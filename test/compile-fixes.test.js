// Improve prompt fixes from the 3 November 2026 review of ten real runs (docs/parity/FEATURES.md F22). Renderer and checker run directly;
// compileDraft runs behind an intercepted claude spawn in its own Node process, so no model is called.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const compile = require("../out/compile");
const { preservationCheck } = require("../out/compile-check");
const { validTaskRecord } = require("../out/task-record");

const base = () => ({ version: 1, status: "ready", outcome: { goal: "Fix the flaky login test.", deliverable: "", beneficiary: "" },
  context: { facts: [], identifiers: [], sources: [], dependencies: [] }, success: { criteria: [] }, requirements: [],
  permissions: { authorized: [], confirm: [], prohibited: [] }, unresolved: [], conflicts: [] });

test("a permission statement containing '; ' renders on its own line and survives the preservation check", () => {
  // Real case 0ebb27e8 (Fable max, 231 s): two confirm items of this form made the whole Improve fail after the paid call.
  const r = base();
  r.permissions.confirm = [{ text: "Pushing the task branch to origin is not stated; confirm before pushing.", provenance: "user" },
    { text: "Deleting the old fixtures is not stated; confirm first.", provenance: "user" }];
  r.permissions.authorized = [{ text: "Edit files under src/; run npm test.", provenance: "user" }];
  r.unresolved = [{ text: "Which browser to test in.", provenance: "user", state: "not-provided" }];
  const record = validTaskRecord(r), rendered = { format: "xml", text: compile.renderXml(record) };
  assert.deepEqual(preservationCheck(record, compile.renderExecutionPrompt(record)).ok, true, "and in prose, which this record now gets");
  assert.equal(rendered.format, "xml");
  assert.match(rendered.text, /^    Requires confirmation: Pushing the task branch to origin is not stated; confirm before pushing\.$/m);
  assert.match(rendered.text, /^    Requires confirmation: Deleting the old fixtures is not stated; confirm first\.$/m);
  assert.deepEqual(preservationCheck(record, rendered), { ok: true, missing: [], extra: [] });
  assert.deepEqual(preservationCheck(record, { format: "markdown", text: compile.renderMarkdown(record) }).ok, true);
});

test("statements with blank lines, indented lines, stray spaces or a lone carriage return round-trip", () => {
  const r = base();
  r.requirements = [{ id: "R1", text: "  Keep the order:\n\n  - first the header\r\n  - then the rows ", provenance: "user", strength: "mandatory", rationale: "" },
    { id: "R2", text: "Old Mac line\rend.", provenance: "user", strength: "mandatory", rationale: "" }];
  r.unresolved = [{ text: "Row limit.", provenance: "user", state: "not-provided" }];
  const record = validTaskRecord(r), rendered = { format: "xml", text: compile.renderXml(record) };
  assert.deepEqual(preservationCheck(record, compile.renderExecutionPrompt(record)).ok, true, "prose, which this record now gets");
  assert.match(rendered.text, /^    - Keep the order: - first the header - then the rows$/m); // no ids: there are no acceptance checks
  assert.match(rendered.text, /^    - Old Mac line end\.$/m);
  assert.deepEqual(preservationCheck(record, rendered).ok, true);
});

test("prose labels an exclusion and ends every statement as a sentence, so nothing runs together", () => {
  const r = base();
  r.outcome.goal = "Add CSV export for the filtered results table";
  r.requirements = [{ id: "R1", text: "Export only rows matching the active filters", provenance: "user", strength: "mandatory", rationale: "" },
    { id: "R2", text: "the public API", provenance: "user", strength: "exclusion", rationale: "" }];
  r.permissions.prohibited = [{ text: "deploy", provenance: "user" }];
  r.outcome.deliverable = "Working local change";
  const record = validTaskRecord(r), rendered = compile.renderExecutionPrompt(record);
  assert.equal(rendered.format, "prose");
  assert.equal(rendered.text, "Add CSV export for the filtered results table. Export only rows matching the active filters. Exclusion: the public API. Not authorized: deploy. Deliver: Working local change.");
  assert.deepEqual(preservationCheck(record, rendered).ok, true);
});

