/* Wyarden 3D monitor, working mock-up: the thinking of the one session the owner has selected, kept current.
 *
 * When the owner selects a session's agent node (Claude Code, Codex, Grok Build or Antigravity), the page
 * sends that node's id and nothing else. This file asks the hub what the node stands for, finds the
 * session's record itself (the page never names a path), reads its thinking with lib/thinking.js in that
 * tool's format, and posts the answer to the page that asked. A Claude Code session's record is the
 * transcript its session file names; another tool's is what lib/thinking-records.js finds in that tool's
 * own sessions folder. While the agent stays selected it looks again every few seconds, and reads again
 * only when the file changed. The watch ends only when it is stopped or replaced, when a Claude Code
 * transcript's path is one this window may not look at, or when the hub names a session of a tool whose
 * record is not read: a hub that does not answer, a session file caught half-written, or a record not
 * found yet is looked at again, so the view recovers by itself.
 *
 * A look that fails is not taken at its word. A negative ("gone", "ended", "unreadable", and a "none",
 * "unrecorded" or "not-yet" that would take back thoughts already shown) is said only when the next look
 * gives the same result; one that is not confirmed is forgotten.
 *
 * This file is a privacy boundary. The monitor keeps and shows no prompt, answer, file content or
 * command line; thinking text is the one exception, asked for by the owner, and it goes one way only:
 * transcript -> readThinking -> this host's memory for one answer -> post() to the one page that asked.
 * It never goes to the hub, a log, the console, a notification, the status bar or any saved state, and
 * no caught error is logged or shown, since its message could hold some of the text. Nothing of an
 * answer's text is kept between ticks: only the file's size and time, and the state last said.
 *
 * As in lib/hub-core.js, every dependency is passed in: the hub, the session lookup, the reader, the
 * `stat`, the page and the timer (`schedule(fn, ms)`, which returns a function that cancels it). So
 * every rule here is tested with a manual clock and no real file. lib/actions.js `focus` plays the same
 * role for a double-click; lib/view.js only hands messages over.
 */
'use strict';
const fs = require('node:fs');
const C = require('./contract.js');

/** How often the transcript is looked at again. Thinking is read by a person, not streamed; one look is one `stat`. */
const EVERY_MS = 3000;
/** The first look waits this long, so stepping across agents with the arrow keys asks about the one it stops on, not each. */
const FIRST_MS = 200;
/**
 * Once "gone" or "ended" is said, or another tool's record is not found, a look comes every fifth tick
 * (15 s): each such look is a hub request and a session-file lookup, or a search of hundreds of folders.
 */
const SLOW_TICKS = 5;
/** The tools whose record lib/thinking-records.js finds and lib/thinking.js reads in their own format. Claude Code's transcript is found by its session file. */
const RECORD_AGENTS = ['codex', 'grok', 'antigravity'];
/** The longest node id taken from the page: an agent node is `a:<agent>:<session>`, and a session id is at most 128 characters. */
const MAX_ID = 200;
/** An agent node's id, exactly: no fourth part, so no path or member can ride along. */
const AGENT_ID = /^a:[a-z]+:[A-Za-z0-9_-]{1,128}$/;
/** Most thoughts passed to the page: lib/thinking.js gives at most LIMITS.thoughts (40), so more than that is not its answer. */
const MAX_THOUGHTS = 40;
/** The largest time a Date can hold. A later one is no time, and would make the page's clock throw. */
const DATE_MAX = 8.64e15;
const STATES = ['recorded', 'unrecorded', 'none', 'not-yet', 'ended', 'gone', 'unreadable'];
const MISSING = 'missing';     // the key of a transcript that is not there

/**
 * A page message that asks for thinking, or undefined when its shape is not exactly right:
 * {target: null} stops the watch; {target: {class: 'agent', id}} starts it. Anything else is ignored
 * without a word. Each value is read once, and a target with any other key is refused.
 */
function checkThinking(message) {
  try {
    if (!message || typeof message !== 'object' || !Object.prototype.hasOwnProperty.call(message, 'target')) return undefined;
    const target = message.target;
    if (target === null) return { target: null };
    if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
    const keys = Object.keys(target);
    if (keys.length !== 2 || !keys.includes('class') || !keys.includes('id')) return undefined;
    const cls = target.class, id = target.id;
    if (cls !== 'agent' || typeof id !== 'string' || id.length > MAX_ID || !AGENT_ID.test(id)) return undefined;
    return { target: { class: 'agent', id } };
  } catch {
    return undefined;                                // a getter that throws is not a request
  }
}

