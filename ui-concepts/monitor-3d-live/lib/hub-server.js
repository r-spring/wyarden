/* Wyarden 3D monitor, working mock-up: the hub's listener, its timers, and its worker entry.
 *
 * One hub per machine. It listens on 127.0.0.1 only, on the port written once in hub.json, and
 * does four things: takes hook payloads from Claude Code (and answers at once, because a hook
 * holds the agent until it is answered), keeps one open line-per-message connection to each
 * editor window, reads the CLI's session list and the transcripts while some window shows the
 * view, and answers resolve and status for holders of the control token. Everything it decides is
 * in hub-core.js; this file is the I/O around it.
 *
 * It runs as a worker thread inside one window's extension host (so a frozen host never makes an
 * agent wait), or in the host's own thread when a worker cannot be made. The contract is
 * docs/monitor-3d/05-working-mockup.md, section 7.2; the security rules are 04, section 4.5.
 */
'use strict';
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const contract = require('./contract.js');
const { createHubCore } = require('./hub-core.js');

const { LIMITS } = contract;
const HOST = '127.0.0.1';
const TIMINGS = {
  discoveryMs: 3000, tailMs: 700, workspacesMs: 250,
  headersMs: 5000,          // a request's headers must arrive in this time
  requestMs: 10000,         // and the whole request (headers and body) in this; an attach RESPONSE is not timed
  bodyMs: 10000,            // a body that stops arriving is dropped after this, and its memory freed
  keepAliveMs: 5000,
  checkMs: 1000,            // how often Node looks for requests past their time
  stuckMs: 5000             // a window with a backlog that writes nothing for this long is closed
};
const MAX_CONNECTIONS = 256;
const PROOF_HEADER = 'x-wyarden-proof';
const CONTROL_BODY = 1024 * 1024;
const STUCK_BYTES = 4 * 1024 * 1024;        // a window this far behind that makes no progress for stuckMs is closed
const MAX_BACKLOG_BYTES = 32 * 1024 * 1024; // a window this far behind is closed at once: the hub's memory
const WRITE_PIECE = 256 * 1024;
const MAX_TAILS = 24;
const TAIL_LOOKBACK = 2 * 1024 * 1024;
const NOT_FOUND = 'Not found\n';
const className = error => (error && error.constructor && error.constructor.name) || typeof error;

/** The real module for each source, or null when it is missing or fails to load: that source is then off. */
function loadDeps(given) {
  const deps = Object.assign({}, given);
  const off = [];
  const want = (name, file, exportName) => {
    if (typeof deps[name] === 'function') return;
    if (deps[name] === null) { off.push(name); return; }        // a test's way to say "this module is missing"
    try {
      const fn = require(file)[exportName];
      if (typeof fn !== 'function') throw new TypeError(exportName + ' is not a function');
      deps[name] = fn;
    } catch { deps[name] = null; off.push(name); }
  };
  want('createNormaliser', './normalise.js', 'createNormaliser');
  want('claudeConfigDirs', './discover.js', 'claudeConfigDirs');
  want('liveClaudeSessions', './discover.js', 'liveClaudeSessions');
  want('createTail', './transcript.js', 'createTail');
  return { deps, off };
}

function sameToken(given, expected) {
  const a = Buffer.from(String(given)), b = Buffer.from(String(expected));
  if (a.length !== b.length) { crypto.timingSafeEqual(b, b); return false; }
  return crypto.timingSafeEqual(a, b);
}
/**
 * The rule for one window's backlog: 'ceiling' (close at once), 'stuck' (close: a backlog and no
 * progress for stuckMs), 'waiting' (a backlog, still moving: look again soon) or 'ok'.
 * Note: on Windows the kernel takes a loopback write whole even when the reader reads nothing
 * (200 MB was measured), so there the backlog stays near zero and only Linux-like systems ever
 * reach 'stuck' or 'ceiling'.
 */
