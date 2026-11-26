// Plan files (F72; src/plan.ts): the schema's refusals, the fixed step prompt, finding the files, and the
// board running a plan: the plan card and its steps, the board merging a passed step itself ("checks"), its automatic follow-ups and
// "Needs you", and a "model" plan's reviewer getting the settle notice. Same VS Code stand-in as test/orchestrator-board.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

class EventEmitter {
  listeners = [];
  event = (l) => (this.listeners.push(l), { dispose() {} });
  fire(e) { for (const l of this.listeners) l(e); }
  dispose() {}
}
const terminals = [];
const vscode = { EventEmitter, ThemeIcon: class {}, TabInputCustom: class { constructor(uri) { this.uri = uri; } }, ViewColumn: { Beside: -2 },
  commands: { executeCommand: async () => {} },
  Uri: { from: (parts) => ({ ...parts, toString: () => `${parts.scheme}://${parts.authority}${parts.path}` }), file: (p) => ({ fsPath: p }) },
  workspace: { openTextDocument: async (o) => ({ content: o?.content }), getConfiguration: () => ({ get: (_k, d) => d }) },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined, showInformationMessage: async () => undefined, showTextDocument: async () => undefined,
    createTerminal: (options) => { const t = { options, shows: [], sent: [], show: (p) => t.shows.push(p), dispose() { t.exitStatus = { code: 0 }; vscode.window.terminals = vscode.window.terminals.filter((x) => x !== t); }, exit(code = 0) { t.exitStatus = { code }; vscode.window.terminals = vscode.window.terminals.filter((x) => x !== t); }, sendText: (text) => t.sent.push(text), exitStatus: undefined, processId: Promise.resolve(4242) };
      terminals.push(t); vscode.window.terminals.push(t); return t; } } };
const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-plan-home-"));
process.env.HOME = process.env.USERPROFILE = home;
process.env.ENTOMATICAL_USAGE_DIR = path.join(home, "usage");
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board } = require("../out/board.js");
const P = require("../out/plan.js");
const q = require("../out/queue.js");

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const made = [], boards = [];
test.after(() => { for (const b of boards) b.dispose(); for (const d of made) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 30 s: 5 s timed out under the full suite's load (11 November 2026); a met condition returns at once.
const until = async (what, ok, ms = 30000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (ok()) return; assert.fail(`timed out waiting for ${what}`); };

const CATALOGUE = { unit: { run: "npm test" }, lint: { run: "npm run lint" } };
const RULES = { catalogue: CATALOGUE, models: ["opus", "sonnet", "haiku", "fable"], efforts: ["low", "medium", "high", "xhigh", "max"], permissions: ["ask", "edits", "auto", "bypass"], accounts: ["acct"], maxSteps: 12, cards: ["abc123"] };
const plan = (extra = {}, steps) => ({ v: 1, name: "Tidy", review: "checks", steps: steps ?? [
  { id: "fix", title: "Fix the text", goal: "Make the line say which card.", files: ["src/queue.ts"], avoid: ["media/"], checks: ["unit"], reply: "the commit id" },
  { id: "docs", title: "Describe it", goal: "Update the docs.", checks: ["lint"], after: ["fix"] }], ...extra });
const errorsOf = (raw, rules = RULES) => { const v = P.validatePlanFile(raw, rules); return "errors" in v ? v.errors : []; };

test("effective expansion rejects blank titles, oversized fields, multiline paths and control overrides", () => {
  const base = (field, value) => plan({ vars: { value } }, [{ id: "a", title: "Title", goal: "Goal", checks: ["unit"], [field]: field === "files" ? ["{{value}}"] : "{{value}}" }]);
  for (const [field, value] of [["title", ""], ["source", "x".repeat(301)], ["reply", "x".repeat(501)], ["files", "one\ntwo"]]) assert.ok("errors" in P.validatePlanFile(base(field, value), RULES), field);
  const huge = base("goal", "x".repeat(2000)); huge.steps[0].goal = "{{value}}{{value}}{{value}}";
  assert.ok("errors" in P.validatePlanFile(huge, RULES));
  assert.ok("errors" in P.validatePlanFile(base("title", "ok"), RULES, { value: "bad\u0001" }));
  assert.ok("errors" in P.validatePlanFile(plan({ about: null }), RULES));
});

const governedPlan = (extra = {}) => plan({ v: 2, reusable: true, review: "model", permission: "auto", reviewer: { permission: "ask" },
  execution: { limits: { active: 3, directChildren: 2, depth: 1 }, allowed: ["provider-defaults"], defaultChild: "provider-defaults" }, ...extra }, [
  { id: "assess", title: "Assess", goal: "Write a report", source: "a.txt", checks: ["unit"], contract: { reads: ["a.txt"], writes: ["report.md"], artifacts: ["report.md"], acceptance: ["Traceable report"], resources: ["named:router"] } },
  { id: "handoff", title: "Handoff", goal: "Write a handoff", after: ["assess"], checks: ["unit"], contract: { reads: ["a.txt"], writes: ["handoff.md"], artifacts: ["handoff.md"], acceptance: ["Actionable handoff"], resources: ["named:router"] } }
]);

test("v2 typed lists preserve spaces and commas; explicit inputs, scope and settings are validated", () => {
  const raw = governedPlan({ inputs: { targets: { type: "list", required: true, default: ["Living room", "Office, upstairs"] } } });
  raw.steps = [{ ...raw.steps[0], title: "Check {{item}}", each: "targets" }];
  const v = P.validatePlanFile(raw, RULES);
  assert.ok(!("errors" in v), JSON.stringify(v));
  assert.deepEqual(v.cards.map((c) => c.step.title), ["Check Living room", "Check Office, upstairs"]);
  assert.ok("errors" in P.validatePlanFile(raw, RULES, { targets: "A B" }));
  assert.ok("errors" in P.validatePlanFile(raw, RULES, { targets: [] }));
  raw.steps[0].contract.writes = ["../outside"];
  assert.ok("errors" in P.validatePlanFile(raw, RULES));
});

test("malformed dependency values are reported instead of throwing", () => {
  for (const after of ["fix", 7, { id: "fix" }, ["fix", 7]]) {
    const invalid = plan({}, [{ id: "docs", title: "Docs", goal: "Update the docs.", checks: ["unit"], after }]);
    assert.match(errorsOf(invalid).join(" "), /"after" must be a list of step ids/);
  }
});

test("standing role settings are validated and disclosed, including their card capacity", () => {
  const raw = plan({ judge: "sonnet", scribe: { model: "haiku", documents: ["REPORT.md"], after: ["fix"] } });
  raw.steps[0].judge = true;
  const result = P.validatePlanFile(raw, RULES);
  assert.ok("cards" in result);
  const preview = P.planPreview(result.plan, result.cards, CATALOGUE).join("\n");
  assert.match(preview, /Standing judge: sonnet/);
  assert.match(preview, /Standing scribe: haiku on the default account; bypass permissions; updates REPORT.md after fix/);
  assert.match(preview, /Standing roles start only when needed/);
  assert.match(preview, /Fix the text.*judged/);
  assert.match(errorsOf(raw, { ...RULES, maxSteps: 3 }).join(" "), /4 cards \(2 steps and 2 standing roles\)/);
  const bad = plan({ scribe: { model: "missing", documents: [], after: ["missing"], typo: true } });
  bad.steps[0].judge = true;
  const errors = errorsOf(bad).join(" ");
  for (const message of [/Unknown field "typo" in "scribe"/, /"scribe.model" must be one of/, /scribe.documents.*at least one/, /Scribe waits for unknown step/, /requests a judge.*no judge model/]) assert.match(errors, message);
});

test("a plan file is checked as a whole: every problem is listed at once, unknown fields refused, nothing missing passes", () => {
  assert.deepEqual(errorsOf(plan()), []);
  const errors = errorsOf({ v: 3, name: "two\nlines", review: "maybe", colour: "red", steps: [
    { id: "Fix", title: "x", goal: "" , checks: ["nope"], typo: 1 },
    { id: "b", title: "b", goal: "b", checks: ["unit"], after: ["b", "ghost"], model: "gpt", effort: "huge", permission: "root" },
    { id: "b", title: "c", goal: "c", checks: [] }] });
  for (const want of [/^Unknown field "colour" at the top/, /^"v" must be 1/, /^"name" must be one line/, /^"review" must be "checks"/, /Unknown field "typo" in Step "Fix"/,
    /Step "Fix": "id" must be lowercase/, /Step "Fix" "goal" must be text and not empty/, /check "nope" is not in workflows\/checks.json \(it has unit, lint\)/,
    /Step "b" "model" must be one of/, /Step "b" "effort" must be one of/, /Step "b" "permission" must be one of/, /Step "b": the id is used twice/,
    /Step "b" waits for itself/, /Step "b" waits for "ghost", which is neither a step of this plan nor a card on the board/])
    assert.ok(errors.some((e) => want.test(e)), `${want} in\n${errors.join("\n")}`);
  assert.match(errorsOf(plan({}, [{ id: "a", title: "a", goal: "a", checks: [] }]))[0], /^Step "a" names no checks\. With "review": "checks"/);
});

test("waits: a circle is refused, a card on the board may be waited for, and checks are required only when checks decide", () => {
  const circle = errorsOf(plan({}, [{ id: "a", title: "a", goal: "a", checks: ["unit"], after: ["c"] }, { id: "b", title: "b", goal: "b", checks: ["unit"], after: ["a"] }, { id: "c", title: "c", goal: "c", checks: ["unit"], after: ["b"] }]));
  assert.ok(circle.some((e) => /^Steps wait for each other in a circle: a → c → b → a\.$/.test(e)), circle.join("\n"));
  assert.deepEqual(errorsOf(plan({}, [{ id: "a", title: "a", goal: "a", checks: ["unit"], after: ["abc123"] }])), [], "a card on the board");
  assert.match(errorsOf(plan({}, [{ id: "a", title: "a", goal: "a", checks: ["unit"], after: ["fff000"] }]))[0], /neither a step of this plan nor a card/);
  assert.deepEqual(errorsOf(plan({ review: "model", reviewer: { model: "sonnet", effort: "low" } }, [{ id: "a", title: "a", goal: "a" }])), [], "a reviewed step may have no checks");
  assert.match(errorsOf(plan({ reviewer: { model: "sonnet" } }))[0], /"reviewer" is only for "review": "model"/);
  assert.match(errorsOf(plan(), { ...RULES, catalogue: undefined })[0], /no workflows\/checks.json/);
  assert.match(errorsOf(plan({ account: "Codex · someone" }))[0], /is not a signed-in account\./);
  assert.match(errorsOf(plan(), { ...RULES, maxSteps: 1 })[0], /^This plan makes 2 cards; a run may have at most 1/);
});

/** The cards a valid plan makes (the test fails on any problem). */
const cardsOf = (raw, vars, rules = RULES) => { const v = P.validatePlanFile(raw, rules, vars); assert.ok(!("errors" in v), "errors" in v ? v.errors.join("\n") : ""); return v; };

test("vars and each: a step repeats per item with {{…}} filled in, after waits for all its cards, the user's values replace the file's, and every misuse is refused", () => {
  const raw = plan({ vars: { features: "F14 F23", target: "Windows" } }, [
    { id: "check", title: "Check {{feature}} on {{target}}", goal: "Check {{feature}}.", files: ["docs/{{feature}}.md"], each: "features", checks: ["unit"], reply: "{{feature}}: done or not" },
    { id: "notes", title: "Notes for {{features}}", goal: "Sum up.", checks: ["lint"], after: ["check"] }]);
  let { plan: p, cards } = cardsOf(raw);
  assert.deepEqual(cards.map((c) => [c.key, c.step.title, c.item, c.after]), [
    ["check[1]", "Check F14 on Windows", "F14", []], ["check[2]", "Check F23 on Windows", "F23", []], ["notes", "Notes for F14 F23", undefined, ["check[1]", "check[2]"]]]);
  assert.deepEqual([cards[1].step.goal, cards[1].step.files, cards[1].step.reply, p.vars], ["Check F23.", ["docs/F23.md"], "F23: done or not", { features: "F14 F23", target: "Windows" }]);
  assert.match(P.stepPrompt(p, cards, 2, "c0ffee", CATALOGUE), /^Step 3 of 3 of plan "Tidy" \(plan card c0ffee\)\. Your branch starts from the plan's branch, which already holds "Check F14 on Windows", "Check F23 on Windows"\./);
  // the user's answers before Run; a list with ; splits there, so items may hold spaces; `as` names the item.
  ({ cards } = cardsOf(plan({ vars: { qs: "What is A?; Why B?" } }, [{ id: "r", title: "Ask: {{q}}", goal: "{{q}}", each: "qs", as: "q", checks: ["unit"] }]), { qs: "One?;Two?;Three?" }));
  assert.deepEqual(cards.map((c) => c.step.title), ["Ask: One?", "Ask: Two?", "Ask: Three?"]);
  const errors = errorsOf(plan({ vars: { features: "", "bad name": "x" } }, [
    { id: "a", title: "{{nope}}", goal: "g", checks: ["unit"], each: "missing" }, { id: "b", title: "b", goal: "g", checks: ["unit"], as: "x" }]), RULES);
  for (const want of [/^Variable "bad name" must be a name/, /Step "a": unknown variable \{\{nope\}\}/, /Step "a": "each" must name one of the plan's variables \(features\)/, /Step "b": "as" needs "each"/])
    assert.ok(errors.some((e) => want.test(e)), `${want} in\n${errors.join("\n")}`);
  assert.match(errorsOf(plan({ vars: { features: " " } }, [{ id: "a", title: "{{feature}}", goal: "g", checks: ["unit"], each: "features" }]))[0], /its each list "features" is empty/);
  assert.match(P.validatePlanFile(raw, RULES, { other: "x" }).errors[0], /^The plan has no variable "other"/);
  assert.match(errorsOf(raw, { ...RULES, maxSteps: 2 })[0], /^This plan makes 3 cards; a run may have at most 2/);
});

test("every step gets the same prompt template, filled in from its fields; every shipped plan file is valid", () => {
  const p0 = plan(); p0.steps[1].source = "plan.json#K-1";
  const { plan: p, cards } = cardsOf(p0), text = P.stepPrompt(p, cards, 1, "c0ffee", CATALOGUE);
  assert.equal(text, [
    `Step 2 of 2 of plan "Tidy" (plan card c0ffee). Your branch starts from the plan's branch, which already holds "Fix the text".`,
    "Goal:\nUpdate the docs.\n\nThe full task is written down: read plan.json#K-1 before you start, and follow it.",
    ["Work in: the files the goal needs.", "Do not touch: never push, merge into main, or change settings or CLAUDE.md.",
      "When you finish, the board runs these checks in your worktree: lint (npm run lint). Run them yourself first and fix what fails.",
      "Commit your work on this branch before you finish.",
      "Nobody can answer questions while you work. If something blocks you, stop and say what blocked you in your last reply.",
      `Your last reply must contain: ${P.DEFAULT_REPLY}.`].join("\n")].join("\n\n"));
  assert.match(P.stepPrompt(p, cards, 0, "c0ffee", CATALOGUE), /Work in: src\/queue.ts\.\nDo not touch: media\/\. Also never push/);
  const repo = path.join(__dirname, "..");
  // The example plans (docs/agents/examples/). Cards' own plans also land in workflows/ (F98 commits them on main); the picker shows their
  // problems, so this test judges only the examples.
  const EXAMPLES = ["docs/agents/examples/example.plan.json", "docs/agents/examples/parity-sweep.plan.json", "docs/agents/examples/research-write.plan.json", "docs/agents/examples/test-fix.plan.json"];
  const shipped = EXAMPLES.map((rel) => P.describePlanFile(repo, path.join(repo, rel))), catalogue = JSON.parse(fs.readFileSync(path.join(repo, "workflows", "checks.json"), "utf8"));
  assert.deepEqual(shipped.map((f) => f.error), EXAMPLES.map(() => undefined));
  for (const f of shipped) assert.deepEqual(errorsOf(P.loadPlanFile(f.file), { ...RULES, catalogue, accounts: undefined, maxSteps: 12 }), [], f.rel);
  assert.deepEqual(shipped.find((f) => f.rel === "docs/agents/examples/parity-sweep.plan.json").vars, { features: "F14 F23" });
});

test("the picker lists every .json in workflows/ except checks.json, and reads a plan file anywhere (the user, 8 November 2026)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-plan-list-"));
  made.push(repo);
  const plan = JSON.stringify({ v: 1, name: "Mine", about: "a plan without the suffix", review: "checks", steps: [] });
  fs.mkdirSync(path.join(repo, "workflows")); fs.mkdirSync(path.join(repo, ".entomatical", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(repo, "workflows", "checks.json"), "{}");
  fs.writeFileSync(path.join(repo, "workflows", "mine.json"), plan);
  fs.writeFileSync(path.join(repo, "workflows", "Upper.JSON"), "{ not json");
  fs.writeFileSync(path.join(repo, "workflows", "other.json"), JSON.stringify({ hello: 1 }));
  fs.mkdirSync(path.join(repo, "workflows", "dir.json"));
  fs.writeFileSync(path.join(repo, ".entomatical", "workflows", "private.plan.json"), plan);
  const found = P.findPlanFiles(repo);
  assert.deepEqual(found.map((f) => [f.rel, f.shared]), [["workflows/Upper.JSON", true], ["workflows/mine.json", true], ["workflows/other.json", true], [".entomatical/workflows/private.plan.json", false]]);
  assert.equal(found[1].name, "Mine"); assert.equal(found[1].about, "a plan without the suffix"); assert.equal(found[1].error, undefined);
  assert.match(found[0].error, /^not valid JSON/);
  assert.equal(found[2].error, 'not a plan file (it has no "steps" list)');
  // Dated names (hook/plan-folder.js gives every new plan one) come first, newest first; undated ones follow by name.
  for (const n of ["2026-11-12-b.plan.json", "2026-11-14-a.plan.json", "2026-11-14-c.plan.json"]) fs.writeFileSync(path.join(repo, "workflows", n), plan);
  assert.deepEqual(P.findPlanFiles(repo).filter((f) => f.shared).map((f) => f.rel.slice("workflows/".length)),
    ["2026-11-14-a.plan.json", "2026-11-14-c.plan.json", "2026-11-12-b.plan.json", "Upper.JSON", "mine.json", "other.json"]);
  for (const n of ["2026-11-12-b.plan.json", "2026-11-14-a.plan.json", "2026-11-14-c.plan.json"]) fs.rmSync(path.join(repo, "workflows", n));
  const elsewhere = path.join(repo, "..", path.basename(repo) + "-outside.json");
  fs.writeFileSync(elsewhere, plan); made.push(elsewhere);
  const d = P.describePlanFile(repo, elsewhere);
  assert.equal(d.name, "Mine"); assert.equal(d.shared, false); assert.equal(d.rel, `../${path.basename(elsewhere)}`);
});

/** A throwaway repo with a check catalogue and a board that owns it, one signed-in Claude account "acct". */
function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-plan-"));
  made.push(repo);
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t"); sh(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  fs.mkdirSync(path.join(repo, "workflows")); fs.writeFileSync(path.join(repo, "workflows", "checks.json"), JSON.stringify(CATALOGUE));
  const file = path.join(repo, "workflows", "tidy.plan.json");
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  boards.push(board);
  board.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }];
  board.accountFolderList = () => [path.join(home, "acct")];
  board.requestRateMs = 0;
  board.checks.start = (t) => { if (t.completion?.commands.length && t.worktree) board.recordChecks(t, { status: "running", run: "mock", revision: sh(t.worktree, "rev-parse", "HEAD") }); }; // tests finish each check by hand
  board.tick();
  const runEvents = [];
  board.onRun((e) => runEvents.push(e));
  return { repo, board, file, runEvents };
}
const event = (board, id, e) => fs.appendFileSync(board.eventsFile(id), JSON.stringify({ t: Date.now(), ...e }) + "\n");
/** The step's hidden run comes up and works. */
const running = (board, t) => { event(board, t.id, { hook_event_name: "SessionStart", session_id: t.sessionId }); event(board, t.id, { hook_event_name: "UserPromptSubmit", prompt: "p" }); board.syncStatus(t.id); };
/** Its hidden run ends with a Stop: the card goes to Review. */
const settle = (board, t) => { terminals.find((x) => x.options.name === `En ${t.id}` && !x.exitStatus)?.exit(0); event(board, t.id, { hook_event_name: "Stop", last_assistant_message: "done" }); board.syncStatus(t.id); };
const FAILED = { status: "error", run: "", error: "npm test exited 1", failure: { command: "npm test", exitCode: 1, lines: ["not ok 3 - queue waits"], tail: "1 failing", log: "log.txt" } };
const finishChecks = async (board, t, result) => { await until("checks to start", () => t.checks?.status === "running", 30000); board.recordChecks(t, { ...result, revision: t.checks.revision }); };

