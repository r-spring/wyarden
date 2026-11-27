// The hub's listener (lib/hub-server.js), on a real loopback port with fake sources: the request
// checks, the answer-first ingest, the window connections, the timers that run only while a scope
// is shown, the worker entry, and one end-to-end run with the real normaliser. Every home folder is
// temporary and every path and id is invented.
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

const { startHub } = require('../lib/hub-server.js');
const contract = require('../lib/contract.js');
const M = require('../media/model.js');

const P = '/home/example/proj', OTHER = '/home/example/other';
const kP = contract.wsKey(P), kOther = contract.wsKey(OTHER);
const delay = ms => new Promise(r => setTimeout(r, ms));
const TIMINGS = { discoveryMs: 60, tailMs: 40, workspacesMs: 20 };

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
async function hubFile() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-'));
  const hub = { v: 1, port: await freePort(), ingest: crypto.randomBytes(32).toString('base64url'), control: crypto.randomBytes(32).toString('base64url'), created: 1 };
  fs.writeFileSync(path.join(home, 'hub.json'), JSON.stringify(hub));
  return { home, hub };
}

function fakeDeps(feedHook) {
  const calls = { dirs: 0, live: 0, tails: 0, polls: 0, closed: 0, fed: 0 };
  let live = [];
  const deps = {
    createNormaliser: () => ({
      feed(p, opts) {
        calls.fed++;
        if (feedHook) feedHook(p);
        if (!p || typeof p !== 'object' || typeof p.session !== 'string') return null;
        const events = (p.events || []).map(e => Object.assign({ v: 1, t: opts.t, agent: 'claude', session: p.session, ws: '', grade: 'exact', src: 'hook:Test' }, e));
        return { agent: 'claude', session: p.session, key: 'claude:' + p.session, cwd: p.cwd, root: null, source: p.source || 'hook', events };
      },
      forget() {}
    }),
    claudeConfigDirs: () => { calls.dirs++; return ['/home/example/.claude']; },
    liveClaudeSessions: () => { calls.live++; return live.map(x => Object.assign({}, x)); },
    createTail: () => { calls.tails++; return { poll() { calls.polls++; return []; }, close() { calls.closed++; } }; }
  };
  return { deps, calls, setLive: list => { live = list; } };
}

async function setup(t, opts = {}) {
  const { home, hub } = await hubFile();
  const fake = fakeDeps(opts.feedHook);
  const h = await startHub(Object.assign({ home, hub, deps: fake.deps, timings: TIMINGS }, opts.hubOptions));
  t.after(async () => { await h.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, hub, h, fake, port: hub.port };
}

function request(port, { method = 'POST', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: text, proof: res.headers['x-wyarden-proof'] }));
    });
    r.on('error', reject);
    r.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}
/** A control request's Authorization header, signed for this method and path. */
const sign = (s, method, p, nonce = contract.newNonce(), token = s.hub.control) => contract.signRequest(token, method, p, nonce);
const control = (s, method, p, body) => request(s.port, { method, path: p, headers: { Authorization: sign(s, method, p), 'Content-Type': 'application/json' }, body });
const post = (s, payload) => request(s.port, { path: contract.hookPath(s.hub.ingest, 'claude'), headers: { 'Content-Type': 'application/json' }, body: payload });

/** A window's open connection: every message it got, and a way to wait for one. */
function open(s, body, { onResponse } = {}) {
  const messages = [];
  let headers = null, ended = false;
  const nonce = contract.newNonce();
  const r = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/v1/attach', agent: false,
    headers: { 'Content-Type': 'application/json', Authorization: sign(s, 'POST', '/v1/attach', nonce) } });
  r.on('close', () => { ended = true; });
  r.on('response', res => {
    headers = res.headers;
    if (onResponse) { onResponse(res); return; }
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { messages.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    res.on('end', () => { ended = true; });
  });
  r.on('error', () => { ended = true; });
  r.end(JSON.stringify(body));
  const waitFor = async (pred, ms = 3000, what = 'a message') => {
    for (const until = Date.now() + ms; Date.now() < until; await delay(10)) { const m = messages.find(pred); if (m) return m; }
    throw new Error('timed out waiting for ' + what);
  };
  return { messages, waitFor, nonce, headers: () => headers, ended: () => ended, close: () => r.destroy() };
}
const winBody = (id, folders, scope) => ({ v: 1, window: { id, app: 'Code', name: id, pid: 1, folders: folders.map(p => ({ path: p, name: path.posix.basename(p) })) }, scope });
const snapshotOf = m => m.type === 'records' && m.records[0] && m.records[0].ctl === 'snapshot';

