#!/usr/bin/env node
"use strict";
// One-time move of the board's saved state from the product's earlier lower-case identifier to "entomatical" (the user,
// 18 November 2026: "change absolutely everything"). Run once per machine with every editor window and session closed.
// A dry run unless --apply. What the user does, in order: docs/plans/2026-11-18-identifier-cutover.md.
//
//   node tools/cutover-entomatical.js [--apply] [--summary] [--drop-old-builds] [--home DIR] [--workspace DIR ...]
//        [--vscodium-user DIR] [--claude DIR ...] [--codex DIR] [--agy DIR] [--grok DIR] [--text FILE ...] [--state DIR]
//        [--force-preflight]
//   node tools/cutover-entomatical.js --rollback <state>/<run>/journal.jsonl
//
// Rules learned in the 17 November folder rename (byte rewrites corrupted SQLite files, shifted the byte offsets the call
// ledger holds into transcripts, split hard links, missed symlinks): rewrite TEXT files only (no NUL byte, no SQLite
// header), change databases through SQL on TEXT values only, write hard-linked files in place, never rewrite a transcript,
// re-point symlinks, back up every changed file first, journal every action so --rollback can undo it.
// The earlier identifier is built from parts so the repository-wide rename tool leaves this file working.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const OLD = ["agent", "board"].join("");
const NEW = "entomatical";
const OLD_UP = OLD.toUpperCase();
const NEW_UP = NEW.toUpperCase();
const PUBLISHER = "example-publisher";
const SECRET = /^auth|credential|oauth|secret|[-_.]token$|^token$/i; // credential files are never read
const MAX_BYTES = 20 * 1024 * 1024;
const OLD_BUILDS = "old build backups: contents left as they were";
// Historical alpha data is outside the main build's identifier migration; leave its names, paths and database rows intact.
const ALPHA = `${OLD}-alpha`;
const ALPHA_ONE = new RegExp(`${ALPHA}(?![A-Za-z0-9_])`);

// ---------- small helpers ----------
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const isFile = (p) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } };
/** The path to use now: the old one until it has been renamed. */
const pick = (oldPath, newPath) => (exists(oldPath) ? oldPath : newPath);
function* entries(dir) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of list) yield [path.join(dir, e.name), e];
}
const binary = (buf) => buf.includes(0) || buf.subarray(0, 15).toString("latin1") === "SQLite format 3";
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const W = "A-Za-z0-9_";
const enc = (p) => p.replace(/[^A-Za-z0-9]/g, "-"); // how Claude names a projects folder after a cwd
const isBoardName = (n) => n.startsWith(`.${OLD}`) || n.startsWith(`.${NEW}`);
/** Folders never entered: a board's worktrees (their own checkouts), node_modules, git object stores. */
const alwaysSkip = (p, e) => e.name === "node_modules" || (e.name === "objects" && path.basename(path.dirname(p)) === ".git")
  || (e.name === "wt" && isBoardName(path.basename(path.dirname(p))));
const oldBuildCache = new Map();
/** A copy of an old extension build: its package.json (or extension/package.json) names the old extension. */
function isOldBuild(dir) {
  if (oldBuildCache.has(dir)) return oldBuildCache.get(dir);
  let yes = false;
  for (const f of [path.join(dir, "package.json"), path.join(dir, "extension", "package.json")]) {
    try { const p = JSON.parse(fs.readFileSync(f, "utf8")); if (p.name === OLD && p.publisher === PUBLISHER) yes = true; } catch { /* none */ }
  }
  oldBuildCache.set(dir, yes);
  return yes;
}

// ---------- names ----------
const NAME_RE = new RegExp(`^(\\.?)(${OLD}|${OLD_UP})(?![A-Za-z0-9])`);
const PUB_RE = new RegExp(`^${esc(PUBLISHER)}\\.${OLD}(?![${W}])`);
/** A file or folder name that starts with the old name (dot folder, helper, tool and test folders, marker, extension id). */
function renameName(name) {
  if (ALPHA_ONE.test(name)) return name; // the alpha build's own folders and files
  if (PUB_RE.test(name)) return name.replace(PUB_RE, `${PUBLISHER}.${NEW}`);
  return encodedName(name.replace(NAME_RE, (_m, dot, w) => dot + (w === OLD ? NEW : NEW_UP)));
}
const ENC_RE = new RegExp(`--(?:${OLD}|${NEW})(?![A-Za-z0-9])([A-Za-z0-9-]*)`, "g");
/** A name that encodes a path through a board folder, as Claude names projects and scratch folders after a cwd. */
const encodedName = (s) => s.replace(ENC_RE, (_m, rest) => `--${NEW}${rest.replace(new RegExp(`-${OLD}(?![A-Za-z0-9])`, "g"), `-${NEW}`)}`);
/** The rest of a path after a board folder: rename segments as the folders are renamed; stop inside a worktree or an old build. */
function fixTail(tail) {
  const parts = tail.split(/([\\/]+)/);
  for (let i = 0; i < parts.length; i += 2) {
    const prev = parts[i - 2];
    parts[i] = renameName(parts[i]);
    if (prev === "wt" || prev === "extension-backups" || parts[i].startsWith(`${PUBLISHER}.`)) break;
  }
  return parts.join("");
}

// ---------- text: path-shaped and key-shaped occurrences only, never the bare word ----------
const SEG = `[^\\s"'\`<>|,;:()\\[\\]{}*?\\\\/]+`;
/** The alpha build's name and the rest of a path after it: hidden from every rule (see ALPHA). */
const ALPHA_RE = new RegExp(`${ALPHA}(?![A-Za-z0-9_])(?:[\\\\/]+${SEG})*`, "g");
/**
 * path: a board dot folder (any parent: home, a workspace, a nested test board) and the renamed names after it.
 * encoded: the same inside a Claude projects folder name. keys: extension id, view container, settings/command/view
 * prefix, env-var prefix, wrapper name, temp-root marker. Text inside the given roots' own paths is never changed, so a
 * root that itself sits under an old-named folder (a test fixture) stays valid.
 */
