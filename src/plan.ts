// Plan files (F72; the user, 5 November 2026; design src/plan.ts): one standard way to hand out work. A plan
// file lists steps with the same few fields; the board checks the file, writes every step's prompt from one fixed template, and makes
// the cards, so no model invents a plan or a prompt at run time. Pure of VS Code so tests drive every refusal directly; the board
// (src/board.ts runPlan) makes and runs the cards.
//
// `vars`, `each`/`as`, the {{var}} placeholders, how an `each` list is split and how its item is named are taken from the parallel
// F72 build on card 3a156f's helper branch (commit 52c573d, src/workflow-file.ts: items, itemName, PLACEHOLDER, the expansion of
// `after` to every card of a repeated step), at the user's choice of 5 November 2026; here they fill the fixed fields instead of
// prompt files.
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import type { Catalogue } from "./checks";
import { CODEX_PERMISSIONS, codexThreadPermissions } from "./codex";
import { executionProblems, validateContract, type Contract, type Execution, type Input, type InputValues } from "./plan-contract";

/** Plan files end in this, in <repo>/workflows (shared through git) or <repo>/.entomatical/workflows (private). */
export const PLAN_SUFFIX = ".plan.json";
/** Who decides that a step is finished: the board by its checks alone, or a reviewer model that also reads the step's changes. */
export type Review = "checks" | "model";
export interface PlanStep {
  id: string; title: string; goal: string; source?: string; files?: string[]; avoid?: string[]; checks?: string[]; reply?: string; after?: string[];
  /** Request a verdict from this plan's standing judge before accepting this step. */
  judge?: boolean;
  /**
   * F119: this step may open its own cards (board.js add), as a coordinator that an orchestrator adds with --may-open may. Its
   * cards count against the run's caps; the step is accepted only once every card it opened is Done or cancelled.
   */
  mayOpen?: boolean;
  /** One card per item of this variable's list; `as` names the item in {{…}} (default: the list's name without its plural s, else item). */
  each?: string; as?: string;
  account?: string; model?: string; effort?: string; permission?: string;
  contract?: Contract;
}
export interface PlanFile {
  v: 1 | 2; name: string; about?: string; review: Review; reviewer?: { account?: string; model?: string; effort?: string; permission?: string }; account?: string;
  model?: string; effort?: string; permission?: string;
  judge?: string; scribe?: { model?: string; documents: string[]; after: string[] };
  /** Texts the steps use as {{name}}; the user may change each one before Run. */
  vars?: Record<string, string>;
  /** A v1 model reviewer may delegate additional work when the operator approves this file. */
  mayOpen?: boolean;
  deliveryChecks?: string[];
  inputs?: Record<string, Input>; reusable?: boolean; execution?: Execution;
  steps: PlanStep[];
}
/** One card a Run makes: a step, or one item of a step's `each` list, with {{vars}} filled in. after holds card keys or board card ids. */
export interface PlanCard { key: string; step: PlanStep; after: string[]; item?: string }
/**
 * What the board allows: its check catalogue, the form's choices, the signed-in Claude, Codex, Grok and Antigravity accounts, the run's
 * card cap, and the ids of cards already on the board (a step may wait for one of them as well as for steps of its own plan).
 */
export type PlanProvider = "claude" | "codex" | "grok" | "antigravity";

/** The standing judge's managed launch policy. The ACP role filter applies to permission requests that reach the board. */
export function standingJudgePermission(provider: PlanProvider, configured?: string) {
  if (provider === "claude") return { permission: "plan", detail: "The standing judge uses Claude plan mode." };
  if (provider === "codex") {
    // An archive may contain a retired setting that today's launcher refuses.
    if (configured !== undefined && !Object.hasOwn(CODEX_PERMISSIONS, configured)) {
      return { permission: null, detail: "The saved Codex permission setting is unrecognized. Its judge launch policy is unknown." };
    }
    const { sandbox, approvalPolicy } = codexThreadPermissions({ permission: configured, role: "judge" });
    return { permission: sandbox, approvalPolicy, detail: `The standing judge uses the Codex ${sandbox} sandbox with approval policy ${approvalPolicy}.` };
  }
  const name = provider === "grok" ? "Grok" : "Antigravity";
  const permission = configured === "ask" || configured === "bypass" ? configured : null;
  const setting = permission === "ask" ? "The board setting is ask. The board selects an advertised approval mode, which may be named plan."
    : permission === "bypass" ? "The board setting is bypass. The board allows an eligible read request once and leaves the provider mode unchanged."
    : "The judge uses the account’s default provider mode.";
  return { permission, detail: `Standing judge on ${name}. ${setting} The board refuses non-read ACP permission requests it receives.` };
}

/**
 * One account a card may run on. Grok and Antigravity have no fixed model list (orchestrator run 0db6d1): models and efforts are what
 * the account last advertised (board.ts acpCatalog), and efforts is its thought-level list. pending: it never advertised any yet, so a
 * model or effort is taken as written and checked when the step's session opens, as board.ts add does.
 */
export interface PlanProfile { name: string; provider: PlanProvider; models: { id: string; efforts: string[] }[]; permissions: string[]; efforts?: string[]; pending?: boolean }
const ACP = (p: PlanProfile) => p.provider === "grok" || p.provider === "antigravity";
export interface PlanRules { catalogue?: Catalogue; models: string[]; efforts: string[]; permissions: string[]; accounts?: string[]; profiles?: PlanProfile[]; defaultAccount?: string; maxSteps: number; cards?: string[] }