test('the hub binds 127.0.0.1 by number, on the port of hub.json', async t => {
  const s = await setup(t);
  assert.equal(s.h.port, s.hub.port);
  assert.equal(s.h.address.address, '127.0.0.1');
  assert.equal(s.h.address.family === 'IPv4' || s.h.address.family === 4, true);
});

test('every refusal is the same plain 404: Origin, Sec-Fetch-Site, wrong Host, wrong token, unknown path, GET on ingest', async t => {
  const s = await setup(t);
  const hook = contract.hookPath(s.hub.ingest, 'claude');
  const bad = contract.hookPath(crypto.randomBytes(32).toString('base64url'), 'claude');
  const status = () => ({ Authorization: sign(s, 'GET', '/v1/status') });
  const cases = {
    origin: { path: hook, headers: { Origin: 'http://example.com' }, body: '{}' },
    secFetch: { path: hook, headers: { 'Sec-Fetch-Site': 'cross-site' }, body: '{}' },
    host: { path: hook, headers: { Host: 'localhost:' + s.port }, body: '{}' },
    hostControl: { method: 'GET', path: '/v1/status', headers: Object.assign({ Host: 'example.com' }, status()) },
    ingestToken: { path: bad, body: '{}' },
    bearer: { method: 'GET', path: '/v1/status', headers: { Authorization: 'Bearer ' + s.hub.control } },
    otherToken: { method: 'GET', path: '/v1/status', headers: { Authorization: sign(s, 'GET', '/v1/status', undefined, crypto.randomBytes(32).toString('base64url')) } },
    otherPath: { path: '/v1/attach', headers: { Authorization: sign(s, 'POST', '/v1/update') }, body: '{}' },
    otherMethod: { path: '/v1/attach', headers: { Authorization: sign(s, 'GET', '/v1/attach') }, body: '{}' },
    noToken: { method: 'GET', path: '/v1/status' },
    unknown: { method: 'GET', path: '/nothing/here', headers: status() },
    unknownV1: { path: '/v1/nothing', headers: { Authorization: sign(s, 'POST', '/v1/nothing') }, body: '{}' },
    getIngest: { method: 'GET', path: hook },
    originControl: { method: 'GET', path: '/v1/status', headers: Object.assign({ Origin: 'null' }, status()) },
    expect: { method: 'GET', path: '/v1/status', headers: Object.assign({ Expect: 'foo' }, status()) },
    expectIngest: { path: hook, headers: { Expect: 'foo', 'Content-Type': 'application/json' }, body: '{}' }
  };
  const answers = {};
  for (const [name, c] of Object.entries(cases)) answers[name] = await request(s.port, c);
  const first = answers.unknown;
  assert.equal(first.status, 404);
  for (const [name, a] of Object.entries(answers)) assert.deepEqual(a, first, name + ' is the same 404');
  assert.equal(s.fake.calls.fed, 0, 'nothing refused reached the normaliser');
  const nonce = contract.newNonce();
  const ok = await request(s.port, { method: 'GET', path: '/v1/status', headers: { Authorization: sign(s, 'GET', '/v1/status', nonce) } });
  assert.equal(ok.status, 200, 'a good signature works');
  assert.equal(ok.proof, contract.hubProof(s.hub.control, nonce), 'and the answer proves the hub holds the token');
});

test('a broken request gets no page at all: the socket is closed with nothing written', async t => {
  const s = await setup(t);
  for (const junk of ['NOT HTTP AT ALL\r\n\r\n', 'GET / HTTP/1.1\r\nHost: 127.0.0.1:' + s.port + '\r\nContent-Length: -1\r\n\r\n']) {
    const got = await rawExchange(s.port, junk, 3000);
    assert.equal(got.text, '', 'no Node error page');
    assert.equal(got.closed, true);
  }
});

/** Write raw bytes to the hub and collect what comes back until it closes the socket (or `ms` pass). */
function rawExchange(port, text, ms) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    let got = '';
    const started = Date.now();
    const timer = setTimeout(() => { socket.destroy(); resolve({ text: got, closed: false, ms: Date.now() - started }); }, ms);
    socket.on('data', c => { got += c; });
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(timer); resolve({ text: got, closed: true, ms: Date.now() - started }); });
    socket.write(text);
  });
}