function patterns(home, workspaces) {
  // Windows writes one folder with either case of its drive letter (git prints C:/, a temp folder may be c:\), so both are shielded.
  const drive = (r) => (/^[A-Za-z]:/.test(r) ? [r[0].toUpperCase() + r.slice(1), r[0].toLowerCase() + r.slice(1)] : [r]);
  const roots = [home, ...workspaces].flatMap(drive).flatMap((r) => [r, r.replace(/\\/g, "/"), r.replace(/\\/g, "\\\\"), enc(r)]);
  const shielded = [...new Set(roots)].filter((r) => r.toLowerCase().includes(OLD)).sort((a, b) => b.length - a.length);
  // Both patterns also match the new name, so a path already moved consumes its tail the same way: a second run changes nothing,
  // and an old name inside a worktree (left on purpose) is never taken for a fresh match.
  const pathPat = { re: new RegExp(`(^|[\\s\`"'(=\\\\/])\\.(?:${OLD}|${NEW})(?![${W}])([-.${W}]*)((?:[\\\\/]+${SEG})*)`, "g"), to: (_m, pre, rest = "", tail = "") => `${pre}.${NEW}${rest}${fixTail(tail)}` };
  const encPat = { re: ENC_RE, to: (m) => encodedName(m) };
  // A decoded executable or event-file path is one value. Its later components can contain
  // spaces (or punctuation) that would end a path match in ordinary prose.
  const terminalPath = { re: new RegExp(`(^|[\\\\/])\\.(?:${OLD}|${NEW})(-speech)?([\\\\/].*)?$`, "s"), to: pathPat.to };
  const ids = [
    { re: new RegExp(`${esc(PUBLISHER)}\\.${OLD}(?![${W}])`, "g"), to: `${PUBLISHER}.${NEW}` },
    { re: new RegExp(`(?<=extension\\.)${OLD}(?![${W}])`, "g"), to: NEW },
    { re: new RegExp(`(?<![${W}.-])${OLD}\\.(?=[A-Za-z])`, "g"), to: `${NEW}.` },
  ];
  const keys = [...ids,
    { re: new RegExp(`(?<![${W}])${OLD_UP}_`, "g"), to: `${NEW_UP}_` },
    { re: new RegExp(`(?<![${W}])${OLD}-claude(?![${W}])`, "g"), to: `${NEW}-claude` },
    { re: new RegExp(`(?<![${W}])${OLD_UP}-TEMP-ROOT`, "g"), to: `${NEW_UP}-TEMP-ROOT` },
  ];
  const sets = { path: [pathPat], terminalPath: [terminalPath], encoded: [encPat], ids, all: [pathPat, ...keys], ledger: [pathPat, encPat, ...keys] };
  const shield = (text) => {
    const saved = [];
    for (const r of shielded) if (text.includes(r)) text = text.split(r).join(`\0${saved.push(r) - 1}\0`);
    if (text.includes(ALPHA)) text = text.replace(ALPHA_RE, (m) => `\0${saved.push(m) - 1}\0`);
    // An alpha path may itself hold a shielded root, so put the saved text back until no marker is left.
    const back = (t) => { for (let i = 0; i < 3 && /\0\d+\0/.test(t); i++) t = t.replace(/\0(\d+)\0/g, (_m, n) => saved[n]); return t; };
    return { text, back: (t) => (saved.length ? back(t) : t) };
  };
  const apply = (text, which) => {
    const s = shield(text);
    let t = s.text;
    let n = 0;
    for (const p of sets[which]) t = t.replace(p.re, (...a) => { const r = typeof p.to === "function" ? p.to(...a) : p.to; if (r !== a[0]) n++; return r; });
    return { text: s.back(t), n };
  };
  /** A leftover is text the rule would still change. */
  const has = (text, which) => apply(text, which).n > 0;
  const name = (n) => shield(n).text.toLowerCase().includes(OLD);
  const rename = (n) => { const s = shield(n); return s.back(renameName(s.text)); };
  return { apply, has, name, rename, shielded };
}

// ---------- one run: dry or applied, journaled ----------
class Run {
  constructor(o, apply, quiet) {
    Object.assign(this, { o, apply, quiet, lines: [], actions: 0, collisions: [], problems: [], dir: undefined, journal: undefined,
      step: "", counts: {}, skipped: [], names: new Map(), after: new Map(), links: new Map(), dropped: new Set(), dbs: new Set(),
      editorFiles: new Set(), editorConflicts: [] });
  }
  say(s) { this.lines.push(s); if (!this.quiet) this.o.log(s); }
  act(s) { this.actions++; this.counts[this.step] = (this.counts[this.step] ?? 0) + 1; this.say(this.apply ? s : `would ${s}`); }
  runDir() {
    if (!this.dir) {
      this.dir = path.join(this.o.state, new Date().toISOString().replace(/[:.]/g, "-"));
      fs.mkdirSync(this.dir, { recursive: true });
      this.journal = path.join(this.dir, "journal.jsonl");
    }
    return this.dir;
  }
  record(entry) { this.runDir(); fs.appendFileSync(this.journal, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"); }
  /** Text backups and database backups live in separate trees: the audit requires the text tree to hold no binary file. */
  backup(kind, file) {
    const rel = path.resolve(file).replace(/^([A-Za-z]):/, "$1").replace(/^[\\/]+/, "");
    const dest = path.join(this.runDir(), "backup", kind, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    return dest;
  }
}

function rename(run, from, to) {
  if (!exists(from)) return false;
  if (exists(to)) {
    run.collisions.push(`${from} and ${to} both exist: combine them by hand first (this script never merges two folders or files)`);
    run.say(`skip: ${to} already exists beside ${from}`);
    return false;
  }
  if (run.apply) fs.renameSync(from, to); // before it is counted: a rename the system refuses is no action
  run.act(`rename ${from} -> ${to}`);
  run.names.set(from, path.basename(to));
  if (run.apply) run.record({ op: "rename", from, to });
  return true;
}

/** Renames every entry under dir whose name starts with the old name, deepest first. Old builds: their own name only. */
function renameTree(run, P, dir, skip) {
  for (const [p, e] of entries(dir)) {
    if (e.isDirectory() && !alwaysSkip(p, e) && !skip(p, e) && !isOldBuild(p)) renameTree(run, P, p, skip);
    const n = P.rename(e.name);
    if (n !== e.name) rename(run, p, path.join(dir, n));
  }
}

/** The text rule: text files only, back up first, keep hard links, re-stat before writing and retry once. */
function rewrite(run, file, transform) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let st;
    try { st = fs.lstatSync(file); } catch { return false; }
    if (!st.isFile() || SECRET.test(path.basename(file))) return false;
    if (st.size > MAX_BYTES) { run.skipped.push(file); run.say(`skip (over 20 MB): ${file}`); return false; }
    const buf = fs.readFileSync(file);
    if (binary(buf)) return false;
    const text = buf.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(buf)) { run.say(`skip (not UTF-8): ${file}`); return false; }
    const { text: next, n } = transform(text);
    if (next === text) return false;
    const what = `rewrite ${file} (${n} change${n === 1 ? "" : "s"})`;
    if (!run.apply) { run.after.set(file, next); run.act(what); return true; }
    const backup = run.backup("text", file);
    const now = fs.lstatSync(file);
    if (now.mtimeMs !== st.mtimeMs || now.size !== st.size || now.ino !== st.ino) { run.say(`changed while reading, reading again: ${file}`); continue; }
    if (st.nlink > 1) fs.writeFileSync(file, next); // the same inode, so every hard link sees the change
    else {
      const tmp = `${file}.${NEW}-cutover-tmp`;
      fs.writeFileSync(tmp, next);
      fs.chmodSync(tmp, st.mode & 0o7777);
      fs.renameSync(tmp, file);
    }
    run.act(what);
    run.record({ op: "write", path: file, backup, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs });
    return true;
  }
  run.problems.push(`${file} kept changing while being read; left as it was`);
  return false;
}
const tx = (P, which) => (text) => P.apply(text, which);

