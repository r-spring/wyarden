// The real media/board.js and board.css in headless Edge/Chrome: a right-click on a button that calls a helper model opens one menu of the
// provider, model, effort and (Finish only) permission mode that action runs on, sends each pick to the host and names it on the
// button (the user, 13 November 2026, F102). VS Code's own card menu still opens everywhere else on the card.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

const now = new Date().toISOString();
const card = { id: "c1", title: "Card one", prompt: "p", status: "review", account: "acct", worktree: "/w/c1", branch: "task/c1", sessionId: "s1",
  createdAt: now, updatedAt: now, reviewable: true, completion: { doneWhen: "Tests pass.", commands: [] } };
const host = (extra = {}) => ({ tasks: [card], live: [], own: [], accounts: ["acct", "cx"], helperModels: { claude: "fable · max effort", codex: "gpt-6-astra · ultra effort" },
  codex: { accounts: ["cx"], models: [{ model: "gpt-6-astra", efforts: ["medium", "high", "ultra"] }], short: [{ name: "astra", id: "gpt-6-astra", label: "Astra" }] }, ...extra });

test("webview: right-click on Review, Refine draft, Finish and the split toggles opens the pick menu, sends each pick and shows it", { timeout: 90_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview check was not run."); return; }
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-pick-webview-"));
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`The browser could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading in the harness");
    await page.evaluate(`window.__host(${JSON.stringify(host())}); window.__posted.length = 0; window.__native = 0; window.addEventListener("contextmenu", () => { window.__native++; }); true`);
    const ev = (js) => page.evaluate(js);
    const find = (scope, label) => `[...document.querySelectorAll(${JSON.stringify(scope + " button")})].find((b) => b.textContent === ${JSON.stringify(label)})`;
    // A real right-click's event: bubbles and can be cancelled. Returns whether it was cancelled (VS Code's menu skips a cancelled one).
    const rightClick = (expr) => ev(`(() => { const b = ${expr}, r = b.getBoundingClientRect();
      return !b.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.bottom })); })()`);
    const menu = () => ev(`(() => { const m = document.querySelector(".action-menu"), r = m.getBoundingClientRect(), vw = document.documentElement.clientWidth;
      return { open: !m.hidden, role: m.getAttribute("role"), label: m.getAttribute("aria-label"), inside: r.left >= 0 && r.right <= vw,
        groups: [...m.querySelectorAll("[role=group]")].map((g) => [g.getAttribute("aria-label"), [...g.querySelectorAll("button")].map((b) => b.textContent), g.querySelector(".split-note")?.textContent || ""]),
        picked: [...m.querySelectorAll("[aria-checked=true]")].map((b) => b.textContent) }; })()`);
    const pick = (label) => ev(`[...document.querySelectorAll(".action-menu button")].find((b) => b.textContent === ${JSON.stringify(label)}).click(); true`);
    const sent = (type) => ev(`window.__posted.filter((m) => m.type === ${JSON.stringify(type)})`);
    const review = find('[data-task="c1"]', "Review"), finish = find('[data-task="c1"]', "Finish"), refine = find(".form", "Refine draft");

    // Review: the default mouse-over says right-click picks another; the right-click is cancelled and never reaches VS Code's menu.
    assert.equal(await ev(`${review}.title`), "Review this card's work against its Done when, on Fable or Astra at medium effort. Uses account usage. Right-click to pick another provider, model or effort.");
    assert.equal(await rightClick(review), true, "the Review right-click is cancelled");
    assert.equal(await ev("window.__native"), 0, "and stopped before VS Code's own card menu");
    let m = await menu();
    assert.deepEqual([m.open, m.role, m.label, m.inside], [true, "menu", "Provider, model and effort for Review", true]);
    assert.deepEqual(m.groups, [
      ["Provider", ["Card's account", "acct", "cx"], ""],
      ["Model", ["Default", "Haiku", "Opus", "Fable"], ""],
      ["Effort", ["Default", "low", "medium", "high", "xhigh", "max"], ""],
      ["Permissions", [], "This helper runs without tools, so it has no permission mode."]]);
    assert.deepEqual(m.picked, ["Card's account", "Default", "Default"]);
    // Opus, then high: each applies at once, is sent to the host, and the menu stays open.
    await pick("Opus");
    await pick("high");
    assert.deepEqual(await sent("setActionPick"), [{ type: "setActionPick", action: "review", pick: { provider: "claude", model: "opus" } },
      { type: "setActionPick", action: "review", pick: { provider: "claude", model: "opus", effort: "high" } }]);
    m = await menu();
    assert.deepEqual([m.open, m.picked], [true, ["Card's account", "Opus", "high"]]);
    // Esc closes it; the Review button (redrawn) names the pick.
    await ev(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
    assert.equal((await menu()).open, false);
    assert.equal(await ev(`${review}.title`), "Review this card's work against its Done when, on Fable or Astra at medium effort. Uses account usage. Your pick: Opus · high effort. Right-click to change it.");
    // Anywhere else on the card the right-click is left to VS Code's own menu.
    assert.equal(await ev(`!document.querySelector('[data-task="c1"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`), false);
    assert.equal(await ev("window.__native"), 1);

    // Refine draft: Opus at high, then Refine draft sends the form's account as before (the host applies the pick).
    await ev(`(() => { const p = document.querySelector('textarea[placeholder="Task prompt"]'); p.value = "Fix the bug."; p.dispatchEvent(new Event("input")); return true; })()`);
    assert.equal(await rightClick(refine), true);
    m = await menu();
    assert.equal(m.label, "Provider, model and effort for Refine draft");
    assert.deepEqual(m.groups[0], ["Provider", ["Selected account", "acct", "cx"], ""]);
    await pick("Opus"); await pick("high");
    assert.deepEqual((await sent("setActionPick")).at(-1), { type: "setActionPick", action: "refine", pick: { provider: "claude", model: "opus", effort: "high" } });
    await ev("document.body.click(); true");
    assert.equal((await menu()).open, false, "a click outside closes it");
    // Refine draft and Improve prompt are split buttons like Title and Done When: ▾ opens the same menu, and a second click closes it.
    const arrow = (expr) => `${expr}.parentElement.querySelector(".split-arrow")`;
    assert.equal(await ev(`${refine}.parentElement.className`), "split");
    await ev(`${arrow(refine)}.click(); true`);
    m = await menu();
    assert.deepEqual([m.open, m.label, m.inside, m.picked], [true, "Provider, model and effort for Refine draft", true, ["Selected account", "Opus", "high"]]);
    await ev(`${arrow(refine)}.click(); true`);
    assert.equal((await menu()).open, false, "a second click on ▾ closes it");
    await ev(`${arrow(find(".form", "Improve prompt"))}.click(); true`);
    assert.equal((await menu()).label, "Provider, model and effort for Improve prompt");
    await ev("document.body.click(); true");
    const line = () => ev(`document.querySelector('[data-refine-target="new"] [data-refine-selection]').textContent`);
    assert.equal(await line(), "Refine draft uses Opus · high effort · acct; Improve prompt uses fable · max effort · acct");
    assert.match(await ev(`${refine}.title`), / Your pick: Opus · high effort\. Right-click to change it\.$/);
    await ev(`${refine}.click(); true`);
    const asked = (await sent("refine")).at(-1);
    assert.deepEqual([asked.account, asked.draft], ["acct", "Fix the bug."]);
    // Another provider: the Codex account. The Claude model does not carry over; the menu lists Codex's own models and efforts.
    await rightClick(refine);
    await pick("cx");
    assert.deepEqual((await sent("setActionPick")).at(-1), { type: "setActionPick", action: "refine", pick: { account: "cx" } });
    m = await menu();
    assert.deepEqual(m.groups.slice(1, 3).map(([g, items]) => [g, items]), [["Model", ["Default", "Astra"]], ["Effort", ["Default", "medium", "high", "ultra"]]]);
    await pick("Astra"); await pick("high");
    assert.deepEqual((await sent("setActionPick")).at(-1), { type: "setActionPick", action: "refine", pick: { account: "cx", provider: "codex", model: "astra", effort: "high" } });
    assert.equal(await line(), "Refine draft uses Astra · high effort · cx; Improve prompt uses fable · max effort · acct");
    // Reset to default clears the pick: the old line exactly.
    await pick("Reset to default");
    assert.deepEqual((await sent("setActionPick")).at(-1), { type: "setActionPick", action: "refine", pick: {} });
    assert.equal(await line(), "Uses fable · max effort · acct");
    await ev("document.body.click(); true");

    // Finish: no provider (the card's Claude account holds its conversation); permission modes for its conflict resolver.
    assert.equal(await rightClick(finish), true);
    m = await menu();
    assert.deepEqual([m.groups[0], m.groups[3]], [["Provider", [], "Finish runs on the card's Claude account, which holds its conversation."],
      ["Permissions", ["Accept edits", "Auto mode", "Bypass permissions"], ""]]);
    assert.deepEqual(m.picked, ["Default", "Default", "Accept edits"]);
    await pick("Bypass permissions");
    assert.deepEqual((await sent("setActionPick")).at(-1), { type: "setActionPick", action: "finish", pick: { permission: "bypass" } });
    await ev("document.body.click(); true");
    assert.match(await ev(`${finish}.title`), / Your pick: Bypass permissions\. Right-click to change it\.$/);

    // The host's own state wins on its next post: the picks it holds are what the buttons show.
    await ev(`window.__host(${JSON.stringify(host({ actionPicks: { review: { account: "cx", provider: "codex", model: "astra", effort: "medium" } } }))}); true`);
    assert.match(await ev(`${review}.title`), / Your pick: cx · Astra · medium effort\. Right-click to change it\.$/);
    assert.match(await ev(`${finish}.title`), / Right-click to pick another model, effort or permission mode\.$/);

    // Title and Done When: a right-click on either part opens their own ▾ menu, not VS Code's.
    for (const id of ["autoTitle", "autoRule"]) {
      const cancelled = await rightClick(`document.getElementById(${JSON.stringify(id)}).closest(".toggle")`);
      const open = await ev(`!document.getElementById(${JSON.stringify(id)}).closest(".split").querySelector("[role=menu]").hidden`);
      assert.deepEqual([cancelled, open], [true, true], id);
      await ev("document.body.click(); true");
    }
    assert.equal(await ev("window.__native"), 1, "none of these right-clicks reached VS Code's menu");

    // A 283 px side bar: the menu opened at the right edge stays inside the panel.
    await page.send("Emulation.setDeviceMetricsOverride", { width: 283, height: 500, deviceScaleFactor: 1, mobile: false });
    await cdp.waitFor(() => page.evaluate("innerWidth === 283"), "the page at 283 px");
    await ev(`(() => { const b = ${review}; b.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 270, clientY: 20 })); return true; })()`);
    m = await menu();
    assert.deepEqual([m.open, m.inside], [true, true]);
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* a temp folder */ }
  }
});
