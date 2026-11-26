/** VS Code controls and card hooks for the local Obsidian context store. */
import * as path from "node:path";
import * as vscode from "vscode";
import { appendResult, createNote, listNotes, noteContext } from "./obsidian";
import type { Board, Task } from "./board";

interface ObsidianSnapshot { folder: string; notes: string[]; truncated?: boolean; error?: string }
let snapshot: ObsidianSnapshot | undefined;
let changed: () => void = () => undefined;
let refreshId = 0;
/** These settings are resource-scoped: read them for the board's folder (without one VS Code logs a warning on every read). */
export const settingsFor = () => vscode.workspace.getConfiguration("entomatical", vscode.workspace.workspaceFolders?.[0]?.uri);
const folder = () => settingsFor().get<string>("obsidian.folder", "").trim();
export const contextSource = () => settingsFor().get<string>("contextSource", "asana");
/** Windows paths differ only in case (`c:\` from a setting, `C:\` from realpath) and still name one folder. */
const samePath = (a: string, b: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
export const obsidianSnapshot = () => snapshot;

export async function refreshObsidian(): Promise<void> {
  const current = folder(), id = ++refreshId;
  if (!current) { snapshot = undefined; changed(); return; }
  try {
    const listed = await listNotes(current);
    if (id !== refreshId) return;
    snapshot = { folder: current, ...listed };
  } catch (e) {
    if (id !== refreshId) return;
    snapshot = { folder: current, notes: [], error: e instanceof Error ? e.message : String(e) };
  }
  changed();
}

export function registerObsidian(context: vscode.ExtensionContext, board: Board | undefined, onChange: () => void) {
  changed = onChange;
  const report = (p: Promise<unknown>) => p.catch((e) => vscode.window.showErrorMessage(`Entomatical: ${e instanceof Error ? e.message : String(e)}`));
  const timer = setInterval(() => void refreshObsidian(), 5 * 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) },
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("entomatical.obsidian")) void refreshObsidian(); else if (e.affectsConfiguration("entomatical.contextSource")) changed(); }),
    vscode.commands.registerCommand("entomatical.contextSource", () => report(chooseSource())),
    vscode.commands.registerCommand("entomatical.obsidianFolder", () => report(chooseFolder())),
    vscode.commands.registerCommand("entomatical.obsidianRefresh", () => report(refreshObsidian())));
  if (board) {
    const before = board.beforeStart;
    board.beforeStart = async (task) => {
      board.noteStartContext.delete(task.id);
      await before(task);
      if (!task.obsidian) return;
      try { board.noteStartContext.set(task.id, await noteContext(task.obsidian)); }
      catch (e) { void vscode.window.showWarningMessage(`Entomatical: "${task.title}" starts without its Obsidian note. ${e instanceof Error ? e.message : String(e)}`); }
    };
  }
  void refreshObsidian();
}

async function chooseSource() {
  const pick = await vscode.window.showQuickPick([
    { label: "Asana project", description: "Link cards to Asana tasks", source: "asana" },
    { label: "Obsidian vault or folder", description: "Send note text to the session; append its result on Finish or Merge", source: "obsidian" },
    { label: "No context source", description: "Keep existing card links, but hide the new-card selector", source: "none" },
  ], { title: "Entomatical: Choose context source" });
  if (!pick) return;
  if (pick.source === "asana") await vscode.commands.executeCommand("entomatical.asanaProject");
  else if (pick.source === "obsidian") await chooseFolder();
  else await settingsFor().update("contextSource", "none", vscode.ConfigurationTarget.Workspace);
}

async function chooseFolder() {
  const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
    title: "Choose an Obsidian vault or folder", openLabel: "Use folder" });
  if (!picked?.[0]) return;
  const settings = settingsFor();
  await settings.update("obsidian.folder", picked[0].fsPath, vscode.ConfigurationTarget.Workspace);
  await settings.update("contextSource", "obsidian", vscode.ConfigurationTarget.Workspace);
  await refreshObsidian();
}

/** A new card's choice, or the same choice from More on an existing card. */
export async function linkObsidian(board: Board, task: Task, choice: string): Promise<void> {
  if (!choice) return;
  board.mustOwn();
  const current = folder();
  if (!current) throw new Error("No Obsidian folder is set. Run Entomatical: Choose Obsidian Folder.");
  if (choice === "new") {
    // Store the folder as the setting names it, as an existing note's link does; createNote returns its realpath.
    const link = { folder: current, note: (await createNote(current, task.title, task.prompt)).note };
    try { board.update(task, { obsidian: link }); }
    catch (e) { throw new Error(`The new note "${link.note}" was created but could not be linked. ${e instanceof Error ? e.message : String(e)}`); }
    void refreshObsidian();
    return;
  }
  if (snapshot?.folder !== current || !snapshot.notes.includes(choice)) throw new Error("That Obsidian note is not in the current folder list. Refresh and pick again.");
  // Re-check the file, including its resolved location, before saving its link.
  await noteContext({ folder: current, note: choice });
  board.mustOwn();
  board.update(task, { obsidian: { folder: current, note: choice } });
}

export async function pickObsidianLink(board: Board, task: Task): Promise<void> {
  board.mustOwn();
  await refreshObsidian();
  if (snapshot?.error && !task.obsidian) throw new Error(snapshot.error);
  const items = [
    ...(folder() && !snapshot?.error ? [{ label: "$(add) New Obsidian note from this card", note: "new" }] : []),
    ...(task.obsidian ? [{ label: "$(close) Unlink", description: task.obsidian.note, note: "unlink" }] : []),
    ...(snapshot?.notes ?? []).map((note) => ({ label: note, description: note === task.obsidian?.note && samePath(folder(), task.obsidian.folder) ? "linked" : "", note })),
  ];
  if (!items.length) throw new Error("No Obsidian folder is set. Run Entomatical: Choose Obsidian Folder.");
  const pick = await vscode.window.showQuickPick(items, { title: `Obsidian note for "${task.title}"`, placeHolder: snapshot?.truncated ? "Only the first 500 notes are listed; choose a smaller folder" : snapshot?.folder });
  if (!pick) return;
  board.mustOwn();
  if (pick.note === "unlink") return void board.update(task, { obsidian: undefined });
  await linkObsidian(board, task, pick.note);
  if (task.sessionId) void vscode.window.showInformationMessage(`Entomatical: linked to "${task.obsidian?.note}". This session already started, so its context was not sent; Finish still appends the result.`);
}

/** After Finish or Merge: warn on failure but do not undo the completed task. */
export async function appendOnFinish(task: Task, branch: string | undefined, reply: string | undefined): Promise<void> {
  if (!task.obsidian) return;
  try { await appendResult(task.obsidian, task.title, task.id, branch, reply); }
  catch (e) { void vscode.window.showWarningMessage(`Entomatical: "${task.title}" is finished, but its Obsidian note was not updated. ${e instanceof Error ? e.message : String(e)}`); }
}
