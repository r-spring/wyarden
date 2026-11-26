// Phase 2 of docs/plans/MASTER-PLAN-capability-profiles-and-orchestration.md (AC-A, AC-A2, AC-H): capability profiles with scoped ids,
// immutable revisions and per-provider variants; Claude inventory with plugin bundles; the resolver; pinned snapshots; and the central
// preflight (Board.gate) that refuses a strict profile on every launch route before any worktree, process or shared file is touched.
// No route is enabled for strict scope (STRICT_ROUTES is empty: no recorded decision, no native proof), so every strict run must block.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const P = require("../out/profiles.js");

/** Every file under a folder with its size and modification time, to show that nothing there was written. Windows has no Unix find, so it walks the folder. */
const listing = (dir) => process.platform === "win32"
  ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => { const f = path.join(e.parentPath ?? e.path, e.name), s = fs.statSync(f); return `${f} ${s.size} ${s.mtimeMs}`; }).sort().join("\n")
  : execFileSync("find", [dir, "-type", "f", "-printf", "%p %s %T@\n"], { encoding: "utf8" });

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-profiles-"));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = () => { const d = path.join(scratch, `d${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v)); };

/** A Claude account folder and worktree with one plugin bundle (two skills, one MCP server), a user skill and user/project MCP servers. */
function claudeSetup() {
  const root = fresh(), dir = path.join(root, "acct"), cwd = path.join(root, "wt"), plug = path.join(root, "cache", "tester", "1.2.0");
  write(path.join(dir, "settings.json"), { enabledPlugins: { "tester@market": true, "off@market": false } });
  write(path.join(dir, "plugins", "installed_plugins.json"), { version: 2, plugins: {
    "tester@market": [{ scope: "user", installPath: plug, version: "1.2.0" }],
    "off@market": [{ scope: "user", installPath: path.join(root, "cache", "off"), version: "0.1" }] } });
  for (const s of ["run-tests", "lint"]) fs.mkdirSync(path.join(plug, "skills", s), { recursive: true });
  write(path.join(plug, ".mcp.json"), { mcpServers: { "test-db": { command: "x" } } });
  fs.mkdirSync(path.join(root, "cache", "off", "skills", "quiet"), { recursive: true });
  fs.mkdirSync(path.join(dir, "skills", "deep-research"), { recursive: true });
  write(path.join(dir, ".claude.json"), { mcpServers: { "user-web": {} }, projects: { [cwd]: { mcpServers: { "local-notes": {} } } } });
  write(path.join(cwd, ".mcp.json"), { mcpServers: { "project-db": {} } });
  return { dir, cwd };
}
const VARIANT = (items, credentials) => ({ items, ...(credentials ? { credentials } : {}) });
const ctx = (inv, over = {}) => ({ provider: "claude", mode: "terminal", inventory: inv, credential: () => true, ...over });
const codes = (r) => r.reasons.map((x) => x.code);

// ---- store: scoped ids, immutable revisions, no credential material ----

test("profiles: new revisions keep earlier ones byte for byte; workspace and personal names never shadow each other (AC-A2)", () => {
  const d = fresh(), ws = path.join(d, "workflows", P.PROFILE_FILE), me = path.join(d, "global", P.PROFILE_FILE);
  const a = P.saveRevision(ws, "workspace", { name: "Coordinator", variants: { claude: VARIANT([{ kind: "skill", id: "deep-research" }]) } });
  assert.match(a.ref, /^workspace:[0-9a-f-]{36}$/);
  const r1 = JSON.stringify(P.readProfiles(ws)[0].revisions[0]);
  const b = P.saveRevision(ws, "workspace", { name: "Coordinator", variants: { claude: VARIANT([{ kind: "plugin", id: "tester@market" }]) } }, a.ref);
  assert.deepEqual([b.ref, b.revision], [a.ref, 2]);
  const revs = P.readProfiles(ws)[0].revisions;
  assert.equal(JSON.stringify(revs[0]), r1, "revision 1 unchanged");
  assert.equal(revs[1].hash, P.revisionHash(revs[1]));
  const c = P.saveRevision(me, "personal", { name: "Coordinator", variants: {} });
  const cat = P.catalog({ workspace: ws, personal: me });
  assert.deepEqual(cat.entries.map((e) => [e.ref, e.scope, e.name, e.revision]), [[a.ref, "workspace", "Coordinator", 2], [c.ref, "personal", "Coordinator", 1]]);
  assert.throws(() => P.saveRevision(ws, "workspace", { name: "x", variants: {} }, c.ref), /is not a workspace profile/);
});

test("profiles: secrets, server definitions, unknown versions and in-place edits are refused (AC-A2)", () => {
  const d = fresh(), f = path.join(d, "p.json"), id = "0b4a9a6e-6f3c-4c7e-9d7c-2b1f0f8e5a11";
  const doc = (variant, extra = {}) => ({ version: 1, profiles: [{ id, revisions: [{ revision: 1, name: "X", variants: { claude: variant }, ...extra }] }] });
  write(f, doc({ items: [{ kind: "mcp", id: "db", env: { TOKEN: "abc" } }] }));
  assert.throws(() => P.readProfiles(f), /fields a profile cannot hold: env/);
  write(f, doc({ items: [], credentials: ["sk-live-123456"] }));
  assert.throws(() => P.readProfiles(f), /references like account:<name> or env:<VARIABLE>, never a secret/);
  for (const bad of ["account:sk-ant-api03-abcdef", "env:ghp_abcdefghijklmnop", "env:lower_case", "account:eyJhbGciOiJIUzI1NiJ9", `account:${"a1B2".repeat(10)}`]) {
    write(f, doc({ items: [], credentials: [bad] }));
    assert.throws(() => P.readProfiles(f), /never a secret/, bad);
  }
  // Only env: and account: are looked up; any other store is refused by name, without echoing the value.
  for (const [other, store] of [["keychain:github", "keychain:"], ["vault:kv/github", "vault:"], ["op://Private/GitHub/token", "op:"]]) {
    write(f, doc({ items: [], credentials: [other] }));
    assert.throws(() => P.readProfiles(f), (e) => e.message.endsWith(`never a secret; ${store} references are not supported`) && !e.message.includes(other), other);
  }
  write(f, doc({ items: [], credentials: "env:GITHUB_TOKEN" }));
  assert.throws(() => P.readProfiles(f), /never a secret$/, "a single string is not a list of references");
  write(f, doc({ items: [], credentials: ["account:me@x.com", "env:GITHUB_TOKEN"] }));
  assert.equal(P.readProfiles(f).length, 1, "plain references are fine");
  assert.throws(() => P.saveRevision(f, "workspace", { name: "Y", variants: {}, revision: 9 }), /cannot hold: revision/);
  assert.throws(() => P.saveRevision(f, "workspace", { name: "Y", variants: { claude: { items: [], env: {} } } }), /cannot hold: env/);
  const locked = path.join(d, "dir.json"); fs.mkdirSync(locked);
  assert.throws(() => P.saveRevision(locked, "workspace", { name: "Y", variants: {} }), /EISDIR/, "a file that cannot be read is not treated as empty and overwritten");
  write(f, doc({ items: [], apiKey: "x" }));
  assert.throws(() => P.readProfiles(f), /cannot hold: apiKey/);
  write(f, { version: 2, profiles: [] });
  assert.throws(() => P.readProfiles(f), /version 2, which this Entomatical cannot read/);
  assert.deepEqual(P.catalog({ workspace: f }).entries, []);
  assert.match(P.catalog({ workspace: f }).errors[0], /^workspace profiles: .*version 2/);
  // Edited in place after it was saved: the stored hash no longer matches, so it cannot be pinned.
  write(f, doc({ items: [{ kind: "skill", id: "a" }] }, { hash: "0".repeat(64) }));
  assert.equal(P.catalog({ workspace: f }).entries[0].altered, true);
  assert.throws(() => P.pin({ workspace: f }, `workspace:${id}`), /edited in place; save a new revision/);
  assert.equal(P.readProfiles(path.join(d, "missing.json")).length, 0);
});

