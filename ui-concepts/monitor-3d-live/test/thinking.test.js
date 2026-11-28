// Thinking: the model's own thinking summaries, read from a transcript on request, and nothing else of it.
// Every file is a temporary one the test writes; every id, text, signature and path in it is invented.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readThinking, thinkingIn, LIMITS } = require('../lib/thinking.js');

const SID = '11111111-2222-4333-8444-555555555555';
const CWD = '/home/dev/example-project';
const T0 = '2026-01-02T03:00:00.000Z';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** A file of `text` in a new temporary folder. */
function write(t, text, name = SID + '.jsonl') {
  const file = path.join(tmp(t), name);
  fs.writeFileSync(file, text);
  return file;
}
/** Swap fs.promises[name] for this test only; `make` gets the real one. */
function wrap(t, name, make) {
  const real = fs.promises[name];
  fs.promises[name] = make(real);
  t.after(() => { fs.promises[name] = real; });
}
const splitLines = text => text.split('\n');
const texts = answer => answer.thoughts.map(x => x.text);

let uid = 0;
const sig = () => 'c2lnbmF0dXJl' + String(++uid).padStart(6, '0');   // invented, base64-shaped
/** An assistant record whose message.content is `content`, as one line with its newline. */
function reply(content, { msg, at = T0, ...extra } = {}) {
  return JSON.stringify({
    parentUuid: null, isSidechain: false, type: 'assistant', uuid: 'a-' + (++uid), timestamp: at, cwd: CWD, sessionId: SID,
    message: { id: msg || 'msg_' + (++uid), type: 'message', role: 'assistant', model: 'example-model', content }, ...extra
  }) + '\n';
}
const thought = (text, signature = sig()) => ({ type: 'thinking', thinking: text, signature });
const blank = (signature = sig()) => ({ type: 'thinking', thinking: '', signature });
const redacted = (data = 'cmVkYWN0ZWQ' + (++uid)) => ({ type: 'redacted_thinking', data });
const said = text => ({ type: 'text', text });
const prompt = text => JSON.stringify({
  parentUuid: null, isSidechain: false, type: 'user', uuid: 'u-' + (++uid), timestamp: T0, cwd: CWD, sessionId: SID,
  message: { role: 'user', content: text }
}) + '\n';
const record = value => JSON.stringify(value) + '\n';

/* ---------- the four answers ---------- */

test('recorded thinking comes back newest first, with its time, and the counts are right', async t => {
  const file = write(t,
    prompt('Invented question: what is seven times six?') +
    reply([thought('First invented thought about the product.')], { at: '2026-01-02T03:00:01.000Z' }) +
    reply([thought('Second invented thought.'), said('An invented answer.')], { at: '2026-01-02T03:00:02.000Z' }) +
    reply([blank()], { at: '2026-01-02T03:00:03.000Z' }) +
    reply([{ type: 'tool_use', id: 'toolu_T1', name: 'Read', input: { file_path: 'notes.txt' } }]) +
    reply([thought('Third invented thought, the newest.')], { at: '2026-01-02T03:00:04.000Z' }));
  const st = fs.statSync(file);
  assert.deepEqual(await readThinking(file), {
    ok: true, size: st.size, mtimeMs: st.mtimeMs, whole: true,
    thoughts: [
      { at: Date.parse('2026-01-02T03:00:04.000Z'), text: 'Third invented thought, the newest.' },
      { at: Date.parse('2026-01-02T03:00:02.000Z'), text: 'Second invented thought.' },
      { at: Date.parse('2026-01-02T03:00:01.000Z'), text: 'First invented thought about the product.' }
    ],
    recorded: 3, unrecorded: 1, more: 0
  });
});

