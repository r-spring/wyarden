// The selected session's thinking, on the page (media/page.js, media/host-feed.js), in a real headless browser:
// what the page asks the host for and when, how the answer is shown, that it is shown as text and kept nowhere,
// and that it costs no frame. The host's half is test/thinking-watch.test.js. Every id and text is invented.
//
// Needs Edge or Chrome (WYARDEN_BROWSER overrides the search). With none, every test is SKIPPED and says why.
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { findBrowser, Harness, sleep } = require('./page-harness.js');
const S = require('./fixtures/stream/streams.js');
const M = require('../media/model.js');

const browser = findBrowser();
const skip = browser.path ? false : 'NO BROWSER: ' + browser.why + '; the thinking page tests did not run';
if (skip) console.log(skip);
const T = { timeout: 90000, skip };

/** A node whose centre is on the canvas, not under an overlay, and that picking finds there (as in test/page.test.js). */
const findNode = test => `(() => {
  const v = Monitor3D.view, r = v.canvas.getBoundingClientRect(), m = Monitor3D.model;
  const h = v.hit.find(h => { const n = m.nodes.get(h.id); return n && (${test})(n) && h.x > 4 && h.y > 4 && h.x < v.width - 4 && h.y < v.height - 4 && document.elementFromPoint(r.left + h.x, r.top + h.y) === v.canvas && v.pick(h.x, h.y) === h.id; });
  return h ? { id: h.id, cls: m.nodes.get(h.id).cls, x: r.left + h.x, y: r.top + h.y } : null;
})()`;
/** What the section shows: hidden or not, its status line, and each thought as [time label, text]. */
const SECTION = `(() => {
  const b = document.getElementById('thinking');
  if (!b) return null;
  return { hidden: b.hidden, open: b.open, label: b.getAttribute('aria-label'), summary: b.querySelector('summary').textContent, status: b.querySelector('.hint').textContent,
    items: [...b.querySelectorAll('.thoughts li')].map(li => [(li.querySelector('time') || { textContent: '' }).textContent, li.querySelector('.thought-text').textContent]),
    after: b.previousElementSibling && b.previousElementSibling.id, shown: !b.hidden && b.getClientRects().length > 0 };
})()`;
const start = id => ({ v: 1, type: 'thinking', target: { class: 'agent', id } });
const stop = { v: 1, type: 'thinking', target: null };
const thinkingPosted = posted => posted.filter(m => m.type === 'thinking');
const T1 = Date.parse('2026-01-02T03:04:05.000Z'), T2 = Date.parse('2026-01-02T03:04:09.000Z'), T3 = Date.parse('2026-01-02T13:20:00.000Z');
/** A host message, as lib/thinking-watch.js builds it. */
function message(id, state, fields = {}) {
  return Object.assign({ v: 1, type: 'thinking', id, state, thoughts: [], recorded: 0, unrecorded: 0, more: 0, whole: true }, fields);
}
const recorded = (id, thoughts, fields = {}) => message(id, 'recorded', Object.assign({ thoughts, recorded: thoughts.length }, fields));
const CANARY = 'CANARY-PAGE-THINKING-4e9b';

