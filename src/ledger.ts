/**
 * Call ledger: an index of every Claude Code API call on this machine, for later study of what each prompt's tokens went on.
 *
 * The transcripts stay where the CLI keeps them (<config dir>/projects/<project>/<session>.jsonl and its subagents' files); nothing
 * is copied. One window on the machine (owner.json, the board's claimOwner rule) reads each transcript's new bytes every 30 s and
 * writes ~/.entomatical/ledger/sessions/<session>.jsonl: a line per transcript file, per prompt and per API call, each with the
 * byte offset of its transcript line, so a reader can seek to the prompt or call itself. sessions.json is the catalog. The schema
 * and the query tool (docs/ledger.md, tools/ledger.js) are copied into the folder so an agent finds them there.
 *
 * Every session counts, whoever started it (board, panel, terminal, another workspace), on every account folder. The CLI marks
 * each user line with its turn's promptId, subagents' lines included, and each assistant line with the requestRef of an
 * api-request line (querySource). Seen in CLI 2.1.312; undocumented, so a missing field is left out rather than guessed.
 * Hard links and copies of one transcript in several account folders (sessions.ts linkIntoHistory, carryTranscript) are one
 * file, keyed by session and file name; the longest copy is read, and of hard links the one in the folder of the account that
 * ran it. A message or prompt id is written once per session, whatever repeats it. Counts and ids only, never text. No model is called.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_DIR, accountFolders, claimOwner, usageKey, writeFileAtomic } from "./sessions";

export const LEDGER_DIR = process.env.ENTOMATICAL_LEDGER_DIR || path.join(os.homedir(), ".entomatical", "ledger");
const VERSION = 1;
const CHUNK = 4 << 20;
const SETTLED_MS = 30_000; // a reply's last line can lag; the calls still held are written once their file has been quiet this long
const HOLD = 8; // calls held per file before the oldest finished one is written
const OPEN_MAX = 64; // calls without a stop reason held per file at most
const SAVE_MS = 5_000; // a long first pass still saves its state this often
const PROMPT_ID = /"promptId":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/;
const TIMESTAMP = /"timestamp":"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z)"/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One transcript file to read: the session's own (agentId undefined) or one of its subagents'. */
interface Source { key: string; file: string; session: string; agentId?: string; account: string; size: number; mtime: number }
/** Where reading a file got to. `pending`: the newest calls, not written yet because a reply's later lines can still add tools or its final counts. `named`: the path its "f" line gave. `fork`: inside a fork's copy of its parent's call. */
interface FileState { named?: string; f: number; offset: number; size: number; mtime: number; promptId?: string; fork?: boolean; pending?: Record<string, any>[]; requests?: Record<string, string> }
export interface SessionEntry {
  account: string; file: string; cwd?: string; entrypoint?: string; version?: string; first?: string; last?: string;
  prompts: number; calls: number; tokens: { input: number; cacheWrite: number; cacheRead: number; output: number };
}
interface State { version: number; files: Record<string, FileState>; next: Record<string, number> }
const TOKENS = ["input", "cacheWrite", "cacheRead", "output"] as const;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Every transcript under every account folder, one per key. Hard links of one file (one inode) have equal sizes, and an append
 * between two stats makes either look longer, so they rank instead: +2 for the account folder whose CLI ran the session
 * (`session-env/<session>`, CLI 2.1.310+), +1 for the link in the session's own project folder; of two folders with a session-env,
 * the newer one (the account that resumed it last). A real copy wins only by being longer.
 */
