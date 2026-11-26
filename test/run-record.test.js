// Phase 6 of docs/plans/MASTER-PLAN-capability-profiles-and-orchestration.md (sections 11, 12): evidence retention, run export and
// measurement. Acceptance AC-I (archive/restore and crash points reconcile without double effects), AC-J (tokens by role, unknown never
// zero, usage-window points are not tokens, evidence gaps explicit), AC-A2 (exported snapshots hold no credential material).
// Pure rules first (src/run-record.ts), then a real Board archiving, exporting and restoring a governed run built by hand.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync, spawnSync } = require("node:child_process");

class EventEmitter {
  listeners = [];
  event = (l) => (this.listeners.push(l), { dispose() {} });
  fire(e) { for (const l of this.listeners) l(e); }
  dispose() {}
}
const vscode = { EventEmitter, ThemeIcon: class {}, TabInputCustom: class { constructor(uri) { this.uri = uri; } }, ViewColumn: { Beside: -2 },
  commands: { executeCommand: async () => {} },
  Uri: { from: (parts) => ({ ...parts, toString: () => `${parts.scheme}://${parts.authority}${parts.path}` }), file: (p) => ({ fsPath: p }) },
  workspace: { openTextDocument: async (o) => ({ content: o?.content }), getConfiguration: () => ({ get: (_k, d) => d }) },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined, showInformationMessage: async () => undefined, showTextDocument: async () => undefined,
    createTerminal: () => { throw new Error("no session is started in these tests"); } } };
