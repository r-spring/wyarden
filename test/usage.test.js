const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const s = require("../out/sessions.js");

const made = []; // every folder tmp() makes; removed when this file's tests are done
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-"));
  made.push(dir);
  return dir;
};
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const statusline = path.join(__dirname, "..", "hook", "statusline.js");
const root = path.parse(process.cwd()).root; // C:\ on Windows, / elsewhere
const accounts = path.join(root, "Users", "example", ".claude-accounts");
const run = (key, input, dir) => execFileSync(process.execPath, [statusline, key], { input, env: { ...process.env, ENTOMATICAL_USAGE_DIR: dir }, encoding: "utf8" });

test("usageKey: main for ~/.claude, folder name otherwise, safe for a file name", () => {
  assert.equal(s.usageKey(""), "main");
  assert.equal(s.usageKey(path.join(accounts, "alternate")), "alternate");
  assert.equal(s.usageKey(path.join(accounts, "team@example.com")), "team@example.com");
  assert.equal(s.usageKey(path.join(root, "x", "a b:c")), "a_b_c");
});

test("statusline.js records rate_limits and prints a summary", () => {
  const dir = tmp();
  const input = JSON.stringify({ model: { display_name: "Opus" }, rate_limits: { five_hour: { used_percentage: 7, resets_at: 1792014000 }, seven_day: { used_percentage: 12, resets_at: 1792180800 } } });
  const out = run("alternate", input, dir);
  assert.equal(out, "5h 7% · week 12%");
  const u = JSON.parse(fs.readFileSync(path.join(dir, "alternate.json"), "utf8"));
  assert.equal(u.fiveHour, 7);
  assert.equal(u.week, 12);
  assert.equal(u.fiveHourResets, 1792014000);
  assert.equal(u.weekResets, 1792180800);
  assert.equal(u.source, "statusline");
  assert.ok(Date.now() - u.at < 60_000);
  assert.deepEqual(s.readUsage(path.join(accounts, "alternate"), dir), u);
});

test("statusline.js ignores input without rate_limits", () => {
  const dir = tmp();
  assert.equal(run("main", JSON.stringify({ model: { display_name: "Opus" } }), dir), "Opus");
  assert.equal(run("main", "not json", dir), "");
  assert.equal(fs.existsSync(path.join(dir, "main.json")), false);
  assert.equal(s.readUsage("", dir), undefined);
});

test("statusline.js still prints when the usage folder cannot be written", () => {
  const blocked = path.join(tmp(), "usage-as-file");
  fs.writeFileSync(blocked, "not a folder");
  const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 7, resets_at: 1 }, seven_day: { used_percentage: 12, resets_at: 2 } } });
  assert.equal(run("main", input, blocked), "5h 7% · week 12%");
});

const win = process.platform === "win32";
// On Windows the .exe is the launcher that starts entomatical-claude.js beside it, so these tests run the same wrapper on both machines.
const wrapper = path.join(__dirname, "..", "wrapper", win ? "entomatical-claude.exe" : "entomatical-claude.js");
const haveWrapper = fs.existsSync(wrapper);
// The .exe runs as is; the .js runs under this node, so the tests do not depend on its execute bit. Each run has its own cwd, temp
// folder and (unless the test sets one) home, so it never takes a live board's pending.txt (found by walking up from the cwd), writes
// the live wrapper log, or starts claude through the machine's real inner wrapper (~/.entomatical/inner-wrapper).
const runWrapper = (args, opts) => {
  const own = tmp();
  const env = { ...(opts.env ?? process.env), TMPDIR: own, TEMP: own, TMP: own };
  if (!opts.env || opts.env.HOME === process.env.HOME) Object.assign(env, { HOME: own, USERPROFILE: own });
  delete env.ENTOMATICAL_WRAPPED; // a test run inside a wrapped session must still reach its own inner wrapper
  opts = { cwd: own, ...opts, env };
  return win ? execFileSync(wrapper, args, opts) : execFileSync(process.execPath, [wrapper, ...args], opts);
};

