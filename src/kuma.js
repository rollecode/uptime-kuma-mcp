// One long-lived, logged-in socket.io connection to Uptime Kuma.
//
// Kuma 2.x has no management REST API: the web interface does everything over
// socket.io events, and the server pushes most lists to the client after login
// instead of answering for them. This keeps those pushes in `state` and
// re-logs in whenever the socket reconnects.

'use strict';

const { io } = require('socket.io-client');

const ACK_TIMEOUT_MS = Number(process.env.KUMA_TIMEOUT_MS || 120_000);
const LOGIN_TIMEOUT_MS = 60_000;

// Lists Kuma pushes after login and after each change, kept as sent.
const PUSHED = [
  'monitorList',
  'monitorTypeList',
  'maintenanceList',
  'apiKeyList',
  'notificationList',
  'statusPageList',
  'proxyList',
  'dockerHostList',
  'remoteBrowserList',
  'info',
];

class KumaError extends Error {}

function createKuma({ url, username, password, connect = io }) {
  if (!url) {
    throw new KumaError('KUMA_URL is not set. Point it at the Uptime Kuma web address.');
  }

  const state = {
    monitorList: {},
    lastHeartbeat: {},
    uptime: {},
    avgPing: {},
    certInfo: {},
    domainInfo: {},
    cloudflared: {},
  };
  let token = null;
  let ready;
  let readyState;
  let markReady;
  let markFailed;

  // Only a settled promise is replaced, so callers already waiting keep theirs.
  function resetReady() {
    if (readyState === 'pending') {
      return;
    }
    readyState = 'pending';
    ready = new Promise((resolve, reject) => {
      markReady = () => {
        readyState = 'ok';
        resolve();
      };
      markFailed = (e) => {
        readyState = 'failed';
        reject(e);
      };
    });
    // A failed login is reported to the next caller, not as an unhandled rejection.
    ready.catch(() => {});
  }
  resetReady();

  const socket = connect(url, { reconnection: true, transports: ['websocket'] });

  async function login() {
    if (token) {
      const res = await socket.timeout(LOGIN_TIMEOUT_MS).emitWithAck('loginByToken', token);
      if (res && res.ok) {
        markReady();
        return;
      }
      token = null;
    }

    if (!username || !password) {
      throw new KumaError('KUMA_USERNAME and KUMA_PASSWORD are not set.');
    }
    const res = await socket.timeout(LOGIN_TIMEOUT_MS).emitWithAck('login', { username, password });
    if (res && res.tokenRequired) {
      throw new KumaError('This Kuma account has two-factor login, which this server cannot answer.');
    }
    if (!res || !res.ok) {
      throw new KumaError(`Uptime Kuma refused the login: ${res && res.msg}`);
    }
    token = res.token;
    markReady();
  }

  socket.on('loginRequired', () => {
    login().catch((e) => markFailed(e));
  });
  socket.on('autoLogin', () => markReady());
  socket.on('connect', () => resetReady());
  socket.on('disconnect', () => resetReady());
  socket.on('connect_error', (e) => markFailed(new KumaError(`Could not connect to Uptime Kuma at ${url}: ${e.message}`)));

  for (const name of PUSHED) {
    socket.on(name, (data) => {
      state[name] = data;
    });
  }
  socket.on('updateMonitorIntoList', (data) => Object.assign(state.monitorList, data));
  socket.on('deleteMonitorFromList', (id) => delete state.monitorList[id]);
  socket.on('heartbeat', (beat) => {
    state.lastHeartbeat[beat.monitorID] = beat;
  });
  socket.on('heartbeatList', (id, list) => {
    if (list && list.length) {
      state.lastHeartbeat[id] = list[list.length - 1];
    }
  });
  socket.on('avgPing', (id, ping) => {
    state.avgPing[id] = ping;
  });
  socket.on('uptime', (id, period, value) => {
    state.uptime[id] = { ...state.uptime[id], [period]: value };
  });
  socket.on('certInfo', (id, json) => {
    try {
      state.certInfo[id] = JSON.parse(json);
    } catch {
      state.certInfo[id] = json;
    }
  });
  socket.on('domainInfo', (id, daysRemaining, expiresOn) => {
    state.domainInfo[id] = { daysRemaining, expiresOn };
  });
  for (const key of ['installed', 'running', 'message', 'errorMessage', 'token']) {
    socket.on(`cloudflared_${key}`, (value) => {
      state.cloudflared[key] = value;
    });
  }

  async function whenReady() {
    // A refused login is retried once the socket is up, rather than failing forever.
    if (readyState === 'failed' && socket.connected) {
      resetReady();
      login().catch((e) => markFailed(e));
    }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new KumaError(`Not logged in to Uptime Kuma at ${url} after ${LOGIN_TIMEOUT_MS / 1000} s.`)), LOGIN_TIMEOUT_MS);
    });
    try {
      await Promise.race([ready, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Emit an event that answers through a callback, and return the answer.
  // Kuma answers failures with { ok: false, msg }, which become errors here.
  async function call(event, ...args) {
    await whenReady();
    let res;
    try {
      res = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(event, ...args);
    } catch {
      throw new KumaError(`Uptime Kuma did not answer ${event} within ${ACK_TIMEOUT_MS / 1000} s.`);
    }
    if (res && typeof res === 'object' && res.ok === false) {
      const msg = typeof res.msg === 'object' ? JSON.stringify(res.msg) : res.msg;
      throw new KumaError(`Uptime Kuma refused ${event}: ${msg}`);
    }
    return res;
  }

  // Emit an event Kuma never answers, and wait for a pushed one instead.
  async function emit(event, args = [], { waitFor, waitMs = 3_000 } = {}) {
    await whenReady();
    const pushed = waitFor
      ? new Promise((resolve) => {
          const timer = setTimeout(resolve, waitMs);
          socket.once(waitFor, () => {
            clearTimeout(timer);
            resolve();
          });
        })
      : null;
    socket.emit(event, ...args);
    await pushed;
  }

  // Log in again on the same socket, so Kuma pushes every list afresh.
  // Needed for statusPageList, which Kuma only sends at login.
  async function refresh() {
    await whenReady();
    await login();
  }

  function close() {
    socket.close();
  }

  return { state, call, emit, refresh, close, url };
}

module.exports = { createKuma, KumaError };
