const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-accounts-"));
test.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
const alt = path.join(fixture, "second-account");
const terminals = [];
const usageCalls = [];
let usageQuery = async () => ({ fiveHour: 25, week: 50, at: Date.now(), source: "query" });
let env = [];
let signedIn = true;
let email = "second@example.test";
const settings = new Map();
const rows = () => [{ configDir: "", loggedIn: true, email: "main@example.test" }, { configDir: alt, loggedIn: signedIn, email }];
const sessions = {
  ACCOUNTS_ROOT: path.join(fixture, "accounts"),
  USAGE_DIR: path.join(fixture, "usage"), usageKey: () => "test",
  DEFAULT_DIR: path.join(os.homedir(), ".claude"),
  sameFolder: (a, b) => path.resolve(a || sessions.DEFAULT_DIR).toLowerCase() === path.resolve(b || sessions.DEFAULT_DIR).toLowerCase(),
  accountFolders: () => ["", alt], accountStatuses: rows,
  authStatus: async (dir) => rows().find((r) => r.configDir === dir),
  freshAuthStatus: async (dir) => rows().find((r) => r.configDir === dir),
  claudeAccountEnv: require("../out/sessions.js").claudeAccountEnv,
  discoverAccounts: async () => [], readUsage: () => undefined, forgetAuthStatus: () => {},
  meantFor: require("../out/sessions.js").meantFor,
  writeFileAtomic: (file, data) => fs.writeFileSync(file, data),
};
const deleted = [];
const vscode = {
  TerminalExitReason: { Process: 2, User: 3 },
  ThemeIcon: class {},
  Uri: { file: (fsPath) => ({ fsPath }) },
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} },
  ConfigurationTarget: { Global: 1 },
  workspace: { fs: { delete: async (uri, options) => { deleted.push([uri.fsPath, options]); } }, getConfiguration: () => ({ get: () => env, update: async (key, next, target) => {
    assert.equal(key, "environmentVariables"); assert.equal(target, 1); env = next;
  } }) },
  window: {
    showInformationMessage() {}, showWarningMessage() {},
    showInputBox() { throw new Error("Reauthentication must not ask for input in VS Code"); },
    createTerminal(options) {
      terminals.push(options);
      return { exitStatus: { code: 0, reason: vscode.TerminalExitReason.Process }, show() {}, dispose() {} };
    },
  },
};
const codexCalls = [];
const codex = { // never the real CLI: discovery would start it
  CODEX_DIR: path.join(fixture, ".codex"), codexBinary: () => "codex", codexTextPath: () => "codex", discoverCodex: async () => {},
  codexCommand: (args) => ({ file: "codex", args }),
  codexStatus: () => ({ loggedIn: true, email: "codex@example.test", plan: "pro", models: [] }),
  codexUsage: async () => { codexCalls.push("usage"); return { week: 40, at: Date.now(), source: "query" }; },
};
const logouts = []; // folders `claude auth logout` ran in; never the real CLI
const cp = require("node:child_process");
const childProcess = { ...cp, execFile: (file, args, options, done) => { if (args.join(" ") === "auth logout") logouts.push(options.env.CLAUDE_CONFIG_DIR ?? ""); done(null, "", ""); } };
const load = Module._load;
Module._load = function (name, ...rest) {
  return name === "child_process" ? childProcess : name === "vscode" ? vscode : name === "os" ? { ...os, homedir: () => fixture } : name === "./sessions" ? sessions : name === "./codex" ? codex : name === "./usage" ? {
    queryUsage: (dir, signal) => { usageCalls.push(dir); return usageQuery(dir, signal); },
  } : load.call(this, name, ...rest);
};
const a = require("../out/accounts.js");
Module._load = load;
a.initAccounts({
  get: (key, fallback) => settings.get(key) ?? fallback,
  update: async (key, value) => settings.set(key, value),
});

