/**
 * Phase 5 of docs/plans/MASTER-PLAN-capability-profiles-and-orchestration.md (section 9): saved milestone councils, fixed review packages,
 * independent member judgments, root reconciliation and the passing rules. Pure functions: Board (src/board.ts) runs the members as
 * read-only judge cards and calls these. O3 and O6 are undecided, so nothing here has a default: every member, checkpoint, rubric, round
 * limit and unavailable-member rule is chosen in the saved configuration, and a missing one is refused, never filled in.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { Selection as ProfileSelection } from "./profiles";

export const COUNCIL_FILE = "councils.json";
export const COUNCIL_FILE_VERSION = 1;
export const CHECKPOINTS = ["plan", "milestone", "final"] as const;
export type Checkpoint = typeof CHECKPOINTS[number];
/** Providers whose judge launch the board makes read-only (Claude plan mode, Codex read-only sandbox). Grok and Antigravity have none. */
export const READ_ONLY_PROVIDERS = ["claude", "codex"];

export interface Member { key: string; account: string; model: string; effort: string; judgeProfile: string }
export interface Rubric { criteria: { id: string; text: string }[]; severities: { id: string; text: string; material: boolean }[] }
export type Passing = { unavailable: "block" } | { unavailable: "quorum"; quorum: number };
export interface Limits { rounds: number; attempts: number; minutes: number }
export interface CouncilContent { name: string; description?: string; members: Member[]; rubric: Rubric; checkpoints: Checkpoint[]; passing: Passing; limits: Limits; equivalence: "none" | "same-tree" }
export interface CouncilRevision extends CouncilContent { revision: number; hash?: string }
export interface Council { id: string; archived?: boolean; revisions: CouncilRevision[] }
/** What a governed run keeps: the exact revision, its hash, and each member's judge profile pinned at approval. */
export interface CouncilSnapshot extends CouncilContent { id: string; revision: number; hash: string; profiles: Record<string, ProfileSelection>; pinnedAt: string }

export const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(v);
export const sha = (v: unknown) => crypto.createHash("sha256").update(typeof v === "string" ? v : canonical(v)).digest("hex");
const contentOf = (r: CouncilContent): CouncilContent => ({ name: r.name, description: r.description, members: r.members, rubric: r.rubric, checkpoints: r.checkpoints, passing: r.passing, limits: r.limits, equivalence: r.equivalence });
export const councilHash = (r: CouncilContent) => sha(contentOf(r));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9._-]{1,40}$/;
const CTL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
function only(o: unknown, keys: string[], where: string): Record<string, unknown> {
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`${where} is not an object`);
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`${where} has unknown fields: ${extra.join(", ")}`);
  return o as Record<string, unknown>;
}
const text = (v: unknown, cap: number, where: string) => { if (typeof v !== "string" || !v.trim() || v.length > cap || CTL.test(v)) throw new Error(`${where} must be a text of up to ${cap} characters`); return v; };
const int = (v: unknown, min: number, max: number, where: string) => { if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new Error(`${where} must be a whole number from ${min} to ${max}`); return v as number; };
const NO_DEFAULT = "there is no default (O3/O6 are undecided); choose it in the saved council";

