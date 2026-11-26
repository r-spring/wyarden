// ACP transport for Grok and Antigravity. It does not read or write provider credentials.
import { execFile, spawn, ChildProcessWithoutNullStreams } from "child_process";
import { createInterface } from "readline";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { exactModel, familyLabel, isExactModel, newestOf, parseModel, tryResolve } from "./models";

export type AcpProvider = "grok" | "antigravity";
export interface AcpOption { id: string; name: string; category?: string; currentValue?: string; values: { value: string; name: string }[] }
export const ACP_PERMISSION_LABELS: Record<string, string> = { allow_once: "Allow once", allow_always: "Allow always", reject_once: "Reject once", reject_always: "Reject always" };
type JsonObject = Record<string, any>;
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

/** The Antigravity models a task can pick (the user, 6 November 2026: only Opus and Argon; 14 November 2026: Carbon too, for the
 *  Battle Royale button), each the newest version `agy models` lists (fix 11: claude-opus-5-5 and gemini-4-argon on 6 November 2026,
 *  gemini-4-carbon on 14 November 2026), passed to agy as --model and --effort. Opus stays first, so it stays preselected. agy 1.5.2
 *  offers low, medium and high for each and refuses max ("claude-opus-5-5 has no "max" effort"), so the default is the highest it
 *  offers: the user asked for max by default. */
export const ANTIGRAVITY_FAMILIES = ["opus", "argon", "carbon"];
export const ANTIGRAVITY_EFFORTS = ["low", "medium", "high"];
const ANTIGRAVITY_DEFAULT_EFFORT = "high";
const EFFORT_IN_ID = /-(low|medium|high)$/;
/** What `agy models` last listed for this machine's sign-in; undefined until it answered (no agy, or not asked yet). */
let agyListed: [string, string][] | undefined;
/** `agy models` output: one "id<TAB>name" line per model, after a "Fetching available models..." line. */
export const parseAgyModels = (text: string): [string, string][] =>
  text.split(/\r?\n/).map((l) => l.split("\t")).filter((p) => p.length === 2 && /^[\w.-]+$/.test(p[0].trim()) && p[1].trim()).map(([id, name]) => [id.trim(), name.trim()]);
export const setAntigravityModels = (models: [string, string][] | undefined) => { agyListed = models; };
/** The ids `agy models` last listed, as listed (some carry their effort: claude-opus-5-5-high); [] before it answered. */
export const antigravityListed = (): string[] => (agyListed ?? []).map(([id]) => id);
/** the user's three (Opus, Argon, Carbon) take the card's --effort; agy's other ids carry their own (gemini-3.8-flash-low), so they take none. */
export const antigravityTakesEffort = (model?: string) => !!model && !EFFORT_IN_ID.test(model) && ANTIGRAVITY_FAMILIES.includes(parseModel("antigravity", model)?.family ?? "");
/**
 * The models an Antigravity card can pick, as [value, label] (F88, F92). the user, 6 November 2026: "List agy's own models", after
 * linux's sign-in listed neither of his two and agy quietly ran its own default. His three (Opus, Argon and, from 14 November 2026,
 * Carbon) where the sign-in lists them, only those it lists, each the newest version it lists ("Opus (claude-opus-5-5)"; fix 11: a short
 * name always runs the newest); otherwise everything it lists, as listed; the three until agy has answered ("Opus (newest)").
 * media/board.js shows them from the board state's antigravityModels.
 */
