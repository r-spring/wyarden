// Obligations the model admits it assumed are quarantined: kept in the record, left out of the executor prompt, shown for review
// (4 November 2026 review, consensus items 19, 20, 46, 50; implementation item 2.2).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const compile = require("../out/compile");
const { preservationCheck } = require("../out/compile-check");
const { validTaskRecord, executorView, quarantined, quarantineProblems } = require("../out/task-record");

const base = () => ({ version: 1, status: "ready", outcome: { goal: "Fix the flaky login test.", deliverable: "", beneficiary: "" },
  context: { facts: [], identifiers: [], sources: [], dependencies: [] }, success: { criteria: [] }, requirements: [],
  permissions: { authorized: [], confirm: [], prohibited: [] }, unresolved: [], conflicts: [] });
const req = (id, text, provenance = "user") => ({ id, text, provenance, strength: "mandatory", rationale: "" });

test("assumed requirements, checks and permissions leave the prompt; IDs renumber and covers follow; context assumptions stay labelled", () => {
  const r = base();
  r.requirements = [req("R1", "Fix the race."), req("R2", "Add a retry helper.", "assumption"), req("R3", "Keep the test name.")];
  r.success.criteria = [{ id: "A1", text: "The test passes ten runs in a row.", provenance: "user", covers: ["R1", "R2"] },
    { id: "A2", text: "Coverage stays the same.", provenance: "assumption", covers: ["R3"] },
    { id: "A3", text: "The name is unchanged.", provenance: "explicit-change", covers: ["R3"] }];
  r.permissions.authorized = [{ text: "Edit test/login.test.js.", provenance: "user" }, { text: "Read the workspace.", provenance: "assumption" }];
  r.permissions.prohibited = [{ text: "Push to main.", provenance: "assumption" }];
  r.context.facts = [{ text: "The race is in the setup hook.", provenance: "assumption" }];
  const record = validTaskRecord(r), v = executorView(record);
  assert.deepEqual(v.requirements.map((q) => [q.id, q.text]), [["R1", "Fix the race."], ["R2", "Keep the test name."]]);
  assert.deepEqual(v.success.criteria.map((a) => [a.id, a.covers]), [["A1", ["R1"]], ["A2", ["R2"]]], "covers drop the quarantined R2 and follow R3 -> R2");
  assert.deepEqual(v.permissions, { authorized: [{ text: "Edit test/login.test.js.", assumed: false }], confirm: [], prohibited: [] });
  assert.deepEqual(v.context.facts, [{ text: "The race is in the setup hook.", assumed: true }], "assumed context stays, labelled");
  assert.deepEqual(quarantined(record), [{ kind: "requirement", id: "R2", text: "Add a retry helper." }, { kind: "acceptance", id: "A2", text: "Coverage stays the same." },
    { kind: "authorized", text: "Read the workspace." }, { kind: "prohibited", text: "Push to main." }]);
  assert.deepEqual(quarantineProblems(record), [], "A1 keeps R1, so nothing blocks");
  for (const rendered of [compile.renderExecutionPrompt(record), { format: "xml", text: compile.renderXml(record) }, { format: "markdown", text: compile.renderMarkdown(record) }]) {
    assert.deepEqual(preservationCheck(record, rendered), { ok: true, missing: [], extra: [] }, rendered.format);
    for (const q of quarantined(record)) assert.ok(!rendered.text.includes(q.text), `${rendered.format} leaves out "${q.text}"`);
  }
  assert.ok(!compile.renderXml(record).includes("Requires confirmation"), "no assumed authorization becomes a confirmation gate");
  assert.deepEqual(compile.tally(record), { requirements: 2, criteria: 2, assumed: 1, quarantined: 4, mustAsk: 0, unresolved: 0 });
  assert.equal(record.requirements.length, 3, "the record keeps everything");
});

test("a user's check that covered only assumed requirements blocks the result instead of checking nothing", () => {
  const r = base();
  r.requirements = [req("R1", "Fix the race."), req("R2", "Add a retry helper.", "assumption"), req("R3", "Log each retry.", "assumption")];
  r.success.criteria = [{ id: "A1", text: "Retries are logged.", provenance: "user", covers: ["R2", "R3"] }, { id: "A2", text: "The test passes.", provenance: "user", covers: ["R1"] }];
  const problems = quarantineProblems(validTaskRecord(r));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Check A1 \("Retries are logged\."\) covers only requirements the model assumed \(R2, R3\)/);
  // An assumed check over assumed requirements is just quarantined with them; a check that covers nothing is not a loss.
  r.success.criteria[0].provenance = "assumption";
  r.success.criteria.push({ id: "A3", text: "It is faster.", provenance: "user", covers: [] });
  assert.deepEqual(quarantineProblems(validTaskRecord(r)), []);
});