/** One council revision's content, checked. Every field is required: nothing is filled in. */
export function validCouncil(raw: unknown, where = "council"): CouncilContent {
  const o = only(raw, ["name", "description", "members", "rubric", "checkpoints", "passing", "limits", "equivalence", "revision", "hash"], where);
  text(o.name, 120, `${where}.name`);
  if (o.description !== undefined) text(o.description, 1000, `${where}.description`);
  if (!Array.isArray(o.members) || !o.members.length || o.members.length > 5) throw new Error(`${where}.members: name 1 to 5 members (account, model, effort, judgeProfile); ${NO_DEFAULT}`);
  const keys = new Set<string>();
  for (const [i, m] of o.members.entries()) {
    const x = only(m, ["key", "account", "model", "effort", "judgeProfile"], `${where}.members[${i}]`);
    if (typeof x.key !== "string" || !KEY.test(x.key) || keys.has(x.key)) throw new Error(`${where}.members[${i}].key must be a distinct name of letters, digits, dot, dash or underscore`);
    keys.add(x.key);
    for (const k of ["account", "model", "effort", "judgeProfile"]) text(x[k], 300, `${where}.members[${i}].${k} (${NO_DEFAULT})`);
  }
  const rb = only(o.rubric, ["criteria", "severities"], `${where}.rubric`);
  if (!Array.isArray(rb.criteria) || !rb.criteria.length || rb.criteria.length > 20) throw new Error(`${where}.rubric.criteria: name 1 to 20 criteria`);
  if (!Array.isArray(rb.severities) || !rb.severities.length || rb.severities.length > 6) throw new Error(`${where}.rubric.severities: name 1 to 6 severities`);
  const ids = (list: unknown[], what: string, extra: string[]) => { const seen = new Set<string>(); for (const [i, c] of list.entries()) { const x = only(c, ["id", "text", ...extra], `${where}.rubric.${what}[${i}]`); if (typeof x.id !== "string" || !KEY.test(x.id) || seen.has(x.id)) throw new Error(`${where}.rubric.${what}[${i}].id must be distinct`); seen.add(x.id); text(x.text, 500, `${where}.rubric.${what}[${i}].text`); } };
  ids(rb.criteria, "criteria", []); ids(rb.severities, "severities", ["material"]);
  if (!rb.severities.every((s) => typeof (s as Record<string, unknown>).material === "boolean")) throw new Error(`${where}.rubric.severities: each says material true or false`);
  if (!rb.severities.some((s) => (s as Record<string, unknown>).material === true)) throw new Error(`${where}.rubric.severities: at least one severity must be material, or no defect could ever block`);
  if (!Array.isArray(o.checkpoints) || !o.checkpoints.length || !o.checkpoints.every((c) => (CHECKPOINTS as readonly unknown[]).includes(c)) || new Set(o.checkpoints).size !== o.checkpoints.length)
    throw new Error(`${where}.checkpoints: choose one or more of ${CHECKPOINTS.join(", ")}; ${NO_DEFAULT}`);
  // A milestone pass holds for later candidates that contain it; only a final review covers the commits after it.
  if (o.checkpoints.includes("milestone") && !o.checkpoints.includes("final")) throw new Error(`${where}.checkpoints: milestone needs final too (commits after a milestone are reviewed only by the final checkpoint)`);
  const p = only(o.passing, ["unavailable", "quorum"], `${where}.passing`);
  if (p.unavailable === "block") { if (p.quorum !== undefined) throw new Error(`${where}.passing: a quorum belongs only to unavailable: "quorum"`); }
  else if (p.unavailable === "quorum") { int(p.quorum, 1, o.members.length, `${where}.passing.quorum`); }
  else throw new Error(`${where}.passing.unavailable must be "block" (every member must assess) or "quorum" (with a quorum: a visibly degraded outcome); ${NO_DEFAULT}`);
  const l = only(o.limits, ["rounds", "attempts", "minutes"], `${where}.limits`);
  int(l.rounds, 1, 5, `${where}.limits.rounds (${NO_DEFAULT})`); int(l.attempts, 1, 3, `${where}.limits.attempts`); int(l.minutes, 5, 1440, `${where}.limits.minutes`);
  if (o.equivalence !== "none" && o.equivalence !== "same-tree") throw new Error(`${where}.equivalence must be "none" (a final commit change is always reviewed again) or "same-tree" (a commit with the reviewed tree and checks passed at it keeps the verdict)`);
  return contentOf(o as unknown as CouncilContent);
}

