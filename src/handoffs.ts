// Load handoff (F101): the handoff docs in <main checkout>/docs/handoffs/, newest first. Pure (no VS Code) so node tests can call it.
import * as fs from "fs";
import * as path from "path";

export interface Handoff { name: string; file: string; mtimeMs: number }

/** The *.md files directly in `dir`, newest first; README.md is the folder's own note and is left out. A missing folder lists nothing. */
export function listHandoffs(dir: string): Handoff[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: Handoff[] = [];
  for (const name of names) {
    if (!/\.md$/i.test(name) || name.toLowerCase() === "readme.md") continue;
    const file = path.join(dir, name);
    try { const st = fs.statSync(file); if (st.isFile()) out.push({ name, file, mtimeMs: st.mtimeMs }); } catch { /* removed meanwhile */ }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
}

/** What Load handoff puts in the prompt box: a marker line naming the doc (absolute path, forward slashes), a newline, then the doc's text unchanged.
 *  A later step detects the marker line, so keep its form exactly: `<!-- handoff: <path> -->`. */
export function handoffPrompt(file: string, text: string): string {
  return `<!-- handoff: ${file.replace(/\\/g, "/")} -->\n${text}`;
}

/** The handoff folder of a main checkout. */
export const handoffDir = (repo: string) => path.join(repo, "docs", "handoffs");

/** A draft Refine draft treats as a handoff (plan 70d079 step 4). path: the doc's absolute path, forward slashes; text: the handoff's text
 *  without the marker line; draft: the marker line and that text, as the receipt stores it; name: the doc's file name. */
export interface HandoffDraft { path: string; name: string; text: string; draft: string }
const MARKER = /^<!--\s*handoff:\s*(.+?)\s*-->$/;

/**
 * Whether a Refine draft is a handoff, checked in the host before the helper runs. (a) The first non-blank line is the marker Load handoff
 * writes (handoffPrompt): the rest of the box is the handoff, as the user may have edited it. (b) The whole trimmed draft is one absolute
 * path (quotes allowed) to an existing .md file inside a folder named docs/handoffs: the doc is read and used with a marker line. Anything
 * else, or a path whose file is missing or unreadable, is not a handoff (undefined), and Refine runs as before. Pure apart from reading files.
 */
export function detectHandoff(draft: string, read: (file: string) => string = (f) => fs.readFileSync(f, "utf8")): HandoffDraft | undefined {
  const first = /^(?:[^\S\n]*\n)*[^\S\n]*(\S[^\n]*)/.exec(draft);
  const marker = first && MARKER.exec(first[1].trim());
  if (first && marker) {
    const end = draft.indexOf("\n", first.index + first[0].length);
    const text = end < 0 ? "" : draft.slice(end + 1);
    return { path: marker[1], name: marker[1].split(/[\\/]/).pop() || marker[1], text, draft: handoffPrompt(marker[1], text) };
  }
  const file = draft.trim().replace(/^"(.+)"$/, "$1").replace(/^'(.+)'$/, "$1");
  if (!file || /[\r\n]/.test(file) || !/\.md$/i.test(file) || !path.isAbsolute(file)) return undefined;
  const folders = path.resolve(file).split(/[\\/]+/).slice(0, -1).map((s) => s.toLowerCase());
  if (!folders.some((s, i) => s === "docs" && folders[i + 1] === "handoffs")) return undefined;
  let text: string;
  try { if (!fs.statSync(file).isFile()) return undefined; text = read(file); } catch { return undefined; }
  const draftText = handoffPrompt(file, text);
  return { path: file.replace(/\\/g, "/"), name: path.basename(file), text, draft: draftText };
}
