// F101: the prompt row (Run a plan… and Load handoff above the prompt box), the handoff lister, and the insert message.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { listHandoffs, handoffDir, handoffPrompt, detectHandoff } = require("../out/handoffs");
const cdp = require("./compile-webview-cdp");

test("A0 handoffPrompt: a marker line with the forward-slash path, a newline, then the doc's text unchanged", () => {
  const text = "# Next steps\r\n\r\n- keep `C:\\x` as is\n  trailing  \n";
  assert.equal(handoffPrompt("C:\\Users\\user\\Dev Stuff\\docs\\handoffs\\2026-11-12-next.md", text),
    "<!-- handoff: C:/Users/user/Dev Stuff/docs/handoffs/2026-11-12-next.md -->\n" + text);
  assert.equal(handoffPrompt("/home/example/repo/docs/handoffs/a.md", ""), "<!-- handoff: /home/example/repo/docs/handoffs/a.md -->\n");
});

test("A1 listHandoffs: the .md files in docs/handoffs/, newest first, without README.md", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-handoffs-"));
  try {
    const dir = handoffDir(repo);
    assert.deepEqual(listHandoffs(dir), [], "a missing folder lists nothing");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "README.md"), "# Handoff docs\n");
    fs.writeFileSync(path.join(dir, "older.md"), "old\n");
    fs.writeFileSync(path.join(dir, "notes.txt"), "not markdown\n");
    fs.mkdirSync(path.join(dir, "sub.md"));
    fs.writeFileSync(path.join(dir, "newer.md"), "new\n");
    const t = Date.now() / 1000;
    fs.utimesSync(path.join(dir, "older.md"), t - 100, t - 100);
    fs.utimesSync(path.join(dir, "newer.md"), t, t);
    const listed = listHandoffs(dir);
    assert.deepEqual(listed.map((h) => h.name), ["newer.md", "older.md"]);
    assert.equal(listed[0].file, path.join(dir, "newer.md"), "the absolute path");
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("A2 webview: the prompt row holds Run a plan… and Load handoff, no title box, and insertPrompt fills the prompt without starting a task", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) return t.skip("Microsoft Edge, Chrome or Chromium is unavailable");
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-handoff-view-"));
  let edge, page;
  try {
    edge = await cdp.launchEdge(url, scratch);
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "the board");
    const layout = await page.evaluate(`(() => { const p = document.querySelector('textarea[placeholder="Task prompt"]');
      const row = document.querySelector('.form .prompt-row'); const wrap = p.closest('.form > *');
      return { titleBox: !!document.querySelector('input[placeholder="Title (optional)"]'), buttons: row ? [...row.querySelectorAll('button')].map((b) => b.textContent) : null,
        above: !!row && row.nextElementSibling === wrap,
        elsewhere: [...document.querySelectorAll('button')].filter((b) => b.textContent === "Run a plan…" && !row.contains(b)).length }; })()`);
    assert.deepEqual(layout, { titleBox: false, buttons: ["Run a plan…", "Load handoff"], above: true, elsewhere: 0 });
    // Load handoff asks the host; it starts nothing itself.
    await page.evaluate(`window.__posted.length = 0; [...document.querySelectorAll('.prompt-row button')].find((b) => b.textContent === "Load handoff").click(); true`);
    assert.deepEqual(await page.evaluate("window.__posted"), [{ type: "loadHandoff" }]);
    const file = path.join(scratch, "docs", "handoffs", "2026-11-12-next.md");
    const insert = handoffPrompt(file, "# Next\n\nDo the thing.\n");
    await page.evaluate(`document.querySelector('textarea[placeholder="Task prompt"]').value = "old draft"; window.__posted.length = 0; window.__host({ insertPrompt: ${JSON.stringify(insert)} }); true`);
    const after = await page.evaluate(`(() => { const p = document.querySelector('textarea[placeholder="Task prompt"]');
      return { value: p.value, focused: document.activeElement === p, saved: window.__state && window.__state.prompt, posted: window.__posted }; })()`);
    assert.deepEqual(after, { value: insert, focused: true, saved: insert, posted: [] }, "the doc's text replaces the box and is saved; no create was posted");
    // A title that comes back with a refused create is not lost: the next Add task sends it.
    await page.evaluate(`window.__host({ failed: { type: "create", title: "Kept title", prompt: "Do it" } }); window.__posted.length = 0; addTask(); true`);
    const create = await page.evaluate(`window.__posted.find((m) => m.type === "create")`);
    assert.equal(create.title, "Kept title");
    assert.equal(create.prompt, "Do it");
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* Edge may still hold a file */ }
  }
});

