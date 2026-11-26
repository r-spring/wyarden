// A card finds its Claude session's transcript and subagents wherever the session went (board.ts claudePlaces, sessions.ts
// sessionPlaces). The layout is card 19d7e9's, measured on 9 November 2026: its worktree merged and deleted, the session resumed from
// the main checkout under another account folder, the transcript hard-linked into two project folders of ~/.claude (one "c--..." from a
// lower-case drive letter), and the subagent transcripts only under the other account's project folder.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

class EventEmitter {
  listeners = [];
  event = (l) => (this.listeners.push(l), { dispose() {} });
  fire(e) { for (const l of this.listeners) l(e); }
  dispose() {}
}
const vscode = { EventEmitter, ThemeIcon: class {}, commands: { executeCommand: async () => {} },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined, createTerminal: () => ({ show() {}, dispose() {}, sendText() {} }) } };
// DEFAULT_DIR and ACCOUNTS_ROOT are read at load: a throwaway home holds both config folders.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-places-"));
process.env.HOME = process.env.USERPROFILE = home;
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board } = require("../out/board.js");
const { forgetSessionPlaces } = require("../out/sessions.js");

const boards = [];
test.after(() => { for (const b of boards) b.dispose(); fs.rmSync(home, { recursive: true, force: true }); });

