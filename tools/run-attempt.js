#!/usr/bin/env node
// The bounded execution path for an operation's phases (workflow.ts). An operation never runs its tool straight from a prompt: it calls
//   node tools/run-attempt.js <repo> <attempt-id> run <phase> --timeout-ms <ms> --kill-after-ms <ms> -- <command...>
//   node tools/run-attempt.js <repo> <attempt-id> auth-done <scope-name> <ttl-minutes>   the owner prompt finished: release its slot, record the access scope
//   node tools/run-attempt.js <repo> <attempt-id> admit <name> <ttl-minutes>   a passed boot/mount/ownership/capacity check, close to execution
// Validation (exit 3, nothing run): the attempt exists and is open, every exclusive claim is still its own, its scope is still the approved
// one. The external worker lane and catalog locks are the operation's own to take inside the command; this checks Entomatical's reservation only.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, execFileSync, spawn } = require("child_process");
const { WorkflowStore, scopeHash, resourceProblem } = require(path.join(__dirname, "..", "out", "workflow.js"));

const [repo, id, verb, ...rest] = process.argv.slice(2);
if (!repo || !id || !verb) { console.error("usage: run-attempt.js <repo> <attempt-id> run <phase> --timeout-ms <positive integer> --kill-after-ms <positive integer> -- <command...> | auth-done <scope> <ttl-min> | admit <name> <ttl-min>"); process.exit(2); }
// Match Board.commonRoot without loading VS Code: every linked worktree uses the main repository's store.
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
let common;
try { common = git("rev-parse", "--git-common-dir").trim(); } catch { /* a non-Git board uses the supplied folder */ }
const root = common ? path.resolve(repo, common, "..") : repo;
const store = new WorkflowStore(path.join(root, ".entomatical", "workflow"));
let a = store.attempt(id), active, locked = false, retainLock = false;
const unlock = () => { if (locked) { fs.rmSync(active); locked = false; } };
const refuse = (why) => { if (!retainLock) unlock(); console.error(`run-attempt: refused: ${why}`); process.exit(3); };

