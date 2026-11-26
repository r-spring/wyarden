/**
 * Grok and Antigravity token counts, sign-in identity and recent totals (F93), read only from files each CLI writes for itself.
 * Nothing here calls a provider, and no login token is kept: a sign-in file is parsed for its email and dropped.
 *
 * Grok (CLI 1.0.70): <GROK_HOME>/sessions/<encodeURIComponent(cwd)>/<session>/usage.json is the usage ledger `grok usage` prints,
 * cumulative per session with a per-model split and per-turn rows; inputTokens includes cached and cache-write input.
 * <GROK_HOME>/auth.json holds the signed-in email.
 *
 * Antigravity (agy 1.5.2): ~/.gemini/antigravity-cli/conversations/<id>.db is SQLite. trajectory_metadata_blob names an ACP session's workspace
 * (field 1.1, a file URI; a terminal run's comes from its log) and each gen_metadata row is one model call whose field 1.4 holds 2 fresh input, 3 output (with thinking),
 * 5 cache read and 9 thinking. That layout is undocumented: it was read from agy's own files on 6 November 2026 and checked against
 * the usage agy's ACP server reported for the same prompts. agy records no cache writes and no call times. The signed-in email is
 * agy's "applyAuthResult: email=" log line; the token itself is in the OS keyring.
 *
 * Neither CLI reports plan limits, so nothing here claims a share of a plan.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import type { Measurement, Tokens } from "./metrics";

const zero = (): Tokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
const add = (a: Tokens, b: Tokens) => { a.input += b.input; a.cacheRead += b.cacheRead; a.cacheWrite += b.cacheWrite; a.output += b.output; };
const total = (t: Tokens) => t.input + t.cacheRead + t.cacheWrite + t.output;
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const DAY = 24 * 3600_000, WEEK = 7 * DAY;

/** Same folder on this OS: Windows paths compare without case and with either slash. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => { const r = path.resolve(p).replace(/[\\/]+$/, ""); return process.platform === "win32" ? r.replace(/\//g, "\\").toLowerCase() : r; };
  return norm(a) === norm(b);
}

// ---- Grok ----

/** One session's usage.json as Tokens per model, plus its turns' end times and totals. Undefined when unreadable. */
export function grokUsageFile(text: string): { models: Record<string, Tokens>; incomplete: boolean; turns: { at: number; total: number; output: number }[]; at?: number } | undefined {
  let j: any;
  try { j = JSON.parse(text); } catch { return undefined; }
  if (!object(j) || !object(j.session)) return undefined;
  const validCounter = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const tokens = (u: unknown): Tokens | undefined => {
    if (!object(u) || !validCounter(u.inputTokens) || !validCounter(u.outputTokens)) return undefined;
    const cacheRead = count(u.cachedReadTokens), cacheWrite = count(u.cacheCreationTokens);
    return { input: Math.max(0, u.inputTokens - cacheRead - cacheWrite), cacheRead, cacheWrite, output: u.outputTokens };
  };
  const split = j.session.modelUsage;
  let incomplete = split !== undefined && !object(split);
  const models = new Map<string, Tokens>();
  if (object(split)) {
    for (const [model, usage] of Object.entries(split)) {
      const t = tokens(usage);
      if (t) models.set(model, t);
      else incomplete = true;
    }
  }
  // A valid session aggregate can stand in for a missing split. Never add it to model subtotals.
  if (!models.size) {
    const t = tokens(j.session);
    if (t) models.set(typeof j.session.primaryModelId === "string" ? j.session.primaryModelId : "grok", t);
    else incomplete = true;
  }
  const turns = (Array.isArray(j.turns) ? j.turns : []).filter(object).flatMap((t: any) => {
    const tk = tokens(t), at = Date.parse(t.endedAt);
    return tk && Number.isFinite(at) ? [{ at, total: total(tk), output: tk.output }] : [];
  });
  const at = Date.parse(j.updatedAt);
  return { models: Object.fromEntries(models), incomplete, turns, at: Number.isFinite(at) ? at : undefined };
}