test('only empty-text and redacted blocks: no thoughts, recorded 0, and unrecorded counts each one', async t => {
  const file = write(t,
    reply([blank(), blank()], { msg: 'msg_TWO_BLANKS' }) +
    reply([redacted()]) +
    reply([{ type: 'thinking', thinking: ' \n\t \r\n ', signature: sig() }]) +
    reply([{ type: 'thinking', thinking: 42, signature: sig() }]) +
    reply([{ type: 'thinking', signature: sig() }]) +
    reply([{ type: 'thinking', thinking: '\u0000\u001b\u2028', signature: sig() }]));   // blank once cleaned
  const got = await readThinking(file);
  assert.deepEqual({ ...got, size: 0, mtimeMs: 0 }, {
    ok: true, size: 0, mtimeMs: 0, whole: true, thoughts: [], recorded: 0, unrecorded: 7, more: 0
  });
});

test('no thinking at all: ok, and every count is zero; an empty file too', async t => {
  const none = { thoughts: [], recorded: 0, unrecorded: 0, more: 0 };
  const file = write(t,
    prompt('An invented question with no thinking in its answer.') +
    reply([said('An invented answer.')]) +
    reply([{ type: 'tool_use', id: 'toolu_N1', name: 'Glob', input: { pattern: '*.md' } }]) +
    record({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_N1', content: 'a.md' }] } }) +
    record({ type: 'system', subtype: 'informational', content: 'invented' }));
  const got = await readThinking(file);
  assert.equal(got.ok, true);
  assert.equal(got.whole, true);
  assert.deepEqual({ thoughts: got.thoughts, recorded: got.recorded, unrecorded: got.unrecorded, more: got.more }, none);
  const empty = await readThinking(write(t, '', 'empty.jsonl'));
  assert.deepEqual(empty, { ok: true, size: 0, mtimeMs: empty.mtimeMs, whole: true, ...none });
});

test('a missing file, a folder, a relative path and a non-string each give their reason, and never throw', async t => {
  const dir = tmp(t);
  const file = path.join(dir, 'present.jsonl');
  fs.writeFileSync(file, reply([thought('Present.')]));
  assert.deepEqual(await readThinking(path.join(dir, 'absent.jsonl')), { ok: false, why: 'missing' });
  assert.deepEqual(await readThinking(path.join(file, 'below-a-file.jsonl')), { ok: false, why: 'missing' }, 'a file where a folder should be');
  assert.deepEqual(await readThinking(dir), { ok: false, why: 'not-a-file' });
  let stats = 0;
  wrap(t, 'stat', real => (...a) => { stats++; return real(...a); });
  const bad = ['relative/session.jsonl', 'session.jsonl', '', undefined, null, 42, {}, [file], Buffer.from(file),
    new String(file), path.join(dir, 'x'.repeat(4100)), file + '\u0000.jsonl'];
  for (const value of bad) {
    const pending = readThinking(value);
    assert.ok(pending instanceof Promise, 'a promise, never a throw');
    assert.deepEqual(await pending, { ok: false, why: 'missing' }, typeof value);
  }
  assert.equal(stats, 0, 'a path that is not an absolute path string is not looked up');
  assert.equal((await readThinking(file)).recorded, 1);
  assert.equal(stats, 1, 'a good path: one stat');
});

test('a path on another machine is missing, and is never looked up: no stat and no open', async t => {
  let stats = 0, opens = 0;
  wrap(t, 'stat', real => (...a) => { stats++; return real(...a); });
  wrap(t, 'open', real => (...a) => { opens++; return real(...a); });
  for (const value of ['\\\\server\\share\\projects\\-home-example-proj\\' + SID + '.jsonl', '//server/share/projects/' + SID + '.jsonl',
    '\\\\?\\UNC\\server\\share\\' + SID + '.jsonl', '\\\\server/share/' + SID + '.jsonl']) {
    assert.deepEqual(await readThinking(value), { ok: false, why: 'missing' }, value);
  }
  assert.deepEqual([stats, opens], [0, 0], 'nothing was asked of the disk, so no server was reached');
});

test('a file that cannot be read is unreadable: no throw, no exception text, and a failed read still closes', async t => {
  const file = write(t, reply([thought('Readable once the fault is gone.')]));
  const real = { stat: fs.promises.stat, open: fs.promises.open };
  t.after(() => Object.assign(fs.promises, real));
  const fail = errCode => async () => { const e = new Error('CANARY-ERROR-TEXT ' + file); e.code = errCode; throw e; };
  fs.promises.stat = fail('EACCES');
  assert.deepEqual(await readThinking(file), { ok: false, why: 'unreadable' });
  fs.promises.stat = real.stat;
  fs.promises.open = fail('EBUSY');
  assert.deepEqual(await readThinking(file), { ok: false, why: 'unreadable' });
  fs.promises.open = fail('ENOENT');                 // gone between its stat and its open
  assert.deepEqual(await readThinking(file), { ok: false, why: 'missing' });
  let closes = 0;
  fs.promises.open = async (...a) => {
    const fh = await real.open(...a);
    return {
      read: async () => { const e = new Error('CANARY-ERROR-TEXT'); e.code = 'EIO'; throw e; },
      close: async () => { closes++; return fh.close(); }
    };
  };
  assert.deepEqual(await readThinking(file), { ok: false, why: 'unreadable' });
  assert.equal(closes, 1, 'the handle is closed although the read failed');
  fs.promises.open = real.open;
  assert.deepEqual(texts(await readThinking(file)), ['Readable once the fault is gone.'], 'tried again, it reads');
});

/* ---------- which records and blocks ---------- */

test('sidechain, user and other records are passed over, even when they hold a thinking block', async t => {
  const file = write(t,
    reply([thought('A subagent thought.')], { isSidechain: true }) +
    record({ type: 'user', isSidechain: false, timestamp: T0, message: { role: 'user', content: [thought('A user-side thought.')] } }) +
    record({ type: 'api-request-blob', timestamp: T0, message: { content: [thought('A copy in a request blob.')] } }) +
    record({ type: 'system', subtype: 'informational', content: [thought('A system thought.')], message: { content: [thought('Another.')] } }) +
    reply({ type: 'thinking', thinking: 'Content that is not an array.', signature: sig() }) +
    record({ type: 'assistant', message: null, thinking: 'A record with no message.' }) +
    record([{ type: 'thinking', thinking: 'A line that is an array.', signature: sig() }]) +
    'null\n' + '"thinking"\n' + '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"half\n' +
    reply([{ type: 'tool_use', id: 'toolu_I1', name: 'Write', input: { content: thought('Inside a tool input.') } }]) +
    record({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_I1', content: [thought('Inside a tool result.')] }] } }) +
    reply([{ type: 'text', text: 'A text block.', thinking: 'A text block with a thinking field.' }]) +
    reply([thought('The only thought that counts.')]));
  const got = await readThinking(file);
  assert.deepEqual(texts(got), ['The only thought that counts.']);
  assert.equal(got.recorded, 1);
  assert.equal(got.unrecorded, 0);
});

test('duplicates: a block written twice counts once; two blocks of one reply both count; no signature is named by id and text', () => {
  const twice = reply([thought('Written twice by the CLI.', 'c2lnLXR3aWNl')], { msg: 'msg_D1', at: '2026-01-02T03:01:00.000Z' });
  const later = reply([thought('Written twice by the CLI.', 'c2lnLXR3aWNl')], { msg: 'msg_D1', at: '2026-01-02T03:09:00.000Z' });  // its own uuid and time
  const pair = reply([thought('One of two.', 'c2lnLW9uZQ'), thought('Two of two.', 'c2lnLXR3bw')], { msg: 'msg_D2' });
  const unsigned = (msg, text) => reply([{ type: 'thinking', thinking: text }], { msg });
  const got = thinkingIn(splitLines(
    twice + twice + later + pair +
    unsigned('msg_D3', 'No signature.') + unsigned('msg_D3', 'No signature.') + unsigned('msg_D3', 'Other text, same id.') +
    unsigned('msg_D4', 'No signature.') +
    reply([blank('c2lnLWJsYW5r')]) + reply([blank('c2lnLWJsYW5r')]) +
    reply([redacted('cmVkLXNhbWU')]) + reply([redacted('cmVkLXNhbWU')])));
  assert.deepEqual(texts(got), ['No signature.', 'Other text, same id.', 'No signature.', 'Two of two.', 'One of two.', 'Written twice by the CLI.']);
  assert.equal(got.recorded, 6, 'D1 once, both of D2, two texts of D3, D4');
  assert.equal(got.unrecorded, 2, 'the blank once, the redacted block once');
  assert.equal(got.thoughts[5].at, Date.parse('2026-01-02T03:01:00.000Z'), 'counted where it first appears');
});

test('at is the record time in ms: ISO 8601 text or a finite number, else null', () => {
  const got = thinkingIn([
    reply([thought('ISO time.')], { at: '2026-01-02T03:04:05.678Z' }),
    reply([thought('Number time.')], { at: 1767323045678 }),
    reply([thought('Null time.')], { at: null }),
    reply([thought('Text that is not a time.')], { at: 'yesterday-ish' }),
    reply([thought('An object time.')], { at: { when: 1 } }),
    record({ type: 'assistant', message: { content: [thought('No timestamp key.')] } })
  ]);
  assert.deepEqual(got.thoughts.map(x => x.at), [null, null, null, null, 1767323045678, Date.parse('2026-01-02T03:04:05.678Z')]);
});

test('thinkingIn takes anything without throwing, and gives exactly its four keys', () => {
  const zero = { thoughts: [], recorded: 0, unrecorded: 0, more: 0 };
  for (const value of [undefined, null, 'a line', 42, {}, ['', 42, null, {}, 'not json "thinking"']]) assert.deepEqual(thinkingIn(value), zero);
  assert.deepEqual(Object.keys(thinkingIn([reply([thought('x')])])), ['thoughts', 'recorded', 'unrecorded', 'more']);
});

/* ---------- privacy ---------- */

test('privacy: the answer holds the thinking text, its time and counts, and nothing else of the transcript', async t => {
  const C = {
    thinking: 'CANARY-THINKING-a1b2', unsigned: 'CANARY-THINKING-UNSIGNED-c3d4',
    prompt: 'CANARY-PROMPT-e5f6', answer: 'CANARY-ANSWER-0718', command: 'CANARY-COMMAND-293a',
    filePath: '/home/dev/CANARY-FILE-PATH-4b5c/notes.txt', nested: 'CANARY-NESTED-6d7e', result: 'CANARY-RESULT-8f90',
    signature: 'Q0FOQVJZLVNJR05BVFVSRS0xMjM0', data: 'Q0FOQVJZLVJFREFDVEVELTU2Nzg',
    session: 'CANARY-SESSION-9abc', cwd: '/home/dev/CANARY-CWD-def0', msg: 'msg_CANARY-MESSAGE-1357',
    uuid: 'CANARY-UUID-2468', tool: 'toolu_CANARY-TOOL-0864', model: 'CANARY-MODEL-9753', branch: 'CANARY-BRANCH-5311'
  };
  const base = { parentUuid: null, isSidechain: false, uuid: C.uuid, sessionId: C.session, cwd: C.cwd, gitBranch: C.branch, version: '2.1.0' };
  const dir = tmp(t);
  const file = path.join(dir, C.session + '.jsonl');
  fs.writeFileSync(file,
    record({ ...base, type: 'user', timestamp: '2026-01-02T03:00:00.000Z',
      message: { role: 'user', content: [said(C.prompt), thought('user side ' + C.prompt, 'c2lnLXVzZXI')] } }) +
    record({ ...base, type: 'assistant', timestamp: '2026-01-02T03:00:01.000Z',
      message: { id: C.msg, model: C.model, role: 'assistant', content: [
        thought(C.thinking, C.signature), redacted(C.data), said(C.answer),
        { type: 'tool_use', id: C.tool, name: 'Bash', input: { command: C.command + ' --file ' + C.filePath, description: 'invented', note: thought(C.nested) } }
      ] } }) +
    record({ ...base, type: 'user', timestamp: '2026-01-02T03:00:02.000Z', toolUseResult: { stdout: C.result },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: C.tool, content: [said(C.result), thought(C.result)] }] } }) +
    record({ ...base, type: 'assistant', timestamp: '2026-01-02T03:00:03.000Z',
      message: { id: C.msg, model: C.model, role: 'assistant', content: [{ type: 'thinking', thinking: C.unsigned }] } }));
  const got = await readThinking(file);
  assert.deepEqual(Object.keys(got), ['ok', 'size', 'mtimeMs', 'whole', 'thoughts', 'recorded', 'unrecorded', 'more']);
  for (const x of got.thoughts) assert.ok(Object.keys(x).every(k => k === 'at' || k === 'text' || k === 'cut'), Object.keys(x).join());
  assert.deepEqual(texts(got), [C.unsigned, C.thinking]);
  assert.equal(got.recorded, 2);
  assert.equal(got.unrecorded, 1);
  const json = JSON.stringify(got);
  assert.ok(json.includes(C.thinking), 'the thinking text is there');
  for (const [name, value] of Object.entries(C)) {
    if (name === 'thinking' || name === 'unsigned') continue;
    assert.ok(!json.includes(value), name + ' must not be in the answer');
  }
  for (const where of [dir, file, path.basename(file)]) {
    assert.ok(!json.includes(where) && !json.includes(JSON.stringify(where).slice(1, -1)), 'no path in the answer');
  }
});

/* ---------- cleaning ---------- */

test('cleaning: plain newlines, no control characters, trimmed, at most one empty line in a row; a tab and a newline survive', () => {
  const raw = '  \r\n\t First line\r\nsecond\u0000line\rthird\u001b[1m line\u2028after\u007f\u0085x\u2029y\n\n\n\n\nfive newlines\ta tab\nkept \n\n  ';
  const [one] = thinkingIn([reply([thought(raw)])]).thoughts;
  assert.equal(one.text, 'First line\nsecond line\nthird [1m line after  x y\n\nfive newlines\ta tab\nkept');
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(one.text));
  assert.ok(!('cut' in one));
});