/** A link to target. Windows makes a symbolic link only with a privilege an ordinary account lacks; a junction needs none. */
function makeLink(target, link) {
  try { fs.symlinkSync(target, link); }
  catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    fs.symlinkSync(target, link, "junction");
  }
}

function relink(run, link, P) {
  let target;
  try { target = fs.readlinkSync(link); } catch { return; }
  const next = P.apply(target, "path").text;
  if (next === target) return;
  run.act(`re-point ${link}: ${target} -> ${next}`);
  run.links.set(link, next);
  if (run.apply) { fs.unlinkSync(link); makeLink(next, link); run.record({ op: "link", path: link, from: target, to: next }); }
}

/** Text rule on every file under dir, re-pointing symlinks. */
function rewriteTree(run, P, dir, which, skip) {
  for (const [p, e] of entries(dir)) {
    if (e.isDirectory()) { if (!alwaysSkip(p, e) && !skip(p, e) && !isOldBuild(p)) rewriteTree(run, P, p, which, skip); }
    else if (e.isSymbolicLink()) relink(run, p, P);
    else if (e.isFile()) rewrite(run, p, tx(P, which));
  }
}

/** Databases: SQL only. edit(db, write) returns the changes; computed read-only first so an unchanged database is never opened for writing. */
function sqlEdit(run, file, edit) {
  if (!isFile(file)) return;
  const { DatabaseSync } = require("node:sqlite");
  const url = pathToFileURL(file);
  url.search = "?immutable=1"; // reads without creating -wal/-shm files, so a dry run changes nothing
  const ro = new DatabaseSync(url, { readOnly: true });
  let changes;
  try { changes = edit(ro, false); } finally { ro.close(); }
  const wal = isFile(`${file}-wal`);
  if (!changes.length && !wal) return;
  if (!run.apply) { if (changes.length) { run.dbs.add(file); run.act(`update ${file}: ${changes.join("; ")}`); } return; }
  const backups = ["", "-wal", "-shm", "-journal"].map((s) => file + s).map((f) => ({ file: f, backup: isFile(f) ? run.backup("db", f) : null }));
  const db = new DatabaseSync(file);
  try {
    db.exec("BEGIN IMMEDIATE");
    changes = edit(db, true);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  } finally { db.close(); }
  if (!changes.length) return;
  run.act(`update ${file}: ${changes.join("; ")}`);
  run.record({ op: "db", path: file, backups });
}

// ---------- steps ----------
const homeBoard = (o) => pick(path.join(o.home, `.${OLD}`), path.join(o.home, `.${NEW}`));
const homeSkip = (board) => (p) => p === path.join(board, "speech") || p === path.join(board, "extension-backups");

function stepHome(run, P) {
  const { home } = run.o;
  const oldDir = path.join(home, `.${OLD}`);
  const newDir = path.join(home, `.${NEW}`);
  // The retired speech edition's home folder: its name only. On Windows it also holds the Whisper runtime and models the
  // speech settings name by full path, and the text rule moves those settings to the new name, so the folder must follow.
  rename(run, path.join(home, `.${OLD}-speech`), path.join(home, `.${NEW}-speech`));
  if (!exists(oldDir) && !exists(newDir)) return run.say(`home: no ${oldDir}; skipped`);
  rename(run, oldDir, newDir);
  const dir = pick(oldDir, newDir);
  renameTree(run, P, dir, homeSkip(dir));
  const backups = path.join(dir, "extension-backups");
  for (const [p, e] of entries(backups)) {
    if (!e.isDirectory()) continue;
    if (run.o.dropOldBuilds) {
      run.act(`delete old build ${p} (cannot be undone)`);
      run.dropped.add(p);
      if (run.apply) { fs.rmSync(p, { recursive: true, force: true }); run.record({ op: "drop", path: p, note: "deleted; --rollback cannot restore it" }); }
    } else if (renameName(e.name) !== e.name) rename(run, p, path.join(backups, renameName(e.name)));
  }
  rewriteTree(run, P, dir, "ledger", homeSkip(dir));
}

