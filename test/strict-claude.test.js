// Strict-route launch recipe and offline transcript verifier. These fixtures exercise the recorded format.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { strictClaude } = require("../out/strict-claude.js");
const { claudeInventory } = require("../out/profiles.js");
const { seen, judge } = require("../tools/strict-probe-check.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-strict-"));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };

function setup() {
  const dir = path.join(scratch, "acct"), cwd = path.join(scratch, "wt"), plug = path.join(scratch, "plug");
  write(path.join(dir, "settings.json"), { enabledPlugins: { "p@m": true, "off@m": false } });
  write(path.join(dir, "plugins", "installed_plugins.json"), { version: 2, plugins: { "p@m": [{ scope: "user", installPath: plug }], "off@m": [{ scope: "user", installPath: plug }] } });
  write(path.join(dir, ".claude.json"), { mcpServers: { user1: { command: "u" } }, projects: { [cwd]: { mcpServers: { keep: { command: "local-wins" } } } } });
  write(path.join(cwd, ".mcp.json"), { mcpServers: { keep: { command: "project" }, drop: { command: "d" } } });
  return { dir, cwd };
}

test("strict-claude: an MCP-only manifest gets the three flags, only its servers' definitions and every plugin off", () => {
  const { dir, cwd } = setup();
  const r = strictClaude([{ kind: "mcp", id: "keep" }, { kind: "mcp", id: "user1" }], claudeInventory(dir, cwd), dir, cwd, "/x/c.mcp.json");
  assert.deepEqual(r.args, ["--strict-mcp-config", "--mcp-config", "/x/c.mcp.json", "--disable-slash-commands", "--no-chrome"]);
  assert.deepEqual(r.mcpConfig, { mcpServers: { keep: { command: "local-wins" }, user1: { command: "u" } } }); // local scope beats .mcp.json
  assert.deepEqual(r.enabledPlugins, { "p@m": false, "off@m": false, "easel@builtin": false, "plugin-authoring@builtin": false });
  assert.deepEqual(strictClaude([], claudeInventory(dir, cwd), dir, cwd, "/x/c.mcp.json").mcpConfig, { mcpServers: {} }); // O1: empty means none
});

test("strict-claude: a skill, a plugin or an undefined server is refused with the reason", () => {
  const { dir, cwd } = setup(), inv = claudeInventory(dir, cwd);
  assert.match(strictClaude([{ kind: "skill", id: "s" }], inv, dir, cwd, "f"), /enforces only MCP servers; skill s/);
  assert.match(strictClaude([{ kind: "plugin", id: "p@m" }], inv, dir, cwd, "f"), /plugin p@m/);
  assert.match(strictClaude([{ kind: "mcp", id: "nope" }], inv, dir, cwd, "f"), /MCP server nope has no definition/);
});

const probe = path.join(__dirname, "..", "tools", "strict-probe-check.js");
const sessionId = "38730c66-aba2-4937-8961-d6da3d3aecfc";
const otherSession = "67517c00-4af6-4fac-8dc5-f615ab0964a2";
const attachment = (type, fields) => ({ type: "attachment", attachment: { type, ...fields } });
const user = { type: "user", message: { role: "user", content: "Hello" } };
const assistant = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } };
const agents = attachment("agent_listing_delta", { isInitial: true, addedTypes: ["Explore"] });
const tools = (addedNames, fields) => attachment("deferred_tools_delta", { addedNames, ...fields });

function chain(...rows) {
  const ids = rows.map(() => require("node:crypto").randomUUID());
  return rows.map((row, i) => ({ sessionId, isSidechain: false, uuid: ids[i], parentUuid: i ? ids[i - 1] : null, ...row }));
}

