import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { Board, Task } from "./board";
import { writeFileAtomic } from "./sessions";
import * as os from "os";
import { codexMeasurement } from "./codex";
import { antigravityMeasurement, grokMeasurement } from "./providerUsage";

export interface Tokens { input: number; cacheRead: number; cacheWrite: number; output: number }
interface Source { kind: string; file: string; identity?: string; line?: number; byteOffset?: number }
export interface MeasurementDiagnostic {
  id: string; code: string; message: string; metric: "tokens" | "context" | "diagnostics";
  firstObservedAt: number; source?: Source; facts?: Record<string, any>;
  taskId?: string; sessionId?: string; stored?: boolean;
}
export interface Measurement {
  tokens: Tokens; total?: number; complete: boolean; source: "stream" | "transcript" | "unknown";
  models: Record<string, Tokens>; gaps: string[]; diagnostics: MeasurementDiagnostic[]; at?: number;
  context?: { usedPercent: number; capacity?: number; at: number };
}
const zero = (): Tokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
const count = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const object = (v: any): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const sum = (t: Tokens) => t.input + t.cacheRead + t.cacheWrite + t.output;
const add = (a: Tokens, b: Tokens) => { for (const k of Object.keys(a) as Array<keyof Tokens>) a[k] += b[k]; };
const empty = (): Measurement => ({ tokens: zero(), complete: false, source: "unknown", models: {}, gaps: [], diagnostics: [] });
const fingerprint = (d: Omit<MeasurementDiagnostic, "id" | "firstObservedAt">) => crypto.createHash("sha256")
  .update(JSON.stringify([d.code, d.metric, d.taskId, d.sessionId, d.source, d.facts])).digest("hex");
