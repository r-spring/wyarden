// The page tests' helper: a tiny loopback server for media/, and a headless Edge or Chrome driven
// over the DevTools protocol. Node built-ins only (no package), so it runs wherever the tests run.
//
// The server fills media/page.html as the extension host does (lib/view.js): a real content
// security policy of the same shape, a nonce, and the media folder's address. Before the page's own
// scripts it adds one nonce'd script, a stand-in for VS Code's acquireVsCodeApi(): every message the
// page posts is kept in window.__posted, every setState in window.__states, and getState() returns
// what the test chose. Host messages reach the page as they do in VS Code, as window "message" events.
//
// The browser driving follows ui-concepts/monitor-3d/shoot.js (itself from docs/monitor-3d/probe/
// shoot.js): a temporary profile, a remote-debugging port, and a probe that counts animation frames
// and canvas strokes before any page script runs. The WebSocket to the browser is written here,
// on node:http and node:crypto, so the tests do not depend on Node's own WebSocket.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

const MEDIA = path.join(__dirname, '..', 'media');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ---------- which browser ---------- */

/** Edge or Chrome: WYARDEN_BROWSER first, then the usual places. Returns { path } or { path: null, why }. */
function findBrowser(env = process.env) {
  if (env.WYARDEN_BROWSER) {
    return fs.existsSync(env.WYARDEN_BROWSER) ? { path: env.WYARDEN_BROWSER } : { path: null, why: 'WYARDEN_BROWSER names ' + env.WYARDEN_BROWSER + ', which does not exist' };
  }
  const candidates = [];
  if (process.platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
    candidates.push(...roots.map(r => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')), ...roots.map(r => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable']) for (const dir of dirs) candidates.push(path.join(dir, name));
  }
  const found = candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  return found ? { path: found } : { path: null, why: 'neither Edge nor Chrome was found (set WYARDEN_BROWSER to its path)' };
}

/* ---------- the server ---------- */

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

/** The stand-in for acquireVsCodeApi, as a script. `state` is what getState() returns at first. */
function standIn(state) {
  const json = JSON.stringify(state === undefined ? null : state).replace(/</g, '\\u003c');
  return `(() => {
  'use strict';
  const copy = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  let state = ${json}, taken = false;
  window.__posted = []; window.__states = [];
  window.acquireVsCodeApi = () => {
    if (taken) throw new Error('acquireVsCodeApi may be called only once');      // as in VS Code
    taken = true;
    return Object.freeze({
      postMessage: message => { window.__posted.push(copy(message)); },
      getState: () => copy(state),
      setState: next => { state = copy(next); window.__states.push(copy(next)); return next; }
    });
  };
})();`;
}

function startServer() {
  const nonce = crypto.randomBytes(18).toString('base64url');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
    if (url.pathname === '/' || url.pathname === '/page.html') {
      const base = 'http://127.0.0.1:' + server.address().port + '/media';
      const csp = require('../lib/view.js').policy(nonce);        // the host's own policy, so the page is tested under what it really gets
      const template = fs.readFileSync(path.join(MEDIA, 'page.html'), 'utf8');
      let html = template.split('{{csp}}').join(csp).split('{{nonce}}').join(nonce).split('{{base}}').join(base);
      const at = html.indexOf('<script');
      html = html.slice(0, at) + '<script nonce="' + nonce + '">' + standIn(server.nextState) + '</script>\n' + html.slice(at);
      return send(200, TYPES['.html'], html);
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const m = /^\/media\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
    if (m && !m[1].startsWith('.')) {
      const file = path.join(MEDIA, m[1]);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return send(200, TYPES[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file));
    }
    send(404, 'text/plain', 'not found');
  });
  server.nextState = null;
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server)); });
}

/* ---------- a WebSocket client, enough for the DevTools protocol ---------- */

