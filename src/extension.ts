import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { Board, Task, accounts, paste } from "./board";
import { measuresText } from "./run-record";
import { BOARD_CSP } from "./cardTerminal";
import { git } from "./git";
import { RemoteRefused, cleanupStatus, confirmationFor, type EffectConfirmation, landedWhere, readinessText, refusalPrompt, statusPath, vaultHelperMissing, vaultQuestionText, vaultStatus, type Authorization, type Readiness, type VaultQuestion } from "./finish";
import { activeConfigDir, accountRows, externalProviderAccounts, addAccount, pickAccount, useAccount, initAccounts, disposeAccounts, logIn, logOut, removeAccount, onAccountsChanged, rescan, codexLogIn, codexLogOut, addGrokAccount, grokLogIn, openGrok, removeGrokAccount, addAntigravityAccount, antigravityLogIn, antigravityLoginId, openAntigravity, hideAntigravityAccount } from "./accounts";
import { restoreClaudeModels, syncModels } from "./model-sync";
import type { ModelProvider } from "./models";
import { CODEX_HOOK, WSL_NOT_ANSWERING, awaitCodexWsl, bundledCodex, codexAccounts, codexChoice, codexCommand, codexModels, codexTextPath, codexVersion, codexWsl, findCodexWsl, findCodexWslLater, hookConfig, placeCodexHook, setCodexBinary, toCodexPath, useCodexWsl } from "./codex";
import { codexSelfTest, finishTest, panelTest, runSelfTests, selfTest } from "./selftest";
import { DEFAULT_DIR, otherAccountDirs, sameFolder, transitionNote, sessionTitle } from "./sessions";
import { checkWorkspace, setWorkspaceRepo, unmovedDataFolder } from "./workspace";
import { completionRule, generateText, helperPolicy, renameSavedSession, reviewRules, withRule } from "./text-actions";
import { refinementContext } from "./refine-context";
import { HelperTabs, helperTitle, improveView, refineView, reviewView, usageNote, type HelperKind } from "./helper-tab";
import { recordDecision } from "./helper-receipt";
import { canReview, cardWork, FINISH_REVIEW_INTERRUPTED, findingsText, gatherWork, isTop, recoverReview, REVIEW_INTERRUPTED, reviewInput, reviewMarkdown, reviewPrompt, reviewWork, reviewerModel, worktreeSnapshot, writeReview, type DoneReview } from "./done-review";
import type { TextVia } from "./worker";
import { readOnlyUri, registerReadOnlyDocs } from "./readonly-docs";
import { projectContext, projectInventory } from "./jobs";
import { lintProposal, lintText } from "./prompt-lint";
import { compileDraft, saveCandidate, loadCandidate, markCandidate, improveRequest, staleReasons, newSpec, addRevision, readSpec, recordSpec, specSummary, controlsOf } from "./compile";
import { reviewImprovements } from "./prompt-review";
import { taskCost } from "./usage-history";
import { interactive } from "./workflow";
import { dictate as dictateVoice, dictateStream, type Voice } from "./voice";
import { migrateSpeechSettings, registerSpeechSettings, setSpeechProvider, setWhisperModel, speechOptions, speechSnapshot } from "./speech-settings";
import { Ledger } from "./ledger";
import { cardSummary as efficiencySummary, modelEfficiency } from "./efficiency";
import { watchReloadRequests } from "./reload-request";
import { quietStartup } from "./startup";
import { toStart, waitReason } from "./queue";
import { asanaSnapshot, commentOnFinish, linkAsana, pickAsanaLink, registerAsana } from "./asana-board";
import type { AsanaSelection } from "./asana-board";
import { appendOnFinish, contextSource, linkObsidian, obsidianSnapshot, pickObsidianLink, registerObsidian } from "./obsidian-board";
import { limitToCatalogue, readCatalogue } from "./checks";
import { battleRun, capsFrom, masterPrompt } from "./orchestrator";
import { autoFinish } from "./auto-finish";
import { ensureOperatorToken } from "./operator";
import { hostClock } from "./local-time";
import { describePlanFile, findPlanFiles, loadPlanFile, planPreview, planningPrompt, type FoundPlan } from "./plan";
import { applyPlanSetup } from "./plan-setup";
import { detectHandoff, handoffDir, handoffPrompt, listHandoffs } from "./handoffs";
import { CLAUDE_FAMILIES, claudeModelId, modelLabel, newestOf, parseModel, shortNames, tryResolve } from "./models";
import { battleFallbackTitle, battleLineup, battlePrompt, contestantsFrom, inCardTerminal } from "./battle";
import { arenaBoards, arenaCards, arenaRuns, callOff, endProcesses, leftovers, listProcesses, stopArena, sweepArena, warnArena, type Stopped, type Warned } from "./arena";
import { PICKS_KEY, cleanPick, readPicks, type ActionKey, type ActionPicks } from "./action-picks";
import { antigravityChoices } from "./acp";
import { PROFILE_FILE, catalog as profileCatalog, pin as pinProfile } from "./profiles";
import { COUNCIL_FILE, councilCatalog, pinCouncil } from "./council";
import { logFile, logInterrupted, setSink, startRun, summary, wasLogged, type RunLog } from "./error-log";
import { HeadlessActivity } from "./headless-activity";
// The board's own quota rules (media/usage.js, shipped in the package), so the Switch account list reads a reset or old reading the same way.
const { usageLine } = require(path.join(__dirname, "..", "media", "usage.js")) as { usageLine: (usage: unknown, now?: number, plan?: string) => string };

async function showTakeoverRequest(board: Board, task: Task, by: Task) {
  if (!task.takeoverAsk || task.takeoverAsk.by !== by.id) return;
  const id = task.id, shown = { ...task.takeoverAsk };
  const pick = await vscode.window.showWarningMessage(`Entomatical: "${by.title}" (${shown.by}) asks to take over "${task.title}" (${id}): ${shown.reason}`, "Approve", "Deny", "Open");
  try {
    if (pick === "Approve") void vscode.window.showInformationMessage(`Entomatical: ${board.approveTakeover(id, shown)}`);
    else if (pick === "Deny") board.denyTakeover(id, shown);
    else if (pick === "Open") await handle(board, { type: "open", id });
  } catch (e) { void vscode.window.showErrorMessage(`Entomatical: ${e instanceof Error ? e.message : e}`); }
}

export function codexPanelStarter(hook: string): Board["startCodexPanel"] {
  return async (task, prompt, launchToken, env, policy) => {
    const codexExtension = vscode.extensions.getExtension("openai.chatgpt");
    if (!codexExtension) return undefined;
    await codexExtension.activate();
    // The loaded sidecar must enforce the sandbox and retain the launch token after turn/start acknowledgement.
    const start = "entomatical.codexPanelStartWithTokenStopV1";
    if (!(await vscode.commands.getCommands(true)).includes(start)) return undefined;
    const gitSha = await git(task.worktree!, ["rev-parse", "HEAD"]);
    return vscode.commands.executeCommand(start, {
      taskId: task.id, launchToken, cwd: toCodexPath(task.worktree!), prompt, gitSha, model: task.model, effort: task.effort,
      title: task.title, named: task.named, ...policy,
      env: { ...env, ENTOMATICAL_EVENTS: toCodexPath(env.ENTOMATICAL_EVENTS), ENTOMATICAL_REPO: toCodexPath(env.ENTOMATICAL_REPO) },
      hooks: hookConfig(hook),
    });
  };
}

const report = (p: Promise<unknown>) => p.catch((e) => vscode.window.showErrorMessage(`Entomatical: ${e instanceof Error ? e.message : String(e)}`));

export async function activate(context: vscode.ExtensionContext) {
  personalProfiles = context.globalStorageUri ? path.join(context.globalStorageUri.fsPath, PROFILE_FILE) : ""; // test hosts may omit it
  speechSecrets = context.secrets;
  extensionRoot = context.extensionPath;
  // A user settings.json VS Code cannot write (a syntax error, a read-only file) makes config.update reject. That must not stop the
  // board from registering below. The old settings stay where they are, and the migration tries again at the next activation.
  try { await migrateSpeechSettings(); }
  catch (e) { void vscode.window.showWarningMessage(`Entomatical: old speech settings were not carried forward: ${e instanceof Error ? e.message : String(e)}`); }
  registerSpeechSettings(context);
  // Before anything writes ~/.entomatical (the ledger) or opens the board: a folder still under the old name means the cutover has not run.
  const unmoved = unmovedDataFolder([os.homedir(), ...(vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").slice(0, 1).map((f) => f.uri.fsPath)]);
  if (unmoved) return void vscode.window.showErrorMessage(`Entomatical: ${unmoved} still has its old name, so the board does not start (it would be empty). Run node tools/cutover-entomatical.js, then reload the window.`);
  if (WIN) recorder = path.join(context.extensionPath, "wrapper", "entomatical-rec.exe");
  context.subscriptions.push(vscode.commands.registerCommand("entomatical.cancelDictation", () => endDictation()));
  context.subscriptions.push(vscode.commands.registerCommand("entomatical.dictateTerminal", () => report(dictateTerminal())), { dispose: endDictation });
  try { await enableTerminalDictationShortcut(); }
  catch (e) { void vscode.window.showWarningMessage(`Entomatical: F8 speech shortcut could not be enabled: ${e instanceof Error ? e.message : String(e)}`); }
  const placeFiles = placesFiles(context.extensionMode);
  const panelBridge = async (action: "install" | "remove") => {
    const codex = vscode.extensions.getExtension("openai.chatgpt");
    if (!codex) throw new Error("The Codex extension is not installed in this window.");
    const patch = require(path.join(context.extensionPath, "tools", "codex-panel-patch.cjs")) as { change: (root: string, action: string) => string };
    const message = patch.change(codex.extensionPath, action);
    const choice = await vscode.window.showInformationMessage(`Entomatical: ${message}`, "Reload Window");
    if (choice === "Reload Window") await vscode.commands.executeCommand("workbench.action.reloadWindow");
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("entomatical.enableCodexPanelBridge", () => report(panelBridge("install"))),
    vscode.commands.registerCommand("entomatical.disableCodexPanelBridge", () => report(panelBridge("remove"))),
  );
  // Codex tasks, sign-in and usage reads run entomatical.codexPath, else the binary chatgpt.cliExecutable names (so both extensions
  // share one CLI), else the installed `codex` on PATH (codexChoice in codex.ts). Never the Codex extension's bundled copy, which updates rarely.
  const codexPath = vscode.workspace.getConfiguration("entomatical").get<string>("codexPath", "").trim();
  const configured = vscode.workspace.getConfiguration("chatgpt").get<string | null>("cliExecutable")?.trim();
  const codex = codexChoice(codexPath, configured, !!vscode.workspace.getConfiguration("chatgpt").get<boolean>("runCodexInWindowsSubsystemForLinux"));
  if (codex.via === "wsl") {
    // the user, 1 November 2026: Codex runs in WSL. The Codex extension then runs it in the first Ubuntu distro with WSL's ~/.codex,
    // so Entomatical runs the `codex` on that distro's PATH and reads the same home, and Codex's editor finds Entomatical's threads.
    const found = findCodexWsl();
    if (found) useCodexWsl(found.distro, found.home);
    else waitForCodexWsl(context); // never Windows Codex instead (8 November 2026): that cannot see WSL's sessions
  } else if (codex.file) setCodexBinary(codex.file);
  // An unset or missing cliExecutable: the Codex extension runs its own copy (entomatical.codexPath does not change what it runs).
  if (codex.via !== "wsl" || codexWsl()) void noteCodexVersion(codex.via, !(configured && fs.existsSync(configured)));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (!["entomatical.codexPath", "chatgpt.cliExecutable", "chatgpt.runCodexInWindowsSubsystemForLinux"].some((k) => e.affectsConfiguration(k))) return;
    // The Codex binary is chosen once, above.
    void vscode.window.showInformationMessage("Entomatical: the Codex setting changes which Codex runs once the window reloads.", "Reload Window")
      .then((pick) => { if (pick) void vscode.commands.executeCommand("workbench.action.reloadWindow"); });
  }));
  // F84: `board.js reload-windows` reloads every installed window; dev hosts (no placeFiles) ignore it, so a check is not cut off.
  if (placeFiles) context.subscriptions.push(watchReloadRequests(Date.now(), () => void vscode.commands.executeCommand("workbench.action.reloadWindow")));
  // Every Claude API call on the machine, indexed for later study (docs/ledger.md). One window does the work; it runs without a board too.
  // Bad ledger state is set aside or waited out quietly otherwise: one warning per window says so.
  // Only installed windows place its query tool: a dev host's build would replace the one the user's windows use.
  const ledger = new Ledger(undefined, undefined, placeFiles ? context.extensionPath : undefined, (message) => void vscode.window.showWarningMessage(message));
  ledger.start();
  context.subscriptions.push(ledger);
  // Claude's stream names the 5-hour limit only now and then, so the ledger's window asks every account's CLI (no tokens used).
  context.subscriptions.push(ledger.whileOwned(15 * 60_000, () => report(rescan(true, true))));
  const repo = repoRoot();
  const board = repo ? new Board(repo, path.join(context.extensionPath, "hook", "hook.js"), placeFiles ? undefined : path.join(repo, ".entomatical", "hook-dev"), false) : undefined; // dev hosts keep their hooks in the scratch repo
  if (board) context.subscriptions.push(headlessActivity = new HeadlessActivity(board));
  // Strict-route probe (strict-claude.ts): development hosts only, read at activation (reload the window after changing it).
  if (board) board.strictProbe = context.extensionMode === vscode.ExtensionMode.Development && vscode.workspace.getConfiguration("entomatical").get<boolean>("dev.strictProbe", false) === true;
  if (board) context.subscriptions.push(board, { dispose: () => windowBoards.delete(board) });
  if (board) windowBoards.add(board); // Battle Royale's arena
  if (board) {
    const baseAccounts = board.accountList;
    Object.assign(board, { accountList: () => [...baseAccounts(), ...externalProviderAccounts()] });
    board.antigravityLoginId = antigravityLoginId;
    board.ideConfigDir = () => activeConfigDir() || DEFAULT_DIR;
    board.panelHistoryDir = panelHistoryDir;
    if (placeFiles) {
      placeCodexHook(path.join(context.extensionPath, "hook", "hook.js"));
      // The board command for sessions (F70, spec 5.2): a fixed path briefs can name on both machines, copied when it differs.
      placeCodexHook(path.join(context.extensionPath, "tools", "board.js"), path.join(os.homedir(), ".entomatical", "board.js"));
    } else board.boardCli = path.join(context.extensionPath, "tools", "board.js"); // a dev host never replaces the placed copy (F87)
    // Codex's editor needs the Codex extension; without it, Codex tasks stay in a terminal.
    board.codexEditor = () => vscode.workspace.getConfiguration("entomatical").get<string>("codexStart", "editor") === "editor" && !!vscode.extensions.getExtension("openai.chatgpt");
    board.panelHook = placeFiles ? CODEX_HOOK : board.hookScript;
    board.startCodexPanel = codexPanelStarter(board.panelHook);
    board.stopCodexPanel = async (threadId) => { await vscode.commands.executeCommand("entomatical.codexPanelStop", threadId); };
    board.cancelCodexPanelStart = async (token) => { await vscode.commands.executeCommand("entomatical.codexPanelCancelStart", token); };
    context.subscriptions.push(
      vscode.commands.registerCommand("entomatical.codexPanelPrepared", (e: { taskId: string; launchToken: string; threadId: string; transcript?: string }) =>
        board.prepareCodexPanel(e.taskId, e.launchToken, e.threadId, e.transcript)),
      vscode.commands.registerCommand("entomatical.codexPanelCanStart", (e: { taskId: string; launchToken: string; threadId: string }) =>
        board.canStartCodexPanel(e.taskId, e.launchToken, e.threadId)),
      vscode.commands.registerCommand("entomatical.codexPanelEvent", (e: { taskId: string; threadId: string; method: string; status?: unknown }) =>
        board.codexPanelEvent(e)),
    );
    // The orchestrator (F69 to F76): its settings, the brief at a fixed path, the run's notifications, and what the inbox needs from here.
    board.orchestratorEnabled = () => vscode.workspace.getConfiguration("entomatical").get<boolean>("orchestrator.enabled", true);
    board.deliverEveryTurns = () => vscode.workspace.getConfiguration("entomatical").get<number>("deliver.everyTurns", 3);
    // FR2: the vault helpers, from the user's own user settings only. A value a workspace or folder sets (a file in a repo) is not read:
    // it names a program Finish runs.
    board.vaultOf = () => vscode.workspace.getConfiguration("entomatical").inspect("finish.vaults")?.globalValue;
    board.capsOf = () => capsFrom(vscode.workspace.getConfiguration("entomatical").get("orchestrator.caps"));
    if (placeFiles) placeCodexHook(path.join(context.extensionPath, "docs", "orchestrator", "BRIEF.md"), board.briefPath); else board.briefPath = path.join(context.extensionPath, "docs", "orchestrator", "BRIEF.md");
    if (placeFiles) placeCodexHook(path.join(context.extensionPath, "docs", "orchestrator", "WATCHER.md"), board.watcherPath); else board.watcherPath = path.join(context.extensionPath, "docs", "orchestrator", "WATCHER.md");
    board.maxRunning = maxRunning;
    board.ruleWriter = (prompt, account) => prepareRule(board, prompt, account ?? "", true);
    board.doneReviewer = (task, opts) => runDoneReview(board, task, opts);
    board.reviewIsLive = id => reviews.has(id);
    const applyLimits = () => {
      const config = vscode.workspace.getConfiguration("entomatical");
      const slots = config.get<number>("workflow.localBudget", 3);
      const minutes = config.get<number>("orchestrator.claimAfterMinutes", 30);
      const graceMs = typeof minutes === "number" ? minutes * 60_000 : NaN;
      board.localBudget = Number.isSafeInteger(slots) && slots >= 0 ? slots : 3;
      board.claimGraceMs = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : 30 * 60_000;
    };
    applyLimits();
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("entomatical.workflow.localBudget") || e.affectsConfiguration("entomatical.orchestrator.claimAfterMinutes")) {
        applyLimits();
        board.refresh();
      }
    }));
    // F95 item 5: the per-machine operator token the user's terminal signs with (~/.entomatical/operator-token, mode 600).
    try { ensureOperatorToken(board.operatorTokenFile); } catch (e) { console.error("Entomatical: operator token", e); }
    context.subscriptions.push(board.onRun(async ({ kind, master, task, text, by, review }) => {
      // F95 item 3: a card asks to take another over; Approve moves it to the asker, Deny tells the asker no.
      if (kind === "takeoverAsked" && task && by) return showTakeoverRequest(board, task, by);
      // `finish self` (F97 section 9): the owner reviews and finishes the run by itself; autoFinish notifies when it ends or waits.
      if (kind === "finishReady") {
        if (board.isOwner()) setTimeout(() => void autoFinish(board, master, { review: (t, o) => board.doneReviewer!(t, o), closeTab: async (t) => { await closeClaudeTab(board, t); } }, review)
          .catch((e) => console.error("Entomatical: self-finish", e instanceof Error ? e.message : e)), 0);
        return;
      }
      // One notification per run event that matters (13.2 item 7); children's own toasts are off unless childNotifications is on.
      const message = kind === "started" ? `Run "${master.title}" started` : kind === "needsYou" ? `Run "${master.title}": ${task?.title ?? "a card"} needs you${text ? `: ${text}` : ""}`
        : kind === "finished" ? `Run "${master.title}" finished${text ? ` · ${text}` : ""}` : kind === "budget" ? `Run "${master.title}" paused: budget reached (${text ?? ""})`
        : `Run "${task?.title ?? master.title}": ${text ?? ""}`;
      const show = kind === "needsYou" || kind === "note" || kind === "budget" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      const pick = await show(`Entomatical: ${message}`, kind === "finished" ? "Open report" : "Open");
      if (pick === "Open report") await report(handle(board, { type: "report", id: master.id }));
      else if (pick === "Open") await report(handle(board, { type: "open", id: (task ?? master).id }));
    }));
    // F95: a takeover request still waiting from before this window opened gets its Approve and Deny again (the old notification is gone).
    try { board.announceTakeoverAsks(); } catch (e) { console.error("Entomatical: takeover requests", e instanceof Error ? e.message : e); }
    board.checks.onResult = (task, passed, error) => {
      const checks = passed ? "All acceptance checks passed." : `Acceptance checks failed: ${error}`;
      void reviewRule(board, task, checks);
      if (passed) return void vscode.window.showInformationMessage(`Entomatical: "${task.title}" passed its acceptance checks.`);
      const fix = task.checks?.failure ? ["Fix it"] : [];
      void vscode.window.showWarningMessage(`Entomatical: "${task.title}": ${error}`, ...fix, "Retry checks").then(async (choice) => {
        // The card as it is now: the toast can outlive a Finish, Merge, Discard or Delete, and the task object it was given.
        const now = board.get(task.id);
        try {
          if (choice === "Retry checks" && now) board.checks.retry(now);
          if (choice === "Fix it" && now) await sendOrPaste(board, now, board.fixPrompt(now));
        } catch (e) { void vscode.window.showErrorMessage(`Entomatical: ${e instanceof Error ? e.message : e}`); }
      });
    };
    // Any board change (a status, a check result, a card removed) may let a held card start.
    context.subscriptions.push(board.onChange(() => setTimeout(() => void startHeld(board), 0)));
    context.subscriptions.push(
      board.onStatus(async ({ task, from, to, quiet, error }) => {
        if (quiet) return; // the scan found the process gone (stopped, killed, VS Code closed) or the turn interrupted at the terminal: not "finished"
        if (task.openedBy && !vscode.workspace.getConfiguration("entomatical").get<boolean>("orchestrator.childNotifications", false)) return; // the run notifies instead (13.2 item 7)
        if (task.finishAsked && to === "needs-input") return; // the self-finish's own needsYou (or the checks' Fix it toast) says it; a second "needs your input" did too (5 November 2026)
        // A rule without checks gets Fable's Review look now; one with checks gets it once they finish (checks.onResult).
        if (to === "review" && task.completion?.haiku && !task.completion.commands.length && board.isOwner()) void reviewRule(board, task, "The rule used has no check commands.");
        const note = transitionNote(from, to, task.adopted, error);
        if (!note || !vscode.workspace.getConfiguration("entomatical").get<boolean>("notifications", true)) return;
        const show = note === "input" || error ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
        const pick = await show(`Entomatical: "${task.title}" ${note === "input" ? "needs your input" : error?.startsWith("Fable limit") ? error.replace("Fable limit reached", "reached its Fable limit") : error ? `stopped on an API error (${error})` : task.asks ? "asked you something" : "finished"}`, "Open");
        if (pick === "Open") await report(handle(board, { type: "open", id: task.id }));
      }),
    );
    board.begin();
    if (board.tasks.some(t => t.held)) void startHeld(board); // recover queued launches and saved retry deadlines after owner initialization
    // FR2: merged work the vault does not have is said again in the window that owns the board (the notice from its Finish is gone
    // after a reload; an upload the old window was running reads "not known" by now, from the board's first tick).
    try {
      const waiting = board.isOwner() ? board.vaultWaiting() : [];
      if (waiting.length) void vscode.window.showWarningMessage(waiting.length === 1 ? `Entomatical: "${waiting[0].title}": ${vaultStatus(waiting[0].vault!)}`
        : `Entomatical: ${waiting.length} cards are merged here and not uploaded to the vault yet.`, UPLOAD_TO_VAULT).then((pick) => (pick ? report(uploadToVault(board)) : undefined));
    } catch (e) { console.error("Entomatical: vault uploads", e instanceof Error ? e.message : e); }
    // M-02: work that landed while its worktree was kept (something was still writing there) is said again too: the message from
    // its Finish is gone after a reload, and Finish on the card is what retries the cleanup.
    try {
      const kept = board.isOwner() ? board.cleanupWaiting() : [];
      if (kept.length) void vscode.window.showWarningMessage(kept.length === 1 ? `Entomatical: "${kept[0].title}": ${cleanupStatus(kept[0].cleanup!, kept[0].worktree!)}`
        : `Entomatical: ${kept.length} cards are merged with their worktrees kept (${kept.map((t) => `"${t.title}"`).join(", ")}). Press Finish on each to retry its cleanup.`);
    } catch (e) { console.error("Entomatical: kept worktrees", e instanceof Error ? e.message : e); }
  }
  context.subscriptions.push(vscode.commands.registerCommand("entomatical.uploadVault", () =>
    board ? report(uploadToVault(board)) : void vscode.window.showWarningMessage("Entomatical: open a folder with a git repository first.")));
  startErrorLog(context, board); // F103
  const boardView = new BoardView(context.extensionUri, board);
  if (board) board.sessionsInEditor = () => boardView.hasTab();
  // A profile file created, edited or deleted shows on the form now, not at the next 15 s tick (F110 finding F1). One file each, not recursive.
  if (board?.repo) for (const f of Object.values(profileFiles(board))) {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(f)), path.basename(f)));
    context.subscriptions.push(w, w.onDidCreate(() => boardView.repost()), w.onDidChange(() => boardView.repost()), w.onDidDelete(() => boardView.repost()));
  }
  registerAsana(context, board, () => boardView.repost());
  registerObsidian(context, board, () => boardView.repost());
  for (const type of ["rename", "generateTitle", "subtask", "followUp", "switchAccount", "asana", "obsidian", "done", "reopen", "finish", "merge", "discard", "delete", "pauseRun", "resumeRun", "stopRun", "archiveRun", "makeOrchestrator"]) {
    context.subscriptions.push(vscode.commands.registerCommand(`entomatical.task.${type}`, (data: { taskId?: string } | undefined) => {
      if (!data?.taskId || !board?.get(data.taskId)) return;
      if (type === "subtask" || type === "followUp") boardView.cardAction(type, data.taskId);
      else void report(handle(board, { type, id: data.taskId }));
    }));
  }
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("entomatical.board", boardView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewPanelSerializer(BoardView.tabType, boardView),
    vscode.commands.registerCommand("entomatical.openBoardTab", () => boardView.openTab()),
    registerReadOnlyDocs(), // Show changes and Open in editor (src/readonly-docs.ts)
    // Review prompt moved out of the board's buttons (the user, 4 November 2026, Q4): the palette runs it on the new-task box, a draft
    // box's context menu on that box. The board does the rest, as the tickbox used to.
    vscode.commands.registerCommand("entomatical.reviewPrompt", (arg?: { draftTarget?: string }) =>
      boardView.cardAction("reviewPrompt", typeof arg?.draftTarget === "string" ? arg.draftTarget : "new")),
  );

  context.subscriptions.push(onAccountsChanged(() => board?.refresh()));
  initAccounts(context.globalState);
  restoreClaudeModels(context.globalState);
  context.subscriptions.push({ dispose: disposeAccounts });
  const accountStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  accountStatus.command = "entomatical.switchAccount";
  const showAccount = () => {
    const row = accountRows().find((r) => r.active);
    accountStatus.text = `$(account) Claude: ${row?.email || "Select account"}`;
    accountStatus.tooltip = "Claude IDE default for new chats. Click to choose the account; existing sessions keep theirs.";
    accountStatus.show();
  };
  context.subscriptions.push(accountStatus, onAccountsChanged(showAccount),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeCode.environmentVariables")) { showAccount(); board?.refresh(); }
    }), vscode.commands.registerCommand("entomatical.switchAccount", () => report(pickAccount())));
  showAccount();

  state = context.globalState;
  actionPicks = readPicks(state.get(PICKS_KEY));
  if (placeFiles) placeWrapper(context.extensionPath);
  else devWrapper = path.join(context.extensionPath, "wrapper", WIN ? "entomatical-claude.exe" : "entomatical-claude.js");
  const wrapper = vscode.workspace.getConfiguration("claudeCode").get<string>("claudeProcessWrapper")?.trim();
  if (wrapper && isRetiredWrapper(wrapper)) report(setPanel(true)); // a retired build had the panel on: carry on with ours
  context.subscriptions.push(
    vscode.commands.registerCommand("entomatical.usePanel", () => report(setPanel(true))),
    vscode.commands.registerCommand("entomatical.useTerminal", () => report(setPanel(false))),
  );

  context.subscriptions.push(vscode.commands.registerCommand("entomatical.login", () => report(addAccount())),
    vscode.commands.registerCommand("entomatical.loginCodex", () => report(codexLogIn())));

  void quietStartup();

  const mode = context.extensionMode;
  if (board && mode !== undefined && (mode === vscode.ExtensionMode.Development || mode === vscode.ExtensionMode.Test)) {
    void report(runSelfTests(board, { selftest: selfTest, "selftest-panel": panelTest, "selftest-codex": codexSelfTest, "selftest-finish": finishTest }));
  }
}

