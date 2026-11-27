// The hub's logic (lib/hub-core.js), one test for each rule of section 7.1 and 7.4 of
// docs/monitor-3d/05-working-mockup.md. A manual clock and a manual scheduler, a small fake
// normaliser, and folders that need not exist: nothing here touches a socket or a real folder.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createHubCore, MAX_SESSIONS, MAX_DUPES } = require('../lib/hub-core.js');
const contract = require('../lib/contract.js');
const M = require('../media/model.js');
const F = require(path.join(__dirname, '..', '..', 'monitor-3d', 'feed.js'));

const P = '/home/example/proj', DEEP = '/home/example/proj/sub', OTHER = '/home/example/other';
const T0 = 1800000000000;
const rootOf = cwd => (cwd ? { root: cwd, real: cwd, ws: contract.wsKey(cwd), name: contract.flavour(cwd).basename(cwd) } : null);

function harness(extra = {}) {
  let t = T0;
  const jobs = [];
  const clock = { now: () => t, add: ms => { t += ms; } };
  const schedule = (fn, ms) => { const job = { at: t + ms, fn, off: false }; jobs.push(job); return () => { job.off = true; }; };
  const run = ms => { t += ms; for (const job of jobs) if (!job.off && job.at <= t) { job.off = true; job.fn(); } };
  const forgot = [];
  const normaliser = extra.normaliser || {
    feed(p, opts) {
      if (!p || typeof p !== 'object' || typeof p.session !== 'string') return null;
      const agent = p.agent || 'claude', source = p.source || 'hook';
      const events = (p.events || []).map(e => Object.assign({
        v: 1, t: opts.t, agent, session: p.session, ws: p.cwd ? contract.wsKey(p.cwd) : '', grade: source === 'hook' ? 'exact' : 'derived',
        src: (source === 'hook' ? 'hook:' : 'transcript:') + 'Test'
      }, e));
      return { agent, session: p.session, key: agent + ':' + p.session, cwd: p.cwd, root: rootOf(p.cwd), source, events };
    },
    forget(key) { forgot.push(key); }
  };
  const core = createHubCore(Object.assign({ normaliser, now: clock.now, schedule, rootInfo: rootOf, epoch: 'abcd1234' }, extra.options));
  const sent = [];
  core.onSend = (id, message) => sent.push({ id, message });
  const hook = (session, cwd, ...events) => core.ingest({ session, cwd, events });
  const records = id => sent.filter(x => x.id === id && x.message.type === 'records').flatMap(x => x.message.records);
  const lastWs = id => { const all = sent.filter(x => x.id === id && x.message.type === 'workspaces'); return all.length ? all[all.length - 1].message : null; };
  const win = (id, folders, scope, app = 'Code', name = id) => core.attach({ id, app, name, pid: 1, folders: folders.map(p => ({ path: p, name: contract.flavour(p).basename(p) })), scope });
  return { core, clock, run, jobs, sent, hook, records, lastWs, win, forgot, clear: () => { sent.length = 0; } };
}
const kP = contract.wsKey(P), kDeep = contract.wsKey(DEEP), kOther = contract.wsKey(OTHER);
const start = { ev: 'tool.start', call: 'c1', tool: 'Read' };

/* ---------- 7.1, sentence by sentence ---------- */

test('Sessions: one record per key with agent, session, cwd, root, pid, status, best source, last event time, owner', () => {
  const h = harness();
  h.win('A', [P], null);
  h.hook('s1', P + '/src', start);
  let s = h.core.session('claude:s1');
  assert.equal(s.agent, 'claude'); assert.equal(s.session, 's1'); assert.equal(s.cwd, P + '/src');
  assert.equal(s.root.root, P + '/src'); assert.equal(s.best, 'hook'); assert.equal(s.lastAt, T0); assert.deepEqual(s.owners, [kP]);
  h.clock.add(500);
  h.core.setLiveSessions([{ agent: 'claude', session: 's1', key: 'claude:s1', cwd: P + '/src', pid: 42, status: 'busy' }]);
  s = h.core.session('claude:s1');
  assert.equal(s.pid, 42); assert.equal(s.status, 'busy'); assert.equal(s.best, 'hook', 'a hook is a better source than the file');
});

test('Workspaces: one for each window\'s set of folders; a single folder keeps wsKey(path); the same set in two editors is one workspace', () => {
  const h = harness();
  h.win('A', [P], null, 'Code');
  h.win('B', [P, OTHER], null, 'VSCodium', 'Example (Workspace)');
  h.win('C', [OTHER, P], null, 'Code', 'Other title');      // the same set, in another order and editor
  h.core.flushWorkspaces();
  const ws = h.lastWs('A');
  assert.equal(h.core.status().workspaces, 2);
  const single = ws.list.find(x => x.key === kP);
  assert.equal(single.windows, 1); assert.deepEqual(single.folders, ['proj']); assert.equal(single.name, 'A');
  const kBoth = contract.windowKey([P, OTHER]);
  assert.notEqual(kBoth, kP);
  const both = ws.list.find(x => x.key === kBoth);
  assert.equal(both.windows, 2);
  assert.deepEqual(both.apps, ['Code', 'VSCodium']);
  assert.deepEqual(both.folders, ['proj', 'other']);
  assert.equal(both.name, 'Example', 'the first window\'s name, its " (Workspace)" suffix stripped');
  assert.equal(h.lastWs('B').own, kBoth); assert.equal(h.lastWs('C').own, kBoth); assert.equal(ws.own, kP);
});

test('Workspaces: the owner\'s case, six windows of which two hold two folders, are six workspaces, named as the windows', () => {
  const h = harness();
  const base = '/home/example/w';
  const sets = [[base + '1'], [base + '2'], [base + '3', base + '4'], [base + '5'], [base + '6', base + '7'], [base + '8']];
  sets.forEach((folders, i) => h.win('W' + i, folders, null, 'Code', 'Window ' + i + (folders.length > 1 ? ' (Workspace)' : '')));
  h.core.flushWorkspaces();
  const list = h.lastWs('W0').list;
  assert.equal(list.length, 6);
  assert.deepEqual(list.map(x => x.name), ['Window 0', 'Window 1', 'Window 2', 'Window 3', 'Window 4', 'Window 5']);
  assert.deepEqual(list.map(x => x.key), sets.map(f => contract.windowKey(f)));
  assert.deepEqual(list.find(x => x.name === 'Window 2').folders, ['w3', 'w4']);
  assert.equal(h.core.status().workspaces, 6);
});

test('Workspaces: a window with no name takes its first folder\'s name; a window with no folder makes no workspace', () => {
  const h = harness();
  h.win('A', [OTHER, P], null, 'Code', '');
  h.win('B', [], null, 'Code', 'Empty');
  h.core.flushWorkspaces();
  assert.deepEqual(h.lastWs('A').list.map(x => x.name), ['other']);
  assert.equal(h.lastWs('B').own, '');
});