test("switch selects a signed-in account, preserves other settings, and follows external changes", async () => {
  const inherited = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    env = [{ name: "KEEP_ME", value: "unchanged" }, { name: "claude_config_dir", value: "C:\\old" }];
    await a.useAccount(alt);
    assert.deepEqual(env, [{ name: "KEEP_ME", value: "unchanged" }, { name: "CLAUDE_CONFIG_DIR", value: alt }]);
    assert.equal(a.activeConfigDir(), alt);
    assert.equal(a.accountRows().find((r) => r.configDir === alt).active, true);
    await a.useAccount("");
    assert.deepEqual(env, [{ name: "KEEP_ME", value: "unchanged" }]);
    assert.equal(a.activeConfigDir(), "");
    env.push({ name: "CLAUDE_CONFIG_DIR", value: alt.toUpperCase() });
    assert.equal(a.accountRows().find((r) => r.configDir === alt).active, true);
    const before = JSON.stringify(env);
    await assert.rejects(a.useAccount("C:\\unknown"), /Unknown account/);
    signedIn = false;
    await assert.rejects(a.useAccount(alt), /not signed in/);
    signedIn = true;
    settings.set("expectedEmails", { [alt]: "someone-else@example.test" });
    await assert.rejects(a.useAccount(alt), /different account/);
    settings.clear();
    process.env.CLAUDE_CONFIG_DIR = alt;
    await assert.rejects(a.useAccount(""), /inherited/);
    assert.equal(JSON.stringify(env), before);
  } finally {
    if (inherited === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = inherited;
  }
});

test("sign in again launches browser auth directly with saved, reported, or no email", async () => {
  try {
    for (const scenario of [
      { saved: undefined, reported: "second@example.test", want: "second@example.test" },
      { saved: "intended@example.test", reported: "wrong@example.test", want: "intended@example.test" },
      { saved: "saved@example.test", reported: undefined, want: "saved@example.test" },
      { saved: undefined, reported: undefined, want: undefined },
    ]) {
      settings.set("expectedEmails", scenario.saved ? { [alt]: scenario.saved } : {});
      email = scenario.reported;
      await a.logIn(alt);
      const terminal = terminals.at(-1);
      assert.equal(terminal.shellPath, "claude");
      assert.deepEqual(terminal.shellArgs, ["auth", "login", ...(scenario.want ? ["--email", scenario.want] : [])]);
      assert.equal(terminal.env.CLAUDE_CONFIG_DIR, alt);
    }
    await a.logIn("", "Main@Example.Test");
    assert.deepEqual(terminals.at(-1).shellArgs, ["auth", "login", "--email", "main@example.test"]);
    assert.equal(terminals.at(-1).env.CLAUDE_CONFIG_DIR, null);
    const count = terminals.length;
    await assert.rejects(a.logIn("unknown-folder"), /Unknown account/);
    assert.equal(terminals.length, count);
    assert.ok(usageCalls.includes(alt));
    assert.ok(usageCalls.includes(""));
  } finally {
    settings.clear();
    email = "second@example.test";
  }
});

