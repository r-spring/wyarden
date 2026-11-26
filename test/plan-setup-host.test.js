// Exercise the production BoardView message receiver, not the retired modal helper.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const P = require("../out/plan");
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function fixture(savedState = new Map()) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-setup-host-"));
  fs.mkdirSync(path.join(repo, "workflows"));
  const raw = { v: 1, name: "Host setup", review: "checks", account: "acct", model: "opus", effort: "low", permission: "ask", steps: [{ id: "a", title: "A", goal: "Fix A", checks: ["unit"] }] };
  const file = path.join(repo, "workflows/a.plan.json"), other = path.join(repo, "workflows/b.plan.json");
  fs.writeFileSync(file, JSON.stringify(raw)); fs.writeFileSync(other, JSON.stringify({ ...raw, name: "Other" }));
  const messages = [], errors = [], runs = [], disposers = [], disposable = { dispose() {} };
  const f = { repo, file, other, messages, errors, runs, savedState, catalogue: { unit: { run: "node check.js" } }, saveDialog: async () => undefined, run: undefined };
  const vscode = {
    Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join("/") }), file: (fsPath) => ({ fsPath, path: fsPath }) },
    workspace: { onDidChangeConfiguration: () => disposable, getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { createQuickPick: () => { throw new Error("Card selection must not open the picker"); }, showErrorMessage: (message) => errors.push(message), showInformationMessage: (...args) => f.info?.(...args), showInputBox: async (o) => f.input?.(o), showSaveDialog: (...args) => f.saveDialog(...args) },
  };
  const board = { repo, dir: path.join(repo, ".entomatical"), tasks: [{ id: "111111", planFile: "workflows/a.plan.json" }, { id: "222222", planFile: "workflows/b.plan.json" }],
    get(id) { return this.tasks.find((task) => task.id === id); }, mustOwn() {}, onChange: () => disposable,
    accountList: () => [{ name: "acct" }], capsOf: () => ({ open: 4, total: 20 }), orchestratorEnabled: () => true,
    checkPlan: (source, vars) => P.validatePlanFile(source, { catalogue: f.catalogue, models: ["opus", "haiku"], efforts: ["low"], permissions: ["ask"], accounts: ["acct"], maxSteps: 20, cards: board.tasks.map((t) => t.id) }, vars),
    async runPlan(...args) { runs.push(args); if (f.run) return f.run(...args); const card = { id: "333333", title: "Run" }; this.tasks.push(card); return { card, steps: [] }; },
  };
  f.board = board;
  const modules = { vscode, "./cardTerminal": require("../out/cardTerminal"), "./plan": P, "./plan-setup": require("../out/plan-setup"), "./profiles": require("../out/profiles"),
    "./checks": { readCatalogue: () => f.catalogue }, "./accounts": { onAccountsChanged: () => disposable },
    "./codex": { codexModels: () => [] }, "./acp": { isAcpProvider: (provider) => ["grok", "antigravity"].includes(provider) } };
  const filename = require.resolve("../out/extension");
  const extension = new Module(filename, module); extension.filename = filename;
  extension.require = (name) => name in modules ? modules[name] : name.startsWith("./") ? {} : require(name);
  extension._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.BoardViewForTest = BoardView; module.exports.setStateForTest = (value) => { state = value; };\n", filename);
  extension.exports.setStateForTest({ get: (key, fallback) => savedState.get(key) ?? fallback, update: async (key, value) => savedState.set(key, structuredClone(value)) });
  // Board rendering is orthogonal: retain the actual attach/receiver and isolate transcript/metrics reads.
  extension.exports.BoardViewForTest.prototype.boardMessage = () => ({ tasks: [] });
  const view = new extension.exports.BoardViewForTest({ path: "/extension" }, board);
  let receive;
  view.resolveWebviewView({ webview: { cspSource: "csp", asWebviewUri: (uri) => uri.path, postMessage: async (message) => messages.push(message), onDidReceiveMessage: (callback) => { receive = callback; return disposable; } }, onDidDispose: (callback) => { disposers.push(callback); return disposable; } });
  f.send = (message) => receive(message);
  f.select = async (id = "111111") => { await f.send({ type: "runPlan", id, file: "/forged.json" }); return messages.filter((m) => m.selectedPlan).at(-1).selectedPlan; };
  f.preview = async (selection, draft = {}, revision = 1) => { await f.send({ type: "previewSelectedPlan", selectionId: selection.selectionId, revision, draft }); return messages.filter((m) => m.planValidation).at(-1).planValidation; };
  f.start = (selection, draft = {}, revision = 1) => f.send({ type: "startSelectedPlan", selectionId: selection.selectionId, revision, draft });
  f.close = () => { disposers.forEach((fn) => fn()); fs.rmSync(repo, { recursive: true, force: true }); };
  return f;
}

