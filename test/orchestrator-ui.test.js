// Actual board DOM: the approval budget and local clock reach the host unchanged.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

test("orchestrator approval edits root limits and displays bypass, cancellation and local time", { timeout: 60000 }, async (t) => {
  if (!cdp.edgePath()) return t.skip("A browser is required for the board DOM check");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-orch-ui-"));
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  let edge, page;
  try {
    edge = await cdp.launchEdge(url, scratch);
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((p) => p.type === "page" && p.url.toLowerCase() === url.toLowerCase()), "board test page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board load");
    const now = "2026-11-05T01:00:00Z";
    const task = { id: "aaaaaa", title: "Run", prompt: "Work", status: "needs-input", createdAt: now, updatedAt: now,
      permission: "bypass", deliveryReady: true, orchestrator: { caps: { open: 4, total: 600, depth: 4, pending: 3, watchers: 3, perWatcher: 4 }, opened: 1 },
      measurement: { source: "unknown", at: now, context: { usedPercent: 20, at: now } },
      plan: { steps: 276, points: 552 }, run: { open: 0, done: 0, cancelled: 1, children: [] } };
    await page.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
    const state = { tasks: [task], live: [], own: [], accounts: [] };
    for (const [board, hour] of [[state, 1], [{ ...state, hostTimezone: "Etc/GMT-3" }, 4]]) {
      await page.evaluate(`window.__host(${JSON.stringify(board)}); true`);
      const seen = await page.evaluate(`({
        meta: document.querySelector('.meta').textContent,
        text: document.querySelector('.card').textContent,
        measurements: [...document.querySelectorAll('.card p')].map(p => p.textContent)
      })`);
      assert.match(seen.meta, /Bypass permissions/);
      assert.match(seen.meta, new RegExp(`started 0?${hour}:00\\b`, 'i'));
      assert.match(seen.text, /0 done · 1 cancelled/);
      assert.match(seen.text, /delivery ready/);
      for (const label of ['Measured', 'Context window 20% full']) {
        const measurement = seen.measurements.find(text => text.startsWith(label));
        assert.ok(measurement, label);
        assert.match(measurement, new RegExp(`\\b0?${hour}:00:00\\b`));
      }
    }
    await page.evaluate(`(() => { document.querySelector('input[aria-label="Total cards"]').value = "800"; document.querySelector('input[aria-label="Notices before a watcher"]').value = "2"; document.querySelector('input[aria-label="Allow automatic pressure watchers"]').checked = true; [...document.querySelectorAll('button')].find(b=>b.textContent==='Approve').click(); })()`);
    assert.deepEqual(await page.evaluate(`window.__posted.filter(m=>m.type==='approvePlan')`), [{ type: "approvePlan", id: "aaaaaa", pressureWatchers: true, caps: { open: 4, total: 800, depth: 4, pending: 2, watchers: 3, perWatcher: 4 } }]);
  } finally {
    page?.close();
    if (edge) await edge.kill();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
