// Thinking in Codex, Grok Build and Antigravity session records: the reasoning text, read through lib/thinking.js's own
// steps, and nothing else of the record. Every file is a temporary one the test writes; every id, text, time and path in
// it is invented, and the shapes are those written down in lib/thinking-formats.js, not copies of any real session.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readThinking, LIMITS } = require('../lib/thinking.js');
const { FORMATS, READERS, codexItems, grokItems, antigravityItems } = require('../lib/thinking-formats.js');

const SID = '11111111-2222-4333-8444-555555555555';
const T0 = Date.parse('2026-01-02T03:00:00.000Z');
const ms = n => T0 + n * 1000;
const iso = n => new Date(ms(n)).toISOString();
const ANSWER_KEYS = ['ok', 'size', 'mtimeMs', 'whole', 'thoughts', 'recorded', 'unrecorded', 'more'];

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wytf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** A file of `text` in a new temporary folder. */
function write(t, text, name = 'session.jsonl') {
  const file = path.join(tmp(t), name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
/** Swap fs.promises[name] for this test only; `make` gets the real one. */
function wrap(t, name, make) {
  const real = fs.promises[name];
  fs.promises[name] = make(real);
  t.after(() => { fs.promises[name] = real; });
}
/** Counts every stat and open from here to the end of the test. */
function countDisk(t) {
  const n = { stat: 0, open: 0 };
  wrap(t, 'stat', real => (...a) => { n.stat++; return real(...a); });
  wrap(t, 'open', real => (...a) => { n.open++; return real(...a); });
  return n;
}
const texts = answer => answer.thoughts.map(x => x.text);
const counts = answer => ({ recorded: answer.recorded, unrecorded: answer.unrecorded, more: answer.more });
const ZERO = { recorded: 0, unrecorded: 0, more: 0 };
const line = value => JSON.stringify(value) + '\n';
let uid = 0;

/* ---------- Codex: a rollout file ---------- */

/** A Codex reasoning record: one summary_text entry per text, or `summary` as given. */
function cxThought(list, { id = 'rs_INVENTED' + (++uid), at = iso(0), summary, ...extra } = {}) {
  return line({ timestamp: at, type: 'response_item', payload: {
    type: 'reasoning', id, summary: summary !== undefined ? summary : [].concat(list).map(text => ({ type: 'summary_text', text })),
    content: null, encrypted_content: 'ZW5jcnlwdGVkLWludmVudGVk' + (++uid), ...extra } });
}
/** Codex's second copy of a reasoning record. Its raw_content entry holds the word "reasoning", so the line passes the cheap filter and only the record test keeps it out. */
function cxTwin(list, { id, at = iso(0), raw = 'Invented raw reasoning of the twin.' } = {}) {
  return line({ timestamp: at, type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thr_INVENTED', turn_id: 'turn_INVENTED',
    item: { type: 'Reasoning', id, summary_text: [].concat(list), raw_content: [{ type: 'reasoning', text: raw }] } } });
}
/** A record that is not reasoning. Each holds an invented `note: "reasoning"`, so it too passes the cheap filter. */
const cxItem = (payload, at = iso(0)) => line({ timestamp: at, type: 'response_item', note: 'reasoning', payload });
const cxSaid = (role, text) => cxItem({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
const cxCall = (callId, command) => cxItem({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', command] }), call_id: callId });
const cxOutput = (callId, output) => cxItem({ type: 'function_call_output', call_id: callId, output });

/* ---------- Grok Build: updates.jsonl ---------- */

function gkLine(update, at = ms(0), updateType = 'AgentThoughtChunk') {
  return line({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SID, update, _meta: { updateType, promptId: 'prompt-INVENTED', agentTimestampMs: at } } });
}
const gkThought = (text, at) => gkLine({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }, at);
/** An answer or a prompt; the tests' texts name agent_thought_chunk, so the line passes the cheap filter. */
const gkSaid = (kind, text, at) => gkLine({ sessionUpdate: kind, content: { type: 'text', text } }, at, kind === 'agent_message_chunk' ? 'AgentMessageChunk' : 'UserMessageChunk');
const gkCall = (id, rawInput, at) => gkLine({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Run an invented command', kind: 'execute', status: 'pending', rawInput }, at, 'ToolCall');
const gkDone = (id, output, at) => gkLine({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', rawOutput: { output },
  content: [{ type: 'content', content: { type: 'text', text: output } }] }, at, 'ToolCallUpdate');

/* ---------- Antigravity: transcript_full.jsonl ---------- */

function agStep(type, fields = {}, { step = ++uid, at = iso(0) } = {}) {
  return line({ step_index: step, type, status: 'DONE', source: 'MODEL', created_at: at, ...fields });
}
const agThought = (text, { step, at, ...extra } = {}) =>
  agStep('PLANNER_RESPONSE', { model: 'example-model', content: 'An invented answer.', thinking: text, tool_calls: [], input_tokens: 10, ...extra }, { step, at });

/* ---------- the same questions of each format ---------- */

/** For each format: a thought at second n, a call that reasoned with no text, records that are not reasoning, and one very big record. */
const KITS = {
  codex: {
    tells: true,
    thought: (text, n) => cxThought([text], { at: iso(n) }),
    blank: n => cxThought([], { at: iso(n) }),
    noise: () => cxSaid('developer', 'Invented developer instructions.') + cxSaid('user', 'An invented question.') +
      cxCall('call_N' + (++uid), 'ls -la') + cxOutput('call_N' + uid, 'an invented listing') + cxSaid('assistant', 'An invented answer.'),
    big: text => cxOutput('call_BIG', text)
  },
  grok: {
    tells: false,
    thought: (text, n) => gkThought(text, ms(n)),
    blank: n => gkThought('', ms(n)),
    noise: () => gkSaid('user_message_chunk', 'An invented question about agent_thought_chunk.', ms(0)) +
      gkCall('tool-N' + (++uid), { command: 'grep -r agent_thought_chunk src' }, ms(0)) + gkDone('tool-N' + uid, 'agent_thought_chunk: 2 matches', ms(0)) +
      gkSaid('agent_message_chunk', 'An invented answer about agent_thought_chunk.', ms(0)),
    big: text => gkDone('tool-BIG', 'agent_thought_chunk ' + text, ms(0))
  },
  antigravity: {
    tells: false,
    thought: (text, n) => agThought(text, { at: iso(n) }),
    blank: n => agThought('', { at: iso(n) }),
    noise: () => agStep('USER_INPUT', { content: 'An invented question.', thinking: 'A thinking key on a user step.' }) +
      agStep('RUN_COMMAND', { content: 'An invented result.', thinking: 'A thinking key on a tool step.' }),
    big: text => agStep('RUN_COMMAND', { content: text, thinking: 'A thinking key on a tool step.' })
  }
};

for (const [format, kit] of Object.entries(KITS)) {
  test(format + ': recorded reasoning comes back newest first, with its time, and the counts are right', async t => {
    const file = write(t, kit.noise() + kit.thought('First invented thought.', 1) + kit.blank(2) + kit.noise() +
      kit.thought('Second invented thought.', 3) + kit.thought('Third invented thought, the newest.', 4));
    const st = fs.statSync(file);
    assert.deepEqual(await readThinking(file, { format }), {
      ok: true, size: st.size, mtimeMs: st.mtimeMs, whole: true,
      thoughts: [
        { at: ms(4), text: 'Third invented thought, the newest.' },
        { at: ms(3), text: 'Second invented thought.' },
        { at: ms(1), text: 'First invented thought.' }
      ],
      recorded: 3, unrecorded: kit.tells ? 1 : 0, more: 0
    });
    const two = await readThinking(file, { format, thoughts: 2 });
    assert.deepEqual([texts(two), two.recorded, two.more, two.whole], [['Third invented thought, the newest.', 'Second invented thought.'], 3, 1, true]);
  });

  test(format + ': nothing at all is ok with every count zero, an empty file too; a missing file and a folder give their reasons', async t => {
    const got = await readThinking(write(t, kit.noise() + kit.noise()), { format });
    assert.deepEqual([got.ok, got.whole, got.thoughts, counts(got)], [true, true, [], ZERO]);
    const empty = await readThinking(write(t, '', 'empty.jsonl'), { format });
    assert.deepEqual(empty, { ok: true, size: 0, mtimeMs: empty.mtimeMs, whole: true, thoughts: [], ...ZERO });
    const dir = tmp(t);
    assert.deepEqual(await readThinking(path.join(dir, 'absent.jsonl'), { format }), { ok: false, why: 'missing' });
    assert.deepEqual(await readThinking(dir, { format }), { ok: false, why: 'not-a-file' });
  });

  test(format + ': the same line twice counts once', async t => {
    const once = kit.thought('Written twice.', 1);
    const got = await readThinking(write(t, once + once + kit.thought('Written once.', 2) + once), { format });
    assert.deepEqual(texts(got), ['Written once.', 'Written twice.']);
    assert.deepEqual(counts(got), { recorded: 2, unrecorded: 0, more: 0 });
    if (kit.tells) {
      const blank = kit.blank(3);
      assert.equal((await readThinking(write(t, blank + blank, 'blank.jsonl'), { format })).unrecorded, 1, 'a blank one too');
    }
  });

  test(format + ': cleaning, the cut and the limits are those of a Claude transcript, by the same code', async t => {
    const raw = [
      'Thought 1.', 'Thought 2.', '  \r\n\t First line\r\nsecond\u0000line\rthird\u001b[1m\u2028after\u007f\u0085x\n\n\n\nfive newlines\ta tab  ',
      'x'.repeat(LIMITS.thought + 50), 'Thought 3.', 'Thought 4.'
    ];
    const claude = n => line({ parentUuid: null, isSidechain: false, type: 'assistant', uuid: 'a-' + (++uid), timestamp: iso(n),
      message: { id: 'msg_' + (++uid), role: 'assistant', content: [{ type: 'thinking', thinking: raw[n], signature: 'c2ln' + (++uid) }] } });
    const claudeFile = write(t, raw.map((_, n) => claude(n)).join(''), 'claude.jsonl');
    const file = write(t, raw.map((x, n) => kit.thought(x, n)).join(''), format + '.jsonl');
    const pick = a => ({ whole: a.whole, thoughts: a.thoughts, recorded: a.recorded, unrecorded: a.unrecorded, more: a.more });
    for (const opts of [{}, { thoughts: 2 }, { chars: 25 }, { chars: 30 }, { thought: 10 }, { chars: 40, thought: 8 }, { chars: 1 }, { thoughts: 1.5 }]) {
      assert.deepEqual(pick(await readThinking(file, { ...opts, format })), pick(await readThinking(claudeFile, opts)), JSON.stringify(opts));
    }
    const got = await readThinking(file, { format });
    assert.equal(got.thoughts[2].text.length, LIMITS.thought);
    assert.ok(got.thoughts[2].text.endsWith('…'));
    assert.equal(got.thoughts[2].cut, true);
    assert.equal(got.thoughts[3].text, 'First line\nsecond line\nthird [1m after  x\n\nfive newlines\ta tab');
    assert.ok(!('cut' in got.thoughts[3]));
  });

  test(format + ': the tail: a window past byte 0 is not whole, and a line longer than the whole window does no harm', async t => {
    const lookback = 4096;
    const a = kit.thought('Older, before the long line.', 1);
    const hidden = kit.thought('Hidden at the end of the long line.', 2);
    const long = 'x'.repeat(4 * lookback) + hidden;            // one line four windows long that ends in a whole record
    const b = kit.thought('After the long line.', 3);
    assert.ok(Buffer.byteLength(hidden + b) < lookback, 'the record that ends the long line lies inside the window');
    const file = write(t, a + long + b);
    const got = await readThinking(file, { format, lookback });
    assert.deepEqual([got.ok, got.whole, got.size, texts(got), counts(got)],
      [true, false, fs.statSync(file).size, ['After the long line.'], { recorded: 1, unrecorded: 0, more: 0 }]);
    const all = await readThinking(file, { format });
    assert.deepEqual([all.whole, texts(all)], [true, ['After the long line.', 'Older, before the long line.']], 'read whole, the long line is not a record');
    // A real record of the format, holding its mark, longer than the window and the last line: the window lies inside it.
    const big = kit.big('z'.repeat(4 * lookback));
    for (const [name, text] of [['last.jsonl', a + big], ['still-written.jsonl', a + big.slice(0, -1)]]) {
      const inside = await readThinking(write(t, text, name), { format, lookback });
      assert.deepEqual([inside.ok, inside.whole, inside.thoughts, counts(inside)], [true, false, [], ZERO], name);
    }
    // The last line with no newline yet: read when it is complete, passed over when it is half a record. CRLF lines are read.
    assert.deepEqual(texts(await readThinking(write(t, a + b.slice(0, -1), 'whole.jsonl'), { format })), ['After the long line.', 'Older, before the long line.']);
    assert.deepEqual(texts(await readThinking(write(t, a + b.slice(0, Math.floor(b.length / 2)), 'half.jsonl'), { format })), ['Older, before the long line.']);
    assert.deepEqual(texts(await readThinking(write(t, (a + b).replace(/\n/g, '\r\n'), 'crlf.jsonl'), { format })), ['After the long line.', 'Older, before the long line.']);
  });

  test(format + ': a file that grew while its modification time was set back is read in full by the next call', async t => {
    const file = write(t, kit.thought('Before it grew.', 1));
    const first = await readThinking(file, { format });
    assert.deepEqual(texts(first), ['Before it grew.']);
    fs.appendFileSync(file, kit.thought('Appended while the time stayed.', 2));
    fs.utimesSync(file, first.mtimeMs / 1000, first.mtimeMs / 1000);
    const st = fs.statSync(file);
    assert.ok(Math.abs(st.mtimeMs - first.mtimeMs) < 1, 'the time is what it was');
    assert.ok(st.size > first.size, 'the size grew');
    const second = await readThinking(file, { format });
    assert.deepEqual([second.size, second.mtimeMs, texts(second)], [st.size, st.mtimeMs, ['Appended while the time stayed.', 'Before it grew.']]);
  });
}

/* ---------- Codex ---------- */

test('codex: reasoning records that all have no summary text give no thoughts, recorded 0, and unrecorded counts each', async t => {
  const file = write(t, cxSaid('user', 'An invented question.') +
    cxThought([]) + cxThought([]) + cxThought(['   ', '\n\t\r\n']) + cxThought(['\u0000\u001b\u2028']) +
    cxThought(null, { summary: [{ type: 'summary_text' }] }) + cxSaid('assistant', 'An invented answer.'));
  const got = await readThinking(file, { format: 'codex' });
  assert.deepEqual({ ...got, size: 0, mtimeMs: 0 }, { ok: true, size: 0, mtimeMs: 0, whole: true, thoughts: [], recorded: 0, unrecorded: 5, more: 0 });
});

test('codex: only a response_item reasoning record is read; its event_msg twin and other records holding a reasoning payload are not', async t => {
  const id = 'rs_INVENTED_TWINNED';
  const file = write(t,
    cxThought(['The reasoning, read once.'], { id, at: iso(1) }) +
    cxTwin(['The reasoning, read once.'], { id, at: iso(1), raw: 'Raw reasoning of the twin.' }) +
    cxTwin(['A summary only a twin holds.'], { id: 'rs_INVENTED_TWIN_ONLY', at: iso(2) }) +
    line({ timestamp: iso(3), type: 'event_msg', payload: { type: 'reasoning', id: 'rs_INVENTED_EVENT', summary: [{ type: 'summary_text', text: 'A reasoning payload under event_msg.' }] } }) +
    line({ timestamp: iso(4), type: 'turn_context', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'A reasoning payload under turn_context.' }] } }) +
    cxItem({ type: 'message', role: 'assistant', summary: [{ type: 'summary_text', text: 'A summary key on an answer.' }], content: [{ type: 'output_text', text: 'An invented answer.' }] }) +
    line({ timestamp: iso(5), type: 'response_item', payload: { type: 'Reasoning', note: 'reasoning', summary: [{ type: 'summary_text', text: 'A payload type in the wrong case.' }] } }) +
    line([{ type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'A line that is an array.' }] } }]) +
    'null\n' + '"reasoning"\n' + '{"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"half\n');
  const got = await readThinking(file, { format: 'codex' });
  assert.deepEqual(texts(got), ['The reasoning, read once.']);
  assert.deepEqual(counts(got), { recorded: 1, unrecorded: 0, more: 0 }, 'a record and its twin count once');
  const json = JSON.stringify(got);
  for (const never of ['Raw reasoning', 'raw_content', 'ZW5jcnlwdGVk', 'encrypted', 'twin', 'event_msg']) assert.ok(!json.includes(never), never);
});