test("Claude sign-in requires this terminal's success and fresh evidence for the intended folder and email", async (t) => {
  const intended = "expected@example.test";
  const binding = { [alt]: intended, "": "main@example.test" };
  const credentials = path.join(alt, ".credentials.json");
  const history = path.join(alt, "projects", "fixture", "session.jsonl");
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.writeFileSync(credentials, '{"fixture":"previous login"}');
  fs.writeFileSync(history, '{"fixture":"previous session"}\n');
  settings.set("expectedEmails", binding);
  t.after(() => settings.clear());
  const info = t.mock.method(vscode.window, "showInformationMessage", () => {});
  const warn = t.mock.method(vscode.window, "showWarningMessage", () => {}); // dismiss Try again
  const reason = vscode.TerminalExitReason;
  for (const [exitStatus, fresh, warning] of [
    [{ code: 1, reason: reason.Process }, undefined, /failed \(exit code 1\)/],
    [{ code: 0, reason: reason.User }, undefined, /cancelled/],
    [{ code: undefined, reason: reason.Process }, undefined, /not confirmed/],
    [undefined, undefined, /not confirmed/], // deadline without a terminal outcome
    [{ code: 0, reason: reason.Process }, undefined, /Could not verify/],
    [{ code: 0, reason: reason.Process }, { loggedIn: false }, /not logged in/],
    [{ code: 0, reason: reason.Process }, { loggedIn: true, email }, /Claude reported second@example\.test/],
    [{ code: 0, reason: reason.Process }, { loggedIn: true }, /Claude reported no email/],
    [{ code: 0, reason: reason.Process }, { loggedIn: true, email: intended }, undefined],
  ]) {
    info.mock.resetCalls();
    warn.mock.resetCalls();
    const usageBefore = usageCalls.length;
    let disposed = false;
    const terminal = t.mock.method(vscode.window, "createTerminal", (options) => {
      assert.deepEqual(options.shellArgs, ["auth", "login", "--email", intended]);
      assert.equal(options.env.CLAUDE_CONFIG_DIR, alt);
      return { exitStatus, show() {}, dispose() { disposed = true; } };
    });
    const status = t.mock.method(sessions, "freshAuthStatus", async dir => {
      assert.equal(dir, alt);
      return fresh && { configDir: dir, ...fresh };
    });
    const listing = t.mock.method(sessions, "accountStatuses", () =>
      rows().map(row => fresh && row.configDir === alt ? { configDir: alt, ...fresh } : row));
    // Advance the ten-minute timeout without waiting or changing the login terminal.
    let time = 0;
    const clock = !exitStatus && t.mock.method(Date, "now", () => time += 600001);
    await a.logIn(alt);
    if (clock) clock.mock.restore();
    const completed = exitStatus?.reason === reason.Process && exitStatus.code === 0;
    assert.equal(status.mock.callCount(), completed ? 1 : 0);
    assert.equal(disposed, completed);
    const notices = info.mock.calls.map(call => call.arguments[0]).filter(m => m.includes("is signed in"));
    assert.deepEqual(notices, warning ? [] : [`Entomatical: second-account is signed in as ${intended}.`]);
    if (warning) assert.match(warn.mock.calls[0].arguments[0], warning);
    else assert.equal(warn.mock.callCount(), 0);
    assert.equal(usageCalls.length - usageBefore, warning ? 0 : 1);
    assert.equal(terminal.mock.callCount(), 1);
    assert.deepEqual(logouts, []);
    assert.equal(fs.readFileSync(credentials, "utf8"), '{"fixture":"previous login"}');
    assert.equal(fs.readFileSync(history, "utf8"), '{"fixture":"previous session"}\n');
    assert.deepEqual(settings.get("expectedEmails"), binding);
    status.mock.restore();
    listing.mock.restore();
    terminal.mock.restore();
  }
});

test("Add signs an account into its own folder when another folder reports that email in error", async (t) => {
  const owner = "owner@example.test", other = "other@example.test";
  const ownFolder = path.join(sessions.ACCOUNTS_ROOT, other);
  settings.set("expectedEmails", { [alt]: owner });
  t.after(() => settings.clear());
  t.mock.method(sessions, "usageKey", () => "add-mismatch");
  const reported = dir => ({ configDir: dir, loggedIn: true, email: other });
  let listed = [];
  t.mock.method(sessions, "accountFolders", () => fs.existsSync(ownFolder) ? [alt, ownFolder] : [alt]);
  t.mock.method(sessions, "accountStatuses", () => listed);
  t.mock.method(sessions, "freshAuthStatus", async dir => reported(dir));
  t.mock.method(sessions, "discoverAccounts", async () => { listed = sessions.accountFolders().map(reported); });
  t.mock.method(vscode.window, "showInputBox", async () => other);
  const info = t.mock.method(vscode.window, "showInformationMessage", () => {});
  const starts = terminals.length, quota = usageCalls.length;

  await a.logIn(alt);
  assert.equal(a.accountRows().find(r => r.configDir === alt).expected, owner);
  assert.deepEqual(usageCalls.slice(quota), []);
  await a.addAccount();
  assert.deepEqual(terminals.slice(starts).map(term => term.env.CLAUDE_CONFIG_DIR), [alt, ownFolder]);
  assert.deepEqual(usageCalls.slice(quota), [ownFolder]);
  assert.equal(a.accountRows().find(r => r.configDir === ownFolder).expected, undefined);
  assert.ok(info.mock.calls.some(c => c.arguments[0].includes(`is signed in as ${other}`)));
  await a.addAccount();
  assert.equal(terminals.length, starts + 2);
  assert.match(info.mock.calls.at(-1).arguments[0], /already signed in \(other@example\.test\)/);
  assert.deepEqual(logouts, []);
});

