// A webview test must end when its page stops answering. Before 13 November 2026 a command to a dead page waited for ever, the
// test never reached its `finally`, and the browser it left open kept `npm test` standing (12 hours, test/card-terminal-webview.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const cdp = require("./compile-webview-cdp");
require("./safe-temp").assertSafeTemp();

test("a command to a page that never answers, or whose renderer has died, is refused instead of waiting for ever", { timeout: 60000 }, async (t) => {
  if (!cdp.edgePath()) return t.skip("Microsoft Edge, Chrome or Chromium is unavailable");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-cdp-dead-"));
  const url = pathToFileURL(path.resolve(__dirname, "terminal-webview-harness.html")).href;
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`The browser could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board ready");

    // A promise the page never settles: refused after the command's own limit, and the page still answers afterwards.
    let started = Date.now();
    await assert.rejects(page.send("Runtime.evaluate", { expression: "new Promise(() => {})", awaitPromise: true }, 500), /Runtime\.evaluate: no answer in 500 ms/);
    assert.ok(Date.now() - started < 5000, `refused in ${Date.now() - started} ms`);
    assert.equal(await page.evaluate("1 + 1"), 2);
    assert.equal(page.pending.size, 0, "nothing is left waiting");

    // The renderer dies while a command waits: that command and every later one are refused at once.
    started = Date.now();
    const waiting = page.evaluate("new Promise(() => {})");
    page.send("Page.crash").catch(() => {});
    await assert.rejects(waiting, /Runtime\.evaluate: the page crashed/);
    await assert.rejects(page.evaluate("1 + 1"), /Runtime\.evaluate: the page crashed/);
    assert.ok(Date.now() - started < 10000, `refused in ${Date.now() - started} ms`);
    assert.equal(page.pending.size, 0, "nothing is left waiting");
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* browser may still release its profile */ }
  }
});
