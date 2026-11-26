const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const made = []; // every folder tmp() makes; removed when this file's tests are done
// The auth status test saves auth-status.json in USAGE_DIR: keep it out of the real home folder, where it made the data folder
// under its new name before the cutover had moved the old one (18 November 2026).
process.env.ENTOMATICAL_USAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-usage-"));
made.push(process.env.ENTOMATICAL_USAGE_DIR);
const fakeHome = test.mock.method(os, "homedir", () => process.env.ENTOMATICAL_USAGE_DIR);
const s = require("../out/sessions.js");
fakeHome.mock.restore();

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-"));
  made.push(dir);
  return dir;
};
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const line = (o) => JSON.stringify(o) + "\n";

test("interruption requires the latest transcript message to explicitly record it", () => {
  const file = path.join(tmp(), "turn.jsonl");
  assert.equal(s.transcriptInterrupted(file), false);
  fs.writeFileSync(file, line({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash" }] } }));
  assert.equal(s.transcriptInterrupted(file), false, "an idle CLI can still be waiting on this tool");
  fs.appendFileSync(file, line({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } }));
  fs.appendFileSync(file, line({ type: "progress" }) + "{partial");
  assert.equal(s.transcriptInterrupted(file), true);
  fs.appendFileSync(file, "\n" + line({ type: "user", message: { content: "Resume." } }));
  assert.equal(s.transcriptInterrupted(file), false, "an old interruption cannot end the new turn");
  fs.appendFileSync(file, line({ type: "user", message: { content: "[Request interrupted by user]" } }));
  assert.equal(s.transcriptInterrupted(file), true);
  fs.appendFileSync(file, line({ type: "assistant", message: { content: [{ type: "text", text: "Continuing" }] } }));
  assert.equal(s.transcriptInterrupted(file), false);
});

test("F53: sessionTitle with customOnly skips Claude's generated title and returns a rename", () => {
  const file = path.join(tmp(), "custom-only.jsonl");
  fs.writeFileSync(file, line({ type: "ai-title", aiTitle: "Generated name" }));
  assert.equal(s.sessionTitle(file, { customOnly: true }), undefined);
  assert.equal(s.sessionTitle(file), "Generated name");
  fs.appendFileSync(file, line({ type: "custom-title", customTitle: "My session" }));
  assert.equal(s.sessionTitle(file, { customOnly: true }), "My session");
});

test("session titles follow generated names and user renames across appends and incomplete writes", () => {
  const file = path.join(tmp(), "titles.jsonl");
  assert.equal(s.sessionTitle(file), undefined);
  fs.writeFileSync(file, line({ type: "ai-title", aiTitle: "Generated name" }));
  assert.equal(s.sessionTitle(file), "Generated name");
  fs.appendFileSync(file, line({ type: "custom-title", customTitle: "My session" }));
  fs.appendFileSync(file, line({ type: "ai-title", aiTitle: "Later automatic name" }));
  assert.equal(s.sessionTitle(file), "My session");
  const renamed = line({ type: "custom-title", customTitle: "Renamed café session" });
  fs.appendFileSync(file, renamed.slice(0, -2));
  assert.equal(s.sessionTitle(file), "My session");
  fs.appendFileSync(file, renamed.slice(-2));
  assert.equal(s.sessionTitle(file), "Renamed café session");
  fs.appendFileSync(file, line({ type: "user", message: { content: "x".repeat(200_000) } }));
  assert.equal(s.sessionTitle(file), "Renamed café session");
  fs.appendFileSync(file, line({ type: "custom-title", customTitle: "Newest name" }));
  assert.equal(s.sessionTitle(file), "Newest name");
  fs.writeFileSync(file, line({ type: "ai-title", aiTitle: "Replaced file" }));
  assert.equal(s.sessionTitle(file), "Replaced file");
});

test("inRepo: the repo and its own worktrees, not a repo nested under .entomatical", () => {
  const p = (...parts) => path.join(path.parse(process.cwd()).root, ...parts); // C:\ on Windows, / elsewhere
  const repo = p("r", "Repo");
  assert.equal(s.inRepo(repo, p("r", "Repo")), true);
  assert.equal(s.inRepo(repo, p("r", "Repo", "src")), true);
  assert.equal(s.inRepo(repo, p("r", "Repo", "..notes")), true);
  assert.equal(s.inRepo(repo, p("r", "Repo", ".entomatical", "wt", "ab12")), true);
  assert.equal(s.inRepo(repo, p("r", "repo", ".entomatical", "wt", "ab12")), process.platform === "win32");
  assert.equal(s.inRepo(repo, p("r", "Repo", ".entomatical", "other repo")), false);
  assert.equal(s.inRepo(repo, p("r", "Repo", ".entomatical", "other repo", ".entomatical", "wt", "x")), false);
  assert.equal(s.inRepo(repo, p("r", "Repo2")), false);
});

test("account folders follow host case rules, including the default account alias", () => {
  const upper = path.join(tmp(), "Account"), lower = path.join(path.dirname(upper), "account");
  assert.equal(s.sameFolder("", s.DEFAULT_DIR), true);
  assert.equal(s.sameFolder(upper, lower), process.platform === "win32");
  assert.deepEqual(s.otherAccountDirs(upper, [upper, lower, lower].map(configDir => ({ configDir }))),
    process.platform === "win32" ? [] : [lower]);
  assert.equal(s.meantFor(lower, { [upper]: "a@example.test" }), process.platform === "win32" ? "a@example.test" : undefined);
});

test("Claude discovery separates existing Linux Repo and repo checkouts", { skip: process.platform !== "linux" }, (t) => {
  const parent = tmp(), sessions = path.join(s.DEFAULT_DIR, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  t.mock.method(process, "kill", (pid, sig) => { assert.ok([101, 102].includes(pid)); assert.equal(sig, 0); });
  for (const [name, pid] of [["Repo", 101], ["repo", 102]]) {
    const cwd = path.join(parent, name, "..notes");
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(sessions, pid + ".json"), line({ pid, cwd, sessionId: name }));
  }
  for (const name of ["Repo", "repo"]) {
    assert.deepEqual(s.liveSessions(path.join(parent, name)).map(s => s.sessionId), [name]);
  }
});

test("sessionName: the CLI's derived placeholder is not a title", () => {
  assert.equal(s.sessionName({ name: "c40724-15", nameSource: "derived" }), undefined);
  assert.equal(s.sessionName({ name: "Fix login", nameSource: "user" }), "Fix login");
  assert.equal(s.sessionName({ name: "Older file" }), "Older file"); // files without nameSource
  assert.equal(s.sessionName({}), undefined);
});

test("linkIntoHistory: one hard link per account in the repo's project folder, appends shared", () => {
  const dir = tmp(), repo = "C:\\r\\Repo", sid = "11111111-2222-3333-4444-555555555555";
  const own = path.join(dir, "own"), ide = path.join(dir, "ide");
  const real = s.transcriptPath(own, repo + "\\.entomatical\\wt\\ab12", sid);
  assert.deepEqual(s.linkIntoHistory(real, [own, ide], repo, sid), []); // no transcript yet
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, line({ type: "user", message: { content: "hi" } }));
  const made = s.linkIntoHistory(real, [own, ide, process.platform === "win32" ? own.toUpperCase() : own], repo, sid);
  assert.deepEqual(made, [s.transcriptPath(own, repo, sid), s.transcriptPath(ide, repo, sid)]);
  fs.appendFileSync(real, line({ type: "user", message: { content: "more" } }));
  assert.deepEqual(s.transcriptExchanges(made[1]).map((e) => e.text), ["hi", "more"]); // the same file, not a copy
  assert.deepEqual(s.linkIntoHistory(real, [own, ide], repo, sid), []); // already linked
  assert.deepEqual(s.linkIntoHistory(made[0], [own], repo, sid), []); // a session run in the repo itself
});

test("linkIntoHistory: a config folder on another filesystem (EXDEV) is skipped once, quietly, and not retried", () => {
  const dir = tmp(), repo = "C:\\r\\Exdev", sid = "22222222-3333-4444-5555-666666666666";
  const own = path.join(dir, "own"), other = path.join(dir, "other");
  const real = s.transcriptPath(own, repo + "\\.entomatical\\wt\\cd34", sid);
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, line({ type: "user", message: { content: "hi" } }));
  const link = fs.linkSync, tries = [];
  fs.linkSync = (from, to) => {
    tries.push(to);
    if (to.startsWith(other)) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    return link(from, to);
  };
  try {
    assert.deepEqual(s.linkIntoHistory(real, [own, other], repo, sid), [s.transcriptPath(own, repo, sid)]);
    assert.equal(fs.existsSync(other), false); // the folders made for the link are removed again
    assert.deepEqual(s.linkIntoHistory(real, [own, other], repo, sid), []);
    assert.equal(tries.filter((t) => t.startsWith(other)).length, 1); // not retried on the next tick
    fs.linkSync = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
    assert.throws(() => s.linkIntoHistory(real, [path.join(dir, "third")], repo, sid), /EACCES/); // other errors still surface
  } finally {
    fs.linkSync = link;
  }
});

