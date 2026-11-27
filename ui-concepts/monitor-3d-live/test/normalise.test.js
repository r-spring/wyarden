// The normaliser: each Claude Code hook gives exactly the events the contract names
// (docs/monitor-3d/05-working-mockup.md section 5), every event passes the model's check, and a
// replayed session draws the expected scene. The payloads are invented (test/fixtures/raw/claude),
// shaped as Claude Code 2.1.332 was seen to send them. A stub stands in for the folder lookup, so
// both path forms are tested on any system and no real folder is read.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const contract = require('../lib/contract.js');
const { createNormaliser, MAX_SESSIONS, MAX_CALLS } = require('../lib/normalise.js');
const M = require('../media/model.js');

const FIX = path.join(__dirname, 'fixtures', 'raw', 'claude');
const load = name => JSON.parse(fs.readFileSync(path.join(FIX, name + '.json'), 'utf8'));

const SID = '11111111-2222-4333-8444-555555555555';
const PID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SUB = 'a0123456789abcdef';
const KEY = 'claude:' + SID;
const call = n => 'toolu_01' + String(n).padStart(22, '0');

const ROOTS = [
  { root: '/home/example/proj', ws: 'wsposix00001', f: path.posix },
  { root: 'C:\\Users\\example\\proj', ws: 'wswin0000001', f: path.win32 }
];
/** rootInfo without a disk: the invented project folder is its own root. */
function stubRoot(cwd) {
  const known = ROOTS.find(r => contract.isInside(r.root, cwd));
  if (known) return { root: known.root, real: known.root, ws: known.ws, name: known.f.basename(known.root) };
  const f = contract.flavour(cwd);
  return { root: cwd, real: cwd, ws: 'wsother00001', name: f.basename(cwd) };
}
const SALT = 'test-salt-0001';
const fresh = () => createNormaliser({ rootInfo: stubRoot, salt: SALT });
const saltedHash = (tool, input) => contract.inputHash(tool, input, SALT);

const env = (t, ev, grade, src, extra) => Object.assign({ v: 1, t, agent: 'claude', session: SID, ws: 'wsposix00001', ev, grade, src }, extra);
const hook = (t, ev, event, extra) => env(t, ev, 'exact', 'hook:' + event, Object.assign({ turn: PID }, extra));
const hashOf = name => saltedHash(load(name).tool_name, load(name).tool_input);

/** Feed fixtures in order at t = 1000, 2000, ...; the events of the last one. */
function run(n, names, t0 = 1000) {
  let out = null;
  names.forEach((name, i) => { out = n.feed(typeof name === 'string' ? load(name) : name, { t: t0 + i * 1000 }); });
  return out;
}

test('SessionStart gives session.start with its source, model and root, and the result names the session', () => {
  const out = fresh().feed(load('session-start'), { t: 1000, hint: 'claude' });
  assert.deepEqual(out.events, [env(1000, 'session.start', 'exact', 'hook:SessionStart', { source: 'startup', model: 'claude-example-1', root: { name: 'proj' } })]);
  assert.equal(out.agent, 'claude');
  assert.equal(out.session, SID);
  assert.equal(out.key, KEY);
  assert.equal(out.cwd, '/home/example/proj');
  assert.equal(out.source, 'hook');
  assert.deepEqual(out.root, stubRoot('/home/example/proj'));
});

test('SessionEnd gives session.end with its reason, and the session is forgotten', () => {
  const n = fresh();
  n.feed(load('user-prompt-submit'), { t: 900 });
  assert.equal(n.size(), 1);
  assert.deepEqual(n.feed(load('session-end'), { t: 1000 }).events, [hook(1000, 'session.end', 'SessionEnd', { reason: 'other' })]);
  assert.equal(n.size(), 0);
});

test('UserPromptSubmit gives turn.start with the turn id and the prompt length only', () => {
  const p = load('user-prompt-submit');
  assert.deepEqual(fresh().feed(p, { t: 1000 }).events, [hook(1000, 'turn.start', 'UserPromptSubmit', { chars: p.prompt.length })]);
});

test('Stop gives turn.end done, with asks when the reply ends with a question mark', () => {
  assert.deepEqual(fresh().feed(load('stop'), { t: 1000 }).events, [hook(1000, 'turn.end', 'Stop', { outcome: 'done', asks: true })]);
  const plain = Object.assign(load('stop'), { last_assistant_message: 'All done.  ' });
  assert.deepEqual(fresh().feed(plain, { t: 1000 }).events, [hook(1000, 'turn.end', 'Stop', { outcome: 'done', asks: false })]);
  const trailing = Object.assign(load('stop'), { last_assistant_message: 'Shall I?\n\n' });
  assert.equal(fresh().feed(trailing, { t: 1000 }).events[0].asks, true);
});

test('StopFailure gives turn.end failed', () => {
  assert.deepEqual(fresh().feed(load('stop-failure'), { t: 1000 }).events, [hook(1000, 'turn.end', 'StopFailure', { outcome: 'failed', asks: false })]);
});

