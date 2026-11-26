const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cdp = require("./compile-webview-cdp");

test("assembled plan setup handles malformed source, multiline roles, graph edits, launch locks and composer restoration", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) return t.skip("No browser available; assembled webview acceptance was not run.");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-plan-integration-"));
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  let browser, page;
  try {
    browser = await cdp.launchEdge(url, scratch);
    const target = await cdp.waitFor(async () => (await cdp.listTargets(browser.port)).find((x) => x.type === "page" && x.url === url), "assembled harness");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board ready");
    await t.test("F116: setup and effective settings disclose the judge's mode and warn only for roles using bypass", async () => {
      const { validatePlanFile } = require("../out/plan");
      const profiles = ["claude", "codex", "grok", "antigravity"].map(provider => ({
        provider, name: `${provider} · fixture`, models: [{ id: "fixture-model", efforts: [] }],
        permissions: provider === "claude" ? ["ask", "edits", "bypass"] : provider === "codex" ? ["ask", "auto", "bypass"] : ["ask", "bypass"],
      }));
      const rules = { profiles, defaultAccount: profiles[0].name, models: [], efforts: [], permissions: [], maxSteps: 3, catalogue: { unit: { run: "true" } } };
      const cases = [
        // Only the plan default is bypass: the judge overrides it, and the actual worker and reviewer use edits.
        [undefined, "bypass", "edits", false, /Claude plan mode/, false],
        [undefined, "bypass", "edits", true, /Claude plan mode/, true],
        [undefined, "ask", "bypass", false, /Claude plan mode/, true],
        ["codex", "ask", "ask", false, /Codex read-only sandbox.*approval policy on-request/, false],
        ["codex", "auto", "ask", false, /Codex read-only sandbox.*approval policy on-request/, false],
        ["codex", "bypass", "ask", false, /Codex read-only sandbox.*approval policy never/, false],
        ["grok", undefined, "ask", false, /Grok.*board setting is bypass.*allows an eligible read request once.*leaves the provider mode unchanged.*refuses non-read ACP/i, true],
        ["antigravity", "ask", "ask", false, /Antigravity.*board setting is ask.*advertised approval mode.*may be named plan.*refuses non-read ACP/i, false],
      ];
      for (const [account, permission, worker, scribe, mode, warning] of cases) {
        const raw = { v: 1, name: "Judge permissions", review: "model", reviewer: { account: profiles[0].name, permission: "edits" },
          account, permission, judge: "fixture-model", steps: [{ id: "a", title: "Work", goal: "G", judge: true, checks: ["unit"], permission: worker }],
          ...(scribe && { scribe: { documents: ["report.md"], after: ["a"] } }) };
        const checked = validatePlanFile(raw, rules);
        assert.equal(checked.errors, undefined);
        const observed = await page.evaluate(`(() => {
          __host({selectedPlan:{selectionId:'judge',file:'judge.json',raw:${JSON.stringify(raw)}}});
          const {selectionId, revision} = __posted.filter(m => m.type === 'previewSelectedPlan').at(-1);
          __host({planValidation:{selectionId,revision,errors:[],...${JSON.stringify(checked)}}});
          return {roles:document.querySelector('.plan-setup-roles').textContent,
            preview:document.querySelector('.plan-setup-review').textContent,
            warning:!!document.querySelector('.plan-setup-permission-note')};
        })()`);
        assert.match(observed.roles, mode);
        assert.match(observed.preview, mode);
        assert.equal(observed.warning, warning);
      }
      await page.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Cancel plan').click()`);
    });
    for (const review of ["checks", "model"]) {
      await t.test(`F119: ${review}-reviewed plan preview shows the delegation and required delivery commands`, async () => {
        const { applyPlanSetup } = require("../out/plan-setup");
        const { validatePlanFile } = require("../out/plan");
        const raw = { v: 1, name: "Delegation", review, ...(review === "model" ? { deliveryChecks: ["suite"] } : {}), steps: [
          { id: "prep", title: "Prepare", goal: "Prepare the work.", checks: ["unit"] },
          { id: "lead", title: "Lead", goal: "Open and accept a helper.", checks: ["unit"], after: ["prep"], mayOpen: true },
          { id: "plain", title: "Plain", goal: "Do the work.", checks: ["unit"], mayOpen: false },
        ] };
        const request = await page.evaluate(`(() => {
          __host({selectedPlan:{selectionId:'delegation',file:'delegation.plan.json',raw:${JSON.stringify(raw)}}});
          return __posted.filter(m=>m.type==='previewSelectedPlan').at(-1);
        })()`);
        const applied = applyPlanSetup(raw, request.draft);
        assert.equal(applied.errors, undefined);
        const catalogue = { unit: { run: "true" }, suite: { run: "npm test" } };
        const checked = validatePlanFile(applied.raw, { catalogue, models: [], efforts: [], permissions: [], maxSteps: 3 }, applied.vars);
        assert.equal(checked.errors, undefined);
        const validation = { selectionId: request.selectionId, revision: request.revision, errors: [], ...checked, catalogue };
        const lines = await page.evaluate(`(() => {
          __host({planValidation:${JSON.stringify(validation)}});
          const disclosure = document.querySelector('.plan-setup-review');
          disclosure.querySelector('summary').click();
          return [...disclosure.querySelectorAll('.plan-setup-effective li')].map(row=>row.innerText);
        })()`);
        const summary = await page.evaluate('document.querySelector("#plan-setup-summary").innerText');
        if (review === "model") assert.match(summary, /Required on the integrated commit: npm test\./);
        else assert.doesNotMatch(summary, /Required on the integrated commit/);
        await page.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Cancel plan').click()`);
        assert.match(lines[0], /^Prepare: .* · no dependencies$/);
        assert.match(lines[1], /^Lead: .* · depends on prep · may open its own cards$/);
        assert.match(lines[2], /^Plain: .* · no dependencies$/);
        assert.equal(lines.filter(line => line.includes("may open its own cards")).length, 1);
      });
    }
    await t.test("malformed scribe and step arrays remain recoverable with host errors", async () => {
      const observed = await page.evaluate(`(() => {
        window.__uiErrors=[]; window.addEventListener('error',e=>__uiErrors.push(e.message));
        document.querySelector('textarea[data-draft-target="new"]').value='ordinary draft';
        __host({selectedPlan:{selectionId:'bad',file:'bad.json',raw:{v:1,name:'Bad',review:'checks',scribe:{},steps:[{id:'a',title:'A',goal:'g',files:'invalid',avoid:9,checks:'invalid',after:'invalid'}]}}});
        const request=__posted.filter(m=>m.type==='previewSelectedPlan').at(-1);
        if(request)__host({planValidation:{selectionId:'bad',revision:request.revision,errors:['"scribe.documents" must name a document.','Step "a" files must be a list.']}});
        return {errors:__uiErrors,alert:document.querySelector('.plan-setup [role="alert"]')?.textContent,cancel:[...document.querySelectorAll('button')].some(b=>b.textContent==='Cancel plan')};
      })()`);
      assert.deepEqual(observed.errors, []);
      assert.match(observed.alert, /scribe.documents/);
      assert.equal(observed.cancel, true);
      await page.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Cancel plan').click()`);
    });
    await t.test("setup receives focus and preserves a scribe trailing newline across preview", async () => {
      const observed = await page.evaluate(`(() => {
        __host({selectedPlan:{selectionId:'good',file:'good.json',raw:{v:1,name:'Good',review:'checks',scribe:{model:'opus',documents:['README.md'],after:['a']},steps:[{id:'a',title:'Alpha',goal:'one',checks:[]},{id:'b',title:'Beta',goal:'two',checks:[],after:['a']}]}}});
        const focused=document.activeElement.classList.contains('plan-setup');
        document.querySelector('.plan-setup-roles').open=true;
        const input=document.querySelector('[aria-label="Scribe documents"]');input.focus();input.value='README.md\\n';input.dispatchEvent(new Event('input'));
        const request=__posted.filter(m=>m.type==='previewSelectedPlan').at(-1);
        __host({planValidation:{selectionId:'good',revision:request.revision,errors:[],plan:{},cards:[]}});
        return {focused,value:document.querySelector('[aria-label="Scribe documents"]').value,active:document.activeElement.getAttribute('aria-label')};
      })()`);
      assert.equal(observed.focused, true);
      assert.equal(observed.value, "README.md\n");
      assert.equal(observed.active, "Scribe documents");
    });
    await t.test("graph edits agree with visible steps and outgoing draft", async () => {
      const observed = await page.evaluate(`(() => {
        [...document.querySelectorAll('button')].find(b=>b.textContent==='Move b up').click();
        [...document.querySelectorAll('button')].find(b=>b.textContent==='Remove a from b').click();
        const request=__posted.filter(m=>m.type==='previewSelectedPlan').at(-1);
        return {order:request.draft.order,after:request.draft.dependencies.b,first:document.querySelector('[id^="plan-setup-step-"] summary').textContent,body:document.querySelector('#plan-setup-step-b').textContent};
      })()`);
      assert.deepEqual(observed.order, ["b", "a"]);
      assert.deepEqual(observed.after, []);
      assert.match(observed.first, /Beta/);
      assert.match(observed.body, /Waits for: nothing/);
    });
    await t.test("pending launch makes graph and presets inert", async () => {
      const observed = await page.evaluate(`(() => {
        const request=__posted.filter(m=>m.type==='previewSelectedPlan').at(-1);
        __host({planValidation:{selectionId:'good',revision:request.revision,errors:[],plan:{},cards:[]}});
        [...document.querySelectorAll('button')].find(b=>b.textContent==='Run plan').click();
        const graph=[...document.querySelectorAll('h3')].find(e=>e.textContent==='Dependencies').parentElement;
        const presets=document.querySelector('[aria-label="Personal settings preset"]').closest('[role="tabpanel"]');
        return {graph:graph.inert,presets:presets.inert,cancel:[...document.querySelectorAll('button')].find(b=>b.textContent==='Cancel plan').disabled,runs:__posted.filter(m=>m.type==='startSelectedPlan').length};
      })()`);
      assert.equal(observed.graph, true); assert.equal(observed.presets, true);
      assert.equal(observed.cancel, true); assert.equal(observed.runs, 1);
    });
    await t.test("host refusal unlocks setup and cancel restores ordinary composer", async () => {
      const observed = await page.evaluate(`(() => {
        __host({planReady:true});
        [...document.querySelectorAll('button')].find(b=>b.textContent==='Cancel plan').click();
        const prompt=document.querySelector('textarea[data-draft-target="new"]');
        return {text:prompt.value,focus:document.activeElement===prompt,hidden:prompt.closest('section').hidden,cancelled:__posted.some(m=>m.type==='cancelPlan')};
      })()`);
      assert.deepEqual(observed, { text: "ordinary draft", focus: true, hidden: false, cancelled: true });
    });
    await t.test("default Codex and Codex alias offer advertised standing-role models", async () => {
      for (const account of [undefined, "codex"]) {
        const observed = await page.evaluate(`(() => {
          __host({tasks:[],live:[],own:[],accounts:['Codex · personal'],codex:{accounts:['Codex · personal'],models:[{model:'gpt-6.1-sol',efforts:['high']}]}});
          __host({selectedPlan:{selectionId:'codex-role',file:'roles.json',raw:{v:1,name:'Roles',review:'checks',${account ? "account:'codex'," : ""}judge:'gpt-6.1-sol',scribe:{documents:['README.md'],after:['a']},steps:[{id:'a',title:'A',goal:'g',model:'gpt-6.1-sol'}]}}});
          const values=label=>[...document.querySelector('[aria-label="'+label+'"]').options].map(o=>({value:o.value,text:o.textContent}));
          return {judge:values('Standing judge model'),scribe:values('Standing scribe model')};
        })()`);
        for (const role of [observed.judge, observed.scribe]) {
          assert.ok(role.some((o) => o.value === "gpt-6.1-sol" && !o.text.includes("not currently offered")));
          assert.equal(role.some((o) => o.value === "opus"), false);
        }
      }
    });
    await t.test("selected preset and typed name survive execution options rerender", async () => {
      const observed = await page.evaluate(`(() => {
        __host({planPresets:{selectionId:'codex-role',presets:[{id:'first',name:'First',settings:{}},{id:'second',name:'Second',settings:{model:'gpt-6.1-sol'}}]}});
        document.querySelector('[aria-label="Personal settings preset"]').value='second';
        document.querySelector('[aria-label="Preset name"]').value='my unfinished name';
        const model=document.querySelector('[aria-label="Worker default model"]');model.value='gpt-6.1-sol';model.dispatchEvent(new Event('change'));
        return {id:document.querySelector('[aria-label="Personal settings preset"]').value,name:document.querySelector('[aria-label="Preset name"]').value};
      })()`);
      assert.deepEqual(observed, { id: "second", name: "my unfinished name" });
    });
    await t.test("starting a plan closes an open bulk confirmation and locks overrides", async () => {
      const observed = await page.evaluate(`(() => {
        const request=__posted.filter(m=>m.type==='previewSelectedPlan').at(-1);
        __host({planValidation:{selectionId:'codex-role',revision:request.revision,errors:[],plan:{},cards:[]}});
        [...document.querySelectorAll('button')].find(b=>b.textContent==='Apply defaults to all steps').click();
        const wasOpen=!!document.querySelector('[aria-label="Confirm replacing step overrides"]');
        [...document.querySelectorAll('button')].find(b=>b.textContent==='Run plan').click();
        return {wasOpen,open:!!document.querySelector('[aria-label="Confirm replacing step overrides"]'),locked:document.querySelector('[aria-label="Step a model"]').disabled,starting:[...document.querySelectorAll('button')].some(b=>b.textContent==='Starting plan…'&&b.disabled)};
      })()`);
      assert.deepEqual(observed, { wasOpen: true, open: false, locked: true, starting: true });
    });
  } finally {
    page?.close(); if (browser) await browser.kill();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