const TOP = ["v", "name", "about", "review", "reviewer", "account", "model", "effort", "permission", "judge", "scribe", "vars", "steps", "inputs", "execution", "reusable", "mayOpen", "deliveryChecks"];
const STEP = ["id", "title", "goal", "source", "files", "avoid", "checks", "reply", "after", "each", "as", "account", "model", "effort", "permission", "judge", "contract", "mayOpen"];
/** A card on the board, named in a step's after: six hex digits (a step id is any other lowercase name). */
export const CARD_ID = /^[0-9a-f]{6}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,29}$/;
const VAR = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
/** Items one `each` list may expand to, and a variable's length. */
export const MAX_EACH = 20, VAR_CAP = 2000;
export const DEFAULT_REPLY = "the commit id, what changed, and anything left undone";
/** Automatic follow-ups the board sends one step of a checks-only plan (a fix after failed checks, or a resume after an interruption). */
export const AUTO_FOLLOW_UPS = 2;

/** `each` items: the text split on `;` or new lines when it has one (items with spaces, such as questions), else on spaces and commas. */
export const items = (text: string) => text.split(/[;\n]/.test(text) ? /[;\r\n]+/ : /[\s,]+/).map((s) => s.trim()).filter(Boolean);
/** The name an `each` item takes in {{…}}: `as`, else the list's name without its plural s (features → feature), else item. */
export const itemName = (each: string, as?: string) => as || (each.length > 1 && each.endsWith("s") ? each.slice(0, -1) : "item");
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
/** The step's text fields, where {{…}} is filled in. */
const TEXTS = ["title", "goal", "source", "reply"] as const, LISTS = ["files", "avoid"] as const;

/**
 * Every problem with a plan file, all at once, or the plan and the cards a Run makes. Unknown fields are refused so a typo shows up
 * instead of being ignored. `vars` replaces the file's own variables for this run (the user's answers before Run); only names the file
 * declares are taken.
 */
