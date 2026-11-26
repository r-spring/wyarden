/**
 * Efficiency summary (F77, the efficiency summary contract idea 1): a fold over one session's call ledger file
 * (docs/ledger.md, written by ledger.ts) and the task's own hook events. No model is called and nothing is written.
 *
 * Pure of VS Code: the board (board.ts efficiencyOf) and the query tool (tools/ledger.js summary and compare, which loads the compiled
 * copy placed beside it in the ledger folder) both use it, so the card and the tool print the same numbers.
 */

/** A call line of sessions/<id>.jsonl (k "c"); only the fields the summary reads. */
export interface LedgerCall { k?: "c"; f?: number; at?: string; promptId?: string; messageId?: string; model?: string; tools?: string[]; input?: number; cacheWrite?: number; cacheRead?: number; output?: number }
export interface LedgerPrompt { k?: "p"; f?: number; n?: number; promptId?: string; at?: string }
export interface LedgerFile { k?: "f"; f?: number; agentId?: string }
export interface LedgerIndex { files: Record<number, LedgerFile>; prompts: LedgerPrompt[]; calls: LedgerCall[] }

/** One prompt of the session: its calls (subagents' included, they carry the parent's promptId), mean context, output and tools. */
export interface PromptRow { n: number; at?: string; calls: number; meanContext: number; output: number; tokens: number; tools: Record<string, number>; tail: boolean }
export interface Efficiency {
  prompts: number; calls: number;
  /** Calls per prompt, one decimal. */
  perPrompt: number;
  /** Mean of input + cacheRead + cacheWrite over all calls, and the same sum for the session's own last call. */
  meanContext: number; endContext: number;
  output: number;
  /** All tokens of the session (input + cacheWrite + cacheRead + output). */
  tokens: number;
  /** Share (0 to 1) of all tokens spent on prompts that began after the first Stop; 0 with one prompt. */
  tail: number;
  /** Where the tail's boundary came from: the task's first Stop event, or (no Stop recorded) the second prompt. */
  tailFrom: "stop" | "prompt";
  /** Calls per model. */
  models: Record<string, number>;
  rows: PromptRow[];
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const context = (c: LedgerCall) => n(c.input) + n(c.cacheRead) + n(c.cacheWrite);
const total = (c: LedgerCall) => context(c) + n(c.output);

/**
 * Parses an index file's text. A half-written line (the ledger appends every 30 s, maybe right now) is skipped. A call written twice
 * by an index from before 4 November 2026 counts once, its last line, as in the catalog and ledger.js.
 */
export function parseIndex(text: string): LedgerIndex {
  const files: Record<number, LedgerFile> = {}, prompts: LedgerPrompt[] = [], calls = new Map<string, LedgerCall>();
  let anonymous = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let l: any;
    try { l = JSON.parse(line); } catch { continue; }
    if (!l || typeof l !== "object") continue;
    if (l.k === "f" && typeof l.f === "number") files[l.f] = l;
    else if (l.k === "p") prompts.push(l);
    else if (l.k === "c") { const key = typeof l.messageId === "string" ? l.messageId : `#${anonymous++}`; calls.delete(key); calls.set(key, l); }
  }
  return { files, prompts, calls: [...calls.values()] };
}

