// The real media/board.js and board.css in headless Edge/Chrome: every on/off choice is a toggle button that changes colour when
// switched on or off and explains itself on mouse-over (the user, 11 November 2026, F53 and the tickboxes beside it, F73's watchers).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

const now = new Date().toISOString();
const plan = { id: "root", title: "Card root", prompt: "p", status: "review", createdAt: now, updatedAt: now,
  orchestrator: { caps: {}, opened: 0 }, plan: { steps: 3, points: 12, caps: { open: 2, total: 4, depth: 2, pending: 2, watchers: 1, perWatcher: 2 } } };

test("webview: every checkbox is drawn as a toggle button with a mouse-over explanation and a different colour on and off", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview check was not run."); return; }
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-toggle-webview-"));
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`The browser could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading in the harness");
    // The theme colours VS Code would give the webview; the harness has none of its own.
    await page.evaluate(`(() => { const s = document.documentElement.style; s.setProperty('--vscode-inputOption-activeBackground', 'rgba(0, 127, 212, 0.4)');
      s.setProperty('--vscode-inputOption-activeForeground', 'rgb(255, 255, 255)'); s.setProperty('--vscode-descriptionForeground', 'rgb(150, 150, 150)'); return true; })()`);
    await page.evaluate(`window.__host(${JSON.stringify({ tasks: [plan], live: [], own: [], accounts: ["acct"] })}); true`);
    await cdp.waitFor(() => page.evaluate(`!!document.querySelector('[data-task="root"] .plan .toggle')`), "the plan card's watcher toggle");

    const read = () => page.evaluate(`[...document.querySelectorAll('input[type=checkbox]')].map((b) => { const l = b.closest('.toggle'); const cs = l && getComputedStyle(l);
      return { id: b.id || b.getAttribute('aria-label'), text: l?.textContent.trim(), title: l?.title, checked: b.checked, background: cs?.backgroundColor, color: cs?.color,
        boxHidden: getComputedStyle(b).opacity === '0' }; })`);
    const before = await read();
    assert.deepEqual(before.map((x) => x.text), ["Title: Haiku", "Done When: Fable", "Plan first", "Card terminal", "Allow delegation", "Watchers off", "Governed run", "Provider defaults"], "every checkbox sits in a toggle button");
    for (const x of before) {
      assert.ok(x.title && x.title.length > 20, `${x.text} explains itself on mouse-over`);
      assert.ok(x.boxHidden, `${x.text}: the checkbox itself is not drawn`);
    }

    // Click each toggle button (the label, as a mouse would) and read it again: the state flips and the colours change.
    await page.evaluate(`[...document.querySelectorAll('input[type=checkbox]')].forEach((b) => b.closest('.toggle').click()); true`);
    const after = await read();
    for (const [i, x] of before.entries()) {
      const y = after[i];
      assert.equal(y.checked, !x.checked, `${x.text}: a click switches it`);
      const on = y.checked ? y : x, off = y.checked ? x : y;
      assert.equal(on.background, "rgba(0, 127, 212, 0.4)", `${x.text}: on is filled with VS Code's toggle colour`);
      assert.equal(off.background, "rgba(0, 0, 0, 0)", `${x.text}: off is not filled`);
      assert.notEqual(on.color, off.color, `${x.text}: its text colour changes too`);
    }
    assert.equal(after.find((x) => /^Watchers/.test(x.text)).text, "Watchers on", "the watcher toggle names its state");
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* a temp folder */ }
  }
});