export function sources(folders = accountFolders(), cwdOf: (session: string) => string | undefined = () => undefined): Source[] {
  type Found = Source & { id: string; root: string; project: string; rank?: number; env?: number };
  const found = new Map<string, Found[]>();
  const add = (s: Found) => { const l = found.get(s.key); if (l) l.push(s); else found.set(s.key, [s]); };
  const list = (dir: string) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
  for (const folder of folders) {
    const root = folder || DEFAULT_DIR;
    const account = usageKey(root);
    const projects = path.join(root, "projects");
    for (const p of list(projects)) {
      if (!p.isDirectory()) continue;
      const dir = path.join(projects, p.name);
      for (const e of list(dir)) {
        const file = path.join(dir, e.name);
        if (e.isFile() && e.name.endsWith(".jsonl") && SESSION_ID.test(e.name.slice(0, -6))) {
          const st = statOf(file);
          if (st) add({ key: e.name.slice(0, -6), file, session: e.name.slice(0, -6), account, root, project: p.name, ...st });
        } else if (e.isDirectory() && SESSION_ID.test(e.name)) {
          const visit = (at: string) => {
            for (const s of list(at)) {
              const sub = path.join(at, s.name);
              if (s.isDirectory()) visit(sub);
              else if (s.isFile() && s.name.startsWith("agent-") && s.name.endsWith(".jsonl")) {
                const st = statOf(sub);
                if (st) add({ key: `${e.name}/${s.name.slice(0, -6)}`, file: sub, session: e.name, agentId: s.name.slice(6, -6), account, root, project: p.name, ...st });
              }
            }
          };
          visit(path.join(file, "subagents"));
        }
      }
    }
  }
  const pick = (all: Found[]): Source => {
    if (all.length === 1) return all[0];
    const cwd = cwdOf(all[0].session) ?? cwdIn(all[0].file);
    // Claude names a project folder after its cwd with every other character a "-" (sessions.ts transcriptPath).
    for (const s of all) {
      s.env = fs.statSync(path.join(s.root, "session-env", s.session), { throwIfNoEntry: false })?.mtimeMs ?? -1;
      s.rank = (s.env >= 0 ? 2 : 0) + (cwd && s.project === cwd.replace(/[^a-zA-Z0-9]/g, "-") ? 1 : 0);
    }
    // Higher rank, then the newer session-env, then the path, so the pick never depends on folder order.
    const over = (a: Found, b: Found) => (a.rank !== b.rank ? a.rank! > b.rank! : a.env !== b.env ? a.env! > b.env! : a.file < b.file);
    const groups = new Map<string, Found>();
    for (const s of all) {
      const g = groups.get(s.id);
      // One file under several names: the best ranked names it; its size is the largest stat.
      if (g) groups.set(s.id, { ...(over(s, g) ? s : g), size: Math.max(g.size, s.size), mtime: Math.max(g.mtime, s.mtime) });
      else groups.set(s.id, s);
    }
    const better = (a: Found, b: Found) => (a.size !== b.size ? a.size > b.size : over(a, b));
    return [...groups.values()].reduce((a, b) => (better(b, a) ? b : a));
  };
  return [...found.values()].map(pick);
}
function statOf(file: string) {
  try {
    // bigint: a Windows file id does not fit a double. An inode of 0 (none given) leaves the file in a group of its own.
    const s = fs.statSync(file, { bigint: true });
    return { size: Number(s.size), mtime: Number(s.mtimeNs) / 1e6, id: s.ino ? `${s.dev}:${s.ino}` : file };
  } catch { return undefined; }
}
/** The cwd on the first transcript line in the file's first 64 KB that has one. */
function cwdIn(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(64 << 10);
      const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, 0)));
      return m ? JSON.parse(m[1]) : undefined;
    } finally { fs.closeSync(fd); }
  } catch { return undefined; }
}

export class Ledger {
  /** Whether this window is the machine's one reader. */
  owned = false;
  pid = process.pid;
  private state: State;
  private catalog: Record<string, SessionEntry>;
  /** Per session, the message and prompt ids already in sessions/<id>.jsonl and the size they were read at. Not in state.json. */
  private written = new Map<string, { size: number; ids: Set<string>; partial: boolean }>();
  private timer?: NodeJS.Timeout;
  private running = false;
  private warned = false;
  private told = false;
  /** Set when state or catalog changed since the last load or save: a pass with nothing new writes nothing. */
  private dirty = false;

  /** `warn` shows the user a sign (extension.ts: a VS Code warning), once per window, when the ledger rebuilds or stops on bad state. */
  constructor(readonly dir = LEDGER_DIR, private readonly folders = accountFolders, private readonly packaged?: string, private readonly warn?: (message: string) => void) {
    this.state = { version: VERSION, files: {}, next: {} };
    this.catalog = {};
  }