/* ---------- limits ---------- */

test('LIMITS are the documented ones, and cannot be changed by a caller', () => {
  assert.deepEqual(LIMITS, { lookback: 4 * 1024 * 1024, thoughts: 40, chars: 60000, thought: 12000 });
  assert.ok(Object.isFrozen(LIMITS));
});

test('limits: one long thought is cut to `thought` characters, the ellipsis included, and marked; a cut never splits a surrogate pair', () => {
  const [long] = thinkingIn([reply([thought('x'.repeat(LIMITS.thought + 500))])]).thoughts;
  assert.equal(long.text.length, LIMITS.thought);
  assert.ok(long.text.endsWith('\u2026'));
  assert.equal(long.cut, true);
  const cut = (text, max) => thinkingIn([reply([thought(text)], { at: T0 })], { thought: max }).thoughts[0];
  assert.deepEqual(cut('abcdefghijklmnop', 10), { at: Date.parse(T0), text: 'abcdefghi\u2026', cut: true });
  assert.deepEqual(cut('abcdefghij', 10), { at: Date.parse(T0), text: 'abcdefghij' }, 'a thought that fits has no cut key');
  const pair = cut('abcdefgh\u{1F600}zzzz', 10).text;
  assert.equal(pair, 'abcdefgh\u2026');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(pair), 'no half of a pair');
  assert.equal(cut('abc     defghijk', 8).text, 'abc\u2026', 'no blank space before the mark');
});

