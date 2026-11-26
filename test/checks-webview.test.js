// The real media/board.js in headless Edge (Windows) or Chrome (Linux): a failed acceptance check shows what failed, and Fix it
// posts checksFix for its card (F06, the user 4 November 2026).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

test("webview: a failed acceptance check shows What failed and Fix it, which posts checksFix", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview check was not run."); return; }
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-checks-webview-"));
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`The browser could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading in the harness");
    const now = new Date().toISOString();
    const task = { id: "c1", title: "Checked", prompt: "p", status: "review", createdAt: now, updatedAt: now,
      completion: { doneWhen: "Tests pass.", commands: ["npm test"] },
      checks: { status: "error", run: "/x/run", error: "Acceptance check 1 failed: npm test exited with 1.",
        failure: { command: "npm test", exitCode: 1, lines: ["not ok 2 - subtracts"], tail: "line 1\nnot ok 2 - subtracts", log: "/x/run/check-0.log" } } };
    // A run still going offers Retry checks too (one that never exits holds Finish, Merge and Discard); a worktree gone has no logs to name.
    const running = { ...task, id: "c2", checks: { status: "running", run: "/x/run2" } };
    const gone = { ...task, id: "c3", checks: { status: "error", run: "", error: "This task's worktree is gone, so its checks cannot run." } };
    // F94 retired (8 November 2026): a card saved before then keeps its completion.verdict key, which the board ignores (no
    // "Done-when condition …" line). Both cards carry one, as F94's own fixtures had it.
    task.completion = { ...task.completion, verdict: { status: "not met", reason: "The subtract test still fails.", model: "claude-fable-5-1", at: now, checks: "Acceptance checks failed: npm test exited with 1." } };
    gone.completion = { ...gone.completion, verdict: { status: "met", reason: "Every test passes.", model: "claude-fable-5-1", at: now, checks: "All acceptance checks passed." } };
    await page.evaluate(`window.__host(${JSON.stringify({ tasks: [task, running, gone], live: [], own: [], accounts: ["acct"] })}); true`);
    const card = (id) => page.evaluate(`(() => { const c = document.querySelector('[data-task="${id}"] .completion'); return c && {
      buttons: [...c.querySelectorAll("button")].map((b) => b.textContent), title: [...c.children].find((n) => /^Acceptance checks running|^This task/.test(n.textContent))?.title }; })()`);
    assert.deepEqual(await cdp.waitFor(() => card("c2"), "the running card"), { buttons: ["Retry checks"], title: "Logs: /x/run2" });
    assert.deepEqual(await card("c3"), { buttons: ["Retry checks"], title: "" });
    const seen = await cdp.waitFor(() => page.evaluate(`(() => { const c = document.querySelector('[data-task="c1"] .completion'); return c && {
      error: [...c.querySelectorAll(".error")].find((n) => n.textContent.startsWith("Acceptance"))?.textContent, summary: c.querySelector(".check-failure summary")?.textContent,
      pre: [...c.querySelectorAll(".check-failure pre")].map((p) => p.textContent), buttons: [...c.querySelectorAll("button")].map((b) => b.textContent) }; })()`), "the card's completion section");
    assert.deepEqual(seen, { error: "Acceptance check 1 failed: npm test exited with 1.", summary: "What failed",
      pre: ["not ok 2 - subtracts", "line 1\nnot ok 2 - subtracts"], buttons: ["Fix it", "Retry checks"] });
    await page.evaluate(`[...document.querySelectorAll(".completion button")].find((b) => b.textContent === "Fix it").click(); true`);
    assert.deepEqual(await page.evaluate(`window.__posted.filter((m) => m.type === "checksFix")`), [{ type: "checksFix", id: "c1" }]);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll("[data-task]")].filter((c) => /Done-when condition|condition (not )?met|judging against/.test(c.textContent)).map((c) => c.dataset.task)`), [],
      "a leftover F94 verdict draws nothing");
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* a temp folder */ }
  }
});