test('Owner: the longest folder that holds the cwd wins; no owner means hidden and drawn nowhere', () => {
  const h = harness();
  h.win('A', [P], 'all');
  h.win('B', [DEEP], 'all');
  h.hook('s1', DEEP + '/x', start);
  h.hook('s2', P + '/y', start);
  h.hook('s3', '/home/example/elsewhere', start);
  assert.deepEqual(h.core.session('claude:s1').owners, [kDeep]);
  assert.deepEqual(h.core.session('claude:s2').owners, [kP]);
  assert.deepEqual(h.core.session('claude:s3').owners, []);
  const st = h.core.status();
  assert.deepEqual(st.sessions, { known: 3, shown: 2, hidden: 1 });
  assert.equal(h.core.models.get('all').sessions.has('claude:s3'), false);
  assert.ok(!h.records('A').some(r => r.session === 's3'), 'a hidden session is sent nowhere');
});

test('Scopes: an owned event gets a seq, goes into all and its owner\'s model, and to windows on all or that owner only', () => {
  const h = harness();
  h.win('A', [P], kP); h.win('B', [OTHER], kOther); h.win('C', [OTHER], 'all');
  h.clear();
  h.hook('s1', P, start);
  const toA = h.records('A'), toB = h.records('B'), toC = h.records('C');
  assert.deepEqual(toA.map(e => e.ev), ['session.start', 'tool.start']);
  assert.deepEqual(toC.map(e => e.ev), ['session.start', 'tool.start']);
  assert.equal(toB.length, 0);
  assert.deepEqual(toA.map(e => e.seq), [1, 2]);
  assert.ok(h.core.models.get(kP).sessions.has('claude:s1') && h.core.models.get('all').sessions.has('claude:s1'));
  assert.equal(h.core.models.get(kOther).sessions.size, 0);
});

test('Workspaces change: a new workspace gets a model, and its known live sessions go in with a hub:known start and root', () => {
  const h = harness();
  h.win('A', [OTHER], 'all');
  h.hook('s1', P + '/src', start);                 // no workspace holds it yet
  assert.deepEqual(h.core.session('claude:s1').owners, []);
  h.clear();
  h.win('B', [P], kP);
  const e = h.records('A').find(r => r.ev === 'session.start');
  assert.ok(e, 'the all window gets the start');
  assert.equal(e.grade, 'derived'); assert.equal(e.src, 'hub:known'); assert.deepEqual(e.root, { name: 'src' });
  assert.ok(h.core.models.get(kP).sessions.has('claude:s1'));
  assert.ok(h.core.models.get('all').sessions.has('claude:s1'));
  const snap = h.records('B')[0];
  assert.equal(snap.ctl, 'snapshot');
  assert.ok(M.load(snap.state).sessions.has('claude:s1'), 'the new window\'s snapshot holds it');
});

test('Workspaces change: a session that lost its owner is dropped from all (workspace-closed); the gone workspace loses its model', () => {
  const h = harness();
  h.win('A', [OTHER], 'all'); h.win('B', [P], kP);
  h.hook('s1', P, start);
  h.clear();
  h.core.detach('B');
  const drop = h.records('A').find(r => r.ctl === 'drop');
  assert.deepEqual({ ctl: drop.ctl, key: drop.key, why: drop.why }, { ctl: 'drop', key: 'claude:s1', why: 'workspace-closed' });
  assert.equal(drop.seq, h.core.status().seq, 'a control record carries the seq of the last event before it');
  assert.equal(h.core.models.has(kP), false);
  assert.equal(h.core.models.get('all').sessions.has('claude:s1'), false);
  assert.equal(h.core.status().sessions.hidden, 1, 'still known, now hidden');
});

test('Workspaces change: a window whose scope is gone is moved to all, with a snapshot', () => {
  const h = harness();
  h.win('A', [P], kP);
  h.win('B', [OTHER], kP);          // B shows A's workspace
  h.clear();
  h.core.detach('A');
  const recs = h.records('B');
  assert.equal(recs[0].ctl, 'snapshot'); assert.equal(recs[0].scope, 'all');
  h.core.flushWorkspaces();
  assert.equal(h.lastWs('B').scope, 'all');
});

test('Workspaces change: every window gets a new workspaces message', () => {
  const h = harness();
  h.win('A', [P], null); h.win('B', [OTHER], null);
  h.core.flushWorkspaces(); h.clear();
  assert.equal(h.core.workspacesPending(), false);
  h.core.update('A', { folders: [{ path: DEEP, name: 'sub' }] });
  assert.equal(h.core.workspacesPending(), true);
  h.core.flushWorkspaces();
  for (const id of ['A', 'B']) assert.deepEqual(h.lastWs(id).list.map(x => x.key).sort(), [kDeep, kOther].sort());
  h.clear();
  assert.equal(h.core.flushWorkspaces(), 0, 'nothing new: nothing sent');
});

test('Duplicates: the same payload twice is dropped for tool, mcp, resource.touch, subagent, turn and wait', () => {
  const h = harness();
  h.win('A', [P], 'all');
  const evs = [
    { ev: 'turn.start', turn: 'p1' },
    { ev: 'tool.start', call: 'c1', tool: 'Read' },
    { ev: 'resource.touch', call: 'c1', kind: 'file', op: 'read', path: 'a.txt' },
    { ev: 'tool.start', call: 'c2', tool: 'Read' },
    { ev: 'tool.end', call: 'c1', tool: 'Read', ok: true },
    { ev: 'tool.end', call: 'c2', tool: 'Read', ok: false, error: 'tool_error' },
    { ev: 'mcp.start', call: 'c3', server: 'srv', tool: 'echo' },
    { ev: 'mcp.end', call: 'c3', server: 'srv', tool: 'echo', ok: true },
    { ev: 'subagent.start', sub: 'a1' }, { ev: 'subagent.stop', sub: 'a1' },
    { ev: 'wait.start', why: 'permission' }, { ev: 'wait.end' }, { ev: 'turn.end', turn: 'p1', outcome: 'done' }
  ];
  for (const e of evs) { h.hook('s1', P, e); h.hook('s1', P, e); }
  const st = h.core.status().events;
  assert.equal(st.duplicates, evs.length);
  assert.equal(h.records('A').filter(r => r.ev).length, evs.length + 1, 'each once, after the hub\'s own start');
  // A different second is a new wait; a different turn id is a new turn.
  h.clock.add(1500);
  h.hook('s1', P, { ev: 'wait.start', why: 'idle' }, { ev: 'turn.start', turn: 'p2' });
  assert.equal(h.core.status().events.duplicates, evs.length);
});

