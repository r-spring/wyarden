// Thinking never travels through the hub. A window's own extension host reads a session's thinking
// straight from its transcript (lib/thinking.js) and posts it to that window's page only; the hub
// path, from the transcript tail to every window's line, carries none of it, nor the assistant's
// text, the prompt or a tool's result: not in a payload, an event, a model, a snapshot, a line, the
// status or resolve answer, a log line or a file. Every marker names the one field it sits in, so a
// failure says which leaked, and every test also checks that the tool calls still came through, so
// none passes because nothing was read. Every id, text, signature and path is invented; every folder
// is temporary.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { createTail } = require('../lib/transcript.js');
const { createNormaliser } = require('../lib/normalise.js');
const { transcriptPath } = require('../lib/discover.js');
const { startHub } = require('../lib/hub-server.js');
const contract = require('../lib/contract.js');
const M = require('../media/model.js');

const FIX = path.join(__dirname, 'fixtures', 'transcript');
const SID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const P = '/home/example/proj', OTHER = '/home/example/other';
const kP = contract.wsKey(P);
const T0 = Date.parse('2026-01-02T03:04:00.000Z');
const TIMINGS = { discoveryMs: 60, tailMs: 40, workspacesMs: 20 };
const delay = ms => new Promise(r => setTimeout(r, ms));

/* One marker per field, for the part of the transcript the first poll replays and for the part appended later. */
const REPLAY = {
  prompt: 'MARK_PROMPT_3c5b', thinking: 'MARK_THINKING_4d1a', signature: 'MARK_SIGNATURE_9b3e', bare: 'MARK_THINKBARE_e07c',
  redacted: 'MARK_REDACTED_51f7', text: 'MARK_TEXT_a6e3', withCall: 'MARK_THINKWITHCALL_c2a8', sigWithCall: 'MARK_SIGWITHCALL_7d10',
  textWithCall: 'MARK_TEXTWITHCALL_0f92', redactedWithCall: 'MARK_REDACTEDWITHCALL_38b6', result: 'MARK_RESULT_8e24', sub: 'MARK_SUBTHINKING_5a0d'
};
const LIVE = Object.fromEntries(Object.entries(REPLAY).map(([k, v]) => [k, v.replace('MARK_', 'MARK_LIVE')]));
const MARKS = [...Object.entries(REPLAY).map(([k, v]) => ['replayed ' + k, v]), ...Object.entries(LIVE).map(([k, v]) => ['live ' + k, v])];
/** What the fixtures hold besides tool calls: mixed.jsonl's thinking block and its signature, one-record-parallel.jsonl's text. */
const FIXTURE_TEXT = [['thinking', 'Invented thinking.'], ['signature', 'c2ln'], ['assistant text', 'Invented text before the calls.']];
/** Keys only a thinking block, or lib/thinking.js's answer, has. */
const THINKING_KEYS = ['thinking', 'thoughts', 'signature', 'redacted_thinking'];
const PAYLOAD_KEYS = ['hook_event_name', 'session_id', 'cwd', 'tool_name', 'tool_input', 'tool_use_id', '_wy'];

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const brief = list => list.map(p => p.hook_event_name + ' ' + p.tool_use_id + ' ' + p.tool_name);

/* ---------- a transcript with a marker in every block the tail must pass over ---------- */

let uid = 0;
/** One record as the CLI writes it (CLI 2.1): an assistant or user message holding these content blocks. */
function record(type, content, extra = {}) {
  uid++;
  const message = type === 'assistant'
    ? { model: 'example-model', id: 'msg_T' + uid, type: 'message', role: 'assistant', content, stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 2 } }
    : { role: 'user', content };
  return JSON.stringify(Object.assign({ parentUuid: null, isSidechain: false, type, message, uuid: type.charAt(0) + '-t' + uid,
    timestamp: new Date(T0 + uid * 1000).toISOString(), userType: 'external', entrypoint: 'cli', cwd: P, sessionId: SID, version: '2.1.0' }, extra)) + '\n';
}
const thought = (text, signature) => ({ type: 'thinking', thinking: text, signature });
const redacted = data => ({ type: 'redacted_thinking', data });
const said = text => ({ type: 'text', text });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input, caller: { type: 'direct' } });
const answer = (id, text, isError) => Object.assign({ type: 'tool_result', tool_use_id: id, content: text }, isError ? { is_error: true } : {});