export function antigravityModels(): [string, string][] {
  const ids = antigravityListed();
  if (!ids.length) return ANTIGRAVITY_FAMILIES.map((f) => [f, `${familyLabel(f)} (newest)`]);
  const preferred = ANTIGRAVITY_FAMILIES.map((f) => [f, newestOf("antigravity", f, ids)?.replace(EFFORT_IN_ID, "")] as const).filter(([, id]) => id);
  return preferred.length ? preferred.map(([f, id]) => [f, `${familyLabel(f)} (${id})`]) : agyListed!;
}
/** The form's Antigravity menu (the user, 23 November 2026): every model `agy models` lists, by its id and agy's own name; the three until it has answered. */
export const antigravityChoices = (): [string, string][] => (agyListed?.length ? agyListed : antigravityModels());
/** The first model offered, at high for the user's three. shortcut: no --effort for agy's other models, until agy says which levels each takes. */
export const antigravityDefault = () => {
  const model = antigravityModels()[0][0];
  return { model, effort: antigravityTakesEffort(model) ? ANTIGRAVITY_DEFAULT_EFFORT : undefined };
};
/** Asks agy which models its sign-in has (the account scan, and Connect Antigravity); a failed or slow answer keeps the last list. */
export function discoverAntigravityModels(): Promise<void> {
  const { file, args, env } = acpCommand("antigravity");
  return new Promise((resolve) => execFile(file, [...args.slice(0, -1), "models"], { env, timeout: 20_000, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
    const listed = error ? [] : parseAgyModels(stdout);
    if (listed.length) agyListed = listed;
    resolve();
  }));
}
/** The board's permission choices (PERMISSIONS in board.ts) as agy flags (agy --help: --mode accept-edits|auto|plan,
 *  --dangerously-skip-permissions). Ask passes none: agy asks unless its own settings allow the tool. */
export const ANTIGRAVITY_PERMISSIONS: Record<string, string[]> = { ask: [], edits: ["--mode=accept-edits"], auto: ["--mode=auto"], bypass: ["--dangerously-skip-permissions"] };
/** The same choices as Grok flags (grok --help, Grok Build 1.0.77: --permission-mode default|acceptEdits|auto|dontAsk|bypassPermissions|plan). */
export const GROK_PERMISSIONS: Record<string, string[]> = { ask: ["--permission-mode=default"], edits: ["--permission-mode=acceptEdits"], auto: ["--permission-mode=auto"],
  bypass: ["--permission-mode=bypassPermissions"] };
/** the user, 6 November 2026: a Grok or Antigravity card runs the provider's most permissive mode unless another is picked (F88). */
export const PROVIDER_DEFAULT_PERMISSION = "bypass";
export const providerPermissionOk = (provider: AcpProvider, permission?: string) =>
  !!permission && Object.hasOwn(provider === "grok" ? GROK_PERMISSIONS : ANTIGRAVITY_PERMISSIONS, permission);
/**
 * A model the form offers, or any version of one (fix 11): claude-opus-5-5 is Opus; an older gemini-3.7-flash-low is the offered
 * gemini-3.8-flash-low (the effort in agy's own ids must match).
 */
export function antigravityModelOk(model?: string): boolean {
  if (!model) return false;
  const offered = antigravityModels().map(([v]) => v), p = parseModel("antigravity", model);
  return offered.includes(model) || antigravityListed().includes(model) || (!!p && offered.some((v) => parseModel("antigravity", v)?.family === p.family
    && (ANTIGRAVITY_FAMILIES.includes(v) ? !EFFORT_IN_ID.test(model) : EFFORT_IN_ID.exec(v)?.[1] === EFFORT_IN_ID.exec(model)?.[1])));
}
/** agy's flags for a task's model, effort and permission; throws on a value the board does not offer. The terminal passes the resolved id. */
export function antigravityArgs(o: { model?: string; effort?: string; permission?: string }): string[] {
  if (o.model && !antigravityModelOk(o.model)) throw new Error(`Unknown Antigravity model ${o.model}. Valid models: ${antigravityModels().map(([id]) => id).join(", ")}${antigravityModels().some(([v]) => ANTIGRAVITY_FAMILIES.includes(v)) ? " (each runs its newest version), or a full id of one of them" : ""}.`);
  if (o.effort && o.model && !antigravityTakesEffort(o.model)) throw new Error(`Antigravity's ${o.model} takes no effort level: it runs at the effort agy gives it.`);
  if (o.effort && !ANTIGRAVITY_EFFORTS.includes(o.effort)) throw new Error(`Unknown effort level ${o.effort} for Antigravity. Valid levels: ${ANTIGRAVITY_EFFORTS.join(", ")}`);
  if (o.permission && !Object.hasOwn(ANTIGRAVITY_PERMISSIONS, o.permission)) throw new Error(`Unknown permission mode ${o.permission}.`);
  return [...(o.model ? [`--model=${o.model}`] : []), ...(o.effort ? [`--effort=${o.effort}`] : []), ...(o.permission ? ANTIGRAVITY_PERMISSIONS[o.permission] : [])];
}
/**
 * Grok's flags for a task's model and permission; throws on a value the board does not offer. The model is the exact id the board
 * resolved from `grok models` (Board.grokLaunchModel; grok 1.0.77: "-m, --model <MODEL>  Model ID to use"); Grok keeps its own effort.
 */
