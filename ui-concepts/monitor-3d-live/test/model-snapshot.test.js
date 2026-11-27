// The live model's additions: a snapshot that a second model carries on from, a session that leaves at once,
// and an agent named after its folder. The events come from the mock-up's seeded simulator, so every name is invented.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const M = require('../media/model.js');
const F = require(path.join(__dirname, '..', '..', 'monitor-3d', 'feed.js'));

const stream = (agents, ms, seed = 7) => F.createSim({ seed, agents, load: 'busy' }).advanceTo(ms);
const feed = (model, events) => { for (const e of events) model.apply(e); return model; };
const places = model => [...model.nodes.values()].filter(n => !n.folded).map(n => n.id + '@' + n.col + '/' + n.floor + '/' + n.slot).sort();

test('a model loaded from a snapshot carries on exactly as the one that made it', () => {
  const events = stream(12, 10 * 60 * 1000);
  assert.ok(events.length > 2000, 'the stream is long enough to mean something: ' + events.length);
  for (const cut of [0, 1, 137, Math.floor(events.length / 2), events.length - 1]) {
    const a = feed(M.create(), events.slice(0, cut));
    const b = M.load(a.serialize());
    assert.equal(b.serialize(), a.serialize(), 'the copy equals the original at cut ' + cut);
    feed(a, events.slice(cut)); feed(b, events.slice(cut));
    assert.equal(b.serialize(), a.serialize(), 'still equal after the rest, cut ' + cut);
    assert.deepEqual(places(b), places(a), 'the same slots, cut ' + cut);
  }
});

test('a loaded model marks every node as changed, and keeps its maps and sets', () => {
  const a = feed(M.create(), stream(4, 120000));
  const b = M.load(a.serialize());
  const changes = b.takeChanges();
  assert.equal(changes.structure, true);
  assert.equal(changes.ids.size, b.nodes.size);
  assert.ok(b.nodes instanceof Map && b.sessions instanceof Map && b.overflow instanceof Set);
  const server = [...b.nodes.values()].find(n => n.cls === 'mcp');
  assert.ok(server && server.ports instanceof Map && server.usedBy instanceof Set, 'an MCP server keeps its ports and users');
  const session = [...b.sessions.values()][0];
  assert.ok(session.calls instanceof Map && session.nodes instanceof Set);
});

test('a snapshot of another version, or a broken one, is refused', () => {
  assert.throws(() => M.load(JSON.stringify({ v: 2, state: {} })), /another version/);
  assert.throws(() => M.load(JSON.stringify({ v: 1, state: { nodes: { $map: [] } } })), /without/);
  assert.throws(() => M.load('not json'));
});

test('a snapshot whose parts are of the wrong kind is refused when it is loaded, not found later by the drawing code', () => {
  const good = feed(M.create(), stream(4, 90000));
  const text = good.serialize();
  assert.doesNotThrow(() => M.load(text), 'the real one loads');
  const firstOf = (state, cls) => state.nodes.$map.find(([, n]) => n.cls === cls)[1];
  const broken = {
    'a label that is an object': s => { firstOf(s, 'agent').label = { text: 'x' }; },
    'columns as text': s => { s.columns = 'abc'; },
    'sessions as a list': s => { s.sessions = []; },
    'a node that is null': s => { s.nodes.$map[0][1] = null; },
    'an unknown class': s => { firstOf(s, 'tool').cls = 'window'; },
    'an unknown state': s => { firstOf(s, 'tool').status = 'toString'; },
    'ports as a plain object': s => { firstOf(s, 'mcp').ports = {}; },
    'a node id that is not one': s => { const pair = s.nodes.$map.find(([, n]) => n.cls === 'tool'); pair[0] = '__proto__'; pair[1].id = '__proto__'; },
    'a column far outside the layout': s => { firstOf(s, 'tool').col = 1e9; },
    'a slot below the grid': s => { firstOf(s, 'tool').slot = -5; },
    'a slot that names no node': s => { s.cells.$map[0][1].slots[0] = 't:nobody'; },
    'a session with no agent': s => { s.sessions.$map[0][1].agentId = 'a:nobody'; },
    'a column that names no session': s => { s.columns[0] = 'claude:nobody'; },
    'counters that are not numbers': s => { s.counts.events = 'many'; },
    'a link with no ends': s => { s.links.$map.push(['x', { id: 'x', kind: 'tool' }]); }
  };
  for (const [what, damage] of Object.entries(broken)) {
    const data = JSON.parse(text);
    damage(data.state);
    assert.throws(() => M.load(JSON.stringify(data)), /wrong shape|without/, what);
  }
  const many = JSON.parse(text), one = firstOf(many.state, 'tool');
  for (let i = 0; i < 10001; i++) many.state.nodes.$map.push(['t:x:' + i, Object.assign({}, one, { id: 't:x:' + i })]);
  assert.throws(() => M.load(JSON.stringify(many)), /more nodes/);
});

