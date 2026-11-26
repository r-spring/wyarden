// Claude Code SubagentStart hook for ab-* sub-agents (F96, scoped sub-agents): briefs the sub-agent, before its first prompt, with live
// worktree facts (branch, HEAD, how far origin/main is ahead, this machine's parity todo features, today's evidence folder) and the
// standing rules, so a dispatch prompt holds only the task, the files and the acceptance test.
// Each fact is read in its own try: a failing command leaves "unknown" on that line only. Other agent types get nothing.
// Prints nothing when it has no brief; on any error it prints nothing and exits 0, so the sub-agent starts as it would without the hook.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const RULES = [
  "Change nothing outside the worktree; never write under ~/.entomatical, ~/.claude* or the repo's .entomatical/ state.",
  "Scratch files only in your temporary folder (TMP, TEMP or TMPDIR: the card's folder under the workspace's .entomatical/tmp); delete them before you reply.",
  "Never read token or credential files.",
  "Bound every grep: -m N or | head; no variable-length regex over a minified file.",
  "Reply in the format your agent definition names, within its line cap.",
];

/** The IDs whose side column starts with "todo", from the `node tools/parity.js --status` table. Throws when the header lacks side. */
function todoFeatures(statusTable, side) {
  const rows = statusTable.split("\n").map((line) => line.split("|").map((cell) => cell.trim()));
  const col = rows.find((cells) => cells[1] === "ID")?.indexOf(side) ?? -1;
  if (col < 2) throw new Error(`no ${side} column`);
  return rows.filter((cells) => /^F\d+$/.test(cells[1]) && cells[col]?.startsWith("todo")).map((cells) => cells[1]);
}

/** fn's value, or "unknown" when it throws. */
const orUnknown = (fn) => { try { return fn(); } catch { return "unknown"; } };

/** The brief for an ab-* sub-agent, or undefined for any other type. run(file, args) returns a command's trimmed stdout in event.cwd or throws. */
function brief(event, run, side) {
  if (typeof event?.agent_type !== "string" || !event.agent_type.startsWith("ab-")) return undefined;
  const cwd = event.cwd || process.cwd(); // where run executes when the event names no cwd
  const branch = orUnknown(() => {
    const name = run("git", ["branch", "--show-current"]) || "(detached)";
    const head = run("git", ["rev-parse", "--short", "HEAD"]);
    const main = run("git", ["rev-parse", "--short", "origin/main"]);
    const ahead = run("git", ["rev-list", "--count", "HEAD..origin/main"]);
    return `${name} at ${head}; origin/main ${main}, ${ahead} commit${ahead === "1" ? "" : "s"} ahead of you`;
  });
  const todo = orUnknown(() => todoFeatures(run("node", ["tools/parity.js", "--status"]), side).join(", ") || "none");
  // shortcut: the folder date is the host's local date from Node's clock, so near midnight it may name yesterday's or today's folder.
  const now = new Date();
  // Windows evidence folders have always been parity-win-<date> (docs/evidence/parity-win-*); the parity column is still "windows".
  const folder = `docs/evidence/parity-${side === "windows" ? "win" : side}-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}/`;
  const evidence = orUnknown(() => `${folder} ${fs.existsSync(path.join(cwd, folder)) ? "(exists)" : "(absent)"}`);
  return [
    `Worktree: ${cwd}`,
    `Branch: ${branch}`,
    `Machine: ${side}; parity todo here: ${todo}`,
    `Evidence folder today: ${evidence}`,
    "",
    "Rules:",
    ...RULES.map((rule) => `- ${rule}`),
  ].join("\n");
}

if (require.main === module) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("error", () => {}).on("data", (c) => (data += c)).on("end", () => {
    try {
      const event = JSON.parse(data) ?? {};
      const run = (file, args) => execFileSync(file, args, { cwd: event.cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
      const additionalContext = brief(event, run, process.platform === "win32" ? "windows" : "linux");
      if (additionalContext) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext } }));
    } catch { /* fail open: the sub-agent starts without a brief */ }
  });
}
module.exports = { brief, todoFeatures, RULES };
