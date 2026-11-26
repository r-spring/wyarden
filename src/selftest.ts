import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Board, HookEvent, Status, accounts, isCardTerminal, paste, terminalName } from "./board";
import { listProcesses } from "./arena";
import { approveCodex, codexAccounts, codexArgs, codexBinary, codexCommand, codexModels, codexWsl, pendingApprovals } from "./codex";
import { git } from "./git";
import { TEMP_MARKER } from "./workspace";

// The native checks use real sessions. See docs/development.md for the disposable workspace and marker format.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const real = fs.realpathSync.native;
const isFile = (p: string) => fs.lstatSync(p, { throwIfNoEntry: false })?.isFile() === true;
const isDir = (p: string) => fs.lstatSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
const commitId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const triggerLifetimeMs = 15 * 60_000;

/** Both effective URLs must name the fixture's own bare origin, including when Git has push URLs or URL rewrites. */
async function finishOrigin(cwd: string, origin: string): Promise<string> {
  if (!isDir(origin) || real(origin) !== origin) throw new Error("Finish self-test requires its sibling origin.git");
  const url = await git(cwd, ["config", "--get", "remote.origin.url"]);
  if (!path.isAbsolute(url) || real(url) !== origin ||
      await git(cwd, ["remote", "get-url", "--all", "origin"]) !== url ||
      await git(cwd, ["remote", "get-url", "--push", "--all", "origin"]) !== url) {
    throw new Error("Finish self-test requires exactly one local fetch and push destination");
  }
  const [gitDir, commonDir, bare, main] = (await git(origin, ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir", "--is-bare-repository", "refs/heads/main^{commit}"])).split(/\r?\n/);
  if (bare !== "true" || real(gitDir) !== origin || real(commonDir) !== origin || !commitId.test(main)) {
    throw new Error("Finish self-test requires a standalone bare origin with main");
  }
  return url;
}

async function requireFinishFixture(repo: string, origin: string): Promise<string> {
  if (await git(repo, ["symbolic-ref", "HEAD"]) !== "refs/heads/main" ||
      await git(repo, ["config", "--get", "branch.main.remote"]) !== "origin" ||
      await git(repo, ["config", "--get", "branch.main.merge"]) !== "refs/heads/main") {
    throw new Error("Finish self-test requires main tracking origin/main");
  }
  return finishOrigin(repo, origin);
}

type SelfTests = {
  selftest: (board: Board) => Promise<void>;
  "selftest-panel": (board: Board) => Promise<void>;
  "selftest-codex": (board: Board) => Promise<void>;
  "selftest-finish": (board: Board, origin: string, account: string) => Promise<void>;
};

/** Called from Development/Test activation. An old, copied or mismatched marker stays intact. */
export async function runSelfTests(board: Board, tests: SelfTests): Promise<void> {
  let repo: string, origin: string, head: string;
  try {
    const { workspaceFile, workspaceFolders } = vscode.workspace;
    if (workspaceFile?.scheme !== "file" || workspaceFolders?.length !== 1 || workspaceFolders[0].uri.scheme !== "file") return;
    repo = real(board.repo);
    const fixture = path.dirname(repo);
    const workspace = path.join(fixture, "fixture.code-workspace");
    const data = path.join(repo, ".entomatical"), dotGit = path.join(repo, ".git");
    if (repo !== path.join(fixture, "repo") || real(workspaceFolders[0].uri.fsPath) !== repo ||
        !isFile(workspace) || real(workspaceFile.fsPath) !== workspace ||
        !isFile(path.join(path.dirname(fixture), TEMP_MARKER)) ||
        !isDir(board.dir) || real(board.dir) !== data || !isDir(dotGit)) return;
    if (!Object.keys(tests).some((name) => isFile(path.join(data, name)))) return;
    const [top, gitDir, commonDir, sha] = (await git(repo, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "HEAD"])).split(/\r?\n/);
    if (real(top) !== repo || real(gitDir) !== dotGit || real(commonDir) !== dotGit || !commitId.test(sha)) return;
    head = sha;
    origin = path.join(fixture, "origin.git");
  } catch { return; }

  await Promise.all((Object.keys(tests) as (keyof SelfTests)[]).map(async (name) => {
    const trigger = path.join(board.dir, name);
    let account = "";
    try {
      if (!isFile(trigger)) return;
      const text = fs.readFileSync(trigger, "utf8");
      const marker = JSON.parse(text);
      if (marker?.test !== name || marker.repo !== repo || marker.head !== head) return;
      const age = Date.now() - marker.armedAt;
      if (!Number.isSafeInteger(marker.armedAt) || age < 0 || age > triggerLifetimeMs) return;
      if (name === "selftest-finish") {
        if (marker.account !== undefined && typeof marker.account !== "string") return;
        account = marker.account?.trim() ?? "";
        await requireFinishFixture(repo, origin);
        if (!isFile(trigger) || fs.readFileSync(trigger, "utf8") !== text) return;
      }
      fs.unlinkSync(trigger);
    } catch { return; }
    if (name === "selftest-finish") await tests[name](board, origin, account);
    else await tests[name](board);
  }));
}

interface Proc {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
}

/** The process listing Battle Royale's sweep uses (src/arena.ts): CIM on Windows, /proc on Linux. */
async function processes(): Promise<Proc[]> {
  return (await listProcesses()).map((p) => ({ ProcessId: p.pid, ParentProcessId: p.ppid, Name: p.name }));
}

function tree(all: Proc[], root: number): Proc[] {
  const out = all.filter((p) => p.ProcessId === root);
  for (let i = 0; i < out.length; i++) out.push(...all.filter((p) => p.ParentProcessId === out[i].ProcessId));
  return out;
}

function lastAssistant(stop: HookEvent | undefined): string | undefined {
  if (typeof stop?.last_assistant_message === "string") return stop.last_assistant_message;
  if (typeof stop?.transcript_path !== "string") return undefined;
  const lines = fs.readFileSync(stop.transcript_path, "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = JSON.parse(lines[i]);
    const text = e.type === "assistant" && e.message?.content?.find?.((c: { type: string }) => c.type === "text")?.text;
    if (text) return text;
  }
  return undefined;
}

/**
 * Panel check: needs the Claude Code extension in an Extension Development Host. Turns the panel wrapper on.
 * Results: <repo>/.entomatical/selftest-panel-result.jsonl.
 */
export async function panelTest(board: Board) {
  const out = path.join(board.dir, "selftest-panel-result.jsonl");
  const log = (step: string, data: object) => fs.appendFileSync(out, JSON.stringify({ step, at: new Date().toISOString(), ...data }) + "\n");
  await sleep(20_000); // a window with many extensions restarts its extension host soon after start
  const pick = (e: HookEvent | undefined) => e && { source: e.source, cwd: e.cwd, transcript: e.transcript_path };
  const until = async (ok: () => boolean, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end && !ok(); ) await sleep(1000);
    return ok();
  };
  log("begin", {});
  try {
    await vscode.commands.executeCommand("entomatical.usePanel");
    log("wrapper", { setting: vscode.workspace.getConfiguration("claudeCode").get("claudeProcessWrapper") });

    // Per account: Start sends the prompt by itself, closing the panel ends the session, Open resumes it.
    for (const account of [accounts().find((a) => a.configDir), accounts().find((a) => !a.configDir && !a.provider)]) {
      if (!account) continue;
      const task = board.add(`panel ${account.name}`, "Reply with just the word KIWI.", account.name);
      const alive = () => !!task.sessionId && board.external.has(task.sessionId);
      await board.startInPanel(task);
      const started = board.events(task.id).find((e) => e.hook_event_name === "SessionStart");
      const replied = await board.waitForEvent(task.id, "Stop", 0, 120_000);
      log("start-in-panel", { account: account.name, inWorktree: started?.cwd === task.worktree, promptSent: !!replied, answer: replied?.last_assistant_message, ...pick(started) });

      const closedAt = Date.now();
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      const ended = await until(() => !alive(), 60_000);
      log("close-panel", { ended, seconds: Math.round((Date.now() - closedAt) / 1000) });

      const n = board.events(task.id).length;
      await board.openInPanel(task);
      const resumed = await board.waitForEvent(task.id, "SessionStart", n, 60_000);
      log("open-resumes", { account: account.name, sameSession: resumed?.session_id === task.sessionId, inWorktree: resumed?.cwd === task.worktree, ...pick(resumed) });
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      await until(() => !alive(), 60_000);
    }

    // A plain panel must still start through the wrapper, untouched.
    const ids = new Set(board.external.keys());
    await vscode.commands.executeCommand("claude-vscode.editor.open");
    await sleep(10_000);
    const plain = [...board.external.values()].find((s) => !ids.has(s.sessionId));
    log("plain-panel", { started: !!plain, cwd: plain?.cwd, account: plain?.account ?? "~/.claude" });
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  } catch (e) {
    log("error", { message: e instanceof Error ? e.stack : String(e) });
  }
  log("end", {});
}

