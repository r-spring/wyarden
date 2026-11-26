// Phase 1 of docs/plans/MASTER-PLAN-capability-profiles-and-orchestration.md (AC-G, AC-G2, AC-H): Improve's accepted specification
// survives Apply, Add task, a reload, Start, Resume and a follow-up, with the user's four settings unchanged, stale results refused,
// deterministic replay of the saved render, and unreadable versions blocked. No model is called and no session is launched.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const compile = require("../out/compile.js");
const { withRule } = require("../out/text-actions.js");
const { masterPrompt } = require("../out/orchestrator.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-spec-binding-"));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const freshDir = () => { const d = path.join(scratch, `b${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };

const record = (requirements, criteria = []) => ({ version: 1, status: "ready", outcome: { goal: "Add CSV export for the filtered table.", deliverable: "", beneficiary: "" },
  context: { facts: [], identifiers: [], sources: [], dependencies: [] },
  success: { criteria: criteria.map(([text, covers], i) => ({ id: `A${i + 1}`, text, provenance: "user", covers })) },
  requirements: requirements.map((text, i) => ({ id: `R${i + 1}`, text, provenance: "user", strength: "mandatory", rationale: "" })),
  permissions: { authorized: [{ text: "Edit src/export.ts", provenance: "user" }], confirm: [], prohibited: [{ text: "Push to the remote", provenance: "user" }] }, unresolved: [], conflicts: [] });
const R1 = record(["Export only rows matching the active filters.", "Keep the column order."], [["The fixture export matches the ordered columns.", ["R1", "R2"]]]);
const result = (rec, dir) => ({ record: rec, rendered: compile.renderExecutionPrompt(rec), model: "claude-fable-5-2", promptVersion: compile.COMPILE_PROMPT_VERSION,
  receipt: path.join(dir, "helpers", "x", "compile-receipt.json") });
const CONTROLS = { account: "acct", model: "opus", effort: "high", permission: "edits" };
const save = (dir, requestId, rec = R1, target = "new", controls = CONTROLS) =>
  compile.saveCandidate(dir, requestId, target, "draft text", "Q1\nanswer", controls, result(rec, dir));

// ---- the binding itself (src/compile.ts) ----

test("identical saved inputs render identical bytes, also after the candidate is written and read back (AC-G)", () => {
  const dir = freshDir(), c = save(dir, "req-a");
  const back = compile.loadCandidate(dir, "req-a");
  assert.equal(compile.renderExecutionPrompt(back.record).text, c.text);
  assert.equal(compile.renderExecutionPrompt(JSON.parse(JSON.stringify(R1))).text, compile.renderExecutionPrompt(R1).text);
  assert.equal(back.outputSha256, require("node:crypto").createHash("sha256").update(c.text).digest("hex"));
  assert.equal(back.rendererVersion, compile.RENDERER_VERSION);
  assert.equal(back.receipt, path.join("helpers", "x", "compile-receipt.json"), "a board-relative receipt path, never one from the webview");
  assert.equal(compile.loadCandidate(dir, "unknown-request"), undefined);
  assert.equal(compile.saveCandidate(dir, "req-b", "new", "d", "", CONTROLS, { ...result(R1, dir), rendered: undefined }), undefined, "an unfinished record is never bindable");
  assert.equal(compile.saveCandidate(dir, "req-c", "new", "d", "", CONTROLS, { ...result(R1, dir), oversize: { chars: 30000, limit: 24000 } }), undefined, "an oversize prompt cannot be applied, so it is not bindable");
});

test("a stale result is refused: changed text, any of the four settings, another box, another renderer, an altered record (AC-G)", () => {
  const dir = freshDir(), c = save(dir, "req-s");
  assert.deepEqual(compile.staleReasons(c, c.text, { ...CONTROLS }, "new"), []);
  assert.deepEqual(compile.staleReasons(c, c.text + " Also log it.", CONTROLS, "new"), ["the text changed after Apply"]);
  for (const [k, v] of [["account", "other"], ["model", "sonnet"], ["effort", "low"], ["permission", ""]])
    assert.deepEqual(compile.staleReasons(c, c.text, { ...CONTROLS, [k]: v }, "new"), [`${k}: ${CONTROLS[k]} → ${v || "default"}`]);
  assert.deepEqual(compile.staleReasons(c, c.text, CONTROLS, "task-1"), ["it was improved for another box"]);
  assert.match(compile.staleReasons({ ...c, rendererVersion: "render-old" }, c.text, CONTROLS, "new")[0], /renderer changed since Improve \(render-old →/);
  const altered = JSON.parse(JSON.stringify(c)); altered.record.permissions.prohibited = [];
  assert.deepEqual(compile.staleReasons(altered, c.text, CONTROLS, "new"), ["the saved improvement no longer renders to the text that was applied"]);
  assert.deepEqual(compile.staleReasons({ ...c, version: 2 }, c.text, CONTROLS, "new"), ["the saved improvement has an unknown version"]);
});

test("stable ids: an unchanged obligation keeps its id, a new one gets the next number, removed ones are superseded and never reused", () => {
  const dir = freshDir();
  const spec1 = compile.newSpec(save(dir, "r1"));
  assert.deepEqual(spec1.revisions[0].ids, { requirements: ["R-01", "R-02"], acceptance: ["A-01"] });
  // Revision 2 drops "Keep the column order.", rewords nothing else but spacing and case, and adds one obligation and one check.
  const R2 = record(["export only rows   matching the ACTIVE filters.", "Write a header row."], [["The fixture export matches the ordered columns.", ["R1"]], ["The header row names every column.", ["R2"]]]);
  const spec2 = compile.addRevision(spec1, save(dir, "r2", R2, "task-1"));
  assert.deepEqual(spec2.revisions[1].ids, { requirements: ["R-01", "R-03"], acceptance: ["A-01", "A-02"] });
  assert.deepEqual(spec2.revisions[1].superseded, ["R-02"]);
  // Revision 3 brings the dropped text back: it is a new obligation now, so it gets a new id, not the superseded R-02.
  const spec3 = compile.addRevision(spec2, save(dir, "r3", record(["Keep the column order."]), "task-1"));
  assert.deepEqual(spec3.revisions[2].ids.requirements, ["R-04"]);
  assert.deepEqual(spec1.revisions.length, 1, "the earlier spec is not changed in place");
  assert.equal(spec3.revisions[0].text, spec1.revisions[0].text, "the original authority stays as it was");
});

test("readSpec: absent is a raw or older card; an unknown version or a damaged spec throws and blocks mutation", () => {
  assert.equal(compile.readSpec(undefined), undefined);
  const spec = compile.newSpec(save(freshDir(), "rs"));
  assert.equal(compile.readSpec(JSON.parse(JSON.stringify(spec))).specId, spec.specId);
  assert.throws(() => compile.readSpec({ ...spec, version: 2 }), /version 2, which this Entomatical cannot read\. It is kept unchanged/);
  const damaged = JSON.parse(JSON.stringify(spec)); damaged.revisions[0].ids.requirements.pop();
  assert.throws(() => compile.readSpec(damaged), /damaged \(ids do not match the record\)/);
  assert.deepEqual(compile.specSummary({ ...spec, version: 9 }).error.slice(0, 40), "This card's improved specification has v");
});

test("launch receipts: exact replay, the first prompt still carries the text through Done when, Plan first and the orchestrator brief; drift named", () => {
  const spec = { ...compile.newSpec(save(freshDir(), "lr")), execution: { ...CONTROLS, source: "user-selection", capabilities: "provider-defaults" } };
  const text = spec.revisions[0].text;
  const planFirst = require("../out/plan.js").planningPrompt("Plan this task.\n\nTask:\n\n{{task}}", { guide: "g", schema: "s", checks: "c" }, text);
  for (const prompt of [text, withRule(text, { goal: "g", doneWhen: "d", commands: ["npm test"] }), masterPrompt("BRIEF", text), planFirst]) {
    const r = compile.launchReceipt(spec, { ...CONTROLS, prompt }, "launch");
    assert.deepEqual([r.kind, r.replay, r.carried, r.drift, r.revision], ["launch", "exact", true, [], 1]);
  }
  assert.equal(compile.launchReceipt(spec, { ...CONTROLS, prompt: "something else" }, "launch").carried, false);
  assert.deepEqual(compile.launchReceipt(spec, { ...CONTROLS, model: "sonnet", prompt: text }, "launch").drift, ["model: opus → sonnet"]);
  const resume = compile.launchReceipt(spec, { ...CONTROLS, prompt: text }, "resume");
  assert.deepEqual([resume.replay, "carried" in resume], ["not-sent", false], "a resume sends no first prompt, so nothing is replayed");
  const old = JSON.parse(JSON.stringify(spec)); old.revisions[0].rendererVersion = "render-old";
  assert.equal(compile.launchReceipt(old, { ...CONTROLS, prompt: text }, "launch").replay, "renderer-changed");
  const altered = JSON.parse(JSON.stringify(spec)); altered.revisions[0].record.requirements[0].text = "Export every row.";
  assert.equal(compile.launchReceipt(altered, { ...CONTROLS, prompt: text }, "launch").replay, "mismatch");
});

// ---- the extension's handlers (src/extension.ts) with a stand-in board and the real compile module ----

function hostFixture(autoStart = true) {
  const added = [], starts = [], sent = [], warnings = [], errors = [];
  const forbid = () => { throw new Error("This test must not open a window or launch a process."); };
  const vscode = {
    workspace: { getConfiguration: () => ({ get: (key, fallback) => (key === "autoStart" ? autoStart : key === "maxRunning" ? 0 : key === "claudeProcessWrapper" ? undefined : fallback) }) },
    window: { showErrorMessage: (m) => { errors.push(m); }, showInformationMessage: forbid, showWarningMessage: (m) => { warnings.push(m); }, setStatusBarMessage: () => ({ dispose() {} }) },
  };
  const stubs = { "./compile": compile, "./queue": require("../out/queue.js"), "./models": require("../out/models.js"), "./plan": require("../out/plan.js") };
  const filename = require.resolve("../out/extension.js");
  const extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = (name) => {
    if (name === "vscode") return vscode;
    if (name === "child_process") return { execFile: forbid, execFileSync: forbid, spawn: forbid };
    if (name === "./profiles") return require("../out/profiles.js"); // pure: capability profiles (phase 2)
    if (name.startsWith("./")) return stubs[name] ?? {};
    return require(name);
  };
  extension._compile(fs.readFileSync(filename, "utf8") + '\nstate = { get: key => key === "panelDeclined" }; module.exports.handle = handle;\n', filename);
  const tasks = [];
  const board = {
    dir: freshDir(), tasks, external: new Map(),
    add(title, prompt, account, parentId, model, effort, completion, step) {
      added.push({ title, prompt, account, model, effort, step });
      const task = { id: `card-${tasks.length + 1}`, status: "queued", title: title || prompt.slice(0, 20), prompt, account, model, effort, ...step };
      tasks.push(task); return task;
    },
    get: (id) => tasks.find((t) => t.id === id),
    mustOwn() {}, configDirOf: () => "/acct", refresh() {}, reconcile() {}, resetUnstarted: () => false, waitingToStart: () => true, live: () => [],
    terminal: () => ({ show() {} }),
    update(task, patch) { Object.assign(task, patch); },
    async start(task) { if (task.failStart) throw new Error("the terminal could not open"); starts.push(task.id); return { show() {} }; },
    startInPanel: forbid,
    async send(task, text) { sent.push({ id: task.id, text }); },
  };
  return { handle: (m) => extension.exports.handle(board, m), board, added, starts, sent, warnings, errors, tasks };
}
const createMessage = (c, extra = {}) => ({ type: "create", title: "Export", prompt: c.text, ...CONTROLS, autoTitle: false, helpers: [{ requestId: "req-new", kind: "improve", edited: false }], ...extra });

test("host: Add task binds the applied result before the start, keeps the four settings, and Start records an exact replay (AC-G, AC-G2)", async () => {
  const f = hostFixture(), c = save(f.board.dir, "req-new");
  await f.handle(createMessage(c));
  assert.equal(f.added.length, 1);
  const { step, account, model, effort } = f.added[0];
  assert.deepEqual([account, model, effort, step.permission], ["acct", "opus", "high", "edits"], "the user's selections, untouched by the improved text");
  assert.equal(step.spec.revisions[0].text, c.text);
  assert.deepEqual(step.spec.revisions[0].ids, { requirements: ["R-01", "R-02"], acceptance: ["A-01"] });
  assert.deepEqual([step.spec.execution.source, step.spec.execution.capabilities], ["user-selection", "provider-defaults"]);
  assert.deepEqual(f.starts, ["card-1"], "auto-start ran after the spec was saved with the card");
  const launch = f.tasks[0].spec.launches;
  assert.deepEqual(launch.map((l) => [l.kind, l.replay, l.carried, l.drift.length]), [["launch", "exact", true, 0]]);
  assert.deepEqual(f.warnings, []);
});

test("host: a stale or missing result is not attached; the text goes as written and a warning says why", async () => {
  const f = hostFixture(), c = save(f.board.dir, "req-new");
  await f.handle(createMessage(c, { prompt: c.text + " Edited." }));
  await f.handle(createMessage(c, { model: "sonnet" }));
  await f.handle(createMessage(c, { helpers: [] })); // raw: no Improve in the chain
  await f.handle(createMessage(c, { helpers: [{ requestId: "lost-reply", kind: "improve" }] })); // a result the host never saved
  assert.deepEqual(f.added.map((a) => !!a.step.spec), [false, false, false, false]);
  assert.deepEqual(f.added.map((a) => a.prompt), [c.text + " Edited.", c.text, c.text, c.text], "every text is kept as sent");
  assert.equal(f.warnings.length, 2);
  assert.match(f.warnings[0], /added with its text as written, without the improved specification: the text changed after Apply\./);
  assert.match(f.warnings[1], /model: opus → sonnet/);
  assert.equal(f.starts.length, 4, "raw tasks still start as before");
});

test("host: a follow-up's specification is added after it was sent; a card with an unreadable version refuses Start, Resume and an improved follow-up", async () => {
  const f = hostFixture(), c = save(f.board.dir, "req-new");
  await f.handle(createMessage(c));
  const card = f.tasks[0];
  card.permission = "edits"; // as Board.add saves it
  const followRec = record(["Export only rows matching the active filters.", "Write a header row."]);
  const fc = save(f.board.dir, "req-follow", followRec, card.id, { account: "acct", model: "opus", effort: "high", permission: "edits" });
  const follow = { type: "send", id: card.id, text: fc.text, helpers: [{ requestId: "req-follow", kind: "improve", edited: false }] };
  const send = f.board.send;
  let refuse;
  f.board.send = () => new Promise((_resolve, reject) => { refuse = reject; });
  const pending = f.handle(follow);
  assert.equal(compile.loadCandidate(f.board.dir, "req-follow").usedBy, card.id, "reserved while the terminal submission is pending");
  refuse(new Error("Enter withheld"));
  await assert.rejects(pending, /Enter withheld/);
  assert.equal(compile.loadCandidate(f.board.dir, "req-follow").usedBy, undefined, "the same improvement can be retried");
  assert.equal(card.spec.revisions.length, 1);
  f.board.send = send;
  await f.handle(follow);
  assert.deepEqual(f.sent.map((s) => s.text), [fc.text]);
  assert.deepEqual(card.spec.revisions.map((r) => [r.revision, r.kind, r.ids.requirements.join()]), [[1, "create", "R-01,R-02"], [2, "follow-up", "R-01,R-03"]]);
  await f.handle({ type: "resume", id: card.id });
  assert.deepEqual(card.spec.launches.map((l) => l.kind), ["launch"], "opening the terminal waiting for setup sends no turn");
  // A spec written by a newer Entomatical: nothing is started, resumed or sent with it, and the record is left as it was.
  card.spec = { ...card.spec, version: 2 };
  const before = JSON.stringify(card.spec);
  await assert.rejects(f.handle({ type: "start", id: card.id }), /version 2, which this Entomatical cannot read/);
  await assert.rejects(f.handle({ type: "resume", id: card.id }), /cannot read/);
  await assert.rejects(f.handle({ type: "send", id: card.id, text: fc.text, helpers: [{ requestId: "req-follow", kind: "improve" }] }), /cannot read/);
  assert.equal(JSON.stringify(card.spec), before);
  assert.deepEqual([f.starts.length, f.sent.length], [1, 1]);
  // A raw follow-up does not touch the specification, so it is still allowed.
  await f.handle({ type: "send", id: card.id, text: "plain follow-up", helpers: [] });
  assert.equal(f.sent.length, 2);
  // Switching account moves and stops nothing on a card whose specification cannot be read.
  await assert.rejects(f.handle({ type: "switchAccount", id: card.id, account: "other" }), /cannot read/);
  assert.equal(JSON.stringify(card.spec), before);
});

test("host: Resume reveals a session found busy or waiting during reconciliation without recording a turn", async () => {
  const f = hostFixture(), c = save(f.board.dir, "req-new");
  await f.handle(createMessage(c));
  const card = f.tasks[0], launches = card.spec.launches;
  card.sessionId = "thread";
  f.board.waitingToStart = () => false;
  let reveals = 0;
  f.board.terminal = () => ({ show() { reveals++; } });
  for (const status of ["busy", "waiting"]) {
    card.status = "review";
    f.board.reconcile = () => f.board.external.set(card.sessionId, { status });
    await f.handle({ type: "resume", id: card.id });
    assert.equal(card.status, status === "busy" ? "running" : "needs-input");
    assert.deepEqual(card.spec.launches, launches);
  }
  assert.equal(reveals, 2);
});

test("host: overlapping Resume clicks record only the acknowledged continuation", async () => {
  const f = hostFixture(), c = save(f.board.dir, "req-new");
  await f.handle(createMessage(c));
  const card = f.tasks[0], msg = { type: "resume", id: card.id };
  card.sessionId = "thread";
  f.board.waitingToStart = () => false;
  const ack = Promise.withResolvers(), calls = [];
  f.board.continueTask = (task) => { calls.push(task.id); return ack.promise; };
  const first = f.handle(msg);
  await f.handle(msg);
  assert.deepEqual(calls, [card.id]);
  assert.deepEqual(card.spec.launches.map((l) => l.kind), ["launch"], "no receipt before acknowledgement");
  ack.resolve();
  await first;
  assert.deepEqual(card.spec.launches.map((l) => [l.kind, l.replay]), [["launch", "exact"], ["resume", "not-sent"]]);
  f.board.continueTask = async () => { throw new Error("unconfirmed"); };
  await assert.rejects(f.handle(msg), /unconfirmed/);
  assert.equal(card.spec.launches.length, 2);
});

test("host: overlapping Resume clicks on an unstarted card dispatch one first turn and record only its launch", async () => {
  const f = hostFixture(false), c = save(f.board.dir, "req-new");
  await f.handle(createMessage(c));
  const card = f.tasks[0], msg = { type: "resume", id: card.id };
  card.sessionId = "never-ready";
  f.board.resetUnstarted = (task) => {
    assert.equal(task.sessionId, "never-ready", "the second click stays pending until Start returns");
    task.sessionId = undefined;
    return true;
  };
  const entered = Promise.withResolvers(), ack = Promise.withResolvers();
  f.board.start = (task) => { f.starts.push(task.id); entered.resolve(); return ack.promise; };
  const first = f.handle(msg);
  await entered.promise;
  await f.handle(msg);
  assert.deepEqual(f.starts, [card.id]);
  assert.deepEqual(card.spec.launches, []);
  ack.resolve();
  await first;
  assert.deepEqual(card.spec.launches.map((l) => [l.kind, l.carried]), [["launch", true]]);
});

test("host: a provider terminal Resume records a receipt only after its dispatcher succeeds", async () => {
  const f = hostFixture(false), c = save(f.board.dir, "req-new");
  await f.handle(createMessage(c));
  const card = f.tasks[0], msg = { type: "resume", id: card.id };
  card.provider = "grok";
  await assert.rejects(f.handle(msg), /Use Follow-up/);
  card.cardTerminalStarted = true;
  f.board.startCardTerminal = async () => { throw new Error("already running"); };
  await assert.rejects(f.handle(msg), /already running/);
  assert.deepEqual(card.spec.launches, []);
  const ack = Promise.withResolvers(), calls = [];
  f.board.startCardTerminal = (task, resume) => { calls.push([task.id, resume]); return ack.promise; };
  const pending = f.handle(msg);
  assert.deepEqual(calls, [[card.id, true]]);
  assert.deepEqual(card.spec.launches, []);
  ack.resolve();
  await pending;
  assert.deepEqual(card.spec.launches.map((l) => l.kind), ["resume"]);
});

test("host: a start that fails writes no launch receipt; an Improve run edited afterwards counts as raw", async () => {
  const f = hostFixture(), c = save(f.board.dir, "req-new");
  assert.equal(compile.improveRequest([{ requestId: "a", kind: "improve", edited: true }]), undefined);
  assert.equal(compile.improveRequest([{ requestId: "r", kind: "refine" }, { requestId: "b", kind: "improve", edited: false }]), "b");
  await f.handle(createMessage(c)); // auto-start: one receipt
  const card = f.tasks[0];
  card.failStart = true;
  await assert.rejects(f.handle({ type: "start", id: card.id }), /could not open/);
  assert.equal(card.spec.launches.length, 1, "no receipt claims a start that did not happen");
  card.failStart = false;
  await f.handle({ type: "start", id: card.id });
  assert.deepEqual(card.spec.launches.map((l) => [l.kind, l.replay]), [["launch", "exact"], ["launch", "exact"]]);
});

test("host: one request id binds one card: a second Add or Send of the same applied box is refused, a failed add or send releases it", async () => {
  const f = hostFixture(), c = save(f.board.dir, "req-new");
  await f.handle(createMessage(c));
  assert.deepEqual([compile.loadCandidate(f.board.dir, "req-new").usedBy, typeof compile.loadCandidate(f.board.dir, "req-new").usedAt], ["card-1", "string"]);
  await f.handle(createMessage(c)); // the same applied box added again
  assert.deepEqual(f.added.map((a) => !!a.step.spec), [true, false], "the second card is added with its text as written");
  assert.match(f.warnings[0], /without the improved specification: this improvement already bound card card-1 \(.+\); run Improve again to bind another card\./);
  // An add that throws (here the stand-in board refuses it) leaves no card holding the result, so the result can still be bound.
  const c2 = save(f.board.dir, "req-two"), add = f.board.add;
  f.board.add = () => { throw new Error("the board refused the card"); };
  await assert.rejects(f.handle(createMessage(c2, { helpers: [{ requestId: "req-two", kind: "improve" }] })), /refused the card/);
  assert.equal(compile.loadCandidate(f.board.dir, "req-two").usedBy, undefined);
  f.board.add = add;
  await f.handle(createMessage(c2, { helpers: [{ requestId: "req-two", kind: "improve" }] }));
  assert.equal(compile.loadCandidate(f.board.dir, "req-two").usedBy, "card-3");
  // Follow-ups: a failed send releases; the first sent one binds; sending the same box again adds no revision.
  const card = f.tasks[0]; card.permission = "edits";
  const fc = save(f.board.dir, "req-follow", record(["Write a header row."]), card.id), msg = { type: "send", id: card.id, text: fc.text, helpers: [{ requestId: "req-follow", kind: "improve" }] };
  const send = f.board.send; f.board.send = async () => { throw new Error("Run paused"); };
  await assert.rejects(f.handle(msg), /Run paused/);
  assert.equal(compile.loadCandidate(f.board.dir, "req-follow").usedBy, undefined);
  f.board.send = send;
  await f.handle(msg);
  await f.handle(msg);
  assert.equal(card.spec.revisions.length, 2, "the second send of the same box adds no revision");
  assert.match(f.warnings.at(-1), /the follow-up was sent .*already bound card card-1/);
});

test("candidates bound more than 7 days ago are pruned, unbound ones after 30 days; newer ones stay", () => {
  const dir = freshDir();
  for (const id of ["old", "recent", "unbound"]) save(dir, id);
  compile.markCandidate(dir, "old", "card-1");
  compile.markCandidate(dir, "recent", "card-2");
  const day = 24 * 3600_000, oldAt = Date.parse(compile.loadCandidate(dir, "old").usedAt);
  assert.equal(compile.pruneCandidates(dir, oldAt + 7 * day - 1000), 0, "kept for the full 7 days");
  assert.equal(compile.pruneCandidates(dir, oldAt + 7 * day + 1000), 2, "both bound ones are older than 7 days by then");
  assert.deepEqual(["old", "recent", "unbound"].map((id) => !!compile.loadCandidate(dir, id)), [false, false, true]);
  compile.markCandidate(dir, "unbound", undefined); // releasing an unbound one is harmless
  assert.equal(compile.loadCandidate(dir, "unbound").usedBy, undefined);
  const savedAt = Date.parse(compile.loadCandidate(dir, "unbound").at);
  assert.equal(compile.pruneCandidates(dir, savedAt + 30 * day - 1000), 0, "an unbound one is kept for 30 days");
  assert.equal(compile.pruneCandidates(dir, savedAt + 30 * day + 1000), 1, "an abandoned Improve goes after 30 days");
  fs.writeFileSync(path.join(dir, "helpers", "improve-candidates", "broken.json"), "{");
  assert.equal(compile.pruneCandidates(dir), 0, "an unreadable file is left alone");
});

test("specSummary on a card with 50 revisions stays well under the 50 ms repost budget", () => {
  const dir = freshDir();
  let spec = compile.newSpec(save(dir, "s0"));
  for (let i = 1; i < 50; i++) spec = compile.addRevision(spec, save(dir, `s${i}`, record([`Requirement ${i}.`, "Keep the column order."], [[`Check ${i}.`, ["R1"]]]), "task-1"));
  assert.equal(spec.revisions.length, 50);
  compile.specSummary(spec); // warm up
  const runs = Array.from({ length: 20 }, () => { const t = process.hrtime.bigint(); compile.specSummary(spec); return Number(process.hrtime.bigint() - t) / 1e6; }).sort((a, b) => a - b);
  console.log(`# specSummary, 50 revisions: median ${runs[10].toFixed(3)} ms, max ${runs.at(-1).toFixed(3)} ms over 20 runs`);
  assert.equal(compile.specSummary(spec).revision, 50);
  assert.ok(runs[10] < 50, `median ${runs[10]} ms`);
});

