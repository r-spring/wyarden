// The real media/board.js and board.css in headless Edge/Chrome: Battle Royale's look (F105, the user, 14 November 2026: "The cards should
// brightly coloured versions of the default colours we set each provider. Codex-blue, Antropic-Orange but more neon verisons and the
// font choices should be aggressive too"). Battle cards, the button and the popup; ordinary cards keep the computed styles they had.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

const now = new Date().toISOString();
const PROVIDERS = [["claude", "Claude"], ["codex", "Codex"], ["grok", "Grok"], ["antigravity", "Antigravity"]];
const NEON = { claude: "#ff6a00", codex: "#00b3ff", grok: "#39ff14", antigravity: "#ff2bd6" };
const LIGHT = { claude: "#b34700", codex: "#0069a8", grok: "#1f7a00", antigravity: "#b0008f" };
const longPath = "C:\\Users\\user\\Documents\\Dev Stuff\\Entomatical\\.entomatical\\wt\\961f90\\docs\\evidence\\parity-win-2026-11-12\\output\\w58\\F58.txt";
const card = (id, provider, extra) => ({ id, title: `Write the fastest tab sorter in the world · ${provider}`, prompt: "Battle.", status: "running", provider: provider === "claude" ? undefined : provider,
  createdAt: now, updatedAt: now, ...extra });
const tasks = [
  ...PROVIDERS.map(([p]) => card(`b-${p}`, p, { battle: "a1b2c3d4", ...(p === "grok" ? { title: `Fix ${longPath} now · Grok` } : {}) })),
  ...PROVIDERS.map(([p]) => card(`o-${p}`, p)),
];
const state = { tasks, live: tasks.map((t) => t.id), own: tasks.map((t) => t.id), accounts: ["acct"], activeAccount: "acct", battleRoyale: { size: 4, clearArena: true } };
const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
// WCAG 2 contrast of two #rrggbb colours.
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// Runs in the page: the computed styles this test compares, for a card, its top edge, its title and the form's buttons.
const LOOK = `(() => {
  const pick = (e, pseudo, keys) => { const s = getComputedStyle(e, pseudo); return Object.fromEntries(keys.map((k) => [k, s[k]])); };
  const BOX = ["borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor", "borderTopWidth", "boxShadow", "backgroundColor", "animationName"];
  const TEXT = ["fontFamily", "fontStyle", "fontWeight", "textTransform", "letterSpacing", "color", "fontSize", "animationName"];
  const out = {};
  for (const c of document.querySelectorAll(".card")) {
    const head = c.querySelector(".battle-head");
    out[c.dataset.task] = { battle: c.dataset.battle ?? null, card: pick(c, null, BOX), edge: pick(c, "::before", ["backgroundColor", "height", "display"]), title: pick(c.querySelector(".title"), null, TEXT),
      provider: head ? { text: head.querySelector(".battle-provider").textContent, ...pick(head.querySelector(".battle-provider"), null, TEXT) } : null,
      tag: head ? { text: head.querySelector(".battle-tag").textContent, ...pick(head.querySelector(".battle-tag"), null, [...TEXT, "borderTopColor"]) } : null };
  }
  const btn = (label) => pick([...document.querySelectorAll("button")].find((b) => b.textContent === label), null, [...TEXT, "boxShadow", "textShadow", "borderTopColor", "backgroundImage"]);
  out.addTask = btn("Add task"); out.battleButton = btn("Battle Royale"); out.bodyFont = getComputedStyle(document.body).fontFamily;
  return out;
})()`;

// What an ordinary card, the Add task button and the ordinary text looked like on the stylesheet before the battle look (b4647bf),
// in the harness (no VS Code theme variables, so each var() takes its fallback). The face is the body's, which the browser picks ("BODY").
const ORDINARY_TITLE = { fontFamily: "BODY", fontStyle: "normal", fontWeight: "600", textTransform: "none", letterSpacing: "normal", color: "rgb(0, 0, 0)", fontSize: "13px", animationName: "none" };
const ORDINARY_CARD = { borderTopColor: "rgba(0, 0, 0, 0)", borderRightColor: "rgba(0, 0, 0, 0)", borderBottomColor: "rgba(0, 0, 0, 0)", borderLeftColor: "rgb(55, 148, 255)",
  borderTopWidth: "1px", boxShadow: "none", backgroundColor: "rgba(0, 0, 0, 0)", animationName: "none" };