function checkProbe(label, rows, allow, verdict) {
  const file = path.join(scratch, "probe.jsonl");
  fs.writeFileSync(file, rows.map(row => typeof row === "string" ? row : JSON.stringify(row)).join("\n"));
  const s = seen(file);
  const problems = judge(s, allow);
  if (verdict === "PASS") assert.deepEqual(problems, [], label);
  else {
    assert.ok(problems.length, label);
    assert.equal(problems.some(p => p.startsWith("INCONCLUSIVE:")), verdict === "INCONCLUSIVE", label);
  }
  const r = require("node:child_process").spawnSync(process.execPath, [probe, file, "--allow", allow.join(",")], { encoding: "utf8" });
  assert.equal(r.status, verdict === "PASS" ? 0 : 1, label + " " + r.stderr);
  assert.ok(r.stdout.trimEnd().split("\n").at(-1).startsWith(verdict + ":"), label + " " + r.stdout);
  const report = JSON.parse(r.stdout.slice(0, r.stdout.lastIndexOf("\n" + verdict)));
  return { s, problems, report };
}

test("strict probe API and CLI require a session's initial listing", () => {
  const empty = chain(user, tools([]), agents, assistant);
  assert.match(judge({ skills: [], agents: [], hooks: [], mcpServers: [] }, [])[0], /^INCONCLUSIVE:/);
  checkProbe("explicit empty list", [{ type: "file-history-snapshot" }, ...empty], [], "PASS");
  checkProbe("allowed server", chain(user, tools(["Read", "mcp__keep__ping"]), agents, assistant), ["keep"], "PASS");
  for (const [label, rows] of [
    ["empty", []], ["junk", ["not json"]], ["unrecognized", [{ unrelated: [] }]],
    ["delta only", [tools([])]], ["session-tagged deltas only", chain(tools([]), agents)],
    ["missing session", empty.map(({ sessionId, ...row }) => row)],
    ["mixed sessions", empty.map((row, i) => i === 1 ? { ...row, sessionId: otherSession } : row)],
    ["foreign session metadata", [{ type: "ai-title", sessionId: otherSession }, ...empty]],
    ["overlapping sessions", [...empty, ...empty]],
    ["compacted root", chain({ ...user, isCompactSummary: true }, tools([]), agents, assistant)],
    ["foreign format in transcript", [...empty, { type: "event_msg", payload: {} }]],
    ["orphaned first record", empty.slice(1)], ["missing middle record", chain(user, tools([]), attachment("skill_listing", { names: ["hidden"] }), agents, assistant).filter((_, i) => i !== 2)],
    ["sidechain", empty.map(row => ({ ...row, isSidechain: true }))],
    ["later listing", chain(user, assistant, tools([]), agents)],
    ["no agent listing", chain(user, tools([]), assistant)],
    ["later agent delta", chain(user, tools([]), attachment("agent_listing_delta", { isInitial: false, addedTypes: ["Explore"] }), assistant)],
    ["no tool listing", chain(user, agents, assistant)],
    ["no end of initial turn", empty.slice(0, -1)],
    ["malformed line in session", [...empty, "{"]],
    ["missing tool names", chain(user, tools(undefined), agents, assistant)],
    ["wrong tool name type", chain(user, tools(""), agents, assistant)],
    ["malformed MCP tool", chain(user, tools(["mcp__keep__"]), agents, assistant)],
    ["malformed agent list", chain(user, tools([]), attachment("agent_listing_delta", { isInitial: true }), assistant)],
    ["malformed skills", chain(user, tools([]), agents, attachment("skill_listing", {}), assistant)],
    ["malformed failed server", chain(user, tools([], { failedMcpServers: [{}] }), agents, assistant)],
  ]) checkProbe(label, rows, [], "INCONCLUSIVE");
});