function verifyWorktrees(run, ws) {
  const r = spawnSync("git", ["-C", ws, "worktree", "list", "--porcelain"], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return run.problems.push(`git worktree list failed in ${ws}: ${(r.stderr || "").trim()}`);
  const prunable = r.stdout.split("\n\n").filter((b) => /^prunable/m.test(b));
  if (prunable.length) run.problems.push(`git worktree list in ${ws} shows prunable worktrees:\n${prunable.join("\n")}`);
  else run.say(`git worktree list in ${ws}: ${r.stdout.split("\n\n").filter(Boolean).length} worktrees, none prunable`);
}

/** The board folder and the retired speech edition's folder of one workspace. */
function stepWorkspace(run, P, ws) {
  let found = false;
  const stuck = []; // board folders the system refused to rename: nothing in them, or pointing into them, is changed
  const norm = (s) => s.replace(/\\/g, "/").toLowerCase();
  for (const [oldName, newName] of [[`.${OLD}`, `.${NEW}`], [`.${OLD}-speech`, `.${NEW}-speech`]]) {
    const oldBoard = path.join(ws, oldName);
    const newBoard = path.join(ws, newName);
    if (!exists(oldBoard) && !exists(newBoard)) continue;
    found = true;
    try { rename(run, oldBoard, newBoard); }
    catch (error) {
      // Windows refuses to rename a folder while a program runs inside it or holds one of its files open (18 November 2026:
      // a job started from a card was still running in a worktree, and the whole run stopped there).
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      run.problems.push(`${oldBoard} is in use by a running program, so it was left as it was: close that program and run this again`);
      stuck.push(oldBoard);
      continue;
    }
    const board = pick(oldBoard, newBoard);
    renameTree(run, P, board, () => false); // nested board folders and old-named tool/test folders too, except inside wt/
    for (const [p, e] of entries(path.join(board, "wt"))) {
      if (!e.isDirectory()) continue;
      for (const [q, f] of entries(p)) {
        if (f.name === ".git" && f.isFile()) rewrite(run, q, tx(P, "path"));
        else if (f.isSymbolicLink()) relink(run, q, P);
      }
    }
    const tmp = path.join(board, "tmp");
    for (const [p, e] of entries(tmp)) if (e.isFile() && /-TEMP-ROOT$/.test(e.name)) rewrite(run, p, tx(P, "all"));
    const links = (d) => { for (const [p, e] of entries(d)) { if (e.isSymbolicLink()) relink(run, p, P); else if (e.isDirectory() && !alwaysSkip(p, e)) links(p); } };
    links(tmp); // tmp/ contents are renamed but not rewritten; their symlinks follow the renamed folders
    rewriteTree(run, P, board, "all", (p) => p === tmp);
  }
  const gitWorktrees = path.join(ws, ".git", "worktrees");
  const pointsIntoStuck = (text) => stuck.some((b) => norm(text).includes(`${norm(b)}/`));
  for (const [p, e] of entries(gitWorktrees)) {
    if (e.isDirectory()) rewrite(run, path.join(p, "gitdir"), (t) => (pointsIntoStuck(t) ? { text: t, n: 0 } : P.apply(t, "path")));
  }
  if (run.apply && exists(gitWorktrees)) verifyWorktrees(run, ws);
  if (!found) run.say(`workspace ${ws}: no board folder; skipped`);
}

function renameJsonKeys(run, file, value) {
  let obj;
  try { obj = JSON.parse(value); } catch { return value; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return value;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    const nk = k.startsWith(`${OLD}.`) ? NEW + k.slice(OLD.length) : k;
    if (nk !== k && nk in obj) { run.collisions.push(`${file}: the extension state has both ${k} and ${nk}`); out[k] = v; continue; }
    if (nk !== k) n++;
    out[nk] = v;
  }
  return n ? JSON.stringify(out) : value;
}

function vscdb(run, P, file) {
  sqlEdit(run, file, (db, write) => {
    const changes = [];
    let rows;
    try {
      rows = db.prepare("SELECT key, typeof(value) AS t, CASE WHEN typeof(value) = 'text' THEN value END AS v FROM ItemTable WHERE instr(key, ?) > 0").all(OLD);
    } catch { return changes; } // no ItemTable
    const has = db.prepare("SELECT 1 FROM ItemTable WHERE key = ?");
    for (const r of rows) {
      if (ALPHA_ONE.test(r.key)) continue; // the alpha build's own rows (its saved state, view state and secrets)
      const key = P.apply(r.key, "ids").text;
      if (key === r.key) continue;
      if (has.get(key)) { run.collisions.push(`${file} has both ${r.key} and ${key}`); continue; }
      let v = r.v;
      if (r.t === "text") v = key === `${PUBLISHER}.${NEW}` ? renameJsonKeys(run, file, r.v) : P.apply(r.v, "ids").text;
      changes.push(`key ${r.key} -> ${key}${v !== r.v ? " and its text value" : ""}`);
      if (!write) continue;
      db.prepare("UPDATE ItemTable SET key = ? WHERE key = ?").run(key, r.key);
      if (r.t === "text" && v !== r.v) db.prepare("UPDATE ItemTable SET value = ? WHERE key = ? AND typeof(value) = 'text'").run(v, key);
    }
    return changes;
  });
}

const profilesOf = (user) => [user, ...[...entries(path.join(user, "profiles"))].filter(([, e]) => e.isDirectory()).map(([p]) => p)];
const boardPathVariables = new Set(["EVENTS", "REPO", "LEDGER_DIR", "METRICS_DIR", "USAGE_DIR"].map((name) => `${NEW_UP}_${name}`));

// Only these editor fields contain settings, paths or identifiers. Other objects (for example
// files.associations and keybinding args) are user data, even when their keys look like ours.
function editorField(scope, key) {
  if (scope === "workspace" && ["settings", "folders", "extensions"].includes(key)) return key;
  if (scope === "settings" && /^(?:\[[^\[\]]+\])+$/.test(key)) return "override";
  if (scope === "settings" || scope === "override") {
    if (/^terminal\.integrated\.env\.(linux|osx|windows)$/.test(key)) return "environment";
    if (/^terminal\.integrated\.profiles\.(linux|osx|windows)$/.test(key)) return "terminalProfiles";
    if (/^terminal\.integrated\.automationProfile\.(linux|osx|windows)$/.test(key)) return "terminalProfile";
    if (key === "claudeCode.claudeProcessWrapper") return "all";
    if (key === "editor.defaultFormatter") return "ids";
    if (/(?:^|\.)(?:path|folder|cwd)$|(?:Path|Folder|Cwd)$/.test(key)) return "path";
  }
  if (scope === "terminalProfiles") return "terminalProfile"; // the property name is the user's profile label
  if (scope === "terminalProfile" && key === "path") return "terminalExecutable";
  if (scope === "terminalProfile" && key === "env") return "environment";
  // The board reads these environment variables as paths. Other values can hold arbitrary
  // literals or shell text, including examples of the very same paths.
  if (scope === "environment" && boardPathVariables.has(key)) return "terminalPath";
  if (scope === "folder" && (key === "path" || key === "uri")) return "path";
  if (scope === "extensions" && (key === "recommendations" || key === "unwantedRecommendations")) return "extensionList";
  if (scope === "binding" && (key === "command" || key === "when")) return key;
}

// JSON.parse discards duplicate keys and comments. Walk the JSONC tokens instead, keeping one
// set of destination keys per object and copying the original bytes between edited strings.
function editorJson(P, file, text) {
  const tokens = text.matchAll(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\x00-\x1f]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[^\s]/g);
  const conflicts = [];
  const output = [];
  let token, offset, copied = 0, n = 0;
  function next() {
    let match;
    do { match = tokens.next().value; } while (match && (match[0].startsWith("//") || match[0].startsWith("/*")));
    token = match?.[0];
    offset = match?.index ?? text.length;
  }
  function invalid() { throw new SyntaxError(file + ": invalid editor JSONC at offset " + offset); }
  function editString(scope) {
    let value;
    try { value = JSON.parse(token); } catch { invalid(); }
    let dest = value;
    if ((scope === "settingKey" || scope === "command") && value.startsWith(OLD + ".")) dest = NEW + value.slice(OLD.length);
    else if (scope === "command" && value.startsWith("-" + OLD + ".")) dest = "-" + NEW + value.slice(OLD.length + 1);
    else if (scope === "envKey" && value.startsWith(OLD_UP + "_")) dest = NEW_UP + value.slice(OLD_UP.length);
    else if (scope === "when") dest = P.apply(value, "ids").text;
    else if (scope === "terminalExecutable" || scope === "terminalPath") dest = P.apply(value, "terminalPath").text;
    else if (scope === "path" || scope === "all" || scope === "ids") dest = P.apply(value, scope).text;
    if (dest !== value) {
      output.push(text.slice(copied, offset), JSON.stringify(dest));
      copied = offset + token.length;
      n++;
    }
    next();
    return [value, dest];
  }
  function value(scope) {
    if (token === "{" || token === "[") {
      const object = token === "{";
      const end = object ? "}" : "]";
      let keyRule;
      if (scope === "settings" || scope === "override") keyRule = "settingKey";
      if (scope === "environment") keyRule = "envKey";
      const keys = keyRule && new Map();
      next();
      while (token !== end) {
        let child;
        if (object) {
          if (!token?.startsWith('"')) invalid();
          const [original, dest] = editString(keyRule);
          const previous = keys?.get(dest);
          if (previous !== undefined && (previous !== dest || original !== dest)) {
            const source = original === dest ? previous : original;
            conflicts.push(`${file}: conflicting editor keys: renaming ${JSON.stringify(source)} would duplicate ${JSON.stringify(dest)} in this object`);
          }
          keys?.set(dest, original);
          child = editorField(scope, dest);
          if (token !== ":") invalid();
          next();
        } else if (scope === "bindings") child = "binding";
        else if (scope === "folders") child = "folder";
        else if (scope === "extensionList") child = "ids";
        else if (scope === "terminalExecutable") child = "terminalPath"; // executable fallback paths
        value(child);
        if (token !== ",") break;
        next();
      }
      if (token !== end) invalid();
    } else if (token?.startsWith('"')) {
      editString(scope);
      return;
    } else if (!/^(?:true|false|null|-?\d)/.test(token)) invalid();
    next();
  }
  next();
  if (token !== undefined) {
    const root = file.endsWith(".code-workspace") ? "workspace" : path.basename(file) === "keybindings.json" ? "bindings" : "settings";
    value(root);
  }
  if (token !== undefined) invalid();
  return { text: n ? output.join("") + text.slice(copied) : text, n, conflicts };
}

