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
  const windows = new Map();        // id -> window
  let workspaces = new Map();       // key -> {key, name, norm, windows: Set, apps: Set}
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

  function ownerOf(s) {
    if (!s.cwdNorm) return null;
    let best = null, length = -1;
    for (const ws of workspaces.values()) {
      if (ws.norm.length > length && contract.isInside(ws.norm, s.cwdNorm)) { best = ws.key; length = ws.norm.length; }
    }
    return best;
  }
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
    for (const s of sessions.values()) if (!s.owner && (!victim || s.lastAt < victim.lastAt)) victim = s;
    if (!victim) for (const s of sessions.values()) if (!victim || s.lastAt < victim.lastAt) victim = s;
    if (victim) forgetSession(victim, 'ended');
  }
  function makeSession(agent, session, key, t) {
    while (sessions.size >= MAX_SESSIONS) evictOne();
    const s = {
      key, agent, session, cwd: null, cwdNorm: null, root: null, pid: null, status: undefined, waitingFor: undefined,
      procStart: undefined, transcript: null, configDir: null, best: null, hookSeen: false, lastAt: t, owner: null,
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
  /** The status a session-file session had, as events, so a workspace that opens later shows it as it is. */
  function statusEvents(s, t, src, from, to) {
    const out = [];
    if (from === 'waiting' && to !== 'waiting') out.push(envelope(s, t, 'wait.end', src, {}));
    if (to === 'busy') out.push(envelope(s, t, 'turn.start', src, {}));
    else if (to === 'idle' && from !== undefined) out.push(envelope(s, t, 'turn.end', src, { outcome: 'done', asks: false }));
    else if (to === 'waiting') out.push(envelope(s, t, 'wait.start', src, { why: /permission/i.test(s.waitingFor || '') ? 'permission' : 'question' }));
    return out;
  }
  /** Put a live session into its owner's model and into `all`, wherever it is not yet. */
  function putInto(s, t, src) {
    if (!s.owner || s.ended) return;
    const missing = [ALL, s.owner].filter(scope => !s.in.has(scope));
    if (!missing.length) return;
    deliver(s, envelope(s, t, 'session.start', src, rootField(s)), missing);
    if (!s.hookSeen) for (const e of statusEvents(s, t, src, undefined, s.status)) deliver(s, e, missing);
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
    if (s.ended && e.ev !== 'session.end') {          // it speaks again: the drop is called off
      s.ended = false;
      if (s.cancelDrop) { s.cancelDrop(); s.cancelDrop = null; }
      markWorkspaces();
    }
    if (s.owner) {
      if (e.ev !== 'session.start' && e.ev !== 'session.end') putInto(s, t, 'hub:known');
      deliver(s, e, [ALL, s.owner]);
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
    try { out = normaliser.feed(payload, { t, hint: opts.hint }); } catch (error) { counts.rejected++; log('warn', 'the normaliser failed: ' + className(error)); return; }
    if (!out || typeof out !== 'object' || typeof out.key !== 'string' || !out.agent || typeof out.session !== 'string' || !out.session) { counts.rejected++; return; }
    // The session id becomes part of every node id and key: one that could hold a ':' could pose as another.
    if (!Model.AGENT_KINDS.includes(out.agent) || !contract.isSessionId(out.session) || out.key !== out.agent + ':' + out.session) { counts.rejected++; return; }
    let s = sessions.get(out.key);
    // A replayed payload is a transcript payload like any other: the same duplicates, the same "hook wins".
    if (s && out.source === 'transcript' && s.hookSeen) { counts.ignored++; return; }
    if (payload && typeof payload === 'object' && payload._wy && typeof payload._wy === 'object' && payload._wy.replay === true) counts.replayed++;
    if (out.source === 'hook') lastHookAt = t;
    if (!s) s = makeSession(out.agent, out.session, out.key, t);
    setCwd(s, out.cwd, out.root);
    if (out.source === 'hook' && !s.hookSeen) { s.hookSeen = true; markWorkspaces(); }
    better(s, out.source);
    if (s.owner === null && s.cwdNorm) { const owner = ownerOf(s); if (owner) { s.owner = owner; markWorkspaces(); } }
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
        s.status = status;
        s.owner = ownerOf(s);
        if (s.owner) {
          hubEvent(s, t, 'session.start', 'sessions-file', rootField(s));
          for (const e of statusEvents(s, t, 'sessions-file', undefined, status)) onEvent(s, e, t);
        }
        continue;
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
  const scopeOf = scope => (scope === null || scope === undefined ? null : scope === ALL || workspaces.has(scope) ? scope : ALL);
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
    const next = new Map();
    for (const w of windows.values()) {
      for (const f of w.folders) {
        let ws = next.get(f.key);
        if (!ws) { ws = { key: f.key, name: f.name, norm: f.norm, windows: new Set(), apps: new Set() }; next.set(f.key, ws); }
        ws.windows.add(w.id);
        if (w.app) ws.apps.add(w.app);
      }
    }
    const before = workspaces;
    workspaces = next;
    for (const key of next.keys()) if (!before.has(key)) models.set(key, Model.create());
    for (const s of sessions.values()) {
      const owner = ownerOf(s);
      if (owner === s.owner) continue;
      const old = s.owner;
      s.owner = owner;
      // The old workspace may still be open (a deeper folder took the session): it no longer shows it.
      if (old && s.in.has(old)) dropFrom(s, old, 'workspace-closed');
      if (!owner) { if (s.in.has(ALL)) dropFrom(s, ALL, 'workspace-closed'); }
      else putInto(s, t, 'hub:known');
    }
    for (const key of before.keys()) {
      if (next.has(key)) continue;
      models.delete(key);
      for (const s of sessions.values()) s.in.delete(key);
    }
    for (const w of windows.values()) {
      if (w.scope && w.scope !== ALL && !workspaces.has(w.scope)) { w.scope = ALL; if (w.ready) sendSnapshot(w); }
    }
    markWorkspaces();
  }

  function workspaceList() {
    const list = [];
    let hidden = 0;
    const per = new Map();
    for (const s of sessions.values()) {
      if (s.ended) continue;
      if (!s.owner) { hidden++; continue; }
      const c = per.get(s.owner) || { sessions: 0, needs: 0 };
      c.sessions++;
      const node = (models.get(s.owner) || models.get(ALL)).nodes.get('a:' + s.key);
      if (node && node.status === 'needs') c.needs++;
      per.set(s.owner, c);
    }
    for (const ws of workspaces.values()) {
      const c = per.get(ws.key) || { sessions: 0, needs: 0 };
      list.push({ key: ws.key, name: ws.name, apps: [...ws.apps].sort(), windows: ws.windows.size, sessions: c.sessions, needs: c.needs });
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { list, hidden };
  }
  function sendWorkspaces(w, built) {
    const message = { type: 'workspaces', list: built.list, hidden: built.hidden, scope: w.scope };
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
    const w = {
      id, app: contract.cleanName(win.app || ''), name: contract.cleanName(win.name || ''),
      pid: Number.isInteger(win.pid) ? win.pid : null, folders: cleanFolders(win.folders), scope: null, ready: false, lastWorkspaces: null
    };
    windows.set(id, w);
    refreshWorkspaces(t);
    w.scope = scopeOf(win.scope);
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
      const scope = scopeOf(change.scope);
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
      .filter(s => !s.hookSeen && !s.ended && s.owner && typeof s.transcript === 'string' && s.cwd)
      .sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_TAILS)
      .map(s => ({ key: s.key, session: s.session, cwd: s.cwd, transcript: s.transcript }));
  };

  /* ---------- resolve and status (7.4) ---------- */

  function nodeOf(s, id) {
    for (const scope of [ALL, s.owner]) {
      const model = scope && models.get(scope);
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
  /** The server fills in what only it knows: whether it runs in a worker, its tails, the sources it lacks. */
  core.setInfo = function setInfo(more) { if (more && typeof more === 'object') Object.assign(info, more); };
  core.status = function status() {
    let shown = 0, hidden = 0;
    const sources = { hook: 0, transcript: 0, sessionsFile: 0 };
    for (const s of sessions.values()) {
      if (!s.ended) { if (s.owner) shown++; else hidden++; }
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