export function validatePlanFile(raw: unknown, rules: PlanRules, vars: InputValues = {}): { plan: PlanFile; cards: PlanCard[]; judgePermission?: ReturnType<typeof standingJudgePermission> } | { errors: string[] } {
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) return { errors: ["Run inputs must be an object."] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors: ["A plan file is one JSON object: { \"v\": 1, \"name\": …, \"review\": …, \"steps\": [ … ] }."] };
  const r = raw as Record<string, unknown>, errors: string[] = [];
  const text = (v: unknown, where: string, cap: number, required: boolean, oneLine = false) => {
    if (v === undefined) { if (required) errors.push(`${where} is missing.`); return; }
    if (typeof v !== "string" || (required && !v.trim())) return void errors.push(`${where} must be text${required ? " and not empty" : ""}.`);
    if (v.length > cap) errors.push(`${where} is longer than ${cap} characters.`);
    if (CONTROL.test(v) || (oneLine && /[\r\n]/.test(v))) errors.push(`${where} must be ${oneLine ? "one line of " : ""}plain text.`);
  };
  const list = (v: unknown, where: string) => {
    if (v === undefined) return;
    if (!Array.isArray(v) || v.length > 20 || !v.every((x) => typeof x === "string" && x.trim() && x.length <= 200 && !CONTROL.test(x) && !/[\r\n]/.test(x)))
      errors.push(`${where} must be a list of up to 20 names or paths, each one line.`);
  };
  const choice = (v: unknown, where: string, allowed: string[]) => {
    if (v === undefined) return;
    if (typeof v !== "string" || !allowed.includes(v)) errors.push(`${where} must be one of ${allowed.join(", ")}.`);
  };
  for (const k of Object.keys(r)) if (!TOP.includes(k)) errors.push(`Unknown field "${k}" at the top. Allowed: ${TOP.join(", ")}.`);
  if (r.deliveryChecks !== undefined) {
    list(r.deliveryChecks, '"deliveryChecks"');
    if (r.v !== 1 || r.review !== "model") errors.push('"deliveryChecks" requires a v1 model-reviewed plan.');
    if (!Array.isArray(r.deliveryChecks) || !r.deliveryChecks.length) errors.push('"deliveryChecks" must name at least one check.');
    else for (const name of r.deliveryChecks) if (typeof name === "string" && (!rules.catalogue || !own(rules.catalogue, name)))
      errors.push(`Delivery check "${name}" is not in workflows/checks.json.`);
  }
  if (r.mayOpen !== undefined && typeof r.mayOpen !== "boolean") errors.push('"mayOpen" must be true or false.');
  if (r.mayOpen === true && (r.v !== 1 || r.review !== "model")) errors.push('Root delegation ("mayOpen": true) requires a v1 model-reviewed plan.');
  if (r.v !== 1 && r.v !== 2) errors.push(`"v" must be 1 or 2.`);
  if (r.v === 1 && ["inputs", "execution", "reusable"].some((k) => r[k] !== undefined)) errors.push("inputs, execution and reusable require v: 2.");
  if (r.v === 2) {
    if (typeof r.reusable !== "boolean") errors.push("v2 requires an explicit reusable boolean.");
    if (r.vars !== undefined) errors.push("v2 uses typed inputs instead of vars.");
    if (r.judge !== undefined || r.scribe !== undefined) errors.push("v2 uses governed review and owner result receipts; legacy standing roles require v1.");
    if (!r.execution || typeof r.execution !== "object" || Array.isArray(r.execution)) errors.push("v2 requires execution limits and explicitly allowed child profiles.");
    else errors.push(...executionProblems(r.execution));
    if (r.permission === undefined) errors.push("v2 requires explicit worker permission.");
    if (r.review === "model" && !(r.reviewer as { permission?: unknown })?.permission) errors.push("v2 requires explicit reviewer.permission.");
  }
  text(r.name, `"name"`, 60, true, true);
  text(r.about, `"about"`, 300, false, true);
  if (r.review !== "checks" && r.review !== "model") errors.push(`"review" must be "checks" (the board accepts a step when its checks pass) or "model" (a reviewer model also reads its changes).`);
  if (!rules.profiles) choice(r.judge, `"judge"`, rules.models);
  if (r.scribe !== undefined) {
    if (!r.scribe || typeof r.scribe !== "object" || Array.isArray(r.scribe)) errors.push(`"scribe" must be { "model": …, "documents": [ … ], "after": [ … ] }.`);
    else {
      const s = r.scribe as Record<string, unknown>;
      for (const k of Object.keys(s)) if (!["model", "documents", "after"].includes(k)) errors.push(`Unknown field "${k}" in "scribe".`);
      if (!rules.profiles) choice(s.model, `"scribe.model"`, rules.models);
      list(s.documents, `"scribe.documents"`);
      list(s.after, `"scribe.after"`);
      if (!Array.isArray(s.documents) || !s.documents.length) errors.push(`"scribe.documents" must name at least one document.`);
      else for (const doc of s.documents) if (typeof doc === "string" && (path.isAbsolute(doc) || /^[A-Za-z]:/.test(doc) || doc.includes("\\") || doc.split("/").some((part) => !part || part === "." || part === ".." || part === ".git" || part === ".entomatical"))) errors.push(`Scribe document "${doc}" must be a safe repository-relative path.`);
      if (!Array.isArray(s.after) || !s.after.length) errors.push(`"scribe.after" must name at least one milestone step.`);
    }
  }
  if (r.reviewer !== undefined) {
    if (r.review !== "model") errors.push(`"reviewer" is only for "review": "model".`);
    if (!r.reviewer || typeof r.reviewer !== "object" || Array.isArray(r.reviewer)) errors.push(`"reviewer" must be { "model": …, "effort": … }.`);
    else {
      const rv = r.reviewer as Record<string, unknown>;
      for (const k of Object.keys(rv)) if (k !== "account" && k !== "model" && k !== "effort" && k !== "permission") errors.push(`Unknown field "${k}" in "reviewer". Allowed: account, model, effort, permission.`);
      if (!rules.profiles) { choice(rv.model, `"reviewer.model"`, rules.models); choice(rv.effort, `"reviewer.effort"`, rules.efforts); }
      if (!rules.profiles) choice(rv.permission, `"reviewer.permission"`, rules.permissions);
    }
  }
  const account = (v: unknown, where: string) => {
    if (v === undefined) return;
    text(v, where, 200, true, true);
    if (typeof v === "string" && rules.accounts && !rules.profiles && !rules.accounts.some((a) => a.toLowerCase() === v.toLowerCase()))
      errors.push(`${where} ${v} is not a signed-in account.`);
  };
  account(r.account, `"account"`);
  if (r.reviewer && typeof r.reviewer === "object" && !Array.isArray(r.reviewer)) account((r.reviewer as Record<string, unknown>).account, `"reviewer.account"`);
  if (!rules.profiles) { choice(r.model, `"model"`, rules.models); choice(r.effort, `"effort"`, rules.efforts); choice(r.permission, `"permission"`, rules.permissions); }
  // Variables: the file's, then this run's answers to them.
  const values: InputValues = Object.create(null);
  if (r.vars !== undefined) {
    if (!r.vars || typeof r.vars !== "object" || Array.isArray(r.vars)) errors.push(`"vars" must be an object of texts, for example { "features": "F14 F23" }.`);
    else for (const [k, v] of Object.entries(r.vars as Record<string, unknown>)) {
      if (!VAR.test(k)) errors.push(`Variable "${k}" must be a name of letters, digits and _.`);
      else if (typeof v !== "string" || v.length > VAR_CAP || CONTROL.test(v.replace(/\r?\n/g, ""))) errors.push(`Variable "${k}" must be text of up to ${VAR_CAP} characters.`);
      else values[k] = v;
    }
  }
  if (r.v === 2 && r.inputs !== undefined) {
    if (!r.inputs || typeof r.inputs !== "object" || Array.isArray(r.inputs)) errors.push("inputs must be an object of typed input definitions.");
    else for (const [k, def] of Object.entries(r.inputs as Record<string, Input>)) {
      if (!VAR.test(k) || !def || typeof def !== "object" || Array.isArray(def) || Object.keys(def).some((f) => !["type", "required", "default"].includes(f)) || !["text", "list"].includes(def.type) || typeof def.required !== "boolean") { errors.push(`Invalid input definition ${k}.`); continue; }
      const value = own(vars, k) ? vars[k] : def.default !== undefined ? def.default : (def.type === "list" ? [] : "");
      const valid = (s: unknown) => typeof s === "string" && s.length <= VAR_CAP && !CONTROL.test(s);
      const validValue = (v: unknown) => def.type === "text" ? valid(v) : Array.isArray(v) && v.length <= MAX_EACH && v.every((s) => valid(s) && s.trim());
      if ((def.default !== undefined && !validValue(def.default)) || !validValue(value)) errors.push(`Input ${k} must be ${def.type === "list" ? "an array of up to 20 nonblank texts" : "text"}.`);
      else if (def.required && (typeof value === "string" ? !value.trim() : !value.length)) errors.push(`Required input ${k} is empty.`);
      else values[k] = value;
    }
  }
  for (const [k, v] of Object.entries(vars)) {
    if (r.v === 2 && r.inputs && typeof r.inputs === "object" && own(r.inputs, k)) continue;
    if (!own(values, k)) errors.push(`The plan has no variable "${k}".`);
    else if (typeof v !== "string" || v.length > VAR_CAP || CONTROL.test(v)) errors.push(`Variable "${k}" must be text of up to ${VAR_CAP} characters.`);
    else values[k] = v;
  }
  if (!Array.isArray(r.steps) || !r.steps.length) return { errors: [...errors, `"steps" must be a list of at least one step.`] };
  const ids = new Set<string>();
  for (const [i, s] of (r.steps as unknown[]).entries()) {
    const label = `Step ${i + 1}`;
    if (!s || typeof s !== "object" || Array.isArray(s)) { errors.push(`${label} must be an object.`); continue; }
    const st = s as Record<string, unknown>;
    const where = typeof st.id === "string" && st.id ? `Step "${st.id}"` : label;
    if (r.v === 2) errors.push(...validateContract(st.contract, where));
    else if (st.contract !== undefined) errors.push(`${where}: contract requires v: 2.`);
    for (const k of Object.keys(st)) if (!STEP.includes(k)) errors.push(`Unknown field "${k}" in ${where}. Allowed: ${STEP.join(", ")}.`);
    if (typeof st.id !== "string" || !ID.test(st.id)) errors.push(`${where}: "id" must be lowercase letters, digits and -, up to 30 characters.`);
    else if (ids.has(st.id)) errors.push(`${where}: the id is used twice.`);
    else ids.add(st.id);
    text(st.title, `${where} "title"`, 80, true, true);
    text(st.goal, `${where} "goal"`, 4000, true);
    text(st.source, `${where} "source"`, 300, false, true);
    account(st.account, `${where} "account"`);
    list(st.files, `${where} "files"`); list(st.avoid, `${where} "avoid"`); list(st.checks, `${where} "checks"`);
    if (st.judge !== undefined && typeof st.judge !== "boolean") errors.push(`${where} "judge" must be true or false.`);
    if (st.judge === true && typeof r.judge !== "string") errors.push(`${where} requests a judge, but the plan has no judge model.`);
    if (st.mayOpen !== undefined && typeof st.mayOpen !== "boolean") errors.push(`${where} "mayOpen" must be true or false.`);
    text(st.reply, `${where} "reply"`, 500, false);
    if (!rules.profiles) { choice(st.model, `${where} "model"`, rules.models); choice(st.effort, `${where} "effort"`, rules.efforts); choice(st.permission, `${where} "permission"`, rules.permissions); }
    if (st.each !== undefined && (typeof st.each !== "string" || !own(values, st.each))) errors.push(`${where}: "each" must name one of the plan's variables${Object.keys(values).length ? ` (${Object.keys(values).join(", ")})` : ""}.`);
    if (st.as !== undefined && (typeof st.as !== "string" || !VAR.test(st.as))) errors.push(`${where}: "as" must be a variable name.`);
    if (st.as !== undefined && st.each === undefined) errors.push(`${where}: "as" needs "each".`);
    // Every {{name}} must be a variable, or the item of this step's each list.
    const known = new Set([...Object.keys(values), ...(typeof st.each === "string" ? [itemName(st.each, typeof st.as === "string" ? st.as : undefined), "item"] : [])]);
    const used = [...TEXTS.map((k) => st[k]), ...LISTS.flatMap((k) => (Array.isArray(st[k]) ? st[k] as unknown[] : []))].filter((x): x is string => typeof x === "string");
    for (const name of new Set(used.flatMap((t) => [...t.matchAll(PLACEHOLDER)].map((m) => m[1])))) if (!known.has(name)) errors.push(`${where}: unknown variable {{${name}}}.`);
    const checks = Array.isArray(st.checks) ? st.checks.filter((c): c is string => typeof c === "string") : [];
    if (st.judge === true && !checks.length) errors.push(`${where}: a judged step must name at least one acceptance check.`);
    if (r.review === "checks" && !checks.length) errors.push(`${where} names no checks. With "review": "checks" the board accepts a step only when its checks pass, so every step needs one from workflows/checks.json.`);
    if (checks.length && !rules.catalogue) errors.push(`${where} names checks, but this repository has no workflows/checks.json to look them up in.`);
    else for (const c of checks) if (rules.catalogue && !own(rules.catalogue, c)) errors.push(`${where}: check "${c}" is not in workflows/checks.json (it has ${Object.keys(rules.catalogue).join(", ") || "none"}).`);
  }
  // Validate effective settings per card, before the board creates anything. A step may override the plan account,
  // so the same inherited model, effort or permission may be valid for one worker but invalid for another.
  let judgeProvider: PlanProvider | undefined;
  if (rules.profiles) {
    const profile = (name: unknown, where: string): PlanProfile | undefined => {
      if (name !== undefined) text(name, where, 200, true, true);
      const requested = typeof name === "string" ? name : rules.defaultAccount;
      if (!requested) { errors.push(`${where}: choose a signed-in Claude, Codex, Grok or Antigravity account.`); return; }
      const exact = rules.profiles!.find((p) => p.name === requested), key = requested.toLowerCase();
      // As board.ts resolveAccount: the exact label, Codex's short label, or a provider's name when it has one account.
      const matches = rules.profiles!.filter((p) => p.name.toLowerCase() === key ||
        (p.provider === "codex" && p.name.replace(/^Codex\s*[·:]\s*/i, "").toLowerCase() === key) || (p.provider !== "claude" && key === p.provider));
      const found = exact ?? (matches.length === 1 ? matches[0] : undefined);
      if (!found) errors.push(`${where} ${requested} is not an available, unambiguous signed-in account (Claude, Codex, Grok or Antigravity).`);
      return found;
    };
    const settings = (p: PlanProfile | undefined, where: string, model: unknown, effort: unknown, permission: unknown) => {
      if (!p) return;
      // Nothing advertised yet: the value waits in acpSelections and the session refuses it at open if the agent does not offer it.
      const queued = (v: unknown) => !!p.pending && ACP(p) && typeof v === "string" && !!v.trim() && v.length <= 200 && !CONTROL.test(v);
      if (model !== undefined && !queued(model) && (typeof model !== "string" || !p.models.some((m) => m.id === model))) errors.push(`${where} "model" must be one of ${p.models.map((m) => m.id).join(", ") || "the models advertised for this account"}.`);
      if (effort !== undefined && !queued(effort)) {
        const offered = typeof model === "string" ? p.models.find((m) => m.id === model)?.efforts : p.provider === "claude" ? rules.efforts : p.efforts;
        if (!offered && p.provider === "codex" && model === undefined) errors.push(`${where}: choose a Codex model when specifying effort.`);
        else if (typeof effort !== "string" || !offered?.includes(effort)) errors.push(`${where} "effort" is not available for the selected model.`);
      }
      if (permission !== undefined && (typeof permission !== "string" || !p.permissions.includes(permission))) errors.push(`${where} "permission" must be one of ${p.permissions.join(", ")}.`);
    };
    const base = profile(r.account, `"account"`);
    for (const st of r.steps as unknown[]) {
      if (!st || typeof st !== "object" || Array.isArray(st)) continue;
      const step = st as Record<string, unknown>;
      const where = `Step "${typeof step.id === "string" ? step.id : "?"}"`;
      const selected = step.account === undefined ? base : profile(step.account, `${where} "account"`);
      settings(selected, where, step.model === undefined ? r.model : step.model, step.effort === undefined ? r.effort : step.effort, step.permission === undefined ? r.permission : step.permission);
    }
    const reviewer = r.reviewer && typeof r.reviewer === "object" && !Array.isArray(r.reviewer) ? r.reviewer as Record<string, unknown> : undefined;
    if (r.review === "model") {
      const selected = reviewer?.account === undefined ? base : profile(reviewer.account, `"reviewer.account"`);
      settings(selected, `"reviewer"`, reviewer?.model, reviewer?.effort, reviewer?.permission);
    }
    if (r.judge !== undefined) {
      judgeProvider = base?.provider;
      settings(base, `"judge"`, r.judge, undefined, r.permission);
    }
    if (r.scribe && typeof r.scribe === "object" && !Array.isArray(r.scribe)) settings(base, `"scribe"`, (r.scribe as Record<string, unknown>).model, undefined, r.permission);
  }
  const steps = (r.steps as Record<string, unknown>[]).filter((s) => s && typeof s === "object");
  if (r.scribe && typeof r.scribe === "object" && !Array.isArray(r.scribe)) {
    const milestones = (r.scribe as Record<string, unknown>).after;
    if (Array.isArray(milestones)) for (const id of milestones) if (typeof id === "string" && !ids.has(id)) errors.push(`Scribe waits for unknown step "${id}".`);
  }
  for (const st of steps) {
    if (st.after === undefined) continue;
    if (!Array.isArray(st.after) || !st.after.every((x) => typeof x === "string")) { errors.push(`Step "${st.id}" "after" must be a list of step ids.`); continue; }
    for (const d of st.after as string[]) {
      if (d === st.id) errors.push(`Step "${st.id}" waits for itself.`);
      else if (!ids.has(d) && !(CARD_ID.test(d) && rules.cards?.includes(d))) errors.push(`Step "${st.id}" waits for "${d}", which is neither a step of this plan nor a card on the board.`);
    }
  }
  // Circles: a step that, through what it waits for, waits for itself (validatePlan's visitor in workflow.ts, on step ids).
  const state = new Map<string, number>(); // 1 visiting, 2 done
  const after = (id: string) => {
    const deps = steps.find((s) => s.id === id)?.after;
    return Array.isArray(deps) ? deps.filter((d): d is string => typeof d === "string" && ids.has(d) && d !== id) : [];
  };
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) return void errors.push(`Steps wait for each other in a circle: ${[...trail, id].join(" → ")}.`);
    state.set(id, 1);
    for (const d of after(id)) visit(d, [...trail, id]);
    state.set(id, 2);
  };
  for (const id of ids) visit(id, []);
  if (errors.length) return { errors };
  // The cards: one per step, or one per item of its each list; after names every card of the steps it waits for.
  const plan: PlanFile = { ...(raw as PlanFile), ...(r.v === 1 && Object.keys(values).length ? { vars: { ...values } as Record<string, string> } : {}),
    ...(r.v === 2 && r.inputs ? { inputs: Object.fromEntries(Object.entries(r.inputs as Record<string, Input>).map(([k, d]) => [k, { ...d, default: values[k] }])) } : {}) };
  const cards: PlanCard[] = [], keysOf = new Map<string, string[]>();
  for (const s of plan.steps) {
    const value = s.each ? values[s.each] : undefined;
    const entries = s.each ? Array.isArray(value) ? value : items(value as string) : [undefined];
    if (s.each && !entries.length) { errors.push(`Step "${s.id}": its each list "${s.each}" is empty.`); continue; }
    if (entries.length > MAX_EACH) { errors.push(`Step "${s.id}": its each list "${s.each}" has ${entries.length} items; at most ${MAX_EACH}.`); continue; }
    const name = s.each ? itemName(s.each, s.as) : "";
    const keys: string[] = [];
    entries.forEach((item, i) => {
      const v = item === undefined ? values : { ...values, [name]: item, item };
      const sub = (t: string) => t.replace(PLACEHOLDER, (m, n: string) => {
        if (Array.isArray(v[n])) { errors.push(`Step "${s.id}": list input {{${n}}} can only be used through each.`); return m; }
        return own(v, n) ? v[n] as string : m;
      });
      const step: PlanStep = { ...s, title: sub(s.title).trim(), goal: sub(s.goal), ...(s.source ? { source: sub(s.source) } : {}), ...(s.reply ? { reply: sub(s.reply) } : {}),
        ...(s.files ? { files: s.files.map(sub) } : {}), ...(s.avoid ? { avoid: s.avoid.map(sub) } : {}) };
      if (step.title.length > 120) errors.push(`Step "${s.id}": the title is longer than 120 characters once its variables are filled in.`);
      text(step.title, `Expanded step "${s.id}" title`, 120, true, true);
      text(step.goal, `Expanded step "${s.id}" goal`, 4000, true);
      text(step.source, `Expanded step "${s.id}" source`, 300, false, true);
      text(step.reply, `Expanded step "${s.id}" reply`, 500, false);
      list(step.files, `Expanded step "${s.id}" files`); list(step.avoid, `Expanded step "${s.id}" avoid`);
      const key = item === undefined ? s.id : `${s.id}[${i + 1}]`;
      cards.push({ key, step, after: [], ...(item === undefined ? {} : { item }) });
      keys.push(key);
    });
    keysOf.set(s.id, keys);
  }
  for (const c of cards) c.after = (c.step.after ?? []).flatMap((a) => keysOf.get(a) ?? [a]); // a board card's id stays as it is
  const total = cards.length + Number(!!plan.judge) + Number(!!plan.scribe);
  if (total > rules.maxSteps) errors.push(`This plan makes ${total} cards${total !== cards.length ? ` (${cards.length} steps and ${total - cards.length} standing roles)` : ""}; a run may have at most ${rules.maxSteps} (entomatical.orchestrator.caps total).`);
  return errors.length ? { errors } : { plan, cards, ...(judgeProvider ? { judgePermission: standingJudgePermission(judgeProvider, plan.permission ?? "bypass") } : {}) };
}