/** The session folders Grok keeps for one working directory (its folder name is the directory, URI-encoded). */
function grokSessionDirs(home: string, cwd: string): string[] {
  const root = path.join(home, "sessions");
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  const out: string[] = [];
  for (const name of names) {
    let decoded: string;
    try { decoded = decodeURIComponent(name); } catch { continue; }
    if (!path.isAbsolute(decoded) || !samePath(decoded, cwd)) continue;
    try { for (const s of fs.readdirSync(path.join(root, name), { withFileTypes: true })) if (s.isDirectory()) out.push(path.join(root, name, s.name)); } catch { /* skip */ }
  }
  return out;
}

const grokFiles = new Map<string, { key: string; parsed: ReturnType<typeof grokUsageFile> }>();
function readGrokUsage(file: string) {
  const st = fs.statSync(file), key = `${st.mtimeMs}:${st.size}`, hit = grokFiles.get(file);
  if (hit?.key === key) return hit.parsed;
  const parsed = grokUsageFile(fs.readFileSync(file, "utf8"));
  grokFiles.set(file, { key, parsed });
  return parsed;
}

export function grokMeasurement(home: string, cwd: string | undefined, running: boolean): Measurement {
  const m: Measurement = { tokens: zero(), complete: false, source: "unknown", models: {}, gaps: [], diagnostics: [] };
  if (!cwd) { m.gaps.push("This card has no worktree yet, so its Grok sessions cannot be found."); return m; }
  const models: Record<string, Tokens> = Object.create(null);
  for (const dir of grokSessionDirs(home, cwd)) {
    const file = path.join(dir, "usage.json");
    let u: ReturnType<typeof grokUsageFile>;
    try { u = readGrokUsage(file); } catch { m.gaps.push(`Grok's usage file could not be read: ${file}`); continue; }
    if (!u) { m.gaps.push(`Grok's usage file could not be parsed: ${file}`); continue; }
    if (u.incomplete) m.gaps.push(`Grok usage has missing or invalid model or session counters (inputTokens, outputTokens): ${file}`);
    if (!Object.keys(u.models).length) continue;
    for (const [model, t] of Object.entries(u.models)) { add((models[model] ??= zero()), t); add(m.tokens, t); }
    if (u.at) m.at = Math.max(m.at ?? 0, u.at);
  }
  if (!Object.keys(models).length) { if (!m.gaps.length) m.gaps.push("Grok has recorded no usage for this card's worktree yet."); return m; }
  m.models = { ...models };
  m.source = "stream";
  m.total = total(m.tokens);
  if (running) m.gaps.push("A turn is still running; Grok adds its tokens when the turn ends.");
  m.complete = !m.gaps.length;
  return m;
}

