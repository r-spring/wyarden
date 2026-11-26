// Validates every case file: record validity (out/task-record validTaskRecord, status ready), fixture paths, rubric
// shape (each requirement, prohibited item and confirm item has at least one check) and property coverage.
// Usage: node eval/compile-format/validate.js [cases dir]
"use strict";
const path = require("path");
const { CASES_DIR, PROPERTIES, CHECK_KINDS, loadCases, requireOut, safeRelative } = require("./lib");

function validateCase(c, validTaskRecord) {
  const errors = [];
  const expectId = path.basename(c.file, ".json");
  if (c.id !== expectId) errors.push(`id "${c.id}" does not match file name "${expectId}"`);
  if (!["development", "held-out"].includes(c.split)) errors.push(`split "${c.split}" is not development|held-out`);
  if (!Array.isArray(c.properties) || !c.properties.length) errors.push("properties is empty");
  else for (const p of c.properties) if (!PROPERTIES.includes(p)) errors.push(`unknown property "${p}"`);
  let record;
  try { record = validTaskRecord(c.record); if (record.status !== "ready") errors.push("record status is not ready"); }
  catch (e) { errors.push(`record invalid: ${e.message}`); }
  const files = c.fixture?.files;
  if (!files || typeof files !== "object" || !Object.keys(files).length) errors.push("fixture.files is empty");
  else for (const [p, content] of Object.entries(files)) {
    if (!safeRelative(p)) errors.push(`fixture path "${p}" is not a safe relative path`);
    if (typeof content !== "string") errors.push(`fixture "${p}" content is not a string`);
  }
  if (!Array.isArray(c.rubric) || !c.rubric.length) errors.push("rubric is empty");
  if (![0, "some"].includes(c.expectedQuestions)) errors.push(`expectedQuestions "${c.expectedQuestions}" is not 0|"some"`);
  if (record) {
    const mustAsk = record.unresolved.some(u => u.state === "must-ask");
    if (mustAsk !== (c.expectedQuestions === "some")) errors.push(`expectedQuestions "${c.expectedQuestions}" but the record ${mustAsk ? "has" : "has no"} must-ask item`);
    const targets = new Set([...record.requirements.map(r => r.id),
      ...record.permissions.prohibited.map((_, i) => `prohibited[${i}]`), ...record.permissions.confirm.map((_, i) => `confirm[${i}]`)]);
    const covered = new Set();
    for (const [i, entry] of (c.rubric || []).entries()) {
      const where = `rubric[${i}]`;
      if (!targets.has(entry.requirement)) errors.push(`${where} targets unknown "${entry.requirement}"`);
      const k = entry.check?.kind;
      if (!CHECK_KINDS.includes(k)) { errors.push(`${where} unknown check kind "${k}"`); continue; }
      if (k !== "manual" && !safeRelative(entry.check.path)) errors.push(`${where} needs a relative path`);
      if ((k === "file-contains" || k === "file-not-contains") && (typeof entry.check.text !== "string" || !entry.check.text.length)) errors.push(`${where} needs non-empty text`);
      if (k === "file-unchanged" && !(entry.check.path in (files || {}))) errors.push(`${where} file-unchanged path "${entry.check.path}" is not a fixture file`);
      if (k === "manual" && !entry.check.note) errors.push(`${where} manual check needs a note`);
      covered.add(entry.requirement);
    }
    for (const t of targets) if (!covered.has(t)) errors.push(`"${t}" has no rubric check`);
  }
  return errors;
}

function coverage(cases) {
  const table = {};
  for (const p of PROPERTIES) table[p] = { development: 0, "held-out": 0, total: 0 };
  for (const c of cases) for (const p of c.properties || []) if (table[p]) { table[p][c.split]++; table[p].total++; }
  const errors = [];
  for (const [p, n] of Object.entries(table)) {
    if (n.total < 3) errors.push(`property "${p}" is covered by ${n.total} cases (< 3)`);
    if (!n.development) errors.push(`property "${p}" has no development case`);
    if (!n["held-out"]) errors.push(`property "${p}" has no held-out case`);
  }
  return { table, errors };
}

function main(dir = process.argv[2] || CASES_DIR) {
  const { validTaskRecord } = requireOut("task-record");
  const cases = loadCases(dir);
  let failed = 0;
  for (const c of cases) {
    const errors = validateCase(c, validTaskRecord);
    const ids = new Set(cases.map(x => x.id));
    if (ids.size !== cases.length) errors.push("duplicate case id");
    console.log(`${errors.length ? "FAIL" : "ok  "} ${c.id} [${c.split}] ${c.properties.join(", ")}${errors.length ? "\n  - " + errors.join("\n  - ") : ""}`);
    failed += errors.length ? 1 : 0;
  }
  const splits = { development: cases.filter(c => c.split === "development").length, "held-out": cases.filter(c => c.split === "held-out").length };
  const cov = coverage(cases);
  console.log(`\ncases: ${cases.length} (development ${splits.development}, held-out ${splits["held-out"]})`);
  console.log("\n| property | development | held-out | total |\n|---|---|---|---|");
  for (const [p, n] of Object.entries(cov.table)) console.log(`| ${p} | ${n.development} | ${n["held-out"]} | ${n.total} |`);
  for (const e of cov.errors) console.log(`FAIL coverage: ${e}`);
  const expected = { total: 24, development: 16, "held-out": 8 };
  const sizeErrors = [];
  if (cases.length !== expected.total) sizeErrors.push(`expected ${expected.total} cases, found ${cases.length}`);
  for (const k of ["development", "held-out"]) if (splits[k] !== expected[k]) sizeErrors.push(`expected ${expected[k]} ${k} cases, found ${splits[k]}`);
  for (const e of sizeErrors) console.log(`FAIL size: ${e}`);
  const ok = !failed && !cov.errors.length && !sizeErrors.length;
  console.log(ok ? "\nvalidate: all cases valid" : `\nvalidate: ${failed} invalid case(s), ${cov.errors.length} coverage error(s), ${sizeErrors.length} size error(s)`);
  return ok;
}

if (require.main === module) process.exitCode = main() ? 0 : 1;
module.exports = { validateCase, coverage, main };
