// Every Uptime Kuma socket event a user can trigger from the web interface, as a tool.
//
// Each tool names the events it emits in `events`; the coverage test checks
// them against the events Kuma's server source listens for. Field names come
// from what each handler in Kuma's server reads.

'use strict';

const crypto = require('crypto');
const { z } = require('zod');

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DESTRUCTIVE = { ...WRITE, destructiveHint: true };

const PUSH_TOKEN_LENGTH = 32;
const TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const STATUS = { 0: 'down', 1: 'up', 2: 'pending', 3: 'maintenance' };

const MONITOR_TYPES =
  'http, keyword, json-query, websocket-upgrade, real-browser, grpc-keyword, port, ping, dns, push, ' +
  'docker, gamedig, globalping, group, kafka-producer, manual, mongodb, mqtt, mysql, ntp, oracledb, pm2, ' +
  'postgres, rabbitmq, radius, redis, sftp, sip-options, smtp, snmp, sqlserver, steam, system-service, ' +
  'tailscale-ping';

// What the web interface fills in for a new monitor (EditMonitor.vue).
const MONITOR_DEFAULTS = {
  type: 'http',
  name: '',
  parent: null,
  url: 'https://',
  wsSubprotocol: '',
  method: 'GET',
  protocol: null,
  location: 'world',
  ipFamily: null,
  interval: 60,
  retryInterval: 60,
  resendInterval: 0,
  maxretries: 0,
  retryOnlyOnStatusCodeFailure: false,
  notificationIDList: {},
  ignoreTls: false,
  upsideDown: false,
  expiryNotification: false,
  domainExpiryNotification: true,
  maxredirects: 10,
  accepted_statuscodes: ['200-299'],
  saveResponse: false,
  saveErrorResponse: true,
  responseMaxLength: 1024,
  dns_resolve_type: 'A',
  dns_resolve_server: '',
  docker_container: '',
  docker_host: null,
  proxyId: null,
  basic_auth_user: '',
  basic_auth_pass: '',
  bearer_token: '',
  mqttUsername: '',
  mqttPassword: '',
  mqttTopic: '',
  mqttWebsocketPath: '',
  mqttSuccessMessage: '',
  mqttCheckType: 'keyword',
  authMethod: null,
  oauth_auth_method: 'client_secret_basic',
  httpBodyEncoding: 'json',
  kafkaProducerBrokers: [],
  kafkaProducerSaslOptions: { mechanism: 'None' },
  cacheBust: false,
  kafkaProducerSsl: false,
  kafkaProducerAllowAutoTopicCreation: false,
  gamedigGivenPortOnly: true,
  gamedigToken: '',
  remote_browser: null,
  screenshot_delay: 0,
  rabbitmqNodes: [],
  rabbitmqUsername: '',
  rabbitmqPassword: '',
  conditions: [],
  system_service_name: '',
  sshAuthMethod: 'password',
  ntpStratumThreshold: 5,
  ntpTimeOffsetThreshold: 1000,
  ntpRootDispersionThreshold: 500,
  ping_count: 3,
  ping_numeric: true,
  packetSize: 56,
  ping_per_request_timeout: 2,
};

// What the web interface fills in for a new maintenance window (EditMaintenance.vue).
const MAINTENANCE_DEFAULTS = {
  title: '',
  description: '',
  strategy: 'single',
  active: 1,
  cron: '30 3 * * *',
  durationMinutes: 60,
  intervalDay: 1,
  dateRange: [null],
  timeRange: [
    { hours: 2, minutes: 0 },
    { hours: 3, minutes: 0 },
  ],
  weekdays: [],
  daysOfMonth: [],
  timezoneOption: 'SAME_AS_SERVER',
};

const id = (what) => z.number().int().describe(`${what} id`);
const str = z.string().nullable().optional();
const num = z.number().nullable().optional();
const bool = z.boolean().optional();

// The fields Kuma's add and editMonitor handlers read.
const MONITOR_FIELDS = z.looseObject({
  type: z.string().optional().describe(`One of: ${MONITOR_TYPES}`),
  name: z.string().optional(),
  description: str,
  parent: num.describe('Id of the group monitor this sits in, or null'),
  active: bool.describe('Only on create: false adds it paused'),
  url: str,
  method: str,
  headers: str.describe('JSON object as a string'),
  body: str,
  httpBodyEncoding: str.describe('json, form or xml'),
  hostname: str,
  port: z.union([z.number(), z.string()]).nullable().optional(),
  interval: z.number().optional().describe('Seconds between checks'),
  retryInterval: z.number().optional(),
  resendInterval: z.number().optional().describe('Resend a DOWN notification every N beats, 0 = never'),
  maxretries: z.number().optional(),
  retryOnlyOnStatusCodeFailure: bool,
  timeout: num.describe('Seconds'),
  keyword: str,
  invertKeyword: bool,
  jsonPath: str,
  jsonPathOperator: str,
  expectedValue: str,
  accepted_statuscodes: z.array(z.string()).optional().describe('Ranges as strings, e.g. ["200-299"]'),
  maxredirects: num,
  ignoreTls: bool,
  upsideDown: bool,
  expiryNotification: bool,
  domainExpiryNotification: bool,
  cacheBust: bool,
  ipFamily: str,
  saveResponse: bool,
  saveErrorResponse: bool,
  responseMaxLength: num,
  notificationIDList: z
    .union([z.array(z.number().int()), z.record(z.string(), z.boolean())])
    .optional()
    .describe('Notification ids to send to, as a list or as {"id": true}'),
  proxyId: num,
  authMethod: str.describe('null, basic, oauth2-cc, ntlm or mtls'),
  basic_auth_user: str,
  basic_auth_pass: str,
  bearer_token: str,
  oauth_client_id: str,
  oauth_client_secret: str,
  oauth_auth_method: str,
  oauth_token_url: str,
  oauth_scopes: str,
  oauth_audience: str,
  authWorkstation: str,
  authDomain: str,
  tlsCa: str,
  tlsCert: str,
  tlsKey: str,
  pushToken: str.describe('Push monitors only; generated when left out'),
  dns_resolve_type: str,
  dns_resolve_server: str,
  docker_container: str,
  docker_host: num,
  packetSize: num,
  ping_count: num,
  ping_numeric: bool,
  ping_per_request_timeout: num,
  game: str,
  gamedigGivenPortOnly: bool,
  gamedigToken: str,
  mqttUsername: str,
  mqttPassword: str,
  mqttTopic: str,
  mqttSuccessMessage: str,
  mqttCheckType: str,
  mqttWebsocketPath: str,
  databaseConnectionString: str,
  databaseQuery: str,
  grpcUrl: str,
  grpcProtobuf: str,
  grpcServiceName: str,
  grpcMethod: str,
  grpcBody: str,
  grpcMetadata: str,
  grpcEnableTls: bool,
  radiusUsername: str,
  radiusPassword: str,
  radiusSecret: str,
  radiusCalledStationId: str,
  radiusCallingStationId: str,
  kafkaProducerTopic: str,
  kafkaProducerBrokers: z.array(z.string()).optional(),
  kafkaProducerSsl: bool,
  kafkaProducerAllowAutoTopicCreation: bool,
  kafkaProducerSaslOptions: z.record(z.string(), z.any()).optional(),
  kafkaProducerMessage: str,
  rabbitmqNodes: z.array(z.string()).optional(),
  rabbitmqUsername: str,
  rabbitmqPassword: str,
  remote_browser: num,
  screenshot_delay: num,
  smtpSecurity: str,
  snmpVersion: str,
  snmpOid: str,
  sshUsername: str,
  sshPassword: str,
  sshPrivateKey: str,
  sshPassphrase: str,
  sshAuthMethod: str,
  sftpPath: str,
  system_service_name: str,
  manual_status: num,
  wsSubprotocol: str,
  wsIgnoreSecWebsocketAcceptHeader: bool,
  location: str,
  protocol: str,
  subtype: str,
  conditions: z.array(z.any()).optional(),
  ntpStratumThreshold: num,
  ntpTimeOffsetThreshold: num,
  ntpRootDispersionThreshold: num,
});

