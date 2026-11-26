// The real media/board.js and board.css in headless Edge (Windows) or Chrome (Linux), from a 180 px side bar to a 900 px tab, with
// what stretches a board: a path and an identifier with no spaces in every text a card shows, long account names, many chips.
// Nothing may make the panel scroll sideways, be cut off at a card's edge, or spill out of its own box; buttons and toggles keep a
// 24 px target (F01; 13 November 2026: at 283 px the account chips made the board 981 px wide, and "Launch failed", a sub-agent's
// line and the timeline were cut at the card's edge; at 180 px so were the chips).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

const now = new Date().toISOString();
const longPath = "C:\\Users\\user\\Documents\\Dev Stuff\\Entomatical\\.entomatical\\wt\\961f90\\docs\\evidence\\parity-win-2026-11-12\\output\\w58\\F58-wrapper-log-lines.txt";
const unbroken = "aVeryLongIdentifierWithNoSpacesAtAll_".repeat(4) + "end";
const card = (id, extra) => ({ id, title: `Card ${id}`, prompt: "Do the work.", status: "review", createdAt: now, updatedAt: now, ...extra });
const kids = ["running", "review", "done"].map((status, i) => card(`k${i}`, { parentId: "orch", openedBy: "orch", openedByTitle: "Orchestrate the whole board", headless: true, status, title: `Child ${i}: ${longPath}` }));
const caps = { open: 3, total: 8, depth: 2, pending: 4, watchers: 1, perWatcher: 4 };
const tasks = [
  card("need", { status: "needs-input", title: `Fix ${unbroken} and then the Review button`, queueWait: `Held: starts after card 20071c (${longPath})`, launchError: `spawn ${longPath} ENOENT`,
    refusalStop: { n: 5, desc: "Bash rm -rf" }, takenOver: true, paused: true, pressureError: "watcher failed", stepHold: "the step's check failed twice", planFirst: true, role: "watcher",
    judged: "pass", switchedTo: "someone.e.x.ample.with.a.long.name@example-organisation.com", repeating: { tool: "Bash", n: 7 } }),
  card("run", { status: "running", doing: { text: `Bash: node --test ${longPath}`, at: Date.now() - 4000 },
    prompts: [{ text: `First prompt.\nSecond line with ${longPath}`, reply: `Done. See ${longPath} and ${unbroken}` }, { text: unbroken, reply: "Working", replyStatus: "partial" }],
    cost: { windows: [{ name: "5-hour", points: 3.2 }, { name: "weekly Opus", reset: true, points: 1 }], open: true },
    subagents: [{ id: "a", type: "ab-reviewer", description: `Review ${longPath}`, doing: `Grep ${unbroken}`, steps: 12, done: false, model: "claude-opus-5-5", effort: "medium" }],
    timeline: [{ text: `04:12:57 Bash ${longPath}` }] }),
  card("rev", { completion: { doneWhen: `The board fits; ${longPath}; ${unbroken}.`, commands: ["npm test", `node --test ${longPath}`] },
    checks: { status: "error", run: "/x/run", error: "Acceptance check 1 failed: npm test exited with 1.", failure: { command: "npm test", exitCode: 1, lines: [`not ok 2 - ${unbroken}`], tail: `not ok 2 - ${unbroken}\n${longPath}`, log: longPath } },
    reviewable: true, reviewFindings: `1. A: Cannot tell. ${longPath}`, interrupted: true,
    doneReview: { findings: [], other: [], explanation: `The diff is cut. ${longPath}`, verdict: "unsure", prompt: "", questions: [{ question: `Is ${unbroken} needed?`, suggested: "Yes" }], file: longPath, model: "fable", effort: "medium", at: now, receipt: "r1" } }),
  card("orch", { title: "Orchestrate the whole board", orchestrator: { opened: 3, caps }, planRun: { review: "model" }, finalReply: `All three cards finished. ${longPath}`,
    run: { open: 2, done: 1, cancelled: 0, running: 1, needsYou: 1, points: 12.5, children: kids.map((k) => ({ id: k.id, title: k.title, status: k.status, points: 4.1 })), budget: { percent: 42, used: 12.5, cap: 30, unknown: [] } },
    plan: { steps: 6, points: 18, caps, policy: { allow: ["media/**", longPath], deny: ["src/**"], noSync: true } } }),
  ...kids,
  card("cdx", { status: "queued", provider: "codex", waiting: true, waitsForReset: { at: Date.now() + 3_600_000 }, deliveryReady: true }),
  card("done1", { status: "done", title: `A finished card ${longPath}`, cancelled: true }),
  // Battle Royale cards (F105): the provider and tag line, the uppercase spaced-out face and the thick neon edge must fit too.
  card("bat1", { status: "running", battle: "a1b2c3d4", title: `Battle ${unbroken} · Claude` }),
  card("bat2", { status: "review", battle: "a1b2c3d4", provider: "antigravity", title: `Battle ${longPath} · Antigravity` }),
];
const at = Date.now();
const longAccount = "Antigravity · someone.e.x.ample.with.a.long.name@example-organisation.com · Profile Default (~/.gemini/antigravity-cli)";
const state = { tasks, live: ["run", "k0"], own: tasks.map((t) => t.id), accounts: ["acct", longAccount], activeAccount: "acct", externalProviders: { [longAccount]: "antigravity" }, orchestratorEnabled: true, battleRoyale: { size: 4, clearArena: true },
  accountRows: [
    { configDir: "", active: true, folder: "~/.claude", loggedIn: true, email: "someone.e.x.ample.with.a.long.name@example-organisation.com", plan: "max", usage: { fiveHour: 97, week: 40, at }, usageRefreshing: false },
    { configDir: "C:\\accounts\\pro", active: false, folder: "pro", loggedIn: true, email: "pro@example.com", plan: "pro", usage: { fiveHour: 20, week: 40, at }, usageRefreshing: false },
    { configDir: "C:\\codex", provider: "codex", active: false, folder: "Codex (~/.codex)", loggedIn: true, email: "codex@example.com", plan: "plus", usage: { windows: [{ minutes: 300, pct: 10 }, { minutes: 7 * 1440, pct: 5 }], at }, usageRefreshing: false }],
  archived: [{ key: "old", title: `An archived run ${longPath}`, archivedAt: now, cards: 3 }] };

