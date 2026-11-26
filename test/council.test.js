// Phase 5 of docs/plans/MASTER-PLAN-capability-profiles-and-orchestration.md (section 9): saved milestone councils. Acceptance AC-D
// (absent member, no score, dissent, stale result, high score with defect, two-round bound), AC-E (the council gates the user's Finish on the
// exact candidate), AC-H (no badge for an unperformed or stale review) and AC-J (shared capacity, usage kept per member). Pure rules first
// (src/council.ts), then a real Board with fake judge sessions.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

class EventEmitter {
  listeners = [];
  event = (l) => (this.listeners.push(l), { dispose() {} });
  fire(e) { for (const l of this.listeners) l(e); }
  dispose() {}
}
const terminals = [];
const vscode = { EventEmitter, ThemeIcon: class {}, TabInputCustom: class { constructor(uri) { this.uri = uri; } }, ViewColumn: { Beside: -2 },
  commands: { executeCommand: async () => {} },
  Uri: { from: (parts) => ({ ...parts, toString: () => `${parts.scheme}://${parts.authority}${parts.path}` }), file: (p) => ({ fsPath: p }) },
  workspace: { openTextDocument: async (o) => ({ content: o?.content }), getConfiguration: () => ({ get: (_k, d) => d }) },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined, showInformationMessage: async () => undefined, showTextDocument: async () => undefined,
    createTerminal: (options) => { const t = { options, shows: [], sent: [], show: (p) => t.shows.push(p), dispose() { t.exitStatus = { code: 0 }; vscode.window.terminals = vscode.window.terminals.filter((x) => x !== t); }, exit(code = 0) { t.exitStatus = { code }; vscode.window.terminals = vscode.window.terminals.filter((x) => x !== t); }, sendText: (s) => t.sent.push(s) };
      terminals.push(t); vscode.window.terminals.push(t); return t; } } };