export function grokArgs(o: { model?: string; permission?: string }): string[] {
  if (o.permission && !Object.hasOwn(GROK_PERMISSIONS, o.permission)) throw new Error(`Unknown permission mode ${o.permission}.`);
  return [...(o.model ? [`--model=${exactModel("grok", o.model)}`] : []), ...(o.permission ? GROK_PERMISSIONS[o.permission] : [])];
}
/**
 * `grok models` output (grok 1.0.77): a "Default model: grok-4.7" line, then "  * grok-4.7 (default)" and "  - grok-4.6" lines.
 * ids: as listed; default: the id it names as its default, if any.
 */
export function parseGrokModels(text: string): { ids: string[]; default?: string } {
  const ids: string[] = [];
  let marked: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[*-]\s+([\w.-]+)(\s.*)?$/.exec(line); // text after the id and a space (a label, "(default)") is not part of it
    if (!m) continue;
    ids.push(m[1]);
    if (/\(default\)/i.test(m[2] ?? "")) marked = m[1];
  }
  const named = /^\s*Default model:\s*([\w.-]+)\s*$/m.exec(text)?.[1];
  return { ids, default: marked ?? named };
}
/**
 * The exact model id to select on an open ACP session (the user, 17 November 2026: exact ids only): a named model resolved against what
 * the session advertises (the newest id of its family, fix 11), or, with none named, the id the session reports it is on
 * (currentValue), selected explicitly. who names the account in a refusal. Throws when the session advertises no model choice, does
 * not offer the name, or would run a short name or alias such as "auto".
 */
export function acpModelChoice(provider: AcpProvider, options: AcpOption[], asked: string | undefined, who: string): { option: AcpOption; value: string } {
  const option = options.find((o) => o.category === "model");
  const offered = option?.values.map((v) => v.value) ?? [];
  if (!option) throw new Error(`${who} advertises no model choice, so the exact model it would run is unknown and nothing was started.`);
  const value = asked ? tryResolve(provider, asked, offered) : option.currentValue;
  if (!value || !offered.includes(value)) throw new Error(asked ? `${who} does not advertise model ${asked}. It offers: ${offered.join(", ") || "none"}.`
    : `${who} does not say which model it is on, so the exact model is unknown. Add a new card with one of its models, or move this card to another account. It offers: ${offered.join(", ") || "none"}.`);
  if (!isExactModel(provider, value)) throw new Error(`${who} would run "${value}", which is not an exact model id, so nothing was started. Add a new card with one of its exact ids, or move this card to another account: ${offered.filter((v) => isExactModel(provider, v)).join(", ") || "none"}.`);
  return { option, value };
}
const grokDefaults = new Map<string, string | undefined>();
/** The default `grok models` last named for a profile, for the form's "Default: …" entry; asked: whether it has answered yet. */
export const grokDefaultSeen = (grokHome: string) => ({ asked: grokDefaults.has(grokHome), id: grokDefaults.get(grokHome) });
/** Asks `grok models` (with this profile's GROK_HOME) which models it has and which is its default; a failure lists none. */
export function discoverGrokModels(grokHome: string): Promise<{ ids: string[]; default?: string }> {
  const { file, args, env } = acpCommand("grok", grokHome);
  return new Promise((resolve) => execFile(file, [...args.slice(0, -2), "models"], { env, timeout: 20_000, windowsHide: true, encoding: "utf8" },
    (error, stdout) => { const listed = error ? { ids: [] } : parseGrokModels(stdout); grokDefaults.set(grokHome, listed.default); resolve(listed); }));
}

