// The board's side of phase 2 (F69, F71, F75, F76): headless runs in hidden terminals, follow-up by resume, the inbox end to end,
// plan approval, settle notices, pause and Stop run, interruption after a reload, and the usage-limit handling. The same VS Code
// stand-in as test/orchestrator.test.js, plus terminals that can be "exited" by the test.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

class EventEmitter {
  listeners = [];
  event = (l) => (this.listeners.push(l), { dispose() {} });
  fire(e) { for (const l of this.listeners) l(e); }
  dispose() {}
}
const terminals = [];
const warnings = [], infos = [], commands = [];
const vscode = { EventEmitter, ThemeIcon: class {}, TabInputCustom: class { constructor(uri) { this.uri = uri; } }, ViewColumn: { Beside: -2 },
  commands: { executeCommand: async (...args) => { commands.push(args); } },
  Uri: { from: (parts) => ({ ...parts, toString: () => `${parts.scheme}://${parts.authority}${parts.path}` }), file: (p) => ({ fsPath: p }) },
  workspace: { openTextDocument: async (o) => ({ content: o?.content }), getConfiguration: () => ({ get: (_k, d) => d }) },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async (m) => { warnings.push(m); return undefined; }, showInformationMessage: async (m) => { infos.push(m); return undefined; }, showTextDocument: async () => undefined,
    createTerminal: (options) => { const t = { options, shows: [], sent: [], show: (p) => t.shows.push(p), dispose() { t.exitStatus = { code: 0 }; vscode.window.terminals = vscode.window.terminals.filter((x) => x !== t); }, exit(code = 0) { t.exitStatus = { code }; vscode.window.terminals = vscode.window.terminals.filter((x) => x !== t); }, sendText: (text) => t.sent.push(text), exitStatus: undefined, processId: Promise.resolve(4242) };
      terminals.push(t); vscode.window.terminals.push(t); return t; } } };
const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-orch2-home-"));
process.env.HOME = process.env.USERPROFILE = home;
process.env.ENTOMATICAL_USAGE_DIR = path.join(home, "usage");
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board } = require("../out/board.js");
const o = require("../out/orchestrator.js");

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const made = [], boards = [];
test.after(() => { for (const b of boards) b.dispose(); for (const d of made) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-orch2-"));
  made.push(repo);
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t"); sh(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false); // no 3 s poll: the tests tick by hand
  boards.push(board);
  board.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }, { name: "spare", configDir: path.join(home, "spare") }];
  board.accountFolderList = () => [path.join(home, "acct"), path.join(home, "spare")];
  board.preflightHeadless = async () => {};
  board.requestRateMs = 0; // the tests send requests faster than an orchestrator may
  board.tick();
  const runEvents = [];
  board.onRun((e) => runEvents.push(e));
  return { repo, board, runEvents };
}
const event = (board, id, e) => fs.appendFileSync(board.eventsFile(id), JSON.stringify({ t: Date.now(), ...e }) + "\n");
const statusLines = (board) => fs.existsSync(board.statusFile) ? fs.readFileSync(board.statusFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
/** An orchestrator card with its worktree, started headless (its hidden terminal is terminals.at(-1)). */
async function master(board, extra = {}) {
  const m = board.add("Run one", "Do the run.", "acct", undefined, "haiku", "low", undefined, { orchestrator: { caps: { ...o.DEFAULT_CAPS }, opened: 0 }, headless: true, ...extra });
  await board.startHeadless(m);
  event(board, m.id, { hook_event_name: "SessionStart", session_id: m.sessionId });
  return m;
}
const settle = (board, task) => { terminals.find((t) => t.options.name === `En ${task.id}` && !t.exitStatus)?.exit(0); event(board, task.id, { hook_event_name: "Stop", last_assistant_message: "done" }); board.syncStatus(task.id); };
async function request(board, body) {
  const inbox = path.join(board.dir, "inbox");
  const nonce = `n${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(path.join(inbox, `${nonce}.json`), JSON.stringify({ v: 1, at: "now", ...body }));
  await board.processInbox();
  for (let i = 0; i < 20 && !fs.existsSync(path.join(inbox, "done", `${nonce}.json`)); i++) await sleep(50);
  return JSON.parse(fs.readFileSync(path.join(inbox, "done", `${nonce}.json`), "utf8"));
}

test("a five-hour cap reads the selected Codex account's 300-minute meter independently of its weekly meter", async () => {
  const { board } = fixture();
  const root = await master(board, { approved: { at: "now", hash: "approved" }, orchestrator: { caps: { ...o.DEFAULT_CAPS, pointsFiveHour: 40 }, opened: 0 } });
  const name = "Codex · fixture";
  board.accountList = () => [{ name, provider: "codex" }];
  board.codexModelIds = () => [];
  const req = { op: "add", by: root.id, session: root.sessionId, title: "Worker", prompt: "fixture", account: name };
  const key = require("../out/sessions.js").usageKey(require("../out/codex.js").CODEX_DIR);
  fs.mkdirSync(process.env.ENTOMATICAL_USAGE_DIR, { recursive: true });
  const write = windows => fs.writeFileSync(path.join(process.env.ENTOMATICAL_USAGE_DIR, key + ".json"), JSON.stringify({ windows, at: Date.now(), source: "query" }));
  const week = { minutes: 10080, pct: 12 };
  write([week]);
  assert.match(board.refusalOf(req), /five-hour usage is unknown/);
  write([week, { minutes: 300, pct: 98 }]);
  assert.match(board.refusalOf(req), /account has used 98/);
  write([week, { minutes: 300, pct: 0 }]);
  assert.equal(board.refusalOf(req), undefined);
});

test("an explicit terminal start replaces the previous failure before the provider confirms", async () => {
  const { board } = fixture();
  const root = await master(board, { approved: { at: "now", hash: "approved" } });
  const child = board.add("Retry", "Start the original assignment", "acct", root.id, undefined, undefined, undefined,
    { headless: true, held: true, openedBy: root.id, watchedBy: root.id });
  board.update(child, { launchError: "previous refusal", startRetryAt: Date.now() - 1 });
  await board.startHeadless(child);
  assert.equal(child.launchError, undefined);
  assert.equal(child.startRetryAt, undefined);
  assert.equal(board.statusOf(child).launchState, "dispatched");
});

test("an agent-created worker integrates through its opener and returns the same acceptance receipt on retry", async () => {
  const { repo, board } = fixture();
  const root = await master(board, { approved: { at: "now", hash: "approved" } });
  const by = { by: root.id, session: root.sessionId };
  const added = await request(board, { ...by, op: "add", title: "Worker", prompt: "Deliver the correction." });
  assert.equal(added.started, true, JSON.stringify(added));
  const child = board.get(added.id);
  event(board, child.id, { hook_event_name: "SessionStart", session_id: child.sessionId });
  fs.writeFileSync(path.join(child.worktree, "a.txt"), "corrected\n");
  sh(child.worktree, "commit", "-qam", "worker result");
  settle(board, child);
  const accepted = await request(board, { ...by, op: "integrate", id: child.id });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.integrated.head, sh(child.worktree, "rev-parse", "HEAD"));
  assert.equal(sh(root.worktree, "show", "HEAD:a.txt"), "corrected");
  assert.equal(sh(repo, "show", "HEAD:a.txt"), "one");
  assert.deepEqual((await request(board, { ...by, op: "integrate", id: child.id })).integrated, accepted.integrated);
});

test("a Grok worker is preflighted and opened like any other runtime (run 0db6d1); its start goes through the ACP path", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "now", hash: "approved" } });
  board.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }, { name: "Grok · Work", provider: "grok", configDir: path.join(home, "grok") }];
  const preflights = [], acp = [];
  board.preflightHeadless = async (provider, configDir) => { preflights.push([provider, configDir]); };
  board.probeAcpCatalogs = false; // F92 catalog probe: checked in refused-start.test.js; these fakes count every session
  board.runAcp = (provider, cwd, profile) => { acp.push([provider, profile]); throw new Error("fake agent unavailable"); };
  const before = board.tasks.length;
  const result = await request(board, { op: "add", by: m.id, session: m.sessionId, title: "Worker", prompt: "Work", account: "Grok · Work" });
  assert.deepEqual(preflights, [["grok", path.join(home, "grok")]]);
  assert.deepEqual(acp, [["grok", path.join(home, "grok")]], "an unattended Grok card runs headless over ACP, not in a terminal");
  assert.equal(board.tasks.length, before + 1);
  assert.match(result.error, /Launch failed: fake agent unavailable/);
  assert.equal(board.get(result.id).provider, "grok");
});

test("an orchestrator card starts headless: a hidden terminal running claude -p through a script, the prompt in a file, --autocompact 150k, the hooks file with Bypass permissions", async () => {
  const { repo, board } = fixture();
  const m = await master(board);
  const term = terminals.at(-1);
  assert.equal(term.options.hideFromUser, true);
  assert.equal(term.options.shellPath, process.platform === "win32" ? "cmd.exe" : "/bin/sh");
  // Windows: cmd.exe starts .\<id>.run.cmd from the launch folder, and the script's cd /d puts claude in the worktree (F71, % in paths).
  assert.equal(term.options.cwd, process.platform === "win32" ? path.join(board.dir, "launch") : m.worktree);
  if (process.platform === "win32") assert.ok(fs.readFileSync(path.resolve(term.options.cwd, term.options.shellArgs.at(-1)), "utf8").includes(`cd /d "${m.worktree}"`));
  assert.equal(term.options.env.CLAUDE_CONFIG_DIR, path.join(home, "acct"));
  assert.equal(term.options.env.ENTOMATICAL_TASK, m.id);
  assert.equal(term.options.env.ENTOMATICAL_REPO, repo);
  assert.equal(term.options.env.ENTOMATICAL_SESSION, m.sessionId);
  const script = fs.readFileSync(path.resolve(term.options.cwd, term.options.shellArgs.at(-1)), "utf8").replace(/'/g, ""); // /bin/sh quotes each argument on Linux
  assert.match(script, /-p --output-format stream-json --verbose --permission-prompts none --settings .* --autocompact 150k --session-id /);
  assert.match(script, new RegExp(`< "?.*${m.id}\\.prompt\\.txt"?`));
  assert.match(fs.readFileSync(path.join(board.dir, "launch", `${m.id}.prompt.txt`), "utf8"), new RegExp(`Your Entomatical card is ${m.id}.*[\\s\\S]*Do the run.`));
  const hooks = JSON.parse(fs.readFileSync(board.hooksFile(m.id), "utf8"));
  assert.deepEqual(hooks.permissions, { defaultMode: "bypassPermissions" });
  assert.deepEqual([m.headless, m.status, board.own().includes(m.id), board.live().includes(m.id)], [true, "queued", true, true]);
  // The process exits: the terminal leaves the list, the card is no longer live.
  settle(board, m);
  assert.deepEqual([m.status, board.own().includes(m.id), board.terminal(m)], ["review", false, undefined]);
});

test("the inbox end to end: add opens a headless subtask with the opened-by line, after as dependsOn, the counters; refusals and the nonce are answered in done/", async () => {
  const { board, runEvents } = fixture();
  const m = await master(board);
  settle(board, m);
  const inbox = path.join(board.dir, "inbox");
  // Not approved yet.
  let r = await request(board, { op: "add", by: m.id, session: m.sessionId, title: "Child A", prompt: "Reply ready." });
  assert.equal(r.error, "Plan not approved");
  board.update(m, { approved: { at: "x", hash: "h" } });
  r = await request(board, { op: "add", by: m.id, session: m.sessionId, title: "Child A", prompt: "Reply ready.", model: "haiku", effort: "low" });
  assert.match(r.id, /^[0-9a-f]{6}$/);
  const a = board.get(r.id);
  assert.equal(r.launchState, "dispatched");
  assert.equal(board.statusOf(a).launchState, "dispatched");
  event(board, a.id, { hook_event_name: "SessionStart", session_id: a.sessionId, agent_id: "native-helper" });
  assert.equal(board.statusOf(a).launchState, "dispatched");
  event(board, a.id, { hook_event_name: "SessionStart", session_id: a.sessionId });
  assert.equal(board.statusOf(a).launchState, "confirmed");
  assert.deepEqual([a.title, a.parentId, a.openedBy, a.watchedBy, a.headless, a.model, a.effort, a.account, a.status, !!a.sessionId], ["Child A", m.id, m.id, m.id, true, "haiku", "low", "acct", "queued", true]);
  assert.equal(a.prompt, `Opened by orchestrator "Run one" (${m.id}) on ${new Date().toISOString().slice(0, 10)}.\n\nReply ready.`);
  assert.equal(m.orchestrator.opened, 1);
  assert.deepEqual(runEvents.map((e) => e.kind), ["started"]);
  assert.equal(terminals.at(-1).options.name, `En ${a.id}`);
  // A second child after the first, started manually: queued with dependsOn, no terminal.
  const before = terminals.length;
  r = await request(board, { op: "add", by: m.id, session: m.sessionId, title: "Child B", prompt: "Reply ready too.", after: [a.id], start: "manual" });
  const b = board.get(r.id);
  assert.equal(r.launchState, "queued");
  assert.deepEqual([b.dependsOn, b.sessionId, terminals.length, r.note], [[a.id], undefined, before, "queued (start: manual)"]);
  // A wrong session, a stranger's card, and an unknown field.
  assert.match((await request(board, { op: "add", by: m.id, session: "other", title: "x", prompt: "y" })).error, /^Not bound: session other/);
  assert.equal((await request(board, { op: "stop", by: m.id, session: m.sessionId, id: "ffffff" })).error, "No card ffffff");
  assert.equal((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "x", prompt: "y", top: true })).error, 'Unknown field "top" for add');
  // The same nonce again returns the earlier answer and opens nothing.
  const nonce = fs.readdirSync(path.join(inbox, "done")).find((f) => JSON.parse(fs.readFileSync(path.join(inbox, "done", f), "utf8")).id === a.id).slice(0, -5);
  const opened = m.orchestrator.opened;
  fs.writeFileSync(path.join(inbox, `${nonce}.json`), JSON.stringify({ v: 1, op: "add", by: m.id, session: m.sessionId, title: "Child A", prompt: "Reply ready." }));
  await board.processInbox();
  assert.deepEqual([m.orchestrator.opened, fs.existsSync(path.join(inbox, `${nonce}.json`)), JSON.parse(fs.readFileSync(path.join(inbox, "done", `${nonce}.json`), "utf8")).id], [opened, false, a.id]);
});

test("send queues while a child runs, delivers when idle, and remains receivable after takeover", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const { id } = await request(board, { op: "add", by: m.id, session: m.sessionId, title: "Child", prompt: "Reply ready." });
  const child = board.get(id);
  event(board, id, { hook_event_name: "SessionStart", session_id: child.sessionId });
  event(board, id, { hook_event_name: "UserPromptSubmit", prompt: "p" }); board.syncStatus(id);
  const response = await request(board, { op: "send", by: m.id, session: m.sessionId, id, text: "fix the failing test\nsecond line" });
  assert.equal(response.queued, true);
  assert.equal(child.status, "running");
  settle(board, child);
  board.deliverNotices(child.id);
  await sleep(100);
  assert.equal(child.followUps, 1);
  assert.match(fs.readFileSync(path.join(board.dir, "launch", `${id}.followup.txt`), "utf8"), /fix the failing test\nsecond line/);
  assert.equal(child.status, "running");
  settle(board, child);
  board.update(child, { followUps: 0, headless: undefined, takenOver: true });
  assert.equal((await request(board, { op: "send", by: m.id, session: m.sessionId, id, text: "message after takeover" })).ok, true);
  const messages = await request(board, { op: "receive", by: child.id, session: child.sessionId });
  assert.ok(messages.messages.some((text) => text.includes("message after takeover")));
});

test("plan: the master goes to Needs input with the steps counted; Approve records the hash, puts it back in Review and sends the approval as a headless follow-up", async () => {
  const { board } = fixture();
  const m = await master(board);
  settle(board, m);
  assert.equal((await request(board, { op: "plan", by: m.id, session: m.sessionId })).error, `No ORCHESTRATION.md in your worktree (${board.planFile(m)})`);
  fs.writeFileSync(board.planFile(m), "# Plan\n\n## Steps\n\n1. Open child A\n2. Open child B\n\n## Budget\n\n- 4 pp\n");
  const r = await request(board, { op: "plan", by: m.id, session: m.sessionId });
  assert.deepEqual([r.ok, r.note, m.status, m.plan.steps, m.plan.points, m.approved], [true, "2 steps, about 4 pp; waiting for the user's approval", "needs-input", 2, 4, undefined]);
  assert.equal((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "x", prompt: "y" })).error, "Plan not approved");
  // Only this master's terminals: `terminals` is shared by the whole file, and an earlier test's board can still open one late
  // under a loaded full run (seen 14 November 2026: 13 !== 12 below).
  const mine = () => terminals.filter((t) => t.options.name === `En ${m.id}`).length;
  const opened = mine();
  await board.approvePlan(m);
  assert.deepEqual([m.status, m.approved.hash.length, mine()], ["running", 12, opened + 1]);
  assert.match(fs.readFileSync(path.join(board.dir, "launch", `${m.id}.followup.txt`), "utf8"), /\n\nPlan approved by the user at \d\d:\d\d\. Open your first cards now/);
  // Approve while the master's hidden run is still ending: the approval waits, and goes once the terminal has closed (seen live, 4 Nov 2026).
  settle(board, m);
  board.update(m, { approved: undefined, plan: { at: "x", steps: 1, points: 2 }, status: "needs-input" });
  await board.followUpHeadless({ ...m }, "noop").catch(() => undefined); // not the card: just a live terminal under its name
  const live = terminals.at(-1);
  const count = mine();
  board.update(m, { status: "needs-input" });
  await board.approvePlan(m);
  assert.deepEqual([m.status, mine()], ["review", count], "nothing started while a run is still ending");
  live.exit(0);
  board.tick();
  await sleep(100);
  assert.equal(mine(), count + 1, "the approval went once the terminal closed");
  // A plan run while the master is still Running waits for its Stop before the card moves.
  settle(board, m);
  board.update(m, { approved: undefined, status: "running" });
  fs.writeFileSync(board.planFile(m), "## Steps\n- one\n");
  await request(board, { op: "plan", by: m.id, session: m.sessionId });
  assert.equal(m.status, "running");
  settle(board, m);
  assert.equal(m.status, "needs-input");
});

test("a master waiting for plan approval stays in Needs input after its hidden run has ended (linux, 4 Nov 2026: it went Interrupted 10 s later)", async () => {
  const { board } = fixture();
  const m = await master(board);
  settle(board, m);
  fs.writeFileSync(board.planFile(m), "## Steps\n- one\n- two\n");
  await request(board, { op: "plan", by: m.id, session: m.sessionId });
  assert.equal(m.status, "needs-input");
  m.updatedAt = new Date(Date.now() - 20_000).toISOString(); // past the scan's 10 s: no terminal, no live session
  board.tick();
  assert.deepEqual([m.status, m.interrupted], ["needs-input", undefined]);
});

test("settle notices: a child reaching Review wakes an idle master once with its status line; a Running master gets them batched at its next Stop; Pause run holds them, Resume run releases them", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const a = board.get((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "A", prompt: "a" })).id);
  const b = board.get((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "B", prompt: "b" })).id);
  for (const c of [a, b]) { event(board, c.id, { hook_event_name: "SessionStart", session_id: c.sessionId }); event(board, c.id, { hook_event_name: "UserPromptSubmit", prompt: "p" }); board.syncStatus(c.id); }
  // Only this master's terminals: the list is shared, and an earlier test's board can still open one under a loaded full run.
  const resumes = () => terminals.filter((t) => t.options.name === `En ${m.id}`).length; // "En <id>" since the rename of 17 November 2026 (3886b2d3)
  const reaches = async (n) => { for (let i = 0; i < 60 && resumes() < n; i++) await sleep(50); await sleep(100); return resumes(); };
  const opened = resumes();
  settle(board, a);
  assert.equal(await reaches(opened + 1), opened + 1, "the idle master was resumed with the notice");
  const notice = fs.readFileSync(path.join(board.dir, "launch", `${m.id}.followup.txt`), "utf8");
  assert.match(notice, new RegExp(`\\n\\nChild settled: ${a.id}  review .*"A"  last: "done"$`));
  assert.equal(m.status, "running");
  // B settles while the master runs: held; a repeated publish sends nothing twice; the master's Stop delivers it.
  settle(board, b);
  board.publishStatus(); board.publishStatus();
  await sleep(100);
  assert.equal(resumes(), opened + 1);
  settle(board, m);
  assert.equal(await reaches(opened + 2), opened + 2);
  assert.match(fs.readFileSync(path.join(board.dir, "launch", `${m.id}.followup.txt`), "utf8"), new RegExp(`\\n\\nChild settled: ${b.id}  review`));
  // Pause: A changes again (done): held; add refused; Resume run releases.
  settle(board, m);
  board.pauseRun(m);
  assert.equal(m.paused, true);
  assert.equal((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "C", prompt: "c" })).error, "Run paused");
  board.update(a, { status: "done" });
  await sleep(100);
  assert.equal(resumes(), opened + 2, "held while paused");
  board.resumeRun(m);
  assert.equal(await reaches(opened + 3), opened + 3);
  assert.match(fs.readFileSync(path.join(board.dir, "launch", `${m.id}.followup.txt`), "utf8"), new RegExp(`\\n\\nChild settled: ${a.id}  done`));
});

test("a window reload kills a hidden run: the child is Interrupted in Review once its session is gone, its master is told, and resume continues it with the nudge", async () => {
  const { board, runEvents } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const a = board.get((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "A", prompt: "a" })).id);
  event(board, a.id, { hook_event_name: "SessionStart", session_id: a.sessionId }); event(board, a.id, { hook_event_name: "UserPromptSubmit", prompt: "p" }); board.syncStatus(a.id);
  assert.equal(a.status, "running");
  // The reload: the terminal is gone with no Stop. The card's last change must be over 10 s old for the scan to call it gone.
  terminals.find((t) => t.options.name === `En ${a.id}`).exit(1);
  a.updatedAt = new Date(Date.now() - 20_000).toISOString(); // update() would stamp now
  const opened = terminals.length;
  board.tick();
  assert.deepEqual([a.status, a.interrupted], ["review", true]);
  await sleep(100);
  assert.equal(terminals.length, opened + 1, "the master was told");
  assert.match(fs.readFileSync(path.join(board.dir, "launch", `${m.id}.followup.txt`), "utf8"), /\[interrupted, headless\]/);
  assert.ok(runEvents.some((e) => e.kind === "needsYou" && e.task.id === a.id), "Run needs you");
  settle(board, m);
  const r = await request(board, { op: "resume", by: m.id, session: m.sessionId, id: a.id });
  assert.deepEqual([r.ok, a.status, a.interrupted], [true, "running", undefined], JSON.stringify(r));
  assert.ok(fs.readFileSync(path.join(board.dir, "launch", `${a.id}.followup.txt`), "utf8").endsWith(`\n\n${o.INTERRUPTED_NUDGE}`));
});

test("a hidden run whose session file says idle mid-turn (a long tool call) stays Running; after a reload its process keeps the card alive until it goes", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  event(board, m.id, { hook_event_name: "UserPromptSubmit", prompt: "p" }); board.syncStatus(m.id);
  // The CLI's session file for the run, in the account's folder, saying idle; the card's last change is old enough to count.
  const sessions = path.join(home, ".claude", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: m.sessionId, cwd: m.worktree, status: "idle" }));
  m.updatedAt = new Date(Date.now() - 20_000).toISOString();
  terminals.find((t) => t.options.name === `En ${m.id}` && !t.exitStatus).exit(0); // the new window after a reload has no terminal object for it
  board.tick();
  assert.deepEqual([m.status, m.interrupted, board.live().includes(m.id)], ["running", undefined, true]);
  fs.rmSync(path.join(sessions, `${process.pid}.json`));
  board.tick();
  assert.deepEqual([m.status, m.interrupted], ["review", true], "gone for good: interrupted");
});

test("Stop run stops the run's live cards, children first, then the master; Stop run counts them", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const a = board.get((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "A", prompt: "a" })).id);
  board.update(a, { status: "running" });
  board.update(m, { status: "running" });
  await board.followUpHeadless(m, "go").catch(() => undefined);
  const live = board.liveRun(m).map((t) => t.id);
  assert.deepEqual(live, [a.id, m.id]);
  assert.equal(board.stopRun(m), 2);
  assert.deepEqual([board.terminal(a), board.terminal(m)], [undefined, undefined]);
  assert.equal(m.paused, true);
  const stoppedAt = terminals.length;
  settle(board, a);
  settle(board, m);
  await sleep(100);
  assert.equal(terminals.length, stoppedAt, "child completion cannot restart the stopped run");
});

test("CORE-GOV-15: Stop run ends a Review child's running acceptance checks, worker and command; later ticks leave them stopped while the run is paused", { skip: !["win32", "linux"].includes(process.platform) }, async () => {
  const { alive } = require("../out/jobs.js");
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-orch2-chk-"));
  made.push(work);
  // The check command records its own pid, then holds for 30 s: long past this test unless Stop run ends it.
  fs.writeFileSync(path.join(work, "hold.cjs"), "require('node:fs').writeFileSync('pid', String(process.pid)); setTimeout(() => {}, 30000);\n");
  const command = `${process.platform === "win32" ? "& " : ""}'${process.execPath}' hold.cjs`;
  const child = board.add("checked", "p", "acct", m.id, undefined, undefined, { commands: [command], doneWhen: "it holds" }, { openedBy: m.id, headless: true });
  child.worktree = work;
  const results = [];
  board.checks.onResult = (t, passed, error) => results.push([t.id, passed, error]);
  const gone = (pid) => !alive(pid) || (process.platform === "linux" && !fs.readFileSync(`/proc/${pid}/cmdline`).length); // a zombie's cmdline is empty
  let workerPid, commandPid;
  try {
    board.update(child, { status: "review" }); // work came to Review: the board starts its checks
    assert.equal(child.checks?.status, "running");
    const run = child.checks.run;
    for (let i = 0; i < 200 && !fs.existsSync(path.join(work, "pid")); i++) await sleep(50);
    commandPid = Number(fs.readFileSync(path.join(work, "pid"), "utf8"));
    workerPid = JSON.parse(fs.readFileSync(path.join(run, "receipt.json"), "utf8")).pid;
    assert.ok(!gone(workerPid) && !gone(commandPid), "the worker and its command run before Stop run");
    assert.ok(!board.liveRun(m).includes(child), "a Review child with running checks is not a live card");
    board.stopRun(m);
    assert.equal(m.paused, true);
    for (let i = 0; i < 200 && !(gone(workerPid) && gone(commandPid)); i++) await sleep(50);
    assert.deepEqual([gone(workerPid), gone(commandPid)], [true, true], "Stop run ends the check worker and its command");
    board.tick();
    assert.deepEqual([child.checks.status, child.checks.error], ["error", "Acceptance checks were interrupted. Retry checks when ready."]);
    assert.deepEqual(results, [[child.id, false, "Acceptance checks were interrupted. Retry checks when ready."]]);
    const runs = fs.readdirSync(path.join(board.dir, "checks", child.id));
    for (let i = 0; i < 3; i++) { board.tick(); await sleep(50); }
    assert.equal(child.checks.status, "error", "a later tick does not restart the checks while the run is paused");
    assert.deepEqual(fs.readdirSync(path.join(board.dir, "checks", child.id)), runs);
    assert.equal(results.length, 1);
  } finally {
    for (const pid of [workerPid, commandPid]) if (pid && !gone(pid)) try { process.kill(pid); } catch { /* gone */ }
  }
});

test("an account reset stays pending while the run is paused and resumes after unpausing", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  const child = board.add("waiting", "p", "acct", m.id, undefined, undefined, undefined,
    { openedBy: m.id, headless: true, waitsForReset: { account: "acct", at: Date.now() - 1000 } });
  const resumed = [];
  board.followUpHeadless = async (task) => { resumed.push(task.id); };
  board.pauseRun(m);
  board.checkResets();
  assert.equal(resumed.length, 0);
  assert.ok(child.waitsForReset);
  board.resumeRun(m);
  board.checkResets();
  assert.deepEqual(resumed, [child.id]);
  assert.equal(child.waitsForReset, undefined);
});

test("CORE-GOV-03: a parked card resumed by hand and finished before its reset stays Done at the reset; an untouched parked card still resumes", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const add = async (title) => board.get((await request(board, { op: "add", by: m.id, session: m.sessionId, title, prompt: title })).id);
  const a = await add("A"), b = await add("B");
  const at = Date.now() + 60_000;
  for (const c of [a, b]) { event(board, c.id, { hook_event_name: "SessionStart", session_id: c.sessionId }); settle(board, c); board.update(c, { waitsForReset: { account: "acct", at } }); }
  await board.followUpHeadless(a, "Carry on."); // the user resumes it by hand
  assert.equal(a.waitsForReset, undefined, "a restart drops the parked wait");
  settle(board, a);
  await board.finish(a, "discard");
  assert.deepEqual([a.status, a.waitsForReset], ["done", undefined]);
  a.waitsForReset = { account: "acct", at }; // a wait saved before this fix: the timer checks the card's state itself
  const resumed = [], aRuns = terminals.filter((t) => t.options.name === `En ${a.id}`).length;
  board.followUpHeadless = async (task) => { resumed.push(task.id); };
  board.checkResets();
  assert.deepEqual(resumed, [], "nothing before the reset");
  const now = Date.now;
  Date.now = () => now() + 120_000; // the clock passes the parked deadline
  try { board.checkResets(); } finally { Date.now = now; }
  assert.deepEqual([a.status, a.waitsForReset, terminals.filter((t) => t.options.name === `En ${a.id}`).length], ["done", undefined, aRuns]);
  assert.deepEqual([resumed, b.waitsForReset], [[b.id], undefined], "only the untouched parked card resumes");
});

test("a headless child that hits a usage limit moves to the account with the most headroom and is resumed once, quietly; with no room it waits for the reset", async () => {
  const { board } = fixture();
  const { parseUsage } = require("../out/usage.js");
  const accounts = board.accountList();
  board.accountList = () => [...accounts, { name: "disputed", configDir: path.join(home, "disputed") }];
  fs.mkdirSync(process.env.ENTOMATICAL_USAGE_DIR, { recursive: true });
  const usage = (key, v) => fs.writeFileSync(path.join(process.env.ENTOMATICAL_USAGE_DIR, `${key}.json`), JSON.stringify({ ...v, at: Date.now(), source: "query" }));
  usage("acct", { fiveHour: 100, week: 50, fiveHourResets: Math.floor(Date.now() / 1000) + 120 });
  usage("spare", parseUsage({ rate_limits: { five_hour: null, limits: [{ kind: "weekly_all", percent: 10 }] } }));
  usage("disputed", parseUsage({ rate_limits: { five_hour: { utilization: 96 }, seven_day: { utilization: 98 },
    limits: [{ kind: "session", percent: 99 }, { kind: "weekly_all", percent: 99 }] } }));
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const a = board.get((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "A", prompt: "a" })).id);
  event(board, a.id, { hook_event_name: "SessionStart", session_id: a.sessionId }); event(board, a.id, { hook_event_name: "UserPromptSubmit", prompt: "p" }); board.syncStatus(a.id);
  // The transcript the switch carries: a saved conversation in the account folder.
  const { transcriptPath } = require("../out/sessions.js");
  const file = transcriptPath(path.join(home, "acct"), a.worktree, a.sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ type: "user", message: { content: "p" } }) + "\n");
  terminals.find((t) => t.options.name === `En ${a.id}` && !t.exitStatus).exit(1);
  const opened = terminals.length;
  event(board, a.id, { hook_event_name: "StopFailure", error: "rate_limit", last_assistant_message: "You've reached your limit" });
  board.syncStatus(a.id);
  for (let i = 0; i < 40 && terminals.length === opened; i++) await sleep(50);
  await sleep(200); // the events watcher sees the StopFailure line again; the resumed run's events are newer than it
  assert.deepEqual([a.account, a.switchedTo, a.status, terminals.length], ["spare", "spare", "running", opened + 1], `terminals since: ${terminals.slice(opened).map((t) => t.options.name).join(" | ")}`);
  assert.equal(terminals.at(-1).options.env.CLAUDE_CONFIG_DIR, path.join(home, "spare"));
  assert.ok(fs.readFileSync(path.join(board.dir, "launch", `${a.id}.followup.txt`), "utf8").endsWith("\n\nContinue."));
  const masterRuns = terminals.filter((t) => t.options.name === `En ${m.id}`).length;
  settle(board, a);
  await sleep(100);
  assert.equal(terminals.filter((t) => t.options.name === `En ${m.id}`).length, masterRuns + 1, "the real settle after the switch still wakes the master");
  // No account with room: the card waits for the reset, then starts again by itself.
  usage("spare", { fiveHour: 100, week: 10, fiveHourResets: Math.floor(Date.now() / 1000) - 1 });
  terminals.find((t) => t.options.name === `En ${a.id}` && !t.exitStatus)?.exit(1);
  event(board, a.id, { hook_event_name: "StopFailure", error: "rate_limit", last_assistant_message: "limit" });
  board.syncStatus(a.id);
  await sleep(300);
  assert.equal(typeof a.waitsForReset?.at, "number");
  const before = terminals.length;
  board.tick(); // the reset has passed
  await sleep(100);
  assert.deepEqual([a.waitsForReset, terminals.length], [undefined, before + 1]);
});

test("usage limit: every exit that neither moves nor parks the child unmutes it and holds it with a reason (audit, 10 November 2026)", async () => {
  const { board, runEvents } = fixture();
  fs.mkdirSync(process.env.ENTOMATICAL_USAGE_DIR, { recursive: true });
  const usage = (key, v) => fs.writeFileSync(path.join(process.env.ENTOMATICAL_USAGE_DIR, `${key}.json`), JSON.stringify({ ...v, at: Date.now(), source: "query" }));
  usage("acct", { fiveHour: 100, week: 50 }); usage("spare", { fiveHour: 5, week: 10 }); // spare has room, so the board would move it
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  const child = (title) => board.add(title, "p", "acct", m.id, undefined, undefined, undefined, { openedBy: m.id, headless: true });
  const exit = async (c, at) => {
    board.muted.add(c.id); // as syncStatus does for a limited child
    await board.limitFallback(c, { t: at, hook_event_name: "StopFailure", error: "rate_limit" });
    return [board.muted.has(c.id), c.stepHold, runEvents.some((e) => e.kind === "needsYou" && e.task === c && e.master === m)];
  };
  const stale = child("stale");
  assert.deepEqual(await exit(stale, Date.now() - 200_000), [false, "It hit a usage limit more than 2 minutes ago, so the board did not move it to another account. Resume it when ready.", true]);
  const busy = child("busy");
  board.ended = async () => false;
  assert.deepEqual(await exit(busy, Date.now()), [false, "It hit a usage limit, but its session did not end, so the board did not move it to another account. Stop it, then resume it.", true]);
  const refused = child("refused");
  board.ended = async () => true; board.switchAccount = () => undefined;
  board.followUpHeadless = async () => { throw new Error("Run paused"); };
  assert.deepEqual(await exit(refused, Date.now()), [false, "It hit a usage limit, and moving it to spare failed: Run paused", true]);
});

/** Runs tools/board.js as the given session would, while the board consumes its inbox (no window poll in these tests). */
async function cli(board, cwd, argv, env) {
  const tool = require("../tools/board.js");
  const out = [];
  const pump = setInterval(() => void board.processInbox(), 30);
  try {
    const code = await tool.main(argv, { cwd, env, write: (s) => out.push(s) });
    return { code, out: out.join("") };
  } finally { clearInterval(pump); }
}
/** A stand-in claude on PATH that records what the process actually got: its arguments, its --settings file's permissions, its environment, its stdin. */
function fakeClaude() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-fake-claude-"));
  made.push(dir);
  const js = path.join(dir, "fake.js");
  fs.writeFileSync(js, `const fs = require("fs"); const a = process.argv.slice(2); const s = JSON.parse(fs.readFileSync(a[a.indexOf("--settings") + 1], "utf8"));
const prompt = fs.readFileSync(0, "utf8");
fs.writeFileSync(process.env.FAKE_READBACK, JSON.stringify({ argv: a, permissions: s.permissions, settingsEnv: s.env, env: { ENTOMATICAL_TASK: process.env.ENTOMATICAL_TASK, ENTOMATICAL_REPO: process.env.ENTOMATICAL_REPO, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, ENTOMATICAL_NO_PROMPTS: process.env.ENTOMATICAL_NO_PROMPTS }, prompt }));
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", permissionMode: s.permissions?.defaultMode }) + "\\n");`);
  if (process.platform === "win32") fs.writeFileSync(path.join(dir, "claude.cmd"), `@"${process.execPath}" "${js}" %*\r\n`);
  else { fs.writeFileSync(path.join(dir, "claude"), `#!/bin/sh\nexec '${process.execPath}' '${js}' "$@"\n`); fs.chmodSync(path.join(dir, "claude"), 0o755); }
  return dir;
}
/** Runs a hidden terminal's script exactly as VS Code would (its shell, arguments, cwd and environment), with the stand-in claude first on PATH. */
function runTerminal(term, bin, readback) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];
  for (const [k, v] of Object.entries(term.options.env)) if (v === null) delete env[k]; else env[k] = v;
  env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  env.FAKE_READBACK = readback;
  const r = require("node:child_process").spawnSync(term.options.shellPath, term.options.shellArgs, { cwd: term.options.cwd, env, encoding: "utf8", timeout: 30_000 });
  return { status: r.status, readback: JSON.parse(fs.readFileSync(readback, "utf8")) };
}

