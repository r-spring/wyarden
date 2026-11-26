// An orchestrator finishes by itself (F97 section 9). the user, 7 November 2026: "If an orchestrator thinks that it's ready to finish,
// then it should just finish. I don't want to have to review a merge plan." After `board.js finish self` and its checks (board.ts
// finishAtStop), the board reviews the whole run. On Done it closes the run's sessions, merges the Done children, commits, and runs
// Finish without its dialog: the checks run again once the remote's latest is merged, and it pushes only if they pass. Then it cleans
// up and writes a report. Not done goes back to the orchestrator (at most AUTO_ROUNDS times); Unsure, no progress or any failure waits
// in Needs input with everything still on disk, and no modal dialog. the user's own Finish button keeps its dialog.
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { leftoverFiles, type Board, type Task } from "./board";
import { AUTO_ROUNDS, FINISH_REVIEW_STEPS, REVIEW_WAITS, findingsText, runConditions, runDeclarations, wholeRunEvidence, worktreeSnapshot, type DoneReview } from "./done-review";
import { assertTaskCheckout, checkedOut, commitStaged, fallbackMessage, mergeInProgress, stageAll, vaultStatus, type FinishPlan } from "./finish";
import { discardWorktree, git, mergeTask } from "./git";
import { recordDecision } from "./helper-receipt";
import { appendEntry, outcomeOf, wasLogged, type Level, type Outcome as LogOutcome } from "./error-log";
import { readJson, saveJson, type Receipt } from "./jobs";
import { checkLimitsMs, readCatalogue } from "./checks";
import { runCards, targetEffectRefusal } from "./orchestrator";
import { runChecks } from "./worker";

/** Automatic prompts per orchestrator, counted independently for review corrections and child merge retries. */
export { AUTO_ROUNDS };
export interface AutoFinishDeps {
  review: (task: Task, opts: { auto: true }) => Promise<DoneReview>;
  closeTab: (t: Task) => Promise<void>;
  limits?: { closeMs: number; pollMs: number; resolveMs: number };
  /** Finish's own helpers (Board.complete); message also writes the master's commit before the children are merged. */
  helpers?: { message?: (diff: string) => Promise<string>; resolve?: (request: string) => Promise<{ code: number | null; output: string }> };
}

const UNRECORDED = "The worktree state could not be recorded, so the push waits for you.";
const CHANGED = "The run's files changed while it was being reviewed, so the push waits for you.";
const UNCOVERED = "The review lacks verified evidence for the current run's requirements.";
/** A finishReady that came while the master was being finished (board.completing), with its review if any: never two at once, none lost. */
const pending = new Map<string, DoneReview | undefined>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function sameUnmet(previous: DoneReview, current: DoneReview): boolean {
  const bound = previous.declarations && current.declarations;
  const sameOrder = bound && JSON.stringify(previous.declarations) === JSON.stringify(current.declarations);
  const unmet = (review: DoneReview) => {
    const rules = review.declarations?.map(d => JSON.stringify(d));
    const keys: (string | number)[] = [];
    for (const f of review.findings) {
      if (f.status !== "not-met") continue;
      if (bound && rules && f.conditionIndex !== undefined) {
        const rule = rules[f.conditionIndex - 1];
        if (!rule) return;
        if (sameOrder) keys.push(f.conditionIndex); // unchanged declarations distinguish even identical rules
        else if (rules.indexOf(rule) === rules.lastIndexOf(rule)) keys.push(rule);
        else return; // a moved duplicate cannot be identified
      } else {
        // Inferred findings and older reviews only have their wording. Never guess which duplicate they meant.
        if (review.findings.filter(other => other.condition === f.condition).length !== 1) return;
        keys.push(JSON.stringify(f.condition));
      }
    }
    return JSON.stringify(keys.sort());
  };
  const before = unmet(previous);
  return before !== undefined && before === unmet(current);
}
const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "None.");

type Outcome = "finished" | "sent-back" | "asked" | "stopped";
/**
 * reviewed: a Done the caller already has (the user's own Review on a master that asked to finish); otherwise the board reviews now.
 * A call while one runs for the same master is remembered, and runs (with all its own checks) once that one leaves or asks.
 */
export async function autoFinish(board: Board, master: Task, deps: AutoFinishDeps, reviewed?: DoneReview): Promise<Outcome> {
  if (master.finishAsked?.reviewInterrupted && !reviewed) return "stopped";
  if (board.completing.has(master.id)) { pending.set(master.id, reviewed); return "stopped"; }
  const result = await finishOnce(board, master, deps, reviewed);
  if (!pending.has(master.id)) return result;
  const next = pending.get(master.id);
  pending.delete(master.id);
  return result === "finished" || result === "sent-back" ? result : autoFinish(board, master, deps, next); // those answered it
}