test('Duplicates: the last 500 keys are remembered for each session', () => {
  const h = harness();
  h.win('A', [P], 'all');
  for (let i = 0; i < MAX_DUPES + 100; i++) h.hook('s1', P, { ev: 'tool.start', call: 'k' + i, tool: 'Read' });
  const before = h.core.status().events.duplicates;
  h.hook('s1', P, { ev: 'tool.start', call: 'k' + (MAX_DUPES + 99), tool: 'Read' });
  assert.equal(h.core.status().events.duplicates, before + 1, 'a recent key is a repeat');
  h.hook('s1', P, { ev: 'tool.start', call: 'k0', tool: 'Read' });
  assert.equal(h.core.status().events.duplicates, before + 1, 'the oldest is forgotten');
});

test('Unknown session: a first event that is not session.start gets a hub-made start first; a start is not doubled', () => {
  const h = harness();
  h.win('A', [P], 'all');
  h.clear();
  h.hook('s1', P, start);
  h.hook('s2', P, { ev: 'session.start', source: 'startup' });
  const r = h.records('A');
  assert.deepEqual(r.map(e => e.session + ' ' + e.ev + ' ' + e.src), ['s1 session.start hub:known', 's1 tool.start hook:Test', 's2 session.start hook:Test']);
  for (const e of r) {
    assert.doesNotThrow(() => M.validate(e));
    for (const k of ['v', 't', 'agent', 'session', 'ws', 'ev', 'grade', 'src', 'seq']) assert.ok(k in e, k + ' is in every event');
  }
});

test('One source per session: after a hook, transcript payloads are ignored and the session leaves tailTargets', () => {
  const h = harness();
  h.win('A', [P], 'all');
  h.core.setLiveSessions([{ agent: 'claude', session: 's1', key: 'claude:s1', cwd: P, pid: 7, transcript: '/home/example/t/s1.jsonl' }]);
  assert.deepEqual(h.core.tailTargets(), [{ key: 'claude:s1', session: 's1', cwd: P, transcript: '/home/example/t/s1.jsonl' }]);
  h.core.ingest({ session: 's1', cwd: P, source: 'transcript', events: [{ ev: 'tool.start', call: 't1', tool: 'Read' }] });
  assert.equal(h.core.session('claude:s1').best, 'transcript');
  h.hook('s1', P, { ev: 'tool.start', call: 'h1', tool: 'Read' });
  assert.deepEqual(h.core.tailTargets(), []);
  const applied = h.core.status().events.applied;
  h.core.ingest({ session: 's1', cwd: P, source: 'transcript', events: [{ ev: 'tool.start', call: 't2', tool: 'Read' }] });
  assert.equal(h.core.status().events.applied, applied);
  assert.equal(h.core.status().events.ignored, 1);
});

test('setLiveSessions, not known: a sessions-file start; busy adds turn.start, waiting adds wait.start; no status adds nothing', () => {
  const h = harness();
  h.win('A', [P], 'all');
  h.clear();
  h.core.setLiveSessions([
    { session: 'b', cwd: P, pid: 1, status: 'busy' },
    { session: 'w1', cwd: P, pid: 2, status: 'waiting', waitingFor: 'approve a permission' },
    { session: 'w2', cwd: P, pid: 3, status: 'waiting', waitingFor: 'an answer' },
    { session: 'n', cwd: P, pid: 4 }
  ]);
  const r = h.records('A').map(e => e.session + ' ' + e.ev + (e.why ? ' ' + e.why : '') + ' ' + e.src + ' ' + e.grade);
  assert.deepEqual(r, [
    'b session.start sessions-file derived', 'b turn.start sessions-file derived',
    'w1 session.start sessions-file derived', 'w1 wait.start permission sessions-file derived',
    'w2 session.start sessions-file derived', 'w2 wait.start question sessions-file derived',
    'n session.start sessions-file derived'
  ]);
});

test('setLiveSessions, known with no hook: a status change gives turn and wait events; a hooked session\'s status gives none', () => {
  const h = harness();
  h.win('A', [P], 'all');
  const list = status => [{ session: 'f', cwd: P, pid: 1, status }, { session: 'h', cwd: P, pid: 2, status }];
  h.hook('h', P, start);
  h.core.setLiveSessions(list('idle'));
  h.clear();
  const step = status => { h.clear(); h.core.setLiveSessions(list(status)); return h.records('A').map(e => e.session + ' ' + e.ev); };
  assert.deepEqual(step('busy'), ['f turn.start']);
  assert.deepEqual(step('waiting'), ['f wait.start']);
  assert.deepEqual(step('idle'), ['f wait.end', 'f turn.end']);
  assert.deepEqual(step('idle'), []);
  assert.deepEqual(step(undefined), [], 'a missing status is not known: nothing');
  assert.deepEqual(step('busy'), ['f turn.start']);
});

test('setLiveSessions: a hook-first session gains its pid from the list, then ends (hub:gone) when it leaves the list', () => {
  const h = harness();
  h.win('A', [P], 'all');
  h.hook('s1', P, start);
  assert.equal(h.core.session('claude:s1').pid, null);
  h.core.setLiveSessions([], h.clock.now());
  assert.equal(h.core.session('claude:s1').ended, false, 'no pid: the list says nothing about it');
  h.core.setLiveSessions([{ agent: 'claude', session: 's1', key: 'claude:s1', cwd: P, pid: 4242, status: 'busy', procStart: '123' }]);
  assert.equal(h.core.session('claude:s1').pid, 4242);
  assert.equal(h.core.session('claude:s1').procStart, '123');
  h.clear();
  h.core.setLiveSessions([]);
  assert.equal(h.records('A').length, 0, 'one missed pass is not an end: the file may be mid-write');
  h.core.setLiveSessions([]);
  const end = h.records('A').find(e => e.ev === 'session.end');
  assert.equal(end.src, 'hub:gone'); assert.equal(end.grade, 'derived'); assert.equal(end.reason, 'gone');
  assert.equal(h.core.session('claude:s1').ended, true);
});

test('After session.end: a drop (ended) 20 s later, and the session is forgotten; an event before then cancels it', () => {
  const h = harness();
  h.win('A', [P], 'all');
  h.hook('s1', P, start, { ev: 'session.end', reason: 'other' });
  h.hook('s2', P, start, { ev: 'session.end', reason: 'other' });
  h.run(10000);
  h.hook('s2', P, { ev: 'tool.start', call: 'c9', tool: 'Grep' });     // s2 speaks again
  h.clear();
  h.run(contract.LIMITS.lingerMs - 10000 + 1);
  const drops = h.records('A').filter(r => r.ctl === 'drop');
  assert.deepEqual(drops.map(d => d.key + ' ' + d.why), ['claude:s1 ended']);
  assert.equal(h.core.session('claude:s1'), undefined);
  assert.deepEqual(h.forgot, ['claude:s1'], 'the normaliser forgets it too');
  assert.ok(h.core.session('claude:s2'));
  assert.equal(h.core.models.get('all').sessions.has('claude:s1'), false);
  h.run(60000);
  assert.ok(h.core.session('claude:s2'), 'the cancelled drop never comes');
});