test("Log In refuses success and quota when the rescan changes the verified identity", async (t) => {
  const intended = "owner@example.test", other = "other@example.test";
  settings.set("expectedEmails", { [alt]: intended });
  t.after(() => settings.clear());
  t.mock.method(sessions, "usageKey", () => "rescan-change");
  let listed = { configDir: alt, loggedIn: true, email: intended };
  t.mock.method(sessions, "accountStatuses", () => [listed]);
  t.mock.method(sessions, "freshAuthStatus", async () => listed);
  t.mock.method(sessions, "discoverAccounts", async () => { listed = { ...listed, email: other }; });
  const info = t.mock.method(vscode.window, "showInformationMessage", () => {});
  const warn = t.mock.method(vscode.window, "showWarningMessage", () => {});
  const quota = usageCalls.length;
  await a.logIn(alt);
  const row = a.accountRows().find(r => r.configDir === alt);
  assert.deepEqual([row.email, row.expected], [other, intended]);
  assert.equal(info.mock.calls.filter(c => c.arguments[0].includes("is signed in")).length, 0);
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(usageCalls.slice(quota), []);
  assert.deepEqual(logouts, []);
});

test("Cancel in Add account leaves the existing login alone, and discovery binds an unbound folder", async (t) => {
  t.mock.method(vscode.window, "showInputBox", async () => undefined);
  const count = terminals.length;
  await a.addAccount();
  assert.equal(terminals.length, count);
  assert.deepEqual(logouts, []);
  settings.clear();
  await a.rescan();
  assert.deepEqual(settings.get("expectedEmails"), { "": "main@example.test", [alt]: email });
  settings.clear();
});

test("usage refresh coalesces clicks, preserves readings on failure, and cancels old-account results", async () => {
  const file = path.join(sessions.USAGE_DIR, "test.json");
  const old = fs.readFileSync(file, "utf8");
  let complete;
  let signal;
  usageQuery = (_, s) => { signal = s; return new Promise((resolve) => { complete = resolve; }); };
  const first = a.refreshAccountUsage(alt);
  assert.equal(a.refreshAccountUsage(alt), first);
  assert.equal(a.accountRows().find(r => r.configDir === alt).usageRefreshing, true);
  a.disposeAccounts();
  assert.equal(signal.aborted, true);
  complete({ fiveHour: 99, at: Date.now(), source: "query" });
  await first;
  assert.equal(fs.readFileSync(file, "utf8"), old);
  usageQuery = async () => { throw new Error("Usage refresh timed out. Try Refresh again."); };
  await a.refreshAccountUsage(alt);
  const row = a.accountRows().find(r => r.configDir === alt);
  assert.equal(row.usageRefreshing, false);
  assert.match(row.usageError, /timed out/);
  assert.equal(fs.readFileSync(file, "utf8"), old);
});

test("the 15-minute poll asks one account at a time; Refresh asks all at once", async () => {
  let running = 0, most = 0;
  usageQuery = async () => { most = Math.max(most, ++running); await new Promise((r) => setTimeout(r, 5)); running--; return { week: 10, at: Date.now(), source: "query" }; };
  await a.rescan(true, true);
  assert.equal(most, 1);
  await a.rescan(true);
  assert.equal(most, 2);
});

test("a usage query goes to the readings log, with null when the CLI reports no 5-hour window", async () => {
  usageQuery = async () => ({ week: 10, at: Date.now(), source: "query" });
  const dir = a.accountRows().find((r) => !r.provider).configDir;
  await a.refreshAccountUsage(dir);
  const file = sessions.usageKey(dir) + ".readings.jsonl";
  const last = JSON.parse(fs.readFileSync(path.join(sessions.USAGE_DIR, file), "utf8").trim().split("\n").at(-1));
  assert.deepEqual([last.fiveHour, last.fiveHourResets, last.week, last.source], [null, null, 10, "query"]);
});

