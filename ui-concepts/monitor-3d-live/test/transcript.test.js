// The transcript tail: tool calls read from a growing transcript file, as hook-shaped payloads.
// Every file is a temporary one the test writes and appends to between polls; every value is invented.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTail, READ_CAP, MAX_OPEN } = require('../lib/transcript.js');

const FIX = path.join(__dirname, 'fixtures', 'transcript');
const SID = '11111111-2222-4333-8444-555555555555';
const CWD = '/home/dev/example-project';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const lines = name => fs.readFileSync(path.join(FIX, name), 'utf8').split('\n').filter(Boolean);
const append = (file, text) => fs.appendFileSync(file, text);
const brief = list => list.map(p => p.hook_event_name + ' ' + p.tool_use_id + ' ' + p.tool_name);

let uid = 0;
const use = (id, name, input = {}, extra = {}) => JSON.stringify({
  isSidechain: false, type: 'assistant', uuid: 'a-' + (++uid), timestamp: '2026-01-02T03:00:00.000Z', cwd: CWD, sessionId: SID,
  message: { id: 'msg_' + id, role: 'assistant', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' }, ...extra
}) + '\n';
const result = (id, isError, extra = {}) => JSON.stringify({
  isSidechain: false, type: 'user', uuid: 'u-' + (++uid), timestamp: '2026-01-02T03:00:01.000Z', cwd: CWD, sessionId: SID,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'invented result text', ...(isError === undefined ? {} : { is_error: isError }) }] }, ...extra
}) + '\n';
/** A record the reader passes over, to pad a file. */
const filler = n => JSON.stringify({ type: 'system', subtype: 'informational', timestamp: '2026-01-02T03:00:00.000Z', sessionId: SID, content: 'x'.repeat(Math.max(0, n - 100)) }) + '\n';

test('the first poll replays every call of the window in file order, marked replay, in the hook shape', t => {
  const file = path.join(tmp(t), SID + '.jsonl');
  fs.writeFileSync(file, lines('mixed.jsonl').join('\n') + '\n');
  const tail = createTail(file, { session: 'from-options', cwd: '/elsewhere' });
  const out = tail.poll();
  assert.deepEqual(brief(out), [
    'PreToolUse toolu_A1 Glob',
    'PreToolUse toolu_A2 Read',
    'PostToolUse toolu_A1 Glob',              // the api-request-blob copy is not counted
    'PostToolUseFailure toolu_A2 Read',       // the sidechain call is skipped
    'PreToolUse toolu_A3 Bash'                // still open: no end yet
  ]);
  assert.deepEqual(out[3], {
    hook_event_name: 'PostToolUseFailure', session_id: SID, cwd: CWD, tool_name: 'Read',
    tool_input: { file_path: '/home/dev/example-project/MISSING.md' }, tool_use_id: 'toolu_A2',
    _wy: { src: 'transcript', at: Date.parse('2026-01-02T03:04:05.000Z'), replay: true }
  });
  assert.deepEqual(out[4], {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: CWD, tool_name: 'Bash',
    tool_input: { command: 'npm test', description: 'Run the tests' }, tool_use_id: 'toolu_A3',
    _wy: { src: 'transcript', at: Date.parse('2026-01-02T03:04:06.000Z'), replay: true }
  });
  assert.ok(out.every(p => p._wy.replay === true));
  assert.ok(!JSON.stringify(out).includes('does not exist'), 'no result text in any payload');
  assert.equal(tail.skipped, 0);
  assert.equal(tail.left, 0);
  assert.equal(tail.open, 1);
  assert.deepEqual(tail.poll(), [], 'nothing new');
  append(file, result('toolu_A3', false));
  const later = tail.poll();
  assert.deepEqual(brief(later), ['PostToolUse toolu_A3 Bash']);
  assert.ok(!('replay' in later[0]._wy), 'a later poll has no replay key');
  assert.equal(tail.open, 0, 'a call is forgotten when its result arrives');
});

