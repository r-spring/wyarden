// One window's line to the hub (lib/hub-client.js): bind or connect, take over when the hub's
// window goes, say "blocked" when another program holds the port, carry updates across a
// reconnect, and leave nothing running after stop(). Real worker threads on loopback; every home
// folder is temporary and every path is invented.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const { createHubClient } = require('../lib/hub-client.js');
const contract = require('../lib/contract.js');

const ONE = '/home/example/one', TWO = 'C:\\Users\\example\\two';
const kOne = contract.wsKey(ONE), kTwo = contract.wsKey(TWO);
const delay = ms => new Promise(r => setTimeout(r, ms));
const until = async (pred, ms, what) => {
  for (const end = Date.now() + ms; Date.now() < end; await delay(10)) if (pred()) return;
  throw new Error('timed out waiting for ' + what);
};

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
async function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-'));
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-'));
  const hub = { v: 1, port: await freePort(), ingest: crypto.randomBytes(32).toString('base64url'), control: crypto.randomBytes(32).toString('base64url'), created: 1 };
  fs.writeFileSync(path.join(home, 'hub.json'), JSON.stringify(hub));
  const clients = [];
  const make = (id, folders, extra = {}) => {
    const c = createHubClient(Object.assign({
      home, window: { id, app: 'Code', name: id, pid: 1, folders: folders.map(p => ({ path: p, name: contract.flavour(p).basename(p) })) },
      timings: { blockedMs: 300, helloMs: 1000 },
      hubOptions: { userHome, env: {}, timings: { discoveryMs: 100, tailMs: 50, workspacesMs: 20 } }
    }, extra));
    c.states = []; c.messages = [];
    c.onState = s => c.states.push(s);
    c.onMessage = m => c.messages.push(m);
    c.lastWs = () => { const w = c.messages.filter(m => m.type === 'workspaces'); return w[w.length - 1]; };
    c.snapshots = () => c.messages.filter(m => m.type === 'records' && m.records[0] && m.records[0].ctl === 'snapshot');
    clients.push(c);
    return c;
  };
  t.after(async () => {
    await Promise.all(clients.map(c => c.stop()));
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(userHome, { recursive: true, force: true });
  });
  return { home, hub, make };
}
const keysOf = c => (c.lastWs() ? c.lastWs().list.map(x => x.key).sort() : []);

test('the first client becomes the hub, the second attaches as a client, and the second takes over when the first stops', async t => {
  const s = await setup(t);
  const a = s.make('A', [ONE]);
  a.start();
  await until(() => a.state === 'up', 5000, 'A up');
  assert.equal(a.role, 'hub');
  assert.deepEqual(a.states.slice(0, 2), ['connecting', 'up']);
  const b = s.make('B', [TWO]);
  b.start();
  await until(() => b.state === 'up', 5000, 'B up');
  assert.equal(b.role, 'client');
  const both = [kOne, kTwo].sort();
  await until(() => keysOf(a).join() === both.join() && keysOf(b).join() === both.join(), 3000, 'both folders in both lists');
  const status = await b.status();
  assert.equal(status.windows, 2); assert.equal(status.role, 'worker');
  b.update({ scope: kTwo });
  await until(() => b.snapshots().length === 1, 3000, 'B\'s first snapshot');

  const t0 = Date.now();
  await a.stop();
  assert.equal(a.state, 'stopped'); assert.equal(a.role, 'client');
  await until(() => b.role === 'hub' && b.state === 'up' && b.states.lastIndexOf('up') > b.states.indexOf('connecting', 1), 3000, 'B to take over');
  assert.ok(Date.now() - t0 < 3000, 'taken over in ' + (Date.now() - t0) + ' ms');
  await until(() => keysOf(b).join() === [kTwo].join(), 2000, 'a list without A\'s folder');
  assert.equal(b.messages.filter(m => m.type === 'hello').length, 2, 'a hello from each hub');
  await until(() => b.snapshots().length === 2, 2000, 'a snapshot from the new hub');
  assert.equal(b.snapshots()[1].scope, kTwo, 'the attach carried B\'s scope to the new hub');
  await a.stop();                                         // a second stop is harmless
});

test('a port held by a foreign HTTP server that answers 200 with junk gives blocked', async t => {
  const s = await setup(t);
  const foreign = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>junk</html>'); });
  await new Promise(r => foreign.listen(s.hub.port, '127.0.0.1', r));
  t.after(() => new Promise(r => { foreign.closeAllConnections && foreign.closeAllConnections(); foreign.close(r); }));
  const c = s.make('A', [ONE]);
  c.start();
  await until(() => c.state === 'blocked', 3000, 'blocked');
  assert.equal(c.role, 'client');
  const ndjsonJunk = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); res.end('{"type":"nothello"}\n'); });
  // The same answer with the right type but no hello is still not a hub.
  await new Promise(r => foreign.close(() => r()));
  await new Promise(r => ndjsonJunk.listen(s.hub.port, '127.0.0.1', r));
  t.after(() => new Promise(r => ndjsonJunk.close(r)));
  const d = s.make('B', [TWO]);
  d.start();
  await until(() => d.state === 'blocked', 3000, 'blocked again');
  await c.stop(); await d.stop();
});

