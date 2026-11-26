// The actual board.js in Edge, with simulated host messages and no running task or personal vault.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const cdp = require("./compile-webview-cdp");

test("webview switches the context selector and sends only the selected source with a new card", async (t) => {
  if (!cdp.edgePath()) return t.skip("Microsoft Edge, Chrome or Chromium is not available on this host");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-obsidian-webview-"));
  const url = pathToFileURL(path.join(__dirname, "compile-webview-harness.html")).href;
  let edge, page;
  try {
    edge = await cdp.launchEdge(url, scratch);
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the board harness");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "the board webview");
    const base = { tasks: [], live: [], own: [], accounts: ["acct"], contextSource: "obsidian",
      obsidian: { folderName: "Project Notes", notes: ["Project.md", "Notes/Plan.md"] },
      asana: { projectName: "Existing project", tasks: [{ gid: "42", name: "Existing task" }] } };
    await page.evaluate(`window.__host(${JSON.stringify(base)})`);
    const controls = await page.evaluate(`(() => { const o = document.querySelector('[aria-label="Obsidian note for new task"]'); const a = document.querySelector('[aria-label="Asana task for new task"]'); return { button: document.querySelector('.asana-bar button').textContent, hidden: o.hidden, asanaHidden: a.hidden, notes: [...o.options].map(x => x.value) }; })()`);
    assert.deepEqual(controls, { button: "Obsidian: Project Notes", hidden: false, asanaHidden: true, notes: ["", "new", "Project.md", "Notes/Plan.md"] });
    await page.evaluate(`(() => { document.querySelector('.asana-bar button').click(); const o = document.querySelector('[aria-label="Obsidian note for new task"]'); o.value = 'Notes/Plan.md'; o.dispatchEvent(new Event('change')); const plan = document.querySelector('#planFirst'); plan.checked = true; plan.dispatchEvent(new Event('change')); document.querySelector('textarea[data-draft-target="new"]').value = 'Test prompt'; [...document.querySelectorAll('button')].find(b => b.textContent === 'Add task').click(); })()`);
    const messages = await page.evaluate("window.__posted");
    assert.ok(messages.some((m) => m.type === "contextSource"));
    const create = messages.findLast((m) => m.type === "create");
    assert.equal(create.obsidian, "Notes/Plan.md");
    assert.equal(create.asana, "");
    assert.equal(create.planFirst, true); // both features survive the main-branch merge
    await page.evaluate(`window.__host(${JSON.stringify({ ...base, contextSource: "asana" })})`);
    const asana = await page.evaluate(`(() => ({ button: document.querySelector('.asana-bar button').textContent, obsidianHidden: document.querySelector('[aria-label="Obsidian note for new task"]').hidden, asanaHidden: document.querySelector('[aria-label="Asana task for new task"]').hidden }))()`);
    assert.deepEqual(asana, { button: "Asana: Existing project", obsidianHidden: true, asanaHidden: false });
    await page.evaluate(`window.__host(${JSON.stringify({ ...base, obsidian: { folderName: "Project Notes", notes: [], error: "Access denied" } })})`);
    assert.equal(await page.evaluate(`document.querySelector('[aria-label="Obsidian note for new task"]').disabled`), true);
    if (process.env.ENTOMATICAL_OBSIDIAN_SCREENSHOT_DIR) {
      await page.evaluate(`window.__host(${JSON.stringify(base)})`);
      await page.evaluate(`document.documentElement.style.cssText = '--vscode-font-family: Segoe UI; --vscode-font-size: 13px; --vscode-foreground: #ddd; --vscode-descriptionForeground: #aaa; --vscode-editorWidget-background: #252526; --vscode-input-background: #333; --vscode-input-foreground: #ddd; --vscode-input-border: #555; --vscode-button-secondaryBackground: #444; --vscode-button-secondaryForeground: #ddd; --vscode-button-background: #0e639c; --vscode-button-foreground: #fff'; document.body.style.background = '#1e1e1e';`);
      for (const width of [420, 1200]) {
        await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
        const shot = await page.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(path.join(process.env.ENTOMATICAL_OBSIDIAN_SCREENSHOT_DIR, `board-${width}.png`), Buffer.from(shot.data, "base64"));
      }
    }
  } finally {
    page?.close();
    if (edge) await edge.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