test("pin: the task keeps a copy; editing, archiving or deleting the profile never changes it, and archived ones cannot be picked anew (AC-A2)", () => {
  const d = fresh(), ws = path.join(d, P.PROFILE_FILE), files = { workspace: ws };
  const { ref } = P.saveRevision(ws, "workspace", { name: "Tests", variants: { claude: VARIANT([{ kind: "plugin", id: "tester@market" }], ["account:me@x"]) } });
  const sel = P.pin(files, ref, new Date("2026-11-16T12:00:00Z"));
  const before = JSON.stringify(sel);
  assert.deepEqual([sel.mode, sel.snapshot.id, sel.snapshot.revision, sel.pinnedAt], ["strict", ref, 1, "2026-11-16T12:00:00.000Z"]);
  P.saveRevision(ws, "workspace", { name: "Tests v2", variants: { claude: VARIANT([]) } }, ref);
  const doc = JSON.parse(fs.readFileSync(ws, "utf8")); doc.profiles[0].archived = true; write(ws, doc);
  assert.throws(() => P.pin(files, ref), /archived; existing tasks keep it/);
  fs.rmSync(ws);
  assert.throws(() => P.pin(files, ref), /no longer exists/);
  assert.equal(JSON.stringify(sel), before);
  assert.doesNotMatch(before, /sk-|token|password/i, "a snapshot holds references only");
});

// ---- inventory and resolver ----

test("Claude inventory: plugins expand to the skills and MCP servers they bring; user, local and project sources are listed; nothing is written", () => {
  const { dir, cwd } = claudeSetup();
  const stamp = () => listing(path.dirname(dir));
  const was = stamp();
  const inv = P.claudeInventory(dir, cwd);
  const ids = inv.items.filter((f) => f.source !== "built-in").map((f) => `${f.kind}:${f.id}:${f.source}:${f.enabled}${f.via ? `:${f.via}` : ""}`).sort();
  assert.deepEqual(ids, ["mcp:local-notes:local:true", "mcp:project-db:project:true", "mcp:test-db:plugin:true:tester@market", "mcp:user-web:user:true",
    "plugin:off@market:plugin (user):false", "plugin:tester@market:plugin (user):true", "skill:deep-research:user:true", "skill:off:quiet:plugin:false:off@market",
    "skill:tester:lint:plugin:true:tester@market", "skill:tester:run-tests:plugin:true:tester@market"]);
  assert.ok(inv.unknown.includes("Claude's built-in tools"), "what it cannot see is unknown, not empty");
  assert.equal(stamp(), was);
  assert.ok(!P.inventory("codex", "", cwd).unknown.some((u) => /does not read/.test(u)), "Codex's inventory is read now");
});

test("parseToml reads the config.toml tables the inventories need: quoted headers, booleans, strings, multi-line arrays, comments", () => {
  const t = P.parseToml(['model = "gpt" # note', '[plugins."a@m"]', "enabled = true", "[mcp_servers.node_repl]", 'command = "/x#y"', "enabled = false",
    '[projects."/home/r/Dev Stuff/x"]', "trust_level = 'trusted'", "[plugins]", "enabled = [", '  "one",', "  'two' ]", "[[marketplace.sources]]", "n = 3"].join("\n"));
  const get = (...k) => t.get(k.join("\u0001"));
  assert.equal(get("").model, "gpt");
  assert.equal(get("plugins", "a@m").enabled, true);
  assert.deepEqual(get("mcp_servers", "node_repl"), { command: "/x#y", enabled: false });
  assert.equal(get("projects", "/home/r/Dev Stuff/x").trust_level, "trusted");
  assert.deepEqual(get("plugins").enabled, ["one", "two"]);
  assert.equal(get("marketplace", "sources").n, 3);
});

/** A Codex home laid out as Codex 0.169 writes it on linux (17 November 2026). */
function codexSetup() {
  const root = fresh(), home = path.join(root, ".codex"), cwd = path.join(root, "wt"), cache = path.join(home, "plugins", "cache");
  write(path.join(home, "config.toml"), ['[projects."' + cwd.replace(/\\/g, "\\\\") + '"]', 'trust_level = "trusted"', '[plugins."docs@runtime"]', "enabled = true",
    '[plugins."tools@bundled"]', "enabled = false", '[plugins."gone@bundled"]', "enabled = true", "[mcp_servers.node_repl]", 'command = "x"', "[mcp_servers.off]", "enabled = false"].join("\n"));
  write(path.join(cache, "runtime", "docs", "1.0.0", ".codex-plugin", "plugin.json"), { name: "docs", version: "1.0.0" });
  write(path.join(cache, "runtime", "docs", "2.0.0", ".codex-plugin", "plugin.json"), { name: "docs", version: "2.0.0" });
  write(path.join(cache, "runtime", "docs", "2.0.0", "skills", "write", "SKILL.md"), "x");
  write(path.join(cache, "bundled", "tools", "9", ".mcp.json"), { mcpServers: { app: { command: "y", enabled: false }, live: { command: "z" } } });
  write(path.join(home, "skills", "mine", "SKILL.md"), "x");
  write(path.join(home, "skills", ".system", "imagegen", "SKILL.md"), "x");
  write(path.join(cwd, ".codex", "config.toml"), "[mcp_servers.repo-db]\ncommand = \"q\"");
  return { home, cwd };
}
const rows = (inv) => inv.items.filter((f) => f.source !== "built-in").map((f) => `${f.kind}:${f.id}:${f.source}:${f.version ?? "-"}:${f.enabled}${f.via ? `:${f.via}` : ""}`).sort();

test("Codex inventory: config.toml plugins (newest cached version, their skills and MCP servers), MCP servers, trusted project servers, user and system skills", () => {
  const { home, cwd } = codexSetup(), inv = P.codexInventory(home, cwd);
  assert.deepEqual(rows(inv), ["mcp:app:plugin:-:false:tools@bundled", "mcp:live:plugin:-:false:tools@bundled", "mcp:node_repl:user:-:true", "mcp:off:user:-:false",
    "mcp:repo-db:project:-:true", "plugin:docs@runtime:plugin (config.toml):2.0.0:true", "plugin:gone@bundled:plugin (config.toml):-:true",
    "plugin:tools@bundled:plugin (config.toml):9:false", "skill:docs:write:plugin:-:true:docs@runtime", "skill:imagegen:system:-:true", "skill:mine:user:-:true"]);
  assert.ok(inv.unknown.some((u) => u.startsWith("what Codex plugin gone@bundled contains")), "a plugin missing from the cache is unknown, not empty");
  assert.ok(inv.unknown.includes("Codex's built-in tools"));
  fs.writeFileSync(path.join(home, "config.toml"), "[plugins\n\u0000");
  fs.chmodSync(path.join(home, "config.toml"), 0o000);
  const locked = P.codexInventory(home, cwd);
  fs.chmodSync(path.join(home, "config.toml"), 0o600);
  if (process.platform !== "win32" && process.getuid?.() !== 0) assert.ok(locked.unknown[0].startsWith(path.join(home, "config.toml")), "an unreadable config.toml is unknown with its reason");
});