test("transcriptExchanges: only what the user typed, oldest first, each with the last answer before the next prompt", () => {
  const file = path.join(tmp(), "t.jsonl");
  fs.writeFileSync(file, [
    line({ type: "user", message: { content: "hello" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }, { type: "text", text: "looking" }] } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "first answer" }] } }),
    line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "a subagent's text" }] } }),
    line({ type: "user", message: { content: "<system-reminder>x</system-reminder>" } }),
    line({ type: "user", message: { content: "[Request interrupted by user]" } }),
    line({ type: "user", isMeta: true, message: { content: "meta" } }),
    line({ type: "user", message: { content: [{ type: "tool_result", content: "r" }] } }),
    line({ type: "user", message: { content: [{ type: "text", text: "second" }] } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "reply" }] } }),
    line({ type: "user", message: { content: "<task-notification>Agent finished.</task-notification>" } }),
    line({ type: "user", message: { content: '<cross-session-message from="peer">Done.</cross-session-message>' } }),
    line({ type: "user", message: { content: '<agent-message from="peer">Done.</agent-message>' } }),
    line({ type: "user", message: { content: "<main> should contain the corrected title." } }),
    "{not json\n",
  ].join(""));
  assert.deepEqual(s.transcriptExchanges(file), [{ text: "hello", reply: "first answer" }, { text: "second", reply: "reply" },
    { text: "<main> should contain the corrected title." }]);
  assert.deepEqual(s.transcriptExchanges(path.join(tmp(), "missing.jsonl")), []);
});

