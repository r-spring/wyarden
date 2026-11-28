/* Wyarden 3D monitor, preview: a stand-in for the editor, so the live tab's own page runs in a browser.
 *
 * tools/preview.js puts this script, and the older page's seeded simulator (ui-concepts/monitor-3d/feed.js,
 * loaded from where it is), before the page's own scripts. It lives in tools/, so the VSIX never carries it
 * (tools/pack.js ships package.json, extension.js, README.md, lib/ and media/ only).
 *
 * It does for the page what VS Code and the extension host do (lib/view.js, lib/hub-core.js):
 *   - acquireVsCodeApi(): postMessage, getState, setState, once only, as in VS Code;
 *   - on "ready": the look for the browser's colour scheme, the hub's state, the workspace chips, then one
 *     snapshot of the scope shown ("all", as a new tab has it);
 *   - then the stream, as "records" for the scope shown; an ended session leaves 20 s later with a "drop";
 *   - a chip ("scope") gets the chips again and a snapshot of that scope; "select" and "act" do nothing here.
 *
 * Everything shown is invented: the simulator's sessions, tools, files, addresses and MCP servers, and two
 * invented editor windows. Claude and Grok sessions work in the first window, Codex and Antigravity in the
 * second, so each chip shows two providers and "All open" shows four.
 *
 * The address carries the choices (there is no control for them in the page):
 *   ?look=<id>             open on that look (an id that is not in media/looks.js is ignored)
 *   ?seed=<integer>        the simulator's seed, 7 by default
 *   ?agents=1|4|12         sessions at once, 4 by default
 *   ?load=quiet|busy       busy by default
 *   ?warm=<seconds>        stream run before the first snapshot, 0 to 600, 60 by default
 */
