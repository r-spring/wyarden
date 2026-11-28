/* Wyarden 3D monitor, working mock-up: the hub's logic, with no I/O of its own.
 *
 * The hub is one per machine. It hears about Claude Code sessions from three sources (hooks,
 * transcripts, the CLI's session files), knows which editor windows are open and which folders
 * they show, and keeps one live model for "all open" and one for each open workspace. This file is
 * that bookkeeping and nothing else: no sockets, no files, no timers. Time comes from `now()` and
 * delayed work from the injected `schedule(fn, ms)`, so every rule here can be tested with a manual
 * clock, and the listener (hub-server.js) stays a thin shell around it.
 *
 * The contract is docs/monitor-3d/05-working-mockup.md, section 7.1 and 7.4. Path containment uses
 * lib/contract.js only. The one place a folder may be read from disk is contract.normPath (a real
 * path) on a window's folders and a session's cwd, once each, and the injected `rootInfo` for a
 * session the CLI's list names before any payload did.
 */
'use strict';
const crypto = require('node:crypto');
const contract = require('./contract.js');

const { ALL, LIMITS, VERSION } = contract;
const MAX_SESSIONS = 500;           // sessions remembered; the least recently active unowned go first
const MAX_DUPES = 500;              // duplicate keys remembered per session
const MAX_TAILS = 24;
const MAX_FOLDERS = 64;             // folders one window may name
const RANK = { 'sessions-file': 1, transcript: 2, hook: 3 };
const COUNTING = /^(session|turn|wait)\./;       // the events that can change a chip's counts
const STATUSES = new Set(['busy', 'idle', 'waiting']);
const TITLE_MAX = 120;              // a session's tab title, as the list gives it

const className = error => (error && error.constructor && error.constructor.name) || typeof error;

/** The key 04 section 2.5 gives each event, so a repeat can be told from a new one. */
function dupeKey(e) {
  const ev = e.ev;
  const sec = () => String(Math.round(e.t / 1000));
  if (/^(tool|mcp)\./.test(ev)) return ev + '|' + e.call;
  if (ev === 'resource.touch') {
    const where = e.url != null ? e.url : typeof e.path === 'string' ? e.path : JSON.stringify(e.path || null);
    return ev + '|' + (e.call || '') + '|' + e.kind + '|' + e.op + '|' + where + (e.server ? '|' + e.server : '');
  }
  // A turn the agent gave no id for falls back to the second it arrived in, like session and wait.
  if (/^turn\./.test(ev)) return ev + '|' + (e.turn ? 'id:' + e.turn : 't:' + sec());
  if (/^subagent\./.test(ev)) return ev + '|' + e.sub;
  return ev + '|' + sec();
}
/** The same key, never long: 500 of them are kept for each session. */
function boundedKey(e) {
  const key = dupeKey(e);
  return key.length <= 200 ? key : 'h|' + crypto.createHash('sha256').update(key).digest('base64url');
}
/** `cwd` when it is a path the hub may keep, else null: then the session is known and owned by nobody. */
const keptCwd = cwd => (typeof cwd === 'string' && cwd.length <= contract.MAX_PATH && contract.isAbsolute(cwd) ? cwd : null);
/** A node id taken apart exactly: `<class>:<agent>:<session>[:<rest>]`. Session ids hold no ':'. */
function parseNodeId(id) {
  const m = /^([a-z]):([a-z]+):([^:]+)(?::([\s\S]*))?$/.exec(id);
  if (!m || !contract.AGENTS.includes(m[2]) || !contract.isSessionId(m[3])) return null;
  return { cls: m[1], key: m[2] + ':' + m[3], rest: m[4] };
}