test('limits: `thoughts` and `chars` leave older thoughts out, more says how many, and the walk stops at the first that does not fit', () => {
  const five = [1, 2, 3, 4, 5].map(n => reply([thought('Thought ' + n + '.')]));   // ten characters each
  assert.deepEqual(texts(thinkingIn(five)), ['Thought 5.', 'Thought 4.', 'Thought 3.', 'Thought 2.', 'Thought 1.']);
  const byCount = thinkingIn(five, { thoughts: 2 });
  assert.deepEqual(texts(byCount), ['Thought 5.', 'Thought 4.']);
  assert.equal(byCount.recorded, 5);
  assert.equal(byCount.more, 3);
  const byChars = thinkingIn(five, { chars: 25 });
  assert.deepEqual(texts(byChars), ['Thought 5.', 'Thought 4.']);
  assert.equal(byChars.more, 3);
  assert.equal(thinkingIn(five, { chars: 30 }).thoughts.length, 3, 'exactly `chars` still fits');
  const mixed = thinkingIn([reply([thought('ok')]), reply([thought('y'.repeat(30))]), five[3], five[4]], { chars: 25 });
  assert.deepEqual(texts(mixed), ['Thought 5.', 'Thought 4.'], 'the older, shorter one is not taken past the one that did not fit');
  assert.equal(mixed.more, 2);
});