/** Signed-in state and email of one Grok home. The token in auth.json is never returned or kept. */
export function grokSignIn(home: string): { signedIn: boolean; email?: string } {
  let j: unknown;
  try { j = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8")); } catch { return { signedIn: false }; }
  if (!object(j)) return { signedIn: false };
  for (const entry of Object.values(j)) {
    if (!object(entry)) continue;
    const has = (k: string) => typeof entry[k] === "string" && entry[k].length > 0;
    if (has("key") || has("refresh_token")) return { signedIn: true, email: has("email") ? entry.email : undefined };
  }
  return { signedIn: false };
}

export interface Recent { day: number; dayOutput: number; week: number; weekOutput: number }
const emptyRecent = (): Recent => ({ day: 0, dayOutput: 0, week: 0, weekOutput: 0 });

/** Tokens every Grok session of this home used on this machine in the last 24 hours and 7 days, by each turn's end time. */
export function grokRecent(home: string, now = Date.now()): Recent {
  const r = emptyRecent(), root = path.join(home, "sessions");
  let cwds: string[] = [];
  try { cwds = fs.readdirSync(root); } catch { return r; }
  for (const c of cwds) {
    let sessions: string[] = [];
    try { sessions = fs.readdirSync(path.join(root, c)); } catch { continue; }
    for (const s of sessions) {
      const file = path.join(root, c, s, "usage.json");
      try {
        if (fs.statSync(file).mtimeMs < now - WEEK) continue;
        for (const t of readGrokUsage(file)?.turns ?? []) {
          if (t.at < now - WEEK) continue;
          r.week += t.total; r.weekOutput += t.output;
          if (t.at >= now - DAY) { r.day += t.total; r.dayOutput += t.output; }
        }
      } catch { /* not a session folder, or no usage yet */ }
    }
  }
  return r;
}

// ---- Antigravity ----

export const AGY_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli");

type Fields = Map<number, (number | Uint8Array | null)[]>;
/** Decode varints and length-delimited fields. Mark fixed-width fields present without decoding their values. */
export function protoFields(b: Uint8Array): Fields {
  const out: Fields = new Map();
  let i = 0;
  const varint = () => {
    let r = 0, s = 0, x: number;
    do { if (i >= b.length || s > 63) throw new Error("bad varint"); x = b[i++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80);
    return r;
  };
  while (i < b.length) {
    const key = varint(), field = Math.floor(key / 8), type = key % 8;
    if (!field) throw new Error("field 0");
    let v: number | Uint8Array | null;
    if (type === 0) v = varint();
    else if (type === 2) { const n = varint(); if (i + n > b.length) throw new Error("truncated field"); v = b.subarray(i, i + n); i += n; }
    else if (type === 1 || type === 5) { i += type === 1 ? 8 : 4; if (i > b.length) throw new Error("truncated field"); v = null; }
    else throw new Error(`wire type ${type}`);
    const list = out.get(field);
    if (list) list.push(v); else out.set(field, [v]);
  }
  return out;
}
function sub(f: Fields | undefined, n: number): Fields | undefined {
  const v = f?.get(n)?.[0];
  if (v === undefined) return undefined;
  if (!(v instanceof Uint8Array)) throw new Error("Invalid call metadata");
  return protoFields(v);
}
function num(f: Fields, n: number): number {
  const v = f.get(n)?.[0];
  if (v === undefined) return 0; // omitted protobuf scalar
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error("Invalid token counter");
  return v;
}

/** One gen_metadata row (one model call) as Tokens; undefined when the row has no usage record. */
export function agyCallTokens(blob: Uint8Array): Tokens | undefined {
  const u = sub(sub(protoFields(blob), 1), 4);
  return u ? { input: num(u, 2), cacheRead: num(u, 5), cacheWrite: 0, output: num(u, 3) } : undefined;
}
/** The workspace folders a trajectory_metadata_blob row names (file URIs turned into paths). */
export function agyWorkspaces(blob: Uint8Array): string[] {
  const out: string[] = [];
  for (const w of protoFields(blob).get(1) ?? []) {
    if (!(w instanceof Uint8Array)) continue;
    for (const uri of protoFields(w).get(1) ?? []) {
      if (!(uri instanceof Uint8Array)) continue;
      try { out.push(fileURLToPath(Buffer.from(uri).toString("utf8"))); } catch { /* not a file URI */ }
    }
  }
  return out;
}

interface Conversation { workspaces: string[]; tokens: Tokens; calls: number; unreadableRows: number; readFailed?: boolean; changed: number }
const conversations = new Map<string, { key: string; c: Conversation }>();
let sqliteModule: any;
/** node:sqlite ships with the Node inside VS Code 1.10x and VSCodium (Node 24.21 there on 6 November 2026); older hosts have none. */
function sqlite(): any {
  if (sqliteModule === undefined) { try { sqliteModule = require("node:sqlite"); } catch { sqliteModule = null; } }
  return sqliteModule;
}
function readConversation(file: string): Conversation {
  let changed = 0, key = "";
  for (const f of [file, file + "-wal"]) {
    try { const st = fs.statSync(f); changed = Math.max(changed, st.mtimeMs); key += `${st.mtimeMs}:${st.size};`; } catch { /* no WAL */ }
  }
  const hit = conversations.get(file);
  if (hit?.key === key) return hit.c;
  const db = new (sqlite().DatabaseSync)(file, { readOnly: true });
  try {
    const c: Conversation = { workspaces: [], tokens: zero(), calls: 0, unreadableRows: 0, changed };
    // One row at a time (a conversation holds hundreds of ~80 KB rows); a row that does not decode is skipped, not the conversation.
    for (const row of db.prepare("SELECT data FROM trajectory_metadata_blob").iterate()) { try { if (row.data) c.workspaces.push(...agyWorkspaces(row.data)); } catch { /* skip row */ } }
    try {
      for (const row of db.prepare("SELECT data FROM gen_metadata").iterate()) {
        try {
          if (!(row.data instanceof Uint8Array)) throw new Error("Expected a call metadata blob");
          const t = agyCallTokens(row.data);
          if (t) { add(c.tokens, t); c.calls++; }
        } catch { c.unreadableRows++; }
      }
    } catch { c.readFailed = true; }
    if (!c.readFailed) conversations.set(file, { key, c });
    return c;
  } finally { db.close(); }
}
/**
 * agy's own last-change time per conversation (conversation_summaries.db). File times are no use for that: agy's search indexer opens
 * every conversation at startup, which touches their files (6 November 2026: October conversations read as changed that day).
 */
function summaryTimes(root: string): Map<string, number> {
  const times = new Map<string, number>();
  try {
    const db = new (sqlite().DatabaseSync)(path.join(root, "conversation_summaries.db"), { readOnly: true });
    try {
      for (const r of db.prepare("SELECT conversation_id, last_modified_time FROM conversation_summaries").iterate()) {
        const at = Date.parse(String(r.last_modified_time).replace(" ", "T").replace(/(\.\d{3})\d*/, "$1")); // "2026-11-07 04:19:13.190991323+00:00"
        if (r.conversation_id && at) times.set(String(r.conversation_id), at);
      }
    } finally { db.close(); }
  } catch { /* no index: file times are used */ }
  return times;
}
const scans = new Map<string, { at: number; files: { file: string; at: number }[] }>();
/** The conversation files changed at or after `since`, newest first. The folder holds hundreds, so a scan is reused for 15 s. */
function recentConversations(since: number, dir = path.join(AGY_DIR, "conversations")): { file: string; at: number }[] {
  let scan = scans.get(dir);
  if (!scan || Date.now() - scan.at > 15_000) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".db")); } catch { names = []; }
    const times = summaryTimes(path.dirname(dir));
    const files = names.map((n) => {
      const file = path.join(dir, n), known = times.get(n.slice(0, -3));
      if (known !== undefined) return { file, at: known };
      let at = 0; // not summarized yet: the file's own time
      for (const f of [file, file + "-wal"]) { try { at = Math.max(at, fs.statSync(f).mtimeMs); } catch { /* none */ } }
      return { file, at };
    });
    scans.set(dir, scan = { at: Date.now(), files: files.sort((a, b) => b.at - a.at) });
  }
  return scan.files.filter((f) => f.at >= since);
}