test('codex: a record is counted once by its payload.id, else by its text', async t => {
  const twice = cxThought(['Written twice.'], { id: 'rs_D1', at: iso(1) });
  const file = write(t, twice + twice +
    cxThought(['Written twice.'], { id: 'rs_D1', at: iso(9) }) +             // written again later, its own time
    cxThought(['Other text, same id.'], { id: 'rs_D1', at: iso(10) }) +
    cxThought(['Same text, its own id.'], { id: 'rs_D2', at: iso(2) }) + cxThought(['Same text, its own id.'], { id: 'rs_D3', at: iso(3) }) +
    cxThought(['No id.'], { id: null, at: iso(4) }) + cxThought(['No id.'], { id: '', at: iso(5) }) + cxThought(['No id, other text.'], { id: 42, at: iso(6) }) +
    cxThought([], { id: 'rs_D4' }) + cxThought([], { id: 'rs_D4' }) + cxThought([], { id: 'rs_D5' }));
  const got = await readThinking(file, { format: 'codex' });
  assert.deepEqual(texts(got), ['No id, other text.', 'No id.', 'Same text, its own id.', 'Same text, its own id.', 'Written twice.']);
  assert.deepEqual(counts(got), { recorded: 5, unrecorded: 2, more: 0 }, 'D4 once and D5');
  assert.equal(got.thoughts[4].at, ms(1), 'counted where it first appears');
});