test("wrapper records a stream rate_limit_event for the session's account", { skip: haveWrapper ? false : "wrapper not built: run npm run build:wrapper" }, () => {
  const dir = tmp();
  const account = path.join(tmp(), "alternate");
  fs.mkdirSync(account);
  const out = runWrapper([process.execPath, path.join(__dirname, "fake-claude.js"), "--output-format", "stream-json", "--input-format", "stream-json"], {
    input: "", env: { ...process.env, ENTOMATICAL_USAGE_DIR: dir, CLAUDE_CONFIG_DIR: account }, encoding: "utf8",
  });
  assert.match(out, /"type":"result"/); // the stream still reaches the host untouched
  const u = JSON.parse(fs.readFileSync(path.join(dir, "alternate.json"), "utf8"));
  assert.equal(u.fiveHour, 50);
  assert.equal(u.week, 64);
  assert.equal(u.fiveHourResets, 1792075800);
  assert.equal(u.weekResets, 1792180800);
  assert.equal(u.source, "stream");
});

test("wrapper keeps the session alive when the usage file cannot be replaced", { skip: haveWrapper ? false : "wrapper not built" }, () => {
  const dir = tmp();
  const account = path.join(tmp(), "alternate");
  fs.mkdirSync(account);
  const file = path.join(dir, "alternate.json");
  fs.writeFileSync(file, "{}");
  // Read-only: on Windows deleting the file fails with an access error, which is not an IOException. Linux renames over a read-only file, so there the folder is made read-only.
  const locked = win ? file : dir;
  fs.chmodSync(locked, win ? 0o444 : 0o555);
  const out = runWrapper([process.execPath, path.join(__dirname, "fake-claude.js"), "--output-format", "stream-json", "--input-format", "stream-json"], {
    input: "", env: { ...process.env, ENTOMATICAL_USAGE_DIR: dir, CLAUDE_CONFIG_DIR: account }, encoding: "utf8",
  }); // execFileSync throws if the wrapper exits non-zero
  fs.chmodSync(locked, win ? 0o666 : 0o755);
  assert.match(out, /"type":"result"/);
  assert.equal(fs.readFileSync(file, "utf8"), "{}"); // the old reading stays
});

// Runs the wrapper over a child that prints these stream lines, for the account folder "alternate", after seeding its usage file.
function streamEvents(events, seed) {
  const dir = tmp();
  const account = path.join(tmp(), "alternate");
  fs.mkdirSync(account);
  const file = path.join(dir, "alternate.json");
  if (seed) fs.writeFileSync(file, JSON.stringify(seed));
  const script = events.map((e) => `console.log(${JSON.stringify(JSON.stringify(e))});`).join("");
  runWrapper([process.execPath, "-e", script], { input: "", env: { ...process.env, ENTOMATICAL_USAGE_DIR: dir, CLAUDE_CONFIG_DIR: account }, encoding: "utf8" });
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
}
const mergeSkip = !haveWrapper ? "wrapper not built" : false;
const ahead = Math.floor(Date.now() / 1000) + 3600;
const earlier = { fiveHour: 40, week: 92, fiveHourResets: ahead, weekResets: ahead + 1, at: Date.now() - 60_000, source: "stream" };

test("wrapper records a rejected rate_limit_event with no unifiedWindows as that window at 100%", { skip: mergeSkip }, () => {
  const u = streamEvents([{ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1793329200 } }], earlier);
  assert.equal(u.week, 100);
  assert.equal(u.weekResets, 1793329200);
  assert.equal(u.fiveHour, 40); // not mentioned, so kept
  assert.equal(u.fiveHourResets, ahead);
  assert.equal(u.source, "stream");
  assert.ok(u.at > earlier.at);
  const five = streamEvents([{ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1792090000,
    unifiedWindows: { five_hour: { utilization: 0.97, resetsAt: 1792090000 }, seven_day: { utilization: 0.5, resetsAt: 1792180800 } } } }]);
  assert.deepEqual([five.fiveHour, five.fiveHourResets, five.week, five.weekResets], [100, 1792090000, 50, 1792180800]);
});

