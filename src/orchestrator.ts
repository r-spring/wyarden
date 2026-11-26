// The orchestrator's rules (spec docs/agents/README.md: 4.1, 4.3, 5.3, section 8; F69, F71, F75, F76;
// 4 November 2026): inbox requests, their validation and refusals, the run's membership and caps, the prompt prefix, the plan
// summary, settle notices, account headroom and the headless command line. Pure of VS Code and of the file system, so tests
// drive every refusal directly. The board (src/board.ts) reads and writes the files and runs the sessions.
import * as path from "path";
import type { Caps, Task } from "./board";
import { inCatalogue, type Catalogue } from "./checks";
import type { StatusRecord } from "./status-line";
import type { Usage } from "./sessions";
import { snapshotProblem, type Selection as ProfileSelection } from "./profiles";

export const DEFAULT_CAPS: Caps = { open: 4, total: 600, depth: 4, followUps: 3, pending: 3, watchers: 3, perWatcher: 4 };
/** Caps from settings or a root plan proposal. Approval fixes one budget for the whole tree. */
export function capsFrom(raw: unknown): Caps {
  const r = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const n = (k: keyof Caps, d: number) => (typeof r[k] === "number" && Number.isFinite(r[k] as number) && (r[k] as number) >= 0 ? Math.floor(r[k] as number) : d);
  const caps: Caps = { open: n("open", 4), total: n("total", 600), depth: Math.min(8, n("depth", 4)), followUps: n("followUps", 3), pending: n("pending", 3), watchers: n("watchers", 3), perWatcher: n("perWatcher", 4) };
  if (typeof r.pointsFiveHour === "number" && Number.isFinite(r.pointsFiveHour) && r.pointsFiveHour > 0) caps.pointsFiveHour = r.pointsFiveHour;
  if (typeof r.points === "number" && Number.isFinite(r.points) && r.points > 0) caps.points = r.points;
  if (r.mayClaim === 1) caps.mayClaim = 1;
  return caps;
}
/** Caps keys a plan may propose beyond DEFAULT_CAPS. mayClaim (F95) is 0 or 1: whether the run's coordinators may claim too. */
export const EXTRA_CAPS = ["pointsFiveHour", "points", "mayClaim"];

/** Every runtime a card can run on; Grok and Antigravity speak ACP (src/acp.ts). */
export const RUNTIMES = ["claude", "codex", "grok", "antigravity"] as const;
export type Runtime = typeof RUNTIMES[number];
export const OPS = ["add", "send", "receive", "stop", "resume", "done", "cancel", "adopt", "rebind", "ready", "note", "plan", "discard", "switch", "finish", "screen", "type",
  "claim", "claim-tree", "request-takeover", "handoff", "turn-done", "submit", "integrate", "readiness", "council"] as const;
export type Op = typeof OPS[number];
export interface RunPolicy { allow: string[]; deny: string[]; noSync: boolean }
/** Accept both the UI aliases and the full Claude model identifiers reported by sessions. */
export const normalizeModel = (model: string) => /^claude-(opus|sonnet|haiku|fable)(?:-[\d-]+)?$/i.exec(model)?.[1].toLowerCase() ?? model;
export interface Request {
  v: 1; op: Op; by: string; session: string | null; at: string; nonce: string;
  title?: string; prompt?: string; parent?: string | null; account?: string | null; model?: string | null; effort?: string | null; permission?: string | null;
  completion?: { commands: string[]; doneWhen?: string; goal?: string } | null; autoRule?: boolean; after?: string[]; start?: "auto" | "manual"; mayOpen?: boolean;
  id?: string; text?: string; self?: true; inferredEditor?: true;
  runtime?: Runtime;
  /** screen (F89): how many lines of the card terminal to return. type (F89): named keys, Enter after the text, type over the user's input. */
  lines?: number; keys?: string[]; enter?: boolean; override?: boolean;
  role?: "judge" | "scribe" | "research";
  judge?: boolean;
  watch?: string[];
  caps?: Partial<Caps>;
  policy?: RunPolicy;
  /** claim, claim-tree, request-takeover, handoff (F95): why, for the audit record and the user. handoff: the receiving card. */
  reason?: string; to?: string;
  /** Phase 3: the client's protocol (GOVERNED_PROTOCOL carries governed fields); governed runs refuse older clients. */
  protocol?: number;
  /** Phase 3 add: the child's profile ref, its bounded assignment, and a narrowed delegation for a coordinator. */
  profile?: string; assignment?: Assignment; delegate?: Partial<Delegation>;
  /** Phase 3 submit: the handoff of a governed child. */
  head?: string; base?: string; summary?: string; files?: string[]; claimedChecks?: string[]; limitations?: string; decisions?: string[]; covers?: string[];
  /** Phase 5 council (the root only): convene a checkpoint, reconcile its findings, retry a member, or show the record. */
  action?: "convene" | "reconcile" | "retry" | "show"; checkpoint?: string; member?: string; dispositions?: unknown[];
}
const ID = /^[0-9a-f]{6}$/;
/** The key names board.js type accepts (TERMINAL_KEYS in cardTerminal.ts holds their bytes). */
export const TYPE_KEYS = ["enter", "escape", "tab", "shift-tab", "backspace", "up", "down", "right", "left", "ctrl-c", "ctrl-d", "ctrl-l", "ctrl-u", "ctrl-o", "ctrl-r", "ctrl-t"];
const FIELDS: Record<Op, string[]> = {
  add: ["title", "prompt", "parent", "account", "model", "effort", "permission", "completion", "autoRule", "after", "start", "mayOpen", "runtime", "role", "judge", "watch", "profile", "assignment", "delegate"],
  send: ["id", "text"], receive: ["inferredEditor"], stop: ["id"], resume: ["id"], done: ["id"], cancel: ["id"], adopt: ["id"], rebind: [], ready: [], note: ["text"], plan: ["caps", "policy"],
  discard: ["id"], switch: ["id", "account"], finish: ["self", "id"], screen: ["id", "lines"], type: ["id", "text", "keys", "enter", "override"],
  claim: ["id", "reason"], "claim-tree": ["id", "reason"], "request-takeover": ["id", "reason"], handoff: ["id", "self", "to", "reason"], "turn-done": [],
  submit: ["head", "base", "summary", "files", "claimedChecks", "limitations", "decisions", "covers"],
  integrate: ["id"], readiness: ["id"], council: ["action", "checkpoint", "member", "dispositions"],
};
const COMMON = ["v", "op", "by", "session", "at", "nonce", "protocol"];
export const PROMPT_CAP = 24_000, TITLE_CAP = 200;

/** A request file's content against the fixed schema: unknown keys refused, texts capped, enums checked. */
export function validateRequest(raw: unknown, nonce: string): { request: Request } | { error: string } {
  const e = (error: string) => ({ error });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return e("Not a request object");
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return e("Unknown request version");
  if (typeof r.op !== "string" || !(OPS as readonly string[]).includes(r.op)) return e(`Unknown op ${String(r.op)}`);
  const op = r.op as Op;
  if (typeof r.by !== "string" || !ID.test(r.by)) return e("Missing by: run this from a task session (ENTOMATICAL_TASK)");
  if (r.session !== undefined && r.session !== null && typeof r.session !== "string") return e("session must be a string");
  for (const k of Object.keys(r)) if (!COMMON.includes(k) && !FIELDS[op].includes(k)) return e(`Unknown field "${k}" for ${op}`);
  const str = (k: string, cap: number, required: boolean): string | undefined => {
    const v = r[k];
    if (v === undefined || v === null) { if (required) throw new Error(`${op} needs ${k}`); return undefined; }
    if (typeof v !== "string") throw new Error(`${k} must be text`);
    if (required && !v.trim()) throw new Error(`${op} needs ${k}`);
    if (v.length > cap) throw new Error(`${k} is longer than ${cap} characters`);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)) throw new Error(`${k} contains control characters`);
    return v;
  };
  try {
    const request: Request = { v: 1, op, by: r.by, session: typeof r.session === "string" ? r.session : null, at: typeof r.at === "string" ? r.at : new Date().toISOString(), nonce };
    if (r.protocol !== undefined) { if (!Number.isInteger(r.protocol) || (r.protocol as number) < 1) return e("protocol must be a whole number"); request.protocol = r.protocol as number; }
    if (r.inferredEditor !== undefined) {
      if (r.inferredEditor !== true) return e("inferredEditor must be true");
      request.inferredEditor = true;
    }
    const list = (k: string, max: number, cap: number, re?: RegExp): string[] | undefined => {
      const v = r[k];
      if (v === undefined || v === null) return undefined;
      if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === "string" && x.trim() && x.length <= cap && !/[\x00-\x1f\x7f]/.test(x) && (!re || re.test(x)))) throw new Error(`${k} must be a list of up to ${max} texts`);
      return (v as string[]).map((x) => x.trim());
    };
    if (op === "add") {
      request.title = str("title", TITLE_CAP, true)!.trim(); request.prompt = str("prompt", PROMPT_CAP, true)!;
      request.parent = str("parent", 6, false) ?? null;
      if (request.parent && !ID.test(request.parent)) return e("parent is not a card id");
      request.account = str("account", 200, false) ?? null; request.model = str("model", 40, false) ?? null; request.effort = str("effort", 20, false) ?? null; request.permission = str("permission", 20, false) ?? null;
      if (r.completion !== undefined && r.completion !== null) {
        const c = r.completion as Record<string, unknown>;
        if (!c || typeof c !== "object" || !Array.isArray(c.commands) || c.commands.length > 10 || !c.commands.every((x) => typeof x === "string" && x.length <= 400)) return e("completion needs commands: up to ten strings");
        request.completion = { commands: c.commands as string[], ...(typeof c.doneWhen === "string" ? { doneWhen: c.doneWhen.slice(0, 1000) } : {}), ...(typeof c.goal === "string" ? { goal: c.goal.slice(0, 1000) } : {}) };
      } else request.completion = null;
      request.autoRule = r.autoRule === true;
      if (r.after !== undefined && (!Array.isArray(r.after) || r.after.length > 20 || !r.after.every((x) => typeof x === "string" && ID.test(x)))) return e("after must be a list of card ids");
      request.after = (r.after as string[] | undefined) ?? [];
      if (r.start !== undefined && r.start !== "auto" && r.start !== "manual") return e("start must be auto or manual");
      request.start = (r.start as "auto" | "manual" | undefined) ?? "auto";
      request.mayOpen = r.mayOpen === true;
      if (r.role !== undefined && !["judge", "scribe", "research"].includes(String(r.role))) return e("role must be judge, scribe or research");
      if (r.role) request.role = r.role as Request["role"];
      if (r.judge !== undefined && typeof r.judge !== "boolean") return e("judge must be true or false");
      if (r.judge !== undefined) request.judge = r.judge === true;
      if (r.watch !== undefined && (!Array.isArray(r.watch) || !r.watch.length || r.watch.length > 20 || !r.watch.every((id) => typeof id === "string" && ID.test(id)) || new Set(r.watch).size !== r.watch.length)) return e("watch must be a nonempty list of distinct card ids");
      if (r.watch) request.watch = r.watch as string[];
      if (request.watch && (!request.mayOpen || request.role)) return e("watch needs --may-open and cannot be a fixed role");
      if (request.role && request.mayOpen) return e("A fixed role cannot open cards");
      if (request.role && request.judge) return e("A fixed role cannot itself request judgment");
      if (r.runtime !== undefined && !(RUNTIMES as readonly unknown[]).includes(r.runtime)) return e(`runtime must be ${RUNTIMES.slice(0, -1).join(", ")} or ${RUNTIMES.at(-1)}`);
      if (r.runtime) request.runtime = r.runtime as Runtime;
      if (request.model) request.model = normalizeModel(request.model);
      // Phase 3: requests only name a profile and narrow; nothing here can widen the run's trusted configuration.
      if (r.profile !== undefined) request.profile = str("profile", 300, true)!.trim();
      if (r.assignment !== undefined) {
        const a = r.assignment as Record<string, unknown>;
        if (!a || typeof a !== "object" || Array.isArray(a)) return e("assignment must be an object");
        for (const k of Object.keys(a)) if (!["key", "outcome", "owns", "acceptance", "evidence", "returns"].includes(k)) return e(`Unknown assignment field "${k}"`);
        if (typeof a.key !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(a.key)) return e("assignment.key must be 1 to 64 letters, digits, dot, dash or underscore");
        if (typeof a.outcome !== "string" || !a.outcome.trim() || a.outcome.length > 1000) return e("assignment.outcome must be a text of up to 1000 characters");
        const ctl = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/; // pasted into prompts and notices
        if (ctl.test(a.outcome)) return e("assignment.outcome contains control characters");
        const sub = (k: string, max: number, cap: number) => { const v = a[k]; if (v === undefined) return undefined; if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === "string" && x.trim() && x.length <= cap && !ctl.test(x))) throw new Error(`assignment.${k} must be a list of up to ${max} texts without control characters`); return (v as string[]).map((x) => x.trim()); };
        if (a.returns !== undefined && (typeof a.returns !== "string" || a.returns.length > 500 || ctl.test(a.returns))) return e("assignment.returns must be a text of up to 500 characters without control characters");
        const owns = sub("owns", 20, 200), acceptance = sub("acceptance", 20, 40), evidence = sub("evidence", 10, 200);
        request.assignment = { key: a.key, outcome: a.outcome.trim(), ...(owns ? { owns } : {}), ...(acceptance ? { acceptance } : {}), ...(evidence ? { evidence } : {}), ...(typeof a.returns === "string" && a.returns.trim() ? { returns: a.returns.trim() } : {}) };
      }
      if (r.delegate !== undefined) {
        const d = r.delegate as Record<string, unknown>;
        if (!d || typeof d !== "object" || Array.isArray(d) || Object.keys(d).some((k) => !["allowed", "defaultChild", "depth"].includes(k))) return e("delegate takes allowed, defaultChild and depth");
        if (d.allowed !== undefined && (!Array.isArray(d.allowed) || d.allowed.length > 20 || !d.allowed.every((x) => typeof x === "string" && x.length <= 300))) return e("delegate.allowed must be a list of profile refs");
        if (d.defaultChild !== undefined && typeof d.defaultChild !== "string") return e("delegate.defaultChild must be a profile ref");
        if (d.depth !== undefined && !Number.isInteger(d.depth)) return e("delegate.depth must be a whole number");
        request.delegate = { ...(d.allowed ? { allowed: d.allowed as string[] } : {}), ...(typeof d.defaultChild === "string" ? { defaultChild: d.defaultChild } : {}), ...(d.depth !== undefined ? { depth: d.depth as number } : {}) };
        if (!request.mayOpen) return e("delegate needs --may-open: a worker opens no cards");
      }
    } else if (op === "submit") {
      request.head = str("head", 64, true)!.trim();
      if (!/^[0-9a-f]{7,64}$/.test(request.head)) return e("head must be a commit id");
      const base = str("base", 64, false)?.trim();
      if (base !== undefined) { if (!/^[0-9a-f]{7,64}$/.test(base)) return e("base must be a commit id"); request.base = base; }
      request.summary = str("summary", 4000, true)!.trim();
      const files = list("files", 200, 400), checks = list("claimedChecks", 20, 400), decisions = list("decisions", 10, 500), covers = list("covers", 40, 40);
      if (files) request.files = files; if (checks) request.claimedChecks = checks; if (decisions) request.decisions = decisions; if (covers) request.covers = covers;
      const limitations = str("limitations", 2000, false)?.trim();
      if (limitations) request.limitations = limitations;
    } else if (op === "council") {
      if (!["convene", "reconcile", "retry", "show"].includes(r.action as string)) return e("council action must be convene, reconcile, retry or show");
      request.action = r.action as Request["action"];
      const cp = str("checkpoint", 20, request.action !== "show");
      if (cp !== undefined) { if (!["plan", "milestone", "final"].includes(cp)) return e("checkpoint must be plan, milestone or final"); request.checkpoint = cp; }
      if (request.action === "retry") { request.member = str("member", 40, true)!.trim(); }
      if (request.action === "reconcile") {
        if (!Array.isArray(r.dispositions) || !r.dispositions.length || r.dispositions.length > 100 || JSON.stringify(r.dispositions).length > 100_000) return e("reconcile needs dispositions: a list of 1 to 100 (finding, disposition, evidence, rationale)");
        request.dispositions = r.dispositions as unknown[];
      } else if (r.dispositions !== undefined) return e("dispositions belong to council reconcile");
      if (request.action !== "retry" && r.member !== undefined) return e("member belongs to council retry");
    } else if (op === "plan") {
      if (r.caps !== undefined) {
        if (!r.caps || typeof r.caps !== "object" || Array.isArray(r.caps)) return e("caps must be an object");
        for (const [k, v] of Object.entries(r.caps)) if (![...Object.keys(DEFAULT_CAPS), ...EXTRA_CAPS].includes(k) || typeof v !== "number" || !Number.isFinite(v) || v < 0 || !Number.isInteger(v)) return e(`Invalid cap ${k}`);
        if ((r.caps as Caps).depth > 8) return e("depth must be at most 8");
        if ((r.caps as Caps).mayClaim !== undefined && (r.caps as Caps).mayClaim! > 1) return e("mayClaim must be 0 or 1");
        request.caps = r.caps as Partial<Caps>;
      }
      if (r.policy !== undefined) {
        const p = r.policy as RunPolicy;
        if (!p || typeof p !== "object" || Object.keys(p).some((k) => !["allow", "deny", "noSync"].includes(k)) || ![p.allow, p.deny].every((a) => Array.isArray(a) && a.length <= 30 && a.every((s) => typeof s === "string" && s.length <= 200)) || typeof p.noSync !== "boolean") return e("policy needs allow/deny string lists and noSync boolean");
        request.policy = p;
      }
    } else if (op === "rebind" || op === "receive" || op === "ready" || op === "turn-done") {
      if (op === "rebind" && !request.session?.trim()) return e("rebind needs this session's identity");
    } else if (op === "note") request.text = str("text", 1000, true)!.trim();
    else if (op === "finish") {
      // Two forms, never both. `finish self` is a request: the board reviews the run and finishes it on Done (F97 section 9).
      // `finish <id>` (F120) closes another card whose work is in the target already. Neither is a merge, push, install or publish verb.
      if (r.self === true) { if (r.id !== undefined) return e("finish takes a card id or self, not both"); request.self = true; }
      else if (r.self !== undefined) return e("self must be true");
      else {
        const id = str("id", 6, false);
        if (id === undefined) return e("finish needs self: true (your own card's run) or the id of a card whose work has landed");
        if (!ID.test(id)) return e("id is not a card id");
        request.id = id;
      }
    } else if (op === "handoff") {
      // F95: one card (with its subtree) or `self`, every open card the caller opened, to another orchestrator card.
      if (r.self === true) { if (r.id !== undefined) return e("handoff takes a card id or self, not both"); request.self = true; }
      else if (r.self !== undefined) return e("self must be true");
      else { request.id = str("id", 6, true)!; if (!ID.test(request.id)) return e("id is not a card id"); }
      request.to = str("to", 6, true)!;
      if (!ID.test(request.to)) return e("to is not a card id");
      const reason = str("reason", 500, false)?.trim();
      if (reason) request.reason = reason;
    } else {
      request.id = str("id", 6, true)!;
      if (!ID.test(request.id)) return e("id is not a card id");
      if (op === "claim" || op === "claim-tree" || op === "request-takeover") request.reason = str("reason", 500, true)!.trim();
      if (op === "send") request.text = str("text", PROMPT_CAP, true)!;
      if (op === "switch") request.account = str("account", 200, true)!.trim();
      if (op === "screen" && r.lines !== undefined) {
        if (typeof r.lines !== "number" || !Number.isInteger(r.lines) || r.lines < 1 || r.lines > 500) return e("lines must be a whole number from 1 to 500");
        request.lines = r.lines;
      }
      if (op === "type") {
        // Text may hold tabs and newlines (a newline sends it as one paste) but no other control characters: those go as named keys.
        request.text = str("text", 8000, false);
        if (r.keys !== undefined) {
          if (!Array.isArray(r.keys) || r.keys.length > 20 || r.keys.some((k) => typeof k !== "string" || !TYPE_KEYS.includes(k))) return e(`keys must be up to 20 of: ${TYPE_KEYS.join(", ")}`);
          request.keys = r.keys as string[];
        }
        for (const k of ["enter", "override"] as const) if (r[k] !== undefined) { if (typeof r[k] !== "boolean") return e(`${k} must be true or false`); request[k] = r[k] as boolean; }
        if (!request.text && !request.keys?.length && !request.enter) return e("type needs text, keys or enter");
      }
    }
    return { request };
  } catch (err) { return e(err instanceof Error ? err.message : String(err)); }
}