function createHubCore(options = {}) {
  const Model = options.Model || require('../media/model.js');
  const normaliser = options.normaliser || { feed: () => null, forget() {} };
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const schedule = typeof options.schedule === 'function' ? options.schedule
    : (fn, ms) => { const timer = setTimeout(fn, ms); if (timer.unref) timer.unref(); return () => clearTimeout(timer); };
  const log = typeof options.log === 'function' ? options.log : () => {};
  const rootInfo = typeof options.rootInfo === 'function' ? options.rootInfo : contract.rootInfo;
  const epoch = typeof options.epoch === 'string' ? options.epoch : crypto.randomBytes(4).toString('hex');
  const lingerMs = Number.isFinite(options.lingerMs) ? options.lingerMs : LIMITS.lingerMs;
  const silentMs = Number.isFinite(options.silentMs) ? options.silentMs : LIMITS.silentMs;
  // A session file can be missed for one pass while the CLI rewrites it; a session ends on the second miss.
  const goneAfter = Number.isInteger(options.goneAfter) && options.goneAfter > 0 ? options.goneAfter : 2;
  const started = now();

  const sessions = new Map();       // key -> session record; Map order is not used for recency
  const windows = new Map();        // id -> window; Map order is attach order (a re-attach keeps its place)
  // A workspace is what one window has open: key -> {key, name, folders: [{key, norm, name}], windows: Set, apps: Set}.
  let workspaces = new Map();
  let byFolder = new Map();         // folder norm -> [workspace keys]: the windows that hold that folder
  const models = new Map([[ALL, Model.create()]]);
  const counts = { received: 0, applied: 0, duplicates: 0, rejected: 0, tooLarge: 0, ignored: 0, replayed: 0 };
  const info = { role: 'thread', tails: 0, off: [] };
  let seq = 0, windowSeq = 0, lastHookAt = null, wsPending = false;

  const core = {
    onSend: () => {},
    /** Called when a `workspaces` message may be due; the server coalesces through `schedule`. */
    onWorkspacesPending: () => {},
    /** Called just before a window's snapshot is made, with its scope. */
    onBeforeSnapshot: () => {},
    epoch
  };
  const send = (id, message) => { try { core.onSend(id, message); } catch (error) { log('warn', 'onSend failed: ' + className(error)); } };
  const markWorkspaces = () => {
    if (wsPending) return;
    wsPending = true;
    try { core.onWorkspacesPending(); } catch (error) { log('warn', 'onWorkspacesPending failed: ' + className(error)); }
  };

  /* ---------- sessions ---------- */

  /** The workspaces that own a session: the longest open folder that holds its cwd decides, and
      every window that has that folder open owns it. Sorted; empty when no window does. */
  function ownersOf(s) {
    if (!s.cwdNorm) return [];
    let best = null;
    for (const norm of byFolder.keys()) {
      if ((!best || norm.length > best.length) && contract.isInside(norm, s.cwdNorm)) best = norm;
    }
    return best ? byFolder.get(best).slice() : [];
  }
  const sameKeys = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);
  function setCwd(s, given, root) {
    const cwd = keptCwd(given);
    if (!cwd || cwd === s.cwd) return;
    s.cwd = cwd;
    try { s.cwdNorm = contract.normPath(cwd); } catch { s.cwdNorm = contract.lexical(cwd); }
    if (root && typeof root.root === 'string') s.root = root;
    else { try { s.root = rootInfo(cwd) || s.root; } catch { /* no root: resolve refuses its files */ } }
  }
  function evictOne() {
    let victim = null;
    for (const s of sessions.values()) if (!s.owners.length && (!victim || s.lastAt < victim.lastAt)) victim = s;
    if (!victim) for (const s of sessions.values()) if (!victim || s.lastAt < victim.lastAt) victim = s;
    if (victim) forgetSession(victim, 'ended');
  }
  function makeSession(agent, session, key, t) {
    while (sessions.size >= MAX_SESSIONS) evictOne();
    const s = {
      key, agent, session, cwd: null, cwdNorm: null, root: null, pid: null, status: undefined, waitingFor: undefined,
      procStart: undefined, transcript: null, configDir: null, best: null, hookSeen: false, lastAt: t, owners: [],
      in: new Set(), dupes: new Set(), ended: false, cancelDrop: null, misses: 0
    };
    sessions.set(key, s);
    markWorkspaces();
    return s;
  }
  function better(s, source) { if (RANK[source] && (!s.best || RANK[source] > RANK[s.best])) s.best = source; }
  function seenBefore(s, e) {
    const k = boundedKey(e);
    if (s.dupes.has(k)) return true;
    s.dupes.add(k);
    if (s.dupes.size > MAX_DUPES) s.dupes.delete(s.dupes.values().next().value);
    return false;
  }

  /* ---------- the models ---------- */

  const scopeWindows = scope => [...windows.values()].filter(w => w.ready && w.scope === scope);
  function sendRecords(scope, record) {
    for (const w of scopeWindows(scope)) send(w.id, { type: 'records', scope, records: [record] });
  }
  /** Apply one event to the given scopes' models. Only an event every model refuses consumes no seq. */
  function deliver(s, e, scopes) {
    try { Model.validate(e); } catch { counts.rejected++; return false; }
    e.seq = seq + 1;
    const applied = [];
    for (const scope of scopes) {
      const model = models.get(scope);
      if (!model) continue;
      try { model.apply(e); applied.push(scope); s.in.add(scope); } catch (error) { log('warn', 'a model refused ' + e.ev + ': ' + className(error)); }
    }
    if (!applied.length) { delete e.seq; counts.rejected++; return false; }
    if (applied.length < scopes.length) counts.rejected++;
    seq = e.seq; counts.applied++;
    for (const scope of applied) sendRecords(scope, e);
    if (COUNTING.test(e.ev)) markWorkspaces();
    return true;
  }
  function envelope(s, t, ev, src, extra) {
    return Object.assign({ v: VERSION, t, agent: s.agent, session: s.session, ws: (s.root && s.root.ws) || '', ev, grade: 'derived', src }, extra);
  }
  const rootField = s => (s.root && s.root.name ? { root: { name: s.root.name } } : {});
  /** The name of the workspace a session works in, as its tile is labelled: its owners' names, sorted. Never a key or a path. */
  function spaceOf(s) {
    const names = s.owners.map(k => workspaces.get(k)).filter(Boolean).map(ws => ws.name).sort();
    return contract.cleanText(names.join(', '), TITLE_MAX);
  }
  /** What a session.start carries: its root's name, its workspace's name, and, when the CLI has named it, its tab's title. */
  const startFields = s => Object.assign(rootField(s), typeof s.title === 'string' ? { title: s.title } : {}, s.owners.length ? { space: spaceOf(s) } : {});
  /** The status a session-file session had, as events, so a workspace that opens later shows it as it is. */
  function statusEvents(s, t, src, from, to) {
    const out = [];
    if (from === 'waiting' && to !== 'waiting') out.push(envelope(s, t, 'wait.end', src, {}));
    if (to === 'busy') out.push(envelope(s, t, 'turn.start', src, {}));
    else if (to === 'idle' && from !== undefined) out.push(envelope(s, t, 'turn.end', src, { outcome: 'done', asks: false }));
    else if (to === 'waiting') out.push(envelope(s, t, 'wait.start', src, { why: /permission/i.test(s.waitingFor || '') ? 'permission' : 'question' }));
    return out;
  }
  /** Put a live session into each owner's model and into `all`, wherever it is not yet. */
  function putInto(s, t, src) {
    if (!s.owners.length || s.ended) return [];
    const missing = [ALL, ...s.owners].filter(scope => !s.in.has(scope));
    if (!missing.length) return [];
    // A session in no model yet: the start tells every model its space. Otherwise the models it is
    // already in learn a new space from refreshWorkspaces' session.info.
    if (!s.in.size) s.space = spaceOf(s);
    deliver(s, envelope(s, t, 'session.start', src, startFields(s)), missing);
    if (!s.hookSeen) for (const e of statusEvents(s, t, src, undefined, s.status)) deliver(s, e, missing);
    return missing;
  }
  function dropFrom(s, scope, why) {
    const model = models.get(scope);
    s.in.delete(scope);
    if (!model) return;
    model.drop(s.key);
    sendRecords(scope, { ctl: 'drop', key: s.key, why, seq });
  }
  function forgetSession(s, why) {
    if (s.cancelDrop) { s.cancelDrop(); s.cancelDrop = null; }
    for (const scope of [...s.in]) dropFrom(s, scope, why);
    sessions.delete(s.key);
    try { normaliser.forget(s.key); } catch { /* the normaliser keeps a bounded memory anyway */ }
    markWorkspaces();
  }
  function endSession(s, t) {
    s.ended = true; s.endedAt = t;
    if (s.cancelDrop) s.cancelDrop();
    s.cancelDrop = schedule(() => { s.cancelDrop = null; if (sessions.get(s.key) === s) forgetSession(s, 'ended'); }, lingerMs);
    markWorkspaces();
  }
  /** One event of a known session, from any source. */
  function onEvent(s, e, t) {
    s.lastAt = t;
    // It speaks again: the drop is called off. A new name is not speaking.
    if (s.ended && e.ev !== 'session.end' && e.ev !== 'session.info') {
      s.ended = false;
      if (s.cancelDrop) { s.cancelDrop(); s.cancelDrop = null; }
      markWorkspaces();
    }
    if (s.owners.length) {
      if (e.ev !== 'session.start' && e.ev !== 'session.end') putInto(s, t, 'hub:known');
      // Every start the hub delivers names the workspace, the normaliser's too.
      if (e.ev === 'session.start') { s.space = spaceOf(s); e.space = s.space; }
      deliver(s, e, [ALL, ...s.owners]);
    } else {
      try { Model.validate(e); } catch { counts.rejected++; return; }
    }
    if (e.ev === 'session.end' && !s.ended) endSession(s, t);
  }
  const hubEvent = (s, t, ev, src, extra) => onEvent(s, envelope(s, t, ev, src, extra), t);

  /* ---------- ingest ---------- */

  core.ingest = function ingest(payload, opts = {}) {
    const t = Number.isFinite(opts.t) ? opts.t : now();
    counts.received++;
    let out;
    try { out = normaliser.feed(payload, { t, hint: opts.hint, route: opts.route, source: opts.source }); } catch (error) { counts.rejected++; log('warn', 'the normaliser failed: ' + className(error)); return; }
    if (!out || typeof out !== 'object' || typeof out.key !== 'string' || !out.agent || typeof out.session !== 'string' || !out.session) { counts.rejected++; return; }
    // The session id becomes part of every node id and key: one that could hold a ':' could pose as another.
    if (!Model.AGENT_KINDS.includes(out.agent) || !contract.isSessionId(out.session) || out.key !== out.agent + ':' + out.session ||
        (out.source !== 'hook' && out.source !== 'transcript')) { counts.rejected++; return; }
    let s = sessions.get(out.key);
    // A replayed payload is a transcript payload like any other: the same duplicates, the same "hook wins".
    if (s && out.source === 'transcript' && s.hookSeen) { counts.ignored++; return; }
    if (payload && typeof payload === 'object' && payload._wy && typeof payload._wy === 'object' && payload._wy.replay === true) counts.replayed++;
    if (out.source === 'hook') lastHookAt = t;
    if (!s) s = makeSession(out.agent, out.session, out.key, t);
    setCwd(s, out.cwd, out.root);
    if (out.source === 'hook' && !s.hookSeen) { s.hookSeen = true; markWorkspaces(); }
    better(s, out.source);
    if (!s.owners.length && s.cwdNorm) { const owners = ownersOf(s); if (owners.length) { s.owners = owners; markWorkspaces(); } }
    for (const e of Array.isArray(out.events) ? out.events : []) {
      if (!e || typeof e !== 'object' || e.agent + ':' + e.session !== s.key) { counts.rejected++; continue; }
      try { Model.validate(e); } catch { counts.rejected++; continue; }
      if (seenBefore(s, e)) { counts.duplicates++; continue; }
      onEvent(s, e, t);
      if (!sessions.has(s.key)) break;
    }
  };
  /** A body the server could not take: too large, or not JSON. Nothing of it is kept. */
  core.countBody = function countBody(kind) {
    counts.received++;
    if (kind === 'tooLarge') counts.tooLarge++; else counts.rejected++;
  };

  /* ---------- the CLI's own list of live sessions ---------- */

  core.setLiveSessions = function setLiveSessions(list, time) {
    if (!Array.isArray(list)) return;
    const t = Number.isFinite(time) ? time : now();
    const named = new Set();
    for (const item of list) {
      if (!item || typeof item !== 'object' || !contract.isSessionId(item.session)) continue;
      const agent = typeof item.agent === 'string' ? item.agent : 'claude';
      if (!Model.AGENT_KINDS.includes(agent)) continue;
      const key = agent + ':' + item.session;
      named.add(key);
      const status = STATUSES.has(item.status) ? item.status : undefined;   // a new file has no status yet
      // The title of the session's tab: text from the session, kept only for its two events and the snapshot.
      const title = typeof item.title === 'string' && item.title.length <= TITLE_MAX ? item.title : undefined;
      let s = sessions.get(key);
      const fresh = !s;
      if (fresh) s = makeSession(agent, item.session, key, t);
      setCwd(s, item.cwd, item.root);
      if (Number.isInteger(item.pid) && item.pid > 0) s.pid = item.pid;
      if (typeof item.procStart === 'string' && /^\d{1,40}$/.test(item.procStart)) s.procStart = item.procStart;
      if (keptCwd(item.transcript)) s.transcript = item.transcript;
      if (keptCwd(item.configDir)) s.configDir = item.configDir;
      s.misses = 0;
      better(s, 'sessions-file');
      const before = s.status;
      s.waitingFor = typeof item.waitingFor === 'string' ? item.waitingFor.slice(0, 200) : undefined;
      if (fresh) {
        s.status = status; s.title = title;
        s.owners = ownersOf(s);
        if (s.owners.length) {
          hubEvent(s, t, 'session.start', 'sessions-file', startFields(s));
          for (const e of statusEvents(s, t, 'sessions-file', undefined, status)) onEvent(s, e, t);
        }
        continue;
      }
      // A new title, whatever source reports the session: one event. A title that goes away is "".
      if (title !== s.title) {
        s.title = title;
        hubEvent(s, t, 'session.info', 'sessions-file', { title: title === undefined ? '' : title });
      }
      if (status === undefined) continue;
      s.status = status;
      if (s.hookSeen || s.ended || status === before) continue;      // a collector's word is better than the file's
      for (const e of statusEvents(s, t, 'sessions-file', before, status)) onEvent(s, e, t);
    }
    for (const s of [...sessions.values()]) {
      if (s.pid == null || s.ended || named.has(s.key)) continue;
      if (++s.misses < goneAfter) continue;
      hubEvent(s, t, 'session.end', 'hub:gone', { reason: 'gone' });
    }
  };
  /** The 30-minute silence rule, for sessions no process id watches. Run from the discovery timer. */
  core.sweep = function sweep(time) {
    const t = Number.isFinite(time) ? time : now();
    for (const s of [...sessions.values()]) {
      if (s.ended || s.pid != null || t - s.lastAt < silentMs) continue;
      hubEvent(s, t, 'session.end', 'hub:silent', { reason: 'silent' });
    }
  };

  /* ---------- windows and workspaces ---------- */

  function cleanFolders(folders) {
    const out = [];
    for (const f of Array.isArray(folders) ? folders.slice(0, MAX_FOLDERS) : []) {
      const p = f && typeof f === 'object' ? f.path : f;
      if (!keptCwd(p)) continue;
      let norm;
      try { norm = contract.normPath(p); } catch { norm = contract.lexical(p); }
      // The top of a file system has no base name; the path itself is not a name to show.
      const base = contract.isFsRoot(p) ? '' : contract.flavour(p).basename(contract.lexical(p));
      const name = contract.cleanName((f && typeof f.name === 'string' && f.name) || base) || '(root)';
      out.push({ key: contract.wsKey(p), norm, name });
    }
    return out;
  }
  /** A scope as asked, resolved to what is open: `all`; a workspace key; a folder key (what a 0.1.0
      host and a saved choice send) held by some workspace (this window's own, else the one with the
      fewest folders, else the smallest key); anything else is `all`. */
  function scopeOf(scope, w) {
    if (scope === null || scope === undefined) return null;
    if (scope === ALL || workspaces.has(scope)) return scope;
    const holders = [...workspaces.values()].filter(ws => ws.folders.some(f => f.key === scope));
    if (!holders.length) return ALL;
    if (w && w.own && holders.some(ws => ws.key === w.own)) return w.own;
    holders.sort((a, b) => a.folders.length - b.folders.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return holders[0].key;
  }
  function sendSnapshot(w) {
    if (!models.get(w.scope)) return;
    // The server brings new transcript tails up to date here, so their recent calls are part of
    // the snapshot and do not follow it as live records. The window takes no records meanwhile.
    w.ready = false;
    try { core.onBeforeSnapshot(w.scope); } catch (error) { log('warn', 'onBeforeSnapshot failed: ' + className(error)); }
    const model = models.get(w.scope);
    if (!model) return;
    w.ready = true;
    send(w.id, { type: 'records', scope: w.scope, records: [{ ctl: 'snapshot', epoch, seq, scope: w.scope, state: model.serialize() }] });
  }
  /** The steps of 7.1 "when the workspaces change". */
  function refreshWorkspaces(t) {
    // One workspace for each set of folders a window has open; windows with the same set share it.
    // Windows are visited in attach order, so the name is the first window's.
    const next = new Map(), folderOwners = new Map(), ownBefore = new Map();
    for (const w of windows.values()) {
      ownBefore.set(w.id, w.own);
      w.own = contract.windowKeyOf(w.folders.map(f => f.key));
      if (!w.own) continue;
      let ws = next.get(w.own);
      if (!ws) {
        const folders = [];
        for (const f of w.folders) if (!folders.some(x => x.key === f.key)) folders.push(f);
        ws = { key: w.own, name: contract.windowName(w.name) || folders[0].name || '(root)', folders, windows: new Set(), apps: new Set() };
        next.set(w.own, ws);
        for (const f of folders) {
          const list = folderOwners.get(f.norm) || [];
          list.push(ws.key);
          folderOwners.set(f.norm, list);
        }
      }
      ws.windows.add(w.id);
      if (w.app) ws.apps.add(w.app);
    }
    for (const list of folderOwners.values()) list.sort();
    const before = workspaces;
    workspaces = next; byFolder = folderOwners;
    for (const key of next.keys()) if (!before.has(key)) models.set(key, Model.create());
    const startedNow = new Map();     // session key -> the models that just got its start, with its space on it
    for (const s of sessions.values()) {
      const owners = ownersOf(s);
      if (sameKeys(owners, s.owners)) continue;
      s.owners = owners;
      // A workspace it was in and no longer belongs to (it closed, or a deeper folder took the session) stops showing it.
      for (const scope of [...s.in]) {
        if (scope === ALL || owners.includes(scope)) continue;
        if (next.has(scope)) dropFrom(s, scope, 'workspace-closed'); else s.in.delete(scope);
      }
      if (!owners.length) { if (s.in.has(ALL)) dropFrom(s, ALL, 'workspace-closed'); }
      else startedNow.set(s.key, putInto(s, t, 'hub:known'));
    }
    for (const key of before.keys()) {
      if (next.has(key)) continue;
      models.delete(key);
      for (const s of sessions.values()) s.in.delete(key);
    }
    // Its owners changed, or one was renamed (its first window left): the models it stays in learn its new space.
    for (const s of sessions.values()) {
      if (!s.owners.length || !s.in.size) continue;
      const space = spaceOf(s);
      if (space === s.space || !space) continue;
      s.space = space;
      const fresh = startedNow.get(s.key) || [];
      const told = [...s.in].filter(scope => !fresh.includes(scope));
      if (told.length) deliver(s, envelope(s, t, 'session.info', 'hub:known', { space }), told);
    }
    // A window that showed its own workspace follows it to its new key (it opened or closed a
    // folder); a window whose scope is gone otherwise goes to `all`. Either gets a snapshot.
    for (const w of windows.values()) {
      if (!w.scope || w.scope === ALL) continue;
      const prev = ownBefore.get(w.id);
      let scope = w.scope;
      if (prev && scope === prev && w.own && w.own !== prev) scope = w.own;
      else if (!workspaces.has(scope)) scope = ALL;
      if (scope !== w.scope) { w.scope = scope; if (w.ready) sendSnapshot(w); }
    }
    markWorkspaces();
  }

  /** Whether a session waits for its owner, read from an owner's model first: `all` can overflow at 12 columns. */
  function needsOwner(s) {
    for (const scope of [...s.owners, ALL]) {
      const model = models.get(scope);
      const node = model && model.nodes.get('a:' + s.key);
      if (node) return node.status === 'needs';
    }
    return false;
  }
  function workspaceList() {
    const list = [];
    let hidden = 0, total = 0, totalNeeds = 0;
    const per = new Map();
    for (const s of sessions.values()) {
      if (s.ended) continue;
      if (!s.owners.length) { hidden++; continue; }
      const needs = needsOwner(s);
      total++; if (needs) totalNeeds++;
      for (const owner of s.owners) {
        const c = per.get(owner) || { sessions: 0, needs: 0 };
        c.sessions++; if (needs) c.needs++;
        per.set(owner, c);
      }
    }
    for (const ws of workspaces.values()) {
      const c = per.get(ws.key) || { sessions: 0, needs: 0 };
      list.push({ key: ws.key, name: ws.name, apps: [...ws.apps].sort(), windows: ws.windows.size, sessions: c.sessions, needs: c.needs,
        folders: ws.folders.slice(0, 16).map(f => f.name) });
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { list, hidden, total, totalNeeds };
  }
  function sendWorkspaces(w, built) {
    // `watching` false: no window shows a scope, the hub has not looked, and the counts are not known.
    const message = { type: 'workspaces', list: built.list, hidden: built.hidden, scope: w.scope,
      total: built.total, totalNeeds: built.totalNeeds, watching: core.needsDiscovery(), own: w.own || '' };
    const text = JSON.stringify(message);
    if (text === w.lastWorkspaces) return false;
    w.lastWorkspaces = text;
    send(w.id, message);
    return true;
  }
  /** Send each window its `workspaces` message when it differs from the last one it got. */
  core.flushWorkspaces = function flushWorkspaces() {
    wsPending = false;
    const built = workspaceList();
    let sent = 0;
    for (const w of windows.values()) if (sendWorkspaces(w, built)) sent++;
    return sent;
  };
  core.workspacesPending = () => wsPending;

  core.attach = function attach(win = {}) {
    if (!win || typeof win !== 'object') return null;
    const t = now();
    const id = contract.safeId(win.id) || 'w' + (++windowSeq);
    const had = windows.get(id);
    if (!had && windows.size >= LIMITS.windows) return null;
    // The raw name: windowName strips a 0.1.0 host's " (Workspace)" before anything cuts it short.
    const w = {
      id, app: contract.cleanName(win.app || ''), name: typeof win.name === 'string' ? win.name.slice(0, 1000) : '',
      pid: Number.isInteger(win.pid) ? win.pid : null, folders: cleanFolders(win.folders), scope: null, ready: false, lastWorkspaces: null, own: ''
    };
    windows.set(id, w);                               // Map.set on a known id keeps its place in attach order
    refreshWorkspaces(t);
    w.scope = scopeOf(win.scope, w);
    sendWorkspaces(w, workspaceList());               // at once: the page needs its chips before anything
    if (w.scope) sendSnapshot(w);
    return id;
  };
  core.update = function update(id, change = {}) {
    const w = windows.get(contract.safeId(id));
    if (!w || !change || typeof change !== 'object') return false;
    if (change.folders !== undefined) { w.folders = cleanFolders(change.folders); refreshWorkspaces(now()); }
    let snapshotSent = false;
    if (change.scope !== undefined) {
      const scope = scopeOf(change.scope, w);
      if (scope !== w.scope) {
        w.scope = scope; w.ready = false;
        if (scope) { sendSnapshot(w); snapshotSent = true; }
        markWorkspaces();
      }
    }
    if (change.snapshot === true && w.scope && !snapshotSent) sendSnapshot(w);
    return true;
  };
  core.detach = function detach(id) {
    if (!windows.delete(contract.safeId(id))) return false;
    refreshWorkspaces(now());
    return true;
  };
  core.needsDiscovery = () => { for (const w of windows.values()) if (w.scope) return true; return false; };
  core.tailTargets = function tailTargets() {
    if (!core.needsDiscovery()) return [];
    return [...sessions.values()]
      .filter(s => !s.hookSeen && !s.ended && s.owners.length && typeof s.transcript === 'string' && s.cwd)
      .sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_TAILS)
      .map(s => ({ key: s.key, session: s.session, cwd: s.cwd, transcript: s.transcript }));
  };

  /* ---------- resolve and status (7.4) ---------- */

  function nodeOf(s, id) {
    for (const scope of [ALL, ...s.owners]) {
      const model = models.get(scope);
      const node = model && model.nodes.get(id);
      if (node) return node;
    }
    return null;
  }
  core.resolve = function resolve(target) {
    const none = { kind: 'none' };
    if (!target || typeof target !== 'object' || typeof target.id !== 'string') return none;
    const id = target.id, member = typeof target.member === 'string' ? target.member : undefined;
    if (id.length > 2000) return none;
    // Exactly one session, read from the id itself: never the longest held key that the id starts with.
    const parsed = parseNodeId(id);
    const s = parsed && sessions.get(parsed.key);
    if (!s) return none;
    if (parsed.cls === 'a') {
      if (parsed.rest !== undefined) return none;
      return { kind: 'session', agent: s.agent, session: s.session, cwd: s.cwd, root: s.root ? s.root.root : null, pid: s.pid };
    }
    if (parsed.cls !== 'r' || parsed.rest === undefined) return none;
    const rest = parsed.rest;
    const node = nodeOf(s, id);
    if (!node || node.cls !== 'resource') return none;
    const names = [...(node.members instanceof Map ? node.members.keys() : [])];
    if (member !== undefined && !names.includes(member)) return none;
    const chosen = member !== undefined ? [member] : names;
    if (rest.startsWith('url:')) {
      const host = rest.slice(4);
      if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return none;
      const urls = [];
      for (const m of chosen) {
        if (typeof m !== 'string' || m.charAt(0) !== '/') continue;
        try { const u = new URL('https://' + host + m); if (u.host === host.toLowerCase()) urls.push(u.href); } catch { /* not an address */ }
      }
      return urls.length ? { kind: 'url', urls } : none;
    }
    if (!rest.startsWith('file:')) return none;
    const group = rest.slice(5);
    if (group.charAt(0) === '(') return { kind: 'outside' };
    if (!s.root || typeof s.root.root !== 'string') return none;
    const root = s.root.root, f = contract.flavour(root);
    const folder = contract.lexical(f.join(root, ...group.split('/').filter(Boolean)));
    if (!contract.isInside(root, folder)) return { kind: 'outside' };
    if (!names.length) return member !== undefined ? none : { kind: 'dir', path: folder };
    const members = [];
    for (const m of chosen) {
      if (!m || /[\\/]/.test(m)) continue;
      const p = contract.lexical(f.join(folder, m));
      const rel = contract.relativeIn(folder, p);
      if (rel === null || rel === '.' || !contract.isInside(root, p)) continue;
      members.push({ name: m, path: p });
    }
    if (!members.length) return none;
    return { kind: 'file', root, folder, members };
  };
  /** Candidate hosts for the existing actions on nodes in active workspaces. */
  core.actionWindows = function actionWindows(origin, action, target) {
    if (!windows.has(origin)) return [];
    const parsed = target && typeof target.id === 'string' && parseNodeId(target.id);
    const session = parsed && sessions.get(parsed.key);
    if (!session || !session.owners.length) return [];
    const found = core.resolve(target);
    const peers = [...windows.values()].filter(w => w.id !== origin);
    // A terminal may belong to a host whose workspace differs from the session's current folder.
    if (action === 'focus') return found.kind === 'session' && !session.ended ? peers.map(w => w.id) : [];
    if (action !== 'open') return [];
    const file = found.kind === 'dir' ? found.path :
      found.kind === 'file' && typeof target.member === 'string' && found.members.length === 1 ? found.members[0].path : '';
    if (!file) return [];
    const depth = window => window.folders.reduce((best, folder) =>
      contract.isInside(folder.norm, file) ? Math.max(best, folder.norm.length) : best, 0);
    return peers.map(w => ({ id: w.id, depth: depth(w) })).filter(w => w.depth).sort((a, b) => b.depth - a.depth).map(w => w.id);
  };
  /** The server fills in what only it knows: whether it runs in a worker, its tails, the sources it lacks. */
  core.setInfo = function setInfo(more) { if (more && typeof more === 'object') Object.assign(info, more); };
  core.status = function status() {
    let shown = 0, hidden = 0;
    const sources = { hook: 0, transcript: 0, sessionsFile: 0 };
    for (const s of sessions.values()) {
      if (!s.ended) { if (s.owners.length) shown++; else hidden++; }
      if (s.best === 'hook') sources.hook++; else if (s.best === 'transcript') sources.transcript++; else if (s.best === 'sessions-file') sources.sessionsFile++;
    }
    return {
      epoch, upMs: now() - started, role: info.role, windows: windows.size, workspaces: workspaces.size,
      sessions: { known: sessions.size, shown, hidden }, events: Object.assign({}, counts), sources,
      tails: info.tails, lastHookAt, off: info.off.slice(), seq
    };
  };

  /* For tests and the server: read-only views. */
  core.models = models;
  core.session = key => sessions.get(key);
  return core;
}

module.exports = { createHubCore, dupeKey, MAX_SESSIONS, MAX_DUPES, MAX_TAILS };
