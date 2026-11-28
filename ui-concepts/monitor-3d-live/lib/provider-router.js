/* Wyarden 3D monitor: the small boundary between raw provider hooks and the hub.
 *
 * An adapter is deliberately plain data and functions:
 *   {
 *     provider: 'grok',
 *     routes: ['grok', 'claude'],
 *     matches(payload, context) -> boolean,
 *     normalise(payload, context) -> canonical record | null,
 *     planConfig?(hub, ...args) -> install.js-compatible change records
 *   }
 *
 * `routes` are authenticated ingress labels, never provider identity. `matches` must identify the
 * provider from the payload shape. That is what lets a Grok payload sent through a Claude-compatible
 * hook reach Grok exactly once without trusting the URL segment. Adapters return only the redacted
 * canonical record; unknown record or event fields are refused before the hub stores anything.
 */
'use strict';

const contract = require('./contract.js');
const Model = require('../media/model.js');

const SOURCES = new Set(['hook', 'transcript']);
const PROVIDERS = new Set(contract.AGENTS);
const RECORD_KEYS = new Set(['agent', 'session', 'key', 'cwd', 'root', 'source', 'events']);
const RECORD_REQUIRED = ['agent', 'session', 'key', 'cwd', 'root', 'source', 'events'];
const EVENT_KEYS = new Set([
  'v', 't', 'at', 'agent', 'session', 'ws', 'ev', 'grade', 'src', 'turn', 'by',
  'call', 'tool', 'class', 'hash', 'server', 'serverSource', 'ok', 'ms', 'msGrade',
  'error', 'interrupted', 'kind', 'op', 'path', 'url', 'scheme', 'sub', 'type',
  'parentCall', 'why', 'answer', 'root', 'title', 'space', 'source', 'model',
  'reason', 'chars', 'asks', 'outcome'
]);
const EVENT_REQUIRED = ['v', 't', 'agent', 'session', 'ws', 'ev', 'grade', 'src'];
const ROOT_KEYS = new Set(['root', 'real', 'ws', 'name']);
const CONFIG_CHANGE_KEYS = new Set(['dir', 'file', 'exists', 'before', 'after', 'changed', 'state', 'error', 'reformatted', 'added', 'replaced', 'collapsed', 'removed']);
const CONFIG_CHANGE_REQUIRED = [...CONFIG_CHANGE_KEYS];
const CONFIG_STATES = new Set(['missing', 'installed', 'partly', 'stale', 'unreadable']);
const SAFE_ID_FIELDS = ['turn', 'by', 'call', 'sub', 'parentCall'];
const SAFE_NAME_FIELDS = ['tool', 'server', 'serverSource', 'type', 'source', 'model', 'reason'];
const CLASSES = new Set(['read', 'edit', 'search', 'execute', 'fetch', 'agent', 'ask', 'mcp', 'other']);
const TOUCH_KINDS = new Set(['file', 'dir', 'url', 'search', 'mcp-resource']);
const OPS = new Set(['read', 'write', 'search', 'unknown']);
const WHYS = new Set(['permission', 'question', 'idle']);
const ANSWERS = new Set(['unknown', 'refused', 'answered', 'allowed']);
const OUTCOMES = new Set(['done', 'failed', 'interrupted']);
const ERRORS = new Set(['tool_error', 'interrupted', 'denied']);
const SHORT_TEXT_MAX = 120;
const MAX_EVENTS = 256;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => {
  try { return isObject(object) && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined; }
  catch { return undefined; }
};
const ownKeys = value => {
  try { return Object.keys(value); } catch { return []; }
};
const hasOnly = (value, allowed) => ownKeys(value).every(key => allowed.has(key));
const hasAll = (value, required) => {
  try { return required.every(key => Object.prototype.hasOwnProperty.call(value, key)); } catch { return false; }
};
const sourceOf = (value, explicit) => {
  if (explicit !== undefined) return SOURCES.has(explicit) ? explicit : '';
  const wy = own(value, '_wy');
  return isObject(wy) && own(wy, 'src') === 'transcript' ? 'transcript' : 'hook';
};
const routeOf = options => {
  if (!isObject(options)) return undefined;
  const route = options.route === undefined ? options.hint : options.route;
  return route === 'transcript' ? undefined : route;
};
const cleanRoute = route => typeof route === 'string' && PROVIDERS.has(route) ? route : undefined;