/** The first part: thinking on its own, a thought that looks like a name, redacted thinking, text, and a record that holds thinking, text and a call together. */
function replayPart(m = REPLAY) {
  return [
    record('user', 'An invented prompt, ' + m.prompt + '.', { promptId: 'p-t1' }),
    record('assistant', [thought('An invented thought, ' + m.thinking + ', about the plan.', m.signature)]),
    record('assistant', [thought(m.bare, '')]),
    record('assistant', [redacted(m.redacted)]),
    record('assistant', [said('An invented answer, ' + m.text + '.')]),
    record('assistant', [thought('An invented thought, ' + m.withCall + ', before a call.', m.sigWithCall), said('Invented text, ' + m.textWithCall + '.'),
      call('toolu_TP01', 'Grep', { pattern: 'TODO', path: 'src' })]),
    record('user', [answer('toolu_TP01', 'An invented result, ' + m.result + '.')]),
    record('assistant', [redacted(m.redactedWithCall), call('toolu_TP02', 'Read', { file_path: P + '/src/a.js' })]),
    record('assistant', [thought('An invented subagent thought, ' + m.sub + '.', 'eA'), call('toolu_TS01', 'Bash', { command: 'echo invented' })], { isSidechain: true, agentId: 'agent-t1' })
  ].join('');
}
/** The part appended later: a result for the call left open, the same kinds of block again, and a new call that fails. */
function livePart(m = LIVE) {
  return [
    record('user', [said('An invented prompt, ' + m.prompt + '.')], { promptId: 'p-t2' }),
    record('user', [answer('toolu_TP02', 'An invented result, ' + m.result + '.')]),
    record('assistant', [thought('An invented thought, ' + m.thinking + ', after a result.', m.signature)]),
    record('assistant', [thought(m.bare, '')]),
    record('assistant', [redacted(m.redacted)]),
    record('assistant', [said('An invented answer, ' + m.text + '.')]),
    record('assistant', [thought('An invented thought, ' + m.withCall + ', before a call.', m.sigWithCall), said('Invented text, ' + m.textWithCall + '.'),
      redacted(m.redactedWithCall), call('toolu_TP03', 'Glob', { pattern: '**/*.md' })]),
    record('assistant', [thought('An invented subagent thought, ' + m.sub + '.', 'eB'), call('toolu_TS02', 'Bash', { command: 'echo invented' })], { isSidechain: true, agentId: 'agent-t1' }),
    record('user', [answer('toolu_TP03', 'An invented result, ' + m.result + '.', true)])
  ].join('');
}
const REPLAYED_CALLS = ['PreToolUse toolu_TP01 Grep', 'PostToolUse toolu_TP01 Grep', 'PreToolUse toolu_TP02 Read'];
const LIVE_CALLS = ['PostToolUse toolu_TP02 Read', 'PreToolUse toolu_TP03 Glob', 'PostToolUseFailure toolu_TP03 Glob'];

/* ---------- searching ---------- */

function assertNoMark(text, where, marks = MARKS) {
  for (const [field, mark] of marks) assert.ok(!text.includes(mark), where + ': the ' + field + ' marker leaked (' + mark + ')');
  if (marks === MARKS) assert.ok(!text.includes('MARK_'), where + ': no marker of any kind');
}
/** Every key at any depth; a text that is itself JSON (a snapshot's state) is walked too. */
function keysOf(value, out = new Set()) {
  if (typeof value === 'string') {
    if (/^\s*[{[]/.test(value)) { try { keysOf(JSON.parse(value), out); } catch { /* text, not JSON */ } }
  } else if (Array.isArray(value)) {
    for (const v of value) keysOf(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out); }
  }
  return out;
}
function assertNoThinkingKey(value, where) {
  const keys = keysOf(value);
  for (const k of THINKING_KEYS) assert.ok(!keys.has(k), where + ': a "' + k + '" key');
}
/** The tail's payloads: the hook shape and nothing else, with no marker and no thinking key. */
function assertCleanPayloads(list, where) {
  for (const p of list) {
    assert.deepEqual(Object.keys(p).filter(k => !PAYLOAD_KEYS.includes(k)), [], where + ': a payload key outside the hook shape');
    assert.deepEqual(Object.keys(p._wy).filter(k => !['src', 'at', 'replay'].includes(k)), [], where + ': a _wy key outside src, at, replay');
  }
  assertNoMark(JSON.stringify(list), where);
  assertNoThinkingKey(list, where);
}
const asJson = value => JSON.stringify(value, (k, v) => (v instanceof Map ? { $map: [...v] } : v instanceof Set ? { $set: [...v] } : v));
function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(p)); else out.push(p);
  }
  return out;
}

/* ---------- A. the tail ---------- */

