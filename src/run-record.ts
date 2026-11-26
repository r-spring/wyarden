/**
 * Phase 6 of docs/plans/MASTER-PLAN-capability-profiles-and-orchestration.md (sections 11, 12): one run's retained evidence, the identities
 * that reconstruct it, and its measurements. Pure of VS Code: Board (archive, restore, export), tools/run-export.js and eval/orchestration use it.
 *
 * Authorities stay separate: tasks.json (operational) and the profile/council files (configuration) are never written here; the archive's
 * copied evidence is immutable and hash-checked; an export and its measures are derived and can always be computed again. Unknown is never
 * zero: a reading that is missing is listed with its reason, and usage-window points are kept apart from tokens (another unit).
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { Task } from "./board";
import { type Operation, writeFileAtomic } from "./sessions";
import { outcomeOf } from "./efficiency";
import { taskCost } from "./usage-history";
import { codexHarness } from "./codex";
import { acpHarness } from "./acp";
import { standingJudgePermission } from "./plan";

export const MANIFEST_VERSION = 1;
const REDACTED_ = "[redacted]";
export const EXPORT_VERSION = 1;

// ---- redaction: an export holds hashes, versions and ids, never credentials ----
// Key names whose string values are secrets. "credentials" (a profile's opaque reference names) and token counts (numbers) are kept.
// shortcut: shape-based, so a secret of an unknown shape passes (a Deepgram key is 40 hex, the shape of a git SHA, which an export must keep).
// "[a-z0-9]_key" names (OPENAI_KEY, apiKey) count; a bare "key" (a council member's or an assignment's) does not.
const SECRET_KEY = /token|secret|passw|[a-z0-9][-_]?key$|authorization|cookie|private[-_]?key|access[-_]?key/i;
const SECRET_VALUE: [RegExp, string][] = [[/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED_], [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED_], [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED_],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED_], [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED_], [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED_], [/\bgsk_[A-Za-z0-9]{20,}/g, REDACTED_], [/\bxai-[A-Za-z0-9_-]{20,}/g, REDACTED_],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, REDACTED_], [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED_],
  // URL user info (https://user:pass@host) and NAME=value assignments of secret-named variables keep their names, not their values.
  [/(\/\/)[^\s/:@]+:[^\s/@]+@/g, `$1${REDACTED_}@`], [/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))(\s*=\s*)[^\s"']+/g, `$1$2${REDACTED_}`]];
export const REDACTED = REDACTED_;
/** A deep copy with secret-named string fields and secret-shaped substrings replaced. */
export function redact<T>(v: T, key = ""): T {
  if (typeof v === "string") return (SECRET_KEY.test(key) ? REDACTED : SECRET_VALUE.reduce((s, [re, to]) => s.replace(re, to), v as string)) as T;
  if (Array.isArray(v)) return v.map((x) => redact(x, key)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)])) as T;
  return v;
}

// ---- evidence ----
export type EvidenceKind = "events" | "measurement" | "council-package" | "operation" | "helper-receipt" | "checks" | "transcript";
/** One piece of evidence the run refers to. `copy`: retained in the archive (relative to the archive folder), with its sha256. `gap`: why it is missing. */
export interface Evidence { kind: EvidenceKind; card?: string; path: string; sha256?: string; size?: number; copy?: string; gap?: string }
/** Copied into the archive: board-owned and small. Transcripts and check folders stay where they are and are referenced (size, or a gap). */
const COPIED: EvidenceKind[] = ["events", "measurement", "council-package", "operation", "helper-receipt"];
const sha256 = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
export const within = (dir: string, p: string) => { const r = path.relative(dir, p); return !!r && !r.startsWith("..") && !path.isAbsolute(r); };

/**
 * Everything the run's cards refer to, found or not. `required` evidence that is missing is a gap: a council package or operation the run
 * names, a helper receipt a specification names, the events and measurement of a card that had a session, a transcript the card recorded.
 */