const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-council-home-"));
process.env.HOME = process.env.USERPROFILE = home;
process.env.ENTOMATICAL_USAGE_DIR = path.join(home, "usage");
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board } = require("../out/board.js");
const o = require("../out/orchestrator.js");
const C = require("../out/council.js");
const P = require("../out/profiles.js");

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const made = [], boards = [];
test.after(() => { for (const b of boards) b.dispose(); for (const d of made) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RUBRIC = { criteria: [{ id: "C1", text: "Meets the acceptance" }, { id: "C2", text: "No regressions" }], severities: [{ id: "major", text: "Blocks acceptance", material: true }, { id: "minor", text: "Polish", material: false }] };
const content = (extra = {}) => ({ name: "Milestone council", members: [
  { key: "a", account: "acct", model: "haiku", effort: "low", judgeProfile: "provider-defaults" },
  { key: "b", account: "spare", model: "haiku", effort: "low", judgeProfile: "provider-defaults" }],
  rubric: RUBRIC, checkpoints: ["final"], passing: { unavailable: "block" }, limits: { rounds: 2, attempts: 2, minutes: 60 }, equivalence: "none", ...extra });
const json = (o) => "Review done.\n```json\n" + JSON.stringify(o) + "\n```";
const judgment = (pkg, member, verdict, extra = {}) => ({ package: pkg, member, verdict,
  criteria: RUBRIC.criteria.map((c) => ({ id: c.id, assessment: verdict === "pass" ? "met" : verdict === "changes-required" ? "not-met" : "unknown" })), score: null, findings: [], missingEvidence: [], ...extra });
const DEFECT = { id: "F1", severity: "major", text: "Export drops the last column", acceptance: ["A-01"], evidence: "src/export.ts:12" };

// ---- pure rules (src/council.ts) ----

test("O3/O6 stay open: a saved council has no defaults; every member, checkpoint, rubric, round limit and unavailable rule is chosen", () => {
  assert.doesNotThrow(() => C.validCouncil(content()));
  for (const [k, re] of [["members", /name 1 to 5 members/], ["checkpoints", /checkpoints/], ["passing", /passing/], ["limits", /limits/], ["rubric", /rubric/], ["equivalence", /equivalence/]]) {
    const c = content(); delete c[k];
    assert.throws(() => C.validCouncil(c), re, k);
  }
  assert.throws(() => C.validCouncil(content({ limits: { attempts: 1, minutes: 30 } })), /rounds.*no default/);
  assert.throws(() => C.validCouncil(content({ passing: { unavailable: "quorum" } })), /quorum/);
  assert.throws(() => C.validCouncil(content({ passing: { unavailable: "quorum", quorum: 3 } })), /quorum must be a whole number from 1 to 2/);
  assert.throws(() => C.validCouncil(content({ rubric: { ...RUBRIC, severities: [{ id: "minor", text: "x", material: false }] } })), /at least one severity must be material/);
  assert.throws(() => C.validCouncil(content({ members: [{ key: "a", account: "acct", model: "haiku", effort: "low" }] })), /judgeProfile/);
  assert.throws(() => C.validCouncil({ ...content(), secret: 1 }), /unknown fields: secret/);
  assert.throws(() => C.validCouncil(content({ checkpoints: ["milestone"] })), /milestone needs final too/, "review fix: a milestone pass alone would let later unreviewed commits through");
  assert.doesNotThrow(() => C.validCouncil(content({ checkpoints: ["milestone", "final"] })));
  assert.equal(C.diversity(["claude", "claude"]), "single provider (claude): not diverse", "two models of one provider are never called diverse");
  assert.match(C.diversity(["claude", "codex"]), /2 providers configured.*not natively verified/);
});

test("saved councils: revisions are append-only; pin refuses archived, edited-in-place and old revisions and pins judge profiles", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-council-file-")); made.push(dir);
  const file = path.join(dir, "councils.json"), ws = path.join(dir, "capability-profiles.json");
  const prof = P.saveRevision(ws, "workspace", { name: "Judge", variants: { claude: { items: [] } } });
  const pinP = (id) => P.pin({ workspace: ws }, id);
  const { ref } = C.saveCouncilRevision(file, content({ members: [{ key: "a", account: "acct", model: "haiku", effort: "low", judgeProfile: prof.ref }] }));
  const s1 = C.pinCouncil(file, ref, pinP);
  assert.equal(s1.revision, 1);
  assert.equal(s1.profiles[prof.ref].mode, "strict", "the judge profile is pinned with the council");
  // A judge profile named at a revision pins exactly that revision or nothing (review fix: no silent judge substitution).
  const { ref: named } = C.saveCouncilRevision(file, content({ members: [{ key: "a", account: "acct", model: "haiku", effort: "low", judgeProfile: `${prof.ref}@1` }] }));
  assert.equal(C.pinCouncil(file, named, pinP).profiles[`${prof.ref}@1`].snapshot.revision, 1);
  P.saveRevision(ws, "workspace", { name: "Judge 2", variants: { claude: { items: [] } } }, prof.ref);
  assert.throws(() => C.pinCouncil(file, named, pinP), /judge profile .*@1 is unavailable; .* is at revision 2/);
  // Written by hand without a hash: sealed at its first pin, so a later edit in place is refused.
  const hand = JSON.parse(fs.readFileSync(file, "utf8"));
  hand.councils.push({ id: "11111111-2222-4333-8444-555555555555", revisions: [{ revision: 1, ...content() }] }); fs.writeFileSync(file, JSON.stringify(hand));
  C.pinCouncil(file, "workspace:11111111-2222-4333-8444-555555555555", pinP);
  const sealed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.match(sealed.councils.at(-1).revisions[0].hash, /^[0-9a-f]{64}$/);
  sealed.councils.at(-1).revisions[0].limits.rounds = 5; fs.writeFileSync(file, JSON.stringify(sealed));
  assert.throws(() => C.pinCouncil(file, "workspace:11111111-2222-4333-8444-555555555555", pinP), /edited in place/);
  C.saveCouncilRevision(file, content({ name: "Edited" }), ref);
  assert.throws(() => C.pinCouncil(file, `${ref}@1`, pinP), /unavailable; .* is at revision 2/);
  assert.equal(C.pinCouncil(file, ref, pinP).name, "Edited");
  assert.equal(s1.name, "Milestone council", "a pinned snapshot never sees the edit");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.councils[0].revisions[1].limits.rounds = 5; fs.writeFileSync(file, JSON.stringify(doc));
  assert.throws(() => C.pinCouncil(file, ref, pinP), /edited in place/);
  doc.councils[0].revisions[1].limits.rounds = 2; doc.councils[0].archived = true; fs.writeFileSync(file, JSON.stringify(doc));
  assert.throws(() => C.pinCouncil(file, ref, pinP), /archived/);
  assert.equal(C.councilCatalog(file).entries[0].archived, true);
});

const snap = (extra = {}) => ({ ...content(), id: "workspace:c", revision: 1, hash: "h", profiles: {}, pinnedAt: "now", ...extra });
const pkgOf = (extra = {}) => C.makePackage({ v: 1, checkpoint: "final", run: "r00000", spec: { prompt: "p" }, governance: { revision: 1 }, council: { id: "workspace:c", revision: 1, hash: "h" }, rubric: RUBRIC,
  candidate: { commit: "c1", tree: "t1" }, target: { ref: "main", sha: "m1" }, requirements: [{ id: "R-01", text: "r" }], acceptance: [{ id: "A-01", text: "a" }],
  checks: { status: "complete", revision: "c1", clean: true, commands: ["npm test"] }, changed: [], limitations: [], ...extra });
const round = (members, dispositions = []) => ({ n: 1, checkpoint: "final", package: "p", file: "f", at: "now", deadline: "later", members, dispositions });
const ret = (key, j) => ({ key, account: key, model: "m", effort: "e", state: "returned", attempts: 1, judgment: j });

test("AC-D judgments: one fenced JSON per member, bound to its package and member; unknown criteria are unknown, never met", () => {
  const pkg = pkgOf();
  assert.match(C.parseJudgment("I think it passes.", pkg, "a").error, /no ```json block/);
  assert.match(C.parseJudgment(json(judgment("other", "a", "pass")), pkg, "a").error, /names package other/);
  assert.match(C.parseJudgment(json(judgment(pkg.id, "b", "pass")), pkg, "a").error, /names member b/);
  assert.match(C.parseJudgment(json(judgment(pkg.id, "a", "changes-required")), pkg, "a").error, /at least one material finding/);
  assert.match(C.parseJudgment(json(judgment(pkg.id, "a", "pass", { findings: [DEFECT] })), pkg, "a").error, /a pass cannot carry a material finding/);
  assert.match(C.parseJudgment(json(judgment(pkg.id, "a", "pass", { score: 11 })), pkg, "a").error, /score/);
  const partial = C.parseJudgment(json({ ...judgment(pkg.id, "a", "pass"), criteria: [{ id: "C1", assessment: "met" }] }), pkg, "a").judgment;
  assert.deepEqual(partial.criteria.find((c) => c.id === "C2"), { id: "C2", assessment: "unknown", note: "not assessed" });
  assert.equal(C.parseJudgment(json(judgment(pkg.id, "a", "pass")), pkg, "a").judgment.score, null, "no score is a valid judgment");
  assert.match(C.memberPrompt(pkg, content().members[0], 1, "/x.json"), /read-only.*you will not see their judgments/s);
});

test("AC-D outcome: explicit verdicts beat scores; unknown evidence never passes; a missing member blocks unless the saved quorum degrades it; dissent kept", () => {
  const pkg = pkgOf(), s = snap();
  const pass = (k, extra) => ret(k, C.validJudgment(judgment(pkg.id, k, "pass", extra), pkg, k));
  const defect = (k, score) => ret(k, C.validJudgment(judgment(pkg.id, k, "changes-required", { score, findings: [DEFECT] }), pkg, k));
  assert.equal(C.evaluateRound(s, round([pass("a"), { key: "b", state: "reviewing", attempts: 1 }])).state, "reviewing");
  assert.equal(C.evaluateRound(s, round([pass("a"), pass("b")])).state, "passed", "no score anywhere still passes");
  // High scores with a defect: reconciliation first, then the confirmed defect decides, not the average.
  const hi = round([pass("a", { score: 10 }), defect("b", 9.5)]);
  assert.equal(C.evaluateRound(s, hi).state, "reconciliation");
  hi.dispositions.push({ finding: "b/F1", disposition: "confirmed", by: "r", at: "now" }, { finding: "b/criterion:C1", disposition: "confirmed", by: "r", at: "now" }, { finding: "b/criterion:C2", disposition: "unresolved", by: "r", at: "now" });
  const e = C.evaluateRound(s, hi);
  assert.deepEqual([e.state, e.dissent], ["changes-required", ["b: changes-required"]]);
  // Disproved with evidence: passes, and the dissent stays in the record.
  // A criterion assessed not met is an objection of its own: disproving the finding alone leaves it open (review fix, phase 5).
  const half = round([pass("a"), defect("b", 2)], [{ finding: "b/F1", disposition: "disproved", evidence: "test/export.test.js:40 covers the last column", by: "r", at: "now" }]);
  assert.deepEqual([C.evaluateRound(s, half).state, C.evaluateRound(s, half).reasons[0]], ["reconciliation", "2 material findings await the root's disposition: b/criterion:C1, b/criterion:C2"]);
  const dis = round([pass("a"), defect("b", 2)], [{ finding: "b/F1", disposition: "disproved", evidence: "test/export.test.js:40 covers the last column", by: "r", at: "now" }, { finding: "b/criterion:C1", disposition: "disproved", evidence: "test/export.test.js:40", by: "r", at: "now" }, { finding: "b/criterion:C2", disposition: "disproved", evidence: "npm test passed at c1", by: "r", at: "now" }]);
  assert.deepEqual([C.evaluateRound(s, dis).state, C.evaluateRound(s, dis).dissent], ["passed", ["b: changes-required"]]);
  // Absent member: block by default rule; a saved quorum gives a visibly degraded pass.
  const absent = round([pass("a"), { key: "b", account: "spare", state: "unavailable", reason: "not signed in", attempts: 0 }]);
  const blocked = C.evaluateRound(s, absent);
  assert.equal(blocked.state, "unable-to-assess");
  assert.match(blocked.reasons[0], /every member must assess.*b unavailable \(not signed in\)/);
  const q = C.evaluateRound(snap({ passing: { unavailable: "quorum", quorum: 1 } }), absent);
  assert.deepEqual([q.state, q.degraded], ["passed", true]);
  assert.equal(C.evaluateRound(snap({ passing: { unavailable: "quorum", quorum: 2 } }), absent).state, "unable-to-assess");
  // Unknown evidence: an unassessed criterion, missing evidence, unable-to-assess, or a package gap.
  assert.equal(C.evaluateRound(s, round([pass("a"), ret("b", C.validJudgment({ ...judgment(pkg.id, "b", "pass"), criteria: [{ id: "C1", assessment: "met" }] }, pkg, "b"))])).state, "unable-to-assess");
  assert.equal(C.evaluateRound(s, round([pass("a"), pass("b", { missingEvidence: ["the check log"] })])).state, "unable-to-assess");
  assert.equal(C.evaluateRound(s, round([pass("a"), pass("b")]), ["checks failed"]).state, "unable-to-assess");
  assert.deepEqual(C.packageGaps({ ...pkg, checks: { status: "error", commands: ["npm test"] } }), ["the root's checks have failed"]);
  assert.match(C.packageGaps({ ...pkg, candidate: null }).join(), /dirty tree is never a review identity/);
});

test("AC-D reconciliation: dispositions name material findings; disproved needs evidence; a mandatory requirement cannot be relabeled outside scope", () => {
  const pkg = pkgOf(), s = snap();
  const r = round([ret("a", C.validJudgment(judgment(pkg.id, "a", "changes-required", { findings: [DEFECT, { id: "F2", severity: "major", text: "Out of scope idea" }, { id: "F3", severity: "minor", text: "Typo" }] }), pkg, "a"))]);
  assert.deepEqual(C.materialFindings(s, r).map((f) => f.key), ["a/F1", "a/F2", "a/criterion:C1", "a/criterion:C2"], "minor findings need no disposition; criteria not met do");
  assert.match(C.validDispositions([{ finding: "a/F3", disposition: "confirmed" }], s, r, pkg, "r").error, /not a material finding/);
  assert.match(C.validDispositions([{ finding: "a/F1", disposition: "disproved" }], s, r, pkg, "r").error, /disproved needs evidence/);
  assert.match(C.validDispositions([{ finding: "a/F1", disposition: "outside-scope", rationale: "later" }], s, r, pkg, "r").error, /cites A-01.*cannot be relabeled outside scope/);
  assert.match(C.validDispositions([{ finding: "a/F2", disposition: "outside-scope" }], s, r, pkg, "r").error, /needs a rationale/);
  assert.match(C.validDispositions([{ finding: "a/F1", disposition: "confirmed" }, { finding: "a/F1", disposition: "confirmed" }], s, r, pkg, "r").error, /listed twice/);
  const ok = C.validDispositions([{ finding: "a/F1", disposition: "unresolved" }, { finding: "a/F2", disposition: "outside-scope", rationale: "not asked for" }, { finding: "a/criterion:C1", disposition: "confirmed" }, { finding: "a/criterion:C2", disposition: "confirmed" }], s, r, pkg, "r");
  assert.equal(ok.dispositions.length, 4);
  r.dispositions = ok.dispositions;
  assert.equal(C.evaluateRound(s, r).state, "changes-required", "unresolved blocks like confirmed");
});

test("AC-D staleness and the round bound: candidate, criteria, config, spec or target changes stale a result; same tree only under the saved rule", () => {
  const pkg = pkgOf(), s = snap(), now = (extra) => ({ ...pkg, ...extra }), no = () => false;
  assert.equal(C.staleReason(pkg, now({}), s, no), undefined);
  assert.match(C.staleReason(pkg, now({ candidate: { commit: "c2", tree: "t2" } }), s, no), /candidate changed.*reviews every final commit change/);
  assert.match(C.staleReason(pkg, now({ candidate: { commit: "c2", tree: "t1" }, checks: { ...pkg.checks, revision: "c2" } }), s, no), /candidate changed/, "same tree without the rule: stale");
  const st = snap({ equivalence: "same-tree" });
  assert.equal(C.staleReason(pkg, now({ candidate: { commit: "c2", tree: "t1" }, checks: { ...pkg.checks, revision: "c2" } }), st, no), undefined, "same tree, checks passed at the new commit");
  assert.match(C.staleReason(pkg, now({ candidate: { commit: "c2", tree: "t1" } }), st, no), /same tree, but its checks have not passed at it/);
  assert.match(C.staleReason(pkg, now({ council: { ...pkg.council, hash: "h2" } }), s, no), /council configuration changed/, "rubric and criteria live in the council hash");
  assert.match(C.staleReason(pkg, now({ spec: { revision: 2, hash: "x" } }), s, no), /specification changed/);
  assert.match(C.staleReason(pkg, now({ target: { ref: "main", sha: "m2" } }), s, no), /target moved/);
  assert.match(C.staleReason(pkg, now({ checks: { ...pkg.checks, commands: ["npm run lint"] } }), s, no), /evidence environment/);
  const ms = pkgOf({ checkpoint: "milestone" });
  assert.equal(C.staleReason(ms, { ...ms, candidate: { commit: "c9", tree: "t9" } }, s, () => true), undefined, "a milestone still in the candidate holds");
  assert.match(C.staleReason(ms, { ...ms, candidate: { commit: "c9", tree: "t9" } }, s, () => false), /not in the candidate/);
  const run = { snapshot: s, rounds: [{ ...round([]), n: 1, outcome: { state: "changes-required" } }, { ...round([]), n: 2, outcome: { state: "unable-to-assess" } }] };
  assert.equal(C.roundsSincePass(run, "final").length, 2);
  assert.equal(C.isDecisionRequired(run, "final"), true, "two rounds without a pass: a decision, not a third round");
  run.rounds.push({ ...round([]), n: 3, outcome: { state: "passed" } });
  assert.equal(C.roundsSincePass(run, "final").length, 0);
});

test("protocol: council requests are validated; only a governed root may send them", () => {
  assert.match(o.validateRequest({ v: 1, op: "council", by: "a00000", action: "vote" }, "n").error, /action must be/);
  assert.match(o.validateRequest({ v: 1, op: "council", by: "a00000", action: "convene" }, "n").error, /needs checkpoint/);
  assert.match(o.validateRequest({ v: 1, op: "council", by: "a00000", action: "convene", checkpoint: "beta" }, "n").error, /checkpoint must be/);
  assert.match(o.validateRequest({ v: 1, op: "council", by: "a00000", action: "reconcile", checkpoint: "final" }, "n").error, /reconcile needs dispositions/);
  assert.match(o.validateRequest({ v: 1, op: "council", by: "a00000", action: "convene", checkpoint: "final", dispositions: [{}] }, "n").error, /belong to council reconcile/);
  assert.equal(o.validateRequest({ v: 1, op: "council", by: "a00000", action: "show" }, "n").request.action, "show");
});

// ---- the board (src/board.ts) ----

function fixture(councilExtra = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-council-"));
  made.push(repo);
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t"); sh(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".entomatical/\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  boards.push(board);
  board.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }, { name: "spare", configDir: path.join(home, "spare") }, { name: "grok · g", provider: "grok", configDir: path.join(home, "grok") }];
  board.accountFolderList = () => [path.join(home, "acct"), path.join(home, "spare")];
  board.preflightHeadless = async () => {};
  board.requestRateMs = 0;
  board.checks.start = () => {}; // the tests set check results themselves (passChecks)
  board["deliverNotices"] = () => {}; // notices stay queued (asserted); a woken root would invalidate its own checks mid-test
  board.tick();
  const ws = path.join(repo, "workflows", "capability-profiles.json"), file = path.join(repo, "workflows", "councils.json");
  const pin = (id) => P.pin({ workspace: ws }, id);
  const { ref } = C.saveCouncilRevision(file, content(councilExtra));
  return { repo, board, pin, pinCouncil: (r) => C.pinCouncil(file, r, pin), ref, file };
}
const event = (board, id, e) => fs.appendFileSync(board.eventsFile(id), JSON.stringify({ t: Date.now(), ...e }) + "\n");
const settle = (board, task) => { terminals.find((t) => t.options.name === `En ${task.id}` && !t.exitStatus)?.exit(0); event(board, task.id, { hook_event_name: "Stop", last_assistant_message: "done" }); board.syncStatus(task.id); };
async function request(board, body) {
  const inbox = path.join(board.dir, "inbox");
  fs.mkdirSync(path.join(inbox, "done"), { recursive: true });
  const nonce = `n${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(path.join(inbox, `${nonce}.json`), JSON.stringify({ v: 1, at: "now", ...body }));
  await board.processInbox();
  for (let i = 0; i < 40 && !fs.existsSync(path.join(inbox, "done", `${nonce}.json`)); i++) await sleep(50);
  return JSON.parse(fs.readFileSync(path.join(inbox, "done", `${nonce}.json`), "utf8"));
}
const LIMITS = { active: 4, directChildren: 3, depth: 2 };
async function governedRoot(f, limits = LIMITS, council = f.ref, allowed = ["provider-defaults"]) {
  const m = f.board.add("Project", "Ship the export feature.", "acct", undefined, "haiku", "low", undefined, { orchestrator: { caps: { ...o.DEFAULT_CAPS }, opened: 0 }, headless: true });
  await f.board.startHeadless(m);
  event(f.board, m.id, { hook_event_name: "SessionStart", session_id: m.sessionId });
  f.board.update(m, { plan: { steps: 2, points: 1, caps: { ...o.DEFAULT_CAPS } } });
  f.board.govern(m, { limits, allowed, defaultChild: allowed[0], ...(council ? { council } : {}) }, f.pin, f.pinCouncil);
  await f.board.approvePlan(m);
  await f.board.ensureWorktree(m);
  return m;
}
const passChecks = (f, t, revision) => f.board.update(t, { completion: { commands: ["true"] }, checks: { status: "complete", run: "", revision, clean: true } });
/** The root's session ended, a commit on its branch, checks passed at it: a candidate the council can review. */
function candidate(f, m, text = "two\n") {
  f.board["pendingNotices"].delete(m.id);
  if (f.board.live().includes(m.id)) settle(f.board, m);
  f.board.tick();
  fs.writeFileSync(path.join(m.worktree, "a.txt"), text); sh(m.worktree, "commit", "-qam", `candidate ${text.trim()}`);
  const c = sh(m.worktree, "rev-parse", "HEAD"); passChecks(f, m, c); return c;
}
const codes = (r) => r.reasons.map((x) => x.code);
const runOf = (m) => m.governed.council;
const lastRound = (m, cp = "final") => runOf(m).rounds.filter((r) => r.checkpoint === cp).at(-1);
const memberCard = (f, m, key) => f.board.get(lastRound(m).members.find((x) => x.key === key).card);
async function reply(f, card, text, hook = "Stop") {
  await sleep(3);
  terminals.find((t) => t.options.name === `En ${card.id}` && !t.exitStatus)?.exit(0);
  event(f.board, card.id, { hook_event_name: hook, ...(hook === "Stop" ? { last_assistant_message: text } : {}) });
  f.board.syncStatus(card.id);
  await f.board.councilResult(f.board.get(card.id));
}
const auth = { by: "user", at: "now", merge: true, push: false, acks: [] };

test("legacy and unconfigured runs: no council, no badge, no council gate; convene refused; members never come from defaults", async () => {
  const f = fixture();
  const m = await governedRoot(f, LIMITS, null);
  assert.equal(m.governed.council, undefined);
  assert.equal(f.board.governedSnapshot(m).overview.council, "not configured");
  assert.equal(f.board.governedViewOf(m).council, undefined, "no council chip at all");
  await assert.rejects(f.board.convene(m, "final"), /has no council/);
  const r = await request(f.board, { op: "council", by: m.id, session: m.sessionId, protocol: 3, action: "show" });
  assert.match(r.error, /has no council/);
  candidate(f, m);
  assert.ok(!codes(await f.board.readiness(m, "target", auth)).some((c) => c.startsWith("council")), "an unconfigured run is not gated by a council");
  // A legacy root cannot use council either.
  const legacy = f.board.add("Legacy", "x", "acct", undefined, "haiku", "low", undefined, { orchestrator: { caps: { ...o.DEFAULT_CAPS }, opened: 0 }, headless: true });
  await f.board.startHeadless(legacy);
  event(f.board, legacy.id, { hook_event_name: "SessionStart", session_id: legacy.sessionId });
  assert.match((await request(f.board, { op: "council", by: legacy.id, session: legacy.sessionId, protocol: 3, action: "show" })).error, /only a governed run has a council/);
});

test("F113: both council prompts identify the receipt and actual output files of a silent and a printing check", async () => {
  const f = fixture();
  const root = await governedRoot(f);
  const revision = candidate(f, root);
  const commands = ['node -e "process.exit(0)"', 'node -e "console.log(42)"'];
  f.board.update(root, { deliveryReady: true, completion: { commands } });
  delete f.board.checks.start; // Use the real detached worker for this fixture.
  f.board.checks.onResult = () => {};
  f.board.checks.start(root);
  for (let i = 0; i < 200 && root.checks.status === "running"; i++) {
    await sleep(25);
    f.board.checks.sync();
  }
  assert.equal(root.checks.status, "complete", root.checks.error);
  const result = await f.board.convene(root, "final");
  const pkg = JSON.parse(fs.readFileSync(result.file, "utf8"));
  const dir = pkg.checks.log;
  const receipt = path.join(dir, "receipt.json");
  const saved = JSON.parse(fs.readFileSync(receipt, "utf8"));
  assert.equal(saved.revision, revision);
  assert.equal(saved.checksPassed, true);
  const prompts = ["a", "b"].map(key => memberCard(f, root, key).prompt);
  assert.ok(prompts.every(prompt => prompt.includes(receipt)), "both members need the check receipt file");
  for (const [i, command] of commands.entries()) {
    const exit = path.join(dir, `check-${i}.json`), log = path.join(dir, `check-${i}.log`);
    assert.ok(prompts.every(prompt => prompt.includes(exit) && prompt.includes(log)), `missing evidence files for ${command}`);
    const recorded = JSON.parse(fs.readFileSync(exit, "utf8"));
    assert.deepEqual([recorded.command, recorded.exitCode], [command, 0]);
    assert.equal(fs.readFileSync(log, "utf8").replace(/\r\n/g, "\n"), i === 0 ? "" : "42\n");
  }
});

test("AC-D/AC-E: a council on unknown evidence is not convened; members share the same package read-only; high score with a defect and dissent block Finish until round two passes", async () => {
  const f = fixture();
  const m = await governedRoot(f);
  assert.equal(f.board.governedViewOf(m).council.checkpoints[0].state, "not convened", "no badge before a review");
  await assert.rejects(f.board.convene(m, "final"), /not convened: .*no acceptance checks.*no member was started/);
  assert.equal(f.board.tasks.filter((t) => t.council).length, 0);
  await assert.rejects(f.board.convene(m, "plan"), /reviews only final/);
  const cand = candidate(f, m);
  let r = await f.board.readiness(m, "target", auth);
  assert.ok(codes(r).includes("council-none"), JSON.stringify(codes(r)));
  const res = await request(f.board, { op: "council", by: m.id, session: m.sessionId, protocol: 3, action: "convene", checkpoint: "final" });
  assert.equal(res.ok, true, JSON.stringify(res));
  const pkg = JSON.parse(fs.readFileSync(res.file, "utf8"));
  assert.equal(pkg.id, res.package);
  assert.deepEqual(pkg.candidate.commit, cand);
  assert.equal(C.makePackage({ ...pkg, id: undefined }).id, pkg.id, "the package id is the hash of its content");
  const a = memberCard(f, m, "a"), b = memberCard(f, m, "b");
  for (const c of [a, b]) {
    assert.equal(c.role, "research", "read-only launch, never the run's standing judge"); assert.equal(c.orchestrator, undefined, "no child teams");
    assert.equal(o.waiterKind({ ...c, sessionId: undefined }), "judge", "judge priority in admission"); assert.equal(c.governedBy, m.id);
    assert.equal(c.account, c === a ? "acct" : "spare", "exactly the saved account"); assert.ok(c.sessionId, "started");
    assert.match(c.prompt, new RegExp(`Review package ${pkg.id}`)); assert.doesNotMatch(c.prompt, /verdict":"pass".*member":"b/);
  }
  assert.ok(m.governed.leases.some((l) => l.card === a.id) && m.governed.leases.some((l) => l.card === b.id), "members hold run leases");
  assert.match(f.board["runContext"](a), /read-only: do not modify files, commit, run board.js/);
  for (const body of [{ op: "send", id: b.id, text: "I pass it" }, { op: "readiness", id: m.id }, { op: "receive" }])
    assert.match((await request(f.board, { by: a.id, session: a.sessionId, protocol: 3, ...body })).error, /read-only council member; it sends no board requests/, body.op);
  // Duplicate convene: the same round, nothing new started.
  const dup = await f.board.convene(m, "final", m.id);
  assert.deepEqual([dup.duplicate, dup.round], [true, 1]);
  assert.equal(f.board.tasks.filter((t) => t.council).length, 2);
  // Peers cannot see each other: the overview holds states only.
  await reply(f, a, json(judgment(pkg.id, "a", "pass", { score: 10 })));
  assert.equal(lastRound(m).members.find((x) => x.key === "a").state, "returned");
  assert.doesNotMatch(JSON.stringify(f.board.governedSnapshot(m).overview.council), /score|findings/);
  r = await f.board.readiness(m, "target", auth);
  assert.ok(codes(r).includes("council-open"));
  await reply(f, b, json(judgment(pkg.id, "b", "changes-required", { score: 9.5, findings: [DEFECT] })));
  assert.equal(lastRound(m).outcome.state, "reconciliation", "high scores do not average a defect away");
  assert.match(f.board["pendingNotices"].get(m.id)?.get("council:final:1:reconciliation") ?? "", /council reconcile final/);
  // A member's later reply is a duplicate; the first judgment stands.
  await reply(f, b, json(judgment(pkg.id, "b", "pass")));
  assert.equal(lastRound(m).members.find((x) => x.key === "b").judgment.verdict, "changes-required");
  assert.equal(lastRound(m).members.find((x) => x.key === "b").duplicates, 1);
  const bad = await request(f.board, { op: "council", by: m.id, session: m.sessionId, protocol: 3, action: "reconcile", checkpoint: "final", dispositions: [{ finding: "b/F1", disposition: "disproved" }] });
  assert.match(bad.error, /disproved needs evidence/);
  const rec = await request(f.board, { op: "council", by: m.id, session: m.sessionId, protocol: 3, action: "reconcile", checkpoint: "final", dispositions: [{ finding: "b/F1", disposition: "confirmed" }, { finding: "b/criterion:C1", disposition: "confirmed" }, { finding: "b/criterion:C2", disposition: "confirmed" }] });
  assert.equal(rec.state, "changes-required", JSON.stringify(rec));
  r = await f.board.readiness(m, "target", auth);
  assert.ok(codes(r).includes("council-changes"), JSON.stringify(codes(r)));
  await assert.rejects(f.board.convene(m, "final"), /already reviewed in round 1/, "the same package is not re-rolled");
  // Round two: a fixed candidate, a new package carrying round one's dispositions.
  const cand2 = candidate(f, m, "two, with the last column\n");
  const r2 = await f.board.convene(m, "final", m.id);
  assert.equal(r2.round, 2);
  const pkg2 = JSON.parse(fs.readFileSync(r2.file, "utf8"));
  assert.deepEqual([pkg2.candidate.commit, pkg2.previous.round, pkg2.previous.dispositions[0].finding], [cand2, 1, "b/F1"]);
  await reply(f, memberCard(f, m, "a"), json(judgment(pkg2.id, "a", "pass")));
  await reply(f, memberCard(f, m, "b"), json(judgment(pkg2.id, "b", "pass")));
  assert.equal(lastRound(m).outcome.state, "passed");
  r = await f.board.readiness(m, "target", auth);
  assert.deepEqual(codes(r).filter((c) => c.startsWith("council")), [], JSON.stringify(r.reasons));
  assert.ok(r.notes.some((n) => /council final: passed in round 2/.test(n)));
  const full = f.board.councilView(m, true).checkpoints[0].history;
  assert.equal(full[0].members.find((x) => x.key === "b").judgment.findings[0].text, DEFECT.text, "round one's finding and dissent stay in the record");
  assert.ok(full.every((h) => h.members.every((x) => /points of the 5-hour window|unknown|never started/.test(x.usage))), "usage per member, unknown when unmeasured");
  // A new commit after the pass: stale on the card and at Finish.
  candidate(f, m, "three\n");
  assert.match(f.board.governedViewOf(m).council.checkpoints[0].state, /^stale \(the candidate changed\)/, "no badge outlives its candidate");
  r = await f.board.readiness(m, "target", auth);
  assert.ok(codes(r).includes("council-stale"), JSON.stringify(codes(r)));
});

test("AC-D: the saved same-tree rule rebinds a final commit rewrite only with checks passed at it; the target moving stales the pass", async () => {
  const f = fixture({ equivalence: "same-tree" });
  const m = await governedRoot(f);
  candidate(f, m);
  const res = await f.board.convene(m, "final");
  for (const k of ["a", "b"]) await reply(f, memberCard(f, m, k), json(judgment(res.package, k, "pass")));
  assert.equal(lastRound(m).outcome.state, "passed");
  sh(m.worktree, "commit", "-q", "--amend", "-m", "final message");
  let r = await f.board.readiness(m, "target", auth);
  assert.ok(codes(r).includes("council-stale") && codes(r).includes("checks-stale"), JSON.stringify(codes(r)));
  passChecks(f, m, sh(m.worktree, "rev-parse", "HEAD"));
  r = await f.board.readiness(m, "target", auth);
  assert.deepEqual(codes(r).filter((c) => c.startsWith("council")), []);
  assert.ok(r.notes.some((n) => /same tree at .*saved same-tree rule/.test(n)));
  assert.equal(f.board.governedViewOf(m).council.checkpoints[0].state, "passed");
  fs.writeFileSync(path.join(f.repo, "b.txt"), "x\n"); sh(f.repo, "add", "b.txt"); sh(f.repo, "commit", "-qm", "main moved");
  assert.match(f.board.governedViewOf(m).council.checkpoints[0].state, /stale \(the target moved\)/);
  assert.ok(codes(await f.board.readiness(m, "target", auth)).includes("council-stale"));
});

test("AC-D: an absent member is recorded, never substituted; the saved block rule and round limit end in the user's decision, a waiver that is not a pass", async () => {
  const f = fixture({ members: [...content().members, { key: "c", account: "gone", model: "opus", effort: "high", judgeProfile: "provider-defaults" }, { key: "g", account: "grok · g", model: "grok-4", effort: "high", judgeProfile: "provider-defaults" }], limits: { rounds: 1, attempts: 1, minutes: 60 } });
  const m = await governedRoot(f);
  candidate(f, m);
  const res = await f.board.convene(m, "final");
  const state = Object.fromEntries(res.members.map((x) => [x.key, x.state]));
  assert.deepEqual(state, { a: "reviewing", b: "reviewing", c: "unavailable", g: "unavailable" });
  assert.match(res.members.find((x) => x.key === "c").reason, /not signed in here; no other member is substituted/);
  assert.match(res.members.find((x) => x.key === "g").reason, /read-only judging is not enforceable on grok/);
  assert.equal(f.board.tasks.filter((t) => t.council).length, 2, "no card for an unavailable member, and no stand-in");
  for (const k of ["a", "b"]) await reply(f, memberCard(f, m, k), json(judgment(res.package, k, "pass", { score: 10 })));
  assert.equal(lastRound(m).outcome.state, "unable-to-assess", "two perfect scores do not make up for absent members");
  const view = f.board.governedViewOf(m).council.checkpoints[0];
  assert.deepEqual([view.state, view.decisionRequired], ["unable-to-assess", true]);
  let r = await f.board.readiness(m, "target", auth);
  assert.ok(codes(r).includes("council-decision"), JSON.stringify(codes(r)));
  await assert.rejects(f.board.convene(m, "final"), /Decision required: 1 round of final without a pass/);
  assert.throws(() => f.board.councilWaive(m, "final", ""), /needs the user's reason/);
  f.board.councilWaive(m, "final", "Grok cannot judge read-only yet; accepted after reading both reviews");
  r = await f.board.readiness(m, "target", auth);
  assert.deepEqual(codes(r).filter((c) => c.startsWith("council")), []);
  assert.ok(r.notes.some((n) => /waived by the user .* as an exception \(not a council pass\)/.test(n)));
  assert.equal(f.board.governedViewOf(m).council.checkpoints[0].state, "waived (exception)");
  assert.throws(() => f.board.councilWaive(m, "final", "again"), /No decision is required/);
  candidate(f, m, "changed after the waiver\n");
  assert.ok(codes(await f.board.readiness(m, "target", auth)).includes("council-stale"), "a waiver is bound to its package too");
});

test("AC-D/AC-I: interrupted, malformed and write-violating members do not count; a retry is bounded by the saved attempts; a deadline makes a member unavailable", async () => {
  const f = fixture({ limits: { rounds: 2, attempts: 2, minutes: 5 } });
  const m = await governedRoot(f);
  candidate(f, m);
  const res = await f.board.convene(m, "final");
  const a = memberCard(f, m, "a"), b = memberCard(f, m, "b");
  await reply(f, a, "", "Interrupt");
  assert.match(lastRound(m).members.find((x) => x.key === "a").reason, /interrupted/);
  await reply(f, b, "pass, trust me");
  assert.match(lastRound(m).members.find((x) => x.key === "b").reason, /no valid judgment: no ```json block/);
  assert.equal(lastRound(m).outcome.state, "unable-to-assess");
  // Retry b on the same card and package: it counts now.
  const rt = await request(f.board, { op: "council", by: m.id, session: m.sessionId, protocol: 3, action: "retry", checkpoint: "final", member: "b" });
  assert.equal(rt.attempt, 2, JSON.stringify(rt));
  assert.equal(lastRound(m).outcome.state, "reviewing", "a retry reopens the round");
  await reply(f, b, json(judgment(res.package, "b", "pass")));
  assert.equal(lastRound(m).members.find((x) => x.key === "b").state, "returned");
  await assert.rejects(f.board.councilRetry(m, "final", "b"), /only an invalid or late member/);
  // a writes into its worktree, then retries: refused; the read-only check would refuse its judgment anyway.
  fs.writeFileSync(path.join(a.worktree, "scratch.txt"), "x\n");
  await assert.rejects(f.board.councilRetry(m, "final", "a"), /changed its worktree/);
  fs.rmSync(path.join(a.worktree, "scratch.txt"));
  await f.board.councilRetry(m, "final", "a");
  fs.writeFileSync(path.join(a.worktree, "a.txt"), "edited by a judge\n");
  await reply(f, a, json(judgment(res.package, "a", "pass")));
  assert.match(lastRound(m).members.find((x) => x.key === "a").reason, /read-only violated/);
  await assert.rejects(f.board.councilRetry(m, "final", "a"), /used its 2 saved attempts/);
  assert.equal(lastRound(m).outcome.state, "unable-to-assess");
  // A reload: a fresh Board reads the same record.
  const again = new Board(f.repo, path.join(f.repo, "hook.js"), undefined, false); boards.push(again);
  assert.equal(again.get(m.id).governed.council.rounds[0].outcome.state, "unable-to-assess");
  // Deadline: a second round whose member never answers becomes unavailable on the tick.
  sh(a.worktree, "checkout", "--", "a.txt");
  candidate(f, m, "round two\n");
  await f.board.convene(m, "final");
  // A member left pending by a crash mid-convene does not hold the round open for good (review fix).
  Object.assign(lastRound(m).members[1], { state: "pending", card: undefined, at: undefined });
  f.board.tick();
  assert.match(lastRound(m).members[1].reason, /stopped before this member started/);
  assert.equal(lastRound(m).members[0].state, "reviewing");
  lastRound(m).deadline = new Date(Date.now() - 1000).toISOString();
  f.board.tick();
  assert.deepEqual(lastRound(m).members.map((x) => x.state), ["unavailable", "unavailable"]);
  assert.match(lastRound(m).members[0].reason, /no judgment within the saved 5 minutes/);
  assert.equal(f.board.governedViewOf(m).council.checkpoints[0].decisionRequired, true, "two rounds without a pass: decision required");
  // After the user's waiver nothing can change the round he decided on (review fix): no retry, no reconcile.
  f.board.councilWaive(m, "final", "accepted with both members late");
  await assert.rejects(f.board.councilRetry(m, "final", "a"), /already decided round 2/);
  assert.throws(() => f.board.councilReconcile(m, "final", [{ finding: "a/F1", disposition: "confirmed" }]), /already decided/);
});

test("CORE-GOV-05: a council whose judge profile the run does not allow is refused before the run is saved; an allowed one's members all review", async () => {
  const f = fixture();
  const strict = P.saveRevision(path.join(f.repo, "workflows", "capability-profiles.json"), "workspace", { name: "Strict judge", variants: { claude: { items: [] } } });
  // Only the strict profile is allowed; the saved council's members use provider defaults.
  await assert.rejects(governedRoot(f, LIMITS, f.ref, [strict.ref]), /council member a's judge profile provider-defaults is not one this run allows/);
  const refused = f.board.tasks.find((t) => t.title === "Project");
  assert.equal(refused.governed, undefined, "the run was not saved as governed");
  assert.equal(f.board.tasks.filter((t) => t.council).length, 0, "no member card exists");
  const eligible = await governedRoot(f, LIMITS, f.ref, ["provider-defaults"]);
  candidate(f, eligible);
  const active = await f.board.convene(eligible, "final");
  assert.deepEqual(active.members.map(x => x.state), ["reviewing", "reviewing"]);
  // Run authorization pins the strict profile; the independent route check still refuses an unverified headless launch.
  const { ref } = C.saveCouncilRevision(f.file, content({ members: content().members.map((x) => ({ ...x, judgeProfile: strict.ref })) }));
  const m = await governedRoot(f, LIMITS, ref, [strict.ref]);
  candidate(f, m);
  const res = await f.board.convene(m, "final");
  for (const x of res.members) {
    const card = f.board.get(x.card);
    assert.equal(card.profile.snapshot.id, strict.ref.replace(/@.*/, ""));
    assert.equal(x.state, "unavailable");
    assert.match(x.reason, /strict scope is not enabled for claude:headless/);
    assert.equal(card.sessionId, undefined);
  }
  // A run saved before this check with a disallowed judge: that member is recorded unavailable, and no card is made for it.
  const old = await governedRoot(f, LIMITS, ref, [strict.ref]);
  old.governed.council.snapshot.members[1].judgeProfile = "provider-defaults";
  old.governed.council.snapshot.profiles["provider-defaults"] = { mode: "provider-defaults" };
  candidate(f, old);
  const before = f.board.tasks.filter((t) => t.council).length;
  const res2 = await f.board.convene(old, "final"), b = res2.members.find((x) => x.key === "b");
  assert.match(b.reason ?? "", /judge profile provider-defaults is not one governed run \w+ allows/);
  assert.equal(b.card, null);
  assert.equal(f.board.tasks.filter((t) => t.council).length, before + 1, "only member a got a card");
});

test("AC-J capacity: members take leases from the run's shared limit; one waits queued, starts when a lease frees, and the board never overbooks", async () => {
  const f = fixture();
  const m = await governedRoot(f, { active: 2, directChildren: 2, depth: 2 });
  candidate(f, m);
  // Keep the root's own lease: it counts against the same limit as the judges.
  m.governed.leases.push({ card: m.id, op: "test", at: new Date().toISOString(), state: "active" });
  f.board["live"] = () => [m.id];
  const res = await f.board.convene(m, "final");
  const states = res.members.map((x) => x.state).sort();
  assert.deepEqual(states, ["queued", "reviewing"]);
  assert.ok(m.governed.leases.length <= 2, `never overbooked: ${m.governed.leases.length}`);
  const q = res.members.find((x) => x.state === "queued"), queued = f.board.get(q.card);
  assert.match(q.reason, /Waiting for an execution lease/);
  assert.equal(queued.held, true);
  assert.equal(f.board.governedViewOf(m).council.checkpoints[0].state, "reviewing");
  // The root ends its session: its lease is released; the held judge starts (as the extension's queue would) and reviews.
  f.board["live"] = () => [];
  m.governed.leases = m.governed.leases.filter((l) => l.card !== m.id);
  await f.board.startHeadless(queued);
  f.board.tick();
  assert.equal(lastRound(m).members.find((x) => x.key === q.key).state, "reviewing");
  for (const k of ["a", "b"]) await reply(f, memberCard(f, m, k), json(judgment(res.package, k, "pass")));
  assert.equal(lastRound(m).outcome.state, "passed");
});
