// The looks (LOOKS.md): the list of 18, the switcher, and what every built look must keep to.
//
// A look that is still a stub is reported as a test marked "to do", so the suite passes while stubs
// remain and its summary line counts them. A look counts as built when its file no longer says
// `stub`: from then on it is held to everything below, with nothing to switch on.
//
// The first half runs in Node alone. The second half needs Edge or Chrome, as page.test.js does, and
// is skipped with a reason when there is none. Pictures go to .scratch/looks/ beside this extension,
// a folder git ignores; nothing else is written. The server's port, the browser's port and its
// profile are the harness's own (a free port, a temporary folder), so worktrees can run this at once.
'use strict';
const test = require('node:test');
const { describe, it, before, after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MEDIA = path.join(ROOT, 'media');
const REPO = path.join(ROOT, '..', '..');
const R = require('../media/looks.js');
const E = require('../media/engine.js');
const M = require('../media/model.js');
const L = require('../media/layout.js');
const FIXED = require('./fixtures/looks/scene.js');
const KNOBS = require('./fixtures/looks/look-every-knob.js');
const KNOBS_SOURCE = fs.readFileSync(path.join(__dirname, 'fixtures', 'looks', 'look-every-knob.js'), 'utf8');
const { findBrowser, Harness, sleep } = require('./page-harness.js');
const S = require('./fixtures/stream/streams.js');
const SHOOT = require('../tools/shoot-looks.js');

/* The allowance for stubs. The acceptance run deletes it (sets it to false): from then on a look that is not built fails the suite. */
const STUBS_ALLOWED = true;

const IDS = ['nexus', 'glasshouse', 'nexus-mockup', 'glasshouse-mockup', 'lattice', 'circuit-city', 'orbital', 'glasshouse-original', 'synapse',
  'event-horizon', 'signal-terrain', 'editor-theme', 'battle-neon', 'paper', 'paper-dark', 'skyline', 'control-room', 'signal-house'];
const LOOKS = {};
for (const id of IDS) LOOKS[id] = require('../media/look-' + id + '.js');
const BUILT = IDS.filter(id => !LOOKS[id].stub), STUBS = IDS.filter(id => LOOKS[id].stub);
const SHOTS = path.join(ROOT, '.scratch', 'looks');
const MESH_KEYS = ['agent', 'subagent', 'tool', 'mcp', 'resource.file', 'resource.url', 'resource.context', 'stack'];

/* ---------- helpers ---------- */

/** A canvas that draws nothing and writes down every stroke, fill and text with the style in force. */
function fakeCanvas() {
  const drawn = { strokes: [], fills: [], texts: [], rects: [] };
  const state = { globalAlpha: 1, fillStyle: '', strokeStyle: '', font: '', lineWidth: 1, dash: [] };
  let moves = 0, lines = 0, arcs = 0;
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'measureText') return text => ({ width: String(text).length * 6 });
      if (key === 'beginPath') return () => { moves = 0; lines = 0; arcs = 0; };
      if (key === 'moveTo') return () => { moves++; };
      if (key === 'lineTo') return () => { lines++; };
      if (key === 'arc') return () => { arcs++; };
      if (key === 'setLineDash') return dash => { target.dash = dash; };
      if (key === 'stroke') return () => { drawn.strokes.push({ color: target.strokeStyle, alpha: target.globalAlpha, width: target.lineWidth, dash: target.dash.slice(), moves, lines }); };
      if (key === 'fill') return () => { drawn.fills.push({ color: target.fillStyle, alpha: target.globalAlpha, moves, lines, arcs }); };
      if (key === 'fillText') return (text, x, y) => { drawn.texts.push({ text, x, y, color: target.fillStyle, font: target.font, alpha: target.globalAlpha }); };
      if (key === 'fillRect') return (x, y, w, h) => { drawn.rects.push({ x, y, w, h, color: target.fillStyle }); };
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; }
  });
  return { canvas: { getContext: () => ctx, width: 0, height: 0 }, drawn };
}
/** A view over the fixed scene in one look, drawn once at 1280 x 720. */
function sceneIn(look, model = FIXED.model()) {
  model.takeClosed();          // no trace of an ended call: with one, the view asks for a second frame when the trace runs out
  const { canvas, drawn } = fakeCanvas(), queue = [];
  let clock = 0;
  const view = new E.View(canvas, { model, look, env: { raf: fn => queue.push(fn), setTimeout: fn => { queue.push(fn); return 1; }, now: () => (clock += 200) } });
  const frame = () => { for (const list of Object.values(drawn)) list.length = 0; view.redraw.request('input'); while (queue.length) queue.shift()(); };
  view.setSize(1280, 720, 1);
  view.frame();
  frame();
  return { view, drawn, frame, model };
}
const isColor = value => typeof value === 'string' && value.trim().length > 2;
const between = (value, low, high) => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
const meshSignature = mesh => JSON.stringify([mesh.vertices.map(v => v.map(n => Math.round(n * 100) / 100)), mesh.lines]);

/* ---------- the list ---------- */

test('the 18 looks: the registry, docs/looks/looks.json, the page\'s script tags and the look files name the same ids in the same order', () => {
  assert.deepEqual(R.ids(), IDS, 'media/looks.js');
  const json = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'looks', 'looks.json'), 'utf8'));
  assert.deepEqual(json.map(e => e.id), IDS, 'docs/looks/looks.json');
  for (const [i, e] of json.entries()) {
    assert.deepEqual(Object.keys(e), ['id', 'name', 'group', 'source'], e.id);
    assert.equal(e.name, R.LIST[i].name, e.id + ': the same name in both lists');
    assert.equal(e.group, R.LIST[i].group, e.id + ': the same group in both lists');
    assert.ok(typeof e.source === 'string' && e.source.length > 8, e.id + ' names its source');
  }
  assert.equal(new Set(R.LIST.map(e => e.name)).size, 18, 'no two looks share a name');
  // The groups are runs: the switcher shows each once, in the list's order.
  assert.deepEqual([...new Set(R.LIST.map(e => e.group))], R.GROUPS);
  assert.deepEqual(R.GROUPS.flatMap(g => R.LIST.filter(e => e.group === g).map(e => e.id)), IDS, 'grouping does not reorder the list');
  // One script tag for each look, in the list's order, after looks.js and the engine and before the page's own script.
  const html = fs.readFileSync(path.join(MEDIA, 'page.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const files = (html.match(/<script\b[^>]*>/g) || []).map(tag => (/src="\{\{base\}\}\/([a-z-]+\.js)"/.exec(tag) || [])[1]);
  assert.deepEqual(files.filter(f => /^look-/.test(f)), IDS.map(id => 'look-' + id + '.js'));
  assert.ok(files.indexOf('engine.js') < files.indexOf('looks.js') && files.indexOf('looks.js') < files.indexOf('look-nexus.js'), 'engine.js, then looks.js, then the looks');
  assert.ok(files.indexOf('look-signal-house.js') < files.indexOf('page.js'), 'every look loads before the page');
  // A look file for each id and no other, and each gives a look of that id.
  const onDisk = fs.readdirSync(MEDIA).filter(f => /^look-.*\.js$/.test(f)).sort();
  assert.deepEqual(onDisk, IDS.map(id => 'look-' + id + '.js').sort());
  for (const id of IDS) assert.equal(LOOKS[id].id, id, 'media/look-' + id + '.js');
  assert.equal(R.entry('toString'), null);
  assert.throws(() => R.stub('no-such-look'), /not in the list/);
});

test('the host\'s HTML (lib/view.js) has a script tag with the page\'s nonce for every look', () => {
  const { MonitorView, policy } = require('../lib/view.js');
  const vscode = { Uri: { joinPath: (base, ...parts) => ({ toString: () => [base, ...parts].join('/') }) } };
  const view = new MonitorView(vscode, { extensionUri: 'https://example.invalid/ext', extensionPath: ROOT }, {});
  const html = view.html({ asWebviewUri: uri => ({ toString: () => uri.toString() + '/' }) });
  const nonce = (/script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(html) || [])[1];
  assert.ok(nonce && html.includes(policy(nonce)), 'the policy names one nonce');
  const tags = html.match(/<script\b[^>]*>/g) || [];
  for (const id of IDS) {
    const tag = tags.find(t => t.includes('src="https://example.invalid/ext/media/look-' + id + '.js"'));
    assert.ok(tag, 'a script tag for ' + id);
    assert.ok(tag.includes('nonce="' + nonce + '"'), id + ': its tag carries the nonce');
  }
  assert.ok(tags.every(t => t.includes('nonce="' + nonce + '"')), 'no script without the nonce');
  assert.ok(!html.includes('{{'), 'no placeholder is left');
});

