/**
 * Advisory, deterministic checks on a draft and on a helper's proposal (4 November 2026 review, consensus items 25, 35, 45; item 3.4).
 * Zero tokens: nothing here calls a model or runs a command from the text. Findings are shown for the user to judge; nothing is
 * deleted or blocked, and none of them establishes that meaning was kept (that needs replay and review).
 *
 * The tracked-file inventory and package scripts stay host-side (projectContext in jobs.ts); only the findings are shown.
 */
import { isPathLike } from "./compile-check";
import { quarantined, type TaskRecord } from "./task-record";

export type LintKind = "not-tracked" | "not-script" | "helper-path" | "git-status" | "source-duplicate" | "expansion" | "assumed-obligations";
export interface LintFinding { kind: LintKind; text: string; message: string }
/** What the repository holds: tracked files (git ls-files) and package.json script names. Absent: no existence checks are made. */
export interface Inventory { files: string[]; scripts: string[] }

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const Q = "`";
// Where an absolute path starts.
const START =
  String.raw`(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]` + // a drive: c:/ or C:\, not inside a word
  String.raw`|~[\\/]` + // the home folder: ~/ or ~\
  String.raw`|(?<![A-Za-z0-9./\\])[\\/](?=[^\s\\/"'${Q},;:<>|*?]+[\\/]))`; // a root slash followed by a folder and another slash
// An absolute path (drive, ~/ or a root slash then a folder): whole when quoted; bare, it may hold spaces and ends after a file
// extension (and any closing punctuation) or, with none, at white space. /compact, and/or and URLs are not absolute paths.
const ABS_PATH = new RegExp(
  `"${START}[^"\\r\\n]*"|'${START}[^'\\r\\n]*'|${Q}${START}[^${Q}\\r\\n]*${Q}` +
  `|${START}(?:[^\\r\\n"'${Q},;:<>|*?]*?\\.[A-Za-z0-9]{1,8}[.:!?)\\]]*(?=[\\s"'${Q},;)\\]]|$)|[^\\s"'${Q},;<>|*?]*)`,
  "g");
// A helper folder: an absolute path whose folders may hold spaces, or any non-blank run, ending in .entomatical/helpers/<id>.
const HELPER = new RegExp(
  `${START}(?:[^\\s\\\\/"'${Q}:]+(?: [^\\s\\\\/"'${Q}:]+)*[\\\\/])*?\\.entomatical[\\\\/]helpers[\\\\/][0-9a-f-]{8,}[^\\s${Q}'"]*` +
  `|[^\\s${Q}'"]*\\.entomatical[\\\\/]helpers[\\\\/][0-9a-f-]{8,}[^\\s${Q}'"]*`,
  "gi");
// A relative file reference: a path with an extension, optionally ./ or ../. Absolute paths are removed first (ABS_PATH); bare words and URLs are left alone.
const FILE_REF = /(?<![\w./:@-])(?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8}(?![\w/])/g;
const SCRIPT_REF = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?([a-z][\w:-]*)/g;
const BUILTIN = new Set(["install", "i", "ci", "add", "remove", "uninstall", "update", "publish", "exec", "init", "link", "pack", "audit", "outdated", "start", "test", "dlx", "x"]);

/** Findings on any text going to a helper or a session: references to missing files or scripts, and context that leaks from helper runs. */
export function lintText(text: string, inventory?: Inventory): LintFinding[] {
  const out: LintFinding[] = [];
  const seen = new Set<string>();
  const add = (f: LintFinding) => { const k = `${f.kind}:${f.text}`; if (!seen.has(k)) { seen.add(k); out.push(f); } };
  // Helper folders and git status leaked into drafts (b3f41ee9 wrote its own cwd; 4b72f847 carried it on). The user may mean them.
  for (const m of text.matchAll(HELPER))
    add({ kind: "helper-path", text: m[0], message: "Names an Entomatical helper folder, likely copied from a helper run. Keep it only if the task is about that folder." });
  for (const m of text.matchAll(/\b(?:on |at )?branch [\w./-]+,? (?:with )?(?:a )?clean (?:working )?tree\b|\bclean working tree\b|\bworking tree (?:is )?clean\b/gi))
    add({ kind: "git-status", text: m[0], message: "Reads like a git status line, possibly from a helper's own folder rather than from you." });
  if (!inventory) return out;
  const tracked = new Set(inventory.files.map((f) => f.replace(/\\/g, "/")));
  for (const m of text.replace(ABS_PATH, " ").matchAll(FILE_REF)) {
    const ref = m[0].replace(/^\.\//, "").replace(/\\/g, "/");
    if (!isPathLike(m[0]) || ref.startsWith("../")) continue;
    const known = tracked.has(ref) || [...tracked].some((f) => f.endsWith(`/${ref}`));
    if (!known) add({ kind: "not-tracked", text: m[0], message: "Not found in tracked files. Fine if the task creates it." });
  }
  const scripts = new Set(inventory.scripts);
  for (const m of text.matchAll(SCRIPT_REF)) {
    const name = m[1], explicitRun = /\srun\s/.test(m[0]);
    if (!explicitRun && BUILTIN.has(name)) { if (name === "test" && !scripts.has("test")) add({ kind: "not-script", text: m[0], message: "Not a declared package script." }); continue; }
    if (!scripts.has(name)) add({ kind: "not-script", text: m[0], message: "Not a declared package script." });
  }
  return out;
}

/** Findings on a proposal: lintText on it, how much longer it is than the draft, facts that repeat a source, and held-back obligations. */
export function lintProposal(draft: string, proposal: string, inventory?: Inventory, record?: TaskRecord): LintFinding[] {
  const out = lintText(proposal, inventory);
  // Advisory only, no fixed ratio is right (consensus item 11): flag a proposal three times the draft and over 1,500 characters.
  if (draft.trim() && proposal.length > 1500 && proposal.length >= 3 * draft.length)
    out.push({ kind: "expansion", text: `${draft.length} → ${proposal.length} characters`, message: `The proposal is ${(proposal.length / draft.length).toFixed(1)} times as long as the draft.` });
  if (record) {
    const sources = record.context.sources.map((s) => squash(s.content));
    for (const f of record.context.facts) {
      const t = squash(f.text);
      if (t.length >= 40 && sources.some((s) => s.includes(t))) out.push({ kind: "source-duplicate", text: f.text, message: "This fact repeats pasted source material word for word." });
    }
    const held = quarantined(record);
    if (held.length) out.push({ kind: "assumed-obligations", text: String(held.length), message: `${held.length} obligation${held.length === 1 ? "" : "s"} the model assumed ${held.length === 1 ? "was" : "were"} held out of the prompt.` });
  }
  return out;
}