test('PreToolUse of Read gives tool.start and a file read touch, relative to the root', () => {
  assert.deepEqual(fresh().feed(load('pre-read'), { t: 1000 }).events, [
    hook(1000, 'tool.start', 'PreToolUse', { call: call(1), tool: 'Read', class: 'read', hash: hashOf('pre-read') }),
    env(1000, 'resource.touch', 'derived', 'args:Read', { turn: PID, call: call(1), kind: 'file', op: 'read', path: 'src/a.js' })
  ]);
});

test('PostToolUse gives tool.end with the exact duration', () => {
  const n = fresh();
  n.feed(load('pre-read'), { t: 1000 });
  assert.deepEqual(n.feed(load('post-read'), { t: 1020 }).events, [
    hook(1020, 'tool.end', 'PostToolUse', { call: call(1), tool: 'Read', ok: true, ms: 12, msGrade: 'exact' })
  ]);
});

test('without duration_ms the time is derived from the start, and absent when the start was not seen', () => {
  const n = fresh();
  const post = load('post-read'); delete post.duration_ms;
  n.feed(load('pre-read'), { t: 1000 });
  assert.deepEqual(n.feed(post, { t: 1250 }).events, [hook(1250, 'tool.end', 'PostToolUse', { call: call(1), tool: 'Read', ok: true, ms: 250, msGrade: 'derived' })]);
  assert.deepEqual(fresh().feed(post, { t: 1250 }).events, [hook(1250, 'tool.end', 'PostToolUse', { call: call(1), tool: 'Read', ok: true })]);
});

test('PostToolUseFailure gives tool.end not ok, with the error as a class only', () => {
  const n = fresh();
  assert.deepEqual(n.feed(load('pre-write'), { t: 1000 }).events, [
    hook(1000, 'tool.start', 'PreToolUse', { call: call(2), tool: 'Write', class: 'edit', hash: hashOf('pre-write') }),
    env(1000, 'resource.touch', 'derived', 'args:Write', { turn: PID, call: call(2), kind: 'file', op: 'write', path: 'src/b.js' })
  ]);
  assert.deepEqual(n.feed(load('failure-write'), { t: 1010 }).events, [
    hook(1010, 'tool.end', 'PostToolUseFailure', { call: call(2), tool: 'Write', ok: false, ms: 7, msGrade: 'exact', error: 'tool_error', interrupted: false })
  ]);
  const stopped = Object.assign(load('failure-write'), { is_interrupt: true });
  assert.deepEqual(fresh().feed(stopped, { t: 1010 }).events, [
    hook(1010, 'tool.end', 'PostToolUseFailure', { call: call(2), tool: 'Write', ok: false, ms: 7, msGrade: 'exact', error: 'interrupted', interrupted: true })
  ]);
});

test('Glob and Grep give a dir search on the folder searched, the cwd when no path is given', () => {
  assert.deepEqual(fresh().feed(load('pre-glob'), { t: 1000 }).events[1],
    env(1000, 'resource.touch', 'derived', 'args:Glob', { turn: PID, call: call(3), kind: 'dir', op: 'search', path: 'src' }));
  const grep = load('pre-grep-sub'); delete grep.agent_id; delete grep.agent_type;
  assert.deepEqual(fresh().feed(grep, { t: 1000 }).events, [
    hook(1000, 'tool.start', 'PreToolUse', { call: call(8), tool: 'Grep', class: 'search', hash: saltedHash('Grep', grep.tool_input) }),
    env(1000, 'resource.touch', 'derived', 'args:Grep', { turn: PID, call: call(8), kind: 'dir', op: 'search', path: '.' })
  ]);
});

test('a path outside the root keeps its base name only; Edit, MultiEdit and NotebookEdit are writes', () => {
  const p = Object.assign(load('pre-read'), { tool_name: 'Edit', tool_input: { file_path: '/home/example/other/secret.txt', old_string: 'a', new_string: 'b' } });
  assert.deepEqual(fresh().feed(p, { t: 1 }).events[1].path, { outside: true, name: 'secret.txt' });
  const multi = Object.assign(load('pre-read'), { tool_name: 'MultiEdit', tool_input: { file_path: 'src/c.js', edits: [] } });
  assert.equal(fresh().feed(multi, { t: 1 }).events[1].path, 'src/c.js', 'a relative path is taken from the cwd');
  const book = Object.assign(load('pre-read'), { tool_name: 'NotebookEdit', tool_input: { notebook_path: '/home/example/proj/n/a.ipynb', new_source: 'x' } });
  const touch = fresh().feed(book, { t: 1 }).events[1];
  assert.equal(touch.op, 'write'); assert.equal(touch.path, 'n/a.ipynb');
});