test('built and not built: ' + BUILT.length + ' looks are built, ' + STUBS.length + ' are stubs', () => {
  for (const id of ['nexus', 'glasshouse', 'nexus-mockup', 'glasshouse-mockup']) assert.ok(BUILT.includes(id), id + ' is built');
  if (!STUBS_ALLOWED) assert.deepEqual(STUBS, [], 'stubs are no longer allowed: every look must be built');
});

/* A stub is a look that is not built. It is reported as "to do"; the check itself only says the stub is a sound one. */
for (const id of STUBS) {
  test('look ' + id + ': to do, it is a stub', { todo: STUBS_ALLOWED ? 'not built yet: drawn like NEXUS' : false }, () => {
    const look = LOOKS[id];
    assert.equal(look.stub, true);
    assert.equal(look.name, R.entry(id).name);
    assert.equal(look.palette, LOOKS.nexus.palette, 'a stub is drawn like NEXUS');
    assert.equal(look.mesh, LOOKS.nexus.mesh);
    if (!STUBS_ALLOWED) assert.fail(id + ' is a stub: it must be built');
  });
}

/* ---------- the fixed scene ---------- */

test('the fixed scene holds every class and every state, a folded stack, open calls, a failed call and a clash', () => {
  const m = FIXED.model(), nodes = [...m.nodes.values()];
  assert.equal(m.counts.rejected, 0);
  assert.deepEqual([...m.sessions.values()].map(s => s.kind).sort(), M.AGENT_KINDS.slice().sort(), 'four sessions, one for each provider');
  for (const cls of ['agent', 'subagent', 'tool', 'mcp', 'resource', 'stack']) assert.ok(nodes.some(n => n.cls === cls), 'a ' + cls);
  for (const kind of M.RESOURCE_KINDS) assert.ok(nodes.some(n => n.cls === 'resource' && n.kind === kind), 'a resource of kind ' + kind);
  for (const status of Object.keys(M.STATES)) assert.ok(nodes.some(n => n.status === status && !n.folded), 'a standing node that is "' + status + '"');
  assert.equal(m.nodes.get(FIXED.SELECTED).status, 'needs', 'the selected agent needs its owner');
  assert.ok(nodes.some(n => n.folded), 'something is folded into the stack');
  const links = [...m.links.values()];
  assert.ok(links.some(l => l.kind === 'tool') && links.some(l => l.kind === 'mcp' && l.port) && links.some(l => l.kind === 'touch' && l.op === 'write') && links.some(l => l.kind === 'touch' && l.op === 'search'), 'open calls of each kind');
  assert.ok(nodes.some(n => n.cls === 'tool' && n.status === 'failed' && n.failed === 1), 'a failed call');
  assert.ok(nodes.some(n => n.cls === 'mcp' && n.ports.size >= 3 && [...n.ports.values()].some(p => p.open)), 'an MCP server with ports, one in use');
  assert.equal(m.arcs.size, 1, 'one clash');
  assert.equal(FIXED.message().records[0].state, FIXED.message().records[0].state, 'the snapshot is the same text every time');
  assert.deepEqual(M.load(FIXED.message().records[0].state).nodes.size, m.nodes.size);
});

/* ---------- every built look, in Node ---------- */

/** Everything a look must be to be drawn by the engine and the page. Returns the list of what is wrong. */
function problems(look) {
  const out = [], bad = text => out.push(text), pal = look.palette || {};
  if (typeof look.name !== 'string' || !look.name) bad('name');
  if (look.theme !== 'dark' && look.theme !== 'light') bad('theme must be "dark" or "light"');
  if (typeof look.font !== 'string' || !look.font) bad('font');
  if (!between(look.lineWidth, .5, 4)) bad('lineWidth must be from 0.5 to 4');
  if (typeof look.glow !== 'boolean') bad('glow must be true or false');
  if (typeof look.caption !== 'function' || typeof look.caption('Read') !== 'string' || !look.caption('Read')) bad('caption(text) must return a text');
  if (look.captionSize !== undefined && !between(look.captionSize, 10, 20)) bad('captionSize must be from 10 to 20');
  if (!look.claims || typeof look.claims !== 'object') bad('claims must be an object (it may be empty)');
  for (const key of ['bg', 'panel', 'line', 'ink', 'caption', 'muted', 'accent', 'clash']) if (!isColor(pal[key])) bad('palette.' + key);
  for (const cls of M.CLASSES) if (!pal.cls || !isColor(pal.cls[cls])) bad('palette.cls.' + cls);
  for (const state of Object.keys(M.STATES)) if (state !== 'rest' && (!pal.state || !isColor(pal.state[state]))) bad('palette.state.' + state);
  for (const key of ['fill', 'solid', 'floorFill', 'floorLine', 'post', 'captionBack', 'captionHalo']) if (!between(pal[key], 0, 1)) bad('palette.' + key + ' must be from 0 to 1');
  if (pal.outline !== undefined && !isColor(pal.outline)) bad('palette.outline');
  if (pal.floor !== undefined) for (const floor of Object.keys(pal.floor)) if (!L.FLOORS.includes(floor) || !isColor(pal.floor[floor])) bad('palette.floor.' + floor);
  if (pal.provider !== undefined) for (const kind of M.AGENT_KINDS) if (!isColor(pal.provider[kind])) bad('palette.provider.' + kind);
  if (look.page !== undefined) {
    if (!look.page || typeof look.page !== 'object') bad('page must be an object');
    else for (const [key, value] of Object.entries(look.page)) {
      if (!Object.prototype.hasOwnProperty.call(R.PAGE, key)) bad('page.' + key + ' is not one of: ' + Object.keys(R.PAGE).join(', '));
      else if (typeof value !== 'string' || !value.trim() || /[;{}]|url\(|@import/i.test(value)) bad('page.' + key + ' must be a plain CSS value');
    }
    const size = look.page && /^(\d+(?:\.\d+)?)px$/.exec(look.page.titleSize || '14px');
    if (!size || +size[1] < 10 || +size[1] > 20) bad('page.titleSize must be from 10px to 20px: the bar keeps its height');
  }
  for (const key of ['fromPage', 'backdrop']) if (look[key] !== undefined && typeof look[key] !== 'function') bad(key + ' must be a function');
  if (look.samples !== undefined) {
    if (typeof look.fromPage !== 'function') bad('samples are for a look that has fromPage');
    try { SHOOT.samplesOf(look); } catch (error) { bad(error.message); }
  }
  for (const key of MESH_KEYS) {
    let mesh;
    try { mesh = look.mesh(key); } catch (error) { bad('mesh("' + key + '") throws: ' + error.message); continue; }
    const vs = mesh && mesh.vertices, ls = mesh && mesh.lines;
    if (!Array.isArray(vs) || !vs.length || !vs.every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))) { bad('mesh("' + key + '").vertices'); continue; }
    if (!Array.isArray(ls) || !ls.length || !ls.every(l => Array.isArray(l) && l.length === 2 && l.every(i => Number.isInteger(i) && i >= 0 && i < vs.length))) { bad('mesh("' + key + '").lines'); continue; }
    if (mesh.faces !== undefined && !(Array.isArray(mesh.faces) && mesh.faces.every(f => Array.isArray(f) && f.length >= 3 && f.every(i => Number.isInteger(i) && i >= 0 && i < vs.length)))) bad('mesh("' + key + '").faces');
    // The engine's frame budget is for meshes of this size, and a mesh must stay in its own slot: it cannot move a node.
    if (vs.length > 120 || ls.length > 120) bad('mesh("' + key + '") has ' + vs.length + ' corners and ' + ls.length + ' lines: at most 120 of each');
    const xs = vs.map(v => v[0]), ys = vs.map(v => v[1]), zs = vs.map(v => v[2]), reach = key.startsWith('resource.') ? 17 : 31;
    if (Math.min(...ys) < -1e-6) bad('mesh("' + key + '") goes under its floor (y < 0)');
    if (Math.max(...ys) > 80) bad('mesh("' + key + '") is taller than 80');
    if (Math.max(...xs.map(Math.abs), ...zs.map(Math.abs)) > reach) bad('mesh("' + key + '") reaches past ' + reach + ' from its slot\'s centre');
    if (Math.abs(Math.min(...xs) + Math.max(...xs)) > 12 || Math.abs(Math.min(...zs) + Math.max(...zs)) > 12) bad('mesh("' + key + '") is not centred on its slot');
  }
  return out;
}