test("Grok inventory: user and project MCP servers (project wins), plugins off unless enabled, skills by priority including Claude compatibility, compat switch honoured", () => {
  const root = fresh(), gh = path.join(root, "grokhome"), cwd = path.join(root, "wt"), was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = root;
  try {
    write(path.join(gh, "config.toml"), "[mcp_servers.gh]\ncommand = \"x\"\n[mcp_servers.db]\nenabled = false\n[plugins]\nenabled = [\"team\"]\ndisabled = [\"noisy\"]");
    write(path.join(cwd, ".grok", "config.toml"), "[mcp_servers.db]\ncommand = \"y\"");
    write(path.join(gh, "plugins", "team", "plugin.json"), { version: "0.3" });
    write(path.join(gh, "plugins", "team", "skills", "ship", "SKILL.md"), "x");
    write(path.join(gh, "plugins", "noisy", ".mcp.json"), { mcpServers: { loud: {} } });
    write(path.join(gh, "bundled", "skills", "review", "SKILL.md"), "x");
    fs.mkdirSync(path.join(gh, "bundled", "skills", "shared"), { recursive: true });
    write(path.join(cwd, ".grok", "skills", "review", "SKILL.md"), "x");
    write(path.join(root, ".claude", "skills", "deep-research", "SKILL.md"), "x");
    const inv = P.grokInventory(gh, cwd);
    assert.deepEqual(rows(inv), ["mcp:db:project:-:true", "mcp:gh:user:-:true", "mcp:loud:plugin:-:false:noisy", "plugin:noisy:plugin (user):-:false",
      "plugin:team:plugin (user):0.3:true", "skill:deep-research:claude (user):-:true", "skill:review:project:-:true", "skill:team:ship:plugin:-:true:team"]);
    assert.ok(inv.unknown.includes("Grok's built-in tools"));
    fs.appendFileSync(path.join(gh, "config.toml"), "\n[compat.claude]\nskills = false");
    assert.ok(!P.grokInventory(gh, cwd).items.some((f) => f.id === "deep-research"), "[compat.claude] skills = false stops the Claude skills");
  } finally { Object.assign(process.env, was); }
});

test("Antigravity inventory: plugins switched in config.json with versions, skills and MCP servers; an empty mcp_config.json is none; unswitched plugins are unknown", () => {
  const root = fresh(), g = path.join(root, ".gemini"), cwd = path.join(root, "wt"), was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = root;
  try {
    write(path.join(g, "config", "config.json"), { plugins: { firebase: { enabled: true }, flutter: { enabled: false } } });
    write(path.join(g, "config", "mcp_config.json"), "");
    write(path.join(g, "config", "plugins", "firebase", "installed_version.json"), { version: "1.0.1" });
    write(path.join(g, "config", "plugins", "firebase", "skills", "auth", "SKILL.md"), "x");
    write(path.join(g, "config", "plugins", "firebase", "mcp_config.json"), { mcpServers: { fb: {} } });
    write(path.join(g, "config", "plugins", "flutter", "plugin.json"), { name: "flutter" });
    write(path.join(g, "config", "plugins", "image-director", "plugin.json"), { name: "image-director" });
    write(path.join(g, "antigravity-cli", "builtin", "skills", "agy-customizations", "SKILL.md"), "x");
    write(path.join(cwd, ".agents", "skills", "local", "SKILL.md"), "x");
    let inv = P.antigravityInventory(cwd);
    assert.deepEqual(rows(inv), ["mcp:fb:plugin:-:true:firebase", "plugin:firebase:plugin (user):1.0.1:true", "plugin:flutter:plugin (user):-:false",
      "plugin:image-director:plugin (user):-:false", "skill:agy-customizations:builtin:-:true", "skill:firebase:auth:plugin:-:true:firebase", "skill:local:project:-:true"]);
    assert.equal(inv.unknown[0], "whether plugins config.json does not switch load (image-director)");
    write(path.join(g, "config", "mcp_config.json"), "{ not json");
    inv = P.antigravityInventory(cwd);
    assert.ok(inv.unknown[0].startsWith(path.join(g, "config", "mcp_config.json")), "a damaged mcp_config.json is unknown with its reason, never empty");
  } finally { Object.assign(process.env, was); }
});

test("resolver: Provider defaults lists what is inherited; strict never broadens and blocks on every unverified route (AC-A)", () => {
  const { dir, cwd } = claudeSetup(), inv = P.claudeInventory(dir, cwd);
  const pd = P.resolve({ mode: "provider-defaults" }, ctx(inv));
  assert.equal(pd.state, "provider-defaults");
  assert.deepEqual(pd.inherited.filter((f) => f.source !== "built-in").map((f) => f.id).sort(), ["deep-research", "local-notes", "project-db", "test-db", "tester:lint", "tester:run-tests", "tester@market", "user-web"]);
  assert.equal(P.resolve(undefined, ctx(inv)).state, "provider-defaults", "an older card without a profile is Provider defaults, never strict none");
  const snap = (variants) => { const s = { id: "workspace:x", revision: 1, name: "S", variants }; return { mode: "strict", pinnedAt: "t", snapshot: { ...s, hash: P.revisionHash(s) } }; };
  // A whole plugin: its skills and server join the manifest; the inheritance leak (user and project extras) is named; the route is unverified.
  const bundle = P.resolve(snap({ claude: VARIANT([{ kind: "plugin", id: "tester@market", version: "1.2.0" }]) }), ctx(inv));
  assert.equal(bundle.state, "blocked");
  assert.deepEqual(bundle.manifest.map((f) => f.id).sort(), ["test-db", "tester:lint", "tester:run-tests", "tester@market"]);
  assert.deepEqual(codes(bundle), ["route-unverified", "inherited-extras", "inventory-unknown"]);
  // F110 finding F2: the line names the first three and counts the rest; items keep the whole list for the form's Show all.
  // Built-in plugins and servers of this machine are inherited too (listed first), so only the configured extras are fixed here.
  const extras = bundle.reasons[1].items;
  assert.deepEqual(extras.filter((x) => !x.endsWith("(built-in)")), ["skill deep-research (user)", "mcp user-web (user)", "mcp local-notes (local)", "mcp project-db (project)"]);
  assert.equal(bundle.reasons[1].text, `would also inherit ${extras.length} it does not list: ${extras.slice(0, 3).join(", ")} and ${extras.length - 3} more`);
  assert.deepEqual(bundle.reasons[2].items, inv.unknown);
  assert.match(bundle.reasons[2].text, new RegExp(`^cannot see ${inv.unknown.slice(0, 3).join(", ").replace(/[().]/g, "\\$&")} and ${inv.unknown.length - 3} more$`));
  assert.equal(bundle.reasons[0].items, undefined, "a reason without a long list carries no items");
  for (const mode of ["terminal", "panel", "editor", "in-card", "headless"]) for (const provider of P.PROVIDERS) {
    const r = P.resolve(snap({ [provider]: VARIANT([{ kind: "plugin", id: "tester@market" }]) }), ctx(inv, { provider, mode }));
    assert.equal(r.state, "blocked", `${provider}:${mode}`);
    assert.ok(codes(r).includes("route-unverified"), `${provider}:${mode} is blocked by the route itself`);
  }
  assert.deepEqual(P.STRICT_ROUTES, {});
  // One skill of a plugin alone, an unavailable server, a drifted version, a missing credential, no variant, an empty strict list, a forged snapshot.
  assert.ok(codes(P.resolve(snap({ claude: VARIANT([{ kind: "skill", id: "tester:lint" }]) }), ctx(inv))).includes("partial-bundle"));
  assert.ok(codes(P.resolve(snap({ claude: VARIANT([{ kind: "mcp", id: "absent" }]) }), ctx(inv))).includes("unavailable"));
  assert.ok(codes(P.resolve(snap({ claude: VARIANT([{ kind: "plugin", id: "tester@market", version: "1.1.0" }]) }), ctx(inv))).includes("drift"));
  assert.ok(codes(P.resolve(snap({ claude: VARIANT([{ kind: "skill", id: "deep-research" }], ["env:AB_NOT_SET"]) }), ctx(inv, { credential: () => false }))).includes("missing-credential"));
  assert.ok(codes(P.resolve(snap({ codex: VARIANT([{ kind: "skill", id: "x" }]) }), ctx(inv))).includes("no-variant"));
  const none = P.resolve(snap({ claude: VARIANT([]) }), ctx(inv));
  assert.deepEqual([codes(none).includes("empty-undecided"), none.manifest, none.state], [false, [], "blocked"], "O1 decided: empty means none; still blocked while no route is enabled");
  const forged = snap({ claude: VARIANT([{ kind: "skill", id: "deep-research" }]) }); forged.snapshot.variants.claude.items.push({ kind: "mcp", id: "user-web" });
  assert.ok(codes(P.resolve(forged, ctx(inv))).includes("altered"));
});

