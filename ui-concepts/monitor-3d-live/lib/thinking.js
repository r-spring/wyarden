/* Wyarden 3D monitor, working mock-up: the thinking one session has done, read from its transcript.
 *
 * For the agent the owner has selected, the view shows "the thinking this session has done". The
 * window's extension host calls readThinking when the page asks, and posts the answer to the page.
 * The text is the model's own thinking summary, which the CLI writes into the session's transcript
 * (`<config>/projects/<folder>/<session>.jsonl`, one JSON record per line).
 *
 * The format is the CLI's own and undocumented. What was seen: an `assistant` record's
 * `message.content` is an array that can hold `{type: "thinking", thinking, signature}`, the
 * signature a long base64 text. Measured on 27 November 2026 with CLI 2.1.332: unless the session
 * was started with `--thinking-display summarized`, `thinking` is an empty string and only the
 * signature is there (374 of 380 blocks). `{type: "redacted_thinking", data}` also exists. The CLI
 * can write the same record again later in the file, so a block is counted once, named by a short
 * hash of its signature (else of its `data`, else of its message id and text). A subagent's own
 * records (`isSidechain: true`) are not read in this slice, as in lib/transcript.js.
 *
 * So an answer tells four things apart: text was recorded (`recorded` > 0); the session thought
 * but no text was recorded (`unrecorded` > 0, `recorded` 0); no thinking at all (both 0); and
 * "could not read" (`ok: false`), which is none of those.
 *
 * This file is a privacy boundary. A transcript also holds prompts, file contents, command lines
 * and the assistant's answers. An answer holds thinking text, its time and counts, and nothing
 * else: no prompt, no answer text, no tool input, no signature, no path, no session id, and no
 * exception text. Nothing is kept between calls: no cache, no global.
 *
 * A call is one `stat`, then the file is opened, read and closed in one go, since on Windows an
 * open handle can stop the CLI from replacing its file. It uses fs.promises, so the extension host
 * is not blocked while it reads. `size` and `mtimeMs` come from that stat, so a caller can skip a
 * second read of a file that has not changed.
 *
 * The caps (LIMITS; a call's options can override each one, for tests):
 *   lookback  4 MB      most bytes read from the end of the file for one answer, as the transcript
 *                       tail's READ_CAP: the newest thinking is at the end, and one answer stays cheap
 *                       however long the session has run. Older thinking is not seen at all.
 *   thoughts  40        newest thoughts returned: the view shows recent thinking, not all of it
 *   chars     60000     most characters of thinking text in one answer, so one message to the page
 *                       stays small
 *   thought   12000     one thought is cut to this many characters, `…` included, so one long
 *                       thought cannot fill an answer by itself
 *   MAX_PATH  4096      a longer path is not looked at, as in lib/contract.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LIMITS = Object.freeze({
  lookback: 4 * 1024 * 1024,   // most bytes read from the end of the file for one answer
  thoughts: 40,                // newest thoughts returned
  chars: 60000,                // most characters of thinking text in one answer
  thought: 12000               // one thought is cut to this many characters
});
const MAX_PATH = 4096;
const NL = 0x0a;
const EMPTY = Buffer.alloc(0);
const ELLIPSIS = '…';

/** C0 and C1 control characters except tab and newline, and the two Unicode line separators, built from codes so no raw control character sits in this file. */
const code = String.fromCharCode;
const CONTROL = new RegExp('[' + code(0) + '-' + code(8) + code(0x0b) + '-' + code(0x1f) + code(0x7f) + '-' + code(0x9f) + code(0x2028, 0x2029) + ']', 'g');

/** The record's own time in ms, or null. The CLI writes ISO 8601 in UTC ("2026-01-02T03:04:05.678Z"). */
function timeOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Each limit from `given` when it is a positive integer there, else from LIMITS. */
function limitsOf(given) {
  const g = given && typeof given === 'object' ? given : {};
  const out = {};
  for (const name of Object.keys(LIMITS)) out[name] = Number.isInteger(g[name]) && g[name] > 0 ? g[name] : LIMITS[name];
  return out;
}

/** Plain newlines, control characters made spaces, blank space trimmed, a run of empty lines kept to one. */
function cleanThought(value) {
  return value.replace(/\r\n?/g, '\n').replace(CONTROL, ' ').trim().replace(/\n{3,}/g, '\n\n');
}

/** Cut to `max` characters, `…` included, never between the two halves of a surrogate pair. */
function cutThought(text, max) {
  if (text.length <= max) return { text };
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { text: text.slice(0, end).trimEnd() + ELLIPSIS, cut: true };
}