const FIXTURE_CALLS = {
  'mixed.jsonl': ['PreToolUse toolu_A1 Glob', 'PreToolUse toolu_A2 Read', 'PostToolUse toolu_A1 Glob', 'PostToolUseFailure toolu_A2 Read', 'PreToolUse toolu_A3 Bash'],
  'one-record-parallel.jsonl': ['PreToolUse toolu_P1 Grep', 'PreToolUse toolu_P2 mcp__example__lookup', 'PostToolUse toolu_P2 mcp__example__lookup', 'PostToolUseFailure toolu_P1 Grep']
};
for (const [name, calls] of Object.entries(FIXTURE_CALLS)) {
  test('A1 ' + name + ': no payload carries its thinking, signature or assistant text, on the first poll or on later polls', t => {
    const lines = fs.readFileSync(path.join(FIX, name), 'utf8').split('\n').filter(Boolean);
    const dir = tmp(t);
    const whole = path.join(dir, 'whole.jsonl');
    fs.writeFileSync(whole, lines.join('\n') + '\n');
    const first = createTail(whole, {}).poll();
    assert.deepEqual(brief(first), calls, 'the first poll replays the calls');
    assertCleanPayloads(first, name + ', the first poll');
    assertNoMark(JSON.stringify(first), name + ', the first poll', FIXTURE_TEXT);
    const grown = path.join(dir, 'grown.jsonl');
    fs.writeFileSync(grown, '');
    const tail = createTail(grown, {});
    assert.deepEqual(tail.poll(), []);
    const later = [];
    for (const line of lines) { fs.appendFileSync(grown, line + '\n'); later.push(...tail.poll()); }
    assert.deepEqual(brief(later), calls, 'later polls give the same calls');
    assertCleanPayloads(later, name + ', later polls');
    assertNoMark(JSON.stringify(later), name + ', later polls', FIXTURE_TEXT);
  });
}

test('A2 a built transcript: the replay and a later poll carry no thinking, signature, redacted data, text, prompt or result, and the calls come out', t => {
  const file = path.join(tmp(t), SID + '.jsonl');
  const first = replayPart(), second = livePart();
  for (const [field, mark] of MARKS) assert.ok((first + second).includes(mark), 'the transcript holds the ' + field + ' marker');
  fs.writeFileSync(file, first);
  const tail = createTail(file, { session: SID, cwd: P });
  const replayed = tail.poll();
  assert.deepEqual(brief(replayed), REPLAYED_CALLS, 'the call in the record with thinking and text is read');
  assert.ok(replayed.every(p => p._wy.replay === true));
  assert.deepEqual(replayed[0].tool_input, { pattern: 'TODO', path: 'src' }, 'the call\'s own input, and nothing beside it');
  assert.deepEqual(replayed[2].tool_input, { file_path: P + '/src/a.js' });
  assertCleanPayloads(replayed, 'the replay');
  fs.appendFileSync(file, second);
  const live = tail.poll();
  assert.deepEqual(brief(live), LIVE_CALLS);
  assert.ok(live.every(p => !('replay' in p._wy)));
  assert.deepEqual(live[1].tool_input, { pattern: '**/*.md' });
  assertCleanPayloads(live, 'a later poll');
  assert.equal(tail.skipped, 0);
});

test('A2 the same transcript a line at a time: no later poll carries any of it', t => {
  const file = path.join(tmp(t), SID + '.jsonl');
  fs.writeFileSync(file, '');
  const tail = createTail(file, { session: SID, cwd: P });
  assert.deepEqual(tail.poll(), []);
  const got = [];
  for (const line of (replayPart() + livePart()).split('\n').filter(Boolean)) { fs.appendFileSync(file, line + '\n'); got.push(...tail.poll()); }
  assert.deepEqual(brief(got), REPLAYED_CALLS.concat(LIVE_CALLS));
  assertCleanPayloads(got, 'later polls');
});

