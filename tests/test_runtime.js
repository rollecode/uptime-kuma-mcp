'use strict';

// The socket client against a fake Kuma that answers like the real handlers.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createKuma } = require('../src/kuma');

function fakeKuma(handlers) {
  const client = new EventEmitter();
  const sent = [];
  const socket = {
    connected: true,
    on: (event, fn) => client.on(event, fn),
    once: (event, fn) => client.once(event, fn),
    emit: (event, ...args) => sent.push([event, ...args]),
    close: () => {},
    timeout: () => ({
      emitWithAck: async (event, ...args) => {
        sent.push([event, ...args]);
        const handler = handlers[event];
        if (!handler) {
          throw new Error('operation has timed out');
        }
        return handler((name, ...payload) => client.emit(name, ...payload), ...args);
      },
    }),
  };
  const server = {
    sent,
    push: (event, ...args) => client.emit(event, ...args),
    connect: () => {
      client.emit('connect');
      client.emit('loginRequired');
    },
  };
  return { socket, server };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function start(handlers) {
  const { socket, server } = fakeKuma(handlers);
  const kuma = createKuma({ url: 'http://kuma.test', username: 'u', password: 'p', connect: () => socket });
  server.connect();
  return { kuma, server };
}

const loginOk = (push) => {
  push('monitorList', { 1: { id: 1, name: 'web' } });
  push('heartbeatList', 1, [{ monitorID: 1, status: 0 }, { monitorID: 1, status: 1, msg: 'OK' }]);
  return { ok: true, token: 'jwt' };
};

test('logs in with the password and keeps what Kuma pushes', async () => {
  const { kuma } = start({ login: loginOk, getMonitorList: () => ({ ok: true }) });
  await kuma.call('getMonitorList');
  assert.equal(kuma.state.monitorList[1].name, 'web');
  assert.equal(kuma.state.lastHeartbeat[1].status, 1);
});

test('a refusal from Kuma becomes an error carrying its message', async () => {
  const { kuma } = start({ login: loginOk, getMonitor: () => ({ ok: false, msg: 'Permission denied.' }) });
  await assert.rejects(kuma.call('getMonitor', 99), /getMonitor: Permission denied/);
});

test('a reconnect logs in again with the token, not the password', async () => {
  const { kuma, server } = start({ login: loginOk, loginByToken: () => ({ ok: true }), getTags: () => ({ ok: true, tags: [] }) });
  await kuma.call('getTags');
  server.push('disconnect');
  server.connect();
  await kuma.call('getTags');
  const logins = server.sent.filter(([event]) => event === 'login' || event === 'loginByToken').map(([event]) => event);
  assert.deepEqual(logins, ['login', 'loginByToken']);
  assert.deepEqual(server.sent.find(([event]) => event === 'loginByToken'), ['loginByToken', 'jwt']);
});

test('a refused token falls back to the password', async () => {
  const { kuma, server } = start({ login: loginOk, loginByToken: () => ({ ok: false }), getTags: () => ({ ok: true, tags: [] }) });
  await kuma.call('getTags');
  server.push('disconnect');
  server.connect();
  await kuma.call('getTags');
  assert.equal(server.sent.filter(([event]) => event === 'login').length, 2);
});

test('an account with two-factor login is reported, not retried silently', async () => {
  const { kuma } = start({ login: () => ({ tokenRequired: true }) });
  await assert.rejects(kuma.call('getTags'), /two-factor/);
});

test('live heartbeats, uptime and cert info are kept per monitor', async () => {
  const { kuma, server } = start({ login: loginOk, getTags: () => ({ ok: true, tags: [] }) });
  await kuma.call('getTags');
  server.push('heartbeat', { monitorID: 1, status: 0, msg: 'timeout' });
  server.push('uptime', 1, 24, 0.99);
  server.push('certInfo', 1, '{"valid":true}');
  server.push('deleteMonitorFromList', 1);
  await flush();
  assert.equal(kuma.state.lastHeartbeat[1].msg, 'timeout');
  assert.deepEqual(kuma.state.uptime[1], { 24: 0.99 });
  assert.deepEqual(kuma.state.certInfo[1], { valid: true });
  assert.equal(kuma.state.monitorList[1], undefined);
});

test('a missing URL is explained', () => {
  assert.throws(() => createKuma({ url: '' }), /KUMA_URL/);
});