test('slow senders: the timeouts are set, a half-sent body is dropped, and an attach line outlives them', async t => {
  const plain = await setup(t);
  assert.deepEqual(plain.h.settings, { headersTimeout: 5000, requestTimeout: 10000, keepAliveTimeout: 5000, maxConnections: 256 });
  const s = await setup(t, { hubOptions: { timings: Object.assign({}, TIMINGS, { bodyMs: 400, requestMs: 700, headersMs: 500, checkMs: 100 }) } });
  const w = open(s, winBody('A', [P], 'all'));
  await w.waitFor(snapshotOf);
  const hook = contract.hookPath(s.hub.ingest, 'claude');
  const half = 'POST ' + hook + ' HTTP/1.1\r\nHost: 127.0.0.1:' + s.port + '\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n' + '{"session":"' + 'x'.repeat(80);
  const got = await rawExchange(s.port, half, 5000);
  assert.equal(got.closed, true, 'the stalled body was dropped');
  assert.ok(got.ms < 2500, 'within its time: ' + got.ms + ' ms');
  assert.equal(got.text, '', 'with no page');
  const headersOnly = await rawExchange(s.port, 'GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:' + s.port + '\r\n', 5000);
  assert.equal(headersOnly.closed, true, 'headers that never finish are dropped too');
  assert.equal(headersOnly.text, '');
  // The attach line is now older than every request timeout, and still carries records.
  await delay(400);
  assert.equal(w.ended(), false);
  await post(s, { session: 'late1', cwd: P, events: [{ ev: 'tool.start', call: 'c1', tool: 'Read' }] });
  await w.waitFor(m => m.type === 'records' && m.records.some(e => e.session === 'late1'), 3000, 'a record on the old line');
  w.close();
});

const pad = (n, mb) => ({ type: 'records', scope: 'all', records: [{ ctl: 'pad', n, pad: 'x'.repeat(mb * 1024 * 1024) }] });
/** A window that reads nothing: a raw socket that sends its attach and is then paused. The hub's
    count of windows is what is read, since the socket itself never looks. */
