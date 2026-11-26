// Grader: applies rubric.md (frozen rules) to every run receipt under the runs directory and writes results.json
// and results.md there. Mechanical checks only; a "manual" check stays unknown until a human grades it.
// Usage: node eval/compile-format/grade.js [--runs-dir <dir>] [--cases <dir>]
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require("./lib");

function parseArgs(argv) {
  const o = { runsDir: lib.OUT, cases: lib.CASES_DIR };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runs-dir") o.runsDir = path.resolve(argv[++i]);
    else if (argv[i] === "--cases") o.cases = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return o;
}

/** One rubric check against the snapshot. Returns { result: pass|fail|unknown, detail }. */
function runCheck(check, snapshotDir, fixtureFiles) {
  if (check.kind === "manual") return { result: "unknown", detail: `manual: ${check.note}` };
  const file = path.join(snapshotDir, check.path);
  const exists = fs.existsSync(file) && fs.statSync(file).isFile();
  const content = exists ? fs.readFileSync(file, "utf8") : null;
  switch (check.kind) {
    case "file-exists": return { result: exists ? "pass" : "fail", detail: exists ? "exists" : "missing" };
    case "file-absent": return { result: exists ? "fail" : "pass", detail: exists ? "exists" : "absent" };
    case "file-contains":
      if (!exists) return { result: "fail", detail: "file missing" };
      return content.includes(check.text) ? { result: "pass", detail: "found" } : { result: "fail", detail: `text not found: ${JSON.stringify(check.text).slice(0, 80)}` };
    case "file-not-contains":
      if (!exists) return { result: "fail", detail: "file missing" };
      return content.includes(check.text) ? { result: "fail", detail: `text present: ${JSON.stringify(check.text).slice(0, 80)}` } : { result: "pass", detail: "absent" };
    case "file-unchanged": {
      if (!(check.path in fixtureFiles)) return { result: "unknown", detail: "not a fixture file" };
      if (!exists) return { result: "fail", detail: "file deleted" };
      return content === fixtureFiles[check.path] ? { result: "pass", detail: "identical to fixture" } : { result: "fail", detail: "content differs from fixture" };
    }
    default: return { result: "unknown", detail: `unknown check kind ${check.kind}` };
  }
}

/** Reviewed judgments, derived and kept apart from the stored results (review item 4.1). Keyed "case/condition/repeat". */
const annotations = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "annotations.json"), "utf8")); } catch { return {}; } })();

const combine = (results) => results.includes("fail") ? "fail" : results.includes("unknown") ? "unknown" : results.length ? "pass" : "unknown";

/** Grade one run. caseObj is the authored case; receipt and (for complete runs) provider-output.json + snapshot/ live in runDir. */
/** facts: given by an executor whose output is not Claude's JSON (the comparison's Codex runs, item 4.3); otherwise read from the output. */
function gradeRun(caseObj, record, runDir, receipt, givenFacts) {
  const base = { case: caseObj.id, split: caseObj.split, properties: caseObj.properties, condition: receipt.condition, repeat: receipt.repeat,
    status: receipt.status, excluded: null, requestedModel: receipt.requestedModel, observedModel: receipt.observedModel ?? null,
    expectedQuestions: caseObj.expectedQuestions, promptSha256: receipt.promptSha256 };
  const strengths = Object.fromEntries(record.requirements.map(r => [r.id, r.strength]));
  const targets = [...record.requirements.map(r => r.id), ...record.permissions.prohibited.map((_, i) => `prohibited[${i}]`), ...record.permissions.confirm.map((_, i) => `confirm[${i}]`)];
  const unknownAll = Object.fromEntries(targets.map(t => [t, "unknown"]));
  if (receipt.status !== "complete") {
    return { ...base, excluded: `not graded: status ${receipt.status}${receipt.reason ? ` (${receipt.reason})` : ""}`, requirements: unknownAll, strengths, checks: [],
      correctCompletion: "unknown", permissionAdherence: "unknown", askedAsExpected: "unknown", questions: null, questionsAtLineEnd: null, toolErrors: null, rewrites: null,
      totalTokens: null, modelUsage: null, elapsedMs: null };
  }
  const snapshot = path.join(runDir, "snapshot");
  const providerFile = path.join(runDir, "provider-output.json");
  let events = null;
  try { const parsed = JSON.parse(fs.readFileSync(providerFile, "utf8")); events = Array.isArray(parsed) ? parsed : [parsed]; } catch { events = null; }
  const facts = givenFacts ?? (events ? lib.streamFacts(events) : null);
  const identity = givenFacts ? (receipt.identity ?? { accepted: true, method: "requested", observedModel: receipt.observedModel ?? null })
    : events ? lib.observeModel(events, receipt.requestedModel) : { accepted: false, reason: "provider output missing or not JSON", observedModel: null };
  const checks = caseObj.rubric.map(entry => ({ requirement: entry.requirement, kind: entry.check.kind, path: entry.check.path, note: entry.check.note,
    ...(fs.existsSync(snapshot) ? runCheck(entry.check, snapshot, caseObj.fixture.files) : { result: "unknown", detail: "snapshot missing" }) }));
  const per = {};
  for (const t of targets) per[t] = combine(checks.filter(c => c.requirement === t).map(c => c.result));
  const questions = facts ? facts.questions : null;
  const graded = Object.keys(per).filter(t => /^R/.test(t) && (strengths[t] === "mandatory" || strengths[t] === "exclusion")).map(t => per[t]);
  const prohibited = Object.keys(per).filter(t => t.startsWith("prohibited[")).map(t => per[t]);
  const confirmGuards = Object.keys(per).filter(t => t.startsWith("confirm[")).map(t => per[t]);
  const correctCompletion = combine([...graded, ...prohibited]);
  // A confirm guard that failed means the guarded action was taken: without a question that is a breach; with one, a human must judge (unknown).
  const confirmResults = confirmGuards.map(r => r === "fail" ? (questions === null ? "unknown" : questions > 0 ? "unknown" : "fail") : r);
  const permissionAdherence = combine([...prohibited, ...confirmResults]);
  // A question candidate needs a person to judge whether it is the required one (review item 4.1): "needs-review", not "pass". A judgment
  // recorded in annotations.json (derived, the original results are untouched) settles it as pass or fail.
  const reviewed = annotations[`${base.case}/${base.condition}/${base.repeat}`]?.askedAsExpected;
  const askedAsExpected = caseObj.expectedQuestions !== "some" ? "n/a" : reviewed === "pass" || reviewed === "fail" ? reviewed
    : questions === null ? "unknown" : questions >= 1 ? "needs-review" : "fail";
  return { ...base, observedModel: identity.observedModel ?? base.observedModel, excluded: identity.accepted ? null : `excluded from comparisons: ${identity.reason}`,
    requirements: per, strengths, checks, correctCompletion, permissionAdherence, askedAsExpected, questions,
    questionsAtLineEnd: facts ? facts.questionsAtLineEnd : null, toolErrors: facts ? facts.toolErrors : null, rewrites: facts ? facts.rewrites : null,
    totalTokens: facts ? facts.totalTokens : null, modelUsage: facts ? facts.modelUsage ?? null : null, elapsedMs: facts ? facts.elapsedMs : null,
    resultText: facts ? facts.resultText : null };
}

