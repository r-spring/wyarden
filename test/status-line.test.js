// The status record and line (src/status-line.ts, F70), the hook's tool description (hook/hook.js) and the check catalogue (src/checks.ts, F76).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { statusRecord, statusLine, liveLine, timeline, eventLabel, quietMinutes, CHANGE_KEY } = require("../out/status-line.js");
const { limitToCatalogue, readCatalogue, inCatalogue, ensureCatalogue } = require("../out/checks.js");

const NOW = Date.parse("2026-11-04T12:00:00Z");
const task = (extra = {}) => ({ id: "c1a2b3", title: "Parity: F14 panel check", prompt: "p", status: "review", statusAt: new Date(NOW - 12 * 60_000).toISOString(),
  createdAt: new Date(NOW - 3600_000).toISOString(), updatedAt: new Date(NOW - 60_000).toISOString(), ...extra });
const events = [
  { t: NOW - 600_000, hook_event_name: "SessionStart", source: "startup" },
  { t: NOW - 590_000, hook_event_name: "UserPromptSubmit", prompt: "Check F14 on Windows\nand write evidence" },
  { t: NOW - 300_000, hook_event_name: "PostToolUse", tool_name: "Bash", desc: "Bash npm test" },
  { t: NOW - 200_000, hook_event_name: "PostToolUse", tool_name: "Edit", desc: "Edit src/board.ts", agent_id: "sub1" },
  { t: NOW - 100_000, hook_event_name: "PostToolUse", tool_name: "Read", desc: "Read docs/ledger.md" },
];

test("the status record carries the spec's fields, asks for a Review card (F79), a null judge, and its own one-line form", () => {
  const r = statusRecord(task({ completion: { commands: ["npm test"] }, checks: { status: "complete", run: "x" }, openedBy: "5e8a55" }), { events: [...events, { t: NOW - 50_000, hook_event_name: "Stop", last_assistant_message: "F14 done 3009514; evidence in docs/evidence/…\nmore" }], lastReply: "F14 done 3009514; evidence in docs/evidence/…", now: NOW });
  assert.deepEqual({ ...r, line: undefined }, { id: "c1a2b3", at: NOW, status: "review", since: NOW - 12 * 60_000, title: "Parity: F14 panel check", launchState: "unknown", checks: "passed", asks: false, quiet: 0, repeating: null, judged: null,
    doing: null, last: "F14 done 3009514; evidence in docs/evidence/…", watchedBy: "5e8a55", openedBy: "5e8a55", role: null, chips: [], line: undefined });
  assert.equal(r.line, statusLine(r, NOW));
  assert.match(r.line, /^c1a2b3  review {8}12 min  checks:passed  asks:no  quiet:0  "Parity: F14 panel check"  last: "F14 done 3009514; evidence in docs\/evidence\/…"$/);
  // F79 and F80: a Review card that asked says asks:yes; a running card names its repeated call; outside Review asks is unknown.
  assert.match(statusRecord(task({ asks: true }), { events, now: NOW }).line, /asks:yes/);
  const running = statusRecord(task({ status: "running", asks: true }), { events, now: NOW, repeating: { tool: "Bash", n: 6 } });
  assert.deepEqual([running.asks, running.repeating], [null, "Bash ×6"]);
  assert.match(running.line, /asks:-  quiet:1  repeating:"Bash ×6"  doing:/);
});

