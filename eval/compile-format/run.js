// Runner for the compile-format comparison.
//   node eval/compile-format/run.js --dry-run
//       renders every prompt, writes out/manifest-resolved.json and one planned receipt per run (status "not-run").
//       Spends nothing. This is the only mode that was executed while building the harness.
//   node eval/compile-format/run.js --live --config-dir <account folder> [--cases a,b] [--formats xml,json] [--repeats n]
//       EXECUTES the user's own `claude` CLI once per case x condition x repeat. Each run spends the subscription
//       usage of the account whose CLAUDE_CONFIG_DIR is given. Needs the user's explicit authorisation first.
// Common options: --out <dir> (default eval/compile-format/out), --workdir-root <dir> (default <tmp>/entomatical-eval).
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const lib = require("./lib");
const { render } = require("./render");

/** A command-line or selection error: the CLI exits 2 and nothing is written (EVC-A-04). */
const usage = (message) => Object.assign(new Error(message), { exitCode: 2 });

function parseArgs(argv) {
  const o = { mode: null, configDir: null, cases: null, formats: null, repeats: 1, out: lib.OUT, workdirRoot: path.join(os.tmpdir(), "entomatical-eval") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.mode = "dry-run";
    else if (a === "--live") o.mode = "live";
    else if (a === "--config-dir") o.configDir = path.resolve(argv[++i]);
    else if (a === "--cases") o.cases = (argv[++i] ?? "").split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--formats") o.formats = (argv[++i] ?? "").split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--repeats") o.repeats = Number(argv[++i]);
    else if (a === "--out") o.out = path.resolve(argv[++i]);
    else if (a === "--workdir-root") o.workdirRoot = path.resolve(argv[++i]);
    else throw usage(`unknown argument ${a}`);
  }
  if (!o.mode) throw usage("pass --dry-run or --live");
  if (!Number.isInteger(o.repeats) || o.repeats < 1) throw usage("--repeats must be a positive integer");
  return o;
}

/** Every case x condition x repeat the options select, in a stable order. */
function plan(manifest, cases, options) {
  const conditions = [...manifest.formats, manifest.shortening.condition].filter(c => !options.formats || options.formats.includes(c));
  if (options.formats) for (const f of options.formats) if (!conditions.includes(f)) throw usage(`unknown format/condition "${f}"`);
  const selected = cases.filter(c => !options.cases || options.cases.includes(c.id));
  if (options.cases) for (const id of options.cases) if (!selected.some(c => c.id === id)) throw usage(`unknown case "${id}"`);
  if (!selected.length || !conditions.length) throw usage(`empty selection: ${selected.length} case(s) x ${conditions.length} condition(s)`);
  const runs = [];
  for (const c of selected) for (const condition of conditions) for (let repeat = 1; repeat <= options.repeats; repeat++) runs.push({ caseObj: c, condition, repeat });
  return { conditions, selected, runs };
}

function resolvedManifest(manifest, cases, options, conditions, runs) {
  return { ...manifest,
    resolvedAt: new Date().toISOString(), mode: options.mode, configDir: options.mode === "live" ? options.configDir : null,
    binary: lib.claudeBinary(), conditions, repeatsRequested: options.repeats, plannedRuns: runs.length,
    hashes: { rubricSha256: lib.fileHash(path.join(lib.ROOT, "rubric.md")), casesSha256: lib.casesHash(), manifestSha256: lib.fileHash(path.join(lib.ROOT, "manifest.json")),
      note: "sha256 of rubric.md, of the cases directory (name + content of every case file) and of manifest.json at resolve time; a later change to any of them is detectable by comparing these" },
    cases: cases.map(c => ({ id: c.id, split: c.split, properties: c.properties, requirements: c.record.requirements.length, expectedQuestions: c.expectedQuestions })) };
}

function runDir(options, run) { return path.join(options.out, run.caseObj.id, run.condition, String(run.repeat)); }
function promptFile(options, run) { return path.join(options.out, run.caseObj.id, `${run.condition}.prompt.txt`); }

function plannedReceipt(manifest, options, run, reason) {
  const text = fs.readFileSync(promptFile(options, run), "utf8");
  return { status: "not-run", reason, case: run.caseObj.id, split: run.caseObj.split, condition: run.condition, repeat: run.repeat,
    requestedModel: manifest.executor.model, requestedEffort: manifest.executor.effort, observedModel: null,
    promptSha256: lib.sha256(text), promptFile: path.relative(options.out, promptFile(options, run)).replace(/\\/g, "/"),
    command: { binary: lib.claudeBinary(), args: lib.claudeArgs(manifest, run.caseObj.id, run.condition, run.repeat), stdin: "prompt", cwd: "<fresh working directory>" },
    plannedAt: new Date().toISOString() };
}