async function silentWindow(s, id) {
  const body = JSON.stringify(winBody(id, [P], 'all'));
  const socket = net.connect(s.port, '127.0.0.1');
  socket.on('error', () => {});
  socket.write('POST /v1/attach HTTP/1.1\r\nHost: 127.0.0.1:' + s.port + '\r\nAuthorization: ' + sign(s, 'POST', '/v1/attach') +
    '\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
  socket.pause();
  await until(() => s.h.core.status().windows === 1, 3000);
  return { close: () => socket.destroy() };
}
/** Whether this system's loopback pushes back on a reader that reads nothing. Windows was measured
    to take 200 MB without a byte left waiting; Linux holds a few megabytes and then pushes back. */
const pushesBack = (() => {
  let answer = null;
  return () => answer || (answer = new Promise(resolve => {
    const server = net.createServer(sock => {
      const buf = Buffer.alloc(48 * 1024 * 1024, 120);
      sock.on('error', () => {});
      sock.write(buf);
      setTimeout(() => { const waiting = sock.writableLength; sock.destroy(); server.close(); resolve(waiting > 1024 * 1024); }, 300);
    });
    server.listen(0, '127.0.0.1', () => { const c = net.connect(server.address().port, '127.0.0.1', () => c.pause()); c.on('error', () => {}); });
  }));
})();

test('the backlog rule judges progress, not size alone', () => {
  const { judgeBacklog, STUCK_BYTES, MAX_BACKLOG_BYTES, TIMINGS: T } = require('../lib/hub-server.js');
  const limits = { stuckBytes: STUCK_BYTES, maxBacklogBytes: MAX_BACKLOG_BYTES };
  assert.equal(STUCK_BYTES, 4 * 1024 * 1024); assert.equal(MAX_BACKLOG_BYTES, 32 * 1024 * 1024); assert.equal(T.stuckMs, 5000);
  const MB = 1024 * 1024;
  assert.equal(judgeBacklog(12 * MB, 10, limits, T), 'waiting', 'two large messages at once, still moving: not stuck');
  assert.equal(judgeBacklog(12 * MB, 4999, limits, T), 'waiting');
  assert.equal(judgeBacklog(12 * MB, 5000, limits, T), 'stuck', 'a backlog and nothing written for 5 s');
  assert.equal(judgeBacklog(3 * MB, 60000, limits, T), 'ok', 'a small backlog is never stuck');
  assert.equal(judgeBacklog(33 * MB, 0, limits, T), 'ceiling', 'the hard ceiling, at once');
});

test('large messages written back to back all reach a window that reads them (the default limits)', async t => {
  const s = await setup(t);
  const w = open(s, winBody('A', [P], 'all'));
  await w.waitFor(snapshotOf);
  // A snapshot followed at once by events is the normal case: several megabytes wait for a moment.
  for (let n = 1; n <= 4; n++) { s.h.core.onSend('A', pad(n, 6)); await new Promise(r => setImmediate(r)); }
  await w.waitFor(m => m.records && m.records[0].ctl === 'pad' && m.records[0].n === 4, 20000, 'all four 6 MB messages');
  assert.deepEqual(w.messages.filter(m => m.records && m.records[0].ctl === 'pad').map(m => m.records[0].n), [1, 2, 3, 4]);
  assert.equal(w.ended(), false, 'a window that reads is never closed for its backlog');
  assert.equal(s.h.core.status().windows, 1);
  w.close();
});

test('a window that reads nothing is closed after the stuck time, even with no further message', async t => {
  if (!(await pushesBack())) { t.skip('this system\'s loopback takes every byte, so a reader that reads nothing leaves no backlog to judge'); return; }
  const s = await setup(t, { hubOptions: { limits: { stuckBytes: 64 * 1024, maxBacklogBytes: 1024 * 1024 * 1024 }, timings: Object.assign({}, TIMINGS, { stuckMs: 400 }) } });
  const w = await silentWindow(s, 'B');
  // 24 MB is well past what a loopback socket's buffers absorb on Windows or Linux.
  s.h.core.onSend('B', pad(1, 24));
  const sent = Date.now();
  await delay(150);
  assert.equal(s.h.core.status().windows, 1, 'not closed before the stuck time');
  await until(() => s.h.core.status().windows === 0, 5000);
  const after = Date.now() - sent;
  assert.ok(after >= 350, 'closed after the stuck time: ' + after + ' ms');
  w.close();
});

test('the hard ceiling closes a window that reads nothing at once', async t => {
  if (!(await pushesBack())) { t.skip('this system\'s loopback takes every byte, so a reader that reads nothing leaves no backlog to judge'); return; }
  const s = await setup(t, { hubOptions: { limits: { stuckBytes: 512 * 1024, maxBacklogBytes: 1024 * 1024 }, timings: Object.assign({}, TIMINGS, { stuckMs: 60000 }) } });
  const w = await silentWindow(s, 'C');
  s.h.core.onSend('C', pad(1, 40));
  const sent = Date.now();
  await until(() => s.h.core.status().windows === 0, 3000);
  assert.ok(Date.now() - sent < 1500, 'at once, long before the stuck time');
  w.close();
});
const until = async (pred, ms) => { for (const end = Date.now() + ms; Date.now() < end; await delay(10)) if (pred()) return; throw new Error('timed out'); };

test('ingest answers 200 {} before the payload is processed', async t => {
  let fedAt = 0;
  const s = await setup(t, { feedHook: p => { if (p && p.slow) { fedAt = Date.now(); const until = fedAt + 600; while (Date.now() < until) { /* busy: the hub's thread is held */ } } } });
  // The client runs in its own thread, so it can see the answer while the hub's thread is busy.
  const code = `
    const http = require('node:http'); const { parentPort, workerData } = require('node:worker_threads');
    const body = JSON.stringify({ session: 'slow1', slow: true, events: [] });
    const r = http.request({ host: '127.0.0.1', port: workerData.port, method: 'POST', path: workerData.path, agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => parentPort.postMessage({ at: Date.now(), status: res.statusCode, text }));
    });
    r.end(body);`;
  const w = new Worker(code, { eval: true, workerData: { port: s.port, path: contract.hookPath(s.hub.ingest, 'claude') } });
  const answer = await new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); });
  await w.terminate();
  assert.equal(answer.status, 200); assert.equal(answer.text, '{}');
  assert.ok(fedAt > 0, 'the payload was processed');
  assert.ok(answer.at < fedAt + 500, 'the answer arrived while the payload was still being processed (' + (answer.at - fedAt) + ' ms)');
});