/** What the window still needs before the board runs (workspace.ts checkWorkspace); empty once it has a board. */
let setupMissing: string[] = [];
/** The board's folder: the saved workspace's first folder, a git repository's top folder (workspace.ts). */
function repoRoot(): string | undefined {
  const check = checkWorkspace(vscode.workspace.workspaceFile, (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath), (folder) => {
    try { return path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: folder, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim()); } catch { return undefined; }
  });
  setupMissing = check.missing;
  setWorkspaceRepo(check.repo);
  return check.repo;
}

/**
 * F103: the "Entomatical" Output channel, where each Review or Finish that did not complete gets a line (src/error-log.ts setSink), and
 * the board whose errors.jsonl "Entomatical: Open error log" opens. Made in activate(); a host without the API (tests) has none.
 */
let errorChannel: vscode.OutputChannel | undefined, errorBoardDir: string | undefined;
const SHOW_LOG = "Show log";
function showErrorLog() {
  if (errorChannel) errorChannel.show(true);
  else void openErrorLog();
}
async function openErrorLog() {
  const file = errorBoardDir ? logFile(errorBoardDir) : undefined;
  if (!file || !fs.existsSync(file)) { void vscode.window.showInformationMessage("Entomatical: no Review or Finish has failed on this board yet, so there is no error log."); return; }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), { preview: true });
}
/** The Output channel, with the log's last lines (a reload empties it) and the runs a reload cut off (logInterrupted). */
function startErrorLog(context: vscode.ExtensionContext, board: Board | undefined) {
  errorBoardDir = board?.dir;
  context.subscriptions.push(vscode.commands.registerCommand("entomatical.openErrorLog", () => openErrorLog()));
  try {
    errorChannel = vscode.window.createOutputChannel("Entomatical");
    context.subscriptions.push(errorChannel, { dispose: () => { setSink(undefined); errorChannel = undefined; } });
  } catch (e) { console.error("Entomatical: Output channel", e instanceof Error ? e.message : e); }
  if (!board) return;
  try {
    const file = logFile(board.dir);
    const earlier = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-20) : [];
    if (earlier.length) errorChannel?.appendLine(`Last ${earlier.length} entries of ${file}:`);
    for (const line of earlier) { try { errorChannel?.appendLine(summary(JSON.parse(line))); } catch { /* a cut line */ } }
  } catch (e) { console.error("Entomatical: error log", e instanceof Error ? e.message : e); }
  if (errorChannel) setSink((line) => errorChannel?.appendLine(line));
  try { logInterrupted(board.dir); } catch (e) { console.error("Entomatical: interrupted runs", e instanceof Error ? e.message : e); }
}

// One board, shown in the sidebar view and/or its own editor tab (the user, 3 Nov 2026). Each webview gets its own post loop and helpers.
/**
 * Every helper call still running, on any board, with the card whose box it works on ("new": the new-task form): deactivate() stops
 * them (F19-2 in session 3482f4's review), and so does Battle Royale's arena.
 */
const allHelpers = new Map<AbortController, string>();
const helperCard = (m: Record<string, unknown>) => (typeof m.id === "string" && m.id ? m.id : "new");
/**
 * Phase 4: the user's Finish of a governed root. Shows the readiness the board computed; anything blocking stops here. Drift and uncertain
 * operations need his acknowledgment first. Push is its own button, never implied by Merge. Returns his authorization, or false.
 */
async function governedAuthorization(r: Readiness): Promise<(Authorization & { confirmed: EffectConfirmation }) | false> {
  const blocking = r.reasons.filter((x) => x.code !== "authorization" && !x.ack);
  if (blocking.length) { await vscode.window.showErrorMessage(`Entomatical: ${readinessText({ ...r, reasons: blocking })}`, { modal: true }); return false; }
  const acks = r.reasons.filter((x) => x.ack);
  const local = confirmationFor(r), publish = confirmationFor(r, true);
  if (acks.length && await vscode.window.showWarningMessage("Acknowledge before Finish?", { modal: true, detail: acks.map((x) => `- ${x.text}`).join("\n") }, "Acknowledge") !== "Acknowledge") return false;
  const t = r.target!, merge = `Merge into ${t.ref}`, push = t.remote && t.remoteSha !== undefined ? `Merge and push to ${t.remote}` : undefined;
  // FR2: a repo with a vault is never pushed. Its upload is its own button, as push is, and the destination and its command are shown.
  const upload = t.vault ? `Merge and upload to ${t.vault.name}` : undefined;
  const detail = [`Candidate ${r.candidate} (the run branch, clean, with every member integrated and its checks passed at exactly this commit).`,
    `${t.ref} is at ${t.sha} and is fast-forwarded to the candidate; no commit, merge commit or conflict resolution is made.`,
    t.vault ? `This repo's Finish destination is ${t.vault.name}: no git remote is fetched or pushed. It is uploaded only if you choose "${upload}", by running ${t.vault.display} in a terminal, which asks for your PIN and a touch. If that does not finish, ${t.ref} stays merged here and the upload stays pending.` :
      push ? `${t.remote} is at ${t.remoteSha ?? "no existing branch"} (push destination ID ${t.pushIdentity}). It is pushed only if you choose "${push}".` :
      t.remote ? `Push to ${t.remote} is unavailable.` : `${t.ref} has no remote; nothing is pushed.`, ...r.notes.map((n) => `Note: ${n}.`)].join("\n");
  const pick = await vscode.window.showWarningMessage(`Finish governed run "${r.card}"?`, { modal: true, detail }, ...[merge, push, upload].filter((x): x is string => !!x));
  if (!pick || (pick !== merge && pick !== push && pick !== upload)) return false;
  // The upload is not a push: its confirmation is the local merge's, and the vault that was shown is checked again before the effect.
  return { by: "user", at: new Date().toISOString(), merge: true, push: !!push && pick === push, upload: !!upload && pick === upload, confirmed: pick === push ? publish : local, acks: acks.map((x) => x.ack!) };
}

const UPLOAD_TO_VAULT = "Upload to Vault";
/**
 * FR2: Upload to Vault (the command, and the button on a pending upload's notice). For work that is merged here and that the repo's
 * vault does not have: the user picks the card (`task` names it), sees the destination and the command it runs, and approves. The
 * helper then runs in a terminal of its own. What only he can settle is asked first (a setting that changed, a branch that moved, a
 * last upload nobody saw end). Nothing is merged here, and nothing is uploaded on a No.
 */
