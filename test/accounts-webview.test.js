// The Accounts section of the real media/board.js in headless Microsoft Edge (the compile harness page, no model called):
// a Claude Max account shows no 5-hour limit, in its row and in the collapsed summary line (F57).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

test("webview: a Claude Max account shows its weekly limit only; a Pro account and Codex keep their 5-hour limit", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview check was not run."); return; }
  const harness = path.resolve(__dirname, "compile-webview-harness.html");
  const url = require("node:url").pathToFileURL(harness).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-accounts-webview-"));
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`Edge could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading in the harness");
    const at = Date.now();
    const usage = { fiveHour: 20, week: 40, at };
    const rows = [
      { configDir: "", active: true, folder: "~/.claude", loggedIn: true, email: "max@example.com", plan: "max", usage: { ...usage, fiveHour: null }, usageRefreshing: false },
      { configDir: "C:\\accounts\\max5", active: false, folder: "max5", loggedIn: true, email: "max5@example.com", plan: "max", usage: { ...usage, fiveHour: 100, fiveHourResets: Math.floor(at / 1000) + 3600 }, usageRefreshing: false },
      { configDir: "C:\\accounts\\pro", active: false, folder: "pro", loggedIn: true, email: "pro@example.com", plan: "pro", usage, usageRefreshing: false },
      { configDir: "C:\\codex", provider: "codex", active: false, folder: "Codex (~/.codex)", loggedIn: true, email: "codex@example.com", plan: "plus",
        usage: { windows: [{ minutes: 300, pct: 10, resets: Math.floor(at / 1000) - 60 }, { minutes: 7 * 1440, pct: 5, resets: Math.floor(at / 1000) + 3600 }], at }, usageRefreshing: false },
    ];
    await page.evaluate(`window.__host(${JSON.stringify({ tasks: [], live: [], own: [], accounts: ["acct"], accountRows: rows })}); true`);
    const labels = await page.evaluate(`[...document.querySelectorAll(".accounts .account")].map((a) => [...a.querySelectorAll(".quota-label span:first-child")].map((s) => s.textContent))`);
    assert.deepEqual(labels, [["Weekly limit"], ["5-hour limit", "Weekly limit"], ["5-hour limit", "Weekly limit"], ["5-hour limit", "Weekly limit"]]);
    const codexMeters = await page.evaluate(`[...document.querySelectorAll(".accounts .account:last-child .quota")].map(q => [q.querySelector(".quota-label span:last-child").textContent, q.querySelector("meter")?.value ?? null])`);
    assert.deepEqual(codexMeters, [["Awaiting update", null], ["5% used · 95% remaining", 5]]);
    // The reading's age shares one line with the last window's reset (the user, 3 November 2026); no separate age line.
    const ages = await page.evaluate(`[...document.querySelectorAll(".accounts .account")].map((a) => [...a.querySelectorAll(".usage-age")].map((e) => e.querySelector(':scope > span')?.textContent ?? e.textContent))`);
    assert.deepEqual(ages.map((a) => a.at(-1).endsWith("reported just now")), [true, true, true, true]);
    assert.deepEqual(ages.map((a) => a.filter((t) => t.includes("reported just now")).length), [1, 1, 1, 1]);
    assert.ok(ages.flat().every((t) => !t.includes("Updates when")));
    assert.equal(await page.evaluate(`document.querySelectorAll('.account-status > .account-login').length`), 4);
    for (const width of [284, 360, 1280]) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      assert.equal(await page.evaluate(`[...document.querySelectorAll('.account-status')].every(s => {
        const text = s.firstElementChild.getBoundingClientRect(), login = s.lastElementChild.getBoundingClientRect();
        return text.right <= login.left + 1 && login.right <= s.getBoundingClientRect().right + 1;
      })`), true, `status and login fit at ${width}px`);
    }
    // Collapsed, the summary line carries one usage chip per signed-in account.
    await page.evaluate(`document.querySelector("details.accounts").open = false; true`);
    const chips = await cdp.waitFor(async () => { const c = await page.evaluate(`[...document.querySelectorAll(".usage-chip")].map((e) => e.textContent)`); return c.length ? c : undefined; }, "the usage chips");
    // A 5-hour figure whose reset has passed is no figure: the chip leaves it out, as the row says "Awaiting update".
    const old = { configDir: "", active: true, folder: "~/.claude", loggedIn: true, email: "old@example.com", plan: "pro",
      usage: { fiveHour: 12, fiveHourResets: Math.floor(at / 1000) - 600, week: 40, at }, usageRefreshing: false };
    await page.evaluate(`window.__host(${JSON.stringify({ tasks: [], live: [], own: [], accounts: ["acct"], accountRows: [old] })}); true`);
    assert.deepEqual(await cdp.waitFor(async () => { const c = await page.evaluate(`[...document.querySelectorAll(".usage-chip")].map((e) => e.textContent)`); return c.length === 1 ? c : undefined; }, "the one chip"), ["old@example.com: weekly 40%"]);
    await page.evaluate(`window.__host(${JSON.stringify({ tasks: [], live: [], own: [], accounts: ["acct"], accountRows: rows })}); true`);
    await cdp.waitFor(async () => (await page.evaluate(`document.querySelectorAll(".usage-chip").length`)) === 4 || undefined, "the four chips again");
    assert.deepEqual(chips, ["max@example.com: weekly 40%", "max5@example.com: 5-hour 100% · weekly 40%", "pro@example.com: 5-hour 20% · weekly 40%", "codex@example.com: weekly 5%"]);
    const external = [
      { configDir: "C:\\grok-accounts\\work", provider: "grok", folder: "work", removable: true, loggedIn: true, email: "me@example.com", usageRefreshing: false,
        recent: { day: 1_234_567, dayOutput: 30_000, week: 5_400_000, weekOutput: 88_124 } },
      { configDir: "", provider: "antigravity", folder: "Shared Google sign-in", loggedIn: false, usageRefreshing: false },
    ];
    await page.evaluate(`window.__host(${JSON.stringify({ tasks: [], live: [], own: [], accounts: ["acct"], accountRows: external })}); true`);
    const descriptions = await page.evaluate(`[...document.querySelectorAll(".accounts .account")].map(a => a.textContent)`);
    // F93: who is signed in, and the tokens used on this computer; a signed-out row says so.
    assert.match(descriptions[0], /^Grok · me@example\.comProfile workThis computer: 24 h 1\.2M tokens \(30k output\) · 7 days 5\.4M \(88\.1k output\)Sign in again/);
    assert.match(descriptions[1], /^Antigravity · Not signed inShared Google sign-inSign in/);
    await page.evaluate(`window.__host(${JSON.stringify({ tasks: [], live: [], own: [], accounts: ["acct"], accountRows: external, modelEfficiency: [
      { provider: "grok", model: "grok-4.7", finished: 3, measured: 3, partial: 0, medianTotal: 1030, medianFresh: 330, medianOutput: 30,
        attempts: 7, passed: 5, failed: 1, unverified: 1, perPassed: 12_345, freshPerPassed: 4_000, medianFollowUps: 1, fewCards: false },
      { provider: "claude", model: "claude-opus-5-5", finished: 2, measured: 2, partial: 2, medianTotal: 2_500_000, medianFresh: 40_000,
        attempts: 3, passed: 0, failed: 1, unverified: 2, medianFollowUps: 0, fewCards: true }] })}); true`);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll(".model-table tr")].map(r => [...r.cells].map(c => c.textContent))`), [
      ["Model"], ["Done", "Measured", "Tokens", "Without cache reads", "Output"],
      ["Grok · grok-4.7"], ["3", "3", "1k", "330", "30"], ["5/7 passed · 12.3k per passed task · follow-ups 1"],
      ["Claude · claude-opus-5-5"], ["2", "2 (2 partial)", "2.5M", "40k", "–"], ["0/3 passed · – per passed task · follow-ups 0"]]);
    // F106: one cell across the five columns, its mouse-over, and a dimmed row when too few cards were measured.
    const outcomes = await page.evaluate(`[...document.querySelectorAll(".model-table tr.model-outcome")].map(r => ({ span: r.cells[0].colSpan, muted: r.cells[0].classList.contains("muted"),
      few: r.classList.contains("model-few"), title: r.cells[0].title, opacity: getComputedStyle(r).opacity }))`);
    assert.deepEqual(outcomes, [
      { span: 5, muted: true, few: false, opacity: "1",
        title: "Passed: acceptance checks passed, or Review said done. 1 failed (discarded, or checks failed), 1 unverified. Per passed task: all tokens of these cards, failed ones included, divided by the passed ones; 4k without cache reads." },
      { span: 5, muted: true, few: true, opacity: "0.6",
        title: "Passed: acceptance checks passed, or Review said done. 1 failed (discarded, or checks failed), 2 unverified. Per passed task: all tokens of these cards, failed ones included, divided by the passed ones; – without cache reads. Too few cards to compare (under 5 measured)." }]);
    // The new line wraps rather than widening the table: it still fits the 284 px sidebar.
    const width = await page.evaluate(`(() => { const box = document.querySelector(".model-scroll"), d = box.closest("details"), was = d.open, w = document.body.style.width;
      d.open = true; document.body.style.width = "284px"; const r = [box.scrollWidth, box.clientWidth]; document.body.style.width = w; d.open = was; return r; })()`);
    assert.ok(width[0] <= width[1] && width[1] <= 284, `model table ${width[0]} px in ${width[1]} px`);
    assert.ok(descriptions.every((text) => !text.includes("Use in IDE")));
    await page.evaluate(`document.querySelector("details.accounts").open = true; [...document.querySelectorAll(".accounts button")].find(b => b.textContent === "Open Grok").focus(); true`);
    await page.evaluate(`window.__host(${JSON.stringify({ tasks: [], live: [], own: [], accounts: ["acct"], accountRows: external })}); true`);
    assert.equal(await page.evaluate(`document.activeElement.textContent`), "Open Grok");
    const actions = await page.evaluate(`(() => { window.__posted.length = 0;
      const menu = document.querySelector('select[aria-label="Add account"]');
      for (const provider of ['claude', 'codex', 'grok', 'antigravity']) {
        menu.value = provider; menu.dispatchEvent(new Event('change'));
        if (menu.value !== '') throw new Error('Provider selection must reset');
      }
      for (const label of ["Open Grok", "Open Antigravity", "Hide"]) {
        [...document.querySelectorAll(".accounts button")].find(b => b.textContent === label).click();
      }
      return window.__posted;
    })()`);
    assert.deepEqual(actions, [
      { type: "accountAdd" }, { type: "accountAdd", provider: "codex" },
      { type: "accountAdd", provider: "grok" }, { type: "accountAdd", provider: "antigravity" },
      { type: "accountOpen", configDir: external[0].configDir, provider: "grok" },
      { type: "accountOpen", configDir: "", provider: "antigravity" },
      { type: "accountRemove", configDir: "", provider: "antigravity" },
    ]);
    assert.equal(await page.evaluate(`[...document.querySelector('select[aria-label="Add account"]').options].filter(o => o.disabled && o.textContent.includes('Not supported yet')).length`), 8);
  } finally {
    page?.close();
    if (edge) await edge.kill();
    // Edge's helper processes can hold its profile folder for a while after kill (EPERM under a full npm test run, 3 Nov 2026).
    // A leftover temp folder is not a test failure, so cleanup never fails the test.
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* left in %TEMP% */ }
  }
});
