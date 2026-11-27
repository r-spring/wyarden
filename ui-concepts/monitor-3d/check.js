// Monitor 3D mock-up: dependency-free checks. Run: node check.js
// They cover the model, the feed, slot stability, drawing only on change, class separation, captions,
// picking, the keyboard, the list twin and the page's own rules. The view is driven on a stub canvas
// with a virtual clock, so "no frame at rest" is counted, not timed. shoot.js repeats the frame
// counts in a real browser.
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const L = require('./layout.js'), M = require('./model.js'), F = require('./feed.js'), E = require('./engine.js'), N = require('./nav.js');
const LOOKS = { nexus: require('./look-nexus.js'), glasshouse: require('./look-glasshouse.js') };
const preview = require('./serve.js');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
const PAGE_SCRIPTS = ['layout.js', 'model.js', 'feed.js', 'engine.js', 'look-nexus.js', 'look-glasshouse.js', 'nav.js', 'app.js'];
const MESH_KEYS = ['agent', 'subagent', 'tool', 'mcp', 'resource.file', 'resource.url', 'resource.context', 'stack'];

/* ---------- helpers ---------- */

let tick = F.EPOCH;
const ev = (agent, session, name, extra) => Object.assign({ v: 1, t: (tick += 50), agent, session, ws: 'w1', ev: name, grade: 'exact', src: 'check' }, extra);
const feedRuns = new Map();
/** The simulated stream for a while, and a model that has taken all of it. */
function ran(agents, load, seconds, seed) {
  const key = [agents, load, seconds, seed || 7].join(' ');
  if (!feedRuns.has(key)) feedRuns.set(key, F.createSim({ seed: seed || 7, agents, load }).advanceTo(seconds * 1000));
  const model = M.create(), events = feedRuns.get(key);
  for (const e of events) model.apply(e);
  return { model, events };
}
/** Two of everything, written by hand. */
function fixture() {
  const m = M.create(), A = ['claude', 's-aaaa'], B = ['codex', 's-bbbb'];
  const list = [
    ev(...A, 'session.start', { source: 'startup', model: 'x' }), ev(...B, 'session.start', { source: 'startup', model: 'y' }),
    ev(...A, 'turn.start', { turn: 'p-1' }), ev(...B, 'turn.start', { turn: 't-1' }),
    ev(...A, 'tool.start', { call: 'c1', tool: 'Read', class: 'read' }), ev(...A, 'resource.touch', { call: 'c1', kind: 'file', op: 'read', path: 'src/app/router.ts' }), ev(...A, 'tool.end', { call: 'c1', tool: 'Read', ok: true, ms: 40 }),
    ev(...A, 'tool.start', { call: 'c2', tool: 'Edit', class: 'edit' }), ev(...A, 'resource.touch', { call: 'c2', kind: 'file', op: 'write', path: 'docs/guide.md' }), ev(...A, 'tool.end', { call: 'c2', tool: 'Edit', ok: true, ms: 90 }),
    ev(...A, 'tool.start', { call: 'c3', tool: 'WebFetch', class: 'fetch' }), ev(...A, 'resource.touch', { call: 'c3', kind: 'url', op: 'read', url: 'https://docs.example.org/guide/hooks' }), ev(...A, 'tool.end', { call: 'c3', tool: 'WebFetch', ok: true, ms: 900 }),
    ev(...A, 'tool.start', { call: 'c4', tool: 'WebFetch', class: 'fetch' }), ev(...A, 'resource.touch', { call: 'c4', kind: 'url', op: 'read', url: 'https://example.com/status' }), ev(...A, 'tool.end', { call: 'c4', tool: 'WebFetch', ok: true, ms: 700 }),
    ev(...A, 'tool.start', { call: 'c5', tool: 'WebSearch', class: 'fetch' }), ev(...A, 'resource.touch', { call: 'c5', kind: 'search', op: 'search' }), ev(...A, 'tool.end', { call: 'c5', tool: 'WebSearch', ok: true, ms: 800 }),
    ev(...A, 'tool.start', { call: 'c6', tool: 'ReadMcpResourceTool', class: 'mcp' }), ev(...A, 'resource.touch', { call: 'c6', kind: 'mcp-resource', op: 'read', server: 'notes', scheme: 'notes' }), ev(...A, 'tool.end', { call: 'c6', tool: 'ReadMcpResourceTool', ok: true, ms: 100 }),
    ev(...A, 'tool.start', { call: 'c7', tool: 'Agent', class: 'agent' }), ev(...A, 'subagent.start', { sub: 'a-1', type: 'Explore', parentCall: 'c7' }),
    ev(...A, 'subagent.stop', { sub: 'a-1', type: 'Explore', calls: 0, ms: 10 }), ev(...A, 'tool.end', { call: 'c7', tool: 'Agent', ok: true, ms: 10 }),
    ev(...B, 'tool.start', { call: 'd1', tool: 'Bash', class: 'execute' }), ev(...B, 'tool.end', { call: 'd1', tool: 'Bash', ok: true, ms: 300, exit: 0 }),
    ev(...B, 'tool.start', { call: 'd2', tool: 'apply_patch', class: 'edit' }), ev(...B, 'resource.touch', { call: 'd2', kind: 'file', op: 'write', path: 'test/store.test.ts' }), ev(...B, 'tool.end', { call: 'd2', tool: 'apply_patch', ok: true, ms: 60 }),
    ev(...B, 'tool.start', { call: 'd3', tool: 'spawn_agent', class: 'agent' }), ev(...B, 'subagent.start', { sub: 'a-2', type: 'Plan', parentCall: 'd3' })
  ];
  for (const server of ['github', 'tracker']) for (const tool of ['one', 'two', 'three']) {
    const call = 'm-' + server + '-' + tool;
    list.push(ev(...A, 'mcp.start', { call, server, tool, serverSource: 'user' }), ev(...A, 'mcp.end', { call, server, tool, ok: true, ms: 200 }));
  }
  for (const e of list) m.apply(e);
  return m;
}
function stubContext() {
  const ctx = { font: '10px x', strokes: 0, fills: 0, texts: [] };
  for (const name of ['setTransform', 'clearRect', 'fillRect', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'arc', 'ellipse', 'scale', 'setLineDash']) ctx[name] = () => {};
  ctx.stroke = () => { ctx.strokes++; };
  ctx.fill = () => { ctx.fills++; };
  ctx.fillText = (text, x, y) => { ctx.texts.push({ text, x, y }); };
  ctx.measureText = text => ({ width: text.length * parseFloat(/(\d+(?:\.\d+)?)px/.exec(ctx.font)[1]) * .62 });
  return ctx;
}
/** A clock that only moves when told to: timers at 4 ms, a display frame every 16 ms. */
function fakeEnv() {
  const env = { t: 0, rafCalls: 0, rafs: [], timers: [], seq: 0, nextFrame: 16 };
  env.now = () => env.t;
  env.raf = fn => { env.rafCalls++; env.rafs.push(fn); };
  env.setTimeout = (fn, ms) => { const id = ++env.seq; env.timers.push({ id, at: env.t + Math.max(0, ms), fn }); return id; };
  env.clearTimeout = id => { env.timers = env.timers.filter(x => x.id !== id); };
  env.run = ms => {
    const end = env.t + ms;
    while (env.t < end) {
      env.t = Math.min(end, env.t + 4);
      for (;;) {
        const due = env.timers.filter(x => x.at <= env.t).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        env.timers = env.timers.filter(x => x !== due); due.fn();
      }
      if (env.t >= env.nextFrame) { while (env.nextFrame <= env.t) env.nextFrame += 16; const list = env.rafs; env.rafs = []; for (const fn of list) fn(env.t); }
    }
  };
  return env;
}
/** The page without a browser: feed, model and view on a stub canvas and the virtual clock. */
function page(options) {
  const o = Object.assign({ agents: 4, load: 'busy', look: 'nexus', width: 780, height: 650, warm: 0 }, options);
  const env = fakeEnv(), ctx = stubContext(), canvas = { getContext: () => ctx, width: 0, height: 0 };
  const p = { env, ctx, model: o.model || M.create() };
  p.view = new E.View(canvas, { model: p.model, look: LOOKS[o.look], env });
  p.view.setSize(o.width, o.height, 1);
  p.feed = F.create({ seed: 7, agents: o.agents, load: o.load, clock: env });
  p.feed.subscribe(e => { p.model.apply(e); p.view.dataChanged(); });
  if (o.warm) p.feed.warm(o.warm * 1000);
  p.view.resetCamera(o.model ? undefined : Array.from({ length: o.agents }, (_, i) => i));
  env.run(1200);                                       // the first frame, and the traces of calls that ended while warming
  p.frames = () => p.view.redraw.frames;
  p.push = e => { p.model.apply(e); p.view.dataChanged(); };
  return p;
}
const overlapping = boxes => { let n = 0; for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (E.overlap(boxes[i], boxes[j])) n++; return n; };
const standingPositions = model => { const out = new Map(); for (const [id, p] of model.positions(1)) out.set(id, p.join(',')); return out; };
const moved = (before, after) => [...before].filter(([id, p]) => after.has(id) && after.get(id) !== p).length;
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const distance = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));

/* ---------- the model ---------- */

