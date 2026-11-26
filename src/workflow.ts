// The workflow scheduler: dependency records, resource claims, run attempts and receipts for steps of a plan (the user, 3 November 2026,
// for the example workflow). Pure of VS Code so tests drive it with fake executors. Storage is <repo>/.entomatical/workflow/, one per
// repository across its worktrees and windows: a claim is a file created exclusively (wx), so two windows cannot hold the same slot.
// The board's owner heartbeat (sessions.ts claimOwner) orders ordinary board writes only; it is not the resource lock.
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readJson, saveJson } from "./jobs";

/** The step's outcome, separate from its card's conversation status: Review, a gone session or Mark done never make it accepted. */
export type Outcome = "pending" | "accepted" | "held" | "blocked" | "deferred" | "not-applicable" | "failed" | "cancelled" | "unknown";
export const OUTCOMES: Outcome[] = ["pending", "accepted", "held", "blocked", "deferred", "not-applicable", "failed", "cancelled", "unknown"];

/** The exact scope an operation is authorized for. A different scope (hash) is different work and needs its own review. */
export interface Scope { operations: string[]; sources: string[]; destinations: string[]; toolVersion: string; bounds: string; expires?: string;
  binding?: { manifest: string; step: string; candidate: string; evidence: Record<string, string> } }

export interface Step {
  /** What the step holds while it runs: local (the session budget), external-worker, auth-prompt, catalog-writer, repair, selection:<store>:<source_id>; cloud and vm have no capacity. */
  resources: string[];
  /** Operations carry their authorized scope; preparation steps have none. */
  scope?: Scope;
  /** Host admissions that must be current at dispatch (ssh, rclone, catalog, drive): records with an expiry and the boot they were made in. */
  admission?: string[];
  /** The unresolved decision that blocks the step. */
  blocker?: string;
  refs?: { inputs?: string[]; tools?: string[]; outputs?: string[] };
  /** Evidence the accepted receipt confirms before dependents release. */
  checks?: string[];
  /** A closure step: its dependencies are satisfied by any terminal outcome (success, hold or failure), not only accepted. */
  closure?: boolean;
  /** Dispatch order, lowest first; the plan keeps USB analysis ahead of retention investigation. */
  priority?: number;
  outcome: Outcome;
  /** The latest attempt; it stays until Record result settles it. */
  attempt?: string;
  /** The accepted receipt, which is what dependents name. Record result may re-judge a held, failed or cancelled attempt. */
  receipt?: string;
  /** v2 plans require a receipt pinned to the submitted commit and artifact contents. */
  evidenceRequired?: boolean;
}

/** The part of a board card the scheduler reads. dependsOn controls execution; parentId (grouping) does not. */
export interface StepTask { id: string; title: string; createdAt: string; dependsOn?: string[]; workflow?: Step }

export interface Attempt {
  id: string; task: string; title: string;
  state: "launching" | "running" | "ended";
  startedAt: string; endedAt?: string;
  resources: string[]; scope?: Scope; scopeHash?: string;
  /** Required access/admission names fixed at dispatch, rechecked at each execution phase. */
  admission?: string[];
  /** Tool and input references fixed at dispatch: a running batch keeps its versions while development makes new ones. */
  refs?: Step["refs"];
  /** Progress the bounded runner reports (Uploading, Verifying, Cleaning up). */
  phase?: string;
  outcome?: Outcome; reason?: string;
  window: number;
  owner?: string;
  /** The dispatching board's workspace. Its tasks.json can be in a different worktree from the shared workflow store. */
  boardRoot?: string;
}
export interface RunReceipt {
  attempt: string; task: string; outcome: Exclude<Outcome, "pending" | "unknown">;
  inputs: string[]; tools: string[]; artifacts: Record<string, string>; checks: string[]; limitations: string; at: string;
  revision?: string; evidence?: Record<string, string>;
}
export interface Claim { resource: string; slot: number; attempt: string; task: string; window: number; at: string }
export interface Approval { scopeHash: string; scope: Scope; at: string; touches: number; used: string[] }
export interface Admission { name: string; at: number; expires: number; bootTime: number }

