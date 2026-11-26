// Refine draft, Improve prompt and Review prompt in their own editor tab (src/helper-tab.ts), and the live output behind it:
// streamed Claude events and Codex reasoning summaries (src/worker.ts), the packet sent (src/text-actions.ts).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

// A stand-in for the VS Code API with just what the tab touches; every created panel is recorded.
function fakeVscode() {
  const panels = [];
  const vscode = {
    Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join("/") }) },
    ViewColumn: { Beside: -2, One: 1 },
    window: {
      createWebviewPanel(viewType, title, show, options) {
        const listeners = { message: [], dispose: [] };
        const panel = { viewType, title, show, options, visible: true, posted: [], reveals: [],
          webview: { cspSource: "csp", html: "", asWebviewUri: (u) => u.path, postMessage: async (m) => { panel.posted.push(JSON.parse(JSON.stringify(m))); return true; },
            onDidReceiveMessage: (cb) => { listeners.message.push(cb); return { dispose() {} }; } },
          onDidDispose: (cb) => { listeners.dispose.push(cb); return { dispose() {} }; },
          reveal: (column, preserveFocus) => panel.reveals.push({ column, preserveFocus }),
          receive: (m) => listeners.message.forEach((cb) => cb(m)),
          dispose: () => listeners.dispose.forEach((cb) => cb()) };
        panels.push(panel); return panel;
      },
    },
  };
  return { vscode, panels };
}
/** An out/ module with the fake vscode, its own relative requires (./readonly-docs) loaded the same way. */
function loadModule(vscode, name = "helper-tab") {
  const file = require.resolve(`../out/${name}.js`), m = new Module(file, module);
  const cache = loadModule.cache.get(vscode) ?? new Map(); loadModule.cache.set(vscode, cache);
  m.filename = file; m.require = (n) => (n === "vscode" ? vscode : n.startsWith("./") ? (cache.get(n) ?? cache.set(n, loadModule(vscode, n.slice(2))).get(n)) : require(n));
  m._compile(fs.readFileSync(file, "utf8"), file);
  return m.exports;
}
loadModule.cache = new WeakMap();
const run = (requestId, extra = {}) => ({ requestId, kind: "refine", target: "new", title: "Refine draft", detail: "opus · high effort · me", draft: "Fix the bug", answers: "",
  cancel: () => {}, ...extra });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("the tab opens beside the board without taking focus; streamed thinking and answer arrive batched, the result at once", async () => {
  const { vscode, panels } = fakeVscode();
  const { HelperTabs } = loadModule(vscode);
  const tabs = new HelperTabs({ path: "/ext" });
  const h = tabs.start("1:new:refine", run("r1"));
  assert.equal(panels.length, 1);
  assert.deepEqual(panels[0].show, { viewColumn: -2, preserveFocus: true }, "beside the board, focus stays on the board");
  assert.equal(panels[0].options.retainContextWhenHidden, undefined, "not kept alive while hidden: it reloads and asks for the run (F19-6)");
  assert.match(panels[0].webview.html, /helper-tab\.js/);
  assert.match(panels[0].webview.html, /script-src 'nonce-/);
  h.prompt("PROMPT TEXT"); h.line("Claude opus started.");
  const before = panels[0].posted.length;
  h.line("Let me ", "thinking"); h.line("think.", "thinking"); h.line('{"kind":', "answer"); h.line('"revision"}', "answer");
  assert.equal(panels[0].posted.length, before, "streamed text waits for the batch");
  await wait(250);
  assert.equal(panels[0].posted.length, before + 1, "one post for the whole batch");
  assert.deepEqual(panels[0].posted.at(-1).append, [{ i: 0, source: "", stream: "thinking", text: "Let me think." }, { i: 1, source: "", stream: "answer", text: '{"kind":"revision"}' }]);
  assert.equal(panels[0].posted.at(-1).run.segments, undefined, "a batch carries only what was appended");
  h.line(" Done.", "answer");
  await wait(250);
  assert.deepEqual(panels[0].posted.at(-1).append, [{ i: 1, source: "", stream: "answer", text: " Done." }], "the second batch: only the appended text");
  h.line("More thought", "thinking"); // thinking again after the answer started: a new segment
  h.finish({ text: "Goal: fixed.", notes: ["Assumption: A"] }, "claude-opus-5-5");
  const last = panels[0].posted.at(-1).run;
  assert.equal(last.status, "done");
  assert.equal(last.segments.length, 3, "finish posts at once, with the batched text");
  assert.equal(last.prompt, "PROMPT TEXT");
  assert.deepEqual(last.log.map((l) => l.text), ["Claude opus started."]);
  assert.deepEqual(last.result, { text: "Goal: fixed.", notes: ["Assumption: A"] });
  assert.equal("cancel" in last, false, "the cancel function stays in the host");
  // Log times use the machine's zone, not the webview's (an hour behind on Windows, 5 November 2026).
  // This test's own lookup can miss where the helper's did not: on Windows it may fall back to `tzutil /g`, which can pass its 2 s limit
  // while the whole suite runs (6 November 2026: the helper posted America/Vancouver, this lookup returned undefined).
  // The reverse also happens (12 November 2026: the helper's lookup timed out, this one returned America/Vancouver), so a miss on
  // either side is allowed; when both found a zone they agree.
  const expectedZone = require("../out/local-time.js").localTimeZone();
  const posted = panels[0].posted.at(-1).hostTimezone;
  if (expectedZone !== undefined && posted !== undefined) assert.equal(posted, expectedZone);
  assert.ok(posted === undefined || typeof posted === "string");
  h.line("late", "answer"); h.line("late line");
  await wait(250);
  assert.equal(panels[0].posted.at(-1).run.segments.length, 3, "nothing is added after the run ended");
});

test("a segment cut at its limit is sent whole again; a full post resets what the tab has (audit finding 13)", async () => {
  const { vscode, panels } = fakeVscode();
  const { HelperTabs } = loadModule(vscode);
  const h = new HelperTabs({ path: "/ext" }).start("1:new:refine", run("r1"));
  panels[0].receive({ type: "ready" }); // the page loaded and asked for the run
  h.line("a".repeat(119_990), "answer");
  await wait(250);
  assert.equal(panels[0].posted.at(-1).append[0].text.length, 119_990);
  h.line("b".repeat(20), "answer"); // past 120,000 characters: the front is cut, so the tab's copy no longer leads it
  await wait(250);
  const cut = panels[0].posted.at(-1);
  assert.equal(cut.append, undefined);
  assert.equal(cut.run.segments[0].text, "a".repeat(119_980) + "b".repeat(20), "the whole segment, as the host now holds it");
  panels[0].receive({ type: "ready" }); // the tab reloaded: a full post
  h.line("c", "answer");
  await wait(250);
  assert.equal(panels[0].posted.at(-1).run.segments[0].text, "a".repeat(119_979) + "b".repeat(20) + "c", "still cut: whole again");
});

test("the 120,000-character window keeps the latest output across models and stream changes", async () => {
  const { vscode, panels } = fakeVscode();
  const { HelperTabs } = loadModule(vscode);
  const h = new HelperTabs({ path: "/ext" }).start("1:new:review", run("r1"));
  const a = h.output("A"), b = h.output("B"), panel = panels[0];
  a("a".repeat(80_000), "thinking");
  b("b".repeat(60_000), "answer");
  a("c".repeat(30_000), "thinking");
  panel.receive({ type: "ready" });
  assert.deepEqual(panel.posted.at(-1).run.segments, [
    { source: "A", stream: "thinking", text: "a".repeat(30_000) + "c".repeat(30_000) },
    { source: "B", stream: "answer", text: "b".repeat(60_000) },
  ]);
  // Same text as the old prefix, but now it belongs to another model and stream.
  b("a".repeat(120_100), "thinking");
  await wait(250);
  const cut = panel.posted.at(-1);
  assert.equal(cut.append, undefined);
  assert.deepEqual(cut.run.segments, [{ source: "B", stream: "thinking", text: "a".repeat(120_000) }]);
  b("", "answer");
  a("x", "answer");
  h.finish({ text: "complete", notes: [] });
  assert.deepEqual(panel.posted.at(-1).run.segments, [
    { source: "B", stream: "thinking", text: "a".repeat(119_999) },
    { source: "A", stream: "answer", text: "x" },
  ]);
});

test("Review prompt's models each get their own output, named; stages show in the status and the log", () => {
  const { vscode, panels } = fakeVscode();
  const { HelperTabs } = loadModule(vscode);
  const h = new HelperTabs({ path: "/ext" }).start("1:new:review", run("r1", { kind: "review", title: "Review prompt" }));
  h.stage("Terra and Sol are improving the prompt…");
  const terra = h.output("Terra (gpt-6.1-terra)"), sol = h.output("Sol (gpt-6.1-sol)");
  terra("T thinks", "thinking"); sol("S thinks", "thinking"); terra(" more", "thinking"); sol("started.");
  h.finish({ text: "Review", notes: [] }, "gpt-6-astra");
  const last = panels[0].posted.at(-1).run;
  assert.equal(last.stage, "Terra and Sol are improving the prompt…");
  assert.deepEqual(last.segments, [{ source: "Terra (gpt-6.1-terra)", stream: "thinking", text: "T thinks more" }, { source: "Sol (gpt-6.1-sol)", stream: "thinking", text: "S thinks" }]);
  assert.deepEqual(last.log.map((l) => l.text), ["Terra and Sol are improving the prompt…", "Sol (gpt-6.1-sol): started."]);
});

test("a new run of the same box and button reuses its tab, and the earlier run can no longer write to it", () => {
  const { vscode, panels } = fakeVscode();
  const { HelperTabs } = loadModule(vscode);
  const tabs = new HelperTabs({ path: "/ext" });
  const first = tabs.start("1:new:refine", run("r1"));
  first.fail("Text generation cancelled or timed out.", true);
  assert.equal(panels[0].posted.at(-1).run.status, "cancelled");
  const second = tabs.start("1:new:refine", run("r2", { answers: "Q\nA" }));
  assert.equal(panels.length, 1, "one tab per draft box and button");
  first.line("stale"); first.finish({ text: "x", notes: [] }, "x");
  assert.equal(panels[0].posted.at(-1).run.requestId, "r2");
  assert.equal(panels[0].posted.at(-1).run.status, "running");
  second.fail("Claude stopped (exit 1): no reason", false);
  assert.equal(panels[0].posted.at(-1).run.status, "failed");
  tabs.start("1:new:improve", run("r3", { kind: "improve", title: "Improve prompt" }));
  tabs.start("1:task-a:refine", run("r4", { target: "task-a", title: "Refine: Task A" }));
  assert.equal(panels.length, 3, "Improve and another box each get their own tab");
  assert.deepEqual(panels.map((p) => p.title), ["Refine draft", "Improve prompt", "Refine: Task A"]);
});

test("Open in editor shows a very long result, and everything sent, whole in an editor tab", async () => {
  const { vscode, panels } = fakeVscode();
  const docs = [], shown = [];
  // Read-only documents since 4 November 2026 (src/readonly-docs.ts): the URI names its text; nothing asks to be saved on close.
  vscode.Uri.from = (c) => ({ ...c });
  // The fake must be complete before the module loads: TypeScript copies vscode's properties at load time.
  let readonly;
  vscode.workspace = { openTextDocument: async (uri) => { docs.push({ content: readonly.readOnlyText(uri), scheme: uri.scheme }); return uri; } };
  vscode.window.showTextDocument = async (d, o) => { shown.push(o); };
  readonly = loadModule(vscode, "readonly-docs");
  loadModule.cache.get(vscode).set("./readonly-docs", readonly); // the tab's own lazy require gets this same instance
  const { HelperTabs } = loadModule(vscode);
  const h = new HelperTabs({ path: "/ext" }).start("1:new:improve", run("r1", { kind: "improve", title: "Improve prompt", answers: "Q\nA" }));
  panels[0].receive({ type: "ready" });
  panels[0].receive({ requestId: "r1", type: "open", what: "result" });
  panels[0].receive({ requestId: "r1", type: "open", what: "sent" });
  await wait(0);
  assert.deepEqual(docs, [{ content: "Fix the bug\nCLARIFICATION ANSWERS:\nQ\nA", scheme: "entomatical-text" }], "no result yet: only what was sent opens, read-only");
  assert.equal(panels[0].posted.at(-1).run.sent, "Fix the bug\nCLARIFICATION ANSWERS:\nQ\nA", "the tab shows the same text");
  const long = `<task>${"x".repeat(200_000)}</task>`;
  h.prompt("P".repeat(150_000));
  h.finish({ text: long, notes: ["Note A"] }, "claude-opus-5-5");
  panels[0].receive({ requestId: "r1", type: "open", what: "result" });
  panels[0].receive({ requestId: "r1", type: "open", what: "sent" });
  await wait(0);
  assert.equal(docs[1].content, `${long}\n\nNote A`, "the whole result, not cut");
  assert.equal(docs[2].content.length, 150_000, "the exact packet sent, whole");
  assert.deepEqual(shown.at(-1), { preview: false });
});

test("closing the tab leaves the run going; Show progress reopens it, and the tab's Cancel stops it", () => {
  const { vscode, panels } = fakeVscode();
  const { HelperTabs } = loadModule(vscode);
  const tabs = new HelperTabs({ path: "/ext" });
  let cancelled = 0;
  const h = tabs.start("1:new:refine", run("r1", { cancel: () => cancelled++ }), 1);
  h.line("started");
  panels[0].dispose();
  h.line("still running");
  tabs.show("r1");
  assert.equal(panels.length, 2, "reopened");
  panels[1].receive({ type: "ready" });
  assert.deepEqual(panels[1].posted.at(-1).run.log.map((l) => l.text), ["started", "still running"], "the reopened tab has the whole log");
  tabs.show("r1");
  assert.deepEqual(panels[1].reveals.at(-1), { column: undefined, preserveFocus: false }, "an explicit Show focuses the tab");
  tabs.show("unknown-request");
  assert.equal(panels.length, 2);
  panels[1].receive({ requestId: "r1", type: "cancel" });
  assert.equal(cancelled, 1);
  h.fail("cancelled", true);
  panels[1].receive({ requestId: "r1", type: "cancel" });
  assert.equal(cancelled, 1, "a finished run is not cancelled again");
});

test("closing a board and helper in either order retires only their history", () => {
  const { vscode, panels } = fakeVscode();
  const { HelperTabs } = loadModule(vscode);
  const tabs = new HelperTabs({ path: "/ext" });
  const other = tabs.start("1:new:refine", run("other"), 1);
  other.prompt("kept by board 1");
  panels[0].dispose();
  for (let owner = 2; owner < 34; owner++) {
    const key = `${owner}:new:refine`, id = `r${owner}`;
    const h = tabs.start(key, run(id), owner), panel = panels.at(-1);
    h.prompt("the packet"); h.line("stream", "answer");
    h.finish({ text: "result", notes: [] });
    if (owner % 2) {
      tabs.releaseBoard(owner);
      panel.receive({ type: "ready" });
      assert.equal(panel.posted.at(-1).run.result.text, "result");
      assert.equal(panel.posted.at(-1).run.segments[0].text, "stream");
      panel.dispose();
    } else {
      panel.dispose();
      tabs.releaseBoard(owner);
    }
    tabs.show(id);
    assert.equal(panels.at(-1), panel, "a retired request cannot reopen");
    assert.deepEqual([...tabs.runs.keys()], ["1:new:refine"]);
    assert.deepEqual([...tabs.byRequest.keys()], ["other"]);
    assert.equal(tabs.panels.size + tabs.timers.size + tabs.shown.size, 0);
  }
  tabs.show("other");
  panels.at(-1).receive({ type: "ready" });
  assert.equal(panels.at(-1).posted.at(-1).run.prompt, "kept by board 1");
});

test("pending batches and delayed writes cannot reach a replacement or resurrect a retired run", async () => {
  const { vscode, panels } = fakeVscode();
  const { HelperTabs } = loadModule(vscode);
  const tabs = new HelperTabs({ path: "/ext" }), key = "1:new:refine";
  const old = tabs.start(key, run("old"), 1), panel = panels[0];
  old.line("queued old text", "thinking");
  assert.ok(tabs.timers.has(key));
  const second = tabs.start(key, run("new"), 1);
  assert.equal(tabs.timers.size, 0);
  const late = async () => {
    await wait(10);
    old.output("old model")("late text", "answer"); old.line("late activity"); old.prompt("late packet");
    old.stage("late stage"); old.finish({ text: "late result", notes: [] }); old.fail("late error", true);
  };
  second.line("current text", "answer");
  await late();
  await wait(200);
  panel.receive({ type: "ready" });
  const current = panel.posted.at(-1).run;
  assert.equal(current.requestId, "new");
  assert.equal(current.status, "running");
  assert.deepEqual(current.segments, [{ source: "", stream: "answer", text: "current text" }]);
  assert.deepEqual(current.log, []);
  assert.equal(current.prompt, undefined);
  assert.equal(current.stage, undefined);
  second.line("queued on close", "answer");
  tabs.releaseBoard(1);
  panel.dispose();
  assert.equal(tabs.timers.size, 0);
  await wait(200);
  second.line("late after disposal", "answer");
  assert.equal(tabs.runs.size + tabs.byRequest.size + tabs.shown.size + tabs.timers.size, 0);
});

// The actual helper page with local DOM/editor doubles. Keep each direction queued independently,
// so clicks and streamed batches can cross a request replacement in a deterministic order.
function helperPage(panel) {
  const posted = [], buttons = [];
  let receive;
  function element(tag) {
    const e = { classList: { add() {} }, dataset: {}, append() {}, after() {}, replaceChildren() {}, querySelectorAll: () => [] };
    if (tag === "button") buttons.push(e);
    return e;
  }
  const vm = require("node:vm");
  const context = vm.createContext({ document: { body: element("body"), createElement: element },
    window: { addEventListener: (_, callback) => { receive = callback; } }, setInterval() {},
    acquireVsCodeApi: () => ({ postMessage: message => posted.push(structuredClone(message)) }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../media/helper-tab.js"), "utf8"), context);
  panel.receive(posted.shift()); // ready
  return {
    display: (message = panel.posted.at(-1)) => receive({ data: structuredClone(message) }),
    click(label) { buttons.find(b => b.ariaLabel === label || b.textContent === label).onclick(); return posted.shift(); },
    segments: () => structuredClone(vm.runInContext("run.segments", context)),
  };
}

test("queued page controls and provider batches belong to the run displayed when they were sent", async () => {
  const { vscode, panels } = fakeVscode(), opened = [], cancelled = [];
  const { HelperTabs } = loadModule(vscode);
  loadModule.cache.get(vscode).set("./readonly-docs", { showReadOnly: (_, content) => opened.push(content) });
  const tabs = new HelperTabs({ path: "/ext" }), key = "1:new:refine";
  const start = id => tabs.start(key, run(id, { draft: id + " draft", cancel: () => cancelled.push(id) }), 1);
  const sent = "Open everything that was sent in an editor tab", result = "Open the whole result in an editor tab";
  const a = start("A"), panel = panels[0], page = helperPage(panel);
  page.display();
  const staleCancel = page.click("Cancel"), staleSent = page.click(sent);
  a.line("A text", "answer");
  await wait(200);
  const staleBatch = panel.posted.at(-1);
  assert.equal(staleBatch.partial, true);

  const b = start("B");
  panel.receive(staleCancel); panel.receive(staleSent);
  assert.deepEqual({ cancelled, opened }, { cancelled: ["A"], opened: [] }, "A's queued clicks must leave B alone");
  panel.receive({ type: "cancel" }); panel.receive({ type: "open", what: "sent" });
  assert.deepEqual({ cancelled, opened }, { cancelled: ["A"], opened: [] }, "actions without a request ID are ignored");
  page.display();
  b.line("B text", "answer");
  await wait(200);
  page.display(); page.display(staleBatch);
  assert.deepEqual(page.segments(), [{ source: "", stream: "answer", text: "B text" }]);
  panel.receive(page.click("Cancel"));
  panel.receive(page.click(sent));
  assert.deepEqual(cancelled, ["A", "B"]);
  assert.deepEqual(opened, ["B draft"]);

  b.finish({ text: "B result", notes: [] }); page.display();
  const staleResult = page.click(result);
  const c = start("C");
  c.finish({ text: "C result", notes: [] });
  panel.receive(staleResult);
  assert.deepEqual(opened, ["B draft"], "a queued Open result cannot read C's result");
  page.display();
  const fromClosedPanel = page.click(result);
  panel.dispose(); tabs.show("C");
  const reopened = panels[1], newPage = helperPage(reopened);
  newPage.display(); panel.receive(fromClosedPanel);
  reopened.receive(newPage.click(sent)); reopened.receive(newPage.click(result));
  assert.deepEqual(opened, ["B draft", "C draft", "C result"]);
  reopened.dispose(); tabs.releaseBoard(1);
  assert.equal(tabs.runs.size, 0);
});

test("provider activity, stages and failures retain bounded diagnostics", () => {
  const { vscode, panels } = fakeVscode();
  const { HelperTabs } = loadModule(vscode);
  const tabs = new HelperTabs({ path: "/ext" }), h = tabs.start("1:new:review", run("r"), 1);
  const huge = "x".repeat(200_000);
  for (let i = 0; i < 350; i++) h.line(i + huge);
  h.stage(huge);
  h.fail(huge, false);
  const latest = panels[0].posted.at(-1).run;
  assert.equal(latest.log.length, 300);
  assert.equal(latest.log.reduce((total, line) => total + line.text.length, 0), 120_000);
  assert.ok(latest.log[0].text.startsWith("51"));
  assert.equal(latest.stage, latest.log.at(-1).text);
  assert.equal(latest.error.length, 4_000);
  assert.ok(latest.error.endsWith("…"));
});

test("a card can reopen a running work review; terminal reviews retire when their panel closes", () => {
  const { vscode, panels } = fakeVscode();
  const { HelperTabs } = loadModule(vscode), tabs = new HelperTabs({ path: "/ext" });
  for (const closeFirst of [false, true]) {
    const h = tabs.start("card:work", run("review", { kind: "work" }));
    h.prompt("large review input");
    const first = panels.at(-1);
    first.dispose(); tabs.show("review");
    const panel = panels.at(-1);
    assert.notEqual(panel, first);
    panel.receive({ type: "ready" });
    assert.equal(panel.posted.at(-1).run.prompt, "large review input");
    if (closeFirst) { panel.dispose(); h.fail("cancelled", true); }
    else { h.finish({ text: "review", notes: [] }); panel.dispose(); }
    assert.equal(tabs.runs.size + tabs.byRequest.size + tabs.shown.size + tabs.timers.size, 0);
  }
});

test("titles and result views match what the board shows", () => {
  const { helperTitle, refineView, improveView, reviewView } = loadModule({});
  assert.equal(helperTitle("refine"), "Refine draft");
  assert.equal(helperTitle("improve", "Fix the login test"), "Improve: Fix the login test");
  assert.equal(helperTitle("review", "x".repeat(50)), `Review: ${"x".repeat(40)}…`);
  assert.deepEqual(refineView({ kind: "unchanged" }, "new").text, "Your draft is already clear.");
  assert.equal(refineView({ kind: "questions", questions: [{ question: "Which?", reason: "Scope", suggested: "All" }] }, "t1").text, "Which?\nWhy: Scope\nSuggested answer: All");
  assert.match(refineView({ kind: "revision", revision: "R", assumptions: [] }, "t1").notes[0], /follow-up box/);
  const ready = improveView({ rendered: { text: "Do it." }, tally: { requirements: 2, criteria: 1, assumed: 0, mustAsk: 1 }, dropped: ["extra"] }, "new");
  assert.equal(ready.text, "Do it.");
  assert.deepEqual(ready.notes.slice(0, 2), ["2 requirements · 1 checks · 0 held back because the model assumed them · 0 assumed facts sent as unconfirmed · 1 questions to ask first", "Possibly not carried into the prompt: extra"]);
  const held = improveView({ rendered: { text: "Do it." }, tally: { requirements: 1, criteria: 0, assumed: 1, quarantined: 1, mustAsk: 0 }, quarantined: [{ kind: "requirement", id: "R2", text: "Add a retry helper." }],
    sourceOnly: ["report.md"], oversize: { chars: 26408, limit: 24000 } }, "new");
  assert.ok(held.notes.includes("The model assumed this; not sent (requirement): Add a retry helper."));
  assert.ok(held.notes.includes("Only in pasted material, not as an instruction: report.md"));
  assert.ok(held.notes.some((n) => n.startsWith("This prompt is 26408 characters, over the 24000-character limit")));
  assert.match(held.notes.at(-1), /copy what you need from it there/);
  // A pasted log gave 628 anchors on linux (4 November 2026): one line per list, not one paragraph per anchor.
  const log = improveView({ rendered: { text: "Do it." }, dropped: ["a", "b"], sourceOnly: ["4019", "514002", "00.970"] }, "new");
  assert.deepEqual(log.notes.filter((n) => /^(Possibly not carried|Only in pasted)/.test(n)),
    ["Possibly not carried into the prompt: a, b", "Only in pasted material, not as an instruction: 4019, 514002, 00.970"]);
  assert.match(improveView({ record: { conflicts: [{ earlier: "A", later: "B", why: "C" }] } }, "new").text, /^Earlier: A\nLater: B\nWhy: C$/);
  const review = reviewView({ review: { overview: "O", attempts: [{ model: "Terra", approach: "P", worked: ["w"], didNotWork: [] }], comparison: "", takeaways: ["t"] },
    attempts: [{ label: "Terra", model: "m", effort: "max", status: "ready" }, { label: "Sol", effort: "max", error: "boom" }] });
  assert.equal(review.text, "O\n\nTerra: P\nWorked: w\n\nTakeaways:\n- t");
  assert.deepEqual(review.notes, ["Terra (m · max effort): finished", "Sol (no model · max effort): failed: boom"]);
  assert.match(reviewView({ reviewError: "late", attempts: [] }).text, /could not review the attempts: late/);
});

test("Codex events become short activity lines; reasoning and the answer are left to the streams", () => {
  const { codexEventLine } = require("../out/worker");
  assert.equal(codexEventLine({ type: "thread.started", thread_id: "x" }), "Codex thread started.");
  assert.equal(codexEventLine({ type: "turn.started" }), "Turn started.");
  assert.equal(codexEventLine({ type: "item.completed", item: { type: "agent_message", text: "{}" } }), undefined);
  assert.equal(codexEventLine({ type: "item.completed", item: { type: "reasoning", text: "Thinking" } }), undefined);
  assert.equal(codexEventLine({ type: "item.completed", item: { type: "web_search" } }), "web_search finished.");
  assert.equal(codexEventLine({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } }), "Turn completed (10 input · 3 output tokens).");
  assert.match(codexEventLine({ type: "error", message: "rate limit" }), /Codex reported: rate limit/);
  assert.equal(codexEventLine({ type: "something.else" }), undefined);
});

// The real runner with spawn intercepted, in its own Node process (as test/refinement-routing.test.js does). The Claude events follow
// the stream-json format the Claude Code extension reads (stream_event wrapping the API's content_block_* events).
async function captureStreaming() {
  const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
  const { EventEmitter } = require("node:events");
  const { PassThrough, Writable } = require("node:stream");
  const dir = process.argv[3];
  const spawns = [];
  let refuseStreaming = false;
  const value = { kind: "unchanged", revision: "", questions: [], assumptions: [] };
  const model = "claude-opus-5-5";
  const result = { type: "result", subtype: "success", is_error: false, session_id: "s", structured_output: value, subagent_stats: { spawned: 0 },
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { [model]: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } };
  const ev = (event, parent = null) => ({ type: "stream_event", event, parent_tool_use_id: parent, session_id: "s" });
  require("node:child_process").spawn = (binary, args) => {
    spawns.push(args);
    const codex = args[0] === "exec", streaming = args.includes("stream-json");
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdin = new Writable({ write(chunk, encoding, callback) { callback(); }, final(callback) {
      callback();
      queueMicrotask(() => {
        if (codex) {
          for (const e of [{ type: "thread.started", thread_id: "t" }, { type: "turn.started" }, { type: "item.completed", item: { type: "reasoning", text: "**Checking the draft**" } },
            { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } }, { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } }])
            child.stdout.write(JSON.stringify(e) + "\n");
          child.stdout.end(); child.emit("close", 0); return;
        }
        if (streaming && refuseStreaming) { child.stderr.write("error: unknown option '--thinking-display'\n"); child.stdout.end(); child.emit("close", 1); return; }
        if (!streaming) { child.stdout.end(JSON.stringify([{ type: "system", subtype: "init" }, result])); child.emit("close", 0); return; }
        const lines = [{ type: "system", subtype: "init", session_id: "s" },
          ev({ type: "message_start" }), ev({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
          ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "The draft " } }),
          ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "is clear." } }),
          ev({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
          ev({ type: "content_block_stop", index: 0 }),
          ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a subagent's text" } }, "toolu_1"),
          ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "StructuredOutput" } }),
          ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"kind":"unch' } }),
          ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'anged"}' } }),
          ev({ type: "content_block_stop", index: 1 }), ev({ type: "message_stop" }), result];
        // Split mid-line, as a pipe may deliver it.
        const text = lines.map((l) => JSON.stringify(l)).join("\n");
        child.stdout.write(text.slice(0, 101)); child.stdout.write(text.slice(101)); child.stdout.end(); child.emit("close", 0);
      });
    } });
    return child;
  };
  const { generateText } = require(process.argv[2]);
  const signal = new AbortController().signal;
  const seen = { prompts: [], out: [] };
  const progress = { prompt: (t) => seen.prompts.push(t), line: (t, s) => seen.out.push([s ?? "log", t]) };

  // Claude, watched: streaming flags, thinking and answer streamed, subagent text ignored, the same answer as before.
  const claude = await generateText(path.join(dir, "claude"), "refine", "Fix the flaky test.", path.join(dir, "acct"), "opus", "Q\nA", signal, "high", undefined, [], "CONTEXT LINE", progress);
  assert.equal(claude.value.kind, "unchanged");
  const a = spawns.at(-1);
  assert.equal(a[a.indexOf("--output-format") + 1], "stream-json");
  assert.ok(a.includes("--include-partial-messages") && a[a.indexOf("--thinking-display") + 1] === "summarized" && a.includes("--verbose"));
  // Since 4 November 2026 the project context comes before the draft, in tags (refinePrompt).
  assert.match(seen.prompts[0], /PROJECT CONTEXT:\n<project_context>\nCONTEXT LINE\n<\/project_context>[\s\S]*DRAFT:\nFix the flaky test\.[\s\S]*CLARIFICATION ANSWERS:\nQ\nA/);
  assert.deepEqual(seen.out, [["log", "Claude opus · high effort started on acct."], ["thinking", "The draft "], ["thinking", "is clear."], ["thinking", "\n\n"],
    ["answer", '{"kind":"unch'], ["answer", 'anged"}'], ["log", "claude-opus-5-5 answered after 0 s."]]);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "claude", "text.provider-output.jsonl"), "utf8"));
  assert.ok(Array.isArray(saved) && saved.at(-1).type === "result" && !saved.some((e) => e.type === "stream_event"), "saved as the array --output-format json prints");

  // Unwatched (titles, completion rules): unchanged one-block JSON output.
  await generateText(path.join(dir, "plain"), "refine", "Fix the flaky test.", path.join(dir, "acct"), "opus", "", signal, "high");
  assert.equal(spawns.at(-1)[spawns.at(-1).indexOf("--output-format") + 1], "json");
  assert.ok(!spawns.at(-1).includes("--include-partial-messages") && !spawns.at(-1).includes("--thinking-display"));

  // A CLI that does not know the streaming flags: one retry without them, said in the activity.
  refuseStreaming = true; seen.out.length = 0;
  const before = spawns.length;
  const fallback = await generateText(path.join(dir, "old-cli"), "refine", "Fix the flaky test.", path.join(dir, "acct"), "opus", "", signal, "high", undefined, [], "", progress);
  assert.equal(fallback.value.kind, "unchanged");
  assert.equal(spawns.length, before + 2);
  assert.equal(spawns.at(-1)[spawns.at(-1).indexOf("--output-format") + 1], "json");
  assert.ok(seen.out.some(([s, t]) => s === "log" && t === "This CLI cannot stream its output; running again without live output."));
  refuseStreaming = false;

  // Codex, watched: detailed reasoning summaries asked for; reasoning to the thinking stream, the answer to the answer stream.
  seen.out.length = 0;
  await generateText(path.join(dir, "codex"), "refine", "Fix the flaky test.", "", "gpt-a", "", signal, "medium", "/fake/codex", [], "", progress);
  const c = spawns.at(-1);
  assert.ok(c.includes('model_reasoning_summary="detailed"') && c.at(-1) === "-");
  // A machine with ~/.codex/AGENTS.md gets one more activity line ("Codex also reads …"); it is the machine's, not the call's.
  assert.deepEqual(seen.out.filter(([s, t]) => !(s === "log" && /^Codex also reads /.test(t))), [["log", "Codex gpt-a · medium effort started on the Codex account."], ["log", "Codex thread started."], ["log", "Turn started."],
    ["thinking", "**Checking the draft**\n\n"], ["log", "Turn completed (5 input · 2 output tokens)."], ["answer", JSON.stringify(value)], ["log", "Answer received."],
    ["log", "gpt-a answered after 0 s."]]);
  await generateText(path.join(dir, "codex-plain"), "refine", "Fix the flaky test.", "", "gpt-a", "", signal, "medium", "/fake/codex");
  assert.ok(!spawns.at(-1).includes('model_reasoning_summary="detailed"'), "unwatched Codex calls are unchanged");
}

test("watched calls stream Claude's thinking and answer and Codex's reasoning; unwatched calls are unchanged; an old CLI falls back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-helper-stream-"));
  try {
    const script = path.join(dir, "capture.cjs");
    fs.writeFileSync(script, `(${captureStreaming.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`);
    execFileSync(process.execPath, [script, require.resolve("../out/text-actions"), dir], { encoding: "utf8", timeout: 15_000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a new run on the same box and button stops the old run's call (F19-3 in session 3482f4's review)", () => {
  const { vscode } = fakeVscode();
  const { HelperTabs } = loadModule(vscode);
  const tabs = new HelperTabs({ path: "/ext" });
  let stopped = 0;
  tabs.start("1:new:refine", run("r1", { cancel: () => stopped++ }));
  tabs.start("1:new:refine", run("r2"));
  assert.equal(stopped, 1);
  const done = tabs.start("1:new:improve", run("r3", { cancel: () => stopped++ }));
  done.finish({ text: "x", notes: [] });
  tabs.start("1:new:improve", run("r4"));
  assert.equal(stopped, 1, "a finished run is not cancelled");
});