// ---- the real Board: saved with the card, read back after a reload (src/board.ts) ----

// One VS Code stand-in for every real-Board test here: board.js keeps the one it was first loaded with. It opens no terminal.
class EventEmitter { listeners = []; event = (l) => (this.listeners.push(l), { dispose() {} }); fire(e) { for (const l of this.listeners) l(e); } dispose() {} }
const vscode = { EventEmitter, ThemeIcon: class {}, commands: { executeCommand: async () => {} }, Uri: { from: (p) => p }, workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined, createTerminal: () => { throw new Error("no terminal"); } } };

test("Board: the specification is saved in tasks.json with the settings the card runs with, and reads back the same after a reload", () => {
  const home = fs.mkdtempSync(path.join(scratch, "home-")), env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
  const boards = [];
  try {
    const { Board } = require("../out/board.js");
    const repo = fs.mkdtempSync(path.join(scratch, "repo-"));
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["commit", "-q", "--allow-empty", "-m", "init"]]) execFileSync("git", args, { cwd: repo });
    const board = new Board(repo, path.join(repo, "hook.js")); boards.push(board);
    const c = compile.saveCandidate(board.dir, "req-board", "new", "d", "", { account: "", model: "opus", effort: "high", permission: "edits" }, result(R1, board.dir));
    const task = board.add("Export", c.text, undefined, undefined, "opus", "high", undefined, { permission: "edits", spec: compile.newSpec(c) });
    assert.deepEqual([task.spec.execution.model, task.spec.execution.effort, task.spec.execution.permission, task.spec.execution.source], ["opus", "high", "edits", "user-selection"]);
    const saved = JSON.parse(fs.readFileSync(path.join(board.dir, "tasks.json"), "utf8")).find((t) => t.id === task.id);
    assert.equal(saved.spec.revisions[0].text, c.text, "persisted before any start");
    board.dispose();
    fs.writeFileSync(path.join(board.dir, "owner.json"), JSON.stringify({ pid: 999999999, at: Date.now() - 600_000 })); // the window closed: a reload
    const again = new Board(repo, path.join(repo, "hook.js")); boards.push(again);
    const back = again.get(task.id);
    const spec = compile.readSpec(back.spec);
    assert.equal(spec.specId, task.spec.specId);
    const launch = compile.launchReceipt(spec, back, "launch");
    assert.deepEqual([launch.replay, launch.carried, launch.drift], ["exact", true, []], "the reloaded card replays its saved render byte for byte");
    assert.equal(compile.renderExecutionPrompt(spec.revisions[0].record).text, back.prompt);
    // An older card without a spec reads as before: nothing is retrofitted.
    // The Orchestrator tickbox runs the card with Bypass: recorded as set by the form's option, not as the user's pick.
    const c2 = compile.saveCandidate(again.dir, "req-orch", "new", "d", "", { account: "", model: "opus", effort: "high", permission: "" }, result(R1, again.dir));
    const orch = again.add("Orchestrate", c2.text, undefined, undefined, "opus", "high", undefined, { permission: "bypass", orchestrator: { caps: again.capsOf(), opened: 0 }, headless: true, spec: compile.newSpec(c2) });
    assert.deepEqual([orch.spec.execution.permission, orch.spec.execution.configured], ["bypass", ["permission: default → bypass (Orchestrator)"]]);
    assert.equal(task.spec.execution.configured, undefined, "nothing was changed on the first card");
    const raw = again.add("Raw", "Just do it.");
    assert.equal(raw.spec, undefined);
    assert.equal(compile.specSummary(raw.spec), undefined);
  } finally {
    for (const b of boards) b.dispose();
    Module._load = load;
    process.env.HOME = env.HOME; process.env.USERPROFILE = env.USERPROFILE;
  }
});