/** The check commands of a step, from the catalogue. */
export const stepCommands = (step: PlanStep, catalogue: Catalogue | undefined) => (step.checks ?? []).map((n) => catalogue?.[n]?.run).filter((c): c is string => !!c);

/** The one prompt template every card gets (the brief's four parts: goal, where to work, boundaries, what to reply), filled in by code. */
export function stepPrompt(plan: PlanFile, cards: PlanCard[], index: number, planCard: string, catalogue: Catalogue | undefined): string {
  const { step, after } = cards[index];
  const checks = (step.checks ?? []).map((n) => `${n} (${catalogue?.[n]?.run ?? "?"})`);
  const before = after.flatMap((k) => { const c = cards.find((x) => x.key === k); return c ? [`"${c.step.title}"`] : []; });
  return [
    `Step ${index + 1} of ${cards.length} of plan "${plan.name}" (plan card ${planCard}).${before.length ? ` Your branch starts from the plan's branch, which already holds ${before.join(", ")}.` : ""}`,
    `Goal:\n${step.goal.trim()}${step.source ? `\n\nThe full task is written down: read ${step.source.trim()} before you start, and follow it.` : ""}`,
    [
      `Work in: ${step.files?.length ? step.files.join(", ") : "the files the goal needs"}.`,
      `Do not touch: ${step.avoid?.length ? `${step.avoid.join(", ")}. Also never` : "never"} push, merge into main, or change settings or CLAUDE.md.`,
      checks.length ? `When you finish, the board runs these checks in your worktree: ${checks.join(", ")}. Run them yourself first and fix what fails.` : "",
      step.mayOpen ? "You may open your own cards for parts of this step (node ~/.entomatical/board.js add; the brief above says how). Merge each card you accept into this branch, mark it Done, and run board.js ready before your last reply. The board accepts this step only when every card you opened is Done or cancelled." : "",
      "Commit your work on this branch before you finish.",
      "Nobody can answer questions while you work. If something blocks you, stop and say what blocked you in your last reply.",
      `Your last reply must contain: ${(step.reply ?? DEFAULT_REPLY).trim()}.`,
    ].filter(Boolean).join("\n"),
  ].join("\n\n");
}