test("refresh through disk to task cost keeps an unmeasured five-hour baseline unknown", async () => {
  const { parseUsage } = require("../out/usage.js");
  const { readUsage } = require("../out/sessions.js");
  const { startReading, taskCost } = require("../out/usage-history.js");
  const cached = () => readUsage(alt, sessions.USAGE_DIR, sessions.usageKey(alt));
  const resets_at = new Date(Date.now() - 60_000).toISOString();
  usageQuery = async () => parseUsage({ rate_limits: { five_hour: { utilization: null, resets_at },
    limits: [{ kind: "weekly_all", percent: 19 }] } });
  await a.refreshAccountUsage(alt);
  const before = cached();
  assert.equal(before.fiveHour, undefined);
  assert.equal(before.fiveHourResets, undefined);
  const start = startReading(before, before.at);

  usageQuery = async () => parseUsage({ rate_limits: { five_hour: { utilization: 63 }, seven_day: { utilization: 21 } } });
  await a.refreshAccountUsage(alt);
  const end = cached();
  const cost = taskCost([{ startedAt: before.at, start, endedAt: end.at, end }]);
  assert.deepEqual(cost.windows, [{ name: "5-hour", incomplete: true }, { name: "weekly", points: 2 }]);
});

test("a reply with only conflicting account meters clears the previous cached number", async () => {
  const { parseUsage } = require("../out/usage.js");
  const { readUsage } = require("../out/sessions.js");
  const cached = () => readUsage(alt, sessions.USAGE_DIR, sessions.usageKey(alt));
  const five_hour = { utilization: 12, resets_at: "2027-01-01T00:00:00Z" };
  usageQuery = async () => parseUsage({ rate_limits: { five_hour } });
  await a.refreshAccountUsage(alt);
  assert.equal(cached().fiveHour, 12);
  usageQuery = async () => parseUsage({ rate_limits: { five_hour, limits: [{ kind: "session", percent: 96, resets_at: five_hour.resets_at }] } });
  await a.refreshAccountUsage(alt);
  const after = cached();
  assert.equal(after.fiveHour, undefined);
  assert.equal(after.fiveHourResets, undefined);
});

test("an empty or scoped-only server meter list replaces both cached numbers; a failed query retains its last reply", async () => {
  const { parseUsage } = require("../out/usage.js");
  const { readUsage } = require("../out/sessions.js");
  const cached = () => readUsage(alt, sessions.USAGE_DIR, sessions.usageKey(alt));
  for (const limits of [[], [{ kind: "weekly_scoped", group: "weekly", percent: 25, scope: { model: { display_name: "Fable" } } }]]) {
    usageQuery = async () => parseUsage({ rate_limits: { five_hour: { utilization: 82 }, seven_day: { utilization: 84 } } });
    await a.refreshAccountUsage(alt);
    const old = cached();
    usageQuery = async () => { throw new Error("synthetic failure"); };
    await a.refreshAccountUsage(alt);
    assert.deepEqual(cached(), old);
    usageQuery = async () => parseUsage({ rate_limits: { five_hour: null, seven_day: null, limits } });
    await a.refreshAccountUsage(alt);
    const next = cached();
    assert.deepEqual([next.fiveHour, next.week, next.quotaCoverage], [undefined, undefined, "incomplete"]);
  }
});

test("automatic fallback uses measured headroom or explicit weekly-only coverage after a cache round trip", async () => {
  const { parseUsage } = require("../out/usage.js");
  const { readUsage } = require("../out/sessions.js");
  const { bestAccount } = require("../out/orchestrator.js");
  const refresh = async limits => {
    usageQuery = async () => parseUsage({ rate_limits: { five_hour: null, limits } });
    await a.refreshAccountUsage(alt);
    return { name: "candidate", ...readUsage(alt, sessions.USAGE_DIR, sessions.usageKey(alt)) };
  };
  const measured = { name: "measured", fiveHour: 20, week: 20 };
  const weekly = { kind: "weekly_all", percent: 5 };
  const disputed = [{ kind: "session", percent: 96 }, { kind: "session", percent: 99 }];
  for (const rows of [[...disputed, { ...weekly, percent: 98 }, { ...weekly, percent: 99 }], [...disputed, weekly]]) {
    const candidate = await refresh(rows);
    assert.equal(bestAccount([candidate, measured]), "measured");
    assert.equal(bestAccount([candidate]), undefined);
  }
  assert.equal(bestAccount([measured, await refresh([weekly])]), "candidate");
});

