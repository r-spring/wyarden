import type { RuleEntry, RuleJudgment } from "./text-actions";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import { isDeepStrictEqual } from "util";
import { TaskChecks } from "./checks";
import type { CheckFailure } from "./jobs";
import { UsageCollector } from "./metrics";
import { addWorktree, changes, discardWorktree, git, inWorktreeRoot, isClean, locked, mergeTask, sharedCommits, worktrees } from "./git";
import { claudeBinary } from "./worker";
import { finishRun, type ActionPick } from "./action-picks";
import { appendEntry, redact, startRun, wasLogged, type Outcome as LogOutcome, type RunLog } from "./error-log";
import { Delivery, checkoutId, deliver, deliveryDue } from "./deliver";
import { FinishPlan, MergeConflict, RemoteRefused, assertTaskCheckout, checkedOut, ExpiredConfirmation, CheckoutRecoveryRequired, isAncestor, mergeExact, pushConfirmed, updateConfirmedCheckout, mergeInProgress, confirmationFor, confirmationProblem, type EffectConfirmation, readinessText, readyWith, remoteSha, type Authorization, type EffectAction, type Readiness, type Reason, commitStaged, goingAwayNote, headlessClaude, integrate, landedIn, plainTail, planFinish, pushTask, resolveRequest, stageAll, updateLocal, writeCommitMessage,
  processAlive, vaultFor, vaultHelperEnv, vaultHelperMissing, vaultResult, vaultSerial, vaultStatus, type VaultDestination, type VaultOutcome, type VaultQuestion, type VaultRecord, type VaultRun, type VaultRunner,
  cleanupStatus, landedWhere, lateWork, releaseVerdict, type CleanupRecord, type Writer } from "./finish";
import { ChildProcess, execFile, spawn } from "child_process";
import { CODEX_DIR, CODEX_HOOK, CODEX_PERMISSIONS, codexThreadPermissions, type CodexPermissions, checkResumable, codexAccounts, codexArgs, codexCommand, codexConfigModel, codexDefaultModel, discoverCodex, fromCodexPath, codexEffortOk, codexModels, codexSubagents, liveCodexSessions, stopCodexWriter, approveCodex, nameCodexThread, pendingApprovals, queueCodexMessage, readRollout, rolloutFor, rolloutStatus, hookArgs, rpcClient, toCodexPath } from "./codex";
import { tempEnv, tempRoot } from "./workspace";
import { DEFAULT_DIR, Exchange, sameFolder, LiveSession, REPLY_CAP, Subagent, accountFolders, carryTranscript, claimOwner, foundAccounts, inRepo, lastAssistantText, linkIntoHistory, liveSessions, readSubagent, readUsage, sessionPlaces, sessionTitle, statusOf, subagents, transcriptExchanges, transcriptInterrupted, transcriptTurns, transcriptPath, typedText, usageKey, writeFileAtomic, Operations, RequestJournal, OPEN_OPS, type Operation,
  alive, inside, notTyped, ownerState, processStart, sameStart, type OwnedProcess } from "./sessions";
import { UsageRun, startReading } from "./usage-history";
import { Context as WorkflowContext, RunReceipt, Step, WorkflowStore, admit, close as closeAttempt, interactive, mark, readiness, reopen, validateAttempt } from "./workflow";
import { execFileSync } from "child_process";

import { speechHistory, speechImportIds } from "./speech-history";
import { rerootTasks } from "./moved";
import { CHANGE_KEY, StatusRecord, launchState, liveLine, statusRecord, timeline } from "./status-line";
import { APPROVED_NOTICE, DEFAULT_CAPS, assignedPrompt, watcherModel, watcherPrompt, HeadlessPlan, headlessPermissions, INTERRUPTED_NUDGE, Request, RunSummary, bestAccount, checksWait, headlessFiles, headlessLaunch, headlessScript,isSettled, masterOf, noticeText, planSummary, prefixPrompt, refusal, runCards, runRoot, runSummary, settleKey, streamText, validateRequest } from "./orchestrator";
import { ensureCatalogue, limitToCatalogue, readCatalogue } from "./checks";
import { hostClock, localTime } from "./local-time";
import { ancestorsOf, capsFrom, normalizeModel, archiveSet, budgetStep, runBudget, BUDGET_NOTICE, RUNTIMES, type Runtime, claimTree, heldBy, isOwn, CLAIM_GRACE_MS, type RightsContext, type Transfer } from "./orchestrator";
import { OPERATOR_TOKEN_FILE, readOperatorToken, verifyOperator, validateOperatorRequest } from "./operator";
import { taskCost } from "./usage-history";
import { LEDGER_DIR } from "./ledger";
import { evidenceOf, exportRun, keepReferenced, ledgerHarness, manifestOf, recordGaps, retain, verifiedCopy, within, type Manifest } from "./run-record";
import { Efficiency, LedgerIndex, efficiency, firstStopAt, parseIndex } from "./efficiency";
import { ACP_PERMISSION_LABELS, ANTIGRAVITY_EFFORTS, ANTIGRAVITY_FAMILIES, AcpOption, AcpProvider, AcpSession, PROVIDER_DEFAULT_PERMISSION, acpCommand, acpModelChoice, antigravityArgs, antigravityDefault, antigravityListed, grokDefaultSeen, antigravityModelOk, antigravityTakesEffort, askMode, discoverAntigravityModels, discoverGrokModels, grokArgs, noAskMode, providerPermissionOk, startAcp } from "./acp";
import type { DoneReview, DoneReviewRun } from "./done-review";
import { recoverReview, terminalReviewWait, worktreeSnapshot } from "./done-review";
import { readSpec, recordSpec, type TaskSpec } from "./compile";
import { CHECKPOINTS, READ_ONLY_PROVIDERS, diversity, evaluateRound, isDecisionRequired, makePackage, memberPrompt, packageGaps, parseJudgment, roundsSincePass, sha, staleReason, validDispositions, type Checkpoint, type CouncilSnapshot, type MemberRun, type PackageContent, type ReviewPackage, type Round } from "./council";
import { strictClaude, type StrictClaude } from "./strict-claude";
/** Profile refusals the strict-route probe's recipe answers (Board.profileProblem); every other reason still refuses. */
const PROBE_WAIVES = ["route-unverified", "inherited-extras", "inventory-unknown"];
import { blockedText, inventory, resolve as resolveProfile, revisionHash, snapshotProblem, type Mode as LaunchMode, type Provider as ProfileProvider, type Reason as ProfileReason, type Selection as ProfileSelection } from "./profiles";
import { claudeModelId, exactModel, familyLabel, isExactModel, modelLabel, modelName, newestOf, parseModel, resolveModel, shortNames, tryResolve } from "./models";
import { AUTO_FOLLOW_UPS, PlanFile, PlanProfile, StepCard, archivePlanFile, describePlanFile, planCardText, reviewerPrompt, stepCommands, stepPrompt, stepTable, validatePlanFile } from "./plan";

import { CardSessionTerminal, CardTerminals, TERMINAL_KEYS, terminalModelNotice } from "./cardTerminal";
import { inCardTerminal } from "./battle";
import { BATTLE_APPROVED_NOTICE, planCapacityWait } from "./orchestrator";
import { governedBelow, overlaps, pathsMeet, boundSession as boundSessionOf, admission, allowanceOf, childProfile, deadlock, dependencyBlock, governedBrief, governedDepth, governedOverview, governedRootOf, narrowDelegation, payloadHash, profileRef, reconcileLeases, targetEffectRefusal, validateGovernance, waiterKind, GOVERNED_CAPABILITY, GOVERNED_PROTOCOL, type Governance, type Waiter } from "./orchestrator";
import { digest as planDigest, manifest as effectiveManifest, manifestProblem, within as withinPlanPath, type PlanApproval, type InputValues, type Contract } from "./plan-contract";
import { dispatchHeld, PanelUpdateError, waitReason as queueWaitReason } from "./queue";

export type Status = "queued" | "running" | "needs-input" | "review" | "done";
type TerminalSubmission = "confirm-submit" | "automatic-submit";

type TakeoverAsk = Readonly<{ id?: string; by: string; reason: string; at: string }>;
type WorktreeAllocation = { card: Task; worktree: string; branch: string; state: "new" | "rollback" | "kept" | "preexisting" };

export interface Task {
  id: string;
  /** Original card ID in the retired speech board; its event files remain in place. */
  legacySpeechId?: string;
  parentId?: string;
  title: string;
  /** The user typed the title (not taken from the prompt), so it becomes the session's name (--name) on start. */
  named?: boolean;
  prompt: string;
  account?: string;
  /**
   * The Claude account folder ("" = ~/.claude) the card was created or moved on. Account names are the CLI's email, which changes
   * when a folder is logged into another login, so the folder is what still identifies the account then.
   */
  configDir?: string;
  /** Runtime provider; unset = Claude. */
  provider?: "codex" | AcpProvider;
  /** This card has started a separate interactive provider terminal conversation. */
  cardTerminalStarted?: boolean;
  /** Card terminal (F89): this Claude or Codex card's session runs in a terminal inside its card, not a VS Code terminal or the panel. */
  cardTerminal?: boolean;
  /** Battle Royale (battle.ts): one random id shared by the cards one battle made, one per provider. Unset on every other card. */
  battle?: string;
  /** Who last typed in the card's terminal (F89): "you" (the user) or a parent card's id, and when. Shown on the card. */
  terminalInput?: { by: string; at: string };
  /** Provider-advertised session selectors and user choices for the next managed turn. */
  acpOptions?: AcpOption[];
  acpSelections?: Record<string, string>;
  /** The board-mediated Antigravity login that opened this session. Absent on older cards. */
  acpLoginId?: string;
  /** A Codex task which continues in Codex's editor (entomatical.codexStart "editor"). */
  codexEditor?: boolean;
  /** The thread uses editor defaults. A sandbox records a verified editor start (approval never); a terminal recovery keeps only the id. */
  codexEditorPolicy?: { threadId: string; sandbox?: CodexPermissions["sandbox"] };
  /** Its first turn was started through the private panel bridge. */
  codexPanelBridge?: boolean;
  /** The rollout's turn count when Stop cut off that first turn, which then never closes in the rollout (see runFirstCodexTurn). */
  codexStopped?: number;
  /** Improve's accepted specification and the settings it was accepted with (compile.ts TaskSpec, master plan phase 1). Unset on raw and older cards. */
  spec?: TaskSpec;
  /** The capability profile pinned when the card was added (profiles.ts, master plan phase 2). Unset on older cards: Provider defaults. */
  profile?: ProfileSelection;
  /** O5: the strict profile the user replaced with Provider defaults on this card, and when (Board.useProviderDefaults). */
  profileReplaced?: { at: string; ref: string; hash: string; inherited?: string[] };
  /** Phase 3: a governed root's trusted configuration (limits, delegable profiles, leases), set only by the user's approval (Board.govern). */
  governed?: import("./orchestrator").Governance;
  /** Phase 3: the governed root this card belongs to, set at creation; changing its role or owner never takes it out of the run. */
  governedBy?: string;
  /** Phase 5: this card is one member's read-only review of one fixed council package (src/council.ts). */
  council?: { root: string; checkpoint: Checkpoint; round: number; member: string; package: string };
  /** Phase 3: what a governed coordinator may delegate, narrowed from its parent's allowance. */
  delegation?: import("./orchestrator").Delegation;
  /** Phase 3: the bounded assignment a governed child was opened with. */
  assignment?: import("./orchestrator").Assignment;
  /** Phase 3: the child's latest validated handoff (board.js submit). */
  submission?: import("./orchestrator").Submission;
  /** Receipt for integrating this card into its opener's branch, with the exact revisions and request or governed operation. */
  integrated?: { into: string; branch: string; before: string; after: string; head: string; base: string; op: string; by: string; at: string };
  /** Phase 4: the last integration attempt that conflicted. Nothing changed then; the card keeps its worktree and submission. */
  conflict?: { files: string[]; into: string; at: string; op: string };
  /** The CLI's model alias or id; unset = the account's default. */
  model?: string;
  /**
   * The exact model id this card's latest launch handed its CLI or ACP session (the user, 17 November 2026: exact ids only). Session
   * details show it, and resuming a Codex thread sends it again, so a resumed conversation never changes model.
   */
  sentModel?: string;
  /** The CLI's effort level; unset = the account's default. */
  effort?: string;
  /** The permission mode picked on the new-task form (PERMISSIONS, or CODEX_PERMISSIONS for Codex); unset = the account's default. */
  permission?: string;
  /** Adoption does not change a live process; apply this permission mode on its next managed launch. */
  pendingPermission?: string;
  /**
   * Plan first (F78): the first turn runs in Claude's plan mode (permissions.defaultMode "plan" in the --settings file, ahead of
   * `permission`). Cleared, and the file rewritten, once that turn has ended (its first Stop) or the plan was approved (ExitPlanMode
   * ran), so a resume does not enter plan mode again. Never on a Codex or headless card.
   */
  planFirst?: boolean;
  /** The last turn's reply ended by asking something (F79, hook.js asks at Stop). Cleared when the card runs again. */
  asks?: boolean;
  /**
   * F91: the card's own hook stopped its headless run after refused calls (hook.js refusalStop): the same call twice, or 8 in a row.
   * The card stays in Needs input with it until the next prompt (a follow-up, or Resume with Bypass) starts a new run.
   */
  refusalStop?: { at: number; rule: "repeat" | "streak"; n: number; desc?: string };
  /**
   * When the work counts as finished. commands are acceptance checks run in the worktree when work comes to Review (checks.ts). doneWhen and goal come from
   * the completion rule (text-actions.ts completionRule). writer identifies its model and effort records the requested effort.
   * Older comparison tasks retain haiku, opus, judgment and review; older writer-only tasks recorded who supplied a missing goal.
   */
  completion?: { commands: string[]; doneWhen?: string; goal?: string; writer?: string; effort?: string; promptVersion?: string; haiku?: RuleEntry; opus?: RuleEntry; judgment?: RuleJudgment;
    review?: { haikuGoodEnough?: boolean; verdict?: string; model?: string; error?: string; at: string; checks: string } };
  /** The latest run of this task's own acceptance checks (checks.ts); run is its folder. */
  checks?: { status: "running" | "complete" | "error"; run: string; error?: string; failure?: CheckFailure; revision?: string; phase?: "task" | "delivery"; at?: string;
    /** Phase 4: the worktree was clean when the run started and still clean at that same HEAD when it passed; governed readiness needs it. */
    clean?: boolean };
  /** Check workers whose Running transition committed before their old process group exited. */
  retiringChecks?: { run: string; pid: number }[];
  worktree?: string;
  branch?: string;
  sessionId?: string;
  status: Status;
  /** Found running in the repo rather than started from the board. */
  adopted?: boolean;
  /** Runs in a Claude Code panel rather than a terminal. */
  panel?: boolean;
  /** When a panel start's launch was claimed but its session had not reported in (ms). Kept on the card so a reload keeps it. */
  panelPending?: number;
  /** A found card moved to Done because its session closed (not by the user). */
  ended?: boolean;
  /** Its branch was merged into the repo. */
  merged?: boolean;
  /** Merged, but Finish could not delete its worktree folder (something still used it): a second Finish only deletes the folder. */
  cleanupPending?: boolean;
  /**
   * M-02: the work landed and Finish kept the worktree whole, because something was still writing there, could not be told to have
   * ended, or had written since (finish.ts CleanupRecord): the commit that landed, where, and what kept the folder. With it, Finish
   * again only cleans up, and Start, Resume and follow-ups are refused. Cleared with the worktree.
   */
  cleanup?: CleanupRecord;
  transcript?: string;
  /** Grok and Antigravity: the folder the session ran in, kept when Finish clears worktree. Their usage files are found by it (F93). */
  ranIn?: string;
  /** The account's usage reading at the start and end of each run, for the card's cost in percentage points (usage-history.ts). */
  usageRuns?: UsageRun[];
  /** The linked Asana task (asana.ts): its context goes in with the first prompt, and Finish or Merge adds a comment to it. */
  asana?: { gid: string; name: string; url?: string };
  /** The linked Obsidian note keeps its original folder when the workspace source changes. */
  obsidian?: { folder: string; note: string };
  /**
   * Steps whose accepted result this step needs (workflow.ts). Controls execution; parentId only groups. On an ordinary card it is
   * Start after (queue.ts): the cards that must finish first.
   */
  dependsOn?: string[];
  /** Added with auto-start on but held back by Start after or the running limit; the board starts it when both clear (queue.ts). */
  held?: boolean;
  /** The last turn ended without a Stop (Esc, a declined prompt, or the session gone). Cleared when the card runs again. */
  interrupted?: boolean;
  /** A failed allocation remains inspectable and cancellable; it is never a delivered result. */
  launchError?: string;
  /** The session the host dispatched to a terminal. An exit before a matching SessionStart is shown separately. */
  terminalLaunch?: { sessionId: string; exited?: boolean };
  /** One automatic retry of an unstarted held card is due at this time. A second failure waits for explicit Start. */
  startRetryAt?: number;
  cancelled?: boolean;
  /** The controller explicitly declared that all delegated work is ready for final acceptance. */
  deliveryReady?: boolean;
  /** An explicitly rebound external controller; distinct from the original managed runtime session. */
  controller?: { sessionId: string; at: string; mode: "external" };
  /** Board-issued ACP controller, independent of the provider's conversation id. */
  boardSessionId?: string;
  /** The root's approved operational instructions, inherited by descendants. CLI permission defaults to Bypass. */
  runPolicy?: { allow: string[]; deny: string[]; noSync: boolean };
  /** When the card entered its current column (ISO), for status lines and `board.js show` (F70). */
  statusAt?: string;
  /** The orchestrator card that opened this card (F69, spec 5.1); shown as the chip. Cards without it are the user's. */
  openedBy?: string;
  /** The orchestrator card that receives this card's settle notices; defaults to openedBy (phase 5 routes it elsewhere). */
  watchedBy?: string;
  /** Original watched set, kept for ancestry checks even after ownership returns to root. */
  watches?: string[];
  /** A fixed orchestration role. Watchers supervise only their explicitly assigned cards. */
  role?: "sub" | "judge" | "scribe" | "research";
  /** Requests a judge verdict after the card passes its checks. */
  judge?: boolean;
  /** The judge verdict is advisory and never changes completion status. */
  judged?: "pass" | "fail";
  /** The exact commit judged, and the current assignment of a standing judge. */
  judgedRevision?: string;
  judgeReady?: boolean;
  judging?: { id: string; revision: string; at: number; prompt: string; phase: "pending" | "dispatching" };
  /** Scribe milestones and the explicitly approved document allowlist. */
  scribe?: { documents: string[]; milestones: { name: string; cards: string[]; complete?: boolean }[]; active?: { name: string; at: number; prompt: string; phase: "pending" | "dispatching" } };
  /** Runs headless in a hidden terminal with no tab (F71); cleared when the user resumes it himself (takenOver). */
  headless?: boolean;
  /** the user resumed a headless card in a panel or terminal: it is his now, and its orchestrator's send is refused as taken over. */
  takenOver?: boolean;
  /** F95: the card's changes of controller by claim, claim-tree, an approved request-takeover or handoff (the last 10; transfers.jsonl keeps all). */
  transfers?: Transfer[];
  /** F95: a card asked the user to take this card over (request-takeover); Approve or Deny on the notification, or the operator CLI. */
  takeoverAsk?: TakeoverAsk;
  /** Follow-ups its orchestrator sent, for caps.followUps. */
  followUps?: number;
  /** On an orchestrator card: its caps and how many cards it opened (F69). root names the run's top orchestrator for a --may-open child. */
  orchestrator?: { caps: Caps; opened: number; root?: string; /** The session `board.js rebind` bound after the user took the card over; else its own sessionId acts. */ session?: string; reboundAt?: string };
  /** On a master: the run is paused (F75): no card opens, settle notices are held. "budget": the board paused it at 100 % of caps.points (F76). */
  paused?: boolean | "budget";
  /** Automatic watchers pause after a failed watcher until the run owner resumes them. */
  pressureError?: string;
  pressureWatchersBlocked?: string[];
  /** On a master: the budget threshold the board last acted on (80: the master was told; 100: the run was paused), so each happens once, also after a reload. */
  budgetNoticed?: 80 | 100;
  /** On a master: `board.js finish self` (F71, F97 section 9). At its Stop the board reviews the run and, on Done, finishes it (src/auto-finish.ts). */
  finishAsked?: { at: string; reviewInterrupted?: boolean; resume?: { sessionId: string; before: number; promptHash?: string; launchId?: string } };
  doneReview?: DoneReview;
  doneReviewRun?: DoneReviewRun;
  /** Automatic review corrections. Older records include any merge retries in this count. */
  autoRounds?: number;
  mergeRetries?: number;
  selfFinish?: { step?: string; error?: string; report?: string; eventsAtWait?: number; composerSubmitted?: boolean; resumePromptHash?: string };
  /** On a master: `board.js plan` was run (F76); the user's Approve sets `approved`. steps and points are the plan's size, read from ORCHESTRATION.md. */
  plan?: { at: string; steps: number; points: number; caps?: Caps; policy?: Task["runPolicy"] };
  approved?: { at: string; hash: string; pressureWatchers?: boolean };
  /** On a master: the "Run finished" notification was shown, once. */
  reported?: boolean;
  /** A headless child parked on a usage limit with no account to switch to (F76): it starts again when the reset passes. */
  waitsForReset?: { account: string; at: number };
  /** The account the board moved a headless child to after a usage limit (F76 chip). */
  switchedTo?: string;
  /**
   * Moved to a new session in the same worktree (another provider, or a lost transcript): its first prompt gets CONTINUE_NOTE. On the
   * card, not in memory, so a reload before that session comes up keeps it; cleared once the new session reports SessionStart.
   */
  continued?: boolean;
  /** The step's workflow: where it runs, what it holds, its scope, and its outcome, kept apart from the conversation status. */
  workflow?: Step;
  /**
   * On a plan card (F72, src/plan.ts): the plan file it ran and who decides that a step is finished. "checks": the board merges a step
   * into this card's branch when its checks pass, and the card runs no session. "model": the card is a reviewer session that does it.
   */
  /** `archived` (F99): where the plan file went when the run finished; `file` then names that path (samePlanFile matters only while a run is open). */
  planRun?: { name: string; file: string; review: "checks" | "model"; deliveryCommands?: string[]; mayOpen?: boolean; stepIds?: string[]; archived?: string; approval?: PlanApproval; reusable?: boolean; sourceHash?: string; configHash?: string; vars?: InputValues; setupState?: "creating" | "prepared" | "started" };
  planStep?: { key: string; contract: Contract };
  /** A settled worker still had a process when its plan tried to check its work. */
  awaitingPlanExit?: string;
  /** "Run this plan now" (F99): the plan file a turn's reply named, repo-relative (`workflows/<name>.plan.json`), seen there at its Stop. */
  planFile?: string;
  /** On a plan step: why the board stopped acting on it and it now waits for the user (shown as "Needs you: …"). Cleared when it runs again. */
  stepHold?: string;
  /** Thrown away with Discard (F72, queue.ts): Done in its column, but its work never landed, so the cards after it stay held. */
  discarded?: boolean;
  /** The title of a Start after card that was discarded and then deleted (F72): this card stays held. */
  blocked?: string;
  /** Turns the card's main session finished since its work was last delivered to the main folder (entomatical.deliver.everyTurns). */
  deliveryTurns?: number;
  /** The turns the card's main session finished, used in delivery commit titles (F108): "<title> (turn N)". */
  turns?: number;
  /** The last delivery to the main folder that did something (deliver.ts): its commit and files, or why it was refused. */
  delivery?: { at: string; sha?: string; files?: number; refused?: string };
  /**
   * FR2: in a repo whose Finish destination is a vault (entomatical.finish.vaults), the card's merged work and whether the vault has
   * it: the merged commit, its branch, the destination and the upload's state (finish.ts VaultRecord). Kept when the worktree goes.
   */
  vault?: VaultRecord;
  createdAt: string;
  updatedAt: string;
}

/** An orchestrator's caps (spec 5.1 and section 8); defaults from entomatical.orchestrator.caps. */
export interface Caps { open: number; total: number; depth: number; followUps: number; pointsFiveHour?: number; pending: number; watchers: number; perWatcher: number;
  /** The run's measured budget in points of the 5-hour window, across its cards and accounts (13.3 item 13); unset = none. */
  points?: number;
  /** F95: 1 lets the run's coordinators, not only its root, claim cards whose holders have finished. */
  mayClaim?: number }

export interface Account {
  name: string;
  /** Empty = the CLI's own ~/.claude. CLAUDE_CONFIG_DIR is left unset then, because setting it also moves .claude.json. */
  configDir?: string;
  /** The runtime owning this account; unset = Claude. */
  provider?: "codex" | AcpProvider;
}

export interface HookEvent {
  t: number;
  terminal_launch_id?: string;
  hook_event_name?: string;
  [key: string]: unknown;
}

function userSubmission(e: HookEvent): string | undefined {
  if (e.hook_event_name !== "UserPromptSubmit" || typeof e.prompt !== "string") return;
  const text = typedText(e.prompt).trim();
  if (text && !notTyped(text)) return text;
}

function sessionBoundary(events: HookEvent[], session: string | undefined): number {
  return events.findLastIndex(e => e.session_id === session && e.agent_id === undefined
    && (e.hook_event_name === "SessionEnd" || (e.hook_event_name === "SessionStart" && e.source !== "compact")));
}

/** The event position before dispatch distinguishes a known promptless launch from a wait saved without launch provenance. */
function finishResume(task: Task) {
  if (!task.finishAsked || !task.sessionId) return;
  const resume = task.finishAsked.resume;
  if (resume) return resume.sessionId === task.sessionId ? resume : undefined;
  // Older boards recorded only a supplied prompt on the wait. Its cursor moved if the composer subsequently submitted.
  const wait = task.selfFinish;
  if (wait?.resumePromptHash && wait.eventsAtWait !== undefined && !wait.composerSubmitted)
    return { before: wait.eventsAtWait, promptHash: wait.resumePromptHash };
}

/** A conversation ID survives Resume. Only hooks inherited from this terminal belong to its new process. */
function finishEvents(task: Task, events: HookEvent[]): HookEvent[] {
  const resume = task.finishAsked?.resume;
  if (!resume?.launchId) return events;
  return events.filter((e, i) => i < resume.before || e.terminal_launch_id === resume.launchId);
}

/** Claude's /clear replaces the conversation in this card's terminal. A resume of the replacement can arrive in the same watcher read. */
function clearedSession(task: Task, events: HookEvent[]): string | undefined {
  if (task.provider || !task.sessionId) return;
  const start = events.findLast(e => e.hook_event_name === "SessionStart" && e.agent_id === undefined && e.source !== "compact"
    && (e.source === "clear" || e.session_id === task.sessionId));
  if (start?.source === "clear" && typeof start.session_id === "string" && start.session_id !== task.sessionId) return start.session_id;
}

/** The logged-in Claude accounts found on disk (see sessions.ts discoverAccounts), then the Codex account (codex.ts). */
export const accounts = (): Account[] => [...foundAccounts(), ...codexAccounts()];

/** Choices offered on the new-task form (mirrored in media/board.js). They go into the task's --settings file as model and effortLevel. */
export const MODELS = ["opus", "sonnet", "haiku", "fable"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** Permission menu choice -> Claude's permissions.defaultMode in the task's --settings file (the user, 3 November 2026). */
export const PERMISSIONS: Record<string, string> = { ask: "default", edits: "acceptEdits", auto: "auto", bypass: "bypassPermissions" };
/**
 * Grok and Antigravity (ACP): ask = the agent's own rules (a modal on a card the user opened; refused and raised to the parent on an
 * unattended card); bypass = the board answers each permission request with the agent's advertised allow-once option.
 */
export const ACP_PERMISSIONS: Record<string, string> = { ask: "Ask", bypass: "Allow once automatically" };
/** The permission a child or adopted card takes when none is asked for: never wider than its parent's (childPermission). */
export function inheritedPermission(parent: { permission?: string; provider?: string }, childAcp: boolean): string {
  return (childPermission(parent, childAcp) as { permission: string }).permission;
}
/** How much each permission choice allows, narrowest first, so a child is never given wider permission than its parent. */
const PERMISSION_RANK: Record<string, number> = { ask: 0, edits: 1, auto: 2, bypass: 3 };
/**
 * The permission an orchestrator's new child gets, or an error. The parent's own level caps it. An unset level on a Grok or
 * Antigravity parent means its agent asks, so it counts as ask; on Claude or Codex it keeps the unattended default, bypass.
 * A child on Grok or Antigravity cannot take a mode they lack (edits, auto): it asks instead.
 */
export function childPermission(parent: { permission?: string; provider?: string }, childAcp: boolean, requested?: string | null): { permission: string } | { error: string } {
  const parentAcp = parent.provider === "grok" || parent.provider === "antigravity";
  const cap = parent.permission ?? (parentAcp ? "ask" : "bypass");
  if (requested && (PERMISSION_RANK[requested] ?? 0) > (PERMISSION_RANK[cap] ?? 0))
    return { error: `Permission ${requested} is wider than this coordinator's own (${cap}); a child never gets wider permission than its parent.` };
  const permission = requested ?? cap;
  return { permission: childAcp && !ACP_PERMISSIONS[permission] ? "ask" : permission };
}
/** ACP config option categories the board may set from --model and --effort. */
const ACP_PICKS = [["model", "model"], ["thought_level", "effort"]] as const;
type AcpCatalog = { at: string; options: AcpOption[]; defaultModel?: string; loginId?: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const COMPILER_TAGS = /<\/?(task|goal|context|requirements|acceptance|permissions|deliverable|unresolved|source_content|document)\b[^>]*>/g;
// Metadata like { type: "text" } alone does not identify an operation for an approval.
function meaningfulPermissionDetail(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return !!value.trim();
  if (!value || typeof value !== "object" || depth >= 20) return false;
  if (Array.isArray(value)) return value.some((item) => meaningfulPermissionDetail(item, depth + 1));
  return Object.entries(value).some(([key, item]) => !["type", "mimeType", "mediaType", "status"].includes(key) && meaningfulPermissionDetail(item, depth + 1));
}
/** An untitled card's title: the first line with words, from the <task> on when sources come first, with its &lt; &gt; &amp; read back. */
export const untitledTitle = (prompt: string) => prompt.slice(Math.max(0, prompt.indexOf("<task>"))).split("\n")
  .map((l) => l.replace(COMPILER_TAGS, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim()).find(Boolean)?.slice(0, 60) || "Untitled";
const LATE_PANEL = "The Claude panel took this task but its session has not reported in yet. The card picks it up when it does.";
/** How long a found Claude transcript stands with no file check (claudePlaces): every render asks, several times per card. */
const LOCATE_FRESH_MS = 3_000;
/** Added to the prompt when a started task moves to the other provider, which cannot continue the old conversation. */
/** Kept by Finish for a Grok or Antigravity card: their usage files are found by the session's folder (F93). */
const ranIn = (t: Task) => (t.provider === "grok" || t.provider === "antigravity") && t.worktree ? { ranIn: t.worktree } : {};
export const CARD_TERMINAL_RESUME_NOTE = "Your earlier terminal session on this task was interrupted. Its work so far is already in this worktree: check git status and git log before you start, and do not redo work that is finished. The task:";
/**
 * F87: the line after a Grok or Antigravity card terminal's first prompt (and a resume's). Neither CLI fires a hook and the board does
 * not read its screen (the user, 9 November 2026: "Grok and Antigravity can decide for themselves"), so the agent reports its turn end:
 * board.js turn-done moves the card from Running to Review, and Finish takes it without a Stop. The path is absolute and quoted: a
 * Windows shell may not expand "~", and a dev host runs its own tools/board.js, not the placed copy (live check, 9 November 2026: agy
 * ran the placed copy of an older build, which had no turn-done).
 */
export const cardTerminalTurnNote = (cli: string) => `Entomatical: as the last step of every turn, run: node "${cli}" turn-done`;
/** F91: the follow-up Resume with Bypass sends to a headless run its hook stopped after refused calls. */
export const RESUME_BYPASS_TEXT = "Continue the task. The calls that were refused before are allowed now.";
export const CONTINUE_NOTE ="This task moved to another account and continues here in a new session. Earlier work on it is already in this worktree: check git status and git log before you start, and do not redo work that is finished.";

// Bracketed paste wrapper, from cline/kanban src/terminal/agent-session-adapters.ts
// (commit abd4912c, Apache-2.0). Sends multi-line text into the Claude TUI as one paste, then Enter.
export const paste = (text: string) => `\u001b[200~${text}\u001b[201~\r`;

// Hook event -> card status. A Notification hook is registered only for permission_prompt. Interrupt is Codex's (Esc during a turn).
// StopFailure fires instead of Stop when an API error (usage limit, overload, sign-in) ended the turn (its hook docs in CLI 2.1.312).
const STATUS_BY_EVENT: Record<string, Status> = {
  UserPromptSubmit: "running",
  PostToolUse: "running",
  PermissionRequest: "needs-input",
  Notification: "needs-input",
  Stop: "review",
  StopFailure: "review",
  Interrupt: "review",
};

/** A turn refused by the account's Fable limit (StopFailure as CLI 2.1.312 sends it, captured 29 Oct 2026). */
export const fableLimitHit = (e: HookEvent | undefined) => e?.hook_event_name === "StopFailure" && e.error === "rate_limit"
  && typeof e.last_assistant_message === "string" && /\bFable limit\b/i.test(e.last_assistant_message);

export function statusFromEvents(events: HookEvent[]): Status | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const s = STATUS_BY_EVENT[events[i].hook_event_name ?? ""];
    if (s) return s;
  }
  return undefined;
}

/** Plan first's turn is over (F78): the session's own first Stop, or its plan approved (ExitPlanMode ran). Subagents' events do not count. */
export const planEnded = (events: HookEvent[]) => events.some((e) => e.agent_id === undefined
  && (e.hook_event_name === "Stop" || (e.hook_event_name === "PostToolUse" && e.tool_name === "ExitPlanMode")));

/** From this many identical tool calls in a row the card shows Repeating (F80). */
export const REPEAT_FROM = 5;
/**
 * Repeating (F80): the run of identical tool calls (hook.js hash: tool name and input) that ends the current prompt, counted since its
 * UserPromptSubmit. Only the session's own calls: a subagent's are its own loop. Other events between two calls do not break the run.
 */
export function repeating(events: HookEvent[]): { tool: string; n: number } | undefined {
  let hash: unknown, tool = "", n = 0;
  for (const e of events) {
    if (e.agent_id !== undefined) continue;
    if (e.hook_event_name === "UserPromptSubmit") { hash = undefined; n = 0; continue; }
    if (e.hook_event_name !== "PostToolUse" || typeof e.hash !== "string") continue;
    if (e.hash === hash) n++; else { hash = e.hash; tool = typeof e.tool_name === "string" ? e.tool_name : "tool"; n = 1; }
  }
  return n >= REPEAT_FROM ? { tool, n } : undefined;
}

/**
 * A Codex task's thread is the one its SessionStart hook named. Events of any other thread (a /new in the terminal, a side
 * thread) are dropped, so they neither move the card nor become its reply. Seen 26 Oct 2026: Codex's title side thread runs no hooks.
 * Seen 28 Oct 2026: `codex exec` also starts a memory-consolidation thread that does run hooks, with no rollout file
 * (transcript_path null), so a SessionStart that names its rollout wins over an earlier one that does not.
 */
export function codexThread(events: HookEvent[]): string | undefined {
  const starts = events.filter((e) => e.hook_event_name === "SessionStart" && typeof e.session_id === "string");
  return (starts.find((e) => typeof e.transcript_path === "string") ?? starts[0])?.session_id as string | undefined;
}

/** The editor reports its thread directly. Older bridge and adopted cards store that id in sessionId alone. */
function confirmedCodexThread(task: Task): string | undefined {
  return task.codexEditorPolicy?.threadId ?? (task.codexPanelBridge || task.adopted ? task.sessionId : undefined);
}

export function ownThread(events: HookEvent[], thread = codexThread(events)): HookEvent[] {
  return events.filter((e) => e.session_id === undefined || e.session_id === thread);
}

/** Merge, Discard and Finish wait for a run: its commands still work in the worktree they would remove. */
/** A merged card's worktree folder git no longer knows: Start, Resume and follow-ups there would run git in the main checkout. */
export const LEFTOVER_MERGED = "This task is already merged; its folder only waits to be deleted. Press Finish to delete it, or start a new card.";
const leftoverText = (task: Task) => task.merged || task.cleanupPending ? LEFTOVER_MERGED
  : `Its worktree folder ${task.worktree} is no longer a git checkout, so a session there would run git in the main checkout. Press Finish or Discard, or start a new card.`;
/** The files left in a folder that is no checkout (up to `max`); empty folders are fine, and Entomatical's node_modules link is no file of the task. */
export function leftoverFiles(dir: string, max = 10): string[] {
  const found: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (found.length >= max) return;
      const at = rel ? path.join(rel, e.name) : e.name;
      if (!rel && e.name === "node_modules" && e.isSymbolicLink()) continue;
      if (e.isDirectory() && !e.isSymbolicLink()) walk(at); else found.push(at);
    }
  };
  walk("");
  return found;
}
/** A merged card's folder that could not be deleted: the work landed, so Finish says so, and only the cleanup is left. */
class CleanupBlocked extends Error {}
/** F120: `board.js finish <id>` met uncommitted files after its last check. It never writes a commit; Board.finishLanded turns this into its refusal. */
class NeverCommits extends Error {}

/** A stopped session can leave a helper with this cwd. This snapshot only observes readable Linux process links. */
async function checkFinishCwd(folder: string) {
  if (process.platform !== "linux") return;
  let root: string;
  try { root = await fs.promises.realpath(folder); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  const uid = process.geteuid!(), deadline = performance.now() + 2000;
  const pids = await fs.promises.readdir("/proc");
  if (!pids.includes(String(process.pid))) throw new Error("Cannot check working directories in /proc. Retry when procfs is available.");
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    if (performance.now() >= deadline) throw new Error("Checking process working directories timed out. Press Finish again.");
    try {
      const cwd = await fs.promises.readlink(`/proc/${pid}/cwd`);
      if (!path.isAbsolute(cwd) || !inside(root, cwd)) continue;
      // Uid in procfs is real, effective, saved and filesystem UID, in that order.
      const status = await fs.promises.readFile(`/proc/${pid}/status`, "utf8");
      if (/^Uid:\s+\d+\s+(\d+)/m.exec(status)?.[1] !== String(uid)) continue;
    } catch (e) {
      if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "")) continue;
      throw e;
    }
    throw new Error(`Process ${pid} still has its working directory in the task worktree. Wait for it to leave or exit, then press Finish again.`);
  }
}
const BUSY = new Set(["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"]);
const CHECKS_RUNNING = "Acceptance checks are still running. Wait for them, or use Retry checks to start them again.";

/** Finish's own helpers (Board.completeHeld); tests and autoFinish pass stand-ins. */
export interface FinishHelpers {
  /** Normal Finish checks for a surviving cwd holder once its own session is closed. */
  checkCwdAfterClose?: boolean;
  message?: (diff: string) => Promise<string>; resolve?: (prompt: string) => Promise<{ code: number | null; output: string }>;
  /** Runs after each merge with the remote's latest (or the local target), before the push or local merge; a throw stops Finish (autoFinish's checks). */
  beforePush?: (worktree: string) => Promise<void>;
  /** The Finish button's right-click pick (F102): the commit message's and the conflict resolver's model, effort and permission mode. */
  pick?: ActionPick;
  /** Phase 4: the user's Finish dialog for a governed root: sees the readiness and returns his explicit authorization (push separately), or false. */
  authorize?: (r: Readiness) => Promise<(Authorization & { confirmed: EffectConfirmation }) | false>;
  /**
   * F120: the card whose session asked for this Finish (`board.js finish <id>`). It is not sent the note that the worktree is going:
   * it asked, and a note typed into its terminal is new work for it, which would end its acceptance checks and clear its delivery state.
   */
  asker?: Request;
}

/** M-02: what a removal holds the worktree against (Board.releaseWriters). */
interface WorktreeGate {
  /** How long to wait for the card's own writers, and how often to look; the board's releaseLimits when left out. */
  limits?: { closeMs: number; pollMs: number };
  /** The commit of the card's branch that landed, and where: recorded on the card when the worktree is kept. */
  result?: { sha: string; into: string };
  /** Whether a commit is in the target. Left out, only the folder's files are looked at (a card whose branch is gone). */
  landed?: (rev: string) => Promise<boolean>;
}

/**
 * What Finish's confirmation answers: false cancels, true goes ahead. FR2: `{ upload: true }` goes ahead and also approves the upload
 * to the vault of the plan that was shown. Only the user's own dialog, which shows that vault and its command, answers so; every other
 * caller (an automatic finish, `board.js finish <id>`) answers true, merges, and stops at "upload pending".
 */
export type FinishAnswer = boolean | { upload: boolean };
type FinishConfirm = (plan: FinishPlan | undefined, related: Task[], state: FinishState) => Promise<FinishAnswer>;

/**
 * FR2: runs a vault's helper in a terminal of its own, where it asks for the PIN and the touch itself. The helper is the terminal's
 * program, with the setting's arguments and no shell around it; nothing it prints or is typed there is read, only its exit status.
 * Not kept across a reload (isTransient), so a window that closes ends the helper with it. Past the limit the terminal is closed.
 * Its environment is this window's own and nothing else (strictEnv, finish.ts vaultHelperEnv): no setting adds a variable to it.
 */
const vaultTerminal: VaultRunner = (dest, kind, opts) => new Promise<VaultRun>((resolve) => {
  const started = Date.now();
  let timedOut = false, ended = false, limit: NodeJS.Timeout | undefined, lost: NodeJS.Timeout | undefined;
  const term = vscode.window.createTerminal({ name: `Vault ${kind === "verify" ? "check" : "upload"}: ${dest.name}`, shellPath: dest.command,
    shellArgs: kind === "verify" ? dest.verifyArgs ?? [] : dest.args, cwd: opts.cwd, env: vaultHelperEnv(), strictEnv: true, isTransient: true });
  const end = (code: number | null) => {
    if (ended) return;
    ended = true;
    clearTimeout(limit); clearTimeout(lost); closed.dispose();
    resolve({ code, timedOut, ms: Date.now() - started });
  };
  // exitStatus.code: the helper's own exit code; undefined when the terminal was closed (by the user, by the limit below, by the window).
  const closed = vscode.window.onDidCloseTerminal((t) => { if (t === term) end(typeof t.exitStatus?.code === "number" ? t.exitStatus.code : null); });
  limit = setTimeout(() => {
    timedOut = true;
    term.dispose();
    lost = setTimeout(() => end(null), 5000); // a close that is never reported still ends the wait
  }, opts.timeoutMs);
  term.show(false); // focused: the PIN is typed here
  void Promise.resolve(term.processId).then((pid) => opts.started?.(pid), () => opts.started?.(undefined));
});

/** What Finish found before it asks (the user, 6 November 2026: Finish works in whatever state the card is left in). */
export interface FinishState {
  /** The session is still open (idle or waiting on a prompt): Finish closes it first. */
  open: boolean;
  /** That open session is waiting on a prompt: closing it leaves the prompt unanswered. */
  asking: boolean;
  /** Nothing left to commit, and the target already has every commit on the branch: Finish only removes the worktree. */
  landed: boolean;
  /** The worktree folder is gone (or is no checkout) but the branch is not: Finish checks the branch out there again to merge it. */
  restore: boolean;
  /** The branch is gone: nothing can be merged, so Finish removes what is left of the worktree and closes the card. */
  noBranch: boolean;
  /** Related sessions waiting on a prompt: they are not told this task is going (the note would answer their prompt). */
  waiting: Task[];
  /**
   * M-02: the work landed in an earlier Finish that kept the worktree (Task.cleanup). This Finish only cleans up: it commits, merges,
   * pushes and uploads nothing, and refuses a folder that holds anything written since.
   */
  cleanupOnly?: CleanupRecord;
}

/** Switch account cannot stop a turn running in Codex's editor: the board has no process for it. */
const CODEX_EDITOR_BUSY = "This task is still working in Codex's editor. Stop it there first, then switch.";

/** The message a window that does not own the board gets for a change it may not make (see Board.isOwner). */
const NOT_OWNER = "Another VS Code window runs this repo's board. Make changes there, or close that window.";

/** A standing role whose turn may have started before a window reload (recoverRoleNotices); lifted once that turn is seen to end. */
const ROLE_RECOVERY_HOLD = "The previous role delivery may have started before the window closed. Review the session before retrying.";

/**
 * Copies hook.js, statusline.js, the F96 sub-agent hooks and plan-folder.js from the extension folder to `dir` (only when the content differs)
 * and returns the copied hook.js.
 * A task's hooks file names these scripts, and Claude resumes a session with that file long after the board wrote it. The extension
 * folder carries its version (example-publisher.entomatical-0.7.3) and VSCodium deletes the old one after an update, so a hook pointing
 * there fails silently and the card stops moving. Same approach as placeCodexHook in codex.ts. When the scripts cannot be copied
 * (none bundled, as in tests, or the folder is not writable) the bundled path is used as before.
 */
export function placeHookScripts(bundledHook: string, dir = path.join(os.homedir(), ".entomatical", "hook")): string {
  try {
    for (const name of ["hook.js", "statusline.js", "subagent-brief.js", "receipt-gate.js", "agent-fence.js", "plan-folder.js"]) {
      const from = path.join(path.dirname(bundledHook), name);
      if (!fs.existsSync(from)) return bundledHook;
      const data = fs.readFileSync(from, "utf8");
      const to = path.join(dir, name);
      if (fs.existsSync(to) && fs.readFileSync(to, "utf8") === data) continue;
      fs.mkdirSync(dir, { recursive: true });
      writeFileAtomic(to, data); // a window running another version may read it at the same moment
    }
    try { fs.rmSync(path.join(dir, "agent-router.js"), { force: true }); } catch { /* retired hook; ignore if locked */ }
    return path.join(dir, "hook.js");
  } catch (e) {
    console.error("Entomatical: could not copy the hook scripts", e);
    return bundledHook;
  }
}

let hookNodeSeen: { pathVar: string; exe: string | undefined } | undefined;
/**
 * Windows only: the node.exe on PATH, for a card's hooks in exec form (`command` is the program, `args` its arguments), which Claude Code
 * starts with no shell. A shell-form hook goes through Git Bash on Windows: bin\bash.exe, usr\bin\bash.exe, node.exe and their consoles,
 * 5 processes for every hook call against 2 (traced on 25 November 2026). Undefined on Linux, and when PATH holds no node.exe: the
 * shell form, as before. The lookup is kept until PATH changes; tests pass their own PATH.
 */
export function hookNode(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "win32") return undefined;
  const pathVar = env.PATH ?? env.Path ?? "";
  if (hookNodeSeen?.pathVar === pathVar) return hookNodeSeen.exe;
  let exe: string | undefined;
  for (const dir of pathVar.split(";").map((d) => d.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean)) {
    const candidate = path.join(dir, "node.exe");
    try { if (fs.statSync(candidate).isFile()) { exe = candidate; break; } } catch { /* not in this folder */ }
  }
  hookNodeSeen = { pathVar, exe };
  return exe;
}

/**
 * Reads a JSON array file. Undefined when it cannot be read just now (locked, a sharing error): the caller keeps what it has and
 * tries again. A corrupt one is set aside as <name>.bad-<time> and reported, so the board still loads, but only by the owner
 * (`setAside`): another window renaming it would empty the owner's board.
 */
function readArray<T>(file: string, setAside: boolean): T[] | undefined {
  if (!fs.existsSync(file)) return [];
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return undefined; }
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value)) return value;
  } catch {
    // fall through
  }
  if (!setAside) return undefined;
  const bad = `${file}.bad-${Date.now()}`;
  try { fs.renameSync(file, bad); } catch { return undefined; } // locked (Windows): read again next tick, no zombie takeover
  vscode.window.showWarningMessage(`Entomatical: ${path.basename(file)} was unreadable, so it was moved to ${bad} and the board started empty.`);
  return [];
}

/** Phase 3: whether a card's profile is one the governed run pinned at approval (same ref; a strict one also the same snapshot). */
const authorizedBy = (g: Governance, sel: ProfileSelection | undefined) => {
  const ref = profileRef(sel), pinned = ref ? g.profiles[ref] : undefined;
  return !!pinned && (pinned.mode !== "strict" || (sel?.mode === "strict" && sel.snapshot.hash === pinned.snapshot.hash));
};

export class Board implements vscode.Disposable {
  private disposed = false;
  readonly dir: string;
  readonly checks: TaskChecks;
  readonly metrics: UsageCollector;
  tasks: Task[] = [];
  private readonly terminals = new Map<string, vscode.Terminal>();
  readonly cardTerminals = new CardTerminals((id) => this.ownsNow() && !!this.get(id));
  /**
   * the user, 18 November 2026: typing in a card terminal lagged. Every key and every chunk of the program's output asked isOwner(), which
   * reads and rewrites owner.json on disk. A yes is now reused for 1 s: tick() renews ownership every 3 s, and another window takes the
   * board over only after 15 s without a heartbeat, so a 1 s old yes is never wrong. A no is never reused.
   */
  private ownerAt = 0;
  private ownsNow(now = Date.now()) {
    if (!this.owned) return false;
    if (now - this.ownerAt < 1000) return true;
    const yes = this.isOwner();
    this.ownerAt = yes ? now : 0;
    return yes;
  }
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onChange = this.changed.event;
  /** A card terminal should be brought into view (F89): its id, and whether to focus it. The board's webview scrolls to it. */
  private readonly cardFocus = new vscode.EventEmitter<{ id: string; focus: boolean }>();
  readonly onCardFocus = this.cardFocus.event;
  /** When the user last typed in each card terminal (F89), and when each parent last read it (`${parent}:${card}`). In memory only. */
  private readonly terminalUser = new Map<string, number>();
  private readonly terminalSeen = new Map<string, number>();
  private readonly typingTimers = new Map<string, NodeJS.Timeout>();
  private readonly status = new vscode.EventEmitter<{ task: Task; from: Status; to: Status; quiet?: boolean; error?: string }>();
  /**
   * A card's status changed (by hooks, the session scan, or the user). quiet: the scan found a board task's process gone, or its turn
   * interrupted at the terminal, which is no news. error: an API error ended the turn (StopFailure's error, e.g. "rate_limit").
   */
  readonly onStatus = this.status.event;
  private watcher?: fs.FSWatcher;
  private readonly closeSub: vscode.Disposable;
  /** Live sessions in this repo by session id, refreshed every few seconds. */
  external = new Map<string, LiveSession>();
  private readonly dismissed: Set<string>;
  private poll?: NodeJS.Timeout;

  /** hook.js at its fixed path (placeHookScripts); statusline.js and the F96 sub-agent hooks sit beside it. */
  readonly hookScript: string;
  /** Workflow records (workflow.ts) under the main repository, shared by its worktrees' windows; a worktree's own .entomatical holds only its board. */
  readonly workflow: WorkflowStore;
  /** How many local preparation steps may run at once (entomatical.workflow.localBudget); set by the extension. */
  localBudget = 3;
  /** Strict-route probe (the user, 17 November 2026): in a development host with entomatical.dev.strictProbe, a strict profile on Claude's
   * terminal, in-card or panel route launches with the strict-claude.ts recipe instead of being refused. Set by the extension; never in production. */
  strictProbe = false;

  /** start = false: the caller wires its listeners first, then calls begin(), so the first tick's replayed Review or StopFailure is announced. */
  /** hookDir: where the hook scripts go; development hosts use the scratch repository's .entomatical/hook-dev. */
  constructor(readonly repo: string, bundledHook: string, hookDir?: string, start = true) {
    this.dir = path.join(repo, ".entomatical");
    this.hookScript = placeHookScripts(bundledHook, hookDir);
    this.workflow = new WorkflowStore(path.join(commonRoot(repo), ".entomatical", "workflow"));
    fs.mkdirSync(path.join(this.dir, "events"), { recursive: true });
    fs.mkdirSync(path.join(this.dir, "hooks"), { recursive: true });
    fs.mkdirSync(path.join(this.dir, "inbox", "done"), { recursive: true });
    const ignore = path.join(this.dir, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
    const tasks = readArray<Task>(this.file, false); // not the owner yet: the first tick's takeover reload sets a corrupt file aside
    this.tasks = this.adopt(tasks ?? []);
    this.loadedAt = tasks ? this.mtime() : 0;
    this.dismissed = new Set(readArray<string>(this.dismissedFile, false) ?? []);
    this.checks = new TaskChecks(this);
    this.metrics = new UsageCollector(this);
    this.cardTerminals.onState((state) => {
      if (state.state !== "exited" || state.retired) return;
      if (!this.owned || !this.isOwner()) return;
      const task = this.get(state.id);
      if (task?.cardTerminalStarted && ["running", "needs-input"].includes(task.status))
        this.update(task, { status: "review", interrupted: true }, undefined, true);
    });
    // Out of inotify instances (EMFILE; the Linux machine hit its 128 on 4 November 2026) fs.watch throws, which left the whole board blank.
    // Without a watcher the 3 s poll reads the events instead (tick), so cards still move, a few seconds later.
    try {
      this.watcher = fs.watch(path.join(this.dir, "events"), (_e, f) => {
        if (f?.endsWith(".jsonl")) this.guard(() => {
          this.syncStatus(f.slice(0, -6));
          // A tool call during a turn changes no status, so the webview would not hear of the new live line: a new status record says it moved.
          if (this.publishStatus()) this.changed.fire();
        });
      });
      this.watcher.on("error", () => { this.watcher?.close(); this.watcher = undefined; }); // e.g. the folder was deleted: the poll takes over
    } catch { /* no watch: the poll covers it */ }
    // The inbox (spec 4.1): request files from orchestrator sessions, consumed by the owner window; the 3 s tick polls it too.
    try { this.inboxWatcher = fs.watch(path.join(this.dir, "inbox"), (_e, f) => { if (f?.endsWith(".json")) this.guard(() => void this.processInbox()); }); this.inboxWatcher.on("error", () => {}); } catch { /* the tick polls */ }
    this.closeSub = vscode.window.onDidCloseTerminal((t) => this.terminalClosed(t));
    this.cardTerminals.onUserInput(({ id, enter }) => this.guard(() => this.userTyped(id, enter)));
    // F89 Battle Royale: a battle card's terminal answers its dialogs past the first minute, and a prompt it cannot answer becomes one
    // card event (status-line.ts shows its desc), so a missed dialog is seen and can become an AUTO_ANSWERS row.
    // 18 November 2026 (the user: the starter watches every session that starts in a terminal): an orchestrator's card and a card a run
    // opened are watched the same way, since nobody sits at them; any other card terminal is watched for its first minute.
    this.cardTerminals.isUnattended = (id) => { const t = this.get(id); return !!(t?.battle || t?.orchestrator || t?.openedBy); };
    this.cardTerminals.isStrict = (id) => { const t = this.get(id); return !!t && typeof this.strictRecipe(t) === "object"; };
    this.cardTerminals.onWaiting(({ id, lines }) => this.guard(() => {
      if (!this.owned || !this.isOwner() || !this.get(id)) return;
      this.noteEvent(id, "TerminalWaiting", `Waiting at: ${lines}`);
    }));
    this.status.event((e) => this.guard(() => this.stampUsage(e.task, e.from, e.to)));
    // Deliver (the user, 15 November 2026): every main-session turn end puts the card in Review (a sub-agent's Stop never moves it), so a
    // plain move to Review is a finished turn. A quiet or failed one (Esc, the session gone, an API error) delivers at once.
    this.status.event((e) => this.guard(() => { if (e.to === "review" && e.from !== "review") this.deliveryTrigger(e.task, e.quiet || e.error ? "review" : "turn"); }));
    // Any status change (the idle scan, a closed session, Stop) accounts for the hook events so far: a poll must not replay them over it.
    this.status.event((e) => this.applied.set(e.task.id, Math.max(this.applied.get(e.task.id) ?? 0, this.events(e.task.id).at(-1)?.t ?? 0)));
    // A step's attempt follows its conversation: running once the session works, ended at Review or Done. A quiet end (the session gone or
    // interrupted) leaves the outcome unknown: nothing here credits an operation as done, and its claims stay until Record result.
    this.status.event((e) => this.guard(() => {
      if (!e.task.workflow) return;
      if (e.to === "running") mark(e.task, this.workflow, "running");
      else if (e.to === "review" || e.to === "done") mark(e.task, this.workflow, "ended", e.quiet ? "session gone or interrupted" : undefined);
      else return;
      this.save();
    }));
    this.status.event((e) => this.guard(() => { if (e.task.role === "sub" && e.to === "review" && (e.quiet || e.error)) this.recoverPressureWatcher(e.task, e.error || "interrupted"); }));
    // A quiet Review is unfinished work: the card says Interrupted and releases no Start after card until it runs again (queue.ts).
    // So is a turn an API error ended (StopFailure, or a Fable limit that resumes on Opus).
    this.status.event((e) => this.guard(() => {
      const interrupted = e.to === "review" ? e.quiet || e.error ? true : undefined : e.to === "running" || e.to === "done" ? undefined : e.task.interrupted;
      if (interrupted !== e.task.interrupted) { e.task.interrupted = interrupted; this.save(); }
    }));
    // Asked you something (F79) holds for the Review it came with: the card running again, or Done, clears it.
    this.status.event((e) => this.guard(() => { if (e.to !== "review" && e.task.asks) { e.task.asks = undefined; this.save(); } }));
    // A card that runs again starts a new turn: its next settle is news even when it reads the same as the last one (the same checks
    // failing with the same last reply; F72's second automatic fix never went before this). A plan step no longer waits for the user.
    this.status.event((e) => this.guard(() => {
      if (e.to !== "running") return;
      this.notified.delete(e.task.id);
      if (e.task.stepHold) { e.task.stepHold = undefined; this.save(); }
    }));
    // Work came to Review: run the task's own acceptance checks. Not after a stop, a closed session (quiet) or an API error: that work is unfinished.
    // An orchestrator's own checks are its delivery's: not at its plan stop, nor while cards of its run are still open (checksWait).
    this.status.event((e) => this.guard(() => {
      if (e.to !== "review" || e.quiet || e.error || this.approving.has(e.task.id) || checksWait(e.task, this.tasks)) return;
      const root = masterOf(e.task, this.tasks);
      // Only the plan's own steps (F119: a card a step opened is checked as any orchestrator's child is; its opener accepts it).
      if (root && this.isPlanStep(e.task, root) && e.task.completion?.commands.length) { if (root.paused) this.pausedSteps.add(e.task.id); else this.preparePlanChecks(e.task, root); }
      else this.checks.start(e.task);
    }));
    // An orchestrator card's turn ended (F71, F76): a plan waiting for approval puts it in Needs input; otherwise held settle notices go
    // to it now, and a run whose children are all Done is reported once.
    this.status.event((e) => this.guard(() => {
      const t = e.task;
      if (e.to !== "review") return;
      if (!t.orchestrator) { this.deliverNotices(t.id); return; }
      if (t.plan && !t.approved && !e.quiet) { this.update(t, { status: "needs-input" }); return; }
      // `finish self` (F97 section 9): its checks first, then finishReady; the board itself merges and pushes nothing (autoFinish does).
      if (t.finishAsked && !e.quiet && !this.approving.has(t.id)) { this.finishAtStop(t); return; }
      this.deliverNotices(t.id);
      this.maybeFinished(t);
    }));
    // The run's measured budget (13.3 item 13), after stampUsage above closed the card's usage run: told at 80 %, paused at 100 %.
    this.status.event((e) => this.guard(() => { if (e.to === "review" || e.to === "done") { const m = masterOf(e.task, this.tasks); if (m?.orchestrator && !m.orchestrator.root) this.checkBudget(m); } }));
    if (start) this.begin();
  }

  /** The first tick, then one every 3 s. */
  begin() {
    if (this.poll) return;
    this.guard(() => this.tick());
    this.poll = setInterval(() => this.guard(() => this.tick()), 3000);
  }

  /**
   * Records the account's usage reading when a run starts (the card enters Running) and when it ends (Review or Done), so the card
   * can say how many percentage points the account moved while the task ran. Runs on every status change, whichever path made it.
   */
  private stampUsage(task: Task, from: Status, to: Status) {
    if (task.adopted) return; // a found session's account is only a name; its runs are not the board's to meter
    const now = Date.now();
    const runs = task.usageRuns ?? [];
    const open = runs.find((r) => !r.endedAt);
    if (to === "running" && from !== "needs-input") {
      if (open) return; // a running task that running again is not a new run
      runs.push({ startedAt: now, start: startReading(this.usageOf(task), now) });
    } else if (!((to === "review" || to === "done") && this.endRun(task))) return;
    task.usageRuns = runs;
    this.save(); // update() saves before it fires, so the stamp needs its own save; tick() saves again, harmlessly
  }

  /** Ends the task's open usage run with its account's reading now; false when none is open. Not saved here. */
  private endRun(task: Task): boolean {
    const open = task.usageRuns?.find((r) => !r.endedAt);
    if (!open) return false;
    open.endedAt = Date.now();
    open.end = this.usageOf(task);
    return true;
  }

  /** The latest usage reading of the task's account, or undefined when there is none or the account cannot be resolved. */
  private usageOf(task: Task) {
    if (task.provider === "grok" || task.provider === "antigravity") return undefined;
    try { return readUsage(task.provider === "codex" ? CODEX_DIR : this.configDirOf(task)); } catch { return undefined; }
  }

  private loadedAt = 0;
  /** When this window's tick last ran: a window that slept (its timers paused) does not take the board the moment it wakes (tick). */
  private lastTick = Date.now();
  private mtime() {
    try {
      return fs.statSync(this.file).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** Errors from timers and watchers are reported instead of escaping into the extension host. */
  private guard(fn: () => void) {
    try {
      fn();
    } catch (e) {
      console.error("Entomatical:", e);
    }
  }

  /**
   * One VS Code window owns a repo's board: only it scans sessions and writes tasks.json, so two windows on the
   * same repo can't overwrite each other's cards. The others show the owner's board and take over when it closes
   * or stops refreshing owner.json. Every call renews the owner's heartbeat there; tick() makes one every 3 seconds.
   */
  isOwner(takeover = false): boolean {
    return !this.disposed && claimOwner(path.join(this.dir, "owner.json"), undefined, undefined, undefined, undefined, takeover);
  }

  /**
   * For changes that act outside tasks.json first (git, files, a terminal or panel) and record the result after: save() would refuse
   * only then, leaving the work done but unrecorded (a worktree and branch that block the next Start, a renamed events file).
   * The extension calls it too, before steps it takes ahead of such a change (Switch account stops the session first).
   */
  mustOwn() {
    if (!this.isOwner()) throw new Error(NOT_OWNER);
  }
  /** Async inbox operations must also belong to a still-live owner instance. */
  private mustOwnActive() {
    if (!this.owned) throw new Error(NOT_OWNER);
    this.mustOwn();
  }

  /** Whether this window held the board at its last tick. */
  private owned = false;
  private importedSpeech = false;

  private rememberSpeechIds(cards: Task[], remembered = speechImportIds(this.repo)) {
    const count = remembered.size;
    for (const card of cards) if (card.legacySpeechId) remembered.add(card.legacySpeechId);
    if (remembered.size !== count) {
      this.mustOwn();
      writeFileAtomic(path.join(this.dir, "speech-imported.json"), JSON.stringify([...remembered]));
    }
  }

  private tick() {
    // After sleep every window's timers wake together: one whose own last tick is stale too waits a tick, so the owner renews first.
    const slept = Date.now() - this.lastTick > 15_000;
    this.lastTick = Date.now();
    if (Date.now() - this.notInMainAt >= 15_000) void this.refreshNotInMain().catch(() => undefined); // every window draws the line, so each reads git itself
    if (this.isOwner(!slept)) {
      // Just took over: the old owner's last save may be newer than the list loaded at this window's last poll, and discover() saves over it.
      const tookOver = !this.owned;
      if (tookOver && this.reload("takeover") === undefined) {
        // Unreadable just now: give the claim back, or a save before the next tick would write the stale list over that save.
        try { writeFileAtomic(path.join(this.dir, "owner.json"), JSON.stringify({ pid: 0, at: 0 })); } catch { /* the next tick tries again */ }
        return;
      }
      if (tookOver) { this.acpCatalogs = undefined; this.loadNotifications(true); this.published.clear(); this.publishStatus(true); } // read the previous owner's latest catalogs before publishing
      this.owned = true;
      if (this.rerooted) this.guard(() => this.save()); // F118: the paths corrected when the list was read, written once (a failed write tries again next tick)
      if (tookOver) {
        this.importedSpeech = false;
        this.hooksChecked.clear(); // the previous owner's final settings rewrite may still be pending
      }
      if (!this.importedSpeech) this.guard(() => {
        const remembered = speechImportIds(this.repo);
        const imported = speechHistory(this.repo, this.tasks, remembered);
        if (imported.length) {
          if (fs.existsSync(this.file) && !fs.existsSync(this.file + ".before-speech-merge")) fs.copyFileSync(this.file, this.file + ".before-speech-merge", fs.constants.COPYFILE_EXCL);
          this.save([...this.tasks, ...imported]);
        }
        // Reconcile even when the previous owner saved the cards but its marker write failed.
        this.rememberSpeechIds(this.tasks, remembered);
        this.importedSpeech = true;
      });
      // Hook events no window applied (a reload, an owner change) or with no watcher come in before discover(), so a Stop that landed
      // meanwhile gives a normal Review, not a quiet one for a session that is gone.
      if (tookOver) for (const task of this.tasks) {
        this.applied.set(task.id, Date.parse(task.updatedAt));
        recoverReview(this, task, this.reviewIsLive?.(task.id) ?? false);
      }
      for (const task of this.tasks) if (tookOver || task.legacySpeechId || !this.watcher || this.held.has(task.id)) this.syncStatus(task.id, true);
      this.discover();
      for (const task of this.tasks) if (task.sessionId) {
        try { this.metrics.persist(task); } catch (e) { console.error("Entomatical: usage snapshot", e); }
      }
      this.checks.sync();
      for (const task of this.tasks) if (task.awaitingPlanExit && !this.hasProcess(task)) {
        const plan = this.get(task.awaitingPlanExit);
        this.update(task, { awaitingPlanExit: undefined });
        if (!plan?.planRun || !this.isPlanStep(task, plan) || task.status !== "review" || task.stepHold || task.interrupted || task.cancelled || task.takenOver) continue;
        if (!task.checks && task.completion?.commands.length) this.preparePlanChecks(task, plan);
        this.queuePlanStep(task, plan);
      }
      this.reconcileGoverned();
      void this.reconcileOperations().catch((e) => console.error("Entomatical: operations", e)); // phase 4: before anything replays
      this.guard(() => this.settleVault()); // FR2: an upload whose window went has an unknown outcome, said on its card
      this.publishStatus();
      void this.processInbox();
      this.checkResets();
      for (const id of [...this.pendingNotices.keys()]) this.deliverNotices(id); // a watcher that was still ending at the first try
      return;
    }
    this.owned = false;
    this.acpCatalogs = undefined; // A reader uses the owner's latest saved choices on its next redraw.
    this.ownerAt = 0;
    this.cardTerminals.shutdown();
    // Another window writes the board; this one still tracks which sessions are live, for the dots and Open.
    const moved = this.scan();
    if (!this.reload() && moved) this.changed.fire();
  }

  /**
   * Loads tasks.json again when another window saved it since this one last read or wrote it; true if it did, undefined when it could
   * not be read just now. A takeover may set a corrupt file aside. Confirmation must read the file even on a coarse clock.
   */
  private reload(mode: "poll" | "takeover" | "confirm" = "poll"): boolean | undefined {
    if (mode !== "confirm" && this.mtime() === this.loadedAt) return false;
    const tasks = readArray<Task>(this.file, mode === "takeover");
    if (!tasks) return undefined;
    if (mode === "confirm") {
      const ids = new Set<string>();
      for (const row of tasks) {
        if (typeof row?.id !== "string" || !row.id || ids.has(row.id) || typeof row.title !== "string" || typeof row.prompt !== "string"
          || !["queued", "running", "needs-input", "review", "done"].includes(row.status)) return undefined;
        ids.add(row.id);
      }
      // Keep live task references when the fresh read matches the complete persisted state.
      if (JSON.stringify(tasks) === JSON.stringify(this.tasks)) {
        this.loadedAt = this.mtime();
        return false;
      }
    }
    this.tasks = this.adopt(tasks);
    this.loadedAt = this.mtime();
    this.changed.fire();
    return true;
  }

  /**
   * F118: a list just read gets its saved paths corrected to this board's folder (src/moved.ts), so a workspace folder that was
   * renamed or moved keeps its cards' worktrees, check runs and reviews. Any window corrects what it shows; the owner writes the
   * correction at its next tick. Only lists read from disk are corrected (and records restored from an archive): a path the board
   * sets while it runs is left as given.
   */
  private rerooted = false;
  private adopt(tasks: Task[]): Task[] {
    if (rerootTasks(tasks, this.dir)) this.rerooted = true;
    return tasks;
  }

  private activity = "";
  private unresolvedCodex = new Set<string>();

  /** Refreshes the live sessions; true when any started, stopped, changed status, or a live task's subagents moved. */
  private scan(): boolean {
    const key = () => [...this.external.values()].map((s) => s.sessionId + s.status + s.name + s.nameSource).join();
    const was = key();
    this.external = new Map();
    const unresolved = new Set<string>();
    const codex = liveCodexSessions(this.repo, codexAccounts()[0]?.name, undefined, unresolved);
    for (const cwd of unresolved) if (!this.unresolvedCodex.has(cwd))
      void vscode.window.showWarningMessage(`Entomatical could not identify a Codex thread's process in ${cwd}. Its session and Stop action are unavailable until ownership is clear.`);
    this.unresolvedCodex = unresolved;
    for (const s of [...liveSessions(this.repo), ...codex]) {
      if (Date.now() - (this.stoppedSessions.get(`${s.pid}:${s.sessionId}`) ?? Infinity) > 15_000) continue;
      // One conversation open twice (a board terminal and the panel's history): the one at work, else the one that changed last. The OS lists files in its own order.
      const had = this.external.get(s.sessionId), idle = (x: LiveSession) => x.status === "idle";
      const better = !had || (idle(had) && !idle(s)) || (idle(had) === idle(s) && (s.statusUpdatedAt ?? 0) > (had.statusUpdatedAt ?? 0));
      if (better) this.external.set(s.sessionId, s);
    }
    const activity = this.tasks
      .filter((t) => (t.sessionId || t.cardTerminalStarted) && t.status !== "done")
      .map((t) => `${t.id}:${this.lastActivityAt(t)}`)
      .join();
    const moved = was !== key() || activity !== this.activity;
    this.activity = activity;
    return moved;
  }

  /** Refreshes the live sessions now instead of at the next 3 s tick. */
  rescan() {
    if (this.scan()) this.changed.fire();
  }

  /** Refresh evidence before a card action, including turns started directly in an editor. */
  reconcile(task: Task) {
    this.mustOwn();
    this.syncStatus(task.id, true);
    this.discover();
  }

  /**
   * Waits, rescanning, until the task's session has ended: no terminal or background run of the board's, and gone from `external`.
   * The CLI writes sessions/<pid>.json for the board's own terminals too, so a stopped one stays in `external` until its process
   * exits and a scan sees that. True once it ended; false after `ms`.
   */
  async ended(task: Task, ms = 10_000): Promise<boolean> {
    for (const end = Date.now() + ms; this.hasProcess(task) && Date.now() < end; ) {
      await sleep(200);
      this.rescan();
    }
    return !this.hasProcess(task);
  }

  /** Session ids whose terminal this board closed, with when: a Resume right after Stop waits for them to leave `external`. */
  private readonly ending = new Map<string, number>();

  /** Before resuming: a session this board stopped in the last 15 s may still be exiting, so wait for it rather than call it "running elsewhere". */
  private async settle(task: Task) {
    const at = task.sessionId ? this.ending.get(task.sessionId) : undefined;
    if (at === undefined) return;
    this.ending.delete(task.sessionId!);
    if (Date.now() - at < 15_000 && this.external.has(task.sessionId!) && !this.terminal(task)) await this.ended(task);
  }

  /** Redraw the board, e.g. after the account list changed. */
  refresh() {
    this.changed.fire();
  }

  /** ACP text streams in many small chunks: redraw at most every 500 ms, the first at once and the last always (audit finding 13). */
  private redrawSoon() {
    if (this.redrawTimer) return;
    const fire = () => { this.redrawTimer = undefined; this.redrawnAt = Date.now(); this.changed.fire(); };
    const wait = this.redrawnAt + 500 - Date.now();
    if (wait <= 0) fire(); else (this.redrawTimer = setTimeout(fire, wait)).unref?.();
  }
  private redrawnAt = 0;
  private redrawTimer?: NodeJS.Timeout;

  get dismissedFile() {
    return path.join(this.dir, "dismissed.json");
  }

  /** Adds sessions running in this repo that the board did not start (once they have a prompt), and tracks their status. */
  private discover() {
    const moved = this.scan();
    const live = [...this.external.values()];
    const now = new Date().toISOString();
    let dirty = false;
    // Found cards from outside this repo (e.g. a test repo inside .entomatical) were added by an older version.
    const kept = this.tasks.filter((t) => !(t.adopted && t.worktree && !inRepo(this.repo, t.worktree)));
    if (kept.length !== this.tasks.length) {
      this.tasks = kept;
      dirty = true;
    }
    for (const s of live) {
      if (this.dismissed.has(s.sessionId)) continue;
      const task = this.tasks.find((t) => t.sessionId === s.sessionId);
      if (task) {
        // A found card mirrors its session; hooks are more precise, so one resumed from the board follows those.
        const mirrored = task.adopted && !this.terminal(task) && (task.status !== "done" || task.ended);
        const mirroredStatus = statusOf(s) === "review" && this.busySubagents(task) ? "running" : statusOf(s);
        if (mirrored && (task.status !== mirroredStatus || task.ended)) {
          const from = task.status;
          Object.assign(task, { status: mirroredStatus, interrupted: undefined, ended: undefined, updatedAt: now, statusAt: now });
          this.status.fire({ task, from, to: task.status });
          dirty = true;
        }
        if (task.adopted && s.account && task.account !== s.account) {
          task.account = s.account; // accounts are discovered after the first scan, and a folder can be re-logged-in
          dirty = true;
        }
        const transcript = s.provider ? s.transcript : transcriptPath(s.configDir, s.cwd, s.sessionId);
        if (task.adopted && task.transcript !== transcript) {
          task.transcript = transcript; // the account folder may have been renamed
          dirty = true;
        }
        const first = task.adopted && task.transcript ? firstPrompt(task.provider, task.transcript) : undefined;
        if (first && first !== task.prompt) {
          Object.assign(task, { prompt: first });
          dirty = true;
        }
        continue;
      }
      const transcript = s.provider ? s.transcript : transcriptPath(s.configDir, s.cwd, s.sessionId);
      const first = transcript && firstPrompt(s.provider, transcript);
      if (!first) continue; // an empty Claude tab; wait for its first prompt
      this.tasks.push({
        id: crypto.randomBytes(3).toString("hex"),
        title: (!s.provider && sessionTitle(transcript)) || s.name || first.trim().split("\n")[0].slice(0, 60),
        prompt: first,
        account: s.account,
        provider: s.provider,
        worktree: s.cwd,
        sessionId: s.sessionId,
        status: statusOf(s),
        adopted: true,
        transcript,
        createdAt: now,
        updatedAt: now,
      });
      dirty = true;
    }
    for (const t of this.tasks) {
      if (!t.adopted && t.sessionId && !t.provider) this.keepHistory(t);
      const transcript = this.transcriptOf(t);
      // A queued Claude card whose session never came up and has nothing running (its terminal was closed after the 10-minute ready wait ran
      // out, or after a window reload) shows Start again. start() resets one closed during its wait; this catches the rest. A saved
      // transcript means a conversation exists, so resetUnstarted (through everReady) leaves such a card alone.
      if (!t.provider && t.status === "queued" && this.resetUnstarted(t)) dirty = true;
      // F53: a card with no typed or generated title (named unset: the tickbox unticked, Auto-start off, or naming failed) and not
      // adopted keeps its prompt's first line: only a
      // rename made in Claude Code (custom-title, or a live name with nameSource "user") replaces it, never Claude's generated name.
      const own = !t.named && !t.adopted;
      const live = t.sessionId ? this.external.get(t.sessionId) : undefined;
      const title = (transcript && !t.provider && sessionTitle(transcript, { customOnly: own })) || ((!own || live?.nameSource === "user") && live?.name);
      if (title && title !== t.title) {
        t.title = title;
        dirty = true;
      }
      // A Codex task in Codex's editor follows its rollout: a turn started there moves the card, and notifies, like a hook would.
      const rolled = t.status === "done" ? undefined : this.codexEditorStatus(t);
      if (rolled && (rolled !== t.status || t.interrupted && (rolled === "running" || readRollout(this.transcriptOf(t)!)?.done))) {
        const from = t.status;
        Object.assign(t, { status: rolled, interrupted: undefined, updatedAt: now, statusAt: now });
        // A turn aborted in Codex's editor (Esc) is unfinished work, as for Claude's Esc: quiet.
        const quiet = rolled === "review" && !readRollout(this.transcriptOf(t)!)?.done;
        this.status.fire({ task: t, from, to: rolled, ...(quiet ? { quiet } : {}) });
        dirty = true;
      }
      // A stale Interrupted card can have live workers, or a turn restarted outside the board. Restore it from current evidence.
      const session = t.sessionId ? this.external.get(t.sessionId) : undefined;
      if (t.status === "review" && !t.cancelled && !t.provider && (this.busySubagents(t) || t.interrupted && session?.status === "busy"
        && (session.statusUpdatedAt ?? 0) > Date.parse(t.statusAt ?? t.updatedAt))) {
        const from = t.status;
        Object.assign(t, { status: "running", interrupted: undefined, updatedAt: now, statusAt: now });
        this.status.fire({ task: t, from, to: "running" });
        this.held.add(t.id); this.applied.delete(t.id); // reconsider the parent's end after its workers settle
        dirty = true;
      }
      if (this.interrupted(t)) {
        // Quiet: the user pressed Esc or declined at the terminal, so "finished" would be false. Interrupted now, not in a listener:
        // the first status line written must already carry the chip (a watcher is told once, F71).
        const from = t.status;
        Object.assign(t, { status: "review", updatedAt: now, statusAt: now, interrupted: true });
        this.status.fire({ task: t, from, to: "review", quiet: true });
        dirty = true;
        continue;
      }
      const gone = (!!t.sessionId || !!t.cardTerminalStarted) && !this.hasProcess(t) && !rolled && !this.busySubagents(t);
      const stale = Date.now() - Date.parse(t.updatedAt) > 10_000; // rides out a resume restarting the process
      if (!gone || !stale) continue;
      if (t.provider === "codex" && t.worktree && this.unresolvedCodex.has(t.worktree)) continue;
      if (t.headless && t.status === "needs-input" && ((t.plan && !t.approved) || t.finishAsked)) continue; // a master waiting for Approve or on its self-finish (Unsure, a failed step): its run ended with a Stop
      if (t.headless && t.status === "needs-input" && t.refusalStop) continue; // F91: its hook stopped the run; it waits for a follow-up, not Review
      if (t.adopted && t.status !== "done") {
        // A found session that was closed goes to Done (marked ended, so it comes back if reopened).
        const from = t.status;
        Object.assign(t, { status: "done", ended: true, updatedAt: now, statusAt: now });
        this.status.fire({ task: t, from, to: t.status });
        dirty = true;
      } else if (!t.adopted && (t.status === "running" || t.status === "needs-input")) {
        // A board task that ended without a Stop hook (stopped, killed, VS Code closed) waits for review. Quiet: "finished" would be false.
        const from = t.status;
        Object.assign(t, { status: "review", updatedAt: now, statusAt: now, interrupted: true });
        this.status.fire({ task: t, from, to: "review", quiet: true });
        dirty = true;
      }
    }
    if (dirty) this.save();
    else if (moved) this.changed.fire();
  }

  /**
   * A board task's turn ended without a Stop hook: the CLI fires none when the user presses Esc mid-turn or answers "No, tell Claude…"
   * at a permission prompt. Idle alone is not proof: long tool calls can leave that same session state.
   */
  private interrupted(t: Task): boolean {
    // A found card resumed in a board terminal follows its hooks, not its session file (discover), so it needs this too.
    if ((t.adopted && !this.terminal(t)) || t.provider || !t.sessionId || (t.status !== "running" && t.status !== "needs-input")) return false;
    // A hidden run's session file reads "idle" while a long tool call runs (seen live, 4 November 2026: a master flickered to Interrupted
    // during board.js wait); a headless run ends with a Stop, or its process goes, so only the gone check below applies to it.
    if (t.headless) return false;
    if (this.external.get(t.sessionId)?.status !== "idle") return false;
    const settled = (ms: number) => Date.now() - ms > 5000;
    // A background subagent still working after its parent's Stop keeps the card Running (syncStatus); one silent for 15 minutes does not.
    const transcript = this.transcriptOf(t);
    return settled(Date.parse(t.updatedAt)) && settled(this.events(t.id).at(-1)?.t ?? 0) && !this.busySubagents(t)
      && !!transcript && transcriptInterrupted(transcript);
  }

  /** The account folder Claude Code panels use for new chats; set by the extension. */
  ideConfigDir: () => string | undefined = () => undefined;
  /** The account folder whose history the Claude Code panel lists; set by the extension. */
  panelHistoryDir: () => string | undefined = () => undefined;
  // While the board is open as an editor tab, task terminals open as editor tabs beside it.
  sessionsInEditor: () => boolean = () => false;

  /**
   * Keeps a board session in the Claude Code panel's history (see linkIntoHistory), for its own account and the
   * IDE's. A launch file goes with it, so resuming from that history runs in the task's worktree and account.
   */
  private keepHistory(task: Task) {
    const transcript = this.transcriptOf(task);
    let own: string;
    try {
      own = this.configDirOf(task) || DEFAULT_DIR;
    } catch {
      return; // account not discovered yet, or gone
    }
    // A resume from panel history reads this file as it is, including the permission mode and script paths.
    if (!this.hooksChecked.has(task.id)) this.refreshHooks(task);
    if (!transcript) return;
    try {
      linkIntoHistory(transcript, [own, this.ideConfigDir() ?? own, this.panelHistoryDir() ?? own], this.repo, task.sessionId!);
      if (task.worktree && fs.existsSync(task.worktree) && !fs.existsSync(this.launchFile(task.sessionId!))) this.writeLaunch(task.sessionId!, task, undefined, false);
    } catch (e) {
      if (!this.linkFailed.has(task.id)) console.error("Entomatical: history link", e); // once, not every tick
      this.linkFailed.add(task.id);
    }
  }
  private readonly linkFailed = new Set<string>();
  private readonly hooksChecked = new Set<string>();

  private refreshHooks(task: Task) {
    try {
      if (fs.statSync(this.hooksFile(task.id), { throwIfNoEntry: false })) this.writeHooks(task);
      this.hooksChecked.add(task.id);
    } catch (e) {
      this.hooksChecked.delete(task.id); // the next owner poll retries from the committed card
      console.error("Entomatical: hooks refresh", e);
    }
  }

  get file() {
    return path.join(this.dir, "tasks.json");
  }
  eventsFile(id: string) {
    const saved = this.get(id)?.legacySpeechId;
    const legacy = saved && /^[a-zA-Z0-9-]{1,80}$/.test(saved) ? saved : undefined;
    return legacy ? path.join(this.repo, ".entomatical-speech", "events", `${legacy}.jsonl`) : path.join(this.dir, "events", `${id}.jsonl`);
  }
  hooksFile(id: string) {
    const saved = this.get(id)?.legacySpeechId;
    const legacy = saved && /^[a-zA-Z0-9-]{1,80}$/.test(saved) ? saved : undefined;
    return legacy ? path.join(this.repo, ".entomatical-speech", "hooks", `${legacy}.json`) : path.join(this.dir, "hooks", `${id}.json`);
  }
  get(id: unknown) {
    return this.tasks.find((t) => t.id === id);
  }

  private save(tasks = this.tasks, staged?: { task: Task; next: Task }) {
    if (!this.isOwner()) {
      const kept = readArray<Task>(this.file, false); // drop the unsaved change
      if (kept) this.tasks = this.adopt(kept); else this.loadedAt = 0; // unreadable just now: the next tick reads it again
      throw new Error(NOT_OWNER);
    }
    if (staged && !tasks.includes(staged.task)) throw new Error("The card changed before this update could be saved.");
    const rows = staged ? tasks.map(t => t === staged.task ? staged.next : t) : tasks;
    writeFileAtomic(this.file, JSON.stringify(rows, null, 2));
    const retiring = staged && staged.next.retiringChecks !== staged.task.retiringChecks && staged.next.retiringChecks?.length;
    if (staged) Object.assign(staged.task, staged.next);
    this.tasks = tasks;
    this.rerooted = false; // F118: what adopt() corrected is on disk now
    this.loadedAt = this.mtime();
    if (retiring) this.guard(() => this.checks.retire(staged.task, false));
    this.changed.fire();
    this.guard(() => this.publishStatus(false, true));
  }
  /**
   * Writes tasks.json and nothing else: no redraw, no status publish, so it is safe inside a status listener (F108's turn count).
   * save()'s publish there delivers settle notices before the other listeners have run. Another window's board does not write.
   */
  private writeTasks() {
    if (!this.isOwner()) return;
    writeFileAtomic(this.file, JSON.stringify(this.tasks, null, 2));
    this.loadedAt = this.mtime();
  }

  /** The change key of the last status line written per card (status.jsonl, F70). */
  private readonly published = new Map<string, string>();
  /** Each card's statusInputs when its change key was last worked out: a save skips the cards whose inputs are the same. */
  private readonly projected = new Map<string, string>();
  /**
   * What a card's status record takes from the board, as opposed to from its events file and transcript: the card itself, its waiting
   * notices and why its checks wait. Undefined when its record takes the clock (no readable statusAt or updatedAt): never the same.
   */
  private statusInputs(t: Task): string | undefined {
    if (!Date.parse(t.statusAt ?? t.updatedAt)) return undefined;
    return `${JSON.stringify(t)}\n${this.pendingNotices?.get(t.id)?.size ?? 0}\n${t.completion?.commands.length ? checksWait(t, this.tasks) ?? "" : ""}`;
  }
  get statusFile() { return path.join(this.dir, "status.jsonl"); }
  /** The status record of a card now (spec 5.4): what status.jsonl and the settle notices carry. */
  statusOf(task: Task, now = Date.now(), activityAt = this.lastActivityAt(task)): StatusRecord {
    return statusRecord(task, { events: this.events(task.id), lastActivityAt: activityAt, lastReply: this.lastReply(task), now, noticesWaiting: this.pendingNotices?.get(task.id)?.size, repeating: this.repeatingOf(task),
      checksWait: task.completion?.commands.length ? checksWait(task, this.tasks) : undefined });
  }
  /**
   * Appends a status line for every card whose record changed (not its age or quiet minutes), so `board.js wait` wakes only on a
   * change. `all` rewrites the file with every card: when this window takes the board over, and when the file has grown past 1 MB.
   * `changed` (Board.save) looks only at the cards whose statusInputs changed: a save changes no events file or transcript, and the
   * watcher and the 3 s tick still look at every card for those. True when a record was written.
   */
  publishStatus(all = false, changed = false): boolean {
    if (!this.owned && !all) return false;
    this.publishCapabilities();
    this.loadNotifications();
    const now = Date.now();
    let out = "";
    const settled: Task[] = [];
    for (const t of this.tasks) {
      const inputs = this.statusInputs(t);
      if (changed && !all && inputs !== undefined && this.projected.get(t.id) === inputs && this.published.has(t.id)) continue;
      if (inputs === undefined) this.projected.delete(t.id); else this.projected.set(t.id, inputs);
      // The change key leaves out quiet, the only use of lastActivityAt (its transcript and subagent lookups were 70 % of a save at
      // 1,000 cards): an unchanged card is judged without them, and a changed card's record is built again in full, as before.
      let r = all ? this.statusOf(t, now) : this.statusOf(t, now, 0);
      const key = CHANGE_KEY(r);
      if (!all && this.published.get(t.id) === key) continue;
      if (!all) r = this.statusOf(t, now);
      this.published.set(t.id, key);
      out += JSON.stringify(r) + "\n";
      if (this.noteSettle(t, r)) settled.push(t);
    }
    for (const t of settled) this.deliverNotices(t.watchedBy ?? t.openedBy!);
    // Phase 3: a governed card's status change is a material event of its run (board.js overview --since), then the run's snapshot.
    let governed = false;
    for (const line of out.split("\n").filter(Boolean)) {
      let r: { id?: string; status?: string; checks?: string } = {};
      try { r = JSON.parse(line); } catch { continue; }
      const t = r.id ? this.get(r.id) : undefined, gov = t ? governedRootOf(t, this.tasks) : undefined;
      if (gov?.root && !all) { this.governedEvent(gov.root, t!.id, "status", `${r.status}${r.checks ? `, checks ${r.checks}` : ""}`); governed = true; }
    }
    if (governed) try { this.save(); } catch { /* not the owner any more */ }
    this.publishGoverned();
    for (const t of this.tasks) if (t.orchestrator && !t.orchestrator.root) { this.recoverRoleNotices(t); this.schedulePressureWatcher(t); this.scheduleJudgments(t); }
    try {
      if (all) writeFileAtomic(this.statusFile, out);
      else if (out) {
        let size = 0;
        try { size = fs.statSync(this.statusFile).size; } catch { /* none yet */ }
        if (size > 1_000_000) this.publishStatus(true); else fs.appendFileSync(this.statusFile, out);
      }
    } catch (e) { console.error("Entomatical: status.jsonl", e); }
    return !!out;
  }
  private capabilitiesText = "";
  /** The CLI reads the host's actual account/model choices and clock zone, rather than guessing in another runtime. */
  private publishCapabilities() {
    // Phase 3: governedRuns (profiles, assignments, submissions, leases); board.js capabilities adds the caller's own profile catalog.
    const clock = hostClock();
    const data = JSON.stringify({ protocolVersion: GOVERNED_PROTOCOL, at: new Date(Math.floor(Date.now() / 10_000) * 10_000).toISOString(),
      hostTimezone: clock.hostTimezone, hostTimeOffsets: clock.hostTimeOffsets, live: this.live(),
      capabilities: { headless: [...RUNTIMES], nestedCards: true, nativeSubagents: true, pressureWatchers: true, standingRoles: ["judge", "scribe", "research"], controls: ["integrate <child>", "switch", "finish self", "finish <id>", "claim", "claim-tree", "request-takeover", "handoff"], runBudget: true, governedRuns: GOVERNED_CAPABILITY },
      // Fix 11: each provider's short names first, each with the id it runs now (newest); a full id of an older version runs that too.
      models: [...MODELS.map((id) => ({ runtime: "claude", id, newest: claudeModelId(id) })), // the full id Claude Code is handed (F92)
        ...[...shortNames("codex", this.codexModelIds()).map((n) => n.name), ...this.codexModelIds()].map((id) => {
          const newest = tryResolve("codex", id, this.codexModelIds())!;
          return { runtime: "codex", id, ...(newest !== id ? { newest } : {}), efforts: codexModels().find((m) => m.model === newest)?.efforts };
        }),
        // Grok and Antigravity: only what each account's agent last advertised (no fixed list exists).
        ...this.accountList().filter((a) => a.provider === "grok" || a.provider === "antigravity").flatMap((a) => {
          const seen = this.acpCatalog(a), efforts = seen?.options.find((o) => o.category === "thought_level")?.values.map((v) => v.value);
          const values = seen?.options.find((o) => o.category === "model")?.values ?? [], ids = values.map((v) => v.value);
          const short = shortNames(a.provider!, ids).filter((n) => !ids.includes(n.name)).map((n) => ({ value: n.name, name: familyLabel(n.name), newest: n.id }));
          return [...short, ...values].map((v) => ({ runtime: a.provider, id: v.value, name: v.name, ...("newest" in v ? { newest: v.newest } : {}), account: a.name, lastSeen: seen!.at, ...(efforts?.length ? { efforts } : {}) }));
        })],
      accounts: this.accountList().map((a) => ({ name: a.name, runtime: a.provider ?? "claude", ...(a.provider === "codex" ? { aliases: ["Codex"] } : {}) })),
    });
    if (data !== this.capabilitiesText) { writeFileAtomic(path.join(this.dir, "capabilities.json"), data); this.capabilitiesText = data; }
  }
  /** The live line (F70): what the session is doing right now, from its latest tool call, while its turn runs. */
  doingOf(task: Task): { text: string; at: number } | undefined {
    if (task.status !== "running" && task.status !== "needs-input") return undefined;
    const hook = liveLine(this.events(task.id));
    if (!task.headless || task.provider === "grok" || task.provider === "antigravity") return hook;
    // A headless run also streams its assistant text (4.2): the newer of the two sources wins.
    const stream = this.streamTail(task);
    return stream && (!hook || (stream.at ?? 0) > hook.at) ? { text: stream.text, at: stream.at ?? Date.now() } : hook;
  }
  /** The last assistant text of a headless run's stream file, read from its tail only. */
  private streamTail(task: Task): { text: string; at?: number } | undefined {
    const file = headlessFiles(this.dir, task.id).stream;
    let fd: number;
    try { fd = fs.openSync(file, "r"); } catch { return undefined; }
    try {
      const size = fs.fstatSync(fd).size, length = Math.min(size, 64 * 1024), buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return streamText(buffer.toString("utf8"));
    } catch { return undefined; } finally { fs.closeSync(fd); }
  }
  /** The card's last twenty events as timeline lines (F70). */
  timelineOf(task: Task) {
    // Prompts a session resumed outside the card sent (outsidePrompts) join the card's own events, by when they were written.
    const outside = task.provider || !task.sessionId ? [] : this.outsidePrompts(task, this.hookPrompts(task, REPLY_CAP)).outside;
    if (!outside.length) return timeline(this.events(task.id));
    const added: HookEvent[] = outside.filter((p) => Number.isFinite(p.at)).map((p) => ({ t: p.at, hook_event_name: "UserPromptSubmit", prompt: p.text, source: "transcript" }));
    return timeline([...this.events(task.id), ...added].sort((a, b) => a.t - b.t));
  }

  /** The call ledger's folder (ledger.ts LEDGER_DIR); tests point it elsewhere. */
  ledgerDir = LEDGER_DIR;
  /** Parsed ledger index files, kept until the file's size or modification time changes (the ledger appends every 30 s). */
  private readonly ledgerCache = new Map<string, { key: string; index: LedgerIndex }>();
  /**
   * The efficiency summary of the card's current session (F77), from the call ledger and the card's first Stop, or undefined: a Codex
   * card (the ledger covers Claude only), no session, or a session the ledger has not indexed yet. Never throws: a missing or
   * half-written index is no data yet, and the render goes on.
   */
  efficiencyOf(task: Task): Efficiency | undefined {
    if (task.provider || !task.sessionId || !/^[0-9a-zA-Z-]{1,80}$/.test(task.sessionId)) return undefined;
    const file = path.join(this.ledgerDir, "sessions", `${task.sessionId}.jsonl`);
    try {
      const st = fs.statSync(file), key = `${st.size}:${st.mtimeMs}`;
      let hit = this.ledgerCache.get(file);
      if (hit?.key !== key) { hit = { key, index: parseIndex(fs.readFileSync(file, "utf8")) }; this.ledgerCache.set(file, hit); }
      return efficiency(hit.index, firstStopAt(this.events(task.id), task.sessionId));
    } catch {
      this.ledgerCache.delete(file);
      return undefined;
    }
  }

  /** Repeating (F80) of a card whose turn runs: the same tool call several times in a row in the current prompt. */
  repeatingOf(task: Task): { tool: string; n: number } | undefined {
    return task.status === "running" || task.status === "needs-input" ? repeating(this.events(task.id)) : undefined;
  }

  /** Latest observed activity: hooks, editor turns, worker transcripts, and the card terminal's own output (Grok and Antigravity fire no hooks). */
  private lastActivityAt(task: Task): number | undefined {
    let at = Math.max(this.events(task.id).reduce((latest, e) => Math.max(latest, e.t), 0), this.cardTerminals.lastOutputAt(task.id) ?? 0);
    const transcript = this.transcriptOf(task);
    try { if (transcript) at = Math.max(at, fs.statSync(transcript).mtimeMs); } catch { /* no readable transcript yet */ }
    for (const agent of this.subagentsOf(task)) at = Math.max(at, agent.updated);
    return at || undefined;
  }

  /** When a running board card last heard from its session or workers; not for found sessions. */
  lastEventAt(task: Task): number | undefined {
    return task.status === "running" && !task.adopted ? this.lastActivityAt(task) : undefined;
  }

  add(title: string, prompt: string, account?: string, parentId?: string, model?: string, effort?: string, completion?: Task["completion"], step?: Pick<Task, "dependsOn" | "workflow" | "permission" | "headless" | "openedBy" | "watchedBy" | "orchestrator" | "held" | "planFirst" | "role" | "judge" | "planRun" | "approved" | "plan" | "cardTerminal" | "battle" | "runPolicy" | "spec" | "profile" | "governedBy" | "assignment" | "delegation" | "council">, batch?: Task[]): Task {
    // Phase 3: a card added under a governed run (a child request, or the user's own subtask) gets an authorized profile and the run's marker.
    // A saved plan builds all of its cards synchronously in a private copy before publishing the complete graph.
    const rows = batch ?? this.tasks, up = rows.find((t) => t.id === (step?.openedBy ?? parentId)), gov = up ? governedRootOf(up, rows) : undefined;
    // Phase 5: council members get role "research": the same read-only launch as a judge (plan mode, read-only sandbox) without being taken
    // for the run's standing judge (runCards(...).find(role === "judge")), which would feed it per-child judgments.
    // Phase 5: a council member's judge profile was pinned with the council at approval; it is not a delegable child profile.
    if (gov && step?.council) { if (!gov.root?.governed?.council) throw new Error(`Governed run ${gov.id} has no council.`); step = { ...step, governedBy: gov.root.id }; }
    else if (gov) {
      if (!gov.root) throw new Error(`Governed run ${gov.id} has no root on the board any more; no card can be added under it.`);
      if (step?.battle || step?.planRun || (step?.orchestrator && !step.openedBy)) throw new Error("Battle Royale, plan-file runs and new orchestrator roots are not supported inside a governed run (phase 3).");
      const g = gov.root.governed!;
      // A child request is bounded by its opener's allowance; the user's own subtask by the root's (his approval is the bound).
      const p = childProfile(step?.openedBy ? allowanceOf(up!) : g.delegation, g, profileRef(step?.profile));
      if ("error" in p) throw new Error(p.error);
      if (step?.profile?.mode === "strict" && p.selection.mode === "strict" && step.profile.snapshot.hash !== p.selection.snapshot.hash) throw new Error(`Profile ${p.ref}: this revision differs from the snapshot governed run ${gov.root.id} approved.`);
      if (governedDepth(up!, gov.root.id, rows) + 1 > g.limits.depth) throw new Error(`Governed run ${gov.root.id}: depth limit (${g.limits.depth}).`);
      step = { ...step, profile: JSON.parse(JSON.stringify(p.selection)), governedBy: gov.root.id };
    }
    const name = account || this.accountList()[0]?.name;
    // An Antigravity model id (claude-opus-5-5) is not Claude's "opus": it stays as it is (resolveAccount keeps the named account).
    const named = name ? this.accountList().find((a) => a.name === name.trim()) : undefined;
    model = model ? (named?.provider === "antigravity" ? model : normalizeModel(model)) : undefined;
    // Codex offers its own models, and each model its own effort levels (codex.ts).
    const found = this.resolveAccount(name, model); // same list as configDirOf
    const codex = found?.provider === "codex";
    const acp = found?.provider === "grok" || found?.provider === "antigravity";
    // A card keeps the model as picked (the user, 23 November 2026): an exact id runs that id while its provider lists it; a short name
    // (typed, or on an older card) still runs the newest id of its family.
    // Plan first on Codex (the user, 12 November 2026): Codex has no plan mode, so the card runs the newest Astra at ultra effort,
    // whatever was picked, and its planning prompt asks it to wait for approval (docs/orchestrator/PLANNER-CODEX.md).
    const codexPlan = codex && !!step?.planFirst && !step.headless && !step.orchestrator;
    if (codexPlan) { model = "astra"; effort = "ultra"; }
    if (name && !found && /^(grok|antigravity)(?:\s*[·:]|$)/i.test(name)) throw new Error(`Unknown provider account ${name}. Refresh Accounts and try again.`);
    // Grok and Antigravity: an unattended card (headless, orchestrator, worker) runs over ACP with what the account's agent last
    // advertised (run 0db6d1); a card in the provider's own terminal takes its CLI flags: Antigravity's model, effort and permission,
    // Grok's permission (F88; antigravityArgs and grokArgs throw otherwise). A battle card is never unattended in this sense: an orchestrator
    // contestant and the cards it opens run in their card terminals (inCardTerminal, a47807).
    const inCard = !!step?.battle && !step.headless;
    const unattended = !!(step?.headless || ((step?.orchestrator || step?.openedBy) && !inCard));
    const acpSelections = acp && unattended ? this.acpSelectionsFor(found!, model, effort) : undefined;
    if (acp && unattended) {
      if (step?.permission && !ACP_PERMISSIONS[step.permission]) throw new Error(`Unknown permission mode ${step.permission}.`);
      if (step?.permission === "ask" && (step.openedBy || step.orchestrator)) { const why = this.acpAskRefusal(found!); if (why) throw new Error(why); }
    } else if (acp) {
      if (found?.provider === "grok" && (model || effort)) throw new Error("A Grok card in its own terminal runs the model `grok models` names as its default, at Grok's own effort; a model or effort can be picked only for an unattended Grok card (Orchestrator).");
      if (found?.provider === "antigravity") antigravityArgs({ model, effort, permission: step?.permission }); else grokArgs({ permission: step?.permission });
    } else {
      let runs: string | undefined;
      try { runs = codex && model ? resolveModel("codex", model, this.codexModelIds()) : model; } // throws "Unknown model …" with the short names
      catch (e) { throw codexPlan ? new Error("Plan first on Codex runs Astra at ultra effort, and the Codex CLI lists no Astra model.") : e; }
      if (codexPlan && !codexEffortOk(runs, "ultra")) throw new Error(`Plan first on Codex runs Astra at ultra effort, and ${runs} does not offer ultra.`);
      if (model && !codex && !MODELS.includes(model)) throw new Error(`Unknown model ${model}. Valid models: ${MODELS.join(", ")}`);
      if (effort && !(codex ? codexEffortOk(runs, effort) : EFFORTS.includes(effort))) throw new Error(`Unknown effort level ${effort}.`);
      if (step?.permission && !(codex ? CODEX_PERMISSIONS[step.permission] : PERMISSIONS[step.permission])) throw new Error(`Unknown permission mode ${step.permission}.`);
    }
    const now = new Date().toISOString();
    let id: string;
    do { id = crypto.randomBytes(3).toString("hex"); } while (rows.some((t) => t.id === id));
    const task: Task = {
      id,
      parentId: rows.find((t) => t.id === parentId)?.id,
      // The first line with words once the prompt compiler's own tags are gone: an improved prompt starts with "<task>" (compile.ts).
      // Only those tags: "x < 10 and y > 5" or "List<String>" keep their text.
      title: title.trim() || untitledTitle(prompt),
      named: !!title.trim() || undefined,
      prompt,
      account: found?.name ?? name,
      configDir: found && !codex ? found.configDir ?? "" : undefined,
      provider: found?.provider,
      model: model || undefined,
      effort: effort || undefined,
      acpSelections,
      completion,
      ...step,
      // the user, 18 November 2026: a Claude or Codex orchestrator he adds runs in its card terminal, where he sees it, the board types
      // its notices (canDeliver) and the start-up watch reads its screen (cardTerminal.ts autoAnswer). A Grok or Antigravity one stays
      // headless for now, as does every card a run opens; a battle's keep their card terminals.
      headless: step?.headless || (step?.orchestrator && !step.openedBy && !inCard && acp) || undefined,
      permission: step?.permission || undefined,
      // A headless card has nobody to approve a plan (F78), and an orchestrator plans by its brief. Grok and Antigravity have no plan
      // mode; Codex plans on Astra (above).
      planFirst: step?.planFirst && (!found?.provider || codexPlan) && !step.headless && !step.orchestrator ? true : undefined,
      // Card terminal (F89) is for an attended Claude or Codex card: Grok and Antigravity always use one, a headless card has no screen.
      // A battle's orchestrator keeps its card terminal (a47807); an orchestrator the user adds always gets one (18 November 2026), and
      // one a run opens (--may-open) none.
      cardTerminal: (step?.cardTerminal || (step?.orchestrator && !step.openedBy)) && !acp && !step?.headless && (!step?.orchestrator || inCard || !step.openedBy) ? true : undefined,
      status: "queued",
      statusAt: now,
      createdAt: now,
      updatedAt: now,
    };
    // The specification is pinned to the settings the card is saved with (the user's selections, as add() normalized them), before any start.
    // What Plan first on Codex (astra, ultra) or the Orchestrator tickbox (bypass) changed is recorded, never passed off as the user's pick.
    if (task.spec) {
      const was = task.spec.execution, configured = [
        ...(codexPlan && (was.model || "") !== "astra" ? [`model: ${was.model || "default"} → astra (Plan first on Codex)`] : []),
        ...((was.effort || "") !== (task.effort ?? "") ? [`effort: ${was.effort || "default"} → ${task.effort || "default"}${codexPlan ? " (Plan first on Codex)" : ""}`] : []),
        ...((was.permission || "") !== (task.permission ?? "") ? [`permission: ${was.permission || "default"} → ${task.permission || "default"}${task.orchestrator ? " (Orchestrator)" : ""}`] : [])];
      task.spec = { ...task.spec, execution: { account: task.account ?? "", model: task.model ?? "", effort: task.effort ?? "", permission: task.permission ?? "", source: "user-selection", capabilities: task.profile?.mode === "strict" ? `${task.profile.snapshot.id}@${task.profile.snapshot.revision}` : "provider-defaults", ...(configured.length ? { configured } : {}) } };
    }
    rows.push(task);
    if (!batch) this.save();
    return task;
  }

  /** Accept the exact labels show prints, Codex's short label, or an email disambiguated by runtime/model. */
  resolveAccount(name?: string | null, model?: string | null, runtime?: Runtime): Account | undefined {
    // An explicit provider label (Codex, Grok, Antigravity) identifies the runtime even when the model is invalid.
    // Filtering it out first would silently turn that card into a Claude card.
    // An Antigravity account named exactly is that account, whatever its model: claude-opus-5-5 would otherwise ask for a Claude one.
    const antigravity = !runtime && name ? this.accountList().find((a) => a.name === name.trim() && a.provider === "antigravity") : undefined;
    if (antigravity) return antigravity;
    const explicit = name ? /^(codex|grok|antigravity)(?:\s*[·:]|$)/i.exec(name.trim())?.[1].toLowerCase() as Runtime | undefined : undefined;
    const wanted = runtime ?? explicit ?? this.runtimeOfModel(model);
    const list = this.accountList().filter((a) => !wanted || (a.provider ?? "claude") === wanted);
    if (!name) return list[0];
    const text = name.trim(), key = text.toLowerCase();
    const exact = list.find((a) => a.name === text);
    if (exact) return exact;
    const matches = list.filter((a) => a.name.toLowerCase() === key);
    if (matches.length > 1) throw new Error(`Account ${text} is ambiguous. Choose its exact profile label.`);
    return matches[0] ?? list.find((a) => a.provider === "codex" && (key === "codex" || a.name.replace(/^Codex\s*[·:]\s*/i, "").toLowerCase() === key))
      ?? (key === "grok" || key === "antigravity" ? list.find((a) => a.provider === key) : undefined);
  }

  /** The model and thought-level options each Grok or Antigravity account last advertised: ids and labels only, nothing secret. */
  private acpCatalogs?: Record<string, AcpCatalog>;
  private acpCatalogUnsaved = false;
  private get acpCatalogFile() { return path.join(this.dir, "acp-catalog.json"); }
  private acpKey(a: { provider?: string; configDir?: string; name?: string; account?: string }) { return `${a.provider}:${a.configDir || a.name || a.account || ""}`; }
  private acpCatalogAll() {
    if (!this.acpCatalogs) {
      try { this.acpCatalogs = JSON.parse(fs.readFileSync(this.acpCatalogFile, "utf8")); } catch { this.acpCatalogs = {}; }
      this.acpCatalogUnsaved = false;
    }
    return this.acpCatalogs!;
  }
  /** The last advertised catalog of an ACP account, or undefined before any session of it opened. */
  acpCatalog(account: Account): AcpCatalog | undefined {
    const row = this.acpCatalogAll()[this.acpKey(account)];
    return account.provider === "antigravity" && (row?.loginId ?? "") !== this.antigravityLoginId() ? undefined : row;
  }
  antigravityLoginId = (): string => "";
  private rememberAcpOptions(task: Task, options: AcpOption[], source?: "session/new", loginId = this.antigravityLoginId()) {
    if (task.provider === "antigravity" && loginId !== this.antigravityLoginId()) return;
    // The mode list too, so Ask can be refused at add when the account advertises no mode that asks (askMode).
    const kept = options.filter((o) => o.category === "model" || o.category === "thought_level" || o.category === "mode")
      .map((o) => ({ id: o.id, name: o.name, category: o.category, values: o.values.map((v) => ({ value: v.value, name: v.name })) }));
    const all = this.acpCatalogAll(), key = this.acpKey({ ...task, name: task.account });
    const previous = this.acpCatalog({ name: task.account ?? "", provider: task.provider, configDir: task.configDir });
    // Only session/new reports the Antigravity default before the card applies its own model.
    let defaultModel = previous?.defaultModel;
    if (source === "session/new" && task.provider === "antigravity") {
      const model = options.find((o) => o.category === "model");
      const id = model?.currentValue;
      defaultModel = isExactModel("antigravity", id) && model?.values.some((v) => v.value === id) ? id : undefined;
    }
    const offered = kept.length ? kept : previous?.options;
    if (!offered) return;
    if (defaultModel !== previous?.defaultModel || JSON.stringify(previous?.options) !== JSON.stringify(offered)) {
      all[key] = { at: new Date().toISOString(), options: offered, defaultModel, ...(task.provider === "antigravity" && loginId ? { loginId } : {}) };
      this.acpCatalogUnsaved = true;
    }
    if (!this.acpCatalogUnsaved) return;
    try {
      writeFileAtomic(this.acpCatalogFile, JSON.stringify(all, null, 2));
      this.acpCatalogUnsaved = false;
    } catch (e) { console.error("Entomatical: acp-catalog.json", e); }
  }
  /** Why Ask cannot be enforced on an unattended card of this ACP account, once it has advertised options; undefined before that. */
  acpAskRefusal(account: Account): string | undefined {
    const seen = this.acpCatalog(account)?.options;
    return seen && !askMode(seen) ? noAskMode(account.name, seen) : undefined;
  }
  /** The advertised mode Ask selects on this ACP account, from its last catalog; undefined when none is known. */
  acpAskMode(account: Account): string | undefined {
    const seen = this.acpCatalog(account)?.options;
    return seen ? askMode(seen)?.value : undefined;
  }
  /**
   * --model and --effort for a Grok or Antigravity account: the advertised option's id and value. Before the account ever advertised
   * options they are queued under their category and checked when the session opens (runHeadlessAcp).
   */
  private acpSelectionsFor(account: Account, model?: string, effort?: string): Record<string, string> | undefined {
    const catalog = this.acpCatalog(account)?.options, out: Record<string, string> = {};
    for (const [category, flag] of ACP_PICKS) {
      const value = flag === "model" ? model : effort;
      if (!value) continue;
      const option = catalog?.find((o) => o.category === category);
      // A model's short name or older id matches the newest advertised id of its family (fix 11), resolved again when the session opens.
      const values = option?.values.map((v) => v.value) ?? [];
      if (catalog && !(flag === "model" ? tryResolve(account.provider!, value, values) : values.includes(value)))
        throw new Error(`${account.name} does not advertise ${flag} ${value}. Last seen: ${option?.values.map((v) => v.value).join(", ") || "none"}.`);
      out[option?.id ?? category] = value;
    }
    return Object.keys(out).length ? out : undefined;
  }
  /**
   * F91: the RefusalStop line hook.js wrote when it stopped this card's headless Claude run, when it still applies: no prompt since it
   * in this session, and no newer run of the card launched since (headlessStartedAt: a follow-up or Resume with Bypass clears it).
   */
  private refusalStopIn(task: Task, current: HookEvent[]): HookEvent | undefined {
    if (task.provider || !task.headless) return undefined;
    const main = current.filter((e) => e.agent_id === undefined);
    const at = main.findLastIndex((e) => e.hook_event_name === "RefusalStop" && !!e.refusal_stop && typeof e.refusal_stop === "object");
    if (at < 0 || main.findLastIndex((e) => e.hook_event_name === "UserPromptSubmit") > at) return undefined;
    return main[at].t > (this.headlessStartedAt.get(task.id) ?? 0) ? main[at] : undefined;
  }
  /**
   * F91, Resume with Bypass: a headless run its hook stopped continues in the same session with Bypass permissions; the settings file
   * is written again at launch (writeHooks), so the calls refused before are allowed.
   */
  async resumeWithBypass(task: Task): Promise<void> {
    if (!task.refusalStop) throw new Error("This card was not stopped by refused calls.");
    this.mustOwn();
    this.update(task, { permission: "bypass", pendingPermission: undefined });
    await this.followUpHeadless(task, RESUME_BYPASS_TEXT);
  }

  /** The ids Codex lists now. An id an old card used is no longer kept: it runs the newest of its family (fix 11). */
  private codexModelIds(): string[] { return codexModels().map((m) => m.model); }
  /** The id Codex's model/list marks as its default (a card on Default model runs it); tests replace it. */
  codexDefaultId = (): string | undefined => codexDefaultModel();
  /** Reads Codex's account and model list again (model/list); tests replace it. */
  discoverCodexModels: () => Promise<void> = () => discoverCodex();
  /** The `model` Codex's effective config sets for a folder (config.toml in CODEX_HOME or the WSL home, or the project's); tests replace it. */
  codexConfiguredModel = (cwd: string): Promise<string | undefined> => codexConfigModel(cwd);
  /** Per card on Default model: the model Codex's config sets, read by codexModelReady just before a launch. */
  private codexConfigured = new Map<string, string>();
  /**
   * Before a Codex launch changes anything: the exact id it will pass (codexLaunchModel). A card on Default model reads the model
   * Codex's config sets for its folder (what Codex itself would run with no -m); Codex's model list is read once more when it is not
   * known yet (a start right after a window reload). Throws the refusal otherwise. A resumed thread keeps the model it ran on.
   */
  private async codexModelReady(task: Task, resume = false): Promise<void> {
    if (task.provider !== "codex") return;
    if (resume && this.codexThreadModel(task)) return;
    if (!task.model) {
      // Before the card's worktree exists (a start checks its model first): the folder it will branch from.
      const configured = await this.codexConfiguredModel(task.worktree ?? this.get(task.parentId)?.worktree ?? this.repo);
      if (configured) this.codexConfigured.set(task.id, configured); else this.codexConfigured.delete(task.id);
    }
    if (!this.codexModelIds().length || (!task.model && !this.codexConfigured.get(task.id) && !this.codexDefaultId())) await this.discoverCodexModels();
    try { this.codexLaunchModel(task, resume); } catch (e) { throw Object.assign(e as Error, { modelRefused: true }); }
  }
  /** The exact id a Codex card's thread ran on: the one the board sent, else the model its SessionStart reported. */
  private codexThreadModel(task: Task): string | undefined {
    if (task.sentModel && isExactModel("codex", task.sentModel)) return task.sentModel;
    const reported = this.events(task.id).findLast((e) => e.hook_event_name === "SessionStart" && typeof e.model === "string")?.model as string | undefined;
    return reported && isExactModel("codex", reported) ? reported : undefined;
  }
  /** The exact id a Codex launch passes (codexLaunchModel), recorded on the card as the model it was handed. */
  private codexSend(task: Task, resume = false): string {
    const id = this.codexLaunchModel(task, resume);
    if (task.sentModel !== id && this.get(task.id) === task) this.update(task, { sentModel: id });
    return id;
  }
  /** What `agy models` lists, as listed (fix 11); tests replace it. */
  agyModelIds = (): string[] => antigravityListed();
  /**
   * Each account's default model by name, for the menus' "Default: Fable 5.2" entry (the user, 23 November 2026). Claude: `model` in the
   * account's settings.json; Codex: the id its model/list marks; Antigravity: the model a fresh ACP session opened on; Grok: its
   * reported model, else what `grok models` names (asked once per profile). An account whose default is not known is left out.
   */
  defaultModels(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const a of this.accountList()) {
      let name: string | undefined;
      if (a.provider === "codex") { const id = this.codexDefaultId(); name = id && modelLabel("codex", id); }
      else if (a.provider) {
        const catalog = this.acpCatalog(a), option = catalog?.options.find((o) => o.category === "model");
        const id = a.provider === "antigravity" ? catalog?.defaultModel : option?.currentValue;
        name = option?.values.find((v) => v.value === id)?.name;
        if (!name && a.provider === "grok") {
          const seen = grokDefaultSeen(a.configDir ?? "");
          if (!seen.asked) void this.grokModels(a.configDir ?? "").then((l) => { if (l.default) this.changed.fire(); }, () => undefined);
          name = seen.id;
        }
      } else {
        let set: unknown;
        try { set = JSON.parse(fs.readFileSync(path.join(a.configDir || path.join(os.homedir(), ".claude"), "settings.json"), "utf8")).model; } catch { /* no settings file */ }
        const id = typeof set === "string" ? set.replace(/\[.*\]$/, "").trim() : "";
        name = id && modelLabel("claude", claudeModelId(normalizeModel(id)));
      }
      if (name) out[a.name] = name;
    }
    return out;
  }
  /** Reads `agy models` again; tests replace it. */
  discoverAgy: () => Promise<void> = () => discoverAntigravityModels();
  /**
   * The runtime a model name belongs to when no account names one (fix 11). Claude's aliases and ids stay Claude's (opus is Claude's
   * unless an Antigravity account is named); gpt-oss and Gemini are Antigravity's although gpt-oss starts with gpt-.
   */
  private runtimeOfModel(model?: string | null): Runtime | undefined {
    const m = model?.trim().toLowerCase();
    if (!m) return undefined;
    if (MODELS.includes(normalizeModel(m))) return "claude";
    const agy = [...ANTIGRAVITY_FAMILIES, ...shortNames("antigravity", this.agyModelIds()).map((n) => n.name)].filter((f) => !MODELS.includes(f));
    if (/^(gemini-|gpt-oss)/.test(m) || agy.includes(m)) return "antigravity";
    if (/^grok(-|$)/.test(m)) return "grok";
    if (/^gpt-/.test(m) || shortNames("codex", this.codexModelIds()).some((n) => n.name === m)) return "codex";
    return undefined;
  }
  /**
   * The exact id a card's model runs (Session details), when it is not the name itself: the id its latest launch was handed
   * (sentModel), else what a launch would send now: a Claude card's CLAUDE_MODEL_IDS entry (F92), a Codex card's newest id of its
   * family or, on Default model, Codex's default; Antigravity's newest id of the card's family, or what a Grok or Antigravity account
   * last advertised for an unattended card. Undefined when unknown before a launch (a Grok terminal reads `grok models` at its start).
   */
  modelOf(task: Task): string | undefined {
    if (task.sentModel && task.provider) return task.sentModel !== task.model ? task.sentModel : undefined;
    if (!task.provider) return task.model ? claudeModelId(this.fableBlocked(task) ? "opus" : task.model) : undefined;
    if (task.provider === "codex" && !task.model) return this.codexConfigured.get(task.id) ?? this.codexDefaultId();
    if (!task.model) return undefined;
    const unattended = !!(task.openedBy || task.orchestrator), acp = task.provider === "grok" || task.provider === "antigravity";
    const account = acp && unattended ? this.accountList().find((a) => a.name === task.account && a.provider === task.provider) : undefined;
    const offered = task.provider === "codex" ? this.codexModelIds() : task.provider === "antigravity" && !unattended ? this.agyModelIds()
      : account ? this.acpCatalog(account)?.options.find((o) => o.category === "model")?.values.map((v) => v.value) ?? [] : [];
    let id = tryResolve(task.provider, task.model, offered);
    // the user's two run without the effort agy's ids carry (agyLaunchModel): Session details name the id the terminal passes.
    if (id && task.provider === "antigravity" && !unattended && antigravityTakesEffort(task.model)) id = id.replace(/-(low|medium|high)$/, "");
    return id && id !== task.model ? id : undefined;
  }
  /**
   * The model id a Codex launch passes: the newest listed id of the card's family; a full id passes as it is before Codex listed any.
   * A card with no model (Default model) passes the id Codex's model/list marks as its default (the user, 17 November 2026: exact ids
   * only); before Codex listed one, the start is refused rather than leave the choice to Codex.
   */
  private codexLaunchModel(task: Task, resume = false): string {
    const thread = resume ? this.codexThreadModel(task) : undefined;
    if (thread) return exactModel("codex", thread);
    const ids = this.codexModelIds();
    if (!task.model) {
      // What Codex itself runs with no -m: the model its config sets (read just before the launch), else model/list's default.
      const id = this.codexConfigured.get(task.id) ?? this.codexDefaultId();
      if (!id) throw new Error("This Codex card uses Codex's default model, and Codex has not said which model that is (its config sets none and its model list marks none). Check Codex's sign-in under Accounts, then try again, or add a new card with a model, or move this card to another account.");
      return exactModel("codex", id);
    }
    if (!ids.length && parseModel("codex", task.model)?.version.length) return exactModel("codex", task.model);
    if (!ids.length) throw new Error(`This Codex card names ${task.model}, and Codex has not listed its models yet, so its exact id is unknown. Check Codex's sign-in under Accounts, then try again.`);
    return exactModel("codex", resolveModel("codex", task.model, ids));
  }
  /**
   * The id an Antigravity terminal runs (fix 11), never another model than the card's: Opus, Argon or Carbon (F88; Carbon from 14 November 2026) runs the newest version
   * `agy models` lists, without the effort some of its ids carry (the card's --effort applies); one of agy's own ids runs the newest
   * version with the same effort in its id. The list is read again when it is missing; a sign-in that lists no such model refuses the start.
   */
  private async agyLaunchModel(model: string): Promise<string> {
    const versioned = !!parseModel("antigravity", model)?.version.length;
    if (!this.agyModelIds().length && !versioned) await this.discoverAgy();
    const ids = this.agyModelIds();
    if (!ids.length) {
      if (versioned) return exactModel("antigravity", model);
      throw new Error("Antigravity has not listed its models (agy models). Check its sign-in, then try again.");
    }
    if (ids.includes(model)) return exactModel("antigravity", model); // an exact listed id runs as picked (F123)
    const family = parseModel("antigravity", model)?.family ?? model;
    if (!antigravityTakesEffort(model)) {
      const id = tryResolve("antigravity", model, ids);
      if (!id) throw new Error(`This Antigravity sign-in does not list ${model}. It lists: ${ids.join(", ")}.`);
      return exactModel("antigravity", id);
    }
    const id = newestOf("antigravity", family, ids);
    if (!id) throw new Error(`This Antigravity sign-in lists no ${familyLabel(family)} model. It lists: ${ids.join(", ")}.`);
    return exactModel("antigravity", id.replace(/-(low|medium|high)$/, ""));
  }
  /** What `grok models` lists for a Grok profile (its GROK_HOME), and the id it names as its default; tests replace it. */
  grokModels: (grokHome: string) => Promise<{ ids: string[]; default?: string }> = (grokHome) => discoverGrokModels(grokHome);
  /**
   * The exact id a Grok terminal runs (the user, 17 November 2026: exact ids only): the default `grok models` names for the card's
   * profile, or the card's own model resolved against that list (the newest id of its family). Read at every start, so a new default
   * is used as soon as Grok has one; a profile whose `grok models` names none refuses the start.
   */
  private async grokLaunchModel(task: Task): Promise<string> {
    const listed = await this.grokModels(task.configDir ?? "");
    if (task.model) {
      const id = tryResolve("grok", task.model, listed.ids);
      if (!id) throw new Error(`This Grok profile does not list ${task.model}${listed.ids.length ? `. It lists: ${listed.ids.join(", ")}` : " (grok models listed nothing; check its sign-in)"}.`);
      return exactModel("grok", id);
    }
    if (!listed.default) throw new Error("This Grok card uses Grok's default model, and `grok models` did not say which model that is. Check this Grok profile's sign-in under Accounts, then try again.");
    return exactModel("grok", listed.default);
  }

  private workflowCtx(): WorkflowContext { return { localBudget: this.localBudget, owner: this.instance, boardRoot: path.resolve(this.repo), verifyReceipt: (t, r) => {
    const task = this.get(t.id);
    if (!task?.integrated || task.integrated.head !== r.revision) return "Accepted evidence is not integrated at its recorded revision";
    return this.planEvidenceProblem(task, r);
  } }; }
  /** The step's readiness or waiting reason (workflow.ts), for the card. */
  readinessOf(task: Task) { return task.workflow ? readiness(task, this.tasks, this.workflow, this.workflowCtx()) : undefined; }

  /**
   * The workflow gate every launch path passes (Start, Resume, panel continuation, follow-up, account change). An ordinary card passes.
   * A step with an open attempt continues it only while its claims, approval, admissions and dependencies still hold; otherwise the step
   * must be ready, and a new attempt is persisted and takes its claims before anything launches.
   */
  gate(task: Task, mode?: LaunchMode, reserve = true) {
    this.checkRetiringChildren(task);
    const planProblem = this.planLaunchProblem(task);
    if (planProblem) throw new Error(planProblem);
    // Capability profile first, before any worktree, claim or process: an unsupported strict scope never launches broader (phase 2).
    const blocked = this.profileProblem(task, mode);
    if (blocked) throw new Error(blocked);
    // Phase 3: a governed card runs only with an authorized profile and an execution lease, reserved here before any launch effect.
    const gov = governedRootOf(task, this.tasks);
    if (gov) {
      const why = this.governedProblem(task, gov);
      if (why) throw new Error(why);
      if (reserve) this.reserveLease(task, gov.root!);
    }
    // A folder git no longer knows (Finish merged and deregistered it, then could not delete it): git there finds the main checkout.
    if (task.worktree && !task.adopted && inWorktreeRoot(this.repo, task.worktree) && fs.existsSync(task.worktree) && !checkedOut(task.worktree)) throw new Error(leftoverText(task));
    // M-02: its work landed and Finish kept the worktree whole until what used it has ended. New work there would be written after
    // the result, where no Finish merges it again.
    if (task.cleanup && task.merged && task.worktree && !task.adopted) throw new Error(LEFTOVER_MERGED);
    if (task.waitsForReset) this.update(task, { waitsForReset: undefined }); // CORE-GOV-03: a restart ends the wait for the account's reset
    const s = task.workflow;
    if (!s) return;
    this.mustOwn(); // before a claim: save() would refuse only after admit or reopen took it
    const why = this.gateProblem(task);
    if (why) throw new Error(why);
    const ctx = this.workflowCtx();
    if (s.attempt && s.outcome === "pending") {
      const wait = reopen(task, this.workflow, ctx);
      if (wait) throw new Error(wait);
    } else if (!admit(task, this.workflow, ctx)) throw new Error("Slot taken by another window");
    this.save();
  }

  /** Neither editor transport answers approval requests. The interactive terminal can collect the owner's answer. */
  private startsInCodexEditor(task: Task): boolean {
    return task.provider === "codex" && this.codexEditor() && !interactive(task.workflow) && !task.cardTerminal
      && CODEX_PERMISSIONS[task.permission ?? ""]?.approvalPolicy !== "on-request";
  }

  /** An editor reopen/queue cannot send overrides. Only ordinary unconfigured legacy cards can inherit an unrecorded policy. */
  private canReopenCodexEditor(task: Task): boolean {
    if (task.cardTerminal || interactive(task.workflow)) return false;
    if (task.permission !== undefined && task.permission !== "bypass") return false;
    const policy = task.codexEditorPolicy;
    if (!policy) return task.permission === undefined && task.role !== "judge" && task.role !== "research";
    return policy.threadId === task.sessionId && policy.sandbox === codexThreadPermissions(task).sandbox;
  }

  /** The provider and launch mode a start or resume of this card takes, as profiles.ts names routes. The panel is passed by its callers. */
  routeOf(task: Task, mode?: LaunchMode): { provider: ProfileProvider; mode: LaunchMode } {
    const provider: ProfileProvider = task.provider ?? "claude";
    const unattended = !!(task.headless || ((task.orchestrator || task.openedBy) && !task.battle));
    if (provider === "grok" || provider === "antigravity") return { provider, mode: unattended ? "headless" : "in-card" };
    if (mode) return { provider, mode };
    if (task.headless) return { provider, mode: "headless" };
    if (task.cardTerminal) return { provider, mode: "in-card" };
    if (provider === "codex") return { provider, mode: (task.sessionId ? task.codexEditor && this.canReopenCodexEditor(task) : this.startsInCodexEditor(task)) ? "editor" : "terminal" };
    return { provider, mode: task.panel ? "panel" : "terminal" };
  }

  /** Why the card's pinned capability profile cannot run on this route, or undefined (Provider defaults, or a verified strict route). */
  profileProblem(task: Task, mode?: LaunchMode): string | undefined { return this.profileCheck(task, mode)?.text; }
  /** profileProblem with the resolver's reasons, for the new-task form's short line and its full lists (F110 finding F2). */
  profileCheck(task: Task, mode?: LaunchMode): { text: string; route?: string; reasons?: ProfileReason[] } | undefined {
    // The form and the launch gate use this same check before changing the card, taking a lease or making a worktree.
    if (task.provider === "codex") {
      try {
        codexThreadPermissions(task);
        if (task.pendingPermission !== undefined) codexThreadPermissions({ permission: task.pendingPermission });
      } catch (e) { return { text: e instanceof Error ? e.message : String(e) }; }
      if (task.codexEditorPolicy && task.codexEditorPolicy.threadId !== task.sessionId) {
        return { text: "The saved session ID differs from the provider-confirmed Codex thread. Check the card's session history before resuming." };
      }
      if (mode === "editor" && !this.canReopenCodexEditor(task)) return { text: "Use Resume to apply this card's permissions in a terminal on the same Codex thread." };
    }
    const sel = task.profile as unknown;
    if (sel === undefined || (sel as { mode?: unknown })?.mode === "provider-defaults") return undefined;
    // Anything else that is not a readable strict snapshot (a newer build's mode, a damaged file) is refused, never run as Provider defaults.
    const why = snapshotProblem(sel);
    if (why) return { text: `This card's capability profile is unreadable (${why}). It is kept unchanged; the card cannot be started, resumed or switched until it is repaired.` };
    const strict = sel as Extract<ProfileSelection, { mode: "strict" }>, route = this.routeOf(task, mode);
    try {
      const r = resolveProfile(strict, { ...route, inventory: this.profileInventory(task),
        platform: process.platform, version: () => route.provider === "claude" ? this.claudeVersion() : undefined,
        credential: (ref) => { try { return ref.startsWith("env:") ? !!({ ...process.env, ...this.taskEnv(task) } as Record<string, string | undefined>)[ref.slice(4)] : ref.startsWith("account:") ? !!this.resolveAccount(ref.slice(8)) : false; } catch { return false; } } });
      if (r.state !== "blocked") return undefined;
      // The probe waives only what its recipe answers (the unverified route, inherited extras, unknown sources).
      const probe = this.strictRecipe(task, mode);
      if (probe && typeof probe !== "string" && r.reasons.every((x) => PROBE_WAIVES.includes(x.code))) return undefined;
      return { text: blockedText(strict.snapshot, r) + (typeof probe === "string" ? ` Strict probe: ${probe}.` : ""), route: r.route, reasons: r.reasons };
    } catch (e) { return { text: `Capability profile ${strict.snapshot.name} r${strict.snapshot.revision} could not be resolved (${e instanceof Error ? e.message : String(e)}); nothing was started.` }; }
  }

  /** The Claude CLI's version, asked once per window and only when a proven strict route needs it (no route is proven yet). */
  private claudeCli?: { version?: string };
  private claudeVersion(): string | undefined {
    if (!this.claudeCli) { try { this.claudeCli = { version: execFileSync(claudeBinary(), ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true }).match(/\d+\.\d+\.\d+/)?.[0] }; } catch { this.claudeCli = {}; } }
    return this.claudeCli.version;
  }

  private profileInventory(task: Task) {
    const provider = task.provider ?? "claude", cwd = task.worktree ?? this.repo;
    const configDir = task.provider === "grok" ? task.configDir ?? "" : this.configDirOf(task);
    const home = provider === "codex" ? CODEX_DIR : configDir || path.join(os.homedir(), provider === "antigravity" ? ".gemini" : `.${provider}`);
    return { provider, home, cwd, ...inventory(provider, configDir, cwd) };
  }

  /** O5: what this card would inherit on its route as Provider defaults, for the user to read before he chooses it. */
  inheritedBy(task: Task) {
    const { provider, home, cwd, items, unknown } = this.profileInventory(task);
    const enabled = items.filter((f) => f.enabled);
    const s = task.profile?.mode === "strict" ? task.profile.snapshot : undefined;
    return { id: task.id, account: task.account, provider, home, cwd, ref: s && `${s.id}@${s.revision}`, hash: s?.hash,
      enabled, items: enabled.map((f) => `${f.kind} ${f.id} (${f.source})`), unknown };
  }
  /**
   * O5 (the user, 17 November 2026): his explicit "Run with Provider defaults instead" on a strict card. The choice is recorded on the
   * card with the profile it replaced; nothing else weakens a strict card. A live session keeps its scope (O7), and a governed card's
   * profile is its run's to change.
   */
  useProviderDefaults(selected: Task, preview?: ReturnType<Board["inheritedBy"]>) {
    this.mustOwn();
    if (this.reload("confirm") === undefined) throw new Error("The current board could not be read. Reopen the preview and try again.");
    const task = this.get(selected.id);
    if (!task) throw new Error("The card no longer exists.");
    if (task.profile?.mode !== "strict") throw new Error("This card has no strict capability profile.");
    if (this.live().includes(task.id)) throw new Error("The session is still running and keeps its scope. Stop it first.");
    if (governedRootOf(task, this.tasks)) throw new Error("This card's profile was authorized by its governed run and cannot be changed on the card. Cancel the card and have the run's root add it again with a profile the run allows.");
    const s = task.profile.snapshot;
    const current = this.inheritedBy(task);
    if (preview && (!isDeepStrictEqual(preview, current) || snapshotProblem(task.profile) || revisionHash(s) !== s.hash))
      throw new Error("The profile or its inherited capabilities changed while the confirmation was open. Review the current preview and try again.");
    // O7: the card now runs under a different configuration, so what was checked, judged or reviewed under the strict one is stale.
    // shortcut: clears them on the card instead of saving configuration revision n+1; move to the run-change path when that exists.
    this.update(task, { profile: { mode: "provider-defaults" }, profileReplaced: { at: new Date().toISOString(), ref: `${s.id}@${s.revision}`, hash: s.hash, inherited: current.items },
      checks: undefined, deliveryReady: undefined, judgedRevision: undefined, doneReview: undefined,
      ...(task.spec ? { spec: { ...task.spec, execution: { ...task.spec.execution, capabilities: "provider-defaults" } } } : {}) });
  }

  /** The strict-route probe's recipe for this card (strict-claude.ts), why it cannot enforce the profile, or undefined when the probe does not apply. */
  strictRecipe(task: Task, mode?: LaunchMode): StrictClaude | string | undefined {
    const sel = task.profile as ProfileSelection | undefined, route = this.routeOf(task, mode);
    if (!this.strictProbe || sel?.mode !== "strict" || route.provider !== "claude" || !["terminal", "in-card", "panel"].includes(route.mode)) return undefined;
    const cwd = task.worktree ?? this.repo, configDir = this.configDirOf(task);
    return strictClaude(sel.snapshot.variants.claude?.items ?? [], inventory("claude", configDir, cwd), configDir, cwd, this.strictMcpFile(task.id));
  }

  /** The selected MCP servers' definitions for one launch. They can hold a server's tokens (env, headers): mode 0600, deleted when the session ends. */
  private strictMcpFile(id: string) { return path.join(this.dir, "launch", `${id}.mcp.json`); }
  /** The extra args the panel wrapper adds for a strict card (no secrets; it names the MCP file). */
  private strictArgsFile(id: string) { return path.join(this.dir, "launch", `${id}.strict.json`); }

  /**
   * Before a strict card's launch: writes its MCP file (0600) and, for the panel wrapper, its args file; for any other card removes both,
   * so a card switched to Provider defaults is not started strict by a stale file. Returns the recipe; throws when it cannot enforce the profile.
   */
  private writeStrict(task: Task, mode?: LaunchMode): StrictClaude | undefined {
    const r = this.strictRecipe(task, mode);
    if (typeof r === "string") throw new Error(`Strict probe: ${r}.`);
    const mcp = this.strictMcpFile(task.id), argsFile = this.strictArgsFile(task.id);
    if (!r) { fs.rmSync(mcp, { force: true }); fs.rmSync(argsFile, { force: true }); return undefined; }
    fs.mkdirSync(path.dirname(mcp), { recursive: true });
    fs.writeFileSync(mcp, JSON.stringify(r.mcpConfig, null, 2), { mode: 0o600 });
    fs.chmodSync(mcp, 0o600); // the mode above applies only to a new file
    fs.writeFileSync(argsFile, JSON.stringify({ args: r.args }, null, 2));
    return r;
  }

  /** Phase 3: why a governed card may not run at all now (root gone, unsupported mode, an unauthorized or altered profile, a failed dependency). */
  governedProblem(task: Task, gov = governedRootOf(task, this.tasks)): string | undefined {
    if (!gov) return undefined;
    const root = gov.root;
    if (!root) return `Governed run ${gov.id} has no root on the board any more; this card stays blocked until the user repairs or cancels it.`;
    const planProblem = this.planLaunchProblem(task);
    if (planProblem) return planProblem;
    if (task.adopted) return "Adopted or found sessions are not supported in governed runs (phase 3); nothing was started.";
    if (task.battle) return "Battle Royale is not supported in governed runs (phase 3); nothing was started.";
    if (task.id !== root.id) {
      if (!authorizedBy(root.governed!, task.profile))
        return `Card ${task.id}'s capability profile (${profileRef(task.profile) ?? "none"}) is not one governed run ${root.id} authorized; nothing was started.`;
      if (!task.sessionId) { const dep = dependencyBlock(task, this.tasks); if (dep) return `${dep}.`; }
    }
    return undefined;
  }
  /** Phase 3: takes the card's execution lease (or shares the one it holds) before a launch; refuses when admission says wait. */
  private reserveLease(task: Task, root: Task) {
    this.mustOwn();
    const g = root.governed!;
    const held = g.leases.find((l) => l.card === task.id);
    // Phase 4: a launch another board instance (a crashed or reloaded window) reserved may have started a session that has not reported
    // yet. It is reconciled before any replay: the tick makes it active when the session shows up, or releases it after the grace time.
    if (held?.state === "reserved" && held.owner && held.owner !== this.instance && !this.live().includes(task.id))
      throw new Error(`A launch of ${task.id} reserved by an earlier window at ${held.at} may have started a session that has not reported yet. Nothing was started; the board waits for it (up to 2 minutes) before another launch.`);
    if (held) {
      // A duplicate launch shares the lease it holds. A new launch of an ended session makes it a fresh reservation again, so the tick
      // cannot release it while the launch is still on its way (seen in test: a follow-up awaiting settle() lost its lease).
      if (!this.live().includes(task.id)) { held.state = "reserved"; held.at = new Date().toISOString(); held.owner = this.instance; this.save(); }
      return;
    }
    const why = admission(task, root, this.tasks, this.governedWaiting(root));
    if (why) throw new Error(`${why}. Nothing was started; the board starts it when a lease is free.`);
    const at = new Date().toISOString();
    g.leases.push({ card: task.id, op: `launch:${task.id}:${Date.parse(at)}`, at, state: this.live().includes(task.id) ? "active" : "reserved", owner: this.instance });
    this.governedEvent(root, task.id, "lease", `lease reserved (${g.leases.length} of ${g.limits.active} active)`);
    this.save();
  }
  /** Phase 3: the cards of a governed run (root first). */
  governedMembers(root: Task): Task[] { return [root, ...this.tasks.filter((t) => t.id !== root.id && governedRootOf(t, this.tasks)?.id === root.id)]; }
  /** Phase 3: who wants a lease now: parents with notices to continue on, judges with work, and held cards ready to start. */
  private governedWaiting(root: Task): Waiter[] {
    this.loadNotifications();
    const holds = new Set(root.governed!.leases.map((l) => l.card)), live = new Set(this.live()), out: Waiter[] = [];
    for (const t of this.governedMembers(root)) {
      if (holds.has(t.id) || t.cancelled || t.status === "done") continue;
      if (this.pendingNotices.get(t.id)?.size && !live.has(t.id) && this.canDeliverIgnoringLease(t)) out.push({ task: t, kind: t.role === "judge" ? "judge" : "continuation" });
      else if (t.held && t.status === "queued" && !t.sessionId && !dependencyBlock(t, this.tasks) && !queueWaitReason(t, this.tasks, 0) && (!t.workflow || this.readinessOf(t)?.state === "ready")) out.push({ task: t, kind: waiterKind(t) });
    }
    return out;
  }
  /** Phase 3: why a governed card waits before it may start (a failed dependency, or no lease for it now); undefined for a legacy card. */
  governedWait(task: Task): string | undefined {
    const gov = governedRootOf(task, this.tasks);
    if (!gov) return undefined;
    if (!gov.root) return `Blocked: governed root ${gov.id} is gone`;
    if (!task.sessionId) { const dep = dependencyBlock(task, this.tasks); if (dep) return dep; }
    return admission(task, gov.root, this.tasks, this.governedWaiting(gov.root));
  }
  /**
   * Phase 3: the user's approval makes this root a governed run (the approval row, extension.ts). Only a fresh root that has opened no card:
   * existing runs stay legacy. `pin` reads the current profile files. Changing an approved configuration (O7) is not built.
   */
  govern(master: Task, raw: unknown, pin: (id: string) => ProfileSelection, pinCouncil?: (ref: string) => CouncilSnapshot): Governance {
    this.mustOwn();
    if (master.governed) throw new Error("This run is already governed; changing an approved configuration is not built yet (O7 is undecided).");
    if (!master.orchestrator || master.orchestrator.root || master.openedBy) throw new Error("Only a root orchestrator card can become a governed run.");
    if (master.battle) throw new Error("A Battle Royale run cannot be governed (phase 3).");
    if (master.planRun) throw new Error("A plan-file run cannot be governed yet (phase 3): its steps are made from the file, not from delegation.");
    if (master.adopted) throw new Error("An adopted session cannot become a governed root (phase 3).");
    if (governedRootOf(master, this.tasks)) throw new Error("This card already belongs to a governed run.");
    if (master.approved || master.orchestrator.opened || runCards(master.id, this.tasks).length || this.tasks.some((t) => t.parentId === master.id)) throw new Error("Only a run that has not been approved and has opened no card can become governed; existing runs stay as they are.");
    const v = validateGovernance(raw, pin);
    if ("error" in v) throw new Error(v.error);
    const g = v.governance, at = new Date().toISOString();
    // Phase 5: a council only when the user chose one here; it is pinned now, with its members' judge profiles (no defaults: O3/O6).
    const ref = (raw as Record<string, unknown>).council;
    if (ref !== undefined && ref !== null && ref !== "") {
      if (typeof ref !== "string" || !pinCouncil) throw new Error("Governed run: the council must be a saved council ref (workspace:<id>)");
      g.council = { snapshot: pinCouncil(ref), rounds: [] };
      // CORE-GOV-05: a member's card must pass governedProblem at launch, so a judge profile the run does not allow is refused here, unsaved.
      for (const m of g.council.snapshot.members) if (!authorizedBy(g, g.council.snapshot.profiles[m.judgeProfile]))
        throw new Error(`Governed run: council member ${m.key}'s judge profile ${m.judgeProfile} is not one this run allows (${g.delegation.allowed.join(", ")}); allow it, or choose a council whose judges use an allowed profile.`);
    }
    if (this.live().includes(master.id) || master.status === "running") g.leases.push({ card: master.id, op: `launch:${master.id}:govern`, at, state: "active" });
    // Phase 4: the target as it was at approval, the baseline for drift (work of this run reaching it by a shell's git).
    try { const ref = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: this.repo, encoding: "utf8", windowsHide: true }).trim(); if (ref !== "HEAD") g.target = { ref, sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: this.repo, encoding: "utf8", windowsHide: true }).trim() }; } catch { /* no baseline: readiness says so */ }
    master.governed = g;
    this.governedEvent(master, master.id, "governed", `governed by the user: ${g.limits.active} active, ${g.limits.directChildren} direct, depth ${g.limits.depth}; allowed ${g.delegation.allowed.join(", ")}${g.delegation.defaultChild ? `; default ${g.delegation.defaultChild}` : "; no default child profile"}${g.council ? `; council ${g.council.snapshot.name} (${g.council.snapshot.id}@${g.council.snapshot.revision}) at ${g.council.snapshot.checkpoints.join(", ")}` : "; no council"}`);
    this.save();
    return g;
  }
  /** Cards inside a launch call (once(), launchStep()): between gate() and their process their reservation is not released. */
  private readonly launching = new Map<string, number>();
  private isLaunching(t: Task) { return this.starting.has(t.id) || (this.launching.get(t.id) ?? 0) > 0; }
  /**
   * Phase 3: a launch from gate() to its process (resume, continue, panel, editor, follow-up; fresh starts go through once()). A launch that
   * throws gives back a reservation its session never used, at once, instead of after the grace time.
   */
  private async launchStep<T>(task: Task, run: () => Promise<T>): Promise<T> {
    this.launching.set(task.id, (this.launching.get(task.id) ?? 0) + 1);
    let failed = true;
    try { const r = await run(); failed = false; return r; } finally {
      const n = (this.launching.get(task.id) ?? 1) - 1;
      if (n > 0) this.launching.set(task.id, n); else this.launching.delete(task.id);
      if (failed && n <= 0) this.releaseUnused(task);
    }
  }
  private releaseUnused(task: Task) {
    const root = governedRootOf(task, this.tasks)?.root, g = root?.governed;
    const l = g?.leases.find((x) => x.card === task.id);
    // Another window's reservation is not this launch's to give back: reconciliation settles it (phase 4).
    if (!g || !l || l.state !== "reserved" || (l.owner && l.owner !== this.instance) || this.live().includes(task.id) || this.starting.has(task.id) || !this.isOwner()) return;
    g.leases = g.leases.filter((x) => x !== l);
    this.governedEvent(root!, task.id, "lease", `lease released: the launch failed before its session started (${g.leases.length} of ${g.limits.active} active)`);
    try { this.save(); } catch { /* the tick reconciles it */ }
    this.changed.fire();
  }
  /** Phase 3: ends the leases whose sessions are known to have ended, counts sessions that run without one, and says once when a run deadlocks. */
  private reconcileGoverned() {
    const live = new Set(this.live());
    for (const id of live) this.launching.delete(id);
    for (const root of this.tasks.filter((t) => t.governed)) {
      const g = root.governed!;
      // A session that runs without a lease (resumed from a provider's own history, a turn typed in its editor) still counts: it gets one,
      // over the limit if need be, and admission stays closed until the run is back under its limit.
      for (const t of this.governedMembers(root)) if (live.has(t.id) && !g.leases.some((l) => l.card === t.id)) {
        g.leases.push({ card: t.id, op: `found:${t.id}:${Date.now()}`, at: new Date().toISOString(), state: "active" });
        this.governedEvent(root, t.id, "lease", `session found running without a lease; counted (${g.leases.length} of ${g.limits.active} active${g.leases.length > g.limits.active ? ", over the limit: nothing more is admitted until it is back under" : ""})`);
        try { this.save(); } catch { /* the next tick */ }
      }
      const r = reconcileLeases(g, this.tasks, { live: (t) => live.has(t.id), starting: (t) => this.isLaunching(t), now: Date.now() });
      if (r.changed) {
        g.leases = r.leases;
        for (const l of r.released) this.governedEvent(root, l.card, "lease", `lease released: session ended (${g.leases.length} of ${g.limits.active} active)`);
        try { this.save(); } catch (e) { console.error("Entomatical: leases", e); }
        if (r.released.length) { for (const t of this.governedMembers(root)) this.deliverNotices(t.id); this.changed.fire(); }
      }
      if (g.council) this.reconcileCouncil(root);
      const dl = deadlock(root, this.tasks, this.governedWaiting(root));
      if (dl !== g.noticed) {
        g.noticed = dl;
        if (dl) { this.governedEvent(root, root.id, "deadlock", dl); this.runEvents.fire({ kind: "note", master: root, text: dl }); }
        try { this.save(); } catch { /* the next tick */ }
      }
    }
  }
  private governedEventsFile(rootId: string) { return path.join(this.dir, "governed", `${rootId}.events.jsonl`); }
  /** Phase 3: one material event of a governed run, numbered for board.js overview --since. The caller saves (the sequence is in tasks.json). */
  private governedEvent(root: Task, card: string, kind: string, text: string) {
    const g = root.governed!;
    g.seq += 1;
    const file = this.governedEventsFile(root.id);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ seq: g.seq, at: new Date().toISOString(), card, kind, text }) + "\n");
      // Compaction keeps the newest 500 events; an older cursor gets the snapshot and expired: true (board.js overview).
      if (fs.statSync(file).size > 256_000) writeFileAtomic(file, fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-500).join("\n") + "\n");
    } catch (e) { console.error("Entomatical: governed events", e); }
  }
  private readonly governedText = new Map<string, string>();
  /** Phase 3: the run's brief and overview for board.js overview, rewritten when they change. */
  governedSnapshot(root: Task): Record<string, unknown> {
    const live = new Set(this.live()), waiting = this.governedWaiting(root);
    return { brief: governedBrief(root), overview: governedOverview(root, this.tasks, { waiting, live: (t) => live.has(t.id), budget: runBudget(root, this.tasks, (t) => this.fiveHourOf(t)), council: this.councilView(root, false),
      waitOf: (t) => t.status === "queued" && !t.sessionId ? this.governedWait(t) ?? queueWaitReason(t, this.tasks, 0) : undefined, current: (t) => this.submissionCurrent.get(t.id) }) };
  }
  /** Whether each submission still matches its worktree's HEAD, as last read from git (submit and Done read it; undefined = not read). */
  private readonly submissionCurrent = new Map<string, boolean>();
  /** Phase 3: the card's governed line for the webview: a root's limits and counts, a member's run, profile, assignment and submission. */
  governedViewOf(t: Task): Record<string, unknown> | undefined {
    const gov = governedRootOf(t, this.tasks);
    if (!gov) return undefined;
    if (t.governed) {
      const o = this.governedSnapshot(t).overview as Record<string, unknown[]>;
      return { root: t.id, isRoot: true, active: t.governed.leases.length, limit: t.governed.limits.active, directChildren: t.governed.limits.directChildren, depth: t.governed.limits.depth,
        allowed: t.governed.delegation.allowed, defaultChild: t.governed.delegation.defaultChild ?? null, seq: t.governed.seq,
        counts: Object.fromEntries(["running", "queued", "waiting", "blocked", "ready", "completed", "decisions"].map((k) => [k, (o[k] ?? []).length])), council: this.councilView(t, false) };
    }
    return { root: gov.id, missing: !gov.root || undefined, profile: profileRef(t.profile) ?? null, key: t.assignment?.key ?? null, lease: !!gov.root?.governed!.leases.some((l) => l.card === t.id),
      submitted: t.submission ? t.submission.head.slice(0, 12) : null, integrated: t.integrated ? t.integrated.after.slice(0, 12) : null, conflict: t.conflict?.files.slice(0, 5) ?? null, council: t.council ? { member: t.council.member, checkpoint: t.council.checkpoint, round: t.council.round } : null };
  }
  // ---- Phase 5 (master plan section 9): milestone council, fixed packages, reconciliation and the readiness gate ----

  /** Phase 5: what a package for this checkpoint would hold now, read from the root's spec, worktree, checks and the target. */
  private async councilFacts(root: Task, checkpoint: Checkpoint): Promise<PackageContent> {
    const g = root.governed!, run = g.council!, snap = run.snapshot, rec = root.spec?.revisions.at(-1);
    let plan: PackageContent["plan"];
    try { const file = this.planFile(root); plan = { file, hash: sha(fs.readFileSync(file, "utf8")) }; } catch { /* no plan file */ }
    let candidate: PackageContent["candidate"] = null;
    if (checkpoint !== "plan" && root.worktree && fs.existsSync(root.worktree) && checkedOut(root.worktree) && !await git(root.worktree, ["status", "--porcelain", "--untracked-files=all"]).catch(() => "unreadable"))
      candidate = { commit: await git(root.worktree, ["rev-parse", "HEAD"]), tree: await git(root.worktree, ["rev-parse", "HEAD^{tree}"]) };
    const ref = await git(this.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD");
    const target = ref === "HEAD" ? null : { ref, sha: await git(this.repo, ["rev-parse", "HEAD"]) };
    const c = root.checks, commands = root.completion?.commands ?? [];
    const changed = candidate && target ? (await git(this.repo, ["diff", "--name-only", `${target.sha}..${candidate.commit}`]).catch(() => "")).split("\n").filter(Boolean).slice(0, 200) : [];
    const prev = run.rounds.filter((r) => r.checkpoint === checkpoint && r.outcome && r.outcome.state !== "reviewing").at(-1);
    const providers = snap.members.map((m) => this.accountList().find((a) => a.name === m.account)?.provider ?? (this.accountList().some((a) => a.name === m.account) ? "claude" : undefined));
    return { v: 1, checkpoint, run: root.id,
      spec: rec ? { revision: rec.revision, hash: sha(rec.record) } : { prompt: sha(root.prompt) }, ...(plan ? { plan } : {}),
      governance: { revision: g.revision }, council: { id: snap.id, revision: snap.revision, hash: snap.hash }, rubric: snap.rubric, candidate, target,
      requirements: rec ? rec.record.requirements.slice(0, 40).map((x, i) => ({ id: rec.ids.requirements[i] ?? x.id, text: x.text.slice(0, 300) })) : [],
      acceptance: rec ? rec.record.success.criteria.slice(0, 40).map((x, i) => ({ id: rec.ids.acceptance[i] ?? x.id, text: x.text.slice(0, 300) })) : [],
      checks: commands.length ? { status: c?.status ?? "none", ...(c?.revision ? { revision: c.revision } : {}), ...(c?.clean !== undefined ? { clean: c.clean } : {}), commands, ...(c?.run ? { log: c.run } : {}) } : null,
      changed, ...(prev ? { previous: { round: prev.n, package: prev.package, outcome: prev.outcome!.state, dispositions: prev.dispositions } } : {}),
      limitations: ["read-only judging is enforced by the launch (Claude plan mode, Codex read-only sandbox) and checked afterwards (the member's own worktree unchanged, git-ignored paths and other folders not checked); it is not natively verified",
        "independence: members get only this package, but they run as the same user and could read the board's files (tasks.json, other members' events); not prevented or detected",
        `diversity: ${diversity(providers)}`, "token and cost limits are not enforced; rounds, attempts and minutes are"] };
  }
  private councilRound(root: Task, checkpoint: string, n: number): Round | undefined { return root.governed?.council?.rounds.find((r) => r.checkpoint === checkpoint && r.n === n); }
  private readPackage(round: Round): ReviewPackage { return JSON.parse(fs.readFileSync(round.file, "utf8")); }
  /**
   * Phase 5: convene the saved council on one checkpoint: a fixed package, then one read-only judge card per member on exactly the
   * account, model and effort saved (an unavailable one is recorded, never substituted). Members take execution leases like any card.
   * The same package again while its round is open returns that round; a round limit reached needs the user's decision instead.
   */
  async convene(root: Task, checkpoint: string, actor = "user"): Promise<Record<string, unknown>> {
    this.mustOwn();
    const run = root.governed?.council;
    if (!root.governed || !run) throw new Error(`${root.id} has no council: the user chooses one when he approves the governed run.`);
    if (actor !== "user" && actor !== root.id) throw new Error("Only the run's root or the user convenes its council.");
    if (!(CHECKPOINTS as readonly string[]).includes(checkpoint) || !run.snapshot.checkpoints.includes(checkpoint as Checkpoint)) throw new Error(`The council reviews only ${run.snapshot.checkpoints.join(", ")}; not ${checkpoint}.`);
    if (root.paused) throw new Error("The run is paused; resume it before convening the council.");
    const cp = checkpoint as Checkpoint, since = roundsSincePass(run, cp);
    if (isDecisionRequired(run, cp)) throw new Error(`Decision required: ${since.length} round${since.length === 1 ? "" : "s"} of ${cp} without a pass (the saved limit is ${run.snapshot.limits.rounds}). the user decides: accept it as an exception (a waiver, never a council pass) or leave it blocked; more rounds need a new council configuration.`);
    const facts = await this.councilFacts(root, cp), gaps = packageGaps(facts);
    if (gaps.length) throw new Error(`The council was not convened: ${gaps.join("; ")}. Unknown evidence never passes, so no member was started.`);
    const pkg = makePackage(facts), last = run.rounds.filter((r) => r.checkpoint === cp).at(-1);
    if (last && (!last.outcome || ["reviewing", "reconciliation"].includes(last.outcome.state))) {
      if (last.package === pkg.id) return { ok: true, duplicate: true, round: last.n, package: pkg.id, note: `round ${last.n} of ${cp} is already reviewing this exact package; nothing new was started` };
      throw new Error(`Round ${last.n} of ${cp} is still ${last.outcome?.state ?? "reviewing"} (package ${last.package.slice(0, 12)}); finish it (reconcile its findings) before convening another.`);
    }
    if (since.length >= run.snapshot.limits.rounds) throw new Error(`Decision required: ${since.length} round${since.length === 1 ? "" : "s"} of ${cp} without a pass (the saved limit is ${run.snapshot.limits.rounds}). the user decides: accept it as an exception (a waiver, never a council pass) or leave it blocked; more rounds need a new council configuration.`);
    // What is reviewed, without the previous round's dispositions: the same work is not reviewed again until something about it changed.
    const subject = sha({ ...facts, previous: undefined });
    if (last && (last.subject ?? last.package) === subject && last.outcome?.state !== "unable-to-assess") throw new Error(`This exact candidate was already reviewed in round ${last.n} (${last.outcome?.state}); change the work, not the dice.`);
    const dir = path.join(this.dir, "council", root.id), file = path.join(dir, `${pkg.id}.json`);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) writeFileAtomic(file, JSON.stringify(pkg, null, 2) + "\n");
    const at = new Date(), n = run.rounds.filter((r) => r.checkpoint === cp).length + 1;
    const round: Round = { n, checkpoint: cp, package: pkg.id, subject, file, at: at.toISOString(), deadline: new Date(at.getTime() + run.snapshot.limits.minutes * 60_000).toISOString(), members: [], dispositions: [] };
    for (const m of run.snapshot.members) {
      const mr: MemberRun = { key: m.key, account: m.account, model: m.model, effort: m.effort, state: "pending", attempts: 0 };
      const acct = this.accountList().find((a) => a.name === m.account), prof = run.snapshot.profiles[m.judgeProfile];
      if (!acct) Object.assign(mr, { state: "unavailable", reason: `account ${m.account} is not signed in here; no other member is substituted` });
      else if (!READ_ONLY_PROVIDERS.includes(mr.provider = acct.provider ?? "claude")) Object.assign(mr, { state: "unavailable", reason: `read-only judging is not enforceable on ${mr.provider}: unsupported for council use` });
      else if (!prof || (prof.mode === "strict" && snapshotProblem(prof))) Object.assign(mr, { state: "unavailable", reason: `judge profile ${m.judgeProfile} is not a readable pinned snapshot` });
      // A run approved before govern() checked this: recorded here, before a card is made that governedProblem would refuse.
      else if (!authorizedBy(root.governed, prof)) Object.assign(mr, { state: "unavailable", reason: `judge profile ${m.judgeProfile} is not one governed run ${root.id} allows; no other profile is substituted` });
      round.members.push(mr);
    }
    run.rounds.push(round);
    const key = `${root.id}:${cp}:${n}`;
    this.convening.add(key);
    try { await this.startMembers(root, run.snapshot, round, pkg, actor); } finally { this.convening.delete(key); }
    this.settleRound(root, round);
    this.save();
    return { ok: true, round: n, package: pkg.id, file, members: round.members.map((x) => ({ key: x.key, card: x.card ?? null, state: x.state, ...(x.reason ? { reason: x.reason } : {}) })) };
  }
  /** Rounds whose members convene() is still starting; any other member left pending was cut off by a crash or reload. */
  private readonly convening = new Set<string>();
  private async startMembers(root: Task, snap: CouncilSnapshot, round: Round, pkg: ReviewPackage, actor: string) {
    const cp = round.checkpoint, n = round.n, file = round.file, run = { snapshot: snap };
    this.governedEvent(root, root.id, "council", `council ${cp} round ${n} convened by ${actor === "user" ? "the user" : actor}: package ${pkg.id.slice(0, 12)}${pkg.candidate ? ` (candidate ${pkg.candidate.commit.slice(0, 12)})` : ""}; ${round.members.map((m) => `${m.key} ${m.state}`).join(", ")}`);
    this.save();
    for (const mr of round.members.filter((x) => x.state === "pending")) {
      const m = run.snapshot.members.find((x) => x.key === mr.key)!;
      try {
        const card = this.add(`Council ${cp} r${n}: ${m.key}`, memberPrompt(pkg, m, n, file), m.account, root.id, m.model, m.effort, undefined,
          { headless: true, openedBy: root.id, watchedBy: root.id, role: "research", profile: JSON.parse(JSON.stringify(run.snapshot.profiles[m.judgeProfile])), council: { root: root.id, checkpoint: cp, round: n, member: m.key, package: pkg.id } });
        mr.card = card.id; mr.model = card.model ?? m.model; // the board's resolved model id, kept for the round
        this.update(card, { status: "review" });
        if (this.fableBlocked(card)) throw new Error(`the saved model ${m.model} is blocked on ${m.account} now (Fable limit); no other model is substituted`);
        await this.ensureWorktree(card);
        mr.head = await git(card.worktree!, ["rev-parse", "HEAD"]);
        const wait = this.startPolicy(card) ?? this.governedWait(card);
        if (wait) { this.update(card, { held: true, status: "queued" }); Object.assign(mr, { state: "queued", reason: wait }); }
        else { await this.startHeadless(card); Object.assign(mr, { state: "reviewing", reason: undefined, attempts: 1, at: new Date().toISOString() }); }
      } catch (e) { Object.assign(mr, { state: "unavailable", reason: `could not start: ${e instanceof Error ? e.message : String(e)}` }); }
      this.save();
    }
  }
  /** Phase 5: a round's state from its members and dispositions; a change is a run event and, once settled, a notice to the root. */
  private settleRound(root: Task, round: Round) {
    const run = root.governed!.council!, e = evaluateRound(run.snapshot, round), was = round.outcome?.state;
    round.outcome = { ...e, at: new Date().toISOString() };
    if (was === e.state) return;
    const decision = isDecisionRequired(run, round.checkpoint);
    const text = `Council ${round.checkpoint} round ${round.n}: ${e.state}${e.degraded ? " (degraded: quorum, not every member assessed)" : ""}${e.reasons.length ? `. ${e.reasons.slice(0, 5).join("; ")}` : ""}${e.dissent.length ? `. Dissent: ${e.dissent.join(", ")}` : ""}${decision ? `. Round limit reached (${run.snapshot.limits.rounds}): the user decides; no further round starts and nothing passes by itself.` : ""}`;
    this.governedEvent(root, root.id, "council", text);
    if (e.state !== "reviewing") { this.queueNotice(root.id, `council:${round.checkpoint}:${round.n}:${e.state}`, `${text}\nRecord: board.js council show ${round.checkpoint}${e.state === "reconciliation" ? `. Reconcile with board.js council reconcile ${round.checkpoint} --file <dispositions.json>` : ""}`); this.deliverNotices(root.id); }
  }
  /**
   * Phase 5: one member's judgment, from its final reply after its turn ended. Counted once: a later reply is a duplicate and ignored.
   * Not counted: an interrupted turn, a reply without a valid judgment of this package, or a worktree the member changed (read-only).
   */
  councilResult(card: Task): Promise<void> {
    // One at a time per card: a hook and the tick may both look at the same turn end.
    const p: Promise<void> = (this.councilInFlight.get(card.id) ?? Promise.resolve()).then(() => this.councilResultNow(card)).finally(() => { if (this.councilInFlight.get(card.id) === p) this.councilInFlight.delete(card.id); });
    this.councilInFlight.set(card.id, p);
    return p;
  }
  private readonly councilInFlight = new Map<string, Promise<void>>();
  private async councilResultNow(card: Task): Promise<void> {
    const c = card.council, root = c ? this.get(c.root) : undefined, round = c && root ? this.councilRound(root, c.checkpoint, c.round) : undefined;
    const mr = round?.members.find((m) => m.key === c!.member && m.card === card.id);
    if (!root || !round || !mr || !mr.at || !this.isOwner()) return;
    const since = Date.parse(mr.at), seen = mr.ended ?? 0;
    const ending = this.events(card.id).findLast((e) => e.t >= since && e.t > seen && ["Stop", "StopFailure", "Interrupt"].includes(e.hook_event_name ?? ""));
    if (!ending) return;
    mr.ended = ending.t;
    if (["returned", "invalid", "unavailable"].includes(mr.state)) {
      mr.duplicates = (mr.duplicates ?? 0) + 1;
      this.governedEvent(root, card.id, "council", `council ${round.checkpoint} round ${round.n}: a later reply from ${mr.key} was ignored; its ${mr.state} result stands`);
      this.save(); return;
    }
    const reply = ending.hook_event_name === "Stop" ? (typeof ending.last_assistant_message === "string" ? ending.last_assistant_message : this.finalReply(card) ?? "") : "";
    const wt = card.worktree, head = wt ? await git(wt, ["rev-parse", "HEAD"]).catch(() => "") : "";
    const clean = !!wt && head === mr.head && await isClean(wt).catch(() => false);
    let why: string | undefined;
    if (!clean) why = "the member changed its worktree (read-only violated); its judgment is not counted";
    else if (ending.hook_event_name !== "Stop" || card.interrupted) why = "its turn was interrupted before a judgment";
    else {
      const p = parseJudgment(reply, this.readPackage(round), mr.key);
      if ("error" in p) why = `no valid judgment: ${p.error}`; else { mr.judgment = p.judgment; mr.state = "returned"; mr.reason = undefined; }
    }
    if (why) Object.assign(mr, { state: "invalid", reason: why });
    this.governedEvent(root, card.id, "council", `council ${round.checkpoint} round ${round.n}: ${mr.key} ${mr.state}${mr.judgment ? ` (${mr.judgment.verdict}, ${mr.judgment.findings.length} finding${mr.judgment.findings.length === 1 ? "" : "s"}${mr.judgment.score !== null ? `, score ${mr.judgment.score}` : ", no score"})` : `: ${why}`}`);
    if (mr.state === "returned") this.update(card, { status: "done" });
    this.settleRound(root, round);
    this.save();
  }
  /** Phase 5, every owner tick: held members that started now review; a finished turn not yet read is read; past the deadline a member is unavailable. */
  private reconcileCouncil(root: Task) {
    const run = root.governed!.council!, now = Date.now();
    for (const round of run.rounds) {
      if (round.outcome && !["reviewing"].includes(round.outcome.state)) continue;
      let changed = false;
      for (const mr of round.members) {
        const card = mr.card ? this.get(mr.card) : undefined;
        // From the round's start: a tick that came late (a reload, another window) must not miss a turn that already ended.
        if (mr.state === "queued" && card?.sessionId) { Object.assign(mr, { state: "reviewing", reason: undefined, attempts: mr.attempts + 1, at: round.at }); changed = true; }
        if (mr.state === "pending" && !this.convening.has(`${root.id}:${round.checkpoint}:${round.n}`)) { Object.assign(mr, { state: "unavailable", reason: "the board stopped before this member started (a reload or crash); retry is not possible, convene again" }); changed = true; }
        if (mr.state === "reviewing" && card) void this.councilResult(card).catch((e) => console.error("Entomatical: council result", e));
        const unread = !!card && this.events(card.id).some((e) => e.t >= Date.parse(mr.at ?? round.at) && e.t > (mr.ended ?? 0) && ["Stop", "StopFailure", "Interrupt"].includes(e.hook_event_name ?? ""));
        if ((mr.state === "reviewing" || mr.state === "queued") && !unread && now > Date.parse(round.deadline)) {
          if (card && this.live().includes(card.id)) this.stop(card);
          if (card?.held) this.update(card, { held: undefined, cancelled: true, status: "review" });
          Object.assign(mr, { state: "unavailable", reason: `no judgment within the saved ${run.snapshot.limits.minutes} minutes` });
          changed = true;
        }
        if (mr.state === "queued" && (!card || card.cancelled)) { Object.assign(mr, { state: "unavailable", reason: "its card was cancelled before it started" }); changed = true; }
      }
      if (changed) { this.settleRound(root, round); try { this.save(); } catch { /* the next tick */ } }
    }
  }
  /** Phase 5: the root's (or the user's) dispositions of the open round's material findings. Each finding keeps its original text and member. */
  councilReconcile(root: Task, checkpoint: string, raw: unknown, actor = "user"): Record<string, unknown> {
    this.mustOwn();
    const run = root.governed?.council, round = run?.rounds.filter((r) => r.checkpoint === checkpoint).at(-1);
    if (!run || !round) throw new Error(`No council round of ${checkpoint} to reconcile.`);
    if (actor !== "user" && actor !== root.id) throw new Error("Only the run's root or the user reconciles council findings.");
    if (round.decision) throw new Error(`the user already decided round ${round.n} of ${checkpoint} (waiver).`);
    if (round.outcome?.state !== "reconciliation") throw new Error(`Round ${round.n} of ${checkpoint} is ${round.outcome?.state ?? "reviewing"}, not awaiting reconciliation.`);
    const v = validDispositions(raw, run.snapshot, round, this.readPackage(round), actor);
    if ("error" in v) throw new Error(v.error);
    const again = v.dispositions.filter((d) => round.dispositions.some((x) => x.finding === d.finding));
    if (again.length) throw new Error(`Already disposed of: ${again.map((d) => d.finding).join(", ")}; a disposition is final for its round.`);
    round.dispositions.push(...v.dispositions);
    this.governedEvent(root, root.id, "council", `council ${checkpoint} round ${round.n}: ${v.dispositions.map((d) => `${d.finding} ${d.disposition}`).join(", ")} (by ${actor === "user" ? "the user" : actor})`);
    this.settleRound(root, round);
    this.save();
    return { ok: true, round: round.n, state: round.outcome!.state, reasons: round.outcome!.reasons, decisionRequired: isDecisionRequired(run, round.checkpoint) };
  }
  /** Phase 5: one more attempt for a member whose judgment was invalid or late, on the same package and card, within the saved attempts. */
  async councilRetry(root: Task, checkpoint: string, member: string, actor = "user"): Promise<Record<string, unknown>> {
    this.mustOwn();
    const run = root.governed?.council, round = run?.rounds.filter((r) => r.checkpoint === checkpoint).at(-1), mr = round?.members.find((m) => m.key === member);
    if (!run || !round || !mr) throw new Error(`No member ${member} in the last round of ${checkpoint}.`);
    if (actor !== "user" && actor !== root.id) throw new Error("Only the run's root or the user retries a council member.");
    if (round.decision) throw new Error(`the user already decided round ${round.n} of ${checkpoint} (waiver); a retry would change what he decided on.`);
    if (!["reviewing", "unable-to-assess"].includes(round.outcome?.state ?? "reviewing")) throw new Error(`Round ${round.n} is ${round.outcome?.state}; a retry would change a settled outcome.`);
    const card = mr.card ? this.get(mr.card) : undefined;
    if (mr.state !== "invalid" && !(mr.state === "unavailable" && card?.sessionId)) throw new Error(`${member} is ${mr.state}${mr.reason ? ` (${mr.reason})` : ""}; only an invalid or late member with a card is retried. No other member is substituted.`);
    if (mr.attempts >= run.snapshot.limits.attempts) throw new Error(`${member} has used its ${run.snapshot.limits.attempts} saved attempt${run.snapshot.limits.attempts === 1 ? "" : "s"} for this round.`);
    if (!card?.sessionId || !card.worktree) throw new Error(`${member}'s card is gone; nothing to retry.`);
    if (this.live().includes(card.id)) throw new Error(`${member} is still running.`);
    const head = await git(card.worktree, ["rev-parse", "HEAD"]).catch(() => "");
    if (head !== mr.head || !await isClean(card.worktree).catch(() => false)) throw new Error(`${member} changed its worktree; a read-only review cannot be retried on it.`);
    const wait = this.governedWait(card);
    if (wait) throw new Error(`${wait}. Nothing was changed; retry when a lease is free.`);
    if (this.fableBlocked(card)) throw new Error(`${member}'s saved model is blocked on its account now (Fable limit); no other model is substituted.`);
    const why = mr.reason ?? mr.state;
    Object.assign(mr, { state: "reviewing", reason: undefined, attempts: mr.attempts + 1, at: new Date(Math.max(Date.now(), (this.events(card.id).at(-1)?.t ?? 0) + 1)).toISOString() });
    round.deadline = new Date(Date.now() + run.snapshot.limits.minutes * 60_000).toISOString();
    this.update(card, { interrupted: undefined, status: "review" });
    this.settleRound(root, round); this.save();
    await this.followUpHeadless(card, `Your previous reply did not count (${why}). Review package ${round.package} again, read-only, and end with exactly one \`\`\`json judgment block as asked.`, false);
    return { ok: true, round: round.n, member, attempt: mr.attempts };
  }
  /** Phase 5: the user's decision after the round limit: accept as an exception (a waiver, bound to the last package; never a council pass). */
  councilWaive(root: Task, checkpoint: string, reason: string): Record<string, unknown> {
    this.mustOwn();
    const run = root.governed?.council;
    if (!run || !isDecisionRequired(run, checkpoint as Checkpoint)) throw new Error(`No decision is required for ${checkpoint}: a waiver is only for a round limit reached without a pass.`);
    if (!reason.trim()) throw new Error("A waiver needs the user's reason.");
    const round = run.rounds.filter((r) => r.checkpoint === checkpoint).at(-1)!;
    round.decision = { kind: "waiver", by: "user", reason: reason.trim().slice(0, 1000), at: new Date().toISOString() };
    this.governedEvent(root, root.id, "council", `council ${checkpoint}: the user waived after round ${round.n} (${round.outcome?.state}) as an exception, not a council pass: ${round.decision.reason}`);
    this.save();
    return { ok: true, round: round.n, decision: round.decision };
  }
  /** Phase 5, inside readiness: every saved checkpoint needs its last round passed (or waived) for a package still describing the run. */
  private async councilReasons(root: Task, r: Readiness, no: (code: string, text: string, ack?: string) => void) {
    const run = root.governed!.council!;
    for (const cp of run.snapshot.checkpoints) {
      const last = run.rounds.filter((x) => x.checkpoint === cp).at(-1), st = last?.outcome?.state ?? "reviewing";
      if (!last) { no("council-none", `Council checkpoint ${cp} has not reviewed this run (board.js council convene ${cp}); a configured council is required before the target.`); continue; }
      if (!last.decision && st !== "passed") {
        if (st === "reviewing" || st === "reconciliation") no("council-open", `Council ${cp} round ${last.n} is ${st}.`);
        else no(isDecisionRequired(run, cp) ? "council-decision" : st === "changes-required" ? "council-changes" : "council-unable", `Council ${cp} round ${last.n}: ${st}${last.outcome!.reasons.length ? ` (${last.outcome!.reasons.slice(0, 3).join("; ")})` : ""}${isDecisionRequired(run, cp) ? `; the round limit (${run.snapshot.limits.rounds}) is reached: the user's decision is required` : ""}.`);
        continue;
      }
      let pkg: ReviewPackage;
      try { pkg = this.readPackage(last); } catch { no("council-stale", `Council ${cp} round ${last.n}: its package file ${last.file} is missing; review again.`); continue; }
      if (pkg.id !== last.package || makePackage({ ...pkg, id: undefined } as unknown as PackageContent).id !== pkg.id) { no("council-stale", `Council ${cp} round ${last.n}: its package file was altered; review again.`); continue; }
      const now = await this.councilFacts(root, cp);
      const anc = pkg.candidate && now.candidate ? await isAncestor(this.repo, pkg.candidate.commit, now.candidate.commit) : false;
      const why = staleReason(pkg, now, run.snapshot, () => anc);
      if (why) { no("council-stale", `Council ${cp} ${last.decision ? "waiver" : "pass"} (round ${last.n}, package ${pkg.id.slice(0, 12)}) is stale: ${why}. Convene ${cp} again.`); continue; }
      r.notes.push(last.decision ? `council ${cp}: waived by the user after round ${last.n} as an exception (not a council pass): ${last.decision.reason}`
        : `council ${cp}: passed in round ${last.n} (package ${pkg.id.slice(0, 12)})${last.outcome!.degraded ? ", degraded (saved quorum; not every member assessed)" : ""}${last.outcome!.dissent.length ? `; dissent: ${last.outcome!.dissent.join(", ")}` : ""}${last.dispositions.filter((d) => d.disposition !== "confirmed").map((d) => `; ${d.finding} ${d.disposition}: ${(d.evidence ?? d.rationale ?? "").slice(0, 160)}`).join("")}${pkg.candidate && now.candidate && pkg.candidate.commit !== now.candidate.commit ? `; ${cp === "final" ? `same tree at ${now.candidate.commit.slice(0, 12)} (saved same-tree rule, checks passed there)` : `milestone ${pkg.candidate.commit.slice(0, 12)} is in the candidate`}` : ""}`);
    }
  }
  /** Phase 5: the council's state for the webview and overview (states only), or the full record for its root and the user (judgments, dispositions, usage). */
  councilView(root: Task, full: boolean): unknown {
    const run = root.governed?.council;
    if (!run) return undefined;
    const s = run.snapshot;
    return { council: `${s.name} (${s.id}@${s.revision})`, members: s.members.map((m) => `${m.key}: ${m.account} ${m.model} ${m.effort}`), rounds: s.limits.rounds, passing: s.passing, equivalence: s.equivalence,
      checkpoints: s.checkpoints.map((cp) => {
        const rounds = run.rounds.filter((r) => r.checkpoint === cp), last = rounds.at(-1);
        let state = !last ? "not convened" : last.decision ? "waived (exception)" : last.outcome?.state ?? "reviewing";
        // No badge outlives its package: a pass or waiver whose candidate or target moved reads stale here; Finish re-checks everything.
        if (last && (last.decision || state === "passed")) { const moved = this.councilMoved(root, last); if (moved) state = `stale (${moved})`; }
        return { checkpoint: cp, state, round: last?.n ?? 0, sincePass: roundsSincePass(run, cp).length, decisionRequired: isDecisionRequired(run, cp) && !last?.decision,
          ...(last ? { package: last.package.slice(0, 12), degraded: !!last.outcome?.degraded, members: last.members.map((m) => ({ key: m.key, state: m.state, card: m.card ?? null })) } : {}),
          ...(full ? { history: rounds.map((r) => ({ round: r.n, package: r.package, file: r.file, at: r.at, outcome: r.outcome, decision: r.decision ?? null, dispositions: r.dispositions,
            members: r.members.map((m) => { const card = m.card ? this.get(m.card) : undefined, pts = card ? this.fiveHourOf(card) : undefined;
              return { ...m, usage: card ? (pts === undefined ? "unknown (no measurable reading)" : `${pts} points of the 5-hour window`) : "none (never started)" }; }) })) } : {}) };
      }) };
  }
  /** Phase 5: a cheap synchronous look (for the card): has the candidate or the target moved since this round's package? */
  private councilMoved(root: Task, round: Round): string | undefined {
    try {
      const pkg = this.readPackage(round), rev = (cwd: string, what = "HEAD") => execFileSync("git", ["rev-parse", what], { cwd, encoding: "utf8", windowsHide: true }).trim();
      if (pkg.target && rev(this.repo) !== pkg.target.sha) return "the target moved";
      const rec = root.spec?.revisions.at(-1);
      if (JSON.stringify(pkg.spec) !== JSON.stringify(rec ? { revision: rec.revision, hash: sha(rec.record) } : { prompt: sha(root.prompt) })) return "the specification changed";
      if (round.checkpoint !== "plan" && JSON.stringify(pkg.checks?.commands ?? []) !== JSON.stringify(root.completion?.commands ?? [])) return "the check commands changed";
      if (round.checkpoint === "milestone" && pkg.candidate && root.worktree && fs.existsSync(root.worktree)) { try { execFileSync("git", ["merge-base", "--is-ancestor", pkg.candidate.commit, "HEAD"], { cwd: root.worktree, windowsHide: true }); } catch { return "the milestone is no longer in the candidate"; } }
      const sameTree = () => root.governed!.council!.snapshot.equivalence === "same-tree" && rev(root.worktree!, "HEAD^{tree}") === pkg.candidate!.tree;
      if (pkg.candidate && root.worktree && fs.existsSync(root.worktree) && round.checkpoint === "final" && rev(root.worktree) !== pkg.candidate.commit && !sameTree()) return "the candidate changed";
      return undefined;
    } catch { return "its package cannot be read"; }
  }
  /** Phase 5: board.js council from the root. */
  private async councilRequest(by: Task, req: Request): Promise<Record<string, unknown>> {
    try {
      switch (req.action) {
        case "convene": return await this.convene(by, req.checkpoint!, by.id);
        case "reconcile": return this.councilReconcile(by, req.checkpoint!, req.dispositions, by.id);
        case "retry": return await this.councilRetry(by, req.checkpoint!, req.member!, by.id);
        default: return { ok: true, council: this.councilView(by, true) };
      }
    } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  }

  // ---- Phase 4 (master plan sections 10 and 11): revision-bound readiness, integration and authorized target effects ----

  /** Phase 4: where a governed child integrates: the card that opened it (else its parent), whose branch is the run branch for it. */
  private destinationOf(t: Task): Task | undefined { return this.get(t.openedBy ?? t.parentId); }
  /** Phase 4: operations of this run still open (prepared, effect-observed, uncertain), except the one the caller is running. */
  private openOps(run: string, except?: string): Operation[] { return this.operations.list().filter((o) => (o.run === run || o.run === "?") && o.id !== except && OPEN_OPS.includes(o.state)); }
  /** Operations this window is carrying out now: reconciliation leaves them alone. */
  private readonly opsInFlight = new Set<string>();

  /**
   * Phase 4: the one readiness predicate for every application-controlled Git effect of a governed card, re-read from git each time.
   * integrate: a child's exact submitted head into its opener's branch. target: a governed root's clean HEAD onto the target branch, only
   * with the user's authorization (push only when he granted it too). Any other route is not an authorization. A legacy card is ready
   * unless it holds governed cards below it. `except`: the operation the caller just prepared (the recheck right before the effect).
   */
  async readiness(task: Task, action: EffectAction, auth?: Authorization, actor = "user", except?: string): Promise<Readiness> {
    const reasons: Reason[] = [], notes: string[] = [], gov = governedRootOf(task, this.tasks);
    const r: Readiness = { action, card: task.id, run: gov?.id, ok: false, reasons, notes, checked: new Date().toISOString() };
    const no = (code: string, text: string, ack?: string) => { reasons.push({ code, text, ...(ack ? { ack } : {}) }); };
    if (this.get(task.id) !== task) { no("card", `Card ${task.id} was removed or reloaded. Reopen it before continuing.`); return r; }
    const label = { integrate: "Merge", target: "Finish", deliver: "Periodic delivery", merge: "Merge", "self-finish": "Self-finish", "finish-self": "finish self", "plan-merge": "A plan merge", "plan-archive": "Plan archival" }[action];
    if (!gov) { const why = targetEffectRefusal(task, this.tasks, label); if (why) no("governed-below", why); r.ok = !reasons.length; return r; }
    const root = gov.root;
    if (!root) { no("root-gone", `Governed run ${gov.id} has no root on the board any more; its cards stay blocked until the user repairs or cancels them.`); return r; }
    if (action !== "integrate" && action !== "target") { no("route", targetEffectRefusal(task, this.tasks, label)!); return r; }
    if (!this.isOwner()) no("owner", NOT_OWNER);
    const dest = action === "integrate" ? this.destinationOf(task) : undefined;
    for (const o of this.openOps(gov.id, except)) if (action === "target" || o.run === "?" || o.card === task.id || o.card === dest?.id || o.pre.into === dest?.id)
      no("operation", this.operationReason(o),
        o.state === "uncertain" ? `op:${o.id}` : undefined);
    if (action === "integrate") await this.integrateFacts(task, root, dest, actor, r, no);
    else await this.targetFacts(task, root, auth, r, no, actor === "user" && !auth);
    r.ok = readyWith(reasons, auth?.acks);
    return r;
  }

  private async integrateFacts(task: Task, root: Task, dest: Task | undefined, actor: string, r: Readiness, no: (code: string, text: string, ack?: string) => void) {
    if (task.planStep) {
      const receipt = task.workflow?.receipt && this.workflow.receipt(task.workflow.receipt);
      const why = !receipt || task.workflow?.outcome !== "accepted" ? "Record an accepted result with commit and artifact evidence before integration." : this.planEvidenceProblem(task, receipt);
      if (why) no("plan-evidence", why);
      const drift = this.planLaunchProblem(task);
      if (drift) no("plan-drift", drift);
    }
    if (task.governed) { no("root", `${task.id} is the run's root: Finish (by the user) takes a governed run to the target; it is not integrated anywhere.`); return; }
    if (!dest || governedRootOf(dest, this.tasks)?.id !== root.id) { no("destination", `${task.id} has no opener in governed run ${root.id} to integrate into.`); return; }
    if (actor !== "user" && actor !== dest.id) no("actor", `Only ${dest.id} (the card that opened ${task.id}) or the user integrates it.`);
    // A child accepted with board.js done but never integrated can still be integrated; one already integrated, cancelled or discarded cannot.
    if (task.integrated || task.cancelled || task.discarded) { no("state", `${task.id} is ${task.cancelled ? "cancelled" : task.discarded ? "discarded" : `integrated already (${task.integrated!.op})`}.`); return; }
    // A coordinator is accepted only with its own children's work integrated into its branch (master plan section 10).
    for (const c of this.tasks.filter((x) => x.openedBy === task.id && !x.cancelled && !x.discarded && !x.integrated))
      no("children-open", `${task.id} opened ${c.id} (${c.title}), which is neither integrated into ${task.branch ?? "its branch"} nor cancelled.`);
    if (this.live().includes(task.id) || this.isLaunching(task)) no("live", `${task.id}'s session is still running; stop it first (its worktree is removed once its work is integrated).`);
    if (!dest.worktree || !dest.branch || !fs.existsSync(dest.worktree) || !checkedOut(dest.worktree)) { no("destination", `${dest.id} has no worktree to integrate into.`); return; }
    const head = await git(dest.worktree, ["rev-parse", "HEAD"]).catch(() => "");
    const branch = await git(dest.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
    r.destination = { card: dest.id, branch, head };
    if (branch !== dest.branch) no("destination", `${dest.id}'s worktree is on ${branch}; expected ${dest.branch}.`);
    if (await git(dest.worktree, ["status", "--porcelain", "--untracked-files=no"]).catch(() => "unreadable")) no("destination-dirty", `${dest.id}'s worktree has uncommitted changes to tracked files; it commits them first (a dirty tree is never integrated into).`);
    if (await mergeInProgress(dest.worktree)) no("destination-merge", `A merge is already in progress in ${dest.worktree}; finish or abort it first.`);
    if (actor === "user" && dest.status === "running" && this.live().includes(dest.id)) no("destination-busy", `${dest.id} is working in its worktree now; integrate when its turn ends, or let it run board.js integrate ${task.id} itself.`);
    for (const id of task.dependsOn ?? []) { const d = this.get(id); if (!d || d.status !== "done" || d.cancelled || d.discarded) no("dependency", `Dependency ${id}${d ? ` (${d.title})` : ""} is ${!d ? "missing" : d.cancelled ? "cancelled" : d.discarded ? "discarded" : "not completed"}; a governed card is integrated only after what it depends on.`); }
    const stale = await this.submissionStale(task);
    if (stale) { no("submission", stale); return; }
    const sub = task.submission!;
    r.candidate = sub.head;
    if (head && !(await isAncestor(dest.worktree, sub.base, head))) no("base", `The submitted base ${sub.base.slice(0, 12)} is no longer in ${dest.branch} (its history was rewritten); ${task.id} must bring its work onto ${dest.branch} and submit again.`);
    if (task.completion?.commands.length) {
      const c = task.checks;
      if (!c || c.status !== "complete") no("checks", `${task.id}'s acceptance checks have ${!c ? "not run" : c.status === "running" ? "not finished" : "failed"}.`);
      else if (c.revision !== sub.head) no("checks-stale", `${task.id}'s checks passed at ${c.revision?.slice(0, 12) ?? "an unknown revision"}, not at the submitted ${sub.head.slice(0, 12)}; run them again.`);
      else if (c.clean !== true) no("checks-dirty", `${task.id}'s checks ran with uncommitted changes in its worktree, or HEAD moved while they ran; run them again on the clean submitted commit.`);
    }
    // Declared and actual overlap: a coordination signal recorded with the integration, not proof of a conflict (git decides that).
    const actual = (await git(dest.worktree, ["diff", "--name-only", `${sub.base}..${sub.head}`]).catch(() => "")).split("\n").filter(Boolean);
    const owns = task.assignment?.owns ?? [];
    const outside = owns.length ? actual.filter((f) => !owns.some((o) => pathsMeet(o, f))) : [];
    if (task.planStep) {
      // Include intermediate commits, including changes later reverted and both sides of renames.
      const history = (await git(dest.worktree, ["log", "-m", "--format=", "--name-only", "--no-renames", `${sub.base}..${sub.head}`])).split("\n").filter(Boolean);
      const escaped = history.filter((f) => !task.planStep!.contract.writes.some((w) => withinPlanPath(f, w)));
      if (escaped.length) no("plan-scope", `The step changed paths outside its allowed writes: ${[...new Set(escaped)].join(", ")}.`);
    }
    if (outside.length) r.notes.push(`changed outside its declared ownership (${owns.join(", ")}): ${outside.slice(0, 10).join(", ")}`);
    for (const o of overlaps([{ ...task, submission: { ...sub, files: actual } }, ...this.governedMembers(root).filter((m) => m.id !== task.id && m.id !== dest.id)]).filter((x) => x.a === task.id || x.b === task.id))
      r.notes.push(`overlaps ${o.a === task.id ? o.b : o.a} (open) on ${o.paths.join(", ")}`);
  }

  private async targetFacts(task: Task, root: Task, auth: Authorization | undefined, r: Readiness, no: (code: string, text: string, ack?: string) => void, previewPush: boolean) {
    if (root.planRun?.approval) for (const member of this.governedMembers(root).filter((t) => t.planStep)) {
      const receipt = member.workflow?.receipt && this.workflow.receipt(member.workflow.receipt);
      const why = !receipt || member.workflow?.outcome !== "accepted" ? "has no accepted result" : this.planEvidenceProblem(member, receipt);
      if (why) no("plan-result", `${member.id}: ${why}. Deferred, blocked and not-applicable are not acceptance.`);
    }
    if (!task.governed) { no("not-root", `${task.id} belongs to governed run ${root.id}: its work reaches the target only through the run. Merge (or its opener's board.js integrate) puts it on ${this.destinationOf(task)?.branch ?? "its opener's branch"}; the user's Finish on ${root.id} takes the run to the target.`); return; }
    if (auth?.by !== "user" || auth.merge !== true) no("authorization", `Not an explicit authorization: governed run ${root.id} reaches the target only through the user's own Finish on its root.`);
    if (!task.worktree || !task.branch || !fs.existsSync(task.worktree) || !checkedOut(task.worktree)) { no("worktree", `${task.id} has no worktree; there is no candidate.`); return; }
    const wt = task.worktree, candidate = await git(wt, ["rev-parse", "HEAD"]).catch(() => "");
    r.candidate = candidate;
    if (await git(wt, ["status", "--porcelain", "--untracked-files=all"]).catch(() => "unreadable")) no("dirty", `${task.id}'s worktree has uncommitted or untracked files; commit them (and run the checks again): a dirty tree is never a candidate.`);
    if (await mergeInProgress(wt)) no("merge-in-progress", `A merge is in progress in ${wt}.`);
    if (this.live().includes(task.id) || this.isLaunching(task)) no("live", `The root's session is still open; stop it (or close its tab) first. A governed Finish does not close sessions for you.`);
    // M-02: stopped, but its process has not gone yet. Nothing is pushed or merged beside it.
    else { const ending = await this.closingLeft(task); if (ending.length) no("live", `The root's session was stopped and has not ended yet (${ending.map((p) => p.what).join(", ")}); the run reaches the target once it has.`); }
    for (const b of this.busyWith(task)) no("busy", `${task.id}: ${b}.`);
    // Every member is integrated (its exact submitted head is in the candidate) or cancelled; nothing open, nothing accepted without a handoff.
    for (const m of this.governedMembers(root)) {
      if (m.id === root.id || m.cancelled || m.discarded || m.council) continue; // a council member reviews; it delivers nothing
      if (m.status !== "done") no("member-open", `${m.id} (${m.title}) is ${m.status}: every member must be integrated or cancelled first.`);
      else if (!m.submission) no("member-unsubmitted", `${m.id} (${m.title}) is Done without a validated submission; cancel it or have it submit and be integrated.`);
      else if (candidate && !(await isAncestor(wt, m.submission.head, candidate))) no("member-not-integrated", `${m.id}'s submitted ${m.submission.head.slice(0, 12)} is not in the candidate ${candidate.slice(0, 12)}.`);
      // In the candidate, but merged by a shell's git rather than integrate: its checks, dependencies and base were never verified by the board.
      else if (candidate && !(m.integrated && await isAncestor(wt, m.integrated.after, candidate))) no("unreceipted", `${m.id}'s submitted ${m.submission.head} is in the candidate without an integration receipt (merged outside board.js integrate or Merge); the board never checked its checks, dependencies or base. Check it, then acknowledge.`, `unreceipted:${m.id}`);
    }
    // Combined validation: the root's own checks, passed at exactly this candidate.
    const c = task.checks;
    if (!task.completion?.commands.length) no("checks-none", `Combined validation is required: ${task.id} has no acceptance checks (Done when). Add them, run them on the integrated run branch, then Finish.`);
    else if (!c || c.status !== "complete") no("checks", `${task.id}'s combined checks have ${!c ? "not run" : c.status === "running" ? "not finished" : "failed"}.`);
    else if (c.revision !== candidate) no("checks-stale", `${task.id}'s checks passed at ${c.revision?.slice(0, 12) ?? "an unknown revision"}, not at the candidate ${candidate.slice(0, 12)}: integration, a conflict resolution or a new commit moved it. Run them again.`);
    else if (c.clean !== true) no("checks-dirty", `${task.id}'s checks ran with uncommitted changes in its worktree, or HEAD moved while they ran; run them again on the clean candidate.`);
    const dr = task.doneReview;
    if (dr && dr.verdict !== "done") {
      const snap = await worktreeSnapshot(wt).catch(() => "");
      if (dr.snapshot && dr.snapshot === snap) no("findings", `The latest Done review of this candidate (${dr.file}) is "${dr.verdict}": its findings are unresolved.`);
      else r.notes.push(`an earlier Done review (${dr.verdict}) read another state; it does not cover this candidate`);
    }
    // The target, read now: on a branch, clean, no merge under way, and already contained in the candidate (so the effect is a fast-forward).
    const ref = await git(this.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD");
    if (ref === "HEAD") { no("target", "The main checkout is not on a branch, so there is no target."); return; }
    const sha = await git(this.repo, ["rev-parse", "HEAD"]);
    r.target = { ref, sha };
    if (await git(this.repo, ["status", "--porcelain", "--untracked-files=no"]).catch(() => "unreadable")) no("target-dirty", `${ref} in the main checkout has uncommitted changes to tracked files; commit or stash them first.`);
    if (await mergeInProgress(this.repo)) no("target-merge", `A merge is in progress in the main checkout.`);
    if (candidate && !(await isAncestor(this.repo, sha, candidate))) no("target-moved", `${ref} is at ${sha.slice(0, 12)}, which the candidate does not contain: merge ${ref} into ${task.branch}, run the checks again, then Finish (a resolved conflict is a new candidate too).`);
    // FR2: with a vault set for the repo, the vault is the destination. The branch's upstream is not read, fetched or pushed; the
    // upload is its own choice in the user's Finish, as push is.
    let vault: VaultDestination | undefined;
    try { vault = this.vaultDestination(); } catch (e) { no("vault", e instanceof Error ? e.message : String(e)); }
    if (!vault && auth?.upload) no("upload-no-vault", "This repo has no vault set (entomatical.finish.vaults), so there is nothing to upload to.");
    const remote = vault ? "" : await git(this.repo, ["config", "--get", `branch.${ref}.remote`]).catch(() => ""), merge = vault ? "" : await git(this.repo, ["config", "--get", `branch.${ref}.merge`]).catch(() => "");
    if (vault) {
      r.target.vault = { id: vault.id, name: vault.name, display: vault.display };
      if (auth?.push) no("push-vault", `${ref} is not pushed: this repo's Finish destination is ${vault.name}. Choose the merge, or the merge and the upload.`);
      else if (!auth?.upload) r.notes.push(`${vault.name} is not uploaded to: the upload is a separate choice in the user's Finish`);
    } else if (remote && merge) {
      const rb = merge.replace(/^refs\/heads\//, "");
      r.target.remote = `${remote}/${rb}`;
      r.target.remoteName = remote;
      r.target.remoteRef = rb;
      if (auth?.push || previewPush) {
        try {
          const endpoint = await this.pushEndpoint(remote);
          r.target.pushIdentity = endpoint.identity;
          r.target.remoteSha = await remoteSha(this.repo, endpoint.url, rb);
          if (auth?.push && r.target.remoteSha) {
            await git(this.repo, ["fetch", "-q", endpoint.url, rb]);
            if (candidate && !(await isAncestor(this.repo, r.target.remoteSha, candidate))) no("remote-moved", `${remote}/${rb} is at ${r.target.remoteSha.slice(0, 12)}, which the candidate does not contain: merge it into ${task.branch}, run the checks again, then Finish.`);
          }
        } catch {
          const why = `${remote}/${rb} needs one readable push destination to confirm its revision.`;
          if (auth?.push) no("remote", why); else r.notes.push(why);
        }
      }
      if (!auth?.push) r.notes.push(`${remote}/${rb} is not pushed: push is a separate choice in the user's Finish`);
    } else if (auth?.push) no("push-no-remote", `${ref} has no upstream remote to push to.`);
    // External drift: work of this run already on the target, put there by something other than this Finish (a shell's git).
    const baseline = root.governed!.target?.sha;
    const heads: { card: string; sha: string }[] = [];
    for (const m of this.governedMembers(root)) {
      if (m.submission) heads.push({ card: m.id, sha: m.submission.head });
      if (m.integrated) heads.push({ card: m.id, sha: m.integrated.after });
      if (baseline && m.branch) { const tip = await git(this.repo, ["rev-parse", "--verify", "-q", `refs/heads/${m.branch}`]).catch(() => ""); if (tip && !(await isAncestor(this.repo, tip, baseline))) heads.push({ card: m.id, sha: tip }); }
    }
    const drifted = new Set<string>();
    for (const h of heads) {
      const revision = `${h.card} at ${h.sha}`;
      if (!drifted.has(revision) && await isAncestor(this.repo, h.sha, sha)) drifted.add(revision);
    }
    if (root.governed!.council) await this.councilReasons(root, r, no);
    if (drifted.size) no("drift", `Work of ${[...drifted].sort().join(", ")} is already on ${ref} (${sha}), put there outside this run's Finish (a shell's git); the board cannot undo it. Check ${ref}, then acknowledge to continue.`, "drift");
    if (!baseline) r.notes.push("no target baseline was recorded for this run (governed before phase 4): unsubmitted branch drift is not checked");
  }

  /**
   * Phase 4: a governed child's exact submitted head into its opener's branch (the run branch), after readiness, with a durable operation
   * record around the merge. A conflict changes nothing in the checkout: the child keeps its worktree and submission, and the opener
   * is told which files. Integration moves the opener's HEAD, so its own checks and submission are stale afterwards (they are bound to revisions).
   */
  async integrate(task: Task, actor = "user", confirmed?: EffectConfirmation): Promise<Record<string, unknown>> {
    this.mustOwn();
    const first = await this.readiness(task, "integrate", undefined, actor);
    const expected = confirmed ?? confirmationFor(first);
    const acks = confirmed?.acknowledged.map(x => x.ack!) ?? [];
    const stale = confirmationProblem(first, expected);
    if (stale) throw new Error(stale);
    if (!readyWith(first.reasons, acks)) throw new Error(readinessText(first));
    const dest = this.get(first.destination!.card), sub = task.submission;
    if (!dest?.worktree || dest !== this.destinationOf(task) || !sub || sub.head !== first.candidate) throw new Error("The integration confirmation has expired. Review the submission and destination again.");
    const worktree = dest.worktree;
    const op = this.operations.open({ kind: "integrate", card: task.id, run: first.run!, actor, owner: this.instance, pre: { head: sub.head, base: sub.base, into: dest.id, branch: dest.branch, before: first.destination!.head, guardedRef: true } });
    this.opsInFlight.add(op.id);
    try {
      const again = await this.readiness(task, "integrate", undefined, actor, op.id);
      const stale = confirmationProblem(again, expected);
      if (stale || !readyWith(again.reasons, acks) || task.submission?.head !== sub.head || this.destinationOf(task) !== dest || dest.worktree !== worktree) {
        this.operations.set(op, { state: "abandoned", result: { reason: "changed between the check and the merge" } });
        throw new Error(stale ?? (!readyWith(again.reasons, acks) ? readinessText(again) : "The integration confirmation has expired. Review the submission and destination again."));
      }
      this.mustOwnActive();
      const m = await this.integrationMerge(worktree, first.candidate!, `Integrate ${task.id} (${task.title.slice(0, 60)}): ${sub.head.slice(0, 12)}`, first.destination!,
        this.repo, after => { this.operations.set(op, { pre: { ...op.pre, after } }); });
      this.settleAcked(again, acks);
      if ("conflict" in m) {
        const now = await git(dest.worktree!, ["rev-parse", "HEAD"]).catch(() => "");
        this.operations.set(op, { state: now === first.destination!.head ? "committed" : "uncertain", result: { outcome: "conflict", files: m.conflict, after: now } });
        this.update(task, { conflict: { files: m.conflict, into: dest.id, at: new Date().toISOString(), op: op.id } });
        const text = `Integrating ${task.id} (${task.title}) into ${dest.branch} conflicts in ${m.conflict.join(", ")}. Nothing changed: ${dest.branch} is as it was, and ${task.id} keeps its worktree and submitted ${sub.head.slice(0, 12)}. Resolve it by serializing the work (the child brings ${dest.branch} into its branch and submits again) or by naming one integration owner; then integrate again.`;
        this.governedEvent(this.get(first.run!)!, task.id, "conflict", text); this.save();
        if (actor !== dest.id) { this.queueNotice(dest.id, `conflict:${task.id}`, text); this.deliverNotices(dest.id); }
        return { error: text, conflict: m.conflict, op: op.id };
      }
      if (await git(this.repo, ["rev-parse", `refs/heads/${op.pre.branch}`]).catch(() => "") !== m.after || !(await isAncestor(worktree, sub.head, m.after))) { this.operations.set(op, { state: "uncertain", result: { after: m.after, reason: "the merge reported success but the confirmed branch no longer matches its result" } }); throw new Error(`Integration of ${task.id} is uncertain; see ${op.id}.`); }
      this.operations.set(op, { state: "effect-observed", result: { after: m.after } });
      return await this.afterIntegration(task, op, first.notes);
    } catch (e) {
      if (e instanceof ExpiredConfirmation) this.operations.set(op, { state: "abandoned", result: { reason: e.message } });
      if (e instanceof CheckoutRecoveryRequired) this.operations.set(op, { state: "uncertain", result: { reason: e.message } });
      throw e;
    } finally { this.opsInFlight.delete(op.id); }
  }
  /** The git merge of an integration; a seam for crash tests (they replace it to stop between the effect and the record). */
  integrationMerge = mergeExact;
  /** Phase 4: the bookkeeping of an integration whose merge was observed (now, or by reconciliation after a crash), then its cleanup. */
  private async afterIntegration(task: Task, op: Operation, notes: string[] = []): Promise<Record<string, unknown>> {
    const dest = this.get(String(op.pre.into)), root = this.get(op.run), after = String(op.result?.after ?? "");
    if (!task.integrated || task.integrated.op !== op.id) {
      this.update(task, { integrated: { into: String(op.pre.into), branch: String(op.pre.branch), before: String(op.pre.before), after, head: String(op.pre.head), base: String(op.pre.base), op: op.id, by: op.actor, at: new Date().toISOString() },
        conflict: undefined, merged: true, status: "done" });
      if (root?.governed) this.governedEvent(root, task.id, "integrated", `${task.id} ${String(op.pre.head).slice(0, 12)} into ${op.pre.branch} (now ${after.slice(0, 12)}) by ${op.actor}${notes.length ? `; ${notes.join("; ")}` : ""}`);
      try { fs.appendFileSync(this.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: "Integration", op: op.id, head: op.pre.head, into: op.pre.branch, after }) + "\n"); } catch { /* no events folder yet */ }
      this.save();
      if (dest && op.actor !== dest.id) { this.queueNotice(dest.id, `integrated:${task.id}`, `the user integrated ${task.id} (${task.title}) into your branch ${op.pre.branch}: HEAD is now ${after.slice(0, 12)}. Checks and any submission of yours from before are stale; run them again.`); this.deliverNotices(dest.id); }
    }
    this.operations.set(op, { state: "committed" });
    const cleanup = await this.cleanupMember(task);
    this.operations.set(op, { cleanup: cleanup ? "pending" : "done", ...(cleanup ? { result: { ...op.result, cleanup } } : {}) });
    return { ok: true, id: task.id, into: op.pre.branch, head: op.pre.head, after, op: op.id, ...(notes.length ? { notes } : {}), ...(cleanup ? { cleanupPending: cleanup } : {}) };
  }
  /** Removes an integrated card's worktree and branch. A failure is recorded as cleanup pending, never as a failed integration. */
  private async cleanupMember(task: Task): Promise<string | undefined> {
    if (!task.worktree || !task.branch) return undefined;
    try {
      await discardWorktree(this.repo, task.worktree, task.branch, !!task.legacySpeechId);
      this.dropCardTemp(task);
      this.update(task, { transcript: this.transcriptOf(task), ...ranIn(task), worktree: undefined, branch: undefined, cleanupPending: undefined });
      return undefined;
    } catch (e) { this.update(task, { cleanupPending: true }); return `its worktree ${task.worktree} was not removed (${e instanceof Error ? e.message : String(e)}); Discard removes it.`; }
  }
  private operationReason(o: Operation) {
    return `Operation ${o.id} (${o.kind} of ${o.card}) is ${o.state}${o.state === "uncertain" ? `: the board cannot tell whether it took effect (${String(o.result?.reason ?? "see the record")}); check ${o.pre.branch ?? o.pre.ref ?? "the refs"} yourself` : ": the board finishes reconciling it first"}. Record: ${path.join(this.dir, "operations", `${o.id}.json`)}`;
  }
  /** the user acknowledged these uncertain operations: they stop blocking; readiness is still recomputed from git, never from the record. */
  private settleAcked(r: Readiness, acks: string[]) {
    for (const a of acks.filter((x) => x.startsWith("op:"))) {
      const op = this.operations.get(a.slice(3));
      if (op?.state === "uncertain" && r.reasons.some((x) => x.ack === a && x.text === this.operationReason(op))) this.operations.set(op, { state: "abandoned", settled: { by: "user", at: new Date().toISOString() } });
    }
  }

  /**
   * Phase 4: Finish of a governed root. Only with the user's authorization (helpers.authorize, the Finish dialog); automatic callers have none and
   * are refused with the readiness reasons. The exact candidate is fast-forwarded onto the target (pushed first when he granted push), after
   * a recheck right before the effect, inside a durable operation record. No commit, conflict resolver or merge commit is made here: a candidate
   * that needs one is not ready. A committed effect whose cleanup failed only retries the cleanup.
   */
  private async finishGoverned(task: Task, helpers: FinishHelpers, step: (text: string) => void): Promise<false | string[]> {
    const pending = this.operations.list().find((o) => o.kind === "target" && o.card === task.id && o.state === "committed" && o.cleanup !== "done");
    // FR2: the cleanup-only Finish showed no destination, so it uploads nothing; what the vault lacks is said, and Upload to Vault uploads.
    if (pending) { step("Deleting the worktree"); const left = await this.cleanupRoot(task, pending); if (left) throw new CleanupBlocked(left); return [`Its work was already on ${pending.pre.push ? pending.pre.remote : pending.pre.ref} (${String(pending.pre.candidate).slice(0, 12)}); only the cleanup was left.`, ...(task.vault && task.vault.state !== "uploaded" ? [vaultStatus(task.vault)] : [])]; }
    step("Checking readiness");
    const first = await this.readiness(task, "target");
    const auth = helpers.authorize ? await helpers.authorize(first) : undefined;
    if (auth === false) return false;
    if (!auth) throw new Error(readinessText(first));
    const r = await this.readiness(task, "target", auth);
    const stale = confirmationProblem(r, auth.confirmed, auth.push);
    if (stale) throw new Error(stale);
    if (!r.ok) throw new Error(readinessText(r));
    const t = r.target!, remote = t.remoteName!, rb = t.remoteRef!, push = auth.push, candidateWorktree = task.worktree!;
    // FR2: the vault that was shown, and whether the user chose the upload too; both are in the operation's record before the effect.
    const vault = t.vault, upload = !!auth.upload && !!vault;
    const op = this.operations.open({ kind: "target", card: task.id, run: task.id, actor: "user", owner: this.instance, authorization: auth,
      pre: { candidate: r.candidate, ref: t.ref, targetBefore: t.sha, remote: t.remote, remoteName: remote, remoteRef: rb, pushIdentity: t.pushIdentity, remoteBefore: t.remoteSha ?? undefined, push, guardedRef: true,
        ...(vault ? { vault: vault.id, vaultName: vault.name, vaultRuns: vault.display, upload } : {}) } });
    this.opsInFlight.add(op.id);
    try {
      step("Checking readiness again");
      const endpoint = push ? await this.pushEndpoint(remote).catch(() => undefined) : undefined;
      const again = await this.readiness(task, "target", auth, "user", op.id);
      const stale = confirmationProblem(again, auth.confirmed, push) ?? (push && endpoint?.identity !== t.pushIdentity
        ? `The push confirmation has expired. Review ${t.remote} in Finish again.` : undefined);
      // FR2: the vault that was shown is the one this Finish may record and upload to.
      if (stale || !again.ok || again.target?.vault?.id !== vault?.id) {
        this.operations.set(op, { state: "abandoned", result: { reason: "changed between the check and the effect" } });
        throw new Error(stale ?? readinessText(again));
      }
      this.mustOwnActive();
      const cand = r.candidate!;
      step(`Locking ${t.ref} for Finish`);
      try {
        await updateConfirmedCheckout(this.repo, candidateWorktree, { branch: t.ref, head: t.sha }, cand, async () => {
          this.mustOwnActive();
          if (push) {
            step(`Pushing ${cand.slice(0, 12)} to ${t.remote}`);
            await this.pushGoverned(op, endpoint!.url, rb, cand, t.remoteSha);
          }
          step(`Updating ${t.ref}`);
          this.mustOwnActive();
          this.operations.set(op, { pre: { ...op.pre, localStarted: true } });
        });
      } catch (e) {
        if (op.state !== "prepared") throw e; // the push recorded its own refusal or uncertain outcome
        const reason = (e as Error).message;
        if (op.pre.localStarted || op.result?.remote === cand) {
          this.operations.set(op, { state: "uncertain", result: { ...op.result, reason } });
          throw new Error(`${op.result?.remote === cand ? `Pushed ${cand} to ${t.remote}. ` : ""}Local checkout needs inspection (operation ${op.id}). ${reason}`);
        }
        this.operations.set(op, { state: "abandoned", result: { reason } });
        throw e;
      }
      const localNow = await git(this.repo, ["rev-parse", `refs/heads/${t.ref}`]).catch(() => "");
      if (localNow !== cand) {
        const reason = `${t.ref} moved again after the local update (operation ${op.id}). Inspect the checkout before continuing.`;
        this.operations.set(op, { state: "uncertain", result: { ...op.result, local: localNow, reason } });
        throw new Error(reason);
      }
      this.settleAcked(again, auth.acks ?? []);
      this.operations.set(op, { state: "effect-observed", result: { ...op.result, local: localNow, localUpdated: true } });
      const notes = await this.afterTarget(task, op);
      // FR2: after the bookkeeping and the cleanup. The helper runs only when the user chose the upload; else the card says pending.
      if (vault) notes.push(...await this.vaultAfterFinish(task, upload, step));
      return notes;
    } finally { this.opsInFlight.delete(op.id); }
  }
  private async pushGoverned(op: Operation, url: string, branch: string, cand: string, before: string | null | undefined) {
    try { await this.pushStep(this.repo, url, branch, cand, before); }
    catch (e) {
      if (e instanceof ExpiredConfirmation) {
        this.operations.set(op, { state: "abandoned", result: { reason: e.message } });
        throw e;
      }
      const now = await this.recordedRemoteSha(op).catch(() => undefined);
      if (now !== undefined && (now !== cand || /^!\t/m.test((e as Error).message))) {
        const reason = now !== before ? `The push confirmation has expired. ${op.pre.remote} is now at ${now ?? "no branch"}. Review it in Finish again.` :
          `${op.pre.remote} refused the push: ${(e as Error).message.split("\n")[0]}. Nothing was changed.`;
        this.operations.set(op, { state: "abandoned", result: { reason } });
        throw new Error(reason);
      } else {
        this.operations.set(op, { state: "uncertain", result: { reason: `push failed and ${op.pre.remote} could not be confirmed (${now ?? "unreadable"})` } });
        throw new Error(`The push to ${op.pre.remote} failed and its outcome is uncertain (operation ${op.id}). Nothing else was done; check ${op.pre.remote} before Finish again.`);
      }
    }
    this.operations.set(op, { result: { remote: cand } });
  }
  /** The conditional fast-forward of a governed Finish. */
  pushStep = pushConfirmed;
  private async pushEndpoint(remote: string) {
    const url = remote === "." ? "." : await git(this.repo, ["remote", "get-url", "--push", "--all", remote]);
    if (!url || /[\r\n]/.test(url)) throw new Error("A single push destination is required.");
    return { url, identity: crypto.createHash("sha256").update(url).digest("hex") };
  }
  private async recordedRemoteSha(op: Operation) {
    const [legacyRemote, ...branch] = String(op.pre.remote ?? "").split("/");
    if (!op.pre.pushIdentity) return remoteSha(this.repo, legacyRemote, branch.join("/"));
    const endpoint = await this.pushEndpoint(String(op.pre.remoteName));
    if (endpoint.identity !== op.pre.pushIdentity) throw new Error("The push destination changed.");
    return remoteSha(this.repo, endpoint.url, String(op.pre.remoteRef));
  }
  /** Phase 4: bookkeeping of an observed target effect (now, or after a crash), then the root's cleanup. */
  private async afterTarget(task: Task, op: Operation, limits?: WorktreeGate["limits"]): Promise<string[]> {
    if (!task.merged) {
      // FR2: the candidate, its branch, the vault and "pending" go on the card with the merge, here too after a crash (reconciliation,
      // which never uploads): the record is what a later Upload to Vault works on.
      const vault = op.pre.vault ? await this.vaultMerged(task, String(op.pre.ref), { id: String(op.pre.vault), name: String(op.pre.vaultName), display: String(op.pre.vaultRuns) }, String(op.pre.candidate)) : {};
      this.update(task, { merged: true, ...vault });
      const landed = op.pre.vault ? `on ${op.pre.ref} (merged here; the upload to ${op.pre.vaultName} was ${op.pre.upload ? "chosen" : "not chosen"})` :
        op.result?.localUpdated === false && op.pre.push ? `pushed to ${op.pre.remote}; local ${op.pre.ref} was not updated` :
        `on ${op.pre.ref}${op.pre.push ? ` and pushed to ${op.pre.remote}` : " (not pushed)"}`;
      if (task.governed) this.governedEvent(task, task.id, "target", `${String(op.pre.candidate).slice(0, 12)} ${landed} by the user's Finish (${op.id})`);
      try { fs.appendFileSync(this.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: "TargetMerge", op: op.id, candidate: op.pre.candidate, ref: op.pre.ref, localUpdated: op.result?.localUpdated, pushed: !!op.pre.push }) + "\n"); } catch { /* no events folder yet */ }
      this.save();
    }
    this.operations.set(op, { state: "committed" });
    const left = await this.cleanupRoot(task, op, limits);
    if (left) throw new CleanupBlocked(`Work is on ${op.pre.push ? op.pre.remote : op.pre.ref} at ${String(op.pre.candidate).slice(0, 12)}; ${left}`);
    return [];
  }
  /** limits: how long the removal waits for the root's own writers (releaseWriters); the board's releaseLimits when left out. */
  private async cleanupRoot(task: Task, op: Operation, limits?: WorktreeGate["limits"]): Promise<string | undefined> {
    try {
      // M-02: the candidate is the result. The root's worktree goes once its writers have closed and it holds nothing but the candidate.
      const candidate = String(op.pre.candidate ?? "");
      if (task.worktree && task.branch) await this.removeWorktree(task, { ...(limits ? { limits } : {}), ...(candidate ? { result: { sha: candidate, into: String(op.pre.ref) }, landed: (rev: string) => isAncestor(this.repo, rev, candidate) } : {}) });
      this.update(task, { status: "done", transcript: this.transcriptOf(task), ...ranIn(task), worktree: undefined, branch: undefined, merged: true, cleanupPending: undefined, cleanup: undefined });
      this.operations.set(op, { cleanup: "done" });
      return undefined;
    } catch (e) {
      this.update(task, { cleanupPending: true });
      this.operations.set(op, { cleanup: "pending", result: { ...op.result, cleanup: e instanceof Error ? e.message : String(e) } });
      // A CleanupBlocked says how to retry itself.
      return `only cleanup is left: ${e instanceof Error ? e.message : String(e)}${e instanceof CleanupBlocked ? "" : " Finish again retries only the cleanup."}`;
    }
  }

  private reconciling = false;
  /** The new target journal distinguishes a confirmed remote effect from the start of the guarded local checkout. */
  private async reconcileGuardedTarget(op: Operation) {
    const { ref, candidate, localStarted, push, remoteBefore } = op.pre;
    const local = await git(this.repo, ["rev-parse", "--verify", `refs/heads/${ref}`]).catch(() => "");
    const index = await git(this.repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const pushed = !!push && op.result?.remote === candidate;
    const result = { ...op.result, local };
    if (!fs.existsSync(index + ".lock")) {
      if (!localStarted) {
        if (pushed) { this.operations.set(op, { state: "effect-observed", result: { ...result, localUpdated: false, reason: "the push completed before the local checkout started" } }); return; }
        if (!push || await this.recordedRemoteSha(op).catch(() => undefined) === (remoteBefore ?? null)) {
          this.operations.set(op, { state: "abandoned", result: { ...result, reason: "the local checkout never started and no push took effect" } }); return;
        }
      } else if (local === candidate && (!push || pushed) &&
        await git(this.repo, ["symbolic-ref", "-q", "HEAD"]).catch(() => "") === `refs/heads/${ref}` &&
        !(await mergeInProgress(this.repo)) && !(await git(this.repo, ["status", "--porcelain", "--untracked-files=no"]))) {
        this.operations.set(op, { state: "effect-observed", result: { ...result, localUpdated: true } }); return;
      }
    }
    this.operations.set(op, { state: "uncertain", result: { ...result, reason: `inspect ${ref}, the checkout and index in ${this.repo} before recovery` } });
  }
  /**
   * Phase 4: after a crash or an owner change, settles operations left prepared or effect-observed by reading the refs, before anything is
   * replayed: unchanged refs → abandoned (nothing happened); the expected revision in place → effect-observed, then its bookkeeping;
   * anything else → uncertain (blocks the run's effects until the user acknowledges it). Never resets or reverts anything.
   */
  async reconcileOperations(): Promise<void> {
    if (this.reconciling || !this.isOwner()) return;
    this.reconciling = true;
    try {
      for (const op of this.operations.list()) {
        if (this.opsInFlight.has(op.id)) continue;
        const task = this.get(op.card);
        // A crash after committed but before cleanup: only the cleanup is left (the merge is never repeated). A conflict is committed too,
        // but nothing was integrated: the child keeps its worktree and branch.
        if (op.kind === "integrate" && op.state === "committed" && !op.cleanup && op.result?.outcome !== "conflict" && task) {
          const left = await this.cleanupMember(task).catch((e) => String(e));
          this.operations.set(op, { cleanup: left ? "pending" : "done" });
          continue;
        }
        if (op.state !== "prepared" && op.state !== "effect-observed") continue;
        // The previous owner may still be finishing it: its record is left alone until it has been quiet for 2 minutes.
        if (op.owner && op.owner !== this.instance && Date.now() - Date.parse(op.updated) < 120_000) continue;
        try {
          if (op.kind === "integrate") {
            if (op.state === "prepared") {
              const dest = this.get(String(op.pre.into)), wt = dest?.worktree;
              if (!wt || !fs.existsSync(wt)) { this.operations.set(op, { state: "uncertain", result: { reason: `destination ${op.pre.into} has no worktree to read` } }); continue; }
              const now = await git(this.repo, ["rev-parse", "--verify", `refs/heads/${op.pre.branch}`]).catch(() => "");
              const branch = await git(wt, ["symbolic-ref", "-q", "HEAD"]).catch(() => "");
              const index = await git(wt, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
              if (!now || branch !== `refs/heads/${op.pre.branch}` || fs.existsSync(index + ".lock") || await mergeInProgress(wt) ||
                (op.pre.guardedRef && await git(wt, ["status", "--porcelain", "--untracked-files=no"]))) {
                this.operations.set(op, { state: "uncertain", result: { reason: `inspect ${op.pre.branch}, the checkout and index in ${wt} before recovery` } });
              }
              else if (now === op.pre.before && !op.pre.after) this.operations.set(op, { state: "abandoned", settled: { by: "reconcile", at: new Date().toISOString() }, result: { reason: "the destination never moved: the merge did not happen" } });
              else if (op.pre.guardedRef ? now === op.pre.after && now !== op.pre.before : await isAncestor(wt, String(op.pre.head), now)) this.operations.set(op, { state: "effect-observed", result: { after: now } });
              else this.operations.set(op, { state: "uncertain", result: { reason: `the destination moved to an unexpected revision ${now}` } });
            }
            if (op.state === "effect-observed" && task) await this.afterIntegration(task, op);
          } else {
            if (op.state === "prepared" && op.pre.guardedRef) await this.reconcileGuardedTarget(op);
            else if (op.state === "prepared") {
              const local = await git(this.repo, ["rev-parse", `refs/heads/${op.pre.ref}`]).catch(() => "");
              const far = op.pre.push ? await this.recordedRemoteSha(op).catch(() => undefined) : undefined;
              if (local === op.pre.targetBefore && (!op.pre.push || far === (op.pre.remoteBefore ?? null))) this.operations.set(op, { state: "abandoned", settled: { by: "reconcile", at: new Date().toISOString() }, result: { reason: "the target never moved: nothing happened" } });
              else if ((local && await isAncestor(this.repo, String(op.pre.candidate), local)) || (op.pre.push && far === op.pre.candidate)) this.operations.set(op, { state: "effect-observed", result: { local, localUpdated: local === op.pre.candidate, ...(op.pre.push ? { remote: far } : {}) } });
              else this.operations.set(op, { state: "uncertain", result: { reason: `the target is at ${local.slice(0, 12)}${op.pre.push ? `, ${op.pre.remote} at ${String(far)}` : ""}, neither before nor the candidate` } });
            }
            // M-02: a short wait for the root's writers here, so a record left by a crash does not hold the others up for a minute; a
            // worktree that is kept waits for the user's Finish, which only cleans up.
            if (op.state === "effect-observed" && task) await this.afterTarget(task, op, { closeMs: 2000, pollMs: 250 }).catch((e) => { if (!(e instanceof CleanupBlocked)) throw e; });
          }
        } catch (e) { console.error("Entomatical: reconcile operation", op.id, e); }
      }
    } finally { this.reconciling = false; }
  }

  private publishGoverned() {
    for (const root of this.tasks.filter((t) => t.governed)) {
      const text = JSON.stringify(this.governedSnapshot(root));
      if (this.governedText.get(root.id) === text) continue;
      try { fs.mkdirSync(path.join(this.dir, "governed"), { recursive: true }); writeFileAtomic(path.join(this.dir, "governed", `${root.id}.json`), text); this.governedText.set(root.id, text); } catch (e) { console.error("Entomatical: governed snapshot", e); }
    }
  }

  /** Why gate() would refuse the task now, without claiming anything (a slot another window takes meanwhile is found only by gate). */
  private gateProblem(task: Task): string | undefined {
    const s = task.workflow;
    if (!s) return undefined;
    const ctx = this.workflowCtx();
    if (s.attempt && s.outcome === "pending") return validateAttempt(task, this.tasks, this.workflow, ctx);
    const r = readiness(task, this.tasks, this.workflow, ctx);
    return r.state === "ready" ? undefined : r.text;
  }

  /** Record result: records the owner's judgement of the step's attempt as a receipt and releases its claims (workflow.ts close). */
  closeStep(task: Task, outcome: RunReceipt["outcome"], limitations: string): RunReceipt {
    this.mustOwn(); // first: closeAttempt writes the receipt and releases the claims before save() could refuse
    if (!task.workflow?.attempt) throw new Error("This step has not run, so there is no result to close.");
    if (this.own().includes(task.id) || task.status === "running" || task.status === "needs-input") throw new Error("Stop the session before closing its result.");
    const checksPassed = !this.checks.owns(task) || task.checks?.status === "complete";
    let evidence: { revision: string; evidence: Record<string, string> } | undefined;
    if (task.planStep && outcome === "accepted") {
      const why = this.planLaunchProblem(task);
      if (why) throw new Error(why);
      if (!task.worktree || !task.submission) throw new Error("Submit the committed work before recording an accepted result.");
      const run = (args: string[]) => execFileSync("git", args, { cwd: task.worktree, encoding: "utf8", windowsHide: true }).trim();
      if (run(["status", "--porcelain", "--untracked-files=all"]) || run(["rev-parse", "HEAD"]) !== task.submission.head) throw new Error("The submission is stale or the worktree is dirty; commit and submit again.");
      if (task.completion?.commands.length && (task.checks?.status !== "complete" || task.checks.revision !== task.submission.head || task.checks.clean !== true)) throw new Error("Checks must pass on the clean submitted commit before acceptance.");
      const artifacts = Object.fromEntries(task.planStep.contract.artifacts.map((f) => [f, crypto.createHash("sha256").update(execFileSync("git", ["show", `${task.submission!.head}:${f}`], { cwd: task.worktree, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).digest("hex")]));
      evidence = { revision: task.submission.head, evidence: artifacts };
    }
    const r = closeAttempt(task, this.workflow, outcome, limitations, checksPassed, evidence);
    this.save();
    if (task.planStep && outcome === "accepted") {
      const root = governedRootOf(task, this.tasks)?.root;
      if (root?.planRun?.review === "checks") void this.integrate(task).then(() => this.planDelivered(root)).catch((e) => this.holdStep(task, root, `Integration needs review: ${e instanceof Error ? e.message : e}`));
      else if (root) { this.queueNotice(root.id, `result:${task.id}`, `the user recorded accepted evidence for ${task.id} at ${r.revision}. Review the submission and use board.js integrate ${task.id}; never merge it through shell git.`); this.deliverNotices(root.id); }
    }
    return r;
  }

  /** Approve scope: remembers the owner's authorization of exactly this scope, for one dispatch (the one-touch rule). */
  approveScope(task: Task) {
    this.mustOwn(); // the approval is written to the workflow store, which save() never guards
    if (!task.workflow?.scope) throw new Error("This step has no scope to approve.");
    const why = this.planLaunchProblem(task);
    if (why) throw new Error(why);
    if (task.workflow.attempt && this.workflow.attempt(task.workflow.attempt)?.state !== "ended") throw new Error("An existing attempt must end and have its result recorded before another approval.");
    this.workflow.approve(task.workflow.scope);
    this.changed.fire();
  }

  /** Like recording checks, acknowledging their exit must not advance the hook replay timestamp. */
  recordRetiringChecks(task: Task, remaining: NonNullable<Task["retiringChecks"]>) {
    this.save(this.tasks, { task, next: { ...task, retiringChecks: remaining.length ? remaining : undefined } });
  }

  /** A check result is not a change to the work, so updatedAt stays: the card keeps its place. */
  recordChecks(task: Task, checks: Task["checks"]) {
    task.checks = checks;
    if (task.planRun?.deliveryCommands && checks?.status === "running") {
      task.deliveryReady = undefined;
      task.reported = undefined;
    }
    this.save();
    // A master that asked to finish: passed checks let the board review the run; failed ones wait in Needs input with Fix it.
    if (task.orchestrator && task.finishAsked && task.status === "review") {
      if (checks?.status === "complete") this.runEvents.fire({ kind: "finishReady", master: task });
      else if (checks?.status === "error") this.update(task, { status: "needs-input" });
      return;
    }
    if (checks?.status === "complete" && task.orchestrator) this.maybeFinished(task);
  }

  /** The master's Stop after `finish self`: with check commands, they run first (recordChecks fires finishReady once they pass). */
  private finishAtStop(t: Task) {
    if (!t.planRun?.deliveryCommands && t.completion?.commands.length && t.checks?.status !== "complete") {
      this.update(t, { deliveryReady: true });
      if (t.checks?.status !== "running") this.checks.start(t); // the Review listener above may have started them already
      return;
    }
    if (this.checks.deliveryProblem(t)) {
      this.update(t, { finishAsked: undefined, deliveryReady: undefined, status: "needs-input" });
      return;
    }
    this.runEvents.fire({ kind: "finishReady", master: t });
  }

  update(task: Task, patch: Partial<Task>, error?: string, quiet?: boolean) {
    const from = task.status;
    const now = new Date().toISOString();
    const next = { ...task };
    if (patch.status === "running" && from !== "running") {
      if (process.platform === "linux") {
        const old = this.checks.runningWorker(task);
        if (old) next.retiringChecks = [...(task.retiringChecks ?? []), old];
      } else this.checks.stop(task); // only Linux can verify the original job path before a delayed process-group signal
      next.checks = undefined; next.deliveryReady = undefined; next.launchError = undefined; next.startRetryAt = undefined;
    }
    Object.assign(next, patch, { updatedAt: now }, patch.status === "running" || patch.status === "done" ? { interrupted: undefined }
      : patch.status === "review" ? { interrupted: error || quiet || patch.interrupted ? true : undefined } : {},
      patch.status === "done" ? { waitsForReset: undefined } : {}, // CORE-GOV-03: a finished card waits for no reset
      patch.status && patch.status !== from ? { statusAt: now } : {});
    this.save(this.tasks, { task, next });
    // An API error is news even in the same column (a StopFailure after the idle scan's Review): its warning shows, and the card says Interrupted.
    if (patch.status && (patch.status !== from || error)) this.status.fire({ task, from, to: patch.status, ...(error ? { error } : {}), ...(quiet ? { quiet } : {}) });
  }

  remove(task: Task) {
    if (this.tasks.some((t) => t.parentId === task.id)) throw new Error("Delete its subtasks first.");
    if (this.deliveryRunning?.id === task.id) throw new Error("Its work is being delivered to the main folder. Try again in a moment.");
    if (this.vaultRuns.has(task.id)) throw new Error("Its work is being uploaded to the vault. Try again when the helper's terminal has closed."); // FR2: the result is written on this card
    if (task.workflow?.attempt && this.workflow.claims().some((c) => c.task === task.id)) throw new Error("This step still holds resources. Record its result first.");
    this.mustOwn(); // before the terminal closes and the session is dismissed
    if (task.retiringChecks?.length) {
      this.checks.retire(task);
      if (task.retiringChecks?.length) throw new Error("Its previous acceptance check is still stopping. Retry Delete after it exits.");
    }
    if (task.legacySpeechId && !this.importedSpeech) this.rememberSpeechIds([task]);
    this.stop(task); // its terminal, or a Codex first turn still working in the background
    this.closing.delete(task.id);
    this.forgetCardTerminal(task.id);
    if (task.codexPanelBridge && task.sessionId) this.forgetPanelHook(task.sessionId);
    if (task.sessionId) {
      // Remember it, or the next scan would add the still-running session (found, or resumed in a panel) straight back.
      this.dismissed.add(task.sessionId);
      writeFileAtomic(this.dismissedFile, JSON.stringify([...this.dismissed]));
    }
    this.checks.stop(task); // its folder goes too, and a worker still running would write it back
    // A discarded card leaves its title on the cards still waiting to start after it, which stay held (F72; a plain delete releases them, F82).
    if (task.discarded) for (const t of this.tasks) if (t.dependsOn?.includes(task.id) && t.status === "queued" && !t.sessionId && !t.blocked) t.blocked = task.title;
    this.tasks = this.tasks.filter((t) => t !== task);
    this.save();
    // Its inbox and wake guard would otherwise stay in notifications.json for good.
    this.loadNotifications();
    const inbox = this.pendingNotices.delete(task.id), guard = this.notified.delete(task.id);
    if (inbox || guard) this.saveNotifications();
    // What an archive's manifest names is copied into its evidence folder first; a failed copy keeps both folders.
    const folders = [path.join(this.dir, "checks", task.id), path.join(this.dir, "reviews", task.id)];
    if (keepReferenced(this.archiveDir, folders)) for (const d of folders) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* a run still in use on Windows */ }
    this.dropCardTemp(task);
  }

  /** Parsed events files, kept until the file's identity, size or modification time changes (one render asks several times per task). */
  private readonly eventCache = new Map<string, { key: string; events: HookEvent[] }>();
  events(id: string): HookEvent[] {
    const file = this.eventsFile(id);
    let events: HookEvent[];
    try {
      const st = fs.statSync(file), key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`, hit = this.eventCache.get(file);
      if (hit?.key === key) events = hit.events;
      else {
        // An unfinished last line fails to parse and is left out; once it is finished the size changes and the file is read again.
        events = fs.readFileSync(file, "utf8").split("\n").flatMap((line) => {
          try {
            return line ? [JSON.parse(line) as HookEvent] : [];
          } catch {
            return [];
          }
        });
        this.eventCache.set(file, { key, events });
      }
    } catch {
      this.eventCache.delete(file);
      return [];
    }
    const task = this.get(id);
    if (task?.provider !== "codex") return events.slice(); // callers cannot change the cached list
    let thread = confirmedCodexThread(task);
    if (!thread && task.codexEditor) {
      // A first-turn hook can report the rollout before thread/start returns. A side thread without a rollout cannot claim the card.
      if (this.codexRuns.has(id) || this.codexPanelStarts.has(id)) thread = codexThread(events.filter((e) => typeof e.transcript_path === "string"));
      thread ??= task.sessionId; // an idle legacy editor needs a matching hook to corroborate its saved id
    }
    return ownThread(events, thread); // terminal starts discover the real id from their hooks
  }

  // ---- M-02, Finish: the card's writers close before its worktree goes (finish.ts, "what must have closed") ----

  /**
   * The session processes this board ended for each card (Stop, Finish's close, the end of an idle panel session), by pid and start
   * time. A session leaves the board's list 15 s after its Stop whether or not its process has gone (scan), so Finish asks about
   * that exact process instead. The start is the one the CLI's session file names, or the board's own reading (noteClosingNow).
   * With neither, nothing is kept: a pid alone would name whatever process has it later.
   */
  private readonly closing = new Map<string, OwnedProcess[]>();
  /** read: this OS's own reading of the process's start, for a session whose file names none (noteClosingNow). */
  private noteClosing(task: Task, live = task.sessionId ? this.external.get(task.sessionId) : undefined, read?: string) {
    const started = read ?? live?.procStart;
    if (!live?.pid || !started || live.pid === process.pid) return;
    const list = this.closing.get(task.id) ?? [];
    if (!list.some((p) => p.pid === live.pid && p.started === started)) list.push({ pid: live.pid, started, what: `its session (process ${live.pid})`, ...(read ? { read: true } : {}) });
    this.closing.set(task.id, list);
  }
  /**
   * Finish's own close, which has the time to look before it closes. A session whose file names its start: this OS's reading of
   * that process is compared with it (startForm). One whose file names none (Codex, an older CLI): the reading itself is the
   * record. Stop and Switch account do not wait for a reading, so there such a session is still not recorded.
   */
  private async noteClosingNow(task: Task) {
    const live = task.sessionId ? this.external.get(task.sessionId) : undefined;
    if (!live?.pid || live.pid === process.pid) return;
    if (live.procStart) { await this.learnStartForm([live]); this.noteClosing(task, live); return; }
    const now = await this.processStart(live.pid);
    if (now !== undefined) this.noteClosing(task, live, now);
  }
  /** Whether a process is there, and when it started (sessions.ts). Tests replace them with stand-ins. */
  processAlive: (pid: number) => boolean = alive;
  processStart: (pid: number) => Promise<string | undefined> = processStart;
  /**
   * This OS reads a process's start in the form the CLI writes it (procStart): seen in this window on a session that was running,
   * where the two were the same. Until then a start that differs from a session file's proves nothing, because that form is the
   * CLI's own and undocumented: a CLI that changed it would make every running session read as another process.
   */
  private startForm = false;
  private async learnStartForm(sessions: Iterable<LiveSession> = this.external.values()): Promise<boolean> {
    let tried = 0;
    for (const s of sessions) {
      if (this.startForm) break;
      if (!s.procStart || !this.processAlive(s.pid) || tried++ >= 3) continue; // three readings at most: each starts a process on Windows
      const now = await this.processStart(s.pid);
      if (now !== undefined && sameStart(now, s.procStart)) this.startForm = true;
    }
    return this.startForm;
  }
  /**
   * Whether a recorded process has ended (sessions.ts ownerState), with "replaced" settled: a start this OS read itself compares
   * with a later reading; a session file's does only once its form is known (startForm). Otherwise nobody can say: "unknown".
   */
  private async ownerNow(p: OwnedProcess): Promise<"exited" | "running" | "unknown"> {
    const state = await ownerState(p, this.processAlive, this.processStart);
    if (state === "running" && !p.read) this.startForm = true; // the same process, by a start in the CLI's own form
    if (state !== "replaced") return state;
    return p.read || await this.learnStartForm() ? "exited" : "unknown";
  }
  /** The card's ended sessions whose process is still there, or cannot be told to have gone; the ones that went are forgotten. */
  private async closingLeft(task: Task): Promise<(OwnedProcess & { state: "running" | "unknown" })[]> {
    const left: (OwnedProcess & { state: "running" | "unknown" })[] = [], gone: OwnedProcess[] = [];
    for (const p of [...(this.closing.get(task.id) ?? [])]) {
      const state = await this.ownerNow(p);
      if (state === "exited") gone.push(p); else left.push({ ...p, state });
    }
    // The list as it is now: a Stop during the readings above may have added to it.
    const kept = (this.closing.get(task.id) ?? []).filter((p) => !gone.includes(p));
    if (kept.length) this.closing.set(task.id, kept); else this.closing.delete(task.id);
    return left;
  }

  /**
   * Who of the card waits for an approval now, from its hook events since its session last started: the session itself (its own
   * prompt, which Finish's dialog names and the user decides on), and each subagent whose permission request no later event of that
   * subagent answered. A subagent's request carries its agent_id (1 of 187 PermissionRequest events in this board's files on
   * 19 November 2026; the next event of that subagent was its SubagentStop). Esc, or a new prompt to the session, ends what a
   * subagent was asking even when it sends no stop of its own: its dialog went with the turn. The session's own Stop does not: a
   * background subagent outlives its parent's turn (card 817bb4, 4 November 2026).
   */
  private approvalWaits(task: Task, events = this.events(task.id)): { session: boolean; children: string[] } {
    const own = (e: HookEvent) => !task.sessionId || e.session_id === undefined || e.session_id === task.sessionId;
    const resume = task.finishAsked?.resume;
    const currentLaunch = (e: HookEvent) => !!resume?.launchId && e.terminal_launch_id === resume.launchId;
    const startsSession = (e: HookEvent) => e.hook_event_name === "SessionStart" && e.agent_id === undefined && e.source !== "compact"
      && (currentLaunch(e) ? e.session_id === task.sessionId : own(e));
    // A verified replacement retires the history already present at launch. Keep the original cursor for classifying delayed hooks.
    const start = events.findLastIndex((e, i) => startsSession(e) && Number.isFinite(e.t)
      && (!resume?.launchId || i < resume.before || currentLaunch(e)));
    const from = resume?.launchId && start >= resume.before ? resume.before : 0;
    const ordered = [];
    for (let i = from; i < events.length; i++) {
      const e = events[i];
      const launch = resume?.launchId ? e.terminal_launch_id : undefined;
      const late = !!resume?.launchId && i >= resume.before && !currentLaunch(e);
      if (late && launch !== undefined) continue;
      const name = e.hook_event_name;
      if (!STATUS_BY_EVENT[name ?? ""] && name !== "SubagentStop" && !startsSession(e)) continue;
      const request = name === "PermissionRequest" || name === "Notification";
      // Requests bearing the new launch ID can precede its first SessionStart. Replay them with that launch's own events.
      if (request && !currentLaunch(e) && i < start && Number.isFinite(e.t) && e.t < events[start].t) continue;
      if (!request && !Number.isFinite(e.t)) continue;
      ordered.push({ e, launch, late, request, time: Number.isFinite(e.t) ? e.t : Infinity });
    }
    // Each hook timestamps before appending. At the same millisecond an answer cannot prove that it followed the request.
    ordered.sort((a, b) => a.time - b.time || Number(a.request) - Number(b.request));
    const byLaunch = new Map<string | undefined, Map<string, Set<string | undefined>>>();
    let firstLaunchStart: number | undefined;
    for (const { e, launch, late, request } of ordered) {
      if (startsSession(e)) {
        if (late) continue;
        if (currentLaunch(e) && e.session_id === resume?.sessionId) {
          firstLaunchStart ??= e.t;
          // This start identifies the process that issued the request. Only a later restart can retire it.
          if (e.t === firstLaunchStart) continue;
        }
        byLaunch.delete(launch);
        continue;
      }
      // Untagged legacy hooks can settle their own approvals, even when delivered after the replacement has stopped.
      let waiting = byLaunch.get(launch);
      if (!waiting) {
        waiting = new Map();
        byLaunch.set(launch, waiting);
      }
      const who = typeof e.agent_id === "string" ? e.agent_id : "";
      if (!who && !own(e)) continue;
      const name = e.hook_event_name;
      const impliedSession = resume?.launchId && launch === undefined ? undefined : task.sessionId;
      const session = typeof e.session_id === "string" ? e.session_id : impliedSession;
      if (request) {
        const sessions = waiting.get(who) ?? new Set();
        waiting.set(who, sessions.add(session));
        continue;
      }
      if (name === "UserPromptSubmit" && !userSubmission(e)) continue;
      if (!late && !who && (name === "Interrupt" || name === "UserPromptSubmit")) { waiting.clear(); continue; }
      // The parent can report its child's SubagentStop. Otherwise an identified actor answers in its own session.
      if (!late && who && name === "SubagentStop" && own(e)) { waiting.delete(who); continue; }
      const sessions = waiting.get(who);
      if ((STATUS_BY_EVENT[name ?? ""] || name === "SubagentStop") && sessions?.delete(session) && !sessions.size) waiting.delete(who);
    }
    const actors = new Set([...byLaunch.values()].flatMap(waiting => [...waiting.keys()]));
    return { session: actors.has(""), children: [...actors].filter(Boolean) };
  }

  /**
   * What may still write in the card's worktree and whose each is, from the board's own records, never from a process's name.
   * The card's own: its session wherever it runs, the session processes this board ended for it (by pid and start time), its
   * acceptance checks, its subagents. Not its own, and so never closed for it: another card whose session runs in the same folder,
   * and a session found in the folder that no card of the board holds.
   */
  private async writersOf(task: Task): Promise<Writer[]> {
    const out: Writer[] = [], mine = (what: string, state: Writer["state"] = "open") => out.push({ what, owner: task.id, state });
    const waits = this.approvalWaits(task);
    const session = task.sessionId ? this.external.get(task.sessionId) : undefined;
    // A session still there after Finish closed it, with its own prompt unanswered: it waits, and does not end by itself.
    const open = (what: string) => mine(what, waits.session && task.status === "needs-input" ? "waiting" : "open");
    if (this.terminal(task)) open("its session's terminal");
    else if (this.cardTerminals.has(task.id)) open("its card terminal");
    else if (this.codexRuns.has(task.id) || this.codexPanelStarts.has(task.id) || this.codexPanelRuns.has(task.id)) mine("Codex's first turn");
    else if (session) open(`its session (process ${session.pid})`);
    else if (["running", "needs-input"].includes(this.codexEditorStatus(task) ?? "")) open("its turn in Codex's editor");
    for (const p of await this.closingLeft(task)) if (p.pid !== session?.pid) mine(p.what, p.state === "running" ? "open" : "unknown");
    if (task.checks?.status === "running") mine("its acceptance checks");
    // A subagent lives in its session's process: with that gone, its last events are history.
    if (out.length) {
      if (waits.children.length) mine(waits.children.length === 1 ? "a subagent" : `${waits.children.length} subagents`, "waiting");
      else if (this.busySubagents(task)) mine("a subagent");
    }
    if (!task.worktree) return out;
    const here = (dir?: string) => !!dir && inside(task.worktree!, dir);
    const sharing = this.tasks.filter((t) => t.id !== task.id && t.status !== "done" && here(t.worktree) && this.live().includes(t.id));
    for (const t of sharing) out.push({ what: `the session of "${t.title}"`, owner: t.id, state: "open" });
    for (const s of this.external.values()) {
      if (s.sessionId === task.sessionId || !here(s.cwd) || sharing.some((t) => t.sessionId === s.sessionId)) continue;
      out.push({ what: `a ${s.provider === "codex" ? "Codex" : "Claude"} session (process ${s.pid})`, owner: this.tasks.find((t) => t.sessionId === s.sessionId)?.id ?? "unknown", state: "open" });
    }
    return out;
  }

  /** How long a removal waits for the card's own writers when its caller names no limits (a governed Finish, a sweep). Tests shorten it. */
  releaseLimits = { closeMs: 60_000, pollMs: 1000 };

  /**
   * The gate every Finish passes right before the worktree goes. It waits for the card's own writers to close (releaseVerdict), then
   * looks at the folder again: nothing may be there that did not land, and nothing unknown may have it open. If any of that fails
   * the worktree stays whole. For landed work the card then records what kept it (cleanup, cleanupPending) and this throws
   * CleanupBlocked; Finish again retries only the cleanup. Nothing is stopped here: Finish's own close has run by now, and what is
   * not the card's is not Finish's to end.
   */
  private async releaseWriters(task: Task, gate: WorktreeGate): Promise<void> {
    const limits = gate.limits ?? this.releaseLimits, worktree = task.worktree!;
    const keep = async (why: string, holders: Writer[] = []): Promise<never> => {
      if (!task.merged) throw new Error(`${why[0].toUpperCase()}${why.slice(1)}`); // nothing landed: the caller says the worktree was kept
      // The result: what this Finish landed, else what the card recorded before, else the folder's own HEAD ("" for a folder that is no checkout).
      const known = gate.result ?? (task.cleanup?.sha ? { sha: task.cleanup.sha, into: task.cleanup.into } : undefined);
      const head = known || !checkedOut(worktree) ? "" : await git(worktree, ["rev-parse", "HEAD"]).catch(() => "");
      const record: CleanupRecord = { sha: known?.sha ?? head, into: known?.into ?? "the target", at: new Date().toISOString(), why, holders };
      // The transcript's path is worked out from the worktree: it is stored now, so the card keeps it whatever becomes of the folder.
      this.update(task, { cleanupPending: true, cleanup: record, transcript: this.transcriptOf(task) });
      throw new CleanupBlocked(`its worktree ${worktree} was kept whole, because ${why} Then press Finish again: it only retries the cleanup.`);
    };
    let writers: Writer[] = [];
    for (const start = Date.now(); ; await sleep(limits.pollMs)) {
      this.rescan();
      writers = await this.writersOf(task);
      const waited = Date.now() - start;
      const verdict = releaseVerdict(writers, task.id, waited >= limits.closeMs ? waited : undefined);
      if ("ready" in verdict) break;
      if ("refuse" in verdict) await keep(verdict.refuse, verdict.holders);
    }
    // Something the board has no record of has the folder open (Windows). A folder just written to can be held for a moment by a
    // scanner or a git of this Finish's own, which the delete below has always outwaited (about 4 s, git.ts), so this waits as long.
    for (const start = Date.now(); this.worktreeHeld(worktree); await sleep(Math.min(limits.pollMs, 250))) {
      if (Date.now() - start >= Math.min(limits.closeMs, 5000)) await keep("something the board has no record of still has the folder open, often a tool the session started (for a Codex editor session, that window's Codex helpers). Close it.",
        [{ what: "a process that has the folder open", owner: "unknown", state: "open" }]);
    }
    // The folder again, after the waits and right before it goes: what a writer left there since the last look must not go with it.
    if (fs.existsSync(worktree) && !checkedOut(worktree)) {
      const files = leftoverFiles(worktree);
      if (files.length) throw new Error(`Its leftover folder ${worktree} still holds files: ${files.join(", ")}${files.length >= 10 ? " …" : ""}. Move what you want to keep, then Finish again, or Discard.`);
    }
    const late = await lateWork(this.repo, worktree, task.branch, gate.landed, gate.result?.sha ?? task.cleanup?.sha);
    if (late) await keep(late);
  }

  /** Cards whose work landed while their worktree was kept (M-02): what a window says again after a reload. */
  cleanupWaiting(): Task[] { return this.tasks.filter((t) => t.cleanup && t.merged && t.worktree && t.status !== "done"); }

  /** Finish removes the card's worktree, once its writers have closed (releaseWriters); a folder something still holds says how to retry. */
  private async removeWorktree(task: Task, gate: WorktreeGate = {}, assertOwner?: () => void): Promise<void> {
    await this.releaseWriters(task, gate);
    assertOwner?.();
    await discardWorktree(this.repo, task.worktree!, task.branch!, !!task.legacySpeechId).catch((e: NodeJS.ErrnoException) => {
      // A merged card's folder in use is only cleanup left: Finish again deletes it (CleanupBlocked); anything else keeps the old advice.
      if (task.merged && BUSY.has(e.code ?? "")) {
        this.update(task, { cleanupPending: true });
        throw new CleanupBlocked(`only its temporary folder ${task.worktree} could not be deleted because something still uses it, often a tool the session started (for a Codex editor session, that window's Codex helpers). Close it, then press Finish again: that only deletes the folder. (${e.code})`);
      }
      throw Object.assign(new Error(`${e.message}${e.code === "EPERM" || e.code === "EBUSY" ? ". Close whatever is using the folder, then use Discard" : ""}`), { code: e.code });
    });
    this.dropCardTemp(task);
  }

  /**
   * The card's own temporary folder, <repo>/.entomatical/tmp/<id> (workspace.ts): its sessions get it as TMP, TEMP and TMPDIR, so what
   * they and their tools make goes inside the workspace (the user, 13 November 2026), never the system temp folder or a drive root.
   */
  cardTemp(task: Task): string {
    const dir = path.join(tempRoot(this.repo), task.id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  /** Deleted with the card's worktree or the card; a folder something still holds is left for the next Finish or Delete. */
  private dropCardTemp(task: Task) {
    try { fs.rmSync(path.join(this.dir, "tmp", task.id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* in use on Windows */ }
  }

  /** Where the CLI keeps the task's conversation, when known. A stored path that no longer exists (an account folder renamed) is recomputed. */
  transcriptOf(task: Task): string | undefined {
    // Codex's hooks name its rollout file (transcript_path); a found Codex session stored it when adopted.
    // A session whose hooks did not name it is found by its thread id, once Codex's SessionStart gave the card that id.
    if (task.provider === "grok" || task.provider === "antigravity") return undefined;
    if (task.provider === "codex") {
      const named = this.events(task.id).findLast((e) => typeof e.transcript_path === "string")?.transcript_path as string | undefined;
      return task.transcript ?? (named === undefined ? undefined : fromCodexPath(named)) // a WSL Codex names a WSL path
      ?? (task.sessionId && this.events(task.id).some((e) => e.hook_event_name === "SessionStart") ? rolloutFor(task.sessionId) : undefined);
    }
    if (!task.sessionId) return task.transcript;
    return this.claudePlaces(task).file;
  }

  /** claudePlaces' last answer per card: `at` when it was last confirmed, `generation` the sessionPlaces listing it used. */
  private readonly located = new Map<string, { key: string; file?: string; found: boolean; folders: string[]; at: number; generation: number }>();

  /**
   * A Claude card's transcript and session folders, wherever its session went: the card's stored transcript, the transcript_path its
   * hooks last named, the path its account and cwd compute, and <every config folder>/projects/<any project folder>/<id>.jsonl
   * (sessions.ts sessionPlaces). The most recently written existing one is the transcript (ties keep that order); every candidate's
   * <id> folder is a session folder, for subagents. With none existing the transcript is what it always was: the computed path, or
   * the stored one when the account is gone. It runs on every render: an answer stands for LOCATE_FRESH_MS, then one stat confirms it
   * until the shared listing is redone; a vanished file forces a new listing.
   */
  private claudePlaces(task: Task): { file?: string; found: boolean; folders: string[] } {
    const id = task.sessionId!, cwd = task.worktree ?? this.repo;
    let own: string | undefined;
    try { own = this.configDirOf(task) || DEFAULT_DIR; } catch { own = undefined; } // account no longer known
    const computed = own === undefined ? undefined : transcriptPath(own, cwd, id);
    const key = [id, task.transcript ?? "", computed ?? ""].join("\n"), now = Date.now();
    const hit = this.located.get(task.id);
    if (hit?.key === key && hit.found && now - hit.at < LOCATE_FRESH_MS) return hit;
    const gone = !!hit?.found && !fs.existsSync(hit.file!);
    const places = sessionPlaces([...this.accountFolderList(), own ?? "", ""], id, gone);
    if (hit?.key === key && hit.found && !gone && hit.generation === places.generation) { hit.at = now; return hit; }
    const named = this.events(task.id).findLast((e) => e.agent_id === undefined && typeof e.transcript_path === "string"
      && path.basename(e.transcript_path) === `${id}.jsonl`)?.transcript_path as string | undefined;
    // The project folder is named after the cwd as the CLI saw it: a lower-case drive letter gives "c--..." (Windows only).
    const otherCase = computed && process.platform === "win32" ? path.join(path.dirname(path.dirname(computed)), path.basename(path.dirname(computed)).replace(/^[a-zA-Z]/, (c) => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()), path.basename(computed)) : undefined;
    const same = (a: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() : path.resolve(a);
    const candidates = [task.transcript, named, computed, otherCase, ...places.transcripts].filter((f): f is string => !!f)
      .filter((f, i, all) => all.findIndex((g) => same(g) === same(f)) === i);
    let file: string | undefined, newest = -Infinity;
    for (const f of candidates) {
      try { const at = fs.statSync(f).mtimeMs; if (at > newest) { newest = at; file = f; } } catch { /* not there */ }
    }
    const folders = [...candidates.map((f) => f.replace(/\.jsonl$/, "")), ...places.folders].filter((f, i, all) => all.findIndex((g) => same(g) === same(f)) === i);
    const answer = { key, file: file ?? computed ?? task.transcript, found: file !== undefined, folders, at: now, generation: places.generation };
    this.located.set(task.id, answer);
    return answer;
  }

  /** A Claude card's session folders (<id>, holding subagents/) wherever the session went (claudePlaces); none for other providers. */
  sessionFolders(task: Task): string[] {
    return task.sessionId && !task.provider ? this.claudePlaces(task).folders : [];
  }

  /** The subagents the task's session has spawned, with what each is doing. */
  subagentsOf(task: Task): Subagent[] {
    const transcript = this.transcriptOf(task);
    let agents: Subagent[];
    if (task.provider === "codex") agents = transcript ? codexSubagents(transcript).map(agent => ({ ...agent })) : [];
    else {
      // A Claude session's subagents sit beside whichever transcript was being written when each ran (claudePlaces): one agent seen
      // in several (hard links, carried copies) is the copy written last.
      const byId = new Map<string, Subagent>();
      const sources = task.sessionId && !task.provider ? this.sessionFolders(task).map((f) => `${f}.jsonl`) : [];
      for (const file of transcript ? [transcript, ...sources] : sources) {
        for (const agent of subagents(file)) {
          const seen = byId.get(agent.id);
          if (!seen || agent.updated > seen.updated) byId.set(agent.id, { ...agent });
        }
      }
      agents = [...byId.values()];
    }
    const lifecycle = new Map<string, HookEvent>();
    for (const event of finishEvents(task, this.events(task.id))) {
      if (typeof event.agent_id !== "string" || !["SubagentStart", "SubagentStop"].includes(event.hook_event_name || "")) continue;
      const previous = lifecycle.get(event.agent_id);
      const namedType = typeof event.agent_type === "string" && event.agent_type.trim() ? event.agent_type : undefined;
      lifecycle.set(event.agent_id, {
        ...event,
        // A blank agent_type is Claude's prompt-suggestion helper, not a type. Keep the real one from an earlier event.
        agent_type: namedType ?? (typeof previous?.agent_type === "string" && previous.agent_type.trim() ? previous.agent_type : event.agent_type),
        model: typeof event.model === "string" ? event.model : previous?.model,
        effort: typeof event.effort === "string" ? event.effort : typeof event.effort_level === "string" ? event.effort_level : previous?.effort,
        agent_transcript_path: typeof event.agent_transcript_path === "string" ? event.agent_transcript_path : previous?.agent_transcript_path,
        last_assistant_message: typeof event.last_assistant_message === "string" ? event.last_assistant_message
          : event.hook_event_name === "SubagentStop" ? previous?.last_assistant_message : undefined,
      });
    }
    for (const [id, event] of lifecycle) {
      const blankType = typeof event.agent_type === "string" && !event.agent_type.trim();
      const transcriptPath = typeof event.agent_transcript_path === "string" && event.agent_transcript_path.trim() ? event.agent_transcript_path : undefined;
      let agent = agents.find(a => a.id === id);
      // The session-folder scan can miss a file the stop hook already named.
      if (!agent && transcriptPath) {
        const read = readSubagent(transcriptPath);
        if (read) {
          agent = agents.find(a => a.id === read.id);
          if (!agent) { agent = { ...read, id: read.id || id }; agents.push(agent); }
        }
      }
      // Prompt-suggestion helpers carry agent_type "" and no readable transcript (their stop names a file that never exists). They are not subagents.
      if (!agent && blankType) continue;
      if (!agent) { agent = { id, type: "agent", description: "", done: false, steps: 0, doing: "Awaiting transcript", updated: event.t, known: false }; agents.push(agent); }
      agent.done = event.hook_event_name === "SubagentStop"; agent.lifecycle = "hook";
      if (typeof event.agent_type === "string" && event.agent_type.trim()) agent.type = event.agent_type;
      if (!agent.model && typeof event.model === "string") agent.model = event.model;
      if (typeof event.effort === "string") agent.effort = event.effort;
      if (agent.doing === "Awaiting transcript" || agent.doing === "starting") {
        const message = typeof event.last_assistant_message === "string" ? event.last_assistant_message.trim() : "";
        if (message) agent.doing = message.split("\n")[0].slice(0, 120);
        else if (agent.done && agent.doing === "Awaiting transcript") agent.doing = "Finished";
      }
      agent.updated = Math.max(agent.updated, event.t);
    }
    return agents;
  }

  /** First line of Claude's latest answer: from the Stop hook for board tasks, else from the transcript. */
  lastReply(task: Task): string | undefined {
    const events = this.events(task.id);
    if (task.provider === "grok" || task.provider === "antigravity") {
      const last = events.findLast((e) => e.hook_event_name === "UserPromptSubmit" || e.hook_event_name === "Stop");
      if (last?.hook_event_name !== "Stop") return undefined;
    }
    const stop = events.findLast((e) => e.hook_event_name === "Stop" && typeof e.last_assistant_message === "string");
    // An ACP turn's Stop also names its last message (after the last tool call); the headline shows that, not the turn's opening line.
    const headline = typeof stop?.last_message === "string" && stop.last_message.trim() ? stop.last_message : stop?.last_assistant_message;
    // A session resumed outside the card (its hooks went elsewhere) answered after the card's last Stop: its transcript has the reply.
    if (stop && !this.outsidePrompts(task, this.hookPrompts(task, REPLY_CAP)).lastIsOutside) return (headline as string).trim().split("\n")[0].slice(0, 160);
    const transcript = this.transcriptOf(task);
    if (!transcript) return undefined;
    return task.provider === "codex" ? readRollout(transcript)?.lastReply?.trim().split("\n")[0].slice(0, 160) : lastAssistantText(transcript);
  }

  /** Every prompt the session received (from the board or typed in the terminal), each with the answer it got; the first prompt before it starts. */
  prompts(task: Task, replyCap = REPLY_CAP): Exchange[] {
    if (task.transcript) {
      // A Claude session resumed elsewhere (another account or project folder) wrote on in another file: transcriptOf finds it.
      const file = task.provider ? task.transcript : this.transcriptOf(task) ?? task.transcript;
      const typed = task.provider === "codex" ? readRollout(file)?.exchanges ?? [] : transcriptExchanges(file);
      return typed.length ? typed : [{ text: task.prompt }];
    }
    const sent = this.outsidePrompts(task, this.hookPrompts(task, replyCap)).merged;
    return sent.length ? sent : [{ text: task.prompt }];
  }

  /**
   * The prompts the card's hooks reported, each paired with the Stop that ended its turn. Codex runs a spawned agent's hooks in the
   * parent's session too, tagged with agent_id: those prompts and stops are the agent's, not the task's.
   */
  private hookPrompts(task: Task, replyCap: number): Exchange[] {
    const sent: Exchange[] = [];
    for (const e of this.events(task.id)) {
      if (e.agent_id !== undefined) continue;
      if (e.hook_event_name === "UserPromptSubmit" && typeof e.prompt === "string") sent.push({ text: typedText(e.prompt) });
      else if (e.source === "acp" && e.hook_event_name === "AcpMessageChunk" && typeof e.text === "string" && sent.length) {
        const current = sent[sent.length - 1];
        current.reply = ((current.reply ?? "") + e.text).slice(0, replyCap);
        current.replyStatus = "partial";
      } else if (e.hook_event_name === "Stop" && typeof e.last_assistant_message === "string" && sent.length) {
        sent[sent.length - 1].reply = e.last_assistant_message.trim().slice(0, replyCap);
        delete sent[sent.length - 1].replyStatus;
      }
    }
    return sent;
  }

  /**
   * A Claude card's hook prompts with the prompts its transcript (wherever claudePlaces found it) holds and its hooks never reported,
   * in transcript order: a session resumed outside the card (card 19d7e9, from the main checkout under another account) sends its
   * hooks elsewhere. A transcript prompt matches the next hook prompt with the same text (whitespace aside); a hook prompt the
   * transcript lacks (a <task> prompt it does not list, one not written yet) stays where it was. `outside` are the added ones, with
   * when each was written. Reads only what the transcript appended since the last call (sessions.ts transcriptTurns).
   */
  private outsidePrompts(task: Task, sent: Exchange[]): { merged: Exchange[]; outside: { text: string; at: number }[]; lastIsOutside: boolean } {
    const none = { merged: sent, outside: [], lastIsOutside: false };
    if (task.provider || !task.sessionId) return none;
    const place = this.claudePlaces(task);
    if (!place.found) return none;
    const { exchanges, times } = transcriptTurns(place.file!);
    const key = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);
    const keys = sent.map((e) => key(e.text));
    const merged: Exchange[] = [], outside: { text: string; at: number }[] = [];
    let next = 0, lastIsOutside = false;
    exchanges.forEach((x, i) => {
      const k = keys.indexOf(key(x.text), next);
      if (k >= 0) { merged.push(...sent.slice(next, k + 1)); next = k + 1; lastIsOutside = false; }
      else { merged.push({ ...x }); outside.push({ text: x.text, at: times[i] }); lastIsOutside = true; }
    });
    if (!outside.length) return none;
    if (next < sent.length) { merged.push(...sent.slice(next)); lastIsOutside = false; }
    return { merged, outside, lastIsOutside };
  }

  /**
   * The last hook event time each card's status was set from (syncStatus), or any status change accounted for (constructor). A rename
   * does not move it. Seeded from updatedAt when this window takes the board over: another window applied the events before then.
   */
  private readonly applied = new Map<string, number>();
  /** Live observations for a standing request. A reload cannot attest that a saved wait still has the same terminal. */
  private readonly liveFinishTurn = new WeakMap<NonNullable<Task["finishAsked"]>, { terminal?: vscode.Terminal; promptIndex?: number }>();
  private readonly finishTerminalLaunches = new WeakMap<vscode.Terminal, string>();

  waitForFinishInput(task: Task, step: string) {
    const wait = { step, eventsAtWait: this.events(task.id).length };
    const term = task.provider === "codex" ? this.terminal(task) : undefined;
    if (task.finishAsked) this.liveFinishTurn.set(task.finishAsked, { terminal: term });
    this.update(task, { status: "needs-input", selfFinish: wait });
  }
  /** Cards whose parent Stop waits on a busy subagent (syncStatus); each tick looks again, so one that went silent cannot hold it. */
  private readonly held = new Set<string>();

  /**
   * Subagents still working: started with no SubagentStop, and heard from in the last 15 minutes. A crashed one never sends its stop; a live
   * one writes its transcript at least once per tool call, and the longest tool call (Bash's timeout cap) is 10 minutes.
   */
  private busySubagents(task: Task): boolean {
    // Not busy either: one whose own Stop or StopFailure fired with no SubagentStop (card 817bb4 has two), or one whose process a
    // later session start replaced (Stop or Esc, then Resume). A compaction keeps the process.
    const events = finishEvents(task, this.events(task.id));
    const ended = new Set(events.filter((e) => typeof e.agent_id === "string" && (e.hook_event_name === "Stop" || e.hook_event_name === "StopFailure")).map((e) => e.agent_id));
    const restarted = events.findLast((e) => e.hook_event_name === "SessionStart" && e.agent_id === undefined && e.source !== "compact")?.t ?? 0;
    return this.subagentsOf(task).some((a) => !a.done && !ended.has(a.id) && a.updated > restarted && Date.now() - a.updated < 15 * 60_000);
  }

  /** replay: the events may be old news (a poll, a takeover), so only one newer than the last one applied (`applied`) moves it. */
  private syncStatus(id: string, replay = false) {
    const task = this.get(id);
    if (!task || task.status === "done" || task.cancelled) return;
    const raw = this.events(id);
    const cardEvents = finishEvents(task, raw);
    const replacement = clearedSession(task, cardEvents);
    if (replacement) this.update(task, { sessionId: replacement, transcript: undefined });
    // Only the controller's hooks can resume a standing interactive Finish. Keep child activity for the ordinary busy checks.
    const finishSession = task.finishAsked && !task.controller && !task.orchestrator?.session && (!task.headless || task.takenOver) ? task.sessionId : undefined;
    const resume = finishResume(task);
    const lifecycle = finishSession ? sessionBoundary(cardEvents, finishSession) : -1;
    // An End after a valid Stop keeps that Stop. Late hooks from the ended process cannot start a new turn.
    const beforeEnd = lifecycle >= (resume?.before ?? 0) && cardEvents[lifecycle]?.hook_event_name === "SessionEnd" ? cardEvents.slice(0, lifecycle) : cardEvents;
    const events = finishSession ? beforeEnd.filter(e => e.session_id === finishSession || e.agent_id !== undefined) : beforeEnd;
    const ready = events.findLast((e) => e.hook_event_name === "SessionStart" && e.session_id === task.sessionId);
    if (this.unconfirmedHeadless.has(id) && ready && ready.t >= (this.headlessStartedAt.get(id) ?? Infinity)) {
      this.unconfirmedHeadless.delete(id);
      this.update(task, { controller: undefined, pendingPermission: undefined, takenOver: undefined,
        ...(task.orchestrator?.session ? { orchestrator: { ...task.orchestrator, session: undefined, reboundAt: undefined } } : {}) });
    }
    // Codex picks its own thread id; the card takes it from SessionStart, so resume, found-session matching and dismissals use the real one.
    const thread = task.provider === "codex" ? finishSession ?? codexThread(events) : undefined;
    const adopted = !!thread && thread !== task.sessionId;
    if (adopted) this.update(task, { sessionId: thread });
    // A panel start whose launch was claimed but whose session reported in after startInPanelNow stopped waiting (panelPending) takes its
    // id as a start in time does; no other card takes a stray SessionStart (a terminal closed in its first second, an old card).
    const late = !task.provider && !task.sessionId && task.panelPending ? events.findLast((e) => e.hook_event_name === "SessionStart" && typeof e.session_id === "string")?.session_id as string | undefined : undefined;
    if (late) {
      this.update(task, { sessionId: late, panel: true, panelPending: undefined }); // first: a window that does not own the board throws here and keeps the continuation
      this.sentPrompt(task);
      this.writeLaunch(late, task);
    }
    // A Claude session's hooks before its latest SessionStart are the process it replaced: a turn that ended with no Stop (Esc, No at a
    // permission prompt) must not put a resumed card back in Running or Needs input (seen on Windows, 31 October 2026, card ba6eed).
    // A subagent's Stop or StopFailure (agent_id; Codex's spawned agents too) ends its own turn, not the task's (seen 4 Nov 2026, card 817bb4).
    const reviewWait = terminalReviewWait(task);
    const current = (task.provider ? events : events.slice(events.findLastIndex((e) => e.hook_event_name === "SessionStart" && e.agent_id === undefined) + 1))
      .filter((e) => e.agent_id === undefined || (!reviewWait && STATUS_BY_EVENT[e.hook_event_name ?? ""] !== "review"));
    let s = statusFromEvents(current);
    const last = current.findLast((e) => STATUS_BY_EVENT[e.hook_event_name ?? ""]); // the event statusFromEvents went by
    // F91: the card's own hook stopped this headless run after refused calls. It stays in Needs input with the reason, whatever came
    // after (the process ending, a Stop), until a later prompt or a newer run of the card.
    const stopped = this.refusalStopIn(task, current);
    if (stopped && task.refusalStop?.at !== stopped.t) this.update(task, { refusalStop: { at: stopped.t, ...(stopped.refusal_stop as Omit<NonNullable<Task["refusalStop"]>, "at">) } });
    else if (!stopped && task.refusalStop) this.update(task, { refusalStop: undefined });
    if (stopped) s = "needs-input";
    // A hidden run resumed after these events (a follow-up): until its own SessionStart, the old Stop, or the old refusals of a run its
    // hook stopped (F91), must not move the card back.
    if ((s === "review" || s === "needs-input") && task.headless && this.terminal(task) && (last?.t ?? 0) < (this.headlessStartedAt.get(task.id) ?? 0)) s = undefined;
    // An interrupted card whose session is gone (a reload, a stop): its old events cannot make it live again; only a new run can.
    if ((s === "running" || s === "needs-input") && task.interrupted && task.status === "review" && !this.terminal(task) && !(task.sessionId && this.external.has(task.sessionId)) && !this.codexRuns.has(task.id)) s = undefined;
    const mark = this.applied.get(id) ?? 0;
    // A watcher can wake for a note and see the same Stop. Use the saved event count even for hooks in the same millisecond.
    // Earlier versions recorded only when the card entered the column.
    let submitted = false;
    let fresh = !(replay && (last?.t ?? 0) <= mark);
    const liveTurn = task.finishAsked && this.liveFinishTurn.get(task.finishAsked);
    // Separate reads can apply a prompt and then see its Stop or Interrupt with the same timestamp.
    if (!fresh && finishSession && task.finishAsked && s === "review" && last?.t === mark) {
      const prompt = liveTurn?.promptIndex;
      fresh = prompt !== undefined && raw.lastIndexOf(last) > prompt;
    }
    if (reviewWait) {
      const count = task.selfFinish?.eventsAtWait;
      const recent = count !== undefined && count <= raw.length ? new Set(raw.slice(count)) : undefined;
      const newer = beforeEnd.filter(e => recent ? recent.has(e) : e.t > Date.parse(task.statusAt ?? task.updatedAt));
      let human = !!task.selfFinish?.composerSubmitted;
      let knownLaunch = !!resume && resume.before === count && resume.before <= cardEvents.length && !human;
      // Without launch provenance a Codex prompt can precede the SessionStart that identifies it as an unknown first turn.
      const waitTerminal = liveTurn?.terminal;
      const waitForStop = task.provider === "codex" && !knownLaunch && !human && !(waitTerminal && waitTerminal === this.terminal(task));
      let echo = knownLaunch ? resume?.promptHash : undefined;
      let unknownFirstTurn = false;
      for (const e of newer) {
        if (e.session_id !== task.sessionId || e.agent_id !== undefined) continue;
        if (e.hook_event_name === "SessionStart" && e.source !== "compact") {
          const cleared = !task.provider && e.source === "clear";
          unknownFirstTurn = !knownLaunch && !cleared;
          // Codex can report this launch's first prompt before its start hook. An unrecorded restart cannot inherit that turn.
          if (unknownFirstTurn || task.provider !== "codex") human = false;
          if (unknownFirstTurn || cleared) echo = undefined;
          knownLaunch = false;
        } else if (e.hook_event_name === "SessionEnd") {
          human = false;
          knownLaunch = false;
          unknownFirstTurn = true;
        } else if (e.hook_event_name === "Stop") {
          knownLaunch = false;
          unknownFirstTurn = false;
          echo = undefined;
        } else {
          const text = userSubmission(e);
          if (!text || unknownFirstTurn) continue;
          // A command-line prompt may be echoed once. A different first prompt, or the same text in a later turn, is new work.
          if (!echo || sha(text) !== echo) human = true;
          echo = undefined;
        }
      }
      fresh = human && !!last && newer.includes(last) && (!waitForStop || last.hook_event_name === "Stop");
      submitted = fresh;
      if (submitted && s === "running" && task.finishAsked && last) this.liveFinishTurn.set(task.finishAsked, { promptIndex: raw.lastIndexOf(last) });
    }
    // A StopFailure not yet applied moves the card even when it is in Review already (the idle scan beat the un-awaited hook, or a
    // refused follow-up in poll mode), so its warning shows and the card is marked Interrupted, once per event.
    // Ten minutes at most for a card already in Review: an old StopFailure from before this build must not mark it Interrupted.
    const failed = !stopped && last?.hook_event_name === "StopFailure" && last.t > mark && (task.status !== "review" || Date.now() - last.t < 600_000);
    // A background subagent can outlive its parent's turn: the parent's Stop then is not the end of the work (card 817bb4, 4 Nov 2026,
    // 8 of 28 Stops were followed by subagent work). The card stays Running; the Stop after the CLI re-prompts it gives the Review.
    // A subagent that just ended after the parent's Stop is followed by the CLI's re-prompt within seconds (0.1 s in 5 of 6 on 817bb4).
    const justEnded = !!last && events.some((e) => e.hook_event_name === "SubagentStop" && e.t > last.t && Date.now() - e.t < 15_000);
    const held = s === "review" && (this.busySubagents(task) || last?.hook_event_name === "Stop" && justEnded);
    if (held) this.held.add(id); else this.held.delete(id);
    if (held && task.status === "review" && this.busySubagents(task)) {
      this.update(task, { status: "running" });
      this.applied.delete(id);
    }
    const finished = task.interrupted && last?.hook_event_name === "Stop" && last.t > mark;
    const moves = !!s && fresh && (s !== task.status || failed || finished) && !held;
    const fable = fresh && !task.provider && fableLimitHit(last) && this.fableFallback(task, events, last!);
    const turnEnded = moves && s === "review";
    const completedPlan = turnEnded && task.planFirst && last?.hook_event_name === "Stop";
    const clearContinuation = task.continued && events.some(e => e.hook_event_name === "SessionStart");
    // Codex's Interrupt (Esc mid-turn) is unfinished work, as for Claude's Esc: quiet, so no checks and no "finished".
    // A headless child's usage limit is the board's to handle (13.1 item 3): no settle notice for the limit itself, only for its real end.
    const limited = fresh && last?.hook_event_name === "StopFailure" && last.error === "rate_limit" && !!task.headless && !!task.openedBy && !task.provider && !fable && !this.fableSeen.has(`${task.id}:${last.t}`);
    if (limited) this.muted.add(task.id);
    if (moves) {
      // Asked you something (F79): a turn that ended with a Stop whose reply asks (hook.js) is kept on the card, before the status
      // fires, so the notification can say so. Any other move clears it.
      const asks = s === "review" && last?.hook_event_name === "Stop" && last.asks === true ? true : undefined;
      const planFile = s === "review" && last?.hook_event_name === "Stop" ? this.writtenPlan(task, last.last_assistant_message) : undefined;
      this.update(task, { status: s, asks, ...(completedPlan ? { planFirst: undefined } : {}),
        ...(submitted ? { selfFinish: undefined, autoRounds: 0, mergeRetries: 0 } : {}),
        ...(completedPlan && clearContinuation ? { continued: undefined } : {}), ...(planFile ? { planFile } : {}) },
        fable || (!stopped && last?.hook_event_name === "StopFailure" ? String(last.error ?? "API error") : undefined), !stopped && last?.hook_event_name === "Interrupt");
      this.applied.set(id, last!.t);
    } else if (submitted) this.update(task, { autoRounds: 0, mergeRetries: 0, selfFinish: undefined });
    if (limited) void this.limitFallback(task, last!);
    // Codex has no --name: the card's title goes on its thread once the thread is known, and again when a turn ends (Codex names
    // threads itself after a turn, which must not win over the user's title).
    if (adopted || turnEnded) void this.nameThread(task);
    // The moved task's new session is up, so its first prompt (read before launch) went in with the note. Last: a non-owner throws here.
    if (task.continued && clearContinuation) { task.continued = undefined; this.save(); }
    // Plan first (F78): once the first turn ended with a Stop, or its plan was approved, the --settings file loses "plan", so a resume
    // or a panel reopen starts in the card's own permission mode. A StopFailure or Esc leaves it: that turn did not get to a plan.
    if (completedPlan || task.planFirst && planEnded(events)) {
      if (!completedPlan) {
        task.planFirst = undefined;
        this.save();
      }
      this.refreshHooks(task);
    }
  }

  /**
   * "Run this plan now" (F99; the user, 14 November 2026): the last `<name>.plan.json` a turn's reply names, as `workflows/<name>` when that
   * file is directly in the main checkout's workflows/. Read from the reply, not F98's hook, so Codex cards get it too. Never on a plan
   * card or a card of its run.
   */
  private writtenPlan(task: Task, reply: unknown): string | undefined {
    if (typeof reply !== "string" || task.planRun || task.workflow || (task.openedBy && this.get(task.openedBy)?.planRun)) return undefined;
    const name = reply.match(/[\w.-]+\.plan\.json/g)?.at(-1);
    return name && fs.existsSync(path.join(this.repo, "workflows", name)) ? `workflows/${name}` : undefined;
  }

  /** Names a Codex thread; tests replace it. */
  setCodexName: (threadId: string, name: string) => Promise<void> = nameCodexThread;
  private readonly namedThreads = new Map<string, string>(); // thread id -> the name last set, so an unchanged title is not sent twice in a row

  /**
   * Puts a Codex card's title on its thread. The Codex extension owns the editor tab label; naming the thread does not guarantee
   * that label changes (26.1021.22027 excludes exec threads from its title lookup). Only typed or generated titles (`named`):
   * a title taken from the prompt would hide Codex's own naming.
   */
  async nameThread(task: Task): Promise<boolean> {
    if (task.provider !== "codex" || !task.named || !task.sessionId) return false;
    if (!task.adopted && !task.codexPanelBridge && !this.events(task.id).some((e) => e.hook_event_name === "SessionStart")) return false; // the id is not Codex's yet
    const title = task.title.trim();
    if (!title || this.namedThreads.get(task.sessionId) === `${task.status}\n${title}`) return false;
    this.namedThreads.set(task.sessionId, `${task.status}\n${title}`);
    try {
      await this.setCodexName(task.sessionId, title);
      return true;
    } catch (e) {
      this.namedThreads.delete(task.sessionId);
      vscode.window.showWarningMessage(`Entomatical: Codex did not take the title "${title}" for its thread. ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** Account folders (usageKey) at their Fable limit, until when (ms). the user, 29 Oct 2026: past it, work carries on with Opus and below. */
  private readonly fableLimited = new Map<string, number>();
  /** Fable-limit StopFailures already acted on, by task and event time. */
  private readonly fableSeen = new Set<string>();

  /** Whether the task's next launch runs on Opus: its account is at its Fable limit and the task runs Fable, by choice or by default. */
  fableBlocked(task: Task): boolean {
    if (task.provider || (task.model && task.model !== "fable")) return false;
    let key: string;
    try { key = usageKey(this.configDirOf(task)); } catch { return false; }
    if ((this.fableLimited.get(key) ?? 0) <= Date.now()) return false;
    return task.model === "fable" || this.events(task.id).some((e) => e.hook_event_name === "SessionStart" && typeof e.model === "string" && /fable/i.test(e.model));
  }

  /**
   * A turn refused by the Fable limit: the account is marked limited until its weekly reset (5 hours when that is unknown), and a board
   * terminal session is resumed on Opus (through its --settings file) with the refused prompt sent again. /model in the session would
   * also save Opus as the account's default (seen 29 Oct 2026), so the board never types it. Returns the card's error note.
   */
  private fableFallback(task: Task, events: HookEvent[], failure: HookEvent): string | undefined {
    const seen = `${task.id}:${failure.t}`;
    if (this.fableSeen.has(seen) || Date.now() - failure.t > 120_000) return undefined; // old news after a reload
    this.fableSeen.add(seen);
    let configDir: string;
    try { configDir = this.configDirOf(task); } catch { return undefined; }
    const week = (readUsage(configDir)?.weekResets ?? 0) * 1000;
    this.fableLimited.set(usageKey(configDir), week > Date.now() ? week : Date.now() + 5 * 3600_000);
    const prompt = events.slice(0, events.indexOf(failure)).findLast((e) => e.hook_event_name === "UserPromptSubmit" && e.agent_id === undefined)?.prompt;
    if (!this.terminal(task) || typeof prompt !== "string" || !this.isOwner()) return "Fable limit reached. Resume continues on Opus";
    void this.continueOnOpus(task, prompt).catch((e) =>
      void vscode.window.showWarningMessage(`Entomatical: "${task.title}" reached its Fable limit, and continuing on Opus failed (${e instanceof Error ? e.message : e}). Use Resume.`));
    return "Fable limit reached; continuing on Opus";
  }

  private async continueOnOpus(task: Task, prompt: string) {
    this.stop(task);
    if (!await this.ended(task)) throw new Error("the session did not close");
    if (await this.resumeAndSend(task, prompt) === false) throw new Error("the resumed session did not come up");
  }

  /** Resumes the task in a terminal and types `prompt` once the session is up. False: it did not come up; undefined: no terminal (Codex's editor). */
  private async resumeAndSend(task: Task, prompt: string): Promise<boolean | undefined> {
    const before = this.events(task.id).length;
    const term = await this.resume(task);
    if (!term) return undefined;
    const ready = await this.waitForEvent(task.id, "SessionStart", before, 120_000, () => this.terminal(task) === term);
    if (!ready) return false;
    await sleep(1500); // as start(): let the input box render
    if (this.terminal(task) !== term) return false;
    const sentAt = this.events(task.id).length;
    term.sendText(paste(prompt), false);
    this.confirmSubmitted(task, term, sentAt);
    return true;
  }

  /** Waits for the hook event; gives up early (undefined) once `keep` says to stop waiting. */
  async waitForEvent(id: string, name: string, after: number, ms: number, keep: () => boolean = () => true): Promise<HookEvent | undefined> {
    for (const end = Date.now() + ms; Date.now() < end && keep(); await sleep(500)) {
      const hit = this.events(id).slice(after).find((e) => e.hook_event_name === name);
      if (hit) return hit;
    }
    return undefined;
  }

  /** A session's terminal closed (a VS Code terminal, or a Claude/Codex card terminal's process exited). */
  private terminalClosed(t: vscode.Terminal) {
    // A strict card's MCP file (strictMcpFile) goes with its session.
    for (const [id, term] of this.terminals) if (term === t) {
      this.terminals.delete(id);
      fs.rmSync(this.strictMcpFile(id), { force: true });
      this.guard(() => {
        const card = this.get(id);
        if (!card) return;
        if (card.terminalLaunch && launchState(card, this.events(id)) === "dispatched")
          this.update(card, { terminalLaunch: { ...card.terminalLaunch, exited: true } });
        this.deliverNotices(id);
        const root = masterOf(card, this.tasks);
        if (root?.orchestrator) this.scheduleJudgments(root);
      });
    }
    this.changed.fire();
  }

  /** The card's ancestors by parentId: parent, grandparent and so on (F89). */
  ancestorsOf(task: Task): Task[] { return ancestorsOf(task, this.tasks); }

  /**
   * F87: Enter typed into a Grok or Antigravity card terminal that reported its turn done (board.js turn-done) sends a new prompt, so
   * the card runs again until the agent reports that turn done too. Only the keys typed are read, never the screen.
   */
  private turnTyped(task: Task | undefined) {
    if (task?.cardTerminalStarted && (task.provider === "grok" || task.provider === "antigravity") && task.status === "review" && !task.interrupted && this.cardTerminals.has(task.id))
      this.update(task, { status: "running" });
  }
  /** the user typed in a card terminal (F89). After 2 s without more keys the card says so and its ancestors get one notice. */
  private userTyped(id: string, enter = false) {
    if (!this.ownsNow()) return;
    if (enter) this.turnTyped(this.get(id));
    this.terminalUser.set(id, Date.now());
    clearTimeout(this.typingTimers.get(id));
    const timer = setTimeout(() => { this.typingTimers.delete(id); this.guard(() => this.reportUserInput(id)); }, 2000);
    timer.unref?.();
    this.typingTimers.set(id, timer);
  }
  private reportUserInput(id: string) {
    const task = this.get(id), at = this.terminalUser.get(id);
    if (!task || !at) return;
    this.update(task, { terminalInput: { by: "you", at: new Date(at).toISOString() } });
    for (const parent of this.ancestorsOf(task)) {
      if (!parent.sessionId || parent.status === "done" || parent.cancelled) continue;
      this.queueNotice(parent.id, `terminal-input:${id}`, `the user typed in the terminal of card ${id} (${task.title}) at ${localTime(at)}. Before you type there, read it: `
        + `node ~/.entomatical/board.js screen ${id}. If he is working in it, leave it until the card is idle or done; to type over his input anyway, add --override to board.js type.`);
      this.deliverNotices(parent.id);
    }
  }

  /** `board.js screen` (F89): the card terminal's text; the parent has now seen what the user typed so far. */
  terminalScreen(by: Task, target: Task, lines = 60) {
    const shot = this.cardTerminals.screen(target.id, lines);
    if (!shot) return undefined;
    this.terminalSeen.set(`${by.id}:${target.id}`, Date.now());
    const user = this.terminalUser.get(target.id);
    return { ...shot, live: shot.state === "running", userInputAt: user ? new Date(user).toISOString() : null };
  }

  /**
   * `board.js type` (F89): keys first (Escape, Ctrl+C …), then text, then Enter, with short gaps so a lone Escape is not read as Alt.
   * Refused while the user has typed there since this parent last read the screen, unless override.
   */
  async terminalType(by: Task, target: Task, o: { text?: string; keys?: string[]; enter?: boolean; override?: boolean }): Promise<string | undefined> {
    if (!this.cardTerminals.has(target.id)) return `Card ${target.id} has no live card terminal; start or resume it first`;
    const user = this.terminalUser.get(target.id) ?? 0, seen = this.terminalSeen.get(`${by.id}:${target.id}`) ?? 0;
    if (user > seen && !o.override) return `the user typed in this card's terminal at ${localTime(user)}, after you last read it. Read it with board.js screen ${target.id}, then decide: leave it until the card is idle or done, or type again (--override types over his input without reading)`;
    for (const key of o.keys ?? []) { this.cardTerminals.write(target.id, TERMINAL_KEYS[key]); await sleep(150); }
    if (o.text) { this.cardTerminals.write(target.id, o.text.includes("\n") ? `\u001b[200~${o.text}\u001b[201~` : o.text); await sleep(o.enter ? 200 : 0); }
    if (o.enter) { this.cardTerminals.write(target.id, "\r"); this.turnTyped(target); }
    this.update(target, { terminalInput: { by: by.id, at: new Date().toISOString() } });
    return undefined;
  }

  /** The task's terminal while its process still runs (an exited one can linger on screen). */
  terminal(task: Task): vscode.Terminal | undefined {
    const own = this.terminals.get(task.id);
    if (own && !own.exitStatus) return own;
    return vscode.window.terminals.find(t => {
      if (t.exitStatus) return false;
      if (task.provider || !task.headless || task.takenOver) return isCardTerminal(t.name, task);
      // An editor-owned hidden Claude terminal can survive its Board. Bind it to the saved conversation.
      const env = (t.creationOptions as vscode.TerminalOptions | undefined)?.env;
      return !!task.sessionId && env?.ENTOMATICAL_TASK === task.id && env.ENTOMATICAL_SESSION === task.sessionId
        && !!env.ENTOMATICAL_REPO && path.relative(this.repo, env.ENTOMATICAL_REPO) === "" && env.ENTOMATICAL_RUNTIME === "claude";
    });
  }

  /** A terminal or background process this board started runs the task's session. */
  private ownProcess(t: Task): boolean {
    return !!this.terminal(t) || this.cardTerminals.has(t.id) || this.codexRuns.has(t.id) || this.codexPanelStarts.has(t.id) || this.codexPanelRuns.has(t.id);
  }

  /** The task's session runs in a process this board started or one a scan found outside it. */
  private hasProcess(t: Task): boolean {
    return this.ownProcess(t) || (!!t.sessionId && this.external.has(t.sessionId));
  }

  /** The task's account folder: "" for ~/.claude. Throws rather than fall back to another account. */
  configDirOf(task: Task): string {
    if (!task.account || task.provider) return ""; // the one Codex account is whichever ~/.codex holds; a signed-out Codex asks in its terminal
    const claude = this.accountList().filter((a) => !a.provider);
    // The name is the folder's email, plus " (folder)" while two folders hold the same email. Logging a folder into another email
    // adds or drops that suffix, so a card's saved name goes stale: "alternate@example.com" once ~/.claude and organization both held it.
    const [, email, label] = /^(.*?)(?: \(([^()]*)\))?$/.exec(task.account)!;
    const labelled = (dir: string) => label !== undefined && (label === "~/.claude" ? sameFolder(dir, "") : path.basename(dir).toLowerCase() === label.toLowerCase());
    const plain = (name: string) => name.replace(/ \([^()]*\)$/, "").toLowerCase();
    const account = claude.find((a) => a.name.toLowerCase() === task.account!.toLowerCase()) // older cards may hold mixed case
      ?? (task.configDir !== undefined ? claude.find((a) => sameFolder(a.configDir ?? "", task.configDir!)) : undefined)
      ?? claude.find((a) => labelled(a.configDir ?? ""))
      ?? claude.find((a) => plain(a.name) === email.toLowerCase()); // the same login in another folder
    if (account) return account.configDir ?? "";
    // No Claude account listed at all: the first login check after a restart has not finished, or every check failed (the CLI slow
    // to start right after boot). That is no sign-out, so the card's own folder is used; a signed-out CLI asks in its terminal.
    if (!claude.length) {
      const folder = this.accountFolderList().find((d) => (task.configDir !== undefined && sameFolder(d, task.configDir)) || labelled(d));
      if (folder !== undefined) return folder;
      throw new Error(`Entomatical is still checking which accounts are signed in. Try again in a moment.`);
    }
    throw new Error(`Account ${task.account} is not available. Is it still logged in? Use More → Switch account to move this task to a signed-in account.`);
  }

  /** The signed-in accounts (Claude folders, then Codex). Tests replace it. */
  accountList: () => Account[] = accounts;
  /** Every Claude account folder, signed in or not ("" = ~/.claude). Tests replace it. */
  accountFolderList: () => string[] = accountFolders;

  /** Prompts to send instead of task.prompt on the next start: a task moved to another provider continues its earlier work. */
  private readonly continuations = new Map<string, string>();
  /** Current oversight and boundaries accompany a resumed turn without repeating its task or consuming its inbox. */
  private runContext(task: Task): string {
    const root = masterOf(task, this.tasks);
    const identity = `Your Entomatical card is ${task.id} (${task.title}); runtime: ${task.provider ?? "claude"}; permissions: ${task.role === "judge" || task.role === "research" ? "read-only role" : task.permission ?? "account default"}.${task.openedBy ? ` Parent card: ${task.openedBy}. Root orchestrator: ${root?.id ?? task.openedBy}.` : task.orchestrator ? ` Root orchestrator: ${task.id}.` : ""}`;
    const policy = root?.runPolicy ?? task.runPolicy;
    const boundaries = policy ? `Run instructions: allowed: ${policy.allow.join(", ") || "as specified in the task"}; denied: ${policy.deny.join(", ") || "none additionally specified"}. External sync hook opt-out: ${policy.noSync ? "on" : "off"}.` : "";
    const delegation = task.orchestrator?.root ? `You are a sub-orchestrator. Root ${root?.id ?? task.orchestrator.root}'s ${root?.approved ? "approved plan covers your scoped work and descendants; do not wait for a separate approval" : "plan still requires approval before you delegate"}.` : "";
    return [identity, boundaries, delegation, this.governedContext(task)].filter(Boolean).join("\n\n");
  }
  /** Phase 3: the governed facts a card needs, role by role: the root its brief cursor, a coordinator its allowance, a worker its assignment's return contract. */
  private governedContext(task: Task): string {
    const gov = governedRootOf(task, this.tasks);
    if (!gov?.root) return "";
    if (task.council) return `Governed run ${gov.root.id}: you are council member ${task.council.member} (checkpoint ${task.council.checkpoint}, round ${task.council.round}). Review read-only: do not modify files, commit, run board.js, open cards or delegate. Your judgment counts only if your worktree is unchanged.`;
    const g = gov.root.governed!, a = allowanceOf(task);
    const lines = [`Governed run ${gov.root.id}: at most ${g.limits.active} sessions run at once (root, coordinators, workers, judges); your lease is released when your session ends, so end your turn while you wait for children. Target effects (Finish, Merge, delivery, finish self) are blocked; integrate submissions into your own branch.`];
    if (a) lines.push(`You may delegate: ${a.allowed.join(", ")}${a.defaultChild ? ` (default ${a.defaultChild})` : " (no default: name --profile)"}; ${a.depth - 1 >= 1 ? `a coordinator you open may delegate ${a.depth - 1} more level${a.depth - 1 === 1 ? "" : "s"}` : "open workers only"}. Every add needs --assignment-file {key, outcome, owns?, acceptance?, evidence?, returns?}. Accept a child (board.js done) only after its submission; the board checks it is still its HEAD. Project state: board.js overview --since <seq> (compact; full evidence by reference).`);
    if (task.assignment) lines.push(`Your assignment ${task.assignment.key}: ${task.assignment.outcome}${task.assignment.owns?.length ? ` Owns: ${task.assignment.owns.join(", ")}.` : ""}${task.assignment.acceptance?.length ? ` Acceptance: ${task.assignment.acceptance.join(", ")}.` : ""}${task.assignment.evidence?.length ? ` Evidence: ${task.assignment.evidence.join("; ")}.` : ""} When done: commit, then board.js submit --head <commit> --summary-file F [--files a,b] [--check "..."] [--covers A-01] [--limitations T] [--decision T]${task.assignment.returns ? `. Return: ${task.assignment.returns}` : ""}.`);
    return lines.join("\n");
  }
  /** The first prompt the next start sends. */
  promptFor(task: Task): string {
    this.loadNotifications();
    const linkedContext = (this.startContext.get(task.id) ?? "") + (this.noteStartContext.get(task.id) ?? "");
    if (!task.orchestrator && !task.openedBy && !this.pendingNotices.get(task.id)?.size) {
      return (this.continuations.get(task.id) ?? (task.continued ? `${task.prompt}\n\n${CONTINUE_NOTE}` : task.prompt)) + linkedContext;
    }
    const live = new Set(this.live());
    const related = task.orchestrator || task.openedBy ? this.tasks.filter((t) => t.id !== task.id && live.has(t.id)).slice(0, 20) : [];
    const sessions = related.length ? `Live board cards (use board.js list --live for current details):\n${related.map((t) => `- ${t.id}: ${t.title}; ${t.provider ?? "claude"}; ${t.account ?? "default account"}`).join("\n")}` : "";
    let delegation = "";
    if (task.orchestrator?.root) {
      let brief = "";
      try { brief = fs.readFileSync(this.briefPath, "utf8").trim(); } catch { /* the essential protocol remains inline */ }
      delegation = task.role === "sub" ? `Supervise only your assigned cards. Do not open another coordinator. Receive or wait for their notices and call board.js ready only after they are Done or cancelled.\n${brief}` : `Use board.js add --may-open for another coordinator within the root caps, and board.js add for workers. Track every card, receive or wait for messages, and call board.js ready after verifying the delegated work.\n${brief}`;
    }
    const pending = this.pendingNotices.get(task.id);
    if (pending?.size) this.promptMessages.set(task.id, new Map(pending));
    return [this.runContext(task), delegation, sessions, this.continuations.get(task.id) ?? (task.continued ? `${task.prompt}\n\n${CONTINUE_NOTE}` : task.prompt),
      linkedContext, pending?.size ? `Pending board messages:\n${[...pending.values()].join("\n\n")}` : ""].filter(Boolean).join("\n\n");
  }
  private readonly promptMessages = new Map<string, Map<string, string>>();
  /** Text added to a task's first prompt, read just before it starts (linked context, set by beforeStart). */
  readonly startContext = new Map<string, string>();
  /** The linked Obsidian note stays available if the user removes the card's Asana link during Start. */
  readonly noteStartContext = new Map<string, string>();
  /** Runs before a session starts; integrations read linked context into startContext here. Must not throw. */
  beforeStart: (task: Task) => Promise<void> = async () => undefined;
  /** The session's last answer in full (from its Stop hook), else the card's reply line. */
  finalReply(task: Task): string | undefined {
    const events = this.events(task.id);
    if (task.provider === "grok" || task.provider === "antigravity") {
      const last = events.findLast((e) => e.hook_event_name === "UserPromptSubmit" || e.hook_event_name === "Stop");
      if (last?.hook_event_name !== "Stop") return undefined;
    }
    const stop = events.findLast((e) => e.hook_event_name === "Stop" && typeof e.last_assistant_message === "string");
    return stop ? (stop.last_assistant_message as string).trim() : this.lastReply(task);
  }
  private sentPrompt(task: Task) {
    // Kept until the session comes up: a card reset before that (resetUnstarted) must start again with the same continuation prompt.
    const continuation = this.continuations.get(task.id);
    if (continuation !== undefined) this.unconfirmed.set(task.id, continuation);
    this.continuations.delete(task.id);
    const sent = this.promptMessages.get(task.id);
    if (sent) { this.acknowledgeMessages(task.id, sent); this.promptMessages.delete(task.id); }
  }
  /** Continuation prompts already sent to a session that has not reported SessionStart yet. */
  private readonly unconfirmed = new Map<string, string>();

  /** Tasks whose session runs in a terminal or background process this board started (follow-up and stop work on these). */
  own(): string[] {
    return this.tasks.filter((t) => this.ownProcess(t)).map((t) => t.id);
  }

  /** Codex tasks on their first turn in the background: nothing to open or follow up until it ends (Stop still works). */
  firstTurn(): string[] {
    return this.tasks.filter((t) => t.provider === "codex" && (this.codexRuns.has(t.id) || this.codexPanelStarts.has(t.id) || this.codexPanelRuns.has(t.id))).map((t) => t.id);
  }

  /** Direct panel starts can be opened during their first turn, unlike the background fallback. */
  panelFirstTurn(): string[] {
    return this.tasks.filter((t) => t.codexPanelBridge && (this.codexPanelStarts.has(t.id) || this.codexPanelRuns.has(t.id))).map((t) => t.id);
  }

  /** Tasks with a running session, wherever it runs. A Codex task in Codex's editor counts while its rollout shows a turn under way. */
  live(): string[] {
    return this.tasks.filter((t) => this.hasProcess(t) || ["running", "needs-input"].includes(this.codexEditorStatus(t) ?? "")).map((t) => t.id);
  }

  /**
   * Whether the task's session ever came up, so there is a conversation to resume: found running, opened in a panel, it reported
   * SessionStart, or (Claude) its saved transcript exists. The last covers sessions whose hooks never reached the board, for example
   * cards started while their hooks file named a deleted extension folder: a real conversation must never be dropped as unstarted.
   */
  everReady(task: Task): boolean {
    return !!task.adopted || !!task.panel || !!task.codexPanelBridge || !!task.codexEditorPolicy || this.events(task.id).some((e) => e.hook_event_name === "SessionStart")
      || (!task.provider && !!task.sessionId && !!this.savedConversation(task));
  }

  /**
   * A card gets its session id before its CLI starts (a Codex card a made-up one, until Codex reports its thread). When that session
   * never came up (its terminal was closed during first-run onboarding, sign-in or folder trust, the launch failed, or the ready wait
   * ran out and it is closed now), there is nothing to resume: drop the id so the card starts again and sends its prompt. True when it did.
   */
  resetUnstarted(task: Task): boolean {
    if (!task.sessionId || this.everReady(task) || this.terminal(task) || this.codexRuns.has(task.id) || this.codexPanelStarts.has(task.id) || this.codexPanelRuns.has(task.id) || this.external.has(task.sessionId)) return false;
    if (!task.provider && task.headless && this.hasNamedTerminal(task)) return false; // wait for the editor to restore the terminal's identity
    if (task.codexEditor && !this.canReopenCodexEditor(task)) return false; // Resume must verify this id before migrating the editor to a terminal
    const continuation = this.unconfirmed.get(task.id);
    if (continuation !== undefined && !this.continuations.has(task.id)) this.continuations.set(task.id, continuation); // a moved task restarts with its note
    this.unconfirmed.delete(task.id);
    this.update(task, { sessionId: undefined, ...(task.provider ? { codexEditor: undefined, codexEditorPolicy: undefined, codexPanelBridge: undefined } : {}) });
    return true;
  }

  private writeHooks(task: Task) {
    const q = (p: string) => `"${p.replace(/\\/g, "/")}"`;
    // Windows: exec form, node.exe started directly (hookNode); elsewhere, or with no node.exe on PATH, the shell form `node "script" "arg"`.
    const node = hookNode();
    const run = (script: string, ...rest: string[]): { type: "command"; command: string; args?: string[] } => node
      ? { type: "command", command: node, args: [script, ...rest] }
      : { type: "command", command: ["node", ...[script, ...rest].map(q)].join(" ") };
    const hooks = [run(this.hookScript, this.eventsFile(task.id))];
    const statusline = path.join(path.dirname(this.hookScript), "statusline.js");
    const beside = (name: string, ...rest: string[]) => [run(path.join(path.dirname(this.hookScript), name), ...rest)];
    // F98: plan files written in a turn are listed here (PostToolUse) and committed once at its Stop.
    const planCommit = beside("plan-folder.js", this.hooksFile(task.id).replace(/\.json$/, ".plan-pending"));
    const settings = {
      // The card's id and repo for board.js (spec 5.4): the settings file reaches every Claude launch path (probe row 8, 4 Nov 2026).
      // PYTHONUTF8: Windows Python otherwise writes and reads cp1252 and fails on any other character (7 tracebacks, 4-6 Nov 2026).
      // Here, not in ~/.claude/settings.json: card sessions run with CLAUDE_CONFIG_DIR set to their account's own folder.
      env: { ...this.taskEnv(task), PYTHONUTF8: "1" },
      // Undefined keys drop out of the JSON, so an unset choice leaves the account's own default.
      // F99 (17 November 2026): Claude Code is handed the full id, never the alias (models.ts CLAUDE_MODEL_IDS); the card keeps its short name.
      model: task.provider ? task.model : claudeModelId(this.fableBlocked(task) ? "opus" : task.model),
      effortLevel: task.effort,
      // Plan first (F78) holds for the first turn only, ahead of the permission pick; syncStatus takes it out after that turn.
      permissions: (task.role === "judge" || task.role === "research") && !task.provider ? { defaultMode: "plan" }
        : task.planFirst && !task.headless && !task.provider ? { defaultMode: "plan" }
        : task.permission && PERMISSIONS[task.permission] ? headlessPermissions(PERMISSIONS[task.permission], !!task.headless && !task.provider)
        // Orchestrator sessions default to bypass; an explicitly selected permission mode wins.
        : task.headless ? { defaultMode: "bypassPermissions" } : undefined,
      // Strict-route probe: no plugin loads (its hooks, agents, skills and servers), per process; strict-claude.ts.
      enabledPlugins: (() => { const r = this.strictRecipe(task); return r && typeof r !== "string" ? r.enabledPlugins : undefined; })(),
      // Shell form only: Claude Code documents no exec form (args) for the status line (code.claude.com/docs/en/statusline, 25 Nov 2026).
      statusLine: { type: "command", command: `node ${q(statusline)} ${usageKey(this.configDirOf(task))} ${q(path.join(this.dir, "metrics", `${task.id}.context.json`))}` },
      hooks: {
        SessionStart: [{ hooks }],
        UserPromptSubmit: [{ hooks }],
        // F98: a plan file written or edited in the main checkout's workflows/ is committed there when the turn ends (Stop).
        PostToolUse: [{ matcher: "*", hooks }, { matcher: "Write|Edit|MultiEdit", hooks: planCommit }],
        PermissionRequest: [{ matcher: "*", hooks }],
        Notification: [{ matcher: "permission_prompt", hooks }],
        Stop: [{ hooks }, { hooks: planCommit }],
        StopFailure: [{ hooks }],
        // F96: ab-* sub-agents: brief, gate the reply, fence Bash; hook.js stays first.
        SubagentStart: [{ hooks }, { matcher: "^ab-", hooks: [{ ...beside("subagent-brief.js")[0], timeout: 30 }] }],
        SubagentStop: [{ hooks }, { matcher: "^ab-", hooks: beside("receipt-gate.js") }],
        // F98: a new plan file goes to the main checkout's workflows/, where Run a plan… lists it.
        PreToolUse: [{ matcher: "Bash|PowerShell", hooks: beside("agent-fence.js") },
          { matcher: "Write", hooks: beside("plan-folder.js") }],
      },
    };
    const text = JSON.stringify(settings, null, 2);
    const file = this.hooksFile(task.id);
    try { if (fs.readFileSync(file, "utf8") === text) return; } catch { /* not written yet */ }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }

  private launch(task: Task, resume: boolean, prompt?: string, launchId?: string): vscode.Terminal {
    if (this.terminal(task)) throw new Error("The session is already running. Stop it first.");
    if (task.sessionId && this.external.has(task.sessionId)) throw new Error("This session is still running elsewhere. Close it there first.");
    const configDir = this.configDirOf(task);
    const codex = task.provider === "codex";
    if (!codex) this.writeHooks(task);
    // A session that never reported SessionStart has no conversation to resume yet, so it starts under its id instead.
    const resumable = resume && this.everReady(task);
    // F118: `claude --resume` reads the project folder named after this cwd. After the workspace folder was renamed or moved the
    // conversation sits under the old name's folder, so it is linked into this one first, as the panel's Open does.
    if (resumable && !task.provider) try { this.locateTranscript(task, configDir || DEFAULT_DIR); } catch { /* saved nowhere: the CLI reports it */ }
    // Codex's hook finds the task's events file in ENTOMATICAL_EVENTS; in WSL mode, wsl.exe runs it and WSLENV carries that path across.
    const taskEnv = { ...this.taskEnv(task), ...(launchId ? { ENTOMATICAL_TERMINAL_LAUNCH: launchId } : {}) };
    const run = codex ? codexCommand(this.codexArgsFor(task, resume, prompt), task.worktree, { ...process.env, ...taskEnv }) : undefined;
    // Strict-route probe: the selected MCP servers' definitions go in their own file, named by the recipe's --mcp-config.
    const strict = codex ? undefined : this.writeStrict(task);
    const claudeArgs = [resumable ? "--resume" : "--session-id", task.sessionId!, "--settings", this.hooksFile(task.id), ...(strict?.args ?? []), ...(!resumable && task.named ? ["--name", task.title] : []), ...(prompt ? ["--", prompt] : [])];
    // Card terminal (F89): the same command and environment in a PTY shown on the card; it stands in for the VS Code terminal below.
    const term = task.cardTerminal ? this.cardSession(task, run ? run.file : claudeBinary(), run ? run.args : claudeArgs, run ? { ...run.env } : (() => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const k of Object.keys(env)) if (k.toUpperCase() === "CLAUDE_CONFIG_DIR") delete env[k];
      return { ...env, ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}), ...taskEnv };
    })()) : vscode.window.createTerminal({
      name: terminalName(task),
      shellPath: run ? run.file : "claude",
      // --name only on the first start: the CLI saves it as the session's title, and a resume keeps any later rename.
      shellArgs: run ? run.args : claudeArgs,
      cwd: task.worktree,
      // null removes an inherited value for ~/.claude.
      env: {
        ...taskEnv,
        ...(run ? (run.env.WSLENV !== undefined ? { WSLENV: run.env.WSLENV } : {}) : { CLAUDE_CONFIG_DIR: configDir || null }),
        TERM: "xterm-256color", COLORTERM: "truecolor", NO_COLOR: null, FORCE_COLOR: "3",
      },
      iconPath: new vscode.ThemeIcon("robot"),
      ...(this.sessionsInEditor() ? { location: { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true } } : {}),
    });
    this.terminals.set(task.id, term);
    if (codex && !resume) this.sentPrompt(task); // the terminal accepted the startup prompt
    // Codex's SessionStart on a resume is not known to come before the first prompt, so only its first start is watched.
    if (!codex || !resume) this.watchStart(task, term);
    this.changed.fire();
    return term;
  }

  /** A Claude or Codex session in its card's terminal (F89), as a stand-in for vscode.Terminal. */
  private cardSession(task: Task, file: string, args: string[], env: NodeJS.ProcessEnv): vscode.Terminal {
    const started = this.cardTerminals.spawnCommand({ id: task.id, file, args, cwd: task.worktree!, env });
    const id = task.id;
    const term = new CardSessionTerminal(terminalName(task), id, started.generation, started.pid, this.cardTerminals, (focus) => this.cardFocus.fire({ id, focus }));
    const terminal = term as unknown as vscode.Terminal;
    const sub = this.cardTerminals.onState(state => {
      if (state.generation !== term.generation || state.state !== "exited") return;
      sub.dispose();
      term.exitStatus = { code: state.exitCode, reason: 0 };
      if (this.terminals.get(id) === terminal) this.terminalClosed(terminal);
    });
    return terminal;
  }

  private forgetCardTerminal(id: string) {
    // Release card-scoped resources before its ID can be reused. The old handle gets its exitStatus on PTY exit.
    if (this.terminals.get(id) instanceof CardSessionTerminal) {
      this.terminals.delete(id);
      fs.rmSync(this.strictMcpFile(id), { force: true });
    }
    this.cardTerminals.forget(id);
  }

  /** Task identity for hooks and board.js; ACP keeps a stable controller across provider conversations. */
  private taskEnv(task: Task): Record<string, string> {
    const acp = task.provider === "grok" || task.provider === "antigravity";
    if (acp && !task.boardSessionId) this.update(task, { boardSessionId: crypto.randomUUID() });
    const session = acp ? task.boardSessionId : task.sessionId;
    return { ...tempEnv(this.cardTemp(task), tempRoot(this.repo)),
      ENTOMATICAL_EVENTS: this.eventsFile(task.id), ENTOMATICAL_TASK: task.id, ENTOMATICAL_REPO: this.repo, ENTOMATICAL_RUNTIME: task.provider ?? "claude",
      ...(session ? { ENTOMATICAL_SESSION: session } : {}),
      ...(task.openedBy ? { ENTOMATICAL_PARENT: task.openedBy, ENTOMATICAL_ROOT: masterOf(task, this.tasks)?.id ?? task.openedBy,
        ENTOMATICAL_NO_SYNC: task.runPolicy?.noSync === false ? "0" : "1" } : {}) };
  }

  /** When the board last opened each task's terminal, and how many events the task had then (see waitingToStart). */
  private readonly launched = new Map<string, { at: number; before: number }>();
  /** How long a terminal session may go without SessionStart before the board says it waits on a prompt. Tests shorten it. */
  startNudgeMs = 20_000;
  private readonly nudges = new Set<NodeJS.Timeout>();

  /**
   * A new session can wait in its terminal before it starts: the CLI's first-run setup (theme picker), sign-in, or folder trust
   * (Codex: "trust this directory"). The terminal opens without focus, so after startNudgeMs with no SessionStart a warning offers
   * to show it with focus, and the card says so (waitingToStart).
   */
  private watchStart(task: Task, term: vscode.Terminal) {
    this.launched.set(task.id, { at: Date.now(), before: this.events(task.id).length });
    if (task.sessionId) this.update(task, { terminalLaunch: { sessionId: task.sessionId }, launchError: undefined, startRetryAt: undefined });
    const timer = setTimeout(async () => {
      this.nudges.delete(timer);
      // The timer has elapsed even if the wall clock reads slightly earlier than launch.at + startNudgeMs.
      if (this.terminals.get(task.id) !== term || term.exitStatus || !task.sessionId || this.sessionStartedSinceLaunch(task)) return;
      this.changed.fire(); // the card's line appears now, though nothing else changed
      const who = task.provider === "codex" ? "Codex" : "Claude";
      if (task.headless) this.update(task, { status: "needs-input" });
      const pick = await vscode.window.showWarningMessage(`Entomatical: "${task.title}" is waiting for ${who} to start. Answer the prompt in its terminal (first-run setup, sign-in or folder trust).`, "Show terminal");
      if (pick === "Show terminal" && !term.exitStatus) term.show(false);
    }, this.startNudgeMs);
    timer.unref?.();
    this.nudges.add(timer);
  }

  /** The task's terminal is open but its session has not reported SessionStart startNudgeMs after the board opened it. */
  waitingToStart(task: Task): boolean {
    if (!task.sessionId || !this.terminal(task)) return false;
    const launch = this.launched.get(task.id); // unset after a window reload: the card's last change stands in
    if (Date.now() - (launch?.at ?? Date.parse(task.updatedAt)) < this.startNudgeMs) return false;
    return !this.sessionStartedSinceLaunch(task);
  }

  private sessionStartedSinceLaunch(task: Task): boolean {
    const before = this.launched.get(task.id)?.before ?? 0;
    return this.events(task.id).slice(before).some((e) => e.hook_event_name === "SessionStart");
  }

  /** Codex's thread id reaches the card with its SessionStart hook (syncStatus). Before that, resume takes the worktree's newest session. */
  private codexArgsFor(task: Task, resume: boolean, continuation?: string) {
    if (resume) checkResumable(task.transcript); // a WSL session cannot resume on Windows Codex (8 November 2026)
    const thread = confirmedCodexThread(task) ?? (this.events(task.id).some((e) => e.hook_event_name === "SessionStart") ? task.sessionId : undefined);
    const prompt = this.promptFor(task), model = this.codexSend(task, resume); // a refusal leaves the prompt unsent
    const editorDefaults = !!task.codexEditor || (!!task.sessionId && task.codexEditorPolicy?.threadId === task.sessionId);
    return codexArgs({ model, effort: task.effort, permission: task.permission, role: task.role, editorDefaults, ...(resume ? { resume: thread ?? "", prompt: continuation } : { prompt }) });
  }

  /**
   * Codex skips hooks the user has not approved, and without them a card never moves. In a repo it has not trusted, it first opens on
   * its own "Trust this folder?" screen in the terminal, where the card waits unseen (and `codex exec` runs read-only by default).
   * Both approvals belong to the Codex folder and survive restarts and updates, so this asks once, in one dialog when both are
   * needed, then has Codex record them exactly as its own /hooks and trust screens would. A Codex that cannot report folder trust
   * (no `config/read`) leaves the folder to its own screen.
   */
  async ensureCodexTrust(task: Task) {
    const pending = await pendingApprovals(task.worktree ?? this.repo);
    // A worktree of a repo already trusted (Codex in WSL asks about each one) is recorded without asking again.
    const hooks = pending.hooks.length > 0, folder = pending.inherited ? undefined : pending.folder;
    if (!hooks && !folder) { if (pending.inherited) await approveCodex(pending); return; }
    const hookText = "Codex runs only hooks you have approved. Entomatical's hook records each session event (start, prompt, tool use, approval request, finish) in this board's .entomatical folder, which is how Codex cards move between columns and Resume finds the session. Approving adds hooks.state entries to Codex's config.toml, the same as approving them in Codex's /hooks screen. Other unapproved hooks stay off.";
    const folderText = folder && `${pending.markedUntrusted ? "Codex has this repo marked untrusted. " : ""}Codex stops on its own "Trust this folder?" screen before working in a repo it has not trusted, and the card waits there until you answer it in the terminal. Trusting ${folder} lets Codex read, edit and run files there under your own Codex permission settings, and loads the repo's own Codex settings; with Codex's default settings an untrusted repo runs read-only. Approving sets projects."${toCodexPath(folder)}".trust_level = "trusted" in Codex's config.toml, the same as choosing "Trust and continue" in Codex.${pending.worktree ? ` Codex in WSL asks about each task folder of the repo on its own, so this card's folder (${toCodexPath(pending.worktree)}) is trusted with it, and later task folders without asking again.` : ""}`;
    const [title, detail, refused] = !folder ? ["Let Codex run Entomatical's status hook?", `${hookText} You are asked once.`, "the Codex status hook was not approved"]
      : !hooks ? ["Let Codex trust this repo?", `${folderText} You are asked once per repo.`, `Codex was not allowed to trust ${folder}`]
      : ["Let Codex trust this repo and run Entomatical's status hook?", `${folderText}\n\n${hookText} You are asked once per repo.`, "Codex's folder trust and status hook were not approved"];
    const ok = await vscode.window.showWarningMessage(title, { modal: true, detail }, "Approve");
    if (ok !== "Approve") throw new Error(`Not started: ${refused}.`);
    await approveCodex(pending);
  }

  /** The worktree being made for each card: two `worktree add`s of one branch at once undo each other, so a second call waits on the first. */
  private worktreeRuns = new Map<string, Promise<void>>();
  private removingRefusedWorktrees = new Map<string, Promise<void>>();

  async ensureWorktree(task: Task, purpose: "use" | "launch" | "parent" = "use"): Promise<void> {
    const removal = this.removingRefusedWorktrees.get(task.id);
    if (removal) await removal;
    if (task.worktree && purpose === "use") this.keepWorktree(task);
    let run = this.worktreeRuns.get(task.id);
    if (!run) {
      run = this.makeWorktree(task, purpose === "parent").finally(() => this.worktreeRuns.delete(task.id));
      this.worktreeRuns.set(task.id, run);
    }
    return run;
  }

  private async makeWorktree(task: Task, forChild: boolean) {
    if (!task.worktree) {
      this.mustOwn(); // before git makes anything the card could not record
      // Inside the repo (gitignored), like Claude Code's own .claude/worktrees.
      const root = path.join(this.dir, "wt");
      let worktree = path.join(root, task.id);
      const branch = `task/${task.id}`;
      const parent = this.get(task.parentId);
      // A parent not started yet gets its worktree and branch now, so the subtask branches from the parent's branch rather than HEAD.
      // A finished parent's branch is gone (merged or thrown away), so HEAD is right then.
      if (parent && (!parent.worktree || this.removingRefusedWorktrees.has(parent.id)) && parent.status !== "done") await this.ensureWorktree(parent, "parent");
      const base = parent?.branch ?? "HEAD";
      fs.mkdirSync(root, { recursive: true });
      // An entry for this folder deleted by hand would refuse the add. Only this one: a global prune also drops the user's own unmounted worktrees.
      if (!fs.existsSync(worktree)) await git(this.repo, ["worktree", "remove", "--force", worktree]).catch(() => undefined); // not listed: nothing to do
      // The branch can exist already: an earlier version made it, then could not record it (another window owned the board, or its
      // checkout failed), and `worktree add -b` would fail on every Start. Its worktree is reused, or made again for the branch.
      const existing = await this.worktreeOf(branch);
      const newBranch = !existing && !(await git(this.repo, ["branch", "--list", branch]));
      if (existing) worktree = existing;
      else {
        const warning = await addWorktree(this.repo, worktree, branch, base);
        if (warning) void vscode.window.showWarningMessage(`Entomatical: ${warning}`);
      }
      this.worktreeAllocations.set(task, { card: task, worktree, branch, state: newBranch ? "new" : "preexisting" });
      if (forChild) {
        // Provisioning a branch for someone else's launch is not activity on this card.
        Object.assign(task, { worktree, branch });
        this.save();
      } else this.update(task, { worktree, branch });
    }
  }
  /** Checkout identity distinguishes a preexisting branch and fences retries against a later checkout at the same path. */
  private worktreeAllocations = new WeakMap<Task, WorktreeAllocation>();

  private keepWorktree(task: Task) {
    const allocation = this.worktreeAllocations.get(task);
    if (allocation && allocation.state !== "preexisting") allocation.state = "kept";
  }
  /**
   * ensureWorktree for a start, returning how to undo it (F92, 17 November 2026: a start refused for its model changes nothing on the
   * card). The undo removes only the worktree and branch this call made (the card's, and an unstarted parent's made for it), never one
   * that existed, and never a parent's that another card has branched from since. A removal that fails is logged: the refusal stands.
   */
  private async ensureWorktreeUndoable(task: Task): Promise<() => Promise<void>> {
    const parent = this.get(task.parentId);
    const removingParent = parent && this.removingRefusedWorktrees.get(parent.id);
    if (removingParent) await removingParent;
    const missing = task.worktree ? [] : [task, parent].filter((t): t is Task => !!t && !t.worktree);
    for (const t of missing) this.worktreeAllocations.delete(t);
    await this.ensureWorktree(task, "launch");
    const made = missing.flatMap((t) => {
      const allocation = this.worktreeAllocations.get(t);
      if (allocation?.state !== "new") return [];
      allocation.state = "rollback";
      return [allocation];
    });
    const checkout = this.worktreeAllocations.get(task);
    // Reattaching the child's old branch did not use a parent branch made for this start.
    const independent = checkout?.state === "preexisting" ? checkout : undefined;
    return () => this.rollbackRefusedWorktrees(task, made, independent);
  }
  /**
   * Removes the worktree and branch a refused start made (ensureWorktreeUndoable) while the card still records exactly those and has not
   * started since. A busy folder or another launch under way defers cleanup. A checkout reused by an accepted launch is kept.
   */
  private async removeRefusedWorktree(t: Task, task: Task, made: WorktreeAllocation, later = false, independent?: WorktreeAllocation): Promise<"removed" | "kept" | "held"> {
    if (this.worktreeAllocations.get(t) !== made || made.state !== "rollback" || this.get(t.id) !== t || t.worktree !== made.worktree || t.branch !== made.branch) return "kept";
    if (!this.isOwner()) return "kept";
    if ((later || t !== task) && (this.isLaunching(t) || this.worktreeRuns.has(t.id))) return "held";
    if (t.sessionId || t.cardTerminalStarted || t.panelPending) return "kept";
    const children = this.tasks.filter((c) => c.parentId === t.id && !(independent?.card === c && this.worktreeAllocations.get(c) === independent
      && c.worktree === independent.worktree && c.branch === independent.branch));
    if (children.some((c) => this.worktreeRuns.has(c.id) || ((later || c !== task) && this.isLaunching(c)))) return "held";
    if (children.some((c) => c.worktree || c.branch || c.sessionId)) return "kept";
    if (this.worktreeHeld(made.worktree)) return "held";
    const removal = this.discardRefusedWorktree(t, task, made);
    this.removingRefusedWorktrees.set(t.id, removal);
    try { await removal; } finally { this.removingRefusedWorktrees.delete(t.id); }
    return "removed";
  }

  private async discardRefusedWorktree(t: Task, task: Task, made: WorktreeAllocation) {
    await discardWorktree(this.repo, made.worktree, made.branch, !!t.legacySpeechId).catch((e) => console.error(`Entomatical: could not remove the worktree of refused start ${t.id}`, e));
    // Once the branch is gone the card must not point at the folder (a folder Windows still held is left without its .git link: the
    // next Start says to delete it rather than run there). A branch git kept keeps the card's record of it.
    const branch = await git(this.repo, ["branch", "--list", made.branch]).catch(() => made.branch);
    if (branch || this.get(t.id) !== t || this.worktreeAllocations.get(t) !== made || t.worktree !== made.worktree || t.branch !== made.branch) return;
    this.worktreeAllocations.delete(t);
    if (t === task) this.update(t, { worktree: undefined, branch: undefined });
    else { Object.assign(t, { worktree: undefined, branch: undefined }); this.save(); }
  }
  /** How often, and for how long, a refused start's held worktree is tried again (live, 17 November 2026: agy let go within a minute). Tests shorten them. */
  heldRetryMs = 10_000;
  heldRetryForMs = 180_000;
  private heldRetries = new Set<NodeJS.Timeout>();
  private async rollbackRefusedWorktrees(task: Task, made: WorktreeAllocation[], independent?: WorktreeAllocation, until?: number): Promise<void> {
    // A held child's checkout can still be reused. Remove it before considering its parent, including on retries.
    while (made.length) {
      const allocation = made[0];
      const result = await this.removeRefusedWorktree(allocation.card, task, allocation, until !== undefined, independent);
      if (result === "kept") {
        const card = this.get(allocation.card.id);
        // Delete can keep the child's checkout, while Discard can keep the card. Neither should strand the parent checkout.
        if (card && (card !== allocation.card || card.worktree || card.branch)) return;
      }
      if (result !== "held") { made.shift(); continue; }
      const deadline = until ?? Date.now() + this.heldRetryForMs;
      if (Date.now() >= deadline) { console.error(`Entomatical: the worktree of refused start ${allocation.card.id} stayed in use; kept`); return; }
      const timer = setTimeout(() => {
        this.heldRetries.delete(timer);
        void this.rollbackRefusedWorktrees(task, made, independent, deadline).catch(() => undefined);
      }, this.heldRetryMs);
      timer.unref?.();
      this.heldRetries.add(timer);
      return;
    }
  }
  /**
   * A folder some process still has open: on Windows such a folder cannot be renamed (elsewhere a held folder can be removed, and
   * this finds nothing). Tests replace it. The check renames the folder to its own name, which moves nothing: before 19 November 2026
   * it renamed it away and back, and a second rename that failed would have left a worktree under another name, on every Finish now
   * (M-02). Measured on Windows 11, node 26.7, that day: to itself fails as away does, EBUSY while a process has the folder as its
   * working folder and EPERM while one holds a file in it open, and succeeds once that process is gone.
   */
  worktreeHeld = (folder: string): boolean => {
    if (process.platform !== "win32" || !fs.existsSync(folder)) return false;
    try { fs.renameSync(folder, folder); return false; } catch { return true; }
  };
  /** The error is a refusal of the card's model (exact ids, 17 November 2026): nothing launched, so the start is undone. */
  private static modelRefusal(e: unknown): boolean { return !!(e as { modelRefused?: boolean } | undefined)?.modelRefused; }

  private static missingExecutable(e: unknown): boolean {
    const error = e as NodeJS.ErrnoException | undefined;
    return error?.code === "ENOENT" && error.syscall?.startsWith("spawn ") === true;
  }

  /** An older F92 timer may still own a checkout reused by this failed Start. Leave published work for explicit cleanup. */
  private keepMissingRunnerCheckout(task: Task) {
    if (this.get(task.id) !== task) return;
    for (const card of [task, ...ancestorsOf(task, this.tasks)]) {
      const allocation = this.worktreeAllocations.get(card);
      if (allocation?.state === "rollback") allocation.state = "kept";
    }
  }

  /** Linux procfs links can change meaning after the child changes cwd, even behind an ordinary symlink. */
  private static acpPathAbsent(candidate: string): boolean {
    if (fs.existsSync(candidate)) return false; // The executable may need a cwd-relative interpreter.
    if (process.platform !== "linux") return true;
    const pending = candidate.split("/").reverse();
    let dir = "/", links = 0;
    try {
      while (pending.length) {
        const part = pending.pop()!;
        if (!part || part === ".") continue;
        const next = path.join(dir, part);
        const stat = fs.lstatSync(next, { throwIfNoEntry: false });
        if (!stat) return true;
        if (stat.isSymbolicLink()) {
          // Check the link's containing filesystem before following it. realpath would hide a procfs link.
          if (fs.statfsSync(dir).type === 0x9fa0 /* PROC_SUPER_MAGIC */ || ++links > 40) return false;
          const target = fs.readlinkSync(next);
          if (target.includes("\uFFFD")) return false; // The link's bytes may not round-trip as a JS path.
          if (path.isAbsolute(target)) dir = "/";
          pending.push(...target.split("/").reverse());
        } else {
          dir = next;
        }
      }
    } catch { /* Leave uncertain lookups to spawn in the checkout. */ }
    return false;
  }

  /** Windows also searches the cwd for bare commands. */
  private static acpExecutableAbsent(file: string, env: NodeJS.ProcessEnv): boolean {
    if (path.isAbsolute(file)) return Board.acpPathAbsent(file);
    if (process.platform === "win32" || file.includes("/")) return false;
    return env.PATH?.split(path.delimiter).every(dir => path.isAbsolute(dir) && Board.acpPathAbsent(`${dir}/${file}`)) === true;
  }

  /**
   * The folder of one of Entomatical's worktrees that has `branch` checked out, if any. Not a locked one (git is still checking it out,
   * or was cut off partway, and its missing files would be committed as deletions), and not the main checkout or the user's own.
   */
  private async worktreeOf(branch: string): Promise<string | undefined> {
    // An entry whose folder was emptied has no .git link: a session there would work in the main checkout's tree.
    return (await worktrees(this.repo)).find((w) => w.lines.includes(`branch refs/heads/${branch}`) && !locked(w.lines) && inWorktreeRoot(this.repo, w.folder)
      && fs.existsSync(path.join(w.folder, ".git")))?.folder;
  }

  /** The worktree holds uncommitted or untracked changes, which removing it would throw away. */
  async hasUncommitted(task: Task): Promise<boolean> {
    return !!task.worktree && fs.existsSync(task.worktree) && !(await isClean(task.worktree)); // a deleted folder holds nothing, and git cannot run in it
  }

  /** How many of the parent's commits merging this subtask would also bring into the repo's current branch. */
  async parentCommits(task: Task): Promise<number> {
    const parent = this.get(task.parentId);
    if (!task.branch || !parent?.branch) return 0; // a finished parent's branch is gone: its work was merged already, or thrown away
    return sharedCommits(this.repo, task.branch, parent.branch);
  }

  /** The task's diff so far. */
  changes(task: Task) {
    if (!task.worktree || !task.branch) throw new Error("This task has no worktree.");
    if (!fs.existsSync(task.worktree)) throw new Error("The worktree folder is gone, so its changes cannot be shown. Merge still lands its commits; Discard drops them."); // else git fails with "spawn git ENOENT"
    return changes(this.repo, task.worktree, task.branch);
  }

  /** Merge the task's branch into the repo, or throw the worktree and branch away. Either way the card is done. */
  async finish(task: Task, how: "merge" | "discard", confirmed?: EffectConfirmation) {
    this.mustOwn(); // first: update() would refuse only after git had merged and deleted
    const verb = how === "merge" ? "Merge" : "Discard", by = this.completing.get(task.id);
    // CORE-DEL-3: one lock per card for Finish, Merge and Discard; nothing else may change the branch or worktree under the holder.
    if (by) throw new Error(`${by} is active on "${task.title}": ${verb} was refused. Nothing was changed.`);
    this.completing.set(task.id, verb); // no delivery starts while it works
    try { await this.deliveryIdle(); return await this.finishHeld(task, how, confirmed); } finally { this.completing.delete(task.id); }
  }
  private async finishHeld(task: Task, how: "merge" | "discard", confirmed?: EffectConfirmation) {
    if (how === "merge") {
      // Phase 4: a governed child's Merge integrates its exact submission into its opener's branch (never the target); a root has Finish.
      const gov = governedRootOf(task, this.tasks);
      if (confirmed || (gov && !task.governed)) {
        if (!confirmed) {
          const current = await this.readiness(task, "integrate");
          throw new Error(current.ok ? "Review the submission and destination in Integrate first." : readinessText(current));
        }
        const r = await this.integrate(task, "user", confirmed);
        if (r.error) throw new Error(String(r.error));
        return;
      }
      const why = gov ? `Merge is blocked: ${task.id} is the root of governed run ${gov.id}; Merge would put the run on the target without its readiness check. Finish (the user's) takes it there.` : targetEffectRefusal(task, this.tasks, "Merge");
      if (why) throw new Error(why);
    }
    if (!task.worktree || !task.branch) throw new Error("This task has no worktree.");
    if (this.live().includes(task.id)) throw new Error("The session is still running. Stop it or close its panel first.");
    if (task.checks?.status === "running") throw new Error(CHECKS_RUNNING);
    if (how === "merge") {
      if (task.merged && !(await git(this.repo, ["branch", "--list", task.branch]))) throw new Error("Already merged. Use Discard to remove its worktree."); // an earlier merge whose cleanup failed; refused only once its branch is really gone
      if (fs.existsSync(task.worktree) && !(await isClean(task.worktree))) throw new Error("The task has uncommitted changes. Ask Claude in the session to commit them, then merge."); // a deleted folder holds no uncommitted work, and git cannot run in it (spawn git ENOENT): the branch still merges
      const checked = this.checks.deliveryRevision(task);
      await mergeTask(this.repo, checked ?? task.branch);
      if (checked && !await this.cleanAtResolution(task.worktree, checked))
        throw new Error(`Merged ${checked}, but the plan worktree changed. Its newer work has been kept.`);
      this.update(task, { merged: true }); // recorded now: the cleanup below can fail after git has already deleted the branch
    }
    await discardWorktree(this.repo, task.worktree, task.branch, !!task.legacySpeechId).catch((e: NodeJS.ErrnoException) => {
      const inUse = e.code === "EPERM" || e.code === "EBUSY" ? ". Close whatever is using the folder, then Discard." : ""; // the folder could not be deleted
      throw new Error(`${task.merged ? "Merged, but its worktree was not removed: " : ""}${e.message}${inUse}`);
    });
    this.dropCardTemp(task);
    // The transcript path is worked out from the worktree, so it is stored before the worktree is cleared; the finished card keeps its last reply and subagents.
    // A discard whose work never merged is not a finished card: the cards that start after it stay held (F72, queue.ts).
    this.update(task, { status: "done", transcript: this.transcriptOf(task), ...ranIn(task), worktree: undefined, branch: undefined, merged: task.merged || how === "merge", cleanupPending: undefined, cleanup: undefined,
      ...(how === "discard" && !task.merged ? { discarded: true } : {}) });
  }

  /**
   * The work a card still has under way, in words. Finish refuses while there is any: it never stops work (the user, 7 November 2026:
   * "the finish button shouldn't end a session that's busy ... It shouldn't just instantly kill their jobs"). A session waiting on a
   * prompt is not working, so it is not listed: Finish closes it, and its dialog says the prompt goes unanswered.
   */
  busyWith(task: Task): string[] {
    const out: string[] = [], live = this.live().includes(task.id);
    if (this.codexRuns.has(task.id)) out.push("Codex is on its first turn in the background");
    else if (this.codexPanelStarts.has(task.id) || this.codexPanelRuns.has(task.id)) out.push("Codex is on its first turn in the panel");
    else if (live && task.status === "running") out.push("its session is working");
    // M-02: a subagent whose tool waits for an approval is work under way, however long it has been silent: it is silent because
    // it waits. The session's own prompt is not listed: Finish's dialog names it, and the user decides there (6 November 2026).
    else if (live && this.approvalWaits(task).children.length) out.push("a subagent is waiting for an approval");
    // busySubagents: one silent for 15 minutes never sent SubagentStop (it crashed), and is not work under way.
    else if (this.terminal(task) && this.busySubagents(task)) out.push("a subagent is still running");
    if (task.checks?.status === "running") out.push("its acceptance checks are running");
    const run = this.liveRun(task).filter((t) => t.id !== task.id).length;
    if (run) out.push(`${run} card${run === 1 ? " of its run is" : "s of its run are"} still running`);
    return out;
  }

  /** Parent and subtasks with a live board terminal: the only sessions Entomatical knows are related to this task. */
  relatedLive(task: Task): Task[] {
    return this.tasks.filter((t) => t.id !== task.id && (t.id === task.parentId || t.parentId === task.id) && !!this.terminal(t));
  }

  /**
   * The card's Finish button (the user, 2 November 2026): close the session's tab, wait for its process to end, then Entomatical does
   * the rest itself. It commits what is left (a quick Claude call writes the message), merges the remote's latest into the task
   * branch in its worktree (a headless Claude run resolves a conflict), pushes to the remote, then updates the local branch from
   * there; with no remote it merges into the local branch. Then it tells related sessions and deletes the worktree. Each step runs
   * only if every earlier one succeeded; a failure throws a message naming the step and what was already done, and the worktree is
   * kept. confirm() sees the plan before anything changes and may cancel (returns false: nothing happened). Returns notes worth
   * showing (for example a local branch that could not be updated after the push).
   *
   * the user, 6 November 2026: Finish deals with a card in whatever state it was left. Work already merged only has its worktree
   * removed. A worktree folder deleted by hand is checked out again from its branch so the branch's commits still land; with the
   * branch gone too there is nothing to merge, and Finish just removes what is left and moves the card to Done. A session waiting on
   * a prompt is closed with the prompt unanswered; a related session waiting on one is not told, not a refusal.
   * the user, 7 November 2026: Finish never stops work under way (busyWith: a working session, a subagent, a Codex first turn,
   * acceptance checks, the live cards of its run). It refuses, before its dialog and again after it, and nothing is changed.
   * Audit, 10 November 2026: a second Finish of a card one is already finishing (the user's button during auto-finish) is refused.
   */
  async complete(...args: Parameters<Board["completeHeld"]>): Promise<false | string[]> {
    const [task, confirm, step, closeTab, limits, helpers] = args;
    if (this.completing.has(task.id)) {
      const refused = new Error(`"${task.title}" is already being finished. Nothing was changed.`);
      startRun(this.dir, "finish", { id: task.id, title: task.title }, { provider: task.provider ?? "claude", account: task.account }, "Checking the task").failed(refused, { outcome: "refused" });
      throw refused;
    }
    this.completing.set(task.id, "Finish");
    try { return await this.completeHeld(task, confirm, step, closeTab, limits, { ...helpers, checkCwdAfterClose: !helpers?.asker }); }
    finally { this.completing.delete(task.id); }
  }
  /**
   * `board.js finish <id>` (the user, 18 November 2026: "you should be able to click done or finish things"): the root of an approved
   * run closes a card whose work is in the target already. It is Finish's "work merged already" case and nothing else: the worktree
   * and branch go and the card is Done. It never commits, merges or pushes and never changes the main folder; a card that needs any
   * of those is refused here, before complete(), and stays the user's Finish. Unlike `done` it does not ask for passing acceptance
   * checks: the work is in the target whatever they said. Git-ignored files are not in git status, so they do not make the worktree
   * unclean and go with it, as with the user's Finish. The rights are in orchestrator.ts (refusal, case "finish"). F120.
   */
  async finishLanded(task: Task, asker: Request): Promise<Record<string, unknown>> {
    const why = async (): Promise<string | undefined> => {
      if (!task.worktree || !task.branch || task.adopted) return "it has no worktree of its own";
      const busy = this.busyWith(task);
      if (busy.length) return `it is still working (${busy.join("; ")})`;
      if (this.live().includes(task.id)) return "its session is still open";
      // M-02: a session this board stopped whose process has not gone yet may still be writing there.
      const ending = await this.closingLeft(task);
      if (ending.length) return `${ending.map((p) => p.what).join(", ")} was stopped and has not ended yet`;
      if (checkedOut(task.worktree)) {
        try { await assertTaskCheckout(task.worktree, task.branch, false); }
        catch (error) { return (error as Error).message; }
      }
      // The branch is gone: only a card the board itself recorded as merged (an earlier Finish that could not delete the folder).
      if (!(await git(this.repo, ["branch", "--list", task.branch]))) return task.merged ? undefined : `its branch ${task.branch} is gone and the board has no record that it was merged`;
      if (!checkedOut(task.worktree)) return "its worktree folder is gone, so its branch would have to be checked out again";
      // FR2: in a vault repo the target is the local branch, as Finish reads it there. This route never uploads: it has no approval.
      let vault: VaultDestination | undefined;
      try { vault = this.vaultDestination(); } catch { return "this repo's vault setting cannot be used (entomatical.finish.vaults)"; }
      const plan = await planFinish(this.repo, task.worktree, task.branch, vault);
      if (plan.dirty.length) return `its worktree has uncommitted files (${plan.dirty.slice(0, 5).join(", ")})`;
      const where = plan.remote ? `${plan.remote}/${plan.remoteBranch}` : plan.target;
      if (!(await landedIn(this.repo, task.branch, plan))) return `its branch has commits that are not in ${where} yet`;
      // In the remote's branch but not the local one: Finish would then update the main folder from the remote (followRemote).
      if (!(await isAncestor(this.repo, task.branch, plan.target))) return `its commits are in ${where} but not in the local ${plan.target} yet`;
      return undefined;
    };
    const refused = (reason: string) => ({ error: `finish: nothing was changed: ${reason}. Finish on card ${task.id} is the user's.` });
    const first = await why();
    if (first) return refused(first);
    // The same test again where Finish asks for its confirmation (the card may have changed meanwhile), and a merge that must not
    // happen stops before any push.
    let late: string | undefined, notes: false | string[];
    try {
      notes = await this.complete(task, async () => !(late = await why()), undefined, undefined, undefined,
        { asker, message: async () => { throw new NeverCommits(); }, beforePush: async () => { throw new Error("board.js finish <id> never merges or pushes"); } });
    } catch (e) {
      // M-02: its work is in the target, and its worktree was kept because something still wrote there, or had written since. The
      // card says what (cleanup); asked again, only that cleanup is retried.
      if (e instanceof CleanupBlocked && task.cleanup) return { error: `finish: nothing was merged or pushed, and its worktree was kept: ${cleanupStatus(task.cleanup, task.worktree!)} Ask again once that is settled, or leave it to the user's Finish on card ${task.id}.` };
      // A file written after that last test: Finish staged it for the commit this never makes. The index goes back to the branch's
      // head, where it was a moment ago; the file stays where it is and the card stays in Review.
      if (!((e as { cause?: unknown }).cause instanceof NeverCommits)) throw e;
      await git(task.worktree!, ["reset", "-q"]).catch(() => undefined);
      return refused((await why()) ?? "its worktree changed while it was being closed");
    }
    if (notes === false) return refused(late ?? "its state changed");
    return { ok: true, note: `Finished ${task.id}: its work was in the target already, so only its worktree was removed. Nothing was merged or pushed.${notes.length ? ` ${notes.join(" ")}` : ""}` };
  }
  /** Cards held by Finish (complete(), or autoFinish for its whole run, which calls completeHeld), Merge or Discard (finish()), with the holder's name. */
  readonly completing = new Map<string, "Finish" | "Merge" | "Discard">();
  /**
   * complete() for a caller that already holds the card in completing. F103: every way it ends without completing is a line in the
   * board's errors.jsonl (src/error-log.ts), with the step it reached; the cancel at its dialog is an info line.
   */
  async completeHeld(task: Task, confirm: FinishConfirm,
    step: (text: string) => void = () => undefined, closeTab: (task: Task) => Promise<void> = async () => undefined,
    limits = { closeMs: 60_000, pollMs: 1000, resolveMs: 900_000 }, helpers: FinishHelpers = {}): Promise<false | string[]> {
    // Phase 4: before any commit, merge or push. A governed child never finishes to the target; a governed root goes through finishGoverned.
    { const gov = governedRootOf(task, this.tasks); const why = gov ? (task.governed ? undefined : readinessText(await this.readiness(task, "target"))) : targetEffectRefusal(task, this.tasks, "Finish"); if (why) throw new Error(why); }
    this.checks.deliveryRevision(task);
    await this.deliveryIdle(); // the caller holds the card in completing, so no new delivery starts meanwhile
    const picked = finishRun(helpers.pick);
    const run = startRun(this.dir, "finish", { id: task.id, title: task.title }, { provider: task.provider ?? "claude", account: task.account,
      model: picked.messageModel, effort: picked.messageEffort, permission: picked.permission }, "Checking the task");
    try {
      const r = task.governed ? await this.finishGoverned(task, helpers, (text) => { run.stage(text); step(text); })
        : await this.completeSteps(task, confirm, (text) => { run.stage(text); step(text); }, closeTab, limits, helpers, run);
      if (r === false) run.failed(new Error("Finish was cancelled at its dialog. Nothing was changed."), { outcome: "cancelled" });
      else run.end();
      return r;
    } catch (e) {
      if (!wasLogged(e)) run.failed(e);
      throw e;
    }
  }
  private async completeSteps(task: Task, confirm: FinishConfirm,
    step: (text: string) => void, closeTab: (task: Task) => Promise<void>, limits: { closeMs: number; pollMs: number; resolveMs: number },
    helpers: FinishHelpers, runLog: RunLog): Promise<false | string[]> {
    const done: string[] = [], notes: string[] = [];
    let planned: FinishPlan | undefined; // set once known: a failed cleanup says where the work went
    const at = async <T>(name: string, run: () => Promise<T> | T): Promise<T> => {
      step(name);
      try { return await run(); } catch (e) {
        // The work landed and only the folder is left: never "nothing was merged" or "the worktree was kept".
        if (e instanceof CleanupBlocked) {
          const where = planned?.remote ? ` and pushed to ${planned.remote}/${planned.remoteBranch}` : planned ? ` into ${planned.target}` : "";
          // FR2: the upload comes after the cleanup, so it has not run. Finish again only cleans up; Upload to Vault uploads.
          const vault = planned?.vault && task.vault?.state !== "uploaded" ? ` It is not uploaded to ${planned.vault.name} yet: run "Entomatical: Upload to Vault" for that.` : "";
          throw new CleanupBlocked(`Work merged${where}; ${e.message}${done.length ? ` Already done: ${done.join(" ")}` : ""}${vault}`);
        }
        const so = done.length ? ` Already done: ${done.join(" ")}` : " Nothing was changed.";
        const text = `Finish stopped while ${name.toLowerCase()}: ${e instanceof Error ? e.message : String(e)}${so} The worktree was kept.`;
        // The remote refused: the type is kept, so the Finish button can ask the card's session about it (the user, 11 November 2026).
        // cause: the error log (F103) reads the runner's exit code and output from it.
        if (e instanceof RemoteRefused) throw Object.assign(new RemoteRefused(text, e.said, e.remoteRef), { step: name, done: [...done], cause: e });
        throw Object.assign(new Error(text), { cause: e });
      }
    };
    const claudeDir = () => { try { return task.provider ? this.accountList().find((a) => !a.provider)?.configDir ?? undefined : this.configDirOf(task); } catch { return undefined; } };
    const helperDir = () => path.join(this.dir, "helpers", crypto.randomUUID());
    const picked = finishRun(helpers.pick);
    const message = helpers.message ?? ((diff: string) => writeCommitMessage(helperDir(), claudeDir(), task.title, task.prompt, diff, AbortSignal.timeout(120_000), picked.messageModel, picked.messageEffort,
      (why, e) => runLog.note("warn", "fallback", why, e)));
    const resolve = helpers.resolve ?? ((prompt: string) => {
      const dir = claudeDir();
      if (dir === undefined) throw new Error("No signed-in Claude account can resolve the conflict.");
      const resume = task.provider ? undefined : task.sessionId, id = resume ? undefined : crypto.randomUUID();
      // A new conversation runs in the worktree, so the next scan would add it as a found card: dismiss it first.
      if (id) { this.dismissed.add(id); writeFileAtomic(this.dismissedFile, JSON.stringify([...this.dismissed])); }
      // Exact ids only (the user, 17 November 2026): with no pick, a Claude card's resolver runs the card's own model by its full id;
      // before, it passed no --model and ran whatever the account's default was.
      // Another provider's card has no Claude model of its own: its resolver runs Opus, by its full id.
      const model = picked.model ?? (task.provider ? "opus" : this.fableBlocked(task) ? "opus" : task.model);
      runLog.set({ model: model ?? "", effort: picked.effort ?? task.effort ?? "" }); // the resolver's, not the message's
      return headlessClaude(task.worktree!, dir, resume, prompt, AbortSignal.timeout(limits.resolveMs), id, { ...picked, model });
    });
    const live = () => this.live().includes(task.id);

    const owned = () => {
      if (!this.isOwner()) throw new Error("Another VS Code window runs this repo's board. Finish it there, or close that window.");
      if (helpers.asker) {
        const reason = this.refusalOf(helpers.asker, true);
        if (reason || this.get(task.id) !== task) throw new Error(reason ?? "The target card changed during Finish.");
      }
    };
    const recoveries = new Map<string, string>();
    const { plan: checkedPlan, state, savedHead } = await at("Checking the task", async () => {
      owned();
      if (!task.worktree || !task.branch || task.adopted) throw new Error("This task has no worktree of its own.");
      const busy = this.busyWith(task);
      if (busy.length) throw new Error(`"${task.title}" is still working (${busy.join("; ")}). Finish does not stop work: wait for it to end, or press Stop first, then Finish again.`);
      const vault = this.vaultDestination(); // FR2: a setting that cannot be used stops Finish here, with nothing changed
      const noBranch = !(await git(this.repo, ["branch", "--list", task.branch]));
      // A new Finish after a rejected resolver still owes the work held by its recovery refs.
      const saved = await git(this.repo, ["for-each-ref", "--format=%(refname) %(objectname)", `refs/entomatical/finish-recovery/${task.id}/`]);
      let savedHead: string | undefined;
      if (saved) {
        if (!noBranch) savedHead = await git(this.repo, ["rev-parse", `refs/heads/${task.branch}`]);
        for (const line of saved.split(/\r?\n/)) {
          const [ref, tip] = line.split(" ");
          if (noBranch && task.merged) {
            // A failed folder removal can leave only the target and the recovery ref.
            if (!await isAncestor(this.repo, tip, "HEAD") && !await isAncestor(this.repo, tip, "@{upstream}"))
              throw new Error(`The task branch is gone and its saved commit ${tip} could not be verified in the target. Its recovery ref is ${ref}.`);
          } else if (!savedHead || !await isAncestor(this.repo, tip, savedHead))
            throw new Error(`${task.branch} does not contain the saved task commit ${tip}. Recover its work from ${ref} before finishing.`);
          recoveries.set(ref, tip);
        }
      }
      if (!noBranch && !checkedOut(task.worktree)) {
        // The card's folder is gone, but git may have its branch checked out in another folder; a checkout here would then fail with
        // "fatal: 'task/<id>' is already used by worktree at …", after the session was closed (17 November 2026, cards 94a532 and
        // dd0d4b, whose saved path still named the workspace folder's old name). Asked here, before anything is closed or made.
        const own = path.resolve(task.worktree);
        const other = (await worktrees(this.repo)).find((w) => w.lines.includes(`branch refs/heads/${task.branch}`) && !!path.relative(w.folder, own));
        if (other && !inWorktreeRoot(this.repo, other.folder))
          throw new Error(`Its worktree folder ${task.worktree} is gone, and git has ${task.branch} checked out at ${other.folder}, which is not one of this board's worktrees. Merge it from there yourself, or remove that worktree, then Finish again.`);
        if (other && checkedOut(other.folder)) this.update(task, { worktree: other.folder }); // that folder holds the work: Finish it there
        // A folder that would be made outside this board's worktrees could not be deleted afterwards ("is not a task worktree of this repo").
        else if (!inWorktreeRoot(this.repo, task.worktree))
          throw new Error(`Its worktree folder ${task.worktree} is gone and is not under this repo's .entomatical${path.sep}wt, so Finish does not make it again. Discard the card, or check ${task.branch} out under .entomatical${path.sep}wt yourself.`);
      }
      const folder = checkedOut(task.worktree);
      // A worktree off its branch (detached, or the branch deleted) whose changes are uncommitted: nothing could carry them, and the
      // worktree's removal would throw them away. Rare enough to leave to the user.
      if (noBranch && folder && await git(task.worktree, ["status", "--porcelain", "--untracked-files=all"]))
        throw new Error(`Its branch ${task.branch} is gone and its worktree has uncommitted changes, so there is nothing to merge them with. Commit them to a branch and merge that yourself, or use Discard to throw them away.`);
      if (noBranch && folder) await assertTaskCheckout(task.worktree, task.branch, false);
      const plan = noBranch ? undefined : await planFinish(this.repo, task.worktree, task.branch, vault);
      const landed = !!plan && !plan.dirty.length && await landedIn(this.repo, task.branch, plan);
      const waiting = this.relatedLive(task).filter((t) => t.status === "needs-input");
      // M-02: an earlier Finish landed the work and kept the worktree: this one only cleans up.
      const cleanupOnly = task.cleanup && task.merged && !noBranch ? task.cleanup : undefined;
      return { plan, savedHead, state: { open: live(), asking: live() && task.status === "needs-input", landed, restore: !noBranch && !folder, noBranch, waiting, ...(cleanupOnly ? { cleanupOnly } : {}) } as FinishState };
    });
    planned = checkedPlan;
    const related = this.relatedLive(task);
    const answer = await confirm(planned, related, state);
    if (!answer) return false;
    // FR2: the upload is approved by the answer to the dialog that showed this plan's vault, and by nothing else.
    const approveUpload = typeof answer === "object" && answer.upload === true && !!planned?.vault;
    owned(); // again: the window may have lost the board while the dialog was open
    this.checks.deliveryRevision(task);

    await at("Closing the session", async () => {
      if (checkedOut(task.worktree!)) await assertTaskCheckout(task.worktree!, task.branch!);
      owned();
      // Again: a follow-up, a queued prompt or a check run may have started while the dialog was open.
      const busy = this.busyWith(task);
      if (busy.length) throw new Error(`It started working while the dialog was open (${busy.join("; ")}). Nothing was stopped: press Finish again once it is done.`);
      // M-02: also a session this board stopped a moment ago whose process has not gone yet. It has left the board's list, and it
      // may still be writing: nothing is committed or merged beside it.
      const open = live();
      if (open || (await this.closingLeft(task)).length) {
        // A Claude panel tab is closed; anything else the board runs (its terminal, a card terminal) is stopped, which records the
        // stop so the card does not read as interrupted. The session is idle or waiting on a prompt here, never mid-turn.
        const panel = open && !!task.sessionId && this.external.has(task.sessionId) && !this.terminal(task) && !this.cardTerminals.has(task.id);
        if (open) {
          await this.noteClosingNow(task); // which process it is, before its tab goes: the wait below asks about that one
          if (panel) await closeTab(task); else this.stop(task);
        }
        let killed = false;
        // A closed tab, or a Stop that was sent, is no proof that it ended. The wait is over when the session has left the board's
        // list and the process it ran in is gone, or its pid is another process's by now (sessions.ts ownerState).
        for (const start = Date.now(); ; await sleep(limits.pollMs)) {
          const left = live() ? undefined : await this.closingLeft(task);
          if (left && !left.length) break;
          // An idle CLI still there after its tab closed (seen for about 5 s on Windows) is ended as Switch account ends one.
          if (panel && !killed && !left && Date.now() - start > Math.min(5000, limits.closeMs / 4)) { killed = true; await this.endIdleSession(task); }
          if (Date.now() - start > limits.closeMs) {
            const after = `after ${Math.round(limits.closeMs / 1000)} seconds`, named = left?.map((p) => p.what).join(", ");
            // The board holds such a record only until the window reloads, which is the way out when the pid is another process's.
            throw new Error(left?.length && left.every((p) => p.state === "unknown")
              ? `Whether ${named} has ended cannot be told ${after}: its process id is in use and its start time cannot be read or compared. Check that it is gone, then press Finish again (after a window reload, if it is).`
              : left?.length ? `${named![0].toUpperCase()}${named!.slice(1)} was stopped and has not ended ${after}. End it, then press Finish again.`
              : `Its session is still running ${after}. Close its tab, then press Finish again.`);
          }
        }
        await sleep(Math.min(1500, limits.pollMs * 2)); // let the CLI release files in the folder
        if (open) done.push("Closed the session.");
      }
      if (helpers.checkCwdAfterClose && !state.noBranch && !state.cleanupOnly) await checkFinishCwd(task.worktree!);
    });

    // gate (M-02): what must hold before the folder goes; the recovery refs go only after it has.
    const removeWorktree = async (gate: WorktreeGate) => {
      owned();
      await this.removeWorktree(task, gate, owned);
      for (const [ref, tip] of recoveries) {
        try { await git(this.repo, ["update-ref", "-d", ref, tip]); }
        catch (e) { notes.push(`The worktree was removed. Could not delete recovery ref ${ref}: ${(e as Error).message}`); }
      }
    };
    if (state.noBranch) {
      // Nothing can be merged. A checkout with work in it was refused above; a folder git no longer knows (an earlier Finish merged,
      // deregistered it and could not delete it) is deleted only when it holds no files, so what a session wrote there since stays.
      notes.push(task.merged ? "Its work was already merged; the leftover folder was deleted." : `Its branch ${task.branch} was already gone, so nothing was merged.`);
      await at("Deleting the worktree", async () => {
        if (checkedOut(task.worktree!)) await assertTaskCheckout(task.worktree!, task.branch!, false);
        if (fs.existsSync(task.worktree!) && !checkedOut(task.worktree!)) {
          const files = leftoverFiles(task.worktree!);
          if (files.length) throw new Error(`Its leftover folder ${task.worktree} still holds files: ${files.join(", ")}${files.length >= 10 ? " …" : ""}. Move what you want to keep, then Finish again, or Discard.`);
        }
        // M-02: with what landed on record from an earlier Finish, a folder that is still a checkout (detached now) may hold no commit beyond it.
        const was = task.cleanup?.sha;
        await removeWorktree({ limits, ...(was ? { landed: (rev: string) => isAncestor(this.repo, rev, was) } : {}) });
        this.update(task, { status: "done", transcript: this.transcriptOf(task), ...ranIn(task), worktree: undefined, branch: undefined, cleanupPending: undefined, cleanup: undefined });
      });
      return notes;
    }
    const plan = planned!;
    const into = plan.remote ? `${plan.remote}/${plan.remoteBranch}` : plan.target;
    const landed = (rev: string) => landedIn(this.repo, rev, plan);

    // M-02: the work landed in an earlier Finish, which kept the worktree whole. Only the cleanup is left, and only that is done:
    // no commit, merge, push or upload. What was written or committed there since is not merged again; it keeps the worktree.
    if (state.cleanupOnly) {
      const was = state.cleanupOnly;
      await at("Deleting the worktree", async () => {
        await removeWorktree({ limits, result: { sha: was.sha, into: was.into }, landed });
        this.update(task, { status: "done", transcript: this.transcriptOf(task), ...ranIn(task), worktree: undefined, branch: undefined, merged: true, cleanupPending: undefined, cleanup: undefined });
      });
      notes.push(`Its work was already ${landedWhere(was)}; only its worktree was left, and it was deleted.`);
      // FR2: as after any cleanup-only Finish, nothing is uploaded here; what the vault lacks is said.
      if (task.vault && task.vault.state !== "uploaded") notes.push(vaultStatus(task.vault));
      return notes;
    }

    if (state.restore || !checkedOut(task.worktree!)) {
      await at(`Checking out ${task.branch} again`, async () => {
        // A registered entry for the deleted folder would refuse the add; only this one (a global prune drops the user's unmounted worktrees).
        if (!fs.existsSync(task.worktree!)) await git(this.repo, ["worktree", "remove", "--force", task.worktree!]).catch(() => undefined);
        // Its branch still listed at another of the board's folders, also gone: git refuses the checkout until that entry is dropped.
        for (const w of await worktrees(this.repo))
          if (w.lines.includes(`branch refs/heads/${task.branch}`) && !fs.existsSync(w.folder) && inWorktreeRoot(this.repo, w.folder))
            await git(this.repo, ["worktree", "remove", "--force", w.folder]).catch(() => undefined);
        await addWorktree(this.repo, task.worktree!, task.branch!, "HEAD"); // the branch exists, so it is checked out, not made
        done.push(`Checked ${task.branch} out again (its folder was gone).`);
      });
    }

    let committed = false;
    await assertTaskCheckout(task.worktree!, task.branch!);
    if (await git(task.worktree!, ["status", "--porcelain", "--untracked-files=all"]) || await mergeInProgress(task.worktree!)) {
      await at("Committing the work", async () => {
        const { files, diff } = await stageAll(task.worktree!);
        const subject = await message(diff);
        await assertTaskCheckout(task.worktree!, task.branch!);
        await commitStaged(task.worktree!, subject);
        committed = true;
        done.push(`Committed ${files.length} file${files.length === 1 ? "" : "s"}.`);
      });
    }

    // Work merged already (by the session itself, or an earlier Finish whose cleanup failed): nothing to merge or push.
    let resolvedHead: string | undefined;
    const deliveryHead = this.checks.deliveryRevision(task);
    const candidate = deliveryHead ?? (savedHead ? await git(this.repo, ["rev-parse", `refs/heads/${task.branch}`]) : task.branch!);
    if (!committed && await landedIn(this.repo, candidate, plan)) {
      if (savedHead && !await isAncestor(this.repo, savedHead, candidate)) throw new Error("The worktree moved off the recovered task history before Finish.");
      if (savedHead || deliveryHead) resolvedHead = candidate;
      if (plan.remote && await git(this.repo, ["log", "--oneline", "-1", `${plan.target}..${task.branch}`]).catch(() => "")) await this.followRemote(task, plan, notes, step);
      // FR2: in the local branch already (a delivery, the session's own merge), which says nothing about the vault: recorded as pending.
      const vault = await this.vaultMerged(task, plan.target, plan.vault);
      owned();
      this.update(task, { merged: true, ...vault });
    } else resolvedHead = await this.mergeFinished(task, plan, done, notes, step, at, resolve, recoveries, savedHead, helpers.beforePush);
    // M-02: the result, read where it landed from: the worktree's HEAD must still be in the target when the folder goes.
    const result = { sha: await git(task.worktree!, ["rev-parse", "HEAD"]).catch(() => ""), into };

    await at("Telling related sessions", async () => {
      owned();
      const told = related.filter((t) => this.terminal(t) && t.status !== "needs-input" && t.id !== helpers.asker?.by);
      for (const t of told) this.send(t, goingAwayNote(task.title, task.id, task.branch!, task.worktree!, plan));
      if (told.length) done.push(`Told ${told.length} related session${told.length === 1 ? "" : "s"}.`);
      for (const t of related.filter((r) => r.status === "needs-input" && r.id !== helpers.asker?.by)) notes.push(`"${t.title}" was waiting on a prompt, so it was not told that this task's worktree is gone.`);
    });

    await at("Deleting the worktree", async () => {
      await assertTaskCheckout(task.worktree!, task.branch!, false);
      if (resolvedHead && !await this.cleanAtResolution(task.worktree!, resolvedHead))
        throw new Error("The worktree changed after its conflict resolution landed.");
      await removeWorktree({ limits, ...(result.sha ? { result } : {}), landed });
      this.update(task, { status: "done", transcript: this.transcriptOf(task), ...ranIn(task), worktree: undefined, branch: undefined, merged: true, cleanupPending: undefined, cleanup: undefined });
    });
    // FR2: last, with the merge, the card and its folder settled, so nothing the helper does (or a window that closes while it waits
    // for the PIN) can leave them half done. Only the user's own Finish runs it; any other route ends here with the upload pending.
    if (plan.vault) notes.push(...await this.vaultAfterFinish(task, approveUpload, step));
    return notes;
  }

  /** With a remote, the local branch follows it once the task is there. The work is safe on the remote, so a failure is a note. */
  private async followRemote(task: Task, plan: FinishPlan, notes: string[], step: (text: string) => void) {
    step(`Updating ${plan.target}`);
    try { await updateLocal(this.repo, task.branch!, plan); }
    catch (e) { notes.push(`${e instanceof Error ? e.message : String(e)} Pull it there when ready; the task is on ${plan.remote}/${plan.remoteBranch}.`); }
  }

  /** Finish's merge: the remote's latest (or the local target) into the task branch, a push with retries, then the local branch. */
  private async mergeFinished(task: Task, plan: FinishPlan, done: string[], notes: string[], step: (text: string) => void,
    at: <T>(name: string, run: () => Promise<T> | T) => Promise<T>, resolve: (prompt: string) => Promise<{ code: number | null; output: string }>,
    recoveries: Map<string, string>, verifiedHead: string | undefined, beforePush?: (worktree: string) => Promise<void>) {
    const base = plan.remote ? `${plan.remote}/${plan.remoteBranch}` : plan.target;
    const worktree = task.worktree!, branch = task.branch!;
    for (let attempt = 1; ; attempt++) {
      const previousHead = verifiedHead;
      verifiedHead = await at(`Merging with ${base}`, async (): Promise<string | undefined> => {
        let head: string;
        try {
          await integrate(worktree, branch, plan);
          if (!previousHead) return;
          head = await git(worktree, ["rev-parse", "HEAD"]);
        } catch (e) {
          if (!(e instanceof MergeConflict)) throw e;
          step(`Resolving the conflict in ${e.files.join(", ")}`);
          const { taskTip, baseTip } = e;
          // The resolver can move the task branch before returning (or throwing). Keep its input reachable independently.
          const recovery = `refs/entomatical/finish-recovery/${task.id}/${taskTip}`;
          await git(this.repo, ["update-ref", recovery, taskTip]);
          recoveries.set(recovery, taskTip);
          done.push(`Saved the original task commit at ${recovery}.`);
          await assertTaskCheckout(worktree, branch, false);
          const r = await resolve(resolveRequest(branch, e.base, e.files, baseTip));
          // F103: the error log keeps the resolver's exit code and the end of its output.
          const ran = { exitCode: r.code, stderrTail: r.output.slice(-2048) };
          await assertTaskCheckout(worktree, branch, false);
          if (await git(worktree, ["status", "--porcelain", "--untracked-files=all"])) throw Object.assign(new Error(`${e.message} The headless Claude run left the worktree with uncommitted changes. ${plainTail(r.output)}`), ran);
          head = await git(worktree, ["rev-parse", "HEAD"]);
          if (!(await isAncestor(worktree, taskTip, head)))
            throw Object.assign(new Error(`${e.message} The headless Claude run did not keep this task's commits.`), ran);
          if (!(await isAncestor(worktree, baseTip, head))) throw Object.assign(new Error(`${e.message} The headless Claude run did not merge it: ${plainTail(r.output) || `exit ${r.code}`}`), ran);
          done.push(`Claude resolved the conflict with ${base}.`);
        }
        // A later clean retry must still carry the verified merge, including both of its input histories.
        if (previousHead && !(await isAncestor(worktree, previousHead, head)))
          throw new Error(`The retry lost the previously verified conflict resolution ${previousHead}.`);
        return head;
      });
      if (beforePush) await at("Running the acceptance checks", async () => {
        if (verifiedHead) {
          await assertTaskCheckout(worktree, branch, false);
          if (!await this.cleanAtResolution(worktree, verifiedHead)) throw new Error("The verified conflict resolution changed before the acceptance checks.");
        }
        await beforePush(worktree);
        if (verifiedHead) {
          await assertTaskCheckout(worktree, branch, false);
          if (!await this.cleanAtResolution(worktree, verifiedHead))
            throw new Error(`The worktree moved off the verified conflict resolution ${verifiedHead} during the acceptance checks.`);
        }
      });
      verifiedHead = this.checks.deliveryRevision(task) ?? verifiedHead;
      if (!plan.remote) break;
      const pushed = await at(`Pushing to ${plan.remote}/${plan.remoteBranch}`, async () => {
        await assertTaskCheckout(task.worktree!, task.branch!, false);
        const ok = await pushTask(worktree, plan, verifiedHead ?? `refs/heads/${branch}`);
        if (!ok && attempt >= 3) {
          const said = `${plan.remote}/${plan.remoteBranch} kept moving while Finish merged with it: its push was refused as not a fast-forward 3 times.`;
          throw new RemoteRefused(`${said} Press Finish again.`, said, `${plan.remote}/${plan.remoteBranch}`);
        }
        return ok;
      });
      if (pushed) { done.push(`Pushed to ${plan.remote}/${plan.remoteBranch}.`); this.update(task, { merged: true }); break; }
    }

    if (plan.remote) await this.followRemote(task, plan, notes, step);
    else {
      await at(`Merging into ${plan.target}`, async () => {
        await assertTaskCheckout(task.worktree!, task.branch!, false);
        await updateLocal(this.repo, verifiedHead ?? branch, plan);
        // FR2: the merged commit, its branch, the vault and "pending" are on the card before anything is uploaded.
        this.update(task, { merged: true, ...(await this.vaultMerged(task, plan.target, plan.vault)) });
        done.push(`Merged into ${plan.target}.`);
      });
    }
    return verifiedHead;
  }

  private async cleanAtResolution(worktree: string, head: string): Promise<boolean> {
    return !await git(worktree, ["status", "--porcelain", "--untracked-files=all"]) && await git(worktree, ["rev-parse", "HEAD"]) === head;
  }

  // ---- FR2 / GAP-02: the vault as Finish's destination (finish.ts, "the encrypted vault") ----

  /** entomatical.finish.vaults as the user's own user settings hold it; set by the extension. A workspace's settings are never read for it. */
  vaultOf: () => unknown = () => undefined;
  /** Runs the vault's helper and waits for it to end: a terminal of its own. A seam for tests. */
  vaultRun: VaultRunner = vaultTerminal;
  /** The vault the user set for this repo, or undefined. Throws when the setting names one that cannot be used as written. */
  vaultDestination(): VaultDestination | undefined { return vaultFor(this.vaultOf(), this.repo); }
  /** Cards whose merged work the vault is not known to have. */
  vaultWaiting(): Task[] { return this.tasks.filter((t) => t.vault && t.vault.state !== "uploaded"); }
  /** The cards whose helper this window is running now. */
  private readonly vaultRuns = new Set<string>();

  /**
   * The record of work that is in a vault repo's local branch now: the branch's commit (the merge just made, or the candidate a
   * governed Finish fast-forwarded to), pending. The card's own record of the same commit and destination is kept as it is.
   */
  private async vaultMerged(task: Task, branch: string, dest?: VaultRecord["destination"], sha?: string): Promise<{ vault?: VaultRecord }> {
    if (!dest) return {};
    const at = sha ?? await git(this.repo, ["rev-parse", `refs/heads/${branch}`]), old = task.vault;
    // Kept: the same commit for the same destination, and a record whose helper is running now (its result is written on it).
    if (old && (old.state === "uploading" || (old.destination.id === dest.id && old.branch === branch && old.sha === at))) return {};
    return { vault: { destination: { id: dest.id, name: dest.name, display: dest.display }, branch, sha: at, mergedAt: new Date().toISOString(), state: "pending", attempts: 0, why: "not uploaded yet" } };
  }

  /** Leaves the merge where it is and says why the upload is pending. A line in the board's error log (F103) says the same. */
  private vaultPending(task: Task, outcome: VaultOutcome, why: string, more: Partial<VaultRecord> = {}, run?: VaultRun): VaultRecord {
    const v = task.vault!;
    this.update(task, { vault: { ...v, ...more, state: "pending", running: undefined, why, last: { at: new Date().toISOString(), outcome, ...(run ? { exitCode: run.code, ms: run.ms } : {}) } } });
    const logged: Record<string, LogOutcome> = { refused: "failed", timeout: "timeout", cancelled: "cancelled", interrupted: "interrupted", "missing-helper": "runner-error" };
    appendEntry(this.dir, { level: logged[outcome] ? "warn" : "info", action: "finish", outcome: logged[outcome] ?? "waiting", stage: `Uploading to ${v.destination.name}`, card: { id: task.id, title: task.title },
      provider: task.provider ?? "claude", account: task.account, message: vaultStatus(task.vault!), ...(run ? { durationMs: run.ms, exitCode: run.code } : {}) });
    return task.vault!;
  }

  /**
   * An upload still marked as running whose helper is gone (the window closed or crashed while it ran): nobody recorded how it ended,
   * so its outcome is not known. One this window runs, or whose process is still there, is left alone.
   */
  private settleVault() {
    for (const t of this.tasks) {
      const v = t.vault;
      if (!v || v.state !== "uploading" || this.vaultRuns.has(t.id)) continue;
      if (v.running && v.running.by !== this.instance && processAlive(v.running.pid)) continue;
      this.vaultPending(t, "interrupted", `the window closed while its helper ran, so whether anything reached ${v.destination.name} is not known`, { uncertain: true });
    }
  }

  /**
   * Uploads a card's merged work to the repo's vault, or says why it is still pending. It never merges: it works on the record of a
   * merge already made, and only on the destination that record names. approve: the user approved this upload now (his Finish dialog,
   * or Upload to Vault, showed the destination); without it nothing is run. confirm: asks him what only he can settle before another
   * upload (a setting that changed, a branch that moved, a last try nobody saw end); with no confirm those wait for him.
   * One at a time for this repo's vault, whichever card and whatever its record names: a second press waits for the first, then
   * finds its result.
   */
  async uploadVault(task: Task, opts: { approve?: boolean; confirm?: (q: VaultQuestion) => Promise<boolean>; step?: (text: string) => void } = {}): Promise<VaultRecord> {
    this.mustOwn();
    const v = task.vault;
    if (!v) throw new Error(`"${task.title}" has no work merged for a vault.`);
    // A route with no approval never waits behind an upload: it says so now. A record that already says more is left as it is.
    if (!opts.approve) return v.state !== "pending" || v.last ? v : this.vaultPending(task, "unauthorized", "this Finish had no approval to upload; only the user's own Finish or Upload to Vault starts one");
    return vaultSerial(checkoutId(this.repo), () => this.uploadVaultNow(task, opts.confirm, opts.step ?? (() => undefined)));
  }
  private async uploadVaultNow(task: Task, confirm: ((q: VaultQuestion) => Promise<boolean>) | undefined, step: (text: string) => void): Promise<VaultRecord> {
    this.mustOwn();
    if (this.get(task.id) !== task || !task.vault) throw new Error(`"${task.title}" is no longer on the board.`);
    this.settleVault();
    const v = task.vault, short = (sha: string) => sha.slice(0, 7);
    if (v.state === "uploaded") return v; // the press that waited behind the upload that did it
    // Left "uploading" by settleVault above: its helper is alive in another window. Any card's, since this repo has one vault.
    const elsewhere = this.tasks.find((t) => t.vault?.state === "uploading" && !this.vaultRuns.has(t.id));
    if (elsewhere) throw new Error(`An upload to ${v.destination.name} that another window started at ${elsewhere.vault!.running?.at ?? "an unknown time"} is still running. Wait for it to end, then try again.`);
    const asked = async (q: VaultQuestion) => !!confirm && await confirm(q) && this.get(task.id) === task;

    // 1. The destination that was approved, and no other, unless the user approves the new one.
    let dest: VaultDestination | undefined, unusable = "";
    try { dest = this.vaultDestination(); } catch (e) { unusable = e instanceof Error ? e.message : String(e); }
    if (!dest) return this.vaultPending(task, "unconfirmed", unusable || "this repo has no vault set any more (entomatical.finish.vaults)");
    const patch: Partial<VaultRecord> = {};
    if (dest.id !== v.destination.id) {
      if (!(await asked({ kind: "destination", record: v, destination: dest })))
        return this.vaultPending(task, "unconfirmed", `this repo's vault setting changed since the merge: it now runs ${dest.display}, and ${v.destination.display} was approved; it waits for the user to approve the new destination`);
      patch.destination = { id: dest.id, name: dest.name, display: dest.display };
    }
    const missing = vaultHelperMissing(dest);
    if (missing) return this.vaultPending(task, "missing-helper", missing, patch);

    // 2. The result that was merged, and no other. A branch that moved, or a last try nobody saw end, is settled first: by the
    // helper's own check when it has one, else by the user, who confirms the state that would be uploaded now.
    const tipOf = () => git(this.repo, ["rev-parse", "--verify", "-q", `refs/heads/${v.branch}`]).catch(() => "");
    const tip = await tipOf();
    if (!tip) return this.vaultPending(task, "unconfirmed", `the branch ${v.branch} no longer exists`, patch);
    const moved = tip !== v.sha;
    // A branch that was reset or rewritten no longer holds what was merged. The helper's check cannot settle that (a vault that
    // matches such a branch does not have this work either): only the user can.
    const contains = !moved || await isAncestor(this.repo, v.sha, tip);
    let behind = false; // the helper's own check said the vault does not hold the repo as it is now
    if (moved || v.uncertain) {
      if (dest.verifyArgs && contains) {
        step(`Checking ${dest.name}`);
        const check = await this.vaultHelper(task, dest, "verify", patch);
        if (check.code === 0 && !check.timedOut) return this.vaultUploaded(task, dest, tip, "verified", check);
        behind = typeof check.code === "number" && !check.timedOut;
        // Nothing runs now: back to pending, so a question that stays open is not taken for an upload whose window went. How the
        // check ended is kept, whatever the user then answers.
        this.update(task, { vault: { ...task.vault, state: "pending", running: undefined, checked: { at: new Date().toISOString(), exitCode: check.code, ms: check.ms, ...(check.timedOut ? { timedOut: true } : {}) },
          ...(behind ? { uncertain: undefined, why: `its helper's check says ${dest.name} does not have it` } : { why: v.why }) } });
      }
      if (moved || !behind) {
        const q: VaultQuestion = moved ? { kind: "moved", record: task.vault, destination: dest, tip, contains } : { kind: "uncertain", record: task.vault, destination: dest };
        if (!(await asked(q))) return this.vaultPending(task, "unconfirmed", !moved ? `its last upload did not report a result (${v.last?.outcome ?? "interrupted"}); it waits for the user to confirm before another upload`
          : contains ? `${v.branch} moved from ${short(v.sha)} to ${short(tip)} since the merge, so an upload would carry more than was approved; it waits for the user to confirm the new state`
          : `${v.branch} moved from ${short(v.sha)} to ${short(tip)} since the merge and no longer holds the merged commit (it was reset or rewritten); it waits for the user to confirm the new state`, patch);
        if (moved) patch.sha = tip;
      }
      patch.uncertain = undefined;
    }
    const sha = patch.sha ?? v.sha;
    // Nothing was uploaded, so an outcome nobody knew stays unknown, unless the helper's check has just settled it.
    if (await tipOf() !== sha) return this.vaultPending(task, "unconfirmed", `${v.branch} moved again while the upload was being confirmed; nothing was uploaded`, { ...patch, sha: v.sha, uncertain: behind ? undefined : v.uncertain });

    // 3. The helper, with what it uploads and where to on the card before it starts.
    step(`Uploading ${v.branch} to ${dest.name}: enter your PIN and touch the key when its terminal asks`);
    const run = await this.vaultHelper(task, dest, "upload", { ...patch, approved: { by: "user", at: new Date().toISOString() } });
    if (run.failed) return this.vaultPending(task, "missing-helper", `its helper could not be started (${redact(run.failed).slice(0, 200)})`, { attempts: task.vault.attempts - 1 }, run);
    const result = vaultResult(run, dest);
    if (result.outcome === "uploaded") return this.vaultUploaded(task, dest, sha, "uploaded", run);
    return this.vaultPending(task, result.outcome, result.why!, { uncertain: result.uncertain || undefined }, run);
  }

  /** Writes "running" on the card, then starts the helper and waits for it. failed: it could not be started at all, so nothing ran. */
  private async vaultHelper(task: Task, dest: VaultDestination, kind: "upload" | "verify", patch: Partial<VaultRecord>): Promise<VaultRun & { failed?: string }> {
    const v = task.vault!;
    this.vaultRuns.add(task.id); // first: the save below redraws, and nothing may take this run for one whose window went
    try {
      this.update(task, { vault: { ...v, ...patch, state: "uploading", why: undefined, attempts: v.attempts + (kind === "upload" ? 1 : 0), running: { at: new Date().toISOString(), by: this.instance, kind } } });
    } catch (e) { this.vaultRuns.delete(task.id); throw e; } // not written (another window has the board): nothing is started
    try {
      return await this.vaultRun(dest, kind, { cwd: this.repo, timeoutMs: dest.timeoutMs, started: (pid) => {
        // Its process, so another window can tell an upload still running from one whose window went.
        const running = task.vault?.running;
        if (pid && running && this.vaultRuns.has(task.id)) { running.pid = pid; this.guard(() => this.writeTasks()); }
      } });
    } catch (e) {
      return { code: null, ms: 0, failed: e instanceof Error ? e.message : String(e) };
    } finally { this.vaultRuns.delete(task.id); }
  }

  /** The vault has it. The same upload carried every earlier merge of that branch, so those cards stop saying pending too. */
  private async vaultUploaded(task: Task, dest: VaultDestination, sha: string, outcome: "uploaded" | "verified", run: VaultRun): Promise<VaultRecord> {
    const at = new Date().toISOString(), v = task.vault!;
    this.update(task, { vault: { ...v, state: "uploaded", running: undefined, uncertain: undefined, why: undefined, last: { at, outcome, exitCode: run.code, ms: run.ms }, uploaded: { at, sha } } });
    for (const t of [...this.tasks]) {
      const o = t.vault;
      if (t === task || !o || o.state !== "pending" || o.destination.id !== dest.id || o.branch !== v.branch) continue;
      if (o.sha === sha || await isAncestor(this.repo, o.sha, sha)) this.update(t, { vault: { ...o, uncertain: undefined, why: undefined, state: "uploaded", uploaded: { at, sha: o.sha, coveredBy: sha } } });
    }
    return task.vault!;
  }

  /**
   * Finish's last step in a vault repo. approve: the user's own Finish, whose dialog showed the destination; then the helper runs.
   * Any other route stops at "upload pending". Never throws: the merge is made and stays, and what is left is a note.
   */
  private async vaultAfterFinish(task: Task, approve: boolean, step: (text: string) => void): Promise<string[]> {
    if (!task.vault || task.vault.state === "uploaded") return [];
    const now = () => this.get(task.id)?.vault ?? task.vault!; // read again: the upload rewrote it
    try { await this.uploadVault(task, { approve, step }); }
    catch (e) { return [`${vaultStatus(now())} (${redact(e instanceof Error ? e.message : String(e))})`]; }
    return now().state === "uploaded" ? [] : [vaultStatus(now())];
  }

  /**
   * Tells the panel wrapper (wrapper/entomatical-claude.js) how to run a session: worktree, account folder, hooks file.
   * "pending" is for the next new panel; a session id is for resuming that session.
   */
  private writeLaunch(name: string, task: Task, firstPrompt?: string, starting = true): string {
    const configDir = this.configDirOf(task);
    this.writeHooks(task);
    // A strict card: the wrapper adds the args and deletes the MCP file when claude ends. Only when a session starts now, so the file with the
    // servers' tokens does not outlive it; a later resume from the panel's own history then finds no MCP file and is refused (wrapper).
    if (!task.provider && starting) this.writeStrict(task, "panel");
    const dir = path.join(this.dir, "launch");
    fs.mkdirSync(dir, { recursive: true });
    const lines = [task.worktree ?? this.repo, configDir, this.hooksFile(task.id)];
    if (firstPrompt) {
      // A new session also gets its first-prompt file and its name (empty: let Claude title it).
      const promptFile = this.promptFile(task.id);
      fs.writeFileSync(promptFile, firstPrompt, "utf8");
      lines.push(promptFile, task.named ? task.title : "");
    }
    fs.writeFileSync(this.launchFile(name), lines.join("\r\n"));
    return lines.join("\r\n"); // not read back: a wrapper may claim the file at once
  }

  private promptFile(id: string) {
    return path.join(this.dir, "launch", `${id}.prompt.txt`);
  }

  private launchFile(name: string) {
    return path.join(this.dir, "launch", `${name}.txt`);
  }

  /** The panel start under way: there is one launch/pending.txt, so panel starts run one at a time. */
  private panelStarts: Promise<unknown> = Promise.resolve();

  /**
   * Start the task in a Claude Code panel. The wrapper sends the prompt as the session's first message.
   * Starts queue behind each other: two at once would share pending.txt, and each panel could take the other's task.
   */
  startInPanel(task: Task): Promise<void> {
    const run = this.panelStarts.then(() => this.once(task, () => this.startInPanelNow(task)));
    this.panelStarts = run.catch(() => {});
    return run;
  }

  private async startInPanelNow(task: Task) {
    if (this.get(task.id) !== task) throw new Error("The card was deleted before it started."); // while queued behind another start
    if (task.sessionId) throw new Error("Already started. Use Open.");
    // A second panel would run the same first prompt in the same worktree. After 10 minutes Start is the way out (its wrapper died).
    if (task.panelPending && Date.now() - task.panelPending < 600_000) throw new Error(LATE_PANEL);
    if (interactive(task.workflow)) throw new Error("This step asks the owner to authenticate, so it runs in a terminal, not the panel's unattended first turn.");
    this.mustOwn(); // before the gate, the worktree and the panel: the session id could not be recorded once it started
    const check = this.launchGuard(task);
    this.gate(task, "panel");
    await this.ensureWorktree(task, "launch");
    await this.beforeStart(task);
    check();
    const before = this.events(task.id).length;
    const mine = this.writeLaunch("pending", task, this.promptFor(task));
    const pending = this.launchFile("pending"), promptFile = this.promptFile(task.id);
    let started: HookEvent | undefined, unclaimed = false;
    try {
      await vscode.commands.executeCommand("claude-vscode.editor.open");
      started = await this.waitForEvent(task.id, "SessionStart", before, 60_000);
    } finally {
      // Not claimed by a wrapper: remove it and its prompt file, but pending.txt only while it still holds this task's launch, never a
      // newer start's. A wrapper that claims it also deletes the prompt file, so a newer start beside a prompt file left means not claimed.
      let held: string | undefined;
      try { held = fs.readFileSync(pending, "utf8"); } catch { /* claimed, so already gone */ }
      unclaimed = held === mine || (held !== undefined && fs.existsSync(promptFile));
      if (held === mine) fs.rmSync(pending, { force: true });
      if (unclaimed) fs.rmSync(promptFile, { force: true });
    }
    // Claimed but not reported in within 60 s: syncStatus gives the card its session id when its SessionStart arrives.
    if (typeof started?.session_id !== "string") {
      if (unclaimed) throw new Error("The Claude panel did not start through Entomatical's wrapper, so it runs in the main folder. Check that the panel wrapper is on.");
      task.panelPending = Date.now(); // syncStatus adopts only a card that waits like this
      this.save();
      throw new Error(LATE_PANEL);
    }
    // Only now: a start that failed above left the card unstarted with no id, and its next Start must send the same continuation prompt.
    this.sentPrompt(task);
    this.update(task, { sessionId: started.session_id, panel: true, panelPending: undefined });
    this.writeLaunch(started.session_id, task);
  }

  canResumeInPanel(task: Task): boolean {
    return !!task.sessionId && !task.provider; // Codex sessions run in terminals only
  }

  /**
   * The conversation file the panel will resume: `claude --resume` looks only under its own CLAUDE_CONFIG_DIR. The task's
   * account folder is where it should be; when it is not there (the account folder was renamed or the card's account changed
   * after the session ran, as task 95f259 on 30 October 2026, whose file was under ~/.claude while the card said
   * another account), the file is found in ~/.claude or another account folder and linked into the task's account folder:
   * the same append-only file under a second name, never a copy. A conversation is not a login; no credential file is touched.
   * Throws, naming the path looked for, when no folder has it, so the panel never reports "No conversation found" on its own.
   */
  private locateTranscript(task: Task, configDir: string): string {
    const cwd = task.worktree ?? this.repo, id = task.sessionId!;
    const expected = transcriptPath(configDir, cwd, id);
    if (fs.existsSync(expected)) return expected;
    const usable = (f: string) => !sameFolder(path.dirname(f), path.dirname(expected)) && fs.existsSync(f);
    // F118: the project folder is named after the cwd, so a renamed or moved workspace folder leaves the file under the old name's
    // project folder. Any project folder of any account folder may hold it (sessionPlaces); the longest is the one still written to.
    const elsewhere = [task.transcript ?? "", ...this.accountFolderList().map((d) => transcriptPath(d || DEFAULT_DIR, cwd, id))].filter(Boolean).find(usable)
      ?? sessionPlaces([...this.accountFolderList(), configDir, ""], id, true).transcripts.filter(usable).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
    if (!elsewhere) throw new Error(`This session has no saved conversation (looked for ${expected}), so there is nothing to reopen.`);
    carryTranscript(elsewhere, expected);
    if (task.transcript !== expected) this.update(task, { transcript: expected }); // the record said where it was not
    return expected;
  }

  /**
   * The Claude Code extension looks for transcripts under its selected account folder. When the task uses another
   * account, link the transcript into the selected history folder (panel selftest "open-resumes"): the
   * same append-only file under a second name, never a copy. The wrapper still runs the session on its own account.
   */
  private linkTranscript(real: string, task: Task, historyDir: string) {
    const seen = transcriptPath(historyDir, task.worktree ?? this.repo, task.sessionId!);
    if (fs.existsSync(seen)) return;
    const created = fs.mkdirSync(path.dirname(seen), { recursive: true });
    try { fs.linkSync(real, seen); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      if (created) fs.rmSync(created, { recursive: true, force: true }); // another drive holds no hard link, and a copy would go stale: skipped, as linkIntoHistory does
    }
  }

  /** Open a started task's session in a Claude Code panel, resuming it in its worktree and account. */
  openInPanel(task: Task, historyDir = DEFAULT_DIR, prompt?: string) { return this.launchStep(task, () => this.openInPanelNow(task, historyDir, prompt)); }
  private async openInPanelNow(task: Task, historyDir = DEFAULT_DIR, prompt?: string) {
    if (!task.sessionId) throw new Error("Not started yet.");
    if (!task.worktree) throw new Error("This task is finished; its worktree was removed.");
    this.mustOwn(); // it launches a session (and may link its transcript): not from a window that does not own the board
    this.gate(task, "panel");
    await this.settle(task);
    if (this.external.has(task.sessionId)) throw new Error("This session is still running elsewhere. Close it there first.");
    const configDir = this.configDirOf(task) || DEFAULT_DIR;
    const real = this.locateTranscript(task, configDir);
    if (!sameFolder(configDir, historyDir)) this.linkTranscript(real, task, historyDir);
    linkIntoHistory(real, [historyDir], this.repo, task.sessionId); // now, not on the next tick: the panel opens a blank chat for a session its list lacks
    this.forgetStopped(task.sessionId); // as resume(): after Stop and switch Windows can hand the new CLI the stopped one's pid
    // The prompt goes through the launch file: the extension only types an initialPrompt into the message box (Claude Code 2.1.318,
    // linux, 6 November 2026), so Resume. sat there unsent. The wrapper sends it once to the resumed session.
    this.writeLaunch(task.sessionId, task, prompt);
    await vscode.commands.executeCommand("claude-vscode.editor.open", task.sessionId);
  }

  /** Cards whose Start is under way. The card has no session id until its worktree is made, so a second press (or the auto start after naming) would start it twice. */
  private starting = new Set<string>();

  private async once<T>(task: Task, run: () => Promise<T>): Promise<T> {
    if (this.starting.has(task.id)) throw new Error("Already starting.");
    this.starting.add(task.id);
    let failed = true;
    try {
      const removal = this.removingRefusedWorktrees.get(task.id);
      if (removal) await removal;
      const result = await run();
      this.keepWorktree(task);
      failed = false;
      return result;
    } finally { this.starting.delete(task.id); if (failed && !this.launching.has(task.id)) this.releaseUnused(task); }
  }

  /** Create the worktree, start the session in a terminal and send the first prompt once the session reports ready. */
  start(task: Task): Promise<vscode.Terminal | undefined> {
    return this.once(task, () => this.startNow(task));
  }

  private async startNow(task: Task): Promise<vscode.Terminal | undefined> {
    if (task.sessionId) throw new Error("Already started. Use Resume.");
    if (task.provider === "grok" || task.provider === "antigravity") return this.startHeadlessNow(task);
    this.mustOwn(); // before the worktree, the Codex approval and the terminal
    const check = this.launchGuard(task);
    this.gate(task);
    // The model first (F92): a Codex card with no exact model id is refused before its worktree, branch or approval exist.
    if (task.provider === "codex") await this.codexModelReady(task);
    const undo = await this.ensureWorktreeUndoable(task);
    try {
      if (task.provider === "codex") await this.ensureCodexTrust(task); // before the id: a declined approval leaves the card unstarted
      await this.beforeStart(task);
      // Again with the worktree's own config (Default model): a refusal here removes the worktree and branch this start made.
      if (task.provider === "codex") await this.codexModelReady(task);
    } catch (e) { if (Board.modelRefusal(e)) await undo(); throw e; }
    check();
    let policy: CodexPermissions | undefined;
    if (task.provider === "codex") {
      try {
        const effective = codexThreadPermissions(task); // the card may have changed during preparation
        if (this.startsInCodexEditor(task)) policy = effective;
      } catch (e) { await undo(); throw e; }
    }
    this.update(task, { sessionId: crypto.randomUUID(), codexEditor: policy ? true : undefined, codexEditorPolicy: undefined, codexStopped: undefined });
    if (policy) {
      const token = crypto.randomUUID();
      this.codexPanelStarts.set(task.id, { token, policy });
      this.changed.fire();
      let dispatched = false;
      try {
        const env = this.taskEnv(task);
        delete env.ENTOMATICAL_SESSION; // the id above is provisional; Codex supplies its real CODEX_THREAD_ID in the shell
        // Like the terminal: Codex gets the newest id of the card's family, never the short name ("sol") it cannot look up.
        const result = await this.startCodexPanel({ ...task, model: this.codexSend(task) }, this.promptFor(task), token, env, policy);
        dispatched = !!result;
        const card = this.get(task.id);
        if (this.codexPanelStarts.get(task.id)?.token !== token || !card) {
          // A replacement may already own this thread. Retry cleanup only for the launch that returned.
          if (result?.threadId && !result.completed) void this.cancelCodexPanelStart(token).catch(() => undefined);
          return undefined;
        }
        if (!result) { // The bridge lookup yielded. Check the card again before spawning the fallback.
          const current = codexThreadPermissions(card);
          if (!this.startsInCodexEditor(card) || current.sandbox !== policy.sandbox) throw new Error("The card's launch settings changed. Retry Start.");
          this.runFirstCodexTurn(card, current);
          return undefined;
        }
        if (!result.completed) this.codexPanelRuns.set(card.id, result.threadId);
        const flags = result.threadStatus?.activeFlags ?? [];
        this.update(card, { sessionId: result.threadId, codexEditorPolicy: { threadId: result.threadId, sandbox: policy.sandbox }, ...(result.transcript ? { transcript: fromCodexPath(result.transcript) } : {}),
          codexPanelBridge: true, status: result.completed ? "review" : flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput") ? "needs-input" : "running", interrupted: result.completed && result.status !== "completed" ? true : undefined },
        undefined, result.completed && result.status !== "completed");
        this.sentPrompt(card);
      } catch (e) {
        const card = this.get(task.id);
        if (dispatched) throw new PanelUpdateError(`Codex returned the launch result for "${task.title}". The Board update failed. ${e instanceof Error ? e.message : e}`, { cause: e });
        if (this.codexPanelStarts.get(task.id)?.token !== token || !card) return undefined; // Stop or Delete cancelled this launch
        if (!card.codexPanelBridge) this.update(card, { sessionId: undefined, codexEditor: undefined, codexEditorPolicy: undefined, status: "queued" });
        else this.update(card, { status: "review", interrupted: true }, undefined, true); // keep the prepared conversation for inspection
        throw e;
      } finally {
        if (this.codexPanelStarts.get(task.id)?.token === token) this.codexPanelStarts.delete(task.id);
        this.changed.fire();
      }
      return undefined;
    }
    if (task.provider === "codex") {
      // The prompt is Codex's start argument, so no ready signal is needed. The id above only marks the card started; its hooks move it.
      let term: vscode.Terminal;
      try { term = this.launch(task, false); }
      catch (e) { this.update(task, { sessionId: undefined }); await undo(); throw e; }
      term.show(true);
      return term;
    }
    const before = this.events(task.id).length;
    const prompt = this.promptFor(task); // now: SessionStart clears a moved task's `continued` before the paste below
    let term: vscode.Terminal;
    try {
      term = this.launch(task, false);
    } catch (e) {
      this.update(task, { sessionId: undefined }); // nothing started, so the card offers Start again
      throw e;
    }
    this.writeLaunch(task.sessionId!, task); // resuming it from the Claude panel's history runs in its worktree and account
    term.show(true); // a folder trust prompt, if any, must be visible
    // Only this terminal's session counts: once it is closed (and perhaps resumed in a new one), a later SessionStart is not its own.
    const mine = () => this.terminal(task) === term;
    // SessionStart fires once the CLI is up, after any folder trust prompt. The short pause lets the input box render.
    const ready = await this.waitForEvent(task.id, "SessionStart", before, 600_000, mine);
    if (!mine()) {
      this.resetUnstarted(task); // closed before it came up (e.g. during onboarding or folder trust): the card shows Start again
      return term;
    }
    if (!ready) {
      vscode.window.showWarningMessage(`Entomatical: session ${task.id} did not report ready in 10 minutes, so the prompt was not sent. Paste it in the terminal.`);
      return term;
    }
    await sleep(1500);
    if (!mine()) return term; // closed during the pause
    const sentAt = this.events(task.id).length;
    term.sendText(paste(prompt), false);
    this.confirmSubmitted(task, term, sentAt);
    this.sentPrompt(task);
    return term;
  }

  /**
   * F97 live check, 12 November 2026: after Claude's folder-trust question a card's first prompt reached the input box but its Enter
   * was lost, so it sat unsent until Enter was pressed in the terminal. Not reproduced outside VS Code's terminal (12 runs in a pty,
   * with and without an xterm emulator). So the board checks: when no turn started within submitCheckMs, it sends one more Enter,
   * unless the terminal changed or a prompt is waiting (the Enter would answer it). An extra Enter in an empty box does nothing.
   */
  private confirmSubmitted(task: Task, term: vscode.Terminal, after: number) {
    setTimeout(() => {
      if (this.terminal(task) !== term || this.get(task.id)?.status === "needs-input") return;
      const since = this.events(task.id).slice(after).map((e) => e.hook_event_name);
      if (since.some((n) => n === "UserPromptSubmit" || n === "Stop" || n === "StopFailure" || n === "PermissionRequest" || n === "Notification")) return;
      term.sendText("\r", false);
    }, this.submitCheckMs).unref?.();
  }

  /** How long the board waits for a pasted prompt's turn to start before sending one more Enter (see confirmSubmitted). Tests shorten it. */
  submitCheckMs = 15_000;

  resume(task: Task, prompt?: string): Promise<vscode.Terminal | undefined> { return this.launchStep(task, () => this.resumeNow(task, prompt)); }
  private checkEditorTerminalResume(task: Task, threadId: string) {
    const confirmed = confirmedCodexThread(task);
    const known = confirmed ? confirmed === threadId : this.events(task.id).some((e) => e.hook_event_name === "SessionStart" && e.session_id === threadId);
    if (this.get(task.id) !== task || task.sessionId !== threadId || !task.codexEditor || !known) throw new Error("Cannot confirm the saved Codex thread. Open its history to identify it before resuming.");
    if (this.live().includes(task.id)) throw new Error("This Codex thread is active. Stop its current turn before resuming it in a terminal.");
  }
  private async resumeNow(task: Task, prompt?: string): Promise<vscode.Terminal | undefined> {
    if (!task.sessionId) throw new Error("Not started yet.");
    if (!task.worktree) throw new Error("This task is finished; its worktree was removed.");
    this.mustOwn(); // it launches a session: not from a window that does not own the board
    if (task.provider === "grok" || task.provider === "antigravity") throw new Error("Use Follow-up to resume this agent with a message.");
    const check = this.launchGuard(task);
    this.gate(task);
    const threadId = task.sessionId;
    if (task.codexEditor && this.canReopenCodexEditor(task)) {
      await this.openInCodex(task);
      this.mustOwn();
      if (this.get(task.id) !== task || task.sessionId !== threadId || task.provider !== "codex" || !task.codexEditor) throw new Error("The card changed while opening its editor. Retry Resume.");
      check();
      this.gate(task, "editor"); // opening a tab yields; recheck the current policy before queueing a prompt
      this.invalidateDelivery(task);
      if (prompt) await queueCodexMessage(threadId, prompt, task.worktree);
      return undefined;
    }
    const fromEditor = task.codexEditor;
    const confirmed = task.provider === "codex" ? confirmedCodexThread(task) : undefined;
    if (fromEditor) this.checkEditorTerminalResume(task, threadId);
    if (task.provider === "codex") {
      await this.codexModelReady(task, true);
      await this.ensureCodexTrust(task); // an Entomatical update can change the hook, and so its approval
    }
    await this.settle(task);
    if (fromEditor || confirmed) {
      this.mustOwn();
      if (confirmed && (this.get(task.id) !== task || task.sessionId !== confirmed || confirmedCodexThread(task) !== confirmed)) {
        throw new Error("The confirmed Codex thread changed while preparing Resume. Check the card's session history.");
      }
      if (fromEditor) this.checkEditorTerminalResume(task, threadId);
      this.gate(task, task.cardTerminal ? "in-card" : "terminal");
    }
    check();
    this.forgetStopped(task.sessionId);
    const before = task.finishAsked ? this.events(task.id).length : undefined;
    const launchId = before === undefined ? undefined : crypto.randomUUID();
    const wait = terminalReviewWait(task) ? task.selfFinish : undefined;
    const term = this.launch(task, true, prompt, launchId);
    if (launchId) this.finishTerminalLaunches.set(term, launchId);
    if (task.finishAsked && before !== undefined) this.update(task, {
      finishAsked: { ...task.finishAsked, resume: { sessionId: threadId, before, launchId, promptHash: prompt ? sha(typedText(prompt).trim()) : undefined } },
      ...(wait ? { selfFinish: { ...wait, eventsAtWait: before, composerSubmitted: undefined, resumePromptHash: undefined } } : {}) });
    if (task.codexEditor) this.update(task, { codexEditor: undefined, codexEditorPolicy: { threadId } });
    this.invalidateDelivery(task);
    return term;
  }

  /** Continue once, then wait for the session's acknowledgement before allowing another Resume. */
  continueTask(task: Task, panel?: () => Promise<void>) { return this.launchStep(task, () => this.continueTaskNow(task, panel)); }
  private async continueTaskNow(task: Task, panel?: () => Promise<void>) {
    this.mustOwn();
    this.gate(task);
    const before = this.events(task.id).length;
    const file = this.transcriptOf(task), turns = task.provider && file ? readRollout(file)?.turns ?? 0 : 0;
    const term = this.terminal(task);
    if (term) { term.show(false); this.send(task, "Resume."); }
    else if (panel) { this.invalidateDelivery(task); await panel(); }
    else (await this.resume(task, "Resume."))?.show(false);
    for (const until = Date.now() + 15_000; Date.now() < until; await sleep(200)) {
      const transcript = this.transcriptOf(task);
      const started = this.events(task.id).slice(before).some((e) => e.hook_event_name === "UserPromptSubmit" && e.agent_id === undefined)
        || task.provider && transcript && (readRollout(transcript)?.turns ?? 0) > turns;
      if (started) { this.reconcile(task); return; }
    }
    throw new Error("Resume was sent, but the session has not confirmed a new turn. Open the session to check before retrying.");
  }

  /**
   * Moves a task to another signed-in account, for example when its account has reached a usage limit. The task's own account need
   * not be signed in any more. Between Claude accounts a started conversation moves with it: its transcript and subagent files are
   * linked into the new folder, so Resume continues it with its history. Claude, Codex, Grok and Antigravity cannot continue each other's conversations,
   * so a change of provider starts a new session in the same worktree, told that the earlier work is already there.
   * A Claude conversation whose transcript is gone (Claude deletes old ones: cleanupPeriodDays) takes that same new-session path.
   * Returns what to run next.
   */
  switchAccount(task: Task, account: string): "start" | "resume" {
    if (this.live().includes(task.id)) throw new Error(task.codexEditor ? CODEX_EDITOR_BUSY : "The session is still running. Stop it or close its panel first.");
    const fresh = this.canSwitch(task, account);
    const target = this.resolveAccount(account)!;
    this.mustOwn(); // before the transcript is carried or the events file set aside: losing SessionStart would make Resume start over
    this.gate(task, undefined, false); // an account or provider change continues the same attempt, under the same gates; the start after it takes the lease
    // The pinned profile must also hold on the target account and provider, before the transcript is carried or anything moves.
    const codex = target.provider === "codex";
    const configDir = codex ? undefined : target.configDir ?? "";
    const onTarget = task.profile && this.profileProblem({ ...task, account: target.name, provider: target.provider, configDir, sessionId: undefined, codexEditor: undefined, codexEditorPolicy: undefined });
    if (onTarget) throw new Error(onTarget);
    if (!task.adopted) this.endRun(task); // a usage run open across the move is the old account's: closed with its reading, saved by update below
    if (!target.provider && target.provider === task.provider && !fresh) {
      let transcript = task.transcript;
      const ready = !!task.sessionId && this.everReady(task); // an id whose session never came up has no conversation to carry or resume
      if (ready) {
        const dest = transcriptPath(target.configDir || DEFAULT_DIR, task.worktree ?? this.repo, task.sessionId!);
        carryTranscript(this.savedConversation(task)!, dest);
        if (task.transcript) transcript = dest;
      }
      this.update(task, { account: target.name, configDir: target.configDir ?? "", transcript, ...(task.sessionId && !ready ? { sessionId: undefined } : {}) });
      // Still in Running (Stop fires no hook): it never enters Running again, so the new account's run opens here.
      if (!task.adopted && (task.status === "running" || task.status === "needs-input")) {
        (task.usageRuns ??= []).push({ startedAt: Date.now(), start: startReading(this.usageOf(task), Date.now()) });
        this.save();
      }
      return ready ? "resume" : "start";
    }
    this.forgetCardTerminal(task.id);
    this.checks.stop(task); // its commands run against the old session's work, and the new session starts on the same worktree
    const acp = target.provider === "grok" || target.provider === "antigravity";
    // An unattended card keeps its ACP choices (acpSelections) and its Ask or Bypass. A terminal card moved to Antigravity starts on its
    // default (Opus, its newest version, at high) unless it already carries one of Antigravity's own choices (F88). Claude's opus is
    // Antigravity's opus too (fix 11).
    const agy = target.provider === "antigravity", unattended = !!(task.openedBy || task.orchestrator);
    const codexRuns = codex && task.model ? tryResolve("codex", task.model, this.codexModelIds()) : undefined;
    const model = agy && !unattended ? (antigravityModelOk(task.model) ? modelName("antigravity", task.model!) : antigravityDefault().model)
      : !acp && task.model && (codex ? !!codexRuns : MODELS.includes(task.model)) ? task.model : undefined;
    const effort = agy && !unattended ? (!antigravityTakesEffort(model) ? undefined : task.effort && ANTIGRAVITY_EFFORTS.includes(task.effort) ? task.effort : antigravityDefault().effort ?? "high")
      : !acp && task.effort && (codex ? codexEffortOk(codexRuns, task.effort) : EFFORTS.includes(task.effort)) ? task.effort : undefined;
    const permission = acp ? (unattended ? (task.permission && ACP_PERMISSIONS[task.permission] ? task.permission : undefined)
        : providerPermissionOk(target.provider as AcpProvider, task.permission) ? task.permission : undefined)
      : task.permission && (codex ? CODEX_PERMISSIONS : PERMISSIONS)[task.permission] ? task.permission : undefined;
    if (task.codexPanelBridge && task.sessionId) this.forgetPanelHook(task.sessionId);
    if (task.sessionId) {
      // The old session's events would make the new one look already started; they are kept beside it, not deleted.
      const events = this.eventsFile(task.id);
      if (fs.existsSync(events)) fs.renameSync(events, `${events}.${Date.now()}.before-switch`);
    }
    // continued: the dialog promised the note whenever the card had a session, and it must survive a reload before the new session's first prompt.
    const clearManagedAcp = (task.provider === "grok" || task.provider === "antigravity") && !task.openedBy && !task.orchestrator;
    this.update(task, { account: target.name, configDir, provider: target.provider, model, effort, permission, acpOptions: undefined, acpSelections: undefined, acpLoginId: undefined, sentModel: undefined,
      ...(clearManagedAcp ? { headless: undefined, pendingPermission: undefined } : {}),
      ...(acp ? { controller: undefined, takenOver: undefined } : {}),
      sessionId: undefined, transcript: undefined, cardTerminalStarted: undefined, codexEditor: undefined, codexEditorPolicy: undefined, codexPanelBridge: undefined, codexStopped: undefined, panel: undefined, status: "queued", continued: task.sessionId ? true : task.continued });
    return "start";
  }

  /**
   * Every refusal switchAccount can make before a session is stopped, without changing anything: the extension calls it before its
   * confirmation, so a refused move never ends a session first. True when the move starts a new session in the same worktree (another
   * provider, or a Claude conversation whose transcript is gone); the caller asks first. A running session is the caller's to stop.
   */
  canSwitch(task: Task, account: string): boolean {
    const target = this.resolveAccount(account);
    if (!target) throw new Error(`Account ${account} is not signed in. Refresh Accounts, then try again.`);
    if (["running", "needs-input"].includes(this.codexEditorStatus(task) ?? "")) throw new Error(CODEX_EDITOR_BUSY); // nothing the board can stop
    const why = this.gateProblem(task);
    if (why) throw new Error(why);
    const foundOnly = "This session was found running rather than started from the board, so it cannot move to another provider. Add a new task for it instead.";
    if (target.provider !== task.provider) {
      if (task.adopted) throw new Error(foundOnly);
      return !!task.sessionId;
    }
    if (target.provider === "codex") throw new Error("This task already runs on the Codex account.");
    if (target.provider === "grok" || target.provider === "antigravity") {
      if (target.configDir === task.configDir) throw new Error("This task already uses that account.");
      return !!task.sessionId; // provider profile credentials are not moved between accounts
    }
    const lost = !!task.sessionId && this.everReady(task) && !this.savedConversation(task);
    if (lost && task.adopted) throw new Error("This found session's saved conversation is in no account folder, so it cannot continue on another account. Add a new task for it instead.");
    return lost;
  }

  /** The task's Claude transcript: where its account says, else in whichever account folder holds it (its account may have been renamed). */
  private savedConversation(task: Task): string | undefined {
    let own: string | undefined;
    try { own = this.transcriptOf(task); } catch { own = undefined; }
    const candidates = [own, task.transcript, ...this.accountFolderList().map((d) => transcriptPath(d || DEFAULT_DIR, task.worktree ?? this.repo, task.sessionId!))];
    return candidates.find((f): f is string => !!f && fs.existsSync(f))
      // F118: or under another project folder, when the workspace folder (and so the cwd the folder is named after) was renamed.
      ?? sessionPlaces([...this.accountFolderList(), ""], task.sessionId!).transcripts.filter((f) => fs.existsSync(f)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  }

  /** Whether new Codex tasks run their first turn in the background and continue in Codex's editor. The extension sets it from entomatical.codexStart. */
  codexEditor: () => boolean = () => false;

  /** Optional private bridge in Codex's extension; undefined keeps the existing background-first-turn path. */
  startCodexPanel: (task: Task, prompt: string, launchToken: string, env: Record<string, string>, policy: CodexPermissions) => Promise<{ threadId: string; transcript?: string; completed?: boolean; status?: string; threadStatus?: { activeFlags?: string[] } } | undefined> = async () => undefined;
  stopCodexPanel: (threadId: string) => Promise<void> = async () => { throw new Error("Codex's panel bridge is unavailable"); };
  cancelCodexPanelStart: (launchToken: string) => Promise<void> = async () => {};
  panelHook = CODEX_HOOK;
  private readonly codexPanelStarts = new Map<string, { token: string; policy: CodexPermissions }>();
  private readonly codexPanelRuns = new Map<string, string>();

  /** The bridge reports its real thread before opening the panel; a stopped or deleted start may not send a prompt. */
  prepareCodexPanel(taskId: string, launchToken: string, threadId: string, transcript?: string): boolean {
    const task = this.get(taskId);
    const start = this.codexPanelStarts.get(taskId);
    if (!start || !task || task.status === "done" || task.cancelled || !this.isOwner() || start.token !== launchToken || !/^[a-zA-Z0-9-]{1,80}$/.test(threadId)) return false;
    const routes = path.join(path.dirname(this.panelHook), "panel-sessions");
    fs.mkdirSync(routes, { recursive: true, mode: 0o700 });
    writeFileAtomic(path.join(routes, `${threadId}.json`), JSON.stringify({ events: toCodexPath(this.eventsFile(task.id)) }));
    this.update(task, { sessionId: threadId, codexEditorPolicy: { threadId, sandbox: start.policy.sandbox }, ...(transcript ? { transcript: fromCodexPath(transcript) } : {}), codexPanelBridge: true });
    return true;
  }

  private forgetPanelHook(threadId: string) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(threadId)) return;
    try { fs.rmSync(path.join(path.dirname(this.panelHook), "panel-sessions", `${threadId}.json`), { force: true }); } catch { /* an in-use route can be left for the next cleanup */ }
  }

  canStartCodexPanel(taskId: string, launchToken: string, threadId: string): boolean {
    const task = this.get(taskId);
    if (!threadId || !task || task.status === "done" || task.cancelled || !this.isOwner() || this.codexPanelStarts.get(taskId)?.token !== launchToken || task.sessionId !== threadId || !this.canReopenCodexEditor(task)) return false;
    // SessionStart can fire before thread/start returns its id and the hook route exists. Fill that gap only if the real hook was missed.
    if (!this.events(task.id).some((e) => e.hook_event_name === "SessionStart" && e.session_id === threadId)) {
      fs.appendFileSync(this.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: "SessionStart", session_id: threadId,
        ...(task.transcript ? { transcript_path: task.transcript } : {}), source: "panel-bridge" }) + "\n");
    }
    return true;
  }

  /** Only status reaches the board; prompts and tool contents stay in Codex's own conversation. */
  codexPanelEvent(event: { taskId: string; threadId: string; method: string; status?: any }) {
    const task = this.get(event.taskId);
    if (!task?.codexPanelBridge || task.sessionId !== event.threadId) return;
    if (event.method === "turn/completed") {
      this.codexPanelRuns.delete(task.id);
      const interrupted = event.status !== "completed";
      this.update(task, { status: "review", interrupted: interrupted || undefined }, undefined, interrupted);
    } else if (event.method === "thread/status/changed" && event.status?.type === "active") {
      const flags = Array.isArray(event.status.activeFlags) ? event.status.activeFlags : [];
      const status = flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput") ? "needs-input" : "running";
      if (task.status !== status) this.update(task, { status });
    }
  }

  /** Starts a Codex process without a terminal. Tests replace it. */
  runCodex = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess => {
    const run = codexCommand(args, options.cwd, options.env); // wsl.exe in WSL mode; taskkill /T on it ends the Linux side too
    return spawn(run.file, run.args, { cwd: options.cwd, env: run.env, windowsHide: true, detached: process.platform !== "win32" }); // its own process group, so Stop ends its children too
  };

  private readonly codexRuns = new Map<string, { child: ChildProcess; stopTree(): void; dispose(): void }>();
  private readonly stopped = new Set<string>();
  private readonly pendingExits = new Set<() => void>();
  private static readonly waitingForExit = new Set<string>();

  /** A stop request may return before exit. On shutdown, leave a receipt for each such child, including catalog probes. */
  private watchManagedExit(task: Task, child: ChildProcess) {
    const dir = path.join(this.dir, "retiring", task.id);
    let receipt: string | undefined;
    const retire = () => {
      if (child.exitCode != null || child.signalCode != null) return;
      fs.mkdirSync(dir, { recursive: true });
      receipt = path.join(dir, crypto.randomUUID() + ".json");
      Board.waitingForExit.add(receipt);
      writeFileAtomic(receipt, JSON.stringify({ pid: child.pid ?? null }));
    };
    const exited = () => {
      child.off("exit", exited);
      child.off("close", exited);
      this.pendingExits.delete(retire);
      if (receipt) {
        Board.waitingForExit.delete(receipt);
        const file = receipt;
        this.guard(() => fs.rmSync(file, { force: true }));
      }
    };
    this.pendingExits.add(retire);
    child.once("exit", exited);
    child.once("close", exited);
  }

  private checkRetiringChildren(task: Task) {
    const dir = path.join(this.dir, "retiring", task.id);
    let files: string[];
    try { files = fs.readdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    for (const name of files) {
      const file = path.join(dir, name);
      if (!Board.waitingForExit.has(file)) {
        // Across extension hosts, only a missing PID proves exit. A reused or unqueryable PID keeps the hold.
        // Signal zero checks existence only; this receipt never authorizes signalling a process.
        try {
          const { pid } = JSON.parse(fs.readFileSync(file, "utf8"));
          if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 0);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "ENOENT") continue;
          if (code === "ESRCH") { fs.rmSync(file, { force: true }); continue; }
        }
      }
      throw new Error(`Waiting for the previous provider process to exit. If the host lost its handle, verify exit before clearing ${file}.`);
    }
  }

  /** Only the Board holding these pipes can finish the turn. Retire the handle before closing it can wake any callbacks. */
  private trackRun(task: Task, child: ChildProcess, conversation: () => string | undefined, close: () => void) {
    this.watchManagedExit(task, child);
    const launchId = task.sessionId;
    let signalled = false;
    const run = {
      child,
      current: () => this.codexRuns.get(task.id) === run,
      stopTree: (shutdown = false) => {
        if (signalled || child.exitCode != null || child.signalCode != null) return;
        signalled = true;
        this.killTree(child, shutdown);
      },
      dispose: () => {
        const sessionId = conversation();
        this.codexRuns.delete(task.id);
        this.stopped.delete(task.id);
        this.unconfirmedHeadless.delete(task.id);
        this.guard(close);
        this.guard(() => run.stopTree(true));
        const card = this.get(task.id);
        if (!card || card.cancelled || card.status === "done" || !this.isOwner()) return;
        if (this.mtime() !== this.loadedAt) return; // a successor already saved a newer board
        if (card.sessionId !== launchId && card.sessionId !== sessionId) return;
        const now = Date.now();
        fs.appendFileSync(this.eventsFile(card.id), JSON.stringify({ t: now, hook_event_name: "Interrupt", session_id: sessionId, source: "board-dispose" }) + "\n");
        // No settle listeners during shutdown. The replacement reads the receipt and the saved interruption.
        const at = new Date(now).toISOString();
        Object.assign(card, { sessionId, status: sessionId ? "review" : "queued", interrupted: true, updatedAt: at, statusAt: at });
        if (!sessionId) Object.assign(card, { transcript: undefined, codexEditor: undefined, codexEditorPolicy: undefined });
        if (sessionId && card.codexEditor) this.markStoppedEditorTurn(card);
        this.writeTasks();
      },
    };
    this.codexRuns.set(task.id, run);
    return run;
  }

  /** Tests replace this factory. Provider credentials remain owned by the CLI. */
  runAcp = startAcp;

  /** Queue an advertised model or thought-level choice for this card's next ACP turn. */
  selectAcpOption(task: Task, id: string, value: string): void {
    this.mustOwn();
    if (task.provider !== "grok" && task.provider !== "antigravity") throw new Error("This card does not use an ACP provider.");
    if (this.live().includes(task.id)) throw new Error("Wait for the current turn to finish before changing the agent configuration.");
    // The card's model and effort fields mirror the queued choice, so show and the card read what the next turn asks for.
    const field = (category?: string) => category === "model" ? "model" : category === "thought_level" ? "effort" : undefined;
    if (value === "" && Object.hasOwn(task.acpSelections ?? {}, id)) {
      const next = { ...task.acpSelections }; delete next[id];
      const f = field(task.acpOptions?.find((item) => item.id === id)?.category);
      this.update(task, { acpSelections: next, ...(f ? { [f]: undefined } : {}) });
      return;
    }
    if (task.acpOptions?.some((item) => item.id === id && item.category === "mode")) throw new Error("Agent permission modes are not yet selectable.");
    const option = task.acpOptions?.find((item) => item.id === id && (item.category === "model" || item.category === "thought_level"));
    if (!option?.values.some((item) => item.value === value)) throw new Error("That option is not currently advertised by this agent.");
    const f = field(option.category);
    this.update(task, { acpSelections: { ...task.acpSelections, [id]: value }, ...(f ? { [f]: value } : {}) });
  }

  /** ACP agents report session identity, progress and permission requests without Codex-specific hooks. */
  private async runHeadlessAcp(task: Task, resume: boolean, prompt: string): Promise<void> {
    if (task.provider !== "grok" && task.provider !== "antigravity") throw new Error("Not an ACP provider.");
    if (this.terminal(task) || this.cardTerminals.has(task.id) || this.codexRuns.has(task.id)) throw new Error("The session is already running. Stop it first.");
    if (task.sessionId && this.external.has(task.sessionId)) throw new Error("This session is still running elsewhere. Close it there first.");
    let checkRun = this.launchGuard(task);
    let session: AcpSession;
    let lastText = "", prompted = false, refused = false, unsupported: string | undefined, afterTool = false, messageStart = 0;
    // Nobody watches an unattended card (a plan step, an orchestrator or its worker): its requests go to the parent, never a modal.
    const unattended = !!(task.openedBy || task.orchestrator), readOnly = task.role === "judge" || task.role === "research";
    let inputRequest: Record<string, unknown> | undefined;
    const loginId = this.antigravityLoginId();
    const sharesCatalog = task.provider !== "antigravity" || !resume || task.acpLoginId === loginId;
    const advertised = (source?: "session/new") => {
      const options = session.options();
      if (sharesCatalog) this.rememberAcpOptions(task, options, source, loginId);
      return options;
    };
    const active = () => !!session && this.codexRuns.get(task.id)?.child === session.child && this.get(task.id) === task && this.isOwner();
    const permissionActive = () => prompted && !session.isClosed && !this.stopped.has(task.id) && active();
    const emit = (hook_event_name: string, fields: Record<string, unknown> = {}) => {
      fs.appendFileSync(this.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name, session_id: task.sessionId, source: "acp", ...fields }) + "\n");
      this.syncStatus(task.id);
    };
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Remove inherited identity, including Windows case variants, before issuing this card's controller.
    for (const key of Object.keys(env)) if (["ENTOMATICAL_SESSION", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID"].includes(key.toUpperCase())) delete env[key];
    Object.assign(env, this.taskEnv(task));
    session = this.runAcp(task.provider, task.worktree!, task.configDir, (update) => {
      if (!active() || this.stopped.has(task.id)) return;
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") {
        if (!prompted) return;
        // Text before and after a tool call are separate messages; without a break they ran together ("…now.I have…", F87).
        const text = (afterTool && lastText && !/\s$/.test(lastText) && !/^\s/.test(update.content.text) ? "\n\n" : "") + update.content.text;
        if (afterTool && lastText) messageStart = lastText.length + text.length - update.content.text.length; // the final message starts here
        afterTool = false;
        lastText += text;
        // Only public agent messages, never agent_thought_chunk or tool input. Keep partial output even if the process exits.
        fs.appendFileSync(this.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: "AcpMessageChunk", session_id: task.sessionId, source: "acp", text }) + "\n");
        this.redrawSoon();
      }
      else if (update?.sessionUpdate === "tool_call") { afterTool = true; emit("PostToolUse", { tool_name: String(update.title ?? update.name ?? "Tool") }); }
      else if (update?.sessionUpdate === "config_option_update") this.update(task, { acpOptions: advertised() });
      else if (update?.sessionUpdate === "unsupported_client_request") {
        unsupported = String(update.method ?? "unknown");
        emit("PermissionRequest", { tool_name: "Agent input", message: `Unsupported agent request: ${unsupported}` });
      }
    }, async (request) => {
      if (!permissionActive()) { refused = true; return undefined; }
      const options = Array.isArray(request.options) ? request.options.filter((o: any) => typeof o?.optionId === "string" && o.optionId && typeof o?.name === "string" && o.name.trim() && Object.hasOwn(ACP_PERMISSION_LABELS, o.kind)) : [];
      const choices = options.map((o: any) => ({ title: `${ACP_PERMISSION_LABELS[o.kind]} — ${o.name}`, id: o.optionId, kind: o.kind }));
      const call = request.toolCall;
      const title = typeof call?.title === "string" ? call.title.trim() : "";
      const tool_name = String(title || "Agent permission").slice(0, 200);
      // A judge or researcher only reads: every other tool kind is refused, and the turn goes on without it.
      if (readOnly && call?.kind !== "read") { emit("PostToolUse", { tool_name: `Refused (read-only ${task.role}): ${tool_name}` }); return undefined; }
      const allowOnce = options.filter((o: any) => o.kind === "allow_once");
      if (task.permission === "bypass" && allowOnce.length === 1) { emit("PostToolUse", { tool_name: `Allowed once (bypass): ${tool_name}` }); return allowOnce[0].optionId; }
      if (unattended) {
        // As a headless Codex approval: raise it to the parent and refuse; a follow-up or a bypass permission can supply it.
        inputRequest = { tool_name, message: `Agent requests permission: ${tool_name}` };
        emit("PermissionRequest", inputRequest);
        refused = true;
        return undefined;
      }
      emit("PermissionRequest", { tool_name, message: "Agent requests permission" });
      let input = "", content = "";
      try {
        if (meaningfulPermissionDetail(call?.rawInput)) input = JSON.stringify(call.rawInput, null, 2);
        if (Array.isArray(call?.content) && meaningfulPermissionDetail(call.content)) content = JSON.stringify(call.content, null, 2);
      } catch { /* refuse an unrepresentable request */ }
      const locations = Array.isArray(call?.locations) ? call.locations.filter((location: any) => typeof location?.path === "string" && location.path.trim()).map((location: any) => location.path) : [];
      const detail = [title, input && `Input:\n${input}`, locations.length && `Locations:\n${locations.join("\n")}`, content && `Details:\n${content}`].filter(Boolean).join("\n\n");
      // Never ask the user to approve an operation whose target/input is missing or truncated.
      const distinct = new Set(choices.map((choice: any) => choice.title)).size === choices.length && new Set(choices.map((choice: any) => choice.id)).size === choices.length;
      const picked = choices.length && distinct && title && (input || locations.length || content) && detail.length <= 4000
        ? await vscode.window.showWarningMessage(`Entomatical: ${task.title} requests permission.`, { modal: true, detail }, ...choices) : undefined;
      if (!permissionActive() || !picked || !choices.includes(picked)) { refused = true; return undefined; }
      emit("PostToolUse", { tool_name: "Permission answered" });
      if (!["allow_once", "allow_always"].includes(picked.kind)) refused = true;
      return picked.id;
    }, env);
    const child = session.child;
    let id = resume ? task.sessionId : undefined, opened = false;
    const run = this.trackRun(task, child, () => id, () => {
      try { session.cancel?.(); } finally { session.close(false); }
    });
    this.headlessStartedAt.set(task.id, Date.now());
    this.unconfirmedHeadless.add(task.id);
    this.muted.delete(task.id);
    const ensureStarting = () => {
      if (this.stopped.has(task.id) || !active())
        throw new Error("Agent start was stopped or its board ownership changed.");
      checkRun();
    };
    const recordOpen = () => {
      this.update(task, { sessionId: id, status: "running", interrupted: undefined, headless: true, acpOptions: advertised(),
        ...(!resume && task.provider === "antigravity" ? { acpLoginId: loginId } : {}) });
      opened = true;
      emit("SessionStart");
      checkRun = this.launchGuard(task); // the accepted session has replaced the allocation
    };
    try {
      id = await session.open(task.worktree!, resume ? task.sessionId : undefined);
      ensureStarting();
      // A choice queued before the account advertised anything is keyed by its category (acpSelectionsFor): find its option now.
      const optionFor = (configId: string) => session.options().find((item) => item.id === configId)
        ?? (ACP_PICKS.some(([category]) => category === configId) ? session.options().find((item) => item.category === configId) : undefined);
      // Model changes may alter the available thought levels, so apply and revalidate the model first.
      const selected = Object.entries(task.acpSelections ?? {}).sort(([a], [b]) => Number(optionFor(b)?.category === "model") - Number(optionFor(a)?.category === "model"));
      // Exact ids only (the user, 17 November 2026): a card with no model selects the exact id the session reports it is on, or is refused.
      if (!selected.some(([configId]) => optionFor(configId)?.category === "model")) selected.unshift(["model", ""]);
      // F92: the model is checked before the card records the session or any event, so a refused fresh start changes nothing on the card
      // (startHeadlessNow also removes the worktree it made). The account's catalog is still kept, so the next start refuses at once. A
      // resumed session's refusal is recorded on the card as before (StopFailure), below.
      const modelAsked = selected.find(([configId, asked]) => configId === "model" && !asked || optionFor(configId)?.category === "model")?.[1];
      if (!resume) {
        try { acpModelChoice(task.provider as AcpProvider, advertised("session/new"), modelAsked || undefined, task.account ?? "The agent"); }
        catch (e) { throw Object.assign(e as Error, { modelRefused: true }); }
      }
      if (resume || !unattended) recordOpen(); // an interactive session can be reopened even if the user stops during configuration
      for (const [configId, asked] of selected) {
        const option = optionFor(configId);
        if (configId === "model" && !asked || option?.category === "model") {
          // Fix 11: a model's short name runs the newest id of its family this session advertises.
          // A fresh start was checked above, before anything was recorded; a refusal here (a resumed session) is recorded as StopFailure.
          const pick = acpModelChoice(task.provider as AcpProvider, session.options(), asked || undefined, task.account ?? "The agent");
          await session.configure(pick.option.id, pick.value);
          ensureStarting();
          if (task.sentModel !== pick.value) this.update(task, { sentModel: pick.value });
          continue;
        }
        if (!option || option.category !== "thought_level") throw new Error(`The agent no longer offers a selectable ${configId}.`);
        if (!option.values.some((v) => v.value === asked)) throw new Error(`${task.account ?? "The agent"} does not advertise effort ${asked}. It offers: ${option.values.map((v) => v.value).join(", ") || "none"}.`);
        await session.configure(option.id, asked);
        ensureStarting();
      }
      // Ask on an unattended card: the agent's own default mode may run tools without asking (live 6 November 2026), so the board
      // selects the advertised mode that asks first (askMode), or fails the card rather than pretend.
      if (unattended && this.headlessPermission(task) === "ask") {
        const pick = askMode(session.options());
        if (!pick) throw new Error(noAskMode(task.account, session.options()));
        if (pick.option.currentValue !== pick.value) await session.configure(pick.option.id, pick.value);
        ensureStarting();
      }
      ensureStarting();
      // Configuration can await a provider or be stopped. Keep a fresh card queued until its first prompt can be submitted.
      if (!opened) recordOpen();
      else this.update(task, { status: "running", acpOptions: advertised() });
      emit("UserPromptSubmit", { prompt });
      prompted = true;
      this.sentPrompt(task);
    } catch (error) {
      if (!run.current()) throw error;
      this.codexRuns.delete(task.id);
      const stopped = this.stopped.delete(task.id);
      this.unconfirmedHeadless.delete(task.id);
      if (opened && this.get(task.id) === task && this.isOwner()) emit(stopped ? "Interrupt" : "StopFailure", stopped ? {} : { error: error instanceof Error ? error.message : "Agent session configuration failed" });
      // F92: a refused fresh start removes its worktree next; the agent must have let go of the folder first (5 s at most).
      const exited = Board.modelRefusal(error) && child.exitCode == null && child.signalCode == null
        ? new Promise<void>((resolve) => { const timer = setTimeout(resolve, 5000); child.once("exit", () => { clearTimeout(timer); resolve(); }); }) : undefined;
      run.stopTree();
      session.close(false);
      await exited;
      throw error;
    }
    void session.prompt(prompt).then((reason) => {
      prompted = false;
      if (!active()) return;
      if (this.stopped.delete(task.id)) emit("Interrupt");
      else if (inputRequest) emit("PermissionRequest", inputRequest); // later events must not hide the unanswered request (as Codex)
      // The whole turn's text is the reply Finish uses; the card's headline is the last message, as a Claude card's is.
      else if (reason === "end_turn" && !refused && !unsupported) emit("Stop", { last_assistant_message: lastText, last_message: lastText.slice(messageStart) });
      else if (reason === "cancelled") emit("Interrupt");
      else emit("StopFailure", { error: unsupported ? `Unsupported agent request: ${unsupported}` : refused ? "The agent's permission request was not approved." : `Agent turn ended: ${reason}` });
    }, (error) => {
      prompted = false;
      if (!active()) return;
      if (this.stopped.delete(task.id)) emit("Interrupt");
      else if (inputRequest) emit("PermissionRequest", inputRequest);
      else emit("StopFailure", { error: error instanceof Error ? error.message : "Agent turn failed" });
    }).finally(() => {
      if (!run.current()) return;
      this.codexRuns.delete(task.id);
      run.stopTree();
      session.close(false);
      if (this.get(task.id) !== task || !this.isOwner()) return;
      this.changed.fire();
      this.deliverNotices(task.id);
    });
  }

  /**
   * Managed Codex turns use the app-server's events directly. They need neither an editor tab nor separately trusted hooks;
   * the thread id is retained for the next turn and Stop owns the same process tree as an editor first turn.
   */
  private runHeadlessCodex(task: Task, resume: boolean, prompt: string): Promise<void> {
    if (this.terminal(task) || this.cardTerminals.has(task.id) || this.codexRuns.has(task.id)) throw new Error("The session is already running. Stop it first.");
    if (task.sessionId && this.external.has(task.sessionId)) throw new Error("This session is still running elsewhere. Close it there first.");
    const policy = codexThreadPermissions(task);
    const model = this.codexSend(task, resume); // fix 11: the newest id of the card's family; a resumed thread keeps its own
    const log = path.join(this.dir, "codex", `${task.id}.log`);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const effort = task.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(task.effort)}`] : [];
    const checkRun = this.launchGuard(task);
    const child = this.runCodex(["app-server", ...effort], { cwd: task.worktree!, env: { ...process.env, ...this.taskEnv(task) } });
    this.headlessStartedAt.set(task.id, Date.now());
    this.unconfirmedHeadless.add(task.id);
    this.muted.delete(task.id);
    const out = fs.createWriteStream(log, { flags: "a" });
    child.stderr?.pipe(out, { end: false });
    child.stdin?.on("error", () => {});
    out.on("error", () => {});
    let accepted = false, completed = false, needsInput = false, lastText = "", problem: string | undefined;
    let inputRequest: Record<string, unknown> | undefined;
    let outcome: "Stop" | "StopFailure" | "Interrupt" = "Interrupt";
    let thread = resume ? task.sessionId : undefined;
    const emit = (hook_event_name: string, fields: Record<string, unknown> = {}) => {
      fs.appendFileSync(this.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name, session_id: thread, source: "app-server", ...fields }) + "\n");
      this.syncStatus(task.id);
    };
    const rpc = rpcClient(child, (method, params) => {
      if (method !== "item/completed" && method !== "turn/completed") return;
      if (!run.current() || !this.isOwner()) return;
      if (params?.threadId && thread && params.threadId !== thread) return;
      if (method === "item/completed") {
        const item = params?.item;
        if (item?.type === "agentMessage" && typeof item.text === "string") lastText = item.text;
        else if (item?.type) emit("PostToolUse", { tool_name: item.type });
      }
      if (method === "turn/completed") {
        completed = true;
        const status = params?.turn?.status;
        outcome = status === "completed" ? "Stop" : status === "interrupted" ? "Interrupt" : "StopFailure";
        if (outcome === "StopFailure") problem = params?.turn?.error?.message ?? `Codex turn ${status ?? "failed"}`;
        run.end();
      }
    }, true, (method, params) => {
      // Even a bypass run can need connector consent or an answer to a question. Surface it to the parent before refusing the
      // unattended request; do not silently hang or manufacture an approval. A follow-up can supply the missing information.
      if (!run.current() || !this.isOwner()) return;
      needsInput = true;
      inputRequest = { tool_name: method, message: String(params?.reason ?? params?.message ?? "Child needs input") };
      emit("PermissionRequest", inputRequest);
    });
    const run = this.trackAppServer(task, child, () => thread, rpc, out);
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { problem = "Codex did not start a turn within 30 seconds"; reject(new Error(problem)); run.end(); }, 30_000);
      timeout.unref?.();
      (async () => {
        await rpc.request("initialize", { clientInfo: { name: "entomatical", version: "1" }, capabilities: {} });
        run.ensureActive();
        checkRun();
        rpc.notify("initialized");
        const started = await rpc.request(resume ? "thread/resume" : "thread/start", {
          ...(resume ? { threadId: task.sessionId, excludeTurns: true } : {}), cwd: toCodexPath(task.worktree!),
          ...(model ? { model } : {}), ...policy,
        });
        run.ensureActive();
        checkRun();
        const id = started?.thread?.id;
        if (typeof id !== "string" || !id) throw new Error("Codex reported no thread");
        thread = id;
        const card = this.get(task.id);
        if (!card) throw new Error("The card was removed during launch");
        if (card.named && card.title.trim()) await rpc.request("thread/name/set", { threadId: thread, name: card.title.trim() }).catch(() => {});
        run.ensureActive();
        checkRun();
        this.update(card, { sessionId: thread, headless: true,
          ...(typeof started.thread.path === "string" ? { transcript: fromCodexPath(started.thread.path) } : {}) });
        await rpc.request("turn/start", { threadId: thread, input: [{ type: "text", text: prompt }], ...(task.effort ? { effort: task.effort } : {}) });
        run.ensureActive();
        accepted = true;
        emit("SessionStart");
        if (!needsInput) emit("UserPromptSubmit");
        this.sentPrompt(card);
        resolve();
      })().catch((error) => { problem = error instanceof Error ? error.message : String(error); reject(new Error(problem)); run.end(); })
        .finally(() => clearTimeout(timeout));
      child.on("error", (error) => { problem = error.message; clearTimeout(timeout); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (!run.current()) return;
        rpc.close(new Error(problem ?? `Codex closed before completing the turn (exit ${code})`));
        this.codexRuns.delete(task.id);
        this.unconfirmedHeadless.delete(task.id);
        const card = this.get(task.id), stopped = this.stopped.delete(task.id);
        out.end();
        if (!card || !this.isOwner()) { reject(new Error("Codex card or board ownership changed.")); return; }
        if (!accepted) {
          if (!resume && card === task && thread && card.sessionId === thread) this.update(card, { sessionId: undefined, transcript: undefined });
          reject(new Error(problem ?? `Codex exited before starting a turn (exit ${code})`));
        } else if (stopped || !needsInput) {
          emit(stopped || !completed ? "Interrupt" : outcome, {
            ...(lastText ? { last_assistant_message: lastText } : {}), ...(problem ? { error: problem } : {}),
          });
        } else emit("PermissionRequest", inputRequest); // later tool events must not hide an unanswered request
        this.changed.fire();
        this.deliverNotices(task.id);
      });
    });
    this.changed.fire();
    return ready;
  }

  private trackAppServer(task: Task, child: ChildProcess, conversation: () => string | undefined, rpc: ReturnType<typeof rpcClient>, out: fs.WriteStream) {
    let ending = false;
    const run = this.trackRun(task, child, conversation, () => {
      rpc.close(new Error("The board closed during the Codex turn."));
      if (!child.stdin?.writableEnded) child.stdin?.end();
      child.stderr?.unpipe(out);
      if (!out.writableEnded) out.end();
    });
    return {
      current: run.current,
      ensureActive: () => {
        if (!run.current() || this.stopped.has(task.id) || !this.isOwner()) throw new Error("Codex start was stopped or its board ownership changed.");
      },
      end: () => {
        if (ending || !run.current()) return;
        ending = true;
        child.stdin?.end();
        setTimeout(() => { if (run.current()) run.stopTree(); }, 5000).unref?.();
      },
    };
  }

  /**
   * The Codex extension offers no way to start a chat with a prompt in a chosen folder, so the first turn runs in the background
   * through `codex app-server`, the protocol the extension itself uses: a thread started in the task's worktree, the card's title put
   * on it, then the turn with the prompt, with the same approved hooks reporting to the card. Such a thread has source "vscode", so
   * Codex's editor lists it and titles its tab with the thread's name; a `codex exec` thread (source "exec", until 2 November 2026)
   * was left out of that lookup and its tab read "Codex" (Codex extension 26.1021.22027). The turn uses the card's effective sandbox and
   * approval "never": nobody is there to answer. When it ends, the conversation opens in Codex's editor, which resumes it in the
   * thread's own folder.
   */
  private runFirstCodexTurn(task: Task, policy: CodexPermissions) {
    this.mustOwn(); // the panel lookup may have outlived its host
    const model = this.codexSend(task); // fix 11: the newest id of the card's family
    const startedAt = Date.now();
    const log = path.join(this.dir, "codex", `${task.id}.log`);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const out = fs.createWriteStream(log);
    const effort = task.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(task.effort)}`] : [];
    const child = this.runCodex(["app-server", ...effort, ...hookArgs()], { cwd: task.worktree!, env: { ...process.env, ...this.taskEnv(task) } });
    child.stderr?.pipe(out, { end: false });
    child.stdin?.on("error", () => {}); // a CLI that exits at once closes stdin; the exit handler reports it
    out.on("error", () => {}); // a log that cannot be written must not take the extension down; the turn still ends below
    let problem: string | undefined;
    let finished = false, thread: string | undefined;
    const rpc = rpcClient(child, (method, params) => {
      if (method.endsWith("/delta") || !run.current() || !this.isOwner()) return;
      out.write(JSON.stringify({ method, params }) + "\n"); // the turn's progress; deltas only repeat it
      if (method === "turn/completed") { finished = true; run.end(); }
    }, true);
    const run = this.trackAppServer(task, child, () => thread ?? codexThread(this.events(task.id).filter(e => e.t >= startedAt && typeof e.transcript_path === "string")), rpc, out);
    const prompt = this.promptFor(task);
    (async () => {
      await rpc.request("initialize", { clientInfo: { name: "entomatical", version: "1" }, capabilities: {} });
      run.ensureActive();
      rpc.notify("initialized");
      const started = await rpc.request("thread/start", { cwd: toCodexPath(task.worktree!), ...(model ? { model } : {}), ...policy });
      run.ensureActive();
      const id = started?.thread?.id;
      if (typeof id !== "string" || !id) throw new Error("Codex reported no thread");
      thread = id;
      // The real id and rollout now, not when SessionStart arrives: Open, Stop and the rollout checks all go by them.
      const card = this.get(task.id);
      if (card) this.update(card, { sessionId: thread, codexEditorPolicy: { threadId: thread, sandbox: policy.sandbox }, ...(typeof started.thread.path === "string" ? { transcript: fromCodexPath(started.thread.path) } : {}) });
      // The tab title: Codex's editor reads the thread's name when the tab opens. Only a typed or generated title; a title taken from
      // the prompt would hide Codex's own naming (see nameThread). A refused name is not worth stopping the turn for.
      if (card?.named && card.title.trim()) await rpc.request("thread/name/set", { threadId: thread, name: card.title.trim() }).catch(() => {});
      run.ensureActive();
      const current = this.get(task.id);
      if (!current || current.sessionId !== thread || !this.canReopenCodexEditor(current)) throw new Error("The card changed before its first prompt. Retry with its current permissions.");
      await rpc.request("turn/start", { threadId: thread, input: [{ type: "text", text: prompt }] }); // the prompt: no quoting or length limit
      run.ensureActive();
      this.sentPrompt(task);
    })().catch((e) => { problem ??= `could not start the turn (${e instanceof Error ? e.message : String(e)})`; run.end(); });
    child.on("error", (e) => { problem = `could not start (${e.message})`; });
    // "exit" can come before the last output is read, and the log is written asynchronously. "close" comes once stdout and stderr have
    // ended (also after a failed start), and the turn ends only when the log is complete on disk, so the warning that names it is true.
    child.on("close", (code) => {
      if (!run.current()) return;
      if (!finished && code !== 0) problem ??= `ended with exit code ${code}`; // before the failed requests report "Codex closed"
      rpc.close(new Error("Codex closed."));
      out.end(() => {
        if (!run.current()) return;
        this.codexRuns.delete(task.id);
        if (!this.isOwner()) return;
        // By id, not by object: a reload() during the turn (another window saved tasks.json) replaces every task object with a new one.
        const card = this.get(task.id);
        if (!card) { this.stopped.delete(task.id); this.changed.fire(); return; } // deleted meanwhile: nothing to reset or open
        // With no SessionStart Codex made no conversation to resume (signed out, bad model, a crash, or Stop), so the card goes back to unstarted and
        // shows Start again; otherwise it keeps a made-up id that Resume can never open. A moved task's continuation prompt is kept for that Start.
        const stopped = this.stopped.delete(card.id);
        if (!this.events(card.id).some((e) => e.hook_event_name === "SessionStart")) {
          const continuation = this.unconfirmed.get(card.id);
          if (continuation !== undefined && !this.continuations.has(card.id)) this.continuations.set(card.id, continuation);
          this.unconfirmed.delete(card.id); // context is re-read on the next start, rather than saved in the continuation
          this.update(card, { sessionId: undefined, transcript: undefined, codexEditor: undefined, codexEditorPolicy: undefined, status: "queued" });
        } else if (stopped) {
          // Stop ends the process at once, before Codex closes its turn in the rollout, which then reads as running for good: the card stayed
          // in Running with Open, and Merge and Discard were hidden (seen 31 October 2026 on Windows). The cut-off turn is remembered.
          if (this.markStoppedEditorTurn(card)) this.save();
        }
        this.changed.fire();
        if (stopped) return;
        if (problem) return void vscode.window.showWarningMessage(`Entomatical: Codex's first turn on "${card.title}" ${problem}. Its output is in ${log}.`);
        // The name again, in case the title changed during the turn, so the tab opens with it.
        const open = () => {
          if (this.isOwner()) return this.openInCodex(card, true).catch((e) => vscode.window.showWarningMessage(`Entomatical: ${e instanceof Error ? e.message : String(e)}`));
        };
        if (card.named) void this.nameThread(card).then(open, open); else void open();
      });
    });
    this.changed.fire();
  }

  /** Opens the task's Codex conversation in Codex's own editor tab (its `openai-codex://route/local/<thread>` address). */
  openInCodex(task: Task, preserveFocus = false) { return this.launchStep(task, () => this.openInCodexNow(task, preserveFocus)); }
  private async openInCodexNow(task: Task, preserveFocus = false) {
    if (this.codexRuns.has(task.id)) throw new Error("Codex is still on the first turn, in the background. The conversation opens in Codex's editor when that turn ends.");
    if (!confirmedCodexThread(task) && !this.events(task.id).some((e) => e.hook_event_name === "SessionStart")) throw new Error("Codex has not reported this task's conversation yet.");
    this.gate(task, "editor");
    const uri = vscode.Uri.from({ scheme: "openai-codex", authority: "route", path: `/local/${task.sessionId}` });
    await vscode.commands.executeCommand("vscode.openWith", uri, "chatgpt.conversationEditor", { preview: false, preserveFocus });
  }

  /**
   * Codex's editor titles a tab only when it opens, from the thread's name, so a renamed thread's open tab is closed and opened
   * again. True when a tab was open.
   */
  async reopenInCodex(task: Task): Promise<boolean> {
    const Custom = (vscode as any).TabInputCustom;
    const groups = [...(vscode.window.tabGroups?.all ?? [])] as any[];
    const open = groups.flatMap((g) => g.tabs).filter((tab) => Custom && tab.input instanceof Custom
      && tab.input.uri.scheme === "openai-codex" && tab.input.uri.path === `/local/${task.sessionId}`);
    if (!open.length) return false;
    this.gate(task, "editor"); // refuse an incompatible saved thread before closing its existing tab
    await vscode.window.tabGroups.close(open);
    await this.openInCodex(task);
    return true;
  }

  /**
   * Ends a task's session that runs outside the board's terminals, such as a Claude panel of this window (its pid is in the CLI's
   * session list). The CLI exits on SIGTERM and leaves that list, which `ended` waits for. the user, 30 October 2026: Switch account
   * stops a panel session itself instead of asking for the panel to be closed first.
   */
  killSession(task: Task) {
    const live = task.sessionId ? this.external.get(task.sessionId) : undefined;
    // A stale or malformed session record must never terminate this extension host.
    if (!live?.pid || live.pid === process.pid) return false;
    if (task.provider === "codex" || live.provider === "codex") {
      if (task.provider !== live.provider || !stopCodexWriter(live)) {
        void vscode.window.showWarningMessage("Entomatical could not safely stop this Codex session. Stop it in its original terminal.");
        return false;
      }
    } else if (process.platform === "win32") execFile("taskkill", ["/PID", String(live.pid), "/T", "/F"], { windowsHide: true }, () => {});
    else try { process.kill(live.pid, "SIGTERM"); } catch { /* already gone */ }
    this.ending.set(task.sessionId!, Date.now());
    this.stoppedSessions.set(`${live.pid}:${live.sessionId}`, Date.now()); // as stop(): a file left behind under a reused pid is not a live session
    this.noteClosing(task, live); // M-02: Finish asks about this exact process before the worktree goes
    return true;
  }

  /**
   * M-02: Finish's fallback for an idle panel session whose tab closed while its CLI stayed. It is ended as Switch account ends one,
   * but only while its process is still the one its session file names, by pid and start time. A pid that went to another process is
   * not ended, and the file it left stops counting as a session. A file that names no start is ended by its pid, as before. One
   * whose start cannot be read, or differs while the CLI's form is not known yet (ownerNow), is neither ended nor passed over:
   * Finish then stops at its limit and says so.
   */
  private async endIdleSession(task: Task) {
    const live = task.sessionId ? this.external.get(task.sessionId) : undefined;
    if (!live?.pid) return;
    const state = live.procStart ? await this.ownerNow({ pid: live.pid, started: live.procStart, what: "" }) : "running";
    if (state === "running") this.killSession(task);
    // Its file outlived it: stamped as stopped past scan's 15 s, so it is no live session (forgetStopped drops the stamp after an hour).
    else if (state === "exited") this.stoppedSessions.set(`${live.pid}:${live.sessionId}`, Date.now() - 16_000);
  }

  /** Ends the task's session: its terminal, or its background first turn with everything it started. */
  /**
   * Session files of processes this board's Stop ended ("pid:session id"), with when. A CLI ended before it removed its file leaves one behind,
   * and Windows soon gives its pid to another process, which would read as the session still running; past 15 s it has exited (settle).
   */
  private readonly stoppedSessions = new Map<string, number>();
  /** A session started or resumed again is live, whatever pid it got: Windows can hand it the stopped process's pid. */
  private forgetStopped(sessionId?: string) {
    for (const [key, at] of this.stoppedSessions) if (key.endsWith(`:${sessionId}`) || Date.now() - at > 3600_000) this.stoppedSessions.delete(key);
  }

  stop(task: Task) {
    if (this.cardTerminals.has(task.id) && !this.terminal(task)) { this.cardTerminals.stop(task.id); return; } // a Grok/Antigravity card terminal; a Claude/Codex one (F89) stops as a terminal below
    const startToken = this.codexPanelStarts.get(task.id)?.token;
    if (startToken && this.codexPanelStarts.delete(task.id)) {
      void this.cancelCodexPanelStart(startToken).catch((e) => vscode.window.showWarningMessage(`Entomatical: could not cancel Codex's panel start: ${e instanceof Error ? e.message : String(e)}`));
      if (task.codexPanelBridge) this.update(task, { status: "review", interrupted: true }, undefined, true);
      else this.update(task, { sessionId: undefined, codexEditor: undefined, codexEditorPolicy: undefined, status: "queued" });
      this.changed.fire();
      return;
    }
    const panelThread = this.codexPanelRuns.get(task.id);
    if (panelThread) {
      void this.stopCodexPanel(panelThread).catch((e) => vscode.window.showWarningMessage(`Entomatical: could not stop Codex's panel turn: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    const live = task.sessionId ? this.external.get(task.sessionId) : undefined;
    const terminal = this.terminal(task);
    if (live && this.terminal(task)) { this.stoppedSessions.set(`${live.pid}:${live.sessionId}`, Date.now()); this.noteClosing(task, live); }
    if (task.sessionId && this.terminal(task)) this.ending.set(task.sessionId, Date.now());
    this.terminal(task)?.dispose();
    const run = this.codexRuns.get(task.id);
    if (!run?.child.pid) {
      if (live && !terminal) this.killSession(task);
      else if (!run && !terminal && task.status === "needs-input" && !(task.provider === "codex" && task.worktree && this.unresolvedCodex.has(task.worktree)) && !this.live().includes(task.id))
        this.update(task, { status: "review", interrupted: true }, undefined, true);
      return;
    }
    this.stopped.add(task.id);
    run.stopTree();
  }

  /**
   * Ends a background Codex process with its whole tree, so Codex's children end too. A process taskkill cannot see (already gone,
   * or a stand-in) falls back to kill(), as the Linux branch does when its process group is missing.
   */
  private killTree(child: ChildProcess, shutdown = false) {
    if (!child.pid) return;
    if (process.platform === "win32") execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, (err) => { if (err) try { child.kill(); } catch { /* already gone */ } });
    else {
      const signal = shutdown ? "SIGKILL" : "SIGTERM";
      try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
    }
  }

  private markStoppedEditorTurn(task: Task): boolean {
    const file = this.transcriptOf(task), rollout = file ? readRollout(file) : undefined;
    if (rollout?.turn !== "running") return false;
    task.codexStopped = rollout.turns;
    return true;
  }

  /** A Codex task handed to Codex's editor has no process the board can see; its rollout file says whether a turn is running. */
  private codexEditorStatus(task: Task): Status | undefined {
    if (!task.codexEditor || task.adopted || this.codexRuns.has(task.id) || this.terminal(task)) return undefined;
    const file = this.transcriptOf(task);
    const rollout = file ? readRollout(file) : undefined;
    if (!rollout || (rollout.turn === "running" && rollout.turns === task.codexStopped)) return undefined; // the turn Stop cut off is over
    const status = rolloutStatus(rollout);
    return status === "review" && this.busySubagents(task) ? "running" : status;
  }

  /** The composer waits for submission before recording new work. Background callers can still schedule terminal input synchronously. */
  send(task: Task, text: string, newWork = true, confirmation?: TerminalSubmission): Promise<unknown> | undefined {
    if (this.codexRuns.has(task.id)) throw new Error("Codex is on its first turn in the background. Follow up in Codex's editor once it opens.");
    if (this.codexPanelStarts.has(task.id) || this.codexPanelRuns.has(task.id)) throw new Error("Follow up in Codex's panel while its first turn runs.");
    const term = this.terminal(task);
    if (!term && task.headless && !task.takenOver && task.sessionId) return this.followUpHeadless(task, text, newWork);
    if (!term) throw new Error("No live session. Resume it first.");
    this.gate(task); // a follow-up is a dispatch too
    // Keystrokes sent into a permission menu could pick an option, so follow-ups wait until it is answered.
    const blocked = this.terminalSendBlocked(task, term, confirmation);
    if (blocked) throw new Error(typeof blocked === "string" ? blocked : "The session is waiting on a prompt. Answer it in the terminal first.");
    if (!confirmation && newWork) this.invalidateDelivery(task);
    const submitted = this.typeInto(task, term, text, confirmation);
    if (confirmation && newWork) return Promise.resolve(submitted).then(() => this.invalidateDelivery(task));
    return submitted;
  }
  private terminalSendBlocked(task: Task, term: vscode.Terminal, confirmation?: TerminalSubmission): boolean | string {
    const launchId = task.finishAsked?.resume?.launchId;
    if (launchId && this.finishTerminalLaunches.get(term) !== launchId
      && (term.creationOptions as vscode.TerminalOptions | undefined)?.env?.ENTOMATICAL_TERMINAL_LAUNCH !== launchId)
      return "Finish cannot identify this terminal. Close it and use Resume to open a terminal for this request.";
    const history = this.events(task.id);
    const events = finishEvents(task, history);
    if (clearedSession(task, events)) return true; // the watcher has yet to adopt the terminal's replacement session
    const waits = this.approvalWaits(task, history);
    if (waits.session || waits.children.length) return true;
    const resume = finishResume(task);
    if (resume && !launchId) return "This saved Finish predates terminal launch IDs. Close the terminal and use Resume so Finish can verify its Stop.";
    const current = resume ? events.slice(resume.before) : events;
    const boundary = sessionBoundary(current, task.sessionId);
    if (current[boundary]?.hook_event_name === "SessionEnd") return true;
    if (confirmation === "automatic-submit") {
      if (task.status !== "review") return true;
    } else if (terminalReviewWait(task)) {
      if (confirmation !== "confirm-submit") return true;
    } else {
      if (task.status === "needs-input") return true;
      if (!resume) return false;
    }
    if (!task.sessionId || task.refusalStop) return true;
    const owner = current.slice(Math.max(boundary, 0)).filter(e => e.session_id === task.sessionId && e.agent_id === undefined);
    const last = owner.findLast(e => e.hook_event_name === "SessionStart" || STATUS_BY_EVENT[e.hook_event_name ?? ""]);
    if (!last) return true;
    if (last.hook_event_name !== "Stop") {
      const escaped = last.hook_event_name === "Interrupt" && task.provider === "codex" && task.interrupted && task.status === "review";
      if (!escaped || !resume || !launchId || confirmation !== "confirm-submit" || !owner.some(e => e.hook_event_name === "Stop")) return true;
    }
    const live = this.external.get(task.sessionId);
    return this.busySubagents(task)
      || !!live && statusOf(live) !== "review" && (live.statusUpdatedAt ?? Infinity) >= last.t;
  }
  /** Types a message into the task's terminal and sends it, as a follow-up is sent. */
  private typeInto(task: Task, term: vscode.Terminal, text: string, confirmation?: TerminalSubmission) {
    const check = confirmation === "automatic-submit" ? this.launchGuard(task) : undefined;
    const wait = confirmation === "confirm-submit" && terminalReviewWait(task) ? task.selfFinish : undefined;
    const submit = (keys: string) => {
      // A confirmed composer submission is human input even if the provider omits the prompt or echoes reserved markup.
      const cursor = wait ? this.events(task.id).length : undefined;
      term.sendText(keys, false);
      if (wait && cursor !== undefined) this.update(task, { selfFinish: { ...wait, eventsAtWait: cursor, composerSubmitted: true } });
    };
    if (task.provider === "codex" && process.platform === "win32") {
      // Codex on Windows reads a paste as a fast burst of keys and takes an Enter within 120 ms of it as a new line (codex-rs
      // tui/src/bottom_pane/paste_burst.rs, PASTE_ENTER_SUPPRESS_WINDOW), so a follow-up sent with its Enter sat unsent in Codex's
      // box (seen 31 October 2026, codex-cli 0.164.0-alpha.11.1). The Enter goes on its own once the burst is over, unless an
      // approval prompt came up meanwhile (the Enter would answer it) or the terminal closed.
      const session = task.sessionId, boundary = sessionBoundary(finishEvents(task, this.events(task.id)), session);
      term.sendText(paste(text).slice(0, -1), false);
      const enter = () => {
        check?.();
        const current = this.get(task.id);
        if (current !== task || current.sessionId !== session || this.terminal(current) !== term) return false;
        if (sessionBoundary(finishEvents(task, this.events(task.id)), session) !== boundary || (wait && (current.selfFinish !== wait || !terminalReviewWait(current)))) return false;
        if (this.terminalSendBlocked(current, term, confirmation)) return false;
        submit("\r");
        return true;
      };
      if (confirmation) return sleep(this.codexEnterMs).then(() => {
        if (!enter()) throw new Error("Enter was withheld because the follow-up terminal closed, changed, or is waiting for input.");
      });
      setTimeout(enter, this.codexEnterMs).unref?.();
      return;
    }
    submit(paste(text));
  }

  /** Fix it's prompt: which acceptance check failed, what it said and where its whole log is (the user, 4 November 2026). */
  fixPrompt(task: Task): string {
    const f = task.checks?.status === "error" ? task.checks.failure : undefined;
    if (!f) throw new Error("This card has no failed acceptance check to fix.");
    return [
      `The acceptance check \`${f.command}\` failed (exit ${f.exitCode}) in this task's worktree.`,
      f.lines.length ? `Lines naming the failure:\n${f.lines.join("\n")}` : "",
      f.tail ? `End of its output:\n${f.tail}` : "",
      `Full log: ${f.log}`,
      `Find the cause and fix it, then run \`${f.command}\` again until it passes. Entomatical runs the acceptance checks again when your work comes back to Review.`,
    ].filter(Boolean).join("\n\n");
  }

  /**
   * Fix it: sends fixPrompt to the task's session. The board's own live terminal gets it at once; an ended Claude terminal session is
   * resumed and gets it once it is up. A session the board cannot type into (a Claude panel, Codex's editor or first turn, another
   * window) returns "paste": the caller puts the prompt on the clipboard.
   * shortcut: a Claude panel session gets no typed prompt, only the clipboard; upgrade by having the wrapper inject it on resume.
   */
  async fixChecks(task: Task): Promise<"sent" | "resumed" | "paste"> {
    return this.sendPrompt(task, this.fixPrompt(task));
  }

  /** Fix it's and Review's delivery: a headless card not taken over gets a headless follow-up; the rest as fixChecks described. */
  async sendPrompt(task: Task, prompt: string): Promise<"sent" | "resumed" | "paste"> {
    this.mustOwn();
    if (task.headless && !task.takenOver) { await this.followUpHeadless(task, prompt); return "sent"; }
    if (this.terminal(task)) { this.send(task, prompt); return "sent"; }
    const elsewhere = task.panel || task.codexEditor || !!task.provider || this.codexRuns.has(task.id) || (!!task.sessionId && this.external.has(task.sessionId));
    if (elsewhere || !task.sessionId || !this.everReady(task)) return "paste";
    return (await this.resumeAndSend(task, prompt)) ? "resumed" : "paste";
  }

  /** How long after a follow-up's text a Codex terminal on Windows gets its Enter (see send). Tests shorten it. */
  codexEnterMs = 500;

  // ---- The orchestrator (spec 4.1 to 4.3, 4.7, section 8, 13.1 to 13.2; F69, F71, F75, F76). The rules are in src/orchestrator.ts. ----

  /** entomatical.orchestrator.enabled; set by the extension. */
  orchestratorEnabled: () => boolean = () => true;
  /** entomatical.deliver.everyTurns (extension.ts): deliver a card's work to the main folder every N turns; 0 = only Finish does. */
  deliverEveryTurns: () => number = () => 3;
  deliveryPollMs = 500;
  /** One delivery at a time for the whole board: each waits for the one before it. */
  private deliveries: Promise<void> = Promise.resolve();
  private readonly deliveryQueued = new Set<string>();
  /** The delivery running git now, with the checkout it writes (checkoutId); Finish, Merge and Discard wait for it, and Delete of its card is refused. */
  private deliveryRunning?: { id: string; target: string; done: Promise<unknown> };

  /**
   * Left out: no worktree or branch, a branch that is not this board's task/ branch in its .entomatical/wt, a done card, and a plan
   * card, a workflow step or a card an orchestrator opened (openedBy: its run brings the work together itself).
   */
  deliverable(t: Task): boolean {
    return !!t.worktree && !!t.branch?.startsWith("task/") && path.dirname(t.worktree) === path.join(this.dir, "wt")
      && t.status !== "done" && !t.finishAsked?.reviewInterrupted && !t.openedBy && !t.planRun && !t.workflow && !governedRootOf(t, this.tasks); // phase 3: no governed card, root included
  }
  /**
   * Cards whose waiting work the board counts and shows (F108): a worktree and branch, not done, not a workflow step, and not a step of
   * a plan run (opened by a card whose run is a plan, or by a card no longer on the board: its run brings its steps together). Wider than
   * deliverable(): a card an orchestrator opened, the plan card itself and a branch outside task/ are never delivered by themselves, so
   * their waiting work shows too. Ported from task/c887fd (ebf2d03) onto this board's delivery code, 16 November 2026.
   */
  countsWork(t: Task): boolean {
    if (!t.worktree || !t.branch || t.status === "done" || t.workflow) return false;
    if (!t.openedBy) return true;
    const master = masterOf(t, this.tasks);
    return !!master && master.id !== t.id && !master.planRun;
  }

  private deliveryTrigger(task: Task, event: "turn" | "review") {
    // F108: every finished turn counts, whatever everyTurns says and whether or not the card delivers.
    const turn = event === "turn";
    if (turn) task.turns = (task.turns ?? 0) + 1;
    const due = this.deliverable(task) ? deliveryDue(this.deliverEveryTurns(), task.deliveryTurns ?? 0, event) : undefined;
    if (due && (task.deliveryTurns ?? 0) !== due.turns) { task.deliveryTurns = due.turns || undefined; this.save(); }
    else if (turn) this.writeTasks(); // not save(): its status publish here, inside a status listener, would wake a master out of turn
    if (due?.deliver && !this.deliveryQueued.has(task.id)) {
      this.deliveryQueued.add(task.id);
      this.deliveries = this.deliveries.then(() => this.deliverNow(task)).catch((e) => console.error("Entomatical: deliver", e));
    }
  }

  /** Waits for every Finish to leave (one may be merging into the main checkout); Finish, Merge or Discard of this card does it all. */
  private async deliverNow(task: Task) {
    while (this.completing.size && !this.completing.has(task.id)) await sleep(this.deliveryPollMs);
    this.deliveryQueued.delete(task.id);
    if (this.get(task.id) !== task || this.completing.has(task.id) || !this.deliverable(task) || !this.isOwner()) return;
    const target = checkoutId(this.repo); // which checkout this delivery writes: on the running delivery and in the card's event
    const done = deliver(this.repo, task.worktree!, task.branch!, task.title, task.turns);
    this.deliveryRunning = { id: task.id, target, done };
    let r: Delivery;
    try { r = await done; } catch (e) { r = { refused: e instanceof Error ? e.message : String(e) }; } finally { this.deliveryRunning = undefined; }
    if ("nothing" in r || this.get(task.id) !== task) return;
    const at = new Date().toISOString();
    task.delivery = "delivered" in r ? { at, sha: r.delivered, files: r.files } : { at, refused: r.refused };
    try { fs.appendFileSync(this.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: "Delivery", ...r, target }) + "\n"); } catch { /* no events folder yet */ }
    try { this.save(); } catch (e) { console.error("Entomatical: deliver", e); } // the window gave up the board
    this.changed.fire();
    void this.refreshNotInMain().catch(() => undefined);
  }

  /** Per card, the commits on its branch the main checkout's branch lacks, plus 1 for uncommitted or untracked files (board.js's line). */
  private readonly notInMainCount = new Map<string, number>();
  private notInMainAt = 0;
  notInMainOf(t: Task): number | undefined { return this.notInMainCount.get(t.id); }
  /** Reads git for every card countsWork names (tick, every 15 s, and after a delivery); a card whose git fails gets no number. */
  async refreshNotInMain() {
    this.notInMainAt = Date.now();
    let target: string | undefined;
    try { target = await git(this.repo, ["symbolic-ref", "--short", "HEAD"]); } catch { /* the main checkout is not on a branch */ }
    const next = new Map<string, number>();
    for (const t of this.tasks.filter((t) => this.countsWork(t))) {
      try {
        if (!target) break;
        const ahead = Number(await git(this.repo, ["rev-list", "--count", `${target}..${t.branch}`]));
        next.set(t.id, ahead + (await isClean(t.worktree!) ? 0 : 1));
      } catch { /* no number for this card */ }
    }
    const same = next.size === this.notInMainCount.size && [...next].every(([id, n]) => this.notInMainCount.get(id) === n);
    this.notInMainCount.clear();
    for (const [id, n] of next) this.notInMainCount.set(id, n);
    if (!same) this.changed.fire();
  }

  /**
   * Until the delivery running now (if any) has finished. For a caller that holds its card in `completing`, so that no new delivery
   * starts: Finish, Merge and Discard here, and autoFinish (auto-finish.ts) before it commits and merges in the master's worktree,
   * where a delivery of the master's own work commits and merges too.
   */
  async deliveryIdle() { while (this.deliveryRunning) await this.deliveryRunning.done.catch(() => undefined); }
  /** entomatical.orchestrator.caps; set by the extension. */
  capsOf: () => Caps = () => DEFAULT_CAPS;
  /** Where the brief is (section 7): named in every orchestrator card's first message. Set by the extension. */
  briefPath = path.join(os.homedir(), ".entomatical", "BRIEF.md");
  /** Where the pressure watcher's brief is (docs/orchestrator/WATCHER.md, placed beside BRIEF.md; F73). Set by the extension. */
  watcherPath = path.join(os.homedir(), ".entomatical", "WATCHER.md");
  /** Writes a completion rule for an `add --autoRule` child (the extension's Fable call); undefined leaves the child without one. */
  ruleWriter?: (prompt: string, account: string | undefined) => Promise<{ prompt: string; completion: Task["completion"] }>;
  /** Reviews a card against its Done when (the extension's runDoneReview, F97); auto: an orchestrator's finish, with no helper tab. */
  doneReviewer?: (task: Task, opts: { auto: boolean; answers?: string }) => Promise<DoneReview>;
  reviewIsLive?: (id: string) => boolean;

  /** Why a new child may not start by itself yet (Start after, the running limit; src/queue.ts with the extension's setting). */
  maxRunning = () => 0;
  isStarting(id: string) { return this.starting.has(id); }
  dispatchTime(task: Task) { return this.headlessStartedAt.get(task.id); }
  dispatchHeld(task: Task, launch: () => Promise<unknown> = () => this.startHeadless(task)) { return dispatchHeld(this, task, launch); }
  startPolicy = (task: Task) => queueWaitReason(task, this.tasks, this.maxRunning(), id => this.isStarting(id));

  /** The scheduler's decision, shared by queued dispatch, saved-plan assignments and their controller's Start/Retry. */
  startWait(task: Task): string | undefined {
    const root = masterOf(task, this.tasks);
    if (root?.paused) return "Run paused";
    if (task.openedBy && !root?.approved) return "Plan not approved";
    if (task.openedBy && (root?.cancelled || root?.status === "done")) return "The run has ended";
    if (task.openedBy && root?.planRun?.setupState && root.planRun.setupState !== "started") return "Waiting for run setup";
    return this.governedWait(task) ?? this.startPolicy(task) ?? this.planCapacityWait(task) ?? this.gateProblem(task);
  }
  /** Not private: autoFinish fires needsYou, and the extension's Review fires finishReady with a manual Done (F97 section 9). */
  readonly runEvents = new vscode.EventEmitter<{ kind: "started" | "needsYou" | "finished" | "note" | "budget" | "finishReady" | "takeoverAsked"; master: Task; task?: Task; text?: string; by?: Task; review?: DoneReview }>();
  /** The run's events (13.2 item 7): started, a card needs the user, finished, paused by its budget, an orchestrator's note; finishReady starts autoFinish. */
  readonly onRun = this.runEvents.event;
  private inboxWatcher?: fs.FSWatcher;
  private inboxBusy = false;
  private readonly lastRequestAt = new Map<string, number>();
  /** At most one request per second per orchestrator (section 8 item 6). Tests shorten it. */
  requestRateMs = 1000;
  private pendingRebinds = new Set<string>(); // card:session with a rebind prompt open, so prompts never stack
  // Overridden in tests: asks the user whether a session that is not the card's own may control it.
  confirmRebind = async (task: Task, session: string): Promise<boolean> =>
    await vscode.window.showWarningMessage(`Let session ${session.slice(0, 8)} control card ${task.id} (${task.title})?`, { modal: true,
      detail: `A different session asked to replace the current controller. Once allowed, session ${session.slice(0, 8)} can add, resume, finish and cancel the children of ${task.title} (${task.id}).` }, "Allow") === "Allow";
  /** Durable inboxes: settle notices coalesce by child; direct messages retain their request nonce. */
  private readonly pendingNotices = new Map<string, Map<string, string>>();
  /** The settle key last noticed per child (the wake guard, section 8 item 7). */
  private readonly notified = new Map<string, string>();
  private notificationsLoaded = false;
  private get notificationsFile() { return path.join(this.dir, "notifications.json"); }
  private loadNotifications(force = false) {
    if (this.notificationsLoaded && !force) return;
    this.notificationsLoaded = true;
    this.pendingNotices.clear(); this.notified.clear();
    try {
      const data = JSON.parse(fs.readFileSync(this.notificationsFile, "utf8"));
      for (const [id, box] of Object.entries(data.pending ?? {})) {
        if (!box || typeof box !== "object") continue;
        const entries = Object.entries(box).filter((entry): entry is [string, string] => typeof entry[1] === "string");
        if (entries.length) this.pendingNotices.set(id, new Map(entries));
      }
      for (const [id, key] of Object.entries(data.notified ?? {})) if (typeof key === "string") this.notified.set(id, key);
    } catch { /* first run: no durable inbox yet */ }
  }
  private saveNotifications() {
    writeFileAtomic(this.notificationsFile, JSON.stringify({ pending: Object.fromEntries([...this.pendingNotices].map(([id, box]) => [id, Object.fromEntries(box)])), notified: Object.fromEntries(this.notified) }));
  }
  private queueNotice(id: string, key: string, text: string) {
    this.loadNotifications();
    const box = this.pendingNotices.get(id) ?? new Map<string, string>();
    box.set(key, text); this.pendingNotices.set(id, box); this.saveNotifications();
  }
  /** A detached/external card explicitly reads its own inbox; no runtime switch or competing process is required. */
  receiveMessages(id: string): string[] {
    this.loadNotifications();
    const messages = [...(this.pendingNotices.get(id)?.values() ?? [])];
    this.pendingNotices.delete(id); this.saveNotifications();
    return messages;
  }
  private acknowledgeMessages(id: string, sent: Map<string, string>) {
    const current = this.pendingNotices.get(id);
    if (!current) return;
    for (const [key, text] of sent) if (current.get(key) === text) current.delete(key);
    if (!current.size) this.pendingNotices.delete(id);
    this.saveNotifications();
  }
  /** Children parked or moved by the board after a usage limit: no notice until the board runs them again. */
  private readonly muted = new Set<string>();
  get inboxDir() { return path.join(this.dir, "inbox"); }
  /** Phase 4: the durable request journal (nonces, body hashes, answers that could not be written). */
  private _requests?: RequestJournal;
  get requests() { return (this._requests ??= new RequestJournal(path.join(this.inboxDir, "journal.jsonl"))); }
  /** Phase 4: this board instance, recorded on the leases it reserves; another instance's reservation is reconciled before a replay. */
  readonly instance = `${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  /** Phase 4: durable records of integrations and target effects (prepared, effect-observed, committed, uncertain, abandoned). */
  private _ops?: Operations;
  get operations() { return (this._ops ??= new Operations(path.join(this.dir, "operations"))); }

  /** Checks the configured runner before allocating a worker card. No model turn or account mutation. */
  async preflightHeadless(provider?: Account["provider"], configDir?: string): Promise<void> {
    const acp = provider === "grok" || provider === "antigravity" ? acpCommand(provider, configDir) : undefined;
    const run = acp
      ? { ...acp, args: acp.file === "cmd.exe" ? ["/d", "/c", provider === "grok" ? "grok" : "agy", "--version"] : ["--version"] }
      : provider === "codex" ? codexCommand(["--version"], this.repo) : { file: claudeBinary(), args: ["--version"], env: process.env };
    await new Promise<void>((resolve, reject) => execFile(run.file, run.args,
      { cwd: this.repo, env: run.env, windowsHide: true, timeout: 15_000 },
      (error) => error ? reject(new Error(`${provider ?? "Claude"} runner could not start: ${error.message}`)) : resolve()));
  }

  /**
   * Start a fresh provider-owned terminal conversation; old ACP history and session id remain intact.
   * resume: the card's earlier terminal was interrupted (Stop, exit, window reload). No CLI flag the repo knows reopens that
   * conversation, so a new terminal on the same card and worktree gets the task prompt behind CARD_TERMINAL_RESUME_NOTE.
   */
  startCardTerminal(task: Task, resume = false): Promise<void> {
    return this.once(task, async () => {
      if (task.provider !== "grok" && task.provider !== "antigravity") throw new Error("Choose Grok or Antigravity for a terminal card.");
      if (resume && !task.cardTerminalStarted) throw new Error("This card has no terminal to resume. Use Start.");
      // An unattended card runs headless over ACP (startHeadless), never in the provider's interactive terminal; a battle's cards do (a47807).
      if ((task.orchestrator || task.openedBy) && !inCardTerminal(task)) throw new Error("An orchestrator or worker card runs unattended: use Start, not the provider's terminal.");
      if (this.live().includes(task.id)) throw new Error("The session is already running. Stop it first.");
      this.mustOwnActive();
      const check = this.launchGuard(task);
      this.gate(task);
      const provider = task.provider, configDir = task.configDir;
      // The model is always an exact id (the user, 17 November 2026), resolved before the worktree and branch exist, so a refused
      // start changes nothing on the card (F92): Antigravity's is the newest id `agy models` lists of the card's family (fix 11), and a
      // card with none is refused (agy does not say which model is its default); Grok's is the default `grok models` names, or the card's
      // resolved there.
      if (provider === "antigravity" && !task.model) throw new Error("This Antigravity card names no model, and agy does not say which model it would use by default. Add a new Antigravity card with a model (Opus, Argon or Carbon), or move this card to another account.");
      const model = provider === "antigravity" ? await this.agyLaunchModel(task.model!) : await this.grokLaunchModel(task);
      this.mustOwnActive();
      if (this.get(task.id) !== task || task.provider !== provider || task.configDir !== configDir || this.live().includes(task.id)) throw new Error("The card changed while its terminal was starting.");
      await this.ensureWorktree(task, "launch");
      await this.beforeStart(task);
      this.mustOwnActive();
      check();
      if (this.get(task.id) !== task || task.provider !== provider || task.configDir !== configDir || this.live().includes(task.id)) throw new Error("The card changed while its terminal was starting.");
      this.gate(task);
      const prompt = `${resume ? `${CARD_TERMINAL_RESUME_NOTE}

` : ""}${this.promptFor(task)}

${cardTerminalTurnNote(this.boardCli)}`;
      // The card's choices from the new-task form (F88): Antigravity's model (resolved above) and effort, and either provider's
      // permission mode. A card without a permission (one from before F88) runs the provider's most permissive mode.
      const permission = task.permission || PROVIDER_DEFAULT_PERMISSION;
      const choices = provider === "antigravity" ? { model, effort: task.effort, permission } : { model, permission };
      if (task.sentModel !== model) this.update(task, { sentModel: model }); // Session details name the exact id the terminal got
      this.cardTerminals.start({ id: task.id, provider, cwd: task.worktree!, configDir, prompt, env: this.taskEnv(task), notice: terminalModelNotice(task), ...choices });
      try { this.update(task, { cardTerminalStarted: true, status: "running", interrupted: undefined, held: undefined, controller: undefined, takenOver: undefined }); }
      catch (error) { this.cardTerminals.stop(task.id); throw error; }
    });
  }

  /**
   * A battle's card (inCardTerminal, a47807) started or resumed in its card terminal, as the board's Start and Resume do it: Grok and
   * Antigravity in their own (a new conversation once one ran), Claude and Codex in theirs (F89).
   */
  async startInCard(task: Task): Promise<unknown> {
    if (task.spec) readSpec(task.spec); // an unreadable specification refuses here, before any effect, as the start handler does
    const acp = task.provider === "grok" || task.provider === "antigravity", resume = acp ? !!task.cardTerminalStarted : !!task.sessionId;
    const r = await (acp ? this.startCardTerminal(task, resume) : resume ? this.resume(task) : this.start(task));
    recordSpec(this, this.get(task.id) ?? task, resume ? "resume" : "launch"); // the start handler's receipt, once the start returned
    return r;
  }
  /** How long `board.js add`, `resume` and `switch` wait for a battle card's start before they answer; the start goes on. Tests shorten it. */
  cardLaunchWaitMs = 10_000;
  /**
   * startInCard for a request from a card: a Claude card terminal's start ends only once its session is up, which can take longer than
   * board.js waits for its answer. A failure within cardLaunchWaitMs is thrown; a later one marks the card as a failed launch, as the
   * caller would, and its opener hears of it as of any settled card.
   */
  private async launchInCard(task: Task): Promise<void> {
    const run = this.startInCard(task).then(() => undefined, (e: unknown) => {
      const error = e instanceof Error ? e.message : String(e);
      try { if (this.get(task.id) === task && this.isOwner()) this.update(task, { launchError: error, status: "review", interrupted: true, held: undefined }, undefined, true); } catch { /* the window gave up the board */ }
      return error;
    });
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), this.cardLaunchWaitMs); timer.unref?.(); });
    const error = await Promise.race([run, waited]).finally(() => clearTimeout(timer));
    if (error) throw new Error(error);
  }

  /** Starts a managed worker: a hidden Claude terminal or a Codex app-server turn. */
  async startHeadless(task: Task): Promise<vscode.Terminal | undefined> {
    if (task.spec) readSpec(task.spec); // an unreadable specification refuses here, before any effect, as the start handler does
    // The start handler's receipt (compile.ts recordSpec) for every caller: the handler, plan steps, orchestrator children, councils.
    return this.once(task, async () => {
      const r = await this.startHeadlessNow(task);
      if (task.spec && this.isOwner()) recordSpec(this, this.get(task.id) ?? task, "launch");
      return r;
    });
  }

  private async startHeadlessNow(task: Task): Promise<vscode.Terminal | undefined> {
    if (task.sessionId) throw new Error("Already started. Use Resume.");
    if (task.planRun?.review === "checks") throw new Error("This plan card runs no session: the board checks its steps and merges them here. Press Finish when every step is Done.");
    const check = this.launchGuard(task);
    this.gate(task);
    // The model first (the user, 17 November 2026: exact ids only): a refusal leaves the card unstarted, with no worktree or branch (F92),
    // and its delivery as it was.
    const acp = task.provider === "grok" || task.provider === "antigravity";
    if (task.provider === "codex") await this.codexModelReady(task);
    if (acp) {
      let fresh: AcpOption[] | undefined;
      try { fresh = await this.acpCatalogProbe(task, check); }
      finally { check(); } // Even a failed probe may belong to an account switched while it was closing.
      this.acpModelPrecheck(task, fresh);
    } else this.mustOwn();
    const undo = await this.ensureWorktreeUndoable(task);
    try {
      await this.beforeStart(task);
      if (task.provider === "codex") await this.codexModelReady(task); // again with the worktree's own config
    } catch (e) { if (Board.modelRefusal(e)) await undo(); throw e; }
    check();
    // An ACP session is checked for its model only once it opens (no catalog yet): its delivery is invalidated once that passed.
    if (!acp) this.invalidateDelivery(task);
    const { openedBy, watchedBy, transfers, status } = task;
    const previous = { permission: task.permission, headless: task.headless, takenOver: task.takenOver, held: task.held, boardSessionId: task.boardSessionId };
    const placeholder = crypto.randomUUID();
    this.update(task, { sessionId: placeholder, headless: true, permission: this.headlessPermission(task), takenOver: undefined, held: undefined,
      ...(status === "review" ? { status: "queued" as const } : {}) }); // a retried allocation occupies a session slot until its first hook
    try {
      if (acp) { await this.runHeadlessAcp(task, false, this.promptFor(task)); this.mustOwn(); this.invalidateDelivery(task); return undefined; }
      if (task.provider === "codex") { await this.runHeadlessCodex(task, false, this.promptFor(task)); return undefined; }
      const term = this.launchHeadless(task, false, this.promptFor(task));
      this.sentPrompt(task);
      return term;
    } catch (e) {
      this.unconfirmedHeadless.delete(task.id);
      if (!this.isOwner()) throw e;
      const refused = Board.modelRefusal(e);
      const missing = acp && task.sessionId === placeholder && Board.missingExecutable(e);
      const unstarted = task.sessionId === placeholder || refused;
      if (missing) this.keepMissingRunnerCheckout(task);
      const current = this.get(task.id) === task && !task.cancelled && !task.discarded && task.status !== "done" && !task.takenOver &&
        task.openedBy === openedBy && task.watchedBy === watchedBy && task.transfers === transfers;
      if (current) {
        const restore = unstarted && status === "review" && task.status === "queued" ? { status } : {};
        this.update(task, refused || missing ? { sessionId: undefined, ...previous, ...restore } :
          { sessionId: unstarted ? undefined : task.sessionId, permission: previous.permission, ...(unstarted ? { held: previous.held, ...restore } : {}) });
        if (refused) await undo(); else if (acp && !missing) this.invalidateDelivery(task);
      } else if (this.get(task.id) === task && task.sessionId === placeholder) {
        this.update(task, { sessionId: undefined }); // only our unconfirmed allocation belongs to this failed start
      }
      throw e;
    }
  }
  /**
   * F92 (live, 17 November 2026: an agy session refused for its model held the new worktree for about a minute): an account with no saved
   * catalog is asked for one before the card's worktree exists, by a session opened in the card's own temporary folder and closed at once.
   * Its catalog is saved, and the card's model is checked against what it advertised, its current model included. Nothing on the card
   * changes. A missing executable fails here. Other session-open errors can depend on the probe directory and are retried in the worktree.
   */
  /** Off in the tests of the session itself, whose fake agents count every session opened; test/refused-start.test.js checks the probe. */
  probeAcpCatalogs = true;
  private readonly catalogProbes = new Set<(shutdown?: boolean) => void>();
  private async acpCatalogProbe(task: Task, check: () => void): Promise<AcpOption[] | undefined> {
    if (!this.probeAcpCatalogs) return;
    const provider = task.provider as AcpProvider;
    const account = this.accountList().find((a) => a.name === task.account && a.provider === provider);
    if (!account) return;
    if (this.acpCatalog(account)) {
      const run = acpCommand(provider, task.configDir);
      // A cached catalog can outlive its executable. If it appears absent, ask the launcher in the temp directory.
      // The filesystem hint alone never refuses a start.
      if (!Board.acpExecutableAbsent(run.file, run.env)) return;
      this.acpModelPrecheck(task); // An already-unlisted choice needs no provider process.
    }
    const cwd = this.cardTemp(task);
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (["ENTOMATICAL_SESSION", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID"].includes(key.toUpperCase())) delete env[key];
    Object.assign(env, tempEnv(cwd, tempRoot(this.repo)));
    const session = this.runAcp(provider, cwd, task.configDir, () => undefined, async () => undefined, env);
    const child = session.child;
    this.watchManagedExit(task, child);
    const close = (shutdown = false) => {
      if (!this.catalogProbes.delete(close)) return;
      try { this.killTree(child, shutdown); } finally { session.close(false); }
    };
    this.catalogProbes.add(close);
    try {
      let options: AcpOption[];
      try { await session.open(cwd); options = session.options(); }
      catch (e) {
        if (Board.missingExecutable(e) && child.spawnfile && Board.acpExecutableAbsent(child.spawnfile, env)
          && fs.existsSync(cwd + path.sep)) {
          this.keepMissingRunnerCheckout(task);
          throw e;
        }
        return; // The lookup or session may succeed in the checkout.
      }
      if (!this.catalogProbes.has(close)) return;
      check();
      this.rememberAcpOptions(task, options, "session/new"); // Publish in reply order. Process exit can take longer than the next probe.
      return options;
    } finally {
      const exited = this.catalogProbes.has(close) && child.exitCode == null && child.signalCode == null
        ? new Promise<void>((resolve) => { const timer = setTimeout(resolve, 5000); child.once("exit", () => { clearTimeout(timer); resolve(); }); }) : undefined;
      close();
      await exited;
    }
  }
  /**
   * Before an unattended Grok or Antigravity start changes anything: the card's model checked against what its account last advertised
   * (acpModelChoice), so a name it does not offer, or an alias, refuses here. Without a catalog yet, or with no model picked (the
   * session's own current model is then selected), the check happens when the session opens.
   */
  private acpModelPrecheck(task: Task, fresh?: AcpOption[]): void {
    const account = this.accountList().find((a) => a.name === task.account && a.provider === task.provider);
    const options = fresh ?? (account ? this.acpCatalog(account)?.options : undefined);
    if (!options) return;
    const option = options.find((o) => o.category === "model");
    const asked = Object.entries(task.acpSelections ?? {}).find(([id]) => id === "model" || id === option?.id)?.[1];
    if (fresh || asked || !option) acpModelChoice(task.provider as AcpProvider, options, asked || undefined, task.account ?? "The agent");
  }

  /** A follow-up to a headless card: a new hidden run resuming its session with the text on stdin (4.3). */
  followUpHeadless(task: Task, text: string, newWork = true): Promise<vscode.Terminal | undefined> { return this.launchStep(task, () => this.followUpHeadlessNow(task, text, newWork)); }
  private async followUpHeadlessNow(task: Task, text: string, newWork = true): Promise<vscode.Terminal | undefined> {
    if (!task.sessionId) throw new Error("Not started yet.");
    if (!task.worktree) throw new Error("This task is finished; its worktree was removed.");
    const check = this.launchGuard(task);
    this.gate(task);
    await this.settle(task);
    if (task.provider === "codex") await this.codexModelReady(task, true);
    check();
    if (newWork) { this.invalidateDelivery(task); task.judged = undefined; task.judgedRevision = undefined; task.judgeReady = undefined; }
    const previousPermission = task.permission;
    this.update(task, { permission: this.headlessPermission(task) });
    const prompt = task.orchestrator || task.openedBy ? `${this.runContext(task)}\n\n${text}` : text;
    try {
      if (task.provider === "grok" || task.provider === "antigravity") { await this.runHeadlessAcp(task, true, prompt); return undefined; }
      if (task.provider === "codex") { await this.runHeadlessCodex(task, true, prompt); return undefined; }
      const term = this.launchHeadless(task, true, prompt);
      this.update(task, { status: "running", interrupted: undefined, headless: true, refusalStop: undefined }); // F91: the next prompt clears a stop
      return term;
    } catch (e) { this.unconfirmedHeadless.delete(task.id); if (this.get(task.id) === task && this.isOwner()) this.update(task, { permission: previousPermission }); throw e; }
  }

  /** A resumed worker invalidates its own acceptance and its ancestors' acceptance, never an ordinary unrelated card's. */
  invalidateDelivery(task: Task) {
    // Phase 5: a council member reviews a fixed package read-only; starting or retrying it changes no work, so the root keeps its checks.
    if ((!task.orchestrator && !task.openedBy) || task.council) return;
    for (let card: Task | undefined = task, depth = 0; card && depth < 10; card = this.get(card.openedBy), depth++) {
      this.checks.stop(card);
      this.update(card, { deliveryReady: undefined, checks: undefined, reported: undefined,
        ...(card.status === "done" ? { status: "review" as Status } : {}) }, undefined, true);
    }
  }

  /**
   * The permission a hidden run uses. Claude and Codex default to Bypass. Grok and Antigravity keep the card's own (unset = the
   * agent's rules, so an unattended card raises each request to its parent); a mode they do not have counts as unset.
   */
  private headlessPermission(task: Task): string | undefined {
    const wanted = task.pendingPermission ?? task.permission;
    if (task.provider === "grok" || task.provider === "antigravity") return wanted && ACP_PERMISSIONS[wanted] ? wanted : undefined;
    return wanted ?? "bypass";
  }

  /** Awaited worktree/model preparation may outlive a cancel, reassignment or pause. Recheck at the provider boundary. */
  private launchGuard(task: Task) {
    const { openedBy, watchedBy, takenOver, controller, status, sessionId, transfers, provider, account, configDir } = task;
    const loginId = provider === "antigravity" ? this.antigravityLoginId() : undefined;
    const managed = !!(openedBy || task.orchestrator);
    const priorRoot = managed ? masterOf(task, this.tasks) : undefined;
    const reopen = status === "done" && !!sessionId && priorRoot?.status === "done";
    const check = () => {
      this.mustOwn();
      if (this.get(task.id) !== task || task.provider !== provider || task.account !== account || task.configDir !== configDir ||
          (provider === "antigravity" && this.antigravityLoginId() !== loginId) ||
          task.openedBy !== openedBy || task.watchedBy !== watchedBy || task.controller !== controller ||
          task.takenOver !== takenOver || task.transfers !== transfers || task.sessionId !== sessionId)
        throw new Error("The card or its controller changed while preparing the launch.");
      if (task.cancelled || task.discarded || (task.status === "done" && (status !== "done" || !sessionId))) throw new Error("The card was cancelled or finished.");
      if (managed || task.held) {
        const root = masterOf(task, this.tasks);
        if (root?.paused) throw new Error("Run paused");
        if (openedBy && !root?.approved) throw new Error("Plan not approved");
        if (openedBy && (root !== priorRoot || root?.cancelled || (root?.status === "done" && !reopen))) throw new Error("The run has ended");
        if (!sessionId) { const wait = this.startWait(task); if (wait) throw new Error(wait); }
      }
    };
    check();
    return check;
  }

  /** A plan pre-creates its steps. Only started, unfinished cards occupy the run's approved open-card capacity. */
  planCapacityWait(task: Task): string | undefined {
    return planCapacityWait(task, this.tasks, id => this.isStarting(id));
  }

  private hasNamedTerminal(task: Task): boolean {
    return vscode.window.terminals.some(t => {
      if (t.exitStatus || !isCardTerminal(t.name, task)) return false;
      const env = (t.creationOptions as vscode.TerminalOptions | undefined)?.env;
      if (!env?.ENTOMATICAL_REPO || !path.isAbsolute(env.ENTOMATICAL_REPO) || env.ENTOMATICAL_TASK !== task.id
        || env.ENTOMATICAL_RUNTIME !== "claude" || !env.ENTOMATICAL_SESSION) return true;
      return path.relative(this.repo, env.ENTOMATICAL_REPO) === "";
    });
  }

  private launchHeadless(task: Task, resume: boolean, text: string): vscode.Terminal {
    if (this.terminal(task)) throw new Error("The session is already running. Stop it first.");
    if (this.hasNamedTerminal(task))
      throw new Error("Cannot verify the existing terminal's session. Close it before retrying.");
    if (task.sessionId && this.external.has(task.sessionId)) throw new Error("This session is still running elsewhere. Close it there first.");
    const configDir = this.configDirOf(task);
    this.writeHooks(task);
    const files = headlessFiles(this.dir, task.id);
    fs.mkdirSync(path.dirname(files.promptFile), { recursive: true });
    fs.mkdirSync(path.dirname(files.stream), { recursive: true });
    const promptFile = resume ? files.followUpFile : files.promptFile;
    fs.writeFileSync(promptFile, text, "utf8");
    const plan: HeadlessPlan = { claude: claudeBinary(), hooks: this.hooksFile(task.id), sessionId: task.sessionId!, resume, title: task.title, named: task.named, orchestrator: !!task.orchestrator,
      promptFile, stream: files.stream, stderr: files.stderr, cwd: task.worktree!, repo: path.resolve(this.repo) };
    fs.writeFileSync(files.script, headlessScript(plan), { mode: 0o755 });
    const term = vscode.window.createTerminal({
      name: terminalName(task), hideFromUser: true,
      ...headlessLaunch(files.script, task.worktree!), env: { CLAUDE_CONFIG_DIR: configDir || null, ...this.taskEnv(task) },
      iconPath: new vscode.ThemeIcon("robot"),
    });
    this.terminals.set(task.id, term);
    this.headlessStartedAt.set(task.id, Date.now());
    this.unconfirmedHeadless.add(task.id);
    if (!resume) this.watchStart(task, term);
    this.muted.delete(task.id);
    this.changed.fire();
    return term;
  }
  /** When each card's latest hidden run was started (ms), so older events do not move the card (syncStatus). */
  private readonly headlessStartedAt = new Map<string, number>();
  /** Only a fresh managed SessionStart can replace an explicitly rebound controller. */
  private readonly unconfirmedHeadless = new Set<string>();

  /** The requests waiting in the inbox, oldest first (the file names sort by time). */
  private inboxFiles(): string[] {
    try { return fs.readdirSync(this.inboxDir).filter((f) => f.endsWith(".json")).sort(); } catch { return []; }
  }

  /** Consumes the inbox: validates each request, applies section 8, acts, and answers in inbox/done/<nonce>.json. One at a time. */
  async processInbox(): Promise<void> {
    if (this.inboxBusy || !this.owned) return;
    this.inboxBusy = true;
    try {
      for (const f of this.inboxFiles()) {
        const file = path.join(this.inboxDir, f), nonce = f.slice(0, -5), done = path.join(this.inboxDir, "done", f);
        let raw: unknown;
        try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch {
          // Mid-write, or never finished: a file older than 10 s is answered as unreadable so it does not sit there for ever.
          try { if (Date.now() - fs.statSync(file).mtimeMs > 10_000) { writeFileAtomic(done, JSON.stringify({ nonce, error: "Unreadable request" })); fs.rmSync(file, { force: true }); } } catch { /* gone */ }
          continue;
        }
        if (fs.existsSync(done)) { fs.rmSync(file, { force: true }); continue; } // idempotent: answered before (section 8 item 8)
        // Phase 4: the durable journal outlives inbox/done's 200 answers, a crash mid-request and a failed answer write.
        const hash = crypto.createHash("sha256").update(JSON.stringify(raw)).digest("hex"), seen = this.requests.get(nonce);
        const answer = (body: Record<string, unknown>) => writeFileAtomic(done, JSON.stringify({ ...(raw && typeof raw === "object" ? raw as object : {}), ...body }));
        let result: Record<string, unknown>;
        if (seen && seen.hash !== hash) result = { error: `Request ${nonce} reuses a nonce the board already handled with a different body; refused, nothing was done.` };
        else if (seen?.state === "answered") result = seen.answer ?? { error: `Request ${nonce} was already handled (${new Date(seen.at).toISOString()}); its answer is gone, and it is not handled twice.` };
        else if (seen?.state === "started") result = { error: `Request ${nonce} was being handled when the board stopped; whether it took effect is uncertain, so it is not handled again. Check the card (board.js show, overview), then send a new request if it is still needed.`, uncertain: true };
        else if (Date.now() - Math.min(fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? Date.now(), Date.parse(String((raw as Record<string, unknown>)?.at)) || Date.now()) > this.requests.horizon) result = { error: `Request ${nonce} is older than the board's request horizon (${Math.round(this.requests.horizon / 86_400_000)} days), so it could be a replay of one already forgotten; refused.` };
        else {
          // Not handled until its start is on disk: on a failed append the request waits for the next pass, which reads the journal again (RT-12).
          try { this.requests.record({ nonce, hash, state: "started", at: Date.now() }); } catch (e) { console.error("Entomatical: request journal", e); break; }
          try { result = await this.handleRequest(raw, nonce); } catch (e) { result = { error: e instanceof Error ? e.message : String(e) }; }
        }
        let wrote = true;
        try { answer(result); } catch (e) { wrote = false; console.error("Entomatical: inbox answer", e); }
        if (seen?.state !== "answered" || (!wrote && !seen.answer)) try { this.requests.record({ nonce, hash, state: "answered", at: seen?.at ?? Date.now(), ...(wrote ? {} : { answer: result }) }); } catch (e) { console.error("Entomatical: request journal", e); }
        if (wrote) fs.rmSync(file, { force: true }); // else kept: the next pass answers it from the journal, without handling it again
      }
      this.pruneDone();
      try { this.requests.compact(); } catch { /* next pass */ }
    } finally { this.inboxBusy = false; }
  }

  /** inbox/done keeps the last 200 answers (5.2). */
  private pruneDone() {
    try {
      const dir = path.join(this.inboxDir, "done");
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
      for (const f of files.slice(0, Math.max(0, files.length - 200))) fs.rmSync(path.join(dir, f), { force: true });
    } catch { /* none */ }
  }

  /** Section 8 for one request, with this board's state. Tests call it directly. */
  refusalOf(req: Request, ignoreRate = false): string | undefined {
    return refusal(req, this.tasks, this.rightsContext(req, ignoreRate));
  }
  /** The board's state as section 8 reads it, for one request. */
  rightsContext(req: Request, ignoreRate = false): RightsContext {
    const account = this.resolveAccount(req.account, req.model, req.runtime);
    const acp = account?.provider === "grok" || account?.provider === "antigravity";
    // Grok and Antigravity: the account's last advertised ids; before any, the requested value is queued and checked at session open.
    const seen = acp ? this.acpCatalog(account!)?.options : undefined;
    const acpIds = (category: string, value?: string | null) => seen ? seen.find((o) => o.category === category)?.values.map((v) => v.value) ?? [] : value ? [value] : [];
    return {
      enabled: this.orchestratorEnabled(), now: performance.now(), lastRequestAt: this.lastRequestAt, rateMs: ignoreRate ? 0 : this.requestRateMs, live: (t) => !!this.terminal(t) || this.cardTerminals.has(t.id) || this.codexRuns.has(t.id),
      everReady: (t) => this.everReady(t), starting: id => this.isStarting(id),
      wallNow: Date.now(), claimGraceMs: this.claimGraceMs, alive: ((ids?: Set<string>) => (t: Task) => (ids ??= new Set(this.live())).has(t.id) || this.starting.has(t.id))(),
      idleSince: (t) => Math.max(Date.parse(t.statusAt ?? t.updatedAt) || 0, this.lastActivityAt(t) ?? 0),
      unprocessed: (by) => this.inboxFiles().filter((f) => { try { return JSON.parse(fs.readFileSync(path.join(this.inboxDir, f), "utf8")).by === by; } catch { return false; } }).length,
      capsOf: (root) => root.orchestrator?.caps ?? this.capsOf(), catalogue: req.op === "add" ? readCatalogue(this.repo) : undefined,
      accountSignedIn: (name) => !!this.resolveAccount(name, req.model, req.runtime),
      accountUsage: (name) => {
        const selected = this.resolveAccount(name ?? this.get(req.by)?.account, req.model, req.runtime) ?? (!name ? account : undefined);
        if (!selected || (selected.provider && selected.provider !== "codex")) return undefined;
        const usage = readUsage(selected.provider === "codex" ? CODEX_DIR : selected.configDir ?? "");
        if (!usage?.windows) return usage;
        return { ...usage, fiveHour: usage.windows.find(w => w.minutes === 300)?.pct, week: usage.windows.find(w => w.minutes === 10080)?.pct };
      },
      // Fix 11: a short name, or a full id of any version of a family the provider lists (handleRequest stores the short name).
      models: account?.provider === "codex" ? [...shortNames("codex", this.codexModelIds()).map((n) => n.name), ...this.codexModelIds()]
        : acp ? (seen ? [...new Set([...shortNames(account!.provider!, acpIds("model")).map((n) => n.name), ...acpIds("model")])] : acpIds("model", req.model)) : MODELS,
      efforts: account?.provider === "codex" ? [...new Set(codexModels().flatMap((m) => m.efforts))] : acp ? acpIds("thought_level", req.effort) : EFFORTS,
      permissions: Object.keys(account?.provider === "codex" ? CODEX_PERMISSIONS : acp ? ACP_PERMISSIONS : PERMISSIONS),
    };
  }

  /** Phase 3: what an add asks for, for the idempotency key's payload check (not the board's later choices). */
  private addPayload(req: Request) {
    return [req.title, req.prompt, req.parent, req.account, req.model, req.effort, req.permission, req.runtime, req.completion, req.after, req.mayOpen, req.role, req.judge, req.profile, req.assignment, req.delegate];
  }
  /** Phase 3: why a governed card's submission cannot be accepted now (none, the tree is dirty, or HEAD moved since), or undefined. */
  async submissionStale(t: Task): Promise<string | undefined> {
    if (!t.submission) return `Card ${t.id} has no validated submission (board.js submit); a governed card is accepted against its handoff.`;
    if (!t.worktree || !fs.existsSync(t.worktree)) return `Card ${t.id}'s worktree is gone; its submission cannot be checked.`;
    const head = await git(t.worktree, ["rev-parse", "HEAD"]).catch(() => ""), clean = await isClean(t.worktree).catch(() => false);
    this.submissionCurrent.set(t.id, clean && head === t.submission.head);
    if (!clean) return `Card ${t.id} has uncommitted changes after its submission; it must submit again.`;
    if (head !== t.submission.head) return `Card ${t.id} changed after its submission (HEAD ${head.slice(0, 12)}, submitted ${t.submission.head.slice(0, 12)}); it must submit again.`;
    return undefined;
  }
  /** Phase 3: a governed child's handoff, validated against git: its clean HEAD, a base that is its ancestor, and the files that really changed. */
  private async submit(by: Task, req: Request): Promise<Record<string, unknown>> {
    const wt = by.worktree!;
    if (!fs.existsSync(wt) || !await isClean(wt)) return { error: "submit: commit your work first; a dirty tree is never a submission." };
    const head = await git(wt, ["rev-parse", "HEAD"]);
    const named = await git(wt, ["rev-parse", "--verify", "--quiet", `${req.head}^{commit}`]).catch(() => "");
    if (named !== head) return { error: `submit: ${req.head} is not this worktree's HEAD (${head.slice(0, 12)}); commit, then submit that commit.` };
    const parent = this.get(by.openedBy ?? by.parentId);
    const base = req.base ? await git(wt, ["rev-parse", "--verify", "--quiet", `${req.base}^{commit}`]).catch(() => "")
      : parent?.branch ? await git(wt, ["merge-base", head, parent.branch]).catch(() => "") : "";
    if (!base) return { error: "submit: the base is unknown; pass --base <commit> (the commit your work started from)." };
    if (!await git(wt, ["merge-base", "--is-ancestor", base, head]).then(() => true, () => false)) return { error: `submit: base ${base.slice(0, 12)} is not an ancestor of ${head.slice(0, 12)}.` };
    // The files always come from where the work left the opener's branch, so a later --base cannot hide earlier commits.
    const from = parent?.branch ? await git(wt, ["merge-base", head, parent.branch]).catch(() => base) : base;
    const files = (await git(wt, ["diff", "--name-only", `${from}..${head}`])).split("\n").map((f) => f.trim()).filter(Boolean);
    this.mustOwnActive();
    if (this.get(by.id) !== by || by.status === "done" || by.cancelled) return { error: "submit: the card changed while its submission was checked; submit again." };
    const unclaimed = req.files ? files.filter((f) => !req.files!.includes(f)) : [];
    // base is what the files were diffed against; a different --base the child named is kept beside it as a claim.
    by.submission = { head, base: from, ...(from !== base ? { claimedBase: base } : {}), summary: req.summary!, files, ...(req.files ? { claimedFiles: req.files } : {}), ...(req.claimedChecks ? { checksClaimed: req.claimedChecks } : {}),
      checks: by.completion?.commands.length ? by.checks?.status ?? "not run" : "none required", ...(req.limitations ? { limitations: req.limitations } : {}),
      ...(req.decisions ? { decisions: req.decisions } : {}), ...(req.covers ? { covers: req.covers } : {}), at: new Date().toISOString() };
    this.submissionCurrent.set(by.id, true);
    const root = governedRootOf(by, this.tasks)!.root!;
    this.governedEvent(root, by.id, "submission", `${by.assignment?.key ?? by.id}: ${head.slice(0, 12)} on ${from.slice(0, 12)}, ${files.length} file${files.length === 1 ? "" : "s"}, checks ${by.submission.checks}`);
    try { fs.appendFileSync(this.eventsFile(by.id), JSON.stringify({ t: Date.now(), hook_event_name: "Submission", head, base: from, files: files.length }) + "\n"); } catch { /* no events folder yet */ }
    this.save();
    if (parent) {
      this.queueNotice(parent.id, `submission:${by.id}`, `Submission from ${by.id} (${by.title}): ${req.summary!.slice(0, 600)}\nHead ${head.slice(0, 12)}, base ${from.slice(0, 12)}${from !== base ? ` (it named ${base.slice(0, 12)})` : ""}, ${files.length} changed file${files.length === 1 ? "" : "s"}; board checks at submit: ${by.submission.checks}${by.completion?.commands.length ? " (the board runs them when the turn ends; Done needs them passed)" : ""}${req.claimedChecks?.length ? `; claimed, not verified: ${req.claimedChecks.join("; ")}` : ""}${unclaimed.length ? `; changed but not listed: ${unclaimed.slice(0, 10).join(", ")}` : ""}${req.decisions?.length ? `\nDecisions needed: ${req.decisions.join("; ")}` : ""}`);
      this.deliverNotices(parent.id);
    }
    return { ok: true, id: by.id, head, base: from, files: files.length, note: `submitted ${head.slice(0, 12)} (${files.length} file${files.length === 1 ? "" : "s"}); your parent decides whether to accept it` };
  }

  /** One request: validation, the refusal, then the verb (5.3). The answer goes to inbox/done. */
  async handleRequest(raw: unknown, nonce: string): Promise<Record<string, unknown>> {
    this.mustOwnActive();
    // F95 item 5: the user's terminal, signed with this machine's operator token. A bad signature reads exactly as no caller at all.
    if (raw && typeof raw === "object" && (raw as Record<string, unknown>).by === "operator") {
      if (!verifyOperator(raw as Record<string, unknown>, nonce, readOperatorToken(this.operatorTokenFile))) return { error: "Missing by: run this from a task session (ENTOMATICAL_TASK)" };
      return this.handleOperator(raw as Record<string, unknown>);
    }
    const v = validateRequest(raw, nonce);
    if ("error" in v) return { error: v.error };
    const req = v.request;
    const addHash = req.op === "add" ? payloadHash(this.addPayload(req)) : ""; // as asked, before the board fills in the account
    if (req.op === "add") {
      if (this.get(req.by)?.planRun?.approval) return { error: "This governed plan already has its fixed assignments. Preview and approve a new plan to add work." };
      if (req.model) req.model = normalizeModel(req.model);
      const caller = this.get(req.by);
      // Phase 3 decides how a profile passes to children; until then a card with a profile opens none, so none runs broader than it.
      // Phase 3: in a governed run the child's profile comes from the caller's allowance; elsewhere a profiled card still opens none.
      if (caller?.profile && caller.profile.mode !== "provider-defaults" && !governedRootOf(caller, this.tasks)) return { error: "A card with a capability profile can open cards only in a governed run: children would otherwise run with the provider's defaults." };
      // Idempotent add (phase 3): the same assignment key from the same card returns its card; another payload under that key is refused.
      const gov = caller ? governedRootOf(caller, this.tasks) : undefined;
      if (gov?.root && req.assignment && req.session && req.session === boundSessionOf(caller!) && (req.protocol ?? 1) >= GOVERNED_PROTOCOL && !gov.root.paused) {
        const was = gov.root.governed!.keys?.[`${req.by}:${req.assignment.key}`];
        if (was) {
          if (was.hash !== addHash) return { error: `Assignment key ${req.assignment.key} was already used for card ${was.card} with a different request; use a new key for new work.` };
          const existing = this.get(was.card);
          return { id: was.card, created: false, duplicate: true, launchState: existing ? launchState(existing, this.events(was.card)) : "unknown",
            note: `Assignment ${req.assignment.key} already has card ${was.card}; nothing new was made or started.` };
        }
      }
      const found = this.resolveAccount(req.account ?? caller?.account, req.model, req.runtime)
        ?? (!req.account ? this.resolveAccount(undefined, req.model, req.runtime) : undefined);
      if (!found) return { error: `Account not signed in: ${req.account ?? req.runtime ?? caller?.account ?? "default"}. Valid accounts: ${this.accountList().map((a) => a.name).join(", ")}` };
      req.account = found.name;
    }
    const why = this.refusalOf(req);
    if (why) return { error: why };
    this.lastRequestAt.set(req.by, performance.now());
    const by = this.get(req.by)!;
    if (by.controller && req.op !== "rebind") this.update(by, { controller: { ...by.controller, at: new Date().toISOString() } });
    const target = req.id ? this.get(req.id)! : undefined;
    switch (req.op) {
      case "add": {
        const root = runRoot(by, this.tasks) ?? by;
        const selected = this.resolveAccount(req.account, req.model, req.runtime);
        // A battle card's cards (a47807, the user, 14 November 2026: "the same goes for each of its subagents that it spawns") carry its
        // battle and run in their card terminals with permission bypass, as the battle's own cards do, on the account, model and effort
        // asked for. A standing role (judge, scribe, research) and a pressure watcher run headless as before: the board starts and feeds
        // them itself.
        const battle = inCardTerminal(by) ? by.battle : undefined, inCard = !!battle && !req.role && !req.watch;
        const granted = childPermission(by, selected?.provider === "grok" || selected?.provider === "antigravity", req.permission);
        if ("error" in granted) return { error: granted.error };
        if (inCard) granted.permission = "bypass";
        if (granted.permission === "ask" && (selected?.provider === "grok" || selected?.provider === "antigravity")) { const why = this.acpAskRefusal(selected); if (why) return { error: why }; }
        await this.preflightHeadless(selected?.provider, selected?.configDir);
        this.mustOwnActive();
        const afterPreflight = this.refusalOf(req, true);
        if (afterPreflight) return { error: afterPreflight };
        const roleBrief = req.watch ? `Supervise only these assigned cards: ${req.watch.join(", ")}. Do not open another coordinator; report their outcomes and request ready only when they are Done or cancelled.` : req.role === "judge" ? "Review only an assigned change; do not modify files. Return the requested verdict format." : req.role === "scribe" ? "Update only the documents explicitly named in the assignment. Commit on your branch; do not push or make decisions." : req.role === "research" ? "Answer the assigned question from evidence. Do not modify files." : "";
        // Phase 3: the governed child's profile, narrowed allowance and assignment (refusal() checked them; computed again here, after the awaits).
        const gov = governedRootOf(by, this.tasks);
        let governedStep: Pick<Task, "profile" | "governedBy" | "assignment" | "delegation"> = {};
        if (gov?.root) {
          const p = childProfile(allowanceOf(by), gov.root.governed!, req.profile), d = narrowDelegation(allowanceOf(by), req.delegate, !!req.mayOpen);
          if ("error" in p) return { error: p.error };
          if ("error" in d) return { error: d.error };
          governedStep = { profile: JSON.parse(JSON.stringify(p.selection)), governedBy: gov.root.id, assignment: req.assignment, ...(d.delegation ? { delegation: d.delegation } : {}) };
        }
        let prompt = prefixPrompt(by.title, by.id, [roleBrief, req.prompt!].filter(Boolean).join("\n\n")), completion = req.completion ?? undefined;
        if (req.autoRule && this.ruleWriter) { const r = await this.ruleWriter(prompt, req.account ?? by.account); prompt = r.prompt; completion = r.completion; }
        this.mustOwnActive();
        const beforeAdd = this.refusalOf(req, true);
        if (beforeAdd) return { error: beforeAdd };
        if (completion) {
          const checks = limitToCatalogue(completion.commands, readCatalogue(this.repo));
          if (checks.refused.length) return { error: `Check not in workflows/checks.json: ${checks.refused.join(", ")}` };
          completion = { ...completion, commands: checks.kept };
        }
        const caps = root.orchestrator?.caps ?? this.capsOf();
        const permission = granted.permission;
        const child = this.add(req.title!, prompt, req.account ?? by.account, by.id, req.model ?? undefined, req.effort ?? undefined, completion,
          { ...(inCard ? { cardTerminal: true } : { headless: true }), ...(battle ? { battle } : {}),
            openedBy: by.id, watchedBy: by.id, permission, ...(req.role ? { role: req.role } : req.watch ? { role: "sub" as const } : {}), ...(req.judge ? { judge: true } : {}), ...(req.after?.length ? { dependsOn: req.after } : {}),
            ...(req.mayOpen ? { orchestrator: { caps, opened: 0, root: root.id } } : {}), ...governedStep });
        child.runPolicy = root.runPolicy;
        if (child.orchestrator) child.approved = root.approved;
        if (req.watch) {
          child.watches = [...req.watch];
          const source = this.pendingNotices.get(root.id);
          for (const id of req.watch) { const t = this.get(id)!; t.watchedBy = child.id; const notice = source?.get(id); if (notice) { source!.delete(id); this.queueNotice(child.id, id, notice); } }
          if (source && !source.size) this.pendingNotices.delete(root.id);
          this.saveNotifications();
        }
        by.deliveryReady = undefined; root.deliveryReady = undefined; root.reported = undefined;
        root.orchestrator!.opened += 1;
        if (gov?.root && req.assignment) {
          (gov.root.governed!.keys ??= {})[`${req.by}:${req.assignment.key}`] = { card: child.id, hash: addHash };
          this.governedEvent(gov.root, child.id, "assigned", `assignment ${req.assignment.key} to ${child.id} by ${by.id} (${profileRef(child.profile)}${child.delegation ? `, may delegate ${child.delegation.allowed.join(", ")} depth ${child.delegation.depth}` : ""})`);
        }
        this.save();
        if (root.orchestrator!.opened === 1) this.runEvents.fire({ kind: "started", master: root });
        const made = { id: child.id, created: true, permission: child.permission ?? null };
        if (child.role === "judge" || child.role === "scribe") {
          this.update(child, { status: "review" });
          return { ...made, started: false, launchState: "waiting", note: "Standing role waits for a board message; it uses no model until then." };
        }
        if (req.start === "manual") return { ...made, started: false, launchState: "queued", note: "queued (start: manual)" };
        const wait = this.startWait(child);
        if (wait) { this.update(child, { held: true }); return { ...made, started: false, launchState: "waiting", note: wait }; }
        try { if (inCardTerminal(child)) await this.launchInCard(child); else await this.startHeadless(child); } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          if (this.get(child.id) !== child || !this.ownsNow() || child.cancelled || child.status === "done" || child.takenOver || child.openedBy !== by.id || child.watchedBy !== by.id)
            return { ...made, started: false, launchState: launchState(child, this.events(child.id)), note: error };
          if (child.role === "sub") this.recoverPressureWatcher(child, "could not start");
          this.update(child, { launchError: error, status: "review", interrupted: true, held: undefined }, undefined, true);
          return { ...made, started: false, launchState: "failed", launchError: error, error: `Launch failed: ${error}. Retry or cancel ${child.id}; it has no completion credit.` };
        }
        return { ...made, started: true, launchState: this.isStarting(child.id) && !child.sessionId ? "requested" : launchState(child, this.events(child.id)) };
      }
      case "send": {
        // CORE-GOV-01: only the target's holder reopens it; anyone else's message waits in its inbox and leaves Done and delivery as they are.
        if (isOwn(by, target!, this.tasks)) {
          this.invalidateDelivery(target!);
          this.update(target!, { followUps: (target!.followUps ?? 0) + 1, deliveryReady: undefined, reported: undefined });
        }
        this.queueNotice(target!.id, `message:${req.nonce}`, `Message from card ${by.id} (${by.title}):\n${req.text!}`);
        this.deliverNotices(target!.id);
        return { ok: true, queued: true, note: `Message queued for ${target!.id}; delivered when idle or by board.js receive.` };
      }
      case "receive": return { ok: true, messages: this.receiveMessages(by.id) };
      case "screen": {
        const shot = this.terminalScreen(by, target!, req.lines ?? 60);
        if (!shot) return { error: `Card ${target!.id} has no card terminal${target!.cardTerminal || target!.provider === "grok" || target!.provider === "antigravity" ? " yet; start or resume it first" : " (it was not started with Card terminal)"}` };
        return { ok: true, ...shot };
      }
      case "type": {
        const why = await this.terminalType(by, target!, { text: req.text, keys: req.keys, enter: req.enter, override: req.override });
        return why ? { error: why } : { ok: true, note: `typed into ${target!.id}` };
      }
      case "stop": this.stop(target!); return { ok: true };
      case "resume": return this.restartCard(target!);
      case "integrate": case "done": {
        if (req.op === "integrate" && governedRootOf(by, this.tasks)) {
          try { return await this.integrate(target!, by.id); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
        }
        if (req.op === "integrate" && target!.status === "done" && target!.integrated?.into === by.id)
          return { ok: true, integrated: target!.integrated, note: `Already integrated ${target!.integrated.head} into ${target!.integrated.branch}.` };
        if (target!.planStep && (target!.workflow?.outcome !== "accepted" || !target!.integrated)) return { error: "A governed plan step needs an accepted result and governed integration before Done." };
        // Git checks below yield. Capture their subject before the first await, then reauthorize immediately before Done.
        const root = runRoot(by, this.tasks) ?? by;
        const approval = JSON.stringify(root.approved ?? null), policy = JSON.stringify(root.runPolicy ?? null), paused = root.paused, callerRole = by.role, callerBranch = by.branch;
        const acceptance = () => JSON.stringify({ checks: target!.checks, completion: target!.completion, branch: target!.branch,
          worktree: target!.worktree, sessionId: target!.sessionId, account: target!.account, provider: target!.provider,
          openedBy: target!.openedBy, watchedBy: target!.watchedBy, lastEvent: this.events(target!.id).at(-1),
          judge: target!.judge, judged: target!.judged, judgedRevision: target!.judgedRevision, stepHold: target!.stepHold });
        const checked = acceptance();
        if (!this.everReady(target!)) return { error: "Not started: cancel this card instead of marking it Done." };
        // Phase 3: a governed card is accepted against its submission, which must still be its worktree's clean HEAD.
        if (governedRootOf(target!, this.tasks)) { const stale = await this.submissionStale(target!); if (stale) return { error: stale }; }
        if (req.op === "done" && by.role === "sub" && target!.watchedBy === by.id) {
          if (!target!.branch || !by.branch || await this.hasUncommitted(target!) || !await git(this.repo, ["merge-base", "--is-ancestor", target!.branch, by.branch]).then(() => true, () => false)) return { error: "Merge the watched card's clean branch into your watcher branch before marking it Done." };
        }
        if (target!.judge && (!target!.worktree || !await isClean(target!.worktree) || await git(target!.worktree, ["rev-parse", "HEAD"]) !== target!.judgedRevision)) return { error: "The card changed after judgment; judge it again." };
        if (target!.orchestrator && !target!.deliveryReady) return { error: "The coordinator must declare ready before Done." };
        if (target!.completion?.commands.length && target!.checks?.status !== "complete") return { error: "Acceptance checks have not passed." };
        const reviewerChild = this.isPlanStep(target!, by) || (!!by.planRun?.mayOpen && target!.openedBy === by.id && !target!.role);
        if (reviewerChild && (!root.approved || root.paused || root.cancelled || root.status === "done" || target!.takenOver || target!.controller))
          return { error: "Accept the step from its active, approved run after its controller is available." };
        if ((reviewerChild || req.op === "integrate") && target!.completion?.commands.length && (target!.stepHold || !await this.matchesCheckedRevision(target!)))
          return { error: "The step no longer matches its checked revision. Review it and run the checks again before marking it Done." };
        if (reviewerChild && target!.stepHold) return { error: target!.stepHold };
        const verify = () => {
          this.mustOwnActive();
          if (this.get(by.id) !== by || this.get(target!.id) !== target || this.get(root.id) !== root || (runRoot(by, this.tasks) ?? by) !== root ||
            root.paused !== paused || JSON.stringify(root.approved ?? null) !== approval || JSON.stringify(root.runPolicy ?? null) !== policy ||
            by.role !== callerRole || by.branch !== callerBranch || acceptance() !== checked)
            return "The card or run changed while checking completion. Review it and try again.";
          return this.refusalOf(req, true);
        };
        const changed = verify();
        if (changed) return { error: changed };
        let receipt: Task["integrated"];
        if (req.op === "integrate" || (reviewerChild && !governedRootOf(target!, this.tasks))) {
          try { receipt = await this.acceptRunBranch(target!, by, req, verify); }
          catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
          const stale = verify();
          if (stale) return { error: stale };
        }
        this.update(target!, { status: "done", ...(receipt ? { integrated: receipt } : {}) });
        { const plan = masterOf(target!, this.tasks); if (plan?.planRun) this.queueScribeMilestone(plan); }
        if (target!.openedBy === by.id || target!.watchedBy === by.id) void this.closeAccepted(target!, by);
        return receipt ? { ok: true, integrated: receipt, note: `Integrated ${receipt.head} into ${receipt.branch} at ${receipt.after}.` } : { ok: true };
      }
      case "cancel": {
        if (target!.role === "judge" && target!.judging) { const job = this.get(target!.judging.id), root = masterOf(target!, this.tasks); if (job && root) this.holdStep(job, root, "The standing judge was cancelled; review or reassign this work."); target!.judging = undefined; }
        if (target!.role === "sub") this.recoverPressureWatcher(target!, "cancelled");
        this.checks.stop(target!);
        this.update(target!, { cancelled: true, held: undefined, status: "review" }, undefined, true);
        return { ok: true, note: "Cancelled; preserved without completion credit." };
      }
      case "adopt": {
        const { live } = this.moveCards(by, [target!], { via: "adopt", by: by.id, countOpened: true, continueWork: true });
        return { ok: true, note: `Adopted ${target!.id} under ${by.id}; existing work and session preserved.${live ? " Live sessions keep their current permission mode until restarted." : ""}` };
      }
      case "claim": {
        this.moveCards(by, [target!], { via: "claim", by: by.id, reason: req.reason });
        return { ok: true, note: `Claimed ${target!.id}: you control it now (stop, resume, done, cancel, send, show). Its branch, worktree and checks are unchanged; review and merge it as your brief says, or cancel it.` };
      }
      case "claim-tree": {
        const plan = claimTree(by, target!, this.tasks, this.rightsContext(req));
        if ("error" in plan) return { error: plan.error };
        this.moveCards(by, plan.tops, { via: "claim-tree", by: by.id, reason: req.reason });
        return { ok: true, moved: plan.moved, live: plan.live, waiting: plan.waiting,
          note: `Claimed ${plan.moved.length} card${plan.moved.length === 1 ? "" : "s"} of ${target!.id}'s run: ${plan.moved.join(", ")}.${plan.live.length ? ` Live, left alone: ${plan.live.join(", ")}.` : ""}${plan.waiting.length ? ` Left with a live card or held: ${plan.waiting.join(", ")}.` : ""} ${target!.id} itself stays with the user.` };
      }
      case "request-takeover": return this.requestTakeover(by, target!, req.reason!);
      case "handoff": {
        const to = this.get(req.to)!;
        const cards = req.self ? heldBy(by, this.tasks).filter((t) => t.id !== to.id) : [target!];
        this.moveCards(to, cards, { via: "handoff", by: by.id, reason: req.reason, op: "handoff" });
        this.queueNotice(to.id, `handoff:${by.id}:${req.nonce}`, `Handoff: card ${by.id} (${by.title}) gave you ${cards.map((c) => `${c.id} (${c.title})`).join(", ")}${req.reason ? `: ${req.reason}` : ""}. You control ${cards.length === 1 ? "it" : "them"} now: review, merge or cancel as your brief says.`);
        this.deliverNotices(to.id);
        return { ok: true, note: `Handed ${cards.map((c) => c.id).join(", ")} to ${to.id}.` };
      }
      case "rebind": {
        const session = req.session!;
        const bind = (card: Task) => {
          this.unconfirmedHeadless.delete(card.id); // an explicit external controller wins over a launch still reporting in
          this.update(card, { controller: { sessionId: session, at: new Date().toISOString(), mode: "external" }, takenOver: true });
        };
        const previous = boundSessionOf(by);
        if (session === previous) {
          bind(by);
          return { ok: true, note: "External controller bound. Use receive or wait to collect notices; the original runtime session was preserved." };
        }
        // Security audit 2026-11-22 lead 1: ENTOMATICAL_TASK alone must not hand a card to any session; the user allows it on the board.
        const waiting = { error: "Waiting for the user to allow this on the board. Once they allow it this session is bound; do not run rebind again." };
        const key = `${by.id}:${session}`;
        if (this.pendingRebinds.has(key)) return waiting;
        this.pendingRebinds.add(key);
        void this.confirmRebind(by, session).then((ok) => {
          const card = this.get(by.id);
          if (ok && card === by && this.isOwner() && boundSessionOf(card) === previous && !this.refusalOf(req, true)) bind(card);
        }, () => undefined).finally(() => this.pendingRebinds.delete(key));
        return waiting;
      }
      case "ready": {
        const root = runRoot(by, this.tasks) ?? by;
        const approval = JSON.stringify(root.approved ?? null), policy = JSON.stringify(root.runPolicy ?? null);
        const controller = JSON.stringify(by.controller ?? null), callerRole = by.role, callerBranch = by.branch;
        const children = () => JSON.stringify(runCards(by.id, this.tasks).filter((t) => t.role !== "judge" && t.role !== "scribe").map((t) => ({
          id: t.id, status: t.status, cancelled: t.cancelled, openedBy: t.openedBy, watchedBy: t.watchedBy, sessionId: t.sessionId,
          branch: t.branch, worktree: t.worktree, checks: t.checks, completion: t.completion, judge: t.judge, judged: t.judged,
          judgedRevision: t.judgedRevision, stepHold: t.stepHold, lastEvent: this.events(t.id).at(-1),
        })));
        const reviewed = children();
        const authorized = () => this.get(by.id) === by && this.get(root.id) === root && (runRoot(by, this.tasks) ?? by) === root && !root.paused &&
          JSON.stringify(root.approved ?? null) === approval && JSON.stringify(root.runPolicy ?? null) === policy && JSON.stringify(by.controller ?? null) === controller &&
          by.role === callerRole && by.branch === callerBranch && children() === reviewed && !this.refusalOf(req, true) &&
          !runCards(by.id, this.tasks).some((t) => (t.role === "judge" || t.role === "scribe") && !t.cancelled && t.status !== "done" &&
            (t.judging || t.scribe?.active || t.stepHold || t.takenOver));
        const standing = runCards(by.id, this.tasks);
        if (standing.some((t) => t.role === "scribe" && !t.cancelled && t.status !== "done" && (t.scribe?.active || t.stepHold || t.takenOver))) return { error: "The standing scribe has an unfinished milestone or needs review." };
        if (standing.some((t) => t.role === "judge" && !t.cancelled && t.status !== "done" && (t.judging || t.stepHold || t.takenOver))) return { error: "The standing judge has an unfinished assignment or needs review." };
        if (!authorized()) return { error: "The run is paused or no longer authorized to finish." };
        if (by.pressureWatchersBlocked?.length && !await this.resolvePressureWatchers(by)) return { error: "A stopped watcher may contain unmerged work. Reconcile its branch and worktree before declaring this run ready." };
        if (!authorized()) return { error: "The card or run changed while checking readiness. Review it and try again." };
        if (by.planRun) { const reason = await this.finishStandingRoles(by, authorized); if (reason) return { error: reason }; }
        this.mustOwnActive();
        if (!authorized() || by.pressureWatchersBlocked?.length || (by.planRun && runCards(by.id, this.tasks).some((t) => (t.role === "judge" || t.role === "scribe") && !t.cancelled && t.status !== "done")))
          return { error: "The card or run changed while checking readiness. Review it and try again." };
        const deliveryProblem = this.checks.deliveryProblem(by, true);
        if (deliveryProblem) {
          if (by.deliveryReady) this.update(by, { deliveryReady: undefined, reported: undefined });
          return { error: deliveryProblem };
        }
        this.update(by, { deliveryReady: true });
        if (by.status === "review") this.checks.start(by);
        this.maybeFinished(by);
        return { ok: true, note: "Delivery ready; final acceptance runs when this turn ends." };
      }
      case "note": this.runEvents.fire({ kind: "note", master: masterOf(by, this.tasks) ?? by, task: by, text: req.text }); return { ok: true };
      // F87: a finished turn, as a Claude card's Stop: Review, not Interrupted. Enter typed in the terminal moves it back (turnTyped).
      case "turn-done": this.update(by, { status: "review" }); return { ok: true, note: `Card ${by.id} is in Review until the next prompt.` };
      case "submit": return this.submit(by, req);
      // Phase 4: a coordinator or root integrates a child it opened into its own branch; readiness is the same one the board shows the user.
      case "council": return this.councilRequest(by, req);
      case "readiness": { const t = target ?? by; return { ok: true, readiness: await this.readiness(t, t.governed || !governedRootOf(t, this.tasks) ? "target" : "integrate", undefined, by.id) }; }
      case "plan": {
        const file = this.planFile(by);
        let text = "";
        try { text = fs.readFileSync(file, "utf8"); } catch { return { error: `No ORCHESTRATION.md in your worktree (${file})` }; }
        const summary = planSummary(text);
        if (!summary.steps) return { error: "ORCHESTRATION.md lists no steps (a list under a Steps heading). Example:\n## Steps\n- Add the parser and its tests\n- Wire it into the board" };
        ensureCatalogue(this.repo);
        this.invalidateDelivery(by);
        const root = runRoot(by, this.tasks) ?? by;
        if (by.orchestrator!.root) {
          this.update(by, { plan: { at: new Date().toISOString(), ...summary }, approved: root.approved, deliveryReady: undefined });
          return { ok: true, note: `${summary.steps} steps; covered by root ${root.id}'s approval.` };
        }
        // A battle's root (a47807): its run was approved when the battle started (battleRun), and nobody approves a plan in a battle. The
        // plan is recorded, the approval stays, and a turn that ended to wait for it is told to go on, as approvePlan tells it.
        if (by.battle) {
          const at = new Date().toISOString();
          this.update(by, { plan: { at, ...summary }, approved: by.approved ?? { at, hash: "battle" }, runPolicy: req.policy ?? by.runPolicy, deliveryReady: undefined });
          this.queueNotice(by.id, "plan", BATTLE_APPROVED_NOTICE);
          this.deliverNotices(by.id);
          return { ok: true, note: BATTLE_APPROVED_NOTICE };
        }
        this.update(by, { plan: { at: new Date().toISOString(), ...summary, caps: capsFrom({ ...by.orchestrator!.caps, ...req.caps }), policy: req.policy ?? by.runPolicy }, approved: undefined, deliveryReady: undefined, ...(by.status === "review" ? { status: "needs-input" as Status } : {}) });
        return { ok: true, note: `${summary.steps} steps, about ${summary.points} pp; waiting for the user's approval` };
      }
      case "discard":
        // A separate process can write after any cleanliness check; preserve the worktree for the user's review.
        return { error: "Automatic discard is unavailable. Ask the user to review this task and use Discard manually." };
      case "switch": {
        // The F41 path (switchAccount), then the card's next run: a resume of the same conversation, or a new session in the same worktree.
        const had = !!target!.sessionId;
        const next = this.switchAccount(target!, req.account!);
        this.update(target!, { switchedTo: target!.account, waitsForReset: undefined });
        if (!had) return { ok: true, note: `moved to ${target!.account}; not started` };
        if (inCardTerminal(target!)) await this.launchInCard(target!); // a battle's card (a47807): its next run is in its card terminal too
        else if (next === "start") await this.startHeadless(target!); else await this.followUpHeadless(target!, "Continue.");
        return { ok: true, note: `moved to ${target!.account} and ${next === "start" ? "started in a new session in the same worktree" : "resumed"}` };
      }
      case "finish": {
        // `finish <id>`: another card, and only when its work has landed (finishLanded).
        if (target) { try { return await this.finishLanded(target, req); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; } }
        // A request (F97 section 9, the user 7 November 2026): at the master's Stop the board reviews the run, and autoFinish finishes it on Done.
        const problem = this.checks.deliveryProblem(by);
        if (problem) return { error: problem };
        this.update(by, { finishAsked: { at: new Date().toISOString() }, deliveryReady: true });
        if (by.status === "review") this.finishAtStop(by); // no Stop is coming: the turn already ended (an external controller)
        return { ok: true, note: "The board reviews the run when this turn ends. On Done it merges, pushes and cleans up by itself; otherwise it sends you what is left." };
      }
    }
  }

  // ---- F95: moving cards between controllers, takeover requests, and the operator's terminal ----

  /** How long a holder must have been idle before its cards may be claimed (entomatical.orchestrator.claimAfterMinutes). */
  claimGraceMs = CLAIM_GRACE_MS;
  /** The board.js a session runs (F87's turn-done line): the placed copy; a dev host sets its own tools/board.js (extension.ts). */
  boardCli = path.join(os.homedir(), ".entomatical", "board.js");
  /** This machine's operator token (src/operator.ts); tests point it elsewhere. */
  operatorTokenFile = OPERATOR_TOKEN_FILE();
  /** Every change of controller, one JSON line each (F95 item 7). Not status.jsonl: a new owner window rewrites that file. */
  get transfersFile() { return path.join(this.dir, "transfers.jsonl"); }

  /**
   * Moves cards, each with the cards under it, to another controller (F95; adopt since F69): `to` becomes their opener and watcher.
   * Branch, worktree, session and checks stay. Settle notices waiting for the old watcher follow the card. A takeover request on a
   * moved card is answered. A former holder that still works is told, except after claim, whose holders have finished. continueWork
   * (adopt) also clears the user's takeover and the cancel; a claim leaves a cancelled card cancelled.
   */
  private moveCards(to: Task, tops: Task[], o: { via: Transfer["via"]; by: string; reason?: string; op?: Transfer["op"]; approvedBy?: string; countOpened?: boolean; continueWork?: boolean }): { live: boolean } {
    // Phase 3: no route (agent, operator, takeover approval) moves cards into or out of a governed run; checked before anything moves.
    for (const t of [to, ...tops]) { const g = governedRootOf(t, this.tasks) ?? (governedBelow(t, this.tasks) ? { id: governedBelow(t, this.tasks)!.governedBy ?? "?" } : undefined); if (g) throw new Error(`Card ${t.id} is in or holds governed run ${g.id}; moving cards into or out of a governed run is not supported (phase 3).`); }
    const root = runRoot(to, this.tasks) ?? to;
    const live = new Set(this.live());
    const existing = new Set(runCards(root.id, this.tasks).map((t) => t.id));
    const at = new Date().toISOString(), records: Transfer[] = [], wake = new Set<string>();
    let anyLive = false;
    this.loadNotifications();
    for (const top of tops) {
      const from = top.openedBy ?? null, watcher = top.watchedBy ?? top.openedBy, ask = top.takeoverAsk;
      const subtree = [top, ...runCards(top.id, this.tasks)];
      if (!o.continueWork) for (const t of subtree) {
        if (!t.held || t.sessionId || t.status !== "queued") continue;
        // The outgoing controller requested auto-start. Transferring control does not carry its queued launch into a different run.
        t.held = undefined;
        t.stepHold = `Control transferred to ${to.id}. Its new controller can start this card when ready.`;
      }
      if (o.countOpened && root.orchestrator) root.orchestrator.opened += subtree.filter((t) => !existing.has(t.id)).length;
      const record: Transfer = { op: o.op ?? "takeover", via: o.via, id: top.id, from, to: to.id, by: o.by, ...(o.reason ? { reason: o.reason } : {}), ...(o.approvedBy ? { approvedBy: o.approvedBy } : {}), at };
      records.push(record);
      this.update(top, { openedBy: to.id, watchedBy: to.id, parentId: to.id, takeoverAsk: undefined,
        ...(o.continueWork || o.approvedBy ? { takenOver: undefined } : {}), ...(o.continueWork ? { cancelled: undefined } : {}),
        ...(o.via !== "adopt" ? { transfers: [...(top.transfers ?? []), record].slice(-10) } : {}) });
      for (const t of subtree) {
        if (live.has(t.id)) anyLive = true;
        this.update(t, { runPolicy: root.runPolicy,
          ...((granted) => !live.has(t.id) ? { headless: true, permission: granted, pendingPermission: undefined } : { pendingPermission: granted })(inheritedPermission(to, t.provider === "grok" || t.provider === "antigravity")),
          ...(t.orchestrator ? { orchestrator: { ...t.orchestrator, root: root.id, caps: root.orchestrator?.caps ?? t.orchestrator.caps }, approved: root.approved } : {}) });
      }
      const box = watcher && watcher !== to.id ? this.pendingNotices.get(watcher) : undefined, held = box?.get(top.id);
      if (held) { box!.delete(top.id); if (!box!.size) this.pendingNotices.delete(watcher!); this.queueNotice(to.id, top.id, held); }
      if (from && from !== to.id && from !== o.by && o.via !== "claim" && o.via !== "claim-tree") {
        this.queueNotice(from, `handoff:${top.id}`, `Ownership handoff: card ${top.id} (${top.title}) is now assigned to ${to.id} (${to.title}). Remove it from your pending work. Do not resume, mark Done or reclaim it; message ${to.id} if coordination is needed. Current board assignments supersede the earlier task packet.`);
        wake.add(from);
      }
      if (ask) {
        const granted = ask.by === to.id;
        this.queueNotice(ask.by, `takeover:${top.id}`, granted
          ? `Takeover granted${o.approvedBy ? ` by ${o.approvedBy}` : o.via === "handoff" ? ` by ${o.by}, who handed it to you` : ""}: you control card ${top.id} (${top.title}) now. Its branch, worktree and checks are unchanged.${live.has(top.id) ? " It still has a live session: stop it before you resume or cancel it." : ""}`
          : `Your takeover request for card ${top.id} (${top.title}) was dropped: it went to ${to.id} (${o.via}).`);
        wake.add(ask.by);
      }
    }
    root.deliveryReady = undefined; root.reported = undefined; this.save();
    try { fs.appendFileSync(this.transfersFile, records.map((r) => JSON.stringify(r) + "\n").join("")); } catch (e) { console.error("Entomatical: transfers.jsonl", e); }
    for (const id of wake) this.deliverNotices(id);
    return { live: anyLive };
  }

  /** request-takeover (F95 item 3): recorded on the card, told to a live owner, and put to the user with Approve and Deny. Nothing moves yet. */
  private requestTakeover(by: Task, target: Task, reason: string): Record<string, unknown> {
    this.update(target, { takeoverAsk: { id: crypto.randomUUID(), by: by.id, reason, at: new Date().toISOString() } });
    const owner = target.openedBy ? this.get(target.openedBy) : undefined;
    const ownerLive = !!owner && owner.id !== by.id && (owner.status === "running" || this.live().includes(owner.id));
    if (ownerLive) {
      this.queueNotice(owner!.id, `takeover:${target.id}`, `Takeover request: card ${by.id} (${by.title}) asks to take over your card ${target.id} (${target.title}): ${reason}. If you agree, run \`board.js handoff ${target.id} --to ${by.id}\`; otherwise the user decides.`);
      this.deliverNotices(owner!.id);
    }
    this.runEvents.fire({ kind: "takeoverAsked", master: masterOf(by, this.tasks) ?? by, task: target, by, text: reason });
    return { ok: true, note: `Asked the user to let you take over ${target.id}${ownerLive ? `; its owner ${owner!.id} was told and may hand it to you first` : ""}. Nothing moved yet. The answer comes as a message (board.js receive, or it wakes you); \`board.js wait --ids ${target.id}\` also wakes when the card changes hands.` };
  }
  /** Fires takeoverAsked again for each request still waiting, so a window opened after it still offers Approve and Deny. Returns how many. */
  announceTakeoverAsks(): number {
    let n = 0;
    for (const target of this.tasks) {
      const by = target.takeoverAsk ? this.get(target.takeoverAsk.by) : undefined;
      if (!by) continue;
      this.runEvents.fire({ kind: "takeoverAsked", master: masterOf(by, this.tasks) ?? by, task: target, by, text: target.takeoverAsk!.reason });
      n++;
    }
    return n;
  }
  private pendingTakeover(id: string, expected: TakeoverAsk | undefined) {
    this.mustOwnActive();
    if (!expected) throw new Error(`Card ${id} has no takeover request.`);
    const target = this.get(id), ask = target?.takeoverAsk;
    // Requests saved before IDs existed can only be identified by their original fields.
    if (!target || !ask || ask.id !== expected.id || (ask.id === undefined &&
        (ask.by !== expected.by || ask.at !== expected.at || ask.reason !== expected.reason))) {
      throw new Error(`The takeover request for card ${id} has expired.`);
    }
    return { target, ask };
  }
  /** Approve on a takeover request (the notification, or the operator's `board.js approve`): the requester gets the card, live or not. */
  approveTakeover(id: string, expected: TakeoverAsk | undefined, approvedBy = "the user"): string {
    const { target, ask } = this.pendingTakeover(id, expected);
    const by = this.get(ask.by);
    const drop = (why: string) => { this.update(target, { takeoverAsk: undefined }); throw new Error(`${why}; the request was dropped.`); };
    if (!by || by.status === "done" || by.cancelled) return drop(`The card that asked (${ask.by}) is ${by ? (by.cancelled ? "cancelled" : "done") : "gone"}`);
    if (!by.orchestrator) return drop(`Card ${by.id} is no longer an orchestrator`);
    if (target.id === by.id || runCards(target.id, this.tasks).some((t) => t.id === by.id)) return drop(`Card ${target.id} holds ${by.id}, so the move would create a cycle`);
    this.moveCards(by, [target], { via: "request", by: by.id, reason: ask.reason, approvedBy });
    return `Card ${target.id} is ${by.id}'s now.`;
  }
  /** Deny on a takeover request: the request goes, the requester is told. */
  denyTakeover(id: string, expected: TakeoverAsk | undefined, deniedBy = "the user"): string {
    const { target, ask } = this.pendingTakeover(id, expected);
    this.update(target, { takeoverAsk: undefined });
    this.queueNotice(ask.by, `takeover:${target.id}`, `${deniedBy} denied your request to take over card ${target.id} (${target.title}). Leave it; message its owner if you need something from it.`);
    this.deliverNotices(ask.by);
    return `Denied ${ask.by}'s request for ${target.id}.`;
  }

  /** An explicit retry keeps a refused cancellation in force and records a fresh dispatch failure on the same card. */
  private async restartCard(task: Task, operator = false): Promise<{ ok: true } | { error: string }> {
    if (this.isStarting(task.id)) return { error: "busy: it is starting" };
    const hidden = !!(task.headless || task.openedBy), battle = inCardTerminal(task) && !!(task.openedBy || task.orchestrator);
    if (operator && !hidden && !battle && task.sessionId && !this.everReady(task)) return { error: "Not started: its session never came up. Press Start on the card." };
    if ((hidden || battle) && (!task.sessionId || task.cancelled || task.status === "done")) {
      const wait = this.startWait(task);
      if (wait) return { error: wait };
    }
    const { cancelled, openedBy, watchedBy, transfers, controller, takenOver, sessionId, status, terminalLaunch, stepHold } = task;
    const events = this.events(task.id).length, dispatchedAt = this.headlessStartedAt.get(task.id);
    this.update(task, { cancelled: undefined, launchError: undefined, startRetryAt: undefined });
    try {
      if (battle) await this.launchInCard(task);
      else if (!task.sessionId && hidden) await this.startHeadless(task);
      else if (hidden) await this.followUpHeadless(task, INTERRUPTED_NUDGE);
      else await this.resume(task, operator ? "Resume." : undefined);
      return { ok: true };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (this.isOwner() && this.get(task.id) === task && !task.cancelled && !task.discarded && task.status === status && task.sessionId === sessionId &&
          task.terminalLaunch === terminalLaunch && !this.hasProcess(task) && this.headlessStartedAt.get(task.id) === dispatchedAt && this.events(task.id).length === events &&
          task.stepHold === stepHold && task.openedBy === openedBy && task.watchedBy === watchedBy && task.transfers === transfers && task.controller === controller && task.takenOver === takenOver)
        this.update(task, { launchError: error, cancelled, startRetryAt: undefined });
      return { error };
    }
  }

  /** F95 item 5: what the user's own terminal may do, as the card's buttons do it. The signature was checked by handleRequest. */
  private async handleOperator(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const v = validateOperatorRequest(raw);
    if ("error" in v) return { error: v.error };
    const { op, id, text, to, reason } = v.request;
    const task = this.get(id);
    if (!task) return { error: `No card ${id}` };
    const live = () => task.status === "running" || this.live().includes(task.id);
    switch (op) {
      case "stop": this.stop(task); return { ok: true, note: `Stopped ${id}.` };
      case "resume": {
        if (live()) return { error: "busy: it is running" };
        const result = await this.restartCard(task, true);
        return "error" in result ? result : { ...result, note: `Resumed ${id}.` };
      }
      case "done":
        if (task.planRun?.review === "checks" && !this.everReady(task)) return { error: "This plan card runs no session: the board checks its steps and merges them here. Press Finish when every step is Done." };
        // A cancelled card may go to Done: it keeps `cancelled`, so it still earns no completion credit (25 November 2026).
        if ((task.openedBy || task.orchestrator) && !task.cancelled && !this.everReady(task)) return { error: "This card never started. Cancel it to preserve it without completion credit." };
        this.update(task, { status: "done" });
        return { ok: true, note: `${id} is Done.` };
      case "cancel":
        if (live()) return { error: "Stop the card before cancelling it." };
        this.checks.stop(task);
        this.update(task, { cancelled: true, held: undefined, status: "review" }, undefined, true);
        return { ok: true, note: "Cancelled; preserved without completion credit." };
      case "send":
        if (task.provider === "grok" || task.provider === "antigravity") await this.followUpHeadless(task, text!); else await this.send(task, text!);
        return { ok: true, note: `Sent to ${id}.` };
      case "handoff": {
        const dest = this.get(to);
        if (!dest) return { error: `No card ${to}` };
        if (!dest.orchestrator) return { error: `handoff: card ${dest.id} is not an orchestrator, so it cannot hold cards` };
        if (dest.id === task.id || runCards(task.id, this.tasks).some((t) => t.id === dest.id)) return { error: `handoff: card ${dest.id} is ${dest.id === task.id ? "the card itself" : `under ${task.id}`}; that would create a cycle` };
        this.moveCards(dest, [task], { via: "operator", op: "handoff", by: "operator", reason, approvedBy: "the user" });
        this.queueNotice(dest.id, `handoff:operator:${task.id}`, `Handoff: the user gave you card ${task.id} (${task.title})${reason ? `: ${reason}` : ""}. You control it now: review, merge or cancel it as your brief says.`);
        this.deliverNotices(dest.id);
        return { ok: true, note: `Handed ${task.id} to ${dest.id}.` };
      }
      case "approve": return { ok: true, note: this.approveTakeover(task.id, task.takeoverAsk, "the user") };
      case "deny": return { ok: true, note: this.denyTakeover(task.id, task.takeoverAsk, "the user") };
    }
  }

  /** The master's plan file (4.3). */
  planFile(master: Task) { return path.join(master.worktree ?? this.repo, "ORCHESTRATION.md"); }

  /** the user approved the plan (13.2 item 6): the master may open cards, and is told so. */
  async approvePlan(master: Task, options: { pressureWatchers?: boolean } = {}) {
    if (!master.plan) throw new Error("This card has no plan waiting for approval.");
    if (master.governed && options.pressureWatchers) throw new Error("Pressure watchers are not supported in governed runs (phase 3): they would open cards outside the run's assignments and leases.");
    ensureCatalogue(this.repo);
    let hash = "";
    try { hash = crypto.createHash("sha256").update(fs.readFileSync(this.planFile(master))).digest("hex").slice(0, 12); } catch { /* the file moved */ }
    this.approving.add(master.id);
    try {
      this.update(master, { approved: { at: new Date().toISOString(), hash, ...(options.pressureWatchers ? { pressureWatchers: true } : {}) },
        orchestrator: { ...master.orchestrator!, caps: master.plan.caps ?? master.orchestrator!.caps },
        runPolicy: master.plan.policy ?? master.runPolicy ?? { allow: [], deny: [], noSync: true },
        status: master.status === "needs-input" ? "review" : master.status });
    } finally { this.approving.delete(master.id); }
    for (const child of runCards(master.id, this.tasks)) {
      child.runPolicy = master.runPolicy;
      if (child.orchestrator) { child.orchestrator.caps = master.orchestrator!.caps; child.approved = master.approved; }
    }
    this.save();
    // Queued like a settle notice: the master's hidden run may still be ending (seen 4 November 2026), and the queue is retried until it can go.
    this.queueNotice(master.id, "plan", APPROVED_NOTICE(localTime(Date.now(), { second: undefined })));
    this.deliverNotices(master.id);
  }

  /** Text to an orchestrator card: a headless resume, or a paste into its board terminal; a card the user took over gets nothing (4.3, phase 2 decision). */
  private async deliver(task: Task, text: string, newWork = false): Promise<boolean> {
    if (!this.canDeliver(task)) return false;
    if (task.headless && !task.takenOver) {
      if (!task.sessionId && (task.role === "judge" || task.role === "scribe")) await this.startHeadless(task);
      else await this.followUpHeadless(task, text, newWork);
      return true;
    }
    if (this.acpBattleTerminal(task)) {
      // Typed as board.js type types it, then Enter, which runs the card again until it reports this turn done too (turnTyped).
      if (newWork) this.invalidateDelivery(task);
      this.cardTerminals.write(task.id, text.includes("\n") ? `\u001b[200~${text}\u001b[201~` : text);
      await sleep(200);
      this.cardTerminals.write(task.id, "\r");
      this.turnTyped(task);
      return true;
    }
    this.send(task, text, newWork);
    return true;
  }
  /**
   * A battle's Grok or Antigravity card in its own terminal (a47807): it has no board terminal, so its notices are typed into its card
   * terminal once it reported its turn done (board.js turn-done puts it in Review). Other Grok and Antigravity cards read theirs with receive.
   */
  private acpBattleTerminal(task: Task): boolean {
    return inCardTerminal(task) && (task.provider === "grok" || task.provider === "antigravity") && !!task.cardTerminalStarted && this.cardTerminals.has(task.id);
  }
  /** Whether a notice can go to the card now: idle in Review, and either a headless card with no run still ending, or a board terminal. */
  private canDeliver(task: Task): boolean {
    if (!this.canDeliverIgnoringLease(task)) return false;
    // Phase 3: a governed parent continues only when it may take an execution lease (it is held back, not refused: the tick retries).
    return !governedRootOf(task, this.tasks) || !this.governedWait(task);
  }
  private canDeliverIgnoringLease(task: Task): boolean {
    if (task.status !== "review" || task.cancelled || task.takenOver || task.controller || task.orchestrator?.session || task.deliveryReady || task.checks?.status === "running") return false;
    if (task.headless) {
      if (!task.sessionId && (task.role === "judge" || task.role === "scribe")) return !this.terminal(task) && !this.codexRuns.has(task.id);
      return !this.terminal(task) && !this.codexRuns.has(task.id) && !!task.sessionId && !!task.worktree && !this.external.has(task.sessionId);
    }
    return !!this.terminal(task) || this.acpBattleTerminal(task);
  }

  /** A settled child (4.2): remembers its line for its watcher, unless nothing changed since the last notice. True when queued. */
  private noteSettle(t: Task, r: StatusRecord): boolean {
    const watcher = t.watchedBy ?? t.openedBy;
    if (!watcher || !isSettled(r)) return false;
    if ((t.role === "judge" || t.role === "scribe") && !t.sessionId) return false;
    // The turn a recovery hold doubted has ended (it outlived the reload; seen on linux, 6 November 2026): handle its result as usual.
    if (t.stepHold === ROLE_RECOVERY_HOLD) {
      const a = t.role === "judge" ? t.judging : t.scribe?.active;
      if (a && this.events(t.id).some((e) => e.t >= a.at && ["Stop", "StopFailure", "Interrupt"].includes(e.hook_event_name ?? ""))) { t.stepHold = undefined; this.save(); }
    }
    if (t.council) { void this.councilResult(t).catch((e) => console.error("Entomatical: council result", e)); return false; }
    if (t.role === "judge") { if (t.status === "review" && t.judging) this.scheduleJudgeResult(t); return false; }
    const key = settleKey(r);
    if (this.notified.get(t.id) === key) return false;
    this.notified.set(t.id, key);
    if (this.muted.has(t.id)) return false; // the board is handling its usage limit: its next run ends the silence (launchHeadless)
    // A plan step (F72): the board commits what it left, then judges it by its checks itself, or tells the plan's reviewer. One
    // step's settles are handled one after the other: two at once would race for its worktree's git index.
    const plan = this.get(watcher);
    if (!plan?.planRun && t.judge && !t.judged && t.status === "review" && !t.interrupted && t.checks?.status === "complete") {
      const root = masterOf(t, this.tasks);
      if (root) void this.requestJudgment(t, root).catch((e) => console.error("Entomatical: judge", e));
      return false;
    }
    if (plan?.planRun && (this.isPlanStep(t, plan) || t.role === "scribe")) {
      this.queuePlanStep(t, plan);
      return false;
    }
    const ancestors = new Set([watcher]);
    // A pressure watcher owns this set of notifications; its own summary reaches the root.
    // Not a plan card (F119): it hears of its own steps only (queuePlanStep above); a card a step opened is that step's to accept.
    if (watcher === t.openedBy) for (let ancestor = this.get(t.openedBy), depth = 0; ancestor && depth < 10; ancestor = this.get(ancestor.openedBy), depth++) if (!ancestor.planRun) ancestors.add(ancestor.id);
    for (const id of ancestors) this.queueNotice(id, t.id, r.status === "needs-input" ? `Child needs input: ${r.line}` : r.line);
    if (r.status === "needs-input" || r.chips.includes("interrupted")) { const m = masterOf(t, this.tasks); if (m) this.runEvents.fire({ kind: "needsYou", master: m, task: t }); }
    return true;
  }

  /** Pressure is checked after publication, outside the synchronous save/notification recursion. */
  private readonly pressureStarting = new Set<string>();
  private pressureSet(root: Task): Task[] {
    const caps = root.orchestrator?.caps, pending = this.pendingNotices.get(root.id);
    if (!caps || !pending || !root.approved?.pressureWatchers || root.paused || root.pressureError || root.status !== "running" || !this.orchestratorEnabled()) return [];
    const request: Request = { v: 1, op: "add", by: root.id, session: boundSessionOf(root) ?? null, at: new Date().toISOString(), nonce: "pressure", title: "Pressure watcher", prompt: "Supervise assigned cards", account: root.account, ...watcherModel(root), permission: root.permission, mayOpen: true };
    if (this.refusalOf(request)) return [];
    const acpRoot = root.provider === "grok" || root.provider === "antigravity", account = acpRoot ? this.resolveAccount(root.account) : undefined;
    if (account && inheritedPermission(root, true) === "ask" && this.acpAskRefusal(account)) return []; // its watcher could not ask
    const cards = runCards(root.id, this.tasks);
    if (!caps.pending || !caps.perWatcher || !caps.watchers || caps.depth < 2 || cards.filter((t) => t.status !== "done" && !t.cancelled).length >= caps.open || root.orchestrator!.opened >= caps.total || cards.filter((t) => t.orchestrator && t.status !== "done" && !t.cancelled).length >= caps.watchers) return [];
    const available = cards.filter((t) => t.openedBy === root.id && (t.watchedBy ?? root.id) === root.id && !t.orchestrator && !t.role && !t.takenOver && !t.controller && t.status !== "done" && !t.cancelled);
    if (available.filter((t) => pending.has(t.id)).length < caps.pending) return [];
    return available.sort((a, b) => Number(pending.has(b.id)) - Number(pending.has(a.id)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, caps.perWatcher);
  }
  private schedulePressureWatcher(root: Task) {
    if (this.pressureStarting.has(root.id) || !this.pressureSet(root).length) return;
    this.pressureStarting.add(root.id);
    queueMicrotask(() => void this.openPressureWatcher(root).catch((e) => console.error("Entomatical: pressure watcher", e)).finally(() => this.pressureStarting.delete(root.id)));
  }
  private async openPressureWatcher(root: Task) {
    this.mustOwn();
    if (!this.pressureSet(root).length) return;
    await this.preflightHeadless(root.provider, root.configDir);
    this.mustOwn();
    if (this.get(root.id) !== root) return;
    const group = this.pressureSet(root); // caps, approval, pause and assignments can change while preflight yields
    if (!group.length) return;
    const ids = group.map((t) => t.id), caps = root.orchestrator!.caps;
    let brief: string | undefined;
    try { brief = fs.readFileSync(this.watcherPath, "utf8"); } catch { /* watcherPrompt falls back to the one-paragraph prompt */ }
    const prompt = watcherPrompt(brief, ids, root.id, root.runPolicy, caps.followUps), { model, effort } = watcherModel(root); // F73
    const watcher = this.add(`Watch ${ids.length} cards`, prompt, root.account, root.id, model, effort, undefined,
      { headless: true, role: "sub", openedBy: root.id, watchedBy: root.id, permission: inheritedPermission(root, root.provider === "grok" || root.provider === "antigravity"), orchestrator: { caps, opened: 0, root: root.id } });
    watcher.approved = root.approved; watcher.runPolicy = root.runPolicy; watcher.watches = ids;
    root.orchestrator!.opened++; root.deliveryReady = undefined; root.reported = undefined;
    const source = this.pendingNotices.get(root.id);
    for (const t of group) {
      t.watchedBy = watcher.id;
      const notice = source?.get(t.id);
      if (notice) { source!.delete(t.id); this.queueNotice(watcher.id, t.id, notice); }
    }
    if (source && !source.size) this.pendingNotices.delete(root.id);
    this.queueNotice(root.id, `watcher:${watcher.id}`, `Sub-orchestrator ${watcher.id} opened, watching ${ids.join(" ")}.`);
    this.saveNotifications(); this.save();
    try {
      const wait = this.startWait(watcher);
      if (wait) this.update(watcher, { held: true });
      else await this.startHeadless(watcher);
    } catch (e) {
      this.recoverPressureWatcher(watcher, `could not start: ${e instanceof Error ? e.message : String(e)}`);
      this.update(watcher, { cancelled: true, launchError: e instanceof Error ? e.message : String(e), status: "review" }, undefined, true);
    }
  }

  /** A stopped watcher never strands its assigned cards or their notices. */
  private recoverPressureWatcher(watcher: Task, reason: string) {
    const root = masterOf(watcher, this.tasks);
    if (!root?.orchestrator || root.id === watcher.id) return;
    const assigned = this.tasks.filter((t) => t.watchedBy === watcher.id && t.openedBy === root.id && !t.cancelled);
    if (!assigned.length && !watcher.branch && !watcher.worktree && !watcher.sessionId) return;
    for (const t of assigned) {
      t.watchedBy = root.id;
      const pending = this.pendingNotices.get(watcher.id)?.get(t.id);
      if (pending || isSettled(this.statusOf(t))) this.queueNotice(root.id, t.id, pending ?? this.statusOf(t).line);
      this.pendingNotices.get(watcher.id)?.delete(t.id);
    }
    root.pressureError = `Watcher ${watcher.id} ${reason}; its cards returned to the root. Reconcile its branch and worktree before declaring ready.`;
    root.pressureWatchersBlocked = [...new Set([...(root.pressureWatchersBlocked ?? []), watcher.id])];
    this.queueNotice(root.id, `watcher-error:${watcher.id}`, root.pressureError);
    this.saveNotifications(); this.save();
  }

  /** Never clear a failed watcher until its preserved branch is included and its worktree has no leftovers. */
  private async resolvePressureWatchers(root: Task): Promise<boolean> {
    for (const id of root.pressureWatchersBlocked ?? []) {
      const watcher = this.get(id);
      if (!watcher) return false;
      if (!watcher.branch && !watcher.worktree && !watcher.sessionId) continue; // preflight failed before allocating anything
      if (!watcher.branch || !root.branch || (watcher.worktree && !fs.existsSync(watcher.worktree)) || await this.hasUncommitted(watcher)) return false;
      if (!await git(this.repo, ["merge-base", "--is-ancestor", watcher.branch, root.branch]).then(() => true, () => false)) return false;
      for (const childId of watcher.watches ?? []) {
        const child = this.get(childId);
        if (!child) return false;
        if (child.status === "done" && !child.cancelled && (!child.branch || !await git(this.repo, ["merge-base", "--is-ancestor", child.branch, root.branch]).then(() => true, () => false))) return false;
      }
    }
    if (!this.owned || !this.isOwner()) return false;
    this.update(root, { pressureError: undefined, pressureWatchersBlocked: undefined });
    return true;
  }

  /** Sends a watcher its pending notices in one message, when it is idle and its run is not paused (4.2, 4.7). */
  deliverNotices(watcherId: string) {
    this.loadNotifications();
    const watcher = this.get(watcherId), box = this.pendingNotices.get(watcherId);
    if (!watcher || !box?.size) return;
    const master = masterOf(watcher, this.tasks) ?? watcher;
    if (master.paused || this.delivering.has(watcherId) || !this.canDeliver(watcher)) return;
    const activeRole = watcher.role === "judge" ? watcher.judging : watcher.role === "scribe" ? watcher.scribe?.active : undefined;
    // An earlier host may have started this turn already; recovery must hold it, not resend it.
    if (activeRole?.phase === "dispatching") return;
    const sent = new Map(box);
    const isDirect = (k: string, text: string) => k === "plan" || k === "orchestrator" || k === "budget" || k.startsWith("message:") || k.startsWith("handoff:") || k.startsWith("terminal-input:") || text.startsWith("Child needs input:");
    const direct = [...sent.entries()].filter(([k, text]) => isDirect(k, text)).map(([, text]) => text);
    const lines = [...sent.entries()].filter(([k, text]) => !isDirect(k, text)).map(([, text]) => text);
    const text = [...direct, lines.length ? noticeText(lines) : undefined].filter(Boolean).join("\n\n");
    this.delivering.add(watcherId);
    const assignment = watcher.role === "judge" ? watcher.judging : watcher.role === "scribe" ? watcher.scribe?.active : undefined;
    if (assignment?.phase === "pending") { assignment.phase = "dispatching"; this.save(); }
    void this.deliver(watcher, text, [...sent.keys()].some((k) => k.startsWith("message:"))).then((delivered) => { if (delivered) this.acknowledgeMessages(watcherId, sent); }, (e) => console.error("Entomatical: settle notice", e)).finally(() => this.delivering.delete(watcherId));
  }
  /** Masters whose Approve is moving them back to Review right now (approvePlan). */
  private readonly approving = new Set<string>();
  /** Watchers whose notice is on its way (a headless resume awaits a tick or two): no second delivery meanwhile. */
  private readonly delivering = new Set<string>();

  /** Every child is Done: the run is finished, once (13.2 item 7). */
  private maybeFinished(master: Task) {
    if (master.reported || master.orchestrator?.root || !master.deliveryReady || master.status !== "review" || master.interrupted) return;
    const children = runCards(master.id, this.tasks);
    if (!children.length || children.some((c) => c.status !== "done" && !c.cancelled)) return;
    if (master.completion?.commands.length && master.checks?.status !== "complete") return;
    if (this.checks.deliveryProblem(master)) {
      this.update(master, { deliveryReady: undefined });
      return;
    }
    this.update(master, { reported: true });
    this.runEvents.fire({ kind: "finished", master, text: master.planRun ? this.archivePlan(master) : undefined });
  }
  /**
   * F99: the finished run's plan file moves to archive/ beside it, so Run a plan… no longer lists it. Finished is the moment the run's
   * reviewer is satisfied: a model plan's reviewer ran board.js ready, or the board accepted every step of a checks plan. Returns the
   * line for the "finished" notification; a failure is reported there and never stops the finish.
   */
  private archivePlan(master: Task): string | undefined {
    const run = master.planRun!;
    if (run.archived) return undefined;
    if (run.approval) return run.reusable ? "plan kept: reusable was explicitly approved" : "plan kept with its single-use receipt; another run is refused";
    // Phase 4: a commit in the main checkout after review would bypass readiness; a governed run never archives this way.
    { const why = targetEffectRefusal(master, this.tasks, "Plan archival"); if (why) return `plan not archived: ${why}`; }
    try {
      if (run.sourceHash) {
        const file = path.resolve(this.repo, run.file);
        if (!fs.existsSync(file) || crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== run.sourceHash)
          return "plan not archived: the original file changed or is missing";
      }
      // the user, 14 November 2026: a plan that takes variables is reusable, so it stays in Run a plan….
      if (Object.keys(describePlanFile(this.repo, path.resolve(this.repo, run.file)).vars ?? {}).length) return "plan kept in Run a plan…: it takes variables, so it can be run again";
      const r = archivePlanFile(this.repo, run.file, master.id);
      if (!r) return undefined;
      this.update(master, { planRun: { ...run, file: r.to, archived: r.to } });
      return r.committed ? `plan archived to ${r.to} (committed ${r.committed}, not pushed)` : r.skipped ? `plan archived to ${r.to}, not committed: ${r.skipped}` : `plan archived to ${r.to}`;
    } catch (e) {
      console.error("Entomatical: archive plan", e);
      return `the plan file ${run.file} was not archived: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** F117: why Make orchestrator is not offered for this card, or undefined. The card's menu asks the same question (media/board.js). */
  makeOrchestratorRefusal(task: Task): string | undefined {
    if (!this.orchestratorEnabled()) return "The orchestrator is off (entomatical.orchestrator.enabled).";
    if (task.orchestrator) return "This card is an orchestrator already.";
    if (task.openedBy) return "An orchestrator opened this card. Its opener makes coordinators itself (board.js add --may-open).";
    if (task.planRun || task.workflow || task.battle || task.role || task.council || governedRootOf(task, this.tasks)) return "A plan card, a workflow step, a Battle Royale card, a standing role or a governed card cannot be made an orchestrator.";
    if (task.status === "done") return "This card is Done. Reopen it first.";
    return undefined;
  }
  /**
   * F117 (the user, 17 November 2026): Make orchestrator on a card of his own. The card becomes the root of a run with the default caps,
   * as a card added with Orchestrator ticked is; its session, permission and terminal stay as they are. Nothing is approved: the
   * session proposes its run with `board.js plan` and the user approves it on the card. The session never saw the brief, so the board
   * sends it as a message: at once to an idle hidden card or one in a board terminal, else at `board.js receive`. Returns true when
   * the message went out now.
   */
  makeOrchestrator(task: Task): boolean {
    this.mustOwn();
    const why = this.makeOrchestratorRefusal(task);
    if (why) throw new Error(why);
    let brief = "";
    try { brief = fs.readFileSync(this.briefPath, "utf8"); } catch { /* the message still says what changed and where the verbs are */ }
    this.update(task, { orchestrator: { caps: this.capsOf(), opened: 0 } });
    this.queueNotice(task.id, "orchestrator", assignedPrompt(brief, task.id));
    const now = !!task.sessionId && this.canDeliver(task);
    this.deliverNotices(task.id);
    return now;
  }

  /** Pause run (4.7): no card opens and notices are held; Resume run releases them. */
  pauseRun(master: Task) { this.update(master, { paused: true }); }
  resumeRun(master: Task) {
    this.update(master, { paused: undefined });
    if (master.pressureWatchersBlocked?.length) void this.resolvePressureWatchers(master).catch((e) => console.error("Entomatical: watcher recovery", e));
    this.deliverNotices(master.id); for (const c of runCards(master.id, this.tasks)) if (c.orchestrator || c.role === "judge" || c.role === "scribe") this.deliverNotices(c.id);
    if (master.planRun) this.queueScribeMilestone(master);
    // Reconstruct work from durable state; pausedSteps itself does not survive a reload.
    if (master.planRun) for (const t of runCards(master.id, this.tasks)) {
      if (t.watchedBy !== master.id || !["review", "needs-input"].includes(t.status) || t.cancelled) continue;
      if (this.isPlanStep(t, master)) {
        this.pausedSteps.delete(t.id);
        if (!t.checks && !t.interrupted && t.completion?.commands.length) this.preparePlanChecks(t, master);
        this.queuePlanStep(t, master);
      } else if (t.role === "scribe" && t.scribe?.active) this.queuePlanStep(t, master);
      else if (t.role === "judge" && t.judging) this.scheduleJudgeResult(t);
    }
    this.recoverRoleNotices(master);
    if (master.planRun?.review === "checks") void this.planDelivered(master);
  }
  /**
   * The points of the 5-hour window a card's finished runs moved (usage-history.ts taskCost), or undefined when that is unknown: a run
   * without a reading at its start or end, or a window that reset during it. A card with no finished run has cost nothing yet.
   */
  fiveHourOf(task: Task): number | undefined {
    if (!(task.usageRuns ?? []).some((r) => r.endedAt)) return 0;
    const w = taskCost(task.usageRuns)?.windows.find((x) => x.name === "5-hour");
    return w && !w.reset && !w.incomplete && typeof w.points === "number" ? Math.round(w.points * 10) / 10 : undefined;
  }
  /**
   * The run's measured budget (13.3 item 13), checked when a card's run ends: at 80 % the master is told once (a notice), at 100 % the
   * run is paused (Pause run: no new card, held notices) and the user is notified once. A turn in flight is never stopped. budgetNoticed
   * is on the card, so a reload repeats neither; the user's Resume run after a budget pause is his decision and is not undone.
   */
  checkBudget(master: Task) {
    const b = runBudget(master, this.tasks, (t) => this.fiveHourOf(t));
    const step = budgetStep(b, master.budgetNoticed);
    if (!step || !b) return;
    if (step === 80) { this.update(master, { budgetNoticed: 80 }); this.queueNotice(master.id, "budget", BUDGET_NOTICE(b)); this.deliverNotices(master.id); return; }
    this.update(master, { budgetNoticed: 100, paused: "budget" });
    this.queueNotice(master.id, "budget", BUDGET_NOTICE(b)); // held while paused; it goes after the user's Resume run
    this.runEvents.fire({ kind: "budget", master, text: `${b.used} of ${b.cap} points` });
  }

  /** Archived runs (4.7): .entomatical/archive/<master id>.json, one file per run; restored ones move to archive/restored/. */
  get archiveDir() { return path.join(this.dir, "archive"); }
  /** Why a card would hide unmerged work if it left the board: uncommitted changes, or a branch with commits not in `ref`. */
  async unmergedWork(t: Task, ref: string): Promise<string | undefined> {
    if (t.worktree && fs.existsSync(t.worktree) && !(await isClean(t.worktree).catch(() => false))) return "uncommitted changes";
    if (!t.branch || !(await git(this.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${t.branch}`]).then(() => true, () => false))) return undefined;
    return await git(this.repo, ["merge-base", "--is-ancestor", t.branch, ref]).then(() => undefined, () => `commits not in ${ref}`);
  }
  /**
   * Archive run (4.7): when the master is Done, its cards leave tasks.json for one archive file, with the plan's path and the final report.
   * It stops, changing nothing, while a card runs, while a card left on the board depends on one of them, or when any card has unmerged
   * work: uncommitted changes, or a branch not in the master's branch (the master's own: not in the repo's current branch). Nothing is deleted.
   */
  async archiveRun(master: Task): Promise<{ file: string; count: number }> {
    this.mustOwn();
    if (!master.orchestrator || master.orchestrator.root) throw new Error("Archive run is for a run's master card.");
    if (master.status !== "done") throw new Error(master.planRun?.review === "checks" ? "Archive run waits until the plan card is Done (Finish)."
      : "Archive run waits until the master card is Done (Finish, or Mark done).");
    const { cards, outside } = archiveSet(master, this.tasks);
    if (outside.length) throw new Error(`Cannot archive: ${outside.map((t) => `"${t.title}"`).join(", ")} stays on the board and depends on this run's cards. Move or delete it first.`);
    const running = cards.filter((t) => t.status === "running" || t.status === "needs-input" || this.terminal(t) || this.codexRuns.has(t.id) || (t.sessionId && this.external.has(t.sessionId)));
    if (running.length) throw new Error(`Cannot archive: ${running.map((t) => `"${t.title}"`).join(", ")} is still running. Stop run first.`);
    const ref = master.branch && await git(this.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${master.branch}`]).then(() => true, () => false) ? master.branch : "HEAD";
    const blockers: string[] = [];
    for (const t of cards) { const why = await this.unmergedWork(t, t === master ? "HEAD" : ref); if (why) blockers.push(`"${t.title}" (${t.id}: ${why})`); }
    if (blockers.length) throw new Error(`Cannot archive: ${blockers.join(", ")} has unmerged work.`);
    this.mustOwn(); // again: git took a moment
    if (!this.importedSpeech && cards.some(t => t.legacySpeechId)) this.rememberSpeechIds(cards);
    fs.mkdirSync(this.archiveDir, { recursive: true });
    let file = path.join(this.archiveDir, `${master.id}.json`);
    if (fs.existsSync(file)) {
      // Phase 6: a file whose cards are all still on the board is an archive cut off before its save (or a restore before its move): kept
      // under restored/ as a duplicate, never listed as a second run. Otherwise it was archived before and restored: keep both.
      let prior: { tasks?: Task[] } | undefined;
      try { prior = JSON.parse(fs.readFileSync(file, "utf8")); } catch { prior = undefined; }
      if (prior?.tasks?.length && prior.tasks.every((t) => this.get(t.id))) this.setAside(file, "dup");
      else file = path.join(this.archiveDir, `${master.id}-${Date.now()}.json`);
    }
    // Phase 6: the evidence the run refers to is copied beside the archive (hashed) and listed in a manifest; missing evidence is a gap in it.
    const at = new Date().toISOString(), evidenceDir = file.slice(0, -5) + ".evidence";
    // Left by an archive cut off before its save, or by a set-aside cut off between its renames: moved aside, never deleted (it may hold the only copies).
    if (fs.existsSync(evidenceDir)) { const restored = path.join(this.archiveDir, "restored"); fs.mkdirSync(restored, { recursive: true }); fs.renameSync(evidenceDir, path.join(restored, `${path.basename(evidenceDir, ".evidence")}-orphan-${Date.now()}.evidence`)); }
    const evidence = retain(evidenceOf(this.dir, cards, this.operations.list(), (id) => this.eventsFile(id)), evidenceDir);
    const record = { v: 2, master: master.id, title: master.title, archivedAt: at, plan: this.planFile(master),
      finalReply: this.finalReply(master) ?? null, summary: this.runSummaryOf(master) ?? null, tasks: cards, manifest: manifestOf(master, cards, evidence, at) };
    writeFileAtomic(file, JSON.stringify(record, null, 2));
    // The cards leave the board only once their records read back from the file.
    let back: { tasks?: unknown[] } | undefined;
    try { back = JSON.parse(fs.readFileSync(file, "utf8")); } catch { back = undefined; }
    if (!Array.isArray(back?.tasks) || back!.tasks!.length !== cards.length) throw new Error(`The archive file ${file} did not read back, so nothing left the board.`);
    const ids = new Set(cards.map((t) => t.id));
    this.tasks = this.tasks.filter((t) => !ids.has(t.id));
    this.loadNotifications();
    for (const id of ids) this.pendingNotices.delete(id);
    this.saveNotifications();
    this.save();
    return { file, count: cards.length };
  }
  /** The archived runs for the Done footer, newest first. */
  archivedRuns(): { key: string; master: string; title: string; archivedAt: string; cards: number }[] {
    let files: string[];
    try { files = fs.readdirSync(this.archiveDir).filter((f) => f.endsWith(".json")); } catch { return []; }
    return files.flatMap((f) => {
      try {
        // Every board rebuild lists these (audit finding 13): a file is parsed again only when its mtime or size changed.
        const file = path.join(this.archiveDir, f), st = fs.statSync(file), hit = this.archiveRows.get(file);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.rows;
        const r = JSON.parse(fs.readFileSync(file, "utf8"));
        const rows = Array.isArray(r?.tasks) ? [{ key: f.slice(0, -5), master: String(r.master), title: String(r.title), archivedAt: String(r.archivedAt), cards: r.tasks.length }] : [];
        this.archiveRows.set(file, { mtimeMs: st.mtimeMs, size: st.size, rows });
        return rows;
      } catch { return []; }
    }).sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  }
  private readonly archiveRows = new Map<string, { mtimeMs: number; size: number; rows: ReturnType<Board["archivedRuns"]> }>();
  /** One archive file's record, by its key (the file name without .json). */
  archivedRun(key: string): { master: string; title: string; archivedAt: string; plan: string; finalReply: string | null; summary: RunSummary | null; tasks: Task[]; manifest?: Manifest } {
    if (!/^[0-9a-f]{6}(-\d+)?$/.test(key)) throw new Error("Not an archived run.");
    const r = JSON.parse(fs.readFileSync(path.join(this.archiveDir, `${key}.json`), "utf8"));
    if (!Array.isArray(r?.tasks)) throw new Error("This archive file holds no cards.");
    return r;
  }
  /**
   * Restore (4.7): the records go back into tasks.json as Done, unless a card with one of their ids is on the board already (then nothing
   * changes). The file moves to archive/restored/, so a later Archive run of the same master writes a fresh one and nothing is lost.
   * Phase 6: the retained evidence is re-hashed first (missing or altered copies are returned as gaps, never trusted) and council packages
   * that are gone from .entomatical/council are put back from their verified copies. When every card is on the board already, an earlier
   * archive or restore was cut off before it finished: the file is only set aside (`reconciled`), nothing is restored twice.
   */
  restoreRun(key: string): { count: number; gaps: string[]; reconciled?: boolean } {
    this.mustOwn();
    const r = this.archivedRun(key), evidenceDir = path.join(this.archiveDir, `${key}.evidence`);
    const gaps = r.manifest ? recordGaps(evidenceDir, r) : ["archived before phase 6 (legacy): no evidence was retained with it"];
    const putBack = () => {
      for (const e of r.manifest?.evidence ?? []) {
        if (e.kind !== "council-package" || !e.copy || fs.existsSync(e.path)) continue;
        if (!within(path.join(this.dir, "council"), path.resolve(e.path))) { gaps.push(`council package ${e.path} is outside this board; not restored`); continue; }
        const copy = verifiedCopy(evidenceDir, e); // inside the evidence folder and still its recorded hash, or nothing is put back
        if (!copy) continue;
        fs.mkdirSync(path.dirname(e.path), { recursive: true });
        fs.copyFileSync(copy, e.path);
      }
    };
    const clash = r.tasks.filter((t) => this.get(t.id));
    if (clash.length && clash.length === r.tasks.length) { putBack(); this.setAside(path.join(this.archiveDir, `${key}.json`)); return { count: 0, gaps, reconciled: true }; }
    if (clash.length) throw new Error(`Cannot restore: ${clash.map((t) => `"${t.title}" (${t.id})`).join(", ")} ${clash.length === 1 ? "is" : "are"} on the board already.`);
    putBack();
    const now = new Date().toISOString();
    const back = r.tasks.map((t) => ({ ...t, status: "done" as Status, updatedAt: now }));
    rerootTasks(back, this.dir); // F118: an archive made before the workspace folder was renamed
    this.tasks.push(...back);
    // Already noticed: a restored Done card is no news to its master.
    this.loadNotifications();
    for (const t of back) this.notified.set(t.id, settleKey(this.statusOf(t)));
    this.saveNotifications();
    this.save();
    this.setAside(path.join(this.archiveDir, `${key}.json`));
    return { count: back.length, gaps };
  }
  /** Moves an archive file and its evidence folder to archive/restored/ under one new name; nothing is deleted. */
  private setAside(file: string, tag = "") {
    const restored = path.join(this.archiveDir, "restored"), name = `${path.basename(file, ".json")}${tag ? `-${tag}` : ""}-${Date.now()}`;
    fs.mkdirSync(restored, { recursive: true });
    // The evidence folder first: cut off between the two, the archive file still lists the run and its next archive moves nothing away.
    const evidence = file.slice(0, -5) + ".evidence";
    if (fs.existsSync(evidence)) fs.renameSync(evidence, path.join(restored, `${name}.evidence`));
    fs.renameSync(file, path.join(restored, `${name}.json`));
  }
  /**
   * Phase 6: a run's export (src/run-record.ts exportRun): identities, manifest, measurements and redacted cards. A card id on the board
   * exports that live run (its master's cards, current evidence); otherwise an archive key exports the archived run with its retained copies.
   */
  exportRun(key: string, from: "auto" | "archive" = "auto") {
    const harness = ledgerHarness(LEDGER_DIR);
    let extension: string | undefined;
    try { extension = `entomatical ${JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version}`; } catch { /* unknown */ }
    const live = from === "auto" ? this.get(key) : undefined;
    if (live) {
      const master = masterOf(live, this.tasks) ?? live;
      const { cards } = archiveSet(master, this.tasks);
      return exportRun(this.dir, { master: master.id, title: master.title, tasks: cards }, { ops: this.operations.list().filter((o) => cards.some((t) => t.id === o.run || t.id === o.card)), harness, extension });
    }
    return exportRun(this.dir, this.archivedRun(key), { evidenceDir: path.join(this.archiveDir, `${key}.evidence`), harness, extension });
  }

  /** The run's live cards, children before watchers before the master (the order Stop run uses). */
  liveRun(master: Task): Task[] {
    const live = (t: Task) => t.status === "running" || t.status === "needs-input" || this.codexRuns.has(t.id) || this.cardTerminals.has(t.id) || !!this.terminal(t);
    const deep = (t: Task) => { let d = 0; for (let x: Task | undefined = t; x?.openedBy && d < 10; d++) x = this.get(x.openedBy); return d; };
    return [...runCards(master.id, this.tasks).filter(live).sort((a, b) => deep(b) - deep(a)), ...(live(master) ? [master] : [])];
  }
  /** Stop run (4.7): every live card of the run, with its ordinary Stop, and every acceptance-check run still going; nothing is merged or deleted. */
  stopRun(master: Task): number {
    this.pauseRun(master); // keep completion notices and queued starts from restarting a stopped run
    const cards = this.liveRun(master);
    for (const t of cards) this.stop(t);
    // A Review card's checks are not a live card (CORE-GOV-15): end them too; the next tick's checks.sync() records them interrupted.
    for (const t of [...runCards(master.id, this.tasks), master]) this.checks.stop(t);
    return cards.length;
  }

  // ---- Battle Royale's arena (src/arena.ts, the user, 14 November 2026). ----

  /**
   * A battle's warning or call-off for one card: typed into a session that takes typed text (a VS Code terminal, a Claude or Codex card
   * terminal) as a follow-up is, but no dispatch (a plan step's gate claims nothing); else an orchestrator's inbox (its "battle" notice,
   * replaced by the next one); else nothing: the card only gets the wait. A session waiting on a prompt is not typed into (keys could
   * answer it).
   */
  warnBattle(task: Task, text: string): "typed" | "notice" | "wait" {
    const term = this.terminal(task);
    if (term && task.status !== "needs-input") { this.typeInto(task, term, text); return "typed"; }
    if (task.orchestrator) { this.battleNotice(task.id, text); return "notice"; }
    return "wait";
  }
  /**
   * Puts a card's battle notice in its inbox, or with no text drops one it has not read (a call-off, or the card stopped): true when
   * there was one to drop.
   */
  battleNotice(id: string, text: string | undefined): boolean {
    if (text !== undefined) { this.queueNotice(id, "battle", text); return false; }
    this.loadNotifications();
    const box = this.pendingNotices.get(id);
    if (!box?.delete("battle")) return false;
    if (!box.size) this.pendingNotices.delete(id);
    this.saveNotifications();
    return true;
  }
  /** A line the board itself adds to a card's events: the card's Timeline shows its desc (F89's "Waiting at:", Battle Royale's stop). */
  noteEvent(id: string, name: string, desc: string) {
    fs.appendFileSync(this.eventsFile(id), JSON.stringify({ t: Date.now(), hook_event_name: name, source: "board", desc }) + "\n");
  }
  /**
   * A battle's sweep, after the leftover processes are ended: each merged card whose folder Finish could not delete (cleanupPending) gets
   * the deletion Finish again would make, and is Done. A folder git still checks out, or one holding files written since, is left and
   * named, as Finish leaves it.
   */
  async retryCleanups(): Promise<{ removed: number; failed: string[] }> {
    const out = { removed: 0, failed: [] as string[] };
    const live = new Set(this.live());
    for (const task of this.tasks.filter((t) => t.cleanupPending && t.merged && t.worktree && t.branch && !live.has(t.id))) {
      try {
        this.mustOwn();
        if (fs.existsSync(task.worktree!)) {
          if (checkedOut(task.worktree!)) throw new Error("git still checks it out; press Finish on the card");
          const files = leftoverFiles(task.worktree!);
          if (files.length) throw new Error(`it still holds files: ${files.join(", ")}${files.length >= 10 ? " …" : ""}`);
        }
        await this.removeWorktree(task); // M-02: once what the card's Stop ended has really gone (releaseWriters)
        this.update(task, { status: "done", transcript: this.transcriptOf(task), ...ranIn(task), worktree: undefined, branch: undefined, cleanupPending: undefined, cleanup: undefined });
        out.removed++;
      } catch (e) { out.failed.push(`the folder of "${task.title}" (${task.worktree}): ${e instanceof Error ? e.message : String(e)}`); }
    }
    return out;
  }

  // ---- Plan files (F72; src/plan.ts; src/plan.ts). ----

  /** The plan reviewer's brief, beside the compiled code (out/../docs/orchestrator), so the packaged extension carries it too. */
  reviewerBriefPath = path.join(__dirname, "..", "docs", "orchestrator", "REVIEWER.md");
  /** Steps of a paused checks-only plan that settled meanwhile; Resume run judges them. */
  private readonly pausedSteps = new Set<string>();
  /** Settles for the same plan share one worktree; serialize their git work and final role merges. */
  private readonly stepRuns = new Map<string, Promise<void>>();
  /** Original assignments have stable ids. Older fixed plans predate that list. */
  isPlanStep(task: Task, plan: Task): boolean {
    return !!plan.planRun && !task.role && task.openedBy === plan.id && (plan.planRun.stepIds?.includes(task.id) ?? !plan.planRun.mayOpen);
  }

  private queuePlanStep(task: Task, plan: Task) {
    this.stepRuns.set(plan.id, (this.stepRuns.get(plan.id) ?? Promise.resolve()).then(() => this.stepSettled(task, plan)).catch((e) => console.error("Entomatical: plan step", e)));
  }
  private readonly planMerges = new Map<string, Promise<unknown>>();
  private async serializeRunMerge<T>(dest: Task, merge: () => Promise<T>): Promise<T> {
    const previous = this.planMerges.get(dest.id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(merge);
    this.planMerges.set(dest.id, current);
    try { return await current; } finally { if (this.planMerges.get(dest.id) === current) this.planMerges.delete(dest.id); }
  }

  /** An approved controller accepts a clean revision into its own card branch. Legacy reviewer Done verifies a previous merge. */
  private acceptRunBranch(child: Task, dest: Task, req: Request, verify: () => string | undefined) {
    return this.serializeRunMerge(dest, async () => {
      const branch = dest.branch, wt = dest.worktree, source = child.worktree;
      if (!wt || !source || branch !== `task/${dest.id}` || child.branch !== `task/${child.id}`)
        throw new Error("Integration needs the child's and controller's own card worktrees.");
      const requireCurrent = () => {
        const reason = verify();
        if (reason || dest.worktree !== wt || child.worktree !== source || child.openedBy !== dest.id)
          throw new Error(reason ?? "The controller or checkout changed. Review this card again.");
      };
      requireCurrent();
      await assertTaskCheckout(source, child.branch, false);
      await assertTaskCheckout(wt, branch, false);
      const head = await git(source, ["rev-parse", "HEAD"]);
      const unchanged = async () => await isClean(source) && await git(source, ["rev-parse", "HEAD"]) === head;
      if (!await unchanged() || (child.completion?.commands.length && head !== child.checks?.revision) || (child.judge && head !== child.judgedRevision))
        throw new Error("The child's worktree changed. Review it and run its checks again.");
      const before = await git(wt, ["rev-parse", "HEAD"]);
      const base = await git(wt, ["merge-base", before, head]);
      let after = before;
      if (!await isAncestor(wt, head, before)) {
        if (req.op === "done") throw new Error(`The child's revision has not landed on ${branch}. Run board.js integrate ${child.id} to merge it and mark it Done.`);
        requireCurrent();
        const merged = await this.integrationMerge(wt, head, `Integrate ${child.id}: ${child.title}`, { branch, head: before }, this.repo, async () => {
          await assertTaskCheckout(source, child.branch!, false);
          if (!await unchanged()) throw new Error("The child's work changed before integration. Review its current revision.");
          requireCurrent();
        });
        if ("conflict" in merged) throw new Error(`Integration conflicts in ${merged.conflict.join(", ")}. The child remains in Review.`);
        after = merged.after;
      }
      await assertTaskCheckout(wt, branch, false);
      if (!await unchanged() || !await isAncestor(wt, after, "HEAD"))
        throw new Error("The checkout changed during integration. Review the current revisions and retry.");
      requireCurrent();
      return { head, before, base, after, into: dest.id, branch, by: req.by, op: req.nonce, at: new Date().toISOString() };
    });
  }
  /**
   * Gates every plan merge (mergePlanBranch, mergeStep, finishStandingRoles, planDelivered). Phase 4: a plan inside a governed run never
   * merges by itself, a route that is not an authorization (govern refuses plan-file runs; this holds if one ever got there by another route).
   */
  private planCanProceed(plan: Task): boolean {
    return this.owned && this.get(plan.id) === plan && !!plan.approved && !plan.paused && !plan.cancelled && !plan.takenOver && plan.status !== "done" && this.isOwner() && (plan.planRun?.approval ? !this.planLaunchProblem(plan) : !targetEffectRefusal(plan, this.tasks, "A plan merge"));
  }
  private async mergePlanBranch(plan: Task, branch: string, authorized: () => boolean = () => true): Promise<boolean> {
    if (plan.governed) throw new Error("Governed plans integrate exact submissions through the governed operation journal.");
    return this.serializeRunMerge(plan, async () => {
      // A queued merge must not use the shared worktree after Pause or ownership changes.
      if (!this.planCanProceed(plan) || !authorized()) return false;
      if (!plan.worktree) await this.ensureWorktree(plan);
      if (!this.planCanProceed(plan) || !authorized()) return false;
      const wt = plan.worktree!, destination = plan.branch;
      if (destination !== `task/${plan.id}`) throw new Error("The run has no assigned integration branch.");
      await assertTaskCheckout(wt, destination, false);
      const revision = await git(wt, ["rev-parse", "--verify", `${branch}^{commit}`]);
      const allowed = () => this.planCanProceed(plan) && authorized() && plan.branch === destination && plan.worktree === wt;
      if (!await isAncestor(wt, revision, "HEAD")) {
        if (!allowed()) return false;
        await mergeTask(wt, revision, () => { if (!allowed()) throw new Error("The run changed before integration."); });
      }
      await assertTaskCheckout(wt, destination, false);
      if (!await isAncestor(wt, revision, "HEAD")) throw new Error("The run branch changed after integration. Review its current revision and retry.");
      return allowed();
    });
  }

  /**
   * A plan file against this board: its check catalogue, the form's choices, the signed-in Claude, Codex, Grok and Antigravity accounts,
   * the card cap, its cards. A Grok or Antigravity account offers what it last advertised (acpCatalog); before that, a model or effort
   * is queued and checked at session open, as add does.
   */
  checkPlan(raw: unknown, vars?: InputValues) {
    const accounts = this.accountList();
    const profiles: PlanProfile[] = accounts.map((a) => {
      if (a.provider === "codex") return { name: a.name, provider: "codex", models: codexModels().map((m) => ({ id: m.model, efforts: m.efforts })), permissions: Object.keys(CODEX_PERMISSIONS) };
      if (a.provider === "grok" || a.provider === "antigravity") {
        const seen = this.acpCatalog(a)?.options, efforts = seen?.find((o) => o.category === "thought_level")?.values.map((v) => v.value) ?? [];
        return { name: a.name, provider: a.provider, models: (seen?.find((o) => o.category === "model")?.values ?? []).map((v) => ({ id: v.value, efforts })),
          efforts, permissions: Object.keys(ACP_PERMISSIONS), ...(seen ? {} : { pending: true }) };
      }
      return { name: a.name, provider: "claude", models: MODELS.map((id) => ({ id, efforts: EFFORTS })), permissions: Object.keys(PERMISSIONS) };
    });
    const checked = validatePlanFile(raw, { catalogue: readCatalogue(this.repo), models: MODELS, efforts: EFFORTS, permissions: Object.keys(PERMISSIONS), profiles,
      defaultAccount: accounts.find((a) => !a.provider)?.name ?? accounts[0]?.name, maxSteps: this.capsOf().total, cards: this.tasks.map((t) => t.id) }, vars);
    if ("errors" in checked) return checked;
    const errors: string[] = [], fallback = checked.plan.account ?? accounts.find((a) => !a.provider)?.name ?? accounts[0]?.name;
    const checkAsk = (name: string | undefined, model: string | undefined, permission: string | undefined, label: string) => {
      if (permission !== "ask") return;
      const account = this.resolveAccount(name, model);
      if (account && (account.provider === "grok" || account.provider === "antigravity")) {
        const why = this.acpAskRefusal(account); if (why) errors.push(`${label}: ${why}`);
      }
    };
    for (const { step } of checked.cards) checkAsk(step.account ?? fallback, step.model ?? checked.plan.model, step.permission ?? checked.plan.permission, `Step "${step.id}"`);
    if (checked.plan.judge) checkAsk(fallback, checked.plan.judge, checked.plan.permission, "Judge");
    if (checked.plan.scribe) checkAsk(fallback, checked.plan.scribe.model, checked.plan.permission, "Scribe");
    return errors.length ? { errors } : checked;
  }
  /** The approval preview is the effective cards, input bytes, checks and pinned governance, not just the source JSON. */
  previewPlan(raw: unknown, file: string, vars: InputValues = {}, pin: (id: string) => ProfileSelection = () => { throw new Error("Choose an available profile"); }): PlanApproval {
    const v = this.checkPlan(raw, vars);
    if ("errors" in v) throw new Error(v.errors.join(" "));
    const g = validateGovernance(v.plan.execution, pin);
    if ("error" in g) throw new Error(g.error);
    if (!g.governance.delegation.defaultChild) throw new Error("A v2 plan must explicitly choose execution.defaultChild.");
    const ref = execFileSync("git", ["branch", "--show-current"], { cwd: this.repo, encoding: "utf8", windowsHide: true }).trim();
    if (!ref) throw new Error("A governed plan needs a named target branch.");
    g.governance.target = { ref, sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: this.repo, encoding: "utf8", windowsHide: true }).trim() };
    const m = effectiveManifest(this.repo, file, v.plan, v.cards, readCatalogue(this.repo), g.governance);
    return { id: crypto.randomUUID(), hash: planDigest(m), manifest: m };
  }
  private planLaunchProblem(task: Task): string | undefined {
    const root = governedRootOf(task, this.tasks)?.root ?? task, a = root.planRun?.approval;
    if (!a) return undefined;
    if (a.hash !== planDigest(a.manifest)) return "The approved effective manifest was altered; this run cannot launch.";
    if (task.id === root.id && a.manifest.plan.review === "model" && task.permission !== a.manifest.plan.reviewer?.permission) return "The approved reviewer permission changed; preview and approve a new run.";
    if (task.planStep) {
      const card = a.manifest.cards.find((c) => c.key === task.planStep!.key), step = card?.step;
      if (!step || planDigest(step.contract) !== planDigest(task.planStep.contract)) return "The step contract changed after approval; this run cannot launch.";
      const after = card!.after.map((k) => root.governed?.keys?.[`${root.id}:${k}`]?.card ?? k);
      if (planDigest(task.dependsOn ?? []) !== planDigest(after) || planDigest(task.workflow?.resources) !== planDigest(step.contract!.resources) ||
        task.workflow?.evidenceRequired !== true || task.workflow.closure || task.permission !== (step.permission ?? a.manifest.plan.permission)) return "The approved dependencies, resources, evidence requirement or permissions changed; this run cannot launch.";
      const gate = step.contract?.gate, scope = task.workflow?.scope;
      if (!!gate !== !!scope) return "The operator gate changed after approval.";
      if (gate && (!scope || scope.binding?.manifest !== a.hash || scope.binding.step !== task.id || scope.binding.candidate !== gate.candidate ||
        scope.toolVersion !== gate.candidate || planDigest(scope.sources) !== planDigest(step.contract!.reads) ||
        JSON.stringify(scope.operations) !== JSON.stringify([gate.action]) || JSON.stringify(scope.destinations) !== JSON.stringify([gate.target]) ||
        planDigest(scope.binding.evidence) !== planDigest(Object.fromEntries(gate.evidence.map((f) => [f, a.manifest.sources[f]]))))) return "The operator action or evidence changed after approval.";
    }
    return manifestProblem(this.repo, a.manifest, readCatalogue(this.repo));
  }
  private planEvidenceProblem(task: Task, receipt: RunReceipt): string | undefined {
    if (!task.planStep || !receipt.revision || receipt.revision !== task.submission?.head || !receipt.evidence) return "Missing or stale submitted revision in the result receipt";
    try {
      for (const f of task.planStep.contract.artifacts) {
        const bytes = execFileSync("git", ["show", `${receipt.revision}:${f}`], { cwd: this.repo, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        if (crypto.createHash("sha256").update(bytes).digest("hex") !== receipt.evidence[f]) return `Missing or stale artifact evidence: ${f}`;
      }
    } catch { return "Accepted artifact evidence is no longer readable at its recorded commit"; }
    return undefined;
  }
  /**
   * The permission a plan card gets when the plan names none. A headless Claude or Codex card already defaults to bypass; a Grok or
   * Antigravity card would otherwise refuse every tool (runHeadlessAcp), so it gets bypass too, as the preview says (planPreview).
   */
  private planPermission(account: string, permission?: string) {
    if (permission) return permission;
    const p = this.resolveAccount(account)?.provider;
    return p === "grok" || p === "antigravity" ? "bypass" : undefined;
  }

  /**
   * Run a plan (F72): the plan card, and one card per step under it with the prompt from the fixed template and the checks from the
   * catalogue. Steps that wait for nothing start at once, hidden, within the running limit; the others wait in Queued and the board
   * starts them when what they wait for is Done (startHeld). Pressing Run after the preview is the approval. A "model" plan's card
   * is its reviewer session and starts first; a "checks" plan's card runs no session and only holds the branch steps merge into.
   */
  async runPlan(raw: unknown, file: string, vars?: InputValues, approval?: PlanApproval, receipt?: { sourceHash: string; configHash: string }): Promise<{ card: Task; steps: Task[]; reused?: boolean }> {
    this.mustOwn();
    if (!this.orchestratorEnabled()) throw new Error("A plan runs as an orchestrator run, and entomatical.orchestrator.enabled is off.");
    const v = this.checkPlan(raw, vars);
    if ("errors" in v) throw new Error(v.errors.join(" "));
    const plan: PlanFile = v.plan, planCards = v.cards, catalogue = readCatalogue(this.repo), model = plan.review === "model";
    const rel = path.relative(this.repo, file).split(path.sep).join("/");
    let previous: Task | undefined;
    if (plan.v === 2) {
      if (!approval || approval.hash !== planDigest(approval.manifest) || planDigest(approval.manifest.plan) !== planDigest(plan) || planDigest(approval.manifest.cards) !== planDigest(planCards) || path.resolve(approval.manifest.file) !== path.resolve(file)) throw new Error("A v2 run needs approval of this exact effective preview.");
      const drift = manifestProblem(this.repo, approval.manifest, catalogue);
      if (drift) throw new Error(drift);
      previous = this.tasks.find((t) => t.planRun?.approval?.id === approval.id || (t.planRun?.setupState === "prepared" && t.planRun.approval?.hash === approval.hash && !t.cancelled && t.status !== "done"));
      if (previous && previous.planRun?.setupState !== "prepared") {
        const existing = previous;
        const steps = this.tasks.filter((t) => t.openedBy === existing.id && !!t.planStep);
        if (existing.planRun?.setupState === "creating" || steps.length !== planCards.length) throw new Error("This approval has an incomplete recorded run. Reconcile its cards before creating another run; nothing was replayed.");
        return { card: existing, steps, reused: true };
      }
      const archived = this.archivedRuns().flatMap((r) => this.archivedRun(r.key).tasks.filter((t) => t.planRun?.approval));
      if (archived.some((t) => t.planRun?.approval?.id === approval.id)) throw new Error("This approval already has an archived run; it cannot be replayed.");
      if (!previous && !plan.reusable && [...this.tasks, ...archived].some((t) => t.planRun?.approval && t.planRun.file === path.relative(this.repo, file).split(path.sep).join("/"))) throw new Error("This plan is not reusable and already has a recorded run.");
      const target = approval.manifest.governance.target;
      if (!target || execFileSync("git", ["rev-parse", "HEAD"], { cwd: this.repo, encoding: "utf8", windowsHide: true }).trim() !== target.sha ||
        execFileSync("git", ["branch", "--show-current"], { cwd: this.repo, encoding: "utf8", windowsHide: true }).trim() !== target.ref) throw new Error("The target changed since preview; preview and approve again.");
    }
    const minimumOpen = Number(!!plan.judge) + Number(!!plan.scribe) + 1;
    if (this.capsOf().open < minimumOpen) throw new Error(`This plan needs at least ${minimumOpen} open slots for its standing roles and a worker; raise the run open cap before starting.`);
    const account = plan.account ?? this.accountList().find((a) => !a.provider)?.name ?? this.accountList()[0]?.name;
    if (!account) throw new Error("A plan requires a signed-in Claude, Codex, Grok or Antigravity account.");
    let sourceHash = "";
    try { sourceHash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { /* moved meanwhile */ }
    const hash = sourceHash.slice(0, 12);
    if (receipt && sourceHash !== receipt.sourceHash) throw new Error("The plan file changed or disappeared. Choose it again before running.");
    if (plan.v === 1 && sourceHash) {
      receipt ??= { sourceHash, configHash: crypto.createHash("sha256").update(JSON.stringify({ raw, vars: vars ?? {} })).digest("hex") };
      const active = this.tasks.filter((t) => t.planRun?.file === rel && !t.planRun.approval && t.status !== "done" && !t.cancelled && !t.discarded &&
        (t.planRun.sourceHash ? t.planRun.sourceHash === sourceHash : t.approved?.hash === hash));
      const incomplete = active.find((t) => t.planRun?.setupState === "creating");
      if (incomplete) throw new Error(`An earlier start left plan card ${incomplete.id} incomplete. Inspect it before starting this plan again.`);
      const reusable = !!Object.keys(plan.vars ?? {}).length, config = receipt.configHash;
      if (!reusable && active.length > 1) throw new Error(`This one-shot plan already has multiple active runs: ${active.map((t) => t.id).join(", ")}. Inspect those cards before choosing which run to continue.`);
      previous = active.find((t) => t.planRun?.configHash === config && (t.planRun.setupState === "prepared" || !reusable));
      if (!previous && active.length && !reusable) throw new Error(`This one-shot plan already has an active run on card ${active[0].id}. Its saved settings differ or predate setup receipts.`);
    }
    if (previous) {
      const card = previous, steps = this.tasks.filter((t) => this.isPlanStep(t, card) && !t.role);
      if (card.planRun!.setupState === "prepared") {
        if (steps.length !== planCards.length) throw new Error(`Plan ${card.id} no longer owns all its original steps. Inspect the run before retrying setup.`);
        await this.startPlanCards(card, steps);
      } else await this.planStarts.get(card.id);
      return { card, steps, reused: true };
    }
    // approved: Run after the preview is the user's approval, so the run's children may start (checkHeadlessRun, startHeld).
    const batch = [...this.tasks];
    const reviewerAccount = model ? plan.reviewer?.account ?? account : account;
    const deliveryCommands = plan.deliveryChecks?.map(name => catalogue![name].run);
    const deliveryRule = deliveryCommands && { commands: [...deliveryCommands], doneWhen: `Delivery checks pass: ${plan.deliveryChecks!.join(", ")}.` };
    const card = this.add(`Plan: ${plan.name}`, "", reviewerAccount, undefined, model ? plan.reviewer?.model : undefined, model ? plan.reviewer?.effort : undefined, deliveryRule, {
      orchestrator: { caps: this.capsOf(), opened: planCards.length + Number(!!plan.judge) + Number(!!plan.scribe) }, planRun: { name: plan.name, file: rel, review: plan.review, ...(deliveryCommands ? { deliveryCommands } : {}), ...(plan.mayOpen ? { mayOpen: true } : {}), ...(plan.v === 2 ? { approval, reusable: plan.reusable } : {}), ...(receipt ? { ...receipt, vars: { ...vars } } : {}), setupState: "creating" }, approved: { at: new Date().toISOString(), hash: approval?.hash ?? hash },
      ...(model ? { headless: true, permission: this.planPermission(reviewerAccount, plan.reviewer?.permission) } : {}) }, batch);
    if (plan.v === 2) {
      card.governed = JSON.parse(JSON.stringify(approval!.manifest.governance));
      card.profile = JSON.parse(JSON.stringify(card.governed!.profiles[card.governed!.delegation.defaultChild!]));
    }
    const steps = planCards.map(({ step: s }) => {
      const commands = stepCommands(s, catalogue);
      return this.add(s.title, "", s.account ?? account, card.id, s.model ?? plan.model, s.effort ?? plan.effort,
        commands.length ? { commands, goal: s.goal.trim().slice(0, 1000), doneWhen: `These checks pass: ${s.checks!.join(", ")}.` } : undefined,
        { headless: true, openedBy: card.id, watchedBy: card.id, permission: this.planPermission(s.account ?? account, s.permission ?? plan.permission), ...(s.judge ? { judge: true } : {}),
          // F119: a coordinator under the plan card, as `board.js add --may-open` makes one: the run's caps, and the plan's approval.
          ...(s.mayOpen ? { orchestrator: { caps: card.orchestrator!.caps, opened: 0, root: card.id }, approved: card.approved } : {}) }, batch);
    });
    card.planRun!.stepIds = steps.map((step) => step.id);
    const cards: StepCard[] = planCards.map((c, i) => ({ id: steps[i].id, card: c }));
    planCards.forEach((c, i) => {
      steps[i].prompt = stepPrompt(plan, planCards, i, card.id, catalogue);
      if (c.after.length) steps[i].dependsOn = c.after.map((k) => cards.find((r) => r.card.key === k)?.id ?? k); // a key of this plan, else a board card's id
      if (plan.v === 2) {
        const t = steps[i], contract = c.step.contract!, gate = contract.gate;
        t.planStep = { key: c.key, contract };
        t.assignment = { key: c.key, outcome: c.step.goal, owns: contract.writes, acceptance: contract.acceptance, evidence: contract.artifacts, returns: c.step.reply };
        card.governed!.keys ??= {};
        card.governed!.keys[`${card.id}:${c.key}`] = { card: t.id, hash: planDigest(c) };
        t.workflow = { resources: contract.resources, outcome: "pending", evidenceRequired: true, checks: contract.acceptance,
          refs: { inputs: contract.reads.map((f) => path.join(this.repo, f)), tools: [approval!.hash] },
          ...(gate ? { scope: { operations: [gate.action], sources: contract.reads, destinations: [gate.target], toolVersion: gate.candidate,
            bounds: "One operator-approved dispatch. Hardware authentication remains a separate owner action; this approval is not proof of a touch.",
            binding: { manifest: approval!.hash, step: t.id, candidate: gate.candidate, evidence: Object.fromEntries(gate.evidence.map((f) => [f, approval!.manifest.sources[f]])) } } } : {}) };
        t.prompt += `\n\nGoverned contract: read ${contract.reads.join(", ")}; allowed writes ${contract.writes.join(", ") || "none"}; required artifacts ${contract.artifacts.join(", ")}. Files outside allowed writes block integration, including reverted changes. This is not an OS sandbox. Commit and submit using board.js submit; the user records the result. Blocked, failed, deferred and not-applicable never release dependents.`;
      }
    });
    if (plan.judge) {
      const judge = this.add("Standing judge", "Review only the assigned child and commit. Do not modify files. Return the exact verdict format requested.", account, card.id, plan.judge, undefined, undefined,
        { role: "judge", headless: true, openedBy: card.id, watchedBy: card.id, permission: this.planPermission(account, plan.permission) }, batch);
      Object.assign(judge, { status: "review", runPolicy: card.runPolicy });
    }
    if (plan.scribe) {
      const scribe = this.add("Standing scribe", `Update only these approved documents: ${plan.scribe.documents.join(", ")}. Read the assigned milestone and replies. Commit the document changes on your branch, then report what changed. Do not push or edit other files.`, account, card.id, plan.scribe.model, undefined, undefined,
        { role: "scribe", headless: true, openedBy: card.id, watchedBy: card.id, permission: this.planPermission(account, plan.permission) }, batch);
      scribe.scribe = { documents: plan.scribe.documents, milestones: plan.scribe.after.map((name) => ({ name, cards: planCards.flatMap((c, i) => c.step.id === name ? [steps[i].id] : []) })) };
      Object.assign(scribe, { status: "review", runPolicy: card.runPolicy });
    }
    let brief = "";
    if (model) try { brief = fs.readFileSync(this.reviewerBriefPath, "utf8"); } catch { brief = "# Plan reviewer brief\n\n(docs/orchestrator/REVIEWER.md could not be read.) Merge each step whose checks passed and whose diff matches its goal (board.js integrate <id>); otherwise board.js send <id> with the one thing to fix."; }
    card.prompt = model ? reviewerPrompt(brief, plan, rel, cards, this.repo) : planCardText(plan, rel, cards);
    if (plan.v === 2) card.prompt = `Governed plan "${plan.name}". Approved effective manifest ${approval!.hash}.\n${stepTable(cards)}\nReview submitted changes and evidence. Never use shell git to merge. A step needs the user's accepted result receipt before board.js integrate <id>. Integration checks exact commits, checks, evidence and allowed writes. Report holds without waiving them. Finish of this root belongs to the user. Do not open extra children: the approved plan already defines every assignment. ${model ? 'This first turn: reply "Ready." and end your turn.' : "This card runs no session."}`;
    if (!model) Object.assign(card, { status: "review", statusAt: new Date().toISOString() }); // no session: it waits for Finish
    card.planRun!.setupState = "prepared";
    this.save(batch);
    await this.startPlanCards(card, steps);
    return { card, steps };
  }

  private readonly planStarts = new Map<string, Promise<void>>();
  private startPlanCards(card: Task, steps: Task[]): Promise<void> {
    const pending = this.planStarts.get(card.id);
    if (pending) return pending;
    const start = Promise.resolve().then(() => this.activatePlan(card, steps)).finally(() => this.planStarts.delete(card.id));
    this.planStarts.set(card.id, start);
    return start;
  }

  private async activatePlan(card: Task, steps: Task[]) {
    const validate = () => {
      this.mustOwnActive();
      if (this.get(card.id) !== card || !card.approved || card.paused || card.cancelled || card.takenOver || card.status === "done")
        throw new Error(`Plan ${card.id} is no longer available to start.`);
    };
    validate();
    try {
      if (card.planRun!.review === "model" && !card.sessionId) await this.startHeadless(card);
      else if (card.planRun!.review === "model" && !this.everReady(card) && !this.hasProcess(card)) throw new Error("The reviewer's previous dispatch is unconfirmed. Inspect its session before continuing.");
      else await this.ensureWorktree(card);
      validate();
    } catch (e) {
      if (this.owned && this.isOwner() && this.get(card.id) === card) this.update(card, { launchError: `Plan setup: ${e instanceof Error ? e.message : String(e)}. Run this plan again with the same settings to retry this card.` });
      throw e;
    }
    // Persist the root and its entire queue together. A host that exits here can start any remaining held steps after reloading.
    card.planRun!.setupState = "started";
    card.launchError = undefined;
    for (const t of steps) if (t.openedBy === card.id && t.status === "queued" && !t.sessionId && !t.cancelled && !t.takenOver && !t.stepHold) t.held = true;
    this.save();
    this.runEvents.fire({ kind: "started", master: card });
    for (const t of steps) if (t.openedBy === card.id) await this.dispatchHeld(t);
  }

  /** Commit a workflow step before its checks, so the checked revision is what the reviewer or board can accept. */
  private readonly preparingPlanChecks = new Map<string, Promise<void>>();
  private preparePlanChecks(task: Task, plan: Task) {
    if (this.preparingPlanChecks.has(task.id)) return;
    const prep = (async () => {
      try {
        const ended = await this.ended(task, 0);
        if (!this.owned || this.get(task.id) !== task || !this.isPlanStep(task, plan) || task.status !== "review" || task.interrupted || task.cancelled || task.takenOver) return;
        if (!ended) { this.update(task, { awaitingPlanExit: plan.id }); return; }
        if (!this.planCanProceed(plan)) { if (plan.paused) this.pausedSteps.add(task.id); return; }
        await this.commitLeftovers(task);
        if (!this.owned || this.get(task.id) !== task || !this.isPlanStep(task, plan) || task.status !== "review" || task.interrupted || task.cancelled || task.takenOver) return;
        if (!this.planCanProceed(plan)) { if (plan.paused) this.pausedSteps.add(task.id); return; }
        this.checks.start(task);
      } catch (e) {
        if (this.owned && this.get(task.id) === task) this.holdStep(task, plan, `Could not prepare the workflow revision for checks: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    this.preparingPlanChecks.set(task.id, prep);
    void prep.finally(() => this.preparingPlanChecks.delete(task.id));
  }

  /** Restore a durable assignment without repeating a possibly delivered model turn. */
  private recoverRoleNotices(root: Task) {
    if (!root.approved || root.paused) return;
    for (const role of runCards(root.id, this.tasks)) {
      if (role.cancelled || role.takenOver || role.stepHold || this.starting.has(role.id) || this.delivering.has(role.id)) continue;
      const assignment = role.role === "judge" ? role.judging : role.role === "scribe" ? role.scribe?.active : undefined;
      if (!assignment) continue;
      const ended = this.events(role.id).some((e) => e.t >= assignment.at && ["Stop", "StopFailure", "Interrupt"].includes(e.hook_event_name ?? ""));
      if (ended || this.terminal(role) || this.codexRuns.has(role.id)) continue;
      if (assignment.phase === "dispatching") {
        if (role.sessionId) {
          role.stepHold = ROLE_RECOVERY_HOLD;
          this.queueNotice(root.id, `role-recovery:${role.id}`, role.stepHold);
          this.save();
          continue;
        }
        assignment.phase = "pending"; this.save();
      }
      const key = role.role === "judge" ? `judge:${role.judging!.id}` : `milestone:${role.scribe!.active!.name}`;
      if (!this.pendingNotices.get(role.id)?.has(key)) this.queueNotice(role.id, key, assignment.prompt);
      this.deliverNotices(role.id);
    }
  }

  /** Retry a waiting judgment when a judge becomes idle, including after a window reload. */
  private scheduleJudgments(root: Task) {
    if (!root.approved || root.paused) return;
    const candidate = runCards(root.id, this.tasks).find((t) => t.judge && !t.judged && !t.stepHold && t.status === "review" && !t.interrupted && t.checks?.status === "complete");
    if (candidate) void this.requestJudgment(candidate, root).catch((e) => console.error("Entomatical: judge", e));
  }
  /** One event-driven judge assignment at a time; the verdict is bound to the exact reviewed commit. */
  private readonly judgingStarts = new Set<string>();
  private async requestJudgment(t: Task, root: Task) {
    if (!t.judge || t.judged || t.interrupted || t.status !== "review" || t.checks?.status !== "complete" || (root.planRun && !t.judgeReady) || !root.approved || root.paused) return;
    const judge = runCards(root.id, this.tasks).find((c) => c.role === "judge" && c.status !== "done" && !c.cancelled);
    if (!judge || judge.judging || this.judgingStarts.has(judge.id) || this.terminal(judge) || this.codexRuns.has(judge.id)) return;
    this.judgingStarts.add(judge.id);
    try {
      if (!t.worktree || !t.branch || !root.branch || !await isClean(t.worktree)) throw new Error("The reviewed branch is missing or has uncommitted changes.");
      const revision = await git(t.worktree, ["rev-parse", "HEAD"]);
      if (root.planRun && !t.checks.revision) throw new Error("The checked revision is unavailable; rerun the acceptance checks.");
      if (t.checks.revision && t.checks.revision !== revision) throw new Error("The branch changed after its acceptance checks.");
      if (!this.owned || root.paused || t.status !== "review" || judge.judging) return;
      const checkLog = t.checks.run || "not recorded";
      const prompt = `Review child ${t.id} at commit ${revision}. Read its diff with git diff ${root.branch}...${revision}, its goal and done-when below, and its acceptance-check output at ${checkLog}. Do not modify files. Reply exactly: verdict: pass for child ${t.id} or verdict: fail for child ${t.id}, followed by at most five reasons and three questions.
Goal: ${t.completion?.goal ?? t.title}
Done when: ${t.completion?.doneWhen ?? "the listed acceptance checks pass"}`;
      judge.judging = { id: t.id, revision, at: Math.max(Date.now(), (this.events(judge.id).at(-1)?.t ?? 0) + 1), prompt, phase: "pending" }; this.save();
      this.queueNotice(judge.id, `judge:${t.id}`, prompt);
      this.deliverNotices(judge.id);
    } catch (e) {
      this.queueNotice(root.id, `judge-error:${t.id}`, `Judgment of ${t.id} could not start: ${e instanceof Error ? e.message : String(e)}`);
      this.holdStep(t, root, "Judgment could not start. Review its worktree and checks.");
    } finally { this.judgingStarts.delete(judge.id); }
  }
  private readonly completingJudges = new Set<string>();
  private scheduleJudgeResult(judge: Task) {
    if (this.completingJudges.has(judge.id) || !judge.judging || (!judge.interrupted && !this.events(judge.id).some((e) => e.t >= judge.judging!.at && ["Stop", "StopFailure", "Interrupt"].includes(e.hook_event_name ?? "")))) return;
    this.completingJudges.add(judge.id);
    queueMicrotask(() => void this.completeJudge(judge).catch((e) => console.error("Entomatical: judge result", e)).finally(() => this.completingJudges.delete(judge.id)));
  }
  private async completeJudge(judge: Task) {
    const assignment = judge.judging, root = masterOf(judge, this.tasks);
    if (!assignment || !root) return;
    const t = this.get(assignment.id);
    const ending = this.events(judge.id).findLast((e) => e.t >= assignment.at && ["Stop", "StopFailure", "Interrupt"].includes(e.hook_event_name ?? ""));
    const answer = ending?.hook_event_name === "Stop" ? (typeof ending.last_assistant_message === "string" ? ending.last_assistant_message : this.finalReply(judge) ?? "") : "";
    const match = /^\s*verdict:\s*(pass|fail)\s+for\s+child\s+([0-9a-f]{6})\b/im.exec(answer);
    const current = t?.worktree ? await git(t.worktree, ["rev-parse", "HEAD"]).catch(() => "") : "";
    if (!t || judge.interrupted || current !== assignment.revision || !match || match[2] !== assignment.id) {
      judge.judging = undefined;
      this.queueNotice(root.id, `judge-error:${assignment.id}`, `Judge ${judge.id} did not return a valid verdict for ${assignment.id}; review it before proceeding.`);
      if (t) this.holdStep(t, root, "The judge returned no valid verdict; review the judge card.");
      this.save(); return;
    }
    t.judged = match[1].toLowerCase() as "pass" | "fail"; t.judgedRevision = assignment.revision; judge.judging = undefined;
    this.queueNotice(root.id, `judge-result:${t.id}`, `Judge ${judge.id}: ${t.judged} for child ${t.id} at ${assignment.revision}. ${answer.slice(0, 3000)}`);
    this.save();
    if (root.planRun) await this.stepSettled(t, root);
    for (const next of runCards(root.id, this.tasks)) if (next.judge && !next.judged && next.checks?.status === "complete" && next.status === "review") { await this.requestJudgment(next, root); break; }
  }
  /** Start one approved milestone at a time; completed milestones survive window reloads. */
  private queueScribeMilestone(plan: Task) {
    if (plan.paused || !plan.approved) return;
    const scribe = runCards(plan.id, this.tasks).find((t) => t.role === "scribe" && t.scribe && !t.cancelled && t.status !== "done");
    if (!scribe?.scribe || scribe.scribe.active || scribe.stepHold || scribe.takenOver) return;
    const milestone = scribe.scribe.milestones.find((m) => !m.complete && m.cards.length && m.cards.every((id) => this.get(id)?.status === "done" && !this.get(id)?.cancelled));
    if (!milestone) return;
    const prompt = `Milestone ${milestone.name} is complete (cards ${milestone.cards.join(", ")}). Read their final replies and update only ${scribe.scribe.documents.join(", ")}. Commit the changes and report the commit.`;
    scribe.scribe.active = { name: milestone.name, at: Math.max(Date.now(), (this.events(scribe.id).at(-1)?.t ?? 0) + 1), prompt, phase: "pending" };
    this.save();
    this.queueNotice(scribe.id, `milestone:${milestone.name}`, prompt);
    this.deliverNotices(scribe.id);
  }
  /** Check every commit, including reverted paths and merge parents, before preserving a scribe's history. */
  private async outsideScribeHistory(scribe: Task, plan: Task, revision = scribe.branch): Promise<string[]> {
    if (!scribe.worktree || !revision || !plan.branch || !scribe.scribe) throw new Error("Scribe scope or branch missing");
    const commits = (await git(scribe.worktree, ["rev-list", `${plan.branch}..${revision}`])).split("\n").filter(Boolean);
    const outside = new Set<string>();
    for (const commit of commits) {
      const files = (await git(scribe.worktree, ["diff-tree", "--root", "-m", "--no-commit-id", "--no-renames", "--name-only", "-z", "-r", commit])).split("\0").filter(Boolean);
      for (const file of files) if (!scribe.scribe.documents.includes(file)) outside.add(file);
    }
    return [...outside];
  }
  /** Validate committed scribe changes against the run's document allowlist before any merge. */
  private async scribeSettled(scribe: Task, plan: Task) {
    const active = scribe.scribe?.active;
    if (!active || scribe.status !== "review" || scribe.stepHold) return;
    const ended = this.events(scribe.id).findLast((e) => e.t >= active.at && ["Stop", "StopFailure", "Interrupt"].includes(e.hook_event_name ?? ""));
    if (!ended && !scribe.interrupted) return;
    if (scribe.interrupted || ended?.hook_event_name !== "Stop") return this.holdStep(scribe, plan, "The scribe was interrupted; review its work before continuing.");
    if (!await this.ended(scribe) || !scribe.worktree || !scribe.branch || !plan.branch || !await isClean(scribe.worktree)) return this.holdStep(scribe, plan, "The scribe has uncommitted work or is still running; review its branch.");
    const outside = await this.outsideScribeHistory(scribe, plan);
    if (outside.length) return this.holdStep(scribe, plan, `The scribe changed files outside its approved document list: ${outside.join(", ")}`);
    const milestone = scribe.scribe!.milestones.find((m) => m.name === active.name);
    if (milestone) milestone.complete = true;
    scribe.scribe!.active = undefined;
    this.queueNotice(plan.id, `scribe:${scribe.id}:${active.name}`, `Scribe ${scribe.id} completed ${active.name}: ${this.finalReply(scribe) ?? "No reply recorded."}`);
    this.save(); this.deliverNotices(plan.id);
    this.queueScribeMilestone(plan);
    if (plan.planRun?.review === "checks") void this.planDelivered(plan);
  }

  /** A plan step settled: commit what it left uncommitted, then judge it by its checks (a checks-only plan) or tell the reviewer. */
  private async stepSettled(t: Task, plan: Task) {
    if (t.planStep) {
      this.runEvents.fire({ kind: "needsYou", master: plan, task: t });
      return; // v2 uses recorded results and governed integration, never the legacy automatic merge.
    }
    await new Promise((r) => setImmediate(r)); // the status change's own listeners first: a Review starts the step's checks
    const step = this.get(t.id);
    if (!step || !this.owned) return;
    if (this.preparingPlanChecks.has(step.id)) await this.preparingPlanChecks.get(step.id);
    if (!this.owned || this.get(step.id) !== step || step.stepHold || step.cancelled || step.takenOver || step.openedBy !== plan.id) return;
    if (!step.role && step.status === "review" && !step.interrupted && this.hasProcess(step)) {
      if (step.awaitingPlanExit !== plan.id) this.update(step, { awaitingPlanExit: plan.id });
      return;
    }
    if (plan.paused) { this.pausedSteps.add(step.id); return; }
    // F119: a step that opened cards is not finished while one of them is open. Its turn ended to wait for them; their notices wake it,
    // and the turn that accepts the last one settles the step again.
    if (step.orchestrator && runCards(step.id, this.tasks).some((c) => c.status !== "done" && !c.cancelled)) return;
    if (step.role === "scribe") return await this.scribeSettled(step, plan);
    // A successful Stop and Review may have been persisted by a host that exited before starting the checks.
    if (step.status === "review" && !step.interrupted && !step.checks && step.completion?.commands.length && this.isPlanStep(step, plan)) {
      this.preparePlanChecks(step, plan);
      return;
    }
    if (step.status === "review" && !step.interrupted && (!step.completion?.commands.length || step.checks?.status === "complete")) {
      if (!step.completion?.commands.length && plan.planRun?.review === "model") {
        try { await this.commitLeftovers(step); } catch (e) { return this.holdStep(step, plan, `Could not commit step changes: ${e instanceof Error ? e.message : String(e)}`); }
      }
      if (step.completion?.commands.length && !await this.matchesCheckedRevision(step)) return this.holdStep(step, plan, "The step changed during or after its checks, or the checked revision is unavailable. Review its changes and resume the step to run checks again.");
      if (!this.owned || !this.isOwner() || this.get(plan.id) !== plan || this.get(step.id) !== step) return;
      if (plan.paused) { this.pausedSteps.add(step.id); return; }
      if (step.judge) step.judgeReady = true;
    }
    try {
      if (step.judge && !step.judged && step.status === "review" && !step.interrupted && step.checks?.status === "complete") { await this.requestJudgment(step, plan); return; }
      if (step.judge && step.judged === "fail") return this.holdStep(step, plan, "The standing judge failed this step. Review its reasons before considering a merge.");
      if (plan.planRun!.review === "checks") return await this.checkStep(step, plan);
      const r = this.statusOf(step);
      if (!isSettled(r)) return; // its checks started meanwhile: their result settles it again
      this.queueNotice(plan.id, step.id, r.status === "needs-input" ? `Child needs input: ${r.line}` : r.line);
      if (r.status === "needs-input" || r.chips.includes("interrupted")) this.runEvents.fire({ kind: "needsYou", master: plan, task: step });
      this.deliverNotices(plan.id);
    } catch (e) { console.error("Entomatical: plan step", e); }
  }

  /** A passed check applies only to the same clean commit it actually ran against. */
  private async matchesCheckedRevision(task: Task): Promise<boolean> {
    return !!task.checks?.revision && !!task.worktree && await isClean(task.worktree).catch(() => false) &&
      await git(task.worktree, ["rev-parse", "HEAD"]).catch(() => "") === task.checks.revision;
  }

  /** The board as a checks-only plan's reviewer: merge a step whose checks passed, give a failed or interrupted one one more turn, or leave it to the user. */
  private async checkStep(t: Task, plan: Task) {
    if (t.status === "done") return this.planDelivered(plan);
    if (t.status === "needs-input") return void this.runEvents.fire({ kind: "needsYou", master: plan, task: t });
    if (t.status !== "review" || t.stepHold) return;
    if (plan.paused) return void this.pausedSteps.add(t.id);
    const more = (t.followUps ?? 0) < AUTO_FOLLOW_UPS;
    if (t.interrupted) return more ? this.autoFollowUp(t, plan, INTERRUPTED_NUDGE) : this.holdStep(t, plan, "It was interrupted again after the board resumed it. Resume it, or Stop run.");
    const checks = t.checks?.status;
    if (t.completion?.commands.length && (!checks || checks === "running")) return; // not run yet: their result settles it again
    if (!t.completion?.commands.length || checks === "complete") {
      if (t.completion?.commands.length && !await this.matchesCheckedRevision(t))
        return this.holdStep(t, plan, "The step changed during or after its checks, or the checked revision is unavailable. Review its changes and resume the step to run checks again.");
      if (t.judge && !t.judged) return void await this.requestJudgment(t, plan);
      if (t.judge && t.judged !== "pass") return this.holdStep(t, plan, "The standing judge did not pass this step. Review its reasons before continuing.");
      if (t.judge && t.worktree && (!await isClean(t.worktree) || await git(t.worktree, ["rev-parse", "HEAD"]) !== t.judgedRevision)) return this.holdStep(t, plan, "The step changed after judgment; review it again before merging.");
      return this.mergeStep(t, plan);
    }
    if (t.checks?.failure && more) return this.autoFollowUp(t, plan, this.fixPrompt(t));
    this.holdStep(t, plan, `Its checks failed${t.followUps ? " again after the board sent it the failure" : ""}: ${t.checks?.error ?? "no reason given"}. See What failed, then Fix it or Resume.`);
  }

  /** One automatic follow-up to a plan step, counted against AUTO_FOLLOW_UPS, once its last hidden run has ended. */
  private async autoFollowUp(t: Task, plan: Task, text: string) {
    this.update(t, { followUps: (t.followUps ?? 0) + 1 });
    try {
      if (!await this.ended(t)) throw new Error("its last run is still ending");
      await this.followUpHeadless(t, text);
    } catch (e) { this.holdStep(t, plan, `The board could not send it a follow-up: ${e instanceof Error ? e.message : String(e)}`); }
  }

  /** Merges a finished step into the plan card's branch and marks it Done, which starts the steps waiting for it. A conflict merges nothing. */
  private async mergeStep(t: Task, plan: Task) {
    if (!t.branch) return this.holdStep(t, plan, "It has no branch to merge.");
    if (!plan.worktree) await this.ensureWorktree(plan);
    const revision = t.judge ? t.judgedRevision! : t.checks?.revision ?? t.branch;
    const checks = t.checks, branch = t.branch, session = t.sessionId;
    const authorized = () => this.get(t.id) === t && this.isPlanStep(t, plan) && t.status === "review" && !t.cancelled && !t.interrupted && !t.stepHold && !t.takenOver
      && t.checks === checks && t.branch === branch && t.sessionId === session && (!t.judge || t.judged === "pass" && t.judgedRevision === revision);
    try { if (!await this.mergePlanBranch(plan, revision, authorized)) { if (plan.paused) this.pausedSteps.add(t.id); return; } } catch (e) {
      if (!this.planCanProceed(plan) || !authorized()) { if (plan.paused) this.pausedSteps.add(t.id); return; }
      const said = e instanceof Error ? e.message : String(e), conflicts = said.match(/CONFLICT[^\n]*/g);
      return this.holdStep(t, plan, `It could not be merged into the plan's branch, so nothing was merged: ${conflicts ? conflicts.join("; ") : said.split("\n")[0]}`);
    }
    if (!this.planCanProceed(plan)) { if (plan.paused) this.pausedSteps.add(t.id); return; }
    if (t.completion?.commands.length && (!t.worktree || !await isClean(t.worktree).catch(() => false) || await git(t.worktree, ["rev-parse", "HEAD"]).catch(() => "") !== revision)) return this.holdStep(t, plan, "The step changed during merge; review it before marking it Done.");
    if (!this.planCanProceed(plan) || !authorized()) { if (plan.paused) this.pausedSteps.add(t.id); return; }
    this.update(t, { status: "done" });
    this.queueScribeMilestone(plan);
    void this.planDelivered(plan);
    void this.closeAccepted(t, plan);
  }

  /**
   * 25 November 2026: an accepted card of a run is finished, not only Done. Once its work is in its parent's branch, its
   * worktree and branch go (the same gated removal Finish uses), and the parent is told, so it can prompt a card that waits on it.
   * A judged card keeps its branch (finishStandingRoles reads it), and a governed one has its own cleanup. Nothing is merged here.
   */
  private async closeAccepted(child: Task, parent: Task) {
    if (!this.owned || child.status !== "done" || !child.worktree || !child.branch || !parent.branch || child.judge || child.planStep || child.governedBy) return;
    if (runCards(child.id, this.tasks).some((c) => c.status !== "done" && !c.cancelled)) return;
    const into = parent.branch;
    let text: string;
    try {
      if (!await isAncestor(this.repo, child.branch, into)) return; // not in the parent's branch: nothing to finish
      await this.removeWorktree(child, { landed: (rev) => isAncestor(this.repo, rev, into) });
      this.update(child, { transcript: this.transcriptOf(child), ...ranIn(child), worktree: undefined, branch: undefined, cleanupPending: undefined, cleanup: undefined });
      text = `Finished ${child.id} "${child.title}": its work is in ${into}, and its worktree and branch were removed. Prompt or start any card that waits on it.`;
    } catch (e) {
      text = `Done ${child.id} "${child.title}", but its worktree was kept: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (parent.planRun?.review === "checks") return; // no session to tell: the board itself starts the steps that wait on it
    this.queueNotice(parent.id, `finished:${child.id}`, text);
    this.deliverNotices(parent.id);
  }

  /** Finish standing roles only when they are idle and their approved work is accounted for. */
  private readonly finalizingPlans = new Set<string>();
  private async finishStandingRoles(plan: Task, authorized: () => boolean = () => true): Promise<string | undefined> {
    const allowed = () => this.planCanProceed(plan) && authorized();
    if (!allowed()) return "The run is paused or its board owner changed.";
    if (this.finalizingPlans.has(plan.id)) return "Standing roles are still being finalized.";
    const cards = runCards(plan.id, this.tasks);
    if (plan.planRun?.approval) for (const child of cards.filter((t) => t.planStep)) {
      const receipt = child.workflow?.receipt && this.workflow.receipt(child.workflow.receipt);
      if (!child.integrated || child.workflow?.outcome !== "accepted" || !receipt || this.planEvidenceProblem(child, receipt)) return `${child.id} lacks accepted, integrated evidence; this plan is not ready.`;
    }
    for (const child of cards.filter((t) => t.judge && t.judged !== "pass" && t.branch && plan.branch)) {
      if (await git(this.repo, ["merge-base", "--is-ancestor", child.branch!, plan.branch!]).then(() => true, () => false)) return `Judged card ${child.id} has no passing verdict but its branch is already in the plan. Review the merge before declaring ready.`;
    }
    for (const child of cards.filter((t) => t.judge && t.judged === "pass" && !t.cancelled)) {
      if (!child.branch || !child.judgedRevision || !plan.branch ||
          await git(this.repo, ["rev-parse", child.branch]).catch(() => "") !== child.judgedRevision ||
          !await git(this.repo, ["merge-base", "--is-ancestor", child.judgedRevision, plan.branch]).then(() => true, () => false))
        return `Judged card ${child.id} no longer matches the reviewed revision included in the plan. Review it before declaring ready.`;
    }
    if (!allowed()) return "The run is paused or its board owner changed.";
    this.queueScribeMilestone(plan);
    const scribe = cards.find((c) => c.role === "scribe" && !c.cancelled && c.status !== "done");
    if (scribe?.scribe && (scribe.scribe.active || scribe.scribe.milestones.some((m) => !m.complete) || scribe.stepHold || scribe.takenOver)) return "The standing scribe has an unfinished milestone or needs review.";
    const judge = cards.find((c) => c.role === "judge" && !c.cancelled && c.status !== "done");
    if (judge?.judging || judge?.stepHold || judge?.takenOver) return "The standing judge has an unfinished assignment or needs review.";
    this.finalizingPlans.add(plan.id);
    try {
      for (const role of [scribe, judge].filter((t): t is Task => !!t)) {
        if (!await this.ended(role) || role.interrupted) return "A standing role is still running or was interrupted.";
        if (!allowed()) return "The run is paused or its board owner changed.";
        if (!role.sessionId) { this.update(role, { cancelled: true, status: "review" }, undefined, true); continue; }
        if (!role.worktree || !role.branch || !plan.branch || !await isClean(role.worktree)) return "A standing role has uncommitted work; review its branch.";
        const revision = await git(role.worktree, ["rev-parse", "HEAD"]);
        if (await git(role.worktree, ["rev-parse", role.branch]) !== revision) return "A standing role branch moved while being reviewed.";
        const commits = (await git(role.worktree, ["rev-list", `${plan.branch}..${revision}`])).trim();
        if (role.role === "judge" && commits) return "The judge made commits; review its branch before closing it.";
        if (role.role === "scribe" && (await this.outsideScribeHistory(role, plan, revision)).length) return "The scribe changed files outside its approved document list.";
        if (role.role === "scribe" && commits) {
          if (!plan.worktree) await this.ensureWorktree(plan);
          try { if (!await this.mergePlanBranch(plan, revision, authorized)) return "The run is paused or its board owner changed."; } catch (e) { return `Scribe changes could not be merged: ${e instanceof Error ? e.message : String(e)}`; }
          if (!await isClean(role.worktree) || await git(role.worktree, ["rev-parse", role.branch]) !== revision) return "The scribe branch changed during merge; review it before closing the role.";
        }
        if (!allowed()) return "The run is paused or its board owner changed.";
        this.update(role, { status: "done" });
      }
      return undefined;
    } finally { this.finalizingPlans.delete(plan.id); }
  }
  /** A checks-only plan declares delivery after its steps and standing roles finish. */
  private async planDelivered(plan: Task) {
    if (plan.planRun?.review !== "checks") return;
    if (plan.pressureWatchersBlocked?.length && !await this.resolvePressureWatchers(plan)) return;
    const cards = runCards(plan.id, this.tasks);
    if (cards.some((c) => c.role !== "judge" && c.role !== "scribe" && c.status !== "done" && !c.cancelled)) return;
    if (await this.finishStandingRoles(plan) || !this.planCanProceed(plan)) return;
    if (!plan.deliveryReady) this.update(plan, { deliveryReady: true });
    this.maybeFinished(plan);
  }

  /** The board stops acting on a plan step: the card says why, and the user gets one "needs you" notification. */
  private holdStep(t: Task, plan: Task, why: string) {
    this.update(t, { stepHold: why });
    this.runEvents.fire({ kind: "needsYou", master: plan, task: t });
  }

  /** Commits what a finished step left uncommitted in its worktree, so its merge carries the work its checks passed on. */
  private async commitLeftovers(t: Task) {
    if (!t.worktree || !fs.existsSync(t.worktree) || await isClean(t.worktree)) return;
    await git(t.worktree, ["add", "-A"]);
    await git(t.worktree, ["commit", "-m", `${t.title}\n\nCommitted by Entomatical: the plan step left this work uncommitted.`]);
  }

  /** A headless child hit a usage limit (13.1 item 3): move it to the account with the most headroom and resume it once, quietly; or park it until the reset. */
  private async limitFallback(task: Task, failure: HookEvent) {
    const seen = `${task.id}:${failure.t}`;
    if (this.fableSeen.has(seen)) return; // this limit is being handled already
    // Audit, 10 November 2026: an exit that neither moves nor parks the card ends the silence and holds it, so it is never left mute.
    const hold = (why: string) => { this.muted.delete(task.id); const root = masterOf(task, this.tasks); if (root) this.holdStep(task, root, why); };
    if (Date.now() - failure.t > 120_000) return hold("It hit a usage limit more than 2 minutes ago, so the board did not move it to another account. Resume it when ready.");
    this.fableSeen.add(seen);
    const accounts = this.accountList().filter((a) => !a.provider).map(a => ({ name: a.name, ...readUsage(a.configDir ?? "") }));
    const best = bestAccount(accounts, task.account);
    if (!best) {
      let u: ReturnType<typeof readUsage>;
      try { u = readUsage(this.configDirOf(task)); } catch { u = undefined; }
      const at = ((u?.fiveHourResets ?? u?.weekResets ?? Date.now() / 1000 + 3600) * 1000);
      this.update(task, { waitsForReset: { account: task.account ?? "", at } });
      return;
    }
    if (!await this.ended(task)) return hold("It hit a usage limit, but its session did not end, so the board did not move it to another account. Stop it, then resume it.");
    try {
      this.switchAccount(task, best);
      this.update(task, { switchedTo: best });
      await this.followUpHeadless(task, "Continue.");
    } catch (e) { console.error("Entomatical: limit fallback", e); hold(`It hit a usage limit, and moving it to ${best} failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
  /** Cards parked on a usage limit start again once the reset has passed (13.1 item 3). */
  private checkResets() {
    for (const t of this.tasks) {
      if (!t.waitsForReset) continue;
      // CORE-GOV-03: the card is checked when the reset comes, not trusted from when it was parked (a wait saved before the fix, a restored card).
      if (t.status === "done" || t.cancelled) { this.update(t, { waitsForReset: undefined }); continue; }
      if (Date.now() < t.waitsForReset.at || !t.headless || this.terminal(t)) continue;
      const root = masterOf(t, this.tasks);
      if (root?.paused || (t.openedBy && !root?.approved)) continue;
      this.update(t, { waitsForReset: undefined });
      void this.followUpHeadless(t, "Continue.").catch((e) => console.error("Entomatical: reset resume", e));
    }
  }

  /** Points of the account's weekly window the card's runs moved (for the run row and report). */
  pointsOf(task: Task): number | null {
    if (!task.usageRuns?.some(r => r.endedAt)) return 0;
    const w = taskCost(task.usageRuns)?.windows.find((x) => x.name === "weekly");
    return typeof w?.points === "number" && !w.reset && !w.incomplete ? Math.round(w.points * 10) / 10 : null;
  }
  /** The run row and report of a master card (4.7, 13.2 item 8). */
  runSummaryOf(master: Task): RunSummary | undefined {
    if (!master.orchestrator || master.orchestrator.root) return undefined;
    const budget = runBudget(master, this.tasks, (t) => this.fiveHourOf(t));
    return { ...runSummary(master, this.tasks, (t) => this.pointsOf(t)), ...(budget ? { budget } : {}) };
  }

  dispose() {
    if (this.disposed) return;
    this.owned = false;
    for (const retire of this.pendingExits) this.guard(retire);
    for (const close of this.catalogProbes) this.guard(() => close(true));
    for (const run of this.codexRuns.values()) this.guard(run.dispose);
    this.disposed = true;
    this.cardTerminals.dispose();
    clearInterval(this.poll);
    clearTimeout(this.redrawTimer);
    for (const timer of this.nudges) clearTimeout(timer);
    for (const timer of this.heldRetries) clearTimeout(timer);
    this.watcher?.close();
    this.inboxWatcher?.close();
    this.closeSub.dispose();
    this.changed.dispose();
    this.status.dispose();
    this.runEvents.dispose();
  }
}

/** A card's terminal tab: "En <id>" (Entomatical) since 17 November 2026; "AB <id>" before the rename. */
export const terminalName = (task: Pick<Task, "id">) => `En ${task.id}`;
/** True for the card's terminal by its current name or the name it had before the rename, so a card still running is found. */
export const isCardTerminal = (name: string, task: Pick<Task, "id">) => name === terminalName(task) || name === `AB ${task.id}`;

/** A found session's first prompt: from Claude's transcript, or a Codex rollout's first user message. */
/** The main repository of a worktree (its common git dir's parent), else the folder itself. */
function commonRoot(repo: string): string {
  try { return path.resolve(repo, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim(), ".."); } catch { return repo; }
}
const firstPrompt = (provider: Task["provider"], transcript: string) => (provider ? readRollout(transcript)?.exchanges : transcriptExchanges(transcript))?.[0]?.text;