/** A card's ancestors by parentId: its parent, grandparent and so on (F89). */
export function ancestorsOf(task: Task, tasks: Task[]): Task[] {
  const out: Task[] = [], seen = new Set([task.id]);
  for (let t: Task | undefined = task; t?.parentId && out.length < 20;) {
    const p = tasks.find((x) => x.id === t!.parentId);
    if (!p || seen.has(p.id)) break;
    seen.add(p.id); out.push(p); t = p;
  }
  return out;
}

/** The run's top orchestrator for a card with orchestrator rights (itself, or its root for a --may-open child). */
export function runRoot(task: Task, tasks: Task[]): Task | undefined {
  return task.orchestrator ? tasks.find((t) => t.id === (task.orchestrator!.root ?? task.id)) ?? task : undefined;
}
/** Every card of the run below the root: the cards whose openedBy chain reaches it. */
export function runCards(rootId: string, tasks: Task[]): Task[] {
  const inRun = new Set([rootId]);
  for (let grew = true; grew;) { grew = false; for (const t of tasks) if (t.openedBy && inRun.has(t.openedBy) && !inRun.has(t.id)) { inRun.add(t.id); grew = true; } }
  return tasks.filter((t) => t.id !== rootId && inRun.has(t.id));
}
/** How far below the master a card sits: 0 for the master, 1 for its children. */
export function depthOf(task: Task, tasks: Task[]): number {
  let d = 0;
  for (let t: Task | undefined = task; t?.openedBy && d < 10; d++) t = tasks.find((x) => x.id === t!.openedBy);
  return d;
}
/** The master of the run a card belongs to (its openedBy chain's top, or itself when it is a master). */
export function masterOf(task: Task, tasks: Task[]): Task | undefined {
  let t: Task | undefined = task;
  for (let i = 0; t?.openedBy && i < 10; i++) t = tasks.find((x) => x.id === t!.openedBy);
  return t?.orchestrator && !t.orchestrator.root ? t : t;
}

/** Plan definitions pre-create all assignments. A queued sibling only occupies a slot once its launch begins. */
export function planCapacityWait(task: Task, tasks: Task[], starting?: (id: string) => boolean): string | undefined {
  const root = task.openedBy ? masterOf(task, tasks) : undefined;
  if (!root?.planRun || !root.orchestrator) return undefined;
  const parents = new Set<string>();
  for (let id = task.openedBy; id && !parents.has(id); id = tasks.find(t => t.id === id)?.openedBy) parents.add(id);
  const open = runCards(root.id, tasks).filter(t => t.id !== task.id && !parents.has(t.id) && !t.cancelled && t.status !== "done"
    && (!!t.sessionId || t.cardTerminalStarted || t.status === "running" || t.status === "needs-input" || starting?.(t.id))).length;
  const cap = root.orchestrator.caps.open;
  return open >= cap ? `Waiting for run capacity (${open} of ${cap} open)` : undefined;
}

export interface RightsContext {
  enabled: boolean;
  now: number;
  /** When each orchestrator's last request was processed (ms). */
  lastRequestAt: Map<string, number>;
  /** The least time between two requests of one orchestrator (section 8 item 6: 1000 ms; tests shorten it). */
  rateMs?: number;
  /** Whether the card's process is still alive (a hidden run ending, a terminal): busy even when its events say Review. */
  live?: (task: Task) => boolean;
  /** A queued card with a launch already in preparation occupies a plan slot. */
  starting?: (id: string) => boolean;
  /** Requests of one orchestrator still unprocessed in the inbox. */
  unprocessed: (by: string) => number;
  capsOf: (root: Task) => Caps;
  catalogue?: Catalogue;
  accountSignedIn: (name: string) => boolean;
  /** The provider of a signed-in account ("codex"), undefined for Claude or an unknown name. */
  providerOf?: (name: string) => string | undefined;
  accountUsage: (name: string | null) => Usage | undefined;
  models: string[]; efforts: string[]; permissions: string[];
  /** Real session evidence, not merely an allocated session id. */
  everReady?: (task: Task) => boolean;
  /** F95: whether any session of the card runs anywhere (Board.live: terminals, card terminals, Codex, found sessions); default `live`. */
  alive?: (task: Task) => boolean;
  /** F95: the wall clock (ms), for how long a holder has been idle; `now` above is a monotonic clock. */
  wallNow?: number;
  /** F95: when a card last did anything (ms): its column change or its last activity. Default: statusAt, else updatedAt. */
  idleSince?: (task: Task) => number;
  /** F95: how long a holder in Review, Queued or Needs input must have been idle before its cards may be claimed (default 30 min). */
  claimGraceMs?: number;
}

// ---- F95: claim, claim-tree, request-takeover and handoff (docs/agents/README.md) ----

