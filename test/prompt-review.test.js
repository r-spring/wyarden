// Review prompt (src/prompt-review.ts): Terra and Sol improve the draft at max effort, then Astra reviews both at ultra effort.
// The real compiler and the real Codex runner run behind an intercepted spawn in their own Node process; no model is ever called.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { validReview, reviewPrompt } = require("../out/prompt-review");

const REVIEW = { overview: "Sol kept every requirement; Terra added a test the draft never asked for.", comparison: "Sol is closer to the draft.",
  takeaways: ["Keep the fixture name exact."], attempts: [{ model: "Terra", approach: "Expanded into sections.", worked: ["Exact names."], didNotWork: ["Added a test."] },
    { model: "Sol", approach: "One paragraph.", worked: ["Short."], didNotWork: [] }] };

test("validReview keeps a well-formed review and refuses broken ones", () => {
  assert.deepEqual(validReview({ ...REVIEW, overview: "  Sol is closer.  ", takeaways: [" a ", " "] }).takeaways, ["a"]);
  for (const bad of [null, { ...REVIEW, overview: " " }, { ...REVIEW, attempts: "x" }, { ...REVIEW, takeaways: [1] }, { ...REVIEW, attempts: [{ model: "Terra", approach: "x", worked: "x", didNotWork: [] }] }])
    assert.throws(() => validReview(bad), /invalid review/);
});

test("reviewPrompt gives Astra the instruction, the draft, the answers and each attempt, including a failed and an unfinished one", () => {
  const text = reviewPrompt("Fix the flaky test.", "", [
    { label: "Terra", model: "gpt-6.1-terra", effort: "max", elapsedMs: 61_000, status: "ready", format: "xml", prompt: "<task>…</task>", dropped: ["flaky"] },
    { label: "Sol", model: "gpt-6.1-sol", effort: "max", error: "Codex stopped: limit" },
    { label: "Luna", effort: "max", status: "unfinished", conflicts: [{ earlier: "Keep it", later: "Drop it", why: "Both govern it." }] }], undefined, "Repository: x");
  // Since 4 November 2026 the attempts are blind (A, B, C) and Astra sees the project context the improvers had (consensus item 34).
  for (const part of ["Do not write a new prompt", "Compile the original request", "ORIGINAL DRAFT:\nFix the flaky test.", "CLARIFICATION ANSWERS:\nNone", "PROJECT CONTEXT:\nRepository: x",
    "ATTEMPT A\nFormat: xml", "could not find these draft details in its prompt: flaky", "PROMPT:\n<task>…</task>",
    "ATTEMPT B\nFailed: Codex stopped: limit", "ATTEMPT C\nUnfinished", "Earlier: Keep it | Later: Drop it | Why: Both govern it."])
    assert.ok(text.includes(part), part);
  for (const leak of ["Terra", "gpt-6.1-terra", "Sol", "61 s", "max effort"]) assert.ok(!text.split("ATTEMPT A")[1].includes(leak), `the attempts do not name ${leak}`);
});

test("reviewPrompt names the executor, shows each attempt's counts, and does not blame a model for Entomatical's own rendering check", () => {
  const text = reviewPrompt("Fix it.", "", [
    { label: "Terra", model: "gpt-6.1-terra", effort: "max", status: "ready", format: "prose", prompt: "Fix it.", tally: { requirements: 3, criteria: 1, assumed: 2, quarantined: 1, mustAsk: 0, unresolved: 1 } },
    { label: "Sol", model: "gpt-6.1-sol", effort: "max", error: "The rendered prompt did not preserve the task record (missing: x; extra: y); the draft is unchanged." }],
    "A new Codex CLI session (gpt-6.1-sol).");
  assert.ok(text.includes("EXECUTOR:\nA new Codex CLI session (gpt-6.1-sol)."));
  assert.ok(text.includes("Counts: 3 requirements, 1 acceptance checks sent; 1 obligations the model assumed and Entomatical held out of the prompt; 2 assumed context statements sent as unconfirmed; 0 must-ask questions"));
  assert.ok(text.includes("Failed in Entomatical's own rendering check, not in the model's answer: The rendered prompt did not preserve"));
  assert.ok(!text.includes("Claude Fable 5.1"));
});