function sourceTextIsSafe(value, source) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 100) return false;
  const cut = value.indexOf(':');
  if (cut < 1 || cut === value.length - 1) return false;
  const kind = value.slice(0, cut), text = value.slice(cut + 1);
  if (source === 'hook' && kind !== 'hook' && kind !== 'args') return false;
  if (source === 'transcript' && kind !== 'transcript') return false;
  return contract.safeName(text) === text;
}

function pathIsSafe(value) {
  if (typeof value === 'string') {
    return value === contract.cleanText(value, contract.LIMITS.path) &&
      !contract.isAbsolute(value) && !value.includes('\\') && !value.split('/').includes('..');
  }
  return isObject(value) && own(value, 'outside') === true && typeof own(value, 'name') === 'string' &&
    contract.cleanName(own(value, 'name')) === own(value, 'name') && hasOnly(value, new Set(['outside', 'name']));
}

function eventIsSafe(event, provider, session, source) {
  try {
    if (!isObject(event) || !hasAll(event, EVENT_REQUIRED) || !hasOnly(event, EVENT_KEYS)) return false;
    if (event.v !== 1 || event.agent !== provider || event.session !== session || typeof event.ws !== 'string' || !Number.isFinite(event.t)) return false;
    if (!/^[A-Za-z0-9_-]{0,80}$/.test(event.ws)) return false;
    if (event.grade !== 'exact' && event.grade !== 'derived') return false;
    if (!sourceTextIsSafe(event.src, source)) return false;
    for (const key of SAFE_ID_FIELDS) if (event[key] !== undefined && (typeof event[key] !== 'string' || contract.safeId(event[key]) !== event[key])) return false;
    for (const key of SAFE_NAME_FIELDS) if (event[key] !== undefined && (typeof event[key] !== 'string' || contract.safeName(event[key]) !== event[key])) return false;
    if (event.class !== undefined && !CLASSES.has(event.class)) return false;
    if (event.kind !== undefined && !TOUCH_KINDS.has(event.kind)) return false;
    if (event.op !== undefined && !OPS.has(event.op)) return false;
    if (event.why !== undefined && !WHYS.has(event.why)) return false;
    if (event.answer !== undefined && !ANSWERS.has(event.answer)) return false;
    if (event.outcome !== undefined && !OUTCOMES.has(event.outcome)) return false;
    if (event.error !== undefined && !ERRORS.has(event.error)) return false;
    if (event.msGrade !== undefined && event.msGrade !== 'exact' && event.msGrade !== 'derived') return false;
    if (event.hash !== undefined && (typeof event.hash !== 'string' || !/^[0-9a-f]{8}$/.test(event.hash))) return false;
    if (event.scheme !== undefined && (typeof event.scheme !== 'string' || !/^[a-z][a-z0-9+.-]{0,31}$/.test(event.scheme))) return false;
    if (event.title !== undefined && (typeof event.title !== 'string' || event.title.length > SHORT_TEXT_MAX || contract.cleanText(event.title, SHORT_TEXT_MAX) !== event.title)) return false;
    if (event.space !== undefined && (typeof event.space !== 'string' || event.space.length > SHORT_TEXT_MAX || contract.cleanText(event.space, SHORT_TEXT_MAX) !== event.space)) return false;
    if (event.root !== undefined && (!isObject(event.root) || !hasAll(event.root, ['name']) || !hasOnly(event.root, new Set(['name'])) ||
        typeof event.root.name !== 'string' || event.root.name.length > contract.LIMITS.name || contract.cleanName(event.root.name) !== event.root.name)) return false;
    if (event.ok !== undefined && typeof event.ok !== 'boolean') return false;
    if (event.interrupted !== undefined && typeof event.interrupted !== 'boolean') return false;
    if (event.asks !== undefined && typeof event.asks !== 'boolean') return false;
    if (event.chars !== undefined && (!Number.isInteger(event.chars) || event.chars < 0)) return false;
    if (event.ms !== undefined && (!Number.isFinite(event.ms) || event.ms < 0)) return false;
    if (event.at !== undefined && !Number.isFinite(event.at)) return false;
    if (event.path !== undefined && !pathIsSafe(event.path)) return false;
    if (event.url !== undefined && contract.cleanUrl(event.url) !== event.url) return false;
    Model.validate(event);
    return true;
  } catch { return false; }
}