test("wrapper keeps the other window when an event names only one", { skip: mergeSkip }, () => {
  const u = streamEvents([{ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1792100000 } } } }], earlier);
  assert.deepEqual([u.fiveHour, u.fiveHourResets, u.week, u.weekResets], [10, 1792100000, 92, ahead + 1]);
  // A window whose reset has passed is not carried forward.
  const stale = streamEvents([{ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { seven_day: { utilization: 0.3, resetsAt: ahead } } } }], { ...earlier, fiveHourResets: 1000 });
  assert.deepEqual([stale.fiveHour, stale.fiveHourResets, stale.week], [null, null, 30]);
  // No earlier file: the window not mentioned is null, as before.
  const fresh = streamEvents([{ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { seven_day: { utilization: 0.3, resetsAt: 1792180800 } } } }]);
  assert.deepEqual([fresh.fiveHour, fresh.fiveHourResets, fresh.week, fresh.weekResets], [null, null, 30, 1792180800]);
});

test("wrapper leaves usage alone for per-model and extra-usage limits, and caps over-limit readings at 100", { skip: mergeSkip }, () => {
  // The shape of the 28 Oct 2026 Fable limit (test/account-fallback.test.js): a per-model weekly bucket, not the account's week.
  const fable = { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day_overage_included", resetsAt: 1793329200 } };
  assert.equal(streamEvents([fable]), undefined);
  assert.deepEqual(streamEvents([fable], earlier), earlier);
  const over = streamEvents([{ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 1.04, resetsAt: 1792180800 } }]);
  assert.deepEqual([over.week, over.weekResets, over.fiveHour], [100, 1792180800, null]);
});

test("wrapper ignores lines that are not rate_limit_event", { skip: haveWrapper ? false : "wrapper not built" }, () => {
  const dir = tmp();
  runWrapper([process.execPath, "-e", "console.log('{\"type\":\"system\"}'); console.log('plain text')"], { input: "", env: { ...process.env, ENTOMATICAL_USAGE_DIR: dir }, encoding: "utf8" });
  assert.deepEqual(fs.readdirSync(dir), []);
});

const { usageWindow } = require("../media/usage.js");
test("quota display distinguishes zero, unknown, stale, limit reached and elapsed reset", () => {
  const reading = { at: Date.parse("2026-11-05T00:00:00Z"), week: 10, weekResets: Date.parse("2026-11-05T01:00:00Z") / 1000 };
  assert.match(usageWindow(reading, "week", reading.at, "Etc/GMT+7").reset, /06:00\s*p\.?m\.?|18:00/i);
  const now = Date.now();
  const u = { fiveHour: 0, week: 100, fiveHourResets: now / 1000 + 3600, at: now };
  assert.equal(usageWindow(u, "fiveHour", now).value, 0);
  assert.match(usageWindow(u, "fiveHour", now).text, /100% remaining/);
  assert.equal(usageWindow(u, "week", now).tone, "limited");
  assert.equal(usageWindow({ ...u, at: now - 900_000 }, "fiveHour", now).tone, "stale");
  assert.equal(usageWindow({ ...u, fiveHourResets: now / 1000 - 1 }, "fiveHour", now).value, undefined);
  for (const value of [null, undefined, "25", -1, 101, NaN, Infinity]) {
    assert.equal(usageWindow({ ...u, fiveHour: value }, "fiveHour", now).text, "Not reported");
  }
  assert.equal(usageWindow(undefined, "week", now).value, undefined);
});

const { usageLine, columnsKey } = require("../media/usage.js");
test("a reached limit stays limited while its reset is ahead, however old the reading", () => {
  const now = Date.now(), old = now - 3 * 3600_000;
  const u = { fiveHour: 100, week: 100, fiveHourResets: now / 1000 + 600, at: old };
  assert.equal(usageWindow(u, "fiveHour", now).tone, "limited");
  assert.match(usageWindow(u, "fiveHour", now).text, /last reported/);
  assert.equal(usageWindow(u, "week", now).tone, "stale", "no reset time reported: an old 100% may have reset, so it greys");
  assert.equal(usageWindow({ ...u, fiveHourResets: now / 1000 - 1 }, "fiveHour", now).tone, "unknown", "its reset passed");
  assert.equal(usageWindow({ ...u, fiveHour: 90 }, "fiveHour", now).tone, "stale");
});

test("Switch account's usage line says when a window reset and how old a reading is", () => {
  const now = Date.now();
  assert.equal(usageLine(undefined, now), "Usage not reported yet.");
  assert.equal(usageLine({ fiveHour: 20, week: 40.4, at: now - 60_000 }, now), "5-hour 20% · weekly 40%");
  assert.equal(usageLine({ fiveHour: 100, week: 40, fiveHourResets: now / 1000 - 5, weekResets: now / 1000 + 9999, at: now - 3 * 3600_000 }, now),
    "5-hour has reset since the last reading · weekly 40% · last reported 3 h ago");
  assert.equal(usageLine({ week: 5, at: now - 20 * 60_000 }, now), "5-hour unknown · weekly 5% · last reported 20 min ago");
});