test('ingest survives junk and an oversized body, counts them, and keeps working', async t => {
  const s = await setup(t, { hubOptions: { limits: { body: 1024 } } });
  for (const junk of ['not json', '[', '', 'null', '{"session": 5}']) {
    const a = await post(s, junk);
    assert.equal(a.status, 200); assert.equal(a.body, '{}');
  }
  let big;
  try { big = await post(s, JSON.stringify({ session: 'big', pad: 'x'.repeat(64 * 1024) })); } catch (error) { big = { status: 'reset', code: error.code }; }
  assert.ok(big.status === 200 || big.status === 'reset', 'answered 200, or the rest of the upload was cut: ' + JSON.stringify(big));
  await delay(50);
  assert.equal((await post(s, { session: 'ok1', cwd: P, events: [{ ev: 'tool.start', call: 'c1', tool: 'Read' }] })).status, 200);
  await delay(20);
  const st = JSON.parse((await control(s, 'GET', '/v1/status')).body);
  assert.equal(st.events.tooLarge, 1);
  assert.ok(st.events.rejected >= 4, 'junk is rejected: ' + st.events.rejected);
  assert.equal(st.sessions.known, 1);
});

test('attach: hello, then workspaces, then a snapshot when it has a scope; the response is ndjson, not cached', async t => {
  const s = await setup(t);
  const w = open(s, winBody('A', [P], 'all'));
  await w.waitFor(snapshotOf, 3000, 'the snapshot');
  assert.deepEqual(w.messages.map(m => m.type), ['hello', 'workspaces', 'records']);
  const hello = w.messages[0];
  assert.equal(hello.v, 1); assert.match(hello.epoch, /^[0-9a-f]{8}$/); assert.equal(hello.pid, process.pid);
  assert.equal(hello.proof, contract.hubProof(s.hub.control, w.nonce), 'hello proves the hub, for this request\'s nonce');
  assert.equal(w.headers()['content-type'], 'application/x-ndjson');
  assert.equal(w.headers()['cache-control'], 'no-store');
  assert.equal(w.headers()['content-encoding'], undefined);
  assert.deepEqual(w.messages[1].list.map(x => x.key), [kP]);
  assert.equal(w.messages[2].records[0].epoch, hello.epoch);
  const quiet = open(s, winBody('B', [OTHER], null));
  await quiet.waitFor(m => m.type === 'workspaces');
  await delay(50);
  assert.equal(quiet.messages.filter(m => m.type === 'records').length, 0, 'scope null: no records');
  w.close(); quiet.close();
});

test('records are batched: the events of one turn of the event loop go out as one message', async t => {
  const s = await setup(t);
  const w = open(s, winBody('A', [P], 'all'));
  await w.waitFor(snapshotOf);
  const n = w.messages.length;
  await post(s, { session: 's1', cwd: P, events: [{ ev: 'tool.start', call: 'c1', tool: 'Read' }, { ev: 'tool.end', call: 'c1', tool: 'Read', ok: true }] });
  const m = await w.waitFor((x, i) => w.messages.indexOf(x) >= n && x.type === 'records');
  assert.deepEqual(m.records.map(e => e.ev), ['session.start', 'tool.start', 'tool.end']);
  w.close();
});

test('two windows with different scopes get different records; a disconnect removes its workspace for the others', async t => {
  const s = await setup(t);
  const a = open(s, winBody('A', [P], kP));
  const b = open(s, winBody('B', [OTHER], kOther));
  await a.waitFor(snapshotOf); await b.waitFor(snapshotOf);
  await post(s, { session: 's1', cwd: P + '/x', events: [{ ev: 'tool.start', call: 'c1', tool: 'Read' }] });
  await post(s, { session: 's2', cwd: OTHER, events: [{ ev: 'tool.start', call: 'c1', tool: 'Grep' }] });
  await a.waitFor(m => m.type === 'records' && m.records.some(e => e.session === 's1' && e.ev === 'tool.start'));
  await b.waitFor(m => m.type === 'records' && m.records.some(e => e.session === 's2' && e.ev === 'tool.start'));
  const sessionsOf = w => new Set(w.messages.filter(m => m.type === 'records').flatMap(m => m.records).filter(e => e.ev).map(e => e.session));
  assert.deepEqual([...sessionsOf(a)], ['s1']);
  assert.deepEqual([...sessionsOf(b)], ['s2']);
  await b.waitFor(m => m.type === 'workspaces' && m.list.length === 2);
  a.close();
  const after = await b.waitFor(m => m.type === 'workspaces' && m.list.length === 1, 3000, 'the list without A');
  assert.deepEqual(after.list.map(x => x.key), [kOther]);
  b.close();
});