/**
 * The conversations agy's terminal runs in `cwd` started. Their files name no workspace (agy 1.5.2, 6 November 2026: only ACP sessions
 * fill trajectory_metadata_blob), but each run's log names its folder ("CLI store manager for workspace <dir>") and then every
 * conversation it created. cache/last_conversations.json keeps the newest per folder, in case the log is gone.
 */
const runLogs = new Map<string, { key: string; workspace?: string; ids: string[] }>();
function agyRunConversations(cwd: string, since: number, root: string): string[] {
  const ids = new Set<string>();
  try {
    const last = JSON.parse(fs.readFileSync(path.join(root, "cache", "last_conversations.json"), "utf8"));
    for (const [dir, id] of Object.entries(last ?? {})) if (typeof id === "string" && samePath(dir, cwd)) ids.add(id);
  } catch { /* no runs yet */ }
  const logs = path.join(root, "log");
  let names: string[] = [];
  try { names = fs.readdirSync(logs).filter((n) => n.startsWith("cli-") && n.endsWith(".log")); } catch { /* no logs */ }
  for (const n of names) {
    const file = path.join(logs, n);
    try {
      const st = fs.statSync(file), key = `${st.mtimeMs}:${st.size}`;
      if (st.mtimeMs < since) continue;
      let hit = runLogs.get(file);
      if (hit?.key !== key) {
        const fd = fs.openSync(file, "r"), buf = Buffer.alloc(Math.min(st.size, 8 << 20)); // the folder and the conversations come early
        try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
        const text = buf.toString("utf8");
        hit = { key, workspace: /store manager for workspace (.+?)\r?$/m.exec(text)?.[1], ids: [...text.matchAll(/Created conversation ([0-9a-f-]{36})/g)].map((x) => x[1]) };
        runLogs.set(file, hit);
      }
      if (hit.workspace && samePath(hit.workspace, cwd)) for (const id of hit.ids) ids.add(id);
    } catch { /* unreadable log: skipped */ }
  }
  return [...ids];
}