const folderOf = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
/** The project folder name with its first letter's case flipped: "C--x" from "c--x" (a cwd whose drive letter was lower case). */
const flipped = (name) => name.replace(/^[a-zA-Z]/, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
const line = (o) => JSON.stringify(o) + "\n";
// The first turn ran in the card's worktree (its hooks saw it); the second came after a resume outside the card, an hour later.
const FIRST = Date.parse("2026-11-09T08:00:00Z"), RESUMED = Date.parse("2026-11-09T09:00:00Z");
const conversation = line({ type: "user", timestamp: new Date(FIRST).toISOString(), message: { role: "user", content: "Fix the takeover handoff" } })
  + line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fixed in the worktree." }] } })
  + line({ type: "user", timestamp: new Date(RESUMED).toISOString(), message: { role: "user", content: "Now resumed from the main checkout" } })
  + line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Resumed reply under the other account." }] } });
const usage = { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 };
const agent = (id, text) => line({ type: "assistant", message: { id: `${id}-m1`, usage, model: "claude-sonnet", content: [{ type: "tool_use", id: `${id}-t1`, name: "Read", input: { file_path: "a.ts" } }] } })
  + line({ type: "assistant", message: { model: "claude-sonnet", content: [{ type: "text", text }] } });

/** Lays out one session as measured; returns its paths. */
function layout(sessionId) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-places-repo-"));
  const worktree = path.join(repo, ".entomatical", "wt", "19d7e9"); // never made: merged and deleted
  const own = path.join(home, ".claude"), other = path.join(home, ".claude-accounts", "personal@example.com");
  const inWorktree = path.join(own, "projects", folderOf(worktree), `${sessionId}.jsonl`);
  // On Windows the "c--" folder is the main checkout's; elsewhere (no drive letter) the flip changes nothing.
  const inRepo = path.join(own, "projects", flipped(folderOf(repo)), `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(inWorktree), { recursive: true });
  fs.mkdirSync(path.dirname(inRepo), { recursive: true });
  fs.writeFileSync(inWorktree, conversation);
  fs.linkSync(inWorktree, inRepo);
  const agents = path.join(other, "projects", folderOf(repo), sessionId, "subagents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, "agent-a1.jsonl"), agent("a1", "Reviewed."));
  fs.writeFileSync(path.join(agents, "agent-a1.meta.json"), JSON.stringify({ agentType: "ab-reviewer", description: "Review the fix" }));
  fs.writeFileSync(path.join(agents, "agent-a2.jsonl"), agent("a2", "Mapped."));
  return { repo, worktree, inWorktree, inRepo, agents };
}

function open(repo) {
  const board = new Board(repo, path.join(repo, "hook.js"));
  board.startNudgeMs = 600_000;
  boards.push(board);
  return board;
}

test("a resumed card finds its transcript and its subagents under another account and project folder", () => {
  forgetSessionPlaces();
  const sessionId = "d6728e54-2fcd-49a2-bb1e-7210af626f46";
  const { repo, worktree, inWorktree, inRepo } = layout(sessionId);
  const board = open(repo);
  // As card 19d7e9: the default account, its deleted worktree still recorded, no stored transcript, and hooks that named the worktree path.
  const live = board.add("Resolve AI card takeover handoff issues", "Fix the takeover handoff");
  board.update(live, { sessionId, worktree, status: "review" });
  fs.mkdirSync(path.dirname(board.eventsFile(live.id)), { recursive: true });
  fs.writeFileSync(board.eventsFile(live.id), line({ t: FIRST - 1000, hook_event_name: "SessionStart", session_id: sessionId, transcript_path: inWorktree })
    + line({ t: FIRST, hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "Fix the takeover  handoff\n", transcript_path: inWorktree })
    + line({ t: FIRST + 60_000, hook_event_name: "Stop", session_id: sessionId, last_assistant_message: "Fixed in the worktree (hook).", transcript_path: inWorktree }));
  assert.ok(fs.existsSync(board.transcriptOf(live)), "the card's transcript is found");
  // The resumed part's prompt joins the hook's one (matched by its text, whitespace aside, so not listed twice), with its reply.
  assert.deepEqual(board.prompts(live).map((e) => [e.text, e.reply]), [
    ["Fix the takeover  handoff\n", "Fixed in the worktree (hook)."],
    ["Now resumed from the main checkout", "Resumed reply under the other account."],
  ]);
  assert.equal(board.lastReply(live), "Resumed reply under the other account.");
  const timeline = board.timelineOf(live).map((l) => [l.t, l.text.replace(/^\S+ /, "")]);
  assert.deepEqual(timeline.map(([, text]) => text), ["SessionStart", "Prompt: Fix the takeover  handoff", "Stop: Fixed in the worktree (hook).", "Prompt: Now resumed from the main checkout"]);
  assert.equal(timeline[3][0], RESUMED);
  assert.deepEqual(board.subagentsOf(live).map((a) => a.id).sort(), ["a1", "a2"]);
  assert.equal(board.subagentsOf(live).find((a) => a.id === "a1").type, "ab-reviewer");
  assert.equal(board.metrics.session(live).tokens.input, 200, "the token measurement counts both subagents' requests");

  // A finished card stored the worktree's transcript path, which is gone now: the main checkout's link still holds the conversation.
  const done = board.add("Finished card", "first prompt");
  fs.rmSync(inWorktree);
  board.update(done, { sessionId, transcript: inWorktree, status: "done" });
  assert.equal(path.resolve(board.transcriptOf(done)).toLowerCase(), path.resolve(inRepo).toLowerCase());
  assert.deepEqual(board.prompts(done).map((e) => [e.text, e.reply]), [
    ["Fix the takeover handoff", "Fixed in the worktree."],
    ["Now resumed from the main checkout", "Resumed reply under the other account."],
  ]);
  assert.equal(board.lastReply(done), "Resumed reply under the other account.");
  assert.deepEqual(board.subagentsOf(done).map((a) => a.id).sort(), ["a1", "a2"]);
});

test("the newest copy wins, one subagent seen in two places is listed once, and a vanished file is found again", () => {
  forgetSessionPlaces();
  const sessionId = "5e551011-0000-4000-8000-000000000002";
  const { repo, inWorktree, inRepo, agents } = layout(sessionId);
  // A carried copy (another drive refused the hard link) under the other account, written later than the links.
  const copy = path.join(path.dirname(agents), "..", `${sessionId}.jsonl`);
  fs.writeFileSync(copy, conversation + line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Newest copy." }] } }));
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(copy, later, later);
  // The same agent beside the worktree link too, older: the newer one is shown, once.
  const beside = path.join(inWorktree.replace(/\.jsonl$/, ""), "subagents");
  fs.mkdirSync(beside, { recursive: true });
  fs.writeFileSync(path.join(beside, "agent-a1.jsonl"), agent("a1", "Older."));
  const earlier = new Date(Date.now() - 600_000);
  fs.utimesSync(path.join(beside, "agent-a1.jsonl"), earlier, earlier);
  const board = open(repo);
  const task = board.add("Card", "Fix the takeover handoff");
  board.update(task, { sessionId, status: "review" });
  assert.equal(path.resolve(board.transcriptOf(task)), path.resolve(copy));
  assert.equal(board.lastReply(task), "Newest copy.");
  const listed = board.subagentsOf(task);
  assert.deepEqual(listed.map((a) => a.id).sort(), ["a1", "a2"]);
  assert.ok(listed.find((a) => a.id === "a1").updated > earlier.getTime());
  // The chosen file goes: the next look, past the short cache, finds the next newest.
  fs.rmSync(copy);
  const now = Date.now;
  Date.now = () => now() + 10_000;
  try {
    const next = path.resolve(board.transcriptOf(task)).toLowerCase();
    assert.ok([inWorktree, inRepo].map((f) => path.resolve(f).toLowerCase()).includes(next), next);
  } finally { Date.now = now; }
});

test("a growing transcript is read on from where the last read stopped, and a line still being written is not kept", () => {
  const { transcriptTurns } = require("../out/sessions.js");
  const file = path.join(home, "growing.jsonl");
  fs.writeFileSync(file, line({ type: "user", timestamp: new Date(FIRST).toISOString(), message: { content: "one" } }));
  const first = transcriptTurns(file).exchanges;
  assert.deepEqual(first, [{ text: "one" }]);
  const half = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "answer one" }] } });
  fs.appendFileSync(file, half); // no newline yet: read, not kept
  assert.deepEqual(transcriptTurns(file).exchanges, [{ text: "one", reply: "answer one" }]);
  fs.appendFileSync(file, "\n" + line({ type: "user", timestamp: new Date(RESUMED).toISOString(), message: { content: "two" } }));
  const turns = transcriptTurns(file);
  assert.deepEqual(turns.exchanges, [{ text: "one", reply: "answer one" }, { text: "two" }]);
  assert.deepEqual(turns.times, [FIRST, RESUMED]);
  assert.deepEqual(first, [{ text: "one" }], "an answer handed out earlier is not changed");
  fs.writeFileSync(file, line({ type: "user", message: { content: "replaced" } })); // shorter: read again from the start
  assert.deepEqual(transcriptTurns(file).exchanges, [{ text: "replaced" }]);
});

// 11 November 2026: the board read a live card's whole transcript again on every change, synchronously on the extension host's thread.
test("after an append a transcript read takes only the new bytes and gives what a fresh read gives; a rewritten, replaced or shorter file is read from the start", () => {
  const { transcriptExchanges } = require("../out/sessions.js");
  const file = path.join(home, "appended.jsonl");
  let copies = 0;
  const turns = (word, from, to) => { let s = ""; for (let i = from; i < to; i++) s += line({ type: "user", message: { content: `${word} ${i}` } }) + line({ type: "assistant", message: { content: [{ type: "text", text: `${word} answer ${i}` }] } }); return s; };
  /** What a first read of the same bytes gives: a copy the cache has never seen. */
  const fresh = () => { const copy = path.join(home, `appended-fresh-${++copies}.jsonl`); fs.copyFileSync(file, copy); return transcriptExchanges(copy); };
  fs.writeFileSync(file, turns("prompt", 0, 200));
  assert.equal(transcriptExchanges(file).length, 200);
  let bytes = 0;
  const realRead = fs.readSync;
  fs.readSync = (...args) => { const n = realRead(...args); bytes += n; return n; };
  try {
    const more = turns("prompt", 200, 201);
    fs.appendFileSync(file, more);
    bytes = 0;
    const after = transcriptExchanges(file);
    const read = bytes;
    // The appended bytes, and 64 bytes before where each read stopped (the check that the file was appended to, not rewritten).
    assert.ok(read <= Buffer.byteLength(more) + 2 * 64, `${read} bytes read for ${Buffer.byteLength(more)} appended (file ${fs.statSync(file).size})`);
    assert.equal(after.length, 201);
    assert.deepEqual(after, fresh());

    // The same file rewritten in place, longer, with another conversation: not taken for an append.
    fs.writeFileSync(file, turns("other", 0, 300));
    bytes = 0;
    const rewritten = transcriptExchanges(file);
    assert.ok(bytes >= fs.statSync(file).size, "read from the start");
    assert.equal(rewritten[0].text, "other 0");
    assert.deepEqual(rewritten, fresh());

    // Replaced by another file (a rename over it), longer again.
    const next = path.join(home, "appended-next.jsonl");
    fs.writeFileSync(next, turns("third", 0, 400));
    fs.renameSync(next, file);
    const replaced = transcriptExchanges(file);
    assert.equal(replaced.length, 400);
    assert.equal(replaced[0].text, "third 0");
    assert.deepEqual(replaced, fresh());

    // Shorter.
    fs.writeFileSync(file, turns("short", 0, 2));
    assert.deepEqual(transcriptExchanges(file), [{ text: "short 0", reply: "short answer 0" }, { text: "short 1", reply: "short answer 1" }]);
  } finally {
    fs.readSync = realRead;
  }
});

test("a transcript larger than one read slice gives the same prompts as one read of it", () => {
  const sessions = require("../out/sessions.js");
  const file = path.join(home, "sliced.jsonl");
  // Lines of about 1 KB so the 8 MB slices end inside lines.
  const pad = "x".repeat(1000);
  let body = "";
  for (let i = 0; i < 9_000; i++) body += line({ type: "user", message: { content: `ask ${i} ${pad}` } }) + line({ type: "assistant", message: { content: [{ type: "text", text: `reply ${i}` }] } });
  fs.writeFileSync(file, body);
  assert.ok(fs.statSync(file).size > sessions.TRANSCRIPT_SLICE, "bigger than a slice");
  const got = sessions.transcriptExchanges(file);
  assert.equal(got.length, 9_000);
  assert.deepEqual(got.at(-1), { text: `ask 8999 ${pad}`, reply: "reply 8999" });
  assert.ok(got.every((e, i) => e.text === `ask ${i} ${pad}` && e.reply === `reply ${i}`));
});