// compileDraft behind an intercepted spawn: the blocked result is kept in the receipt and costs no second call.
async function blocked() {
  const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
  const { EventEmitter } = require("node:events"), { PassThrough, Writable } = require("node:stream");
  const [compileFile, dir, recordJson] = process.argv.slice(2);
  let spawns = 0;
  require("node:child_process").spawn = (file, args) => {
    spawns++;
    const model = args[args.indexOf("--model") + 1].replace(/^claude-([a-z]+)-[\d-]+$/, "$1"); // the CLI gets the full id (models.ts CLAUDE_MODEL_IDS)
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdin = new Writable({ write(c, e, cb) { cb(); }, final(cb) { cb(); queueMicrotask(() => {
      child.stdout.end(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s", subagent_stats: { spawned: 0 }, structured_output: JSON.parse(recordJson),
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: { [`claude-${model}-5-5`]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }));
      child.emit("close", 0); }); } });
    return child;
  };
  const compile = require(compileFile);
  const folder = path.join(dir, "blocked");
  await assert.rejects(compile.compileDraft(folder, "Fix the flaky login test and log retries.", "", "", "opus", "high", new AbortController().signal),
    /The improved prompt was not applied: Check A1 .* covers only requirements the model assumed/);
  const receipt = JSON.parse(fs.readFileSync(path.join(folder, "compile-receipt.json"), "utf8"));
  assert.deepEqual([receipt.outcome, receipt.receiptStatus, receipt.quarantineProblems.length, receipt.quarantined.length], ["quarantine-blocked", "failed", 1, 2]);
  assert.ok(fs.existsSync(path.join(folder, "text.result.json")), "the model's answer is kept");
  // Asking again with the same input reuses the saved answer: no second paid call, the same verdict.
  await assert.rejects(compile.compileDraft(folder, "Fix the flaky login test and log retries.", "", "", "opus", "high", new AbortController().signal), /not applied/);
  assert.equal(spawns, 1);
}

test("compileDraft keeps a blocked record in its receipt, applies nothing, and reuses the saved answer instead of calling again", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-quarantine-"));
  const r = base();
  r.requirements = [req("R1", "Fix the race."), req("R2", "Add a retry helper.", "assumption"), req("R3", "Log each retry.", "assumption")];
  r.success.criteria = [{ id: "A1", text: "Retries are logged.", provenance: "user", covers: ["R2", "R3"] }];
  try {
    const script = path.join(dir, "blocked.cjs");
    fs.writeFileSync(script, `(${blocked.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`);
    execFileSync(process.execPath, [script, require.resolve("../out/compile"), dir, JSON.stringify(r)], { encoding: "utf8", timeout: 20_000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Item 3.3: the model writes no ids (Entomatical numbers fresh output), and facts from PROJECT CONTEXT have their own provenance.
test("fresh model output is numbered R1.. and A1.. by position; a record that has ids keeps them; covers must still name real requirements", () => {
  const { numberFreshRecord, COMPILE_INSTRUCTION } = compile;
  const fresh = { ...base(), requirements: [{ text: "Fix the race.", provenance: "user", strength: "mandatory", rationale: "" }, { text: "Keep the name.", provenance: "user", strength: "preference", rationale: "" }],
    success: { criteria: [{ text: "Passes ten runs.", provenance: "user", covers: ["R1"] }, { text: "Name unchanged.", provenance: "user", covers: ["R2"] }] } };
  const numbered = validTaskRecord(numberFreshRecord(fresh));
  assert.deepEqual(numbered.requirements.map((r) => r.id), ["R1", "R2"]);
  assert.deepEqual(numbered.success.criteria.map((a) => [a.id, a.covers]), [["A1", ["R1"]], ["A2", ["R2"]]]);
  assert.equal("id" in fresh.requirements[0], false, "the model's answer is not changed in place");
  const legacy = { ...base(), requirements: [req("R2", "Old numbering.")], success: { criteria: [{ id: "A7", text: "Checked.", provenance: "user", covers: ["R2"] }] } };
  assert.deepEqual(validTaskRecord(numberFreshRecord(legacy)).success.criteria[0].id, "A7", "a legacy record keeps its own ids");
  assert.throws(() => validTaskRecord(numberFreshRecord({ ...fresh, success: { criteria: [{ text: "x", provenance: "user", covers: ["R9"] }] } })), /covers unknown requirement "R9"/);
  const schema = require("../out/task-record").TASK_RECORD_SCHEMA;
  assert.equal("id" in schema.properties.requirements.items.properties, false);
  assert.equal("id" in schema.properties.success.properties.criteria.items.properties, false);
  assert.ok(COMPILE_INSTRUCTION.replace(/\s+/g, " ").includes("Entomatical numbers the requirements R1, R2, ... in the order you list them"));
});

test("project provenance: a fact from PROJECT CONTEXT is sent as a plain fact; an obligation marked project is quarantined", () => {
  const r = base();
  r.context.facts = [{ text: "Tests run with node --test.", provenance: "project" }];
  r.requirements = [req("R1", "Fix the race."), req("R2", "Run npm run lint too.", "project")];
  r.permissions.authorized = [{ text: "Edit any file under src.", provenance: "project" }];
  const record = validTaskRecord(r), v = executorView(record);
  assert.deepEqual(v.context.facts, [{ text: "Tests run with node --test.", assumed: false }]);
  assert.deepEqual(v.requirements.map((q) => q.text), ["Fix the race."]);
  assert.deepEqual(quarantined(record).map((q) => [q.kind, q.text]), [["requirement", "Run npm run lint too."], ["authorized", "Edit any file under src."]]);
  assert.ok(!compile.renderXml(record).includes("Assumed (unconfirmed): Tests run"), "a project fact is not labelled as a guess");
});
