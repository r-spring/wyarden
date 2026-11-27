// What the scene draws, checked in Node with a canvas that only writes down what it is asked to draw: the two solids,
// colour by provider, captions with no plate behind them, the tab's title under an agent only while it is pointed at,
// and the workspace's name on the tile an agent stands on. Every name here is invented.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../media/model.js');
const E = require('../media/engine.js');
const LOOKS = { nexus: require('../media/look-nexus.js'), glasshouse: require('../media/look-glasshouse.js') };

/** A canvas that draws nothing and remembers every text and every filled rectangle, with the colour and font in force. */
function fakeCanvas() {
  const drawn = { texts: [], rects: [], discs: [] };
  const state = { globalAlpha: 1, fillStyle: '', strokeStyle: '', font: '', lineWidth: 1 };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'measureText') return text => ({ width: String(text).length * 6 });
      if (key === 'fillText') return (text, x, y) => { drawn.texts.push({ text, x, y, color: target.fillStyle, font: target.font, alpha: target.globalAlpha, how: 'fill' }); };
      if (key === 'strokeText') return (text, x, y) => { drawn.texts.push({ text, x, y, color: target.strokeStyle, font: target.font, alpha: target.globalAlpha, how: 'stroke' }); };
      if (key === 'fillRect') return (x, y, w, h) => { drawn.rects.push({ x, y, w, h, color: target.fillStyle, alpha: target.globalAlpha }); };
      if (key === 'arc') return (x, y, r) => { drawn.discs.push({ x, y, r, color: target.fillStyle, alpha: target.globalAlpha }); };
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; }
  });
  return { canvas: { getContext: () => ctx, width: 0, height: 0 }, drawn };
}
/** A view over a model, drawn once. `frame()` draws again after a change. */
function scene(model, look = LOOKS.nexus) {
  const { canvas, drawn } = fakeCanvas(), queue = [];
  let clock = 0;
  const view = new E.View(canvas, { model, look, env: { raf: fn => queue.push(fn), setTimeout: fn => { queue.push(fn); return 1; }, now: () => (clock += 200) } });
  const frame = () => { drawn.texts.length = 0; drawn.rects.length = 0; drawn.discs.length = 0; view.redraw.request('input'); while (queue.length) queue.shift()(); };
  view.setSize(1280, 720, 1);
  view.frame();
  frame();
  return { view, drawn, frame, filled: () => drawn.texts.filter(t => t.how === 'fill').map(t => t.text) };
}
const base = (session, agent = 'claude') => ({ v: 1, agent, session, ws: 'w1', grade: 'exact', src: 'hook:PreToolUse' });
/** One session with a tool call, a file and a subagent; its workspace and its tab's title as given. */
function session(model, id, { agent = 'claude', space, title, t = 1000 } = {}) {
  const b = base(id, agent);
  model.apply({ ...b, t, ev: 'session.start', grade: 'derived', src: 'sessions-file', root: { name: 'c0ffee' }, ...(space !== undefined ? { space } : {}), ...(title !== undefined ? { title } : {}) });
  model.apply({ ...b, t: t + 1, ev: 'turn.start', turn: 'p1' });
  model.apply({ ...b, t: t + 2, ev: 'tool.start', call: 'c1', tool: 'Read' });
  model.apply({ ...b, t: t + 3, ev: 'resource.touch', call: 'c1', kind: 'file', op: 'read', path: 'src/a.js' });
  model.apply({ ...b, t: t + 4, ev: 'subagent.start', sub: 'sub1', type: 'Explore' });
  return 'a:' + agent + ':' + id;
}

test('the two solids: an icosahedron has 12 corners and 30 edges, a dodecahedron 20 and 30, and each stands on its floor', () => {
  for (const [name, corners, degree] of [['icosahedron', 12, 5], ['dodecahedron', 20, 3]]) {
    const mesh = E.shapes[name](20);
    assert.equal(mesh.vertices.length, corners, name);
    assert.equal(mesh.lines.length, 30, name);
    const per = new Array(corners).fill(0);
    for (const [a, b] of mesh.lines) { per[a]++; per[b]++; }
    assert.ok(per.every(n => n === degree), name + ': every corner has ' + degree + ' edges');
    const ys = mesh.vertices.map(v => v[1]), middle = (Math.min(...ys) + Math.max(...ys)) / 2;
    assert.ok(Math.abs(Math.min(...ys)) < 1e-9, name + ' stands on y = 0');
    for (const v of mesh.vertices) assert.ok(Math.abs(Math.hypot(v[0], v[1] - middle, v[2]) - 20) < 1e-9, name + ': every corner is 20 from the centre');
    assert.ok(Math.abs(Math.min(...E.shapes[name](20, 7).vertices.map(v => v[1])) - 7) < 1e-9, name + ' can be set down higher');
  }
});

