// Recorded streams for the page tests: what the hub would send, made in Node from the mock-up's
// seeded simulator (ui-concepts/monitor-3d/feed.js) and the live model (media/model.js), so the
// same seed always gives the same sessions, slots and snapshot text. Nothing here is real: the
// simulator's files, URLs and servers are invented, and so are the folder names and workspace keys below.
//
// The simulator speaks for four agents; this slice is Claude Code only, so every session is
// renamed "claude", named after an invented folder (session.start's `root`), and numbered (`seq`)
// as the hub numbers events. A session in `derived` reads as one with no collector: its calls come
// from the transcript (`grade: "derived"`, `src: "transcript:<Event>"`).
'use strict';
const path = require('node:path');
const M = require('../../../media/model.js');
const F = require(path.join(__dirname, '..', '..', '..', '..', 'monitor-3d', 'feed.js'));

const FOLDERS = ['demo-shop', 'notes-app', 'api-gateway', 'site-docs', 'tiny-queue', 'pixel-forge', 'weather-cli', 'recipe-box', 'chat-relay', 'map-tiles', 'log-sieve', 'form-kit'];
/* Workspace keys are 12 hex characters, as contract.wsKey makes them; these are made up. */
const KEYS = { shop: '5d1e0c7a9b21', notes: '8f3a62c4d0e7', docs: 'c09b7e15a4f3', extra: ['11aa22bb33cc', '44dd55ee66ff', '7a8b9c0d1e2f', '9e8d7c6b5a40', 'b1c2d3e4f5a6'] };
const EPOCH = 'a1b2c3d4';

/** A stream that can be read on: `events` up to `ms`, then `more(ms)` for what follows, renamed the same way. */
function stream({ agents = 4, ms = 90000, seed = 7, derived = [] } = {}) {
  const sim = F.createSim({ seed, agents, load: 'busy' });
  const folderOf = new Map(), slowOf = new Set();
  let seq = 0, started = 0;
  const rename = e => {
    const out = Object.assign({}, e, { agent: 'claude', seq: ++seq });
    const key = e.agent + ':' + e.session;
    if (e.ev === 'session.start' && !folderOf.has(key)) {
      const index = started++;
      folderOf.set(key, FOLDERS[index % FOLDERS.length]);
      if (derived.includes(index)) slowOf.add(key);
    }
    if (e.ev === 'session.start') { out.root = { name: folderOf.get(key) || 'unnamed' }; if (out.model) out.model = 'sim-claude-model'; }
    if (slowOf.has(key) && typeof out.src === 'string' && out.src.startsWith('hook:')) { out.src = 'transcript:' + out.src.slice(5); out.grade = 'derived'; }
    return out;
  };
  const events = sim.advanceTo(ms).map(rename);
  let at = ms;
  return { events, more(extra) { at += extra; return sim.advanceTo(at).map(rename); }, lastSeq: () => seq };
}

/** The hub's model of a stream, and its snapshot text. */
function modelOf(events) {
  const model = M.create();
  for (const e of events) { try { model.apply(e); } catch (error) { /* the hub counts a refusal and sends it nowhere */ } }
  return model;
}

function snapshotRecords(scope, model, seq) {
  return { v: 1, type: 'records', scope, records: [{ ctl: 'snapshot', epoch: EPOCH, seq: seq || 0, scope, state: model.serialize() }] };
}
function eventRecords(scope, events) { return { v: 1, type: 'records', scope, records: events }; }
function dropRecords(scope, key, why) { return { v: 1, type: 'records', scope, records: [{ ctl: 'drop', key, why: why || 'ended' }] }; }

/** A ready-made scene: `agents` sessions in one scope, as the first message a page gets. */
function scene({ agents = 4, ms = 90000, seed = 7, scope = KEYS.shop, derived = [1, 3] } = {}) {
  const s = stream({ agents, ms, seed, derived });
  const model = modelOf(s.events);
  return { stream: s, model, scope, message: snapshotRecords(scope, model, s.lastSeq()) };
}

/** A "workspaces" message: three workspaces, this window's own folder among them. */
function workspaces({ scope = KEYS.shop, here = [KEYS.docs], hidden = 0, counts = {}, extra = 0 } = {}) {
  const list = [
    { key: KEYS.shop, name: 'demo-shop', apps: ['VS Code'], windows: 1, sessions: 4, needs: 1 },
    { key: KEYS.notes, name: 'notes-app', apps: ['VS Code', 'VSCodium'], windows: 2, sessions: 2, needs: 0 },
    { key: KEYS.docs, name: 'site-docs', apps: ['VS Code'], windows: 1, sessions: 0, needs: 0 }
  ];
  for (let i = 0; i < extra; i++) list.push({ key: KEYS.extra[i], name: 'a-rather-long-workspace-name-' + (i + 1), apps: ['Code - OSS'], windows: 1, sessions: i, needs: i % 2 });
  for (const w of list) if (counts[w.key] != null) w.sessions = counts[w.key];
  return { v: 1, type: 'workspaces', list, hidden, scope, here };
}

function hub(state, role, collector) {
  return { v: 1, type: 'hub', state, role, collectors: collector ? { claude: collector } : {} };
}

module.exports = { FOLDERS, KEYS, EPOCH, stream, modelOf, snapshotRecords, eventRecords, dropRecords, scene, workspaces, hub };