class Socket extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket; this.buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0); this.parts = []; this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', chunk => { this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk; this.read(); });
    socket.on('close', () => { this.closed = true; this.emit('close'); });
    socket.on('error', error => this.emit('error', error));
    if (this.buffer.length) setImmediate(() => this.read());
  }
  static open(address) {
    return new Promise((resolve, reject) => {
      const u = new URL(address), key = crypto.randomBytes(16).toString('base64');
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } });
      req.on('upgrade', (res, socket, head) => {
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (res.headers['sec-websocket-accept'] !== accept) { socket.destroy(); return reject(new Error('the browser answered the WebSocket handshake wrongly')); }
        resolve(new Socket(socket, head));
      });
      req.on('response', res => reject(new Error('the browser refused the WebSocket: HTTP ' + res.statusCode)));
      req.on('error', reject);
      req.end();
    });
  }
  read() {
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let length = b[1] & 0x7f, at = 2;
      if (length === 126) { if (b.length < 4) return; length = b.readUInt16BE(2); at = 4; }
      else if (length === 127) { if (b.length < 10) return; length = Number(b.readBigUInt64BE(2)); at = 10; }
      const mask = masked ? b.subarray(at, at + 4) : null;
      if (masked) at += 4;
      if (b.length < at + length) return;
      const payload = Buffer.from(b.subarray(at, at + length));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = b.subarray(at + length);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this.frame(0xA, payload); continue; }
      if (op === 0xA) continue;
      this.parts.push(payload);
      if (fin) { const text = Buffer.concat(this.parts).toString('utf8'); this.parts = []; this.emit('message', text); }
    }
  }
  frame(op, payload) {
    if (this.closed) return;
    const length = payload.length;
    let head;
    if (length < 126) { head = Buffer.alloc(2); head[1] = 0x80 | length; }
    else if (length < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(length, 2); }
    else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(length), 2); }
    head[0] = 0x80 | op;
    const mask = crypto.randomBytes(4), body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];      // a client must mask what it sends
    this.socket.write(Buffer.concat([head, mask, body]));
  }
  send(text) { this.frame(0x1, Buffer.from(text, 'utf8')); }
  close() { if (this.closed) return; try { this.frame(0x8, Buffer.alloc(0)); } catch { /* already gone */ } this.closed = true; this.socket.end(); }
}

class Cdp extends EventEmitter {
  constructor(ws) {
    super();
    this.ws = ws; this.id = 1; this.waiting = new Map();
    ws.on('message', text => {
      const m = JSON.parse(text);
      if (m.id) {
        const w = this.waiting.get(m.id);
        if (!w) return;
        this.waiting.delete(m.id); clearTimeout(w.timer);
        if (m.error) w.reject(new Error(m.error.message)); else w.resolve(m.result);
      } else if (m.method) this.emit(m.method, m.params || {});
    });
    ws.on('close', () => { for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(new Error('the browser connection closed')); } this.waiting.clear(); });
  }
  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      const timer = setTimeout(() => { if (this.waiting.delete(id)) reject(new Error(method + ' timed out')); }, 30000);
      this.waiting.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('in the page: ' + r.exceptionDetails.text + ' ' + ((r.exceptionDetails.exception || {}).description || ''));
    return r.result.value;
  }
}

/* ---------- the probe: before any page script ---------- */

const PROBE = `(() => {
  const m = window.__m = { raf: 0, strokes: 0, errors: [], csp: [] };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => { m.raf++; return raf(cb); };
  const P = CanvasRenderingContext2D.prototype, stroke = P.stroke;
  P.stroke = function () { m.strokes++; return stroke.apply(this, arguments); };
  window.addEventListener('error', e => m.errors.push(String(e.message)));
  document.addEventListener('securitypolicyviolation', e => m.csp.push(e.violatedDirective + ' ' + e.blockedURI));
})();`;

/* ---------- the harness ---------- */