test('codex: summary entries are joined with a blank line; a summary that is not an array, or holds no text, is unrecorded and throws nothing', async t => {
  const joined = await readThinking(write(t,
    cxThought(['Part one.', 'Part two.', 'Part three.'], { at: iso(1) }) +
    cxThought(['Before a blank entry.', '   ', '', 'After it.'], { at: iso(2) }) +
    cxThought(['Ends with newlines.\n\n\n', 'Next entry.'], { at: iso(3) })), { format: 'codex' });
  assert.deepEqual(texts(joined), ['Ends with newlines.\n\nNext entry.', 'Before a blank entry.\n\nAfter it.', 'Part one.\n\nPart two.\n\nPart three.']);
  const odd = [
    'A summary that is text.', { type: 'summary_text', text: 'An object, not an array.' }, null, 42,
    [null, 42, 'a bare string', ['nested'], { type: 'summary_text', text: 7 }, { type: 'summary_text', text: null }, { type: 'summary_text' }]
  ];
  const file = write(t, odd.map(summary => cxThought(null, { summary })).join('') +
    line({ timestamp: iso(0), type: 'response_item', payload: { type: 'reasoning', id: 'rs_NO_SUMMARY' } }) +
    line({ timestamp: iso(0), type: 'response_item', payload: 'reasoning' }) +
    line({ timestamp: iso(0), type: 'response_item', payload: null, note: 'reasoning' }), 'odd.jsonl');
  const got = await readThinking(file, { format: 'codex' });
  assert.deepEqual([got.ok, got.thoughts, counts(got)], [true, [], { recorded: 0, unrecorded: 6, more: 0 }]);
});

