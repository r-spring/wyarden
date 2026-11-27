// How many existing nodes move when one node is added, per world layout. Reads the mock-up files; writes nothing.
//   node stability.js <path to nexus-worlds-29d4d1>
'use strict';
const path = require('path'), vm = require('vm'), fs = require('fs');
const dir = process.argv[2];
const ctx = { console, Math, Object, Array, Map, Set, Number, String, JSON, Error };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['model.js', 'engine.js', 'modes-city-orbit.js', 'modes-glass-synapse.js', 'modes-horizon-terrain.js']) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
const M = ctx.NexusModel, W = ctx.NexusWorlds;
const g0 = M.seed();
const types = {}; g0.nodes.forEach(n => types[n.type] = (types[n.type] || 0) + 1);
console.log('model', JSON.stringify({ nodes: g0.nodes.length, edges: g0.edges.length, events: g0.events.length, types: Object.keys(types).length, perType: types }));
const extra = id => ({ id, label: id.toUpperCase(), type: 'tool', status: 'idle', position: [0, 0, 330], detail: '', metrics: {} });
const moved = (a, b) => a.nodes.filter(n => { const m = b.nodes.find(x => x.id === n.id); return m && Math.hypot(...n.position.map((v, i) => v - m.position[i])) > 0.5; }).length;
const out = {};
for (const id of ['city', 'orbit', 'glass', 'synapse', 'horizon', 'terrain']) {
  const L = W[id].layout, t = 34;
  const base = L(M.seed(), t);
  const gEnd = M.seed(); gEnd.nodes.push(extra('x-end')); const end = L(gEnd, t);
  const gMid = M.seed(); gMid.nodes.splice(25, 0, extra('x-mid')); const mid = L(gMid, t);
  const gTen = M.seed(); for (let i = 0; i < 10; i++) gTen.nodes.push(extra('x-' + i)); const ten = L(gTen, t);
  // Same graph, one second later: nodes moved by time alone.
  const later = L(M.seed(), t + 1);
  const newPos = ten.nodes.filter(n => n.id.startsWith('x-')).map(n => n.position.map(v => Math.round(v)).join(','));
  out[id] = { movedByAppend1: moved(base, end), movedByInsert1: moved(base, mid), movedByAppend10: moved(base, ten), movedByOneSecond: moved(base, later), distinctPositionsFor10NewTools: new Set(newPos).size };
}
console.log(JSON.stringify(out, null, 1));