const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-runrec-home-"));
process.env.HOME = process.env.USERPROFILE = home;
process.env.ENTOMATICAL_USAGE_DIR = path.join(home, "usage");
process.env.ENTOMATICAL_LEDGER_DIR = path.join(home, "ledger");
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board } = require("../out/board.js");
const o = require("../out/orchestrator.js");
const R = require("../out/run-record.js");

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const made = [], boards = [];
test.after(() => { for (const b of boards) b.dispose(); for (const d of made) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
const SECRET = "sk-ant-abcdefghijklmnopqrstuvwxyz0123";

// ---- pure rules ----

test("redact: secret-named strings and secret-shaped values go; counts, ids, hashes and credential reference names stay (AC-A2)", () => {
  const r = R.redact({ apiKey: "plain", token: "abc", tokens: { input: 5, output: 1 }, prompt: `use ${SECRET} and ghp_${"a".repeat(30)} with Bearer abc.def.ghi123`,
    credentials: ["work-github"], hash: "a".repeat(64), nested: [{ Authorization: "x" }] });
  assert.deepEqual([r.apiKey, r.token, r.tokens, r.credentials, r.hash, r.nested[0].Authorization], [R.REDACTED, R.REDACTED, { input: 5, output: 1 }, ["work-github"], "a".repeat(64), R.REDACTED]);
  assert.equal(r.prompt, `use ${R.REDACTED} and ${R.REDACTED} with ${R.REDACTED}`);
  // Review fixes: Groq and xAI keys, URL user info, NAME=value of a secret-named variable, *_KEY field names; a bare member "key" stays.
  const more = R.redact({ text: `gsk_${"b".repeat(30)} xai-${"c".repeat(30)} https://bob:hunter2@example.com DEEPGRAM_API_KEY=abc123 sha ${"d".repeat(40)}`, OPENAI_KEY: "x", apiKey: "y", key: "a" });
  assert.equal(more.text, `${R.REDACTED} ${R.REDACTED} https://${R.REDACTED}@example.com DEEPGRAM_API_KEY=${R.REDACTED} sha ${"d".repeat(40)}`, "a 40-hex git sha is kept");
  assert.deepEqual([more.OPENAI_KEY, more.apiKey, more.key], [R.REDACTED, R.REDACTED, "a"]);
});

const card = (id, extra = {}) => ({ id, title: id, prompt: "p", status: "done", createdAt: "2026-11-16T00:00:00.000Z", updatedAt: "2026-11-16T00:00:00.000Z", ...extra });
const tok = (input, cacheRead, cacheWrite, output) => ({ input, cacheRead, cacheWrite, output });

test("v1 archive export keeps configured permission filters and reports managed judge policy separately", () => {
  const root = card("root");
  const judge = (id, provider, permission) => card(id, { openedBy: root.id, headless: true, role: "judge", provider, permission });
  const tasks = [root, judge("claude", undefined, "bypass"), judge("codex", "codex", "bypass"),
    judge("grok", "grok", "bypass"), judge("agy", "antigravity", "bypass"), judge("auto", "codex", "auto"),
    judge("unset", "codex"), judge("legacy", "codex", "obsolete"), judge("old-grok", "grok", "edits"), judge("old-agy", "antigravity", "edits"),
    card("scribe", { openedBy: root.id, role: "scribe", permission: "bypass" })];
  const before = JSON.stringify(tasks);
  const manifest = R.manifestOf(root, tasks, [], root.createdAt);
  const record = R.exportRun(home, { master: root.id, archivedAt: root.createdAt, tasks, manifest });
  assert.equal(record.v, 1);
  assert.equal(JSON.stringify(record.cards), before);
  assert.equal(JSON.stringify(tasks), before);
  assert.deepEqual(record.identities.filter(i => i.role === "judge" && i.execution.permission === "bypass").map(i => i.id), ["claude", "codex", "grok", "agy"]);
  const execution = id => record.identities.find(i => i.id === id).execution;
  assert.deepEqual(record.identities.map(i => i.execution.permission), tasks.map(t => t.permission ?? null));
  assert.equal(execution("claude").effectiveJudgePolicy.permission, "plan");
  for (const [id, approval] of [["codex", "never"], ["auto", "on-request"], ["unset", "never"]]) {
    const policy = execution(id).effectiveJudgePolicy;
    assert.equal(policy.permission, "read-only");
    assert.equal(policy.approvalPolicy, approval);
  }
  assert.equal(execution("legacy").effectiveJudgePolicy.permission, null);
  for (const id of ["old-grok", "old-agy"]) {
    const { permission, effectiveJudgePolicy } = execution(id);
    assert.deepEqual([permission, effectiveJudgePolicy.permission], ["edits", null]);
    assert.match(effectiveJudgePolicy.detail, /default provider mode/);
  }
  assert.match(execution("grok").effectiveJudgePolicy.detail, /refuses non-read ACP/);
  assert.equal(Object.hasOwn(execution("scribe"), "effectiveJudgePolicy"), false);
});

test("measureRun: tokens by role; unknown is listed with its reason, never 0; partial is a lower bound; points are a separate unit (AC-J)", () => {
  const root = card("r00t01", { sessionId: "s-root", orchestrator: { caps: {}, opened: 2 }, usageRuns: [{ startedAt: 1, start: { at: 1, fiveHour: 10 }, endedAt: 2, end: { at: 2, fiveHour: 14 } }] });
  const coord = card("c00rd1", { sessionId: "s-coord", openedBy: root.id, autoRounds: 1, mergeRetries: 2 });
  const work = card("w0rk01", { sessionId: "s-work", openedBy: coord.id, checks: { status: "complete", run: "x" } });
  const judge = card("judge1", { sessionId: "s-judge", openedBy: root.id, role: "judge" });
  const plan = card("plan01", { openedBy: root.id }); // never ran a session
  const snaps = { r00t01: { tokens: tok(10, 100, 5, 20), complete: true, source: "stream" }, w0rk01: { tokens: tok(1, 2, 3, 4), complete: false, source: "transcript", gaps: ["a subagent file is missing"] },
    judge1: { tokens: tok(0, 0, 0, 0), complete: false, source: "unknown", gaps: ["No captured usage stream exists for this session."] } };
  const helpers = [{ file: "/b/helpers/x/compile-receipt.json", card: root.id, kind: "improve", attempts: [
    { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 1 } },
    { usage: { input_tokens: 9506, cached_input_tokens: 7552, cache_write_input_tokens: 0, output_tokens: 20 } }, { usage: null }, { usage: { weird: 1 } }] }];
  const m = R.measureRun(root, [root, coord, work, judge, plan], { snapshot: (t) => snaps[t.id], ops: [], helpers, gaps: ["events missing at /x"] });
  assert.deepEqual(Object.fromEntries(R.ROLES.map((r) => [r, [m.roles[r].sessions, m.roles[r].measured, m.roles[r].partial, m.roles[r].unknown.length, m.roles[r].total]])),
    { root: [1, 1, 0, 0, 135], coordinator: [1, 0, 0, 1, null], worker: [1, 0, 1, 0, 10], council: [0, 0, 0, 0, null], judge: [1, 0, 0, 1, null], helper: [4, 2, 0, 2, 116 + 9526] });
  assert.equal(m.roles.coordinator.total, null, "a session with no reading is unknown, not 0 tokens");
  assert.equal(m.rework.autoRounds, 3, "the exported total includes review corrections and merge retries");
  assert.deepEqual(m.roles.coordinator.unknown, [{ card: coord.id, reason: "no measurement snapshot" }]);
  assert.deepEqual(m.roles.judge.unknown, [{ card: judge.id, reason: "No captured usage stream exists for this session." }]);
  assert.deepEqual(m.roles.helper.tokens, tok(10 + 1954, 100 + 7552, 1, 25), "Codex's input includes its cached input; Claude's does not");
  assert.deepEqual(m.roles.helper.unknown.map((u) => u.reason), ["usage not reported", "usage in an unknown shape"]);
  assert.deepEqual(m.roles.worker.noSession, [plan.id]);
  assert.deepEqual([m.roles.root.points, m.total.points], [{ "default account · 5-hour": 4 }, { "default account · 5-hour": 4 }], "usage-window points are kept apart from tokens, per account window");
  assert.deepEqual(m.total.pointsUnknown.sort(), [coord.id, judge.id, work.id].sort());
  assert.equal(m.total.total, 135 + 10 + 116 + 9526);
  assert.match(m.coverage.text, /^3 of 8 sessions measured completely, 1 partial, 4 unknown$/);
  assert.deepEqual(m.evidenceGaps, ["events missing at /x"]);
  assert.ok(m.unavailable.some((u) => u.startsWith(`tokens of ${coord.id}`)));
  // Outcomes: legacy cards use the board's existing outcome; turning Done alone is unverified; with no accepted root, time is unknown.
  assert.deepEqual(m.cards.map((c) => [c.id, c.outcome]), [[root.id, "unverified"], [coord.id, "unverified"], [work.id, "accepted"], [judge.id, "review"], [plan.id, "unverified"]], "a judge's card is a review, not unverified work");
  assert.match(m.time.unknown, /no accepted result/);
  assert.match(m.requirements.unknown, /no accepted specification/);
  const lines = R.measuresText(m).join("\n");
  assert.match(lines, /\| coordinator \| 1 \| 0 \| 0 \| 1 \| 0 \| unknown \|/);
  assert.match(lines, /\| worker \| 1 \| 0 \| 1 \| 0 \| 1 \| 10 \(lower bound\) \|/);
  assert.match(lines, /\| council \| 0 \| 0 \| 0 \| 0 \| 0 \| none \(no session\) \|/);
  // Coverage needs submissions: a specification with no submitted work is unknown, not "everything uncovered".
  const spec = { revisions: [{ ids: { requirements: ["R1"], acceptance: ["A1"] } }] };
  assert.match(R.measureRun({ ...root, spec }, [{ ...root, spec }, work], { snapshot: () => undefined, ops: [], helpers: [], gaps: [] }).requirements.unknown, /no card handed in a submission/);
  // A card whose runs have no usable reading is unknown for points, never silently absent.
  const open = card("open01", { sessionId: "s-open", usageRuns: [{ startedAt: 1 }] });
  assert.deepEqual(R.measureRun(open, [open], { snapshot: () => undefined, ops: [], helpers: [], gaps: [] }).total.pointsUnknown, [open.id]);
});

test("cardOutcome: a governed child is accepted only with an integration receipt, a governed root only with a committed target operation", () => {
  const ops = [{ id: "target-r-1", kind: "target", card: "r", run: "r", state: "committed" }];
  assert.equal(R.cardOutcome(card("c", { governedBy: "r", checks: { status: "complete" } }), ops).outcome, "unverified", "checks passing is not integration");
  assert.equal(R.cardOutcome(card("c", { governedBy: "r", integrated: { into: "r", op: "integrate-c" } }), ops).outcome, "accepted");
  assert.equal(R.cardOutcome(card("r", { governed: {} }), []).outcome, "unverified");
  assert.deepEqual(R.cardOutcome(card("r", { governed: {} }), ops), { outcome: "accepted", basis: "target operation target-r-1" });
  assert.equal(R.cardOutcome(card("x", { discarded: true, checks: { status: "complete" } }), []).outcome, "failed");
  assert.equal(R.cardOutcome(card("x", { status: "running" }), []).outcome, "open");
});

// ---- a real Board: archive, export, restore ----

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-runrec-"));
  made.push(repo);
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  boards.push(board);
  board.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }];
  board.tick();
  return { repo, board };
}
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data)); };