test('update: a new scope gives a new snapshot; snapshot: true gives one for the same scope; resolve and status over HTTP', async t => {
  const s = await setup(t);
  const w = open(s, winBody('A', [P], kP));
  const other = open(s, winBody('B', [OTHER], null));
  await w.waitFor(snapshotOf); await other.waitFor(m => m.type === 'workspaces');
  await post(s, { session: 's1', cwd: P, events: [{ ev: 'tool.start', call: 'c1', tool: 'Read' }, { ev: 'resource.touch', call: 'c1', kind: 'file', op: 'read', path: 'src/a.js' }] });
  const up = await control(s, 'POST', '/v1/update', { window: 'A', scope: kOther });
  assert.equal(up.status, 200); assert.equal(up.body, '{}');
  const snap = await w.waitFor(m => snapshotOf(m) && m.scope === kOther);
  assert.equal(snap.records[0].scope, kOther);
  const count = w.messages.filter(snapshotOf).length;
  await control(s, 'POST', '/v1/update', { window: 'A', snapshot: true });
  await w.waitFor(() => w.messages.filter(snapshotOf).length === count + 1, 3000, 'a second snapshot');
  const res = JSON.parse((await control(s, 'POST', '/v1/resolve', { window: 'A', target: { id: 'r:claude:s1:file:src/' } })).body);
  assert.deepEqual(res, { kind: 'file', root: P, folder: P + '/src', members: [{ name: 'a.js', path: P + '/src/a.js' }] });
  assert.deepEqual(JSON.parse((await control(s, 'POST', '/v1/resolve', { window: 'A', target: { id: 'r:claude:nobody:file:src/' } })).body), { kind: 'none' });
  const st = JSON.parse((await control(s, 'GET', '/v1/status')).body);
  assert.equal(st.windows, 2); assert.equal(st.workspaces, 2); assert.equal(st.sessions.shown, 1); assert.equal(st.role, 'thread');
  assert.deepEqual(st.off, []);
  w.close(); other.close();
});

test('a window attaching with two folders and a name gets a list of one entry, with that name and both folders', async t => {
  const s = await setup(t);
  const body = { v: 1, window: { id: 'A', app: 'Code', name: 'Example (Workspace)', pid: 1, folders: [{ path: P, name: 'proj' }, { path: OTHER, name: 'other' }] }, scope: kP };
  const w = open(s, body);
  const snap = await w.waitFor(snapshotOf);
  const ws = w.messages.find(m => m.type === 'workspaces');
  const key = contract.windowKey([P, OTHER]);
  assert.deepEqual(ws.list.map(x => [x.key, x.name, x.folders, x.windows]), [[key, 'Example', ['proj', 'other'], 1]]);
  assert.equal(ws.own, key);
  assert.equal(snap.scope, key, 'a 0.1.0 host\'s first-folder key lands on its own window');
  const last = await w.waitFor(m => m.type === 'workspaces' && m.watching === true, 3000, 'watching');
  assert.equal(last.scope, key); assert.equal(last.total, 0);
  w.close();
});

test('discovery and tails run only while some window shows a scope, and once before the first snapshot', async t => {
  const s = await setup(t);
  s.fake.setLive([{ agent: 'claude', session: 'd1', key: 'claude:d1', cwd: P, pid: 77, status: 'busy', transcript: '/home/example/.claude/projects/x/d1.jsonl' }]);
  const w = open(s, winBody('A', [P], null));
  await w.waitFor(m => m.type === 'workspaces');
  await delay(200);
  assert.equal(s.fake.calls.live, 0, 'no scope: no discovery');
  assert.equal(s.fake.calls.polls, 0);
  await control(s, 'POST', '/v1/update', { window: 'A', scope: 'all' });
  assert.equal(s.fake.calls.live, 1, 'one pass before the snapshot');
  const snap = await w.waitFor(snapshotOf);
  const model = M.load(snap.records[0].state);
  assert.equal(model.nodes.get('a:claude:d1').status, 'working', 'the first snapshot holds the discovered session, busy');
  await delay(300);
  assert.ok(s.fake.calls.live >= 3, 'discovery runs: ' + s.fake.calls.live);
  assert.equal(s.fake.calls.tails, 1, 'one tail for the session with no hook');
  assert.ok(s.fake.calls.polls >= 3);
  await control(s, 'POST', '/v1/update', { window: 'A', scope: null });
  const live = s.fake.calls.live, polls = s.fake.calls.polls;
  assert.equal(s.fake.calls.closed, 1, 'its tail is closed');
  await delay(250);
  assert.equal(s.fake.calls.live, live); assert.equal(s.fake.calls.polls, polls);
  w.close();
});