test('WebFetch gives a url read with scheme, host and path only; WebSearch a search with no target', () => {
  const out = fresh().feed(load('pre-fetch'), { t: 1000 }).events;
  assert.deepEqual(out[0], hook(1000, 'tool.start', 'PreToolUse', { call: call(6), tool: 'WebFetch', class: 'fetch', hash: hashOf('pre-fetch') }));
  assert.deepEqual(out[1], env(1000, 'resource.touch', 'derived', 'args:WebFetch', { turn: PID, call: call(6), kind: 'url', op: 'read', url: 'https://docs.example.com/guide/start' }));
  const search = Object.assign(load('pre-fetch'), { tool_name: 'WebSearch', tool_input: { query: 'example query' } });
  assert.deepEqual(fresh().feed(search, { t: 1 }).events[1], env(1, 'resource.touch', 'derived', 'args:WebSearch', { turn: PID, call: call(6), kind: 'search', op: 'search' }));
  const ftp = Object.assign(load('pre-fetch'), { tool_input: { url: 'ftp://example.com/a' } });
  assert.equal(fresh().feed(ftp, { t: 1 }).events.length, 1, 'an address that is not http(s) gives no touch');
});

test('ReadMcpResourceTool gives an mcp-resource read with the server and the scheme only', () => {
  const p = Object.assign(load('pre-read'), { tool_name: 'ReadMcpResourceTool', tool_input: { server: 'docs', uri: 'notes://private/area/1' } });
  const out = fresh().feed(p, { t: 1 }).events;
  assert.equal(out[0].class, 'mcp');
  assert.deepEqual(out[1], env(1, 'resource.touch', 'derived', 'args:ReadMcpResourceTool', { turn: PID, call: call(1), kind: 'mcp-resource', op: 'read', server: 'docs', scheme: 'notes' }));
});

test('an MCP call gives mcp.start and mcp.end, the server from mcp_server (exact)', () => {
  const n = fresh();
  assert.deepEqual(n.feed(load('pre-mcp'), { t: 1000 }).events, [
    hook(1000, 'mcp.start', 'PreToolUse', { call: call(4), server: 'example_srv', tool: 'echo', serverSource: 'dynamic', hash: hashOf('pre-mcp') })
  ]);
  assert.deepEqual(n.feed(load('post-mcp'), { t: 1040 }).events, [
    hook(1040, 'mcp.end', 'PostToolUse', { call: call(4), server: 'example_srv', tool: 'echo', serverSource: 'dynamic', ok: true, ms: 30, msGrade: 'exact' })
  ]);
});

test('without mcp_server the name is split at the first __ (derived); the end keeps the start\'s server', () => {
  const n = fresh();
  const pre = Object.assign(load('pre-mcp'), { tool_name: 'mcp__github__list__issues' }); delete pre.mcp_server;
  assert.deepEqual(n.feed(pre, { t: 1 }).events, [
    env(1, 'mcp.start', 'derived', 'hook:PreToolUse', { turn: PID, call: call(4), server: 'github', tool: 'list__issues', hash: saltedHash('mcp__github__list__issues', pre.tool_input) })
  ]);
  const post = Object.assign(load('post-mcp')); delete post.tool_name; delete post.mcp_server;
  assert.deepEqual(n.feed(post, { t: 2 }).events, [
    env(2, 'mcp.end', 'derived', 'hook:PostToolUse', { turn: PID, call: call(4), server: 'github', tool: 'list__issues', ok: true, ms: 30, msGrade: 'exact' })
  ]);
  const odd = Object.assign(load('pre-mcp'), { tool_name: 'mcp__lonely' }); delete odd.mcp_server;
  const e = fresh().feed(odd, { t: 1 }).events[0];
  assert.equal(e.ev, 'tool.start'); assert.equal(e.class, 'mcp'); assert.equal(e.tool, 'mcp__lonely');
});

test('an MCP argument named path, file_path, url or uri gives a touch with op unknown', () => {
  const p = Object.assign(load('pre-mcp'), { tool_input: { path: 'src/x.js', file_path: '/home/example/proj/y.js', url: 'https://api.example.com/v1/items?token=1', uri: 'db://cluster/table', other: '/home/example/proj/z.js' } });
  const touches = fresh().feed(p, { t: 1 }).events.slice(1);
  const base = { turn: PID, call: call(4), op: 'unknown' };
  const src = 'args:mcp__example_srv__echo';
  assert.deepEqual(touches, [
    env(1, 'resource.touch', 'derived', src, Object.assign({}, base, { kind: 'file', path: 'src/x.js' })),
    env(1, 'resource.touch', 'derived', src, Object.assign({}, base, { kind: 'file', path: 'y.js' })),
    env(1, 'resource.touch', 'derived', src, Object.assign({}, base, { kind: 'url', url: 'https://api.example.com/v1/items' })),
    env(1, 'resource.touch', 'derived', src, Object.assign({}, base, { kind: 'mcp-resource', server: 'example_srv', scheme: 'db' }))
  ]);
});