test('codex: at is the record time: ISO 8601 text, else null', async t => {
  const got = await readThinking(write(t,
    cxThought(['ISO time.'], { at: '2026-01-02T03:04:05.678Z' }) +
    line({ type: 'response_item', payload: { type: 'reasoning', id: 'rs_NO_TIME', summary: [{ type: 'summary_text', text: 'No timestamp key.' }] } }) +
    cxThought(['Null time.'], { at: null }) + cxThought(['Text that is not a time.'], { at: 'yesterday-ish' }) +
    cxThought(['An object time.'], { at: { when: 1 } }) + cxThought(['A boolean time.'], { at: true })), { format: 'codex' });
  assert.deepEqual(got.thoughts.map(x => x.at), [null, null, null, null, null, Date.parse('2026-01-02T03:04:05.678Z')]);
});

test('codex privacy: the answer holds the reasoning text, its time and counts, and nothing else of the rollout', async t => {
  const C = {
    reasoning: 'CANARY-REASONING-c0d1', session: 'CANARY-SESSION-c0d2', cwd: '/home/dev/CANARY-CWD-c0d3', developer: 'CANARY-DEVELOPER-c0d4',
    prompt: 'CANARY-PROMPT-c0d5', answer: 'CANARY-ANSWER-c0d6', command: 'CANARY-COMMAND-c0d7', filePath: '/home/dev/CANARY-FILE-PATH-c0d8/notes.txt',
    output: 'CANARY-OUTPUT-c0d9', id: 'rs_CANARY-ID-c0da', callId: 'call_CANARY-CALL-c0db', encrypted: 'Q0FOQVJZLUVOQ1JZUFRFRC1jMGRj',
    raw: 'CANARY-RAW-CONTENT-c0dd', content: 'CANARY-REASONING-CONTENT-c0de', model: 'CANARY-MODEL-c0df'
  };
  const dir = tmp(t);
  const file = path.join(dir, 'rollout-2026-01-02T03-00-00-' + C.session + '.jsonl');
  fs.writeFileSync(file,
    line({ timestamp: iso(0), type: 'session_meta', note: 'reasoning', payload: { id: C.session, cwd: C.cwd, originator: 'invented', cli_version: '0.0.0' } }) +
    line({ timestamp: iso(0), type: 'turn_context', note: 'reasoning', payload: { cwd: C.cwd, model: C.model } }) +
    cxSaid('developer', C.developer) + cxSaid('user', C.prompt) +
    line({ timestamp: iso(1), type: 'response_item', payload: { type: 'reasoning', id: C.id,
      summary: [{ type: 'summary_text', text: 'An invented summary, ' + C.reasoning + '.' }], content: [{ type: 'reasoning_text', text: C.content }], encrypted_content: C.encrypted } }) +
    cxTwin(['An invented summary, ' + C.reasoning + '.'], { id: C.id, at: iso(1), raw: C.raw }) +
    cxCall(C.callId, C.command + ' --file ' + C.filePath) + cxOutput(C.callId, C.output) + cxSaid('assistant', C.answer) +
    line({ timestamp: iso(2), type: 'response_item', payload: { type: 'reasoning', id: 'rs_INVENTED_EMPTY', summary: [], encrypted_content: C.encrypted } }));
  const got = await readThinking(file, { format: 'codex' });
  assertOnly(got, C, dir, file);
  assert.deepEqual([texts(got), got.thoughts[0].at, counts(got)], [['An invented summary, ' + C.reasoning + '.'], ms(1), { recorded: 1, unrecorded: 1, more: 0 }]);
});