// ---- board-internal starts (src/board.ts): plan steps, orchestrator children and battle cards write the start handler's receipt ----

/** A real Board in a throwaway repo whose sessions are stand-ins: no terminal, process or model. Each card it adds under another card
 *  carries an Improve-bound specification, as a card added through Add task would; the route under test then starts it. */
async function withStarts(fn) {
  const home = fs.mkdtempSync(path.join(scratch, "home-")), env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
  let board;
  try {
    const { Board } = require("../out/board.js");
    const repo = fs.mkdtempSync(path.join(scratch, "repo-"));
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["commit", "-q", "--allow-empty", "-m", "init"]]) execFileSync("git", args, { cwd: repo });
    board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
    const accounts = [{ name: "acct", configDir: path.join(home, "acct") }];
    Object.assign(board, { accountList: () => accounts, accountFolderList: () => accounts.map((a) => a.configDir), preflightHeadless: async () => {}, requestRateMs: 0 });
    board.tick();
    const starts = [], spec = compile.newSpec(save(board.dir, "req-route"));
    // The session stand-ins sit below the start functions under test (startHeadless, startInCard), so those run as written.
    board.startHeadlessNow = async (t) => { starts.push(["headless", t.id]); board.update(t, { sessionId: `h-${t.id}` }); };
    board.start = async (t) => { starts.push(["card terminal", t.id]); board.update(t, { sessionId: `s-${t.id}` }); };
    const add = board.add.bind(board);
    board.add = (...args) => {
      const t = add(...args);
      if (args[3]) {
        const specCopy = structuredClone(spec);
        if (args[8]) t.spec = specCopy; // runPlan publishes this staged card with the rest of its batch
        else board.update(t, { spec: specCopy });
      }
      return t;
    };
    await fn({ board, repo, starts });
  } finally {
    board?.dispose();
    Module._load = load;
    process.env.HOME = env.HOME; process.env.USERPROFILE = env.USERPROFILE;
  }
}
// The spec carries the settings it was improved with (opus, high, edits); the route's own picks show as drift, as on a handler start.
const receipts = (t) => t.spec.launches.map((l) => [l.kind, l.replay, l.revision, l.drift]);
async function inbox(board, body) {
  const dir = path.join(board.dir, "inbox"), nonce = `n${++n}`;
  fs.writeFileSync(path.join(dir, `${nonce}.json`), JSON.stringify({ v: 1, at: "now", ...body }));
  await board.processInbox();
  for (let i = 0; i < 40 && !fs.existsSync(path.join(dir, "done", `${nonce}.json`)); i++) await new Promise((r) => setTimeout(r, 50));
  return JSON.parse(fs.readFileSync(path.join(dir, "done", `${nonce}.json`), "utf8"));
}

