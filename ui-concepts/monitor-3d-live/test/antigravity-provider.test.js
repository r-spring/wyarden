'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const contract = require('../lib/contract.js');
const { createHubCore } = require('../lib/hub-core.js');
const { startHub } = require('../lib/hub-server.js');
const { createNormaliser } = require('../lib/normalise.js');
const { configDirs, createAdapter, EVENTS, hookAcknowledgement, status, tagHookPayload } = require('../lib/providers/antigravity.js');

const WORK = 'C:\\fixture\\workspace';
const EXTRA = 'C:\\fixture\\extra';
const SID = '33c64cec-7651-4f4c-87a0-66883b3b263a';
const KEY = 'antigravity:' + SID;
const START = 1800000000000;
const GROUP = 'wyarden-monitor-antigravity';
const ROOTS = [EXTRA, WORK];
const rootOf = cwd => ({ root: cwd, real: cwd, ws: contract.wsKey(cwd), name: contract.flavour(cwd).basename(cwd) });
const fixture = (hookEventName, fields = {}) => ({
  hookEventName, conversationId: SID, workspacePaths: ROOTS, cwd: WORK,
  lastUserInput: 'synthetic-private-prompt', transcriptPath: 'C:\\private\\transcript.jsonl',
  artifactDirectoryPath: 'C:\\private\\artifacts', modelName: 'fixture-model', ...fields
});
const read = (stepIdx, file = WORK + '\\fixture.txt') => ({ stepIdx, toolCall: { name: 'read_file', args: { Path: file } } });
const invocation = (invocationNum = 0, initialNumSteps = 1) => ({ invocationNum, initialNumSteps });
const stop = (fullyIdle = true, fields = {}) => ({ executionNum: 0, fullyIdle, terminationReason: 'model_stop', ...fields });
const normalise = () => createNormaliser({ adapters: [createAdapter()], rootInfo: rootOf });
const feed = (normaliser, event, fields, t = START) => normaliser.feed(fixture(event, fields), { t, route: 'antigravity', source: 'hook' });