export function evidenceOf(dir: string, cards: Task[], ops: Operation[], eventsFile = (id: string) => path.join(dir, "events", `${id}.jsonl`)): Evidence[] {
  const out: Evidence[] = [], seen = new Set<string>();
  const add = (kind: EvidenceKind, file: string, card: string | undefined, required: boolean) => {
    const p = path.resolve(dir, file);
    if (seen.has(`${kind}\n${p}`)) return;
    seen.add(`${kind}\n${p}`);
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (!st) { if (required) out.push({ kind, card, path: p, gap: `${kind} missing at ${p}` }); return; }
    out.push({ kind, card, path: p, size: st.isFile() ? st.size : undefined });
  };
  const ids = new Set(cards.map((t) => t.id));
  for (const t of cards) {
    add("events", eventsFile(t.id), t.id, !!t.sessionId);
    add("measurement", path.join(dir, "measurements", `${t.id}.json`), t.id, !!t.sessionId);
    for (const r of t.spec?.revisions ?? []) if (r.receipt) add("helper-receipt", r.receipt, t.id, true);
    if (t.doneReview?.receipt) add("helper-receipt", t.doneReview.receipt, t.id, true);
    for (const r of t.governed?.council?.rounds ?? []) add("council-package", r.file, t.id, true);
    if (t.checks?.run) add("checks", t.checks.run, t.id, false);
    if (t.transcript) add("transcript", t.transcript, t.id, true);
  }
  for (const o of ops) if (ids.has(o.run) || ids.has(o.card)) add("operation", path.join(dir, "operations", `${o.id}.json`), o.card, true);
  return out;
}

/** Copies the copyable evidence into the folder `to` and records each copy's sha256 and path relative to `to`; the source is never moved. */
// The source path's hash in the name: two helper receipts of one card are both called compile-receipt.json.
const copyPath = (e: Evidence, to: string) => path.join(to, e.kind, `${e.card ?? "run"}-${sha256(e.path).slice(0, 8)}-${path.basename(e.path)}`);
/** A file's sha256, or a folder's: of each file's relative path and sha256, in sorted order. */
function hashOf(p: string): string {
  if (!fs.statSync(p).isDirectory()) return sha256(fs.readFileSync(p));
  const h = crypto.createHash("sha256");
  for (const f of (fs.readdirSync(p, { recursive: true }) as string[]).sort()) {
    const full = path.join(p, f);
    if (fs.statSync(full).isFile()) h.update(`${f.split(path.sep).join("/")}\0${sha256(fs.readFileSync(full))}\0`);
  }
  return h.digest("hex");
}
export function retain(evidence: Evidence[], to: string): Evidence[] {
  return evidence.map((e) => {
    if (e.gap || !COPIED.includes(e.kind) || e.size === undefined) return e;
    try {
      const bytes = fs.readFileSync(e.path), dest = copyPath(e, to);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
      return { ...e, sha256: sha256(bytes), size: bytes.length, copy: path.relative(to, dest) };
    } catch (err) { return { ...e, gap: `${e.kind} could not be copied: ${(err as NodeJS.ErrnoException).code ?? "error"}` }; }
  });
}

/** A retained copy's path when it is inside the evidence folder and still has its recorded hash; else undefined (a gap, never read). */
export function verifiedCopy(evidenceDir: string, e: Evidence): string | undefined {
  if (!e.copy || e.gap) return undefined;
  const f = path.resolve(evidenceDir, e.copy);
  try { return within(evidenceDir, f) && hashOf(f) === e.sha256 ? f : undefined; } catch { return undefined; }
}
/** Each retained copy (relative to `evidenceDir`) re-read and re-hashed: missing or altered copies are gaps (never silently trusted). */
export function verifyEvidence(evidenceDir: string, evidence: Evidence[]): string[] {
  const gaps: string[] = [];
  for (const e of evidence) {
    if (e.gap) { gaps.push(e.gap); continue; }
    if (!e.copy) continue;
    const file = path.resolve(evidenceDir, e.copy);
    if (!within(evidenceDir, file)) { gaps.push(`${e.kind} copy ${e.copy} is outside the archive`); continue; }
    let hash: string;
    try { hash = hashOf(file); } catch { gaps.push(`${e.kind} copy missing: ${file}`); continue; }
    if (hash !== e.sha256) gaps.push(`${e.kind} copy altered: ${file}`);
  }
  return gaps;
}

/**
 * Before Delete removes `folders` (a card's checks/ and reviews/): every archive manifest (archive/ and archive/restored/) that names a file or
 * folder inside them, not yet copied, gets its own hashed copy in its evidence folder, as retain does. False when a copy failed: keep the folders.
 */