/** The agent owns authentication. Remove ambient keys so a selected CLI login is not silently replaced. */
export function acpCommand(provider: AcpProvider, grokHome?: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
  const clean = { ...env };
  const clear = (...names: string[]) => { for (const key of Object.keys(clean)) if (names.includes(key.toUpperCase())) delete clean[key]; };
  const exe = platform === "win32" ? ".exe" : "";
  if (provider === "grok") {
    if (!grokHome) throw new Error("Choose a Grok profile before starting a task.");
    clear("GROK_HOME", "XAI_API_KEY", "GROK_DEPLOYMENT_KEY");
    clean.GROK_HOME = grokHome;
    const installed = path.join(os.homedir(), ".grok", "bin", `grok${exe}`);
    if (fs.existsSync(installed)) return { file: installed, args: ["agent", "stdio"], env: clean };
    // Fixed commands only: cmd resolves a possible .cmd shim without interpolating a prompt or path into shell text.
    return platform === "win32" ? { file: "cmd.exe", args: ["/d", "/c", "grok", "agent", "stdio"], env: clean }
      : { file: "grok", args: ["agent", "stdio"], env: clean };
  }
  clear("GEMINI_HOME", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "AGY_ADC_AUTH");
  const installed = [path.join(os.homedir(), ".gemini", "bin", `agy${exe}`), ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, "agy", "bin", `agy${exe}`)] : [])];
  const found = installed.find((file) => fs.existsSync(file));
  if (found) return { file: found, args: ["acp"], env: clean };
  return platform === "win32" ? { file: "cmd.exe", args: ["/d", "/c", "agy", "acp"], env: clean }
    : { file: "agy", args: ["acp"], env: clean };
}

/** A connection owns one conversation. Loading a previous session is conditional on the agent's capability. */
export class AcpSession {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private sessionId?: string;
  private busy = false;
  private configOptions: JsonObject[] = [];
  private modes: JsonObject[] = [];
  private readonly reader;
  get isClosed(): boolean { return this.closed; }

  constructor(readonly child: ChildProcessWithoutNullStreams,
    private readonly onUpdate: (update: JsonObject) => void = () => {},
    private readonly onPermission: (request: JsonObject) => Promise<string | undefined> = async () => undefined) {
    this.reader = createInterface({ input: child.stdout });
    this.reader.on("line", (line) => {
      let message: JsonObject;
      try { message = JSON.parse(line); } catch { return; }
      if (typeof message.method === "string" && message.id !== undefined) {
        void this.respond(message);
      } else if (typeof message.method === "string") {
        if (message.method === "session/update" && message.params?.sessionId === this.sessionId) {
          const update = message.params.update;
          if (update?.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) this.configOptions = update.configOptions;
          this.onUpdate(update);
        }
      } else if (typeof message.id === "number") {
        const p = this.pending.get(message.id);
        if (!p) return;
        this.pending.delete(message.id);
        if (message.error) p.reject(new Error(message.error.message || "Agent rejected the request.")); else p.resolve(message.result);
      }
    });
    child.on("error", (error) => this.fail(error));
    child.on("exit", () => this.fail(new Error("Agent exited before completing the request.")));
    child.stdin.on("error", (error) => this.fail(error));
    // stderr is drained, but not copied into conversation history or exposed as identity information.
    child.stderr.resume();
  }

