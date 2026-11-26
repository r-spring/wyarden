/**
 * Asana as the context store for board tasks (the user, 2 November 2026). A card can be linked to a task in the workspace's chosen
 * Asana project. When the card's session starts, the Asana task's description and latest comments go in with its first prompt;
 * when Finish or Merge lands its work, a comment with the session's last reply is added to the Asana task. Entomatical only reads
 * tasks, creates a task when asked, and adds comments: it never edits or deletes an existing task's name or description.
 *
 * The token is a personal access token from ASANA_PAT or VS Code's secret storage (extension.ts). It is held in memory, sent only
 * to app.asana.com, and never written to a file, log or message. No vscode import, so tests run it with a fake fetch.
 */
const API = "https://app.asana.com/api/1.0";
/** Caps that keep the context block small: it rides on every linked task's first prompt. */
export const NOTES_CAP = 6000, COMMENT_CAP = 800, COMMENTS = 10, REPLY_CAP = 3000;
const PAGE = 100, MAX_PAGES = 5;

export interface AsanaTask { gid: string; name: string; url?: string }
export interface AsanaLink { gid: string; name: string; url?: string }
type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export class Asana {
  constructor(private readonly token: string, private readonly fetchFn: Fetch = (globalThis as any).fetch, private readonly timeoutMs = 20_000) {
    if (!token) throw new Error("No Asana token. Set ASANA_PAT, or run Entomatical: Set Asana Token.");
  }

  private async call(method: string, pathAndQuery: string, data?: unknown): Promise<any> {
    const r = await this.fetchFn(API + pathAndQuery, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json", ...(data ? { "Content-Type": "application/json" } : {}) },
      body: data ? JSON.stringify({ data }) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const why = Array.isArray(body?.errors) ? body.errors.map((e: any) => e?.message).filter(Boolean).join("; ") : "";
      throw new Error(`Asana answered ${r.status}${why ? `: ${why}` : ""}.`);
    }
    return body;
  }

  /** Every page of a list, up to MAX_PAGES. truncated says more were left unread. */
  private async list(pathAndQuery: string): Promise<{ items: any[]; truncated: boolean }> {
    const items: any[] = [];
    let offset: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const sep = pathAndQuery.includes("?") ? "&" : "?";
      const body = await this.call("GET", `${pathAndQuery}${sep}limit=${PAGE}${offset ? `&offset=${encodeURIComponent(offset)}` : ""}`);
      items.push(...(Array.isArray(body.data) ? body.data : []));
      offset = body.next_page?.offset;
      if (!offset) return { items, truncated: false };
    }
    return { items, truncated: true };
  }

  /** The workspaces (and organizations) the token can see. */
  async workspaces(): Promise<AsanaTask[]> {
    const { items } = await this.list("/workspaces?opt_fields=name");
    return items.map((w) => ({ gid: w.gid, name: w.name }));
  }

  /** One workspace's projects that are not archived, sorted by name. */
  async projects(workspace: string): Promise<AsanaTask[]> {
    const { items } = await this.list(`/projects?workspace=${encodeURIComponent(workspace)}&archived=false&opt_fields=name`);
    return items.map((p) => ({ gid: p.gid, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async projectName(project: string): Promise<string> {
    return (await this.call("GET", `/projects/${encodeURIComponent(project)}?opt_fields=name`)).data?.name ?? project;
  }

  /** The project's open tasks, in the project's order. */
  async openTasks(project: string): Promise<{ tasks: AsanaTask[]; truncated: boolean }> {
    const { items, truncated } = await this.list(`/projects/${encodeURIComponent(project)}/tasks?completed_since=now&opt_fields=name,permalink_url`);
    return { tasks: items.filter((t) => t.name?.trim()).map((t) => ({ gid: t.gid, name: t.name, url: t.permalink_url })), truncated };
  }

  /** The block added to a linked task's first prompt: its name, link, description and latest comments. */
  async context(gid: string, now = new Date()): Promise<string> {
    const task = (await this.call("GET", `/tasks/${encodeURIComponent(gid)}?opt_fields=name,notes,permalink_url,completed,due_on,assignee.name`)).data;
    const { items, truncated } = await this.list(`/tasks/${encodeURIComponent(gid)}/stories?opt_fields=type,text,created_at,created_by.name`);
    return contextBlock(task, items.filter((s) => s.type === "comment"), truncated, now);
  }

  async create(project: string, name: string, notes: string): Promise<AsanaLink> {
    const t = (await this.call("POST", "/tasks?opt_fields=name,permalink_url", { name, notes, projects: [project] })).data;
    return { gid: t.gid, name: t.name, url: t.permalink_url };
  }

  async comment(gid: string, text: string): Promise<void> {
    await this.call("POST", `/tasks/${encodeURIComponent(gid)}/stories`, { text });
  }
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (cut at ${n.toLocaleString("en")} characters)` : s);

export function contextBlock(task: any, comments: any[], storiesTruncated: boolean, now = new Date()): string {
  const notes = String(task?.notes ?? "").trim();
  const shown = comments.slice(-COMMENTS);
  const lines = [
    "", "",
    `Asana context (added by Entomatical from the linked Asana task, read ${now.toISOString().slice(0, 16).replace("T", " ")} UTC)`,
    `Task: ${task?.name ?? ""}${task?.permalink_url ? ` (${task.permalink_url})` : ""}`,
    ...(task?.completed ? ["Status: completed in Asana"] : []),
    ...(task?.due_on ? [`Due: ${task.due_on}`] : []),
    ...(task?.assignee?.name ? [`Assignee: ${task.assignee.name}`] : []),
    "Description:", notes ? cap(notes, NOTES_CAP) : "(none)",
  ];
  if (shown.length) {
    const older = comments.length - shown.length;
    lines.push(`Latest comments, oldest first${older ? ` (${older} older not shown)` : ""}${storiesTruncated ? " (the task has more history than was read)" : ""}:`);
    for (const c of shown) lines.push(`- ${c.created_by?.name ?? "someone"}, ${String(c.created_at ?? "").slice(0, 10)}: ${cap(String(c.text ?? "").trim(), COMMENT_CAP)}`);
  }
  lines.push("When this task is finished, Entomatical adds a comment with your last reply to that Asana task, so end with a short summary of what was done.");
  return lines.join("\n");
}

/** The comment Finish or Merge adds to the linked Asana task. */
export function finishComment(title: string, id: string, branch: string | undefined, reply: string | undefined): string {
  return [`Entomatical finished "${title}" (card ${id})${branch ? `: ${branch} was merged` : ""}.`,
    ...(reply?.trim() ? ["", "Last reply:", cap(reply.trim(), REPLY_CAP)] : [])].join("\n");
}

/** A project's gid from a gid or an Asana project URL (app.asana.com/0/<project>/... or /1/<workspace>/project/<project>/...). */
export function projectGid(input: string): string | undefined {
  const s = input.trim();
  if (/^\d+$/.test(s)) return s;
  return s.match(/\/project\/(\d+)/)?.[1] ?? s.match(/app\.asana\.com\/0\/(\d+)/)?.[1];
}