test('in both looks an agent is an icosahedron and a subagent a dodecahedron, and the other classes kept their shapes', () => {
  for (const look of Object.values(LOOKS)) {
    assert.equal(look.mesh('agent').vertices.length, 12, look.id);
    assert.equal(look.mesh('agent').lines.length, 30, look.id);
    assert.equal(look.mesh('subagent').vertices.length, 20, look.id);
    assert.equal(look.mesh('subagent').lines.length, 30, look.id);
    const size = mesh => Math.max(...mesh.vertices.map(v => v[1]));
    assert.ok(size(look.mesh('subagent')) < size(look.mesh('agent')) * .7, look.id + ': a subagent is clearly the smaller');
    assert.equal(look.mesh('tool').vertices.length >= 8, true);
    for (const key of ['tool', 'mcp', 'resource.file', 'resource.url', 'resource.context', 'stack']) assert.ok(look.mesh(key).lines.length > 0, look.id + ' ' + key);
  }
});

test('each look has one colour for each provider, and none of them is another class\'s or a state\'s', () => {
  for (const look of Object.values(LOOKS)) {
    const p = look.palette.provider;
    assert.deepEqual(Object.keys(p).sort(), M.AGENT_KINDS.slice().sort(), look.id);
    assert.deepEqual(Object.keys(E.PROVIDERS).sort(), M.AGENT_KINDS.slice().sort());
    const taken = [look.palette.cls.tool, look.palette.cls.resource, look.palette.cls.mcp, ...Object.values(look.palette.state), look.palette.clash, look.palette.bg];
    const all = Object.values(p).map(c => c.toLowerCase());
    assert.equal(new Set(all).size, 4, look.id + ': four different colours');
    for (const c of all) { assert.match(c, /^#[0-9a-f]{6}$/); assert.ok(!taken.map(x => x.toLowerCase()).includes(c), look.id + ': ' + c + ' is used for something else'); }
    assert.equal(look.palette.captionBack, 0, look.id + ': no plate behind a caption');
    // Not only different: far enough apart to be told at a glance (a distance in red, green and blue of 40 or more) from
    // each other, from the other classes, from the floor agents stand on, and from the two colours that call for action.
    const rgb = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)), apart = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));
    const floor = look.palette.floor.agent;
    const others = { tool: look.palette.cls.tool, resource: look.palette.cls.resource, mcp: look.palette.cls.mcp, floor, needs: look.palette.state.needs, failed: look.palette.state.failed, background: look.palette.bg };
    for (const [kind, colour] of Object.entries(p)) {
      for (const [what, other] of Object.entries(others)) assert.ok(apart(colour, other) >= 40, look.id + ': ' + kind + ' is ' + apart(colour, other).toFixed(0) + ' from ' + what);
      for (const [kind2, colour2] of Object.entries(p)) if (kind2 !== kind) assert.ok(apart(colour, colour2) >= 60, look.id + ': ' + kind + ' is ' + apart(colour, colour2).toFixed(0) + ' from ' + kind2);
    }
  }
});

test('a state mark stands clear of its shape, so it never hides a small node', () => {
  const model = M.create();
  session(model, 'one-0001', { space: 'Example Shop' });
  const { view, drawn } = scene(model);
  // A mark is drawn on a disc of the background's colour. For every node that has a mark, that disc's centre is up and to
  // the right of the node's own box by most of the disc's radius, so at most a sliver of the node's corner lies under it.
  const backs = drawn.discs.filter(d => d.color === LOOKS.nexus.palette.bg && d.alpha > .9 && d.alpha < 1);
  const checked = [];
  for (const hit of view.hit) {
    const n = model.nodes.get(hit.id);
    if (!M.STATES[n.status].shape) continue;
    const maxX = Math.max(...hit.hull.map(q => q.x)), minY = Math.min(...hit.hull.map(q => q.y));
    const disc = backs.find(d => Math.abs(d.x - maxX - d.r * .72) < .01 && Math.abs(d.y - minY + d.r * .72) < .01);
    assert.ok(disc, 'the mark of ' + hit.id + ' stands out from its corner');
    assert.ok(disc.x - disc.r > maxX - disc.r * .3 && disc.y + disc.r < minY + disc.r * .3, hit.id + ': the disc covers no more than a sliver of the node');
    checked.push(n.cls);
  }
  assert.ok(checked.includes('agent') && checked.includes('subagent'), 'an agent\'s and a subagent\'s mark were checked: ' + checked.join());
});