test('limits: the newest thought is given even when it alone passes `chars`', () => {
  const got = thinkingIn([reply([thought('Older.')]), reply([thought('z'.repeat(100))])], { chars: 50 });
  assert.deepEqual(texts(got), ['z'.repeat(100)]);
  assert.equal(got.more, 1);
  const both = thinkingIn([reply([thought('Older.')]), reply([thought('z'.repeat(100))])], { chars: 50, thought: 20 });
  assert.deepEqual(texts(both), ['z'.repeat(19) + '\u2026', 'Older.'], 'the newest is cut to `thought` first');
});

test('limits: the defaults apply, and an option that is not a positive integer falls back to them', async t => {
  const many = Array.from({ length: 45 }, (_, n) => reply([thought('Short thought ' + n + '.')]));
  assert.equal(thinkingIn(many).thoughts.length, 40);
  assert.equal(thinkingIn(many).more, 5);
  for (const bad of [0, -1, 1.5, '2', NaN, Infinity, null, undefined, true]) {
    assert.equal(thinkingIn(many, { thoughts: bad }).thoughts.length, 40, String(bad));
  }
  assert.equal(thinkingIn(many, 'not an object').thoughts.length, 40);
  const big = Array.from({ length: 6 }, (_, n) => reply([thought(String(n).repeat(11000))]));
  const capped = thinkingIn(big);
  assert.equal(capped.thoughts.length, 5, '5 x 11000 fits in 60000; a sixth does not');
  assert.equal(capped.more, 1);
  const file = write(t, many.join(''));
  const one = await readThinking(file, { thoughts: 1, lookback: 'all of it' });
  assert.deepEqual(texts(one), ['Short thought 44.']);
  assert.equal(one.more, 44);
  assert.equal(one.whole, true);
});