class Harness {
  /** Start the server and the browser. Always pair with close(), which also runs when a test fails. */
  static async start(browserPath) {
    const h = new Harness();
    h.server = await startServer();
    h.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-'));
    const args = ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + h.profile,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--mute-audio', '--hide-scrollbars',
      '--window-size=1280,720', 'about:blank'];
    if (typeof process.getuid === 'function' && process.getuid() === 0) args.unshift('--no-sandbox');      // a root container (CI) cannot use the sandbox
    // On Windows msedge.exe can hand over to the real browser process and exit with 0 at once, so the
    // child handle is not the browser. The browser's own process id comes from DevTools below, and
    // that is what close() ends, also when a test failed.
    h.child = spawn(browserPath, args, { stdio: 'ignore', windowsHide: true });
    h.child.on('error', () => { /* reported by devtoolsPort() as "did not open its port" */ });
    h.killOnExit = () => { for (const pid of [h.pid, h.child.pid]) if (pid) { try { process.kill(pid); } catch { /* gone */ } } };
    process.once('exit', h.killOnExit);
    try {
      const port = await h.devtoolsPort();
      const version = await getJson('http://127.0.0.1:' + port + '/json/version');
      h.browserCdp = new Cdp(await Socket.open(version.webSocketDebuggerUrl));
      try { const info = await h.browserCdp.send('SystemInfo.getProcessInfo'); h.pid = (info.processInfo.find(p => p.type === 'browser') || {}).id || null; } catch { h.pid = null; }
      const targets = await getJson('http://127.0.0.1:' + port + '/json/list');
      const page = targets.find(t => t.type === 'page');
      if (!page) throw new Error('the browser has no page to drive');
      h.cdp = new Cdp(await Socket.open(page.webSocketDebuggerUrl));
      h.errors = [];
      h.cdp.on('Runtime.consoleAPICalled', p => { if (p.type === 'error' || p.type === 'assert') h.errors.push('console: ' + p.args.map(a => a.value !== undefined ? a.value : a.description).join(' ')); });
      h.cdp.on('Runtime.exceptionThrown', p => h.errors.push('exception: ' + ((p.exceptionDetails.exception || {}).description || p.exceptionDetails.text)));
      h.cdp.on('Log.entryAdded', p => { if (p.entry.level === 'error') h.errors.push('log: ' + p.entry.text + (p.entry.url ? ' ' + p.entry.url : '')); });
      for (const domain of ['Page', 'Runtime', 'Log']) await h.cdp.send(domain + '.enable');
      await h.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    } catch (error) { await h.close(); throw error; }
    return h;
  }
  async devtoolsPort() {
    const file = path.join(this.profile, 'DevToolsActivePort');
    for (let i = 0; i < 120; i++) {
      try { const port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]); if (port > 0) return port; } catch { /* not written yet */ }
      if (this.child.exitCode !== null && this.child.exitCode !== 0) throw new Error('the browser exited at start (code ' + this.child.exitCode + ')');
      await sleep(125);
    }
    throw new Error('the browser did not open its DevTools port');
  }
  /** A fresh page. `state` is what the stand-in's getState() returns. */
  async open({ width = 1280, height = 720, state = null } = {}) {
    this.server.nextState = state;
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    this.errors = [];
    const loaded = new Promise(resolve => this.cdp.once('Page.loadEventFired', resolve));
    await this.cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + this.server.address().port + '/page.html' });
    await Promise.race([loaded, sleep(10000)]);
    for (let i = 0; i < 80; i++) { if (await this.eval('!!(window.Monitor3D && Monitor3D.view.redraw.frames > 0)').catch(() => false)) break; await sleep(50); }
    await sleep(150);
  }
  eval(expression) { return this.cdp.eval(expression); }
  /** Deliver a host message, and return once the page has handled it (a second message is a marker behind it). */
  deliver(message) {
    return this.eval(`new Promise(resolve => {
      const marker = 'harness-' + Math.random();
      const done = e => { if (e.data === marker) { window.removeEventListener('message', done); resolve(true); } };
      window.addEventListener('message', done);
      window.postMessage(${JSON.stringify(message).replace(/</g, '\\u003c')}, '*');
      window.postMessage(marker, '*');
    })`);
  }
  posted() { return this.eval('window.__posted'); }
  clearPosted() { return this.eval('window.__posted.length = 0'); }
  counters() { return this.eval('[Monitor3D.view.redraw.frames, __m.raf, __m.strokes]'); }
  async mouse(type, x, y, clickCount, modifiers) {
    await this.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: clickCount || 0, modifiers: modifiers || 0 });
  }
  async click(x, y) { await this.mouse('mouseMoved', x, y); await this.mouse('mousePressed', x, y, 1); await this.mouse('mouseReleased', x, y, 1); }
  async dblclick(x, y) { await this.click(x, y); await this.mouse('mousePressed', x, y, 2); await this.mouse('mouseReleased', x, y, 2); }
  /** One key press. `modifiers`: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
  async key(key, code, keyCode, modifiers) {
    for (const type of ['rawKeyDown', 'keyUp']) await this.cdp.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: modifiers || 0 });
  }
  async screenshot(file) {
    const png = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
    return file;
  }
  async close() {
    const cdp = this.browserCdp || this.cdp;
    try { if (cdp) await Promise.race([cdp.send('Browser.close'), sleep(2000)]); } catch { /* it may be gone */ }
    for (const c of [this.cdp, this.browserCdp]) { try { if (c) c.ws.close(); } catch { /* gone */ } }
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (const pid of [this.pid, this.child && this.child.exitCode === null ? this.child.pid : null]) {
      if (!pid) continue;
      for (let i = 0; i < 30 && alive(pid); i++) await sleep(100);
      if (alive(pid)) { try { process.kill(pid); } catch { /* gone */ } for (let i = 0; i < 30 && alive(pid); i++) await sleep(100); }
    }
    if (this.killOnExit) process.removeListener('exit', this.killOnExit);
    if (this.server) await new Promise(resolve => { this.server.closeAllConnections?.(); this.server.close(() => resolve()); });
    // Windows lets go of a closed browser's profile a moment after its process ends: try for a few seconds.
    for (let i = 0; this.profile && fs.existsSync(this.profile) && i < 20; i++) {
      try { fs.rmSync(this.profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { await sleep(250); }
    }
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let body = ''; res.setEncoding('utf8'); res.on('data', d => { body += d; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } }); }).on('error', reject);
  });
}

module.exports = { findBrowser, startServer, standIn, Harness, Socket, Cdp, PROBE, MEDIA, sleep };
