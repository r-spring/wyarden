// Claude Code status line command for sessions Entomatical starts in a terminal. The CLI pipes its status JSON in;
// the rate_limits part is written to <usage dir>\<account key>.json for the board, and a one-line summary is
// printed for the terminal. Usage data comes from nowhere else. Panel sessions never run this;
// the wrapper reads the stream's rate_limit_event instead.
const fs = require("fs");
const os = require("os");
const path = require("path");
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (data += c)).on("end", () => {
  let status = {};
  try { status = JSON.parse(data); } catch { /* print nothing */ }
  // Context is a snapshot, not lifetime consumption. Never sum these fields.
  const contextFile = process.argv[3];
  const context = status.context_window;
  if (contextFile && context && typeof context.used_percentage === "number" && Number.isFinite(context.used_percentage) && context.used_percentage >= 0 && context.used_percentage <= 100) {
    try {
      fs.mkdirSync(path.dirname(contextFile), { recursive: true });
      const tmp = `${contextFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ usedPercent: context.used_percentage, capacity: context.context_window_size, at: Date.now(), sessionId: status.session_id }));
      fs.renameSync(tmp, contextFile);
    } catch { /* monitoring never interrupts the working session */ }
  }
  const r = status.rate_limits;
  const pct = (w) => (w && typeof w.used_percentage === "number" ? w.used_percentage : undefined);
  const five = pct(r && r.five_hour);
  const week = pct(r && r.seven_day);
  if (five === undefined && week === undefined) {
    process.stdout.write((status.model && status.model.display_name) || "");
    return;
  }
  const dir = process.env.ENTOMATICAL_USAGE_DIR || path.join(os.homedir(), ".entomatical", "usage");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${process.argv[2] || "main"}.json`);
    const next = { fiveHour: five, week, fiveHourResets: r.five_hour && r.five_hour.resets_at, weekResets: r.seven_day && r.seven_day.resets_at, at: Date.now(), source: "statusline" };
    // Every reading that differs from the last one goes to <key>.readings.jsonl with the session that saw it, so a later study
    // can put each change in the limits beside the API calls made at that time (hook.js writes those).
    let last = {};
    try { last = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { /* no earlier reading */ }
    if (["fiveHour", "week", "fiveHourResets", "weekResets"].some((k) => last[k] !== next[k])) {
      fs.appendFileSync(path.join(dir, `${process.argv[2] || "main"}.readings.jsonl`), JSON.stringify({ ...next, sessionId: status.session_id }) + "\n");
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, file);
  } catch { /* locked or unwritable: the summary still prints */ }
  process.stdout.write(`5h ${five === undefined ? "?" : five}% · week ${week === undefined ? "?" : week}%`);
});
