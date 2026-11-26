// Capability profiles, master plan docs/plans/MASTER-PLAN-capability-profiles-and-orchestration.md sections 5 and 7, phase 2.
// A profile names the MCP servers, skills and plugins a task should see, per provider, under a stable scoped id with immutable
// revisions. A task pins one revision's snapshot when it is added; Board.gate resolves that snapshot before every launch and refuses a
// strict profile on any route that has not been independently verified (STRICT_ROUTES). A profile is not a sandbox: filesystem, shell
// and network reach are the permission mode's business, and a shell can reach programs that no tool list names.
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CODEX_DIR } from "./codex";

export const PROFILE_FILE_VERSION = 1;
export const PROFILE_FILE = "capability-profiles.json";
export type Provider = "claude" | "codex" | "grok" | "antigravity";
export const PROVIDERS: Provider[] = ["claude", "codex", "grok", "antigravity"];
export type Mode = "terminal" | "panel" | "editor" | "in-card" | "headless";
export type Kind = "mcp" | "skill" | "plugin";
export interface Item { kind: Kind; id: string; version?: string }
export interface Variant { items: Item[]; credentials?: string[] }
export interface Revision { revision: number; name: string; description?: string; variants: Partial<Record<Provider, Variant>>; hash?: string }
export interface Profile { id: string; archived?: boolean; revisions: Revision[] }
export type Scope = "workspace" | "personal";
/** What a task keeps: a copy of one revision, so later edits, archiving or removal of the profile never change a pinned run. */
export interface Snapshot { id: string; revision: number; hash: string; name: string; description?: string; variants: Partial<Record<Provider, Variant>> }
export type Selection = { mode: "provider-defaults" } | { mode: "strict"; snapshot: Snapshot; pinnedAt: string };

/**
 * Provider/launch routes on which strict scoping is enabled, keyed "provider:mode". Empty until a route has its launch recipe wired
 * and has passed the user's by-hand check on that operating system (decisions.md, 17 November 2026: Claude and Codex interactive routes,
 * Linux first, never headless). Add a route with exactly what was proven; see docs/plans/2026-11-17-strict-profile-faults-plan.md.
 */
export const STRICT_ROUTES: Readonly<Record<string, StrictRoute>> = {};
/**
 * What a proven route's launch recipe can deliver: the kinds of selection it can load alone, the operating systems (process.platform)
 * it passed the user's by-hand check on, and the provider CLI version it passed with. A route is supported only inside all three.
 */
export interface StrictRoute { kinds: Kind[]; platforms: string[]; version: string }
/** Plugins built into Claude Code (2.1.327; card b50972's native check, 17 November 2026): in no file, on unless enabledPlugins says false. */
export const CLAUDE_BUILTIN_PLUGINS: Record<string, string[]> = { "easel@builtin": ["easel"], "plugin-authoring@builtin": [] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDENT = /^[\w.@:/-]{1,200}$/;
// An opaque reference into an existing store (account:<name>, env:<VARIABLE>), never the secret itself.
const CREDENTIAL = /^(account:[\w.@+ ·:()-]{1,128}|env:[A-Z_][A-Z0-9_]{0,127})$/;
// Token-shaped text written as a "reference" (account:sk-ant-…, a JWT, a long random run) is refused as a likely secret.
const SECRETISH = /sk-|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|AIza|eyJ|[A-Za-z0-9_-]{32}/;

const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(v);
/** sha256 of a revision's content (name, description, variants), independent of key order. */
export function revisionHash(r: Pick<Revision, "name" | "description" | "variants">): string {
  return crypto.createHash("sha256").update(canonical({ name: r.name, description: r.description, variants: r.variants })).digest("hex");
}

function only(o: unknown, keys: string[], where: string): Record<string, unknown> {
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`${where} is not an object`);
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  // Strict keys: a profile cannot carry server commands, environment, headers or tokens, only identifiers and opaque references.
  if (extra.length) throw new Error(`${where} has fields a profile cannot hold: ${extra.join(", ")}`);
  return o as Record<string, unknown>;
}
function validVariant(v: unknown, where: string): Variant {
  const o = only(v, ["items", "credentials"], where);
  if (!Array.isArray(o.items)) throw new Error(`${where}.items is not a list`);
  const seen = new Set<string>();
  for (const [i, it] of o.items.entries()) {
    const x = only(it, ["kind", "id", "version"], `${where}.items[${i}]`);
    if (x.kind !== "mcp" && x.kind !== "skill" && x.kind !== "plugin") throw new Error(`${where}.items[${i}].kind must be mcp, skill or plugin`);
    if (typeof x.id !== "string" || !IDENT.test(x.id)) throw new Error(`${where}.items[${i}].id is not an identifier`);
    if (x.version !== undefined && (typeof x.version !== "string" || !IDENT.test(x.version))) throw new Error(`${where}.items[${i}].version is not a version`);
    if (seen.has(`${x.kind}:${x.id}`)) throw new Error(`${where} lists ${x.kind} ${x.id} twice`);
    seen.add(`${x.kind}:${x.id}`);
  }
  if (o.credentials !== undefined) {
    const bad = !Array.isArray(o.credentials) ? o.credentials : o.credentials.find((c) => typeof c !== "string" || !CREDENTIAL.test(c) || SECRETISH.test(c));
    // Name the store, never the value: the value may be the secret itself.
    const store = typeof bad === "string" ? /^[a-z]+:/i.exec(bad)?.[0] : undefined;
    if (bad !== undefined) throw new Error(`${where}.credentials must be references like account:<name> or env:<VARIABLE>, never a secret${store && store !== "account:" && store !== "env:" ? `; ${store} references are not supported` : ""}`);
  }
  return o as unknown as Variant;
}