/** A finished governed run as phases 1 to 5 leave it: spec, pinned profile, council round with a package, a member, an integrated child, operations. */
function governedRun(board, repo) {
  const head = sh(repo, "rev-parse", "HEAD");
  const profile = { mode: "strict", snapshot: { id: "workspace:prof-1", revision: 2, hash: "f".repeat(64), name: "Worker", variants: { claude: { items: [], credentials: ["work-github"] } } }, pinnedAt: "2026-11-16T00:00:00.000Z" };
  const m = board.add("Governed run", `Do it. Key ${SECRET}`, "acct", undefined, "haiku", "low", undefined, { orchestrator: { caps: { ...o.DEFAULT_CAPS }, opened: 2 } });
  const pkgFile = path.join(board.dir, "council", m.id, `${"9".repeat(64)}.json`);
  write(pkgFile, { v: 1, id: "9".repeat(64), candidate: { commit: head } });
  write(path.join(board.dir, "helpers", "h1", "compile-receipt.json"), { kind: "improve", input: `draft with ${SECRET}`, attempts: [{ provider: "claude", usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }] });
  const spec = { version: 1, specId: "spec-1", execution: { account: "acct", model: "haiku", effort: "low", permission: "", source: "user-selection", capabilities: "workspace:prof-1@2" },
    revisions: [{ revision: 1, kind: "create", at: "2026-11-16T00:00:00.000Z", draft: "d", answers: "", inputSha256: "1".repeat(64), record: { outcome: { goal: "g", deliverable: "d" }, requirements: [{ id: "R1", text: "one", provenance: "user" }, { id: "R2", text: "two", provenance: "user" }],
      success: { criteria: [{ id: "A1", text: "a" }] }, permissions: { prohibited: [] }, unresolved: [] }, ids: { requirements: ["R1", "R2"], acceptance: ["A1"] }, superseded: [],
      promptVersion: "pv", rendererVersion: "rv", format: "prose", text: "t", outputSha256: "2".repeat(64), improvedBy: "haiku", receipt: path.join("helpers", "h1", "compile-receipt.json") }],
    launches: [{ at: "2026-11-16T00:00:01.000Z", kind: "launch", revision: 1, replay: "exact", promptSha256: "3".repeat(64), drift: [] }] };
  const governed = { v: 1, revision: 1, at: "2026-11-16T00:00:00.000Z", setBy: "user-selection", limits: { active: 3, directChildren: 2, depth: 1 }, profiles: { "workspace:prof-1@2": profile },
    delegation: { allowed: ["workspace:prof-1@2"], depth: 1 }, leases: [], seq: 4, target: { ref: "main", sha: head },
    council: { snapshot: { id: "workspace:council-1", revision: 1, hash: "c".repeat(64), name: "C", members: [], rubric: { criteria: [], severities: [] }, checkpoints: ["final"], passing: { unavailable: "block" }, limits: { rounds: 2, attempts: 1, minutes: 30 }, equivalence: "none", profiles: {}, pinnedAt: "x" },
      rounds: [{ n: 1, checkpoint: "final", package: "9".repeat(64), file: pkgFile, at: "x", deadline: "y", dispositions: [], outcome: { state: "passed", reasons: [], dissent: [], at: "z" },
        members: [{ key: "a", account: "acct", provider: "claude", model: "haiku", effort: "low", state: "returned", attempts: 1 }, { key: "b", account: "gone", model: "sol", effort: "high", state: "unavailable", reason: "account gone is not signed in", attempts: 0 }] }] } };
  board.update(m, { status: "done", sessionId: "11111111-1111-4111-8111-111111111111", spec, profile, governed, statusAt: "2026-11-16T01:00:00.000Z" });
  const w = board.add("Worker", "Work.", "acct", undefined, "haiku", "low", undefined, {});
  board.update(w, { status: "done", openedBy: m.id, governedBy: m.id, sessionId: "22222222-2222-4222-8222-222222222222", profile, assignment: { key: "k1", outcome: "o", acceptance: ["A1"] },
    submission: { head, base: head, summary: "s", files: ["a.txt"], checks: "complete", covers: ["R1", "A1"], at: "x" }, integrated: { into: m.id, branch: "task/x", before: head, after: head, head, base: head, op: "integrate-w-1", by: m.id, at: "x" },
    transcript: path.join(home, "gone", "transcript.jsonl") });
  const j = board.add("Member a", "Review.", "acct", undefined, "haiku", "low", undefined, {});
  board.update(j, { status: "done", openedBy: m.id, governedBy: m.id, role: "research", council: { root: m.id, checkpoint: "final", round: 1, member: "a", package: "9".repeat(64) }, sessionId: "33333333-3333-4333-8333-333333333333" });
  for (const t of [m, w, j]) write(board.eventsFile(t.id), JSON.stringify({ t: 1, hook_event_name: "SessionStart", session_id: t.sessionId }) + "\n");
  write(path.join(board.dir, "measurements", `${m.id}.json`), { version: 1, taskId: m.id, tokens: tok(100, 1000, 50, 200), total: 1350, complete: true, source: "stream", models: {}, gaps: [] });
  write(path.join(board.dir, "measurements", `${w.id}.json`), { version: 1, taskId: w.id, tokens: tok(10, 20, 0, 5), complete: false, source: "transcript", models: {}, gaps: ["partial"] });
  // The council member has a session but no snapshot: unknown.
  const op = board.operations.open({ kind: "integrate", card: w.id, run: m.id, actor: m.id, pre: { head } }); board.operations.set(op, { state: "committed", result: { after: head } });
  const target = board.operations.open({ kind: "target", card: m.id, run: m.id, actor: "user", authorization: { by: "user", at: "x", merge: true, push: false }, pre: { candidate: head } });
  board.operations.set(target, { state: "committed", result: { after: head } });
  write(path.join(home, "ledger", "sessions.json"), { [m.sessionId]: { version: "2.1.312", entrypoint: "sdk-cli" } });
  return { m, w, j, pkgFile, head, target };
}

