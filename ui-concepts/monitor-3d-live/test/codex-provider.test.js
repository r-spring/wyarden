'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const contract = require('../lib/contract.js');
const { createNormaliser } = require('../lib/normalise.js');
const { startHub } = require('../lib/hub-server.js');
const { createAdapter, configDirs, liveCodexSessions, status, EVENTS } = require('../lib/providers/codex.js');

const cwd = '/work/codex-fixture';
const session = '01900000-0000-7000-8000-000000000001';
const turn = '01900000-0000-7000-8000-000000000002';
const root = { root: cwd, real: cwd, ws: contract.wsKey(cwd), name: 'codex-fixture' };
const privateMarker = 'PRIVATE_FIXTURE_CONTENT';
const normaliser = () => createNormaliser({ rootInfo: () => root, adapters: [createAdapter({ salt: 'fixture' })] });

function native(event, fields = {}) {
  const shared = { hook_event_name: event, session_id: session, cwd, transcript_path: null };
  if (event === 'SessionEnd') return { ...shared, reason: 'other', ...fields };
  const common = { ...shared, model: 'fixture-model', permission_mode: 'default' };
  if (event === 'SessionStart') return { ...common, source: 'startup', ...fields };
  return { ...common, turn_id: turn, ...fields };
}

function tool(event, name, id, fields = {}) {
  return native(event, { tool_name: name, tool_use_id: id, tool_input: { command: privateMarker }, ...fields });
}

const feed = (n, payload, t) => n.feed(payload, { route: 'codex', source: 'hook', t });

test('Codex command hooks pair shell execution by native call id across working directories and turns', () => {
  const n = normaliser();
  const start = feed(n, native('SessionStart'), 100);
  assert.equal(start.key, 'codex:' + session);
  assert.equal(start.events[0].ev, 'session.start');
  const before = feed(n, tool('PreToolUse', 'Bash', 'call-shell', { cwd: cwd + '/client' }), 200);
  const after = feed(n, tool('PostToolUse', 'Bash', 'call-shell', { turn_id: 'collecting-turn',
    cwd: cwd + '/client', tool_response: 'Process exited with code 91\n' + privateMarker }), 500);
  assert.deepEqual([before.cwd, after.cwd], [cwd, cwd]);
  assert.deepEqual(before.events.map(e => [e.ev, e.call, e.turn, e.class]), [['tool.start', 'call-shell', turn, 'execute']]);
  const [end] = after.events;
  assert.deepEqual([end.ev, end.call, end.turn, end.ok, end.ms, end.grade], ['tool.end', 'call-shell', 'collecting-turn', true, 300, 'derived']);
  assert.equal(end.error, undefined, 'stdout cannot prove an exit status');
  const knownFailure = feed(n, tool('PostToolUse', 'Bash', 'another-call', { tool_response: { exit_code: 5 } }), 600);
  assert.deepEqual(knownFailure.events.map(e => [e.ok, e.error]), [[false, 'tool_error']]);
  assert.equal(JSON.stringify([start, before, after, knownFailure]).includes(privateMarker), false);
  assert.equal(feed(n, native('SessionEnd'), 700).events[0].ev, 'session.end');
  assert.equal(n.size(), 0);
});

test('Codex patch post yields only redacted resource touches and native subagent attribution', () => {
  const n = normaliser();
  feed(n, native('SessionStart'), 1);
  const patch = ['*** Begin Patch', '*** Update File: src/old.txt', '*** Move to: src/new.txt', '@@',
    '-' + privateMarker, '+' + privateMarker, '*** Delete File: /work/private/old.txt', '*** End Patch'].join('\n');
  const fields = { agent_id: 'sub-1', tool_input: { command: patch } };
  const before = feed(n, tool('PreToolUse', 'apply_patch', 'patch', fields), 2);
  const after = feed(n, tool('PostToolUse', 'apply_patch', 'patch', { ...fields, tool_response: privateMarker }), 3);
  assert.deepEqual(before.events.map(e => [e.ev, e.by]), [['tool.start', 'sub-1']]);
  assert.deepEqual(after.events.map(e => [e.ev, e.by, e.path]), [
    ['tool.end', 'sub-1', undefined], ['resource.touch', 'sub-1', 'src/old.txt'],
    ['resource.touch', 'sub-1', 'src/new.txt'], ['resource.touch', 'sub-1', { outside: true, name: 'old.txt' }]
  ]);
  assert.doesNotMatch(JSON.stringify([before, after]), /PRIVATE_FIXTURE_CONTENT|\/work\/private/);
});