async function uploadToVault(board: Board, task?: Task): Promise<void> {
  board.mustOwn(); // before the questions
  const waiting = board.vaultWaiting();
  if (!waiting.length) { void vscode.window.showInformationMessage("Entomatical: no merged work is waiting for a vault upload."); return; }
  const card = task && waiting.includes(task) ? task : waiting.length === 1 ? waiting[0]
    : (await vscode.window.showQuickPick(waiting.map((t) => ({ label: t.title, description: t.id, detail: vaultStatus(t.vault!), task: t })), { placeHolder: "Upload which card's merged work to the vault?" }))?.task;
  const v = card?.vault;
  if (!card || !v) return;
  const dest = board.vaultDestination(); // a setting that cannot be used is the error shown
  if (!dest) throw new Error(`This repo has no vault set any more (entomatical.finish.vaults), so "${card.title}" cannot be uploaded. ${vaultStatus(v)}`);
  const missing = vaultHelperMissing(dest);
  const detail = [`"${card.title}" is merged into ${v.branch} at ${v.sha.slice(0, 7)}.`, `It is uploaded to ${dest.name} by running: ${dest.display}`,
    missing ? `That cannot run now: ${missing}.` : "The helper opens in a terminal and asks for your PIN and a touch. If it does not finish, the merge stays and the upload stays pending."];
  if ((await vscode.window.showWarningMessage(`Upload ${v.branch} to ${dest.name}?`, { modal: true, detail: detail.join("\n") }, "Upload")) !== "Upload") return;
  const ask = async (q: VaultQuestion) => { const t = vaultQuestionText(q); return (await vscode.window.showWarningMessage(t.title, { modal: true, detail: t.detail }, t.yes)) === t.yes; };
  const record = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Entomatical: vault upload of "${card.title}"` }, (progress) =>
    board.uploadVault(card, { approve: true, confirm: ask, step: (text) => progress.report({ message: text }) }));
  const text = `Entomatical: "${card.title}": ${vaultStatus(record)}`;
  if (record.state === "uploaded") void vscode.window.showInformationMessage(text);
  else if ((await vscode.window.showWarningMessage(text, UPLOAD_TO_VAULT)) === UPLOAD_TO_VAULT) await uploadToVault(board, card);
}

export function deactivate() {
  for (const c of allHelpers.keys()) c.abort(); allHelpers.clear();
  for (const c of reviews.values()) c.abort(REVIEW_INTERRUPTED);
  return endDictation();
}
// Refine draft, Improve prompt, Review prompt and Review (F97) each show in their own editor tab (src/helper-tab.ts). Made on first use;
// the board view sets the extension's folder it needs.
let helperTabs: HelperTabs | undefined, helperTabsUri: vscode.Uri | undefined;
let headlessActivity: HeadlessActivity | undefined;
const tabs = () => (helperTabs ??= new HelperTabs(helperTabsUri!));

type HelperReceipt = { kind: "improve" | "refine"; file: string };

// Refine has no saved candidate. Key its run folder by request so another view can recover the finished receipt.
const refineDir = (boardDir: string, requestId: string) =>
  path.join(boardDir, "helpers", "refine-" + crypto.createHash("sha256").update(requestId).digest("hex"));

/** Record the form text before launch templates. Only the host can supply a helper receipt. */
function recordProvenance(board: Board, m: Record<string, unknown>, task: string, receipts: Map<string, HelperReceipt>) {
  const text = m.type === "send" ? m.text : m.prompt;
  if (typeof text !== "string" || !text.trim()) return;
  const helpers = (Array.isArray(m.helpers) ? m.helpers : []).map((h) => {
    const known = receipts.get(h?.requestId);
    if (known && known.kind === h.kind) return { kind: known.kind, edited: h.edited === true, receipt: path.relative(board.dir, known.file) };
    // A restored draft carries its request ID. Improve already saves the output and its receipt under that ID.
    if (!known && h?.kind === "improve") {
      const candidate = loadCandidate(board.dir, h.requestId);
      if (candidate?.version === 1 && typeof candidate.text === "string" && typeof candidate.receipt === "string") {
        const receipt = path.normalize(candidate.receipt);
        const parts = receipt.split(path.sep);
        const inHelpers = parts.length === 3 && parts[0] === "helpers" && parts[2] === "compile-receipt.json";
        return { kind: "improve", edited: h.edited === true || candidate.text !== text,
          receipt: inHelpers && fs.existsSync(path.join(board.dir, receipt)) ? receipt : null };
      }
    }
    if (!known && h?.kind === "refine" && typeof h.requestId === "string") {
      const file = path.join(refineDir(board.dir, h.requestId), "refine-receipt.json");
      try {
        const entry = JSON.parse(fs.readFileSync(file, "utf8"));
        if (entry.kind === "refine" && entry.receiptStatus === "done" && entry.outcome === "revision")
          return { kind: "refine", edited: h.edited === true, receipt: path.relative(board.dir, file) };
      } catch { /* an older or unavailable receipt has no verifiable request link */ }
    }
    return { kind: "unknown", edited: null, receipt: null };
  });
  const line = { at: new Date().toISOString(), event: m.type === "send" ? "follow-up" : "create", task,
    promptSha256: crypto.createHash("sha256").update(text).digest("hex"), chars: text.length, source: helpers.length ? helpers.at(-1)!.kind : "raw", helpers };
  try { fs.appendFileSync(path.join(board.dir, "provenance.jsonl"), JSON.stringify(line) + "\n"); } catch { /* provenance is evidence, never a blocker */ }
}

/**
 * Runs `build` for a burst of requests at most once per `gapMs`: a request after a quiet spell builds at once, the rest of the burst
 * waits for one build at the end of the gap. While `visible()` is false a build is only noted as missed, and `shown()` runs it then.
 * `now()` builds at once, for a webview that asked (a click, a reload): it stands in for a build that was waiting.
 * The board's build reads every card's transcripts on the extension host's one thread, which Claude Code's speech-to-text shares
 * (11 November 2026: the host froze 1 to 15 s at a time, 11 to 30 times in half an hour per window, and the mic started late).
 */
function coalesce(build: () => void, gapMs: number, visible: () => boolean) {
  let last = -Infinity, timer: ReturnType<typeof setTimeout> | undefined, missed = false, building = false;
  const run = (asked = false) => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!asked && !visible()) { missed = true; return; }
    missed = false; last = Date.now(); building = true;
    try { build(); } catch (e) { console.error("Entomatical: board refresh failed", e); } finally { building = false; }
  };
  const request = () => {
    if (timer) return; // a build already waits: it shows this change too
    const wait = last + gapMs - Date.now();
    if (wait <= 0 && !building) run(); else timer = setTimeout(run, Math.max(wait, 0));
  };
  return { request, now: () => run(true), shown: () => { if (missed) request(); } };
}

class BoardView implements vscode.WebviewViewProvider, vscode.WebviewPanelSerializer {
  static readonly tabType = "entomatical.boardTab";
  private boards = 0; // numbers each board webview, so the sidebar's and the tab's new-task boxes get separate refine tabs
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private posts = new Set<{ send: (message: object) => void; visible: () => boolean }>();
  // A card's context menu came from the tab when the tab is focused, else from the sidebar.
  cardAction(type: string, id: string) { void (this.panel?.active ? this.panel.webview : this.view?.webview ?? this.panel?.webview)?.postMessage({ cardAction: { type, id } }); }
  hasTab() { return !!this.panel; }
  // Board changes, the 15 s tick and account or setting changes ask for a rebuild: a burst gets at most one per 500 ms, none while no
  // board webview is visible, and one when a board webview shows again. A webview's own message (a click, a reload) builds at once.
  private readonly refresh = coalesce(() => { const message = this.boardMessage(); for (const post of this.posts) post.send(message); }, 500,
    () => [...this.posts].some((p) => p.visible()));
  repost() { this.refresh.request(); }
  constructor(private readonly extensionUri: vscode.Uri, private readonly board: Board | undefined) {
    helperTabsUri = extensionUri;
    board?.onChange(() => this.repost()); // one subscription, not one per webview: the sidebar and the tab share each rebuild
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.onDidDispose(() => { if (this.view === view) this.view = undefined; });
    view.title = vscode.workspace.name || "Board";
    this.attach(view.webview, view);
    view.onDidChangeVisibility?.(() => { if (view.visible) this.refresh.shown(); }); // ?.: the tests' stub views have no event
  }

  openTab() {
    if (this.panel) return this.panel.reveal();
    const panel = vscode.window.createWebviewPanel(BoardView.tabType, "Entomatical", { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      { retainContextWhenHidden: true });
    this.adopt(panel);
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
    if (this.panel) return panel.dispose(); // only one board tab
    this.adopt(panel);
  }

  private adopt(panel: vscode.WebviewPanel) {
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "icon.svg");
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
    this.attach(panel.webview, panel);
    panel.onDidChangeViewState?.(() => { if (panel.visible) this.refresh.shown(); });
  }

  /** The board webview's message. A board change builds it once and sends it to every board webview (repost, audit finding 13). */
  private boardMessage() {
    const board = this.board;
    // Built first: Model efficiency (F93) groups the same measurements the cards show.
    let owner: boolean | undefined; // asked once, and only when a card could be reviewed: isOwner writes owner.json
    const cards = board ? board.tasks.map((t) => { const refusal = canReview(t, board.tasks); return { ...t, spec: undefined, specSummary: t.spec ? specSummary(t.spec) : undefined, profileBlocked: t.profile ? board.profileProblem?.(t) : undefined, governed: undefined, governedView: board.governedViewOf?.(t), prompts: board.prompts(t), subagents: board.subagentsOf(t), reply: board.lastReply(t), measurement: board.metrics.session(t), cost: taskCost(t.usageRuns), waiting: board.waitingToStart(t) || undefined, readiness: board.readinessOf(t), queueWait: queueWait(board, t),
                doing: board.doingOf(t), timeline: board.timelineOf(t), run: board.runSummaryOf(t), controllerTitle: (t.watchedBy || t.openedBy) ? board.get((t.watchedBy || t.openedBy)!)?.title : undefined,
                // F77 to F80: the ledger summary (rows stay in ledger.js), the repeated call and the last event for the Quiet chip.
                efficiency: efficiencySummary(board.efficiencyOf(t)), repeating: board.repeatingOf(t), lastEventAt: board.lastEventAt(t), resuming: resuming.has(t.id),
                runModel: board.modelOf(t), // fix 11: the id the card's short name runs now ("sol → gpt-6.1-sol")
                // F97: whether Review shows (in the window that owns the board only), and the findings as the MD file words them (board.js formats none itself).
                // reviewBlocked: why Send answers is off on an Unsure review the card cannot be reviewed again with now (it went back to Running, say).
                reviewable: !refusal && (owner ??= board.isOwner()), reviewBlocked: t.doneReview?.verdict === "unsure" ? refusal : undefined,
                reviewFindings: t.doneReview ? findingsText(t.doneReview) : undefined,
                finalReply: t.orchestrator ? board.finalReply(t) : undefined,
                notInMain: board.notInMainOf(t), // commits and uncommitted work not in the main folder yet, read by the board's tick
                // F108: countsWork, the card's line shows; delivers, the board also delivers it every few turns and at Review. ?.: the tests' stand-in boards have neither.
                countsWork: board.countsWork?.(t) || undefined, delivers: board.deliverable?.(t) || undefined,
                planReady: t.planFile && fs.existsSync(path.join(board.repo, t.planFile)) || undefined }; }) : []; // F99: Run this plan now, until it is archived or deleted
    const asana = asanaSnapshot();
    return {
      accountRows: accountRows(),
      ...hostClock(),
      autoStart: vscode.workspace.getConfiguration("entomatical").get<boolean>("autoStart", true), // off: the Haiku title tickbox has nothing to do
      activeAccount: claudeDefaultName(),
      dictation: WIN || LINUX ? "Dictate into this box using the selected speech provider" : false,
      speech: speechSnapshot(),
      dictationNeedsAccount: false,
      contextSource: contextSource(),
      asana: asana && { project: asana.project, generation: asana.generation, projectName: asana.projectName, error: asana.error, truncated: asana.truncated,
        tasks: asana.tasks.map((t) => ({ gid: t.gid, name: t.name })) },
      obsidian: obsidianSnapshot() && { folderName: path.basename(obsidianSnapshot()!.folder) || obsidianSnapshot()!.folder,
        notes: obsidianSnapshot()!.notes, truncated: obsidianSnapshot()!.truncated, error: obsidianSnapshot()!.error },
      ...(board
        ? {
            tasks: cards,
            modelEfficiency: modelEfficiency(cards), // F93: the same measurements as the cards, grouped by model
            orchestratorEnabled: board.orchestratorEnabled(),
            // Battle Royale's button shows only with its setting on: the contestants' count and whether the arena is cleared word its popup.
            battleRoyale: (({ enabled, contestants, clearArena }) => enabled ? { size: contestants.length, clearArena } : undefined)(battleSettings()),
            deliverEveryTurns: board.deliverEveryTurns(), // the card's "Not in main folder yet" mouse-over counts down to it
            archived: board.archivedRuns(), // the Done footer's Archived runs (F75)
            planningPrompt: plannerPrompt(board.repo), // Plan first's preview (F99); the webview fills {{task}} as the user types
            planningPromptCodex: plannerPrompt(board.repo, undefined, true), // the same for a Codex account (Astra at ultra effort)
            live: board.live(),
            own: board.own(),
            firstTurn: board.firstTurn(), // Codex first turns in the background: Stop only, no Open or Follow-up
            panelFirstTurn: board.panelFirstTurn(),
            accounts: board.accountList().map((a) => a.name),
            profiles: profileView(board), // phase 2: absent until a profile file exists
            councils: councilView(board), // phase 5: absent until workflows/councils.json exists
            externalProviders: Object.fromEntries(externalProviderAccounts().map((a) => [a.name, a.provider])),
            // What each Grok or Antigravity account's agent last advertised: the board has no fixed list of their models. Absent until a session of it opened.
            acpCatalogs: acpCatalogsOf(board),
            // A Codex account's model and effort menus list what the CLI offers it.
            // Every model the CLI lists, each with its name and version ("Astra 6.2") for the task and plan menus (the user, 23 November 2026).
            codex: { accounts: codexAccounts().map((a) => a.name), models: codexModels().map((m) => ({ ...m, label: modelLabel("codex", m.model) })),
              // The newest id of each name, for the helper picks (Review, Improve): one entry per name, labelled with its version.
              short: shortNames("codex", codexModels().map((m) => m.model)).map((n) => ({ ...n, label: modelLabel("codex", n.id) })) },
            // Claude's four, each with the version it runs now ("Fable 5.2").
            claudeModels: CLAUDE_FAMILIES.map((f) => [f, modelLabel("claude", claudeModelId(f))]),
            // Each account's default model by name, for "Default: Fable 5.2"; an account whose default is unknown is absent.
            defaultModels: board.defaultModels?.() ?? {},
            // F88: every model `agy models` lists for a terminal card (acp.ts antigravityChoices).
            antigravityModels: antigravityChoices(),
            // What Refine draft and Improve prompt run on for each provider (Q2: always the most capable model at its highest effort).
            helperModels: helperModels(),
            // F102: each helper button's right-click pick; an action left out runs on its defaults.
            actionPicks,
          }
        : { tasks: [], live: [], own: [], accounts: [], codex: { accounts: [], models: [] }, error: `Entomatical needs a saved workspace with a git repository folder. ${setupMissing.join(" ")} Then reload the window.` }),
    };
  }

  private attach(webview: vscode.Webview, host: { onDidDispose: vscode.Event<void>; readonly visible: boolean }) {
    const helpers = new Map<string, AbortController>();
    const receipts = new Map<string, HelperReceipt>(); // requestId -> its receipt, for Apply/Keep/Restore and provenance
    const boardKey = ++this.boards;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    const xterm = vscode.Uri.joinPath(this.extensionUri, "node_modules", "@xterm", "xterm");
    const fitAddon = vscode.Uri.joinPath(this.extensionUri, "node_modules", "@xterm", "addon-fit");
    webview.options = { enableScripts: true, localResourceRoots: [media, xterm, fitAddon] };
    // Nonce CSP pattern from salam/claudine src/providers/KanbanViewProvider.ts (commit c6cbb01d, MIT).
    const nonce = crypto.randomBytes(16).toString("hex");
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    // BOARD_CSP lets style attributes through for the card terminals' colours (cardTerminal.ts).
    webview.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${BOARD_CSP(webview.cspSource, nonce)}">
<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(xterm, "css", "xterm.css"))}">
<link rel="stylesheet" href="${uri("board.css")}"><link rel="stylesheet" href="${uri("plan-setup.css")}"></head>
<body><script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(xterm, "lib", "xterm.js"))}"></script><script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(fitAddon, "lib", "addon-fit.js"))}"></script><script nonce="${nonce}" src="${uri("card-terminal.js")}"></script><script nonce="${nonce}" src="${uri("usage.js")}"></script><script nonce="${nonce}" src="${uri("plan-graph.js")}"></script><script nonce="${nonce}" src="${uri("plan-presets.js")}"></script><script nonce="${nonce}" src="${uri("plan-setup.js")}"></script><script nonce="${nonce}" src="${uri("board.js")}"></script></body></html>`;

    const board = this.board;
    // The build reads each card's transcripts on the extension host's thread: the timer and VS Code's events go through repost's
    // coalescing; post, after this webview's own message, builds at once and sends to every board webview.
    const post = () => this.refresh.now();
    const tick = () => this.repost();
    const share = { send: (message: object) => void webview.postMessage(message), visible: () => host.visible !== false }; // unset only in the tests' stubs
    this.posts.add(share);
    host.onDidDispose(() => this.posts.delete(share));
    const usageTimer = setInterval(tick, 15_000);
    const terminals = (board as unknown as { cardTerminals?: {
      onData: (listener: (event: object) => void) => vscode.Disposable;
      onState: (listener: (event: object) => void) => vscode.Disposable;
      attach: (id: string) => object | undefined;
      input: (id: string, generation: string, data: string, user?: boolean) => void;
      resize: (id: string, generation: string, cols: number, rows: number) => void;
    } } | undefined)?.cardTerminals;
    const subs = [onAccountsChanged(tick),
      terminals?.onData((event) => void webview.postMessage({ type: "terminalData", ...event })),
      terminals?.onState((event) => void webview.postMessage({ type: "terminalState", ...event })),
      board?.onCardFocus?.((event) => void webview.postMessage({ type: "terminalFocus", ...event })),
      vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("claudeCode.environmentVariables") || e.affectsConfiguration("entomatical.speech") || e.affectsConfiguration("entomatical.autoStart") || e.affectsConfiguration("entomatical.battleRoyale")) tick(); })];
    host.onDidDispose(() => clearInterval(usageTimer));
    host.onDidDispose(() => {
      helperTabs?.releaseBoard(boardKey);
      for (const controller of helpers.values()) { controller.abort(); allHelpers.delete(controller); }
      helpers.clear();
    });
    host.onDidDispose(() => subs.forEach((s) => s?.dispose()));
    host.onDidDispose(() => endDictation(webview));
    host.onDidDispose(() => callOffArena(boardKey)); // its popup is gone with it
    let selectedPlan: SelectedPlan | undefined;
    let selectionId = "";
    let preview: { revision: number; draft: string; fingerprint: string } | undefined;
    let partialPlan: { sourceHash: string; ids: string[] } | undefined;
    let startingPlan = false;
    webview.onDidReceiveMessage(async (m) => {
      if (startingPlan && (m.type === "cancelPlan" || m.type === "runPlan" || m.type === "loadHandoff")) return;
      if (m.type === "loadHandoff") {
        // Load handoff (F101): pick a handoff doc and put its text, under a marker line naming it, in the prompt box. It starts nothing.
        if (!board) return;
        const file = await pickHandoff(board.repo);
        if (!file) return;
        let text: string;
        try { text = fs.readFileSync(file, "utf8"); }
        catch (e) { void vscode.window.showErrorMessage(`Load handoff could not read ${file}: ${(e as Error).message}`); return; }
        void webview.postMessage({ insertPrompt: handoffPrompt(file, text) });
        return;
      }
      if (m.type === "terminalAttach" || m.type === "terminalInput" || m.type === "terminalResize") {
        if (!terminals || typeof m.id !== "string" || !board?.get(m.id)) return;
        try {
          if (m.type === "terminalAttach") void webview.postMessage({ type: "terminalState", ...(terminals.attach(m.id) ?? { id: m.id, state: "unavailable" }) });
          else if (typeof m.generation === "string") {
            if (m.type === "terminalInput" && typeof m.data === "string") terminals.input(m.id, m.generation, m.data, m.user !== false); // user: false = xterm's own reply to a terminal query, not the user (F89)
            else if (m.type === "terminalResize" && Number.isInteger(m.cols) && Number.isInteger(m.rows)) terminals.resize(m.id, m.generation, m.cols, m.rows);
          }
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          if (m.type === "terminalAttach") void webview.postMessage({ type: "terminalState", id: m.id, state: "unavailable", error });
          else void vscode.window.showErrorMessage(`Entomatical terminal: ${error}`);
        }
        return;
      }
      if (m.type === "parakeetTools" || m.type === "speechSettings" || m.type === "speechLocal" || m.type === "speechKey" || m.type === "speechProvider" || m.type === "speechModel") {
        try {
          if (m.type === "speechProvider") await setSpeechProvider(m.provider);
          else if (m.type === "speechModel") await setWhisperModel(m.model);
          else await vscode.commands.executeCommand(m.type === "parakeetTools" ? "entomatical.parakeetTools" : m.type === "speechSettings" ? "entomatical.speechSettings" : m.type === "speechLocal" ? "entomatical.configureLocalSpeech" : "entomatical.setSpeechApiKey");
        } catch (e) { void vscode.window.showErrorMessage(`Entomatical: ${e instanceof Error ? e.message : String(e)}`); }
        post(); return;
      }
      if (m.type === "syncModels") {
        const provider = m.provider as ModelProvider;
        if (!["claude", "codex", "grok", "antigravity"].includes(provider)) return;
        try {
          const listed = await syncModels(provider, state);
          void vscode.window.showInformationMessage(`Entomatical: ${provider} models synced. ${listed.join("; ") || "The provider listed none."}`);
        } catch (e) { void vscode.window.showErrorMessage(`Entomatical: ${e instanceof Error ? e.message : String(e)}`); }
        board?.refresh(); post(); return;
      }
      if (m.type === "dictate") {
        if (board) await dictateDirect(board, webview, m).catch((e) => vscode.window.showErrorMessage(`Entomatical: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
      if (m.type === "ready") {
        // A reloaded webview has marked its running helpers interrupted, so their calls are stopped too (F19-3 in session 3482f4's review).
        for (const controller of helpers.values()) { controller.abort(); allHelpers.delete(controller); }
        helpers.clear();
        callOffArena(boardKey); // a reloaded webview has no Battle Royale popup open
        if (m.planSetupOpen === true) void vscode.window.showInformationMessage("Plan setup closed on reload. Use “Run a plan…” to choose the plan again.");
        return post();
      }
      if (m.type === "battlePrepare" || m.type === "battleWarn" || m.type === "battleCancel") {
        // Battle Royale's popup (src/arena.ts): an answer, if any, goes back to this webview only.
        if (!board) return;
        const answer = await arenaMessage(board, m, boardKey).catch((e) => ({ battleRefused: e instanceof Error ? e.message : String(e) }));
        if (answer) void webview.postMessage(answer);
        return post();
      }
      if (m.type === "contextSource") { await vscode.commands.executeCommand("entomatical.contextSource"); return post(); } // the board's top button
      if (m.type === "setActionPick") {
        // F102: a pick from a helper button's right-click menu is that action's default from now on, in every window of this profile.
        try {
          const { action, pick } = cleanPick(m.action, m.pick);
          const next = { ...actionPicks };
          if (pick) next[action] = pick; else delete next[action];
          actionPicks = next;
          await state?.update(PICKS_KEY, actionPicks);
        } catch (e) { void vscode.window.showErrorMessage(`Entomatical: ${e instanceof Error ? e.message : String(e)}`); }
        return post();
      }
      if (m.type === "cancelHelper") { helpers.get(m.requestId)?.abort(); return; }
      if (m.type === "showHelper") { if (typeof m.requestId === "string") helperTabs?.show(m.requestId); return; }
      if (m.type === "helperDecision") {
        const file = typeof m.requestId === "string" ? receipts.get(m.requestId)?.file : undefined;
        if (file && (m.action === "apply" || m.action === "keep" || m.action === "restore")) recordDecision(file, m.action);
        return;
      }
      if (m.type === "showDiff") {
        // VS Code's own diff editor, from two read-only untitled documents (item 2.5).
        if (typeof m.before !== "string" || typeof m.after !== "string") return;
        // Read-only documents, so closing the diff asks nothing (item 10 of session 3482f4's second review).
        await vscode.commands.executeCommand("vscode.diff", readOnlyUri("your draft.md", m.before), readOnlyUri("proposal.md", m.after),
          typeof m.title === "string" ? m.title : "Your draft ↔ proposal", { preview: true });
        return;
      }
      // the user, 4 Nov 2026: Refine draft, Improve prompt and Review prompt run visibly, each in its own editor tab beside the board, which
      // stays usable meanwhile. The tab streams each model's thinking and answer. Results still go back to the board's draft box below.
      const helperTab = (kind: HelperKind, controller: AbortController, detail: string) => {
        const target = typeof m.id === "string" && m.id ? m.id : "new";
        return tabs().start(`${boardKey}:${target}:${kind}`, {
          requestId: m.requestId, kind, target, detail, cancel: () => controller.abort(),
          title: helperTitle(kind, board?.tasks.find((t) => t.id === target)?.title),
          draft: typeof m.draft === "string" ? m.draft : "", answers: typeof m.answers === "string" ? m.answers : "" }, boardKey);
      };
      // Q2 (the user, 4 Nov 2026): helpers run on the most capable model at its highest effort; the selected account picks Claude, Codex, Grok or Antigravity.
      // A Grok or Antigravity account has no fixed most-capable model: its helpers run on that same account with the agent's default model (run 0db6d1).
      // F102: a right-click pick may name another account, and a model and effort for its provider (src/action-picks.ts).
      const policyFor = (claudeNames: string[], action: "refine" | "improve") => { try {
        return helperPolicy(pickedAccount(board, action, m.account), claudeNames, { accounts: codexAccounts().map(a => a.name), models: codexModels() }, acpHelperAccounts(board), actionPicks[action]); }
        catch (e) { return { error: e instanceof Error ? e.message : String(e) }; } };
      const detailOf = (p: ReturnType<typeof policyFor>) => ("error" in p ? String(m.account ?? "") : isAcpProvider(p.provider) ? `Uses the agent's default model · ${p.account}` : `${p.model} · ${p.effort} effort · ${p.account}`);
      if (m.type === "refine") {
        if (!board || typeof m.requestId !== "string" || helpers.has(m.requestId)) return;
        const controller = new AbortController(); helpers.set(m.requestId, controller); allHelpers.set(controller, helperCard(m));
        // Deep (Fable · max) took 259 s on a 6,000-character draft (26 Oct 2026); Cancel refinement stops it sooner.
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 600_000);
        const target = m.id || "new";
        const policy = policyFor(accounts().map(a => a.name), "refine");
        const tab = helperTab("refine", controller, detailOf(policy));
        try {
          if ("error" in policy) throw new Error(policy.error);
          const { model, effort } = policy;
          tab.line(`Model: ${policy.source}.`);
          const { configDir, via, fallback } = helperRoute(board, policy.account, policy.provider);
          const context = refinementContext(board.repo);
          tab.line(`Project context gathered (${context.length} characters).`);
          // Handoff mode (plan 70d079 step 4): a Load handoff marker, or a bare path to a docs/handoffs/*.md, becomes a task prompt for a new session.
          const boxText = typeof m.draft === "string" ? m.draft : "", handoff = detectHandoff(boxText);
          if (handoff) {
            tab.line(`Handoff detected: writing a task prompt from ${handoff.name} (${handoff.path}).`);
            void webview.postMessage({ refinementMode: { requestId: m.requestId, target, handoff: handoff.name } });
          }
          // Advisory, zero-token checks (item 3.4): shown, never applied or blocking.
          const inventory = projectInventory(board.repo), draftText = handoff ? handoff.draft : boxText;
          for (const f of lintText(handoff ? handoff.text : draftText, inventory)) tab.line(`Check the draft: ${f.message} (${f.text})`);
          const dir = refineDir(board.dir, m.requestId);
          fs.mkdirSync(path.dirname(dir), { recursive: true });
          fs.mkdirSync(dir); // a repeated request cannot overwrite an earlier run
          const result = await generateText(dir, "refine", draftText, configDir, model,
            typeof m.answers === "string" ? m.answers : "", controller.signal, effort, via, fallback, context, tab,
            executorLine(board, m), handoff ? { path: handoff.path, text: handoff.text } : undefined);
          if (result.note) { useFallbackAccount(result.configDir ?? "", configDir, result.note); tab.line(result.note); }
          if (result.receipt) receipts.set(m.requestId, { kind: "refine", file: result.receipt });
          const lint = result.value.kind === "revision" ? lintProposal(handoff ? handoff.text : draftText, result.value.revision, inventory) : [];
          const view = refineView(result.value, target);
          const used = usageNote(result.usage);
          tab.finish({ ...view, notes: [...(handoff ? [`Task prompt for a new session, from the handoff ${handoff.path}.`] : []), ...lint.map((f) => `Check: ${f.message} (${f.text})`), ...view.notes, ...(used ? [used] : [])] }, result.model);
          void webview.postMessage({ refinement: { requestId: m.requestId, target, original: m.draft, ...result.value, lint, model: result.model, effort, ...(handoff ? { handoff: handoff.name } : {}) } });
        } catch (e) {
          // The board and the tab say the same thing (F19-7 in session 3482f4's review).
          const message = timedOut ? "Stopped after ten minutes without an answer." : e instanceof Error ? e.message : String(e);
          tab.fail(message, controller.signal.aborted && !timedOut);
          void webview.postMessage({ refinement: { requestId: m.requestId, target, error: message } });
        }
        finally { clearTimeout(timer); helpers.delete(m.requestId); allHelpers.delete(controller); }
        return;
      }
      if (m.type === "compile") {
        // Same routing, helper folder, abort and timeout as refine. The compiled text goes back to the webview only; the user applies it to the task box.
        if (!board || typeof m.requestId !== "string" || helpers.has(m.requestId)) return;
        const controller = new AbortController(); helpers.set(m.requestId, controller); allHelpers.set(controller, helperCard(m));
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 600_000); // same allowance as refine: Deep compiles on Fable/max need minutes
        const target = m.id || "new";
        const policy = policyFor(accounts().filter((a) => !a.provider).map(a => a.name), "improve");
        const tab = helperTab("improve", controller, detailOf(policy));
        try {
          // the user, 3 Nov 2026: Improve also runs on a Codex account, as Refine does; since 4 Nov on the maximum policy.
          if ("error" in policy) throw new Error(policy.error);
          const { model, effort } = policy;
          tab.line(`Model: ${policy.source}.`);
          const dir = path.join(board.dir, "helpers", crypto.randomUUID());
          const { configDir, via, fallback } = helperRoute(board, policy.account, policy.provider);
          const inventory = projectInventory(board.repo); // read before the call, not after minutes of waiting
          const result = await compileDraft(dir, typeof m.draft === "string" ? m.draft : "", typeof m.answers === "string" ? m.answers : "",
            configDir, model, effort, controller.signal, fallback, via,
            { executor: executorLine(board, m), context: refinementContext(board.repo) }, tab);
          if (result.note) { useFallbackAccount(result.configDir ?? "", configDir, result.note); tab.line(result.note); }
          receipts.set(m.requestId, { kind: "improve", file: result.receipt });
          // Saved for Add task or Send to bind (phase 1): the controls are the form's for a new task, the card's own for a follow-up.
          const targetTask = typeof m.id === "string" ? board.get(m.id) : undefined, controls = controlsOf(targetTask ?? m);
          let bindable = false;
          try { bindable = !!saveCandidate(board.dir, m.requestId, target, typeof m.draft === "string" ? m.draft : "", typeof m.answers === "string" ? m.answers : "", controls, result); }
          catch (e) { tab.line(`The improved specification could not be saved, so Add task will send the text without it: ${e instanceof Error ? e.message : String(e)}`); }
          const lint = result.rendered ? lintProposal(typeof m.draft === "string" ? m.draft : "", result.rendered.text, inventory, result.record) : [];
          const improved = improveView({ ...result, lint }, target), used = usageNote(result.usage);
          tab.finish({ ...improved, notes: [...improved.notes, ...(used ? [used] : [])] }, result.model);
          void webview.postMessage({ compilation: { requestId: m.requestId, target, original: m.draft, status: result.record.status, record: result.record,
            rendered: result.rendered, conflicts: result.record.conflicts, dropped: result.dropped, sourceOnly: result.sourceOnly, quarantined: result.quarantined,
            oversize: result.oversize, lint, tally: result.tally, model: result.model, effort, promptVersion: result.promptVersion, controls, bindable } });
        } catch (e) {
          const message = timedOut ? "Stopped after ten minutes without an answer." : e instanceof Error ? e.message : String(e);
          tab.fail(message, controller.signal.aborted && !timedOut);
          void webview.postMessage({ compilation: { requestId: m.requestId, target, error: message } });
        }
        finally { clearTimeout(timer); helpers.delete(m.requestId); allHelpers.delete(controller); }
        return;
      }
      if (m.type === "reviewPrompt") {
        // Review prompt: Terra and Sol (max) each improve the draft, then Astra (ultra) reviews their attempts. The review goes back to the
        // webview only, for reading; nothing is applied to the task box.
        if (!board || typeof m.requestId !== "string" || helpers.has(m.requestId)) return;
        const controller = new AbortController(); helpers.set(m.requestId, controller); allHelpers.set(controller, helperCard(m));
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 1_800_000); // two max-effort improvements, then an ultra-effort review: tens of minutes on a long draft
        const target = m.id || "new";
        const tab = helperTab("review", controller, "Terra and Sol at max effort, then Astra at ultra effort · Codex");
        try {
          if (!codexAccounts().length) throw new Error("Review prompt needs a signed-in Codex account.");
          const result = await reviewImprovements(path.join(board.dir, "helpers", crypto.randomUUID()), typeof m.draft === "string" ? m.draft : "",
            typeof m.answers === "string" ? m.answers : "", { path: codexTextPath(), models: codexModels() }, controller.signal,
            (stage) => { tab.stage(stage); void webview.postMessage({ compilationStage: { requestId: m.requestId, target, stage } }); },
            { executor: executorLine(board, m), context: refinementContext(board.repo) }, tab.output);
          tab.finish(reviewView(result), result.review?.model);
          void webview.postMessage({ compilation: { requestId: m.requestId, target, original: m.draft, ...result } });
        } catch (e) {
          // The board and the tab say the same thing (item 3 of session 3482f4's second review).
          const message = timedOut ? "Stopped after thirty minutes without a review." : e instanceof Error ? e.message : String(e);
          tab.fail(message, controller.signal.aborted && !timedOut);
          void webview.postMessage({ compilation: { requestId: m.requestId, target, error: message } });
        }
        finally { clearTimeout(timer); helpers.delete(m.requestId); allHelpers.delete(controller); }
        return;
      }
      try {
        if (m.type === "cancelPlan") { selectedPlan = undefined; selectionId = ""; preview = undefined; return; }
        if (m.type === "runPlan") {
          const picked = await selectPlan(board, m);
          if (picked && board && (picked.raw as { v?: unknown } | null)?.v === 2) { await runGovernedPlan(board, picked); post(); return; } // F116 setup carries v1 only
          if (picked) { selectedPlan = picked; selectionId = crypto.randomUUID(); preview = undefined; void webview.postMessage({ selectedPlan: { selectionId, label: picked.label, file: picked.file.rel, raw: picked.raw } }); }
          return;
        }
        if (m.type === "getPlanPresets" || m.type === "savePlanPreset" || m.type === "renamePlanPreset" || m.type === "deletePlanPreset") {
          if (!selectedPlan || m.selectionId !== selectionId) return;
          const presets = state.get<PlanPreset[]>("planSetupPresets", []);
          if (m.type === "savePlanPreset") {
            const name = presetName(m.name);
            if (presets.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new Error("A personal preset already has that name.");
            if (presets.length >= 50) throw new Error("At most 50 personal presets can be saved.");
            presets.push({ id: crypto.randomUUID(), name, settings: cleanPlanPreset(m.settings) });
          } else if (m.type === "renamePlanPreset") {
            const entry = presets.find((p) => p.id === m.id), name = presetName(m.name);
            if (!entry) throw new Error("That preset no longer exists.");
            if (presets.some((p) => p.id !== entry.id && p.name.toLowerCase() === name.toLowerCase())) throw new Error("A personal preset already has that name.");
            entry.name = name;
          } else if (m.type === "deletePlanPreset") {
            const index = presets.findIndex((p) => p.id === m.id);
            if (index < 0) throw new Error("That preset no longer exists.");
            presets.splice(index, 1);
          }
          if (m.type !== "getPlanPresets") await state.update("planSetupPresets", presets);
          void webview.postMessage({ planPresets: { selectionId, presets } });
          return;
        }
        if (m.type === "savePlanAs") {
          if (!board || !selectedPlan || m.selectionId !== selectionId) return;
          const picked = selectedPlan, chosenId = selectionId;
          board.mustOwn();
          if (planHash(picked.file.file) !== picked.hash) throw new Error("The original plan changed. Choose it again before saving.");
          const graph = applyPlanSetup(picked.raw, { order: m.order, dependencies: m.dependencies });
          if ("errors" in graph) throw new Error(graph.errors.join("\n"));
          const checked = board.checkPlan(graph.raw, graph.vars);
          if ("errors" in checked) throw new Error(checked.errors.join("\n"));
          const uri = await vscode.window.showSaveDialog({ title: "Save as new plan", saveLabel: "Save new plan", defaultUri: vscode.Uri.file(path.join(board.repo, "workflows", "new.plan.json")), filters: { "Plan files": ["json"] } });
          if (!uri) return;
          board.mustOwn();
          if (selectedPlan !== picked || selectionId !== chosenId) throw new Error("The selected plan changed while the save dialog was open. Save it again.");
          if (planHash(picked.file.file) !== picked.hash) throw new Error("The original plan changed. Choose it again before saving.");
          const rechecked = board.checkPlan(graph.raw, graph.vars);
          if ("errors" in rechecked) throw new Error(rechecked.errors.join("\n"));
          if (!/\.json$/i.test(uri.fsPath)) throw new Error("A plan file must end in .json.");
          fs.writeFileSync(uri.fsPath, JSON.stringify(graph.raw, null, 2) + "\n", { flag: "wx" });
          void vscode.window.showInformationMessage(`Entomatical: saved new plan ${uri.fsPath}.`);
          return;
        }
        if (m.type === "previewSelectedPlan") {
          if (!board || !selectedPlan || m.selectionId !== selectionId || !Number.isSafeInteger(m.revision)) return;
          const revision = m.revision as number;
          const checked = previewSelectedPlan(board, selectedPlan, m.draft);
          preview = "errors" in checked ? undefined : { revision, draft: JSON.stringify(m.draft), fingerprint: checked.fingerprint };
          void webview.postMessage({ planValidation: { selectionId, revision, ...("errors" in checked ? { errors: checked.errors } : { errors: [], plan: checked.plan, cards: checked.cards, catalogue: checked.catalogue, judgePermission: checked.judgePermission }) } });
          return;
        }
        if (m.type === "startSelectedPlan") {
          if (startingPlan) return;
          startingPlan = true;
          try {
            if (!board || !selectedPlan) throw new Error("Choose a plan again before running it.");
            if (partialPlan?.sourceHash === selectedPlan.hash && partialPlan.ids.some((id) => board.get(id))) throw new Error(`A previous start created cards ${partialPlan.ids.join(", ")}. Inspect that run before trying again.`);
            if (m.selectionId !== selectionId || !preview || m.revision !== preview.revision || JSON.stringify(m.draft) !== preview.draft) throw new Error("The plan settings changed. Review the updated preview before running.");
            const checked = previewSelectedPlan(board, selectedPlan, m.draft);
            if ("errors" in checked) throw new Error(checked.errors.join("\n"));
            if (checked.fingerprint !== preview.fingerprint) { preview = undefined; throw new Error("The plan, accounts, checks or board state changed. Review the updated preview before running."); }
            const picked = selectedPlan;
            const before = new Set(board.tasks.map((t) => t.id));
            try {
              const { card, steps, reused } = await board.runPlan(checked.raw, picked.file.file, checked.vars, undefined, { sourceHash: picked.hash, configHash: checked.configHash });
              selectedPlan = undefined; preview = undefined;
              void webview.postMessage({ planStarted: true });
              void vscode.window.showInformationMessage(reused ? `Entomatical: using existing plan card ${card.id} (${card.title}).` : `Entomatical: "${card.title}" made ${steps.length} step card${steps.length === 1 ? "" : "s"}; ${steps.filter((t) => !!t.sessionId).length} started.`);
            } catch (e) {
              const created = board.tasks.filter((t) => !before.has(t.id));
              const root = created.find((t) => t.planRun?.sourceHash === picked.hash && t.planRun.configHash === checked.configHash);
              if (root?.planRun?.setupState === "prepared") throw new Error(`Plan ${root.id} kept its assignments. ${root.launchError ?? String(e)}`);
              const ids = root ? created.filter((t) => t.id === root.id || t.openedBy === root.id).map((t) => t.id) : [];
              if (ids.length) { partialPlan = { sourceHash: picked.hash, ids }; throw new Error(`Start did not finish; cards ${ids.join(", ")} were created. Inspect them before retrying. ${e instanceof Error ? e.message : String(e)}`); }
              throw e;
            }
          } finally { startingPlan = false; void webview.postMessage({ planReady: true }); }
        } else {
          const outcome = await handle(board, m, board ? (id) => recordProvenance(board, m, id, receipts) : undefined);
          if (m.type === "send" && outcome !== "sent") throw new Error("The follow-up card is no longer available.");
          if (m.type === "create" && m.createId) {
            if (!outcome) throw new Error("The board is unavailable.");
            void webview.postMessage({ created: m.createId, task: outcome });
          }
        }
        if (m.type === "accountUse") void webview.postMessage({ accountActionComplete: true });
        if (m.type === "send") void webview.postMessage({ sent: m.id, sendId: m.sendId });
      } catch (e) {
        void webview.postMessage({ failed: m, ...(e instanceof CreateContextError ? { createContextIssue: e.field } : {}) });
        vscode.window.showErrorMessage(`Entomatical: ${e instanceof Error ? e.message : String(e)}`);
      }
      post();
    });
  }
}

/** entomatical.maxRunning: how many cards may be in Running before held cards wait (0: no limit). Manual Start ignores it. */
const maxRunning = () => Math.max(0, vscode.workspace.getConfiguration("entomatical").get<number>("maxRunning", 0));
/** What a queued, unstarted ordinary card waits for (queue.ts), for its card. */
function queueWait(board: Board, t: import("./board").Task) {
  if (t.status !== "queued" || t.sessionId) return undefined;
  if (t.held && t.launchError) return t.startRetryAt ? "Waiting to retry the launch" : "Use Start to retry the launch";
  return t.held || t.openedBy || t.dependsOn?.length ? board.startWait(t) : undefined;
}
const dispatching = new WeakSet<Board>();
const retryTimers = new WeakMap<Board, NodeJS.Timeout>();
/** A held launch stays queued across eligibility changes. One retry is allowed for an unstarted card; another failure needs Start. */
async function startHeld(board: Board) {
  if (dispatching.has(board) || !board.isOwner()) return;
  dispatching.add(board);
  clearTimeout(retryTimers.get(board));
  let nextRetry = Infinity;
  try {
    // Check the live limits after each start. Reserving global slots for a plan step that is itself held
    // by its run's capacity would otherwise prevent an unrelated ready card from being considered.
    for (const t of toStart(board.tasks, 0)) {
      const task = board.get(t.id);
      if (!task) continue;
      const r = await board.dispatchHeld(task, () => handle(board, { type: "start", id: task.id }, undefined, true));
      if (r.state === "retry") nextRetry = Math.min(nextRetry, r.at);
      if (r.state === "failed") void vscode.window.showErrorMessage(`Entomatical: "${task.title}" could not start: ${r.error}`);
      if (r.state === "result-error") void vscode.window.showErrorMessage(`Entomatical: ${r.error}`);
    }
  } finally {
    dispatching.delete(board);
    if (Number.isFinite(nextRetry)) {
      const timer = setTimeout(() => void startHeld(board), Math.max(0, nextRetry - Date.now()));
      timer.unref();
      retryTimers.set(board, timer);
    }
  }
}