/**
 * Live check of the card's Finish button with a real Claude session. The disposable repo needs a sibling bare origin and a
 * .claude/settings.json that lets sessions edit and run commands. The task session leaves an uncommitted edit to a.txt and stays
 * open; meanwhile another clone pushes a conflicting edit of a.txt to origin. Finish must close the session's tab, wait for its
 * process to end, commit, merge origin's latest (a headless Claude run resolves the conflict), push, bring local main up to date
 * from origin and delete the worktree. Results: <repo>/.entomatical/selftest-finish-result.jsonl.
 */
export async function finishTest(board: Board, origin: string, wanted: string) {
  // Account discovery finishes shortly after activation.
  for (const end = Date.now() + 60_000; !accounts().length && Date.now() < end; ) await sleep(1000);
  const signedIn = accounts();
  const account = (wanted
    ? signedIn.find((a) => path.basename(a.configDir || "").toLowerCase() === wanted.toLowerCase())
    : signedIn[0])?.name;
  if (!account) throw new Error(wanted ? `Finish self-test account folder is unavailable: ${wanted}` : "Finish self-test requires a signed-in account");
  const out = path.join(board.dir, "selftest-finish-result.jsonl");
  const log = (step: string, data: object = {}) => fs.appendFileSync(out, JSON.stringify({ step, at: new Date().toISOString(), ...data }) + "\n");
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "(missing)");
  log("begin", { account });
  try {
    const task = board.add("finish selftest", "Append a new last line containing exactly TASK-LINE to a.txt. Do not commit. Then reply DONE.", account);
    // start() waits for SessionStart, which comes only after the new worktree's trust prompt is answered, so the answer is armed
    // when the terminal opens, and sent only if the session has still not started (an Up and Enter in a ready CLI would resend history).
    const opened = vscode.window.onDidOpenTerminal((t) => {
      if (!t.name.includes(task.id)) return;
      opened.dispose();
      setTimeout(() => { if (!board.events(task.id).some((e) => e.hook_event_name === "SessionStart")) t.sendText("\u001b[A\r", false); }, 15_000);
    });
    const term = await board.start(task).finally(() => opened.dispose());
    if (!term) throw new Error("the task session did not start in a terminal");
    const stop = await board.waitForEvent(task.id, "Stop", 0, 300_000);
    log("task-edited", { stopped: !!stop, aTxt: read(path.join(task.worktree!, "a.txt")) });
    if (!stop) throw new Error(`the task session did not finish its turn: ${board.events(task.id).map((e) => `${e.hook_event_name}${e.tool_name ? `(${e.tool_name})` : ""}`).join(", ")}`);

    // Someone else pushes a conflicting edit of a.txt to origin.
    const url = await requireFinishFixture(board.repo, origin);
    const other = path.join(board.dir, "selftest-other-clone");
    fs.rmSync(other, { recursive: true, force: true });
    await git(board.dir, ["clone", "-q", "-b", "main", "--", url, other]);
    fs.appendFileSync(path.join(other, "a.txt"), "REMOTE-LINE\n");
    await git(other, ["-c", "user.name=selftest", "-c", "user.email=selftest@example.invalid", "commit", "-qam", "Remote edit"]);
    await finishOrigin(other, origin);
    await git(other, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    log("remote-edited", { originA: await git(other, ["show", "HEAD:a.txt"]) });

    const steps: string[] = [];
    let notes: false | string[] = false;
    try {
      await requireFinishFixture(board.repo, origin);
      await finishOrigin(task.worktree!, origin);
      notes = await board.complete(task, async (p, related) => {
        log("plan", { plan: { ...p, related: related.map((t) => t.id) } });
        return p?.target === "main" && p.remote === "origin" && p.remoteBranch === "main";
      },
        (s) => { steps.push(s); log("step", { step: s }); }, undefined, undefined,
        { beforePush: async (worktree) => { await requireFinishFixture(board.repo, origin); await finishOrigin(worktree, origin); } });
      log("finished", { ok: notes !== false, notes });
    } catch (e) {
      log("finished", { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    log("result", { steps, terminalClosed: !board.terminal(task), cardStatus: task.status, worktreeExists: !!task.worktree && fs.existsSync(task.worktree),
      originA: await git(board.repo, ["show", "origin/main:a.txt"]).catch((e) => `(${e.message})`), mainA: read(path.join(board.repo, "a.txt")),
      mainIsOrigin: (await git(board.repo, ["rev-parse", "HEAD"])) === (await git(board.repo, ["rev-parse", "origin/main"]).catch(() => "")),
      mainLog: await git(board.repo, ["log", "--oneline", "-6"]), mainStatus: await git(board.repo, ["status", "--porcelain"]) });
    try { fs.rmSync(other, { recursive: true, force: true }); } catch { /* git's read-only pack files: EPERM on Windows; the folder is gitignored */ }
  } catch (e) {
    log("error", { message: e instanceof Error ? e.stack : String(e) });
  }
  log("end");
  await vscode.commands.executeCommand("workbench.action.closeWindow");
}

export async function selfTest(board: Board) {
  const out = path.join(board.dir, "selftest-result.jsonl");
  const log = (step: string, data: object) =>
    fs.appendFileSync(out, JSON.stringify({ step, at: new Date().toISOString(), ...data }) + "\n");
  const names = (from: number) => board.events(task.id).slice(from).map((e) => e.hook_event_name);
  const prompt = "Line one: reply with the word KIWI.\nLine two: also include the word LIME.";
  const task = board.add("selftest", prompt);
  const notes: string[] = [];
  const sub = board.onStatus((e) => notes.push(`${e.from}>${e.to}`));
  log("begin", { task: task.id });
  try {
    await vscode.commands.executeCommand("entomatical.board.focus");
    // Start, worktree, multi-line first prompt.
    // A new worktree gets Claude's folder trust prompt. Answer it (Up to "Yes", Enter): this is a throwaway test folder.
    setTimeout(() => {
      if (board.events(task.id).length) return;
      log("trust-prompt-answered", {});
      vscode.window.terminals.find((t) => isCardTerminal(t.name, task))?.sendText("\u001b[A\r", false);
    }, 15_000);
    setTimeout(() => board.events(task.id).length || log("not-ready-after-60s", { worktree: task.worktree }), 60_000);
    const term = (await board.start(task))!; // a Claude task always gets a terminal
    const submit = await board.waitForEvent(task.id, "UserPromptSubmit", 0, 30_000);
    log("first-prompt", { worktree: task.worktree, arrived: submit?.prompt, exact: submit?.prompt === prompt });
    const stop1 = await board.waitForEvent(task.id, "Stop", 0, 120_000);
    log("first-answer", { status: task.status, answer: lastAssistant(stop1), events: names(0), transitions: notes });

    // Check 5: follow-up sent while the session is busy.
    let n = board.events(task.id).length;
    board.send(task, "Write a 250-word story about a fox. Do not use any tools.");
    await board.waitForEvent(task.id, "UserPromptSubmit", n, 30_000);
    await sleep(3000);
    const busy = task.status;
    board.send(task, "Then reply with only the word MANGO.");
    let stop2: HookEvent | undefined;
    for (const end = Date.now() + 180_000; Date.now() < end; await sleep(1000)) {
      const ev = board.events(task.id).slice(n);
      const lastSubmit = ev.map((e) => e.hook_event_name).lastIndexOf("UserPromptSubmit");
      const submits = ev.filter((e) => e.hook_event_name === "UserPromptSubmit").length;
      stop2 = ev.slice(lastSubmit).find((e) => e.hook_event_name === "Stop");
      if (submits >= 2 && stop2) break;
    }
    const prompts = board.events(task.id).slice(n).filter((e) => e.hook_event_name === "UserPromptSubmit").map((e) => e.prompt);
    log("busy-follow-up", { statusWhenSent: busy, prompts, events: names(n), answer: lastAssistant(stop2) });

    // Check 2: does dispose end claude and its children?
    const pid = (await term.processId)!;
    const before = tree(await processes(), pid);
    term.dispose();
    await sleep(5000);
    const after = await processes();
    const alive = before.filter((p) => after.some((a) => a.ProcessId === p.ProcessId && a.Name === p.Name));
    log("stop", { pid, before: before.map((p) => `${p.ProcessId} ${p.Name}`), alive: alive.map((p) => `${p.ProcessId} ${p.Name}`) });

    // Check 6 in a terminal: resume keeps the conversation.
    n = board.events(task.id).length;
    const term2 = (await board.resume(task))!;
    const started = await board.waitForEvent(task.id, "SessionStart", n, 60_000);
    log("resume-start", { ok: !!started, source: started?.source, sameSession: started?.session_id === task.sessionId, exit: term2.exitStatus });
    if (!started) throw new Error("resume did not start");
    await sleep(1500);
    board.send(task, "Which words did you reply with in your very first answer? Reply with just those words.");
    const stop3 = await board.waitForEvent(task.id, "Stop", n, 120_000);
    log("resume-answer", { answer: lastAssistant(stop3) });
    term2.dispose();

    // Checks 3b and 4: statusLine from a --settings file, and whether rate_limits reaches it.
    const dir = path.join(board.dir, "selftest-statusline");
    fs.mkdirSync(dir, { recursive: true });
    const statusFile = path.join(dir, "status.jsonl").replace(/\\/g, "/");
    const settings = path.join(dir, "settings.json");
    fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: `node "${board.hookScript.replace(/\\/g, "/")}" "${statusFile}"` } }));
    const term3 = vscode.window.createTerminal({ name: "AB selftest statusline", shellPath: "claude", shellArgs: ["--settings", settings], cwd: task.worktree });
    await sleep(20_000);
    term3.sendText(paste("Reply with the word OK."), false);
    await sleep(30_000);
    term3.dispose();
    const lines = fs.existsSync(statusFile) ? fs.readFileSync(statusFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    const withLimits = lines.filter((l) => l.rate_limits);
    log("statusline", { calls: lines.length, withRateLimits: withLimits.length, rateLimits: withLimits.at(-1)?.rate_limits, keys: Object.keys(lines.at(-1) ?? {}) });
  } catch (e) {
    log("error", { message: e instanceof Error ? e.stack : String(e) });
  }
  sub.dispose();
  log("end", {});
  await vscode.commands.executeCommand("workbench.action.closeWindow");
}