/** Reads the workspace council file. Missing: no councils. Unknown version or a malformed council: throws, so nothing in it is selectable. */
export function readCouncils(file: string): Council[] {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const doc = only(JSON.parse(raw), ["version", "councils"], file);
  if (doc.version !== COUNCIL_FILE_VERSION) throw new Error(`${file} has version ${JSON.stringify(doc.version)}, which this Entomatical cannot read`);
  if (!Array.isArray(doc.councils)) throw new Error(`${file}: councils is not a list`);
  const seen = new Set<string>();
  return doc.councils.map((c, i) => {
    const o = only(c, ["id", "archived", "revisions"], `councils[${i}]`);
    if (typeof o.id !== "string" || !UUID.test(o.id) || seen.has(o.id)) throw new Error(`councils[${i}].id must be a distinct lower-case UUID`);
    seen.add(o.id);
    if (!Array.isArray(o.revisions) || !o.revisions.length) throw new Error(`council ${o.id} has no revisions`);
    let last = 0;
    for (const [j, r] of o.revisions.entries()) {
      const x = r as Record<string, unknown>;
      if (!Number.isInteger(x?.revision) || (x.revision as number) <= last) throw new Error(`council ${o.id}: revision numbers must rise`);
      last = x.revision as number;
      validCouncil(r, `council ${o.id} revisions[${j}]`);
    }
    return o as unknown as Council;
  });
}
/** A new revision (or a new council); earlier revisions are copied unchanged, so a pinned run never sees an edit. Returns the ref. */
export function saveCouncilRevision(file: string, content: unknown, id?: string): { ref: string; revision: number } {
  const councils = readCouncils(file), c = validCouncil(content, "the new revision");
  const bare = id ? id.replace(/^workspace:/, "") : crypto.randomUUID();
  let x = councils.find((y) => y.id === bare);
  if (id && !x) throw new Error(`No council ${id}.`);
  if (!x) councils.push(x = { id: bare, revisions: [] });
  const revision = (x.revisions.at(-1)?.revision ?? 0) + 1;
  x.revisions.push({ revision, ...c, hash: councilHash(c) });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: COUNCIL_FILE_VERSION, councils }, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return { ref: `workspace:${bare}`, revision };
}
export interface CouncilEntry { ref: string; name: string; revision: number; members: number; providers: string; archived: boolean; altered: boolean }
export function councilCatalog(file: string): { entries: CouncilEntry[]; error?: string } {
  try {
    return { entries: readCouncils(file).map((c) => { const r = c.revisions.at(-1)!; return { ref: `workspace:${c.id}`, name: r.name, revision: r.revision, members: r.members.length, providers: "", archived: !!c.archived, altered: !!r.hash && r.hash !== councilHash(r) }; }) };
  } catch (e) { return { entries: [], error: e instanceof Error ? e.message : String(e) }; }
}
/** Pins a council's newest revision for a governed run, with each member's judge profile pinned too. Archived, edited-in-place or unknown: refused. */
export function pinCouncil(file: string, ref: string, pinProfile: (id: string) => ProfileSelection, now = new Date()): CouncilSnapshot {
  const [bare, rev] = ref.replace(/^workspace:/, "").split("@");
  const c = readCouncils(file).find((x) => x.id === bare);
  if (!c) throw new Error(`Council ${ref} does not exist (${file}).`);
  if (c.archived) throw new Error(`Council ${ref} is archived; runs that pinned it keep it, new runs cannot select it.`);
  const r = c.revisions.at(-1)!, hash = councilHash(r);
  if (rev !== undefined && Number(rev) !== r.revision) throw new Error(`Council ${ref} is unavailable; ${bare} is at revision ${r.revision}.`);
  if (r.hash && r.hash !== hash) throw new Error(`Council ${ref} r${r.revision} was edited in place; save a new revision instead.`);
  if (!r.hash) { // written by hand: sealed now, at its first pin, so any later edit in place is refused
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.councils.find((x: Council) => x.id === bare).revisions.at(-1).hash = hash;
    const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n"); fs.renameSync(tmp, file);
  }
  const profiles: Record<string, ProfileSelection> = {};
  for (const m of r.members) {
    if (profiles[m.judgeProfile]) continue;
    if (m.judgeProfile === "provider-defaults") { profiles[m.judgeProfile] = { mode: "provider-defaults" }; continue; }
    const [pid, prev] = m.judgeProfile.split("@"), sel = pinProfile(pid);
    // A named revision is that revision or nothing: pinning a newer one would substitute the member's judge.
    if (prev !== undefined && sel.mode === "strict" && Number(prev) !== sel.snapshot.revision) throw new Error(`Council ${ref}: member ${m.key}'s judge profile ${m.judgeProfile} is unavailable; ${pid} is at revision ${sel.snapshot.revision}.`);
    profiles[m.judgeProfile] = sel;
  }
  return JSON.parse(JSON.stringify({ ...contentOf(r), id: `workspace:${bare}`, revision: r.revision, hash, profiles, pinnedAt: now.toISOString() }));
}
/** Different providers among the members, as configured. Two models of one provider are never called diverse; native diversity is unverified. */
export const diversity = (providers: (string | undefined)[]) => { const p = [...new Set(providers.filter(Boolean))]; return p.length >= 2 ? `${p.length} providers configured (${p.join(", ")}); not natively verified` : `single provider${p.length ? ` (${p[0]})` : ""}: not diverse`; };