test("F91: a headless child its hook stopped stays in Needs input with the reason, tells its parent, and Resume with Bypass continues the same session", async () => {
  const { repo, board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const prompt = path.join(repo, "child.md");
  fs.writeFileSync(prompt, "Write ten files.\n");
  const me = { ENTOMATICAL_TASK: m.id, CLAUDE_CODE_SESSION_ID: m.sessionId };
  const before = terminals.length;
  const r = await cli(board, repo, ["add", "--title", "Ask child", "--prompt-file", prompt, "--permission", "ask"], me);
  assert.equal(r.code, 0, r.out);
  const id = r.out.trim(), child = board.get(id);
  const term = terminals.slice(before).find((t) => t.options.name === `En ${id}`);
  // The run as Claude Code reports it: its session, its prompt, then 8 refused Writes through the real hook with ENTOMATICAL_NO_PROMPTS=1.
  event(board, id, { hook_event_name: "SessionStart", session_id: child.sessionId });
  event(board, id, { hook_event_name: "UserPromptSubmit", session_id: child.sessionId, prompt: "Write ten files." });
  const hook = path.join(__dirname, "..", "hook", "hook.js");
  let decision = "";
  for (let n = 1; n <= 8; n++) decision = require("node:child_process").spawnSync(process.execPath, [hook, board.eventsFile(id)], { encoding: "utf8", env: { ...process.env, ENTOMATICAL_NO_PROMPTS: "1" },
    input: JSON.stringify({ hook_event_name: "PermissionRequest", session_id: child.sessionId, cwd: child.worktree, tool_name: "Write", tool_input: { file_path: path.join(child.worktree, `f${n}.txt`), content: "x" } }) }).stdout;
  assert.equal(JSON.parse(decision).hookSpecificOutput.decision.interrupt, true);
  board.syncStatus(id);
  assert.equal(child.status, "needs-input");
  assert.deepEqual({ ...child.refusalStop, at: 0 }, { at: 0, rule: "streak", n: 8, desc: "Write f8.txt" });
  const rec = board.statusOf(child);
  assert.ok(rec.chips.includes("refused calls"));
  assert.equal(rec.doing, "Stopped after 8 refused calls (last: Write f8.txt)");
  // The parent is told, and board.js wait would return the same line.
  board.publishStatus(true);
  board.pendingNotices.clear(); board.loadNotifications(true);
  assert.ok(board.receiveMessages(m.id).some((text) => text.startsWith("Child needs input:") && text.includes("Stopped after 8 refused calls (last: Write f8.txt)")));
  // The interrupt ends the process with no Stop: the sweep keeps the card in Needs input rather than Review marked Interrupted.
  term.exit(1);
  child.updatedAt = new Date(Date.now() - 60_000).toISOString();
  board.tick();
  assert.deepEqual([child.status, child.interrupted, !!child.refusalStop], ["needs-input", undefined, true]);
  // Resume with Bypass: Bypass in the card and its settings file, the same session resumed with the follow-up, the stop cleared.
  await board.resumeWithBypass(child);
  const next = terminals.filter((t) => t.options.name === `En ${id}`).at(-1);
  assert.notEqual(next, term);
  assert.equal(child.permission, "bypass");
  assert.deepEqual(JSON.parse(fs.readFileSync(board.hooksFile(id), "utf8")).permissions, { defaultMode: "bypassPermissions" });
  assert.match(fs.readFileSync(path.resolve(next.options.cwd, next.options.shellArgs.at(-1)), "utf8").replace(/'/g, ""), new RegExp(`--resume ${child.sessionId}`));
  assert.match(fs.readFileSync(o.headlessFiles(board.dir, id).followUpFile, "utf8"), /Continue the task\. The calls that were refused before are allowed now\.$/);
  board.syncStatus(id);
  assert.deepEqual([child.status, child.refusalStop], ["running", undefined], "the old stop line does not come back for the new run");
  await assert.rejects(board.resumeWithBypass(child), /not stopped by refused calls/);
});

test("permission transport: board.js add --permission reaches the request, the card, its settings file and the process; explicit modes and session identity survive transport", async () => {
  const { repo, board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const prompt = path.join(repo, "child.md");
  fs.writeFileSync(prompt, "Reply ready.\n");
  const me = { ENTOMATICAL_TASK: m.id, CLAUDE_CODE_SESSION_ID: m.sessionId };
  // 1. The CLI writes the request with the permission; the board answers with the card it made.
  const before = terminals.length;
  const r = await cli(board, repo, ["add", "--title", "Ask child", "--prompt-file", prompt, "--permission", "ask"], me);
  assert.equal(r.code, 0, r.out);
  const id = r.out.trim();
  assert.match(id, /^[0-9a-f]{6}$/);
  const answer = fs.readdirSync(path.join(board.dir, "inbox", "done")).map((f) => JSON.parse(fs.readFileSync(path.join(board.dir, "inbox", "done", f), "utf8"))).find((a) => a.id === id);
  assert.deepEqual([answer.op, answer.permission, answer.session, answer.started], ["add", "ask", m.sessionId, true]);
  // 2. The card and 3. its settings file: Claude's defaultMode "default", no allowed commands, nobody to answer prompts.
  const child = board.get(id);
  // This child's own terminal, by name: under a full npm test another card's timer can open one meanwhile (seen 5 Nov 2026: 35, not 34).
  const mine = terminals.slice(before).filter((t) => t.options.name === `En ${id}`);
  assert.deepEqual([child.permission, child.headless, child.openedBy, mine.length], ["ask", true, m.id, 1]);
  const settings = JSON.parse(fs.readFileSync(board.hooksFile(id), "utf8"));
  assert.deepEqual(settings.permissions, { defaultMode: "default" });
  // 4. The process the hidden terminal runs: the stand-in records what it was actually given.
  const bin = fakeClaude();
  const run = runTerminal(mine[0], bin, path.join(bin, "readback.json"));
  assert.equal(run.status, 0);
  const { argv, permissions, env, prompt: stdin } = run.readback;
  assert.deepEqual(argv.slice(0, 8), ["-p", "--output-format", "stream-json", "--verbose", "--permission-prompts", "none", "--settings", board.hooksFile(id)]);
  assert.deepEqual(argv.slice(8, 10), ["--session-id", child.sessionId]);
  assert.deepEqual(permissions, { defaultMode: "default" }, "the process reads defaultMode default with no allow rules: every prompted tool is denied, since --permission-prompts none answers nothing");
  assert.deepEqual(argv.slice(-2), ["--add-dir", path.resolve(board.repo)], "the main checkout is a working directory, last");
  assert.equal(run.readback.settingsEnv.PYTHONUTF8, "1");
  // F91: the claude process (and so its hooks) runs with ENTOMATICAL_NO_PROMPTS=1; the terminal's own environment does not carry it.
  assert.deepEqual(env, { ENTOMATICAL_TASK: id, ENTOMATICAL_REPO: repo, CLAUDE_CONFIG_DIR: path.join(home, "acct"), ENTOMATICAL_NO_PROMPTS: "1" });
  assert.equal(mine[0].options.env.ENTOMATICAL_NO_PROMPTS, undefined);
  assert.match(stdin, new RegExp(`Opened by orchestrator "Run one" \\(${m.id}\\)`));
  assert.match(fs.readFileSync(path.join(board.dir, "stream", `${id}.jsonl`), "utf8"), /"permissionMode":"default"/);
  // board.js show reads it back for the orchestrator.
  const shown = await cli(board, repo, ["show", id], me);
  assert.match(shown.out, /permission: ask/);
  // An Accept edits child gets the project's commands for both shells, so git merge and npm test run with nobody to ask (fix 1).
  const edits = await cli(board, repo, ["add", "--title", "Edits child", "--prompt-file", prompt, "--permission", "edits"], me);
  assert.equal(edits.code, 0, edits.out);
  const editsId = edits.out.trim();
  const editsTerm = terminals.slice(before).filter((t) => t.options.name === `En ${editsId}`);
  assert.equal(editsTerm.length, 1);
  const editsRun = runTerminal(editsTerm[0], bin, path.join(bin, "readback-edits.json"));
  assert.equal(editsRun.status, 0);
  assert.deepEqual(editsRun.readback.permissions, { defaultMode: "acceptEdits", allow: o.HEADLESS_ALLOW });
  assert.ok(editsRun.readback.permissions.allow.includes("PowerShell(git *)"));
  // Invalid permissions and requests with no session never allocate cards. Bypass is the run default.
  assert.equal(m.permission, "bypass");
  const opened = m.orchestrator.opened, cards = board.tasks.length;
  const odd = await cli(board, repo, ["add", "--title", "Odd", "--prompt-file", prompt, "--permission", "root"], me);
  assert.equal(odd.code, 1);
  assert.match(odd.out, /refused: Unknown permission root/);
  const unbound = await cli(board, repo, ["add", "--title", "Unbound", "--prompt-file", prompt], { ENTOMATICAL_TASK: m.id });
  assert.equal(unbound.code, 1);
  assert.match(unbound.out, /refused: Not bound: the request names no session/);
  assert.deepEqual([m.orchestrator.opened, board.tasks.length], [opened, cards]);
});

test("CLI launch failure reports a card with no completion credit and exits 1", async () => {
  const { repo, board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const prompt = path.join(repo, "child.md");
  fs.writeFileSync(prompt, "Reply ready.\n");
  const me = { ENTOMATICAL_TASK: m.id, CLAUDE_CODE_SESSION_ID: m.sessionId };
  board.startHeadless = async () => { throw new Error("no worktree"); };
  const y = await cli(board, repo, ["add", "--title", "Fails", "--prompt-file", prompt], me);
  assert.equal(y.code, 1);
  assert.match(y.out, /Launch failed: no worktree.*[0-9a-f]{6}; it has no completion credit/);
  const failed = board.tasks.find((t) => t.title === "Fails");
  assert.deepEqual([failed.status, failed.sessionId, failed.launchError], ["review", undefined, "no worktree"]);
  const receipt = fs.readdirSync(path.join(board.dir, "inbox", "done")).map((f) => JSON.parse(fs.readFileSync(path.join(board.dir, "inbox", "done", f), "utf8"))).find((r) => r.id === failed.id);
  assert.deepEqual([receipt.permission, receipt.created, receipt.started, receipt.launchState], ["bypass", true, false, "failed"]);
  const json = await cli(board, repo, ["add", "--title", "Manual", "--prompt-file", prompt, "--start", "manual", "--json"], me);
  assert.equal(JSON.parse(json.out).launchState, "queued");
});

test("takeover and rebind: a taken-over master keeps its own session; rebind moves control to the new session, the old one is refused, and held notices show on its line", async () => {
  const { repo, board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const a = board.get((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "A", prompt: "a" })).id);
  event(board, a.id, { hook_event_name: "SessionStart", session_id: a.sessionId }); event(board, a.id, { hook_event_name: "UserPromptSubmit", prompt: "p" }); board.syncStatus(a.id);
  board.update(m, { headless: undefined, takenOver: true }); // the user pressed Resume on the master
  assert.equal((await request(board, { op: "note", by: m.id, session: m.sessionId, text: "still me" })).ok, true, "the same session after a takeover still acts");
  board.confirmRebind = async () => true; // the user clicks Allow
  const r = await cli(board, repo, ["rebind"], { ENTOMATICAL_TASK: m.id, CLAUDE_CODE_SESSION_ID: "chat-2-session" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Waiting for the user to allow this on the board/);
  await new Promise((resolve) => setImmediate(resolve)); // the user's Allow binds after the answer
  assert.deepEqual([m.controller.sessionId, typeof m.controller.at], ["chat-2-session", "string"]);
  assert.match((await request(board, { op: "note", by: m.id, session: m.sessionId, text: "old" })).error, /^Not bound: session .* is not this card's controller \(chat-2-s\)/);
  assert.equal((await request(board, { op: "note", by: m.id, session: "chat-2-session", text: "new" })).ok, true);
  // A child settles: no push into the card's old session (that would start a second controller); the line counts it instead.
  const opened = terminals.length;
  settle(board, a);
  await sleep(100);
  board.publishStatus();
  assert.equal(terminals.length, opened, "nothing started for the rebound master");
  const line = statusLines(board).filter((l) => l.id === m.id).at(-1);
  assert.deepEqual(line.chips, ["taken over", "rebound to chat-2-s", "notices waiting 1"]);
  assert.match((await cli(board, repo, ["show", m.id], { ENTOMATICAL_TASK: m.id, CLAUDE_CODE_SESSION_ID: "chat-2-session" })).out, /chips: .*rebound to chat-2-s, notices waiting 1/);
  // The child's own record is what the new controller polls (wait --mine reads it).
  assert.match(statusLines(board).filter((l) => l.id === a.id).at(-1).line, new RegExp(`^${a.id}  review`));
});

test("phase-appropriate checks: a master's acceptance checks do not run at its plan stop nor while its run has open cards; they run at the Review after its cards are Done", async () => {
  const { board } = fixture();
  const started = [];
  board.checks.start = (t) => started.push(t.id); // no worker: the decision is what is tested
  const m = await master(board, { completion: { commands: ["npm test"] } });
  event(board, m.id, { hook_event_name: "UserPromptSubmit", prompt: "plan it" }); board.syncStatus(m.id);
  fs.writeFileSync(board.planFile(m), "## Steps\n- one\n");
  await request(board, { op: "plan", by: m.id, session: m.sessionId }); // run d60bfd: the plan-only turn's Stop ran the final checks
  settle(board, m);
  assert.deepEqual([m.status, started], ["needs-input", []]);
  assert.equal(board.statusOf(m).checks, "pending");
  await board.approvePlan(m); // back in Review for a moment, then Running with the approval: no checks for that Review either
  assert.deepEqual([m.status, started], ["running", []]);
  const a = board.get((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "A", prompt: "a" })).id);
  settle(board, m);
  assert.deepEqual([m.status, started], ["review", []], "a card of the run is still open");
  board.update(a, { status: "done" });
  event(board, m.id, { hook_event_name: "UserPromptSubmit", prompt: "wrap up" }); board.syncStatus(m.id);
  await request(board, { op: "ready", by: m.id, session: m.sessionId });
  settle(board, m);
  assert.deepEqual(started, [m.id]);
  // An ordinary card is unchanged: its checks run at its Review.
  const plain = board.add("plain", "p", "acct", undefined, undefined, undefined, { commands: ["npm test"] });
  board.update(plain, { sessionId: "s-plain", status: "running", worktree: m.worktree });
  event(board, plain.id, { hook_event_name: "Stop", last_assistant_message: "done" }); board.syncStatus(plain.id);
  assert.deepEqual(started, [m.id, plain.id]);
});

test("disabled orchestration refuses requests and failed runner preflight allocates no card", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  board.orchestratorEnabled = () => false;
  assert.equal((await request(board, { op: "note", by: m.id, session: m.sessionId, text: "hi" })).error, "Orchestrator disabled (entomatical.orchestrator.enabled is off)");
  board.orchestratorEnabled = () => true;
  board.preflightHeadless = async () => { throw new Error("runner missing"); };
  const before = board.tasks.length;
  const result = await request(board, { op: "add", by: m.id, session: m.sessionId, title: "missing", prompt: "never runs" });
  assert.match(result.error, /runner missing/);
  assert.equal(board.tasks.length, before);
  assert.equal(m.orchestrator.opened, 0);
});

test("ready announces completion only after the root's final turn reaches Review", async () => {
  const { board, runEvents } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  board.update(m, { status: "running" });
  const child = board.add("delivered child", "p", "acct", m.id, undefined, undefined, undefined, { openedBy: m.id });
  board.update(child, { status: "done" });
  assert.equal((await request(board, { op: "ready", by: m.id, session: m.sessionId })).ok, true);
  assert.equal(m.deliveryReady, true);
  assert.equal(runEvents.some((e) => e.kind === "finished"), false);
  settle(board, m);
  assert.equal(runEvents.filter((e) => e.kind === "finished").length, 1);
});

test("root approval covers a coordinator and its grandchild, with identities and exact run membership", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const add = (by, title, extra = {}) => request(board, { op: "add", by: by.id, session: by.sessionId, title, prompt: `Do ${title}.`, ...extra });
  const worker = board.get((await add(m, "worker")).id);
  const coordinator = board.get((await add(m, "coordinator", { mayOpen: true })).id);
  event(board, coordinator.id, { hook_event_name: "SessionStart", session_id: coordinator.sessionId });
  fs.writeFileSync(board.planFile(coordinator), "## Steps\n- delegate one bounded result\n");
  const plan = await request(board, { op: "plan", by: coordinator.id, session: coordinator.sessionId });
  assert.match(plan.note, /covered by root/);
  assert.equal(coordinator.approved.hash, "h");
  const grandchildResult = await add(coordinator, "grandchild");
  assert.equal(grandchildResult.started, true, JSON.stringify(grandchildResult));
  const grandchild = board.get(grandchildResult.id);
  assert.equal(grandchild.openedBy, coordinator.id);
  assert.equal(grandchild.permission, "bypass");
  assert.equal(m.orchestrator.opened, 3);
  assert.deepEqual(new Set(board.runSummaryOf(m).children.map((c) => c.id)), new Set([worker.id, coordinator.id, grandchild.id]));
  const brief = fs.readFileSync(path.join(board.dir, "launch", `${grandchild.id}.prompt.txt`), "utf8");
  for (const id of [m.id, coordinator.id, grandchild.id]) assert.ok(brief.includes(id), id);
  const denied = await add(worker, "unapproved nesting");
  assert.match(denied.error, /Not an orchestrator/);
});

test("failed launches are inspectable and cancellable, never credited as Done", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  board.startHeadless = async () => { throw new Error("provider refused model"); };
  const r = await request(board, { op: "add", by: m.id, session: m.sessionId, title: "failure", prompt: "p" });
  const child = board.get(r.id);
  assert.deepEqual([r.created, r.started], [true, false]);
  assert.match(child.launchError, /provider refused model/);
  assert.match((await request(board, { op: "done", by: m.id, session: m.sessionId, id: child.id })).error, /[Nn]ever started|[Nn]ot started/);
  assert.equal((await request(board, { op: "cancel", by: m.id, session: m.sessionId, id: child.id })).ok, true);
  assert.equal(child.cancelled, true);
  assert.equal(child.status, "review");
  assert.equal(board.runSummaryOf(m).done, 0);
  assert.equal(board.runSummaryOf(m).open, 0);
});

test("cancelling a child during preparation prevents its provider from starting", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  const child = board.add("Preparing", "work", "acct", m.id, undefined, undefined, undefined, { headless: true, openedBy: m.id, watchedBy: m.id });
  const preparing = Promise.withResolvers(), proceed = Promise.withResolvers();
  board.beforeStart = async () => { preparing.resolve(); await proceed.promise; };
  const pending = board.startHeadless(child);
  await preparing.promise;
  const before = terminals.length;
  const cancel = await request(board, { op: "cancel", by: m.id, session: m.sessionId, id: child.id });
  proceed.resolve();
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual([cancel.ok, child.cancelled, child.sessionId, terminals.length], [true, true, undefined, before]);
});