const NOTIFICATION_FIELDS = z.looseObject({
  name: z.string().optional(),
  type: z.string().optional().describe('Provider, as Kuma names it: telegram, discord, slack, ntfy, webhook, smtp, pushover and so on'),
  isDefault: bool.describe('Turn on for new monitors'),
  applyExisting: bool.describe('Also attach to every existing monitor'),
});

const PROXY_FIELDS = z.looseObject({
  protocol: z.string().optional().describe('http, https, socks, socks5, socks5h or socks4'),
  host: z.string().optional(),
  port: z.number().int().optional(),
  auth: bool,
  username: str,
  password: str,
  active: bool,
  default: bool.describe('Use for new monitors'),
  applyExisting: bool.describe('Also set on every existing monitor'),
});

const DOCKER_HOST_FIELDS = z.looseObject({
  name: z.string().optional(),
  dockerType: z.string().optional().describe('socket or tcp'),
  dockerDaemon: z.string().optional().describe('Socket path or tcp://host:port'),
});

const MAINTENANCE_FIELDS = z.looseObject({
  title: z.string().optional(),
  description: str,
  strategy: z
    .string()
    .optional()
    .describe('manual, single, recurring-interval, recurring-weekday, recurring-day-of-month or cron'),
  active: z.union([z.boolean(), z.number()]).optional(),
  dateRange: z
    .array(z.string().nullable())
    .optional()
    .describe('[start, end] as "YYYY-MM-DD HH:mm"; for single, and the bounds of recurring ones'),
  timeRange: z
    .array(z.object({ hours: z.number().int(), minutes: z.number().int() }))
    .optional()
    .describe('Recurring strategies: [start, end] time of day'),
  weekdays: z.array(z.number().int()).optional().describe('recurring-weekday: 1 = Monday ... 7 = Sunday'),
  daysOfMonth: z.array(z.union([z.number().int(), z.string()])).optional().describe('recurring-day-of-month: 1-31 or "lastDay1"'),
  intervalDay: z.number().int().optional().describe('recurring-interval: every N days'),
  cron: str.describe('cron strategy: the schedule'),
  durationMinutes: z.number().optional().describe('cron strategy: how long each window lasts'),
  timezoneOption: str.describe('IANA zone, UTC or SAME_AS_SERVER'),
});

const STATUS_PAGE_FIELDS = z.looseObject({
  slug: z.string().optional().describe('Change it to rename the page address'),
  title: z.string().optional(),
  description: str,
  theme: str.describe('auto, light or dark'),
  autoRefreshInterval: z.number().optional(),
  showTags: bool,
  showPoweredBy: bool,
  showCertificateExpiry: bool,
  showOnlyLastHeartbeat: bool,
  footerText: str,
  customCSS: str,
  rssTitle: str,
  domainNameList: z.array(z.string()).optional(),
  analyticsType: str.describe('google, umami, plausible, matomo, rybbit or null'),
  analyticsId: str,
  analyticsScriptUrl: str,
});

const GROUP_LIST = z
  .array(
    z.looseObject({
      id: z.number().int().optional().describe('Existing group id; leave out for a new group'),
      name: z.string(),
      monitorList: z.array(
        z.looseObject({
          id: z.number().int(),
          sendUrl: z.union([z.boolean(), z.number()]).optional().describe('Show the monitor URL on the page'),
          url: str.describe('Custom URL to link instead'),
        })
      ),
    })
  )
  .describe('Every group on the page, in order. Groups left out are deleted.');

// Drop Kuma's acknowledgement plumbing and keep the payload.
function clean(res) {
  if (!res || typeof res !== 'object' || Array.isArray(res)) {
    return res;
  }
  const { ok, msgi18n, ...rest } = res;
  return rest;
}

function genToken(length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += TOKEN_CHARS[crypto.randomInt(TOKEN_CHARS.length)];
  }
  return out;
}

