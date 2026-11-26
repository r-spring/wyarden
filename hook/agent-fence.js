// Claude Code PreToolUse hook for Bash and PowerShell inside ab-* sub-agents (F96, scoped sub-agents): no ab-* type pushes, and the four read-only
// types (the ones with no Edit or Write tool) neither run a repo-changing git command nor write to .entomatical state or a .claude folder.
// The main session's calls carry no agent_type and pass untouched, as do other agent types and other tools, but for one rule that holds
// for every session and sub-agent: no `npm ci` where node_modules is the link to the main checkout's packages (see CLEAN_INSTALL).
// Prints nothing when the command may run; on any error it prints nothing and exits 0, so the command runs as asked.
// shortcut: whitespace words, not a shell parser (quotes other than a quoted -C or -c value, env prefixes, sudo, `2>` and `--git-dir x`
// are not understood), so it stops a role's mistakes, not an attacker; move to a real tokenizer if a fenced role is seen getting past it.
// PowerShell cmdlets (Remove-Item, Set-Content) are not word-matched either: in the PowerShell tool only the git rules hold.
const fs = require("fs");
const path = require("path");
const READ_ONLY = new Set(["ab-reviewer", "ab-mapper", "ab-test-gate", "ab-host-investigator"]);
// the user, 15 November 2026: a card's node_modules is a link to the main checkout's (linkModules, src/git.ts), and `npm ci` empties
// node_modules before it installs. On 14 November card ba055b followed a plan step's "First run `npm ci`" and deleted the packages of
// the main checkout and of every other card through the link. `npm install` deletes nothing first and is let through.
// shortcut: `npm --prefix <dir> ci` and a folder change the words do not show (a script, `git -C`) are not followed.
const CLEAN_INSTALL = new Set(["ci", "clean-install", "ic", "install-clean", "isntall-clean"]);
const MOVE = /^(?:cd|pushd|sl|chdir|Set-Location|Push-Location)\s+(?:-(?:Literal)?Path\s+)?(.+)$/i;
const SHARED = "[agent fence] node_modules here is a link to the main checkout's packages, which every card shares: npm ci would delete them "
  + "for all of them. The packages are already installed, so skip this step and go on. Only if this branch changes package-lock.json: remove "
  + "the link itself first (Windows: cmd /c rmdir node_modules; Linux: rm node_modules), then run npm ci.";

/** True when the words are npm's clean install: the first word after "npm" that is not an option is ci or one of its aliases. */
const cleanInstall = (words) => /^npm(\.cmd)?$/i.test(words[0] ?? "") && CLEAN_INSTALL.has(words.slice(1).find((w) => !w.startsWith("-")));

/** The folder a cd or Set-Location segment moves to from dir, or dir when the segment is none. gitBash: read /c/… as c:/… (the Bash tool on Windows). */
function moved(dir, segment, gitBash = false) {
  const to = MOVE.exec(segment)?.[1].trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!to) return dir;
  return path.resolve(dir, gitBash ? to.replace(/^\/([A-Za-z])(?=\/|$)/, "$1:") : to);
}

/** True when npm run in dir would work on a linked node_modules: npm's folder is the nearest one above with a node_modules or a package.json. */
function sharedModules(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    try { return fs.lstatSync(path.join(d, "node_modules")).isSymbolicLink(); } catch { /* none here */ }
    if (fs.existsSync(path.join(d, "package.json")) || path.dirname(d) === d) return false;
  }
}
// Not branch, tag, config or worktree: each has read forms (git branch --show-current, git tag -l, git config --get, git worktree list).
const REPO_CHANGING = new Set(["commit", "checkout", "switch", "merge", "stash", "reset", "rebase", "add", "rm", "mv", "cherry-pick", "clean",
  "restore", "pull", "revert", "apply", "am"]);
const WRITERS = new Set(["rm", "mv", "mkdir", "tee", "touch", "truncate"]);
// The two-character separators first, so "||" is not read as two pipes.
const SEPARATORS = ["&&", "||", ";", "|", "\n"];

