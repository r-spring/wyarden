#!/usr/bin/env node
// Entomatical panel wrapper for the Claude Code extension (user setting claudeCode.claudeProcessWrapper), on Linux and Windows.
// The extension runs: entomatical-claude <path to claude> <cli args...>
// On Linux this file is the wrapper. On Windows the setting names entomatical-claude.exe (wrapper/launcher.cs), which starts
// this file with node, because Windows cannot start a .js file as a program.
//
// Every call passes straight through, except a chat session (stream-json) that Entomatical asked for:
// Entomatical writes <repo>/.entomatical/launch/pending.txt just before it opens a new Claude panel, and
// <repo>/.entomatical/launch/<session id>.txt for later resumes. Each file holds three lines: the task's worktree, its
// account config folder (empty = ~/.claude) and its hooks settings file (which also carries the task's model and effort).
// That session runs in the worktree, with CLAUDE_CONFIG_DIR set (or cleared for the main account) and
// --settings <hooks file> added. pending.txt adds the first-prompt file and the session name (--name).
// It never reads or touches login data.
//
// The wrapper that claudeCode.claudeProcessWrapper named before Entomatical took the setting (for example a memory-cap
// launcher) is kept: its path is in ~/.entomatical/inner-wrapper, and claude is started through it.
// Ending claude with the wrapper: on Windows the launcher's kill-on-close job does it. Elsewhere claude runs in its own
// process group; a signal that ends the wrapper, or VSCodium closing its end of stdout, is passed to that group (SIGKILL 3 s
// later, and again when claude ends, for a tool child that ignored it), and claude also ends when its stdin closes.
// shortcut: a child that starts its own process group outlives a SIGKILLed wrapper; kill the group or cgroup by hand if
// that ever matters.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");

const WIN = process.platform === "win32";
const LINE_CAP = 1 << 20; // longest stdout line scanned for usage and metrics