/** A card of the run: its board id and what it was made from. */
export interface StepCard { id: string; card: PlanCard }
/** The step list as the reviewer and the plan card show it: card id, title, checks and the cards it waits for. */
export function stepTable(rows: StepCard[]): string {
  const idOf = (k: string) => rows.find((r) => r.card.key === k)?.id ?? k;
  return rows.map(({ id, card: { step, after } }) => `- ${id}  "${step.title}"  checks: ${step.checks?.length ? step.checks.join(", ") : "none"}${step.judge ? "  JUDGE REQUIRED: do not merge until a pass for the exact revision" : ""}${step.mayOpen ? "  MAY OPEN CARDS: it accepts its own cards; it is ready for you only after it ran board.js ready" : ""}${after.length ? `  waits for: ${after.map(idOf).join(", ")}` : ""}`).join("\n");
}

/** The plan's variables for this run, one line, when it has any. */
const varLine = (plan: PlanFile) => plan.vars && Object.keys(plan.vars).length ? `\nVariables: ${Object.entries(plan.vars).map(([k, v]) => `${k} = ${v}`).join("; ")}` : "";

/** A checks-only plan card's text: what the board does with its steps. It runs no session. */
export const planCardText = (plan: PlanFile, file: string, rows: StepCard[]) =>
  `Plan "${plan.name}" from ${file}.${plan.about ? ` ${plan.about}` : ""}${varLine(plan)}\n\nThe board runs these steps in order. When a step's checks pass${plan.judge ? " and its requested judge verdict passes" : ""}, it merges the step into this card's branch and marks it Done.${plan.scribe ? " The scribe updates the approved documents at configured milestones." : ""} Press Finish on this card when every step is Done.\n\n${stepTable(rows)}`;

