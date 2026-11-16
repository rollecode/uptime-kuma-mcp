'use strict';

// Tool definitions, their schemas and what they send to Kuma, through a real MCP client.

const test = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const { tools, clean, PUSH_TOKEN_LENGTH } = require('../src/tools');
const { buildServer } = require('../src/server');

const tool = (name) => tools.find((t) => t.name === name);

// Answers each event from `answers`, records every call.
function fakeKuma(answers = {}, state = {}) {
  const calls = [];
  return {
    url: 'http://kuma.test',
    calls,
    state: { monitorList: {}, lastHeartbeat: {}, uptime: {}, avgPing: {}, certInfo: {}, domainInfo: {}, cloudflared: {}, ...state },
    call: async (event, ...args) => {
      calls.push([event, ...args]);
      const answer = answers[event];
      return typeof answer === 'function' ? answer(...args) : (answer ?? { ok: true });
    },
    emit: async () => {},
    refresh: async () => {},
  };
}

async function connect(kuma) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer(kuma).connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return client;
}

test('names are unique, verb-first snake case and short enough for every client', () => {
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) {
    assert.match(name, /^[a-z]+(_[a-z0-9]+)+$/, name);
    assert.ok(name.length <= 64, name);
  }
});

test('every tool says what it does and how risky it is', () => {
  for (const t of tools) {
    assert.ok(t.description.length > 10, t.name);
    assert.ok(t.annotations, t.name);
    if (/^(delete|clear)_/.test(t.name)) {
      assert.equal(t.annotations.destructiveHint, true, t.name);
    }
    if (/^(list|get|count)_/.test(t.name) && t.name !== 'get_webpush_public_key') {
      assert.equal(t.annotations.readOnlyHint, true, t.name);
    }
  }
});

test('every input schema converts to JSON Schema', () => {
  for (const t of tools) {
    const schema = z.toJSONSchema(z.object(t.input));
    assert.equal(schema.type, 'object', t.name);
  }
});

test('the server lists every tool plus get_result_page', async () => {
  const client = await connect(fakeKuma());
  const { tools: listed } = await client.listTools();
  assert.equal(listed.length, tools.length + 1);
  assert.ok(listed.some((t) => t.name === 'get_result_page'));
});

test('a call answers with status and result; a failure with status error', async () => {
  const kuma = fakeKuma({ getTags: { ok: true, tags: [{ id: 1, name: 'prod' }] } });
  const client = await connect(kuma);

  const ok = await client.callTool({ name: 'list_tags', arguments: {} });
  assert.deepEqual(JSON.parse(ok.content[0].text), { status: 'success', result: [{ id: 1, name: 'prod' }] });

  kuma.call = async () => {
    throw new Error('Uptime Kuma refused getTags: nope');
  };
  const failed = await client.callTool({ name: 'list_tags', arguments: {} });
  assert.deepEqual(JSON.parse(failed.content[0].text), { status: 'error', message: 'Uptime Kuma refused getTags: nope' });
});

test('list_monitors summarises with the current status', async () => {
  const kuma = fakeKuma(
    {},
    {
      monitorList: { 3: { id: 3, name: 'api', type: 'http', url: 'https://example.com', active: true, tags: [{ name: 'env', value: 'prod' }] } },
      lastHeartbeat: { 3: { status: 0, time: 't', msg: 'timeout', ping: null } },
      uptime: { 3: { 24: 0.5 } },
    }
  );
  const [m] = await tool('list_monitors').run(kuma, {});
  assert.equal(m.status, 'down');
  assert.equal(m.target, 'https://example.com');
  assert.deepEqual(m.tags, ['env:prod']);
  assert.deepEqual(m.uptime, { 24: 0.5 });
  assert.deepEqual(kuma.calls, [['getMonitorList']]);
});

