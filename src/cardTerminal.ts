import { randomUUID } from "crypto";
import * as path from "path";
import { acpCommand, AcpProvider, antigravityArgs, grokArgs } from "./acp";
import { exactModel } from "./models";
import type { IPty, IPtyForkOptions } from "node-pty";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";

/** Full terminal output can include secrets. Keep only a bounded, in-memory replay, never board events. */
const REPLAY_LIMIT = 512 * 1024;
const INPUT_LIMIT = 64 * 1024;
export const NOT_RUNNING_BOARD = "Another window runs this board, or this one is taking it over after a reload.";
export type TerminalState = "running" | "stopping" | "exited";
export interface CardTerminalState { id: string; generation: string; state: TerminalState; cols: number; rows: number; exitCode?: number; retired?: boolean }
export interface CardTerminalSnapshot extends CardTerminalState { snapshot: string }
export interface CardTerminalData { id: string; generation: string; data: string }
type Listener<T> = (event: T) => void;
type Spawn = (file: string, args: string[], options: IPtyForkOptions) => IPty;
/** Ends a process and everything it started; calls back with an error when it could not (Windows: taskkill /T /F, as board.ts killTree). */
type TreeKill = (pid: number, done: (error: Error | null) => void) => void;
const taskkillTree: TreeKill = (pid, done) => {
  require("child_process").execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error: Error | null) => done(error));
};
const ptySpawn: Spawn = (...args) => require("node-pty").spawn(...args);
// node-pty 1.2.0-beta.18's WindowsPtyAgent records native exit before WindowsTerminal reports socket close.
type WindowsPty = IPty & { _agent?: { readonly exitCode?: number; _conoutSocketWorker?: { dispose(): void } } };
function windowsPtyExited(pty: IPty): boolean {
  return typeof (pty as WindowsPty)._agent?.exitCode === "number";
}
/**
 * the user, 15 November 2026: the card's terminal showed plain white on black. A VS Code terminal tells the CLI it can use colour
 * (COLORTERM=truecolor); the extension host's environment does not, and may carry NO_COLOR, FORCE_COLOR=0 or CI from whatever started
 * VS Code. The card's terminal is a colour terminal (xterm.js), so it gets the same as a VS Code terminal. Exported for the tests.
 */
export function colorEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    const name = k.toUpperCase();
    if (name === "NO_COLOR" || name === "CI" || name === "TERM" || name === "COLORTERM" || (name === "FORCE_COLOR" && /^(0|false)$/i.test(v ?? ""))) continue;
    out[k] = v;
  }
  return { ...out, TERM: "xterm-256color", COLORTERM: "truecolor" };
}
/**
 * The board webview's Content-Security-Policy (extension.ts attach). the user, 18 November 2026: the card terminals showed no colours and
 * typing in them lagged. xterm's DOM renderer draws each 24-bit colour as a style="…" attribute on the cell (its _addStyle), which a
 * style-src without 'unsafe-inline' blocks, one CSP violation per cell. style-src-attr lets attributes through; <style> elements still
 * need the nonce and scripts are unchanged.
 */
export const BOARD_CSP = (cspSource: string, nonce: string) =>
  `default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}';`;
/** treeKill: how this entry's tree ends on Windows; only a real node-pty process (or an injected one) has one, never a stand-in pid. */
interface Entry { state: CardTerminalState; process: IPty; provider?: AcpProvider; output: string; screen?: HeadlessTerminal; started: number; outputAt?: number; treeKill?: TreeKill }
/** Start-up checks come in the first seconds; after this a screen showing the same words (a diff of this file) is not a prompt. */
const AUTO_ANSWER_MS = 60_000;
/**
 * Start-up checks answered automatically: [name, what the screen shows, keys sent]. The keys pick each one's yes option. They are
 * matched against the screen with all whitespace as single spaces, as a narrow card terminal wraps the question onto several lines.
 */