function judgeBacklog(waiting, quietMs, limits, timings) {
  if (waiting > limits.maxBacklogBytes) return 'ceiling';
  if (waiting <= limits.stuckBytes) return 'ok';
  return quietMs >= timings.stuckMs ? 'stuck' : 'waiting';
}
/** The path of a request, with no query: what a control request's signature covers. */
const pathOf = url => { const cut = url.indexOf('?'); return cut < 0 ? url : url.slice(0, cut); };

/**
 * Start the hub. Resolves with {port, core, close()} once it listens; rejects with the listen
 * error (error.code 'EADDRINUSE' when another hub has the port).
 */
function startHub(options = {}) {
  return new Promise((resolve, reject) => {
    let hub;
    try { hub = options.hub || contract.readHubFile(options.home) || contract.ensureHubFile(options.home); }
    catch (error) { reject(error); return; }
    const log = typeof options.log === 'function'
      ? (level, message) => { try { options.log(level, message); } catch { /* a logger never stops the hub */ } }
      : () => {};
    const timings = Object.assign({}, TIMINGS, options.timings);
    const limits = Object.assign({ body: LIMITS.body, stuckBytes: STUCK_BYTES, maxBacklogBytes: MAX_BACKLOG_BYTES }, options.limits);
    const userHome = typeof options.userHome === 'string' ? options.userHome : os.homedir();
    const env = options.env && typeof options.env === 'object' ? options.env : process.env;
    const { deps, off } = loadDeps(options.deps);
    if (deps.claudeConfigDirs === null || deps.liveClaudeSessions === null) {
      for (const k of ['claudeConfigDirs', 'liveClaudeSessions']) if (!off.includes(k)) off.push(k);
    }
    const discoveryOn = !!(deps.claudeConfigDirs && deps.liveClaudeSessions);
    const schedule = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return () => clearTimeout(timer); };

    let normaliser = null;
    if (deps.createNormaliser) {
      try { normaliser = deps.createNormaliser({ rootInfo: contract.rootInfo }); } catch (error) { log('error', 'the normaliser cannot start: ' + className(error)); }
    }
    if (!normaliser && !off.includes('createNormaliser')) off.push('createNormaliser');
    const epoch = crypto.randomBytes(4).toString('hex');
    const core = createHubCore({ normaliser: normaliser || undefined, now: Date.now, schedule, log, epoch, rootInfo: contract.rootInfo,
      lingerMs: options.lingerMs, silentMs: options.silentMs, goneAfter: options.goneAfter });
    core.setInfo({ role: options.role === 'worker' ? 'worker' : 'thread', off });

    const conns = new Map();         // window id -> {res, pending, id}
    const actions = new Map();       // relay id -> request and its candidate editor connections
    const sockets = new Set();
    const tails = new Map();         // session key -> tail
    let flushQueued = false, closing = false, discoveryTimer = null, tailTimer = null;
    let wsCancel = null, lastWsFlush = 0;

    /* ---------- messages to windows: batched per turn of the event loop ---------- */

    /* A window is judged by progress, not by size: a snapshot followed at once by events can leave
       megabytes waiting for a window that reads perfectly well. It is closed when more than
       `maxBacklogBytes` waits (the hub's memory), or when more than `stuckBytes` waits and nothing
       of it has been written for `stuckMs`. A closed window attaches again and gets a snapshot. */
    let stuckTimer = null;
    const dropWindow = (conn, why) => {
      log('warn', 'a window ' + why + '; its connection is closed');
      conn.pending = [];
      conn.res.destroy();
    };
    const checkBacklogs = () => {
      const t = Date.now();
      let backlog = false;
      for (const conn of conns.values()) {
        if (conn.res.destroyed) continue;
        const verdict = judgeBacklog(conn.res.writableLength, t - conn.progressAt, limits, timings);
        if (verdict === 'ceiling') dropWindow(conn, 'has too much waiting');
        else if (verdict === 'stuck') dropWindow(conn, 'stopped reading');
        else if (verdict === 'waiting') backlog = true;
      }
      // The timer runs only while some window has a backlog, so a window that never gets another message is still judged.
      if (backlog && !stuckTimer) { stuckTimer = setInterval(checkBacklogs, Math.max(20, Math.min(1000, Math.floor(timings.stuckMs / 4)))); stuckTimer.unref(); }
      else if (!backlog && stuckTimer) { clearInterval(stuckTimer); stuckTimer = null; }
    };
    const flushAll = () => {
      flushQueued = false;
      for (const conn of conns.values()) {
        if (!conn.pending.length || conn.res.destroyed) continue;
        const bytes = Buffer.from(conn.pending.map(m => JSON.stringify(m) + '\n').join(''), 'utf8');
        conn.pending = [];
        // A write into an empty queue starts a new wait; each piece that reaches the socket is
        // progress. Pieces, so a large message that is being read shows progress before its end.
        if (conn.res.writableLength === 0) conn.progressAt = Date.now();
        const done = () => { conn.progressAt = Date.now(); };
        for (let at = 0; at < bytes.length; at += WRITE_PIECE) conn.res.write(bytes.subarray(at, at + WRITE_PIECE), done);
      }
      checkBacklogs();
    };
    core.onSend = (id, message) => {
      const conn = conns.get(id);
      if (!conn) return;
      const p = conn.pending;
      if (message.type === 'records') {
        const first = message.records[0];
        // A snapshot is the whole picture: records still waiting to go out are part of it already.
        if (first && first.ctl === 'snapshot') conn.pending = p.filter(m => m.type !== 'records');
        const last = conn.pending[conn.pending.length - 1];
        if (last && last.type === 'records' && last.scope === message.scope) last.records = last.records.concat(message.records);
        else conn.pending.push({ type: 'records', scope: message.scope, records: message.records.slice() });
      } else if (message.type === 'workspaces') {
        conn.pending = p.filter(m => m.type !== 'workspaces');
        conn.pending.push(message);
      } else p.push(message);
      if (!flushQueued) { flushQueued = true; setImmediate(flushAll); }
    };
    // At most four `workspaces` rounds a second, through the same unref'd timers as everything else.
    core.onWorkspacesPending = () => {
      if (wsCancel || closing) return;
      const wait = Math.max(0, lastWsFlush + timings.workspacesMs - Date.now());
      wsCancel = schedule(() => { wsCancel = null; lastWsFlush = Date.now(); try { core.flushWorkspaces(); } catch (error) { log('warn', 'workspaces failed: ' + className(error)); } }, wait);
    };

    /* ---------- discovery and transcripts: only while some window shows a scope ---------- */

    const discoverOnce = () => {
      if (closing) return;
      const t = Date.now();
      if (discoveryOn) {
        try {
          const dirs = deps.claudeConfigDirs({ home: userHome, env });
          const list = deps.liveClaudeSessions(dirs, {});
          for (const item of Array.isArray(list) ? list : []) {
            if (item && typeof item.cwd === 'string' && !item.root) { try { item.root = contract.rootInfo(item.cwd); } catch { /* no root */ } }
          }
          core.setLiveSessions(list, t);
        } catch (error) { log('warn', 'discovery failed: ' + className(error)); }
      }
      try { core.sweep(t); } catch (error) { log('warn', 'the silence rule failed: ' + className(error)); }
    };
    const targetsNow = () => {
      try { return core.tailTargets().slice(0, MAX_TAILS); } catch (error) { log('warn', 'tail targets failed: ' + className(error)); return []; }
    };
    /** A tail for each target that has none, within the cap. Returns the new ones. */
    const openTails = targets => {
      const fresh = [];
      if (!deps.createTail) return fresh;
      for (const target of targets) {
        if (tails.has(target.key) || tails.size >= MAX_TAILS) continue;
        // Real transcripts hold large request lines: 256 KB reached back only a few calls.
        try {
          const tail = deps.createTail(target.transcript, { session: target.session, cwd: target.cwd, lookback: TAIL_LOOKBACK });
          tails.set(target.key, tail); fresh.push(tail);
        } catch (error) { log('warn', 'a transcript tail cannot start: ' + className(error)); }
      }
      return fresh;
    };
    const drain = tail => {
      let payloads = [];
      try { payloads = tail.poll() || []; } catch (error) { log('warn', 'a transcript poll failed: ' + className(error)); }
      for (const payload of payloads) {
        try { core.ingest(payload, { hint: 'transcript', t: Date.now() }); } catch (error) { log('warn', 'a transcript payload failed: ' + className(error)); }
      }
    };
    const pollTails = () => {
      if (closing) return;
      const targets = targetsNow();
      const want = new Set(targets.map(x => x.key));
      for (const [key, tail] of tails) if (!want.has(key)) { try { tail.close(); } catch { /* gone already */ } tails.delete(key); }
      // A tail opened here (a session discovery found while a scope is shown) gives its replay on
      // this first poll, and the replay goes out as live records. Accepted: a session that just
      // started has little history, and the snapshots already made cannot hold it.
      openTails(targets);
      for (const tail of [...tails.values()]) drain(tail);
      core.setInfo({ tails: tails.size });
    };
    /* Just before a snapshot: new tails are opened and polled once, so the recent calls their first
       poll replays are inside the snapshot instead of following it as motion. Tails that exist are
       left to their timer. */
    core.onBeforeSnapshot = () => {
      if (closing) return;
      for (const tail of openTails(targetsNow())) drain(tail);
      core.setInfo({ tails: tails.size });
    };
    const closeTails = () => { for (const tail of tails.values()) { try { tail.close(); } catch { /* gone already */ } } tails.clear(); core.setInfo({ tails: 0 }); };
    const syncTimers = () => {
      const need = !closing && core.needsDiscovery();
      if (need && !discoveryTimer) {
        discoveryTimer = setInterval(discoverOnce, timings.discoveryMs); discoveryTimer.unref();
        tailTimer = setInterval(pollTails, timings.tailMs); tailTimer.unref();
      } else if (!need && discoveryTimer) {
        clearInterval(discoveryTimer); clearInterval(tailTimer); discoveryTimer = tailTimer = null;
        closeTails();
      }
    };
    /** The first window to ask for a scope gets the live sessions in its snapshot, not 3 s later. */
    const beforeScope = scope => { if (scope != null && !core.needsDiscovery()) discoverOnce(); };

    /* ---------- requests ---------- */

    const notFound = res => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(NOT_FOUND), Connection: 'close' });
      res.end(NOT_FOUND);
    };
    /** A JSON answer. With `nonce`, it carries the hub's proof, so the window can tell its hub from a stranger. */
    const json = (res, status, value, nonce) => {
      const text = JSON.stringify(value);
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) };
      if (nonce) headers[PROOF_HEADER] = contract.hubProof(hub.control, nonce);
      res.writeHead(status, headers);
      res.end(text);
    };
    /** Read a body up to `max` bytes. `done(buffer)`, or `done(null)` when it was larger.
        A body that stops arriving is dropped after `bodyMs`: the socket is destroyed and the chunks let go. */
    const readBody = (req, max, done) => {
      let chunks = [];
      let size = 0, over = false;
      const timer = setTimeout(() => {
        if (over) return;
        over = true; chunks = [];
        log('warn', 'a request body stopped arriving after ' + size + ' bytes; dropped');
        req.socket.destroy();
      }, timings.bodyMs);
      timer.unref();
      req.on('data', chunk => {
        if (over) return;
        size += chunk.length;
        if (size > max) { over = true; clearTimeout(timer); chunks = []; req.pause(); done(null, size); return; }
        chunks.push(chunk);
      });
      req.on('end', () => { clearTimeout(timer); if (!over) { over = true; const body = Buffer.concat(chunks, size); chunks = []; done(body, size); } });
      req.on('error', () => { clearTimeout(timer); chunks = []; over = true; });
      req.on('close', () => { clearTimeout(timer); if (!over) { over = true; chunks = []; } });
    };
    const parse = buffer => { try { return JSON.parse(buffer.toString('utf8')); } catch { return undefined; } };

    const ingest = (req, res, agent) => {
      readBody(req, limits.body, (buffer, size) => {
        if (!buffer) {
          core.countBody('tooLarge');
          log('warn', 'a hook body over the limit was dropped: ' + size + '+ bytes');
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 2, Connection: 'close' });
          res.end('{}', () => { req.socket.end(); const t = setTimeout(() => req.socket.destroy(), 1000); t.unref(); });
          return;
        }
        // Answer first: the agent waits for this answer and nothing below concerns it.
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 2 });
        res.end('{}');
        setImmediate(() => {
          let payload, event = '?';
          try {
            payload = parse(buffer);
            if (payload === undefined) { core.countBody('rejected'); log('warn', 'a hook body is not JSON: ' + size + ' bytes'); return; }
            if (payload && typeof payload.hook_event_name === 'string' && /^[A-Za-z]{1,40}$/.test(payload.hook_event_name)) event = payload.hook_event_name;
            core.ingest(payload, { hint: agent, t: Date.now() });
          } catch (error) {
            log('warn', 'a hook payload failed: event ' + event + ', ' + size + ' bytes, ' + className(error));
          } finally { payload = null; buffer = null; }
        });
      });
    };

    const attach = (req, res, nonce) => {
      readBody(req, CONTROL_BODY, buffer => {
        const body = buffer && parse(buffer);
        if (!body || typeof body !== 'object' || !body.window || typeof body.window !== 'object') { json(res, 400, {}); return; }
        if (closing) { notFound(res); return; }
        const win = body.window;
        const scope = body.scope === undefined ? null : body.scope;
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.flushHeaders();
        req.socket.setNoDelay(true);
        req.socket.setTimeout(0);
        // The proof answers this request's nonce: only a holder of the control token can make it.
        res.write(JSON.stringify({ type: 'hello', v: 1, epoch, pid: process.pid, proof: contract.hubProof(hub.control, nonce) }) + '\n');
        const id = contract.safeId(win.id) || 'w-' + crypto.randomBytes(4).toString('hex');
        const old = conns.get(id);
        const conn = { id, res, pending: [], progressAt: Date.now(), actions: win.actions === true };
        conns.set(id, conn);
        if (old) old.res.end();                       // the same window again: the old line is done
        beforeScope(scope);
        const got = core.attach({ id, app: win.app, name: win.name, pid: win.pid, folders: win.folders, scope });
        if (got === null) { conns.delete(id); res.end(JSON.stringify({ type: 'bye', why: 'too-many-windows' }) + '\n'); return; }
        syncTimers();
        const gone = () => {
          for (const action of actions.values()) {
            if (action.origin === conn || action.claimed === conn) action.finish(action.claimed ? 'failed' : undefined);
            else if (action.peers.delete(conn) && !action.peers.size) action.finish();
          }
          if (conns.get(id) !== conn) return;
          conns.delete(id);
          core.detach(id);
          syncTimers();
        };
        res.on('close', gone);
      });
    };
    const control = (req, res, nonce, fn) => {
      readBody(req, CONTROL_BODY, buffer => {
        const body = buffer && parse(buffer);
        if (!body || typeof body !== 'object') { json(res, 400, {}, nonce); return; }
        let answer;
        try { answer = fn(body); } catch (error) { log('warn', 'a control request failed: ' + className(error)); answer = {}; }
        json(res, 200, answer, nonce);
      });
    };

    const relay = (req, res, nonce, pathname) => {
      readBody(req, CONTROL_BODY, buffer => {
        if (!buffer || pathname !== contract.actionPath(buffer)) return notFound(res);
        const body = parse(buffer);
        const conn = conns.get(body?.window);
        if (!conn?.actions || closing) return json(res, 200, {}, nonce);
        if (typeof body.id === 'string') {
          const pending = actions.get(body.id);
          if (!pending?.peers.has(conn)) return json(res, 200, {}, nonce);
          if (body.claim === true) {
            const granted = !pending.claimed;
            if (granted) pending.claimed = conn;
            return json(res, 200, { granted }, nonce);
          }
          pending.peers.delete(conn);
          if (pending.claimed === conn) {
            const expected = pending.action === 'focus' ? ['terminal', 'panel'] : ['opened', 'revealed'];
            pending.finish(expected.includes(body.result) ? body.result : 'failed');
          } else if (!pending.peers.size) pending.finish();
          return json(res, 200, {}, nonce);
        }

        const { action, target } = body;
        if (!target || typeof target.id !== 'string' || target.id.length > 1200 ||
            (target.member !== undefined && (typeof target.member !== 'string' || target.member.length > LIMITS.path))) {
          return json(res, 400, {}, nonce);
        }
        if (actions.size >= 32) return json(res, 200, { result: 'failed' }, nonce);
        const peers = core.actionWindows(conn.id, action, target).map(id => conns.get(id)).filter(peer => peer?.actions && !peer.res.destroyed);
        if (!peers.length) return json(res, 200, {}, nonce);
        // The first workspace holding a file is the most specific. A session's terminals are tested in parallel.
        if (action === 'open') peers.length = 1;
        const id = contract.newNonce();
        const pending = { origin: conn, action, peers: new Set(peers), claimed: null, finish };
        const timer = setTimeout(() => finish(pending.claimed ? 'failed' : undefined), contract.ACTION_WAIT_MS);
        timer.unref();
        actions.set(id, pending);
        res.on('close', () => finish());
        function finish(result) {
          if (!actions.delete(id)) return;
          clearTimeout(timer);
          if (!res.destroyed) json(res, 200, { result }, nonce);
        }
        const node = { class: action === 'focus' ? 'agent' : 'resource', id: target.id };
        for (const peer of peers) core.onSend(peer.id, { type: 'action', id, action, target: node, member: target.member });
      });
    };

    const ingestPrefix = '/' + contract.MARK + '/h/';
    const server = http.createServer({ connectionsCheckingInterval: timings.checkMs }, (req, res) => {
      try {
        // These checks come first, and every refusal is the same 404: a wrong token reads as a wrong path.
        if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) return notFound(res);
        if (req.headers.host !== HOST + ':' + port) return notFound(res);
        const url = req.url || '';
        if (url.startsWith(ingestPrefix)) {
          const m = /^([A-Za-z0-9_-]+)\/([a-z]+)$/.exec(url.slice(ingestPrefix.length));
          if (req.method !== 'POST' || !m || !sameToken(m[1], hub.ingest)) return notFound(res);
          return ingest(req, res, m[2]);
        }
        // A control request is signed for its method and path with a fresh nonce; the token itself never travels.
        const pathname = pathOf(url);
        const nonce = pathname.startsWith('/v1/') ? contract.checkRequest(hub.control, req.method, pathname, req.headers.authorization) : null;
        if (!nonce) return notFound(res);
        if (req.method === 'POST' && /^\/v1\/action\/[0-9a-f]{64}$/.test(pathname)) return relay(req, res, nonce, pathname);
        if (req.method === 'POST' && pathname === '/v1/attach') return attach(req, res, nonce);
        if (req.method === 'POST' && pathname === '/v1/update') {
          return control(req, res, nonce, body => {
            const change = {};
            for (const k of ['folders', 'scope', 'snapshot']) if (body[k] !== undefined) change[k] = body[k];
            if (change.scope !== undefined) beforeScope(change.scope);
            core.update(body.window, change);
            syncTimers();
            return {};
          });
        }
        if (req.method === 'POST' && pathname === '/v1/resolve') return control(req, res, nonce, body => core.resolve(body.target));
        if (req.method === 'GET' && pathname === '/v1/status') return json(res, 200, core.status(), nonce);
        return notFound(res);
      } catch (error) {
        log('error', 'a request failed: ' + className(error));
        try { notFound(res); } catch { /* the socket is gone */ }
      }
    });
    // requestTimeout covers the arrival of a request, not the life of its response: an attach line
    // stays open for as long as its window does (a test holds one open past these times).
    server.headersTimeout = timings.headersMs;
    server.requestTimeout = timings.requestMs;
    server.keepAliveTimeout = timings.keepAliveMs;
    server.maxConnections = MAX_CONNECTIONS;
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    // A broken or timed-out request gets no page at all (not Node's own 400 or 408): the socket goes.
    server.on('clientError', (error, socket) => { socket.destroy(); });
    // An `Expect:` header Node does not know would get its own 417 page; it gets the same 404 as the rest.
    server.on('checkExpectation', (req, res) => notFound(res));

    const port = hub.port;
    let listening = false;
    server.once('error', error => { if (!listening) reject(error); });
    server.listen({ port, host: HOST, exclusive: true }, () => {
      listening = true;
      const address = server.address();
      if (!address || typeof address !== 'object' || address.address !== HOST) {
        server.close();
        reject(Object.assign(new Error('the hub is not bound to ' + HOST), { code: 'ENOTLOOPBACK' }));
        return;
      }
      server.on('error', error => log('error', 'the listener failed: ' + className(error)));
      log('info', 'the hub listens on port ' + port + (off.length ? '; off: ' + off.join(', ') : ''));
      let closed = null;
      resolve({
        port, core, epoch, address: { address: address.address, family: address.family, port: address.port },
        settings: { headersTimeout: server.headersTimeout, requestTimeout: server.requestTimeout, keepAliveTimeout: server.keepAliveTimeout, maxConnections: server.maxConnections },
        /** Stop timers and tails, say bye on every window's line, and free the port. */
        close() {
          if (closed) return closed;
          closing = true;
          if (discoveryTimer) { clearInterval(discoveryTimer); clearInterval(tailTimer); discoveryTimer = tailTimer = null; }
          if (wsCancel) { wsCancel(); wsCancel = null; }
          if (stuckTimer) { clearInterval(stuckTimer); stuckTimer = null; }
          closeTails();
          for (const action of actions.values()) action.finish(action.claimed ? 'failed' : undefined);
          closed = new Promise(done => {
            server.close(() => done());
            for (const conn of [...conns.values()]) {
              conns.delete(conn.id);
              try {
                const rest = conn.pending.map(m => JSON.stringify(m) + '\n').join('');
                conn.res.end(rest + JSON.stringify({ type: 'bye' }) + '\n');
              } catch { /* gone already */ }
            }
            for (const socket of sockets) socket.end();
            const t = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 300);
            t.unref();
          });
          return closed;
        }
      });
    });
  });
}