export function keepReferenced(archiveDir: string, folders: string[]): boolean {
  let ok = true;
  for (const dir of [archiveDir, path.join(archiveDir, "restored")]) {
    let files: string[];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      let rec: { manifest?: Manifest };
      try { rec = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; } // not an archive record
      const named = (rec?.manifest?.evidence ?? []).filter((e) => !e.copy && !e.gap && folders.some((d) => d === path.resolve(e.path) || within(d, path.resolve(e.path))) && fs.existsSync(e.path));
      if (!named.length) continue;
      try {
        const to = file.slice(0, -5) + ".evidence";
        for (const e of named) {
          const dest = copyPath(e, to);
          fs.cpSync(e.path, dest, { recursive: true });
          Object.assign(e, { sha256: hashOf(dest), copy: path.relative(to, dest) });
        }
        writeFileAtomic(file, JSON.stringify(rec, null, 2));
      } catch { ok = false; }
    }
  }
  return ok;
}

// ---- identities ----
/**
 * The build that ran a session, by provider: Claude from the ledger catalog (~/.entomatical/ledger/sessions.json), Codex from its rollout's
 * session_meta (codexHarness); Grok and Antigravity record none in their session files (acpHarness says why). `unknown` carries the reason.
 */
export type HarnessOf = (sessionId: string, provider?: string) => { version?: string; entrypoint?: string; unknown?: string } | undefined;
export function ledgerHarness(ledgerDir: string): HarnessOf {
  let cat: Record<string, { version?: string; entrypoint?: string }> = {};
  try { cat = JSON.parse(fs.readFileSync(path.join(ledgerDir, "sessions.json"), "utf8")); } catch { /* no ledger: every harness unknown */ }
  return (s, provider) => provider === "codex" ? codexHarness(s) : provider === "grok" || provider === "antigravity" ? acpHarness(provider) : cat[s];
}

export type Role = "root" | "coordinator" | "worker" | "council" | "judge" | "helper";
export const ROLES: Role[] = ["root", "coordinator", "worker", "council", "judge", "helper"];
/** A card's role in its run: the master; a council member; a legacy standing judge; a card that opened others or may delegate; else a worker. */
export function roleOf(t: Task, root: Task, cards: Task[]): Role {
  if (t.id === root.id) return "root";
  if (t.council) return "council";
  if (t.role === "judge") return "judge";
  if (t.delegation || t.orchestrator || cards.some((c) => c.openedBy === t.id)) return "coordinator";
  return "worker";
}

const profileId = (t: Task) => !t.profile ? { mode: "provider-defaults", recorded: false } : t.profile.mode === "provider-defaults" ? { mode: "provider-defaults", recorded: true }
  : { mode: "strict", ref: `${t.profile.snapshot.id}@${t.profile.snapshot.revision}`, hash: t.profile.snapshot.hash, pinnedAt: t.profile.pinnedAt };