/** One change of a card's controller, kept on the card (last 10) and in .entomatical/transfers.jsonl. */
export interface Transfer { op: "takeover" | "handoff"; via: "claim" | "claim-tree" | "request" | "handoff" | "operator" | "adopt"; id: string; from: string | null; to: string; by: string; reason?: string; approvedBy?: string; at: string }
export const CLAIM_GRACE_MS = 30 * 60_000;
/** An automatically claimed card stays with its claimer this long, so two orphan collectors cannot pass it back and forth. */
export const CLAIM_HOLD_MS = 60 * 60_000;
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + " UTC";
const agoText = (ms: number, now: number) => { const m = Math.max(0, Math.round((now - ms) / 60_000)); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const wall = (ctx: RightsContext) => ctx.wallNow ?? Date.now();
const idleFrom = (t: Task, ctx: RightsContext) => ctx.idleSince?.(t) ?? (Date.parse(t.statusAt ?? t.updatedAt) || 0);
/** A session is running for the card: its column says so, or its process is still alive. */
export const isLive = (t: Task, ctx: RightsContext) => t.status === "running" || !!(ctx.alive ?? ctx.live)?.(t);
/** The cards that hold a card: its opener chain up to the master, then its watcher when that is another card. Ids of deleted cards stay. */
export function holdersOf(task: Task, tasks: Task[]): { id: string; task?: Task }[] {
  const out: { id: string; task?: Task }[] = [], seen = new Set([task.id]);
  for (let id = task.openedBy; id && !seen.has(id) && out.length < 12;) { seen.add(id); const t = tasks.find((x) => x.id === id); out.push({ id, task: t }); id = t?.openedBy; }
  if (task.watchedBy && !seen.has(task.watchedBy)) out.push({ id: task.watchedBy, task: tasks.find((x) => x.id === task.watchedBy) });
  return out;
}
/** Whether a holder has let go of its cards: gone, Done, cancelled, or idle with no live session for `grace` ms. */
export function holderIdle(t: Task | undefined, ctx: RightsContext, grace: number): boolean {
  if (!t || t.status === "done" || t.cancelled) return true;
  if (isLive(t, ctx)) return false;
  return wall(ctx) - idleFrom(t, ctx) >= grace;
}
/** A holder's state in a refusal: "running", "done 23 h ago", "review, idle 12 min ago", "no longer on the board". */
export function holderState(t: Task | undefined, ctx: RightsContext): string {
  if (!t) return "no longer on the board";
  if (t.cancelled) return "cancelled";
  if (t.status === "done") return `done ${agoText(Date.parse(t.statusAt ?? t.updatedAt) || 0, wall(ctx))}`;
  if (isLive(t, ctx)) return t.status === "running" ? "running" : `${t.status}, session live`;
  return `${t.status}, idle since ${agoText(idleFrom(t, ctx), wall(ctx))}`;
}
const askHint = (id: string) => `Ask with \`board.js request-takeover ${id} --reason "..."\``;
/** The last automatic claim of a card still inside its hold. */
function heldClaim(t: Task, ctx: RightsContext): Transfer | undefined {
  const last = t.transfers?.at(-1);
  return last && (last.via === "claim" || last.via === "claim-tree") && wall(ctx) - Date.parse(last.at) < CLAIM_HOLD_MS ? last : undefined;
}
/** Whether a card is already the caller's: in its run (openedBy chain) or watched by it. */
export const isOwn = (by: Task, t: Task, tasks: Task[]) => t.watchedBy === by.id || runCards(by.id, tasks).some((x) => x.id === t.id);
/** The caller's right to claim at all (root, or a coordinator whose run's caps carry mayClaim 1) under an approved, unpaused run. */
function claimAuthority(by: Task, tasks: Task[], ctx: RightsContext, id: string): string | undefined {
  const root = runRoot(by, tasks) ?? by;
  if (by.orchestrator?.root && !(ctx.capsOf(root).mayClaim ?? 0)) return `claim: only the run's root may claim, or a coordinator whose approved plan has mayClaim 1. ${askHint(id)}.`;
  if (!root.approved || root.paused) return "Run must be approved and unpaused";
  return undefined;
}
/** A plan-file run claiming from an earlier run of the same plan file (supersession): no idle wait for the old holders. */
const samePlanFile = (by: Task, target: Task, tasks: Task[]) => { const mine = (runRoot(by, tasks) ?? by).planRun?.file, theirs = masterOf(target, tasks)?.planRun?.file; return !!mine && mine === theirs; };

/** Why `claim` may not move this card to the caller automatically, or undefined when it may (F95 item 1). */
export function claimRefusal(by: Task, target: Task, tasks: Task[], ctx: RightsContext): string | undefined {
  const authority = claimAuthority(by, tasks, ctx, target.id);
  if (authority) return authority;
  if (target.id === by.id || isOwn(by, target, tasks)) return `claim: card ${target.id} is already yours`;
  if (runCards(target.id, tasks).some((t) => t.id === by.id)) return `claim: card ${target.id} holds your own card; that would create a cycle`;
  const root = runRoot(by, tasks) ?? by;
  if (!target.openedBy && target.orchestrator) return `claim: card ${target.id} is a run's root; \`board.js claim-tree ${target.id} --reason "..."\` takes what its run left behind`;
  if (!target.openedBy) return `Card ${target.id} is the user's: no orchestrator opened it. ${root.planRun ? askHint(target.id) : `Adopt it (\`board.js adopt ${target.id}\`), or ${askHint(target.id).replace(/^Ask/, "ask")}`}.`;
  for (let owner = by.openedBy, depth = 0; owner && depth < 10; depth++) {
    if (target.openedBy === owner) return `Card ${target.id} is assigned to ancestor ${owner}; only that coordinator can change this assignment`;
    owner = tasks.find((t) => t.id === owner)?.openedBy;
  }
  const hold = heldClaim(target, ctx);
  if (hold) return `Card ${target.id} was claimed by ${hold.to} at ${hhmm(Date.parse(hold.at))}; it stays with ${hold.to} for an hour so collectors do not pass it back and forth. Message ${hold.to} (\`board.js send ${hold.to} --text "..."\`).`;
  if (target.takenOver) return `the user took card ${target.id} over himself. ${askHint(target.id)}.`;
  if (isLive(target, ctx)) return `Card ${target.id} has a live session (${target.status}); claim never moves a live session. ${askHint(target.id)}.`;
  const below = runCards(target.id, tasks).find((t) => isLive(t, ctx));
  if (below) return `Card ${below.id} under ${target.id} has a live session; claim never moves a live session. ${askHint(target.id)}.`;
  const grace = samePlanFile(by, target, tasks) ? 0 : ctx.claimGraceMs ?? CLAIM_GRACE_MS;
  for (const h of holdersOf(target, tasks)) if (!holderIdle(h.task, ctx, grace))
    return `Card ${target.id} is controlled by ${h.id} (${holderState(h.task, ctx)}). ${askHint(target.id)} or message the owner (\`board.js send ${h.id} --text "..."\`).`;
  return undefined;
}

/** What `claim-tree` takes from a finished or dead root (F95 item 2): the tops it moves, every card that moves, and what stays and why. */
export interface ClaimTree { tops: Task[]; moved: string[]; live: string[]; waiting: string[] }
export function claimTree(by: Task, root: Task, tasks: Task[], ctx: RightsContext): ClaimTree | { error: string } {
  const authority = claimAuthority(by, tasks, ctx, root.id);
  if (authority) return { error: authority };
  if (!root.orchestrator) return { error: `claim-tree: card ${root.id} is not an orchestrator; use claim ${root.id}` };
  if (root.id === by.id || isOwn(by, root, tasks) || runCards(root.id, tasks).some((t) => t.id === by.id)) return { error: `claim-tree: card ${root.id} is in your own run` };
  const grace = samePlanFile(by, root, tasks) ? 0 : ctx.claimGraceMs ?? CLAIM_GRACE_MS;
  for (const h of [{ id: root.id, task: root }, ...holdersOf(root, tasks)]) if (!holderIdle(h.task, ctx, grace))
    return { error: `Card ${h.id} is ${holderState(h.task, ctx)}; claim-tree takes only a finished or idle run. ${askHint(root.id)} or message it (\`board.js send ${h.id} --text "..."\`).` };
  const cards = runCards(root.id, tasks).filter((t) => !isOwn(by, t, tasks));
  const live = cards.filter((t) => isLive(t, ctx));
  // A live card keeps its holders and everything under it: the cards above it up to the root, and the cards it holds or watches.
  const blocked = new Set<string>();
  for (const l of live) {
    blocked.add(l.id);
    for (const a of holdersOf(l, tasks)) blocked.add(a.id);
    for (const d of runCards(l.id, tasks)) blocked.add(d.id);
    for (const w of cards) if (w.watchedBy === l.id) blocked.add(w.id);
  }
  for (const t of cards) if (t.takenOver || heldClaim(t, ctx)) blocked.add(t.id);
  const movable = cards.filter((t) => !blocked.has(t.id) && t.status !== "done" && !t.cancelled);
  const ids = new Set(movable.map((t) => t.id));
  const tops = movable.filter((t) => !t.openedBy || !ids.has(t.openedBy));
  const moved = [...new Set([...tops, ...tops.flatMap((t) => runCards(t.id, tasks))].map((t) => t.id))];
  return { tops, moved, live: live.map((t) => t.id), waiting: cards.filter((t) => blocked.has(t.id) && !live.includes(t)).map((t) => t.id) };
}
/** handoff self: every open card the caller opened. */
export const heldBy = (by: Task, tasks: Task[]) => tasks.filter((t) => t.openedBy === by.id && t.status !== "done" && !t.cancelled);

/** The ownership refusal (F95 item 6): who controls the card, how it stands, and the verb that would work, ids filled in. */
export function ownershipRefusal(by: Task, target: Task, tasks: Task[], ctx: RightsContext): string {
  const root = runRoot(by, tasks) ?? by;
  if (!target.openedBy && target.orchestrator) {
    const tree = by.orchestrator ? claimTree(by, target, tasks, ctx) : { error: "not an orchestrator" };
    return `Card ${target.id} is the root of another run (${holderState(target, ctx)}); a root stays with the user. ${"error" in tree || !tree.moved.length ? askHint(target.id) : `You may \`board.js claim-tree ${target.id} --reason "..."\` to take the ${tree.moved.length} open card${tree.moved.length === 1 ? "" : "s"} it left behind`}.`;
  }
  if (!target.openedBy) return `Card ${target.id} is not yours: no orchestrator opened it (the user's card). ${root.planRun ? askHint(target.id) : `Adopt it (\`board.js adopt ${target.id}\`), or ${askHint(target.id).replace(/^Ask/, "ask")}`}.`;
  const owner = target.openedBy, state = holderState(tasks.find((t) => t.id === owner), ctx);
  const claim = by.orchestrator ? claimRefusal(by, target, tasks, ctx) : "not an orchestrator";
  if (!claim) return `Card ${target.id} is controlled by ${owner} (${state}). You may \`board.js claim ${target.id} --reason "..."\` (owner terminal${samePlanFile(by, target, tasks) ? ", same plan file" : ""}).`;
  return `Card ${target.id} is controlled by ${owner} (${state}). ${askHint(target.id)} or message the owner (\`board.js send ${owner} --text "..."\`).`;
}

/** The explicit controller, including cards rebound by versions before controller was a separate field. */
export const boundSession = (t: Task) => t.controller?.sessionId ?? t.orchestrator?.session
  ?? (t.provider === "grok" || t.provider === "antigravity" ? t.boardSessionId : t.sessionId);
const short = (s: string) => s.slice(0, 8);

/**
 * Phase 3: what a governed run refuses on top of section 8. Older clients cannot carry its fields; requests never widen the trusted
 * configuration; unsupported modes (watchers, moving cards in or out, finish self) stay blocked.
 */
export function governedRefusal(req: Request, by: Task, target: Task | undefined, gov: { id: string; root?: Task }, tasks: Task[]): string | undefined {
  const root = gov.root;
  // Phase 5: a council member reviews one fixed package independently; it sends nothing (no messages to peers or the root, no typing, no requests).
  if (by.council) return `${req.op}: card ${by.id} is a read-only council member; it sends no board requests (its judgment is its final reply)`;
  if (!root) return `Governed run ${gov.id} has no root on the board any more; its cards are blocked until the user repairs or cancels them`;
  if (["add", "submit", "switch", "resume", "integrate"].includes(req.op) && (req.protocol ?? 1) < GOVERNED_PROTOCOL)
    return `This card belongs to governed run ${root.id}, which needs board.js protocol ${GOVERNED_PROTOCOL} to carry profiles, assignments and submissions; this client sent ${req.protocol ?? 1}. Update board.js (the extension places it at ~/.entomatical/board.js)`;
  if (target && target.id !== by.id && governedRootOf(target, tasks)?.id !== root.id && !["send", "screen", "type"].includes(req.op)) return `${req.op}: card ${target.id} is outside governed run ${root.id}`;
  switch (req.op) {
    case "add": {
      if (req.watch) return "add: watchers are not supported in governed runs (phase 3)";
      const allowance = allowanceOf(by);
      if (!allowance) return "Governed run: this card has no delegation allowance (a worker opens no cards)";
      if (!req.assignment) return "Governed run: add needs an assignment (--assignment-file: key, outcome, and optionally owns, acceptance, evidence, returns)";
      const p = childProfile(allowance, root.governed!, req.profile);
      if ("error" in p) return p.error;
      const d = narrowDelegation(allowance, req.delegate, !!req.mayOpen);
      if ("error" in d) return d.error;
      if (governedDepth(by, root.id, tasks) + 1 > root.governed!.limits.depth) return `Governed run: depth limit (${root.governed!.limits.depth})`;
      const cycle = dependencyCycle(tasks, { id: "(new)", dependsOn: req.after ?? [] });
      if (cycle) return `Governed run: Start after links form a cycle (${cycle.join(" → ")})`;
      for (const id of req.after ?? []) { const d2 = tasks.find((t) => t.id === id); if (d2 && governedRootOf(d2, tasks)?.id !== root.id) return `Governed run: after ${id} is outside this run`; }
      return undefined;
    }
    case "submit": {
      if (by.governed) return "submit: the root does not submit; it integrates";
      if (!by.assignment) return "submit: this card has no assignment";
      if (!by.worktree || !by.branch) return "submit: no worktree to submit from";
      if (by.status === "done" || by.cancelled) return `submit: card ${by.id} is ${by.cancelled ? "cancelled" : "done"}`;
      return undefined;
    }
    case "council": return by.governed ? (by.governed.council ? undefined : `council: governed run ${root.id} has no council (the user chooses one when he approves the run)`) : `council: only the root of governed run ${root.id} convenes and reconciles its council; members review read-only`;
    case "integrate": return !target ? "integrate needs the card id of a child you opened" : (target.openedBy ?? target.parentId) !== by.id ? `integrate: only the card that opened ${target.id} (${target.openedBy ?? target.parentId ?? "none"}) integrates it into its branch` : undefined;
    case "done": return target && !target.submission ? `done: card ${target.id} has no validated submission (board.js submit); a governed card is accepted against its handoff` : undefined;
    case "finish": return targetEffectRefusal(by, tasks, req.id ? "finish <id>" : "finish self");
    case "plan": return req.caps || req.policy ? `plan: governed run ${root.id} keeps the limits and permissions the user approved; a request cannot change them` : undefined;
    case "adopt": case "claim": case "claim-tree": case "handoff": case "request-takeover":
      return `${req.op}: moving cards into or out of governed run ${root.id} is not supported (phase 3)`;
  }
  return undefined;
}

/** Section 8, in order: the one-line refusal, or undefined when the request may go ahead. */
export function refusal(req: Request, tasks: Task[], ctx: RightsContext): string | undefined {
  // turn-done is a Grok or Antigravity card terminal's own turn end (F87), not orchestration: it works with the orchestrator off.
  if (!ctx.enabled && req.op !== "turn-done") return "Orchestrator disabled (entomatical.orchestrator.enabled is off)";
  const by = tasks.find((t) => t.id === req.by);
  if ((req.op === "receive" || req.op === "rebind") && tasks.some(t => t !== by && t.id === req.by)) return "Ambiguous card id on this board.";
  // A card terminal's ancestors may read and type in it whether or not they orchestrate (F89).
  if (!by || (!by.orchestrator && !["send", "receive", "rebind", "screen", "type", "turn-done", "submit", "readiness"].includes(req.op))) return req.op === "turn-done" ? `No card ${req.by}` : "Not an orchestrator";
  // Knowing a card id is not enough to act for it. Detached sessions bind explicitly; ordinary requests need the current controller.
  if (!req.session?.trim()) return "Not bound: the request names no session. Run board.js inside the card's own session; a chat that only knows the card id cannot act for it";
  const identity = boundSession(by);
  if (req.op !== "rebind" && !identity) return "Not bound: the card has no session yet";
  if (req.op !== "rebind" && req.session !== identity) return `Not bound: session ${short(req.session)} is not this card's controller (${short(identity!)}). Run board.js rebind explicitly from the current session`;
  const last = ctx.lastRequestAt.get(req.by);
  if ((ctx.rateMs ?? 1000) > 0 && last !== undefined && ctx.now - last < (ctx.rateMs ?? 1000)) return "Rate: at most one request per second";
  if (ctx.unprocessed(req.by) > 20) return "Rate: more than 20 requests waiting";
  const root = runRoot(by, tasks) ?? by;
  const caps = ctx.capsOf(root);
  const target = req.id ? tasks.find((t) => t.id === req.id) : undefined;
  if (req.id) {
    if (!target) return `No card ${req.id}`;
    // `finish <id>` also takes a card of the user's own (no opener); its own case below decides the rest.
    if (!["send", "adopt", "screen", "type", "claim", "claim-tree", "request-takeover", "readiness"].includes(req.op) && !(req.op === "finish" && !target.openedBy)
      && !runCards(by.id, tasks).some((t) => t.id === target.id) && target.watchedBy !== req.by)
      return ownershipRefusal(by, target, tasks, ctx);
  }
  const gov = req.op === "turn-done" ? undefined : governedRootOf(by, tasks);
  if (gov) { const why = governedRefusal(req, by, target, gov, tasks); if (why) return why; }
  else if (target && ["adopt", "claim", "claim-tree", "handoff", "request-takeover"].includes(req.op) && governedRootOf(target, tasks)) return `${req.op}: card ${target.id} belongs to governed run ${governedRootOf(target, tasks)!.id}; moving cards into or out of a governed run is not supported (phase 3)`;
  else if (req.op === "submit") return "submit: only a card of a governed run submits a handoff";
  else if (req.op === "council") return "council: only a governed run has a council";
  else if (req.op === "integrate") {
    if (!target || target.openedBy !== by.id) return "integrate needs a child you opened";
    const blocked = targetEffectRefusal(target, tasks, "Integration") ?? targetEffectRefusal(by, tasks, "Integration");
    if (blocked) return blocked;
    if (!root.approved || root.paused || root.cancelled || root.status === "done" || by.cancelled || by.status === "done") return "Integration needs an approved, active run.";
    if (target.takenOver || target.controller || target.cancelled || target.discarded) return "Integration needs a child still controlled by this run.";
    if (target.status === "done" && target.integrated?.into === by.id) return undefined;
    if (target.stepHold) return target.stepHold;
    if (target.dependsOn?.some(id => !tasks.some(t => t.id === id && t.status === "done" && !t.cancelled && !t.discarded))) return "A dependency is still outstanding.";
  } else if (req.op === "add" && (req.profile || req.assignment || req.delegate)) return "add: --profile, --assignment-file and --delegate-file need a governed run (the user approves one); nothing was made, so nothing runs on Provider defaults by mistake";
  // Ordinary integration also closes the child, so it must satisfy every completion rule below.
  switch (!gov && req.op === "integrate" ? "done" : req.op) {
    case "submit": case "integrate": case "readiness": case "council": return undefined; // governedRefusal checked the caller; the board checks the revisions
    case "add": {
      // F119: a step the plan file marks "mayOpen": true is a coordinator under the plan card and opens cards as any coordinator does.
      if (by.status === "done" || by.cancelled || root.status === "done" || root.cancelled) return "add: this card or its run has ended";
      if (root.planRun && by.id === root.id) {
        if (!root.planRun.mayOpen || root.planRun.review !== "model" || root.planRun.approval) return "add: this run follows a plan file, which lists every step; its reviewer opens no cards (F72)";
        if (req.watch || req.role === "judge" || req.role === "scribe") return "add: the saved plan fixes its standing roles and step reviewers. Open a worker or a delegating child for additional work.";
      }
      if (root.paused) return root.paused === "budget" ? `Run paused: points budget reached (caps.points ${caps.points ?? "?"}); the user's Resume run continues it` : "Run paused";
      if (!root.approved) return "Plan not approved";
      if (req.parent && req.parent !== req.by) return "add: the parent must be your own card (subtasks only in this version)";
      const cards = runCards(root.id, tasks);
      if ((req.role === "judge" || req.role === "scribe") && cards.some((t) => t.role === req.role && !t.cancelled && t.status !== "done")) return `A ${req.role} already stands in this run`;
      if (req.judge && !cards.some((t) => t.role === "judge" && !t.cancelled && t.status !== "done")) return "Open a standing judge before requesting judgment";
      if (req.judge && !req.autoRule && !req.completion?.commands.length) return "A judged card needs acceptance checks";
      // F119: a plan's standing judge is released for the plan's own steps only (judgeReady, Board.stepSettled); a card a step opened would wait for ever.
      if (req.judge && root.planRun) return "add: --judge is not available to a card a plan step opens (the plan's judge reviews the plan's own steps); give the card acceptance checks instead";
      if (req.watch) {
        if (by.id !== root.id) return "Only the root may assign a watcher";
        if (req.watch.length > caps.perWatcher) return `perWatcher cap (${caps.perWatcher})`;
        if (cards.filter((t) => t.orchestrator && t.status !== "done" && !t.cancelled).length >= caps.watchers) return `watchers cap (${caps.watchers})`;
        if (req.watch.some((id) => !cards.some((t) => t.id === id && t.openedBy === root.id && (t.watchedBy ?? root.id) === root.id && !t.orchestrator && !t.role && !t.takenOver && !t.controller && t.status !== "done" && !t.cancelled))) return "watch: every card must be an available direct child of this root";
      }
      // A plan run makes all its steps before any starts, so its open cap limits started cards (Board.planCapacityWait), not cards made:
      // a card a step opens waits in Queued for a free slot instead of being refused here (F119).
      if (!root.planRun && cards.filter((t) => t.status !== "done" && !t.cancelled).length >= caps.open) return `open cap (${caps.open})`;
      if ((root.orchestrator?.opened ?? 0) >= caps.total) return `total cap (${caps.total})`;
      const depth = depthOf(by, tasks) + 1;
      if (depth > caps.depth) return `depth cap (${caps.depth})`;
      if (req.mayOpen && by.role === "sub") return "A pressure watcher may not open another coordinator";
      if (req.mayOpen && depth >= caps.depth) return `may-open: a card at depth ${depth} may not open cards (depth cap ${caps.depth})`;
      if (req.account && !ctx.accountSignedIn(req.account)) return `Account not signed in: ${req.account}`;
      if (caps.pointsFiveHour !== undefined) {
        const usage = ctx.accountUsage(req.account ?? null);
        if (usage?.fiveHour === undefined) return `pointsFiveHour cap (${caps.pointsFiveHour}): five-hour usage is unknown`;
        if (usage.fiveHour >= caps.pointsFiveHour) return `pointsFiveHour cap (${caps.pointsFiveHour}): the account has used ${usage.fiveHour}`;
      }
      if (req.model && !ctx.models.includes(normalizeModel(req.model))) return `Unknown model ${req.model}. Valid models: ${ctx.models.join(", ")}`;
      if (req.effort && !ctx.efforts.includes(req.effort)) return `Unknown effort ${req.effort}. Valid efforts: ${ctx.efforts.join(", ")}`;
      if (req.permission && !ctx.permissions.includes(req.permission)) return `Unknown permission ${req.permission}. Valid permissions: ${ctx.permissions.join(", ")}`;
      for (const id of req.after ?? []) if (!tasks.some((t) => t.id === id)) return `after: no card ${id}`;
      if (ctx.catalogue && req.completion) for (const c of req.completion.commands) if (!inCatalogue(c, ctx.catalogue)) return `Check not in workflows/checks.json: ${c}`;
      return undefined;
    }
    case "send": {
      // Inbox messages are accepted in every state; delivery waits for a safe turn boundary.
      return undefined;
    }
    case "resume": {
      if (target!.takenOver) return "taken over";
      if (target!.status === "running" || ctx.live?.(target!)) return "busy";
      if (root.paused || !root.approved) return "Run must be approved and unpaused";
      if (ctx.starting?.(target!.id)) return "busy";
      if (root.planRun && (!target!.sessionId || target!.cancelled || target!.status === "done")) {
        const wait = planCapacityWait(target!, tasks, ctx.starting);
        if (wait) return wait;
      } else if (!root.planRun && (target!.cancelled || target!.status === "done") && runCards(root.id, tasks).filter((t) => t.status !== "done" && !t.cancelled).length >= caps.open) return `open cap (${caps.open})`;
      if (!target!.sessionId && !target!.headless && !(target!.openedBy && target!.cardTerminal)) return "not started";
      return undefined;
    }
    // Stop also ends a hidden process that is still exiting after its Review event.
    case "stop": return target!.status === "running" || target!.status === "needs-input" || ctx.live?.(target!) ? undefined
      : target!.status === "queued" && !target!.sessionId ? "not running (never started: no process to stop)" : "not running";
    case "done": {
      if (target!.status === "done") return "done";
      if (target!.cancelled || target!.launchError || !(ctx.everReady ? ctx.everReady(target!) : target!.sessionId)) return "Never started successfully; use cancel, not done";
      if (target!.status !== "review" || ctx.live?.(target!)) return "Not ready for completion";
      if (target!.interrupted) return "Interrupted work is not complete";
      if (target!.judging || target!.scribe?.active) return "The standing role is still working on an assignment";
      if (target!.judge && target!.judged !== "pass") return "A passing judge verdict is required";
      if (target!.completion?.commands.length && target!.checks?.status !== "complete") return "Acceptance checks have not passed";
      if (target!.orchestrator && !target!.deliveryReady) return "Orchestrator must declare ready first";
      if (runCards(target!.id, tasks).some((t) => t.status !== "done" && !t.cancelled)) return "Descendants are not finished";
      if (tasks.some((t) => t.watchedBy === target!.id && t.openedBy !== target!.id && t.status !== "done" && !t.cancelled)) return "Watched cards are not finished";
      return undefined;
    }
    case "cancel": return ctx.live?.(target!) || target!.status === "running" || target!.status === "needs-input" ? "Stop the card before cancelling it" : undefined;
    case "claim": return claimRefusal(by, target!, tasks, ctx);
    case "claim-tree": {
      const plan = claimTree(by, target!, tasks, ctx);
      if ("error" in plan) return plan.error;
      return plan.moved.length ? undefined : `claim-tree: nothing to take under ${target!.id}${plan.live.length ? `; live, left alone: ${plan.live.join(", ")}` : ""}${plan.waiting.length ? `; waiting for a live card or held: ${plan.waiting.join(", ")}` : ""}`;
    }
    case "request-takeover": {
      if (target!.id === by.id || isOwn(by, target!, tasks)) return `request-takeover: card ${target!.id} is already yours`;
      if (runCards(target!.id, tasks).some((t) => t.id === by.id)) return `request-takeover: card ${target!.id} holds your own card; that would create a cycle`;
      if (target!.status === "done") return `request-takeover: card ${target!.id} is Done; nothing to take over`;
      const asked = target!.takeoverAsk;
      if (asked) return asked.by === by.id ? `request-takeover: you already asked at ${hhmm(Date.parse(asked.at))}; the user's answer comes as a message` : `Card ${target!.id} already has a takeover request from ${asked.by}; wait for the user's answer`;
      return undefined;
    }
    case "handoff": {
      const to = tasks.find((t) => t.id === req.to);
      if (!to) return `No card ${req.to}`;
      if (to.id === by.id) return "handoff: that card is you";
      if (!to.orchestrator) return `handoff: card ${to.id} is not an orchestrator, so it cannot hold cards`;
      if (to.status === "done" || to.cancelled) return `handoff: card ${to.id} is ${to.cancelled ? "cancelled" : "done"}; hand it to a coordinator that still works`;
      const cards = req.self ? heldBy(by, tasks).filter((t) => t.id !== to.id) : [target!];
      if (!cards.length) return "handoff: you hold no open cards";
      for (const c of cards) if (c.id === to.id || runCards(c.id, tasks).some((t) => t.id === to.id)) return `handoff: card ${to.id} is under ${c.id}; that would create a cycle`;
      return undefined;
    }
    case "adopt": {
      if (root.planRun) {
        const tree = !target!.openedBy && target!.orchestrator, why = tree ? (((p) => "error" in p ? p.error : p.moved.length ? undefined : "nothing")(claimTree(by, target!, tasks, ctx))) : claimRefusal(by, target!, tasks, ctx);
        return `adopt: this run follows a plan file, which lists every step (F72). ${why ? `${askHint(target!.id)}, or message its owner.` : `You may \`board.js ${tree ? "claim-tree" : "claim"} ${target!.id} --reason "..."\` instead.`}`;
      }
      if (target!.id === by.id || runCards(target!.id, tasks).some((t) => t.id === by.id)) return "Adoption would create a cycle";
      // Adopt clears takenOver (moveCards continueWork) and moves the cards under it, so the user's takeover must refuse it (CORE-GOV-02).
      { const taken = [target!, ...runCards(target!.id, tasks)].find((t) => t.takenOver);
        if (taken) return `adopt: the user took card ${taken.id}${taken === target ? "" : ` under ${target!.id}`} over himself; it stays his. ${askHint(target!.id)}.`; }
      // Grok and Antigravity cards are adopted like any other and then run unattended over ACP (runHeadlessAcp). One open in its
      // provider's own terminal is not: the board cannot steer that terminal, so it is stopped first.
      { const open = [target!, ...runCards(target!.id, tasks)].find((t) => (t.provider === "grok" || t.provider === "antigravity") && t.cardTerminalStarted && ctx.live?.(t));
        if (open) return `Card ${open.id} is open in ${open.provider === "grok" ? "Grok" : "Antigravity"}'s own terminal; stop it first, as an adopted card runs unattended over ACP`; }
      if (target!.openedBy === by.id) return undefined;
      for (let owner = by.openedBy, depth = 0; owner && depth < 10; depth++) {
        if (target!.openedBy === owner) return `Card ${target!.id} is assigned to ancestor ${owner}; only that coordinator can change this assignment`;
        owner = tasks.find((t) => t.id === owner)?.openedBy;
      }
      if (!root.approved || root.paused) return "Run must be approved and unpaused";
      const subtree = [target!, ...runCards(target!.id, tasks)];
      const existing = new Set(runCards(root.id, tasks).map((t) => t.id));
      const added = subtree.filter((t) => !existing.has(t.id));
      if (runCards(root.id, tasks).filter((t) => t.status !== "done" && !t.cancelled).length + added.filter((t) => t.status !== "done" && !t.cancelled).length > caps.open) return `open cap (${caps.open})`;
      if ((root.orchestrator?.opened ?? 0) + added.length > caps.total) return `total cap (${caps.total})`;
      const height = Math.max(...subtree.map((t) => depthOf(t, tasks) - depthOf(target!, tasks)));
      if (depthOf(by, tasks) + 1 + height > caps.depth) return `depth cap (${caps.depth})`;
      return undefined;
    }
    case "rebind": return by.status === "done" || by.cancelled ? `rebind: card ${by.id} is closed` : undefined;
    case "receive":
      if (req.inferredEditor && (by.provider !== "codex" || by.codexEditor !== true || by.status === "done" || by.cancelled || by.sessionId !== req.session))
        return "receive: this thread no longer belongs to an active Codex editor on this board.";
      return by.codexEditor && by.sessionId === req.session && tasks.some(t => t !== by && t.sessionId === req.session)
        ? "Ambiguous editor thread on this board." : undefined;
    // F87 (the user, 9 November 2026: "Grok and Antigravity can decide for themselves"): the agent in a Grok or Antigravity card terminal
    // says its turn ended; the board does not read its screen. Only the caller's own card, bound by its session above, and only while it runs.
    case "turn-done": {
      if ((by.provider !== "grok" && by.provider !== "antigravity") || !by.cardTerminalStarted) return `turn-done: card ${by.id} is not a Grok or Antigravity card terminal; its turns end on their own`;
      if (ctx.live && !ctx.live(by)) return `turn-done: card ${by.id} has no live terminal`;
      if (by.status !== "running") return `turn-done: card ${by.id} is ${by.status}, not running`;
      return undefined;
    }
    case "screen": case "type":
      return ancestorsOf(target!, tasks).some((a) => a.id === by.id) ? undefined
        : `Only an ancestor of card ${target!.id} (its parent, grandparent and so on) may read or type in its terminal`;
    case "ready": {
      if (!root.approved) return "Plan not approved";
      if (runCards(by.id, tasks).some((t) => t.status !== "done" && !t.cancelled && !(by.planRun && (t.role === "judge" || t.role === "scribe")))) return "Descendants are not finished";
      if (tasks.some((t) => t.watchedBy === by.id && t.openedBy !== by.id && t.status !== "done" && !t.cancelled)) return "Watched cards are not finished";
      return undefined;
    }
    case "note": return undefined;
    case "plan": return by.planRun ? "plan: this card runs a plan file; the user approved it by pressing Run" : by.orchestrator?.root && (req.caps || req.policy) ? "Only the root may propose run caps or permissions"
      : by.battle && req.caps ? BATTLE_CAPS_REFUSAL : undefined;
    // The ancestor check (section 8 item 5) needs git and runs on the board after this; nothing here deletes anything.
    case "discard": {
      if (target!.takenOver) return "taken over";
      if (target!.status === "running" || target!.status === "needs-input" || ctx.live?.(target!)) return "busy: stop it first";
      if (!target!.worktree || !target!.branch) return "discard: no worktree (already finished or discarded)";
      if (runCards(target!.id, tasks).some((t) => t.status !== "done" && !t.cancelled)) return "discard: its own cards are still open";
      return undefined;
    }
    case "switch": {
      if (target!.takenOver) return "taken over";
      if (target!.status === "running" || target!.status === "needs-input" || ctx.live?.(target!)) return "busy: stop it first";
      if (root.paused || !root.approved) return "Run must be approved and unpaused";
      if (!ctx.accountSignedIn(req.account!)) return `Account not signed in: ${req.account}`;
      if ((target!.account ?? "").toLowerCase() === req.account!.toLowerCase()) return `switch: already on ${req.account}`;
      const usage = ctx.accountUsage(req.account!);
      if (usage?.quotaCoverage === "incomplete") return `switch: ${req.account} has incomplete quota readings`;
      const used = usage?.fiveHour;
      if (used !== undefined && used >= 95) return `switch: ${req.account} has no headroom (5-hour window ${used} % used)`;
      if (usage?.week !== undefined && usage.week >= 95) return `switch: ${req.account} has no headroom (weekly window ${usage.week} % used)`;
      return undefined;
    }
    // A request: only the master, only with its run closed, once. The self-finish (src/auto-finish.ts) acts on it after a Done review.
    case "finish": {
      // `finish <id>` (the user, 18 November 2026): the root of an approved run asks the board to close another card whose work is in
      // the target already: a card of its run, or one of the user's own. These are the rights; Board.finishLanded checks the git side
      // (clean worktree, every commit landed) and removes the worktree. Nothing is merged or pushed, and the checks are not asked for.
      if (target) {
        if (target.id === by.id) return "finish: for your own card use `board.js finish self`";
        if (by.status === "done" || by.cancelled || root.status === "done" || root.cancelled) return "finish: the asking card or its run is closed";
        if (by.orchestrator?.root || root.planRun || by.battle) return "finish: only the root of an ordinary run asks the board to finish a card";
        if (root.paused || !root.approved) return "Run must be approved and unpaused";
        const governed = governedRootOf(target, tasks);
        if (governed) return `finish: card ${target.id} belongs to governed run ${governed.id}; it reaches the target only through that run's readiness check`;
        if (!target.openedBy && target.orchestrator) return `finish: card ${target.id} is the root of a run; a root stays with the user`;
        if (target.status === "done") return "done";
        if (target.takenOver) return `finish: the user took card ${target.id} over; it is his to finish`;
        if (target.status !== "review" || ctx.live?.(target)) return `finish: card ${target.id} is not in Review with its session ended`;
        if (!target.worktree) return `finish: card ${target.id} has no worktree, so there is nothing to remove`;
        if (runCards(target.id, tasks).some((t) => t.status !== "done" && !t.cancelled)) return "Descendants are not finished";
        return undefined;
      }
      // A battle's cards race on one task: the user compares their branches and finishes the one he picks, as with a battle card that
      // does not orchestrate. finish self would merge and push the first one done (a47807).
      if (by.battle) return BATTLE_FINISH_REFUSAL;
      if (by.orchestrator?.root) return "finish: only the master asks to finish";
      if (!by.worktree) return "finish: nothing to finish (the card has no worktree)";
      const open = runCards(by.id, tasks).filter((t) => t.status !== "done" && !t.cancelled).length;
      if (open) return `finish: ${open} card${open === 1 ? " of the run is" : "s of the run are"} still open`;
      // finishAsked stands until a round sends work back or Accept prompt sends the prompt; then finish self is accepted again.
      if (by.finishAsked) return "finish: already asked; the board reviews the run when this turn ends, or the card waits for the user";
      return undefined;
    }
  }
}

/**
 * What Archive run moves (4.7): the master and every card of its run. `outside` are cards left on the board that would lose their
 * parent or a Start after card (a card the user added under one of them): the archive stops for those rather than orphan them.
 */
export function archiveSet(master: Task, tasks: Task[]): { cards: Task[]; outside: Task[] } {
  const cards = [master, ...runCards(master.id, tasks)];
  const ids = new Set(cards.map((t) => t.id));
  const outside = tasks.filter((t) => !ids.has(t.id) && ((t.parentId && ids.has(t.parentId)) || (t.dependsOn ?? []).some((d) => ids.has(d))));
  return { cards, outside };
}

/** A run's measured points budget (13.3 item 13): points of the 5-hour window its cards' runs moved, against caps.points. */
export interface Budget { cap: number; used: number; percent: number; unknown: string[] }
/**
 * The run's budget, or undefined when it has none. `fiveHourOf` gives a card's measured points, or undefined when its runs have no
 * comparable reading (no reading at start or end, a window that reset): such a card counts as unknown, never as zero, and is listed.
 * Not the per-account pointsFiveHour cap, which is one account's absolute reading.
 */
export function runBudget(root: Task, tasks: Task[], fiveHourOf: (t: Task) => number | undefined): Budget | undefined {
  const cap = root.orchestrator?.caps.points;
  if (!cap) return undefined;
  let used = 0;
  const unknown: string[] = [];
  for (const t of [root, ...runCards(root.id, tasks)]) { const p = fiveHourOf(t); if (p === undefined) unknown.push(t.id); else used += p; }
  used = Math.round(used * 10) / 10;
  return { cap, used, percent: Math.floor((used / cap) * 100), unknown };
}
/** What the budget asks of the board now: tell the master at 80 %, pause the run at 100 %; each once (`noticed` is the last one done). */
export function budgetStep(b: Budget | undefined, noticed: number | undefined): 80 | 100 | undefined {
  if (!b) return undefined;
  if (b.percent >= 100 && (noticed ?? 0) < 100) return 100;
  if (b.percent >= 80 && (noticed ?? 0) < 80) return 80;
  return undefined;
}
export const BUDGET_NOTICE = (b: Budget) => `Budget: this run has used ${b.used} of its ${b.cap} points of the 5-hour window (${b.percent} %)${b.unknown.length ? `; ${b.unknown.length} card${b.unknown.length === 1 ? " has" : "s have"} no measurable reading and count as unknown` : ""}. `
  + (b.percent >= 100 ? "The board paused the run: add is refused until the user resumes it. Cards already running finish their turn." : "At 100 % the board pauses the run: open no more cards than the plan needs.");

/**
 * Why an orchestrator's own acceptance checks wait, or undefined when they run at this Review (run d60bfd: the final product checks
 * ran at the plan-only stop, before setup, and failed). Ordinary cards never wait.
 */
export function checksWait(task: Task, tasks: Task[]): string | undefined {
  if (!task.orchestrator) return undefined;
  if (task.plan && !task.approved) return "the plan waits for approval";
  const open = runCards(task.id, tasks).filter((t) => t.status !== "done" && !t.cancelled).length;
  return open ? `${open} card${open === 1 ? "" : "s"} of its run still open` : undefined;
}

/** The line the board writes before a child's prompt (4.1), so a reader or a resumed session knows who asked. */
export const prefixPrompt = (title: string, id: string, prompt: string, date = new Date()) =>
  `Opened by orchestrator "${title}" (${id}) on ${date.toISOString().slice(0, 10)}.\n\n${prompt}`;

/**
 * The orchestrator card's first message: the brief's text first, then the user's prompt (section 7). Inline, not a path: a headless run
 * may not read files outside its worktree (seen 4 November 2026: `Read ~/.entomatical/BRIEF.md` was denied and the master stopped).
 */
export const masterPrompt = (brief: string, prompt: string) =>
  `You are an orchestrator card on the Entomatical. The brief below says what you may do and how; your card id is in $ENTOMATICAL_TASK.\n\n${brief.trim()}\n\n---\n\nYour task:\n\n${prompt}`;

/**
 * F117: the message to a card the user made an orchestrator after it was added (Make orchestrator). Its session never had the brief, so
 * it gets it now, inline as masterPrompt gives it. Nothing is approved by the change itself.
 */
export const assignedPrompt = (brief: string, id: string) =>
  `the user enabled delegation for this card (${id}). Nothing is approved yet: write your plan, run board.js plan and end your turn, and the user approves it on the card. Your task stays what it was. A panel session can collect its queued messages with board.js receive.\n\n${brief.trim()}`;

/** The pressure watcher's prompt before docs/orchestrator/WATCHER.md was wired (F73); still sent when that brief cannot be read. */
export const watcherFallback = (ids: string[]) =>
  `Supervise only these existing cards: ${ids.join(", ")}. Inspect each result and its checks; follow up within the run limits. Merge every card you accept into your own branch (git merge --no-edit task/<id>), unless the run policy's deny list or the root explicitly forbids you merging. Report every outcome and call board.js ready only after all assigned cards are Done or cancelled. Never push, finish the root, or change run limits.`;

/**
 * A pressure watcher's first message (F73): WATCHER.md's body without its YAML frontmatter, then its assignment (card ids, root id,
 * the run policy, the follow-up cap). Inline like masterPrompt, since a headless run may not read outside its worktree. A brief that
 * is missing or empty gives watcherFallback.
 */
export function watcherPrompt(brief: string | undefined, ids: string[], rootId: string, policy: RunPolicy | undefined, followUps: number): string {
  const body = (brief ?? "").replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").trim();
  if (!body) return watcherFallback(ids);
  const list = (xs: string[] | undefined) => (xs?.length ? xs.join(", ") : "none");
  return `${body}\n\n---\n\n## Your assignment\n\n- Cards: ${ids.join(", ")}\n- Root: ${rootId}\n` +
    `- Run policy allow: ${list(policy?.allow)}\n- Run policy deny: ${list(policy?.deny)}\n- Follow-up cap: ${followUps} per card\n` +
    `- Merge: merge every card you accept into your own branch (git merge --no-edit task/<id>), unless the deny list above or the root explicitly forbids you merging; the root merges your branch later\n`;
}

/**
 * A pressure watcher's model and effort (the user, 9 November 2026): Claude runs Opus at medium, Codex runs Sol (the newest, GPT 6.1 Sol)
 * at medium. Grok and Antigravity have neither, so they keep the root's model and effort.
 */
export function watcherModel(root: Pick<Task, "provider" | "model" | "effort">): { model?: string; effort?: string } {
  if (!root.provider) return { model: "opus", effort: "medium" };
  if (root.provider === "codex") return { model: "sol", effort: "medium" };
  return { model: root.model, effort: root.effort };
}

/** The plan's size from ORCHESTRATION.md: list items under a Steps or Plan heading (else every top-level list item), and points at `perCard` each. */
export function planSummary(markdown: string, perCard = 2): { steps: number; points: number } {
  const lines = markdown.split(/\r?\n/);
  const item = (l: string) => /^\s{0,3}(?:[-*+]|\d+[.)])\s+\S/.test(l);
  let section: string[] = [], inSection = false, found = false;
  for (const l of lines) {
    if (/^#{1,6}\s/.test(l)) {
      // A later matching heading (## Steps under # Plan) starts over; the first other heading after items ends the section.
      if (/^#{1,6}\s.*(steps?|plan|cards?)\b/i.test(l)) { section = []; inSection = true; found = true; }
      else if (found && section.some(item)) break;
      else inSection = false;
      continue;
    }
    if (inSection) section.push(l);
  }
  const items = (found ? section : lines).filter((l) => item(l) && !/^\s{0,3}[-*+]\s+\[x\]/i.test(l));
  const steps = items.length;
  return { steps, points: Math.round(steps * perCard * 10) / 10 };
}

/** A settled card: its watcher has something to act on (4.2). Checks still running are not settled. */
export const isSettled = (r: StatusRecord) => r.status === "done" || r.status === "needs-input" || (r.status === "review" && r.checks !== "running");
/** What a settle notice is about: a new notice goes only when this changed since the last one (the wake guard, section 8 item 7). */
export const settleKey = (r: StatusRecord) => JSON.stringify([r.status, r.checks, r.chips.includes("interrupted"), r.chips.includes("needs input"), r.last]);
/** One notice for the children that settled together, one line each (4.2). */
export const noticeText = (lines: string[]) => (lines.length === 1 ? `Child settled: ${lines[0]}` : `Children settled:\n${lines.map((l) => `- ${l}`).join("\n")}`);
export const INTERRUPTED_NUDGE = "Your previous turn was interrupted by a window reload or a stop. Read the state of your worktree and continue the task from where you left off.";
export const APPROVED_NOTICE = (time: string) => `Plan approved by the user at ${time}. Open your first cards now (board.js add), then wait for them (board.js wait --mine --timeout 600).`;

// ---- Battle Royale with Orchestrator ticked (a47807, the user, 14 November 2026). ----
/**
 * What makes a battle card an orchestrator: the board's caps, and its run approved from the start, since nobody approves a plan in a
 * battle (battlePreamble). The policy is approvePlan's default. The card runs in its card terminal, not headless (inCardTerminal).
 */
export const battleRun = (caps: Caps, at = new Date()) => ({ orchestrator: { caps: { ...caps }, opened: 0 }, approved: { at: at.toISOString(), hash: "battle" },
  runPolicy: { allow: [] as string[], deny: [] as string[], noSync: true } });
/** The answer to a battle card's `plan`, and the notice its turn gets: the run is approved already. */
export const BATTLE_APPROVED_NOTICE = "Plan recorded. A Battle Royale run is approved when it starts, with the board's caps, so nobody approves it: open your first cards now (board.js add), then wait for them (board.js wait --mine --timeout 600).";
export const BATTLE_CAPS_REFUSAL = "plan: a Battle Royale run keeps the caps it started with; send no caps file";
export const BATTLE_FINISH_REFUSAL = "finish: a Battle Royale card leaves its branch for the user to compare with the others; he finishes the one he picks";

/** The signed-in Claude account with the most headroom: 5-hour window under 95 % and the lowest weekly use; undefined when none has room. */
export function bestAccount(accounts: (Pick<Usage, "week" | "fiveHour" | "quotaCoverage"> & { name: string })[], except?: string): string | undefined {
  const ok = accounts.filter(a => a.name !== except && a.quotaCoverage !== "incomplete" && a.week !== undefined && a.week < 95 &&
    (a.fiveHour !== undefined ? a.fiveHour < 95 : a.quotaCoverage === "weekly-only"));
  // On a weekly tie prefer a measured five-hour window. Weekly-only accounts keep their input order on a tie.
  ok.sort((a, b) => {
    if (a.week !== b.week) return a.week! - b.week!;
    if (a.fiveHour === undefined) return b.fiveHour === undefined ? 0 : 1;
    return b.fiveHour === undefined ? -1 : a.fiveHour - b.fiveHour;
  });
  return ok[0]?.name;
}

export interface HeadlessPlan { claude: string; hooks: string; sessionId: string; resume: boolean; title?: string; named?: boolean; orchestrator?: boolean; promptFile: string; stream: string; stderr: string; cwd: string; repo?: string }
/**
 * The arguments of a headless run (4.3): print mode, streamed, nobody to answer prompts, the task's settings file, the run's session.
 * repo: the main checkout, added as a working directory so a child in a stricter mode can read and copy what is there and in its
 * sibling worktrees (uncommitted kit files, a sibling's output). Under Bypass, the default, it changes nothing (failed tool calls plan,
 * fix 1, 6 November 2026: under Accept edits a nested worktree's Read and cp of the main checkout were refused without it, allowed with
 * it). Last, because --add-dir takes every value up to the next option.
 * --autocompact: an orchestrator compacts early and relies on its files (4.3). 150k, not the CLI's 100k minimum (the user, 17 November
 * 2026): at 100k the CLI compacted at 66k to 74k of context, and a session now reloads about 43k of prompt, skills and instructions
 * after each compaction, so a Fable orchestrator came back at 66k to 69k, compacted three times in a row and was stopped (card 49d1da).
 */
export function headlessArgs(p: HeadlessPlan): string[] {
  return ["-p", "--output-format", "stream-json", "--verbose", "--permission-prompts", "none", "--settings", p.hooks,
    ...(p.orchestrator ? ["--autocompact", "150k"] : []),
    ...(p.resume ? ["--resume", p.sessionId] : ["--session-id", p.sessionId, ...(p.named && p.title ? ["--name", p.title] : [])]),
    ...(p.repo ? ["--add-dir", p.repo] : [])];
}
const q = (s: string) => `"${s}"`;
/** The script the hidden terminal runs: the prompt on stdin, the stream to a file, as the probes ran it (`run-probe.js`). */
export function headlessScript(p: HeadlessPlan, platform = process.platform): string {
  // cmd.exe acts on these even inside quotes (%) or once a stray " ends them, so a card title keeps none of them (audit, 10 November 2026).
  const args = headlessArgs({ ...p, title: p.title?.replace(/["%&|<>^]/g, "") }).map((a) => (/[\s"]/.test(a) ? q(a) : a)).join(" ");
  // ENTOMATICAL_NO_PROMPTS=1 for this claude process only (F91): its hooks inherit it, so hook.js knows nobody can answer a prompt here
  // and stops a run that keeps getting refused. Terminal, panel and Codex sessions never have it.
  // A .cmd file expands % even inside quotes, so every % in a path or argument is doubled to %% (audit finding 8, 11 November 2026).
  // The script changes into the worktree itself: cmd.exe starts it by its bare name from its own folder (headlessLaunch), since cmd /c
  // expands %NAME% in a path on its command line (F71 live check, 12 November 2026: a board folder holding %OS% was not found).
  if (platform === "win32") return `@echo off\r\nset ENTOMATICAL_NO_PROMPTS=1\r\n${`cd /d ${q(p.cwd)} || exit /b 1`.replace(/%/g, "%%")}\r\n${`${q(p.claude)} ${args} < ${q(p.promptFile)} > ${q(p.stream)} 2> ${q(p.stderr)}`.replace(/%/g, "%%")}\r\n`;
  const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  // No exec: sh keeps the hidden terminal's pty open. An exec'd claude with all three streams redirected left nothing holding it, and
  // VS Code ended the run within 0.3 s, before it read its prompt (Linux machine, 4 November 2026).
  return `#!/bin/sh\nENTOMATICAL_NO_PROMPTS=1 ${sq(p.claude)} ${headlessArgs(p).map(sq).join(" ")} < ${sq(p.promptFile)} > ${sq(p.stream)} 2> ${sq(p.stderr)}\n`;
}
/**
 * How the hidden terminal starts the script. Windows: cmd.exe runs `.\<id>.run.cmd` (never a % in it; ".\" so NoDefaultCurrentDirectoryInExePath cannot hide it) from the
 * launch folder, because cmd /c expands %NAME% in a full path on its command line, so a board folder or user name holding one made
 * the script "not found" (F71, 12 November 2026); the script's own `cd /d` (headlessScript) puts claude in the worktree. Linux: sh
 * runs the full path in the worktree, as before.
 */
export function headlessLaunch(script: string, worktree: string, platform = process.platform): { shellPath: string; shellArgs: string[]; cwd: string } {
  return platform === "win32" ? { shellPath: "cmd.exe", shellArgs: ["/d", "/c", `.\\${path.basename(script)}`], cwd: path.dirname(script) }
    : { shellPath: "/bin/sh", shellArgs: [script], cwd: worktree };
}
/** Where a headless run's files live under the board folder. */
export const headlessFiles = (dir: string, id: string) => ({
  promptFile: path.join(dir, "launch", `${id}.prompt.txt`), followUpFile: path.join(dir, "launch", `${id}.followup.txt`),
  script: path.join(dir, "launch", `${id}.run.${process.platform === "win32" ? "cmd" : "sh"}`),
  stream: path.join(dir, "stream", `${id}.jsonl`), stderr: path.join(dir, "stream", `${id}.stderr.txt`),
});
/**
 * The commands a headless card in Accept edits or Auto mode may run without asking (headlessPermissions). A headless run has nobody to
 * answer a prompt, so without these the project's own commands (git merge, npm test, node board.js) were refused (4 November 2026).
 * Both shells: on Windows sessions run git through the PowerShell tool, whose rules are separate from Bash's. Checked live 6 November
 * 2026: PowerShell(git merge *) let `git merge --no-edit` run in a headless Accept edits session; without it the call was refused.
 */
export const HEADLESS_ALLOW = [
  ...["node", "npm", "npx", "git", "ls", "cat", "echo", "mkdir", "cp", "test", "pwsh", "powershell", "python", "sh"].map((c) => `Bash(${c} *)`),
  ...["node", "npm", "npx", "git", "python", "Get-ChildItem", "Get-Content", "Select-String", "Test-Path", "Copy-Item", "New-Item"].map((c) => `PowerShell(${c} *)`),
];
/**
 * A Claude card's permissions block for its --settings file. Ask stays strict on purpose (nothing that prompts runs headless); Bypass
 * needs no list; plan mode only reads. A terminal or panel card has a person to answer, so only headless cards get the list.
 */
export function headlessPermissions(defaultMode: string, headless: boolean): { defaultMode: string; allow?: string[] } {
  return headless && (defaultMode === "acceptEdits" || defaultMode === "auto") ? { defaultMode, allow: HEADLESS_ALLOW } : { defaultMode };
}

/** The last assistant text in a headless run's stream file (the live line's second source, 4.2), from its tail. */
export function streamText(tail: string): { text: string; at?: number } | undefined {
  const lines = tail.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e?.type !== "assistant" || e.parent_tool_use_id) continue;
      const text = Array.isArray(e.message?.content) ? e.message.content.find((p: { type: string }) => p.type === "text")?.text : undefined;
      if (typeof text === "string" && text.trim()) return { text: text.trim().split("\n")[0].slice(0, 80), at: typeof e.timestamp === "string" ? Date.parse(e.timestamp) : undefined };
    } catch { /* a cut-off first line of the tail */ }
  }
  return undefined;
}

/** A run's summary for the master card's run row and report (4.7, 13.2 item 8). */
export interface RunSummary { running: number; needsYou: number; done: number; open: number; cancelled: number; points: number | null; budget?: Budget; children: { id: string; title: string; status: string; points: number | null; interrupted?: boolean; takenOver?: boolean; cancelled?: boolean; held?: boolean; asked?: boolean }[] }
export function runSummary(root: Task, tasks: Task[], pointsOf: (t: Task) => number | null): RunSummary {
  const children = runCards(root.id, tasks).map((t) => ({ id: t.id, title: t.title, status: t.status, points: pointsOf(t), interrupted: !t.cancelled && t.interrupted && t.status === "review" || undefined, takenOver: t.takenOver || undefined, cancelled: t.cancelled || undefined,
    held: !!t.stepHold && t.status !== "done" || undefined, // a plan step the board left to the user (F72)
    asked: !!t.takeoverAsk || undefined })); // another card asked the user to take it over (F95)
  const needsYou = children.filter((c) => c.status === "needs-input" || c.interrupted || c.held || c.asked).length;
  const points = children.reduce<number | null>((sum, child) => sum === null || child.points === null ? null : sum + child.points, 0);
  return { running: children.filter((c) => c.status === "running").length, needsYou, done: children.filter((c) => c.status === "done").length,
    open: children.filter((c) => c.status !== "done" && !c.cancelled).length, cancelled: children.filter((c) => c.cancelled).length, points: points === null ? null : Math.round(points * 10) / 10, children };
}

// ---- Phase 3 (master plan section 8, docs/plans/MASTER-PLAN-capability-profiles-and-orchestration.md): governed runs ----
// A root the user approves as governed carries trusted limits, the profiles its run may delegate (pinned snapshots) and a default child
// profile. Its own execution profile is the card's `profile` (phase 2); what it may delegate is `governed.delegation`. Children get a
// narrowed `delegation`, never a wider one. Execution leases bound how many sessions may run at once, separately from open-card caps.
// No numerical default exists (O2 is open): every limit is typed in at approval. Pure: the board supplies liveness and files.

/** The board.js protocol that can carry governed fields (profile, assignment, delegate, submit). Older clients are refused in governed runs. */
export const GOVERNED_PROTOCOL = 3;
export const PROVIDER_DEFAULTS = "provider-defaults";
/** What capabilities.json says about governed runs (Board.publishCapabilities). */
export const GOVERNED_CAPABILITY = { protocol: GOVERNED_PROTOCOL, ops: ["add --profile --assignment-file --delegate-file", "submit", "overview --since", "integrate <child>", "readiness <id>", "council convene|reconcile|retry|show"],
  targetEffects: "only the user's Finish on the root, after the readiness check (phase 4); push is a separate choice in that Finish; children integrate into their opener's branch (integrate, or the user's Merge)", unsupported: ["watchers", "adopt", "claim", "claim-tree", "handoff", "request-takeover", "finish self", "battle", "plan-file runs"] };
export interface GovernedLimits { active: number; directChildren: number; depth: number }
/** What a card may delegate: exact profile refs (`<scoped id>@<revision>` or provider-defaults), the default for an unnamed child, and edges left below it. */
export interface Delegation { allowed: string[]; defaultChild?: string; depth: number }
/** One execution slot: reserved before a launch, active once the session is seen, released only when the session is known to have ended. */
export interface Lease { card: string; op: string; at: string; state: "reserved" | "active"; /** Phase 4: the board instance that reserved it (launch reconciliation after a crash). */ owner?: string }
export interface Governance {
  v: 1; revision: 1; at: string; setBy: "user-selection";
  limits: GovernedLimits;
  /** ref → pinned selection, copied when the user approved; children pin from here, never from the live profile files. */
  profiles: Record<string, ProfileSelection>;
  delegation: Delegation;
  leases: Lease[];
  /** Material event sequence of this run (board.js overview --since). */
  seq: number;
  /** Idempotent add: `<opener>:<assignment key>` → the card made for it and a hash of its payload. */
  keys?: Record<string, { card: string; hash: string }>;
  /** The deadlock text last announced, so it is announced once. */
  noticed?: string;
  /** Phase 4: the target branch and its commit when the user approved the run (drift baseline). Unset for runs governed before phase 4. */
  target?: { ref: string; sha: string };
  /** Phase 5: the council the user chose at approval (pinned revision) and its rounds. Unset: no council (not configured). */
  council?: import("./council").CouncilRun;
}
/** A bounded assignment: what the child owns and must return. */
export interface Assignment { key: string; outcome: string; owns?: string[]; acceptance?: string[]; evidence?: string[]; returns?: string }
/** A validated handoff: the exact revision, the files git says changed, and the board's check status beside what the child claimed. */
export interface Submission { head: string; base: string; claimedBase?: string; summary: string; files: string[]; claimedFiles?: string[]; checksClaimed?: string[]; checks: string; limitations?: string; decisions?: string[]; covers?: string[]; at: string }

export const profileRef = (sel: ProfileSelection | undefined): string | undefined =>
  !sel ? undefined : sel.mode === "provider-defaults" ? PROVIDER_DEFAULTS : `${sel.snapshot.id}@${sel.snapshot.revision}`;

const posInt = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
/**
 * the user's governed configuration from the approval row, checked. `pin` reads the current profile files (phase 2's pin) and throws for an
 * unknown, archived or altered profile. A ref may name its revision; a revision other than the newest is unavailable for new pins.
 */
export function validateGovernance(raw: unknown, pin: (id: string) => ProfileSelection, now = new Date()): { governance: Governance } | { error: string } {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  if (!r) return { error: "Governed run: no configuration" };
  // council is pinned by Board.govern (src/council.ts pinCouncil); here it is only allowed.
  for (const k of Object.keys(r)) if (!["limits", "allowed", "defaultChild", "council"].includes(k)) return { error: `Governed run: unknown field ${k}` };
  const l = r.limits as Record<string, unknown> | undefined;
  // No default for any limit (O2 is undecided): a missing one is a choice still to make, never a number filled in here.
  if (!l || typeof l !== "object") return { error: "Governed run: choose the limits (active executions, direct children, depth); there are no defaults" };
  for (const k of Object.keys(l)) if (!["active", "directChildren", "depth"].includes(k)) return { error: `Governed run: unknown limit ${k}` };
  if (!posInt(l.active, 1, 32)) return { error: "Governed run: active executions must be a whole number from 1 to 32 (it counts the root, coordinators, workers and judges)" };
  if (!posInt(l.directChildren, 1, 32) || (l.directChildren as number) > (l.active as number)) return { error: "Governed run: direct children must be a whole number from 1 to the active limit" };
  if (!posInt(l.depth, 1, 8)) return { error: "Governed run: depth must be a whole number from 1 to 8" };
  if (!Array.isArray(r.allowed) || !r.allowed.length || r.allowed.length > 20 || !r.allowed.every((x) => typeof x === "string" && x.length <= 300) || new Set(r.allowed).size !== r.allowed.length)
    return { error: "Governed run: choose at least one profile children may use (Provider defaults counts only when chosen)" };
  const profiles: Record<string, ProfileSelection> = {}, allowed: string[] = [];
  for (const want of r.allowed as string[]) {
    if (want === PROVIDER_DEFAULTS) { profiles[want] = { mode: "provider-defaults" }; allowed.push(want); continue; }
    const [id, rev] = want.split("@");
    let sel: ProfileSelection;
    try { sel = pin(id); } catch (e) { return { error: `Governed run: ${e instanceof Error ? e.message : String(e)}` }; }
    if (sel.mode !== "strict") return { error: `Governed run: ${want} is not a profile` };
    if (rev !== undefined && Number(rev) !== sel.snapshot.revision) return { error: `Governed run: ${want} is unavailable; ${id} is at revision ${sel.snapshot.revision}` };
    const ref = profileRef(sel)!;
    if (profiles[ref]) return { error: `Governed run: ${ref} is listed twice` };
    profiles[ref] = sel; allowed.push(ref);
  }
  let defaultChild: string | undefined;
  if (r.defaultChild !== undefined && r.defaultChild !== null && r.defaultChild !== "") {
    if (typeof r.defaultChild !== "string") return { error: "Governed run: default child profile must be one of the allowed profiles" };
    defaultChild = allowed.find((a) => a === r.defaultChild || a.split("@")[0] === r.defaultChild);
    if (!defaultChild) return { error: `Governed run: default child profile ${r.defaultChild} is not among the allowed profiles` };
  }
  return { governance: { v: 1, revision: 1, at: now.toISOString(), setBy: "user-selection", limits: { active: l.active as number, directChildren: l.directChildren as number, depth: l.depth as number },
    profiles, delegation: { allowed, ...(defaultChild ? { defaultChild } : {}), depth: l.depth as number }, leases: [], seq: 0 } };
}

/** The governed run a card belongs to: its own root, its `governedBy` marker, or the first governed card up its opener and parent chain. */
export function governedRootOf(task: Task, tasks: Task[]): { id: string; root?: Task } | undefined {
  const seen = new Set<string>();
  for (let t: Task | undefined = task, i = 0; t && i < 25 && !seen.has(t.id); i++) {
    seen.add(t.id);
    if (t.governed) return { id: t.id, root: t };
    if (t.governedBy) { const id = t.governedBy; return { id, root: tasks.find((x) => x.id === id && !!x.governed) }; }
    const up: string | undefined = t.openedBy ?? t.parentId;
    t = up ? tasks.find((x) => x.id === up) : undefined;
  }
  return undefined;
}
/** Edges from the governed root down to the card (opener, else parent). */
export function governedDepth(task: Task, rootId: string, tasks: Task[]): number {
  let d = 0;
  for (let t: Task | undefined = task; t && t.id !== rootId && d < 25; d++) { const up: string | undefined = t.openedBy ?? t.parentId; t = up ? tasks.find((x) => x.id === up) : undefined; }
  return d;
}
/** What the card may delegate: the root's allowance, a coordinator's narrowed one, nothing for a worker. */
export const allowanceOf = (t: Task): Delegation | undefined => t.governed ? t.governed.delegation : t.delegation;

/** The child's profile: the named ref, else the allowance's default; refused outside the allowance or when nothing is pinned for it. */
export function childProfile(allowance: Delegation | undefined, g: Governance, requested?: string | null): { ref: string; selection: ProfileSelection } | { error: string } {
  if (!allowance) return { error: "Governed run: this card has no delegation allowance (a worker opens no cards)" };
  const ref = requested ? allowance.allowed.find((a) => a === requested || a.split("@")[0] === requested) ?? requested : allowance.defaultChild;
  if (!ref) return { error: `Governed run: choice required. There is no default child profile; name one with --profile (${allowance.allowed.join(", ")})` };
  if (!allowance.allowed.includes(ref)) return { error: `Governed run: profile ${ref} is not in this card's delegation allowance (${allowance.allowed.join(", ")})` };
  const selection = g.profiles[ref];
  if (!selection) return { error: `Governed run: profile ${ref} is not pinned in the run's approved configuration` };
  if (selection.mode === "strict") { const why = snapshotProblem(selection); if (why) return { error: `Governed run: profile ${ref} is unavailable (${why})` }; }
  return { ref, selection };
}
/** A coordinator child's allowance: a subset of the parent's refs, a default among them, and fewer edges. Undefined for a worker. */
export function narrowDelegation(parent: Delegation | undefined, req: Partial<Delegation> | undefined, mayOpen: boolean): { delegation?: Delegation } | { error: string } {
  if (!mayOpen) return req ? { error: "delegate needs --may-open: a worker opens no cards" } : {};
  if (!parent) return { error: "Governed run: this card has no delegation allowance" };
  if (parent.depth < 2) return { error: `Governed run: depth. A coordinator here could not open cards (this card has ${parent.depth} edge${parent.depth === 1 ? "" : "s"} of delegation left)` };
  const allowed = req?.allowed ?? parent.allowed;
  const outside = allowed.filter((a) => !parent.allowed.includes(a));
  if (outside.length) return { error: `Governed run: delegate ${outside.join(", ")} is outside this card's allowance (${parent.allowed.join(", ")}); a descendant never gets more than its parent` };
  if (!allowed.length) return { error: "Governed run: a coordinator needs at least one profile to delegate" };
  if (req?.defaultChild !== undefined && !allowed.includes(req.defaultChild)) return { error: `Governed run: default child ${req.defaultChild} is not among the delegated profiles` };
  const depth = req?.depth ?? parent.depth - 1;
  if (!Number.isInteger(depth) || depth < 1 || depth > parent.depth - 1) return { error: `Governed run: delegate depth must be from 1 to ${parent.depth - 1}` };
  const defaultChild = req?.defaultChild ?? (parent.defaultChild && allowed.includes(parent.defaultChild) ? parent.defaultChild : undefined);
  return { delegation: { allowed: [...allowed], ...(defaultChild ? { defaultChild } : {}), depth } };
}

/** The first governed card in this card's run below it (openedBy chain: the cards its Finish merges), or undefined. A manual subtask is not merged by its parent. */
export function governedBelow(task: Task, tasks: Task[]): Task | undefined {
  const under = (t: Task) => { for (let x: Task | undefined = t, i = 0; x && i < 25; i++) { const up: string | undefined = x.openedBy; if (up === task.id) return true; x = up ? tasks.find((y) => y.id === up) : undefined; } return false; };
  return tasks.find((t) => t.id !== task.id && (t.governed || t.governedBy) && under(t));
}
/**
 * Why a route that is not an explicit authorization (periodic delivery, self-finish, finish self, plan merges and archival, a root's Merge)
 * is refused for this card, or undefined for a legacy card. Phase 4: a governed run reaches the target only through the user's Finish on its
 * root after Board.readiness passes; a child reaches its run branch only through integrate (board.js integrate, or the user's Merge).
 */
export function targetEffectRefusal(task: Task, tasks: Task[], what: string): string | undefined {
  const g = governedRootOf(task, tasks);
  if (!g) {
    // A legacy card that holds governed cards below it (moved there by any route) would carry their work to the target with its own.
    const held = governedBelow(task, tasks);
    return held ? `${what} is blocked: governed card ${held.id} (run ${held.governedBy ?? held.id}) sits under card ${task.id}; a governed card's work reaches the target only through its own run's readiness check.` : undefined;
  }
  return `${what} is blocked: card ${task.id} belongs to governed run ${g.id}, and ${what.toLowerCase()} is not an explicit authorization. A governed run reaches the target only through the user's Finish on its root after the readiness check (push is a separate choice there); a child reaches its run branch only through integrate (board.js integrate, or the user's Merge).`;
}

export interface LeaseView { live: (t: Task) => boolean; starting: (t: Task) => boolean; now: number; graceMs?: number }
/** A lease ends only when its session is known to have ended: no live process, no launch under way, not Running. A reservation that never came up ends after a launch error, a cancel or the grace time. */
export function releasable(l: Lease, t: Task | undefined, v: LeaseView): boolean {
  if (!t) return true;
  if (v.live(t) || t.status === "running") return false;
  if (l.state === "active") return true;
  // A reservation whose run already came and settled (its column changed after the reservation) ended, even between two looks;
  // so did one whose launch failed or whose card was cancelled. Otherwise a launch still on its way keeps it; else the grace time.
  const settledSince = ["review", "needs-input", "done"].includes(t.status) && (Date.parse(t.statusAt ?? "") || 0) > (Date.parse(l.at) || 0);
  if (settledSince || t.launchError || t.cancelled) return true;
  return !v.starting(t) && v.now - (Date.parse(l.at) || 0) > (v.graceMs ?? 120_000);
}
/** Leases after a look at the board: which stay (a reservation seen live becomes active) and which end. */
export function reconcileLeases(g: Governance, tasks: Task[], v: LeaseView): { leases: Lease[]; released: Lease[]; changed: boolean } {
  const leases: Lease[] = [], released: Lease[] = [];
  let changed = false;
  for (const l of g.leases) {
    const t = tasks.find((x) => x.id === l.card);
    if (releasable(l, t, v)) { released.push(l); changed = true; continue; }
    if (l.state === "reserved" && t && (v.live(t) || t.status === "running")) { leases.push({ ...l, state: "active" }); changed = true; } else leases.push(l);
  }
  return { leases, released, changed };
}

/** A card that wants a lease now: a parent continuation (notices waiting), a judge with work, or a ready card to start. */
export interface Waiter { task: Task; kind: "continuation" | "judge" | "start" }
const KIND_RANK = { continuation: 0, judge: 1, start: 2 } as const;
const KIND_TEXT = { continuation: "parent continuation", judge: "judge", start: "ready card" } as const;
const opener = (t: Task, rootId: string) => t.id === rootId ? undefined : t.openedBy ?? t.parentId;
export const waiterKind = (t: Task): Waiter["kind"] => t.role === "judge" || t.council ? "judge" : (t.governed || t.delegation) && t.sessionId ? "continuation" : "start";
/** Admission order: parent continuations, then judges, then new work; within a class the group with fewest active leases first (round robin), then the oldest wait (aging). */
export function admissionOrder(waiting: Waiter[], g: Governance, tasks: Task[], rootId: string): Waiter[] {
  const groupActive = (p: string | undefined) => g.leases.filter((l) => { const x = tasks.find((t) => t.id === l.card); return !!x && opener(x, rootId) === p; }).length;
  const since = (t: Task) => Date.parse(t.statusAt ?? t.createdAt) || 0;
  return [...waiting].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || groupActive(opener(a.task, rootId)) - groupActive(opener(b.task, rootId)) || since(a.task) - since(b.task) || a.task.id.localeCompare(b.task.id));
}
/**
 * Why the card may not take an execution lease now, or undefined. A card holding one keeps it (a duplicate launch shares it). Otherwise
 * the run's active limit, its opener's direct-children limit, and the slots reserved for waiters ahead of it in admission order.
 */
