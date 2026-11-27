// Monitor 3D mock-up: screenshots and measurements in a real browser. No packages (Node 22 or later).
//   node shoot.js [screenshot folder]     (default: docs/monitor-3d/img/after)
// It starts the loopback preview on a free port, drives headless Edge or Chrome over the DevTools
// protocol, saves one PNG per look and size, and writes what it measured to measured.json here.
// Adapted from docs/monitor-3d/probe/shoot.js in this repository (the probe used on the originals).
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), { spawn } = require('child_process'), { pathToFileURL } = require('url');
const preview = require('./serve.js');

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'docs', 'monitor-3d', 'img', 'after'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
const browser = [
  ...roots.map(r => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
  ...roots.map(r => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
  '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
].find(p => fs.existsSync(p));
if (!browser) { console.error('NO_BROWSER: neither Edge nor Chrome was found, so no screenshot was taken.'); process.exit(2); }
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// Counts animation frames asked for and canvas strokes, before any page script runs.
const PROBE = `(() => {
  const m = window.__m = { raf: 0, strokes: 0, errors: [] };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => { m.raf++; return raf(cb); };
  const P = CanvasRenderingContext2D.prototype, stroke = P.stroke;
  P.stroke = function () { m.strokes++; return stroke.apply(this, arguments); };
  window.addEventListener('error', e => m.errors.push(String(e.message)));
  document.addEventListener('securitypolicyviolation', e => m.errors.push('CSP: ' + e.violatedDirective + ' ' + e.blockedURI));
})();`;

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 1; this.waiting = new Map(); ws.onmessage = e => { const m = JSON.parse(e.data), w = m.id && this.waiting.get(m.id); if (!w) return; this.waiting.delete(m.id); if (m.error) w.reject(new Error(m.error.message)); else w.resolve(m.result); }; }
  static open(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); ws.onopen = () => resolve(new Cdp(ws)); ws.onerror = () => reject(new Error('could not reach the browser')); }); }
  send(method, params) { return new Promise((resolve, reject) => { const id = this.id++; this.waiting.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params: params || {} })); setTimeout(() => { if (this.waiting.delete(id)) reject(new Error(method + ' timed out')); }, 30000); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + ((r.exceptionDetails.exception || {}).description || '')); return r.result.value; }
}
const scriptSeconds = async c => (await c.send('Performance.getMetrics')).metrics.find(m => m.name === 'ScriptDuration').value;
const counters = c => c.eval('[Monitor3D.view.redraw.frames, __m.raf, __m.strokes]');
const overlaps = `(() => { const b = Monitor3D.view.labels; let n = 0; for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) if (b[i].x < b[j].x + b[j].w && b[j].x < b[i].x + b[i].w && b[i].y < b[j].y + b[j].h && b[j].y < b[i].y + b[i].h) n++; return n; })()`;

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const server = await preview.listen(0), base = 'http://127.0.0.1:' + server.address().port + '/';
  const port = await freePort(), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-3d-shoot-'));
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--window-size=1280,720', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const results = { browser: path.basename(browser), looks: {} };
  try {
    let targets;
    for (let i = 0; i < 80 && !targets; i++) { try { targets = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).filter(t => t.type === 'page'); if (!targets.length) targets = undefined; } catch { await sleep(250); } }
    if (!targets) throw new Error('the browser did not start');
    const c = await Cdp.open(targets[0].webSocketDebuggerUrl);
    await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Performance.enable');
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    const open = async (url, width, height) => {
      await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await c.send('Page.navigate', { url });
      for (let i = 0; i < 40; i++) { await sleep(150); if (await c.eval('!!(window.Monitor3D && Monitor3D.view.redraw.frames)').catch(() => false)) break; }
      await sleep(400);
    };
    const shot = async name => { const png = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(png.data, 'base64')); console.log('saved ' + name + '.png'); };
    // Select something worth reading in the inspector: an agent that waits for the owner, else one with an open call.
    const choose = `(() => { const all = [...Monitor3D.model.nodes.values()]; const n = all.find(n => n.cls === 'agent' && n.status === 'needs') || all.find(n => n.cls === 'agent' && n.open) || all.find(n => n.cls === 'agent'); if (n) Monitor3D.select(n.id, 'scene'); return n ? n.label : ''; })()`;

    for (const look of ['nexus', 'glasshouse']) {
      const r = results.looks[look] = {};
      const page = (agents, extra) => base + '?look=' + look + '&agents=' + agents + '&load=busy&warm=90&autostart=0' + (extra || '');

      await open(page(4), 1280, 720);
      // A real click on a tool selects it, and a real key press moves the selection to the next node.
      const target = await c.eval(`(() => { const v = Monitor3D.view, r = v.canvas.getBoundingClientRect(); const h = v.hit.find(h => Monitor3D.model.nodes.get(h.id).cls === 'tool' && document.elementFromPoint(r.left + h.x, r.top + h.y) === v.canvas); return { id: h.id, x: r.left + h.x, y: r.top + h.y }; })()`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
      await sleep(200);
      r.clickSelects = (await c.eval('Monitor3D.state.selected')) === target.id;
      await c.eval(`document.getElementById('scene').focus()`);
      for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 });
      await sleep(200);
      r.keyMovesSelection = await c.eval(`(() => { const order = MonitorNav.order(Monitor3D.model); return Monitor3D.state.selected === order[(order.indexOf(${JSON.stringify(target.id)}) + 1) % order.length]; })()`);
      r.listRowsMatchScene = await c.eval(`document.querySelectorAll('#twin [role=option]').length === Monitor3D.model.standing().length + [...Monitor3D.model.nodes.values()].filter(n => n.cls === 'agent' && n.status === 'needs').length`);
      r.inspectorListsVsCodeLabels = await c.eval(`document.querySelectorAll('#inspector .actions li').length > 0 && document.querySelectorAll('#inspector button, #inspector a').length === 0`);
      await c.eval(choose); await sleep(300); await shot(look);
      r.formControls = await c.eval(`document.querySelectorAll('input, select, textarea, form, [contenteditable]').length`);
      r.errors = await c.eval('__m.errors');

      await open(page(4), 1280, 720);
      await c.eval(`(() => { const n = [...Monitor3D.model.nodes.values()].find(n => n.cls === 'resource' && n.writes && !n.folded); Monitor3D.select(n.id, 'scene'); Monitor3D.view.isolate(n.col); })()`);
      await sleep(300); await shot(look + '-one-column');

      await open(page(4), 800, 600); await c.eval(choose); await sleep(300); await shot(look + '-800x600');
      r.fits800x600 = await c.eval('document.documentElement.scrollWidth <= 800 && document.documentElement.scrollHeight <= 600 && Monitor3D.view.width >= 400');

      // Twelve busy agents: at rest for three seconds, then running for five.
      await open(page(12), 1280, 720); await c.eval(choose); await sleep(1000);
      let a = await counters(c); await sleep(3000); let b = await counters(c);
      r.atRest = { seconds: 3, framesDrawn: b[0] - a[0], animationFramesAskedFor: b[1] - a[1], strokes: b[2] - a[2] };
      await c.eval(`(() => { const v = Monitor3D.view, draw = v.draw.bind(v); window.__ms = []; v.draw = r => { draw(r); __ms.push(v.stats.ms); }; Monitor3D.feed.start(); })()`);
      await sleep(500);
      a = await counters(c); let s0 = await scriptSeconds(c); const e0 = await c.eval('Monitor3D.model.counts.events'); await c.eval('__ms.length = 0');
      await sleep(5000);
      b = await counters(c); const s1 = await scriptSeconds(c), e1 = await c.eval('Monitor3D.model.counts.events'), ms = await c.eval('__ms.slice().sort((x, y) => x - y)');
      await c.eval('Monitor3D.feed.pause()'); await sleep(900);
      r.running12Busy = {
        seconds: 5, eventsPerSecond: +((e1 - e0) / 5).toFixed(1), framesPerSecond: +((b[0] - a[0]) / 5).toFixed(1),
        frameMsMedian: +(ms[Math.floor(ms.length / 2)] || 0).toFixed(2), frameMsWorst: +(ms[ms.length - 1] || 0).toFixed(2),
        scriptMsPerSecond: Math.round((s1 - s0) * 1000 / 5), nodes: await c.eval('Monitor3D.view.stats.nodes'), captions: await c.eval('Monitor3D.view.stats.labels'), overlappingCaptionPairs: await c.eval(overlaps)
      };
      await shot(look + '-12-agents');
      console.log(look, JSON.stringify(r));
    }

    // The page must also open straight from the file, with no server.
    await open(pathToFileURL(path.join(__dirname, 'index.html')).href + '?autostart=0', 1280, 720);
    results.opensFromFile = { ok: await c.eval('!!(window.Monitor3D && Monitor3D.view.redraw.frames > 0 && Monitor3D.model.nodes.size > 0)').catch(() => false), errors: await c.eval('window.__m ? __m.errors : ["no probe"]').catch(e => [e.message]) };
    console.log('opens from file', JSON.stringify(results.opensFromFile));
    // Press every button on the page once, with an agent selected, and look for errors.
    results.everyButton = await c.eval(`(async () => {
      const agent = [...Monitor3D.model.nodes.values()].find(n => n.cls === 'agent');
      const pressed = [];
      for (const b of document.querySelectorAll('button')) {
        if (!Monitor3D.state.selected) { const a = [...Monitor3D.model.nodes.values()].find(n => n.cls === 'agent'); if (a) Monitor3D.select(a.id, 'scene'); }
        if (b.disabled) continue;
        b.click(); pressed.push(b.textContent.trim());
        await new Promise(r => setTimeout(r, 120));
      }
      return { pressed: pressed.length, of: document.querySelectorAll('button').length, errors: __m.errors, nodesAfter: Monitor3D.model.nodes.size, agentSeen: !!agent };
    })()`);
    console.log('every button', JSON.stringify(results.everyButton));
    fs.writeFileSync(path.join(__dirname, 'measured.json'), JSON.stringify(results, null, 2) + '\n');
    try { await c.send('Browser.close'); } catch {}
  } finally {
    server.close();
    await sleep(1200);
    try { child.kill(); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
  }
})().catch(error => { console.error('FAILED: ' + error.message); process.exit(1); });
