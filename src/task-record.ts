/**
 * The task record: the structured result of the compile stage (test/fixtures/compile/document-example.source.xml,
 * "What to preserve from the clarification conversation"). It is the single source of the rendered execution prompt
 * (src/compile.ts). Five dimensions: outcome, context, success, requirements, permissions; four unresolved states;
 * provenance per statement; an "unfinished" status when a consequential contradiction remains.
 */
/** project: a fact or dependency taken from PROJECT CONTEXT (4 November 2026 review, item 27). It is not the user's word, so it cannot
 *  authorize an obligation: a requirement, criterion or permission marked project is quarantined like an assumption. */
export type Provenance = "user" | "explicit-change" | "project" | "assumption";
export type Unresolved = "not-provided" | "not-applicable" | "user-delegated" | "must-ask";
export type Strength = "mandatory" | "preference" | "exclusion" | "tradeoff";
export interface Statement { text: string; provenance: Provenance }
export interface Requirement extends Statement { id: string; strength: Strength; rationale: string }
export interface Acceptance extends Statement { id: string; covers: string[] }
export interface SourceContent { label: string; content: string }
export interface UnresolvedItem extends Statement { state: Unresolved }
export interface Conflict { earlier: string; later: string; why: string }
export interface TaskRecord {
  version: 1;
  status: "ready" | "unfinished";
  outcome: { goal: string; deliverable: string; beneficiary: string };
  context: { facts: Statement[]; identifiers: string[]; sources: SourceContent[]; dependencies: Statement[] };
  success: { criteria: Acceptance[] };
  requirements: Requirement[];
  permissions: { authorized: Statement[]; confirm: Statement[]; prohibited: Statement[] };
  unresolved: UnresolvedItem[];
  conflicts: Conflict[];
}

export const PROVENANCE: Provenance[] = ["user", "explicit-change", "project", "assumption"];
export const UNRESOLVED: Unresolved[] = ["not-provided", "not-applicable", "user-delegated", "must-ask"];
export const STRENGTH: Strength[] = ["mandatory", "preference", "exclusion", "tradeoff"];

const str = { type: "string" };
const statement = { type: "object", additionalProperties: false, properties: { text: str, provenance: { type: "string", enum: PROVENANCE } }, required: ["text", "provenance"] };
const list = (items: unknown) => ({ type: "array", items });
/** Structured-output schema for the compile call. Every property is required; arrays may be empty; "" means not stated. */
export const TASK_RECORD_SCHEMA = { type: "object", additionalProperties: false,
  properties: {
    version: { type: "integer", enum: [1] },
    status: { type: "string", enum: ["ready", "unfinished"] },
    outcome: { type: "object", additionalProperties: false, properties: { goal: str, deliverable: str, beneficiary: str }, required: ["goal", "deliverable", "beneficiary"] },
    context: { type: "object", additionalProperties: false, properties: { facts: list(statement), identifiers: list(str),
      sources: list({ type: "object", additionalProperties: false, properties: { label: str, content: str }, required: ["label", "content"] }),
      dependencies: list(statement) }, required: ["facts", "identifiers", "sources", "dependencies"] },
    // No ids: Entomatical numbers requirements R1.. and criteria A1.. by position (compile.ts numberFreshRecord); covers uses those numbers.
    success: { type: "object", additionalProperties: false, properties: { criteria: list({ type: "object", additionalProperties: false,
      properties: { text: str, provenance: { type: "string", enum: PROVENANCE }, covers: list(str) }, required: ["text", "provenance", "covers"] }) }, required: ["criteria"] },
    requirements: list({ type: "object", additionalProperties: false,
      properties: { text: str, provenance: { type: "string", enum: PROVENANCE }, strength: { type: "string", enum: STRENGTH }, rationale: str },
      required: ["text", "provenance", "strength", "rationale"] }),
    permissions: { type: "object", additionalProperties: false, properties: { authorized: list(statement), confirm: list(statement), prohibited: list(statement) }, required: ["authorized", "confirm", "prohibited"] },
    unresolved: list({ type: "object", additionalProperties: false,
      properties: { text: str, provenance: { type: "string", enum: PROVENANCE }, state: { type: "string", enum: UNRESOLVED } }, required: ["text", "provenance", "state"] }),
    conflicts: list({ type: "object", additionalProperties: false, properties: { earlier: str, later: str, why: str }, required: ["earlier", "later", "why"] }),
  },
  required: ["version", "status", "outcome", "context", "success", "requirements", "permissions", "unresolved", "conflicts"] };