test("a controller retries a plan child through dependency and slot gates, counting only started plan assignments", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  board.update(m, { takenOver: true }); // hold the fixture's real notices without starting another session in the measured slot
  m.orchestrator.caps.open = 1;
  m.planRun = { review: "model", name: "Planned", stepIds: [] };
  const children = Array.from({ length: 4 }, (_, index) => board.add(`step ${index}`, "work", "acct", m.id, undefined, undefined, undefined,
    { headless: true, openedBy: m.id, watchedBy: m.id }));
  m.planRun.stepIds = children.map(t => t.id);
  const [candidate, dependency] = children;
  board.update(children[2], { status: "review", launchError: "An earlier launch failed" }); // a failure before allocation consumes no slot
  board.update(candidate, { cancelled: true, status: "review", dependsOn: [dependency.id] });
  const retry = () => request(board, { op: "resume", by: m.id, session: m.sessionId, id: candidate.id });
  assert.match((await retry()).error, /Starts after step 1/);
  assert.equal(candidate.cancelled, true, "a refused retry preserves the cancellation");
  board.update(dependency, { status: "done" });
  board.maxRunning = () => 1;
  const outside = board.add("Other run", "work", "acct");
  board.update(outside, { status: "running" });
  assert.match((await retry()).error, /Waiting for a session slot/);
  board.update(outside, { status: "done" });
  const prepare = board.beforeStart;
  board.beforeStart = async () => { throw new Error("Provider unavailable"); };
  assert.equal((await retry()).error, "Provider unavailable");
  assert.deepEqual([candidate.cancelled, candidate.launchError], [true, "Provider unavailable"]);
  board.beforeStart = prepare;
  const result = await retry();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([!!candidate.sessionId, candidate.cancelled], [true, undefined]);
});

test("a failed retry of an existing session restores cancellation until a new controller or dispatch takes over", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  board.update(m, { takenOver: true });
  const child = board.add("Retry", "work", "acct", m.id, undefined, undefined, undefined, { openedBy: m.id, headless: true });
  await board.startHeadless(child);
  event(board, child.id, { hook_event_name: "SessionStart", session_id: child.sessionId });
  settle(board, child);
  const act = op => request(board, { op, by: m.id, session: m.sessionId, id: child.id });
  assert.equal((await act("cancel")).ok, true);
  const session = child.sessionId;
  board.launchHeadless = () => { throw new Error("Provider unavailable"); };
  assert.equal((await act("resume")).error, "Provider unavailable");
  assert.deepEqual([child.sessionId, child.cancelled, child.launchError], [session, true, "Provider unavailable"]);
  board.followUpHeadless = async () => {
    board.update(child, { controller: { sessionId: "new-controller", mode: "external", at: "now" }, takenOver: true });
    throw new Error("Controller changed");
  };
  assert.equal((await act("resume")).error, "Controller changed");
  assert.deepEqual([child.cancelled, child.launchError, child.controller.sessionId], [undefined, undefined, "new-controller"]);
});

test("cross-account messages and adoption preserve sessions; permission notices reach the root and survive reload", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  board.update(m, { takenOver: true }); // keep the durable root inbox available for inspection
  const other = board.add("other account", "p", "spare");
  board.update(other, { sessionId: "other-session", status: "needs-input" });
  const send = await request(board, { op: "send", by: m.id, session: m.sessionId, id: other.id, text: "cross-account hello" });
  assert.equal(send.ok, true);
  board.pendingNotices.clear(); board.loadNotifications(true);
  const receive = await request(board, { op: "receive", by: other.id, session: other.sessionId });
  assert.ok(receive.messages.some((text) => text.includes("cross-account hello")));
  assert.equal((await request(board, { op: "adopt", by: m.id, session: m.sessionId, id: other.id })).ok, true);
  assert.deepEqual([other.openedBy, other.sessionId, other.permission], [m.id, "other-session", "bypass"]);
  event(board, other.id, { hook_event_name: "PermissionRequest", tool_name: "PowerShell", desc: "PowerShell requires input" });
  board.publishStatus(true);
  board.pendingNotices.clear(); board.loadNotifications(true);
  assert.ok(board.receiveMessages(m.id).some((text) => text.startsWith("Child needs input:")));
});

