/** Tool-free provider calls for the text helpers, and the detached worker that runs acceptance checks. No VS Code dependency. */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { isDeepStrictEqual } from "util";
import { execFile, spawn } from "child_process";
import { readJson, saveJson, type Receipt } from "./jobs";
import { codexHomeIn, toWsl, wslCommand, WSL_PREFIX } from "./wsl";
import { acpModelChoice, startAcp, type AcpProvider } from "./acp";
import { claudeModelId, exactModel, newestOf } from "./models";
import { isTempRoot, makeTemp, tempRoot, workspaceRepo } from "./workspace";

export type TextModel = "haiku" | "sonnet" | "fable" | "opus";
export type TextEffort = "low" | "medium" | "high" | "xhigh" | "max";
/** The four providers a helper call (title, completion rule, Refine, Improve) can run on. */
export type HelperProvider = "claude" | "codex" | AcpProvider;
/**
 * A helper call on Grok or Antigravity (orchestrator run 0db6d1): one headless ACP prompt. configDir is the Grok profile's GROK_HOME
 * ("" for Antigravity's shared sign-in). There is no fixed model list: a named model must be among the options the session advertises
 * (a short name runs the newest of its family), and an empty one selects the model the session reports it is on, by its exact id
 * (acpModelChoice; 17 November 2026). An empty effort keeps the agent's own.
 */
export interface AcpVia { acp: AcpProvider }
/** Where a helper call goes: Claude (nothing), the Codex CLI (its path, "wsl:<distro>" in WSL), or a Grok or Antigravity agent. */
export type TextVia = string | AcpVia;
export const viaProvider = (via?: TextVia): HelperProvider => typeof via === "object" ? via.acp : via ? "codex" : "claude";
/** How a helper starts an ACP agent; tests put a fake agent here. */
export const acpHelper = { start: startAcp };
/** provider "codex": a text job on a Codex model the user picked (member then holds that model). */
/** fallbackConfigDirs: other signed-in Claude account folders, tried in order when a Claude call hits a usage limit. */
interface Job { member: string; configDir: string; codexPath: string; effort?: string; provider?: "codex" | AcpProvider; fallbackConfigDirs?: string[]; onOutput?: HelperOutput }
/**
 * Live output from a helper call, for the helper tab (src/helper-tab.ts). Without stream: one activity line. With stream: a piece of the
 * model's thinking (Claude's thinking summary, Codex's reasoning summaries) or of its answer as it is written. Memory only: never written to disk here.
 */
export type HelperOutput = (text: string, stream?: "thinking" | "answer") => void;
/** One activity line for a Codex --json event, or undefined for an event not worth a line (reasoning and the answer go to the streams). */
export function codexEventLine(event: any): string | undefined {
  const clip = (t: unknown) => typeof t === "string" ? (t.length > 400 ? `${t.slice(0, 400)}…` : t) : "";
  switch (event?.type) {
    case "thread.started": return "Codex thread started.";
    case "turn.started": return "Turn started.";
    case "item.completed":
      if (event.item?.type === "agent_message" || event.item?.type === "reasoning") return undefined;
      if (event.item?.type === "error") return `Codex reported: ${clip(event.item.message ?? event.item.text ?? "")}`;
      return event.item?.type ? `${event.item.type} finished.` : undefined;
    case "turn.completed": {
      const u = event.usage || {};
      return `Turn completed${typeof u.input_tokens === "number" ? ` (${u.input_tokens} input · ${u.output_tokens ?? 0} output tokens)` : ""}.`;
    }
    case "turn.failed": case "error": return `Codex reported: ${clip(event.error?.message ?? event.message ?? JSON.stringify(event))}`;
    default: return undefined;
  }
}
export function newestModel(models: Array<{ model: string; hidden?: boolean }>, family: "astra" | "sol" | "terra") {
  // Versions compared as numbers (fix 11, models.ts), not localeCompare, which orders "." against "-" by locale.
  const found = newestOf("codex", family, models.filter(m => !m.hidden).map(m => m.model));
  if (!found) throw new Error(`The signed-in Codex CLI did not advertise a ${family} model.`);
  return found;
}

/** The claude binary to spawn: the native one on Windows when installed, else what PATH gives. */
export function claudeBinary(): string {
  const native = path.join(os.homedir(), ".local", "bin", "claude.exe");
  return process.platform === "win32" && fs.existsSync(native) ? native : "claude";
}

