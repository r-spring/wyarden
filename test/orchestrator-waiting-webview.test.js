// The real media/board.js in headless Edge/Chrome: an orchestrator card whose own turn ended stays in Running while its cards work (F75).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

const now = new Date().toISOString();
const card = (id, extra = {}) => ({ id, title: `Card ${id}`, prompt: "p", status: "review", createdAt: now, updatedAt: now, ...extra });
const orch = (extra = {}) => card("root", { orchestrator: { caps: {}, opened: 1 }, ...extra });
const child = (extra = {}) => card("kid", { parentId: "root", status: "running", headless: true, ...extra });

test("webview: an orchestrator card with working cards under it is drawn in Running with a Waiting chip", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview check was not run."); return; }
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-waiting-webview-"));
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`The browser could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading in the harness");
    // Where is the card drawn, and which "Waiting on" chip does it carry?
    const draw = async (tasks, id = "root") => {
      await page.evaluate(`window.__host(${JSON.stringify({ tasks, live: [], own: [], accounts: ["acct"] })}); true`);
      return page.evaluate(`(() => { const c = document.querySelector('[data-task="${id}"]'); const h = c?.closest(".column")?.querySelector("h3");
        return c && { column: h.dataset.status, chip: [...c.querySelectorAll(".chip")].map((x) => x.textContent).find((x) => /^Waiting on/.test(x)) || null }; })()`);
    };
    await draw([orch(), child()]);
    const controller = () => page.evaluate(`document.querySelector('[data-task="kid"]').textContent`);
    assert.match(await controller(), /Controller: you/);
    await draw([orch(), child({ openedBy: "root", watchedBy: "watcher", controllerTitle: "Watcher" })]);
    assert.ok((await controller()).includes("Controller: Watcher (watcher)"));
    const kids = (...statuses) => statuses.map((status, i) => child({ id: `k${i}`, status }));

    assert.deepEqual(await draw([orch(), child()]), { column: "running", chip: "Waiting on 1 card" }, "a running child holds it in Running");
    assert.deepEqual(await draw([orch(), ...kids("running", "queued", "needs-input", "review", "done")]), { column: "running", chip: "Waiting on 3 cards" }, "queued, running and needs-input count; review and done do not");
    assert.deepEqual(await draw([orch(), child({ id: "mid", status: "review" }), child({ id: "deep", parentId: "mid", status: "queued" })]), { column: "running", chip: "Waiting on 1 card" }, "a grandchild counts");
    assert.deepEqual(await draw([card("plan", { planRun: { review: "checks" } }), child({ parentId: "plan" })], "plan"), { column: "running", chip: "Waiting on 1 card" }, "a plan card counts too");

    assert.deepEqual(await draw([orch({ asks: true }), child()]), { column: "review", chip: null }, "a card that asks the user something stays in Review");
    assert.deepEqual(await draw([orch({ interrupted: true }), child()]), { column: "review", chip: null }, "an interrupted card stays in Review");
    assert.deepEqual(await draw([orch({ deliveryReady: true }), child()]), { column: "review", chip: null }, "a card that declared ready stays in Review");
    assert.deepEqual(await draw([orch(), child({ status: "done" })]), { column: "review", chip: null }, "all cards done: back in Review");
    assert.deepEqual(await draw([orch(), ...kids("queued", "queued", "running", "running")].map((c, i) => i === 1 ? { ...c, blocked: "Other" } : i === 2 ? { ...c, cancelled: true } : i === 3 ? { ...c, discarded: true } : c)), { column: "running", chip: "Waiting on 1 card" }, "blocked, cancelled and discarded cards do not count");
    assert.deepEqual(await draw([orch(), ...kids("queued", "running").map((c) => ({ ...c, cancelled: true }))]), { column: "review", chip: null }, "only cancelled cards: Review");
    assert.deepEqual(await draw([card("root"), child()]), { column: "review", chip: null }, "a plain parent is unchanged");
    assert.deepEqual(await draw([orch({ status: "needs-input" }), child()]), { column: "needs-input", chip: null }, "other statuses are unchanged");

    // A Done run keeps only its Done cards folded in the run row; a Review card under it is drawn in Review, outside the run row.
    const runOf = (...kids) => ({ children: kids.map((k) => ({ id: k.id, title: k.title, status: k.status })), running: 0, needsYou: 0, done: 0, points: 0 });
    const where = (id) => page.evaluate(`(() => { const c = document.querySelector('[data-task="${id}"]'); return c ? { column: c.closest(".column")?.querySelector("h3")?.dataset.status, inRunRow: !!c.closest(".run-children") } : null; })()`);
    const open = child({ id: "open", status: "review" }), finished = child({ id: "fin", status: "done" });
    await draw([orch({ status: "done", run: runOf(open, finished) }), open, finished]);
    assert.deepEqual(await where("open"), { column: "review", inRunRow: false }, "a Review card under a Done run is on the board in Review");
    assert.equal(await where("fin"), null, "a Done card under a Done run stays folded (run row closed)");
    await draw([orch({ status: "review", asks: true, run: runOf(open) }), open]);
    assert.equal(await where("open"), null, "under a run that is not Done, a Review card stays folded as before");
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* a temp folder */ }
  }
});
