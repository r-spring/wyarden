import * as fs from "fs";
import * as path from "path";
import type { Task } from "./board";

/** A deleted card's import marker outlives its row in tasks.json. */
export function speechImportIds(repo: string): Set<string> {
  const file = path.join(repo, ".entomatical", "speech-imported.json");
  let ids: unknown;
  try { ids = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  if (!Array.isArray(ids) || !ids.every(id => typeof id === "string")) throw new Error(`Invalid speech import history in ${file}`);
  return new Set(ids);
}

/** Import metadata without moving/deleting worktrees, transcripts, or the retired board. */
export function speechHistory(repo: string, current: Task[], remembered = speechImportIds(repo)): Task[] {
  let source: Task[];
  try { source = JSON.parse(fs.readFileSync(path.join(repo, ".entomatical-speech", "tasks.json"), "utf8")); }
  catch { return []; }
  if (!Array.isArray(source)) return [];
  source = source.filter(t => t && typeof t.id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(t.id) && typeof t.prompt === "string" && typeof t.title === "string");
  source = source.filter(t => !remembered.has(t.id));
  const imported = new Map(current.filter(t => t.legacySpeechId).map(t => [t.legacySpeechId!, t.id]));
  const ids = new Set(current.map(t => t.id));
  for (const task of source) {
    if (imported.has(task.id)) continue;
    let id = task.id;
    while (ids.has(id)) id = `speech-${id}`;
    ids.add(id); imported.set(task.id, id);
  }
  return source.filter(t => !current.some(c => c.legacySpeechId === t.id)).map(t => ({ ...t,
    id: imported.get(t.id)!, parentId: t.parentId ? imported.get(t.parentId) || t.parentId : undefined, legacySpeechId: t.id }));
}
