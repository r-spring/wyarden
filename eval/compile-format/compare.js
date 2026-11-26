#!/usr/bin/env node
// The downstream comparison (4 November 2026 review, consensus item 39, implementation item 4.3): does Refine draft, Improve prompt or
// both make the executor's work better than the draft as typed? Pre-registered in comparison.json.
//
//   node eval/compile-format/compare.js [--manifest comparison.json] [--dry-run]        plans only; no model is called (the default)
//   node eval/compile-format/compare.js --live [--config-dir <Claude account>] [--codex <codex path>] [--case <id>] [--include-held-out]
//
// Each case's prompt is prepared once per condition (original, refine, improve, two-step) by the production helpers at the maximum policy,
// and that one preparation is run by both executors (Fable/max via Claude Code, the newest Astra at its highest effort via Codex) in a
// fresh fixture repository, then graded with the M9 rubric against the authored record. Preparation and execution costs are reported
// separately; a preparation that fails (refused, unfinished, blocked, oversize) stays in the denominator. Everything lands under
// eval/compile-format/out/compare/<run id>/. A sentinel file beside each fixture repository must be unchanged after the run.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const lib = require("./lib");
const { gradeRun } = require("./grade");

/** A selection error: the CLI exits 2 before anything is planned, prepared or run (EVC-A-04). */
const usage = (message) => Object.assign(new Error(message), { exitCode: 2 });

function args(argv) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  return { manifest: get("--manifest") || path.join(__dirname, "comparison.json"), live: argv.includes("--live"), configDir: get("--config-dir") || "",
    codex: get("--codex"), only: get("--case"), heldOut: argv.includes("--include-held-out"), out: get("--out") };
}

/** The helpers at the maximum policy; tests replace these. */
function productionHelpers(configDir) {
  const text = lib.requireOut("text-actions"), compile = lib.requireOut("compile");
  const signal = new AbortController().signal;
  return {
    refine: (dir, draft, answers) => text.generateText(dir, "refine", draft, configDir, "fable", answers, signal, "max").then((r) => ({ value: r.value, receipt: r.receipt, elapsedMs: r.durationMs ?? r.elapsedMs, usage: r.usage })),
    improve: (dir, draft, answers) => compile.compileDraft(dir, draft, answers, configDir, "fable", "max", signal).then((r) => ({ text: r.rendered?.text, oversize: r.oversize, status: r.record.status, receipt: r.receipt, elapsedMs: r.elapsedMs, usage: r.usage, quarantined: r.quarantined.length })),
  };
}

/** One condition's prompt for one case, or why there is none. Steps keep each helper call's receipt, time and usage. */
async function prepare(entry, condition, helpers, dir) {
  const steps = [];
  const refined = async () => {
    let r = await helpers.refine(path.join(dir, "refine"), entry.draft, "");
    steps.push({ helper: "refine", outcome: r.value.kind, receipt: r.receipt, elapsedMs: r.elapsedMs, usage: r.usage });
    if (r.value.kind === "questions") {
      if (!entry.answers) return { failed: "Refine asked questions and the case has no accepted answers" };
      r = await helpers.refine(path.join(dir, "refine-answers"), entry.draft, entry.answers);
      steps.push({ helper: "refine", outcome: r.value.kind, receipt: r.receipt, elapsedMs: r.elapsedMs, usage: r.usage, withAnswers: true });
      if (r.value.kind === "questions") return { failed: "Refine asked again after the accepted answers" };
    }
    return { text: r.value.kind === "revision" ? r.value.revision : entry.draft };
  };
  const improved = async (draft, answers) => {
    const r = await helpers.improve(path.join(dir, "improve"), draft, answers);
    steps.push({ helper: "improve", outcome: r.status, receipt: r.receipt, elapsedMs: r.elapsedMs, usage: r.usage, quarantined: r.quarantined });
    if (r.status !== "ready" || !r.text) return { failed: `Improve gave no prompt (${r.status})` };
    if (r.oversize) return { failed: `Improve's prompt is over the limit (${r.oversize.chars} characters)` };
    return { text: r.text };
  };
  try {
    let result;
    if (condition === "original") result = { text: entry.draft };
    else if (condition === "refine") result = await refined();
    else if (condition === "improve") result = await improved(entry.draft, entry.answers || "");
    else if (condition === "two-step") { const r = await refined(); result = r.failed ? r : await improved(r.text, ""); }
    else throw new Error(`unknown condition ${condition}`);
    return { condition, prompt: result.text ?? null, status: result.failed ? "preparation-failed" : "ready", reason: result.failed ?? null, steps };
  } catch (e) { return { condition, prompt: null, status: "preparation-failed", reason: e instanceof Error ? e.message : String(e), steps }; }
}

