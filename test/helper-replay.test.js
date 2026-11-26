// The receipt summary (tools/helper-receipts.js) and the regression replay (eval/compile-format/replay.js), on synthetic folders
// (4 November 2026 review, item 3.5). No model is called: spawn is forbidden in the replay run.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { summarise } = require("../tools/helper-receipts");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ab-replay-"));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); };

test("the summary reports each kind of folder plainly: pending, corrupt, old receipts, nested calls, missing input", () => {
  const root = tmp();
  try {
    write(path.join(root, "aaaa1111", "refine-receipt.json"), { kind: "refine", receiptStatus: "pending", promptVersion: "refine-2026-11-04", draft: "Fix it.", answers: "", context: "", requestedModel: "fable", requestedEffort: "max" });
    write(path.join(root, "aaaa1111", "text.schema.json"), { properties: { kind: {}, revision: {} } });
    write(path.join(root, "bbbb2222", "text.schema.json"), { properties: { title: {} } });
    write(path.join(root, "bbbb2222", "text.result.json"), "{ not json");
    write(path.join(root, "cccc3333", "compile-receipt.json"), { promptVersion: "compile-2026-10-26-b1", draft: "D", requestedModel: "fable", requestedEffort: "max", observedModel: "claude-fable-5-1" });
    write(path.join(root, "cccc3333", "text.schema.json"), { properties: { requirements: {}, permissions: {} } });
    write(path.join(root, "cccc3333", "text.result.json"), { value: {}, model: "claude-fable-5-1", elapsedMs: 157000, usage: { usage: { input_tokens: 10, output_tokens: 5 } } });
    write(path.join(root, "dddd4444", "rule", "fable", "text.schema.json"), { properties: { goalFound: {} } });
    write(path.join(root, "dddd4444", "rule", "fable", "text.result.json"), { value: {}, model: "claude-fable-5-1", elapsedMs: 5000 });
    // A Review prompt run whose review never came (cancelled): labelled review, not improve.
    write(path.join(root, "eeee5555", "terra", "compile-receipt.json"), { kind: "improve", receiptStatus: "done", draft: "D" });
    write(path.join(root, "eeee5555", "terra", "text.schema.json"), { properties: { requirements: {}, permissions: {} } });
    write(path.join(root, "eeee5555", "sol", "text.schema.json"), { properties: { requirements: {}, permissions: {} } });
    const s = (id) => summarise(path.join(root, id));
    assert.deepEqual([s("eeee5555").kind, s("eeee5555").status], ["review", "no review (cancelled or interrupted)"]);
    assert.deepEqual([s("aaaa1111").status, s("aaaa1111").interrupted, s("aaaa1111").input.draftChars], ["pending", "pending receipt with no result: interrupted work, not re-run", 7]);
    assert.deepEqual([s("bbbb2222").kind, s("bbbb2222").problems.length, s("bbbb2222").input], ["title", 1, "missing"]);
    assert.deepEqual([s("cccc3333").kind, s("cccc3333").status, s("cccc3333").tokens, s("cccc3333").attempts], ["improve", "done (old receipt)", 15, "missing"]);
    assert.deepEqual([s("dddd4444").kind, s("dddd4444").nestedIn], ["completion-rule", path.join("rule", "fable")]);
    const before = fs.readFileSync(path.join(root, "aaaa1111", "refine-receipt.json"), "utf8");
    execFileSync(process.execPath, [path.join(__dirname, "..", "tools", "helper-receipts.js"), "--root", root, "--json"], { encoding: "utf8" });
    assert.equal(fs.readFileSync(path.join(root, "aaaa1111", "refine-receipt.json"), "utf8"), before, "the summary writes nothing");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a dry-run replay calls no model, refuses cases without stored input, skips held-out cases, and leaves the sources unchanged", () => {
  const root = tmp(), helpers = path.join(root, "helpers");
  try {
    const receipt = { promptVersion: "compile-2026-10-26-b1", draft: "Fix the flaky login test.", answers: "Q\nA", executor: "A new Codex CLI session.", context: "Repository: x" };
    write(path.join(helpers, "aaaa1111-0000", "compile-receipt.json"), receipt);
    write(path.join(helpers, "bbbb2222-0000", "text.result.json"), { value: { kind: "questions" } });
    const manifest = path.join(root, "manifest.json");
    write(manifest, { roots: { here: helpers }, cases: [
      { id: "stored", kind: "improve", root: "here", helper: "aaaa1111", split: "regression" },
      { id: "output-only", kind: "refine", root: "here", helper: "bbbb2222", split: "regression" },
      { id: "missing-root", kind: "improve", root: "nowhere", helper: "cccc", split: "regression" },
      { id: "authored", kind: "refine", draft: "Run npm test.", split: "regression" },
      { id: "held", kind: "refine", draft: "Secret held-out case.", split: "held-out" }] });
    const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(helpers, "aaaa1111-0000", "compile-receipt.json"))).digest("hex");
    const script = path.join(root, "run.cjs");
    write(script, `require("node:child_process").spawn = () => { throw new Error("no model may be called in a dry run"); };
require(${JSON.stringify(path.join(__dirname, "..", "eval", "compile-format", "replay.js"))}).main(["--manifest", ${JSON.stringify(manifest)}, "--dry-run"]).then((c) => { process.exitCode = c; });`);
    const out = JSON.parse(execFileSync(process.execPath, [script], { encoding: "utf8" }));
    const by = Object.fromEntries(out.rows.map((r) => [r.case, r]));
    assert.equal(out.dryRun, true);
    assert.deepEqual(Object.keys(by), ["stored", "output-only", "missing-root", "authored"], "the held-out case is skipped");
    assert.equal(by.stored.status, "dry-run");
    assert.equal(by.stored.storedPromptVersion, "compile-2026-10-26-b1");
    assert.equal(by.stored.draftChars, receipt.draft.length);
    assert.match(by["output-only"].reason, /stored no input \(output-only\): replay refused/);
    assert.match(by["missing-root"].reason, /helpers root nowhere not found/);
    assert.equal(by.authored.status, "dry-run");
    const after = crypto.createHash("sha256").update(fs.readFileSync(path.join(helpers, "aaaa1111-0000", "compile-receipt.json"))).digest("hex");
    assert.equal(after, hash, "stored receipts are never changed");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the outcome report matches legacy prompt hashes and groups them by source, read-only", () => {
  const root = tmp();
  try {
    const { join, summary } = require("../tools/prompt-outcomes");
    const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
    const raw = "Fix the flaky test.", improved = "<task>\n  <goal>Fix it.</goal>\n</task>";
    write(path.join(root, "tasks.json"), [{ id: "t1", prompt: raw, status: "done", checks: { status: "complete" } },
      { id: "t2", prompt: `${improved}\n\nCompletion rule (added by Entomatical)\nGoal: x`, status: "review", checks: { status: "error" } }]);
    write(path.join(root, "provenance.jsonl"), [
      { at: "a", event: "create", task: null, promptSha256: sha(raw), chars: raw.length, source: "raw", helpers: [] },
      { at: "b", event: "create", task: null, promptSha256: sha(improved), chars: improved.length, source: "improve", helpers: [{ kind: "improve", edited: false, receipt: "helpers/x/compile-receipt.json" }] },
      { at: "c", event: "follow-up", task: "t2", promptSha256: sha("more"), chars: 4, source: "raw", helpers: [] },
      { at: "d", event: "create", task: null, promptSha256: sha("gone"), chars: 4, source: "refine", helpers: [{ kind: "refine", edited: true, receipt: "r" }] }].map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n");
    const { rows, provenanceLines } = join(root);
    assert.equal(provenanceLines, 4, "an unreadable line is skipped");
    assert.deepEqual(rows.map((r) => [r.source, r.edited, r.task, r.status, r.checks, r.followUps]),
      [["raw", false, "t1", "done", "complete", 0], ["improve", false, "t2", "review", "error", 1], ["refine", true, null, "not found", "unknown", null]]);
    const g = summary(rows);
    assert.deepEqual(Object.keys(g), ["raw", "improve, applied as is", "refine, edited after"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