// ---- the fixed package ----

export interface PackageContent {
  v: 1; checkpoint: Checkpoint; run: string;
  spec: { revision: number; hash: string } | { prompt: string };
  plan?: { file: string; hash: string };
  governance: { revision: number };
  council: { id: string; revision: number; hash: string };
  rubric: Rubric;
  candidate: { commit: string; tree: string } | null;
  target: { ref: string; sha: string } | null;
  requirements: { id: string; text: string }[];
  acceptance: { id: string; text: string }[];
  // In v1 packages, log is the check worker's run directory.
  checks: { status: string; revision?: string; clean?: boolean; commands: string[]; log?: string } | null;
  changed: string[];
  previous?: { round: number; package: string; outcome: string; dispositions: Disposition[] };
  limitations: string[];
}
export interface ReviewPackage extends PackageContent { id: string }
/** The package's identity is the hash of everything a member sees; the round number is outside it. */
export const makePackage = (c: PackageContent): ReviewPackage => ({ ...c, id: sha(c) });
/** The facts a fixed package needs before it can be reviewed at all; a review whose evidence is unknown cannot pass, so it is not started. */
export function packageGaps(c: PackageContent): string[] {
  const out: string[] = [];
  if (c.checkpoint !== "plan") {
    if (!c.candidate) out.push("there is no clean candidate commit (a dirty tree is never a review identity)");
    const k = c.checks;
    if (!k || !k.commands.length) out.push("the root has no acceptance checks (Done when): the combined validation is unknown");
    else if (k.status !== "complete") out.push(`the root's checks have ${k.status === "running" ? "not finished" : k.status === "none" ? "not run" : "failed"}`);
    else if (k.revision !== c.candidate?.commit) out.push(`the root's checks passed at ${k.revision?.slice(0, 12) ?? "an unknown revision"}, not at the candidate`);
    else if (k.clean !== true) out.push("the root's checks ran on a dirty or moving tree");
  }
  if (!c.target) out.push("the target branch is unknown");
  return out;
}
/** The member's prompt: the package and nothing else (no peer judgments), read-only, and the exact reply format. */
export function memberPrompt(pkg: ReviewPackage, member: Member, round: number, file: string): string {
  const crit = pkg.rubric.criteria.map((c) => `- ${c.id}: ${c.text}`).join("\n"), sev = pkg.rubric.severities.map((s) => `- ${s.id}${s.material ? " (material)" : ""}: ${s.text}`).join("\n");
  const cand = pkg.candidate ? `Candidate commit ${pkg.candidate.commit} (tree ${pkg.candidate.tree}) against ${pkg.target?.ref ?? "the target"} at ${pkg.target?.sha ?? "?"}: read it with git diff ${pkg.target?.sha ?? "<target>"}..${pkg.candidate.commit} and git show ${pkg.candidate.commit}:<path>. Do not check it out or change any branch.`
    : `There is no implementation yet: review the plan${pkg.plan ? ` at ${pkg.plan.file}` : ""} and the specification against the baseline ${pkg.target?.sha ?? "?"}.`;
  const checks = pkg.checks, dir = checks?.log;
  const evidence = dir && checks ? [
    `The package's checks.log names the run directory. Read the check evidence below.\nReceipt: ${path.join(dir, "receipt.json")}`,
    ...checks.commands.map((command, i) => `- ${command}\n  Exit record: ${path.join(dir, `check-${i}.json`)}\n  Output: ${path.join(dir, `check-${i}.log`)}`),
    "A readable zero-byte output file means the command printed nothing. Verify the exit code in its exit record.",
  ].join("\n") : "";
  return `You are council member ${member.key}, round ${round}, checkpoint ${pkg.checkpoint} of governed run ${pkg.run}. Review package ${pkg.id} (the full package is at ${file}).
Review independently and read-only: do not modify, create or commit files, open cards, delegate, or run board.js. Other members review the same package; you will not see their judgments.
${cand}
Requirements:\n${pkg.requirements.map((r) => `- ${r.id}: ${r.text}`).join("\n") || "- (see the specification in the package)"}
Acceptance:\n${pkg.acceptance.map((a) => `- ${a.id}: ${a.text}`).join("\n") || "- (none listed)"}
Checks: ${checks ? `${checks.status} at ${checks.revision ?? "?"}\n${evidence || checks.commands.join("; ")}` : "none"}
${pkg.previous ? `Previous round ${pkg.previous.round} (${pkg.previous.outcome}); the root's dispositions are in the package file.\n` : ""}Criteria:\n${crit}\nSeverities:\n${sev}
End your reply with exactly one JSON block in a \`\`\`json fence, nothing after it:
{"package":"${pkg.id}","member":"${member.key}","verdict":"pass" | "changes-required" | "unable-to-assess","criteria":[{"id":"<criterion id>","assessment":"met" | "not-met" | "unknown","note":"..."}],"score":<0-10 or null>,"findings":[{"id":"F1","severity":"<severity id>","text":"...","requirements":["R-01"],"acceptance":["A-01"],"evidence":"<file:line, command or commit>"}],"missingEvidence":["what you needed and could not see"]}
Assess every criterion. Unknown evidence is "unknown", never "met". changes-required names at least one material finding; pass leaves no criterion not-met and no material finding.`;
}

