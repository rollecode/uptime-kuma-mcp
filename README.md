<center align="center" style="text-align: center;justify-content:center;">
<div align="center" style="text-align: center;justify-content:center;">
<h1 align="center" style="text-align: center;justify-content:center;">

Uptime Kuma MCP server

<img style="justify-content:center;text-align: center;width: 95px; height: auto;" width="793" height="411" alt="image" src="https://github.com/user-attachments/assets/abed1a04-d69b-4ab4-a490-d606064df72d" />
<img style="justify-content:center;text-align: center;width: 49px; height: auto;" alt="Uptime Kuma" src="public/logo.png" />

</h1>


![Version](https://img.shields.io/badge/version-1.0.0-blue.svg?style=for-the-badge) ![Node](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white) ![Uptime Kuma](https://img.shields.io/badge/Uptime_Kuma-5CDD8B?style=for-the-badge&logo=uptimekuma&logoColor=white) ![Coverage](https://img.shields.io/badge/event_coverage-76%2F76-brightgreen?style=for-the-badge)

</div>
</center>

<hr>

Run Uptime Kuma from Claude.ai and Claude Code. All 76 socket events a user can trigger from Kuma's web interface are tools, read from Kuma's own server source. Not a curated subset: everything the web interface can do, this can do.

<hr>

> [!WARNING]
> Using this server with a paid AI service costs money. Tool definitions and results are billed as input tokens, and an agent can call tools repeatedly on its own. You are responsible for every charge, so set spending limits with your provider. The author accepts no liability for any costs. See [DISCLAIMER.md](DISCLAIMER.md).

## Why not the other options

Measured against the `socket.on` handlers of Uptime Kuma 2.5.11, which has 76 events a user can trigger, login plumbing left out:

| Server | Kuma events | Coverage |
| --- | --- | --- |
| `@davidfuchs/mcp-uptime-kuma` 0.16.0 | 32 | 42 % |
| This one | **76** | **100 %** |

The other one covers monitors, notifications, tags, maintenance, status pages and Docker hosts and stops there. Nothing else reaches proxies, remote browsers, API keys, status page incidents, settings changes, statistics clearing, the database or Kuma's built-in Cloudflare Tunnel at all.

## How it stays complete

Uptime Kuma 2.x has no management API. Its web interface does everything over socket.io: it emits an event such as `add` or `editMonitor`, and Kuma pushes most lists back on its own. This server keeps one socket logged in as your Kuma user, holds what Kuma pushes, and logs in again whenever the socket reconnects. Each tool sends the same fields the web interface sends, taken from the handlers in Kuma's `server/server.js` and `server/socket-handlers/`.

`kuma-events.json` lists every `socket.on` event in Kuma's server source:

```bash
node scripts/extract-events.js /path/to/uptime-kuma > kuma-events.json
```

A test compares it with the events the tools emit, in both directions. An event Kuma adds and this misses fails the build; so does a tool emitting an event Kuma does not listen for.

Left out on purpose, because they are login plumbing rather than actions: `login`, `loginByToken`, `logout`, `setup`, `needSetup`, `verifyToken`, `twoFAStatus`, `prepare2FA`, `save2FA`, `disable2FA`, `changePassword` and `disconnectOtherSocketClients`.

## Tool names

Verb first, so the name says what it does:

| Pattern | Meaning | Example |
| --- | --- | --- |
| `list_*` | Read a collection | `list_monitors`, `list_notifications` |
| `get_*` | Read one record | `get_monitor`, `get_status_page` |
| `create_*` | Add | `create_monitor`, `create_maintenance` |
| `update_*` | Change | `update_monitor`, `update_settings` |
| `delete_*` | Remove | `delete_monitor`, `delete_tag` |

Actions are named for what they do: `pause_monitor`, `resume_monitor`, `test_notification`, `post_incident`, `resolve_incident`, `clear_monitor_heartbeats`, `shrink_database`, `start_cloudflared`.

86 tools, plus `get_result_page` for reading results too large to send at once.

## What is covered

| Area | Tools |
| --- | --- |
| Monitors | list, get, create, update, delete, pause, resume, heartbeats, chart data, status changes, clear events, clear heartbeats, clear all statistics, domain expiry support, monitor types |
| Tags | list, create, update, delete, add to a monitor, change its value, remove from a monitor |
| Notifications | list, create, update, delete, test, Apprise check, web push key |
| Maintenance | list, get, create, update, delete, pause, resume, set monitors, set status pages |
| Status pages | list, get, create, update settings, logo and groups, delete, post, edit, resolve, unpin and delete incidents, incident history |
| Proxies, Docker hosts, remote browsers | list, create, update, delete, test |
| API keys | list, create, delete, enable, disable |
| Server | settings, server info, timezone, database size and shrink, push examples, game list, PM2 processes, Chrome check, Cloudflare Tunnel status, start, stop and token removal, profile picture |

`list_monitors` shows each monitor with its current status (up, down, pending, maintenance), last check, uptime over 24 hours, 30 days and a year, and average ping, from the heartbeats Kuma pushes as they happen.

`set_avatar` needs a Kuma build that listens for `setAvatar`; upstream 2.5.11 does not.

## Setup

```bash
git clone https://github.com/rollecode/uptime-kuma-mcp.git
cd uptime-kuma-mcp
npm install
```

```bash
export KUMA_URL=http://127.0.0.1:3001
export KUMA_USERNAME=...
export KUMA_PASSWORD=...
export KUMA_PUBLIC_URL=https://status.example.com   # for push URLs
```

An account with two-factor login cannot be used: the server logs in on its own and has no code to give.

### Claude Code

```bash
claude mcp add uptime-kuma -- node /path/to/uptime-kuma-mcp/src/server.js
```

## Writing records

Kuma replaces a record on save rather than merging. The `update_*` tools take only the fields to change: they read the record from Kuma first, apply the changes and send the whole thing back, so nothing you did not mention is lost.

`create_monitor` fills in what the web interface would: an http monitor every 60 seconds accepting 200-299, with the default notifications and the default proxy. A push monitor gets a token, and the answer carries its push URL.

## Hosting it

Running it over HTTP puts it in reach of Claude.ai as a custom connector, and of Claude Code on other machines. Three tiers, the same shape the other servers in this family use:

| Tier | Port | What it does |
| --- | --- | --- |
| `uptime-kuma-mcp` | 8640 | The server. No login of its own, never exposed |
| nginx | 8641 | Front door, behind a Cloudflare Tunnel |
| `auth-server.js` | 8642 | OAuth 2.1 sign-in, or a fixed bearer token |

```bash
node set-password.js 'a password for the sign-in page'
printf 'KUMA_URL=...\nKUMA_USERNAME=...\nKUMA_PASSWORD=...\nKUMA_PUBLIC_URL=...\n' > ~/.config/uptime-kuma-mcp/env
chmod 600 ~/.config/uptime-kuma-mcp/env
openssl rand -hex 32 > ~/.config/uptime-kuma-mcp/token
chmod 600 ~/.config/uptime-kuma-mcp/token
```

Copy `systemd/*.service` into `/etc/systemd/system/`, replacing `YOUR_USER` and the hostnames, then:

```bash
sudo systemctl enable --now uptime-kuma-mcp uptime-kuma-mcp-auth
```

Point `nginx/uptime-kuma-mcp.conf` at your own hostname and send the tunnel at `127.0.0.1:8641`. Claude Code can then skip the browser sign-in with the fixed token:

```bash
claude mcp add --transport http uptime-kuma https://uptime-kuma-mcp.your-domain/mcp \
  --header "Authorization: Bearer $(cat ~/.config/uptime-kuma-mcp/token)" --scope user
```

Environment the server itself reads: `KUMA_URL, KUMA_USERNAME, KUMA_PASSWORD, KUMA_PUBLIC_URL, KUMA_TIMEOUT_MS, MCP_PUBLIC_URL`. The sign-in page carries the Uptime Kuma mark and green, set through `APP_NAME` and the `APP_*` colours in the auth unit.

### Claude.ai

Settings, Connectors, Add custom connector, URL `https://uptime-kuma-mcp.your-domain/mcp`, client ID and secret blank. The sign-in page asks for the password set above. Connectors belong to the account, so adding it once covers mobile too.

## Development

```bash
npm install
npm test
KUMA_SRC=/path/to/uptime-kuma npm test   # also checks the snapshot against that source
```