/** Reads one profile file. Missing: no profiles. Unknown version or a malformed profile: throws, so nothing in it is selectable. */
export function readProfiles(file: string): Profile[] {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; } // a locked file is not an empty one
  const doc = only(JSON.parse(raw), ["version", "profiles"], file);
  if (doc.version !== PROFILE_FILE_VERSION) throw new Error(`${file} has version ${JSON.stringify(doc.version)}, which this Entomatical cannot read`);
  if (!Array.isArray(doc.profiles)) throw new Error(`${file}: profiles is not a list`);
  const ids = new Set<string>();
  return doc.profiles.map((p, i) => {
    const o = only(p, ["id", "archived", "revisions"], `profiles[${i}]`);
    if (typeof o.id !== "string" || !UUID.test(o.id)) throw new Error(`profiles[${i}].id must be a lower-case UUID`);
    if (o.archived !== undefined && typeof o.archived !== "boolean") throw new Error(`profile ${o.id}: archived must be true or false`);
    if (ids.has(o.id)) throw new Error(`profile ${o.id} appears twice`);
    ids.add(o.id);
    if (!Array.isArray(o.revisions) || !o.revisions.length) throw new Error(`profile ${o.id} has no revisions`);
    let last = 0;
    for (const [j, r] of o.revisions.entries()) {
      const x = only(r, ["revision", "name", "description", "variants", "hash"], `profile ${o.id} revisions[${j}]`);
      if (!Number.isInteger(x.revision) || (x.revision as number) <= last) throw new Error(`profile ${o.id}: revision numbers must rise`);
      last = x.revision as number;
      if (typeof x.name !== "string" || !x.name.trim()) throw new Error(`profile ${o.id} r${last} has no name`);
      if (x.description !== undefined && typeof x.description !== "string") throw new Error(`profile ${o.id} r${last}: description must be text`);
      if (x.hash !== undefined && (typeof x.hash !== "string" || !/^[0-9a-f]{64}$/.test(x.hash))) throw new Error(`profile ${o.id} r${last}: hash must be 64 hex digits`);
      const v = only(x.variants, PROVIDERS, `profile ${o.id} r${last} variants`);
      for (const k of Object.keys(v)) validVariant(v[k], `profile ${o.id} r${last} variants.${k}`);
    }
    return o as unknown as Profile;
  });
}

/** Writes a new revision (or a new profile when id is absent); earlier revisions are copied unchanged. Returns the scoped id. */
export function saveRevision(file: string, scope: Scope, content: Pick<Revision, "name" | "description" | "variants">, id?: string): { ref: string; revision: number } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, () => appendRevision(file, scope, content, id));
}
function appendRevision(file: string, scope: Scope, content: Pick<Revision, "name" | "description" | "variants">, id?: string): { ref: string; revision: number } {
  const profiles = readProfiles(file);
  const bare = id ? unscope(id, scope) : crypto.randomUUID();
  let p = profiles.find((x) => x.id === bare);
  if (id && !p) throw new Error(`No ${scope} profile ${id}.`);
  if (!p) profiles.push(p = { id: bare, revisions: [] });
  const c = only(content, ["name", "description", "variants"], "the new revision");
  if (typeof c.name !== "string" || !c.name.trim()) throw new Error("A capability profile needs a name.");
  if (c.description !== undefined && typeof c.description !== "string") throw new Error("A description must be text.");
  const revision = (p.revisions.at(-1)?.revision ?? 0) + 1;
  const r = { revision, name: c.name, ...(c.description !== undefined ? { description: c.description } : {}), variants: only(c.variants, PROVIDERS, "variants") as Revision["variants"] };
  for (const [k, v] of Object.entries(r.variants)) { if (!PROVIDERS.includes(k as Provider)) throw new Error(`Unknown provider ${k}.`); validVariant(v, `variants.${k}`); }
  p.revisions.push({ ...r, hash: revisionHash(r) });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: PROFILE_FILE_VERSION, profiles }, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return { ref: `${scope}:${bare}`, revision };
}