(function () {
  'use strict';
  const F = window.MonitorFeed;
  if (!F) throw new Error('preview: the simulator (feed.js) did not load before the stand-in');

  /* ---------- the choices in the address ---------- */

  const params = new URLSearchParams(location.search);
  const oneOf = (value, list, fallback) => (list.includes(value) ? value : fallback);
  const seedText = params.get('seed'), warmText = params.get('warm');
  const options = {
    seed: seedText && Number.isInteger(Number(seedText)) ? Number(seedText) : 7,
    agents: oneOf(Number(params.get('agents')), F.PRESETS.agents, 4),
    load: oneOf(params.get('load'), F.PRESETS.load, 'busy'),
    warm: warmText !== null && Number.isFinite(Number(warmText)) ? Math.max(0, Math.min(600, Number(warmText))) : 60,
    look: params.get('look') || ''
  };
  /** The look named in the address, when the registry has it. Asked when the page reads its state, after looks.js has loaded. */
  function lookAsked() {
    const R = window.MonitorLookRegistry, looks = window.MonitorLooks || {};
    return options.look && R && R.entry(options.look) && Object.prototype.hasOwnProperty.call(looks, options.look) ? options.look : '';
  }

  /* ---------- the two invented windows ---------- */

  const ALL = 'all', LINGER_MS = 20000;            // as lib/contract.js: an ended session stays this long
  const WINDOWS = [
    { key: '3c9a1f02d4e7', name: 'demo-shop', space: 'Demo Shop', apps: ['VS Code'], kinds: ['claude', 'grok'] },
    { key: 'b81e6d30a5c2', name: 'notes-app', space: 'Notes App', apps: ['Cursor'], kinds: ['codex', 'antigravity'] }
  ];
  const OWN = WINDOWS[0].key;                      // the window this tab stands in
  const windowOf = kind => WINDOWS.find(w => w.kinds.includes(kind)) || WINDOWS[0];
  const TITLES = ['Fix the checkout total', 'Add dark mode to the notes list', 'Rewrite the install guide', 'Retry failed jobs once',
    'Speed up the search page', 'Tidy the release script', 'Add a test for the cart', 'Find why the build is slow',
    'Rename the settings keys', 'Explain the router', 'Move the logo into assets', 'Check the broken links'];
  const titleOf = session => { let h = 0; for (const c of session) h = (h * 31 + c.charCodeAt(0)) >>> 0; return TITLES[h % TITLES.length]; };

  /* ---------- the editor's API ---------- */

  let pageState = null, taken = false;
  const copy = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  window.acquireVsCodeApi = () => {
    if (taken) throw new Error('acquireVsCodeApi may be called only once');      // as in VS Code
    taken = true;
    return Object.freeze({
      postMessage: message => { const m = copy(message); setTimeout(() => fromPage(m), 0); },
      getState: () => { if (pageState === null) { const look = lookAsked(); if (look) pageState = { v: 1, look, lookChosen: true }; } return copy(pageState); },
      setState: next => { pageState = copy(next); keepAddress(pageState); return next; }
    });
  };
  /** A look the owner chose goes into the address, so a reload or a copied address opens on it. */
  function keepAddress(s) {
    if (!s || !s.lookChosen || typeof s.look !== 'string' || params.get('look') === s.look) return;
    params.set('look', s.look);
    try { history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash); } catch (error) { /* the address is a convenience */ }
  }
  const toPage = message => window.postMessage(Object.assign({ v: 1 }, message), location.origin);
  document.addEventListener('DOMContentLoaded', () => { document.title = '3D Monitor: preview on invented data'; });

  /* ---------- the hub: three models, one for each scope ---------- */

  const seen = { events: 0, ev: {}, failed: 0, waits: 0, touches: {}, providers: {} };
  let models = null, scope = ALL, seq = 0, queue = [], flushing = false, lastChips = '', feed = null, live = false;
  const ended = new Map();                         // session key -> { t, win }

  function modelsFor(win) { return [models[ALL], models[win.key]]; }
  function shows(winKey) { return scope === ALL || scope === winKey; }
  function onEvent(raw) {
    const win = windowOf(raw.agent), e = Object.assign({}, raw, { ws: win.key });
    if (e.ev === 'session.start') { e.space = win.space; e.title = titleOf(e.session); }
    count(e);
    for (const m of modelsFor(win)) { try { m.apply(e); } catch (error) { m.counts.rejected++; } }
    const key = e.agent + ':' + e.session;
    if (e.ev === 'session.end') ended.set(key, { t: e.t, win: win.key });
    else if (ended.has(key)) ended.delete(key);
    if (live && shows(win.key)) queue.push(e);
    for (const [k, x] of [...ended]) {
      if (e.t < x.t + LINGER_MS) continue;
      ended.delete(k);
      for (const m of [models[ALL], models[x.win]]) m.drop(k);
      if (live && shows(x.win)) queue.push({ ctl: 'drop', key: k, why: 'ended' });
    }
    if (live && !flushing) { flushing = true; queueMicrotask(flush); }
  }
  function count(e) {
    seen.events++; seen.ev[e.ev] = (seen.ev[e.ev] || 0) + 1; seen.providers[e.agent] = true;
    if (e.ok === false) seen.failed++;
    if (e.ev === 'wait.start' && e.why !== 'idle') seen.waits++;
    if (e.ev === 'resource.touch') seen.touches[e.kind] = (seen.touches[e.kind] || 0) + 1;
  }
  function flush() {
    flushing = false;
    if (queue.length) { toPage({ type: 'records', scope, records: queue }); queue = []; }
    sendChips(false);
  }
  function figures(m) {
    let needs = 0;
    for (const n of m.nodes.values()) if (n.cls === 'agent' && n.status === 'needs') needs++;
    return { sessions: m.sessions.size, needs };
  }
  function sendChips(always) {
    const list = WINDOWS.map(w => Object.assign({ key: w.key, name: w.name, apps: w.apps, windows: 1, folders: [w.name] }, figures(models[w.key])));
    const all = figures(models[ALL]);
    const message = { type: 'workspaces', list, hidden: 0, scope, here: [OWN], own: OWN, total: all.sessions, totalNeeds: all.needs, watching: true };
    const text = JSON.stringify(message);
    if (!always && text === lastChips) return;
    lastChips = text;
    toPage(message);
  }
  function sendSnapshot() {
    queue = [];
    toPage({ type: 'records', scope, records: [{ ctl: 'snapshot', epoch: 'preview' + options.seed, seq: ++seq, scope, state: models[scope].serialize() }] });
  }
  const themeLook = () => (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'glasshouse' : 'nexus');      // as lib/view.js sendLook

  function fromPage(m) {
    if (!m || typeof m !== 'object' || m.v !== 1) return;
    if (m.type === 'ready') ready();
    else if (m.type === 'scope') {
      if (m.scope !== ALL && !WINDOWS.some(w => w.key === m.scope)) return;      // lib/view.js validScope, for the windows that exist
      scope = m.scope;
      sendChips(true); sendSnapshot();
    } else if (m.type === 'act' && window.console) window.console.info('preview: the editor would ' + (m.action === 'focus' ? 'show' : 'open') + ' ' + JSON.stringify(m.target) + '; nothing is opened here.');
  }
  function ready() {
    if (models) { toPage({ type: 'look', look: themeLook() }); toPage({ type: 'hub', state: 'up', role: 'hub', collectors: COLLECTORS }); sendChips(true); sendSnapshot(); return; }
    const M = window.MonitorModel;
    models = { [ALL]: M.create() };
    for (const w of WINDOWS) models[w.key] = M.create();
    toPage({ type: 'look', look: themeLook() });
    toPage({ type: 'hub', state: 'up', role: 'hub', collectors: COLLECTORS });
    feed = F.create({ seed: options.seed, agents: options.agents, load: options.load });
    feed.subscribe(onEvent);
    if (options.warm) feed.warm(options.warm * 1000);      // the first snapshot already holds a minute of work
    sendChips(true); sendSnapshot();
    live = true;
    feed.start();
    if (window.matchMedia) window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => toPage({ type: 'look', look: themeLook() }));
  }
  const COLLECTORS = { claude: { state: 'installed', folders: 1, installed: 1 } };

  /** For the preview's test and for a curious owner: what was asked for, and what the stream has held so far. */
  window.MonitorPreview = { options, windows: WINDOWS.map(w => ({ key: w.key, name: w.name, kinds: w.kinds.slice() })), seen, scope: () => scope };
})();