test("subagents: type, description, steps, done and current action", () => {
  const dir = tmp();
  const transcript = path.join(dir, "sess.jsonl");
  const agents = path.join(dir, "sess", "subagents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, "agent-abc.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Find callers" }));
  const file = path.join(agents, "agent-abc.jsonl");
  fs.writeFileSync(file, [
    line({ type: "user", message: { content: "Find callers of foo" } }),
    line({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Grep", input: { pattern: "foo(" } }] } }),
    line({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } }] } }),
  ].join(""));
  let [a] = s.subagents(transcript);
  assert.equal(a.id, "abc");
  assert.equal(a.type, "general-purpose");
  assert.equal(a.description, "Find callers");
  assert.equal(a.steps, 2);
  assert.equal(a.done, false);
  assert.equal(a.doing, "Read src/a.ts");
  fs.appendFileSync(file, line({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "Two callers.\nDetails..." }] } }));
  [a] = s.subagents(transcript);
  assert.equal(a.done, true);
  assert.equal(a.doing, "Two callers.");
  assert.deepEqual(s.subagents(path.join(dir, "none.jsonl")), []);
});

test("subagents: a transcript larger than one read is read from its tail only", () => {
  const dir = tmp();
  const transcript = path.join(dir, "big.jsonl");
  const agents = path.join(dir, "big", "subagents");
  fs.mkdirSync(agents, { recursive: true });
  const file = path.join(agents, "agent-big.jsonl");
  const filler = line({ type: "user", message: { content: "x".repeat(1024 * 1024) } });
  const fd = fs.openSync(file, "w");
  for (let i = 0; i * Buffer.byteLength(filler) <= s.MAX_SUBAGENT_READ; i++) fs.writeSync(fd, filler);
  fs.writeSync(fd, line({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "tail.ts" } }] } }));
  fs.closeSync(fd);
  let [a] = s.subagents(transcript);
  assert.equal(a.doing, "Read tail.ts");
  assert.equal(a.steps, 1);
  fs.appendFileSync(file, line({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "Finished." }] } }));
  [a] = s.subagents(transcript);
  assert.equal(a.done, true);
  assert.equal(a.steps, 1);
});