/**
 * A transcript path this window may look at: an absolute path string of at most MAX_PATH characters
 * that is on this machine. A path on another machine (`\\server\share`, `//server/...`) is never
 * touched, because touching it signs this machine in to a server someone else chose (lib/contract.js),
 * and a config folder, from which the path is made, can be named by the environment.
 */
const localPath = file => typeof file === 'string' && file.length > 0 && file.length <= C.MAX_PATH && !file.includes('\0') &&
  C.isAbsolute(file) && !C.isNetworkPath(file);
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
/** Size and time as one key, or '' when either is not a number: then the next tick reads again. */
const keyOf = (size, mtimeMs) => (Number.isFinite(size) && Number.isFinite(mtimeMs) ? size + ':' + mtimeMs : '');
const empty = state => ({ state, thoughts: [], recorded: 0, unrecorded: 0, more: 0, whole: true });
/** A file that is not there, as `stat` says it. */
const isMissing = error => { try { return !!error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'); } catch { return false; } };

/**
 * What the page is told, built field by field from the reader's answer: the state, the thoughts as
 * {at, text}, the counts and `whole`. Size, time and `ok` stay here. Returns MISSING for a transcript
 * that is not there, null for an answer that tells nothing (unreadable, not a file, a wrong shape).
 */
function fromAnswer(answer) {
  try {
    if (!answer || typeof answer !== 'object') return null;
    if (answer.ok !== true) return answer.why === 'missing' ? MISSING : null;
    const key = keyOf(answer.size, answer.mtimeMs), list = answer.thoughts, thoughts = [];
    const length = Array.isArray(list) ? Math.min(list.length, MAX_THOUGHTS) : 0;
    for (let i = 0; i < length; i++) {
      const x = list[i];
      if (!x || typeof x !== 'object') continue;
      const text = x.text, at = x.at;
      if (typeof text !== 'string' || !text) continue;
      thoughts.push({ at: typeof at === 'number' && Number.isFinite(at) && Math.abs(at) <= DATE_MAX ? at : null, text });
    }
    const unrecorded = count(answer.unrecorded);
    const state = thoughts.length ? 'recorded' : unrecorded > 0 ? 'unrecorded' : 'none';
    return { key, body: { state, thoughts, recorded: count(answer.recorded), unrecorded, more: count(answer.more), whole: answer.whole === true } };
  } catch {
    return null;
  }
}

/* What one look found. A state result carries the body to post, the transcript's key when it came from
   the file, and a signature that holds no text: the state and the counts. */
const NOTHING = { kind: 'nothing' };    // a look that tells nothing: no answer from the hub, a lookup that threw
const SAME = { kind: 'same' };          // the transcript is as it was when last read
const OTHER = { kind: 'other' };        // a session of a tool whose record is not read here
const REFUSED = { kind: 'refused' };    // a Claude Code transcript path this window may not look at
/** `slow`: once this result is said, the next look is SLOW_TICKS away. */
const result = (body, key, slow) => ({
  kind: 'state', state: body.state, body, key, slow: slow === true,
  sig: body.state === 'recorded' ? 'recorded' : [body.state, body.recorded, body.unrecorded, body.more, body.whole].join(':')
});
/** A result that is said only when the next look agrees. */
const doubtful = (r, shownThoughts) => r.state === 'gone' || r.state === 'ended' || r.state === 'unreadable' ||
  (shownThoughts && (r.state === 'none' || r.state === 'unrecorded' || r.state === 'not-yet'));

/** The default timer: one that does not keep the editor's process alive. */
function later(fn, ms) {
  const timer = setTimeout(fn, ms);
  if (timer.unref) timer.unref();
  return () => clearTimeout(timer);
}
/** The default `stat`: size and time only. */
async function statOf(file) {
  const s = await fs.promises.stat(file);
  return { size: s.size, mtimeMs: s.mtimeMs };
}

/**
 * One watch at a time, for one page.
 *   deps.resolve(target)   -> the hub's answer; for an agent node {kind: 'session', agent, session, ...}
 *   deps.session(id)       -> a Claude Code session's entry of discover.liveClaudeSessions ({transcript, ...}), or null
 *   deps.record(agent, id) -> another tool's record {file, format} (lib/thinking-records.js recordOf), or null
 *   deps.read(file, opts)  -> lib/thinking.js readThinking's answer; Claude Code's with no opts, another tool's with {format}
 *   deps.stat(file)        -> {size, mtimeMs}; fs.promises.stat when left out
 *   deps.post(message)     -> to the page that asked, and to no other
 *   deps.schedule(fn, ms)  -> a function that cancels it; setTimeout when left out
 *   deps.everyMs           -> how often to look again (EVERY_MS)
 *
 * The first look comes FIRST_MS after `watch`: it asks the hub, then finds the record once (the
 * lookup reads files) and reads it. A later look is one `stat`, and reads only when the size or time
 * changed. A look is scheduled only when the one before has finished, so two never overlap, and a read
 * never starts while one started by an earlier watch is still on the disk: one read at a time per view.
 * An answer is posted only while its watch is the current one: a slow answer for an earlier selection
 * is dropped. A session of any tool but the four ends the watch without a word.
 *
 * Another tool's record not found is "not-yet", said as Claude Code's is, and looked for again every
 * fifth tick; such a tool has no session file, so there is no "ended" for it.
 */
function createWatch(deps = {}) {
  const resolve = typeof deps.resolve === 'function' ? deps.resolve : async () => null;
  const session = typeof deps.session === 'function' ? deps.session : () => null;
  const record = typeof deps.record === 'function' ? deps.record : async () => null;
  const read = typeof deps.read === 'function' ? deps.read : async () => null;
  const stat = typeof deps.stat === 'function' ? deps.stat : statOf;
  const post = typeof deps.post === 'function' ? deps.post : () => {};
  const schedule = typeof deps.schedule === 'function' ? deps.schedule : later;
  const everyMs = Number.isFinite(deps.everyMs) && deps.everyMs > 0 ? deps.everyMs : EVERY_MS;
  let now = null;                // the current watch
  let reading = null;            // the read on the disk, of whichever watch started it

  const live = w => now === w;
  function cancel(w) {
    const stopTimer = w.cancel;
    w.cancel = null;
    if (typeof stopTimer === 'function') { try { stopTimer(); } catch { /* a timer that cannot be cancelled finds its watch stopped */ } }
  }
  function send(w, body) {
    if (!live(w) || !STATES.includes(body.state)) return;
    const message = { type: 'thinking', id: w.id, state: body.state, thoughts: body.thoughts, recorded: body.recorded, unrecorded: body.unrecorded, more: body.more, whole: body.whole };
    try { post(message); } catch { /* the page is gone; nothing of the message is logged */ }
  }
  function next(w, ms) {
    if (!live(w)) return;
    try { w.cancel = schedule(() => { w.cancel = null; if (live(w)) run(w); }, ms); }
    catch { if (live(w)) now = null; }               // no timer: the watch cannot go on
  }
  function run(w) {
    tick(w).then(() => next(w, w.slow ? everyMs * SLOW_TICKS : everyMs), () => next(w, everyMs));
  }

  async function tick(w) {
    let r;
    try { r = w.file ? await again(w) : await begin(w); } catch { r = NOTHING; }
    if (!live(w)) return;
    try { decide(w, r); } catch { /* nothing of it is kept or shown */ }
  }
  /** Which session the node is, and where its record is; then the first read. */
  async function begin(w) {
    let found;
    try { found = await resolve({ id: w.id }); } catch { return NOTHING; }
    if (!live(w) || !found || typeof found !== 'object') return NOTHING;
    let kind, agent, sessionId;
    try { kind = found.kind; agent = found.agent; sessionId = found.session; } catch { return NOTHING; }
    // lib/hub-client.js answers {kind: 'none'} also when the hub did not answer: one such look says nothing.
    if (kind !== 'session' || !C.isSessionId(sessionId)) return result(empty('gone'));
    if (RECORD_AGENTS.includes(agent)) return findRecord(w, agent, sessionId);
    if (agent !== 'claude') return OTHER;
    let entry;
    try { entry = await session(sessionId); } catch { return NOTHING; }
    if (!live(w)) return NOTHING;
    if (!entry || typeof entry !== 'object') return result(empty('ended'));   // no session file, or one caught half-written
    let file;
    try { file = entry.transcript; } catch { return NOTHING; }
    if (!localPath(file)) return REFUSED;
    w.file = file;
    w.slow = false;                                   // a look that succeeds: every tick again
    return load(w);
  }
  /**
   * Another tool's record, from lib/thinking-records.js. Only an object with a `file` this window may look
   * at and the agent's own `format` is a record; anything else is "no record", looked for again every
   * fifth tick, since a search lists hundreds of folders. A lookup that throws tells nothing.
   */
  async function findRecord(w, agent, sessionId) {
    let found;
    try { found = await record(agent, sessionId); } catch { return NOTHING; }
    if (!live(w)) return NOTHING;
    let file, format;
    try { if (found && typeof found === 'object') { file = found.file; format = found.format; } } catch { return NOTHING; }
    if (format !== agent || !localPath(file)) return result(empty('not-yet'), undefined, true);
    w.file = file;
    w.format = format;
    w.slow = false;                                   // found: every tick again
    return load(w);
  }
  /** A later look: one `stat`, and a read only when the file changed. */
  async function again(w) {
    let st = null, missing = false;
    try { st = await stat(w.file); } catch (error) { missing = isMissing(error); }
    if (!live(w)) return NOTHING;
    if (missing) return result(empty('not-yet'), MISSING);
    if (st && typeof st === 'object') {
      let key = '';
      try { key = keyOf(st.size, st.mtimeMs); } catch { key = ''; }
      if (key && w.doubt && w.doubt.key === key) return w.doubt;      // as at the last look: the same result, without a read
      if (key && key === w.seen) return SAME;                         // unchanged: no read, no post
    }
    return load(w);
  }
  async function load(w) {
    let answer;
    try { answer = await readOne(w); } catch { answer = null; }
    if (!live(w)) return NOTHING;
    const got = fromAnswer(answer);
    if (got === MISSING) return result(empty('not-yet'), MISSING);
    if (!got) return result(empty('unreadable'), '');
    return result(got.body, got.key);
  }
  /** One read at a time: wait for one an earlier watch started, then read only if this watch is still the current one. */
  async function readOne(w) {
    while (reading) {
      try { await reading; } catch { /* its own watch deals with it */ }
      if (!live(w)) return undefined;
    }
    // Claude Code's transcript is read as it always was, with no options; another tool's in its own format.
    const pending = Promise.resolve().then(() => (w.format ? read(w.file, { format: w.format }) : read(w.file)));
    reading = pending;
    try { return await pending; } finally { if (reading === pending) reading = null; }
  }
  /** What a look's result does: end the watch, wait for the next look to agree, or post. */
  function decide(w, r) {
    if (r === OTHER) { stop(); return; }
    if (r === REFUSED) { send(w, empty('not-yet')); if (live(w)) stop(); return; }
    if (r.kind !== 'state') { w.doubt = null; return; }              // a look that tells nothing, or nothing new: a doubt is forgotten
    if (doubtful(r, w.shownThoughts) && !(w.doubt && w.doubt.sig === r.sig)) { w.doubt = r; return; }
    w.doubt = null;
    // A read that fails after something was said posts nothing: the page keeps what it has, and the next tick reads again.
    if (r.state === 'unreadable' && w.said) { w.seen = ''; return; }
    if (r.key !== undefined) w.seen = r.key;
    w.slow = r.state === 'gone' || r.state === 'ended' || r.slow;    // the pace of the next look, whether or not this one is said
    if (r.state !== 'recorded' && r.sig === w.said) return;          // said already
    send(w, r.body);
    w.said = r.sig;
    if (r.state === 'recorded') w.shownThoughts = true;
  }

  /** Watch the agent node `id`, in place of any earlier watch. Its first look is FIRST_MS away. */
  function watch(id) {
    stop();
    if (typeof id !== 'string') return;
    const w = { id, file: '', format: '', seen: '', doubt: null, said: '', shownThoughts: false, slow: false, cancel: null };
    now = w;
    next(w, FIRST_MS);
  }
  function stop() {
    const w = now;
    now = null;
    if (w) cancel(w);
  }
  /** The node id being watched, or null. */
  const current = () => (now ? now.id : null);

  return { watch, stop, current };
}

module.exports = { checkThinking, createWatch, EVERY_MS, FIRST_MS, SLOW_TICKS, MAX_ID, STATES, RECORD_AGENTS };