/**
 * The approval check's prompt, for a Codex in a read-only sandbox. Windows: `touch` there is Git's touch.exe, which crashes inside
 * Codex's Windows sandbox ("CreateFileMapping … Win32 error 5"); Codex did not take that for the sandbox, replied that the command
 * had failed and never asked for approval (31 October 2026, codex-cli 0.164.0-alpha.11.1, gpt-6-luna low). So on Windows it is
 * PowerShell's own command, and the prompt asks for approval outright.
 */
export function approvalPrompt(platform: NodeJS.Platform = process.platform): string {
  // Both prompts ask for the approval outright: told only to run the command, gpt-6-luna in WSL ran it, had the read-only sandbox refuse
  // it, and replied that the folder is read-only without asking (2 November 2026, twice; it had asked the day before).
  if (platform !== "win32") return "Run the shell command `touch approval-selftest.txt` in the current folder. The sandbox is read-only, so request approval to run it outside the sandbox. Then reply DONE.";
  return "Run the shell command `New-Item -ItemType File approval-selftest.txt` in the current folder. The sandbox is read-only, so request approval to run it outside the sandbox. Then reply DONE.";
}

/**
 * Answers Codex's approval prompt with "y". Codex runs the PermissionRequest hook before it draws the prompt, so the card shows Needs
 * input while keys still go to Codex's message box: on Windows a "y" sent at once was typed there and the prompt kept waiting
 * (31 October 2026, codex-cli 0.164.0-alpha.11.1). There the answer waits two seconds.
 */