const MAX_TEXT = 24_000, MAX_ITEMS = 200;
const fail = (why: string): never => { throw new Error(`The compiler returned an invalid task record (${why}); the draft is unchanged.`); };
const text = (v: unknown, where: string): string => {
  if (typeof v !== "string") fail(`${where} is not text`);
  const s = v as string;
  if (s.length > MAX_TEXT) fail(`${where} exceeds ${MAX_TEXT} characters`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) fail(`${where} contains control characters`);
  return s;
};
const array = (v: unknown, where: string): unknown[] => {
  if (!Array.isArray(v)) fail(`${where} is not a list`);
  if ((v as unknown[]).length > MAX_ITEMS) fail(`${where} has more than ${MAX_ITEMS} items`);
  return v as unknown[];
};
const object = (v: unknown, where: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(`${where} is not an object`);
  return v as Record<string, unknown>;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], where: string): T => {
  if (typeof v !== "string" || !allowed.includes(v as T)) fail(`${where} must be one of ${allowed.join(", ")}`);
  return v as T;
};
const statementOf = (v: unknown, where: string): Statement => {
  const o = object(v, where);
  return { text: text(o.text, `${where}.text`), provenance: oneOf(o.provenance, PROVENANCE, `${where}.provenance`) };
};
const ids = (items: Array<{ id: string }>, pattern: RegExp, where: string) => {
  const seen = new Set<string>();
  for (const item of items) {
    if (!pattern.test(item.id)) fail(`${where} id "${item.id}" is malformed`);
    if (seen.has(item.id)) fail(`${where} id "${item.id}" is duplicated`);
    seen.add(item.id);
  }
  return seen;
};

/** Rejects unsuccessful or incomplete generation before a record is treated as ready (document, "Choosing the representation"). */
export function validTaskRecord(value: unknown): TaskRecord {
  const o = object(value, "record");
  if (o.version !== 1) fail("version is not 1");
  const status = oneOf(o.status, ["ready", "unfinished"] as const, "status");
  const outcome = object(o.outcome, "outcome");
  const context = object(o.context, "context");
  const success = object(o.success, "success");
  const permissions = object(o.permissions, "permissions");
  const record: TaskRecord = {
    version: 1, status,
    outcome: { goal: text(outcome.goal, "outcome.goal"), deliverable: text(outcome.deliverable, "outcome.deliverable"), beneficiary: text(outcome.beneficiary, "outcome.beneficiary") },
    context: {
      facts: array(context.facts, "context.facts").map((s, i) => statementOf(s, `context.facts[${i}]`)),
      identifiers: array(context.identifiers, "context.identifiers").map((s, i) => text(s, `context.identifiers[${i}]`)),
      sources: array(context.sources, "context.sources").map((s, i) => { const d = object(s, `context.sources[${i}]`);
        return { label: text(d.label, `context.sources[${i}].label`), content: text(d.content, `context.sources[${i}].content`) }; }),
      dependencies: array(context.dependencies, "context.dependencies").map((s, i) => statementOf(s, `context.dependencies[${i}]`)),
    },
    success: { criteria: array(success.criteria, "success.criteria").map((s, i) => { const a = object(s, `success.criteria[${i}]`);
      return { ...statementOf(a, `success.criteria[${i}]`), id: text(a.id, `success.criteria[${i}].id`),
        covers: array(a.covers, `success.criteria[${i}].covers`).map((c, j) => text(c, `success.criteria[${i}].covers[${j}]`)) }; }) },
    requirements: array(o.requirements, "requirements").map((s, i) => { const r = object(s, `requirements[${i}]`);
      return { ...statementOf(r, `requirements[${i}]`), id: text(r.id, `requirements[${i}].id`),
        strength: oneOf(r.strength, STRENGTH, `requirements[${i}].strength`), rationale: text(r.rationale, `requirements[${i}].rationale`) }; }),
    permissions: {
      authorized: array(permissions.authorized, "permissions.authorized").map((s, i) => statementOf(s, `permissions.authorized[${i}]`)),
      confirm: array(permissions.confirm, "permissions.confirm").map((s, i) => statementOf(s, `permissions.confirm[${i}]`)),
      prohibited: array(permissions.prohibited, "permissions.prohibited").map((s, i) => statementOf(s, `permissions.prohibited[${i}]`)),
    },
    unresolved: array(o.unresolved, "unresolved").map((s, i) => { const u = object(s, `unresolved[${i}]`);
      return { ...statementOf(u, `unresolved[${i}]`), state: oneOf(u.state, UNRESOLVED, `unresolved[${i}].state`) }; }),
    conflicts: array(o.conflicts, "conflicts").map((s, i) => { const c = object(s, `conflicts[${i}]`);
      return { earlier: text(c.earlier, `conflicts[${i}].earlier`), later: text(c.later, `conflicts[${i}].later`), why: text(c.why, `conflicts[${i}].why`) }; }),
  };
  // Empty facts, dependencies, permissions and identifiers carry nothing and would render as a bare label: drop them.
  const filled = <T extends { text: string }>(items: T[]) => items.filter((s) => s.text.trim());
  record.context.facts = filled(record.context.facts); record.context.dependencies = filled(record.context.dependencies);
  record.context.identifiers = record.context.identifiers.filter((s) => s.trim());
  for (const k of ["authorized", "confirm", "prohibited"] as const) record.permissions[k] = filled(record.permissions[k]);
  const known = ids(record.requirements, /^R[1-9]\d*$/, "requirement");
  ids(record.success.criteria, /^A[1-9]\d*$/, "acceptance");
  for (const a of record.success.criteria) for (const c of a.covers) if (!known.has(c)) fail(`acceptance ${a.id} covers unknown requirement "${c}"`);
  for (const [i, s] of record.requirements.entries()) if (!s.text.trim()) fail(`requirements[${i}] is empty`);
  for (const [i, s] of record.success.criteria.entries()) if (!s.text.trim()) fail(`success.criteria[${i}] is empty`);
  for (const [i, s] of record.unresolved.entries()) if (!s.text.trim()) fail(`unresolved[${i}] is empty`);
  if (status === "ready") {
    if (!record.outcome.goal.trim()) fail("a ready record has no goal");
    if (record.conflicts.length) fail("a ready record lists conflicts");
  } else if (!record.conflicts.length) fail("an unfinished record lists no conflict");
  return record;
}