// ---- gap closure, phase 2 review items (docs/evidence/capability-profiles-gap-closure/e13710.md) ----

const strict = (variants) => { const s = { id: "workspace:x", revision: 1, name: "S", variants }; return { mode: "strict", pinnedAt: "t", snapshot: { ...s, hash: P.revisionHash(s) } }; };

test("resolver: a plugin that is installed but disabled, or one of its skills, is not available and stays out of the manifest", () => {
  const { dir, cwd } = claudeSetup(), inv = P.claudeInventory(dir, cwd);
  for (const items of [[{ kind: "plugin", id: "off@market" }], [{ kind: "plugin", id: "off@market" }, { kind: "skill", id: "off:quiet" }]]) {
    const r = P.resolve(strict({ claude: VARIANT(items) }), ctx(inv));
    assert.deepEqual(r.reasons.filter((x) => x.code === "disabled").map((x) => x.text), items.map((it) => `${it.kind} ${it.id} is installed but disabled for this account and worktree (enabledPlugins)`));
    assert.ok(!codes(r).includes("unavailable"));
    assert.deepEqual(r.manifest, [], "a disabled plugin brings nothing into the manifest");
  }
  assert.ok(!codes(P.resolve(strict({ claude: VARIANT([{ kind: "plugin", id: "tester@market" }]) }), ctx(inv))).includes("disabled"));
});

test("Claude inventory: a plugin installed with scope local for this worktree wins over its user copy; plugin.json MCP paths, inline servers and arrays are read; MCPB and unreadable paths are unknown", () => {
  const root = fresh(), dir = path.join(root, "acct"), cwd = path.join(root, "wt"), other = path.join(root, "other");
  const userCopy = path.join(root, "cache", "loc", "1.0"), localCopy = path.join(root, "cache", "loc", "2.0"), strCopy = path.join(root, "cache", "str"), elsewhere = path.join(root, "cache", "elsewhere");
  write(path.join(dir, "settings.json"), { enabledPlugins: { "str@market": true } });
  write(path.join(cwd, ".claude", "settings.local.json"), { enabledPlugins: { "loc@market": true, "elsewhere@market": true } });
  write(path.join(dir, "plugins", "installed_plugins.json"), { version: 2, plugins: {
    "loc@market": [{ scope: "user", installPath: userCopy, version: "1.0" }, { scope: "local", projectPath: other, installPath: userCopy, version: "1.0" }, { scope: "local", projectPath: cwd, installPath: localCopy, version: "2.0" }],
    "str@market": [{ scope: "user", installPath: strCopy, version: "3.0" }],
    "elsewhere@market": [{ scope: "local", projectPath: other, installPath: elsewhere, version: "1.0" }] } });
  fs.mkdirSync(path.join(userCopy, "skills", "stale"), { recursive: true });
  fs.mkdirSync(path.join(localCopy, "skills", "fresh"), { recursive: true });
  fs.mkdirSync(path.join(elsewhere, "skills", "not-here"), { recursive: true });
  write(path.join(localCopy, ".claude-plugin", "plugin.json"), { name: "loc", mcpServers: ["./servers.json", { "inline-srv": { command: "x" } }, "./bundle.mcpb", "./gone.json"] });
  write(path.join(localCopy, "servers.json"), { mcpServers: { "file-srv": { command: "x" } } });
  write(path.join(localCopy, ".mcp.json"), { mcpServers: { "dot-srv": { command: "x" } } });
  write(path.join(strCopy, ".claude-plugin", "plugin.json"), { name: "str", mcpServers: "./more.json" });
  write(path.join(strCopy, "more.json"), { "flat-srv": { command: "x" } });
  const inv = P.claudeInventory(dir, cwd);
  const ids = inv.items.filter((f) => f.source !== "built-in").map((f) => `${f.kind}:${f.id}:${f.source}:${f.version ?? ""}:${f.enabled}${f.via ? `:${f.via}` : ""}`).sort();
  assert.deepEqual(ids, ["mcp:dot-srv:plugin::true:loc@market", "mcp:file-srv:plugin::true:loc@market", "mcp:flat-srv:plugin::true:str@market", "mcp:inline-srv:plugin::true:loc@market",
    "plugin:loc@market:plugin (local):2.0:true", "plugin:str@market:plugin (user):3.0:true", "skill:loc:fresh:plugin::true:loc@market"]);
  assert.deepEqual(inv.unknown.filter((u) => u.includes("plugin loc@market")), ["MCP servers of plugin loc@market from ./bundle.mcpb", "MCP servers of plugin loc@market from ./gone.json"]);
});