/** A model-reviewed plan card's first message: the reviewer brief, then this plan's steps (inline, as masterPrompt does). */
export const reviewerPrompt = (brief: string, plan: PlanFile, file: string, rows: StepCard[], repo: string) =>
  `${brief.trim()}\n\n---\n\nPlan "${plan.name}" from ${file}.${plan.about ? ` ${plan.about}` : ""}${varLine(plan)}${plan.deliveryChecks ? `\nBoard-run delivery checks: ${plan.deliveryChecks.join(", ")}. After integration, call board.js ready to start them. While they run, wait and check board.js show self. Repair failures on the plan branch. Call ready again for the current commit; only its success declares delivery ready.` : ""}\n${plan.mayOpen ? "Run approval allows you to open additional worker cards with board.js add --title T --prompt-file F [--runtime R]. Apply the same run limits and accept these cards before declaring ready." : "The plan lists your assignments. You may manage the listed cards. Opening additional cards requires a plan approved for delegation."}\nRepository: ${repo}. Step worktrees are .entomatical/wt/<card id> under it.\n\nSteps:\n${stepTable(rows)}${plan.judge ? "\n\nFor every marked step, do not merge or mark Done unless its standing judge has returned pass for the same checked commit. A fail or missing verdict is a hold, not a merge instruction." : ""}\n\nThis first turn: reply "Ready." and end your turn. The board wakes you when steps finish.`;

