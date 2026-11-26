#!/usr/bin/env node
// Phase 6 (docs/plans/MASTER-PLAN-capability-profiles-and-orchestration.md sections 11 and 12): read-only run export and baseline comparison.
// Writes nothing; the board's tasks.json, archives and evidence stay the single authorities, and everything printed here is derived.
//
//   node tools/run-export.js [--board <.entomatical folder>] <card id | archive key> [--text]   one run: identities, manifest, measures (JSON, or Markdown)
//   node tools/run-export.js [--board <.entomatical folder>] --compare [--json]                every run on the board and in its archive, grouped
//
// --compare groups runs as simple (one card, no children), delegated (a master with children: plan runs and legacy orchestrator runs) and
// governed (a root the user approved as governed, phase 3). It is observational: the user picks which work becomes which kind of run, so the
// groups are not a controlled experiment; sample sizes are printed beside every figure and a group with no runs says so instead of 0.
"use strict";
const fs = require("fs");
const path = require("path");

const out = (name) => {
  for (const p of [path.join(__dirname, name), path.join(__dirname, "..", "out", name)]) if (fs.existsSync(p)) return require(p);
  throw new Error(`${name} is missing (in the repo, run npm run build)`);
};
const R = out("run-record.js"), { archiveSet } = out("orchestrator.js");
const LEDGER = process.env.ENTOMATICAL_LEDGER_DIR || path.join(require("os").homedir(), ".entomatical", "ledger");

function args(argv) {
  const a = { board: path.join(process.cwd(), ".entomatical"), rest: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--board") a.board = path.resolve(argv[++i]);
    else if (argv[i].startsWith("--")) a[argv[i].slice(2)] = true;
    else a.rest.push(argv[i]);
  }
  return a;
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${file}`);
    throw new Error(`Cannot read ${file}: ${error.code}`);
  }
}

function optionalFiles(dir) {
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => path.join(dir, name));
}

const hasId = (value) => typeof value === "string" && value.trim().length > 0;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const string = (value) => typeof value === "string";
const bool = (value) => typeof value === "boolean";
const timestamp = (value) => string(value) && Number.isFinite(Date.parse(value));
const listOf = (value, check) => Array.isArray(value) && value.every(check);
const digest = (value) => string(value) && /^[0-9a-f]{64}$/.test(value);

// Optional fields used to select runs, determine roles and outcomes, or add up measurements.
// Older cards omit fields for features that did not exist when they were written.
const cardFields = {
  openedBy: hasId, governedBy: hasId, sessionId: hasId,
  ended: bool, discarded: bool, cancelled: bool,
  launchError: string, switchedTo: string, role: (v) => ["sub", "judge", "scribe", "research"].includes(v),
  checks: (v) => ["running", "complete", "error"].includes(v?.status) && string(v.run),
  doneReview: (v) => ["done", "not-done", "unsure"].includes(v?.verdict),
  governed: (v) => v?.v === 1 && v.revision === 1 && v.setBy === "user-selection" && record(v.profiles),
  delegation: (v) => listOf(v?.allowed, hasId) && count(v.depth),
  orchestrator: (v) => record(v?.caps) && count(v.opened),
  council: (v) => hasId(v?.root) && ["plan", "milestone", "final"].includes(v.checkpoint) && count(v.round) && hasId(v.member) && hasId(v.package),
  integrated: (v) => record(v) && ["into", "op", "branch", "before", "after", "head", "base", "by", "at"].every((key) => hasId(v[key])),
  submission: (v) => hasId(v?.head) && hasId(v.base) && listOf(v.files, string) && (v.covers === undefined || listOf(v.covers, hasId)),
  followUps: count, autoRounds: count, mergeRetries: count, transfers: Array.isArray,
  dependsOn: (v) => listOf(v, hasId),
};
function taskList(tasks, file) {
  if (!Array.isArray(tasks)) throw new Error(`Invalid task list in ${file}: expected an array of cards`);
  const ids = new Set();
  for (const [i, t] of tasks.entries()) {
    if (!hasId(t?.id) || ids.has(t.id)) throw new Error(`Invalid or duplicate task id at index ${i} in ${file}`);
    ids.add(t.id);
    if (!["queued", "running", "needs-input", "review", "done"].includes(t.status)) throw new Error(`Invalid task status for ${t.id} in ${file}`);
    for (const [field, check] of Object.entries(cardFields)) {
      if (t[field] !== undefined && !check(t[field])) throw new Error(`Invalid task field ${field} for ${t.id} in ${file}`);
    }
  }
  return tasks;
}

function tasksOf(board) {
  if (!fs.statSync(board, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Missing or invalid board directory: ${board}`);
  const file = path.join(board, "tasks.json"), ledger = readJson(file);
  const tasks = taskList(Array.isArray(ledger) ? ledger : ledger?.tasks, file);
  // A dangling or cyclic opener chain would drop every card in the chain from the comparison.
  const byId = new Map(tasks.map((t) => [t.id, t])), checked = new Set();
  for (const t of tasks) {
    const chain = new Set();
    for (let card = t; card.openedBy && !checked.has(card.id); card = byId.get(card.openedBy)) {
      if (chain.has(card.id) || !byId.has(card.openedBy)) throw new Error(`Invalid openedBy chain for ${card.id} in ${file}`);
      chain.add(card.id);
    }
    for (const id of chain) checked.add(id);
  }
  return tasks;
}