// ---- member judgments ----

export interface Finding { id: string; severity: string; text: string; requirements?: string[]; acceptance?: string[]; evidence?: string }
export interface Judgment { package: string; member: string; verdict: "pass" | "changes-required" | "unable-to-assess"; criteria: { id: string; assessment: "met" | "not-met" | "unknown"; note?: string }[]; score: number | null; findings: Finding[]; missingEvidence: string[] }
/** The last fenced JSON block of a member's final reply, checked against its package, member and the rubric. */
export function parseJudgment(reply: string, pkg: ReviewPackage, member: string): { judgment: Judgment } | { error: string } {
  const blocks = [...reply.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) return { error: "no ```json block in the final reply" };
  let raw: unknown;
  try { raw = JSON.parse(blocks.at(-1)![1]); } catch (e) { return { error: `the JSON block does not parse (${(e as Error).message})` }; }
  try { return { judgment: validJudgment(raw, pkg, member) }; } catch (e) { return { error: (e as Error).message }; }
}
export function validJudgment(raw: unknown, pkg: ReviewPackage, member: string): Judgment {
  const o = only(raw, ["package", "member", "verdict", "criteria", "score", "findings", "missingEvidence"], "judgment");
  if (o.package !== pkg.id) throw new Error(`the judgment names package ${String(o.package).slice(0, 80)}, not ${pkg.id}`);
  if (o.member !== member) throw new Error(`the judgment names member ${String(o.member).slice(0, 40)}, not ${member}`);
  if (!["pass", "changes-required", "unable-to-assess"].includes(o.verdict as string)) throw new Error("verdict must be pass, changes-required or unable-to-assess");
  if (o.score !== null && o.score !== undefined && (typeof o.score !== "number" || !Number.isFinite(o.score) || o.score < 0 || o.score > 10)) throw new Error("score must be a number from 0 to 10, or null");
  const criteria = Array.isArray(o.criteria) ? o.criteria.map((c, i) => { const x = only(c, ["id", "assessment", "note"], `criteria[${i}]`); if (!["met", "not-met", "unknown"].includes(x.assessment as string)) throw new Error(`criteria[${i}].assessment must be met, not-met or unknown`); return { id: String(x.id), assessment: x.assessment as Judgment["criteria"][number]["assessment"], ...(typeof x.note === "string" ? { note: x.note.slice(0, 1000) } : {}) }; }) : undefined;
  if (!criteria) throw new Error("criteria must be a list");
  // A criterion the member left out is unknown, never met.
  for (const c of pkg.rubric.criteria) if (!criteria.some((x) => x.id === c.id)) criteria.push({ id: c.id, assessment: "unknown", note: "not assessed" });
  const sevs = new Map(pkg.rubric.severities.map((s) => [s.id, s.material]));
  if (!Array.isArray(o.findings) || o.findings.length > 30) throw new Error("findings must be a list of up to 30");
  const seen = new Set<string>();
  const findings = o.findings.map((f, i) => {
    const x = only(f, ["id", "severity", "text", "requirements", "acceptance", "evidence"], `findings[${i}]`);
    if (typeof x.id !== "string" || !KEY.test(x.id) || seen.has(x.id)) throw new Error(`findings[${i}].id must be distinct`);
    seen.add(x.id);
    if (!sevs.has(x.severity as string)) throw new Error(`findings[${i}].severity must be one of ${[...sevs.keys()].join(", ")}`);
    const ids = (k: string) => x[k] === undefined ? undefined : Array.isArray(x[k]) && (x[k] as unknown[]).every((y) => typeof y === "string" && y.length <= 40) ? (x[k] as string[]).slice(0, 20) : (() => { throw new Error(`findings[${i}].${k} must be a list of ids`); })();
    return { id: x.id, severity: x.severity as string, text: text(x.text, 2000, `findings[${i}].text`), ...(ids("requirements") ? { requirements: ids("requirements") } : {}), ...(ids("acceptance") ? { acceptance: ids("acceptance") } : {}), ...(typeof x.evidence === "string" ? { evidence: x.evidence.slice(0, 500) } : {}) };
  });
  const missingEvidence = Array.isArray(o.missingEvidence) ? o.missingEvidence.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 500)).slice(0, 20) : [];
  const material = findings.filter((f) => sevs.get(f.severity));
  if (o.verdict === "changes-required" && !material.length) throw new Error("changes-required must name at least one material finding");
  if (o.verdict === "pass" && (material.length || criteria.some((c) => c.assessment === "not-met"))) throw new Error("a pass cannot carry a material finding or a criterion not met");
  return { package: pkg.id, member, verdict: o.verdict as Judgment["verdict"], criteria, score: typeof o.score === "number" ? o.score : null, findings, missingEvidence };
}

