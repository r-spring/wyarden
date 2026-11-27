/* Wyarden 3D monitor, working mock-up: a session's tool calls, read from its transcript.
 *
 * Until "Set Up Collectors" is run, no hook reports for a session. The CLI still writes every
 * tool call to its transcript (`<config>/projects/<folder>/<session>.jsonl`, one JSON record per
 * line), so the hub follows that file and turns each call's start and end into a payload shaped
 * like the hook's own. The normaliser then treats both sources alike, and grades this one
 * "derived".
 *
 * The format is the CLI's own and undocumented. What was seen (CLI 2.1): an assistant record holds
 * one content block, so parallel calls are several records with the same message id, one
 * `tool_use` each; a user record holds a `tool_result` with `tool_use_id` and, on failure,
 * `is_error: true`, but not the tool's name, which is remembered from its `tool_use`. Many other
 * record types exist (`api-request-blob` even repeats tool blocks); only `assistant` and `user`
 * are read, and anything else is passed over.
 *
 * A first look at a file (and a jump, and a file that shrank) replays the recent calls of its last
 * `lookback` bytes, so a view that opens on a live session is not empty; those payloads carry
 * `_wy.replay: true`.
 *
 * The hub polls every 700 ms: a poll is one `stat` when nothing changed, never throws, and never
 * keeps the file open between polls, since on Windows an open handle can stop the CLI from
 * replacing its file. Tool inputs are passed on in memory only; result content is never kept.
 */
'use strict';
const fs = require('node:fs');

const READ_CAP = 4 * 1024 * 1024;        // most bytes one poll reads; more than this appended is jumped over
const CARRY_CAP = 8 * 1024 * 1024;       // an unfinished line longer than this is dropped, not held
const MAX_OPEN = 500;                    // open calls remembered; the oldest goes first
const NL = 0x0a;
const EMPTY = Buffer.alloc(0);

/** The record's own time in ms, or undefined. The CLI writes ISO 8601 in UTC ("2026-01-02T03:04:05.678Z"). */
function timeOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

const str = v => (typeof v === 'string' && v ? v : undefined);