test('A model refuses an event: counted as rejected and sent nowhere; a bad payload too', () => {
  const Boom = {
    create() { const m = M.create(); const apply = m.apply.bind(m); m.apply = e => { if (e.tool === 'Boom') throw new Error('refused'); apply(e); }; return m; },
    validate: M.validate, AGENT_KINDS: M.AGENT_KINDS
  };
  const h = harness({ options: { Model: Boom } });
  h.win('A', [P], 'all');
  h.hook('s1', P, start);
  h.clear();
  const seq = h.core.status().seq;
  h.hook('s1', P, { ev: 'tool.start', call: 'c2', tool: 'Boom' }, { ev: 'nonsense' });
  h.core.ingest('not an object');
  assert.equal(h.records('A').length, 0);
  assert.equal(h.core.status().events.rejected, 3);
  assert.equal(h.core.status().seq, seq, 'a refused event takes no seq');
});

test('Snapshots: attach with a scope gets the snapshot first; scope null gets no records', () => {
  const h = harness();
  h.win('A', [P], null);
  h.hook('s1', P, start);
  h.win('B', [OTHER], 'all');
  const first = h.sent.filter(x => x.id === 'B');
  assert.equal(first[0].message.type, 'workspaces');
  assert.equal(first[1].message.type, 'records');
  const snap = first[1].message.records[0];
  assert.deepEqual({ ctl: snap.ctl, epoch: snap.epoch, scope: snap.scope, seq: snap.seq }, { ctl: 'snapshot', epoch: 'abcd1234', scope: 'all', seq: 2 });
  assert.equal(M.load(snap.state).serialize(), h.core.models.get('all').serialize());
  h.hook('s1', P, { ev: 'tool.end', call: 'c1', tool: 'Read', ok: true });
  assert.equal(h.records('A').length, 0, 'a window with no scope gets no records');
  assert.equal(h.records('B').length, 2);
});

/* ---------- the rest the brief asks for ---------- */

test('A long simulator stream through the core equals the same stream applied to a model directly', () => {
  const events = F.createSim({ seed: 7, agents: 12, load: 'busy' }).advanceTo(10 * 60 * 1000);
  assert.ok(events.length > 2000);
  const sim = {
    feed(p) {
      const e = p.e, cwd = P + '/' + e.ws;
      return { agent: e.agent, session: e.session, key: e.agent + ':' + e.session, cwd, root: rootOf(cwd), source: 'hook', events: [Object.assign({}, e)] };
    },
    forget() {}
  };
  const h = harness({ normaliser: sim });
  h.win('A', [P], kP);
  h.win('B', [P], 'all');
  const direct = M.create();
  // The hub names the workspace on every start it delivers: here the one window-workspace, "A".
  for (const e of events) { direct.apply(e.ev === 'session.start' ? Object.assign({}, e, { space: 'A' }) : e); h.core.ingest({ e }, { t: e.t }); }
  const st = h.core.status();
  assert.equal(st.events.duplicates, 0, 'this seed has no repeats by the keys of 2.5');
  assert.equal(st.events.applied, events.length);
  const strip = text => text.replace(/"seq":\d+,?/g, '');
  assert.equal(strip(h.core.models.get(kP).serialize()), strip(direct.serialize()));
  assert.equal(strip(h.core.models.get('all').serialize()), strip(direct.serialize()));
  const seqs = h.records('A').filter(r => r.ev).map(r => r.seq);
  assert.equal(seqs.length, events.length);
  seqs.forEach((s, i) => assert.equal(s, i + 1, 'seq rises by one'));
});

test('A window that changes scope gets a snapshot first, then events of the new scope only', () => {
  const h = harness();
  h.win('A', [P], 'all'); h.win('B', [OTHER], null);
  h.hook('s1', P, start); h.hook('s2', OTHER, start);
  h.clear();
  h.core.update('A', { scope: kOther });
  h.hook('s1', P, { ev: 'tool.end', call: 'c1', tool: 'Read', ok: true });
  h.hook('s2', OTHER, { ev: 'tool.end', call: 'c1', tool: 'Read', ok: true });
  const r = h.records('A');
  assert.equal(r[0].ctl, 'snapshot'); assert.equal(r[0].scope, kOther);
  assert.deepEqual(r.slice(1).map(e => e.session), ['s2']);
  h.clear();
  h.core.update('A', { scope: kOther });
  assert.equal(h.records('A').length, 0, 'the same scope again: no new snapshot');
  h.core.update('A', { snapshot: true });
  assert.equal(h.records('A')[0].ctl, 'snapshot', 'snapshot: true sends one for the current scope');
  h.clear();
  h.core.update('B', { snapshot: true });
  assert.equal(h.records('B').length, 0, 'with scope null it does nothing');
});

test('A session moves owner when a deeper folder is opened in another window, and back when it closes', () => {
  const h = harness();
  h.win('A', [P], kP);
  h.hook('s1', DEEP + '/x', start);
  assert.deepEqual(h.core.session('claude:s1').owners, [kP]);
  h.clear();
  h.win('B', [DEEP], kDeep);
  assert.deepEqual(h.core.session('claude:s1').owners, [kDeep]);
  const toA = h.records('A');
  assert.deepEqual(toA.map(r => r.ctl || r.ev), ['drop'], 'the shallower workspace no longer shows it');
  assert.equal(h.core.models.get(kP).sessions.has('claude:s1'), false);
  assert.ok(M.load(h.records('B')[0].state).sessions.has('claude:s1'));
  assert.ok(h.core.models.get('all').sessions.has('claude:s1'), 'all keeps it');
  h.clear();
  h.core.detach('B');
  assert.deepEqual(h.core.session('claude:s1').owners, [kP]);
  assert.deepEqual(h.records('A').map(r => r.ev + ' ' + r.src), ['session.start hub:known']);
});

test('Hidden counts and needs in the workspaces message; the list is sorted by name, then key', () => {
  const h = harness();
  h.win('A', ['/home/example/zeta'], 'all', 'Code', 'zeta');
  h.win('B', ['/home/example/alpha'], null, 'Code', 'alpha');
  h.win('C', [P], null, 'Code', 'proj');
  h.hook('s1', P, start, { ev: 'wait.start', why: 'permission' });
  h.hook('s2', P, start);
  h.hook('s3', '/home/example/nowhere', start);
  h.hook('s4', '/home/example/nowhere2', start);
  h.core.flushWorkspaces();
  const ws = h.lastWs('A');
  assert.deepEqual(ws.list.map(x => x.name), ['alpha', 'proj', 'zeta']);
  const proj = ws.list.find(x => x.key === kP);
  assert.equal(proj.sessions, 2); assert.equal(proj.needs, 1);
  assert.equal(ws.hidden, 2); assert.equal(ws.scope, 'all');
  assert.equal(ws.total, 2); assert.equal(ws.totalNeeds, 1);
  for (const k of ['key', 'name', 'apps', 'windows', 'sessions', 'needs', 'folders']) assert.ok(k in proj);
  for (const k of ['list', 'hidden', 'scope', 'total', 'totalNeeds', 'watching', 'own']) assert.ok(k in ws, k);
});