test('the control token is never sent: a stranger on the port records every header and body and never sees it', async t => {
  const s = await setup(t);
  const seen = [];
  const stranger = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push(req.method + ' ' + req.url + '\n' + JSON.stringify(req.headers) + '\n' + body);
      if (req.url === '/v1/attach') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/v1/resolve' ? { kind: 'file', root: '/home/example', folder: '/home/example', members: [{ name: 'x', path: '/home/example/x' }] } : { epoch: 'deadbeef' }));
    });
  });
  await new Promise(r => stranger.listen(s.hub.port, '127.0.0.1', r));
  t.after(() => new Promise(r => stranger.close(r)));
  const c = s.make('A', [ONE]);
  c.start();
  await until(() => c.state === 'blocked', 3000, 'blocked');
  assert.deepEqual(await c.resolve({ id: 'a:claude:x' }), { kind: 'none' }, 'an answer without the hub\'s proof is not used');
  assert.equal(await c.status(), null);
  await c.stop();
  assert.ok(seen.length >= 3, 'it saw the attach, the resolve and the status: ' + seen.length);
  const all = seen.join('\n');
  assert.ok(!all.includes(s.hub.control), 'the control token is in no header and no body');
  assert.ok(seen.every(x => /"authorization":"Wyarden [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"/.test(x)), 'each request is signed instead');
});

test('a stranger that answers a plausible hello without a valid proof gives blocked, and nothing it sent is passed on', async t => {
  const s = await setup(t);
  const fake = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ type: 'hello', v: 1, epoch: 'deadbeef', pid: 1, proof: 'A'.repeat(43) }) + '\n');
    res.write(JSON.stringify({ type: 'records', scope: 'all', records: [] }) + '\n');
  });
  await new Promise(r => fake.listen(s.hub.port, '127.0.0.1', r));
  t.after(() => new Promise(r => { fake.closeAllConnections && fake.closeAllConnections(); fake.close(r); }));
  const logs = [];
  const c = s.make('A', [ONE], { log: (level, message) => logs.push(message) });
  c.start();
  await until(() => c.state === 'blocked', 3000, 'blocked');
  assert.deepEqual(c.messages, [], 'no message from that connection was delivered');
  assert.ok(logs.some(m => /not our hub/.test(m)));
  assert.ok(!c.states.includes('up'));
  await c.stop();
});

test('update before up is sent on connect; snapshot: true is not replayed; two updates arrive in order', async t => {
  const s = await setup(t);
  const c = s.make('A', []);
  c.update({ folders: [{ path: ONE, name: 'one' }], scope: 'all' });
  c.update({ snapshot: true });                           // for now only: not carried into the attach
  c.start();
  await until(() => c.state === 'up', 5000, 'up');
  await until(() => c.snapshots().length >= 1 && keysOf(c).join() === kOne, 3000, 'the remembered folder and scope');
  await delay(150);
  assert.equal(c.snapshots().length, 1, 'one snapshot: the attach\'s own');
  assert.equal(c.snapshots()[0].scope, 'all');
  c.update({ scope: kOne });
  c.update({ scope: 'all' });
  await until(() => c.snapshots().length === 3, 3000, 'two more snapshots');
  assert.deepEqual(c.snapshots().map(m => m.scope), ['all', kOne, 'all'], 'in the order they were made');
  await c.update({ snapshot: true });
  await until(() => c.snapshots().length === 4, 3000, 'a fresh snapshot on request');
  assert.equal(c.snapshots()[3].scope, 'all');
  const answer = await c.resolve({ id: 'a:claude:nobody' });
  assert.deepEqual(answer, { kind: 'none' });
});

test('after stop() nothing keeps the process alive', async t => {
  const s = await setup(t);
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { createHubClient } = require(workerData.client);
    const c = createHubClient({ home: workerData.home, window: { id: 'Z', app: 'Code', name: 'Z', pid: 1, folders: [] },
      hubOptions: { userHome: workerData.userHome, env: {} } });
    c.onState = state => {
      if (state !== 'up') return;
      parentPort.postMessage({ role: c.role });
      c.stop().then(() => parentPort.postMessage({ stopped: true }));
    };
    c.start();`;
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-'));
  t.after(() => fs.rmSync(userHome, { recursive: true, force: true }));
  const w = new Worker(code, { eval: true, workerData: { client: require.resolve('../lib/hub-client.js'), home: s.home, userHome } });
  const messages = [];
  w.on('message', m => messages.push(m));
  const exited = new Promise(resolve => w.once('exit', resolve));
  const timeout = new Promise(resolve => { const timer = setTimeout(() => resolve('still running'), 8000); timer.unref(); });
  const result = await Promise.race([exited, timeout]);
  if (result === 'still running') await w.terminate();
  assert.deepEqual(messages, [{ role: 'hub' }, { stopped: true }]);
  assert.equal(result, 0, 'the thread ended by itself after stop()');
});