/** One card for the add-task form, as `create` and `battle` make it: add, name, Plan first's prompt, Asana and Obsidian, then the start. */
interface NewCard {
  title: string; prompt: string; account: string; parentId: string; model: string; effort: string; completion: import("./board").Task["completion"];
  step: Parameters<Board["add"]>[7] & object;
  /** Name the untitled card with this model and effort before it starts. */
  name?: HelperPick;
  asana?: AsanaSelection; obsidian?: string;
}
/**
 * The specification Improve produced for this text, when the box applied it and nothing changed since: the text, the account, model,
 * effort and permission (for a follow-up, the card's own), and the renderer (master plan phase 1). A stale one is not attached; the
 * text goes as written and a warning says why, so a structured record never rides on prose it did not produce.
 */
function boundSpec(board: Board, m: Record<string, unknown>, sent: string, target: string, task?: import("./board").Task) {
  if (!Array.isArray(m.helpers) || !m.helpers.length) return undefined; // raw text: no Improve run shaped it
  const requestId = improveRequest(m.helpers), candidate = requestId ? loadCandidate(board.dir, requestId) : undefined;
  if (!candidate) return undefined;
  const stale = staleReasons(candidate, sent, controlsOf(task ?? m), target);
  if (!stale.length) return newSpec(candidate, task ? "follow-up" : "create");
  void vscode.window.showWarningMessage(`Entomatical: ${task ? "the follow-up was sent" : "the card was added"} with its text as written, without the improved specification: ${stale.join("; ")}.`);
  return undefined;
}
/** Personal capability profiles live in the extension's global storage; workspace ones in workflows/ (master plan section 7). */
let personalProfiles = "";
const profileFiles = (board: Board) => ({ workspace: path.join(board.repo, "workflows", PROFILE_FILE), ...(personalProfiles ? { personal: personalProfiles } : {}) });
/** The form's profile choices, each with why it is blocked on each account (Board.profileProblem). Undefined while no profile file exists. */
function profileView(board: Board) {
  if (!board.repo) return undefined; // stand-in boards in handler tests
  const files = profileFiles(board);
  if (!Object.values(files).some((f) => fs.existsSync(f))) return undefined;
  const { entries, errors } = profileCatalog(files);
  return { errors, entries: entries.filter((e) => !e.archived).map((e) => {
    let pinned: ReturnType<typeof pinProfile> | undefined, error = "";
    try { pinned = pinProfile(files, e.ref); } catch (x) { error = x instanceof Error ? x.message : String(x); }
    // Per account: the form's line (the reasons, each long list cut to a few names) and the whole lists behind it (F110 finding F2).
    const blocked: Record<string, string> = {}, lists: Record<string, string[]> = {};
    for (const a of board.accountList()) {
      const c = error ? { text: error } : board.profileCheck({ id: "preview", title: "", prompt: "", status: "queued", account: a.name, provider: a.provider,
        configDir: a.configDir ?? "", profile: pinned } as import("./board").Task);
      blocked[a.name] = c ? (c.reasons ? c.reasons.map((r) => r.text).join("; ") + "." : c.text) : "";
      const full = (c?.reasons ?? []).filter((r) => r.items).map((r) => `${r.code === "inventory-unknown" ? "Cannot see" : "Would also inherit"}: ${r.items!.join(", ")}.`);
      if (full.length) lists[a.name] = full;
    }
    return { ref: e.ref, scope: e.scope, name: e.name, revision: e.revision, blocked, lists };
  }) };
}
/** Phase 5: the saved councils for the approval row (workspace file only), or undefined while none is saved. */
const councilFile = (board: Board) => path.join(board.repo, "workflows", COUNCIL_FILE);
function councilView(board: Board) {
  if (!board.repo || !fs.existsSync(councilFile(board))) return undefined;
  const c = councilCatalog(councilFile(board));
  return { error: c.error, entries: c.entries.filter((e) => !e.archived && !e.altered).map((e) => ({ ref: e.ref, name: e.name, revision: e.revision, members: e.members })) };
}
/**
 * Phase 5: the user's council actions on a governed root: convene a saved checkpoint, read the full record, or (only after the round limit)
 * waive as an exception with his reason. A waiver is recorded as an exception, never as a council pass.
 */
async function councilAction(board: Board, task: import("./board").Task) {
  const run = task.governed?.council;
  if (!run) throw new Error("This run has no council: one is chosen when the governed run is approved.");
  const view = board.councilView(task, false) as { checkpoints: { checkpoint: string; state: string; decisionRequired: boolean }[] };
  const items = [...view.checkpoints.map((c) => ({ label: `Convene ${c.checkpoint}`, description: c.state, act: "convene", cp: c.checkpoint })),
    { label: "Show the council record", description: "every round, judgment, disposition and member usage", act: "show", cp: "" },
    ...view.checkpoints.filter((c) => c.decisionRequired).map((c) => ({ label: `Waive ${c.checkpoint} as an exception`, description: "round limit reached; recorded as a waiver, never a council pass", act: "waive", cp: c.checkpoint }))];
  const pick = await vscode.window.showQuickPick(items, { title: `Council: ${run.snapshot.name} r${run.snapshot.revision}` });
  if (!pick) return;
  if (pick.act === "show") { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: JSON.stringify(board.councilView(task, true), null, 2), language: "json" }), { preview: true }); return; }
  if (pick.act === "convene") { const r = await board.convene(task, pick.cp); void vscode.window.showInformationMessage(`Entomatical: council ${pick.cp} ${r.duplicate ? "is already reviewing this package" : `round ${r.round} convened`} (package ${String(r.package).slice(0, 12)}).`); return; }
  const reason = await vscode.window.showInputBox({ title: `Waive council ${pick.cp} (exception, not a pass)`, prompt: "Your reason, kept in the run's record", validateInput: (v) => v.trim() ? undefined : "A waiver needs a reason" });
  if (!reason) return;
  const ok = await vscode.window.showWarningMessage(`Waive council ${pick.cp}?`, { modal: true, detail: "The council did not pass this package. Finish may go ahead for this exact package only; the record says waived by you, not passed." }, "Waive");
  if (ok === "Waive") board.councilWaive(task, pick.cp, reason);
}
/** Refuses a card whose pinned capability profile cannot run on its route (Board.profileProblem), before any effect. */
function profileFirst(board: Board, task: import("./board").Task) {
  const blocked = board.profileProblem?.(task); // ?.: the stand-in boards of older handler tests lack it; Board always has it
  if (blocked) throw new Error(blocked);
}
/** Adds the card and starts it as the form does. Throws only when the board refuses the card; a failed start leaves it queued. */
async function addCard(board: Board, c: NewCard, recordPrompt?: (id: string) => void) {
  const added = board.add(c.title, c.prompt, c.account, c.parentId, c.model, c.effort, c.completion, ...(Object.keys(c.step).length ? [c.step] : []));
  recordPrompt?.(added.id);
  await prepareAddedCard(board, added, c).catch((e) => {
    void vscode.window.showWarningMessage(`Entomatical: card ${added.id} was added but setup did not finish. ${e instanceof Error ? e.message : String(e)}`);
  });
  return added.id;
}

async function prepareAddedCard(board: Board, added: import("./board").Task, c: NewCard) {
  // A failed start leaves the card queued with its Start button; throwing would put the text back and invite a duplicate.
  const autoStart = vscode.workspace.getConfiguration("entomatical").get<boolean>("autoStart", true);
  // A blocked capability profile: no naming call, no Asana or Obsidian link, no start. The card waits in Queued with its reason.
  const blocked = board.profileProblem?.(added);
  if (blocked) { void vscode.window.showWarningMessage(`Entomatical: the card was added but not started. ${blocked}`); return; }
  if (autoStart && c.name) {
    naming.add(added.id);
    try { await autoTitle(board, added, c.name); } finally { naming.delete(added.id); }
  }
  // Plan first (F99): the card is sent the planning prompt, shown in full in the form's preview and as the card's prompt #1. After
  // naming, so Haiku names the task and not the template. add() keeps planFirst only for an attended Claude or Codex card; a Codex
  // card runs on Astra at ultra effort and gets the Codex planning prompt.
  if (added.planFirst) board.update(added, { prompt: plannerPrompt(board.repo, added.prompt, added.provider === "codex") });
  // The Asana box (asana-board.ts): after the title, so a new Asana task gets the card's name; before the start, so its context goes in.
  if (c.asana) await linkAsana(board, added, c.asana).catch((e) => vscode.window.showWarningMessage(`Entomatical: the card was added without an Asana task. ${e instanceof Error ? e.message : String(e)}`));
  if (c.obsidian) await linkObsidian(board, added, c.obsidian).catch((e) => vscode.window.showWarningMessage(`Entomatical: the card was added without an Obsidian note. ${e instanceof Error ? e.message : String(e)}`));
  // The running limit (F82): the card waits in Queued and the board starts it when it may (startHeld).
  if (autoStart && waitReason(added, board.tasks, maxRunning())) board.update(added, { held: true });
  else if (autoStart) {
    await handle(board, { type: "start", id: added.id }).catch((e) => vscode.window.showErrorMessage(`Entomatical: ${e instanceof Error ? e.message : String(e)}`));
  }
}

class CreateContextError extends Error {
  constructor(readonly field: "parent" | "account" | "profile", message: string) { super(message); }
}

// ---- Battle Royale's arena (src/arena.ts, the user, 14 November 2026): the popup's messages, the countdown and the report. ----

/** Every board of this window (one today). Battle Royale clears each one this window owns, the battle's own board first. */
const windowBoards = new Set<Board>();
const arenaOf = (board: Board) => arenaBoards([board, ...[...windowBoards].filter((b) => b !== board)]);
/** The warning while the popup is open: what it changed, and the webview that sent it (0: the battle itself). */
let warned: (Warned & { from: number }) | undefined;
/** The 30 seconds a warned card gets, and the moment stopped sessions get to exit before the sweep. Tests shorten them. */
let arenaTiming = { warnMs: 30_000, settleMs: 2_000 };
/** A battle is clearing the arena or adding its cards: a second one is refused. */
let battling = false;
/** A card the extension runs work for: its review, or a helper call on its box. */
const arenaBusy = (id: string) => reviews.has(id) || [...allHelpers.values()].includes(id);
/** Stops the review and the helper calls the extension runs for a card; true when it had any. */
function stopCardWork(id: string): boolean {
  let any = false;
  const review = reviews.get(id);
  if (review) { review.abort(REVIEW_BATTLE); any = true; }
  for (const [controller, card] of allHelpers) if (card === id) { controller.abort(); any = true; }
  return any;
}
/** No, Escape, a closed or reloaded popup, or a refused battle: the warning is called off (from: only the one that webview sent). */
function callOffArena(from?: number) {
  if (!warned || (from !== undefined && warned.from !== from)) return;
  const w = warned;
  warned = undefined;
  callOff(w);
}
/** The entomatical.battleRoyale settings (the user, 17 November 2026): off by default, which hides the button and refuses every battle. */
function battleSettings() {
  const c = vscode.workspace.getConfiguration("entomatical");
  const enabled = c.get<boolean>("battleRoyale.enabled", false);
  // Contestants are read only when it is on: off, nothing about them matters (and other suites stub battle.ts away).
  return { enabled, contestants: enabled ? contestantsFrom(c.get("battleRoyale.contestants")) : [], clearArena: c.get<boolean>("battleRoyale.clearArena", true) };
}
/** What every Battle Royale message checks first, changing nothing: the setting, the prompt, this window's ownership of the board, the line-up. */
function battleCheck(board: Board, m: Record<string, unknown>) {
  if (typeof m.prompt !== "string" || !m.prompt.trim()) throw new Error("A task needs a prompt.");
  // Never broadened silently: a battle runs every provider on its own configuration, so it cannot honour a strict profile.
  if (typeof m.profile === "string" && m.profile && m.profile !== "provider-defaults") throw new Error("Battle Royale runs each provider with its own configuration, so it cannot run a capability profile. Choose Provider defaults.");
  if (!battleSettings().enabled) throw new Error("Battle Royale is off. Turn it on in Settings: Entomatical › Battle Royale: Enabled.");
  board.mustOwn();
  return battleLineup(board.accountList(), typeof m.account === "string" ? m.account : "", codexModels(), battleSettings().contestants); // refuses with fewer than two
}
/**
 * The popup's messages before `battle` (each with the fields of `create`). battlePrepare checks, finds the targets and lists the
 * processes, and changes nothing: { battleReady: { cards, runs, skipped, processes } }, skipped being the boards another window owns.
 * battleWarn warns the targets, pauses every run, clears `held` and starts the 30 seconds. battleCancel calls the warning off. A refusal
 * is { battleRefused: why } and changes nothing.
 */
async function arenaMessage(board: Board, m: Record<string, unknown>, from: number): Promise<object | undefined> {
  if (m.type === "battleCancel") { callOffArena(); return undefined; }
  try { battleCheck(board, m); } catch (e) { return { battleRefused: e instanceof Error ? e.message : String(e) }; }
  const { owned, skipped } = arenaOf(board);
  if (m.type === "battleWarn" && !battleSettings().clearArena) return undefined; // nothing is stopped, so nobody is warned
  if (m.type === "battleWarn") { warned ??= { ...warnArena(owned, arenaBusy, Date.now()), from }; return undefined; }
  let processes: number | undefined; // what the sweep would end now, live sessions' processes included; it lists again after the stop
  try { processes = leftovers(await listProcesses(), owned.map((b) => b.repo), [process.pid]).length; } catch { /* unknown */ }
  return { battleReady: { cards: owned.reduce((n, b) => n + arenaCards(b, arenaBusy).length, 0), runs: owned.reduce((n, b) => n + arenaRuns(b).length, 0),
    skipped: skipped.map((b) => b.repo), processes } };
}
/** The rest of the warning's 30 seconds, under a notification that counts down. */
async function countdown(ms: number) {
  if (ms <= 0) return;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Entomatical: Battle Royale" }, async (progress) => {
    const end = Date.now() + ms;
    for (let left = ms; left > 0; left = end - Date.now()) {
      progress.report({ message: `the arena is cleared in ${Math.ceil(left / 1000)} s` });
      await new Promise((r) => setTimeout(r, Math.min(1000, left)));
    }
  });
}
/** The one message after the clearing: what was stopped and ended, the boards skipped, what failed. */
function arenaReport(s: Stopped, helpers: number, swept: { ended: number; removed: number; failures: string[] }, skipped: string[]): string {
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const failures = [...s.failures, ...swept.failures];
  return [`Entomatical: Battle Royale cleared the arena. Stopped ${n(s.cards, "card")}, ${n(s.runs, "run")}${helpers ? ` and ${n(helpers, "helper call")}` : ""}; ended ${n(swept.ended, "leftover process", "leftover processes")}`
    + `${swept.removed ? `; deleted the leftover folders of ${n(swept.removed, "merged card")}` : ""}. Stopped cards wait in Review; Resume continues each.`,
    skipped.length ? `Skipped ${n(skipped.length, "board")} another window owns: ${skipped.join(", ")}.` : "",
    failures.length ? `Failed: ${failures.join("; ")}.` : ""].filter(Boolean).join(" ");
}

