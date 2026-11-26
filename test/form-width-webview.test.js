// The real media/board.js and board.css in headless Edge (Windows) or Chrome (Linux), at the sidebar's width: the new-task form's
// selects and inputs fit the panel, so a long account name does not make the side panel scroll sideways (F03; the Windows F93 check on
// 9 November 2026 saw the account select 374 px wide in a 283 px sidebar).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

test("webview: at 283 px with a long account name the new-task form fits the panel and the board does not scroll sideways", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview check was not run."); return; }
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-form-width-webview-"));
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`The browser could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading in the harness");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 283, height: 900, deviceScaleFactor: 1, mobile: false });
    const long = "Antigravity · someone.e.x.ample.with.a.long.name@example-organisation.com · Profile Default (~/.gemini/antigravity-cli)";
    const grok = "Grok · team@example.com · Profile Default (~/.grok) · a second long label";
    await page.evaluate(`window.__host(${JSON.stringify({ tasks: [], live: [], own: [], accounts: ["acct", long, grok], activeAccount: long,
      externalProviders: { [long]: "antigravity", [grok]: "grok" } })}); true`);
    const seen = await cdp.waitFor(() => page.evaluate(`(() => {
      const box = document.querySelector('select[aria-label="Account for new task"]');
      if (!box || box.value !== ${JSON.stringify(long)} || innerWidth !== 283) return null;
      const form = document.querySelector("section.form");
      const wide = [...form.querySelectorAll("select, input:not([type=checkbox]), textarea")].filter((e) => e.offsetParent)
        .map((e) => ({ label: e.getAttribute("aria-label") || e.placeholder || e.tagName, right: Math.round(e.getBoundingClientRect().right) }))
        .filter((e) => e.right > document.documentElement.clientWidth);
      return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, wide,
        accountWidth: Math.round(box.getBoundingClientRect().width), fullLabel: box.selectedOptions[0].textContent };
    })()`), "the long account to be selected at 283 px");
    assert.deepEqual(seen.wide, [], `form controls past the panel's right edge: ${JSON.stringify(seen)}`);
    assert.ok(seen.scrollWidth <= seen.clientWidth, `the board scrolls sideways: scrollWidth ${seen.scrollWidth} in ${seen.clientWidth}`);
    assert.ok(seen.accountWidth > 100, `the account select is too narrow to read: ${seen.accountWidth} px`);
    assert.equal(seen.fullLabel, long, "the option keeps the whole account name");
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* a temp folder */ }
  }
});