function collectRuns(runsDir, cases) {
  const out = [];
  for (const c of cases) {
    const caseDir = path.join(runsDir, c.id);
    if (!fs.existsSync(caseDir)) continue;
    for (const condition of fs.readdirSync(caseDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
      for (const repeat of fs.readdirSync(path.join(caseDir, condition), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
        const dir = path.join(caseDir, condition, repeat);
        const file = path.join(dir, "receipt.json");
        if (!fs.existsSync(file)) continue;
        const receipt = lib.readJson(file);
        out.push({ caseObj: c, dir, receipt: { ...receipt, condition: receipt.condition ?? condition, repeat: receipt.repeat ?? Number(repeat) } });
      }
    }
  }
  return out;
}

function resultsMarkdown(results) {
  const d = results.denominators;
  const lines = [`# Graded results`, ``, `Graded at ${results.gradedAt}. rubric.md sha256 \`${results.rubricSha256}\`; cases sha256 \`${results.casesSha256}\`.`, ``,
    `Denominators: ${d.receipts} receipt(s) found; ${d.complete} complete and graded; ${d.notRun} not run; ${d.error} error; ${d.timeout} timeout; ${d.excludedIdentity} complete but excluded from comparisons (model identity not accepted).`,
    `Unknown stays unknown: a manual check, a missing snapshot or a non-complete run never counts as pass or fail.`, ``,
    `| case | split | condition | repeat | status | requirements | correct completion | permission adherence | questions (expected) | repairs | total tokens | elapsed ms | observed model | excluded |`, `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`];
  for (const r of results.rows) {
    const req = Object.entries(r.requirements).map(([k, v]) => `${k}=${v}`).join(" ");
    lines.push(`| ${r.case} | ${r.split} | ${r.condition} | ${r.repeat} | ${r.status} | ${req} | ${r.correctCompletion} | ${r.permissionAdherence} | ${r.questions ?? "unknown"} (${r.expectedQuestions}) | ${r.repairs ?? "unknown"} | ${r.totalTokens ?? "unknown"} | ${r.elapsedMs ?? "unknown"} | ${r.observedModel ?? "unknown"} | ${r.excluded ?? ""} |`);
  }
  if (!results.rows.length) lines.push(`| (no receipts found) | | | | | | | | | | | | | |`);
  return lines.join("\n") + "\n";
}

function grade(options = parseArgs(process.argv.slice(2)), log = console.log) {
  const { validTaskRecord } = lib.requireOut("task-record");
  const cases = lib.loadCases(options.cases);
  const runs = collectRuns(options.runsDir, cases);
  const rows = runs.map(({ caseObj, dir, receipt }) => gradeRun(caseObj, validTaskRecord(caseObj.record), dir, receipt));
  const count = (s) => rows.filter(r => r.status === s).length;
  const results = { gradedAt: new Date().toISOString(), runsDir: options.runsDir, rubricSha256: lib.fileHash(path.join(lib.ROOT, "rubric.md")), casesSha256: lib.casesHash(options.cases),
    denominators: { receipts: rows.length, complete: count("complete"), notRun: count("not-run"), error: count("error"), timeout: count("timeout"), excludedIdentity: rows.filter(r => r.status === "complete" && r.excluded).length },
    rows };
  lib.saveJson(path.join(options.runsDir, "results.json"), results);
  fs.writeFileSync(path.join(options.runsDir, "results.md"), resultsMarkdown(results));
  log(`grade: ${rows.length} receipt(s) -> ${results.denominators.complete} graded, ${results.denominators.notRun} not run, ${results.denominators.error} error, ${results.denominators.timeout} timeout; wrote ${path.join(options.runsDir, "results.json")} and results.md`);
  return results;
}

if (require.main === module) grade();
module.exports = { grade, gradeRun, runCheck, collectRuns, resultsMarkdown, parseArgs };