function readOperation(file, sourceName) {
  const op = readJson(file);
  if (![op?.id, op?.run, op?.card, op?.actor].every(hasId) || !["target", "integrate"].includes(op.kind) ||
      sourceName !== op.id + ".json" ||
      (op.kind === "target" && op.run !== op.card) || !["prepared", "effect-observed", "committed", "uncertain", "abandoned"].includes(op.state) ||
      !timestamp(op.at) || !timestamp(op.updated) || !record(op.pre) || !Object.values(op.pre).every((v) => string(v) || bool(v))) {
    throw new Error(`Invalid or unsupported operation in ${file}`);
  }
  const { owner, result, authorization, settled, cleanup } = op;
  if ((owner !== undefined && !hasId(owner)) || (result !== undefined && !record(result)) ||
      (result?.outcome !== undefined && (op.kind !== "integrate" || result.outcome !== "conflict")) ||
      (cleanup !== undefined && !["pending", "done"].includes(cleanup)) ||
      (settled !== undefined && (!["user", "reconcile"].includes(settled?.by) || !hasId(settled.at))) ||
      (authorization !== undefined && (authorization?.by !== "user" || !hasId(authorization.at) || authorization.merge !== true ||
        !bool(authorization.push) || (authorization.acks !== undefined && !listOf(authorization.acks, string))))) {
    throw new Error(`Invalid operation metadata in ${file}`);
  }
  return op;
}
const opsOf = (board) => optionalFiles(path.join(board, "operations")).map((file) => readOperation(file, path.basename(file)));

function validEvidence(e) {
  return ["events", "measurement", "council-package", "operation", "helper-receipt", "checks", "transcript"].includes(e?.kind) &&
    hasId(e.path) && (e.card === undefined || hasId(e.card)) && (e.gap === undefined || hasId(e.gap)) &&
    (e.size === undefined || count(e.size)) && (e.sha256 === undefined || digest(e.sha256)) &&
    (e.copy === undefined || (hasId(e.copy) && digest(e.sha256)));
}

