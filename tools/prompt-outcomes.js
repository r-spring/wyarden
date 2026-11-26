#!/usr/bin/env node
// Read-only descriptive report: how tasks whose prompt was written raw, refined or improved went (4 November 2026 review, consensus
// item 37, implementation item 4.2). Joins .entomatical/provenance.jsonl (one line per task created or follow-up sent, written by the
// extension since 4 November 2026) with .entomatical/tasks.json and each card's token measurement, .entomatical/measurements/<id>.json.
// Writes nothing.
//
//   node tools/prompt-outcomes.js [--board <.entomatical folder>] [--json]
//
// The measures are proxies and say so: the card's column, whether its acceptance checks last passed, and its outcome (passed, failed
// or unverified, by outcomeOf in src/efficiency.ts, for matched cards that are Done). Tokens per passed task are all the tokens of the
// group's measured Done cards, failed and unverified ones included, divided by its passed cards ("-" with none passed). the user chooses
// which drafts to refine, so groups are not comparable as an experiment; the controlled comparison is eval/compile-format (item 4.3).
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const lines = (file) => { try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
// The board's own outcome rule (src/efficiency.ts), loaded as tools/ledger.js does: beside this file, or built in the repo.
const efficiencyModule = () => {
  for (const p of [path.join(__dirname, "efficiency.js"), path.join(__dirname, "..", "out", "efficiency.js")]) if (fs.existsSync(p)) return require(p);
  throw new Error("efficiency.js is missing beside prompt-outcomes.js (in the repo, run npm run build)");
};
/** A card's total tokens from measurements/<id>.json, or null when it is unmeasured (no file, unreadable, or source "unknown"). */
function tokensOf(board, id) {
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(board, "measurements", `${id}.json`), "utf8")); } catch { return null; }
  if (!m || m.source === "unknown" || !m.tokens) return null;
  const t = m.tokens, n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return typeof m.total === "number" ? m.total : n(t.input) + n(t.cacheRead) + n(t.cacheWrite) + n(t.output);
}

/** Reserve IDs first. A legacy match must be unique in both directions, independent of receipt order. */
function matchCreates(creates, tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const reserved = new Set(creates.filter((p) => p.task != null).map((p) => p.task));
  const claims = new Map();
  const matches = creates.map((p) => {
    let candidates;
    if (p.task != null) candidates = byId.has(p.task) ? [byId.get(p.task)] : [];
    else {
      const prefixMatches = Number.isSafeInteger(p.chars) && p.chars > 0
        ? tasks.filter((t) => typeof t.prompt === "string" && t.prompt.length >= p.chars && sha(t.prompt.slice(0, p.chars)) === p.promptSha256)
        : [];
      candidates = prefixMatches.filter((t) => !reserved.has(t.id));
      if (!candidates.length && prefixMatches.length) return { attribution: "legacy prefix matches reserved ID" };
    }
    // Even a receipt with multiple candidates competes for each of them.
    for (const t of candidates) claims.set(t.id, (claims.get(t.id) ?? 0) + 1);
    if (p.task != null) return { task: candidates[0], attribution: "card ID" };
    if (candidates.length === 1) return { task: candidates[0], attribution: "unique legacy prefix" };
    return { attribution: candidates.length ? "ambiguous legacy prefix" : "unmatched legacy prefix" };
  });
  return matches.map((m) => {
    if (!m.task || claims.get(m.task.id) === 1) return m;
    return { attribution: m.attribution === "card ID" ? "duplicate card ID" : "ambiguous legacy prefix" };
  });
}

function join(board) {
  const { outcomeOf } = efficiencyModule();
  const prov = lines(path.join(board, "provenance.jsonl"));
  let tasks = [];
  try { const t = JSON.parse(fs.readFileSync(path.join(board, "tasks.json"), "utf8")); tasks = Array.isArray(t) ? t : t.tasks || []; } catch { /* no board */ }
  const creates = prov.filter((p) => p.event === "create");
  const matches = matchCreates(creates, tasks);
  const rows = creates.map((p, i) => {
    const { task, attribution } = matches[i];
    const edited = p.helpers.some((h) => h.edited);
    const outcome = (task && outcomeOf(task)) || null;
    const missing = attribution === "card ID" || attribution === "unmatched legacy prefix";
    return { at: p.at, source: p.source, edited, recordedTask: p.task ?? null, attribution, task: task?.id ?? null,
      status: task?.status ?? (missing ? "not found" : `unknown (${attribution})`),
      checks: task ? task.checks?.status ?? "none" : "unknown", followUps: task ? prov.filter((f) => f.event === "follow-up" && f.task === task.id).length : null,
      outcome, tokens: outcome ? tokensOf(board, task.id) : null };
  });
  return { rows, provenanceLines: prov.length, tasks: tasks.length };
}

function summary(rows) {
  const groups = {};
  for (const r of rows) {
    const k = r.source === "improve" || r.source === "refine" ? r.source + (r.edited ? ", edited after" : ", applied as is") : r.source;
    const g = (groups[k] ||= { tasks: 0, matched: 0, status: {}, checks: {}, followUps: 0, passed: 0, failed: 0, unverified: 0, measured: 0, tokens: 0, perPassed: null });
    g.tasks++; if (r.task) g.matched++;
    g.status[r.status] = (g.status[r.status] || 0) + 1;
    g.checks[r.checks] = (g.checks[r.checks] || 0) + 1;
    if (r.task) g.followUps += r.followUps;
    if (r.outcome) g[r.outcome]++;
    if (r.outcome && typeof r.tokens === "number") { g.measured++; g.tokens += r.tokens; }
  }
  for (const g of Object.values(groups)) g.perPassed = g.passed && g.measured ? Math.round(g.tokens / g.passed) : null;
  return groups;
}

function main(argv) {
  const i = argv.indexOf("--board");
  const board = i >= 0 ? argv[i + 1] : path.join(__dirname, "..", ".entomatical");
  const { kilo } = efficiencyModule();
  const { rows, provenanceLines, tasks } = join(board);
  const groups = summary(rows);
  if (argv.includes("--json")) { console.log(JSON.stringify({ provenanceLines, tasks, groups, rows }, null, 2)); return 0; }
  console.log(`${provenanceLines} provenance lines (since 4 November 2026), ${tasks} tasks on the board.`);
  console.log("Proxies only: the card's column, its last acceptance-check run and its outcome. Groups are chosen by the user, not assigned.");
  console.log("| prompt source | tasks | matched to a card | columns | acceptance checks | follow-ups | passed | failed | unverified | tokens per passed task |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ");
  for (const [k, g] of Object.entries(groups)) console.log(`| ${k} | ${g.tasks} | ${g.matched} | ${fmt(g.status)} | ${fmt(g.checks)} | ${g.followUps} | ${g.passed} | ${g.failed} | ${g.unverified} | ${g.perPassed === null ? "-" : kilo(g.perPassed)} |`);
  if (!rows.length) console.log("| (no task created since provenance began) | 0 | 0 | | | | | | | |");
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { join, summary };
