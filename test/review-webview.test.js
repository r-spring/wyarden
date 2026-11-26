// The real media/board.js in headless Edge or Chrome: the Review button, the verdict chip, the findings and the prompt for the session (F97).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");
const cdp = require("./compile-webview-cdp");

const now = new Date().toISOString();
const base = (id, extra) => ({ id, title: id, prompt: "p", status: "review", createdAt: now, updatedAt: now, completion: { doneWhen: "Tests pass.", commands: [] }, ...extra });
const review = (extra) => ({ findings: [], other: [], explanation: "x", verdict: "not-done", prompt: "Fix the subtract test.\nThen rerun.", questions: [], file: "/x/r.md", model: "fable", effort: "medium", at: now, receipt: "r1", ...extra });

async function withBoard(t, tasks, body) {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview check was not run."); return; }
  const url = pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-review-webview-"));
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`The browser could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading in the harness");
    await page.evaluate(`window.__host(${JSON.stringify({ tasks, live: [], own: [], accounts: ["acct"] })}); true`);
    await body(page);
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* a temp folder */ }
  }
}
const ev = (page, js) => page.evaluate(js);
const panel = (id) => `document.querySelector('[data-task="${id}"] .completion details.rules')`;
const clickIn = (page, id, label) => ev(page, `[...document.querySelectorAll('[data-task="${id}"] button')].find((b) => b.textContent === ${JSON.stringify(label)}).click(); true`);
const posted = (page, type) => ev(page, `window.__posted.filter((m) => m.type === ${JSON.stringify(type)})`);

// Run button messages through the compiled handler. The editor stand-in reads each real fixture file
// before recording its displayed URI, so a missing file cannot count as an open tab.
function reviewHost(t, tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-documents-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opened = [];
  const vscode = {
    Uri: { file: pathToFileURL },
    workspace: { openTextDocument: async uri => ({ uri, text: await fs.promises.readFile(uri, "utf8") }) },
    window: { showTextDocument: async doc => opened.push(doc.uri.href) },
  };
  const filename = require.resolve("../out/extension.js");
  const extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = name => name === "vscode" ? vscode : name.startsWith("./") ? {} : require(name);
  extension._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.receive = handle;", filename);
  const board = { get: id => tasks.find(task => task.id === id) };
  function write(name) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, name);
    return file;
  }
  return { opened, receive: message => extension.exports.receive(board, message), write };
}

test("webview: a Not done review shows its chip, the prompt in the dropdown, Accept prompt and Open findings", { timeout: 60_000 }, async (t) => {
  const findings = "1. Tests pass: Not met. npm test fails.";
  const a = base("n1", { reviewFindings: findings, doneReview: review() });
  const b = base("n2", { reviewFindings: findings, doneReview: review({ sent: "copied" }) });
  await withBoard(t, [a, b], async (page) => {
    const seen = await cdp.waitFor(() => ev(page, `(() => { const c = document.querySelector('[data-task="n1"]'); const d = c && c.querySelector(".completion details.rules"); return d && {
      chip: c.querySelector(".chip.verdict-not-done")?.textContent, open: d.open, summary: d.querySelector("summary").textContent,
      boxes: [...d.querySelectorAll("textarea")].map((x) => x.value), buttons: [...d.querySelectorAll("button")].map((x) => x.textContent) }; })()`), "the review panel");
    assert.deepEqual(seen, { chip: "Not done", open: true, summary: "Review: Not done", boxes: [findings, "Fix the subtract test.\nThen rerun."], buttons: ["Accept prompt", "Open findings"] });
    await clickIn(page, "n1", "Accept prompt");
    assert.deepEqual(await posted(page, "acceptReview"), [{ type: "acceptReview", id: "n1" }]);
    const copied = await ev(page, `(() => { const d = ${panel("n2")}; return { text: d.textContent, buttons: [...d.querySelectorAll("button")].map((x) => x.textContent) }; })()`);
    assert.ok(copied.text.includes("On the clipboard: paste it into the session."));
    assert.deepEqual(copied.buttons, ["Open findings"]);
  });
});

test("webview: Unsure shows each question pre-filled with its suggested answer; Send answers posts the answers", { timeout: 60_000 }, async (t) => {
  const r = review({ verdict: "unsure", prompt: "", questions: [{ question: "Is X needed?", suggested: "Yes" }, { question: "Which port?", suggested: "" }] });
  await withBoard(t, [base("u1", { reviewFindings: "1. A: Cannot tell.", doneReview: r })], async (page) => {
    await cdp.waitFor(() => ev(page, `!!${panel("u1")}`), "the review panel");
    assert.equal(await ev(page, `${panel("u1")}.querySelector("summary").textContent`), "Review: Unsure");
    assert.deepEqual(await ev(page, `[...${panel("u1")}.querySelectorAll("textarea:not([readonly])")].map((x) => x.value)`), ["Yes", ""]);
    await clickIn(page, "u1", "Send answers");
    assert.deepEqual(await posted(page, "reviewWork"), [{ type: "reviewWork", id: "u1", answers: "Is X needed?\nYes\n\nWhich port?\nUnanswered; preserve ambiguity." }]);
  });
});

// the user, 11 November 2026 (card abd489): the session ran again after an Unsure review, and Send answers then failed with
// "Entomatical: Review works on a card in Review." Now the button waits, with the host's reason, and the answers stay editable.
test("webview: Send answers is off with the host's reason while the card cannot be reviewed, and the answers stay editable", { timeout: 60_000 }, async (t) => {
  const r = review({ verdict: "unsure", prompt: "", receipt: "r3", questions: [{ question: "Is X needed?", suggested: "Yes" }] });
  const card = (extra) => base("u3", { reviewFindings: "1. A: Cannot tell.", doneReview: r, ...extra });
  const blocked = card({ status: "running", reviewBlocked: "Review works on a card in Review." });
  await withBoard(t, [blocked], async (page) => {
    const read = () => ev(page, `(() => { const d = ${panel("u3")}; const b = [...d.querySelectorAll("button")].find((x) => x.textContent === "Send answers");
      return { disabled: b.disabled, note: [...d.querySelectorAll(".muted")].map((x) => x.textContent), editable: [...d.querySelectorAll("textarea:not([readonly])")].map((x) => x.value) }; })()`);
    await cdp.waitFor(() => ev(page, `!!${panel("u3")}`), "the review panel");
    assert.deepEqual(await read(), { disabled: true, note: ["Send answers is off: Review works on a card in Review. Your answers are kept."], editable: ["Yes"] });
    await ev(page, `(() => { const b = ${panel("u3")}.querySelector("textarea:not([readonly])"); b.value = "No"; b.dispatchEvent(new Event("input")); return true; })()`);
    await clickIn(page, "u3", "Send answers");
    assert.deepEqual(await posted(page, "reviewWork"), [], "a disabled button posts nothing");
    // Back in Review: the button works and sends what was typed while it waited.
    await ev(page, `window.__host(${JSON.stringify({ tasks: [card({})], live: [], own: [], accounts: ["acct"] })}); true`);
    assert.deepEqual(await read(), { disabled: false, note: [], editable: ["No"] });
    await clickIn(page, "u3", "Send answers");
    assert.deepEqual(await posted(page, "reviewWork"), [{ type: "reviewWork", id: "u3", answers: "Is X needed?\nNo" }]);
  });
});

test("webview: typed answers stay with their review: a redraw keeps them, a newer Unsure review shows its own suggested answers", { timeout: 60_000 }, async (t) => {
  const first = review({ verdict: "unsure", prompt: "", questions: [{ question: "Is X needed?", suggested: "Yes" }] });
  const card = (r) => base("u2", { reviewFindings: "1. A: Cannot tell.", doneReview: r });
  await withBoard(t, [card(first)], async (page) => {
    const boxes = () => ev(page, `[...${panel("u2")}.querySelectorAll("textarea:not([readonly])")].map((x) => x.value)`);
    const redraw = (r) => ev(page, `window.__host(${JSON.stringify({ tasks: [card(r)], live: [], own: [], accounts: ["acct"] })}); true`);
    await cdp.waitFor(() => ev(page, `!!${panel("u2")}`), "the review panel");
    await ev(page, `(() => { const b = ${panel("u2")}.querySelector("textarea:not([readonly])"); b.value = "Only on Linux"; b.dispatchEvent(new Event("input")); return true; })()`);
    await redraw(first);
    assert.deepEqual(await boxes(), ["Only on Linux"], "the same review keeps what was typed");
    await redraw(review({ verdict: "unsure", prompt: "", receipt: "r2", questions: [{ question: "Which port?", suggested: "8080" }, { question: "Which OS?", suggested: "" }] }));
    assert.deepEqual(await boxes(), ["8080", ""]);
  });
});

// 993639e added a second top-level reviewView; the later declaration replaced Review Prompt (Experimental)'s result view.
test("board.js declares each top-level function once", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "media", "board.js"), "utf8");
  const names = [...source.matchAll(/^(?:async\s+)?function\*?\s*([\w$]+)\s*\(/gm)].map((m) => m[1]);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
  assert.ok(names.includes("reviewView") && names.includes("doneReviewView"));
});

test("webview: Review Prompt (Experimental) shows its own result, and a card with a Done review keeps its Review dropdown", { timeout: 60_000 }, async (t) => {
  await withBoard(t, [base("d2", { reviewFindings: "1. Tests pass: Not met.", doneReview: review() })], async (page) => {
    await cdp.waitFor(() => ev(page, `!!${panel("d2")}`), "the card's review dropdown");
    const view = () => ev(page, `(() => { const v = document.querySelector('[data-refine-target="new"] .compilation'); return v && { status: v.querySelector('[role="status"]')?.textContent,
      boxes: [...v.querySelectorAll("textarea")].map((x) => x.value), summaries: [...v.querySelectorAll("summary")].map((x) => x.textContent), buttons: [...v.querySelectorAll("button")].map((x) => x.textContent) }; })()`);
    await ev(page, `(() => { const b = document.querySelector('textarea[data-draft-target="new"]'); b.value = "Explain the test."; b.dispatchEvent(new Event("input")); return true; })()`);
    await ev(page, `window.__host({ cardAction: { type: "reviewPrompt", id: "new" } }); true`);
    const [asked] = await posted(page, "reviewPrompt");
    assert.equal(asked.draft, "Explain the test.");
    assert.equal((await view())?.status, "Terra and Sol are improving the prompt…");
    const result = { attempts: [{ label: "Terra", model: "gpt-6.1-terra", effort: "max", status: "ready", format: "prose", prompt: "Explain it." }],
      review: { overview: "Terra kept the goal.", attempts: [], comparison: "", takeaways: [], model: "gpt-6-astra", effort: "ultra", elapsedMs: 5 } };
    await ev(page, `window.__host(${JSON.stringify({ compilation: { requestId: asked.requestId, target: "new", original: "Explain the test.", ...result } })}); true`);
    assert.deepEqual(await view(), { status: "Review by gpt-6-astra · ultra effort", boxes: ["Terra kept the goal.", "Explain it."],
      summaries: ["Terra attempt (gpt-6.1-terra · max effort)"], buttons: ["Dismiss review"] });
    assert.equal(await ev(page, `${panel("d2")}.querySelector("summary").textContent`), "Review: Not done");
  });
});

test("webview: a running review shows Reviewing… with Show progress and Cancel review; a failed one Dismiss and Show log (F103)", { timeout: 60_000 }, async (t) => {
  const run = base("r1", { doneReviewRun: { requestId: "q1", at: now, model: "fable", effort: "medium" } });
  const bad = base("r2", { doneReviewRun: { requestId: "q2", at: now, model: "fable", effort: "medium", error: "The window closed mid-review." } });
  const dflt = base("r3", { doneReviewRun: { requestId: "q3", at: now, model: "", effort: "" } });
  await withBoard(t, [run, bad, dflt], async (page) => {
    const read = (id) => ev(page, `(() => { const c = [...document.querySelectorAll('[data-task="${id}"] .completion')].at(-1); return c && { text: c.firstChild.textContent, buttons: [...c.querySelectorAll("button")].map((x) => x.textContent) }; })()`);
    assert.deepEqual(await cdp.waitFor(() => read("r1"), "the running card"), { text: "Reviewing… (fable · medium effort)", buttons: ["Show progress", "Cancel review"] });
    assert.equal((await read("r3")).text, "Reviewing… (the agent's default model)");
    assert.deepEqual(await read("r2"), { text: "The window closed mid-review.", buttons: ["Dismiss", "Show log"] });
    await clickIn(page, "r1", "Show progress"); await clickIn(page, "r1", "Cancel review"); await clickIn(page, "r2", "Show log"); await clickIn(page, "r2", "Dismiss");
    assert.deepEqual(await posted(page, "showErrorLog"), [{ type: "showErrorLog", id: "r2" }]);
    assert.deepEqual(await posted(page, "showHelper"), [{ type: "showHelper", requestId: "q1" }]);
    assert.deepEqual(await posted(page, "cancelReview"), [{ type: "cancelReview", id: "r1" }]);
    assert.deepEqual(await posted(page, "dismissReview"), [{ type: "dismissReview", id: "r2" }]);
  });
});

test("webview: Review shows only on a reviewable card", { timeout: 60_000 }, async (t) => {
  await withBoard(t, [base("v1", { reviewable: true }), base("v2", { reviewable: false })], async (page) => {
    const has = (id) => ev(page, `[...document.querySelectorAll('[data-task="${id}"] button')].some((b) => b.textContent === "Review")`);
    await cdp.waitFor(() => has("v1"), "the Review button");
    assert.equal(await has("v2"), false);
    await clickIn(page, "v1", "Review");
    assert.deepEqual(await posted(page, "reviewWork"), [{ type: "reviewWork", id: "v1" }]);
  });
});

test("webview: a Done review shows the green Done chip and its findings, with no Accept prompt", { timeout: 60_000 }, async (t) => {
  await withBoard(t, [base("d1", { reviewFindings: "1. Tests pass: Met.", doneReview: review({ verdict: "done", prompt: "" }) }),
    base("d2", { reviewFindings: "1. Tests pass: Met.", doneReview: review({ verdict: "done", prompt: "", workedAfter: true }) })], async (page) => {
    const seen = await cdp.waitFor(() => ev(page, `(() => { const c = document.querySelector('[data-task="d1"]'); const d = c && c.querySelector(".completion details.rules"); return d && {
      chip: c.querySelector(".chip.verdict-done")?.textContent, open: d.open, summary: d.querySelector("summary").textContent,
      boxes: [...d.querySelectorAll("textarea")].map((x) => x.value), buttons: [...d.querySelectorAll("button")].map((x) => x.textContent) }; })()`), "the review panel");
    assert.deepEqual(seen, { chip: "Done", open: false, summary: "Review: Done", boxes: ["1. Tests pass: Met."], buttons: ["Open findings"] });
    // A Done the card has worked past says so (workedAfter).
    assert.equal(await ev(page, `document.querySelector('[data-task="d2"] .chip.verdict-done').textContent`), "Done, worked since");
  });
});

test("webview: an orchestrator's self-finish shows Finishing: with its step and error (and Show log, F103) while it asks, and Open report once finished", { timeout: 60_000 }, async (t) => {
  const none = { completion: undefined }; // no Done when panel: the self-finish line is the card's only .completion
  const stopped = base("s1", { ...none, finishAsked: { at: now }, selfFinish: { step: "Pushing to origin/main", error: "Finish stopped while pushing to origin/main: no network." } });
  const finished = base("s2", { ...none, status: "done", selfFinish: { report: "/x/reports/s2.md" } });
  const old = base("s3", { ...none, selfFinish: { step: "Reviewing the run" } }); // its request was answered (Accept prompt cleared it)
  await withBoard(t, [stopped, finished, old], async (page) => {
    const read = (id) => ev(page, `(() => { const c = document.querySelector('[data-task="${id}"] .completion'); return c && { text: [...c.children].filter((x) => x.tagName === "DIV").map((x) => x.textContent), buttons: [...c.querySelectorAll("button")].map((x) => x.textContent) }; })()`);
    assert.deepEqual(await cdp.waitFor(() => read("s1"), "the self-finish line"), { text: ["Finishing: Pushing to origin/main", "Finish stopped while pushing to origin/main: no network."], buttons: ["Show log"] });
    assert.deepEqual(await read("s2"), { text: [], buttons: ["Open report"] });
    assert.equal(await read("s3"), null);
    await clickIn(page, "s2", "Open report"); await clickIn(page, "s1", "Show log");
    assert.deepEqual(await posted(page, "openReview"), [{ type: "openReview", id: "s2", kind: "report" }]);
    assert.deepEqual(await posted(page, "showErrorLog"), [{ type: "showErrorLog", id: "s1" }]);
  });
});

test("Open report and Open findings display the selected card's distinct document URIs across reviews", { timeout: 60_000 }, async t => {
  const card = base("dual", { reviewFindings: "Tests failed." });
  const tasks = [base("other", { doneReview: review() }), card];
  const host = reviewHost(t, tasks);
  const report = host.write("Finish report.md"), first = host.write("first findings.md"), newer = host.write("new findings.md");
  card.selfFinish = { report };
  card.doneReview = review({ file: first });
  await withBoard(t, tasks, async page => {
    await cdp.waitFor(() => ev(page, `!!${panel(card.id)}`), "the selected card's review");
    const open = async label => {
      await clickIn(page, card.id, label);
      const message = (await posted(page, "openReview")).at(-1);
      await host.receive(message);
    };
    await open("Open report");
    await open("Open findings");
    assert.deepEqual(host.opened, [report, first].map(file => pathToFileURL(file).href));
    card.doneReview = review({ receipt: "r2", file: newer });
    await ev(page, `window.__host(${JSON.stringify({ tasks, live: [], own: [], accounts: ["acct"] })}); true`);
    await open("Open findings");
    await open("Open report");
    assert.deepEqual(host.opened.slice(2), [newer, report].map(file => pathToFileURL(file).href));
  });
});

test("openReview keeps legacy selection and reports absent records or files without substituting the other document", async t => {
  const card = base("dual", {});
  const host = reviewHost(t, [card]);
  const report = host.write("report.md"), findings = host.write("findings.md");
  const message = { type: "openReview", id: card.id };
  card.doneReview = review({ file: findings });
  await host.receive(message);
  await assert.rejects(host.receive({ ...message, kind: "report" }), /no saved Finish report/);
  card.selfFinish = { report };
  await host.receive(message);
  fs.unlinkSync(findings);
  await assert.rejects(host.receive({ ...message, kind: "findings" }), { code: "ENOENT" });
  delete card.doneReview;
  await assert.rejects(host.receive({ ...message, kind: "findings" }), /no saved review findings/);
  await assert.rejects(host.receive({ ...message, id: "removed" }), /card is no longer available/);
  await assert.rejects(host.receive({ ...message, kind: "unknown" }), /Unknown review document/);
  assert.deepEqual(host.opened, [findings, report].map(file => pathToFileURL(file).href));
});

test("webview: the recovered review replaces both progress messages and offers an explicit Review retry", { timeout: 60_000 }, async (t) => {
  const { canReview, recoverReview } = require("../out/done-review.js");
  const card = base("cut", { worktree: "/wt/cut", finishAsked: { at: now }, selfFinish: { step: "Reviewing the run" },
    doneReviewRun: { requestId: "r1", at: now, model: "fable", effort: "medium" } });
  await withBoard(t, [card], async (page) => {
    const text = () => ev(page, `document.querySelector('[data-task="cut"]')?.textContent`);
    await cdp.waitFor(async () => (await text())?.includes("Finishing: Reviewing the run"), "the original Finish step");
    assert.match(await text(), /Reviewing…/);
    recoverReview({ completing: new Set(), isOwner: () => true, update: Object.assign }, card, false);
    card.reviewable = !canReview(card, [card]);
    await ev(page, `window.__host(${JSON.stringify({ tasks: [card], live: [], own: [], accounts: ["acct"] })}); true`);
    const repaired = await text();
    assert.doesNotMatch(repaired, /Finishing:|Reviewing…|Cancel review/);
    assert.match(repaired, /Automatic finish was interrupted\. Press Review to retry\./);
    assert.match(repaired, /The review was interrupted when the window closed\./);
    assert.deepEqual(await posted(page, "reviewWork"), []);
    await clickIn(page, "cut", "Review");
    assert.deepEqual(await posted(page, "reviewWork"), [{ type: "reviewWork", id: "cut" }]);
  });
});