test("plan step: a step runPlan starts at once writes the start handler's launch receipt with its replay result", () => withStarts(async ({ board, repo, starts }) => {
  fs.mkdirSync(path.join(repo, "workflows"));
  fs.writeFileSync(path.join(repo, "workflows", "checks.json"), JSON.stringify({ unit: { run: "npm test" } }));
  const file = path.join(repo, "workflows", "route.plan.json");
  const { steps: [first, second] } = await board.runPlan({ v: 1, name: "Route", review: "checks", steps: [
    { id: "a", title: "A", goal: "Do a.", checks: ["unit"] }, { id: "b", title: "B", goal: "Do b.", checks: ["unit"], after: ["a"] }] }, file);
  assert.deepEqual(starts, [["headless", first.id]], "only the step that waits for nothing started");
  assert.deepEqual(receipts(first), [["launch", "exact", 1, ["model: opus → default", "effort: high → default", "permission: edits → default"]]]);
  assert.deepEqual([second.held, second.spec.launches], [true, []], "a held step has no receipt until it starts");
}));

test("orchestrator child: a card opened with board.js add writes the start handler's launch receipt with its replay result", () => withStarts(async ({ board, starts }) => {
  const m = board.add("Orchestrate", "p", "acct", undefined, undefined, undefined, undefined, { orchestrator: { caps: board.capsOf(), opened: 0 }, headless: true, approved: { at: "x", hash: "h" } });
  board.update(m, { sessionId: "s-m", status: "review" });
  const r = await inbox(board, { op: "add", by: m.id, session: "s-m", title: "Helper", prompt: "Write the lexer.", model: "haiku", effort: "low", permission: "edits" });
  assert.deepEqual([r.error, r.started], [undefined, true]);
  const child = board.get(r.id);
  assert.deepEqual(starts, [["headless", child.id]]);
  assert.deepEqual(receipts(child), [["launch", "exact", 1, ["model: opus → haiku", "effort: high → low"]]]);
  assert.equal(m.spec, undefined, "the orchestrator itself was not started here");
}));