test("host binds card selection, draft and revision to a validated preview before effects", async () => {
  const f = fixture();
  try {
    const selection = await f.select();
    assert.equal(selection.file, "workflows/a.plan.json"); assert.equal(f.runs.length, 0);
    await f.start(selection); assert.match(f.errors.at(-1), /Review the updated preview/);
    assert.deepEqual((await f.preview(selection)).errors, []);
    await f.start(selection, {}, 2); assert.equal(f.runs.length, 0);
    await f.start(selection, { defaults: { model: "haiku" } }); assert.equal(f.runs.length, 0);
    const invalid = await f.preview(selection, { defaults: { model: "not-a-model" } }, 3);
    assert.ok(invalid.errors.length); await f.start(selection, { defaults: { model: "not-a-model" } }, 3);
    assert.equal(f.runs.length, 0); assert.equal(f.board.tasks.length, 2);
    const draft = { defaults: { model: "haiku" } };
    await f.preview(selection, draft, 4); await f.start(selection, draft, 4);
    assert.equal(f.runs.length, 1); assert.equal(f.runs[0][0].model, "haiku"); assert.equal(f.runs[0][1], f.file);
    assert.equal(f.runs[0][3], undefined); assert.match(f.runs[0][4].sourceHash, /^[0-9a-f]{64}$/); assert.match(f.runs[0][4].configHash, /^[0-9a-f]{64}$/);
    assert.ok(f.messages.some((m) => m.planStarted));
  } finally { f.close(); }
});