for (const id of BUILT) {
  test('look ' + id + ': it is a complete look, and it keeps what it claims', () => {
    const look = LOOKS[id], pal = look.palette, claims = look.claims || {};
    assert.equal(look.stub, undefined);
    assert.deepEqual(problems(look), []);
    assert.equal(!!claims.providers, !!pal.provider, 'a look gives the providers colours exactly when it claims to (claims.providers)');
    if (claims.classes) {
      // Five silhouettes and five colours, one for each class.
      const colours = M.CLASSES.map(cls => pal.cls[cls].toLowerCase());
      assert.equal(new Set(colours).size, 5, id + ' claims a colour for each class: ' + colours.join(' '));
      const shapes = ['agent', 'subagent', 'tool', 'mcp', 'resource.file'].map(key => meshSignature(look.mesh(key)));
      assert.equal(new Set(shapes).size, 5, id + ' claims a silhouette for each class');
    }
    if (claims.providers) {
      // One hue for each provider, and none of them another class's, a state's, the clash colour or the background.
      const own = M.AGENT_KINDS.map(kind => pal.provider[kind].toLowerCase());
      assert.equal(new Set(own).size, 4, id + ' claims a colour for each provider');
      const taken = [pal.cls.tool, pal.cls.resource, pal.cls.mcp, ...Object.values(pal.state), pal.clash, pal.bg].map(c => c.toLowerCase());
      for (const c of own) assert.ok(!taken.includes(c), id + ': the provider colour ' + c + ' is used for something else');
    }
  });

  test('look ' + id + ': a state is a mark and a word, never a colour or a shape; and nothing stands elsewhere than in NEXUS', () => {
    const look = LOOKS[id], { view, drawn, model, frame } = sceneIn(look), base = sceneIn(LOOKS.nexus);
    assert.ok(view.stats.nodes > 20 && view.labels.length > 4, 'the scene is drawn: ' + view.stats.nodes + ' nodes, ' + view.labels.length + ' captions');
    // Same class (and for an agent the same provider), any state: the same mesh and the same colour.
    const seen = new Map();
    for (const n of model.nodes.values()) {
      if (n.folded) continue;
      const v = view.visual(n), key = v.mesh + (n.cls === 'agent' || n.cls === 'subagent' ? ' ' + view.providerOf(n) : '');
      if (!seen.has(key)) seen.set(key, { mesh: v.mesh, color: v.color, states: new Set() });
      const first = seen.get(key);
      assert.equal(v.color, first.color, id + ': ' + n.id + ' (' + n.status + ') has another colour than its class');
      first.states.add(n.status);
      assert.equal(v.badge, M.STATES[n.status].shape, 'the mark is the state\'s');
    }
    assert.ok([...seen.values()].some(s => s.states.size >= 3), 'a class was seen in three states');
    // Where a node stands does not depend on the look: its base point on screen is the same as in NEXUS.
    const at = new Map(base.view.hit.map(h => [h.id, h.base.join(' ')]));
    assert.equal(view.hit.length, base.view.hit.length);
    for (const h of view.hit) assert.equal(h.base.join(' '), at.get(h.id), id + ': ' + h.id + ' stands elsewhere');
    assert.ok(drawn.strokes.length > 50);
    // The state's name is a word in the caption of the selected node.
    view.setSelected(FIXED.SELECTED); frame();
    const word = look.caption(M.STATES.needs.name);
    assert.ok(drawn.texts.some(t => String(t.text).startsWith(word)), id + ': the selected agent\'s caption says "' + word + '"');
  });

  test('look ' + id + ': its backdrop is still, inside the limits, and asks for no clock; its colours have fixed fall-backs', () => {
    const look = LOOKS[id];
    if (typeof look.fromPage === 'function') {
      for (const [name, vars] of SHOOT.samplesOf(look)) {
        look.fromPage((key, fallback) => (Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : fallback));
        assert.deepEqual(problems(look), [], 'after fromPage under its sample "' + name + '"');
      }
      look.fromPage((name, fallback) => fallback);        // a page with none of the variables: the fall-backs
      assert.deepEqual(problems(look), [], 'after fromPage with nothing to read');
    }
    if (typeof look.backdrop !== 'function') return;
    const cols = [L.DOCK, 0, 1, 2, 3];
    const real = { now: Date.now, random: Math.random, perf: performance.now };
    let first;
    try {
      Date.now = () => { throw new Error('a backdrop may not read the clock'); };
      Math.random = () => { throw new Error('a backdrop may not use Math.random: use MonitorEngine.seeded'); };
      performance.now = () => { throw new Error('a backdrop may not read the clock'); };
      first = look.backdrop(E.backdropScene(cols, 1));
    } finally { Date.now = real.now; Math.random = real.random; performance.now = real.perf; }
    assert.deepEqual(look.backdrop(E.backdropScene(cols, 1)), first, 'asked twice, it gives the same items');
    for (const spread of [1, L.SPREAD]) for (const shown of [cols, [L.DOCK], [L.DOCK, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]]) {
      const kept = E.compileBackdrop(look.backdrop(E.backdropScene(shown, spread)), look.palette);
      assert.deepEqual(kept.over, {}, id + ': over the backdrop\'s limits with ' + shown.length + ' columns: ' + JSON.stringify(kept.count));
    }
    const { view } = sceneIn(look);
    assert.equal(view.backdropInfo.error, '', 'the backdrop throws');
  });
}

/* ---------- the contract itself, on a look made for the tests ---------- */

test('the contract: a look that uses every knob is a complete look', () => {
  const look = Object.assign({}, KNOBS, { page: Object.assign({}, KNOBS.page) });
  delete look.page.notAKey;
  assert.deepEqual(problems(look), []);
  assert.deepEqual(problems(KNOBS), ['page.notAKey is not one of: ' + Object.keys(R.PAGE).join(', ')], 'a key outside the list is reported');
  assert.deepEqual(Object.keys(look.page).sort(), Object.keys(R.PAGE).sort(), 'the test look sets every page variable');
});