test("AC-I/AC-J: Archive run keeps a manifest and hashed copies of the run's evidence; Export reconstructs exact identities, no secrets; Restore verifies and puts packages back", async () => {
  const { repo, board } = fixture();
  const { m, w, j, pkgFile, head, target } = governedRun(board, repo);
  const before = JSON.parse(JSON.stringify([m, w, j].map((t) => board.get(t.id))));
  const live = board.exportRun(m.id);
  assert.equal(live.run.archivedAt, null);
  const r = await board.archiveRun(board.get(m.id));
  const rec = JSON.parse(fs.readFileSync(r.file, "utf8"));
  assert.equal(rec.v, 2);
  const kinds = rec.manifest.evidence.filter((e) => e.copy).map((e) => `${e.kind}:${e.card}`).sort();
  assert.deepEqual(kinds, [`council-package:${m.id}`, `events:${j.id}`, `events:${m.id}`, `events:${w.id}`, `helper-receipt:${m.id}`, `measurement:${m.id}`, `measurement:${w.id}`, `operation:${m.id}`, `operation:${w.id}`].sort());
  assert.deepEqual(rec.manifest.gaps.sort(), [`measurement missing at ${path.join(board.dir, "measurements", `${j.id}.json`)}`, `transcript missing at ${path.join(home, "gone", "transcript.jsonl")}`].sort(), "missing evidence is an explicit gap");
  // Export: exact identities from the archive.
  const x = board.exportRun(m.id);
  const id = (cid) => x.identities.find((i) => i.id === cid);
  assert.deepEqual([x.run.legacy, x.run.governed, id(m.id).role, id(w.id).role, id(j.id).role], [false, true, "root", "worker", "council"]);
  assert.deepEqual(id(m.id).spec, { specId: "spec-1", version: 1, revision: 1, inputSha256: "1".repeat(64), outputSha256: "2".repeat(64), promptVersion: "pv", rendererVersion: "rv",
    requirements: ["R1", "R2"], acceptance: ["A1"], capabilities: "workspace:prof-1@2", launches: [{ at: "2026-11-16T00:00:01.000Z", kind: "launch", revision: 1, replay: "exact", promptSha256: "3".repeat(64), drift: [] }] });
  assert.deepEqual(id(m.id).profile, { mode: "strict", ref: "workspace:prof-1@2", hash: "f".repeat(64), pinnedAt: "2026-11-16T00:00:00.000Z" });
  assert.deepEqual(id(m.id).harness, { provider: "claude", session: m.sessionId, cli: "2.1.312", entrypoint: "sdk-cli" });
  assert.equal(id(w.id).harness.unknown, "session not in the ledger catalog", "a harness the board cannot name is unknown, not guessed");
  assert.deepEqual(id(m.id).governance.council.rounds[0].members.map((x) => [x.key, x.state]), [["a", "returned"], ["b", "unavailable"]]);
  assert.deepEqual([id(m.id).governance.council.hash, id(m.id).governance.council.rounds[0].package, id(m.id).governance.target], ["c".repeat(64), "9".repeat(64), { ref: "main", sha: head }]);
  assert.deepEqual(id(w.id).source.submission, { head, base: head, files: ["a.txt"], covers: ["R1", "A1"] });
  assert.ok(x.operations.some((op) => op.id === target.id && op.state === "committed"));
  // Measurements from the retained copies: accepted root (target op), worker accepted (integrated), council member unknown, coverage.
  assert.deepEqual([x.measures.outcomes.root, x.measures.outcomes.accepted], ["accepted", 2]);
  assert.deepEqual(x.measures.requirements, { total: 3, covered: ["R1", "A1"], claimedNotAccepted: [], uncovered: ["R2"] });
  assert.deepEqual([x.measures.roles.root.total, x.measures.roles.worker.total, x.measures.roles.council.total, x.measures.roles.helper.total], [1350, 35, null, 10]);
  assert.ok(x.measures.unavailable.includes("council final round 1 member b: account gone is not signed in"));
  assert.equal(typeof x.measures.time.toAcceptedMs, "number");
  const text = JSON.stringify(x);
  assert.ok(!text.includes(SECRET), "no secret in the export (prompt, receipts)");
  assert.ok(text.includes("work-github"), "credential reference names are kept; they are not secrets");
  // Restore: the package that went missing comes back from its verified copy; the cards equal what was archived, now Done.
  fs.rmSync(pkgFile);
  const back = board.restoreRun(m.id);
  assert.deepEqual([back.count, back.reconciled], [3, undefined]);
  assert.deepEqual(back.gaps.sort(), rec.manifest.gaps.sort(), "the gaps recorded at archive time are reported; no copy is altered");
  assert.equal(fs.existsSync(pkgFile), true);
  // updatedAt is the restore's own time; governed.seq counts the run's material events, and the restore is one.
  const strip = (t) => ({ ...t, updatedAt: undefined, governed: t.governed && { ...t.governed, seq: undefined } });
  assert.deepEqual([m, w, j].map((t) => strip(board.get(t.id))), before.map(strip), "archive and restore keep every pinned snapshot and identity");
  const reload = new Board(repo, path.join(repo, "hook.js"), undefined, false); boards.push(reload);
  assert.deepEqual(strip(reload.get(m.id)), strip(board.get(m.id)), "and they read back after a reload");
  const restored = fs.readdirSync(path.join(board.archiveDir, "restored"));
  assert.equal(restored.filter((f) => f.endsWith(".evidence")).length, 1, "the evidence folder moves with its archive file");
});