export function admission(card: Task, root: Task, tasks: Task[], waiting: Waiter[]): string | undefined {
  const g = root.governed!;
  const holds = (id: string) => g.leases.some((l) => l.card === id);
  if (holds(card.id)) return undefined;
  const limit = g.limits.active, used = g.leases.length;
  if (used >= limit) return `Waiting for an execution lease: ${used} of ${limit} active in governed run ${root.id}`;
  const groupActive = (p: string) => g.leases.filter((l) => { const x = tasks.find((t) => t.id === l.card); return !!x && opener(x, root.id) === p; }).length;
  const fits = (t: Task) => { const p = opener(t, root.id); return !p || groupActive(p) < g.limits.directChildren; };
  if (!fits(card)) return `Waiting for an execution lease: card ${opener(card, root.id)} already has ${g.limits.directChildren} direct children active`;
  const all = waiting.some((w) => w.task.id === card.id) ? waiting : [...waiting, { task: card, kind: waiterKind(card) }];
  const ahead = admissionOrder(all.filter((w) => fits(w.task) && !holds(w.task.id)), g, tasks, root.id).slice(0, limit - used);
  if (ahead.some((w) => w.task.id === card.id)) return undefined;
  return `Waiting for an execution lease: the free ${limit - used === 1 ? "slot is" : "slots are"} reserved for ${ahead.map((w) => `${w.task.id} (${KIND_TEXT[w.kind]})`).join(", ")}`;
}
/** Every lease held by a session that is not working while ready cards wait: nobody can progress until a holder ends its session. */
export function deadlock(root: Task, tasks: Task[], waiting: Waiter[]): string | undefined {
  const g = root.governed!;
  if (g.leases.length < g.limits.active || !waiting.length) return undefined;
  const holders = g.leases.map((l) => tasks.find((t) => t.id === l.card));
  if (holders.some((t) => !t || t.status === "running" || (t.status === "queued" && !t.sessionId))) return undefined; // working, or still launching
  return `Capacity deadlock in governed run ${root.id}: all ${g.limits.active} execution leases are held by sessions that are not working (${holders.map((t) => `${t!.id} ${t!.status}`).join(", ")}) while ${waiting.length} ready card${waiting.length === 1 ? "" : "s"} wait (${waiting.map((w) => w.task.id).join(", ")}). A lease is released only when its session has ended: finish that turn or stop one of the holders.`;
}