test("CORE-GOV-01: send outside the run leaves a Done card done; the holder's and the operator's send still reopen it", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const a = board.get((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "A", prompt: "a" })).id);
  event(board, a.id, { hook_event_name: "SessionStart", session_id: a.sessionId });
  settle(board, a);
  await sleep(100); settle(board, m); // the master's run for A's settle notice ends
  // The root first: marking A Done first would wake the root with A's settle notice.
  const finished = () => { board.update(m, { status: "done", deliveryReady: true }); board.update(a, { status: "done" }); };
  finished();
  const outsider = await master(board, { approved: { at: "x", hash: "h2" } });
  settle(board, outsider);
  const sent = recordFollowUps(board), started = terminals.length;
  const r = await request(board, { op: "send", by: outsider.id, session: outsider.sessionId, id: a.id, text: "outside hello" });
  await sleep(100);
  assert.deepEqual([r.ok, r.queued], [true, true]);
  assert.deepEqual([a.status, m.status, m.deliveryReady, a.followUps], ["done", "done", true, undefined]);
  assert.deepEqual([sent.length, terminals.length], [0, started], "no turn starts");
  assert.ok((await request(board, { op: "receive", by: a.id, session: a.sessionId })).messages.some((t) => t.includes("outside hello")));
  // The holder (a's opener) reopens its own Done child as before: delivery cleared up the chain and a turn starts.
  assert.equal((await request(board, { op: "send", by: m.id, session: m.sessionId, id: a.id, text: "holder hello" })).ok, true);
  await sleep(100);
  assert.equal(a.followUps, 1);
  assert.notEqual(m.status, "done"); assert.equal(m.deliveryReady, undefined);
  assert.ok(sent.some((s) => s.id === a.id && s.text.includes("holder hello")));
  settle(board, a); await sleep(100); settle(board, m);
  // the user's operator send reopens it too.
  finished();
  assert.equal((await board.handleOperator({ op: "send", id: a.id, text: "operator hello" })).ok, true);
  assert.notEqual(a.status, "done");
  assert.notEqual(m.status, "done"); assert.equal(m.deliveryReady, undefined);
  assert.ok(sent.some((s) => s.id === a.id && s.text.includes("operator hello")));
});

test("Mark done: a never-started card is refused until it is cancelled; a cancelled one goes to Done and stays cancelled", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const a = board.get((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "A", prompt: "a", start: "manual" })).id);
  assert.equal(board.everReady(a), false);
  assert.equal((await board.handleOperator({ op: "done", id: a.id })).error, "This card never started. Cancel it to preserve it without completion credit.");
  assert.equal((await board.handleOperator({ op: "cancel", id: a.id })).ok, true);
  assert.deepEqual([a.status, a.cancelled], ["review", true]);
  assert.equal((await board.handleOperator({ op: "done", id: a.id })).ok, true);
  assert.deepEqual([a.status, a.cancelled], ["done", true]);
});

test("adoption informs the former owner and rejects its stale attempt to reclaim the parent's assignment", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  board.update(m, { takenOver: true });
  const coordinator = board.add("coordinator", "original task", "acct", m.id, undefined, undefined, undefined,
    { openedBy: m.id, orchestrator: { caps: m.orchestrator.caps, root: m.id, opened: 1 } });
  const worker = board.add("worker", "work", "acct", coordinator.id, undefined, undefined, undefined, { openedBy: coordinator.id });
  assert.equal((await request(board, { op: "adopt", by: m.id, session: m.sessionId, id: worker.id })).ok, true);
  assert.equal(worker.openedBy, m.id);
  assert.match(board.receiveMessages(coordinator.id).join("\n"), /Ownership handoff:.*Do not resume, mark Done or reclaim/s);
  board.update(coordinator, { sessionId: "coordinator-session" });
  const reclaim = await request(board, { op: "adopt", by: coordinator.id, session: coordinator.sessionId, id: worker.id });
  assert.match(reclaim.error, /assigned to ancestor/);
  assert.equal(worker.openedBy, m.id);
});

test("CORE-GOV-02: adopt leaves a card the user took over, and a parent holding one, where they are; an ordinary card still moves", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const taken = board.add("taken", "p", "acct");
  board.update(taken, { takenOver: true, sessionId: "taken-session" });
  const r1 = await request(board, { op: "adopt", by: m.id, session: m.sessionId, id: taken.id });
  assert.match(r1.error, new RegExp(`^adopt: the user took card ${taken.id} over himself`));
  assert.deepEqual([taken.openedBy, taken.takenOver, taken.sessionId], [undefined, true, "taken-session"]);
  const parent = board.add("parent", "p", "acct");
  const inner = board.add("inner", "p", "acct", parent.id, undefined, undefined, undefined, { openedBy: parent.id });
  board.update(inner, { takenOver: true });
  const r2 = await request(board, { op: "adopt", by: m.id, session: m.sessionId, id: parent.id });
  assert.match(r2.error, new RegExp(`^adopt: the user took card ${inner.id} under ${parent.id} over himself`));
  assert.deepEqual([parent.openedBy, inner.openedBy, inner.takenOver], [undefined, parent.id, true]);
  assert.equal(fs.existsSync(board.transfersFile) && fs.readFileSync(board.transfersFile, "utf8").includes('"via":"adopt"'), false, "nothing moved");
  const plain = board.add("plain", "p", "acct");
  assert.equal((await request(board, { op: "adopt", by: m.id, session: m.sessionId, id: plain.id })).ok, true);
  assert.equal(plain.openedBy, m.id);
});

test("external controller rebind is explicit and plan stops cannot run final acceptance", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  const originalSession = m.sessionId;
  settle(board, m);
  board.confirmRebind = async () => true; // the user clicks Allow
  const result = await request(board, { op: "rebind", by: m.id, session: "new-controller" });
  assert.match(result.error, /Waiting for the user/);
  await new Promise((resolve) => setImmediate(resolve)); // the user's Allow binds after the answer
  assert.equal(m.sessionId, originalSession);
  assert.equal(m.controller.sessionId, "new-controller");
  assert.match((await request(board, { op: "note", by: m.id, session: originalSession, text: "stale driver" })).error, /session/);
  assert.equal((await request(board, { op: "note", by: m.id, session: "new-controller", text: "rebound" })).ok, true);
  const checks = [];
  board.checks.start = (task) => { if (task.deliveryReady) checks.push(task.id); };
  fs.writeFileSync(board.planFile(m), "## Steps\n- implement\n");
  await request(board, { op: "plan", by: m.id, session: "new-controller" });
  board.update(m, { status: "running" }); settle(board, m);
  assert.equal(checks.length, 0);
  await board.approvePlan(m);
  assert.equal((await request(board, { op: "ready", by: m.id, session: "new-controller" })).ok, true);
  assert.deepEqual(checks, [m.id]);
});

test("adopting a subtree propagates run policy and defaults stopped descendants to Bypass without mislabelling live sessions", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" }, runPolicy: { allow: ["read reference files"], deny: [], noSync: true } });
  settle(board, m);
  board.update(m, { takenOver: true });
  const coordinator = await master(board, { approved: { at: "old", hash: "old" }, permission: "ask" });
  settle(board, coordinator);
  const live = board.add("live", "p", "acct", coordinator.id, undefined, undefined, undefined,
    { openedBy: coordinator.id, permission: "ask", headless: true });
  await board.startHeadless(live);
  const stopped = board.add("stopped", "p", "acct", coordinator.id, undefined, undefined, undefined,
    { openedBy: coordinator.id, permission: "ask" });
  const result = await request(board, { op: "adopt", by: m.id, session: m.sessionId, id: coordinator.id });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.note, /Live sessions keep their current permission mode/);
  assert.equal(coordinator.permission, "bypass");
  assert.equal(stopped.permission, "bypass");
  assert.equal(stopped.headless, true);
  assert.equal(live.permission, "ask");
  assert.equal(live.pendingPermission, "bypass");
  for (const card of [coordinator, live, stopped]) assert.deepEqual(card.runPolicy, m.runPolicy);
  assert.equal(coordinator.orchestrator.root, m.id);
  assert.equal(m.orchestrator.opened, 3);
  board.update(coordinator, { takenOver: true });
  settle(board, live);
  board.update(live, { controller: { sessionId: "external-controller", at: new Date().toISOString(), mode: "external" },
    orchestrator: { caps: m.orchestrator.caps, root: m.id, opened: 0, session: "legacy-controller", reboundAt: "earlier" } });
  await board.followUpHeadless(live, "Continue under the adopted run.");
  assert.equal(live.permission, "bypass");
  assert.equal(live.controller.sessionId, "external-controller", "creating a terminal is not proof of a live managed session");
  assert.equal(live.pendingPermission, "bypass");
  const settings = JSON.parse(fs.readFileSync(board.hooksFile(live.id), "utf8"));
  assert.equal(settings.permissions.defaultMode, "bypassPermissions");
  const followup = fs.readFileSync(path.join(board.dir, "launch", `${live.id}.followup.txt`), "utf8");
  assert.match(followup, new RegExp(`Root orchestrator: ${m.id}`));
  assert.match(followup, /allowed: read reference files/);
  assert.ok(followup.endsWith("\n\nContinue under the adopted run."));
  event(board, live.id, { hook_event_name: "SessionStart", session_id: live.sessionId });
  board.syncStatus(live.id);
  assert.equal(live.pendingPermission, undefined);
  assert.equal(live.controller, undefined);
  assert.equal(live.orchestrator.session, undefined, "fresh managed SessionStart also releases a persisted legacy binding");
});

/** Follow-ups the board sends to headless cards, by card id, in order (the original still runs). */
function recordFollowUps(board) {
  const sent = [];
  const original = board.followUpHeadless.bind(board);
  board.followUpHeadless = (task, text, ...rest) => { sent.push({ id: task.id, text }); return original(task, text, ...rest); };
  return sent;
}

test("Archive run: refused until the master is Done, while a card depends on the run, and while any card has unmerged work (listed); then one archive file and nothing deleted; Restore puts the cards back as Done, refusing an id clash", async () => {
  const { repo, board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const a = board.get((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "A", prompt: "a" })).id);
  event(board, a.id, { hook_event_name: "SessionStart", session_id: a.sessionId });
  settle(board, a);
  await sleep(100); settle(board, m); // the master's run for A's settle notice ends
  fs.writeFileSync(path.join(a.worktree, "a.txt"), "two\n");
  sh(a.worktree, "commit", "-qam", "A's work");
  await assert.rejects(board.archiveRun(m), /^Error: Archive run waits until the master card is Done/);
  board.update(a, { status: "done" });
  await sleep(100); settle(board, m);
  board.update(m, { status: "done" });
  const tasksBefore = fs.readFileSync(board.file, "utf8");
  // A's commit is not in the master's branch: the archive stops and names it; nothing moved.
  await assert.rejects(board.archiveRun(m), new RegExp(`^Error: Cannot archive: "A" \\(${a.id}: commits not in task/${m.id}\\) has unmerged work\\.$`));
  assert.equal(fs.readFileSync(board.file, "utf8"), tasksBefore);
  assert.equal(fs.existsSync(path.join(board.dir, "archive", `${m.id}.json`)), false);
  // Merged into the master's branch, which is not in the repo's branch yet: now the master is the one with unmerged work.
  sh(m.worktree, "merge", "-q", "--no-edit", a.branch);
  await assert.rejects(board.archiveRun(m), new RegExp(`^Error: Cannot archive: "Run one" \\(${m.id}: commits not in HEAD\\) has unmerged work\\.$`));
  sh(repo, "merge", "-q", "--no-edit", m.branch);
  // Uncommitted work counts too; and a card of the user's under the run would lose its parent.
  fs.writeFileSync(path.join(a.worktree, "notes.txt"), "draft\n");
  await assert.rejects(board.archiveRun(m), new RegExp(`^Error: Cannot archive: "A" \\(${a.id}: uncommitted changes\\) has unmerged work\\.$`));
  fs.rmSync(path.join(a.worktree, "notes.txt"));
  const mine = board.add("Mine", "p", "acct", a.id);
  await assert.rejects(board.archiveRun(m), /^Error: Cannot archive: "Mine" stays on the board and depends on this run's cards/);
  board.remove(mine);
  // Archived: the records leave tasks.json for archive/<master>.json with the plan's path and the report; worktrees and branches stay.
  const r = await board.archiveRun(m);
  assert.deepEqual([r.count, r.file], [2, path.join(board.dir, "archive", `${m.id}.json`)]);
  const record = JSON.parse(fs.readFileSync(r.file, "utf8"));
  assert.deepEqual([record.master, record.title, record.tasks.map((t) => t.id), record.plan, record.summary.children.length], [m.id, "Run one", [m.id, a.id], board.planFile(m), 1]);
  assert.deepEqual([board.get(m.id), board.get(a.id), JSON.parse(fs.readFileSync(board.file, "utf8")).some((t) => t.id === m.id || t.id === a.id)], [undefined, undefined, false]);
  assert.deepEqual([fs.existsSync(a.worktree), sh(repo, "branch", "--list", a.branch).length > 0], [true, true], "nothing is deleted");
  assert.deepEqual(board.archivedRuns().map((x) => [x.key, x.title, x.cards]), [[m.id, "Run one", 2]]);
  // Restore refuses an id already on the board, and changes nothing.
  const clash = board.add("Clash", "p", "acct");
  const own = clash.id;
  board.update(clash, { id: a.id });
  assert.throws(() => board.restoreRun(m.id), new RegExp(`^Error: Cannot restore: "A" \\(${a.id}\\) is on the board already\\.$`));
  assert.equal(fs.existsSync(r.file), true);
  board.update(clash, { id: own });
  board.remove(clash);
  // Restored as Done; the file moves to archive/restored, so nothing is lost and a later archive never overwrites a file.
  assert.equal(board.restoreRun(m.id).count, 2);
  assert.deepEqual([board.get(m.id).status, board.get(a.id).status, fs.existsSync(r.file), fs.readdirSync(path.join(board.dir, "archive", "restored")).filter((f) => f.endsWith(".json")).length, board.archivedRuns().length], ["done", "done", false, 1, 0]);
  fs.writeFileSync(r.file, JSON.stringify({ v: 1, master: m.id, title: "older copy", archivedAt: "2026-01-01T00:00:00Z", tasks: [] }));
  const again = await board.archiveRun(board.get(m.id));
  assert.match(path.basename(again.file), new RegExp(`^${m.id}-\\d+\\.json$`));
  assert.equal(JSON.parse(fs.readFileSync(r.file, "utf8")).title, "older copy");
});

test("Archived runs: an unchanged archive file is read once across rebuilds; a rewritten one is read again (audit finding 13)", (t) => {
  const { board } = fixture();
  fs.mkdirSync(board.archiveDir, { recursive: true });
  const file = path.join(board.archiveDir, "abc123.json");
  fs.writeFileSync(file, JSON.stringify({ v: 1, master: "abc123", title: "Run", archivedAt: "2026-11-01T00:00:00Z", tasks: [{}, {}] }));
  const read = t.mock.method(fs, "readFileSync");
  const reads = () => read.mock.calls.filter((c) => c.arguments[0] === file).length;
  assert.deepEqual(board.archivedRuns().map((x) => [x.key, x.title, x.cards]), [["abc123", "Run", 2]]);
  assert.deepEqual(board.archivedRuns().map((x) => [x.key, x.title, x.cards]), [["abc123", "Run", 2]]);
  assert.equal(reads(), 1, "the second rebuild uses the cached row");
  fs.writeFileSync(file, JSON.stringify({ v: 1, master: "abc123", title: "Run renamed", archivedAt: "2026-11-01T00:00:00Z", tasks: [{}] }));
  assert.deepEqual(board.archivedRuns().map((x) => [x.title, x.cards]), [["Run renamed", 1]]);
  assert.equal(reads(), 2, "a changed size reads the file again");
});

test("measured budget: told at 80 % once, paused at 100 % once (add refused, the user notified) without stopping a running card; unmeasured cards are unknown, not zero; both survive a reload; Resume run goes on", async () => {
  const { repo, board, runEvents } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" }, orchestrator: { caps: { ...o.DEFAULT_CAPS, points: 10 }, opened: 0 } });
  settle(board, m);
  const sent = recordFollowUps(board);
  const add = async (title) => board.get((await request(board, { op: "add", by: m.id, session: m.sessionId, title, prompt: title })).id);
  const a = await add("A"), b = await add("B"), c = await add("C");
  for (const t of [a, b, c]) event(board, t.id, { hook_event_name: "SessionStart", session_id: t.sessionId });
  event(board, b.id, { hook_event_name: "UserPromptSubmit", prompt: "p" }); board.syncStatus(b.id);
  const run = (start, end) => [{ startedAt: 1, start: { at: 1, fiveHour: start }, endedAt: 2, end: { at: 2, fiveHour: end } }];
  board.update(c, { usageRuns: [{ startedAt: 1, endedAt: 2, end: { at: 2, fiveHour: 40 } }] }); // no reading at its start: unknown
  board.update(a, { usageRuns: run(10, 18.5) });
  settle(board, c);
  settle(board, a); // its run ends: 8.5 of 10 points
  await sleep(100); settle(board, m); await sleep(100); settle(board, m); await sleep(100);
  assert.equal(m.budgetNoticed, 80);
  const told = sent.filter((s) => s.id === m.id && /Budget: /.test(s.text));
  assert.equal(told.length, 1, JSON.stringify(sent));
  assert.match(told[0].text, /Budget: this run has used 8\.5 of its 10 points of the 5-hour window \(85 %\); \d cards? ha(s|ve) no measurable reading and count as unknown\. At 100 %/);
  assert.ok(board.runSummaryOf(m).budget.unknown.includes(c.id));
  // Past 100 %: the run pauses; the running child is not stopped; add is refused; the user gets one notification.
  settle(board, m);
  const d = await add("D");
  event(board, d.id, { hook_event_name: "SessionStart", session_id: d.sessionId });
  board.update(d, { usageRuns: run(0, 2) });
  settle(board, d);
  assert.deepEqual([m.paused, m.budgetNoticed, b.status, !!board.terminal(b)], ["budget", 100, "running", true]);
  assert.deepEqual(runEvents.filter((e) => e.kind === "budget").map((e) => e.text), ["10.5 of 10 points"]);
  assert.equal((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "E", prompt: "e" })).error, "Run paused: points budget reached (caps.points 10); the user's Resume run continues it");
  board.checkBudget(m);
  assert.equal(runEvents.filter((e) => e.kind === "budget").length, 1, "once");
  // A window reload: the pause and the threshold are on the card, the held budget notice in the durable inbox.
  await sleep(100); settle(board, m); await sleep(100);
  board.dispose();
  const next = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  boards.push(next);
  next.accountList = board.accountList; next.accountFolderList = board.accountFolderList; next.preflightHeadless = async () => {}; next.requestRateMs = 0;
  const events2 = [];
  next.onRun((e) => events2.push(e));
  const sent2 = recordFollowUps(next);
  next.tick();
  const m2 = next.get(m.id);
  assert.deepEqual([m2.paused, m2.budgetNoticed], ["budget", 100]);
  next.checkBudget(m2);
  assert.deepEqual(events2.filter((e) => e.kind === "budget"), [], "not again after the reload");
  // the user's Resume run: the held budget notice goes, and the same budget does not pause the run again.
  next.resumeRun(m2);
  await sleep(150);
  next.checkBudget(m2);
  assert.deepEqual([m2.paused, m2.budgetNoticed], [undefined, 100]);
  assert.ok(sent2.some((s) => s.id === m.id && /The board paused the run/.test(s.text)), JSON.stringify(sent2));
});

