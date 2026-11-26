// A board redraw keeps the follow-up being typed, with its selection, in two board documents (the side bar and the tab) of one workbench.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
require("./safe-temp").assertSafeTemp();

const at = (n) => new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString();
const card = (id, n, extra = {}) => ({ id, title: `Card ${id}`, status: "review", createdAt: at(n), updatedAt: at(n), ...extra });

// Two independently focused, cross-origin board documents in one workbench.
async function twoBoardDocuments(t) {
  const cdp = require("./compile-webview-cdp");
  const harness = path.join(__dirname, "terminal-webview-harness.html");
  const assets = new Map([["/test/board.html", harness]]);
  for (const [, ref] of fs.readFileSync(harness, "utf8").matchAll(/(?:src|href)="(\.\.\/[^"]+)"/g)) {
    assets.set(new URL(ref, "http://fixture/test/board.html").pathname, path.resolve(__dirname, ref));
  }
  const origins = {};
  for (const name of ["sidebar", "tab"]) {
    const server = require("node:http").createServer((req, res) => {
      if (req.url === "/") {
        res.setHeader("Content-Type", "text/html");
        return res.end(Object.entries(origins).map(([n, origin]) => `<iframe name="${n}" style="width:48%;height:90vh;border:0" src="${origin}/test/board.html"></iframe>`).join(""));
      }
      const file = assets.get(req.url);
      if (!file) { res.writeHead(404).end(); return; }
      res.setHeader("Content-Type", { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[path.extname(file)]);
      fs.createReadStream(file).pipe(res);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    origins[name] = `http://127.0.0.1:${server.address().port}`;
  }
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "board-views-"));
  let browser, page;
  t.after(async () => {
    page?.close(); await browser?.kill();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const url = origins.tab + "/";
  browser = await cdp.launchEdge(url, dir);
  const target = await cdp.waitFor(async () => (await cdp.listTargets(browser.port)).find(p => p.url === url), "workbench");
  page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  const docs = {};
  for (const name of Object.keys(origins)) {
    const context = await cdp.waitFor(async () => {
      const { frameTree } = await page.send("Page.getFrameTree");
      const frame = frameTree.childFrames?.find(f => f.frame.name === name)?.frame;
      const id = page.events.findLast(e => e.method === "Runtime.executionContextCreated" && e.params.context.auxData.isDefault && e.params.context.auxData.frameId === frame?.id)?.params.context.id;
      return id && await page.evaluate("window.__ready", id) && id;
    }, name + " frame");
    const evaluate = js => page.evaluate(js, context);
    await evaluate("window.__posted.length = 0; true");
    const pointerAt = async element => {
      const [x, y] = await evaluate(`(() => { const el = ${element}; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]; })()`);
      const [left, top] = await page.evaluate(`(() => { const r = document.querySelector('iframe[name="${name}"]').getBoundingClientRect(); return [r.x,r.y]; })()`);
      return type => page.send("Input.dispatchMouseEvent", { type, x: left+x, y: top+y, button: "left", clickCount: 1 });
    };
    docs[name] = { evaluate, async click(element) {
      const pointer = await pointerAt(element);
      await pointer("mousePressed");
      await pointer("mouseReleased");
    } };
  }
  return { docs, page, targetId: target.id, port: browser.port };
}

test("an ordinary background redraw preserves the selected follow-up on return and respects a later choice", { timeout: 60000 }, async t => {
  const cdp = require("./compile-webview-cdp");
  if (!cdp.edgePath()) return t.skip("Microsoft Edge, Chrome or Chromium is unavailable");
  const { docs: { tab, sidebar }, page, targetId, port } = await twoBoardDocuments(t);
  const worktree = require("node:os").tmpdir();
  const edited = card("edited", 1, { provider: "grok", worktree, sessionId: "saved", prompt: "Edit" });
  const other = card("other", 2, { prompt: "Other" });
  const refresh = () => tab.evaluate(`window.__host(${JSON.stringify({ tasks: [edited, other], accounts: [], live: [], own: [] })}); true`);
  await refresh();
  const draft = `document.querySelector('textarea[data-draft-target="edited"]')`;
  await tab.click(`[...document.querySelector('.card[data-task="edited"]').querySelectorAll("button")].find(b => b.textContent === "Follow-up")`);
  const select = async () => {
    await tab.evaluate(`${draft}.select(); true`);
    await page.send("Input.insertText", { text: "aXXc" });
    await tab.evaluate(`${draft}.setSelectionRange(1, 3, "backward"); true`);
  };
  const redraw = async () => {
    await tab.evaluate(`window.__before = ${draft}; true`);
    other.title += "!";
    await refresh();
    assert.ok(await tab.evaluate(`window.__before !== ${draft}`), "the unrelated card change rebuilt the textarea");
  };
  const replaceSelection = async () => {
    const selection = await tab.evaluate(`[${draft}.selectionStart, ${draft}.selectionEnd, ${draft}.selectionDirection]`);
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "b", code: "KeyB", windowsVirtualKeyCode: 66, text: "b" });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "b", code: "KeyB", windowsVirtualKeyCode: 66 });
    assert.deepEqual(await tab.evaluate(`[${draft}.value, document.activeElement === ${draft}]`), ["abc", true]);
    assert.deepEqual(selection, [1, 3, "backward"]);
  };
  await select(); await redraw(); await replaceSelection(); // The same refresh with the board in front.
  await select();
  const away = await page.send("Target.createTarget", { url: "about:blank" });
  await page.send("Target.activateTarget", { targetId: away.targetId });
  const awayTarget = (await cdp.listTargets(port)).find(p => p.id === away.targetId);
  const otherPage = await cdp.Cdp.connect(awayTarget.webSocketDebuggerUrl);
  t.after(() => otherPage.close());
  await otherPage.evaluate('document.body.append(document.createElement("textarea")); document.querySelector("textarea").focus(); true');
  await cdp.waitFor(() => tab.evaluate("!document.hasFocus()"), "workbench in the background");
  await redraw();
  assert.ok(await otherPage.evaluate("document.hasFocus()"));
  await otherPage.send("Input.insertText", { text: "away" });
  assert.equal(await otherPage.evaluate('document.querySelector("textarea").value'), "away");
  await page.send("Target.activateTarget", { targetId }); // No click or scripted focus on return.
  await cdp.waitFor(() => page.evaluate("document.hasFocus()"), "workbench returned to the foreground");
  await replaceSelection();

  await select();
  const peerDraft = `document.querySelector('textarea[data-draft-target="new"]')`;
  await sidebar.click(peerDraft); // A more recent selection in the same workbench.
  await redraw();
  await page.send("Target.activateTarget", { targetId: away.targetId });
  await cdp.waitFor(() => otherPage.evaluate("document.hasFocus()"), "other tab active again");
  await redraw();
  await page.send("Target.activateTarget", { targetId });
  await cdp.waitFor(() => page.evaluate("document.hasFocus()"), "workbench active again");
  await page.send("Input.insertText", { text: "peer" });
  assert.deepEqual(await sidebar.evaluate(`[${peerDraft}.value, document.activeElement === ${peerDraft}]`), ["peer", true]);
  assert.equal(await tab.evaluate(`${draft}.value`), "aXXc");
});