// Runs in its own Node process: spawn is replaced before the worker loads.
async function chain() {
  const assert = require("node:assert/strict"), path = require("node:path");
  const { EventEmitter } = require("node:events"), { PassThrough, Writable } = require("node:stream");
  const [reviewFile, dir, reviewJson] = process.argv.slice(2);
  const record = { version: 1, status: "ready", outcome: { goal: "Fix the flaky login test.", deliverable: "", beneficiary: "" },
    context: { facts: [], identifiers: ["test/login.test.js"], sources: [], dependencies: [] }, success: { criteria: [] },
    requirements: [{ id: "R1", text: "Keep the fixture name exact.", provenance: "user", strength: "mandatory", rationale: "" }],
    permissions: { authorized: [], confirm: [], prohibited: [] }, unresolved: [], conflicts: [] };
  const unfinished = { ...record, status: "unfinished", conflicts: [{ earlier: "Keep the test.", later: "Delete the test.", why: "Both decide its fate." }] };
  let calls = [], stdin = {}, broken = new Set(), answers = {};
  require("node:child_process").spawn = (binary, args) => {
    assert.equal(args[0], "exec", "the review runs on the Codex CLI only");
    const model = args[args.indexOf("--model") + 1], effort = args.find((a) => a.startsWith("model_reasoning_effort=")).split("=")[1];
    calls.push(`${model}@${JSON.parse(effort)}`);
    const child = new EventEmitter(), chunks = [];
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdin = new Writable({ write(c, e, cb) { chunks.push(c); cb(); }, final(cb) {
      cb(); stdin[model] = Buffer.concat(chunks).toString();
      queueMicrotask(() => {
        if (broken.has(model)) { child.stderr.end("Error: model unavailable\n"); child.stdout.end(""); return child.emit("close", 1); }
        const answer = answers[model] ?? (model === "gpt-6-astra" ? JSON.parse(reviewJson) : record);
        child.stdout.end([{ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(answer) } }, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }].map((e) => JSON.stringify(e)).join("\n"));
        child.emit("close", 0);
      });
    } });
    return child;
  };
  const { reviewImprovements } = require(reviewFile);
  const models = [{ model: "gpt-6.1-sol", efforts: ["max", "ultra"] }, { model: "gpt-6-sol", efforts: ["max", "ultra"] }, { model: "gpt-6.1-terra", efforts: ["max", "ultra"] },
    { model: "gpt-5.6-terra", efforts: ["max"] }, { model: "gpt-6-astra", efforts: ["max", "ultra"] }, { model: "gpt-6-luna", efforts: ["max"] }];
  const signal = new AbortController().signal;
  let n = 0;
  const run = async (m = models) => { calls = []; stdin = {}; const stages = []; const r = await reviewImprovements(path.join(dir, String(n++)), "Fix the flaky login test.", "", { path: "codex-bin", models: m }, signal, (s) => stages.push(s)); return { ...r, stages }; };

  // The newest Terra and Sol improve at max effort, then the newest Astra reviews at ultra effort.
  let r = await run();
  assert.deepEqual(calls.slice(0, 2).sort(), ["gpt-6.1-sol@max", "gpt-6.1-terra@max"]);
  assert.equal(calls[2], "gpt-6-astra@ultra");
  assert.deepEqual(r.stages, ["Terra and Sol are improving the prompt…", "Astra is reviewing their attempts…"]);
  assert.deepEqual(r.attempts.map((a) => [a.label, a.model, a.effort, a.status, a.format]), [["Terra", "gpt-6.1-terra", "max", "ready", "prose"], ["Sol", "gpt-6.1-sol", "max", "ready", "prose"]]);
  assert.ok(r.attempts[0].prompt.includes("Keep the fixture name exact."), r.attempts[0].prompt);
  assert.deepEqual([r.review.overview, r.review.model, r.review.effort, r.reviewError], [JSON.parse(reviewJson).overview, "gpt-6-astra", "ultra", undefined]);
  assert.ok(stdin["gpt-6-astra"].includes("ATTEMPT A\n") && stdin["gpt-6-astra"].includes("ATTEMPT B\n") && !stdin["gpt-6-astra"].split("ATTEMPT A")[1].includes("gpt-6.1-terra"));
  // Sol fails: Terra's attempt is still reviewed, and Astra is told why Sol has none.
  broken = new Set(["gpt-6.1-sol"]);
  r = await run();
  assert.match(r.attempts[1].error, /Codex .* stopped \(exit 1\): .*model unavailable/);
  assert.ok(r.review && stdin["gpt-6-astra"].includes("ATTEMPT B\nFailed: "));
  // Terra leaves it unfinished: its contradictions go to Astra instead of a prompt.
  broken = new Set(); answers = { "gpt-6.1-terra": unfinished };
  r = await run();
  assert.deepEqual([r.attempts[0].status, r.attempts[0].prompt, r.attempts[0].conflicts], ["unfinished", undefined, unfinished.conflicts]);
  assert.ok(stdin["gpt-6-astra"].includes("Unfinished: it reported contradictions instead of a prompt.\n- Earlier: Keep the test. | Later: Delete the test."));
  // Astra fails: the attempts are kept and the reason is returned.
  answers = {}; broken = new Set(["gpt-6-astra"]);
  r = await run();
  assert.equal(r.review, undefined);
  assert.match(r.reviewError, /model unavailable/);
  assert.equal(r.attempts.filter((a) => a.prompt).length, 2);
  // Astra answers in the wrong shape: that is a review error too, not a crash.
  broken = new Set(); answers = { "gpt-6-astra": { overview: "" } };
  r = await run();
  assert.match(r.reviewError, /invalid review/);
  // No Astra model offering ultra: said plainly, no call made for it.
  answers = {};
  r = await run(models.map((m) => (m.model === "gpt-6-astra" ? { ...m, efforts: ["max"] } : m)));
  assert.equal(r.reviewError, "gpt-6-astra does not offer ultra effort.");
  assert.ok(!calls.includes("gpt-6-astra@ultra"));
  // Both improvers fail: one error with both reasons, and Astra is never asked.
  broken = new Set(["gpt-6.1-sol", "gpt-6.1-terra"]);
  await assert.rejects(run(), (e) => /^Neither model could improve the prompt\. Terra: .* Sol: /.test(e.message));
  assert.ok(!calls.some((c) => c.startsWith("gpt-6-astra")));
}

test("reviewImprovements: Terra and Sol at max, Astra at ultra, and every failure path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-prompt-review-"));
  try {
    const script = path.join(dir, "chain.cjs");
    fs.writeFileSync(script, `(${chain.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`);
    execFileSync(process.execPath, [script, require.resolve("../out/prompt-review"), dir, JSON.stringify(REVIEW)], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