test('MCP results carry isError, while arguments, content, metadata and transcript paths stay private', () => {
  const n = normaliser();
  const fields = { tool_input: { secret: privateMarker }, transcript_path: '/logs/' + privateMarker };
  const before = feed(n, tool('PreToolUse', 'mcp__fixture__check', 'mcp-1', fields), 100);
  const after = feed(n, tool('PostToolUse', 'mcp__fixture__check', 'mcp-1', {
    ...fields, tool_response: { content: [{ type: 'text', text: privateMarker }], isError: true,
      structuredContent: { secret: privateMarker }, _meta: { credential: privateMarker } }
  }), 104);
  assert.deepEqual(before.events.map(e => [e.ev, e.server, e.tool, e.call, e.turn]), [['mcp.start', 'fixture', 'check', 'mcp-1', turn]]);
  assert.deepEqual(after.events.map(e => [e.ev, e.error, e.ok, e.call, e.ms]), [['mcp.end', 'tool_error', false, 'mcp-1', 4]]);
  const prompt = feed(n, native('UserPromptSubmit', { prompt: privateMarker }), 105);
  const stop = feed(n, native('Stop', { last_assistant_message: privateMarker }), 106);
  assert.doesNotMatch(JSON.stringify([before, after, prompt, stop]), /PRIVATE_FIXTURE_CONTENT|transcript_path|structuredContent|credential/);
});

test('permission waiting closes only on matching tool evidence or a turn boundary', () => {
  const n = normaliser();
  const waiting = feed(n, native('PermissionRequest', { tool_name: 'Bash', tool_input: { command: privateMarker } }), 1);
  const another = feed(n, tool('PostToolUse', 'Bash', 'another', { tool_input: { command: 'else' }, tool_response: '' }), 2);
  const allowed = feed(n, tool('PostToolUse', 'Bash', 'original', { tool_response: '' }), 3);
  assert.deepEqual(waiting.events.map(e => [e.ev, e.why]), [['wait.start', 'permission']]);
  assert.deepEqual(another.events.map(e => e.ev), ['tool.end']);
  assert.deepEqual(allowed.events.map(e => [e.ev, e.answer]), [['wait.end', 'allowed'], ['tool.end', undefined]]);
  feed(n, native('PermissionRequest', { tool_name: 'Bash', tool_input: { command: privateMarker } }), 4);
  const interrupted = feed(n, native('Interrupt'), 5);
  assert.deepEqual(interrupted.events.map(e => [e.ev, e.answer, e.outcome]), [
    ['wait.end', 'unknown', undefined], ['turn.end', undefined, 'interrupted']
  ]);
});

test('the Codex route alone cannot authenticate an unrelated payload or a malformed Codex call', () => {
  const n = normaliser();
  const valid = tool('PreToolUse', 'Bash', 'call-shell');
  for (const fields of [{ turn_id: undefined }, { tool_use_id: '' }, { transcript_path: undefined },
    { session_id: '../fixture' }, { cwd: 'relative' }, { hook_event_name: 'Unsupported' }]) {
    assert.equal(feed(n, { ...valid, ...fields }, 100), null);
  }
  assert.equal(feed(n, { hook_event_name: 'PreToolUse', session_id: session, cwd, tool_name: 'Read' }, 100), null);
  assert.equal(n.feed(valid, { source: 'transcript', route: 'codex' }), null);
  assert.equal(n.feed(valid), null, 'the inherited Claude matcher also recognizes snake_case without a route');
  assert.equal(n.size(), 0);
});

function temporaryHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wyarden-codex-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  return home;
}

const commandFor = (provider, event) => `wyarden-collector ${provider} ${event}`;
const existing = { matcher: 'Bash', hooks: [{ type: 'command', command: 'existing-hook' }] };

test('temporary Codex setup is repeatable and removal preserves unrelated hook approval positions', t => {
  const home = temporaryHome(t);
  const dirs = configDirs({ home, env: { CODEX_HOME: home } });
  assert.deepEqual(dirs, [home]);
  assert.deepEqual(configDirs({ home, env: {} }), [path.join(home, '.codex')]);
  const file = path.join(home, 'hooks.json');
  const prior = { hooks: { PreToolUse: [existing], PreCompact: [existing] } };
  fs.writeFileSync(file, JSON.stringify(prior, null, 2));
  const n = normaliser();
  const plan = mode => n.planConfig('codex', {}, { dirs, mode, commandFor }).changes[0];
  const add = plan('add');
  assert.equal(add.added, EVENTS.length);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), prior, 'planning does not write');
  fs.writeFileSync(file, add.after);
  const repeat = plan('add');
  assert.deepEqual([repeat.changed, repeat.added, repeat.replaced], [false, 0, 0]);
  const installed = JSON.parse(repeat.after);
  assert.deepEqual(installed.hooks.PreToolUse[0], existing);
  assert.deepEqual(installed.hooks.PreCompact, [existing]);
  for (const event of EVENTS) assert.equal(installed.hooks[event].at(-1).hooks[0].command, commandFor('codex', event));
  const later = { hooks: [{ type: 'command', command: 'another-collector' }] };
  installed.hooks.PreToolUse.push(later);
  installed.hooks.Stop = [];
  fs.writeFileSync(file, JSON.stringify(installed, null, 2));
  const remove = plan('remove');
  assert.equal(remove.removed, EVENTS.length - 1);
  assert.deepEqual(JSON.parse(remove.after).hooks, { PreToolUse: [existing, { hooks: [] }, later], PreCompact: [existing], Stop: [] });
  fs.writeFileSync(file, remove.after);
  assert.equal(plan('remove').changed, false);
});

