/* Wyarden 3D monitor, working mock-up: one editor window's line to the hub.
 *
 * Every window's extension host makes one of these. It attaches to the hub on the port in
 * hub.json and keeps that connection open; the hub streams one JSON message per line. When nothing
 * listens on the port, this host starts the hub itself in a worker thread, so whichever window
 * binds first is the hub and the listening socket is the only lock. When the hub's window closes,
 * every other window tries again after a short random wait, and one of them becomes the new hub.
 *
 * No `vscode` here: the extension passes in its window's id, app, folders and a log function, and
 * gets states and messages back. The contract is docs/monitor-3d/05-working-mockup.md, section 7.3.
 */
'use strict';
const http = require('node:http');
const contract = require('./contract.js');

const TIMINGS = {
  retryMinMs: 50, retryMaxMs: 400,   // after a lost connection
  blockedMs: 10000,                  // another program holds the port: try again this often
  helloMs: 5000,                     // a 200 with no hello line in this time is not our hub
  workerCloseMs: 2000,               // a worker that does not close in this time is terminated
  requestMs: 5000                    // update, resolve and status
};
const MAX_LINE = 64 * 1024 * 1024;
const STATES = ['connecting', 'up', 'blocked', 'stopped'];
const className = error => (error && error.constructor && error.constructor.name) || typeof error;