/* ---------- B and C. the real hub: discovery, tail and normaliser, with a window's line read whole ---------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function request(port, { method = 'POST', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    r.on('error', reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const sign = (s, method, p, nonce = contract.newNonce()) => contract.signRequest(s.hub.control, method, p, nonce);
const control = (s, method, p, body) => request(s.port, { method, path: p, headers: { Authorization: sign(s, method, p), 'Content-Type': 'application/json' }, body });

/** A window's open connection: every line as received (`raw`), each parsed, and a way to wait for one. */
function open(s, body) {
  const raw = [], messages = [];
  const r = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/v1/attach', agent: false,
    headers: { 'Content-Type': 'application/json', Authorization: sign(s, 'POST', '/v1/attach') } });
  r.on('response', res => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); raw.push(line); messages.push(JSON.parse(line)); buf = buf.slice(i + 1); } });
  });
  r.on('error', () => {});
  r.end(JSON.stringify(body));
  const waitFor = async (pred, ms = 5000, what = 'a message') => {
    for (const until = Date.now() + ms; Date.now() < until; await delay(10)) { const m = messages.find(pred); if (m) return m; }
    throw new Error('timed out waiting for ' + what);
  };
  return { raw, messages, waitFor, close: () => r.destroy() };
}
const winBody = (id, folders, scope) => ({ v: 1, window: { id, app: 'Code', name: id, pid: 1, folders: folders.map(p => ({ path: p, name: path.posix.basename(p) })) }, scope });
const snapshotOf = m => m.type === 'records' && m.records[0] && m.records[0].ctl === 'snapshot';
const liveEnd = m => m.type === 'records' && m.records.some(e => e.ev === 'tool.end' && e.call === 'toolu_TP03');

/**
 * A hub on a temporary monitor home, with everything real but the user's home: discovery finds a
 * session file there (this process stands in for the CLI, so its pid is alive), the real tail reads
 * the transcript beside it, and the real normaliser is wrapped only to keep a copy of what it is
 * given and what it gives. The transcript is outside the monitor home, so a walk of that home
 * finds only what the hub wrote or read for itself.
 */
async function canaryHub(t) {
  const home = tmp(t), userHome = tmp(t);
  const hub = { v: 1, port: await freePort(), ingest: crypto.randomBytes(32).toString('base64url'), control: crypto.randomBytes(32).toString('base64url'), created: 1 };
  fs.writeFileSync(path.join(home, 'hub.json'), JSON.stringify(hub));
  const config = path.join(userHome, '.claude');
  fs.mkdirSync(path.join(config, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(config, 'sessions', process.pid + '.json'),
    JSON.stringify({ pid: process.pid, sessionId: SID, cwd: P, status: 'busy', updatedAt: T0, entrypoint: 'cli' }));
  const transcript = transcriptPath(config, P, SID);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, replayPart());
  const logs = [], fed = [], made = [];
  const deps = {
    createNormaliser: opts => {
      const n = createNormaliser(opts);
      return {
        feed(p, o) { fed.push(JSON.stringify(p)); const out = n.feed(p, o); made.push(JSON.stringify(out)); return out; },
        forget: key => n.forget(key)
      };
    }
  };
  const h = await startHub({ home, hub, userHome, env: {}, timings: TIMINGS, deps, log: (level, message) => logs.push(level + ': ' + message) });
  t.after(() => h.close());
  return { h, hub, port: hub.port, home, transcript, logs, fed, made };
}