test("a Claude Max account shows no 5-hour limit unless its reading has one; other plans and Codex windows keep theirs", () => {
  const { fiveHourShown } = require("../media/usage.js");
  const now = Date.now();
  const u = { fiveHour: 20, week: 40, at: now - 60_000 };
  assert.equal(usageLine({ fiveHour: null, week: 40, at: now - 60_000 }, now, "max"), "weekly 40%"); // Max 20x reports none
  assert.equal(usageLine(u, now, "max"), "5-hour 20% · weekly 40%"); // Max 5x still reports one (4 November 2026)
  assert.equal(usageLine({ week: 5, at: now - 20 * 60_000 }, now, "max"), "weekly 5% · last reported 20 min ago");
  assert.equal(usageLine(u, now, "pro"), "5-hour 20% · weekly 40%");
  assert.equal(usageLine(u, now), "5-hour 20% · weekly 40%");
  const codex = { windows: [{ minutes: 300, pct: 10 }, { minutes: 7 * 1440, pct: 5 }], at: now - 60_000 };
  assert.equal(usageLine(codex, now, "max"), "5-hour 10% · weekly 5%", "a provider's own windows are shown as reported");
  assert.deepEqual(["max", "Max", "max_20x", "pro", "team", "", undefined].map((p) => fiveHourShown(p)), [false, false, false, true, true, true, true]);
  assert.deepEqual(["max", "pro"].map((p) => fiveHourShown(p, { fiveHour: 100 })), [true, true]); // a Max account at its 5-hour limit shows it
});

test("the 15-second usage re-post leaves the task columns alone; a task change redraws them", () => {
  const base = { tasks: [{ id: "a", status: "running" }], live: [], accountRows: [{ usage: { at: 1 } }], activeAccount: "x" };
  assert.equal(columnsKey(base), columnsKey({ ...base, accountRows: [{ usage: { at: 2 } }], activeAccount: "y" }));
  assert.notEqual(columnsKey(base), columnsKey({ ...base, tasks: [{ id: "a", status: "review" }] }));
  assert.notEqual(columnsKey(base), columnsKey({ ...base, live: ["a"] }));
});

test("usage cache validates timestamps and individual windows, and normalizes the main folder", () => {
  const dir = tmp();
  assert.equal(s.usageKey(path.join(os.homedir(), ".claude")), "main");
  const file = path.join(dir, "main.json");
  for (const raw of [null, [], {}, { at: "yesterday" }, { at: Date.now() + 120_000 }]) {
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.equal(s.readUsage("", dir), undefined);
  }
  fs.writeFileSync(file, JSON.stringify({ at: Date.now(), fiveHour: null, week: 0, weekResets: -2 }));
  const u = s.readUsage("", dir);
  assert.equal(u.fiveHour, undefined);
  assert.equal(u.week, 0);
  assert.equal(u.weekResets, undefined);
  assert.equal(u.windows, undefined); // Claude's reading carries no provider windows
  // A provider's own windows (Codex) survive the cache with their lengths; a window without a length, or a bad percent, is dropped or blanked.
  fs.writeFileSync(file, JSON.stringify({ at: Date.now(), windows: [{ minutes: 10080, pct: 3, resets: 1793608189 }, { minutes: 300, pct: 120, resets: 0 }, { pct: 5 }] }));
  assert.deepEqual(s.readUsage("", dir).windows, [{ minutes: 10080, pct: 3, resets: 1793608189 }, { minutes: 300, pct: undefined, resets: undefined }]);
  fs.writeFileSync(file, JSON.stringify({ at: Date.now(), windows: [] }));
  assert.equal(s.readUsage("", dir).windows, undefined);
});

test("a window is named by its real length: Claude's two keep their names, Codex's others say how long they are", () => {
  assert.equal(s.windowName(300), "5-hour");
  assert.equal(s.windowName(10080), "weekly");
  assert.equal(s.windowName(60), "1-hour");
  assert.equal(s.windowName(1440), "1-day");
  assert.equal(s.windowName(43200), "30-day");
});