async function handle(board: Board | undefined, m: Record<string, unknown>, recordPrompt?: (id: string) => void, queuedStart = false) {
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  if (typeof m.type === "string" && m.type.startsWith("account") && m.provider === "grok") {
    switch (m.type) {
      case "accountAdd": return addGrokAccount();
      case "accountLogin": return grokLogIn(m.configDir);
      case "accountOpen": return openGrok(m.configDir);
      case "accountRemove": return removeGrokAccount(m.configDir);
      default: throw new Error("Unsupported Grok account action.");
    }
  }
  if (typeof m.type === "string" && m.type.startsWith("account") && m.provider === "antigravity") {
    switch (m.type) {
      case "accountAdd": return addAntigravityAccount();
      case "accountLogin": return antigravityLogIn();
      case "accountOpen": return openAntigravity();
      case "accountRemove": return hideAntigravityAccount();
      default: throw new Error("Unsupported Antigravity account action.");
    }
  }
  if (typeof m.type === "string" && m.type.startsWith("account") && m.provider !== undefined && m.provider !== "codex") throw new Error("Unknown account provider.");
  const codex = m.provider === "codex";
  switch (m.type) {
    case "accountUse":
      if (codex) throw new Error("The IDE default is a Claude Code setting; Codex accounts are picked per task.");
      return useAccount(m.configDir);
    case "accountLogin":
      return codex ? codexLogIn() : logIn(m.configDir);
    case "accountLogout":
      return codex ? codexLogOut() : logOut(m.configDir);
    case "accountRemove":
      return removeAccount(m.configDir);
    case "accountSettings": // the settings pages the CLIs and their extensions link to; the browser shows whichever account it is signed into
      return void vscode.env.openExternal(vscode.Uri.parse(codex ? "https://chatgpt.com/#settings" : "https://claude.ai/settings/usage"));
    case "accountAdd": // Codex has one account, ~/.codex: adding it is signing it in
      return codex ? codexLogIn() : addAccount();
    case "accountRefresh":
      return rescan(true);
  }
  if (!board) return;
  if (m.type === "create") {
    if (!text(m.prompt).trim()) throw new Error("A task needs a prompt.");
    board.mustOwn(); // before the Fable rule's long call: add() would refuse only after it
    const account = text(m.account), parentId = text(m.parentId), profileRef = text(m.profile);
    const boundContext = typeof m.createId === "string" || m.profileRevision !== undefined;
    const readContext = () => {
      if (boundContext && parentId && !board.get(parentId)) throw new CreateContextError("parent", "The selected parent is unavailable. Choose a parent or use no parent.");
      if (boundContext && account && !board.accountList().some((a) => a.name === account)) throw new CreateContextError("account", "The selected account is unavailable. Choose an account for the draft.");
      try {
        const profile = profileRef === "provider-defaults" ? { mode: "provider-defaults" as const } : profileRef ? pinProfile(profileFiles(board), profileRef) : undefined;
        if (m.profileRevision !== undefined && (profile?.mode !== "strict" || profile.snapshot.revision !== m.profileRevision)) throw new Error("The profile revision changed.");
        return profile;
      } catch (e) {
        if (!boundContext) throw e;
        throw new CreateContextError("profile", `Choose a capability profile for the draft. ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    // The model and effort picked on the toggles' drop-downs (the user, 13 November 2026); anything else is the default.
    const titlePick = helperPick(m.titleModel, m.titleEffort, TITLE_DEFAULT), rulePick = helperPick(m.ruleModel, m.ruleEffort, RULE_DEFAULT);
    if (boundContext && m.autoRule === true) readContext();
    const { prompt, completion } = m.autoRule === true ? await prepareRule(board, text(m.prompt), account, (m.mayOpen ?? m.orchestrator) === true && board.orchestratorEnabled(), rulePick) : { prompt: text(m.prompt), completion: undefined };
    // Rule generation can outlive the selection. Recheck and pin the displayed revision before any card is added.
    const profile = readContext();
    // The Orchestrator tickbox (F69, F71): the card gets the brief first in its message and may open cards of its own. A Claude or
    // Codex one runs in its card terminal, where the user sees it and the board types its notices (the user, 18 November 2026); Board.add
    // gives it that terminal and keeps a Grok or Antigravity one headless.
    const orchestrator = (m.mayOpen ?? m.orchestrator) === true && board.orchestratorEnabled();
    // Plan first (F78): the first turn runs in Claude's plan mode, or on Codex's Astra at ultra effort; add() drops it for a Grok,
    // Antigravity or headless card.
    const spec = boundSpec(board, m, text(m.prompt), "new");
    const step = { ...(spec ? { spec } : {}), ...(profile ? { profile } : {}), ...(text(m.permission) ? { permission: text(m.permission) } : orchestrator ? { permission: "bypass" } : {}), ...(orchestrator ? { orchestrator: { caps: board.capsOf(), opened: 0 } } : {}),
      ...(m.planFirst === true ? { planFirst: true } : {}), ...(m.cardTerminal === true && !orchestrator ? { cardTerminal: true } : {}) };
    // the user, 30 October 2026: an untitled task is named before it starts (Haiku, or Luna for Codex, at low effort), so the session
    // carries the title from its first message (--name, or the Codex thread's name). A failed naming keeps the prompt's first line.
    // The Haiku title tickbox beside Add task (the user, 29 October; ticked by default) turns it off.
    // One request id binds one card: claimed before the first await, so a second Add of the same box finds it used; released if no card was added.
    const bound = spec ? improveRequest(m.helpers)! : undefined;
    if (bound) markCandidate(board.dir, bound, "");
    const choice = text(m.asana);
    const asana = choice ? { choice, project: text(m.asanaProject), generation: typeof m.asanaGeneration === "number" ? m.asanaGeneration : 0 } : undefined;
    try {
      return await addCard(board, { title: text(m.title), prompt: orchestrator ? masterPrompt(readBrief(board.briefPath), prompt) : prompt, account, parentId,
        model: text(m.model), effort: text(m.effort), completion, step, name: m.autoTitle !== false && !text(m.title).trim() ? titlePick : undefined, asana, obsidian: text(m.obsidian) }, recordPrompt);
    } finally { if (bound) markCandidate(board.dir, bound, board.tasks.find((t) => t.spec?.specId === spec!.specId)?.id); }
  }
  // Battle Royale (battle.ts, the user, 14 November 2026): one prompt starts a card per contestant (entomatical.battleRoyale.contestants;
  // by default one per provider, each on its top model at its top effort),
  // in its card terminal with permission bypass, so it runs with no input. The form's account, model, effort, permission, Plan first, Card
  // terminal, Asana and Obsidian are ignored; its parent, Haiku title, Done when and Orchestrator (a47807) are honoured. First the arena is
  // cleared (src/arena.ts): the rest of the warning's 30 seconds (a warning goes out now if the popup sent none), then every card and run
  // of every board this window owns is stopped and parked, leftover processes are ended, and one message says what was done.
  if (m.type === "battle") {
    if (battling) throw new Error("A Battle Royale is already clearing the arena."); // a second click would start four more cards
    let check: ReturnType<typeof battleCheck>;
    // Refused before anything is cleared or made; a warning that went out is called off.
    try { check = battleCheck(board, m); } catch (e) { callOffArena(); throw e; }
    const { lineup, skipped } = check;
    if (skipped.length) void vscode.window.showWarningMessage(`Entomatical: Battle Royale runs without ${skipped.map((s) => `${s.label} (${s.reason})`).join(", ")}.`);
    const titlePick = helperPick(m.titleModel, m.titleEffort, TITLE_DEFAULT), rulePick = helperPick(m.ruleModel, m.ruleEffort, RULE_DEFAULT);
    const first = lineup[0], firstTask = { account: first.account, provider: first.provider === "claude" ? undefined : first.provider } as import("./board").Task;
    const autoStart = vscode.workspace.getConfiguration("entomatical").get<boolean>("autoStart", true);
    battling = true;
    try {
      // With battleRoyale.clearArena off nothing is warned, waited for, stopped or swept: the contestants join the cards already running.
      const arena = battleSettings().clearArena ? arenaOf(board) : undefined;
      const warning = arena && (warned ??= { ...warnArena(arena.owned, arenaBusy, Date.now()), from: 0 });
      // The Done when and the title are written while the cards get their 30 seconds, and are done before anything is stopped (the sweep
      // must not meet their calls). A failure there, or a call-off meanwhile, refuses the battle: the warning is called off.
      const ready = (async () => {
        // One Done when for every card, written once on the user's prompt.
        const { prompt, completion } = m.autoRule === true ? await prepareRule(board, text(m.prompt), first.account, false, rulePick) : { prompt: text(m.prompt), completion: undefined };
        // The task is named once, from the user's prompt as typed, before any card exists; each card's title then ends in its provider.
        const title = text(m.title).trim()
          || (autoStart && m.autoTitle !== false ? await titleFor(board, { ...firstTask, prompt: text(m.prompt) }, titlePick) : undefined)
          || battleFallbackTitle(text(m.prompt));
        return { prompt, completion, title };
      })();
      ready.catch(() => undefined); // awaited below; this keeps a failure during the countdown from going unhandled
      let prepared: Awaited<typeof ready>;
      try {
        if (warning) await countdown(warning.at + arenaTiming.warnMs - Date.now());
        prepared = await ready;
        if (warning && warned !== warning) throw new Error("Battle Royale was called off.");
      } catch (e) { if (warning && warned === warning) callOffArena(); throw e; }
      if (arena) {
        warned = undefined;
        const helpers = allHelpers.size;
        const stopped = stopArena(arena.owned, arenaBusy, stopCardWork);
        for (const c of allHelpers.keys()) c.abort(); // the new-task form's helpers too
        await new Promise((r) => setTimeout(r, arenaTiming.settleMs)); // stopped sessions exit; what is left after is a leftover
        const swept = await sweepArena(arena.owned, [process.pid], listProcesses, endProcesses);
        void vscode.window.showInformationMessage(arenaReport(stopped, helpers, swept, arena.skipped.map((b) => b.repo)));
      }
      const { prompt, completion, title } = prepared;
      const battle = crypto.randomBytes(4).toString("hex");
      // With the Orchestrator tickbox (a47807, the user, 14 November 2026): each card is an orchestrator that still runs in its card terminal,
      // its run approved from the start with the board's caps (nobody approves a plan in a battle), the brief first in its message and the
      // Battle Royale line kept; the cards it opens run in card terminals too (board.ts, inCardTerminal).
      const orchestrator = (m.mayOpen ?? m.orchestrator) === true && board.orchestratorEnabled();
      const brief = orchestrator ? readBrief(board.briefPath) : "";
      const ids: string[] = [];
      for (const entry of lineup) {
        try {
          const id = await addCard(board, { title: `${title} · ${entry.label}`, prompt: orchestrator ? masterPrompt(brief, battlePrompt(prompt, lineup.length - 1)) : battlePrompt(prompt, lineup.length - 1), account: entry.account, parentId: text(m.parentId), model: entry.model ?? "",
            effort: entry.effort ?? "", completion: completion && structuredClone(completion), step: { permission: "bypass", cardTerminal: true, battle, ...(orchestrator ? battleRun(board.capsOf()) : {}) } }, recordPrompt);
          ids.push(id);
        } catch (e) {
          // The cards already made stay; the next provider still gets its card.
          void vscode.window.showWarningMessage(`Entomatical: Battle Royale made no ${entry.label} card. ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return ids;
    } finally { battling = false; }
  }
  // Archived runs (F75): by archive key, not by card, since their cards are off the board.
  if (m.type === "restoreRun") {
    const { count: n, gaps, reconciled } = board.restoreRun(text(m.key));
    const gapText = gaps.length ? ` Evidence gaps (${gaps.length}): ${gaps.slice(0, 3).join("; ")}${gaps.length > 3 ? " …" : ""}` : "";
    if (reconciled) vscode.window.showWarningMessage(`Entomatical: this run's cards are on the board already (an archive or restore was cut off); the archive file moved to restored/ and nothing was restored twice.${gapText}`);
    else (gaps.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(`Entomatical: ${n} card${n === 1 ? "" : "s"} restored to Done.${gapText}`);
    return;
  }
  // Phase 6: the run's export (identities, manifest, measurements, redacted cards) as a JSON document to inspect or save.
  if (m.type === "exportRun") {
    const content = JSON.stringify(board.exportRun(text(m.key), "archive"), null, 2);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content, language: "json" }), { preview: true });
    return;
  }
  if (m.type === "archivedReport") {
    const r = board.archivedRun(text(m.key));
    // An archive the export cannot read (no master card in it) still opens its report, with the measurements said to be unavailable.
    const measures = (key: string) => { try { return measuresText(board.exportRun(key, "archive").measures); } catch (e) { return [`Measurements unavailable: ${e instanceof Error ? e.message : String(e)}`]; } };
    const rows = (r.summary?.children ?? []).map((c) => `| ${c.title} | ${c.id} | ${c.status} | ${pointsLabel(c.points)} |`);
    const content = [`# Run report: ${r.title} (${r.master}), archived ${r.archivedAt}`, "", `Plan: ${r.plan}`, "", "## Final reply", "", r.finalReply ?? "(none)", "",
      "## Cards", "", "| Card | Id | Status | Cost |", "|---|---|---|---|", ...rows, "", "## Measurements and evidence", "", ...measures(text(m.key)), "",
      `Archive file: ${path.join(board.archiveDir, `${text(m.key)}.json`)}`, ""].join("\n");
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content, language: "markdown" }), { preview: true });
    return;
  }
  const task = board.get(m.id);
  if (m.type === "openReview") {
    if (!task) throw new Error("The selected card is no longer available.");
    // Older webviews sent only the card id and preferred its Finish report.
    const kind = m.kind === undefined ? (task.selfFinish?.report ? "report" : "findings") : m.kind;
    if (kind !== "report" && kind !== "findings") throw new Error("Unknown review document.");
    const file = kind === "report" ? task.selfFinish?.report : task.doneReview?.file;
    if (!file) throw new Error(kind === "report" ? "This card has no saved Finish report." : "This card has no saved review findings.");
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), { preview: true });
    return;
  }
  if (!task) return;
  switch (m.type) {
    case "closeStep": {
      const s = task.workflow;
      if (!s?.attempt) throw new Error("This step has not run, so there is no result to close.");
      board.mustOwn(); // before the pickers
      // Plain words (the user, 5 November 2026: "a box that's empty that I don't know what to put in").
      const checks = s.checks?.length ? ` This also confirms: ${s.checks.join("; ")}.` : "";
      const pick = await vscode.window.showQuickPick([
        { label: "accepted", description: `It worked. The steps waiting for it can start.${checks}` },
        { label: "held", description: "Keep it as it is, but do not count it yet. The steps waiting for it keep waiting." },
        { label: "blocked", description: "A prerequisite is missing. Record what is needed; dependents keep waiting." },
        { label: "deferred", description: "The work is postponed. Record why; it does not count as accepted." },
        { label: "not-applicable", description: "Record why this work does not apply. This decision is not a passing result." },
        { label: "failed", description: "It did not work. It is kept, and not run again." },
        { label: "cancelled", description: "It was called off." }], { title: `Record the result of "${task.title}" (attempt ${s.attempt})`, placeHolder: "How did this step go?" });
      if (!pick) return;
      const limitations = await vscode.window.showInputBox({ title: `Notes for "${task.title}" (optional)`, value: "",
        prompt: "Anything still missing or not checked. Leave it empty and press Enter if there is nothing.", placeHolder: "For example: not tested on Linux" });
      if (limitations === undefined) return;
      const r = board.closeStep(task, pick.label as import("./workflow").RunReceipt["outcome"], limitations);
      vscode.window.showInformationMessage(`Entomatical: recorded "${task.title}" as ${r.outcome}. The record is .entomatical/workflow/receipts/${r.attempt}.json in the repository.`);
      return;
    }
    case "approveScope": {
      const scope = task.workflow?.scope;
      if (!scope) throw new Error("This step has no scope to approve.");
      board.mustOwn(); // before the question
      const detail = [`Operations: ${scope.operations.join(", ")}`, `Sources: ${scope.sources.join(", ") || "none"}`, `Destinations: ${scope.destinations.join(", ") || "none"}`,
        `Tool version: ${scope.toolVersion}`, `Bounds: ${scope.bounds}`, scope.expires ? `Expires: ${scope.expires}` : "", scope.binding ? `Manifest: ${scope.binding.manifest}\nEvidence: ${JSON.stringify(scope.binding.evidence)}\nOne dispatch. This approval does not authenticate to a device or prove a hardware-key touch.` : "One dispatch (one touch); a failed attempt is not retried."].filter(Boolean).join("\n");
      const ok = await vscode.window.showWarningMessage(`Approve this exact scope for "${task.title}"?`, { modal: true, detail }, "Approve");
      if (ok === "Approve") board.approveScope(task);
      return;
    }
    case "generateTitle": {
      if (!board.isOwner()) throw new Error("Generate this title in the window that owns the board.");
      if (task.status === "running" || task.status === "needs-input") throw new Error("Wait until the session is idle before generating its title.");
      const previous = task.title;
      const dir = path.join(board.dir, "helpers", crypto.randomUUID());
      // Haiku is a Claude model: a Codex task's title is written with the Claude IDE default account. A Grok or Antigravity task's
      // title is written on its own account with the agent's default model (run 0db6d1).
      const acp = acpAccountOf(board, task.account);
      const configDir = acp ? acp.configDir : task.provider ? activeConfigDir() : board.configDirOf(task);
      const progressTitle = acp ? `Entomatical: generating title on ${acp.name}` : "Entomatical: generating title with Haiku";
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: progressTitle, cancellable: true }, async (_progress, token) => {
        const controller = new AbortController(); const cancel = token.onCancellationRequested(() => controller.abort());
        const timer = setTimeout(() => controller.abort(), 120_000);
        try { return await generateText(dir, "title", `${task.prompt.slice(0, 5000)}\nLatest activity: ${(board.lastReply(task) || "").slice(0, 800)}`, configDir, acp ? "" : "haiku", "", controller.signal, undefined, acp?.via, acp ? [] : otherAccountDirs(configDir)); }
        finally { clearTimeout(timer); cancel.dispose(); }
      });
      if (result.note) useFallbackAccount(result.configDir ?? "", configDir, result.note);
      if (board.get(task.id)?.title !== previous) throw new Error("The title changed while generation ran. Your newer title was preserved.");
      const title = result.value.title;
      await applyGeneratedTitle(board, task, title);
      const undo = await vscode.window.showInformationMessage(`Entomatical: title saved as “${title}”.${!task.provider && (task.panel || task.adopted) ? " Reopen the Claude tab if needed." : ""}`, "Undo");
      if (undo === "Undo" && board.get(task.id)?.title === title) await applyGeneratedTitle(board, task, previous);
      break;
    }
    case "checksRetry":
      board.checks.retry(task);
      break;
    case "checksFix":
      await sendOrPaste(board, task, board.fixPrompt(task));
      break;
    // The Review button (F97): the reviewer reads the card's work against its Done when; Accept prompt sends what it wrote.
    case "reviewWork": {
      try { board.mustOwn(); } // before the reviewer's long call: its verdict could not be recorded
      catch (e) { throw refuseReview(board, task, e); }
      recoverReview(board, task, reviews.has(task.id));
      const refused = canReview(task, board.tasks);
      if (refused) throw refuseReview(board, task, new Error(refused));
      // Cancel review is not an error: the card says "Review cancelled." (Refine's cancel does not toast either).
      const r = await runDoneReview(board, task, { auto: false, answers: text(m.answers) || undefined }).catch((e) => { if (e.message !== REVIEW_CANCELLED) throw e; });
      // A Done on a master that asked to finish (an Unsure answered, or the user's own Review) continues its self-finish with this review.
      const now = board.get(task.id);
      if (r?.verdict === "done" && now?.finishAsked && now.orchestrator) board.runEvents.fire({ kind: "finishReady", master: now, review: r });
      break;
    }
    case "cancelReview":
      reviews.get(task.id)?.abort(REVIEW_CANCELLED);
      recoverReview(board, task, reviews.has(task.id));
      break;
    // F103: the failure notice's Show log opens the Output channel with the error log's lines.
    case "showErrorLog":
      showErrorLog();
      break;
    case "dismissReview":
      if (task.doneReviewRun?.error) board.update(task, { doneReviewRun: undefined }); // a run still going is not hidden
      break;
    case "acceptReview": {
      const r = task.doneReview;
      // A Done has no prompt; a prompt sent, or being sent (a second press meanwhile), is not sent again.
      if (!r?.prompt || r.sent || accepting.has(task.id)) break;
      accepting.add(task.id);
      try {
        const sent = await sendOrPaste(board, task, r.prompt, "the prompt");
        recordDecision(r.receipt, "accept");
        const now = board.get(task.id); // a newer review that landed meanwhile keeps its own fields
        // Accept is the user's own action: like a manual Review, it resets the automatic rounds (AUTO_ROUNDS).
        if (now) board.update(now, { ...(now.doneReview?.receipt === r.receipt ? { doneReview: { ...now.doneReview, sent } } : {}), finishAsked: undefined, autoRounds: 0, mergeRetries: 0 });
      } finally { accepting.delete(task.id); }
      break;
    }
    case "rename": {
      if (!board.isOwner()) throw new Error("Rename this session from the window that owns its board.");
      if (task.provider === "codex" || isAcpProvider(task.provider)) {
        // A reload can replace the object, and a provider switch can edit it in place while the dialog is open.
        const { id, createdAt, openedBy, provider, account, configDir, sessionId, boardSessionId, title: previous } = task;
        const title = await vscode.window.showInputBox({ prompt: "Rename card", value: previous,
          validateInput: (value) => !value.trim() || /[\r\n\x00-\x1f]/.test(value) ? "Enter a name on one line" : undefined });
        if (title === undefined) return;
        if (!board.isOwner()) throw new Error("Rename this session from the window that owns its board.");
        const current = board.get(id);
        if (!current || current.createdAt !== createdAt) throw new Error("The selected card was removed or replaced while Rename was open.");
        if (current.openedBy !== openedBy || current.provider !== provider || current.account !== account || current.configDir !== configDir ||
            current.sessionId !== sessionId || current.boardSessionId !== boardSessionId) {
          throw new Error("The card's owner, account or session changed. Open Rename again.");
        }
        if (current.title !== previous) throw new Error("The title changed while Rename was open. Your newer title was preserved.");
        board.update(current, { title: title.trim(), named: true });
        if (provider === "codex" && await board.nameThread(current)) {
          const reopened = await board.reopenInCodex(current).catch(() => false);
          vscode.window.showInformationMessage(`Entomatical: Codex's thread is named “${current.title}”${reopened ? ", and its tab was reopened with that title" : ""}.`);
        }
        return;
      }
      const found = task.sessionId ? board.external.get(task.sessionId) : undefined;
      const chain = found ? await ancestors(found.pid) : [];
      let terminal = board.terminal(task);
      if (!terminal && found) {
        for (const candidate of vscode.window.terminals) {
          const pid = await candidate.processId;
          if (pid && chain.includes(pid)) { terminal = candidate; break; }
        }
      }
      if (!task.sessionId || terminal) {
        if (terminal && (task.status === "running" || task.status === "needs-input")) throw new Error("Wait until this session is idle before renaming it.");
        const title = await vscode.window.showInputBox({ prompt: "Rename session", value: task.title,
          validateInput: (value) => !value.trim() || /[\r\n\x00-\x1f]/.test(value) ? "Enter a session name on one line" : undefined });
        if (title === undefined) return;
        if (terminal) terminal.sendText(paste(`/rename ${title.trim()}`), false);
        else board.update(task, { title: title.trim(), named: true });
        return;
      }
      if (found && !chain.includes(process.pid)) throw new Error("This session runs in another window. Rename it there; Entomatical will pick up its new name.");
      if (!found) await board.openInPanel(task, panelHistoryDir());
      await vscode.commands.executeCommand("claude-vscode.primaryEditor.open", task.sessionId);
      await vscode.commands.executeCommand("claude-vscode.renameSessionTab");
      return;
    }
    case "startTerminal":
    case "start":
      // Pressed while Haiku names it: the session would start without the name, and the start after naming would then fail.
      if (naming.has(task.id)) return void vscode.window.showInformationMessage(`Entomatical: "${task.title}" is being named. It starts once its title is made, or waits its turn behind Start after or the running limit.`);
      board.mustOwn(); // first: in another window Use panel would set this profile's claudeProcessWrapper, then Start would refuse
      if (task.spec) readSpec(task.spec); // an unreadable specification refuses the start here, before any effect
      profileFirst(board, task); // before Use panel can write claudeProcessWrapper, naming, or anything else
      if (!queuedStart && task.held) {
        if (task.openedBy || task.orchestrator) {
          const wait = board.startWait(task);
          if (wait) throw new Error(wait);
        } else board.update(task, { held: undefined, launchError: undefined, startRetryAt: undefined }); // ordinary manual Start may override its queue
      }
      // The start's receipt is written only once a start call returned (a cancelled dialog or a failed start leaves none).
      const started = () => { if (task.spec) recordSpec(board, board.get(task.id) ?? task, "launch"); };
      // Only an ordinary card opens the provider's own terminal; a headless, orchestrator or worker card runs unattended below (runHeadlessAcp).
      // A battle's orchestrator and the cards it opens run in their terminals too (a47807).
      if (["grok", "antigravity"].includes(String(task.provider)) && (m.type === "startTerminal" || !(task.headless || task.orchestrator) || inCardTerminal(task))) {
        if (task.sessionId || (task as typeof task & { cardTerminalStarted?: boolean }).cardTerminalStarted) {
          const hadTerminal = (task as typeof task & { cardTerminalStarted?: boolean }).cardTerminalStarted;
          const detail = [task.sessionId ? "The earlier ACP conversation and its recorded history remain available; the terminal does not resume it." : "",
            hadTerminal ? "The previous terminal output will be replaced. Entomatical cannot verify whether the provider saved that conversation." : "",
            "This starts a new conversation."].filter(Boolean).join("\n\n");
          const choice = await vscode.window.showWarningMessage(`Start a new terminal conversation for "${task.title}"?`,
            { modal: true, detail }, "Start new terminal");
          if (choice !== "Start new terminal") break;
          board.mustOwn();
          if (board.get(task.id) !== task) throw new Error("The card changed while awaiting confirmation.");
        }
        await (board as unknown as { startCardTerminal: (item: typeof task) => Promise<void> }).startCardTerminal(task);
        started();
        break;
      }
      if (m.type === "startTerminal") throw new Error("Only Grok and Antigravity cards use an in-card terminal.");
      // An orchestrator with a card terminal (Claude or Codex, 18 November 2026) starts in it below; a Codex one saved without stays headless.
      if (task.headless || (task.orchestrator && task.provider && !task.cardTerminal && !inCardTerminal(task))) { await board.startHeadless(task); break; } // Board.startHeadless writes the receipt, as for every board-internal start
      // Codex runs in a terminal only; so does a step that asks the owner to authenticate (never the panel's unattended first turn), and
      // an orchestrator: the board can type its notices into a terminal, never into the panel (Board.canDeliver).
      if (task.provider !== "codex" && !task.cardTerminal && !task.orchestrator && !(task.workflow && interactive(task.workflow)) && await usePanel()) await board.startInPanel(task);
      else (await board.start(task))?.show(true); // a Codex task in editor mode has no terminal
      started();
      break;
    case "open": {
      const term = board.terminal(task);
      const found = task.sessionId ? board.external.get(task.sessionId) : undefined;
      if (task.headless && !task.takenOver && task.sessionId) await headlessActivity!.open(task);
      else if (term) term.show();
      else if (task.codexEditor) await board.openInCodex(task);
      else if (found) await openFound(found.pid, task.sessionId!);
      else if (wrapperIsOn() && board.canResumeInPanel(task) && !task.orchestrator) await board.openInPanel(task, panelHistoryDir()); // an orchestrator's session belongs in a terminal (Resume)
      else vscode.window.showInformationMessage("Entomatical: no live session for this task. Use Resume.");
      break;
    }
    case "send":
      if (text(m.text).trim()) {
        const improved = Array.isArray(m.helpers) && m.helpers.length ? improveRequest(m.helpers) : undefined, current = improved ? readSpec(task.spec) : undefined; // an unreadable specification refuses before sending
        const followSpec = improved ? boundSpec(board, m, text(m.text), task.id, task) : undefined;
        if (followSpec) markCandidate(board.dir, improved!, task.id); // before the send's first await: one request id binds one card
        try {
          if (["grok", "antigravity"].includes(String(task.provider))) await board.followUpHeadless(task, text(m.text));
          else await board.send(task, text(m.text), true, "confirm-submit");
        } catch (e) { if (followSpec) markCandidate(board.dir, improved!, undefined); throw e; }
        // A follow-up after a Done verdict is the main sign of a false Done (review report section 5): recorded once on its receipt.
        const now = board.get(task.id) ?? task, r = now.doneReview;
        if (r?.verdict === "done" && !r.workedAfter) { recordDecision(r.receipt, "worked-after-done"); board.update(now, { doneReview: { ...r, workedAfter: true } }); }
        // the user's own follow-up resets the automatic rounds (AUTO_ROUNDS), as a manual Review and Accept do; sendBack's prompts do not come here.
        if (now.autoRounds || now.mergeRetries) board.update(now, { autoRounds: 0, mergeRetries: 0 });
        // A follow-up's specification is added only once it was sent; the card's earlier revisions stay.
        // Read again after the send: a start or resume receipt written meanwhile is kept.
        if (followSpec) board.update(now, { spec: current ? addRevision(readSpec(now.spec) ?? current, loadCandidate(board.dir, improved)!) : followSpec });
        recordPrompt?.(task.id);
        return "sent" as const;
      }
      throw new Error("A follow-up needs text.");
    case "setAcpOption":
      (board as unknown as { selectAcpOption: (task: import("./board").Task, id: string, value: string) => void }).selectAcpOption(task, text(m.optionId), text(m.value));
      break;
    case "stop":
      board.stop(task);
      break;
    case "resume": {
      if (task.spec) readSpec(task.spec); // an unreadable specification refuses the resume before any effect
      profileFirst(board, task); // before a headless card is converted to a taken-over one
      // An in-card terminal that was interrupted (Stop, exit, window reload) continues in a new terminal on the same card and worktree.
      if (task.provider === "grok" || task.provider === "antigravity") {
        if (!task.cardTerminalStarted) throw new Error("Use Follow-up on this card to continue its conversation.");
        board.mustOwn();
        await board.startCardTerminal(task, true);
      } else if (await resumeTask(board, task) !== "continued") break;
      const now = board.get(task.id) ?? task;
      if (now.spec) recordSpec(board, now, "resume");
      break;
    }
    case "profileDefaults": {
      // O5: show exactly what the card would inherit, then record the user's explicit choice on the card. Nothing is started here.
      board.mustOwn();
      const preview = board.inheritedBy(task), { items, unknown } = preview, pick = "Run with Provider defaults instead";
      const detail = `The card drops its strict profile and inherits what the account is set up with:\n${items.length ? items.map((x) => `- ${x}`).join("\n") : "- nothing Entomatical can list"}${unknown.length ? `\nNot listed: ${unknown.join(", ")}.` : ""}`;
      if (await vscode.window.showWarningMessage(`Run "${task.title}" with Provider defaults?`, { modal: true, detail }, pick) === pick) board.useProviderDefaults(task, preview);
      break;
    }
    case "resumeBypass":
      if (task.spec) readSpec(task.spec);
      profileFirst(board, task);
      // F91: a headless run its own hook stopped after refused calls continues in the same session with Bypass permissions.
      await board.resumeWithBypass(task);
      if (task.spec) recordSpec(board, board.get(task.id) ?? task, "resume");
      break;
    case "switchAccount": {
      // When the task's account has reached its limit: move it to another signed-in account (Claude, Codex, Grok or Antigravity), then start or resume it there.
      board.mustOwn(); // first: in another window "Stop and switch" would end the session, then switchAccount would refuse
      if (task.spec) readSpec(task.spec); // an unreadable specification: nothing is stopped or moved
      profileFirst(board, task); // nothing is stopped; Board.switchAccount checks the target account too
      await rescan(); // a folder may have been logged into another login since the board last asked
      let here: string | undefined; // the task's own Claude folder, if its account still resolves; a renamed account must not block the move
      try { here = task.provider ? undefined : board.configDirOf(task); } catch { here = undefined; }
      const rows = accountRows();
      const rowOf = (a: { configDir?: string; provider?: string }) => rows.find((r) =>
        (r.provider ?? "") === (a.provider ?? "") && (a.provider === "codex" || a.provider === "antigravity" || sameFolder(r.configDir, a.configDir ?? "")));
      const hereEmail = (here !== undefined ? rowOf({ configDir: here })?.email : undefined) ?? task.account?.replace(/ \(.*\)$/, "").toLowerCase();
      // A found session cannot change provider (switchAccount refuses), so it is offered only its own provider's accounts.
      const picks = board.accountList().filter((a) => (!task.adopted || (a.provider ?? "") === (task.provider ?? ""))
        && a.name !== task.account && (a.provider || task.provider || here === undefined || !sameFolder(a.configDir ?? "", here))).map((a) => {
        const row = rowOf(a), u = row?.usage;
        const other = (a.provider ?? "") !== (task.provider ?? "");
        return {
          label: a.name,
          description: [a.provider ? ({ codex: "Codex", grok: "Grok", antigravity: "Antigravity" } as Record<string, string>)[a.provider] : `Claude · ${a.configDir ? path.basename(a.configDir) : "~/.claude"}`, row?.plan,
            !a.provider && !task.provider && row?.email && row.email === hereEmail && "same login as this task's account, so the same limit",
            other && task.sessionId && "starts a new conversation"].filter(Boolean).join(" · "),
          detail: usageLine(u, undefined, row?.plan),
          account: a,
        };
      });
      if (!picks.length) throw new Error("No other signed-in account. Add or sign in an account under Accounts first.");
      const pick = await vscode.window.showQuickPick(picks, { title: `Move "${task.title}" to another account`,
        placeHolder: task.sessionId ? "Pick the account to continue on" : "Pick the account to start on" });
      if (!pick) break;
      // Every refusal of switchAccount, before the confirmation and before a session is stopped. fresh: a new session in the same worktree.
      const fresh = board.canSwitch(task, pick.account.name);
      const running = board.own().includes(task.id);
      // The CLI lists the board's own terminals in `external` too, so only a session the board did not start is "elsewhere". A Claude
      // panel of this window is a child of this extension host: the board ends it itself and resumes the task on the new account
      // (the user, 30 October 2026); another window's session is still refused.
      const live = !running && task.sessionId ? board.external.get(task.sessionId) : undefined;
      const panelHere = !!live?.pid && (await ancestors(live.pid)).includes(process.pid);
      if (live && !panelHere) throw new Error("This session is open in another window. Close it there, then switch.");
      const other = (pick.account.provider ?? "") !== (task.provider ?? "");
      if (running || panelHere || fresh) {
        const to = pick.account.provider ? ({ codex: "Codex", grok: "Grok", antigravity: "Antigravity" } as Record<string, string>)[pick.account.provider] : "Claude";
        const detail = [running && "Its running session is stopped first.", panelHere && "Its session in the Claude panel is ended first, and the task reopens there on the new account.",
          fresh && `${other ? `${to} cannot continue this conversation` : "This account cannot continue the saved conversation"}, so a new ${to} session starts in the same worktree with the task's prompt. The work so far stays in the worktree, and the new session is told to check it first.`,
          other && `The model and effort go back to ${to}'s defaults unless ${to} offers the same ones.`].filter(Boolean).join(" ");
        const button = fresh ? "Start new session" : "Stop and switch";
        const ok = await vscode.window.showWarningMessage(`Move "${task.title}" to ${pick.label}?`, { modal: true, detail }, button);
        if (ok !== button) break;
      }
      board.mustOwn(); // again: the window may have lost the board while the pickers were open
      if (running || panelHere) {
        if (running) board.stop(task); else board.killSession(task);
        if (!await board.ended(task)) throw new Error("The session did not end within 10 seconds. Stop it, then switch again.");
      }
      // An ended panel session's tab only reveals itself when reopened, so it goes; also when the session had died before (its tab may linger).
      if (panelHere || (task.panel && !running)) {
        const tabs = await closeClaudeTab(board, task);
        if (tabs > 1 || (tabs === 0 && panelHere)) void vscode.window.showInformationMessage(`Entomatical: close the old Claude tab of "${task.title}" yourself; Entomatical could not tell which tab was its. Then press Resume on the card to continue on the new account.`);
      }
      const next = board.switchAccount(task, pick.account.name);
      await handle(board, { type: next, id: task.id });
      break;
    }
    case "changes": {
      const { diff, untracked } = await board.changes(task);
      const note = untracked.length ? `# Untracked files (not in the diff): ${untracked.join(", ")}\n\n` : "";
      const doc = await vscode.workspace.openTextDocument({ content: note + (diff || "No tracked changes yet."), language: "diff" });
      await vscode.window.showTextDocument(doc, { preview: true });
      break;
    }
    case "merge": {
      board.mustOwn(); // before the question
      // Phase 4: a governed child's Merge integrates its exact submission into its opener's branch (the run branch), never the target.
      if (task.governedBy && !task.governed) { // every governed child carries governedBy from creation (phase 3)
        const r = await board.readiness(task, "integrate");
        const blocking = r.reasons.filter((x) => !x.ack), acks = r.reasons.filter((x) => x.ack);
        if (blocking.length) throw new Error(readinessText({ ...r, reasons: blocking }));
        const confirmed = confirmationFor(r);
        // An uncertain earlier integration into the same branch: the user checks it and acknowledges, or nothing more is integrated there.
        if (acks.length && await vscode.window.showWarningMessage("Acknowledge before Integrate?", { modal: true, detail: acks.map((x) => `- ${x.text}`).join("\n") }, "Acknowledge") !== "Acknowledge") break;
        const ok = await vscode.window.showWarningMessage(`Integrate "${task.title}" into ${r.destination!.branch} (its run branch, not ${await git(board.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "the target")})?`,
          { modal: true, detail: [`Run ${r.run}, card ${r.card}. Submitted ${r.candidate}, merged into ${r.destination!.card}'s ${r.destination!.branch} at ${r.destination!.head}; then its worktree is removed.`, ...r.notes.map((n) => `Note: ${n}.`)].join("\n") }, "Integrate");
        if (ok === "Integrate") await board.finish(task, "merge", confirmed);
        break;
      }
      const target = await git(board.repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const message = `Merge "${task.title}" (${task.branch}) into ${target}, then remove its worktree?` + (await board.parentCommits(task) ? ` This includes its parent's commits that are not in ${target} yet.` : "") + (task.obsidian ? ` The last reply (up to 3,000 characters) will be appended to the Obsidian note "${task.obsidian.note}".` : "");
      const ok = await vscode.window.showWarningMessage(message, { modal: true }, "Merge");
      if (ok === "Merge") {
        const branch = task.branch, reply = board.finalReply(task);
        await board.finish(task, "merge");
        await commentOnFinish(task, branch, reply);
        await appendOnFinish(task, branch, reply);
      }
      break;
    }
    case "asana":
      await pickAsanaLink(board, task);
      break;
    case "obsidian":
      await pickObsidianLink(board, task);
      break;
    case "finish": {
      const branch = task.branch, reply = board.finalReply(task); // read before Finish clears the worktree
      try {
        const notes = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Entomatical: finishing "${task.title}"` }, (progress) =>
          board.complete(task, async (plan, related, state) => {
            const tell = related.filter((t) => !state.waiting.includes(t));
            const reported = [
              task.asana ? `Add a comment with the session's last reply to the Asana task "${task.asana.name}".` : "",
              task.obsidian ? `Append up to 3,000 characters of the session's last reply to the Obsidian note "${task.obsidian.note}".` : "",
            ];
            // the user, 6 November 2026: Finish deals with the card in whatever state it was left; work already merged only loses its worktree.
            // 7 November: work under way is refused before this dialog (board.busyWith), so nothing here is stopped mid-turn.
            const stop = !state.open ? "" : state.asking ? "Close this task's session, which is waiting on a prompt (the prompt goes unanswered), and wait for its process to end."
              : "Close this task's session tab and wait for its process to end.";
            let steps: string[];
            if (!plan) steps = [stop, `Its branch ${task.branch} no longer exists, so there is nothing to merge.`, "Delete what is left of its worktree folder and move the card to Done.", ...reported];
            // M-02: the work landed in an earlier Finish, which kept the worktree. This one only cleans up, and says what kept it.
            else if (state.cleanupOnly) steps = [stop,
              `Its work is already ${landedWhere(state.cleanupOnly)}. Nothing is committed, merged, pushed or uploaded again.`,
              `Last time its worktree was kept because ${state.cleanupOnly.why}`,
              `Wait for what the card still runs there to end, and check that the folder holds nothing written since. If something still uses it, or it holds new files or commits, it is kept as it is and Finish says why.`,
              `Delete the worktree and branch ${task.branch}, and move the card to Done.`, ...reported];
            else {
              const files = plan.dirty.map(statusPath);
              const remote = plan.remote && `${plan.remote}/${plan.remoteBranch}`;
              const landed = state.landed;
              // FR2: a repo with a vault is merged here only, and the destination and the command it runs are shown before anything
              // is done. the user's Finish on this dialog is his approval of that upload (the answer returned below).
              const vault = plan.vault, noHelper = vault && vaultHelperMissing(vault);
              steps = [
                stop,
                state.restore ? `Its worktree folder is gone, so check ${task.branch} out there again (uncommitted work in the folder went with it; the branch's commits are kept).` : "",
                files.length ? `Commit ${files.length} uncommitted file${files.length === 1 ? "" : "s"} (${files.slice(0, 8).join(", ")}${files.length > 8 ? ", …" : ""}), with a message Claude Haiku writes from the changes.` : "",
                landed ? `Nothing to merge: ${remote || plan.target} already has every commit on ${task.branch}.` : "",
                landed && remote && plan.commits.length ? `Update ${plan.target} here from ${remote}.` : "",
                landed ? "" : remote ? `Merge the latest ${remote} into ${task.branch}, in its worktree. A conflict is resolved by Claude without a tab, continuing this task's conversation.`
                  : `Merge ${plan.target} into ${task.branch}, in its worktree. A conflict is resolved by Claude without a tab, continuing this task's conversation.`,
                landed ? "" : remote ? `Push to ${remote} (GitHub first), then update ${plan.target} here from it.`
                  : vault ? `Merge ${task.branch} into ${plan.target} here. No git remote is fetched or pushed: this repo's Finish destination is ${vault.name}.`
                  : `Merge ${task.branch} into ${plan.target} (no remote is set for ${plan.target}).`,
                !landed && remote && plan.overlap.length ? `${plan.target} here has uncommitted changes to ${plan.overlap.join(", ")}, which this task also changes; if git cannot update it, Finish tells you and leaves them alone.` : "",
                !landed && !remote && plan.overlap.length ? `${plan.target} here has uncommitted changes to ${plan.overlap.join(", ")}, which this task also changes; commit or stash them first, or the merge stops.` : "",
                tell.length ? `Tell ${tell.map((t) => `"${t.title}"`).join(", ")} that this task is going away.` : "",
                state.waiting.length ? `${state.waiting.map((t) => `"${t.title}"`).join(", ")} ${state.waiting.length === 1 ? "is" : "are"} waiting on a prompt, so ${state.waiting.length === 1 ? "it is" : "they are"} not told.` : "",
                `Delete the worktree and branch ${task.branch}, and move the card to Done.`,
                !vault ? "" : noHelper ? `Upload ${plan.target} to ${vault.name}: not now, because ${noHelper}. ${plan.target} stays merged here with the upload pending.`
                  : `Upload ${plan.target} to ${vault.name} by running ${vault.display} in a terminal. It asks for your PIN and a touch.`,
                ...reported,
              ];
            }
            const lines = [...steps.filter(Boolean).map((s, i) => `${i + 1}. ${s}`), "", "Each step runs only if the earlier ones succeed. If one fails, Finish stops, tells you why and keeps the worktree."
              // A cleanup-only Finish reaches no remote and starts no upload (M-02), so neither sentence is shown, and nothing is approved.
              + (plan?.remote && !state.cleanupOnly ? ` If ${plan.remote} does not accept it, this task's session is asked whether to fix the cause.` : "")
              + (plan?.vault && !state.cleanupOnly ? ` The upload is the exception: if it does not finish (a timeout, a refusal, a closed terminal), ${plan.target} stays merged here, the card says the upload is pending, and "Entomatical: Upload to Vault" tries it again.` : "")];
            const yes = "Finish";
            const title = `Finish "${task.title}"?`;
            if ((await vscode.window.showWarningMessage(title, { modal: true, detail: lines.join("\n") }, yes)) !== yes) return false;
            return plan?.vault && !state.cleanupOnly ? { upload: true } : true; // FR2: the vault and its command were among the steps he just read
          }, (text) => progress.report({ message: text }), async (t) => { await closeClaudeTab(board, t); }, undefined, { pick: actionPicks.finish, ...(task.governed ? { authorize: governedAuthorization } : {}) }));
        if (notes) { await commentOnFinish(task, branch, reply); await appendOnFinish(task, branch, reply); }
        // FR2: a vault repo's Finish says where the work is: uploaded, or merged here with the upload pending (its note), which Upload to Vault tries again.
        const vault = notes ? task.vault : undefined;
        if (notes && vault && vault.state !== "uploaded") void vscode.window.showWarningMessage(`Entomatical: "${task.title}" is finished. ${notes.join(" ")}`, UPLOAD_TO_VAULT)
          .then((pick) => (pick ? uploadToVault(board, task) : undefined)).then(undefined, (e) => vscode.window.showErrorMessage(`Entomatical: ${e instanceof Error ? e.message : String(e)}`));
        else if (notes && notes.length) void vscode.window.showWarningMessage(`Entomatical: "${task.title}" is finished. ${notes.join(" ")}`);
        if (notes && vault?.state === "uploaded") void vscode.window.showInformationMessage(`Entomatical: "${task.title}" is finished. ${vaultStatus(vault)}`);
      } catch (e) {
        // the user, 11 November 2026: when the remote (GitHub) does not accept Finish, whatever the reason, the card's own session gets a
        // prompt Entomatical writes and asks him whether to fix the cause; it fixes nothing before he answers.
        if (e instanceof RemoteRefused && board.get(task.id) === task && task.worktree) {
          const prompt = refusalPrompt(task.title, task.branch ?? branch ?? "", e);
          try {
            await askCard(board, task, prompt);
            void vscode.window.showWarningMessage(`Entomatical: ${e.remoteRef} did not accept Finish of "${task.title}". Its session was asked whether to fix the cause; answer it there, then press Finish again. ${e.message}`);
            break;
          } catch (sent) {
            await vscode.env.clipboard.writeText(prompt);
            await vscode.window.showErrorMessage(`Entomatical: ${e.message} Its session could not be asked about it (${sent instanceof Error ? sent.message : String(sent)}). The prompt for it is on the clipboard.`, { modal: true });
            break;
          }
        }
        // Modal so a stopped Finish cannot be missed; handle()'s caller would show only a passing notification. Show log: F103.
        if (await vscode.window.showErrorMessage(`Entomatical: ${e instanceof Error ? e.message : String(e)}`, { modal: true }, SHOW_LOG) === SHOW_LOG) showErrorLog();
      }
      break;
    }
    case "discard": {
      board.mustOwn(); // before the question
      const ok = await vscode.window.showWarningMessage(`Throw away "${task.title}": its worktree and branch, including any uncommitted work?`, { modal: true }, "Discard");
      if (ok === "Discard") await board.finish(task, "discard");
      break;
    }
    case "done":
      // A checks-reviewed plan card runs no session by design: Finish merges its steps; "never started" misled (Windows, 5 November 2026).
      if (task.planRun?.review === "checks" && !board.everReady(task)) throw new Error("This plan card runs no session: the board checks its steps and merges them here. Press Finish when every step is Done.");
      // A cancelled card may go to Done: it keeps `cancelled`, so it still earns no completion credit (25 November 2026).
      if ((task.openedBy || task.orchestrator) && !task.cancelled && !board.everReady(task)) throw new Error("This card never started. Cancel it to preserve it without completion credit.");
      board.update(task, { status: "done" });
      break;
    case "cancel":
      if (board.live().includes(task.id)) throw new Error("Stop the card before cancelling it.");
      board.checks.stop(task);
      board.update(task, { cancelled: true, held: undefined, status: "review" }, undefined, true);
      break;
    case "approvePlan":
      if (m.caps && typeof m.caps === "object") {
        const values = m.caps as Record<string, unknown>;
        for (const key of ["open", "total", "depth", "pending", "watchers", "perWatcher"]) if ((values[key] !== undefined || ["open", "total", "depth"].includes(key)) && (!Number.isInteger(values[key]) || Number(values[key]) < 1 || (key === "depth" && Number(values[key]) > 8))) throw new Error("Run limits must be positive integers; depth is at most 8.");
        if (task.plan) board.update(task, { plan: { ...task.plan, caps: capsFrom({ ...task.orchestrator?.caps, ...task.plan.caps, ...values }) } });
      }
      // Phase 3: a governed run is the user's choice in this row; its limits have no defaults (O2) and its profiles are pinned now.
      if (m.governed !== undefined && m.governed !== null) {
        if (m.pressureWatchers === true) throw new Error("Pressure watchers are not supported in governed runs (phase 3); untick one of them.");
        board.govern(task, m.governed, (id) => pinProfile(profileFiles(board), id), (ref) => pinCouncil(councilFile(board), ref, (id) => pinProfile(profileFiles(board), id)));
      }
      await board.approvePlan(task, { pressureWatchers: m.pressureWatchers === true });
      break;
    case "editPlan":
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(board.planFile(task))), { preview: false });
      break;
    case "report": {
      const doc = await vscode.workspace.openTextDocument({ content: reportText(board, task), language: "markdown" });
      await vscode.window.showTextDocument(doc, { preview: true });
      break;
    }
    case "council":
      await councilAction(board, task);
      break;
    case "makeOrchestrator": {
      // F117: the board sends the brief; a session it cannot wake (a panel) reads it with board.js receive, so the user is told to say so.
      const sent = board.makeOrchestrator(task);
      vscode.window.showInformationMessage(`Entomatical: "${task.title}" can delegate after you approve its plan. ${sent ? "The board sent its session the instructions." : "The instructions are queued. A panel session can read them with node ~/.entomatical/board.js receive."}`);
      break;
    }
    case "pauseRun":
      board.pauseRun(task);
      break;
    case "resumeRun":
      board.resumeRun(task);
      break;
    case "stopRun": {
      const n = board.liveRun(task).length;
      if (!n) { vscode.window.showInformationMessage(`Entomatical: nothing in "${task.title}" is running.`); break; }
      const ok = await vscode.window.showWarningMessage(`Stop ${n} session${n === 1 ? "" : "s"} in "${task.title}"? Worktrees and branches are kept.`, { modal: true }, "Stop run");
      if (ok === "Stop run") board.stopRun(task);
      break;
    }
    case "archiveRun": {
      // F75: one dialog, then the board checks every card for unmerged work and refuses with the list (nothing moves then).
      board.mustOwn(); // before the question
      const n = 1 + (board.runSummaryOf(task)?.children.length ?? 0);
      const ok = await vscode.window.showWarningMessage(`Archive "${task.title}"? ${n} cards leave the board; nothing is deleted.`, { modal: true,
        detail: "Its cards move to .entomatical/archive with the run's report. Archived runs at the foot of the Done column can restore them." }, "Archive run");
      if (ok === "Archive run") await board.archiveRun(task);
      break;
    }
    case "reopen":
      board.update(task, { status: "review" });
      break;
    case "delete": {
      board.mustOwn(); // before the question, as Start and Switch account do (F45): a window that does not own the board changes nothing
      if (board.tasks.some((t) => t.parentId === task.id)) throw new Error("Delete its subtasks first."); // before the modal: remove() would say so only after the discard
      const keep = task.branch ? "Delete card, keep worktree" : "Delete";
      const choices = task.branch ? [keep, "Delete card and worktree"] : [keep];
      const detail = [task.branch && await board.hasUncommitted(task) && `Its worktree has uncommitted or untracked changes. "Delete card and worktree" throws them away; "Delete card, keep worktree" leaves them in ${task.worktree}.`].filter(Boolean).join("\n\n") || undefined;
      const ok = await vscode.window.showWarningMessage(`Delete "${task.title}" from the board?`, { modal: true, detail }, ...choices);
      if (!ok) break;
      if (ok === "Delete card and worktree") await board.finish(task, "discard");
      board.remove(task);
      break;
    }
  }
}