/** The command for one executor run; the prompt goes on stdin. */
function executorCommand(executor, base, caseId, condition, repeat, codexPath) {
  if (executor.provider === "codex") return { binary: codexPath, args: lib.codexExecArgs(executor.model, executor.effort) };
  const manifest = { executor: { ...base, model: executor.model, effort: executor.effort } };
  return { binary: lib.claudeBinary(), args: lib.claudeArgs(manifest, caseId, `${condition}-${executor.id}`, repeat) };
}

/** One executor run in a fresh fixture repository, graded. spawnImpl is child_process.spawn unless a test replaces it. */
function execute({ caseObj, executor, prep, repeat, dir, base, codexPath, configDir, timeoutMs, spawnImpl = spawn }) {
  fs.mkdirSync(dir, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ab-compare-"));
  const workdir = path.join(root, "repo"), sentinel = path.join(root, "outside.txt"), sentinelText = `sentinel ${caseObj.id}\n`;
  fs.writeFileSync(sentinel, sentinelText);
  const fixtureCommit = lib.makeWorkdir(caseObj, workdir);
  const command = executorCommand(executor, base, caseObj.id, prep.condition, repeat, codexPath);
  const receipt = { status: "running", case: caseObj.id, split: caseObj.split, condition: `${prep.condition}/${executor.id}`, repeat, executor: executor.id,
    requestedModel: executor.model, requestedEffort: executor.effort, observedModel: executor.provider === "codex" ? executor.model : null,
    identity: executor.provider === "codex" ? { accepted: true, method: "requested", observedModel: executor.model, reason: "codex exec reports no model of its own" } : undefined,
    promptSha256: lib.sha256(prep.prompt), command: { binary: command.binary, args: command.args, stdin: "prompt" }, fixtureCommit, startedAt: new Date().toISOString() };
  const started = Date.now();
  return new Promise((resolve) => {
    const env = executor.provider === "codex" ? { ...process.env } : lib.environment(configDir);
    const child = spawnImpl(command.binary, command.args, { cwd: workdir, env, windowsHide: true });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.setEncoding?.("utf8"); child.stderr.setEncoding?.("utf8");
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr = (stderr + String(d)).slice(-4000); });
    child.on("error", (e) => { stderr += `\nspawn error: ${e.message}`; });
    child.on("close", (code) => {
      clearTimeout(timer);
      Object.assign(receipt, { finishedAt: new Date().toISOString(), wallClockMs: Date.now() - started, exitCode: code, stderrTail: stderr || undefined, providerOutput: "provider-output.json" });
      fs.writeFileSync(path.join(dir, "provider-output.json"), stdout);
      let facts;
      if (executor.provider === "codex") facts = lib.codexFacts(stdout);
      else { try { const parsed = JSON.parse(stdout); const events = Array.isArray(parsed) ? parsed : [parsed]; facts = lib.streamFacts(events); receipt.identity = lib.observeModel(events, executor.model); receipt.observedModel = receipt.identity.observedModel; } catch { facts = undefined; } }
      receipt.sentinelUnchanged = fs.existsSync(sentinel) && fs.readFileSync(sentinel, "utf8") === sentinelText;
      lib.copyTree(workdir, path.join(dir, "snapshot"));
      receipt.status = timedOut ? "timeout" : code === 0 && facts ? "complete" : "error";
      if (receipt.status !== "complete") receipt.reason = timedOut ? `killed after ${timeoutMs} ms` : `exit code ${code}`;
      lib.saveJson(path.join(dir, "receipt.json"), receipt);
      const graded = gradeRun(caseObj, caseObj.record, dir, receipt, receipt.status === "complete" ? facts : undefined);
      // A write outside the fixture repository is a permission breach whatever the rubric says.
      if (!receipt.sentinelUnchanged) graded.permissionAdherence = "fail";
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* the snapshot is the record */ }
      resolve(graded);
    });
    child.stdin.on("error", () => { /* reported through the exit code */ });
    child.stdin.end(prep.prompt);
  });
}

/** Totals per condition and executor: completion and permission grades, questions where expected, preparation and execution time. */
function summarise(rows, preps) {
  const out = {};
  for (const r of rows) {
    const g = (out[r.condition] ||= { runs: 0, completion: { pass: 0, unknown: 0, fail: 0 }, permissions: { pass: 0, unknown: 0, fail: 0 }, asked: {}, executionMs: 0 });
    g.runs++; g.completion[r.correctCompletion] = (g.completion[r.correctCompletion] || 0) + 1;
    g.permissions[r.permissionAdherence] = (g.permissions[r.permissionAdherence] || 0) + 1;
    if (r.askedAsExpected !== "n/a") g.asked[r.askedAsExpected] = (g.asked[r.askedAsExpected] || 0) + 1;
    g.executionMs += r.wallClockMs || 0;
  }
  const prep = {};
  for (const p of preps) {
    const g = (prep[p.condition] ||= { prepared: 0, failed: 0, helperMs: 0 });
    if (p.status === "ready") g.prepared++; else g.failed++;
    g.helperMs += p.steps.reduce((a, s) => a + (s.elapsedMs || 0), 0);
  }
  return { byConditionAndExecutor: out, preparation: prep };
}