/** Governed runs never count a missing or failed dependency as accepted (the legacy queue skips a deleted one). */
export function dependencyBlock(task: Task, tasks: Task[]): string | undefined {
  for (const id of task.dependsOn ?? []) {
    const d = tasks.find((t) => t.id === id);
    if (!d) return `Blocked: dependency ${id} is missing; a governed run never counts a deleted card as accepted. Cancel this card or reassign the work`;
    if (d.discarded || d.cancelled || (d.launchError && d.status !== "done")) return `Blocked: dependency ${d.id} (${d.title}) failed (${d.discarded ? "discarded" : d.cancelled ? "cancelled" : "launch failed"}); reassign it or cancel this card`;
  }
  return undefined;
}
/** A cycle in Start after links among these cards (and an optional new card's), as ids in order, or undefined. */
export function dependencyCycle(tasks: Task[], extra?: { id: string; dependsOn: string[] }): string[] | undefined {
  const edges = new Map(tasks.map((t) => [t.id, t.dependsOn ?? []]));
  if (extra) edges.set(extra.id, extra.dependsOn);
  const state = new Map<string, 1 | 2>(), stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 2) return undefined;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1); stack.push(id);
    for (const d of edges.get(id) ?? []) if (edges.has(d)) { const c = visit(d); if (c) return c; }
    stack.pop(); state.set(id, 2);
    return undefined;
  };
  for (const id of edges.keys()) { const c = visit(id); if (c) return c; }
  return undefined;
}
const normPath = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
export const pathsMeet = (a: string, b: string) => { const x = normPath(a), y = normPath(b); return x === y || x.startsWith(y + "/") || y.startsWith(x + "/"); };
/** Open assignments whose declared ownership or submitted files meet: a coordination signal, not proof of a conflict. */
export function overlaps(cards: Task[]): { a: string; b: string; paths: string[] }[] {
  const open = cards.filter((t) => t.status !== "done" && !t.cancelled && !t.discarded).map((t) => ({ id: t.id, paths: [...(t.assignment?.owns ?? []), ...(t.submission?.files ?? [])] })).filter((x) => x.paths.length);
  const out: { a: string; b: string; paths: string[] }[] = [];
  for (let i = 0; i < open.length; i++) for (let j = i + 1; j < open.length; j++) {
    const paths = [...new Set(open[i].paths.filter((p) => open[j].paths.some((q) => pathsMeet(p, q))).map(normPath))];
    if (paths.length) out.push({ a: open[i].id, b: open[j].id, paths: paths.slice(0, 10) });
  }
  return out;
}
/** A stable digest of an assignment payload, for idempotent add (same key, same payload: the same card; another payload: refused). */
export const payloadHash = (x: unknown) => JSON.stringify(x);

