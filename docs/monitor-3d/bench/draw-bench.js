#!/usr/bin/env node
// Draw-time benchmark for docs/monitor-3d/03-build-approach.md. Node 22+ built-ins only (fetch, WebSocket).
//
//   node docs/monitor-3d/bench/draw-bench.js --scene <path to nexus-lattice scene.js> [--three <dir with three.module.js
//        and three.core.js>] [--out <results.json>] [--draws 50] [--warm 10] [--idle-seconds 10]
//
// It serves page.html, bench-page.js, the concept's scene.js and model.js (the folder of --scene) and, if given, three.js,
// on 127.0.0.1 only, then drives headless Microsoft Edge (or Chrome/Chromium off Windows) over the DevTools protocol, twice:
// once with --disable-gpu, as this repository's webview tests run, and once with the GPU allowed.
// The source files are read in place and never changed; nothing is copied into this repository.
// The results file records browser version, GPU string and CPU model, never a path, a user or a machine name.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const scenePath = arg('scene');
if (!scenePath || !fs.existsSync(scenePath)) { console.error('Give --scene <path to scene.js>.'); process.exit(2); }
const threeDir = arg('three');
const draws = +arg('draws', 50), warm = +arg('warm', 10), idleSeconds = +arg('idle-seconds', 10);
const out = arg('out');
const sizes = [40, 200, 1000];

const files = {
  '/': [path.join(__dirname, 'page.html'), 'text/html'],
  '/bench-page.js': [path.join(__dirname, 'bench-page.js'), 'text/javascript'],
  '/scene.js': [scenePath, 'text/javascript'],
  '/model.js': [path.join(path.dirname(scenePath), 'model.js'), 'text/javascript'],
};
if (threeDir) for (const f of ['three.module.js', 'three.core.js']) files['/three/' + f] = [path.join(threeDir, f), 'text/javascript'];

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const f = files[req.url.split('?')[0]];
      if (!f) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-store' });
      fs.createReadStream(f[0]).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function browserPath() {
  const c = process.platform !== 'win32' ? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'] : [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return c.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('cannot connect to ' + url)); });
    return new Cdp(ws);
  }
  constructor(ws) {
    this.ws = ws; this.id = 1; this.wait = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); const w = this.wait.get(m.id); if (w) { this.wait.delete(m.id); m.error ? w[1](new Error(m.error.message)) : w[0](m.result); } };
  }
  send(method, params = {}, timeout = 300_000) {
    return new Promise((ok, no) => {
      const id = this.id++, t = setTimeout(() => { this.wait.delete(id); no(new Error(method + ': no answer')); }, timeout);
      this.wait.set(id, [(v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); no(e); }]);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async metrics() { const r = await this.send('Performance.getMetrics'); return Object.fromEntries(r.metrics.map((m) => [m.name, m.value])); }
}

async function freePort() {
  const net = require('node:net');
  return new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
}

async function runOnce(url, gpu) {
  const exe = browserPath();
  if (!exe) throw new Error('No Edge, Chrome or Chromium found.');
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor3d-bench-'));
  const args = ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--window-size=1280,720', '--force-device-scale-factor=1', ...(gpu ? [] : ['--disable-gpu']), url];
  const child = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
  let browserWs;
  try {
    let page;
    for (let i = 0; i < 80 && !page; i++) {
      try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); page = list.find((t) => t.type === 'page' && t.url.startsWith(url)); } catch { /* not up yet */ }
      if (!page) await sleep(250);
    }
    if (!page) throw new Error('the page never appeared');
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    browserWs = version.webSocketDebuggerUrl;
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Performance.enable');
    for (let i = 0; i < 80 && !(await cdp.eval('!!window.benchReady')); i++) await sleep(250);
    const result = { gpuFlag: gpu ? 'GPU allowed' : '--disable-gpu', browser: version.Browser, gpu: await cdp.eval('bench.gpuInfo()'), canvas: [], three: [] };
    for (const n of sizes) result.canvas.push(await cdp.eval(`bench.benchCanvas(${n}, ${draws}, ${warm})`));
    result.canvasNoGlow = [];
    for (const n of sizes) result.canvasNoGlow.push(await cdp.eval(`bench.benchCanvas(${n}, ${draws}, ${warm}, true)`));
    result.domLabels = [];
    for (const n of sizes) result.domLabels.push(await cdp.eval(`bench.benchDomLabels(${n}, ${draws}, ${warm})`));
    if (threeDir) for (const n of sizes) result.three.push(await cdp.eval(`bench.benchThree(${n}, ${draws}, ${warm})`));
    // Idle: main-thread busy time (TaskDuration) over idleSeconds, at rest after one draw, then with the concept's
    // never-stopping animation loop. TaskDuration is the renderer main thread only; GPU process time is not counted.
    await cdp.eval('bench.drawOnce()'); await sleep(1000);
    let a = await cdp.metrics(); await sleep(idleSeconds * 1000); let b = await cdp.metrics();
    const rest = { seconds: idleSeconds, mainThreadBusyMs: +((b.TaskDuration - a.TaskDuration) * 1000).toFixed(1), frames: 0 };
    await cdp.eval('bench.startLoop()'); await sleep(1000);
    a = await cdp.metrics(); const f0 = await cdp.eval('0'); await sleep(idleSeconds * 1000); b = await cdp.metrics();
    const frames = await cdp.eval('bench.stopLoop()');
    const looping = { seconds: idleSeconds, mainThreadBusyMs: +((b.TaskDuration - a.TaskDuration) * 1000).toFixed(1), framesIncludingWarmup: frames + f0 };
    result.idle = { rest, rafLoop40: looping, jsHeapUsedMB: +(b.JSHeapUsedSize / 1048576).toFixed(1) };
    cdp.ws.close();
    return result;
  } finally {
    try { const b = await Cdp.connect(browserWs); await b.send('Browser.close', {}, 5000); } catch { try { child.kill(); } catch { /* gone */ } }
    await sleep(1500);
    if (process.platform === 'win32') try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already exited */ }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* left in temp */ }
  }
}

(async () => {
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const now = new Date(), local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const report = { date: local, method: { draws, warm, idleSeconds, viewport: '1280x720 at device scale 1', sizes }, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, platform: `${process.platform} ${os.release()}`, node: process.version, runs: [] };
  try {
    for (const gpu of [false, true]) { console.error(gpu ? 'run: GPU allowed' : 'run: --disable-gpu'); report.runs.push(await runOnce(url, gpu)); }
  } finally { server.close(); }
  const text = JSON.stringify(report, null, 2);
  if (out) fs.writeFileSync(out, text + '\n');
  console.log(text);
})().catch((e) => { console.error(e); process.exit(1); });