  /** The saved state, read again at every pass: another window may have owned the ledger since this one last did. False: no pass now. */
  private load(): boolean {
    const at = (name: string) => path.join(this.dir, name);
    const read = (name: string) => fs.readFileSync(at(name), "utf8");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let state: State | undefined, catalog: Record<string, SessionEntry> | undefined;
    try {
      state = JSON.parse(read("state.json"));
    } catch (e) {
      if (!(e instanceof SyntaxError)) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") return this.skip(`state.json: ${(e as Error).message}`);
      } else {
        // Damaged state would stop the ledger for good: it is set aside and the index rebuilt (the old index is set aside too).
        try { fs.renameSync(at("state.json"), at(`state.json.bad-${stamp}`)); } catch (r) { return this.skip(`state.json is damaged and could not be set aside: ${(r as Error).message}`); }
        this.tell(`Entomatical: the call ledger's state.json was damaged, so it was kept as state.json.bad-${stamp} in ${this.dir} and the index is being rebuilt from the transcripts.`);
      }
    }
    if (state) {
      // Another version's state (a newer Entomatical in another window) is left for it, never rebuilt over.
      if (state.version !== VERSION) {
        const why = `state.json is version ${state.version}, this Entomatical reads ${VERSION}`;
        this.tell(`Entomatical: the call ledger is not recording: ${why} (${this.dir}). Update Entomatical in this window.`);
        return this.skip(why);
      }
      try {
        catalog = JSON.parse(read("sessions.json"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") return this.skip(`sessions.json: ${(e as Error).message}`);
        // No catalog: rebuilt like missing state, or the sessions already read would never be in it.
      }
    }
    if (!state || !catalog) {
      // No state: the index is rebuilt from the transcripts. The old one is set aside, not appended to twice or deleted: the CLI
      // deletes old transcripts (cleanupPeriodDays), so it can be the only record of their calls. The newest two are kept.
      const old = at("sessions");
      try {
        if (fs.existsSync(old)) fs.renameSync(old, `${old}.before-${stamp}`);
      } catch (e) {
        return this.skip(`the old index could not be set aside (retried next pass): ${(e as Error).message}`); // Windows: EPERM while a file in it is open
      }
      this.prune("sessions.before-");
      this.prune("state.json.bad-");
      this.state = { version: VERSION, files: {}, next: {} };
      this.catalog = {};
      this.written.clear();
      this.dirty = true;
      return true;
    }
    // Written by 0.8.8 and before, never read. Its catalog totals counted a repeated call twice: recounted once from the index.
    const legacy = Object.values(state.files).some((f) => "file" in f);
    for (const f of Object.values(state.files)) delete (f as { file?: string }).file;
    this.state = state;
    this.catalog = catalog;
    this.dirty = legacy;
    if (legacy) {
      this.written.clear();
      for (const [id, entry] of Object.entries(catalog)) this.ids(id, entry);
    }
    return true;
  }
  /** Removes all but the newest two of the ledger folder's entries named `prefix<time>`. */
  private prune(prefix: string) {
    try {
      for (const n of fs.readdirSync(this.dir).filter((n) => n.startsWith(prefix)).sort().slice(0, -2)) fs.rmSync(path.join(this.dir, n), { recursive: true, force: true });
    } catch { /* tried again at the next rebuild */ }
  }
  private skip(why: string) {
    if (!this.warned) console.error(`Entomatical ledger: not indexing: ${why}`); // once, not every 30 s
    this.warned = true;
    return false;
  }
  private tell(message: string) {
    console.error(message);
    if (!this.told) this.warn?.(message);
    this.told = true;
  }

  /** False when another window holds owner.json: two owners would each write every call. */
  private mine() {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(this.dir, "owner.json"), "utf8"));
      return typeof o?.pid !== "number" || o.pid === this.pid;
    } catch {
      return true; // no owner file: nobody else claims it
    }
  }

  /** Runs a pass now and every 30 s while this window owns the ledger. */
  start(everyMs = 30_000) {
    this.place();
    const tick = () => { this.owned = claimOwner(path.join(this.dir, "owner.json"), this.pid, Date.now(), 3 * everyMs, undefined, true); if (this.owned) void this.pass().catch((e) => this.skip(`a pass failed: ${(e as Error).message}`)); };
    this.timer = setInterval(tick, everyMs);
    setTimeout(tick, 5_000).unref?.();
  }
  dispose() { if (this.timer) clearInterval(this.timer); }

  /** Runs `job` every `everyMs`, in the window that owns the ledger only. */
  whileOwned(everyMs: number, job: () => unknown) {
    const t = setInterval(() => { if (this.owned && this.mine()) job(); }, everyMs);
    return { dispose: () => clearInterval(t) };
  }

  /** Copies the schema and the query tool (with the efficiency summary it loads, F77) from the extension into the ledger folder, when they differ. */
  private place() {
    if (!this.packaged) return;
    for (const [from, to] of [["docs/ledger.md", "README.md"], ["tools/ledger.js", "ledger.js"], ["out/efficiency.js", "efficiency.js"]]) {
      try {
        const text = fs.readFileSync(path.join(this.packaged, from), "utf8");
        fs.mkdirSync(this.dir, { recursive: true });
        const dest = path.join(this.dir, to);
        let old: string | undefined;
        try { old = fs.readFileSync(dest, "utf8"); } catch { /* not placed yet */ }
        if (old !== text) writeFileAtomic(dest, text);
      } catch { /* not packaged: the repo's own copy serves */ }
    }
  }

  /** Reads every transcript's new lines and writes their prompts and calls. Returns how many lines were written. */
  async pass(now = Date.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let finished = false;
    try {
      if (!this.load()) return 0;
      let written = 0, saved = Date.now();
      const seen = new Set<string>();
      for (const s of sources(this.folders(), (id) => this.catalog[id]?.cwd)) {
        seen.add(s.key);
        const st = this.state.files[s.key];
        const settled = now - s.mtime > SETTLED_MS;
        if (st && st.named === s.file && st.size === s.size && st.mtime === s.mtime && (!st.pending?.length || !settled)) continue;
        this.dirty = true;
        const n = await this.read(s, settled);
        if (n < 0) return written; // another window owns the ledger now: it has the state
        written += n;
        // Saved once per pass: saving after every file rewrote the whole state per file, quadratic on a first pass.
        if (Date.now() - saved > SAVE_MS) { if (!this.save()) return written; saved = Date.now(); }
        await new Promise((r) => setImmediate(r)); // let the editor breathe between files
      }
      // A file gone from every folder (the CLI deleted it): its held calls are written, then it leaves the state.
      for (const [key, st] of Object.entries(this.state.files)) {
        if (seen.has(key) || (st.named && fs.existsSync(st.named))) continue;
        const session = key.split("/")[0];
        const entry = this.entry(session, "");
        const ids = this.ids(session, entry), out: object[] = [];
        for (const c of st.pending ?? []) this.take(c, entry, ids, out);
        if (out.length && !(await this.append(session, out))) return written;
        written += out.length;
        delete this.state.files[key];
        this.dirty = true;
      }
      finished = !this.dirty || this.save();
      return written;
    } finally {
      this.running = false;
      // The index can now be ahead of the saved catalog, which the next pass loads: its ids are read again, and the totals recounted.
      if (!finished) this.written.clear();
    }
  }

  private save() {
    if (!this.mine()) return false;
    fs.mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(path.join(this.dir, "sessions.json"), JSON.stringify(this.catalog));
    writeFileAtomic(path.join(this.dir, "state.json"), JSON.stringify(this.state));
    this.dirty = false;
    return true;
  }

  private entry(session: string, account: string) {
    return (this.catalog[session] ??= { account, file: "", prompts: 0, calls: 0, tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } });
  }

  /**
   * The message and prompt ids already in sessions/<session>.jsonl, read again only when its size is not the one this window left.
   * The catalog's totals are recounted from the same lines, a repeated message id once (its last line), so they match the index.
   */
  private ids(session: string, entry: SessionEntry): Set<string> {
    const file = path.join(this.dir, "sessions", `${session}.jsonl`);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* nothing written yet */ }
    const known = this.written.get(session);
    if (known && known.size === size) return known.ids;
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { /* nothing written yet */ }
    const ids = new Set<string>(), calls = new Map<string, any>();
    let prompts = 0;
    for (const l of text.split("\n")) {
      let o: any;
      try { o = JSON.parse(l); } catch { continue; } // a half-written line
      if (o?.k === "c" && typeof o.messageId === "string") { ids.add(o.messageId); calls.set(o.messageId, o); }
      else if (o?.k === "p" && typeof o.promptId === "string") { ids.add(o.promptId); prompts = Math.max(prompts, num(o.n) ?? 0); }
    }
    entry.prompts = prompts;
    entry.calls = calls.size;
    entry.tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    for (const c of calls.values()) for (const k of TOKENS) entry.tokens[k] += num(c[k]) ?? 0;
    this.written.set(session, { size: Buffer.byteLength(text), ids, partial: text.length > 0 && !text.endsWith("\n") });
    return ids;
  }

  /** A finished call goes out once per session: the CLI can write a reply's line again megabytes later, and a shorter copy is read from its start. */
  private take(c: Record<string, any>, entry: SessionEntry, ids: Set<string>, out: object[]) {
    if (ids.has(c.messageId)) return;
    ids.add(c.messageId);
    out.push(c);
    entry.calls++;
    for (const k of TOKENS) entry.tokens[k] += c[k] ?? 0;
  }

  /** Appends a session's lines, unless another window took the ledger since this pass began. */
  private async append(session: string, out: object[]): Promise<boolean> {
    const known = this.written.get(session);
    if (!this.mine()) { this.written.delete(session); return false; } // its ids now hold lines never written
    const text = (known?.partial ? "\n" : "") + out.map((o) => JSON.stringify(o)).join("\n") + "\n";
    try {
      fs.mkdirSync(path.join(this.dir, "sessions"), { recursive: true });
      await fs.promises.appendFile(path.join(this.dir, "sessions", `${session}.jsonl`), text);
    } catch (e) {
      this.written.delete(session);
      throw e;
    }
    if (known) Object.assign(known, { size: known.size + Buffer.byteLength(text), partial: false });
    return true;
  }

  /** Reads a file's new lines. Returns how many lines it wrote, or -1 when another window took the ledger. */
  private async read(s: Source, settled: boolean): Promise<number> {
    const st = (this.state.files[s.key] ??= { f: (this.state.next[s.session] = (this.state.next[s.session] ?? 0) + 1), offset: 0, size: 0, mtime: 0 });
    const entry = this.entry(s.session, s.account);
    const ids = this.ids(s.session, entry);
    const out: object[] = [];
    if (st.named !== s.file) out.push({ k: "f", f: st.f, file: s.file, agentId: s.agentId, account: s.account });
    st.named = s.file;
    if (!s.agentId) { entry.file = s.file; entry.account = s.account; }
    if (s.size < st.offset) { // replaced, not grown: the held calls are written first, the new file is read from its start
      for (const c of st.pending ?? []) this.take(c, entry, ids, out);
      Object.assign(st, { offset: 0, pending: undefined, promptId: undefined, fork: undefined });
    }

    const querySources: Record<string, string> = { ...st.requests }; // an api-request line can end one pass and its reply start the next
    // A reply spans several lines with one message id, and other lines (tool results, other replies) can sit between them.
    // Current transcripts (CLI 2.1.312) put the stop reason on a multi-line reply's first line, so a stop reason does not mean its
    // last line was seen; older subagent transcripts have a partial count first (output 3, no stop reason) and the final one lines,
    // sometimes many calls, later. Completeness rests on HOLD and the settle: the newest HOLD calls stay open, and older ones too
    // until a line gives their stop reason; a later line adds its tools and, when it has a stop reason or more output, its counts.
    // The oldest finished call is written once more than HOLD are open, and all of them once the file settles.
    const open: Record<string, any>[] = st.pending ?? [];
    const finish = (all: boolean) => {
      for (let i = 0; i < open.length && open.length > (all ? 0 : HOLD); ) {
        if (all || open[i].stop) this.take(open.splice(i, 1)[0], entry, ids, out);
        else i++;
      }
      // shortcut: a transcript whose lines never give a stop reason would hold every call (slow, and all of it in state.json); past
      // OPEN_MAX the oldest goes out as it is. Raise OPEN_MAX if a final count is ever seen more than that many calls late.
      while (open.length > OPEN_MAX) this.take(open.shift()!, entry, ids, out);
    };
    const counts = (u: any) => {
      const cc = u.cache_creation || {}, sv = u.server_tool_use || {};
      return {
        input: num(u.input_tokens), cacheWrite: num(u.cache_creation_input_tokens), cacheWrite1h: num(cc.ephemeral_1h_input_tokens),
        cacheWrite5m: num(cc.ephemeral_5m_input_tokens), cacheRead: num(u.cache_read_input_tokens), output: num(u.output_tokens),
        thinking: num(u.output_tokens_details?.thinking_tokens), webSearch: num(sv.web_search_requests), webFetch: num(sv.web_fetch_requests),
      };
    };
    const assistant = (e: any, at: number) => {
      const m = e.message;
      if (!m || !m.usage || typeof m.id !== "string") return;
      if (m.model === "<synthetic>") return; // the CLI's own line ("You've hit your session limit"), no API call
      const named = (Array.isArray(m.content) ? m.content : []).filter((x: any) => x && x.type === "tool_use" && typeof x.name === "string").map((x: any) => x.name as string);
      const held = open.find((c) => c.messageId === m.id);
      if (held) {
        held.tools.push(...named);
        if (m.stop_reason || (num(m.usage.output_tokens) ?? 0) > (held.output ?? 0)) Object.assign(held, counts(m.usage), { stop: m.stop_reason ?? held.stop });
        return;
      }
      open.push({
        k: "c", f: st.f, offset: at, at: e.timestamp, promptId: st.promptId, messageId: m.id, requestId: e.requestId,
        querySource: querySources[e.requestRef], model: m.model, effort: e.effort, stop: m.stop_reason ?? undefined, tools: named, ...counts(m.usage),
      });
      finish(false);
      if (!s.agentId) {
        entry.cwd ??= e.cwd; entry.entrypoint ??= e.entrypoint; entry.version = e.version ?? entry.version;
        entry.first ??= e.timestamp; entry.last = e.timestamp ?? entry.last;
      }
    };
    const user = (id: string | undefined, at: number, timestamp: unknown) => {
      st.fork = undefined; // a fork's own work starts at its first user line
      if (!id || id === st.promptId) return;
      st.promptId = id;
      if (s.agentId || ids.has(id)) return; // a subagent works under its parent's prompt, which the parent's file records
      ids.add(id);
      entry.prompts++;
      out.push({ k: "p", f: st.f, offset: at, n: entry.prompts, promptId: id, at: timestamp });
    };
    const line = (text: string, at: number) => {
      const big = text.length > 256 << 10;
      // Tool results make user lines large: those are not parsed, only their promptId and timestamp read.
      if (big && !text.includes('"type":"assistant"')) {
        if (text.includes('"type":"user"')) { user(PROMPT_ID.exec(text)?.[1], at, TIMESTAMP.exec(text)?.[1]); }
        return;
      }
      if (!text.includes('"type":"assistant"') && !text.includes('"type":"user"') && !text.includes('"type":"api-request"') && !text.includes('"type":"fork-context-ref"')) return;
      let e: any;
      try { e = JSON.parse(text); } catch { return; }
      // A fork subagent's file starts with a fork-context-ref line, then a copy of the parent's call that started it: the parent's file has that call.
      if (e.type === "fork-context-ref") st.fork = true;
      else if (e.type === "assistant") { if (!st.fork) assistant(e, at); }
      else if (e.type === "api-request" && typeof e.id === "string") querySources[e.id] = e.querySource;
      else if (e.type === "user") user(typeof e.promptId === "string" ? e.promptId : undefined, at, e.timestamp);
    };

    let fd: fs.promises.FileHandle;
    try { fd = await fs.promises.open(s.file, "r"); } catch { return 0; }
    let pos = st.offset;
    try {
      for (let chunk = CHUNK; pos < s.size; ) {
        const buf = Buffer.alloc(Math.min(chunk, s.size - pos));
        const { bytesRead } = await fd.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        let start = 0;
        for (let nl; (nl = buf.indexOf(10, start)) >= 0 && nl < bytesRead; start = nl + 1) line(buf.toString("utf8", start, nl), pos + start);
        if (start === 0) {
          if (bytesRead === buf.length && pos + bytesRead < s.size) { chunk *= 2; continue; } // a line longer than the chunk
          break; // only an unfinished last line is left: next time
        }
        pos += start;
        chunk = CHUNK;
        await new Promise((r) => setImmediate(r)); // let the editor breathe on a long first read
      }
    } finally {
      await fd.close();
    }
    if (settled) finish(true);
    st.pending = open;
    st.requests = Object.fromEntries(Object.entries(querySources).slice(-4));
    st.offset = pos;
    st.size = s.size;
    st.mtime = s.mtime;
    if (out.length && !(await this.append(s.session, out))) return -1;
    return out.length;
  }
}
