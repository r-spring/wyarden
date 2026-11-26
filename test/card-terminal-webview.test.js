const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const cdp = require("./compile-webview-cdp");
require("./safe-temp").assertSafeTemp();

test("an interactive card terminal streams, accepts input and keeps its instance on board redraw", { timeout: 60000 }, async (t) => {
  if (!cdp.edgePath()) return t.skip("Microsoft Edge, Chrome or Chromium is unavailable");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-card-terminal-"));
  const url = pathToFileURL(path.resolve(__dirname, "terminal-webview-harness.html")).href;
  let edge, page;
  try {
    edge = await cdp.launchEdge(url, scratch);
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "terminal harness");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board ready");
    await page.evaluate('document.body.style.setProperty("--vscode-terminal-ansiRed", "#dc3232"); true');
    const task = { id: "abc123", title: "Grok task", prompt: "Work", provider: "grok", status: "running", cardTerminalStarted: true, worktree: "C:\\task", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const state = { tasks: [task], live: [task.id], own: [task.id], accounts: [] };
    await page.evaluate(`window.__host(${JSON.stringify(state)}); true`);
    await cdp.waitFor(() => page.evaluate('window.__posted.some(m => m.type === "terminalAttach" && m.id === "abc123")'), "terminal attachment");
    await page.evaluate(`window.__host(${JSON.stringify({ type: "terminalState", id: task.id, generation: "g1", state: "running", snapshot: "Before\r\n\u001b[6n" })}); true`);
    await page.evaluate(`window.__host(${JSON.stringify({ type: "terminalData", id: task.id, generation: "g1", data: "\u001b[31mLive <script>\u001b[0m" })}); true`);
    await cdp.waitFor(() => page.evaluate('document.querySelector(".xterm-rows")?.textContent.includes("Live <script>")'), "streamed output");
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".xterm-rows .xterm-fg-1")).color'), "rgb(220, 50, 50)");
    assert.equal(await page.evaluate('document.querySelectorAll(".card-terminal script").length'), 0);
    assert.equal(await page.evaluate('document.querySelector(".card-terminal-header .muted").textContent'), "Live");
    assert.equal(await page.evaluate('[...document.querySelectorAll(".card-terminal style")].every(s => s.nonce === "terminal-test" && !!s.sheet)'), true, "xterm-generated styles honor strict CSP");
    assert.equal(await page.evaluate('window.__posted.some(m => m.type === "terminalResize" && m.id === "abc123" && m.generation === "g1" && m.cols > 0 && m.rows > 0)'), true);
    assert.equal(await page.evaluate('window.__posted.some(m => m.type === "terminalInput")'), false, "replaying a device query must not reply to the live process");
    assert.equal(await page.evaluate('document.querySelector(".card-terminal-screen").clientHeight'), 400, "a card terminal opens at twice the old 200px height");
    const oldRows = await page.evaluate('window.__posted.filter(m => m.type === "terminalResize").at(-1).rows');
    await page.evaluate('document.querySelector(".card-terminal-screen").style.height = "600px"; true');
    await cdp.waitFor(() => page.evaluate(`window.__posted.some(m => m.type === "terminalResize" && m.rows > ${oldRows})`), "resized terminal dimensions");
    assert.equal(await page.evaluate('document.activeElement.matches(".xterm-helper-textarea")'), false);
    // The card's own Focus terminal button gives its xterm the keyboard.
    await page.evaluate(`window.__posted.length = 0; [...document.querySelector('.card[data-task="abc123"]').querySelectorAll("button")].find(b => b.textContent === "Focus terminal").click(); true`);
    assert.equal(await page.evaluate('document.activeElement.closest(".card-terminal")?.dataset.terminalTask'), task.id);
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "x", code: "KeyX", text: "x", unmodifiedText: "x", windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "x", code: "KeyX", windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88 });
    await cdp.waitFor(() => page.evaluate('window.__posted.some(m => m.type === "terminalInput" && m.generation === "g1" && m.data === "x")'), "terminal keystroke");
    await page.evaluate('window.__terminal = document.querySelector(".card-terminal"); true');
    task.updatedAt = new Date(Date.now() + 1000).toISOString();
    await page.evaluate(`window.__host(${JSON.stringify(state)}); true`);
    assert.equal(await page.evaluate('window.__terminal === document.querySelector(".card-terminal")'), true, "redraw keeps terminal and scrollback");
    assert.equal(await page.evaluate('document.activeElement.classList.contains("xterm-helper-textarea")'), true, "terminal focus survives redraw");
    await page.evaluate(`window.__host(${JSON.stringify({ type: "terminalData", id: task.id, generation: "g1", data: "\r\nAfter redraw" })}); true`);
    await cdp.waitFor(() => page.evaluate('document.querySelector(".xterm-rows")?.textContent.includes("After redraw")'), "new output after board redraw without keyboard input");
    await page.evaluate(`window.__host(${JSON.stringify({ type: "terminalData", id: task.id, generation: "old", data: "WRONG GENERATION" })}); true`);
    await page.evaluate(`window.__host(${JSON.stringify({ type: "terminalData", id: task.id, generation: "g1", data: "\r\nStill live" })}); true`);
    await cdp.waitFor(() => page.evaluate('document.querySelector(".xterm-rows").textContent.includes("Still live")'), "current output rendered after the stale message");
    assert.equal(await page.evaluate('document.querySelector(".xterm-rows").textContent.includes("WRONG GENERATION")'), false);
    await page.evaluate(`window.__host(${JSON.stringify({ type: "terminalState", id: task.id, generation: "old", state: "exited", retired: true, exitCode: 17 })}); true`);
    assert.equal(await page.evaluate('document.querySelector(".card-terminal-header .muted").textContent'), "Live", "a retired generation cannot close the replacement screen");
    await page.evaluate(`window.__host(${JSON.stringify({ type: "terminalState", id: task.id, generation: "g1", state: "exited" })}); true`);
    assert.equal(await page.evaluate('document.querySelector(".card-terminal-header .muted").textContent'), "Exited");
    // After a window reload the first attach can come before this window owns the board: the next render asks again (card faebc2).
    const notOwner = "Another window runs this board, or this one is taking it over after a reload.";
    await page.evaluate(`window.__host(${JSON.stringify({ type: "terminalState", id: task.id, state: "unavailable", error: notOwner })}); true`);
    assert.equal(await page.evaluate('document.querySelector(".card-terminal-header .muted").textContent'), notOwner);
    await page.evaluate('window.__posted.length = 0; true');
    task.updatedAt = new Date(Date.now() + 2000).toISOString();
    await page.evaluate(`window.__host(${JSON.stringify(state)}); true`);
    await cdp.waitFor(() => page.evaluate('window.__posted.some(m => m.type === "terminalAttach" && m.id === "abc123")'), "attach retried after a refusal");
    await page.evaluate(`window.__host(${JSON.stringify({ type: "terminalState", id: task.id, state: "unavailable" })}); true`);
    assert.equal(await page.evaluate('document.querySelector(".card-terminal-header .muted").textContent'), "Ended with the last window. Press Resume to continue in a new terminal.");
    await page.evaluate('window.__posted.length = 0; true');
    task.updatedAt = new Date(Date.now() + 3000).toISOString();
    await page.evaluate(`window.__host(${JSON.stringify(state)}); true`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await page.evaluate('window.__posted.some(m => m.type === "terminalAttach")'), false, "an answered attach is not repeated");
    await page.evaluate(`(() => { window.__hiddenPosts = []; window.__hiddenTerminals = window.createCardTerminals((type, args) => window.__hiddenPosts.push({type, ...args})); const node = window.__hiddenTerminals.view({id:"hidden-task", title:"Hidden", provider:"grok"}); node.style.display="none"; node.style.width="320px"; document.body.append(node); window.__hiddenTerminalNode = node; })(); true`);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await page.evaluate('window.__hiddenPosts.some(m => m.type === "terminalAttach")'), false, "do not open a zero-size hidden terminal");
    await page.evaluate('window.__hiddenTerminalNode.style.display = "block"; true');
    await cdp.waitFor(() => page.evaluate('window.__hiddenPosts.some(m => m.type === "terminalAttach" && m.id === "hidden-task")'), "terminal becomes visible and attaches");
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* browser may still release its profile */ }
  }
});