test("Claude inventory, Windows key forms: .claude.json project keys in the CLI's form (C:/x) and the backslash form both match the worktree (fixtures only; not checked on Windows)", () => {
  const root = fresh(), dir = path.join(root, "acct"), plug = path.join(root, "cache", "win"), wcwd = "C:\\Users\\user\\Dev\\wt";
  write(path.join(dir, "settings.json"), { enabledPlugins: { "win@market": true } });
  write(path.join(dir, "plugins", "installed_plugins.json"), { version: 2, plugins: { "win@market": [{ scope: "local", projectPath: "c:/Users/user/Dev/wt", installPath: plug }] } });
  write(path.join(dir, ".claude.json"), { projects: {
    "C:/Users/user/Dev/wt": { mcpServers: { fwd: {} } }, "c:\\Users\\user\\Dev\\wt\\": { mcpServers: { back: {} } }, "C:/Users/user/Dev/wt2": { mcpServers: { other: {} } } } });
  const inv = P.claudeInventory(dir, wcwd, "win32");
  assert.deepEqual(inv.items.filter((f) => f.source === "local").map((f) => f.id).sort(), ["back", "fwd"]);
  assert.ok(inv.items.some((f) => f.id === "win@market" && f.source === "plugin (local)"));
  for (const [a, b, same] of [["C:/Users/user/wt", "C:\\Users\\user\\wt", true], ["c:\\Users\\user\\wt\\", "C:\\Users\\user\\wt", true], ["C:/users/USER/wt", "C:\\Users\\user\\wt", true], ["C:/Users/user/wt", "C:/Users/user/wt2", false]])
    assert.equal(P.samePath(a, b, "win32"), same, `${a} vs ${b}`);
  assert.equal(P.samePath("/home/r/wt/", "/home/r/wt", "linux"), true);
  assert.equal(P.samePath("/home/r/WT", "/home/r/wt", "linux"), false);
});

test("saveRevision: three processes saving at once lose no revision; a held lock waits, then refuses; a stale lock is taken over", async () => {
  const { spawn } = require("node:child_process");
  const d = fresh(), ws = path.join(d, P.PROFILE_FILE), lock = `${ws}.lock`;
  const { ref } = P.saveRevision(ws, "workspace", { name: "Shared", variants: {} });
  const script = `const P=require(${JSON.stringify(path.resolve(__dirname, "../out/profiles.js"))});for(let i=0;i<25;i++)P.saveRevision(process.argv[1],"workspace",{name:process.argv[2]+i,variants:{}},process.argv[3]);`;
  const run = (k) => new Promise((ok, no) => {
    const c = spawn(process.execPath, ["-e", script, ws, k, ref], { stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; c.stderr.on("data", (b) => { err += b; }); c.on("exit", (code) => code === 0 ? ok() : no(new Error(err)));
  });
  await Promise.all(["a", "b", "c"].map(run));
  const revs = P.readProfiles(ws)[0].revisions;
  assert.deepEqual(revs.map((r) => r.revision), Array.from({ length: 76 }, (_, i) => i + 1));
  for (const k of ["a", "b", "c"]) assert.equal(revs.filter((r) => r.name.startsWith(k)).length, 25, `every save of process ${k} kept`);
  assert.equal(fs.existsSync(lock), false, "the lock is released");
  fs.writeFileSync(lock, "999\n");
  const t0 = Date.now();
  assert.throws(() => P.saveRevision(ws, "workspace", { name: "late", variants: {} }, ref), /being saved by another window/);
  assert.ok(Date.now() - t0 >= 1500, "it waited for the other window first");
  assert.equal(P.readProfiles(ws)[0].revisions.length, 76, "nothing written while locked");
  const old = new Date(Date.now() - 60_000); fs.utimesSync(lock, old, old);
  assert.equal(P.saveRevision(ws, "workspace", { name: "after", variants: {} }, ref).revision, 77, "a lock left by a crashed window is taken over");
  assert.equal(fs.existsSync(lock), false);
});

// ---- the central preflight on a real Board ----

test("Board: two tasks on one account pin different manifests; every launch route refuses before any effect; shared config untouched (AC-A, AC-A2)", async (t) => {
  class EventEmitter { listeners = []; event = (l) => (this.listeners.push(l), { dispose() {} }); fire(e) { for (const l of this.listeners) l(e); } dispose() {} }
  const launched = [];
  const vscode = { EventEmitter, ThemeIcon: class {}, Uri: { from: (p) => p }, commands: { executeCommand: async (...a) => { launched.push(a); } },
    workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
    window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined, createTerminal: () => { launched.push("terminal"); throw new Error("no terminal"); } } };
  const home = fs.mkdtempSync(path.join(scratch, "home-")), env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
  const boards = [];
  try {
    const { Board } = require("../out/board.js");
    const repo = fs.mkdtempSync(path.join(scratch, "repo-"));
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["commit", "-q", "--allow-empty", "-m", "init"]]) execFileSync("git", args, { cwd: repo });
    const { dir } = claudeSetup();
    const board = new Board(repo, path.join(repo, "hook.js")); boards.push(board);
    board.accountList = () => [{ name: "me@x", configDir: dir }];
    const ws = path.join(repo, "workflows", P.PROFILE_FILE), files = { workspace: ws };
    const tests = P.saveRevision(ws, "workspace", { name: "Tests", variants: { claude: VARIANT([{ kind: "plugin", id: "tester@market" }]) } });
    const research = P.saveRevision(ws, "workspace", { name: "Research", variants: { claude: VARIANT([{ kind: "skill", id: "deep-research" }]) } });
    const shared = () => listing(dir);
    const was = shared();
    const a = board.add("A", "Run the tests.", "me@x", undefined, undefined, undefined, undefined, { profile: P.pin(files, tests.ref) });
    const b = board.add("B", "Research it.", "me@x", undefined, undefined, undefined, undefined, { profile: P.pin(files, research.ref) });
    const c = board.add("C", "Ordinary.", "me@x", undefined, undefined, undefined, undefined, { profile: { mode: "provider-defaults" } });
    assert.equal(a.account, b.account);
    assert.notEqual(a.profile.snapshot.hash, b.profile.snapshot.hash, "same account, distinct pinned manifests");
    assert.equal(board.profileProblem(c), undefined, "Provider defaults is its own explicit choice and launches as before");
    assert.equal(board.profileProblem(board.add("D", "Older card.", "me@x")), undefined, "a card without a profile is Provider defaults");
    // Every route the board launches through, each refused with its own exact route named.
    const refuse = async (route, run) => { await assert.rejects(run, new RegExp(`Capability profile (Tests|Research) r1 \\(workspace:[0-9a-f-]+\\) is blocked on ${route}: .*strict scope is not enabled for ${route}`), route); };
    const strict = (title, step = {}, account = "me@x") => board.add(title, "x", account, undefined, undefined, undefined, undefined, { profile: P.pin(files, tests.ref), ...step });
    await refuse("claude:terminal", () => board.start(a));
    await refuse("claude:panel", () => board.startInPanel(b));
    const h = strict("H", { headless: true }), i = strict("I", { cardTerminal: true });
    await refuse("claude:headless", () => board.startHeadless(h));
    await refuse("claude:in-card", () => board.start(i));
    board.accountList = () => [{ name: "me@x", configDir: dir }, { name: "Codex", provider: "codex" }, { name: "grok: g", provider: "grok", configDir: path.join(home, ".grok") }];
    const cx = strict("X", {}, "Codex"), gk = strict("G", {}, "grok: g"), gh = strict("GH", { headless: true }, "grok: g");
    await refuse(`codex:${board.codexEditor() ? "editor" : "terminal"}`, () => board.start(cx));
    await refuse("grok:in-card", () => board.startCardTerminal(gk));
    await refuse("grok:headless", () => board.start(gh));
    board.accountList = () => [{ name: "me@x", configDir: dir }];
    for (const t of [a, b, h, i, cx, gk, gh]) assert.deepEqual([t.sessionId, t.worktree, t.status], [undefined, undefined, "queued"], `${t.title}: nothing started, no worktree made`);
    // An unreadable selection (a newer build's mode, a damaged snapshot) is refused, never run as Provider defaults.
    assert.match(board.profileProblem({ ...c, profile: { mode: "strict-v2" } }), /capability profile is unreadable \(profile has fields a profile cannot hold|unknown mode/);
    assert.match(board.profileProblem({ ...c, profile: { mode: "strict", pinnedAt: "t", snapshot: { id: "workspace:x", revision: 1, hash: "h", name: "S", variants: { claude: { items: "all" } } } } }), /unreadable \(snapshot variants\.claude\.items is not a list\)/);
    // A started card (resume, account switch) refuses the same way and is left as it was.
    board.update(a, { sessionId: "11111111-1111-4111-8111-111111111111", worktree: repo });
    await refuse("claude:terminal", () => board.resume(a));
    await assert.rejects(() => board.continueTask(a), /blocked on claude:terminal/);
    board.update(h, { sessionId: "22222222-2222-4222-8222-222222222222", worktree: repo });
    await assert.rejects(() => board.followUpHeadless(h, "more"), /blocked on claude:headless/);
    assert.throws(() => board.gate(a), /blocked on claude:terminal/);
    board.accountList = () => [{ name: "me@x", configDir: dir }, { name: "other@x", configDir: path.join(home, ".claude-accounts", "other") }];
    assert.throws(() => board.switchAccount(a, "other@x"), /Capability profile Tests r1 .* is blocked/);
    board.accountList = () => [{ name: "me@x", configDir: dir }];
    assert.equal(board.get(a.id).account, "me@x");
    assert.deepEqual(launched, [], "no terminal, panel or command was opened");
    assert.equal(shared(), was, "the shared account folder is byte-for-byte unchanged");
    // The profile changes after pinning: the cards keep their snapshot, and the saved board still has it after a reload.
    P.saveRevision(ws, "workspace", { name: "Tests v2", variants: { claude: VARIANT([{ kind: "mcp", id: "user-web" }]) } }, tests.ref);
    board.dispose();
    fs.writeFileSync(path.join(board.dir, "owner.json"), JSON.stringify({ pid: 999999999, at: Date.now() - 600_000 }));
    const again = new Board(repo, path.join(repo, "hook.js")); boards.push(again);
    assert.deepEqual(again.get(a.id).profile.snapshot, a.profile.snapshot);
    assert.equal(again.get(a.id).profile.snapshot.name, "Tests");
    await t.test("RT-09: the Grok defaults confirmation rechecks the selected home and current card",
      () => checkGrokDefaults(again, home, b.profile));
  } finally {
    for (const x of boards) x.dispose();
    Module._load = load;
    Object.assign(process.env, env);
  }
});