/** The preview before Run: one line per card, in order, with what it waits for and its checks. */
export function planPreview(plan: PlanFile, cards: PlanCard[], catalogue: Catalogue | undefined): string[] {
  if (plan.v === 2) return [plan.about ?? plan.name, `Governed run: ${plan.execution!.limits.active} active executions; ${plan.execution!.limits.directChildren} direct children; depth ${plan.execution!.limits.depth}; child profile ${plan.execution!.defaultChild}.`,
    `Reusable: ${plan.reusable}. Reviewer permissions: ${plan.reviewer?.permission ?? "no model reviewer"}. Scope is enforced at integration, not an OS or network sandbox.`,
    ...cards.map(({ key, step, after }) => `${key}: ${step.title}; after ${after.join(", ") || "none"}; worker permissions ${step.permission ?? plan.permission}; reads ${step.contract!.reads.join(", ")}; allowed writes ${step.contract!.writes.join(", ")}; evidence ${step.contract!.artifacts.join(", ")}; locks ${step.contract!.resources.join(", ") || "none"}; ${step.contract!.gate ? `operator gate: ${step.contract!.gate.action}; target ${step.contract!.gate.target}; candidate ${step.contract!.gate.candidate}` : "preparation (no operator gate)"}.`),
    "Run pins the effective manifest. Approve scope authorizes one dispatch; hardware authentication remains separate. Record result supplies acceptance evidence. Only accepted, integrated results release dependencies. Finish remains the owner's action."];
  const who = plan.review === "model" ? `A reviewer model${plan.reviewer?.model ? ` (${plan.reviewer.model})` : ""}${plan.reviewer?.account ?? plan.account ? ` on ${plan.reviewer?.account ?? plan.account}` : " on the default account"}${plan.reviewer?.effort ? ` · ${plan.reviewer.effort} effort` : ""} reads each finished step's changes, then merges it or sends one fix (reviewer permissions: ${plan.reviewer?.permission ?? "bypass"}).`
    : plan.judge || plan.scribe ? "The board runs the specified checks and event-driven standing roles before merging accepted work." : "The board merges each step when its checks pass. No model runs between steps.";
  const titleOf = (k: string) => cards.find((c) => c.key === k)?.step.title ?? k;
  return [
    plan.about ?? "",
    who,
    ...(plan.deliveryChecks ? [`Required on the integrated commit: ${plan.deliveryChecks.map(n => catalogue?.[n]?.run ?? n).join(", ")}.`] : []),
    ...(plan.mayOpen ? ["The reviewer may open additional cards within this run’s limits."] : []),
    ...(plan.judge ? [`Standing judge: ${plan.judge} on ${plan.account ?? "the default account"}; reviews the steps marked judge before acceptance. Claude uses plan mode, Codex uses a read-only sandbox, and the board refuses non-read ACP permission requests.`] : []),
    ...(plan.scribe ? [`Standing scribe: ${plan.scribe.model ?? "default model"} on ${plan.account ?? "the default account"}; ${plan.permission ?? "bypass"} permissions; updates ${plan.scribe.documents.join(", ")} after ${plan.scribe.after.join(", ")}.`] : []),
    ...(plan.judge || plan.scribe ? ["Standing roles start only when needed and use model calls when awakened."] : []),
    "",
    ...cards.map(({ step: s, after }, i) => `${i + 1}. ${s.title}${after.length ? ` · after ${after.map(titleOf).join(", ")}` : ""} · account: ${s.account ?? plan.account ?? "default"} · checks: ${(s.checks ?? []).map((n) => catalogue?.[n]?.run ?? n).join(", ") || "none"}${s.judge ? " · judged" : ""}${s.mayOpen ? " · may open its own cards" : ""}${s.model ?? plan.model ? ` · ${s.model ?? plan.model}` : ""}${s.effort ?? plan.effort ? ` · ${s.effort ?? plan.effort} effort` : ""} · ${s.permission ?? plan.permission ?? "bypass"} permissions`),
    "",
    "Run makes the plan card and its steps, and starts the steps that wait for nothing.",
  ].filter((l, i) => i > 0 || l);
}

export interface FoundPlan { file: string; rel: string; shared: boolean; name?: string; about?: string; vars?: Record<string, string>; error?: string }
/** JSON files in a workflows folder that are never plans. */
const NOT_PLANS = new Set(["checks.json"]);
/**
 * The plan files of a repo: shared ones in workflows/, then private ones in .entomatical/workflows/. Every .json file there is listed
 * (the user, 8 November 2026: a plan named without ".plan.json" was missing from the picker), except checks.json; one that is not a
 * plan says so in its row. In each folder the dated names (YYYY-MM-DD-, which hook/plan-folder.js gives every new plan; the user,
 * 14 November 2026) come first, newest first, then the undated ones by name.
 */
export function findPlanFiles(repo: string): FoundPlan[] {
  const out: FoundPlan[] = [];
  const dated = (n: string) => /^\d{4}-\d{2}-\d{2}-/.test(n);
  const order = (a: string, b: string) => (dated(a) !== dated(b) ? (dated(a) ? -1 : 1) : dated(a) && a.slice(0, 10) !== b.slice(0, 10) ? (a.slice(0, 10) < b.slice(0, 10) ? 1 : -1) : a < b ? -1 : a > b ? 1 : 0);
  for (const [dir, shared] of [[path.join(repo, "workflows"), true], [path.join(repo, ".entomatical", "workflows"), false]] as const) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".json") && !NOT_PLANS.has(n.toLowerCase())).sort(order); } catch { continue; }
    for (const n of names) {
      try { if (!fs.statSync(path.join(dir, n)).isFile()) continue; } catch { continue; }
      out.push(describePlanFile(repo, path.join(dir, n), shared));
    }
  }
  return out;
}