/** The orchestrator brief's text (docs/orchestrator/BRIEF.md, placed under ~/.entomatical), or a one-line stand-in when it is missing. */
/** The installed extension's folder (activate): Plan first's planning prompt names its shipped guide and schema by absolute path. */
let extensionRoot = "";
/**
 * Plan first's planning prompt (F99): docs/orchestrator/PLANNER.md with the guide, the plan schema and this repo's check catalogue as
 * absolute paths. Without a task, {{task}} stays for the Add task form's preview (media/board.js fills it as the user types).
 * Codex (the user, 12 November 2026) gets PLANNER-CODEX.md: no plan mode, so it is asked to wait for approval, and no F98 hook, so it
 * writes the file straight into the main checkout's workflows/.
 */
function plannerPrompt(repo: string | undefined, task?: string, codex = false): string {
  repo ??= ""; // never throw while the board's state is built
  const docs = path.join(extensionRoot, "docs");
  let template: string;
  try { template = fs.readFileSync(path.join(docs, "orchestrator", codex ? "PLANNER-CODEX.md" : "PLANNER.md"), "utf8"); }
  catch { template = `Plan this task. ${codex ? "Propose the plan and wait for approval before you write anything" : "Get the plan approved before you change anything"}. If the approved plan is a single step, write no plan file: do that step yourself in this session. With two or more steps, do not do the work: write it as an Entomatical plan file, ${codex ? "{{workflows}}" : "workflows"}/<name>.plan.json (format: {{schema}}; rules: {{guide}}; checks by name from {{checks}})${codex ? "" : " with the Write tool"}, and end by naming its path. When the user will repeat the task with different inputs, declare them as vars (see the rules); such a plan stays listed after it finishes.\n\nTask:\n\n{{task}}`; }
  return planningPrompt(template, { guide: path.join(docs, "agents", "README.md"), schema: path.join(docs, "agents", "schemas", "plan.schema.json"), checks: path.join(repo, "workflows", "checks.json"), workflows: path.join(repo, "workflows") }, task);
}
function readBrief(file: string): string {
  try { return fs.readFileSync(file, "utf8"); } catch { return `(The brief at ${file} could not be read. Use node ~/.entomatical/board.js --help for the verbs, plan first, and wait for approval.)`; }
}

const pointsLabel = (points?: number | null) => typeof points === "number" ? `${points} pp` : "unknown";

/** The run report (13.2 item 8): the master's final reply, each child's outcome and cost, and where the plan is. */
function reportText(board: Board, master: import("./board").Task): string {
  const run = board.runSummaryOf(master);
  const rows = (run?.children ?? []).map((c) => `| ${c.title} | ${c.id} | ${c.status}${c.interrupted ? " (interrupted)" : ""}${c.takenOver ? " (taken over)" : ""} | ${pointsLabel(c.points)} |`);
  return [`# Run report: ${master.title} (${master.id})`, "", `Plan: ${board.planFile(master)}`, "", "## Final reply", "", board.finalReply(master) ?? "(none yet)", "",
    "## Cards", "", "| Card | Id | Status | Cost |", "|---|---|---|---|", ...rows, "", `Total: ${run?.done ?? 0} done of ${run?.children.length ?? 0}, ${pointsLabel(run?.points)}.`, ""].join("\n");
}

/** the user, 28 Oct 2026: a call answered by a fallback account after a usage limit makes that account the default, so later calls start there. */
function useFallbackAccount(configDir: string, from: string, note?: string) {
  // The asked-for account answered (no fallback happened), or the answerer is already the default (another member or call switched it).
  // A panel row shows its own note, so only calls pass one.
  if (sameFolder(configDir, from) || sameFolder(configDir, activeConfigDir())) {
    if (note) void vscode.window.showInformationMessage(`Entomatical: ${note}`);
    return;
  }
  const name = (dir: string) => (dir ? path.basename(dir) : "~/.claude"); // the worker's note names accounts the same way
  void useAccount(configDir).then(() => vscode.window.showInformationMessage(`Entomatical: ${name(from)} hit a usage limit; ${name(configDir)} is now the default account.`),
    (e) => vscode.window.showWarningMessage(`Entomatical: ${name(configDir)} answered after a usage limit but could not become the default account. ${e instanceof Error ? e.message : e}`));
}

const isAcpProvider = (provider: unknown) => provider === "grok" || provider === "antigravity";

/**
 * A Grok or Antigravity account by name, for a helper call on that same account (orchestrator run 0db6d1): its provider, and its
 * folder (the Grok profile's GROK_HOME; "" for Antigravity's shared sign-in). Helpers there use the agent's default model.
 */
function acpAccountOf(board: Board | undefined, name: unknown) {
  const a = board?.accountList?.().find((x) => x.name === name && isAcpProvider(x.provider));
  return a ? { name: a.name, provider: a.provider as "grok" | "antigravity", configDir: a.configDir ?? "", via: { acp: a.provider as "grok" | "antigravity" } } : undefined;
}
const acpLabel = (provider: "grok" | "antigravity") => (provider === "grok" ? "Grok" : "Antigravity");
/** Where a helper call goes: the account's own ACP agent, the Codex CLI, or Claude (with its other accounts as usage-limit fallbacks). */
function helperRoute(board: Board, account: string | undefined, provider: string | undefined): { configDir: string; via?: TextVia; fallback: string[] } {
  const acp = acpAccountOf(board, account);
  if (acp) return { configDir: acp.configDir, via: acp.via, fallback: [] };
  const configDir = board.configDirOf({ account, provider } as Task);
  return provider === "codex" ? { configDir, via: codexTextPath(), fallback: [] } : { configDir, fallback: otherAccountDirs(configDir) };
}
/** The Grok and Antigravity accounts, for helperPolicy. */
const acpHelperAccounts = (board: Board | undefined) =>
  (board?.accountList?.() ?? []).filter((a) => isAcpProvider(a.provider)).map((a) => ({ name: a.name, provider: a.provider as "grok" | "antigravity" }));

/** The Claude IDE default account's name: the board's default for new Claude chats. */
function claudeDefaultName(): string | undefined {
  return accounts().find((a) => !a.provider && sameFolder(a.configDir ?? "", activeConfigDir()))?.name;
}

/** Each Grok or Antigravity account's last advertised model and effort choices, as [id, label] pairs, for the new-task form's menus. */
function acpCatalogsOf(board: Board) {
  const out: Record<string, { at: string; models: [string, string][]; newest: [string, string][]; efforts: [string, string][]; ask: string | null }> = {};
  for (const a of board.accountList()) {
    if (!isAcpProvider(a.provider)) continue;
    const seen = board.acpCatalog(a);
    if (!seen) continue;
    const pairs = (category: string): [string, string][] => seen.options.find((o) => o.category === category)?.values.map((v): [string, string] => [v.value, v.name]) ?? [];
    // ask: the advertised mode an unattended Ask card runs in, or null when the account advertises none (Ask is refused there).
    // newest: the helper picks' list (Review, Improve): the newest version of each name, and ids of no known shape as they are (F123).
    const models = pairs("model"), ids = models.map(([v]) => v);
    const newest = models.filter(([v]) => { const p = parseModel(a.provider!, v); return !p?.version.length || newestOf(a.provider!, p.family, ids) === v; });
    out[a.name] = { at: seen.at, models, newest, efforts: pairs("thought_level"), ask: board.acpAskMode(a) ?? null };
  }
  return out;
}

/** The helpers' fixed model per provider, for the board's selection line. Codex is undefined when no Codex account or Astra model is known. */
function helperModels(): { claude: string; codex?: string } {
  const out: { claude: string; codex?: string } = { claude: `${helperName("fable")} · max effort` };
  const codex = codexAccounts()[0];
  if (codex) { try { const p = helperPolicy(codex.name, [], { accounts: [codex.name], models: codexModels() }); out.codex = `${modelLabel("codex", p.model)} · ${p.effort} effort`; } catch { /* no Astra listed */ } }
  return out;
}

/**
 * Who will read an improved prompt (compile.ts compilePrompt, EXECUTOR): for a card's follow-up box, that task's own live session;
 * otherwise the new task the form's account and model will start. A Codex first turn runs unattended and cannot ask mid-turn.
 */
function executorLine(board: Board, m: Record<string, unknown>): string {
  const task = typeof m.id === "string" ? board.get(m.id) : undefined;
  if (task) {
    return `The next message to the live ${task.provider === "codex" ? "Codex CLI" : task.provider === "grok" ? "Grok CLI" : task.provider === "antigravity" ? "Antigravity CLI" : "Claude Code"} session${task.model ? ` (${task.model})` : ""} of the task "${task.title}". `
      + "That session already has the task's prompt, its worktree and the conversation so far: keep references to them as written, do not list them as unresolved, and keep the message as short as the request.";
  }
  const model = typeof m.model === "string" && m.model ? ` (${m.model})` : "";
  const acp = board.accountList?.().find((a) => a.name === m.account && isAcpProvider(a.provider));
  if (acp) return `A new ${acp.provider === "grok" ? "Grok" : "Antigravity"} CLI session${model} working in its own git worktree of the user's repository. It can ask the user while it works in its terminal; an orchestrated or plan worker runs unattended and cannot.`;
  return codexAccounts().some((a) => a.name === m.account)
    ? `A new Codex CLI session${model} working in its own git worktree of the user's repository. Its first turn runs unattended and cannot ask the user anything until it ends, so a must-ask matter means finishing the unaffected work and ending the turn with the question.`
    : `A new Claude Code session${model} working in its own git worktree of the user's repository. It can ask the user while it works.`;
}

/** The Claude models and efforts a title or Done when may run on, picked on the add-task toggles' drop-downs (the user, 13 November 2026). */
const HELPER_MODELS = ["haiku", "opus", "fable"], HELPER_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const TITLE_DEFAULT = { model: "haiku", effort: "low" }, RULE_DEFAULT = { model: "fable", effort: "high" };
type HelperPick = typeof TITLE_DEFAULT;
/** A model and effort from the form, each one only from the lists above; anything else is the default. */
function helperPick(model: unknown, effort: unknown, fallback: HelperPick): HelperPick {
  return { model: HELPER_MODELS.includes(model as string) ? model as string : fallback.model, effort: HELPER_EFFORTS.includes(effort as string) ? effort as string : fallback.effort };
}
/** "Fable 5.2": the helper's model with the version it runs now. */
function helperName(model: string) { return modelLabel("claude", claudeModelId(model)); }

/**
 * Before a new card exists, Fable at high effort, or the model and effort picked on the form, writes its completion rule
 * (text-actions.ts completionRule). A rule that cannot be written leaves the task without one and says why; Cancel puts the text back in the form.
 */