const setupReceipt = (file) => ({ sourceHash: require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'), configHash: 'configuration-under-test' });

test('setup source changed after approval is refused before any card is created', async () => {
  const { board, file } = fixture(), raw = plan();
  fs.writeFileSync(file, JSON.stringify(raw));
  const receipt = setupReceipt(file);
  fs.writeFileSync(file, JSON.stringify({ ...raw, name: 'Changed after approval' }));
  const before = board.tasks.map(t => t.id);
  await assert.rejects(board.runPlan(raw, file, {}, undefined, receipt), /changed or disappeared/);
  assert.deepEqual(board.tasks.map(t => t.id), before);
});

test('prepared setup survives a failed root start and can resume the same cards after reload', async () => {
  const { repo, board, file } = fixture(), raw = plan();
  fs.writeFileSync(file, JSON.stringify(raw));
  const receipt = setupReceipt(file);
  board.ensureWorktree = async () => { throw new Error('injected worktree creation failure'); };
  await assert.rejects(board.runPlan(raw, file, {}, undefined, receipt), /injected worktree creation failure/);
  const root = board.tasks.find(t => t.planRun);
  assert.ok(root); assert.equal(root.planRun.setupState, 'prepared');
  assert.match(root.launchError, /injected worktree creation failure.*retry this card/);
  assert.ok(board.tasks.filter(t => t.openedBy === root.id).every(t => !t.sessionId && !t.held));
  const ids = board.tasks.map(t => t.id);
  board.dispose();
  const next = new Board(repo, path.join(repo, 'hook.js'), undefined, false); boards.push(next);
  next.accountList = () => [{ name: 'acct', configDir: path.join(home, 'acct') }];
  next.accountFolderList = () => [path.join(home, 'acct')]; next.tick();
  assert.equal(next.get(root.id).planRun.setupState, 'prepared');
  const result = await next.runPlan(P.loadPlanFile(file), file, {}, undefined, setupReceipt(file));
  assert.equal(result.card.id, root.id);
  assert.equal(result.card.launchError, undefined);
  assert.equal(result.card.planRun.setupState, 'started');
  assert.deepEqual(result.steps.map(t => !!t.sessionId), [true, false]);
  assert.deepEqual(next.tasks.map(t => t.id), ids);
});

test("plan creation publishes a fully wired graph once and a late card-construction failure leaves the board intact", async () => {
  const { board, file } = fixture(), original = board.add("Existing", "Existing work");
  const raw = plan({}, Array.from({ length: 8 }, (_, i) => ({ id: "s" + i, title: "Step " + i, goal: "g", checks: ["unit"], ...(i ? { after: ["s" + (i - 1)] } : {}) })));
  const add = board.add.bind(board);
  board.add = (...args) => { if (args[0] === "Step 6") throw new Error("late card refusal"); return add(...args); };
  await assert.rejects(board.runPlan(raw, file), /late card refusal/);
  assert.deepEqual(board.tasks.map(t => t.id), [original.id]);
  assert.deepEqual(JSON.parse(fs.readFileSync(board.file, "utf8")).map(t => t.id), [original.id]);
  const snapshots = [];
  board.onChange(() => snapshots.push(board.tasks.filter(t => t.openedBy).map(t => ({ prompt: t.prompt, after: t.dependsOn }))));
  board.add = add;
  const setup = board.ensureWorktree.bind(board);
  board.ensureWorktree = async (task) => {
    if (task.planRun) {
      assert.equal(snapshots.length, 1, "all cards and dependencies became visible in one board save");
      assert.equal(snapshots[0].length, 8);
      assert.ok(snapshots[0].every((s, i) => s.prompt && (i === 0 || s.after?.length === 1)));
    }
    return setup(task);
  };
  await board.runPlan(raw, file);
});

test("overlapping starts of a one-shot plan share its assignments; variable plans remain reusable", async () => {
  const { board, file } = fixture(), raw = plan();
  fs.writeFileSync(file, JSON.stringify(raw));
  const [first, concurrent] = await Promise.all([board.runPlan(raw, file), board.runPlan(raw, file)]);
  assert.equal(concurrent.card.id, first.card.id);
  assert.equal(concurrent.reused, true);
  assert.deepEqual(board.tasks.map(t => t.id), [first.card, ...first.steps].map(t => t.id));
  const again = await board.runPlan(raw, file);
  assert.equal(again.card.id, first.card.id);
  const legacyDuplicate = board.add("Earlier duplicate", "", "acct", undefined, undefined, undefined, undefined, { planRun: { ...first.card.planRun }, approved: first.card.approved });
  await assert.rejects(board.runPlan(raw, file), new RegExp(`${first.card.id}, ${legacyDuplicate.id}`));
  const reusable = plan({ vars: { area: "queue" } });
  fs.writeFileSync(file, JSON.stringify(reusable));
  const a = await board.runPlan(reusable, file), b = await board.runPlan(reusable, file);
  assert.notEqual(a.card.id, b.card.id);
});

test("a Stop before worker exit retries its checks once the process has gone", async () => {
  const { board, file } = fixture();
  const { card, steps: [task] } = await board.runPlan(plan(), file);
  running(board, task);
  const ended = board.ended.bind(board);
  board.ended = (task) => ended(task, 0);
  event(board, task.id, { hook_event_name: "Stop", last_assistant_message: "done" });
  board.syncStatus(task.id);
  await until("durable exit wait", () => task.awaitingPlanExit === card.id);
  assert.equal(task.stepHold, undefined);
  assert.equal(task.checks, undefined);
  board.terminal(task).exit(0);
  board.tick();
  await until("checks after exit", () => task.checks?.status === "running");
  assert.equal(task.awaitingPlanExit, undefined);
  assert.equal(task.stepHold, undefined);
});

test("the first saved-plan dispatch retains a transient failure and the held queue retries the same assignment", async () => {
  const { board, file } = fixture();
  const start = board.startHeadless.bind(board);
  let tries = 0;
  board.startHeadless = async task => {
    if (++tries === 1) throw new Error("Provider temporarily unavailable");
    return start(task);
  };
  const { card, steps: [first] } = await board.runPlan(plan(), file);
  assert.deepEqual([first.held, first.launchError, first.stepHold, first.openedBy], [true, "Provider temporarily unavailable", undefined, card.id]);
  assert.ok(first.startRetryAt > Date.now());
  assert.equal((await board.dispatchHeld(first)).state, "retry");
  assert.equal(tries, 1);
  board.update(first, { startRetryAt: Date.now() - 1 });
  assert.equal((await board.dispatchHeld(first)).state, "started");
  assert.deepEqual([tries, first.held, first.launchError, first.startRetryAt], [2, undefined, undefined, undefined]);
  assert.ok(first.sessionId);
});

test('setup receipt retains a changed original plan instead of archiving or committing its replacement', async () => {
  const { repo, board, file } = fixture(), raw = plan();
  fs.writeFileSync(file, JSON.stringify(raw));
  const receipt = setupReceipt(file), head = sh(repo, 'rev-parse', 'HEAD');
  board.ensureWorktree = async () => {};
  board.startHeadless = async () => {};
  const { card } = await board.runPlan(raw, file, {}, undefined, receipt);
  assert.equal(card.planRun.setupState, 'started');
  const replacement = JSON.stringify({ ...raw, name: 'Replacement to preserve' });
  fs.writeFileSync(file, replacement);
  assert.match(board.archivePlan(card), /not archived.*original file changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), replacement);
  assert.equal(card.planRun.archived, undefined);
  assert.equal(fs.existsSync(path.join(repo, 'workflows', 'archive', 'tidy.plan.json')), false);
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), head);
});