test("AC-I: an altered or deleted copy is a gap at restore and export; a legacy archive exports as legacy with its evidence not inventoried", async () => {
  const { repo, board } = fixture();
  const { m } = governedRun(board, repo);
  // Review fix: two helper receipts of one card share a file name; both copies are kept and verify.
  const spec = board.get(m.id).spec;
  write(path.join(board.dir, "helpers", "h2", "compile-receipt.json"), { kind: "improve", attempts: [] });
  board.update(board.get(m.id), { spec: { ...spec, revisions: [...spec.revisions, { ...spec.revisions[0], revision: 2, kind: "follow-up", receipt: path.join("helpers", "h2", "compile-receipt.json") }] } });
  const r = await board.archiveRun(board.get(m.id));
  assert.equal(JSON.parse(fs.readFileSync(r.file, "utf8")).manifest.evidence.filter((e) => e.kind === "helper-receipt" && e.copy).length, 2);
  assert.deepEqual(R.verifyEvidence(r.file.slice(0, -5) + ".evidence", JSON.parse(fs.readFileSync(r.file, "utf8")).manifest.evidence).filter((g) => /helper/.test(g)), []);
  const rec = JSON.parse(fs.readFileSync(r.file, "utf8")), evidenceDir = r.file.slice(0, -5) + ".evidence";
  const ev = rec.manifest.evidence.find((e) => e.kind === "measurement" && e.copy), op = rec.manifest.evidence.find((e) => e.kind === "operation" && e.copy);
  fs.appendFileSync(path.join(evidenceDir, ev.copy), " ");
  fs.rmSync(path.join(evidenceDir, op.copy));
  const x = board.exportRun(m.id);
  assert.ok(x.measures.evidenceGaps.includes(`measurement copy altered: ${path.join(evidenceDir, ev.copy)}`));
  assert.ok(x.measures.evidenceGaps.includes(`operation copy missing: ${path.join(evidenceDir, op.copy)}`));
  // An edited manifest cannot make Restore write outside the board's council folder, nor Export read a file that is not a retained copy.
  const outside = path.join(home, "planted.json");
  const intact = rec.manifest.evidence.find((e) => e.kind === "events" && e.copy);
  rec.manifest.evidence.push({ kind: "council-package", card: m.id, path: outside, copy: intact.copy, sha256: intact.sha256 }, { kind: "operation", card: m.id, path: path.join(home, "secret-op.json") });
  write(path.join(home, "secret-op.json"), { id: "planted", kind: "target", card: m.id, state: "committed" });
  const evil = path.join(board.dir, "council", m.id, "evil.json"); // inside the council folder, but its "copy" climbs out of the evidence folder
  rec.manifest.evidence.push({ kind: "council-package", card: m.id, path: evil, copy: path.relative(evidenceDir, path.join(home, "secret-op.json")), sha256: "0".repeat(64) });
  rec.tasks[1].title = "edited after archiving"; // review fix: the card records are hashed in the manifest too
  fs.writeFileSync(r.file, JSON.stringify(rec));
  assert.ok(!board.exportRun(m.id).operations.some((x) => x.id === "planted"), "only retained copies are read from an archive");
  assert.ok(board.exportRun(m.id, "archive").measures.evidenceGaps.includes("the card records were edited after archiving (their hash differs from the manifest)"));
  const back = board.restoreRun(m.id);
  assert.ok(back.gaps.some((g) => g.startsWith("measurement copy altered")) && back.gaps.some((g) => g.startsWith("operation copy missing")));
  assert.ok(back.gaps.includes("the card records were edited after archiving (their hash differs from the manifest)"));
  assert.equal(fs.existsSync(outside), false, "nothing is written outside .entomatical/council");
  assert.equal(fs.existsSync(evil), false, "a copy outside the evidence folder, or one whose hash differs, is never put back");
  assert.ok(back.gaps.includes(`council package ${outside} is outside this board; not restored`));
  // A v1 archive (before phase 6): read and exported as legacy; nothing is invented for it.
  const old = { v: 1, master: "abcdef", title: "Old run", archivedAt: "2026-10-01T00:00:00.000Z", plan: "", finalReply: null, summary: null,
    tasks: [card("abcdef", { orchestrator: { caps: {}, opened: 1 }, sessionId: "44444444-4444-4444-8444-444444444444" }), card("fedcba", { openedBy: "abcdef" })] };
  write(path.join(board.archiveDir, "abcdef.json"), old);
  const lx = board.exportRun("abcdef");
  assert.equal(lx.run.legacy, true);
  assert.match(lx.measures.evidenceGaps[0], /archived before phase 6 \(legacy\)/);
  assert.deepEqual([lx.measures.roles.root.total, lx.measures.roles.root.unknown[0].reason], [null, "no measurement snapshot"]);
  assert.deepEqual(board.restoreRun("abcdef").gaps, ["archived before phase 6 (legacy): no evidence was retained with it"]);
});

