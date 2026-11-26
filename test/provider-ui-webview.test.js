const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

test("external providers use their own task choices and expose a follow-up on an idle card", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) return t.skip("Microsoft Edge, Chrome or Chromium is unavailable");
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-provider-ui-"));
  let edge, page;
  try {
    edge = await cdp.launchEdge(url, scratch);
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "the board");
    const task = { id: "abc123", title: "Grok task", prompt: "Work", provider: "grok", status: "review", headless: true,
      sessionId: "session", worktree: "C:\\task", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      acpOptions: [{ id: "model", name: "Agent model", category: "model", currentValue: "default", values: [{ value: "default", name: "Default" }, { value: "other", name: "Other" }] },
        { id: "mode", name: "Mode", category: "mode", values: [{ value: "bypass", name: "Bypass" }] }] };
    // Fake ids only: the board has no static Grok or Antigravity list; the menus show what an account's agent last advertised (state.acpCatalogs).
    const state = { tasks: [task], live: [], own: [], accounts: ["Claude", "Grok · work", "Antigravity · Shared"], activeAccount: "Claude",
      externalProviders: { "Grok · work": "grok", "Antigravity · Shared": "antigravity" },
      // Fix 11 (F92): Antigravity's three terminal models (Carbon from 14 November 2026) as short names, each with the newest id `agy models` listed.
      antigravityModels: [["opus", "Opus (claude-opus-5-5)"], ["argon", "Argon (gemini-4-argon)"], ["carbon", "Carbon (gemini-4-carbon)"]],
      acpCatalogs: { "Grok · work": { at: "2026-11-06T10:00:00.000Z", models: [["fake-model-a", "Fake A"], ["fake-model-b", "Fake B"]], efforts: [["fake-effort-a", "Fake effort A"]] } } };
    await page.evaluate(`window.__host(${JSON.stringify(state)}); true`);
    const pick = (name) => `(() => { const a = document.querySelector('[aria-label="Account for new task"]'); a.value = ${JSON.stringify(name)}; a.dispatchEvent(new Event('change')); })()`;
    const menus = () => page.evaluate(`['Model for new task', 'Effort for new task', 'Permission mode for new task'].map(label => [...document.querySelector('select[aria-label="' + label + '"]').options].map(o => [o.value, o.textContent]))`);
    const tick = (on) => page.evaluate(`(() => { const o = document.getElementById('orchestrator'); o.checked = ${on}; o.dispatchEvent(new Event('change')); return true; })()`);
    const flags = () => page.evaluate(`Object.fromEntries(['autoTitle', 'autoRule', 'orchestrator', 'planFirst'].map(id => [id, document.getElementById(id).disabled]))`);
    // The account picker groups all four providers.
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('[aria-label="Account for new task"] optgroup')].map(g => g.label)`), ["Claude", "Grok", "Antigravity"]);
    // A Grok account with a catalog: its advertised models and efforts, the two ACP permission modes, and every toggle but Plan first.
    await page.evaluate(pick("Grok · work"));
    await tick(true);
    assert.deepEqual(await menus(), [
      [["", "Default model"], ["fake-model-a", "Fake A"], ["fake-model-b", "Fake B"]],
      [["", "Default effort"], ["fake-effort-a", "Fake effort A"]],
      [["ask", "Ask permissions"], ["bypass", "Bypass permissions"]]]);
    assert.deepEqual(await flags(), { autoTitle: false, autoRule: false, orchestrator: false, planFirst: true });
    // An Antigravity account that has advertised nothing yet says so, and still offers the toggles.
    await page.evaluate(pick("Antigravity · Shared"));
    assert.deepEqual((await menus()).slice(0, 2), [[["", "Default model (none seen yet)"]], [["", "Default effort (none seen yet)"]]]);
    assert.deepEqual(await flags(), { autoTitle: false, autoRule: false, orchestrator: false, planFirst: true });
    // Ask is offered only where the agent advertised a mode that asks first, and the tooltip names it; with none, Ask is not offered.
    const permissionTitle = () => page.evaluate(`document.querySelector('select[aria-label="Permission mode for new task"]').title`);
    await page.evaluate(`window.__host(${JSON.stringify({ ...state, acpCatalogs: { "Grok · work": { ...state.acpCatalogs["Grok · work"], ask: null },
      "Antigravity · Shared": { at: "2026-11-06T10:00:00.000Z", models: [], efforts: [], ask: "fake-ask-mode" } } })}); true`);
    await page.evaluate(pick("Grok · work"));
    assert.deepEqual((await menus())[2], [["bypass", "Bypass permissions"]]);
    assert.match(await permissionTitle(), /Grok · work advertises no mode that asks for approval, so Ask is not offered\./);
    await page.evaluate(pick("Antigravity · Shared"));
    assert.deepEqual((await menus())[2], [["ask", "Ask permissions"], ["bypass", "Bypass permissions"]]);
    assert.match(await permissionTitle(), /Ask runs it in the agent's advertised mode fake-ask-mode\./);
    await page.evaluate(`window.__host(${JSON.stringify(state)}); true`);
    // Orchestrator ticked on a Grok account with a model: the create message carries all of it (the host then runs the card unattended).
    const created = await page.evaluate(`(() => {
      ${pick("Grok · work")};
      const o = document.getElementById('orchestrator'); o.checked = true; o.dispatchEvent(new Event('change'));
      const m = document.querySelector('select[aria-label="Model for new task"]'); m.value = 'fake-model-a'; m.dispatchEvent(new Event('change'));
      const box = document.querySelector('textarea[data-draft-target="new"]'); box.value = 'Plan the work'; box.dispatchEvent(new Event('input'));
      window.__posted.length = 0;
      [...document.querySelectorAll('button')].find(b => b.textContent === 'Add task').click();
      return window.__posted.find(x => x.type === 'create');
    })()`);
    assert.equal(created.account, "Grok · work");
    assert.equal(created.model, "fake-model-a");
    assert.equal(created.mayOpen, true);
    assert.equal(created.planFirst, false);
    // Refine draft and Improve prompt are offered and run on that same Grok or Antigravity account, with the agent's default model.
    const helpers = () => page.evaluate(`({ refine: document.querySelector('[data-refine-start]').disabled, improve: document.querySelector('[data-compile-start]').disabled, line: document.querySelector('[data-refine-selection]').textContent })`);
    await page.evaluate(pick("Antigravity · Shared"));
    let h = await helpers();
    assert.equal(h.refine, false);
    assert.equal(h.improve, false);
    assert.equal(h.line, "Uses the agent's default model · Antigravity · Shared");
    // No Claude default account is needed: they never run on Claude for a Grok or Antigravity account.
    await page.evaluate(`window.__host(${JSON.stringify({ ...state, activeAccount: "" })}); true`);
    await page.evaluate(pick("Grok · work"));
    h = await helpers();
    assert.equal(h.refine, false);
    assert.equal(h.line, "Uses the agent's default model · Grok · work");
    assert.doesNotMatch(h.line, /Claude IDE default|require a Claude or Codex/);
    const tips = await page.evaluate(`[...document.querySelectorAll('label')].map((l) => l.title).filter((t) => /named from its prompt|writes the task's goal/.test(t))`);
    assert.equal(tips.length, 2);
    for (const tip of tips) { assert.match(tip, /the agent's default model on the task's own/); assert.doesNotMatch(tip, /Claude IDE default account for a (Codex, )?Grok/); }
    await page.evaluate(`window.__host(${JSON.stringify(state)}); true`);
    await page.evaluate(pick("Grok · work"));
    // In the provider's own terminal (Orchestrator unticked), F88: Antigravity's fixed list, every permission mode, Bypass preselected.
    await tick(false);
    // F88: Antigravity offers exactly its three models (Opus, Argon, Carbon) and agy's effort levels, with Opus at high preselected, and every permission mode.
    const agy = await page.evaluate(`(() => {
      const account = document.querySelector('[aria-label="Account for new task"]');
      account.value = 'Antigravity · Shared'; account.dispatchEvent(new Event('change'));
      return ['Model for new task', 'Effort for new task', 'Permission mode for new task'].map(label => { const s = document.querySelector('select[aria-label="' + label + '"]');
        return { values: [...s.options].map(o => o.value), labels: [...s.options].map(o => o.textContent), value: s.value }; });
    })()`);
    assert.deepEqual(agy.map((x) => x.values), [["opus", "argon", "carbon"], ["low", "medium", "high"], ["ask", "edits", "auto", "bypass"]]);
    assert.deepEqual(agy[0].labels, ["Opus (claude-opus-5-5)", "Argon (gemini-4-argon)", "Carbon (gemini-4-carbon)"]);
    assert.deepEqual(agy.map((x) => x.value), ["opus", "high", "bypass"]);
    const claude = await page.evaluate(`(() => { const a = document.querySelector('[aria-label="Account for new task"]'); a.value = 'Claude'; a.dispatchEvent(new Event('change'));
      const s = document.querySelector('select[aria-label="Permission mode for new task"]'); return { values: [...s.options].map(o => o.value), value: s.value }; })()`);
    assert.deepEqual(claude, { values: ["ask", "edits", "auto", "bypass"], value: "bypass" });
    await page.evaluate(`(() => { const a = document.querySelector('[aria-label="Account for new task"]'); a.value = 'Antigravity · Shared'; a.dispatchEvent(new Event('change')); return true; })()`);
    const createdAgy = await page.evaluate(`(() => { window.__posted.length = 0;
      const pick = (label, value) => { const s = document.querySelector('select[aria-label="' + label + '"]'); s.value = value; s.dispatchEvent(new Event('change')); };
      pick('Model for new task', 'carbon'); pick('Permission mode for new task', 'edits');
      const box = document.querySelector('textarea[data-draft-target="new"]'); box.value = 'Check the Antigravity form'; box.dispatchEvent(new Event('input'));
      [...document.querySelectorAll('button')].find(b => b.textContent === 'Add task').click(); return window.__posted.find(m => m.type === 'create'); })()`);
    assert.deepEqual([createdAgy.account, createdAgy.model, createdAgy.effort, createdAgy.permission], ["Antigravity · Shared", "carbon", "high", "edits"]);
    // F88 (the user, 6 November 2026, "List agy's own models"): a sign-in whose agy models lists neither of the two offers agy's own, at its own effort.
    const agyListed = [["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"], ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"]];
    await page.evaluate(`window.__host(${JSON.stringify({ ...state, antigravityModels: agyListed })}); true`);
    const listed = await page.evaluate(`(() => { const a = document.querySelector('[aria-label="Account for new task"]');
      a.value = 'Claude'; a.dispatchEvent(new Event('change')); a.value = 'Antigravity · Shared'; a.dispatchEvent(new Event('change'));
      return ['Model for new task', 'Effort for new task'].map(label => { const s = document.querySelector('select[aria-label="' + label + '"]');
        return { values: [...s.options].map(o => o.value), labels: [...s.options].map(o => o.textContent), value: s.value }; }); })()`);
    assert.deepEqual(listed, [{ values: ["gemini-3.8-flash-low", "claude-sonnet-4-6"], labels: ["Gemini 3.8 Flash (Low)", "Claude Sonnet 4.6 (Thinking)"], value: "gemini-3.8-flash-low" },
      { values: [""], labels: ["Default effort"], value: "" }]);
    // Before agy has answered (no list in the state): the user's three as short names, "(newest)".
    await page.evaluate(`window.__host(${JSON.stringify({ ...state, antigravityModels: [] })}); true`);
    const fallback = await page.evaluate(`(() => { const a = document.querySelector('[aria-label="Account for new task"]');
      a.value = 'Claude'; a.dispatchEvent(new Event('change')); a.value = 'Antigravity · Shared'; a.dispatchEvent(new Event('change'));
      return [...document.querySelector('select[aria-label="Model for new task"]').options].map(o => [o.value, o.textContent]); })()`);
    assert.deepEqual(fallback, [["opus", "Opus (newest)"], ["argon", "Argon (newest)"], ["carbon", "Carbon (newest)"]]);
    // A sign-in that lists no Carbon (the host sends only Opus and Argon): the menu shows only those two, as before.
    await page.evaluate(`window.__host(${JSON.stringify({ ...state, antigravityModels: state.antigravityModels.slice(0, 2) })}); true`);
    const noCarbon = await page.evaluate(`(() => { const a = document.querySelector('[aria-label="Account for new task"]');
      a.value = 'Claude'; a.dispatchEvent(new Event('change')); a.value = 'Antigravity · Shared'; a.dispatchEvent(new Event('change'));
      return [...document.querySelector('select[aria-label="Model for new task"]').options].map(o => o.value); })()`);
    assert.deepEqual(noCarbon, ["opus", "argon"]);
    await page.evaluate(`window.__host(${JSON.stringify(state)}); true`);
    const optionMessage = await page.evaluate(`(() => { window.__posted.length = 0; const s = document.querySelector('select[aria-label="Agent model"]'); s.value = 'other'; s.dispatchEvent(new Event('change')); return window.__posted.at(-1); })()`);
    assert.deepEqual(optionMessage, { type: "setAcpOption", id: "abc123", optionId: "model", value: "other" });
    assert.equal(await page.evaluate(`document.querySelector('select[aria-label="Mode"]')`), null);
    await page.evaluate(`document.querySelector('.card[data-task="abc123"] button:nth-of-type(1)').click(); true`);
    assert.equal(await page.evaluate(`!!document.querySelector('textarea[data-draft-target="abc123"]')`), true);
    const message = await page.evaluate(`(() => { window.__posted.length = 0; const box = document.querySelector('textarea[data-draft-target="abc123"]'); box.value = 'Continue the review'; box.dispatchEvent(new Event('input')); [...document.querySelectorAll('.card[data-task="abc123"] button')].find(b => b.textContent === 'Send').click(); return window.__posted.at(-1); })()`);
    assert.equal(message.type, "send");
    assert.equal(message.id, "abc123");
    assert.equal(message.text, "Continue the review");
    await page.evaluate(`window.__host({failed:${JSON.stringify(message)}}); window.__host(${JSON.stringify(state)}); true`);
    assert.equal(await page.evaluate(`document.querySelector('textarea[data-draft-target="abc123"]').value`), "Continue the review");
    // Fix 11 (F92): a Codex account's menu lists its short names with the id each runs now, the efforts of that id, and Session details
    // show the short name with the id it runs.
    await page.evaluate(`window.__host(${JSON.stringify({ ...state, accounts: [...state.accounts, "Codex · x"], defaultModels: { "Codex · x": "Sol 6.1" }, tasks: [{ ...task, id: "cdx001", provider: "codex", model: "sol", runModel: "gpt-6.1-sol", acpOptions: undefined }],
      codex: { accounts: ["Codex · x"], models: [{ model: "gpt-6.1-sol", label: "Sol 6.1", efforts: ["low", "xhigh"] }, { model: "gpt-6-sol", label: "Sol 6", efforts: ["low"] }], short: [{ name: "sol", id: "gpt-6.1-sol", label: "Sol" }] } })}); true`);
    const codex = await page.evaluate(`(() => { ${pick("Codex · x")};
      const m = document.querySelector('select[aria-label="Model for new task"]'), before = [...m.options].map(o => [o.value, o.textContent]);
      m.value = 'gpt-6.1-sol'; m.dispatchEvent(new Event('change'));
      return { before, title: m.title, efforts: [...document.querySelector('select[aria-label="Effort for new task"]').options].map(o => o.value),
        meta: document.querySelector('.card[data-task="cdx001"] .meta').textContent }; })()`);
    assert.deepEqual(codex.before, [["", "Default: Sol 6.1"], ["gpt-6.1-sol", "Sol 6.1 (gpt-6.1-sol)"], ["gpt-6-sol", "Sol 6 (gpt-6-sol)"]], "F123: every listed model, and the default by name");
    assert.equal(codex.title, "Model for new task");
    assert.deepEqual(codex.efforts, ["", "low", "xhigh"]);
    assert.match(codex.meta, / · sol → gpt-6\.1-sol · /);
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* browser may still hold the directory */ }
  }
});