test('Memory bounds: 500 sessions (the least recently active unowned first), and at most LIMITS.windows windows', () => {
  const h = harness();
  h.win('A', [P], null);
  h.hook('owned', P, start);
  for (let i = 0; i < MAX_SESSIONS + 10; i++) { h.clock.add(1); h.hook('u' + i, '/home/example/none', start); }
  assert.equal(h.core.status().sessions.known, MAX_SESSIONS);
  assert.ok(h.core.session('claude:owned'),'the owned session, oldest of all, stays');
  assert.equal(h.core.session('claude:u0'), undefined);
  assert.ok(h.core.session('claude:u' + (MAX_SESSIONS + 9)));
  for (let i = 1; i < contract.LIMITS.windows; i++) assert.ok(h.win('w' + i, [], null));
  assert.equal(h.win('one-too-many', [], null), null);
  assert.ok(h.win('A', [P], null), 'a window that is attached already may attach again');
});

test('The 30-minute silence rule ends a session with no pid (hub:silent)', () => {
  const h = harness();
  h.win('A', [P], 'all');
  h.hook('s1', P, start);
  h.core.setLiveSessions([{ session: 's2', cwd: P, pid: 9 }]);
  h.clock.add(contract.LIMITS.silentMs);
  h.clear();
  h.core.sweep();
  const ends = h.records('A').filter(e => e.ev === 'session.end');
  assert.deepEqual(ends.map(e => e.session + ' ' + e.src + ' ' + e.reason), ['s1 hub:silent silent']);
});

test('needsDiscovery is true only while some window shows a scope', () => {
  const h = harness();
  h.win('A', [P], null);
  assert.equal(h.core.needsDiscovery(), false);
  h.core.update('A', { scope: 'all' });
  assert.equal(h.core.needsDiscovery(), true);
  h.core.update('A', { scope: null });
  assert.equal(h.core.needsDiscovery(), false);
});

/* ---------- resolve (7.4) ---------- */

test('resolve: file group, one member, dir group, outside group, url, agent, unknown id, and a .. that tries to escape', () => {
  const ROOT = 'C:\\Users\\example\\proj';
  const h = harness();
  h.win('A', [ROOT], 'all');
  const touch = (call, extra) => ({ ev: 'resource.touch', call, op: 'read', ...extra });
  h.hook('s1', ROOT, start,
    touch('c1', { kind: 'file', path: 'src/a.js' }), touch('c1', { kind: 'file', path: 'src/b.js' }),
    touch('c1', { kind: 'dir', path: 'lib' }), touch('c1', { kind: 'file', path: { outside: true, name: 'x.txt' } }),
    touch('c1', { kind: 'url', url: 'https://example.com/docs/a' }),
    touch('c1', { kind: 'file', path: '../../evil/x.txt' }), touch('c1', { kind: 'file', path: 'src/..' }));
  const r = target => h.core.resolve(target);
  const file = r({ id: 'r:claude:s1:file:src/' });
  assert.equal(file.kind, 'file'); assert.equal(file.root, ROOT); assert.equal(file.folder, ROOT + '\\src');
  assert.deepEqual(file.members, [{ name: 'a.js', path: ROOT + '\\src\\a.js' }, { name: 'b.js', path: ROOT + '\\src\\b.js' }]);
  assert.deepEqual(r({ id: 'r:claude:s1:file:src/', member: 'b.js' }).members, [{ name: 'b.js', path: ROOT + '\\src\\b.js' }]);
  assert.deepEqual(r({ id: 'r:claude:s1:file:src/', member: 'zz.js' }), { kind: 'none' });
  assert.deepEqual(r({ id: 'r:claude:s1:file:lib/' }), { kind: 'dir', path: ROOT + '\\lib' });
  assert.deepEqual(r({ id: 'r:claude:s1:file:(outside the workspace)' }), { kind: 'outside' });
  assert.deepEqual(r({ id: 'r:claude:s1:url:example.com' }), { kind: 'url', urls: ['https://example.com/docs/a'] });
  const agent = r({ id: 'a:claude:s1' });
  assert.deepEqual(agent, { kind: 'session', agent: 'claude', session: 's1', cwd: ROOT, root: ROOT, pid: null });
  assert.deepEqual(r({ id: 'a:claude:nobody' }), { kind: 'none' });
  assert.deepEqual(r({ id: 'r:claude:nobody:file:src/' }), { kind: 'none' });
  assert.deepEqual(r({ id: 't:claude:s1:Read' }), { kind: 'none' });
  assert.deepEqual(r({ id: 42 }), { kind: 'none' });
  const escape = r({ id: 'r:claude:s1:file:../../evil/' });
  assert.deepEqual(escape, { kind: 'outside' }, 'a group with .. that leaves the root is never a path');
  // "src/.." gives the group "src/" and the member "..": that member is refused, the others stay.
  const all = r({ id: 'r:claude:s1:file:src/' });
  for (const m of all.members) assert.ok(contract.isInside(ROOT + '\\src', m.path) && m.name !== '..');
  assert.deepEqual(r({ id: 'r:claude:s1:file:src/', member: '..' }), { kind: 'none' });
});

test('resolve: a POSIX root gives POSIX paths', () => {
  const h = harness();
  h.win('A', [P], 'all');
  h.hook('s1', P, start, { ev: 'resource.touch', call: 'c1', kind: 'file', op: 'write', path: 'a/b/c.txt' });
  assert.deepEqual(h.core.resolve({ id: 'r:claude:s1:file:a/b/' }), { kind: 'file', root: P, folder: P + '/a/b', members: [{ name: 'c.txt', path: P + '/a/b/c.txt' }] });
});

test('resolve finds its session exactly: a session id with ":" is refused, and no id resolves under another session\'s root', () => {
  const h = harness();
  const A = '/home/example/a', B = '/home/example/b';
  h.win('W', [A, B], 'all');
  h.hook('x', A, start, { ev: 'resource.touch', call: 'c1', kind: 'file', op: 'read', path: 'sub/one.txt' });
  const before = h.core.status().events.rejected;
  // The reviewer's case: a session named so that its node ids start like those of session "x".
  h.core.ingest({ session: 'x:file:sub', cwd: B, events: [start, { ev: 'resource.touch', call: 'c1', kind: 'file', op: 'read', path: 'evil/two.txt' }] });
  assert.equal(h.core.status().events.rejected, before + 1, 'a session id with ":" is not a session');
  assert.equal(h.core.session('claude:x:file:sub'), undefined);
  assert.deepEqual(h.core.resolve({ id: 'r:claude:x:file:sub:file:evil/' }), { kind: 'none' });
  assert.deepEqual(h.core.resolve({ id: 'r:claude:x:file:sub/' }).members, [{ name: 'one.txt', path: A + '/sub/one.txt' }]);
  assert.deepEqual(h.core.resolve({ id: 'a:claude:x:extra' }), { kind: 'none' }, 'an agent id is exactly a:<agent>:<session>');
  assert.deepEqual(h.core.resolve({ id: 'r:nosuchagent:x:file:sub/' }), { kind: 'none' });
});

