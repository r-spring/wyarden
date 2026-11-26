// The real media/board.js and board.css in headless Edge/Chrome: the Battle Royale button and its two-step warning popup (F105,
// the user, 14 November 2026). The host is simulated: battleReady, battleRefused and a refused battle are delivered as the extension would.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

// the user, 17 November 2026: ten texts per box, rotated per opening. The lists are read from the page (board.js's own constants);
// every first text must still say what the battle does.
const FACTS = ["every running card on every board in this window gets 30 seconds to save its work", "parked in Review", "leftover agent processes are hunted down and killed", "4 absurdly expensive models get your one prompt"];
const ON = { tasks: [], live: [], own: [], accounts: ["acct"], battleRoyale: { size: 4, clearArena: true } };
const PROMPT = "Write the fastest tab sorter in the world.";

test("webview: Battle Royale's button, its two-step warning, the ticker, Yes, No and Escape", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview check was not run."); return; }
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-battle-webview-"));
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`The browser could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading in the harness");
    await page.evaluate(`(() => {
      window.__btn = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Battle Royale');
      window.__dialog = () => document.querySelector('[role=dialog]');
      window.__open = () => { const o = document.querySelector('.battle-overlay'); return !!o && !o.hidden && getComputedStyle(o).display !== 'none'; };
      window.__press = (label) => [...window.__dialog().querySelectorAll('button')].find((b) => b.textContent === label).click();
      window.__prompt = (v) => { const p = document.querySelector('textarea[placeholder="Task prompt"]'); if (v !== undefined) p.value = v; return p.value; };
      window.__types = () => window.__posted.map((m) => m.type);
      window.__font = () => parseFloat(getComputedStyle(window.__btn()).fontSize);
      window.__water = () => Number(document.querySelector('.battle-water').textContent.replace(/[^0-9]/g, ''));
      window.__text = () => document.getElementById('battle-text').textContent;
      window.__round = () => Number(document.getElementById('battle-text').dataset.round);
      window.__lists = (n) => ({ tips: BATTLE_TIPS.map((f) => f(n)), opens: BATTLE_OPENS, closes: BATTLE_CLOSES, seconds: BATTLE_SECONDS.map((f) => f(n)), gos: BATTLE_GOS });
      return true; })()`);
    const L = await page.evaluate("window.__lists(4)");
    for (const [name, list] of Object.entries(L)) assert.equal(new Set(list).size, 10, `ten different ${name}`);

    // The setting off (no battleRoyale in the state): no button.
    assert.equal(await page.evaluate("window.__btn().hidden"), true, "hidden until the host turns it on");
    await page.evaluate(`window.__host(${JSON.stringify(ON)}); true`);

    // The button sits right after Add task, with the user's tooltip.
    const placed = await page.evaluate(`(() => { const b = window.__btn(); return { before: b.previousElementSibling?.textContent, hidden: b.hidden, title: b.title, open: window.__open() }; })()`);
    assert.deepEqual({ ...placed, title: L.tips.includes(placed.title) }, { before: "Add task", hidden: false, title: true, open: false });
    const size = await page.evaluate("window.__font()");

    // A click with a prompt: the text grows, only battlePrepare is posted, the first warning shows with focus on No.
    await page.evaluate(`window.__posted.length = 0; window.__prompt(${JSON.stringify(PROMPT)}); window.__btn().click(); true`);
    const first = await page.evaluate(`(() => ({ types: window.__types(), prompt: window.__posted[0]?.prompt, account: window.__posted[0]?.account, open: window.__open(), font: window.__font(),
      text: document.getElementById(window.__dialog().getAttribute('aria-labelledby')).textContent, focus: document.activeElement.textContent,
      buttons: [...window.__dialog().querySelectorAll('button')].map((b) => b.textContent), modal: window.__dialog().getAttribute('aria-modal') }))()`);
    assert.deepEqual(first.types, ["battlePrepare"]);
    assert.equal(first.prompt, PROMPT); assert.equal(first.account, "acct", "battlePrepare carries the fields Add task sends");
    assert.ok(first.open, "the popup is open");
    assert.ok(first.font > size, `the button's text grows (${size} px to ${first.font} px)`);
    const i = await page.evaluate("window.__round()");
    assert.equal(placed.title, L.tips[i], "the tip belongs to the same set");
    assert.ok(first.text.startsWith(`${L.opens[i]} `) && first.text.endsWith(` ${L.closes[i]}`), first.text);
    for (const f of FACTS) assert.ok(first.text.includes(f), `the first text says: ${f}`);
    assert.deepEqual(first.buttons, ["Yes", "No"]);
    assert.equal(first.focus, "No"); assert.equal(first.modal, "true");

    // battleReady adds the line of cards and runs.
    await page.evaluate(`window.__host({ battleReady: { cards: 3, runs: 1, skipped: [] } }); true`);
    assert.equal(await page.evaluate(`[...window.__dialog().querySelectorAll('p')].find((p) => p.textContent.startsWith('Cards'))?.textContent`), "Cards to shut down: 3 · runs: 1");

    // The first Yes posts battleWarn, keeps the popup open, shows the second text and a ticker that keeps rising.
    await page.evaluate(`window.__press('Yes'); true`);
    const second = await page.evaluate(`(() => ({ types: window.__types(), open: window.__open(), text: document.getElementById('battle-text').textContent,
      water: document.querySelector('.battle-water').textContent, buttons: [...window.__dialog().querySelectorAll('button')].map((b) => b.textContent) }))()`);
    assert.deepEqual(second.types, ["battlePrepare", "battleWarn"]);
    assert.ok(second.open);
    assert.equal(second.text, `${L.seconds[i]} The arena is being swept while you read this.`);
    assert.match(second.water, /^Estimated water about to evaporate: \d{1,3}(,\d{3}){2,} litres$/, "millions, with thousands separators");
    assert.deepEqual(second.buttons, [L.gos[i], "No"]);
    const w1 = await page.evaluate("window.__water()");
    await new Promise((r) => setTimeout(r, 700));
    const w2 = await page.evaluate("window.__water()");
    assert.ok(w1 >= 1_000_000 && w2 > w1, `the ticker rises (${w1} then ${w2})`);

    // The second Yes closes the popup, posts one battle with the prompt and no create, and empties the box.
    await page.evaluate(`window.__press(${JSON.stringify(L.gos[i])}); true`);
    const fought = await page.evaluate(`({ types: window.__types(), battle: window.__posted.filter((m) => m.type === 'battle').map((m) => m.prompt), open: window.__open(), box: window.__prompt(), font: window.__font() })`);
    assert.deepEqual(fought.types, ["battlePrepare", "battleWarn", "battle"]);
    assert.deepEqual(fought.battle, [PROMPT]);
    assert.equal(fought.open, false); assert.equal(fought.box, ""); assert.equal(fought.font, size);

    // A battle the host refuses puts the prompt back, as a refused create does.
    await page.evaluate(`window.__host({ failed: { type: 'battle', prompt: ${JSON.stringify(PROMPT)} } }); true`);
    assert.equal(await page.evaluate("window.__prompt()"), PROMPT);

    // No before the first Yes: no battleCancel, the prompt stays, the text goes back to its size.
    await page.evaluate(`window.__posted.length = 0; window.__btn().click(); window.__press('No'); true`);
    assert.deepEqual(await page.evaluate(`({ types: window.__types(), open: window.__open(), box: window.__prompt(), font: window.__font() })`),
      { types: ["battlePrepare"], open: false, box: PROMPT, font: size });

    // No after the first Yes posts battleCancel; the prompt stays.
    await page.evaluate(`window.__posted.length = 0; window.__btn().click(); window.__press('Yes'); window.__press('No'); true`);
    assert.deepEqual(await page.evaluate(`({ types: window.__types(), open: window.__open(), box: window.__prompt(), font: window.__font() })`),
      { types: ["battlePrepare", "battleWarn", "battleCancel"], open: false, box: PROMPT, font: size });

    // Every new click starts at the first text, of the next set; Escape is No, here after the first Yes too.
    await page.evaluate(`window.__posted.length = 0; window.__btn().click(); true`);
    const j = (i + 3) % 10; // three openings since
    assert.deepEqual(await page.evaluate(`({ round: window.__round(), opens: window.__text().startsWith(${JSON.stringify(L.opens[j])}), water: document.querySelector('.battle-water').hidden,
      count: [...window.__dialog().querySelectorAll('p')].find((p) => p.textContent.startsWith('Cards')) ?? null })`), { round: j, opens: true, water: true, count: null });
    await page.evaluate(`window.__press('Yes'); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    assert.deepEqual(await page.evaluate(`({ types: window.__types(), open: window.__open(), box: window.__prompt() })`),
      { types: ["battlePrepare", "battleWarn", "battleCancel"], open: false, box: PROMPT });

    // battleRefused closes the popup and shows the reason under the form, posting nothing more.
    await page.evaluate(`window.__posted.length = 0; window.__btn().click(); window.__host({ battleRefused: "Another VS Code window runs this repo's board." }); true`);
    assert.deepEqual(await page.evaluate(`({ types: window.__types(), open: window.__open(), box: window.__prompt(), note: document.querySelector('.battle-note').textContent,
      noteShown: !document.querySelector('.battle-note').hidden, font: window.__font() })`),
      { types: ["battlePrepare"], open: false, box: PROMPT, note: "Another VS Code window runs this repo's board.", noteShown: true, font: size });

    // Rotation: ten openings in a row give ten different first texts, each saying what happens; the tip moves on after each.
    const seen = new Set();
    for (let k = 0; k < 10; k++) {
      const r = await page.evaluate(`(() => { const tip = window.__btn().title; window.__btn().click(); const out = { tip, text: window.__text(), round: window.__round() }; window.__press('No'); return out; })()`);
      assert.equal(r.tip, L.tips[r.round]);
      for (const f of FACTS) assert.ok(r.text.includes(f), `opening ${k}: ${f}`);
      seen.add(r.text);
    }
    assert.equal(seen.size, 10);

    // battleRoyale.clearArena off: the first text says nothing is stopped, no card count, and the second text drops the sweep.
    await page.evaluate(`window.__host(${JSON.stringify({ ...ON, battleRoyale: { size: 2, clearArena: false } })}); window.__posted.length = 0; window.__btn().click(); window.__host({ battleReady: { cards: 3, runs: 1, skipped: [] } }); true`);
    const kept = await page.evaluate(`({ text: window.__text(), round: window.__round(), count: [...window.__dialog().querySelectorAll('p')].find((p) => p.textContent.startsWith('Cards') && !p.hidden) ?? null })`);
    assert.ok(kept.text.includes("2 absurdly expensive models get your one prompt") && kept.text.includes("Your running cards are left alone") && !kept.text.includes("30 seconds"), kept.text);
    assert.equal(kept.count, null);
    await page.evaluate(`window.__press('Yes'); true`);
    assert.equal(await page.evaluate("window.__text()"), (await page.evaluate("window.__lists(2)")).seconds[kept.round]);
    // Switched off while the popup is open: it closes (the warning called off) and the button goes.
    await page.evaluate(`window.__host(${JSON.stringify({ ...ON, battleRoyale: undefined })}); true`);
    assert.deepEqual(await page.evaluate(`({ open: window.__open(), hidden: window.__btn().hidden, last: window.__types().at(-1) })`), { open: false, hidden: true, last: "battleCancel" });
    await page.evaluate(`window.__host(${JSON.stringify(ON)}); true`);

    // An empty prompt posts battle at once, with no popup.
    await page.evaluate(`window.__posted.length = 0; window.__prompt(''); window.__btn().click(); true`);
    assert.deepEqual(await page.evaluate(`({ types: window.__types(), open: window.__open() })`), { types: ["battle"], open: false });
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* a temp folder */ }
  }
});
