/**
 * The VS Code side of the Asana context store (asana.ts): the token, the workspace's project, the list of its open tasks for the
 * new-task form, linking a card, the context read before a start, and the comment after Finish or Merge.
 *
 * Settings: entomatical.asana.project (a project gid, set per workspace by Entomatical: Choose Asana Project). The token comes from
 * the ASANA_PAT environment variable, else from VS Code's secret storage (Entomatical: Set Asana Token); it stays in memory.
 */
import * as vscode from "vscode";
import { Asana, AsanaTask, finishComment, projectGid } from "./asana";
import type { Board, Task } from "./board";

const SECRET = "entomatical.asana.token";
const REFRESH_MS = 5 * 60_000;
let secrets: vscode.SecretStorage | undefined;
let changed: () => void = () => undefined;

interface AsanaRequest { project: string; generation: number }
export interface AsanaSelection extends AsanaRequest { choice: string }
/** What the board's form shows: the project and its open tasks, or why they could not be read. */
export interface AsanaSnapshot extends AsanaRequest { projectName?: string; tasks: AsanaTask[]; truncated?: boolean; error?: string }
let generation = 0;
let snapshot: AsanaSnapshot | undefined;

// entomatical.asana.project is resource-scoped: read it for the board's folder, or VS Code logs a warning on every read.
const settingsFor = () => vscode.workspace.getConfiguration("entomatical", vscode.workspace.workspaceFolders?.[0]?.uri);
const project = () => projectGid(settingsFor().get<string>("asana.project", "") ?? "");
export const asanaSnapshot = () => snapshot && snapshot.project === project() ? snapshot : undefined;
const isCurrent = (request: AsanaRequest) => request.generation === generation && request.project === project();
const staleSelection = () => new Error("The Asana selection expired. Refresh and pick again.");

function currentSnapshot(request: AsanaRequest): AsanaSnapshot {
  if (!snapshot || snapshot.project !== request.project || snapshot.generation !== request.generation || !isCurrent(request)) throw staleSelection();
  return snapshot;
}

async function client(): Promise<Asana> {
  const token = process.env.ASANA_PAT?.trim() || (await secrets?.get(SECRET))?.trim() || "";
  return new Asana(token);
}

export async function refreshAsana(): Promise<AsanaSnapshot | undefined> {
  const gid = project();
  const id = ++generation;
  if (snapshot && snapshot.project !== gid) {
    snapshot = undefined;
    changed();
  }
  if (!gid) return;
  const request = { project: gid, generation: id };
  let next: AsanaSnapshot;
  try {
    const asana = await client();
    if (!isCurrent(request)) return;
    const [projectName, open] = await Promise.all([asana.projectName(gid), asana.openTasks(gid)]);
    next = { ...request, projectName, tasks: open.tasks, truncated: open.truncated || undefined };
  } catch (e) {
    next = { ...request, tasks: [], error: e instanceof Error ? e.message : String(e) };
  }
  if (!isCurrent(request)) return;
  snapshot = next;
  changed();
  return next;
}

export function registerAsana(context: vscode.ExtensionContext, board: Board | undefined, onChange: () => void) {
  secrets = context.secrets;
  changed = onChange;
  const report = (p: Promise<unknown>) => p.catch((e) => vscode.window.showErrorMessage(`Entomatical: ${e instanceof Error ? e.message : String(e)}`));
  const timer = setInterval(() => void refreshAsana(), REFRESH_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) },
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("entomatical.asana")) void refreshAsana(); }),
    vscode.commands.registerCommand("entomatical.asanaToken", () => report(setToken())),
    vscode.commands.registerCommand("entomatical.asanaProject", () => report(chooseProject())),
    vscode.commands.registerCommand("entomatical.asanaRefresh", () => report(refreshAsana())));
  if (board) {
    board.beforeStart = async (task) => {
      board.startContext.delete(task.id);
      const gid = task.asana?.gid;
      if (!gid) return;
      try {
        const asana = await client();
        if (!cardWithLink(board, task, gid)) return;
        const text = await asana.context(gid);
        if (cardWithLink(board, task, gid)) board.startContext.set(task.id, text);
      }
      catch (e) { void vscode.window.showWarningMessage(`Entomatical: "${task.title}" starts without its Asana context. ${e instanceof Error ? e.message : String(e)}`); }
    };
  }
  void refreshAsana();
}

async function setToken() {
  const value = await vscode.window.showInputBox({ title: "Asana personal access token", password: true, ignoreFocusOut: true,
    prompt: process.env.ASANA_PAT ? "ASANA_PAT is set and is used first. A token saved here is used only when ASANA_PAT is empty." : "Saved in VS Code's secret storage. Leave empty to remove it." });
  if (value === undefined) return;
  if (value.trim()) await secrets!.store(SECRET, value.trim()); else await secrets!.delete(SECRET);
  await refreshAsana();
}