function rewriteEditor(run, P, file) {
  run.editorFiles.add(file);
  rewrite(run, file, (text) => {
    const result = editorJson(P, file, text);
    if (run.apply && result.conflicts.length) throw new Error(result.conflicts.join("\n"));
    for (const conflict of result.conflicts) run.editorConflicts.push(conflict);
    return result;
  });
}

function stepVscodium(run, P) {
  for (const ws of run.o.workspaces) {
    for (const [p, e] of entries(ws)) if (e.isFile() && e.name.endsWith(".code-workspace")) rewriteEditor(run, P, p);
    rewriteEditor(run, P, path.join(ws, ".vscode", "settings.json"));
  }
  const user = run.o.vscodiumUser;
  if (!exists(user)) return run.say(`VSCodium: no ${user}; skipped`);
  const extOld = `${PUBLISHER}.${OLD}`;
  const extNew = `${PUBLISHER}.${NEW}`;
  for (const prof of profilesOf(user)) {
    for (const f of ["settings.json", "keybindings.json"]) rewriteEditor(run, P, path.join(prof, f));
    const gs = path.join(prof, "globalStorage");
    rename(run, path.join(gs, extOld), path.join(gs, extNew));
    vscdb(run, P, path.join(gs, "state.vscdb"));
  }
  for (const [p, e] of entries(path.join(user, "workspaceStorage"))) {
    if (!e.isDirectory()) continue;
    rename(run, path.join(p, extOld), path.join(p, extNew));
    vscdb(run, P, path.join(p, "state.vscdb"));
  }
}

