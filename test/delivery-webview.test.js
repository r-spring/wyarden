// The real media/board.js in headless Edge/Chrome: a card's line saying whether its work is in the main folder (F108).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

const now = new Date().toISOString();
const card = (id, extra = {}) => ({ id, title: `Card ${id}`, prompt: "p", status: "review", createdAt: now, updatedAt: now,
  worktree: `/repo/.entomatical/wt/${id}`, branch: `task/${id}`, countsWork: true, delivers: true, ...extra });
const NOT_BY_ITSELF = "Entomatical does not deliver this card by itself. Its work reaches the main folder when it is finished.";
const REASON = "The main checkout has uncommitted changes to files this card changed, so nothing was delivered.";

test("webview: a card's work in the main folder, waiting, or refused; none without a worktree, when done, or on a plan step", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview check was not run."); return; }
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-delivery-webview-"));
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`The browser could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading in the harness");
    await page.evaluate(`document.body.style.setProperty("--vscode-editorWarning-foreground", "rgb(200, 100, 0)"); true`); // the harness has no theme
    await page.send("Emulation.setDeviceMetricsOverride", { width: 284, height: 900, deviceScaleFactor: 1, mobile: false });
    const draw = async (tasks, every = 3) => {
      await page.evaluate(`window.__host(${JSON.stringify({ tasks, live: [], own: [], accounts: ["acct"], deliverEveryTurns: every })}); true`);
      return page.evaluate(`Object.fromEntries([...document.querySelectorAll('[data-task]')].map((c) => { const d = c.querySelector('.delivery');
        return [c.dataset.task, d && { text: d.textContent, title: d.title, refused: d.classList.contains('refused'), muted: d.classList.contains('muted'),
          color: getComputedStyle(d).color,
          ellipsis: getComputedStyle(d).textOverflow, fits: d.getBoundingClientRect().right <= c.getBoundingClientRect().right + 1 }]; }))`);
    };
    const delivered = { at: now, sha: "abc1234", files: 4 };
    const cards = await draw([
      card("in", { delivery: delivered, notInMain: 0 }),
      card("wait", { delivery: delivered, notInMain: 2, deliveryTurns: 1 }),
      card("refused", { delivery: { at: now, refused: REASON }, notInMain: 1 }),
      card("bare", { worktree: undefined, branch: undefined, countsWork: undefined, delivers: undefined, delivery: delivered, notInMain: 1 }),
      card("done", { status: "done", delivery: delivered, notInMain: 0 }),
      // A plan's step: the host counts nothing for it (Board.countsWork).
      card("step", { countsWork: undefined, delivers: undefined, openedBy: "plan1", notInMain: 3 }),
      card("fresh", { notInMain: 0 }),
      // Counted but never delivered by itself (an orchestrator's card): only its waiting work, with no promise of delivery.
      card("sub", { delivers: undefined, openedBy: "orch1", notInMain: 1 }),
      card("subclean", { delivers: undefined, openedBy: "orch1", notInMain: 0 }),
    ]);
    assert.equal(cards.sub.text, "Not in main folder yet: 1 change");
    assert.equal(cards.sub.title, NOT_BY_ITSELF);
    assert.equal(cards.sub.refused, false);
    assert.equal(cards.subclean, null, "nothing waiting: no line");
    assert.equal(cards.in.text, "In main folder");
    assert.match(cards.in.title, /^Delivered .+: 4 files, commit abc1234\. Entomatical brings this card's work into the main folder every 3 turns and when it reaches Review\.$/);
    assert.equal(cards.wait.text, "Not in main folder yet: 2 changes");
    assert.equal(cards.wait.title, "Next delivery in 2 turns, or when this card reaches Review. Finish delivers it now.");
    assert.equal(cards.refused.text, `Not delivered: ${REASON}`);
    assert.match(cards.refused.title, new RegExp(`^Delivery refused .+: ${REASON.replace(/[.,]/g, "\\$&")}$`));
    assert.equal(cards.refused.refused, true);
    assert.equal(cards.refused.color, "rgb(200, 100, 0)", "the refused line is in the warning colour");
    assert.notEqual(cards.in.color, "rgb(200, 100, 0)");
    for (const id of ["in", "wait", "refused"]) {
      assert.equal(cards[id].muted, true, id);
      assert.equal(cards[id].ellipsis, "ellipsis", id);
      assert.equal(cards[id].fits, true, `${id} fits the 284 px sidebar`);
    }
    for (const id of ["bare", "done", "step", "fresh"]) assert.equal(cards[id], null, `${id} has no line`);

    const off = await draw([card("wait", { notInMain: 1 }), card("in", { delivery: delivered, notInMain: 0 })], 0);
    assert.equal(off.wait.title, "Automatic delivery is off (entomatical.deliver.everyTurns is 0). Finish delivers it.");
    assert.match(off.in.title, /^Delivered .+: 4 files, commit abc1234\. Automatic delivery is off \(entomatical\.deliver\.everyTurns is 0\)\. Finish delivers it\.$/);
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* a temp folder */ }
  }
});