// Runs in the page. Each list names the innermost element at fault, once per kind of element.
const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const sig = (e) => e.tagName.toLowerCase() + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\\s+/).join(".") : "");
  const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.checkVisibility?.() !== false; };
  const all = [...document.body.querySelectorAll("*")].filter(shown);
  const right = (e) => e.getBoundingClientRect().right;
  const clips = (e) => getComputedStyle(e).overflowX !== "visible";
  const scrolls = (e) => /auto|scroll/.test(getComputedStyle(e).overflowX);
  const clipper = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) if (clips(p)) return p; return null; };
  const name = (e) => sig(e) + " '" + (e.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40) + "'";
  const past = [], cut = [], spill = [], small = [], seen = new Set();
  const once = (list, e, extra = "") => { const key = list === past ? "p" + sig(e) : list === cut ? "c" + sig(e) : list === spill ? "s" + sig(e) : "t" + sig(e); if (!seen.has(key)) { seen.add(key); list.push(name(e) + extra); } };
  for (const e of all) {
    const c = clipper(e);
    // Past the panel's right edge, unless it sits in a box that scrolls by design (the model table).
    if (right(e) > vw + 0.5 && !(c && scrolls(c)) && ![...e.children].some((k) => shown(k) && right(k) > vw + 0.5)) once(past, e, " right " + Math.round(right(e)) + " of " + vw);
    // Cut off by a box that hides its overflow (a card).
    if (c && !scrolls(c)) {
      const edge = c.getBoundingClientRect().left + c.clientLeft + c.clientWidth;
      if (right(e) > edge + 0.5 && ![...e.children].some((k) => shown(k) && right(k) > edge + 0.5)) once(cut, e, " in " + sig(c) + " by " + Math.round(right(e) - edge));
    }
    // Text wider than its own box (an unbroken word).
    if (e.clientWidth && e.scrollWidth > e.clientWidth + 1 && !clips(e) && ![...e.children].some((k) => k.clientWidth && k.scrollWidth > k.clientWidth + 1 && !clips(k))) once(spill, e, " by " + (e.scrollWidth - e.clientWidth));
  }
  for (const e of document.querySelectorAll("button:not(.link), label.toggle")) if (shown(e) && e.getBoundingClientRect().height < 23.5) once(small, e, " " + Math.round(e.getBoundingClientRect().height) + " px tall");
  const cols = Object.fromEntries([...document.querySelectorAll(".column")].map((c) => { const r = c.getBoundingClientRect(); return [c.querySelector("h3").dataset.status, { left: Math.round(r.left), top: Math.round(r.top), bottom: Math.round(r.bottom) }]; }));
  return { innerWidth, vw, cols, scrollWidth: document.documentElement.scrollWidth, cards: document.querySelectorAll(".card").length, chips: document.querySelectorAll(".chip").length, past, cut, spill, small };
})()`;

test("webview: from 180 px to 1400 px nothing scrolls sideways, is cut at a card's edge or spills out of its box, and Review sits under Needs input until five columns fit", { timeout: 120_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview check was not run."); return; }
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-responsive-webview-"));
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`The browser could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading in the harness");
    for (const open of [false, true]) {
      for (const width of [180, 283, 520, 900, 1400]) {
        await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await page.evaluate(`window.__host(${JSON.stringify(state)}); true`);
        await cdp.waitFor(() => page.evaluate(`innerWidth === ${width} && document.querySelectorAll(".card").length >= 6`), `the board drawn at ${width} px`);
        if (open) await page.evaluate(`for (const d of document.querySelectorAll("details")) d.open = true; true`);
        const seen = await page.evaluate(MEASURE);
        const where = `at ${width} px with every section ${open ? "open" : "as drawn"}`;
        assert.ok(seen.cards >= 6 && seen.chips >= 10, `the sample board was not drawn ${where}: ${seen.cards} cards, ${seen.chips} chips`);
        assert.ok(seen.scrollWidth <= seen.vw, `the board scrolls sideways ${where}: ${seen.scrollWidth} in ${seen.vw}; past the edge: ${seen.past.join("; ")}`);
        assert.deepEqual(seen.past, [], `past the panel's right edge ${where}`);
        assert.deepEqual(seen.cut, [], `cut off at a card's edge ${where}`);
        assert.deepEqual(seen.spill, [], `text wider than its box ${where}`);
        assert.deepEqual(seen.small, [], `buttons or toggles under 24 px ${where}`);
        // Where the columns sit: one under the other in a side bar; three stacks in between (Queued over Running, Needs input over
        // Review, Done), so Review starts right under Needs input and not below the tall Running column; five across at full width.
        const c = seen.cols, order = ["queued", "running", "needs-input", "review", "done"], under = (a, b) => c[a].left === c[b].left && c[a].top - c[b].bottom >= 0 && c[a].top - c[b].bottom <= 9; // the 8 px gap
        const placed = `${where}: ${JSON.stringify(c)}`;
        if (width <= 283) assert.ok(order.slice(1).every((key, i) => under(key, order[i])), `one column, in order, ${placed}`);
        else if (width <= 900) {
          assert.ok(under("running", "queued") && under("review", "needs-input"), `Running under Queued and Review under Needs input ${placed}`);
          assert.ok(c["needs-input"].left > c.queued.left && c["needs-input"].top === c.queued.top, `the second stack beside the first ${placed}`);
          assert.ok(c.review.top < c.running.bottom, `Review does not wait for the Running column to end ${placed}`);
        } else assert.ok(order.every((key, i) => c[key].top === c.queued.top && (i === 0 || c[key].left > c[order[i - 1]].left)), `five columns side by side ${placed}`);
      }
    }
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* a temp folder */ }
  }
});