/** One plan file's row for the picker: its name, about and vars, or why it cannot be used. Works for a file anywhere on disk. */
export function describePlanFile(repo: string, file: string, shared = false): FoundPlan {
  const rel = path.relative(repo, file).split(path.sep).join("/");
  try {
    const p = loadPlanFile(file) as Partial<PlanFile>;
    if (!p || typeof p !== "object" || Array.isArray(p) || !Array.isArray(p.steps)) return { file, rel, shared, error: "not a plan file (it has no \"steps\" list)" };
    const vars = p.vars && typeof p.vars === "object" && !Array.isArray(p.vars) ? Object.fromEntries(Object.entries(p.vars).filter(([, v]) => typeof v === "string")) as Record<string, string> : undefined;
    return { file, rel, shared, name: typeof p.name === "string" ? p.name : undefined, about: typeof p.about === "string" ? p.about : undefined, ...(vars ? { vars } : {}) };
  } catch (e) { return { file, rel, shared, error: e instanceof Error ? e.message : String(e) }; }
}

/**
 * Plan first's planning prompt (F99; the user, 11 November 2026: "I'm not sure exactly what the prompt even is, so I would like that to
 * be printed in line"). The template is docs/orchestrator/PLANNER.md; {{guide}}, {{schema}} and {{checks}} become absolute paths, and
 * {{task}} the task as typed, last, so the webview's preview (media/board.js) fills the same text the card is sent.
 */
export function planningPrompt(template: string, paths: { guide: string; schema: string; checks: string; workflows?: string }, task?: string): string {
  // {{workflows}}: the main checkout's workflows/ folder, in the Codex template (PLANNER-CODEX.md), which has no F98 hook to move the file.
  const filled = template.replace(/\{\{guide\}\}/g, paths.guide).replace(/\{\{schema\}\}/g, paths.schema).replace(/\{\{checks\}\}/g, paths.checks)
    .replace(/\{\{workflows\}\}/g, paths.workflows ?? "workflows").trim();
  return task === undefined ? filled : filled.split("{{task}}").join(task.trim());
}

/** Runs git in dir: { ok, out } with trimmed stdout, or stderr when it failed. */
function git(dir: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  return { ok: r.status === 0, out: String((r.status === 0 ? r.stdout : r.stderr || r.stdout) || r.error || "").trim() };
}
/** Why the main checkout cannot take a commit now (the guards of hook/plan-folder.js commitPlan), or undefined. */
function noCommit(repo: string): string | undefined {
  const head = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!head.ok) return `git could not read the main checkout: ${head.out}`;
  if (head.out !== "main") return `the main checkout is on ${head.out}, not main`;
  for (const ref of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) if (git(repo, ["rev-parse", "-q", "--verify", ref]).ok) return `a ${ref.split("_")[0].toLowerCase()} is under way in the main checkout`;
  for (const d of ["rebase-merge", "rebase-apply"]) { const p = git(repo, ["rev-parse", "--git-path", d]); if (p.ok && fs.existsSync(path.resolve(repo, p.out))) return "a rebase is under way in the main checkout"; }
  return undefined;
}
const stampOf = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/**
 * A finished plan leaves Run a plan… (F99; the user, 11 November 2026: "The plan that it ran should be archived and no longer in the
 * active run a plan list"): its file moves to archive/ in its own folder, which findPlanFiles does not read. Only a file directly in
 * workflows/ or .entomatical/workflows/ moves; a plan picked by path elsewhere stays. In workflows/ the move is committed on main in the
 * main checkout (those two paths only, never pushed), as F98 commits a new plan; otherwise it is left for the user to commit, with why.
 * Returns the new repo-relative path, or undefined when the file was not in a plan folder or is gone.
 */
export function archivePlanFile(repo: string, rel: string, card?: string, now = new Date()): { to: string; committed?: string; skipped?: string } | undefined {
  const file = path.resolve(repo, rel), dir = path.dirname(file);
  const shared = path.join(repo, "workflows"), mine = path.join(repo, ".entomatical", "workflows");
  const same = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!same(dir, shared) && !same(dir, mine)) return undefined;
  if (!fs.existsSync(file)) return undefined;
  const archive = path.join(dir, "archive");
  fs.mkdirSync(archive, { recursive: true });
  const name = path.basename(file);
  let target = path.join(archive, name);
  if (fs.existsSync(target)) target = path.join(archive, name.replace(/(\.plan)?\.json$/i, (ext) => `-${stampOf(now)}${ext}`));
  const relOf = (f: string) => path.relative(repo, f).split(path.sep).join("/");
  const from = relOf(file), to = relOf(target);
  // A plan the user never committed is untracked: only a tracked old path goes into the commit's pathspec, or git refuses it.
  const tracked = same(dir, shared) && git(repo, ["ls-files", "--error-unmatch", "--", from]).ok;
  fs.renameSync(file, target);
  if (!same(dir, shared)) return { to };
  const why = noCommit(repo);
  if (why) return { to, skipped: why };
  const paths = tracked ? [from, to] : [to];
  const add = git(repo, ["add", "-A", "--", ...paths]);
  if (!add.ok) return { to, skipped: `git add failed: ${add.out}` };
  if (git(repo, ["diff", "--cached", "--quiet", "--", ...paths]).ok) return { to };
  const msg = `Archive plan file ${from}${card ? ` (plan card ${card})` : ""}\n\nMoved to ${to} by Entomatical (F99) when its run finished, so Run a plan… no longer lists it.`;
  const done = git(repo, ["commit", "-q", "-m", msg, "--", ...paths]);
  if (!done.ok) return { to, skipped: `git commit failed: ${done.out}` };
  const sha = git(repo, ["rev-parse", "--short", "HEAD"]);
  return { to, committed: sha.ok ? sha.out : "?" };
}

/** The file's JSON, or an error that says it is not valid JSON. */
export function loadPlanFile(file: string): unknown {
  const text = fs.readFileSync(file, "utf8");
  try { return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch (e) { throw new Error(`not valid JSON (${e instanceof Error ? e.message : String(e)})`); }
}