function diagnostic(code: string, message: string, source?: Source, facts?: Record<string, any>, metric: MeasurementDiagnostic["metric"] = "tokens"): MeasurementDiagnostic {
  const d = { code, message: source ? `${message} (${source.file}${source.line ? `, line ${source.line}` : ""})` : message, metric, source, facts };
  return { ...d, id: fingerprint(d), firstObservedAt: Date.now() };
}
function note(m: Measurement, d: MeasurementDiagnostic) {
  if (!m.diagnostics.some(old => old.id === d.id)) m.diagnostics.push(d);
  if (!m.gaps.includes(d.message)) m.gaps.push(d.message);
  if (d.metric === "tokens") m.complete = false;
}
// Error.message can contain transcript fragments. Keep only OS codes and the error class.
function safeError(e: unknown) {
  const error = e as NodeJS.ErrnoException;
  return { errorType: e instanceof SyntaxError ? "SyntaxError" : "Error", errorCode: typeof error?.code === "string" ? error.code : undefined,
    operation: typeof error?.syscall === "string" ? error.syscall : undefined };
}
function fields(value: unknown, names: string[], prefix = "") {
  const m = object(value) ? value : {};
  return { missingFields: names.filter(k => m[k] === undefined).map(k => prefix + k),
    invalidFields: names.filter(k => m[k] !== undefined && !count(m[k])).map(k => prefix + k) };
}
function modelIssues(value: unknown) {
  const problems: { missingFields: string[]; invalidFields: string[] } = { missingFields: [], invalidFields: [] };
  if (!object(value) || !Object.keys(value).length) {
    (value === undefined ? problems.missingFields : problems.invalidFields).push("modelUsage"); return problems;
  }
  for (const [name, raw] of Object.entries(value)) {
    const issue = fields(raw, ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"], `${name}.`);
    problems.missingFields.push(...issue.missingFields); problems.invalidFields.push(...issue.invalidFields);
  }
  return problems;
}
export function modelTotals(value: unknown): Record<string, Tokens> | undefined {
  const issue = modelIssues(value);
  if (issue.missingFields.length || issue.invalidFields.length) return;
  return Object.fromEntries(Object.entries(value as Record<string, any>).map(([name, m]) => [name,
    { input: m.inputTokens, output: m.outputTokens, cacheRead: m.cacheReadInputTokens, cacheWrite: m.cacheCreationInputTokens }]));
}
function recordIssues(r: any) {
  if (!object(r)) return { valueType: r === null ? "null" : Array.isArray(r) ? "array" : typeof r };
  const checks: Record<string, boolean> = { producer: typeof r.producer === "string" && !!r.producer,
    sequence: Number.isSafeInteger(r.sequence) && r.sequence >= 0, at: count(r.at), kind: ["start", "activity", "reset", "result"].includes(r.kind) };
  if (r.kind === "start") checks.resumed = typeof r.resumed === "boolean";
  if (r.kind === "result") checks.subtype = typeof r.subtype === "string";
  return { missingFields: Object.keys(checks).filter(k => r[k] === undefined), invalidFields: Object.keys(checks).filter(k => r[k] !== undefined && !checks[k]) };
}
function validRecord(r: any) {
  return object(r) && typeof r.producer === "string" && !!r.producer && Number.isSafeInteger(r.sequence) && r.sequence >= 0 && count(r.at)
    && ["start", "activity", "reset", "result"].includes(r.kind)
    && (r.kind !== "start" || typeof r.resumed === "boolean") && (r.kind !== "result" || typeof r.subtype === "string");
}
/** Final snapshots are cumulative and inclusive of native children. Never add their transcript counts again. */
export function summarizeStream(records: any[]): Measurement {
  const result = empty();
  let current: Record<string, Tokens> = {}, base: Record<string, Tokens> = {}, pending = false, knownStart = false;
  let currentProducer: string | undefined; // the process whose result `current` is
  const seen = new Set<string>();
  for (const r of records) {
    if (!validRecord(r)) { note(result, diagnostic("source_record_invalid", "A usage record has an invalid shape or identity.", r?._source, recordIssues(r))); continue; }
    const id = `${r.producer}:${r.sequence}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const facts = { producer: r.producer, sequence: r.sequence };
    if (r.kind === "start") { knownStart ||= r.resumed === false; pending = true; continue; }
    if (r.kind === "activity") { pending = true; continue; }
    if (r.kind === "reset") {
      for (const [m, t] of Object.entries(current)) { base[m] ??= zero(); add(base[m], t); }
      current = {}; pending = true; continue;
    }
    const models = modelTotals(r.modelUsage);
    if (!models) { note(result, diagnostic("source_fields_invalid", "A final usage record has missing or invalid token fields.", r._source, { ...facts, ...modelIssues(r.modelUsage) })); pending = true; continue; }
    if (r.subtype === "error_during_execution") { note(result, diagnostic("usage_result_incomplete", "Claude reported an execution error; final usage is incomplete.", r._source, facts)); pending = true; continue; }
    const decreases = Object.entries(current).flatMap(([model, t]) => (Object.keys(t) as Array<keyof Tokens>)
      .filter(field => !models[model] || models[model][field] < t[field])
      .map(field => ({ model, field, previous: t[field], current: models[model]?.[field] ?? null })));
    if (decreases.length) {
      // A resumed process sometimes continues the previous process's totals and sometimes starts again from zero (measured on one session:
      // the first process ended at 4,446,508; the resumed one's first result was 1,191,118 under another model). So a new process whose first
      // result is lower than the last total started again, and the last total is kept as for a reset. Within one process a decrease is an error.
      if (currentProducer === undefined || currentProducer === r.producer) { note(result, diagnostic("counter_decreased", "Cumulative counters decreased without a verified reset.", r._source, { ...facts, decreases })); continue; }
      for (const [m, t] of Object.entries(current)) { base[m] ??= zero(); add(base[m], t); }
    }
    current = models; currentProducer = r.producer; result.source = "stream"; result.at = r.at; pending = r.subtype !== "success";
    if (pending) note(result, diagnostic("usage_result_incomplete", "The final result did not report success.", r._source, facts));
  }
  for (const [m, t] of Object.entries(current)) { base[m] ??= zero(); add(base[m], t); }
  result.models = base;
  for (const t of Object.values(base)) add(result.tokens, t);
  if (result.source === "stream") result.total = sum(result.tokens);
  if (!knownStart) note(result, diagnostic("session_start_unobserved", "Collection did not observe the beginning of this session."));
  if (pending) note(result, diagnostic("usage_pending", "Work after the latest complete result is not yet accounted for."));
  result.complete = result.source === "stream" && !result.diagnostics.some(d => d.metric === "tokens");
  return result;
}
interface Cursor { identity: string; anchor: Buffer; offset: number; line: number; modified: number; rows: any[]; diagnostics: MeasurementDiagnostic[] }
interface History { size: number; modified: number; entries: Map<string, MeasurementDiagnostic>; tail: boolean }
export class UsageCollector {
  private cursors = new Map<string, Cursor>();
  private saved = new Map<string, string>();
  private known = new Map<string, MeasurementDiagnostic>();
  private histories = new Map<string, History>();
  private failures = new Map<string, MeasurementDiagnostic>();
  private pending = new Map<string, Map<string, MeasurementDiagnostic>>();
  /** Grok and Antigravity readings per card (F93): the board asks on every post, and a live agy run changes its files each call. */
  private providerReadings = new Map<string, { at: number; key: string; m: Measurement }>();
  constructor(private board: Board) {}
  private read(file: string, transcript = false): { rows: any[]; diagnostics: MeasurementDiagnostic[] } {
    let source: Source = { kind: transcript ? "transcript" : "stream", file };
    try {
      const st = fs.statSync(file), identity = `${st.dev}:${st.ino}`;
      source = { ...source, identity };
      if (!st.isFile()) throw Object.assign(new Error("Expected a file"), { code: "EISDIR", syscall: "read" });
      let c = this.cursors.get(file);
      let replaced = false;
      if (c && c.identity === identity && st.size >= c.offset && (st.size !== c.offset || st.mtimeMs !== c.modified) && c.anchor.length) {
        const fd = fs.openSync(file, "r");
        try {
          const anchor = Buffer.alloc(c.anchor.length);
          const n = fs.readSync(fd, anchor, 0, anchor.length, c.offset - anchor.length);
          replaced = n !== anchor.length || !anchor.equals(c.anchor);
        } finally { fs.closeSync(fd); }
      }
      if (!c || replaced || c.identity !== identity || st.size < c.offset || (st.size === c.offset && st.mtimeMs !== c.modified)) {
        c = { identity, anchor: Buffer.alloc(0), offset: 0, line: 1, modified: 0, rows: [], diagnostics: [] }; this.cursors.set(file, c);
      }
      if (st.size > c.offset) {
        const fd = fs.openSync(file, "r");
        try {
          const buffer = Buffer.alloc(st.size - c.offset); const length = fs.readSync(fd, buffer, 0, buffer.length, c.offset);
          let start = 0;
          for (let end = buffer.indexOf(10); end >= 0 && end < length; end = buffer.indexOf(10, start)) {
            const location = { ...source, line: c.line, byteOffset: c.offset + start };
            const text = buffer.subarray(start, end).toString("utf8");
            if (text.trim()) {
              try {
                const r = JSON.parse(text);
                if (!object(r)) c.diagnostics.push(diagnostic("source_record_invalid", "A recorded JSON value is not an object.", location, recordIssues(r)));
                else if (transcript) {
                  if (r.type === "assistant" && r.message?.usage) {
                    if (typeof r.message.id !== "string" || !r.message.id) c.diagnostics.push(diagnostic("source_fields_invalid", "An assistant usage record has no request identity.", location, { missingFields: ["message.id"] }));
                    else c.rows.push({ id: r.message.id, model: r.message.model, usage: r.message.usage, at: Date.parse(r.timestamp), _source: location });
                  }
                } else c.rows.push({ ...r, _source: location });
              } catch (e) { c.diagnostics.push(diagnostic("source_parse_failed", "JSON parsing failed for a measurement source record.", location, safeError(e))); }
            }
            c.line++; start = end + 1;
          }
          if (start) c.anchor = Buffer.from(Buffer.concat([c.anchor, buffer.subarray(Math.max(0, start - 64), start)]).subarray(-64));
          c.offset += start; c.modified = st.mtimeMs;
        } finally { fs.closeSync(fd); }
      }
      const diagnostics = [...c.diagnostics];
      if (st.size > c.offset) diagnostics.push(diagnostic("source_record_partial", "The source ends with an unfinished JSONL record.", { ...source, line: c.line, byteOffset: c.offset }));
      return { rows: c.rows, diagnostics };
    } catch (e) { return { rows: [], diagnostics: [diagnostic("source_read_failed", "A measurement source could not be read.", source, safeError(e))] }; }
  }
  session(task: Task): Measurement {
    if (task.provider === "codex") return codexMeasurement(this.board.transcriptOf(task)); // Codex's own token counts, from its rollout file
    if (task.provider === "grok" || task.provider === "antigravity") { // F93: each CLI's own usage files, found by the card's worktree
      const running = task.status === "running" || task.status === "needs-input";
      const cwd = task.worktree ?? task.ranIn; // a finished card has only ranIn
      const key = JSON.stringify([task.provider, task.status, cwd, task.configDir, task.model]), hit = this.providerReadings.get(task.id);
      if (hit && hit.key === key && Date.now() - hit.at < 10_000) return structuredClone(hit.m); // a copy: persist() adds notes to what it gets
      const result = task.provider === "grok" ? grokMeasurement(task.configDir || path.join(os.homedir(), ".grok"), cwd, running)
        : antigravityMeasurement(cwd, Date.parse(task.createdAt) || 0, running, task.model || "default model");
      note(result, diagnostic("source_unavailable", "Context usage is not reported for this provider.", undefined, undefined, "context"));
      this.providerReadings.set(task.id, { at: Date.now(), key, m: structuredClone(result) });
      return result;
    }
    const dir = path.join(this.board.dir, "metrics");
    let files: string[] = []; const errors: MeasurementDiagnostic[] = [];
    try { files = fs.readdirSync(dir).filter(f => task.sessionId && f.startsWith(task.sessionId + ".") && f.endsWith(".jsonl")); }
    catch (e) { errors.push(diagnostic("source_read_failed", "The stream directory could not be read.", { kind: "stream", file: dir }, safeError(e))); }
    const records = files.map(f => this.read(path.join(dir, f)));
    const stream = summarizeStream(records.flatMap(r => r.rows).sort((a, b) => (a.at || 0) - (b.at || 0) || (a.sequence || 0) - (b.sequence || 0)));
    if (!files.length) note(stream, diagnostic("source_unavailable", "No captured usage stream exists for this session.", { kind: "stream", file: dir }));
    for (const d of [...errors, ...records.flatMap(r => r.diagnostics)]) note(stream, d);
    const lastWork = this.board.events(task.id).filter(e => e.hook_event_name === "UserPromptSubmit" || e.hook_event_name === "PostToolUse").reduce((n, e) => Math.max(n, e.t), 0);
    if (task.status === "running" || task.status === "needs-input" || (stream.at && lastWork > stream.at)) note(stream,
      diagnostic("usage_newer_than_snapshot", "Work is newer than the last settled usage snapshot.", undefined, { snapshotAt: stream.at })); // not status or lastWork: they change every tick, and each change was a new journal line
    let result = stream;
    if (stream.source !== "stream") {
      const transcript = this.board.transcriptOf(task), discovery: MeasurementDiagnostic[] = [];
      // A resumed Claude session's subagents can sit beside another copy of its transcript (board.ts sessionFolders): each agent once, its newest copy.
      const agents = new Map<string, { file: string; at: number }>();
      for (const beside of transcript ? [transcript, ...(this.board.sessionFolders?.(task) ?? []).map(f => `${f}.jsonl`)] : []) {
        const root = path.join(beside.replace(/\.jsonl$/, ""), "subagents");
        for (const file of agentTranscripts(beside, discovery)) {
          let at = 0; try { at = fs.statSync(file).mtimeMs; } catch { /* gone since the listing */ }
          const key = path.relative(root, file), seen = agents.get(key);
          if (!seen || at > seen.at) agents.set(key, { file, at });
        }
      }
      result = this.transcripts(transcript ? [transcript, ...[...agents.values()].map(a => a.file)] : []);
      for (const d of [...stream.diagnostics, ...discovery]) note(result, d);
    }
    const contextFile = path.join(dir, `${task.id}.context.json`), contextSource = { kind: "context", file: contextFile };
    try {
      const c = JSON.parse(fs.readFileSync(contextFile, "utf8"));
      if (object(c) && count(c.usedPercent) && c.usedPercent <= 100 && count(c.at)) result.context = { usedPercent: c.usedPercent, capacity: count(c.capacity) ? c.capacity : undefined, at: c.at };
      else note(result, diagnostic("context_fields_invalid", "The context snapshot has missing or invalid percentage/timestamp fields.", contextSource, undefined, "context"));
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") note(result, diagnostic(e instanceof SyntaxError ? "source_parse_failed" : "source_read_failed", "The context snapshot could not be read or parsed.", contextSource, safeError(e), "context")); }
    if (this.failures.has(task.id)) note(result, this.failures.get(task.id)!);
    result.diagnostics = result.diagnostics.map(d => {
      const bound = { ...d, taskId: task.id, sessionId: task.sessionId }; bound.id = fingerprint(bound);
      const previous = this.known.get(bound.id); if (previous) { bound.firstObservedAt = previous.firstObservedAt; if (previous.stored !== undefined && bound.stored === undefined) bound.stored = previous.stored; }
      this.known.set(bound.id, bound); return bound;
    });
    return result;
  }
  transcripts(files: string[]): Measurement {
    const result = empty();
    note(result, diagnostic("transcript_output_unfinalized", "Transcript output counts are not final; full consumption is unknown."));
    if (!files.length) note(result, diagnostic("source_unavailable", "No session transcript was located."));
    const requests = new Map<string, any>();
    for (const file of files) {
      const data = this.read(file, true); for (const d of data.diagnostics) note(result, d);
      for (const r of data.rows) requests.set(r.id, r);
    }
    for (const r of requests.values()) {
      const issue = fields(r.usage, ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]);
      if (typeof r.model !== "string") issue.invalidFields.push("model");
      if (issue.missingFields.length || issue.invalidFields.length) { note(result, diagnostic("source_fields_invalid", "A request has missing or invalid token fields.", r._source, issue)); continue; }
      const u = r.usage, t = { input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, output: 0 };
      result.models[r.model] ??= zero(); add(result.models[r.model], t); add(result.tokens, t);
      result.source = "transcript"; if (Number.isFinite(r.at)) result.at = Math.max(result.at || 0, r.at);
    }
    return result;
  }
  private history(file: string): History {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; return { size: 0, modified: 0, entries: new Map(), tail: false }; }
    if (!st.isFile()) throw Object.assign(new Error("Expected diagnostic journal file"), { code: "EISDIR", syscall: "read" });
    const hit = this.histories.get(file); if (hit?.size === st.size && hit.modified === st.mtimeMs) return hit;
    const text = fs.readFileSync(file, "utf8"), entries = new Map<string, MeasurementDiagnostic>();
    for (const row of text.split("\n").filter(Boolean)) { try { const d = JSON.parse(row); if (typeof d?.id === "string") entries.set(d.id, d); } catch { /* damaged history remains on disk; later records stay independently readable */ } }
    const result = { size: st.size, modified: st.mtimeMs, entries, tail: !!text && !text.endsWith("\n") }; this.histories.set(file, result); return result;
  }
  persist(task: Task) {
    this.failures.delete(task.id);
    const measurement = this.session(task), dir = path.join(this.board.dir, "measurements"), file = path.join(dir, `${task.id}.diagnostics.jsonl`);
    const pending = this.pending.get(task.id) ?? new Map<string, MeasurementDiagnostic>();
    for (const d of measurement.diagnostics) if (!pending.has(d.id)) pending.set(d.id, d);
    this.pending.set(task.id, pending);
    let target = file;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const history = this.history(file);
      if (history.tail) {
        const d = diagnostic("diagnostic_tail_incomplete", "An interrupted diagnostic tail was retained and separated before appending.", { kind: "diagnostics", file, byteOffset: history.size }, undefined, "diagnostics");
        d.taskId = task.id; d.sessionId = task.sessionId; d.id = fingerprint(d); note(measurement, d); pending.set(d.id, d);
      }
      const fresh = [...pending.values()].filter(d => !history.entries.has(d.id));
      if (fresh.length || history.tail) {
        const fd = fs.openSync(file, "a");
        try { fs.writeFileSync(fd, (history.tail ? "\n" : "") + fresh.map(d => JSON.stringify({ ...d, version: 1, parserVersion: 1, stored: true }) + "\n").join("")); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        for (const d of fresh) history.entries.set(d.id, { ...d, stored: true });
        const st = fs.statSync(file); history.size = st.size; history.modified = st.mtimeMs; history.tail = false; this.histories.set(file, history);
      }
      for (const d of pending.values()) { const prior = history.entries.get(d.id)!; d.firstObservedAt = prior.firstObservedAt; d.stored = true; this.known.set(d.id, d); }
      for (const d of measurement.diagnostics) { d.firstObservedAt = history.entries.get(d.id)!.firstObservedAt; d.stored = true; }
      const json = JSON.stringify({ version: 1, taskId: task.id, sessionId: task.sessionId, account: task.account, ...measurement });
      target = path.join(dir, `${task.id}.json`);
      if (this.saved.get(task.id) !== json) { writeFileAtomic(target, json); this.saved.set(task.id, json); }
      this.pending.delete(task.id);
    } catch (e) {
      const d = diagnostic("diagnostic_write_failed", (target === file ? "Diagnostic evidence could not be persisted; unsaved evidence remains in memory until writing succeeds." : "The measurement snapshot could not be saved; the diagnostic journal was written."), { kind: "diagnostics", file: target }, safeError(e), "diagnostics");
      d.taskId = task.id; d.sessionId = task.sessionId; d.id = fingerprint(d); d.stored = false;
      if (pending.has(d.id)) d.firstObservedAt = pending.get(d.id)!.firstObservedAt;
      pending.set(d.id, d); this.failures.set(task.id, d); note(measurement, d);
    }
    return measurement;
  }
}
export function agentTranscripts(transcript: string, diagnostics: MeasurementDiagnostic[] = []): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const file = path.join(dir, e.name);
      if (e.isDirectory()) visit(file); else if (e.name.endsWith(".jsonl")) files.push(file);
    } } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push(diagnostic("source_read_failed", "A worker transcript directory could not be read.", { kind: "transcript", file: dir }, safeError(e))); }
  };
  visit(path.join(transcript.replace(/\.jsonl$/, ""), "subagents")); return files;
}