check('model: it takes the vocabulary and rejects anything else with an error', () => {
  assert.equal(M.EVENTS.length, 13);
  const m = M.create();
  assert.throws(() => m.apply(ev('claude', 's', 'task.start', {})), /unknown event/);
  assert.throws(() => m.apply(Object.assign(ev('claude', 's', 'session.start', {}), { v: 2 })), /schema version/);
  assert.throws(() => m.apply(ev('copilot', 's', 'session.start', {})), /unknown agent/);
  assert.throws(() => m.apply(Object.assign(ev('claude', 's', 'session.start', {}), { grade: 'guess' })), /grade/);
  assert.throws(() => m.apply(ev('claude', 's', 'tool.start', { tool: 'Read' })), /call is missing/);
  assert.throws(() => m.apply(ev('claude', 's', 'resource.touch', { kind: 'worktree', op: 'read' })), /unknown kind/);
  assert.equal(m.nodes.size, 0);
});
check('model: an unknown node class is rejected with an error', () => {
  const m = M.create();
  for (const cls of ['workspace', 'orchestrator', 'task', 'worktree', 'check', 'account', 'main', 'remote', 'context'])
    assert.throws(() => m.addNode({ id: 'x-' + cls, cls, col: 0 }), /unknown node class/);
});
check('model: the hand-written fixture has two or more of each class, and the counts match', () => {
  const m = fixture(), counts = m.classCounts(), kinds = { file: 0, url: 0, context: 0 };
  for (const n of m.nodes.values()) if (n.cls === 'resource') kinds[n.kind]++;
  assert.deepEqual({ agent: counts.agent, subagent: counts.subagent, mcp: counts.mcp }, { agent: 2, subagent: 2, mcp: 2 });
  assert.equal(counts.tool, 9);
  assert.deepEqual(kinds, { file: 3, url: 2, context: 2 });
  assert.equal(counts.resource, 7);
});
check('model: after five minutes of twelve busy agents, only the five classes (and stacks) exist', () => {
  const { model } = ran(12, 'busy', 300), seen = new Set([...model.nodes.values()].map(n => n.cls));
  for (const cls of seen) assert.ok(M.CLASSES.includes(cls) || cls === 'stack', cls);
  for (const cls of M.CLASSES) assert.ok(seen.has(cls), 'no ' + cls);
  assert.deepEqual(M.CLASSES, ['agent', 'subagent', 'tool', 'resource', 'mcp']);
});
check('model: a tool call is a link from its start event to its end event', () => {
  const m = M.create();
  m.apply(ev('claude', 's1', 'session.start', {}));
  assert.equal(m.links.size, 0);
  m.apply(ev('claude', 's1', 'tool.start', { call: 'c1', tool: 'Bash', class: 'execute' }));
  assert.deepEqual([...m.links.values()].map(l => [l.kind, l.from, l.to]), [['tool', 'a:claude:s1', 't:claude:s1:Bash']]);
  assert.equal(m.nodes.get('t:claude:s1:Bash').status, 'working');
  m.apply(ev('claude', 's1', 'tool.end', { call: 'c1', tool: 'Bash', ok: true, ms: 12 }));
  assert.equal(m.links.size, 0);
  assert.equal(m.nodes.get('t:claude:s1:Bash').status, 'rest');
  assert.equal(m.takeClosed().length, 1);
});
check('model: a resource touch is a link from the tool, for as long as that call is open', () => {
  const m = M.create();
  m.apply(ev('claude', 's1', 'tool.start', { call: 'c1', tool: 'Edit', class: 'edit' }));
  m.apply(ev('claude', 's1', 'resource.touch', { call: 'c1', kind: 'file', op: 'write', path: 'src/a.ts' }));
  const touch = [...m.links.values()].find(l => l.kind === 'touch');
  assert.deepEqual([touch.from, touch.to, touch.op], ['t:claude:s1:Edit', 'r:claude:s1:file:src/', 'write']);
  m.apply(ev('claude', 's1', 'tool.end', { call: 'c1', tool: 'Edit', ok: true, ms: 5 }));
  assert.equal(m.links.size, 0);
  assert.equal(m.nodes.get('r:claude:s1:file:src/').writes, 1);
});
check('model: a subagent\'s call starts at the subagent; a caller the agent cannot name is marked unclear', () => {
  const m = M.create();
  m.apply(ev('claude', 's1', 'subagent.start', { sub: 'a-9', type: 'Explore' }));
  m.apply(ev('claude', 's1', 'tool.start', { call: 'c1', tool: 'Grep', class: 'search', by: 'a-9' }));
  m.apply(ev('codex', 's2', 'tool.start', { call: 'c2', tool: 'Bash', class: 'execute', by: '?' }));
  assert.equal(m.links.get('c1').from, 's:claude:s1:a-9');
  assert.equal(m.links.get('c2').from, 'a:codex:s2');
  assert.equal(m.links.get('c2').unclear, true);
  assert.equal(m.links.get('c1').unclear, false);
});
check('model: a failed call marks the tool as failed until its next good call', () => {
  const m = M.create();
  m.apply(ev('claude', 's1', 'tool.start', { call: 'c1', tool: 'Bash', class: 'execute' }));
  m.apply(ev('claude', 's1', 'tool.end', { call: 'c1', tool: 'Bash', ok: false, ms: 9, error: 'tool_error' }));
  const tool = m.nodes.get('t:claude:s1:Bash');
  assert.deepEqual([tool.status, tool.failed, tool.lastError], ['failed', 1, 'tool_error']);
  m.apply(ev('claude', 's1', 'tool.start', { call: 'c2', tool: 'Bash', class: 'execute' }));
  m.apply(ev('claude', 's1', 'tool.end', { call: 'c2', tool: 'Bash', ok: true, ms: 9 }));
  assert.equal(tool.status, 'rest');
});
check('model: an agent\'s state follows turn, wait and session events', () => {
  const m = M.create(), s = ['claude', 's1'], state = () => m.nodes.get('a:claude:s1').status;
  m.apply(ev(...s, 'session.start', {})); assert.equal(state(), 'idle');
  m.apply(ev(...s, 'turn.start', { turn: 'p-1' })); assert.equal(state(), 'working');
  m.apply(ev(...s, 'wait.start', { why: 'permission', tool: 'Bash' })); assert.equal(state(), 'needs');
  m.apply(ev(...s, 'wait.end', { why: 'permission', answer: 'allowed' })); assert.equal(state(), 'working');
  m.apply(ev(...s, 'turn.end', { outcome: 'failed' })); assert.equal(state(), 'failed');
  m.apply(ev(...s, 'wait.start', { why: 'idle' })); assert.equal(state(), 'failed');
  m.apply(ev(...s, 'turn.start', { turn: 'p-2' })); m.apply(ev(...s, 'turn.end', { outcome: 'interrupted' })); assert.equal(state(), 'unclear');
  m.apply(ev(...s, 'turn.start', { turn: 'p-3' })); m.apply(ev(...s, 'turn.end', { outcome: 'done', asks: true })); assert.equal(state(), 'needs');
  m.apply(ev(...s, 'session.end', { reason: 'other' })); assert.equal(state(), 'done');
});
check('model: a session first seen in mid-flight gets an agent marked unclear, not a guess', () => {
  const m = M.create();
  m.apply(ev('grok', 's9', 'tool.start', { call: 'c1', tool: 'grep', class: 'search' }));
  assert.equal(m.nodes.get('a:grok:s9').status, 'unclear');
});
check('MCP: two servers with three tools each are two nodes and six ports', () => {
  const m = fixture(), servers = [...m.nodes.values()].filter(n => n.cls === 'mcp');
  assert.equal(servers.length, 2);
  assert.equal(servers.reduce((sum, n) => sum + n.ports.size, 0), 6);
  assert.equal([...m.nodes.values()].filter(n => n.cls === 'tool' && /one|two|three/.test(n.label)).length, 0);
});
check('MCP: a call lights its own port on its own server, and is a link while it is open', () => {
  const m = fixture(), open = m.links.size;
  m.apply(ev('claude', 's-aaaa', 'mcp.start', { call: 'x1', server: 'github', tool: 'two' }));
  const github = m.nodes.get('m:github'), tracker = m.nodes.get('m:tracker');
  assert.deepEqual([...github.ports.values()].map(p => p.open), [0, 1, 0]);
  assert.deepEqual([...tracker.ports.values()].map(p => p.open), [0, 0, 0]);
  assert.deepEqual([m.links.get('x1').kind, m.links.get('x1').to, m.links.get('x1').port], ['mcp', 'm:github', 'two']);
  assert.equal(m.links.size, open + 1);
  m.apply(ev('claude', 's-aaaa', 'mcp.end', { call: 'x1', server: 'github', tool: 'two', ok: true, ms: 1 }));
  assert.equal(m.links.size, open);
  assert.deepEqual([...github.ports.values()].map(p => p.open), [0, 0, 0]);
});
check('MCP: servers stand in the boundary dock and nowhere else; nothing else stands there', () => {
  const { model } = ran(12, 'busy', 300);
  for (const n of model.nodes.values()) {
    if (n.cls === 'mcp' || (n.cls === 'stack' && n.of === 'mcp')) assert.deepEqual([n.col, n.floor], [L.DOCK, 'mcp']);
    else assert.ok(n.col >= 0 && n.floor !== 'mcp', n.id);
  }
});
check('resources: files are grouped by folder, URLs by host, context items stand alone', () => {
  const m = M.create(), s = ['claude', 's1'];
  for (const p of ['src/a.ts', 'src/b.ts', 'src/deep/c.ts', 'package.json']) m.apply(ev(...s, 'resource.touch', { kind: 'file', op: 'read', path: p }));
  m.apply(ev(...s, 'resource.touch', { kind: 'dir', op: 'search', path: 'src' }));
  for (const u of ['https://docs.example.org/a', 'https://docs.example.org/b?token=1#x', 'https://example.com/']) m.apply(ev(...s, 'resource.touch', { kind: 'url', op: 'read', url: u }));
  m.apply(ev(...s, 'resource.touch', { kind: 'search', op: 'search' }));
  m.apply(ev(...s, 'resource.touch', { kind: 'file', op: 'read', path: { outside: true, name: 'notes.txt' } }));
  const labels = [...m.nodes.values()].filter(n => n.cls === 'resource').map(n => n.kind + ' ' + n.label).sort();
  assert.deepEqual(labels, ['context web search', 'file notes.txt (outside the workspace)', 'file package.json', 'file src/ (2 files)', 'file src/deep/c.ts', 'url docs.example.org (2 pages)', 'url example.com']);
  assert.equal(m.nodes.get('r:claude:s1:file:src/').searches, 1);
});
check('resources: read and write are counted apart, for the group and for each file', () => {
  const m = M.create(), s = ['claude', 's1'];
  for (const op of ['read', 'read', 'write', 'read']) m.apply(ev(...s, 'resource.touch', { kind: 'file', op, path: 'src/a.ts' }));
  m.apply(ev(...s, 'resource.touch', { kind: 'file', op: 'write', path: 'src/b.ts' }));
  const n = m.nodes.get('r:claude:s1:file:src/');
  assert.deepEqual([n.reads, n.writes, n.touches], [3, 2, 5]);
  assert.deepEqual([n.members.get('a.ts').reads, n.members.get('a.ts').writes, n.members.get('b.ts').writes], [3, 1, 1]);
});
check('resources: 500 file events leave at most the cap and one stack, and the stack\'s count is exact', () => {
  const m = M.create(), s = ['claude', 's1'];
  for (let i = 0; i < 500; i++) m.apply(ev(...s, 'resource.touch', { kind: 'file', op: 'read', path: 'dir' + i + '/file.ts' }));
  const standing = m.standing().filter(n => n.floor === 'resource'), stack = m.nodes.get(m.stackId(0, 'resource'));
  assert.equal(standing.filter(n => n.cls === 'resource').length, 8);
  assert.equal(standing.length, 9);
  assert.equal(stack.count, 492);
  assert.equal(stack.label, '+492');
});
check('resources: the same holds for 500 events on 40 folders, and nothing is lost', () => {
  const m = M.create(), s = ['claude', 's1'];
  for (let i = 0; i < 500; i++) m.apply(ev(...s, 'resource.touch', { kind: 'file', op: i % 3 ? 'read' : 'write', path: 'dir' + (i * 7 % 40) + '/f' + (i % 5) + '.ts' }));
  const all = [...m.nodes.values()].filter(n => n.cls === 'resource'), stack = m.nodes.get(m.stackId(0, 'resource'));
  assert.equal(all.length, 40);
  assert.equal(all.filter(n => !n.folded).length, 8);
  assert.equal(stack.count, 32);
  assert.equal(all.reduce((sum, n) => sum + n.touches, 0), 500);
});
check('resources: a resource grows with its touch count, and never past its slot', () => {
  const p = page({ agents: 1 }), s = ['claude', 's1'];
  let last = 0;
  for (let i = 0; i < 400; i++) {
    p.model.apply(ev(...s, 'resource.touch', { kind: 'file', op: 'read', path: 'src/a.ts' }));
    const size = p.view.visual(p.model.nodes.get('r:claude:s1:file:src/')).size;
    assert.ok(size >= last && size <= 1 + E.MAX_GROWTH); last = size;
  }
  assert.equal(last, 1 + E.MAX_GROWTH);
  for (const look of Object.values(LOOKS)) for (const key of MESH_KEYS.filter(k => k.startsWith('resource'))) {
    const reach = Math.max(...look.mesh(key).vertices.map(v => Math.max(Math.abs(v[0]), Math.abs(v[2])))) * (1 + E.MAX_GROWTH);
    assert.ok(reach <= L.SLOT_PITCH / 2, look.id + ' ' + key + ' reaches ' + reach);
  }
});
check('stacks: idle items fold under pressure, the busy ones stay, and a folded item that is used again comes back', () => {
  const m = M.create(), s = ['claude', 's1'];
  for (let i = 0; i < 8; i++) m.apply(ev(...s, 'tool.start', { call: 'c' + i, tool: 'T' + i }));
  for (let i = 1; i < 8; i++) m.apply(ev(...s, 'tool.end', { call: 'c' + i, tool: 'T' + i, ok: true }));
  m.apply(ev(...s, 'tool.start', { call: 'c8', tool: 'T8' }));                 // nine tools, eight slots: the idle one quiet longest folds
  assert.equal(m.nodes.get('t:claude:s1:T1').folded, true);
  assert.equal(m.nodes.get('t:claude:s1:T0').folded, false);                  // still in a call
  assert.equal(m.visibleId('t:claude:s1:T1'), m.stackId(0, 'tool'));
  tick += M.STALE_MS + 1000;
  m.apply(ev(...s, 'tool.start', { call: 'c9', tool: 'T1' }));                 // used again, and another has been idle long enough
  assert.equal(m.nodes.get('t:claude:s1:T1').folded, false);
  assert.equal(m.nodes.get(m.stackId(0, 'tool')).count, 1);
});
check('states: each has its own shape and name, and none borrows a class colour', () => {
  const shapes = Object.values(M.STATES).map(s => s.shape).filter(Boolean), names = Object.values(M.STATES).map(s => s.name);
  assert.equal(new Set(shapes).size, shapes.length);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(shapes, ['pyramid', 'cross', 'globe', 'diamond', 'hourglass', 'dot']);
  for (const look of Object.values(LOOKS)) for (const key of Object.keys(M.STATES)) if (M.STATES[key].shape) {
    assert.match(look.palette.state[key], /^#[0-9a-f]{6}$/);
    assert.ok(!Object.values(look.palette.cls).includes(look.palette.state[key]), look.id + ' ' + key);
  }
});
check('states: a change of state changes the mark and nothing else (mesh and colour stay the class\'s)', () => {
  for (const lookId of Object.keys(LOOKS)) {
    const p = page({ model: fixture(), look: lookId });
    for (const n of p.model.standing()) {
      const first = p.view.visual(n), was = n.status, marks = new Set();
      for (const status of Object.keys(M.STATES)) {
        n.status = status;
        const v = p.view.visual(n);
        assert.deepEqual([v.mesh, v.color, v.size], [first.mesh, first.color, first.size], n.id + ' ' + status);
        marks.add(v.badge);
      }
      assert.equal(marks.size, 7);
      n.status = was;
    }
  }
});

/* ---------- the feed ---------- */

check('feed: every event is in the vocabulary, with its envelope and required fields', () => {
  const { events } = ran(12, 'busy', 300), seen = new Set();
  for (const e of events) {
    M.validate(e); seen.add(e.ev);
    for (const key of ['v', 't', 'agent', 'session', 'ws', 'ev', 'grade', 'src']) assert.ok(e[key] !== undefined && e[key] !== '', e.ev + ' has no ' + key);
    assert.match(e.src, /^(hook|args):/);
    if (e.ev === 'tool.start') assert.ok(['read', 'edit', 'search', 'execute', 'fetch', 'agent', 'ask', 'mcp', 'other'].includes(e.class), e.class);
    if (e.ev === 'tool.end' || e.ev === 'mcp.end') { assert.ok(Number.isFinite(e.ms)); assert.ok(['exact', 'derived'].includes(e.msGrade)); if (!e.ok) assert.ok(['tool_error', 'denied', 'interrupted', 'timeout'].includes(e.error)); }
    if (e.ev === 'wait.end') assert.ok(['allowed', 'refused', 'answered', 'unknown'].includes(e.answer));
  }
  assert.deepEqual([...seen].sort(), M.EVENTS.slice().sort());
});
check('feed: the events keep to the privacy rule (no absolute path, query string, command or message text)', () => {
  const { events } = ran(12, 'busy', 300), allowed = new Set(['v', 't', 'at', 'agent', 'session', 'turn', 'by', 'ws', 'ev', 'grade', 'src', 'source', 'model', 'reason', 'chars', 'outcome', 'asks', 'call', 'tool', 'class', 'hash', 'ok', 'ms', 'msGrade', 'error', 'interrupted', 'exit', 'kind', 'op', 'path', 'url', 'server', 'scheme', 'serverSource', 'sub', 'type', 'parentCall', 'calls', 'why', 'answer']);
  for (const e of events) {
    for (const key of Object.keys(e)) assert.ok(allowed.has(key), 'field ' + key);
    if (typeof e.path === 'string') assert.ok(!/^([A-Za-z]:|\/|~|\.\.)/.test(e.path) && !e.path.includes('\\'), e.path);
    if (e.url) assert.ok(!/[?#@]/.test(e.url) && /^https:\/\/([a-z]+\.)?example\.(com|org|net)\//.test(e.url), e.url);
    assert.ok(/^w\d$/.test(e.ws));
  }
});
check('feed: the same seed gives the same stream, another seed another', () => {
  const a = JSON.stringify(F.createSim({ seed: 3, agents: 4, load: 'busy' }).advanceTo(60000));
  assert.equal(a, JSON.stringify(F.createSim({ seed: 3, agents: 4, load: 'busy' }).advanceTo(60000)));
  assert.notEqual(a, JSON.stringify(F.createSim({ seed: 4, agents: 4, load: 'busy' }).advanceTo(60000)));
});
check('feed: presets for 1, 4 and 12 agents, and busy is busier than quiet', () => {
  assert.deepEqual(F.PRESETS.agents, [1, 4, 12]);
  assert.deepEqual(F.PRESETS.load, ['quiet', 'busy']);
  for (const agents of F.PRESETS.agents) {
    const sessions = new Set(ran(agents, 'busy', 30).events.map(e => e.session));
    assert.equal(sessions.size, agents);
    assert.ok(ran(agents, 'busy', 300).events.length > 2.5 * ran(agents, 'quiet', 300).events.length);
  }
});
check('feed: what an agent cannot report is not invented', () => {
  const { events } = ran(12, 'busy', 600), of = agent => events.filter(e => e.agent === agent);
  assert.ok(of('codex').every(e => !/PostToolUseFailure/.test(e.src)), 'Codex has no failure event');
  assert.ok(of('codex').every(e => e.ev !== 'tool.start' || !['read', 'search', 'fetch'].includes(e.class)), 'Codex reads through the shell');
  assert.ok(of('antigravity').every(e => e.ev !== 'session.end'), 'Antigravity has no session end');
  assert.ok(events.filter(e => e.by).every(e => (e.agent === 'codex' || e.agent === 'antigravity') === (e.by === '?')), 'Codex and Antigravity do not name the subagent');
  assert.ok(events.filter(e => e.ev === 'tool.start' && e.class === 'execute').every(e => !events.some(t => t.ev === 'resource.touch' && t.call === e.call && t.session === e.session)), 'a shell call names no resource');
  assert.ok(events.filter(e => e.ev === 'mcp.start').every(e => (e.agent === 'claude') === (e.grade === 'exact')));
});
check('feed: subscribe(onEvent) is the only way out; pause stops it; speed scales it', () => {
  const env = fakeEnv(), feed = F.create({ seed: 7, agents: 4, load: 'busy', clock: env }), got = [];
  const stop = feed.subscribe(e => got.push(e));
  env.run(5000); assert.equal(got.length, 0);                    // not started
  feed.start(); env.run(20000);
  const atOne = got.length; assert.ok(atOne > 30);
  feed.pause(); env.run(20000); assert.equal(got.length, atOne);
  assert.equal(env.timers.length, 0);                            // a paused feed leaves no timer behind
  feed.setSpeed(4); feed.start(); env.run(5000);
  assert.ok(Math.abs(feed.simTime() - 40000) < 200, 'simulated time ' + feed.simTime());
  const before = got.length; stop(); env.run(5000); assert.equal(got.length, before);
  assert.deepEqual(Object.keys(feed).filter(k => /event|emit|push/i.test(k)), []);
});
check('feed: a quiet feed sleeps until its next event instead of ticking', () => {
  const env = fakeEnv(), feed = F.create({ seed: 7, agents: 1, load: 'quiet', clock: env });
  let events = 0, wakes = 0;
  feed.subscribe(() => events++);
  const set = env.setTimeout; env.setTimeout = (fn, ms) => { wakes++; return set(fn, ms); };
  feed.start(); env.run(120000);
  assert.ok(events > 5 && wakes <= events + 2, wakes + ' wake-ups for ' + events + ' events');
});
check('updates are incremental: 10,000 events at well under 1 ms each', () => {
  const events = F.createSim({ seed: 11, agents: 12, load: 'busy' }).advanceTo(900000).slice(0, 10000), m = M.create();
  assert.equal(events.length, 10000);
  const start = process.hrtime.bigint();
  for (const e of events) m.apply(e);
  const each = Number(process.hrtime.bigint() - start) / 1e6 / events.length;
  assert.ok(each < .25, each.toFixed(4) + ' ms an event');
});
check('history is bounded: after an hour of twelve busy agents nothing has grown past its cap', () => {
  const { model } = ran(12, 'busy', 3600);
  for (const s of model.sessions.values()) assert.ok(s.history.length <= M.HISTORY);
  assert.ok(model.closed.length <= 64 && model.arcs.size <= M.ARC_CAP);
  assert.ok(model.standing().length <= 12 * 27 + 9);
  for (const n of model.nodes.values()) if (n.cls === 'resource') assert.ok(n.members.size <= M.MEMBER_CAP);
  for (const cell of model.cells.values()) assert.ok(cell.folded.length <= M.STACK_CAP);
});

/* ---------- slots, floors and columns ---------- */

check('slots: one node more (in the middle of the data, or at the end) moves no existing node', () => {
  const m = fixture(), before = standingPositions(m);
  m.apply(ev('claude', 's-aaaa', 'tool.start', { call: 'n1', tool: 'Aardvark', class: 'other' }));      // sorts before every other tool
  m.apply(ev('claude', 's-aaaa', 'resource.touch', { kind: 'file', op: 'read', path: 'aaa/first.ts' }));
  m.apply(ev('claude', 's-aaaa', 'subagent.start', { sub: 'a-0', type: 'Plan' }));
  m.apply(ev('grok', 's-cccc', 'session.start', {}));
  const after = standingPositions(m);
  assert.equal(after.size, before.size + 4);
  assert.equal(moved(before, after), 0);
  assert.ok([...before.keys()].every(id => after.has(id)));
});
check('slots: ten more nodes move no existing node', () => {
  const m = fixture(), before = standingPositions(m);
  for (let i = 0; i < 10; i++) m.apply(ev('codex', 's-bbbb', 'resource.touch', { kind: 'file', op: 'read', path: 'pkg' + i + '/x.ts' }));
  for (let i = 0; i < 10; i++) m.apply(ev('claude', 's-' + i, 'session.start', {}));
  assert.equal(moved(before, standingPositions(m)), 0);
});
check('slots: a node that leaves moves no other and leaves a gap; the next arrival takes the gap', () => {
  const m = fixture(), gone = m.nodes.get('t:claude:s-aaaa:Edit'), slot = gone.slot, before = standingPositions(m);
  m.removeNode(gone);
  const after = standingPositions(m);
  assert.equal(after.size, before.size - 1);
  assert.equal(moved(before, after), 0);
  assert.equal(m.cell(0, 'tool').slots[slot], null);
  m.apply(ev('claude', 's-aaaa', 'tool.start', { call: 'n2', tool: 'Glob', class: 'search' }));
  assert.equal(m.nodes.get('t:claude:s-aaaa:Glob').slot, slot);
  assert.equal(moved(before, standingPositions(m)), 0);
});
check('slots: a session that ends keeps its column, and the columns beside it do not move', () => {
  const { model } = ran(4, 'busy', 60), before = standingPositions(model), first = model.sessions.get(model.columns[1]);
  model.apply(ev(first.kind, first.session, 'session.end', { reason: 'other' }));
  assert.equal(moved(before, standingPositions(model)), 0);
  assert.equal(model.columns[1], first.key);
  model.removeSession(first);
  assert.equal(model.columns[1], null);
  assert.equal(moved(before, standingPositions(model)), 0);
  model.apply(ev('grok', 's-new', 'session.start', {}));
  assert.equal(model.nodes.get('a:grok:s-new').col, 1);
});
check('slots: time passing moves nothing', () => {
  const m = fixture(), before = standingPositions(m);
  tick += 3600 * 1000;
  m.apply(ev('claude', 's-aaaa', 'turn.end', { outcome: 'done' }));
  assert.equal(moved(before, standingPositions(m)), 0);
  assert.ok(!/Date\.now|performance\.now|\.now\(/.test(read('layout.js')), 'the layout reads no clock');
});
check('slots: over ten minutes of twelve busy agents, no standing node ever moves', () => {
  const m = M.create(), where = new Map();
  let movedCount = 0, compared = 0;
  for (const e of ran(12, 'busy', 600).events) {
    m.apply(e);
    for (const id of m.changed) {
      const n = m.nodes.get(id);
      if (!n || n.folded) { where.delete(id); continue; }
      const p = L.position(n, 1).join(',');
      if (where.has(id)) { compared++; if (where.get(id) !== p) movedCount++; }
      where.set(id, p);
    }
    m.changed.clear();
  }
  assert.ok(compared > 5000);
  assert.equal(movedCount, 0);
});
check('slots: Tidy, and only Tidy, closes the gaps', () => {
  const { model } = ran(12, 'busy', 300);
  const ended = [...model.sessions.values()].slice(2, 5);
  for (const s of ended) model.apply(ev(s.kind, s.session, 'session.end', { reason: 'other' }));
  for (const s of ended.slice(0, 1)) model.removeSession(s);
  assert.ok(model.columns.includes(null));
  const standingBefore = model.standing().filter(n => n.cls !== 'stack').length, all = new Set(model.nodes.keys());
  model.tidy();
  assert.deepEqual(model.columnsInUse(), Array.from({ length: 9 }, (_, i) => i));
  for (const cell of model.cells.values()) {
    const slots = L.slotsFor(cell.floor === 'agent' ? 'subagent' : cell.floor), used = slots.map(s => cell.slots[s] != null);
    assert.ok(used.indexOf(false) < 0 || used.lastIndexOf(true) < used.indexOf(false), 'a gap is left in ' + cell.col + '|' + cell.floor);
    if (cell.folded.length) assert.ok(used.every(Boolean), 'a stack beside a free slot');
  }
  for (const n of model.nodes.values()) { assert.ok(all.has(n.id) || n.cls === 'stack'); if (!n.folded) assert.equal(model.cell(n.col, n.floor).slots[n.slot], n.id); }
  assert.ok(model.standing().filter(n => n.cls !== 'stack').length <= standingBefore);
});
check('floors: y comes from the class alone; agents on top, then MCP servers, tools, resources', () => {
  const { model } = ran(12, 'busy', 300);
  for (const spread of [1, L.SPREAD]) for (const n of model.standing()) assert.equal(L.position(n, spread)[1], L.floorY(L.FLOOR_OF[n.cls === 'stack' ? n.of : n.cls], spread));
  assert.ok(L.floorY('agent') > L.floorY('mcp') && L.floorY('mcp') > L.floorY('tool') && L.floorY('tool') > L.floorY('resource'));
  assert.equal(L.FLOOR_OF.subagent, 'agent');
});
check('floors: a hundred more nodes of one class change no floor height', () => {
  const m = fixture(), heights = () => L.FLOORS.map(f => L.floorY(f, 1)).join(), before = heights(), ys = new Set();
  for (let i = 0; i < 100; i++) m.apply(ev('claude', 's-aaaa', 'tool.start', { call: 'h' + i, tool: 'Tool' + i }));
  for (const n of m.standing()) if (n.floor === 'tool') ys.add(L.position(n, 1)[1]);
  assert.equal(heights(), before);
  assert.deepEqual([...ys], [L.floorY('tool', 1)]);
});
check('columns: 1, 4, 9 and 12 agents stand in columns that do not overlap, and the dock overlaps none', () => {
  for (const count of [1, 4, 9, 12]) {
    const m = M.create();
    for (let i = 0; i < count; i++) m.apply(ev(M.AGENT_KINDS[i % 4], 's-' + i, 'session.start', {}));
    const cols = [L.DOCK].concat(m.columnsInUse());
    assert.equal(cols.length, count + 1);
    for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) {
      const a = L.columnOrigin(cols[i]), b = L.columnOrigin(cols[j]);
      assert.ok(Math.abs(a[0] - b[0]) >= L.CELL || Math.abs(a[1] - b[1]) >= L.CELL, cols[i] + ' and ' + cols[j]);
    }
  }
});
check('columns: they come from the data, in order of first appearance, for any agent', () => {
  const m = M.create();
  ['antigravity', 'antigravity', 'grok', 'claude'].forEach((kind, i) => m.apply(ev(kind, 's-' + i, 'session.start', {})));
  assert.deepEqual(m.columns, ['antigravity:s-0', 'antigravity:s-1', 'grok:s-2', 'claude:s-3']);
  for (const file of ['layout.js', 'engine.js', 'look-nexus.js', 'look-glasshouse.js', 'nav.js'])
    assert.ok(!/claude|codex|grok|antigravity|provider/i.test(read(file)), file + ' names an agent');
});
check('columns: a thirteenth live session is counted as left out, and takes a column when one ends', () => {
  const m = M.create();
  for (let i = 0; i < 13; i++) m.apply(ev('claude', 's-' + i, 'session.start', {}));
  assert.equal(m.columnsInUse().length, 12);
  assert.equal(m.overflow.size, 1);
  m.apply(ev('claude', 's-12', 'turn.start', {}));
  assert.equal(m.leftOut.events, 2);
  m.apply(ev('claude', 's-3', 'session.end', { reason: 'other' }));
  m.apply(ev('claude', 's-12', 'tool.start', { call: 'c', tool: 'Read' }));
  assert.equal(m.overflow.size, 0);
  assert.equal(m.nodes.get('a:claude:s-12').col, 3);
});
check('looks: switching the look leaves every node where it was', () => {
  const model = ran(12, 'busy', 300).model, a = page({ model, look: 'nexus' }), b = page({ model, look: 'glasshouse' });
  b.view.camera = JSON.parse(JSON.stringify(a.view.camera));
  a.view.draw(); b.view.draw();
  const at = view => new Map(view.hit.map(h => [h.id, h.base.join(',')]));
  assert.ok(a.view.hit.length > 150);
  assert.deepEqual([...at(a.view)].sort(), [...at(b.view)].sort());
  a.view.setLook(LOOKS.glasshouse); a.env.run(100);
  assert.deepEqual([...at(a.view)].sort(), [...at(b.view)].sort());
});
check('looks: a look is palette, meshes and caption style, and has no say in the layout', () => {
  for (const look of Object.values(LOOKS)) {
    assert.deepEqual(Object.keys(look).sort(), ['caption', 'font', 'glow', 'id', 'lineWidth', 'mesh', 'name', 'palette', 'theme']);
    for (const key of MESH_KEYS) {
      const mesh = look.mesh(key);
      assert.ok(mesh.vertices.length >= 4 && mesh.lines.length >= 4);
      for (const v of mesh.vertices) { assert.ok(v.every(Number.isFinite)); assert.ok(v[1] >= 0, key + ' goes below its floor'); assert.ok(Math.hypot(v[0], v[2]) <= L.SLOT_PITCH / 2, key + ' is wider than its slot'); }
      for (const [i, j] of mesh.lines) assert.ok(mesh.vertices[i] && mesh.vertices[j]);
    }
    assert.throws(() => look.mesh('worktree'));
  }
  assert.ok(!/position|columnOrigin|slotOffset|MonitorLayout|layout\.js/.test(read('look-nexus.js') + read('look-glasshouse.js')));
});
check('separate floors: on and then off again restores every position exactly', () => {
  const { model } = ran(12, 'busy', 300), before = JSON.stringify([...model.positions(1)]);
  const apart = model.positions(L.SPREAD);
  assert.ok([...apart.values()].some(p => p[1] > L.floorY('agent', 1)));
  for (const [id, p] of apart) { const flat = model.positions(1).get(id); assert.deepEqual([p[0], p[2]], [flat[0], flat[2]]); }
  assert.equal(JSON.stringify([...model.positions(1)]), before);
});
check('coordinates are finite for every preset, look, size and camera', () => {
  let points = 0;
  for (const agents of [1, 4, 12]) for (const look of Object.keys(LOOKS)) for (const [w, h] of [[780, 650], [556, 520], [1, 1]]) {
    const p = page({ model: ran(agents, 'busy', 120).model, look, width: w, height: h });
    for (const camera of [null, { yaw: 3, pitch: 1.5, distance: 260 }, { yaw: -2, pitch: -.1, distance: 14000 }]) {
      if (camera) Object.assign(p.view.camera, camera);
      p.view.draw();
      for (const hit of p.view.hit) { points++; assert.ok([hit.x, hit.y, hit.depth, ...hit.base].every(Number.isFinite)); for (const q of hit.hull) assert.ok(Number.isFinite(q.x) && Number.isFinite(q.y)); }
      for (const box of p.view.labels) assert.ok([box.x, box.y, box.w, box.h].every(Number.isFinite));
      assert.ok(Object.values(p.view.camera).flat().every(Number.isFinite));
    }
  }
  assert.ok(points > 1000);
});

/* ---------- drawing only on change ---------- */

check('at rest nothing is drawn: no frame, and no animation frame is even asked for', () => {
  const p = page({ agents: 12, warm: 120 });
  assert.ok(p.view.hit.length > 100);
  const frames = p.frames(), asked = p.env.rafCalls, strokes = p.ctx.strokes;
  p.env.run(3000);
  assert.deepEqual([p.frames() - frames, p.env.rafCalls - asked, p.ctx.strokes - strokes, p.env.timers.length], [0, 0, 0, 0]);
});
check('one event is one frame; an ended call adds one more when its trace fades, then nothing', () => {
  const p = page({ agents: 1 });
  let frames = p.frames();
  p.push(ev('claude', 's1', 'tool.start', { call: 'c1', tool: 'Bash', class: 'execute' }));
  p.env.run(2000); assert.equal(p.frames() - frames, 1); frames = p.frames();
  p.push(ev('claude', 's1', 'tool.end', { call: 'c1', tool: 'Bash', ok: true, ms: 2000 }));
  p.env.run(300); assert.equal(p.frames() - frames, 1);
  assert.equal(p.view.afterglow.length, 1);
  p.env.run(1000); assert.equal(p.frames() - frames, 2);
  assert.equal(p.view.afterglow.length, 0);
  p.env.run(5000); assert.equal(p.frames() - frames, 2);
});
check('a burst of 500 events in one second is drawn in batches: at most 10 frames', () => {
  const p = page({ agents: 1 }), frames = p.frames();
  for (let i = 0; i < 500; i++) { p.push(ev('claude', 's1', 'resource.touch', { kind: 'file', op: 'read', path: 'src/f' + (i % 9) + '.ts' })); p.env.run(2); }
  const during = p.frames() - frames;
  assert.ok(during >= 8 && during <= 10, during + ' frames');
  p.env.run(3000);
  assert.ok(p.frames() - frames <= 11);
});
check('twelve busy agents for twenty seconds: at most 10 frames a second, and none once the feed is paused', () => {
  const p = page({ agents: 12, warm: 60 }), frames = p.frames(), events = p.model.counts.events, camera = JSON.stringify(p.view.camera);
  p.feed.start(); p.env.run(20000);
  const drawn = p.frames() - frames;
  assert.ok(p.model.counts.events - events > 150);
  assert.ok(drawn > 40 && drawn <= 200, drawn + ' frames in 20 s');
  assert.equal(JSON.stringify(p.view.camera), camera, 'live data moved the camera');
  p.feed.pause(); p.env.run(1500);
  const rest = p.frames(), asked = p.env.rafCalls;
  p.env.run(5000);
  assert.deepEqual([p.frames() - rest, p.env.rafCalls - asked], [0, 0]);
});
check('camera input: one frame for each input, several inputs in one display frame are one frame, none after', () => {
  const p = page({ agents: 4, warm: 60 });
  let frames = p.frames();
  for (let i = 0; i < 5; i++) { p.view.orbit(.05, 0); p.env.run(16); }
  assert.equal(p.frames() - frames, 5); frames = p.frames();
  p.view.orbit(.05, 0); p.view.zoom(.9); p.view.pan(4, 4); p.env.run(16);
  assert.equal(p.frames() - frames, 1); frames = p.frames();
  p.view.setSelected(p.view.hit[0].id); p.view.setSelected(p.view.hit[0].id); p.env.run(16);
  assert.equal(p.frames() - frames, 1);
  p.env.run(3000); assert.equal(p.frames() - frames, 1);
});
check('live data never moves the camera, and neither does a node that stands far away', () => {
  const p = page({ agents: 1 }), camera = JSON.stringify(p.view.camera);
  for (let i = 0; i < 12; i++) p.push(ev('codex', 's-' + i, 'session.start', {}));
  for (let i = 0; i < 100; i++) p.push(ev('codex', 's-11', 'resource.touch', { kind: 'file', op: 'write', path: 'd' + i + '/x.ts' }));
  p.env.run(2000);
  assert.equal(JSON.stringify(p.view.camera), camera);
  assert.ok(p.view.stats.offscreen > 0, 'the far columns are reported as off screen, not chased');
});
check('no frame loop in the source: requestAnimationFrame once, inside the scheduler; no setInterval anywhere', () => {
  for (const file of PAGE_SCRIPTS) {
    const text = read(file);
    assert.ok(!/setInterval/.test(text), file + ' uses setInterval');
    assert.equal((text.match(/requestAnimationFrame/g) || []).length, file === 'engine.js' ? 1 : 0, file);
  }
  assert.match(read('engine.js'), /this\.raf = env\.raf \|\| \(fn => root\.requestAnimationFrame\(fn\)\)/);
});
check('decorative motion is off by default: a new call draws no pulse and asks for no extra frame', () => {
  const p = page({ agents: 1 });
  assert.equal(p.view.motion, false);
  const frames = p.frames();
  p.push(ev('claude', 's1', 'tool.start', { call: 'c1', tool: 'Bash', class: 'execute' }));
  p.env.run(2000);
  assert.equal(p.frames() - frames, 1);
  assert.equal(p.view.redraw.byReason.motion, undefined);
  assert.equal(p.view.pulses.size, 0);
  assert.match(read('app.js'), /aria-pressed="false">Motion off|Motion off/);
});
check('motion, when the owner turns it on, runs only while a call\'s pulse travels, then stops', () => {
  const p = page({ agents: 1 });
  p.view.setMotion(true); p.env.run(100);
  const frames = p.frames();
  p.push(ev('claude', 's1', 'tool.start', { call: 'c1', tool: 'Bash', class: 'execute' }));
  p.env.run(E.GLOW_MS + 200);
  const during = p.frames() - frames;
  assert.ok(during >= 20 && during <= 45, during + ' frames');
  p.env.run(4000);
  assert.ok(p.frames() - frames - during <= 1);
});
check('frame cost: building a frame of 200 or more nodes stays far under the 8 ms budget (stub canvas)', () => {
  const p = page({ model: ran(12, 'busy', 900).model });
  assert.ok(p.view.hit.length >= 200, p.view.hit.length + ' nodes');
  const times = [];
  for (let i = 0; i < 25; i++) { const start = process.hrtime.bigint(); p.view.draw(); times.push(Number(process.hrtime.bigint() - start) / 1e6); }
  times.sort((a, b) => a - b);
  assert.ok(times[12] < 8, 'median ' + times[12].toFixed(2) + ' ms');
});

/* ---------- class separation, captions, picking ---------- */

check('classes: five classes, five silhouettes and five colours in each look', () => {
  for (const look of Object.values(LOOKS)) {
    const signature = key => { const mesh = look.mesh(key), max = i => Math.max(...mesh.vertices.map(v => v[i])), min = i => Math.min(...mesh.vertices.map(v => v[i])); return [mesh.vertices.length, mesh.lines.length, max(0) - min(0), max(1), max(2) - min(2)].map(v => Math.round(v)).join('/'); };
    assert.equal(new Set(MESH_KEYS.map(signature)).size, MESH_KEYS.length, look.id + ': two classes share a mesh');
    const colors = M.CLASSES.map(cls => look.palette.cls[cls]);
    assert.equal(new Set(colors).size, 5);
    for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) assert.ok(distance(colors[i], colors[j]) >= 60, look.id + ': ' + M.CLASSES[i] + ' and ' + M.CLASSES[j] + ' are too close in colour');
    for (const color of colors) assert.ok(distance(color, look.palette.bg) >= 120, look.id + ': ' + color + ' is faint on the background');
  }
});
check('classes: a node draws its class\'s mesh and colour, whatever its agent, kind of call or state', () => {
  const p = page({ model: ran(12, 'busy', 300).model }), seen = {};
  for (const n of p.model.standing()) {
    const v = p.view.visual(n), cls = n.cls === 'stack' ? 'stack' : n.cls;
    assert.equal(v.color, LOOKS.nexus.palette.cls[n.cls === 'stack' ? n.of : n.cls]);
    (seen[cls] = seen[cls] || new Set()).add(v.mesh);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, [...v].sort()])),
    { agent: ['agent'], subagent: ['subagent'], tool: ['tool'], mcp: ['mcp'], resource: ['resource.context', 'resource.file', 'resource.url'], stack: ['stack'] });
});
check('classes: each has its fixed place (its floor, and for the agent the centre slot of its column)', () => {
  const { model } = ran(12, 'busy', 600);
  for (const n of model.standing()) {
    if (n.cls === 'agent') assert.equal(n.slot, L.AGENT_SLOT);
    else if (n.cls === 'stack') assert.equal(n.slot, L.STACK_SLOT);
    else assert.ok(n.slot !== L.STACK_SLOT && (n.cls !== 'subagent' || n.slot !== L.AGENT_SLOT), n.id);
    assert.equal(n.floor, L.FLOOR_OF[n.cls === 'stack' ? n.of : n.cls]);
  }
});
check('captions never overlap: 0 overlapping pairs at about 40, 80 and 200 nodes, in both looks and both sizes', () => {
  const models = [ran(1, 'busy', 300).model, ran(4, 'busy', 300).model, ran(12, 'busy', 900).model];
  assert.ok(models[0].standing().length >= 20 && models[1].standing().length >= 70 && models[2].standing().length >= 200);
  let drawn = 0;
  for (const model of models) for (const look of Object.keys(LOOKS)) for (const [w, h] of [[780, 650], [556, 520]]) {
    const p = page({ model, look, width: w, height: h }), ids = p.view.hit.map(x => x.id);
    p.view.keepClear = [{ x: w - 300, y: 0, w: 300, h: 40 }, { x: 0, y: h - 50, w: w - 20, h: 50 }];
    for (const camera of [null, { distance: 900 }, { distance: 500, yaw: .3 }]) {
      if (camera) Object.assign(p.view.camera, camera);
      p.view.selected = ids[drawn % ids.length]; p.view.hover = ids[(drawn * 7 + 3) % ids.length];
      p.view.draw(); drawn++;
      assert.equal(overlapping(p.view.labels), 0);
      for (const box of p.view.labels.filter(b => b.id !== p.view.selected && b.id !== p.view.hover)) for (const keep of p.view.keepClear) assert.ok(!E.overlap(box, keep), 'a caption covers an overlay');
    }
  }
  assert.equal(drawn, 36);
});
check('captions by level of detail: every agent is named from afar, everything in a column is named close up', () => {
  const p = page({ model: ran(4, 'busy', 300).model });
  const far = new Set(p.view.labels.map(b => b.id)), column = p.model.standing().filter(n => n.col === 0);
  for (const n of p.model.standing()) if (n.cls === 'agent') assert.ok(far.has(n.id), n.label + ' has no caption');
  assert.ok(p.view.stats.skipped === 0 || far.size < p.model.standing().length);
  p.view.isolate(0); p.view.draw();
  const near = new Set(p.view.labels.map(b => b.id));
  assert.ok(column.every(n => near.has(n.id)), 'close up, ' + column.filter(n => !near.has(n.id)).map(n => n.label).join(', ') + ' had no caption');
  assert.ok(column.filter(n => far.has(n.id)).length < column.length);
});
check('captions say the state in words, so a state is never told by colour alone', () => {
  const p = page({ model: fixture() });
  p.view.draw();
  const agent = p.model.nodes.get('a:claude:s-aaaa');
  assert.ok(p.ctx.texts.some(t => t.text === 'WORKING'), 'the agent caption names its state');
  assert.equal(p.view.detailOf(Object.assign({}, agent, { status: 'needs' })), 'needs you');
  assert.match(N.line(agent, p.model), /\. working since \d\d:\d\d:\d\d UTC\./);
});
check('picking: the pointer on a node selects it; 20 px outside every outline selects nothing', () => {
  const m = M.create();
  m.apply(ev('claude', 's1', 'tool.start', { call: 'c', tool: 'Read' }));
  const p = page({ model: m });
  p.view.draw();
  for (const hit of p.view.hit) {
    assert.equal(p.view.pick(hit.x, hit.y), hit.id);
    const right = Math.max(...hit.hull.map(q => q.x)), top = Math.min(...hit.hull.map(q => q.y));
    assert.equal(p.view.pick(right + 20, hit.y), null);
    assert.equal(p.view.pick(hit.x, top - 20), null);
  }
});
check('picking: where two outlines overlap, each node\'s own centre still selects that node', () => {
  const p = page({ model: ran(12, 'busy', 900).model });
  Object.assign(p.view.camera, { pitch: 1.2, yaw: .9 });
  p.view.draw();
  let overlaps = 0;
  for (const a of p.view.hit) {
    assert.equal(p.view.pick(a.x, a.y), a.id);
    for (const b of p.view.hit) if (a !== b && E.inHull(b.hull, a.x, a.y)) overlaps++;
  }
  assert.ok(overlaps > 0, 'no two outlines overlapped, so the tie rule was not exercised');
});
check('clash: two agents that write one file get exactly one arc; a read gives none', () => {
  const m = M.create();
  m.apply(ev('claude', 's1', 'resource.touch', { kind: 'file', op: 'write', path: 'src/a.ts' }));
  m.apply(ev('codex', 's2', 'resource.touch', { kind: 'file', op: 'read', path: 'src/a.ts' }));
  assert.equal(m.arcs.size, 0);
  m.apply(ev('codex', 's2', 'resource.touch', { kind: 'file', op: 'write', path: 'src/a.ts' }));
  m.apply(ev('codex', 's2', 'resource.touch', { kind: 'file', op: 'write', path: 'src/a.ts' }));
  m.apply(ev('claude', 's1', 'resource.touch', { kind: 'file', op: 'write', path: 'src/a.ts' }));
  assert.equal(m.arcs.size, 1);
  assert.deepEqual([...m.arcs.values()][0].paths, ['src/a.ts']);
  m.apply(Object.assign(ev('grok', 's3', 'resource.touch', { kind: 'file', op: 'write', path: 'src/a.ts' }), { ws: 'w2' }));
  assert.equal(m.arcs.size, 1, 'another workspace is another file');
});