test('the class of each built-in tool', () => {
  const classes = { Read: 'read', Write: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Grep: 'search', Glob: 'search', Bash: 'execute', PowerShell: 'execute', WebFetch: 'fetch', WebSearch: 'fetch', Agent: 'agent', Task: 'agent', AskUserQuestion: 'ask', ToolSearch: 'other', TodoWrite: 'other', constructor: 'other' };
  for (const [tool, cls] of Object.entries(classes)) {
    const e = fresh().feed(Object.assign(load('pre-bash'), { tool_name: tool, tool_input: {} }), { t: 1 }).events[0];
    assert.equal(e.class, cls, tool);
  }
});

test('PermissionRequest and a permission Notification give wait.start; the call\'s end gives wait.end allowed first', () => {
  const n = fresh();
  assert.deepEqual(n.feed(load('pre-bash'), { t: 1000 }).events, [
    hook(1000, 'tool.start', 'PreToolUse', { call: call(5), tool: 'Bash', class: 'execute', hash: hashOf('pre-bash') })
  ]);
  assert.deepEqual(n.feed(load('permission-request'), { t: 1100 }).events, [
    hook(1100, 'wait.start', 'PermissionRequest', { why: 'permission', tool: 'Bash', hash: hashOf('pre-bash') })
  ]);
  assert.deepEqual(n.feed(load('notification-permission'), { t: 1200 }).events, [hook(1200, 'wait.start', 'Notification', { why: 'permission' })]);
  // A parallel call ending says nothing about the wait: it is tied to the Bash call.
  n.feed(load('pre-read'), { t: 1300 });
  assert.deepEqual(n.feed(load('post-read'), { t: 1400 }).events.map(e => e.ev), ['tool.end']);
  assert.deepEqual(n.feed(load('post-bash'), { t: 5000 }).events, [
    env(5000, 'wait.end', 'derived', 'hook:PostToolUse', { turn: PID, why: 'permission', answer: 'allowed' }),
    hook(5000, 'tool.end', 'PostToolUse', { call: call(5), tool: 'Bash', ok: true, ms: 40, msGrade: 'exact' })
  ]);
});

test('PermissionDenied gives tool.end denied, and wait.end refused', () => {
  const n = fresh();
  n.feed(load('pre-fetch'), { t: 1000 });
  n.feed(Object.assign(load('permission-request'), { tool_name: 'WebFetch', tool_input: load('pre-fetch').tool_input }), { t: 1100 });
  assert.deepEqual(n.feed(load('permission-denied'), { t: 1300 }).events, [
    env(1300, 'wait.end', 'derived', 'hook:PermissionDenied', { turn: PID, why: 'permission', answer: 'refused' }),
    hook(1300, 'tool.end', 'PermissionDenied', { call: call(6), tool: 'WebFetch', ok: false, ms: 300, msGrade: 'derived', error: 'denied', interrupted: false })
  ]);
});

