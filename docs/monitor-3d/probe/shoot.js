// Screenshots and cost probes for the seven NEXUS mock-ups. Headless Edge over the DevTools protocol (Node 22+).
// Start both mock-up servers first (node serve.js in each folder: 4320 lattice, 4321 worlds), then:
//   node shoot.js <screenshot folder> [results.json]
// Writes one PNG per page, three 80-node stress PNGs, and the raw numbers to results.json (default: probe-raw.json in
// docs/monitor-3d/). The committed probe-results.json is a tidied copy of one run.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), { spawn } = require('child_process'), net = require('net');
const out = path.resolve(process.argv[2]);
const resultsFile = path.resolve(process.argv[3] || path.join(__dirname, '..', 'probe-raw.json'));
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)
  .map(root => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(p => fs.existsSync(p));
if (!edge) { console.error('NO_BROWSER'); process.exit(2); }
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const PAGES = [
  ['lattice', 'http://127.0.0.1:4320/'],
  ['city', 'http://127.0.0.1:4321/city.html'],
  ['orbit', 'http://127.0.0.1:4321/orbit.html'],
  ['glass', 'http://127.0.0.1:4321/glass.html'],
  ['synapse', 'http://127.0.0.1:4321/synapse.html'],
  ['horizon', 'http://127.0.0.1:4321/horizon.html'],
  ['terrain', 'http://127.0.0.1:4321/terrain.html'],
];

// Counts frames, strokes and the labels of one frame. Optional stress: 40 extra nodes appended to the model.
const probe = stress => `(() => {
  const m = window.__m = { frames: 0, strokes: 0, fills: 0, texts: [], grab: false };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => raf(t => { m.frames++; const g = m.grab; if (g) { m.texts = []; m.rec = true; } try { cb(t); } finally { if (g) { m.rec = false; m.grab = false; } } });
  const P = CanvasRenderingContext2D.prototype, st = P.stroke, fl = P.fill, ft = P.fillText;
  P.stroke = function () { m.strokes++; return st.apply(this, arguments); };
  P.fill = function () { m.fills++; return fl.apply(this, arguments); };
  P.fillText = function (t, x, y) {
    if (m.rec && this.globalAlpha > 0.2) { const w = this.measureText(t).width, size = parseFloat(this.font.match(/(\\d+(?:\\.\\d+)?)px/)?.[1] || 8), al = this.textAlign;
      m.texts.push({ t: String(t), x: al === 'center' ? x - w / 2 : (al === 'right' || al === 'end') ? x - w : x, y: y - size, w, h: size * 1.15 }); }
    return ft.apply(this, arguments);
  };
  ${stress ? `let nm; Object.defineProperty(window, 'NexusModel', { configurable: true, get: () => nm, set: v => { const seed = v.seed; v.seed = () => { const g = seed();
    const agents = ['claude', 'codex', 'grok', 'antigravity'];
    for (let i = 0; i < 40; i++) { const tool = i < 16, a = agents[i % 4], ang = i * 2.39996, r = 380 + (i % 5) * 40;
      const id = (tool ? 'x-tool-' : 'x-file-') + i;
      g.nodes.push({ id, label: tool ? ['MCP / GITHUB.SEARCH', 'MCP / PLAYWRIGHT.CLICK', 'READ', 'EDIT', 'BASH', 'GREP', 'WEBFETCH', 'MCP / ASANA.GET'][i % 8] + ' ' + i : 'SRC/' + ['BOARD', 'LATTICE', 'HOOK', 'TERMINAL', 'WEBVIEW'][i % 5] + '-' + i + '.TS',
        type: tool ? 'tool' : 'context', status: i % 3 ? 'idle' : 'active', position: [Math.cos(ang) * r, 10 + (i % 4) * 20, Math.sin(ang) * r], detail: 'stress probe', metrics: {} });
      g.edges.push({ id: a + '>' + id, from: a, to: id, kind: tool ? 'tool' : 'data', active: i % 3 === 0 }); }
    return g; }; nm = v; } });` : ''}
})();`;

const overlaps = texts => {
  let pairs = 0; const hit = new Set();
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    const a = texts[i], b = texts[j];
    const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ix > 2 && iy > 2) { pairs++; hit.add(i); hit.add(j); }
  }
  return { labels: texts.length, overlappingPairs: pairs, labelsInvolved: hit.size };
};

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 1; this.p = new Map(); ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const { res, rej } = this.p.get(m.id); this.p.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } }; }
  static open(url) { return new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(new Cdp(ws)); ws.onerror = () => rej(new Error('ws')); }); }
  send(method, params = {}) { return new Promise((res, rej) => { const id = this.id++; this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error(method + ' timeout')); } }, 30000); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '')); return r.result.value; }
}
const metric = async c => Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));