// <tmp>/entomatical-wrapper.log: one line per decision, to diagnose launches. Past 1 MB it becomes .log.1 and a new one starts.
function log(line) {
  const file = path.join(os.tmpdir(), "entomatical-wrapper.log");
  try {
    if (fs.statSync(file).size > 1 << 20) fs.renameSync(file, `${file}.1`);
  } catch {
    // no log yet
  }
  try {
    fs.appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${line}\n`, { mode: 0o600 }); // it names folders and args
  } catch {
    // unwritable: launches still go ahead
  }
}

const SESSION_ID = /^[0-9a-fA-F-]{8,64}$/;

/** fn(), retried for up to half a second while Windows antivirus holds a just-written file (EPERM, EBUSY). */
function retry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (attempt >= 10 || (e.code !== "EPERM" && e.code !== "EBUSY")) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function resumeId(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--resume=")) return args[i].slice("--resume=".length);
    if (args[i] === "--resume" && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

function findLaunchDir(from) {
  for (let d = path.resolve(from); ; d = path.dirname(d)) {
    const launch = path.join(d, ".entomatical", "launch");
    try {
      if (fs.statSync(launch).isDirectory()) return launch;
    } catch {
      // not here
    }
    // The workspace's .entomatical/tmp (src/workspace.ts) is the top of its temporary folders: never the real board's launch folder.
    if (path.dirname(d) === d || fs.existsSync(path.join(d, "ENTOMATICAL-TEMP-ROOT"))) return undefined;
  }
}

/** Applies a launch file if one matches (changes run.cwd, run.env, args); returns the task's first prompt for a new session. */
function apply(args, run) {
  if (!args.some((a) => a === "stream-json" || a.startsWith("--input-format"))) return undefined; // not a chat session
  // Claude Code's config-cache probe (its spawnConfigProbe sets CLAUDE_CODE_CONFIG_PROBE=1) is a stream-json session that ends
  // within seconds. Seen on Windows, 31 October 2026 (extension 2.1.314): "Use panel" at a first Start made it run, it took
  // pending.txt, and the task's own panel opened a blank chat. It is never a board task, so it takes no launch file.
  if (run.env.CLAUDE_CODE_CONFIG_PROBE) return void log("config probe: no launch file");
  const dir = findLaunchDir(run.cwd);
  if (!dir) return undefined;

  let launch;
  let claimed = false;
  const resume = resumeId(args);
  if (resume !== undefined) {
    const file = path.join(dir, `${resume}.txt`);
    if (SESSION_ID.test(resume) && fs.existsSync(file)) launch = file;
  } else {
    // A new chat or test run started inside a task worktree (<repo>/.entomatical/wt/<id>) walks up to the main repo's launch
    // folder; that pending.txt is another card's start (reproduced 4 November 2026: it took that card's prompt and name).
    const inside = path.relative(path.dirname(dir), path.resolve(run.cwd));
    if (!inside.startsWith("..") && !path.isAbsolute(inside)) return void log(`cwd ${run.cwd} is inside ${path.dirname(dir)}: no launch file for a new session`);
    const pending = path.join(dir, "pending.txt");
    let fresh = false;
    try {
      fresh = Date.now() - fs.statSync(pending).mtimeMs < 60_000; // as long as the board waits for the session to report in
    } catch {
      // none
    }
    // Claim it by renaming, so only one process can take it.
    const mine = `${pending}.${process.pid}`;
    if (fresh) {
      try {
        retry(() => fs.renameSync(pending, mine));
        launch = mine;
        claimed = true;
      } catch (e) {
        if (e.code !== "ENOENT") log(`pending.txt not claimed: ${e.code}`); // ENOENT: another process claimed it first
      }
    }
  }
  log(`launch file ${launch ?? "none"}${resume !== undefined ? ` for resume ${resume}` : " (new session)"}`);
  if (!launch) return undefined;

  // Lines: worktree, account config folder, hooks settings file, and for a new session the first-prompt file and session name.
  // Both files are read before anything changes, so a failed read leaves the session as the panel started it, not half set up.
  const lines = retry(() => fs.readFileSync(launch, "utf8")).split(/\r?\n/);
  let prompt;
  try {
    // A resume's launch file names a prompt file only when the board resumed it with a message (Resume); used up below, so a later
    // resume of the same session from the panel's history sends nothing.
    prompt = lines[3] && fs.existsSync(lines[3]) ? retry(() => fs.readFileSync(lines[3], "utf8")) : undefined;
  } catch (e) {
    if (!claimed) log(`resume prompt not read: ${e.code ?? e.message}`); // the resume still runs in its worktree and account
    else {
      try { fs.renameSync(launch, path.join(path.dirname(launch), "pending.txt")); } catch { /* gone: the board's wait reports it */ }
      throw e; // given back, so the next start can take it
    }
  }
  if (claimed) rmQuiet(launch);
  if (lines.length < 3 || !fs.existsSync(lines[0]) || !fs.statSync(lines[0]).isDirectory()) return undefined;
  run.cwd = lines[0];
  if (lines[1]) run.env.CLAUDE_CONFIG_DIR = lines[1];
  else delete run.env.CLAUDE_CONFIG_DIR; // main-account tasks must not inherit the IDE default
  if (lines[2] && fs.existsSync(lines[2])) {
    args.push("--settings", lines[2]);
    // The extension's own --permission-mode=<mode> outranks the file's permissions.defaultMode (seen on the Linux machine, 4 November 2026),
    // so the task's pick replaces it. Bypass only when the extension allows it, as in its own menu.
    let mode;
    try {
      mode = JSON.parse(fs.readFileSync(lines[2], "utf8")).permissions?.defaultMode;
    } catch {
      // unreadable: the extension's mode stands
    }
    const at = args.findIndex((a) => a.startsWith("--permission-mode="));
    if (typeof mode === "string" && at >= 0 && (mode !== "bypassPermissions" || args.includes("--allow-dangerously-skip-permissions"))) {
      args[at] = `--permission-mode=${mode}`;
    }
  }
  if (lines[2]) strictArgs(lines[2], args, run);
  if (lines[2]) run.metricDir = path.join(path.dirname(path.dirname(lines[2])), "metrics");
  if (claimed && lines[4]) args.push("--name", lines[4]); // the panel tab follows the session_title_changed this makes
  if (prompt === undefined) return undefined;
  rmQuiet(lines[3]);
  return prompt || undefined;
}

/**
 * A card with a strict capability profile (src/strict-claude.ts): <board>/launch/<card>.strict.json lists the extra args, which name the
 * card's MCP file (the selected servers' definitions, mode 0600). That file is deleted when claude ends (main). Without it the session
 * must not start, since it would load everything the account has, so this throws an error marked strict and main exits instead of
 * passing the call through.
 */
function strictArgs(hooks, args, run) {
  const file = path.join(path.dirname(path.dirname(hooks)), "launch", `${path.basename(hooks, ".json")}.strict.json`);
  const refuse = (why) => { throw Object.assign(new Error(why), { strict: true }); };
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return; // not a strict card
    refuse(`strict profile: ${file} is unreadable (${e.message})`);
  }
  const extra = Array.isArray(spec?.args) && spec.args.every((a) => typeof a === "string") ? spec.args : refuse(`strict profile: ${file} has no args list`);
  const mcp = extra[extra.indexOf("--mcp-config") + 1];
  if (!extra.includes("--mcp-config") || !mcp || !fs.existsSync(mcp))
    refuse(`strict profile: its MCP file ${mcp ?? "(none)"} is gone (it is deleted when its session ends); resume the card from the Entomatical board`);
  args.push(...extra);
  run.strictMcp = mcp;
}

// Best effort: a file that cannot be deleted (Windows antivirus holding it) must not lose the session its prompt.
function rmQuiet(file) {
  try {
    fs.rmSync(file);
  } catch (e) {
    log(`could not delete ${file}: ${e.code}`);
  }
}

/**
 * The wrapper that was set before Entomatical's, if any. Never an Entomatical wrapper (this file, the Windows launcher beside it,
 * or a retired build's copy in another folder), which would start this one again forever.
 */
function innerWrapper() {
  try {
    const inner = fs.readFileSync(path.join(os.homedir(), ".entomatical", "inner-wrapper"), "utf8").trim();
    if (inner && !fs.existsSync(inner)) log(`inner wrapper ${inner} is missing: claude starts without it`);
    else if (inner && !path.basename(inner).startsWith("entomatical-claude")) return inner;
  } catch {
    // none recorded
  }
  return undefined;
}

// Same rule as usageKey in src/sessions.ts: "main" for ~/.claude, else the folder name made file-safe.
const norm = (p) => (WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
const usageKey = (configDir) => {
  const dir = (configDir || "").replace(/[\\/]+$/, "");
  return dir && norm(dir) !== norm(path.join(os.homedir(), ".claude")) ? path.basename(dir).replace(/[^A-Za-z0-9_.@-]/g, "_") : "main";
};

// The event's shape, from the zod schema in the Claude CLI 2.1.312 bundle (rate_limit_info):
//   { status: "allowed" | "allowed_warning" | "rejected", resetsAt?, rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus"
//     | "seven_day_sonnet" | "seven_day_overage_included" | "overage", utilization?, unifiedWindows?: { five_hour?, seven_day?,
//     seven_day_overage_included?: { utilization (a fraction, above 1 when over), resetsAt, status? } } }
// The CLI leaves out windows whose reset has passed, and a rejected event can carry no unifiedWindows at all.
// rateLimitType names the window the status is about. Only five_hour and seven_day are the account's own windows; the
// others are per-model buckets (a Fable limit says "Switch to another model") or extra-usage credit, so they leave the row alone.
const WINDOWS = { five_hour: ["fiveHour", "fiveHourResets"], seven_day: ["week", "weekResets"] };
const pct = (fraction) => Math.min(100, Math.max(0, Math.round(fraction * 100)));
const isFraction = (v) => typeof v === "number" && Number.isFinite(v);
const isTime = (v) => Number.isInteger(v) && v > 0;

/** The usage fields this event reports, or undefined. A window the event does not mention is not in the result. */
function usageFromEvent(info) {
  if (!info || typeof info !== "object") return undefined;
  const out = {};
  const windows = info.unifiedWindows && typeof info.unifiedWindows === "object" ? info.unifiedWindows : {};
  for (const [name, [field, resetField]] of Object.entries(WINDOWS)) {
    const w = windows[name];
    if (!w || !isFraction(w.utilization)) continue;
    out[field] = w.status === "rejected" ? 100 : pct(w.utilization);
    out[`${field}Exact`] = w.utilization * 100; // unrounded, for the readings log only
    if (isTime(w.resetsAt)) out[resetField] = w.resetsAt;
  }
  const named = WINDOWS[info.rateLimitType];
  if (named) {
    const [field, resetField] = named;
    if (info.status === "rejected") out[field] = 100;
    else if (out[field] === undefined && isFraction(info.utilization)) out[field] = pct(info.utilization);
    if (out[field] !== undefined && out[resetField] === undefined && isTime(info.resetsAt)) out[resetField] = info.resetsAt;
  }
  return Object.keys(out).length ? out : undefined;
}

// The CLI prints one of these after each reply in stream mode; the status line never runs there.
// Written in the same shape as hook/statusline.js so the board reads both alike. Merged into the last reading, so an
// event that names one window keeps the other window's reading.
function noteRateLimit(line, key, m) {
  if (!line.startsWith('{"type":"rate_limit_event"')) return;
  let usage, session;
  try {
    const obj = JSON.parse(line);
    usage = usageFromEvent(obj.rate_limit_info);
    session = typeof obj.session_id === "string" ? obj.session_id : m && m.last;
  } catch {
    return; // not a whole JSON line
  }
  if (!usage) return;
  // Best effort: a failure here is logged, because the session must go on.
  try {
    const dir = process.env.ENTOMATICAL_USAGE_DIR || path.join(os.homedir(), ".entomatical", "usage");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${key}.json`);
    let last = {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) last = raw;
    } catch {
      // no earlier reading
    }
    // A window whose reset has passed is not carried forward: its usage restarted, and the CLI may name no new window for hours.
    const expired = (resets) => typeof last[resets] === "number" && last[resets] * 1000 <= Date.now();
    const keep = (field, resets) => (last[field] === undefined || expired(resets) ? null : last[field]);
    const { fiveHourExact, weekExact, ...shown } = usage;
    const next = { fiveHour: keep("fiveHour", "fiveHourResets"), week: keep("week", "weekResets"), fiveHourResets: keep("fiveHourResets", "fiveHourResets"), weekResets: keep("weekResets", "weekResets"), ...shown, at: Date.now(), source: "stream" };
    // As in statusline.js, the reading goes to <key>.readings.jsonl with its session; here every event (one per reply), with the
    // unrounded percentages, which move even when the rounded ones do not.
    fs.appendFileSync(path.join(dir, `${key}.readings.jsonl`), JSON.stringify({ ...next, fiveHourExact, weekExact, sessionId: session }) + "\n");
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, file);
  } catch (e) {
    log(`usage not written: ${e.message}`);
  }
}

