// Report: aggregates results.json (from grade.js) into report.md in the same directory. Per-condition totals with
// development and held-out separated, a per-case per-requirement matrix, the close-comparison list, the runs that
// did not happen and why, and the statement that the recommendation is the user's judgement on acceptable cost.
// Usage: node eval/compile-format/report.js [--runs-dir <dir>]
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require("./lib");

function parseArgs(argv) {
  const o = { runsDir: lib.OUT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runs-dir") o.runsDir = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return o;
}

const n = (rows, f) => rows.filter(f).length;
const sumKnown = (rows, key) => { const known = rows.filter(r => typeof r[key] === "number"); return { sum: known.reduce((a, r) => a + r[key], 0), known: known.length }; };

function totalsTable(rows, conditions) {
  const lines = [`| condition | runs graded | excluded | correct completion pass / unknown / fail | permission adherence pass / unknown / fail | question candidates (runs known) | tool errors (runs known) | additional edits (runs known) | total tokens (runs known) | elapsed ms (runs known) |`,
    `|---|---|---|---|---|---|---|---|---|---|`];
  for (const c of conditions) {
    const all = rows.filter(r => r.condition === c && r.status === "complete");
    const g = all.filter(r => !r.excluded);
    const q = sumKnown(g, "questions"), te = sumKnown(g, "toolErrors"), rw = sumKnown(g, "rewrites"), tok = sumKnown(g, "totalTokens"), el = sumKnown(g, "elapsedMs");
    lines.push(`| ${c} | ${g.length} | ${all.length - g.length} | ${n(g, r => r.correctCompletion === "pass")} / ${n(g, r => r.correctCompletion === "unknown")} / ${n(g, r => r.correctCompletion === "fail")} | ${n(g, r => r.permissionAdherence === "pass")} / ${n(g, r => r.permissionAdherence === "unknown")} / ${n(g, r => r.permissionAdherence === "fail")} | ${q.sum} (${q.known}) | ${te.sum} (${te.known}) | ${rw.sum} (${rw.known}) | ${tok.sum} (${tok.known}) | ${el.sum} (${el.known}) |`);
  }
  return lines.join("\n");
}

/** Number of graded (mandatory/exclusion) requirements that passed in a row; null when nothing is known. */
function passedCount(row) {
  const ids = Object.keys(row.requirements).filter(t => /^R/.test(t) && (row.strengths?.[t] === "mandatory" || row.strengths?.[t] === "exclusion"));
  if (!ids.length) return null;
  return { passed: ids.filter(t => row.requirements[t] === "pass").length, unknown: ids.filter(t => row.requirements[t] === "unknown").length, of: ids.length };
}

function matrix(rows, cases, conditions) {
  const lines = [`| case | split | condition | repeat | per-requirement | correct completion | permission adherence | asked as expected | question candidates | tool errors | additional edits | tokens | elapsed ms |`, `|---|---|---|---|---|---|---|---|---|---|---|---|---|`];
  for (const c of cases) for (const cond of conditions) {
    const runs = rows.filter(r => r.case === c.id && r.condition === cond).sort((a, b) => a.repeat - b.repeat);
    if (!runs.length) { lines.push(`| ${c.id} | ${c.split} | ${cond} | - | (no receipt) | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown |`); continue; }
    for (const r of runs) {
      const req = Object.entries(r.requirements).map(([k, v]) => `${k}=${v}`).join(" ");
      lines.push(`| ${c.id} | ${c.split} | ${cond} | ${r.repeat} | ${r.status === "complete" ? req : `(${r.status})`} | ${r.correctCompletion} | ${r.permissionAdherence} | ${r.askedAsExpected ?? "unknown"} | ${r.questions ?? "unknown"} | ${r.toolErrors ?? "unknown"} | ${r.rewrites ?? "unknown"} | ${r.totalTokens ?? "unknown"} | ${r.elapsedMs ?? "unknown"} |`);
    }
  }
  return lines.join("\n");
}

/** Close comparisons (manifest repeat rule): per case, the top two formats' first-pass passed-requirement counts differ by at most 1. */
function closeComparisons(rows, cases, formats) {
  const out = [];
  for (const c of cases) {
    const scores = formats.map(f => { const r = rows.find(x => x.case === c.id && x.condition === f && x.repeat === 1 && x.status === "complete" && !x.excluded); return r ? { f, ...passedCount(r) } : null; }).filter(Boolean);
    if (scores.length < 2) continue;
    scores.sort((a, b) => b.passed - a.passed);
    if (scores[0].passed - scores[1].passed <= 1) out.push(`${c.id} (${c.split}): ${scores.map(s => `${s.f} ${s.passed}/${s.of}${s.unknown ? ` (+${s.unknown} unknown)` : ""}`).join(", ")}`);
  }
  return out;
}

function report(options = parseArgs(process.argv.slice(2)), log = console.log) {
  const resultsFile = path.join(options.runsDir, "results.json");
  if (!fs.existsSync(resultsFile)) throw new Error(`${resultsFile} is missing: run grade.js first`);
  const results = lib.readJson(resultsFile);
  const manifest = lib.loadManifest();
  const cases = lib.loadCases();
  const formats = manifest.formats, short = manifest.shortening.condition;
  const rows = results.rows;
  const complete = rows.filter(r => r.status === "complete");
  const notRun = rows.filter(r => r.status !== "complete");
  const L = [];
  L.push(`# Compile-format comparison report`, ``, `Generated ${new Date().toISOString()} from ${path.join(options.runsDir, "results.json")} (graded ${results.gradedAt}).`,
    `rubric.md sha256 \`${results.rubricSha256}\`; cases sha256 \`${results.casesSha256}\`.`, ``,
    `Conditions: formats ${formats.join(", ")} (identical semantic content, different serialization) and, separately, \`${short}\` (${manifest.shortening.kind}; never pooled with the formats).`,
    `Executor fixed at model ${manifest.executor.model}, effort ${manifest.executor.effort}, tools ${manifest.executor.tools.join("/")}, permission mode ${manifest.executor.permissionMode}.`, ``);
  L.push(`## Denominators`, ``, `${results.denominators.receipts} receipt(s): ${results.denominators.complete} complete and graded, ${results.denominators.notRun} not run, ${results.denominators.error} error, ${results.denominators.timeout} timeout, ${results.denominators.excludedIdentity} excluded (model identity not accepted).`, ``);
  if (!complete.length) {
    L.push(`## No completed runs`, ``, `No live runs were authorised in this session. No executor was started and no usage was spent. The runs below were planned and did not happen:`, ``);
    for (const r of notRun) L.push(`- ${r.case} / ${r.condition} / repeat ${r.repeat}: ${r.excluded ?? r.status}`);
    if (!notRun.length) L.push(`- (no planned receipts found either; run \`node eval/compile-format/run.js --dry-run\`)`);
    L.push(``);
  } else if (notRun.length) {
    L.push(`## Runs that did not happen`, ``);
    for (const r of notRun) L.push(`- ${r.case} / ${r.condition} / repeat ${r.repeat}: ${r.excluded ?? r.status}`);
    L.push(``);
  }
  for (const split of ["development", "held-out"]) {
    const sr = complete.filter(r => r.split === split);
    L.push(`## ${split === "development" ? "Development cases" : "Held-out cases (frozen; reported separately, never used for tuning)"}`, ``);
    L.push(`### Per-format totals (${split})`, ``, sr.length ? totalsTable(sr, formats) : `(no completed ${split} runs)`, ``);
    L.push(`### Shortening condition (${split}; information removal, compared only against \`xml\`)`, ``, sr.length ? totalsTable(sr, ["xml", short]) : `(no completed ${split} runs)`, ``);
    L.push(`### Per-case per-requirement matrix (${split})`, ``, matrix(rows.filter(r => r.split === split), cases.filter(c => c.split === split), [...formats, short]), ``);
    const close = closeComparisons(sr, cases.filter(c => c.split === split), formats);
    L.push(`### Close comparisons (${split}; ${manifest.repeats.closeRule}; ${manifest.repeats.label})`, ``, close.length ? close.map(s => `- ${s}`).join("\n") : `(none identified${sr.length ? "" : ": no completed runs"})`, ``);
  }
  L.push(`## Reading the numbers`, ``,
    `- "unknown" is never a pass: manual checks, missing snapshots and non-complete runs stay unknown and are counted in the denominators above.`,
    `- Tokens are the repo's unit (input + cacheRead + cacheWrite + output) from the CLI's own result record; prompt sizes in characters are in render-sizes.json and are not token counts.`,
    `- Repeats of close comparisons are a plan (manifest.repeats), not a claim about variance.`,
    `- The recommendation is the user's judgement on acceptable total cost: this report shows the measurements and does not choose a format on cost by itself.`, ``);
  const text = L.join("\n");
  fs.writeFileSync(path.join(options.runsDir, "report.md"), text);
  log(`report: wrote ${path.join(options.runsDir, "report.md")} (${complete.length} completed run(s), ${notRun.length} not run)`);
  return text;
}

if (require.main === module) { try { report(); } catch (e) { console.error(e.message); process.exitCode = 1; } }
module.exports = { report, totalsTable, matrix, closeComparisons, passedCount, parseArgs };
