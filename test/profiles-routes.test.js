"use strict";
// Phase 2 re-run (card 4a75de): the three launch routes phase-2.md listed as "covered by the same gate call but not each driven by a
// test": continuing in the Claude panel, opening Codex's editor, and a follow-up typed into a live terminal. In its own file so it does
// not clash with the cards editing profiles.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const P = require("../out/profiles.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-profile-routes-"));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test("Board: a strict card is refused on panel continuation, Codex's editor and a live-terminal follow-up before any effect (AC-A)", async () => {
  class EventEmitter { listeners = []; event = (l) => (this.listeners.push(l), { dispose() {} }); fire(e) { for (const l of this.listeners) l(e); } dispose() {} }
  const effects = [], terminals = [];
  const vscode = { EventEmitter, ThemeIcon: class {}, Uri: { from: (p) => p }, commands: { executeCommand: async (...a) => { effects.push(a); } },
    workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
    window: { terminals, onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined, createTerminal: () => { effects.push("terminal"); throw new Error("no terminal"); } } };
  const home = fs.mkdtempSync(path.join(scratch, "home-")), env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
  let board;
  try {
    const { Board } = require("../out/board.js");
    const repo = fs.mkdtempSync(path.join(scratch, "repo-"));
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["commit", "-q", "--allow-empty", "-m", "init"]]) execFileSync("git", args, { cwd: repo });
    const dir = path.join(home, "acct");
    fs.mkdirSync(path.join(dir, "skills", "deep-research"), { recursive: true });
    board = new Board(repo, path.join(repo, "hook.js"));
    board.accountList = () => [{ name: "me@x", configDir: dir }, { name: "Codex", provider: "codex" }];
    const ws = path.join(repo, "workflows", P.PROFILE_FILE);
    const variant = { items: [{ kind: "skill", id: "deep-research" }] };
    const made = P.saveRevision(ws, "workspace", { name: "Research", variants: { claude: variant, codex: variant } });
    const strict = (title, account) => board.add(title, "x", account, undefined, undefined, undefined, undefined, { profile: P.pin({ workspace: ws }, made.ref) });
    const started = (t, id) => board.update(t, { sessionId: id, worktree: repo });
    const refused = (route) => new RegExp(`Capability profile Research r1 \\(workspace:[0-9a-f-]+\\) is blocked on ${route}: .*strict scope is not enabled for ${route}`);

    const panel = strict("Panel", "me@x"); started(panel, "11111111-1111-4111-8111-111111111111");
    await assert.rejects(() => board.openInPanel(panel), refused("claude:panel"));

    const codex = strict("Editor", "Codex"); started(codex, "22222222-2222-4222-8222-222222222222");
    board.update(codex, { codexPanelBridge: true }); // past the "Codex has not reported this conversation" check, so the gate is what refuses
    await assert.rejects(() => board.openInCodex(codex), refused("codex:editor"));

    const typed = [], live = strict("Live", "me@x"); started(live, "33333333-3333-4333-8333-333333333333");
    board.terminals.set(live.id, { name: "live", sendText: (s) => typed.push(s), show() {}, dispose() {} });
    assert.throws(() => board.send(live, "more work"), refused("claude:terminal"));

    // O5: the user's explicit switch. A live session keeps its scope; a stopped card records the choice and the profile it replaced.
    assert.throws(() => board.useProviderDefaults(live), /still running and keeps its scope/);
    const inherits = ["plugin easel@builtin (built-in)", "mcp easel (built-in)", "plugin plugin-authoring@builtin (built-in)", "skill deep-research (user)"];
    assert.deepEqual(board.inheritedBy(panel).items, inherits);
    const hash = panel.profile.snapshot.hash;
    board.update(panel, { checks: { status: "complete", run: "r" }, deliveryReady: true, judgedRevision: "abc" });
    board.useProviderDefaults(panel);
    const after = board.get(panel.id);
    assert.deepEqual([after.checks, after.deliveryReady, after.judgedRevision, after.profileReplaced.inherited], [undefined, undefined, undefined, inherits], "O7: what was checked under the strict profile is stale; what he was shown is kept");
    assert.deepEqual([board.get(panel.id).profile, board.get(panel.id).profileReplaced.ref, board.get(panel.id).profileReplaced.hash, board.profileProblem(board.get(panel.id))], [{ mode: "provider-defaults" }, `${made.ref}@1`, hash, undefined]);
    assert.throws(() => board.useProviderDefaults(board.get(panel.id)), /no strict capability profile/);
    assert.deepEqual(typed, [], "nothing was typed into the live terminal");
    assert.deepEqual(effects, [], "no editor, panel or terminal was opened");
    assert.equal(fs.existsSync(path.join(dir, "settings.json")), false, "nothing was written to the shared account folder");
    const pinned = P.pin({ workspace: ws }, made.ref).snapshot.hash;
    for (const t of [codex, live]) assert.equal(board.get(t.id).profile.snapshot.hash, pinned, `${t.title}: snapshot kept, not converted to Provider defaults`);

    // The Claude terminal probe can check an empty manifest locally, so the switch reaches the target preflight.
    const grokDir = path.join(home, "managed");
    fs.mkdirSync(grokDir);
    fs.writeFileSync(path.join(grokDir, "config.toml"), "[mcp_servers.chosen]\nenabled = true");
    board.accountList = () => [{ name: "default Claude", configDir: "" }, { name: "managed Grok", provider: "grok", configDir: grokDir }];
    const empty = P.saveRevision(ws, "workspace", { name: "Empty", variants: { claude: { items: [] }, grok: { items: [] } } });
    const source = board.add("Switch", "x", "default Claude", undefined, undefined, undefined, undefined, { profile: P.pin({ workspace: ws }, empty.ref) });
    assert.deepEqual(board.inheritedBy(source).items, inherits.filter((item) => !item.startsWith("skill ")));
    board.strictProbe = true;
    assert.equal(board.profileProblem(source), undefined);
    assert.throws(() => board.switchAccount(source, "managed Grok"), /blocked on grok:in-card: .*mcp chosen \(user\)/);
    assert.equal(source.account, "default Claude");
  } finally {
    board?.dispose();
    Module._load = load;
    Object.assign(process.env, env);
  }
});