/* ---------- the worker entry ---------- */

function runWorker(workerThreads) {
  const { parentPort, workerData } = workerThreads;
  const post = message => { try { parentPort.postMessage(message); } catch { /* the parent is gone */ } };
  let hub = null, closing = false;
  const finish = () => { post({ type: 'closed' }); parentPort.close(); };
  parentPort.on('message', message => {
    if (!message || message.type !== 'close' || closing) return;
    closing = true;
    if (hub) hub.close().then(finish, finish);         // else the start below sees `closing`
  });
  startHub({
    home: workerData.home, hub: workerData.hub, role: 'worker', timings: workerData.timings, limits: workerData.limits,
    userHome: workerData.userHome, env: workerData.env, lingerMs: workerData.lingerMs,
    log: (level, message) => post({ type: 'log', level, message })
  }).then(started => {
    hub = started;
    if (closing) { hub.close().then(finish, finish); return; }
    post({ type: 'listening', port: started.port });
  }, error => {
    // The code and the class only: an error's message can hold a path.
    const code = error && typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'ERROR';
    post({ type: 'error', code, message: className(error) });
    if (closing) finish(); else parentPort.close();
  });
}

const workerThreads = require('node:worker_threads');
if (!workerThreads.isMainThread && workerThreads.workerData && workerThreads.workerData.wyardenHub) runWorker(workerThreads);

module.exports = { startHub, judgeBacklog, TIMINGS, STUCK_BYTES, MAX_BACKLOG_BYTES };