test("Delete keeps the checks an archive manifest names (moved into its evidence folder, hashed); a card no archive names loses checks/ and reviews/", async () => {
  const { repo, board } = fixture();
  const { m, w } = governedRun(board, repo);
  const run = path.join(board.dir, "checks", w.id, "1");
  write(path.join(run, "job.json"), { commands: ["npm test"] }); write(path.join(run, "out", "log.txt"), "ok\n");
  board.update(board.get(w.id), { checks: { status: "complete", run } });
  write(path.join(board.dir, "reviews", w.id, "r.md"), "# review\n");
  await board.archiveRun(board.get(m.id));
  board.restoreRun(m.id); // the archive moves to archive/restored/ and the cards are live again
  const restored = path.join(board.archiveDir, "restored"), file = path.join(restored, fs.readdirSync(restored).find((f) => f.endsWith(".json")));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).manifest.evidence.find((e) => e.kind === "checks").copy, undefined, "checks are referenced, not copied, at archive time");
  board.remove(board.get(w.id));
  assert.deepEqual([fs.existsSync(path.join(board.dir, "checks", w.id)), fs.existsSync(path.join(board.dir, "reviews", w.id))], [false, false]);
  const ev = JSON.parse(fs.readFileSync(file, "utf8")).manifest.evidence.find((e) => e.kind === "checks"), evidenceDir = file.slice(0, -5) + ".evidence";
  assert.ok(ev.copy && /^[0-9a-f]{64}$/.test(ev.sha256), "the manifest records the copy and its hash");
  assert.equal(fs.readFileSync(path.join(evidenceDir, ev.copy, "out", "log.txt"), "utf8"), "ok\n");
  assert.deepEqual(R.verifyEvidence(evidenceDir, [ev]), [], "the folder copy verifies");
  fs.appendFileSync(path.join(evidenceDir, ev.copy, "out", "log.txt"), "x");
  assert.deepEqual(R.verifyEvidence(evidenceDir, [ev]), [`checks copy altered: ${path.join(evidenceDir, ev.copy)}`], "an altered file in the copied folder is a gap");
  // A card no archive names: both folders are deleted and no archive file changes.
  const x = board.add("Loose", "Do it.", "acct", undefined, "haiku", "low", undefined, {});
  write(path.join(board.dir, "checks", x.id, "1", "job.json"), {}); write(path.join(board.dir, "reviews", x.id, "r.md"), "r");
  board.update(x, { checks: { status: "complete", run: path.join(board.dir, "checks", x.id, "1") } });
  const before = fs.readFileSync(file, "utf8");
  board.remove(x);
  assert.deepEqual([fs.existsSync(path.join(board.dir, "checks", x.id)), fs.existsSync(path.join(board.dir, "reviews", x.id))], [false, false]);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("AC-I crash points: an archive cut off before its save and a restore cut off before its move reconcile; nothing is listed or restored twice", async () => {
  const { repo, board } = fixture();
  const { m } = governedRun(board, repo);
  // 1. Archive writes its file, then the board stops before tasks.json is saved: a fresh Board still has the cards and sees the file.
  const save = board.save;
  board.save = () => { throw new Error("crash"); };
  await assert.rejects(board.archiveRun(board.get(m.id)), /crash/);
  board.save = save;
  const b2 = new Board(repo, path.join(repo, "hook.js"), undefined, false); boards.push(b2); board.dispose();
  b2.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }]; b2.tick();
  assert.equal(b2.get(m.id)?.status, "done");
  assert.deepEqual(b2.archivedRuns().map((x) => x.key), [m.id]);
  // Restore of that file restores nothing (every card is there): it is set aside, with its evidence.
  const rec1 = b2.restoreRun(m.id);
  assert.deepEqual([rec1.count, rec1.reconciled, b2.archivedRuns().length, b2.tasks.filter((t) => t.id === m.id).length], [0, true, 0, 1]);
  // Archive again: one file under the plain name.
  const r = await b2.archiveRun(b2.get(m.id));
  assert.equal(path.basename(r.file), `${m.id}.json`);
  // 2. Restore saves tasks.json, then the board stops before the file moves: the file is put back to simulate it.
  b2.restoreRun(m.id);
  const moved = fs.readdirSync(path.join(b2.archiveDir, "restored")).filter((f) => f.endsWith(".json")).sort().at(-1);
  fs.copyFileSync(path.join(b2.archiveDir, "restored", moved), r.file);
  const again = b2.restoreRun(m.id);
  assert.deepEqual([again.count, again.reconciled, b2.tasks.filter((t) => t.id === m.id).length], [0, true, 1]);
  // 3. The same left-over file found by Archive run: set aside as a duplicate, the new archive takes the plain name.
  fs.copyFileSync(path.join(b2.archiveDir, "restored", moved), r.file);
  const r3 = await b2.archiveRun(b2.get(m.id));
  assert.equal(path.basename(r3.file), `${m.id}.json`);
  assert.ok(fs.readdirSync(path.join(b2.archiveDir, "restored")).some((f) => f.startsWith(`${m.id}-dup-`)));
  assert.deepEqual(b2.archivedRuns().map((x) => x.key), [m.id]);
});

function compareCli(dir) {
  const result = spawnSync(process.execPath, [require.resolve("../tools/run-export.js"), "--board", dir, "--compare", "--json"], { encoding: "utf8" });
  assert.ifError(result.error);
  return result;
}

