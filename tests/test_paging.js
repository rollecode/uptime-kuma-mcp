'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const paging = require('../src/paging');

const bigList = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `monitor-${i}`, url: `https://example.com/${'x'.repeat(40)}` }));

test('a small result comes back whole', () => {
  const payload = { status: 'success', result: [{ id: 1 }] };
  assert.deepEqual(JSON.parse(paging.fit(payload)), payload);
});

test('a large list comes back as a first page with paging', () => {
  const page = JSON.parse(paging.fit({ status: 'success', result: bigList }));
  assert.equal(page.status, 'success');
  assert.equal(page.paging.total, 2000);
  assert.ok(page.result.length > 0 && page.result.length < 2000);
  assert.equal(page.paging.next_offset, page.result.length);
  assert.ok(JSON.stringify(page).length <= paging.BUDGET);
});

test('get_result_page continues, narrows and filters', () => {
  const first = JSON.parse(paging.fit({ status: 'success', result: bigList }));
  const id = first.paging.result_id;

  const next = JSON.parse(paging.getResultPage({ result_id: id, offset: first.paging.next_offset, limit: 5 }));
  assert.equal(next.result[0].id, first.paging.next_offset);
  assert.equal(next.result.length, 5);

  const narrow = JSON.parse(paging.getResultPage({ result_id: id, limit: 2, fields: ['name'] }));
  assert.deepEqual(narrow.result, [{ name: 'monitor-0' }, { name: 'monitor-1' }]);

  const filtered = JSON.parse(paging.getResultPage({ result_id: id, match: { name: 'monitor-1999' } }));
  assert.equal(filtered.paging.total, 1);
  assert.equal(filtered.result[0].id, 1999);
});

test('an unknown result id says it expired', () => {
  const res = JSON.parse(paging.getResultPage({ result_id: 'nope' }));
  assert.equal(res.status, 'error');
  assert.match(res.message, /expired/);
});

test('one huge string is split into partial_json pages', () => {
  const first = JSON.parse(paging.fit({ status: 'success', result: 'y'.repeat(200_000) }));
  assert.ok(first.partial_json.length > 0);
  assert.ok(first.paging.next_offset > 0);
});
