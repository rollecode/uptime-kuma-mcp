'use strict';

// Every event Kuma's server listens for has a tool, except login plumbing.
// The snapshot comes from scripts/extract-events.js; set KUMA_SRC to an
// uptime-kuma checkout to also check the snapshot against that source.

const test = require('node:test');
const assert = require('node:assert/strict');

const { tools } = require('../src/tools');
const snapshot = require('../kuma-events.json');
const { extract } = require('../scripts/extract-events');

// Login, setup, two-factor and password plumbing, plus the UDP socket of the RADIUS client.
const EXCLUDED = [
  'login',
  'loginByToken',
  'logout',
  'setup',
  'needSetup',
  'verifyToken',
  'twoFAStatus',
  'prepare2FA',
  'save2FA',
  'disable2FA',
  'changePassword',
  'disconnectOtherSocketClients',
  'message',
  'error',
];

const covered = new Set(tools.flatMap((t) => t.events));

test('every Kuma event outside login plumbing has a tool', () => {
  const missing = snapshot.events.filter((e) => !EXCLUDED.includes(e) && !covered.has(e));
  assert.deepEqual(missing, []);
});

test('every event a tool emits exists in Kuma', () => {
  const unknown = [...covered].filter((e) => !snapshot.events.includes(e));
  assert.deepEqual(unknown, []);
});

test('every excluded event still exists in Kuma', () => {
  const stale = EXCLUDED.filter((e) => !snapshot.events.includes(e));
  assert.deepEqual(stale, []);
});

test('the snapshot matches the Kuma source', { skip: !process.env.KUMA_SRC && 'KUMA_SRC not set' }, () => {
  assert.deepEqual(extract(process.env.KUMA_SRC).events, snapshot.events);
});