export const RESOURCES = ["local", "external-worker", "auth-prompt", "catalog-writer", "repair", "cloud", "vm"];
export const resourceOk = (r: string) => RESOURCES.includes(r) || /^selection:[^:]+:.+$/.test(r) || /^named:[a-z0-9][a-z0-9-]{0,79}$/.test(r);
export const capacity = (resource: string, localBudget: number) => resource === "local" ? localBudget : resource === "cloud" || resource === "vm" || !resourceOk(resource) ? 0 : 1;
const WAIT: Record<string, string> = { "external-worker": "Waiting for external worker", "catalog-writer": "Waiting for writer", "auth-prompt": "Waiting for the authentication slot", repair: "Waiting for the repair slot" };
export const waitText = (resource: string) => WAIT[resource] ?? (resource.startsWith("selection:") ? `Waiting for selection ${resource.slice(10)}` : `Waiting for ${resource}`);
/** Steps with an owner prompt run in a terminal the owner can answer, never through an unattended first turn. */
export const interactive = (step: Step | undefined) => !!step && (step.resources.includes("auth-prompt") || !!step.admission?.length);
export const scopeHash = (s: Scope) => crypto.createHash("sha256").update(JSON.stringify([s.operations, s.sources, s.destinations, s.toolVersion, s.bounds, ...(s.binding ? [s.binding] : [])])).digest("hex").slice(0, s.binding ? 64 : 12);
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
export const bootTime = () => Date.now() - os.uptime() * 1000;