// Runs in its own Node process: spawn is replaced before the worker loads.
async function chain() {
  const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
  const { EventEmitter } = require("node:events"), { PassThrough, Writable } = require("node:stream");
  const [compileFile, dir] = process.argv.slice(2);
  let answer, stdin = "";
  require("node:child_process").spawn = (binary, args) => {
    const model = args[args.indexOf("--model") + 1].replace(/^claude-([a-z]+)-[\d-]+$/, "$1"); // the CLI gets the full id (models.ts CLAUDE_MODEL_IDS)
    const child = new EventEmitter(), chunks = [];
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdin = new Writable({ write(c, e, cb) { chunks.push(c); cb(); }, final(cb) {
      cb(); stdin = Buffer.concat(chunks).toString();
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s", subagent_stats: { spawned: 0 }, structured_output: answer,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: { [`claude-${model}-5-5`]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }));
        child.emit("close", 0);
      });
    } });
    return child;
  };
  const compile = require(compileFile), signal = new AbortController().signal;
  const draft = "Fix the flaky login test in test/login.test.js and keep npm test green.";
  const record = { version: 1, status: "ready", outcome: { goal: "Fix the flaky login test.", deliverable: "", beneficiary: "" },
    context: { facts: [], identifiers: ["test/login.test.js"], sources: [{ label: "Request", content: `  ${draft.replace(/ /g, "  ")}\n` }], dependencies: [] },
    success: { criteria: [{ id: "A1", text: "npm test passes.", provenance: "user", covers: ["R1"] }] },
    requirements: [{ id: "R1", text: "Fix the flaky login test.", provenance: "user", strength: "mandatory", rationale: "" },
      { id: "R2", text: "Add a retry helper.", provenance: "assumption", strength: "mandatory", rationale: "" }],
    permissions: { authorized: [], confirm: [], prohibited: [] }, unresolved: [{ text: "Which CI runs it.", provenance: "user", state: "must-ask" }], conflicts: [] };
  const receiptOf = (d) => JSON.parse(fs.readFileSync(path.join(d, "compile-receipt.json"), "utf8"));

  // The executor line and project context reach the model; the request filed as its own source is dropped; counts come back.
  answer = record;
  const extra = { executor: "A new Codex CLI session (gpt-6.1-sol).", context: "Repository: entomatical\n{\"scripts\":{\"test\":\"node --test\"}}" };
  let d = path.join(dir, "ok");
  const r = await compile.compileDraft(d, draft, "", "", "opus", "high", signal, [], undefined, extra);
  assert.equal(stdin, compile.compilePrompt(draft, "", extra));
  assert.ok(stdin.includes("EXECUTOR:\nA new Codex CLI session (gpt-6.1-sol).") && stdin.endsWith(`PROJECT CONTEXT:\n${extra.context}`));
  assert.deepEqual(r.record.context.sources, [], "the request is not its own source");
  assert.ok(!r.rendered.text.includes("<source_content>"));
  // R2 "Add a retry helper" was assumed: it is quarantined (not sent), and counted as such (4 November 2026, items 46, 50).
  assert.deepEqual(r.tally, { requirements: 1, criteria: 1, assumed: 0, quarantined: 1, mustAsk: 1, unresolved: 1 });
  assert.deepEqual(r.quarantined, [{ kind: "requirement", id: "R2", text: "Add a retry helper." }]);
  assert.ok(!r.rendered.text.includes("Add a retry helper."), "the assumed requirement is not in the prompt");
  let receipt = receiptOf(d);
  assert.deepEqual([receipt.outcome, receipt.provider, receipt.modelSource, receipt.executor, receipt.preservation.ok, receipt.tally.quarantined, receipt.draftChars],
    ["ready", "claude", "observed", extra.executor, true, 1, draft.length]);
  assert.deepEqual(receipt.quarantined, r.quarantined, "the receipt keeps what was held back");
  // An invalid record still leaves a receipt that says so.
  answer = { ...record, requirements: [{ ...record.requirements[0], id: "" }] };
  d = path.join(dir, "invalid");
  await assert.rejects(compile.compileDraft(d, draft, "", "", "opus", "high", signal), /invalid task record/);
  receipt = receiptOf(d);
  assert.deepEqual([receipt.outcome, receipt.observedModel], ["invalid-record", "claude-opus-5-5"]);
  assert.match(receipt.error, /requirement id "" is malformed/);
  // An unfinished record is recorded as such, with nothing rendered.
  answer = { ...record, status: "unfinished", conflicts: [{ earlier: "Keep it.", later: "Drop it.", why: "Both decide it." }] };
  d = path.join(dir, "unfinished");
  const u = await compile.compileDraft(d, draft, "", "", "opus", "high", signal);
  assert.equal(u.rendered, undefined);
  assert.deepEqual([receiptOf(d).outcome, receiptOf(d).format], ["unfinished", null]);
}

test("compileDraft sends the executor and project context, drops the request filed as a source, and records every outcome in the receipt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-compile-fixes-"));
  try {
    const script = path.join(dir, "chain.cjs");
    fs.writeFileSync(script, `(${chain.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`);
    execFileSync(process.execPath, [script, require.resolve("../out/compile"), dir], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