/** The time (ms) of the task's first Stop of the session's own turn: subagents' Stops and other sessions' events are left out. */
export function firstStopAt(events: { t?: unknown; hook_event_name?: unknown; agent_id?: unknown; session_id?: unknown }[], sessionId?: string): number | undefined {
  const stop = events.find((e) => e.hook_event_name === "Stop" && e.agent_id === undefined && (sessionId === undefined || e.session_id === undefined || e.session_id === sessionId));
  return typeof stop?.t === "number" ? stop.t : undefined;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** The summary, or undefined when the index has no calls yet (the card then says "No ledger data yet", never zeros). */
export function efficiency(index: LedgerIndex, firstStop?: number): Efficiency | undefined {
  const { calls, files } = index;
  if (!calls.length) return undefined;
  const prompts = [...index.prompts].sort((a, b) => n(a.n) - n(b.n));
  const at = (s?: string) => (s ? Date.parse(s) : NaN);
  // A prompt is part of the tail when it began after the first Stop; with no Stop recorded (a found session, events lost), every
  // prompt after the first one is. One prompt: no tail.
  const inTail = (p: LedgerPrompt, i: number) => prompts.length > 1 && (firstStop !== undefined ? at(p.at) > firstStop : i > 0);
  const tailIds = new Set(prompts.filter(inTail).map((p) => p.promptId).filter(Boolean));
  const known = new Set(prompts.map((p) => p.promptId).filter(Boolean));
  // A call whose prompt the index does not name (an older transcript) is placed by its own time.
  const callInTail = (c: LedgerCall) => prompts.length > 1 && (c.promptId && known.has(c.promptId) ? tailIds.has(c.promptId) : firstStop !== undefined && at(c.at) > firstStop);
  const tokens = calls.reduce((s, c) => s + total(c), 0);
  const tailTokens = calls.filter(callInTail).reduce((s, c) => s + total(c), 0);
  // The session's own last call (not a subagent's: their context is their own), by time; the index order when times are missing.
  const own = calls.filter((c) => !files[n(c.f)]?.agentId);
  const last = (own.length ? own : calls).reduce((a, b) => (at(b.at) >= at(a.at) || Number.isNaN(at(a.at)) ? b : a));
  const models: Record<string, number> = {};
  // Each prompt's calls from one pass, not a filter per prompt (78 ms a card on an 8,599-call session, audit finding 13).
  const byPrompt = new Map<string, LedgerCall[]>();
  for (const c of calls) {
    if (c.model) models[c.model] = (models[c.model] ?? 0) + 1;
    if (c.promptId) { const list = byPrompt.get(c.promptId); if (list) list.push(c); else byPrompt.set(c.promptId, [c]); }
  }
  const rows = prompts.map((p, i): PromptRow => {
    const mine = (p.promptId && byPrompt.get(p.promptId)) || [];
    const tools: Record<string, number> = {};
    for (const c of mine) for (const t of c.tools ?? []) tools[t] = (tools[t] ?? 0) + 1;
    return { n: n(p.n) || i + 1, at: p.at, calls: mine.length, meanContext: mine.length ? Math.round(mine.reduce((s, c) => s + context(c), 0) / mine.length) : 0,
      output: mine.reduce((s, c) => s + n(c.output), 0), tokens: mine.reduce((s, c) => s + total(c), 0), tools, tail: inTail(p, i) };
  });
  const count = Math.max(prompts.length, 1);
  return {
    prompts: prompts.length, calls: calls.length, perPrompt: round1(calls.length / count),
    meanContext: Math.round(calls.reduce((s, c) => s + context(c), 0) / calls.length), endContext: context(last),
    output: calls.reduce((s, c) => s + n(c.output), 0), tokens,
    tail: tokens ? tailTokens / tokens : 0, tailFrom: firstStop !== undefined ? "stop" : "prompt", models, rows,
  };
}

/** What the card shows (board.js efficiencyLine): the numbers only; the per-prompt rows and models stay in ledger.js. */
export const cardSummary = (e: Efficiency | undefined) => e && { prompts: e.prompts, calls: e.calls, perPrompt: e.perPrompt, meanContext: e.meanContext,
  endContext: e.endContext, output: e.output, tail: Math.round(e.tail * 100) };

/** Thousands as "88k" (one decimal under 10k), for the card's line and the tool. */
export const kilo = (x: number) => (x >= 10_000 ? `${Math.round(x / 1000)}k` : x >= 1000 ? `${round1(x / 1000)}k` : String(Math.round(x)));

/** The median of a list, or undefined when it is empty. */
export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The model that made most of a session's calls. */
export const mainModel = (e: Efficiency) => Object.entries(e.models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";

/** How a finished card ended: its work landed and was checked, it was thrown away or its checks errored, or nobody checked it. */
export type Outcome = "passed" | "failed" | "unverified";
export interface OutcomeCard { status: string; ended?: boolean; discarded?: boolean; checks?: { status: string }; doneReview?: { verdict?: string } }

/**
 * A card's outcome, or undefined when it is not an attempt (not Done, or a found session that only closed). The order matters: a
 * discard is failed even when its checks passed, since its work never landed (F72).
 */
export function outcomeOf(card: OutcomeCard): Outcome | undefined {
  if (card.status !== "done" || card.ended) return undefined;
  if (card.discarded || card.checks?.status === "error") return "failed";
  if (card.checks?.status === "complete") return "passed";
  if (card.doneReview?.verdict === "done") return "passed";
  return "unverified";
}

/** One row of the board's model comparison (F93): finished cards whose main model is this one. */
export interface ModelRow {
  provider: string; model: string; finished: number; measured: number; partial: number;
  medianTotal?: number; medianFresh?: number; medianOutput?: number;
  /** Done cards of the group, discarded ones included (found sessions that only closed are not). */
  attempts: number;
  /** Attempts by outcomeOf. */
  passed: number; failed: number; unverified: number;
  /** All tokens of every measured attempt (failed and unverified included) per passed card, rounded; undefined with no pass or no measurement. */
  perPassed?: number;
  /** The same without cache reads. */
  freshPerPassed?: number;
  /** Median follow-up prompts per attempt (0 when unset). */
  medianFollowUps?: number;
  /** Fewer than 5 attempts measured: too few to compare. */
  fewCards: boolean;
}
type Counted = { input: number; cacheRead: number; cacheWrite: number; output: number };
type Measured = { tokens: Counted; total?: number; complete: boolean; source: string; models: Record<string, Counted> };
/**
 * Done cards (not found sessions that merely closed) grouped by provider and main model: the model that used most of the card's
 * tokens, else the card's chosen model. Antigravity's files name no model, so its cards always group under the chosen one. Medians, not means, so one runaway card does not hide the usual cost. "Fresh" leaves out
 * cache reads, which providers price and count differently. Output is left out where only a transcript was read (Claude's
 * transcript output counts are not final). Cards deleted from the board are not counted.
 *
 * finished, measured, partial and the medians cover cards whose work landed (discards left out). The outcome fields count every
 * attempt, discards included, because failed runs cost about 4 times as much as successful ones (SWE-Effi, arXiv 2509.09853):
 * perPassed charges the tokens of every measured attempt to the passed cards, so a model that often fails costs more per result.
 * A group whose only cards are discarded still gets a row, with finished 0.
 */
export function modelEfficiency(tasks: (OutcomeCard & { provider?: string; model?: string; measurement?: Measured; followUps?: number })[]): ModelRow[] {
  const groups = new Map<string, { row: ModelRow; totals: number[]; fresh: number[]; outputs: number[]; allTotal: number; allFresh: number; attemptsMeasured: number; followUps: number[] }>();
  const sum = (x: Counted) => x.input + x.cacheRead + x.cacheWrite + x.output;
  for (const t of tasks) {
    const outcome = outcomeOf(t);
    if (!outcome) continue;
    const m = t.measurement, measured = !!m && m.source !== "unknown";
    const main = measured ? Object.entries(m!.models).sort((a, b) => sum(b[1]) - sum(a[1]))[0]?.[0] : undefined;
    const provider = t.provider ?? "claude", model = main ?? t.model ?? "default model", key = `${provider}\n${model}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { row: { provider, model, finished: 0, measured: 0, partial: 0, attempts: 0, passed: 0, failed: 0, unverified: 0, fewCards: true },
      totals: [], fresh: [], outputs: [], allTotal: 0, allFresh: 0, attemptsMeasured: 0, followUps: [] });
    g.row.attempts++;
    g.row[outcome]++;
    g.followUps.push(typeof t.followUps === "number" && Number.isFinite(t.followUps) ? t.followUps : 0);
    const totalTokens = measured ? m!.total ?? sum(m!.tokens) : 0, freshTokens = measured ? m!.tokens.input + m!.tokens.cacheWrite + m!.tokens.output : 0;
    if (measured) { g.attemptsMeasured++; g.allTotal += totalTokens; g.allFresh += freshTokens; }
    if (t.discarded) continue; // a discard is Done but its work never landed (F72): only the outcome fields count it
    g.row.finished++;
    if (!measured) continue;
    g.row.measured++;
    if (!m!.complete) g.row.partial++;
    g.totals.push(totalTokens);
    g.fresh.push(freshTokens);
    if (m!.source !== "transcript") g.outputs.push(m!.tokens.output);
  }
  return [...groups.values()].map(({ row, totals, fresh, outputs, allTotal, allFresh, attemptsMeasured, followUps }) => {
    const per = row.passed && attemptsMeasured;
    return { ...row, medianTotal: median(totals), medianFresh: median(fresh), medianOutput: median(outputs),
      perPassed: per ? Math.round(allTotal / row.passed) : undefined, freshPerPassed: per ? Math.round(allFresh / row.passed) : undefined,
      medianFollowUps: median(followUps), fewCards: attemptsMeasured < 5 };
  }).sort((a, b) => a.provider.localeCompare(b.provider) || b.finished - a.finished || a.model.localeCompare(b.model));
}