/** .claude.json: rename project KEYS only, keep order and indentation. */
function projectKeys(run, P, file, text) {
  let obj;
  try { obj = JSON.parse(text); } catch { return { text, n: 0 }; }
  if (!obj || !obj.projects || typeof obj.projects !== "object") return { text, n: 0 };
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj.projects)) {
    const nk = P.apply(k, "path").text;
    if (nk !== k && nk in obj.projects) { run.collisions.push(`${file} has projects ${k} and ${nk}`); out[k] = v; continue; }
    if (nk !== k) n++;
    out[nk] = v;
  }
  if (!n) return { text, n };
  obj.projects = out;
  const indent = (/^\{\r?\n([ \t]+)"/.exec(text) || [])[1] ?? 0;
  return { text: JSON.stringify(obj, null, indent) + (text.endsWith("\n") ? "\n" : ""), n };
}

/** history.jsonl: the "project" value of each line only; every other byte, and any line that does not parse, stays. */
function historyProjects(P, text) {
  let n = 0;
  const lines = text.split("\n").map((line) => {
    let obj;
    try { obj = JSON.parse(line); } catch { return line; }
    if (!obj || typeof obj.project !== "string") return line;
    const next = P.apply(obj.project, "path").text;
    if (next === obj.project) return line;
    for (const sep of [":", ": "]) {
      const from = `"project"${sep}${JSON.stringify(obj.project)}`;
      if (line.includes(from)) { n++; return line.split(from).join(`"project"${sep}${JSON.stringify(next)}`); }
    }
    return line;
  });
  return { text: lines.join("\n"), n };
}

function stepClaude(run, P) {
  for (const dir of run.o.claude) {
    if (!exists(dir)) { run.say(`Claude: no ${dir}; skipped`); continue; }
    const projects = path.join(dir, "projects");
    for (const [p, e] of entries(projects)) {
      if (!e.isDirectory()) continue;
      const name = P.apply(e.name, "encoded").text; // folder rename only: the call ledger holds byte offsets into the transcripts
      if (name !== e.name) rename(run, p, path.join(projects, name));
    }
    const configs = [path.join(dir, ".claude.json")];
    if (path.basename(dir) === ".claude") configs.push(path.join(path.dirname(dir), ".claude.json"));
    for (const c of configs) rewrite(run, c, (t) => { const k = projectKeys(run, P, c, t); const v = P.apply(k.text, "path"); return { text: v.text, n: k.n + v.n }; });
    rewrite(run, path.join(dir, "history.jsonl"), (t) => historyProjects(P, t));
  }
}

function stepCodex(run, P) {
  const dir = run.o.codex;
  if (!exists(dir)) return run.say(`Codex: no ${dir}; skipped`);
  for (const [file, e] of entries(dir)) {
    if (!e.isFile() || !/^state_.*\.sqlite$/.test(e.name)) continue;
    sqlEdit(run, file, (db, write) => {
      const changes = [];
      const cols = db.prepare("SELECT name, type FROM pragma_table_info('threads')").all().filter((c) => /TEXT/i.test(c.type)).map((c) => c.name);
      for (const col of cols) {
        const q = `"${col.replace(/"/g, '""')}"`;
        let n = 0;
        for (const r of db.prepare(`SELECT rowid AS id, ${q} AS v FROM threads WHERE typeof(${q}) = 'text' AND instr(${q}, ?) > 0`).all(`.${OLD}`)) {
          const v = P.apply(r.v, "path").text;
          if (v === r.v) continue;
          n++;
          if (write) db.prepare(`UPDATE threads SET ${q} = ? WHERE rowid = ?`).run(v, r.id);
        }
        if (n) changes.push(`threads.${col} in ${n} row${n === 1 ? "" : "s"}`);
      }
      return changes;
    });
  }
  run.say("Codex: rollout files left alone. Codex will ask once to approve the board's hook again (its approval is tied to the hook's path).");
}

function stepOthers(run, P) {
  for (const [name, dir] of [["Antigravity", run.o.agy], ["Grok", run.o.grok]]) {
    if (!exists(dir)) { run.say(`${name}: no ${dir}; skipped`); continue; }
    for (const [p, e] of entries(dir)) if (e.isFile() && e.name.endsWith(".json")) rewrite(run, p, tx(P, "path"));
    run.say(`${name}: only top-level JSON settings in ${dir} were checked; its databases, other files and subfolders were left alone`);
  }
}

function stepText(run, P) {
  for (const f of run.o.text) {
    if (run.editorFiles.has(f)) continue;
    if (!rewrite(run, f, tx(P, "all")) && !isFile(f)) run.say(`text: no ${f}; skipped`);
  }
}

const STEPS = [["home folder", (r, P) => stepHome(r, P)], ["workspaces", (r, P) => { for (const ws of r.o.workspaces) stepWorkspace(r, P, ws); }],
  ["VSCodium", stepVscodium], ["Claude", stepClaude], ["Codex", stepCodex], ["Antigravity and Grok", stepOthers], ["text files", stepText]];
function steps(run, P) { for (const [name, fn] of STEPS) { run.step = name; fn(run, P); } }

// ---------- audit: what is left after the plan (a dry run predicts it from the planned actions) ----------
function audit(run, P) {
  const o = run.o;
  const left = [];
  let fixed = 0;
  const skipped = { big: 0, speech: 0 };
  const seen = new Set();
  const area = (p) => {
    const rel = (root, label) => { const r = path.relative(root, p); return r && !r.startsWith("..") && !path.isAbsolute(r) ? `${label}${path.sep}${r.split(path.sep)[0]}` : null; };
    const both = (dir, b) => rel(path.join(dir, b), path.join(dir, b.replace(OLD, NEW))) ?? rel(path.join(dir, b.replace(OLD, NEW)), path.join(dir, b.replace(OLD, NEW)));
    for (const ws of o.workspaces) for (const b of [`.${OLD}`, `.${OLD}-speech`]) { const a = both(ws, b); if (a) return a; }
    return both(o.home, `.${OLD}`) ?? rel(o.vscodiumUser, o.vscodiumUser)
      ?? o.claude.map((c) => rel(c, c)).find(Boolean) ?? path.dirname(p);
  };
  const note = (raw, after, reason, p) => { if (after) left.push({ reason, path: p }); else if (raw) fixed++; };
  const name = (p, e, reason) => {
    const after = run.dropped.has(p) ? null : run.names.get(p) ?? e.name;
    note(P.name(e.name), after !== null && P.name(after), reason ?? `names (${area(p)})`, p);
    if (e.isSymbolicLink()) {
      let t = "";
      try { t = fs.readlinkSync(p); } catch { /* gone */ }
      note(P.has(t, "path"), P.has(run.links.get(p) ?? t, "path"), `symlinks (${area(p)})`, p);
    }
  };
  const content = (p, which, reason) => {
    if (seen.has(p) || SECRET.test(path.basename(p))) return;
    seen.add(p);
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (!st.isFile()) return;
    if (st.size > MAX_BYTES) { skipped.big++; return; }
    const buf = fs.readFileSync(p);
    if (binary(buf)) return;
    const text = buf.toString("utf8");
    const has = run.editorFiles.has(p) ? (t) => editorJson(P, p, t).n > 0 : (t) => P.has(t, which);
    const raw = has(text);
    note(raw, run.after.has(p) ? has(run.after.get(p)) : raw, reason ?? `text (${area(p)})`, p);
  };
  const tree = (dir, which, skip = () => false) => {
    for (const [p, e] of entries(dir)) {
      if (run.dropped.has(p)) { fixed++; continue; }
      name(p, e);
      if (e.isDirectory()) {
        if (isOldBuild(p) || path.dirname(p) === path.join(hb, "extension-backups")) left.push({ reason: OLD_BUILDS, path: path.join(path.dirname(p), run.names.get(p) ?? e.name) });
        else if (!alwaysSkip(p, e) && !skip(p, e)) tree(p, which, skip);
      } else if (e.isFile()) content(p, which);
    }
  };
  const hb = homeBoard(o);
  note(hb.endsWith(`.${OLD}`), hb.endsWith(`.${OLD}`) && !run.names.has(hb), "names (home folder)", hb);
  tree(hb, "ledger", (p) => {
    if (p === path.join(hb, "speech")) { skipped.speech++; return true; }
    return false;
  });
  for (const ws of o.workspaces) {
    for (const b of [`.${OLD}`, `.${OLD}-speech`]) {
      const board = path.join(ws, b);
      if (exists(board)) note(true, !run.names.has(board), `names (${ws})`, board);
      const cur = pick(board, path.join(ws, b.replace(OLD, NEW)));
      const tmp = path.join(cur, "tmp");
      const WT = "worktree files left as they are (each branch's own files; merging main renames them)";
      for (const [p, e] of entries(path.join(cur, "wt"))) { name(p, e); for (const [q, f] of entries(p)) name(q, f, f.isSymbolicLink() ? undefined : WT); }
      tree(cur, "all", (p) => {
        if (p !== tmp) return false;
        const walkNames = (d) => { for (const [q, f] of entries(d)) { name(q, f); if (f.isDirectory() && !alwaysSkip(q, f)) walkNames(q); else if (f.isFile() && d === tmp && /-TEMP-ROOT$/.test(f.name)) content(q, "all"); } };
        walkNames(tmp);
        return true;
      });
    }
    for (const [p, e] of entries(ws)) if (e.isFile() && e.name.endsWith(".code-workspace")) content(p, "all");
    content(path.join(ws, ".vscode", "settings.json"), "all");
  }
  const user = o.vscodiumUser;
  const dry = new Run(o, false, true);
  for (const prof of profilesOf(user)) {
    content(path.join(prof, "settings.json"), "all");
    content(path.join(prof, "keybindings.json"), "all");
    for (const [p, e] of entries(path.join(prof, "globalStorage"))) name(p, e);
    vscdb(dry, P, path.join(prof, "globalStorage", "state.vscdb"));
  }
  for (const [p] of entries(path.join(user, "workspaceStorage"))) { for (const [q, f] of entries(p)) name(q, f); vscdb(dry, P, path.join(p, "state.vscdb")); }
  for (const dir of o.claude) {
    for (const [p, e] of entries(path.join(dir, "projects"))) name(p, e);
    const configs = [path.join(dir, ".claude.json")];
    if (path.basename(dir) === ".claude") configs.push(path.join(path.dirname(dir), ".claude.json"));
    for (const c of configs) content(c, "path", "Claude .claude.json: old paths outside the project keys");
  }
  stepCodex(dry, P);
  for (const f of dry.dbs) note(true, !run.dbs.has(f), "database rows", f);
  for (const dir of [o.agy, o.grok]) for (const [p, e] of entries(dir)) if (e.isFile() && e.name.endsWith(".json")) content(p, "path");
  for (const f of o.text) content(f, "all", "text files given with --text");

  const groups = new Map();
  for (const h of left) { if (!groups.has(h.reason)) groups.set(h.reason, []); groups.get(h.reason).push(h.path); }
  run.say(run.apply ? `audit: ${left.length} left after this run` : `audit: the plan fixes ${fixed}; ${left.length} would be left`);
  for (const [reason, paths] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    run.say(`  ${paths.length}  ${reason}: ${paths.slice(0, 3).join(" | ")}${paths.length > 3 ? " | ..." : ""}`);
  }
  run.say(`audit: not read: ${skipped.big} file${skipped.big === 1 ? "" : "s"} over 20 MB, ${skipped.speech} speech runtime folder${skipped.speech === 1 ? "" : "s"}`);
  if (run.dir) {
    const scan = (d) => { for (const [p, e] of entries(d)) { if (e.isDirectory()) scan(p); else if (e.isFile() && binary(fs.readFileSync(p))) run.problems.push(`binary file in the text backup tree: ${p}`); } };
    scan(path.join(run.dir, "backup", "text"));
    run.say("audit: text backup tree checked for binary files");
  }
  return { fixed, left, groups, skipped };
}

// ---------- preflight ----------
function listProcesses() {
  if (process.platform !== "linux") return null;
  const out = [];
  for (const pid of fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    let cmd = "";
    let cwd = "";
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim(); } catch { /* gone or not ours */ }
    try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { /* gone or not ours */ }
    out.push({ pid: Number(pid), cmd, cwd });
  }
  return out;
}
function liveProcesses(o) {
  const list = o.listProcesses();
  if (!list) { o.log(`preflight: the process check was skipped on ${process.platform}; close every editor window and session yourself`); return []; }
  const under = new RegExp(`[\\\\/]\\.${OLD}(?:[\\\\/]|$)`);
  return list
    .filter((p) => p.pid !== process.pid && (p.cmd.toLowerCase().includes(OLD) || under.test(p.cwd)))
    .map((p) => `process ${p.pid} still uses the old name: ${p.cmd.slice(0, 160)}${p.cwd ? ` (cwd ${p.cwd})` : ""}`);
}

