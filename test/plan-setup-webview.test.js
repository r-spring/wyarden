const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cdp = require("./compile-webview-cdp");

test("plan setup preserves exceptions, rejects stale previews, confirms bulk reset and gates a single run", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) return t.skip("No Edge/Chrome/Chromium: browser acceptance not run.");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-plan-setup-"));
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  let browser, page;
  try {
    browser = await cdp.launchEdge(url, scratch);
    const target = await cdp.waitFor(async () => (await cdp.listTargets(browser.port)).find((x) => x.type === "page" && x.url === url), "harness");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await page.evaluate(fs.readFileSync(path.resolve(__dirname, "../media/plan-setup.js"), "utf8"));
    await page.evaluate(`(() => {const style=document.createElement('style');style.textContent=${JSON.stringify(fs.readFileSync(path.resolve(__dirname, "../media/plan-setup.css"), "utf8"))};document.head.append(style);})()`);
    await page.evaluate(`(() => {
      window.setupMessages = []; window.setup = createPlanSetup({send:(type, data) => setupMessages.push({type,...data}), onCancel:()=>window.cancelled=true});
      document.body.replaceChildren(setup.element);
      setup.load({selectionId:'s',file:'workflows/example.json',raw:{v:1,name:'Example',review:'model',reviewer:{model:'sonnet',permission:'auto'},account:'acct',model:'opus',vars:{areas:'one\\ntwo'},steps:[{id:'a',title:'A',goal:'Goal',model:'missing',each:'areas'}]}},{accounts:['acct']});
    })()`);
    assert.equal(await page.evaluate(`setupMessages.find(m=>m.type==='previewSelectedPlan').draft.steps.a.model`), "missing");
    const source = await page.evaluate(`setup.getSelection().raw`);
    const apply = require("../out/plan-setup").applyPlanSetup;
    const preview = apply(source, await page.evaluate(`setupMessages.find(m=>m.type==='previewSelectedPlan').draft`));
    assert.deepEqual(preview.errors, undefined);
    assert.deepEqual(preview.raw.reviewer, source.reviewer);
    assert.match(await page.evaluate(`setup.element.textContent`), /Reviewer permissions: auto/);
    for (const mayOpen of [true, false]) {
      await page.evaluate(`setup.validation({selectionId:'s',revision:1,errors:[],plan:{review:'model',mayOpen:${mayOpen}},cards:[]}); true`);
      assert.equal(await page.evaluate(`setup.element.querySelector('#plan-setup-summary').textContent.includes('reviewer may open additional cards')`), mayOpen);
    }
    for (const permission of ["auto", "bypass"]) {
      const showsBypass = await page.evaluate(`(() => {
        setup.validation({selectionId:'s',revision:1,errors:[],plan:{review:'model',permission:'auto',reviewer:{permission:'${permission}'}},cards:[]});
        return !!setup.element.querySelector('.plan-setup-permission-note');
      })()`);
      assert.equal(showsBypass, permission === "bypass");
    }
    assert.equal(await page.evaluate(`document.querySelector('[aria-label="Step a model"]').selectedOptions[0].textContent`), "missing (not currently offered)");
    await page.evaluate(`(() => { const e=document.querySelector('[aria-label="Worker default model"]');e.value='haiku';e.dispatchEvent(new Event('change')); })()`);
    assert.equal(await page.evaluate(`setup.getDraft().steps.a.model`), "missing");
    await page.evaluate(`setup.validation({selectionId:'s',revision:1,errors:[],cards:[]})`);
    assert.equal(await page.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Run plan').disabled`), true);
    await page.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Apply defaults to all steps').click()`);
    assert.equal(await page.evaluate(`setup.getDraft().steps.a.model`), "missing");
    await page.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Remove step overrides').click()`);
    assert.deepEqual(await page.evaluate(`setup.getDraft().steps.a`), { model: null });
    await page.evaluate(`setup.validation({selectionId:'s',revision:setupMessages.at(-1).revision,errors:['Step "a" has a problem'],cards:[]})`);
    assert.match(await page.evaluate(`document.querySelector('[role="alert"]').textContent`), /has a problem/);
    await page.evaluate(`setup.validation({selectionId:'s',revision:setupMessages.at(-1).revision,errors:[],plan:{account:'acct'},cards:[{step:{id:'a',title:'A',goal:'Goal'},after:[]}]}); [...document.querySelectorAll('button')].find(b=>b.textContent==='Run plan').click(); [...document.querySelectorAll('button')].find(b=>b.textContent==='Starting plan…').click();`);
    assert.equal(await page.evaluate(`setupMessages.filter(m=>m.type==='startSelectedPlan').length`), 1);
    const launch = apply(source, await page.evaluate(`setupMessages.find(m=>m.type==='startSelectedPlan').draft`));
    assert.deepEqual(launch.raw.reviewer, source.reviewer);
    const snapshot = await page.evaluate(`(() => {const d=setup.getDraft(); d.defaults.model='opus'; return setup.getDraft().defaults.model;})()`);
    assert.equal(snapshot, "haiku");
    await page.evaluate(`setup.ready()`);
    for (const width of [180, 284, 360, 900, 1400]) {
      const overflow = await page.evaluate(`(() => {setup.element.style.width='${width}px'; const r=setup.element.getBoundingClientRect();return [...setup.element.querySelectorAll('select,textarea,button,details')].filter(e=>e.getBoundingClientRect().right>r.right+1).map(e=>e.tagName);})()`);
      assert.deepEqual(overflow, [], `controls fit ${width}px`);
    }
    await page.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Cancel plan').click()`);
    assert.equal(await page.evaluate(`window.cancelled`), true);
  } finally {
    page?.close(); if (browser) await browser.kill();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