test("subagents: a transcript deleted between the listing and its stat or open is skipped, the others still listed", (t) => {
  const dir = tmp();
  const transcript = path.join(dir, "race.jsonl");
  const agents = path.join(dir, "race", "subagents");
  fs.mkdirSync(agents, { recursive: true });
  for (const id of ["keep", "gone", "late"]) fs.writeFileSync(path.join(agents, `agent-${id}.jsonl`), line({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: id }] } }));
  const statSync = fs.statSync;
  t.mock.method(fs, "statSync", (file, ...rest) => {
    if (String(file).endsWith("agent-gone.jsonl")) fs.rmSync(file); // vanishes before its stat
    const st = statSync(file, ...rest);
    if (String(file).endsWith("agent-late.jsonl")) fs.rmSync(file); // vanishes after its stat, before its open
    return st;
  });
  assert.deepEqual(s.subagents(transcript).map((a) => a.id), ["keep"]);
});

test("lastAssistantText returns the first line, capped", () => {
  const file = path.join(tmp(), "t.jsonl");
  const long = "x".repeat(500);
  fs.writeFileSync(file, [
    line({ type: "assistant", message: { content: [{ type: "text", text: "first answer" }] } }),
    line({ type: "user", message: { content: "more" } }),
    line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: `<b>Done</b>: all set\n${long}` }] } }),
  ].join(""));
  assert.equal(s.lastAssistantText(file), "<b>Done</b>: all set");
  fs.appendFileSync(file, line({ type: "assistant", message: { content: [{ type: "text", text: long }] } }));
  assert.equal(s.lastAssistantText(file).length, 160);
  assert.equal(s.lastAssistantText(path.join(tmp(), "none.jsonl")), undefined);
});

test("lastAssistantText rereads the file only when it changed", () => {
  const file = path.join(tmp(), "t.jsonl");
  const reply = (text) => line({ type: "assistant", message: { content: [{ type: "text", text }] } });
  const then = new Date(Date.now() - 60_000);
  fs.writeFileSync(file, reply("aaaa"));
  fs.utimesSync(file, then, then);
  assert.equal(s.lastAssistantText(file), "aaaa");
  fs.writeFileSync(file, reply("bbbb")); // same size
  fs.utimesSync(file, then, then); // same time: the cached answer stands
  assert.equal(s.lastAssistantText(file), "aaaa");
  fs.utimesSync(file, new Date(), new Date()); // touched: read again
  assert.equal(s.lastAssistantText(file), "bbbb");
});