(async () => {
  const port = await freePort(), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'a223d7-edge-'));
  const child = spawn(edge, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1600,1000', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let targets;
  for (let i = 0; i < 60 && !targets; i++) { try { targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === 'page'); if (!targets.length) targets = undefined; } catch { await sleep(250); } }
  const c = await Cdp.open(targets[0].webSocketDebuggerUrl);
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Performance.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  const results = {};
  for (const stress of [false, true]) {
    const injected = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: probe(stress) });
    for (const [name, url] of PAGES) {
      if (stress && !['lattice', 'city', 'glass'].includes(name)) continue;
      const key = stress ? name + '-80-nodes' : name;
      await c.send('Page.navigate', { url }); await sleep(3000);
      const r = { url };
      r.nodeCount = await c.eval(`document.querySelectorAll('#manifest button[data-node]').length`);
      // Playing, motion on: the default state.
      let m0 = await metric(c), f0 = await c.eval('[__m.frames,__m.strokes,__m.fills]'); await sleep(3000);
      let m1 = await metric(c), f1 = await c.eval('[__m.frames,__m.strokes,__m.fills]');
      r.playing = { framesPerSec: (f1[0] - f0[0]) / 3, strokesPerSec: Math.round((f1[1] - f0[1]) / 3), fillsPerSec: Math.round((f1[2] - f0[2]) / 3), scriptMsPerSec: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000 / 3), taskMsPerSec: Math.round((m1.TaskDuration - m0.TaskDuration) * 1000 / 3) };
      await c.eval('__m.grab = true'); await sleep(200);
      r.labelsOneFrame = overlaps(await c.eval('__m.texts'));
      const shot = await c.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, key + '.png'), Buffer.from(shot.data, 'base64'));
      // Paused, motion off: nothing in the data changes.
      await c.eval(`(() => { const play = document.getElementById('play'); if (play && /Ⅱ/.test(play.textContent)) play.click(); const mo = document.getElementById('motion'); if (mo && mo.getAttribute('aria-pressed') === 'true') mo.click(); return [play?.textContent, mo?.getAttribute('aria-pressed')]; })()`).then(v => r.stillControls = v);
      await sleep(500);
      m0 = await metric(c); f0 = await c.eval('[__m.frames,__m.strokes,__m.fills]'); await sleep(3000);
      m1 = await metric(c); f1 = await c.eval('[__m.frames,__m.strokes,__m.fills]');
      r.pausedMotionOff = { framesPerSec: (f1[0] - f0[0]) / 3, strokesPerSec: Math.round((f1[1] - f0[1]) / 3), fillsPerSec: Math.round((f1[2] - f0[2]) / 3), scriptMsPerSec: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000 / 3), taskMsPerSec: Math.round((m1.TaskDuration - m0.TaskDuration) * 1000 / 3) };
      results[key] = r; console.log(key, JSON.stringify(r));
    }
    await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier });
  }
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  try { await c.send('Browser.close'); } catch {}
  await sleep(1500);
  try { child.kill(); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