async function prepareRule(board: Board, prompt: string, account: string, commands: boolean, pick: HelperPick = RULE_DEFAULT) {
  // Fable is a Claude model: a Codex task's rule is written on the Claude IDE default account, as Generate title does. A Grok or
  // Antigravity task's rule is written on its own account with the agent's default model (run 0db6d1), whatever was picked.
  const acp = acpAccountOf(board, account);
  const chosen = accounts().find((a) => a.name === account);
  const configDir = acp ? acp.configDir : chosen && !chosen.provider ? board.configDirOf({ account } as import("./board").Task) : activeConfigDir();
  const fallback = acp ? [] : otherAccountDirs(configDir), dir = path.join(board.dir, "helpers", crypto.randomUUID());
  const name = helperName(pick.model);
  const writer = acp ? `the agent's default model on ${acp.name}` : `${name} at ${pick.effort} effort`;
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true, title: `Entomatical: Done when, ${writer}` }, async (progress, token) => {
    const controller = new AbortController(), cancel = token.onCancellationRequested(() => controller.abort());
    const timer = setTimeout(() => controller.abort(), 900_000); // keep the existing deadline for slow calls and account retries
    try {
      const r = await completionRule(path.join(dir, "rule"), prompt, projectContext(board.repo), { configDir, fallbackConfigDirs: fallback, ...(acp ? { via: acp.via } : pick) }, controller.signal,
        (step) => progress.report({ message: step }), commands);
      const last = r.answered.at(-1); // a call another account answered after a usage limit
      if (last) useFallbackAccount(last.configDir, configDir, last.note);
      void vscode.window.showInformationMessage(acp ? `Entomatical: ${acpLabel(acp.provider)} wrote when the task is done on ${acp.name}.` : `Entomatical: ${name} wrote when the task is done at ${pick.effort} effort.`);
      if (commands && r.dropped.length) void vscode.window.showWarningMessage(`Entomatical: these check commands could change files or reach the network, so they were left out: ${r.dropped.join(" · ")}`);
      // The check catalogue (F76): with workflows/checks.json in the repo, only its commands may be checks.
      const { kept, refused } = limitToCatalogue(r.rule.commands, readCatalogue(board.repo));
      if (commands && refused.length) void vscode.window.showWarningMessage(`Entomatical: these checks are not in workflows/checks.json, so they were left out: ${refused.join(" · ")}`);
      const rule = { ...r.rule, commands: kept };
      const completion: import("./board").Task["completion"] = { commands: rule.commands, doneWhen: rule.doneWhen, goal: rule.goal, writer: r.writer, effort: r.effort, ...(r.rule.promptVersion ? { promptVersion: r.rule.promptVersion } : {}) };
      return { prompt: withRule(prompt, rule), completion };
    } catch (e) {
      if (controller.signal.aborted) throw new Error(token.isCancellationRequested ? "Cancelled; the prompt is back in the form." : "Writing the Done when timed out; the prompt is back in the form.");
      void vscode.window.showWarningMessage(`Entomatical: the task starts without a Done when. ${e instanceof Error ? e.message : String(e)}`);
      return { prompt, completion: undefined };
    } finally { clearTimeout(timer); cancel.dispose(); }
  });
}

/**
 * Fable's second look once the work reached Review (after its checks, or at once when it has none): was Haiku's rule good enough next to
 * Opus's, given the actual work? The verdict lands in the card's completion-rule panel. Only tasks whose rule Haiku and Opus both wrote.
 */
async function reviewRule(board: Board, task: import("./board").Task, checks: string) {
  const c = task.completion;
  if (!c?.haiku || !c.opus || !task.worktree) return;
  const acp = acpAccountOf(board, task.account);
  const configDir = acp ? acp.configDir : task.provider ? activeConfigDir() : board.configDirOf(task);
  const at = new Date().toISOString();
  const save = (review: NonNullable<typeof c.review>) => { const now = board.get(task.id); if (now?.completion) board.update(now, { completion: { ...now.completion, review } }); };
  try {
    const r = await reviewRules(path.join(board.dir, "helpers", crypto.randomUUID()), { prompt: task.prompt, haiku: c.haiku, opus: c.opus, pick: c.judgment?.pick, checks, work: await workSummary(board, task) },
      acp ? { configDir, fallbackConfigDirs: [], via: acp.via } : { configDir, fallbackConfigDirs: otherAccountDirs(configDir) }, new AbortController().signal);
    if (r.note) useFallbackAccount(r.configDir ?? "", configDir, r.note);
    save({ haikuGoodEnough: r.haikuGoodEnough, verdict: r.verdict, model: r.model, at, checks });
  } catch (e) {
    save({ error: e instanceof Error ? e.message : String(e), at, checks });
  }
}

/** Each running review's call, by card id. An abort's reason is the text the card shows. */
const reviews = new Map<string, AbortController>();
/** Cards whose Accept prompt is being sent. */
const accepting = new Set<string>();
const REVIEW_CANCELLED = "Review cancelled.";
const REVIEW_TIMEOUT = "Stopped after fifteen minutes without an answer.";
const REVIEW_BATTLE = "Stopped for Battle Royale. Press Review to run it again.";
/** A Review refused before it starts (another window owns the board, canReview's reasons): an error log line (F103), then the error to throw. */
function refuseReview(board: Board, task: Task, e: unknown): unknown {
  startRun(board.dir, "review", { id: task.id, title: task.title }, { provider: task.provider ?? "claude", account: task.account }, "Checking the card").failed(e, { outcome: "refused" });
  return e;
}

/**
 * Review (F97): the reviewer reads the card's work against its Done when, on the card's account (src/done-review.ts). The card shows the
 * run while it goes (doneReviewRun), then keeps the newest verdict (doneReview) with its MD file and receipt; a failed or cancelled run
 * keeps the last verdict and shows its error. The input is gathered first, so a card whose worktree is gone changes nothing. A manual
 * Review shows in its own helper tab and resets the automatic rounds; auto (an orchestrator's finish) has no tab.
 */
async function runDoneReview(board: Board, task: Task, opts: { auto: boolean; answers?: string }): Promise<DoneReview> {
  // F103: every way a review ends without a verdict is a line in the board's errors.jsonl, with the stage it reached.
  const log = startRun(board.dir, "review", { id: task.id, title: task.title }, { provider: task.provider ?? "claude", account: task.account },
    `${opts.auto ? "Automatic review: c" : "C"}hoosing the reviewer`);
  try { const review = await reviewSteps(board, task, opts, log); log.end(); return review; }
  catch (e) { if (!wasLogged(e)) log.failed(e); throw e; }
}
async function reviewSteps(board: Board, task: Task, opts: { auto: boolean; answers?: string }, log: RunLog): Promise<DoneReview> {
  const stage = (name: string) => log.stage(`${opts.auto ? "Automatic review: " : ""}${name}`);
  // F102: the Review button's right-click pick may name another signed-in account, and a model and effort for its provider.
  const account = pickedAccount(board, "review", task.account) as string | undefined;
  const provider = account === task.account ? task.provider : board.accountList().find((a) => a.name === account)?.provider as Task["provider"];
  log.set({ provider: provider ?? "claude", account });
  // A Grok or Antigravity card runs on its own account: never on the Claude default helperRoute would fall back to.
  if (isAcpProvider(provider) && !acpAccountOf(board, account)) throw new Error(`This card's ${acpLabel(provider as "grok" | "antigravity")} account is not set up, so it cannot be reviewed.`);
  const { model, effort } = reviewerModel(provider, codexModels(), actionPicks.review);
  log.set({ model: model || "(the agent's default)", effort: effort || "(default)" });
  if (reviews.has(task.id)) throw new Error("A review of this card is already running.");
  const controller = new AbortController();
  reviews.set(task.id, controller);
  // Taken just before the input is gathered: an edit made meanwhile makes it differ, never match (autoFinish then reviews again).
  // Only autoFinish reads it, and it finishes only a run's master, so no other card pays for it.
  stage("Gathering the work");
  const snapshot = task.worktree && isTop(task) ? await worktreeSnapshot(task.worktree).catch(() => undefined) : undefined;
  const input = await reviewInput(board, task, opts.answers).catch((e) => { reviews.delete(task.id); throw e; });
  const requestId = crypto.randomUUID(), at = new Date().toISOString();
  const timer = setTimeout(() => controller.abort(REVIEW_TIMEOUT), 900_000);
  let tab: ReturnType<HelperTabs["start"]> | undefined;
  try {
    // The card as it is after gathering. A manual Review resets the automatic rounds (AUTO_ROUNDS, Task 7).
    const current = board.get(task.id) ?? task;
    board.update(current, { doneReviewRun: { requestId, at, model, effort }, ...(opts.auto ? {} : { autoRounds: 0, mergeRetries: 0 }),
      ...(!opts.auto && current.selfFinish?.error === FINISH_REVIEW_INTERRUPTED ? { selfFinish: undefined } : {}) });
    const prompt = reviewPrompt(input), route = { model, effort, ...helperRoute(board, account, provider) };
    if (!opts.auto) {
      tab = tabs().start(`${task.id}:work`, { requestId, kind: "work", target: task.id, title: helperTitle("work", task.title), draft: "", answers: opts.answers ?? "",
        detail: [model ? `${model} · ${effort} effort` : "Uses the agent's default model", account].filter(Boolean).join(" · "), cancel: () => controller.abort(REVIEW_CANCELLED) });
      tab.prompt(prompt);
    }
    const helperDir = path.join(board.dir, "helpers", crypto.randomUUID());
    stage("Calling the reviewer");
    log.set({ receipt: path.join(helperDir, "review-receipt.json") });
    const r = await reviewWork(helperDir, prompt, route, controller.signal, { input, provider }, tab?.line);
    stage("Writing the review");
    log.set({ receipt: r.receipt });
    if (r.note) { useFallbackAccount(r.configDir ?? "", route.configDir, r.note); tab?.line(r.note); }
    const markdown = reviewMarkdown(task, r.result, { model: r.model, effort, at, input });
    const review: DoneReview = { ...r.result, file: writeReview(board.dir, task.id, at, markdown), model: r.model, effort, at, receipt: r.receipt, ...(snapshot ? { snapshot } : {}) };
    const now = board.get(task.id); // the card as it is now: it may have been reloaded or deleted meanwhile
    if (now) {
      if (now.doneReview?.receipt) recordDecision(now.doneReview.receipt, "superseded");
      board.update(now, { doneReview: review, doneReviewRun: undefined });
    }
    tab?.finish({ text: markdown, notes: [] }, r.model);
    return review;
  } catch (e) {
    const reason = controller.signal.reason;
    const error = controller.signal.aborted && typeof reason === "string" ? reason : e instanceof Error ? e.message : String(e);
    tab?.fail(error, reason === REVIEW_CANCELLED || reason === REVIEW_BATTLE);
    const now = board.get(task.id);
    if (now?.doneReviewRun?.requestId === requestId) board.update(now, { doneReviewRun: { ...now.doneReviewRun, error } });
    // Logged with the runner's own error (its exit code and stderr), not the card's text alone; a cancel (Battle Royale's stop too) is an info line.
    const outcome = !controller.signal.aborted ? undefined : reason === REVIEW_CANCELLED || reason === REVIEW_BATTLE ? "cancelled" : reason === REVIEW_INTERRUPTED ? "interrupted" : reason === REVIEW_TIMEOUT ? "timeout" : undefined;
    log.failed(e, { message: error, ...(outcome ? { outcome } : {}) });
    throw Object.assign(new Error(error), { logged: true });
  } finally { clearTimeout(timer); reviews.delete(task.id); }
}

/**
 * The work in the task's worktree since its branch point, as a helper at Review reads it: the Review button's own gathering
 * (done-review.ts), so a card whose commits are already in main still shows them and never another card's, within 24,000 characters of
 * diff and new files. New files nobody added are read too, up to 4,000 characters each: a session that stops without committing
 * leaves its new files that way.
 */
async function workSummary(board: Board, task: import("./board").Task) {
  try {
    const { base, own } = await cardWork(board, task);
    const work = await gatherWork(task.worktree!, base, task.prompt, { diff: 24_000, untracked: 4_000 }, own);
    return [work.summary, "(CUT: files too large to show here.)", `Diff:\n${work.diff || "none"}`, ...(work.untracked ? [`New files:\n${work.untracked}`] : [])].join("\n\n");
  } catch (e) {
    return `(the work could not be read: ${e instanceof Error ? e.message : e})`;
  }
}

/**
 * Names a new untitled task before its first start: Haiku at low effort (or the model and effort picked on the form) for a Claude task,
 * the newest Luna model at low effort for a Codex one. The board keeps the prompt's first line as the title when the helper fails or
 * takes longer than 45 s; the task starts either way.
 */
async function autoTitle(board: Board, task: import("./board").Task, pick: HelperPick = TITLE_DEFAULT) {
  const title = await titleFor(board, task, pick);
  const current = board.get(task.id);
  if (title !== undefined && current && !current.named) board.update(current, { title, named: true }); // a Rename meanwhile wins
}