test("battle card: a card a battle's orchestrator opens starts in its card terminal and writes the launch receipt with its replay result", () => withStarts(async ({ board, starts }) => {
  const m = board.add("Race · Claude", "Battle Royale: …", "acct", undefined, undefined, undefined, undefined,
    { permission: "bypass", cardTerminal: true, battle: "b4771e00", ...require("../out/orchestrator.js").battleRun(board.capsOf()) });
  board.update(m, { sessionId: "s-m", status: "review" });
  const r = await inbox(board, { op: "add", by: m.id, session: "s-m", title: "Helper", prompt: "Write the lexer.", model: "haiku", effort: "low" });
  assert.deepEqual([r.error, r.started], [undefined, true]);
  const card = board.get(r.id);
  assert.deepEqual([card.battle, card.cardTerminal, starts], ["b4771e00", true, [["card terminal", card.id]]]);
  assert.deepEqual(receipts(card), [["launch", "exact", 1, ["model: opus → haiku", "effort: high → low", "permission: edits → bypass"]]]);
  // An unreadable specification refuses the next board-internal start before any effect, as the start handler refuses it.
  board.update(card, { sessionId: undefined, spec: { ...card.spec, version: 2 } });
  await assert.rejects(board.startInCard(card), /cannot read/);
  await assert.rejects(board.startHeadless(card), /cannot read/);
  assert.equal(starts.length, 1);
}));