function readArchive(file) {
  const name = /^([0-9a-f]{6})(?:-\d+)?\.json$/.exec(path.basename(file));
  if (!name) throw new Error(`Unsupported archive name: ${file}`);
  const rec = readJson(file);
  taskList(rec?.tasks, file);
  if (!rec.tasks.some((t) => t.id === rec.master)) throw new Error(`Invalid archive in ${file}: missing master card`);
  if (name[1] !== rec.master) throw new Error(`Archive filename ${file} does not match master ${rec.master}`);
  if (rec.v !== undefined && ![1, 2].includes(rec.v)) throw new Error(`Unsupported archive version in ${file}`);
  if (rec.v === 2 || rec.manifest !== undefined) {
    const m = rec.manifest;
    if (m?.v !== R.MANIFEST_VERSION || m.root !== rec.master || !hasId(m.at) || !listOf(m.cards, hasId) ||
        m.cards.length !== rec.tasks.length || !rec.tasks.every((t) => m.cards.includes(t.id)) ||
        (m.tasksSha256 !== undefined && !digest(m.tasksSha256)) || !listOf(m.gaps, hasId)) {
      throw new Error(`Invalid or unsupported archive manifest in ${file}`);
    }
    if (!listOf(m.evidence, validEvidence)) throw new Error(`Invalid or unsupported archive evidence in ${file}`);
    // readOperation binds each receipt's id to its original filename, even when the copy has a different name.
    const operationNames = new Set();
    for (const entry of m.evidence) {
      if (entry.kind !== "operation") continue;
      const sourceName = path.win32.basename(entry.path);
      if (operationNames.has(sourceName)) throw new Error(`Duplicate operation ${sourceName} in ${file}`);
      operationNames.add(sourceName);
    }
    const gaps = new Set(m.evidence.map((e) => e.gap));
    if (m.gaps.some((gap) => !gaps.has(gap))) throw new Error(`Unaccounted archive evidence gap in ${file}`);
  }
  return rec;
}

function exportArchive(board, file, rec) {
  const evidenceDir = file.slice(0, -5) + ".evidence";
  const ops = [];
  for (const e of rec.manifest?.evidence ?? []) {
    if (e.kind !== "operation" || e.gap) continue;
    const copy = R.verifiedCopy(evidenceDir, e);
    if (!copy) throw new Error(`Unreadable or unverified operation copy in ${file}: ${e.copy ?? e.path}`);
    const op = readOperation(copy, path.win32.basename(e.path)); // manifests may contain Windows or POSIX source paths
    if (e.card !== undefined && e.card !== op.card) throw new Error(`Invalid operation card in ${copy}`);
    ops.push(op);
  }
  return R.exportRun(board, rec, { evidenceDir, ops, harness: R.ledgerHarness(LEDGER) });
}