test('a new tail\'s replay lands inside the first snapshot, and a later attach does not poll an existing tail out of turn', async t => {
  const fake = fakeDeps();
  let polls = 0;
  const replay = (ev, call, extra) => ({ session: 'd1', cwd: P, source: 'transcript', _wy: { src: 'transcript', replay: true, at: 1 },
    events: [Object.assign({ ev, call, tool: 'Read', grade: 'derived', src: 'transcript:Test' }, extra)] });
  fake.deps.createTail = () => ({
    poll() { polls++; return polls === 1 ? [replay('tool.start', 'r1'), replay('tool.end', 'r1', { ok: true }), replay('tool.start', 'r2')] : []; },
    close() {}
  });
  fake.setLive([{ agent: 'claude', session: 'd1', key: 'claude:d1', cwd: P, pid: 77, status: 'busy', transcript: '/home/example/.claude/projects/x/d1.jsonl' }]);
  const { home, hub } = await hubFile();
  // A long tail timer: any poll seen here is one made out of turn.
  const h = await startHub({ home, hub, deps: fake.deps, timings: { discoveryMs: 10000, tailMs: 10000, workspacesMs: 20 } });
  t.after(async () => { await h.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const s = { port: hub.port, hub };
  const a = open(s, winBody('A', [P], 'all'));
  const snap = await a.waitFor(snapshotOf);
  const model = M.load(snap.records[0].state);
  const tool = model.nodes.get('t:claude:d1:Read');
  assert.ok(tool, 'the replayed calls are in the snapshot');
  assert.equal(tool.calls, 2); assert.equal(tool.open, 1);
  assert.equal(polls, 1);
  await delay(150);
  const after = a.messages.slice(a.messages.indexOf(snap) + 1).filter(m => m.type === 'records').flatMap(m => m.records);
  assert.deepEqual(after.filter(e => e.call === 'r1' || e.call === 'r2'), [], 'no live record for a replayed call');
  const b = open(s, winBody('B', [OTHER], kP));
  await b.waitFor(snapshotOf);
  assert.ok(M.load(b.messages.find(snapshotOf).records[0].state).nodes.get('t:claude:d1:Read'));
  assert.equal(polls, 1, 'the existing tail was not polled out of turn');
  const st = JSON.parse((await control(s, 'GET', '/v1/status')).body);
  assert.equal(st.events.replayed, 3); assert.equal(st.tails, 1);
  a.close(); b.close();
});

test('a source whose module is missing is off, status names it, and the hub still serves', async t => {
  // A dep given as null stands for a module that is missing or throws at load.
  const s = await setup(t, { hubOptions: { deps: { createNormaliser: null, claudeConfigDirs: null, liveClaudeSessions: null, createTail: null } } });
  const st = JSON.parse((await control(s, 'GET', '/v1/status')).body);
  assert.deepEqual(st.off.sort(), ['claudeConfigDirs', 'createNormaliser', 'createTail', 'liveClaudeSessions']);
  const w = open(s, winBody('A', [P], 'all'));
  await w.waitFor(snapshotOf);
  assert.equal((await post(s, { session: 's1', cwd: P, events: [] })).status, 200);
  await delay(150);
  const after = JSON.parse((await control(s, 'GET', '/v1/status')).body);
  assert.equal(after.events.rejected, 1, 'with no normaliser a payload is counted, not used');
  w.close();
});

test('a second hub on the same port fails with EADDRINUSE; close() frees the port and says bye', async t => {
  const s = await setup(t);
  await assert.rejects(startHub({ home: s.home, hub: s.hub, deps: s.fake.deps }), e => e.code === 'EADDRINUSE');
  const w = open(s, winBody('A', [P], 'all'));
  await w.waitFor(snapshotOf);
  await s.h.close();
  await w.waitFor(m => m.type === 'bye', 2000, 'bye');
  const again = await startHub({ home: s.home, hub: s.hub, deps: s.fake.deps });
  await again.close();
});

test('the worker entry: started in a real Worker it posts listening, serves a window, and closes on request', async t => {
  const { home, hub } = await hubFile();
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(userHome, { recursive: true, force: true }); });
  const w = new Worker(require.resolve('../lib/hub-server.js'), { workerData: { wyardenHub: true, home, hub, userHome, env: {}, timings: TIMINGS } });
  const messages = [];
  w.on('message', m => messages.push(m));
  const until = async (pred, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await delay(10)) { const m = messages.find(pred); if (m) return m; } throw new Error('timed out'); };
  const listening = await until(m => m.type === 'listening' || m.type === 'error');
  assert.deepEqual(listening, { type: 'listening', port: hub.port });
  const s = { port: hub.port, hub };
  const win = open(s, winBody('A', [P], 'all'));
  await win.waitFor(snapshotOf);
  const st = JSON.parse((await control(s, 'GET', '/v1/status')).body);
  assert.equal(st.role, 'worker');
  assert.ok(messages.some(m => m.type === 'log' && typeof m.message === 'string'), 'log lines go to the parent');
  const exited = new Promise(resolve => w.once('exit', resolve));
  w.postMessage({ type: 'close' });
  await until(m => m.type === 'closed');
  await win.waitFor(m => m.type === 'bye', 2000);
  assert.equal(await exited, 0, 'the worker ends by itself');
  // A second worker on a taken port says so.
  const blocker = await startHub({ home, hub, deps: fakeDeps().deps });
  const w2 = new Worker(require.resolve('../lib/hub-server.js'), { workerData: { wyardenHub: true, home, hub, userHome, env: {} } });
  const err = await new Promise(resolve => w2.on('message', m => { if (m.type === 'error') resolve(m); }));
  assert.equal(err.code, 'EADDRINUSE');
  await new Promise(resolve => w2.once('exit', resolve));
  await blocker.close();
});

