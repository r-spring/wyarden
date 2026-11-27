/* Wyarden 3D monitor, working mock-up: the seam between the extension host and the page.
 *
 * The mock-up's page took its events from a simulator through one function, subscribe(onEvent).
 * This file stands where the simulator stood (docs/monitor-3d/04-wiring-plan.md section 5.1): it
 * listens for the host's messages (docs/monitor-3d/05-working-mockup.md section 8.1) and hands each
 * one to the page in the order it came.
 *
 *     const feed = MonitorHostFeed.create(acquireVsCodeApi());
 *     feed.subscribe((event, scope) => {});          // every record that has `ev`, in order
 *     feed.onSnapshot = (state, scope, record) => {}; // {ctl: "snapshot"}: state is model.serialize() text
 *     feed.onDrop = (key, why, scope) => {};          // {ctl: "drop"}
 *     feed.onWorkspaces = message => {};              // {type: "workspaces"}
 *     feed.onHub = message => {};                     // {type: "hub"}
 *     feed.onLook = look => {};                       // {type: "look"}
 *     feed.post({type: "scope", scope});              // v: 1 is added
 *     feed.start();                                   // sends {v: 1, type: "ready"} once
 *
 * A message of another version or an unknown type, and a record of an unknown shape, are ignored.
 * A handler that throws is counted in `feed.errors` and never stops the next record: one bad record
 * must not freeze the view, and an exception thrown into VS Code's message dispatch would be lost anyway.
 */
(function (root) {
  'use strict';
  const VERSION = 1;

  function create(api, options) {
    if (!api || typeof api.postMessage !== 'function') throw new Error('host feed: the VS Code API is required');
    const target = (options && options.window) || root;
    const listeners = new Set();
    let started = false, listening = false;

    const feed = {
      onSnapshot: null, onDrop: null, onWorkspaces: null, onHub: null, onLook: null,
      errors: 0, lastError: '', received: 0, ignored: 0,
      subscribe(onEvent) { listeners.add(onEvent); return () => listeners.delete(onEvent); },
      post(message) { api.postMessage(Object.assign({}, message, { v: VERSION })); },
      start() {
        listen();
        if (started) return;
        started = true;
        feed.post({ type: 'ready' });
      },
      /** Stop listening (for tests; a webview page simply goes away). */
      close() { if (listening) target.removeEventListener('message', onMessage); listening = false; },
      /** Handle one host message as if it had arrived (for tests in Node). */
      handle
    };

    function call(fn, args) {
      if (typeof fn !== 'function') return;
      try { fn.apply(null, args); } catch (error) {
        feed.errors++; feed.lastError = String(error && error.message || error);
        if (root.console) root.console.warn('monitor host feed: ' + feed.lastError);
      }
    }
    function record(r, scope) {
      if (!r || typeof r !== 'object') { feed.ignored++; return; }
      if (r.ctl === 'snapshot') {
        if (typeof r.state !== 'string') { feed.ignored++; return; }
        call(feed.onSnapshot, [r.state, typeof r.scope === 'string' ? r.scope : scope, r]);
      } else if (r.ctl === 'drop') {
        if (typeof r.key !== 'string' || !r.key) { feed.ignored++; return; }
        call(feed.onDrop, [r.key, r.why, scope]);
      } else if (typeof r.ev === 'string') {
        for (const fn of [...listeners]) call(fn, [r, scope]);
      } else feed.ignored++;
    }
    function handle(m) {
      if (!m || typeof m !== 'object' || m.v !== VERSION || typeof m.type !== 'string') { feed.ignored++; return; }
      feed.received++;
      if (m.type === 'records') {
        if (!Array.isArray(m.records)) { feed.ignored++; return; }
        const scope = typeof m.scope === 'string' ? m.scope : '';
        for (const r of m.records) record(r, scope);
      } else if (m.type === 'workspaces') {
        if (Array.isArray(m.list)) call(feed.onWorkspaces, [m]); else feed.ignored++;
      } else if (m.type === 'hub') {
        call(feed.onHub, [m]);
      } else if (m.type === 'look') {
        if (typeof m.look === 'string') call(feed.onLook, [m.look]); else feed.ignored++;
      } else feed.ignored++;
    }
    function onMessage(e) {
      try { handle(e && e.data); } catch (error) { feed.errors++; feed.lastError = String(error && error.message || error); }
    }
    function listen() {
      if (listening || typeof target.addEventListener !== 'function') return;
      target.addEventListener('message', onMessage);
      listening = true;
    }
    listen();          // from the start, so a message that comes before start() is not lost
    return feed;
  }

  const api = { create, VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MonitorHostFeed = api;
})(typeof window === 'undefined' ? globalThis : window);