// ---- rounds, reconciliation and the outcome ----

export type MemberState = "pending" | "queued" | "reviewing" | "returned" | "invalid" | "unavailable";
export interface MemberRun { key: string; account: string; provider?: string; model: string; effort: string; card?: string; state: MemberState; reason?: string; attempts: number; at?: string; head?: string; ended?: number; judgment?: Judgment; duplicates?: number }
export type DispositionKind = "confirmed" | "disproved" | "outside-scope" | "unresolved";
export interface Disposition { finding: string; disposition: DispositionKind; evidence?: string; rationale?: string; by: string; at: string }
export type Outcome = "reviewing" | "reconciliation" | "passed" | "changes-required" | "unable-to-assess";
export interface Round { n: number; checkpoint: Checkpoint; package: string; /** sha of the package content without `previous`: the work under review. */ subject?: string; file: string; at: string; deadline: string; members: MemberRun[]; dispositions: Disposition[]; outcome?: { state: Outcome; reasons: string[]; degraded?: boolean; dissent: string[]; at: string }; decision?: { kind: "waiver"; by: "user"; reason: string; at: string } }
export interface CouncilRun { snapshot: CouncilSnapshot; rounds: Round[] }

const SETTLED: MemberState[] = ["returned", "invalid", "unavailable"];
/** Every material finding of the returned judgments, keyed member/finding. */
export function materialFindings(snap: Pick<CouncilContent, "rubric">, round: Round): { key: string; member: string; finding: Finding }[] {
  const material = new Set(snap.rubric.severities.filter((s) => s.material).map((s) => s.id));
  // A criterion a member assessed not met is an objection of its own: it needs a disposition like a material finding (member/criterion:<id>).
  return round.members.flatMap((m) => m.state === "returned" && m.judgment ? [...m.judgment.findings.filter((f) => material.has(f.severity)).map((f) => ({ key: `${m.key}/${f.id}`, member: m.key, finding: f })),
    ...m.judgment.criteria.filter((c) => c.assessment === "not-met").map((c) => ({ key: `${m.key}/criterion:${c.id}`, member: m.key, finding: { id: `criterion:${c.id}`, severity: "criterion", text: `criterion ${c.id} not met${c.note ? `: ${c.note}` : ""}` } }))] : []);
}
/** The root's dispositions, checked: each names a material finding of this round; disproved needs evidence; outside scope needs a rationale and cannot touch a listed requirement or acceptance id. */
export function validDispositions(raw: unknown, snap: CouncilSnapshot, round: Round, pkg: ReviewPackage, by: string, now = new Date()): { dispositions: Disposition[] } | { error: string } {
  if (!Array.isArray(raw) || !raw.length || raw.length > 100) return { error: "dispositions must be a list of 1 to 100" };
  const known = new Map(materialFindings(snap, round).map((f) => [f.key, f.finding]));
  const mandatory = new Set([...pkg.requirements.map((r) => r.id), ...pkg.acceptance.map((a) => a.id)]);
  const out: Disposition[] = [], seen = new Set<string>();
  for (const [i, d] of raw.entries()) {
    let x: Record<string, unknown>;
    try { x = only(d, ["finding", "disposition", "evidence", "rationale"], `dispositions[${i}]`); } catch (e) { return { error: (e as Error).message }; }
    const f = known.get(String(x.finding));
    if (!f) return { error: `dispositions[${i}]: ${String(x.finding)} is not a material finding of round ${round.n} (member/finding, e.g. ${[...known.keys()][0] ?? "none"})` };
    if (seen.has(String(x.finding))) return { error: `dispositions[${i}]: ${String(x.finding)} is listed twice` };
    seen.add(String(x.finding));
    if (!["confirmed", "disproved", "outside-scope", "unresolved"].includes(x.disposition as string)) return { error: `dispositions[${i}].disposition must be confirmed, disproved, outside-scope or unresolved` };
    const ev = typeof x.evidence === "string" ? x.evidence.trim().slice(0, 1000) : "", why = typeof x.rationale === "string" ? x.rationale.trim().slice(0, 1000) : "";
    if (x.disposition === "disproved" && !ev) return { error: `dispositions[${i}]: disproved needs evidence (a file:line, command output or commit that shows the finding is wrong)` };
    if (x.disposition === "outside-scope") {
      if (!why) return { error: `dispositions[${i}]: outside-scope needs a rationale` };
      const hit = [...(f.requirements ?? []), ...(f.acceptance ?? [])].filter((id) => mandatory.has(id));
      if (hit.length) return { error: `dispositions[${i}]: ${String(x.finding)} cites ${hit.join(", ")}, which the package lists as required; a mandatory requirement cannot be relabeled outside scope` };
    }
    out.push({ finding: String(x.finding), disposition: x.disposition as DispositionKind, ...(ev ? { evidence: ev } : {}), ...(why ? { rationale: why } : {}), by, at: now.toISOString() });
  }
  return { dispositions: out };
}
/**
 * The round's state from its members and dispositions. Explicit verdicts decide; scores never do. Unknown evidence never passes. A missing
 * member blocks unless the saved rule is a quorum, which makes the outcome visibly degraded. Every material finding needs a disposition;
 * a confirmed or unresolved one means changes required. Original findings and dissent stay in the record.
 */