// A window PID or owner token cannot locate its board after a reload. Older attempts can be matched by both saved ids.
function owningBoardTasks(attempt) {
  const dirs = new Set([attempt.boardRoot ?? repo]);
  if (attempt.boardRoot === undefined && common) {
    for (const field of git("worktree", "list", "--porcelain", "-z").split("\0")) {
      if (field.startsWith("worktree ")) dirs.add(field.slice("worktree ".length));
    }
  }
  const seen = new Set();
  let board, sawCard = false;
  for (const dir of dirs) {
    let file;
    // native: on Windows the JS realpath keeps the caller's drive-letter case (VS Code's "c:\") while git worktree list says "C:/",
    // so one board read twice would look like two claims.
    try { file = fs.realpathSync.native(path.join(dir, ".entomatical", "tasks.json")); }
    catch (e) { if (e.code === "ENOENT" && attempt.boardRoot === undefined) continue; throw e; }
    if (seen.has(file)) continue;
    seen.add(file);
    const tasks = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(tasks)) refuse("invalid saved workflow board; explicit reconciliation required");
    for (const task of tasks) {
      if (task.id !== attempt.task) continue;
      sawCard = true;
      if (task.workflow?.attempt !== attempt.id) continue;
      if (board) refuse("multiple saved tasks claim this attempt; explicit reconciliation required");
      board = tasks;
    }
  }
  if (!board && (attempt.boardRoot !== undefined || attempt.owner !== undefined || sawCard))
    refuse("owning saved workflow task cannot be identified; explicit reconciliation required");
  return board ?? []; // A standalone attempt can have no board record.
}
if (!a) refuse(`no attempt ${id}`);
const resources = resourceProblem([], store);
if (resources) refuse(resources);
const metadata = verb === "admit" || verb === "auth-done";
const [name, minutes] = rest, ttlMs = Number(minutes) * 60_000, now = Date.now();
if (metadata) {
  if (rest.length !== 2 || !name.trim() || !Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(now + ttlMs) || now + ttlMs <= now) refuse(`${verb} needs <name> <finite positive ttl-min>`);
}
const [phase, timeoutFlag, timeout, killFlag, killAfter, separator, ...command] = rest;
const timeoutMs = Number(timeout), killAfterMs = Number(killAfter);
// Node timers accept signed 32-bit milliseconds; larger values silently become 1 ms. No operational default is supplied here.
const timerOk = (n) => Number.isInteger(n) && n > 0 && n <= 2_147_483_647;
if (!metadata && (verb !== "run" || !phase?.trim() || timeoutFlag !== "--timeout-ms" || killFlag !== "--kill-after-ms" || separator !== "--" || !command[0] || !timerOk(timeoutMs) || !timerOk(killAfterMs))) refuse("run needs <phase> --timeout-ms <positive integer> --kill-after-ms <positive integer> -- <command...>");
const safeId = a.id.replace(/[^A-Za-z0-9._-]/g, "_"), dir = path.join(store.dir, "attempts", `${safeId}.phases`);
const phaseId = crypto.createHash("sha256").update(phase).digest("hex");
const commandHash = crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex");
active = path.join(store.dir, "attempts", `${safeId}.active-phase.json`);
const intent = path.join(dir, `${phaseId}.intent.json`), resultFile = path.join(dir, `${phaseId}.result.json`);
const record = { ...(metadata ? { verb } : { phase, commandHash, timeoutMs, killAfterMs }), runnerPid: process.pid, at: new Date().toISOString() };
const create = (file, value) => {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
try { create(active, record); } catch (error) { if (error.code === "EEXIST") refuse("attempt has an active or unreconciled phase; no retry"); throw error; }
locked = true;
// All three mutating verbs share this mutex. Never save the startup snapshot over a phase's newer terminal outcome.
a = store.attempt(id);
if (!a) refuse(`no attempt ${id}`);
let boardTasks;
try { boardTasks = owningBoardTasks(a); }
catch { refuse("cannot read the owning workflow board; explicit reconciliation required"); }
const currentResources = resourceProblem(boardTasks, store);
if (currentResources) refuse(currentResources);
if (a.state === "ended" || (a.outcome && a.outcome !== "pending")) refuse(`attempt ${id} is ${a.outcome ?? a.state}; no retry`);
const claims = store.claims();
for (const r of a.resources) if (r !== "local" && !claims.some((c) => c.resource === r && c.attempt === id)) refuse(`attempt ${id} no longer holds ${r}`);
if (a.scopeHash) {
  if (!a.scope || scopeHash(a.scope) !== a.scopeHash) refuse("scope snapshot changed since dispatch");
  const ap = store.approval(a.scope);
  if (!ap?.scope || typeof ap.scope !== "object" || Array.isArray(ap.scope) || scopeHash(ap.scope) !== a.scopeHash || ap.scopeHash !== a.scopeHash || !Array.isArray(ap.used) || !ap.used.includes(id) || ap.scope.expires !== a.scope.expires) refuse("scope not approved for this attempt or expiry changed");
  if (a.scope.expires !== undefined && (!Number.isFinite(Date.parse(a.scope.expires)) || Date.parse(a.scope.expires) <= Date.now())) refuse("authorization expired or has an invalid expiry");
}
if (metadata) {
  if (verb === "auth-done" && (!a.resources.includes("auth-prompt") || !claims.some((c) => c.resource === "auth-prompt" && c.attempt === id))) refuse("authentication prompt is not held by this attempt");
  store.admit(name, ttlMs);
  if (verb === "auth-done") { a.resources = a.resources.filter((r) => r !== "auth-prompt"); store.saveAttempt(a); store.release(id, "auth-prompt"); }
  unlock(); process.exit(0);
}
if (a.admission && !Array.isArray(a.admission)) refuse("invalid admission snapshot");
for (const name of a.admission ?? []) if (typeof name !== "string" || !name.trim() || !store.admitted(name)) refuse("phase needs current admission");
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
if (fs.existsSync(intent)) {
  if (fs.existsSync(resultFile)) unlock();
  else { retainLock = true; Object.assign(a, { state: "ended", outcome: "unknown", reason: "prior phase intent has no result" }); store.saveAttempt(a); }
  refuse("phase already has an intent; reconcile its result, no retry");
}
create(intent, record); // Durable intent precedes every possible execution; an uncertain controller is never automatically retried.
retainLock = true;
a.phase = phase; store.saveAttempt(a);
const win = process.platform === "win32";
let child, finished = false, stopping, deadline, escalation;
const groupAlive = () => {
  if (!child?.pid) return false;
  if (win) return child.exitCode === null && child.signalCode === null;
  try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
};
// Same process-tree pattern as Board.killTree/checks.stop; this does not contain setsid children or prove remote-job termination.
const signalTree = (signal) => {
  if (!child?.pid) return;
  if (win) execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: killAfterMs }, () => {});
  else try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") stopping = "process-group cleanup unproved"; }
};
const finish = (outcome, status, signal, reason) => {
  if (finished) return;
  finished = true; clearTimeout(deadline); clearTimeout(escalation);
  const result = { ...record, pid: child?.pid, outcome, status, signal, reason, finishedAt: new Date().toISOString() };
  create(resultFile, result);
  const fd = fs.openSync(path.join(store.dir, "attempts", `${safeId}.phases.jsonl`), "a", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(result) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (outcome !== "success") {
    const current = store.attempt(id);
    Object.assign(current, { state: "ended", outcome, reason, endedAt: result.finishedAt }); store.saveAttempt(current);
  } else unlock(); // The attempt's payload/writer/selection claims and receipt acceptance are untouched.
  process.exit(outcome === "success" ? 0 : outcome === "unknown" ? 124 : status || 1);
};
const stop = (reason) => {
  if (finished || stopping) return;
  stopping = reason;
  signalTree("SIGTERM");
  escalation = setTimeout(() => { signalTree("SIGKILL"); finish("unknown", null, null, stopping); }, killAfterMs);
};
for (const signal of ["SIGINT", "SIGTERM", ...(win ? [] : ["SIGHUP"])]) process.on(signal, () => stop(`controller interrupted (${signal}); remote state unproved`));
try { child = spawn(command[0], command.slice(1), { stdio: "inherit", cwd: process.cwd(), detached: !win, windowsHide: true }); }
catch (error) { finish("failed", null, null, `spawn failed (${error.code || "unknown"})`); }
deadline = setTimeout(() => stop("phase deadline exceeded; remote state unproved"), timeoutMs);
child.once("error", (error) => finish("failed", null, null, `spawn failed (${error.code || "unknown"})`));
child.once("close", (status, signal) => {
  if (finished) return;
  if (stopping) { if (!groupAlive()) finish("unknown", status, signal, stopping); return; }
  if (groupAlive()) { stop("phase left a process group; cleanup unproved"); return; }
  if (signal) { finish("unknown", status, signal, `phase interrupted (${signal}); remote state unproved`); return; }
  finish(status === 0 ? "success" : "failed", status, signal, status === 0 ? undefined : "phase command failed");
});