/* ---------- the tail of the file ---------- */

test('the tail: a window past byte 0 is not whole, and its cut first line is dropped, even when cut inside a character', async t => {
  const a = reply([said('An emoji \u{1F600} before the thought.'), thought('Older thought, cut by the window.')]);
  const b = reply([thought('Newer thought: caf\u00e9 \u2014 \u{1F600} done.')]);
  const file = write(t, a + b, 'tail.jsonl');
  const bytesA = Buffer.from(a, 'utf8');
  const lenB = Buffer.byteLength(b, 'utf8');
  const total = bytesA.length + lenB;
  const emoji = bytesA.indexOf(Buffer.from('\u{1F600}', 'utf8'));
  assert.ok(emoji > 0);
  const inChar = await readThinking(file, { lookback: total - (emoji + 2) });   // two of the emoji's four bytes
  assert.equal(inChar.ok, true);
  assert.equal(inChar.whole, false);
  assert.equal(inChar.size, total);
  assert.deepEqual(texts(inChar), ['Newer thought: caf\u00e9 \u2014 \u{1F600} done.']);
  assert.equal(inChar.recorded, 1);
  assert.ok(!JSON.stringify(inChar).includes('\ufffd'), 'no broken character');
  const exact = await readThinking(file, { lookback: lenB });                    // starts exactly at `b`
  assert.deepEqual([exact.whole, texts(exact)], [false, ['Newer thought: caf\u00e9 \u2014 \u{1F600} done.']]);
  const oneIn = await readThinking(file, { lookback: total - 1 });               // one byte into `a`
  assert.deepEqual([oneIn.whole, oneIn.recorded], [false, 1]);
  const all = await readThinking(file, { lookback: total });
  assert.deepEqual([all.whole, all.recorded], [true, 2]);
  const none = await readThinking(file, { lookback: 5 });                        // no line starts in the window
  assert.deepEqual({ ...none, mtimeMs: 0 }, { ok: true, size: total, mtimeMs: 0, whole: false, thoughts: [], recorded: 0, unrecorded: 0, more: 0 });
});