test('setLiveSessions refuses a hostile entry: a bad session id is skipped, a bad cwd is no cwd (known, owned by nobody)', () => {
  const h = harness();
  h.win('A', ['/'], 'all');                     // a window on the top of the file system would own any cwd
  h.core.setLiveSessions([
    { session: 'a:b', cwd: P, pid: 1 }, { session: '../x', cwd: P, pid: 2 }, { session: 'x'.repeat(200), cwd: P, pid: 3 },
    { session: 5, cwd: P, pid: 4 }, { session: '', cwd: P, pid: 5 },
    { session: 'ok1', cwd: 'relative/path', pid: 6 }, { session: 'ok2', cwd: '/' + 'a'.repeat(contract.MAX_PATH + 10), pid: 7 },
    { session: 'ok3', cwd: { toString: () => P }, pid: 8, procStart: 'not a number', transcript: 'relative.jsonl' }
  ]);
  const st = h.core.status();
  assert.equal(st.sessions.known, 3);
  for (const id of ['ok1', 'ok2', 'ok3']) {
    const s = h.core.session('claude:' + id);
    assert.equal(s.cwd, null); assert.deepEqual(s.owners, []);
  }
  assert.equal(h.core.session('claude:ok3').procStart, undefined);
  assert.equal(h.core.session('claude:ok3').transcript, null);
  assert.equal(st.sessions.hidden, 3);
  assert.deepEqual(h.core.tailTargets(), []);
});

test('a window on the top of a file system is listed as "(root)", not as its path', () => {
  const h = harness();
  h.win('A', ['/'], null, 'Code', '');
  h.win('B', ['C:\\'], null, 'Code', '');
  h.core.flushWorkspaces();
  assert.deepEqual(h.lastWs('A').list.map(x => x.name), ['(root)', '(root)']);
  assert.deepEqual(h.lastWs('A').list.map(x => x.folders), [['(root)'], ['(root)']]);
});

test('a duplicate key built from a long value stays short', () => {
  const h = harness();
  h.win('A', [P], 'all');
  const long = { ev: 'resource.touch', call: 'c1', kind: 'url', op: 'read', url: 'https://example.com/' + 'p'.repeat(5000) };
  h.hook('s1', P, long); h.hook('s1', P, long);
  assert.equal(h.core.status().events.duplicates, 1);
  for (const k of h.core.session('claude:s1').dupes) assert.ok(k.length <= 200, 'kept short: ' + k.length);
});

/* ---------- 0.1.1: a workspace is what one window has open ---------- */

test('A session in folder F is owned by window A (F alone) and window B (F and G): in both models, in all once', () => {
  const h = harness();
  const kA = kP, kB = contract.windowKey([P, OTHER]);
  h.win('X', ['/home/example/watch'], 'all');
  h.win('A', [P], kA);
  h.hook('s1', P + '/src', start);
  h.clear();
  h.win('B', [P, OTHER], kB);
  assert.deepEqual(h.core.session('claude:s1').owners, [kA, kB].sort());
  assert.deepEqual(h.records('X').map(e => e.ev + ' ' + e.space), ['session.info A, B'], 'all already holds it: no second start, only its new space');
  assert.ok(M.load(h.records('B')[0].state).sessions.has('claude:s1'), 'B\'s first snapshot holds it');
  for (const k of [kA, kB, 'all']) assert.ok(h.core.models.get(k).sessions.has('claude:s1'), k);
  h.core.flushWorkspaces();
  const ws = h.lastWs('X');
  assert.equal(ws.list.find(x => x.key === kA).sessions, 1);
  assert.equal(ws.list.find(x => x.key === kB).sessions, 1);
  assert.equal(ws.total, 1, 'counted once for "All open"');
  h.clear();
  h.hook('s1', P, { ev: 'tool.end', call: 'c1', tool: 'Read', ok: true });
  for (const id of ['X', 'A', 'B']) assert.deepEqual(h.records(id).map(e => e.ev), ['tool.end'], id + ' gets the event once');
  h.clear();
  h.core.detach('A');
  assert.deepEqual(h.core.session('claude:s1').owners, [kB]);
  for (const id of ['X', 'B']) assert.deepEqual(h.records(id).map(e => e.ev + ' ' + e.space), ['session.info B'], 'closing A only renames the space for ' + id);
  assert.equal(h.core.models.has(kA), false);
  assert.ok(h.core.models.get('all').sessions.has('claude:s1'));
  h.clear();
  h.core.detach('B');
  assert.deepEqual(h.records('X').map(r => r.ctl + ' ' + r.why), ['drop workspace-closed']);
  assert.equal(h.core.models.get('all').sessions.has('claude:s1'), false);
});

test('Adding a folder changes a window\'s key: it follows its own workspace; a window that showed the old key goes to all', () => {
  const h = harness();
  const G = '/home/example/g';
  h.win('A', [P], kP);
  h.win('V', [OTHER], kP);                  // V shows A's workspace
  h.hook('s1', P, start);
  h.clear();
  h.core.update('A', { folders: [{ path: P, name: 'proj' }, { path: G, name: 'g' }] });
  const kNew = contract.windowKey([P, G]);
  assert.equal(h.core.models.has(kP), false, 'the old workspace is gone');
  assert.deepEqual(h.core.session('claude:s1').owners, [kNew]);
  const a = h.records('A'), v = h.records('V');
  assert.equal(a[0].ctl, 'snapshot'); assert.equal(a[0].scope, kNew, 'A follows its own workspace');
  assert.ok(M.load(a[0].state).sessions.has('claude:s1'));
  assert.equal(v[0].ctl, 'snapshot'); assert.equal(v[0].scope, 'all', 'V goes to all');
  h.core.flushWorkspaces();
  assert.equal(h.lastWs('A').own, kNew); assert.equal(h.lastWs('A').scope, kNew);
});

test('Adding a folder while another window keeps the old set: the window still follows its own workspace', () => {
  const h = harness();
  const G = '/home/example/g';
  h.win('A', [P], kP); h.win('C', [P], kP);
  h.clear();
  h.core.update('A', { folders: [P, G].map(p => ({ path: p })) });
  assert.ok(h.core.models.has(kP), 'C still holds the old set');
  assert.equal(h.records('A')[0].scope, contract.windowKey([P, G]));
  assert.deepEqual(h.records('C'), [], 'C is not moved');
});