/** The exact identities that reconstruct one card: specification, execution configuration, profile, harness, source revisions and reviews. */
export function identityOf(t: Task, role: Role, harness: HarnessOf) {
  const spec = t.spec, last = spec?.revisions.at(-1), gov = t.governed, h = t.sessionId ? harness(t.sessionId, t.provider ?? "claude") : undefined;
  // In v1, execution.permission is the saved card setting. Derive the managed judge policy separately.
  const judge = t.role === "judge" && t.headless ? standingJudgePermission(t.provider ?? "claude", t.permission) : undefined;
  return {
    id: t.id, title: t.title, role, status: t.status, createdAt: t.createdAt, statusAt: t.statusAt ?? null, openedBy: t.openedBy ?? null, governedBy: t.governedBy ?? null,
    execution: { provider: t.provider ?? "claude", account: t.account ?? null, model: t.model ?? null, effort: t.effort ?? null,
      permission: t.permission ?? null, ...(judge && { effectiveJudgePolicy: judge }),
      headless: !!t.headless, panel: !!t.panel },
    spec: spec ? { specId: spec.specId, version: spec.version, revision: last?.revision ?? null, inputSha256: last?.inputSha256 ?? null, outputSha256: last?.outputSha256 ?? null,
      promptVersion: last?.promptVersion ?? null, rendererVersion: last?.rendererVersion ?? null, requirements: last?.ids.requirements ?? [], acceptance: last?.ids.acceptance ?? [],
      capabilities: spec.execution.capabilities, launches: spec.launches.map((l) => ({ at: l.at, kind: l.kind, revision: l.revision, replay: l.replay, promptSha256: l.promptSha256, drift: l.drift })) } : null,
    profile: profileId(t),
    harness: { provider: t.provider ?? "claude", session: t.sessionId ?? null, cli: h?.version ?? null, entrypoint: h?.entrypoint ?? null,
      ...(t.sessionId && !h?.version ? { unknown: h?.unknown ?? (t.provider ? `${t.provider}: no harness reader for this provider` : "session not in the ledger catalog") } : {}) },
    governance: gov ? { revision: gov.revision, at: gov.at, setBy: gov.setBy, limits: gov.limits, delegation: gov.delegation, target: gov.target ?? null,
      profiles: Object.fromEntries(Object.entries(gov.profiles).map(([ref, sel]) => [ref, sel.mode === "strict" ? sel.snapshot.hash : "provider-defaults"])),
      council: gov.council ? { id: gov.council.snapshot.id, revision: gov.council.snapshot.revision, hash: gov.council.snapshot.hash,
        rounds: gov.council.rounds.map((r) => ({ checkpoint: r.checkpoint, n: r.n, package: r.package, outcome: r.outcome?.state ?? "open", decision: r.decision?.kind ?? null,
          members: r.members.map((m) => ({ key: m.key, provider: m.provider ?? null, model: m.model, state: m.state, card: m.card ?? null, ...(m.reason ? { reason: m.reason } : {}) })) })) } : null } : null,
    source: { branch: t.branch ?? null, submission: t.submission ? { head: t.submission.head, base: t.submission.base, files: t.submission.files, covers: t.submission.covers ?? [] } : null,
      integrated: t.integrated ? { into: t.integrated.into, before: t.integrated.before, after: t.integrated.after, op: t.integrated.op } : null,
      checks: t.checks ? { status: t.checks.status, revision: t.checks.revision ?? null, clean: t.checks.clean ?? null } : null,
      delivery: t.delivery?.sha ?? null, merged: !!t.merged },
    review: { council: t.council ?? null, judgedRevision: t.judgedRevision ?? null, judged: t.judged ?? null, doneReview: t.doneReview ? { verdict: t.doneReview.verdict ?? null, model: t.doneReview.model, receipt: t.doneReview.receipt } : null },
  };
}