/* ---------- keyboard, the list twin, the inspector ---------- */

check('keyboard: Page Down visits every node once and comes back to the first', () => {
  for (const [agents, seconds] of [[1, 60], [4, 300], [12, 600]]) {
    const { model } = ran(agents, 'busy', seconds), all = model.standing().map(n => n.id), seen = [];
    let id = N.move(model, '', 'PageDown', {});
    for (let i = 0; i < all.length; i++) { seen.push(id); id = N.move(model, id, 'PageDown', {}); }
    assert.equal(id, seen[0]);
    assert.deepEqual(seen.slice().sort(), all.slice().sort());
    assert.equal(N.move(model, seen[0], 'PageUp', {}), seen[seen.length - 1]);
    assert.deepEqual([N.move(model, seen[5], 'Home', {}), N.move(model, seen[5], 'End', {})], [seen[0], seen[seen.length - 1]]);
  }
});
check('keyboard: the four arrow keys alone reach every node from any node', () => {
  for (const [agents, seconds] of [[1, 60], [4, 300], [12, 600]]) {
    const { model } = ran(agents, 'busy', seconds), all = model.standing().map(n => n.id);
    for (const start of [all[0], all[all.length - 1], all[Math.floor(all.length / 2)]]) {
      const seen = new Set([start + '|']), reached = new Set([start]), queue = [[start, {}]];
      while (queue.length) {
        const [id, memo] = queue.shift();
        for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
          const next = Object.assign({}, memo), to = N.move(model, id, key, next), state = to + '|' + (next.col === undefined ? '' : next.col);
          if (!seen.has(state)) { seen.add(state); reached.add(to); queue.push([to, next]); }
        }
      }
      assert.equal(reached.size, all.length, 'from ' + start + ': ' + all.filter(id => !reached.has(id)).slice(0, 3).join(', ') + ' cannot be reached');
    }
  }
});
check('keyboard: Left and Right stay on the floor, Up and Down stay in the column and pass through the dock', () => {
  const m = fixture(), memo = {};
  const tool = 't:claude:s-aaaa:Read';
  assert.equal(m.nodes.get(N.move(m, tool, 'ArrowRight', memo)).floor, 'tool');
  const up = N.move(m, tool, 'ArrowUp', memo);
  assert.equal(m.nodes.get(up).cls, 'mcp');
  assert.equal(N.move(m, up, 'ArrowUp', memo), 'a:claude:s-aaaa');
  assert.equal(m.nodes.get(N.move(m, up, 'ArrowDown', memo)).owner, 'claude:s-aaaa');
  assert.equal(m.nodes.get(N.move(m, tool, 'ArrowDown', memo)).floor, 'resource');
  assert.equal(N.move(m, 'gone', 'ArrowRight', memo), N.order(m)[0]);
  assert.match(read('index.html'), /role="application"[^>]*aria-label="3D scene[^"]*"[^>]*aria-describedby="scene-help"/);
  assert.match(read('index.html'), /<canvas id="scene" tabindex="0"/);
});
check('list twin: one row for every node that stands in the scene, and no other', () => {
  for (const model of [fixture(), ran(12, 'busy', 600).model]) {
    const rows = N.rows(model).flatMap(g => g.rows), own = rows.filter(r => r.key === r.id);
    assert.deepEqual(own.map(r => r.id).sort(), model.standing().map(n => n.id).sort());
    assert.equal(new Set(rows.map(r => r.key)).size, rows.length);
    for (const row of rows) assert.ok(row.text.length > 10 && /^(Agent|Subagent|Tool|MCP server|Resource|Stack)/.test(row.text), row.text);
    assert.deepEqual(own.map(r => r.id), N.order(model));
  }
  assert.match(read('index.html'), /id="twin" role="listbox" tabindex="0" aria-label="[^"]+"/);
});
check('list twin: agents that need the owner come first, the longest wait first, with clock times', () => {
  const m = M.create();
  for (const id of ['s1', 's2', 's3']) m.apply(ev('claude', id, 'turn.start', {}));
  m.apply(ev('claude', 's3', 'wait.start', { why: 'permission', tool: 'Bash' }));
  m.apply(ev('claude', 's1', 'wait.start', { why: 'question' }));
  const first = N.rows(m)[0];
  assert.equal(first.title, 'Needs you (2)');
  assert.deepEqual(first.rows.map(r => r.id), ['a:claude:s3', 'a:claude:s1']);
  assert.match(first.rows[0].text, /needs you \(permission for Bash\) since \d\d:\d\d:\d\d UTC/);
  for (const file of ['nav.js', 'app.js', 'engine.js']) assert.ok(!/\bago\b|minutes? ago|timeago|Date\.now/.test(read(file)), file + ' uses a relative time');
});
check('inspector: every class has facts and an "In VS Code" list of what the wiring would do', () => {
  const m = fixture();
  m.apply(ev('claude', 's-aaaa', 'tool.start', { call: 'z', tool: 'Bash', class: 'execute' }));
  const labels = id => N.describe(m.nodes.get(id), m).actions.map(a => a.label);
  assert.deepEqual(labels('a:claude:s-aaaa'), ['Focus the session', 'Show the call']);
  assert.deepEqual(labels('s:claude:s-aaaa:a-1'), ['Focus the session', 'Show the call']);
  assert.deepEqual(labels('t:claude:s-aaaa:Bash'), ['Show the call', 'Focus the session']);
  assert.deepEqual(labels('r:claude:s-aaaa:file:docs/'), ['Open the file', 'Show the diff', 'Show the call']);
  assert.deepEqual(labels('r:claude:s-aaaa:file:src/app/'), ['Open the file', 'Show the call']);
  assert.deepEqual(labels('r:claude:s-aaaa:url:example.com'), ['Open the URL', 'Show the call']);
  assert.deepEqual(labels('m:github'), ['Open the MCP configuration', 'Show the call']);
  for (const n of m.standing()) {
    const d = N.describe(n, m);
    assert.ok(d.facts.length >= 2 && d.actions.length >= 1 && d.className, n.id);
    for (const [label, value] of d.facts) assert.ok(typeof label === 'string' && typeof value === 'string' && value !== 'undefined' && !/NaN|\[object/.test(value), n.id + ' ' + label + ' ' + value);
    for (const a of d.actions) assert.ok(a.detail.length > 20);
  }
  const big = ran(12, 'busy', 600).model;
  for (const n of big.standing()) assert.ok(N.describe(n, big).facts.length >= 2);
});
check('a folded node is shown as its stack, and the stack lists what it holds', () => {
  const { model } = ran(12, 'busy', 600), stack = model.standing().find(n => n.cls === 'stack');
  const folded = model.foldedIn(stack);
  assert.equal(folded.length + model.cell(stack.col, stack.floor).dropped, stack.count);
  for (const n of folded) assert.equal(model.visibleId(n.id), stack.id);
  const d = N.describe(stack, model);
  assert.deepEqual(d.actions.map(a => a.label), ['List the folded items']);
  assert.ok(d.lists[0].items.length >= 1);
});
check('isolate shows one column and the dock, and leaving it restores the camera', () => {
  const p = page({ model: ran(12, 'busy', 300).model }), saved = JSON.stringify(p.view.camera);
  p.view.isolate(5); p.view.draw();
  assert.ok(p.view.hit.length > 5);
  for (const hit of p.view.hit) assert.ok([5, L.DOCK].includes(p.model.nodes.get(hit.id).col));
  assert.notEqual(JSON.stringify(p.view.camera), saved);
  assert.equal(p.view.release(), true);
  assert.equal(JSON.stringify(p.view.camera), saved);
  assert.equal(p.view.release(), false);
});

/* ---------- the page's own rules ---------- */

check('sizes: at 1280x720 and at 800x600 the framed scene is inside the canvas, for 1, 4 and 12 agents', () => {
  for (const [w, h] of [[780, 650], [556, 520]]) for (const agents of [1, 4, 12]) {
    const model = M.create();
    for (const e of ran(agents, 'busy', 30).events) model.apply(e);
    const p = page({ model, width: w, height: h });
    p.view.resetCamera(Array.from({ length: agents }, (_, i) => i)); p.view.draw();
    assert.equal(p.view.stats.offscreen, 0, agents + ' agents at ' + w + 'x' + h);
    for (const hit of p.view.hit) assert.ok(hit.x > 0 && hit.x < w && hit.y > 0 && hit.y < h);
  }
  const css = read('style.css');
  assert.match(css, /@media \(max-width: 1100px\)/);
  assert.ok(!/min-width:\s*(9|1\d)\d\dpx[^)]/.test(css.replace(/@media[^{]+/g, '')), 'a fixed width wider than 800 px');
});
check('the page has no form control and nothing editable', () => {
  const html = read('index.html'), app = read('app.js');
  assert.ok(!/<(input|select|textarea|form|option|datalist)\b|contenteditable|designMode/i.test(html + app));
  const made = new Set([...app.matchAll(/\bel\('([a-z0-9]+)'/g)].map(m => m[1]));
  for (const tag of made) assert.ok(['canvas', 'div', 'p', 'h2', 'h3', 'dl', 'dt', 'dd', 'ul', 'li', 'b', 'span', 'i'].includes(tag), 'app.js makes a <' + tag + '>');
  assert.equal((app.match(/createElement\(/g) || []).length, 1);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(app), 'text goes in as text');
});
check('every button is a feed or view control; the "In VS Code" list is text, not controls', () => {
  const html = read('index.html'), app = read('app.js');
  const buttons = [...html.matchAll(/<button type="button"([^>]*)>([^<]+)<\/button>/g)].map(m => m[2]);
  assert.deepEqual(buttons, ['Pause', 'Speed 1x', '1', '4', '12', 'Quiet', 'Busy', 'NEXUS', 'Glasshouse', 'Motion off', 'Frame all', 'Separate floors', 'Isolate', 'Tidy', 'List']);
  assert.equal((html.match(/<button/g) || []).length, buttons.length);
  assert.equal((html.match(/<a /g) || []).length, 1);                         // the skip link
  assert.match(app, /const li = el\('li'\); li\.append\(el\('b', '', a\.label\), el\('span', '', a\.detail\)\)/);
  assert.match(app, /These are labels, not controls\./);
  assert.ok(!/vscode|acquireVsCodeApi|postMessage/.test(PAGE_SCRIPTS.map(read).join('').replace(/In VS Code|VS Code's|in VS Code/g, '')), 'nothing is wired');
});
check('the legend gives shape, colour and name for every class, state and kind of call', () => {
  const app = read('app.js');
  for (const key of MESH_KEYS) assert.ok(app.includes("icon('" + key + "'"), 'no legend icon for ' + key);
  for (const name of ['Agent', 'Subagent', 'Tool', 'MCP server', 'Files', 'URLs', 'Context']) assert.ok(app.includes("'" + name + "'"), name);
  assert.match(app, /for \(const key of Object\.keys\(M\.STATES\)\) if \(M\.STATES\[key\]\.shape\) states\.append\(item\(badge\(key, 18\), M\.STATES\[key\]\.name\)\)/);
  for (const text of ['Tool call', 'MCP call', 'Read (dashed)', 'Write (solid', 'Search (dotted)', 'just ended', 'wrote the same file']) assert.ok(app.includes(text), text);
  assert.match(read('index.html'), /<details id="legend" open>/);
});
check('a visible count of frames drawn is on the page', () => {
  const app = read('app.js');
  assert.match(app, /\['frames', 'frames drawn'\]/);
  assert.match(app, /hud\.frames\.textContent = stats\.frames/);
  assert.match(read('index.html'), /<div class="hud" id="hud"/);
});
check('no network: the page\'s scripts never fetch, and the page\'s policy allows no connection', () => {
  for (const file of PAGE_SCRIPTS) assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|\bimport\(|navigator\.serviceWorker|new Worker/.test(read(file)), file);
  const html = read('index.html'), css = read('style.css');
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'/);
  assert.ok(!/https?:\/\//.test(html + css), 'the page links to nothing outside itself');
  assert.ok(!/url\(|@import|@font-face/.test(css));
  for (const file of PAGE_SCRIPTS) for (const url of read(file).match(/https?:\/\/[^\s'"`)]+/g) || []) assert.match(url, /^https:\/\/([a-z]+\.)?example\.(com|org|net)/, file + ' names ' + url);
});
check('no packages, no build step: the page loads plain files that are all here, and Node needs only its own modules', () => {
  const html = read('index.html'), scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.deepEqual(scripts, PAGE_SCRIPTS);
  assert.equal((html.match(/<script/g) || []).length, scripts.length);
  for (const file of scripts.concat('style.css')) assert.ok(fs.existsSync(path.join(__dirname, file)), file);
  assert.deepEqual(preview.FILES.slice().sort(), scripts.concat(['index.html', 'style.css']).sort());
  for (const file of fs.readdirSync(__dirname).filter(f => f.endsWith('.js'))) for (const m of read(file).matchAll(/require\('([^']+)'\)/g))
    assert.ok(m[1].startsWith('./') || m[1].startsWith('node:') || ['fs', 'path', 'os', 'net', 'child_process', 'url'].includes(m[1]), file + ' requires ' + m[1]);
  for (const file of ['package.json', 'node_modules', 'package-lock.json']) assert.ok(!fs.existsSync(path.join(__dirname, file)), file);
});
check('nothing private in this folder: no email address, user folder or drive path', () => {
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/, folder = new RegExp('[A-Za-z]:[\\\\/]' + 'Users|/' + 'Users/|/' + 'home/[a-z]');
  for (const file of fs.readdirSync(__dirname)) {
    if (!/\.(js|html|css|md|json)$/.test(file)) continue;
    const text = read(file);
    assert.ok(!email.test(text), file + ' holds an email address: ' + (email.exec(text) || [''])[0]);
    assert.ok(!folder.test(text), file + ' holds a local path');
  }
});
check('the preview serves on the loopback address only, and only the page\'s own files', async () => {
  const server = await preview.listen(0), port = server.address().port;
  const get = name => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/' + name }, res => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject));
  try {
    assert.equal(server.address().address, '127.0.0.1');
    assert.equal(preview.HOST, '127.0.0.1');
    const index = await get('');
    assert.equal(index.statusCode, 200);
    assert.match(index.headers['content-security-policy'], /connect-src 'none'/);
    for (const name of preview.FILES) assert.equal((await get(name)).statusCode, 200, name);
    for (const name of ['check.js', 'serve.js', 'README.md', '../../package.json', '..%2f..%2fpackage.json', 'shoot.js']) assert.equal((await get(name)).statusCode, 404, name);
  } finally { server.close(); }
});

/* ---------- run ---------- */

(async () => {
  let passed = 0;
  const failed = [];
  for (const { name, fn } of checks) {
    try { await fn(); passed++; console.log('ok    ' + name); }
    catch (error) { failed.push(name); console.log('FAIL  ' + name + '\n      ' + String(error.message).split('\n').slice(0, 6).join('\n      ')); }
  }
  console.log('\n' + passed + ' of ' + checks.length + ' checks passed' + (failed.length ? '; ' + failed.length + ' failed' : '') + '.');
  process.exit(failed.length ? 1 : 0);
})();