test("the live line is the latest tool description of a running turn, skipping subagents, and gone once the turn ended", () => {
  assert.deepEqual(liveLine(events), { text: "Read docs/ledger.md", at: NOW - 100_000 });
  assert.equal(liveLine([...events, { t: NOW - 10, hook_event_name: "Stop", last_assistant_message: "done" }]), undefined);
  assert.equal(liveLine([events[0], events[1]]), undefined);
  const r = statusRecord(task({ status: "running" }), { events, now: NOW });
  assert.equal(r.doing, "Read docs/ledger.md");
  assert.match(r.line, /running {7}12 min  checks:none  asks:-  quiet:1  doing:"Read docs\/ledger.md"  "Parity/);
  // A review card shows no live line even with descriptions in its events.
  assert.equal(statusRecord(task(), { events, now: NOW }).doing, null);
});

test("chips: needs input, interrupted, headless, taken over, paused, waits for reset, plan ready; checks failed and running", () => {
  const chips = (extra) => statusRecord(task(extra), { events: [], now: NOW }).chips;
  assert.deepEqual(chips({ status: "needs-input" }), ["needs input"]);
  assert.deepEqual(chips({ interrupted: true }), ["interrupted"]);
  assert.deepEqual(chips({ deliveryReady: true }), ["delivery ready"]);
  assert.deepEqual(chips({ cancelled: true }), ["cancelled"]);
  assert.deepEqual(chips({ interrupted: true, status: "running" }), []);
  assert.deepEqual(chips({ headless: true, takenOver: true, paused: true }), ["headless", "taken over", "paused"]);
  assert.equal(chips({ waitsForReset: { account: "a", at: NOW } })[0].startsWith("waits for reset "), true);
  assert.deepEqual(chips({ plan: { at: "x", steps: 3, points: 6 } }), ["plan ready"]);
  assert.deepEqual(chips({ plan: { at: "x", steps: 3, points: 6 }, approved: { at: "y", hash: "h" } }), []);
  const checks = (c) => statusRecord(task({ completion: { commands: ["npm test"] }, checks: c }), { events: [], now: NOW }).checks;
  assert.equal(checks({ status: "error", run: "x" }), "failed");
  assert.equal(checks({ status: "running", run: "x" }), "running");
  assert.equal(checks(undefined), "pending");
  assert.equal(checks({ status: "error", run: "x", error: "Acceptance checks were interrupted. Retry checks when ready." }), "interrupted");
  assert.equal(statusRecord(task({ status: "needs-input" }), { events: [], now: NOW }).line.includes("[needs input]"), true);
});

test("checks: none only without commands; assigned but not run is pending; an orchestrator's checks that wait read pending over an older result", () => {
  const rec = (extra, input = {}) => statusRecord(task(extra), { events: [], now: NOW, ...input });
  assert.equal(rec({}).checks, null);
  assert.match(rec({}).line, /checks:none/);
  // Run d60bfd: list said checks:none for cards whose four commands had not run yet; show said "not run yet".
  const assigned = rec({ completion: { commands: ["npm test", "npm run parity"] } });
  assert.equal(assigned.checks, "pending");
  assert.match(assigned.line, /checks:pending/);
  assert.equal(rec({ completion: { commands: ["npm test"] }, checks: { status: "complete", run: "x" } }, { checksWait: "the plan waits for approval" }).checks, "pending");
  assert.equal(rec({ completion: { commands: ["npm test"] }, checks: { status: "running", run: "x" } }, { checksWait: "1 card of its run still open" }).checks, "running");
});

test("controller chips: a rebound card names its new session, and settle notices that could not go yet are counted", () => {
  const r = statusRecord(task({ controller: { sessionId: "0123456789abcdef", at: "x", mode: "external" }, takenOver: true }), { events: [], now: NOW, noticesWaiting: 2 });
  assert.deepEqual(r.chips, ["taken over", "rebound to 01234567", "notices waiting 2"]);
  assert.match(r.line, /\[taken over, rebound to 01234567, notices waiting 2\]/);
  assert.deepEqual(statusRecord(task(), { events: [], now: NOW, noticesWaiting: 0 }).chips, []);
  // A persisted card from before the controller field keeps its visible binding until resumed.
  assert.deepEqual(statusRecord(task({ orchestrator: { caps: {}, opened: 1, session: "fedcba9876543210" } }), { events: [], now: NOW }).chips, ["rebound to fedcba98"]);
});

test("the change key ignores the record's age and quiet minutes, so wait wakes only on a real change", () => {
  const a = statusRecord(task(), { events, now: NOW }), b = statusRecord(task(), { events, now: NOW + 5 * 60_000 });
  assert.equal(CHANGE_KEY(a), CHANGE_KEY(b));
  assert.notEqual(CHANGE_KEY(a), CHANGE_KEY(statusRecord(task({ status: "done" }), { events, now: NOW })));
  assert.equal(quietMinutes(events, NOW), 1);
  assert.equal(quietMinutes([], NOW), null);
  assert.equal(statusRecord(task({ status: "running" }), { events, now: NOW, lastActivityAt: NOW - 1000 }).quiet, 0,
    "worker or editor activity resets the same quiet timer used by the card");
});

test("the timeline is the last twenty events of the session itself, labelled", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ t: NOW - (30 - i) * 1000, hook_event_name: "PostToolUse", desc: `Read f${i}.ts` }));
  const lines = timeline([...events, ...many]);
  assert.equal(lines.length, 20);
  assert.match(lines.at(-1).text, /Read f29\.ts$/);
  assert.equal(eventLabel(events[1]), "Prompt: Check F14 on Windows");
  assert.equal(eventLabel({ t: 1, hook_event_name: "Stop", last_assistant_message: "ready\nTASK=1" }), "Stop: ready");
  assert.equal(eventLabel({ t: 1, hook_event_name: "StopFailure", error: "rate_limit" }), "StopFailure: rate_limit");
  assert.equal(eventLabel(events[0]), "SessionStart (startup)");
  assert.equal(timeline([...events, { t: NOW, hook_event_name: "SubagentStart", agent_id: "s" }]).some((l) => l.text.includes("Subagent")), false);
});

