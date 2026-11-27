/* Wyarden 3D monitor, working mock-up: from a Claude Code hook payload to the monitor's events.
 *
 * A hook payload holds everything the session did: command lines, file contents, prompts, replies,
 * absolute paths. This file is the one place that reads it, so the privacy rule of
 * docs/monitor-3d/02-live-signals.md section 13 has one implementation. Every event is built here
 * from a fixed list of fields; nothing from a payload is spread or copied whole, and text is kept
 * only through the helpers of contract.js.
 *
 * It also derives what the agent does not say outright: how long a call took when no duration came,
 * which Agent call a subagent belongs to, and when a wait for the owner ended. For that it remembers
 * a little about each session, bounded, and forgets the least recent session first.
 *
 * The contract is docs/monitor-3d/05-working-mockup.md section 5. A payload of any shape must never
 * make it throw: the hub feeds it whatever arrives on the port.
 */
'use strict';
const crypto = require('node:crypto');
const contract = require('./contract.js');

/* The only ways a string from a payload reaches an event: safeId (ids), safeName (names),
   keptPath (paths), cleanUrl (addresses), the scheme pattern below, and comparison with the fixed
   words of this file (event names, classes, notification types). A value cut to 80 characters is
   not safe by itself: a path or a command line fits in 80 characters. */
const { cleanUrl, keptPath, inputHash, isAbsolute, isSessionId, safeId, safeName } = contract;

const MAX_SESSIONS = 200;
const MAX_CALLS = 200;          // calls (and subagents) remembered for one session
/* Longer than any real path or address: such a value is junk, and it is not worth parsing. */
const BIG = 1 << 20;
/* Keys only other agents' payloads have. Grok also sends `hook_event_name`, so the snake_case name
   alone does not prove the payload is Claude Code's (02 section 5). */
const FOREIGN = ['hookEventName', 'sessionId', 'toolName', 'toolInput', 'toolUseId', 'conversationId', 'toolCall'];

const CLASS_OF = new Map([
  ['Read', 'read'],
  ['Write', 'edit'], ['Edit', 'edit'], ['MultiEdit', 'edit'], ['NotebookEdit', 'edit'],
  ['Grep', 'search'], ['Glob', 'search'],
  ['Bash', 'execute'], ['PowerShell', 'execute'],
  ['WebFetch', 'fetch'], ['WebSearch', 'fetch'],
  ['Agent', 'agent'], ['Task', 'agent'],
  ['AskUserQuestion', 'ask'],
  ['ReadMcpResourceTool', 'mcp'], ['ListMcpResourcesTool', 'mcp']
]);
/* The hook events this slice knows. `src` is built only from these words, never from the payload's text. */
const KNOWN = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification', 'SubagentStart', 'SubagentStop']);
const SCHEME = /^[a-z][a-z0-9+.-]{0,31}$/;
const NOTICE_WHY = new Map([
  ['permission_prompt', 'permission'], ['idle_prompt', 'idle'],
  ['elicitation_dialog', 'question'], ['agent_needs_input', 'question']
]);
/* The argument names that may name a resource in an MCP call (02 section 12). Nothing else of an
   MCP call's input is ever read. */
const MCP_TARGETS = ['path', 'file_path', 'url', 'uri'];