// Provider edges since 25 November 2026: Codex blue, Grok dark green, Antigravity purple (before: Codex purple, the others orange).
const ORDINARY_EDGE = { claude: "rgb(217, 119, 87)", codex: "rgb(79, 168, 255)", grok: "rgb(63, 169, 90)", antigravity: "rgb(179, 146, 240)" };
const ADD_TASK = { fontFamily: "BODY", fontStyle: "normal", fontWeight: "400", textTransform: "none", letterSpacing: "normal", color: "rgb(0, 0, 0)", fontSize: "16px",
  animationName: "none", boxShadow: "none", textShadow: "none", borderTopColor: "rgba(0, 0, 0, 0)", backgroundImage: "none" };

// Runs in the page at the current width: the document and the open popup scroll sideways by nothing and cut nothing off.
const FITS = `(() => {
  const vw = document.documentElement.clientWidth, bad = [];
  const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.checkVisibility?.() !== false; };
  if (document.documentElement.scrollWidth > vw) bad.push("the page scrolls sideways: " + document.documentElement.scrollWidth + " in " + vw);
  const boxes = [...document.querySelectorAll(".card[data-battle]"), ...document.querySelectorAll(".battle-dialog")].filter(shown);
  for (const box of boxes) {
    const b = box.getBoundingClientRect(), inner = b.left + box.clientLeft + box.clientWidth;
    if (b.left < -0.5 || b.right > vw + 0.5) bad.push(box.className + " past the panel: " + Math.round(b.left) + " to " + Math.round(b.right) + " of " + vw);
    if (box.scrollWidth > box.clientWidth + 1) bad.push(box.className + " scrolls sideways: " + box.scrollWidth + " in " + box.clientWidth);
    for (const e of box.querySelectorAll("*")) if (shown(e)) {
      if (e.getBoundingClientRect().right > inner + 0.5) bad.push("'" + e.textContent.slice(0, 30) + "' cut at the edge of " + box.className);
      if (e.clientWidth && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === "visible" && !e.closest(".card-terminal")) bad.push("'" + e.textContent.slice(0, 30) + "' wider than its box");
    }
  }
  return { bad, battleCards: document.querySelectorAll(".card[data-battle]").length, dialog: !!document.querySelector(".battle-dialog") && shown(document.querySelector(".battle-dialog")) };
})()`;