test("transitionNote: only board tasks, only on real transitions", () => {
  assert.equal(s.transitionNote("running", "needs-input", false), "input");
  assert.equal(s.transitionNote("running", "review", false), "done");
  assert.equal(s.transitionNote("needs-input", "review", false), "done");
  assert.equal(s.transitionNote("queued", "review", false), undefined); // nothing ran
  assert.equal(s.transitionNote("review", "review", false), undefined);
  assert.equal(s.transitionNote("review", "done", false), undefined);
  assert.equal(s.transitionNote("running", "needs-input", true), undefined); // found session: you are already in it
  assert.equal(s.transitionNote("running", "review", true), undefined);
});

test("transitionNote: an API error at Review always warns, even from Queued (a first prompt refused within one poll) or from Review (F42)", () => {
  assert.equal(s.transitionNote("queued", "review", false, "rate_limit"), "done");
  assert.equal(s.transitionNote("review", "review", false, "overloaded"), "done");
  assert.equal(s.transitionNote("review", "review", true, "overloaded"), undefined); // found session: you are already in it
});

test("claimOwner: defers only to a live owner with a fresh heartbeat", () => {
  const file = path.join(tmp(), "owner.json");
  const live = () => true, dead = () => false;
  assert.equal(s.claimOwner(file, 111, 1000, 15000, live, true), true);   // first claim
  assert.equal(s.claimOwner(file, 222, 2000, 15000, live, true), false);  // a live, fresh owner keeps it
  assert.equal(s.claimOwner(file, 111, 3000, 15000, live), true);   // the owner renews its heartbeat
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).at, 3000);
  assert.equal(s.claimOwner(file, 222, 30000, 15000, live, true), true);  // stale heartbeat: a reused pid is not an owner
  assert.equal(s.claimOwner(file, 333, 31000, 15000, dead, true), true);  // dead owner: taken over
  fs.writeFileSync(file, JSON.stringify({ pid: 444 }));             // the old format had no heartbeat
  assert.equal(s.claimOwner(file, 555, 40000, 15000, live, true), true);
  fs.writeFileSync(file, "not json");
  assert.equal(s.claimOwner(file, 666, 41000, 15000, live, true), true);
});

// F45: only a window's tick takes the board over, since only the tick reloads the old owner's last save first.
test("claimOwner: without takeover a stale, dead or missing owner is not taken; the owner still renews", () => {
  const file = path.join(tmp(), "owner.json");
  const dead = () => false;
  assert.equal(s.claimOwner(file, 111, 1000, 15000, dead), false); // no owner yet
  assert.ok(!fs.existsSync(file));
  assert.equal(s.claimOwner(file, 111, 1000, 15000, dead, true), true);
  assert.equal(s.claimOwner(file, 222, 60000, 15000, dead), false); // a dead, stale owner: refused until 222's tick
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, 111);
  assert.equal(s.claimOwner(file, 111, 61000, 15000, dead), true);  // its own heartbeat, renewed
});

test("claimOwner: a takeover that another window overwrote at the same moment does not count", () => {
  const file = path.join(tmp(), "owner.json");
  fs.writeFileSync(file, JSON.stringify({ pid: 111, at: 0 })); // stale
  const real = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (f, ...rest) => (f === file && ++reads > 1 ? JSON.stringify({ pid: 333, at: 60000 }) : real(f, ...rest)); // 333's write lands after 222's
  try { assert.equal(s.claimOwner(file, 222, 60000, 15000, () => false, true), false); } finally { fs.readFileSync = real; }
  assert.equal(s.claimOwner(file, 222, 60000, 15000, () => false, true), true); // alone, it holds
});

test("claimOwner: renews the file by rename and never truncates it in place", () => {
  const dir = tmp(), file = path.join(dir, "owner.json");
  s.claimOwner(file, 111, 1000, 15000, undefined, true);
  const real = fs.writeFileSync, wrote = [];
  fs.writeFileSync = (f, ...rest) => { wrote.push(f); return real(f, ...rest); };
  try { s.claimOwner(file, 111, 2000); } finally { fs.writeFileSync = real; }
  assert.deepEqual(wrote.filter((f) => f === file), []); // a truncated owner.json reads as "no owner" to a window polling at that moment
  assert.deepEqual(fs.readdirSync(dir), ["owner.json"]); // the temp file is gone
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).at, 2000);
});

