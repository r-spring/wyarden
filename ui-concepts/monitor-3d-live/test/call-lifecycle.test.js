'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const M = require('../media/model.js');
const Nav = require('../media/nav.js');
const { createNormaliser } = require('../lib/normalise.js');
const codexAdapter = require('../lib/providers/codex.js');
const antigravityAdapter = require('../lib/providers/antigravity.js');

const cwd = 'C:\\Work\\monitor-fixture';
const first = '01900000-0000-7000-8000-000000000001';
const second = '01900000-0000-7000-8000-000000000002';

function fixture() {
  const normaliser = createNormaliser({ adapters: [codexAdapter.createAdapter(), antigravityAdapter.createAdapter()],
    rootInfo: () => ({ root: cwd, real: cwd, ws: 'fixture', name: 'fixture' }) });
  let t = 0;
  return (model, route, payload) => {
    const receipt = normaliser.feed(payload, { route, source: 'hook', t: ++t });
    assert.ok(receipt, 'the production normaliser accepts the native fixture');
    for (const e of receipt.events) model.apply(e);
  };
}

function codex(hook_event_name, turn_id, fields = {}) {
  return { hook_event_name, turn_id, session_id: first, cwd, transcript_path: null,
    model: 'fixture', permission_mode: 'default', ...fields };
}

const shell = (event, turn, id, fields) => codex(event, turn, { tool_name: 'Bash', tool_use_id: id, ...fields });
const codexKey = 'codex:' + first;
const agentOf = model => model.nodes.get('a:' + codexKey);
const bashOf = model => model.nodes.get('t:' + codexKey + ':Bash');
const historyOf = model => model.sessions.get(codexKey).history;
const counts = node => [node.calls, node.open, node.failed, node.status];

test('Codex 0.172.0 Bash start with no post closes only on its completed turn, with an unknown result', () => {
  const send = fixture(), model = M.create();
  const apply = e => send(model, 'codex', e);
  // Scrubbed denied-read sequence: Bash pre-hook, no tool post, then the turn reaches its boundary.
  apply(codex('UserPromptSubmit', 'denied-turn'));
  apply(shell('PreToolUse', 'denied-turn', 'denied-read'));
  assert.deepEqual(counts(agentOf(model)), [1, 1, 0, 'working']);
  assert.deepEqual(counts(bashOf(model)), [1, 1, 0, 'working']);
  assert.equal(model.links.size, 1);
  const restored = M.load(model.serialize());
  for (const target of [model, restored]) {
    send(target, 'codex', codex('Stop', 'denied-turn'));
    assert.deepEqual(counts(agentOf(target)), [1, 0, 0, 'idle']);
    assert.deepEqual(counts(bashOf(target)), [1, 0, 0, 'rest']);
    assert.equal(bashOf(target).lastOk, null);
    assert.equal(bashOf(target).lastMs, null);
    assert.deepEqual(historyOf(target).map(({ call, ok }) => [call, ok]), [['denied-read', null]]);
    assert.deepEqual(target.takeClosed().map(({ call, ok }) => [call, ok]), [['denied-read', null]]);
    assert.equal(target.links.size, 0);
    assert.match(Nav.describe(agentOf(target), target).lists[0].items[0], /end not observed/);
    assert.deepEqual(Nav.describe(bashOf(target), target).facts.find(([label]) => label === 'Last call'),
      ['Last call', 'end not observed']);
  }
});

test('a late Codex post corrects the original call once after restore and leaves other turns and sessions open', () => {
  const send = fixture();
  let model = M.create();
  const apply = e => send(model, 'codex', e);
  apply(codex('UserPromptSubmit', 'older'));
  apply(shell('PreToolUse', 'older', 'late-read'));
  apply(codex('UserPromptSubmit', 'newer'));
  apply(shell('PreToolUse', 'newer', 'good-read'));
  apply(shell('PreToolUse', 'older', 'late-read', { session_id: second }));
  apply(codex('Interrupt', 'older'));
  assert.deepEqual(counts(agentOf(model)), [2, 1, 0, 'working']);
  assert.equal(agentOf(model).turn, 'newer');
  assert.deepEqual(counts(bashOf(model)), [2, 1, 0, 'working']);
  assert.deepEqual([...model.links.values()].map(link => [link.session, link.call]),
    [[codexKey, 'good-read'], ['codex:' + second, 'late-read']]);
  assert.deepEqual(historyOf(model).map(c => [c.call, c.ok]), [['late-read', null]]);
  model = M.load(model.serialize());
  const late = shell('PostToolUse', 'older', 'late-read', { tool_response: { exit_code: 5 } });
  apply(late);
  model = M.load(model.serialize());
  apply(late);
  assert.deepEqual(counts(agentOf(model)), [2, 1, 1, 'working']);
  assert.deepEqual(counts(bashOf(model)), [2, 1, 1, 'working']);
  assert.deepEqual(historyOf(model).map(c => [c.call, c.ok, c.error, c.ms]), [['late-read', false, 'tool_error', 5]]);
  assert.deepEqual(model.takeClosed(), [], 'a late post does not close a second link');
  apply(shell('PostToolUse', 'newer', 'good-read', { tool_response: { exit_code: 0 } }));
  apply(codex('Stop', 'newer'));
  assert.deepEqual(counts(agentOf(model)), [2, 0, 1, 'idle']);
  assert.deepEqual(counts(bashOf(model)), [2, 0, 1, 'rest']);
  assert.equal(bashOf(model).lastOk, true);
  assert.deepEqual(historyOf(model).map(c => [c.call, c.ok]), [['late-read', false], ['good-read', true]]);
  assert.deepEqual([...model.links.values()].map(link => link.session), ['codex:' + second]);
});