/** One call O opened first and never ended, ten closed calls C0..C9 (C9 failed), and an open call P at the end. */
function capFile(t) {
  const file = path.join(tmp(t), 'cap.jsonl');
  let text = use('toolu_O', 'Bash');
  for (let n = 0; n < 10; n++) text += use('toolu_C' + n, 'Read') + result('toolu_C' + n, n === 9);
  fs.writeFileSync(file, text + use('toolu_P', 'Write'));
  return file;
}

test('the first poll gives at most the last `replay` calls, plus any call still open, and counts the rest in left', t => {
  const file = capFile(t);
  const tail = createTail(file, { replay: 3 });
  const out = tail.poll();
  assert.deepEqual(brief(out), [
    'PreToolUse toolu_O Bash',                // beyond the cap, but still open: always given
    'PreToolUse toolu_C8 Read',
    'PostToolUse toolu_C8 Read',
    'PreToolUse toolu_C9 Read',
    'PostToolUseFailure toolu_C9 Read',
    'PreToolUse toolu_P Write'
  ]);
  assert.ok(out.every(p => p._wy.replay === true));
  assert.equal(tail.left, 8, 'C0..C7: neither start nor end given');
  assert.equal(tail.open, 2);
  append(file, result('toolu_O', false) + result('toolu_C3', false));
  assert.deepEqual(brief(tail.poll()), ['PostToolUse toolu_O Bash', 'PostToolUse toolu_C3 '],
    'later polls keep their rule: an end whose start was left out is given, unnamed');
});

test('replay: 0 gives only the calls still open (the old first poll)', t => {
  const tail = createTail(capFile(t), { replay: 0 });
  const out = tail.poll();
  assert.deepEqual(brief(out), ['PreToolUse toolu_O Bash', 'PreToolUse toolu_P Write']);
  assert.ok(out.every(p => p._wy.replay === true));
  assert.equal(tail.left, 10);
});

test('the default replay is 150 calls', t => {
  const file = path.join(tmp(t), 'many.jsonl');
  let text = '';
  for (let n = 0; n < 200; n++) text += use('toolu_' + n, 'Grep') + result('toolu_' + n, false);
  fs.writeFileSync(file, text);
  assert.ok(fs.statSync(file).size < 262144, 'the whole file is in the window');
  const tail = createTail(file, {});
  const out = tail.poll();
  assert.equal(out.length, 300);
  assert.equal(out[0].tool_use_id, 'toolu_50');
  assert.equal(tail.left, 50);
  assert.equal(tail.open, 0);
});

test('later polls give each start and end in order; the result content is never carried', t => {
  const file = path.join(tmp(t), 'a.jsonl');
  fs.writeFileSync(file, '');
  const tail = createTail(file, { session: SID, cwd: CWD });
  assert.deepEqual(tail.poll(), []);
  const got = [];
  for (const line of lines('mixed.jsonl')) { append(file, line + '\n'); got.push(...tail.poll()); }
  assert.deepEqual(brief(got), [
    'PreToolUse toolu_A1 Glob',
    'PreToolUse toolu_A2 Read',
    'PostToolUse toolu_A1 Glob',              // the api-request-blob copy of A1 is not counted
    'PostToolUseFailure toolu_A2 Read',       // the sidechain call S1 is skipped
    'PreToolUse toolu_A3 Bash'
  ]);
  const end = got[3];
  assert.deepEqual(end, {
    hook_event_name: 'PostToolUseFailure', session_id: SID, cwd: CWD, tool_name: 'Read',
    tool_input: { file_path: '/home/dev/example-project/MISSING.md' }, tool_use_id: 'toolu_A2',
    _wy: { src: 'transcript', at: Date.parse('2026-01-02T03:04:05.000Z') }
  });
  assert.ok(!JSON.stringify(got).includes('does not exist'), 'no result text in any payload');
  assert.ok(!JSON.stringify(got).includes('README.md'), 'no result text in any payload');
  assert.equal(tail.skipped, 0);
});