/** The title a helper writes for a task's prompt on the task's account (autoTitle), or undefined after a warning when it fails. */
async function titleFor(board: Board, task: import("./board").Task, pick: HelperPick): Promise<string | undefined> {
  // A Grok or Antigravity task is named on its own account with the agent's default model and effort (run 0db6d1).
  const codex = task.provider === "codex", acp = acpAccountOf(board, task.account);
  const namer = codex ? "Luna" : acp ? acp.name : helperName(pick.model);
  const status = vscode.window.setStatusBarMessage?.(`Entomatical: naming the task with ${codex || acp ? namer : `${namer} at ${pick.effort} effort`}…`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const dir = path.join(board.dir, "helpers", crypto.randomUUID());
    const configDir = codex ? "" : acp ? acp.configDir : board.configDirOf(task);
    const model = codex ? lunaModel() : acp ? "" : pick.model;
    const result = await generateText(dir, "title", task.prompt.slice(0, 5000), configDir, model, "", controller.signal, acp ? undefined : codex ? "low" : pick.effort,
      codex ? codexTextPath() : acp?.via, codex || acp ? [] : otherAccountDirs(configDir));
    if (result.note) useFallbackAccount(result.configDir ?? "", configDir, result.note);
    return result.value.title;
  } catch (e) {
    vscode.window.showWarningMessage(`Entomatical: the task starts under its prompt's first line; ${namer} did not name it. ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  } finally { clearTimeout(timer); status?.dispose(); }
}

/** The newest Luna model the signed-in Codex CLI offers (gpt-6-luna over gpt-5.6-luna on 30 October 2026), versions compared as numbers (fix 11). */
function lunaModel(): string {
  const found = tryResolve("codex", "luna", codexModels().map((m) => m.model));
  if (!found) throw new Error("The signed-in Codex CLI did not advertise a Luna model.");
  return found;
}

async function applyGeneratedTitle(board: Board, task: import("./board").Task, title: string) {
  if (!board.isOwner()) throw new Error("Board ownership changed; the generated title was not applied.");
  // A Grok or Antigravity session has no Claude saved session or /rename: only the board title changes.
  if (!task.sessionId || task.provider === "codex" || task.provider === "grok" || task.provider === "antigravity") { board.update(task, { title, named: true }); await board.nameThread(task); return; }
  if (task.status === "running" || task.status === "needs-input") throw new Error("The session became busy; retry the title when it is idle.");
  const terminal = board.terminal(task);
  if (terminal) terminal.sendText(paste(`/rename ${title}`), false);
  else await renameSavedSession(task.worktree && fs.existsSync(task.worktree) ? task.worktree : board.repo, board.configDirOf(task), task.sessionId, title);
  const file = board.transcriptOf(task);
  for (let i = 0; i < 30; i++) {
    if (file && sessionTitle(file) === title) { board.update(task, { title, named: true }); return; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("The native title change was not confirmed. The board title was left unchanged; use manual Rename.");
}

const WIN = process.platform === "win32";
const LINUX = process.platform === "linux";
// The panel wrapper (wrapper/entomatical-claude.js; on Windows started by the wrapper/launcher.cs .exe beside it) lives at a fixed path so the Claude Code setting survives Entomatical updates.
const WRAPPER = path.join(os.homedir(), ".entomatical", WIN ? "entomatical-claude.exe" : "entomatical-claude");
// [bundled file in wrapper/, where it goes]. The Windows launcher starts the .js beside itself.
const WRAPPER_FILES: [string, string][] = WIN
  ? [["entomatical-claude.exe", WRAPPER], ["entomatical-claude.js", path.join(path.dirname(WRAPPER), "entomatical-claude.js")]]
  : [["entomatical-claude.js", WRAPPER]];
// The claudeProcessWrapper value from before Entomatical's, which entomatical-claude.js starts claude through.
const INNER = path.join(path.dirname(WRAPPER), "inner-wrapper");
let state: vscode.Memento;
/** The right-click picks of the buttons that call a helper model (F102, src/action-picks.ts), kept per profile in globalState. */
let actionPicks: ActionPicks = {};
/** The account an action's pick names while it is still on the board; else the action's own account (the form's, or the card's). */
function pickedAccount(board: Board | undefined, action: ActionKey, own: unknown): unknown {
  const named = actionPicks[action]?.account;
  return named && (board?.accountList?.() ?? []).some((a) => a.name === named) ? named : own;
}

/**
 * In an Extension Development Host that does not place files: this build's own bundled wrapper (<extension>/wrapper). Set by hand as
 * claudeProcessWrapper in the dev host's profile, it is used as it is, so a check runs the worktree's wrapper; Entomatical never sets it
 * itself, so a dev host on the real profile still leaves the user's setting on ~/.entomatical. Before 5 November 2026 it was taken
 * for a retired build's wrapper and replaced by the installed one (run d60bfd, F58/F81). On Linux set it through an extensionless
 * symlink: the Claude extension runs a wrapper named *.js with node, claude first (2.1.318, 6 November 2026, F78 evidence).
 */
let devWrapper: string | undefined;
/**
 * Whether two paths name the same file. On Windows in any case: VS Code hands the extension its path with a lower-case drive
 * letter (c:\Users\…) while a setting typed by hand says C:\, and fs.realpathSync keeps the case it was given (seen 5 November
 * 2026 in a dev host: the worktree wrapper was still taken for a retired one). realpathSync.native gives the file's own case.
 */
function sameFile(a: string, b: string) {
  const norm = (p: string) => { let r: string; try { r = fs.realpathSync.native(p); } catch { r = path.resolve(p); } return WIN ? r.toLowerCase() : r; };
  return norm(a) === norm(b);
}
const isDevWrapper = (w: string | undefined) => !!w && !!devWrapper && sameFile(w, devWrapper);
/** True when this build's wrapper is the claudeProcessWrapper setting. */
const wrapperIsOn = () => {
  const w = vscode.workspace.getConfiguration("claudeCode").get<string>("claudeProcessWrapper");
  return w === WRAPPER || isDevWrapper(w);
};
/**
 * A retired Entomatical build's wrapper: named like ours, in another folder (the speech edition retired on 2 November 2026 left one in
 * ~/.entomatical-speech). Never started, since it would start ours again forever; setPanel replaces it with ours.
 */
const isRetiredWrapper = (w: string) => path.basename(w).startsWith("entomatical-claude") && !isOwnWrapper(w) && !isDevWrapper(w);
/** What the inner-wrapper file beside a wrapper names, or "" when there is none. */
function innerOf(wrapper: string): string {
  try {
    return fs.readFileSync(path.join(path.dirname(wrapper), "inner-wrapper"), "utf8").trim();
  } catch {
    return "";
  }
}
// Claude Code 2.1.312 follows the folder its sign-in check reports only when no process wrapper is set. With ours its session list reads
// its own process environment, not the claudeCode.environmentVariables setting, so a session missing there opens as a blank new chat.
const panelHistoryDir = () => (wrapperIsOn() ? process.env.CLAUDE_CONFIG_DIR || DEFAULT_DIR : activeConfigDir() || DEFAULT_DIR);

/**
 * Whether this build replaces the machine-wide files in ~/.entomatical (panel wrapper, hook scripts, codex-hook.js). An Extension
 * Development Host isolates only its --user-data-dir, so it would overwrite the installed build's copies; ENTOMATICAL_PLACE_FILES=1 lets it.
 */
const placesFiles = (mode: vscode.ExtensionMode) => mode === vscode.ExtensionMode.Production || process.env.ENTOMATICAL_PLACE_FILES === "1";

/**
 * Copies each bundled wrapper file into place when it differs. Elsewhere through a temp file renamed over the old copy, so a panel
 * starting meanwhile finds one or the other. On Windows a running .exe can't be overwritten but can be renamed, so the new one is
 * copied beside it and swapped in (swapWrapper); leftovers are deleted once no panel uses them. A failure is one warning: activation goes on with the old copy.
 */
/**
 * Windows: copies to `<target>.new` first, then moves the old copy to `old` and the new one into place, so a failed copy or rename
 * never leaves no wrapper (audit, 10 November 2026). A failure throws after putting the old copy back and removing the `.new`.
 */
function swapWrapper(bundled: string, target: string, old: string, f: Pick<typeof fs, "copyFileSync" | "renameSync" | "rmSync" | "existsSync"> = fs) {
  const fresh = `${target}.new`;
  let moved = false;
  try {
    f.copyFileSync(bundled, fresh);
    if (f.existsSync(target)) {
      f.renameSync(target, old);
      moved = true;
    }
    f.renameSync(fresh, target);
  } catch (e) {
    if (moved) f.renameSync(old, target);
    f.rmSync(fresh, { force: true });
    throw e;
  }
}

function placeWrapper(extensionPath: string) {
  try {
    const dir = path.dirname(WRAPPER);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir).filter((f) => f.startsWith("entomatical-claude.old-"))) {
      try {
        fs.rmSync(path.join(dir, f));
      } catch {
        // still running
      }
    }
    for (const [name, target] of WRAPPER_FILES) {
      const bundled = path.join(extensionPath, "wrapper", name);
      if (!fs.existsSync(bundled)) continue;
      const same = fs.existsSync(target) && fs.readFileSync(target).equals(fs.readFileSync(bundled));
      if (WIN) {
        if (same) continue;
        swapWrapper(bundled, target, path.join(dir, `entomatical-claude.old-${Date.now()}${path.extname(target)}`));
      } else if (same) fs.chmodSync(target, 0o755); // a copy that lost its execute bit
      else {
        const tmp = `${target}.${process.pid}.tmp`;
        try {
          fs.copyFileSync(bundled, tmp);
          fs.chmodSync(tmp, 0o755); // the .vsix does not keep the execute bit
          fs.renameSync(tmp, target);
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      }
    }
  } catch (e) {
    void vscode.window.showWarningMessage(`Entomatical: could not update the panel wrapper in ${path.dirname(WRAPPER)} (${e instanceof Error ? e.message : e}). Panel sessions use the copy already there.`);
  }
}

/**
 * WSL mode is on, but WSL did not answer at activation. Codex starts fail with WSL_NOT_ANSWERING (codex.ts) while this checks WSL
 * every 30 seconds without blocking the window. Once WSL answers, the window must reload: the board read Codex's home at activation.
 */
function waitForCodexWsl(context: vscode.ExtensionContext) {
  awaitCodexWsl();
  let stopped = false, wake = () => {};
  context.subscriptions.push({ dispose: () => { stopped = true; wake(); } });
  void vscode.window.showErrorMessage(`Entomatical: ${WSL_NOT_ANSWERING}`, "Check Now").then((pick) => { if (pick) wake(); });
  void (async () => {
    while (!stopped) {
      await new Promise<void>((ok) => { const t = setTimeout(ok, 30_000); wake = () => { clearTimeout(t); ok(); }; });
      if (stopped) return;
      const found = await findCodexWslLater();
      if (!found || stopped) continue;
      const pick = await vscode.window.showInformationMessage(`Entomatical: WSL (${found.distro}) answers again. Reload the window to run Codex tasks there.`, "Reload Window");
      if (pick) void vscode.commands.executeCommand("workbench.action.reloadWindow");
      return;
    }
  })();
}

/**
 * Logs the Codex Entomatical runs and its version, and warns when chatgpt.cliExecutable is unset (so the Codex extension runs its bundled
 * copy) and that copy's version differs: two CLI versions then share ~/.codex. Runs after activation, never holding it up.
 * The warning's button writes that setting for the user (it is an application setting, so never a workspace's); the settings
 * listener in activate() then offers Reload Window.
 */
export async function noteCodexVersion(via: string, unset: boolean) {
  const run = codexCommand(["--version"]);
  const ours = await codexVersion(run.file, run.args);
  console.log(`Entomatical: Codex runs ${codexTextPath()} (${via}), ${ours ?? "which gave no version"}`);
  if (!unset || !ours || codexWsl()) return; // in WSL the Codex extension runs WSL's codex too, not its bundled one
  const bundled = bundledCodex(vscode.extensions.getExtension("openai.chatgpt")?.extensionPath);
  const theirs = bundled && (await codexVersion(bundled));
  if (!theirs || theirs === ours) return;
  const set = "Set chatgpt.cliExecutable";
  const pick = await vscode.window.showWarningMessage(`Entomatical: Codex tasks run ${ours} (${run.file}), but the Codex extension runs its bundled ${theirs}. Set chatgpt.cliExecutable to ${run.file} so both run the same Codex.`, set);
  if (pick !== set) return;
  try { await vscode.workspace.getConfiguration("chatgpt").update("cliExecutable", run.file, vscode.ConfigurationTarget.Global); }
  catch (e) { void vscode.window.showErrorMessage(`Entomatical: chatgpt.cliExecutable was not set: ${e instanceof Error ? e.message : e}`); }
}

/** Cards being named before their automatic start (F53): a Start pressed meanwhile waits for that start instead. */
const naming = new Set<string>();

/** Keep repeated clicks from dispatching a second continuation while the first is being acknowledged. */
const resuming = new Set<string>();
async function resumeTask(board: Board, task: Task): Promise<"pending" | "opened" | "start" | "continued"> {
  if (resuming.has(task.id)) return "pending";
  board.mustOwn();
  resuming.add(task.id); board.refresh();
  try {
    board.reconcile(task);
    if (board.resetUnstarted(task)) {
      await handle(board, { type: "start", id: task.id }); // Start owns the first turn's launch receipt.
      return "start";
    }
    const found = task.sessionId ? board.external.get(task.sessionId) : undefined;
    const busy = found?.status === "busy", waiting = found?.status === "waiting";
    if (busy || waiting || board.waitingToStart(task) || task.status === "needs-input" || task.status === "running" && board.live().includes(task.id)) {
      if (busy || waiting) board.update(task, { status: waiting ? "needs-input" : "running", interrupted: undefined });
      await handle(board, { type: "open", id: task.id });
      return "opened";
    }
    if (task.headless && !task.takenOver) board.update(task, { headless: undefined, takenOver: true });
    // An orchestrator resumes in a board terminal, where the board can type its notices (Board.canDeliver); the panel takes none. One
    // whose session is live in the panel now (Make orchestrator on a panel card, F117) stays there.
    const panel = !board.terminal(task) && !task.cardTerminal && !(task.orchestrator && !found) && wrapperIsOn() && board.canResumeInPanel(task) ? async () => {
      // Claude ignores initialPrompt on an already-open tab. End only this window's idle session and reopen its saved conversation.
      if (found) {
        if (!(await ancestors(found.pid)).includes(process.pid)) throw new Error("This session is open in another window. Resume it there.");
        board.killSession(task);
        if (!await board.ended(task)) throw new Error("The idle session did not close. Open it to check before resuming.");
      }
      const tabs = await closeClaudeTab(board, task);
      if (tabs > 1) throw new Error("More than one Claude tab matches this card. Close its old tab, then Resume.");
      await board.openInPanel(task, panelHistoryDir(), "Resume.");
    } : undefined;
    await board.continueTask(task, panel);
    return "continued";
  } finally {
    resuming.delete(task.id); board.refresh();
  }
}

/**
 * Fix it (F06) and Accept prompt (F97): the prompt goes to the task's session (Board.sendPrompt). One the board cannot type into gets it
 * on the clipboard, and is opened.
 */
async function sendOrPaste(board: Board, task: Task, prompt: string, what = "the fix prompt"): Promise<"sent" | "copied"> {
  if (await board.sendPrompt(task, prompt) !== "paste") return "sent";
  await vscode.env.clipboard.writeText(prompt);
  if (task.sessionId && wrapperIsOn() && board.canResumeInPanel(task) && task.panel) await board.openInPanel(task, panelHistoryDir());
  else if (task.codexEditor && task.sessionId) await board.resume(task);
  void vscode.window.showInformationMessage(`Entomatical: ${what} for "${task.title}" is on the clipboard. Paste it into its session.`);
  return "copied";
}

/**
 * A prompt Entomatical wrote goes into the card's own session, which Finish closed (F60, the remote refused). Grok, Antigravity and
 * hidden cards get a headless follow-up; a live terminal gets it typed; a Claude panel card is reopened in the panel, the wrapper
 * sending the prompt; every other card (Claude or Codex terminal, card terminal, Codex's editor) is resumed with it. Throws when
 * it cannot be sent.
 */
async function askCard(board: Board, task: Task, prompt: string): Promise<void> {
  board.mustOwn();
  if (!task.sessionId) throw new Error("it has no session");
  if (task.provider === "grok" || task.provider === "antigravity" || (task.headless && !task.takenOver)) { await board.followUpHeadless(task, prompt); return; }
  if (board.terminal(task)) { await board.send(task, prompt); return; }
  if (task.panel && !task.cardTerminal && wrapperIsOn() && board.canResumeInPanel(task)) {
    if (await closeClaudeTab(board, task) > 1) throw new Error("more than one Claude tab matches this card");
    await board.openInPanel(task, panelHistoryDir(), prompt);
    return;
  }
  (await board.resume(task, prompt))?.show(false);
}

/** True when a wrapper path is Entomatical's own (which, started through itself, would loop forever). */
function isOwnWrapper(wrapper: string) {
  return path.resolve(wrapper) === WRAPPER || sameFile(wrapper, WRAPPER);
}

/**
 * Turns the panel wrapper on or off. A wrapper set before it (e.g. a memory-cap launcher) is kept in the chain and put back on off.
 * claudeProcessWrapper is a per-profile setting, but INNER is one file for the whole machine, so it is only ever set to a real
 * wrapper: a profile with none set must not clear the one another profile's sessions rely on. What this profile had before
 * is kept in its own globalState (per profile), so off puts back exactly that and never removes a wrapper the user set.
 */
async function setPanel(on: boolean) {
  if (on && wrapperIsOn()) return void (await state.update("panelDeclined", false)); // already ours, or the dev host's own wrapper
  if (on && !fs.existsSync(WRAPPER)) throw new Error(`The panel wrapper is missing at ${WRAPPER}. Only an installed Entomatical places it; in an Extension Development Host set ENTOMATICAL_PLACE_FILES=1.`);
  const config = vscode.workspace.getConfiguration("claudeCode");
  const current = config.get<string>("claudeProcessWrapper");
  if (on && current !== WRAPPER) {
    let earlier = current?.trim() ?? "";
    // A retired build's wrapper is dropped; what it kept inside it is what this profile had before any Entomatical.
    for (let i = 0; earlier && isRetiredWrapper(earlier) && i < 8; i++) earlier = innerOf(earlier);
    if (earlier && isOwnWrapper(earlier)) earlier = "";
    await state.update("wrapperBefore", earlier);
    if (earlier) fs.writeFileSync(INNER, earlier);
  }
  // Off only undoes Entomatical's own setting; any other wrapper stays as it is.
  if (!on && current !== WRAPPER && !isDevWrapper(current)) return void (await state.update("panelDeclined", true));
  const saved = state.get<string>("wrapperBefore");
  // Installs from before wrapperBefore existed only have INNER.
  const before = saved ?? (fs.existsSync(INNER) ? fs.readFileSync(INNER, "utf8").trim() : "");
  await config.update("claudeProcessWrapper", on ? WRAPPER : before && !isOwnWrapper(before) ? before : undefined, vscode.ConfigurationTarget.Global);
  await state.update("panelDeclined", !on);
}

/** True when tasks should open in a Claude Code panel. Asks once. */
async function usePanel(): Promise<boolean> {
  if (wrapperIsOn()) return true;
  if (state.get("panelDeclined")) return false;
  const pick = await vscode.window.showInformationMessage(
    "Open Entomatical tasks in the Claude Code panel?",
    {
      modal: true,
      detail:
        "This sets claudeCode.claudeProcessWrapper in your user settings to Entomatical's small wrapper (on Linux a wrapper already set there keeps running, inside it). It runs board tasks in their worktree and account; every other Claude session passes through unchanged. Turn it off any time with 'Entomatical: Use Terminal Instead'.",
    },
    "Use panel",
    "Use terminal",
  );
  if (!pick) throw new Error("Not started.");
  await setPanel(pick === "Use panel");
  return pick === "Use panel";
}

/**
 * Closes the Claude Code editor tab of a session that has just been ended. Claude Code keeps one tab per session and, asked to open
 * that session again, only reveals the tab: after Switch account ended a panel session, its tab stayed with "Claude Code process exited
 * with code 1" and nothing resumed until a message was typed there (seen on Windows, 31 October 2026, extension 2.1.314). With the tab
 * closed, the resume opens a new tab, which resumes at once on the new account. Closing a tab ends its session, so only a tab that
 * can be this card's alone goes: the tab API has no link from the board's `claude-vscode.editor.open` to the tab it made, so the tab is
 * found by its title, which Claude Code shortens past 25 characters to 24 and "…", and a label that would also fit another card's title
 * is left alone. Nothing is closed unless exactly one tab matches. Returns how many matched.
 */
async function closeClaudeTab(board: Board, task: Task): Promise<number> {
  const fits = (label: string, title: string) => label === title || (label.endsWith("…") && label.length > 1 && title.startsWith(label.slice(0, -1)));
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes("claudeVSCodePanel")
    // Only another card with a live session can own that tab: closing one whose session is gone ends nothing (titles often share 24 characters).
    && fits(t.label, task.title) && !board.tasks.some((o) => o.id !== task.id && !!o.sessionId && board.external.has(o.sessionId) && fits(t.label, o.title)));
  if (tabs.length === 1) await vscode.window.tabGroups.close(tabs[0]);
  return tabs.length;
}

/** The pid and its ancestors, nearest first. */
async function ancestors(pid: number): Promise<number[]> {
  const parentOf = WIN ? await windowsParents() : procParent;
  const chain = [pid];
  while (chain.length < 8 && parentOf(chain[chain.length - 1])) chain.push(parentOf(chain[chain.length - 1]));
  return chain;
}

async function windowsParents(): Promise<(pid: number) => number> {
  const ps = Buffer.from('Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }', "utf16le").toString("base64");
  const { stdout: out } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", ps], { encoding: "utf8", maxBuffer: 1 << 24, timeout: 15_000, windowsHide: true });
  const parent = new Map(out.trim().split(/\r?\n/).map((l) => l.trim().split(" ").map(Number) as [number, number]));
  return (p) => parent.get(p) ?? 0;
}

/** Parent pid from /proc/<pid>/stat: the second field after the command name, which is in parentheses and may hold spaces. 0 if unknown. */
function procParent(pid: number): number {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) || 0;
  } catch {
    return 0;
  }
}

/** Brings a found session forward: its VS Code terminal, or its Claude Code panel when that panel lives in this window. */
async function openFound(pid: number, sessionId: string) {
  const chain = await ancestors(pid);
  for (const t of vscode.window.terminals) {
    const p = await t.processId;
    if (p && chain.includes(p)) return t.show();
  }
  // A panel session is a child of this window's extension host. Opening one from another window would start a second copy.
  if (chain.includes(process.pid)) return void vscode.commands.executeCommand("claude-vscode.editor.open", sessionId);
  vscode.window.showInformationMessage("Entomatical: this session is running in another VS Code window or outside VS Code.");
}

// The provider is explicit; failures never switch services or accounts silently.
let speechSecrets: vscode.SecretStorage;
type DictationOwner = vscode.Webview | vscode.Terminal;
type Dictation = { owner: DictationOwner; voice?: Voice; post: (state: string | false) => void; stopping?: boolean; cancelled?: boolean };
let dictation: Dictation | undefined;
let recorder = "arecord";
async function dictateDirect(board: Board, webview: vscode.Webview, m: Record<string, unknown>) {
  return dictateTo(webview, sentence => { void webview.postMessage({ dictated: sentence }); }, state => { void webview.postMessage({ dictating: state }); },
    soFar => { void webview.postMessage({ dictatedLive: soFar }); });
}

async function enableTerminalDictationShortcut() {
  const config = vscode.workspace.getConfiguration("terminal.integrated");
  if (config.get<boolean>("sendKeybindingsToShell", false)) throw new Error("Turn off terminal.integrated.sendKeybindingsToShell to use F8 dictation.");
  const command = "entomatical.dictateTerminal", skipped = config.get<string[]>("commandsToSkipShell", []);
  if (!skipped.includes(command) || skipped.includes(`-${command}`))
    await config.update("commandsToSkipShell", [...skipped.filter(c => c !== command && c !== `-${command}`), command], vscode.ConfigurationTarget.Global);
}

async function dictateTerminal() {
  // F8 stops the original recording even if focus has moved to another terminal.
  if (dictation) return stopDictation(dictation);
  const terminal = vscode.window.activeTerminal;
  if (!terminal || terminal.exitStatus) throw new Error("Focus a running terminal before starting dictation.");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 21);
  status.command = "entomatical.dictateTerminal";
  status.tooltip = "Uses Entomatical Speech Settings. F8 stops recording and inserts the transcript without sending it.";
  const closed = vscode.window.onDidCloseTerminal(t => { if (t === terminal) endDictation(terminal); });
  try {
    await dictateTo(terminal, sentence => {
      if (!vscode.window.terminals.includes(terminal) || terminal.exitStatus) return;
      // Keep provider output as a paste, never terminal control sequences or an Enter key.
      const text = sentence.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
      if (text.trim()) terminal.sendText(paste(` ${text}`).slice(0, -1), false);
    }, state => {
      if (!state) { status.hide(); return; }
      status.text = state === "starting" ? "$(mic) Starting microphone…" : state === "recording" ? "$(mic-filled) Recording speech — F8 to stop" : "$(loading~spin) Finishing dictation…";
      status.show();
    });
  } finally { closed.dispose(); status.dispose(); }
}

function stopDictation(d: Dictation) {
  if (d.cancelled || d.stopping || !d.voice) return;
  d.stopping = true; d.post("stopping"); return d.voice.stop();
}

/** `partial` (the board's boxes only) gets Parakeet's live text; a terminal cannot replace what was pasted, so it gets the final text alone. */
async function dictateTo(owner: DictationOwner, text: (sentence: string) => void, post: (state: string | false) => void, partial?: (soFar: string) => void) {
  if (dictation) return stopDictation(dictation);
  const d: Dictation = dictation = { owner, post };
  const active = () => dictation === d && !d.cancelled;
  d.post("starting");
  try {
    const options = await speechOptions(speechSecrets);
    if (!active()) return;
    const events = { text: (sentence: string) => { if (active()) text(sentence); },
      partial: partial && ((soFar: string) => { if (active()) partial(soFar); }),
      recording: () => { if (active()) d.post("recording"); },
      transcribing: () => { if (active()) { d.stopping = true; d.post("stopping"); } },
      error: (message: string) => { if (active()) void vscode.window.showErrorMessage(`Entomatical: ${message}`); } };
    d.voice = options.provider === "local" ? dictateStream(options, events, recorder) : dictateVoice(options, events, recorder);
    await d.voice.closed;
  } catch (error) {
    if (active()) throw error;
  } finally {
    if (dictation === d) { dictation = undefined; if (!d.cancelled) d.post(false); }
  }
}

function endDictation(disposedOwner?: DictationOwner) {
  const d = dictation;
  if (!d || (disposedOwner && d.owner !== disposedOwner)) return;
  if (d.cancelled) return d.voice?.closed;
  d.cancelled = true;
  if (d.voice) d.voice.cancel(); // Keep the microphone reserved until voice.closed.
  else dictation = undefined; // Still loading settings. No recording to release.
  if (!disposedOwner) d.post(false);
  return d.voice?.closed;
}

type SelectedPlan = { label: string; file: FoundPlan; raw: unknown; hash: string };
type PlanPreset = { id: string; name: string; settings: Record<string, unknown> };
function presetName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 100 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("A preset name must be one line of up to 100 characters.");
  return value.trim();
}
/** Personal presets are settings only; reject arbitrary fields, variables and credentials. */
function cleanPlanPreset(value: unknown): Record<string, unknown> {
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Invalid personal preset.");
    return v as Record<string, unknown>;
  };
  const root = object(value), result: Record<string, unknown> = {};
  const fields = ["account", "model", "effort", "permission"];
  const pick = (v: unknown, allowed: string[]) => {
    const o = object(v), clean: Record<string, string> = {};
    for (const [k, x] of Object.entries(o)) {
      if (!allowed.includes(k) || typeof x !== "string" || !x.trim() || x.length > 200 || /[\x00-\x1f\x7f]/.test(x)) throw new Error("A preset has an unsupported setting.");
      clean[k] = x;
    }
    return clean;
  };
  for (const [k, v] of Object.entries(root)) {
    if (fields.includes(k)) Object.assign(result, pick({ [k]: v }, fields));
    else if (k === "reviewer") result[k] = pick(v, ["account", "model", "effort"]);
    else if (k === "scribe") result[k] = pick(v, ["model"]);
    else if (k === "judge") { const o = pick({ judge: v }, ["judge"]); result[k] = o.judge; }
    else if (k === "steps") {
      const steps = object(v), entries = Object.entries(steps);
      if (entries.length > 600 || entries.some(([id]) => !/^[a-z0-9][a-z0-9-]{0,29}$/.test(id))) throw new Error("Invalid preset step names.");
      result[k] = Object.fromEntries(entries.map(([id, settings]) => [id, pick(settings, fields)]));
    } else throw new Error("A preset may contain only execution settings.");
  }
  return result;
}
const planHash = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
/** Prepare the same validated run for both the visible preview and the final start. */
function previewSelectedPlan(board: Board, pick: SelectedPlan, draft: unknown) {
  try {
    board.mustOwn();
    if (planHash(pick.file.file) !== pick.hash) return { errors: ["The plan file changed. Choose it again before running."] };
    const incomplete = board.tasks.find((t) => t.planRun?.sourceHash === pick.hash && t.planRun.setupState === "creating" && !t.cancelled && t.status !== "done" && (!t.planRun.file || t.planRun.file === pick.file.rel));
    if (incomplete) return { errors: [`An earlier start left plan card ${incomplete.id} incomplete. Inspect it before starting this plan again.`] };
    const applied = applyPlanSetup(pick.raw, draft);
    if ("errors" in applied) return applied;
    const checked = board.checkPlan(applied.raw, applied.vars);
    if ("errors" in checked) return checked;
    const caps = board.capsOf();
    if (!board.orchestratorEnabled()) return { errors: ["Enable card delegation in Entomatical settings to run a plan."] };
    const minimumOpen = Number(!!checked.plan.judge) + Number(!!checked.plan.scribe) + 1;
    if (caps.open < minimumOpen) return { errors: [`This plan needs at least ${minimumOpen} open slots for its standing roles and a worker.`] };
    const catalogue = readCatalogue(board.repo);
    const configHash = crypto.createHash("sha256").update(JSON.stringify({ raw: applied.raw, vars: applied.vars })).digest("hex");
    const planKeys = new Set(checked.cards.map((c) => c.key));
    const dependencies = new Set(checked.cards.flatMap((c) => c.after.filter((id) => !planKeys.has(id))));
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ source: pick.hash, configHash, catalogue, caps, maxRunning: maxRunning(),
      accounts: board.accountList().map((a) => ({ name: a.name, provider: a.provider })), models: codexModels(), acp: acpCatalogsOf(board),
      cards: board.tasks.filter((t) => dependencies.has(t.id)).map((t) => ({ id: t.id, status: t.status, cancelled: t.cancelled })) })).digest("hex");
    return { ...applied, ...checked, catalogue, fingerprint, configHash };
  } catch (e) { return { errors: [e instanceof Error ? e.message : String(e)] }; }
}
/**
 * A v2 plan (governed assignments, typed inputs, approval of the effective manifest) keeps main's dialog flow: one input box per
 * input, board.previewPlan, the modal with the manifest hash, and Run as the approval. The plan setup (F116) carries v1 plans only.
 */
async function runGovernedPlan(board: Board, pick: SelectedPlan) {
  const raw = pick.raw;
  // The plan's variables, each asked once with the file's text filled in (Escape cancels the run).
  const vars: import("./plan-contract").InputValues = {};
  for (const [name, value] of Object.entries(pick.file.vars ?? {})) {
    const answer = await vscode.window.showInputBox({ title: `Run plan "${pick.label}": ${name}`, value, prompt: "Change it for this run, or press Enter to keep it. A list is split on ; or new lines when it has one, else on spaces and commas." });
    if (answer === undefined) return;
    vars[name] = answer;
  }
  const definition = raw as import("./plan").PlanFile;
  for (const [name, input] of Object.entries(definition.inputs ?? {})) {
    const answer = await vscode.window.showInputBox({ title: `Run plan "${pick.label}": ${name}${input.required ? " (required)" : ""}`,
      value: input.type === "list" ? JSON.stringify(input.default ?? []) : String(input.default ?? ""),
      prompt: input.type === "list" ? 'Enter a JSON array of texts, for example ["Living room", "Office, upstairs"]. Spaces and commas stay inside each item.' : "Enter the text for this input." });
    if (answer === undefined) return;
    try { vars[name] = input.type === "list" ? JSON.parse(answer) : answer; } catch { throw new Error(`Input ${name} must be a JSON array of texts.`); }
  }
  const checked = board.checkPlan(raw, vars);
  if ("errors" in checked) return void vscode.window.showErrorMessage(`Entomatical: ${pick.file.rel} has ${checked.errors.length === 1 ? "a problem" : `${checked.errors.length} problems`}. Nothing was made.`, { modal: true, detail: checked.errors.join("\n") });
  const n = checked.cards.length;
  const approval = board.previewPlan(raw, pick.file.file, vars, (id) => pinProfile(profileFiles(board), id));
  const detail = planPreview(checked.plan, checked.cards, readCatalogue(board.repo)).join("\n") + `\nEffective manifest: ${approval.hash}\nPinned sources: ${Object.keys(approval.manifest.sources).join(", ")}`;
  const ok = await vscode.window.showInformationMessage(`Run plan "${checked.plan.name}"? ${n} step card${n === 1 ? "" : "s"}.`, { modal: true, detail }, "Run");
  if (ok !== "Run") return;
  const { card, steps, reused } = await board.runPlan(raw, pick.file.file, vars, approval);
  if (reused) return void vscode.window.showInformationMessage(`Entomatical: using existing plan card ${card.id} (${card.title}).`);
  const started = steps.filter((t) => !!t.sessionId).length;
  vscode.window.showInformationMessage(`Entomatical: "${card.title}" made ${steps.length} step card${steps.length === 1 ? "" : "s"}; ${started} started, the rest start when the steps they wait for are Done.`);
}
async function selectPlan(board: Board | undefined, m: Record<string, unknown>): Promise<SelectedPlan | undefined> {
  if (!board) return;
  board.mustOwn();
  let pick: { label: string; file: FoundPlan } | undefined;
  if (m.id !== undefined) {
    const rel = board.get(typeof m.id === "string" ? m.id : "")?.planFile;
    if (!rel || !fs.existsSync(path.join(board.repo, rel))) throw new Error("This card has no plan file to run: it was not recorded, or it was archived or deleted.");
    const file = describePlanFile(board.repo, path.join(board.repo, rel), true);
    pick = { label: file.name ?? path.basename(file.file), file };
  } else pick = await pickPlanFile(board.repo);
  if (!pick) return;
  try {
    const hash = planHash(pick.file.file), raw = loadPlanFile(pick.file.file);
    if (hash !== planHash(pick.file.file)) throw new Error("changed while being read; choose it again");
    return { ...pick, raw, hash };
  } catch (e) { throw new Error(`${pick.file.rel} is ${e instanceof Error ? e.message : String(e)}`); }
}

/**
 * Run a plan…'s picker (F72; the user, 8 November 2026: "my json that I want to select is not there and I can't input a path to a json
 * either"). Lists every plan file in workflows/ and .entomatical/workflows/, and also takes a typed path to a .json file anywhere
 * (absolute, or relative to the repo) or "Choose a plan file…", a file dialog.
 */
async function pickPlanFile(repo: string): Promise<{ label: string; file: FoundPlan } | undefined> {
  type Item = vscode.QuickPickItem & { file?: FoundPlan; browse?: true };
  const row = (f: FoundPlan): Item => ({ label: f.name ?? path.basename(f.file), description: f.error ? `cannot be used: ${f.error}` : f.about,
    detail: `${f.rel}${f.shared ? "" : " (private to this machine)"}`, file: f });
  const listed = findPlanFiles(repo).map(row);
  const browse: Item = { label: "$(folder-opened) Choose a plan file…", description: "a .json file anywhere on this computer", alwaysShow: true, browse: true };
  const typedPath = (value: string): string | undefined => {
    let v = value.trim().replace(/^["']|["']$/g, "");
    if (!/\.json$/i.test(v)) return undefined;
    if (v === "~" || v.startsWith("~/") || v.startsWith("~\\")) v = path.join(os.homedir(), v.slice(1));
    const file = path.resolve(repo, v);
    try { return fs.statSync(file).isFile() ? file : undefined; } catch { return undefined; }
  };
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = "Run a plan";
  qp.placeholder = listed.length ? "Pick a plan, or type the path of a .json plan file. Nothing starts until you press Run in the preview."
    : "No plan files in workflows/ yet. Type the path of a .json plan file, or choose one.";
  qp.matchOnDescription = true; qp.matchOnDetail = true;
  const fill = () => {
    const file = typedPath(qp.value);
    const typed: Item[] = file && !listed.some((i) => i.file && path.resolve(i.file.file) === file) ? [{ ...row(describePlanFile(repo, file)), alwaysShow: true }] : [];
    qp.items = [...typed, ...listed, { label: "", kind: vscode.QuickPickItemKind.Separator }, browse];
  };
  fill();
  const chosen = await new Promise<Item | undefined>((resolve) => {
    qp.onDidChangeValue(fill);
    qp.onDidAccept(() => { const it = qp.selectedItems[0]; if (it) { resolve(it); qp.hide(); } });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (!chosen) return undefined;
  if (chosen.file) return { label: chosen.label, file: chosen.file };
  const workflows = path.join(repo, "workflows");
  const uris = await vscode.window.showOpenDialog({ title: "Run a plan: choose a plan file", canSelectMany: false, openLabel: "Use this plan",
    filters: { "Plan files": ["json"] }, defaultUri: vscode.Uri.file(fs.existsSync(workflows) ? workflows : repo) });
  if (!uris?.[0]) return undefined;
  const f = describePlanFile(repo, uris[0].fsPath);
  return { label: f.name ?? path.basename(f.file), file: f };
}

/** Load handoff's picker (F101): the *.md files in <main checkout>/docs/handoffs/, newest first; an empty or missing folder offers a file dialog. */
async function pickHandoff(repo: string): Promise<string | undefined> {
  const dir = handoffDir(repo);
  const listed = listHandoffs(dir);
  const browse = async () => {
    const uris = await vscode.window.showOpenDialog({ title: "Load handoff: choose a handoff doc", canSelectMany: false, openLabel: "Load this handoff",
      filters: { "Markdown": ["md"] }, defaultUri: vscode.Uri.file(fs.existsSync(dir) ? dir : repo) });
    return uris?.[0]?.fsPath;
  };
  if (!listed.length) {
    const choose = "Choose a file…";
    const answer = await vscode.window.showInformationMessage(`No handoff docs in ${dir}.`, choose);
    return answer === choose ? browse() : undefined;
  }
  type Item = vscode.QuickPickItem & { file?: string };
  const items: Item[] = [...listed.map((h) => ({ label: h.name, description: new Date(h.mtimeMs).toLocaleString(), detail: h.file, file: h.file })),
    { label: "", kind: vscode.QuickPickItemKind.Separator }, { label: "$(folder-opened) Choose a file…", alwaysShow: true }];
  const chosen = await vscode.window.showQuickPick(items, { title: "Load handoff", placeHolder: "Pick a handoff doc; its text goes into the prompt box. Nothing starts." });
  if (!chosen) return undefined;
  return chosen.file ?? browse();
}