// ---- the webview (media/board.js) in headless Edge or Chrome ----

const cdp = require("./compile-webview-cdp");
test("webview: settings preview, Apply refused after a setting changes, edit-after-Apply notice, refused Add keeps the result, 180 px, keyboard, card chips", { timeout: 120_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview scenario was not run."); return; }
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const profile = fs.mkdtempSync(path.join(scratch, "edge-"));
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, profile); } catch (e) { t.skip(`Edge could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading");
    await page.evaluate(cdp.HELPERS);
    const ev = (expr) => page.evaluate(expr);
    const D = "Add CSV export for the filtered table.";
    const X = compile.renderExecutionPrompt(R1).text;
    await ev(`__h.setBox(${JSON.stringify(D)}); __h.click("Improve prompt")`);
    const req = await ev("__h.lastCompile()");
    const permission = await ev(`document.querySelector('select[aria-label="Permission mode for new task"]')?.value ?? null`);
    assert.deepEqual([req.model, req.effort, req.permission], ["opus", "high", permission], "Improve carries the permission so the host can bind all four settings");
    const controls = { account: "acct", model: "opus", effort: "high", permission };
    await ev(`__h.inject(${JSON.stringify({ requestId: req.requestId, target: "new", original: D, status: "ready", record: R1, rendered: { format: "prose", text: X }, conflicts: [], model: "claude-fable-5-2", effort: "max", promptVersion: "p", controls, bindable: true })})`);
    const muted = await ev("__h.muted()");
    assert.ok(muted.includes(`Runs with your settings: acct · opus · high effort · ${permission === "bypass" ? "Bypass permissions" : "?"}`), muted.join(" | "));
    assert.ok(muted.includes("Capabilities: Provider defaults (the account's own MCP servers, skills and plugins, as the provider is set up). Improve does not change these settings."));
    // A setting changed after Improve: Apply is refused and the alert says which.
    await ev(`__h.select("Model for new task", "sonnet")`);
    assert.ok((await ev("__h.buttons()")).includes("Apply improved prompt (disabled)"));
    assert.deepEqual(await ev("__h.alerts()"), ["Settings changed after Improve (model: opus → sonnet). Improve again to keep the improved specification, or send the text as written without it."]);
    await ev(`__h.select("Model for new task", "opus")`);
    assert.deepEqual(await ev("__h.alerts()"), []);
    // Keyboard: Apply is a focusable native button that Enter activates.
    await ev(`__h.btn("Apply improved prompt").focus(); true`);
    assert.equal(await ev("document.activeElement.textContent"), "Apply improved prompt");
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await cdp.waitFor(async () => (await ev("__h.value()")) === X, "Enter on Apply to apply the improved prompt");
    await ev(`__h.setBox(${JSON.stringify(X + " Also log it.")})`);
    assert.deepEqual(await ev("__h.alerts()"), ["Your draft changed after Apply, so it will be sent as written, without the improved specification. Improve again to keep it."]);
    await ev(`__h.setBox(${JSON.stringify(X)})`);
    assert.deepEqual(await ev("__h.alerts()"), []);
    // 180 px side bar: no sideways scroll, and the settings line and Apply's row stay inside the panel.
    await page.send("Emulation.setDeviceMetricsOverride", { width: 180, height: 900, deviceScaleFactor: 1, mobile: false });
    const fit = await ev(`(() => { const w = document.documentElement.clientWidth, line = [...document.querySelectorAll(".compilation .muted")].find((e) => e.textContent.startsWith("Runs with"));
      const r = line.getBoundingClientRect(), b = __h.btn("Restore original").getBoundingClientRect();
      return { scroll: document.documentElement.scrollWidth - w, line: r.right <= w && r.left >= 0, button: b.right <= w && b.left >= 0 }; })()`);
    assert.deepEqual(fit, { scroll: 0, line: true, button: true });
    await page.send("Emulation.clearDeviceMetricsOverride");
    // Add task: the host gets the text, the four settings and the Improve run that shaped it; a refused Add gives both back.
    await ev(`[...document.querySelectorAll("button")].find((b) => b.textContent === "Add task").click(); true`);
    const create = await ev(`window.__posted.filter((m) => m.type === "create").at(-1)`);
    assert.deepEqual([create.prompt, create.model, create.effort, create.permission, create.helpers], [X, "opus", "high", permission, [{ requestId: req.requestId, kind: "improve", edited: false }]]);
    assert.equal(await ev("__h.value()"), "");
    await ev(`window.__host({ failed: window.__posted.filter((m) => m.type === "create").at(-1) }); true`);
    assert.equal(await ev("__h.value()"), X);
    assert.ok((await ev("__h.buttons()")).includes("Restore original"), "the applied Improve result came back with the text");
    // Card chips: revision and ids, settings changed since Improve, an unreadable spec.
    const summary = { revision: 2, requirements: ["R-01", "R-03"], acceptance: ["A-01"], superseded: ["R-02"], format: "prose", rendererVersion: compile.RENDERER_VERSION,
      execution: { account: "acct", model: "opus", effort: "high", permission: "edits" }, last: { kind: "resume", replay: "not-sent", drift: ["model: opus → sonnet"] } };
    await ev(`window.__host({ tasks: [{ id: "c1", title: "Export", prompt: "p", status: "review", specSummary: ${JSON.stringify(summary)} }, { id: "c2", title: "Newer", prompt: "p", status: "queued", specSummary: { error: "version 2" } }], live: [], own: [], accounts: ["acct"] }); true`);
    const chips = await ev(`[...document.querySelectorAll(".chip")].map((c) => [c.textContent, c.title])`);
    const chip = (text) => chips.find(([t]) => t === text);
    assert.match(chip("Improved spec r2")[1], /^Accepted from Improve prompt: R-01, R-03, A-01; replaced R-02\. Settings: acct · opus · high effort · Accept edits\. Capabilities: Provider defaults\.$/);
    assert.equal(chip("Settings changed since Improve")[1], "model: opus → sonnet");
    assert.equal(chip("Specification unreadable")[1], "version 2");
  } finally {
    page?.close();
    if (edge) await edge.kill();
  }
});