async function finishOnce(board: Board, master: Task, deps: AutoFinishDeps, reviewed?: DoneReview): Promise<Outcome> {
  // The master working again (a follow-up, a notice that woke it, its checks): its worktree and column are left alone, and
  // finishAsked stays, so its next Stop finishes it. Checked again before each step that touches the worktree or pushes.
  const running = () => master.status === "running"; // a function: the status changes under the awaits below
  const busy = () => running() || board.busyWith(master).length > 0;
  if (running() || master.checks?.status === "running") return "stopped"; // changes nothing
  board.completing.set(master.id, "Finish"); // the user's Finish is refused until this run leaves
  const leave = () => { board.update(master, { selfFinish: undefined }); return "stopped" as const; };
  let landed = false; // Finish pushed and moved the master to Done: a later failure is an error on the card, never Needs input
  const limits = deps.limits ?? { closeMs: 60_000, pollMs: 1000, resolveMs: 900_000 };
  const step = (text: string) => board.update(master, { selfFinish: { step: text } });
  const started = Date.now();
  // F103: an automatic finish that stops is a line in the board's error log; a review or Finish failure logged itself already.
  const log = (level: Level, outcome: LogOutcome, message: string, stage = master.selfFinish?.step ?? "Starting") => appendEntry(board.dir, { level, action: "finish", outcome,
    stage: `Automatic finish: ${stage}`, card: { id: master.id, title: master.title }, provider: master.provider ?? "claude", account: master.account, durationMs: Date.now() - started, message });
  const ask = (text: string) => {
    log("info", "waiting", text);
    board.waitForFinishInput(master, text);
    board.runEvents.fire({ kind: "needsYou", master, task: master, text });
    return "asked" as const;
  };
  // The orchestrator gets it; this request ends there, and it calls finish self again when done.
  const sendBack = async (prompt: string, counter: "autoRounds" | "mergeRetries", patch: Partial<Task> = {}) => {
    if (!master.headless && !master.takenOver && !master.controller && !master.orchestrator?.session && board.terminal(master))
      await board.send(master, prompt, true, "automatic-submit");
    else await board.followUpHeadless(master, prompt);
    board.update(master, { [counter]: (master[counter] ?? 0) + 1, finishAsked: undefined, selfFinish: undefined, ...patch });
    return "sent-back" as const;
  };
  try {
    // Only a run's master finishes unattended; any other card keeps Finish's dialog.
    if (!master.orchestrator || master.orchestrator.root) throw new Error("Only a run's master card finishes by itself.");
    if (master.planRun) throw new Error("A plan's own reviewer judges this card."); // canReview's text
    { const why = targetEffectRefusal(master, board.tasks, "Self-finish"); if (why) throw new Error(why); } // phase 3: before any commit or merge
    if (!master.worktree || !master.branch) throw new Error("This card has no worktree of its own.");
    const worktree = master.worktree, branch = master.branch, run = runCards(master.id, board.tasks);
    // The request was refused while a card was open, but one may have been reopened since: never stop work under way.
    const open = run.filter((t) => t.status !== "done" && !t.cancelled);
    if (open.length) throw new Error(`${open.map((t) => `"${t.title}"`).join(", ")} ${open.length === 1 ? "is" : "are"} not Done or cancelled, so the run cannot finish.`);

    // Before separate counters the only automatic prompts before the first review were merge retries.
    // With a saved review, refund only identifiable merge prompts in the most recent charged turns.
    if (master.mergeRetries === undefined && master.autoRounds) {
      const total = master.autoRounds;
      let merges = total;
      if (master.doneReview) {
        const recent = board.prompts(master, Infinity).slice(1).slice(-total);
        const conflicts = recent.filter(p => /(?:^|\n)Merging .+ into your branch failed: .+\. Merge it, resolve the conflict, commit, then call board\.js finish self again\.$/.test(p.text));
        merges = Math.min(conflicts.length, total - (master.doneReview.sent === "auto" ? 1 : 0));
      }
      board.update(master, { autoRounds: total - merges, mergeRetries: merges });
    }

    // 1. Close the run's sessions still open, and wait for their processes to end.
    await assertTaskCheckout(worktree, branch);
    step("Closing the run's sessions");
    for (const t of board.liveRun(master).filter((t) => t.id !== master.id)) {
      board.stop(t);
      for (const start = Date.now(); board.live().includes(t.id); await sleep(limits.pollMs))
        if (Date.now() - start > limits.closeMs) throw new Error(`"${t.title}" is still running after ${Math.round(limits.closeMs / 1000)} seconds.`);
    }

    // A delivery of the master's own work may be under way: its Stop on a delivery turn starts one just before this run, and it
    // commits and merges in this same worktree. No new one starts while the card is in `completing` (19 November 2026, M-05).
    await board.deliveryIdle();

    // 2. The master's own uncommitted work: mergeTask refuses a dirty checkout.
    if (busy()) return leave();
    await assertTaskCheckout(worktree, branch);
    if (await git(worktree, ["status", "--porcelain", "--untracked-files=all"]) || await mergeInProgress(worktree)) {
      step("Committing the orchestrator's work");
      await assertTaskCheckout(worktree, branch);
      const { diff } = await stageAll(worktree);
      const message = await (deps.helpers?.message ?? (async () => fallbackMessage(master.title)))(diff);
      await assertTaskCheckout(worktree, branch);
      await commitStaged(worktree, message);
    }

    // 3. Every Done child's commits not in the master's branch. A conflict is the orchestrator's to resolve: an automatic round.
    for (const child of run.filter((t) => t.status === "done" && !t.cancelled && t.branch)) {
      const reason = await childCheckoutProblem(child);
      if (reason) throw new Error(`Cannot finish "${child.title}" (${child.id}): ${reason}`);
      if (!(await board.unmergedWork(child, branch))) continue;
      step(`Merging ${child.title}`);
      await assertTaskCheckout(worktree, branch, false);
      try { await mergeTask(worktree, child.branch!); }
      catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!message.startsWith("Merge failed") || (master.mergeRetries ?? 0) >= AUTO_ROUNDS) throw e;
        const said = message.split("\nThe repo is unchanged")[0].replace(/^Merge failed: /, "").replace(/\s+/g, " ").trim().replace(/\.$/, "");
        return await sendBack(`Merging ${child.title} (${child.branch}) into your branch failed: ${said}. Merge it, resolve the conflict, commit, then call board.js finish self again.`, "mergeRetries");
      }
    }

    // 4. The review of the whole run. Its input carries the master's check results (done-review.ts reviewInput).
    const previous = master.doneReview;
    const childRules = () => runCards(master.id, board.tasks).map(t => ({ id: t.id, prompt: t.prompt, doneWhen: t.completion?.doneWhen }));
    const coversRun = (review: DoneReview) => {
      const conditions = runConditions(master.completion?.doneWhen, childRules());
      const followUps = board.prompts(master, Infinity).slice(1).map(e => e.text);
      return review.wholeRunEvidence === wholeRunEvidence(master.prompt, followUps, conditions, review.findings);
    };
    let review = reviewed;
    for (let pass = 0; ; pass++) {
      if (!review) {
        await assertTaskCheckout(worktree, branch);
        step(FINISH_REVIEW_STEPS[pass ? 1 : 0]);
        // For a reviewer returning just numbered findings, bind them to the declarations at dispatch.
        // A validated result carries its own declarations from the input it actually read.
        const declarations = runDeclarations(master.completion?.doneWhen, childRules());
        review = await deps.review(master, { auto: true });
        if (review.verdict === "not-done" && !review.declarations) review = { ...review, declarations };
        if (busy()) return leave(); // it started while the reviewer read: neither a prompt nor a push now
      }
      await assertTaskCheckout(worktree, branch);
      board.update(master, { doneReview: review });
      if (review.verdict === "not-done") {
        if ((master.autoRounds ?? 0) > 0 && previous?.sent === "auto" && previous.verdict === "not-done" && sameUnmet(previous, review)) return ask(REVIEW_WAITS.noProgress);
        if ((master.autoRounds ?? 0) >= AUTO_ROUNDS) return ask(REVIEW_WAITS.exhausted);
        const sent = await sendBack(review.prompt, "autoRounds", { mergeRetries: master.mergeRetries ?? 0, doneReview: { ...review, sent: "auto" } });
        recordDecision(review.receipt, "auto");
        return sent;
      }
      if (review.verdict !== "done") return ask(REVIEW_WAITS.unsure);
      // A Done covers only the worktree it read (its snapshot, taken as it gathered its input). A manual Done from before steps 2
      // and 3, or a turn the master took while the reviewer read, is reviewed again once, on the state that would be pushed.
      // the user is asked when that cannot settle it; only a running master is left silently, since its next Stop resumes this.
      if (!review.snapshot) return busy() ? leave() : ask(UNRECORDED); // worktreeSnapshot failed (a diff over git()'s buffer)
      const covered = coversRun(review);
      if (covered && review.snapshot === await worktreeSnapshot(worktree)) break;
      // A saved Done from before per-output evidence, or a change to the rules without a tree edit, needs a current review.
      if (!covered && (!reviewed || pass)) return ask(UNCOVERED);
      if (pass) return busy() ? leave() : ask(CHANGED);
      review = undefined;
    }

    // 5. Each card's commits, for the report, while its branch still exists (merged or not).
    const head = await git(board.repo, ["rev-parse", "HEAD"]);
    const cards: { t: Task; column: string; commits: string }[] = [];
    for (const t of run) cards.push({ t, column: t.cancelled ? `${t.status}, cancelled` : t.status,
      commits: t.branch ? await git(board.repo, ["merge-base", head, t.branch]).then((base) => git(board.repo, ["log", "--oneline", `${base}..${t.branch}`])).catch(() => "") : "" });
    const reply = board.finalReply(master);

    // 6. Finish, with no dialog. Its checks run after each merge with the remote's latest, before the push.
    const commands = master.completion?.commands ?? [];
    // BUG-14: each command runs under its own finite limit (checks.ts checkLimitMs), from the catalogue of the main folder, not the
    // candidate's own copy. Only a run the worker recorded as passed lets the push go on; a failed command, one ended from outside,
    // one stopped at its limit or a receipt that says anything else throws, and Finish then keeps the worktree for the next try.
    const beforePush = async (cwd: string) => {
      if (!commands.length) return;
      const job = path.join(board.dir, "checks", master.id, String(Date.now()), "job.json");
      saveJson(job, { commands, cwd, phase: "delivery", at: new Date().toISOString(), limitsMs: checkLimitsMs(commands, readCatalogue(board.repo)) });
      await runChecks(job); // records a failure in its receipt instead of throwing
      const r = readJson<Receipt>(path.join(path.dirname(job), "receipt.json"));
      if (r.status !== "complete" || r.checksPassed !== true) throw new Error((r.error || "The acceptance checks did not pass.").replace(/^Error: /, ""));
      // The full suite's limit is 33 minutes now. Work that started meanwhile may have changed what the checks passed on.
      if (busy()) throw new Error("It started working while its acceptance checks ran, so nothing was pushed. Its next finish runs them again.");
    };
    let plan: FinishPlan | undefined;
    if (busy()) return leave();
    if (!coversRun(review)) return ask(UNCOVERED);
    const notes = (await board.completeHeld(master, async (p) => { plan = p; return true; }, step, deps.closeTab, limits, { ...deps.helpers, beforePush })) || [];
    landed = true;

    // 7. The run's worktrees, branches and temporary files. A card with work not in what was pushed is left as it is, and listed.
    step("Cleaning up");
    const finished = plan as FinishPlan | undefined, ref = finished ? (finished.remote ? `${finished.remote}/${finished.remoteBranch}` : finished.target) : "HEAD";
    const cleaned = [`The worktree and branch of "${master.title}" (Finish).`], left: string[] = [];
    let cleanupError: string | undefined;
    try {
      for (const t of run) {
        const why = await board.unmergedWork(t, ref) || await childCheckoutProblem(t);
        if (why) { left.push(`"${t.title}" (${t.id}): ${why}. Its column, worktree ${t.worktree ?? "(none)"}, branch ${t.branch ?? "(none)"} and temporary files are kept.`); continue; }
        if (t.worktree && t.branch) { await discardWorktree(board.repo, t.worktree, t.branch, !!t.legacySpeechId); cleaned.push(`The worktree and branch ${t.branch} of "${t.title}".`); }
        removeTemp(board, t.id);
        board.update(t, { status: "done", ...(t.worktree && t.branch ? { worktree: undefined, branch: undefined } : {}) });
      }
      removeTemp(board, master.id);
      cleaned.push("The temporary files of those cards and the master: hooks, launch, wait and checks. Events, stream and metrics are kept for the board's history and cost.");
    } catch (e) {
      cleanupError = `Cleaning up stopped: ${e instanceof Error ? e.message : String(e)} Anything not listed under Cleaned up is still on disk.`;
      notes.push(cleanupError);
    }

    // 8. The report, beside the board, and a notification.
    step("Writing the report");
    const sha = finished ? await git(board.repo, ["rev-parse", ref]).catch(() => "") : "";
    // FR2: a repo with a vault is merged here and never pushed. An automatic finish has no approval to upload (the helper needs
    // the user's PIN and touch), so it stops with the upload pending: said here, in the notes and in a notification of its own.
    const vault = finished?.vault ? master.vault : undefined, waits = !!vault && vault.state !== "uploaded";
    const pushed = !finished ? "Nothing was pushed: its branch was already gone."
      : `${ref} at ${sha}${finished.vault ? ` (merged here; nothing is pushed in a repo with a vault${waits ? `, and the upload to ${vault!.destination.name} is pending: see Notes` : ""})` : finished.remote ? "" : " (no remote is set, so it was merged locally)"}`;
    const file = path.join(board.dir, "reports", `${master.id}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [`# ${master.title} (${master.id}): finished by itself`,
      `## What the run did\n\n${reply?.trim() || "No final reply."}`,
      `## Cards\n\n${cards.map((c) => `### ${c.t.title} (${c.t.id})\n\nColumn: ${c.column}\nDone when: ${c.t.completion?.doneWhen || "none"}\nCommits:\n${c.commits || "none"}`).join("\n\n") || "None."}`,
      `## Review\n\nVerdict: Done\nFile: ${review.file}\n\n${findingsText(review)}`,
      `## Pushed\n\n${pushed}`, `## Cleaned up\n\n${list(cleaned)}`, `## Left behind\n\n${list(left)}`, `## Notes\n\n${list(notes)}`].join("\n\n") + "\n");
    board.update(master, { selfFinish: { report: file, ...(cleanupError ? { error: cleanupError } : {}) }, finishAsked: undefined });
    if (cleanupError) board.runEvents.fire({ kind: "needsYou", master, task: master, text: cleanupError });
    if (waits) board.runEvents.fire({ kind: "needsYou", master, task: master, text: vaultStatus(vault!) });
    const show = () => vscode.workspace.openTextDocument(vscode.Uri.file(file)).then((doc) => vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true }));
    void Promise.resolve(vscode.window.showInformationMessage(`Entomatical: "${master.title}" finished by itself${sha ? `: ${sha.slice(0, 7)} is on ${ref}` : ""}${waits ? `; the upload to ${vault!.destination.name} is pending` : ""}.`, "Open report"))
      .then((pick) => (pick ? show() : undefined)).catch(() => undefined);
    await Promise.resolve(show()).catch(() => undefined); // the work is done; a tab that will not open changes nothing
    return "finished";
  } catch (e) {
    // Nothing more is deleted; the card names the step it stopped at, and the error. A running master keeps its column, and a
    // Done one (the failure came after the push) stays Done.
    const error = e instanceof Error ? e.message : String(e);
    if (!wasLogged(e)) log("error", outcomeOf(e), error);
    board.update(master, { ...(landed || busy() ? {} : { status: "needs-input" as const }), ...(landed ? { finishAsked: undefined } : {}),
      selfFinish: { step: master.selfFinish?.step, error } });
    board.runEvents.fire({ kind: "needsYou", master, task: master, text: error });
    return landed ? "finished" : "stopped";
  } finally { board.completing.delete(master.id); }
}

/** A child's recorded branch can be landed while another checkout or unfinished operation still holds work in its folder. */
async function childCheckoutProblem(task: Task): Promise<string | undefined> {
  if (!task.worktree || !task.branch || !fs.existsSync(task.worktree)) return;
  try {
    if (!checkedOut(task.worktree)) {
      const files = leftoverFiles(task.worktree);
      return files.length ? `its leftover folder holds files: ${files.join(", ")}` : undefined;
    }
    await assertTaskCheckout(task.worktree, task.branch, false);
  } catch (e) { return e instanceof Error ? e.message : String(e); }
}

/** The card's temporary files: its hook settings, launch files, wait record and check runs. */
function removeTemp(board: Board, id: string) {
  const launch = path.join(board.dir, "launch");
  const names = fs.existsSync(launch) ? fs.readdirSync(launch).filter((n) => n.startsWith(`${id}.`)).map((n) => path.join(launch, n)) : [];
  for (const f of [path.join(board.dir, "hooks", `${id}.json`), path.join(board.dir, "wait", `${id}.json`), path.join(board.dir, "wait", id), path.join(board.dir, "checks", id), ...names])
    fs.rmSync(f, { recursive: true, force: true });
}
