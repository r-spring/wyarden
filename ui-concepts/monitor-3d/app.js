/* Monitor 3D mock-up: the page. It joins the feed, the model and the view, and fills the
 * inspector, the legend and the list twin.
 *
 * Nothing here edits information: the buttons start and stop the simulated feed and change how the
 * scene is shown, a click or a key selects, and the "In VS Code" list is text. The page's own
 * panels are redrawn from a frame caused by data, so they too change at most ten times a second
 * and not at all when nothing happens.
 */
(function () {
  'use strict';
  const L = window.MonitorLayout, M = window.MonitorModel, F = window.MonitorFeed, E = window.MonitorEngine, N = window.MonitorNav, LOOKS = window.MonitorLooks;
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
  const range = n => Array.from({ length: n }, (_, i) => i);

  const params = new URLSearchParams(location.search);
  const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  const state = {
    agents: oneOf(Number(params.get('agents')), F.PRESETS.agents, 4),
    load: oneOf(params.get('load'), F.PRESETS.load, 'busy'),
    seed: Number.isInteger(Number(params.get('seed'))) && params.get('seed') ? Number(params.get('seed')) : 7,
    look: oneOf(params.get('look'), Object.keys(LOOKS), 'nexus'),
    warm: Math.max(0, Math.min(600, params.has('warm') ? Number(params.get('warm')) || 0 : 45)),      // seconds of stream run before the first frame
    autostart: params.get('autostart') !== '0',
    speed: 1, selected: '', owner: '', memo: {}, attention: ''
  };
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let model = M.create();
  const feed = F.create({ seed: state.seed, agents: state.agents, load: state.load });
  const canvas = $('scene'), twin = $('twin');
  const view = new E.View(canvas, { model, look: LOOKS[state.look], onSelect: id => select(id, 'scene'), onFrame, onKey });

  /* The one way in. Anything that has subscribe(onEvent) can stand where the simulated feed stands. */
  const source = feed;
  source.subscribe(event => {
    try { model.apply(event); } catch (error) { model.counts.rejected++; }
    view.dataChanged();
  });

  /* ---------- selection ---------- */

  function select(id, from) {
    const n = id ? model.nodes.get(id) : null;
    state.selected = n ? id : '';
    state.owner = n ? (n.owner || '') : '';
    view.setSelected(state.selected);
    renderInspector();
    markTwin(from !== 'twin');
    $('isolate').disabled = view.isolated == null && !(n && n.col !== L.DOCK);
    if (from === 'scene' || from === 'keys') $('live').textContent = n ? 'Selected. ' + N.line(n, model) : 'Nothing selected.';
  }
  /** The selection is kept by id. A selected node that folds becomes its stack; one that leaves becomes its agent. */
  function keepSelection() {
    if (!state.selected) return;
    const n = model.nodes.get(state.selected);
    if (n && !n.folded) return;
    const next = n ? model.stackId(n.col, n.floor) : model.nodes.has('a:' + state.owner) ? 'a:' + state.owner : '';
    select(next, 'model');
  }
  function onKey(e) {
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

  /* ---------- the inspector ---------- */

  function icon(key, color, size) {
    const c = el('canvas'); c.width = c.height = size * 2; c.style.width = c.style.height = size + 'px';
    const ctx = c.getContext('2d'); ctx.scale(2, 2);
    E.drawIcon(ctx, LOOKS[state.look], key, color, size);
    c.setAttribute('aria-hidden', 'true');
    return c;
  }
  function badge(status, size) {
    const c = el('canvas'), look = LOOKS[state.look]; c.width = c.height = size * 2; c.style.width = c.style.height = size + 'px';
    const ctx = c.getContext('2d'); ctx.scale(2, 2);
    E.drawBadge(ctx, M.STATES[status].shape, size / 2, size / 2, size * .3, look.palette.state[status], look.palette.panel);
    c.setAttribute('aria-hidden', 'true');
    return c;
  }
  function renderInspector() {
    const box = $('inspector'), n = model.nodes.get(state.selected);
    if (!n) {
      box.replaceChildren(el('h2', '', 'Inspector'), el('p', 'empty', 'Nothing is selected. Click a shape, or put the focus on the scene and press an arrow key.'));
      return;
    }
    const d = N.describe(n, model), v = view.visual(n), head = el('div', 'insp-head'), names = el('div');
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
    parts.push(el('h3', '', 'In VS Code'), el('p', 'hint', 'What the wiring would do. These are labels, not controls.'), acts);
    box.replaceChildren(...parts);
  }

  /* ---------- the list twin ---------- */

  const rowOf = new Map();      // row key -> element
  let rowSeq = 0;
  function rebuildTwin() {
    rowOf.clear();
    const parts = [];
    for (const group of N.rows(model)) {
      const box = el('div'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', group.title);
      const title = el('div', 'twin-title', group.title); title.setAttribute('aria-hidden', 'true');
      box.append(title);
      for (const row of group.rows) {
        const item = el('div', 'twin-row', row.text);
        item.id = 'row-' + (++rowSeq); item.setAttribute('role', 'option'); item.dataset.node = row.id; item.setAttribute('aria-selected', 'false');
        rowOf.set(row.key, item); box.append(item);
      }
      parts.push(box);
    }
    if (!parts.length) parts.push(el('p', 'hint', 'No session yet.'));
    twin.replaceChildren(...parts);
    markTwin(false);
  }
  function refreshTwin(ids) {
    for (const id of ids) {
      const n = model.nodes.get(id);
      if (!n || n.folded) continue;
      const text = N.line(n, model);
      for (const key of [id, 'attention ' + id]) { const item = rowOf.get(key); if (item && item.textContent !== text) item.textContent = text; }
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
  twin.addEventListener('keydown', e => {
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
    return c;
  }
  function buildLegend() {
    const look = LOOKS[state.look], pal = look.palette, body = $('legend-body');
    const item = (mark, name, key) => { const row = el('div', 'legend-item'), text = el('span', '', name); if (key) { countOf[key] = el('i', '', ''); text.append(' ', countOf[key]); } row.append(mark, text); return row; };
    const line = (color, dash, extra) => sample(ctx => { ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.6; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(2, 7); ctx.lineTo(32, 7); ctx.stroke(); ctx.setLineDash([]); if (extra) extra(ctx); });
    const classes = el('div', 'legend-grid');
    classes.append(
      item(icon('agent', pal.cls.agent, 22), 'Agent', 'agent'), item(icon('subagent', pal.cls.subagent, 22), 'Subagent', 'subagent'),
      item(icon('tool', pal.cls.tool, 22), 'Tool', 'tool'), item(icon('mcp', pal.cls.mcp, 22), 'MCP server', 'mcp'),
      item(icon('resource.file', pal.cls.resource, 22), 'Files', 'file'), item(icon('resource.url', pal.cls.resource, 22), 'URLs', 'url'),
      item(icon('resource.context', pal.cls.resource, 22), 'Context', 'context'), item(icon('stack', pal.muted, 22), '+N idle, folded'));
    const states = el('div', 'legend-grid');
    for (const key of Object.keys(M.STATES)) if (M.STATES[key].shape) states.append(item(badge(key, 18), M.STATES[key].name));
    const calls = el('div', 'legend-grid legend-wide');
    calls.append(
      item(line(pal.cls.tool, []), 'Tool call, while it is open'),
      item(line(pal.cls.mcp, [], ctx => { ctx.beginPath(); ctx.arc(31, 7, 2.5, 0, 7); ctx.fill(); }), 'MCP call, to the tool’s port on the server'),
      item(line(pal.cls.resource, [5, 4], ctx => { ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(4, 7, 2.6, 0, 7); ctx.fillStyle = pal.panel; ctx.fill(); ctx.stroke(); }), 'Read (dashed); a ring marks a resource that was read'),
      item(line(pal.cls.resource, [], ctx => { ctx.beginPath(); ctx.moveTo(33, 7); ctx.lineTo(26, 3.5); ctx.lineTo(26, 10.5); ctx.closePath(); ctx.fill(); ctx.fillRect(1.4, 4.4, 5.2, 5.2); }), 'Write (solid, with a head); a square marks a resource that was written'),
      item(line(pal.cls.resource, [1, 4]), 'Search (dotted)'),
      item(line(pal.cls.tool, [2, 6]), 'A call that has just ended; a cross if it failed'),
      item(line(pal.clash, [6, 4], ctx => { ctx.font = 'bold 9px sans-serif'; ctx.fillText('!', 15, 6); }), 'Two agents wrote the same file'));
    body.replaceChildren(el('h3', '', 'Classes (files, URLs and context are resources)'), classes, el('h3', '', 'States (a mark beside the shape)'), states, el('h3', '', 'Calls'), calls,
      el('p', 'hint', 'A resource grows with the number of times it was touched. A dashed agent is a session that has ended.'));
    countLegend();
  }
  function countLegend() {
    const counts = Object.assign(model.classCounts(), { file: 0, url: 0, context: 0 });
    for (const n of model.nodes.values()) if (n.cls === 'resource') counts[n.kind]++;
    for (const key of Object.keys(countOf)) countOf[key].textContent = '(' + counts[key] + ')';
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
  }
  /** Bring the inspector, the list and the legend up to date with what changed in the model. */
  function syncPanels() {
    const changes = model.takeChanges();
    keepSelection();
    const waiting = [...model.nodes.values()].filter(n => n.cls === 'agent' && n.status === 'needs').sort((a, b) => a.since - b.since);
    const attention = waiting.map(n => n.id).join(' ');
    if (changes.structure || attention !== state.attention) { rebuildTwin(); countLegend(); } else refreshTwin(changes.ids);
    if (attention !== state.attention) {
      const before = state.attention.split(' '), fresh = waiting.filter(n => !before.includes(n.id));
      if (fresh.length) $('live').textContent = fresh.map(n => n.label + ' needs you' + (n.wait ? ': ' + n.wait.why : '')).join('. ') + '.';
      state.attention = attention;
    }
    if (state.selected && changes.ids.has(state.selected)) renderInspector();
  }

  /* ---------- controls: the simulated feed and the view, never the information ---------- */

  function press(selector, test) { for (const b of document.querySelectorAll(selector)) b.setAttribute('aria-pressed', String(test(b))); }
  function applyLook() {
    const look = LOOKS[state.look], pal = look.palette, root = document.documentElement.style;
    for (const [name, value] of [['--bg', pal.bg], ['--panel', pal.panel], ['--line', pal.line], ['--ink', pal.ink], ['--text', pal.caption], ['--muted', pal.muted], ['--accent', pal.accent], ['--font', look.font]]) root.setProperty(name, value);
    document.documentElement.style.colorScheme = look.theme;
    press('[data-look]', b => b.dataset.look === state.look);
    view.setLook(look); buildLegend(); renderInspector();
  }
  /** A new stream: a fresh model, and the camera framed on the columns the preset will use. */
  function restart() {
    model = M.create(); state.attention = ''; state.memo = {};
    view.setModel(model);
    feed.preset({ agents: state.agents, load: state.load, seed: state.seed });
    if (state.warm) feed.warm(state.warm * 1000);
    press('[data-agents]', b => Number(b.dataset.agents) === state.agents);
    press('[data-load]', b => b.dataset.load === state.load);
    $('isolate').setAttribute('aria-pressed', 'false');
    select('', 'model'); rebuildTwin(); countLegend();
    view.resetCamera(range(state.agents));
  }
  function setIsolated(on) {
    const n = model.nodes.get(state.selected);
    if (on && n && n.col !== L.DOCK) view.isolate(n.col); else view.release();
    $('isolate').setAttribute('aria-pressed', String(view.isolated != null));
    $('isolate').disabled = view.isolated == null && !(n && n.col !== L.DOCK);
  }
  function setPlaying(on) {
    if (on) feed.start(); else feed.pause();
    $('play').textContent = on ? 'Pause' : 'Start'; $('play').setAttribute('aria-pressed', String(on));
  }
  function keepClear() {
    const base = canvas.getBoundingClientRect();
    view.keepClear = [$('view-buttons'), $('hud')].map(box => { const r = box.getBoundingClientRect(); return { x: r.left - base.left - 4, y: r.top - base.top - 4, w: r.width + 8, h: r.height + 8 }; });
    document.documentElement.style.setProperty('--bar-height', document.querySelector('.bar').getBoundingClientRect().height + 'px');
  }

  $('play').addEventListener('click', () => setPlaying(!feed.running()));
  $('speed').addEventListener('click', () => {
    const steps = F.PRESETS.speed; state.speed = steps[(steps.indexOf(state.speed) + 1) % steps.length];
    feed.setSpeed(state.speed); $('speed').textContent = 'Speed ' + state.speed + 'x';
  });
  for (const b of document.querySelectorAll('[data-agents]')) b.addEventListener('click', () => { state.agents = Number(b.dataset.agents); restart(); });
  for (const b of document.querySelectorAll('[data-load]')) b.addEventListener('click', () => { state.load = b.dataset.load; restart(); });
  for (const b of document.querySelectorAll('[data-look]')) b.addEventListener('click', () => { state.look = b.dataset.look; applyLook(); });
  $('motion').addEventListener('click', () => { view.setMotion(!view.motion); $('motion').textContent = view.motion ? 'Motion on' : 'Motion off'; $('motion').setAttribute('aria-pressed', String(view.motion)); });
  if (reducedMotion) { $('motion').disabled = true; $('motion').textContent = 'Motion off (system setting)'; }
  $('frame').addEventListener('click', () => view.frame(view.isolated == null ? undefined : [view.isolated]));
  $('spread').addEventListener('click', () => {
    const on = view.spread === 1;
    view.setSpread(on ? L.SPREAD : 1); $('spread').setAttribute('aria-pressed', String(on));
    view.frame(view.isolated == null ? undefined : [view.isolated]);
  });
  $('isolate').addEventListener('click', () => setIsolated(view.isolated == null));
  $('tidy').addEventListener('click', () => { model.tidy(); view.dataChanged(); });
  $('list-toggle').addEventListener('click', () => { const on = document.body.classList.toggle('show-list'); $('list-toggle').setAttribute('aria-pressed', String(on)); if (on) twin.focus(); });

  /* ---------- start ---------- */

  buildHud();
  view.resize();
  applyLook();
  restart();
  keepClear();
  new ResizeObserver(() => { view.resize(); keepClear(); }).observe(canvas.parentElement);
  setPlaying(state.autostart);

  window.Monitor3D = { view, feed, state, select, get model() { return model; } };      // for the screenshot and measuring script
})();