export function environment(configDir: string) {
  const env = { ...process.env };
  // Providers own their authentication. Do not inherit an unrelated task's provider/account.
  for (const key of ["CLAUDECODE", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_EFFORT_LEVEL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"]) delete env[key];
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  // A helper folder in the workspace's .entomatical/tmp: git must not climb from there into the repository (workspace.ts).
  const repo = workspaceRepo();
  if (repo) env.GIT_CEILING_DIRECTORIES = tempRoot(repo);
  return env;
}

/** Attribute the answer separately from the CLI's aggregate usage (which can include background calls). */
export function parseClaudeResponse(parsed: any, member: string, requestedModel = member) {
  const events: any[] = Array.isArray(parsed) ? parsed : [parsed];
  const raw = events.findLast(event => event?.type === "result");
  if (!raw) throw new Error("Claude returned no result record; inspect its saved provider output.");
  if (raw.is_error || raw.subtype !== "success") throw new Error(raw.result || raw.subtype || "Claude did not finish successfully.");
  const value = raw.structured_output ?? (typeof raw.result === "string" ? JSON.parse(raw.result) : undefined);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Claude returned no structured answer; inspect its saved provider output.");
  const models = Object.keys(raw.modelUsage || {});
  const family = (model: string, name: string) => new RegExp(`^claude-(?:[0-9]+(?:-[0-9]+)*-)?${name}(?:-|$)`).test(model.toLowerCase());
  const assistants = events.filter(event => event?.type === "assistant" && !event.error);
  if (raw.subagent_stats?.spawned > 0 || assistants.some(event => event.parent_tool_use_id != null)) {
    throw new Error("Claude delegated work during a helper call; the answer was not accepted.");
  }
  const main = assistants.filter(event => !raw.session_id || !event.session_id || event.session_id === raw.session_id);
  if (assistants.length && (!main.length || main.length !== assistants.length || main.some(event => typeof event.message?.model !== "string" || !event.message.model))) {
    throw new Error("Claude assistant identity is missing or belongs to another session; the answer was not accepted.");
  }
  const observed = [...new Set<string>(main.map(event => event.message?.model).filter((model): model is string => typeof model === "string"))];
  let actual: string | undefined, method: string;
  if (observed.length) {
    if (observed.length !== 1 || !family(observed[0], member)) throw new Error(`Claude answered with ${observed.join(", ")}, not the requested ${member} model.`);
    actual = observed[0]; method = "assistant-model";
    if (!models.includes(actual)) throw new Error("Claude's answer model is missing from its usage report; identity could not be reconciled.");
  } else if (models.length === 1 && family(models[0], member)) {
    actual = models[0]; method = "sole-usage-model";
  } else {
    // Old nonverbose receipts have no assistant model. Recover only a unique exact top-level usage match,
    // no spawned agents, and Haiku-only ancillary usage. Never select a model merely because it is present.
    const pairs = [["input_tokens", "inputTokens"], ["output_tokens", "outputTokens"],
      ["cache_read_input_tokens", "cacheReadInputTokens"], ["cache_creation_input_tokens", "cacheCreationInputTokens"]];
    const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
    const matched = models.filter(model => pairs.every(([key, field]) => valid(raw.usage?.[key]) && valid(raw.modelUsage[model]?.[field]) && raw.usage[key] === raw.modelUsage[model][field]));
    if (raw.subagent_stats?.spawned !== 0 || matched.length !== 1 || !family(matched[0], member)
      || models.some(model => model !== matched[0] && !family(model, "haiku"))) {
      throw new Error(`Claude's ${member} answer model could not be identified unambiguously; inspect its saved provider output.`);
    }
    actual = matched[0]; method = "main-usage-match";
  }
  if (requestedModel !== member && actual !== requestedModel) throw new Error(`Claude answered with ${actual}; this goal is pinned to ${requestedModel}.`);
  return { value, model: actual, usage: { usage: raw.usage, modelUsage: raw.modelUsage, totalCostUsd: raw.total_cost_usd,
    attribution: { method, primaryModel: actual, auxiliaryModels: models.filter(model => model !== actual) } } };
}

/**
 * The provider's own reason for a failed call, and whether it was a usage limit. Seen 28 Oct 2026: a Claude account over its
 * Fable limit exits 1 with nothing on stderr; its JSON holds a rejected rate_limit_event and a result "You've reached your Fable limit…".
 */
export function providerFailure(stdout: string, stderr: string, claude: boolean): { message?: string; limited: boolean } {
  let message: string | undefined, limited = false;
  if (claude) {
    let events: any[] = [];
    try { const parsed = JSON.parse(stdout); events = Array.isArray(parsed) ? parsed : [parsed]; } catch { /* not JSON: stderr is all there is */ }
    for (const e of events) {
      if (e?.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected") limited = true;
      if (e?.type === "assistant" && e.error === "rate_limit") limited = true;
      if (e?.type === "result" && (e.is_error || e.api_error_status)) {
        if (typeof e.result === "string" && e.result.trim()) message = e.result.trim();
        if (e.api_error_status === 429) limited = true;
      }
    }
  } else {
    for (const line of stdout.split("\n").filter(Boolean)) {
      try { const e = JSON.parse(line); const m = e?.error?.message ?? (e?.type === "error" ? e.message : undefined); if (typeof m === "string" && m.trim()) message = m.trim(); } catch { /* partial line */ }
    }
    if (message && /\b429\b|rate limit|usage limit/i.test(message)) limited = true;
  }
  return { message: message ?? (stderr.trim().split("\n").filter(Boolean).at(-1) || undefined), limited };
}
const accountLabel = (configDir: string) => (configDir ? path.basename(configDir) : "~/.claude");

/** Codex exec JSONL orders messages and turn boundaries. Older streams can omit the start marker. */
function completedCodexAnswer(stdout: string, stderr = "") {
  let pending: string | undefined, error: string | undefined;
  let completed: { text?: string; usage: unknown } | undefined;
  const stopped = (line: string) => {
    const failure = providerFailure(line, stderr, false);
    return Object.assign(new Error(`Codex stopped: ${failure.message || line}`), { limited: failure.limited });
  };
  for (const line of stdout.split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; } // WSL login shells can print non-JSON lines
    switch (event?.type) {
      case "thread.started": case "turn.started":
        pending = undefined; completed = undefined; error = undefined;
        break;
      case "item.completed":
        if (event.item?.type === "agent_message") { pending = event.item.text; completed = undefined; }
        break;
      case "turn.completed":
        completed = { text: pending, usage: event.usage }; pending = undefined;
        break;
      case "turn.failed": throw stopped(line);
      case "error": error = line; break; // a reconnect can be followed by a genuine completion
    }
  }
  if (!completed) {
    if (error) throw stopped(error);
    throw new Error("Codex exited without a completed turn.");
  }
  if (completed.text) {
    try {
      const value = JSON.parse(completed.text);
      if (value) return { value, text: completed.text, usage: completed.usage };
    } catch { /* the last agent message did not contain a structured answer */ }
  }
  throw new Error("Codex returned no structured answer.");
}

/** True when dir or one of its parents holds a .git entry: inside a repository's working tree or a worktree. */
export function insideRepository(dir: string): boolean {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, ".git"))) return true;
    if (isTempRoot(d)) return false; // the workspace's .entomatical/tmp: git stops here too (GIT_CEILING_DIRECTORIES)
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
}
/**
 * A fresh, empty folder outside any repository for one helper process to run in (4 November 2026 review, consensus items 8, 13, 51).
 * Run from the helper folder inside the user's repository, the CLI added that repository's git state to the model's context
 * (seen in b3f41ee9 and 94e6f28b). The schema, output and receipts stay in the helper folder; only the process's cwd moves.
 * This removes the repository-working-directory route only; it does not prove no other ambient context reaches the model.
 */