// ---------- entry points ----------
function findWorkspaces(home) {
  const out = [];
  const look = (dir, depth) => {
    for (const [p, e] of entries(dir)) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      if ([`.${OLD}`, `.${NEW}`, `.${OLD}-speech`, `.${NEW}-speech`].some((b) => exists(path.join(p, b)))) out.push(p);
      if (depth < 2) look(p, depth + 1);
    }
  };
  look(home, 1);
  return out;
}

function withDefaults(a) {
  const home = path.resolve(a.home ?? os.homedir());
  const sub = (...p) => path.join(home, ...p);
  const vscodium = process.platform === "win32" ? sub("AppData", "Roaming", "VSCodium", "User")
    : process.platform === "darwin" ? sub("Library", "Application Support", "VSCodium", "User") : sub(".config", "VSCodium", "User");
  const accounts = [...entries(sub(".claude-accounts"))].filter(([, e]) => e.isDirectory()).map(([p]) => p);
  return {
    log: console.log, listProcesses, ...a, home,
    workspaces: (a.workspaces?.length ? a.workspaces : findWorkspaces(home)).map((p) => path.resolve(p)),
    vscodiumUser: path.resolve(a.vscodiumUser ?? vscodium),
    claude: (a.claude?.length ? a.claude : [sub(".claude"), ...accounts]).map((p) => path.resolve(p)),
    codex: path.resolve(a.codex ?? sub(".codex")),
    agy: path.resolve(a.agy ?? sub(".gemini")),
    grok: path.resolve(a.grok ?? sub(".grok")),
    text: (a.text ?? []).map((p) => path.resolve(p)),
    state: path.resolve(a.state ?? sub(".local", "state", `${NEW}-cutover`)),
  };
}

