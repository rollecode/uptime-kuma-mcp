// Keep tool results small enough for a chat client to accept.
//
// A result over BUDGET is kept here and answered with its first page, the total
// and the field names. get_result_page reads the rest, filtered or narrowed to
// chosen fields, so nothing is lost: it only arrives in parts.

'use strict';

const crypto = require('crypto');

// Characters per response, about 20 000 tokens.
const BUDGET = 80_000;
// Lists smaller than this stay in the first page; larger ones are paged.
const INLINE = 2_000;

// ponytail: count-capped LRU in process memory; results are lost on restart.
const KEPT = 8;
const results = new Map();

const HINT =
  'Large result, sent in pages. Call get_result_page with this result_id and ' +
  'next_offset for more, or path to page another of the lists. Pass fields ' +
  'to fetch only some keys, or match to filter, e.g. {"name": "nginx"}.';

const dump = (value) => JSON.stringify(value) ?? 'null';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function at(value, path) {
  for (const key of path) {
    value = value[key];
  }
  return value;
}

// Every list worth paging, by path, largest first.
function findLists(value, path = [], depth = 0, found = new Map()) {
  if (Array.isArray(value)) {
    const size = dump(value).length;
    if (size >= INLINE || path.length === 0) {
      found.set(path.join('.'), { path, size });
    }
  } else if (isObject(value) && depth <= 4) {
    for (const [key, child] of Object.entries(value)) {
      findLists(child, [...path, key], depth + 1, found);
    }
  }
  return new Map([...found].sort((a, b) => b[1].size - a[1].size));
}

function getField(item, field) {
  for (const key of field.split('.')) {
    if (!isObject(item)) {
      return null;
    }
    item = item[key];
  }
  return item ?? null;
}

function matches(item, match) {
  return Object.entries(match).every(([field, want]) =>
    dump(getField(item, field)).toLowerCase().includes(String(want).toLowerCase())
  );
}

// A copy of payload with the list at each path swapped for a new value.
function replace(payload, replacements) {
  if (replacements.has('')) {
    return replacements.get('');
  }
  const copy = { ...payload };
  for (const [name, value] of replacements) {
    const path = name.split('.');
    let node = copy;
    for (const key of path.slice(0, -1)) {
      node[key] = { ...node[key] };
      node = node[key];
    }
    node[path[path.length - 1]] = value;
  }
  return copy;
}

function emptied(lists) {
  return new Map([...lists.keys()].map((name) => [name, []]));
}

// Serialise a tool's answer, paging it when it is over BUDGET.
function fit(payload) {
  const text = dump(payload);
  if (text.length <= BUDGET) {
    return text;
  }

  const resultId = crypto.randomBytes(6).toString('hex');
  let lists = findLists(payload);
  if (lists.size && dump(replace(payload, emptied(lists))).length > BUDGET / 2) {
    lists = new Map();
  }
  results.set(resultId, { payload: lists.size ? payload : text, lists });
  while (results.size > KEPT) {
    results.delete(results.keys().next().value);
  }
  return page(resultId);
}

function textPage(resultId, text, offset) {
  // Escaping inside a JSON string grows the text, so shrink until it fits.
  let end = offset + BUDGET - 1_000;
  while (dump(text.slice(offset, end)).length > BUDGET - 1_000) {
    end = offset + Math.floor(((end - offset) * 9) / 10);
  }
  return dump({
    status: 'success',
    partial_json: text.slice(offset, end),
    paging: {
      result_id: resultId,
      total_chars: text.length,
      offset,
      next_offset: end < text.length ? end : null,
      hint: 'Too large to split into items. Concatenate partial_json from every page to rebuild it.',
    },
  });
}

function page(resultId, { offset = 0, limit, fields, match, path } = {}) {
  const { payload, lists } = results.get(resultId);
  results.delete(resultId);
  results.set(resultId, { payload, lists });
  if (!lists.size) {
    return textPage(resultId, payload, offset);
  }

  const chosen = path === undefined || path === null ? lists.keys().next().value : path;
  if (!lists.has(chosen)) {
    return dump({
      status: 'error',
      message: `No list at ${JSON.stringify(path)}. Choose one of: ${[...lists.keys()].join(', ')}.`,
    });
  }

  let items = at(payload, lists.get(chosen).path);
  if (match) {
    items = items.filter((item) => matches(item, match));
  }
  const total = items.length;
  let window = items.slice(offset);
  if (limit !== undefined && limit !== null) {
    window = window.slice(0, limit);
  }
  if (fields && fields.length) {
    window = window.map((item) => Object.fromEntries(fields.map((f) => [f, getField(item, f)])));
  }

  const sample = items.find(isObject);
  const paging = {
    result_id: resultId,
    path: chosen || null,
    lists:
      lists.size > 1
        ? Object.fromEntries([...lists].map(([name, l]) => [name, at(payload, l.path).length]))
        : null,
    total,
    offset,
    fields: sample ? Object.keys(sample).sort() : null,
    hint: HINT,
  };
  const empty = emptied(lists);
  let used = dump({ page: replace(payload, empty), paging }).length + 200;

  const taken = [];
  for (const item of window) {
    const size = dump(item).length + 1;
    if (taken.length && used + size > BUDGET) {
      break;
    }
    taken.push(item);
    used += size;
  }

  const following = offset + taken.length;
  paging.returned = taken.length;
  paging.next_offset = following < total ? following : null;

  const result = replace(payload, new Map([...empty, [chosen, taken]]));
  if (isObject(result)) {
    return dump({ ...result, paging });
  }
  return dump({ status: 'success', result, paging });
}

function getResultPage({ result_id, offset, limit, fields, match, path }) {
  if (!results.has(result_id)) {
    return dump({ status: 'error', message: 'That result has expired. Call the original tool again.' });
  }
  return page(result_id, { offset, limit, fields, match, path });
}

module.exports = { BUDGET, fit, getResultPage };
