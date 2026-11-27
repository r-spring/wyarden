// The live page (media/page.html and its scripts) in a real headless browser: what it posts to the
// host, what it draws and when, the workspace chips, the status line, and that it keeps the
// mock-up's promises (no frame at rest, captions that never overlap, a frame under 8 ms at about
// 200 nodes). docs/monitor-3d/05-working-mockup.md section 8 is the contract under test.
//
// Needs Edge or Chrome (WYARDEN_BROWSER overrides the search). With none, every test is SKIPPED and
// says why; none passes without having run. Screenshots go to WYARDEN_PAGE_SHOTS when it is set,
// else to a temporary folder that is removed afterwards.
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findBrowser, Harness, sleep } = require('./page-harness.js');
const S = require('./fixtures/stream/streams.js');
const M = require('../media/model.js');
const L = require('../media/layout.js');

const browser = findBrowser();
const skip = browser.path ? false : 'NO BROWSER: ' + browser.why + '; the page tests did not run';
if (skip) console.log(skip);
const T = { timeout: 90000, skip };
const K = S.KEYS;
const measured = {};

const text = selector => `(document.querySelector(${JSON.stringify(selector)}) || {}).textContent`;
const visible = selector => `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !!e && !e.hidden && e.getClientRects().length > 0; })()`;
/** A node whose centre is on the canvas, not under an overlay, and that picking finds there. */
const findNode = test => `(() => {
  const v = Monitor3D.view, r = v.canvas.getBoundingClientRect(), m = Monitor3D.model;
  const h = v.hit.find(h => { const n = m.nodes.get(h.id); return n && (${test})(n) && h.x > 4 && h.y > 4 && h.x < v.width - 4 && h.y < v.height - 4 && document.elementFromPoint(r.left + h.x, r.top + h.y) === v.canvas && v.pick(h.x, h.y) === h.id; });
  return h ? { id: h.id, cls: m.nodes.get(h.id).cls, x: r.left + h.x, y: r.top + h.y } : null;
})()`;
const positions = `(() => { const out = {}; for (const h of Monitor3D.view.hit) out[h.id] = [h.x, h.y]; return out; })()`;
const overlapping = `(() => { const b = Monitor3D.view.labels; let n = 0; for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) if (b[i].x < b[j].x + b[j].w && b[j].x < b[i].x + b[i].w && b[i].y < b[j].y + b[j].h && b[j].y < b[i].y + b[i].h) n++; return n; })()`;
const median = list => { const s = list.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
/* What the scene's own canvas fills: every text and every rectangle, recorded on the page's real 2D context. */
const RECORD = `(() => {
  const ctx = Monitor3D.view.ctx;
  window.__drawn = { texts: [], rects: [] };
  if (ctx.__recording) return true;
  ctx.__recording = true;
  const fillText = ctx.fillText, fillRect = ctx.fillRect;
  ctx.fillText = function (text, x, y) { window.__drawn.texts.push({ text: String(text), x, y }); return fillText.apply(this, arguments); };
  ctx.fillRect = function (x, y, w, h) { window.__drawn.rects.push({ x, y, w, h }); return fillRect.apply(this, arguments); };
  return true;
})()`;
const CLEAR = 'window.__drawn.texts.length = 0; window.__drawn.rects.length = 0; true';
/** A point on the canvas where no node is, for the pointer to go to. */
const EMPTY_POINT = `(() => {
  const v = Monitor3D.view, r = v.canvas.getBoundingClientRect();
  for (let y = 20; y < v.height - 20; y += 17) for (let x = 20; x < v.width - 20; x += 23)
    if (!v.pick(x, y) && !v.hit.some(h => Math.hypot(h.x - x, h.y - y) < 40) && document.elementFromPoint(r.left + x, r.top + y) === v.canvas) return { x: r.left + x, y: r.top + y };
  return null;
})()`;
const hexRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('the live page in a headless browser', () => {
  let h;
  before(async () => { if (!skip) h = await Harness.start(browser.path); });
  after(async () => {
    if (h) await h.close();
    if (!skip) console.log('MEASURED ' + JSON.stringify(Object.assign({ browser: path.basename(browser.path) }, measured)));
  });

  it('1. loads with no error and no policy violation, posts one "ready", and waits for the hub', T, async () => {
    await h.open();
    await sleep(300);
    assert.deepEqual(h.errors, []);
    assert.deepEqual(await h.eval('__m.csp'), []);
    assert.deepEqual(await h.eval('__m.errors'), []);
    assert.deepEqual(await h.posted(), [{ v: 1, type: 'ready' }]);
    assert.equal(await h.eval(text('#empty')), 'Waiting for the hub…');
    assert.equal(await h.eval(visible('#empty')), true);
    assert.equal(await h.eval('document.querySelectorAll("script:not([nonce])").length'), 0, 'every script carries the nonce');
    // The template itself: no inline script or style, no style or "on" attribute; every file comes from {{base}}.
    const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'page.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    assert.doesNotMatch(source, /<style|\sstyle\s*=|\son[a-z]+\s*=/i);
    const tags = source.match(/<script\b[^>]*>/g) || [];
    assert.equal(tags.length, 8);
    for (const tag of tags) assert.match(tag, /^<script nonce="\{\{nonce\}\}" src="\{\{base\}\}\/[a-z-]+\.js">$/);
    for (const tag of source.match(/<link\b[^>]*>/g) || []) assert.match(tag, /href="\{\{base\}\}\/[a-z-]+\.css"/);
    assert.ok(source.includes('content="{{csp}}"'));
  });

  it('2. a snapshot of 4 agents is drawn, then 0 frames and 0 animation frames in 3 s at rest', T, async () => {
    await h.open();
    const scene = S.scene({ agents: 4 });
    await h.deliver(scene.message);
    await sleep(800);
    assert.equal(await h.eval('Monitor3D.model.sessions.size'), 4);
    assert.ok(await h.eval('Monitor3D.view.stats.nodes') >= 20, 'nodes are drawn');
    assert.equal(await h.eval(visible('#empty')), false);
    const a = await h.counters(); await sleep(3000); const b = await h.counters();
    measured.atRest = { seconds: 3, frames: b[0] - a[0], animationFrames: b[1] - a[1], strokes: b[2] - a[2] };
    assert.equal(b[0] - a[0], 0, 'frames drawn at rest');
    assert.equal(b[1] - a[1], 0, 'animation frames asked for at rest');
    assert.deepEqual(h.errors, []);
  });

  it('3. one event draws at most 2 frames (an ended call: one more for its trace), and frames stop within 1 s', T, async () => {
    await h.open();
    const scene = S.scene({ agents: 4 });
    await h.deliver(scene.message);
    await sleep(800);
    const agent = [...scene.model.sessions.values()][0];
    const base = { v: 1, agent: 'claude', session: agent.session, grade: 'exact' };
    let t = scene.model.now + 1000, seq = scene.stream.lastSeq();
    const start = { ...base, t, seq: ++seq, ev: 'tool.start', src: 'hook:PreToolUse', call: 'call_page_test_1', tool: 'Read', class: 'read' };
    let a = await h.counters();
    await h.deliver(S.eventRecords(scene.scope, [start]));
    await sleep(1000);
    let b = await h.counters();
    const startFrames = b[0] - a[0];
    await sleep(1000);
    let c = await h.counters();
    assert.ok(startFrames >= 1 && startFrames <= 2, 'frames for a call that starts: ' + startFrames);
    assert.equal(c[0] - b[0], 0, 'no frame in the second after');
    assert.equal(await h.eval('Monitor3D.model.links.has("call_page_test_1")'), true);

    const end = { ...base, t: t + 120, seq: ++seq, ev: 'tool.end', src: 'hook:PostToolUse', call: 'call_page_test_1', tool: 'Read', ok: true, ms: 120, msGrade: 'exact' };
    a = await h.counters();
    await h.deliver(S.eventRecords(scene.scope, [end]));
    await sleep(1200);
    b = await h.counters();
    const endFrames = b[0] - a[0];
    await sleep(1000);
    c = await h.counters();
    assert.ok(endFrames >= 1 && endFrames <= 3, 'frames for a call that ends (2 and its 600 ms trace): ' + endFrames);
    assert.equal(c[0] - b[0], 0, 'no frame in the second after');
    assert.equal(c[1] - b[1], 0, 'no animation frame asked for in the second after');
    measured.perEvent = { callStart: startFrames, callEnd: endFrames };
  });

  it('4. a drop removes that session\'s column and moves nothing else', T, async () => {
    await h.open();
    const scene = S.scene({ agents: 4 });
    await h.deliver(scene.message);
    await sleep(800);
    const gone = [...scene.model.sessions.values()].find(s => s.col === 1);
    const before = await h.eval(positions);
    await h.deliver(S.dropRecords(scene.scope, gone.key, 'ended'));
    await sleep(600);
    const after = await h.eval(positions);
    assert.equal(await h.eval(`Monitor3D.model.sessions.has(${JSON.stringify(gone.key)})`), false);
    assert.equal(await h.eval('Monitor3D.model.columns[1]'), null);
    assert.equal(after[gone.agentId], undefined, 'its agent is no longer drawn');
    assert.equal(Object.keys(after).filter(id => id.includes(gone.key)).length, 0, 'none of its nodes is drawn');
    let compared = 0;
    for (const id of Object.keys(after)) {
      if (!before[id]) continue;
      compared++;
      assert.ok(Math.abs(before[id][0] - after[id][0]) < 0.01 && Math.abs(before[id][1] - after[id][1]) < 0.01, id + ' moved on screen');
    }
    assert.ok(compared >= 15, 'enough nodes were compared: ' + compared);
    assert.equal(await h.eval('Monitor3D.model.sessions.size'), 3);
  });

  it('5. a click posts one "select"; a double-click or Ctrl+Enter posts one "act": "open" on a file, "focus" on an agent', T, async () => {
    await h.open();
    const scene = S.scene({ agents: 4 });
    await h.deliver(scene.message);
    await sleep(800);

    const tool = await h.eval(findNode("n => n.cls === 'tool'"));
    assert.ok(tool, 'a tool to click');
    await h.clearPosted();
    await h.click(tool.x, tool.y);
    await sleep(300);
    assert.deepEqual(await h.posted(), [{ v: 1, type: 'select', target: { class: 'tool', id: tool.id } }]);
    assert.equal(await h.eval('Monitor3D.state.selected'), tool.id);

    const file = await h.eval(findNode("n => n.cls === 'resource' && n.kind === 'file'"));
    assert.ok(file, 'a file resource to double-click');
    await h.clearPosted();
    await h.dblclick(file.x, file.y);
    await sleep(400);
    let posted = await h.posted();
    const acts = posted.filter(m => m.type === 'act');
    assert.deepEqual(acts, [{ v: 1, type: 'act', action: 'open', target: { class: 'resource', id: file.id } }]);
    assert.ok(posted.filter(m => m.type === 'select').length <= 1, 'one select for the two clicks of a double-click');
    assert.equal(posted.filter(m => m.type !== 'act' && m.type !== 'select').length, 0);

    const agent = await h.eval(findNode("n => n.cls === 'agent'"));
    assert.ok(agent, 'an agent to double-click');
    await h.clearPosted();
    await h.dblclick(agent.x, agent.y);
    await sleep(400);
    posted = await h.posted();
    // A session is only shown: one "focus" that names its own agent node.
    const focus = [{ v: 1, type: 'act', action: 'focus', target: { class: 'agent', id: agent.id } }];
    assert.deepEqual(posted.filter(m => m.type === 'act'), focus, 'a double-click on an agent asks to show its session, once');
    assert.ok(posted.filter(m => m.type === 'select').length <= 1, 'one select for the two clicks of a double-click');
    assert.equal(posted.filter(m => m.type !== 'act' && m.type !== 'select').length, 0);

    await h.click(file.x, file.y);
    await sleep(200);
    await h.eval("document.getElementById('scene').focus()");
    await h.clearPosted();
    await h.key('Enter', 'Enter', 13, 2);
    await sleep(200);
    assert.deepEqual(await h.posted(), [{ v: 1, type: 'act', action: 'open', target: { class: 'resource', id: file.id } }]);
    assert.equal(await h.eval('Monitor3D.view.isolated'), null, 'Ctrl+Enter does not isolate');
    const actions = await h.eval("[...document.querySelectorAll('#inspector .actions b')].map(b => b.textContent)");
    assert.ok(actions.includes('Double-click, or Ctrl+Enter: open it in the editor'), actions.join(' | '));

    await h.eval(`Monitor3D.select(${JSON.stringify(agent.id)}, 'model')`);
    await h.eval("document.getElementById('scene').focus()");
    assert.equal(await h.eval('document.activeElement.id'), 'scene', 'the keys go to the scene');
    await h.clearPosted();
    await h.key('Enter', 'Enter', 13, 2);
    await sleep(200);
    assert.deepEqual(await h.posted(), focus, 'Ctrl+Enter on an agent asks to show its session, once');
    assert.equal(await h.eval('Monitor3D.view.isolated'), null, 'Ctrl+Enter on an agent does not isolate its column');
    // Enter alone, on the same agent and the same focus, does isolate it: the line above is not empty.
    await h.key('Enter', 'Enter', 13);
    await sleep(200);
    assert.equal(await h.eval('Monitor3D.view.isolated'), await h.eval(`Monitor3D.model.nodes.get(${JSON.stringify(agent.id)}).col`), 'Enter alone isolates the column');
    assert.deepEqual(await h.posted(), focus, 'and posts nothing');
    assert.deepEqual(h.errors, []);
  });

  it('6. chips: "All open", this window\'s first, a click posts only "scope", aria-pressed follows the hub, focus survives an update', T, async () => {
    await h.open();
    await h.deliver(S.workspaces({ scope: K.shop, here: [K.docs] }));
    const labels = await h.eval("[...document.querySelectorAll('#chips .chip')].map(b => [b.dataset.scope, b.querySelector('.chip-name').textContent, b.getAttribute('aria-pressed')])");
    assert.deepEqual(labels, [['all', 'All open', 'false'], [K.docs, 'site-docs', 'false'], [K.shop, 'demo-shop', 'true'], [K.notes, 'notes-app', 'false']]);
    assert.equal(await h.eval('document.getElementById("chips").getAttribute("role")'), 'toolbar');
    assert.ok(await h.eval('!!document.getElementById("chips").getAttribute("aria-labelledby")'), 'the toolbar has a label');
    assert.match(await h.eval(`document.querySelector('[data-scope="${K.shop}"] .chip-needs').textContent`), /needs you/);
    assert.equal(await h.eval(`document.querySelector('[data-scope="${K.notes}"]').title`), 'notes-app\nOpen in VS Code, VSCodium.');

    const at = await h.eval(`(() => { const r = document.querySelector('[data-scope="${K.notes}"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await h.clearPosted();
    await h.click(at.x, at.y);
    await sleep(200);
    assert.deepEqual(await h.posted(), [{ v: 1, type: 'scope', scope: K.notes }]);
    assert.equal(await h.eval(`document.querySelector('[data-scope="${K.notes}"] .chip-note').textContent`), 'switching…');
    assert.equal(await h.eval(`document.querySelector('[data-scope="${K.shop}"]').getAttribute('aria-pressed')`), 'true', 'nothing changes until the hub answers');

    await h.deliver(S.workspaces({ scope: K.notes, here: [K.docs] }));
    assert.equal(await h.eval(`document.querySelector('[data-scope="${K.notes}"]').getAttribute('aria-pressed')`), 'true');
    assert.equal(await h.eval(`document.querySelector('[data-scope="${K.shop}"]').getAttribute('aria-pressed')`), 'false');
    await h.deliver(S.snapshotRecords(K.notes, M.create()));
    assert.equal(await h.eval(`document.querySelector('[data-scope="${K.notes}"] .chip-note').hidden`), true, '"switching…" ends with the snapshot');

    await h.eval(`(() => { const b = document.querySelector('[data-scope="${K.docs}"]'); b.__mark = 1; b.focus(); })()`);
    await h.deliver(S.workspaces({ scope: K.notes, here: [K.docs] }));
    assert.equal(await h.eval('document.activeElement.__mark === 1 && document.activeElement.dataset.scope'), K.docs, 'an identical message rebuilds nothing');
    await h.deliver(S.workspaces({ scope: K.notes, here: [K.docs], counts: { [K.shop]: 7 } }));
    assert.equal(await h.eval('document.activeElement.__mark === 1 && document.activeElement.dataset.scope'), K.docs, 'a count update rebuilds nothing');
    assert.equal(await h.eval(`document.querySelector('[data-scope="${K.shop}"] .chip-count').textContent`), '7');
    await h.deliver(S.workspaces({ scope: K.notes, here: [K.docs], extra: 1 }));
    assert.equal(await h.eval('document.querySelectorAll("#chips .chip").length'), 5);
    assert.equal(await h.eval('document.activeElement.dataset.scope'), K.docs, 'after a real change the same chip has the focus');
    await h.key('ArrowRight', 'ArrowRight', 39);
    // Order now: All open, site-docs (this window), then by name: a-rather-long-…-1, demo-shop, notes-app.
    assert.equal(await h.eval('document.activeElement.dataset.scope'), K.extra[0], 'Right moves along the toolbar');
    assert.deepEqual(h.errors, []);
  });

  it('7. a snapshot of another scope replaces the scene; a second one of the same scope keeps the camera', T, async () => {
    await h.open();
    const first = S.scene({ agents: 4, seed: 7, scope: K.shop });
    const second = S.scene({ agents: 2, seed: 11, scope: K.notes });
    await h.deliver(first.message);
    await sleep(500);
    assert.deepEqual((await h.eval('[...Monitor3D.model.sessions.keys()]')).sort(), [...first.model.sessions.keys()].sort());
    await h.deliver(second.message);
    await sleep(500);
    const keys = await h.eval('[...Monitor3D.model.sessions.keys()]');
    assert.deepEqual(keys.sort(), [...second.model.sessions.keys()].sort());
    for (const key of first.model.sessions.keys()) assert.ok(!keys.includes(key), 'gone: ' + key);
    assert.equal(await h.eval('Monitor3D.state.scope'), K.notes);
    assert.equal(await h.eval('Monitor3D.view.stats.nodes'), second.model.standing().length);
    await h.eval('Monitor3D.view.orbit(0.3, 0.1)');
    await sleep(200);
    const camera = await h.eval('JSON.stringify(Monitor3D.view.camera)');
    await h.deliver(second.message);
    await sleep(300);
    assert.equal(await h.eval('JSON.stringify(Monitor3D.view.camera)'), camera, 'a re-sent snapshot does not move the camera');
  });

  it('8. nothing live: one sentence that names the workspace, or says "any open workspace"', T, async () => {
    await h.open();
    await h.deliver(S.workspaces({ scope: K.shop }));
    await h.deliver(S.snapshotRecords(K.shop, M.create()));
    await sleep(200);
    assert.equal(await h.eval(text('#empty')), 'No live agent session in demo-shop.');
    assert.equal(await h.eval(visible('#empty')), true);
    await h.deliver(S.snapshotRecords('all', M.create()));
    await sleep(200);
    assert.equal(await h.eval(text('#empty')), 'No live agent session in any open workspace.');
    await h.deliver(S.scene({ agents: 1, ms: 30000, scope: 'all' }).message);
    await sleep(200);
    assert.equal(await h.eval(visible('#empty')), false, 'the sentence goes when a session is live');
  });

  it('9. the status line: hub in this window with no collector; connected with one; port held by another program', T, async () => {
    await h.open();
    assert.equal(await h.eval(text('#status')), 'Hub: starting…');
    const scene = S.scene({ agents: 3, ms: 60000 });
    const sessions = scene.model.sessions.size;
    await h.deliver(S.workspaces({ hidden: 2 }));
    await h.deliver(scene.message);
    await h.deliver(S.hub('up', 'hub', { state: 'missing', folders: 2, installed: 0 }));
    await sleep(200);
    const install = 'Claude Code collector: not installed. Calls are read from transcripts (derived). To install: run “Wyarden 3D Monitor: Set Up Collectors…” from the Command Palette.';
    assert.equal(await h.eval(text('#status')), 'Hub: running in this window. Showing ' + sessions + ' sessions. 2 more are live in folders that are open in no window. ' + install);
    assert.equal(await h.eval(text('#status-live')), 'Hub: running in this window. ' + install, 'announced: hub and collector');
    await h.deliver(S.workspaces({ hidden: 1 }));
    assert.match(await h.eval(text('#status')), /1 more is live in a folder that is open in no window\./);
    assert.equal(await h.eval(text('#status-live')), 'Hub: running in this window. ' + install, 'a count change is not announced');

    await h.deliver(S.hub('up', 'client', { state: 'installed', folders: 3, installed: 3 }));
    await h.deliver(S.workspaces({ hidden: 0 }));
    assert.equal(await h.eval(text('#status')), 'Hub: connected. Showing ' + sessions + ' sessions. Claude Code collector: installed in 3 of 3 account folders (exact calls).');
    assert.equal(await h.eval(text('#status-live')), 'Hub: connected. Claude Code collector: installed in 3 of 3 account folders (exact calls).');

    await h.deliver(S.hub('blocked', 'client', { state: 'installed', folders: 3, installed: 3 }));
    assert.match(await h.eval(text('#status')), /^Hub: another program holds its port\./);
    assert.equal(await h.eval(visible('#status')), true);
  });

  it('10. no editing control anywhere: no input, select, textarea, form or contenteditable', T, async () => {
    await h.open();
    await h.deliver(S.workspaces({}));
    await h.deliver(S.scene({ agents: 4 }).message);
    await h.deliver(S.hub('up', 'hub', { state: 'partly', folders: 2, installed: 1 }));
    await sleep(800);                 // as test 5 waits: in a cold browser the first frame is not drawn after 300 ms
    const agent = await h.eval(findNode("n => n.cls === 'agent'"));
    assert.ok(agent, 'an agent to click');
    await h.click(agent.x, agent.y);
    await sleep(200);
    assert.equal(await h.eval('document.querySelectorAll("input, select, textarea, form, [contenteditable]").length'), 0);
    assert.equal(await h.eval('document.querySelectorAll("#inspector button, #inspector a").length'), 0, 'the inspector has labels, not controls');
    // A session's "In VS Code" section: its heading, its hint, and one label with its text for each thing that is wired or not.
    const wired = await h.eval(`(() => {
      const heads = [...document.querySelectorAll('#inspector h3')].filter(e => e.textContent === 'In VS Code');
      const hint = heads[0] && heads[0].nextElementSibling, list = hint && hint.nextElementSibling;
      if (!list) return { heads: heads.length };
      return {
        heads: heads.length, hint: hint.tagName + '.' + hint.className + ': ' + hint.textContent, list: list.tagName + '.' + list.className,
        rows: [...list.children].map(li => [...li.children].map(e => e.tagName + ': ' + e.textContent)),
        shown: [heads[0], hint, list].every(e => e.getClientRects().length > 0)
      };
    })()`);
    assert.deepEqual(wired, {
      heads: 1, hint: 'P.hint: What is wired now. These are labels, not controls.', list: 'UL.actions',
      rows: [
        ['B: Double-click, or Ctrl+Enter: show its terminal or chat panel', 'SPAN: For a session in a terminal of this window, or in this window\'s Claude Code chat panel. For any other, a message says so and nothing is opened.'],
        ['B: A click selects it', 'SPAN: The selection stays in this view. Nothing else happens.']
      ],
      shown: true
    }, 'a session\'s "In VS Code" section says what is wired now, as text');
    const facts = await h.eval("[...document.querySelectorAll('#inspector .facts dt')].map(d => d.textContent + ': ' + d.nextElementSibling.textContent)");
    assert.ok(facts.some(f => /^Folder: /.test(f)), facts.join(' | '));
    assert.ok(facts.some(f => /^Session id: /.test(f)), facts.join(' | '));
    assert.ok(facts.some(f => /^Calls: (exact, from (Claude Code's|the agent's) hooks|derived, read from the transcript; set up the collector for exact calls)$/.test(f)), facts.join(' | '));
    assert.match(await h.eval(text('#inspector .insp-state')), /\((exact|derived)\)/, 'the grade stays visible');
  });

  it('11. captions: 0 overlapping pairs after a 12-agent snapshot', T, async () => {
    await h.open();
    await h.deliver(S.scene({ agents: 12, ms: 900000 }).message);
    await sleep(600);
    const labels = await h.eval('Monitor3D.view.labels.length');
    assert.ok(labels >= 12, 'captions drawn: ' + labels);
    const pairs = await h.eval(overlapping);
    measured.captions12 = { nodes: await h.eval('Monitor3D.view.stats.nodes'), captions: labels, overlappingPairs: pairs };
    assert.equal(pairs, 0);
  });

  it('12. a frame at about 200 nodes stays inside the plan\'s budget (median; 8 ms at 200 nodes, 16 ms at 500)', T, async () => {
    await h.open();
    await h.deliver(S.scene({ agents: 12, ms: 900000 }).message);
    await sleep(600);
    // Five frames first, not counted: the script engine compiles the drawing code on its first runs, and a cold frame is not a frame at rest.
    const ms = await h.eval(`(() => { const v = Monitor3D.view, out = []; for (let i = 0; i < 5; i++) v.draw(new Set(['input'])); for (let i = 0; i < 41; i++) { v.draw(new Set(['input'])); out.push(v.stats.ms); } return out; })()`);
    const nodes = await h.eval('Monitor3D.view.stats.nodes');
    measured.frame200 = { nodes, frames: ms.length, medianMs: +median(ms).toFixed(2), worstMs: +Math.max(...ms).toFixed(2) };
    assert.ok(nodes >= 180, 'about 200 nodes: ' + nodes);
    // The plan's budget (04 section 8) is 8 ms at 200 nodes and 16 ms at 500. This scene has more than 200 nodes, so it is
    // held to the budget for the number it really draws, on the line between those two points (9.7 ms at 265 nodes).
    const budget = nodes <= 200 ? 8 : 8 + (Math.min(nodes, 500) - 200) * (16 - 8) / 300;
    measured.frame200.budgetMs = +budget.toFixed(2);
    assert.ok(median(ms) < budget, 'median frame ' + median(ms).toFixed(2) + ' ms at ' + nodes + ' nodes, budget ' + budget.toFixed(2) + ' ms');
  });

  it('13. at 800 x 600 with 8 workspaces the chips do not cover the scene, and nothing scrolls sideways', T, async () => {
    await h.open({ width: 800, height: 600 });
    await h.deliver(S.workspaces({ extra: 5 }));
    await h.deliver(S.scene({ agents: 4 }).message);
    await h.deliver(S.hub('up', 'hub', { state: 'missing', folders: 2, installed: 0 }));
    await sleep(400);
    const box = await h.eval(`(() => {
      const rect = e => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
      const bar = document.getElementById('chips');
      // A chip scrolled out of the toolbar is clipped by it: what shows of it is its part inside the toolbar.
      const shown = [...bar.querySelectorAll('.chip')].map(c => { const a = rect(c), b = rect(bar); return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) }; });
      const hit = [...bar.querySelectorAll('.chip')].filter(c => { const r = c.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2; return x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight && c.contains(document.elementFromPoint(x, y)) && y > bar.getBoundingClientRect().bottom; }).length;
      const inner = bar.getBoundingClientRect(), half = [...bar.querySelectorAll('.chip')].filter(c => { const r = c.getBoundingClientRect(); const top = Math.max(r.top, inner.top + bar.clientTop), bottom = Math.min(r.bottom, inner.top + bar.clientTop + bar.clientHeight); return bottom > top + 0.5 && bottom - top < r.height - 0.5; }).length;
      return { canvas: rect(document.getElementById('scene')), toolbar: rect(bar), chips: shown, outsideButOnTop: hit, halfShown: half, scrolls: bar.scrollHeight > bar.clientHeight, overflow: getComputedStyle(bar).overflowY,
        status: rect(document.getElementById('status')), width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight };
    })()`);
    const meets = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    assert.equal(box.chips.length, 9);
    assert.ok(!meets(box.toolbar, box.canvas), 'the toolbar covers the canvas');
    for (const chip of box.chips) assert.ok(chip.bottom <= chip.top || !meets(chip, box.canvas), 'a chip covers the canvas');
    assert.equal(box.outsideButOnTop, 0, 'a chip outside the toolbar is drawn over the page');
    assert.equal(box.halfShown, 0, 'a row of chips shows half cut');
    if (box.scrolls) assert.equal(box.overflow, 'auto', 'the chips that do not fit can be scrolled to');
    assert.ok(box.width <= 800 && box.height <= 600, 'the page scrolls: ' + box.width + ' x ' + box.height);
    assert.ok(box.canvas.bottom - box.canvas.top >= 300, 'the scene keeps its height: ' + (box.canvas.bottom - box.canvas.top));
    assert.ok(box.status.bottom <= 600 && box.status.top >= box.canvas.bottom, 'the status line is under the scene and in view');
    if (process.env.WYARDEN_PAGE_SHOTS) await h.screenshot(path.join(path.resolve(process.env.WYARDEN_PAGE_SHOTS), 'page-800x600.png'));
  });

  it('14. the look follows the host until the owner presses a look button', T, async () => {
    await h.open();
    await h.deliver({ v: 1, type: 'look', look: 'glasshouse' });
    assert.equal(await h.eval('Monitor3D.state.look'), 'glasshouse');
    assert.equal(await h.eval('document.querySelector("[data-look=glasshouse]").getAttribute("aria-pressed")'), 'true');
    await h.deliver({ v: 1, type: 'look', look: 'nexus' });
    assert.equal(await h.eval('Monitor3D.state.look'), 'nexus');
    await h.deliver({ v: 1, type: 'look', look: 'glasshouse' });
    const at = await h.eval(`(() => { const r = document.querySelector('[data-look=nexus]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await h.click(at.x, at.y);
    await sleep(100);
    assert.equal(await h.eval('Monitor3D.state.look'), 'nexus');
    await h.deliver({ v: 1, type: 'look', look: 'glasshouse' });
    assert.equal(await h.eval('Monitor3D.state.look'), 'nexus', 'the owner\'s choice wins');
    await h.deliver({ v: 1, type: 'look', look: 'no-such-look' });
    assert.deepEqual(h.errors, []);
    // A name every object answers to is not a look: it must neither be taken now nor be saved for the next load.
    await h.open();
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) await h.deliver({ v: 1, type: 'look', look: name });
    await sleep(100);
    assert.equal(await h.eval('Monitor3D.state.look'), 'nexus');
    assert.deepEqual(h.errors, []);
    assert.deepEqual(await h.eval('__m.errors'), []);
    await h.open({ state: { v: 1, look: 'constructor', lookChosen: true } });
    await sleep(300);
    assert.equal(await h.eval('Monitor3D.state.look'), 'nexus', 'a saved look of that kind is ignored');
    assert.deepEqual((await h.posted()).filter(m => m.type === 'ready'), [{ v: 1, type: 'ready' }], 'and the page still starts');
  });

  it('15. after a reload with the saved state: the look, the pressed buttons, the camera and the selection come back', T, async () => {
    await h.open();
    const scene = S.scene({ agents: 4 });
    await h.deliver(scene.message);
    await sleep(500);
    for (const selector of ['[data-look=glasshouse]', '#spread']) {
      const at = await h.eval(`(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await h.click(at.x, at.y);
      await sleep(150);
    }
    const tool = await h.eval(findNode("n => n.cls === 'tool'"));
    await h.click(tool.x, tool.y);
    await h.eval('Monitor3D.view.orbit(0.25, 0.05)');
    await sleep(300);
    const states = await h.eval('window.__states');
    assert.ok(states.length > 0, 'the page saved its state');
    const saved = states[states.length - 1];
    assert.equal(saved.look, 'glasshouse');
    assert.equal(saved.spread, true);
    assert.equal(saved.selected, tool.id);

    await h.open({ state: saved });
    assert.equal(await h.eval('Monitor3D.state.look'), 'glasshouse', 'the look before any snapshot');
    await h.deliver({ v: 1, type: 'look', look: 'nexus' });
    await h.deliver(scene.message);
    await sleep(400);
    assert.equal(await h.eval('Monitor3D.state.look'), 'glasshouse', 'the owner\'s look still wins');
    assert.equal(await h.eval('document.querySelector("[data-look=glasshouse]").getAttribute("aria-pressed")'), 'true');
    assert.equal(await h.eval('document.getElementById("spread").getAttribute("aria-pressed")'), 'true');
    assert.equal(await h.eval('Monitor3D.view.spread'), L.SPREAD);
    assert.equal(await h.eval('Monitor3D.state.selected'), tool.id);
    const camera = await h.eval('Monitor3D.view.camera');
    for (const key of ['yaw', 'pitch', 'distance']) assert.ok(Math.abs(camera[key] - saved.camera[key]) < 1e-9, 'camera ' + key);
    assert.deepEqual(h.errors, []);
  });

  it('16. a session that starts lands in view while the camera is the page\'s own; a camera the owner moved is never moved', T, async () => {
    await h.open();
    await h.deliver(S.snapshotRecords(K.shop, M.create(), 0));
    await sleep(400);
    const start = n => ({ v: 1, t: 1795689600000 + n * 1000, agent: 'claude', session: 'follow-000' + n, ws: 'w1', ev: 'session.start', grade: 'exact', src: 'hook:UserPromptSubmit', root: { name: 'folder-' + n }, seq: n });
    const inView = n => `(() => { const v = Monitor3D.view, hit = v.hit.find(x => x.id === 'a:claude:follow-000${n}'); return !!hit && hit.x > 0 && hit.y > 0 && hit.x < v.width && hit.y < v.height; })()`;
    const camera = 'JSON.stringify(Monitor3D.view.camera)';
    await h.deliver(S.eventRecords(K.shop, [start(1)]));
    await sleep(500);
    assert.equal(await h.eval(inView(1)), true, 'the first session of an empty scene is in view');
    await h.deliver(S.eventRecords(K.shop, [start(2), start(3), start(4), start(5)]));
    await sleep(500);
    for (const n of [1, 2, 3, 4, 5]) assert.equal(await h.eval(inView(n)), true, 'session ' + n + ' is in view');
    assert.equal(await h.eval('Monitor3D.view.stats.offscreen'), 0);
    // A session that leaves moves nothing: the camera stays, and so does everything still on screen.
    const framed = await h.eval(camera);
    await h.deliver(S.dropRecords(K.shop, 'claude:follow-0003', 'ended'));
    await sleep(400);
    assert.equal(await h.eval(camera), framed, 'a drop does not move the camera');
    // The owner zooms in: from now on the camera is theirs.
    await h.eval('(Monitor3D.view.zoom(0.5), 1)');
    await sleep(300);
    const theirs = await h.eval(camera);
    assert.notEqual(theirs, framed);
    await h.deliver(S.eventRecords(K.shop, [start(6), start(7)]));
    await sleep(500);
    assert.equal(await h.eval('Monitor3D.model.sessions.size'), 6);
    assert.equal(await h.eval(camera), theirs, 'a camera the owner moved stays where it is');
    // "Frame all" hands it back to the page.
    await h.eval('(document.getElementById("frame").click(), 1)');
    await sleep(300);
    await h.deliver(S.eventRecords(K.shop, [start(8), start(9)]));
    await sleep(500);
    for (const n of [1, 2, 4, 5, 6, 7, 8, 9]) assert.equal(await h.eval(inView(n)), true, 'after Frame all, session ' + n + ' is in view');
  });

  it('17. in a narrow tab (beside an editor) the scene keeps the width, the inspector goes under it, and nothing scrolls sideways', T, async () => {
    await h.open({ width: 420, height: 720 });
    await h.deliver(S.workspaces());
    await h.deliver(S.scene({ agents: 4 }).message);
    await sleep(700);
    const box = selector => `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`;
    const scene = await h.eval(box('#scene')), side = await h.eval(box('.side'));
    assert.ok(scene.w >= 400, 'the scene is ' + scene.w + ' px wide');
    assert.ok(scene.h >= 300, 'the scene is ' + scene.h + ' px tall');
    assert.ok(side.y >= scene.y + scene.h - 1, 'the inspector is under the scene, not beside it');
    assert.equal(await h.eval(visible('#legend')), false, 'the legend waits for a wider tab');
    assert.equal(await h.eval(visible('#inspector')), true);
    assert.equal(await h.eval('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, 'nothing scrolls sideways');
    assert.equal(await h.eval('Monitor3D.view.stats.offscreen'), 0, 'every session is still in view');
    const node = await h.eval(findNode('n => n.cls === "agent"'));
    assert.ok(node, 'an agent can be clicked');
    await h.click(node.x, node.y);
    await sleep(150);
    assert.equal(await h.eval('Monitor3D.state.selected'), node.id);
    assert.deepEqual(h.errors, []);
  });

  it('18. a chip per editor window (0.1.1): totals, hover text, own window first; the 0.1.0 shape still works', T, async () => {
    await h.open();
    const chip = key => `document.querySelector('[data-scope="${key}"]')`;
    const allCount = () => h.eval(`${chip('all')}.querySelector('.chip-count').textContent`);
    const allNeeds = () => h.eval(`(() => { const n = ${chip('all')}.querySelector('.chip-needs'); return n.hidden ? '' : n.textContent; })()`);
    const order = () => h.eval("[...document.querySelectorAll('#chips .chip')].map(b => b.dataset.scope)");

    // The 0.1.0 shape: no new field, so "All open" sums the list.
    await h.deliver(S.workspaces({ here: [K.docs] }));
    assert.equal(await allCount(), '6');
    assert.equal(await allNeeds(), '▲ needs you');
    assert.equal(await h.eval(`${chip(K.notes)}.title`), 'notes-app\nOpen in VS Code, VSCodium.');
    assert.equal(await h.eval('document.getElementById("chips").getAttribute("aria-labelledby")'), 'scopes-name');
    assert.equal(await h.eval('document.getElementById("scopes-name").textContent'), 'Workspace: one for each open editor window');
    assert.equal(await h.eval('document.getElementById("scopes-name").firstChild.nodeValue'), 'Workspace', 'the visible label stays "Workspace"');
    assert.ok(await h.eval('(() => { const r = document.querySelector("#scopes-name .sr-only").getBoundingClientRect(); return r.width <= 1 && r.height <= 1; })()'), 'the rest is for screen readers only');

    // The 0.1.1 shape: the hub's totals win, also a real 0; the hover text names the folders when they say more.
    await h.deliver(S.workspaces({ here: [K.docs], v011: true, total: 5, totalNeeds: 2 }));
    assert.equal(await allCount(), '5', 'total, not the sum 6');
    assert.equal(await allNeeds(), '▲ 2 need you');
    await h.deliver(S.workspaces({ here: [K.docs], v011: true, total: 0, totalNeeds: 0 }));
    assert.equal(await allCount(), '0');
    assert.equal(await allNeeds(), '', 'no mark when totalNeeds is 0');
    assert.equal(await h.eval(`${chip(K.notes)}.title`), 'notes-app\nFolders: notes-app, notes-api.\nOpen in VS Code, VSCodium.');
    assert.equal(await h.eval(`${chip(K.shop)}.title`), 'demo-shop\nOpen in VS Code.', 'one folder with the workspace\'s own name is not repeated');
    assert.equal(await h.eval(`${chip(K.docs)}.title`), 'site-docs\nFolders: docs-site.\nOpen in VS Code (this window).');
    assert.equal(await h.eval(`${chip('all')}.title`), 'Every open editor window, each session counted once');

    // `own` alone puts this window's chip first.
    await h.deliver(S.workspaces({ here: [], own: K.notes, v011: true, total: 5, totalNeeds: 1 }));
    assert.deepEqual(await order(), ['all', K.notes, K.shop, K.docs], 'All open, this window (notes-app), then by name: demo-shop, site-docs');
    assert.match(await h.eval(`${chip(K.notes)}.title`), /\(this window\)\.$/);
    // When `own` is present it alone decides: a key also in `here` (this window's folder, for a 0.1.0 hub) is not this window's.
    await h.deliver(S.workspaces({ here: [K.docs], own: K.notes, v011: true, total: 5, totalNeeds: 1 }));
    assert.deepEqual(await order(), ['all', K.notes, K.shop, K.docs], '`own` wins over `here`');
    assert.doesNotMatch(await h.eval(`${chip(K.docs)}.title`), /this window/);

    // A message that differs only in `watching`, or only in the hover text, rebuilds nothing and keeps the focus.
    await h.eval(`(() => { const b = ${chip(K.shop)}; b.__mark = 1; b.focus(); })()`);
    await h.deliver(S.workspaces({ here: [], own: K.notes, v011: true, total: 5, totalNeeds: 1, watching: false }));
    assert.equal(await h.eval('document.activeElement.__mark === 1 && document.activeElement.dataset.scope'), K.shop, 'only `watching` changed');
    const other = S.workspaces({ here: [], own: K.notes, v011: true, total: 6, totalNeeds: 1, watching: false });
    other.list.find(w => w.key === K.shop).folders = ['demo-shop', 'demo-shop-api'];
    await h.deliver(other);
    assert.equal(await h.eval('document.activeElement.__mark === 1 && document.activeElement.dataset.scope'), K.shop, 'only folders and total changed');
    assert.equal(await h.eval(`${chip(K.shop)}.title`), 'demo-shop\nFolders: demo-shop, demo-shop-api.\nOpen in VS Code.');
    assert.equal(await allCount(), '6');

    // A page meeting an older hub again (a window reloaded first): back to the sums, still no error.
    await h.deliver(S.workspaces({ here: [K.docs] }));
    assert.equal(await allCount(), '6');
    assert.deepEqual(await order(), ['all', K.docs, K.shop, K.notes]);
    assert.deepEqual(h.errors, []);
  });

  it('19. a caption has no plate behind it: the only filled rectangle bigger than a write mark is the whole scene\'s background', T, async () => {
    await h.open();
    await h.deliver(S.scene({ agents: 4 }).message);
    await sleep(700);
    await h.eval(RECORD);
    await h.eval(CLEAR + '; Monitor3D.view.redraw.request("input")');
    await sleep(250);
    const { rects } = await h.eval('window.__drawn');
    const size = await h.eval('[Monitor3D.view.width, Monitor3D.view.height]');
    const labels = await h.eval('Monitor3D.view.labels.length');
    assert.ok(labels >= 4, 'captions were drawn: ' + labels);
    const big = rects.filter(r => r.w > 6 || r.h > 6);
    assert.deepEqual(big, [{ x: 0, y: 0, w: size[0], h: size[1] }], 'one big rectangle: the background');
    // The engine also fills a 5.2 px square under a resource that was written (its "write" mark); none is a plate.
    const plates = await h.eval(`(() => { const r = window.__drawn.rects; return Monitor3D.view.labels.filter(b => r.some(q => q.x <= b.x + 1 && q.y <= b.y + 1 && q.x + q.w >= b.x + b.w - 1 && q.y + q.h >= b.y + b.h - 1 && q.w < Monitor3D.view.width)).length; })()`);
    assert.equal(plates, 0, 'no rectangle covers a caption');
    measured.captionRects = { background: 1, writeMarks: rects.length - 1 };
  });

  it('20. an agent\'s tab title shows directly under its name only while the real pointer is on it', T, async () => {
    await h.open();
    await h.deliver(S.scene({ agents: 4 }).message);
    await sleep(700);
    await h.eval(RECORD);
    await h.eval(CLEAR + '; Monitor3D.view.redraw.request("input")');
    await sleep(250);
    let texts = (await h.eval('window.__drawn.texts')).map(t => t.text);
    for (const title of S.TITLES) assert.ok(!texts.some(t => t.startsWith(title.slice(0, 12))), 'at rest no title is drawn: ' + title);

    const agent = await h.eval(findNode("n => n.cls === 'agent' && !!n.title"));
    assert.ok(agent, 'an agent with a title to point at');
    const title = await h.eval(`Monitor3D.model.nodes.get(${JSON.stringify(agent.id)}).title`);
    let a = await h.counters();
    await h.eval(CLEAR);
    await h.mouse('mouseMoved', agent.x, agent.y);
    await sleep(400);
    let b = await h.counters();
    const drawn = await h.eval('window.__drawn.texts');
    const shown = drawn.filter(t => t.text === title);
    assert.ok(shown.length > 0, 'pointed at: the title "' + title + '" is drawn');
    const box = await h.eval(`Monitor3D.view.labels.find(l => l.id === ${JSON.stringify(agent.id)})`);
    assert.equal(box.title, title);
    const t = shown[shown.length - 1];
    // Positions are sums of fractions of a pixel, so "the same x, 12 px lower" is compared within a hundredth of a pixel.
    assert.ok(drawn.some(n => n.text === box.lines[0] && Math.abs(n.x - t.x) < .01 && Math.abs(n.y - (t.y - 12)) < .01), 'directly under the agent\'s name, ' + box.lines[0]);
    assert.ok(b[0] - a[0] >= 1 && b[0] - a[0] <= 2, 'frames for pointing at it: ' + (b[0] - a[0]));
    assert.equal(await h.eval(overlapping), 0, 'the title clears the other captions');

    const away = await h.eval(EMPTY_POINT);
    assert.ok(away, 'an empty point on the canvas');
    await h.eval(CLEAR);
    a = await h.counters();
    await h.mouse('mouseMoved', away.x, away.y);
    await sleep(400);
    b = await h.counters();
    texts = (await h.eval('window.__drawn.texts')).map(x => x.text);
    assert.ok(!texts.includes(title), 'the pointer left: the title is gone');
    assert.ok(b[0] - a[0] >= 1 && b[0] - a[0] <= 2, 'frames for leaving it: ' + (b[0] - a[0]));
    await sleep(1000);
    const c = await h.counters();
    assert.equal(c[0] - b[0], 0, 'and then frames stop');
    assert.equal(c[1] - b[1], 0);
    measured.titleOnPointer = { framesOn: b[0] - a[0] };
  });

  it('21. an agent\'s caption is its provider\'s name, the folder\'s code is not drawn, and two providers have two colours', T, async () => {
    await h.open();
    const scene = S.scene({ agents: 4 });
    await h.deliver(scene.message);
    await sleep(700);
    await h.eval(RECORD);
    await h.eval(CLEAR + '; Monitor3D.view.redraw.request("input")');
    await sleep(250);
    const texts = (await h.eval('window.__drawn.texts')).map(t => t.text);
    const agents = await h.eval(`Monitor3D.view.labels.filter(l => Monitor3D.model.nodes.get(l.id).cls === 'agent').map(l => [Monitor3D.model.nodes.get(l.id).kind, l.lines[0]])`);
    assert.ok(agents.length >= 2, 'agent captions: ' + agents.length);
    for (const [kind, name] of agents) assert.equal(name, { claude: 'CLAUDE', codex: 'CODEX' }[kind], kind);
    assert.ok(texts.includes('CLAUDE') && texts.includes('CODEX'), 'both providers are named');
    for (const code of S.FOLDERS) assert.ok(!texts.some(t => t.toLowerCase().includes(code)), 'the folder code ' + code + ' is not drawn');
    // The two providers' colours, as the look gives them, are on the canvas around each agent.
    const found = await h.eval(`(() => {
      const v = Monitor3D.view, m = Monitor3D.model, out = {};
      const ctx = v.canvas.getContext('2d'), ratio = v.ratio;
      for (const hit of v.hit) {
        const n = m.nodes.get(hit.id);
        if (!n || n.cls !== 'agent') continue;
        const color = v.colorOf(n), want = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
        const data = ctx.getImageData(Math.round((hit.x - 20) * ratio), Math.round((hit.y - 20) * ratio), Math.round(40 * ratio), Math.round(40 * ratio)).data;
        let best = 999;
        for (let i = 0; i < data.length; i += 4) best = Math.min(best, Math.hypot(data[i] - want[0], data[i + 1] - want[1], data[i + 2] - want[2]));
        out[n.kind] = Math.min(out[n.kind] === undefined ? 999 : out[n.kind], best);
      }
      return { near: out, claude: v.look.palette.provider.claude, codex: v.look.palette.provider.codex };
    })()`);
    assert.notEqual(found.claude, found.codex);
    for (const kind of ['claude', 'codex']) assert.ok(found.near[kind] < 40, kind + '\'s colour is drawn at its agent: ' + JSON.stringify(found.near));
  });

  it('22. the legend: Agent and Subagent in a neutral colour, and the four providers with live counts', T, async () => {
    await h.open();
    const scene = S.scene({ agents: 4 });
    await h.deliver(scene.message);
    await sleep(500);
    for (const look of ['nexus', 'glasshouse']) {
      await h.deliver({ v: 1, type: 'look', look });
      await sleep(150);
      const legend = await h.eval(`(() => {
        const heads = [...document.querySelectorAll('#legend-body h3')], at = heads.findIndex(x => /^Providers/.test(x.textContent));
        const grid = heads[at] && heads[at].nextElementSibling;
        const rows = grid ? [...grid.querySelectorAll('.legend-item')].map(r => r.textContent.trim()) : [];
        const agent = document.querySelector('#legend-body .legend-item canvas'), ctx = agent.getContext('2d'), d = ctx.getImageData(0, 0, agent.width, agent.height).data;
        let best = -1, rgb = null;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > best) { best = d[i + 3]; rgb = [d[i], d[i + 1], d[i + 2]]; }
        return { head: heads[at] ? heads[at].textContent : '', rows, firstClass: agent.parentElement.textContent.trim(), color: agent.dataset.color, rgb, providers: Monitor3D.view.look.palette.provider, muted: Monitor3D.view.look.palette.muted };
      })()`);
      assert.equal(legend.head, 'Providers (the colour of an agent and its subagents)');
      const counts = { claude: 0, codex: 0, grok: 0, antigravity: 0 };
      for (const n of scene.model.nodes.values()) if (n.cls === 'agent') counts[n.kind]++;
      assert.deepEqual(legend.rows, ['Claude (' + counts.claude + ')', 'Codex (' + counts.codex + ')', 'Grok (0)', 'Antigravity (0)'], look);
      assert.match(legend.firstClass, /^Agent \(4\)$/);
      assert.equal(legend.color, legend.muted, look + ': the Agent entry is drawn in the look\'s muted colour');
      for (const c of Object.values(legend.providers)) assert.ok(distance(legend.rgb, hexRgb(c)) > distance(legend.rgb, hexRgb(legend.muted)), look + ': the Agent swatch is nearer muted than ' + c);
    }
  });

  it('23. each agent\'s tile is labelled with its workspace, clear of every caption; with no workspace named the floor says AGENTS', T, async () => {
    await h.open();
    const scene = S.scene({ agents: 4 });
    await h.deliver(scene.message);
    await sleep(700);
    const expected = [...scene.model.sessions.values()].map(s => scene.model.nodes.get(s.agentId).space);
    for (const look of ['nexus', 'glasshouse']) {
      await h.deliver({ v: 1, type: 'look', look });
      await sleep(300);
      const tiles = await h.eval('Monitor3D.view.tileLabels');
      assert.deepEqual(tiles.map(t => t.text).sort(), expected.map(s => (look === 'nexus' ? s.toUpperCase() : s)).sort(), look);
      const clash = await h.eval(`(() => {
        const t = Monitor3D.view.tileLabels, c = Monitor3D.view.labels, meets = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        let n = 0; for (let i = 0; i < t.length; i++) { for (let j = i + 1; j < t.length; j++) if (meets(t[i], t[j])) n++; for (const b of c) if (meets(t[i], b)) n++; } return n;
      })()`);
      assert.equal(clash, 0, look + ': a tile label meets another or a caption');
    }
    await h.open();
    await h.deliver(S.scene({ agents: 4, named: false }).message);
    await sleep(700);
    await h.eval(RECORD);
    await h.eval(CLEAR + '; Monitor3D.view.redraw.request("input")');
    await sleep(250);
    assert.deepEqual(await h.eval('Monitor3D.view.tileLabels'), []);
    assert.ok((await h.eval('window.__drawn.texts')).some(t => t.text === 'AGENTS'), 'the floor keeps its title');
  });

  it('24. session.info: a new tab title reaches the inspector and the list; a new workspace name relabels the tile and the column', T, async () => {
    await h.open();
    const scene = S.scene({ agents: 4 });
    await h.deliver(scene.message);
    await sleep(600);
    const s = [...scene.model.sessions.values()][0], agent = scene.model.nodes.get(s.agentId);
    await h.eval(`Monitor3D.select(${JSON.stringify(agent.id)}, 'model')`);
    const facts = () => h.eval("Object.fromEntries([...document.querySelectorAll('#inspector .facts dt')].map(d => [d.textContent, d.nextElementSibling.textContent]))");
    let f = await facts();
    assert.equal(f['Tab title'], agent.title);
    assert.equal(f.Workspace, agent.space);
    assert.equal(f.Provider, 'Claude');
    assert.equal(await h.eval(text('#inspector h2')), 'Claude ' + agent.root);
    const row = () => h.eval(`(() => { const r = document.querySelector('#twin .twin-row[data-node=${JSON.stringify(agent.id)}]'); return r ? r.textContent : ''; })()`);
    assert.match(await row(), new RegExp('^Agent: Claude, “' + agent.title + '”, in ' + agent.space + ', '));

    const info = { v: 1, t: scene.model.now + 1000, seq: scene.stream.lastSeq() + 1, agent: 'claude', session: s.session, ev: 'session.info', grade: 'derived', src: 'sessions-file', title: 'Ship the new invoice page', space: 'Billing Desk' };
    await h.deliver(S.eventRecords(scene.scope, [info]));
    await sleep(500);
    f = await facts();
    assert.equal(f['Tab title'], 'Ship the new invoice page');
    assert.equal(f.Workspace, 'Billing Desk');
    assert.match(await row(), /^Agent: Claude, “Ship the new invoice page”, in Billing Desk, /);
    assert.ok((await h.eval('[...document.querySelectorAll("#twin .twin-title")].map(t => t.textContent)')).includes('Column ' + (s.col + 1) + ': Claude in Billing Desk'), 'the column names its new workspace');
    assert.ok((await h.eval('Monitor3D.view.tileLabels.map(t => t.text)')).includes('BILLING DESK'), 'the tile is relabelled');
    assert.deepEqual(h.errors, []);
  });

  it('25. a subagent shows its own session; the list\'s double-click and Ctrl+Enter do as the scene\'s; a tool asks for nothing; the help says so', T, async () => {
    await h.open();
    const scene = S.scene({ agents: 4 });
    await h.deliver(scene.message);
    await sleep(700);
    const focus = id => [{ v: 1, type: 'act', action: 'focus', target: { class: 'agent', id } }];
    const sessionAgent = id => scene.model.sessions.get(scene.model.nodes.get(id).owner).agentId;
    const keysTo = async id => { await h.eval(`document.getElementById(${JSON.stringify(id)}).focus()`); assert.equal(await h.eval('document.activeElement.id'), id, 'the keys go to #' + id); };
    const actionRows = "[...document.querySelectorAll('#inspector .actions li')].map(li => [...li.children].map(e => e.textContent))";

    // A subagent asks to show the session that started it, named by that session's agent node (the host knows no subagent).
    const sub = [...scene.model.nodes.values()].find(n => n.cls === 'subagent' && !n.folded);
    assert.ok(sub, 'the scene has a standing subagent');
    const owner = sessionAgent(sub.id);
    assert.notEqual(owner, sub.id);
    assert.equal(await h.eval(`Monitor3D.model.nodes.has(${JSON.stringify(sub.id)})`), true);
    await h.eval(`Monitor3D.select(${JSON.stringify(sub.id)}, 'model')`);
    await keysTo('scene');
    await h.clearPosted();
    await h.key('Enter', 'Enter', 13, 2);
    await sleep(200);
    assert.deepEqual(await h.posted(), focus(owner), 'Ctrl+Enter on a subagent asks to show its session, once');
    assert.equal(await h.eval('Monitor3D.view.isolated'), null, 'Ctrl+Enter does not isolate');
    assert.deepEqual(await h.eval(actionRows), [
      ['Double-click, or Ctrl+Enter: show its session', 'The terminal or chat panel of the session that started it, as for an agent.'],
      ['A click selects it', 'The selection stays in this view. Nothing else happens.']
    ], 'a subagent\'s "In VS Code" labels, the wired one first');

    const picked = await h.eval(findNode("n => n.cls === 'subagent'"));
    assert.ok(picked, 'a subagent to double-click');
    await h.clearPosted();
    await h.dblclick(picked.x, picked.y);
    await sleep(400);
    let posted = await h.posted();
    assert.deepEqual(posted.filter(m => m.type === 'act'), focus(sessionAgent(picked.id)), 'a double-click on a subagent asks to show its session, once');
    assert.ok(posted.filter(m => m.type === 'select').length <= 1, 'one select for the two clicks of a double-click');
    assert.equal(posted.filter(m => m.type !== 'act' && m.type !== 'select').length, 0);

    // What the page posts comes from nav.act. A subagent whose session, or whose session's agent node, is not in the model asks for nothing.
    assert.deepEqual(await h.eval(`(() => {
      const N = MonitorNav, m = Monitor3D.model, sub = m.nodes.get(${JSON.stringify(sub.id)});
      return [
        N.act(sub, m),
        N.act(Object.assign({}, sub, { owner: 'claude:no-such-session' }), m),
        N.act(sub, { sessions: new Map([[sub.owner, { agentId: 'a:claude:no-such-agent' }]]), nodes: new Map() }),
        N.act(sub, null),
        N.act(undefined, m)
      ];
    })()`), [{ action: 'focus', class: 'agent', id: owner }, null, null, null, null]);

    // The list: a double-click on an agent's row, then Ctrl+Enter with the focus on the list.
    const agentId = [...scene.model.sessions.values()][0].agentId;
    const row = await h.eval(`(() => {
      const r = document.querySelector('#twin .twin-row[data-node=${JSON.stringify(agentId)}]');
      if (!r) return null;
      r.scrollIntoView({ block: 'center' });        // not 'nearest': a group's title sticks to the top of the list and can cover the row
      const b = r.getBoundingClientRect(), x = b.left + Math.min(40, b.width / 2), y = b.top + b.height / 2, at = document.elementFromPoint(x, y);
      return at && at.closest('.twin-row') === r ? { x, y } : null;
    })()`);
    assert.ok(row, 'the agent\'s row can be pointed at');
    await h.clearPosted();
    await h.dblclick(row.x, row.y);
    await sleep(400);
    posted = await h.posted();
    assert.deepEqual(posted.filter(m => m.type === 'act'), focus(agentId), 'a double-click on an agent\'s row asks to show its session, once');
    assert.deepEqual(posted.filter(m => m.type === 'select'), [{ v: 1, type: 'select', target: { class: 'agent', id: agentId } }]);
    assert.equal(posted.length, 2);
    await h.eval(`Monitor3D.select(${JSON.stringify(sub.id)}, 'model')`);
    await keysTo('twin');
    await h.clearPosted();
    await h.key('Enter', 'Enter', 13, 2);
    await sleep(200);
    assert.deepEqual(await h.posted(), focus(owner), 'Ctrl+Enter in the list on a subagent asks to show its session, once');

    // A tool: a double-click selects it, and neither it nor Ctrl+Enter asks the host for anything.
    const tool = await h.eval(findNode("n => n.cls === 'tool'"));
    assert.ok(tool, 'a tool to double-click');
    await h.clearPosted();
    await h.dblclick(tool.x, tool.y);
    await sleep(400);
    assert.deepEqual(await h.posted(), [{ v: 1, type: 'select', target: { class: 'tool', id: tool.id } }], 'a double-click on a tool asks for nothing');
    await keysTo('scene');
    await h.clearPosted();
    await h.key('Enter', 'Enter', 13, 2);
    await sleep(200);
    assert.deepEqual(await h.posted(), [], 'Ctrl+Enter on a tool asks for nothing');

    // The help for the list and for the scene says what Ctrl+Enter does now.
    assert.equal(await h.eval(text('#twin-help')), 'The scene as text. Up and Down move the selection; Ctrl+Enter opens a file or address, or shows a session.');
    assert.equal(await h.eval(text('#scene-help')), 'Arrow keys move the selection: Left and Right along a floor, Up and Down between floors. Page Up and Page Down step through everything, Home and End jump to the ends, Escape clears the selection, Enter shows the selected agent\'s column alone, Ctrl+Enter opens the selected file or address, or shows the selected session. Shift with an arrow key turns the camera, plus and minus zoom, F frames everything, R resets the camera. The list next to the scene holds the same items as text.');
    assert.deepEqual(h.errors, []);
  });

  it('screenshots of both looks at 1280 x 720, with 4 agents and three workspace chips', T, async () => {
    const wanted = process.env.WYARDEN_PAGE_SHOTS, dir = wanted ? path.resolve(wanted) : fs.mkdtempSync(path.join(os.tmpdir(), 'wym-shots-'));
    fs.mkdirSync(dir, { recursive: true });
    try {
      const files = [];
      for (const look of ['nexus', 'glasshouse']) {
        await h.open({ width: 1280, height: 720 });
        await h.deliver({ v: 1, type: 'look', look });
        await h.deliver(S.hub('up', 'hub', { state: 'missing', folders: 2, installed: 0 }));
        await h.deliver(S.workspaces({ scope: K.shop, here: [K.shop], hidden: 1 }));
        await h.deliver(S.scene({ agents: 4 }).message);
        await sleep(500);
        await h.eval("(() => { const all = [...Monitor3D.model.nodes.values()]; const n = all.find(n => n.cls === 'agent' && n.status === 'needs') || all.find(n => n.cls === 'agent' && n.open) || all.find(n => n.cls === 'agent'); Monitor3D.select(n.id, 'model'); })()");
        await sleep(400);
        assert.ok(await h.eval("Monitor3D.view.hit.some(x => Monitor3D.model.nodes.get(x.id).cls === 'subagent')"), 'a subagent is on screen');
        assert.ok(await h.eval("new Set(Monitor3D.view.hit.map(x => Monitor3D.model.nodes.get(x.id)).filter(n => n.cls === 'agent').map(n => n.kind)).size >= 2"), 'two providers are on screen');
        files.push(await h.screenshot(path.join(dir, 'page-' + look + '.png')));
        // The same scene with the real pointer on an agent that is not selected, so its tab's title shows.
        const agent = await h.eval(findNode("n => n.cls === 'agent' && !!n.title && n.id !== Monitor3D.state.selected"));
        await h.mouse('mouseMoved', agent.x, agent.y);
        await sleep(400);
        assert.ok(await h.eval(`Monitor3D.view.labels.some(l => l.id === ${JSON.stringify(agent.id)} && l.title)`), 'the title is shown');
        files.push(await h.screenshot(path.join(dir, 'page-' + look + '-pointer.png')));
        await h.mouse('mouseMoved', 1, 1);
      }
      for (const file of files) assert.ok(fs.statSync(file).size > 20000, file + ' is a real picture');
      measured.screenshots = wanted ? files : 'taken and removed (set WYARDEN_PAGE_SHOTS to keep them)';
      assert.deepEqual(h.errors, []);
    } finally {
      if (!wanted) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