test('an agent and its subagents take their provider\'s colour; a tool, a file and a server keep their class\'s', () => {
  const model = M.create();
  const claude = session(model, 'one-0001'), codex = session(model, 'two-0002', { agent: 'codex', t: 2000 });
  for (const look of Object.values(LOOKS)) {
    const { view } = scene(model, look), pal = look.palette, node = id => model.nodes.get(id);
    assert.equal(view.colorOf(node(claude)), pal.provider.claude);
    assert.equal(view.colorOf(node(codex)), pal.provider.codex);
    assert.equal(view.colorOf(node('s:claude:one-0001:sub1')), pal.provider.claude, 'a subagent has its agent\'s provider colour');
    assert.equal(view.colorOf(node('s:codex:two-0002:sub1')), pal.provider.codex);
    assert.equal(view.colorOf(node('t:claude:one-0001:Read')), pal.cls.tool);
    assert.equal(view.colorOf(node('r:claude:one-0001:file:src/')), pal.cls.resource);
    assert.equal(view.visual(node(claude)).color, pal.provider.claude, 'the legend and the inspector draw with the same colour');
    // A subagent from a snapshot made before subagents carried their provider: its session's is used.
    const old = Object.assign({}, node('s:codex:two-0002:sub1')); delete old.kind;
    assert.equal(view.colorOf(old), pal.provider.codex);
    // A pile of folded subagents has the colour of its column's provider.
    assert.equal(view.colorOf({ cls: 'stack', of: 'subagent', col: model.sessions.get('codex:two-0002').col }), pal.provider.codex);
    assert.equal(view.colorOf({ cls: 'stack', of: 'tool', col: 0 }), pal.cls.tool);
    // A provider a look has no colour for falls back to the class's colour, and nothing throws.
    assert.equal(view.colorOf({ cls: 'agent', kind: 'toString', col: 5 }), pal.cls.agent);
  }
});

test('a caption has no plate behind it: the only filled rectangle is the background of the whole scene', () => {
  const model = M.create();
  session(model, 'one-0001', { space: 'Example Shop', title: 'Fix the checkout total' });
  for (const look of Object.values(LOOKS)) {
    const { drawn, view } = scene(model, look);
    assert.ok(view.labels.length >= 3, 'captions were drawn: ' + view.labels.length);
    assert.deepEqual(drawn.rects, [{ x: 0, y: 0, w: 1280, h: 720, color: look.palette.bg, alpha: 1 }], look.id);
    // Every caption's letters are filled once, over a thin outline in the background's colour.
    const outlines = drawn.texts.filter(t => t.how === 'stroke');
    assert.ok(outlines.length >= view.labels.length);
    assert.ok(outlines.every(t => t.color === look.palette.bg && t.alpha < 1));
  }
});

test('an agent is named by its provider; its tab\'s title shows under that name only while the pointer is on it', () => {
  const model = M.create();
  const id = session(model, 'one-0001', { space: 'Example Shop', title: 'Fix the checkout total' });
  const { view, drawn, frame, filled } = scene(model);
  assert.ok(filled().includes('CLAUDE'), 'the agent says what it is');
  assert.ok(!filled().some(t => /C0FFEE/i.test(t)), 'the folder\'s code is not in the scene');
  assert.ok(!filled().some(t => /checkout/i.test(t)), 'at rest the title is not shown');
  view.setSelected(id); frame();
  assert.ok(!filled().some(t => /checkout/i.test(t)), 'nor when the agent is only selected');
  view.hover = id; frame();
  const texts = drawn.texts.filter(t => t.how === 'fill'), name = texts.find(t => t.text === 'CLAUDE'), title = texts.find(t => t.text === 'Fix the checkout total');
  assert.ok(title, 'pointed at: the title is shown, as written');
  assert.equal(title.x, name.x);
  assert.equal(title.y, name.y + 12, 'directly under what agent it is');
  const state = texts.find(t => /^WORKING/.test(t.text));
  assert.equal(state.y, title.y + 12, 'and its state under the title');
  assert.equal(view.labels.find(b => b.id === id).title, 'Fix the checkout total');
  view.hover = ''; frame();
  assert.ok(!filled().some(t => /checkout/i.test(t)), 'the pointer left: the title is gone');
  // Another node pointed at does not bring an agent's title out.
  view.hover = 't:claude:one-0001:Read'; frame();
  assert.ok(!filled().some(t => /checkout/i.test(t)));
});

test('a long title is cut to fit, and an agent with no title shows none', () => {
  const model = M.create();
  const long = session(model, 'one-0001', { space: 'Example Shop', title: 'A very long title that says in many words what this session is about and then some more' });
  const none = session(model, 'two-0002', { space: 'Example Shop', t: 5000 });
  const { view, frame, filled } = scene(model);
  view.hover = long; frame();
  const shown = filled().find(t => t.startsWith('A very long title'));
  assert.equal(shown.length, E.TITLE_SHOWN);
  assert.ok(shown.endsWith('…'));
  view.hover = none; frame();
  const box = view.labels.find(b => b.id === none);
  assert.equal(box.title, '');
  assert.deepEqual(box.lines.length, 2, 'its name and its state, and no empty line between');
});