/** One live executor run. Never called in dry-run mode or by the selftest. */
function executeRun(manifest, options, run) {
  const dir = runDir(options, run);
  fs.mkdirSync(dir, { recursive: true });
  const prompt = fs.readFileSync(promptFile(options, run), "utf8");
  const workdir = path.join(options.workdirRoot, `${run.caseObj.id}-${run.condition}-${run.repeat}-${Date.now().toString(36)}`);
  const fixtureCommit = lib.makeWorkdir(run.caseObj, workdir);
  const claudeMd = path.join(options.configDir, "CLAUDE.md");
  const receipt = { ...plannedReceipt(manifest, options, run, ""), status: "running", reason: undefined, configDir: options.configDir,
    configDirClaudeMdSha256: fs.existsSync(claudeMd) ? lib.fileHash(claudeMd) : null, workdir, fixtureCommit, startedAt: new Date().toISOString() };
  lib.saveJson(path.join(dir, "receipt.json"), receipt);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(receipt.command.binary, receipt.command.args, { cwd: workdir, env: lib.environment(options.configDir), windowsHide: true });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, manifest.executor.timeoutMs);
    child.stdout.on("data", d => { stdout += d.toString(); });
    child.stderr.on("data", d => { stderr = (stderr + d.toString()).slice(-4000); });
    child.on("error", e => { stderr += `\nspawn error: ${e.message}`; });
    child.on("close", code => {
      clearTimeout(timer);
      receipt.finishedAt = new Date().toISOString();
      receipt.wallClockMs = Date.now() - started;
      receipt.exitCode = code;
      receipt.stderrTail = stderr || undefined;
      fs.writeFileSync(path.join(dir, "provider-output.json"), stdout); // verbatim, even when empty or invalid
      receipt.providerOutput = "provider-output.json";
      let events = null;
      try { const parsed = JSON.parse(stdout); events = Array.isArray(parsed) ? parsed : [parsed]; } catch { events = null; }
      if (events) {
        const facts = lib.streamFacts(events);
        const identity = lib.observeModel(events, manifest.executor.model);
        Object.assign(receipt, { observedModel: identity.observedModel, identity, usage: facts.usage ?? null, modelUsage: facts.modelUsage ?? null,
          totalTokens: facts.totalTokens, elapsedMs: facts.elapsedMs, numTurns: facts.numTurns, resultSubtype: facts.resultSubtype, resultIsError: facts.resultIsError });
      } else {
        Object.assign(receipt, { identity: { observedModel: null, method: "unparsable", accepted: false, reason: "provider output is not JSON" }, usage: null, totalTokens: null, elapsedMs: null });
      }
      receipt.gitStatus = lib.gitStatus(workdir);
      lib.copyTree(workdir, path.join(dir, "snapshot"));
      receipt.snapshot = "snapshot";
      receipt.status = timedOut ? "timeout" : code === 0 && events ? "complete" : "error";
      if (receipt.status !== "complete") receipt.reason = timedOut ? `killed after ${manifest.executor.timeoutMs} ms` : `exit code ${code}${events ? "" : ", provider output not JSON"}`;
      try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* the snapshot is the record; a leftover temp dir is harmless */ }
      lib.saveJson(path.join(dir, "receipt.json"), receipt);
      resolve(receipt);
    });
    child.stdin.on("error", () => { /* reported through exit code */ });
    child.stdin.end(prompt);
  });
}

async function main(argv = process.argv.slice(2), log = console.log) {
  const options = parseArgs(argv);
  const manifest = lib.loadManifest();
  const cases = lib.loadCases();
  const { conditions, selected, runs } = plan(manifest, cases, options);
  const rendered = render({ out: options.out, cases: lib.CASES_DIR }, log);
  lib.saveJson(path.join(options.out, "manifest-resolved.json"), resolvedManifest(manifest, cases, options, conditions, runs));
  if (!rendered.ok && options.mode === "live") throw new Error(`${rendered.failures} rendering(s) failed the preservation check (see out/preservation-checks.json); fix the renderer or the check before spending a live run`);
  if (options.mode === "dry-run") {
    if (!rendered.ok) { log(`\nWARNING: ${rendered.failures} rendering(s) failed the preservation check (see out/preservation-checks.json); planned receipts are still written, exit code 1`); process.exitCode = 1; }
    let planned = 0, kept = 0;
    for (const run of runs) {
      const file = path.join(runDir(options, run), "receipt.json");
      if (fs.existsSync(file) && lib.readJson(file).status !== "not-run") { kept++; continue; } // never overwrite a real run's receipt
      lib.saveJson(file, plannedReceipt(manifest, options, run, "dry run: no live runs were authorised in this session"));
      planned++;
    }
    log(`\ndry run: ${planned} planned receipt(s) written with status "not-run" (${kept} existing live receipt(s) left untouched); ${runs.length} runs = ${selected.length} cases x ${conditions.length} conditions x ${options.repeats} repeat(s)`);
    log("no claude process was started and no usage was spent");
    return { planned, runs: runs.length };
  }
  if (!options.configDir) throw new Error("--live needs --config-dir <account folder> (the user chooses the account; manifest.accounts is null)");
  if (!fs.existsSync(options.configDir)) throw new Error(`config dir ${options.configDir} does not exist`);
  log(`LIVE: ${runs.length} executor run(s) with CLAUDE_CONFIG_DIR=${options.configDir}. Each spends subscription usage.`);
  let done = 0, skipped = 0;
  for (const run of runs) {
    const file = path.join(runDir(options, run), "receipt.json");
    if (fs.existsSync(file) && lib.readJson(file).status === "complete") { skipped++; continue; } // resume: a completed run is never paid for twice
    const receipt = await executeRun(manifest, options, run);
    done++;
    log(`${receipt.status} ${run.caseObj.id} ${run.condition} #${run.repeat} model=${receipt.observedModel ?? "?"} tokens=${receipt.totalTokens ?? "?"} elapsedMs=${receipt.elapsedMs ?? "?"} exit=${receipt.exitCode}`);
  }
  log(`\nlive: ${done} run(s) executed, ${skipped} already complete. Next: node eval/compile-format/grade.js && node eval/compile-format/report.js`);
  return { done, skipped };
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = e.exitCode ?? 1; });
module.exports = { parseArgs, plan, plannedReceipt, resolvedManifest, main };