function notificationIDs(value) {
  if (!Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(value.map((n) => [String(n), true]));
}

function pushURL(kuma, token) {
  const base = (process.env.KUMA_PUBLIC_URL || kuma.state.info?.primaryBaseURL || kuma.url).replace(/\/$/, '');
  return `${base}/api/push/${token}?status=up&msg=OK&ping=`;
}

function monitorStatus(kuma, monitorID) {
  const beat = kuma.state.lastHeartbeat[monitorID];
  return {
    status: beat ? STATUS[beat.status] ?? beat.status : 'unknown',
    lastCheck: beat ? { time: beat.time, msg: beat.msg, ping: beat.ping } : null,
    uptime: kuma.state.uptime[monitorID] ?? null,
    avgPing24h: kuma.state.avgPing[monitorID] ?? null,
  };
}

function summary(kuma, m) {
  return {
    id: m.id,
    name: m.name,
    pathName: m.pathName,
    type: m.type,
    active: m.active,
    parent: m.parent,
    target: m.url && m.url !== 'https://' ? m.url : m.hostname,
    interval: m.interval,
    tags: (m.tags || []).map((t) => (t.value ? `${t.name}:${t.value}` : t.name)),
    maintenance: m.maintenance,
    ...monitorStatus(kuma, m.id),
  };
}

function findIn(list, itemID, what) {
  const item = (Array.isArray(list) ? list : Object.values(list || {})).find((x) => x.id === itemID);
  if (!item) {
    throw new Error(`No ${what} with id ${itemID}.`);
  }
  return item;
}

// Kuma keeps a channel's settings as a JSON string in `config`.
function parseConfig(notification) {
  try {
    return JSON.parse(notification.config);
  } catch {
    return {};
  }
}

async function rawMonitor(kuma, monitorID) {
  return (await kuma.call('getMonitor', monitorID)).monitor;
}

async function statusPageData(kuma, slug) {
  const res = await fetch(`${kuma.url.replace(/\/$/, '')}/api/status-page/${encodeURIComponent(slug)}`);
  if (!res.ok) {
    throw new Error(`Uptime Kuma answered HTTP ${res.status} for status page ${slug}.`);
  }
  return res.json();
}

const tools = [
  // --- monitors ---------------------------------------------------------
  {
    name: 'list_monitors',
    events: ['getMonitorList'],
    annotations: READ,
    description:
      'List every monitor with its current status (up, down, pending, maintenance), last check and uptime. ' +
      'A compact summary by default; full: true returns every field.',
    input: { full: bool.describe('Every monitor field instead of a summary') },
    run: async (kuma, { full }) => {
      await kuma.call('getMonitorList');
      const list = Object.values(kuma.state.monitorList);
      return full ? list.map((m) => ({ ...m, ...monitorStatus(kuma, m.id) })) : list.map((m) => summary(kuma, m));
    },
  },
  {
    name: 'get_monitor',
    events: ['getMonitor'],
    annotations: READ,
    description: 'One monitor with every setting, its current status, uptime, average ping and certificate and domain expiry.',
    input: { id: id('Monitor') },
    run: async (kuma, { id: monitorID }) => ({
      ...(await rawMonitor(kuma, monitorID)),
      ...monitorStatus(kuma, monitorID),
      certInfo: kuma.state.certInfo[monitorID] ?? null,
      domainInfo: kuma.state.domainInfo[monitorID] ?? null,
    }),
  },
  {
    name: 'create_monitor',
    events: ['add'],
    annotations: { ...WRITE, idempotentHint: false },
    description:
      'Add a monitor. Fields left out take the web interface defaults: http, 60 s interval, 200-299 accepted, ' +
      'default notifications and proxy attached. A push monitor gets a token and its push URL is returned.',
    input: { monitor: MONITOR_FIELDS.describe('The monitor. At least type and name, plus url or hostname for most types.') },
    run: async (kuma, { monitor }) => {
      const notifications = {};
      for (const n of kuma.state.notificationList || []) {
        if (parseConfig(n).isDefault) {
          notifications[n.id] = true;
        }
      }
      const defaultProxy = (kuma.state.proxyList || []).find((p) => p.default);
      const full = {
        ...MONITOR_DEFAULTS,
        notificationIDList: notifications,
        proxyId: defaultProxy ? defaultProxy.id : null,
        ...monitor,
      };
      full.notificationIDList = notificationIDs(full.notificationIDList);
      if (full.type === 'push' && !full.pushToken) {
        full.pushToken = genToken(PUSH_TOKEN_LENGTH);
      }
      const res = clean(await kuma.call('add', full));
      return full.type === 'push' ? { ...res, pushURL: pushURL(kuma, full.pushToken) } : res;
    },
  },
  {
    name: 'update_monitor',
    events: ['editMonitor'],
    annotations: WRITE,
    description:
      'Change a monitor. Pass only the fields to change: the rest are read from Kuma first and sent back unchanged, ' +
      'because Kuma replaces every field on save. The monitor restarts if it is active.',
    input: { id: id('Monitor'), changes: MONITOR_FIELDS.describe('Fields to change') },
    run: async (kuma, { id: monitorID, changes }) => {
      const merged = { ...(await rawMonitor(kuma, monitorID)), ...changes, id: monitorID };
      merged.notificationIDList = notificationIDs(merged.notificationIDList);
      return clean(await kuma.call('editMonitor', merged));
    },
  },
  {
    name: 'delete_monitor',
    events: ['deleteMonitor'],
    annotations: DESTRUCTIVE,
    description: 'Delete a monitor and its history. For a group, children are unlinked unless deleteChildren is true.',
    input: { id: id('Monitor'), deleteChildren: bool.describe('Group monitors: delete the children too') },
    run: async (kuma, { id: monitorID, deleteChildren = false }) => clean(await kuma.call('deleteMonitor', monitorID, deleteChildren)),
  },
  {
    name: 'pause_monitor',
    events: ['pauseMonitor'],
    annotations: WRITE,
    description: 'Pause a monitor: no checks and no notifications until resumed.',
    input: { id: id('Monitor') },
    run: async (kuma, { id: monitorID }) => clean(await kuma.call('pauseMonitor', monitorID)),
  },
  {
    name: 'resume_monitor',
    events: ['resumeMonitor'],
    annotations: WRITE,
    description: 'Resume a paused monitor.',
    input: { id: id('Monitor') },
    run: async (kuma, { id: monitorID }) => clean(await kuma.call('resumeMonitor', monitorID)),
  },
  {
    name: 'get_monitor_beats',
    events: ['getMonitorBeats'],
    annotations: READ,
    description: 'Every heartbeat of a monitor in the last N hours, oldest first: status (0 down, 1 up, 2 pending, 3 maintenance), time, message, ping.',
    input: { id: id('Monitor'), period: z.number().positive().describe('Hours back from now') },
    run: async (kuma, { id: monitorID, period }) => (await kuma.call('getMonitorBeats', monitorID, period)).data,
  },
  {
    name: 'get_monitor_chart_data',
    events: ['getMonitorChartData'],
    annotations: READ,
    description:
      'Aggregated up, down and ping figures for the monitor chart: per minute up to 24 hours, per hour up to 720, per day beyond.',
    input: { id: id('Monitor'), period: z.number().positive().describe('Hours back from now') },
    run: async (kuma, { id: monitorID, period }) => (await kuma.call('getMonitorChartData', monitorID, period)).data,
  },
  {
    name: 'count_important_heartbeats',
    events: ['monitorImportantHeartbeatListCount'],
    annotations: READ,
    description: 'How many status changes (important heartbeats) are recorded, for one monitor or all of them.',
    input: { monitorID: num.describe('Leave out for every monitor') },
    run: async (kuma, { monitorID = null }) => (await kuma.call('monitorImportantHeartbeatListCount', monitorID)).count,
  },
  {
    name: 'list_important_heartbeats',
    events: ['monitorImportantHeartbeatListPaged'],
    annotations: READ,
    description: 'Status changes (the dashboard event list), newest first, for one monitor or all of them.',
    input: {
      monitorID: num.describe('Leave out for every monitor'),
      offset: z.number().int().min(0).optional(),
      count: z.number().int().min(1).max(500).optional().describe('Default 25'),
    },
    run: async (kuma, { monitorID = null, offset = 0, count = 25 }) =>
      (await kuma.call('monitorImportantHeartbeatListPaged', monitorID, offset, count)).data,
  },
  {
    name: 'clear_monitor_events',
    events: ['clearEvents'],
    annotations: DESTRUCTIVE,
    description: "Clear a monitor's event list (status change messages). Heartbeats stay.",
    input: { id: id('Monitor') },
    run: async (kuma, { id: monitorID }) => clean(await kuma.call('clearEvents', monitorID)),
  },
  {
    name: 'clear_monitor_heartbeats',
    events: ['clearHeartbeats'],
    annotations: DESTRUCTIVE,
    description: "Delete a monitor's heartbeats and uptime statistics.",
    input: { id: id('Monitor') },
    run: async (kuma, { id: monitorID }) => clean(await kuma.call('clearHeartbeats', monitorID)),
  },
  {
    name: 'clear_all_statistics',
    events: ['clearStatistics'],
    annotations: DESTRUCTIVE,
    description: 'Delete the heartbeats and uptime statistics of every monitor.',
    input: {},
    run: async (kuma) => clean(await kuma.call('clearStatistics')),
  },
  {
    name: 'check_domain_expiry_support',
    events: ['checkDomain'],
    annotations: READ,
    description: 'Whether Kuma can watch the domain expiry of a monitor target, and which domain and TLD it would check.',
    input: { type: z.string().describe('Monitor type'), url: str, hostname: str, grpcUrl: str },
    run: async (kuma, partial) => clean(await kuma.call('checkDomain', partial)),
  },
  {
    name: 'list_monitor_types',
    events: [],
    annotations: READ,
    description: 'Monitor types that support conditions, with their condition variables and operators.',
    input: {},
    run: async (kuma) => kuma.state.monitorTypeList,
  },

  // --- tags -------------------------------------------------------------
  {
    name: 'list_tags',
    events: ['getTags'],
    annotations: READ,
    description: 'Every tag: id, name and colour.',
    input: {},
    run: async (kuma) => (await kuma.call('getTags')).tags,
  },
  {
    name: 'create_tag',
    events: ['addTag'],
    annotations: { ...WRITE, idempotentHint: false },
    description: 'Create a tag.',
    input: { name: z.string(), color: z.string().describe('Hex colour, e.g. #2563EB') },
    run: async (kuma, { name, color }) => (await kuma.call('addTag', { name, color })).tag,
  },
  {
    name: 'update_tag',
    events: ['editTag'],
    annotations: WRITE,
    description: 'Rename or recolour a tag. Fields left out keep their value.',
    input: { id: id('Tag'), name: z.string().optional(), color: z.string().optional() },
    run: async (kuma, { id: tagID, name, color }) => {
      const current = findIn((await kuma.call('getTags')).tags, tagID, 'tag');
      return (await kuma.call('editTag', { id: tagID, name: name ?? current.name, color: color ?? current.color })).tag;
    },
  },
  {
    name: 'delete_tag',
    events: ['deleteTag'],
    annotations: DESTRUCTIVE,
    description: 'Delete a tag and remove it from every monitor.',
    input: { id: id('Tag') },
    run: async (kuma, { id: tagID }) => clean(await kuma.call('deleteTag', tagID)),
  },
  {
    name: 'add_monitor_tag',
    events: ['addMonitorTag'],
    annotations: { ...WRITE, idempotentHint: false },
    description: 'Put a tag on a monitor, optionally with a value.',
    input: { tagID: id('Tag'), monitorID: id('Monitor'), value: z.string().optional() },
    run: async (kuma, { tagID, monitorID, value = '' }) => clean(await kuma.call('addMonitorTag', tagID, monitorID, value)),
  },
  {
    name: 'update_monitor_tag',
    events: ['editMonitorTag'],
    annotations: WRITE,
    description: "Change the value of a tag on a monitor.",
    input: { tagID: id('Tag'), monitorID: id('Monitor'), value: z.string() },
    run: async (kuma, { tagID, monitorID, value }) => clean(await kuma.call('editMonitorTag', tagID, monitorID, value)),
  },
  {
    name: 'delete_monitor_tag',
    events: ['deleteMonitorTag'],
    annotations: DESTRUCTIVE,
    description: 'Take a tag off a monitor. The value has to match the one on the monitor, "" for none.',
    input: { tagID: id('Tag'), monitorID: id('Monitor'), value: z.string().optional() },
    run: async (kuma, { tagID, monitorID, value = '' }) => clean(await kuma.call('deleteMonitorTag', tagID, monitorID, value)),
  },

  // --- notifications ----------------------------------------------------
  {
    name: 'list_notifications',
    events: [],
    annotations: READ,
    description: 'Every notification channel with its full provider settings.',
    input: {},
    run: async (kuma) => (kuma.state.notificationList || []).map((n) => ({ id: n.id, ...parseConfig(n), active: n.active })),
  },
  {
    name: 'create_notification',
    events: ['addNotification'],
    annotations: { ...WRITE, idempotentHint: false },
    description:
      'Add a notification channel. Provider fields are named as Kuma names them; read an existing one with list_notifications to see the shape.',
    input: { notification: NOTIFICATION_FIELDS.describe('At least name and type, plus the provider fields') },
    run: async (kuma, { notification }) => clean(await kuma.call('addNotification', notification, null)),
  },
  {
    name: 'update_notification',
    events: ['addNotification'],
    annotations: WRITE,
    description: 'Change a notification channel. Pass only the fields to change; the rest are kept.',
    input: { id: id('Notification'), changes: NOTIFICATION_FIELDS },
    run: async (kuma, { id: notificationID, changes }) => {
      const current = parseConfig(findIn(kuma.state.notificationList, notificationID, 'notification'));
      return clean(await kuma.call('addNotification', { ...current, ...changes }, notificationID));
    },
  },
  {
    name: 'delete_notification',
    events: ['deleteNotification'],
    annotations: DESTRUCTIVE,
    description: 'Delete a notification channel.',
    input: { id: id('Notification') },
    run: async (kuma, { id: notificationID }) => clean(await kuma.call('deleteNotification', notificationID)),
  },
  {
    name: 'test_notification',
    events: ['testNotification'],
    annotations: { ...WRITE, idempotentHint: false, openWorldHint: true },
    description: 'Send a test message through a notification channel: an existing one by id, or settings not yet saved.',
    input: {
      id: num.describe('Existing channel to test'),
      notification: NOTIFICATION_FIELDS.optional().describe('Settings to test, or overrides on the existing channel'),
    },
    run: async (kuma, { id: notificationID, notification = {} }) => {
      const base = notificationID ? parseConfig(findIn(kuma.state.notificationList, notificationID, 'notification')) : {};
      return clean(await kuma.call('testNotification', { ...base, ...notification }));
    },
  },
  {
    name: 'check_apprise',
    events: ['checkApprise'],
    annotations: READ,
    description: 'Whether the Apprise command line tool is installed on the Kuma server.',
    input: {},
    run: async (kuma) => ({ installed: await kuma.call('checkApprise') }),
  },
  {
    name: 'get_webpush_public_key',
    events: ['getWebpushVapidPublicKey'],
    annotations: WRITE,
    description: 'The VAPID public key for browser push notifications. Kuma generates the key pair on first use.',
    input: {},
    run: async (kuma) => ({ publicKey: (await kuma.call('getWebpushVapidPublicKey')).msg }),
  },

  // --- proxies ----------------------------------------------------------
  {
    name: 'list_proxies',
    events: [],
    annotations: READ,
    description: 'Every proxy monitors can go through.',
    input: {},
    run: async (kuma) => kuma.state.proxyList || [],
  },
  {
    name: 'create_proxy',
    events: ['addProxy'],
    annotations: { ...WRITE, idempotentHint: false },
    description: 'Add a proxy.',
    input: { proxy: PROXY_FIELDS.describe('At least protocol, host and port') },
    run: async (kuma, { proxy }) => clean(await kuma.call('addProxy', proxy, null)),
  },
  {
    name: 'update_proxy',
    events: ['addProxy'],
    annotations: WRITE,
    description: 'Change a proxy. Pass only the fields to change; the rest are kept.',
    input: { id: id('Proxy'), changes: PROXY_FIELDS },
    run: async (kuma, { id: proxyID, changes }) => {
      const current = findIn(kuma.state.proxyList, proxyID, 'proxy');
      return clean(await kuma.call('addProxy', { ...current, ...changes }, proxyID));
    },
  },
  {
    name: 'delete_proxy',
    events: ['deleteProxy'],
    annotations: DESTRUCTIVE,
    description: 'Delete a proxy. Monitors using it go direct.',
    input: { id: id('Proxy') },
    run: async (kuma, { id: proxyID }) => clean(await kuma.call('deleteProxy', proxyID)),
  },

  // --- docker hosts -----------------------------------------------------
  {
    name: 'list_docker_hosts',
    events: [],
    annotations: READ,
    description: 'Every Docker host docker monitors can query.',
    input: {},
    run: async (kuma) => kuma.state.dockerHostList || [],
  },
  {
    name: 'create_docker_host',
    events: ['addDockerHost'],
    annotations: { ...WRITE, idempotentHint: false },
    description: 'Add a Docker host.',
    input: { dockerHost: DOCKER_HOST_FIELDS.describe('name, dockerType and dockerDaemon') },
    run: async (kuma, { dockerHost }) => clean(await kuma.call('addDockerHost', dockerHost, null)),
  },
  {
    name: 'update_docker_host',
    events: ['addDockerHost'],
    annotations: WRITE,
    description: 'Change a Docker host. Pass only the fields to change.',
    input: { id: id('Docker host'), changes: DOCKER_HOST_FIELDS },
    run: async (kuma, { id: hostID, changes }) => {
      const current = findIn(kuma.state.dockerHostList, hostID, 'Docker host');
      return clean(await kuma.call('addDockerHost', { ...current, ...changes }, hostID));
    },
  },
  {
    name: 'delete_docker_host',
    events: ['deleteDockerHost'],
    annotations: DESTRUCTIVE,
    description: 'Delete a Docker host and unset it on monitors that used it.',
    input: { id: id('Docker host') },
    run: async (kuma, { id: hostID }) => clean(await kuma.call('deleteDockerHost', hostID)),
  },
  {
    name: 'test_docker_host',
    events: ['testDockerHost'],
    annotations: READ,
    description: 'Connect to a Docker host and count its containers: an existing one by id, or settings not yet saved.',
    input: { id: num.describe('Existing Docker host'), dockerHost: DOCKER_HOST_FIELDS.optional() },
    run: async (kuma, { id: hostID, dockerHost = {} }) => {
      const base = hostID ? findIn(kuma.state.dockerHostList, hostID, 'Docker host') : {};
      return clean(await kuma.call('testDockerHost', { ...base, ...dockerHost }));
    },
  },

  // --- remote browsers --------------------------------------------------
  {
    name: 'list_remote_browsers',
    events: [],
    annotations: READ,
    description: 'Every remote browser real-browser monitors can drive.',
    input: {},
    run: async (kuma) => kuma.state.remoteBrowserList || [],
  },
  {
    name: 'create_remote_browser',
    events: ['addRemoteBrowser'],
    annotations: { ...WRITE, idempotentHint: false },
    description: 'Add a remote browser (a Playwright websocket endpoint).',
    input: { name: z.string(), url: z.string().describe('e.g. ws://chrome:3000/chromium/playwright') },
    run: async (kuma, { name, url }) => clean(await kuma.call('addRemoteBrowser', { name, url }, null)),
  },
  {
    name: 'update_remote_browser',
    events: ['addRemoteBrowser'],
    annotations: WRITE,
    description: 'Rename a remote browser or change its URL.',
    input: { id: id('Remote browser'), name: z.string().optional(), url: z.string().optional() },
    run: async (kuma, { id: browserID, name, url }) => {
      const current = findIn(kuma.state.remoteBrowserList, browserID, 'remote browser');
      return clean(await kuma.call('addRemoteBrowser', { name: name ?? current.name, url: url ?? current.url }, browserID));
    },
  },
  {
    name: 'delete_remote_browser',
    events: ['deleteRemoteBrowser'],
    annotations: DESTRUCTIVE,
    description: 'Delete a remote browser and unset it on monitors that used it.',
    input: { id: id('Remote browser') },
    run: async (kuma, { id: browserID }) => clean(await kuma.call('deleteRemoteBrowser', browserID)),
  },
  {
    name: 'test_remote_browser',
    events: ['testRemoteBrowser'],
    annotations: READ,
    description: 'Check that Kuma can connect to a remote browser URL.',
    input: { url: z.string() },
    run: async (kuma, { url }) => clean(await kuma.call('testRemoteBrowser', { url })),
  },

  // --- API keys ---------------------------------------------------------
  {
    name: 'list_api_keys',
    events: ['getAPIKeyList'],
    annotations: READ,
    description: 'Every API key for the metrics endpoint: name, status and expiry. The keys themselves are never shown again.',
    input: {},
    run: async (kuma) => {
      await kuma.call('getAPIKeyList');
      return kuma.state.apiKeyList;
    },
  },
  {
    name: 'create_api_key',
    events: ['addAPIKey'],
    annotations: { ...WRITE, idempotentHint: false },
    description: 'Create an API key. The key is in the answer and only there: Kuma stores just its hash.',
    input: {
      name: z.string(),
      expires: str.describe('"YYYY-MM-DD HH:mm:ss" in UTC, or leave out for no expiry'),
      active: bool.describe('Default true'),
    },
    run: async (kuma, { name, expires = null, active = true }) => clean(await kuma.call('addAPIKey', { name, expires, active })),
  },
  {
    name: 'delete_api_key',
    events: ['deleteAPIKey'],
    annotations: DESTRUCTIVE,
    description: 'Delete an API key.',
    input: { id: id('API key') },
    run: async (kuma, { id: keyID }) => clean(await kuma.call('deleteAPIKey', keyID)),
  },
  {
    name: 'disable_api_key',
    events: ['disableAPIKey'],
    annotations: WRITE,
    description: 'Disable an API key without deleting it.',
    input: { id: id('API key') },
    run: async (kuma, { id: keyID }) => clean(await kuma.call('disableAPIKey', keyID)),
  },
  {
    name: 'enable_api_key',
    events: ['enableAPIKey'],
    annotations: WRITE,
    description: 'Enable a disabled API key.',
    input: { id: id('API key') },
    run: async (kuma, { id: keyID }) => clean(await kuma.call('enableAPIKey', keyID)),
  },

  // --- maintenance ------------------------------------------------------
  {
    name: 'list_maintenance',
    events: ['getMaintenanceList'],
    annotations: READ,
    description: 'Every maintenance window with its schedule, status (scheduled, under-maintenance, ended, inactive) and next timeslot.',
    input: {},
    run: async (kuma) => {
      await kuma.call('getMaintenanceList');
      return Object.values(kuma.state.maintenanceList || {});
    },
  },
  {
    name: 'get_maintenance',
    events: ['getMaintenance'],
    annotations: READ,
    description: 'One maintenance window with its schedule.',
    input: { id: id('Maintenance') },
    run: async (kuma, { id: maintenanceID }) => (await kuma.call('getMaintenance', maintenanceID)).maintenance,
  },
  {
    name: 'get_maintenance_monitors',
    events: ['getMonitorMaintenance'],
    annotations: READ,
    description: 'Ids of the monitors a maintenance window covers.',
    input: { id: id('Maintenance') },
    run: async (kuma, { id: maintenanceID }) => (await kuma.call('getMonitorMaintenance', maintenanceID)).monitors,
  },
  {
    name: 'get_maintenance_status_pages',
    events: ['getMaintenanceStatusPage'],
    annotations: READ,
    description: 'Status pages a maintenance window is shown on.',
    input: { id: id('Maintenance') },
    run: async (kuma, { id: maintenanceID }) => (await kuma.call('getMaintenanceStatusPage', maintenanceID)).statusPages,
  },
  {
    name: 'create_maintenance',
    events: ['addMaintenance'],
    annotations: { ...WRITE, idempotentHint: false },
    description:
      'Create a maintenance window. Monitors in it show as under maintenance and send no notifications. ' +
      'Pass monitorIDs and statusPageIDs to attach them in the same call.',
    input: {
      maintenance: MAINTENANCE_FIELDS.describe('At least title and strategy, plus the schedule fields the strategy uses'),
      monitorIDs: z.array(z.number().int()).optional(),
      statusPageIDs: z.array(z.number().int()).optional(),
    },
    run: async (kuma, { maintenance, monitorIDs, statusPageIDs }) => {
      const res = clean(await kuma.call('addMaintenance', { ...MAINTENANCE_DEFAULTS, ...maintenance }));
      if (monitorIDs) {
        await kuma.call('addMonitorMaintenance', res.maintenanceID, monitorIDs.map((m) => ({ id: m })));
      }
      if (statusPageIDs) {
        await kuma.call('addMaintenanceStatusPage', res.maintenanceID, statusPageIDs.map((s) => ({ id: s })));
      }
      return res;
    },
  },
  {
    name: 'update_maintenance',
    events: ['editMaintenance'],
    annotations: WRITE,
    description: 'Change a maintenance window. Pass only the fields to change; the rest are kept.',
    input: { id: id('Maintenance'), changes: MAINTENANCE_FIELDS },
    run: async (kuma, { id: maintenanceID, changes }) => {
      const current = (await kuma.call('getMaintenance', maintenanceID)).maintenance;
      return clean(await kuma.call('editMaintenance', { ...current, ...changes, id: maintenanceID }));
    },
  },
  {
    name: 'set_maintenance_monitors',
    events: ['addMonitorMaintenance'],
    annotations: WRITE,
    description: 'Set which monitors a maintenance window covers. Replaces the whole list.',
    input: { id: id('Maintenance'), monitorIDs: z.array(z.number().int()) },
    run: async (kuma, { id: maintenanceID, monitorIDs }) =>
      clean(await kuma.call('addMonitorMaintenance', maintenanceID, monitorIDs.map((m) => ({ id: m })))),
  },
  {
    name: 'set_maintenance_status_pages',
    events: ['addMaintenanceStatusPage'],
    annotations: WRITE,
    description: 'Set which status pages show a maintenance window. Replaces the whole list.',
    input: { id: id('Maintenance'), statusPageIDs: z.array(z.number().int()) },
    run: async (kuma, { id: maintenanceID, statusPageIDs }) =>
      clean(await kuma.call('addMaintenanceStatusPage', maintenanceID, statusPageIDs.map((s) => ({ id: s })))),
  },
  {
    name: 'pause_maintenance',
    events: ['pauseMaintenance'],
    annotations: WRITE,
    description: 'Deactivate a maintenance window without deleting it.',
    input: { id: id('Maintenance') },
    run: async (kuma, { id: maintenanceID }) => clean(await kuma.call('pauseMaintenance', maintenanceID)),
  },
  {
    name: 'resume_maintenance',
    events: ['resumeMaintenance'],
    annotations: WRITE,
    description: 'Reactivate a paused maintenance window.',
    input: { id: id('Maintenance') },
    run: async (kuma, { id: maintenanceID }) => clean(await kuma.call('resumeMaintenance', maintenanceID)),
  },
  {
    name: 'delete_maintenance',
    events: ['deleteMaintenance'],
    annotations: DESTRUCTIVE,
    description: 'Delete a maintenance window.',
    input: { id: id('Maintenance') },
    run: async (kuma, { id: maintenanceID }) => clean(await kuma.call('deleteMaintenance', maintenanceID)),
  },

  // --- status pages -----------------------------------------------------
  {
    name: 'list_status_pages',
    events: [],
    annotations: READ,
    description: 'Every status page: id, slug, title and settings.',
    input: {},
    run: async (kuma) => {
      await kuma.refresh();
      return kuma.state.statusPageList;
    },
  },
  {
    name: 'get_status_page',
    events: ['getStatusPage'],
    annotations: READ,
    description: 'One status page: its settings, its monitor groups, pinned incident and maintenance.',
    input: { slug: z.string() },
    run: async (kuma, { slug }) => {
      const { config } = await kuma.call('getStatusPage', slug);
      const { publicGroupList, incidents, maintenanceList } = await statusPageData(kuma, slug);
      return { config, publicGroupList, incidents, maintenanceList };
    },
  },
  {
    name: 'create_status_page',
    events: ['addStatusPage'],
    annotations: { ...WRITE, idempotentHint: false },
    description: 'Create an empty status page. Add groups and monitors with update_status_page.',
    input: { title: z.string(), slug: z.string().describe('Lowercase letters, digits and dashes') },
    run: async (kuma, { title, slug }) => clean(await kuma.call('addStatusPage', title, slug)),
  },
  {
    name: 'update_status_page',
    events: ['saveStatusPage'],
    annotations: WRITE,
    description:
      'Change a status page: settings, logo, and its monitor groups. Everything left out is kept as it is. ' +
      'publicGroupList replaces all groups; read the current ones with get_status_page first.',
    input: {
      slug: z.string().describe('Current slug'),
      changes: STATUS_PAGE_FIELDS.optional(),
      logo: z.string().optional().describe('data:image/png;base64,... for a new logo, or a URL'),
      publicGroupList: GROUP_LIST.optional(),
    },
    run: async (kuma, { slug, changes = {}, logo, publicGroupList }) => {
      const { config } = await kuma.call('getStatusPage', slug);
      const groups = publicGroupList ?? (await statusPageData(kuma, slug)).publicGroupList;
      const res = await kuma.call('saveStatusPage', slug, { ...config, ...changes }, logo ?? config.icon, groups);
      return clean(res);
    },
  },
  {
    name: 'delete_status_page',
    events: ['deleteStatusPage'],
    annotations: DESTRUCTIVE,
    description: 'Delete a status page with its groups and incidents.',
    input: { slug: z.string() },
    run: async (kuma, { slug }) => clean(await kuma.call('deleteStatusPage', slug)),
  },
  {
    name: 'post_incident',
    events: ['postIncident'],
    annotations: { ...WRITE, idempotentHint: false },
    description: 'Pin an incident banner on a status page. Pass id to update the pinned one instead.',
    input: {
      slug: z.string(),
      title: z.string(),
      content: z.string().describe('Markdown'),
      style: z.string().optional().describe('info, warning, danger, primary, light or dark'),
      id: num.describe('Existing incident to update'),
    },
    run: async (kuma, { slug, id: incidentID, title, content, style = 'warning' }) =>
      (await kuma.call('postIncident', slug, { id: incidentID ?? undefined, title, content, style })).incident,
  },
  {
    name: 'update_incident',
    events: ['editIncident'],
    annotations: WRITE,
    description: 'Edit an incident on a status page, including ones in the history.',
    input: {
      slug: z.string(),
      incidentID: id('Incident'),
      title: z.string(),
      content: z.string(),
      style: z.string().optional(),
      pin: bool,
    },
    run: async (kuma, { slug, incidentID, title, content, style = 'warning', pin = true }) =>
      (await kuma.call('editIncident', slug, incidentID, { title, content, style, pin })).incident,
  },
  {
    name: 'resolve_incident',
    events: ['resolveIncident'],
    annotations: WRITE,
    description: 'Mark an incident resolved. It moves to the history.',
    input: { slug: z.string(), incidentID: id('Incident') },
    run: async (kuma, { slug, incidentID }) => (await kuma.call('resolveIncident', slug, incidentID)).incident,
  },
  {
    name: 'unpin_incident',
    events: ['unpinIncident'],
    annotations: WRITE,
    description: 'Take the pinned incident banner off a status page.',
    input: { slug: z.string() },
    run: async (kuma, { slug }) => clean(await kuma.call('unpinIncident', slug)),
  },
  {
    name: 'delete_incident',
    events: ['deleteIncident'],
    annotations: DESTRUCTIVE,
    description: 'Delete an incident from a status page.',
    input: { slug: z.string(), incidentID: id('Incident') },
    run: async (kuma, { slug, incidentID }) => clean(await kuma.call('deleteIncident', slug, incidentID)),
  },
  {
    name: 'list_incident_history',
    events: ['getIncidentHistory'],
    annotations: READ,
    description: 'Past incidents of a status page, newest first. Pass the returned cursor for the next page.',
    input: { slug: z.string(), cursor: str },
    run: async (kuma, { slug, cursor = null }) => clean(await kuma.call('getIncidentHistory', slug, cursor)),
  },

  // --- settings and server ----------------------------------------------
  {
    name: 'get_settings',
    events: ['getSettings'],
    annotations: READ,
    description: 'General settings: base URL, timezone, retention, TLS expiry days, entry page, search engine visibility and so on.',
    input: {},
    run: async (kuma) => (await kuma.call('getSettings')).data,
  },
  {
    name: 'update_settings',
    events: ['setSettings'],
    annotations: WRITE,
    description: 'Change general settings. Pass only the keys to change; the rest are kept. disableAuth turns off the login page.',
    input: { changes: z.record(z.string(), z.any()).describe('Setting keys as get_settings names them') },
    run: async (kuma, { changes }) => {
      const current = (await kuma.call('getSettings')).data;
      return clean(await kuma.call('setSettings', { ...current, ...changes }, process.env.KUMA_PASSWORD));
    },
  },
  {
    name: 'set_server_timezone',
    events: ['initServerTimezone'],
    annotations: WRITE,
    description: "Set the server's timezone, as the web interface does on first login.",
    input: { timezone: z.string().describe('IANA zone, e.g. Europe/Helsinki') },
    run: async (kuma, { timezone }) => {
      await kuma.emit('initServerTimezone', [timezone], { waitFor: 'info' });
      return kuma.state.info;
    },
  },
  {
    name: 'get_server_info',
    events: [],
    annotations: READ,
    description: 'Kuma version, latest version, timezone, database type and runtime.',
    input: {},
    run: async (kuma) => kuma.state.info,
  },
  {
    name: 'get_database_size',
    events: ['getDatabaseSize'],
    annotations: READ,
    description: 'Size of the Kuma database in bytes.',
    input: {},
    run: async (kuma) => (await kuma.call('getDatabaseSize')).size,
  },
  {
    name: 'shrink_database',
    events: ['shrinkDatabase'],
    annotations: WRITE,
    description: 'Compact the database (SQLite VACUUM). Can take a while on a big one.',
    input: {},
    run: async (kuma) => clean(await kuma.call('shrinkDatabase')),
  },
  {
    name: 'get_push_example',
    events: ['getPushExample'],
    annotations: READ,
    description: 'Example code for calling a push monitor URL.',
    input: { language: z.string().describe('e.g. bash-curl, javascript-fetch, python, powershell, go, php') },
    run: async (kuma, { language }) => (await kuma.call('getPushExample', language)).code,
  },
  {
    name: 'list_games',
    events: ['getGameList'],
    annotations: READ,
    description: 'Games the gamedig monitor type can query, with their keys.',
    input: {},
    run: async (kuma) => (await kuma.call('getGameList')).gameList,
  },
  {
    name: 'list_pm2_processes',
    events: ['getPM2ProcessList'],
    annotations: READ,
    description: 'PM2 processes on the Kuma server, for the pm2 monitor type.',
    input: {},
    run: async (kuma) => (await kuma.call('getPM2ProcessList')).processList,
  },
  {
    name: 'test_chrome',
    events: ['testChrome'],
    annotations: READ,
    description: 'Check a Chrome or Chromium executable for real-browser monitors and report its version.',
    input: { executable: z.string().describe('Path, or "#playwright_chromium" for the bundled one') },
    run: async (kuma, { executable }) => clean(await kuma.call('testChrome', executable)),
  },
  {
    name: 'set_avatar',
    events: ['setAvatar'],
    annotations: WRITE,
    description: "Set the account's profile picture, or remove it. Needs a Kuma build with the setAvatar event.",
    input: { image: z.string().nullable().describe('data:image/png;base64,... up to 512 KB, or null to remove') },
    run: async (kuma, { image }) => clean(await kuma.call('setAvatar', image || null)),
  },

  // --- cloudflared ------------------------------------------------------
  {
    name: 'get_cloudflared_status',
    events: ['cloudflared_join', 'cloudflared_leave'],
    annotations: READ,
    description: "Status of Kuma's built-in Cloudflare Tunnel: installed, running, last message and error, and the saved token.",
    input: {},
    run: async (kuma) => {
      await kuma.emit('cloudflared_join', [], { waitFor: 'cloudflared_token' });
      await kuma.emit('cloudflared_leave');
      return kuma.state.cloudflared;
    },
  },
  {
    name: 'start_cloudflared',
    events: ['cloudflared_start'],
    annotations: WRITE,
    description: "Start Kuma's built-in Cloudflare Tunnel. A token passed here is saved for next time.",
    input: { token: z.string().optional().describe('Tunnel token; leave out to use the saved one') },
    run: async (kuma, { token }) => {
      await kuma.emit('cloudflared_join');
      await kuma.emit('cloudflared_start', [token ?? null], { waitFor: 'cloudflared_running', waitMs: 10_000 });
      await kuma.emit('cloudflared_leave');
      return kuma.state.cloudflared;
    },
  },
  {
    name: 'stop_cloudflared',
    events: ['cloudflared_stop'],
    annotations: DESTRUCTIVE,
    description: "Stop Kuma's built-in Cloudflare Tunnel. Anyone reaching Kuma through it loses access.",
    input: {},
    run: async (kuma) => {
      let failure = null;
      await kuma.emit('cloudflared_join');
      // Kuma only answers this one when it fails.
      const onFailure = (res) => {
        failure = res;
      };
      await kuma.emit('cloudflared_stop', [process.env.KUMA_PASSWORD, onFailure], { waitFor: 'cloudflared_running', waitMs: 10_000 });
      await kuma.emit('cloudflared_leave');
      if (failure) {
        throw new Error(`Uptime Kuma refused cloudflared_stop: ${failure.msg}`);
      }
      return kuma.state.cloudflared;
    },
  },
  {
    name: 'remove_cloudflared_token',
    events: ['cloudflared_removeToken'],
    annotations: DESTRUCTIVE,
    description: "Forget the saved Cloudflare Tunnel token.",
    input: {},
    run: async (kuma) => {
      await kuma.emit('cloudflared_removeToken');
      return { removed: true };
    },
  },
];

module.exports = { tools, clean, genToken, notificationIDs, MONITOR_DEFAULTS, PUSH_TOKEN_LENGTH };