test('scopeOf: all; a workspace key; a folder key (own window, else fewest folders, else smallest key); else all', () => {
  const h = harness();
  const F = '/home/example/f', G = '/home/example/g', H = '/home/example/h', Z = '/home/example/z';
  const kF = contract.wsKey(F), kG = contract.wsKey(G), kH = contract.wsKey(H);
  h.win('A', [F], null); h.win('B', [F, G], null); h.win('C', [G, H], null); h.win('D', [Z], null); h.win('E', [G, H, Z], null);
  const kB = contract.windowKey([F, G]), kC = contract.windowKey([G, H]);
  const scopeAfter = (id, scope) => { h.core.update(id, { scope }); h.core.flushWorkspaces(); return h.lastWs(id).scope; };
  assert.equal(scopeAfter('D', 'all'), 'all');
  assert.equal(scopeAfter('D', kB), kB, 'a workspace key');
  assert.equal(scopeAfter('B', kG), kB, 'a folder key this window holds: its own (a 0.1.0 host\'s first-folder key)');
  assert.equal(scopeAfter('D', kH), kC, 'held by C and E: C has fewer folders');
  assert.equal(scopeAfter('A', kG), [kB, kC].sort()[0], 'held by B and C, both with two folders: the smaller key');
  assert.equal(scopeAfter('D', 'abcdef012345'), 'all', 'anything else');
  // Pinned corner: B (F and G) asking for wsKey(F) gets A's workspace, because kF IS a workspace key.
  assert.equal(scopeAfter('B', kF), kF);
  const snap = h.records('B').filter(r => r.ctl === 'snapshot').pop();
  assert.equal(snap.scope, kF, 'the snapshot carries the resolved key');
  // A scope given at attach is resolved the same way.
  h.win('Old', [G, H], kG);
  assert.equal(h.records('Old')[0].scope, kC);
});

test('A re-attach keeps its place: the workspace is still named after the window that attached first', () => {
  const h = harness();
  h.win('A', [P, OTHER], null, 'Code', 'First');
  h.win('C', [OTHER, P], null, 'Code', 'Second');
  h.win('A', [P, OTHER], null, 'Code', 'First');
  h.core.flushWorkspaces();
  assert.deepEqual(h.lastWs('C').list.map(x => x.name), ['First']);
});

test('A deeper folder takes a session from two windows at once: each drops it, all keeps it with no second start', () => {
  const h = harness();
  h.win('X', ['/home/example/watch'], 'all');
  h.win('A', [P], kP);
  h.win('B', [P, OTHER], contract.windowKey([P, OTHER]));
  h.hook('s1', DEEP + '/x', start);
  h.clear();
  h.win('C', [DEEP], kDeep);
  assert.deepEqual(h.core.session('claude:s1').owners, [kDeep]);
  assert.deepEqual(h.records('A').map(r => r.ctl + ' ' + r.key), ['drop claude:s1']);
  assert.deepEqual(h.records('B').map(r => r.ctl + ' ' + r.key), ['drop claude:s1']);
  assert.deepEqual(h.records('X').map(e => e.ev + ' ' + e.space), ['session.info C'], 'all holds it throughout, and learns its new space');
  assert.ok(M.load(h.records('C')[0].state).sessions.has('claude:s1'));
});

test('watching flips with the first scope asked for and the last one dropped, and goes out each time', () => {
  const h = harness();
  h.win('A', [P], null); h.win('B', [OTHER], null);
  h.core.flushWorkspaces();
  assert.equal(h.lastWs('A').watching, false); assert.equal(h.lastWs('B').watching, false);
  h.clear();
  h.core.update('A', { scope: 'all' });
  h.core.flushWorkspaces();
  assert.equal(h.lastWs('A').watching, true); assert.equal(h.lastWs('B').watching, true, 'B is told too');
  h.clear();
  h.core.update('A', { scope: null });
  h.core.flushWorkspaces();
  assert.equal(h.lastWs('A').watching, false); assert.equal(h.lastWs('B').watching, false);
  h.clear();
  h.win('C', [P], 'all');
  h.core.flushWorkspaces();
  assert.equal(h.lastWs('B').watching, true, 'a window attaching with a scope flips it as well');
  h.clear();
  h.core.detach('C');
  h.core.flushWorkspaces();
  assert.equal(h.lastWs('B').watching, false, 'and its leaving flips it back');
});

test('total and totalNeeds count each owned live session once; needs are read from an owner\'s model', () => {
  const h = harness();
  h.win('A', [P], null); h.win('B', [P, OTHER], null);
  h.hook('s1', P, start, { ev: 'wait.start', why: 'question' });
  h.hook('s2', OTHER, start);
  h.hook('s3', '/home/example/elsewhere', start);
  h.core.flushWorkspaces();
  const ws = h.lastWs('A');
  assert.equal(ws.total, 2); assert.equal(ws.totalNeeds, 1); assert.equal(ws.hidden, 1);
  const kB = contract.windowKey([P, OTHER]);
  assert.deepEqual([ws.list.find(x => x.key === kP).sessions, ws.list.find(x => x.key === kP).needs], [1, 1]);
  assert.deepEqual([ws.list.find(x => x.key === kB).sessions, ws.list.find(x => x.key === kB).needs], [2, 1]);
});

/* ---------- 0.1.1: the title of a session's tab ---------- */

test('Titles: a fresh session starts with its title; a change gives one session.info to all and each owner; the same gives none; gone gives ""', () => {
  const h = harness();
  h.win('X', ['/home/example/watch'], 'all');
  h.win('A', [P], kP);
  h.win('B', [P, OTHER], contract.windowKey([P, OTHER]));
  const entry = title => ({ agent: 'claude', session: 't1', key: 'claude:t1', cwd: P, pid: 5, title });
  h.clear();
  h.core.setLiveSessions([entry('Fix the parser')]);
  const startX = h.records('X').find(e => e.ev === 'session.start');
  assert.equal(startX.title, 'Fix the parser'); assert.deepEqual(startX.root, { name: 'proj' });
  const step = title => { h.clear(); h.core.setLiveSessions([entry(title)]); return ['X', 'A', 'B'].map(id => h.records(id).filter(e => e.ev === 'session.info' && 'title' in e).map(e => e.title)); };
  assert.deepEqual(step('Fix the parser'), [[], [], []], 'the same title again: nothing');
  assert.deepEqual(step('Write the tests'), [['Write the tests'], ['Write the tests'], ['Write the tests']], 'one event for all and each owner');
  const e = h.records('X')[0];
  assert.deepEqual([e.grade, e.src], ['derived', 'sessions-file']);
  assert.deepEqual(step(undefined), [[''], [''], ['']], 'a title that goes away');
  assert.deepEqual(step(undefined), [[], [], []]);
  assert.equal(h.core.models.get('all').nodes.get('a:claude:t1').title, '');
});