test("claimOwner: a read that fails once is tried again before the owner counts as gone", () => {
  const file = path.join(tmp(), "owner.json");
  const live = () => true;
  assert.equal(s.claimOwner(file, 111, 1000, 15000, live, true), true);
  const real = fs.readFileSync;
  const glitches = [() => "", () => { throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }); }]; // half-written, locked
  for (const glitch of glitches) {
    let first = true;
    fs.readFileSync = (f, ...rest) => (f === file && first ? ((first = false), glitch()) : real(f, ...rest));
    try { assert.equal(s.claimOwner(file, 222, 2000, 15000, live, true), false); } finally { fs.readFileSync = real; }
  }
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, 111); // still the first owner's
});

test("a panel prompt sent while Claude in Chrome is connected shows what was typed, not Chrome's <browser_instruction> block", () => {
  const { typedText, transcriptExchanges } = require("../out/sessions");
  const block = "<browser_instruction># Claude in Chrome browser automation\n\n" + "x".repeat(4000) + "</browser_instruction>\n";
  assert.equal(typedText(block + "What is A97796?"), "What is A97796?");
  assert.equal(typedText("<browser_instruction> unclosed"), "<browser_instruction> unclosed"); // not Claude Code's shape: left alone
  assert.equal(typedText("plain"), "plain");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-typed-"));
  const file = path.join(dir, "s.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "user", message: { content: [{ type: "text", text: block }, { type: "text", text: "hello there" }] } }) + "\n");
  assert.deepEqual(transcriptExchanges(file), [{ text: "hello there" }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an auth status check that prints no JSON (a timeout, a crash) keeps the folder's last status; loggedIn:false signs it out", { skip: process.platform === "win32" && "execFile finds no shell-script claude on Windows" }, async (t) => {
  const bin = fs.mkdtempSync(path.join(require("./exec-tmpdir").execTmpdir(), "ab-auth-"));
  const answer = path.join(bin, "answer.txt");
  const dir = path.join(bin, "acct");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh
[ "$*" = "auth status" ] && [ "$CLAUDE_CONFIG_DIR" = '${dir}' ] && [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] || exit 2
cat '${answer}'
exit "$(cat '${bin}/code')"
`, { mode: 0o755 });
  const PATH = process.env.PATH;
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "synthetic-inherited-token";
  t.after(() => { if (token === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = token; });
  process.env.PATH = `${bin}${path.delimiter}${PATH}`;
  t.after(() => { process.env.PATH = PATH; fs.rmSync(bin, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(bin, "code"), "0");
  fs.writeFileSync(answer, JSON.stringify({ loggedIn: true, email: "Max@Example.com", subscriptionType: "max" }));
  assert.deepEqual(await s.authStatus(dir), { configDir: dir, loggedIn: true, email: "max@example.com", plan: "max" });
  for (const [planTier, plan] of [["max_5x", "max_5x (CLI tier)"], ["max_20x", "max_20x (CLI tier)"], ["max_other", "max"]]) {
    fs.writeFileSync(answer, JSON.stringify({ loggedIn: true, email: "Max@Example.com", subscriptionType: "max", planTier }));
    assert.equal((await s.authStatus(dir)).plan, plan);
  }
  fs.writeFileSync(path.join(bin, "code"), "1");
  assert.equal(await s.freshAuthStatus(dir), undefined, "a failed command cannot confirm a positive JSON response");
  fs.writeFileSync(path.join(bin, "code"), "0");
  fs.writeFileSync(answer, JSON.stringify({ loggedIn: "false", email: "max@example.com" }));
  assert.equal(await s.freshAuthStatus(dir), undefined);
  fs.writeFileSync(answer, "Error: something went wrong");
  assert.equal(await s.freshAuthStatus(dir), undefined, "login verification cannot use the discovery cache");
  assert.deepEqual(await s.authStatus(dir), { configDir: dir, loggedIn: true, email: "max@example.com", plan: "max" });
  fs.writeFileSync(answer, JSON.stringify({ loggedIn: false }));
  fs.writeFileSync(path.join(bin, "code"), "1"); // the CLI's explicit sign-out
  assert.equal((await s.authStatus(dir)).loggedIn, false);
  fs.writeFileSync(answer, "Error: something went wrong");
  assert.equal((await s.authStatus(path.join(bin, "never-seen"))).loggedIn, false); // no earlier answer: not signed in
  fs.writeFileSync(answer, JSON.stringify({ loggedIn: true, email: "a@example.com" }));
  fs.writeFileSync(path.join(bin, "code"), "0");
  await s.authStatus(dir);
  s.forgetAuthStatus(dir); // signed out or removed: the old login must not stand in for a failed check
  fs.writeFileSync(answer, "Error: something went wrong");
  assert.equal((await s.authStatus(dir)).loggedIn, false);
});

// F41: a copy left by an earlier move (a hard link refused across drives) must not be resumed after the conversation grew elsewhere.
test("carryTranscript: a shorter copy at the destination is set aside and placed again; the same file or a longer one is kept", () => {
  const dir = tmp();
  const from = path.join(dir, "a", "s1.jsonl"), dest = path.join(dir, "b", "s1.jsonl");
  fs.mkdirSync(path.dirname(from), { recursive: true });
  fs.writeFileSync(from, "one\n");
  assert.deepEqual(s.carryTranscript(from, dest), [dest]);
  assert.deepEqual(s.carryTranscript(from, dest), []); // the same file (a link): nothing to do
  fs.rmSync(dest);
  fs.writeFileSync(dest, "one\n"); // the copy fallback
  fs.appendFileSync(from, "two\n"); // the conversation went on on the first account
  assert.deepEqual(s.carryTranscript(from, dest), [dest]);
  assert.equal(fs.readFileSync(dest, "utf8"), "one\ntwo\n");
  assert.equal(fs.readdirSync(path.dirname(dest)).filter((n) => n.endsWith(".stale")).length, 1); // kept beside it, not deleted
  fs.rmSync(dest);
  fs.writeFileSync(dest, "one\ntwo\nthree\n"); // longer: it went on after the move, so it stays
  assert.deepEqual(s.carryTranscript(from, dest), []);
  assert.equal(fs.readFileSync(dest, "utf8"), "one\ntwo\nthree\n");
});

test("RT-12: the request journal shows an entry or a compaction only once it is on disk", () => {
  const file = path.join(tmp(), "journal.jsonl"), j = new s.RequestJournal(file, 1000), now = Date.now();
  const eio = () => Object.assign(new Error("EIO: injected"), { code: "EIO" });
  const open = test.mock.method(fs, "openSync", () => { throw eio(); });
  try { assert.throws(() => j.record({ nonce: "lost", hash: "h", state: "started", at: now }), /EIO/); } finally { open.mock.restore(); }
  assert.equal(j.get("lost"), undefined, "never journaled, so never started");
  j.record({ nonce: "old", hash: "h", state: "answered", at: now - 5000 });
  fs.appendFileSync(file, line({ nonce: "pad", hash: "x".repeat(1_100_000), state: "answered", at: now }));
  const rename = test.mock.method(fs, "renameSync", () => { throw eio(); });
  try { assert.throws(() => j.compact(now), /EIO/); } finally { rename.mock.restore(); }
  assert.equal(j.get("old")?.state, "answered", "the compaction failed, so the file still holds it");
  j.compact(now);
  assert.deepEqual([j.get("old"), new s.RequestJournal(file, 1000).get("old"), j.get("pad")?.state], [undefined, undefined, "answered"]);
});