test("v2 approval detects drift and creates idempotent governed assignments with durable resource admission", async () => {
  const { board, repo, file } = fixture(), raw = governedPlan();
  fs.writeFileSync(file, JSON.stringify(raw));
  const approval = board.previewPlan(raw, file);
  fs.writeFileSync(path.join(repo, "a.txt"), "changed");
  await assert.rejects(board.runPlan(raw, file, {}, approval), /source a.txt changed/);
  assert.equal(board.tasks.length, 0);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  const starts = [];
  board.startHeadless = async (t) => { await board.ensureWorktree(t); board.gate(t); starts.push(t.id); };
  const result = await board.runPlan(raw, file, {}, approval);
  assert.ok(result.card.governed);
  assert.equal(result.card.permission, "ask");
  assert.equal(result.steps[0].assignment.key, "assess");
  assert.equal(result.steps[1].held, true);
  assert.deepEqual(result.card.governed.delegation.allowed, ["provider-defaults"]);
  assert.equal(board.workflow.claims().filter((c) => c.resource === "named:router").length, 1);
  const again = await board.runPlan(raw, file, {}, approval);
  assert.equal(again.card.id, result.card.id);
  assert.equal(starts.length, 2, "replaying the same approval starts nothing again");
  const second = await board.runPlan(raw, file, {}, board.previewPlan(raw, file));
  assert.equal(second.steps[0].held, true, "another plan waits for the same physical resource");
  assert.equal(second.steps[0].workflow.attempt, undefined);
  fs.writeFileSync(path.join(repo, "workflows", "checks.json"), JSON.stringify({ ...CATALOGUE, unit: { run: "different" } }));
  assert.throws(() => board.gate(result.steps[0]), /Check unit changed/);
});

test("v2 gates bind action and evidence, stay queued before approval and cannot replay an ended attempt", async () => {
  const { board, file } = fixture(), raw = governedPlan();
  raw.steps[0].contract.gate = { action: "Inspect candidate", target: "router serial ABC", candidate: "commit-123", evidence: ["a.txt"] };
  fs.writeFileSync(file, JSON.stringify(raw));
  board.startHeadless = async (t) => { await board.ensureWorktree(t); board.gate(t); };
  const { steps: [step] } = await board.runPlan(raw, file, {}, board.previewPlan(raw, file));
  assert.equal(step.held, true);
  assert.equal(step.workflow.attempt, undefined);
  board.approveScope(step);
  board.gate(step);
  const W = require("../out/workflow.js"), restored = new W.WorkflowStore(board.workflow.dir);
  assert.equal(restored.approval(step.workflow.scope).used.length, 1);
  W.mark(step, restored, "ended");
  assert.throws(() => board.gate(step), /no replay/);
  step.workflow.scope.operations = ["Reboot instead"];
  assert.throws(() => board.approveScope(step), /action or evidence changed/);
});

test("v2 reload keeps manifest, assignment ownership and uncertain leases; non-reusable is explicit", async () => {
  const { board, repo, file } = fixture(), raw = governedPlan({ reusable: false });
  fs.writeFileSync(file, JSON.stringify(raw));
  board.startHeadless = async (t) => { await board.ensureWorktree(t); board.gate(t); };
  const approval = board.previewPlan(raw, file), { card, steps } = await board.runPlan(raw, file, {}, approval);
  await assert.rejects(board.runPlan(raw, file, {}, board.previewPlan(raw, file)), /not reusable/);
  const lease = structuredClone(card.governed.leases.find((l) => l.card === steps[0].id));
  board.dispose();
  const restored = new Board(repo, path.join(repo, "hook.js"), undefined, false); boards.push(restored);
  restored.accountList = board.accountList; restored.accountFolderList = board.accountFolderList; restored.tick();
  const result = await restored.runPlan(raw, file, {}, approval);
  assert.equal(result.card.id, card.id);
  assert.equal(result.card.planRun.approval.hash, approval.hash);
  assert.equal(result.steps[0].governedBy, card.id);
  assert.equal(result.steps[0].assignment.key, "assess");
  assert.deepEqual(result.card.governed.leases.find((l) => l.card === steps[0].id), lease);
  assert.equal(restored.workflow.claims()[0].task, steps[0].id);
  assert.throws(() => restored.gate(result.steps[0]), /earlier window/);
  result.card.governed.leases = []; // Even after the ordinary execution reservation expires, a possibly delivered action is not replayed.
  assert.throws(() => restored.gate(result.steps[0]), /earlier board owner.*no replay/);
});

test("v2 acceptance needs committed artifacts and integration rejects an out-of-scope commit even if reverted", async () => {
  const { board, file } = fixture(), raw = governedPlan();
  fs.writeFileSync(file, JSON.stringify(raw));
  board.startHeadless = async (t) => { await board.ensureWorktree(t); board.gate(t); };
  board.deliverNotices = () => {};
  const { card, steps: [step, next] } = await board.runPlan(raw, file, {}, board.previewPlan(raw, file));
  assert.match(await board.finishStandingRoles(card), /lacks accepted, integrated evidence/);
  assert.throws(() => board.closeStep(step, "accepted", ""), /Submit the committed work/);
  const base = sh(step.worktree, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(step.worktree, "report.md"), "Evidence\n");
  sh(step.worktree, "add", "report.md"); sh(step.worktree, "commit", "-qm", "report");
  const head = sh(step.worktree, "rev-parse", "HEAD");
  step.submission = { head, base, summary: "report", files: ["report.md"], checks: "complete", at: new Date().toISOString() };
  step.checks = { status: "complete", clean: true, revision: head, run: "checked" };
  board.closeStep(step, "accepted", "Report accepted; device acceptance remains open.");
  assert.match(board.readinessOf(next).text, /not integrated/);
  await board.integrate(step);
  assert.equal(board.readinessOf(next).state, "ready");
  const receipt = board.workflow.receipt(step.workflow.receipt);
  receipt.evidence["report.md"] = "changed"; board.workflow.saveReceipt(receipt);
  assert.match(board.readinessOf(next).text, /stale artifact/);
  assert.equal(step.integrated.head, head);
  // A second run proves that a temporary forbidden edit cannot hide behind a clean final diff.
  const other = await board.runPlan(raw, file, {}, board.previewPlan(raw, file)), t = other.steps[0];
  const from = sh(t.worktree, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(t.worktree, "a.txt"), "outside scope\n"); sh(t.worktree, "add", "a.txt"); sh(t.worktree, "commit", "-qm", "outside");
  sh(t.worktree, "revert", "--no-edit", "HEAD");
  fs.writeFileSync(path.join(t.worktree, "report.md"), "Report\n"); sh(t.worktree, "add", "report.md"); sh(t.worktree, "commit", "-qm", "report");
  const revision = sh(t.worktree, "rev-parse", "HEAD");
  t.submission = { head: revision, base: from, summary: "report", files: ["report.md"], checks: "complete", at: new Date().toISOString() };
  t.checks = { status: "complete", clean: true, revision, run: "checked" };
  board.closeStep(t, "accepted", "Only report accepted");
  await assert.rejects(board.integrate(t), /outside its allowed writes: a.txt/);
  assert.equal(t.integrated, undefined);
});

test("workflow judge gates its exact worker revision and scribe runs once after the approved milestone", async () => {
  const { board, file } = fixture();
  const raw = plan({ judge: "sonnet", scribe: { model: "haiku", documents: ["REPORT.md"], after: ["fix"] } }, [
    { id: "fix", title: "Fix", goal: "make a change", checks: ["unit"], judge: true }]);
  const { card, steps: [work] } = await board.runPlan(raw, file);
  const judge = board.tasks.find((t) => t.openedBy === card.id && t.role === "judge");
  const scribe = board.tasks.find((t) => t.openedBy === card.id && t.role === "scribe");
  assert.deepEqual([judge.status, judge.sessionId, scribe.status, scribe.sessionId, card.orchestrator.opened], ["review", undefined, "review", undefined, 3]);
  running(board, work);
  fs.writeFileSync(path.join(work.worktree, "b.txt"), "fixed\n");
  board.checks.start = (t) => { if (t.id === work.id) board.recordChecks(t, { status: "complete", run: "check-log", revision: sh(t.worktree, "rev-parse", "HEAD") }); };
  settle(board, work);
  await until("judge wakes", () => !!judge.sessionId, 30000); // as "scribe starts": 5 s timed out once under the full suite's load
  assert.equal(work.status, "review", "checks alone must not merge a judged step");
  assert.equal(judge.judging.id, work.id);
  assert.equal(work.checks.revision, judge.judging.revision, "the actual committed revision is checked before judgment");
  assert.equal(sh(work.worktree, "status", "--porcelain"), "");
  running(board, judge);
  terminals.find((x) => x.options.name === `En ${judge.id}` && !x.exitStatus).exit(0);
  event(board, judge.id, { hook_event_name: "Stop", last_assistant_message: `verdict: pass for child ${work.id}\n- Verified.` });
  board.syncStatus(judge.id);
  await until("worker merge", () => work.status === "done", 30000); // 5 s timed out twice under the full suite's load (11 November 2026)
  await until("scribe wakes", () => !!scribe.sessionId, 30000);
  assert.equal(card.deliveryReady, undefined, "scribe must complete before the plan is delivered");
  running(board, scribe);
  fs.writeFileSync(path.join(scribe.worktree, "REPORT.md"), "Documented.\n");
  sh(scribe.worktree, "add", "REPORT.md"); sh(scribe.worktree, "commit", "-qm", "document milestone");
  settle(board, scribe);
  await until("plan delivery", () => card.deliveryReady === true);
  assert.equal(fs.readFileSync(path.join(card.worktree, "REPORT.md"), "utf8"), "Documented.\n");
  assert.deepEqual([work.judged, judge.status, scribe.status, scribe.scribe.milestones[0].complete], ["pass", "done", "done", true]);
});

