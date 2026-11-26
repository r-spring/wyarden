// F99 "Run this plan now" (the user, 14 November 2026): the card's button (real media/board.js in headless Edge or Chrome), and the host's
// runPlan with a card id taking that card's recorded file without the picker (src/extension.ts handle, compiled in isolation as in
// test/extension-create.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const cdp = require("./compile-webview-cdp");
const P = require("../out/plan.js");

function host(repo) {
  const calls = { inputs: [], infos: [], runs: [] };
  const vscode = {
    workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
    window: {
      createQuickPick: () => { throw new Error("the picker must not open"); },
      showInputBox: async (o) => { calls.inputs.push(o.title); return o.value; },
      showErrorMessage: async (m, o) => { throw new Error(`${m} ${o?.detail ?? ""}`); },
      showInformationMessage: async (m, o, ...items) => { calls.infos.push(m); return items.includes("Run") ? "Run" : undefined; },
    },
  };
  const stubs = { "./plan": P, "./checks": { readCatalogue: () => undefined, limitToCatalogue: () => ({ kept: [], refused: [] }) } };
  const filename = require.resolve("../out/extension.js");
  const extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = (name) => name === "vscode" ? vscode : name === "./profiles" ? require("../out/profiles.js") : name.startsWith("./") ? stubs[name] ?? {} : require(name);
  extension._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.selectPlan = selectPlan;\n", filename);
  const RULES = { catalogue: { unit: { run: "npm test" } }, models: ["opus", "haiku"], efforts: ["low"], permissions: ["ask"], accounts: ["acct"], maxSteps: 12, cards: [] };
  const tasks = [];
  const board = { repo, tasks, get: (id) => tasks.find((t) => t.id === id), mustOwn() {},
    checkPlan: (raw, vars) => P.validatePlanFile(raw, RULES, vars),
    runPlan: async (raw, file, vars) => { calls.runs.push({ raw, file, vars }); return { card: { title: raw.name }, steps: [] }; } };
  return { board, calls, select: (m) => extension.exports.selectPlan(board, m) };
}

test("a card's plan is selected by its recorded file, and missing files are refused", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-run-plan-card-"));
  try {
    fs.mkdirSync(path.join(repo, "workflows"));
    const file = path.join(repo, "workflows", "x.plan.json");
    fs.writeFileSync(file, JSON.stringify({ v: 1, name: "X", review: "checks", vars: { area: "queue" }, steps: [{ id: "a", title: "Fix {{area}}", goal: "g", checks: ["unit"], model: "opus" }] }));
    const { board, calls, select } = host(repo);
    board.tasks.push({ id: "c1", planFile: "workflows/x.plan.json" }, { id: "c2" }, { id: "c3", planFile: "workflows/gone.plan.json" });
    const picked = await select({ type: "runPlan", id: "c1", file: "/somewhere/else.json" }); // a path from the webview is ignored
    assert.equal(calls.runs.length, 0);
    assert.equal(picked.file.file, file);
    assert.equal(picked.raw.steps[0].model, "opus");
    for (const id of ["c2", "c3", "nope"]) await assert.rejects(select({ type: "runPlan", id }), /This card has no plan file to run/);
    assert.equal(calls.runs.length, 0);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("F99 webview: Run this plan now shows only on a card whose plan file is ready and that is not running, and posts runPlan with its id", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview check was not run."); return; }
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-run-plan-webview-"));
  const now = new Date().toISOString();
  const card = (id, extra) => ({ id, title: id, prompt: "p", status: "review", createdAt: now, updatedAt: now, ...extra });
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`The browser could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading in the harness");
    const tasks = [card("p1", { planFile: "workflows/x.plan.json", planReady: true }), card("p2", { planFile: "workflows/x.plan.json", planReady: true, status: "running" }),
      card("p3", { planFile: "workflows/gone.plan.json" }), card("p4")];
    await page.evaluate(`window.__host(${JSON.stringify({ tasks, live: [], own: [], accounts: ["acct"] })}); true`);
    const seen = await cdp.waitFor(() => page.evaluate(`(() => { if (!document.querySelector('[data-task="p4"]')) return undefined; const out = {};
      for (const id of ["p1", "p2", "p3", "p4"]) out[id] = [...document.querySelectorAll('[data-task="' + id + '"] button')].filter((b) => b.textContent === "Run this plan now").map((b) => b.title);
      return out; })()`), "the cards");
    assert.deepEqual(seen, { p1: ["Run the plan this card wrote. It shows the steps first; nothing starts until you press Run."], p2: [], p3: [], p4: [] });
    await page.evaluate(`[...document.querySelectorAll('[data-task="p1"] button')].find((b) => b.textContent === "Run this plan now").click(); true`);
    assert.deepEqual(await page.evaluate(`window.__posted.filter((m) => m.type === "runPlan")`), [{ type: "runPlan", id: "p1" }]);
    const loaded = await page.evaluate(`(() => {
      const box = document.querySelector('textarea[data-draft-target="new"]'); box.value = 'unfinished task';
      window.__host({ selectedPlan: { selectionId: 's', label: 'X', file:'x.plan.json', raw: { v: 1, name: 'X', review:'checks', account: 'acct', model: 'opus', effort: 'low', permission: 'ask', steps: [{id:'a',title:'A',goal:'g'}] } } });
      const get = (s) => document.querySelector('[aria-label="Worker default ' + s + '"]');
      const result = { prompt: box.value, formHidden: box.closest('.form').hidden, account: get('account').value, model: get('model').value, effort: get('effort').value, permission: get('permission').value, runs: window.__posted.filter(m => m.type === 'startSelectedPlan').length };
      get('model').value = 'haiku'; get('model').dispatchEvent(new Event('change'));
      get('effort').value = 'high'; get('effort').dispatchEvent(new Event('change'));
      get('permission').value = 'bypass'; get('permission').dispatchEvent(new Event('change'));
      const preview = window.__posted.filter(m=>m.type==='previewSelectedPlan').at(-1);
      window.__host({planValidation:{selectionId:'s',revision:preview.revision,errors:[],plan:{account:'acct'},cards:[{step:{id:'a',title:'A'},after:[]}]}});
      [...document.querySelectorAll('button')].find(b => b.textContent === 'Run plan').click();
      return result;
    })()`);
    assert.deepEqual(loaded, { prompt: "unfinished task", formHidden: true, account: "acct", model: "opus", effort: "low", permission: "ask", runs: 0 });
    const started = await page.evaluate(`window.__posted.find(m => m.type === 'startSelectedPlan')`);
    assert.deepEqual(started.draft.defaults, { account: "acct", model: "haiku", effort: "high", permission: "bypass" });
    await page.evaluate(`window.__host({ planReady: true }); [...document.querySelectorAll('button')].find(b => b.textContent === 'Cancel plan').click(); true`);
    assert.deepEqual(await page.evaluate(`({ text: document.querySelector('textarea[data-draft-target="new"]').value, readOnly: document.querySelector('textarea[data-draft-target="new"]').readOnly, cancelled: window.__posted.some(m => m.type === 'cancelPlan') })`), { text: "unfinished task", readOnly: false, cancelled: true });
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* a temp folder */ }
  }
});