test('Codex planner refuses ambiguous JSON without altering the hooks file', t => {
  const dir = temporaryHome(t);
  const file = path.join(dir, 'hooks.json');
  const n = normaliser();
  for (const raw of ['{"hooks":{},"hooks":{}}', '{"hooks":{"Stop":null}}', '{"hooks":{},"value":9223372036854775807}']) {
    fs.writeFileSync(file, raw);
    const { changes: [change] } = n.planConfig('codex', {}, { dirs: [dir], commandFor });
    assert.deepEqual([change.state, change.changed, change.after], ['unreadable', false, raw]);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
});

test('approval status reads native Codex results for Wyarden hooks only', async t => {
  const dir = temporaryHome(t);
  const n = normaliser();
  const [change] = n.planConfig('codex', {}, { dirs: [dir], commandFor }).changes;
  fs.writeFileSync(change.file, change.after);
  const metadata = EVENTS.map(event => ({ eventName: event[0].toLowerCase() + event.slice(1), source: 'user',
    sourcePath: change.file, handlerType: 'command', enabled: true, trustStatus: 'trusted',
    command: commandFor('codex', event), statusMessage: 'Wyarden 3D Monitor' }));
  const read = async hooks => (await status([dir], {}, { inspectHooks: () => ({ data: [{ hooks }] }) }))[0];
  const unrelated = { ...metadata[0], source: 'project', command: 'entomatical-hook', trustStatus: 'untrusted' };
  const approved = await read([...metadata, unrelated]);
  assert.deepEqual([approved.state, approved.approval], ['installed', 'approved']);
  const pending = await read([{ ...metadata[0], trustStatus: 'untrusted' }, ...metadata.slice(1)]);
  assert.deepEqual([pending.state, pending.approval], ['awaiting-approval', 'awaiting-approval']);
  assert.equal((await read([{ ...metadata[0], enabled: false }, ...metadata.slice(1)])).state, 'inactive');
  assert.equal((await status([dir], {}, { inspectHooks: () => null }))[0].state, 'approval-unknown');
});

test('app-server fallback requests only loaded thread metadata and redacts editor session content', async () => {
  const requests = [];
  const rows = await liveCodexSessions({ run: (_args, _options, read) => read(async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/loaded/list') return { data: [session, '../unsafe', session, 'unloaded'] };
    const loaded = params.threadId === session;
    return { thread: { id: params.threadId, cwd, source: 'vscode', name: privateMarker, turns: [privateMarker],
      status: loaded ? { type: 'active', activeFlags: ['waitingOnApproval'] } : { type: 'notLoaded' } } };
  }) });
  assert.deepEqual(requests, [
    { method: 'thread/loaded/list', params: { limit: 64 } },
    { method: 'thread/read', params: { threadId: session, includeTurns: false } },
    { method: 'thread/read', params: { threadId: 'unloaded', includeTurns: false } }
  ]);
  assert.deepEqual(rows, [{ agent: 'codex', session, cwd, status: 'waiting', waitingFor: 'permission' }]);
  assert.deepEqual(await liveCodexSessions({ run: () => null }), []);
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('a loopback hub delivers native Codex session and paired tool activity to the matching workspace', async t => {
  const home = temporaryHome(t);
  const hub = { v: 1, port: await freePort(), ingest: contract.token(), control: contract.token(), created: 1 };
  fs.writeFileSync(path.join(home, 'hub.json'), JSON.stringify(hub));
  const started = await startHub({ home, hub, providerAdapters: [createAdapter()], deps: {
    claudeConfigDirs: () => [], liveClaudeSessions: () => [], createTail: () => null
  } });
  t.after(() => started.close());
  const scope = contract.wsKey(cwd);
  started.core.attach({ id: 'codex-window', app: 'Code', name: 'Codex fixture', pid: 1, scope, folders: [{ path: cwd }] });
  const post = payload => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: hub.port, method: 'POST',
      path: contract.hookPath(hub.ingest, 'codex'), headers: { 'Content-Type': 'application/json' } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.end(JSON.stringify(payload));
  });
  assert.equal(await post(native('SessionStart')), 200);
  assert.equal(await post(tool('PreToolUse', 'mcp__fixture__check', 'loopback')), 200);
  const model = started.core.models.get(scope);
  assert.deepEqual(started.core.session('codex:' + session).owners, [scope]);
  assert.equal(model.nodes.get('a:codex:' + session).kind, 'codex');
  const agent = model.sessions.get('codex:' + session);
  assert.equal(agent.calls.size, 1);
  assert.equal(await post(tool('PostToolUse', 'mcp__fixture__check', 'loopback', { tool_response: { isError: true } })), 200);
  assert.equal(agent.calls.size, 0);
  assert.equal(model.nodes.get('a:codex:' + session).failed, 1);
});