function temp(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wyarden-agy-test-'));
  t.after(() => {
    assert.equal(path.dirname(folder), os.tmpdir());
    assert.ok(path.basename(folder).startsWith('wyarden-agy-test-'));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  return folder;
}

test('routes native CLI session and pairs stepIdx with successful and failed tool completions', () => {
  const monitor = normalise();
  const start = feed(monitor, 'SessionStart');
  assert.equal(start.key, KEY);
  assert.deepEqual(start.root, rootOf(WORK));
  assert.deepEqual(start.events.map(e => [e.ev, e.src, e.model]), [['session.start', 'hook:SessionStart', 'fixture-model']]);
  const first = feed(monitor, 'PreToolUse', read(2)).events;
  assert.deepEqual(first.map(e => [e.ev, e.call, e.grade]), [
    ['tool.start', 'step-2', 'exact'], ['resource.touch', 'step-2', 'derived']
  ]);
  assert.equal(first[0].tool, 'read_file');
  assert.equal(first[0].class, 'read');
  assert.equal(first[1].path, 'fixture.txt');
  const [success] = feed(monitor, 'PostToolUse', { ...read(2), error: '' }, START + 35).events;
  assert.equal(success.ok, true);
  assert.equal(success.ms, 35);
  assert.equal(success.msGrade, 'derived');
  feed(monitor, 'PreToolUse', read(3), START + 80);
  const failed = feed(monitor, 'PostToolUse', { ...read(3), error: 'synthetic-private-error' }, START + 120);
  assert.deepEqual(failed.events.map(e => [e.ev, e.call, e.ok, e.error]), [['tool.end', 'step-3', false, 'tool_error']]);
  assert.doesNotMatch(JSON.stringify([start.events, first, failed.events]), /private|transcript|artifact/);
  const [orphan] = feed(monitor, 'PostToolUse', read(0)).events;
  assert.equal(orphan.ev, 'tool.end');
  assert.equal(orphan.ms, undefined);
  assert.equal(orphan.ok, true);
});

test('selects the reported cwd from multiple mounts, checks it against the mounts, and accepts older payloads', () => {
  const monitor = normalise();
  assert.equal(feed(monitor, 'SessionStart', { cwd: WORK + '\\nested' }).cwd, WORK + '\\nested');
  assert.equal(feed(monitor, 'SessionStart', { cwd: undefined }).cwd, EXTRA);
  assert.equal(feed(monitor, 'SessionStart', { cwd: 'C:\\private', workspacePaths: [null, 'relative', EXTRA] }).cwd, EXTRA);
  assert.equal(feed(monitor, 'SessionStart', { cwd: WORK, workspacePaths: [] }).cwd, WORK);
  assert.equal(feed(monitor, 'SessionStart', { cwd: 'relative', workspacePaths: [] }).cwd, null);
});

test('keeps only supplied resource targets and supported MCP metadata', () => {
  const monitor = normalise();
  const tool = (stepIdx, name, args) => feed(monitor, 'PreToolUse', { stepIdx, toolCall: { name, args } }).events;
  const [, outside] = tool(1, 'view_file', { AbsolutePath: 'C:\\private\\outside.txt', ignored: 'private' });
  assert.deepEqual(outside.path, { outside: true, name: 'outside.txt' });
  const [, url] = tool(2, 'read_url_content', { Url: 'https://user:password@example.test/safe?q=secret#secret' });
  assert.equal(url.url, 'https://example.test/safe');
  assert.equal(tool(3, 'list_dir', { OtherPath: WORK }).length, 1);
  assert.equal(tool(4, 'run_command', { CommandLine: 'synthetic-private-command', Cwd: EXTRA }).length, 1);
  const args = { ServerName: 'local_fixture', ToolName: 'check_status', Arguments: { uri: 'notes://private/location', payload: 'ignore' } };
  const [mcp, resource] = tool(5, 'call_mcp_tool', args);
  assert.deepEqual([mcp.ev, mcp.server, mcp.tool, mcp.serverSource, mcp.grade], ['mcp.start', 'local_fixture', 'check_status', 'args', 'derived']);
  assert.deepEqual([resource.kind, resource.op, resource.scheme, resource.server], ['mcp-resource', 'unknown', 'notes', 'local_fixture']);
  assert.doesNotMatch(JSON.stringify([mcp, resource]), /private|ignore/);
  const [end] = feed(monitor, 'PostToolUse', { stepIdx: 5, toolCall: { name: 'call_mcp_tool' }, error: '' }).events;
  assert.equal(end.ev, 'mcp.end');
  assert.equal(end.server, 'local_fixture');
  assert.deepEqual(tool(6, 'call_mcp_tool', { ServerName: 'local_fixture', ToolName: 'check_status' }).map(e => e.ev), ['mcp.start']);
  const [unknown, eagerResource] = tool(7, 'mcp_local_fixture_check_status', { uri: 'notes://private/location' });
  assert.equal(unknown.ev, 'tool.start');
  assert.equal(unknown.class, 'mcp');
  assert.equal(unknown.server, undefined);
  assert.deepEqual([eagerResource.kind, eagerResource.scheme, eagerResource.server], ['mcp-resource', 'notes', undefined]);
});

test('rejects malformed hooks and accepts the fixed command tag only for its configured event', () => {
  const monitor = normalise();
  for (const payload of [null, [], fixture('Unknown'), fixture('SessionStart', { conversationId: '../escape' }),
    fixture('SessionStart', { workspacePaths: 'not-an-array' }), fixture('PreToolUse', read(-1)),
    fixture('PreToolUse', read('0')), fixture('PreToolUse', { stepIdx: 0, toolCall: { name: 'read_file', args: [] } }),
    fixture('PostToolUse', { ...read(0), error: { private: 'payload' } }), fixture('PreInvocation', invocation(0, 0.5)),
    fixture('Stop', { executionNum: 0, fullyIdle: 'true' }), fixture(undefined)]) {
    assert.equal(monitor.feed(payload, { route: 'antigravity', source: 'hook' }), null);
  }
  assert.equal(monitor.feed(fixture('SessionStart'), { route: 'claude' }), null);
  assert.equal(monitor.feed(fixture('SessionStart'), { route: 'antigravity', source: 'transcript' }), null);
  const { hookEventName, ...untagged } = fixture('SessionStart');
  assert.equal(monitor.feed(tagHookPayload(hookEventName, untagged)).key, KEY);
  assert.equal(tagHookPayload('Stop', fixture('SessionStart')), null);
  assert.equal(tagHookPayload('Stop', []), null);
  assert.equal(tagHookPayload('Unknown', untagged), null);
  assert.deepEqual(hookAcknowledgement('PreToolUse'), { decision: 'allow' });
  assert.deepEqual(hookAcknowledgement('Stop'), { decision: 'stop' });
  for (const event of EVENTS.filter(e => e !== 'PreToolUse' && e !== 'Stop')) assert.deepEqual(hookAcknowledgement(event), {});
});

test('invocations stay in the running turn until fully idle and the hub ends a silent session on its existing clock', () => {
  let now = START;
  const monitor = normalise();
  const drops = [];
  const core = createHubCore({ normaliser: monitor, now: () => now, rootInfo: rootOf,
    schedule(fn) { drops.push(fn); return () => {}; } });
  const records = [];
  core.onSend = (_id, message) => { if (message.type === 'records') records.push(...message.records); };
  core.attach({ id: 'local-window', name: 'Fixture window', scope: contract.windowKey([WORK, EXTRA]),
    folders: [{ path: WORK }, { path: EXTRA }] });
  const ingest = (event, fields) => core.ingest(fixture(event, fields), { route: 'antigravity', source: 'hook' });
  ingest('SessionStart');
  ingest('PreInvocation', invocation());
  ingest('PostInvocation', invocation());
  ingest('PreInvocation', invocation(1, 3));
  ingest('Stop', stop(false));
  assert.deepEqual(records.filter(e => e.ev?.startsWith('turn.')).map(e => e.ev), ['turn.start']);
  now += 5000;
  ingest('Stop', stop());
  assert.equal(core.session(KEY).ended, false);
  assert.equal(records.find(e => e.ev === 'turn.end').outcome, 'done');
  assert.equal(records.some(e => e.ev === 'session.end'), false);
  now += contract.LIMITS.silentMs - 1;
  core.sweep();
  assert.equal(core.session(KEY).ended, false);
  now++;
  core.sweep();
  assert.equal(core.session(KEY).ended, true);
  assert.deepEqual(records.filter(e => e.ev === 'session.end').map(e => [e.src, e.reason, e.t]), [['hub:silent', 'silent', now]]);
  drops.at(-1)();
  assert.equal(core.session(KEY), undefined);
  assert.equal(monitor.size(), 0);
});

test('a real loopback hub shows an Antigravity tool failure in the workspace model', async t => {
  const home = temp(t);
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const hub = { ...contract.ensureHubFile(home), port };
  const server = await startHub({ home, hub, providerAdapters: [createAdapter()],
    deps: { claudeConfigDirs: () => [], liveClaudeSessions: () => [] } });
  t.after(() => server.close());
  const scope = contract.windowKey([WORK, EXTRA]);
  const records = [];
  server.core.onSend = (_id, message) => { if (message.type === 'records') records.push(...message.records); };
  server.core.attach({ id: 'fixture-window', app: 'Code', name: 'Workspace (Workspace)', scope, folders: [{ path: WORK }, { path: EXTRA }] });
  for (const payload of [fixture('SessionStart'), fixture('PreToolUse', read(2)), fixture('PostToolUse', { ...read(2), error: 'synthetic failure' })]) {
    const response = await fetch(contract.hookUrl(hub, 'antigravity'), { method: 'POST', body: JSON.stringify(payload) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {});
  }
  for (let i = 0; i < 100 && !records.some(e => e.ev === 'tool.end'); i++) await delay(10);
  assert.equal(server.core.models.get(scope).sessions.has(KEY), true);
  assert.deepEqual(records.filter(e => e.ev?.startsWith('tool.')).map(e => [e.ev, e.call, e.ok, e.error]), [
    ['tool.start', 'step-2', undefined, undefined], ['tool.end', 'step-2', false, 'tool_error']
  ]);
});

test('temporary-home setup is idempotent and removal restores the unrelated hooks byte for byte', t => {
  const home = temp(t);
  const [dir] = configDirs({ home });
  assert.deepEqual(configDirs({ env: { USERPROFILE: home, HOME: home } }), [dir]);
  assert.equal(dir, path.join(home, '.gemini', 'config'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'hooks.json');
  const existing = '\uFEFF{\r\n\t"user-hook" : {"enabled":false,"Stop":[{"command":"echo {hello, world}"}]},\r\n\t"other":{"large":90071992547409931234}\r\n}\r\n';
  fs.writeFileSync(file, existing);
  const commandFor = (provider, event) => 'fixture-command ' + provider + ' ' + event;
  const opts = { dirs: [dir], commandFor };
  const plan = (mode = 'add') => normalise().planConfig('antigravity', null, { ...opts, mode }).changes[0];
  const [empty] = createAdapter().planConfig(null, { dirs: configDirs({ home: path.join(home, 'empty-home') }), commandFor });
  assert.equal(empty.exists, false);
  assert.equal(empty.changed, true);
  assert.equal(JSON.parse(empty.after)[GROUP].Stop[0].command, 'fixture-command antigravity Stop');
  assert.equal(fs.existsSync(empty.dir), false, 'planning is read only');
  const add = plan();
  assert.equal(add.added, 6);
  assert.equal(add.before, existing);
  assert.equal(add.state, 'missing');
  assert.match(add.after, /90071992547409931234/);
  const group = JSON.parse(add.after.slice(1))[GROUP];
  assert.deepEqual(Object.keys(group), EVENTS);
  assert.equal(group.PreToolUse[0].matcher, '*');
  assert.equal(group.PreToolUse[0].hooks[0].command, 'fixture-command antigravity PreToolUse');
  fs.writeFileSync(file, add.after);
  assert.equal(status([dir], null, { commandFor }).state, 'installed');
  assert.equal(plan().changed, false);
  const remove = plan('remove');
  assert.equal(remove.removed, 6);
  assert.equal(remove.after, existing);
  fs.writeFileSync(file, remove.after);
  assert.equal(plan('remove').changed, false);
  assert.equal(status([dir], null, { commandFor }).state, 'missing');
});

test('ownership checks refuse collisions and malformed files and can restore a disabled owned group', t => {
  const [dir] = configDirs({ home: temp(t) });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'hooks.json');
  const commandFor = (_provider, event) => 'our-command ' + event;
  const plan = mode => createAdapter().planConfig(null, { dirs: [dir], commandFor, mode })[0];
  const owned = JSON.parse(plan('add').after)[GROUP];
  const alias = { unrelated: owned };
  fs.writeFileSync(file, JSON.stringify(alias));
  assert.equal(status([dir], null, { commandFor }).installed, 0);
  assert.equal(plan('remove').changed, false);
  for (const content of ['{bad-json', JSON.stringify({ [GROUP]: { ...owned, Stop: [{ command: 'unrelated' }] } }),
    '{"' + GROUP + '":{"Stop":[],"Stop":' + JSON.stringify(owned.Stop) + '}}']) {
    fs.writeFileSync(file, content);
    for (const mode of ['add', 'remove']) {
      const refused = plan(mode);
      assert.equal(refused.state, 'unreadable');
      assert.equal(refused.changed, false);
      assert.equal(refused.after, content);
    }
  }
  fs.writeFileSync(file, JSON.stringify({ user: 42, [GROUP]: { enabled: false, Stop: owned.Stop }, tail: 1 }));
  assert.equal(status([dir], null, { commandFor }).stale, 1);
  assert.deepEqual(JSON.parse(plan('remove').after), { user: 42, tail: 1 });
  const restored = plan('add');
  assert.equal(restored.added, 5);
  assert.equal(restored.replaced, 1);
  assert.deepEqual(JSON.parse(restored.after), { user: 42, [GROUP]: owned, tail: 1 });
});