async function main(argv, deps = {}) {
  const a = args(argv);
  const manifest = lib.readJson(a.manifest), base = lib.loadManifest().executor;
  const cases = lib.loadCases();
  if (argv.includes("--case") && !a.only) throw usage("--case needs a case id");
  if (a.only && !manifest.cases.some((e) => e.case === a.only)) throw usage(`unknown case "${a.only}"`);
  const entries = manifest.cases.filter((e) => (!a.only || e.case === a.only)).map((e) => ({ ...e, caseObj: cases.find((c) => c.id === e.case) }))
    .filter((e) => e.caseObj && (a.heldOut || e.caseObj.split !== "held-out"));
  if (!entries.length) throw usage("empty selection: no case left (a held-out case needs --include-held-out)");
  const runId = deps.runId || new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = a.out || path.join(lib.OUT, "compare", runId);
  const conditions = manifest.conditions.map((c) => c.id);
  const plan = { runId, live: a.live, conditions, executors: manifest.executors.map((x) => x.id), cases: entries.map((e) => e.case),
    preparations: entries.length * conditions.length, executorRuns: entries.length * conditions.length * manifest.executors.length * (manifest.repeats || 1) };
  if (!a.live) { console.log(JSON.stringify({ ...plan, note: "dry run: no model was called; --live runs it and spends usage" }, null, 2)); return { plan }; }
  let executors = manifest.executors;
  let codexPath;
  if (executors.some((x) => x.provider === "codex")) {
    const { codexBinary, codexStatus, discoverCodex, setCodexBinary } = lib.requireOut("codex");
    const { helperPolicy } = lib.requireOut("text-actions");
    if (a.codex) setCodexBinary(/[/\\]/.test(a.codex) ? path.resolve(a.codex) : a.codex);
    codexPath = codexBinary();
    // Discover through the same CLI that will execute the prompts, before preparing them.
    await discoverCodex();
    const status = codexStatus();
    if (status?.error) throw new Error(`Codex model discovery failed: ${status.error}`);
    if (!status?.loggedIn) throw new Error("The Codex CLI did not report a signed-in account.");
    const { model, effort } = helperPolicy("codex", [], { accounts: ["codex"], models: status.models });
    executors = executors.map((x) => x.provider === "codex" ? { ...x, model, effort } : x);
  }
  const helpers = deps.helpers || productionHelpers(a.configDir);
  const preps = [], rows = [];
  for (const e of entries) for (const condition of conditions) {
    const prep = await prepare(e, condition, helpers, path.join(outDir, e.case, condition, "prepare"));
    preps.push({ case: e.case, ...prep, prompt: undefined, promptSha256: prep.prompt ? lib.sha256(prep.prompt) : null, promptChars: prep.prompt?.length ?? 0 });
    if (prep.prompt) fs.mkdirSync(path.join(outDir, e.case, condition), { recursive: true }), fs.writeFileSync(path.join(outDir, e.case, condition, "prompt.txt"), prep.prompt);
    for (const executor of executors) for (let repeat = 1; repeat <= (manifest.repeats || 1); repeat++) {
      const dir = path.join(outDir, e.case, condition, executor.id, String(repeat));
      if (!prep.prompt) { rows.push({ case: e.case, condition: `${condition}/${executor.id}`, repeat, status: "preparation-failed", correctCompletion: "fail", permissionAdherence: "unknown", askedAsExpected: e.caseObj.expectedQuestions === "some" ? "unknown" : "n/a", reason: prep.reason }); continue; }
      const graded = await execute({ caseObj: e.caseObj, executor, prep, repeat, dir, base, codexPath, configDir: a.configDir, timeoutMs: manifest.timeoutMs || 600000, spawnImpl: deps.spawn });
      rows.push({ ...graded, wallClockMs: lib.readJson(path.join(dir, "receipt.json")).wallClockMs });
    }
  }
  const report = { ...plan, preparations: preps, rows, summary: summarise(rows, preps) };
  lib.saveJson(path.join(outDir, "comparison.json"), report);
  console.log(JSON.stringify(report.summary, null, 2));
  return report;
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.exitCode ? e.message : e); process.exitCode = e.exitCode ?? 1; });
module.exports = { prepare, executorCommand, execute, summarise, main };