test('Notification types: idle and question waits; any other type gives nothing; a prompt ends the wait', () => {
  const n = fresh();
  assert.deepEqual(n.feed(load('notification-idle'), { t: 1000 }).events, [hook(1000, 'wait.start', 'Notification', { why: 'idle' })]);
  for (const type of ['elicitation_dialog', 'agent_needs_input']) {
    assert.deepEqual(fresh().feed(Object.assign(load('notification-idle'), { notification_type: type }), { t: 1 }).events, [hook(1, 'wait.start', 'Notification', { why: 'question' })]);
  }
  for (const type of ['auth_success', 'agent_completed', '', 7]) {
    const out = fresh().feed(Object.assign(load('notification-idle'), { notification_type: type }), { t: 1 });
    assert.deepEqual(out.events, [], String(type));
  }
  const prompt = Object.assign(load('user-prompt-submit'), { prompt_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  assert.deepEqual(n.feed(prompt, { t: 2000 }).events, [
    env(2000, 'wait.end', 'derived', 'hook:UserPromptSubmit', { turn: PID, why: 'idle', answer: 'unknown' }),
    hook(2000, 'turn.start', 'UserPromptSubmit', { turn: prompt.prompt_id, chars: prompt.prompt.length })
  ]);
});

test('AskUserQuestion opens a question wait that its own end answers', () => {
  const n = fresh();
  assert.deepEqual(n.feed(load('pre-ask'), { t: 1000 }).events, [
    hook(1000, 'tool.start', 'PreToolUse', { call: call(9), tool: 'AskUserQuestion', class: 'ask', hash: hashOf('pre-ask') }),
    env(1000, 'wait.start', 'derived', 'hook:PreToolUse', { turn: PID, why: 'question', tool: 'AskUserQuestion' })
  ]);
  assert.deepEqual(n.feed(load('post-ask'), { t: 4000 }).events, [
    env(4000, 'wait.end', 'derived', 'hook:PostToolUse', { turn: PID, why: 'question', answer: 'answered' }),
    hook(4000, 'tool.end', 'PostToolUse', { call: call(9), tool: 'AskUserQuestion', ok: true, ms: 3000, msGrade: 'exact' })
  ]);
});

test('a subagent: its start names the open Agent call, its calls carry by, its stop', () => {
  const n = fresh();
  assert.equal(n.feed(load('pre-agent'), { t: 1000 }).events[0].class, 'agent');
  assert.deepEqual(n.feed(load('subagent-start'), { t: 1100 }).events, [
    hook(1100, 'subagent.start', 'SubagentStart', { sub: SUB, type: 'general-purpose', parentCall: call(7) })
  ]);
  const grep = load('pre-grep-sub');
  assert.deepEqual(n.feed(grep, { t: 1200 }).events, [
    hook(1200, 'tool.start', 'PreToolUse', { by: SUB, call: call(8), tool: 'Grep', class: 'search', hash: saltedHash('Grep', grep.tool_input) }),
    env(1200, 'resource.touch', 'derived', 'args:Grep', { turn: PID, by: SUB, call: call(8), kind: 'dir', op: 'search', path: '.' })
  ]);
  assert.deepEqual(n.feed(load('post-grep-sub'), { t: 1300 }).events, [hook(1300, 'tool.end', 'PostToolUse', { by: SUB, call: call(8), tool: 'Grep', ok: true, ms: 5, msGrade: 'exact' })]);
  assert.deepEqual(n.feed(load('subagent-stop'), { t: 1400 }).events, [hook(1400, 'subagent.stop', 'SubagentStop', { sub: SUB, type: 'general-purpose' })]);
  assert.deepEqual(n.feed(load('post-agent'), { t: 1500 }).events, [hook(1500, 'tool.end', 'PostToolUse', { call: call(7), tool: 'Agent', ok: true, ms: 900, msGrade: 'exact' })]);
  assert.equal(fresh().feed(load('subagent-start'), { t: 1 }).events[0].parentCall, undefined, 'no open Agent call: no parentCall');
});

test('parallel Agent calls: each subagent claims the earliest unclaimed one', () => {
  const n = fresh();
  n.feed(load('pre-agent'), { t: 1 });
  n.feed(Object.assign(load('pre-agent'), { tool_use_id: call(70), tool_name: 'Task' }), { t: 2 });
  assert.equal(n.feed(load('subagent-start'), { t: 3 }).events[0].parentCall, call(7));
  assert.equal(n.feed(Object.assign(load('subagent-start'), { agent_id: 'a1111111111111111' }), { t: 4 }).events[0].parentCall, call(70));
  assert.equal(n.feed(load('subagent-start'), { t: 5 }).events[0].parentCall, call(7), 'a repeated start names the same parent');
});

test('parallel calls interleave and pair by tool_use_id only', () => {
  const n = fresh();
  const a = load('pre-read'), b = Object.assign(load('pre-read'), { tool_use_id: call(11), tool_input: { file_path: '/home/example/proj/src/c.js' } });
  const strip = p => { const q = Object.assign({}, p, { hook_event_name: p.hook_event_name }); delete q.duration_ms; return q; };
  n.feed(a, { t: 1000 }); n.feed(b, { t: 1100 });
  const endB = n.feed(strip(Object.assign({}, b, { hook_event_name: 'PostToolUse' })), { t: 1500 }).events[0];
  const endA = n.feed(strip(Object.assign({}, a, { hook_event_name: 'PostToolUseFailure', error: 'x' })), { t: 1700 }).events[0];
  assert.deepEqual([endB.call, endB.ok, endB.ms], [call(11), true, 400]);
  assert.deepEqual([endA.call, endA.ok, endA.ms], [call(1), false, 700]);
});

test('identical payloads give identical events, so the hub can drop the repeat', () => {
  const n = fresh();
  const names = ['user-prompt-submit', 'pre-read', 'post-read', 'pre-agent', 'subagent-start', 'pre-grep-sub', 'post-grep-sub', 'subagent-stop', 'post-agent', 'stop'];
  for (const name of names) {
    const first = n.feed(load(name), { t: 5000 }).events;
    const again = n.feed(load(name), { t: 5000 }).events;
    for (const e of again) assert.ok(first.some(f => JSON.stringify(f) === JSON.stringify(e)), name + ': ' + e.ev + ' repeats an event of the first');
  }
  const post = load('post-read'); delete post.duration_ms;
  const m = fresh();
  m.feed(load('pre-read'), { t: 1000 }); m.feed(load('pre-read'), { t: 1001 });
  assert.equal(m.feed(post, { t: 1300 }).events[0].ms, 300, 'a repeated start keeps the first one\'s time');
  assert.equal(m.feed(post, { t: 1301 }).events[0].ms, 300, 'a repeated end keeps the first one\'s duration');
});

test('the turn: prompt_id when the payload has it, else the last one remembered for the session', () => {
  const n = fresh();
  n.feed(load('user-prompt-submit'), { t: 1 });
  const bare = { hook_event_name: 'PreToolUse', session_id: SID, cwd: '/home/example/proj', tool_name: 'Read', tool_input: { file_path: 'src/a.js' }, tool_use_id: call(1) };
  assert.equal(n.feed(bare, { t: 2 }).events[0].turn, PID);
  n.feed(load('stop'), { t: 3 });
  assert.equal(n.feed(Object.assign({}, bare, { tool_use_id: call(2) }), { t: 4 }).events[0].turn, undefined, 'after the turn ended no turn is assumed');
});

test('a transcript payload: every event derived, src transcript:<Event>, at, and ms from the two at times', () => {
  const n = fresh();
  const pre = { hook_event_name: 'PreToolUse', session_id: SID, cwd: '/home/example/proj', tool_name: 'Read', tool_input: { file_path: '/home/example/proj/src/a.js' }, tool_use_id: call(1), _wy: { src: 'transcript', at: 5000 } };
  const out = n.feed(pre, { t: 9000 });
  assert.equal(out.source, 'transcript');
  assert.deepEqual(out.events, [
    env(9000, 'tool.start', 'derived', 'transcript:PreToolUse', { at: 5000, call: call(1), tool: 'Read', class: 'read', hash: saltedHash('Read', pre.tool_input) }),
    env(9000, 'resource.touch', 'derived', 'transcript:PreToolUse', { at: 5000, call: call(1), kind: 'file', op: 'read', path: 'src/a.js' })
  ]);
  const post = Object.assign({}, pre, { hook_event_name: 'PostToolUseFailure', _wy: { src: 'transcript', at: 5400 } });
  assert.deepEqual(n.feed(post, { t: 9700 }).events, [
    env(9700, 'tool.end', 'derived', 'transcript:PostToolUseFailure', { at: 5400, call: call(1), tool: 'Read', ok: false, ms: 400, msGrade: 'derived', error: 'tool_error', interrupted: false })
  ]);
  const mcp = Object.assign({}, pre, { tool_name: 'mcp__example_srv__echo', tool_input: {}, tool_use_id: call(2), _wy: { src: 'transcript', at: 'soon' } });
  const e = n.feed(mcp, { t: 1 }).events[0];
  assert.deepEqual([e.ev, e.grade, e.server, e.at], ['mcp.start', 'derived', 'example_srv', undefined]);
});

test('any other event gives no events, and the session is still named', () => {
  const out = fresh().feed(Object.assign(load('user-prompt-submit'), { hook_event_name: 'PostToolBatch', tool_calls: [] }), { t: 1 });
  assert.deepEqual([out.key, out.events], [KEY, []]);
  const noCwd = load('user-prompt-submit'); delete noCwd.cwd;
  const bare = fresh().feed(noCwd, { t: 1 });
  assert.deepEqual([bare.cwd, bare.root, bare.events[0].ws], [null, null, '']);
});

test('Grok\'s camelCase shape and Antigravity\'s shape return null, whatever the hint says', () => {
  const n = fresh();
  const grok = { hookEventName: 'PreToolUse', hook_event_name: 'PreToolUse', sessionId: SID, cwd: '/home/example/proj', toolName: 'read_file', toolInput: {}, toolUseId: 'x' };
  const grokWithSnake = Object.assign({}, grok, { session_id: SID });
  const antigravity = { conversationId: 'c-1', workspacePaths: ['/home/example/proj'], toolCall: { name: 'view_file', args: {} }, stepIdx: 3 };
  for (const p of [grok, grokWithSnake, antigravity]) for (const hint of ['claude', 'grok', 'antigravity', undefined]) assert.equal(n.feed(p, { t: 1, hint }), null);
  assert.equal(n.size(), 0, 'a refused payload leaves nothing remembered');
});

test('junk payloads never throw', () => {
  const n = fresh();
  const huge = 'x'.repeat(3 * 1024 * 1024);
  const nasty = {};
  Object.defineProperty(nasty, 'hook_event_name', { enumerable: true, get() { throw new Error('boom'); } });
  const trap = new Proxy({}, { get() { throw new Error('trap'); }, has() { throw new Error('trap'); }, getOwnPropertyDescriptor() { throw new Error('trap'); }, ownKeys() { throw new Error('trap'); } });
  const deep = {}; let at = deep; for (let i = 0; i < 2000; i++) { at.x = {}; at = at.x; }
  const junk = [
    null, undefined, 0, 1, 'PreToolUse', true, [], [load('pre-read')], {}, () => 1, Symbol('x'), 10n, nasty, trap,
    { hook_event_name: 5, session_id: SID }, { hook_event_name: 'PreToolUse' }, { session_id: SID }, { hook_event_name: 'PreToolUse', session_id: '' },
    { hook_event_name: 'PreToolUse', session_id: {} }, { hook_event_name: '   ', session_id: SID },
    Object.assign(load('pre-read'), { tool_input: 'not an object' }), Object.assign(load('pre-read'), { tool_input: null }),
    Object.assign(load('pre-read'), { tool_input: [1, 2] }), Object.assign(load('pre-read'), { tool_input: { file_path: 42 } }),
    Object.assign(load('pre-read'), { tool_input: { file_path: huge } }), Object.assign(load('pre-read'), { tool_name: huge }),
    Object.assign(load('pre-read'), { tool_name: ['Read'] }), Object.assign(load('pre-read'), { tool_use_id: { id: 1 } }),
    Object.assign(load('pre-read'), { cwd: 42 }), Object.assign(load('pre-read'), { cwd: 'relative/dir' }), Object.assign(load('pre-read'), { cwd: huge }),
    Object.assign(load('pre-read'), { session_id: huge }), Object.assign(load('pre-read'), { tool_input: deep }),
    Object.assign(load('pre-mcp'), { mcp_server: 'not an object' }), Object.assign(load('pre-mcp'), { mcp_server: { name: 7, source: [] } }),
    Object.assign(load('pre-mcp'), { tool_name: 'mcp__' }), Object.assign(load('pre-mcp'), { tool_name: 'mcp____' }),
    Object.assign(load('pre-fetch'), { tool_input: { url: 'https://' + huge } }), Object.assign(load('pre-fetch'), { tool_input: { url: 'not a url' } }),
    Object.assign(load('post-read'), { duration_ms: 'fast' }), Object.assign(load('post-read'), { duration_ms: -5 }), Object.assign(load('post-read'), { duration_ms: Infinity }),
    Object.assign(load('stop'), { last_assistant_message: { text: '?' } }), Object.assign(load('stop'), { last_assistant_message: huge + '?' }),
    Object.assign(load('session-start'), { model: { id: 'claude-example-2' } }), Object.assign(load('session-start'), { model: 12 }),
    Object.assign(load('subagent-start'), { agent_id: 12 }), Object.assign(load('notification-idle'), { notification_type: { a: 1 } }),
    Object.assign(load('user-prompt-submit'), { _wy: 'transcript' }), Object.assign(load('user-prompt-submit'), { _wy: { src: 'transcript', at: NaN } }),
    JSON.parse('{"hook_event_name":"PreToolUse","session_id":"s","__proto__":{"tool_name":"Read","tool_use_id":"x"}}'),
    Object.assign(Object.create({ tool_name: 'Read', tool_use_id: 'x' }), { hook_event_name: 'PreToolUse', session_id: 's' })
  ];
  for (const p of junk) {
    let out;
    assert.doesNotThrow(() => { out = n.feed(p, { t: 1 }); });
    if (out === null) continue;
    assert.ok(Array.isArray(out.events));
    for (const e of out.events) M.validate(e);
  }
  for (const opts of [undefined, null, 5, { t: 'x' }, { t: NaN }]) assert.doesNotThrow(() => n.feed(load('pre-read'), opts));
  const timeless = n.feed(load('pre-read'), undefined).events[0];
  assert.ok(Number.isFinite(timeless.t), 'with no arrival time, now is used');
  const inherited = n.feed(junk[junk.length - 1], { t: 1 });
  assert.deepEqual(inherited.events, [], 'inherited fields are never read');
  const ns = fresh();
  const longName = ns.feed(Object.assign(load('pre-read'), { tool_name: 'T'.repeat(500) }), { t: 1 }).events[0];
  assert.match(longName.tool, /^unnamed-[0-9a-f]{6}$/, 'a name longer than a name can be is replaced, not cut');
  M.validate(longName);
});

test('memory is bounded: 200 sessions, least recent out first; 200 calls per session', () => {
  const n = fresh();
  // Each session opens an idle wait; whether a prompt then ends it shows whether the session is remembered.
  const idle = i => Object.assign(load('notification-idle'), { session_id: 'session-' + i });
  const prompt = i => Object.assign(load('user-prompt-submit'), { session_id: 'session-' + i });
  for (let i = 0; i < 150; i++) n.feed(idle(i), { t: i });
  n.feed(idle(0), { t: 150 });                         // session 0 is used again: it is now the most recent
  for (let i = 150; i < 260; i++) n.feed(idle(i), { t: i });
  assert.equal(n.size(), MAX_SESSIONS);
  assert.equal(n.feed(prompt(0), { t: 301 }).events[0].ev, 'wait.end', 'session 0 was used recently: remembered');
  assert.equal(n.feed(prompt(61), { t: 302 }).events[0].ev, 'wait.end', 'the oldest that fits is still there');
  assert.equal(n.feed(prompt(1), { t: 303 }).events[0].ev, 'turn.start', 'session 1 was among the least recent: forgotten');
  assert.equal(n.size(), MAX_SESSIONS);
  n.forget('claude:session-0');
  assert.equal(n.size(), MAX_SESSIONS - 1);
  n.forget('session-61');
  assert.equal(n.size(), MAX_SESSIONS - 2, 'a bare session id is accepted too');
  n.forget(42);

  const c = fresh();
  const post = load('post-read'); delete post.duration_ms;
  for (let i = 0; i < 260; i++) c.feed(Object.assign(load('pre-read'), { tool_use_id: 'call-' + i }), { t: 1000 + i });
  assert.equal(c.feed(Object.assign({}, post, { tool_use_id: 'call-0' }), { t: 5000 }).events[0].ms, undefined, 'the oldest call was forgotten');
  assert.equal(c.feed(Object.assign({}, post, { tool_use_id: 'call-259' }), { t: 5000 }).events[0].ms, 5000 - 1259, 'a recent call is remembered');
  assert.equal(MAX_CALLS, 200);
  // An open Agent call outlives two hundred calls that ended inside it.
  const a = fresh();
  a.feed(load('pre-agent'), { t: 1 });
  for (let i = 0; i < 300; i++) {
    a.feed(Object.assign(load('pre-grep-sub'), { tool_use_id: 'sub-' + i }), { t: 2 });
    a.feed(Object.assign(load('post-grep-sub'), { tool_use_id: 'sub-' + i }), { t: 3 });
  }
  const end = load('post-agent'); delete end.duration_ms;
  assert.equal(a.feed(end, { t: 1001 }).events[0].ms, 1000);
});

test('every event of every fixture passes the model\'s check', () => {
  const names = fs.readdirSync(FIX).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
  let count = 0;
  for (const name of names) {
    const data = load(name);
    const n = fresh();
    for (const p of Array.isArray(data) ? data : [data]) for (const e of n.feed(p, { t: 1000 + count }).events) { M.validate(e); count++; }
  }
  // And with the starts first, so every end, wait and touch is exercised.
  const n = fresh();
  for (const p of load('windows-session')) for (const e of n.feed(p, { t: 2000 }).events) { M.validate(e); count++; }
  assert.ok(count > 40, 'events checked: ' + count);
});

const SESSION = ['session-start', 'user-prompt-submit', 'pre-read', 'post-read', 'pre-write', 'failure-write', 'pre-glob', 'pre-mcp', 'post-mcp',
  'pre-bash', 'permission-request', 'notification-permission', 'post-bash', 'pre-fetch', 'permission-denied', 'pre-agent', 'subagent-start',
  'pre-grep-sub', 'post-grep-sub', 'subagent-stop', 'post-agent', 'pre-ask', 'post-ask', 'stop', 'notification-idle'];

function replay(payloads, ws) {
  const n = fresh(), model = M.create(), all = [];
  payloads.forEach((p, i) => { for (const e of n.feed(p, { t: 1000 + i * 100 }).events) { model.apply(e); all.push(e); } });
  const key = KEY;
  assert.ok(model.nodes.has('a:' + key), 'the agent');
  assert.equal(model.nodes.get('a:' + key).label, 'claude proj', 'named after its root');
  assert.equal(model.nodes.get('a:' + key).ws, ws);
  assert.equal(model.nodes.get('a:' + key).collector, true);
  assert.ok(model.nodes.has('t:' + key + ':Read'), 'a tool node');
  const file = model.nodes.get('r:' + key + ':file:src/');
  assert.ok(file && file.members.has('a.js') && file.members.has('b.js'), 'a file resource with its files');
  assert.ok(model.nodes.has('r:' + key + ':file:./'), 'the folder a search covered');
  assert.ok(model.nodes.has('r:' + key + ':url:docs.example.com'), 'the fetched host');
  const server = model.nodes.get('m:example_srv');
  assert.ok(server && server.ports.has('echo'), 'an MCP server with a port');
  assert.equal(server.source, 'dynamic');
  const sub = model.nodes.get('s:' + key + ':' + SUB);
  assert.ok(sub, 'a subagent');
  assert.equal(sub.parentCall, call(7));
  assert.equal(sub.status, 'done');
  const write = model.nodes.get('t:' + key + ':Write');
  assert.equal(write.failed, 1, 'a failed mark');
  assert.equal(write.status, 'failed');
  assert.equal(model.nodes.get('t:' + key + ':WebFetch').lastError, 'denied');
  assert.equal(model.sessions.get(key).calls.size, 1, 'only the Glob call is still open: its end never came');
  return all;
}

test('a full POSIX session replayed into the model draws the expected scene', () => {
  replay(SESSION.map(load), 'wsposix00001');
});

test('a full Windows session, with backslash paths, draws the same scene on this machine', () => {
  // The file ends with StopFailure and SessionEnd; the end would close every call, so they are left out here.
  const all = replay(load('windows-session').filter(p => p.hook_event_name !== 'StopFailure' && p.hook_event_name !== 'SessionEnd'), 'wswin0000001');
  const text = JSON.stringify(all);
  // A drive letter that opens a string value (so "https://" does not count), or any backslash at all.
  assert.ok(!/"[A-Za-z]:[\\/]/.test(text) && !text.includes('\\'), 'no Windows path in any event');
  assert.ok(all.some(e => e.path === 'src/a.js'), 'the relative path uses forward slashes');
});

test('with the real rootInfo, a folder holding .git is the root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-'));
  try {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, 'pkg'));
    const n = createNormaliser();
    const p = Object.assign(load('pre-read'), { cwd: path.join(dir, 'pkg'), tool_input: { file_path: path.join(dir, 'pkg', 'x.js') } });
    const out = n.feed(p, { t: 1 });
    assert.equal(out.root.root, contract.lexical(dir));
    assert.equal(out.events[0].ws, contract.wsKey(dir));
    assert.equal(out.events[1].path, 'pkg/x.js');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