test('a late Codex MCP error preserves the newer turn’s wait and the newer call’s result', () => {
  const send = fixture(), model = M.create();
  const apply = e => send(model, 'codex', e);
  const mcp = (event, turn, id, fields) => codex(event, turn, { tool_name: 'mcp__fixture__read', tool_use_id: id, ...fields });
  apply(codex('UserPromptSubmit', 'older'));
  apply(mcp('PreToolUse', 'older', 'old-mcp'));
  apply(codex('UserPromptSubmit', 'newer'));
  apply(mcp('PermissionRequest', 'newer', 'new-mcp'));
  apply(mcp('PreToolUse', 'newer', 'new-mcp'));
  apply(codex('Stop', 'older'));
  assert.equal(agentOf(model).wait.why, 'permission');
  assert.deepEqual(counts(agentOf(model)), [2, 1, 0, 'needs']);
  const server = model.nodes.get('m:fixture');
  assert.deepEqual(counts(server), [2, 1, 0, 'working']);
  assert.equal(server.ports.get('read').open, 1);
  apply(mcp('PostToolUse', 'newer', 'new-mcp', { tool_response: { isError: false } }));
  apply(codex('Stop', 'newer'));
  apply(mcp('PostToolUse', 'older', 'old-mcp', { tool_response: { isError: true } }));
  assert.deepEqual(counts(server), [2, 0, 1, 'rest']);
  assert.equal(server.lastOk, true);
  assert.deepEqual(server.ports.get('read'), { name: 'read', calls: 2, open: 0, failed: 1 });
  assert.deepEqual(historyOf(model).map(c => [c.call, c.ok]), [['old-mcp', false], ['new-mcp', true]]);
});

test('a late Codex post still pairs after the displayed call history rolls over', () => {
  const send = fixture();
  let model = M.create();
  const apply = e => send(model, 'codex', e);
  apply(shell('PreToolUse', 'older', 'late-read'));
  apply(codex('Stop', 'older'));
  for (let i = 0; i < 51; i++) apply(shell('PostToolUse', 'newer', 'read-' + i, { tool_response: { exit_code: 0 } }));
  assert.equal(historyOf(model).some(c => c.call === 'late-read'), false);
  model = M.load(model.serialize());
  const late = shell('PostToolUse', 'older', 'late-read', { tool_response: { exit_code: 5 } });
  apply(late);
  apply(late);
  assert.deepEqual(counts(bashOf(model)), [52, 0, 1, 'rest']);
  assert.equal(bashOf(model).lastOk, true);
  assert.equal(historyOf(model).some(c => c.call === 'late-read'), false);
});

test('Antigravity sessions with the same native step keep both drawable tool and resource links after restore', () => {
  const send = fixture(), model = M.create();
  const apply = (m, event, session) => send(m, 'antigravity', {
    hookEventName: event, conversationId: session, workspacePaths: [cwd], stepIdx: 3,
    toolCall: { name: 'view_file', args: { AbsolutePath: cwd + '\\src\\readme.txt' } }
  });
  apply(model, 'PreToolUse', first);
  apply(model, 'PreToolUse', second);
  const pictures = m => [...m.links.values()].map(l => [l.session, l.kind, l.call, m.visibleId(l.from), m.visibleId(l.to)]);
  const expected = [first, second].flatMap(session => {
    const key = 'antigravity:' + session;
    return [[key, 'tool', 'step-3', 'a:' + key, 't:' + key + ':view_file'],
      [key, 'touch', 'step-3', 't:' + key + ':view_file', 'r:' + key + ':file:src/']];
  });
  assert.deepEqual(pictures(model), expected);
  const saved = model.serialize();
  const legacy = JSON.parse(saved).state;
  const legacyIds = new Map(legacy.links.$map.map(([id, link]) => [id, link.kind === 'touch' ? link.call + ' > ' + link.to : link.call]));
  // The older snapshot had just the second session's primary link, plus both resource links.
  legacy.links.$map = [...new Map(legacy.links.$map.map(([id, link]) => [legacyIds.get(id), { ...link, id: legacyIds.get(id) }]))];
  for (const [, session] of legacy.sessions.$map) for (const [, call] of session.calls.$map) call.links = call.links.map(id => legacyIds.get(id));
  for (const loaded of [M.load(saved), M.load(JSON.stringify({ v: 1, state: legacy }))]) {
    assert.deepEqual(pictures(loaded).sort(), expected.slice().sort());
    apply(loaded, 'PostToolUse', first);
    assert.deepEqual(pictures(loaded), expected.slice(2));
    assert.deepEqual(loaded.takeClosed().map(l => [l.session, l.kind]), expected.slice(0, 2).map(l => l.slice(0, 2)));
    assert.equal(loaded.sessions.get('antigravity:' + second).calls.get('step-3').links.length, 2);
    assert.equal(loaded.nodes.get(expected[3][4]).open, 1);
    apply(loaded, 'PostToolUse', second);
    assert.equal(loaded.links.size, 0);
    assert.equal(loaded.nodes.get(expected[3][4]).open, 0);
  }
});