test("main-account panel launch clears an inherited IDE account; other sessions keep it", { skip: !haveWrapper }, () => {
  const repo = tmp();
  const launch = path.join(repo, ".entomatical", "launch");
  fs.mkdirSync(launch, { recursive: true });
  const id = "12345678-1234-1234-1234-123456789abc";
  fs.writeFileSync(path.join(launch, `${id}.txt`), [repo, "", path.join(repo, "hooks.json")].join("\r\n"));
  const script = "console.log(process.env.CLAUDE_CONFIG_DIR || 'main')";
  const options = { cwd: repo, input: "", env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(repo, "second") }, encoding: "utf8" };
  const out = runWrapper([process.execPath, "-e", script, "--", "--input-format", "stream-json", "--resume", id], options);
  assert.equal(out.trim(), "main");
  const normal = runWrapper([process.execPath, "-e", script, "--", "--input-format", "stream-json"], options);
  assert.equal(normal.trim(), path.join(repo, "second"));
});

test("a new panel task gets --name from its launch file; an empty name line adds nothing", { skip: !haveWrapper }, () => {
  const repo = tmp();
  const launch = path.join(repo, ".entomatical", "launch");
  fs.mkdirSync(launch, { recursive: true });
  const script = "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify(process.argv.slice(2))))";
  const run = (name) => {
    const prompt = path.join(launch, "p.prompt.txt");
    fs.writeFileSync(prompt, "hi", "utf8");
    fs.writeFileSync(path.join(launch, "pending.txt"), [repo, "", "", prompt, name].join("\r\n"));
    return JSON.parse(runWrapper([process.execPath, "-e", script, "--", "--input-format", "stream-json"], { cwd: repo, input: "", encoding: "utf8" }).trim());
  };
  assert.deepEqual(run("Fix the \"login\" page").slice(-2), ["--name", 'Fix the "login" page']); // quoting survives
  assert.equal(run("").includes("--name"), false);
});

// Seen on linux, 4 November 2026 (Claude Code 2.1.318): the extension starts claude with --permission-mode=<its own initial mode>,
// which outranks permissions.defaultMode in the task's --settings file, so a panel task picked Accept edits ran in "default" (F81).
test("a panel task's permission pick replaces the extension's --permission-mode; bypass only when the extension allows it", { skip: !haveWrapper }, () => {
  const repo = tmp();
  const launch = path.join(repo, ".entomatical", "launch");
  fs.mkdirSync(launch, { recursive: true });
  const id = "12345678-1234-1234-1234-123456789abc";
  const hooks = path.join(repo, "hooks.json");
  fs.writeFileSync(path.join(launch, `${id}.txt`), [repo, "", hooks].join("\r\n"));
  const script = "console.log(JSON.stringify(process.argv.slice(2)))";
  const run = (settings, ...extra) => {
    fs.writeFileSync(hooks, JSON.stringify(settings));
    const args = JSON.parse(runWrapper([process.execPath, "-e", script, "--", "--input-format", "stream-json", `--resume=${id}`, "--permission-mode=default", ...extra], { cwd: repo, input: "", encoding: "utf8" }).trim());
    return args.filter((a) => a.startsWith("--permission-mode"));
  };
  assert.deepEqual(run({ permissions: { defaultMode: "acceptEdits" } }), ["--permission-mode=acceptEdits"]);
  assert.deepEqual(run({ permissions: { defaultMode: "auto" } }), ["--permission-mode=auto"]);
  assert.deepEqual(run({}), ["--permission-mode=default"], "Default permissions leaves the extension's mode");
  assert.deepEqual(run({ permissions: { defaultMode: "bypassPermissions" } }), ["--permission-mode=default"]);
  assert.deepEqual(run({ permissions: { defaultMode: "bypassPermissions" } }, "--allow-dangerously-skip-permissions"), ["--permission-mode=bypassPermissions"]);
});