/* ---------- Grok Build ---------- */

test('grok: a chunk with blank text is passed over and not counted: unrecorded is always 0', async t => {
  const got = await readThinking(write(t, gkThought('', ms(1)) + gkThought('   \n\t ', ms(2)) + gkThought('\u0000\u2029', ms(3)) + KITS.grok.noise()), { format: 'grok' });
  assert.deepEqual([got.ok, got.whole, got.thoughts, counts(got)], [true, true, [], ZERO]);
});

test('grok: only agent_thought_chunk is read; answers, prompts, tool calls and their results are not', async t => {
  const file = write(t,
    gkSaid('user_message_chunk', 'An invented prompt that names agent_thought_chunk.', ms(1)) +
    gkThought('The only thought.', ms(2)) +
    gkSaid('agent_message_chunk', 'An invented answer about agent_thought_chunk.', ms(3)) +
    gkCall('tool-1', { command: 'grep -r agent_thought_chunk src' }, ms(4)) +
    gkDone('tool-1', 'agent_thought_chunk: 2 matches', ms(5)) +
    line({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SID, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'An answer marked as a thought in _meta.' } },
      _meta: { updateType: 'AgentThoughtChunk', note: 'agent_thought_chunk', agentTimestampMs: ms(6) } } }) +
    line({ jsonrpc: '2.0', method: 'session/update', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Not under params.' } } }) +
    line({ jsonrpc: '2.0', id: 7, method: 'session/prompt', params: { sessionId: SID, prompt: [{ type: 'text', text: 'A prompt request naming agent_thought_chunk.' }] } }) +
    line([{ params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'A line that is an array.' } } } }]) +
    'null\n' + '"agent_thought_chunk"\n' + '{"params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"half\n');
  const got = await readThinking(file, { format: 'grok' });
  assert.deepEqual(texts(got), ['The only thought.']);
  assert.deepEqual(counts(got), { recorded: 1, unrecorded: 0, more: 0 });
});

test('grok: a thought is counted once by its time and text', async t => {
  const twice = gkThought('Written twice.', ms(1));
  const again = line({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SID, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Written twice.' } },
    _meta: { updateType: 'AgentThoughtChunk', promptId: 'prompt-OTHER', agentTimestampMs: ms(1) } } });
  const got = await readThinking(write(t, twice + twice + again + gkThought('Written twice.', ms(2)) + gkThought('Same time, other text.', ms(1))), { format: 'grok' });
  assert.deepEqual(texts(got), ['Same time, other text.', 'Written twice.', 'Written twice.']);
  assert.deepEqual(got.thoughts.map(x => x.at), [ms(1), ms(2), ms(1)]);
  assert.deepEqual(counts(got), { recorded: 3, unrecorded: 0, more: 0 });
});

test('grok: content that is not an object, or text that is not a string, is passed over and throws nothing', async t => {
  const bad = [
    { content: 'A content that is text.' }, { content: null }, { content: ['An array.'] }, { content: 42 },
    { content: { type: 'text', text: 42 } }, { content: { type: 'text', text: null } }, { content: { type: 'text', text: { nested: 'An object.' } } },
    { content: { type: 'text', text: ['An array.'] } }, { content: { type: 'text' } }, {}
  ];
  const file = write(t, bad.map(u => gkLine({ sessionUpdate: 'agent_thought_chunk', ...u }, ms(1))).join('') +
    gkThought('The one with text.', ms(2)) +
    line({ jsonrpc: '2.0', method: 'session/update', params: null, note: 'agent_thought_chunk' }) +
    line({ params: { update: null }, note: 'agent_thought_chunk' }) + line({ params: { update: 'agent_thought_chunk' } }) +
    line({ params: ['agent_thought_chunk'] }) + line({ params: { update: { sessionUpdate: ['agent_thought_chunk'], content: { type: 'text', text: 'An array kind.' } } } }));
  const got = await readThinking(file, { format: 'grok' });
  assert.deepEqual([got.ok, texts(got), counts(got)], [true, ['The one with text.'], { recorded: 1, unrecorded: 0, more: 0 }]);
});

test('grok: at is params._meta.agentTimestampMs when it is a finite number, else null', async t => {
  const chunk = text => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
  const got = await readThinking(write(t,
    gkThought('Number time.', 1767323045678) +
    gkThought('ISO text is not this format\'s time.', '2026-01-02T03:04:05.678Z') +
    gkThought('Null time.', null) +
    line({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SID, update: chunk('No _meta.') } }) +
    line({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SID, update: chunk('A _meta that is null.'), _meta: null } }) +
    line({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SID, update: chunk('A time in the record, not in _meta.'), agentTimestampMs: 5 } }) +
    '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"A time too big."}},"_meta":{"agentTimestampMs":1e400}}}\n'),
  { format: 'grok' });
  assert.deepEqual(got.thoughts.map(x => x.at), [null, null, null, null, null, null, 1767323045678]);
});