function rootIsSafe(root) {
  if (root == null) return true;
  if (!isObject(root) || !hasAll(root, ['root']) || !hasOnly(root, ROOT_KEYS)) return false;
  if (typeof root.root !== 'string' || root.root.length > contract.MAX_PATH || !contract.isAbsolute(root.root) ||
      root.root !== contract.cleanText(root.root, contract.MAX_PATH)) return false;
  if (root.real !== undefined && (typeof root.real !== 'string' || root.real.length > contract.MAX_PATH ||
      !contract.isAbsolute(root.real) || root.real !== contract.cleanText(root.real, contract.MAX_PATH))) return false;
  if (root.ws !== undefined && (typeof root.ws !== 'string' || root.ws.length > contract.LIMITS.name ||
      root.ws !== contract.cleanName(root.ws))) return false;
  if (root.name !== undefined && (typeof root.name !== 'string' || root.name.length > contract.LIMITS.name ||
      root.name !== contract.cleanName(root.name))) return false;
  return true;
}

function recordIsSafe(record, adapter, context) {
  try {
    if (!isObject(record) || !hasAll(record, RECORD_REQUIRED) || !hasOnly(record, RECORD_KEYS)) return null;
    const provider = adapter.provider;
    const session = record.session;
    if (record.agent !== provider || !contract.isSessionId(session) || record.key !== provider + ':' + session) return null;
    if (record.source !== context.source || !Array.isArray(record.events) || record.events.length > MAX_EVENTS) return null;
    if (record.cwd !== null && record.cwd !== undefined &&
        (typeof record.cwd !== 'string' || record.cwd.length > contract.MAX_PATH || !contract.isAbsolute(record.cwd) ||
         record.cwd !== contract.cleanText(record.cwd, contract.MAX_PATH))) return null;
    if (!rootIsSafe(record.root)) return null;
    for (const event of record.events) if (!eventIsSafe(event, provider, session, context.source)) return null;

    // Copy the contract fields only. An adapter cannot smuggle a raw payload through a useful-looking
    // object, and an inherited property cannot become part of the hub's stored record.
    const clean = {
      agent: provider,
      session,
      key: provider + ':' + session,
      cwd: record.cwd == null ? null : record.cwd,
      root: record.root == null ? null : Object.assign({}, record.root),
      source: context.source,
      events: record.events.map(event => Object.assign({}, event))
    };
    if (!clean.root && clean.cwd && typeof context.rootInfo === 'function') {
      try {
        const root = context.rootInfo(clean.cwd);
        if (rootIsSafe(root)) clean.root = root;
      } catch { /* the hub can still keep the session without a root */ }
    }
    return clean;
  } catch { return null; }
}

function configChangeIsSafe(change) {
  try {
    if (!isObject(change) || !hasAll(change, CONFIG_CHANGE_REQUIRED) || !hasOnly(change, CONFIG_CHANGE_KEYS)) return false;
    return typeof change.dir === 'string' && typeof change.file === 'string' && typeof change.before === 'string' &&
      typeof change.after === 'string' && typeof change.exists === 'boolean' && typeof change.changed === 'boolean' &&
      CONFIG_STATES.has(change.state) && (change.error === null || typeof change.error === 'string') &&
      typeof change.reformatted === 'boolean' && ['added', 'replaced', 'collapsed', 'removed'].every(k => Number.isInteger(change[k]) && change[k] >= 0);
  } catch { return false; }
}