export class WorkflowStore {
  constructor(readonly dir: string) {}
  private file(kind: string, id: string) { return path.join(this.dir, kind, `${safe(id)}.json`); }
  private read<T>(kind: string, id: string): T | undefined { try { return readJson<T>(this.file(kind, id)); } catch { return undefined; } }
  private list<T>(kind: string): T[] {
    const dir = path.join(this.dir, kind);
    if (!fs.existsSync(dir)) return [];
    // The runner's active-phase mutex is metadata beside attempt records, not an attempt snapshot.
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !(kind === "attempts" && f.endsWith(".active-phase.json"))).flatMap((f) => { try { return [readJson<T>(path.join(dir, f))]; } catch { return []; } });
  }
  attempt(id: string) { return this.read<Attempt>("attempts", id); }
  saveAttempt(a: Attempt) { saveJson(this.file("attempts", a.id), a); }
  attempts() { return this.list<Attempt>("attempts"); }
  receipt(id: string) { return this.read<RunReceipt>("receipts", id); }
  saveReceipt(r: RunReceipt) { saveJson(this.file("receipts", r.attempt), r); }
  approval(scope: Scope) { return this.read<Approval>("approvals", scopeHash(scope)); }
  approve(scope: Scope, touches = 1) { const a: Approval = { scopeHash: scopeHash(scope), scope, at: new Date().toISOString(), touches, used: [] }; saveJson(this.file("approvals", a.scopeHash), a); return a; }
  /** Whether the named admission is current: unexpired and recorded in this boot. */
  admitted(name: string, now = Date.now(), boot = bootTime()) {
    const a = this.read<Admission>("admission", name);
    return !!a && a.expires > now && Math.abs(a.bootTime - boot) < 120_000;
  }
  admit(name: string, ttlMs: number, now = Date.now(), boot = bootTime()) { saveJson(this.file("admission", name), { name, at: now, expires: now + ttlMs, bootTime: boot } satisfies Admission); }
  claims(): Claim[] {
    const dir = path.join(this.dir, "claims");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).flatMap((r) => this.list<Claim>(path.join("claims", r)));
  }
  /** Takes one free slot of a compatible resource. Exclusive file creation makes it atomic across windows. */
  claim(resource: string, slots: number, attempt: Attempt): boolean {
    if (!resourceOk(resource) || resourceProblem([], this)) return false;
    const dir = path.join(this.dir, "claims", safe(resource));
    fs.mkdirSync(dir, { recursive: true });
    for (let slot = 0; slot < slots; slot++) {
      const c: Claim = { resource, slot, attempt: attempt.id, task: attempt.task, window: attempt.window, at: new Date().toISOString() };
      const file = path.join(dir, `${slot}.json`);
      try { fs.writeFileSync(file, JSON.stringify(c), { flag: "wx" }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") continue; throw e; }
      // A reduced budget can leave a higher numbered local slot occupied while a lower one is free.
      if (resource === "local" && fs.readdirSync(dir).filter(name => name.endsWith(".json")).length > slots) {
        fs.unlinkSync(file);
        return false;
      }
      return true;
    }
    return false;
  }
  /** Releases the attempt's claims (all, or one resource's). */
  release(attempt: string, resource?: string) {
    for (const c of this.claims()) if (c.attempt === attempt && (!resource || c.resource === resource)) fs.rmSync(path.join(this.dir, "claims", safe(c.resource), `${c.slot}.json`), { force: true });
  }
}

export interface Readiness { state: "ready" | "dependency" | "resource" | "blocked" | "attempt" | "closed"; text: string }
export interface Context { localBudget: number; now?: number; owner?: string; boardRoot?: string; verifyReceipt?: (task: StepTask, receipt: RunReceipt) => string | undefined }

/** Keep incompatible state readable for reconciliation, but never schedule or continue through an unknown resource namespace. */
export function resourceProblem(tasks: StepTask[], store: WorkflowStore): string | undefined {
  const valid = (resources: unknown) => Array.isArray(resources) && resources.every((r) => typeof r === "string" && resourceOk(r));
  if (tasks.some((t) => t.workflow && !valid(t.workflow.resources)) ||
      store.attempts().some((a) => !valid(a.resources)) ||
      store.claims().some((c) => typeof c.resource !== "string" || !resourceOk(c.resource)))
    return "Workflow resources require explicit reconciliation: unknown or retired resource in stored tasks, attempts or claims";
}

const depText = (t: StepTask) => `${t.title}${t.workflow?.receipt ? ` (receipt ${t.workflow.receipt})` : ""}`;
const terminal = (o: Outcome) => !["pending", "unknown"].includes(o);

function authorizationProblem(scope: Scope, now: number): string | undefined {
  if (!scope.expires) return;
  const expires = Date.parse(scope.expires);
  if (!Number.isFinite(expires)) return "Authorization expiry is invalid; awaiting scope review";
  if (expires <= now) return "Authorization expired; awaiting scope review";
}

function sameScope(current: Scope | undefined, recorded: Scope | undefined, pin: string | undefined): boolean {
  return (current && scopeHash(current)) === pin && (recorded && scopeHash(recorded)) === pin && current?.expires === recorded?.expires;
}

function referenceProblem(current: Step["refs"], dispatched: Step["refs"]): string | undefined {
  if ((["inputs", "tools", "outputs"] as const).some((key) => JSON.stringify(current?.[key] ?? []) !== JSON.stringify(dispatched?.[key] ?? [])))
    return "Input, tool or output references changed since dispatch; awaiting scope review";
}

/** Why a step cannot be dispatched now, or Ready. Dependency waits (I need this result) and resource waits (ready, but held) are told apart. */
export function readiness(task: StepTask, tasks: StepTask[], store: WorkflowStore, ctx: Context): Readiness {
  const s = task.workflow;
  if (!s) return { state: "ready", text: "Ready" };
  const resources = resourceProblem([task, ...tasks], store);
  if (resources) return { state: "blocked", text: resources };
  const now = ctx.now ?? Date.now();
  if (s.outcome === "accepted") return { state: "closed", text: `Accepted · receipt ${s.receipt}` };
  // A hold stays until the owner re-judges the attempt with Record result; failed and cancelled fall through to the gates (a scoped
  // step's spent touch stops it there).
  if (s.outcome === "held") return { state: "closed", text: `Held (attempt ${s.attempt}): ${store.receipt(s.attempt!)?.limitations || "no reason given"}` };
  if (["blocked", "deferred", "not-applicable"].includes(s.outcome)) return { state: "closed", text: `${s.outcome}: ${store.receipt(s.attempt!)?.limitations || "awaiting a new decision"}` };
  const a = s.attempt ? store.attempt(s.attempt) : undefined;
  if (a && !terminal(s.outcome)) {
    if (s.outcome === "unknown") return { state: "attempt", text: `Interrupted: attempt ${a.id} has no result yet (${a.reason ?? "no acknowledgement"}). Record its result` };
    if (a.state === "launching") return { state: "attempt", text: "Starting" };
    if (a.state === "running") return { state: "attempt", text: `Running${a.phase ? ` · ${a.phase}` : ""}` };
    return { state: "attempt", text: `Session ended: Record its result (attempt ${a.id})` };
  }
  if (a && store.claims().some((c) => c.attempt === a.id)) return { state: "attempt", text: `${s.outcome[0].toUpperCase()}${s.outcome.slice(1)} (attempt ${a.id}) still holds resources: Record its result` };
  if (s.blocker) return { state: "blocked", text: `Awaiting resolution of ${s.blocker}` };
  for (const id of task.dependsOn ?? []) {
    const d = tasks.find((t) => t.id === id);
    if (!d) return { state: "dependency", text: `Needs missing step ${id}` };
    const o = d.workflow?.outcome ?? "pending";
    if (s.closure ? !terminal(o) : o !== "accepted") return { state: "dependency", text: s.closure ? `Needs ${d.title} to end` : `Needs accepted result of ${depText(d)}` };
    if ((s.evidenceRequired || d.workflow?.evidenceRequired) && !s.closure) {
      const receipt = d.workflow?.receipt && store.receipt(d.workflow.receipt);
      const why = !receipt || receipt.outcome !== "accepted" || !receipt.revision || !receipt.evidence || !ctx.verifyReceipt ? "Missing verified evidence receipt" : ctx.verifyReceipt(d, receipt);
      if (why) return { state: "dependency", text: `${d.title}: ${why}` };
    }
  }
  if (s.scope) {
    const why = authorizationProblem(s.scope, now);
    if (why) return { state: "blocked", text: why };
    const ap = store.approval(s.scope);
    if (!ap) return { state: "blocked", text: `Awaiting scope review (${scopeHash(s.scope)})` };
    if (!sameScope(s.scope, ap.scope, ap.scopeHash)) return { state: "blocked", text: "Scope changed since approval; awaiting scope review" };
    if (ap.used.length >= ap.touches) return { state: "blocked", text: `Touch budget spent (${ap.used.length} of ${ap.touches}, attempt ${ap.used.at(-1)}); no retry. Awaiting scope review` };
  }
  for (const name of s.admission ?? []) if (!store.admitted(name, now)) return { state: "blocked", text: `Needs current ${name} admission` };
  const claims = store.claims();
  for (const r of s.resources) {
    const cap = capacity(r, ctx.localBudget);
    if (cap === 0) return { state: "blocked", text: `${r} compute is unavailable under current recovery policy` };
    const held = claims.filter((c) => c.resource === r).length;
    if (held >= cap) return { state: "resource", text: r === "local" ? `Waiting for a local session slot (${held} of ${cap} in use)` : waitText(r) };
  }
  return { state: "ready", text: "Ready" };
}

/** Checks a live attempt again at its execution boundary: its claims, approval, admissions and dependencies must still hold. */
export function validateAttempt(task: StepTask, tasks: StepTask[], store: WorkflowStore, ctx: Context): string | undefined {
  const resources = resourceProblem([task, ...tasks], store);
  if (resources) return resources;
  const s = task.workflow, a = s?.attempt ? store.attempt(s.attempt) : undefined;
  if (!s || !a) return "No attempt to continue";
  if (s.evidenceRequired && a.owner !== ctx.owner) return "An earlier board owner dispatched this attempt. Reconcile and record its result before a new dispatch; no replay.";
  if (a.scope?.binding && a.state === "ended") return "This operator-gated dispatch has ended; record its result. A new attempt needs a new approval; no replay.";
  const outcome = s.outcome === "pending" ? a.outcome ?? s.outcome : s.outcome;
  if (outcome !== "pending") return `Attempt ${a.id} is ${outcome}: Record its result; no retry`;
  if (!sameScope(s.scope, a.scope, a.scopeHash))
    return "Scope changed since dispatch; awaiting scope review";
  if (a.scope) {
    const ap = store.approval(a.scope);
    if (!ap || ap.scopeHash !== a.scopeHash || !sameScope(a.scope, ap.scope, a.scopeHash)) return "Scope is not approved for this attempt; awaiting scope review";
    // Its touch must be one this approval granted: a re-approval starts a new budget that this attempt did not spend.
    const touch = ap.used.indexOf(a.id);
    if (touch < 0 || touch >= ap.touches) return `Scope is not approved for this attempt: attempt ${a.id} has no touch of the current approval; no retry. Awaiting scope review`;
    const why = authorizationProblem(a.scope, ctx.now ?? Date.now());
    if (why) return why;
  }
  const refs = referenceProblem(s.refs, a.refs);
  if (refs) return refs;
  if (JSON.stringify(s.admission ?? []) !== JSON.stringify(a.admission ?? [])) return "Admission requirements changed since dispatch; awaiting scope review";
  const claims = store.claims();
  for (const r of a.resources) if (r !== "local" && !claims.some((c) => c.resource === r && c.attempt === a.id)) return `Attempt ${a.id} no longer holds ${r}`;
  // Continuing uses this attempt's already-consumed touch; only a new dispatch checks the remaining touch budget.
  // The scope is checked above, not by readiness: admit() spent this attempt's own touch, which readiness counts as "budget spent"
  // and so refused every approved scoped step at its launch (found live on Windows, 5 November 2026, F66).
  // An ended conversation still needs current scope, claims, blockers, dependencies and admissions before reopen.
  const probe: StepTask = { ...task, workflow: { ...s, attempt: undefined, resources: [], scope: undefined } };
  const r = readiness(probe, tasks, store, ctx);
  if (r.state !== "ready") return r.text;
  return undefined;
}

/** Persists a new attempt (before any launch), takes its claims and spends its touch. Undefined when a slot was lost to another window. */
export function admit(task: StepTask, store: WorkflowStore, ctx: Context, window = process.pid): Attempt | undefined {
  if (resourceProblem([task], store)) return undefined;
  const s = task.workflow!;
  const a: Attempt = { id: crypto.randomBytes(4).toString("hex"), task: task.id, title: task.title, state: "launching", startedAt: new Date().toISOString(),
    resources: s.resources, scope: s.scope, scopeHash: s.scope && scopeHash(s.scope), admission: s.admission?.slice(), refs: s.refs, window, owner: ctx.owner, boardRoot: ctx.boardRoot };
  for (const r of s.resources) if (!store.claim(r, capacity(r, ctx.localBudget), a)) { store.release(a.id); return undefined; }
  if (s.scope) { const ap = store.approval(s.scope)!; ap.used.push(a.id); saveJson(path.join(store.dir, "approvals", `${ap.scopeHash}.json`), ap); }
  store.saveAttempt(a);
  s.attempt = a.id; s.outcome = "pending"; s.receipt = undefined;
  return a;
}

export interface DispatchResult { launched: string[]; skipped: { id: string; text: string }[] }
/**
 * Examines eligible steps in priority order and launches those whose whole requirement is available, continuing past the rest.
 * preparation: steps without a scope, within the local budget. authorized: steps whose scope is approved.
 */
export async function dispatch(tasks: StepTask[], store: WorkflowStore, ctx: Context, mode: "preparation" | "authorized",
  launch: (task: StepTask, attempt: Attempt) => Promise<void> | void, save: () => void = () => {}, window = process.pid): Promise<DispatchResult> {
  const out: DispatchResult = { launched: [], skipped: [] };
  const steps = tasks.filter((t) => t.workflow && (mode === "preparation" ? !t.workflow.scope : !!t.workflow.scope))
    .sort((x, y) => (x.workflow!.priority ?? 100) - (y.workflow!.priority ?? 100) || x.createdAt.localeCompare(y.createdAt));
  const pending: Promise<{ id: string; text?: string }>[] = [];
  try {
    for (const t of steps) {
      const r = readiness(t, tasks, store, ctx);
      if (r.state !== "ready") { pending.push(Promise.resolve({ id: t.id, text: r.text })); continue; }
      const a = admit(t, store, ctx, window);
      if (!a) { pending.push(Promise.resolve({ id: t.id, text: "Slot taken by another window" })); continue; }
      save();
      // Claims stay ordered; a provider's slow startup must not delay another independent launch.
      pending.push((async () => {
        try { await launch(t, a); return { id: t.id }; }
        catch (e) {
          fail(t, store, e instanceof Error ? e.message : String(e)); save();
          return { id: t.id, text: `Launch failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      })());
    }
  } finally {
    // Also settle existing launches if a later admission fails; collect in decision order, not completion order.
    for (const r of await Promise.all(pending)) {
      if (r.text !== undefined) out.skipped.push({ id: r.id, text: r.text }); else out.launched.push(r.id);
    }
  }
  return out;
}

/** The attempt ended with a known failure (a failed login, expired access, locked staging, ambiguous ownership): no retry; its claims stay until closed. */
export function fail(task: StepTask, store: WorkflowStore, reason: string) {
  const a = task.workflow?.attempt ? store.attempt(task.workflow.attempt) : undefined;
  if (!a) return;
  Object.assign(a, { state: "ended", endedAt: new Date().toISOString(), outcome: "failed", reason }); store.saveAttempt(a);
  task.workflow!.outcome = "failed";
  store.release(a.id, "local");
}

/** The session came up (running) or its conversation ended (ended); a gone session is unknown. Local budget frees at the end; the rest waits for Record result. */
export function mark(task: StepTask, store: WorkflowStore, state: "running" | "ended", unknown?: string) {
  const s = task.workflow, a = s?.attempt ? store.attempt(s.attempt) : undefined;
  if (!s || !a || a.state === "ended" || terminal(s.outcome) || s.outcome === "unknown") return;
  if (state === "running") { a.state = "running"; store.saveAttempt(a); return; }
  Object.assign(a, { state: "ended", endedAt: new Date().toISOString(), ...(unknown ? { outcome: "unknown", reason: unknown } : {}) }); store.saveAttempt(a);
  if (unknown) s.outcome = "unknown";
  store.release(a.id, "local");
}

/** Resumes an ended attempt's conversation: the same attempt, holding the same exclusive resources, with a local slot taken again. */
export function reopen(task: StepTask, store: WorkflowStore, ctx: Context): string | undefined {
  const a = store.attempt(task.workflow!.attempt!)!;
  if (a.state !== "ended") return undefined;
  if (a.resources.includes("local") && !store.claims().some((c) => c.attempt === a.id && c.resource === "local") && !store.claim("local", ctx.localBudget, a)) return "Waiting for a local session slot";
  Object.assign(a, { state: "running", endedAt: undefined }); store.saveAttempt(a);
  return undefined;
}

const sha = (f: string) => { try { return crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"); } catch { return "missing"; } };

/**
 * Record result (formerly Accept/close result): the owner's judgement of the attempt, recorded as a private receipt (attempt, inputs, tools, artifact hashes,
 * checks, limitations) that survives Finish removing the worktree. Only accepted releases dependents; every outcome releases the claims.
 */
export function close(task: StepTask, store: WorkflowStore, outcome: RunReceipt["outcome"], limitations: string, checksPassed = true, evidence?: { revision: string; evidence: Record<string, string> }): RunReceipt {
  const s = task.workflow!, a = store.attempt(s.attempt!)!;
  if (!OUTCOMES.includes(outcome) || ["pending", "unknown"].includes(outcome)) throw new Error("Invalid result outcome.");
  if (["blocked", "deferred", "not-applicable"].includes(outcome) && !limitations.trim()) throw new Error("This outcome requires a reason or applicability decision; it is not an accepted result.");
  if (outcome === "accepted" && s.evidenceRequired && (!evidence?.revision || !Object.keys(evidence.evidence).length)) throw new Error("Accepted plan results need exact commit and artifact evidence.");
  if (outcome === "accepted" && !checksPassed) throw new Error("Its checks did not pass, so the result cannot be accepted. Hold or fail it.");
  if (outcome === "accepted") {
    const resources = resourceProblem([task], store);
    if (resources) throw new Error(resources);
  }
  if (outcome === "accepted" && !sameScope(s.scope, a.scope, a.scopeHash)) throw new Error("Scope changed since dispatch; awaiting scope review");
  const refs = referenceProblem(s.refs, a.refs);
  if (outcome === "accepted" && refs) throw new Error(refs);
  const artifacts = Object.fromEntries((a.refs?.outputs ?? []).map((f) => [f, sha(f)]));
  if (outcome === "accepted" && Object.values(artifacts).includes("missing")) throw new Error("A declared output artifact is missing or unreadable. Hold or fail the result.");
  const r: RunReceipt = { attempt: a.id, task: task.id, outcome, inputs: a.refs?.inputs ?? [], tools: a.refs?.tools ?? [],
    artifacts, checks: s.checks ?? [], limitations, at: new Date().toISOString(), ...evidence };
  store.saveReceipt(r);
  Object.assign(a, { state: "ended", endedAt: a.endedAt ?? r.at, outcome }); store.saveAttempt(a);
  store.release(a.id);
  s.outcome = outcome; s.receipt = outcome === "accepted" ? a.id : undefined;
  return r;
}

export interface Lane { resource: string; capacity: number; holders: { title: string; attempt: string; window: number; at: string }[]; queued: string[]; release: string[] }
/** The lane view: who holds each resource, who waits for it, and what releases it. */
export function lanes(tasks: StepTask[], store: WorkflowStore, ctx: Context): Lane[] {
  const claims = store.claims();
  const names = [...new Set([...RESOURCES, ...claims.map((c) => c.resource), ...tasks.flatMap((t) => t.workflow?.resources ?? [])])];
  return names.map((resource) => {
    const held = claims.filter((c) => c.resource === resource);
    const holders = held.map((c) => ({ title: tasks.find((t) => t.id === c.task)?.title ?? c.task, attempt: c.attempt, window: c.window, at: c.at }));
    const queued = tasks.filter((t) => t.workflow?.resources.includes(resource) && !held.some((c) => c.task === t.id) && readiness(t, tasks, store, ctx).state !== "closed").map((t) => t.title);
    const release = holders.map((h) => `Record result of ${h.title} (attempt ${h.attempt})`);
    return { resource, capacity: capacity(resource, ctx.localBudget), holders, queued, release };
  });
}

/** A plan file: steps keyed for their dependsOn, created under the project card without launching any. */
export interface PlanStep { key: string; title: string; prompt: string; dependsOn?: string[]; workflow: Omit<Step, "outcome" | "attempt" | "receipt"> }
export interface Plan { project?: string; steps: PlanStep[] }
/** Problems with a plan, or none. */
export function validatePlan(plan: Plan): string[] {
  const errors: string[] = [];
  if (!Array.isArray(plan?.steps) || !plan.steps.length) return ["A plan needs a steps array."];
  const keys = new Set<string>();
  for (const s of plan.steps) {
    if (!s.key || keys.has(s.key)) errors.push(`Step key ${s.key ?? "(none)"} is missing or repeated.`); keys.add(s.key);
    if (!s.title || !s.prompt) errors.push(`Step ${s.key} needs a title and a prompt.`);
    if (!Array.isArray(s.workflow?.resources)) errors.push(`Step ${s.key} needs workflow.resources.`);
    for (const r of s.workflow?.resources ?? []) if (!resourceOk(r)) errors.push(`Step ${s.key}: unknown resource ${r}.`);
    if (s.workflow?.scope && !(s.workflow.scope.operations?.length && s.workflow.scope.toolVersion)) errors.push(`Step ${s.key}: a scope names its operations and tool version.`);
  }
  for (const s of plan.steps) for (const d of s.dependsOn ?? []) if (!keys.has(d)) errors.push(`Step ${s.key} depends on unknown step ${d}.`);
  const seen = new Map<string, number>(); // 1 visiting, 2 done
  const visit = (k: string, trail: string[]): void => {
    if (seen.get(k) === 2) return;
    if (seen.get(k) === 1) { errors.push(`Dependency cycle: ${[...trail, k].join(" → ")}.`); return; }
    seen.set(k, 1);
    for (const d of plan.steps.find((s) => s.key === k)?.dependsOn ?? []) visit(d, [...trail, k]);
    seen.set(k, 2);
  };
  for (const s of plan.steps) visit(s.key, []);
  return errors;
}