test('every snapshot a long stream can make passes the shape check, with stacks, folded nodes and ended sessions in it', () => {
  const events = stream(12, 10 * 60 * 1000, 3), model = M.create();
  let checked = 0;
  events.forEach((e, i) => { model.apply(e); if (i % 500 === 0) { M.load(model.serialize()); checked++; } });
  model.tidy();
  M.load(model.serialize());
  for (const key of [...model.sessions.keys()].slice(0, 5)) { model.drop(key); M.load(model.serialize()); }
  assert.ok(checked >= 5, 'snapshots checked along the way: ' + checked);
});

test('calls that start and never end cannot pile up: a session keeps at most 64 open, and the snapshot stays small', () => {
  const model = M.create();
  const base = { v: 1, agent: 'claude', session: 'flood-0001', ws: 'w1', grade: 'exact', src: 'hook:PreToolUse' };
  model.apply({ ...base, t: 1000, ev: 'session.start' });
  for (let i = 0; i < 20000; i++) {
    model.apply({ ...base, t: 2000 + i, ev: 'tool.start', call: 'call-' + i, tool: 'Read' });
    model.apply({ ...base, t: 2000 + i, ev: 'resource.touch', call: 'call-' + i, kind: 'file', op: 'read', path: 'folder-' + i + '/file.txt' });
  }
  const session = model.sessions.get('claude:flood-0001');
  assert.equal(session.calls.size, 64);
  assert.ok(model.links.size <= 64 * 2, 'links: ' + model.links.size);
  assert.equal(model.leftOut.calls, 20000 - 64);
  assert.ok(model.nodes.size < 400, 'nodes: ' + model.nodes.size);
  const text = model.serialize();
  assert.ok(text.length < 400000, 'the snapshot is ' + text.length + ' characters');
  assert.doesNotThrow(() => M.load(text));
  assert.equal(model.nodes.get('t:claude:flood-0001:Read').open, 64, 'the tool counts what is still open');
  model.apply({ ...base, t: 90000, ev: 'tool.end', call: 'call-19999', tool: 'Read', ok: true, src: 'hook:PostToolUse' });
  assert.equal(session.calls.size, 63, 'a call that is still open ends as usual');
});

test('drop: the session leaves at once, its column is free, and nothing else moves', () => {
  const model = feed(M.create(), stream(4, 90000));
  const keys = [...model.sessions.keys()];
  assert.equal(keys.length, 4);
  const gone = model.sessions.get(keys[1]), col = gone.col;
  const others = places(model).filter(line => !line.includes(keys[1]) && !line.startsWith('m:') && !line.startsWith('k:' + col + ':'));
  model.takeChanges();
  assert.equal(model.drop(keys[1]), true);
  assert.equal(model.sessions.has(keys[1]), false);
  assert.equal(model.columns[col], null, 'the column is free');
  assert.equal([...model.nodes.values()].filter(n => n.owner === keys[1]).length, 0, 'none of its nodes is left');
  assert.equal([...model.links.values()].filter(l => l.session === keys[1]).length, 0, 'none of its calls is left open');
  for (const n of model.nodes.values()) if (n.cls === 'mcp') assert.ok(n.usedBy.size > 0 || n.open > 0, 'no MCP server is left without a user');
  const after = new Set(places(model));
  for (const line of others) assert.ok(after.has(line), 'still in place: ' + line);
  assert.equal(model.takeChanges().structure, true);
  assert.equal(model.drop(keys[1]), false, 'a second drop finds nothing');
  assert.doesNotThrow(() => M.load(model.serialize()));
});

test('drop: the freed column goes to the next new session', () => {
  const model = feed(M.create(), stream(3, 60000));
  const key = [...model.sessions.keys()][0], col = model.sessions.get(key).col;
  model.drop(key);
  model.apply({ v: 1, t: model.now + 1, agent: 'claude', session: 'fresh-0001', ws: 'w9', ev: 'session.start', grade: 'exact', src: 'hook:SessionStart' });
  assert.equal(model.sessions.get('claude:fresh-0001').col, col);
});

test('an agent is named after its folder, and knows whether a collector reports for it', () => {
  const model = M.create();
  const base = { v: 1, agent: 'claude', session: 'abcdef123456', ws: 'w1' };
  model.apply({ ...base, t: 1000, ev: 'session.start', grade: 'derived', src: 'sessions-file', root: { name: 'example-repo' } });
  const agent = model.nodes.get('a:claude:abcdef123456');
  assert.equal(agent.label, 'claude example-repo');
  assert.equal(agent.root, 'example-repo');
  assert.equal(agent.collector, false);
  model.apply({ ...base, t: 2000, ev: 'tool.start', grade: 'derived', src: 'transcript:PreToolUse', call: 'c1', tool: 'Read' });
  assert.equal(agent.collector, false, 'a transcript is not a collector');
  model.apply({ ...base, t: 3000, ev: 'tool.end', grade: 'exact', src: 'hook:PostToolUse', call: 'c1', tool: 'Read', ok: true });
  assert.equal(agent.collector, true);
  assert.equal(M.load(model.serialize()).nodes.get(agent.id).label, 'claude example-repo');
});