test('grok privacy: the answer holds the reasoning text, its time and counts, and nothing else of the update stream', async t => {
  const C = {
    reasoning: 'CANARY-REASONING-9r01', session: 'CANARY-SESSION-9r02', promptId: 'CANARY-PROMPT-ID-9r03', prompt: 'CANARY-PROMPT-9r04',
    answer: 'CANARY-ANSWER-9r05', command: 'CANARY-COMMAND-9r06', filePath: '/home/dev/CANARY-FILE-PATH-9r07/notes.txt',
    output: 'CANARY-OUTPUT-9r08', toolId: 'CANARY-TOOL-ID-9r09', title: 'CANARY-TITLE-9r0a'
  };
  const up = (update, updateType, at) => line({ jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: C.session, update, _meta: { updateType, promptId: C.promptId, agentTimestampMs: at } } });
  const said = text => ({ type: 'text', text });
  const dir = tmp(t);
  const file = path.join(dir, C.session, 'updates.jsonl');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file,
    up({ sessionUpdate: 'user_message_chunk', content: said(C.prompt + ', and agent_thought_chunk.') }, 'UserMessageChunk', ms(0)) +
    up({ sessionUpdate: 'agent_thought_chunk', content: said('An invented thought, ' + C.reasoning + '.') }, 'AgentThoughtChunk', ms(1)) +
    up({ sessionUpdate: 'tool_call', toolCallId: C.toolId, title: C.title, kind: 'execute', status: 'pending',
      rawInput: { command: C.command + ' --file ' + C.filePath + ' agent_thought_chunk' } }, 'ToolCall', ms(2)) +
    up({ sessionUpdate: 'tool_call_update', toolCallId: C.toolId, status: 'completed', rawOutput: { output: C.output + ' agent_thought_chunk' },
      content: [{ type: 'content', content: said(C.output) }] }, 'ToolCallUpdate', ms(3)) +
    up({ sessionUpdate: 'agent_message_chunk', content: said(C.answer + ', and agent_thought_chunk.') }, 'AgentMessageChunk', ms(4)));
  const got = await readThinking(file, { format: 'grok' });
  assertOnly(got, C, dir, file);
  assert.deepEqual([texts(got), got.thoughts[0].at, counts(got)], [['An invented thought, ' + C.reasoning + '.'], ms(1), { recorded: 1, unrecorded: 0, more: 0 }]);
});

/* ---------- Antigravity ---------- */

test('antigravity: a model call with no thinking text is passed over: unrecorded is always 0', async t => {
  const got = await readThinking(write(t,
    agThought('') + agThought('  \n\t ') + agThought('\u0000\u2028') + agThought(42) + agThought(null) + agThought(['An array.']) +
    agStep('PLANNER_RESPONSE', { content: 'An answer, and no thinking key.' }) + KITS.antigravity.noise()), { format: 'antigravity' });
  assert.deepEqual([got.ok, got.whole, got.thoughts, counts(got)], [true, true, [], ZERO]);
});

test('antigravity: only PLANNER_RESPONSE thinking is read; another type with a thinking key is not, nor content or tool_calls', async t => {
  const file = write(t,
    agStep('USER_INPUT', { content: 'An invented prompt.', thinking: 'A thinking key on a user step.' }) +
    agStep('planner_response', { thinking: 'A type in the wrong case.' }) +
    agStep('RUN_COMMAND', { content: 'An invented result.', thinking: 'A thinking key on a tool step.' }) +
    agThought('The only thought.', { at: iso(1), content: 'CONTENT-NOT-READ an invented answer.',
      tool_calls: [{ id: 'call-INVENTED', name: 'run_command', args: { CommandLine: 'TOOL-CALL-NOT-READ ls' } }] }) +
    line({ type: 'PLANNER_RESPONSE', step: { thinking: 'Nested, not the record\'s own.' } }) +
    line([{ type: 'PLANNER_RESPONSE', thinking: 'A line that is an array.' }]) +
    'null\n' + '"thinking"\n' + '{"type":"PLANNER_RESPONSE","thinking":"half\n');
  const got = await readThinking(file, { format: 'antigravity' });
  assert.deepEqual(texts(got), ['The only thought.']);
  assert.deepEqual(counts(got), { recorded: 1, unrecorded: 0, more: 0 });
  const json = JSON.stringify(got);
  for (const never of ['CONTENT-NOT-READ', 'TOOL-CALL-NOT-READ', 'call-INVENTED', 'example-model']) assert.ok(!json.includes(never), never);
});

test('antigravity: a step is counted once by its step_index, else by its time and text', async t => {
  const twice = agThought('Written twice.', { step: 1, at: iso(1) });
  const got = await readThinking(write(t, twice + twice +
    agThought('Written twice.', { step: 1, at: iso(9) }) + agThought('Other text, same step.', { step: 1, at: iso(10) }) +
    agThought('Same text, its own step.', { step: 2, at: iso(2) }) + agThought('Same text, its own step.', { step: 3, at: iso(2) }) +
    agThought('No step.', { step: null, at: iso(4) }) + agThought('No step.', { step: '5', at: iso(4) }) + agThought('No step.', { step: null, at: iso(6) })),
  { format: 'antigravity' });
  assert.deepEqual(texts(got), ['No step.', 'No step.', 'Same text, its own step.', 'Same text, its own step.', 'Written twice.']);
  assert.deepEqual(got.thoughts.map(x => x.at), [ms(6), ms(4), ms(2), ms(2), ms(1)], 'counted where it first appears');
  assert.deepEqual(counts(got), { recorded: 5, unrecorded: 0, more: 0 });
});