/** Runs fn holding `<file>.lock`, so two windows saving at once cannot drop each other's revision (read, append and write happen inside). */
function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`, until = Date.now() + 2000;
  for (;;) {
    try { fs.writeFileSync(lock, `${process.pid}\n`, { flag: "wx" }); break; } catch (e) {
      // Windows answers EPERM, not EEXIST, while the holder is deleting the lock: the name stays taken until the delete completes
      // (18 November 2026: "three processes saving at once" failed there about one run in two). It is held, so wait like any other.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && !(process.platform === "win32" && code === "EPERM")) throw e;
    }
    // shortcut: a lock older than 10 s is taken as left by a crashed window (a save takes milliseconds); two takers racing on it can both proceed.
    let stale = false;
    try { stale = Date.now() - fs.statSync(lock).mtimeMs > 10_000; } catch { /* gone meanwhile: the next try takes it, within the same deadline */ }
    if (stale) { try { fs.rmSync(lock, { force: true }); continue; } catch { /* still held open: wait for it within the deadline */ } }
    if (Date.now() > until) throw new Error(`${file} is being saved by another window; try again.`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}
const unscope = (ref: string, scope: Scope) => {
  if (!ref.startsWith(`${scope}:`)) throw new Error(`${ref} is not a ${scope} profile`);
  return ref.slice(scope.length + 1);
};

export interface CatalogEntry { ref: string; scope: Scope; name: string; revision: number; archived: boolean; altered: boolean }
/** Workspace and personal profiles side by side: the scope is part of the id, so equal names never shadow each other. */
export function catalog(files: Partial<Record<Scope, string>>): { entries: CatalogEntry[]; errors: string[] } {
  const entries: CatalogEntry[] = [], errors: string[] = [];
  for (const scope of ["workspace", "personal"] as Scope[]) {
    const file = files[scope];
    if (!file) continue;
    try {
      for (const p of readProfiles(file)) {
        const r = p.revisions.at(-1)!;
        entries.push({ ref: `${scope}:${p.id}`, scope, name: r.name, revision: r.revision, archived: !!p.archived, altered: !!r.hash && r.hash !== revisionHash(r) });
      }
    } catch (e) { errors.push(`${scope} profiles: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return { entries, errors };
}

/** Pins the newest revision of a profile for a new task. Refuses an archived, altered or unknown profile. */
export function pin(files: Partial<Record<Scope, string>>, ref: string, now = new Date()): Selection {
  const scope = ref.split(":")[0] as Scope, file = files[scope];
  if ((scope !== "workspace" && scope !== "personal") || !file) throw new Error(`Unknown capability profile ${ref}.`);
  const p = readProfiles(file).find((x) => x.id === unscope(ref, scope));
  if (!p) throw new Error(`Capability profile ${ref} no longer exists.`);
  if (p.archived) throw new Error(`Capability profile ${ref} is archived; existing tasks keep it, new tasks cannot select it.`);
  const r = p.revisions.at(-1)!, hash = revisionHash(r);
  if (r.hash && r.hash !== hash) throw new Error(`Capability profile ${ref} r${r.revision} was edited in place; save a new revision instead.`);
  const snapshot: Snapshot = JSON.parse(JSON.stringify({ id: ref, revision: r.revision, hash, name: r.name, description: r.description, variants: r.variants }));
  return { mode: "strict", snapshot, pinnedAt: now.toISOString() };
}

/** Why a task's saved selection is not a readable strict snapshot, or undefined. Used before resolving, so damage blocks instead of throwing. */
export function snapshotProblem(sel: unknown): string | undefined {
  try {
    const o = only(sel, ["mode", "snapshot", "pinnedAt"], "profile");
    if (o.mode !== "strict") return `unknown mode ${JSON.stringify(o.mode)}`;
    const s = only(o.snapshot, ["id", "revision", "hash", "name", "description", "variants"], "snapshot");
    if (typeof s.id !== "string" || !/^(workspace|personal):/.test(s.id) || !Number.isInteger(s.revision) || typeof s.hash !== "string" || typeof s.name !== "string") throw new Error("snapshot identity is incomplete");
    const v = only(s.variants, PROVIDERS, "snapshot variants");
    for (const k of Object.keys(v)) validVariant(v[k], `snapshot variants.${k}`);
    return undefined;
  } catch (e) { return e instanceof Error ? e.message : String(e); }
}

export interface Found { kind: Kind; id: string; source: string; version?: string; enabled: boolean; via?: string }
export interface Inventory { items: Found[]; unknown: string[] }

const readJson = (f: string): Record<string, unknown> | undefined => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return undefined; } };
const dirs = (d: string) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name).sort(); } catch { return []; } };
const keys = (o: unknown) => o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o) : [];