test('create_monitor fills the web defaults, default notifications and the default proxy', async () => {
  const kuma = fakeKuma(
    { add: { ok: true, msg: 'successAdded', msgi18n: true, monitorID: 7 } },
    {
      notificationList: [{ id: 4, config: '{"isDefault":true}' }, { id: 5, config: '{"isDefault":false}' }],
      proxyList: [{ id: 2, default: true }],
    }
  );
  const res = await tool('create_monitor').run(kuma, { monitor: { name: 'web', url: 'https://example.com', active: false } });
  const [, sent] = kuma.calls[0];
  assert.equal(sent.type, 'http');
  assert.deepEqual(sent.accepted_statuscodes, ['200-299']);
  assert.deepEqual(sent.notificationIDList, { 4: true });
  assert.equal(sent.proxyId, 2);
  assert.equal(sent.active, false);
  assert.deepEqual(res, { msg: 'successAdded', monitorID: 7 });
});

test('a push monitor gets a token and its push URL comes back', async () => {
  process.env.KUMA_PUBLIC_URL = 'https://status.example.com/';
  const kuma = fakeKuma({ add: { ok: true, monitorID: 8 } });
  const res = await tool('create_monitor').run(kuma, { monitor: { type: 'push', name: 'cron', notificationIDList: [1, 2] } });
  const [, sent] = kuma.calls[0];
  assert.equal(sent.pushToken.length, PUSH_TOKEN_LENGTH);
  assert.deepEqual(sent.notificationIDList, { 1: true, 2: true });
  assert.equal(res.pushURL, `https://status.example.com/api/push/${sent.pushToken}?status=up&msg=OK&ping=`);
  delete process.env.KUMA_PUBLIC_URL;
});

test('update_monitor sends the stored monitor with only the changes applied', async () => {
  const stored = { id: 3, name: 'api', interval: 60, basic_auth_pass: 'secret', accepted_statuscodes: ['200-299'], notificationIDList: { 4: true } };
  const kuma = fakeKuma({ getMonitor: { ok: true, monitor: stored }, editMonitor: { ok: true, monitorID: 3 } });
  await tool('update_monitor').run(kuma, { id: 3, changes: { interval: 300 } });
  const [event, sent] = kuma.calls[1];
  assert.equal(event, 'editMonitor');
  assert.deepEqual(sent, { ...stored, interval: 300 });
});

test('update_settings keeps the other settings and confirms with the password', async () => {
  process.env.KUMA_PASSWORD = 'pw';
  const kuma = fakeKuma({ getSettings: { ok: true, data: { keepDataPeriodDays: 180, searchEngineIndex: false } } });
  await tool('update_settings').run(kuma, { changes: { keepDataPeriodDays: 90 } });
  assert.deepEqual(kuma.calls[1], ['setSettings', { keepDataPeriodDays: 90, searchEngineIndex: false }, 'pw']);
  delete process.env.KUMA_PASSWORD;
});

test('update_notification keeps the provider settings it is not given', async () => {
  const kuma = fakeKuma({}, { notificationList: [{ id: 4, config: '{"name":"tg","type":"telegram","telegramChatID":"1"}' }] });
  await tool('update_notification').run(kuma, { id: 4, changes: { name: 'telegram' } });
  assert.deepEqual(kuma.calls[0], ['addNotification', { name: 'telegram', type: 'telegram', telegramChatID: '1' }, 4]);
});

test('create_maintenance attaches monitors and status pages', async () => {
  const kuma = fakeKuma({ addMaintenance: { ok: true, maintenanceID: 9 } });
  await tool('create_maintenance').run(kuma, { maintenance: { title: 'm', strategy: 'manual' }, monitorIDs: [1], statusPageIDs: [2] });
  assert.equal(kuma.calls[0][1].strategy, 'manual');
  assert.deepEqual(kuma.calls[1], ['addMonitorMaintenance', 9, [{ id: 1 }]]);
  assert.deepEqual(kuma.calls[2], ['addMaintenanceStatusPage', 9, [{ id: 2 }]]);
});

test('clean drops the acknowledgement fields only', () => {
  assert.deepEqual(clean({ ok: true, msg: 'Saved.', msgi18n: true, id: 1 }), { msg: 'Saved.', id: 1 });
  assert.equal(clean(true), true);
});