test("webview: Battle Royale's neon cards, aggressive face, button and popup; ordinary cards unchanged; light and high-contrast themes; 180 and 283 px", { timeout: 90_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview check was not run."); return; }
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-battle-look-"));
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`The browser could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading in the harness");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`window.__host(${JSON.stringify(state)}); true`);
    await cdp.waitFor(() => page.evaluate(`document.querySelectorAll(".card").length === 8`), "the eight cards");
    const theme = (cls) => page.evaluate(`document.body.className = ${JSON.stringify(cls)}; true`);

    // Dark (the harness has no theme class, as a dark theme's body has no vscode-light): the neon.
    let look = await page.evaluate(LOOK);
    for (const [p, name] of PROVIDERS) {
      const b = look[`b-${p}`], where = `the ${name} battle card`;
      assert.equal(b.battle, "a1b2c3d4", `${where} has data-battle`);
      assert.equal(b.provider.text, name, `${where} names its provider`);
      assert.equal(b.tag.text, "Battle Royale", `${where} has the tag`);
      assert.equal(b.edge.backgroundColor, rgb(NEON[p]), `${where}'s top edge is its neon`);
      assert.equal(b.edge.height, "4px", `${where}'s top edge is thick`);
      assert.equal(b.provider.color, rgb(NEON[p]), `${where}'s provider name is its neon`);
      assert.equal(b.tag.color, rgb(NEON[p]), `${where}'s tag is its neon`);
      assert.equal(b.tag.borderTopColor, rgb(NEON[p]), `${where}'s tag is outlined in its neon`);
      assert.equal(b.card.borderTopColor, rgb(NEON[p]), `${where}'s border is its neon`);
      // color-mix() comes back as color(srgb r g b / a) with channels from 0 to 1.
      const glow = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+) \/ 0\.55\) 0px 0px 8px/.exec(b.card.boxShadow);
      assert.ok(glow, `${where} glows: ${b.card.boxShadow}`);
      assert.equal(`rgb(${glow.slice(1, 4).map((v) => Math.round(Number(v) * 255)).join(", ")})`, rgb(NEON[p]), `${where} glows in its neon`);
      assert.equal(b.card.borderLeftColor, ORDINARY_CARD.borderLeftColor, `${where}'s left edge stays the status stripe`);
      for (const [part, s] of [["title", b.title], ["provider name", b.provider], ["tag", b.tag]]) {
        assert.match(s.fontFamily, /^Impact, Haettenschweiler, "Arial Narrow Bold", "DejaVu Sans Condensed", sans-serif$/, `${where}'s ${part} is in the aggressive face`);
        assert.deepEqual([s.textTransform, s.fontStyle, s.fontWeight, s.animationName], ["uppercase", "italic", "900", "none"], `${where}'s ${part} is uppercase, italic and heavy, and does not move`);
        assert.ok(parseFloat(s.letterSpacing) > 0, `${where}'s ${part} is spaced out a little`);
      }
      assert.equal(b.card.animationName, "none", `${where} does not move`);
    }
    // Ordinary cards: the computed styles they had before the battle look.
    for (const [p, name] of PROVIDERS) {
      const o = look[`o-${p}`];
      assert.equal(o.battle, null);
      assert.equal(o.provider, null, `the ordinary ${name} card has no battle line`);
      assert.deepEqual(o.card, ORDINARY_CARD, `the ordinary ${name} card's box is unchanged`);
      assert.deepEqual(o.edge, { backgroundColor: ORDINARY_EDGE[p], height: "2px", display: "block" }, `the ordinary ${name} card's top edge is unchanged`);
      assert.deepEqual(o.title, { ...ORDINARY_TITLE, fontFamily: look.bodyFont }, `the ordinary ${name} card's title is unchanged`);
    }
    assert.deepEqual(look.addTask, { ...ADD_TASK, fontFamily: look.bodyFont }, "Add task is unchanged");
    // The button: the face, neon orange text with a blue glow, an orange-to-blue edge.
    const bb = look.battleButton;
    assert.match(bb.fontFamily, /^Impact,/);
    assert.deepEqual([bb.textTransform, bb.fontStyle, bb.fontWeight], ["uppercase", "italic", "900"]);
    assert.equal(bb.color, rgb("#ff6a00"));
    assert.match(bb.textShadow, /rgba\(0, 179, 255/);
    assert.match(bb.backgroundImage, /linear-gradient\(90deg, rgb\(255, 106, 0\), rgb\(0, 179, 255\)\)/);

    // The popup: the face, large and heavy, neon orange text, electric-blue count, ticker and No; the button's text still grows.
    const size = await page.evaluate(`parseFloat(getComputedStyle([...document.querySelectorAll('button')].find((b) => b.textContent === 'Battle Royale')).fontSize)`);
    await page.evaluate(`(() => { const p = document.querySelector('textarea[placeholder="Task prompt"]'); p.value = 'Write the fastest tab sorter in the world.';
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Battle Royale').click(); window.__host({ battleReady: { cards: 3, runs: 1, skipped: [] } }); return true; })()`);
    const popup = () => page.evaluate(`(() => { const d = document.querySelector('.battle-dialog'), s = (e) => getComputedStyle(e);
      const text = document.getElementById('battle-text'), count = [...d.querySelectorAll('p')].find((p) => p.textContent.startsWith('Cards')), no = [...d.querySelectorAll('button')].find((b) => b.textContent === 'No');
      const yes = d.querySelector('button.danger');
      return { font: s(d).fontFamily, transform: s(d).textTransform, weight: s(text).fontWeight, size: parseFloat(s(text).fontSize), text: s(text).color, count: s(count).color,
        no: s(no).color, yes: s(yes).backgroundColor, border: s(d).borderTopColor, shadow: s(d).boxShadow, background: s(d).backgroundColor,
        button: parseFloat(s([...document.querySelectorAll('button')].find((b) => b.textContent === 'Battle Royale')).fontSize) }; })()`);
    const open = await popup();
    assert.match(open.font, /^Impact,/);
    assert.equal(open.transform, "uppercase"); assert.equal(open.weight, "900");
    assert.ok(open.size >= 20, `the popup's text is large (${open.size} px)`);
    assert.equal(open.text, rgb("#ff6a00")); assert.equal(open.border, rgb("#ff6a00")); assert.equal(open.yes, rgb("#ff6a00"));
    assert.equal(open.count, rgb("#00b3ff")); assert.equal(open.no, rgb("#00b3ff"));
    assert.notEqual(open.shadow, "none");
    assert.ok(open.button > size, `the button's text grows while the popup is open (${size} to ${open.button} px)`);

    // Light theme: the darker shades, each 4.5:1 or better on the light card backgrounds (#f3f3f3 and white).
    await theme("vscode-light");
    look = await page.evaluate(LOOK);
    for (const [p, name] of PROVIDERS) {
      const b = look[`b-${p}`];
      assert.equal(b.edge.backgroundColor, rgb(LIGHT[p]), `the ${name} battle card's top edge on a light theme`);
      assert.equal(b.provider.color, rgb(LIGHT[p]), `the ${name} provider name on a light theme`);
      assert.equal(b.tag.color, rgb(LIGHT[p]), `the ${name} tag on a light theme`);
      for (const bg of ["#f3f3f3", "#ffffff"]) assert.ok(contrast(LIGHT[p], bg) >= 4.5, `${LIGHT[p]} on ${bg}: ${contrast(LIGHT[p], bg).toFixed(2)}:1`);
    }

    // High contrast, dark and light: no neon and no glow anywhere; the face stays.
    for (const hc of ["vscode-high-contrast", "vscode-high-contrast-light"]) {
      await theme(hc);
      look = await page.evaluate(LOOK);
      const neons = new Set([...Object.values(NEON), ...Object.values(LIGHT)].map(rgb));
      for (const [p, name] of PROVIDERS) {
        const b = look[`b-${p}`], where = `the ${name} battle card in ${hc}`;
        assert.equal(b.edge.display, "none", `${where} has no top edge`);
        assert.equal(b.card.boxShadow, "none", `${where} does not glow`);
        for (const c of [b.provider.color, b.tag.color, b.tag.borderTopColor, b.card.borderTopColor, b.card.borderRightColor]) assert.ok(!neons.has(c), `${where}: ${c} is a neon`);
        assert.match(b.title.fontFamily, /^Impact,/);
      }
      const p = await popup();
      assert.ok(!neons.has(p.text) && !neons.has(p.count) && !neons.has(p.no) && !neons.has(p.border), `the popup in ${hc} has no neon: ${JSON.stringify(p)}`);
      assert.equal(p.shadow, "none", `the popup in ${hc} does not glow`);
      assert.equal(look.battleButton.boxShadow, "none"); assert.equal(look.battleButton.textShadow, "none");
      assert.ok(!neons.has(look.battleButton.color), `the button in ${hc} has no neon`);
    }
    await theme("");

    // 180 and 283 px: battle cards and the open popup, at each of its two steps, fit with nothing cut off.
    for (const width of [283, 180]) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height: 700, deviceScaleFactor: 1, mobile: false });
      await cdp.waitFor(() => page.evaluate(`innerWidth === ${width}`), `the page at ${width} px`);
      for (const step of [1, 2]) {
        if (step === 2) await page.evaluate(`[...document.querySelectorAll('.battle-dialog button')].find((b) => b.textContent === 'Yes').click(); true`);
        const seen = await page.evaluate(FITS);
        assert.equal(seen.battleCards, 4);
        assert.ok(seen.dialog, `the popup is open at ${width} px, step ${step}`);
        assert.deepEqual(seen.bad, [], `at ${width} px, step ${step}`);
      }
      await page.evaluate(`[...document.querySelectorAll('.battle-dialog button')].find((b) => b.textContent === 'No').click(); true`);
      await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Battle Royale').click(); true`);
    }
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* a temp folder */ }
  }
});
