const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cdp = require("./compile-webview-cdp");

test("plan setup tabs preserve drafts, expose errors and fit narrow sidebars", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) return t.skip("No browser available; plan navigation acceptance was not run.");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-plan-navigation-"));
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  let browser, page;
  try {
    browser = await cdp.launchEdge(url, scratch);
    const target = await cdp.waitFor(async () => (await cdp.listTargets(browser.port)).find((x) => x.type === "page" && x.url === url), "navigation harness");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board ready");
    await page.evaluate(`(() => {
      window.navSource={v:1,name:'A representative plan with a long descriptive title',about:'Review several areas and preserve the source plan.',review:'model',account:'acct',model:'opus',reviewer:{model:'haiku'},vars:{areas:'first\\nsecond'},scribe:{documents:['README.md'],after:['a']},steps:[
        {id:'a',title:'Alpha with a long title that must wrap inside a narrow sidebar',goal:'long-goal-'.repeat(25),each:'areas',model:'sonnet',checks:[]},
        {id:'b',title:'Beta',goal:'Review results',after:['a'],checks:[]},
        {id:'c',title:'Gamma',goal:'Integrate results',after:['b'],checks:[]}]};
      __host({tasks:[],live:[],own:[],accounts:['acct']});
      __host({selectedPlan:{selectionId:'navigation',file:'workflows/long-path/example.plan.json',raw:navSource}});
      window.navPreview=(errors=[])=>{const request=__posted.filter(m=>m.type==='previewSelectedPlan').at(-1);__host({planValidation:{selectionId:'navigation',revision:request.revision,errors,plan:navSource,cards:navSource.steps.map(step=>({step,after:step.after||[]}))}});};
      window.navTab=id=>document.querySelector('#plan-tab-'+id).click();
      window.navRun=()=>[...document.querySelectorAll('.plan-setup button')].find(b=>b.textContent==='Run plan');
      window.navVisible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
      __host({planPresets:{selectionId:'navigation',presets:[{id:'first',name:'First preset',settings:{}},{id:'second',name:'Second preset with a very long name',settings:{model:'haiku'}}]}});
    })()`);
    assert.deepEqual(await page.evaluate(`({selected:document.querySelector('[role=tab][aria-selected=true]').textContent,panels:[...document.querySelectorAll('[role=tabpanel]')].filter(navVisible).map(e=>e.id),disabled:navRun().disabled})`), { selected: "Setup", panels: ["plan-panel-setup"], disabled: true });
    await t.test("arrow keys use roving focus and hide inactive panels", async () => {
      await page.evaluate(`document.querySelector('#plan-tab-setup').focus()`);
      for (const [key, expected] of [["ArrowRight", "Steps"], ["End", "Presets"], ["ArrowRight", "Setup"], ["Home", "Setup"]]) {
        await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key });
        const state = await page.evaluate(`({active:document.activeElement.textContent,selected:document.querySelector('[role=tab][aria-selected=true]').textContent,stops:[...document.querySelectorAll('[role=tab]')].filter(e=>e.tabIndex===0).length,panels:[...document.querySelectorAll('[role=tabpanel]')].filter(navVisible).length})`);
        assert.deepEqual(state, { active: expected, selected: expected, stops: 1, panels: 1 });
      }
    });
    await t.test("preview retains active tab, typed variable and preset state", async () => {
      await page.evaluate(`(() => {const variable=document.querySelector('[aria-label="Variable areas"]');variable.value='edited first\\nedited second\\n';variable.dispatchEvent(new Event('input'));navTab('presets');document.querySelector('[aria-label="Personal settings preset"]').value='second';document.querySelector('[aria-label="Preset name"]').value='unfinished preset';navPreview();})()`);
      assert.deepEqual(await page.evaluate(`({selected:document.querySelector('[role=tab][aria-selected=true]').textContent,variable:document.querySelector('[aria-label="Variable areas"]').value,preset:document.querySelector('[aria-label="Personal settings preset"]').value,name:document.querySelector('[aria-label="Preset name"]').value,labels:[...document.querySelectorAll('.plan-presets-fields label > span')].map(e=>e.textContent)})`), { selected: "Presets", variable: "edited first\nedited second\n", preset: "second", name: "unfinished preset", labels: ["Saved preset", "Preset name"] });
      await page.evaluate(`navTab('dependencies');[...document.querySelectorAll('button')].find(b=>b.textContent==='Move b up').click();navPreview();navTab('setup');navTab('dependencies');`);
      assert.deepEqual(await page.evaluate(`({first:document.querySelector('[data-step]').dataset.step,order:__posted.filter(m=>m.type==='previewSelectedPlan').at(-1).draft.order})`), { first: "b", order: ["b", "a", "c"] });
    });
    await t.test("summary and validation gate remain available in every tab", async () => {
      for (const errors of [[`Step "b" has an invalid dependency`], []]) {
        await page.evaluate(`navPreview(${JSON.stringify(errors)})`);
        for (const id of ["setup", "steps", "dependencies", "presets"]) {
          assert.deepEqual(await page.evaluate(`(() => {navTab('${id}');return {summary:navVisible(document.querySelector('#plan-setup-summary')),run:navVisible(navRun()),disabled:navRun().disabled,hidden:[...document.querySelectorAll('[role=tabpanel]')].filter(e=>e.hidden).every(e=>!navVisible(e))};})()`), { summary: true, run: true, disabled: errors.length > 0, hidden: true });
        }
      }
      await page.evaluate(`navPreview(['Step "b" has an invalid dependency']);document.querySelector('#plan-setup-summary [role=alert] a').click()`);
      assert.deepEqual(await page.evaluate(`({tab:document.querySelector('[role=tab][aria-selected=true]').textContent,open:document.querySelector('#plan-setup-step-b').open,visible:navVisible(document.querySelector('#plan-setup-step-b')),focused:document.activeElement.id})`), { tab: "Steps", open: true, visible: true, focused: "plan-setup-step-b" });
      await page.evaluate(`navPreview()`);
    });
    await t.test("visible controls fit all supported widths including graph and presets", async () => {
      for (const width of [180, 284, 360, 900, 1400]) {
        for (const id of ["setup", "steps", "dependencies", "presets"]) {
          const overflow = await page.evaluate(`(() => {const root=document.querySelector('.plan-setup');root.style.width='${width}px';root.style.maxWidth='none';navTab('${id}');root.querySelectorAll('#plan-panel-${id} details').forEach(e=>e.open=true);const bounds=root.getBoundingClientRect();return [...root.querySelectorAll('input,textarea,select,button')].filter(navVisible).filter(e=>{const r=e.getBoundingClientRect();return r.right>bounds.right+1||r.left<bounds.left-1;}).map(e=>e.getAttribute('aria-label')||e.textContent);})()`);
          assert.deepEqual(overflow, [], `${id} controls fit ${width}px`);
        }
      }
    });
    await t.test("the run action stays in view while scrolling a narrow setup", async () => {
      await page.send("Emulation.setDeviceMetricsOverride", { width: 284, height: 600, deviceScaleFactor: 1, mobile: false });
      const observed = await page.evaluate(`(() => {const root=document.querySelector('.plan-setup');root.style.width='100%';root.style.maxWidth='';navTab('setup');root.scrollIntoView({block:'start'});const r=navRun().getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight};})()`);
      assert.ok(observed.top >= 0 && observed.bottom <= observed.height, `run action stays in the ${observed.height}px viewport`);
      await page.send("Emulation.clearDeviceMetricsOverride");
    });
    await t.test("role error links reveal their fields inside the roles disclosure", async () => {
      for (const [message, label] of [
        ['"reviewer.model" is not offered.', 'Reviewer model'],
        ['"scribe.documents" must name a document.', 'Scribe documents'],
        ['"scribe.after" must name a source step.', 'Scribe milestones'],
      ]) {
        const observed = await page.evaluate(`(() => {
          document.querySelector('.plan-setup-roles').open=false;navTab('presets');
          navPreview([${JSON.stringify(message)}]);
          document.querySelector('#plan-setup-summary [role=alert] a').click();
          return {tab:document.querySelector('[role=tab][aria-selected=true]').textContent,open:document.querySelector('.plan-setup-roles').open,focus:document.activeElement.getAttribute('aria-label'),visible:navVisible(document.activeElement)};
        })()`);
        assert.deepEqual(observed, { tab: "Setup", open: true, focus: label, visible: true }, message);
      }
      await page.evaluate(`navPreview()`);
    });
    await t.test("dependency selection and Goal disclosure survive asynchronous updates", async () => {
      await page.evaluate(`(() => {navTab('dependencies');const choice=document.querySelector('[aria-label="Dependency for a"]');choice.value='c';choice.dispatchEvent(new Event('change'));choice.focus();document.querySelector('[data-step="a"] > details').open=true;})()`);
      for (const update of ["navPreview()", "__host({tasks:[],live:[],own:[],accounts:['acct']})"]) {
        await page.evaluate(update);
        assert.deepEqual(await page.evaluate(`({selected:document.querySelector('[aria-label="Dependency for a"]').value,open:document.querySelector('[data-step="a"] > details').open,focused:document.activeElement.getAttribute('aria-label'),tab:document.querySelector('[role=tab][aria-selected=true]').textContent})`), { selected: "c", open: true, focused: "Dependency for a", tab: "Dependencies" });
      }
    });
    const effects = await page.evaluate(`__posted.filter(m=>['startSelectedPlan','savePlanAs','savePlanPreset','renamePlanPreset','deletePlanPreset'].includes(m.type)).map(m=>m.type)`);
    assert.deepEqual(effects, [], "navigation, preview and graph draft changes have no execution or save effects");
    assert.equal(await page.evaluate(`navSource.steps[0].model`), "sonnet", "source settings remain intact");
    await t.test("empty preset selector stays intrinsically disabled through preview and launch cycles", async () => {
      await page.evaluate(`__host({planPresets:{selectionId:'navigation',presets:[]}});navTab('presets')`);
      for (const update of ["navPreview()", "navRun().click()", "__host({planReady:true})", "navPreview()", "navRun().click()", "__host({planReady:true})"]) {
        await page.evaluate(update);
        assert.deepEqual(await page.evaluate(`({disabled:document.querySelector('[aria-label="Personal settings preset"]').disabled,text:document.querySelector('[aria-label="Personal settings preset"] option').textContent})`), { disabled: true, text: "No saved presets" }, update);
      }
      assert.equal(await page.evaluate(`__posted.filter(m=>m.type==='startSelectedPlan').length`), 2);
    });
  } finally {
    page?.close(); if (browser) await browser.kill();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
