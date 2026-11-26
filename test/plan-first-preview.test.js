// F99: Plan first's planning prompt is printed in the Add task form while the box is ticked, with the task as typed in place of
// {{task}}, so the user can read what the card will be sent. The real media/board.js in headless Edge or Chrome (compile-webview harness).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

test("F99 the planning prompt shows under the form only with Plan first ticked on a Claude or Codex account, and follows the prompt box; Codex fixes Astra at ultra", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) return t.skip("Microsoft Edge, Chrome or Chromium is unavailable");
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-plan-first-"));
  let edge, page;
  try {
    edge = await cdp.launchEdge(url, scratch);
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "the board");
    const planningPrompt = "Plan this task as an Entomatical plan file.\nIts format: C:\\x\\plan.schema.json\n\nTask:\n\n{{task}}";
    const state = { tasks: [], live: [], own: [], accounts: ["Claude", "Grok · work"], activeAccount: "Claude",
      externalProviders: { "Grok · work": "grok" }, planningPrompt };
    await page.evaluate(`window.__host(${JSON.stringify(state)}); true`);
    const view = () => page.evaluate(`(() => { const d = document.querySelector('details.plan-prompt'); const box = d.querySelector('textarea[aria-label="Planning prompt"]');
      return { hidden: d.hidden, open: d.open, text: box.value, summary: d.querySelector('summary').textContent }; })()`);
    const set = (js) => page.evaluate(`(() => { ${js}; return true; })()`);
    const tickPlanFirst = (on) => set(`const b = document.getElementById('planFirst'); b.checked = ${on}; b.dispatchEvent(new Event('change'))`);
    const type = (text) => set(`const p = document.querySelector('textarea[placeholder="Task prompt"]'); p.value = ${JSON.stringify(text)}; p.dispatchEvent(new Event('input'))`);
    await tickPlanFirst(false);
    assert.equal((await view()).hidden, true, "hidden while Plan first is off");
    await type("  Split the parser.  ");
    await tickPlanFirst(true);
    assert.deepEqual(await view(), { hidden: false, open: true, summary: "Planning prompt", text: planningPrompt.replace("{{task}}", "Split the parser.") });
    await type("Split the parser\ninto two files.");
    assert.equal((await view()).text, planningPrompt.replace("{{task}}", "Split the parser\ninto two files."), "it follows the prompt box");
    // Orchestrator ticked: the card runs headless, which has no plan mode, so no planning prompt is sent and none is shown.
    await set(`const o = document.getElementById('orchestrator'); o.checked = true; o.dispatchEvent(new Event('change'))`);
    assert.equal((await view()).hidden, true);
    await set(`const o = document.getElementById('orchestrator'); o.checked = false; o.dispatchEvent(new Event('change'))`);
    assert.equal((await view()).hidden, false);
    // A Grok account greys Plan first out, and the preview goes with it.
    await set(`const a = document.querySelector('[aria-label="Account for new task"]'); a.value = "Grok · work"; a.dispatchEvent(new Event('change'))`);
    assert.equal((await view()).hidden, true);
    // A Codex account (the user, 12 November 2026): Plan first stays on, shows the Codex planning prompt, and fixes the model and effort
    // menus to the newest Astra at ultra effort; unticking gives the picks back.
    const planningPromptCodex = "Plan this task. Codex has no plan mode here.\n\nTask:\n\n{{task}}";
    await page.evaluate(`window.__host(${JSON.stringify({ ...state, accounts: [...state.accounts, "Codex · x"], planningPromptCodex,
      codex: { accounts: ["Codex · x"], models: [{ model: "gpt-6.1-sol", efforts: ["low", "max"] }, { model: "gpt-6.1-astra", efforts: ["high", "ultra"] }],
        short: [{ name: "sol", id: "gpt-6.1-sol", label: "Sol" }, { name: "astra", id: "gpt-6.1-astra", label: "Astra" }] } })}); true`);
    const menus = () => page.evaluate(`['Model for new task', 'Effort for new task'].map(label => { const s = document.querySelector('select[aria-label="' + label + '"]');
      return { value: s.value, disabled: s.disabled, options: [...s.options].map(o => o.textContent) }; })`);
    await set(`const a = document.querySelector('[aria-label="Account for new task"]'); a.value = "Codex · x"; a.dispatchEvent(new Event('change'))`);
    assert.equal(await page.evaluate(`document.getElementById('planFirst').disabled`), false);
    assert.deepEqual(await view(), { hidden: false, open: true, summary: "Planning prompt", text: planningPromptCodex.replace("{{task}}", "Split the parser\ninto two files.") });
    assert.deepEqual(await menus(), [{ value: "astra", disabled: true, options: ["Astra (gpt-6.1-astra)"] }, { value: "ultra", disabled: true, options: ["ultra effort"] }]);
    const created = await page.evaluate(`(() => { window.__posted.length = 0; [...document.querySelectorAll('button')].find(b => b.textContent === 'Add task').click(); return window.__posted.find(m => m.type === 'create'); })()`);
    assert.deepEqual([created.account, created.planFirst, created.model, created.effort], ["Codex · x", true, "astra", "ultra"]);
    await tickPlanFirst(false);
    const after = await menus();
    assert.deepEqual([after[0].disabled, after[0].options[0], after[1].disabled], [false, "Default model", false]);
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* Edge may still hold a file */ }
  }
});