test('antigravity: a thought whose truncated_fields names thinking is marked cut, as the tool left it; one that names only content is not', async t => {
  const got = await readThinking(write(t,
    agThought('Cut by the tool at its own limit', { at: iso(1), truncated_fields: ['thinking'] }) +
    agThought('Only the answer was cut.', { at: iso(2), truncated_fields: ['content'] }) +
    agThought('Both were cut', { at: iso(3), truncated_fields: ['content', 'thinking'] }) +
    agThought('A string, not an array.', { at: iso(4), truncated_fields: 'thinking' }) +
    agThought('An array of other things.', { at: iso(5), truncated_fields: [{ name: 'thinking' }, null, ['thinking']] }) +
    agThought('An empty array.', { at: iso(6), truncated_fields: [] })), { format: 'antigravity' });
  assert.deepEqual(got.thoughts, [
    { at: ms(6), text: 'An empty array.' },
    { at: ms(5), text: 'An array of other things.' },
    { at: ms(4), text: 'A string, not an array.' },
    { at: ms(3), text: 'Both were cut', cut: true },
    { at: ms(2), text: 'Only the answer was cut.' },
    { at: ms(1), text: 'Cut by the tool at its own limit', cut: true }
  ]);
  const older = await readThinking(write(t,
    agThought('Cut by the tool, the older.', { at: iso(1), truncated_fields: ['thinking'] }) + agThought('Not cut, the newer.', { at: iso(2) }), 'pair.jsonl'),
  { format: 'antigravity', thoughts: 1 });
  assert.deepEqual([older.thoughts, older.more], [[{ at: ms(2), text: 'Not cut, the newer.' }], 1], 'the mark stays with its own thought');
  const long = await readThinking(write(t, agThought('y'.repeat(50), { at: iso(1), truncated_fields: ['thinking'] }), 'long.jsonl'), { format: 'antigravity', thought: 10 });
  assert.deepEqual(long.thoughts, [{ at: ms(1), text: 'y'.repeat(9) + '…', cut: true }], 'cut again by `thought`, as any other');
});

test('antigravity: at is created_at as ISO 8601 text or a number of ms, else null', async t => {
  const got = await readThinking(write(t,
    agThought('ISO time.', { at: '2026-01-02T03:04:05.678Z' }) + agThought('Number time.', { at: 1767323045678 }) +
    agThought('Null time.', { at: null }) + agThought('Text that is not a time.', { at: 'yesterday-ish' }) +
    agThought('An object time.', { at: { when: 1 } }) + agThought('A boolean time.', { at: true }) +
    line({ step_index: 99, type: 'PLANNER_RESPONSE', thinking: 'No created_at key.' })), { format: 'antigravity' });
  assert.deepEqual(got.thoughts.map(x => x.at), [null, null, null, null, null, 1767323045678, Date.parse('2026-01-02T03:04:05.678Z')]);
});

test('antigravity privacy: the answer holds the thinking text, its time and counts, and nothing else of the transcript', async t => {
  const C = {
    reasoning: 'CANARY-REASONING-a901', prompt: 'CANARY-PROMPT-a902', answer: 'CANARY-ANSWER-a903', command: 'CANARY-COMMAND-a904',
    filePath: '/home/dev/CANARY-FILE-PATH-a905/notes.txt', output: 'CANARY-OUTPUT-a906', toolId: 'CANARY-TOOL-ID-a907', model: 'CANARY-MODEL-a908',
    userThinking: 'CANARY-USER-STEP-THINKING-a909', toolThinking: 'CANARY-TOOL-STEP-THINKING-a90a', conversation: 'CANARY-CONVERSATION-a90b'
  };
  const dir = tmp(t);
  const file = path.join(dir, C.conversation, 'transcript_full.jsonl');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file,
    agStep('USER_INPUT', { content: C.prompt, thinking: C.userThinking, conversation_id: C.conversation }, { at: iso(0) }) +
    agThought('An invented thought, ' + C.reasoning + '.', { at: iso(1), model: C.model, content: C.answer, conversation_id: C.conversation,
      tool_calls: [{ id: C.toolId, name: 'run_command', args: { CommandLine: C.command + ' --file ' + C.filePath } }] }) +
    agStep('RUN_COMMAND', { content: C.output, thinking: C.toolThinking, tool_call_id: C.toolId }, { at: iso(2) }));
  const got = await readThinking(file, { format: 'antigravity' });
  assertOnly(got, C, dir, file);
  assert.deepEqual([texts(got), got.thoughts[0].at, counts(got)], [['An invented thought, ' + C.reasoning + '.'], ms(1), { recorded: 1, unrecorded: 0, more: 0 }]);
});

/** The privacy checks every format shares: the documented keys only, the reasoning canary there, no other canary, no path. */
function assertOnly(got, C, dir, file) {
  assert.deepEqual(Object.keys(got), ANSWER_KEYS);
  for (const x of got.thoughts) assert.ok(Object.keys(x).every(k => k === 'at' || k === 'text' || k === 'cut'), Object.keys(x).join());
  const json = JSON.stringify(got);
  assert.ok(json.includes(C.reasoning), 'the reasoning text is there');
  for (const [name, value] of Object.entries(C)) {
    if (name !== 'reasoning') assert.ok(!json.includes(value), name + ' must not be in the answer');
  }
  for (const where of [dir, file, path.basename(file), path.dirname(file)]) {
    assert.ok(!json.includes(where) && !json.includes(JSON.stringify(where).slice(1, -1)), 'no path in the answer');
  }
}

/* ---------- the format option and the disk ---------- */

test('an unknown format is unreadable, before the path is looked at, and the disk is not touched', async t => {
  const file = write(t, cxThought(['Present.']));
  const disk = countDisk(t);
  const unknown = ['Codex', 'CLAUDE', 'gemini', '', ' codex', 'codex ', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf',
    null, 0, 42, true, {}, ['codex'], new String('codex')];
  for (const format of unknown) {
    const pending = readThinking(file, { format });
    assert.ok(pending instanceof Promise, 'a promise, never a throw');
    assert.deepEqual(await pending, { ok: false, why: 'unreadable' }, String(format));
  }
  for (const where of ['relative/session.jsonl', '\\\\server\\share\\session.jsonl', 42]) {
    assert.deepEqual(await readThinking(where, { format: 'gemini' }), { ok: false, why: 'unreadable' }, 'the format is checked first');
  }
  assert.deepEqual(disk, { stat: 0, open: 0 }, 'nothing was asked of the disk');
  assert.equal((await readThinking(file, { format: 'codex' })).recorded, 1);
  assert.equal((await readThinking(file, { format: undefined })).recorded, 0, 'no format: a Claude transcript, which this is not');
  assert.equal((await readThinking(file, { format: 'claude' })).recorded, 0);
  assert.equal((await readThinking(file, 'codex')).recorded, 0, 'options that are not an object name no format');
  assert.deepEqual(disk, { stat: 4, open: 4 });
});