// Seen on Windows, 31 October 2026 (Claude Code 2.1.314): setting claudeProcessWrapper ("Use panel" at a first Start) makes the
// extension load its config cache through the wrapper, a stream-json session started with CLAUDE_CODE_CONFIG_PROBE=1 that shuts
// down within seconds. It took pending.txt, so the task's own panel opened a blank chat and the card kept the probe's session.
test("Claude Code's config probe leaves a new panel task's launch file for the task's own panel", { skip: !haveWrapper }, () => {
  const repo = tmp();
  const launch = path.join(repo, ".entomatical", "launch");
  fs.mkdirSync(launch, { recursive: true });
  const prompt = path.join(launch, "p.prompt.txt");
  fs.writeFileSync(prompt, "hi", "utf8");
  fs.writeFileSync(path.join(launch, "pending.txt"), [repo, "", "", prompt, "Probe check"].join("\r\n"));
  const script = "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify(process.argv.slice(2))))";
  const { CLAUDE_CODE_CONFIG_PROBE: _, ...env } = process.env;
  const run = (extra) => JSON.parse(runWrapper([process.execPath, "-e", script, "--", "--input-format", "stream-json"],
    { cwd: repo, input: "", env: { ...env, ...extra }, encoding: "utf8" }).trim());
  const probe = run({ CLAUDE_CODE_CONFIG_PROBE: "1" }); // as the extension's spawnConfigProbe starts it
  assert.equal(probe.includes("--name"), false);
  assert.deepEqual(fs.readdirSync(launch).sort(), ["p.prompt.txt", "pending.txt"], "the probe claimed nothing");
  const task = run({});
  assert.deepEqual(task.slice(-2), ["--name", "Probe check"]);
  assert.deepEqual(fs.readdirSync(launch), [], "the task's panel used the launch and prompt files");
});