test("a v2 plan keeps the approval dialog: typed inputs, previewPlan, and the approval as runPlan's fourth argument", async () => {
  const f = fixture();
  try {
    const gov = { v: 2, name: "Gov", review: "checks", reusable: false, inputs: { rooms: { type: "list", required: true } }, execution: { limits: { active: 1, directChildren: 1, depth: 1 }, defaultChild: "worker" }, steps: [] };
    fs.writeFileSync(f.other, JSON.stringify(gov));
    const approval = { id: "approval-1", hash: "h".repeat(64), manifest: { sources: { "a.txt": "x" } } }, previews = [];
    f.board.checkPlan = (raw, vars) => ({ plan: raw, cards: [], vars });
    f.board.previewPlan = (...args) => { previews.push(args); return approval; };
    f.input = () => '["Living room", "Office, upstairs"]';
    f.info = (_message, options) => options?.modal ? "Run" : undefined;
    await f.send({ type: "runPlan", id: "222222" });
    assert.equal(f.messages.some((m) => m.selectedPlan), false); // no tabbed setup for v2
    assert.deepEqual(previews[0][2], { rooms: ["Living room", "Office, upstairs"] });
    assert.equal(f.runs.length, 1); assert.equal(f.runs[0][1], f.other); assert.equal(f.runs[0][3], approval); assert.equal(f.runs[0][4], undefined);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test("preview sends the effective judge policy for the current account to the webview", async () => {
  const f = fixture();
  try {
    const source = JSON.parse(fs.readFileSync(f.file, "utf8"));
    fs.writeFileSync(f.file, JSON.stringify({ ...source, judge: "opus" }));
    const profiles = ["claude", "codex"].map(provider => ({
      name: provider === "claude" ? "acct" : "Codex · test", provider, models: [{ id: "opus", efforts: ["low"] }], permissions: ["ask"],
    }));
    f.board.checkPlan = (raw, vars) => P.validatePlanFile(raw, { catalogue: f.catalogue, profiles, models: [], efforts: ["low"], permissions: ["ask"], maxSteps: 3 }, vars);
    const selected = await f.select();
    assert.equal((await f.preview(selected)).judgePermission.permission, "plan");
    assert.equal((await f.preview(selected, { defaults: { account: "codex" } }, 2)).judgePermission.permission, "read-only");
    assert.equal(f.runs.length, 0);
  } finally { f.close(); }
});

test("host rechecks source and catalogue at start instead of trusting prior preview", async () => {
  for (const change of ["source", "catalogue"]) {
    const f = fixture();
    try {
      const selection = await f.select(); await f.preview(selection);
      if (change === "source") fs.appendFileSync(f.file, "\n"); else f.catalogue = { unit: { run: "node changed-check.js" } };
      await f.start(selection); assert.equal(f.runs.length, 0); assert.equal(f.board.tasks.length, 2);
      assert.match(f.errors.at(-1), /changed/);
    } finally { f.close(); }
  }
});

test("an unrelated board card status change preserves the approved plan preview", async () => {
  const f = fixture();
  try {
    const selection = await f.select();
    assert.deepEqual((await f.preview(selection)).errors, []);
    f.board.get("222222").status = "done";
    await f.start(selection);
    assert.equal(f.runs.length, 1, "unrelated progress must not require another approval");
    assert.equal(f.errors.length, 0);
    assert.ok(f.messages.some((message) => message.planStarted));
  } finally { f.close(); }
});

test("a referenced external dependency state change invalidates the approved plan preview", async () => {
  const f = fixture();
  try {
    f.board.get("222222").status = "review";
    const selection = await f.select();
    const draft = { dependencies: { a: ["222222"] } };
    assert.deepEqual((await f.preview(selection, draft)).errors, []);
    f.board.get("222222").status = "done";
    await f.start(selection, draft);
    assert.equal(f.runs.length, 0);
    assert.equal(f.board.tasks.length, 2);
    assert.match(f.errors.at(-1), /board state changed.*updated preview/);
  } finally { f.close(); }
});

test("duplicate start and reselection are ignored while a run is pending", async () => {
  const f = fixture(), gate = deferred();
  try {
    f.run = async () => { await gate.promise; return { card: { title: "Run" }, steps: [] }; };
    const selection = await f.select(); await f.preview(selection);
    const first = f.start(selection); await Promise.resolve();
    await f.start(selection); await f.send({ type: "runPlan", id: "222222" });
    assert.equal(f.runs.length, 1); assert.equal(f.messages.filter((m) => m.selectedPlan).length, 1);
    gate.resolve(); await first; assert.equal(f.messages.filter((m) => m.planStarted).length, 1);
  } finally { gate.resolve(); f.close(); }
});

test("partial creation holds retry even after plan reselection", async () => {
  const f = fixture();
  try {
    f.run = async (_raw, _file, _vars, _approval, receipt) => { f.board.tasks.push({ id: "444444", title: "Partially created", planRun: { ...receipt, setupState: "creating" } }); throw new Error("simulated launch failure"); };
    const selection = await f.select(); await f.preview(selection); await f.start(selection);
    assert.match(f.errors.at(-1), /444444/); assert.equal(f.runs.length, 1);
    await f.preview(selection); await f.start(selection); assert.equal(f.runs.length, 1);
    const reselected = await f.select(); await f.preview(reselected); await f.start(reselected);
    assert.equal(f.runs.length, 1, "reselection must not remove the partial-run recovery hold");
  } finally { f.close(); }
});

test("save-as refuses selection changes while the file dialog is pending", async () => {
  const f = fixture(), gate = deferred(), destination = path.join(f.repo, "copy.plan.json");
  try {
    f.saveDialog = () => gate.promise;
    const selection = await f.select();
    const saving = f.send({ type: "savePlanAs", selectionId: selection.selectionId, order: ["a"], dependencies: { a: [] } });
    await Promise.resolve(); await f.select("222222"); gate.resolve({ fsPath: destination }); await saving;
    assert.equal(fs.existsSync(destination), false, "an old selection must not write after reselection");
  } finally { gate.resolve(); f.close(); }
});

test("preset host boundary rejects content and secrets before personal storage", async () => {
  const f = fixture();
  try {
    const selection = await f.select();
    for (const settings of [{ vars: { private: "content" } }, { model: "opus", apiKey: "secret" }, { steps: { a: { goal: "content" } } }]) {
      await f.send({ type: "savePlanPreset", selectionId: selection.selectionId, name: "Rejected", settings });
      assert.equal(f.savedState.has("planSetupPresets"), false);
    }
    await f.send({ type: "savePlanPreset", selectionId: selection.selectionId, name: "Personal", settings: { model: "opus", steps: { a: { effort: "low" } } } });
    assert.equal(f.savedState.get("planSetupPresets").length, 1);
    assert.deepEqual(f.savedState.get("planSetupPresets")[0].settings, { model: "opus", steps: { a: { effort: "low" } } });
  } finally { f.close(); }
});

test("save-as writes dependency edits only, keeps source intact and refuses destination collisions", async () => {
  const f = fixture(), destination = path.join(f.repo, "saved.plan.json");
  try {
    const original = fs.readFileSync(f.file);
    const selection = await f.select();
    f.saveDialog = async () => ({ fsPath: destination });
    const message = { type: "savePlanAs", selectionId: selection.selectionId, order: ["a"], dependencies: { a: ["222222"] } };
    await f.send(message);
    const expected = JSON.parse(original); expected.steps[0].after = ["222222"];
    assert.deepEqual(JSON.parse(fs.readFileSync(destination, "utf8")), expected);
    assert.deepEqual(fs.readFileSync(f.file), original);
    assert.equal(f.runs.length, 0); assert.equal(f.board.tasks.length, 2);
    const savedBytes = fs.readFileSync(destination);
    await f.send({ ...message, dependencies: { a: [] } });
    assert.match(f.errors.at(-1), /EEXIST|exist/i);
    assert.deepEqual(fs.readFileSync(destination), savedBytes);
    assert.deepEqual(fs.readFileSync(f.file), original);
  } finally { f.close(); }
});

test("save-as cancellation and dialog-time source, catalogue or ownership changes never write", async () => {
  for (const change of ["cancel", "source", "catalogue", "ownership"]) {
    const f = fixture(), gate = deferred(), destination = path.join(f.repo, "blocked.plan.json");
    try {
      f.saveDialog = () => gate.promise;
      const selection = await f.select();
      const saving = f.send({ type: "savePlanAs", selectionId: selection.selectionId, order: ["a"], dependencies: { a: [] } });
      await Promise.resolve();
      if (change === "source") fs.appendFileSync(f.file, "\n");
      if (change === "catalogue") f.catalogue = {};
      if (change === "ownership") f.board.mustOwn = () => { throw new Error("Another window owns this board"); };
      gate.resolve(change === "cancel" ? undefined : { fsPath: destination }); await saving;
      assert.equal(fs.existsSync(destination), false, change);
      assert.equal(f.runs.length, 0); assert.equal(f.board.tasks.length, 2);
      if (change === "cancel") assert.equal(f.errors.length, 0);
      else assert.ok(f.errors.length, `${change} should explain the refusal`);
    } finally { gate.resolve(); f.close(); }
  }
});

test("personal preset save/list/rename/delete survives a new host and rejects duplicate names", async () => {
  const store = new Map(), f = fixture(store);
  let reloaded;
  try {
    const selection = await f.select();
    const send = (type, rest = {}) => f.send({ type, selectionId: selection.selectionId, ...rest });
    const settings = { account: "acct", model: "haiku", steps: { a: { effort: "low" } } };
    await send("savePlanPreset", { name: "Personal", settings });
    const first = structuredClone(store.get("planSetupPresets")[0]);
    await send("getPlanPresets");
    assert.deepEqual(f.messages.filter((m) => m.planPresets).at(-1).planPresets.presets, [first]);
    await send("savePlanPreset", { name: "personal", settings });
    assert.match(f.errors.at(-1), /already has that name/); assert.equal(store.get("planSetupPresets").length, 1);
    await send("savePlanPreset", { name: "Second", settings: { model: "opus" } });
    await send("renamePlanPreset", { id: first.id, name: "SECOND" });
    assert.match(f.errors.at(-1), /already has that name/); assert.equal(store.get("planSetupPresets")[0].name, "Personal");
    await send("renamePlanPreset", { id: first.id, name: "Renamed" });
    assert.equal(store.get("planSetupPresets")[0].name, "Renamed");
    assert.deepEqual(store.get("planSetupPresets")[0].settings, settings);
    // A new compiled extension/BoardView sees the persisted personal store, without any selection auto-application.
    reloaded = fixture(store); const next = await reloaded.select();
    await reloaded.send({ type: "getPlanPresets", selectionId: next.selectionId });
    const listed = reloaded.messages.filter((m) => m.planPresets).at(-1).planPresets;
    assert.equal(listed.selectionId, next.selectionId); assert.equal(listed.presets[0].name, "Renamed");
    assert.deepEqual(listed.presets[0].settings, settings); assert.equal(next.raw.model, "opus");
    assert.equal(reloaded.runs.length, 0);
    await reloaded.send({ type: "deletePlanPreset", selectionId: next.selectionId, id: first.id });
    assert.equal(store.get("planSetupPresets").length, 1);
    assert.equal(store.get("planSetupPresets")[0].name, "Second");
    await reloaded.send({ type: "deletePlanPreset", selectionId: next.selectionId, id: first.id });
    assert.match(reloaded.errors.at(-1), /no longer exists/);
    assert.equal(store.get("planSetupPresets").length, 1);
  } finally { reloaded?.close(); f.close(); }
});