async function checkGrokDefaults(board, home, otherProfile) {
  const repo = board.repo, ws = path.join(repo, "workflows", P.PROFILE_FILE), files = { workspace: ws };
  const accounts = [
    { name: "Grok managed", provider: "grok", configDir: path.join(home, "managed-grok"), server: "chosen" },
    { name: "Grok default", provider: "grok", configDir: path.join(home, ".grok"), server: "ordinary" },
  ];
  board.accountList = () => accounts;
  for (const { configDir, server } of accounts) write(path.join(configDir, "config.toml"), `[mcp_servers.${server}]\nenabled = true`);
  const profile = P.saveRevision(ws, "workspace", { name: "No extras", variants: { grok: { items: [] } } });
  const pinned = P.pin(files, profile.ref);
  const ui = host(repo);
  const form = ui.profileView(board).entries.find((entry) => entry.ref === profile.ref);
  for (const account of accounts) {
    const expected = `mcp ${account.server} (user)`;
    const task = board.add(account.name, "x", account.name, undefined, undefined, undefined, undefined, { profile: pinned });
    const check = board.profileCheck(task);
    assert.equal(check.reasons.find((r) => r.code === "inherited-extras").text, `would also inherit 1 it does not list: ${expected}`);
    assert.equal(form.blocked[account.name], check.reasons.map((r) => r.text).join("; ") + ".");
    assert.deepEqual(board.inheritedBy(task).items, [expected]);
    const message = { type: "profileDefaults", id: task.id };
    const saved = () => JSON.parse(fs.readFileSync(board.file, "utf8")).find((card) => card.id === task.id);
    ui.answer = undefined;
    await ui.handle(message, board);
    assert.deepEqual(ui.asked.at(-1)[1].detail.split("\n").filter((line) => line.startsWith("- ")), [`- ${expected}`]);
    assert.deepEqual(saved().profile, pinned);
    assert.equal(saved().profileReplaced, undefined);
    // Use a timestamp exactly representable on both platforms. Only the normal pre-dialog
    // reload sees the timestamp change. The dialog edit below restores it after writing.
    const stamp = new Date("2026-01-01T00:00:00Z");
    const writeAtSameTime = (value) => {
      write(board.file, value);
      fs.utimesSync(board.file, stamp, stamp);
      assert.equal(fs.statSync(board.file).mtimeMs, board.loadedAt);
    };
    const confirmDuring = (change) => {
      fs.utimesSync(board.file, stamp, stamp);
      board.reload();
      assert.equal(board.loadedAt, stamp.getTime());
      let answer;
      ui.answer = new Promise((resolve) => { answer = resolve; });
      const asked = ui.asked.length;
      const result = ui.handle(message, board);
      assert.equal(ui.asked.length, asked + 1, "the confirmation is open");
      change();
      answer("Run with Provider defaults instead");
      return result;
    };
    if (account.server === "chosen") {
      const stale = /changed while the confirmation was open/;
      const refuse = async (change, reason = stale) => {
        let afterChange;
        await assert.rejects(confirmDuring(() => {
          change();
          afterChange = fs.readFileSync(board.file, "utf8");
        }), reason);
        assert.equal(fs.readFileSync(board.file, "utf8"), afterChange, "refusal writes nothing to the board");
        assert.equal(board.get(task.id).profile.mode, "strict");
      };
      const config = path.join(account.configDir, "config.toml"), original = fs.readFileSync(config);
      await refuse(() => fs.appendFileSync(config, "\n[mcp_servers.extra]\nenabled = true"));
      fs.writeFileSync(config, original);
      // Only the unknown list changes when the otherwise absent project config cannot be read.
      const projectConfig = path.join(repo, ".grok", "config.toml");
      await refuse(() => fs.mkdirSync(projectConfig, { recursive: true }));
      fs.rmdirSync(projectConfig);
      const otherHome = path.join(home, "same-inventory");
      write(path.join(otherHome, "config.toml"), original.toString());
      const patch = (fields) => board.update(board.get(task.id), fields);
      await refuse(() => patch({ configDir: otherHome }));
      await refuse(() => patch({ account: "renamed Grok" }));
      patch({ configDir: account.configDir, account: account.name });
      await refuse(() => {
        const cards = JSON.parse(fs.readFileSync(board.file, "utf8"));
        Object.assign(cards.find((card) => card.id === task.id), { profile: otherProfile, title: "Replacement" });
        writeAtSameTime(cards);
        assert.equal(board.reload(), false, "ordinary polling still skips the equal-mtime edit");
      });
      assert.deepEqual(saved().profile, otherProfile);
      assert.equal(saved().title, "Replacement");
      patch({ profile: pinned });
      await refuse(() => patch({ governedBy: "123abc" }), /authorized by its governed run/);
      patch({ governedBy: undefined });
      const valid = fs.readFileSync(board.file, "utf8");
      const rows = JSON.parse(valid);
      for (const malformed of ["{", "{}", [...rows, null], [...rows, rows[0]]]) {
        await refuse(() => writeAtSameTime(malformed), /current board could not be read/);
        writeAtSameTime(valid);
      }
      const owner = path.join(board.dir, "owner.json");
      await refuse(() => write(owner, { pid: process.ppid, at: Date.now() }), /Another VS Code window/);
      write(owner, { pid: process.pid, at: Date.now() });
    }
    let otherCards;
    await confirmDuring(() => {
      const cards = JSON.parse(fs.readFileSync(board.file, "utf8"));
      if (account.server === "chosen") {
        cards.find((c) => c.id === task.id).title = "Edited during confirmation";
        cards.find((c) => c.id !== task.id).title = "Edited sibling";
        cards.push({ ...cards[0], id: require("node:crypto").randomBytes(3).toString("hex"), title: "Added during confirmation" });
        writeAtSameTime(cards);
      }
      otherCards = cards.filter((c) => c.id !== task.id);
      assert.equal(board.reload(), false);
    });
    const accepted = saved();
    assert.deepEqual(JSON.parse(fs.readFileSync(board.file, "utf8")).filter((c) => c.id !== task.id), otherCards);
    assert.equal(accepted.title, account.server === "chosen" ? "Edited during confirmation" : account.name);
    assert.deepEqual(accepted.profile, { mode: "provider-defaults" });
    assert.deepEqual(accepted.profileReplaced.inherited, [expected]);
    assert.equal(accepted.profileReplaced.hash, pinned.snapshot.hash);
  }
}