test('the tail: the rest of a cut line is not read, even when it would parse as a record', async t => {
  const hidden = reply([thought('Hidden in the part of a line the window cut.')]);
  const b = reply([thought('After the cut line.')]);
  const file = write(t, 'NOT JSON ' + hidden + b, 'trap.jsonl');
  const got = await readThinking(file, { lookback: Buffer.byteLength(hidden + b, 'utf8') });   // starts at the `{` of `hidden`
  assert.equal(got.whole, false);
  assert.deepEqual(texts(got), ['After the cut line.']);
  assert.equal(got.recorded, 1);
});

test('a last line with no newline is read when it is complete, and passed over when it is half a record; CRLF lines are read', async t => {
  const a = reply([thought('A complete line.')]);
  const b = reply([thought('The last line, no newline yet.')]);
  assert.deepEqual(texts(await readThinking(write(t, a + b.slice(0, -1), 'whole.jsonl'))), ['The last line, no newline yet.', 'A complete line.']);
  const half = await readThinking(write(t, a + b.slice(0, Math.floor(b.length / 2)), 'half.jsonl'));
  assert.deepEqual([half.ok, texts(half)], [true, ['A complete line.']]);
  const crlf = await readThinking(write(t, (a + b).replace(/\n/g, '\r\n'), 'crlf.jsonl'));
  assert.deepEqual(texts(crlf), ['The last line, no newline yet.', 'A complete line.']);
});

/* ---------- nothing held ---------- */

test('the file is not left open: every open is closed, and the file can be renamed and deleted at once', async t => {
  const file = write(t, reply([thought('Held for no longer than one read.')]));
  let opens = 0, closes = 0;
  wrap(t, 'open', real => async (...a) => {
    opens++;
    const fh = await real(...a);
    const close = fh.close.bind(fh);
    fh.close = async () => { closes++; return close(); };
    return fh;
  });
  assert.equal((await readThinking(file)).recorded, 1);
  assert.equal((await readThinking(file, { lookback: 10 })).whole, false);
  assert.deepEqual([opens, closes], [2, 2], 'each open closed before the answer');
  // Node opens files on Windows with delete sharing, so these pass with a handle open too: the count above is the real check.
  fs.renameSync(file, file + '.moved');
  fs.rmSync(file + '.moved');
  assert.ok(!fs.existsSync(file + '.moved'));
});

test('the module keeps nothing: each call reflects the file as it is, and parallel calls do not mix', async t => {
  const file = write(t, reply([thought('Before the change.', 'c2lnLXNhbWU')]));
  assert.deepEqual(texts(await readThinking(file)), ['Before the change.']);
  fs.writeFileSync(file, reply([thought('After the change, same signature.', 'c2lnLXNhbWU')]));
  const after = await readThinking(file);
  assert.deepEqual(texts(after), ['After the change, same signature.'], 'a block seen by an earlier call is not remembered');
  assert.equal(after.size, fs.statSync(file).size);
  fs.appendFileSync(file, reply([thought('Appended later.')]));
  assert.deepEqual(texts(await readThinking(file)), ['Appended later.', 'After the change, same signature.']);
  fs.writeFileSync(file, '');
  assert.equal((await readThinking(file)).recorded, 0);
  const other = write(t, reply([thought('In another file.')]), 'other.jsonl');
  fs.writeFileSync(file, reply([thought('In the first file.')]));
  const [one, two] = await Promise.all([readThinking(file), readThinking(other)]);
  assert.deepEqual([texts(one), texts(two)], [['In the first file.'], ['In another file.']]);
});

test('the module needs only fs, path, crypto and lib/contract.js, holds no raw control character, and exports only its API', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'thinking.js'), 'utf8');
  const needs = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map(m => m[1]).sort();
  assert.deepEqual(needs, ['./contract.js', 'node:crypto', 'node:fs', 'node:path']);
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/.test(source), 'no raw control character');
  assert.deepEqual(Object.keys(require('../lib/thinking.js')), ['readThinking', 'thinkingIn', 'LIMITS']);
});
