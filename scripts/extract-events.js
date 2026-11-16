#!/usr/bin/env node
// List every socket.on event Uptime Kuma's server listens for.
// Usage: node scripts/extract-events.js <path to an uptime-kuma checkout> [> kuma-events.json]

'use strict';

const fs = require('fs');
const path = require('path');

// `socket.on("name"` or `socket.on(prefix + "name"`, where prefix is a string constant in the file.
const HANDLER = /socket\.on\(\s*(?:([A-Za-z_]\w*)\s*\+\s*)?["'`]([\w-]+)["'`]/g;
const CONSTANT = /const\s+([A-Za-z_]\w*)\s*=\s*["'`]([\w-]+)["'`]/g;

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return files(full);
    }
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function extract(kumaDir) {
  const events = new Set();
  for (const file of files(path.join(kumaDir, 'server'))) {
    const source = fs.readFileSync(file, 'utf8');
    const constants = Object.fromEntries([...source.matchAll(CONSTANT)].map((m) => [m[1], m[2]]));
    for (const [, prefix, name] of source.matchAll(HANDLER)) {
      events.add(prefix ? `${constants[prefix] ?? prefix}${name}` : name);
    }
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(kumaDir, 'package.json'), 'utf8'));
  return { version, events: [...events].sort() };
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node scripts/extract-events.js <path to an uptime-kuma checkout>');
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(extract(dir), null, 2)}\n`);
}

module.exports = { extract };
