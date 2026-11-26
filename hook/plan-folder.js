// Claude Code hook for plan files (F98, plan files go where Run a plan… looks; the user, 9 November 2026). The picker reads only the
// board's repo (src/plan.ts findPlanFiles), never a card's worktree, so a card's plan used to show only after Finish.
//
// PreToolUse, Write: a card that writes a NEW workflow plan file anywhere else has the write moved to <main checkout>/workflows/.
// A new plan's name gets the day it was written in front, YYYY-MM-DD- (the user, 14 November 2026), unless it already starts with a
// date; a new plan written into either folder the picker reads (workflows/ or .entomatical/workflows/ of the main checkout) stays in
// that folder and only gets its date. Rewrites of a file that already exists (a shipped plan edited on a branch) pass unchanged. A
// name already taken is refused with the reason.
//
// PostToolUse, Write|Edit|MultiEdit: a plan file a card wrote or edited in <main checkout>/workflows/ is noted as pending, one path a
// line, in the file named by the hook's argument (<board>/hooks/<card>.plan-pending, beside the card's settings file).
// Stop: each pending plan file is committed once, when the card's turn ends (the user, 14 November 2026: a plan edited 20 times in a
// turn made 20 commits), that file only (`git commit -- <file>`, other staged work untouched), when the main checkout is on main with
// no merge, rebase or cherry-pick under way. Never pushed. When it cannot commit, it says why and leaves the file in place; a file
// gone by then (archived, deleted) is skipped quietly. A turn ended by Esc or an API error (no Stop) leaves the list for the next Stop.
// With no argument (a settings file from an older Entomatical) PostToolUse commits at once, as before.
//
// A plan file is a name ending in .plan.json, or JSON content that is an object with "v": 1 and a "steps" list.
// Prints nothing when it has no decision; on any error it prints nothing and exits 0, so the tool runs as asked.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const WIN = process.platform === "win32";
const same = (a, b) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);
const BRANCH = "main";

/** True when this file is a workflow plan file: by its name, or by content that parses as one. */
function isPlan(file, content) {
  if (/\.plan\.json$/i.test(file)) return true;
  if (typeof content !== "string" || !/\.json$/i.test(file)) return false;
  try {
    const v = JSON.parse(content);
    return !!v && typeof v === "object" && !Array.isArray(v) && v.v === 1 && Array.isArray(v.steps);
  } catch {
    return false;
  }
}

/** The board's repository: ENTOMATICAL_REPO from the card's settings, else the folder holding .entomatical/wt/<id> in cwd, else undefined. */
function repoOf(env, cwd) {
  if (env && typeof env.ENTOMATICAL_REPO === "string" && env.ENTOMATICAL_REPO) return path.resolve(env.ENTOMATICAL_REPO);
  const m = /^(.*?)[\\/]\.entomatical[\\/]wt[\\/][^\\/]+/.exec(cwd || "");
  return m ? path.resolve(m[1]) : undefined;
}

/** Today's date on this machine as YYYY-MM-DD, the prefix a new plan file's name gets. */
function today(now = new Date()) {
  const two = (x) => String(x).padStart(2, "0");
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}
/** A plan file's name with the day it was written in front (the user, 14 November 2026); a name that already starts with a date is kept. */
const dated = (name, day) => (/^\d{4}-\d{2}-\d{2}-/.test(name) ? name : `${day}-${name}`);

/** The PreToolUse output for a Write event, or undefined to let it run as asked. exists is fs.existsSync and day today(), passed in for tests. */
function place(event, env = process.env, exists = fs.existsSync, day = today()) {
  const input = event?.tool_input;
  if (event?.tool_name !== "Write" || !input || typeof input.file_path !== "string") return undefined;
  const cwd = event.cwd || process.cwd();
  const file = path.resolve(cwd, input.file_path);
  if (!isPlan(file, input.content)) return undefined;
  const repo = repoOf(env, cwd);
  if (!repo) return undefined;
  if (exists(file)) return undefined; // an existing plan file edited where it lives
  const dir = path.dirname(file);
  // A new plan written straight into a folder the picker reads stays in that folder; it only gets its date.
  const listed = [path.join(repo, "workflows"), path.join(repo, ".entomatical", "workflows")].find((d) => same(d, dir));
  const name = dated(/\.json$/i.test(file) ? path.basename(file) : `${path.basename(file)}.plan.json`, day);
  const target = path.join(listed ?? path.join(repo, "workflows"), name);
  if (same(target, file)) return undefined; // already where it belongs, under a dated name
  if (exists(target)) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `[plan folder] ${target} already exists. Plan files go in that folder so Run a plan… lists them: choose another file name, or read and edit that file.`,
      },
    };
  }
  // Ask, not allow, when the session would have asked for a write outside its folder anyway.
  const decision = event.permission_mode === "default" || event.permission_mode === "plan" ? "ask" : "allow";
  return {
    systemMessage: `[plan folder] plan file saved to ${target} so Run a plan… lists it`,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: `Plan files go in ${path.join(repo, "workflows")}, named with the day they were written, so Run a plan… lists them newest first.`,
      updatedInput: { ...input, file_path: target },
      additionalContext: `Entomatical wrote this plan file to ${target} instead of ${file} (new plan files get the day's date in front of their name), so it shows in Run a plan… now${listed && !same(listed, path.join(repo, "workflows")) ? "" : `, and commits it on ${BRANCH} in the main checkout when this turn ends`}. It is not in your worktree or branch: read and edit it at that path, and do not commit a copy of it.`,
    },
  };
}