test("the Codex account gets its own row and usage read, and is never a Claude IDE default", async () => {
  const row = a.accountRows().find((r) => r.provider === "codex");
  assert.deepEqual([row.configDir, row.email, row.plan, row.loggedIn, row.active], [codex.CODEX_DIR, "codex@example.test", "pro", true, false]);
  assert.ok(codexCalls.length >= 1); // read when the accounts were first scanned, because no reading existed
  const before = codexCalls.length;
  await a.refreshAccountUsage(codex.CODEX_DIR);
  assert.equal(codexCalls.length, before + 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(sessions.USAGE_DIR, "test.json"), "utf8")).week, 40);
  await assert.rejects(a.useAccount(codex.CODEX_DIR), /Unknown account/);
});

test("a failed or unconfirmed Codex login never reports an earlier valid sign-in as this attempt's success", async () => {
  const original = { create: vscode.window.createTerminal, info: vscode.window.showInformationMessage, warning: vscode.window.showWarningMessage };
  try {
    for (const code of [2, undefined, 0]) {
      const infos = [], warnings = [];
      let disposed = false;
      vscode.window.createTerminal = (options) => {
        assert.deepEqual([options.shellPath, options.shellArgs], ["codex", ["login"]]);
        return { exitStatus: { code }, show() {}, dispose() { disposed = true; } };
      };
      vscode.window.showInformationMessage = (text) => infos.push(text);
      vscode.window.showWarningMessage = (text) => warnings.push(text);
      await a.codexLogIn();
      assert.equal(infos.some((text) => text.includes("is signed in as")), code === 0);
      assert.equal(disposed, code === 0, "keep the failed terminal available for its real error");
      if (code === 2) assert.match(warnings.join("\n"), /sign-in failed \(exit code 2\)/);
      if (code === undefined) assert.match(warnings.join("\n"), /sign-in was not confirmed/);
    }
  } finally {
    vscode.window.createTerminal = original.create;
    vscode.window.showInformationMessage = original.info;
    vscode.window.showWarningMessage = original.warning;
  }
});

test("Grok profiles use separate homes, never claim a verified identity, and only allow known folders", async () => {
  const input = vscode.window.showInputBox;
  const warn = vscode.window.showWarningMessage;
  const createTerminal = vscode.window.createTerminal;
  const deletedBefore = deleted.length;
  try {
    vscode.window.showInputBox = async () => "first@example.test";
    await a.addGrokAccount();
    const first = path.join(fixture, ".grok-accounts", "first@example.test");
    assert.deepEqual(terminals.at(-1).shellArgs, ["login"]);
    assert.deepEqual(terminals.at(-1).env, { GROK_HOME: first, XAI_API_KEY: null, GROK_DEPLOYMENT_KEY: null });
    vscode.window.showInputBox = async () => "second";
    await a.addGrokAccount();
    const second = path.join(fixture, ".grok-accounts", "second");
    assert.equal(terminals.at(-1).env.GROK_HOME, second);
    const rows = a.accountRows().filter((r) => r.provider === "grok");
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => !r.loggedIn && !r.email && !r.usage));
    const defaultHome = path.join(fixture, ".grok");
    fs.mkdirSync(defaultHome);
    const defaultRow = a.accountRows().find((r) => r.provider === "grok" && r.configDir === defaultHome);
    assert.equal(defaultRow.removable, false);
    assert.deepEqual(a.externalProviderAccounts().filter((r) => r.provider === "grok"), [
      { name: "Grok · ~/.grok", configDir: defaultHome, provider: "grok" },
      { name: "Grok · first@example.test", configDir: first, provider: "grok" },
      { name: "Grok · second", configDir: second, provider: "grok" },
    ]);
    await assert.rejects(a.removeGrokAccount(defaultHome), /default Grok profile/);
    a.openGrok(first);
    assert.deepEqual(terminals.at(-1).shellArgs, []);
    assert.equal(terminals.at(-1).env.GROK_HOME, first);
    const mixed = 'xAi_Api_Key', prior = process.env[mixed];
    try {
      process.env[mixed] = 'test-only';
      const actual = Object.keys(process.env).find((k) => k.toUpperCase() === 'XAI_API_KEY');
      a.openGrok(first);
      assert.equal(terminals.at(-1).env[actual], null);
      assert.equal(terminals.at(-1).env.GROK_DEPLOYMENT_KEY, null);
    } finally { if (prior === undefined) delete process.env[mixed]; else process.env[mixed] = prior; }
    const live = { show() {}, dispose() {}, exitStatus: undefined };
    vscode.window.createTerminal = () => live;
    const login = a.grokLogIn(first);
    await assert.rejects(a.grokLogIn(first), /already in progress/);
    live.exitStatus = { code: 0 };
    await login;
    vscode.window.createTerminal = createTerminal;
    assert.throws(() => a.openGrok(path.join(first, "..", "unknown")), /Unknown Grok/);
    vscode.window.showInputBox = async () => "../escape";
    await assert.rejects(a.addGrokAccount(), /valid account label/);
    vscode.window.showInputBox = async () => "second";
    await assert.rejects(a.addGrokAccount(), /already exists/);
    vscode.window.showWarningMessage = async () => "Remove";
    await a.removeGrokAccount(first);
    assert.deepEqual(deleted.at(-1), [first, { recursive: true, useTrash: true }]);
  } finally {
    vscode.window.showInputBox = input;
    vscode.window.showWarningMessage = warn;
    vscode.window.createTerminal = createTerminal;
    deleted.splice(deletedBefore);
  }
});