/** The compact, authoritative brief: derived from the root's accepted spec (phase 1) or prompt, and the user's governed configuration. Not editable. */
export function governedBrief(root: Task): Record<string, unknown> {
  const g = root.governed!, rec = root.spec?.revisions.at(-1);
  return { root: root.id, title: root.title,
    ...(rec ? { outcome: rec.record.outcome.goal, deliverable: rec.record.outcome.deliverable,
      requirements: rec.record.requirements.slice(0, 12).map((r, i) => ({ id: rec.ids.requirements[i] ?? r.id, text: r.text.slice(0, 200), source: r.provenance })),
      acceptance: rec.record.success.criteria.slice(0, 12).map((a, i) => ({ id: rec.ids.acceptance[i] ?? a.id, text: a.text.slice(0, 200) })),
      exclusions: rec.record.permissions.prohibited.slice(0, 8).map((s) => s.text.slice(0, 200)),
      unresolved: rec.record.unresolved.slice(0, 8).map((u) => u.text.slice(0, 200)) }
      : { outcome: root.prompt.slice(0, 600) }),
    decisions: [`Governed configuration selected by the user at ${g.at} (revision ${g.revision})`],
    allowances: { limits: g.limits, allowed: g.delegation.allowed, defaultChild: g.delegation.defaultChild ?? null, rootProfile: profileRef(root.profile) ?? PROVIDER_DEFAULTS },
    targetEffects: "the user's Finish on the root after the readiness check (board.js readiness self); push only when he chooses it; children integrate into their opener's branch",
    council: g.council ? { name: g.council.snapshot.name, ref: `${g.council.snapshot.id}@${g.council.snapshot.revision}`, checkpoints: g.council.snapshot.checkpoints, rounds: g.council.snapshot.limits.rounds,
      how: "board.js council convene <checkpoint> once the candidate is clean and its checks passed; then board.js council reconcile <checkpoint> --file F.json for every material finding. Finish needs each checkpoint passed for the current candidate." } : "not configured" };
}

