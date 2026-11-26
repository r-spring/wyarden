#!/usr/bin/env node
// Read-only summary of helper runs (4 November 2026 review, item 3.5). Reads every folder under --root (default: .entomatical/helpers of
// this repository): its refine-receipt.json or compile-receipt.json when present, else text.result.json and text.schema.json. Writes
// nothing, repairs nothing, loads no credentials. Older folders have no receipt; their kind comes from the schema and their input is
// reported as missing.
//
//   node tools/helper-receipts.js [--root <dir>] [--json]
"use strict";
const fs = require("fs");
const path = require("path");

const readJson = (file) => { try { return { value: JSON.parse(fs.readFileSync(file, "utf8")) }; } catch (e) { return fs.existsSync(file) ? { error: e.message } : {}; } };

/** The kind of call a schema belongs to. */
function kindOfSchema(schema) {
  const p = schema && schema.properties;
  if (!p) return "unknown";
  if (p.requirements && p.permissions) return "improve";
  if (p.kind && p.revision) return "refine";
  if (p.title) return "title";
  if (p.goalFound) return "completion-rule";
  if (p.haikuGoodEnough) return "rule-review";
  if (p.overview && p.attempts) return "review";
  return "unknown";
}
const sumTokens = (u) => {
  if (!u || typeof u !== "object") return null;
  const usage = u.usage && typeof u.usage === "object" ? u.usage : u; // Claude results wrap usage; Codex results are flat
  const n = (k) => (typeof usage[k] === "number" ? usage[k] : 0);
  const total = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens") + n("output_tokens");
  return total || null;
};

/** One folder's summary. Missing data is reported as missing, never guessed. A folder whose calls sit in subfolders (a completion
 *  rule's "rule/fable", a review's per-model folders) is summarised from its first subfolder that has a schema, and says so. */
function summarise(dir) {
  if (!fs.existsSync(path.join(dir, "text.schema.json"))) {
    const sub = fs.readdirSync(dir).map((d) => path.join(dir, d)).filter((d) => fs.statSync(d).isDirectory());
    // A Review prompt run: one folder per model (src/prompt-review.ts). Summarised from Astra's review, or marked unfinished without it.
    const names = sub.map((d) => path.basename(d));
    if (names.some((n) => ["terra", "sol", "astra"].includes(n))) {
      const astra = path.join(dir, "astra");
      const base = fs.existsSync(path.join(astra, "text.schema.json")) ? summarise(astra) : summarise(sub.find((d) => fs.existsSync(path.join(d, "text.schema.json"))) || sub[0]);
      const reviewed = fs.existsSync(path.join(astra, "text.result.json"));
      return { ...base, id: path.basename(dir), kind: "review", status: reviewed ? base.status : "no review (cancelled or interrupted)", nestedIn: names.join(", ") };
    }
    const nested = sub.flatMap((d) => [d, ...fs.readdirSync(d).map((e) => path.join(d, e))]).find((d) => fs.existsSync(path.join(d, "text.schema.json")));
    if (nested) return { ...summarise(nested), id: path.basename(dir), nestedIn: path.relative(dir, nested) };
  }
  const id = path.basename(dir);
  const receiptFile = ["refine-receipt.json", "compile-receipt.json"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  const receipt = receiptFile ? readJson(receiptFile) : {};
  const result = readJson(path.join(dir, "text.result.json"));
  const schema = readJson(path.join(dir, "text.schema.json"));
  const r = receipt.value || {}, res = result.value || {};
  const kind = r.kind || kindOfSchema(schema.value);
  const value = res.value || {};
  const problems = [receipt.error && `receipt unreadable: ${receipt.error}`, result.error && `result unreadable: ${result.error}`].filter(Boolean);
  const status = r.receiptStatus || (receiptFile ? (result.value ? "done (old receipt)" : "failed (old receipt)") : result.value ? "done (no receipt)" : "no result");
  return {
    id, kind, status,
    interrupted: r.receiptStatus === "pending" ? "pending receipt with no result: interrupted work, not re-run" : null,
    promptVersion: r.promptVersion || null,
    input: r.draft !== undefined ? { draftChars: r.draft.length, answersChars: (r.answers || "").length, contextChars: (r.context || "").length } : "missing",
    requested: r.requestedModel ? `${r.requestedModel}/${r.requestedEffort || "?"}` : null,
    observedModel: r.observedModel || res.model || null,
    outcome: r.outcome || (kind === "refine" ? value.kind : null) || null,
    outputChars: kind === "refine" && typeof value.revision === "string" ? value.revision.length : typeof r.renderedChars === "number" ? r.renderedChars : null,
    format: r.format || null,
    preservationOk: r.preservation ? r.preservation.ok : null,
    quarantined: Array.isArray(r.quarantined) ? r.quarantined.length : null,
    elapsedMs: typeof res.elapsedMs === "number" ? res.elapsedMs : typeof r.elapsedMs === "number" ? r.elapsedMs : null,
    operationMs: typeof r.durationMs === "number" ? r.durationMs : null,
    attempts: Array.isArray(r.attempts) ? r.attempts.map((a) => `${a.account}:${a.outcome}`).join(" ") : "missing",
    tokens: sumTokens(res.usage) ?? sumTokens(r.usage),
    problems,
  };
}

function main(argv) {
  const i = argv.indexOf("--root");
  const root = i >= 0 ? argv[i + 1] : path.join(__dirname, "..", ".entomatical", "helpers");
  if (!fs.existsSync(root)) { console.error(`No helper folder at ${root}.`); return 1; }
  const rows = fs.readdirSync(root).map((d) => path.join(root, d)).filter((d) => fs.statSync(d).isDirectory()).map(summarise)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  if (argv.includes("--json")) { console.log(JSON.stringify(rows, null, 2)); return 0; }
  const cell = (v) => (v === null || v === undefined ? "-" : typeof v === "object" ? JSON.stringify(v) : String(v));
  console.log("| id | kind | status | prompt | requested | observed | outcome | output chars | elapsed s | tokens | quarantined | input |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.id.slice(0, 8)} | ${r.kind} | ${r.status} | ${cell(r.promptVersion)} | ${cell(r.requested)} | ${cell(r.observedModel)} | ${cell(r.outcome)} | ${cell(r.outputChars)} | ${r.elapsedMs === null ? "-" : Math.round(r.elapsedMs / 1000)} | ${cell(r.tokens)} | ${cell(r.quarantined)} | ${r.input === "missing" ? "missing" : "stored"} |`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { summarise, kindOfSchema };
