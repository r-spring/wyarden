const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

test("cards offer Resume for an interrupted live session, show pending acknowledgement, and clear stale hints", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) return t.skip("A browser is required for the board DOM check");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-resume-ui-"));
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  let edge, page;
  try {
    edge = await cdp.launchEdge(url, scratch);
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((p) => p.type === "page" && p.url.toLowerCase() === url.toLowerCase()), "board test page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board load");
    const now = new Date().toISOString(), task = { id: "aaaaaa", title: "Resume task", prompt: "Work", sessionId: "session", worktree: "/wt",
      status: "review", interrupted: true, createdAt: now, updatedAt: now };
    const host = (patch) => page.evaluate(`window.__host(${JSON.stringify({ tasks: [{ ...task, ...patch }], live: [task.id], own: [task.id], accounts: [] })}); true`);
    const read = () => page.evaluate(`(() => { const c=document.querySelector('.card'); return {text:c.textContent, buttons:[...c.querySelectorAll('button')].map(b=>({text:b.textContent,disabled:b.disabled}))}; })()`);
    await host({});
    assert.ok((await read()).buttons.some((b) => b.text === "Resume" && !b.disabled));
    await page.evaluate(`document.querySelectorAll('.card button').forEach(b=>{if(b.textContent==='Resume')b.click()}); true`);
    assert.deepEqual(await page.evaluate(`window.__posted.filter(m=>m.type==='resume')`), [{ type: "resume", id: task.id }]);
    await host({ resuming: true });
    let seen = await read();
    assert.ok(seen.buttons.some((b) => b.text === "Resuming…" && b.disabled));
    assert.match(seen.text, /waiting for the session to start its next turn/);
    assert.doesNotMatch(seen.text, /Interrupted:/);
    await host({ status: "running", interrupted: undefined, lastEventAt: Date.now() });
    seen = await read();
    assert.doesNotMatch(seen.text, /Interrupted:|Quiet|Resuming/);
    assert.ok(!seen.buttons.some((b) => b.text === "Resume"));
    await host({ status: "running", interrupted: undefined, lastEventAt: Date.now() - 25 * 60_000 });
    seen = await read();
    assert.match(seen.text, /Quiet 25 min/);
    assert.match(await page.evaluate(`document.querySelector('.chip.quiet').title`), /subagent activity/);
    // Check both board widths in one inspection round.
    for (const width of [1000, 480]) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await host({ resuming: true });
      assert.equal(await page.evaluate(`document.querySelector('.card').scrollWidth <= document.querySelector('.card').clientWidth + 1`), true);
    }
  } finally {
    page?.close();
    if (edge) await edge.kill();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