export interface OverviewView { waitOf: (t: Task) => string | undefined; live: (t: Task) => boolean; current: (t: Task) => boolean | undefined; waiting: Waiter[]; budget?: Budget; council?: unknown }
/** The project overview from actual state: what runs, waits, is blocked, is ready to integrate, and what needs a decision. Evidence by reference. */
export function governedOverview(root: Task, tasks: Task[], v: OverviewView): Record<string, unknown> {
  const g = root.governed!;
  const members = tasks.filter((t) => t.id !== root.id && governedRootOf(t, tasks)?.id === root.id);
  const line = (t: Task, extra: Record<string, unknown> = {}) => ({ id: t.id, title: t.title.slice(0, 80), by: opener(t, root.id) ?? null, ...(t.assignment ? { key: t.assignment.key } : {}), profile: profileRef(t.profile) ?? PROVIDER_DEFAULTS, ...extra });
  const groups: Record<string, unknown[]> = { running: [], queued: [], waiting: [], blocked: [], ready: [], completed: [], cancelled: [] };
  const decisions: { id: string; text: string }[] = [];
  for (const t of members) {
    if (t.council) continue; // a council member is a reviewer, listed under council
    const wait = v.waitOf(t);
    if (t.conflict && t.status !== "done" && !t.cancelled && !t.discarded) decisions.push({ id: t.id, text: `integration into ${t.conflict.into} conflicts in ${t.conflict.files.join(", ")}: serialize the work or name one integration owner` });
    if (t.cancelled || t.discarded) groups.cancelled.push(line(t));
    else if (t.status === "done") groups.completed.push(line(t, { ...(t.submission ? { head: t.submission.head.slice(0, 12) } : {}), ...(t.integrated ? { integrated: { into: t.integrated.into, after: t.integrated.after.slice(0, 12) } } : {}) }));
    else if (t.status === "running") groups.running.push(line(t));
    else if (t.status === "needs-input" || t.launchError) { decisions.push({ id: t.id, text: t.launchError ? `launch failed: ${t.launchError.slice(0, 200)}` : "needs input" }); groups.waiting.push(line(t)); }
    else if (t.submission && t.status === "review") groups.ready.push(line(t, { head: t.submission.head.slice(0, 12), files: t.submission.files.length, checks: t.completion?.commands.length ? t.checks?.status ?? "not run" : "none required", current: v.current(t) ?? "unknown" }));
    else if (wait?.startsWith("Blocked")) groups.blocked.push(line(t, { reason: wait }));
    else if (t.status === "queued") groups.queued.push(line(t, wait ? { reason: wait } : {}));
    else groups.waiting.push(line(t, { live: v.live(t) }));
  }
  const dl = deadlock(root, tasks, v.waiting), ov = overlaps(members);
  if (dl) decisions.push({ id: root.id, text: dl });
  for (const o of ov) decisions.push({ id: o.a, text: `overlap with ${o.b} on ${o.paths.join(", ")}: serialize (--after) or name one integration owner` });
  return { protocol: GOVERNED_PROTOCOL, seq: g.seq, root: { id: root.id, status: root.status, live: v.live(root) },
    leases: { active: g.leases.length, limit: g.limits.active, holders: g.leases.map((l) => ({ card: l.card, state: l.state, since: l.at })) },
    ...groups, decisions, council: v.council ?? "not configured", budget: v.budget ? { used: v.budget.used, cap: v.budget.cap, unknown: v.budget.unknown } : "no points budget set",
    evidence: "board.js show <id> (status, checks, recent events); board.js events <id>; checks receipts under .entomatical/checks/<id>/" };
}