/** The git verb of a segment's words: the first word after "git" that is not an option, skipping the value of -C and -c. */
function gitVerb(words) {
  if (words[0] !== "git") return undefined;
  for (let i = 1; i < words.length; i++) {
    if (words[i] === "-C" || words[i] === "-c") {
      const quote = words[++i]?.[0];
      // A quoted value with a space ("/home/example/Dev Stuff/entomatical") spans words: skip to the word that closes the quote.
      if ((quote === '"' || quote === "'") && !words[i].endsWith(quote)) {
        const close = words.findIndex((w, j) => j > i && w.endsWith(quote));
        i = close < 0 ? words.length : close;
      }
    } else if (!words[i].startsWith("-")) return words[i];
  }
  return undefined;
}

/** The words a segment writes to: cp's destination, every argument of another writing command, else the words from its first redirect on. */
function target(words) {
  if (words[0] === "cp") return words.slice(-1); // what cp copies from is a read
  const sedInPlace = words[0] === "sed" && words.some((w) => w.startsWith("-i") || w.startsWith("--in-place"));
  if (WRITERS.has(words[0]) || sedInPlace) return words.slice(1);
  const redirect = words.findIndex((w) => w.startsWith(">")); // ">", ">>" and an attached ">file"; what it redirects from is a read
  return redirect < 0 ? [] : words.slice(redirect);
}

/**
 * True when a target word names .entomatical state or a .claude folder. A path inside a worktree (.entomatical/wt/<id>/…) is not state,
 * nor one inside the workspace's temporary folders (.entomatical/tmp/…), where scratch copies now go (src/workspace.ts, 13 Nov 2026).
 */
const isState = (word) => word.includes(".claude") || (word.includes(".entomatical") && (/(^|[\\/])\.\.([\\/]|$)/.test(word) || !/\.entomatical[\\/](wt[\\/][A-Za-z0-9_-]+|tmp)[\\/]./.test(word)));

const deny = (permissionDecisionReason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason } });

/**
 * The PreToolUse output that denies a Bash or PowerShell command, or undefined to let it run: `npm ci` on linked packages in any session,
 * and the ab-* rules in an ab-* sub-agent. linked is sharedModules, passed in for tests.
 */
function fence(event, linked = sharedModules) {
  const type = event?.agent_type;
  const command = event?.tool_input?.command;
  if (!(event?.tool_name === "Bash" || event?.tool_name === "PowerShell") || typeof command !== "string") return undefined;
  const ab = typeof type === "string" && type.startsWith("ab-");
  let dir = typeof event.cwd === "string" ? event.cwd : "";
  const segments = SEPARATORS.reduce((parts, sep) => parts.flatMap((p) => p.split(sep)), [command]);
  for (const segment of segments) {
    const words = segment.trim().split(/\s+/);
    if (dir) dir = moved(dir, segment.trim(), event.tool_name === "Bash" && process.platform === "win32");
    if (dir && cleanInstall(words) && linked(dir)) return deny(SHARED);
    if (!ab) continue;
    if (words[0] === "cd") continue; // cd changes nothing, and its folder may be any path
    const verb = gitVerb(words);
    if (verb === "push") return deny(`[agent fence] ${type} never pushes; commit and report the commit.`);
    if (!READ_ONLY.has(type)) continue;
    if (REPO_CHANGING.has(verb)) return deny(`[agent fence] ${type} is read-only: no repo-changing git command (${verb}).`);
    if (target(words).some(isState)) return deny(`[agent fence] ${type} is read-only: no writes to .entomatical state or .claude folders.`);
  }
  return undefined;
}

if (require.main === module) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("error", () => {}).on("data", (c) => (data += c)).on("end", () => {
    try {
      const out = fence(JSON.parse(data) ?? {});
      if (out) process.stdout.write(JSON.stringify(out));
    } catch { /* fail open: the command runs as asked */ }
  });
}
module.exports = { READ_ONLY, fence, moved, sharedModules };