/** Runs git in dir; returns { ok, out } with trimmed stdout, or stderr when it failed. */
function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  return { ok: r.status === 0, out: ((r.status === 0 ? r.stdout : r.stderr || r.stdout) || String(r.error || "")).trim() };
}

/** Commits one plan file in the main checkout. Returns { committed: sha } or { skipped: why }; nothing to commit returns undefined. */
function commitPlan(repo, file, task) {
  const rel = path.relative(repo, file).split(path.sep).join("/");
  const head = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!head.ok) return { skipped: `git could not read the main checkout: ${head.out}` };
  if (head.out !== BRANCH) return { skipped: `the main checkout is on ${head.out}, not ${BRANCH}` };
  for (const ref of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    if (git(repo, ["rev-parse", "-q", "--verify", ref]).ok) return { skipped: `a ${ref.split("_")[0].toLowerCase()} is under way in the main checkout` };
  }
  for (const d of ["rebase-merge", "rebase-apply"]) {
    const p = git(repo, ["rev-parse", "--git-path", d]);
    if (p.ok && fs.existsSync(path.resolve(repo, p.out))) return { skipped: "a rebase is under way in the main checkout" };
  }
  const add = git(repo, ["add", "--", rel]);
  if (!add.ok) return { skipped: `git add failed: ${add.out}` };
  if (git(repo, ["diff", "--cached", "--quiet", "--", rel]).ok) return undefined; // unchanged
  const msg = `Plan file ${rel}${task ? ` (card ${task})` : ""}\n\nCommitted by Entomatical's plan-folder hook (F98) so Run a plan… lists it on every machine after a pull.`;
  const done = git(repo, ["commit", "-q", "-m", msg, "--", rel]);
  if (!done.ok) return { skipped: `git commit failed: ${done.out}` };
  const sha = git(repo, ["rev-parse", "--short", "HEAD"]);
  return { committed: sha.ok ? sha.out : "?" };
}

/**
 * The PostToolUse output for a write or edit of a plan file in the main checkout's workflows/, or undefined. The file is added to
 * the pending list for Stop; with no list (an older settings file) it is committed now. commit is for tests.
 */
function settle(event, env = process.env, commit = commitPlan, pending = undefined) {
  const input = event?.tool_input;
  if (!["Write", "Edit", "MultiEdit"].includes(event?.tool_name) || !input || typeof input.file_path !== "string") return undefined;
  const cwd = event.cwd || process.cwd();
  const file = path.resolve(cwd, input.file_path);
  const repo = repoOf(env, cwd);
  if (!repo || !same(path.dirname(file), path.join(repo, "workflows"))) return undefined;
  let content = input.content;
  if (typeof content !== "string") { try { content = fs.readFileSync(file, "utf8"); } catch { return undefined; } }
  if (!isPlan(file, content)) return undefined;
  if (pending) {
    fs.appendFileSync(pending, `${file}\n`); // appends, so parallel tool calls lose no entry
    const text = `[plan folder] plan file saved to ${file}; it is committed on ${BRANCH} when this turn ends (not pushed)`;
    return { systemMessage: text, hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `${text}. Say this in your last reply.` } };
  }
  const r = commit(repo, file, env.ENTOMATICAL_TASK);
  if (!r) return undefined;
  // One line says where the file is, by its absolute path, and whether it was committed: Claude Code 2.1.319 does not show the
  // PreToolUse systemMessage of an allowed Write in the terminal (linux F98 check, 9 November 2026), but shows this one.
  const text = r.committed
    ? `[plan folder] plan file saved to ${file} and committed on ${BRANCH} (${r.committed}); not pushed`
    : `[plan folder] plan file saved to ${file}, not committed: ${r.skipped}. Run a plan… lists it; the user commits it.`;
  return { systemMessage: text, hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `${text} Say this in your last reply.` } };
}

/** The Stop output: commits each pending plan file once and clears the list, or undefined when nothing was pending. Never blocks. */
function finish(event, env = process.env, pending, commit = commitPlan) {
  let list;
  try { list = fs.readFileSync(pending, "utf8"); } catch { return undefined; }
  const repo = repoOf(env, event?.cwd || process.cwd());
  if (!repo) return undefined;
  fs.rmSync(pending, { force: true });
  const lines = [];
  for (const file of new Set(list.split(/\r?\n/).filter(Boolean))) {
    if (!fs.existsSync(file)) continue; // archived or deleted since
    const r = commit(repo, file, env.ENTOMATICAL_TASK);
    if (r?.committed) lines.push(`[plan folder] ${file} committed on ${BRANCH} (${r.committed}); not pushed`);
    else if (r?.skipped) lines.push(`[plan folder] ${file} not committed: ${r.skipped}. Run a plan… lists it; the user commits it.`);
  }
  return lines.length ? { systemMessage: lines.join("\n") } : undefined;
}

if (require.main === module) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("error", () => {}).on("data", (c) => (data += c)).on("end", () => {
    try {
      const event = JSON.parse(data) ?? {};
      const pending = process.argv[2];
      const out = event.hook_event_name === "PostToolUse" ? settle(event, process.env, commitPlan, pending)
        : event.hook_event_name === "Stop" ? (pending ? finish(event, process.env, pending) : undefined) : place(event);
      if (out) process.stdout.write(JSON.stringify(out));
    } catch { /* fail open: the tool runs as asked */ }
  });
}
module.exports = { isPlan, repoOf, place, settle, finish, commitPlan, today, dated };
