// Page side of the draw-time benchmark. Loaded by page.html, driven by draw-bench.js over the DevTools protocol.
// Nothing here talks to the network beyond the loopback server that served it.
// window.NexusScene and window.NexusModel come from the NEXUS lattice concept (scene.js, model.js), served unmodified.
'use strict';

// Seeded generator so every run builds the same graphs.
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// n = 40 is the concept's own fixture (model.js seed()). Larger graphs copy its type mix, statuses, edge kinds and
// edge-per-node ratio, and place nodes inside the fixture's own bounding box, so the camera and panel stay the same.
function buildGraph(n) {
  const base = window.NexusModel.seed();
  if (n === base.nodes.length) return { nodes: base.nodes, edges: base.edges };
  const r = rng(1000 + n);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const types = base.nodes.map((x) => x.type), statuses = base.nodes.map((x) => x.status), kinds = base.edges.map((e) => e.kind);
  const lo = [0, 1, 2].map((i) => Math.min(...base.nodes.map((x) => x.position[i])));
  const hi = [0, 1, 2].map((i) => Math.max(...base.nodes.map((x) => x.position[i])));
  const nodes = [];
  for (let i = 0; i < n; i++) nodes.push({ id: 'n' + i, label: 'NODE ' + i, type: pick(types), status: pick(statuses), position: [0, 1, 2].map((k) => lo[k] + r() * (hi[k] - lo[k])), detail: '', metrics: {} });
  const ratio = base.edges.length / base.nodes.length, edges = [];
  for (let i = 0, m = Math.round(n * ratio); i < m; i++) {
    const a = 1 + Math.floor(r() * (n - 1)), b = Math.floor(r() * a);
    edges.push({ id: 'e' + i, from: nodes[a].id, to: nodes[b].id, kind: pick(kinds), active: r() < 0.4 });
  }
  return { nodes, edges };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const stats = (a) => ({ median: +median(a).toFixed(3), p90: +pct(a, 0.9).toFixed(3), min: +Math.min(...a).toFixed(3), max: +Math.max(...a).toFixed(3), n: a.length });

function freshCanvas() {
  document.querySelectorAll('canvas').forEach((c) => c.remove());
  const c = document.createElement('canvas');
  c.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:720px';
  document.body.appendChild(c);
  return c;
}

// Canvas 2D: the concept's Scene.draw(), motion off (the draw-on-change case: no packets, no pulses).
// Each draw turns the camera a little, as a camera input would, so every draw is a full redraw.
// "js" is the time inside draw(). "flushed" adds getImageData of one pixel, which makes the browser finish rasterising
// the frame before it returns, so it counts the raster work that draw() only queues.
// noGlow: the same draw with every shadowBlur (the glow) ignored, to see what the glow costs.
function benchCanvas(n, draws, warm, noGlow) {
  const canvas = freshCanvas();
  const scene = new window.NexusScene.Scene(canvas, null, null);
  scene.motion = false;
  const g = buildGraph(n), ctx = canvas.getContext('2d');
  if (noGlow) Object.defineProperty(ctx, 'shadowBlur', { get: () => 0, set: () => {} });
  const js = [], flushed = [];
  for (let i = 0; i < warm; i++) { scene.camera.yaw += 0.01; scene.draw(g, 0, 0); ctx.getImageData(0, 0, 1, 1); }
  for (let i = 0; i < draws; i++) { scene.camera.yaw += 0.01; const t0 = performance.now(); scene.draw(g, 0, 0); js.push(performance.now() - t0); }
  for (let i = 0; i < draws; i++) { scene.camera.yaw += 0.01; const t0 = performance.now(); scene.draw(g, 0, 0); ctx.getImageData(0, 0, 1, 1); flushed.push(performance.now() - t0); }
  return { nodes: g.nodes.length, edges: g.edges.length, glow: !noGlow, canvasPx: [canvas.width, canvas.height], js: stats(js), flushed: stats(flushed) };
}

// DOM labels: one absolutely placed <div> per node over the scene, moved by a CSS transform on each camera change,
// using scene.js project(). "js" is the placing loop; "layout" adds a forced style and layout pass (offsetHeight).
// Paint and compositing are not counted.
function benchDomLabels(n, draws, warm) {
  freshCanvas();
  document.querySelectorAll('.lbl').forEach((x) => x.remove());
  const S = window.NexusScene, g = buildGraph(n), cam = { yaw: -0.52, pitch: 0.53, distance: 1160, target: [50, 65, 35] };
  const layer = document.createElement('div'); layer.className = 'lbl'; layer.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:720px;pointer-events:none;font:11px system-ui;color:#cfe';
  document.body.appendChild(layer);
  const els = g.nodes.map((x) => { const d = document.createElement('div'); d.textContent = x.label; d.style.cssText = 'position:absolute;left:0;top:0;white-space:nowrap;will-change:transform'; layer.appendChild(d); return d; });
  const place = () => { cam.yaw += 0.01; g.nodes.forEach((x, i) => { const p = S.project(x.position, cam, 1280, 720); els[i].style.transform = p ? `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)` : 'translate(-9999px,0)'; }); };
  for (let i = 0; i < warm; i++) { place(); void document.body.offsetHeight; }
  const js = [], layout = [];
  for (let i = 0; i < draws; i++) { const t0 = performance.now(); place(); js.push(performance.now() - t0); void document.body.offsetHeight; }
  for (let i = 0; i < draws; i++) { const t0 = performance.now(); place(); void document.body.offsetHeight; layout.push(performance.now() - t0); }
  layer.remove();
  return { nodes: n, js: stats(js), layout: stats(layout) };
}

// three.js on WebGL2: the same wireframe shapes (scene.js geometry()), the same ground grid, edges as the same
// 16-segment curves merged into one buffer, and one text sprite per node (a CanvasTexture drawn once at build).
// "js" is the time inside renderer.render(). "flushed" adds a one-pixel readPixels, which waits for the GPU.
async function benchThree(n, draws, warm) {
  const THREE = await import(window.THREE_URL || '/three/three.module.js');
  const S = window.NexusScene;
  const canvas = freshCanvas();
  const t0 = performance.now();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(1280, 720, false);
  const gl = renderer.getContext();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#020910');
  const camera = new THREE.PerspectiveCamera(45, 1280 / 720, 10, 6000);
  const g = buildGraph(n);
  const grid = [];
  for (let i = -850; i <= 850; i += 50) grid.push(i, -18, -750, i, -18, 750, -850, -18, i, 850, -18, i);
  const gridGeo = new THREE.BufferGeometry(); gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(grid, 3));
  scene.add(new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: '#174251', transparent: true, opacity: 0.3 })));
  const mats = new Map();
  const mat = (c) => { if (!mats.has(c)) mats.set(c, new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.82 })); return mats.get(c); };
  for (const node of g.nodes) {
    const m = S.geometry(node.type, S.nodeRadius(node)), pts = [];
    for (const [a, b] of m.lines) pts.push(...m.vertices[a], ...m.vertices[b]);
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const obj = new THREE.LineSegments(geo, mat(S.colors[node.type] || '#61e5f5')); obj.position.set(...node.position); scene.add(obj);
    const lc = document.createElement('canvas'); lc.width = 256; lc.height = 32; const lx = lc.getContext('2d');
    lx.font = '20px Consolas,monospace'; lx.fillStyle = S.colors[node.type] || '#61e5f5'; lx.textAlign = 'center'; lx.fillText(node.label, 128, 22);
    const tex = new THREE.CanvasTexture(lc);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sprite.position.set(node.position[0], node.position[1] - S.nodeRadius(node) - 14, node.position[2]); sprite.scale.set(96, 12, 1); scene.add(sprite);
  }
  const byId = new Map(g.nodes.map((x) => [x.id, x])), edgePts = [];
  for (const e of g.edges) { const a = byId.get(e.from).position, b = byId.get(e.to).position; let prev = a; for (let i = 1; i <= 16; i++) { const next = S.edgePoint(a, b, i / 16); edgePts.push(...prev, ...next); prev = next; } }
  const edgeGeo = new THREE.BufferGeometry(); edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePts, 3));
  scene.add(new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: '#61e5f5', transparent: true, opacity: 0.35 })));
  let yaw = -0.52;
  const place = () => { yaw += 0.01; const d = 1160, p = 0.53; camera.position.set(50 + d * Math.cos(p) * Math.sin(-yaw), 65 + d * Math.sin(p), 35 + d * Math.cos(p) * Math.cos(-yaw)); camera.lookAt(50, 65, 35); };
  const px = new Uint8Array(4);
  place(); renderer.render(scene, camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const build = performance.now() - t0;
  for (let i = 0; i < warm; i++) { place(); renderer.render(scene, camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
  const js = [], flushed = [];
  for (let i = 0; i < draws; i++) { place(); const s = performance.now(); renderer.render(scene, camera); js.push(performance.now() - s); }
  gl.finish();
  for (let i = 0; i < draws; i++) { place(); const s = performance.now(); renderer.render(scene, camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); flushed.push(performance.now() - s); }
  const info = { calls: renderer.info.render.calls, lines: renderer.info.render.lines, textures: renderer.info.memory.textures, geometries: renderer.info.memory.geometries };
  renderer.dispose(); renderer.forceContextLoss();
  return { nodes: g.nodes.length, edges: g.edges.length, revision: THREE.REVISION, buildMs: +build.toFixed(1), info, js: stats(js), flushed: stats(flushed) };
}

function gpuInfo() {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return { webgl2: false };
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const out = { webgl2: true, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR) };
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return out;
}

// For the idle test: a never-stopping requestAnimationFrame loop drawing the 40-node fixture with motion on, as the
// concept's app.js does (app.js frame()). startLoop() returns at once; stopLoop() returns the frame count.
let loop = null;
function startLoop() {
  const canvas = freshCanvas(), scene = new window.NexusScene.Scene(canvas, null, null), g = buildGraph(40);
  let frames = 0, last = 0, time = 0;
  const frame = (now) => { const dt = last ? Math.min(0.1, (now - last) / 1000) : 0; last = now; time += dt; scene.draw(g, time, dt); frames++; loop.raf = requestAnimationFrame(frame); };
  loop = { raf: requestAnimationFrame(frame), frames: () => frames };
  return true;
}
function stopLoop() { cancelAnimationFrame(loop.raf); const f = loop.frames(); loop = null; return f; }
// Draw once and stop: the draw-on-change case at rest.
function drawOnce() { const canvas = freshCanvas(), scene = new window.NexusScene.Scene(canvas, null, null); scene.motion = false; scene.draw(buildGraph(40), 0, 0); return true; }

window.bench = { buildGraph, benchCanvas, benchThree, benchDomLabels, gpuInfo, startLoop, stopLoop, drawOnce };
window.benchReady = true;