export async function answerApproval(term: Pick<vscode.Terminal, "sendText">, platform: NodeJS.Platform = process.platform) {
  if (platform === "win32") await sleep(2000);
  term.sendText("y", false);
}

/**
 * Codex in a real VS Code terminal, driven through the board (Linux; the Codex event contract).
 * Results go to <repo>/.entomatical/selftest-codex-result.jsonl. It makes about six small Codex turns on the smallest model.
 */
/** A terminal running `codex <args>` the way the board starts one: through wsl.exe in WSL mode (F61), else the binary itself. */
function codexTerminal(name: string, cwd: string, events: string, args: string[]): vscode.Terminal {
  const run = codexCommand(args, cwd, { ...process.env, ENTOMATICAL_EVENTS: events });
  const term = vscode.window.createTerminal({ name, shellPath: run.file, shellArgs: run.args, cwd,
    env: { ENTOMATICAL_EVENTS: run.env.ENTOMATICAL_EVENTS, ...(run.env.WSLENV !== undefined ? { WSLENV: run.env.WSLENV } : {}) } });
  term.show(true); // as the board shows its terminals; a hidden wsl.exe terminal sat for 2 minutes without starting (2 November 2026)
  return term;
}

export async function codexSelfTest(board: Board) {
  const out = path.join(board.dir, "selftest-codex-result.jsonl");
  const log = (step: string, data: object) => fs.appendFileSync(out, JSON.stringify({ step, at: new Date().toISOString(), ...data }) + "\n");
  const until = async (ok: () => unknown, ms: number) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (ok()) return true; return false; };
  const notes: string[] = [];
  const sub = board.onStatus((e) => notes.push(`${e.task.id}:${e.from}>${e.to}`));
  // These checks drive the terminal flow (follow-ups, Esc, resume in a terminal), whatever entomatical.codexStart says.
  const editorMode = board.codexEditor;
  board.codexEditor = () => false;
  try {
    await until(() => codexAccounts().length, 60_000);
    const account = codexAccounts()[0]?.name;
    if (!account) throw new Error("no signed-in Codex account");
    const model = codexModels().find((m) => m.model.includes("luna")) ?? codexModels()[0];
    // Exact ids only (17 November 2026): every codex run below gets -m with a listed id, so a Codex that lists none stops the self-test.
    if (!model) throw new Error("the signed-in Codex CLI lists no models, so the self-test has no exact model id to run");
    const effort = model?.efforts.includes("low") ? "low" : undefined;
    log("begin", { binary: codexBinary(), wsl: codexWsl()?.distro, account, model: model?.model, effort });
    const task = board.add("codex selftest", "Reply with the single word KIWI.", account, undefined, model?.model, effort);
    const statusAt = (s: Status) => until(() => task.status === s, 120_000);
    // Starting a self-test approves Entomatical's own hook and trusts its repo, as the Approve button would; other unapproved hooks stay off.
    await board.ensureWorktree(task);
    const pending = await pendingApprovals(task.worktree!);
    await approveCodex(pending);
    const after = await pendingApprovals(task.worktree!);
    log("hook-approval", { approved: pending.hooks.length, folder: pending.folder, folderUnknown: pending.folderUnknown, stillPending: after.hooks.length, folderStillUntrusted: !!after.folder });
    const term = (await board.start(task))!;
    const started = await board.waitForEvent(task.id, "SessionStart", 0, 60_000);
    const done1 = await statusAt("review");
    log("first-turn", { started: !!started, sessionIsThread: task.sessionId === started?.session_id, review: done1, reply: board.lastReply(task),
      prompts: board.prompts(task), transcript: board.transcriptOf(task), events: board.events(task.id).map((e) => e.hook_event_name) });
    // An approval: the owner's Codex runs with danger-full-access and never asks, so this one task gets a read-only sandbox, launched
    // here under the board's terminal name with the board's own hooks. The card must show Needs input and refuse a follow-up meanwhile.
    // Codex in WSL runs bash, so it gets the Linux prompt (on 2 November 2026 it had no New-Item).
    const gate = board.add("codex approval selftest", approvalPrompt(codexWsl() ? "linux" : process.platform), account, undefined, model?.model, effort);
    await board.ensureWorktree(gate);
    const gateTerm = codexTerminal(terminalName(gate), gate.worktree!, board.eventsFile(gate.id), ["-s", "read-only", ...codexArgs({ model: model?.model, effort, prompt: gate.prompt })]);
    const waiting = await until(() => gate.status === "needs-input", 120_000);
    let refused = false;
    try { board.send(gate, "this must be refused"); } catch { refused = true; }
    log("approval", { needsInput: waiting, followUpRefused: refused, events: board.events(gate.id).map((e) => e.hook_event_name) });
    if (waiting) await answerApproval(gateTerm);
    const approved = await until(() => gate.status === "review", 120_000);
    log("approved", { review: approved, fileMade: fs.existsSync(path.join(gate.worktree!, "approval-selftest.txt")), reply: board.lastReply(gate) });
    gateTerm.dispose();
    // Esc during a turn: Codex's Interrupt hook moves the card to Review.
    board.send(task, "Run the shell command `sleep 60` and then reply DONE.");
    await until(() => board.events(task.id).some((e) => e.hook_event_name === "PostToolUse" || e.hook_event_name === "PermissionRequest") || task.status === "running", 60_000);
    await sleep(4000);
    const before = task.status;
    term.sendText("\u001b", false);
    const interrupted = await until(() => board.events(task.id).some((e) => e.hook_event_name === "Interrupt"), 30_000);
    log("interrupt", { statusBefore: before, interruptHook: interrupted, status: task.status });
    // A spawned agent shows in the card's subagent list.
    board.send(task, "Use your spawn_agent tool to start one sub-agent whose task is to reply with the single word OK, wait for its answer, then reply DONE.");
    await sleep(2000);
    await statusAt("review");
    const agents = board.subagentsOf(task);
    log("subagent", { count: agents.length, agents: agents.map((a) => ({ type: a.type, done: a.done, model: a.model, lifecycle: a.lifecycle })) });
    const m = board.metrics.session(task);
    log("measurement", { source: m.source, complete: m.complete, tokens: m.tokens, total: m.total, models: Object.keys(m.models), gaps: m.gaps });
    // Stop, then resume the same thread: it remembers the first answer.
    const thread = task.sessionId;
    term.dispose();
    await sleep(3000);
    const n = board.events(task.id).length;
    const resumed = await board.resume(task);
    resumed?.show(true); // as the board's Resume button does (extension.ts)
    // Codex runs no SessionStart hook when it resumes; it comes (source "resume") with the first prompt of the resumed session
    // (the Codex event contract; seen again 2 November 2026 in WSL, codex-cli 0.166.0). So the follow-up goes
    // once the terminal has had time to come up, and the resume is up when that SessionStart answers it. A terminal stuck on a
    // Codex screen (folder trust) sends nothing, and the step times out.
    await sleep(8000);
    board.send(task, "Which single word did you reply with in your very first answer? Reply with just that word.");
    const back = await board.waitForEvent(task.id, "SessionStart", n, 120_000);
    log("resume-start", { ok: !!back, source: back?.source, sameThread: back?.session_id === thread, exit: resumed?.exitStatus, events: board.events(task.id).slice(n).map((e) => e.hook_event_name) });
    const stop = await board.waitForEvent(task.id, "Stop", n, 120_000);
    log("resume", { sameThread: stop?.session_id === thread, answer: stop?.last_assistant_message });
    board.terminal(task)?.dispose();
    // A Codex session started outside the board, in a board worktree, becomes a found card; closing it moves the card to Done.
    const found = codexTerminal("selftest codex found", task.worktree!, path.join(board.dir, "selftest-found.jsonl"), codexArgs({ model: model?.model, effort, prompt: "Reply with the single word PLUM." }));
    const earlier = new Set(board.tasks.map((t) => t.id)); // a found card from an earlier run does not count
    const card = () => board.tasks.find((t) => t.adopted && t.provider === "codex" && !earlier.has(t.id));
    const adopted = await until(card, 90_000);
    log("found", { adopted, card: card() && { status: card()!.status, prompt: card()!.prompt, worktree: card()!.worktree, account: card()!.account } });
    found.dispose();
    const ended = await until(() => card()?.status === "done", 40_000);
    log("found-closed", { done: ended, ended: card()?.ended });
  } catch (e) {
    log("error", { message: e instanceof Error ? e.stack : String(e) });
  }
  board.codexEditor = editorMode;
  log("transitions", { notes });
  sub.dispose();
  log("end", {});
  await vscode.commands.executeCommand("workbench.action.closeWindow");
}