test("Antigravity uses the shared sign-in, reports identity as unknown, and hiding does not delete it", async () => {
  const before = deleted.length, info = vscode.window.showInformationMessage, opened = terminals.length;
  const previousLogin = a.antigravityLoginId();
  await a.addAntigravityAccount(); // the offer is dismissed: no forced login over a working shared sign-in (F86)
  assert.equal(a.antigravityLoginId(), previousLogin);
  assert.equal(terminals.length, opened);
  assert.ok(a.accountRows().some((r) => r.provider === "antigravity"));
  const shown = [];
  vscode.window.showInformationMessage = async (message, ...choices) => { shown.push(message); return choices.find((c) => c === "Sign in"); };
  try { await a.addAntigravityAccount(); } finally { vscode.window.showInformationMessage = info; }
  const completedLogin = a.antigravityLoginId();
  assert.notEqual(completedLogin, previousLogin);
  assert.deepEqual(terminals.at(-1).shellArgs, ["acp", "--login"]);
  // agy waits in the terminal for the code the browser shows; the message says so (a browser-only sign-in sat unfinished, 6 November 2026).
  assert.ok(shown.some((m) => /paste the code it shows into the "Sign in Antigravity" terminal/.test(m)), shown.join(" | "));
  assert.deepEqual(terminals.at(-1).env, { GEMINI_HOME: null, GEMINI_API_KEY: null, GOOGLE_API_KEY: null, GOOGLE_APPLICATION_CREDENTIALS: null, AGY_ADC_AUTH: null });
  const row = a.accountRows().find((r) => r.provider === "antigravity");
  assert.equal(row.folder, "Shared Google sign-in");
  assert.equal(row.loggedIn, false);
  assert.equal(row.email, undefined);
  assert.ok(a.externalProviderAccounts().some((r) => r.name === "Antigravity · Shared" && r.provider === "antigravity"));
  a.openAntigravity();
  assert.deepEqual(terminals.at(-1).shellArgs, []);
  await a.hideAntigravityAccount();
  assert.equal(a.antigravityLoginId(), completedLogin);
  assert.equal(a.accountRows().some((r) => r.provider === "antigravity"), false);
  assert.equal(a.externalProviderAccounts().some((r) => r.provider === "antigravity"), false);
  assert.equal(deleted.length, before);
});

test("only a successful Antigravity login replaces the shared catalog's login identifier", async (t) => {
  const original = a.antigravityLoginId();
  const terminal = t.mock.method(vscode.window, "createTerminal", () => ({ exitStatus: { code: 1 }, show() {} }));
  await a.antigravityLogIn();
  assert.equal(a.antigravityLoginId(), original);
  terminal.mock.restore();
  await a.antigravityLogIn();
  assert.notEqual(a.antigravityLoginId(), original);
});