test('several tool_use blocks in one record, and several results in one record', t => {
  const file = path.join(tmp(t), 'p.jsonl');
  fs.writeFileSync(file, '');
  const tail = createTail(file, {});
  tail.poll();
  append(file, lines('one-record-parallel.jsonl').join('\n') + '\n');
  const out = tail.poll();
  assert.deepEqual(brief(out), [
    'PreToolUse toolu_P1 Grep',
    'PreToolUse toolu_P2 mcp__example__lookup',
    'PostToolUse toolu_P2 mcp__example__lookup',
    'PostToolUseFailure toolu_P1 Grep'
  ]);
  assert.equal(out[0].cwd, 'C:\\Work\\example-app');
  assert.equal(out[0].session_id, '99999999-8888-4777-8666-555555555555');
  assert.deepEqual(out[0].tool_input, { pattern: 'TODO', path: 'src' });
});

test('the first poll of a whole file: an open call with several blocks per record', t => {
  const file = path.join(tmp(t), 'p.jsonl');
  fs.writeFileSync(file, lines('one-record-parallel.jsonl')[0] + '\n');
  assert.deepEqual(brief(createTail(file, {}).poll()), ['PreToolUse toolu_P1 Grep', 'PreToolUse toolu_P2 mcp__example__lookup']);
});

test('a result whose start came before the lookback is still given, with tool_name "" and tool_input {}', t => {
  const file = path.join(tmp(t), 'a.jsonl');
  fs.writeFileSync(file, use('toolu_OLD', 'Edit', { file_path: 'a.txt' }) + filler(3000) + filler(3000));
  const tail = createTail(file, { lookback: 2000 });
  assert.deepEqual(tail.poll(), [], 'its start is outside the window, so it is not known');
  append(file, result('toolu_OLD', true));
  assert.deepEqual(tail.poll(), [{
    hook_event_name: 'PostToolUseFailure', session_id: SID, cwd: CWD, tool_name: '', tool_input: {},
    tool_use_id: 'toolu_OLD', _wy: { src: 'transcript', at: Date.parse('2026-01-02T03:00:01.000Z') }
  }]);
});

test('on the first poll the cut first line is thrown away, not counted; a window on a line boundary keeps its line', t => {
  const dir = tmp(t);
  const a = use('toolu_CUT', 'Read'), b = use('toolu_KEEP', 'Write');
  const cut = path.join(dir, 'cut.jsonl');
  fs.writeFileSync(cut, a + b);
  const t1 = createTail(cut, { lookback: b.length + 10 });   // starts inside `a`
  assert.deepEqual(brief(t1.poll()), ['PreToolUse toolu_KEEP Write']);
  assert.equal(t1.skipped, 0);
  const exact = path.join(dir, 'exact.jsonl');
  fs.writeFileSync(exact, a + b);
  const t2 = createTail(exact, { lookback: b.length });       // starts exactly at `b`
  assert.deepEqual(brief(t2.poll()), ['PreToolUse toolu_KEEP Write']);
  const whole = path.join(dir, 'whole.jsonl');
  fs.writeFileSync(whole, a + b);
  const t3 = createTail(whole, { lookback: a.length + b.length });
  assert.deepEqual(brief(t3.poll()), ['PreToolUse toolu_CUT Read', 'PreToolUse toolu_KEEP Write']);
});

test('a partial last line waits for the rest; CRLF endings are read too', t => {
  const file = path.join(tmp(t), 'a.jsonl');
  fs.writeFileSync(file, '');
  const tail = createTail(file, {});
  tail.poll();
  const line = use('toolu_HALF', 'Grep', { pattern: 'x' });
  append(file, line.slice(0, 40));
  assert.deepEqual(tail.poll(), []);
  append(file, line.slice(40, -1));
  assert.deepEqual(tail.poll(), [], 'still no newline');
  append(file, '\r\n');
  assert.deepEqual(brief(tail.poll()), ['PreToolUse toolu_HALF Grep']);
  assert.equal(tail.skipped, 0);
});

test('a multi-byte character cut between two appends survives', t => {
  const file = path.join(tmp(t), 'a.jsonl');
  fs.writeFileSync(file, '');
  const tail = createTail(file, {});
  tail.poll();
  const text = 'caf\u00e9 \u2014 \u{1F600} done';
  const bytes = Buffer.from(use('toolu_UTF', 'Write', { content: text }), 'utf8');
  const emoji = bytes.indexOf(Buffer.from('\u{1F600}', 'utf8'));
  assert.ok(emoji > 0);
  fs.appendFileSync(file, bytes.subarray(0, emoji + 2));          // two of the emoji's four bytes
  assert.deepEqual(tail.poll(), []);
  fs.appendFileSync(file, bytes.subarray(emoji + 2));
  const out = tail.poll();
  assert.equal(out.length, 1);
  assert.equal(out[0].tool_input.content, text);
});

