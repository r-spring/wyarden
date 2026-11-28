/* Wyarden 3D monitor: the looks. Which looks there are, what a look may set on the page around the
 * scene, and the switcher that chooses one. LOOKS.md (beside media/) is the guide to writing a look.
 *
 * A look is one file, look-<id>.js, which puts one object on `MonitorLooks`. This file names the 18
 * ids, in the order of docs/looks/README.md; docs/looks/looks.json holds the same list with each
 * look's source. A look that is not built yet is a stub: `stub(id)` gives the NEXUS look under that
 * id, marked `stub: true`, so the page loads and the switcher says "not built".
 *
 * Nothing here draws the scene (engine.js does) and nothing here says where a thing stands (layout.js).
 */
(function (root) {
  'use strict';
  const inNode = typeof module !== 'undefined' && module.exports;

  const GROUPS = ['Monitor', 'Original mock-ups', 'Board and landing page', 'From Entridir'];
  const LIST = [
    { id: 'nexus', name: 'NEXUS', group: GROUPS[0] },
    { id: 'glasshouse', name: 'Glasshouse', group: GROUPS[0] },
    { id: 'nexus-mockup', name: 'NEXUS mock-up', group: GROUPS[0] },
    { id: 'glasshouse-mockup', name: 'Glasshouse mock-up', group: GROUPS[0] },
    { id: 'lattice', name: 'Lattice original', group: GROUPS[1] },
    { id: 'circuit-city', name: 'Circuit City', group: GROUPS[1] },
    { id: 'orbital', name: 'Orbital Mechanics', group: GROUPS[1] },
    { id: 'glasshouse-original', name: 'Glasshouse original', group: GROUPS[1] },
    { id: 'synapse', name: 'Synapse', group: GROUPS[1] },
    { id: 'event-horizon', name: 'Event Horizon', group: GROUPS[1] },
    { id: 'signal-terrain', name: 'Signal Terrain', group: GROUPS[1] },
    { id: 'editor-theme', name: 'Editor theme', group: GROUPS[2] },
    { id: 'battle-neon', name: 'Battle neon', group: GROUPS[2] },
    { id: 'paper', name: 'Paper', group: GROUPS[2] },
    { id: 'paper-dark', name: 'Paper dark', group: GROUPS[2] },
    { id: 'skyline', name: 'Skyline', group: GROUPS[3] },
    { id: 'control-room', name: 'Control Room', group: GROUPS[3] },
    { id: 'signal-house', name: 'Signal House', group: GROUPS[3] }
  ];
  const ids = () => LIST.map(entry => entry.id);
  const entry = id => LIST.find(e => e.id === id) || null;

  /* What a look may set on the page besides its palette: `look.page = { key: 'a CSS value' }`.
     Each key is one CSS custom property that style.css uses with a fall-back, so a look that sets
     none of them (NEXUS, Glasshouse) leaves the page as it was. The list is fixed: a key that is not
     here is ignored. A size is never in it except the title's, because the bar keeps its height. */
  const PAGE = {
    ui: '--ui',                       // the page's text: a font-family list
    titleFont: '--title-font',        // "Monitor 3D" in the top bar: a font-family list
    titleStyle: '--title-style',      // normal | italic
    titleWeight: '--title-weight',    // 100 to 900
    titleSize: '--title-size',        // up to about 20px: the bar does not grow
    titleSpacing: '--title-spacing',  // letter-spacing
    titleCase: '--title-case',        // uppercase | none | lowercase | capitalize
    titleColor: '--title-color',
    titleShadow: '--title-shadow',    // a text-shadow, for a glow
    headFont: '--head-font',          // the panels' headings: a font-family list
    labelFont: '--label-font',        // the small spaced headings: a font-family list; absent, they have headFont's
    labelSpacing: '--label-spacing',  // the small headings' letter-spacing
    labelCase: '--label-case',        // the small headings: uppercase | none
    radius: '--radius',               // corners of buttons, chips and the boxes over the scene
    panelInk: '--panel-ink',          // the five below: the panels' own colours, where a panel is dark
    panelText: '--panel-text',        //   and the stage is light (or the other way round). The palette's
    panelMuted: '--panel-muted',      //   ink, caption, muted, line and accent are used on a panel
    panelLine: '--panel-line',        //   when these are absent.
    panelAccent: '--panel-accent'
  };

  /** The NEXUS look under another id, marked as not built. For look-<id>.js until its look is written. */
  function stub(id) {
    const e = entry(id);
    if (!e) throw new Error('looks: "' + id + '" is not in the list');
    const base = inNode ? require('./look-nexus.js') : root.MonitorLooks && root.MonitorLooks.nexus;
    if (!base) throw new Error('looks: look-nexus.js must load before the stub of "' + id + '"');
    return Object.assign({}, base, { id, name: e.name, stub: true });
  }

  /* ---------- the page around the scene ---------- */

  /** read(name, fallback): a CSS variable of the page as it is now, or the fall-back when it is absent or empty. */
  function reader(doc) {
    const style = doc.defaultView.getComputedStyle(doc.documentElement);
    return (name, fallback) => { const value = String(style.getPropertyValue(name) || '').trim(); return value || fallback; };
  }
  /** Let a look work out its colours from the page (look.fromPage), each time it is applied. */
  function refresh(look, doc) {
    if (typeof look.fromPage === 'function') look.fromPage(reader(doc));
    return look;
  }
  /** Everything of a look that the page shows, as one text: two equal texts need no second apply. */
  function signature(look) {
    return JSON.stringify([look.theme, look.font, look.lineWidth, look.glow, look.captionSize, look.palette, look.page || null]);
  }
  /** Set the look's lettering and panel variables, and clear every one it does not set. */
  function applyPage(look, style) {
    const page = look.page && typeof look.page === 'object' ? look.page : {};
    for (const key of Object.keys(PAGE)) {
      const value = Object.prototype.hasOwnProperty.call(page, key) && typeof page[key] === 'string' ? page[key].trim() : '';
      if (value) style.setProperty(PAGE[key], value); else style.removeProperty(PAGE[key]);
    }
  }
  /**
   * The colour behind a swatch that is drawn on a panel (the legend's and the inspector's shapes and marks).
   * A look's class and state colours are made for the stage. Where its panels have their own ink they may not show
   * on a panel, so there each swatch stands on the stage's colour. '' for every other look: nothing behind a swatch.
   */
  function swatchBack(look) {
    const page = look.page && typeof look.page === 'object' ? look.page : {};
    return ['panelInk', 'panelText', 'panelMuted'].some(key => typeof page[key] === 'string' && page[key].trim()) ? look.palette.bg : '';
  }
  /**
   * Call `changed` when the editor's theme changes under the page. VS Code rewrites the variables on
   * <html> and the classes on <body>; neither is a timer and neither asks for a frame. The page's own
   * writes to the same attributes arrive here too, so `changed` must do nothing when nothing changed.
   */
  function watchTheme(doc, changed) {
    const Observer = doc.defaultView.MutationObserver;
    if (typeof Observer !== 'function') return null;
    const observer = new Observer(() => changed());
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    if (doc.body) observer.observe(doc.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-kind', 'data-vscode-theme-id', 'data-vscode-theme-name'] });
    return observer;
  }

  /* ---------- the switcher: buttons only ---------- */

  /**
   * Fills the look switcher of page.html: "previous look", the current look's name (which opens the
   * list), "next look", and in the list one button for each look, grouped as LIST groups them.
   *   options.looks        the registered looks, by id (MonitorLooks)
   *   options.current()    the id of the look shown now
   *   options.choose(id)   the owner chose a look
   * Returns { show(id), close(), open() }: `show` names the look in the bar after it was applied.
   */
  function switcher(doc, options) {
    const $ = id => doc.getElementById(id), looks = options.looks || {};
    const prev = $('look-prev'), next = $('look-next'), name = $('look-name'), panel = $('look-panel');
    const el = (tag, cls, text) => { const node = doc.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
    const has = id => Object.prototype.hasOwnProperty.call(looks, id);
    const usable = () => ids().filter(has);
    const buttons = () => [...panel.querySelectorAll('button[data-look]:not(:disabled)')];
    const label = el('span', 'look-label'), tag = el('span', 'look-tag', 'not built'), caret = el('span', 'look-caret', '▾');
    caret.setAttribute('aria-hidden', 'true'); tag.hidden = true;
    name.replaceChildren(label, tag, caret);

    const parts = [];
    for (const group of GROUPS) {
      const box = el('div', 'look-group'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', group);
      box.append(el('span', 'group-name', group));
      for (const e of LIST.filter(x => x.group === group)) {
        const b = el('button'); b.type = 'button'; b.dataset.look = e.id; b.setAttribute('aria-pressed', 'false'); b.tabIndex = -1;
        b.append(el('span', 'look-label', e.name));
        if (!has(e.id)) { b.disabled = true; b.dataset.missing = 'true'; b.append(el('span', 'look-tag', 'missing')); b.setAttribute('aria-label', e.name + ', missing'); }
        else if (looks[e.id].stub) { b.dataset.stub = 'true'; b.append(el('span', 'look-tag', 'not built')); b.setAttribute('aria-label', e.name + ', not built'); b.title = e.name + ' is not built yet. Until it is, it is drawn like NEXUS.'; }
        box.append(b);
      }
      parts.push(box);
    }
    panel.replaceChildren(...parts);

    let isOpen = false;
    const outside = e => { if (!panel.contains(e.target) && !name.contains(e.target)) close(false); };
    function rove(to) { for (const b of buttons()) b.tabIndex = b === to ? 0 : -1; }
    function open() {
      if (isOpen) return;
      isOpen = true; panel.hidden = false; name.setAttribute('aria-expanded', 'true');
      doc.addEventListener('pointerdown', outside, true);
      const at = buttons().find(b => b.dataset.look === options.current()) || buttons()[0];
      if (at) { rove(at); at.focus(); }
    }
    function close(refocus) {
      if (!isOpen) return;
      isOpen = false; panel.hidden = true; name.setAttribute('aria-expanded', 'false');
      doc.removeEventListener('pointerdown', outside, true);
      if (refocus) name.focus();
    }
    function step(by) {
      const list = usable(), at = list.indexOf(options.current());
      if (list.length) options.choose(list[((at < 0 ? 0 : at + by) + list.length) % list.length]);
    }
    function show(id) {
      const e = entry(id), look = has(id) ? looks[id] : null, text = e ? e.name : id, stubbed = !!(look && look.stub);
      if (label.textContent !== text) label.textContent = text;
      tag.hidden = !stubbed;
      name.setAttribute('aria-label', 'Look: ' + text + (stubbed ? ', not built' : '') + '. Choose a look');
      name.title = 'Look: ' + text + (stubbed ? ' (not built: drawn like NEXUS)' : '') + '. Opens the list of looks.';
      for (const b of panel.querySelectorAll('button[data-look]')) b.setAttribute('aria-pressed', String(b.dataset.look === id));
      rove(buttons().find(b => b.dataset.look === id) || buttons()[0]);
    }

    prev.addEventListener('click', () => step(-1));
    next.addEventListener('click', () => step(1));
    name.addEventListener('click', () => { if (isOpen) close(true); else open(); });
    name.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' && !isOpen) { e.preventDefault(); open(); }
      else if (e.key === 'Escape' && isOpen) { e.preventDefault(); close(true); }
    });
    panel.addEventListener('click', e => {
      const b = e.target.closest ? e.target.closest('button[data-look]') : null;
      if (!b || b.disabled || !has(b.dataset.look)) return;
      options.choose(b.dataset.look);
      close(true);
    });
    panel.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
      const list = buttons(), at = list.indexOf(doc.activeElement);
      if (at < 0) return;
      const to = { ArrowRight: (at + 1) % list.length, ArrowDown: (at + 1) % list.length, ArrowLeft: (at - 1 + list.length) % list.length, ArrowUp: (at - 1 + list.length) % list.length, Home: 0, End: list.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault(); rove(list[to]); list[to].focus();
    });
    // Tab leaves the list: it closes behind the focus.
    panel.addEventListener('focusout', e => { if (isOpen && e.relatedTarget && !panel.contains(e.relatedTarget) && !name.contains(e.relatedTarget)) close(false); });

    return { show, open, close: () => close(false), get isOpen() { return isOpen; } };
  }

  const api = { GROUPS, LIST, PAGE, ids, entry, stub, reader, refresh, signature, applyPage, swatchBack, watchTheme, switcher };
  if (inNode) module.exports = api; else root.MonitorLookRegistry = api;
})(typeof window === 'undefined' ? globalThis : window);