test("strict probe API and CLI distinguish declarations, attachment status and forbidden capabilities", () => {
  const rows = chain(user, tools(["mcp__keep__ping"], {
    failedMcpServers: [{ name: "broken" }], pendingMcpServers: ["waiting"], needsAuthMcpServers: ["locked"],
  }), attachment("mcp_instructions_delta", { addedNames: ["drop"] }),
  attachment("skill_listing", { isInitial: true, names: ["probe-skill"] }),
  attachment("agent_listing_delta", { isInitial: true, addedTypes: ["Explore", "plugin:agent"] }),
  attachment("hook_success", { hookEvent: "SessionStart", command: "node /home/u/.claude/plugins/cache/x/hook.js" }), assistant);
  const { report, problems } = checkProbe("forbidden attachments", rows, ["keep"], "FAIL");
  assert.deepEqual(report.mcpServers, ["drop", "keep"]);
  assert.deepEqual(report.failedMcp, ["broken"]);
  assert.deepEqual(report.pendingMcp, ["waiting"]);
  assert.deepEqual(report.needsAuthMcp, ["locked"]);
  for (const expected of ["MCP server drop", "failed MCP server broken", "pending MCP server waiting", "needs-auth MCP server locked",
    "skill probe-skill", "plugin agent plugin:agent", "plugin hook SessionStart: node /home/u/.claude/plugins/cache/x/hook.js"]) assert.ok(problems.includes(expected), expected);
  for (const field of ["failedMcpServers", "pendingMcpServers", "needsAuthMcpServers"]) {
    const onlyStatus = checkProbe(field, chain(user, tools([], { [field]: ["keep"] }), agents, assistant), ["keep"], "FAIL");
    assert.deepEqual(onlyStatus.report.mcpServers, []);
    assert.ok(onlyStatus.problems.includes("selected MCP server keep is missing from the initial listing"));
  }
  checkProbe("later declaration", chain(user, tools([]), agents, assistant, tools(["mcp__keep__ping"])), ["keep"], "FAIL");
  checkProbe("later forbidden server", chain(user, tools([]), agents, assistant, tools(["mcp__drop__ping"])), [], "FAIL");
});

// The panel route: the wrapper adds a strict card's args from <board>/launch/<card>.strict.json, deletes its MCP file when claude ends,
// and refuses to start (exit 1, claude never run) when that file is gone, instead of passing the call through with everything loaded.
test("panel wrapper: a strict card's args are added, its MCP file is deleted after the session, and a missing MCP file refuses the start", () => {
  const { execFileSync, spawnSync } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(scratch, "panel-")), board = path.join(root, "repo", ".entomatical"), wt = path.join(root, "wt");
  fs.mkdirSync(path.join(board, "launch"), { recursive: true }); fs.mkdirSync(path.join(board, "hooks")); fs.mkdirSync(wt);
  const hooks = path.join(board, "hooks", "c1.json"), mcp = path.join(board, "launch", "c1.mcp.json"), sid = "0b6f0a51-8c2e-4d6a-9f00-0000000000aa";
  fs.writeFileSync(hooks, "{}");
  fs.writeFileSync(path.join(board, "launch", `${sid}.txt`), [wt, "", hooks].join("\r\n"));
  const extra = ["--strict-mcp-config", "--mcp-config", mcp, "--disable-slash-commands", "--no-chrome"];
  fs.writeFileSync(path.join(board, "launch", "c1.strict.json"), JSON.stringify({ args: extra }));
  const seen = path.join(root, "saw.json"), claude = path.join(root, "fake-claude.js");
  fs.writeFileSync(claude, `require("fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args: process.argv.slice(2), mcp: require("fs").existsSync(${JSON.stringify(mcp)}) }));`);
  const wrapper = path.join(__dirname, "..", "wrapper", "entomatical-claude.js");
  const argv = [wrapper, process.execPath, claude, "--output-format", "stream-json", "--input-format", "stream-json", `--resume=${sid}`];
  const env = { ...process.env, TMPDIR: root, TEMP: root, TMP: root, CLAUDE_CODE_CONFIG_PROBE: "", ENTOMATICAL_WRAPPED: "2" };
  fs.writeFileSync(mcp, "{}", { mode: 0o600 });
  execFileSync(process.execPath, argv, { cwd: path.join(root, "repo"), input: "", env });
  const saw = JSON.parse(fs.readFileSync(seen, "utf8"));
  assert.deepEqual(saw.args.slice(saw.args.indexOf("--strict-mcp-config"), saw.args.indexOf("--strict-mcp-config") + extra.length), extra);
  assert.equal(saw.mcp, true, "the MCP file is there while claude runs");
  assert.equal(fs.existsSync(mcp), false, "and gone once it has ended");
  fs.rmSync(seen);
  const r = spawnSync(process.execPath, argv, { cwd: path.join(root, "repo"), input: "", env, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /strict profile: its MCP file .* is gone/);
  assert.equal(fs.existsSync(seen), false, "claude was not started");
});
