import * as vscode from "vscode";
import type { Board, Task } from "./board";

const SCHEME = "entomatical-activity";

/** A read-only view of a headless card; opening or closing it never touches its process. */
export class HeadlessActivity implements vscode.Disposable, vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly registration: vscode.Disposable;
  private readonly boardChange: vscode.Disposable;
  private readonly timer: NodeJS.Timeout;
  private readonly contents = new Map<string, string>();

  constructor(private readonly board: Board) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);
    this.boardChange = board.onChange(() => this.refresh());
    // The stream can grow without a hook event. Only open activity documents are refreshed.
    this.timer = setInterval(() => this.refresh(), 3000);
  }

  private refresh() {
    const open = new Set<string>();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== SCHEME) continue;
      open.add(doc.uri.path);
      if (this.contents.get(doc.uri.path) !== this.render(doc.uri)) this.changed.fire(doc.uri);
    }
    for (const key of this.contents.keys()) if (!open.has(key)) this.contents.delete(key);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const content = this.render(uri);
    this.contents.set(uri.path, content);
    return content;
  }

  private render(uri: vscode.Uri): string {
    const id = uri.path.slice(1).replace(/\.md$/, ""), task = this.board.get(id);
    if (!task) return `# Card ${id}\n\nThis card is no longer on the board.\n`;
    const activity = this.board.doingOf(task)?.text;
    const timeline = this.board.timelineOf(task).map((item) => `- ${item.text}`).join("\n");
    const exchanges = this.board.prompts(task, Infinity).map((p, i) =>
      `## Prompt ${i + 1}\n\n${p.text}\n\n### ${p.replyStatus === "partial" ? "Partial reply (turn not completed)" : "Reply"}\n\n${p.reply ?? "(no reply yet)"}`).join("\n\n");
    return `# ${task.title} (${task.id})\n\nRead-only headless activity; this is not an interactive terminal or a complete tool log.\n\n`
      + `Card status: ${task.status}${task.interrupted ? " (interrupted)" : ""}${task.takenOver ? " (taken over)" : ""}\n\n`
      + `## Current activity\n\n${activity ?? "No current activity reported."}\n\n`
      + `## Recent timeline\n\n${timeline || "No activity reported yet."}\n\n${exchanges}\n`;
  }

  async open(task: Task) {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${task.id}.md` });
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  dispose() {
    clearInterval(this.timer);
    this.boardChange.dispose();
    this.registration.dispose();
    this.changed.dispose();
  }
}