/**
 * Sixteen hex characters of a hash that name one block, so a record the CLI wrote twice is counted
 * once. A hash, so the set of names seen holds neither a signature nor any text.
 */
function keyOf(messageId, block) {
  let basis;
  if (typeof block.signature === 'string' && block.signature) basis = 'sig\n' + block.signature;
  else if (block.type === 'redacted_thinking' && typeof block.data === 'string' && block.data) basis = 'data\n' + block.data;
  else basis = 'id\n' + messageId + '\n' + (typeof block.thinking === 'string' ? block.thinking : '');
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

/**
 * The pure part: from complete transcript lines in file order, the newest thoughts first, within
 * the limits, and the counts. Only a line that holds `thinking"` is parsed (that matches both
 * `"thinking"` and `"redacted_thinking"`); a line that does not parse is passed over.
 */
function thinkingIn(lines, limits) {
  const max = limitsOf(limits);
  const seen = new Set();
  const found = [];            // recorded thoughts in file order: {at, text}, text already cleaned
  let unrecorded = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    if (typeof line !== 'string' || !line.includes('thinking"')) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    if (r.type !== 'assistant' || r.isSidechain === true) continue;
    const m = r.message;
    if (!m || typeof m !== 'object' || !Array.isArray(m.content)) continue;
    const id = typeof m.id === 'string' ? m.id : '';
    for (const b of m.content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type !== 'thinking' && b.type !== 'redacted_thinking') continue;
      const key = keyOf(id, b);
      if (seen.has(key)) continue;
      seen.add(key);
      const text = b.type === 'thinking' && typeof b.thinking === 'string' ? cleanThought(b.thinking) : '';
      if (text) found.push({ at: timeOf(r.timestamp), text });
      else unrecorded++;       // blank once cleaned, not a string, or redacted
    }
  }
  // From the newest back. The newest is always given; after it, the first that does not fit ends the walk.
  const thoughts = [];
  let used = 0;
  for (let i = found.length - 1; i >= 0 && thoughts.length < max.thoughts; i--) {
    const { text, cut } = cutThought(found[i].text, max.thought);
    if (thoughts.length && used + text.length > max.chars) break;
    used += text.length;
    thoughts.push(cut ? { at: found[i].at, text, cut } : { at: found[i].at, text });
  }
  return { thoughts, recorded: found.length, unrecorded, more: found.length - thoughts.length };
}

const failed = why => ({ ok: false, why });
const gone = e => !!e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');

/** Opened, read and closed in one go. Returns the bytes actually read (the file may have changed since its stat). */
async function readRange(file, from, length) {
  if (length <= 0) return EMPTY;
  const buf = Buffer.alloc(length);
  const fh = await fs.promises.open(file, 'r');
  let got = 0;
  try {
    while (got < length) {
      const { bytesRead } = await fh.read(buf, got, length - got, from + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
  } finally { await fh.close(); }
  return got === length ? buf : buf.subarray(0, got);
}

/**
 * The thinking a transcript holds, newest first. Never rejects: a path that is not an absolute
 * path string (or is longer than MAX_PATH) is `missing` without touching the disk, a folder is
 * `not-a-file`, and any other failure to stat, open or read is `unreadable`.
 */
async function readThinking(file, opts) {
  try {
    if (typeof file !== 'string' || file.length > MAX_PATH || file.includes('\0') || !path.isAbsolute(file)) return failed('missing');
    const max = limitsOf(opts);
    let st;
    try { st = await fs.promises.stat(file); } catch (e) { return failed(gone(e) ? 'missing' : 'unreadable'); }
    if (!st.isFile()) return failed('not-a-file');
    const start = Math.max(0, st.size - max.lookback);
    // One byte before the window tells whether the window starts on a line of its own.
    const from = start > 0 ? start - 1 : 0;
    const buf = await readRange(file, from, st.size - from);
    let body = buf;
    if (start > 0) {
      const nl = buf.indexOf(NL);  // everything before it belongs to a line the window cut
      body = nl < 0 ? EMPTY : buf.subarray(nl + 1);
    }
    // Decoded only after the cut, so a character split by the window start is thrown away whole.
    // The last line may have no newline yet: it is tried, and passed over if it does not parse.
    const lines = body.toString('utf8').split('\n');
    return { ok: true, size: st.size, mtimeMs: st.mtimeMs, whole: start === 0, ...thinkingIn(lines, max) };
  } catch (e) {
    return failed(gone(e) ? 'missing' : 'unreadable');
  }
}

module.exports = { readThinking, thinkingIn, LIMITS };