const AUTO_ANSWERS: [string, RegExp, string][] = [
  // Claude Code 2.1.325: title "WARNING: Claude Code running in Bypass Permissions mode", options "No, exit" (first, the cursor's start)
  // then "Yes, I accept", no numbers. Down then Enter.
  ["claude-bypass", /Bypass Permissions mode[\s\S]*[>❯] No, exit Yes, I accept/i, "\u001b[B\r"],
  ["trust-yn", /Do you trust the contents of this directory\?[\s\S]*Yes, proceed\s+y/i, "y"],
  // Grok 1.0.77: "Do you trust the contents of this directory? Grok Build may run or modify contents in this directory, posing security
  // risks." over the key options "y  Yes, proceed" and "n  No, quit" ("Enter or y to trust · n or Esc to quit"); y trusts.
  ["grok-trust", /Do you trust the contents of this directory\? Grok Build may run or modify contents in this directory, ?posing security risks\.[\s\S]*y Yes, proceed n No, quit/i, "y"],
  // The selection cursor is "❯" in current Claude Code (">" before); Windows 11 November 2026: "❯ No, exit" went unanswered. The cursor
  // must be on "No, exit" (where Claude starts it), so Down then Enter picks "Yes, I trust this folder". A short card terminal can scroll
  // the question off the screen, so the line above the options ("Claude Code'll be able to read, edit, and execute files here.") also counts.
  // Claude Code 2.1.325 names the first option "No, continue without these permissions" instead when the folder's settings pre-approve
  // tools, add directories or start MCP servers; the cursor still starts on it.
  ["claude-trust", /(Is this a project you created or one you trust\?|Claude Code['’]ll be able to read, edit, and execute files here\.)[\s\S]*[>❯] No, (exit|continue without these permissions) Yes, I trust this folder/i, "\u001b[B\r"],
  // Dialog text and cursor start read from Claude Code CLI 2.1.325's own code: imports start on "No", MCP on "Continue without", so
  // Up, Up picks "Use this MCP server" (this server only, not all future ones).
  // The option lines alone: a short card terminal (31x13, linux 14 November 2026) had scrolled both titles off and neither was answered.
  ["claude-imports", /[>❯] No, disable external imports Yes, allow external imports/i, "\u001b[B\r"],
  ["claude-mcp", /Use this MCP server Use this and all future MCP servers in this project [>❯] Continue without using this MCP server/i, "\u001b[A\u001b[A\r"],
  // agy preselects "Yes, I trust this folder", but a card terminal too short for its screen (30x13, linux 6 November 2026) cuts the
  // options off, so its own question is enough.
  ["trust", /Do you trust the contents of this project\? (Antigravity CLI requires permission|[\s\S]*[>❯] Yes, I trust this folder)/i, "\r"],
  ["codex-hooks", /Hooks need review[\s\S]*2\. Trust all and continue/i, "2\r"],
  ["codex-trust", /Do you trust the contents of this directory\?[\s\S]*1\. Yes, continue/i, "1\r"],
  ["codex-update", /Update available[\s\S]*Skip until next version/i, "2\r"],
  // Codex 0.167.2 words its folder trust "Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.
  // …", option "Trust and continue" (then "Open restricted", "Quit"). The pattern needs the number drawn beside it, so the key is that number;
  // a quote or comma right after the label is source text (a diff), not the list.
  ["codex-trust-folder", /Trust this folder\? Codex can read, edit, and run files here[\s\S]*1\. Trust and continue(?!["'`,])/i, "1\r"],
  // Codex 0.167.2, before its screen starts: "Codex rebuilt its local database." … "Continuing startup with a fresh local database..."
  // then "Press Enter to continue."; only Enter goes on.
  ["codex-db-rebuilt", /Codex rebuilt its local database\.[\s\S]*Continuing startup with a fresh local database\.\.\. Press Enter to continue\./i, "\r"],
  // Codex 0.167.2, during a run: "Approaching rate limits", "Switch to <model> for lower credit usage?", options "Switch to <model>",
  // "Keep current model", "Keep current model (never show again)". The drawn "2." picks "Keep current model", which keeps the card's
  // model and leaves the reminder setting as it was.
  ["codex-rate-limit", /Approaching rate limits[\s\S]*for lower credit usage\?[\s\S]*2\. Keep current model(?! ?\(never|["'`,])/i, "2\r"],
];
/** Battle cards (F89): a selection prompt no row answers that stays this long on the screen becomes one "Waiting at:" card event. */
const WAITING_MS = 30_000;
const CURSOR = /^[>❯›] +\S/;
const RULE = /^[─━═╌╍┄┅—_\-]+$/;
/**
 * A selection prompt on a card screen (F89 battle cards): the question (a line with "?") and the lines below it down to the end of the
 * option list, joined with " / ", or undefined. An option line starts with the cursor glyph or "1."; the question is at most six lines
 * above it, with no rule line between (so a question in the agent's reply above Claude's or Codex's input box is not one).
 */
export function waitingPrompt(screen: string): string | undefined {
  const lines = screen.split("\n").map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!CURSOR.test(lines[i]) && !/^1\.\s+\S/.test(lines[i])) continue;
    let q = -1;
    for (let j = i - 1; j >= Math.max(0, i - 6) && !RULE.test(lines[j]); j--) if (lines[j].includes("?")) { q = j; break; }
    if (q < 0) continue;
    let end = i;
    while (end + 1 < lines.length && lines[end + 1]) end++;
    const block = lines.slice(q, end + 1).filter(Boolean).slice(0, 12).join(" / ");
    return block.length > 400 ? `${block.slice(0, 399)}…` : block;
  }
  return undefined;
}
const GROK_TRUST = "Do you trust the contents of this directory?";
/**
 * Grok's folder trust cut off by a narrow card terminal (F89; Grok 1.0.77 recorded at 32 columns, 1.0.92 at 32 and 41): the question cut
 * before its "?" at the left edge ("Do you trust the contents of thi"), at most six lines above "Yes, proceed   y" directly over "No, quit
 * n", then only blank lines to Grok's version footer, the last line on the screen. waitingPrompt does not see it (no "?", no cursor), so
 * this returns it joined like waitingPrompt's. autoAnswer types "y" at it once, as the grok-trust-cut row (F105, 25 November 2026: a Grok
 * battle card sat there and never ran its task), and makes one "Waiting at:" event if it is still there 30 s later; any other cut
 * screen only gets the "Waiting at:" event. visible: the terminal's rows as
 * shown, without scrollback, so a dialog scrolled away is not taken for one waiting.
 */
export function grokTrustWaiting(visible: string): string | undefined {
  const rows = visible.split("\n").map((l) => l.trimEnd());
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  if (!/^Grok Build +\d+(\.\d+)+( \[[a-z]+\])?$/.test(rows.pop()?.trim() ?? "")) return undefined;
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  const n = rows.length;
  if (n < 3 || !/^Yes, proceed +y$/.test(rows[n - 2].trim()) || !/^No, quit +n$/.test(rows[n - 1].trim())) return undefined;
  for (let q = n - 3; q >= Math.max(0, n - 9); q--) {
    if (rows[q].length >= 25 && rows[q].length < GROK_TRUST.length && GROK_TRUST.startsWith(rows[q])) return `${rows[q]} / Yes, proceed y / No, quit n`;
  }
  return undefined;
}
/** Lines of scrollback the headless screen keeps for a parent's `board.js screen` (F89). */
const SCREEN_SCROLLBACK = 1000;
/** Rows a card terminal opens with. Twice the old 24, so the default length is 100% longer (the user, 25 November 2026). */
const OPEN_ROWS = 48;

/**
 * Keys a parent card may send with `board.js type --key` (F89), as the bytes a terminal sends for them. Text goes separately and cannot
 * carry control characters, so these are the only way to send Escape, Ctrl+C or arrows.
 */
export const TERMINAL_KEYS: Record<string, string> = {
  enter: "\r", escape: "\u001b", tab: "\t", "shift-tab": "\u001b[Z", backspace: "\u007f", up: "\u001b[A", down: "\u001b[B", right: "\u001b[C", left: "\u001b[D",
  "ctrl-c": "\u0003", "ctrl-d": "\u0004", "ctrl-l": "\u000c", "ctrl-u": "\u0015", "ctrl-o": "\u000f", "ctrl-r": "\u0012", "ctrl-t": "\u0014",
};

/**
 * The part of vscode.Terminal the board uses (send, show, dispose, process id, exit), for a Claude or Codex session that runs in its
 * card's terminal instead of a VS Code terminal (F89). The board keeps it in the same map as its VS Code terminals, so Start, Resume,
 * follow-ups, Stop and the start warning work unchanged.
 */
export class CardSessionTerminal {
  exitStatus: { code: number | undefined; reason: number } | undefined;
  readonly processId: Promise<number | undefined>;
  constructor(readonly name: string, readonly id: string, readonly generation: string, pid: number, private readonly terms: CardTerminals,
    private readonly reveal: (focus: boolean) => void) { this.processId = Promise.resolve(pid); }
  sendText(text: string, addNewLine = true) { if (!this.exitStatus) this.terms.write(this.id, addNewLine ? `${text}\r` : text, this.generation); }
  show(preserveFocus?: boolean) { this.reveal(!preserveFocus); }
  hide() { /* the card terminal stays on its card */ }
  dispose() { this.terms.stop(this.id, this.generation); }
}

/**
 * Antigravity's terminal takes the card's model and effort as flags (F88, antigravityArgs). Grok's takes the model as an exact id
 * (--model, grokArgs; since 17 November 2026: the card's model, or the default `grok models` names) and starts on the agent's own
 * effort. When a Grok card names an effort, the terminal says so; it applies to the card's ACP runs (unattended runs and follow-ups).
 */
export function terminalModelNotice(task: { provider?: string; model?: string; effort?: string }): string | undefined {
  if (task.provider !== "grok" || !task.effort) return undefined;
  return `Entomatical: this Grok terminal uses the agent's default effort. The card's choice (effort ${task.effort}) applies to its unattended runs and follow-ups.`;
}
/** Whether the provider's argv fits the OS: Windows' 32,767-character command line (node-pty quotes each argument and may escape
 * every " or \, so those count twice), or Linux's 128 KiB per argument (MAX_ARG_STRLEN, NUL included). */
export function argvFits(file: string, args: string[], platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return [file, ...args].reduce((n, a) => n + a.length + (a.match(/["\\]/g)?.length ?? 0) + 3, 0) <= 32767;
  return args.every((a) => Buffer.byteLength(a) < 128 * 1024);
}
/** Direct PTYs: the terminal stream is private to the owning board and is never interpreted as completion. */
export class CardTerminals {
  private readonly entries = new Map<string, Entry>();
  private readonly retiring = new Map<string, Entry>(); // forgotten by card ID, owned by generation until the PTY exits
  private readonly dataListeners = new Set<Listener<CardTerminalData>>();
  private readonly stateListeners = new Set<Listener<CardTerminalState>>();
  private readonly inputListeners = new Set<Listener<{ id: string; enter: boolean }>>();
  private readonly waitingListeners = new Set<Listener<{ id: string; lines: string }>>();
  /** Whether a card is a Battle Royale card (Task.battle): its terminal answers past 60 s, again on a dialog's return, and reports waits. */
  /** A card nobody sits at (a battle's, an orchestrator's, one a run opened): its start-up watch has no 60 s limit. Set by the board. */
  isUnattended: (id: string) => boolean = () => false;
  /** Whether a card runs a strict capability profile (strict-claude.ts): its Claude project-MCP question is answered "Continue without". */
  isStrict: (id: string) => boolean = () => false;
  constructor(private readonly allowed: (id: string) => boolean, private readonly spawn: Spawn = ptySpawn,
    private readonly headless: (cols: number, rows: number) => HeadlessTerminal | undefined = (cols, rows) =>
      new (require("@xterm/headless").Terminal)({ cols, rows, scrollback: SCREEN_SCROLLBACK, allowProposedApi: true }),
    private readonly treeKill?: TreeKill) {}

  onData(listener: Listener<CardTerminalData>) { this.dataListeners.add(listener); return { dispose: () => this.dataListeners.delete(listener) }; }
  onState(listener: Listener<CardTerminalState>) { this.stateListeners.add(listener); return { dispose: () => this.stateListeners.delete(listener) }; }
  /** the user typed in a card terminal (keys or a paste in the board's webview), not the board or a parent card (F89). enter: he pressed Enter (outside a paste). */
  onUserInput(listener: Listener<{ id: string; enter: boolean }>) { this.inputListeners.add(listener); return { dispose: () => this.inputListeners.delete(listener) }; }
  /** A battle card's terminal has shown the same unanswered selection prompt for 30 s (F89): its question and option lines. */
  onWaiting(listener: Listener<{ id: string; lines: string }>) { this.waitingListeners.add(listener); return { dispose: () => this.waitingListeners.delete(listener) }; }
  private emitState(state: CardTerminalState) { for (const listener of this.stateListeners) listener({ ...state }); }
  // Right after a window reload the new window owns the board only once its first takeover tick succeeds (up to 15 s while the
  // old extension host's heartbeat is fresh). The webview attaches again on its next render, so this is a wait, not a loss.
  private check(id: string) { if (!this.allowed(id)) throw new Error(NOT_RUNNING_BOARD); }
  has(id: string) { return !!this.entries.get(id) && this.entries.get(id)!.state.state !== "exited"; }
  /** When a live card terminal last printed anything: the card's own activity signal, whatever provider or hooks it has (F80 Quiet). */
  lastOutputAt(id: string): number | undefined { const e = this.entries.get(id); return e?.state.state === "running" ? e.outputAt : undefined; }
  attach(id: string): CardTerminalSnapshot | undefined {
    this.check(id);
    const entry = this.entries.get(id);
    return entry && { ...entry.state, snapshot: entry.output };
  }
  start(request: { id: string; provider: AcpProvider; cwd: string; configDir?: string; prompt: string; env?: Record<string, string>; notice?: string; model?: string; effort?: string; permission?: string }): CardTerminalState {
    const { id, provider, cwd, configDir, prompt, env, notice } = request;
    this.check(id);
    if (this.has(id)) throw new Error("A terminal is already running on this card.");
    if (!path.isAbsolute(cwd)) throw new Error("The task must have an absolute working directory.");
    if (typeof prompt !== "string" || !prompt.trim() || prompt.includes("\0")) throw new Error("The initial terminal prompt must not be empty or contain NUL.");
    if (provider !== "grok" && provider !== "antigravity") throw new Error("Interactive card terminals support Grok and Antigravity only.");
    const command = acpCommand(provider, configDir);
    // Discard ambient controller identity before installing the board-issued task environment.
    for (const key of Object.keys(command.env)) if (["ENTOMATICAL_SESSION", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID"].includes(key.toUpperCase())) delete command.env[key];
    Object.assign(command.env, env);
    // No shell command: execute the provider directly, passing the prompt as a single argv value.
    const file = command.file === "cmd.exe" ? (provider === "grok" ? "grok.exe" : "agy.exe") : command.file;
    // The card's choices go in as fixed flags before the prompt (grokArgs and antigravityArgs refuse any other value): Grok's model and
    // permission mode, and Antigravity's model, effort and permission. A model is only ever an exact id (the user, 17 November 2026): the
    // board resolves it first (Board.startCardTerminal), and a short name or alias reaching here is refused.
    if (request.model) exactModel(provider, request.model);
    const args = provider === "grok" ? [...grokArgs(request), "--", prompt] : [...antigravityArgs(request), `--prompt-interactive=${prompt}`];
    // An orchestrator's brief alone is over 9,000 characters (F89), so only the OS's own argv limit applies.
    if (!argvFits(file, args)) throw new Error("The initial terminal prompt is too long for this system's command line (Windows: 32,767 characters in all; Linux: 128 KiB).");
    const { pid: _pid, ...state } = this.open(id, file, args, cwd, command.env, provider);
    // A board notice (not the provider's output) shown first in the terminal and kept in its replay.
    const entry = this.entries.get(id);
    if (notice && entry) {
      const text = `\u001b[2m${notice}\u001b[0m\r\n`;
      entry.output = (text + entry.output).slice(-REPLAY_LIMIT);
      for (const listener of this.dataListeners) listener({ id, generation: state.generation, data: text });
    }
    return state;
  }
  /**
   * A Claude or Codex session in its card's terminal (F89): the board builds the exact command and environment it gives a VS Code
   * terminal (the task's account, hooks file and ENTOMATICAL_* identity), so nothing is stripped here.
   */
  spawnCommand(request: { id: string; file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }): CardTerminalState & { pid: number } {
    this.check(request.id);
    if (this.has(request.id)) throw new Error("A terminal is already running on this card.");
    if (!path.isAbsolute(request.cwd)) throw new Error("The task must have an absolute working directory.");
    return this.open(request.id, request.file, request.args, request.cwd, request.env);
  }
  private open(id: string, file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, provider?: AcpProvider): CardTerminalState & { pid: number } {
    const state: CardTerminalState = { id, generation: randomUUID(), state: "running", cols: 80, rows: OPEN_ROWS };
    const process = this.spawn(file, args, { cwd, env: colorEnv(env), name: "xterm-256color", cols: state.cols, rows: state.rows });
    let screen: HeadlessTerminal | undefined;
    try { screen = this.headless(state.cols, state.rows); } catch { screen = undefined; } // no screen for a parent; the terminal itself still works
    // Tests replace spawn with stand-ins whose pids are not theirs to end, so only node-pty's own processes get taskkill by default.
    const entry: Entry = { state, process, provider, output: "", screen, started: Date.now(), treeKill: this.treeKill ?? (this.spawn === ptySpawn ? taskkillTree : undefined) };
    this.entries.get(id)?.screen?.dispose();
    this.entries.set(id, entry);
    process.onData((data) => {
      if (this.entries.get(id) !== entry || state.state === "exited") return;
      if (!this.allowed(id)) { this.end(entry); return; }
      entry.output = (entry.output + data).slice(-REPLAY_LIMIT);
      entry.outputAt = Date.now();
      entry.screen?.write(data);
      this.autoAnswer(entry);
      for (const listener of this.dataListeners) listener({ id, generation: state.generation, data });
    });
    process.onExit(({ exitCode }) => {
      if (state.state === "exited") return;
      const retired = this.retiring.delete(state.generation);
      if (!retired && this.entries.get(id) !== entry) return;
      state.state = "exited"; state.exitCode = exitCode;
      // Pinned node-pty beta leaves its Windows ConPTY worker alive on natural exit. Dispose
      // only that worker: calling kill() after exit can enumerate and signal a reused PID.
      if (globalThis.process.platform === "win32") {
        const internal = process as WindowsPty;
        try { internal._agent?._conoutSocketWorker?.dispose(); } catch { /* already disposed */ }
      }
      this.emitState(state);
    });
    this.emitState(state);
    return { ...state, pid: process.pid };
  }
  /**
   * the user, 6 November 2026: start-up checks are answered yes automatically, for every provider (folder trust, Bypass consent, Codex's
   * update offer is skipped). Each check is answered once per terminal, 400 ms after its screen settles, and only in the terminal's
   * first 60 s. Different checks can follow one another (Codex's update offer, then its folder trust), so one answer does not end it.
   * An unattended card (isUnattended: a battle's, an orchestrator's, one a run opened) answers for as long as its terminal runs, and
   * answers a check again after it left the screen and came back.
   * The starter (the user, 18 November 2026): while a terminal is answered for, a selection prompt no row answers is watched too, on every
   * card terminal (watchWaiting), so a start that hangs on a question says so on its card.
   */
  private autoAnswer(entry: Entry) {
    const e = entry as Entry & { answerTimer?: NodeJS.Timeout; answered?: Set<string> };
    // Battle cards (the user, 14 November 2026: "runs autonomously without needing any user input") have no 60 s limit.
    const battle = this.isUnattended(e.state.id);
    const late = () => !battle && Date.now() - e.started >= AUTO_ANSWER_MS;
    if (!e.screen || late()) return;
    clearTimeout(e.answerTimer);
    e.answerTimer = setTimeout(() => {
      if (this.entries.get(e.state.id) !== e || e.state.state !== "running" || late()) return;
      let lines: string;
      let visible: string;
      try { lines = this.screen(e.state.id, e.state.rows)?.text ?? ""; visible = this.visible(e); } catch { return; } // the board went to another window
      const text = lines.replace(/\s+/g, " ");
      const answered = (e.answered ??= new Set());
      // Grok's trust cut off by a narrow terminal is matched on the visible rows (grokTrustWaiting), not the text; "y" trusts.
      const rows: [string, boolean, string][] = [...AUTO_ANSWERS.map(([key, pattern, reply]): [string, boolean, string] => [key, pattern.test(text), reply]),
        ["grok-trust-cut", grokTrustWaiting(visible) !== undefined, "y"]];
      // A battle card answers a dialog again once it has left the screen and come back.
      if (battle) for (const [key, shown] of rows) if (answered.has(key) && !shown) answered.delete(key);
      let matched: string | undefined;
      for (const [key, shown, reply] of rows) {
        if (!shown) continue;
        matched = key;
        if (answered.has(key)) continue;
        answered.add(key);
        // A strict card gets only its profile's MCP servers (passed with --mcp-config, never asked about): Enter keeps the cursor's
        // "Continue without using this MCP server".
        const keys = key === "claude-mcp" && this.isStrict(e.state.id) ? "\r" : reply;
        try { e.process.write(keys); } catch { /* ended */ }
        break;
      }
      // Grok's cut trust still on the visible rows 30 s after its "y" (the key did not take) becomes one Waiting event.
      this.watchWaiting(e, matched === "grok-trust-cut" ? grokTrustWaiting(visible) : matched ? undefined : this.waitingBlock(e, lines, visible));
    }, 400);
  }
  /**
   * F89: a selection prompt no row matches that stays on the screen for 30 s becomes one "Waiting at: …" card event (through onWaiting),
   * so a missed dialog is seen and can become a row. Nothing is typed. An unattended card for as long as it runs; any other card
   * terminal for a prompt first seen in its first 60 s (autoAnswer calls this only then).
   */
  private watchWaiting(entry: Entry, block: string | undefined) {
    const e = entry as Entry & { waitTimer?: NodeJS.Timeout; waitBlock?: string; waited?: Set<string> };
    if (block === e.waitBlock) return; // the same prompt: its 30 s run on
    clearTimeout(e.waitTimer);
    e.waitTimer = undefined; e.waitBlock = block;
    if (!block || e.waited?.has(block)) return;
    e.waitTimer = setTimeout(() => {
      e.waitTimer = undefined;
      if (this.entries.get(e.state.id) !== e || e.state.state !== "running" || e.waitBlock !== block) return;
      let lines: string;
      let visible: string;
      try { lines = this.screen(e.state.id, e.state.rows)?.text ?? ""; visible = this.visible(e); } catch { return; }
      if (this.waitingBlock(e, lines, visible) !== block || AUTO_ANSWERS.some(([, pattern]) => pattern.test(lines.replace(/\s+/g, " ")))) return;
      (e.waited ??= new Set()).add(block);
      for (const listener of this.waitingListeners) listener({ id: e.state.id, lines: block });
    }, WAITING_MS);
    e.waitTimer.unref?.();
  }
  private waitingBlock(e: Entry, lines: string, visible: string): string | undefined {
    // agy's first-run picker has a label rather than a question. Report only its visible welcome screen.
    if (e.provider === "antigravity" && /^ *Welcome to Antigravity CLI! *\n(?: *\n)* *Choose your color scheme: *(?:$|[╭┌─])/m.test(visible)) return "Choose your color scheme:";
    return waitingPrompt(lines) ?? grokTrustWaiting(visible);
  }
  /** The rows a card terminal shows now, without scrollback. */
  private visible(e: Entry): string {
    const b = e.screen?.buffer.active;
    return b ? Array.from({ length: e.state.rows }, (_, i) => b.getLine(b.baseY + i)?.translateToString(true) ?? "").join("\n") : "";
  }
  /** Input from the board's webview. user: false marks bytes xterm sent by itself (replies to the program's terminal queries). */
  input(id: string, generation: string, data: string, user = true) {
    const entry = this.running(id, generation);
    if (typeof data !== "string" || data.length > INPUT_LIMIT) throw new Error("Terminal input is too large.");
    entry.process.write(data);
    const enter = data.replace(/\u001b\[200~[\s\S]*?\u001b\[201~/g, "").includes("\r");
    if (user) for (const listener of this.inputListeners) listener({ id, enter });
  }
  /** Input from the board itself (a prompt, a follow-up) or a parent card (F89): never reported as the user's. */
  write(id: string, data: string, generation?: string) {
    this.check(id);
    const entry = this.entries.get(id);
    if (!entry || entry.state.state !== "running" || (generation !== undefined && entry.state.generation !== generation)) throw new Error("That terminal has ended or been replaced.");
    if (typeof data !== "string" || data.length > INPUT_LIMIT) throw new Error("Terminal input is too large.");
    entry.process.write(data);
  }
  /**
   * What the card's terminal shows, as plain text (F89, `board.js screen`): the last `lines` lines of the headless screen, scrollback
   * included, with trailing blank lines dropped. Undefined when the card has no terminal.
   */
  screen(id: string, lines = 60): { text: string; state: TerminalState; cols: number; rows: number } | undefined {
    this.check(id);
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const buffer = entry.screen?.buffer.active;
    const all: string[] = [];
    if (buffer) for (let i = 0; i < buffer.length; i++) all.push(buffer.getLine(i)?.translateToString(true) ?? "");
    else all.push(...entry.output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g, "").split(/\r?\n/));
    while (all.length && !all[all.length - 1].trim()) all.pop();
    const n = Math.max(1, Math.min(500, Math.floor(lines)));
    return { text: all.slice(-n).join("\n"), state: entry.state.state, cols: entry.state.cols, rows: entry.state.rows };
  }
  resize(id: string, generation: string, cols: number, rows: number) {
    const entry = this.running(id, generation);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 2 || rows > 500) throw new Error("Invalid terminal size.");
    if (entry.state.cols === cols && entry.state.rows === rows) return;
    entry.process.resize(cols, rows);
    entry.screen?.resize(cols, rows);
    entry.state.cols = cols; entry.state.rows = rows;
  }
  private running(id: string, generation: string) {
    this.check(id);
    const entry = this.entries.get(id);
    if (!entry || entry.state.state !== "running" || entry.state.generation !== generation) throw new Error("That terminal has ended or been replaced.");
    return entry;
  }
  stop(id: string, generation?: string) {
    this.check(id);
    const entry = this.entries.get(id);
    if (!entry || entry.state.state === "exited") return;
    if (generation !== undefined && entry.state.generation !== generation) throw new Error("That terminal has been replaced.");
    this.end(entry);
  }
  /**
   * On Windows node-pty's kill() ends only the processes attached to the pseudo-console. Claude starts its tool shells with consoles of
   * their own, so a ping run by its PowerShell tool lived on after Stop (F89, 11 November 2026). The whole tree ends first, while the
   * root is still running so taskkill can find its children; kill() follows only if taskkill could not end it. After a natural exit
   * nothing is signalled (see open()). Linux keeps kill() (SIGHUP to the session leader).
   */
  private end(entry: Entry) {
    if (entry.state.state !== "running") return;
    entry.state.state = "stopping";
    try {
      if (globalThis.process.platform === "win32" && windowsPtyExited(entry.process)) return;
      if (globalThis.process.platform === "win32" && entry.treeKill && entry.process.pid > 0) {
        let settled = false;
        entry.treeKill(entry.process.pid, (error) => {
          if (settled) return;
          settled = true;
          if (error && entry.state.state !== "exited" && !windowsPtyExited(entry.process)) try { entry.process.kill(); } catch { /* already gone */ }
        });
      } else entry.process.kill();
    } finally { if (entry.state.state === "stopping") this.emitState(entry.state); }
  }
  /** Drop the visible terminal immediately. Its own exit callback releases the retiring process. */
  forget(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (entry.state.state !== "exited") {
      entry.state.retired = true;
      this.retiring.set(entry.state.generation, entry);
    }
    try { this.end(entry); }
    finally {
      entry.screen?.dispose();
      entry.screen = undefined;
      entry.output = "";
    }
  }
  shutdown() { for (const entry of this.entries.values()) this.end(entry); }
  dispose() { for (const id of this.entries.keys()) this.forget(id); this.dataListeners.clear(); this.stateListeners.clear(); this.inputListeners.clear(); this.waitingListeners.clear(); }
}