test('the contract: every page variable is one CSS custom property that style.css uses with a fall-back', () => {
  const css = fs.readFileSync(path.join(MEDIA, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const names = Object.values(R.PAGE);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) {
    assert.match(name, /^--[a-z-]+$/);
    if (name === '--ui') { assert.ok(/:root\s*\{[^}]*--ui:/.test(css), '--ui has its value in :root'); continue; }
    assert.ok(css.includes('var(' + name + ', '), name + ' is used with a fall-back');
    assert.ok(!new RegExp(name + '\\s*:').test(css), name + ' is set by a look only, never by the stylesheet');
  }
  // applyPage sets what a look gives and clears what it does not; a key outside the list is never set.
  const set = new Map(), style = { setProperty: (k, v) => set.set(k, v), removeProperty: k => set.delete(k) };
  R.applyPage(KNOBS, style);
  assert.deepEqual([...set.keys()].sort(), names.slice().sort());
  assert.equal(set.get('--radius'), '11px');
  R.applyPage(LOOKS.nexus, style);
  assert.equal(set.size, 0, 'a look that sets none clears them all');
  assert.equal(R.swatchBack(KNOBS), KNOBS.palette.bg, 'panels with their own ink: a swatch stands on the stage\'s colour');
  assert.equal(R.swatchBack(LOOKS.nexus), '');
});

test('the contract: an outline colour apart from the fill, faces, and a caption size', () => {
  const { view, drawn } = sceneIn(KNOBS), pal = KNOBS.palette;
  // Every mesh edge is stroked in the outline colour; the class's colour is the fill.
  const edges = drawn.strokes.filter(s => s.color === pal.outline && s.width === KNOBS.lineWidth);
  assert.ok(edges.length >= view.stats.nodes, 'each node\'s edges are in the outline colour: ' + edges.length);
  assert.ok(!drawn.strokes.some(s => s.width === KNOBS.lineWidth && Object.values(pal.cls).includes(s.color) && s.alpha === 1 && s.dash.length === 0 && s.lines > 2), 'no mesh is outlined in its class\'s colour');
  for (const cls of ['agent', 'tool', 'resource', 'mcp']) assert.ok(drawn.fills.some(f => f.color === pal.cls[cls] && f.alpha === pal.fill) || cls === 'tool', cls + ' is filled in its class\'s colour');
  // A mesh with `faces: []` (the cross) fills nothing: each standing tool's fill has an empty path. A pile of folded tools is a box, and is filled.
  const model = FIXED.model(), tools = [...model.nodes.values()].filter(n => n.cls === 'tool' && !n.folded).length, piles = [...model.nodes.values()].filter(n => n.cls === 'stack' && n.of === 'tool').length;
  const toolFills = drawn.fills.filter(f => f.color === pal.cls.tool && f.alpha === pal.fill);
  assert.deepEqual([toolFills.filter(f => f.moves === 0).length, toolFills.filter(f => f.moves > 0).length], [tools, piles], 'the cross is two strokes and no fill');
  // A flat polygon is filled as drawn: one face, as many corners as the mesh.
  assert.ok(drawn.fills.some(f => f.color === pal.cls.agent && f.alpha === pal.fill && f.moves === 1 && f.lines === 2), 'the triangle is filled by its one face');
  // The caption size: 15 px at rest (16.5 selected, 13.5 for the state's line), and a caption's box grows with it.
  const sizes = new Set(drawn.texts.map(t => /(\d+(?:\.\d+)?)px/.exec(t.font)[1]));
  assert.ok(sizes.has('15') && sizes.has('13.5'), [...sizes].join(' '));
  assert.ok(!sizes.has('10') && !sizes.has('11'), 'no caption is left at the default size: ' + [...sizes].join(' '));
  const plain = sceneIn(LOOKS.nexus);
  const tall = Math.max(...view.labels.map(b => b.h)), usual = Math.max(...plain.view.labels.map(b => b.h));
  assert.equal(usual, 2 * 12 + 3);
  assert.equal(tall, 2 * 12 * 1.5 + 3);
  // merge carries faces, and a mesh of the looks before this contract has none.
  assert.equal(E.shapes.merge(E.shapes.box(2, 2, 2), E.shapes.box(2, 2, 2, 2)).faces, undefined);
  const mixed = E.shapes.merge(E.shapes.box(2, 2, 2), E.shapes.polygon([[0, 0, 0], [1, 0, 0], [0, 1, 0]]));
  assert.deepEqual(mixed.faces, [[8, 9, 10]]);
  assert.deepEqual(mixed.lines.slice(-3), [[8, 9], [9, 10], [10, 8]]);
});

test('the contract: a backdrop at the limits is one path for each item, is kept between frames, and is behind everything', () => {
  let asked = 0;
  const look = Object.assign({}, KNOBS, { backdrop: scene => { asked++; return KNOBS.backdrop(scene); } });
  const { view, drawn, frame } = sceneIn(look), B = E.BACKDROP;
  assert.deepEqual(view.backdropInfo, { segments: B.segments, dots: B.dots, texts: B.texts, styles: B.styles, over: {}, error: '' });
  assert.ok(B.segments >= 1000 && B.styles <= 16, 'the limits: ' + JSON.stringify(B));
  // The first things drawn after the background: 10 strokes for 1,500 segments, then 2 fills for 500 dots.
  const first = drawn.strokes.slice(0, B.styles - 2);
  assert.equal(first.reduce((n, s) => n + s.lines, 0), B.segments, 'every segment is in one of the first ' + first.length + ' strokes');
  assert.ok(first.every(s => s.lines === B.segments / (B.styles - 2) && s.alpha === .35), 'one stroke for each item, whatever it holds');
  assert.deepEqual(first.map(s => s.dash.length), [0, 2, 0, 2, 0, 2, 0, 2, 0, 2], 'a dash is the item\'s own');
  assert.deepEqual(drawn.fills.slice(0, 2).map(f => f.arcs), [B.dots / 2, B.dots / 2], 'one fill for each item of dots');
  assert.equal(drawn.texts.filter(t => /^DISTRICT \d+$/.test(t.text)).length, B.texts);
  assert.equal(drawn.texts.findIndex(t => /^DISTRICT/.test(t.text)), 0, 'the backdrop\'s text is drawn before any floor title or caption');
  // The look is asked once: a second frame, a selection and a turn of the camera only project what was kept.
  assert.equal(asked, 1);
  frame(); view.setSelected(FIXED.SELECTED); frame(); view.orbit(.2, .1); frame();
  assert.equal(asked, 1, 'the backdrop is not asked for again');
  // It is asked again when the floors change (spread, or the columns shown), and when the look is applied again.
  view.setSpread(L.SPREAD); frame();
  assert.equal(asked, 2);
  view.isolate(1); frame();
  assert.equal(asked, 3);
  view.setLook(look); frame();
  assert.equal(asked, 4);
  // What a backdrop is told: the floors, and nothing of the model.
  const scene = E.backdropScene([L.DOCK, 0, 1], 1);
  assert.deepEqual(Object.keys(scene).sort(), ['bounds', 'cell', 'columns', 'floors', 'pitch', 'rowPitch']);
  assert.deepEqual(scene.columns.map(c => [c.dock, c.x, c.z, Object.keys(c.tiles).join()]), [[true, -L.PITCH, 0, 'mcp'], [false, 0, 0, 'agent,tool,resource'], [false, L.PITCH, 0, 'agent,tool,resource']]);
  assert.deepEqual(scene.columns[1].tiles.agent, L.tile(0, 'agent', 1));
  assert.deepEqual(scene.floors, { agent: 510, mcp: 340, tool: 170, resource: 0 });
});

test('the contract: what is over a backdrop\'s limits is not drawn and is counted; a backdrop that throws does not stop the scene', () => {
  const B = E.BACKDROP, line = [[0, 0, 0], [10, 0, 0]];
  const many = { lines: new Array(B.segments + 25).fill(line) }, dots = { dots: new Array(B.dots + 7).fill([0, 0, 0]) };
  const kept = E.compileBackdrop([many, dots, ...new Array(B.texts + 3).fill({ text: 'x', at: [0, 0, 0] }), ...new Array(B.styles).fill({ dots: [[1, 1, 1]] })], LOOKS.nexus.palette);
  assert.deepEqual(kept.count, { segments: B.segments, dots: B.dots, texts: B.texts, styles: 2 });
  assert.deepEqual(kept.over, { segments: 25, dots: B.styles + 7, texts: 3 });
  assert.deepEqual(E.compileBackdrop(new Array(B.styles + 2).fill({ lines: [line] }), LOOKS.nexus.palette).over, { styles: 2 });
  // Things that are not items are left out, and nothing throws.
  const odd = E.compileBackdrop([null, 7, 'x', {}, { lines: 'no' }, { lines: [[[0, 0, 0]]] }, { lines: [[[0, 0, NaN], [1, 1, 1]]] }, { dots: [[1, 2]] }, { text: '', at: [0, 0, 0] }, { text: 'a', at: [0, 0] }], LOOKS.nexus.palette);
  assert.deepEqual(odd.ops, []);
  assert.equal(E.compileBackdrop(undefined, LOOKS.nexus.palette).ops.length, 0);
  // Out-of-range styles are brought inside: alpha 0 to 1, width 0.25 to 6, dot size 0.4 to 6, text 6 to 48 px.
  const tamed = E.compileBackdrop([{ lines: [line], alpha: 9, width: 400 }, { dots: [[0, 0, 0]], size: 90 }, { text: 'big', at: [0, 0, 0], size: 900 }], LOOKS.nexus.palette).ops;
  assert.deepEqual([tamed[0].alpha, tamed[0].width, tamed[1].size, tamed[2].size, tamed[0].color], [1, 6, 6, 48, LOOKS.nexus.palette.line]);
  const broken = Object.assign({}, LOOKS.nexus, { backdrop: () => { throw new Error('boom'); } });
  const { view } = sceneIn(broken);
  assert.equal(view.backdropInfo.error, 'boom');
  assert.ok(view.stats.nodes > 20, 'the scene is still drawn');
  // The helpers: a ring closes on itself and is still; the same seed gives the same scatter.
  const ring = E.strokes.ring([5, 6, 7], 10, 12, .4, .2);
  assert.equal(ring.length, 13);
  assert.deepEqual(ring[0], ring[12]);
  assert.deepEqual(E.strokes.ring([5, 6, 7], 10, 12, .4, .2), ring);
  assert.equal(E.strokes.grid(0, 0, 200, 100, 0, 100).length, 3 + 2);
  const a = E.seeded(3), b = E.seeded(3), c = E.seeded(4);
  const run = f => [f(), f(), f()];
  assert.deepEqual(run(a), run(b));
  assert.notDeepEqual(run(E.seeded(3)), run(c));
  assert.ok(run(E.seeded(9)).every(n => n >= 0 && n < 1));
});

test('the contract: colours read from the page, with fixed fall-backs, and a signature that changes only when they do', () => {
  const look = Object.assign({}, KNOBS, { palette: Object.assign({}, KNOBS.palette) });
  const style = { '--vscode-editor-background': ' #102030 ' };
  const doc = { documentElement: {}, defaultView: { getComputedStyle: () => ({ getPropertyValue: name => style[name] || '' }) } };
  const before = R.signature(look);
  R.refresh(look, doc);
  assert.equal(look.palette.bg, '#102030', 'read from the page, trimmed');
  assert.equal(look.palette.ink, '#1b1b1b', 'absent: the fixed fall-back');
  assert.notEqual(R.signature(look), before);
  const again = R.signature(look);
  assert.equal(R.signature(R.refresh(look, doc)), again, 'nothing changed: the same signature');
  assert.equal(R.refresh(LOOKS.nexus, doc), LOOKS.nexus, 'a look without fromPage is left as it is');
});

test('the shoot tool takes built looks only, and a look\'s samples are sets of the editor\'s variables', () => {
  const { wanted, refused } = SHOOT.sort(['nexus-mockup', STUBS[0] || 'nexus', 'no-such-look', 'nexus-mockup', 'toString']);
  assert.deepEqual(wanted, STUBS.length ? ['nexus-mockup'] : ['nexus-mockup', 'nexus']);
  assert.equal(refused.length, STUBS.length ? 3 : 2);
  if (STUBS.length) assert.match(refused[0], /^[a-z-]+: not built yet/);
  assert.match(refused[refused.length - 1], /^toString: not a look/);
  assert.equal(path.relative(REPO, SHOOT.OUT).split(path.sep).join('/'), 'docs/looks/img');
  assert.deepEqual(SHOOT.samplesOf(LOOKS.nexus), []);
  assert.deepEqual(SHOOT.samplesOf(KNOBS), [['dark', KNOBS.samples.dark]]);
  for (const samples of [7, { Dark: {} }, { 'a/b': {} }, { dark: null }, { dark: { '--bg': '#000' } }, { dark: { '--vscode-editor-background': 7 } }])
    assert.throws(() => SHOOT.samplesOf({ id: 'x', samples }), /^Error: x: /, JSON.stringify(samples));
  // A look's sample changes what fromPage reads, and the look is still a complete look under it.
  const look = Object.assign({}, KNOBS, { palette: Object.assign({}, KNOBS.palette), page: undefined });
  look.fromPage((key, fallback) => KNOBS.samples.dark[key] || fallback);
  assert.equal(look.palette.bg, '#1e1e1e');
  assert.deepEqual(problems(look), []);
});

/* ---------- in the browser ---------- */

const browser = findBrowser();
const skip = browser.path ? false : 'NO BROWSER: ' + browser.why + '; the looks were not checked in a page';
if (skip) console.log(skip);
const T = { timeout: 120000, skip };
const measured = {};

/** The scene canvas's pixels as one number, how much of it is not the background, and the size the view has. */
const PICTURE = `(() => {
  const v = Monitor3D.view, c = v.canvas, ctx = c.getContext('2d'), d = new Uint32Array(ctx.getImageData(0, 0, c.width, c.height).data.buffer);
  const probe = document.createElement('canvas'); probe.width = probe.height = 1;
  const p = probe.getContext('2d'); p.fillStyle = v.look.palette.bg; p.fillRect(0, 0, 1, 1);
  const bg = new Uint32Array(p.getImageData(0, 0, 1, 1).data.buffer)[0];
  let h = 2166136261, other = 0;
  for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); if (d[i] !== bg) other++; }
  return { hash: (h >>> 0).toString(16), drawn: other / d.length, width: v.width, height: v.height, nodes: v.stats.nodes, captions: v.labels.length, backdrop: v.backdropInfo };
})()`;
/* One frame as a number made of everything it asks the canvas to draw, with the style in force; then the same frame a minute
   later by the page's clocks, with Math.random forbidden. Pixels are not compared here: a browser may rasterise the same
   commands differently after the canvas has been read back, and what must not differ is what the look asks for. */
const DRAWN_TWICE = `(() => {
  const v = Monitor3D.view, ctx = v.ctx, P = CanvasRenderingContext2D.prototype;
  const names = ['beginPath', 'moveTo', 'lineTo', 'arc', 'ellipse', 'closePath', 'fill', 'stroke', 'fillRect', 'clearRect', 'fillText', 'strokeText', 'setLineDash'];
  const inked = new Set(['fill', 'stroke', 'fillRect', 'fillText', 'strokeText']);
  const run = () => {
    let h = 2166136261, calls = 0;
    const add = text => { for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); } };
    for (const name of names) ctx[name] = function (...args) {
      calls++;
      add(name + '(' + args.map(a => (typeof a === 'number' ? a.toFixed(3) : JSON.stringify(a))).join(',') + ')');
      if (inked.has(name)) add([ctx.fillStyle, ctx.strokeStyle, ctx.globalAlpha, ctx.lineWidth, ctx.font, ctx.textAlign].join('|'));
      return P[name].apply(this, args);
    };
    try { v.draw(new Set(['input'])); } finally { for (const name of names) delete ctx[name]; }
    return (h >>> 0).toString(16) + ' in ' + calls + ' calls';
  };
  const first = run(), real = { now: performance.now.bind(performance), date: Date.now, random: Math.random };
  performance.now = () => real.now() + 60000; Date.now = () => real.date() + 60000;
  Math.random = () => { throw new Error('a look may not use Math.random when it draws'); };
  try { return [first, run()]; } finally { delete performance.now; Date.now = real.date; Math.random = real.random; }
})()`;
const centre = selector => `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  return { x, y, w: r.width, h: r.height, inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, onTop: e.contains(document.elementFromPoint(x, y)) }; })()`;
const LOOK_STATE = `({ look: document.documentElement.dataset.look, state: Monitor3D.state.look, chosen: Monitor3D.state.lookChosen, pressed: [...document.querySelectorAll('button[data-look][aria-pressed="true"]')].map(b => b.dataset.look),
  name: document.querySelector('#look-name .look-label').textContent, tag: !document.querySelector('#look-name .look-tag').hidden, open: !document.getElementById('look-panel').hidden, focus: document.activeElement && (document.activeElement.id || document.activeElement.dataset.look || document.activeElement.tagName) })`;
const FRAME_MS = `(() => { const v = Monitor3D.view, out = []; for (let i = 0; i < 5; i++) v.draw(new Set(['input'])); for (let i = 0; i < 41; i++) { v.draw(new Set(['input'])); out.push(v.stats.ms); } return out; })()`;
const median = list => { const s = list.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

describe('the looks in a headless browser', () => {
  let h;
  const pictures = new Map();
  before(async () => { if (!skip) { h = await Harness.start(browser.path); fs.mkdirSync(SHOTS, { recursive: true }); } });
  after(async () => {
    if (h) await h.close();
    if (!skip) console.log('MEASURED looks ' + JSON.stringify(measured));
  });
  /** A page showing the fixed scene, as a tab does: the hub's state, the chips, one snapshot. */
  async function openScene(size, state) {
    await h.open(Object.assign({}, size, { state: state || null }));
    for (const message of FIXED.around()) await h.deliver(message);
    await h.deliver(FIXED.message());
    await sleep(500);
  }
  async function clickOn(selector) {
    const at = await h.eval(centre(selector));
    assert.ok(at, selector + ' is in the page');
    assert.ok(at.w > 0 && at.h > 0 && at.inView, selector + ' is in view: ' + JSON.stringify(at));
    assert.ok(at.onTop, selector + ' is not covered');
    await h.click(at.x, at.y);
    await sleep(120);
  }
  /** A key that also types, as a real key does: Enter and Space press the button that has the focus. */
  async function type(key, code, keyCode, text) {
    await h.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, text });
    await h.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await sleep(150);
  }
  const enter = () => type('Enter', 'Enter', 13, '\r'), space = () => type(' ', 'Space', 32, ' ');
  const noErrors = async what => {
    assert.deepEqual(h.errors, [], what);
    assert.deepEqual(await h.eval('__m.errors'), [], what);
    assert.deepEqual(await h.eval('__m.csp'), [], what + ': the policy');
  };

  it('the switcher is built from the list: 18 buttons in order, grouped, stubs marked "not built", and buttons only', T, async () => {
    await openScene();
    const page = await h.eval(`({
      registered: Object.keys(MonitorLooks),
      buttons: [...document.querySelectorAll('#look-panel button[data-look]')].map(b => ({ id: b.dataset.look, text: b.querySelector('.look-label').textContent, tag: (b.querySelector('.look-tag') || {}).textContent || '', stub: b.dataset.stub === 'true', pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label') || '', disabled: b.disabled })),
      groups: [...document.querySelectorAll('#look-panel .look-group')].map(g => ({ name: g.getAttribute('aria-label'), role: g.getAttribute('role'), shown: g.querySelector('.group-name').textContent, ids: [...g.querySelectorAll('button[data-look]')].map(b => b.dataset.look) })),
      elsewhere: document.querySelectorAll('button[data-look]').length - document.querySelectorAll('#look-panel button[data-look]').length,
      editing: document.querySelectorAll('select, input, textarea, form, [contenteditable]').length,
      prev: document.getElementById('look-prev').getAttribute('aria-label'), next: document.getElementById('look-next').getAttribute('aria-label'),
      nameTag: document.getElementById('look-name').tagName, expanded: document.getElementById('look-name').getAttribute('aria-expanded'), hidden: document.getElementById('look-panel').hidden
    })`);
    assert.deepEqual(page.registered, IDS, 'the looks the page registered');
    assert.deepEqual(page.buttons.map(b => b.id), IDS, 'the buttons');
    assert.deepEqual(page.buttons.map(b => b.text), R.LIST.map(e => e.name));
    assert.deepEqual(page.groups.map(g => g.name), R.GROUPS);
    assert.ok(page.groups.every(g => g.role === 'group' && g.shown === g.name));
    assert.deepEqual(page.groups.flatMap(g => g.ids), IDS);
    for (const b of page.buttons) {
      assert.equal(b.stub, STUBS.includes(b.id), b.id);
      assert.equal(b.tag, b.stub ? 'not built' : '', b.id + ': a stub is plainly marked, a built look is not');
      if (b.stub) assert.equal(b.label, b.text + ', not built');
      assert.equal(b.disabled, false);
      assert.equal(b.pressed, String(b.id === 'nexus'), b.id);
    }
    assert.equal(page.elsewhere, 0, 'no look button outside the list');
    assert.equal(page.editing, 0, 'no select, input, textarea, form or contenteditable');
    assert.deepEqual([page.prev, page.next, page.nameTag, page.expanded, page.hidden], ['Previous look', 'Next look', 'BUTTON', 'false', true]);
    await noErrors('at load');
  });

  for (const id of BUILT) {
    it('look ' + id + ': a click on its button shows it, the scene is drawn, and no frame is drawn in the 3 seconds after', T, async () => {
      await openScene();
      await clickOn('#look-name');
      assert.equal((await h.eval(LOOK_STATE)).open, true, 'the list is open');
      await clickOn('#look-panel button[data-look="' + id + '"]');
      await h.eval(`Monitor3D.select(${JSON.stringify(FIXED.SELECTED)}, 'model')`);
      await sleep(500);
      const s = await h.eval(LOOK_STATE);
      assert.equal(s.look, id, 'document.documentElement.dataset.look');
      assert.deepEqual(s.pressed, [id], 'its button alone is pressed');
      assert.deepEqual([s.state, s.chosen, s.name, s.tag, s.open], [id, true, R.entry(id).name, false, false]);
      const a = await h.counters(); await sleep(3000); const b = await h.counters();
      assert.equal(b[0] - a[0], 0, 'frames drawn at rest');
      assert.equal(b[1] - a[1], 0, 'animation frames asked for at rest');
      assert.equal(b[2] - a[2], 0, 'strokes at rest');
      const picture = await h.eval(PICTURE);
      assert.equal(picture.nodes, [...FIXED.model().nodes.values()].filter(n => !n.folded).length, 'every standing node is drawn');
      assert.ok(picture.drawn > .02, 'more than the background is drawn: ' + (picture.drawn * 100).toFixed(1) + ' % of the canvas');
      assert.ok(picture.captions >= 6, 'captions: ' + picture.captions);
      if (picture.backdrop) assert.deepEqual([picture.backdrop.over, picture.backdrop.error], [{}, ''], 'the backdrop is inside its limits');
      // Drawn again a minute later with nothing changed, it is the same drawing: nothing in a look depends on when it is drawn.
      const twice = await h.eval(DRAWN_TWICE);
      assert.equal(twice[1], twice[0], 'the same scene is drawn differently a minute later');
      assert.ok(parseInt(twice[0].split(' in ')[1], 10) > 500, 'the frame was recorded: ' + twice[0]);
      pictures.set(id, picture);
      await h.screenshot(path.join(SHOTS, id + '.png'));
      await noErrors(id);
    });
  }

  it('no two built looks draw the same picture of the same scene, and none changes the size of the scene', T, async () => {
    assert.deepEqual([...pictures.keys()], BUILT, 'every built look was photographed');
    const by = new Map();
    for (const [id, p] of pictures) { assert.ok(!by.has(p.hash), id + ' draws the same picture as ' + by.get(p.hash)); by.set(p.hash, id); }
    const first = pictures.get(BUILT[0]);
    for (const [id, p] of pictures) assert.deepEqual([p.width, p.height], [first.width, first.height], id + ' at 1280 x 720');
    // The same at 800 x 600 and in the narrow layout, where the bar is tightest.
    for (const size of [{ width: 800, height: 600 }, { width: 560, height: 600 }]) {
      await openScene(size);
      const sizes = {};
      for (const id of BUILT) { await h.eval(`Monitor3D.chooseLook(${JSON.stringify(id)})`); await sleep(150); sizes[id] = await h.eval('[Monitor3D.view.width, Monitor3D.view.height, document.querySelector(".bar").getBoundingClientRect().height]'); }
      for (const id of BUILT) assert.deepEqual(sizes[id], sizes[BUILT[0]], id + ' at ' + size.width + ' x ' + size.height);
    }
    measured.pictures = Object.fromEntries([...pictures].map(([id, p]) => [id, p.hash]));
    measured.scene = [first.width, first.height];
  });

  for (const size of [{ width: 800, height: 600 }, { width: 560, height: 600 }]) {
    it('the switcher at ' + size.width + ' x ' + size.height + ': every look can be reached by pointer, the name is always shown in full, previous and next go round', T, async () => {
      await openScene(size);
      // The name of the current look is in the bar, in view, whether the list is open or not; and so are the two arrows.
      for (const selector of ['#look-name', '#look-prev', '#look-next']) { const at = await h.eval(centre(selector)); assert.ok(at.inView && at.onTop && at.w >= 20 && at.h >= 24, selector + ': ' + JSON.stringify(at)); }
      // Each look in turn by a real click in the list. The list scrolls when it must; it never leaves the window.
      for (const id of IDS) {
        await clickOn('#look-name');
        const panel = await h.eval(`(() => { const r = document.getElementById('look-panel').getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);
        assert.ok(panel.left >= 0 && panel.right <= size.width && panel.top >= 0 && panel.bottom <= size.height, 'the list is inside the window: ' + JSON.stringify(panel));
        await clickOn('#look-panel button[data-look="' + id + '"]');
        const s = await h.eval(LOOK_STATE);
        assert.deepEqual([s.look, s.pressed, s.open, s.name, s.tag], [id, [id], false, R.entry(id).name, STUBS.includes(id)], id);
        const fits = await h.eval(`(() => { const l = document.querySelector('#look-name .look-label'), b = document.getElementById('look-name').getBoundingClientRect(); return { cut: l.scrollWidth > l.clientWidth, left: b.left, right: b.right }; })()`);
        assert.equal(fits.cut, false, id + ': its name is cut short in the bar');
        assert.ok(fits.left >= 0 && fits.right <= size.width);
      }
      assert.equal(await h.eval('document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight'), true, 'the page does not scroll');
      // Next from the last look is the first; previous from the first is the last; 18 steps come back.
      await clickOn('#look-next');
      assert.equal((await h.eval(LOOK_STATE)).look, IDS[0]);
      await clickOn('#look-prev');
      assert.equal((await h.eval(LOOK_STATE)).look, IDS[17]);
      const seen = [];
      for (let i = 0; i < 18; i++) { await clickOn('#look-next'); seen.push((await h.eval(LOOK_STATE)).look); }
      assert.deepEqual(seen, IDS, 'next goes through the list in order');
      // A press outside the open list closes it, and chooses nothing.
      await clickOn('#look-name');
      await clickOn('#status');
      assert.deepEqual([(await h.eval(LOOK_STATE)).open, (await h.eval(LOOK_STATE)).look], [false, IDS[17]]);
      if (process.env.WYARDEN_PAGE_SHOTS || size.width === 800) { await clickOn('#look-name'); await h.screenshot(path.join(SHOTS, 'switcher-' + size.width + 'x' + size.height + '.png')); }
      await noErrors('the switcher at ' + size.width);
    });
  }

  it('the switcher by keyboard: Enter opens the list on the current look, arrows move, Enter chooses, Escape closes', T, async () => {
    await openScene({ width: 800, height: 600 });
    await h.eval('document.getElementById("look-name").focus()');
    await enter();
    await sleep(120);
    let s = await h.eval(LOOK_STATE);
    assert.deepEqual([s.open, s.focus], [true, 'nexus'], 'the list opens with the focus on the current look');
    assert.equal(await h.eval('document.querySelectorAll("#look-panel button[tabindex=\\"0\\"]").length'), 1, 'one tab stop in the list');
    await h.key('ArrowRight', 'ArrowRight', 39); await h.key('ArrowRight', 'ArrowRight', 39); await h.key('ArrowDown', 'ArrowDown', 40);
    assert.equal((await h.eval(LOOK_STATE)).focus, IDS[3]);
    await h.key('ArrowLeft', 'ArrowLeft', 37);
    assert.equal((await h.eval(LOOK_STATE)).focus, IDS[2]);
    await h.key('End', 'End', 35);
    assert.equal((await h.eval(LOOK_STATE)).focus, IDS[17]);
    await h.key('Home', 'Home', 36); await h.key('ArrowLeft', 'ArrowLeft', 37);
    assert.equal((await h.eval(LOOK_STATE)).focus, IDS[17], 'the arrows go round');
    assert.equal((await h.eval(LOOK_STATE)).look, 'nexus', 'moving the focus chooses nothing');
    await h.key('Home', 'Home', 36); await h.key('ArrowRight', 'ArrowRight', 39); await h.key('ArrowRight', 'ArrowRight', 39);
    await enter();
    await sleep(150);
    s = await h.eval(LOOK_STATE);
    assert.deepEqual([s.look, s.pressed, s.open, s.focus, s.chosen], [IDS[2], [IDS[2]], false, 'look-name', true], 'Enter chooses, closes the list and puts the focus back on the name');
    // Escape closes without choosing; the arrows beside the name are ordinary buttons.
    await h.key('ArrowDown', 'ArrowDown', 40);
    await sleep(100);
    assert.deepEqual([(await h.eval(LOOK_STATE)).open, (await h.eval(LOOK_STATE)).focus], [true, IDS[2]], 'Down on the name opens the list too');
    await h.key('ArrowRight', 'ArrowRight', 39);
    await h.key('Escape', 'Escape', 27);
    await sleep(100);
    s = await h.eval(LOOK_STATE);
    assert.deepEqual([s.look, s.open, s.focus], [IDS[2], false, 'look-name']);
    await h.eval('document.getElementById("look-next").focus()');
    await enter();
    await sleep(120);
    await space();
    await sleep(120);
    s = await h.eval(LOOK_STATE);
    assert.deepEqual([s.look, s.focus], [IDS[4], 'look-next'], 'Enter and Space on "next look" step twice, and the focus stays');
    assert.equal(s.tag, true, 'a stub is marked beside its name in the bar');
    assert.match(await h.eval('document.getElementById("look-name").getAttribute("aria-label")'), /^Look: Lattice original, not built\. /);
    assert.match(await h.eval('document.getElementById("live").textContent'), /^Look: Lattice original, not built yet\.$/);
    await noErrors('the switcher by keyboard');
  });

  it('the host\'s rule: the editor\'s theme picks NEXUS or Glasshouse until a look is chosen; the choice is saved and comes back', T, async () => {
    await openScene();
    await h.deliver({ v: 1, type: 'look', look: 'glasshouse' });
    assert.deepEqual([(await h.eval(LOOK_STATE)).look, (await h.eval(LOOK_STATE)).chosen], ['glasshouse', false]);
    await h.deliver({ v: 1, type: 'look', look: 'nexus' });
    assert.equal((await h.eval(LOOK_STATE)).look, 'nexus');
    // "Next look" is a choice, as a button of the list is.
    await clickOn('#look-next'); await clickOn('#look-next');
    assert.deepEqual([(await h.eval(LOOK_STATE)).look, (await h.eval(LOOK_STATE)).chosen], ['nexus-mockup', true]);
    for (const look of ['glasshouse', 'nexus', 'circuit-city', 'toString']) await h.deliver({ v: 1, type: 'look', look });
    assert.equal((await h.eval(LOOK_STATE)).look, 'nexus-mockup', 'the owner\'s choice stays when the theme changes');
    const saved = (await h.eval('window.__states')).pop();
    assert.deepEqual([saved.look, saved.lookChosen], ['nexus-mockup', true]);
    await openScene(undefined, saved);
    await h.deliver({ v: 1, type: 'look', look: 'glasshouse' });
    const s = await h.eval(LOOK_STATE);
    assert.deepEqual([s.look, s.pressed, s.name, s.chosen], ['nexus-mockup', ['nexus-mockup'], 'NEXUS mock-up', true], 'after a reload');
    // A stub is a look like any other to the saved state.
    await openScene(undefined, { v: 1, look: 'skyline', lookChosen: true });
    assert.deepEqual([(await h.eval(LOOK_STATE)).look, (await h.eval(LOOK_STATE)).tag], ['skyline', true]);
    await noErrors('the host\'s rule');
  });

  it('a look\'s lettering and panel variables are set while it is shown and cleared when another is; the scene keeps its size', T, async () => {
    await openScene();
    const style = `(() => { const cs = (s, p) => getComputedStyle(document.querySelector(s)).getPropertyValue(p), root = document.documentElement.style;
      return { set: ${JSON.stringify(Object.values(R.PAGE))}.filter(n => root.getPropertyValue(n) !== ''), size: [Monitor3D.view.width, Monitor3D.view.height], bar: document.querySelector('.bar').getBoundingClientRect().height,
        title: [cs('.brand strong', 'font-style'), cs('.brand strong', 'font-size'), cs('.brand strong', 'text-transform'), cs('.brand strong', 'color'), cs('.brand strong', 'letter-spacing'), cs('.brand strong', 'font-weight')],
        titleFont: cs('.brand strong', 'font-family'), body: cs('body', 'font-family'), head: cs('.side h2', 'font-family'), label: [cs('.side h3', 'text-transform'), cs('.side h3', 'letter-spacing')],
        radius: [cs('#motion', 'border-radius'), cs('#hud', 'border-radius'), cs('#frame', 'border-radius')], shadow: cs('.brand strong', 'text-shadow') !== 'none',
        panel: [cs('.side h2', 'color'), cs('#status', 'color'), cs('.bar', 'border-bottom-color'), cs('#motion', 'color'), cs('#frame', 'color'), cs('#hud b', 'color')], stageInk: cs('.stage', '--ink').trim(),
        swatch: getComputedStyle(document.querySelector('#legend-body canvas')).backgroundColor, text: document.querySelector('.brand strong').textContent };
    })()`;
    const plain = await h.eval(style);
    assert.deepEqual(plain.set, [], 'NEXUS sets no lettering variable');
    assert.deepEqual(plain.title, ['normal', '14px', 'uppercase', 'rgb(232, 252, 255)', '3px', '600'], 'the title as it was before there were variables');
    assert.deepEqual([plain.label, plain.radius, plain.shadow, plain.swatch], [['uppercase', '0.6px'], ['3px', '3px', '3px'], false, 'rgba(0, 0, 0, 0)']);
    assert.equal(plain.text, 'Monitor 3D');
    await h.eval(KNOBS_SOURCE);
    await h.eval('Monitor3D.chooseLook("every-knob")');
    await sleep(300);
    const set = await h.eval(style);
    assert.deepEqual(set.set, Object.values(R.PAGE), 'every variable of the list is set');
    assert.deepEqual(set.title, ['italic', '19px', 'none', 'rgb(245, 158, 11)', '1px', '400']);
    for (const family of [set.titleFont, set.body, set.head]) assert.match(family, /^Georgia/);
    assert.deepEqual([set.label, set.radius, set.shadow], [['none', '2px'], ['11px', '11px', '11px'], true]);
    // The panels have their own ink (light on dark) and the stage keeps the palette's (dark on light).
    assert.deepEqual(set.panel, ['rgb(248, 250, 252)', 'rgb(154, 164, 178)', 'rgb(71, 85, 105)', 'rgb(215, 221, 229)', 'rgb(215, 221, 229)', 'rgb(248, 250, 252)']);
    assert.equal(set.stageInk, '#1b1b1b');
    assert.equal(set.swatch, 'rgb(244, 239, 230)', 'a swatch on a dark panel stands on the stage\'s colour');
    assert.deepEqual([set.size, set.bar], [plain.size, plain.bar], 'the bar and the scene keep their size under other lettering');
    assert.equal((await h.eval(LOOK_STATE)).name, 'every-knob', 'a look outside the list is named by its id');
    await h.eval('Monitor3D.chooseLook("nexus")');
    await sleep(300);
    assert.deepEqual(await h.eval(style), plain, 'back in NEXUS everything is as it was: every variable is cleared');
    await noErrors('lettering');
  });

  it('a look that reads its colours from the page reads them again when the editor\'s theme changes, also after the owner chose it; nothing else redraws', T, async () => {
    await openScene();
    await h.eval(KNOBS_SOURCE);
    await h.eval('Monitor3D.chooseLook("every-knob")');
    await sleep(300);
    const read = '[MonitorLooks["every-knob"].palette.bg, document.documentElement.style.getPropertyValue("--bg"), MonitorLooks["every-knob"].palette.ink, document.documentElement.style.getPropertyValue("--ink"), Monitor3D.state.lookChosen]';
    assert.deepEqual(await h.eval(read), ['#f4efe6', '#f4efe6', '#1b1b1b', '#1b1b1b', true], 'no editor variables: the fixed fall-backs');
    const corner = `(() => { const d = Monitor3D.view.ctx.getImageData(2, 2, 1, 1).data; return [d[0], d[1], d[2]]; })()`;
    assert.deepEqual(await h.eval(corner), [0xf4, 0xef, 0xe6]);
    // The editor changes its theme: VS Code rewrites the variables on <html>. The page notices by itself.
    let before = await h.counters();
    await h.eval('document.documentElement.style.setProperty("--vscode-editor-background", "#123456"); document.documentElement.style.setProperty("--vscode-editor-foreground", "#fedcba")');
    await sleep(400);
    assert.deepEqual(await h.eval(read), ['#123456', '#123456', '#fedcba', '#fedcba', true]);
    assert.deepEqual(await h.eval(corner), [0x12, 0x34, 0x56], 'the scene is drawn again in the new colour');
    let after = await h.counters();
    assert.ok(after[0] - before[0] >= 1 && after[0] - before[0] <= 2, 'one frame for the change (two at most): ' + (after[0] - before[0]));
    // The host's own word that the theme changed does the same, and never changes the look the owner chose.
    await h.eval('window.__probe = MonitorLooks["every-knob"].fromPage; MonitorLooks["every-knob"].fromPage = function (read) { window.__reads = (window.__reads || 0) + 1; return window.__probe.call(this, read); }');
    await h.deliver({ v: 1, type: 'look', look: 'glasshouse' });
    assert.equal(await h.eval('window.__reads'), 1, 'a "look" message makes the look read the page again');
    assert.equal((await h.eval(LOOK_STATE)).look, 'every-knob');
    // At rest nothing reads and nothing draws: not the page's own writes to <html>, not a class on <body>.
    before = await h.counters();
    await h.eval('document.body.classList.toggle("show-list"); document.documentElement.style.setProperty("--bar-height", "77px"); document.body.setAttribute("data-vscode-theme-kind", "vscode-dark")');
    await sleep(2000);
    after = await h.counters();
    assert.equal(after[0] - before[0], 0, 'frames after changes that are not the look\'s colours');
    assert.equal(after[1] - before[1], 0, 'animation frames asked for');
    assert.ok(await h.eval('window.__reads') >= 2, 'the look did look at the page, and found the same colours');
    // In a look that does not read the page, a change of theme costs nothing at all.
    await h.eval('Monitor3D.chooseLook("nexus")');
    await sleep(300);
    before = await h.counters();
    await h.eval('document.documentElement.style.setProperty("--vscode-editor-background", "#abcdef"); document.body.className = "vscode-light"');
    await h.deliver({ v: 1, type: 'look', look: 'glasshouse' });
    await sleep(1000);
    after = await h.counters();
    assert.deepEqual([after[0] - before[0], after[1] - before[1], (await h.eval(LOOK_STATE)).look], [0, 0, 'nexus']);
    await noErrors('colours from the page');
  });

  it('the shoot tool writes one picture for the look named and no other, where it is told to', T, async () => {
    const out = path.join(SHOTS, 'shoot'), committed = path.join(REPO, 'docs', 'looks', 'img');
    const listing = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).map(f => f + ' ' + fs.statSync(path.join(dir, f)).mtimeMs).sort() : []);
    for (const file of fs.existsSync(out) ? fs.readdirSync(out) : []) fs.unlinkSync(path.join(out, file));
    const before = listing(committed);
    const written = await SHOOT.shoot(['glasshouse-mockup'], { out });
    assert.deepEqual(fs.readdirSync(out), ['glasshouse-mockup.png']);
    assert.deepEqual(written.map(w => [w.id, w.sample, w.nodes]), [['glasshouse-mockup', '', [...FIXED.model().nodes.values()].filter(n => !n.folded).length]]);
    assert.ok(written[0].bytes > 20000, 'a real picture: ' + written[0].bytes + ' bytes');
    assert.deepEqual(listing(committed), before, 'the committed pictures are not touched by a test');
  });

  it('every built look draws a frame at about 200 nodes inside the plan\'s budget, and so does a backdrop at the engine\'s limits', T, async () => {
    await h.open();
    await h.deliver(S.scene({ agents: 12, ms: 900000 }).message);
    await sleep(600);
    await h.eval(KNOBS_SOURCE);
    // NEXUS's own meshes behind the test look's backdrop: 1,500 segments in 10 paths, 500 dots, 40 texts.
    await h.eval('MonitorLooks["nexus-backdrop"] = Object.assign({}, MonitorLooks.nexus, { id: "nexus-backdrop", backdrop: MonitorLooks["every-knob"].backdrop })');
    measured.frame200 = {};
    for (const id of BUILT.concat(['every-knob', 'nexus-backdrop'])) {
      await h.eval(`Monitor3D.chooseLook(${JSON.stringify(id)})`);
      await sleep(200);
      const still = await h.eval(FRAME_MS), nodes = await h.eval('Monitor3D.view.stats.nodes');
      // The camera turning: a backdrop is projected again in every frame, so this is what it costs at its worst.
      const turning = await h.eval(FRAME_MS.replace('v.draw(new Set([\'input\'])); out.push', 'v.camera.yaw += .01; v.draw(new Set([\'input\'])); out.push'));
      const budget = nodes <= 200 ? 8 : 8 + (Math.min(nodes, 500) - 200) * (16 - 8) / 300;
      measured.frame200[id] = { nodes, medianMs: +median(still).toFixed(2), turningMs: +median(turning).toFixed(2), budgetMs: +budget.toFixed(2) };
      assert.ok(nodes >= 180, id + ': about 200 nodes: ' + nodes);
      assert.ok(median(still) < budget, id + ': median frame ' + median(still).toFixed(2) + ' ms at ' + nodes + ' nodes, budget ' + budget.toFixed(2) + ' ms');
      assert.ok(median(turning) < budget, id + ': median frame while the camera turns ' + median(turning).toFixed(2) + ' ms, budget ' + budget.toFixed(2) + ' ms');
    }
    const info = await h.eval('Monitor3D.view.backdropInfo');
    assert.deepEqual([info.segments, info.dots, info.texts, info.styles, info.over], [E.BACKDROP.segments, E.BACKDROP.dots, E.BACKDROP.texts, E.BACKDROP.styles, {}]);
    await noErrors('the frame budget');
  });
});