/** What the executor receives: decisions and necessary uncertainty, never the interview or the full provenance. */
export interface ExecutorStatement { text: string; assumed: boolean }
export interface ExecutorView {
  outcome: { goal: string; deliverable: string; beneficiary: string };
  context: { facts: ExecutorStatement[]; identifiers: string[]; sources: SourceContent[]; dependencies: ExecutorStatement[] };
  success: { criteria: Array<ExecutorStatement & { id: string; covers: string[] }> };
  requirements: Array<ExecutorStatement & { id: string; strength: Strength; rationale: string }>;
  permissions: { authorized: ExecutorStatement[]; confirm: ExecutorStatement[]; prohibited: ExecutorStatement[] };
  unresolved: Array<ExecutorStatement & { state: Unresolved }>;
}
const collapse = (s: Statement): ExecutorStatement => ({ text: s.text, assumed: s.provenance === "assumption" });
/** An obligation the executor gets: the user's word, or an explicit change. Assumed and project-derived ones are quarantined. */
const supported = (s: Statement) => s.provenance === "user" || s.provenance === "explicit-change";
/**
 * The executor gets no obligation the model admits it assumed (4 November 2026 review, items 19, 20, 50). Assumed requirements, acceptance
 * criteria and permissions of every category are quarantined: left out of the view, listed by quarantined() for the review panel, and kept
 * in the record. An assumed authorization is no longer turned into "Requires confirmation" (that made 94e6f28b ask before reading files).
 * Assumed context (facts, dependencies) stays, labelled as unconfirmed. Requirements and checks are renumbered R1.. and A1.. so the prompt
 * has no gaps, and each check's covers follows the renumbering, minus requirements that were quarantined.
 */
export function executorView(record: TaskRecord): ExecutorView {
  const kept = record.requirements.filter(supported);
  const id = new Map(kept.map((r, i) => [r.id, `R${i + 1}`]));
  return {
    outcome: { ...record.outcome },
    context: { facts: record.context.facts.map(collapse), identifiers: [...record.context.identifiers],
      sources: record.context.sources.map(s => ({ ...s })), dependencies: record.context.dependencies.map(collapse) },
    success: { criteria: record.success.criteria.filter(supported).map((a, i) => ({ ...collapse(a), id: `A${i + 1}`,
      covers: a.covers.filter(c => id.has(c)).map(c => id.get(c)!) })) },
    requirements: kept.map(r => ({ ...collapse(r), id: id.get(r.id)!, strength: r.strength, rationale: r.rationale })),
    permissions: { authorized: record.permissions.authorized.filter(supported).map(collapse), confirm: record.permissions.confirm.filter(supported).map(collapse),
      prohibited: record.permissions.prohibited.filter(supported).map(collapse) },
    // An open question is not a guess: "Must ask before proceeding: Assumed (unconfirmed): ..." contradicted itself.
    unresolved: record.unresolved.map(u => ({ text: u.text, assumed: false, state: u.state })),
  };
}

/** What the model assumed and the executor will not get: shown in review as "The model assumed these; not sent". */
export interface Quarantined { kind: "requirement" | "acceptance" | "authorized" | "confirm" | "prohibited"; id?: string; text: string }
export function quarantined(record: TaskRecord): Quarantined[] {
  return [...record.requirements.filter(r => !supported(r)).map(r => ({ kind: "requirement" as const, id: r.id, text: r.text })),
    ...record.success.criteria.filter(a => !supported(a)).map(a => ({ kind: "acceptance" as const, id: a.id, text: a.text })),
    ...(["authorized", "confirm", "prohibited"] as const).flatMap(k => record.permissions[k].filter(s => !supported(s)).map(s => ({ kind: k, text: s.text })))];
}
/**
 * Why a record cannot be applied after quarantine, or [] when it can. A check the user stated that covered requirements, all of which were
 * quarantined, would check nothing that is sent: the record is kept for review, nothing is applied, and no new model call is made.
 * A check that keeps at least one supported requirement is fine (its covers just loses the others).
 */
export function quarantineProblems(record: TaskRecord): string[] {
  const removed = new Set(record.requirements.filter(r => !supported(r)).map(r => r.id));
  return record.success.criteria.filter(a => supported(a) && a.covers.length > 0 && a.covers.every(c => removed.has(c)))
    .map(a => `Check ${a.id} ("${a.text}") covers only requirements the model assumed (${a.covers.join(", ")}), so it would check nothing that is sent.`);
}