/** Two steps: an Asana workspace, then one of its projects. Escape on the project list goes back to the workspaces. */
async function chooseProject() {
  const asana = await client();
  const reading = <T>(title: string, run: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, run);
  const spaces = await reading("Entomatical: reading Asana workspaces", () => asana.workspaces());
  if (!spaces.length) throw new Error("This Asana token sees no workspace.");
  const none = { label: "No Asana project", description: "turn the Asana link off for this workspace", gid: "" };
  let pick: { label: string; gid: string } | undefined;
  for (;;) {
    const space = await vscode.window.showQuickPick([none, ...spaces.map((w) => ({ label: w.name, description: w.gid, gid: w.gid }))],
      { title: "Asana workspace (step 1 of 2)", matchOnDescription: true });
    if (!space) return;
    if (!space.gid) { pick = none; break; }
    const projects = await reading(`Entomatical: reading projects in ${space.label}`, () => asana.projects(space.gid));
    if (!projects.length) { void vscode.window.showWarningMessage(`Entomatical: ${space.label} has no open projects this token can see.`); continue; }
    pick = await vscode.window.showQuickPick(projects.map((p) => ({ label: p.name, description: p.gid, gid: p.gid })),
      { title: `Asana project in ${space.label} (step 2 of 2; Escape goes back)`, matchOnDescription: true });
    if (pick) break;
  }
  const settings = settingsFor();
  await settings.update("asana.project", pick.gid || undefined, vscode.ConfigurationTarget.Workspace);
  await settings.update("contextSource", pick.gid ? "asana" : "none", vscode.ConfigurationTarget.Workspace);
  await refreshAsana();
}

function cardWithLink(board: Board, task: Task, gid: string | undefined): Task | undefined {
  const current = board.get(task.id);
  return current && current.createdAt === task.createdAt && current.asana?.gid === gid ? current : undefined;
}

/** Links a card to the chosen Asana task: "new" creates one in the project from the card's title and prompt. */
export async function linkAsana(board: Board, task: Task, selection: AsanaSelection): Promise<void> {
  const { choice, project: gid } = selection;
  const shown = currentSnapshot(selection), previous = task.asana?.gid;
  if (choice === "new") {
    const asana = await client();
    currentSnapshot(selection);
    board.mustOwn();
    if (!cardWithLink(board, task, previous)) throw new Error("The card's Asana link changed. Open Asana task again.");
    const link = await asana.create(gid, task.title, task.prompt);
    const current = cardWithLink(board, task, previous);
    if (!current || !isCurrent(selection)) throw new Error(`Asana created "${link.name}" (${link.gid}). The selection expired during creation. Refresh and pick the task again.`);
    board.mustOwn();
    board.update(current, { asana: link });
    void refreshAsana();
    return;
  }
  const found = shown.tasks.find((t) => t.gid === choice);
  if (!found) throw new Error("That Asana task is no longer open in the project. Refresh and pick again.");
  board.update(task, { asana: { gid: found.gid, name: found.name, url: found.url } });
}

/** More → Asana task: link, change or remove a card's Asana task. */
export async function pickAsanaLink(board: Board, task: Task): Promise<void> {
  board.mustOwn(); // first: "New" creates the Asana task before update() could refuse
  const linked = task.asana?.gid;
  if (task.asana) {
    const options = [{ label: "$(close) Unlink", description: task.asana.name, action: "unlink" }];
    if (project()) options.push({ label: "Change Asana task…", description: "", action: "change" });
    const action = await vscode.window.showQuickPick(options, { title: `Asana task for "${task.title}"` });
    if (!action) return;
    board.mustOwn();
    const current = cardWithLink(board, task, linked);
    if (!current) throw new Error("The card's Asana link changed. Open Asana task again.");
    task = current;
    if (action.action === "unlink") {
      board.update(task, { asana: undefined });
      board.startContext.delete(task.id);
      return;
    }
  }
  if (!project()) throw new Error("No Asana project is set. Run Entomatical: Choose Asana Project.");
  const shown = await refreshAsana();
  if (!shown || !isCurrent(shown)) throw staleSelection();
  if (shown.error) throw new Error(shown.error);
  const items = [
    { label: "$(add) New Asana task from this card", gid: "new" },
    ...shown.tasks.map((t) => ({ label: t.name, description: t.gid === task.asana?.gid ? "linked" : "", gid: t.gid })),
  ];
  const pick = await vscode.window.showQuickPick(items, { title: `Asana task for "${task.title}"`, placeHolder: shown.projectName });
  if (!pick) return;
  board.mustOwn(); // again: the board can move to another window while the pick is open, and "New" creates the Asana task first
  const current = cardWithLink(board, task, linked);
  if (!current) throw new Error("The card's Asana link changed. Open Asana task again.");
  await linkAsana(board, current, { project: shown.project, generation: shown.generation, choice: pick.gid });
  if (task.sessionId) void vscode.window.showInformationMessage(`Entomatical: linked to "${task.asana?.name}". This session already started, so its context was not sent; Finish still adds a comment there.`);
}

/** After Finish or Merge: a comment with the session's last reply on the linked Asana task. A failure is a warning, never a stop. */
export async function commentOnFinish(task: Task, branch: string | undefined, reply: string | undefined): Promise<void> {
  if (!task.asana) return;
  try { await (await client()).comment(task.asana.gid, finishComment(task.title, task.id, branch, reply)); }
  catch (e) { void vscode.window.showWarningMessage(`Entomatical: "${task.title}" is finished, but its Asana comment was not added. ${e instanceof Error ? e.message : String(e)}`); }
}