test('a path on another machine is missing for every format, and is never looked up: no stat and no open', async t => {
  const disk = countDisk(t);
  for (const format of FORMATS) {
    for (const value of ['\\\\server\\share\\sessions\\rollout.jsonl', '//server/share/sessions/updates.jsonl',
      '\\\\?\\UNC\\server\\share\\transcript_full.jsonl', '\\\\server/share/' + SID + '.jsonl']) {
      assert.deepEqual(await readThinking(value, { format }), { ok: false, why: 'missing' }, format + ' ' + value);
    }
  }
  assert.deepEqual(disk, { stat: 0, open: 0 });
});

test('every format: a file that cannot be read is unreadable, with no exception text, and calls in parallel do not mix', async t => {
  const files = Object.fromEntries(Object.entries(KITS).map(([format, kit]) => [format, write(t, kit.thought('In the ' + format + ' file.', 1))]));
  const real = fs.promises.stat;
  t.after(() => { fs.promises.stat = real; });
  fs.promises.stat = async () => { const e = new Error('CANARY-ERROR-TEXT'); e.code = 'EACCES'; throw e; };
  for (const [format, file] of Object.entries(files)) assert.deepEqual(await readThinking(file, { format }), { ok: false, why: 'unreadable' }, format);
  fs.promises.stat = real;
  const answers = await Promise.all(Object.entries(files).map(([format, file]) => readThinking(file, { format })));
  assert.deepEqual(answers.map(texts), Object.keys(files).map(format => ['In the ' + format + ' file.']));
});

/* ---------- the extractors themselves ---------- */

test('each extractor takes any JSON value without throwing, and gives only key, at, text and cut', () => {
  const values = [undefined, null, 0, 42, '', 'reasoning', true, [], [{}], {},
    { type: 'response_item' }, { type: 'response_item', payload: null }, { type: 'response_item', payload: [] },
    { type: 'response_item', payload: { type: 'reasoning', summary: 'text', id: 7 } }, { type: 'response_item', payload: { type: 'reasoning', summary: { 0: { text: 'x' } } } },
    { params: null }, { params: [] }, { params: { update: null } }, { params: { update: { sessionUpdate: 'agent_thought_chunk', content: 'text' } } },
    { params: { update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'x' } }, _meta: 'not an object' } },
    { type: 'PLANNER_RESPONSE' }, { type: 'PLANNER_RESPONSE', thinking: 5 },
    { type: 'PLANNER_RESPONSE', thinking: 'x', truncated_fields: 'thinking', step_index: '1', created_at: [] }];
  for (const items of [codexItems, grokItems, antigravityItems]) {
    for (const value of values) {
      let got;
      assert.doesNotThrow(() => { got = items(value); }, items.name);
      assert.ok(Array.isArray(got), items.name);
      for (const x of got) {
        assert.ok(Object.keys(x).every(k => ['key', 'at', 'text', 'cut'].includes(k)), Object.keys(x).join());
        assert.ok(typeof x.key === 'string' && typeof x.text === 'string' && (x.at === null || Number.isFinite(x.at)));
      }
    }
  }
  assert.deepEqual(codexItems(JSON.parse(cxThought(['A.', 'B.'], { id: 'rs_X', at: iso(1) }))), [{ key: 'id\nrs_X', at: ms(1), text: 'A.\n\nB.' }]);
  assert.deepEqual(codexItems(JSON.parse(cxThought([], { id: 'rs_E' }))), [{ key: 'id\nrs_E', at: ms(0), text: '' }], 'a blank one, for unrecorded');
  assert.deepEqual(grokItems(JSON.parse(gkThought('G.', ms(2)))), [{ key: 'at\n' + ms(2) + '\nG.', at: ms(2), text: 'G.' }]);
  assert.deepEqual(antigravityItems(JSON.parse(agThought('A.', { step: 3, at: iso(3), truncated_fields: ['thinking'] }))), [{ key: 'step\n3', at: ms(3), text: 'A.', cut: true }]);
  assert.deepEqual(antigravityItems(JSON.parse(agThought('A.', { step: null, at: iso(3) }))), [{ key: 'at\n' + ms(3) + '\nA.', at: ms(3), text: 'A.' }]);
});

test('lib/thinking-formats.js needs no other module, holds no raw control character, and exports only its API', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'thinking-formats.js'), 'utf8');
  assert.ok(!/\brequire\s*\(/.test(source), 'no module');
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/.test(source), 'no raw control character');
  assert.deepEqual(Object.keys(require('../lib/thinking-formats.js')), ['FORMATS', 'READERS', 'codexItems', 'grokItems', 'antigravityItems']);
  assert.deepEqual(FORMATS, ['claude', 'codex', 'grok', 'antigravity']);
  assert.deepEqual(Object.keys(READERS), ['codex', 'grok', 'antigravity']);
  assert.deepEqual(Object.fromEntries(Object.entries(READERS).map(([name, r]) => [name, [r.mark, r.items, r.tellsUnrecorded]])), {
    codex: ['"reasoning"', codexItems, true], grok: ['agent_thought_chunk', grokItems, false], antigravity: ['"thinking"', antigravityItems, false]
  });
  assert.ok(Object.isFrozen(FORMATS) && Object.isFrozen(READERS) && Object.values(READERS).every(Object.isFrozen));
});
