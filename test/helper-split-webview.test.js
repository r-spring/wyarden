// The real media/board.js and board.css in headless Edge/Chrome: Title: Haiku and Done When: Fable are split buttons whose ▾ opens a menu of
// the Claude model and effort that helper runs on (the user, 13 November 2026, F53 and F54).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

test("webview: the title and Done when toggles are split buttons whose drop-down picks the model and effort, names it and sends it with Add task", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview check was not run."); return; }
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-split-webview-"));
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`The browser could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading in the harness");
    await page.evaluate(`window.__host(${JSON.stringify({ tasks: [], live: [], own: [], accounts: ["acct", "cx"], codex: { accounts: ["cx"], models: [], short: [] } })}); true`);

    const read = (id) => page.evaluate(`(() => { const box = document.getElementById(${JSON.stringify(id)}), wrap = box.closest('.split'), arrow = wrap.querySelector('.split-arrow'), menu = wrap.querySelector('[role=menu]');
      return { text: box.closest('.toggle').textContent.trim(), checked: box.checked, open: !menu.hidden, expanded: arrow.getAttribute('aria-expanded'), popup: arrow.getAttribute('aria-haspopup'),
        label: arrow.getAttribute('aria-label'), arrow: arrow.textContent, disabled: arrow.disabled, title: arrow.title, focused: document.activeElement === arrow,
        picked: [...menu.querySelectorAll('[role=menuitemradio][aria-checked=true]')].map((b) => b.textContent),
        items: [...menu.querySelectorAll('button')].map((b) => b.getAttribute('role') + ':' + b.textContent) }; })()`);
    const arrow = (id) => page.evaluate(`document.getElementById(${JSON.stringify(id)}).closest('.split').querySelector('.split-arrow').click(); true`);
    const pick = (id, text) => page.evaluate(`[...document.getElementById(${JSON.stringify(id)}).closest('.split').querySelectorAll('[role=menuitemradio]')].find((b) => b.textContent === ${JSON.stringify(text)}).click(); true`);

    // Defaults: the labels are exactly as before, and ▾ is a menu button with its own name.
    let title = await read("autoTitle"), rule = await read("autoRule");
    assert.equal(title.text, "Title: Haiku");
    assert.equal(rule.text, "Done When: Fable");
    assert.deepEqual([title.arrow, title.popup, title.expanded, title.label, title.open], ["▾", "menu", "false", "Model and effort for titles", false]);
    assert.equal(rule.label, "Model and effort for Done when");
    assert.deepEqual(title.items, ["menuitemradio:Haiku", "menuitemradio:Opus", "menuitemradio:Fable", ...["low", "medium", "high", "xhigh", "max"].map((e) => `menuitemradio:${e}`)], "no Sonnet");
    assert.deepEqual([title.picked, rule.picked], [["Haiku", "low"], ["Fable", "high"]]);

    // A click on the toggle part switches it and opens nothing.
    await page.evaluate(`document.getElementById('autoTitle').closest('.toggle').click(); true`);
    title = await read("autoTitle");
    assert.deepEqual([title.checked, title.open], [false, false]);
    await page.evaluate(`document.getElementById('autoTitle').closest('.toggle').click(); true`);
    assert.equal((await read("autoTitle")).checked, true);

    // ▾ opens the menu; Opus then high applies at once, the menu stays open and the label names the pick.
    await arrow("autoTitle");
    assert.deepEqual([(await read("autoTitle")).open, (await read("autoTitle")).expanded], [true, "true"]);
    await pick("autoTitle", "Opus");
    assert.equal((await read("autoTitle")).text, "Title: Opus");
    await pick("autoTitle", "high");
    title = await read("autoTitle");
    assert.deepEqual([title.text, title.open, title.picked], ["Title: Opus·high", true, ["Opus", "high"]]);
    // Esc closes it and puts the focus back on ▾.
    await page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    title = await read("autoTitle");
    assert.deepEqual([title.open, title.expanded, title.focused], [false, "false", true]);

    // Done when: another model at high is "Done when: {Model}", another effort adds it; a click outside closes the menu.
    await arrow("autoRule");
    await pick("autoRule", "Opus");
    assert.equal((await read("autoRule")).text, "Done When: Opus");
    await pick("autoRule", "max");
    assert.equal((await read("autoRule")).text, "Done When: Opus·max");
    await page.evaluate(`document.body.click(); true`);
    assert.equal((await read("autoRule")).open, false);

    // Add task sends the picks; the pick is remembered in the webview's state.
    await page.evaluate(`(() => { const p = document.querySelector('textarea[placeholder="Task prompt"]'); p.value = 'Do the work.'; p.dispatchEvent(new Event('input'));
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Add task').click(); return true; })()`);
    const sent = (await page.evaluate("window.__posted")).filter((m) => m.type === "create").at(-1);
    assert.deepEqual([sent.titleModel, sent.titleEffort, sent.ruleModel, sent.ruleEffort], ["opus", "high", "opus", "max"]);
    assert.deepEqual(await page.evaluate("[window.__state.titlePick, window.__state.rulePick]"), [{ model: "opus", effort: "high" }, { model: "opus", effort: "max" }]);
    // Back to the defaults gives the old labels exactly.
    await arrow("autoRule"); await pick("autoRule", "Fable"); await pick("autoRule", "high"); await page.evaluate(`document.body.click(); true`);
    assert.equal((await read("autoRule")).text, "Done When: Fable");

    // A Codex account: its title is Luna's, so the title's ▾ is greyed with the reason; its Done when is written on Claude, so that one is not.
    await page.evaluate(`(() => { const a = document.querySelector('select[aria-label="Account for new task"]'); a.value = 'cx'; a.dispatchEvent(new Event('change')); return a.value; })()`);
    title = await read("autoTitle"); rule = await read("autoRule");
    assert.deepEqual([title.disabled, title.title], [true, "A Codex task is named by Luna at low effort, so this model and effort are for Claude accounts."]);
    assert.deepEqual([rule.disabled, rule.title], [false, "Model and effort for Done when"]);
    await page.evaluate(`(() => { const a = document.querySelector('select[aria-label="Account for new task"]'); a.value = 'acct'; a.dispatchEvent(new Event('change')); return true; })()`);
    assert.equal((await read("autoTitle")).disabled, false);

    // A 283 px side bar, short enough to have a vertical scroll bar: either menu, open, stays inside the panel and the board does not
    // scroll sideways (a max-width of 100vw counted the scroll bar and did).
    await page.send("Emulation.setDeviceMetricsOverride", { width: 283, height: 400, deviceScaleFactor: 1, mobile: false });
    await cdp.waitFor(() => page.evaluate("innerWidth === 283"), "the page at 283 px");
    for (const id of ["autoTitle", "autoRule"]) {
      await arrow(id);
      const seen = await page.evaluate(`(() => { const vw = document.documentElement.clientWidth, menu = document.getElementById(${JSON.stringify(id)}).closest('.split').querySelector('[role=menu]');
        const r = menu.getBoundingClientRect();
        const past = [...document.body.querySelectorAll('*')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > vw + 0.5; }).map((e) => e.tagName + '.' + e.className);
        return { vw, innerWidth, scrollWidth: document.documentElement.scrollWidth, open: !menu.hidden, left: r.left, right: r.right, past }; })()`);
      assert.ok(seen.open, `${id}: the menu is open`);
      assert.ok(seen.vw < seen.innerWidth, `${id}: the page has a vertical scroll bar, ${seen.vw} of ${seen.innerWidth}`);
      assert.ok(seen.left >= 0 && seen.right <= seen.vw, `${id}: the menu sits inside the panel: ${seen.left}-${seen.right} of ${seen.vw}`);
      assert.deepEqual(seen.past, [], `${id}: nothing right of the panel`);
      assert.ok(seen.scrollWidth <= seen.vw, `${id}: no sideways scroll: ${seen.scrollWidth} in ${seen.vw}`);
      await page.evaluate(`document.body.click(); true`);
    }
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* a temp folder */ }
  }
});