export function neutralExecutionDir(): { dir: string; outsideRepository: boolean } {
  // Inside the open workspace (the user, 13 November 2026): <repo>/.entomatical/tmp/helpers, where git stops at the temp root's marker.
  // Measured 13 November 2026 with the helper flags below (Claude CLI, Haiku): +545 input tokens next to a %TEMP% folder, the same with
  // the repository's CLAUDE.md excluded, so that file is not what is added.
  const repo = workspaceRepo();
  if (repo) { const dir = makeTemp("helpers", repo); return { dir, outsideRepository: !insideRepository(dir) }; }
  for (const base of [os.tmpdir(), path.join(os.homedir(), ".entomatical", "helper-cwd")]) {
    try {
      fs.mkdirSync(base, { recursive: true });
      if (!insideRepository(base)) return { dir: fs.mkdtempSync(path.join(base, "entomatical-helper-")), outsideRepository: true };
    } catch { /* this base is unusable: try the next */ }
  }
  return { dir: fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-helper-")), outsideRepository: false };
}
/** What a saved answer must have been made from before it is reused: provider, model, effort, the exact prompt and the schema. */
export function helperInputKey(input: { provider: HelperProvider; model: string; effort: string; prompt: string; schema: unknown }): string {
  return crypto.createHash("sha256").update(JSON.stringify([input.provider, input.model, input.effort, input.prompt, input.schema])).digest("hex");
}
/**
 * One provider process of a helper call, for receipts (4 November 2026 review, item 1.2). reported.* comes from the provider's own
 * events and is null when it gave none; it is never filled in from what was requested. No environment or credential is recorded.
 */
export interface HelperAttempt {
  n: number; provider: HelperProvider; account: string; model: string; effort: string; stream: boolean;
  executable: string; argv: string[]; cwd: string; wslCd: string | null; cwdOutsideRepository: boolean;
  startedAt: string; endedAt: string | null; elapsedMs: number | null;
  outcome: "running" | "answered" | "limited" | "failed" | "cancelled" | "no-stream";
  exitCode: number | null; error: string | null;
  reported: { model: string | null; cwd: string | null; version: string | null };
  usage: unknown; costUsd: number | null; providerOutput: string | null;
}

interface CallResult { value: any; model: string; usage: unknown; elapsedMs: number; recoveredSavedOutput?: boolean; configDir?: string; note?: string;
  attempts?: HelperAttempt[]; durationMs?: number; inputKey?: string }
async function call(job: Job, dir: string, model: string, prompt: string, schema: unknown, signal: AbortSignal): Promise<CallResult> {
  const key = "text";
  const output = path.join(dir, `${key}.result.json`);
  const provider: HelperProvider = job.provider ?? "claude";
  const claude = provider === "claude", acp = provider === "grok" || provider === "antigravity";
  // An ACP call with no effort keeps the agent's own thought level; Claude and Codex default to medium.
  const effort = job.effort || (acp ? "" : "medium");
  const inputKey = helperInputKey({ provider, model, effort, prompt, schema });
  const inputFile = path.join(dir, `${key}.input.json`);
  const providerOutput = path.join(dir, `${key}.provider-output.jsonl`);
  const sameInput = () => { try { return readJson<{ inputKey?: string }>(inputFile).inputKey === inputKey; } catch { return false; } };
  const aside = (file: string) => fs.renameSync(file, file.replace(/(\.[a-z]+)$/, `-${Date.now()}$1`));
  // A successful call survives a crash before its stage checkpoint, but only for the same input: file presence alone is not enough.
  if (fs.existsSync(output)) {
    const saved = readJson<CallResult>(output);
    if (saved.inputKey === inputKey) {
      if (provider !== "codex") return saved;
      // Older builds also cached intermediate messages. Reuse a matching cache only with its completed stream.
      const attempt = saved.attempts?.at(-1);
      if (sameInput() && attempt?.outcome === "answered" && attempt.exitCode === 0) {
        try {
          const answer = completedCodexAnswer(fs.readFileSync(providerOutput, "utf8"));
          if (isDeepStrictEqual(answer.value, saved.value)) return saved;
        } catch { /* missing or incomplete evidence: retry */ }
      }
      if (fs.existsSync(providerOutput)) aside(providerOutput);
    }
    aside(output);
  }
  if (claude && fs.existsSync(providerOutput) && !sameInput()) aside(providerOutput);
  if (claude && fs.existsSync(providerOutput)) {
    let recoveredResult: CallResult | undefined;
    try {
      const parsed = readJson<any>(providerOutput), recovered = parseClaudeResponse(parsed, job.member, model);
      const raw = Array.isArray(parsed) ? parsed.findLast(event => event?.type === "result") : parsed;
      recoveredResult = { ...recovered, elapsedMs: typeof raw.duration_ms === "number" ? raw.duration_ms : 0, recoveredSavedOutput: true, attempts: [], durationMs: 0, inputKey };
    } catch { /* A failed/ambiguous response requires a real retry; keep its evidence before replacing it. */ }
    // Persistence failure must surface, never turn a reusable answer into another paid request.
    if (recoveredResult) { saveJson(output, recoveredResult); job.onOutput?.("Reused the answer saved by an earlier run of this call."); return recoveredResult; }
    fs.copyFileSync(providerOutput, path.join(dir, `${key}.provider-output-${Date.now()}.jsonl`));
  }
  const schemaFile = path.join(dir, `${key}.schema.json`);
  saveJson(schemaFile, schema);
  // Written before any provider process starts, so saved output can later be matched to the input it answered.
  saveJson(inputFile, { inputKey, provider, model, effort, at: new Date().toISOString() });
  if (acp) {
    const attempts: HelperAttempt[] = [], operationStarted = Date.now();
    try {
      const answered: CallResult = { ...(await acpAttempt(provider as AcpProvider, attempts)), configDir: job.configDir, attempts, durationMs: Date.now() - operationStarted, inputKey };
      saveJson(output, answered);
      return answered;
    } catch (e) { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { attempts, durationMs: Date.now() - operationStarted }); }
  }
  const binary = claude ? claudeBinary() : job.codexPath;
  // codexPath "wsl:<distro>": Codex runs in that WSL distro (codex.ts codexTextPath), so its file arguments are WSL paths.
  const wslDistro = !claude && job.codexPath.startsWith(WSL_PREFIX) ? job.codexPath.slice(WSL_PREFIX.length) : undefined;
  // Watched (onOutput): Claude streams its events, partial messages and a thinking summary (the flags the Claude Code extension itself
  // passes for its panel), and Codex adds detailed reasoning summaries. Unwatched calls keep the one-block JSON output.
  const argsFor = (stream: boolean) => claude
    // The full id, not the alias (models.ts CLAUDE_MODEL_IDS, the user, 17 November 2026); the answer is still checked against the family.
    ? ["--print", "--model", exactModel("claude", claudeModelId(model)), "--effort", effort,
      ...(stream ? ["--output-format", "stream-json", "--include-partial-messages", "--thinking-display", "summarized"] : ["--output-format", "json"]), "--verbose", "--name", `Entomatical ${job.member} ${key}`, "--json-schema", JSON.stringify(schema),
      "--settings", JSON.stringify({ fallbackModel: [], switchModelsOnFlag: false }),
      "--safe-mode", "--strict-mcp-config", "--tools", "", "--no-session-persistence", "--permission-mode", "dontAsk"]
    : ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only",
      "--model", exactModel("codex", model), "--json", "--output-schema", wslDistro ? toWsl(schemaFile, wslDistro) : schemaFile, "--color", "never",
      "--disable", "shell_tool", "--disable", "multi_agent", "--disable", "apps", "--disable", "plugins", "--disable", "goals",
      "-c", "web_search=\"disabled\"", "-c", `model_reasoning_effort=${JSON.stringify(effort)}`, "-c", "approval_policy=\"never\"",
      // No AGENTS.md from the cwd or its parents: a repository's (20.5 KB in sample-project) went to the model unseen and uncapped (F20-2, 3482f4's review).
      "-c", "project_doc_max_bytes=0",
      ...(stream ? ["-c", "model_reasoning_summary=\"detailed\""] : []), "-"];
  let streaming = !!job.onOutput;
  // The packet is supplied on stdin; no shell interpolation or command-line prompt length limits.
  // A Claude call that hits a usage limit runs again on the next signed-in account (the CLI holds each folder's own login).
  const accounts = claude ? [job.configDir, ...(job.fallbackConfigDirs ?? []).filter((d) => d !== job.configDir)] : [job.configDir];
  const limitedOn: string[] = [];
  const attempts: HelperAttempt[] = [];
  const operationStarted = Date.now();
  let result: CallResult | undefined;
  for (const configDir of accounts) {
    try {
      result = { ...(await attemptOnce(configDir)), configDir, attempts, durationMs: Date.now() - operationStarted, inputKey };
      if (limitedOn.length) result.note = `${limitedOn.join(", ")} hit a usage limit, so ${accountLabel(configDir)} answered instead.`;
      break;
    } catch (e) {
      const limited = !!(e as { limited?: boolean }).limited;
      if (!limited || configDir === accounts.at(-1)) {
        // Every account was limited only when the last one was too; textJob moves Fable to Opus on allLimited. A cancel, timeout or
        // other failure after an earlier limit is reported as what it was (it used to read "every account hit a usage limit").
        const labels = [...limitedOn, accountLabel(configDir)], reason = e instanceof Error ? e.message : String(e);
        const message = !limitedOn.length ? undefined : limited ? `Every signed-in Claude account hit a usage limit (${labels.join(", ")}). ${reason}`
          : `${limitedOn.join(", ")} hit a usage limit; ${accountLabel(configDir)} then failed: ${reason}`;
        throw Object.assign(message ? new Error(message) : e as Error, { allLimited: limited, accounts: labels, reason: (e as { reason?: string }).reason, attempts,
          durationMs: Date.now() - operationStarted, ...(message ? { cause: e } : {}) });
      }
      limitedOn.push(accountLabel(configDir));
      job.onOutput?.(`${accountLabel(configDir)} hit a usage limit; trying the next signed-in account.`);
    }
  }
  saveJson(output, result);
  return result!;

  async function attemptOnce(configDir: string) {
    try { return await attempt(configDir, streaming); }
    catch (e) {
      if (!(e as { noStream?: boolean }).noStream) throw e;
      streaming = false;
      job.onOutput?.("This CLI cannot stream its output; running again without live output.");
      return attempt(configDir, false);
    }
  }

  function attempt(configDir: string, stream: boolean) {
  const args = argsFor(stream);
  const started = Date.now();
  return new Promise<CallResult>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Text generation cancelled."));
    job.onOutput?.(`${claude ? "Claude" : "Codex"} ${model} · ${effort} effort started on ${claude ? accountLabel(configDir) : "the Codex account"}.`);
    // Codex still reads its own $CODEX_HOME/AGENTS.md (--ignore-user-config skips only config.toml); the repository's is not loaded.
    // Say so when it holds anything, since it is not in "What was sent" (item 1 of session 3482f4's second review). In WSL mode it is
    // the distro's ~/.codex/AGENTS.md, read through its Windows path (found unannounced on Windows, 5 November 2026).
    const agents = claude ? undefined : codexAgentsNote(wslDistro);
    if (agents) job.onOutput?.(agents);
    const exec = neutralExecutionDir();
    const run = wslDistro ? wslCommand({ distro: wslDistro }, args, exec.dir) : { file: binary, args };
    // The inline schema is long and already saved beside the receipt; the recorded argv names that file instead.
    const shownArgs = run.args.map((a, i) => (run.args[i - 1] === "--json-schema" ? `<${path.basename(schemaFile)}>` : a));
    const record: HelperAttempt = { n: attempts.length + 1, provider: claude ? "claude" : "codex", account: claude ? accountLabel(configDir) : "the Codex account",
      model, effort: effort, stream, executable: run.file, argv: shownArgs, cwd: exec.dir, wslCd: wslDistro ? exec.dir : null,
      cwdOutsideRepository: exec.outsideRepository, startedAt: new Date(started).toISOString(), endedAt: null, elapsedMs: null, outcome: "running",
      exitCode: null, error: null, reported: { model: null, cwd: null, version: null }, usage: null, costUsd: null, providerOutput: null };
    attempts.push(record);
    const end = (outcome: HelperAttempt["outcome"], error?: unknown) => {
      if (record.outcome !== "running") return; // one terminal state: a late close cannot turn a cancel into success
      record.outcome = outcome; record.endedAt = new Date().toISOString(); record.elapsedMs = Date.now() - started;
      if (error !== undefined) record.error = error instanceof Error ? error.message : String(error);
    };
    const removeExec = () => { try { fs.rmSync(exec.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left for the OS to clean */ } };
    // WSL_UTF8: wsl.exe's own messages come as UTF-16 otherwise (F20-4, 3482f4's review).
    const child = spawn(run.file, run.args, { cwd: exec.dir, env: wslDistro ? { ...environment(configDir), WSL_UTF8: "1" } : environment(configDir), windowsHide: true });
    // Decode as streams: a multi-byte character split across two chunks used to become U+FFFD and could be applied into a draft (F19-1).
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    // On Windows the whole tree ends, as for background Codex (board.ts killTree): wsl.exe alone may leave the Linux process running (F20-5).
    const kill = () => {
      if (process.platform === "win32" && child.pid) execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => { child.kill(); });
      else child.kill();
    };
    const cancel = () => { end("cancelled", "Text generation cancelled or timed out."); kill(); reject(new Error("Text generation cancelled or timed out.")); };
    signal.addEventListener("abort", cancel, { once: true });
    let stdout = "", stderr = "";
    // Codex always prints one JSON event per line. Claude does too when streaming; its non-stream events are kept as the array that
    // --output-format json would have printed, so the saved output and its parsing are the same either way.
    let partial = "";
    const events: unknown[] = [], blocks: Record<number, string> = {};
    const out = job.onOutput;
    const take = (line: string) => {
      let e: any;
      try { e = JSON.parse(line); } catch { return; } // not a JSON line
      if (claude) {
        if (e?.type !== "stream_event") { events.push(e); return; }
        const d = e.event;
        if (!out || e.parent_tool_use_id != null || !d) return;
        if (d.type === "content_block_start") blocks[d.index] = d.content_block?.type;
        else if (d.type === "content_block_stop" && blocks[d.index] === "thinking") out("\n\n", "thinking");
        else if (d.type === "content_block_delta") {
          if (d.delta?.type === "thinking_delta" && typeof d.delta.thinking === "string") out(d.delta.thinking, "thinking");
          else if (d.delta?.type === "text_delta" && typeof d.delta.text === "string") out(d.delta.text, "answer");
          else if (d.delta?.type === "input_json_delta" && typeof d.delta.partial_json === "string") out(d.delta.partial_json, "answer");
        }
        return;
      }
      if (!out) return;
      if (e?.type === "item.completed" && e.item?.type === "reasoning" && typeof e.item.text === "string") out(`${e.item.text.trim()}\n\n`, "thinking");
      else { const shown = codexEventLine(e); if (shown) out(shown); }
    };
    child.stdout.on("data", data => {
      const text = data.toString();
      // Streamed Claude receipts are built from the parsed events on close. Raw deltas only feed the live tab.
      if (!claude || !stream) stdout += text;
      if (claude && !stream) return;
      const lines = (partial + text).split("\n"); partial = lines.pop() ?? "";
      for (const l of lines) take(l);
    });
    child.stderr.on("data", data => {
      const text = String(data).replace(/\0/g, "");
      stderr = (stderr + text).slice(-4000);
      for (const l of text.split("\n")) if (l.trim()) job.onOutput?.(`stderr: ${l.trim().slice(0, 400)}`);
    });
    child.on("error", (e) => { end("failed", e); removeExec(); reject(e); }); child.stdin.on("error", (e) => { end("failed", e); reject(e); });
    child.on("close", code => {
      signal.removeEventListener("abort", cancel);
      removeExec();
      record.exitCode = code;
      try {
        if (partial && (stream || !claude)) { take(partial); partial = ""; }
        // A streamed Claude call is saved and parsed as the same JSON array a non-streamed one prints.
        if (claude && stream) stdout = JSON.stringify(events);
        // The raw output is kept even after a cancel: it is evidence. Each attempt also gets its own copy, so a later attempt cannot overwrite it.
        fs.writeFileSync(providerOutput, stdout);
        record.providerOutput = path.basename(providerOutput);
        Object.assign(record, providerTelemetry(stdout, claude));
        if (code !== 0 && claude && stream && /unknown option|unrecognized|thinking-display|include-partial-messages/i.test(stderr)) {
          end("no-stream", "This Claude CLI does not support streamed output.");
          throw Object.assign(new Error("This Claude CLI does not support streamed output."), { noStream: true });
        }
        if (code !== 0) {
          const failure = providerFailure(stdout, stderr, claude);
          throw Object.assign(new Error(`${claude ? "Claude" : "Codex"} on ${claude ? accountLabel(configDir) : "the Codex account"} stopped (exit ${code}): ${failure.message || "it gave no reason; check its sign-in and model access"}`), { limited: failure.limited, reason: failure.message,
            exitCode: code, stderrTail: stderr.slice(-2048) }); // F103: the error log keeps the runner's exit code and the end of its stderr
        }
        let value: any, actual = model, usage: unknown;
        if (claude) {
          let answer;
          try { answer = parseClaudeResponse(JSON.parse(stdout), job.member, model); }
          catch (e) {
            const failure = providerFailure(stdout, stderr, true);
            if (failure.limited) throw Object.assign(new Error(`Claude on ${accountLabel(configDir)} hit a usage limit: ${failure.message || e}`), { limited: true, reason: failure.message });
            throw e;
          }
          value = answer.value; actual = answer.model; usage = answer.usage;
        } else {
          const answer = completedCodexAnswer(stdout, stderr);
          value = answer.value; usage = answer.usage;
          if (record.outcome === "running") { out?.(answer.text, "answer"); out?.("Answer received."); }
        }
        if (record.outcome === "cancelled") { keepAttemptOutput(); return; } // cancelled while the answer arrived: the cancel stands
        end("answered");
        job.onOutput?.(`${actual} answered after ${Math.round((Date.now() - started) / 1000)} s.`);
        resolve({ value, model: actual, usage, elapsedMs: Date.now() - started });
      } catch (e) { end((e as { limited?: boolean }).limited ? "limited" : "failed", e); keepAttemptOutput(); reject(e); }
    });
    // An attempt that did not answer keeps its own copy, so the next attempt's output cannot overwrite it; the answer stays in the
    // canonical file only (one copy per attempt, item 6 of session 3482f4's second review).
    function keepAttemptOutput() {
      if (!fs.existsSync(providerOutput)) return;
      record.providerOutput = `${key}.attempt-${record.n}.provider-output.jsonl`;
      try { fs.copyFileSync(providerOutput, path.join(dir, record.providerOutput)); } catch { /* evidence only */ }
    }
    child.stdin.end(prompt);
  });
  }

  /**
   * One headless ACP prompt on Grok or Antigravity: open a session in a neutral folder, select the model by an exact id (acpModelChoice:
   * the named one, or the session's current one) and the thought level only when named (from what the session advertises; never a fixed
   * list), send the packet, and read the JSON answer from the agent's message. ACP has
   * no schema option, so the schema goes into the packet and the caller's own check (validTitle, validRefinement, validRule) stands.
   * A helper uses no tools: every permission request is refused, and a tool call the agent reports anyway (one its settings
   * preapprove) cancels the turn and fails the helper. No account fallback: the selected account answers or the call fails.
   */
  async function acpAttempt(provider: AcpProvider, attempts: HelperAttempt[]): Promise<CallResult> {
    const name = provider === "grok" ? "Grok" : "Antigravity", started = Date.now();
    const account = provider === "grok" ? accountLabel(job.configDir) : "the shared Antigravity sign-in";
    if (signal.aborted) throw new Error("Text generation cancelled.");
    const exec = neutralExecutionDir();
    const record: HelperAttempt = { n: attempts.length + 1, provider, account, model, effort, stream: !!job.onOutput,
      executable: provider === "grok" ? "grok" : "agy", argv: provider === "grok" ? ["agent", "stdio"] : ["acp"], cwd: exec.dir, wslCd: null,
      cwdOutsideRepository: exec.outsideRepository, startedAt: new Date(started).toISOString(), endedAt: null, elapsedMs: null, outcome: "running",
      exitCode: null, error: null, reported: { model: null, cwd: null, version: null }, usage: null, costUsd: null, providerOutput: null };
    attempts.push(record);
    const end = (outcome: HelperAttempt["outcome"], error?: unknown) => {
      if (record.outcome !== "running") return;
      record.outcome = outcome; record.endedAt = new Date().toISOString(); record.elapsedMs = Date.now() - started;
      if (error !== undefined) record.error = error instanceof Error ? error.message : String(error);
    };
    const out = job.onOutput;
    out?.(`${name} ${model || "(its default model)"} · ${effort || "its default"} effort started on ${account}.`);
    // A helper is not a board session: no inherited controller identity reaches the agent (as runHeadlessAcp).
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (["ENTOMATICAL_SESSION", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID"].includes(k.toUpperCase())) delete env[k];
    let answer = "", stopReason: string | undefined;
    const sent = `${prompt}\n\nReply with only one JSON object, and no other text, that matches this JSON Schema:\n${JSON.stringify(schema)}`;
    let session: ReturnType<typeof startAcp> | undefined, onAbort = () => {};
    // A helper uses no tools. Refusing permission requests is not enough: an agent may run a tool its own settings preapprove, so any
    // reported tool call ends the turn and fails the helper.
    let toolUsed: (title: string) => void = () => {};
    const usedTool = new Promise<never>((_, reject) => { toolUsed = (title) => reject(new Error(`${name} on ${account} ran a tool (${title}); helpers use no tools, so the answer was discarded. Turn off the agent's preapproved tools or use another account.`)); });
    usedTool.catch(() => {});
    try {
      session = acpHelper.start(provider, exec.dir, job.configDir || undefined, (u) => {
        const text = typeof u?.content?.text === "string" && u.content.type === "text" ? u.content.text : undefined;
        if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") {
          const title = String(u.title ?? u.kind ?? u.toolCallId ?? "a tool");
          out?.(`${name} ran a tool (${title}); helpers use no tools, so the turn is cancelled.`);
          try { session?.cancel(); } catch { /* closed */ }
          toolUsed(title);
        }
        else if (u?.sessionUpdate === "agent_message_chunk" && text !== undefined) { answer += text; out?.(text, "answer"); }
        else if (u?.sessionUpdate === "agent_thought_chunk" && text !== undefined) out?.(text, "thinking");
      }, async () => { out?.(`${name} asked to use a tool; refused, as helpers use no tools.`); return undefined; }, env);
      const s = session;
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => { end("cancelled", "Text generation cancelled or timed out."); try { s.cancel(); } catch { /* closed */ } reject(new Error("Text generation cancelled or timed out.")); };
        signal.addEventListener("abort", onAbort, { once: true });
      });
      cancelled.catch(() => {});
      const turn = async () => {
        await s.open(exec.dir);
        // The model first: a model change may change the thought levels on offer. Always an exact id (the user, 17 November 2026): a
        // short name runs the newest advertised id of its family, and no model selects the exact id the session says it is on.
        const pick = acpModelChoice(provider, s.options(), model || undefined, `${name} on ${account}`);
        await s.configure(pick.option.id, pick.value);
        for (const [category, value, what] of [["thought_level", effort, "effort"]] as const) {
          if (!value) continue;
          const option = s.options().find((o) => o.category === category);
          if (!option) throw new Error(`${name} on ${account} advertises no ${what} choice; leave the ${what} empty to use its default.`);
          if (!option.values.some((v) => v.value === value)) throw new Error(`${name} on ${account} does not advertise ${what} ${value}. It offers: ${option.values.map((v) => v.value).join(", ") || "none"}.`);
          await s.configure(option.id, value);
        }
        record.reported.model = s.options().find((o) => o.category === "model")?.currentValue ?? null;
        stopReason = await s.prompt(sent);
      };
      await Promise.race([turn(), cancelled, usedTool]);
    } catch (e) {
      end("failed", e);
      throw e instanceof Error && /^(Agent exited|Agent did not initialize)/.test(e.message) ? new Error(`${name} on ${account} stopped: ${e.message} Check its sign-in.`) : e;
    } finally {
      signal.removeEventListener("abort", onAbort);
      try { session?.close(); } catch { /* already closed */ }
      try { fs.rmSync(exec.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left for the OS to clean */ }
      // The agent's public answer text and turn outcome are the evidence; thoughts and tool input are not kept.
      try { fs.writeFileSync(providerOutput, JSON.stringify({ provider, stopReason: stopReason ?? null, answer }) + "\n"); record.providerOutput = path.basename(providerOutput); } catch { /* evidence only */ }
    }
    if (stopReason !== "end_turn") { const e = new Error(`${name} on ${account} ended its turn with ${stopReason ?? "no outcome"}, not an answer.`); end("failed", e); throw e; }
    const value = jsonAnswer(answer);
    if (!value) { const e = new Error(`${name} returned no structured answer; inspect its saved provider output.`); end("failed", e); throw e; }
    end("answered");
    const actual = record.reported.model ?? model;
    out?.(`${actual || name} answered after ${Math.round((Date.now() - started) / 1000)} s.`);
    return { value, model: actual, usage: null, elapsedMs: Date.now() - started };
  }
}