/* ---------- reading a payload safely ---------- */

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
/** An own field only: a payload's prototype is never consulted. */
const own = (o, k) => (isObj(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** A raw string, or '' for anything else. It is only compared or parsed, never put in an event as it is. */
const str = v => (typeof v === 'string' ? v : '');
/** A raw string that may be a path or an address, or '' when it is not one worth reading. */
const target = v => (typeof v === 'string' && v.length < BIG ? v : '');

/**
 * What a tool's name says: an MCP call (server and tool) or a plain tool with its class.
 * `mcp_server.name` is the server when present (exact): a server's own name may hold `__`
 * (`mcp__probe_srv__echo` was observed), so the tool is what follows `mcp__<name>__`.
 * Otherwise the name is split at the first `__` after the prefix (derived).
 * Every part is made safe on its own: a safe whole name does not make its parts safe.
 */
function describe(rawName, payload) {
  const full = safeName(rawName);
  if (!full) return null;
  if (rawName.startsWith('mcp__')) {
    const box = own(payload, 'mcp_server');
    const given = str(own(box, 'name')).trim(), source = safeName(own(box, 'source'));
    const rest = rawName.slice(5), cut = rest.indexOf('__');
    let server = '', tool = '', exact = false;
    if (given) {
      server = given; exact = true;
      tool = rest.startsWith(given + '__') ? rest.slice(given.length + 2) : cut > 0 ? rest.slice(cut + 2) : '';
    } else if (cut > 0) {
      server = rest.slice(0, cut); tool = rest.slice(cut + 2);
    }
    server = safeName(server); tool = safeName(tool);
    if (server && tool) return { mcp: true, full, server, tool, source, exact, cls: 'mcp' };
    return { mcp: false, full, tool: full, cls: 'mcp' };     // an MCP name that cannot be split
  }
  return { mcp: false, full, tool: full, cls: CLASS_OF.get(rawName) || 'other' };
}

/** The scheme of a URI, lower case, when it looks like a scheme; else ''. The rest of the URI is never kept. */
function schemeOf(uri) {
  const cut = uri.indexOf(':');
  if (cut < 1) return '';
  const scheme = uri.slice(0, cut).toLowerCase();
  return SCHEME.test(scheme) ? scheme : '';
}

function createNormaliser(options) {
  const rootInfo = (options && typeof options.rootInfo === 'function') ? options.rootInfo : contract.rootInfo;
  /* One random salt for the life of this normaliser: a hash still pairs a permission with its call
     and shows a repeated call, but a short input cannot be found again by hashing guesses.
     `options.salt` is for tests only, so they can state the hash they expect. */
  const salt = options && typeof options.salt === 'string' && options.salt ? options.salt : crypto.randomBytes(16).toString('hex');
  const hashOf = (tool, input) => inputHash(tool, input, salt);
  /* key -> { cwd, root, turn, calls: Map(call -> {t, at, info, hash, claimed, end}),
     subs: Map(subagent -> parentCall), wait: {why, call} | null }. Map order is recency. Nothing
     here depends on a SessionStart: http hooks never get one (probe findings), so any first event
     makes the record. */
  const sessions = new Map();

  function sessionFor(key) {
    let s = sessions.get(key);
    if (s) sessions.delete(key);
    else s = { cwd: null, root: null, turn: '', calls: new Map(), subs: new Map(), wait: null };
    sessions.set(key, s);
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    return s;
  }
  /* An ended call stays remembered until room is needed, so a repeated end (two hooks for one event
     were observed) gives the same `ms` as the first. Ended calls make room first: an Agent call can
     stay open while its subagent makes hundreds of others. */
  function remember(s, call, open) {
    s.calls.set(call, open);
    while (s.calls.size > MAX_CALLS) {
      let gone = null;
      for (const [id, c] of s.calls) if (c.end) { gone = id; break; }
      s.calls.delete(gone ?? s.calls.keys().next().value);
    }
  }
  function safeRoot(cwd) {
    try { const info = rootInfo(cwd); return isObj(info) && typeof info.root === 'string' ? info : null; } catch { return null; }
  }

  function feedUnsafe(payload, opts) {
    if (!isObj(payload)) return null;
    for (const k of FOREIGN) if (own(payload, k) !== undefined) return null;
    // A session id that is not made of id characters is not a session (a path, a command): refused whole.
    const event = str(own(payload, 'hook_event_name')), session = own(payload, 'session_id');
    if (!event || !isSessionId(session)) return null;

    const t = num(own(opts, 't')) ?? Date.now();
    const wy = own(payload, '_wy');
    const fromTranscript = isObj(wy) && own(wy, 'src') === 'transcript';
    const at = fromTranscript ? num(own(wy, 'at')) : undefined;
    const key = 'claude:' + session;
    const s = sessionFor(key);

    const cwdGiven = target(own(payload, 'cwd'));
    if (cwdGiven && isAbsolute(cwdGiven) && cwdGiven !== s.cwd) { s.cwd = cwdGiven; s.root = safeRoot(cwdGiven); }
    const ws = s.root && typeof s.root.ws === 'string' ? s.root.ws : '';

    // Only safe ids are remembered, so a turn carried to a later event is as safe as the first.
    const promptId = safeId(own(payload, 'prompt_id'));
    const turnBefore = s.turn;
    if (promptId) s.turn = promptId;
    else if (event === 'UserPromptSubmit') s.turn = '';         // a new turn whose id is not known
    const turn = s.turn;
    const by = safeId(own(payload, 'agent_id'));
    const grade = fromTranscript ? 'derived' : 'exact';
    const src = KNOWN.has(event) ? (fromTranscript ? 'transcript:' : 'hook:') + event : '';

    /* The envelope. `withBy` marks the events a subagent's call makes. */
    const base = (ev, g, from, withBy, turnId = turn) => {
      const e = { v: 1, t, agent: 'claude', session, ws, ev, grade: g, src: from };
      if (at !== undefined) e.at = at;
      if (turnId) e.turn = turnId;
      if (withBy && by) e.by = by;
      return e;
    };

    /* A wait ends at the next sign that the session moved on. A wait tied to one call (a question,
       or a permission matched to its call by the input's hash) ends only with that call, or with a
       new prompt: a parallel call's end says nothing about it. */
    const endWait = (call, withTurn) => {
      const w = s.wait;
      if (!w) return null;
      if (w.call && event !== 'UserPromptSubmit' && call !== w.call) return null;
      s.wait = null;
      let answer = 'unknown';
      if (event === 'PermissionDenied') answer = 'refused';
      else if (w.why === 'question' && (event === 'PostToolUse' || event === 'UserPromptSubmit')) answer = 'answered';
      else if (w.why === 'permission' && event === 'PostToolUse') answer = 'allowed';
      const e = base('wait.end', 'derived', src, false, withTurn);
      e.why = w.why; e.answer = answer;
      return e;
    };

    const events = [];
    const tool = own(payload, 'tool_name');

    switch (event) {
      case 'SessionStart': {
        const e = base('session.start', grade, src, false);
        const source = safeName(own(payload, 'source')); if (source) e.source = source;
        const model = own(payload, 'model');
        const modelName = safeName(typeof model === 'string' ? model : own(model, 'id'));
        if (modelName) e.model = modelName;
        // The root's base name is what the contract names a session after (02 section 13 keeps a base
        // name); rootInfo makes it, and the top of a file system is "(root)", never its path.
        if (s.root && typeof s.root.name === 'string' && s.root.name) e.root = { name: contract.cleanName(s.root.name) };
        events.push(e);
        break;
      }
      case 'SessionEnd': {
        const e = base('session.end', grade, src, false);
        const reason = safeName(own(payload, 'reason')); if (reason) e.reason = reason;
        events.push(e);
        sessions.delete(key);                    // a resumed session starts its memory again
        break;
      }
      case 'UserPromptSubmit': {
        const done = endWait('', turnBefore); if (done) events.push(done);
        const e = base('turn.start', grade, src, false);
        const prompt = own(payload, 'prompt');
        if (typeof prompt === 'string') e.chars = prompt.length;
        events.push(e);
        break;
      }
      case 'Stop':
      case 'StopFailure': {
        const e = base('turn.end', grade, src, false);
        e.outcome = event === 'Stop' ? 'done' : 'failed';
        const reply = own(payload, 'last_assistant_message');
        e.asks = typeof reply === 'string' && reply.trimEnd().endsWith('?');
        events.push(e);
        s.turn = '';
        break;
      }
      case 'PreToolUse': {
        const call = safeId(own(payload, 'tool_use_id'));
        const info = typeof tool === 'string' ? describe(tool, payload) : null;
        if (!call || !info) break;
        const input = own(payload, 'tool_input');
        const hash = hashOf(info.full, input);
        const g = info.mcp && !info.exact ? 'derived' : grade;
        const e = base(info.mcp ? 'mcp.start' : 'tool.start', g, src, true);
        e.call = call;
        if (info.mcp) { e.server = info.server; e.tool = info.tool; if (info.source) e.serverSource = info.source; }
        else { e.tool = info.tool; e.class = info.cls; }
        e.hash = hash;
        events.push(e);
        // A repeated start keeps the first one's time and claim.
        if (!s.calls.has(call)) remember(s, call, { t, at, info, hash, claimed: false, end: null });
        for (const touch of touches(info, isObj(input) ? input : {}, s)) {
          const r = base('resource.touch', 'derived', fromTranscript ? src : 'args:' + info.full, true);
          r.call = call; r.kind = touch.kind; r.op = touch.op;
          if (touch.path !== undefined) r.path = touch.path;
          if (touch.url !== undefined) r.url = touch.url;
          if (touch.server) r.server = touch.server;
          if (touch.scheme) r.scheme = touch.scheme;
          events.push(r);
        }
        if (!info.mcp && info.full === 'AskUserQuestion') {
          const w = base('wait.start', 'derived', src, false);
          w.why = 'question'; w.tool = info.full;
          events.push(w);
          s.wait = { why: 'question', call };
        }
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied': {
        // The same odd id gives the same stand-in, so an end still meets its start.
        const call = safeId(own(payload, 'tool_use_id'));
        const open = call ? s.calls.get(call) : undefined;
        const done = endWait(call); if (done) events.push(done);
        if (!call) break;
        let info = typeof tool === 'string' ? describe(tool, payload) : null;
        if (open && (!info || (open.info.mcp && !(info.mcp && info.exact)))) info = open.info;
        const g = info && info.mcp && !info.exact ? 'derived' : grade;
        const e = base(info && info.mcp ? 'mcp.end' : 'tool.end', g, src, true);
        e.call = call;
        if (info && info.mcp) { e.server = info.server; e.tool = info.tool; if (info.source) e.serverSource = info.source; }
        else if (info) e.tool = info.tool;
        e.ok = event === 'PostToolUse';
        const duration = num(own(payload, 'duration_ms'));
        if (duration !== undefined && duration >= 0) { e.ms = Math.round(duration); e.msGrade = 'exact'; }
        else if (open && open.end) { if (open.end.msGrade) { e.ms = open.end.ms; e.msGrade = open.end.msGrade; } }
        else if (open) {
          const ms = at !== undefined && open.at !== undefined ? at - open.at : t - open.t;
          if (ms >= 0) { e.ms = Math.round(ms); e.msGrade = 'derived'; }
        }
        if (open && !open.end) open.end = { ms: e.ms, msGrade: e.msGrade };
        if (event === 'PostToolUseFailure') {
          const interrupted = own(payload, 'is_interrupt') === true;
          e.error = interrupted ? 'interrupted' : 'tool_error'; e.interrupted = interrupted;
        } else if (event === 'PermissionDenied') { e.error = 'denied'; e.interrupted = false; }
        events.push(e);
        break;
      }
      case 'PermissionRequest': {
        const info = typeof tool === 'string' ? describe(tool, payload) : null;
        const e = base('wait.start', grade, src, false);
        e.why = 'permission';
        let tied = '';
        if (info) {
          e.tool = info.full;
          e.hash = hashOf(info.full, own(payload, 'tool_input'));
          // PermissionRequest carries no tool_use_id: its call is the latest open one with the same input.
          for (const [id, open] of s.calls) if (!open.end && open.hash === e.hash && open.info.full === info.full) tied = id;
        }
        events.push(e);
        s.wait = { why: 'permission', call: tied };
        break;
      }
      case 'Notification': {
        const why = NOTICE_WHY.get(str(own(payload, 'notification_type')));
        if (!why) break;
        const e = base('wait.start', grade, src, false);
        e.why = why;
        events.push(e);
        if (!s.wait || s.wait.why !== why) s.wait = { why, call: '' };   // keep a wait already tied to its call
        break;
      }
      case 'SubagentStart':
      case 'SubagentStop': {
        if (!by) break;
        const e = base(event === 'SubagentStart' ? 'subagent.start' : 'subagent.stop', grade, src, false);
        e.sub = by;
        const type = safeName(own(payload, 'agent_type')); if (type) e.type = type;
        if (event === 'SubagentStart') {
          // A repeated start names the same parent; it must not claim a second Agent call.
          let parent = s.subs.get(by);
          if (parent === undefined) {
            parent = parentOf(s);
            if (parent) s.calls.get(parent).claimed = true;
            s.subs.set(by, parent);
            if (s.subs.size > MAX_CALLS) s.subs.delete(s.subs.keys().next().value);
          }
          if (parent) e.parentCall = parent;
        }
        events.push(e);
        break;
      }
      default: break;                          // an event this slice does not draw: the session is still named
    }

    return { agent: 'claude', session, key, cwd: s.cwd, root: s.root, source: fromTranscript ? 'transcript' : 'hook', events };
  }

  /* The Agent call a subagent belongs to. Parallel Agent calls start their subagents in the order of
     the calls, so the earliest open call no subagent has claimed is taken; else the latest open one. */
  function parentOf(s) {
    let latest = '';
    for (const [id, open] of s.calls) {
      if (open.info.cls !== 'agent' || open.end) continue;
      if (!open.claimed) return id;
      latest = id;
    }
    return latest;
  }

  /* The resources a call names, from the fields 02 section 12 lists and no other. */
  function touches(info, input, s) {
    const out = [], cwd = s.cwd, root = s.root;
    const file = (raw, op) => {
      const kept = keptPath(root, cwd, target(raw));
      if (kept == null) return;
      out.push({ kind: 'file', op, path: typeof kept === 'string' ? kept : { outside: true, name: kept.name } });
    };
    const dir = raw => {
      const kept = keptPath(root, cwd, target(raw) || cwd);
      if (kept == null) return;
      out.push({ kind: 'dir', op: 'search', path: typeof kept === 'string' ? kept : { outside: true, name: kept.name } });
    };
    const url = (raw, op) => {
      const kept = cleanUrl(target(raw));
      if (kept) { out.push({ kind: 'url', op, url: kept }); return true; }
      return false;
    };
    if (info.mcp) {
      for (const k of MCP_TARGETS) {
        const raw = target(own(input, k));
        if (!raw) continue;
        if (k === 'path' || k === 'file_path') file(raw, 'unknown');
        else if (!url(raw, 'unknown') && k === 'uri') {
          const scheme = schemeOf(raw);
          if (scheme && !isAbsolute(raw)) out.push({ kind: 'mcp-resource', op: 'unknown', server: info.server, scheme });
        }
      }
      return out;
    }
    switch (info.full) {
      case 'Read': file(own(input, 'file_path'), 'read'); break;
      case 'Write': case 'Edit': case 'MultiEdit': file(own(input, 'file_path'), 'write'); break;
      case 'NotebookEdit': file(own(input, 'notebook_path'), 'write'); break;
      case 'Grep': case 'Glob': dir(own(input, 'path')); break;
      case 'WebFetch': url(own(input, 'url'), 'read'); break;
      case 'WebSearch': out.push({ kind: 'search', op: 'search' }); break;
      case 'ReadMcpResourceTool': {
        const server = safeName(own(input, 'server')), scheme = schemeOf(target(own(input, 'uri')));
        const touch = { kind: 'mcp-resource', op: 'read' };
        if (server) touch.server = server;
        if (scheme) touch.scheme = scheme;
        out.push(touch);
        break;
      }
      default: break;
    }
    return out;
  }

  return {
    /** A payload -> {agent, session, key, cwd, root, source, events}, or null. Never throws. */
    feed(payload, opts) {
      try { return feedUnsafe(payload, opts); } catch { return null; }
    },
    /** Forget one session: `<agent>:<session>`, or the bare session id. */
    forget(key) {
      if (typeof key !== 'string') return;
      sessions.delete(key.startsWith('claude:') ? key : 'claude:' + key);
    },
    size: () => sessions.size
  };
}

module.exports = { createNormaliser, MAX_SESSIONS, MAX_CALLS };