describe('the thinking section in a headless browser', () => {
  let h;
  before(async () => { if (!skip) h = await Harness.start(browser.path); });
  after(async () => { if (h) await h.close(); });

  /** A fresh page with a scene of four agents. */
  async function scene(options) {
    await h.open(options);
    const s = S.scene({ agents: 4 });
    await h.deliver(s.message);
    await sleep(800);
    return s;
  }
  /** The Claude Code sessions' agents: the only ones whose thinking is asked for. */
  const agents = () => h.eval("[...Monitor3D.model.nodes.values()].filter(n => n.cls === 'agent' && n.kind === 'claude').map(n => n.id)");

  it('1. an agent selected (a click, or Monitor3D.select) asks once; a tool or no selection stops once; a restored selection asks', T, async () => {
    await scene();
    assert.deepEqual(await h.eval(SECTION), { hidden: true, open: true, label: 'Thinking', summary: 'Thinking', status: '', items: [], after: 'inspector', shown: false }, 'built hidden, right after the inspector');
    const agent = await h.eval(findNode("n => n.cls === 'agent' && n.kind === 'claude'"));
    assert.ok(agent, 'an agent to click');
    await h.clearPosted();
    await h.click(agent.x, agent.y);
    await sleep(300);
    assert.deepEqual(await h.posted(), [{ v: 1, type: 'select', target: { class: 'agent', id: agent.id } }, start(agent.id)], 'a click: its select, then one request');
    await h.click(agent.x, agent.y);
    await sleep(200);
    assert.deepEqual(thinkingPosted(await h.posted()), [start(agent.id)], 'the same agent again asks nothing more');

    const other = (await agents()).find(id => id !== agent.id);
    await h.clearPosted();
    await h.eval(`Monitor3D.select(${JSON.stringify(other)}, 'model')`);
    assert.deepEqual(await h.posted(), [start(other)], 'Monitor3D.select of another agent: one request, for it');

    const tool = await h.eval(findNode("n => n.cls === 'tool'"));
    assert.ok(tool, 'a tool to click');
    await h.clearPosted();
    await h.click(tool.x, tool.y);
    await sleep(300);
    assert.deepEqual(await h.posted(), [{ v: 1, type: 'select', target: { class: 'tool', id: tool.id } }, stop], 'a tool: one stop');
    const another = await h.eval("[...Monitor3D.model.nodes.values()].find(n => (n.cls === 'resource' || n.cls === 'mcp') && !n.folded).id");
    await h.clearPosted();
    await h.eval(`Monitor3D.select(${JSON.stringify(another)}, 'model')`);
    assert.deepEqual(await h.posted(), [], 'from one thing that is not an agent to another: nothing');

    await h.eval(`Monitor3D.select(${JSON.stringify(agent.id)}, 'model')`);
    await h.clearPosted();
    await h.eval("document.getElementById('scene').focus()");
    await h.key('Escape', 'Escape', 27);
    await sleep(200);
    assert.equal(await h.eval('Monitor3D.state.selected'), '');
    assert.deepEqual(await h.posted(), [stop], 'Escape clears the selection: one stop');
    await h.eval("Monitor3D.select('', 'model')");
    assert.deepEqual(await h.posted(), [stop], 'and no second one');

    // Saved with an agent selected; the page reloads (as VS Code reloads a tab that was hidden) and asks again.
    await h.eval(`Monitor3D.select(${JSON.stringify(agent.id)}, 'model')`);
    await sleep(100);
    const states = await h.eval('window.__states');
    const saved = states[states.length - 1];
    assert.equal(saved.selected, agent.id);
    await h.open({ state: saved });
    assert.deepEqual(await h.posted(), [{ v: 1, type: 'ready' }], 'nothing is asked before the scene is there');
    await h.deliver(S.scene({ agents: 4 }).message);
    await sleep(300);
    assert.equal(await h.eval('Monitor3D.state.selected'), agent.id, 'the selection came back');
    assert.deepEqual(await h.posted(), [{ v: 1, type: 'ready' }, start(agent.id)], 'a restored selection asks once');
    assert.equal((await h.eval(SECTION)).status, 'Reading this session\'s transcript…');
    assert.deepEqual(h.errors, []);
  });

  it('2. a "recorded" answer shows the section, its status line and the thoughts newest first, as text only', T, async () => {
    await scene();
    const [id] = await agents();
    await h.eval(`Monitor3D.select(${JSON.stringify(id)}, 'model')`);
    assert.deepEqual(await h.eval(SECTION), { hidden: false, open: true, label: 'Thinking', summary: 'Thinking', status: 'Reading this session\'s transcript…', items: [], after: 'inspector', shown: true });
    const trap = '<img src=x onerror=alert(1)><b>bold</b>';
    await h.deliver(recorded(id, [
      { at: T3, text: 'The newest invented thought.\n\nIt keeps its empty line.' },
      { at: T2, text: trap },
      { at: null, text: 'An invented thought with no time.' },
      { at: T1, text: 'The oldest invented thought.' }
    ], { recorded: 6, more: 2, unrecorded: 1 }));
    const got = await h.eval(SECTION);
    assert.equal(got.shown, true);
    assert.equal(got.status, '6 thoughts recorded. The newest 4 are shown. 1 more left no text.');
    assert.deepEqual(got.items, [
      ['13:20:00 UTC', 'The newest invented thought.\n\nIt keeps its empty line.'],
      ['03:04:09 UTC', trap],
      ['', 'An invented thought with no time.'],
      ['03:04:05 UTC', 'The oldest invented thought.']
    ]);
    assert.equal(await h.eval("document.querySelectorAll('#thinking img, #thinking b').length + document.querySelectorAll('img').length"), 0, 'the markup is text: no img, no b');
    assert.equal(await h.eval("document.querySelectorAll('#thinking .thoughts li')[2].querySelector('time')"), null, 'no time label when the time is not known');
    assert.equal(await h.eval("document.querySelector('#thinking time').dateTime"), '2026-01-02T13:20:00.000Z');
    assert.deepEqual(await h.eval("(() => { const s = getComputedStyle(document.querySelector('#thinking .thought-text')); return [s.whiteSpace, s.overflowWrap]; })()"), ['pre-wrap', 'anywhere']);
    // The inspector is redrawn while the agent changes; the section is not part of it and stays.
    await h.eval(`Monitor3D.select(${JSON.stringify(id)}, 'model')`);
    await h.deliver({ v: 1, type: 'look', look: 'glasshouse' });
    assert.deepEqual((await h.eval(SECTION)).items.length, 4, 'a redrawn inspector leaves the section alone');
    assert.deepEqual(await h.eval('__m.errors'), []);
    assert.deepEqual(h.errors, []);
  });

  it('3. an answer for another id changes nothing; after deselecting, the section is hidden and holds no thought text', T, async () => {
    await scene();
    const [id, other] = await agents();
    await h.deliver(recorded(id, [{ at: T1, text: CANARY + ' before anything was asked' }]));
    assert.equal((await h.eval(SECTION)).hidden, true, 'an answer that was not asked for shows nothing');
    assert.ok(!(await h.eval("document.getElementById('thinking').textContent")).includes(CANARY));
    await h.eval(`Monitor3D.select(${JSON.stringify(id)}, 'model')`);
    await h.deliver(recorded(id, [{ at: T1, text: CANARY + ' for the selected agent' }]));
    const shown = await h.eval(SECTION);
    await h.deliver(recorded(other, [{ at: T2, text: 'For another agent, never shown.' }]));
    await h.deliver(message(other, 'gone'));
    assert.deepEqual(await h.eval(SECTION), shown, 'an answer for another id changes nothing');
    // Moving to the other agent: its own request, and none of the first one's thoughts stay.
    await h.eval(`Monitor3D.select(${JSON.stringify(other)}, 'model')`);
    let got = await h.eval(SECTION);
    assert.deepEqual([got.status, got.items], ['Reading this session\'s transcript…', []]);
    await h.deliver(recorded(id, [{ at: T1, text: 'A late answer for the first agent.' }]));
    assert.deepEqual((await h.eval(SECTION)).items, [], 'a late answer for the agent before is dropped');
    await h.deliver(recorded(other, [{ at: T2, text: CANARY + ' for the second agent' }]));
    await h.eval("Monitor3D.select('', 'model')");
    got = await h.eval(SECTION);
    assert.equal(got.hidden, true);
    assert.equal(got.shown, false);
    assert.deepEqual(got.items, []);
    assert.equal(await h.eval("document.querySelectorAll('#thinking li, #thinking .thought-text, #thinking time').length"), 0, 'the thoughts left the DOM');
    assert.ok(!(await h.eval('document.body.textContent')).includes(CANARY), 'no thought text anywhere in the page');
  });

  it('4. every state\'s status line, with the singular forms and the combined suffixes', T, async () => {
    await scene();
    const [id] = await agents();
    await h.eval(`Monitor3D.select(${JSON.stringify(id)}, 'model')`);
    const forty = Array.from({ length: 40 }, (_, i) => ({ at: T1 + i * 1000, text: 'Invented thought ' + i + '.' }));
    const rows = [
      [recorded(id, [{ at: T1, text: 'One.' }]), '1 thought recorded.'],
      [recorded(id, [{ at: T1, text: 'One.' }, { at: T2, text: 'Two.' }]), '2 thoughts recorded.'],
      [recorded(id, [{ at: T1, text: 'One.' }], { recorded: 3, more: 2 }), '3 thoughts recorded. Only the newest is shown.'],
      [recorded(id, [{ at: T1, text: 'One.' }, { at: T2, text: 'Two.' }], { recorded: 5, more: 3 }), '5 thoughts recorded. The newest 2 are shown.'],
      [recorded(id, [{ at: T1, text: 'One.' }], { unrecorded: 1 }), '1 thought recorded. 1 more left no text.'],
      [recorded(id, [{ at: T1, text: 'One.' }], { recorded: 1, whole: false }), '1 thought recorded. Only the end of the transcript was read.'],
      [recorded(id, [{ at: T1, text: 'One.' }], { recorded: 2, more: 1, unrecorded: 1, whole: false }), '2 thoughts recorded. Only the newest is shown. 1 more left no text. Only the end of the transcript was read.'],
      [recorded(id, forty, { recorded: 52, more: 12, unrecorded: 9, whole: false }), '52 thoughts recorded. The newest 40 are shown. 9 more left no text. Only the end of the transcript was read.'],
      [message(id, 'unrecorded', { unrecorded: 1 }), 'Claude thought 1 time here, and Claude Code recorded no text for it. It records the text for a session started with --thinking-display summarized.'],
      [message(id, 'unrecorded', { unrecorded: 14 }), 'Claude thought 14 times here, and Claude Code recorded no text for it. It records the text for a session started with --thinking-display summarized.'],
      [message(id, 'unrecorded', { unrecorded: 2, whole: false }), 'Claude thought 2 times here, and Claude Code recorded no text for it. It records the text for a session started with --thinking-display summarized. Only the end of the transcript was read.'],
      [message(id, 'none'), 'No thinking in this session yet.'],
      [message(id, 'none', { whole: false }), 'No thinking in the last part of the transcript. Only its end was read.'],
      [message(id, 'not-yet'), 'This session\'s transcript is not written yet.'],
      [message(id, 'ended'), 'This session has ended.'],
      [message(id, 'gone'), 'The hub names no session for this node. It is asked again.'],
      [message(id, 'unreadable'), 'This session\'s transcript could not be read. It is tried again.']
    ];
    for (const [m, line] of rows) {
      await h.deliver(m);
      const got = await h.eval(SECTION);
      assert.equal(got.status, line, m.state);
      assert.equal(got.items.length, m.state === 'recorded' ? m.thoughts.length : 0, m.state + ': the list');
      assert.equal(got.shown, true);
    }
    assert.deepEqual(h.errors, []);
  });

  it('5. no control in the section: no button, link, input, select, textarea or contenteditable', T, async () => {
    await scene();
    const [id] = await agents();
    await h.eval(`Monitor3D.select(${JSON.stringify(id)}, 'model')`);
    await h.deliver(recorded(id, [{ at: T1, text: 'An invented thought with <a href="x">a link</a> and <button>a button</button>.' }]));
    assert.equal(await h.eval("document.querySelectorAll('#thinking button, #thinking a, #thinking input, #thinking select, #thinking textarea, #thinking [contenteditable], #thinking form').length"), 0);
    assert.equal(await h.eval('document.querySelectorAll("input, select, textarea, form, [contenteditable]").length'), 0, 'nor anywhere in the page');
  });

  it('6. at rest with an agent selected and its thinking shown: 0 frames, 0 animation frames; the same answer again changes no node', T, async () => {
    await scene();
    const [id] = await agents();
    await h.eval(`Monitor3D.select(${JSON.stringify(id)}, 'model')`);
    const answer = recorded(id, [{ at: T2, text: 'The newest invented thought.' }, { at: T1, text: 'An older invented thought.' }], { unrecorded: 2 });
    await h.deliver(answer);
    await sleep(800);
    await h.eval(`(() => { window.__mutations = 0; window.__observer = new MutationObserver(list => { window.__mutations += list.length; });
      window.__observer.observe(document.getElementById('thinking'), { subtree: true, childList: true, characterData: true, attributes: true }); return true; })()`);
    const nodes = await h.eval("(() => { window.__nodes = [...document.querySelectorAll('#thinking *')]; return window.__nodes.length; })()");
    const a = await h.counters();
    for (let i = 0; i < 3; i++) { await h.deliver(answer); await sleep(1000); }       // the host's answer, as it comes when the file changed but not its thinking
    const b = await h.counters();
    assert.equal(b[0] - a[0], 0, 'frames drawn at rest');
    assert.equal(b[1] - a[1], 0, 'animation frames asked for at rest');
    assert.equal(await h.eval('window.__mutations + window.__observer.takeRecords().length'), 0, 'the same answer changes no node');
    assert.equal(await h.eval("(() => { const now = [...document.querySelectorAll('#thinking *')]; return now.length === window.__nodes.length && now.every((n, i) => n === window.__nodes[i]); })()"), true, 'the very same nodes');
    assert.ok(nodes >= 7, 'summary, status, list and two thoughts: ' + nodes);
    // A real change is shown, and still costs no frame.
    const c = await h.counters();
    await h.deliver(recorded(id, [{ at: T3, text: 'A new invented thought.' }, ...answer.thoughts], { unrecorded: 2 }));
    await sleep(500);
    const d = await h.counters();
    assert.equal((await h.eval(SECTION)).items.length, 3);
    assert.deepEqual([d[0] - c[0], d[1] - c[1]], [0, 0], 'an answer draws no frame');
  });

  it('7. thinking text is in neither the saved state nor anything posted to the host, nor in #live or the status line', T, async () => {
    await scene();
    const [id, other] = await agents();
    await h.eval(`Monitor3D.select(${JSON.stringify(id)}, 'model')`);
    const globals = await h.eval('Object.getOwnPropertyNames(window)');
    await h.deliver(recorded(id, [{ at: T1, text: CANARY + ' newest' }, { at: null, text: CANARY + ' older' }]));
    // Text only: no attribute of any element in the section holds it, and the page kept it nowhere a script can reach.
    assert.deepEqual(await h.eval(`[...document.querySelectorAll('#thinking, #thinking *')].flatMap(e => [...e.attributes].map(a => e.tagName + ' ' + a.name + '=' + a.value)).filter(s => s.includes(${JSON.stringify(CANARY)}))`), [], 'in no attribute');
    assert.deepEqual((await h.eval('Object.getOwnPropertyNames(window)')).filter(name => !globals.includes(name)), [], 'no new property on window');
    const exposed = `(() => {
      const seen = new WeakSet();
      const text = JSON.stringify(window.Monitor3D, (key, value) => {
        if (!value || typeof value !== 'object') return value;
        if (value instanceof Node || value === window || seen.has(value)) return undefined;
        seen.add(value);
        if (value instanceof Map) return [...value.entries()];
        if (value instanceof Set) return [...value];
        return value;
      });
      return { length: text.length, holds: text.includes(${JSON.stringify(CANARY)}) };
    })()`;
    const what = await h.eval(exposed);
    assert.ok(what.length > 1000, 'the model, the view and the feed were walked: ' + what.length);
    assert.equal(what.holds, false, 'not in what window.Monitor3D exposes');
    // Everything that saves or posts, after the text is shown: the camera, a view button, another selection and back, a scope chip.
    await h.eval('Monitor3D.view.orbit(0.2, 0.1)');
    await sleep(200);
    await h.eval("document.getElementById('spread').click()");
    await h.eval(`Monitor3D.select(${JSON.stringify(other)}, 'scene')`);
    await h.eval(`Monitor3D.select(${JSON.stringify(id)}, 'scene')`);
    await h.deliver(recorded(id, [{ at: T1, text: CANARY + ' again' }]));
    await h.deliver(S.workspaces({}));
    await h.eval("document.querySelector('#chips .chip:not([aria-pressed=\"true\"])').click()");
    await sleep(300);
    const states = await h.eval('window.__states'), posted = await h.posted();
    assert.ok(states.length >= 2, 'the page saved its state after the text was shown');
    assert.ok(posted.some(m => m.type === 'scope') && posted.some(m => m.type === 'select'), 'and posted to the host');
    assert.ok(!JSON.stringify(states).includes(CANARY), 'not in the saved state');
    assert.ok(!JSON.stringify(posted).includes(CANARY), 'not posted to the host');
    assert.ok(!JSON.stringify(posted).includes('newest'), 'nothing derived from it either');
    for (const m of thinkingPosted(posted)) assert.ok(m.target === null || (Object.keys(m).join() === 'type,target,v' && Object.keys(m.target).join() === 'class,id'), 'a request holds a node id and nothing else');
    for (const selector of ['#live', '#status-live', '#status', '#inspector', '#twin']) {
      assert.ok(!(await h.eval(`document.querySelector(${JSON.stringify(selector)}).textContent`)).includes(CANARY), 'not in ' + selector);
    }
    assert.ok((await h.eval("document.getElementById('thinking').textContent")).includes(CANARY), 'it is on screen, where it belongs');
    assert.equal((await h.eval(exposed)).holds, false, 'and still not in what window.Monitor3D exposes');
  });

  it('11. another provider\'s agent asks for nothing and shows no section; its "In VS Code" row is the old one', T, async () => {
    await scene();
    const otherKind = await h.eval("([...Monitor3D.model.nodes.values()].find(n => n.cls === 'agent' && n.kind !== 'claude') || {}).id");
    assert.ok(otherKind, 'the scene has an agent of another provider');
    const [claude] = await agents();
    const rows = "[...document.querySelectorAll('#inspector .actions li')].map(li => [...li.children].map(e => e.textContent))";
    await h.clearPosted();
    await h.eval(`Monitor3D.select(${JSON.stringify(otherKind)}, 'scene')`);
    assert.deepEqual(await h.posted(), [{ v: 1, type: 'select', target: { class: 'agent', id: otherKind } }], 'a select, and no thinking message');
    assert.equal((await h.eval(SECTION)).hidden, true, 'no section');
    assert.deepEqual((await h.eval(rows))[1], ['A click selects it', 'The selection stays in this view. Nothing else happens.']);
    // From a Claude Code session's agent to it: one stop, as for a tool.
    await h.eval(`Monitor3D.select(${JSON.stringify(claude)}, 'model')`);
    assert.deepEqual((await h.eval(rows))[1], ['A click selects it', 'This window reads its thinking from the session\'s transcript and shows it under Thinking. Nothing else is done.']);
    await h.clearPosted();
    await h.eval(`Monitor3D.select(${JSON.stringify(otherKind)}, 'model')`);
    assert.deepEqual(await h.posted(), [stop]);
    assert.equal((await h.eval(SECTION)).hidden, true);
    // An answer for it, had one come, shows nothing.
    await h.deliver(recorded(otherKind, [{ at: T1, text: 'Never asked for.' }]));
    assert.equal((await h.eval(SECTION)).hidden, true);
    assert.deepEqual(h.errors, []);
  });

  it('8. at 800 x 600 the open section is on screen, scrolls on its own, leaves the legend and the inspector room, and nothing scrolls sideways', T, async () => {
    await scene({ width: 800, height: 600 });
    const [id] = await agents();
    await h.eval(`Monitor3D.select(${JSON.stringify(id)}, 'model')`);
    const long = 'An invented thought that goes on for a while, with a long unbroken word: ' + 'x'.repeat(300) + '.\nAnd a second line.';
    await h.deliver(recorded(id, Array.from({ length: 40 }, (_, i) => ({ at: T1 + i * 1000, text: i + '. ' + long })), { recorded: 40 }));
    await sleep(300);
    const box = await h.eval(`(() => {
      const rect = s => { const r = document.querySelector(s).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height }; };
      const t = document.getElementById('thinking');
      return { thinking: rect('#thinking'), inspector: rect('#inspector'), legend: rect('#legend'), side: rect('.side'),
        scrolls: t.scrollHeight > t.clientHeight, overflow: getComputedStyle(t).overflowY, sideways: t.scrollWidth > t.clientWidth,
        width: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, height: document.documentElement.scrollHeight };
    })()`);
    assert.ok(box.thinking.top >= 0 && box.thinking.left >= 0 && box.thinking.bottom <= 600 && box.thinking.right <= 800, 'on screen: ' + JSON.stringify(box.thinking));
    assert.ok(box.thinking.height >= 60, 'tall enough to read: ' + box.thinking.height);
    assert.ok(box.thinking.top >= box.inspector.bottom - 0.5 && box.legend.top >= box.thinking.bottom - 0.5, 'between the inspector and the legend');
    assert.ok(box.legend.top < 600 && box.legend.bottom <= box.side.bottom + 0.5, 'the legend stays on the panel: ' + JSON.stringify(box.legend));
    assert.ok(box.inspector.height >= 60, 'the inspector keeps room: ' + box.inspector.height);
    assert.equal(box.scrolls, true, 'a long list scrolls inside the section');
    assert.equal(box.overflow, 'auto');
    assert.equal(box.sideways, false, 'a long word wraps');
    assert.ok(box.width <= box.client && box.width <= 800, 'no horizontal scroll bar: ' + box.width);
    assert.ok(box.height <= 600, 'the page does not scroll: ' + box.height);
    const shots = process.env.WYARDEN_PAGE_SHOTS ? path.resolve(process.env.WYARDEN_PAGE_SHOTS) : '';
    if (shots) { fs.mkdirSync(shots, { recursive: true }); await h.screenshot(path.join(shots, 'thinking-800x600.png')); }

    // A narrow tab (beside an editor): the side panel is under the scene; the section and the inspector share it.
    await scene({ width: 420, height: 720 });
    await h.eval(`Monitor3D.select(${JSON.stringify(id)}, 'model')`);
    await h.deliver(recorded(id, Array.from({ length: 12 }, (_, i) => ({ at: T1 + i * 1000, text: i + '. ' + long })), { recorded: 12 }));
    await sleep(300);
    const narrow = await h.eval(`(() => {
      const r = s => document.querySelector(s).getBoundingClientRect();
      return { thinking: r('#thinking').height, inspector: r('#inspector').height, bottom: r('#thinking').bottom, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);
    assert.ok(narrow.thinking >= 40 && narrow.inspector >= 60 && narrow.bottom <= 720, 'a narrow tab: ' + JSON.stringify(narrow));
    assert.equal(narrow.sideways, false);
    if (shots) await h.screenshot(path.join(shots, 'thinking-420x720.png'));
  });

  it('10. a selection the model clears, by a dropped session or by a snapshot without it, stops once and empties the section', T, async () => {
    const s = await scene();
    const [id, other] = await agents();
    const key = await h.eval(`Monitor3D.model.nodes.get(${JSON.stringify(id)}).owner`);
    await h.eval(`Monitor3D.select(${JSON.stringify(id)}, 'model')`);
    await h.deliver(recorded(id, [{ at: T1, text: CANARY + ' before the drop' }]));
    await h.clearPosted();
    await h.deliver(S.dropRecords(s.scope, key, 'ended'));
    await sleep(400);                                       // the selection follows the model on the next frame
    assert.equal(await h.eval('Monitor3D.state.selected'), '', 'the dropped session\'s agent is no longer selected');
    assert.deepEqual(await h.posted(), [stop], 'one stop');
    let got = await h.eval(SECTION);
    assert.deepEqual([got.hidden, got.items], [true, []]);
    assert.ok(!(await h.eval('document.body.textContent')).includes(CANARY));

    await h.eval(`Monitor3D.select(${JSON.stringify(other)}, 'model')`);
    await h.deliver(recorded(other, [{ at: T2, text: CANARY + ' before the snapshot' }]));
    await h.clearPosted();
    await h.deliver(S.snapshotRecords(s.scope, M.create()));
    await sleep(300);
    assert.equal(await h.eval('Monitor3D.state.selected'), '');
    assert.deepEqual(await h.posted(), [stop], 'a snapshot without it: one stop');
    got = await h.eval(SECTION);
    assert.deepEqual([got.hidden, got.items], [true, []]);
    assert.ok(!(await h.eval('document.body.textContent')).includes(CANARY));
    assert.deepEqual(h.errors, []);
  });

  it('9. a malformed "thinking" message is ignored whole: no error is kept, and the section is unchanged', T, async () => {
    await scene();
    const [id] = await agents();
    await h.eval(`Monitor3D.select(${JSON.stringify(id)}, 'model')`);
    await h.deliver(recorded(id, [{ at: T1, text: 'The invented thought on show.' }]));
    const before = await h.eval("document.getElementById('thinking').outerHTML");
    const ok = recorded(id, [{ at: T2, text: 'Would replace it.' }]);
    const bad = [
      { v: 1, type: 'thinking' },
      { ...ok, id: undefined }, { ...ok, id: 42 }, { ...ok, id: { id } }, { ...ok, id: [id] },
      { ...ok, state: 'bogus' }, { ...ok, state: 'toString' }, { ...ok, state: '__proto__' }, { ...ok, state: null }, { ...ok, state: ['recorded'] },
      { ...ok, thoughts: undefined }, { ...ok, thoughts: null }, { ...ok, thoughts: 'Would replace it.' }, { ...ok, thoughts: { 0: { at: T1, text: 'x' }, length: 1 } },
      { ...ok, thoughts: [null] }, { ...ok, thoughts: [42] }, { ...ok, thoughts: ['Would replace it.'] }, { ...ok, thoughts: [['x']] },
      { ...ok, thoughts: [{ at: T1 }] }, { ...ok, thoughts: [{ at: T1, text: 42 }] }, { ...ok, thoughts: [{ at: T1, text: '' }] }, { ...ok, thoughts: [{ at: T1, text: { text: 'x' } }] },
      { ...ok, thoughts: [{ text: 'no time key' }] }, { ...ok, thoughts: [{ at: '03:04:05', text: 'x' }] }, { ...ok, thoughts: [{ at: 1e300, text: 'x' }] }, { ...ok, thoughts: [{ at: -9e15, text: 'x' }] },
      { ...ok, thoughts: Array.from({ length: 41 }, () => ({ at: T1, text: 'x' })) }, { ...ok, thoughts: [{ at: T1, text: 'y'.repeat(12001) }] },
      { ...ok, recorded: 1e20 }, { ...ok, recorded: 1e308 }, { ...ok, recorded: -1 }, { ...ok, recorded: 1.5 }, { ...ok, recorded: '1' }, { ...ok, recorded: null },
      { ...ok, unrecorded: 2 ** 53 }, { ...ok, more: -0.5 }, { ...ok, more: undefined }, { ...ok, whole: 'yes' }, { ...ok, whole: 1 }, { ...ok, whole: undefined },
      { ...ok, v: 2 }, { ...ok, type: 'Thinking' }, 'thinking', 42, null, [ok]
    ];
    for (const m of bad) await h.deliver(m);
    assert.equal(await h.eval("document.getElementById('thinking').outerHTML"), before, 'the section is unchanged');
    assert.deepEqual(await h.eval('[Monitor3D.feed.lastError, Monitor3D.feed.errors]'), ['', 0], 'no error kept by the feed');
    assert.deepEqual(await h.eval('__m.errors'), []);
    assert.deepEqual(h.errors, [], 'nothing on the console');
    // The harness's own marker after each message is one unknown message: a thinking message adds nothing to `ignored`.
    const ignored = await h.eval('Monitor3D.feed.ignored');
    await h.deliver(ok);
    assert.deepEqual((await h.eval(SECTION)).items, [['03:04:09 UTC', 'Would replace it.']], 'a good message after them is shown');
    assert.equal(await h.eval('Monitor3D.feed.ignored'), ignored + 1, 'a thinking message is handled, not counted as ignored');
  });
});