/* ---------- with the real normaliser ---------- */

const realNormaliser = (() => { try { return require('../lib/normalise.js').createNormaliser; } catch { return null; } })();

test('end to end with the real normaliser: a Claude PreToolUse and PostToolUse over HTTP become a tool node', { skip: !realNormaliser && 'lib/normalise.js is not there yet' }, async t => {
  const { home, hub } = await hubFile();
  const h = await startHub({ home, hub, timings: TIMINGS, deps: {
    createNormaliser: realNormaliser, claudeConfigDirs: () => [], liveClaudeSessions: () => [], createTail: () => ({ poll: () => [], close() {} })
  } });
  t.after(async () => { await h.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const s = { port: hub.port, hub };
  const w = open(s, winBody('A', [P], 'all'));
  await w.waitFor(snapshotOf);
  const sid = '11111111-2222-4333-8444-555555555555';
  const base = { session_id: sid, cwd: P, transcript_path: P + '/t.jsonl', permission_mode: 'default', prompt_id: '99999999-2222-4333-8444-555555555555' };
  const pre = Object.assign({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: P + '/src/a.js' }, tool_use_id: 'toolu_000000000000000000000001' }, base);
  const postEvent = Object.assign({}, pre, { hook_event_name: 'PostToolUse', tool_response: { ok: true }, duration_ms: 12 });
  assert.equal((await post(s, pre)).status, 200);
  assert.equal((await post(s, pre)).status, 200, 'the same hook twice (two settings files)');
  assert.equal((await post(s, postEvent)).status, 200);
  const done = await w.waitFor(m => m.type === 'records' && m.records.some(e => e.ev === 'tool.end'));
  assert.ok(done);
  await control(s, 'POST', '/v1/update', { window: 'A', snapshot: true });
  const snaps = () => w.messages.filter(snapshotOf);
  await w.waitFor(() => snaps().length === 2);
  const model = M.load(snaps()[1].records[0].state);
  const tool = model.nodes.get('t:claude:' + sid + ':Read');
  assert.ok(tool, 'a tool node for Read');
  assert.equal(tool.calls, 1); assert.equal(tool.lastOk, true); assert.equal(tool.open, 0);
  assert.ok(model.nodes.get('r:claude:' + sid + ':file:src/'), 'the file it read');
  const st = JSON.parse((await control(s, 'GET', '/v1/status')).body);
  assert.equal(st.events.duplicates >= 1, true, 'the repeat was dropped');
  assert.equal(st.sources.hook, 1);
  const text = w.messages.map(m => JSON.stringify(m)).join('\n');
  assert.ok(!text.includes(P + '/src/a.js'), 'no absolute path leaves on a window\'s line');
  w.close();
});