test("a plan refuses standing roles without enough approved open slots", async () => {
  const { board, file } = fixture();
  board.capsOf = () => ({ open: 2, total: 12, depth: 2, followUps: 3, pending: 3, watchers: 3, perWatcher: 4 });
  const raw = plan({ judge: "sonnet", scribe: { documents: ["REPORT.md"], after: ["fix"] } }, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"], judge: true }]);
  await assert.rejects(board.runPlan(raw, file), /at least 3 open slots/);
  assert.equal(board.tasks.length, 0);
});

test("plan capacity holds ready steps without counting precreated cards and reserves concurrent starts", async () => {
  const { board, file } = fixture();
  board.capsOf = () => ({ open: 1, total: 12, depth: 2, followUps: 3, pending: 3, watchers: 3, perWatcher: 4 });
  const raw = plan({}, ["a", "b", "c"].map((id) => ({ id, title: id, goal: id, checks: ["unit"] })));
  const { steps: [first, second, third] } = await board.runPlan(raw, file);
  assert.ok(first.sessionId);
  assert.deepEqual([second.held, third.held, second.sessionId, third.sessionId], [true, true, undefined, undefined]);
  await assert.rejects(board.startHeadless(second), /Waiting for run capacity \(1 of 1 open\)/);
  board.update(first, { status: "done" });
  let resume;
  let preparing = false;
  board.beforeStart = async () => { preparing = true; await new Promise((resolve) => { resume = resolve; }); };
  const next = board.startHeadless(second);
  await until("the second step's preparation", () => preparing);
  await assert.rejects(board.startHeadless(third), /Waiting for run capacity \(1 of 1 open\)/);
  resume();
  await next;
  board.update(second, { status: "done" });
  board.beforeStart = async () => {};
  await board.startHeadless(third);
  assert.ok(third.sessionId, "the next queued step can start after capacity frees");
});

test("Run a plan (checks): a plan card with no session, one card per step under it from the template; the first starts hidden, the second waits for it", async () => {
  const { board, file, runEvents } = fixture();
  const before = terminals.length;
  const { card, steps: [fix, docs] } = await board.runPlan(plan(), file);
  assert.deepEqual([card.title, card.status, card.sessionId, card.planRun, card.orchestrator.opened, card.headless], ["Plan: Tidy", "review", undefined, { name: "Tidy", file: "workflows/tidy.plan.json", review: "checks", stepIds: [fix.id, docs.id], setupState: "started" }, 2, undefined]);
  assert.ok(card.worktree && card.branch === `task/${card.id}`, "the plan's branch exists before any step starts");
  assert.match(card.prompt, /The board runs these steps in order\. When a step's checks pass, it merges the step into this card's branch/);
  for (const s of [fix, docs]) assert.deepEqual([s.parentId, s.openedBy, s.watchedBy, s.headless, s.account], [card.id, card.id, card.id, true, "acct"]);
  assert.deepEqual([fix.completion.commands, docs.completion.commands, docs.dependsOn], [["npm test"], ["npm run lint"], [fix.id]]);
  const made = cardsOf(plan());
  assert.equal(fix.prompt, P.stepPrompt(made.plan, made.cards, 0, card.id, CATALOGUE));
  assert.deepEqual([!!fix.sessionId, terminals.length, docs.sessionId, docs.held], [true, before + 1, undefined, true]);
  assert.equal(q.waitReason(docs, board.tasks, 0), `Starts after ${fix.title}`);
  assert.equal(sh(fix.worktree, "rev-parse", "HEAD"), sh(card.worktree, "rev-parse", "HEAD"), "a step branches from the plan's branch");
  assert.deepEqual(runEvents.map((e) => e.kind), ["started"]);
  await assert.rejects(board.startHeadless(card), /This plan card runs no session/);
  assert.equal(board.runSummaryOf(card).children.length, 2);
  // Archive names Finish, the way a checks plan card ends; it used to suggest Mark done, which refused it as "never started" (5 November 2026).
  await assert.rejects(board.archiveRun(card), /^Error: Archive run waits until the plan card is Done \(Finish\)\.$/);
});

test("checks decide: a passed step's leftovers are committed and it is merged into the plan's branch and marked Done, which releases the next; failures get two automatic follow-ups, then Needs you", async () => {
  const { board, file, runEvents } = fixture();
  const { card, steps: [fix, docs] } = await board.runPlan(plan(), file);
  running(board, fix);
  fs.writeFileSync(path.join(fix.worktree, "b.txt"), "fixed\n"); // left uncommitted by the step
  settle(board, fix);
  assert.equal(fix.status, "review");
  await finishChecks(board, fix, { status: "complete", run: "" });
  await until("the merge", () => fix.status === "done");
  assert.equal(fs.readFileSync(path.join(card.worktree, "b.txt"), "utf8"), "fixed\n", "merged into the plan card's worktree");
  assert.match(sh(card.worktree, "log", "-5", "--format=%B"), /Committed by Entomatical: the plan step left this work uncommitted/);
  // Finished, not only Done: its worktree and branch go once its work is in the plan's branch.
  const wt = path.join(board.dir, "wt", fix.id);
  await until("the step's worktree removed", () => !fix.worktree && !fs.existsSync(wt), 30000);
  assert.equal(sh(card.worktree, "branch", "--list", `task/${fix.id}`), "");
  assert.equal(q.waitReason(docs, board.tasks, 0), undefined, "Done releases the step waiting for it");
  // The second step fails its checks: the failure goes back to it, twice; the third failure is the user's.
  await board.startHeadless(docs);
  for (let n = 1; n <= 3; n++) {
    running(board, docs); settle(board, docs);
    await finishChecks(board, docs, FAILED);
    if (n < 3) {
      await until(`follow-up ${n}`, () => docs.followUps === n && docs.status === "running");
      assert.match(fs.readFileSync(path.join(board.dir, "launch", `${docs.id}.followup.txt`), "utf8"), /\n\nThe acceptance check `npm test` failed \(exit 1\)[\s\S]*not ok 3 - queue waits/);
    }
  }
  await until("Needs you", () => !!docs.stepHold);
  assert.match(docs.stepHold, /^Its checks failed again after the board sent it the failure: npm test exited 1\. See What failed/);
  assert.deepEqual([docs.status, docs.followUps], ["review", 2]);
  assert.ok(runEvents.some((e) => e.kind === "needsYou" && e.task.id === docs.id && e.master.id === card.id));
  const summary = board.runSummaryOf(card);
  assert.deepEqual([summary.needsYou, summary.children.find((c) => c.id === docs.id).held], [1, true]);
  // the user takes it from there: once it runs again the hold clears.
  running(board, docs);
  assert.equal(docs.stepHold, undefined);
});

test("Run a plan with each: one card per item, the next step waits for all of them, and the user's value for the list wins", async () => {
  const { board, file } = fixture();
  const raw = plan({ vars: { areas: "queue" } }, [
    { id: "fix", title: "Fix {{area}}", goal: "Fix the {{area}} tests.", each: "areas", checks: ["unit"] },
    { id: "verify", title: "Whole suite", goal: "Run it all.", checks: ["unit"], after: ["fix"] }]);
  const { card, steps } = await board.runPlan(raw, file, { areas: "queue; board" });
  assert.deepEqual(steps.map((s) => s.title), ["Fix queue", "Fix board", "Whole suite"]);
  assert.deepEqual([card.orchestrator.opened, steps[2].dependsOn], [3, [steps[0].id, steps[1].id]]);
  assert.match(steps[1].prompt, /^Step 2 of 3 of plan "Tidy"[\s\S]*Goal:\nFix the board tests\./);
  assert.match(card.prompt, /Variables: areas = queue; board/);
  assert.deepEqual(steps.map((s) => !!s.sessionId), [true, true, false]);
});

test("a checks-only plan whose last step is merged is declared ready by the board, and the run is announced finished once", async () => {
  const { board, repo, file, runEvents } = fixture();
  const raw = plan({}, [{ id: "only", title: "Only", goal: "o", checks: ["unit"] }]);
  fs.writeFileSync(file, JSON.stringify(raw)); // an uncommitted plan, as a Plan first card leaves it when the main checkout could not commit
  assert.ok(P.findPlanFiles(repo).some((f) => f.rel === "workflows/tidy.plan.json"));
  const { card, steps: [only] } = await board.runPlan(raw, file);
  assert.ok(card.approved?.at, "Run is the approval");
  running(board, only); settle(board, only);
  await finishChecks(board, only, { status: "complete", run: "" });
  await until("finished", () => runEvents.some((e) => e.kind === "finished"));
  assert.deepEqual([only.status, card.deliveryReady, card.reported, card.status], ["done", true, true, "review"]);
  assert.equal(runEvents.filter((e) => e.kind === "finished").length, 1);
  // F99: the finished plan leaves Run a plan…: moved to workflows/archive/ and committed there on main, said in the notification.
  const finished = runEvents.find((e) => e.kind === "finished");
  assert.match(finished.text, /^plan archived to workflows\/archive\/tidy\.plan\.json \(committed [0-9a-f]+, not pushed\)$/);
  assert.equal(fs.existsSync(file), false);
  assert.ok(fs.existsSync(path.join(repo, "workflows", "archive", "tidy.plan.json")));
  assert.deepEqual([card.planRun.file, card.planRun.archived], ["workflows/archive/tidy.plan.json", "workflows/archive/tidy.plan.json"]);
  assert.equal(P.findPlanFiles(repo).some((f) => /tidy/.test(f.rel)), false, "Run a plan… no longer lists it");
  assert.match(sh(repo, "log", "-1", "--format=%s"), new RegExp(`^Archive plan file workflows/tidy\\.plan\\.json \\(plan card ${card.id}\\)$`));
  assert.equal(sh(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
});

test("F99 a finished plan with vars stays in workflows/ and Run a plan… (reusable); the notification says so", async () => {
  const { board, repo, file, runEvents } = fixture();
  const raw = plan({ vars: { area: "queue" } }, [{ id: "only", title: "Fix {{area}}", goal: "Fix the {{area}} tests.", checks: ["unit"] }]);
  fs.writeFileSync(file, JSON.stringify(raw));
  const { card, steps: [only] } = await board.runPlan(raw, file, { area: "board" });
  running(board, only); settle(board, only);
  await finishChecks(board, only, { status: "complete", run: "" });
  await until("finished", () => runEvents.some((e) => e.kind === "finished"));
  assert.equal(runEvents.find((e) => e.kind === "finished").text, "plan kept in Run a plan…: it takes variables, so it can be run again");
  assert.ok(fs.existsSync(file));
  assert.equal(card.planRun.archived, undefined);
  assert.ok(P.findPlanFiles(repo).some((f) => f.rel === "workflows/tidy.plan.json"), "Run a plan… still lists it");
});

test("F99 Run this plan now: a Stop whose reply names an existing workflows/<name>.plan.json records it on the card; a missing file, or a plan run's card, records nothing", async () => {
  const { board, repo, file } = fixture();
  fs.writeFileSync(path.join(repo, "workflows", "x.plan.json"), "{}");
  const stop = (t, reply) => {
    board.update(t, { sessionId: `s-${t.id}`, status: "running" });
    event(board, t.id, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    event(board, t.id, { hook_event_name: "Stop", last_assistant_message: reply });
    board.syncStatus(t.id);
  };
  const a = board.add("a", "plan it");
  stop(a, `Draft was workflows/old.plan.json.\nSaved to ${path.join(repo, "workflows", "x.plan.json")}`);
  assert.deepEqual([a.status, a.planFile], ["review", "workflows/x.plan.json"]);
  const b = board.add("b", "plan it");
  stop(b, `Saved to ${path.join(repo, "workflows", "missing.plan.json")}`);
  assert.deepEqual([b.status, b.planFile], ["review", undefined]);
  // A plan run's step card names its own plan file: not offered.
  const raw = plan({}, [{ id: "only", title: "Only", goal: "o", checks: ["unit"] }]);
  fs.writeFileSync(file, JSON.stringify(raw));
  const { card, steps: [only] } = await board.runPlan(raw, file);
  running(board, only);
  event(board, only.id, { hook_event_name: "Stop", last_assistant_message: "Ran workflows/tidy.plan.json" });
  board.syncStatus(only.id);
  assert.deepEqual([only.status, only.planFile, card.planFile], ["review", undefined, undefined]);
});

test("F99 archivePlanFile: a committed plan's move is one commit on main; a taken name gets a time stamp; off main it moves without a commit; private plans just move", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-archive-"));
  made.push(repo);
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t"); sh(repo, "config", "core.autocrlf", "false");
  fs.mkdirSync(path.join(repo, "workflows", "archive"), { recursive: true });
  fs.writeFileSync(path.join(repo, "workflows", "a.plan.json"), "{}");
  fs.writeFileSync(path.join(repo, "workflows", "archive", "a.plan.json"), "{\"old\":1}");
  fs.writeFileSync(path.join(repo, "keep.txt"), "staged\n");
  sh(repo, "add", "workflows"); sh(repo, "commit", "-qm", "init"); sh(repo, "add", "keep.txt");
  const r = P.archivePlanFile(repo, "workflows/a.plan.json", "abc123", new Date("2026-11-11T10:20:30Z"));
  assert.equal(r.to, "workflows/archive/a-20261111-102030.plan.json");
  assert.match(r.committed, /^[0-9a-f]+$/);
  assert.equal(fs.readFileSync(path.join(repo, "workflows", "archive", "a.plan.json"), "utf8"), "{\"old\":1}", "an earlier archive is kept");
  assert.deepEqual(sh(repo, "show", "--no-renames", "--name-status", "--format=", "HEAD").split("\n").sort(), ["A\tworkflows/archive/a-20261111-102030.plan.json", "D\tworkflows/a.plan.json"]);
  assert.equal(sh(repo, "diff", "--cached", "--name-only"), "keep.txt", "other staged work stays staged");
  // Off main: moved, not committed, and why.
  fs.writeFileSync(path.join(repo, "workflows", "b.plan.json"), "{}");
  sh(repo, "checkout", "-qb", "side");
  assert.deepEqual(P.archivePlanFile(repo, "workflows/b.plan.json"), { to: "workflows/archive/b.plan.json", skipped: "the main checkout is on side, not main" });
  // A private plan moves only; a file outside the two folders, or one already gone, is left alone.
  fs.mkdirSync(path.join(repo, ".entomatical", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".entomatical", "workflows", "p.json"), "{}");
  assert.deepEqual(P.archivePlanFile(repo, ".entomatical/workflows/p.json"), { to: ".entomatical/workflows/archive/p.json" });
  fs.writeFileSync(path.join(repo, "elsewhere.plan.json"), "{}");
  assert.equal(P.archivePlanFile(repo, "elsewhere.plan.json"), undefined);
  assert.ok(fs.existsSync(path.join(repo, "elsewhere.plan.json")));
  assert.equal(P.archivePlanFile(repo, "workflows/gone.plan.json"), undefined);
  assert.deepEqual(P.findPlanFiles(repo).map((f) => f.rel), [], "archive/ is not listed");
});

test("F99 archivePlanFile: a plan run before F98's Stop commit (untracked, on main) is archived in one commit that adds only the archive copy", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-archive-"));
  made.push(repo);
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t"); sh(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "keep.txt"), "x\n"); sh(repo, "add", "keep.txt"); sh(repo, "commit", "-qm", "init");
  fs.mkdirSync(path.join(repo, "workflows"));
  fs.writeFileSync(path.join(repo, "workflows", "new.plan.json"), "{}");
  const r = P.archivePlanFile(repo, "workflows/new.plan.json", "abc123");
  assert.equal(r.to, "workflows/archive/new.plan.json");
  assert.match(r.committed, /^[0-9a-f]+$/);
  assert.equal(sh(repo, "show", "--name-status", "--format=", "HEAD"), "A\tworkflows/archive/new.plan.json");
  assert.equal(fs.existsSync(path.join(repo, "workflows", "new.plan.json")), false, "so F98's Stop finds it gone and skips it");
});

test("F99 planningPrompt: the shipped PLANNER.md gets absolute paths, and the task goes in verbatim, or stays {{task}} for the form's preview", () => {
  const template = fs.readFileSync(path.join(__dirname, "..", "docs", "orchestrator", "PLANNER.md"), "utf8");
  const paths = { guide: "/x/docs/agents/README.md", schema: "/x/docs/agents/schemas/plan.schema.json", checks: "/repo/workflows/checks.json" };
  const preview = P.planningPrompt(template, paths);
  assert.ok(preview.includes("{{task}}"));
  assert.doesNotMatch(preview, /\{\{(guide|schema|checks)\}\}/);
  for (const p of Object.values(paths)) assert.ok(preview.includes(p), p);
  assert.match(preview, /workflows\/<short-kebab-name>\.plan\.json/);
  // the user, 14 November 2026: one step needs no file, and inputs the user varies are vars.
  assert.match(preview, /If the approved plan is a single step, write no plan file: carry that step out yourself in this session/);
  assert.match(preview, /With two or more steps, do not do the work itself\./);
  assert.match(preview, /declare those inputs as `vars`.*stays listed in Run a plan… after it finishes/);
  const task = "Split the parser into two files.\nKeep $1 and {{guide}} as typed.";
  const sent = P.planningPrompt(template, paths, `  ${task}\n`);
  assert.ok(sent.endsWith(task), "the task is last, as typed");
  assert.equal(sent, preview.split("{{task}}").join(task), "the preview shows what the card is sent");
});

test("Plan first on Codex: the shipped PLANNER-CODEX.md asks to wait for approval and names the main checkout's workflows/ by full path", () => {
  const template = fs.readFileSync(path.join(__dirname, "..", "docs", "orchestrator", "PLANNER-CODEX.md"), "utf8");
  const paths = { guide: "/x/docs/agents/README.md", schema: "/x/docs/agents/schemas/plan.schema.json", checks: "/repo/workflows/checks.json", workflows: "/repo/workflows" };
  const preview = P.planningPrompt(template, paths);
  assert.ok(preview.includes("{{task}}"));
  assert.doesNotMatch(preview, /\{\{(guide|schema|checks|workflows)\}\}/);
  assert.match(preview, /`\/repo\/workflows\/<short-kebab-name>\.plan\.json`/);
  assert.match(preview, /Codex has no plan mode here/);
  assert.doesNotMatch(preview, /Write tool/); // Codex has none
  assert.match(preview, /If the approved plan is a single step, write no plan file: carry that step out yourself in this session/);
  assert.match(preview, /declare those inputs as `vars`/);
});

test("a merge conflict merges nothing and names the files; an interrupted step is resumed once; Pause run holds the board's judgement until Resume run", async () => {
  const { board, file } = fixture();
  const { card, steps: [a, b] } = await board.runPlan(plan({}, [
    { id: "a", title: "A", goal: "a", checks: ["unit"] }, { id: "b", title: "B", goal: "b", checks: ["unit"] }]), file);
  for (const [t, text] of [[a, "from a\n"], [b, "from b\n"]]) { running(board, t); fs.writeFileSync(path.join(t.worktree, "a.txt"), text); settle(board, t); }
  await finishChecks(board, a, { status: "complete", run: "" });
  await until("a merged", () => a.status === "done");
  await finishChecks(board, b, { status: "complete", run: "" });
  await until("b held", () => !!b.stepHold);
  assert.match(b.stepHold, /^It could not be merged into the plan's branch, so nothing was merged: CONFLICT \(content\): Merge conflict in a\.txt/);
  assert.equal(fs.readFileSync(path.join(card.worktree, "a.txt"), "utf8"), "from a\n");
  assert.equal(sh(card.worktree, "status", "--porcelain"), "", "the aborted merge left the plan's worktree clean");
  // Interrupted (a window reload ends hidden runs): one automatic resume, held while paused.
  const { card: c2, steps: [x] } = await board.runPlan(plan({ name: "Second" }, [{ id: "x", title: "X", goal: "x", checks: ["unit"] }]), file);
  running(board, x);
  board.pauseRun(c2);
  terminals.find((t) => t.options.name === `En ${x.id}` && !t.exitStatus)?.exit(0);
  board.update(x, { status: "review" }, undefined, true); // a quiet Review: interrupted
  await sleep(100);
  assert.deepEqual([x.interrupted, x.followUps, x.status], [true, undefined, "review"], "paused: nothing sent");
  board.resumeRun(c2);
  await until("the resume", () => x.followUps === 1 && x.status === "running");
  assert.match(fs.readFileSync(path.join(board.dir, "launch", `${x.id}.followup.txt`), "utf8"), /\n\nYour previous turn was interrupted/);
});

test("a reviewed plan: the plan card is the reviewer, started with the brief and the step table; a passed step reaches it as a settle notice; it may not open cards", async () => {
  const { repo, board, file } = fixture();
  const { card, steps: [fix] } = await board.runPlan(plan({ review: "model", reviewer: { model: "sonnet", effort: "low" } }), file);
  assert.deepEqual([card.headless, card.model, card.effort, !!card.sessionId, card.planRun.review], [true, "sonnet", "low", true, "model"]);
  const first = fs.readFileSync(path.join(board.dir, "launch", `${card.id}.prompt.txt`), "utf8");
  assert.match(first, /A step's allowed files apply to its worker\.[\s\S]*fix the integration failure on the plan branch/);
  assert.match(first, /Only after the required reviewer checks pass on the current commit, run `node ~\/.entomatical\/board\.js ready`/);
  assert.match(first, /^Your Entomatical card is [0-9a-f]{6} \(Plan: Tidy\)[^\n]*\n\n# Plan reviewer brief\r?\n/); // the board's identity line, then the brief
  assert.match(first, new RegExp(`Repository: ${repo.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}\\.`));
  assert.match(first, new RegExp(`- ${fix.id}  "Fix the text"  checks: unit\\n- [0-9a-f]{6}  "Describe it"  checks: lint  waits for: ${fix.id}`));
  event(board, card.id, { hook_event_name: "SessionStart", session_id: card.sessionId });
  settle(board, card); // its "Ready." turn ends: idle in Review
  running(board, fix); settle(board, fix);
  await finishChecks(board, fix, { status: "complete", run: "" });
  await until("the notice", () => card.status === "running");
  assert.match(fs.readFileSync(path.join(board.dir, "launch", `${card.id}.followup.txt`), "utf8"), new RegExp(`\\n\\nChild settled: ${fix.id}  review .*checks:passed`));
  assert.equal(fix.status, "review", "the reviewer merges and marks it Done, not the board");
  // The reviewer's inbox requests: add and plan are refused, done on its step is not.
  const ask = async (body) => {
    const nonce = `n${Date.now()}${Math.random().toString(36).slice(2, 6)}`, inbox = path.join(board.dir, "inbox");
    fs.writeFileSync(path.join(inbox, `${nonce}.json`), JSON.stringify({ v: 1, at: "now", by: card.id, session: card.sessionId, ...body }));
    await board.processInbox();
    return JSON.parse(fs.readFileSync(path.join(inbox, "done", `${nonce}.json`), "utf8"));
  };
  assert.match((await ask({ op: "add", title: "x", prompt: "y" })).error, /^add: this run follows a plan file/);
  assert.match((await ask({ op: "plan" })).error, /^plan: this card runs a plan file/);
  assert.equal((await ask({ op: "done", id: fix.id })).ok, true);
  assert.equal(fix.status, "done");
});

test("ready requires a board-run delivery receipt for the clean integrated plan commit", async () => {
  const { repo, board, file } = fixture();
  const command = `node -e "process.exit(require('fs').readFileSync('a.txt','utf8').trim() === 'fixed' ? 0 : 1)"`;
  fs.writeFileSync(path.join(repo, "workflows", "checks.json"), JSON.stringify({ suite: { run: command } }));
  const raw = plan({ review: "model", deliveryChecks: ["suite"] }, [{ id: "work", title: "Work", goal: "Fix it." }]);
  assert.ok(board.checkPlan({ ...raw, deliveryChecks: ["unknown"] }).errors);
  assert.ok(board.checkPlan({ ...raw, deliveryChecks: [] }).errors);
  const checked = board.checkPlan(raw);
  assert.ok(P.planPreview(checked.plan, checked.cards, { suite: { run: command } }).join("\n").includes(command));
  const { card, steps: [child] } = await board.runPlan(raw, file);
  running(board, card);
  const ask = (op, args = {}) => board.handleRequest({ v: 1, by: card.id, session: card.sessionId, op, ...args }, `delivery-${Math.random()}`);
  assert.match((await ask("ready")).error, /not finished/);
  board.update(child, { status: "done" });
  delete board.checks.start; // use the real detached worker on this fixture's temporary plan branch
  board.checks.onResult = () => {};
  const result = async () => until("delivery worker to finish", () => {
    board.checks.sync();
    return card.checks?.status !== "running";
  });
  assert.match((await ask("ready")).error, /Started delivery checks/);
  const first = card.checks.run;
  assert.match((await ask("ready")).error, /running/);
  assert.equal(card.checks.run, first);
  await result();
  assert.equal(card.checks.status, "error");
  assert.ok(!card.deliveryReady);
  assert.match((await ask("finish", { self: true })).error, /failed/i);
  await assert.rejects(board.complete(card, async () => true), /delivery|failed/i);
  fs.writeFileSync(path.join(card.worktree, "a.txt"), "fixed\n");
  assert.match((await ask("ready")).error, /clean checkout/);
  sh(card.worktree, "commit", "-qam", "repair");
  assert.match((await ask("ready")).error, /Started delivery checks/);
  await result();
  assert.equal(card.checks.status, "complete");
  assert.equal(card.checks.revision, sh(card.worktree, "rev-parse", "HEAD"));
  assert.equal((await ask("ready")).ok, true);
  const passed = card.checks.run;
  settle(board, card);
  assert.equal(card.checks.run, passed, "ending the reviewer turn reuses its verified receipt");
  assert.equal(board.checks.deliveryRevision(card), sh(card.worktree, "rev-parse", "HEAD"));
  sh(card.worktree, "commit", "--allow-empty", "-qm", "new revision");
  assert.match((await ask("ready")).error, /Started delivery checks/);
  assert.ok(!card.deliveryReady);
  await result();
  const saved = path.join(card.checks.run, "receipt.json");
  const receipt = JSON.parse(fs.readFileSync(saved));
  fs.writeFileSync(saved, JSON.stringify({ ...receipt, commands: ["different command"] }));
  assert.match((await ask("ready")).error, /Started delivery checks/);
  assert.ok(!card.deliveryReady);
  await result();
  assert.equal((await ask("ready")).ok, true);
});

test("a v1 reviewer with approved delegation can add managed workers and must settle them before delivery", async () => {
  const { board, file } = fixture();
  const raw = plan({ review: "model", mayOpen: true }, [{ id: "listed", title: "Listed", goal: "Deliver the change." }]);
  const checked = P.validatePlanFile(raw, RULES);
  assert.match(P.planPreview(checked.plan, checked.cards, CATALOGUE).join("\n"), /reviewer may open additional cards/);
  const { card, steps: [listed] } = await board.runPlan(raw, file);
  running(board, card);
  board.preflightHeadless = async () => {};
  const ask = (body) => board.handleRequest({ v: 1, by: card.id, session: card.sessionId, ...body }, `delegate-${Math.random()}`);
  assert.match(card.prompt, /Run approval allows you to open additional worker cards/);
  const request = { op: "add", title: "Follow up", prompt: "Check the correction.", start: "manual" };
  board.pauseRun(card);
  assert.match((await ask(request)).error, /paused/i);
  board.resumeRun(card);
  const added = await ask(request);
  assert.equal(added.created, true, JSON.stringify(added));
  const worker = board.get(added.id);
  assert.deepEqual([worker.openedBy, worker.watchedBy, worker.parentId], [card.id, card.id, card.id]);
  assert.ok(board.isPlanStep(listed, card));
  assert.equal(board.isPlanStep(worker, card), false);
  board.update(listed, { status: "done" });
  assert.match((await ask({ op: "ready" })).error, /not finished/);
  board.update(card, { orchestrator: { ...card.orchestrator, caps: { ...card.orchestrator.caps, total: 2 } } });
  assert.match((await ask(request)).error, /total cap/);
  assert.equal((await ask({ op: "cancel", id: worker.id })).ok, true);
  assert.equal((await ask({ op: "ready" })).ok, true);
  const count = board.tasks.length;
  board.update(card, { status: "done" });
  assert.match((await ask(request)).error, /run has ended/);
  board.update(card, { status: "review", cancelled: true });
  assert.match((await ask(request)).error, /run has ended/);
  assert.equal(board.tasks.length, count);
});

test("a failed verdict holds a workflow step and does not merge it", async () => {
  const { board, file } = fixture();
  const raw = plan({ judge: "sonnet" }, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"], judge: true }]);
  const { card, steps: [work] } = await board.runPlan(raw, file);
  const judge = board.tasks.find((t) => t.openedBy === card.id && t.role === "judge");
  running(board, work); fs.writeFileSync(path.join(work.worktree, "change.txt"), "work\n"); settle(board, work);
  await finishChecks(board, work, { status: "complete", run: "check-log" });
  await until("judge wakes", () => !!judge.sessionId, 30000); // as "scribe starts": 5 s timed out once under the full suite's load
  running(board, judge);
  terminals.find((x) => x.options.name === `En ${judge.id}` && !x.exitStatus).exit(0);
  event(board, judge.id, { hook_event_name: "Stop", last_assistant_message: `verdict: fail for child ${work.id}\n- Missing evidence.` });
  board.syncStatus(judge.id);
  await until("the failed verdict holds work", () => !!work.stepHold);
  assert.equal(work.judged, "fail");
  assert.equal(work.status, "review");
  assert.equal(fs.existsSync(path.join(card.worktree, "change.txt")), false);
  assert.equal(card.deliveryReady, undefined);
});

test("a scribe cannot merge a document outside the approved allowlist", async () => {
  const { board, file } = fixture();
  const raw = plan({ scribe: { model: "haiku", documents: ["REPORT.md"], after: ["fix"] } }, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"] }]);
  const { card, steps: [work] } = await board.runPlan(raw, file);
  const scribe = board.tasks.find((t) => t.openedBy === card.id && t.role === "scribe");
  running(board, work); settle(board, work); await finishChecks(board, work, { status: "complete", run: "check-log" });
  await until("scribe wakes", () => !!scribe.sessionId);
  running(board, scribe);
  fs.writeFileSync(path.join(scribe.worktree, "UNAPPROVED.md"), "not allowed\n");
  sh(scribe.worktree, "add", "UNAPPROVED.md"); sh(scribe.worktree, "commit", "-qm", "outside scope");
  fs.rmSync(path.join(scribe.worktree, "UNAPPROVED.md"));
  fs.writeFileSync(path.join(scribe.worktree, "REPORT.md"), "allowed\n");
  sh(scribe.worktree, "add", "-A"); sh(scribe.worktree, "commit", "-qm", "revert outside path and document");
  assert.doesNotMatch(sh(scribe.worktree, "diff", "--name-only", `${card.branch}...${scribe.branch}`), /UNAPPROVED/);
  settle(board, scribe);
  await until("scribe held", () => !!scribe.stepHold);
  assert.match(scribe.stepHold, /outside its approved document list/);
  assert.equal(fs.existsSync(path.join(card.worktree, "UNAPPROVED.md")), false);
  assert.equal(card.deliveryReady, undefined);
});

test("model-reviewed plans hold failed judgments and never ask the reviewer to merge them", async () => {
  const { board, file } = fixture();
  const raw = plan({ review: "model", judge: "sonnet" }, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"], judge: true }]);
  const { card, steps: [work] } = await board.runPlan(raw, file);
  const judge = board.tasks.find((t) => t.role === "judge" && t.openedBy === card.id);
  assert.match(card.prompt, /do not merge until a pass for the exact revision/i);
  running(board, card); settle(board, card);
  running(board, work);
  fs.writeFileSync(path.join(work.worktree, "failure.txt"), "unapproved\n");
  board.checks.start = (t) => { if (t.id === work.id) board.recordChecks(t, { status: "complete", run: "check-log", revision: sh(t.worktree, "rev-parse", "HEAD") }); };
  settle(board, work);
  await until("judge wakes", () => !!judge.sessionId, 30000); // as "scribe starts": 5 s timed out once under the full suite's load
  running(board, judge);
  terminals.find((x) => x.options.name === `En ${judge.id}` && !x.exitStatus).exit(0);
  event(board, judge.id, { hook_event_name: "Stop", last_assistant_message: `verdict: fail for child ${work.id}\n- Incorrect.` });
  board.syncStatus(judge.id);
  await until("step held", () => !!work.stepHold);
  assert.match(work.stepHold, /failed this step/);
  assert.equal(fs.existsSync(path.join(card.worktree, "failure.txt")), false);
  assert.equal(work.status, "review");
  const msgs = board.receiveMessages(card.id).join("\n");
  assert.doesNotMatch(msgs, /Child settled:/);
});

test("model-reviewed plan ready closes an unused standing judge without pretending it ran", async () => {
  const { board, file } = fixture();
  const raw = plan({ review: "model", judge: "sonnet" }, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"] }]);
  const { card, steps: [work] } = await board.runPlan(raw, file);
  const judge = board.tasks.find((t) => t.role === "judge" && t.openedBy === card.id);
  board.update(work, { status: "done" });
  const result = await board.handleRequest({ v: 1, op: "ready", by: card.id, session: card.sessionId }, "ready-model");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(judge.cancelled, true);
  assert.equal(judge.sessionId, undefined);
  assert.equal(card.deliveryReady, true);
});

test("paused checks-only steps resume after the owner window reloads", async () => {
  const { repo, board, file } = fixture();
  const { card, steps: [work] } = await board.runPlan(plan({}, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"] }]), file);
  running(board, work); fs.writeFileSync(path.join(work.worktree, "recovered.txt"), "done\n");
  board.pauseRun(card); settle(board, work);
  await sleep(100);
  assert.equal(work.status, "review");
  const cardId = card.id, workId = work.id;
  board.dispose();
  const next = new Board(repo, path.join(repo, "hook.js"), undefined, false); boards.push(next);
  next.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }];
  next.accountFolderList = () => [path.join(home, "acct")]; next.checks.start = (t) => { if (t.completion?.commands.length && t.worktree) next.recordChecks(t, { status: "running", run: "mock", revision: sh(t.worktree, "rev-parse", "HEAD") }); }; next.tick();
  const root = next.get(cardId), restored = next.get(workId);
  assert.equal(root.paused, true);
  next.resumeRun(root);
  await finishChecks(next, restored, { status: "complete", run: "check-log" });
  await until("the paused step to merge after reload", () => restored.status === "done", 30000);
  assert.equal(fs.readFileSync(path.join(root.worktree, "recovered.txt"), "utf8"), "done\n");
});

test("simultaneously settled plan steps serialize their merges into the shared plan worktree", async () => {
  const { board, file } = fixture();
  const raw = plan({}, [{ id: "a", title: "A", goal: "a", checks: ["unit"] }, { id: "b", title: "B", goal: "b", checks: ["unit"] }]);
  const { card, steps } = await board.runPlan(raw, file);
  for (const [i, work] of steps.entries()) {
    running(board, work);
    fs.writeFileSync(path.join(work.worktree, `${i}.txt`), `value ${i}\n`);
    sh(work.worktree, "add", `${i}.txt`); sh(work.worktree, "commit", "-qm", `work ${i}`);
    settle(board, work);
  }
  for (const work of steps) await finishChecks(board, work, { status: "complete", run: "check-log" });
  await until("both merges", () => steps.every((t) => t.status === "done"));
  assert.equal(fs.readFileSync(path.join(card.worktree, "0.txt"), "utf8"), "value 0\n");
  assert.equal(fs.readFileSync(path.join(card.worktree, "1.txt"), "utf8"), "value 1\n");
  assert.equal(sh(card.worktree, "status", "--porcelain"), "");
});

test("model-reviewed workflow waits for and incorporates the standing scribe before ready", async () => {
  const { board, file } = fixture();
  const raw = plan({ review: "model", scribe: { model: "haiku", documents: ["REPORT.md"], after: ["fix"] } }, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"] }]);
  const { card, steps: [work] } = await board.runPlan(raw, file);
  const scribe = board.tasks.find((t) => t.role === "scribe" && t.openedBy === card.id);
  running(board, card); settle(board, card);
  running(board, work);
  fs.writeFileSync(path.join(work.worktree, "fix.txt"), "fixed\n");
  sh(work.worktree, "add", "fix.txt"); sh(work.worktree, "commit", "-qm", "fix");
  settle(board, work); await finishChecks(board, work, { status: "complete", run: "check-log" });
  await sleep(100);
  sh(card.worktree, "merge", "--no-edit", work.branch);
  const request = (op, extra = {}) => board.handleRequest({ v: 1, op, by: card.id, session: card.sessionId, ...extra }, `${op}-${Math.random()}`);
  assert.equal((await request("done", { id: work.id })).ok, true);
  await until("scribe starts", () => !!scribe.sessionId);
  assert.match((await request("ready")).error, /scribe.*unfinished/i);
  running(board, scribe);
  fs.writeFileSync(path.join(scribe.worktree, "REPORT.md"), "summary\n");
  sh(scribe.worktree, "add", "REPORT.md"); sh(scribe.worktree, "commit", "-qm", "summarize");
  settle(board, scribe);
  await until("scribe milestone", () => scribe.scribe.milestones[0].complete === true);
  const ready = await request("ready");
  assert.equal(ready.ok, true, JSON.stringify(ready));
  assert.equal(fs.readFileSync(path.join(card.worktree, "REPORT.md"), "utf8"), "summary\n");
  assert.equal(scribe.status, "done");
});

test("model plan steps settled during pause are reported after reload and resume", async () => {
  const { repo, board, file } = fixture();
  const { card, steps: [work] } = await board.runPlan(plan({ review: "model" }, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"] }]), file);
  running(board, card); settle(board, card); running(board, work);
  board.pauseRun(card); settle(board, work);
  await sleep(100); const rootId = card.id, workId = work.id; board.dispose();
  const next = new Board(repo, path.join(repo, "hook.js"), undefined, false); boards.push(next);
  next.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }]; next.accountFolderList = () => [path.join(home, "acct")]; next.checks.start = (t) => { if (t.completion?.commands.length && t.worktree) next.recordChecks(t, { status: "running", run: "mock", revision: sh(t.worktree, "rev-parse", "HEAD") }); }; next.tick();
  next.resumeRun(next.get(rootId));
  await finishChecks(next, next.get(workId), { status: "complete", run: "check-log" });
  const followup = path.join(next.dir, "launch", `${rootId}.followup.txt`);
  await until("reviewer notification", () => (fs.existsSync(followup) && fs.readFileSync(followup, "utf8").includes(workId)) || next.receiveMessages(rootId).join("\n").includes(workId), 30000);
});

test("scribe completion during pause is processed after reload and resume", async () => {
  const { repo, board, file } = fixture();
  const raw = plan({ scribe: { documents: ["REPORT.md"], after: ["fix"] } }, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"] }]);
  const { card, steps: [work] } = await board.runPlan(raw, file);
  const scribe = board.tasks.find((t) => t.role === "scribe" && t.openedBy === card.id);
  running(board, work); settle(board, work); await finishChecks(board, work, { status: "complete", run: "check-log" });
  await until("scribe starts", () => !!scribe.sessionId, 30000); running(board, scribe);
  fs.writeFileSync(path.join(scribe.worktree, "REPORT.md"), "summary\n"); sh(scribe.worktree, "add", "REPORT.md"); sh(scribe.worktree, "commit", "-qm", "summary");
  board.pauseRun(card); settle(board, scribe); await sleep(100);
  const rootId = card.id, scribeId = scribe.id; board.dispose();
  const next = new Board(repo, path.join(repo, "hook.js"), undefined, false); boards.push(next);
  next.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }]; next.accountFolderList = () => [path.join(home, "acct")]; next.checks.start = () => {}; next.tick();
  next.resumeRun(next.get(rootId));
  await until("scribe completed", () => next.get(scribeId).scribe.milestones[0].complete, 30000);
  await until("plan delivered", () => next.get(rootId).deliveryReady, 30000);
  assert.equal(fs.readFileSync(path.join(next.get(rootId).worktree, "REPORT.md"), "utf8"), "summary\n");
});

test("model reviewer cannot declare ready after a judged branch advances", async () => {
  const { board, file } = fixture();
  const raw = plan({ review: "model", judge: "sonnet" }, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"], judge: true }]);
  const { card, steps: [work] } = await board.runPlan(raw, file);
  fs.writeFileSync(path.join(work.worktree, "fix.txt"), "first\n"); sh(work.worktree, "add", "fix.txt"); sh(work.worktree, "commit", "-qm", "reviewed");
  const revision = sh(work.worktree, "rev-parse", "HEAD"); sh(card.worktree, "merge", "--no-edit", revision);
  board.update(work, { status: "done", judged: "pass", judgedRevision: revision });
  fs.writeFileSync(path.join(work.worktree, "fix.txt"), "unreviewed\n"); sh(work.worktree, "add", "fix.txt"); sh(work.worktree, "commit", "-qm", "later");
  sh(card.worktree, "merge", "--no-edit", work.branch);
  const result = await board.handleRequest({ v: 1, op: "ready", by: card.id, session: card.sessionId }, "advanced-branch");
  assert.match(result.error, /no longer matches the reviewed revision/); assert.equal(card.deliveryReady, undefined);
});

test("plan validation uses each card's provider, model effort and permission, including reviewer and standing roles", () => {
  const profiles = [
    { name: "acct", provider: "claude", models: RULES.models.map((id) => ({ id, efforts: RULES.efforts })), permissions: RULES.permissions },
    { name: "Codex · test", provider: "codex", models: [{ id: "gpt-test", efforts: ["low", "high"] }, { id: "gpt-mini", efforts: ["low"] }], permissions: ["ask", "auto", "bypass"] },
  ];
  const rules = { ...RULES, profiles, defaultAccount: "acct" };
  const codex = plan({ review: "model", reviewer: { account: "Codex · test", model: "gpt-test", effort: "high" } }, [
    { id: "a", title: "Claude", goal: "g", account: "acct", model: "sonnet", effort: "max", checks: ["unit"] },
    { id: "b", title: "Codex", goal: "g", account: "Codex · test", model: "gpt-test", effort: "high", permission: "auto", checks: ["unit"] }]);
  assert.deepEqual(errorsOf(codex, rules), []);
  const result = P.validatePlanFile(codex, rules);
  const preview = P.planPreview(result.plan, result.cards, CATALOGUE).join("\n");
  assert.match(preview, /reviewer model \(gpt-test\) on Codex · test · high effort/);
  assert.match(preview, /Codex · account: Codex · test/);
  const bad = plan({ account: "Codex · test", model: "gpt-mini", effort: "high", permission: "edits", judge: "sonnet", scribe: { model: "haiku", documents: ["REPORT.md"], after: ["a"] } },
    [{ id: "a", title: "Bad", goal: "g", checks: ["unit"] }]);
  const errors = errorsOf(bad, rules).join("\n");
  for (const want of [/Step "a" "effort"/, /Step "a" "permission"/, /"judge" "model"/, /"scribe" "model"/]) assert.match(errors, want);
  // Not signed in here: named like any other missing account, never refused for being Grok or Antigravity.
  assert.match(errorsOf(plan({ account: "Grok · Work" }), rules).join(" "), /Grok · Work is not an available, unambiguous signed-in account \(Claude, Codex, Grok or Antigravity\)/);
  assert.match(errorsOf(plan({ account: "Antigravity · Shared" }), rules).join(" "), /Antigravity · Shared is not an available, unambiguous signed-in account/);
  assert.match(errorsOf(plan({ account: "Codex · test", effort: "low" }), rules).join(" "), /choose a Codex model when specifying effort/);
  assert.match(errorsOf(plan({ account: "Codex · test" }, [{ id: "a", title: "A", goal: "g", checks: ["unit"], model: null }]), rules).join(" "), /"model" must be one of/);
  const inherited = plan({ model: "sonnet" }, [{ id: "a", title: "A", goal: "g", account: "Codex · test", checks: ["unit"] }]);
  assert.match(errorsOf(inherited, rules).join(" "), /Step "a" "model"/);
});

test("workflow run creates Codex steps with a separately selected Claude reviewer and refuses external workers before card creation", async () => {
  const { board, file } = fixture();
  board.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }, { name: "Codex · test", provider: "codex", configDir: "" }, { name: "Grok · Work", provider: "grok", configDir: "grok" }];
  const started = [];
  board.startHeadless = async (task) => { started.push({ title: task.title, account: task.account, provider: task.provider, permission: task.permission }); await board.ensureWorktree(task); };
  const raw = plan({ account: "Codex · test", review: "model", reviewer: { account: "acct", model: "sonnet" }, permission: "auto" },
    [{ id: "a", title: "Codex work", goal: "g", checks: ["unit"] }, { id: "b", title: "Claude work", goal: "g", account: "acct", checks: ["lint"] }]);
  const { card, steps } = await board.runPlan(raw, file);
  assert.equal(card.account, "acct");
  assert.deepEqual(steps.map((t) => [t.account, t.provider, t.permission]), [["Codex · test", "codex", "auto"], ["acct", undefined, "auto"]]);
  assert.deepEqual(started.map((t) => t.account), ["acct", "Codex · test", "acct"]);
  const other = plan({ account: "acct", review: "model", reviewer: { account: "Codex · test" } },
    [{ id: "c", title: "Claude for Codex reviewer", goal: "g", checks: ["unit"] }]);
  const otherRun = await board.runPlan(other, file);
  assert.equal(otherRun.card.provider, "codex");
  assert.equal(otherRun.card.account, "Codex · test");
  assert.equal(otherRun.steps[0].account, "acct");
  const count = board.tasks.length;
  await assert.rejects(board.runPlan(plan({ account: "Grok · Missing" }), file), /Grok · Missing is not an available, unambiguous signed-in account/);
  assert.equal(board.tasks.length, count, "a refused plan creates no partial cards");
});

test("checks-only plans hold changes made during checks without committing or merging them", async () => {
  const { board, file } = fixture();
  const { card, steps: [work] } = await board.runPlan(plan({}, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"] }]), file);
  running(board, work); fs.writeFileSync(path.join(work.worktree, "a.txt"), "worker change\n"); settle(board, work);
  await until("checks start on a committed worker revision", () => work.checks?.status === "running");
  const revision = work.checks.revision;
  assert.equal(sh(work.worktree, "rev-parse", "HEAD"), revision);
  assert.equal(sh(work.worktree, "status", "--porcelain"), "");
  fs.writeFileSync(path.join(work.worktree, "a.txt"), "check modified this\n");
  board.recordChecks(work, { status: "complete", run: "mock", revision });
  await until("changed tree held", () => !!work.stepHold);
  assert.match(work.stepHold, /changed during or after its checks/);
  assert.equal(sh(work.worktree, "rev-parse", "HEAD"), revision);
  assert.equal(fs.readFileSync(path.join(work.worktree, "a.txt"), "utf8"), "check modified this\n");
  assert.equal(fs.readFileSync(path.join(card.worktree, "a.txt"), "utf8"), "one\n");
  assert.equal(work.status, "review");
});

test("checks-only plans merge the checked commit and hold changes made while merge is waiting", async () => {
  const { board, file } = fixture();
  const { card, steps: [work] } = await board.runPlan(plan({}, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"] }]), file);
  running(board, work); fs.writeFileSync(path.join(work.worktree, "a.txt"), "checked\n"); settle(board, work);
  await until("checks started", () => work.checks?.status === "running");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  board.planMerges.set(card.id, gate);
  const revision = work.checks.revision;
  board.recordChecks(work, { status: "complete", run: "mock", revision });
  await until("merge queued", () => board.planMerges.get(card.id) !== gate);
  fs.writeFileSync(path.join(work.worktree, "a.txt"), "unchecked after checks\n");
  release();
  await until("changed work held", () => !!work.stepHold);
  assert.match(work.stepHold, /changed during (or after its checks|merge)/);
  assert.equal(work.status, "review");
  assert.notEqual(fs.readFileSync(path.join(card.worktree, "a.txt"), "utf8"), "unchecked after checks\n");
  assert.equal(fs.readFileSync(path.join(work.worktree, "a.txt"), "utf8"), "unchecked after checks\n");
});

test("a real passing check that rewrites a tracked file is held and keeps its output", async () => {
  const { board, file, repo } = fixture();
  const { TaskChecks } = require("../out/checks.js");
  board.checks.start = TaskChecks.prototype.start.bind(board.checks);
  board.checks.onResult = () => {};
  fs.writeFileSync(path.join(repo, "workflows", "checks.json"), JSON.stringify({ mutate: { run: 'node -e "require(\'fs\').writeFileSync(\'a.txt\', \'changed by check\\n\')"' } }));
  const { card, steps: [work] } = await board.runPlan(plan({}, [{ id: "fix", title: "Fix", goal: "g", checks: ["mutate"] }]), file);
  running(board, work); fs.writeFileSync(path.join(work.worktree, "a.txt"), "worker change\n"); settle(board, work);
  await until("real check starts", () => work.checks?.status === "running", 30000);
  await until("real check finishes", () => { board.checks.sync(); return work.checks?.status === "complete" || work.checks?.status === "error"; }, 30000);
  assert.equal(work.checks.status, "complete", work.checks.error);
  await until("check output held", () => !!work.stepHold, 30000);
  assert.match(work.stepHold, /changed during or after its checks/);
  assert.match(fs.readFileSync(path.join(work.worktree, "a.txt"), "utf8"), /changed by check/);
  assert.equal(fs.readFileSync(path.join(card.worktree, "a.txt"), "utf8"), "one\n");
});

test("a merge queued behind another merge waits for Resume after Pause", async () => {
  const { board, file } = fixture();
  const { card, steps: [work] } = await board.runPlan(plan({}, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"] }]), file);
  running(board, work); fs.writeFileSync(path.join(work.worktree, "a.txt"), "checked\n"); settle(board, work);
  await until("checks start", () => work.checks?.status === "running", 30000);
  let release; const gate = new Promise((resolve) => { release = resolve; }); board.planMerges.set(card.id, gate);
  await finishChecks(board, work, { status: "complete", run: "check-log" });
  await until("merge queued", () => board.planMerges.get(card.id) !== gate, 30000);
  board.pauseRun(card); release(); await board.stepRuns.get(card.id);
  assert.equal(work.status, "review"); assert.equal(fs.readFileSync(path.join(card.worktree, "a.txt"), "utf8"), "one\n");
  board.resumeRun(card); await until("merge after resume", () => work.status === "done", 30000);
  assert.equal(fs.readFileSync(path.join(card.worktree, "a.txt"), "utf8"), "checked\n");
});

test("cancelling a checked step while its merge is queued preserves the run branch", async () => {
  const { board, file } = fixture();
  const { card, steps: [work] } = await board.runPlan(plan(), file);
  running(board, work); fs.writeFileSync(path.join(work.worktree, "a.txt"), "cancelled change\n"); settle(board, work);
  await until("checks start", () => work.checks?.status === "running");
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  board.planMerges.set(card.id, gate);
  await finishChecks(board, work, { status: "complete", run: "check-log" });
  await until("merge queued", () => board.planMerges.get(card.id) !== gate);
  board.update(work, { cancelled: true });
  release();
  await board.stepRuns.get(card.id);
  assert.equal(work.status, "review");
  assert.equal(fs.readFileSync(path.join(card.worktree, "a.txt"), "utf8"), "one\n");
});

test("a checked step whose revision is already in the run recovers Done without another commit", async () => {
  const { board, file } = fixture();
  const { card, steps: [work] } = await board.runPlan(plan(), file);
  running(board, work); fs.writeFileSync(path.join(work.worktree, "a.txt"), "landed\n"); settle(board, work);
  await until("checks start", () => work.checks?.status === "running");
  sh(card.worktree, "merge", "--no-ff", "--no-edit", work.checks.revision);
  const recorded = sh(card.worktree, "rev-parse", "HEAD");
  await finishChecks(board, work, { status: "complete", run: "check-log" });
  await until("existing integration recorded", () => work.status === "done");
  assert.equal(sh(card.worktree, "rev-parse", "HEAD"), recorded);
});

test("a merge queued by an old owner waits for the new owner to resume it", async () => {
  const { repo, board, file } = fixture();
  const { card, steps: [work] } = await board.runPlan(plan({}, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"] }]), file);
  running(board, work); fs.writeFileSync(path.join(work.worktree, "a.txt"), "checked\n"); settle(board, work);
  await until("checks start", () => work.checks?.status === "running", 30000);
  let release; const gate = new Promise((resolve) => { release = resolve; }); board.planMerges.set(card.id, gate);
  await finishChecks(board, work, { status: "complete", run: "check-log" });
  await until("merge queued", () => board.planMerges.get(card.id) !== gate, 30000);
  const cardId = card.id, workId = work.id, pending = board.stepRuns.get(card.id); board.dispose(); release(); await pending;
  assert.equal(work.status, "review"); assert.equal(fs.readFileSync(path.join(card.worktree, "a.txt"), "utf8"), "one\n");
  const next = new Board(repo, path.join(repo, "hook.js"), undefined, false); boards.push(next);
  next.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }]; next.accountFolderList = () => [path.join(home, "acct")]; next.checks.start = () => {}; next.tick();
  next.resumeRun(next.get(cardId)); await until("new owner merges", () => next.get(workId).status === "done", 30000);
  assert.equal(fs.readFileSync(path.join(next.get(cardId).worktree, "a.txt"), "utf8"), "checked\n");
});

test("pausing while preparing checks defers them until Resume", async () => {
  const { board, file } = fixture();
  const { card, steps: [work] } = await board.runPlan(plan({}, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"] }]), file);
  let release; const gate = new Promise((resolve) => { release = resolve; }); const ended = board.ended.bind(board);
  board.ended = async (task) => { if (task.id === work.id) await gate; return ended(task); };
  running(board, work); fs.writeFileSync(path.join(work.worktree, "a.txt"), "worker\n"); settle(board, work);
  board.pauseRun(card); release(); await board.preparingPlanChecks.get(work.id);
  assert.equal(work.checks, undefined); assert.equal(fs.readFileSync(path.join(card.worktree, "a.txt"), "utf8"), "one\n");
  board.resumeRun(card); await finishChecks(board, work, { status: "complete", run: "check-log" });
  await until("resumed merge", () => work.status === "done", 30000);
});

test("a paused scribe merge is retried on Resume before plan delivery", async () => {
  const { board, file } = fixture();
  const raw = plan({ scribe: { documents: ["REPORT.md"], after: ["fix"] } }, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"] }]);
  const { card, steps: [work] } = await board.runPlan(raw, file);
  const scribe = board.tasks.find((t) => t.role === "scribe" && t.openedBy === card.id);
  running(board, work); settle(board, work); await finishChecks(board, work, { status: "complete", run: "check-log" });
  await until("scribe starts", () => !!scribe.sessionId, 30000); running(board, scribe);
  fs.writeFileSync(path.join(scribe.worktree, "REPORT.md"), "summary\n"); sh(scribe.worktree, "add", "REPORT.md"); sh(scribe.worktree, "commit", "-qm", "summary");
  let release; const gate = new Promise((resolve) => { release = resolve; }); board.planMerges.set(card.id, gate);
  settle(board, scribe); await until("scribe merge queued", () => board.planMerges.get(card.id) !== gate, 30000);
  board.pauseRun(card); release(); await sleep(100);
  assert.equal(card.deliveryReady, undefined); assert.equal(fs.existsSync(path.join(card.worktree, "REPORT.md")), false);
  board.resumeRun(card); await until("scribe delivered after resume", () => card.deliveryReady === true, 30000);
  assert.equal(fs.readFileSync(path.join(card.worktree, "REPORT.md"), "utf8"), "summary\n");
});

test("model reviewer never receives passed work changed by a real check and cannot mark it done", async () => {
  const { board, file, repo } = fixture();
  const { TaskChecks } = require("../out/checks.js");
  board.checks.start = TaskChecks.prototype.start.bind(board.checks);
  board.checks.onResult = () => {};
  fs.writeFileSync(path.join(repo, "workflows", "checks.json"), JSON.stringify({ mutate: { run: 'node -e "require(\'fs\').writeFileSync(\'a.txt\', \'changed by check\\n\')"' } }));
  const raw = plan({ review: "model" }, [{ id: "fix", title: "Fix", goal: "g", checks: ["mutate"] }]);
  const { card, steps: [work] } = await board.runPlan(raw, file);
  running(board, card); settle(board, card);
  running(board, work); fs.writeFileSync(path.join(work.worktree, "a.txt"), "worker change\n"); settle(board, work);
  await until("real check starts", () => work.checks?.status === "running", 30000);
  const checked = work.checks.revision;
  assert.equal(sh(work.worktree, "show", `${checked}:a.txt`), "worker change");
  await until("real check finishes", () => { board.checks.sync(); return work.checks?.status === "complete" || work.checks?.status === "error"; }, 30000);
  assert.equal(work.checks.status, "complete", work.checks.error);
  await until("changed work held", () => !!work.stepHold, 30000);
  assert.match(work.stepHold, /changed during or after its checks/);
  assert.equal(sh(work.worktree, "rev-parse", "HEAD"), checked);
  assert.match(fs.readFileSync(path.join(work.worktree, "a.txt"), "utf8"), /changed by check/);
  assert.doesNotMatch(board.receiveMessages(card.id).join("\n"), /Child settled:/);
  const result = await board.handleRequest({ v: 1, op: "done", by: card.id, session: card.sessionId, id: work.id }, "done-mutated");
  assert.match(result.error, /no longer matches its checked revision/);
  assert.equal(work.status, "review");
});

for (const interruption of ["conflict", "merge landed before receipt", "approval withdrawn"]) {
  test(`reviewer integration recovers without premature Done: ${interruption}`, async () => {
    const { repo, board, file } = fixture();
    const raw = plan({ review: "model" }, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"] }]);
    const { card, steps: [child] } = await board.runPlan(raw, file);
    running(board, card); running(board, child);
    fs.writeFileSync(path.join(child.worktree, "a.txt"), "worker\n");
    settle(board, child);
    await finishChecks(board, child, { status: "complete", run: "checked" });
    await board.stepRuns.get(card.id);
    const head = child.checks.revision;
    const source = sh(repo, "rev-parse", "HEAD");
    const accept = () => board.handleRequest({ v: 1, op: "integrate", by: card.id, session: card.sessionId, id: child.id }, "accept-" + interruption);
    if (interruption === "conflict") {
      fs.writeFileSync(path.join(card.worktree, "a.txt"), "reviewer\n");
      sh(card.worktree, "commit", "-qam", "concurrent edit");
      const before = sh(card.worktree, "rev-parse", "HEAD");
      assert.match((await accept()).error, /conflicts in a.txt/);
      assert.equal(sh(card.worktree, "rev-parse", "HEAD"), before);
      assert.equal(sh(card.worktree, "status", "--porcelain"), "");
    } else if (interruption === "merge landed before receipt") {
      const merge = board.integrationMerge;
      board.integrationMerge = async (...args) => { await merge(...args); throw new Error("receipt interrupted"); };
      assert.match((await accept()).error, /receipt interrupted/);
      assert.equal(child.status, "review");
      const after = sh(card.worktree, "rev-parse", "HEAD");
      board.integrationMerge = async () => { throw new Error("a retry must recognize the landed commit"); };
      const result = await accept();
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.integrated.head, head);
      assert.equal(result.integrated.after, after);
      assert.equal(child.status, "done");
    } else {
      const before = sh(card.worktree, "rev-parse", "HEAD"), merge = board.integrationMerge;
      board.integrationMerge = (...args) => { board.update(card, { approved: undefined }); return merge(...args); };
      assert.match((await accept()).error, /run changed/);
      assert.equal(sh(card.worktree, "rev-parse", "HEAD"), before);
    }
    if (interruption !== "merge landed before receipt") {
      assert.equal(child.status, "review"); assert.equal(child.integrated, undefined);
    }
    assert.equal(sh(repo, "rev-parse", "HEAD"), source);
  });
}

test("legacy passed plan checks without a revision cannot start a judgment or be marked done", async () => {
  const { board, file } = fixture();
  const raw = plan({ review: "model", judge: "sonnet" }, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"], judge: true }]);
  const { card, steps: [work] } = await board.runPlan(raw, file);
  const judge = board.tasks.find((t) => t.role === "judge" && t.openedBy === card.id);
  running(board, card); settle(board, card); running(board, work); settle(board, work);
  await until("checks start", () => work.checks?.status === "running");
  work.judgeReady = true; // existing persisted state created by an older build
  work.checks = { status: "complete", run: "legacy" };
  await board.requestJudgment(work, card);
  await until("legacy check held", () => !!work.stepHold);
  assert.equal(judge.sessionId, undefined);
  assert.equal(work.judged, undefined);
  assert.match(work.stepHold, /revision|Judgment could not start/);
  assert.equal(work.status, "review");
});

for (const change of ["unchanged", "worker resumed", "checks replaced", "session changed", "run paused", "approval changed", "policy changed", "controller changed", "owner lost", "owner disposed"]) {
  test(`Done revalidates after checked-revision verification: ${change}`, async () => {
    const { board, file } = fixture();
    const raw = plan({ review: "model" }, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"] }]);
    const { card, steps: [work] } = await board.runPlan(raw, file);
    running(board, card); settle(board, card); running(board, work); settle(board, work);
    await finishChecks(board, work, { status: "complete", run: "passed" });
    await sleep(50);
    await board.stepRuns.get(card.id);
    assert.equal(work.status, "review");
    assert.equal(work.checks.status, "complete");
    let release, entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const match = board.matchesCheckedRevision.bind(board);
    board.matchesCheckedRevision = async (task) => { entered = true; await gate; return match(task); };
    const pending = board.handleRequest({ v: 1, op: "done", by: card.id, session: card.sessionId, id: work.id }, `done-${change}`);
    await until("Done is checking the revision", () => entered);
    const isOwner = board.isOwner;
    if (change === "worker resumed") board.update(work, { status: "running" });
    if (change === "checks replaced") board.update(work, { checks: { ...work.checks, run: "new-check-run" } });
    if (change === "session changed") board.update(work, { sessionId: "another-session" });
    if (change === "run paused") board.pauseRun(card);
    if (change === "approval changed") board.update(card, { approved: undefined });
    if (change === "policy changed") board.update(card, { runPolicy: { allow: [], deny: ["external writes"], noSync: true } });
    if (change === "controller changed") board.update(card, { controller: { sessionId: "other-controller", at: new Date().toISOString(), mode: "external" } });
    if (change === "owner lost") board.isOwner = () => false;
    if (change === "owner disposed") board.dispose();
    release();
    if (change === "owner lost" || change === "owner disposed") {
      await assert.rejects(pending, /Another VS Code window/);
      board.isOwner = isOwner;
    } else {
      const result = await pending;
      if (change === "unchanged") assert.equal(result.ok, true);
      else assert.ok(result.error, "stale Done is refused");
    }
    assert.equal(work.status === "done", change === "unchanged");
  });
}

test("a disposed board refuses initial inbox requests and in-flight Ready after awaiting standing roles", async () => {
  const { board, file } = fixture();
  const { card, steps: [work] } = await board.runPlan(plan({ review: "model" }, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"] }]), file);
  board.update(work, { status: "done" });
  let release, entered; const gate = new Promise((resolve) => { release = resolve; });
  board.finishStandingRoles = async () => { entered = true; await gate; return undefined; };
  const request = { v: 1, op: "ready", by: card.id, session: card.sessionId };
  const pending = board.handleRequest(request, "in-flight-ready");
  await until("Ready waits for roles", () => entered);
  board.dispose(); release();
  await assert.rejects(pending, /Another VS Code window/);
  assert.equal(card.deliveryReady, undefined);
  await assert.rejects(board.handleRequest(request, "after-dispose"), /Another VS Code window/);
});

for (const change of ["unchanged", "controller", "approval", "policy", "paused", "child resumed", "child checks", "child added"]) {
  test(`Ready revalidates after standing-role finalization: ${change}`, async () => {
    const { board, file } = fixture();
    const { card, steps: [work] } = await board.runPlan(plan({ review: "model" }, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"] }]), file);
    board.update(work, { status: "done" });
    let release, entered; const gate = new Promise((resolve) => { release = resolve; });
    board.finishStandingRoles = async () => { entered = true; await gate; return undefined; };
    const pending = board.handleRequest({ v: 1, op: "ready", by: card.id, session: card.sessionId }, `ready-${change}`);
    await until("Ready is checking roles", () => entered);
    if (change === "controller") board.update(card, { controller: { sessionId: "another-controller", at: new Date().toISOString(), mode: "external" } });
    if (change === "approval") board.update(card, { approved: undefined });
    if (change === "policy") board.update(card, { runPolicy: { allow: [], deny: ["publish"], noSync: true } });
    if (change === "paused") board.pauseRun(card);
    if (change === "child resumed") board.update(work, { status: "running" });
    if (change === "child checks") board.update(work, { checks: { status: "error", run: "new" } });
    if (change === "child added") board.add("Late child", "work", "acct", card.id, undefined, undefined, undefined, { openedBy: card.id });
    release(); const result = await pending;
    if (change === "unchanged") assert.equal(result.ok, true, JSON.stringify(result));
    else assert.ok(result.error, "stale Ready is refused");
    assert.equal(card.deliveryReady === true, change === "unchanged");
  });
}

test("revoking approval while a Ready scribe merge waits prevents the merge", async () => {
  const { board, file } = fixture();
  const raw = plan({ review: "model", scribe: { documents: ["REPORT.md"], after: ["fix"] } }, [{ id: "fix", title: "Fix", goal: "g", checks: ["unit"] }]);
  const { card, steps: [work] } = await board.runPlan(raw, file);
  const scribe = board.tasks.find((t) => t.role === "scribe" && t.openedBy === card.id);
  running(board, card); settle(board, card); running(board, work); settle(board, work);
  await finishChecks(board, work, { status: "complete", run: "check-log" }); await board.stepRuns.get(card.id);
  sh(card.worktree, "merge", "--no-edit", work.branch);
  const done = await board.handleRequest({ v: 1, op: "done", by: card.id, session: card.sessionId, id: work.id }, "ready-scribe-done");
  assert.equal(done.ok, true, JSON.stringify(done)); await until("scribe starts", () => !!scribe.sessionId, 30000);
  running(board, scribe); fs.writeFileSync(path.join(scribe.worktree, "REPORT.md"), "summary\n");
  sh(scribe.worktree, "add", "REPORT.md"); sh(scribe.worktree, "commit", "-qm", "summary"); settle(board, scribe);
  await until("scribe milestone finished", () => scribe.scribe.milestones[0].complete, 30000);
  let release; const gate = new Promise((resolve) => { release = resolve; }); board.planMerges.set(card.id, gate);
  const pending = board.handleRequest({ v: 1, op: "ready", by: card.id, session: card.sessionId }, "ready-scribe-revoked");
  await until("scribe merge queued", () => board.planMerges.get(card.id) !== gate, 30000);
  board.update(card, { approved: undefined }); release(); const result = await pending;
  assert.ok(result.error); assert.equal(card.deliveryReady, undefined);
  assert.equal(fs.existsSync(path.join(card.worktree, "REPORT.md")), false);
});

// ---- F119: a plan step marked "mayOpen" opens its own cards (the user, 17 November 2026). ----

test("F119: \"mayOpen\" on a step is true or false, and the preview, the step's prompt and the reviewer's list say so", () => {
  const raw = plan({}, [{ id: "lead", title: "Lead", goal: "Split the work.", checks: ["unit"], mayOpen: true }, { id: "docs", title: "Docs", goal: "g", checks: ["lint"], after: ["lead"] }]);
  const v = P.validatePlanFile(raw, RULES);
  assert.ok("cards" in v, JSON.stringify(v.errors));
  const preview = P.planPreview(v.plan, v.cards, CATALOGUE).join("\n");
  assert.match(preview, /1\. Lead .* · may open its own cards/);
  assert.doesNotMatch(preview, /2\. Docs .*may open/);
  assert.match(P.stepPrompt(v.plan, v.cards, 0, "abc123", CATALOGUE), /You may open your own cards .*board\.js ready/);
  assert.doesNotMatch(P.stepPrompt(v.plan, v.cards, 1, "abc123", CATALOGUE), /open your own cards/);
  assert.match(P.stepTable(v.cards.map((card, i) => ({ id: `id${i}`, card }))), /"Lead".*MAY OPEN CARDS/);
  raw.steps[0].mayOpen = "yes";
  assert.match(errorsOf(raw).join(" "), /"mayOpen" must be true or false/);
});

test("F119: a mayOpen step of a plan longer than the open cap opens a card; a plain step may not; the board accepts the step only after its card", async () => {
  const { board, file } = fixture();
  board.preflightHeadless = async () => {};
  const raw = plan({}, [{ id: "lead", title: "Lead", goal: "Split the work.", checks: ["unit"], mayOpen: true },
    ...["a", "b", "c", "d", "e"].map((id) => ({ id, title: `Part ${id}`, goal: "g", checks: ["unit"], after: ["lead"] }))]); // six cards against an open cap of 4
  const { card, steps: [lead, plain] } = await board.runPlan(raw, file);
  assert.deepEqual([lead.orchestrator.root, lead.orchestrator.opened, lead.approved.hash, plain.orchestrator], [card.id, 0, card.approved.hash, undefined]);
  running(board, lead);
  const ask = (by, body) => board.handleRequest({ v: 1, by: by.id, session: by.sessionId ?? "none", ...body }, `f116-${Math.random()}`);
  assert.equal((await ask(plain, { op: "add", title: "x", prompt: "y" })).error, "Not an orchestrator");
  const added = await ask(lead, { op: "add", title: "Helper", prompt: "Do one part." });
  assert.equal(added.created, true, JSON.stringify(added));
  const helper = board.get(added.id);
  assert.deepEqual([helper.openedBy, helper.watchedBy, card.orchestrator.opened], [lead.id, lead.id, 7]);
  await until("the helper to start", () => !!helper.sessionId);
  // The run's capacity: the card's own opener does not count against it, another step's cards do.
  const caps = card.orchestrator.caps.open;
  card.orchestrator.caps.open = 1;
  assert.equal(board.planCapacityWait(helper), undefined);
  assert.match(board.planCapacityWait(plain), /^Waiting for run capacity \(2 of 1 open\)$/);
  card.orchestrator.caps.open = caps;
  // The step's turn ends while its card is open: its checks wait and the board does not merge it.
  settle(board, lead);
  await sleep(300);
  assert.deepEqual([lead.status, lead.checks], ["review", undefined]);
  // The helper settles: the step that opened it hears of it and is woken; the plan card hears nothing.
  running(board, helper); settle(board, helper);
  await until("the step to be woken", () => lead.status === "running");
  assert.match(fs.readFileSync(path.join(board.dir, "launch", `${lead.id}.followup.txt`), "utf8"), new RegExp(`Child settled: ${helper.id}  review`));
  assert.equal(board.pendingNotices.get(card.id)?.has(helper.id) ?? false, false);
  running(board, lead);
  assert.equal((await ask(lead, { op: "done", id: helper.id })).ok, true);
  assert.equal((await ask(lead, { op: "ready" })).ok, true);
  settle(board, lead);
  await finishChecks(board, lead, { status: "complete", run: "" });
  await until("the board to merge the step", () => lead.status === "done");
});