export function evaluateRound(snap: CouncilSnapshot, round: Round, gaps: string[] = []): { state: Outcome; reasons: string[]; degraded?: boolean; dissent: string[] } {
  if (round.members.some((m) => !SETTLED.includes(m.state))) return { state: "reviewing", reasons: [`${round.members.filter((m) => SETTLED.includes(m.state)).length} of ${round.members.length} members settled`], dissent: [] };
  const returned = round.members.filter((m) => m.state === "returned" && m.judgment), missing = round.members.filter((m) => !returned.includes(m));
  const dissent = returned.filter((m) => m.judgment!.verdict !== "pass").map((m) => `${m.key}: ${m.judgment!.verdict}`);
  const reasons: string[] = [];
  let degraded: boolean | undefined, missingText = "";
  for (const g of gaps) reasons.push(`package evidence: ${g}`);
  if (missing.length) {
    const why = missing.map((m) => `${m.key} ${m.state}${m.reason ? ` (${m.reason})` : ""}`).join("; ");
    if (snap.passing.unavailable === "quorum" && returned.length >= snap.passing.quorum) { degraded = true; missingText = why; }
    else reasons.push(snap.passing.unavailable === "quorum" ? `only ${returned.length} of the quorum of ${snap.passing.quorum} assessed: ${why}` : `every member must assess (saved rule: block): ${why}`);
  }
  for (const m of returned) {
    const j = m.judgment!;
    if (j.verdict === "unable-to-assess") reasons.push(`${m.key} was unable to assess`);
    const unknown = j.criteria.filter((c) => c.assessment === "unknown").map((c) => c.id);
    if (unknown.length) reasons.push(`${m.key} could not assess ${unknown.join(", ")}`);
    if (j.missingEvidence.length) reasons.push(`${m.key} lacked evidence: ${j.missingEvidence.slice(0, 3).join("; ")}`);
  }
  if (reasons.length) return { state: "unable-to-assess", reasons, degraded, dissent };
  const found = materialFindings(snap, round), disp = new Map(round.dispositions.map((d) => [d.finding, d]));
  const open = found.filter((f) => !disp.has(f.key));
  if (open.length) return { state: "reconciliation", reasons: [`${open.length} material finding${open.length === 1 ? "" : "s"} await the root's disposition: ${open.map((f) => f.key).join(", ")}`], degraded, dissent };
  const blocking = found.filter((f) => ["confirmed", "unresolved"].includes(disp.get(f.key)!.disposition));
  if (blocking.length) return { state: "changes-required", reasons: blocking.map((f) => `${f.key} ${disp.get(f.key)!.disposition}: ${f.finding.text.slice(0, 200)}`), degraded, dissent };
  return { state: "passed", reasons: degraded ? [`degraded: not assessed by ${missingText}`] : [], degraded, dissent };
}
/** Rounds of a checkpoint since its last pass or waiver: the count the saved round limit bounds. */
export function roundsSincePass(run: CouncilRun, checkpoint: Checkpoint): Round[] {
  const rounds = run.rounds.filter((r) => r.checkpoint === checkpoint);
  const last = rounds.findLastIndex((r) => r.outcome?.state === "passed" || r.decision);
  return rounds.slice(last + 1);
}
export const isDecisionRequired = (run: CouncilRun, checkpoint: Checkpoint) => {
  const since = roundsSincePass(run, checkpoint), last = since.at(-1);
  return since.length >= run.snapshot.limits.rounds && !!last?.outcome && ["changes-required", "unable-to-assess"].includes(last.outcome.state);
};
/** Why a reviewed package no longer describes the current state, or undefined. `ancestor` answers git ancestry for the milestone checkpoint. */
export function staleReason(pkg: ReviewPackage, now: PackageContent, snap: CouncilSnapshot, ancestor: (a: string, b: string) => boolean): string | undefined {
  if (pkg.council.hash !== now.council.hash) return "the council configuration changed";
  if (pkg.governance.revision !== now.governance.revision) return "the run's approved configuration changed";
  if (canonical(pkg.spec) !== canonical(now.spec)) return "the specification changed";
  if (canonical(pkg.plan ?? null) !== canonical(now.plan ?? null) && pkg.checkpoint === "plan") return "the plan changed";
  if (pkg.target?.sha !== now.target?.sha) return `the target moved (${pkg.target?.sha.slice(0, 12) ?? "?"} → ${now.target?.sha.slice(0, 12) ?? "?"})`;
  if (pkg.checkpoint === "plan") return undefined;
  if (canonical(pkg.checks?.commands ?? []) !== canonical(now.checks?.commands ?? [])) return "the check commands (the evidence environment) changed";
  const a = pkg.candidate, b = now.candidate;
  if (!a || !b) return "there is no clean candidate to compare";
  if (pkg.checkpoint === "milestone") return a.commit === b.commit || ancestor(a.commit, b.commit) ? undefined : `the reviewed milestone ${a.commit.slice(0, 12)} is not in the candidate ${b.commit.slice(0, 12)}`;
  if (a.commit === b.commit) return undefined;
  // A final commit rewrite: rebound only by the saved same-tree rule, with checks passed at the new commit; otherwise reviewed again.
  if (snap.equivalence === "same-tree" && a.tree === b.tree && now.checks?.status === "complete" && now.checks.revision === b.commit && now.checks.clean === true) return undefined;
  return snap.equivalence === "same-tree" && a.tree === b.tree ? `the candidate commit changed to ${b.commit.slice(0, 12)} with the same tree, but its checks have not passed at it` : `the candidate changed (${a.commit.slice(0, 12)} → ${b.commit.slice(0, 12)})${snap.equivalence === "none" ? "; the saved rule reviews every final commit change" : ""}`;
}