test("plan steps cannot carry a profile; a child's profile is carried only into a governed run (phase 3), never ignored into Provider defaults", () => {
  const { validateRequest, refusal } = require("../out/orchestrator.js"), { validatePlanFile } = require("../out/plan.js");
  // Phase 3 carries the field; outside a governed run a profiled card is still refused (Board.handleRequest, test/governed.test.js).
  const v1 = validateRequest({ v: 1, op: "add", by: "abc123", session: "s", title: "T", prompt: "x", profile: "workspace:x" }, "n");
  assert.equal(v1.request.profile, "workspace:x");
  const root = { id: "abc123", title: "R", prompt: "p", status: "running", createdAt: "x", updatedAt: "x", sessionId: "s", orchestrator: { caps: { open: 4, total: 9, depth: 4, followUps: 3, pending: 3, watchers: 3, perWatcher: 4 }, opened: 0 }, approved: { at: "x", hash: "h" } };
  const ctx = { enabled: true, now: 0, lastRequestAt: new Map(), rateMs: 0, unprocessed: () => 0, capsOf: (r) => r.orchestrator.caps, accountSignedIn: () => true, accountUsage: () => undefined, models: ["opus"], efforts: ["high"], permissions: ["bypass"] };
  assert.match(refusal(v1.request, [root], ctx), /need a governed run/, "an ordinary run refuses the field instead of ignoring it");
  const rules = { catalogue: {}, models: ["opus"], efforts: ["high"], permissions: ["bypass"], maxSteps: 4 };
  const v = validatePlanFile({ v: 1, name: "P", review: "checks", steps: [{ id: "a", title: "A", goal: "Do it.", profile: "workspace:x" }] }, rules);
  assert.ok(v.errors.some((e) => /Unknown field "profile"/.test(e)), JSON.stringify(v));
});

// ---- the extension's handlers (src/extension.ts) with a stand-in board ----

function host(repo) {
  const added = [], starts = [], updates = [], asked = [], switched = [], out = {};
  const forbid = () => { throw new Error("This test must not open a window or launch a process."); };
  const vscode = { workspace: { getConfiguration: () => ({ get: (k, d) => (k === "autoStart" ? true : d) }) },
    window: { showErrorMessage: () => {}, showInformationMessage: forbid, showWarningMessage: async (...a) => { asked.push(a); return out.answer; }, setStatusBarMessage: () => ({ dispose() {} }) } };
  const stubs = { "./compile": require("../out/compile.js"), "./profiles": P, "./queue": require("../out/queue.js"), "./models": require("../out/models.js"), "./plan": require("../out/plan.js") };
  const filename = require.resolve("../out/extension.js"), extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = (name) => name === "vscode" ? vscode : name === "child_process" ? { execFile: forbid, execFileSync: forbid, spawn: forbid } : name.startsWith("./") ? stubs[name] ?? {} : require(name);
  extension._compile(fs.readFileSync(filename, "utf8") + '\nstate = { get: () => undefined }; Object.assign(module.exports, { handle, profileView });\n', filename);
  const tasks = [], board = { repo, dir: fresh(), tasks, external: new Map(), mustOwn() {}, accountList: () => [], orchestratorEnabled: () => false,
    add(title, prompt, account, parentId, model, effort, completion, step) { added.push(step); const t = { id: `c${tasks.length + 1}`, title, status: "queued", prompt, provider: "codex", ...step }; /* Codex: Start goes straight to board.start, no panel question */ tasks.push(t); return t; },
    get: (id) => tasks.find((t) => t.id === id), update(t, p) { Object.assign(t, p); }, waitingToStart: () => true, live: () => [],
    async start(t) { starts.push(t.id); }, async startInPanel(t) { starts.push(t.id); }, resetUnstarted: () => false, reconcile() {}, refresh() {},
    inheritedBy: () => ({ items: ["skill deep-research (user)"], unknown: ["Claude's built-in tools"] }), useProviderDefaults: (t) => { switched.push(t.id); },
    profileProblem: (t) => t.profile && t.profile.mode !== "provider-defaults" ? "Capability profile Tests r1 is blocked." : undefined };
  vscode.workspace.getConfiguration = () => ({ get: (k, d) => (k === "autoStart" ? true : k === "maxRunning" ? 0 : k === "claudeProcessWrapper" ? undefined : d), update: async (...a) => { updates.push(a); } });
  return Object.assign(out, { handle: (m, target = board) => extension.exports.handle(target, m), profileView: extension.exports.profileView, added, starts, updates, tasks, asked, switched });
}