test("remove trashes an extra account folder after confirmation, but never the main folder or the IDE default", async () => {
  const inherited = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  const warn = vscode.window.showWarningMessage;
  try {
    await assert.rejects(a.removeAccount(""), /main account/);
    env = [{ name: "CLAUDE_CONFIG_DIR", value: alt }];
    await assert.rejects(a.removeAccount(alt), /IDE default/);
    env = [];
    await a.removeAccount(alt); // the dialog is dismissed
    assert.deepEqual(deleted, []);
    settings.set("expectedEmails", { [alt]: email, other: "keep@example.test" });
    vscode.window.showWarningMessage = async () => "Remove";
    signedIn = false; // a removed folder no longer reports a login (this stand-in keeps listing it)
    await a.removeAccount(alt);
    assert.deepEqual(deleted, [[alt, { recursive: true, useTrash: true }]]);
    assert.deepEqual(settings.get("expectedEmails"), { other: "keep@example.test", "": "main@example.test" }); // the rescan binds the main folder
  } finally {
    signedIn = true;
    vscode.window.showWarningMessage = warn;
    if (inherited === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = inherited;
  }
});

test("Add account is not refused because the Codex login uses the same email", async () => {
  const ask = vscode.window.showInputBox, info = vscode.window.showInformationMessage;
  const said = [];
  try {
    vscode.window.showInformationMessage = (m) => { said.push(m); };
    vscode.window.showInputBox = async () => "Codex@Example.Test";
    const count = terminals.length;
    await a.addAccount();
    assert.equal(terminals.length, count + 1, "a Claude login is started");
    assert.equal(terminals.at(-1).env.CLAUDE_CONFIG_DIR, path.join(sessions.ACCOUNTS_ROOT, "codex@example.test"));
    assert.ok(!said.some((m) => /already signed in/.test(m)));
    vscode.window.showInputBox = async () => "second@example.test"; // a Claude folder is already signed in as this email
    await a.addAccount();
    assert.equal(terminals.length, count + 1);
    assert.ok(said.some((m) => /already signed in \(second-account\)/.test(m)));
  } finally {
    vscode.window.showInputBox = ask; vscode.window.showInformationMessage = info;
    settings.clear();
  }
});

test("log in creates folders directly inside ~/.claude-accounts and preserves their intended address on Cancel", async (t) => {
  try {
    const count = terminals.length;
    for (const bad of [
      sessions.ACCOUNTS_ROOT + "-x", // a sibling that shares the prefix
      path.join(sessions.ACCOUNTS_ROOT + "-x", "someone"),
      path.join(sessions.ACCOUNTS_ROOT, "..", "escaped"),
      path.join(sessions.ACCOUNTS_ROOT, "a", "b"),
      path.join(sessions.ACCOUNTS_ROOT, "bad name"),
      sessions.ACCOUNTS_ROOT,
    ]) await assert.rejects(a.logIn(bad), /Unknown account/, bad);
    assert.equal(terminals.length, count);
    assert.equal(fs.existsSync(path.join(fixture, "escaped")), false);
    const newFolder = path.join(sessions.ACCOUNTS_ROOT, "first_tag@example.test");
    t.mock.method(vscode.window, "createTerminal", options => {
      terminals.push(options);
      return { exitStatus: { reason: vscode.TerminalExitReason.User }, show() {} };
    });
    await a.logIn(newFolder, "first+tag@example.test");
    assert.equal(terminals.at(-1).env.CLAUDE_CONFIG_DIR, newFolder);
    assert.deepEqual(terminals.at(-1).shellArgs, ["auth", "login", "--email", "first+tag@example.test"]);
    assert.equal(settings.get("expectedEmails")[newFolder], "first+tag@example.test");
    t.mock.method(sessions, "accountFolders", () => ["", alt, newFolder]);
    const before = terminals.length;
    await assert.rejects(a.logIn(newFolder, "first_tag@example.test"), /already belongs to first\+tag/);
    assert.equal(terminals.length, before);
    assert.deepEqual(logouts, []);
  } finally {
    settings.clear();
  }
});
