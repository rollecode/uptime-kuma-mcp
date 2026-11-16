#!/usr/bin/env node
// Uptime Kuma MCP server: every socket event of the web interface as a tool.
// Over stdio for Claude Code, or over HTTP on the local machine behind auth-server.js.

'use strict';

const http = require('http');
const crypto = require('crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const { createKuma } = require('./kuma');
const { tools } = require('./tools');
const paging = require('./paging');
const { version } = require('../package.json');

const DEFAULT_PORT = 8640;
const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
// A chat left idle keeps its session this long before it has to reconnect.
const SESSION_IDLE_MS = 24 * 3600 * 1000;
const ICON_SIZES = [48, 96, 256];

const INSTRUCTIONS =
  'Manage an Uptime Kuma instance: monitors, heartbeats and uptime, notifications, tags, ' +
  'maintenance windows, status pages and incidents, proxies, Docker hosts, remote browsers, ' +
  'API keys and settings. Tools are named verb-first: list_* and get_* read, create_*, update_* ' +
  'and delete_* change. Start with list_monitors, which shows each monitor with its current status. ' +
  'update_* tools take only the fields to change and keep the rest. ' +
  'Monitor ids are numbers; status pages go by slug.';

function reply(text) {
  return { content: [{ type: 'text', text }] };
}

function icons() {
  const base = (process.env.MCP_PUBLIC_URL || '').replace(/\/$/, '');
  if (!base) {
    return undefined;
  }
  return ICON_SIZES.map((size) => ({
    src: size === 256 ? `${base}/icon.png` : `${base}/icon-${size}.png`,
    mimeType: 'image/png',
    sizes: [`${size}x${size}`],
  }));
}

function buildServer(kuma) {
  const server = new McpServer(
    {
      name: 'uptime-kuma',
      version,
      icons: icons(),
      websiteUrl: process.env.MCP_PUBLIC_URL || undefined,
    },
    { instructions: INSTRUCTIONS }
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input, annotations: tool.annotations },
      async (args) => {
        try {
          return reply(paging.fit({ status: 'success', result: (await tool.run(kuma, args)) ?? null }));
        } catch (e) {
          return reply(JSON.stringify({ status: 'error', message: e.message }));
        }
      }
    );
  }

  server.registerTool(
    'get_result_page',
    {
      description:
        'Read more of a result that was too large to return in one piece. Any tool whose answer is too large ' +
        'returns its first page with a `paging` block; pass its result_id here. Nothing is fetched again: ' +
        'the stored result is paged, filtered and narrowed.',
      inputSchema: {
        result_id: z.string().describe('From the paging block of the earlier answer'),
        offset: z.number().int().min(0).optional().describe('First item to return, usually the previous next_offset'),
        limit: z.number().int().min(1).optional().describe('At most this many items'),
        fields: z.array(z.string()).optional().describe('Only these keys of each item; dots reach nested keys'),
        match: z
          .record(z.string(), z.string())
          .optional()
          .describe('Keep only items whose field contains this text, ignoring case, e.g. {"name": "nginx"}'),
        path: z.string().optional().describe('Which list to page when the result holds several, as named in paging.lists'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => reply(paging.getResultPage(args))
  );

  return server;
}

// No login of its own: auth-server.js sits in front, so it binds loopback only.
function serveHttp(kuma, host, port) {
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `refusing to listen on ${host}: this server has no login of its own. ` +
        'Keep it on the local machine and put a proxy in front.'
    );
  }

  const sessions = new Map();

  async function openSession() {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, seen: Date.now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };
    await buildServer(kuma).connect(transport);
    return transport;
  }

  setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const { transport, seen } of sessions.values()) {
      if (seen < cutoff) {
        transport.close();
      }
    }
  }, 3600 * 1000).unref();

  http
    .createServer((req, res) => {
      if (!req.url.startsWith('/mcp')) {
        res.writeHead(404).end();
        return;
      }
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const raw = Buffer.concat(chunks).toString();
          const body = raw ? JSON.parse(raw) : undefined;
          const sessionId = req.headers['mcp-session-id'];
          const session = sessionId ? sessions.get(sessionId) : null;
          if (sessionId && !session) {
            res.writeHead(404).end();
            return;
          }
          if (session) {
            session.seen = Date.now();
          }
          const transport = session ? session.transport : await openSession();
          await transport.handleRequest(req, res, body);
        } catch (e) {
          console.error(e);
          if (!res.headersSent) {
            res.writeHead(500).end();
          }
        }
      });
    })
    .listen(port, host, () => {
      console.error(`uptime-kuma-mcp listening on http://${host}:${port}/mcp, serving ${kuma.url}`);
    });
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);

  const kuma = createKuma({
    url: process.env.KUMA_URL,
    username: process.env.KUMA_USERNAME,
    password: process.env.KUMA_PASSWORD,
  });

  if (arg('--transport', process.env.MCP_TRANSPORT || 'stdio') === 'http') {
    serveHttp(kuma, arg('--host', process.env.MCP_HOST || '127.0.0.1'), Number(arg('--port', process.env.MCP_PORT || DEFAULT_PORT)));
    return;
  }

  await buildServer(kuma).connect(new StdioServerTransport());
  console.error(`uptime-kuma-mcp connected over stdio, serving ${kuma.url}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('uptime-kuma-mcp failed to start:', e.message);
    process.exit(1);
  });
}

module.exports = { buildServer };
