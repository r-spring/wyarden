'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const contract = require('../lib/contract.js');
const { createNormaliser } = require('../lib/normalise.js');
const { startHub } = require('../lib/hub-server.js');
const grok = require('../lib/providers/grok.js');

const SID = 'sample-grok-session';
const ROOT = 'C:\\example\\workspace';
const SENT = '2026-11-28T00:00:00.123Z';
const nameOf = {
  SessionStart: 'session_start', SessionEnd: 'session_end', UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use', PostToolUse: 'post_tool_use', PostToolUseFailure: 'post_tool_use_failure',
  Stop: 'stop', StopFailure: 'stop_failure', StopCancelled: 'stop_cancelled',
  Notification: 'notification', PermissionDenied: 'permission_denied'
};

// Grok 1.0.92 sends the same dual-key envelope to native and Claude-compatible hooks.
function payload(event, extra = {}) {
  return {
    hookEventName: nameOf[event], hook_event_name: event, sessionId: SID, session_id: SID,
    cwd: ROOT, workspaceRoot: ROOT, timestamp: SENT, ...extra
  };
}

const read = {
  toolName: 'read_file', tool_name: 'read_file', toolUseId: 'call-1', tool_use_id: 'call-1',
  toolInput: { target_file: 'src/fixture.txt', offset: 1 }
};

const router = () => createNormaliser({ adapters: [grok.createAdapter()] });
const feed = (normaliser, body, route = 'grok') => normaliser.feed(body, { route, source: 'hook', t: 42 });
const eventTypes = out => out.events.map(event => event.ev);

