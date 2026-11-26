// The real media/board.js in headless Edge/Chrome: a subagent's state line says "1 step" for one step and "N steps" otherwise (F13, live check 11 November 2026).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

const now = new Date().toISOString();
const agent = (id, steps) => ({ id, type: "general-purpose", description: `Agent ${id}`, doing: "Throwaway", steps, done: true });
const card = { id: "root", title: "Card root", prompt: "p", status: "review", createdAt: now, updatedAt: now,
  subagents: [agent("a", 1), agent("b", 2)] };

test("webview: a subagent with one step reads 1 step, with two reads 2 steps", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview check was not run."); return; }
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-subagent-steps-webview-"));
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`The browser could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading in the harness");
    await page.evaluate(`window.__host(${JSON.stringify({ tasks: [card], live: [], own: [], accounts: ["acct"] })}); true`);
    const lines = await cdp.waitFor(() => page.evaluate(`(() => { const d = [...document.querySelectorAll('[data-task="root"] .agents .agent .muted')]; return d.length === 2 && d.map((e) => e.textContent); })()`), "the card's two subagent lines");
    assert.deepEqual(lines, ["run ended: Throwaway · 1 step", "run ended: Throwaway · 2 steps"]);
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* a temp folder */ }
  }
});