  private write(message: JsonObject) {
    if (this.closed || !this.child.stdin.writable) throw new Error("Agent connection is closed.");
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }
  private request(method: string, params: JsonObject): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try { this.write({ id, method, params }); } catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  private async respond(message: JsonObject) {
    if (message.method !== "session/request_permission") {
      this.onUpdate({ sessionUpdate: "unsupported_client_request", method: String(message.method).slice(0, 120) });
      try { this.write({ id: message.id, error: { code: -32601, message: "Unsupported client method" } }); } catch { /* closed */ }
      return;
    }
    let chosen: string | undefined;
    try { if (!this.closed && this.sessionId && message.params?.sessionId === this.sessionId) chosen = await this.onPermission(message.params); } catch { /* refused */ }
    if (this.closed) return;
    const options = Array.isArray(message.params?.options) ? message.params.options : [];
    const matching = options.filter((option: JsonObject) => typeof chosen === "string" && option?.optionId === chosen);
    const allowed = matching.length === 1 && Object.hasOwn(ACP_PERMISSION_LABELS, matching[0].kind);
    try { this.write({ id: message.id, result: { outcome: allowed ? { outcome: "selected", optionId: chosen } : { outcome: "cancelled" } } }); } catch { /* closed */ }
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    this.reader.close();
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }
  async open(cwd: string, resumeId?: string): Promise<string> {
    const timer = setTimeout(() => { this.fail(new Error("Agent did not initialize within 30 seconds.")); this.child.kill(); }, 30_000);
    timer.unref?.();
    try {
    const init = await this.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "entomatical", version: "1" } });
    if (init?.protocolVersion !== 1) throw new Error("The agent does not support ACP version 1.");
    const canResume = init?.agentCapabilities?.sessionCapabilities?.resume != null;
    if (resumeId && !canResume && !init?.agentCapabilities?.loadSession) throw new Error("This agent cannot load an existing ACP session.");
    const method = !resumeId ? "session/new" : canResume ? "session/resume" : "session/load";
    // session/load may replay prior updates before its response, which must not be confused with a new turn.
    const result = await this.request(method, { cwd, mcpServers: [], ...(resumeId ? { sessionId: resumeId } : {}) });
    const id = resumeId ?? result?.sessionId;
    if (typeof id !== "string" || !id || id.length > 256 || /[\x00-\x1f\x7f]/.test(id)) throw new Error("The agent did not return a valid session ID.");
    this.sessionId = id;
    this.configOptions = Array.isArray(result?.configOptions) ? result.configOptions : [];
    this.modes = Array.isArray(result?.modes?.availableModes) ? result.modes.availableModes : [];
    return id;
    } finally { clearTimeout(timer); }
  }
  /** A safe, bounded snapshot suitable for a task card; no account or credential material. */
  options(): AcpOption[] {
    const options = this.configOptions.filter((item) => item.type === "select" && ["model", "thought_level", "mode"].includes(item.category)
      && typeof item.id === "string" && item.id.length <= 120 && typeof item.name === "string" && Array.isArray(item.options))
      .slice(0, 20).map((item) => ({ id: item.id, name: item.name.slice(0, 120),
        ...(typeof item.category === "string" ? { category: item.category.slice(0, 80) } : {}),
        ...(typeof item.currentValue === "string" ? { currentValue: item.currentValue.slice(0, 200) } : {}),
        values: item.options.flatMap((entry: JsonObject) => Array.isArray(entry.options) ? entry.options : [entry])
          .filter((entry: JsonObject) => typeof entry?.value === "string" && typeof entry?.name === "string" && entry.value.length <= 200)
          .slice(0, 100).map((entry: JsonObject) => ({ value: entry.value, name: entry.name.slice(0, 120) })) }));
    if (!options.some((option) => option.category === "mode") && this.modes.length) options.push({ id: "__acp_mode", name: "Mode", category: "mode", currentValue: undefined,
      values: this.modes.filter((mode) => typeof mode.id === "string" && typeof mode.name === "string" && mode.id.length <= 200).slice(0, 100).map((mode) => ({ value: mode.id, name: mode.name.slice(0, 120) })) });
    return options;
  }
  /** Only selections explicitly advertised by this session may be sent back to the agent. */
  async configure(id: string, value: string): Promise<void> {
    if (!this.sessionId) throw new Error("Open the agent session first.");
    const option = this.configOptions.find((item) => item.id === id && item.type === "select");
    if (option && typeof option.id === "string" && Array.isArray(option.options)) {
      const values = option.options.flatMap((item: JsonObject) => Array.isArray(item.options) ? item.options : [item]);
      if (!values.some((item: JsonObject) => item.value === value)) throw new Error(`The agent did not offer ${id} ${value}.`);
      const result = await this.request("session/set_config_option", { sessionId: this.sessionId, configId: option.id, value });
      if (!Array.isArray(result?.configOptions)) throw new Error("The agent did not confirm its configuration.");
      this.configOptions = result.configOptions;
      if (!this.configOptions.some((item) => item.id === option.id && item.currentValue === value)) throw new Error(`The agent did not apply ${id} ${value}.`);
      return;
    }
    if (id === "__acp_mode" && this.modes.some((mode) => mode.id === value)) {
      await this.request("session/set_mode", { sessionId: this.sessionId, modeId: value });
      return;
    }
    throw new Error(`The agent did not advertise a ${id} selector.`);
  }
  async prompt(text: string): Promise<string> {
    if (!this.sessionId) throw new Error("Open the agent session first.");
    if (this.busy) throw new Error("The agent is already handling a turn.");
    this.busy = true;
    try {
      const result = await this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] });
      if (typeof result?.stopReason !== "string") throw new Error("The agent did not report a turn outcome.");
      return result.stopReason;
    } finally { this.busy = false; }
  }
  cancel() { if (this.sessionId && this.busy) this.write({ method: "session/cancel", params: { sessionId: this.sessionId } }); }
  close(killChild = true) {
    this.fail(new Error("Agent connection closed."));
    if (killChild) this.child.kill();
  }
}