// ---- plan docs/plans/2026-11-17-strict-profile-faults-plan.md, steps 1 and 2 ----

test("resolver: a proven route supports only what its recipe can load, on the OS and CLI release it was proven with (AC-A)", () => {
  const snap = (items) => { const s = { id: "workspace:x", revision: 1, name: "S", variants: { claude: { items } } }; return { mode: "strict", pinnedAt: "t", snapshot: { ...s, hash: P.revisionHash(s) } }; };
  const found = (kind, id) => ({ kind, id, source: "user", enabled: true });
  const inventory = { items: [found("mcp", "web"), found("skill", "notes"), found("mcp", "other")], unknown: ["Claude's built-in tools"] };
  const routes = { "claude:terminal": { kinds: ["mcp"], platforms: ["linux"], version: "2.1.327" } };
  const at = (items, over = {}) => P.resolve(snap(items), { provider: "claude", mode: "terminal", inventory, credential: () => true, routes, platform: "linux", version: () => "2.1.340", ...over });
  const codes = (r) => r.reasons.map((x) => x.code);
  assert.deepEqual(P.STRICT_ROUTES, {}, "nothing is proven in the shipped table");
  const one = at([{ kind: "mcp", id: "web" }]);
  assert.deepEqual([one.state, one.manifest.map((m) => m.id), one.reasons], ["supported", ["web"], []], "a patch release of the proven CLI, same OS, MCP only");
  assert.equal(at([]).state, "supported", "none is deliverable too");
  assert.deepEqual(codes(at([{ kind: "mcp", id: "web" }, { kind: "skill", id: "notes" }])), ["unenforceable"]);
  assert.match(at([{ kind: "skill", id: "notes" }]).reasons[0].text, /claude:terminal can enforce only mcp selections; skill notes cannot be loaded alone there/);
  assert.deepEqual(codes(at([], { version: () => "2.2.0" })), ["version-unverified"]);
  assert.match(at([], { version: () => undefined }).reasons[0].text, /proven on claude 2\.1\.327; this machine runs a version Entomatical could not read/);
  const win = at([{ kind: "mcp", id: "web" }], { platform: "win32" });
  assert.deepEqual(codes(win), ["route-unverified", "inherited-extras", "inventory-unknown"], "a Linux proof enables nothing on Windows");
  assert.match(win.reasons[0].text, /on win32: it is proven on linux only/);
  assert.ok(codes(at([], { mode: "panel" })).includes("route-unverified"), "another route of the same provider stays blocked");
});

test("Claude inventory: the CLI's built-in plugins and the Chrome server are listed as inherited; a settings switch turns a built-in off", () => {
  const root = fs.mkdtempSync(path.join(scratch, "builtin-")), dir = path.join(root, "acct"), cwd = path.join(root, "wt");
  const put = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };
  const builtins = () => P.claudeInventory(dir, cwd).items.filter((f) => f.source === "built-in").map((f) => `${f.kind} ${f.id} ${f.enabled}`);
  put(path.join(dir, ".claude.json"), {});
  assert.deepEqual(builtins(), ["plugin easel@builtin true", "mcp easel true", "plugin plugin-authoring@builtin true"]);
  put(path.join(dir, ".claude.json"), { claudeInChromeDefaultEnabled: true });
  put(path.join(dir, "settings.json"), { enabledPlugins: { "easel@builtin": false } });
  assert.deepEqual(builtins(), ["plugin easel@builtin false", "mcp easel false", "plugin plugin-authoring@builtin true", "mcp claude-in-chrome true"]);
  assert.ok(P.claudeInventory(dir, cwd).unknown.includes("skills bundled with the CLI"), "bundled skills stay unknown, never empty");
});