test('B through the real hub, two windows on the session\'s folder and one on all: no line, model, snapshot, status, log or file carries any of it', async t => {
  const s = await canaryHub(t);
  const a = open(s, winBody('A', [P], kP));
  const snapA = await a.waitFor(snapshotOf, 5000, 'A\'s snapshot');
  const b = open(s, winBody('B', [P], kP));
  const c = open(s, winBody('C', [OTHER], 'all'));
  const firsts = [['A', snapA], ['B', await b.waitFor(snapshotOf, 5000, 'B\'s snapshot')], ['C', await c.waitFor(snapshotOf, 5000, 'C\'s snapshot')]];
  assert.equal(firsts[1][1].scope, kP); assert.equal(firsts[2][1].scope, 'all');
  for (const [name, snap] of firsts) {
    const model = M.load(snap.records[0].state);
    const grep = model.nodes.get('t:claude:' + SID + ':Grep'), read = model.nodes.get('t:claude:' + SID + ':Read');
    assert.ok(grep && read, name + ': the replayed calls are in its first snapshot');
    assert.equal(grep.calls, 1); assert.equal(read.open, 1);
    assertNoMark(model.serialize(), name + '\'s first snapshot, loaded back');
  }

  fs.appendFileSync(s.transcript, livePart());
  const windows = [['A', a], ['B', b], ['C', c]];
  for (const [name, w] of windows) {
    await w.waitFor(liveEnd, 5000, name + ': the live call');
    const live = w.messages.filter(m => m.type === 'records' && !snapshotOf(m)).flatMap(m => m.records)
      .filter(e => e.session === SID && /^tool\./.test(e.ev)).map(e => e.ev + ' ' + e.call);
    assert.deepEqual(live, ['tool.end toolu_TP02', 'tool.start toolu_TP03', 'tool.end toolu_TP03'], name + ': the live calls, and none replayed');
    const start = w.messages.flatMap(m => m.records || []).find(e => e.ev === 'tool.start' && e.call === 'toolu_TP03');
    assert.equal(start.tool, 'Glob');
  }
  await control(s, 'POST', '/v1/update', { window: 'A', snapshot: true });
  const again = await a.waitFor(m => snapshotOf(m) && m !== snapA, 5000, 'A\'s second snapshot');
  const loaded = M.load(again.records[0].state);
  assert.ok(loaded.nodes.get('t:claude:' + SID + ':Glob'), 'the live call is in the second snapshot');
  assertNoMark(loaded.serialize(), 'A\'s second snapshot, loaded back');

  // What the hub holds: every model, and its record of the session.
  assert.deepEqual([...s.h.core.models.keys()].sort(), ['all', contract.wsKey(OTHER), kP].sort());
  for (const [scope, model] of s.h.core.models) {
    assertNoMark(model.serialize(), 'the hub\'s model for ' + scope);
    assertNoThinkingKey(model.serialize(), 'the hub\'s model for ' + scope);
  }
  assertNoMark(asJson(s.h.core.session('claude:' + SID)), 'the hub\'s record of the session');

  // What the normaliser was given (the payloads) and what it gave (the events), each copied when it happened.
  assert.ok(s.fed.length >= 6, 'the tail\'s payloads reached the normaliser: ' + s.fed.length);
  assert.ok(s.fed.every(p => JSON.parse(p)._wy.src === 'transcript'), 'every payload came from the transcript tail');
  assertNoMark(s.fed.join('\n'), 'a payload');
  assertNoThinkingKey(s.fed.map(p => JSON.parse(p)), 'a payload');
  assertNoMark(s.made.join('\n'), 'an event the normaliser made');

  const statusText = (await control(s, 'GET', '/v1/status')).body;
  const st = JSON.parse(statusText);
  assert.equal(st.tails, 1); assert.equal(st.sources.transcript, 1); assert.equal(st.events.replayed, 3, 'the replay ran');
  assertNoMark(statusText, 'the status answer');
  assertNoThinkingKey(st, 'the status answer');

  await s.h.close();
  for (const [name, w] of windows) await w.waitFor(m => m.type === 'bye', 3000, name + ': bye');
  for (const [name, w] of windows) {
    assert.ok(w.messages.some(m => m.type === 'workspaces'), name + ' got its workspaces');
    assertNoMark(w.raw.join('\n'), 'a line window ' + name + ' received');
    assertNoThinkingKey(w.messages, 'a line window ' + name + ' received');
  }
  assert.ok(s.logs.length > 0, 'the hub\'s log lines were collected');
  assertNoMark(s.logs.join('\n'), 'the hub\'s log');
  const files = filesUnder(s.home);
  assert.ok(files.some(f => path.basename(f) === 'hub.json'), 'the walk reads hub.json');
  for (const f of files) {
    const bytes = fs.readFileSync(f);
    for (const [field, mark] of MARKS) assert.ok(!bytes.includes(mark), path.relative(s.home, f) + ': the ' + field + ' marker');
    assert.ok(!bytes.includes('MARK_'), path.relative(s.home, f) + ': no marker of any kind');
  }
});

test('C a resolve answer for the session\'s agent holds only kind, agent, session, cwd, root and pid, and no text', async t => {
  const s = await canaryHub(t);
  const a = open(s, winBody('A', [P], kP));
  await a.waitFor(snapshotOf, 5000, 'the snapshot');
  fs.appendFileSync(s.transcript, livePart());
  await a.waitFor(liveEnd, 5000, 'the live call');
  const text = (await control(s, 'POST', '/v1/resolve', { window: 'A', target: { id: 'a:claude:' + SID } })).body;
  const res = JSON.parse(text);
  assert.deepEqual(Object.keys(res), ['kind', 'agent', 'session', 'cwd', 'root', 'pid']);
  assert.equal(res.kind, 'session'); assert.equal(res.agent, 'claude'); assert.equal(res.session, SID);
  assert.equal(res.cwd, P); assert.equal(res.pid, process.pid);
  assert.ok(res.root === null || typeof res.root === 'string', 'root is a path or null');
  assertNoMark(text, 'the resolve answer');
  for (const id of ['t:claude:' + SID + ':Grep', 't:claude:' + SID + ':Glob', 'a:claude:' + SID + ':thinking']) {
    assert.deepEqual(JSON.parse((await control(s, 'POST', '/v1/resolve', { window: 'A', target: { id } })).body), { kind: 'none' }, id);
  }
  await s.h.close();
  a.close();
});