/**
 * The advertised mode an unattended Ask card runs in: a value of the agent's own `mode` option whose id or name says it asks first
 * (ask, approve, approval, confirm, untrusted, manual), else one that says read-only, else one named plan. A value whose words also
 * say it allows without asking (auto, accept, always, bypass, yolo, skip, allow, full, dangerous) never counts. Only ids the agent
 * advertised are returned; nothing is invented. Live 6 November 2026: Grok advertised no mode; Antigravity advertised default,
 * accept-edits and plan, and in default it ran a shell command and wrote a file without any permission request.
 */
export function askMode(options: AcpOption[]): { option: AcpOption; value: string } | undefined {
  const option = options.find((o) => o.category === "mode");
  if (!option) return undefined;
  const words = (v: { value: string; name: string }) => `${v.value} ${v.name}`.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const allows = new Set(["auto", "accept", "always", "bypass", "yolo", "skip", "allow", "full", "dangerous", "dangerously"]);
  const candidates = option.values.filter((v) => !words(v).some((w) => allows.has(w)));
  const tests: ((w: string[]) => boolean)[] = [
    (w) => w.some((x) => ["ask", "approve", "approval", "confirm", "untrusted", "manual"].includes(x)),
    (w) => w.includes("readonly") || w.some((x, i) => x === "read" && w[i + 1] === "only"),
    (w) => w.includes("plan"),
  ];
  for (const test of tests) { const found = candidates.find((v) => test(words(v))); if (found) return { option, value: found.value }; }
  return undefined;
}

/** Why an unattended Grok or Antigravity card cannot run with Ask on this account (askMode found nothing). */
export function noAskMode(account: string | undefined, options: AcpOption[] | undefined): string {
  const modes = options?.find((o) => o.category === "mode")?.values.map((v) => v.value) ?? [];
  return `${account ?? "This agent"} advertises no mode that asks for approval (modes: ${modes.join(", ") || "none"}), so Ask cannot be enforced on an unattended card. Use Bypass, or a Claude or Codex account.`;
}

export function startAcp(provider: AcpProvider, cwd: string, grokHome?: string, onUpdate?: (update: JsonObject) => void,
  onPermission?: (request: JsonObject) => Promise<string | undefined>, env: NodeJS.ProcessEnv = process.env): AcpSession {
  const run = acpCommand(provider, grokHome, env);
  return new AcpSession(spawn(run.file, run.args, { cwd, env: run.env, windowsHide: true, detached: process.platform !== "win32" }), onUpdate, onPermission);
}

/**
 * Neither CLI writes its version into a session's files (checked 17 November 2026), so a session's harness stays unknown, with where it
 * was looked for. Grok 1.0.77: <GROK_HOME>/sessions/<cwd>/<id>/summary.json and prompt_context.json name the model, not the CLI build.
 * agy 1.5.10: conversations/<id>.db holds protobuf blobs, and its log names the version per CLI start, not per conversation.
 */
export const acpHarness = (provider: AcpProvider) => ({ unknown: provider === "grok"
  ? "grok: its session files (<GROK_HOME>/sessions/<cwd>/<session>/summary.json, prompt_context.json) record the model, not the CLI version"
  : "antigravity: its conversation store (~/.gemini/antigravity-cli/conversations/<session>.db) does not record the CLI version readably; its log records it per CLI start, not per conversation" });
