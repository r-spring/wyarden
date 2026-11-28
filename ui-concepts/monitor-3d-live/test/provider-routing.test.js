// The shared provider boundary: a compatible Claude hook can be classified by payload shape,
// while the real loopback hub keeps provider-qualified sessions and workspace snapshots separate.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');

const { createNormaliser } = require('../lib/normalise.js');
const { startHub } = require('../lib/hub-server.js');
const contract = require('../lib/contract.js');
const Model = require('../media/model.js');

const P = '/home/example/proj';
const SID = 'shared-session-01';
const ROOT = { root: P, real: P, ws: contract.wsKey(P), name: 'proj' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const rootInfo = cwd => (typeof cwd === 'string' && cwd === P ? ROOT : null);

function grokPayload(extra = {}) {
  return Object.assign({
    hookEventName: 'PreToolUse',
    sessionId: SID,
    workspace: P,
    toolName: 'Read'
  }, extra);
}

function grokAdapter(counts = {}) {
  const bump = name => { counts[name] = (counts[name] || 0) + 1; };
  return {
    provider: 'grok',
    // Grok may read the Claude settings hook; this is a route, not an identity claim.
    routes: ['claude'],
    matches(payload) {
      bump('matches');
      return payload !== null && typeof payload === 'object' &&
        typeof payload.hookEventName === 'string' && typeof payload.sessionId === 'string' &&
        typeof payload.toolName === 'string' && !Object.prototype.hasOwnProperty.call(payload, 'hook_event_name');
    },
    normalise(payload, context) {
      bump('normalise');
      const session = payload.sessionId;
      const event = {
        v: 1, t: context.t, agent: 'grok', session, ws: ROOT.ws, ev: 'tool.start',
        grade: context.source === 'hook' ? 'exact' : 'derived',
        src: context.source === 'hook' ? 'hook:PreToolUse' : 'transcript:PreToolUse',
        call: 'g-call', tool: 'Read'
      };
      if (payload.unsafe === 'path') event.path = '/not-kept';
      if (payload.unsafe === 'field') event.private = 'not-kept';
      if (payload.unsafe === 'name') event.tool = 'command --token /private';
      return {
        agent: 'grok', session, key: 'grok:' + session, cwd: P, root: ROOT,
        source: context.source, events: [event]
      };
    },
    planConfig() {
      bump('planConfig');
      return [{
        dir: '/home/example/.grok', file: '/home/example/.grok/settings.json', exists: false,
        before: '', after: '{}\n', changed: true, state: 'missing', error: null,
        reformatted: false, added: 1, replaced: 0, collapsed: 0, removed: 0
      }];
    }
  };
}

test('the router identifies Grok through a Claude route once, validates its canonical shape, and plans without writing', () => {
  const counts = {};
  const normaliser = createNormaliser({ rootInfo, adapters: [grokAdapter(counts)] });
  const out = normaliser.feed(grokPayload(), { t: 1000, route: 'claude', source: 'hook' });
  assert.equal(out.agent, 'grok');
  assert.equal(out.key, 'grok:' + SID);
  assert.equal(out.events.length, 1);
  Model.validate(out.events[0]);
  assert.deepEqual(counts, { matches: 1, normalise: 1 });

  const planned = normaliser.planConfig('grok', { port: 1 });
  assert.equal(planned.provider, 'grok');
  assert.equal(planned.changes[0].state, 'missing');
  assert.equal(counts.planConfig, 1);
  assert.equal(normaliser.planConfig('unknown', {}), null);

  assert.equal(normaliser.feed(grokPayload({ unsafe: 'path' }), { t: 1001, route: 'claude', source: 'hook' }), null);
  assert.equal(normaliser.feed(grokPayload({ unsafe: 'field' }), { t: 1002, route: 'claude', source: 'hook' }), null);
  assert.equal(normaliser.feed(grokPayload({ unsafe: 'name' }), { t: 1003, route: 'claude', source: 'hook' }), null);
  assert.equal(normaliser.feed(grokPayload({ sessionId: '../not-a-session' }), { t: 1004, route: 'claude', source: 'hook' }), null);
  assert.equal(normaliser.feed(grokPayload(), { t: 1005, route: 'openai', source: 'hook' }), null);

  const claude = createNormaliser({ rootInfo });
  const claudeOut = claude.feed({
    hook_event_name: 'PreToolUse', session_id: SID, cwd: P,
    tool_name: 'Read', tool_use_id: 'c-call', tool_input: { file_path: P + '/src/example.js' }
  }, { t: 1000, route: 'claude', source: 'hook' });
  assert.equal(claudeOut.agent, 'claude');
  assert.equal(claude.feed(grokPayload(), { t: 1000, route: 'claude', source: 'hook' }), null);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function makeHubFile() {
  const home = fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'wyarden-routing-'));
  const hub = {
    v: 1, port: await freePort(),
    ingest: crypto.randomBytes(32).toString('base64url'),
    control: crypto.randomBytes(32).toString('base64url'), created: 1
  };
  fs.writeFileSync(require('node:path').join(home, 'hub.json'), JSON.stringify(hub));
  return { home, hub };
}

function request(port, { method = 'POST', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.once('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

function control(s, method, path, body) {
  const nonce = contract.newNonce();
  const headers = { Authorization: contract.signRequest(s.hub.control, method, path, nonce) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return request(s.port, { method, path, headers, body });
}

function post(s, route, payload) {
  return request(s.port, {
    path: contract.hookPath(s.hub.ingest, route),
    headers: { 'Content-Type': 'application/json' }, body: payload
  });
}

function openWindow(s, body) {
  const messages = [];
  let buffer = '';
  const nonce = contract.newNonce();
  const req = http.request({
    host: '127.0.0.1', port: s.port, method: 'POST', path: '/v1/attach', agent: false,
    headers: {
      Authorization: contract.signRequest(s.hub.control, 'POST', '/v1/attach', nonce),
      'Content-Type': 'application/json'
    }
  });
  req.on('response', res => {
    res.setEncoding('utf8');
    res.on('data', chunk => {
      buffer += chunk;
      for (let cut = buffer.indexOf('\n'); cut >= 0; cut = buffer.indexOf('\n')) {
        const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
        try { messages.push(JSON.parse(line)); } catch { /* a malformed line is not a valid test message */ }
      }
    });
  });
  req.on('error', () => {});
  req.end(JSON.stringify(body));
  const waitFor = async (predicate, timeout = 3000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const found = messages.find(predicate);
      if (found) return found;
      await delay(10);
    }
    throw new Error('timed out waiting for a hub message');
  };
  return { messages, waitFor, close: () => req.destroy() };
}

async function eventually(predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error('timed out waiting for state');
}

const snapshotOf = message => message.type === 'records' && message.records && message.records[0] && message.records[0].ctl === 'snapshot';

test('a real loopback hub keeps same-id Claude and Grok sessions distinct in a workspace snapshot', async t => {
  const { home, hub } = await makeHubFile();
  const counts = {};
  let started = null;
  let window = null;
  t.after(async () => {
    if (window) window.close();
    if (started) await started.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const adapter = grokAdapter(counts);
  started = await startHub({
    home, hub, providerAdapters: [adapter], timings: { discoveryMs: 1000, tailMs: 1000, workspacesMs: 10 },
    deps: {
      createNormaliser, claudeConfigDirs: () => [], liveClaudeSessions: () => [],
      createTail: () => ({ poll: () => [], close() {} })
    }
  });
  const s = { port: hub.port, hub };
  const workspace = contract.wsKey(P);
  window = openWindow(s, {
    v: 1,
    window: { id: 'routing-window', app: 'Code', name: 'Routing', pid: 1, folders: [{ path: P, name: 'proj' }] },
    scope: workspace
  });
  const first = await window.waitFor(snapshotOf);
  assert.equal(first.scope, workspace);

  const claudeResponse = await post(s, 'claude', {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: P,
    tool_name: 'Read', tool_use_id: 'c-call', tool_input: { file_path: P + '/src/example.js' }
  });
  assert.equal(claudeResponse.status, 200);
  await window.waitFor(message => message.type === 'records' && message.records.some(e => e.agent === 'claude' && e.ev === 'tool.start'));

  const grokResponse = await post(s, 'claude', grokPayload());
  assert.equal(grokResponse.status, 200);
  await window.waitFor(message => message.type === 'records' && message.records.some(e => e.agent === 'grok' && e.ev === 'tool.start'));
  // The Grok matcher is considered once for each hook payload; only the matching payload is normalised.
  assert.deepEqual(counts, { matches: 2, normalise: 1 });

  const unknownRoute = await post(s, 'unknown', grokPayload());
  assert.equal(unknownRoute.status, 404);
  const beforeUnsafe = JSON.parse((await control(s, 'GET', '/v1/status')).body);
  assert.equal((await post(s, 'claude', grokPayload({ unsafe: 'path' }))).status, 200);
  await eventually(async () => JSON.parse((await control(s, 'GET', '/v1/status')).body).events.rejected > beforeUnsafe.events.rejected);

  const snapshots = () => window.messages.filter(snapshotOf);
  const beforeSnapshot = snapshots().length;
  assert.equal((await control(s, 'POST', '/v1/update', { window: 'routing-window', snapshot: true })).status, 200);
  await eventually(() => snapshots().length > beforeSnapshot);
  const latest = snapshots()[snapshots().length - 1];
  assert.equal(latest.scope, workspace);
  const model = Model.load(latest.records[0].state);
  assert.equal(model.sessions.has('claude:' + SID), true);
  assert.equal(model.sessions.has('grok:' + SID), true);
  assert.equal(model.sessions.size, 2);

  const status = JSON.parse((await control(s, 'GET', '/v1/status')).body);
  assert.deepEqual(status.sessions, { known: 2, shown: 2, hidden: 0 });
});