test('a file that shrank is read again from its end', t => {
  const file = path.join(tmp(t), 'a.jsonl');
  fs.writeFileSync(file, filler(400) + filler(400) + use('toolu_1', 'Read'));
  const tail = createTail(file, {});
  assert.deepEqual(brief(tail.poll()), ['PreToolUse toolu_1 Read']);
  fs.writeFileSync(file, use('toolu_2', 'Glob') + use('toolu_3', 'Grep') + result('toolu_2', false));
  assert.ok(fs.statSync(file).size < 1000);
  const again = tail.poll();
  assert.deepEqual(brief(again), ['PreToolUse toolu_2 Glob', 'PreToolUse toolu_3 Grep', 'PostToolUse toolu_2 Glob'], 'the new content is replayed');
  assert.ok(again.every(p => p._wy.replay === true));
  append(file, result('toolu_3', false));
  assert.deepEqual(brief(tail.poll()), ['PostToolUse toolu_3 Grep']);
});

test('a missing file gives nothing until it appears', t => {
  const file = path.join(tmp(t), 'later.jsonl');
  const tail = createTail(file, { session: SID, cwd: CWD });
  assert.deepEqual(tail.poll(), []);
  assert.deepEqual(tail.poll(), []);
  fs.writeFileSync(file, use('toolu_1', 'Read') + result('toolu_1', false) + use('toolu_2', 'Bash'));
  assert.deepEqual(brief(tail.poll()), ['PreToolUse toolu_1 Read', 'PostToolUse toolu_1 Read', 'PreToolUse toolu_2 Bash']);
  fs.rmSync(file);
  assert.deepEqual(tail.poll(), [], 'gone again: no throw');
});

test('subagent records are skipped, even when their ids match', t => {
  const file = path.join(tmp(t), 'a.jsonl');
  fs.writeFileSync(file, '');
  const tail = createTail(file, {});
  tail.poll();
  append(file, use('toolu_S', 'Bash', {}, { isSidechain: true }) + use('toolu_M', 'Read') + result('toolu_M', false, { isSidechain: true }));
  assert.deepEqual(brief(tail.poll()), ['PreToolUse toolu_M Read']);
  assert.equal(tail.open, 1);
});

test('an unparseable line is skipped and counted; the lines around it are read', t => {
  const file = path.join(tmp(t), 'a.jsonl');
  fs.writeFileSync(file, '');
  const tail = createTail(file, {});
  tail.poll();
  append(file, use('toolu_1', 'Read') + '{"type":"assistant","message":{"content":[\n' + '\n' + 'not json\n' + result('toolu_1', false));
  assert.deepEqual(brief(tail.poll()), ['PreToolUse toolu_1 Read', 'PostToolUse toolu_1 Read']);
  assert.equal(tail.skipped, 2, 'two bad lines; the blank line is not counted');
});

test('session_id and cwd come from the record, else from the options; at is absent without a timestamp', t => {
  const file = path.join(tmp(t), 'a.jsonl');
  fs.writeFileSync(file, '');
  const tail = createTail(file, { session: 'opt-session', cwd: '/opt/folder' });
  tail.poll();
  append(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: 'not an object' }] } }) + '\n');
  assert.deepEqual(tail.poll(), [{
    hook_event_name: 'PreToolUse', session_id: 'opt-session', cwd: '/opt/folder', tool_name: 'Read', tool_input: {},
    tool_use_id: 'toolu_1', _wy: { src: 'transcript' }
  }]);
});

