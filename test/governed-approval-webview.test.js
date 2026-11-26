// The real media/board.js in headless Edge/Chrome: the Governed run section of a plan-approval row (F111). Findings of the linux check,
// docs/evidence/capability-profiles-gap-closure/linux-F111.md: B1 a blocked profile shows as blocked with its reason, R1 what was typed
// survives a board update, W1 the section fits narrow side bars.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

const plan = (updatedAt) => ({ id: "root", title: "Card root", prompt: "p", status: "review", account: "acct", createdAt: "2026-11-18T01:00:00Z", updatedAt,
  orchestrator: { caps: {}, opened: 0 }, plan: { steps: 3, points: 12, caps: { open: 2, total: 4, depth: 2, pending: 2, watchers: 1, perWatcher: 2 } } });
const REASON = "Capability profile Docs only r1 is blocked on claude:terminal: skill docs is not installed or configured for this account and worktree. "
  + `Missing from /fixture/${"long-worktree-name-".repeat(12)}docs.`;
const profiles = { errors: [], entries: [{ ref: "workspace:d0c5", scope: "workspace", name: "Docs only", revision: 1, blocked: { acct: REASON, other: "This account cannot see the profile inventory." } }] };
const host = (updatedAt) => JSON.stringify({ tasks: [plan(updatedAt)], live: [], own: [], accounts: ["acct", "other"], activeAccount: "other", profiles });

test("webview: governed approval shows blocked reasons by keyboard, keeps typed choices across updates, and fits narrow side bars", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview check was not run."); return; }
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-governed-webview-"));
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`The browser could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading in the harness");
    await page.evaluate(`window.__host(${host("2026-11-18T01:00:00Z")}); true`);
    const q = (sel) => `document.querySelector('[data-task="root"] ${sel}')`;
    await cdp.waitFor(() => page.evaluate(`!!${q('input[aria-label="Approve as a governed run"]')}`), "the governed toggle");

    // B1: both choices mark the profile as blocked; Tab from its checkbox and Enter reveal the root account's reason.
    await page.evaluate(`${q('input[aria-label="Approve as a governed run"]')}.click(); true`);
    const b1 = await page.evaluate(`(() => { const f = ${q("fieldset.governed")};
      return { boxes: [...f.querySelectorAll("label.toggle")].map((l) => l.textContent), options: [...f.querySelectorAll('select[aria-label="Default child profile"] option')].map((o) => o.textContent),
        summary: f.querySelector("details summary")?.textContent, open: f.querySelector("details")?.open }; })()`);
    assert.deepEqual(b1.boxes, ["Provider defaults", "Docs only (workspace) r1 · blocked"]);
    assert.deepEqual(b1.options, ["No default (each add names one)", "Provider defaults", "Docs only (workspace) r1 · blocked"]);
    assert.equal(b1.summary, "Why Docs only (workspace) r1 is blocked on acct");
    assert.equal(b1.open, false);
    await page.evaluate(`${q('input[aria-label="Children may use Docs only (workspace) r1 · blocked"]')}.focus(); true`);
    await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    assert.equal(await page.evaluate(`document.activeElement === ${q("fieldset.governed summary")}`), true);
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    assert.equal(await page.evaluate(`${q("fieldset.governed details[open] p")}?.textContent`), REASON);

    // R1: tick, type and choose, with focus in a limit box; then a board update rebuilds the card.
    await page.evaluate(`(() => {
      const set = (label, v) => { const e = ${q("")}.querySelector('[aria-label="' + label + '"]'); e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); };
      set("Active executions (root, coordinators, workers, judges)", "6"); set("Direct active children per card", "3"); set("Delegation depth", "2");
      ${q('input[aria-label="Children may use Provider defaults"]')}.click();
      const d = ${q('select[aria-label="Default child profile"]')}; d.value = "provider-defaults"; d.dispatchEvent(new Event("change", { bubbles: true }));
      ${q('input[aria-label="Delegation depth"]')}.focus(); return true; })()`);
    await new Promise((r) => setTimeout(r, 100)); // the details toggle event is queued
    const before = await page.evaluate(`${q(".plan")} !== null && (window.__oldPlan = ${q(".plan")}, true)`);
    assert.ok(before);
    await page.evaluate(`window.__host(${host("2026-11-18T01:00:05Z")}); true`);
    const r1 = await page.evaluate(`(() => { const f = ${q("fieldset.governed")};
      return { rebuilt: ${q(".plan")} !== window.__oldPlan, open: !f.hidden, ticked: ${q('input[aria-label="Approve as a governed run"]')}.checked,
        values: [...f.querySelectorAll("input, select")].map((e) => e.type === "checkbox" ? e.checked : e.value), focus: document.activeElement.ariaLabel, why: f.querySelector("details").open }; })()`);
    assert.equal(r1.rebuilt, true, "the update really rebuilt the row");
    assert.deepEqual({ ...r1, rebuilt: undefined }, { rebuilt: undefined, open: true, ticked: true, values: ["6", "3", "2", true, false, "provider-defaults", ""], focus: "Delegation depth", why: true });

    await page.evaluate(`window.__posted.length = 0; [...document.querySelectorAll('[data-task="root"] button')].find((b) => b.textContent === "Approve").click(); true`);
    const sent = (await page.evaluate("window.__posted")).find((m) => m.type === "approvePlan");
    assert.deepEqual(sent?.governed, { limits: { active: 6, directChildren: 3, depth: 2 }, allowed: ["provider-defaults"], defaultChild: "provider-defaults" });

    // W1: the filled fieldset, its controls and the expanded reason text fit at both reported widths and at 360 px.
    for (const width of [180, 284, 360]) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height: 700, deviceScaleFactor: 1, mobile: false });
      const w1 = await cdp.waitFor(() => page.evaluate(`(() => {
        if (innerWidth !== ${width}) return null;
        const f = ${q("fieldset.governed")};
        const right = Math.min(f.parentElement.getBoundingClientRect().right, document.documentElement.clientWidth);
        const over = [f, ...f.querySelectorAll("*")].filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > right + 0.5)
          .map((e) => e.ariaLabel || e.tagName);
        const reason = document.createRange();
        reason.selectNodeContents(f.querySelector("details[open] p"));
        const lines = [...reason.getClientRects()];
        return { over, reasonFits: lines.length > 0 && lines.every((line) => line.right <= f.getBoundingClientRect().right + 0.5) };
      })()`), `the ${width} px viewport`);
      assert.deepEqual(w1, { over: [], reasonFits: true }, `governed approval fits at ${width} px`);
    }
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* a temp folder */ }
  }
});
