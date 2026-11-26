// The real media/board.js in headless Edge/Chrome: the pressure-watcher checkbox on a plan awaiting approval shows its on/off state next to it (F73, 9 November 2026).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

const now = new Date().toISOString();
const plan = { id: "root", title: "Card root", prompt: "p", status: "review", createdAt: now, updatedAt: now,
  orchestrator: { caps: {}, opened: 0 }, plan: { steps: 3, points: 12, caps: { open: 2, total: 4, depth: 2, pending: 2, watchers: 1, perWatcher: 2 } } };

test("webview: the pressure-watcher checkbox reads Watchers off, then Watchers on when ticked, and Approve sends its state", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview check was not run."); return; }
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-pressure-webview-"));
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`The browser could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading in the harness");
    await page.evaluate(`window.__host(${JSON.stringify({ tasks: [plan], live: [], own: [], accounts: ["acct"] })}); true`);
    const box = `document.querySelector('[data-task="root"] .plan input[type=checkbox][aria-label="Allow automatic pressure watchers"]')`;
    // The checkbox, what sits right after it, and the label's full text.
    // Since 11 November 2026 the box and its state are one toggle button; the explanation is its mouse-over and the line beside it.
    const read = () => page.evaluate(`(() => { const b = ${box}; return b && { checked: b.checked, next: b.nextSibling?.textContent, label: b.closest("label").textContent,
      title: b.closest("label").title, beside: b.closest("label").nextSibling?.textContent }; })()`);
    const off = await cdp.waitFor(read, "the plan card's watcher checkbox");
    assert.equal(off.checked, false, "unticked by default");
    assert.equal(off.next, "Watchers off", "the state label sits right after the box");
    const sentence = "Allow the board to open additional watcher cards when notices accumulate (uses run slots and model usage)";
    assert.equal(off.title, sentence, "the explanation is the toggle's mouse-over");
    assert.equal(off.beside, sentence, "the explanatory sentence stays beside it");

    await page.evaluate(`${box}.click(); true`);
    assert.deepEqual(await read(), { ...off, checked: true, next: "Watchers on", label: off.label.replace("Watchers off", "Watchers on") }, "ticking shows Watchers on at once");

    await page.evaluate(`window.__posted.length = 0; [...document.querySelectorAll('[data-task="root"] button')].find((b) => b.textContent === "Approve").click(); true`);
    const sent = (await page.evaluate("window.__posted")).find((m) => m.type === "approvePlan");
    assert.equal(sent?.pressureWatchers, true, "Approve sends the ticked state");

    await page.evaluate(`${box}.click(); true`);
    assert.equal((await read()).next, "Watchers off", "unticking shows Watchers off again");
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* a temp folder */ }
  }
});
