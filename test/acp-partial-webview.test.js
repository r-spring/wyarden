const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const cdp = require("./compile-webview-cdp");
require("./safe-temp").assertSafeTemp();

test("ACP partial replies are visible and labelled until a turn completes", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("No supported browser available"); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-acp-partial-"));
  let edge, page;
  try {
    const url = pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
    edge = await cdp.launchEdge(url, scratch);
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "board page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board ready");
    const task = { id: "abc123", title: "Agent", prompt: "Work", provider: "grok", status: "running", headless: true, sessionId: "agent-session", worktree: "work", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), prompts: [{ text: "Work", reply: "Working", replyStatus: "partial" }] };
    const show = async (live) => page.evaluate(`window.__host(${JSON.stringify({ tasks: [task], live, own: live, accounts: [] })}); true`);
    await show([task.id]);
    assert.equal(await page.evaluate('document.querySelector(".card .reply").textContent'), "Partial reply: Working");
    task.status = "review"; task.interrupted = true;
    await show([]);
    assert.equal(await page.evaluate('document.querySelector(".card .reply").textContent'), "Partial reply: Working");
    task.interrupted = undefined; task.reply = "Finished"; task.prompts[0] = { text: "Work", reply: "Finished" };
    await show([]);
    assert.equal(await page.evaluate('document.querySelector(".card .reply").textContent'), "↩ Finished");
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* browser may still release its profile */ }
  }
});