function createTail(file, { session, cwd, lookback = 262144, replay = 150 } = {}) {
  const back = Math.max(0, Math.min(Number.isFinite(lookback) ? Math.floor(lookback) : 262144, READ_CAP));
  const replayMax = Number.isInteger(replay) && replay >= 0 ? replay : 150;
  let pos = 0;                 // offset of the next byte to read
  let carry = null;            // bytes after the last newline read: the start of an unfinished line
  let discarding = false;      // the bytes up to the next newline belong to a line that cannot be used
  let first = true;
  let closed = false;
  const open = new Map();      // tool_use id -> {name, input}, oldest first

  const tail = { skipped: 0, jumps: 0, left: 0, poll, close };
  Object.defineProperty(tail, 'open', { get: () => open.size, enumerable: true });

  /** Opened, read and closed in one go. Returns the bytes actually read (the file may have changed since its stat). */
  function readRange(from, length) {
    if (length <= 0) return EMPTY;
    const buf = Buffer.allocUnsafe(length);
    const fd = fs.openSync(file, 'r');
    let got = 0;
    try {
      while (got < length) {
        const n = fs.readSync(fd, buf, got, length - got, from + got);
        if (n === 0) break;
        got += n;
      }
    } finally { fs.closeSync(fd); }
    return got === length ? buf : buf.subarray(0, got);
  }

  function keepCarry(rest) {
    if (!rest.length) { carry = null; return; }
    if (rest.length > CARRY_CAP) { carry = null; discarding = true; tail.skipped++; return; }
    carry = Buffer.from(rest);              // a copy, so the large read buffer can be freed
  }

  /** Whole lines only. Bytes are joined before decoding, so a character split across two reads stays whole. */
  function takeLines(buf) {
    let data = carry ? Buffer.concat([carry, buf]) : buf;
    carry = null;
    if (discarding) {
      const nl = data.indexOf(NL);
      if (nl < 0) return [];
      data = data.subarray(nl + 1);
      discarding = false;
    }
    const last = data.lastIndexOf(NL);
    if (last < 0) { keepCarry(data); return []; }
    keepCarry(data.subarray(last + 1));
    return data.toString('utf8', 0, last).split('\n');
  }

  /** The tool calls one line holds, as [{use|result, id, ...}]. Unknown and subagent records give none. */
  function itemsOf(line) {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!text.trim()) return [];
    let r;
    try { r = JSON.parse(text); } catch { tail.skipped++; return []; }
    if (!r || typeof r !== 'object' || Array.isArray(r)) return [];
    if (r.isSidechain === true) return [];  // a subagent's own calls: not drawn in this slice
    if (r.type !== 'assistant' && r.type !== 'user') return [];
    const content = r.message && typeof r.message === 'object' ? r.message.content : null;
    if (!Array.isArray(content)) return [];
    const base = { sid: str(r.sessionId) ?? str(r.session_id) ?? session, cwd: str(r.cwd) ?? cwd, at: timeOf(r.timestamp) };
    const items = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (r.type === 'assistant' && b.type === 'tool_use' && str(b.id) && str(b.name)) {
        items.push({ ...base, kind: 'use', id: b.id, name: b.name, input: b.input && typeof b.input === 'object' ? b.input : {} });
      } else if (r.type === 'user' && b.type === 'tool_result' && str(b.tool_use_id)) {
        items.push({ ...base, kind: 'result', id: b.tool_use_id, failed: b.is_error === true });
      }
    }
    return items;
  }

  function payload(event, item, name, input, replayed) {
    const wy = { src: 'transcript' };
    if (item.at !== undefined) wy.at = item.at;
    if (replayed) wy.replay = true;          // read back from the window, not seen as it happened
    return { hook_event_name: event, session_id: item.sid, cwd: item.cwd, tool_name: name, tool_input: input, tool_use_id: item.id, _wy: wy };
  }

  function remember(id, name, input) {
    open.set(id, { name, input });
    while (open.size > MAX_OPEN) open.delete(open.keys().next().value);
  }

  /** The end of a call: named from its remembered start, or "" when the start was never seen. */
  function ending(item, replayed) {
    const call = open.get(item.id);
    open.delete(item.id);
    return payload(item.failed ? 'PostToolUseFailure' : 'PostToolUse', item, call ? call.name : '', call ? call.input : {}, replayed);
  }

  /** Later polls: every start and every end, in file order. */
  function follow(lines) {
    const out = [];
    for (const line of lines) {
      for (const item of itemsOf(line)) {
        if (item.kind === 'use') {
          if (open.has(item.id)) continue;   // the same call written twice
          remember(item.id, item.name, item.input);
          out.push(payload('PreToolUse', item, item.name, item.input));
        } else {
          out.push(ending(item));
        }
      }
    }
    return out;
  }

  /**
   * A first look (the first poll, a jump, a shrunk file): a view that opens on a live session
   * should show at once what it has recently been doing, so the window is replayed, starts and
   * ends in file order, but only its last `replay` calls, to keep one poll small. A call still
   * open at the end is always given, whatever its age, since the view must show it running. An
   * end whose start is not given (before the window, or left out) is not given either, except for
   * a call already open from before a jump, which is ended so it does not stay open in the view.
   */
  function settle(lines) {
    const events = [];                       // in file order: {call, start} or {prior: payload}
    const calls = [];                        // in the order they started
    const byId = new Map();
    for (const line of lines) {
      for (const item of itemsOf(line)) {
        if (item.kind === 'use') {
          if (open.has(item.id) || byId.has(item.id)) continue;
          const call = { use: item, end: null, keep: false };
          calls.push(call);
          byId.set(item.id, call);
          events.push({ call, start: true });
        } else {
          const call = byId.get(item.id);
          if (call) {
            if (call.end) continue;          // the same result written twice
            call.end = item;
            events.push({ call, start: false });
          } else if (open.has(item.id)) {
            events.push({ prior: ending(item, true) });
          }                                  // else its start was before what was read
        }
      }
    }
    const from = Math.max(0, calls.length - replayMax);
    calls.forEach((call, i) => {
      call.keep = i >= from || !call.end;
      if (!call.keep) tail.left++;
    });
    const out = [];
    for (const e of events) {
      if (e.prior) { out.push(e.prior); continue; }
      const { use: u, end } = e.call;
      if (!e.call.keep) continue;
      out.push(e.start
        ? payload('PreToolUse', u, u.name, u.input, true)
        : payload(end.failed ? 'PostToolUseFailure' : 'PostToolUse', end, u.name, u.input, true));
    }
    for (const call of calls) if (!call.end) remember(call.use.id, call.use.name, call.use.input);
    return out;
  }

  /** Read the last `lookback` bytes and start from there. */
  function restart(size) {
    const start = Math.max(0, size - back);
    // One byte before the window tells whether the window starts on a line of its own.
    const from = start > 0 ? start - 1 : 0;
    const buf = readRange(from, size - from);
    pos = from + buf.length;
    first = false;
    carry = null;
    discarding = false;
    let body = buf;
    if (start > 0) {
      const nl = buf.indexOf(NL);
      if (nl < 0) { discarding = true; body = EMPTY; } else body = buf.subarray(nl + 1);
    }
    return settle(takeLines(body));
  }

  function poll() {
    if (closed) return [];
    try {
      const st = fs.statSync(file, { throwIfNoEntry: false });
      if (!st || !st.isFile()) return [];   // not written yet: it may appear later
      const size = st.size;
      if (first) return restart(size);
      if (size === pos) return [];
      if (size < pos) return restart(size); // shrank: rewritten, so read again from its end
      if (size - pos > READ_CAP) { tail.jumps++; return restart(size); }
      const buf = readRange(pos, size - pos);
      pos += buf.length;
      return follow(takeLines(buf));
    } catch {
      return [];                            // busy, locked or gone for a moment: the next poll tries again
    }
  }

  function close() {
    closed = true;
    open.clear();
    carry = null;
  }

  return tail;
}

module.exports = { createTail, READ_CAP, MAX_OPEN };