test("safe controls: discard needs user review; switch through Switch account and resume; finish self is a request: the board itself merges, pushes, installs or publishes nothing", async () => {
  const { repo, board, runEvents } = fixture();
  // Delivery every N turns (deliver.ts) would fast-forward main to the master's branch in the background; under load it landed after the
  // heads below were read, so main looked moved by finish self. This test is about finish self, so delivery is off.
  board.deliverEveryTurns = () => 0;
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const a = board.get((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "A", prompt: "a" })).id);
  event(board, a.id, { hook_event_name: "SessionStart", session_id: a.sessionId });
  settle(board, a);
  await sleep(100); settle(board, m);
  fs.writeFileSync(path.join(a.worktree, "a.txt"), "child work\n");
  fs.writeFileSync(path.join(a.worktree, ".gitignore"), "private.tmp\n");
  sh(a.worktree, "add", ".gitignore");
  sh(a.worktree, "commit", "-qam", "child work");
  const ask = (op, extra = {}) => request(board, { op, by: m.id, session: m.sessionId, ...extra });
  // An automatic discard must never remove a branch or worktree, even after a clean merge.
  const refused = /Automatic discard is unavailable.*review this task.*Discard manually/;
  const branch = a.branch, worktree = a.worktree;
  assert.match((await ask("discard", { id: a.id })).error, refused);
  assert.deepEqual([fs.existsSync(worktree), a.status], [true, "review"]);
  sh(m.worktree, "merge", "-q", "--no-edit", branch);
  fs.writeFileSync(path.join(worktree, "scratch.txt"), "keep me\n");
  assert.match((await ask("discard", { id: a.id })).error, refused);
  assert.equal(fs.readFileSync(path.join(worktree, "scratch.txt"), "utf8"), "keep me\n");
  fs.rmSync(path.join(worktree, "scratch.txt"));
  fs.writeFileSync(path.join(worktree, "private.tmp"), "ignored work\n");
  assert.equal(sh(worktree, "status", "--porcelain"), "", "ignored work is invisible to normal clean checks");
  assert.match((await ask("discard", { id: a.id })).error, refused);
  assert.equal(fs.readFileSync(path.join(worktree, "private.tmp"), "utf8"), "ignored work\n");
  fs.rmSync(path.join(worktree, "private.tmp"));
  assert.ok(sh(repo, "branch", "--list", branch));
  assert.ok(fs.existsSync(worktree));
  assert.equal(a.status, "review");
  // The existing user-initiated flow remains available after its confirmation.
  await board.finish(a, "discard");
  assert.deepEqual([a.status, a.worktree, sh(repo, "branch", "--list", branch)], ["done", undefined, ""]);
  await sleep(100); settle(board, m);
  // Switch: busy while it runs; no headroom refused; then the F41 path moves it and its next run starts on the new account.
  const b = board.get((await ask("add", { title: "B", prompt: "b" })).id);
  event(board, b.id, { hook_event_name: "SessionStart", session_id: b.sessionId });
  event(board, b.id, { hook_event_name: "UserPromptSubmit", prompt: "p" }); board.syncStatus(b.id);
  assert.equal((await ask("switch", { id: b.id, account: "spare" })).error, "busy: stop it first");
  settle(board, b);
  await sleep(100); settle(board, m);
  fs.mkdirSync(process.env.ENTOMATICAL_USAGE_DIR, { recursive: true });
  const usage = (key, fiveHour) => fs.writeFileSync(path.join(process.env.ENTOMATICAL_USAGE_DIR, `${key}.json`), JSON.stringify({ fiveHour, week: 10, at: Date.now(), source: "query" }));
  usage("spare", 99);
  assert.equal((await ask("switch", { id: b.id, account: "spare" })).error, "switch: spare has no headroom (5-hour window 99 % used)");
  usage("spare", 5);
  const s = await ask("switch", { id: b.id, account: "spare" });
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.deepEqual([b.account, b.switchedTo, terminals.at(-1).options.name, terminals.at(-1).options.env.CLAUDE_CONFIG_DIR], ["spare", "spare", `En ${b.id}`, path.join(home, "spare")]);
  settle(board, b);
  board.update(b, { status: "done" });
  await sleep(100); settle(board, m);
  // finish self, mid-turn: a request. The board itself merges and pushes nothing: at the Stop it only fires finishReady, which the
  // extension's autoFinish (src/auto-finish.ts) acts on; no Needs input and no dialog.
  event(board, m.id, { hook_event_name: "UserPromptSubmit", prompt: "wrap up" }); board.syncStatus(m.id);
  const heads = () => [sh(repo, "rev-parse", "main"), sh(repo, "rev-parse", m.branch), sh(repo, "remote"), sh(repo, "status", "--porcelain")];
  // The every-3-turns delivery queued by an earlier Stop merges m's branch into main asynchronously; let it land before the snapshot.
  await board.deliveries;
  const before = heads();
  board.complete = async () => { throw new Error("only autoFinish runs Finish"); };
  const me = { ENTOMATICAL_TASK: m.id, CLAUDE_CODE_SESSION_ID: m.sessionId };
  const f = await cli(board, repo, ["finish", "self"], me);
  assert.deepEqual([f.code, f.out], [0, "ok  The board reviews the run when this turn ends. On Done it merges, pushes and cleans up by itself; otherwise it sends you what is left.\n"]);
  assert.deepEqual([m.status, typeof m.finishAsked.at, m.deliveryReady, runEvents.some((e) => e.kind === "finishReady")], ["running", "string", true, false]);
  settle(board, m);
  assert.deepEqual([m.status, runEvents.at(-1).kind, runEvents.at(-1).master], ["review", "finishReady", m]);
  m.updatedAt = new Date(Date.now() - 20_000).toISOString();
  board.tick();
  assert.deepEqual([m.status, m.interrupted, heads()], ["review", undefined, before], "not Interrupted; main, the branch, the remotes and the checkout unchanged");
  assert.equal((await cli(board, repo, ["finish", "self"], me)).out, "refused: finish: already asked; the board reviews the run when this turn ends, or the card waits for the user\n");
  // A bare `finish` is refused by the command itself, before any request is written. Its message has named `finish <id>` beside
  // `finish self` since 777026d5 (18 November 2026); this test had kept the wording from before that commit.
  await assert.rejects(cli(board, repo, ["finish"], me), /^Error: finish needs `self` \(the board reviews and finishes your own card's run\) or the id of a card whose work has landed\.$/);
  for (const op of ["merge", "push", "install"]) assert.equal((await ask(op, { id: m.id })).error, `Unknown op ${op}`);
  assert.equal(typeof board.dismissFinish, "undefined", "the Review-the-plan request and its Dismiss are gone");
});

// The reviewer's prompt ends "When this is done, call board.js finish self again." After an automatic round, and after Accept prompt
// (which clears finishAsked, test/prepare-task.test.js "Accept prompt sends the prompt through the Fix it route"), that call is accepted.
test("finish self after an automatic round, or after Accept prompt, is accepted and leads to a new review", async () => {
  const { autoFinish } = require("../out/auto-finish.js");
  const { repo, board, runEvents } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const me = { ENTOMATICAL_TASK: m.id, CLAUDE_CODE_SESSION_ID: m.sessionId };
  const ready = () => runEvents.filter((e) => e.kind === "finishReady").length;
  const turn = async () => { event(board, m.id, { hook_event_name: "UserPromptSubmit", prompt: "p" }); board.syncStatus(m.id); return cli(board, repo, ["finish", "self"], me); };
  const accepted = /^ok  The board reviews the run when this turn ends\./;
  const notDone = (condition) => ({ findings: [{ condition, status: "not-met", evidence: "missing" }], other: "", explanation: "x", verdict: "not-done",
    prompt: `Reopen ${condition}. When this is done, call board.js finish self again.`, questions: [], file: "f.md", model: "fable", effort: "medium", at: "now", receipt: path.join(repo, "none.json") });
  const reviews = [notDone("A"), notDone("B"), notDone("C")], prompts = [];
  const deps = { review: async () => reviews.shift(), closeTab: async () => undefined };
  board.followUpHeadless = async (t, text) => { prompts.push(text); };
  assert.match((await turn()).out, accepted);
  settle(board, m);
  assert.equal(ready(), 1);
  // An automatic round sends the prompt back and ends the request: the next finish self is accepted, and its Stop reviews again.
  assert.equal(await autoFinish(board, m, deps), "sent-back");
  assert.match((await turn()).out, accepted);
  settle(board, m);
  assert.equal(ready(), 2);
  assert.equal(await autoFinish(board, m, deps), "sent-back");
  assert.deepEqual([prompts.length, m.autoRounds], [2, 2]);
  // Past the limit it waits for the user; a finish self meanwhile is refused with what it waits for.
  assert.match((await turn()).out, accepted);
  settle(board, m);
  assert.equal(await autoFinish(board, m, deps), "asked");
  assert.equal(m.status, "needs-input");
  assert.match((await cli(board, repo, ["finish", "self"], me)).out, /^refused: finish: already asked; the board reviews the run when this turn ends, or the card waits for the user/);
  // Accept prompt: the prompt goes to the session and the request ends (the extension's acceptReview), so finish self is accepted again.
  board.update(m, { finishAsked: undefined });
  assert.match((await turn()).out, accepted);
  settle(board, m);
  assert.equal(ready(), 4);
});

test("pressure watcher requires explicit approval and free capacity, then owns its exact notice set", async () => {
  const { board } = fixture();
  board.watcherPath = path.join(__dirname, "..", "docs", "orchestrator", "WATCHER.md"); // F73: the brief as the extension places it
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  board.update(m, { status: "running", runPolicy: { allow: ["npm test"], deny: ["git push"], noSync: true } });
  const a = board.add("A", "a", "acct", m.id, undefined, undefined, undefined, { openedBy: m.id, watchedBy: m.id });
  const b = board.add("B", "b", "acct", m.id, undefined, undefined, undefined, { openedBy: m.id, watchedBy: m.id });
  board.update(a, { status: "review" }); board.update(b, { status: "review" });
  await sleep(50);
  assert.equal(board.tasks.filter((t) => t.role === "sub").length, 0, "existing approvals cannot silently create extra paid work");
  board.update(m, { approved: { at: "x", hash: "h", pressureWatchers: true }, orchestrator: { ...m.orchestrator, caps: { ...m.orchestrator.caps, pending: 2, open: 2 } } });
  await sleep(50);
  assert.equal(board.tasks.filter((t) => t.role === "sub").length, 0, "a full run does not bypass its open-card cap");
  board.update(m, { orchestrator: { ...m.orchestrator, caps: { ...m.orchestrator.caps, open: 3 } } });
  for (let i = 0; i < 100 && !board.tasks.some((t) => t.role === "sub" && t.sessionId); i++) await sleep(50);
  const watcher = board.tasks.find((t) => t.role === "sub");
  assert.ok(watcher && watcher.sessionId, "an approved watcher starts when the slot is available");
  assert.deepEqual([a.watchedBy, b.watchedBy], [watcher.id, watcher.id]);
  assert.equal(m.orchestrator.opened, 1);
  // F73 (the user, 9 November 2026): a Claude root's watcher runs Opus at medium, not the root's haiku/low, on the root's account.
  assert.deepEqual([watcher.model, watcher.effort, watcher.account], ["opus", "medium", m.account]);
  // Its prompt is WATCHER.md's body without the frontmatter, then the assignment: cards, root, run policy and follow-up cap.
  const brief = fs.readFileSync(board.watcherPath, "utf8"), body = brief.slice(brief.indexOf("\n---", 3) + 4).trim();
  assert.ok(watcher.prompt.startsWith(body.slice(0, 200)), "the prompt starts with the brief's body");
  assert.ok(!/^---|name: pressure-watcher|model: opus/.test(watcher.prompt), "no frontmatter");
  const assignment = watcher.prompt.slice(watcher.prompt.indexOf("## Your assignment"));
  for (const want of [a.id, b.id, `Root: ${m.id}`, "allow: npm test", "deny: git push", `Follow-up cap: ${m.orchestrator.caps.followUps} per card`])
    assert.ok(assignment.includes(want), `the assignment names ${want}`);
  // F73 (the user, 9 November 2026): a watcher merges every card it accepts into its own branch by default.
  assert.match(assignment, /Merge: merge every card you accept into your own branch \(git merge --no-edit task\/<id>\)/);
  assert.match(watcher.prompt, /Merge every card you accept into your own branch: `git merge --no-edit task\/<id>`, then `done <id>`/);
  assert.doesNotMatch(watcher.prompt, /only when (?:the run policy or the root )?authori[sz]e/i);
  assert.equal(board.refusalOf({ op: "ready", by: watcher.id, session: watcher.sessionId, nonce: "n", v: 1, at: "now" }), "Watched cards are not finished");
  assert.match(fs.readFileSync(path.join(board.dir, "launch", `${watcher.id}.prompt.txt`), "utf8"), new RegExp(`Pending board messages:[\\s\\S]*${a.id}`));
  assert.ok(board.receiveMessages(m.id).some((s) => s.includes(`watching ${a.id}`) || s.includes(`watching ${b.id}`)));
  event(board, watcher.id, { hook_event_name: "SessionStart", session_id: watcher.sessionId });
  event(board, watcher.id, { hook_event_name: "UserPromptSubmit", session_id: watcher.sessionId, prompt: "watch" }); board.syncStatus(watcher.id);
  event(board, watcher.id, { hook_event_name: "Interrupt", session_id: watcher.sessionId }); board.syncStatus(watcher.id);
  assert.deepEqual([a.watchedBy, b.watchedBy], [m.id, m.id], "interrupted watcher returns the cards to their root");
  assert.match(m.pressureError, /returned to the root/);
});

test("standing judge sleeps until requested and its verdict gates completion of the reviewed commit", async () => {
  const { board } = fixture();
  board.checks.start = () => {};
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const before = terminals.length;
  const j = await request(board, { op: "add", by: m.id, session: m.sessionId, title: "Judge", prompt: "Review the assigned change.", role: "judge" });
  const judge = board.get(j.id);
  assert.equal(j.started, false);
  assert.deepEqual([judge.role, judge.status, judge.sessionId, terminals.length], ["judge", "review", undefined, before]);
  assert.match((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "Judge 2", prompt: "review", role: "judge" })).error, /already stands/);
  const result = await request(board, { op: "add", by: m.id, session: m.sessionId, title: "Work", prompt: "do it", judge: true,
    completion: { commands: ["git status"], goal: "A bounded change", doneWhen: "Checks pass" } });
  assert.ok(result.id, JSON.stringify(result));
  const child = board.get(result.id);
  event(board, child.id, { hook_event_name: "SessionStart", session_id: child.sessionId });
  event(board, child.id, { hook_event_name: "UserPromptSubmit", session_id: child.sessionId, prompt: "work" });
  board.syncStatus(child.id);
  assert.match((await request(board, { op: "done", by: m.id, session: m.sessionId, id: child.id })).error, /Not ready/);
  const revision = sh(child.worktree, "rev-parse", "HEAD");
  board.recordChecks(child, { status: "complete", run: "check-log", revision });
  settle(board, child);
  for (let i = 0; i < 100 && !judge.sessionId; i++) await sleep(50);
  assert.ok(judge.sessionId, "the judge wakes only after the child settles with passed checks");
  assert.equal(JSON.parse(fs.readFileSync(board.hooksFile(judge.id), "utf8")).permissions.defaultMode, "plan");
  assert.equal(judge.judging.id, child.id);
  assert.equal(child.judged, undefined);
  assert.match(fs.readFileSync(path.join(board.dir, "launch", `${judge.id}.prompt.txt`), "utf8"), new RegExp(`Review child ${child.id} at commit ${revision}`));
  event(board, judge.id, { hook_event_name: "SessionStart", session_id: judge.sessionId });
  event(board, judge.id, { hook_event_name: "UserPromptSubmit", session_id: judge.sessionId, prompt: "judge" });
  board.syncStatus(judge.id);
  terminals.find((t) => t.options.name === `En ${judge.id}` && !t.exitStatus).exit(0);
  event(board, judge.id, { hook_event_name: "Stop", session_id: judge.sessionId, last_assistant_message: `verdict: pass for child ${child.id}\n- Checks match.` });
  board.syncStatus(judge.id);
  for (let i = 0; i < 100 && !child.judged; i++) await sleep(20);
  assert.equal(child.judged, "pass");
  assert.equal(child.judgedRevision, revision);
  assert.equal(child.status, "review", "a model verdict cannot mark a card Done");
  assert.equal((await request(board, { op: "done", by: m.id, session: m.sessionId, id: child.id })).ok, true);
});

test("an explicit watcher can supervise only eligible children, and approval is rechecked after runner preflight", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const a = (await request(board, { op: "add", by: m.id, session: m.sessionId, title: "A", prompt: "a", start: "manual" })).id;
  const outsider = board.add("Other", "x", "acct");
  let r = await request(board, { op: "add", by: m.id, session: m.sessionId, title: "Watch", prompt: "review", mayOpen: true, watch: [outsider.id] });
  assert.match(r.error, /available direct child/);
  r = await request(board, { op: "add", by: m.id, session: m.sessionId, title: "Watch", prompt: "review", mayOpen: true, watch: [a], start: "manual" });
  const sub = board.get(r.id);
  assert.deepEqual([sub.role, board.get(a).watchedBy, r.started], ["sub", sub.id, false]);
  assert.match(sub.prompt, new RegExp(`Supervise only these assigned cards: ${a}`));
  board.update(sub, { sessionId: "watcher-session" });
  r = await request(board, { op: "add", by: sub.id, session: sub.sessionId, title: "Nested", prompt: "x", mayOpen: true });
  assert.match(r.error, /may not open another coordinator/);
  const count = board.tasks.length;
  board.preflightHeadless = async () => { board.pauseRun(m); };
  r = await request(board, { op: "add", by: m.id, session: m.sessionId, title: "Raced", prompt: "x" });
  assert.match(r.error, /Run paused/);
  assert.equal(board.tasks.length, count, "nothing is allocated if the run pauses during preflight");
});

test("cancelled watcher with completed children cannot hide its unmerged branch from root readiness", async () => {
  const { board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const child = board.get((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "Child", prompt: "work", start: "manual" })).id);
  const sub = board.get((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "Watch", prompt: "review", mayOpen: true, watch: [child.id] })).id);
  event(board, sub.id, { hook_event_name: "SessionStart", session_id: sub.sessionId });
  event(board, sub.id, { hook_event_name: "UserPromptSubmit", session_id: sub.sessionId, prompt: "watch" }); board.syncStatus(sub.id);
  await board.startHeadless(child);
  fs.writeFileSync(path.join(child.worktree, "child.txt"), "child work\n");
  sh(child.worktree, "add", "child.txt"); sh(child.worktree, "commit", "-qm", "child work");
  event(board, child.id, { hook_event_name: "SessionStart", session_id: child.sessionId });
  event(board, child.id, { hook_event_name: "UserPromptSubmit", session_id: child.sessionId, prompt: "work" }); board.syncStatus(child.id);
  settle(board, child);
  assert.match((await request(board, { op: "done", by: sub.id, session: sub.sessionId, id: child.id })).error, /Merge the watched card/);
  sh(sub.worktree, "merge", "--no-edit", child.branch);
  assert.equal((await request(board, { op: "done", by: sub.id, session: sub.sessionId, id: child.id })).ok, true);
  fs.writeFileSync(path.join(sub.worktree, "watched.txt"), "must preserve\n");
  sh(sub.worktree, "add", "watched.txt"); sh(sub.worktree, "commit", "-qm", "watcher work");
  terminals.find((t) => t.options.name === `En ${sub.id}` && !t.exitStatus).exit(0);
  event(board, sub.id, { hook_event_name: "Interrupt", session_id: sub.sessionId }); board.syncStatus(sub.id);
  assert.equal(child.watchedBy, m.id, "even completed children return to root oversight");
  assert.equal((await request(board, { op: "cancel", by: m.id, session: m.sessionId, id: sub.id })).ok, true);
  assert.match((await request(board, { op: "ready", by: m.id, session: m.sessionId })).error, /unmerged work/);
  sh(m.worktree, "merge", "--no-edit", sub.branch);
  assert.equal((await request(board, { op: "ready", by: m.id, session: m.sessionId })).ok, true);
  assert.equal(fs.readFileSync(path.join(m.worktree, "watched.txt"), "utf8"), "must preserve\n");
});