test('the tile an agent stands on is labelled with its workspace\'s name, never a key or a folder\'s code', () => {
  const model = M.create();
  session(model, 'one-0001', { space: 'Example Shop' });
  session(model, 'two-0002', { space: 'Notes', t: 5000 });
  const { view, filled } = scene(model);
  assert.deepEqual(view.tileLabels.map(l => l.text), ['EXAMPLE SHOP', 'NOTES']);
  assert.ok(!filled().includes('AGENTS'), 'the floor\'s own title makes way for the names');
  assert.ok(filled().includes('TOOLS') && filled().includes('RESOURCES'), 'the other floors keep their titles');
  const [a, b] = view.tileLabels;
  assert.ok(a.x + a.w <= b.x, 'two neighbours\' names do not run into each other');
  // A session whose workspace changes its name is relabelled; one that loses it falls back to the floor's title.
  model.apply({ ...base('one-0001'), t: 9000, ev: 'session.info', grade: 'derived', src: 'sessions-file', space: 'Shop, Tools' });
  const again = scene(model);
  assert.deepEqual(again.view.tileLabels.map(l => l.text), ['SHOP, TOOLS', 'NOTES']);
});

test('a workspace\'s name that is too long for its tile is cut, and a scene whose hub names no workspace keeps "AGENTS"', () => {
  const model = M.create();
  session(model, 'one-0001', { space: 'A workspace with a remarkably long name indeed, longer than any tile is wide' });
  session(model, 'two-0002', { space: 'Another workspace whose name goes on and on, far past the edge of its tile', t: 5000 });
  const { view } = scene(model);
  assert.equal(view.tileLabels.length, 2);
  assert.ok(view.tileLabels.every(l => l.text.endsWith('…')), view.tileLabels.map(l => l.text).join(' | '));
  assert.ok(view.tileLabels[0].x + view.tileLabels[0].w <= view.tileLabels[1].x);
  const old = M.create();
  session(old, 'one-0001');                                   // as a hub of 0.1.0 sends it: no workspace name
  const before = scene(old);
  assert.deepEqual(before.view.tileLabels, []);
  assert.ok(before.filled().includes('AGENTS'));
  assert.ok(before.filled().includes('CLAUDE'));
});

test('the model: a session\'s title and workspace name come on its start or in session.info, and change nothing else', () => {
  const model = M.create(), b = base('one-0001');
  model.apply({ ...b, t: 1, ev: 'session.start', title: 'First title', space: 'Example Shop' });
  const agent = model.nodes.get('a:claude:one-0001');
  assert.equal(agent.title, 'First title');
  assert.equal(agent.space, 'Example Shop');
  model.apply({ ...b, t: 2, ev: 'wait.start', why: 'permission', tool: 'Bash' });
  assert.equal(agent.status, 'needs');
  model.takeChanges();
  model.apply({ ...b, t: 3, ev: 'session.info', grade: 'derived', src: 'sessions-file', title: 'Second title' });
  assert.equal(agent.title, 'Second title');
  assert.equal(agent.space, 'Example Shop', 'what an event does not name is left as it was');
  assert.equal(agent.status, 'needs', 'a name is not a state');
  assert.ok(model.takeChanges().ids.has(agent.id), 'the view hears of it');
  model.apply({ ...b, t: 4, ev: 'session.info', grade: 'derived', src: 'sessions-file', title: '' });
  assert.equal(agent.title, '', 'a title can go away');
  const copy = M.load(model.serialize()).nodes.get(agent.id);
  assert.equal(copy.space, 'Example Shop');
  for (const bad of [{ ev: 'session.info' }, { ev: 'session.info', title: 7 }, { ev: 'session.info', space: {} }, { ev: 'session.info', title: 'x'.repeat(M.TITLE_MAX + 1) }, { ev: 'session.start', title: ['a'] }])
    assert.throws(() => M.validate({ ...b, t: 5, ...bad }), /short text|nothing to say/, JSON.stringify(bad));
  // session.info for a session that has ended does not bring it back.
  model.apply({ ...b, t: 6, ev: 'session.end' });
  model.apply({ ...b, t: 7, ev: 'session.info', grade: 'derived', src: 'sessions-file', title: 'Late' });
  assert.equal(model.sessions.get('claude:one-0001').ended, true);
  // A subagent knows its provider, and a snapshot whose title is not a text is refused.
  const other = M.create();
  session(other, 'two-0002', { agent: 'grok' });
  assert.equal(other.nodes.get('s:grok:two-0002:sub1').kind, 'grok');
  const data = JSON.parse(other.serialize());
  data.state.nodes.$map.find(([, n]) => n.cls === 'agent')[1].title = { text: 'x' };
  assert.throws(() => M.load(JSON.stringify(data)), /wrong shape/);
});