test("hook.js writes a short tool description (name and main argument, path relative to cwd, 80 characters at most) and never the input", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-hook-desc-"));
  const out = path.join(dir, "e.jsonl");
  const run = (event) => execFileSync(process.execPath, [path.join(__dirname, "..", "hook", "hook.js"), out], { input: JSON.stringify(event) });
  const cwd = "C:\\Users\\example\\wt\\abc123";
  run({ hook_event_name: "PostToolUse", tool_name: "Edit", cwd, tool_input: { file_path: `${cwd}\\src\\board.ts`, old_string: "secret-looking input " + "x".repeat(5000), new_string: "y" } });
  run({ hook_event_name: "PostToolUse", tool_name: "Bash", cwd, tool_input: { command: "npm test\n&& echo second line", description: "Run the tests" } });
  run({ hook_event_name: "PostToolUse", tool_name: "Grep", cwd, tool_input: { pattern: "x".repeat(200) } });
  run({ hook_event_name: "PermissionRequest", tool_name: "Write", cwd, tool_input: { file_path: "/other/place/f.txt" } });
  run({ hook_event_name: "Stop", last_assistant_message: "done" });
  const lines = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.desc), ["Edit src/board.ts", "Bash npm test", `Grep ${"x".repeat(74)}…`, "Write /other/place/f.txt", undefined]);
  assert.equal(lines[2].desc.length, 80);
  assert.equal(lines.some((l) => "tool_input" in l || JSON.stringify(l).includes("secret-looking")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the check catalogue limits commands to workflows/checks.json when the repo has one, and limits nothing without it", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-catalogue-"));
  assert.equal(readCatalogue(repo), undefined);
  assert.deepEqual(limitToCatalogue(["npm test", "rm -rf /"], undefined), { kept: ["npm test", "rm -rf /"], refused: [] });
  fs.mkdirSync(path.join(repo, "workflows"));
  fs.writeFileSync(path.join(repo, "workflows", "checks.json"), JSON.stringify({ "npm-test": { run: "npm test", what: "unit tests and parity", minutes: 4 }, parity: { run: "npm run parity" } }));
  const catalogue = readCatalogue(repo);
  assert.deepEqual(Object.keys(catalogue), ["npm-test", "parity"]);
  assert.equal(inCatalogue("npm   test", catalogue), "npm-test");
  assert.equal(inCatalogue("parity", catalogue), "parity");
  assert.deepEqual(limitToCatalogue(["npm test", "npm run build", "parity"], catalogue), { kept: ["npm test", "npm run parity"], refused: ["npm run build"] });
  fs.writeFileSync(path.join(repo, "workflows", "checks.json"), "not json");
  assert.throws(() => readCatalogue(repo), /Invalid .*checks\.json/);
  assert.throws(() => ensureCatalogue(repo), /Invalid .*checks\.json/);
  fs.writeFileSync(path.join(repo, "workflows", "checks.json"), JSON.stringify({ broken: { what: "no run" } }));
  assert.throws(() => readCatalogue(repo), /needs a nonempty run command/);
  fs.rmSync(path.join(repo, "workflows", "checks.json"));
  assert.deepEqual(ensureCatalogue(repo), {});
  assert.deepEqual(limitToCatalogue(["npm test"], readCatalogue(repo)), { kept: [], refused: ["npm test"] });
  fs.rmSync(repo, { recursive: true, force: true });
});