// Refine draft's handoff mode (plan 70d079 step 4): the host's detection, before the helper runs.
test("A3 detectHandoff: the marker line Load handoff writes, after blank lines; the rest of the box is the handoff as edited; no file is read", () => {
  const read = () => { throw new Error("the marker case reads no file"); };
  const h = detectHandoff("\n  \r\n<!-- handoff: C:/Users/user/Dev Stuff/docs/handoffs/2026-11-12-next.md -->\r\n# Goal\nDo X (edited)\n", read);
  assert.deepEqual(h, { path: "C:/Users/user/Dev Stuff/docs/handoffs/2026-11-12-next.md", name: "2026-11-12-next.md", text: "# Goal\nDo X (edited)\n",
    draft: "<!-- handoff: C:/Users/user/Dev Stuff/docs/handoffs/2026-11-12-next.md -->\n# Goal\nDo X (edited)\n" });
  const loaded = handoffPrompt("/home/example/repo/docs/handoffs/a.md", "# A\n");
  assert.deepEqual(detectHandoff(loaded, read), { path: "/home/example/repo/docs/handoffs/a.md", name: "a.md", text: "# A\n", draft: loaded }, "what Load handoff writes round-trips");
  assert.equal(detectHandoff("<!-- handoff: /x/docs/handoffs/a.md -->", read).text, "", "a marker alone is a handoff with empty text (generateText refuses it)");
});

test("A4 detectHandoff: a bare absolute path to an existing .md in docs/handoffs is read; anything else is an ordinary draft", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-detect-"));
  try {
    const dir = handoffDir(repo), file = path.join(dir, "next.md"), text = "# Next\r\n\r\nDo the thing.\n";
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, text);
    const want = { path: file.replace(/\\/g, "/"), name: "next.md", text, draft: handoffPrompt(file, text) };
    assert.deepEqual(detectHandoff(`  ${file}\n`), want, "the bare path, with surrounding spaces");
    assert.deepEqual(detectHandoff(`"${file}"`), want, "a quoted path (Copy as path)");
    // Missing file, wrong folder, relative path, a path with more text, a plain draft, a marker that is not the first non-blank line.
    assert.equal(detectHandoff(path.join(dir, "missing.md")), undefined, "a missing file is an ordinary draft");
    fs.mkdirSync(path.join(repo, "docs", "plans"), { recursive: true });
    const elsewhere = path.join(repo, "docs", "plans", "next.md"); fs.writeFileSync(elsewhere, text);
    assert.equal(detectHandoff(elsewhere), undefined, "outside docs/handoffs");
    assert.equal(detectHandoff(path.join("docs", "handoffs", "next.md")), undefined, "a relative path");
    assert.equal(detectHandoff(`${file}\nand refine it`), undefined, "a path with more text");
    fs.mkdirSync(path.join(dir, "folder.md"));
    assert.equal(detectHandoff(path.join(dir, "folder.md")), undefined, "a folder named .md");
    assert.equal(detectHandoff("Fix the flaky test in test/voice.test.js."), undefined, "a plain draft");
    assert.equal(detectHandoff(`Please read this:\n${handoffPrompt(file, text)}`), undefined, "the marker after other text");
    assert.equal(detectHandoff(""), undefined);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("A5 webview: Refine draft says when the host found a handoff, while it runs and with the result", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) return t.skip("Microsoft Edge, Chrome or Chromium is unavailable");
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-handoff-refine-"));
  let edge, page;
  try {
    edge = await cdp.launchEdge(url, scratch);
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "the board");
    const text = () => page.evaluate(`document.querySelector('[data-refine-target="new"]').textContent`);
    await page.evaluate(`refinements.set("new", { requestId: "r1", original: "<!-- handoff: /x/docs/handoffs/next.md -->\\n# Next", pending: true }); refreshRefinement("new"); true`);
    assert.doesNotMatch(await text(), /Handoff detected/, "nothing is said before the host decides");
    await page.evaluate(`window.__host({ refinementMode: { requestId: "other", target: "new", handoff: "wrong.md" } }); true`);
    assert.doesNotMatch(await text(), /Handoff detected/, "another request's mode is ignored");
    await page.evaluate(`window.__host({ refinementMode: { requestId: "r1", target: "new", handoff: "next.md" } }); true`);
    assert.match(await text(), /Handoff detected: writing a task prompt from next\.md\./);
    await page.evaluate(`window.__host({ refinement: { requestId: "r1", target: "new", kind: "revision", revision: "Goal: do it.\\n\\nFull handoff: /x/docs/handoffs/next.md", questions: [], assumptions: [], model: "m", handoff: "next.md" } }); true`);
    const done = await text();
    assert.match(done, /Handoff mode: a task prompt for a new session, written from next\.md\. Apply replaces the handoff in the box\./);
    assert.doesNotMatch(done, /Handoff detected/);
  } finally {
    page?.close();
    if (edge) await edge.kill();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* Edge may still hold a file */ }
  }
});