function createHubClient(options = {}) {
  const timings = Object.assign({}, TIMINGS, options.timings);
  const userLog = typeof options.log === 'function' ? options.log : () => {};
  const log = (level, message) => { try { userLog(level, message); } catch { /* never throws out */ } };
  const hubOptions = Object.assign({}, options.hubOptions);   // passed to the hub this host starts (tests)
  const win = Object.assign({ id: '', app: '', name: '', pid: process.pid, folders: [] }, options.window);
  let scope = options.scope === undefined ? null : options.scope;

  let state = null, stopped = false, started = false;
  let req = null, retryTimer = null, helloTimer = null;
  let worker = null, localHub = null, starting = false;
  let failures = 0, attachVersion = 0, version = 0;
  let queue = Promise.resolve();       // updates go out one after the other, in the order made
  let stopping = null;

  const client = {
    onState: () => {},
    onMessage: () => {},
    role: 'client',
    get state() { return state; }
  };
  const setState = next => {
    if (state === next || !STATES.includes(next)) return;
    state = next;
    try { client.onState(next); } catch (error) { log('warn', 'onState failed: ' + className(error)); }
  };
  const emit = message => { try { client.onMessage(message); } catch (error) { log('warn', 'onMessage failed: ' + className(error)); } };

  const clearTimers = () => {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
  };
  const later = (fn, ms) => {
    if (stopped) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = null; if (!stopped) fn(); }, ms);
  };
  const soon = () => later(attach, timings.retryMinMs + Math.random() * (timings.retryMaxMs - timings.retryMinMs));
  const blocked = why => {
    log('warn', 'the hub port is held by something else: ' + why);
    setState('blocked');
    later(attach, timings.blockedMs);
  };
  const hubFile = () => {
    try { return contract.ensureHubFile(options.home); } catch (error) { log('error', 'hub.json: ' + className(error)); return null; }
  };

  /* ---------- the hub, when this host runs it ---------- */

  function startLocalHub(hub) {
    if (starting || stopped) return;
    starting = true;
    const data = Object.assign({}, hubOptions, { wyardenHub: true, home: options.home, hub });
    let w;
    try {
      const { Worker } = require('node:worker_threads');
      w = new Worker(require.resolve('./hub-server.js'), { workerData: data });
    } catch (error) {
      log('warn', 'a worker cannot be made; the hub runs in this thread: ' + className(error));
      startInThread(hub);
      return;
    }
    worker = w;
    let listened = false, settled = false;
    w.on('message', message => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'log') { log(message.level, 'hub: ' + message.message); return; }
      if (message.type === 'listening') {
        listened = true; settled = true; starting = false; client.role = 'hub';
        if (stopped) { closeWorker(w); return; }
        attach();
      } else if (message.type === 'error' && !settled) {
        settled = true; starting = false;
        if (message.code === 'EADDRINUSE') { if (worker === w) worker = null; soon(); }    // another window won
        else { log('warn', 'the hub worker failed: ' + message.code); if (worker === w) worker = null; startInThread(hub); }
      }
    });
    w.on('error', error => { log('error', 'the hub worker crashed: ' + className(error)); });
    w.on('exit', code => {
      if (worker === w) worker = null;
      if (listened) { if (client.role === 'hub' && !localHub) client.role = 'client'; return; }
      if (!settled) {
        settled = true; starting = false;
        log('warn', 'the hub worker exited before it listened (' + code + '); the hub runs in this thread');
        startInThread(hub);
      }
    });
  }
  function startInThread(hub) {
    if (stopped) { starting = false; return; }
    starting = true;
    let startHub;
    try { ({ startHub } = require('./hub-server.js')); } catch (error) { starting = false; log('error', 'the hub cannot load: ' + className(error)); later(attach, timings.blockedMs); return; }
    startHub(Object.assign({}, hubOptions, { home: options.home, hub, log: (level, message) => log(level, 'hub: ' + message) })).then(h => {
      starting = false;
      if (stopped) { h.close(); return; }
      localHub = h; client.role = 'hub';
      attach();
    }, error => {
      starting = false;
      if (error && error.code === 'EADDRINUSE') soon();
      else { log('error', 'the hub cannot start: ' + className(error)); later(attach, timings.blockedMs); }
    });
  }
  function closeWorker(w) {
    return new Promise(done => {
      let finished = false;
      const end = () => { if (finished) return; finished = true; clearTimeout(timer); w.terminate().then(done, done); };
      const timer = setTimeout(end, timings.workerCloseMs);
      w.on('message', m => { if (m && m.type === 'closed') end(); });
      w.once('exit', end);
      try { w.postMessage({ type: 'close' }); } catch { end(); }
    });
  }

  /* ---------- the connection ---------- */

  function attach() {
    if (stopped) return;
    clearTimers();
    setState(state === 'blocked' ? 'blocked' : 'connecting');
    const hub = hubFile();
    if (!hub) { later(attach, timings.blockedMs); return; }
    const sent = version;
    const body = JSON.stringify({ v: 1, window: { id: win.id, app: win.app, name: win.name, pid: win.pid, folders: win.folders, actions: true }, scope });
    let gotHello = false, buffer = '', ended = false;
    // Whatever answers on the port gets a signature, never the token; our hub answers with a proof.
    const nonce = contract.newNonce();
    const r = http.request({
      host: '127.0.0.1', port: hub.port, method: 'POST', path: '/v1/attach', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: contract.signRequest(hub.control, 'POST', '/v1/attach', nonce) }
    });
    req = r;
    const lost = why => {
      if (ended) return;
      ended = true;
      if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
      if (req === r) req = null;
      if (stopped) return;
      if (!gotHello) return;          // the paths before the hello decide for themselves
      log('info', 'the hub connection ended: ' + why);
      setState('connecting');
      soon();
    };
    r.on('error', error => {
      if (ended || stopped) { ended = true; return; }
      if (gotHello) { lost(className(error)); return; }
      ended = true;
      if (req === r) req = null;
      if (error.code === 'ECONNREFUSED') { failures = 0; startLocalHub(hub); return; }
      // A port that takes the connection and then drops it: try a few times, then say it is held.
      if (++failures >= 3) { failures = 0; blocked(error.code || className(error)); } else soon();
    });
    r.on('response', res => {
      if (res.statusCode !== 200 || !/^application\/x-ndjson/.test(res.headers['content-type'] || '')) {
        ended = true; res.resume(); r.destroy(); if (req === r) req = null;
        blocked('status ' + res.statusCode);
        return;
      }
      res.setEncoding('utf8');
      helloTimer = setTimeout(() => { helloTimer = null; if (!gotHello) { ended = true; r.destroy(); if (req === r) req = null; blocked('no hello'); } }, timings.helloMs);
      res.on('data', chunk => {
        if (ended) return;
        buffer += chunk;
        if (buffer.length > MAX_LINE) { log('warn', 'a line from the hub is too long'); r.destroy(); lost('too long'); return; }
        let cut;
        while ((cut = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { message = null; }
          if (!gotHello) {
            if (!message || message.type !== 'hello' || message.v !== 1 || typeof message.epoch !== 'string') {
              ended = true; r.destroy(); if (req === r) req = null; blocked('not a hub'); return;
            }
            // Nothing from this connection is passed on unless the hello proves it holds our token.
            if (typeof message.proof !== 'string' || !contract.sameText(message.proof, contract.hubProof(hub.control, nonce))) {
              ended = true; r.destroy(); if (req === r) req = null; blocked('not our hub'); return;
            }
            gotHello = true; failures = 0; attachVersion = sent;
            if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
            setState('up');
            emit({ type: 'hello', v: 1, epoch: message.epoch, pid: message.pid });
            // Changes made while the attach was on its way go out now, in order.
            if (version !== attachVersion) send({ folders: win.folders, scope }, false);
            continue;
          }
          if (!message || typeof message !== 'object' || typeof message.type !== 'string') continue;
          if (message.type === 'bye') { r.destroy(); lost('bye'); return; }
          emit(message);
        }
      });
      res.on('end', () => { if (!gotHello && !ended) { ended = true; if (req === r) req = null; blocked('closed before hello'); } else lost('end'); });
      res.on('close', () => { if (!gotHello && !ended) { ended = true; if (req === r) req = null; if (!stopped) soon(); } else lost('close'); });
      res.on('error', () => lost('error'));
    });
    r.end(body);
  }

  /* ---------- control requests ---------- */

  function request(method, path, value, timeout = timings.requestMs) {
    return new Promise(resolve => {
      const hub = contract.readHubFile(options.home);
      if (!hub) { resolve(null); return; }
      const body = value === undefined ? '' : JSON.stringify(value);
      const nonce = contract.newNonce();
      const headers = { Authorization: contract.signRequest(hub.control, method, path, nonce) };
      if (value !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
      let done = false;
      const finish = result => { if (!done) { done = true; resolve(result); } };
      const r = http.request({ host: '127.0.0.1', port: hub.port, method, path, agent: false, headers, timeout }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', c => { text += c; if (text.length > 16 * 1024 * 1024) r.destroy(); });
        res.on('end', () => {
          if (res.statusCode !== 200) { finish(null); return; }
          // An answer that does not prove our token (a stranger on the port) is not used: no path from it is opened.
          const proof = res.headers['x-wyarden-proof'];
          if (typeof proof !== 'string' || !contract.sameText(proof, contract.hubProof(hub.control, nonce))) {
            log('warn', path + ' answered by something that is not our hub');
            finish(null); return;
          }
          try { finish(JSON.parse(text)); } catch { finish(null); }
        });
        res.on('error', () => finish(null));
      });
      r.on('timeout', () => r.destroy());
      r.on('error', error => { log('warn', path + ' failed: ' + (error.code || className(error))); finish(null); });
      r.end(body);
    });
  }
  function send(change, remember) {
    const body = Object.assign({ window: win.id }, change);
    const sentVersion = version;
    queue = queue.then(() => (stopped ? null : request('POST', '/v1/update', body))).then(answer => {
      if (answer === null && remember && !stopped) log('warn', 'an update did not reach the hub; it goes with the next attach');
      if (answer !== null && sentVersion === version) attachVersion = version;
    });
    return queue;
  }

  client.start = function start() {
    if (started || stopped) return;
    started = true;
    attach();
  };
  /** New folders or scope: kept, sent now when connected, and part of every later attach. */
  client.update = function update(change = {}) {
    if (!change || typeof change !== 'object' || stopped) return Promise.resolve();
    const out = {};
    if (change.folders !== undefined) { win.folders = Array.isArray(change.folders) ? change.folders : []; out.folders = win.folders; }
    if (change.scope !== undefined) { scope = change.scope; out.scope = scope; }
    if (out.folders !== undefined || out.scope !== undefined) version++;
    // A fresh snapshot is for now only: an attach brings one anyway, so it is never replayed.
    if (change.snapshot === true) out.snapshot = true;
    if (!Object.keys(out).length) return Promise.resolve();
    if (state !== 'up') return Promise.resolve();
    return send(out, true);
  };
  client.resolve = async function resolve(target) {
    const answer = await request('POST', '/v1/resolve', { window: win.id, target });
    return answer && typeof answer === 'object' && typeof answer.kind === 'string' ? answer : { kind: 'none' };
  };
  const actionRequest = (value, timeout) => {
    const body = { window: win.id, ...value };
    return request('POST', contract.actionPath(JSON.stringify(body)), body, timeout);
  };
  client.act = async (action, target) => (await actionRequest({ action, target }, contract.ACTION_WAIT_MS + timings.requestMs))?.result;
  client.claim = async id => (await actionRequest({ id, claim: true }))?.granted === true;
  client.actionDone = (id, result) => actionRequest({ id, result });
  client.status = async function status() {
    const answer = await request('GET', '/v1/status');
    return answer && typeof answer === 'object' ? answer : null;
  };
  /** Close the connection, and the hub when this host runs it. Safe to call twice. */
  client.stop = function stop() {
    if (stopping) return stopping;
    stopped = true;
    clearTimers();
    if (req) { try { req.destroy(); } catch { /* gone already */ } req = null; }
    const waits = [];
    if (worker) { waits.push(closeWorker(worker)); worker = null; }
    if (localHub) { waits.push(localHub.close().catch(() => {})); localHub = null; }
    client.role = 'client';
    setState('stopped');
    stopping = Promise.all(waits).then(() => {});
    return stopping;
  };
  return client;
}

module.exports = { createHubClient, TIMINGS };