function checkedAdapter(value) {
  if (!isObject(value) || typeof value.provider !== 'string' || !PROVIDERS.has(value.provider) ||
      !Array.isArray(value.routes) || !value.routes.length || typeof value.matches !== 'function' ||
      typeof value.normalise !== 'function') throw new TypeError('provider adapter shape is invalid');
  const routes = new Set(value.routes);
  if ([...routes].some(route => !PROVIDERS.has(route))) throw new TypeError('provider adapter route is invalid');
  if (value.planConfig !== undefined && typeof value.planConfig !== 'function') throw new TypeError('provider config planner is invalid');
  return Object.freeze({
    provider: value.provider,
    routes,
    matches: value.matches,
    normalise: value.normalise,
    forget: typeof value.forget === 'function' ? value.forget : () => {},
    size: typeof value.size === 'function' ? value.size : () => 0,
    planConfig: value.planConfig
  });
}

/**
 * Build the shared provider registry.
 *
 * `feed(payload, {t, hint|route, source})` returns a canonical record or null. `context` passed to
 * adapters is `{t, route, source, rootInfo}`. `planConfig(provider, hub, ...args)` is pure and returns
 * `{provider, changes}` where `changes` has the same per-file shape as `install.plan()`; it never writes.
 */
function createProviderRouter(adapters, options = {}) {
  const list = (Array.isArray(adapters) ? adapters : []).map(checkedAdapter);
  const byProvider = new Map();
  for (const adapter of list) {
    if (byProvider.has(adapter.provider)) throw new TypeError('duplicate provider adapter');
    byProvider.set(adapter.provider, adapter);
  }
  const rootInfo = typeof options.rootInfo === 'function' ? options.rootInfo : undefined;

  const router = {
    feed(payload, opts) {
      const explicitSource = isObject(opts) ? opts.source : undefined;
      const source = sourceOf(payload, explicitSource);
      if (!SOURCES.has(source)) return null;
      const routeGiven = routeOf(opts);
      if (routeGiven !== undefined && !PROVIDERS.has(routeGiven)) return null;
      const route = cleanRoute(routeGiven);
      const t = isObject(opts) && Number.isFinite(opts.t) ? opts.t : Date.now();
      const context = { t, route, source, rootInfo };
      const candidates = list.filter(adapter => route === undefined || adapter.routes.has(route));
      const matched = [];
      for (const adapter of candidates) {
        try { if (adapter.matches(payload, context) === true) matched.push(adapter); } catch { /* malformed input is refused */ }
      }
      if (matched.length !== 1) return null;
      let record;
      try { record = matched[0].normalise(payload, context); } catch { return null; }
      return recordIsSafe(record, matched[0], context);
    },
    forget(key) {
      if (typeof key !== 'string') return;
      const cut = key.indexOf(':');
      const provider = cut < 0 ? 'claude' : key.slice(0, cut);
      const adapter = byProvider.get(provider);
      if (adapter) { try { adapter.forget(key); } catch { /* bounded adapter state is optional */ } }
    },
    size() {
      let total = 0;
      for (const adapter of list) {
        try { const size = adapter.size(); total += Number.isFinite(size) ? size : 0; } catch { /* no size */ }
      }
      return total;
    },
    planConfig(provider, ...args) {
      const adapter = byProvider.get(provider);
      if (!adapter || !adapter.planConfig) return null;
      let changes;
      try { changes = adapter.planConfig(...args); } catch { return null; }
      if (!Array.isArray(changes) || !changes.every(configChangeIsSafe)) return null;
      return { provider, changes };
    }
  };
  return router;
}

module.exports = { createProviderRouter, MAX_EVENTS };
