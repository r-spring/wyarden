/* Wyarden 3D monitor, working mock-up: the page. It joins the host's feed, the model and the view,
 * and fills the workspace chips, the status line, the inspector, the legend and the list twin.
 *
 * Started from ui-concepts/monitor-3d/app.js. Changed (docs/monitor-3d/05-working-mockup.md 8.2):
 *   - the source is host-feed.js, not the simulator: a snapshot replaces the model, an event is
 *     applied to it, a drop removes one session; the simulated-feed buttons are gone;
 *   - the workspace chips and the status line are new, and both only show what the host says;
 *   - a double-click or Ctrl+Enter on a file or an address asks the host to open it, and on a session
 *     or one of its subagents asks the host to show that session's terminal or chat panel (only to show
 *     it: nothing is started or changed); a click tells the host what was selected and does nothing else;
 *   - the camera, the look, the pressed view buttons and the selection survive a reload through
 *     the webview's state, because VS Code destroys a hidden tab's page.
 *
 * Nothing here edits information: the chips choose what is shown, the other buttons change how it
 * is shown, a click or a key selects, and the "In VS Code" list is text. The page's own panels are
 * redrawn from a frame caused by data, so they change at most ten times a second and not at all when
 * nothing happens. No timer runs at rest.
 */
(function () {
  'use strict';
  const L = window.MonitorLayout, M = window.MonitorModel, E = window.MonitorEngine, N = window.MonitorNav, LOOKS = window.MonitorLooks, H = window.MonitorHostFeed;
  const K = window.MonitorLookRegistry;      // looks.js: the list of looks, what a look may set on the page, the switcher
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  /** A look this page has, by its own name: "toString" or "__proto__" is found on every object, and is not a look. */
  const isLook = name => typeof name === 'string' && Object.prototype.hasOwnProperty.call(LOOKS, name);
  const SWITCH_MS = 10000;          // how long a chip says "switching…" when the hub does not answer

  const api = window.acquireVsCodeApi();
  const saved = readSaved(api.getState());
  const state = {
    look: saved.look || 'nexus', lookChosen: saved.lookChosen,        // the host's theme decides until the owner presses a look button
    selected: '', owner: '', memo: {}, attention: '',
    scope: null, snapshots: 0,                                          // the scope the scene shows, from the last snapshot
    workspaces: null, hub: null, pending: '', pendingTimer: null,
    chipsSignature: '', announced: ''
  };
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let model = M.create();
  const feed = H.create(api);
  const canvas = $('scene'), twin = $('twin'), chips = $('chips');
  const view = new E.View(canvas, { model, look: LOOKS[state.look], onSelect: id => select(id, 'scene'), onFrame, onKey });

  /* ---------- the one way in: the host's records ---------- */

  feed.onSnapshot = (text, scope, record) => {
    let next;
    try { next = M.load(text); } catch (error) { model.counts.rejected++; view.dataChanged(); return; }
    const first = state.snapshots === 0, changed = scope !== state.scope;
    const iso = view.isolated, back = view.savedCamera;
    model = next; state.scope = scope; state.snapshots++; state.attention = ''; state.memo = {};
    view.setModel(model);
    // A snapshot of the scope already shown keeps the camera, and the isolated column while it stands.
    if (!changed && iso != null && model.columns[iso] != null) { view.isolated = iso; view.savedCamera = back; }
    else if (iso != null && back) { view.camera = back; view.savedCamera = null; }
    if (first && restoreView()) { /* the camera came back from the saved state */ }
    else if (first || changed) frameAll(true);
    else followNew();
    $('isolate').setAttribute('aria-pressed', String(view.isolated != null));
    if (state.pending && state.pending === scope) clearPending();
    keepSelection(true);
    rebuildTwin(); countLegend(); renderEmpty(); renderChips(); renderStatus();
    save();
  };
  feed.subscribe((event, scope) => {
    if (!state.snapshots || scope !== state.scope) return;        // an event belongs to the model of its scope
    try { model.apply(event); } catch (error) { model.counts.rejected++; }
    followNew();
    view.dataChanged();
  });
  feed.onDrop = (key, why, scope) => {
    if (!state.snapshots || scope !== state.scope) return;
    model.drop(key);
    followNew();
    view.dataChanged();
  };

  /* ---------- keeping every session in view ----------
   * Data never moves a node, and never moves a camera the owner has moved. But while the camera still stands exactly
   * where the page itself last framed it, a NEW column is framed in: a session that starts must not start off screen.
   * A column that leaves changes nothing, so what stays on screen stays where it was. */
  let framed = { key: '', cols: [] };
  function cameraKey() { const c = view.camera; return [c.yaw, c.pitch, c.distance, c.target[0], c.target[1], c.target[2]].map(v => v.toFixed(2)).join(' '); }
  /** Frame the columns in use; an empty scene is framed as if its first column stood, so the first session lands in view. */
  function frameAll(reset) {
    const cols = model.columnsInUse(), wanted = cols.length ? cols : [0];
    if (reset) view.resetCamera(wanted); else view.frame(wanted);
    framed = { key: cameraKey(), cols };
  }
  function followNew() {
    const cols = model.columnsInUse(), fresh = cols.some(col => !framed.cols.includes(col));
    if (!fresh) { framed.cols = framed.cols.filter(col => cols.includes(col)); return; }
    if (view.isolated != null || cameraKey() !== framed.key) return;        // the camera is the owner's now
    frameAll(false);
  }
  feed.onWorkspaces = message => { state.workspaces = message; renderChips(); renderStatus(); renderEmpty(); };
  feed.onHub = message => {
    const selected = model.nodes.get(state.selected);
    const last = collectorState(selected?.kind)?.state;
    state.hub = message;
    renderStatus();
    if (selected?.cls === 'agent' && collectorState(selected.kind)?.state !== last) renderInspector();
  };
  // The host says this when the page loads and when the editor's theme changes. Until the owner chooses a look the theme
  // picks one; after that the look stays, and one that reads its colours from the page reads them again (refreshLook).
  feed.onLook = look => { if (!state.lookChosen && isLook(look) && look !== state.look) { state.look = look; applyLook(); save(); } else refreshLook(); };

  /* ---------- selection ---------- */

  function select(id, from) {
    const n = id ? model.nodes.get(id) : null, before = state.selected;
    state.selected = n ? id : '';
    state.owner = n ? (n.owner || '') : '';
    view.setSelected(state.selected);
    renderInspector();
    markTwin(from !== 'twin');
    $('isolate').disabled = view.isolated == null && !(n && n.col !== L.DOCK);
    if (from === 'scene' || from === 'keys') $('live').textContent = n ? 'Selected. ' + N.line(n, model) : 'Nothing selected.';
    // The owner's own selection is told to the host; one the model made (a node left) is not.
    if (n && state.selected !== before && (from === 'scene' || from === 'twin' || from === 'keys')) feed.post({ type: 'select', target: { class: n.cls, id: n.id } });
    if (state.selected !== before) save();
  }
  /** The selection is kept by id. A selected node that folds becomes its stack; one that leaves becomes its agent.
      After a snapshot (`fresh`), a node that is gone clears the selection. */
  function keepSelection(fresh) {
    const wanted = state.selected || (fresh && state.snapshots === 1 ? saved.selected : '');
    if (!wanted) { if (fresh) select('', 'model'); return; }
    const n = model.nodes.get(wanted);
    if (n && !n.folded) { if (wanted !== state.selected || fresh) select(wanted, 'model'); return; }
    if (fresh && !n) { select('', 'model'); return; }
    const next = n ? model.stackId(n.col, n.floor) : model.nodes.has('a:' + state.owner) ? 'a:' + state.owner : '';
    select(next, 'model');
  }
  /** A double-click or Ctrl+Enter: a file group or a URL group is opened, a session (or a subagent's
      session) is shown. nav.js decides which, so the "In VS Code" labels and this can never disagree. */
  function act(id) {
    const a = N.act(model.nodes.get(id), model);
    if (!a) return false;
    feed.post({ type: 'act', action: a.action, target: { class: a.class, id: a.id } });
    return true;
  }
  function onKey(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) { if (state.selected) act(state.selected); return true; }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && e.shiftKey) return false;        // Shift and an arrow turn the camera
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
      select(N.move(model, state.selected, e.key, state.memo), 'keys');
      return true;
    }
    if (e.key === 'Escape') { if (view.isolated != null) setIsolated(false); else select('', 'keys'); return true; }
    if (e.key === 'Enter') { setIsolated(view.isolated == null); return true; }
    return false;
  }
  canvas.addEventListener('dblclick', e => {
    const r = canvas.getBoundingClientRect(), id = view.pick(e.clientX - r.left, e.clientY - r.top);
    if (id) act(id);
  });

  /* ---------- the inspector ---------- */

  function icon(key, color, size) {
    const c = el('canvas'); c.width = c.height = size * 2; c.style.width = c.style.height = size + 'px';
    const ctx = c.getContext('2d'); ctx.scale(2, 2);
    E.drawIcon(ctx, LOOKS[state.look], key, color, size);
    c.setAttribute('aria-hidden', 'true');
    return backed(c);
  }
  /** A swatch on a panel. Where the look's panels have their own ink, it stands on the stage's colour (looks.js, swatchBack). */
  function backed(c) {
    const back = K.swatchBack(LOOKS[state.look]);
    if (back) { c.style.background = back; c.style.borderRadius = '3px'; }
    return c;
  }
  function badge(status, size) {
    const c = el('canvas'), look = LOOKS[state.look]; c.width = c.height = size * 2; c.style.width = c.style.height = size + 'px';
    const ctx = c.getContext('2d'); ctx.scale(2, 2);
    E.drawBadge(ctx, M.STATES[status].shape, size / 2, size / 2, size * .3, look.palette.state[status], K.swatchBack(look) || look.palette.panel);
    c.setAttribute('aria-hidden', 'true');
    return backed(c);
  }
  function renderInspector() {
    const box = $('inspector'), n = model.nodes.get(state.selected);
    if (!n) {
      box.replaceChildren(el('h2', '', 'Inspector'), el('p', 'empty', 'Nothing is selected. Click a shape, or put the focus on the scene and press an arrow key.'));
      return;
    }
    const d = N.describe(n, model), v = view.visual(n), head = el('div', 'insp-head'), names = el('div');
    if (n.cls === 'agent' && n.kind !== 'claude' && !n.collector) {
      const calls = d.facts.find(fact => fact[0] === 'Calls');
      if (calls) calls[1] = (n.kind === 'codex' ? 'Session activity can be discovered through the Codex app server. ' : '') + collectorStep(n.kind);
    }
    names.append(el('p', 'insp-class', d.className + (d.kindName ? ': ' + d.kindName : '')), el('h2', '', d.title));
    head.append(icon(v.mesh, v.color, 40), names);
    const parts = [head];
    if (d.stateLine) { const line = el('p', 'insp-state'); if (M.STATES[d.status].shape) line.append(badge(d.status, 18)); line.append(el('span', '', d.stateLine)); parts.push(line); }
    const facts = el('dl', 'facts');
    for (const [label, value] of d.facts) facts.append(el('dt', '', label), el('dd', '', value));
    parts.push(facts);
    for (const list of d.lists) {
      const ul = el('ul', 'plain');
      for (const item of list.items) ul.append(el('li', '', item));
      parts.push(el('h3', '', list.title), ul);
    }
    const acts = el('ul', 'actions');
    for (const a of d.actions) { const li = el('li'); li.append(el('b', '', a.label), el('span', '', a.detail)); acts.append(li); }
    parts.push(el('h3', '', 'In VS Code'), el('p', 'hint', 'What is wired now. These are labels, not controls.'), acts);
    box.replaceChildren(...parts);
  }

  /* ---------- the list twin ---------- */

  const rowOf = new Map();      // row key -> element
  const groupOf = new Map();    // column -> { box, title }: a column's title names its workspace, which session.info can change
  let rowSeq = 0;
  function rebuildTwin() {
    rowOf.clear(); groupOf.clear();
    const parts = [];
    for (const group of N.rows(model)) {
      const box = el('div'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', group.title);
      const title = el('div', 'twin-title', group.title); title.setAttribute('aria-hidden', 'true');
      box.append(title);
      if (group.col !== undefined) groupOf.set(group.col, { box, title });
      for (const row of group.rows) {
        const item = el('div', 'twin-row', row.text);
        item.id = 'row-' + (++rowSeq); item.setAttribute('role', 'option'); item.dataset.node = row.id; item.setAttribute('aria-selected', 'false');
        rowOf.set(row.key, item); box.append(item);
      }
      parts.push(box);
    }
    if (!parts.length) parts.push(el('p', 'hint', state.snapshots ? 'No live session.' : 'Waiting for the hub…'));
    twin.replaceChildren(...parts);
    markTwin(false);
  }
  function refreshTwin(ids) {
    for (const id of ids) {
      const n = model.nodes.get(id);
      if (!n || n.folded) continue;
      const text = N.line(n, model);
      for (const key of [id, 'attention ' + id]) { const item = rowOf.get(key); if (item && item.textContent !== text) item.textContent = text; }
      const group = n.cls === 'agent' && groupOf.get(n.col);
      if (group) {
        const title = N.columnTitle(model, n.col);
        if (group.title.textContent !== title) { group.title.textContent = title; group.box.setAttribute('aria-label', title); }
      }
    }
  }
  function markTwin(scroll) {
    for (const item of twin.querySelectorAll('[aria-selected="true"]')) item.setAttribute('aria-selected', 'false');
    const item = rowOf.get(state.selected);
    if (!item) { twin.removeAttribute('aria-activedescendant'); return; }
    item.setAttribute('aria-selected', 'true'); twin.setAttribute('aria-activedescendant', item.id);
    if (scroll) item.scrollIntoView({ block: 'nearest' });
  }
  twin.addEventListener('click', e => { const item = e.target.closest('.twin-row'); if (item) select(item.dataset.node, 'twin'); });
  twin.addEventListener('dblclick', e => { const item = e.target.closest('.twin-row'); if (item) act(item.dataset.node); });
  twin.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (state.selected) act(state.selected); return; }
    const items = [...twin.querySelectorAll('.twin-row')], at = items.findIndex(item => item.getAttribute('aria-selected') === 'true');
    const to = { ArrowDown: Math.min(items.length - 1, at + 1), ArrowUp: Math.max(0, at - 1), Home: 0, End: items.length - 1 }[e.key];
    if (to === undefined || !items.length) { if (e.key === 'Escape') select('', 'twin'); return; }
    e.preventDefault();
    select(items[to].dataset.node, 'twin');
    items[to].scrollIntoView({ block: 'nearest' });
    twin.setAttribute('aria-activedescendant', items[to].id);
  });

  /* ---------- the legend: shape, colour and name ---------- */

  const countOf = {};
  function sample(draw) {
    const c = el('canvas'); c.width = 68; c.height = 28; c.style.width = '34px'; c.style.height = '14px'; c.setAttribute('aria-hidden', 'true');
    const ctx = c.getContext('2d'); ctx.scale(2, 2); ctx.lineCap = 'round'; draw(ctx);
    return backed(c);
  }
  function buildLegend() {
    const look = LOOKS[state.look], pal = look.palette, body = $('legend-body');
    const item = (mark, name, key) => { const row = el('div', 'legend-item'), text = el('span', '', name); if (key) { countOf[key] = el('i', '', ''); text.append(' ', countOf[key]); } row.append(mark, text); return row; };
    const line = (color, dash, extra) => sample(ctx => { ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.6; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(2, 7); ctx.lineTo(32, 7); ctx.stroke(); ctx.setLineDash([]); if (extra) extra(ctx); });
    // An agent's and a subagent's colour is its provider's, so their shapes are shown here in a neutral colour,
    // and the providers get a group of their own. A look with no provider colours still draws a legend.
    // A look that gives no provider a colour of its own (palette.provider is absent) shows the two in their class's colour,
    // and has no group of providers.
    const byProvider = !!pal.provider, neutral = pal.muted || pal.caption, agentColor = byProvider ? neutral : pal.cls.agent;
    const classes = el('div', 'legend-grid'), agentMark = icon('agent', agentColor, 22);
    agentMark.dataset.color = agentColor;         // the colour each swatch was drawn in, for the tests
    classes.append(
      item(agentMark, 'Agent', 'agent'), item(icon('subagent', byProvider ? neutral : pal.cls.subagent, 22), 'Subagent', 'subagent'),
      item(icon('tool', pal.cls.tool, 22), 'Tool', 'tool'), item(icon('mcp', pal.cls.mcp, 22), 'MCP server', 'mcp'),
      item(icon('resource.file', pal.cls.resource, 22), 'Files', 'file'), item(icon('resource.url', pal.cls.resource, 22), 'URLs', 'url'),
      item(icon('resource.context', pal.cls.resource, 22), 'Context', 'context'), item(icon('stack', neutral, 22), '+N idle, folded'));
    const providers = el('div', 'legend-grid');
    for (const kind of byProvider ? Object.keys(E.PROVIDERS || {}) : []) {
      const color = pal.provider && Object.prototype.hasOwnProperty.call(pal.provider, kind) ? pal.provider[kind] : pal.cls.agent;
      const mark = icon('agent', color, 22);
      mark.dataset.color = color;
      providers.append(item(mark, E.PROVIDERS[kind], 'provider:' + kind));
    }
    const states = el('div', 'legend-grid');
    for (const key of Object.keys(M.STATES)) if (M.STATES[key].shape) states.append(item(badge(key, 18), M.STATES[key].name));
    const calls = el('div', 'legend-grid legend-wide');
    calls.append(
      item(line(pal.cls.tool, []), 'Tool call, while it is open'),
      item(line(pal.cls.mcp, [], ctx => { ctx.beginPath(); ctx.arc(31, 7, 2.5, 0, 7); ctx.fill(); }), 'MCP call, to the tool’s port on the server'),
      item(line(pal.cls.resource, [5, 4], ctx => { ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(4, 7, 2.6, 0, 7); ctx.fillStyle = K.swatchBack(look) || pal.panel; ctx.fill(); ctx.stroke(); }), 'Read (dashed); a ring marks a resource that was read'),
      item(line(pal.cls.resource, [], ctx => { ctx.beginPath(); ctx.moveTo(33, 7); ctx.lineTo(26, 3.5); ctx.lineTo(26, 10.5); ctx.closePath(); ctx.fill(); ctx.fillRect(1.4, 4.4, 5.2, 5.2); }), 'Write (solid, with a head); a square marks a resource that was written'),
      item(line(pal.cls.resource, [1, 4]), 'Search (dotted)'),
      item(line(pal.cls.tool, [2, 6]), 'A call that has just ended; a cross if it failed'),
      item(line(pal.clash, [6, 4], ctx => { ctx.font = 'bold 9px sans-serif'; ctx.fillText('!', 15, 6); }), 'Two agents wrote the same file'));
    body.replaceChildren(el('h3', '', 'Classes (files, URLs and context are resources)'), classes,
      ...(byProvider ? [el('h3', '', 'Providers (the colour of an agent and its subagents)'), providers] : []),
      el('h3', '', 'States (a mark beside the shape)'), states, el('h3', '', 'Calls'), calls,
      el('p', 'hint', 'A resource grows with the number of times it was touched. A dashed agent is a session that has ended; it leaves 20 seconds later. "exact" came from a hook; "derived" was read from a transcript or a session file.'));
    countLegend();
  }
  function countLegend() {
    const counts = Object.assign(model.classCounts(), { file: 0, url: 0, context: 0 });
    for (const kind of Object.keys(E.PROVIDERS || {})) counts['provider:' + kind] = 0;
    for (const n of model.nodes.values()) {
      if (n.cls === 'resource') counts[n.kind]++;
      else if (n.cls === 'agent' && ('provider:' + view.providerOf(n)) in counts) counts['provider:' + view.providerOf(n)]++;
    }
    for (const key of Object.keys(countOf)) countOf[key].textContent = '(' + (counts[key] || 0) + ')';
  }

  /* ---------- workspace chips: a filter on what is shown, chosen by the hub's next snapshot ---------- */

  /* A chip stands for one open editor window's workspace (0.1.1); a 0.1.0 hub listed one per folder.
     Every field the 0.1.1 hub added (folders, total, totalNeeds, own, watching) may be missing. */
  const chipOf = new Map();     // scope -> { button, count, needs, note }
  const countOrNull = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
  function workspaceList() {
    const m = state.workspaces, here = new Set(m && Array.isArray(m.here) ? m.here : []);
    const own = m && typeof m.own === 'string' ? m.own : '';
    // This window's own workspace: `own` alone when the hub names it (0.1.1); else `here`, which is what a 0.1.0 hub needs.
    const mine = key => (own ? key === own : here.has(key));
    const list = m ? m.list.filter(w => w && typeof w.key === 'string' && w.key) : [];
    const name = w => (typeof w.name === 'string' && w.name ? w.name : w.key);
    return list.slice().sort((a, b) => (mine(b.key) - mine(a.key)) || name(a).localeCompare(name(b), undefined, { sensitivity: 'base' }) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(w => ({ key: w.key, name: name(w), here: mine(w.key), sessions: Number(w.sessions) || 0, needs: Number(w.needs) || 0, windows: Number(w.windows) || 0,
        apps: Array.isArray(w.apps) ? w.apps.filter(a => typeof a === 'string' && a) : [], folders: Array.isArray(w.folders) ? w.folders.filter(f => typeof f === 'string' && f) : [] }));
  }
  /** The hover text: the full name; the folders when they say more than the name; the editors that have it open. */
  function chipTitle(w) {
    if (w.key === 'all') return 'Every open editor window, each session counted once';
    const lines = [w.name];
    if (w.folders.length > 1 || (w.folders.length === 1 && w.folders[0] !== w.name)) lines.push('Folders: ' + w.folders.join(', ') + '.');
    lines.push('Open in ' + (w.apps.length ? w.apps.join(', ') : 'a window') + (w.here ? ' (this window).' : '.'));
    return lines.join('\n');
  }
  function renderChips() {
    const list = workspaceList(), m = state.workspaces || {};
    // A session can belong to two windows, so the hub's own totals win over the sums when it sends them.
    const total = countOrNull(m.total), totalNeeds = countOrNull(m.totalNeeds);
    const all = { key: 'all', name: 'All open', here: false, apps: [], folders: [], windows: 0,
      sessions: total !== null ? total : list.reduce((s, w) => s + w.sessions, 0), needs: totalNeeds !== null ? totalNeeds : list.reduce((s, w) => s + w.needs, 0) };
    const entries = [all].concat(list);
    // Rebuilt only when the chips themselves change (key, name, order), so a count, a hover text or
    // `watching` that moves never takes the focus away.
    const signature = JSON.stringify(entries.map(w => [w.key, w.name, w.here]));
    if (signature !== state.chipsSignature) {
      const focused = chips.contains(document.activeElement) ? document.activeElement.dataset.scope : undefined;
      state.chipsSignature = signature; chipOf.clear();
      const buttons = entries.map(w => {
        const button = el('button', 'chip'); button.type = 'button'; button.dataset.scope = w.key;
        const name = el('span', 'chip-name', w.name), count = el('span', 'chip-count'), needs = el('span', 'chip-needs'), note = el('span', 'chip-note');
        button.append(name, count, needs, note);
        button.addEventListener('click', () => chooseScope(w.key));
        chipOf.set(w.key, { button, count, needs, note });
        return button;
      });
      chips.replaceChildren(...buttons);
      if (focused && chipOf.has(focused)) chipOf.get(focused).button.focus();
    }
    const shown = state.workspaces && typeof state.workspaces.scope === 'string' ? state.workspaces.scope : state.scope;
    for (const w of entries) {
      const chip = chipOf.get(w.key), known = !!state.workspaces;
      setText(chip.count, known ? String(w.sessions) : '');
      chip.count.hidden = !known;
      setText(chip.needs, w.needs ? '▲ ' + (w.needs === 1 ? 'needs you' : w.needs + ' need you') : '');
      chip.needs.hidden = !w.needs;
      const switching = state.pending === w.key;
      setText(chip.note, switching ? 'switching…' : '');
      chip.note.hidden = !switching;
      chip.button.setAttribute('aria-pressed', String(shown === w.key));
      if (switching) chip.button.setAttribute('aria-busy', 'true'); else chip.button.removeAttribute('aria-busy');
      const label = w.name + (known ? ', ' + plural(w.sessions, 'live session', 'live sessions') : '') + (w.needs ? ', ' + w.needs + ' waiting for you' : '') + (switching ? ', switching' : '');
      if (chip.button.getAttribute('aria-label') !== label) chip.button.setAttribute('aria-label', label);
      const title = chipTitle(w);
      if (chip.button.title !== title) chip.button.title = title;
    }
    rovingTabs();
  }
  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
  /** One tab stop for the whole toolbar: the chip shown, else the first. Arrow keys move between chips. */
  function rovingTabs() {
    const buttons = [...chips.querySelectorAll('.chip')];
    const current = buttons.find(b => b === document.activeElement) || buttons.find(b => b.getAttribute('aria-pressed') === 'true') || buttons[0];
    for (const b of buttons) { const want = b === current ? '0' : '-1'; if (b.getAttribute('tabindex') !== want) b.setAttribute('tabindex', want); }
  }
  chips.addEventListener('keydown', e => {
    const buttons = [...chips.querySelectorAll('.chip')], at = buttons.indexOf(document.activeElement);
    if (at < 0) return;
    const to = { ArrowRight: (at + 1) % buttons.length, ArrowLeft: (at - 1 + buttons.length) % buttons.length, Home: 0, End: buttons.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault(); buttons[to].focus(); rovingTabs();
  });
  chips.addEventListener('focusin', rovingTabs);
  /** A chip asks the host for a scope and nothing else. The scene changes when the hub's snapshot comes. */
  function chooseScope(key) {
    const shown = state.workspaces && typeof state.workspaces.scope === 'string' ? state.workspaces.scope : state.scope;
    if (key === shown && !state.pending) return;
    feed.post({ type: 'scope', scope: key });
    clearPending();
    state.pending = key;
    state.pendingTimer = setTimeout(() => { state.pendingTimer = null; state.pending = ''; renderChips(); }, SWITCH_MS);
    renderChips();
  }
  function clearPending() {
    if (state.pendingTimer !== null) clearTimeout(state.pendingTimer);
    state.pendingTimer = null; state.pending = '';
  }

  /* ---------- the status line and the empty scene: text only, from the host's messages ---------- */

  const COMMAND = '“Wyarden 3D Monitor: Set Up Collectors…”';
  const RESTART = { codex: 'Restart Codex and open /hooks to review Wyarden.', grok: 'Restart Grok Build.', antigravity: 'Restart Antigravity.' };
  const collectorState = provider => state.hub?.collectors?.[provider];
  function collectorStep(provider) {
    const c = collectorState(provider);
    if (c?.state === 'awaiting-approval') return 'Awaiting hook approval. In Codex, open /hooks and review the Wyarden commands.';
    if (c?.state === 'approval-unknown') return 'Hook approval could not be read. ' + RESTART[provider];
    if (c?.state === 'inactive') return 'Hooks are inactive. ' + RESTART[provider];
    if (c?.state === 'runtime-unavailable') return 'Install Node.js and reopen the editor before setting up this collector.';
    if (c?.state === 'bridge-unavailable') return 'The local collector command is unavailable. Run ' + COMMAND + '.';
    if (c?.state === 'installed') return 'Live calls appear on the next hook event. ' + RESTART[provider];
    if (c?.state === 'unreadable' || c?.state === 'unavailable') return 'Collector status unavailable. Open Status for details.';
    if (c?.folders === 0) return 'Start the provider once, then run ' + COMMAND + '.';
    return 'Run ' + COMMAND + '. ' + RESTART[provider];
  }
  function hubSentence() {
    const h = state.hub;
    if (!h) return 'Hub: starting…';
    if (h.state === 'up') return h.role === 'hub' ? 'Hub: running in this window.' : 'Hub: connected.';
    if (h.state === 'blocked') return 'Hub: another program holds its port.';
    if (h.state === 'stopped') return 'Hub: stopped.';
    return 'Hub: starting…';
  }
  function collectorSentence() {
    const c = state.hub && state.hub.collectors && state.hub.collectors.claude;
    if (!c || typeof c !== 'object') return '';
    const folders = Number(c.folders) || 0, installed = Number(c.installed) || 0;
    const install = ' To install: run ' + COMMAND + ' from the Command Palette.';
    if (!folders) return 'Claude Code collector: no Claude Code account folder was found.';
    if (c.state === 'installed') return 'Claude Code collector: installed in ' + installed + ' of ' + plural(folders, 'account folder', 'account folders') + ' (exact calls).';
    if (c.state === 'partly') return 'Claude Code collector: installed in ' + installed + ' of ' + plural(folders, 'account folder', 'account folders') + ' (exact calls there; derived elsewhere).' + install;
    return 'Claude Code collector: not installed. Calls are read from transcripts (derived).' + install;
  }
  function nativeCollectorSentences() {
    return Object.keys(RESTART).flatMap(provider => {
      const c = collectorState(provider);
      if (!c) return [];
      const label = (provider === 'grok' ? 'Grok Build' : N.providerName(provider)) + ' collector: ';
      if (c.state === 'installed') return [label + 'installed.'];
      if (c.state === 'awaiting-approval') return [label + 'awaiting hook approval in /hooks.'];
      if (c.state === 'approval-unknown') return [label + 'approval unknown. Check /hooks.'];
      if (c.state === 'inactive') return [label + 'inactive. ' + RESTART[provider]];
      if (c.state === 'partly') return [label + 'partially configured.'];
      if (c.state === 'runtime-unavailable') return [label + 'command runtime unavailable.'];
      if (c.state === 'bridge-unavailable') return [label + 'local command unavailable.'];
      if (c.state === 'unreadable' || c.state === 'unavailable') return [label + 'status unavailable.'];
      return [label + (c.folders ? 'setup needed.' : 'no profile found.')];
    });
  }
  function renderStatus() {
    const parts = [hubSentence()];
    if (state.snapshots) parts.push('Showing ' + plural(model.sessions.size, 'session', 'sessions') + '.');
    const hidden = state.workspaces ? Number(state.workspaces.hidden) || 0 : 0;
    if (hidden > 0) parts.push(hidden === 1 ? '1 more is live in a folder that is open in no window.' : hidden + ' more are live in folders that are open in no window.');
    const collector = collectorSentence();
    const collectors = [collector, ...nativeCollectorSentences()].filter(Boolean);
    parts.push(...collectors);
    setText($('status'), parts.join(' '));
    // Said aloud only when the hub or the collector changes, never for a count.
    const spoken = [hubSentence(), ...collectors].join(' ');
    if (spoken !== state.announced) { state.announced = spoken; setText($('status-live'), spoken); }
  }
  function scopeName(key) {
    const w = workspaceList().find(x => x.key === key);
    return w ? w.name : 'this workspace';
  }
  function renderEmpty() {
    const box = $('empty');
    let text = '';
    if (!state.snapshots) text = 'Waiting for the hub…';
    else if (!model.sessions.size && !model.overflow.size) text = state.scope === 'all' ? 'No live agent session in any open workspace.' : 'No live agent session in ' + scopeName(state.scope) + '.';
    setText(box, text);
    box.hidden = !text;
  }

  /* ---------- once per frame ---------- */

  const hud = {};
  function buildHud() {
    const box = $('hud'), parts = [];
    for (const [key, name] of [['frames', 'frames drawn'], ['ms', 'last frame, ms'], ['nodes', 'nodes'], ['links', 'open calls'], ['labels', 'captions'], ['events', 'events'], ['left', 'left out'], ['off', 'off screen']]) {
      const span = el('span'); hud[key] = el('b', '', '0'); span.append(name + ' ', hud[key]); parts.push(span);
    }
    box.replaceChildren(...parts);
  }
  function onFrame(stats, reasons) {
    if (reasons.has('data')) syncPanels();
    hud.frames.textContent = stats.frames; hud.ms.textContent = stats.ms.toFixed(1); hud.nodes.textContent = stats.nodes; hud.links.textContent = stats.links;
    hud.labels.textContent = stats.labels + (stats.skipped ? ' (+' + stats.skipped + ' on hover)' : '');
    hud.events.textContent = model.counts.events + (model.counts.rejected ? ' (' + model.counts.rejected + ' rejected)' : '');
    hud.left.textContent = model.overflow.size + ' sessions, ' + model.leftOut.arcs + ' clashes';
    hud.off.textContent = stats.offscreen + (stats.offscreen ? ' (F frames all)' : '');
    if (reasons.has('input') || reasons.has('size')) save();        // the camera moves only by input
  }
  /** Bring the inspector, the list, the legend and the status line up to date with what changed in the model. */
  function syncPanels() {
    const changes = model.takeChanges();
    keepSelection(false);
    const waiting = [...model.nodes.values()].filter(n => n.cls === 'agent' && n.status === 'needs').sort((a, b) => a.since - b.since);
    const attention = waiting.map(n => n.id).join(' ');
    if (changes.structure || attention !== state.attention) { rebuildTwin(); countLegend(); renderEmpty(); renderStatus(); } else refreshTwin(changes.ids);
    if (attention !== state.attention) {
      const before = state.attention.split(' '), fresh = waiting.filter(n => !before.includes(n.id));
      if (fresh.length) $('live').textContent = fresh.map(n => N.agentName(n) + (typeof n.title === 'string' && n.title.trim() ? ', “' + n.title.trim() + '”,' : '') + ' needs you' + (n.wait ? ': ' + n.wait.why : '')).join('. ') + '.';
      state.attention = attention;
    }
    if (state.selected && changes.ids.has(state.selected)) renderInspector();
  }

  /* ---------- the view buttons: how the scene is shown, never the information ---------- */

  function press(selector, test) { for (const b of document.querySelectorAll(selector)) b.setAttribute('aria-pressed', String(test(b))); }
  function applyLook() {
    const look = K.refresh(LOOKS[state.look], document), pal = look.palette, root = document.documentElement.style;      // refresh: look.fromPage, when it has one
    for (const [name, value] of [['--bg', pal.bg], ['--panel', pal.panel], ['--line', pal.line], ['--ink', pal.ink], ['--text', pal.caption], ['--muted', pal.muted], ['--accent', pal.accent], ['--needs', pal.state.needs], ['--font', look.font]]) root.setProperty(name, value);
    K.applyPage(look, root);                // the look's lettering and panel variables; those it does not set are cleared
    document.documentElement.style.colorScheme = look.theme;
    document.documentElement.dataset.look = state.look;
    press('[data-look]', b => b.dataset.look === state.look);
    switcher.show(state.look);
    state.lookSignature = K.signature(look);
    view.setLook(look); buildLegend(); renderInspector();
  }
  /** The owner chose a look: a button of the list, or "previous" or "next". From then on the editor's theme no longer picks one. */
  function chooseLook(id) {
    if (!isLook(id)) return;
    state.look = id; state.lookChosen = true;
    applyLook(); save();
    $('live').textContent = 'Look: ' + (K.entry(id) || LOOKS[id]).name + (LOOKS[id].stub ? ', not built yet' : '') + '.';
  }
  /** The editor's theme changed under the page: a look that takes its colours from the page takes them again. Any other
      look, and one whose colours come out the same, is left alone: nothing is applied and no frame is drawn. */
  function refreshLook() {
    const look = LOOKS[state.look];
    if (typeof look.fromPage !== 'function') return;
    if (K.signature(K.refresh(look, document)) !== state.lookSignature) applyLook();
  }
  function setIsolated(on) {
    const n = model.nodes.get(state.selected);
    if (on && n && n.col !== L.DOCK) view.isolate(n.col); else view.release();
    $('isolate').setAttribute('aria-pressed', String(view.isolated != null));
    $('isolate').disabled = view.isolated == null && !(n && n.col !== L.DOCK);
    save();
  }
  function setSpread(on) {
    view.setSpread(on ? L.SPREAD : 1); $('spread').setAttribute('aria-pressed', String(on));
  }
  function setMotion(on) {
    view.setMotion(on); $('motion').textContent = view.motion ? 'Motion on' : 'Motion off'; $('motion').setAttribute('aria-pressed', String(view.motion));
  }
  function setList(on) {
    document.body.classList.toggle('show-list', on); $('list-toggle').setAttribute('aria-pressed', String(on));
  }
  function keepClear() {
    const base = canvas.getBoundingClientRect();
    view.keepClear = [$('view-buttons'), $('hud')].map(box => { const r = box.getBoundingClientRect(); return { x: r.left - base.left - 4, y: r.top - base.top - 4, w: r.width + 8, h: r.height + 8 }; });
    document.documentElement.style.setProperty('--bar-height', document.querySelector('.scopes').getBoundingClientRect().bottom + 'px');
  }

  const switcher = K.switcher(document, { looks: LOOKS, current: () => state.look, choose: chooseLook });      // one button for each look, built from the list
  $('motion').addEventListener('click', () => { setMotion(!view.motion); save(); });
  if (reducedMotion) { $('motion').disabled = true; $('motion').textContent = 'Motion off (system setting)'; }
  $('frame').addEventListener('click', () => { if (view.isolated == null) frameAll(false); else view.frame([view.isolated]); });
  $('spread').addEventListener('click', () => {
    setSpread(view.spread === 1);
    if (view.isolated == null) frameAll(false); else view.frame([view.isolated]);
    save();
  });
  $('isolate').addEventListener('click', () => setIsolated(view.isolated == null));
  $('tidy').addEventListener('click', () => { model.tidy(); view.dataChanged(); });
  $('list-toggle').addEventListener('click', () => { const on = !document.body.classList.contains('show-list'); setList(on); if (on) twin.focus(); save(); });

  /* ---------- state across reloads: VS Code destroys a hidden tab's page ---------- */

  function readSaved(s) {
    const out = { look: '', lookChosen: false, camera: null, savedCamera: null, isolated: null, spread: false, motion: false, list: false, selected: '', scope: null, follow: false };
    if (!s || typeof s !== 'object' || s.v !== 1) return out;
    const camera = c => (c && Number.isFinite(c.yaw) && Number.isFinite(c.pitch) && Number.isFinite(c.distance) && Array.isArray(c.target) && c.target.length === 3 && c.target.every(Number.isFinite)
      ? { yaw: c.yaw, pitch: c.pitch, distance: c.distance, target: c.target.slice() } : null);
    if (isLook(s.look)) { out.look = s.look; out.lookChosen = s.lookChosen === true; }
    out.camera = camera(s.camera); out.savedCamera = camera(s.savedCamera);
    out.isolated = Number.isInteger(s.isolated) ? s.isolated : null;
    out.spread = s.spread === true; out.motion = s.motion === true; out.list = s.list === true;
    out.selected = typeof s.selected === 'string' ? s.selected : '';
    out.scope = typeof s.scope === 'string' ? s.scope : null;
    out.follow = s.follow === true;
    return out;
  }
  let lastSaved = '';
  function save() {
    const c = view.camera, b = view.savedCamera;
    const s = {
      v: 1, look: state.look, lookChosen: state.lookChosen,
      camera: { yaw: c.yaw, pitch: c.pitch, distance: c.distance, target: c.target.slice() },
      savedCamera: b ? { yaw: b.yaw, pitch: b.pitch, distance: b.distance, target: b.target.slice() } : null,
      isolated: view.isolated, spread: view.spread !== 1, motion: view.motion, list: document.body.classList.contains('show-list'),
      selected: state.selected, scope: state.snapshots ? state.scope : saved.scope,
      follow: view.isolated == null && cameraKey() === framed.key        // the camera still stands where the page framed it
    };
    const text = JSON.stringify(s);
    if (text === lastSaved) return;
    lastSaved = text;
    try { api.setState(s); } catch (error) { /* the state is a convenience; the page works without it */ }
  }
  /** On the first snapshot of the scope that was shown before the reload, put the camera back as it was. */
  function restoreView() {
    if (!saved.camera || saved.scope !== state.scope) return false;
    view.camera = saved.camera;
    if (saved.isolated != null && model.columns[saved.isolated] != null && saved.savedCamera) { view.isolated = saved.isolated; view.savedCamera = saved.savedCamera; }
    else if (saved.isolated != null && saved.savedCamera) view.camera = saved.savedCamera;
    // A camera the page had framed itself goes on following new sessions; one the owner had moved stays theirs.
    framed = saved.follow && view.isolated == null ? { key: cameraKey(), cols: [] } : { key: '', cols: model.columnsInUse() };
    if (saved.follow) followNew();
    view.redraw.request('input');
    return true;
  }

  /* ---------- start ---------- */

  buildHud();
  view.resize();
  applyLook();
  if (saved.spread) setSpread(true);
  if (saved.motion && !reducedMotion) setMotion(true);
  if (saved.list) setList(true);
  if (saved.camera) view.camera = saved.camera;          // shown over the empty floors until the first snapshot decides
  rebuildTwin(); countLegend(); renderInspector(); renderEmpty(); renderChips(); renderStatus();
  keepClear();
  new ResizeObserver(() => { view.resize(); keepClear(); }).observe(canvas.parentElement);
  new ResizeObserver(keepClear).observe(document.querySelector('.scopes'));
  K.watchTheme(document, refreshLook);
  feed.start();

  window.Monitor3D = { view, feed, state, select, chooseLook, get model() { return model; } };      // for the measuring script and the tests
})();
