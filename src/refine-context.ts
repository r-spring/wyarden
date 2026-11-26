import * as fs from "fs";
import * as path from "path";
import { projectContext } from "./jobs";

/** Most characters of project context a refinement sends. Keeps the helper call small. */
export const CONTEXT_LIMIT = 6000;
const NOTE_FILES = ["CLAUDE.md", "README.md"];
const NOTE_CHARS = 1500;

/**
 * The opening of a note file: a regular file inside the repo, and only its first 8 KB. A symlink could point at a login token
 * outside the repo, and a FIFO named README.md would block the extension host (review, 4 November 2026).
 */
function opening(file: string, repo: string): string {
  let fd: number | undefined;
  try {
    // A link is followed only while it stays in the repo (CLAUDE.md -> AGENTS.md is common); one to a token outside is not.
    const real = fs.realpathSync.native(file), root = fs.realpathSync.native(repo);
    if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) return "";
    fd = fs.openSync(real, "r");
    const b = Buffer.alloc(8192);
    return b.subarray(0, fs.readSync(fd, b, 0, b.length, 0)).toString("utf8").trim();
  } catch { return ""; } // absent: skipped
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/**
 * Read-only project context for the refinement helper, so it can answer what the folder already makes clear instead of
 * asking: the tracked-file inventory and package scripts (projectContext, as the completion rule gets), the opening of
 * CLAUDE.md and README.md. The helper itself still runs without tools. The notes keep their place; the inventory gets what is
 * left (a big package.json used to push them out past the limit). The board's other open tasks are no longer sent
 * (25 November 2026).
 */
export function refinementContext(repo: string): string {
  const notes: string[] = [];
  for (const file of NOTE_FILES) {
    const text = opening(path.join(repo, file), repo);
    if (text) notes.push(`${file} (opening):\n${text.slice(0, NOTE_CHARS)}${text.length > NOTE_CHARS ? "\n[truncated]" : ""}`);
  }
  const rest = notes.join("\n\n");
  const head = `Repository: ${path.basename(repo)}\n`;
  const room = Math.max(0, CONTEXT_LIMIT - head.length - rest.length - 2);
  // Most useful first, as the cut takes the end: the package's scripts (how to build and test), then the files, then dependency names.
  const { package: pkg, ...files } = projectContext(repo) as Record<string, any>;
  const inventory = JSON.stringify({ ...(pkg ? { package: { name: pkg.name, scripts: pkg.scripts } } : {}), ...files,
    ...(pkg ? { dependencies: pkg.dependencies, devDependencies: pkg.devDependencies } : {}) });
  const cut = inventory.length > room ? inventory.lastIndexOf(",", room - 12) : -1; // at an entry boundary, never inside one
  return [head + (inventory.length > room ? `${inventory.slice(0, Math.max(0, cut))}\n[truncated]` : inventory), rest].filter(Boolean).join("\n\n").slice(0, CONTEXT_LIMIT);
}
