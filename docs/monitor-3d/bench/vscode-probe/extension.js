// Bench-only extension, run by probe-driver.js in an isolated Extension Development Host. Never packaged.
// Phases, each announced by writing <out>/phase-<name> so the driver can sample processes in between:
//   baseline: VS Code is up, no webview. (driver samples)
//   open:     a webview panel opens with the benchmark page; WebGL2 info and draw times are posted back.
//   rest:     the panel is visible and drawn once; nothing draws. (driver samples)
//   loop:     the page runs the concept's never-stopping animation loop. (driver samples)
//   move:     the panel is moved into a new window (workbench.action.moveEditorToNewWindow); page loads are counted.
// Then results.json is written and VS Code quits.
'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');

const LIGHT = process.env.MONITOR3D_LIGHT === '1'; // light: no draw benchmarks, so the rest sample is the cost of a drawn-once panel
const OUT = process.env.MONITOR3D_OUT, SCENE = process.env.MONITOR3D_SCENE, THREE = process.env.MONITOR3D_THREE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mark = (name) => fs.writeFileSync(path.join(OUT, 'phase-' + name), String(Date.now()));
const waitGo = async (name) => { const f = path.join(OUT, 'go-' + name); for (let i = 0; i < 600 && !fs.existsSync(f); i++) await sleep(100); };

async function activate(context) {
  if (!OUT || !SCENE) return;
  const result = { vscode: vscode.version, loads: [], messages: [] };
  try {
    await sleep(LIGHT ? 30000 : 5000); mark('baseline'); await waitGo('baseline');
    const sceneDir = vscode.Uri.file(path.dirname(SCENE)), benchDir = vscode.Uri.file(path.dirname(__dirname));
    const roots = [sceneDir, benchDir, ...(THREE ? [vscode.Uri.file(THREE)] : [])];
    const panel = vscode.window.createWebviewPanel('monitor3dProbe', 'monitor-3d probe', vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: roots, retainContextWhenHidden: true });
    const w = panel.webview, u = (f) => w.asWebviewUri(vscode.Uri.file(f)).toString();
    const nonce = Math.random().toString(36).slice(2);
    const threeUrl = THREE ? u(path.join(THREE, 'three.module.js')) : '';
    w.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} blob: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${w.cspSource};">
<style>html,body{margin:0;background:#020910;overflow:hidden}</style></head><body>
<script nonce="${nonce}">window.THREE_URL=${JSON.stringify(threeUrl)};</script>
<script nonce="${nonce}" src="${u(path.join(path.dirname(SCENE), 'model.js'))}"></script>
<script nonce="${nonce}" src="${u(SCENE)}"></script>
<script nonce="${nonce}" src="${u(path.join(path.dirname(__dirname), 'bench-page.js'))}"></script>
<script nonce="${nonce}">
const api = acquireVsCodeApi();
const prior = api.getState();
api.postMessage({ type: 'loaded', at: Date.now(), hadState: !!prior, size: [innerWidth, innerHeight], dpr: devicePixelRatio });
api.setState({ loadedOnce: true });
window.addEventListener('message', async (e) => {
  const m = e.data; let value, error;
  try { value = m.fn === 'probe' ? { alive: true, hasBench: !!window.bench } : await window.bench[m.fn](...m.args); } catch (x) { error = String(x && x.stack || x); }
  api.postMessage({ type: 'reply', id: m.id, value, error });
});
</script></body></html>`;
    let next = 1; const wait = new Map();
    w.onDidReceiveMessage((m) => {
      if (m.type === 'loaded') result.loads.push(m);
      else if (m.type === 'reply' && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
    });
    const ask = (fn, ...args) => new Promise((ok) => { const id = next++; wait.set(id, ok); w.postMessage({ id, fn, args }); });
    for (let i = 0; i < 100 && !result.loads.length; i++) await sleep(100);
    result.gpu = await ask('gpuInfo');
    result.canvas = [];
    if (!LIGHT) for (const n of [40, 200, 1000]) result.canvas.push(await ask('benchCanvas', n, 50, 10));
    result.three = [];
    if (THREE && !LIGHT) for (const n of [40, 200, 1000]) result.three.push(await ask('benchThree', n, 50, 10));
    await ask('drawOnce'); await sleep(LIGHT ? 10000 : 3000);
    mark('rest'); await waitGo('rest');
    await ask('startLoop'); await sleep(2000);
    mark('loop'); await waitGo('loop');
    result.loopFrames = await ask('stopLoop');
    const before = result.loads.length;
    panel.reveal(vscode.ViewColumn.One, false);
    try { await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow'); result.moveCommand = 'ran'; } catch (x) { result.moveCommand = 'failed: ' + x.message; }
    await sleep(6000);
    result.loadsAfterMove = result.loads.length - before;
    result.afterMove = await Promise.race([ask('probe'), sleep(5000).then(() => 'no answer in 5 s')]);
    mark('move'); await waitGo('move');
  } catch (e) { result.error = String(e && e.stack || e); }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(result, null, 2));
  mark('done');
  await sleep(500);
  vscode.commands.executeCommand('workbench.action.quit');
}
module.exports = { activate, deactivate() {} };