// ---- measurements ----
export interface Tokens { input: number; cacheRead: number; cacheWrite: number; output: number }
/** A saved measurement snapshot (metrics.ts persist, measurements/<card>.json). */
export interface Snapshot { tokens: Tokens; total?: number; complete: boolean; source: string; gaps?: string[] }
export interface RoleMeasure {
  /** Sessions in this role (cards that ran a model, or helper attempts). */
  sessions: number;
  /** Complete token totals; partial = a lower bound (some source was missing); unknown = no reading, with its reason. */
  measured: number; partial: number; unknown: { card: string; reason: string }[];
  /** Cards in this role that never ran a session (a checks-only plan card, a council member that was unavailable has no card). Not zero tokens: no reading applies. */
  noSession: string[];
  /** Sum of the measured and partial readings; null when nothing was measured (never 0 for "unknown"). */
  tokens: Tokens | null; total: number | null;
  /** Percentage points each usage window moved while the cards ran: the account's window, other sessions on it included. Not tokens. */
  points: Record<string, number>; pointsUnknown: string[];
}
const blank = (): RoleMeasure => ({ sessions: 0, measured: 0, partial: 0, unknown: [], noSession: [], tokens: null, total: null, points: {}, pointsUnknown: [] });
const addTokens = (m: RoleMeasure, t: Tokens, total?: number) => {
  m.tokens ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const k of ["input", "cacheRead", "cacheWrite", "output"] as const) m.tokens[k] += t[k];
  m.total = (m.total ?? 0) + (total ?? t.input + t.cacheRead + t.cacheWrite + t.output);
};
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
/** A helper attempt's provider-reported usage, Claude's or Codex's shape (codex.ts usageOf: Codex's input includes its cached input). */
export function helperTokens(u: any): Tokens | undefined {
  const input = num(u?.input_tokens), output = num(u?.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  if (u.cached_input_tokens !== undefined) { const cached = num(u.cached_input_tokens) ?? 0; return { input: Math.max(0, input - cached), cacheRead: cached, cacheWrite: num(u.cache_write_input_tokens) ?? 0, output }; }
  return { input, cacheRead: num(u.cache_read_input_tokens) ?? 0, cacheWrite: num(u.cache_creation_input_tokens) ?? 0, output };
}

export type CardOutcome = "accepted" | "failed" | "unverified" | "open" | "review";
/**
 * What happened to a card's work. Governed: a child is accepted only with an integration receipt, the root only with a committed target
 * operation (phase 4); legacy: the board's existing outcome (checks passed or a Done review said done). Turning Done alone is unverified.
 */
export function cardOutcome(t: Task, ops: Operation[]): { outcome: CardOutcome; basis: string } {
  if (t.discarded || t.cancelled || t.launchError) return { outcome: "failed", basis: t.discarded ? "discarded" : t.cancelled ? "cancelled" : "launch failed" };
  if (t.council || t.role === "judge") return { outcome: "review", basis: t.council ? `council member ${t.council.member}: a judgment, not work` : "standing judge: a verdict, not work" };
  if (t.status !== "done") return { outcome: "open", basis: `status ${t.status}` };
  if (t.checks?.status === "error") return { outcome: "failed", basis: "checks failed" };
  if (t.governed) { const op = ops.find((o) => o.kind === "target" && o.card === t.id && o.state === "committed"); return op ? { outcome: "accepted", basis: `target operation ${op.id}` } : { outcome: "unverified", basis: "governed root without a committed target operation" }; }
  if (t.governedBy) return t.integrated ? { outcome: "accepted", basis: `integrated into ${t.integrated.into} (${t.integrated.op})` } : { outcome: "unverified", basis: "governed card without an integration receipt" };
  const o = outcomeOf(t);
  return o === "passed" ? { outcome: "accepted", basis: t.checks?.status === "complete" ? "checks passed" : "Done review: done" } : { outcome: o === "failed" ? "failed" : "unverified", basis: o === "failed" ? "failed" : "Done without checks or review" };
}

export interface HelperReceipt { file: string; card?: string; kind?: string; attempts: { provider?: string; model?: string; outcome?: string; usage?: unknown }[] }

/** Every measurement section 12 asks for, per role and for the run; inputs are read-only and nothing is written. */
export function measureRun(root: Task, cards: Task[], o: { snapshot: (t: Task) => Snapshot | undefined; ops: Operation[]; helpers: HelperReceipt[]; gaps: string[] }) {
  const roles = Object.fromEntries(ROLES.map((r) => [r, blank()])) as Record<Role, RoleMeasure>;
  const card: { id: string; role: Role; outcome: CardOutcome; basis: string; tokens: number | null; reading: string }[] = [];
  for (const t of cards) {
    const role = roleOf(t, root, cards), m = roles[role], oc = cardOutcome(t, o.ops);
    let reading: string, tokens: number | null = null;
    if (!t.sessionId) { m.noSession.push(t.id); reading = "no session"; }
    else {
      m.sessions++;
      const s = o.snapshot(t);
      if (!s) { m.unknown.push({ card: t.id, reason: "no measurement snapshot" }); reading = "unknown: no measurement snapshot"; }
      else if (s.source === "unknown") { const why = s.gaps?.[0] ?? "no measurable source"; m.unknown.push({ card: t.id, reason: why }); reading = `unknown: ${why}`; }
      else { addTokens(m, s.tokens, s.total); tokens = s.total ?? s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite + s.tokens.output; if (s.complete) { m.measured++; reading = s.source; } else { m.partial++; reading = `partial (${s.source}, a lower bound)`; } }
    }
    // Keyed by account and window: windows of different accounts are different quantities. Concurrent cards on one account each see the
    // shared window move, so a sum over them is an upper bound (measuresText says so).
    let usable = false;
    for (const w of taskCost(t.usageRuns)?.windows ?? []) {
      if (typeof w.points === "number" && !w.reset && !w.incomplete) { const k = `${t.account ?? "default account"} · ${w.name}`; m.points[k] = Math.round(((m.points[k] ?? 0) + w.points) * 10) / 10; usable = true; }
      else if (!m.pointsUnknown.includes(t.id)) m.pointsUnknown.push(t.id);
    }
    if (!usable && t.sessionId && !m.pointsUnknown.includes(t.id)) m.pointsUnknown.push(t.id);
    card.push({ id: t.id, role, ...oc, tokens, reading });
  }
  for (const h of o.helpers) for (const [i, a] of h.attempts.entries()) {
    const m = roles.helper, who = `${h.kind ?? "helper"} ${path.basename(h.file)}#${i + 1}${h.card ? ` (${h.card})` : ""}`, t = helperTokens(a.usage);
    m.sessions++;
    if (t) { addTokens(m, t); m.measured++; } else m.unknown.push({ card: who, reason: a.usage === undefined || a.usage === null ? "usage not reported" : "usage in an unknown shape" });
  }
  const total = blank();
  for (const m of Object.values(roles)) {
    total.sessions += m.sessions; total.measured += m.measured; total.partial += m.partial; total.unknown.push(...m.unknown); total.noSession.push(...m.noSession); total.pointsUnknown.push(...m.pointsUnknown);
    if (m.tokens) addTokens(total, m.tokens, m.total ?? undefined);
    for (const [k, v] of Object.entries(m.points)) total.points[k] = Math.round(((total.points[k] ?? 0) + v) * 10) / 10;
  }
  // Requirement coverage: the root's accepted specification against what accepted children's submissions say they cover.
  const ids = root.spec?.revisions.at(-1)?.ids, accepted = new Set(card.filter((c) => c.outcome === "accepted").map((c) => c.id));
  const covered = new Set<string>(), claimed = new Set<string>();
  for (const t of cards) for (const id of t.submission?.covers ?? []) (accepted.has(t.id) ? covered : claimed).add(id);
  const all = ids ? [...ids.requirements, ...ids.acceptance] : [];
  const requirements = ids && !cards.some((t) => t.submission) ? { unknown: "no card handed in a submission naming what it covers (legacy or plan run), so coverage was not recorded" } : ids ? { total: all.length, covered: all.filter((x) => covered.has(x)), claimedNotAccepted: all.filter((x) => claimed.has(x) && !covered.has(x)), uncovered: all.filter((x) => !covered.has(x)) }
    : { unknown: "the root has no accepted specification (raw prompt), so coverage cannot be computed" };
  const rounds = root.governed?.council?.rounds ?? [];
  const integrate = o.ops.filter((x) => x.kind === "integrate"), target = o.ops.filter((x) => x.kind === "target");
  const rootOutcome = card.find((c) => c.id === root.id)!;
  const acceptedAt = rootOutcome.outcome !== "accepted" ? undefined : root.governed ? target.find((x) => x.state === "committed" && x.card === root.id)?.updated : root.statusAt;
  const ms = acceptedAt ? Date.parse(acceptedAt) - Date.parse(root.createdAt) : NaN;
  return {
    v: 1, roles, total, cards: card,
    coverage: { sessions: total.sessions, measured: total.measured, partial: total.partial, unknown: total.unknown.length, text: `${total.measured} of ${total.sessions} sessions measured completely, ${total.partial} partial, ${total.unknown.length} unknown` },
    outcomes: { root: rootOutcome.outcome, basis: rootOutcome.basis, accepted: card.filter((c) => c.outcome === "accepted").length, failed: card.filter((c) => c.outcome === "failed").length,
      unverified: card.filter((c) => c.outcome === "unverified").length, open: card.filter((c) => c.outcome === "open").length, reviews: card.filter((c) => c.outcome === "review").length },
    requirements,
    reassignments: { transfers: cards.reduce((n, t) => n + (t.transfers?.length ?? 0), 0), accountSwitches: cards.filter((t) => t.switchedTo).length },
    rework: { followUps: cards.reduce((n, t) => n + (t.followUps ?? 0), 0), autoRounds: cards.reduce((n, t) => n + (t.autoRounds ?? 0) + (t.mergeRetries ?? 0), 0),
      councilRounds: rounds.length, councilNotPassed: rounds.filter((r) => r.outcome && r.outcome.state !== "passed").length },
    integration: { attempts: integrate.length, conflicts: integrate.filter((x) => x.result?.outcome === "conflict").length,
      uncertain: o.ops.filter((x) => x.state === "uncertain").length, abandoned: o.ops.filter((x) => x.state === "abandoned").length, targetEffects: target.filter((x) => x.state === "committed").length },
    time: Number.isFinite(ms) ? { toAcceptedMs: ms, unknown: undefined } : { toAcceptedMs: undefined, unknown: rootOutcome.outcome === "accepted" ? "no acceptance time recorded" : `the run has no accepted result (${rootOutcome.basis})` },
    evidenceGaps: o.gaps,
    unavailable: [...total.unknown.map((u) => `tokens of ${u.card}: ${u.reason}`), ...total.pointsUnknown.map((id) => `usage points of ${id}: no comparable reading`),
      ...rounds.flatMap((r) => r.members.filter((m) => m.state === "unavailable").map((m) => `council ${r.checkpoint} round ${r.n} member ${m.key}: ${m.reason ?? "unavailable"}`))],
  };
}
export type RunMeasures = ReturnType<typeof measureRun>;

// ---- manifest and export ----
/** `tasksSha256`: of the archived card records as written (JSON.stringify), so an edited record is a gap at Restore and Export. */
export interface Manifest { v: typeof MANIFEST_VERSION; root: string; at: string; cards: string[]; tasksSha256?: string; evidence: Evidence[]; gaps: string[] }
export const manifestOf = (root: Task, cards: Task[], evidence: Evidence[], at: string): Manifest =>
  ({ v: MANIFEST_VERSION, root: root.id, at, cards: cards.map((t) => t.id), tasksSha256: sha256(JSON.stringify(cards)), evidence, gaps: evidence.filter((e) => e.gap).map((e) => e.gap!) });
/** Gaps of an archive record: its retained copies, and its card records against the hash taken when it was archived. */
export function recordGaps(evidenceDir: string, rec: { tasks: Task[]; manifest?: Manifest }): string[] {
  const m = rec.manifest!;
  return [...verifyEvidence(evidenceDir, m.evidence), ...(m.tasksSha256 && sha256(JSON.stringify(rec.tasks)) !== m.tasksSha256 ? ["the card records were edited after archiving (their hash differs from the manifest)"] : [])];
}

/** Where to read a piece of evidence: from an archive only its retained copy inside the evidence folder (an edited manifest names no other file); live, its own path. */
const source = (e: Evidence | undefined, evidenceDir?: string) => {
  if (!evidenceDir) return e!.path;
  const f = e && verifiedCopy(evidenceDir, e);
  if (!f) throw new Error("no verified copy");
  return f;
};
/** Reads the helper receipts the evidence lists, preferring the archive's verified copy. Unreadable ones are skipped (their gap is already listed). */
export function helperReceipts(evidence: Evidence[], evidenceDir?: string): HelperReceipt[] {
  return evidence.filter((e) => e.kind === "helper-receipt" && !e.gap).flatMap((e) => {
    try {
      const r = JSON.parse(fs.readFileSync(source(e, evidenceDir), "utf8"));
      return [{ file: e.path, card: e.card, kind: typeof r.kind === "string" ? r.kind : undefined, attempts: Array.isArray(r.attempts) ? r.attempts : [] }];
    } catch { return []; }
  });
}

/**
 * The run's export: its identities, the manifest, the measurements and the redacted cards, from an archive record (or the board's live
 * cards). A legacy archive (no manifest) exports with its evidence marked not inventoried. `evidenceDir` resolves the retained copies.
 */
export function exportRun(dir: string, rec: { master: string; title?: string; archivedAt?: string; plan?: string; tasks: Task[]; manifest?: Manifest }, o: { evidenceDir?: string; ops?: Operation[]; harness?: HarnessOf; now?: Date; extension?: string } = {}) {
  const root = rec.tasks.find((t) => t.id === rec.master);
  if (!root) throw new Error(`The run's master card ${rec.master} is not in the record.`);
  const legacy = !rec.manifest;
  const ops = o.ops ?? (rec.manifest ? readOps(rec.manifest, o.evidenceDir) : []);
  const evidence = rec.manifest?.evidence ?? evidenceOf(dir, rec.tasks, ops);
  const gaps = rec.manifest ? (o.evidenceDir ? recordGaps(o.evidenceDir, rec) : rec.manifest.gaps)
    : rec.archivedAt ? ["archived before phase 6 (legacy): evidence was not inventoried or retained; live files are listed where they still exist", ...evidence.filter((e) => e.gap).map((e) => e.gap!)]
      : evidence.filter((e) => e.gap).map((e) => e.gap!);
  const copyOf = (kind: EvidenceKind, id: string) => evidence.find((e) => e.kind === kind && e.card === id && !e.gap);
  const snapshot = (t: Task): Snapshot | undefined => {
    const e = copyOf("measurement", t.id);
    try { return JSON.parse(fs.readFileSync(rec.manifest && o.evidenceDir ? source(e, o.evidenceDir) : path.join(dir, "measurements", `${t.id}.json`), "utf8")); } catch { return undefined; }
  };
  const harness = o.harness ?? (() => undefined);
  return redact({
    v: EXPORT_VERSION, exportedAt: (o.now ?? new Date()).toISOString(), exportedBy: o.extension ?? null,
    run: { root: root.id, title: rec.title ?? root.title, archivedAt: rec.archivedAt ?? null, plan: rec.plan ?? null, legacy, governed: !!root.governed },
    identities: rec.tasks.map((t) => identityOf(t, roleOf(t, root, rec.tasks), harness)),
    manifest: rec.manifest ?? null,
    measures: measureRun(root, rec.tasks, { snapshot, ops, helpers: helperReceipts(evidence, o.evidenceDir), gaps }),
    operations: ops.map((x) => ({ id: x.id, kind: x.kind, card: x.card, state: x.state, pre: x.pre, result: x.result ?? null, authorization: x.authorization ?? null, cleanup: x.cleanup ?? null })),
    cards: rec.tasks,
  });
}

/** The run's operation records as retained in the archive (verified copy), else from their original place. */
export function readOps(m: Manifest, evidenceDir?: string): Operation[] {
  return m.evidence.filter((e) => e.kind === "operation" && !e.gap).flatMap((e) => {
    try { return [JSON.parse(fs.readFileSync(source(e, evidenceDir), "utf8"))]; } catch { return []; }
  });
}

/** The measurements as Markdown lines (the archived run's report and tools/run-export.js --text): unknown stays "unknown", never 0. */
export function measuresText(m: RunMeasures): string[] {
  const tok = (r: RoleMeasure) => !r.sessions ? "none (no session)" : r.total === null ? "unknown" : `${r.total.toLocaleString("en")}${r.partial || r.unknown.length ? " (lower bound)" : ""}`;
  const pts = (r: RoleMeasure) => (Object.entries(r.points).map(([k, v]) => `${k} ${v} pp`).join(", ") || (r.pointsUnknown.length ? "unknown" : "none")) + (Object.keys(r.points).length && r.pointsUnknown.length ? ` (${r.pointsUnknown.length} card(s) unknown)` : "");
  const req = "unknown" in m.requirements ? `unknown (${m.requirements.unknown})` : `${m.requirements.covered.length} of ${m.requirements.total} covered by accepted work${m.requirements.uncovered.length ? `; uncovered: ${m.requirements.uncovered.join(", ")}` : ""}`;
  return [`Outcome: ${m.outcomes.root} (${m.outcomes.basis}); cards accepted ${m.outcomes.accepted}, failed ${m.outcomes.failed}, unverified ${m.outcomes.unverified}, open ${m.outcomes.open}, review cards ${m.outcomes.reviews}`,
    `Requirements: ${req}`, `Time to accepted result: ${m.time.toAcceptedMs !== undefined ? `${Math.round(m.time.toAcceptedMs / 60000)} min` : `unknown (${m.time.unknown})`}`,
    `Measurement coverage: ${m.coverage.text}`, `Rework: ${m.rework.followUps} follow-ups, ${m.rework.autoRounds} automatic rounds, ${m.rework.councilRounds} council rounds (${m.rework.councilNotPassed} not passed); reassignments: ${m.reassignments.transfers} transfers, ${m.reassignments.accountSwitches} account switches`,
    `Integration: ${m.integration.attempts} attempts, ${m.integration.conflicts} conflicts, ${m.integration.uncertain} uncertain, ${m.integration.abandoned} abandoned; target effects ${m.integration.targetEffects}`,
    "", "| Role | Sessions | Complete | Partial | Unknown | No session | Tokens | Usage window (not tokens) |", "|---|---|---|---|---|---|---|---|",
    ...ROLES.map((r) => { const x = m.roles[r]; return `| ${r} | ${x.sessions} | ${x.measured} | ${x.partial} | ${x.unknown.length} | ${x.noSession.length} | ${tok(x)} | ${pts(x)} |`; }),
    `| total | ${m.total.sessions} | ${m.total.measured} | ${m.total.partial} | ${m.total.unknown.length} | ${m.total.noSession.length} | ${tok(m.total)} | ${pts(m.total)} |`,
    "Usage-window points are each account's window movement while the cards ran (other sessions on the account included); cards running at the same time on one account each count the same movement, so sums are upper bounds.",
    "", `Evidence gaps: ${m.evidenceGaps.length ? "" : "none"}`, ...m.evidenceGaps.map((g) => `- ${g}`), "", `Unavailable readings: ${m.unavailable.length ? "" : "none"}`, ...m.unavailable.map((u) => `- ${u}`)];
}