/**
 * What a Claude session in this account folder and worktree would discover without a profile, read from the files Claude reads; nothing
 * is written. Plugins expand to the skills and MCP servers they contribute. Sources this cannot see are listed as unknown, not as empty.
 */
export function claudeInventory(configDir: string, cwd: string, platform: string = process.platform): Inventory {
  const dir = configDir || path.join(os.homedir(), ".claude");
  const state = readJson(configDir ? path.join(dir, ".claude.json") : path.join(os.homedir(), ".claude.json")) ?? {};
  const items: Found[] = [], unknown = ["Claude's built-in tools", "managed (enterprise) settings", "plugin commands, agents and hooks", "claude.ai connectors", "skills bundled with the CLI"];
  const add = (f: Found) => { if (!items.some((x) => x.kind === f.kind && x.id === f.id && x.source === f.source)) items.push(f); };
  // enabledPlugins: user settings, then the project's shared and local settings override them.
  const enabled: Record<string, boolean> = {};
  for (const f of [path.join(dir, "settings.json"), path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json")])
    Object.assign(enabled, (readJson(f)?.enabledPlugins as Record<string, boolean> | undefined) ?? {});
  const installed = (readJson(path.join(dir, "plugins", "installed_plugins.json"))?.plugins ?? {}) as Record<string, { scope?: string; projectPath?: string; installPath?: string; version?: string }[]>;
  for (const [id, copies] of Object.entries(installed)) {
    const at = (scope: string) => (copies ?? []).find((c) => c.scope === scope && (scope === "user" || scope === "managed" || (!!c.projectPath && samePath(c.projectPath, cwd, platform))));
    // The CLI's own order (2.1.326): an install with scope local for this folder, then scope project, then the user install.
    const copy = at("local") ?? at("project") ?? at("user") ?? at("managed");
    if (!copy?.installPath) continue;
    const root = copy.installPath;
    const on = enabled[id] === true, name = id.split("@")[0];
    add({ kind: "plugin", id, source: `plugin (${copy.scope})`, version: copy.version, enabled: on });
    for (const s of dirs(path.join(root, "skills"))) add({ kind: "skill", id: `${name}:${s}`, source: "plugin", enabled: on, via: id });
    // plugin.json mcpServers adds to .mcp.json: a map, a path to a JSON file, an MCPB file or URL, or a list of those (CLI 2.1.326 schema).
    const servers = (decl: unknown): string[] => {
      if (Array.isArray(decl)) return decl.flatMap(servers);
      if (typeof decl !== "string") return keys(decl);
      const j = decl.endsWith(".json") ? readJson(path.resolve(root, decl)) : undefined;
      if (j) return keys(j.mcpServers ?? j);
      if (on) unknown.push(`MCP servers of plugin ${id} from ${decl}`);
      return [];
    };
    const mcp = readJson(path.join(root, ".mcp.json"));
    for (const s of [...servers(readJson(path.join(root, ".claude-plugin", "plugin.json"))?.mcpServers), ...keys(mcp?.mcpServers ?? mcp)]) add({ kind: "mcp", id: s, source: "plugin", enabled: on, via: id });
  }
  // What the CLI brings itself and no plugin or MCP file lists: its built-in plugins and, when the account has it on, the Chrome server.
  for (const [id, mcp] of Object.entries(CLAUDE_BUILTIN_PLUGINS)) {
    const on = enabled[id] !== false;
    add({ kind: "plugin", id, source: "built-in", enabled: on });
    for (const s of mcp) add({ kind: "mcp", id: s, source: "built-in", enabled: on, via: id });
  }
  if (state.claudeInChromeDefaultEnabled === true) add({ kind: "mcp", id: "claude-in-chrome", source: "built-in", enabled: true });
  for (const s of dirs(path.join(dir, "skills"))) add({ kind: "skill", id: s, source: "user", enabled: true });
  for (const s of dirs(path.join(cwd, ".claude", "skills"))) add({ kind: "skill", id: s, source: "project", enabled: true });
  for (const s of keys(state.mcpServers)) add({ kind: "mcp", id: s, source: "user", enabled: true });
  // Every key naming this folder, in either Windows form, counts: listing a server too many blocks, one too few would leak.
  for (const [, project] of Object.entries((state.projects as Record<string, { mcpServers?: unknown }> | undefined) ?? {}).filter(([k]) => samePath(k, cwd, platform)))
    for (const s of keys(project?.mcpServers)) add({ kind: "mcp", id: s, source: "local", enabled: true });
  for (const s of keys(readJson(path.join(cwd, ".mcp.json"))?.mcpServers)) add({ kind: "mcp", id: s, source: "project", enabled: true });
  return { items, unknown };
}

/**
 * Two paths name the same folder. On Windows the CLI writes .claude.json project keys as path.normalize with "/" (C:/x/y, read from
 * the 2.1.326 binary); older or hand-written keys use "\"; NTFS ignores case. Both forms are tested with fixtures only, not on Windows.
 */
export function samePath(a: string, b: string, platform: string = process.platform): boolean {
  const norm = (x: string) => platform === "win32" ? path.win32.resolve(x).toLowerCase() : path.posix.resolve(x);
  return norm(a) === norm(b);
}

// ---- Codex, Grok and Antigravity: read from the files each CLI writes (locations checked on linux 17 November 2026, see
// docs/evidence/capability-profiles-gap-closure/d3569a.md). A file that exists but cannot be parsed is listed as unknown with its reason.

type Toml = Map<string, Record<string, unknown>>;
const SEP = "\u0001";
/**
 * The tables of a TOML file with their string, boolean, number and string-array values; enough for config.toml's [plugins."id"],
 * [mcp_servers.name], [projects."path"] and [plugins] enabled = [...]. shortcut: inline tables and multi-line strings are kept as raw
 * text, upgrade to a real parser if a profile ever needs values inside them.
 */
export function parseToml(text: string): Toml {
  const tables: Toml = new Map([["", {}]]);
  let cur = tables.get("")!, pending: { key: string; text: string } | undefined;
  const scalar = (v: string): unknown => v === "true" ? true : v === "false" ? false : /^[+-]?\d[\d_]*(\.\d+)?$/.test(v) ? Number(v.replace(/_/g, ""))
    : v.startsWith("\"") ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v.startsWith("'") && v.endsWith("'") ? v.slice(1, -1)
    : v.startsWith("[") ? [...v.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[2] ?? JSON.parse(`"${m[1]}"`)) : v;
  const segs = (h: string) => [...h.matchAll(/\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([\w-]+))\s*(?:\.|$)/g)].map((m) => m[2] ?? (m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[3]));
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (pending) { pending.text += " " + line; if (line.includes("]")) { cur[pending.key] = scalar(pending.text); pending = undefined; } continue; }
    if (!line || line.startsWith("#")) continue;
    const h = /^\[\[?(.+?)\]\]?\s*(#.*)?$/.exec(line);
    if (h) { const k = segs(h[1]).join(SEP); if (!tables.has(k)) tables.set(k, {}); cur = tables.get(k)!; continue; }
    const kv = /^("(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)\s*=\s*(.*?)\s*(#[^"']*)?$/.exec(line);
    if (!kv) continue;
    const key = segs(kv[1])[0];
    if (kv[2].startsWith("[") && !kv[2].includes("]")) pending = { key, text: kv[2] };
    else cur[key] = scalar(kv[2]);
  }
  return tables;
}
/** The direct sub-tables of `prefix` ([mcp_servers.x] under "mcp_servers"), by name. */
const children = (t: Toml, ...prefix: string[]) => [...t].filter(([k]) => { const s = k.split(SEP); return s.length === prefix.length + 1 && prefix.every((p, i) => s[i] === p); })
  .map(([k, v]) => [k.split(SEP).at(-1)!, v] as const);
/** A config file: missing is "nothing configured"; present but unreadable is unknown, with the reason. */
function load<T>(file: string, parse: (text: string) => T, unknown: string[]): T | undefined {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") unknown.push(`${file} (${(e as Error).message})`); return undefined; }
  try { return parse(text); } catch (e) { unknown.push(`${file} (${e instanceof Error ? e.message : String(e)})`); return undefined; }
}
const json = (text: string) => text.trim() ? JSON.parse(text) as Record<string, any> : {};
/** Folders holding a SKILL.md, as the three CLIs define a skill. */
const skills = (d: string) => dirs(d).filter((n) => !n.startsWith(".") && fs.existsSync(path.join(d, n, "SKILL.md")));
/** A plugin folder's skills and MCP servers, added under the plugin (`via`). */
function bundle(items: Found[], dir: string, id: string, on: boolean, mcpFiles: string[], unknown: string[]) {
  const name = id.split("@")[0];
  for (const s of skills(path.join(dir, "skills"))) items.push({ kind: "skill", id: `${name}:${s}`, source: "plugin", enabled: on, via: id });
  for (const f of mcpFiles) {
    const m = load(path.join(dir, f), json, unknown);
    for (const [s, v] of Object.entries((m?.mcpServers ?? {}) as Record<string, { enabled?: boolean; disabled?: boolean }>))
      items.push({ kind: "mcp", id: s, source: "plugin", enabled: on && v?.enabled !== false && v?.disabled !== true, via: id });
  }
}

/**
 * Codex (0.169): $CODEX_HOME/config.toml names plugins ([plugins."name@marketplace"] enabled) and MCP servers ([mcp_servers.name]);
 * plugins sit in plugins/cache/<marketplace>/<name>/<version>/ with skills/ and .mcp.json; user skills in skills/, Codex's own in
 * skills/.system/. A trusted project's .codex/config.toml adds its MCP servers.
 */
export function codexInventory(home: string, cwd: string): Inventory {
  const unknown: string[] = [], items: Found[] = [];
  const cfg = load(path.join(home, "config.toml"), parseToml, unknown) ?? new Map();
  for (const [id, t] of children(cfg, "plugins")) {
    const [name, market] = id.split("@"), base = path.join(home, "plugins", "cache", market ?? "", name), on = t.enabled === true;
    let ver: string | undefined;
    try { ver = path.basename(fs.realpathSync(path.join(base, "latest"))); } catch { ver = dirs(base).filter((v) => v !== "latest").sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1); }
    if (!ver) { items.push({ kind: "plugin", id, source: "plugin (config.toml)", enabled: on }); unknown.push(`what Codex plugin ${id} contains (not in ${base})`); continue; }
    const dir = path.join(base, ver);
    items.push({ kind: "plugin", id, source: "plugin (config.toml)", version: (readJson(path.join(dir, ".codex-plugin", "plugin.json"))?.version as string | undefined) ?? ver, enabled: on });
    bundle(items, dir, id, on, [".mcp.json"], unknown);
  }
  for (const [s, t] of children(cfg, "mcp_servers")) items.push({ kind: "mcp", id: s, source: "user", enabled: t.enabled !== false });
  const trusted = children(cfg, "projects").some(([p, t]) => t.trust_level === "trusted" && samePath(p, cwd));
  const proj = load(path.join(cwd, ".codex", "config.toml"), parseToml, unknown);
  if (proj) for (const [s, t] of children(proj, "mcp_servers")) items.push({ kind: "mcp", id: s, source: "project", enabled: trusted && t.enabled !== false });
  for (const s of skills(path.join(home, "skills"))) items.push({ kind: "skill", id: s, source: "user", enabled: true });
  for (const s of skills(path.join(home, "skills", ".system"))) items.push({ kind: "skill", id: s, source: "system", enabled: true });
  return { items, unknown: [...unknown, "Codex's built-in tools", "ChatGPT apps and connectors ([apps] in config.toml)", "managed settings (managed_config.toml, requirements.toml)",
    "plugin hooks and agents", "repository and ~/.agents skill folders", "config overrides and MCP servers the launcher passes"] };
}

/**
 * Grok (1.0.77, ~/.grok/docs/user-guide 05, 08, 09): MCP servers and [plugins] enabled/disabled in GROK_HOME's and the project's
 * .grok/config.toml (project wins); plugins in GROK_HOME/plugins, .grok/plugins and installed-plugins, off unless enabled; skills from
 * GROK_HOME/bundled/skills, GROK_HOME/skills, the project's .grok, .agents and .claude skills, ~/.claude/skills and ~/.cursor/skills.
 */
export function grokInventory(grokHome: string, cwd: string): Inventory {
  const home = grokHome || path.join(os.homedir(), ".grok"), unknown: string[] = [], items: Found[] = [];
  const user = load(path.join(home, "config.toml"), parseToml, unknown) ?? new Map(), proj = load(path.join(cwd, ".grok", "config.toml"), parseToml, unknown) ?? new Map();
  const mcp = new Map<string, Found>();
  for (const [cfg, source] of [[user, "user"], [proj, "project"]] as const)
    for (const [s, t] of children(cfg, "mcp_servers")) mcp.set(s, { kind: "mcp", id: s, source, enabled: t.enabled !== false });
  items.push(...mcp.values());
  const list = (k: string) => [user, proj].flatMap((c) => { const v = c.get("plugins")?.[k]; return Array.isArray(v) ? v as string[] : []; });
  const enabled = list("enabled"), disabled = list("disabled");
  for (const [d, source] of [[path.join(cwd, ".grok", "plugins"), "plugin (project)"], [path.join(home, "plugins"), "plugin (user)"], [path.join(home, "installed-plugins"), "plugin (installed)"]] as const)
    for (const name of dirs(d)) {
      const dir = path.join(d, name), on = enabled.includes(name) && !disabled.includes(name);
      const version = (readJson(path.join(dir, "plugin.json")) ?? readJson(path.join(dir, ".claude-plugin", "plugin.json")))?.version as string | undefined;
      items.push({ kind: "plugin", id: name, source, version, enabled: on });
      bundle(items, dir, name, on, [".mcp.json"], unknown);
    }
  const compatOff = (v: string) => user.get(`compat${SEP}${v}`)?.skills === false;
  const roots: [string, string, boolean?][] = [[path.join(cwd, ".grok", "skills"), "project"], [path.join(cwd, ".agents", "skills"), "project"], [path.join(home, "skills"), "user"],
    [path.join(os.homedir(), ".agents", "skills"), "user"], [path.join(home, "bundled", "skills"), "bundled"],
    [path.join(cwd, ".claude", "skills"), "claude (project)", compatOff("claude")], [path.join(os.homedir(), ".claude", "skills"), "claude (user)", compatOff("claude")],
    [path.join(cwd, ".cursor", "skills"), "cursor (project)", compatOff("cursor")], [path.join(os.homedir(), ".cursor", "skills"), "cursor (user)", compatOff("cursor")]];
  // Grok keeps the highest-priority skill of each name.
  for (const [d, source, off] of roots) if (!off) for (const s of skills(d)) if (!items.some((f) => f.kind === "skill" && f.id === s)) items.push({ kind: "skill", id: s, source, enabled: true });
  return { items, unknown: [...unknown, "Grok's built-in tools", "commands/ folders", "folders between the working folder and the repository root", "[skills] extra paths and ignores",
    "the GROK_CLAUDE_SKILLS_ENABLED and GROK_CURSOR_SKILLS_ENABLED variables", "marketplace plugins outside the plugin folders", "managed settings (requirements.toml, MDM)", "plugins passed per session or process (pluginDirs, --plugin-dir)"] };
}

/**
 * Antigravity (agy 1.5.10, its built-in agy-customizations guide): plugins in ~/.gemini/config/plugins, the project's .agents/plugins and
 * agy's builtin/plugins, switched in ~/.gemini/config/config.json; MCP servers in ~/.gemini/config/mcp_config.json and each plugin's
 * mcp_config.json; skills in agy's builtin/skills, ~/.gemini/config/skills and the project's .agents/skills.
 */
export function antigravityInventory(cwd: string): Inventory {
  const g = path.join(os.homedir(), ".gemini"), unknown: string[] = [], items: Found[] = [];
  const cfg = load(path.join(g, "config", "config.json"), json, unknown) ?? {};
  const unlisted: string[] = [];
  for (const [d, source] of [[path.join(cwd, ".agents", "plugins"), "plugin (project)"], [path.join(g, "config", "plugins"), "plugin (user)"], [path.join(g, "antigravity-cli", "builtin", "plugins"), "plugin (builtin)"]] as const)
    for (const name of dirs(d)) {
      const dir = path.join(d, name), set = cfg.plugins?.[name]?.enabled;
      if (typeof set !== "boolean") unlisted.push(name);
      const version = (readJson(path.join(dir, "installed_version.json")) ?? readJson(path.join(dir, "plugin.json")))?.version as string | undefined;
      items.push({ kind: "plugin", id: name, source, version, enabled: set === true });
      bundle(items, dir, name, set === true, ["mcp_config.json"], unknown);
    }
  for (const [s, v] of Object.entries((load(path.join(g, "config", "mcp_config.json"), json, unknown)?.mcpServers ?? {}) as Record<string, { disabled?: boolean }>))
    items.push({ kind: "mcp", id: s, source: "user", enabled: v?.disabled !== true });
  for (const [d, source] of [[path.join(cwd, ".agents", "skills"), "project"], [path.join(g, "config", "skills"), "user"], [path.join(g, "antigravity-cli", "builtin", "skills"), "builtin"]] as const)
    for (const s of skills(d)) items.push({ kind: "skill", id: s, source, enabled: true });
  return { items, unknown: [...unknown, ...(unlisted.length ? [`whether plugins config.json does not switch load (${unlisted.join(", ")})`] : []), "Antigravity's built-in tools",
    "rules and hooks", "~/.gemini/skills and the Antigravity app's folder (~/.gemini/antigravity)", "workspace settings"] };
}

/** Inventory for a provider, read from its own files. What a reader cannot see is listed as unknown, which never counts as empty. configDir: Claude's account folder, or the Grok profile's GROK_HOME. */
export function inventory(provider: Provider, configDir: string, cwd: string): Inventory {
  return provider === "claude" ? claudeInventory(configDir, cwd) : provider === "codex" ? codexInventory(CODEX_DIR, cwd)
    : provider === "grok" ? grokInventory(configDir, cwd) : antigravityInventory(cwd);
}

/** items: the whole list behind a reason whose text names only the first few (F110 finding F2: 60-odd inherited skills made a 3,000-character line). */
export interface Reason { code: string; text: string; items?: string[] }
const NAMED = 3;
const few = (xs: string[]) => xs.length > NAMED ? `${xs.slice(0, NAMED).join(", ")} and ${xs.length - NAMED} more` : xs.join(", ");
export interface Resolution { state: "provider-defaults" | "blocked" | "supported"; route: string; reasons: Reason[]; manifest: Found[]; inherited: Found[]; unknown: string[] }

/**
 * The resolver: Provider defaults (inherit what the provider is set up with, listed), or a strict profile's exact manifest with every
 * reason it cannot run as asked. Never broadens: anything unsure is a reason, and any reason blocks.
 */
export function resolve(sel: Selection | undefined, ctx: { provider: Provider; mode: Mode; inventory: Inventory; credential: (ref: string) => boolean;
  /** The machine's OS and the provider CLI's version (read only for a proven route); routes replaces the table in tests. */
  platform?: string; version?: () => string | undefined; routes?: Readonly<Record<string, StrictRoute>> }): Resolution {
  const route = `${ctx.provider}:${ctx.mode}`, inherited = ctx.inventory.items.filter((f) => f.enabled);
  if (!sel || sel.mode === "provider-defaults") return { state: "provider-defaults", route, reasons: [], manifest: [], inherited, unknown: ctx.inventory.unknown };
  const s = sel.snapshot, reasons: Reason[] = [], manifest: Found[] = [];
  const why = (code: string, text: string, items?: string[]) => reasons.push({ code, text, ...(items && items.length > NAMED ? { items } : {}) });
  if (revisionHash(s) !== s.hash) why("altered", `the pinned snapshot of ${s.id} r${s.revision} no longer matches its hash`);
  const v = s.variants[ctx.provider];
  if (!v) why("no-variant", `${s.name} r${s.revision} has no ${ctx.provider} variant, so it is incompatible (not empty, not inherited)`);
  else {
    // O1 (the user, 17 November 2026): an empty strict list means none; nothing is inherited in its place.
    for (const it of v.items) {
      const found = ctx.inventory.items.filter((f) => f.kind === it.kind && f.id === it.id);
      if (!found.length) { why("unavailable", `${it.kind} ${it.id} is not installed or configured for this account and worktree`); continue; }
      const live = found.filter((x) => x.enabled);
      if (!live.length) { why("disabled", `${it.kind} ${it.id} is installed but disabled for this account and worktree (enabledPlugins)`); continue; }
      const f = live.find((x) => !it.version || x.version === it.version) ?? live[0];
      if (it.version && f.version !== it.version) why("drift", `${it.kind} ${it.id} is ${f.version ?? "unversioned"} here, the profile pins ${it.version}`);
      manifest.push(f);
      // Claude loads a plugin as a whole: one of its skills or servers alone cannot be selected.
      if (f.via && !v.items.some((x) => x.kind === "plugin" && x.id === f.via)) why("partial-bundle", `${it.kind} ${it.id} comes with plugin ${f.via}, which loads as a bundle; select the whole plugin or remove it`);
      if (it.kind === "plugin") for (const c of ctx.inventory.items.filter((x) => x.via === it.id)) if (!manifest.includes(c)) manifest.push(c);
    }
    for (const c of v.credentials ?? []) if (!ctx.credential(c)) why("missing-credential", `credential ${c} is not present in its store`);
  }
  const proven = (ctx.routes ?? STRICT_ROUTES)[route], platform = ctx.platform ?? process.platform;
  if (proven?.platforms.includes(platform)) {
    // Supported means the route's recipe can deliver exactly this manifest, on this machine's OS, with the CLI release it was proven on.
    const minor = (x?: string) => x?.match(/^\d+\.\d+/)?.[0], here = ctx.version?.();
    if (!minor(here) || minor(here) !== minor(proven.version)) why("version-unverified", `${route} was proven on ${ctx.provider} ${proven.version}; this machine runs ${here ?? "a version Entomatical could not read"}`);
    const cannot = (v?.items ?? []).filter((it) => !proven.kinds.includes(it.kind));
    if (cannot.length) why("unenforceable", `${route} can enforce only ${proven.kinds.join(", ")} selections; ${cannot.map((it) => `${it.kind} ${it.id}`).join(", ")} cannot be loaded alone there`);
  } else {
    why("route-unverified", proven ? `strict scope is not enabled for ${route} on ${platform}: it is proven on ${proven.platforms.join(", ")} only` : `strict scope is not enabled for ${route}: no route has passed the user's by-hand check yet (decisions.md: Claude and Codex interactive routes first, never headless)`);
    const extras = inherited.filter((f) => !manifest.some((m) => m.kind === f.kind && m.id === f.id));
    const names = extras.map((f) => `${f.kind} ${f.id} (${f.source})`), unseen = ctx.inventory.unknown;
    if (names.length) why("inherited-extras", `would also inherit ${names.length} it does not list: ${few(names)}`, names);
    if (unseen.length) why("inventory-unknown", `cannot see ${few(unseen)}`, unseen);
  }
  return { state: reasons.length ? "blocked" : "supported", route, reasons, manifest, inherited, unknown: ctx.inventory.unknown };
}

/** One line for a refusal or a mouse-over. */
export const blockedText = (s: Snapshot, r: Resolution) => `Capability profile ${s.name} r${s.revision} (${s.id}) is blocked on ${r.route}: ${r.reasons.map((x) => x.text).join("; ")}. Nothing was started; "Run with Provider defaults instead" on the card inherits the provider's configuration.`;