/** One run's export: a card on the board (its master's run, live evidence) or an archive key (retained copies). */
function exportOne(board, key, tasks = tasksOf(board), ops) {
  const card = tasks.find((t) => t.id === key);
  if (card) {
    let master = card;
    for (let i = 0; master.openedBy && i < 10; i++) master = tasks.find((t) => t.id === master.openedBy) ?? master;
    const { cards } = archiveSet(master, tasks), ids = new Set(cards.map((t) => t.id));
    return R.exportRun(board, { master: master.id, title: master.title, tasks: cards }, { ops: (ops ?? opsOf(board)).filter((o) => ids.has(o.run) || ids.has(o.card)), harness: R.ledgerHarness(LEDGER) });
  }
  const file = path.join(board, "archive", `${key}.json`);
  return exportArchive(board, file, readArchive(file));
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
/** The comparison over every master on the board (cards with no opener) and every archived run. */
function compare(board) {
  const tasks = tasksOf(board), ops = opsOf(board), runs = [];
  for (const m of tasks.filter((t) => !t.openedBy && !t.ended)) runs.push(exportOne(board, m.id, tasks, ops));
  // An archive whose master is still on the board was cut off before its save (or its restore before the move): counted once, as the live run.
  for (const file of optionalFiles(path.join(board, "archive"))) {
    const rec = readArchive(file);
    if (!tasks.some((t) => t.id === rec.master)) runs.push(exportArchive(board, file, rec));
  }
  const kind = (x) => x.run.governed ? "governed" : x.identities.length > 1 ? "delegated" : "simple";
  const groups = {};
  for (const g of ["simple", "delegated", "governed"]) {
    const rs = runs.filter((x) => kind(x) === g), m = rs.map((x) => x.measures);
    // Fully measured: every session of the run has a complete or partial reading (partial = a lower bound, flagged).
    const full = m.filter((x) => x.total.unknown.length === 0 && x.total.sessions > 0);
    const acc = m.filter((x) => x.outcomes.root === "accepted"), fullAcc = full.filter((x) => x.outcomes.root === "accepted");
    const sum = (xs) => xs.reduce((a, x) => a + (x.total.total ?? 0), 0);
    groups[g] = rs.length ? {
      runs: rs.length, cards: m.reduce((a, x) => a + x.cards.length, 0),
      rootOutcomes: Object.fromEntries(["accepted", "failed", "unverified", "open"].map((k) => [k, m.filter((x) => x.outcomes.root === k).length])),
      sessions: m.reduce((a, x) => a + x.total.sessions, 0), sessionsMeasured: m.reduce((a, x) => a + x.total.measured, 0), sessionsPartial: m.reduce((a, x) => a + x.total.partial, 0),
      sessionsUnknown: m.reduce((a, x) => a + x.total.unknown.length, 0), runsFullyMeasured: full.length, runsWithPartial: full.filter((x) => x.total.partial > 0).length,
      medianTokensPerRun: median(full.map((x) => x.total.total ?? 0)),
      // Cache reads dominate totals and are priced and counted differently by each provider (efficiency.ts "fresh"): shown apart.
      medianFreshTokensPerRun: median(full.map((x) => x.total.tokens ? x.total.tokens.input + x.total.tokens.cacheWrite + x.total.tokens.output : 0)), tokensPerAcceptedRun: fullAcc.length ? Math.round(sum(full) / fullAcc.length) : null,
      tokensPerAcceptedBasis: `${full.length} fully measured runs, ${fullAcc.length} of them accepted`,
      medianMinutesToAccepted: ((v) => (v === null ? null : v / 60000))(median(acc.map((x) => x.time.toAcceptedMs).filter((v) => typeof v === "number"))), acceptedWithTime: acc.filter((x) => typeof x.time.toAcceptedMs === "number").length,
      rework: { followUps: m.reduce((a, x) => a + x.rework.followUps, 0), autoRounds: m.reduce((a, x) => a + x.rework.autoRounds, 0), councilRounds: m.reduce((a, x) => a + x.rework.councilRounds, 0) },
      reassignments: m.reduce((a, x) => a + x.reassignments.transfers + x.reassignments.accountSwitches, 0),
      integrationFailures: m.reduce((a, x) => a + x.integration.conflicts + x.integration.uncertain, 0),
      evidenceGaps: m.reduce((a, x) => a + x.evidenceGaps.length, 0),
      requirements: { runsWithSpec: m.filter((x) => !("unknown" in x.requirements)).length, covered: m.reduce((a, x) => a + (x.requirements.covered?.length ?? 0), 0), total: m.reduce((a, x) => a + (x.requirements.total ?? 0), 0) },
      helperSessions: m.reduce((a, x) => a + x.roles.helper.sessions, 0),
    } : { runs: 0, note: "no runs of this kind on this board: every figure is unknown, not 0" };
  }
  return { v: 1, board, runs: runs.length, groups, caveat: "observational: groups are chosen by the user, not assigned; tokens exclude unknown sessions; usage-window points are not tokens" };
}

if (require.main === module) {
  const a = args(process.argv.slice(2));
  try {
    if (a.compare) {
      const c = compare(a.board);
      if (a.json) console.log(JSON.stringify(c, null, 2));
      else for (const [g, x] of Object.entries(c.groups)) console.log(`${g}: ${JSON.stringify(x)}`);
    } else {
      if (!a.rest[0]) throw new Error("usage: run-export.js [--board <dir>] <card id | archive key> [--text] | --compare [--json]");
      const x = exportOne(a.board, a.rest[0]);
      console.log(a.text ? [`# Run ${x.run.title} (${x.run.root})`, "", ...R.measuresText(x.measures)].join("\n") : JSON.stringify(x, null, 2));
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
module.exports = { exportOne, compare };