test('Titles: a session a hook reports for still gets its title from the list', () => {
  const h = harness();
  h.win('A', [P], 'all');
  h.hook('t2', P, start);
  h.clear();
  h.core.setLiveSessions([{ agent: 'claude', session: 't2', key: 'claude:t2', cwd: P, pid: 6, title: 'Hooked' }]);
  assert.deepEqual(h.records('A').map(e => e.ev + ' ' + e.title), ['session.info Hooked']);
  assert.equal(h.core.models.get('all').nodes.get('a:claude:t2').title, 'Hooked');
});

test('Titles: a session put into a newly attached window\'s model carries its title on the hub:known start', () => {
  const h = harness();
  h.win('X', ['/home/example/watch'], 'all');
  h.core.setLiveSessions([{ agent: 'claude', session: 't3', key: 'claude:t3', cwd: P, pid: 7, title: 'Later' }]);
  h.clear();
  h.win('A', [P], kP);
  const start3 = h.records('X').find(e => e.ev === 'session.start');
  assert.equal(start3.src, 'hub:known'); assert.equal(start3.title, 'Later');
  assert.equal(M.load(h.records('A')[0].state).nodes.get('a:claude:t3').title, 'Later', 'in the new window\'s first snapshot');
});

test('Titles: a title that is not a string or is too long is ignored; every event made passes validate', () => {
  const h = harness();
  h.win('A', [P], 'all');
  h.core.setLiveSessions([
    { agent: 'claude', session: 'u1', key: 'claude:u1', cwd: P, pid: 8, title: 42 },
    { agent: 'claude', session: 'u2', key: 'claude:u2', cwd: P, pid: 9, title: 'x'.repeat(121) },
    { agent: 'claude', session: 'u3', key: 'claude:u3', cwd: P, pid: 10, title: 'x'.repeat(120) }
  ]);
  const starts = Object.fromEntries(h.records('A').filter(e => e.ev === 'session.start').map(e => [e.session, e.title]));
  assert.deepEqual(starts, { u1: undefined, u2: undefined, u3: 'x'.repeat(120) });
  assert.equal(h.core.session('claude:u1').title, undefined);
  h.core.setLiveSessions([
    { agent: 'claude', session: 'u1', key: 'claude:u1', cwd: P, pid: 8, title: { bad: true } },
    { agent: 'claude', session: 'u2', key: 'claude:u2', cwd: P, pid: 9, title: 'Now fine' },
    { agent: 'claude', session: 'u3', key: 'claude:u3', cwd: P, pid: 10, title: 'x'.repeat(500) }
  ]);
  for (const e of h.records('A').filter(r => r.ev)) assert.doesNotThrow(() => M.validate(e), e.ev);
  assert.deepEqual(h.records('A').filter(e => e.ev === 'session.info' && 'title' in e).map(e => e.session + ' ' + e.title), ['u2 Now fine', 'u3 ']);
});

/* ---------- 0.1.1: the name of the workspace a session works in ---------- */

test('Space: every start names the window, not a folder: from the list, from a hook\'s own start, and a hub-made one', () => {
  const h = harness();
  h.win('W', [P, OTHER], 'all', 'Code', 'Example Shop (Workspace)');
  h.core.setLiveSessions([{ agent: 'claude', session: 'p1', key: 'claude:p1', cwd: P, pid: 3 }]);
  h.core.ingest({ session: 'p2', cwd: OTHER, events: [{ ev: 'session.start', source: 'startup' }] });
  h.hook('p3', OTHER, start);
  const starts = h.records('W').filter(e => e.ev === 'session.start');
  assert.deepEqual(starts.map(e => e.session + ' ' + e.src + ' ' + e.space), ['p1 sessions-file Example Shop', 'p2 hook:Test Example Shop', 'p3 hub:known Example Shop']);
  assert.equal(h.core.models.get('all').nodes.get('a:claude:p1').space, 'Example Shop');
  for (const e of h.records('W').filter(r => r.ev)) assert.doesNotThrow(() => M.validate(e));
});

test('Space: two owners give both names; closing one sends one session.info with the other to all and its model; unchanged sends nothing', () => {
  const h = harness();
  const kB = contract.windowKey([P, OTHER]);
  h.win('X', ['/home/example/watch'], 'all', 'Code', 'Watch');
  h.win('A', [P], kP, 'Code', 'Zeta Shop');
  h.win('B', [P, OTHER], kB, 'Code', 'Alpha Site');
  h.hook('p1', P, start);
  assert.equal(h.records('X').find(e => e.ev === 'session.start').space, 'Alpha Site, Zeta Shop');
  h.clear();
  h.win('Y', ['/home/example/elsewhere'], null, 'Code', 'Elsewhere');
  assert.deepEqual(h.records('X').filter(e => e.ev === 'session.info'), [], 'an unrelated window: the space is unchanged, nothing is sent');
  h.clear();
  h.core.detach('A');
  const infos = id => h.records(id).filter(e => e.ev === 'session.info').map(e => e.space);
  assert.deepEqual(infos('X'), ['Alpha Site'], 'all learns the remaining name, once');
  assert.deepEqual(infos('B'), ['Alpha Site'], 'and so does the remaining window\'s model');
  assert.equal(h.core.models.get(kB).nodes.get('a:claude:p1').space, 'Alpha Site');
  assert.equal(h.core.models.get('all').nodes.get('a:claude:p1').space, 'Alpha Site');
  for (const id of ['X', 'B']) for (const e of h.records(id).filter(r => r.ev)) assert.doesNotThrow(() => M.validate(e));
});

test('Space: a workspace renamed because its first window left sends the new name', () => {
  const h = harness();
  h.win('X', ['/home/example/watch'], 'all', 'Code', 'Watch');
  h.win('A', [P], null, 'Code', 'First');
  h.win('C', [P], null, 'Code', 'Second');
  h.hook('p1', P, start);
  h.clear();
  h.core.detach('A');
  assert.deepEqual(h.records('X').filter(e => e.ev === 'session.info').map(e => e.space), ['Second']);
});

test('status has every field of 7.4', () => {
  const h = harness();
  const st = h.core.status();
  for (const k of ['epoch', 'upMs', 'role', 'windows', 'workspaces', 'sessions', 'events', 'sources', 'tails', 'lastHookAt', 'off']) assert.ok(k in st, k);
  for (const k of ['received', 'applied', 'duplicates', 'rejected', 'tooLarge']) assert.ok(k in st.events, k);
  for (const k of ['hook', 'transcript', 'sessionsFile']) assert.ok(k in st.sources, k);
  for (const k of ['known', 'shown', 'hidden']) assert.ok(k in st.sessions, k);
});