test("pressure watchers take queued notices before newer running cards", async () => {
  const { board } = fixture();
  board.watcherPath = path.join(board.dir, "no-such-WATCHER.md"); // F73: a brief that cannot be read gives the old prompt
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  board.update(m, { status: "running" });
  const queuedNotice = board.add("Settled", "a", "acct", m.id, undefined, undefined, undefined, { openedBy: m.id, watchedBy: m.id });
  board.update(queuedNotice, { status: "review" });
  const newer = board.add("Still working", "b", "acct", m.id, undefined, undefined, undefined, { openedBy: m.id, watchedBy: m.id });
  board.update(newer, { status: "running" });
  board.update(m, { approved: { at: "x", hash: "h", pressureWatchers: true }, orchestrator: { ...m.orchestrator, caps: { ...m.orchestrator.caps, pending: 1, perWatcher: 1, open: 3 } } });
  for (let i = 0; i < 100 && !board.tasks.some((t) => t.role === "sub" && t.sessionId); i++) await sleep(50);
  const watcher = board.tasks.find((t) => t.role === "sub");
  assert.ok(watcher?.sessionId);
  assert.equal(queuedNotice.watchedBy, watcher.id);
  assert.equal(newer.watchedBy, m.id);
  assert.equal(watcher.prompt, o.watcherFallback([queuedNotice.id]));
  assert.ok(watcher.prompt.startsWith(`Supervise only these existing cards: ${queuedNotice.id}.`));
  // F73 (the user, 9 November 2026): the fallback carries the same merge-by-default rule.
  assert.match(watcher.prompt, /Merge every card you accept into your own branch \(git merge --no-edit task\/<id>\)/);
  assert.doesNotMatch(watcher.prompt, /only when authori[sz]ed/i);
});

test("a saved judge assignment recovers its missing notice exactly once after reload", async () => {
  const { repo, board } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m); board.pauseRun(m);
  const worker = board.add("Work", "x", "acct", m.id, undefined, undefined, undefined, { openedBy: m.id, watchedBy: m.id, judge: true });
  const judge = board.add("Judge", "Review", "acct", m.id, undefined, undefined, undefined, { openedBy: m.id, watchedBy: m.id, headless: true, role: "judge" });
  board.update(judge, { status: "review", judging: { id: worker.id, revision: "abc123", at: Date.now(), prompt: "Recover this exact assignment.", phase: "pending" } });
  assert.equal(judge.sessionId, undefined);
  const rootId = m.id, judgeId = judge.id;
  board.dispose();
  const next = new Board(repo, path.join(repo, "hook.js"), undefined, false); boards.push(next);
  next.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }]; next.accountFolderList = () => [path.join(home, "acct")]; next.preflightHeadless = async () => {}; next.tick();
  next.resumeRun(next.get(rootId));
  for (let i = 0; i < 100 && !next.get(judgeId).sessionId; i++) await sleep(50);
  assert.ok(next.get(judgeId).sessionId, "the assignment is dispatched after the owner returns");
  assert.match(fs.readFileSync(path.join(next.dir, "launch", `${judgeId}.prompt.txt`), "utf8"), /Recover this exact assignment/);
  await sleep(100);
  assert.equal(terminals.filter((t) => t.options.name === `En ${judgeId}` && !t.exitStatus).length, 1);
});

test("subsequent judge and scribe assignments recover after reload without duplicate deliveries", async () => {
  for (const roleName of ["judge", "scribe"]) {
    const { repo, board } = fixture();
    const root = await master(board, { approved: { at: "x", hash: "h" } }); settle(board, root);
    const role = board.add(roleName, "Review", "acct", root.id, undefined, undefined, undefined, { openedBy: root.id, watchedBy: root.id, headless: true, role: roleName });
    await board.startHeadless(role); settle(board, role);
    board.pauseRun(root);
    const assignment = { at: Date.now() + 5000, prompt: `Recover second ${roleName} turn.`, phase: "pending" };
    if (roleName === "judge") role.judging = { ...assignment, id: "abcdef", revision: "123456" };
    else role.scribe = { documents: ["REPORT.md"], milestones: [{ name: "fix", cards: ["abcdef"] }], active: { ...assignment, name: "fix" } };
    board.save(); const before = terminals.filter((t) => t.options.name === `En ${role.id}`).length, rootId = root.id, roleId = role.id; board.dispose();
    const next = new Board(repo, path.join(repo, "hook.js"), undefined, false); boards.push(next);
    next.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }]; next.accountFolderList = () => [path.join(home, "acct")]; next.preflightHeadless = async () => {}; next.tick();
    next.resumeRun(next.get(rootId));
    for (let i = 0; i < 100 && terminals.filter((t) => t.options.name === `En ${roleId}`).length === before; i++) await sleep(50);
    assert.equal(terminals.filter((t) => t.options.name === `En ${roleId}`).length, before + 1, `${roleName} follow-up starts`);
    assert.match(fs.readFileSync(path.join(next.dir, "launch", `${roleId}.followup.txt`), "utf8"), new RegExp(`Recover second ${roleName} turn`));
    next.tick(); await sleep(100); assert.equal(terminals.filter((t) => t.options.name === `En ${roleId}`).length, before + 1, "no duplicate follow-up");
  }
});

test("an uncertain previously dispatched role assignment is held instead of sent twice", async () => {
  const { repo, board } = fixture();
  const root = await master(board, { approved: { at: "x", hash: "h" } }); settle(board, root);
  const role = board.add("Judge", "Review", "acct", root.id, undefined, undefined, undefined, { openedBy: root.id, watchedBy: root.id, headless: true, role: "judge" });
  await board.startHeadless(role); settle(board, role); board.pauseRun(root);
  role.judging = { id: "abcdef", revision: "123456", at: Date.now() + 5000, prompt: "Maybe delivered", phase: "dispatching" }; board.save();
  const before = terminals.filter((t) => t.options.name === `En ${role.id}`).length, rootId = root.id, roleId = role.id; board.dispose();
  const next = new Board(repo, path.join(repo, "hook.js"), undefined, false); boards.push(next);
  next.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }]; next.preflightHeadless = async () => {}; next.tick(); next.resumeRun(next.get(rootId));
  await sleep(100); assert.match(next.get(roleId).stepHold, /may have started/); assert.equal(terminals.filter((t) => t.options.name === `En ${roleId}`).length, before);
});

// Seen on linux, 6 November 2026 (F74): a window reload during the standing judge's turn. The hidden run lived on, but the new window
// did not see its terminal yet, so it held the judge. The turn then ended: the verdict landed once, yet the judge kept "Needs you" and
// the plan could not deliver ("The standing judge has an unfinished assignment or needs review.").
test("a judge held after a reload is released when that turn ends: the verdict lands once and the hold goes", async () => {
  const { repo, board } = fixture();
  board.checks.start = () => {};
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const judge = board.get((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "Judge", prompt: "Review the assigned change.", role: "judge" })).id);
  const child = board.get((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "Work", prompt: "do it", judge: true,
    completion: { commands: ["git status"], goal: "A bounded change", doneWhen: "Checks pass" } })).id);
  event(board, child.id, { hook_event_name: "SessionStart", session_id: child.sessionId });
  event(board, child.id, { hook_event_name: "UserPromptSubmit", session_id: child.sessionId, prompt: "work" });
  board.syncStatus(child.id);
  const revision = sh(child.worktree, "rev-parse", "HEAD");
  board.recordChecks(child, { status: "complete", run: "check-log", revision });
  settle(board, child);
  for (let i = 0; i < 100 && !judge.sessionId; i++) await sleep(50);
  event(board, judge.id, { hook_event_name: "SessionStart", session_id: judge.sessionId });
  event(board, judge.id, { hook_event_name: "UserPromptSubmit", session_id: judge.sessionId, prompt: "judge" });
  board.syncStatus(judge.id);
  assert.equal(judge.judging?.phase, "dispatching");
  // The window reloads mid-turn; the stand-in's terminals carry no name, so the new window cannot see the judge's (as on linux).
  const judgeId = judge.id, childId = child.id;
  board.dispose();
  const next = new Board(repo, path.join(repo, "hook.js"), undefined, false); boards.push(next);
  next.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }]; next.accountFolderList = () => [path.join(home, "acct")]; next.preflightHeadless = async () => {}; next.tick();
  await sleep(100);
  assert.match(next.get(judgeId).stepHold ?? "", /may have started/);
  const launches = terminals.filter((t) => t.options.name === `En ${judgeId}`).length;
  // That turn ends.
  event(next, judgeId, { hook_event_name: "Stop", session_id: next.get(judgeId).sessionId, last_assistant_message: `verdict: pass for child ${childId}\n- Checks match.` });
  next.syncStatus(judgeId);
  for (let i = 0; i < 100 && !next.get(childId).judged; i++) await sleep(20);
  assert.equal(next.get(childId).judged, "pass");
  assert.equal(next.get(childId).judgedRevision, revision);
  assert.equal(next.get(judgeId).stepHold, undefined, "the turn the hold doubted has ended and its verdict was applied");
  assert.equal(terminals.filter((t) => t.options.name === `En ${judgeId}`).length, launches, "no second judge turn");
});

test("a terminal that closes before provider startup stays distinguishable from a confirmed session", async () => {
  const { board, repo } = fixture();
  const root = await master(board, { approved: { at: "now", hash: "h" } });
  const result = await request(board, { op: "add", by: root.id, session: root.sessionId, title: "Worker", prompt: "Work" });
  const worker = board.get(result.id), term = board.terminal(worker);
  assert.equal(result.launchState, "dispatched");
  term.exit(134);
  board.terminalClosed(term);
  assert.equal(board.statusOf(worker).launchState, "exited-unconfirmed");
  const shown = require("../tools/board.js").showText(repo, worker.id);
  assert.match(shown, /launch state: exited-unconfirmed/);
  event(board, worker.id, { hook_event_name: "SessionStart", session_id: "older-session" });
  assert.equal(board.statusOf(worker).launchState, "exited-unconfirmed");
  event(board, worker.id, { hook_event_name: "SessionStart", session_id: worker.sessionId });
  assert.equal(board.statusOf(worker).launchState, "confirmed");
});

test("a stopped watcher with only cancelled assignments still preserves its branch", async () => {
  const { board } = fixture();
  const root = await master(board, { approved: { at: "x", hash: "h" } }); settle(board, root);
  const child = board.get((await request(board, { op: "add", by: root.id, session: root.sessionId, title: "Child", prompt: "work", start: "manual" })).id);
  const watcher = board.get((await request(board, { op: "add", by: root.id, session: root.sessionId, title: "Watch", prompt: "review", mayOpen: true, watch: [child.id] })).id);
  fs.writeFileSync(path.join(watcher.worktree, "watcher.txt"), "preserve\n");
  sh(watcher.worktree, "add", "watcher.txt"); sh(watcher.worktree, "commit", "-qm", "watcher work");
  board.update(child, { cancelled: true });
  terminals.find((t) => t.options.name === `En ${watcher.id}` && !t.exitStatus).exit(0);
  assert.equal((await request(board, { op: "cancel", by: root.id, session: root.sessionId, id: watcher.id })).ok, true);
  assert.match((await request(board, { op: "ready", by: root.id, session: root.sessionId })).error, /unmerged work/);
  sh(root.worktree, "merge", "--no-edit", watcher.branch);
  assert.equal((await request(board, { op: "ready", by: root.id, session: root.sessionId })).ok, true);
});

test("disposing the owner during worker preflight cannot allocate a card", async () => {
  const { board } = fixture();
  const root = await master(board, { approved: { at: "x", hash: "h" } }); settle(board, root);
  let release, entered; const gate = new Promise((resolve) => { release = resolve; });
  board.preflightHeadless = async () => { entered = true; await gate; };
  const before = board.tasks.length;
  const pending = board.handleRequest({ v: 1, op: "add", by: root.id, session: root.sessionId, title: "Worker", prompt: "work" }, "owner-disposed-preflight");
  for (let i = 0; i < 100 && !entered; i++) await sleep(10);
  assert.equal(entered, true); board.dispose(); release();
  await assert.rejects(pending, /Another VS Code window/); assert.equal(board.tasks.length, before);
});

// ---- F117: Make orchestrator on a card of the user's own (17 November 2026). ----

