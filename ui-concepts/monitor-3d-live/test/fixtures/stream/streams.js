// Recorded streams for the page tests: what the hub would send, made in Node from the mock-up's
// seeded simulator (ui-concepts/monitor-3d/feed.js) and the live model (media/model.js), so the
// same seed always gives the same sessions, slots and snapshot text. Nothing here is real: the
// simulator's files, URLs and servers are invented, and so are the folder names and workspace keys below.
//
// The simulator speaks for four agents, one after the other. Every session is renamed "claude" except
// those in `keep` (by default the second session, which stays the simulator's own Codex), so a scene has
// two providers. Each session is named after an invented folder code, as a card's worktree is
// (session.start's `root`), and numbered (`seq`) as the hub numbers events. With `named` (the
// default) its session.start also carries the window's title (`space`) and its tab's title (`title`), as
// a 0.1.1 hub sends them; `named: false` gives the 0.1.0 shape, with neither. A session in `derived`
// reads as one with no collector: its calls come from the transcript (`grade: "derived"`).
'use strict';
const path = require('node:path');
const M = require('../../../media/model.js');
const F = require(path.join(__dirname, '..', '..', '..', '..', 'monitor-3d', 'feed.js'));

const FOLDERS = ['c0ffee', 'b16b00', 'a1c3e5', 'd00d42', 'f4ce11', 'e7a9b0', '9d8c7b', '5a6b7c', '3e2d1c', '0f1e2d', '7b8a96', '4c5d6e'];
const SPACES = ['Demo Shop', 'Notes App', 'Demo Shop', 'Site Docs', 'Tiny Queue', 'Pixel Forge', 'Weather CLI', 'Recipe Box', 'Chat Relay', 'Map Tiles', 'Log Sieve', 'Form Kit'];
const TITLES = ['Fix the checkout total', 'Add dark mode to the notes list', 'Speed up the product search', 'Rewrite the install guide', 'Retry failed jobs once',
  'Sprite sheet export', 'Hourly forecast table', 'Import recipes from a file', 'Reconnect after sleep', 'Cache map tiles on disk', 'Filter logs by level', 'Validate the sign-up form'];
/* Workspace keys are 12 hex characters, as contract.wsKey makes them; these are made up. */
const KEYS = { shop: '5d1e0c7a9b21', notes: '8f3a62c4d0e7', docs: 'c09b7e15a4f3', extra: ['11aa22bb33cc', '44dd55ee66ff', '7a8b9c0d1e2f', '9e8d7c6b5a40', 'b1c2d3e4f5a6'] };
const EPOCH = 'a1b2c3d4';

/** A stream that can be read on: `events` up to `ms`, then `more(ms)` for what follows, renamed the same way. */
function stream({ agents = 4, ms = 90000, seed = 7, derived = [], keep = [1], named = true } = {}) {
  const sim = F.createSim({ seed, agents, load: 'busy' });
  const indexOf = new Map(), slowOf = new Set(), kept = new Set();
  let seq = 0, started = 0;
  const rename = e => {
    const key = e.agent + ':' + e.session;
    if (e.ev === 'session.start' && !indexOf.has(key)) {
      const index = started++;
      indexOf.set(key, index);
      if (derived.includes(index)) slowOf.add(key);
      if (keep.includes(index)) kept.add(key);
    }
    const out = Object.assign({}, e, { agent: kept.has(key) ? e.agent : 'claude', seq: ++seq });
    if (e.ev === 'session.start') {
      const index = indexOf.get(key) || 0;
      out.root = { name: FOLDERS[index % FOLDERS.length] };
      if (out.model) out.model = 'sim-' + out.agent + '-model';
      if (named) { out.space = SPACES[index % SPACES.length]; out.title = TITLES[index % TITLES.length]; }
    }
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
function scene({ agents = 4, ms = 90000, seed = 7, scope = KEYS.shop, derived = [1, 3], keep = [1], named = true } = {}) {
  const s = stream({ agents, ms, seed, derived, keep, named });
  const model = modelOf(s.events);
  return { stream: s, model, scope, message: snapshotRecords(scope, model, s.lastSeq()) };
}

/* The folders each window has open, in the 0.1.1 shape: demo-shop's one folder has its own name,
   notes-app is a workspace file with two folders, site-docs's one folder is named otherwise. */
const WINDOW_FOLDERS = { [KEYS.shop]: ['demo-shop'], [KEYS.notes]: ['notes-app', 'notes-api'], [KEYS.docs]: ['docs-site'] };

/**
 * A "workspaces" message: three workspaces, this window's own among them.
 * By default the 0.1.0 shape, with none of the fields 0.1.1 added. `v011: true` adds `folders` to each
 * entry and `watching`; `total`, `totalNeeds` and `own` are added only when given, so each can be
 * tested missing.
 */
function workspaces({ scope = KEYS.shop, here = [KEYS.docs], hidden = 0, counts = {}, extra = 0, v011 = false, total, totalNeeds, own, watching = true } = {}) {
  const list = [
    { key: KEYS.shop, name: 'demo-shop', apps: ['VS Code'], windows: 1, sessions: 4, needs: 1 },
    { key: KEYS.notes, name: 'notes-app', apps: ['VS Code', 'VSCodium'], windows: 2, sessions: 2, needs: 0 },
    { key: KEYS.docs, name: 'site-docs', apps: ['VS Code'], windows: 1, sessions: 0, needs: 0 }
  ];
  for (let i = 0; i < extra; i++) list.push({ key: KEYS.extra[i], name: 'a-rather-long-workspace-name-' + (i + 1), apps: ['Code - OSS'], windows: 1, sessions: i, needs: i % 2 });
  for (const w of list) if (counts[w.key] != null) w.sessions = counts[w.key];
  const message = { v: 1, type: 'workspaces', list, hidden, scope, here };
  if (v011) {
    for (const w of list) w.folders = WINDOW_FOLDERS[w.key] || [w.name];
    message.watching = watching;
  }
  if (total !== undefined) message.total = total;
  if (totalNeeds !== undefined) message.totalNeeds = totalNeeds;
  if (own !== undefined) message.own = own;
  return message;
}

function hub(state, role, collector) {
  return { v: 1, type: 'hub', state, role, collectors: collector ? { claude: collector } : {} };
}

module.exports = { FOLDERS, SPACES, TITLES, KEYS, EPOCH, stream, modelOf, snapshotRecords, eventRecords, dropRecords, scene, workspaces, hub };