test("host: Add task pins the chosen profile, records Provider defaults explicitly, refuses an unknown or archived one; Battle refuses a profile (AC-A)", async () => {
  const repo = fresh(), ws = path.join(repo, "workflows", P.PROFILE_FILE);
  const { ref } = P.saveRevision(ws, "workspace", { name: "Tests", variants: { claude: VARIANT([{ kind: "skill", id: "a" }]) } });
  const f = host(repo), msg = (profile) => ({ type: "create", title: "T", prompt: "Do it.", account: "", model: "", effort: "", permission: "", autoTitle: false, profile });
  await f.handle(msg(ref));
  assert.deepEqual([f.added[0].profile.mode, f.added[0].profile.snapshot.id, f.added[0].profile.snapshot.revision], ["strict", ref, 1]);
  await f.handle(msg("provider-defaults"));
  assert.deepEqual(f.added[1].profile, { mode: "provider-defaults" });
  await f.handle(msg(""));
  assert.equal(f.added[2]?.profile, undefined, "no profile file shown: the card is as before");
  await assert.rejects(f.handle(msg("workspace:0b4a9a6e-6f3c-4c7e-9d7c-2b1f0f8e5a11")), /no longer exists/);
  const doc = JSON.parse(fs.readFileSync(ws, "utf8")); doc.profiles[0].archived = true; write(ws, doc);
  await assert.rejects(f.handle(msg(ref)), /archived/);
  assert.equal(f.added.length, 3, "a refused profile adds no card");
  assert.deepEqual(f.starts, ["c2", "c3"], "the Provider defaults cards auto-started; the strict card did not (no naming, linking or start)");
  const startsBefore = f.starts.length;
  await assert.rejects(f.handle({ type: "start", id: "c1" }), /Capability profile Tests r1 is blocked/);
  await assert.rejects(f.handle({ type: "resume", id: "c1" }), /Capability profile Tests r1 is blocked/);
  assert.deepEqual([f.starts.length, f.updates], [startsBefore, []], "refused before Use panel could write a setting");
  await assert.rejects(f.handle({ type: "battle", prompt: "Go.", profile: ref }), /cannot run a capability profile/);
  // O5: the switch asks first, with what the card would inherit; only his click on the named button changes the card.
  f.asked.length = 0; // earlier steps warned on their own
  await f.handle({ type: "profileDefaults", id: "c1" });
  assert.deepEqual([f.switched, f.asked.length], [[], 1], "dismissed: nothing changes");
  assert.equal(f.asked[0][0], 'Run "T" with Provider defaults?');
  assert.match(f.asked[0][1].detail, /inherits what the account is set up with:\n- skill deep-research \(user\)\nNot listed: Claude's built-in tools\./);
  assert.equal(f.asked[0][1].modal, true);
  f.answer = "Run with Provider defaults instead";
  await f.handle({ type: "profileDefaults", id: "c1" });
  assert.deepEqual(f.switched, ["c1"]);
});

// ---- the form (media/board.js) in headless Chrome ----

const cdp = require("./compile-webview-cdp");
test("webview: the profile choice appears only with profiles, Provider defaults is explicit, a blocked profile says why, the card chip shows it (AC-H)", { timeout: 120_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview scenario was not run."); return; }
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const profileDir = fs.mkdtempSync(path.join(scratch, "edge-"));
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, profileDir); } catch (e) { t.skip(`Edge could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading");
    await page.evaluate(cdp.HELPERS);
    const ev = (expr) => page.evaluate(expr);
    const box = `document.querySelector('select[aria-label="Capability profile for new task"]')`;
    assert.equal(await ev(`${box}.hidden`), true, "no profile file: nothing new on the form");
    const why = "Capability profile Tests r1 (workspace:x) is blocked on claude:terminal: strict scope is not enabled for claude:terminal.";
    // The form's line is the reasons alone, each long list cut to three names; the whole lists open under Show all (F110 findings F2, F3).
    const line = "strict scope is not enabled for claude:terminal; would also inherit 5 it does not list: skill a (user), skill b (user), skill c (user) and 2 more.";
    const lists = ["Would also inherit: skill a (user), skill b (user), skill c (user), skill d (user), skill e (user)."];
    await ev(`window.__host({ tasks: [], live: [], own: [], accounts: ["acct"], profiles: { errors: [], entries: [{ ref: "workspace:x", scope: "workspace", name: "Tests", revision: 1, blocked: { acct: ${JSON.stringify(line)} }, lists: { acct: ${JSON.stringify(lists)} } }] } }); true`);
    assert.equal(await ev(`${box}.hidden`), false);
    assert.deepEqual(await ev(`[...${box}.options].map((o) => [o.value, o.textContent])`), [["provider-defaults", "Provider defaults"], ["workspace:x", "Tests (workspace) r1"]]);
    assert.equal(await ev(`${box}.value`), "provider-defaults");
    assert.match(await ev(`document.querySelector(".profile-note").textContent`), /^Capabilities: Provider defaults/);
    await ev(`__h.select("Capability profile for new task", "workspace:x")`);
    assert.equal(await ev(`document.querySelector(".profile-note").textContent`), `Blocked: Tests r1: ${line}`);
    assert.equal(await ev(`document.querySelector(".profile-note").getAttribute("role")`), "status", "announced to screen readers");
    assert.equal(await ev(`${box}.title`), "Tests (workspace) r1", "the whole choice in the mouse-over, which a narrow side bar cuts");
    assert.deepEqual(await ev(`(() => { const d = document.querySelector(".profile-lists"); return [d.hidden, d.querySelector("summary").textContent, [...d.querySelectorAll("p")].map((p) => p.textContent)]; })()`), [false, "Show all", lists]);
    await page.send("Emulation.setDeviceMetricsOverride", { width: 180, height: 900, deviceScaleFactor: 1, mobile: false });
    const fit = await ev(`(() => { const w = document.documentElement.clientWidth, r = document.querySelector(".profile-note").getBoundingClientRect(), s = ${box}.getBoundingClientRect();
      return { scroll: document.documentElement.scrollWidth - w, note: r.right <= w && r.left >= 0, select: s.right <= w && s.left >= 0 }; })()`);
    assert.deepEqual(fit, { scroll: 0, note: true, select: true });
    await page.send("Emulation.clearDeviceMetricsOverride");
    await ev(`__h.setBox("Run the tests."); [...document.querySelectorAll("button")].find((b) => b.textContent === "Add task").click(); true`);
    assert.equal(await ev(`window.__posted.filter((m) => m.type === "create").at(-1).profile`), "workspace:x");
    const snapshot = { id: "workspace:x", revision: 1, name: "Tests", hash: "h", variants: {} };
    await ev(`window.__host({ tasks: [{ id: "c1", title: "A", prompt: "p", status: "queued", profile: { mode: "strict", pinnedAt: "t", snapshot: ${JSON.stringify(snapshot)} }, profileBlocked: ${JSON.stringify(why)} }], live: [], own: [], accounts: ["acct"] }); true`);
    // The blocked chip is a disclosure: its summary takes keyboard focus and opens the reason (F110 finding F5).
    const chip = `document.querySelector(".chip.profile-chip")`;
    assert.deepEqual(await ev(`[${chip}.tagName, ${chip}.querySelector("summary").textContent, ${chip}.open]`), ["DETAILS", "Profile Tests r1 · blocked", false]);
    await ev(`${chip}.querySelector("summary").focus(); true`);
    assert.equal(await ev(`document.activeElement === ${chip}.querySelector("summary")`), true);
    await ev(`${chip}.querySelector("summary").click(); true`);
    assert.deepEqual(await ev(`[${chip}.open, ${chip}.querySelector("span").textContent]`), [true, why]);
    // O5: a blocked strict card that is not running offers the switch; a running one does not.
    const offer = `[...document.querySelectorAll("button")].find((b) => b.textContent === "Run with Provider defaults instead")`;
    await ev(`${offer}.click(); true`);
    assert.deepEqual(await ev(`window.__posted.at(-1)`), { type: "profileDefaults", id: "c1" });
    await ev(`window.__host({ tasks: [{ id: "c1", title: "A", prompt: "p", status: "running", profile: { mode: "strict", pinnedAt: "t", snapshot: ${JSON.stringify(snapshot)} }, profileBlocked: ${JSON.stringify(why)} }], live: ["c1"], own: [], accounts: ["acct"] }); true`);
    assert.equal(await ev(`!!${offer}`), false, "a live session keeps its scope: no switch offered");
    assert.equal(await ev(`${box}.hidden`), true, "profiles gone from the host: the choice hides again");
  } finally {
    page?.close();
    if (edge) await edge.kill();
  }
});
