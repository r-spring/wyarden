/** Local Markdown notes used as a context store for board cards. No Obsidian plugin or network service is needed. */
import * as fs from "fs";
import * as path from "path";
import { finishComment } from "./asana";

const NOTES_CAP = 6000, MAX_NOTES = 500;
export interface ObsidianLink { folder: string; note: string }
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** List Markdown notes below the selected folder, ignoring hidden folders and symbolic links. */
export async function listNotes(folder: string): Promise<{ notes: string[]; truncated: boolean }> {
  const root = await fs.promises.realpath(folder);
  const notes: string[] = [], pending = [""];
  while (pending.length) {
    const dir = pending.pop()!;
    const entries = await fs.promises.readdir(path.join(root, dir), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(relative);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        if (notes.length === MAX_NOTES) return { notes: notes.sort(), truncated: true };
        notes.push(relative);
      }
    }
  }
  return { notes: notes.sort(), truncated: false };
}

/** Resolve every read/write beneath its original folder, even if settings have since changed. */
async function notePath(link: ObsidianLink): Promise<string> {
  if (!path.isAbsolute(link.folder) || path.isAbsolute(link.note) || !/\.md$/i.test(link.note)) throw new Error("Invalid Obsidian note path.");
  const root = await fs.promises.realpath(link.folder);
  const candidate = path.resolve(root, link.note);
  if (!inside(root, candidate)) throw new Error("The Obsidian note is outside its chosen folder.");
  const file = await fs.promises.realpath(candidate);
  if (!inside(root, file)) throw new Error("The Obsidian note is outside its chosen folder.");
  if (path.relative(candidate, file)) throw new Error("The linked Obsidian note now resolves through a symbolic link.");
  return file;
}

/** Read a bounded amount for the first prompt; a missing or moved note is an error, never a new file. */
export async function noteContext(link: ObsidianLink): Promise<string> {
  const file = await notePath(link);
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("The linked Obsidian note is not a file.");
    const buffer = Buffer.alloc(NOTES_CAP * 4 + 4);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const cut = stat.size > bytesRead || text.length > NOTES_CAP;
    return `\n\nObsidian context (linked note ${link.note}; read ${new Date().toISOString()}):\n${text.slice(0, NOTES_CAP)}${cut ? `\n… (cut at ${NOTES_CAP.toLocaleString("en")} characters)` : ""}\nWhen this task is finished, Entomatical appends up to 3,000 characters of your last reply to this note, so end with a short summary of what was done.`;
  } finally { await handle.close(); }
}

/** Create a new note without replacing an existing one, including on Windows. */
export async function createNote(folder: string, title: string, prompt: string): Promise<ObsidianLink> {
  const root = await fs.promises.realpath(folder);
  const clean = title.replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").trim();
  let base = "";
  for (const ch of clean) {
    if (base.length + ch.length > 100 || Buffer.byteLength(base + ch, "utf8") > 200) break;
    base += ch;
  }
  base = base.replace(/[. ]+$/g, "") || "New note";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  for (let n = 1; n <= 1000; n++) {
    const note = `${base}${n === 1 ? "" : ` (${n})`}.md`;
    let handle: fs.promises.FileHandle;
    try { handle = await fs.promises.open(path.join(root, note), "wx"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") continue; throw e; }
    try { await handle.writeFile(`# ${title.replace(/[\r\n]+/g, " ")}\n\n${prompt}\n`, "utf8"); }
    finally { await handle.close(); }
    return { folder: root, note };
  }
  throw new Error("Could not find an unused name for the new Obsidian note.");
}

/** Append to an existing file only: never recreate a deleted note or replace its contents. */
export async function appendResult(link: ObsidianLink, title: string, id: string, branch?: string, reply?: string): Promise<void> {
  const file = await notePath(link);
  const handle = await fs.promises.open(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error("The linked Obsidian note is not a file.");
    await handle.writeFile(`\n\n## Entomatical result — ${new Date().toISOString()}\n\n${finishComment(title, id, branch, reply)}\n`, "utf8");
  } finally { await handle.close(); }
}