test('more than 4 MB appended at once: a jump to the end, read like a first poll', t => {
  const file = path.join(tmp(t), 'a.jsonl');
  fs.writeFileSync(file, use('toolu_BEFORE', 'Bash') + use('toolu_LOST', 'Read'));
  const tail = createTail(file, {});
  assert.deepEqual(brief(tail.poll()), ['PreToolUse toolu_BEFORE Bash', 'PreToolUse toolu_LOST Read']);
  const block = filler(64 * 1024);
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, result('toolu_LOST', false));            // its end falls in the part that is jumped over
    for (let n = 0; n < 80; n++) fs.writeSync(fd, block);     // 5 MB of records the reader passes over
    fs.writeSync(fd, use('toolu_CLOSED', 'Glob') + result('toolu_CLOSED', false) + result('toolu_BEFORE', true) + use('toolu_OPEN', 'Write'));
  } finally { fs.closeSync(fd); }
  assert.ok(fs.statSync(file).size > READ_CAP + 1024 * 1024);
  const out = tail.poll();
  assert.equal(tail.jumps, 1);
  assert.deepEqual(brief(out), ['PreToolUse toolu_CLOSED Glob', 'PostToolUse toolu_CLOSED Glob', 'PostToolUseFailure toolu_BEFORE Bash', 'PreToolUse toolu_OPEN Write'],
    'the window is replayed, and a call open from before that ends in it is ended');
  assert.ok(out.every(p => p._wy.replay === true));
  assert.equal(tail.skipped, 0, 'the cut line at the window start is not counted');
  append(file, result('toolu_OPEN', false));
  const later = tail.poll();
  assert.deepEqual(brief(later), ['PostToolUse toolu_OPEN Write']);
  assert.ok(!('replay' in later[0]._wy));
});

test('at most 500 open calls are remembered; the oldest goes first', t => {
  const file = path.join(tmp(t), 'a.jsonl');
  fs.writeFileSync(file, '');
  const tail = createTail(file, {});
  tail.poll();
  let text = '';
  for (let n = 0; n <= MAX_OPEN; n++) text += use('toolu_' + n, 'Read');
  append(file, text);
  assert.equal(tail.poll().length, MAX_OPEN + 1);
  assert.equal(tail.open, MAX_OPEN);
  append(file, result('toolu_0', false) + result('toolu_1', false) + result('toolu_' + MAX_OPEN, false));
  assert.deepEqual(brief(tail.poll()), ['PostToolUse toolu_0 ', 'PostToolUse toolu_1 Read', 'PostToolUse toolu_500 Read']);
  assert.equal(tail.open, MAX_OPEN - 2);
});

test('a poll with nothing new does not open the file, and every open is closed again', t => {
  const file = path.join(tmp(t), 'a.jsonl');
  fs.writeFileSync(file, use('toolu_1', 'Read'));
  const tail = createTail(file, {});
  const real = { open: fs.openSync, close: fs.closeSync };
  let opens = 0, closes = 0;
  fs.openSync = (...a) => { opens++; return real.open(...a); };
  fs.closeSync = (...a) => { closes++; return real.close(...a); };
  try {
    tail.poll();
    assert.equal(opens, 1);
    for (let n = 0; n < 5; n++) tail.poll();
    assert.equal(opens, 1, 'size unchanged: no read');
    append(file, result('toolu_1', false));
    tail.poll();
    assert.equal(opens, 2);
    assert.equal(closes, opens);
  } finally { fs.openSync = real.open; fs.closeSync = real.close; }
  fs.renameSync(file, file + '.moved');                          // nothing holds the file between polls
});

test('a read that fails does not throw and is tried again', t => {
  const file = path.join(tmp(t), 'a.jsonl');
  fs.writeFileSync(file, use('toolu_1', 'Read'));
  const tail = createTail(file, {});
  const real = fs.openSync;
  fs.openSync = () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; };
  try { assert.deepEqual(tail.poll(), []); } finally { fs.openSync = real; }
  assert.deepEqual(brief(tail.poll()), ['PreToolUse toolu_1 Read']);
});

test('close() frees what is held; a poll after it gives nothing', t => {
  const file = path.join(tmp(t), 'a.jsonl');
  fs.writeFileSync(file, use('toolu_1', 'Read'));
  const tail = createTail(file, {});
  tail.poll();
  assert.equal(tail.open, 1);
  tail.close();
  assert.equal(tail.open, 0);
  append(file, result('toolu_1', false));
  assert.deepEqual(tail.poll(), []);
});