function comparison(dir) {
  const result = compareCli(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

function rejectedComparison(dir, file, reason) {
  const result = compareCli(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.includes(file), result.stderr);
  assert.match(result.stderr, reason);
}

test("comparison CLI requires readable board inputs and identifies each rejected source", () => {
  const dir = path.join(home, "invalid-board"), ledger = path.join(dir, "tasks.json");
  const rejects = (file, reason) => rejectedComparison(dir, file, reason);
  rejects(dir, /board directory/i);
  fs.mkdirSync(dir);
  rejects(ledger, /ENOENT/);
  write(ledger, "[");
  rejects(ledger, /invalid JSON/i);
  if (process.platform !== "win32" && process.getuid() !== 0) {
    fs.chmodSync(ledger, 0);
    try { rejects(ledger, /EACCES/); } finally { fs.chmodSync(ledger, 0o600); }
  }
  for (const data of [{}, { tasks: null }, [null], { tasks: [{}] }]) {
    write(ledger, data);
    rejects(ledger, /task/i);
  }
  write(ledger, [card("abcdef")]);
  const duplicate = path.join(dir, "archive", "abcdef.json");
  write(duplicate, { v: 1, master: "abcdef", tasks: [card("abcdef")] });
  assert.equal(comparison(dir).runs, 1);
  write(duplicate, { v: 3, master: "abcdef", tasks: [card("abcdef")] });
  rejects(duplicate, /unsupported archive version/i);
  const renamed = path.join(dir, "archive", "unknown.json");
  fs.renameSync(duplicate, renamed);
  rejects(renamed, /unsupported archive name/i);
  fs.rmSync(path.dirname(duplicate), { recursive: true });
  for (const [folder, name, invalid] of [
    ["archive", "abcdef.json", { master: "abcdef", tasks: [] }], // validate even when the live master shadows this record
    ["operations", "op.json", { id: "op", run: "abcdef", card: "abcdef", kind: "other", state: "committed" }],
  ]) {
    const source = path.join(dir, folder), file = path.join(source, name);
    write(source, "not a directory");
    rejects(source, /ENOTDIR/);
    fs.unlinkSync(source);
    write(file, "{");
    rejects(file, /invalid JSON/i);
    write(file, invalid);
    rejects(file, /invalid|unsupported/i);
    fs.unlinkSync(file);
    fs.mkdirSync(file); // unreadable as a file, including for privileged test users
    rejects(file, /EISDIR|EPERM|EACCES/);
    fs.rmSync(source, { recursive: true });
  }
});

for (const patch of [{ ended: "false" }, { status: "broken" }, { openedBy: 3 }, { checks: { status: "broken" } },
  { discarded: "false" }, { integrated: {} }, { role: "other" }, { followUps: "2" }]) {
  const field = Object.keys(patch)[0];
  test(`comparison CLI rejects an invalid card ${field} in a mixed ledger`, () => {
    const dir = path.join(home, "mixed-" + field), file = path.join(dir, "tasks.json");
    write(file, [card("123456"), card("abcdef", patch)]);
    rejectedComparison(dir, file, new RegExp(field));
  });
}

test("comparison CLI validates every manifest evidence kind and accepts the original manifest without a task hash", () => {
  const dir = path.join(home, "manifest-kinds"), root = card("abcdef"), file = path.join(dir, "archive", "abcdef.json");
  write(path.join(dir, "tasks.json"), [card("123456")]);
  const manifest = R.manifestOf(root, [root], [{ kind: "transcript", path: "old transcript" }], root.createdAt);
  delete manifest.tasksSha256;
  const archive = { v: 2, archivedAt: root.createdAt, master: root.id, tasks: [root], manifest };
  write(file, archive);
  assert.equal(comparison(dir).groups.simple.runs, 2);
  manifest.evidence.push({ kind: "operation-not-supported", path: "x" });
  write(file, archive);
  rejectedComparison(dir, file, /evidence/i);
});

test("comparison CLI requires a complete target operation record before accepting the root", () => {
  const { repo, board } = fixture(), { target } = governedRun(board, repo);
  const file = path.join(board.dir, "operations", target.id + ".json");
  assert.equal(comparison(board.dir).groups.governed.rootOutcomes.accepted, 1);
  for (const key of ["actor", "pre", "at", "updated"]) {
    const incomplete = { ...target };
    delete incomplete[key];
    write(file, incomplete);
    rejectedComparison(board.dir, file, /operation/i);
  }
  for (const patch of [{ pre: [] }, { pre: { push: "yes", candidate: 5 } }, { updated: "broken" },
    { authorization: { ...target.authorization, push: "false" } }, { state: "unknown" }]) {
    write(file, { ...target, ...patch });
    rejectedComparison(board.dir, file, /operation/i);
  }
  // The original operation writer had no owner field. Keep optional metadata absent.
  const { owner, cleanup, settled, authorization, ...original } = target;
  write(file, original);
  assert.equal(comparison(board.dir).groups.governed.rootOutcomes.accepted, 1);
});

test("comparison CLI accepts both task ledger shapes with absent optional sources", () => {
  const dir = path.join(home, "ledger-shapes"), ledger = path.join(dir, "tasks.json");
  for (const wrap of [(tasks) => tasks, (tasks) => ({ tasks })]) {
    write(ledger, wrap([]));
    const empty = comparison(dir);
    assert.equal(empty.runs, 0);
    assert.deepEqual(Object.values(empty.groups).map((g) => g.runs), [0, 0, 0]);
    write(ledger, wrap([card("abcdef", { sessionId: "unmeasured" })]));
    const { runs, groups } = comparison(dir);
    assert.deepEqual([runs, groups.simple.sessionsUnknown, groups.simple.runsFullyMeasured, groups.simple.medianTokensPerRun], [1, 1, 0, null]);
  }
});

test("comparison CLI accepts every board status, boolean ended flags and older archive records", () => {
  const dir = path.join(home, "valid-statuses"), file = path.join(dir, "tasks.json");
  const statuses = ["queued", "running", "needs-input", "review", "done"];
  write(file, [...statuses.map((status) => card(status, { status, ended: false })), card("closed", { ended: true })]);
  const legacy = card("abcdef", { checks: { status: "complete", run: "" } });
  write(path.join(dir, "archive", "abcdef.json"), { v: 1, master: legacy.id, tasks: [legacy], archivedAt: legacy.createdAt });
  const c = comparison(dir);
  assert.equal(c.runs, 6);
  assert.deepEqual(c.groups.simple.rootOutcomes, { accepted: 1, failed: 0, unverified: 1, open: 4 });
  for (const tasks of [[card("a"), card("a")], [card("a", { openedBy: "gone" })],
    [card("a", { openedBy: "b" }), card("b", { openedBy: "a" })]]) {
    write(file, tasks);
    rejectedComparison(dir, file, /duplicate task id|openedBy chain/i);
  }
});

test("tools/run-export.js: one run by card id or archive key; --compare groups simple, delegated and governed runs, and an empty group is unknown, not 0", async () => {
  const { repo, board } = fixture();
  const { m } = governedRun(board, repo);
  const s = board.add("Simple", "p", "acct"); board.update(s, { status: "done", sessionId: "55555555-5555-4555-8555-555555555555", checks: { status: "complete", run: "x" } });
  write(path.join(board.dir, "measurements", `${s.id}.json`), { tokens: tok(1, 2, 3, 4), complete: true, source: "stream" });
  const tool = require("../tools/run-export.js");
  assert.equal(tool.exportOne(board.dir, m.id).run.root, m.id);
  let c = comparison(board.dir);
  assert.deepEqual([c.groups.simple.runs, c.groups.simple.rootOutcomes.accepted, c.groups.simple.medianTokensPerRun, c.groups.governed.runs, c.groups.delegated.runs], [1, 1, 10, 1, 0]);
  assert.deepEqual([c.groups.simple.runsFullyMeasured, c.groups.governed.sessionsPartial, c.groups.governed.rootOutcomes.accepted], [1, 1, 1]);
  assert.match(c.groups.delegated.note, /unknown, not 0/);
  assert.equal(c.groups.governed.sessionsUnknown, 1, "the council member without a snapshot is counted unknown");
  assert.equal(c.groups.governed.medianTokensPerRun, null, "a run with an unknown session is not called fully measured");
  const { file } = await board.archiveRun(board.get(m.id));
  assert.equal(tool.exportOne(board.dir, m.id).run.archivedAt !== null, true, "after archiving, the key exports the archive");
  c = comparison(board.dir);
  assert.equal(c.groups.governed.runs, 1, "archived runs are counted once");
  assert.equal(c.groups.governed.rootOutcomes.accepted, 1, "retained target operation still counts");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const operation = record.manifest.evidence.find((e) => e.kind === "operation");
  const copy = path.join(file.slice(0, -5) + ".evidence", operation.copy);
  const { actor, ...incomplete } = JSON.parse(fs.readFileSync(copy, "utf8"));
  for (const [bytes, reason] of [[JSON.stringify(incomplete), /operation/i], ["{", /invalid JSON/i]]) {
    write(copy, bytes);
    operation.sha256 = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
    write(file, record); // even a correctly hashed copy must be a complete operation
    rejectedComparison(board.dir, copy, reason);
  }
});

test("comparison CLI requires the archive filename to name its master, with or without a timestamp", () => {
  const dir = path.join(home, "archive-names"), root = card("abcdef"), archive = path.join(dir, "archive");
  write(path.join(dir, "tasks.json"), []);
  const plain = path.join(archive, "abcdef.json"), suffix = "-1730000000000.json";
  write(plain, { v: 1, master: root.id, archivedAt: root.createdAt, tasks: [root] });
  assert.equal(comparison(dir).runs, 1);
  const stamped = path.join(archive, root.id + suffix);
  fs.renameSync(plain, stamped);
  assert.equal(comparison(dir).runs, 1);
  for (const name of ["123456.json", "123456" + suffix]) {
    const alias = path.join(archive, name);
    fs.copyFileSync(stamped, alias);
    rejectedComparison(dir, alias, /master.*abcdef/i);
    fs.unlinkSync(alias);
  }
});

test("comparison CLI counts one conflict through archive and restore and rejects duplicate operation identities", async (t) => {
  const { repo, board } = fixture(), { m, w, head } = governedRun(board, repo);
  const conflict = board.operations.open({ kind: "integrate", card: w.id, run: m.id, actor: m.id, pre: { head } });
  board.operations.set(conflict, { state: "committed", result: { outcome: "conflict", files: ["a.txt"], after: head } });
  function oneConflict() {
    const { runs, groups } = comparison(board.dir);
    assert.deepEqual([runs, groups.governed.runs, groups.governed.integrationFailures], [1, 1, 1]);
  }
  oneConflict();
  const { file } = await board.archiveRun(board.get(m.id));
  oneConflict();
  const archive = JSON.parse(fs.readFileSync(file, "utf8")), evidence = archive.manifest.evidence;
  const entry = evidence.find((e) => e.kind === "operation" && path.basename(e.path) === conflict.id + ".json");
  const evidenceDir = file.slice(0, -5) + ".evidence";
  const alias = { ...entry, path: path.join("other", conflict.id + ".json"), copy: "other-operation.json" };
  fs.copyFileSync(path.join(evidenceDir, entry.copy), path.join(evidenceDir, alias.copy));
  for (const [name, duplicate] of [["repeated entry", entry], ["separate paths and copies with the same receipt id", alias]]) {
    await t.test(name, () => {
      write(file, { ...archive, manifest: { ...archive.manifest, evidence: [...evidence, duplicate] } });
      rejectedComparison(board.dir, file, /duplicate operation/i);
    });
  }
  write(file, archive);
  board.restoreRun(m.id);
  oneConflict();
});

test("harness identity: Codex from its rollout's session_meta; Grok and Antigravity unknown with where it was looked for; never guessed", () => {
  const thread = "01a1e3e4-4d2e-7d52-99d6-22b800ccaecc", day = path.join(home, ".codex", "sessions", "2026", "11", "16");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-11-16T03-25-52-${thread}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: thread, cli_version: "0.169.0", originator: "entomatical", source: "vscode" } }) + "\n{}\n");
  const harness = R.ledgerHarness(path.join(home, "ledger"));
  const card = (provider, sessionId) => R.identityOf({ id: `c-${provider}`, title: "t", status: "done", createdAt: "x", provider, sessionId }, "worker", harness).harness;
  assert.deepEqual(card("codex", thread), { provider: "codex", session: thread, cli: "0.169.0", entrypoint: "entomatical" });
  assert.match(card("codex", "0000").unknown, /^codex: no rollout file for thread 0000/);
  assert.match(card("grok", "g1").unknown, /^grok: its session files .* record the model, not the CLI version/);
  assert.match(card("antigravity", "a1").unknown, /^antigravity: .* not per conversation/);
  assert.equal(card("grok", "g1").cli, null);
  assert.equal(card("codex", undefined).unknown, undefined, "no session: nothing to name");
});