// Token measurement: per session, only usage metadata (never prompt or reply text),
// to <metrics dir>/<session>.<producer>.jsonl, read by src/metrics.ts.
const METRIC_TYPE = /"type"\s*:\s*"(assistant|result|system)"/;
function noteMetric(line, m) {
  if (!m.dir || !METRIC_TYPE.test(line)) return;
  try {
    const obj = JSON.parse(line);
    const session = obj.session_id;
    if (typeof session !== "string" || !SESSION_ID.test(session)) return;
    m.last = session;
    if (!m.sessions.has(session)) {
      m.sessions.add(session);
      writeMetric(session, { kind: "start", resumed: m.resumed }, m);
    }
    let record;
    if (obj.type === "result") {
      record = { kind: "result", subtype: obj.subtype };
      if ("modelUsage" in obj) record.modelUsage = obj.modelUsage;
      if ("uuid" in obj) record.eventId = obj.uuid;
    } else if (obj.type === "assistant") record = { kind: "activity" };
    else if (obj.subtype === "conversation_reset") record = { kind: "reset" };
    else return;
    writeMetric(session, record, m);
  } catch (e) {
    log(`metrics not written: ${e.message}`);
  }
}

function writeMetric(session, record, m) {
  Object.assign(record, { at: Date.now(), producer: m.producer, sequence: m.sequence++, sessionId: session, account: m.account });
  fs.mkdirSync(m.dir, { recursive: true });
  fs.appendFileSync(path.join(m.dir, `${session}.${m.producer}.jsonl`), JSON.stringify(record) + "\n");
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    process.stderr.write("entomatical-claude: expected the claude executable as the first argument\n");
    process.exit(2);
  }
  const args = argv.slice(1);
  const run = { cwd: process.cwd(), env: { ...process.env } };
  // Owner 2026-11-04: VSCodium always reports telemetry off, so the Claude extension sets DISABLE_TELEMETRY=1.
  // That turns off the CLI's feature flags, so trusted-device enrollment never runs and Remote Control gets
  // HTTP 403 "elevated session requires a trusted device". Drop it so Remote Control works.
  delete run.env.DISABLE_TELEMETRY;
  let firstPrompt;
  try {
    firstPrompt = apply(args, run);
  } catch (e) {
    log(`launch file ignored: ${e.message}`);
    if (e.strict) {
      process.stderr.write(`entomatical-claude: ${e.message}\n`);
      process.exit(1);
    }
  }
  // Set for the inner wrapper: if it starts this wrapper again (under another name), that one runs claude directly.
  // A depth, not a flag: claude's children inherit it, and a VSCodium started from a panel session's tool must still give its
  // panels the inner wrapper (memory cap, telemetry fix). A loop through a renamed copy still stops after two levels.
  const depth = Number(run.env.ENTOMATICAL_WRAPPED) || 0;
  const inner = depth < 2 ? innerWrapper() : undefined;
  if (inner) run.env.ENTOMATICAL_WRAPPED = String(depth + 1);
  else delete run.env.ENTOMATICAL_WRAPPED;
  const command = inner ? [inner, argv[0], ...args] : [argv[0], ...args];
  log(`cwd=${run.cwd} config=${run.env.CLAUDE_CONFIG_DIR ?? ""} prompt=${firstPrompt !== undefined} inner=${inner ?? ""} args=${JSON.stringify(args)}`);
  const key = usageKey(run.env.CLAUDE_CONFIG_DIR);
  const metrics = { dir: run.metricDir ?? process.env.ENTOMATICAL_METRICS_DIR, resumed: resumeId(args) !== undefined,
    producer: crypto.randomUUID().replace(/-/g, ""), sessions: new Set(), sequence: 0, account: key };

  // detached is a process group elsewhere, but its own console window on Windows.
  const failed = (e) => {
    log(`could not start ${command[0]}: ${e.message}`);
    process.stderr.write(`entomatical-claude: could not start ${command[0]}: ${e.message}\n`);
    process.exit(127);
  };
  let child;
  try {
    child = spawn(command[0], command.slice(1), { cwd: run.cwd, env: run.env, stdio: ["pipe", "pipe", "inherit"], detached: !WIN, windowsHide: true });
  } catch (e) {
    failed(e); // Node throws at once for a .cmd or .bat without a shell (EINVAL)
  }
  child.on("error", failed);

  // The first prompt goes in right after the first full line (the extension's initialize request), so it arrives as
  // an ordinary message once the session is set up. One stream-json user message, as the extension itself sends them.
  let inject = firstPrompt === undefined ? undefined : Buffer.from(JSON.stringify({ type: "user", message: { role: "user", content: firstPrompt } }) + "\n");
  child.stdin.on("error", () => {}); // claude already gone
  process.stdin.on("data", (b) => {
    const nl = inject ? b.indexOf(10) : -1;
    if (nl >= 0) {
      child.stdin.write(b.subarray(0, nl + 1));
      child.stdin.write(inject);
      b = b.subarray(nl + 1);
      inject = undefined;
    }
    child.stdin.write(b);
  });
  process.stdin.on("end", () => child.stdin.end());

  // Bytes pass through untouched, at the pace VSCodium reads them (pipe pauses claude's stdout while ours is full). Each
  // complete line is also checked for a usage reading and token metrics; those lines are small, so a longer one is skipped.
  child.stdout.pipe(process.stdout, { end: false });
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let skipping = false;
  child.stdout.on("data", (b) => {
    const text = decoder.write(b);
    let from = 0;
    for (let nl; (nl = text.indexOf("\n", from)) >= 0; from = nl + 1) { // only the new text is searched
      if (!skipping) {
        const line = pending + text.slice(from, nl);
        noteRateLimit(line, key, metrics);
        noteMetric(line, metrics);
      }
      pending = "";
      skipping = false;
    }
    if (skipping) return;
    pending += text.slice(from);
    if (pending.length > LINE_CAP) [pending, skipping] = ["", true];
  });

  // Ends claude's group with sig, then SIGKILL after 3 s: the Claude extension SIGKILLs this wrapper 5 s after its SIGTERM.
  let stopping = false;
  const killGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      // already gone
    }
  };
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    if (run.strictMcp) rmQuiet(run.strictMcp); // Windows exits at once below
    if (WIN) process.exit(128 + os.constants.signals[sig]); // the launcher's kill-on-close job ends claude
    killGroup(sig);
    setTimeout(() => {
      killGroup("SIGKILL");
      process.exit(128 + os.constants.signals[sig]);
    }, 3000).unref();
  };
  for (const sig of WIN ? [] : ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => stop(sig));
  // VSCodium went away (EPIPE): nobody reads claude any more, so it is ended as on a signal instead of this wrapper dying alone.
  process.stdout.on("error", (e) => {
    log(`stdout closed: ${e.code}`);
    stop("SIGTERM");
  });
  child.on("close", (code, signal) => {
    if (stopping) killGroup("SIGKILL"); // a tool child left in claude's group that ignored the signal
    if (run.strictMcp) rmQuiet(run.strictMcp); // the strict card's MCP file goes with its session (strictArgs)
    // Exit once VSCodium has everything claude printed: process.exit drops what is still queued.
    const exit = () => process.exit(code ?? 128 + (os.constants.signals[signal] ?? 0));
    process.stdout.write("", exit);
    setTimeout(exit, 3000).unref(); // a reader that is alive but never reads again
  });
}

main();