function extensionLines(o) {
  const profiles = [];
  try {
    const s = JSON.parse(fs.readFileSync(path.join(o.vscodiumUser, "globalStorage", "storage.json"), "utf8"));
    for (const p of s.userDataProfiles ?? []) if (p.name) profiles.push(p.name);
  } catch { /* no profiles listed */ }
  const flags = ["", ...profiles.map((n) => `--profile "${n}" `)];
  return ["Last, with VSCodium still closed, swap the extension (once per profile):",
    ...flags.map((f) => `codium ${f}--uninstall-extension ${PUBLISHER}.${OLD}`),
    ...flags.map((f) => `codium ${f}--install-extension "<the new build's .vsix>"`)];
}

/** Returns { refused, actions, counts, journal, audit, problems }. */
function run(args) {
  const o = withDefaults(args);
  oldBuildCache.clear();
  const P = patterns(o.home, o.workspaces);
  o.log(`${o.apply ? "APPLY" : "DRY RUN (nothing is changed; add --apply)"}: home ${o.home}; workspaces ${o.workspaces.join(", ") || "none found"}`);
  const pre = new Run(o, false, true);
  steps(pre, P);
  const refused = [...(o.forcePreflight ? [] : liveProcesses(o)), ...pre.collisions, ...pre.editorConflicts];
  if (refused.length) {
    o.log("preflight found:");
    for (const r of refused) o.log(`  ${r}`);
    if (!o.forcePreflight || pre.editorConflicts.length) {
      o.log("Nothing was changed. Resolve the reported conflicts or close the listed programs, then run again.");
      return { refused, actions: 0, problems: [] };
    }
  }
  let r = pre;
  if (o.apply) {
    r = new Run(o, true, !!o.summary);
    try { steps(r, P); } catch (error) {
      o.log(`stopped: ${error.stack || error.message}`);
      if (r.journal) o.log(`undo what was done: node ${__filename} --rollback "${r.journal}"`);
      throw error;
    }
  } else if (!o.summary) for (const line of pre.lines) o.log(line);
  r.quiet = false;
  o.log(`actions per step: ${STEPS.map(([n]) => `${n} ${r.counts[n] ?? 0}`).join(", ")}; total ${r.actions}${o.apply ? "" : " planned"}`);
  if (r.skipped.length) o.log(`skipped ${r.skipped.length} text file${r.skipped.length === 1 ? "" : "s"} over 20 MB`);
  const result = audit(r, P);
  for (const p of r.problems) o.log(`PROBLEM: ${p}`);
  if (r.journal) o.log(`journal: ${r.journal}\nundo with: node ${__filename} --rollback "${r.journal}"`);
  if (!o.summary) for (const line of extensionLines(o)) o.log(line);
  return { refused: null, actions: r.actions, counts: r.counts, journal: r.journal, audit: result, problems: r.problems };
}

/** Undoes a journal in reverse order. Returns the number of failures. */
function rollback(journal, log = console.log) {
  const acts = fs.readFileSync(journal, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).reverse();
  let failures = 0;
  for (const a of acts) {
    try {
      if (a.op === "rename") {
        if (!exists(a.to) || exists(a.from)) { log(`skip: cannot move ${a.to} back to ${a.from}`); failures++; continue; }
        fs.renameSync(a.to, a.from);
      } else if (a.op === "write") {
        fs.writeFileSync(a.path, fs.readFileSync(a.backup)); // in place, so hard links stay
        fs.utimesSync(a.path, new Date(a.atimeMs), new Date(a.mtimeMs));
      } else if (a.op === "db") {
        for (const b of a.backups) { if (b.backup) fs.copyFileSync(b.backup, b.file); else fs.rmSync(b.file, { force: true }); }
      } else if (a.op === "link") {
        fs.unlinkSync(a.path);
        makeLink(a.from, a.path);
      } else if (a.op === "drop") { log(`cannot undo: ${a.path} was deleted (--drop-old-builds)`); continue; }
      log(`undone: ${a.op} ${a.path ?? `${a.to} -> ${a.from}`}`);
    } catch (error) { log(`failed to undo ${JSON.stringify(a)}: ${error.message}`); failures++; }
  }
  return failures;
}

function parseArgs(argv) {
  const o = { workspaces: [], claude: [], text: [] };
  const flags = { "--apply": "apply", "--force-preflight": "forcePreflight", "--summary": "summary", "--drop-old-builds": "dropOldBuilds" };
  const single = { "--home": "home", "--vscodium-user": "vscodiumUser", "--codex": "codex", "--agy": "agy", "--grok": "grok", "--state": "state", "--rollback": "rollback" };
  const multi = { "--workspace": "workspaces", "--claude": "claude", "--text": "text" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags[a]) o[flags[a]] = true;
    else if (single[a]) { if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${a} needs a value`); o[single[a]] = argv[++i]; }
    else if (multi[a]) {
      const before = o[multi[a]].length;
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) o[multi[a]].push(argv[++i]);
      if (o[multi[a]].length === before) throw new Error(`${a} needs a value`);
    } else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

if (require.main === module) {
  try {
    const a = parseArgs(process.argv.slice(2));
    if (a.rollback) process.exit(rollback(path.resolve(a.rollback)) ? 1 : 0);
    const r = run(a);
    process.exitCode = r.refused || r.problems.length ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

module.exports = { run, rollback, parseArgs, patterns, renameName, OLD, NEW };