function temporaryHome(t) {
  const base = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(base, 'wyarden-grok-test-'));
  t.after(() => {
    assert.equal(path.dirname(dir), base);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('the shared router distinguishes Grok aliases from a real same-ID Claude hook', () => {
  const normaliser = router();
  const bothKeys = payload('PreToolUse', read);
  for (const route of ['grok', 'claude']) {
    const out = feed(normaliser, bothKeys, route);
    assert.equal(out.key, 'grok:' + SID);
    assert.deepEqual(eventTypes(out), ['tool.start', 'resource.touch']);
    assert.equal(out.events[0].at, Date.parse(SENT));
  }
  const aliasOnly = { sessionId: SID, cwd: ROOT, hook_event_name: 'PreToolUse', tool_name: 'read_file', tool_use_id: 'call-1' };
  assert.equal(feed(normaliser, aliasOnly, 'claude').events[0].call, 'call-1');
  const nativeOnly = { sessionId: SID, cwd: ROOT, hookEventName: 'sessionStart' };
  assert.equal(feed(normaliser, nativeOnly).events[0].ev, 'session.start');
  const claude = { hook_event_name: 'SessionStart', session_id: SID, cwd: ROOT };
  assert.equal(feed(normaliser, claude, 'claude').key, 'claude:' + SID);
  assert.equal(feed(normaliser, claude), null);
  assert.equal(feed(normaliser, { ...bothKeys, session_id: 'inconsistent' }, 'claude'), null);
  assert.equal(feed(normaliser, { ...bothKeys, hook_event_name: 'PostToolUse' }, 'claude'), null);
  assert.equal(normaliser.feed(bothKeys, { source: 'transcript' }), null);
});

test('Grok lifecycle closes calls and distinguishes genuine turn completion, interruption and teardown', () => {
  const normaliser = router();
  const send = (event, extra) => feed(normaliser, payload(event, extra)).events;
  assert.deepEqual(send('SessionStart', { source: 'new' }).map(e => [e.ev, e.source]), [['session.start', 'new']]);
  assert.equal(send('UserPromptSubmit', { promptId: 'turn-1' })[0].turn, 'turn-1');
  assert.equal(send('Notification', { notificationType: 'permission_prompt' })[0].why, 'permission');
  assert.deepEqual(send('Notification', { notification_type: 'permission_prompt' }), []);
  assert.deepEqual(send('PostToolUse', { ...read, durationMs: 25 }).map(e => [e.ev, e.ok, e.ms, e.msGrade, e.answer]), [
    ['wait.end', undefined, undefined, undefined, 'allowed'], ['tool.end', true, 25, 'exact', undefined]
  ]);
  assert.equal(send('PostToolUseFailure', read)[0].error, 'tool_error');
  assert.equal(send('PostToolUse', { ...read, toolResult: { FileNotFound: 'ignored' } })[0].ok, false);
  assert.equal(send('PermissionDenied', read)[0].error, 'denied');
  assert.equal(send('Stop', { reason: 'end_turn', promptId: 'turn-1' })[0].outcome, 'done');
  assert.equal(send('StopCancelled', { promptId: 'turn-2' })[0].outcome, 'interrupted');
  assert.equal(send('StopFailure', { promptId: 'turn-3' })[0].outcome, 'failed');
  assert.equal(send('SessionEnd', { reason: 'shutdown' })[0].ev, 'session.end');
  assert.deepEqual(send('Stop', { reason: 'shutdown' }), []);
  assert.equal(send('SessionStart', { source: 'load' })[0].source, 'load');
});

test('only observed tool argument keys produce sanitized resource touches', () => {
  const normaliser = router();
  const tool = (toolName, toolInput, extra) => feed(normaliser, payload('PreToolUse', {
    toolName, toolUseId: 'a-call', toolInput, ...extra
  })).events;
  assert.equal(tool('read_file', { file_path: 'unobserved.txt' }).length, 1);
  const inner = tool('read_file', { target_file: 'src/fixture.txt' })[1];
  assert.deepEqual([inner.kind, inner.op, inner.path, inner.grade], ['file', 'read', 'src/fixture.txt', 'derived']);
  const outer = tool('read_file', { target_file: 'D:\\private\\other\\outside.txt' })[1];
  assert.deepEqual(outer.path, { outside: true, name: 'outside.txt' });
  assert.equal(tool('read_file', { target_file: 'hidden.txt [truncated]' }).length, 1);
  const readDir = tool('list_dir', { target_directory: 'src' })[1];
  assert.deepEqual([readDir.kind, readDir.op, readDir.path], ['dir', 'read', 'src']);
  const search = tool('grep', { path: 'src', pattern: 'private-query-sentinel' })[1];
  assert.deepEqual([search.kind, search.op, search.path], ['dir', 'search', 'src']);
  const edit = tool('search_replace', { file_path: 'fixture.txt', new_string: 'private-text-sentinel' })[1];
  assert.deepEqual([edit.kind, edit.op, edit.path], ['file', 'write', 'fixture.txt']);
  const mcp = tool('local_server__lookup', { path: 'unverified-mcp-key' });
  assert.deepEqual(mcp.map(e => [e.ev, e.server, e.tool, e.grade]), [['mcp.start', 'local_server', 'lookup', 'derived']]);
  for (const item of [
    payload('UserPromptSubmit', { prompt: 'private-prompt-sentinel', transcriptPath: 'C:\\private\\transcript-sentinel' }),
    payload('Stop', { reason: 'end_turn', lastAssistantMessage: 'private-answer-sentinel' }),
    payload('PostToolUse', { ...read, toolResult: { text: 'private-result-sentinel' } }),
    payload('PreToolUse', { ...read, toolName: 'private-command-sentinel /path', toolInput: { command: 'private-shell-sentinel' } }),
    edit, search, outer
  ]) {
    const eventOutput = item.ev ? item : feed(normaliser, item).events;
    assert.doesNotMatch(JSON.stringify(eventOutput), /sentinel|private|unverified-mcp/);
  }
});

test('native setup, repeat setup, stale replacement and exact removal preserve other files', t => {
  const home = temporaryHome(t);
  const dir = path.join(home, '.grok');
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  const sibling = path.join(dir, 'hooks', 'private.json');
  const other = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo unrelated"}]}]}}\r\n';
  fs.writeFileSync(sibling, other);
  const dirs = grok.configDirs({ home, env: {} });
  assert.deepEqual(dirs, [dir]);
  assert.deepEqual(grok.configDirs({ home: __dirname, env: { GROK_HOME: dir } }), [dir]);
  assert.deepEqual(grok.configDirs({ home, env: { GROK_HOME: path.join(home, 'missing') } }), []);
  const hub = { port: 23456, ingest: 'synthetic-ingest' };

  const planned = router().planConfig('grok', hub, { dirs, mode: 'add', commandFor: () => assert.fail('Grok uses HTTP') });
  const [add] = planned.changes;
  assert.equal(add.state, 'missing');
  assert.equal(add.added, 11);
  assert.equal(fs.existsSync(add.file), false);
  assert.equal(grok.apply([{ ...add }])[0].written, false);
  assert.equal(grok.apply([add])[0].written, true);
  const got = JSON.parse(fs.readFileSync(add.file, 'utf8'));
  assert.deepEqual(got.hooks.PreToolUse, [{ hooks: [{ type: 'http', url: contract.hookUrl(hub, 'grok'), timeout: 1 }] }]);
  assert.equal(grok.status(dirs, hub).state, 'installed');
  assert.equal(grok.planConfig(hub, { dirs })[0].changed, false);

  const restart = { ...hub, port: 23457 };
  const [stale] = grok.planConfig(restart, { dirs });
  assert.equal(stale.state, 'stale');
  assert.equal(stale.replaced, 11);
  assert.equal(grok.apply([stale])[0].written, true);
  const [remove] = grok.planConfig(restart, { dirs, mode: 'remove' });
  assert.equal(remove.removed, 11);
  assert.equal(grok.apply([remove])[0].written, true);
  assert.equal(fs.existsSync(add.file), false);
  assert.equal(grok.planConfig(restart, { dirs, mode: 'remove' })[0].changed, false);
  assert.deepEqual(fs.readdirSync(path.dirname(add.file)), ['private.json']);
  assert.equal(fs.readFileSync(sibling, 'utf8'), other);
});

test('a changed plan or unrelated file at the reserved filename is preserved', t => {
  const dir = temporaryHome(t);
  const hub = { port: 23456, ingest: 'synthetic-ingest' };
  const [add] = grok.planConfig(hub, { dirs: [dir] });
  assert.equal(grok.apply([add])[0].written, true);
  const [remove] = grok.planConfig(hub, { dirs: [dir], mode: 'remove' });
  const extra = JSON.parse(add.after);
  extra.hooks.Stop[0].hooks.push({ type: 'command', command: 'echo my-hook' });
  const edited = JSON.stringify(extra, null, 2) + '\n';
  fs.writeFileSync(add.file, edited);
  assert.equal(grok.apply([remove])[0].written, false);
  assert.equal(grok.status([dir], hub).installed, 0);
  assert.equal(grok.status([dir], hub).unreadable, 1);
  for (const mode of ['add', 'remove']) {
    const [conflict] = grok.planConfig(hub, { dirs: [dir], mode });
    assert.equal(conflict.state, 'unreadable');
    assert.equal(grok.apply([conflict])[0].written, false);
    assert.equal(fs.readFileSync(add.file, 'utf8'), edited);
  }
});

test('a real loopback hub renders one Grok call from both hook routes', async t => {
  const home = temporaryHome(t);
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const hub = { v: 1, port, ingest: contract.token(), control: contract.token() };
  const live = await startHub({ home, hub, providerAdapters: [grok.createAdapter()], deps: {
    createNormaliser, claudeConfigDirs: () => [], liveClaudeSessions: () => []
  } });
  t.after(() => live.close());
  live.core.attach({ id: 'test-editor', app: 'Code', name: 'Grok fixture', pid: 1, folders: [{ path: ROOT, name: 'workspace' }], scope: 'all' });

  async function post(route, item) {
    const received = live.core.status().events.received;
    const response = await fetch(contract.hookUrl(hub, route), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item)
    });
    assert.equal(response.status, 200);
    await response.json();
    for (let attempt = 0; attempt < 100 && live.core.status().events.received === received; attempt++) await delay(10);
    assert.equal(live.core.status().events.received, received + 1);
  }

  const model = live.core.models.get('all');
  const agent = () => model.nodes.get('a:grok:' + SID);
  const workspaceRoot = 'C:\\example';
  await post('grok', payload('SessionStart', { workspaceRoot, source: 'new' }));
  assert.ok(agent());
  assert.equal(agent().kind, 'grok');
  const start = payload('PreToolUse', { ...read, workspaceRoot });
  await post('grok', start);
  assert.equal(agent().open, 1);
  await post('claude', start);
  assert.equal(agent().calls, 1);
  assert.equal(agent().open, 1);
  const end = payload('PostToolUse', { ...read, workspaceRoot, durationMs: 5, toolResult: 'private-result-sentinel' });
  await post('claude', end);
  await post('grok', end);
  assert.equal(agent().calls, 1);
  assert.equal(agent().open, 0);
  assert.equal(live.core.status().sessions.shown, 1);
  assert.equal(live.core.status().events.duplicates, 3);
  assert.equal(live.core.status().events.rejected, 0);
  assert.doesNotMatch(JSON.stringify(model.serialize()), /private-result-sentinel/);
});
