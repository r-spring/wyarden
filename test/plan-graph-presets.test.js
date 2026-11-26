const test = require("node:test");
const assert = require("node:assert/strict");
const Graph = require("../media/plan-graph");
const Presets = require("../media/plan-presets");
const plan = () => ({ v: 1, name: "Private", review: "model", vars: { secret: "not a setting" }, model: "opus", judge: "haiku", scribe: { model: "haiku", documents: ["notes.md"], after: ["a"] }, steps: [{ id: "a", goal: "private goal", model: "sol" }, { id: "b", after: ["a", "abcdef"], each: "items" }] });

test("graph edits preserve source and separate list order from dependency edges", () => {
  const source = plan(), moved = Graph.edit(source, { type: "move", id: "b", direction: -1 });
  assert.deepEqual(moved.steps.map((s) => s.id), ["b", "a"]);
  assert.deepEqual(moved.steps[0].after, ["a", "abcdef"]);
  assert.deepEqual(source, plan());
  const added = Graph.edit(source, { type: "addDependency", id: "a", dependency: "b" });
  assert.deepEqual(added.steps[0].after, ["b"]); // Host, not this UI, decides whether the resulting cycle validates.
  assert.deepEqual(Graph.edit(added, { type: "addDependency", id: "a", dependency: "b" }), added);
  assert.deepEqual(Graph.edit(source, { type: "removeDependency", id: "b", dependency: "abcdef" }).steps[1].after, ["a"]);
  assert.throws(() => Graph.edit(source, { type: "move", id: "missing", direction: 1 }), /unique/);
});

test("presets allowlist settings, preserve scopes and content, and report concrete replacements", () => {
  const source = plan(), captured = Presets.capture(source);
  assert.equal(JSON.stringify(captured).includes("private"), false);
  assert.equal(captured.vars, undefined);
  const hostile = { model: "unknown-model", vars: { secret: "leak" }, goal: "replace", token: "credential", reviewer: { account: "missing", apiKey: "leak" }, scribe: { model: "sol", documents: ["evil"] }, steps: { a: { effort: "ultra", goal: "replace", apiKey: "leak" } } };
  const applied = Presets.apply(source, hostile);
  const fixedPermission = { ...source, reviewer: { permission: "auto" } };
  assert.deepEqual(Presets.apply(fixedPermission, {}).reviewer, { permission: "auto" });
  assert.deepEqual(Presets.apply(fixedPermission, { reviewer: { model: "sonnet", permission: "bypass" } }).reviewer, { model: "sonnet", permission: "auto" });
  assert.equal(applied.model, "unknown-model");
  assert.equal(applied.reviewer.account, "missing");
  assert.equal(applied.reviewer.apiKey, undefined);
  assert.equal(applied.steps[0].model, undefined);
  assert.equal(applied.steps[0].effort, "ultra");
  assert.equal(applied.steps[0].goal, "private goal");
  assert.deepEqual(applied.vars, source.vars);
  assert.deepEqual(applied.scribe.documents, ["notes.md"]);
  assert.deepEqual(applied.scribe.after, ["a"]);
  assert.equal(applied.judge, "haiku");
  assert.ok(Presets.replacementSummary(source, hostile).includes("steps.a.model: sol → inherit/default"));
  assert.deepEqual(source, plan());
});

// A small native-control DOM stand-in checks the component's callbacks without a browser dependency.
class Element {
  constructor(tag, ownerDocument) { this.tagName = tag; this.ownerDocument = ownerDocument; this.children = []; this.listeners = {}; this.dataset = {}; this.value = ""; }
  append(...nodes) { this.children.push(...nodes); if (this.tagName === "select" && !this.value) this.value = nodes[0]?.value || ""; }
  replaceChildren() { this.children = []; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  click() { if (!this.disabled) return this.listeners.click?.(); }
}
const document = { createElement: (tag) => new Element(tag, document) };
function find(node, predicate) { if (predicate(node)) return node; for (const child of node.children) { const result = find(child, predicate); if (result) return result; } }
const button = (node, text) => find(node, (el) => el.tagName === "button" && el.textContent === text);

test("native graph controls edit, undo, reset and save without implicit edge creation", () => {
  const root = document.createElement("section"), changes = [], saves = [];
  const view = Graph.mount(root, { plan: plan(), externalCards: ["fedcba"], expanded: [{ sourceStepId: "b", key: "b-1" }], onChange: (value) => changes.push(value), onSaveAs: (value) => saves.push(value) });
  button(root, "Move b up").click();
  assert.deepEqual(changes.at(-1).steps[0].after, ["a", "abcdef"]);
  button(root, "Undo dependency edit").click();
  assert.equal(changes.at(-1).steps[0].id, "a");
  const select = find(root, (el) => el["aria-label"] === "Dependency for a"); select.value = "fedcba";
  button(root, "Add dependency to a").click();
  assert.deepEqual(changes.at(-1).steps[0].after, ["fedcba"]);
  button(root, "Cancel dependency edits").click();
  assert.deepEqual(changes.at(-1), plan());
  const row = find(root, (el) => el.dataset.step === "a");
  row.listeners.drop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { getData: () => "b" } });
  assert.equal(changes.at(-1).steps[0].id, "b");
  assert.deepEqual(changes.at(-1).steps[0].after, ["a", "abcdef"]);
  button(root, "Save dependency edits as new plan").click(); assert.deepEqual(saves[0], changes.at(-1));
  view.destroy(); assert.equal(root.children.length, 0);
});