test("F117: the native Codex editor receives its queued delegation brief with only its thread ID", async () => {
  const { board } = fixture();
  const card = board.add("Panel receive", "p", "acct");
  await board.ensureWorktree(card);
  const thread = "native-editor-thread";
  board.update(card, { provider: "codex", codexEditor: true, sessionId: thread, status: "review" });
  assert.equal(board.makeOrchestrator(card), false);
  const receive = (env) => cli(board, card.worktree, ["receive"], env);
  const editor = { CODEX_THREAD_ID: thread };
  assert.match((await receive({})).out, /refused: Missing by/);
  assert.match((await receive({ CODEX_THREAD_ID: "unrelated-thread" })).out, /refused: Missing by/);
  for (const env of [{ ENTOMATICAL_SESSION: thread }, { CLAUDE_CODE_SESSION_ID: thread }, { ...editor, ENTOMATICAL_RUNTIME: "grok" },
    { ...editor, CLAUDE_CODE_SESSION_ID: "another-session" }]) assert.match((await receive(env)).out, /refused: Missing by/);
  const received = await receive(editor);
  assert.equal(received.code, 0, received.out);
  assert.ok(JSON.parse(received.out)[0].startsWith(`the user enabled delegation for this card (${card.id}).`));
  const done = path.join(board.dir, "inbox", "done");
  const receipt = fs.readdirSync(done).map((f) => JSON.parse(fs.readFileSync(path.join(done, f), "utf8"))).find((r) => r.messages?.length);
  assert.deepEqual([receipt.by, receipt.session], [card.id, thread]);
  assert.deepEqual(JSON.parse((await receive(editor)).out), []);
  const explicit = { ENTOMATICAL_TASK: card.id, ...editor };
  const add = ["add", "--title", "Child", "--prompt", "Work"];
  assert.match((await cli(board, card.worktree, add, editor)).out, /refused: Missing by/);
  assert.match((await cli(board, card.worktree, add, explicit)).out, /refused: Plan not approved/);
  board.update(card, { controller: { sessionId: "detached-controller", at: new Date().toISOString() } });
  board.queueNotice(card.id, "replacement", "For the replacement");
  assert.match((await receive(editor)).out, /refused: Not bound/);
  let approvals = 0;
  board.confirmRebind = async () => { approvals++; return false; };
  assert.match((await cli(board, card.worktree, ["rebind"], editor)).out, /refused: Missing by/);
  assert.equal(approvals, 0);
  assert.match((await cli(board, card.worktree, ["rebind"], explicit)).out, /Waiting for the user/);
  assert.equal(approvals, 1);
  assert.equal(card.controller.sessionId, "detached-controller");
  assert.deepEqual(JSON.parse((await receive({ ...explicit, CODEX_THREAD_ID: "detached-controller" })).out), ["For the replacement"]);
  let allow;
  board.confirmRebind = () => new Promise(resolve => { allow = resolve; });
  assert.match((await cli(board, card.worktree, ["rebind"], explicit)).out, /Waiting for the user/);
  board.update(card, { controller: { sessionId: "newer-controller", at: new Date().toISOString() } });
  allow(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(card.controller.sessionId, "newer-controller", "an approval opened against the previous binding has expired");
  for (const state of [{ status: "done" }, { status: "review", cancelled: true }]) {
    board.update(card, { ...state, controller: undefined });
    assert.match((await receive(editor)).out, /refused: Missing by/);
    assert.deepEqual(JSON.parse((await receive(explicit)).out), [], "a bound session can collect mail explicitly after closure");
  }
});

for (const [transition, change] of Object.entries({
  done: { status: "done" }, cancelled: { cancelled: true }, terminal: { codexEditor: false }, provider: { provider: "claude" },
  "different native thread": { sessionId: "new-thread", controller: { sessionId: "fixture-thread", mode: "external" } },
})) {
  test(`F117: queued inferred receive rechecks editor eligibility after transition to ${transition}`, async () => {
    const { board, repo } = fixture();
    const card = board.add("Native panel", "Work", "acct");
    const env = { CODEX_THREAD_ID: "fixture-thread" };
    board.update(card, { provider: "codex", codexEditor: true, sessionId: env.CODEX_THREAD_ID, status: "review" });
    board.queueNotice(card.id, "pending", "still queued");
    const out = [];
    const pending = require("../tools/board.js").main(["receive"], { cwd: repo, env, write: s => out.push(s) });
    assert.equal(fs.readdirSync(path.join(board.dir, "inbox")).filter(name => name.endsWith(".json")).length, 1);
    board.update(card, change);
    await board.processInbox();
    assert.equal(await pending, 1, out.join(""));
    assert.match(out.join(""), /active Codex editor/);
    const explicit = { ...env, ENTOMATICAL_TASK: card.id };
    const received = await cli(board, repo, ["receive"], explicit);
    assert.deepEqual([received.code, JSON.parse(received.out)], [0, ["still queued"]]);
    assert.deepEqual(JSON.parse((await cli(board, repo, ["receive"], explicit)).out), []);
  });
}

test("F117: Make orchestrator gives an ordinary card a root's rights and the brief, approves nothing, and is refused where it makes no sense", async () => {
  const { board } = fixture();
  board.briefPath = path.join(__dirname, "..", "docs", "orchestrator", "BRIEF.md");
  const t = board.add("Plain card", "Do a thing.", "acct", undefined, "haiku", "low", undefined, { headless: true });
  await board.startHeadless(t);
  event(board, t.id, { hook_event_name: "SessionStart", session_id: t.sessionId });
  assert.equal((await request(board, { op: "ready", by: t.id, session: t.sessionId })).error, "Not an orchestrator");
  settle(board, t); // idle in Review: the board can wake it
  assert.equal(board.makeOrchestrator(t), true);
  assert.deepEqual([t.orchestrator.opened, t.orchestrator.root, t.orchestrator.caps.open, t.approved, t.headless], [0, undefined, o.DEFAULT_CAPS.open, undefined, true]);
  for (let i = 0; i < 150 && t.status !== "running"; i++) await sleep(20);
  const sent = fs.readFileSync(path.join(board.dir, "launch", `${t.id}.followup.txt`), "utf8");
  assert.match(sent, /the user enabled delegation for this card/);
  assert.match(sent, /Nothing is approved yet/);
  assert.match(sent, /# Orchestrator brief/);
  // Its own session may ask now; opening a card still waits for the user's approval of its plan.
  assert.equal((await request(board, { op: "add", by: t.id, session: t.sessionId, title: "x", prompt: "y" })).error, "Plan not approved");
  assert.throws(() => board.makeOrchestrator(t), /an orchestrator already/);
  const child = board.add("Child", "p", "acct", t.id, undefined, undefined, undefined, { headless: true, openedBy: t.id, watchedBy: t.id });
  assert.match(board.makeOrchestratorRefusal(child), /An orchestrator opened this card/);
  const old = board.add("Old", "p", "acct");
  board.update(old, { status: "done" });
  assert.match(board.makeOrchestratorRefusal(old), /Reopen it first/);
  const fresh = board.add("Fresh", "p", "acct");
  board.orchestratorEnabled = () => false;
  assert.match(board.makeOrchestratorRefusal(fresh), /orchestrator is off/);
  board.orchestratorEnabled = () => true;
  assert.equal(board.makeOrchestratorRefusal(fresh), undefined);
  // A card the board cannot wake (no session it runs): the brief waits for board.js receive.
  assert.equal(board.makeOrchestrator(fresh), false);
  assert.match(board.receiveMessages(fresh.id).join("\n"), /the user enabled delegation for this card/);
});

// ---- F120: board.js finish <id> (the user, 18 November 2026: "you should be able to click done or finish things") ----
// The rights are in test/orchestrator-rules.test.js "F120: ...". Here: the request end to end, and what git must show before the
// board removes a worktree. The main branch tracks a bare remote, so "nothing was pushed" is a claim these tests can fail.
async function landedRun(withRemote = true) {
  const { repo, board } = fixture();
  let remote;
  if (withRemote) {
    remote = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-orch2-remote-"));
    made.push(remote);
    sh(remote, "init", "-q", "--bare", "-b", "main");
    sh(repo, "remote", "add", "origin", remote);
    sh(repo, "push", "-q", "-u", "origin", "main");
  }
  board.deliverEveryTurns = () => 0; // periodic delivery merges on its own schedule; these tests read main and the remote
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const ask = (op, extra = {}) => request(board, { op, by: m.id, session: m.sessionId, ...extra });
  const commit = (c, name, text) => { fs.writeFileSync(path.join(c.worktree, name), text); sh(c.worktree, "add", name); sh(c.worktree, "commit", "-qm", `${c.id} ${name}`); };
  /** A card of the run in Review with its session ended and one commit on its branch. */
  const worker = async (title) => {
    const c = board.get((await ask("add", { title, prompt: "p" })).id);
    event(board, c.id, { hook_event_name: "SessionStart", session_id: c.sessionId });
    settle(board, c);
    await sleep(100); settle(board, m); // the settle notice woke the master: end that turn too
    commit(c, `${c.id}.txt`, `${title}\n`);
    return c;
  };
  /** Lands a branch where Finish looks for it: merged into the main folder's branch and, with a remote, pushed. */
  const land = (c) => { sh(repo, "merge", "-q", "--no-edit", c.branch); if (remote) sh(repo, "push", "-q", "origin", "main"); };
  const heads = () => [sh(repo, "rev-parse", "main"), remote ? sh(remote, "rev-parse", "main") : "", sh(repo, "status", "--porcelain")];
  const kept = (c) => [c.status, fs.existsSync(path.join(c.worktree, ".git")), sh(repo, "branch", "--list", c.branch) !== ""];
  return { repo, remote, board, m, ask, commit, worker, land, heads, kept };
}

test("F120: finish <id> closes a card of the run whose work has landed: worktree and branch gone, Done, nothing merged or pushed", async () => {
  const { repo, board, m, ask, commit, worker, land, heads } = await landedRun();
  const a = await worker("A");
  // An ignored file is not in git status, so it does not make the worktree unclean. It goes with the worktree, as with the user's Finish.
  commit(a, ".gitignore", "private.tmp\n");
  fs.writeFileSync(path.join(a.worktree, "private.tmp"), "ignored\n");
  assert.equal(sh(a.worktree, "status", "--porcelain"), "");
  land(a);
  // Unlike `done`, it does not ask for passing acceptance checks: the work is in the target whatever they said.
  board.update(a, { completion: { commands: ["exit 1"] }, checks: { status: "error", run: "r1", error: "exit 1" } });
  assert.equal((await ask("done", { id: a.id })).error, "Acceptance checks have not passed");
  // The root's own card is never closed this way, and nothing is asked of the run.
  assert.equal((await ask("finish", { id: m.id })).error, "finish: for your own card use `board.js finish self`");
  const { worktree, branch } = a, before = heads();
  for (const state of [{ status: "done" }, { status: "review", cancelled: true }]) {
    board.update(m, state);
    assert.match((await ask("finish", { id: a.id })).error, /asking card or its run is closed/);
    assert.deepEqual([a.status, a.worktree, fs.existsSync(worktree), sh(repo, "branch", "--list", branch).includes(branch)], ["review", worktree, true, true]);
  }
  board.update(m, { status: "review", cancelled: undefined });
  const complete = board.complete.bind(board);
  board.complete = (task, confirm, ...rest) => complete(task, async (...args) => {
    const allowed = await confirm(...args);
    if (allowed) board.update(m, { status: "done" });
    return allowed;
  }, ...rest);
  assert.match((await ask("finish", { id: a.id })).error, /asking card or its run is closed/);
  assert.deepEqual([a.status, a.worktree, fs.existsSync(worktree)], ["review", worktree, true]);
  board.complete = complete;
  board.update(m, { status: "review" });
  board.complete = ((complete) => (...args) => { completes.push(args[0].id); return complete(...args); })(board.complete.bind(board));
  const completes = [];
  event(board, m.id, { hook_event_name: "UserPromptSubmit", prompt: "close what has landed" }); board.syncStatus(m.id); // mid-turn, as an orchestrator asks
  const me = { ENTOMATICAL_TASK: m.id, CLAUDE_CODE_SESSION_ID: m.sessionId };
  const done = await cli(board, repo, ["finish", a.id], me);
  assert.deepEqual([done.code, done.out], [0, `${a.id}  Finished ${a.id}: its work was in the target already, so only its worktree was removed. Nothing was merged or pushed.\n`]);
  assert.deepEqual([a.status, a.worktree, a.branch, a.merged], ["done", undefined, undefined, true]);
  assert.deepEqual([fs.existsSync(worktree), sh(repo, "branch", "--list", branch), sh(repo, "worktree", "list").includes(a.id)], [false, "", false]);
  assert.deepEqual(heads(), before, "main, the remote and the main folder are as they were");
  assert.deepEqual([completes, m.finishAsked, m.status], [[a.id], undefined, "running"], "Finish ran for that card only; the root's own run is not asked to finish");
  // Asked again: the card is Done already, and nothing runs.
  const again = await cli(board, repo, ["finish", a.id], me);
  assert.deepEqual([again.code, again.out, completes], [1, "refused: done\n", [a.id]]);
  assert.deepEqual(heads(), before);
  settle(board, m);
});

test("F120: finish <id> also closes a card of the user's own whose work is in the local branch (no remote), and refuses another run's card", async () => {
  const { repo, board, m, ask, commit, land, heads } = await landedRun(false);
  const own = board.add("the user's card", "Do it.", "acct", undefined, "haiku", "low", undefined, { headless: true });
  await board.startHeadless(own);
  event(board, own.id, { hook_event_name: "SessionStart", session_id: own.sessionId });
  settle(board, own);
  commit(own, "own.txt", "his work\n");
  assert.deepEqual([own.openedBy, own.status], [undefined, "review"]);
  // A second run and its card: no approved root may close a card another run opened.
  const m2 = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m2);
  const theirs = board.get((await request(board, { op: "add", by: m2.id, session: m2.sessionId, title: "Theirs", prompt: "p" })).id);
  event(board, theirs.id, { hook_event_name: "SessionStart", session_id: theirs.sessionId });
  settle(board, theirs);
  await sleep(100); settle(board, m2);
  assert.match((await ask("finish", { id: theirs.id })).error, new RegExp(`^Card ${theirs.id} is controlled by ${m2.id} \\(`));
  assert.equal((await ask("finish", { id: m2.id })).error, `finish: card ${m2.id} is the root of a run; a root stays with the user`);
  // the user's card: refused while its commit is not in main, accepted once it is.
  const { worktree, branch } = own;
  assert.equal((await ask("finish", { id: own.id })).error, `finish: nothing was changed: its branch has commits that are not in main yet. Finish on card ${own.id} is the user's.`);
  land(own);
  const before = heads();
  const r = await ask("finish", { id: own.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([own.status, own.worktree, fs.existsSync(worktree), sh(repo, "branch", "--list", branch)], ["done", undefined, false, ""]);
  assert.deepEqual(heads(), before);
  assert.deepEqual([theirs.status, fs.existsSync(theirs.worktree)], ["review", true], "the other run's card is as it was");
});

test("F120: finish <id> changes nothing while the card's work is not all in the target: commits not landed, not pushed, uncommitted files, on the remote only, a folder deleted by hand", async () => {
  const { repo, board, ask, commit, worker, heads, kept } = await landedRun();
  const refused = (c, why) => `finish: nothing was changed: ${why}. Finish on card ${c.id} is the user's.`;
  const b = await worker("B");
  let before = heads();
  const same = async (c, why, what) => {
    const r = await ask("finish", { id: c.id });
    assert.equal(r.error, refused(c, why), what);
    assert.deepEqual([heads(), kept(c)], [before, ["review", true, true]], `${what}: main, the remote, the card, its worktree and its branch are as they were`);
  };
  // Its commit is nowhere but its branch.
  await same(b, "its branch has commits that are not in origin/main yet", "not merged");
  // Merged into the main folder's branch but not pushed: with a remote, landed means on the remote.
  sh(repo, "merge", "-q", "--no-edit", b.branch);
  before = heads();
  await same(b, "its branch has commits that are not in origin/main yet", "merged but not pushed");
  sh(repo, "push", "-q", "origin", "main");
  before = heads();
  // Landed, but a file nobody committed sits in the worktree: removing the worktree would lose it.
  fs.writeFileSync(path.join(b.worktree, "scratch.txt"), "keep me\n");
  await same(b, "its worktree has uncommitted files (?? scratch.txt)", "an untracked file");
  assert.equal(fs.readFileSync(path.join(b.worktree, "scratch.txt"), "utf8"), "keep me\n");
  fs.rmSync(path.join(b.worktree, "scratch.txt"));
  fs.writeFileSync(path.join(b.worktree, `${b.id}.txt`), "edited after the commit\n");
  await same(b, `its worktree has uncommitted files (M ${b.id}.txt)`, "a tracked file changed");
  sh(b.worktree, "checkout", "-q", "--", `${b.id}.txt`);
  // On the remote but not in the main folder's branch: Finish would then update the main folder, which this never does.
  const c = await worker("C");
  sh(c.worktree, "merge", "-q", "--no-edit", "main"); // a card of a run starts from its opener's branch: bring it up to main first
  sh(c.worktree, "push", "-q", "origin", `${c.branch}:main`);
  sh(repo, "fetch", "-q", "origin");
  before = heads();
  await same(c, "its commits are in origin/main but not in the local main yet", "pushed, the main folder behind");
  // Its folder deleted by hand: its branch would have to be checked out again to be sure nothing is left.
  fs.rmSync(b.worktree, { recursive: true, force: true });
  const r = await ask("finish", { id: b.id });
  assert.equal(r.error, refused(b, "its worktree folder is gone, so its branch would have to be checked out again"));
  assert.deepEqual([heads(), b.status, sh(repo, "branch", "--list", b.branch) !== ""], [before, "review", true]);
});
test("F120: the root that asks is live and is the card's parent: it is not sent the going-away note, so its checks and delivery state stand", async () => {
  const { board, m, ask, commit, land, heads } = await landedRun();
  const d = board.get((await ask("add", { title: "D", prompt: "p" })).id);
  event(board, d.id, { hook_event_name: "SessionStart", session_id: d.sessionId });
  settle(board, d);
  await sleep(100); // the settle notice woke the root in a new hidden terminal; this time its turn is left running, as when it asks
  event(board, m.id, { hook_event_name: "UserPromptSubmit", prompt: "close what has landed" }); board.syncStatus(m.id);
  const live = board.terminal(m);
  assert.ok(live, "the root's session is running");
  assert.deepEqual([d.parentId, board.relatedLive(d).map((t) => t.id), m.status], [m.id, [m.id], "running"], "the user's Finish on this card would tell the root");
  commit(d, `${d.id}.txt`, "D\n");
  land(d);
  board.update(m, { deliveryReady: true, reported: true });
  const before = heads(), sent = live.sent.length;
  const r = await ask("finish", { id: d.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([d.status, d.worktree, heads()], ["done", undefined, before]);
  assert.deepEqual([live.sent.slice(sent), m.deliveryReady, m.reported, m.status, board.terminal(m) === live], [[], true, true, "running", true],
    "nothing was typed into the asking root's terminal, and what it had declared stands");
  settle(board, m);
});

test("F120: a file written after the board's last check is neither committed nor lost: refused, the index as it was, the card still in Review", async () => {
  const { board, ask, worker, land, heads, kept } = await landedRun();
  const e = await worker("E");
  land(e);
  const before = heads(), head = sh(e.worktree, "rev-parse", "HEAD");
  // Finish's confirmation is finishLanded's second look at the card. This writes a file right after it says yes.
  const complete = board.complete.bind(board);
  const late = () => path.join(e.worktree, "late.txt");
  board.complete = (task, confirm, ...rest) => complete(task, async (...seen) => { const yes = await confirm(...seen); if (yes) fs.writeFileSync(late(), "written after the last check\n"); return yes; }, ...rest);
  const r = await ask("finish", { id: e.id });
  assert.equal(r.error, `finish: nothing was changed: its worktree has uncommitted files (?? late.txt). Finish on card ${e.id} is the user's.`);
  assert.deepEqual([heads(), kept(e), sh(e.worktree, "rev-parse", "HEAD"), sh(e.worktree, "status", "--porcelain"), fs.readFileSync(late(), "utf8")],
    [before, ["review", true, true], head, "?? late.txt", "written after the last check\n"], "no commit on its branch, the file not even staged, and still there");
});
// the user, 22 November 2026: "orchestrator mode doesn't seem to be able to tell when a sub card's task is finished and should be
// merged and closed out". The whole path on the board: the child's Stop puts it in Review, its master hears of it, the master's
// merge plus board.js done close it, and the run reports finished.
test("a finished child is detected: its master is told it settled in Review, done closes it, and the run reports finished", async () => {
  const { board, runEvents } = fixture();
  const m = await master(board, { approved: { at: "x", hash: "h" } });
  settle(board, m);
  const c = board.get((await request(board, { op: "add", by: m.id, session: m.sessionId, title: "Child", prompt: "c" })).id);
  event(board, c.id, { hook_event_name: "SessionStart", session_id: c.sessionId }); event(board, c.id, { hook_event_name: "UserPromptSubmit", prompt: "p" }); board.syncStatus(c.id);
  assert.equal((await request(board, { op: "done", by: m.id, session: m.sessionId, id: c.id })).error, "Not ready for completion", "a running child is not finished");
  settle(board, c);
  assert.equal(c.status, "review");
  const notice = path.join(board.dir, "launch", `${m.id}.followup.txt`);
  for (let i = 0; i < 60 && !fs.existsSync(notice); i++) await sleep(50);
  assert.match(fs.readFileSync(notice, "utf8"), new RegExp(`Child settled: ${c.id}  review`), "the master is told the child finished");
  settle(board, m);
  assert.equal((await request(board, { op: "done", by: m.id, session: m.sessionId, id: c.id })).ok, true);
  assert.equal(c.status, "done");
  board.update(m, { deliveryReady: true, status: "review" });
  board.publishStatus();
  assert.ok(runEvents.some((e) => e.kind === "finished" && e.master.id === m.id), "every child Done: the run reports finished");
});

// ---- FR2 / GAP-02 (19 November 2026): a vault repo on the two routes this file's fixtures cover: `board.js finish <id>` (F120) and
// the user's Finish of a governed run. The rest is in test/finish.test.js ("vault: ..."). The helper is a node script the test writes,
// started by this test's own node; its "vault" is a bare repository beside it. No real vault helper, vault or key is touched.
const { spawn } = require("node:child_process");
const P = require("../out/profiles.js");
const { confirmationFor } = require("../out/finish.js"); // what the dialog showed: Finish checks it again before the effect
/** Makes `repo` a vault repo: main tracks an origin that is a placeholder, and the user's settings name the fake helper for it. */
function vaultRepo(repo, board) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-orch2-vault-"));
  made.push(dir);
  const mirror = path.join(dir, "vault.git"), script = path.join(dir, "fake-vault.js"), log = path.join(dir, "calls.jsonl");
  sh(dir, "init", "-q", "--bare", "-b", "main", mirror);
  fs.writeFileSync(script, `const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] !== "push") process.exit(64);
execFileSync("git", ["push", "-q", path.join(__dirname, "vault.git"), "main:main"], { cwd: process.cwd(), stdio: "ignore" });
`);
  // The placeholder is a path that is not there: git fails at once on it and reaches no network.
  sh(repo, "remote", "add", "origin", "DISABLED-origin"); sh(repo, "config", "branch.main.remote", "origin"); sh(repo, "config", "branch.main.merge", "refs/heads/main");
  board.vaultOf = () => ({ [repo]: { name: "test vault", command: process.execPath, args: [script, "push"] } });
  // This file's terminals start nothing, so the helper is started here, as the board's own terminal starts it.
  board.vaultRun = (dest, kind, opts) => new Promise((resolve) => {
    assert.equal(dest.command, process.execPath, "these tests start only their own node as a vault helper");
    const at = Date.now(), child = spawn(dest.command, kind === "verify" ? dest.verifyArgs : dest.args, { cwd: opts.cwd, stdio: "ignore", windowsHide: true });
    child.once("close", (code) => resolve({ code, ms: Date.now() - at }));
  });
  return { calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0),
    inVault: () => { try { return sh(mirror, "rev-parse", "-q", "--verify", "refs/heads/main"); } catch { return ""; } } };
}

test("F120: in a vault repo, finish <id> reads the local branch, not the disabled origin, closes a landed card and starts no upload; the card says the upload is pending", async () => {
  const { repo, board, ask, worker, land, heads } = await landedRun(false);
  const a = await worker("A");
  sh(repo, "remote", "add", "origin", "DISABLED-origin"); sh(repo, "config", "branch.main.remote", "origin"); sh(repo, "config", "branch.main.merge", "refs/heads/main");
  // With no vault set, the card is looked for where main's upstream says: an origin that no longer answers has none of it.
  land(a);
  assert.equal((await ask("finish", { id: a.id })).error, `finish: nothing was changed: its branch has commits that are not in origin/main yet. Finish on card ${a.id} is the user's.`);
  sh(repo, "remote", "remove", "origin");
  const vault = vaultRepo(repo, board);
  const b = await worker("B");
  assert.equal((await ask("finish", { id: b.id })).error, `finish: nothing was changed: its branch has commits that are not in main yet. Finish on card ${b.id} is the user's.`);
  const before = heads(), { worktree, branch } = a;
  const r = await ask("finish", { id: a.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.note, new RegExp(`^Finished ${a.id}: its work was in the target already, so only its worktree was removed\\. Nothing was merged or pushed\\. Merged into main \\(\\w{7}\\) locally; upload to test vault pending: this Finish had no approval to upload; only the user's own Finish or Upload to Vault starts one\\. test vault is behind until it is uploaded\\.$`));
  assert.deepEqual([a.status, a.worktree, a.merged, fs.existsSync(worktree), sh(repo, "branch", "--list", branch)], ["done", undefined, true, false, ""]);
  assert.deepEqual([a.vault.state, a.vault.sha, a.vault.branch, a.vault.attempts, a.vault.last.outcome, a.vault.approved], ["pending", before[0], "main", 0, "unauthorized", undefined]);
  assert.deepEqual([heads(), vault.calls(), vault.inVault()], [before, 0, ""], "main and the main folder are as they were, and the helper was never started");
  assert.deepEqual(board.vaultWaiting().map((c) => c.id), [a.id]);
});

test("F120: Finish leaves the merged and vault fields alone if the root retires during the vault lookup", async () => {
  const { repo, board, m, ask, worker, land, kept } = await landedRun(false);
  const child = await worker("Landed");
  land(child);
  const vault = vaultRepo(repo, board);
  const vaultMerged = board.vaultMerged.bind(board);
  board.vaultMerged = async (...args) => {
    const record = await vaultMerged(...args);
    assert.equal(record.vault.state, "pending");
    board.update(m, { status: "done" });
    return record;
  };
  const reply = await ask("finish", { id: child.id });
  assert.match(reply.error, /asking card or its run is closed/);
  assert.deepEqual(kept(child), ["review", true, true]);
  assert.deepEqual([child.merged, child.vault, vault.calls()], [undefined, undefined, 0]);
});

test("a governed run in a vault repo: the user's Finish reads no remote and pushes nothing; the upload is its own choice, and without it the run is merged locally with the upload pending", async () => {
  const { repo, board } = fixture();
  const vault = vaultRepo(repo, board);
  const ws = path.join(repo, "workflows", "capability-profiles.json");
  P.saveRevision(ws, "workspace", { name: "Tests", variants: { claude: { items: [{ kind: "skill", id: "run-tests" }] } } });
  /** A governed root with one commit of its own, its session ended and its checks passed at that commit: all Finish needs but the user. */
  const root = async () => {
    const m = board.add("Project", "Ship it.", "acct", undefined, "haiku", "low", undefined, { orchestrator: { caps: { ...o.DEFAULT_CAPS }, opened: 0 }, headless: true });
    await board.startHeadless(m);
    event(board, m.id, { hook_event_name: "SessionStart", session_id: m.sessionId });
    board.update(m, { plan: { steps: 2, points: 1, caps: { ...o.DEFAULT_CAPS } } });
    board.govern(m, { limits: { active: 5, directChildren: 4, depth: 2 }, allowed: ["provider-defaults"], defaultChild: "provider-defaults" }, (id) => P.pin({ workspace: ws }, id));
    await board.approvePlan(m);
    await board.ensureWorktree(m);
    fs.writeFileSync(path.join(m.worktree, `${m.id}.txt`), "the run's work\n"); sh(m.worktree, "add", "."); sh(m.worktree, "commit", "-qm", `run ${m.id}`);
    board["pendingNotices"].delete(m.id); settle(board, m); board.tick();
    const candidate = sh(m.worktree, "rev-parse", "HEAD");
    board.update(m, { completion: { commands: ["true"] }, checks: { status: "complete", run: "", revision: candidate, clean: true } });
    return { m, candidate };
  };
  /** the user's Finish: his dialog sees the readiness and answers with the merge, plus what `grant` adds. */
  const finish = async (m, grant) => {
    let seen;
    const notes = await board.complete(m, async () => true, () => {}, async () => {}, undefined, { authorize: async (r) => { seen = r; return { by: "user", at: new Date().toISOString(), merge: true, push: false, confirmed: confirmationFor(r, !!grant?.push), ...grant }; } });
    return { notes, seen };
  };
  const codes = (r) => r.reasons.map((x) => x.code);
  const target = (m) => board.operations.list().find((x) => x.kind === "target" && x.card === m.id);

  // 1. The merge only. main still names origin, which is never read: the vault is the destination.
  const a = await root();
  let r = await board.readiness(a.m, "target");
  assert.deepEqual(codes(r), ["authorization"], JSON.stringify(r.reasons));
  assert.deepEqual([r.target.remote, r.target.remoteSha, r.target.vault.name], [undefined, undefined, "test vault"]);
  assert.ok(r.notes.some((n) => n === "test vault is not uploaded to: the upload is a separate choice in the user's Finish"), JSON.stringify(r.notes));
  assert.deepEqual(codes(await board.readiness(a.m, "target", { by: "user", at: "now", merge: true, push: true })), ["push-vault"], "push is not a choice in a vault repo");
  const one = await finish(a.m, {});
  assert.ok(one.seen.target.vault.display.endsWith(" push"), "the dialog is given the destination and its command");
  assert.deepEqual([sh(repo, "rev-parse", "main"), a.m.status, a.m.merged, a.m.vault.state, a.m.vault.sha, a.m.vault.branch, a.m.vault.attempts, a.m.vault.last.outcome, vault.calls(), vault.inVault()],
    [a.candidate, "done", true, "pending", a.candidate, "main", 0, "unauthorized", 0, ""]);
  assert.match(one.notes.join(" "), /^Merged into main \(\w{7}\) locally; upload to test vault pending: this Finish had no approval to upload/);
  assert.deepEqual([target(a.m).state, target(a.m).pre.push, target(a.m).pre.upload, target(a.m).pre.vaultName, target(a.m).authorization.upload], ["committed", false, false, "test vault", undefined]);
  assert.match(fs.readFileSync(path.join(board.dir, "governed", `${a.m.id}.events.jsonl`), "utf8"), /"kind":"target".*merged here; the upload to test vault was not chosen/);

  // 2. The merge and the upload: the exact candidate is on main, and the helper ran once for it. That upload carried the first run too.
  const b = await root();
  const two = await finish(b.m, { upload: true });
  assert.deepEqual(two.notes, []);
  assert.deepEqual([sh(repo, "rev-parse", "main"), b.m.status, b.m.vault.state, b.m.vault.sha, b.m.vault.attempts, b.m.vault.last.exitCode, vault.calls(), vault.inVault()],
    [b.candidate, "done", "uploaded", b.candidate, 1, 0, 1, b.candidate]);
  assert.deepEqual([target(b.m).pre.upload, target(b.m).authorization.upload, a.m.vault.state, a.m.vault.uploaded.coveredBy], [true, true, "uploaded", b.candidate]);

  // 3. M-02 (19 November 2026): something the board has no record of has the root's folder open when it would go. The run is on main;
  // its worktree is kept whole and the card says why. Finish again only cleans up: nothing is merged a second time, and no upload starts.
  const c = await root();
  board.releaseLimits = { closeMs: 400, pollMs: 20 };
  // First: the root's session was stopped a moment ago and its process (simulated here) has not gone. Nothing reaches the target beside it.
  let running = true;
  board.processAlive = (pid) => pid === 7100 && running;
  board.processStart = async () => "9";
  board.closing.set(c.m.id, [{ pid: 7100, started: "9", what: "its session (process 7100)" }]);
  r = await board.readiness(c.m, "target", { by: "user", at: "now", merge: true, push: false });
  assert.deepEqual(codes(r), ["live"], JSON.stringify(r.reasons));
  assert.equal(r.reasons[0].text, "The root's session was stopped and has not ended yet (its session (process 7100)); the run reaches the target once it has.");
  await assert.rejects(finish(c.m, {}), /The root's session was stopped and has not ended yet/);
  assert.deepEqual([sh(repo, "rev-parse", "main"), c.m.merged, board.operations.list().filter((x) => x.card === c.m.id).length], [b.candidate, undefined, 0], "main is where the second run left it, and no operation was opened");
  running = false; // it ended
  let held = true;
  board.worktreeHeld = () => held;
  await assert.rejects(finish(c.m, { upload: true }), /^Error: Work is on main at \w{12}; only cleanup is left: its worktree .* was kept whole, because something the board has no record of still has the folder open, often a tool the session started \(for a Codex editor session, that window's Codex helpers\)\. Close it\. Then press Finish again: it only retries the cleanup\.$/s);
  const ops = () => board.operations.list().filter((x) => x.kind === "target" && x.card === c.m.id);
  assert.deepEqual([sh(repo, "rev-parse", "main"), c.m.status === "done", c.m.merged, c.m.cleanupPending, c.m.cleanup.sha, c.m.cleanup.into, c.m.cleanup.holders.map((h) => h.owner), fs.existsSync(path.join(c.m.worktree, ".git")), sh(repo, "rev-parse", c.m.branch)],
    [c.candidate, false, true, true, c.candidate, "main", ["unknown"], true, c.candidate]);
  assert.deepEqual([ops().map((x) => [x.state, x.cleanup]), c.m.vault.state, vault.calls()], [[["committed", "pending"]], "pending", 1], "the effect is recorded once, and the upload the user chose has not started");
  held = false;
  const { worktree: kept, branch: keptBranch } = c.m;
  const again = await board.complete(c.m, async () => true, () => {}, async () => {}, undefined, { authorize: async () => { throw new Error("not asked: nothing is left to authorize"); } });
  assert.match(again.join(" "), /^Its work was already on main \(\w{12}\); only the cleanup was left\. Merged into main \(\w{7}\) locally; upload to test vault pending/);
  assert.deepEqual([sh(repo, "rev-parse", "main"), c.m.status, c.m.cleanup, c.m.cleanupPending, fs.existsSync(kept), sh(repo, "branch", "--list", keptBranch), ops().map((x) => [x.state, x.cleanup]), vault.calls()],
    [c.candidate, "done", undefined, undefined, false, "", [["committed", "done"]], 1], "one operation, main where it was, and still one run of the helper (the second root's)");
});

// ---- M-02, Finish (19 November 2026) on `board.js finish <id>`: the card's writers close before its worktree goes ----
// The processes are simulated: the board is told what is there (Board.processAlive, Board.processStart, the session list) instead of
// asking the OS, so nothing on this machine is looked up or ended. The rest of M-02's Finish tests are in test/finish.test.js.
/** landedRun with simulated processes (procs: pid -> start) and a session list the test fills (listed). */
async function landedWithProcesses() {
  const run = await landedRun();
  const procs = new Map(), listed = [];
  run.board.processAlive = (pid) => procs.has(pid);
  run.board.processStart = async (pid) => procs.get(pid);
  Object.defineProperty(run.board, "external", { configurable: true, get: () => new Map(listed.map((s) => [s.sessionId, s])), set() {} });
  run.board.releaseLimits = { closeMs: 400, pollMs: 20 };
  return { ...run, procs, listed };
}

test("F120: M-02: finish <id> keeps a landed card's worktree while the session the board stopped for it has not ended, or a session no card holds runs in its folder; asked again once they are gone, it only cleans up", async (t) => {
  const { repo, board, m, ask, commit, land, heads, kept, procs, listed } = await landedWithProcesses();
  const refused = (c, why) => `finish: nothing was changed: ${why}. Finish on card ${c.id} is the user's.`;
  // A card of the run whose session the board itself stops. Its CLI is process 7001, started at 50, as its session file says.
  const a = board.get((await ask("add", { title: "A", prompt: "p" })).id);
  event(board, a.id, { hook_event_name: "SessionStart", session_id: a.sessionId });
  procs.set(7001, "50");
  listed.push({ pid: 7001, sessionId: a.sessionId, cwd: a.worktree, configDir: "", procStart: "50" });
  board.stop(a); // its terminal closes ...
  listed.length = 0; // ... and its session file goes, but the process has not ended yet
  settle(board, a);
  await sleep(100); settle(board, m);
  commit(a, `${a.id}.txt`, "A\n");
  land(a);
  const before = heads(), result = sh(repo, "rev-parse", a.branch);
  // 1. Its own process is still there: refused at the first look, with nothing changed. A closed terminal was no proof.
  let r = await ask("finish", { id: a.id });
  assert.equal(r.error, refused(a, "its session (process 7001) was stopped and has not ended yet"));
  assert.deepEqual([heads(), kept(a), a.merged, a.cleanup, procs.get(7001)], [before, ["review", true, true], undefined, undefined, "50"]);
  t.diagnostic(`M-02 fixture "CLI route, delayed exit": worktree survived the first ask; helper: session process 7001 (start 50), stopped by the board and not ended; owner: card ${a.id}; merges/pushes/uploads before retry 0/0/0, after retry 0/0/0 (main ${before[0].slice(0, 7)}, origin ${before[1].slice(0, 7)} throughout)`);
  procs.delete(7001); // it ends
  // 2. Now a Claude session that no card holds (the user dismissed it) runs in A's folder. It is not A's: left running, and the folder stays.
  board.dismissed.add("stranger");
  procs.set(7002, "60");
  listed.push({ pid: 7002, sessionId: "stranger", cwd: a.worktree, configDir: "", procStart: "60" });
  const keptText = new RegExp(`^finish: nothing was merged or pushed, and its worktree was kept: Its work is in origin/main \\(${result.slice(0, 7)}\\); only its worktree .* is left, kept whole because its folder is in use by a Claude session \\(process 7002\\), which no card of this board owns\\. It was left running: end it yourself when it is done\\. Finish again retries only that cleanup: nothing is merged, pushed or uploaded again\\. Ask again once that is settled, or leave it to the user's Finish on card ${a.id}\\.$`, "s");
  r = await ask("finish", { id: a.id });
  assert.match(r.error, keptText);
  assert.deepEqual([heads(), kept(a), a.merged, a.cleanupPending, a.cleanup.sha, a.cleanup.into, a.cleanup.holders, procs.get(7002)],
    [before, ["review", true, true], true, true, result, "origin/main", [{ what: "a Claude session (process 7002)", owner: "unknown", state: "open" }], "60"]);
  assert.ok(a.transcript && a.transcript === board.transcriptOf(a), "the transcript's path is on the card");
  // Asked again while it is there: the same answer, and nothing else happens.
  r = await ask("finish", { id: a.id });
  assert.match(r.error, keptText);
  assert.deepEqual([heads(), kept(a)], [before, ["review", true, true]]);
  // 3. It is gone: asked again, only the cleanup is done.
  listed.length = 0; procs.delete(7002);
  const { worktree, branch } = a;
  r = await ask("finish", { id: a.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.note, `Finished ${a.id}: its work was in the target already, so only its worktree was removed. Nothing was merged or pushed. Its work was already in origin/main (${result.slice(0, 7)}); only its worktree was left, and it was deleted.`);
  assert.deepEqual([heads(), a.status, a.worktree, a.merged, a.cleanup, a.cleanupPending, fs.existsSync(worktree), sh(repo, "branch", "--list", branch)], [before, "done", undefined, true, undefined, undefined, false, ""]);
  t.diagnostic(`M-02 fixture "CLI route, unknown ownership": worktree survived two asks; removed by the third, once the session was gone; helper: Claude session, process 7002, in the card's folder, never ended by the board; owner: unknown; merges/pushes/uploads before retry 0/0/0, after retry 0/0/0 (main ${heads()[0].slice(0, 7)}, origin ${heads()[1].slice(0, 7)} unchanged)`);
  settle(board, m);
});

for (const [change, rootUpdate, refusal] of [
  ["the root retires", { status: "done" }, /asking card or its run is closed/],
  ["the root changes controller", { controller: { sessionId: "new-controller", mode: "external", at: "now" } }, /is not this card's controller/],
]) {
  test(`F120: Finish keeps the worktree and branch when ${change} while a writer closes`, async () => {
    const { repo, board, m, ask, worker, land, heads, kept } = await landedRun(false);
    const child = await worker("Landed");
    land(child);
    const before = heads(), tip = sh(repo, "rev-parse", child.branch);
    // One open writer forces releaseWriters to wait. At the next poll it has closed and the caller has lost authority.
    let polls = 0;
    board.writersOf = async (task) => {
      assert.equal(task.id, child.id);
      if (++polls === 1) return [{ what: "its session", owner: child.id, state: "open" }];
      board.update(m, rootUpdate);
      return [];
    };
    const reply = await ask("finish", { id: child.id });
    assert.equal(polls, 2);
    assert.match(reply.error, refusal);
    assert.deepEqual(kept(child), ["review", true, true]);
    assert.equal(sh(child.worktree, "rev-parse", "HEAD"), tip);
    assert.deepEqual(heads(), before);
  });
}

test("F120: M-02: a file written between the board's last look and the removal keeps the worktree: it is not committed and not lost, and asked again the card is refused until the file is taken out", async (t) => {
  const { board, ask, worker, land, heads, kept } = await landedWithProcesses();
  const e = await worker("E");
  land(e);
  const before = heads(), head = sh(e.worktree, "rev-parse", "HEAD"), late = path.join(e.worktree, "late.txt");
  // A writer nobody saw: the file appears as the board comes to remove the folder, after every earlier look at it.
  const release = board.releaseWriters.bind(board);
  let write = true;
  board.releaseWriters = async (...args) => { if (write) { write = false; fs.writeFileSync(late, "written at the last moment\n"); } return release(...args); };
  let r = await ask("finish", { id: e.id });
  assert.match(r.error, new RegExp(`^finish: nothing was merged or pushed, and its worktree was kept: Its work is in origin/main \\(${head.slice(0, 7)}\\); only its worktree .* is left, kept whole because its worktree holds files written since its work landed: late\\.txt\\. Move what you want to keep \\(or Discard to drop them\\)\\. Finish again retries only that cleanup: nothing is merged, pushed or uploaded again\\. Ask again once that is settled, or leave it to the user's Finish on card ${e.id}\\.$`, "s"));
  assert.deepEqual([heads(), kept(e), sh(e.worktree, "rev-parse", "HEAD"), sh(e.worktree, "status", "--porcelain"), fs.readFileSync(late, "utf8"), e.merged, e.cleanupPending, e.cleanup.sha],
    [before, ["review", true, true], head, "?? late.txt", "written at the last moment\n", true, true, head], "no commit, the file not staged and still there, main and the remote as they were");
  // Asked again with the file there: this route never commits, so its own first look refuses it.
  r = await ask("finish", { id: e.id });
  assert.equal(r.error, `finish: nothing was changed: its worktree has uncommitted files (?? late.txt). Finish on card ${e.id} is the user's.`);
  assert.deepEqual([heads(), kept(e), fs.readFileSync(late, "utf8")], [before, ["review", true, true], "written at the last moment\n"]);
  fs.rmSync(late); // taken out of the folder
  const { worktree } = e;
  r = await ask("finish", { id: e.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([heads(), e.status, e.cleanup, fs.existsSync(worktree)], [before, "done", undefined, false]);
  t.diagnostic(`M-02 fixture "CLI route, late file": worktree survived two asks with late.txt in it; removed by the third, once it was taken out; helper: whatever wrote late.txt; owner: not known to the board; merges/pushes/uploads before retry 0/0/0, after retry 0/0/0 (main ${heads()[0].slice(0, 7)}, origin ${heads()[1].slice(0, 7)} unchanged)`);
});

// Acceptance of the Finish repair plan (19 November 2026, card 04e321): the landed-only close asked for both cards of one run, one
// landed and one not, with what git and the board show for each. One "finish route" line per card, as in test/finish.test.js
// ("Finish acceptance: ..."): the refs here and in the bare remote, the branch the work is looked for in, how often Finish ran for
// the card, what it merged, pushed or uploaded, the card, and whether its worktree is there.
test("F120: acceptance: of two cards of one run, finish <id> closes the one whose work has landed and refuses the one whose work has not; main and the bare remote are as they were, and nothing is merged or pushed", async (t) => {
  const { repo, remote, board, ask, worker, land, heads, kept } = await landedRun();
  sh(remote, "config", "core.logAllRefUpdates", "always"); // from here on the remote keeps one line for every push it takes
  const pushes = () => { try { return fs.readFileSync(path.join(remote, "logs", "refs", "heads", "main"), "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
  const ref = (dir, name) => { try { return sh(dir, "rev-parse", "-q", "--verify", name); } catch { return ""; } };
  const seven = (sha) => (sha ? sha.slice(0, 7) : "none");
  const completes = [];
  board.complete = ((complete) => (...args) => { completes.push(args[0].id); return complete(...args); })(board.complete.bind(board));
  const a = await worker("A"), b = await worker("B");
  land(a); // merged into main and pushed by hand, as a card's work lands before this is asked; B's commit stays on its branch
  const landedPushes = pushes(), before = heads();
  assert.equal(landedPushes, 1, "the remote counted the push that landed A");
  const line = (route, c, was, answer) => t.diagnostic(`finish route "${route}": local main=${seven(ref(repo, "refs/heads/main"))}, ${was.branch}=${seven(ref(repo, `refs/heads/${was.branch}`))}; bare origin main=${seven(ref(remote, "refs/heads/main"))}; `
    + `named branch=main (looked for in origin/main); helper attempts=${completes.filter((id) => id === c.id).length} Finish for this card (no helper on this route); merges/pushes/uploads=${heads()[0] === before[0] ? 0 : "main moved"}/${pushes() - landedPushes}/0; `
    + `card=${c.status}${c.merged ? ", merged" : ""}; worktree=${fs.existsSync(was.worktree) ? "there" : "gone"}; answer=${answer}`);

  // The card whose work has not landed: refused at the board's first look, before Finish is started for it.
  const wasB = { worktree: b.worktree, branch: b.branch }, tipB = sh(repo, "rev-parse", b.branch);
  let r = await ask("finish", { id: b.id });
  assert.equal(r.error, `finish: nothing was changed: its branch has commits that are not in origin/main yet. Finish on card ${b.id} is the user's.`);
  assert.deepEqual([heads(), kept(b), b.merged, b.cleanup, sh(repo, "rev-parse", b.branch), pushes() - landedPushes, completes], [before, ["review", true, true], undefined, undefined, tipB, 0, []]);
  line("orchestrator's close, the card has not landed", b, wasB, "refused, nothing changed");

  // The card whose work has landed: its worktree and branch go and it is Done. Nothing is merged or pushed for it.
  const wasA = { worktree: a.worktree, branch: a.branch };
  r = await ask("finish", { id: a.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.note, `Finished ${a.id}: its work was in the target already, so only its worktree was removed. Nothing was merged or pushed.`);
  assert.deepEqual([a.status, a.merged, a.worktree, a.branch, a.cleanup, fs.existsSync(wasA.worktree), ref(repo, `refs/heads/${wasA.branch}`), sh(repo, "worktree", "list").includes(a.id)],
    ["done", true, undefined, undefined, undefined, false, "", false]);
  assert.deepEqual([heads(), pushes() - landedPushes, completes], [before, 0, [a.id]], "main, the remote and the main folder are as they were; Finish ran once, for that card");
  line("orchestrator's close, the card has landed", a, wasA, "closed");
  // The other card of the run is as it was through both.
  assert.deepEqual([kept(b), sh(repo, "rev-parse", b.branch), fs.existsSync(path.join(wasB.worktree, `${b.id}.txt`))], [["review", true, true], tipB, true]);
});