// Skipped on Windows: the earlier wrapper here is a shell script, and HOME does not move os.homedir() there (USERPROFILE does).
// test/launcher.test.js checks the first prompt through the Windows launcher.
test("wrapper runs a board session in its worktree, through the earlier wrapper, with the first prompt after the first line", { skip: win && "this test's earlier wrapper is a shell script" }, () => {
  const repo = tmp();
  const home = tmp();
  const worktree = path.join(repo, ".entomatical", "wt", "abc123");
  const launch = path.join(repo, ".entomatical", "launch");
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(launch);
  const hooks = path.join(repo, "hooks.json");
  const promptFile = path.join(launch, "abc123.prompt.txt");
  fs.writeFileSync(hooks, "{}");
  fs.writeFileSync(promptFile, 'Line "one"\nline two');
  fs.writeFileSync(path.join(launch, "pending.txt"), [worktree, "", hooks, promptFile].join("\r\n"));
  // The earlier wrapper notes that it ran, then starts claude as a real one would.
  const mark = path.join(home, "inner-ran");
  const bin = fs.mkdtempSync(path.join(__dirname, "..", "out", "bin-")); // os.tmpdir() can be mounted noexec
  made.push(bin);
  const inner = path.join(bin, "inner.sh");
  fs.writeFileSync(inner, `#!/bin/sh\necho "$PWD" > "${mark}"\nexec "$@"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, ".entomatical"));
  fs.writeFileSync(path.join(home, ".entomatical", "inner-wrapper"), inner + "\n");
  // Fake claude: prints its cwd and arguments, then echoes stdin.
  const fake = path.join(home, "echo-claude.js");
  fs.writeFileSync(fake, "console.log(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) })); process.stdin.pipe(process.stdout);");
  const out = runWrapper([process.execPath, fake, "--input-format", "stream-json"], {
    cwd: repo, input: '{"type":"control_request"}\n{"type":"second"}\n', env: { ...process.env, HOME: home }, encoding: "utf8",
  });
  const [first, initialize, injected, second] = out.trim().split("\n");
  const ran = JSON.parse(first);
  assert.equal(ran.cwd, worktree);
  assert.deepEqual(ran.argv, ["--input-format", "stream-json", "--settings", hooks]);
  assert.equal(initialize, '{"type":"control_request"}');
  assert.deepEqual(JSON.parse(injected), { type: "user", message: { role: "user", content: 'Line "one"\nline two' } });
  assert.equal(second, '{"type":"second"}');
  assert.equal(fs.readFileSync(mark, "utf8").trim(), worktree);
  assert.deepEqual(fs.readdirSync(launch), []); // the launch and prompt files are used up
});

test("a resumed panel session gets its launch file's prompt once, after the first line; the launch file stays for later resumes", { skip: win && "this test's earlier wrapper is a shell script" }, () => {
  const repo = tmp();
  const home = tmp();
  const worktree = path.join(repo, ".entomatical", "wt", "abc123");
  const launch = path.join(repo, ".entomatical", "launch");
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(launch);
  fs.mkdirSync(path.join(home, ".entomatical"));
  const hooks = path.join(repo, "hooks.json");
  const promptFile = path.join(launch, "abc123.prompt.txt");
  const sid = "0b4f7c2e-1d3a-4c5b-9e8f-112233445566";
  fs.writeFileSync(hooks, "{}");
  fs.writeFileSync(promptFile, "Resume.");
  fs.writeFileSync(path.join(launch, `${sid}.txt`), [worktree, "", hooks, promptFile, "T"].join("\r\n"));
  const fake = path.join(home, "echo-claude.js");
  fs.writeFileSync(fake, "console.log(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) })); process.stdin.pipe(process.stdout);");
  const resume = () => runWrapper([process.execPath, fake, "--input-format", "stream-json", `--resume=${sid}`], {
    cwd: repo, input: '{"type":"control_request"}\n{"type":"second"}\n', env: { ...process.env, HOME: home }, encoding: "utf8",
  }).trim().split("\n");
  const [first, initialize, injected, second] = resume();
  assert.equal(JSON.parse(first).cwd, worktree);
  assert.deepEqual(JSON.parse(first).argv, ["--input-format", "stream-json", `--resume=${sid}`, "--settings", hooks], "no --name on a resume");
  assert.equal(initialize, '{"type":"control_request"}');
  assert.deepEqual(JSON.parse(injected), { type: "user", message: { role: "user", content: "Resume." } });
  assert.equal(second, '{"type":"second"}');
  assert.deepEqual(fs.readdirSync(launch), [`${sid}.txt`], "the prompt file is used up; the session's launch file stays");
  assert.deepEqual(resume().slice(1), ['{"type":"control_request"}', '{"type":"second"}'], "a later resume from the panel's history sends nothing");
});

// Readings log (FEATURES.md F56): every reading with the session that saw it, so a later study can put each change in the limits
// beside the API calls hook.js records.
const readingsOf = (dir, key) => fs.readFileSync(path.join(dir, `${key}.readings.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("statusline.js logs a reading that changed, with its session", () => {
  const dir = tmp();
  const at = (five) => JSON.stringify({ session_id: "s1", rate_limits: { five_hour: { used_percentage: five, resets_at: 1 }, seven_day: { used_percentage: 12, resets_at: 2 } } });
  run("alternate", at(7), dir);
  run("alternate", at(7), dir); // same reading: not logged again
  run("alternate", at(8), dir);
  assert.deepEqual(readingsOf(dir, "alternate").map((r) => [r.fiveHour, r.week, r.sessionId, r.source]), [[7, 12, "s1", "statusline"], [8, 12, "s1", "statusline"]]);
});

test("wrapper logs every rate_limit_event with its session and unrounded percentages", { skip: !haveWrapper ? "wrapper not built" : false }, () => {
  const dir = tmp();
  const account = path.join(tmp(), "alternate");
  fs.mkdirSync(account);
  const sid = "11111111-2222-3333-4444-555555555555";
  const ev = (u) => ({ type: "rate_limit_event", session_id: sid, rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: u, resetsAt: 1792100000 }, seven_day: { utilization: 0.3, resetsAt: 1792180800 } } } });
  const script = [ev(0.0712), ev(0.0748)].map((e) => `console.log(${JSON.stringify(JSON.stringify(e))});`).join("");
  runWrapper([process.execPath, "-e", script], { input: "", env: { ...process.env, ENTOMATICAL_USAGE_DIR: dir, CLAUDE_CONFIG_DIR: account }, encoding: "utf8" });
  const r = readingsOf(dir, "alternate");
  assert.deepEqual(r.map((x) => [x.fiveHour, x.week, x.sessionId, x.source]), [[7, 30, sid, "stream"], [7, 30, sid, "stream"]]);
  assert.ok(Math.abs(r[0].fiveHourExact - 7.12) < 1e-9 && Math.abs(r[1].fiveHourExact - 7.48) < 1e-9);
  // The board's file keeps its old shape.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "alternate.json"), "utf8")).fiveHourExact, undefined);
});