test("preset UI requires concrete replacement approval and routes only allowlisted settings", async () => {
  const root = document.createElement("section"), applied = [], saved = [], renamed = [], deleted = [];
  const options = { plan: plan(), presets: [{ id: "p", name: "Personal", settings: { model: "sol" } }], onApply: (value) => applied.push(value), onSave: (...args) => saved.push(args), onRename: (...args) => renamed.push(args), onDelete: (id) => deleted.push(id) };
  const view = Presets.mount(root, options);
  await button(root, "Apply personal preset").click(); assert.equal(applied.length, 0);
  let replacements;
  view.update({ confirm: async (values) => { replacements = values; return true; } });
  await button(root, "Apply personal preset").click();
  assert.equal(applied[0].model, "sol"); assert.ok(replacements.includes("defaults.model: opus → sol"));
  const name = find(root, (el) => el["aria-label"] === "Preset name"); name.value = "My settings";
  button(root, "Save personal preset").click(); assert.deepEqual(saved[0], ["My settings", Presets.capture(plan())]);
  button(root, "Rename personal preset").click(); assert.deepEqual(renamed[0], ["p", "My settings"]);
  button(root, "Delete personal preset").click(); assert.deepEqual(deleted, ["p"]);
  view.destroy(); assert.equal(root.children.length, 0);
});

test("browser graph buttons support keyboard reorder with retained focus and preset replacement cancellation", { timeout: 60_000 }, async (t) => {
  const cdp = require("./compile-webview-cdp"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
  if (!cdp.edgePath()) return t.skip("Browser unavailable; native controls were not checked.");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-plan-components-"));
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  let browser, page;
  try {
    browser = await cdp.launchEdge(url, scratch);
    const target = await cdp.waitFor(async () => (await cdp.listTargets(browser.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "harness");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "harness scripts");
    for (const filename of ["plan-graph.js", "plan-presets.js"]) await page.evaluate(`(0,eval)(${JSON.stringify(fs.readFileSync(path.join(__dirname, "../media", filename), "utf8"))}); true`);
    await page.evaluate(`(() => {
      document.body.replaceChildren(); const graph = document.createElement('section'), presets = document.createElement('section'); document.body.append(graph, presets);
      window.graphChanges = []; window.presetChanges = [];
      const source = ${JSON.stringify(plan())};
      PlanGraph.mount(graph, { plan: source, onChange: p => graphChanges.push(p) });
      PlanPresets.mount(presets, { plan: source, presets: [{ id: 'p', name: 'Personal', settings: { model: 'sol' } }], confirm: async () => false, onApply: p => presetChanges.push(p) });
      [...graph.querySelectorAll('button')].find(b => b.textContent === 'Move b up').focus();
      return true;
    })()`);
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    const result = await page.evaluate(`({ order: graphChanges.at(-1)?.steps.map(s => s.id), after: graphChanges.at(-1)?.steps[0].after, focus: document.activeElement.textContent })`);
    assert.deepEqual(result.order, ["b", "a"]); assert.deepEqual(result.after, ["a", "abcdef"]); assert.equal(result.focus, "Move b down");
    await page.evaluate(`(async () => { [...document.querySelectorAll('button')].find(b => b.textContent === 'Apply personal preset').click(); await Promise.resolve(); return true; })()`);
    assert.equal(await page.evaluate("presetChanges.length"), 0);
  } finally {
    page?.close(); if (browser) await browser.kill(); fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
