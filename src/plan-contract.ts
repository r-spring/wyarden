// Version 2 adapts plan files to the existing governed run and workflow stores.
// Scope is an integration boundary, not a filesystem or network sandbox.
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { PlanFile, PlanCard } from "./plan";
import type { Catalogue } from "./checks";
import type { Governance } from "./orchestrator";

export type InputValues = Record<string, string | string[]>;
export interface Input { type: "text" | "list"; required: boolean; default?: string | string[] }
export interface Execution { limits: { active: number; directChildren: number; depth: number }; allowed: string[]; defaultChild: string }
export interface Contract {
  reads: string[]; writes: string[]; artifacts: string[]; acceptance: string[]; resources: string[];
  gate?: { action: string; target: string; candidate: string; evidence: string[] };
}
export function executionProblems(raw: unknown): string[] {
  if (!object(raw) || Object.keys(raw).some((k) => !["limits", "allowed", "defaultChild"].includes(k))) return ["execution must contain limits, allowed and defaultChild."];
  const l = raw.limits;
  if (!object(l) || Object.keys(l).some((k) => !["active", "directChildren", "depth"].includes(k)) ||
    !["active", "directChildren", "depth"].every((k) => Number.isInteger(l[k]) && Number(l[k]) >= 1 && Number(l[k]) <= (k === "depth" ? 8 : 32)) || Number(l.directChildren) > Number(l.active)) return ["execution.limits needs active 1..32, directChildren 1..active and depth 1..8."];
  if (!Array.isArray(raw.allowed) || !raw.allowed.length || raw.allowed.length > 20 || !raw.allowed.every((p) => plain(p, 300)) || new Set(raw.allowed).size !== raw.allowed.length || typeof raw.defaultChild !== "string" || !raw.allowed.includes(raw.defaultChild)) return ["execution must explicitly allow and select the defaultChild profile."];
  return [];
}
export const safePath = (s: string) => !!s && !path.isAbsolute(s) && !/[:\\\x00-\x1f\x7f*?\[\]{}]/.test(s) &&
  !s.split("/").some((p) => !p || p === "." || p === ".." || p === ".git" || p === ".entomatical");
export const within = (file: string, root: string) => file === root || file.startsWith(`${root}/`);
const plain = (s: unknown, cap = 200): s is string => typeof s === "string" && !!s.trim() && s.length <= cap && !/[\x00-\x1f\x7f]/.test(s);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function validateContract(raw: unknown, where: string): string[] {
  const errors: string[] = [];
  if (!object(raw)) return [`${where} needs a contract object.`];
  for (const k of Object.keys(raw)) if (!["reads", "writes", "artifacts", "acceptance", "resources", "gate"].includes(k)) errors.push(`${where}: unknown contract field ${k}.`);
  for (const k of ["reads", "writes", "artifacts", "acceptance", "resources"]) {
    const list = raw[k];
    if (!Array.isArray(list) || list.length > 20 || !list.every((x) => plain(x)) || new Set(list).size !== list.length) { errors.push(`${where}.${k} must be up to 20 unique, nonblank lines (200 characters each).`); continue; }
    if (["reads", "writes", "artifacts"].includes(k) && !list.every(safePath)) errors.push(`${where}.${k} must contain safe repository-relative paths (no globs).`);
    if (["artifacts", "acceptance"].includes(k) && !list.length) errors.push(`${where}.${k} must not be empty.`);
    if (k === "resources" && !list.every((x) => /^named:[a-z0-9][a-z0-9-]{0,79}$/.test(x))) errors.push(`${where}.resources must use named:<lowercase-id> locks.`);
  }
  if (Array.isArray(raw.artifacts) && Array.isArray(raw.writes)) for (const f of raw.artifacts) if (typeof f === "string" && !raw.writes.some((w) => typeof w === "string" && within(f, w))) errors.push(`${where}: artifact ${f} is outside writes.`);
  if (raw.gate !== undefined) {
    if (!object(raw.gate)) errors.push(`${where}.gate must be an object.`);
    else {
      for (const k of Object.keys(raw.gate)) if (!["action", "target", "candidate", "evidence"].includes(k)) errors.push(`${where}.gate: unknown field ${k}.`);
      for (const k of ["action", "target", "candidate"]) if (!plain(raw.gate[k], 300)) errors.push(`${where}.gate.${k} must identify the exact action, target or candidate (300 characters).`);
      const evidence = raw.gate.evidence;
      if (!Array.isArray(evidence) || !evidence.length || evidence.length > 20 || !evidence.every((x) => plain(x) && safePath(x))) errors.push(`${where}.gate.evidence needs 1 to 20 repository-relative evidence files.`);
    }
  }
  return errors;
}
export const digest = (value: unknown): string => crypto.createHash("sha256").update(canonical(value)).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b, "en")).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export interface Manifest {
  plan: PlanFile; cards: PlanCard[]; checks: Catalogue; sources: Record<string, string>; file: string; fileHash: string;
  governance: Governance;
}
export interface PlanApproval { id: string; hash: string; manifest: Manifest }
/** Never follow a source symlink outside the repository or accept a missing input as an approved value. */
export function sourceHash(repo: string, rel: string): string {
  if (!safePath(rel)) throw new Error(`Unsafe plan source: ${rel}`);
  const root = fs.realpathSync(repo), real = fs.realpathSync(path.join(repo, rel));
  if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) throw new Error(`Plan source is not a file in the repository: ${rel}`);
  return crypto.createHash("sha256").update(fs.readFileSync(real)).digest("hex");
}
export function manifest(repo: string, file: string, plan: PlanFile, cards: PlanCard[], catalogue: Catalogue | undefined, governance: Governance): Manifest {
  const names = [...new Set(cards.flatMap(({ step: s }) => [...(s.source ? [s.source] : []), ...(s.contract?.reads ?? []), ...(s.contract?.gate?.evidence ?? [])]))].sort();
  const checks = Object.fromEntries([...new Set(cards.flatMap((c) => c.step.checks ?? []))].sort().map((n) => [n, catalogue![n]]));
  return { plan, cards, checks, sources: Object.fromEntries(names.map((n) => [n, sourceHash(repo, n)])), file,
    fileHash: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), governance };
}
export function manifestProblem(repo: string, m: Manifest, catalogue: Catalogue | undefined): string | undefined {
  try {
    if (crypto.createHash("sha256").update(fs.readFileSync(m.file)).digest("hex") !== m.fileHash) return "The plan file changed after preview; preview and approve it again.";
    for (const [name, hash] of Object.entries(m.sources)) if (sourceHash(repo, name) !== hash) return `Plan source ${name} changed after approval; preview and approve a new run.`;
    for (const [name, check] of Object.entries(m.checks)) if (digest(catalogue?.[name]) !== digest(check)) return `Check ${name} changed after approval; preview and approve a new run.`;
  } catch (e) { return `Approved plan input is unavailable: ${e instanceof Error ? e.message : e}`; }
  return undefined;
}