/** The one JSON object in an agent's reply: the whole text, inside a ```json fence, or from its first { to its last }. */
export function jsonAnswer(text: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  for (const candidate of [text.trim(), fenced?.trim(), text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    if (!candidate) continue;
    try { const v = JSON.parse(candidate); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch { /* next form */ }
  }
  return undefined;
}

/** What the provider itself reported about an attempt: its model, cwd and CLI version (Claude's init event), usage and cost estimate. */
function providerTelemetry(stdout: string, claude: boolean): Pick<HelperAttempt, "reported" | "usage" | "costUsd"> {
  const reported: HelperAttempt["reported"] = { model: null, cwd: null, version: null };
  let usage: unknown = null, costUsd: number | null = null;
  try {
    if (claude) {
      const parsed = JSON.parse(stdout), events: any[] = Array.isArray(parsed) ? parsed : [parsed];
      const init = events.find((e) => e?.type === "system" && e.subtype === "init");
      if (typeof init?.cwd === "string") reported.cwd = init.cwd;
      if (typeof init?.claude_code_version === "string") reported.version = init.claude_code_version;
      const models = [...new Set(events.filter((e) => e?.type === "assistant" && typeof e.message?.model === "string").map((e) => e.message.model))];
      if (models.length === 1) reported.model = models[0] as string;
      const res = events.findLast((e) => e?.type === "result");
      if (res) { usage = res.usage ?? null; costUsd = typeof res.total_cost_usd === "number" ? res.total_cost_usd : null; }
    } else {
      for (const line of stdout.split("\n").filter(Boolean)) {
        try { const e = JSON.parse(line); if (e.type === "turn.completed") usage = e.usage ?? null; } catch { /* partial line */ }
      }
    }
  } catch { /* unparseable output: every field stays unavailable */ }
  return { reported, usage, costUsd };
}

/** One tool-free call on exactly this model (other accounts on a usage limit, never another model). A finished call's answer is kept in dir. */
/** via: the Codex CLI path, or { acp: "grok" | "antigravity" } for one headless ACP prompt; nothing for Claude. Effort defaults to medium on Claude and Codex, to the agent's own on ACP. */
export function textCall(dir: string, model: string, configDir: string, prompt: string, schema: unknown, signal: AbortSignal, effort?: string, via?: TextVia, fallbackConfigDirs: string[] = [], onOutput?: HelperOutput) {
  fs.mkdirSync(dir, { recursive: true });
  const provider = viaProvider(via);
  return call({ member: model, effort, configDir, codexPath: typeof via === "string" ? via : "", provider: provider === "claude" ? undefined : provider,
    fallbackConfigDirs: provider === "claude" ? fallbackConfigDirs : [], onOutput }, dir, model, prompt, schema, signal);
}

/** The helper tab's line when Codex's own AGENTS.md holds anything (native, or in `wslDistro` through its Windows path). */
export function codexAgentsNote(wslDistro?: string): string | undefined {
  const home = wslDistro ? codexHomeIn(wslDistro) : process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  if (!home) return undefined;
  try {
    const f = path.join(home, "AGENTS.md"), size = fs.statSync(f).size;
    return size > 0 ? `Codex also reads ${wslDistro ? toWsl(f, wslDistro) : f} (${size} bytes), which is not shown under What was sent.` : undefined;
  } catch { return undefined; }
}

/** Naming and refinement share the tested tool-free provider runner; monitoring never calls this. */
export async function textJob(dir: string, model: string, configDir: string, prompt: string, schema: unknown, signal: AbortSignal, effort?: string, codexPath?: TextVia, fallbackConfigDirs: string[] = [], onOutput?: HelperOutput) {
  const run = (m: string) => textCall(dir, m, configDir, prompt, schema, signal, effort, codexPath, fallbackConfigDirs, onOutput);
  try { return await run(model); }
  catch (e) {
    // the user, 29 Oct 2026: once Fable's limit is reached everywhere, work carries on with Opus and below. Same effort: Opus takes max too.
    if (codexPath || model !== "fable" || !(e as { allLimited?: boolean }).allLimited) throw e;
    onOutput?.("Every signed-in Claude account hit its Fable limit; asking Opus instead.");
    const earlier = (e as { attempts?: HelperAttempt[] }).attempts ?? [];
    const result = await run("opus").catch((err) => { throw Object.assign(err, { attempts: [...earlier, ...((err as { attempts?: HelperAttempt[] }).attempts ?? [])] }); });
    result.attempts = [...earlier, ...(result.attempts ?? [])].map((a, i) => ({ ...a, n: i + 1 }));
    return { ...result, note: [`Every signed-in Claude account hit its Fable limit, so Opus answered instead.`, result.note].filter(Boolean).join(" ") };
  }
}

// A line that names a failure, and a test runner's tally that says none failed ("ℹ fail 0", "0 failed"), which is not one.
const FAILED = /\b(error|errors|fail|failed|failing|failure|failures|not ok)\b|✖|✗/i;
const ERROR_NAME = /[a-z]Error\b|Exception\b/; // AssertionError, TypeError, NullPointerException: case matters, or "terror" would count
const NONE_FAILED = /\b(fail|failed|failures|errors?)\W{0,3}0\b|\b0 (failed|failures|errors?)\b/i;
// Passed and skipped tests may describe error handling; their titles are not failed checks.
const PASSED = /^\s*(?:[✔✓√﹣]\s|ok\s+\d+\b|PASS\b|#\s*Subtest:)/;
// node --test's closing summary names the actual failures; stack frames add no summary.
const FAILING_BLOCK = /^\s*✖ failing tests:?\s*$/;
const STACK = /^\s+at\s/;

/** What a failed check said, from the last 64 KB of its log: the lines naming the failure and the end of the output. Both are
 *  bounded, because they are kept on the card in tasks.json and go into Fix it's prompt. A runner's own failing-tests summary wins
 *  (its lines, stack frames left out); else the lines naming a failure, never a passed test's. */
export function failureReadout(log: string): { lines: string[]; tail: string } {
  let text = "";
  try {
    const fd = fs.openSync(log, "r");
    try {
      const size = fs.fstatSync(fd).size, n = Math.min(size, 65536), b = Buffer.alloc(n);
      fs.readSync(fd, b, 0, n, size - n);
      text = b.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { /* no log: nothing to show */ }
  const all = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const block = all.findLastIndex((l) => FAILING_BLOCK.test(l));
  const picked = block >= 0 ? all.slice(block + 1).filter((l) => !STACK.test(l) && !PASSED.test(l))
    : all.filter((l) => (FAILED.test(l) || ERROR_NAME.test(l)) && !NONE_FAILED.test(l) && !PASSED.test(l));
  return {
    lines: picked.slice(0, 10).map((l) => l.slice(0, 300)),
    tail: all.slice(-30).join("\n").slice(-3000),
  };
}

export async function runChecks(jobFile: string) {
  const dir = path.dirname(jobFile);
  // limitsMs: each command's time limit (auto-finish, checks.ts checkLimitsMs); a command past it is killed and fails the run.
  const job = readJson<Pick<Receipt, "revision" | "phase" | "at" | "ruleId"> & { commands: string[]; cwd: string; limitsMs?: number[] }>(jobFile);
  const receipt: Receipt = { status: "running", pid: process.pid, heartbeat: Date.now(), bootTime: Date.now() - os.uptime() * 1000,
    revision: job.revision, phase: job.phase, at: job.at, ruleId: job.ruleId, commands: job.commands };
  const file = path.join(dir, "receipt.json");
  // A failed write (disk full, the folder busy) must not crash the worker mid-run; the next beat tries again.
  const heartbeat = setInterval(() => { receipt.heartbeat = Date.now(); try { saveJson(file, receipt); } catch { /* next beat */ } }, 5000);
  // The worker itself runs as node through ELECTRON_RUN_AS_NODE (jobs.ts); a check command that starts Electron or Code must not.
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
  try {
    saveJson(file, receipt);
    for (let i = 0; i < job.commands.length; i++) {
      const limit = job.limitsMs?.[i];
      let timedOut = false;
      const code = await new Promise<number | null>((resolve, reject) => {
        const log = fs.openSync(path.join(dir, `check-${i}.log`), "a");
        // With a limit it gets its own process group on Linux, so the kill reaches what the shell started too.
        const child = process.platform === "win32"
          ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", job.commands[i]], { cwd: job.cwd, env, windowsHide: true, stdio: ["ignore", log, log] })
          : spawn("/bin/sh", ["-c", job.commands[i]], { cwd: job.cwd, env, stdio: ["ignore", log, log], detached: !!limit });
        fs.closeSync(log);
        const timer = limit ? setTimeout(() => {
          timedOut = true;
          if (process.platform === "win32") execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, (err) => { if (err) child.kill(); });
          else try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }, limit) : undefined;
        child.once("error", (e) => { clearTimeout(timer); reject(e); }); child.once("close", (c) => { clearTimeout(timer); resolve(c); });
      });
      saveJson(path.join(dir, `check-${i}.json`), { command: job.commands[i], exitCode: code, at: new Date().toISOString(), ...(timedOut ? { timedOut: true } : {}) });
      if (code !== 0 || timedOut) {
        const log = path.join(dir, `check-${i}.log`);
        receipt.failure = { command: job.commands[i], exitCode: code, ...failureReadout(log), log };
        throw new Error(timedOut ? `Acceptance check ${i + 1} timed out: ${job.commands[i]} ran past its limit of ${limit! >= 60_000 ? `${+(limit! / 60_000).toFixed(1)} minutes` : `${+(limit! / 1000).toFixed(1)} seconds`} and was stopped.`
          : `Acceptance check ${i + 1} failed: ${job.commands[i]} exited with ${code}.`);
      }
    }
    receipt.checksPassed = true; receipt.status = "complete";
  } catch (e) { receipt.status = "error"; receipt.checksPassed = false; receipt.error = String(e); }
  finally { clearInterval(heartbeat); saveJson(file, receipt); }
}

if (require.main === module) void runChecks(process.argv[2]).catch(e => { console.error(e); process.exitCode = 1; });