export const AGY_NO_CACHE_WRITES = "Antigravity records no cache writes; input, cache read and output come from its own conversation files.";
export function antigravityMeasurement(cwd: string | undefined, since: number, running: boolean, model: string, dir?: string): Measurement {
  const m: Measurement = { tokens: zero(), complete: false, source: "unknown", models: {}, gaps: [], diagnostics: [] };
  if (!cwd) { m.gaps.push("This card has no worktree yet, so its Antigravity conversations cannot be found."); return m; }
  if (!sqlite()) { m.gaps.push("This editor's Node has no SQLite module, so Antigravity's conversation files cannot be read."); return m; }
  let found = 0;
  const folder = dir ?? path.join(AGY_DIR, "conversations");
  const runs = new Set(agyRunConversations(cwd, since - 60_000, path.dirname(folder)).map((id) => path.join(folder, id + ".db")).filter((f) => fs.existsSync(f)));
  for (const file of new Set([...runs, ...recentConversations(since - 60_000, dir).map((f) => f.file)])) {
    let c: Conversation;
    try { c = readConversation(file); } catch {
      if (runs.has(file)) m.gaps.push(`An Antigravity conversation file could not be read: ${file}`);
      continue;
    }
    if (!runs.has(file) && !c.workspaces.some((w) => samePath(w, cwd))) continue;
    if (c.readFailed) m.gaps.push(`Antigravity call records could not be read from ${path.basename(file)}.`);
    if (c.unreadableRows) m.gaps.push(`Antigravity conversation ${path.basename(file)} has unreadable call rows: ${c.unreadableRows}.`);
    if (!c.calls) continue;
    found++;
    add((m.models[model] ??= zero()), c.tokens); add(m.tokens, c.tokens);
    m.at = Math.max(m.at ?? 0, c.changed);
  }
  if (!found) { if (!m.gaps.length) m.gaps.push("Antigravity has recorded no usage for this card's worktree yet."); return m; }
  m.source = "stream";
  m.total = total(m.tokens);
  m.gaps.push(AGY_NO_CACHE_WRITES);
  if (running) m.gaps.push("A turn is still running; Antigravity adds each model call's tokens as it ends.");
  m.complete = m.gaps.length === 1;
  return m;
}

/**
 * Tokens of the Antigravity conversations on this machine last changed within 24 hours and 7 days: each conversation's whole total,
 * as agy records no call times (the row says "conversations active in"). The first read decodes the week's conversations; later
 * reads decode only files that changed.
 */
export function antigravityRecent(now = Date.now(), dir?: string): Recent {
  const r = emptyRecent();
  if (!sqlite()) return r;
  for (const { file, at } of recentConversations(now - WEEK, dir)) {
    try {
      const c = readConversation(file), t = total(c.tokens);
      r.week += t; r.weekOutput += c.tokens.output;
      if (at >= now - DAY) { r.day += t; r.dayOutput += c.tokens.output; }
    } catch { /* unreadable conversation: left out */ }
  }
  return r;
}

/**
 * The email of agy's latest sign-in, from the newest of its logs that records one, and when that log was last written.
 * agy also logs "You are not logged into Antigravity." at startup in sessions that then sign in, so that line is not read as signed out.
 */
export function antigravitySignIn(dir = path.join(AGY_DIR, "log")): { email?: string; at?: number } {
  let files: { file: string; at: number; size: number }[] = [];
  try {
    files = fs.readdirSync(dir).filter((n) => n.endsWith(".log")).flatMap((n) => {
      try { const st = fs.statSync(path.join(dir, n)); return st.isFile() ? [{ file: path.join(dir, n), at: st.mtimeMs, size: st.size }] : []; } catch { return []; }
    });
  } catch { return {}; }
  for (const f of files.sort((a, b) => b.at - a.at).slice(0, 40)) {
    let text: string;
    try {
      const fd = fs.openSync(f.file, "r");
      try {
        const n = Math.min(f.size, 4 << 20), buf = Buffer.alloc(n); // the tail of a large log is enough: the latest sign-in is what counts
        fs.readSync(fd, buf, 0, n, f.size - n);
        text = buf.toString("utf8");
      } finally { fs.closeSync(fd); }
    } catch { continue; }
    const all = [...text.matchAll(/applyAuthResult: email=([^\s,]+)/g)];
    if (all.length) return { email: all[all.length - 1][1], at: f.at };
  }
  return {};
}
