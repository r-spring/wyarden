const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");

test("Open shows a refreshing read-only headless activity view without touching its terminal", async () => {
  let provider, timer, boardListener, shownTerminal = 0, shownDoc, registered = true, timerCleared = false;
  const listeners = new Set(), documents = [];
  const vscode = {
    EventEmitter: class {
      event = listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; };
      fire(value) { for (const listener of listeners) listener(value); }
      dispose() { listeners.clear(); }
    },
    Uri: { from: value => value },
    workspace: {
      textDocuments: documents,
      registerTextDocumentContentProvider: (scheme, p) => { assert.equal(scheme, "entomatical-activity"); provider = p; return { dispose: () => { registered = false; } }; },
      openTextDocument: async uri => { const doc = { uri }; documents.push(doc); return doc; },
    },
    window: { showTextDocument: async doc => { shownDoc = doc; } },
  };
  const task = { id: "a3af1f", title: "Phase 1", status: "running", headless: true, sessionId: "session" };
  let current = "Reading files", timeline = [], reply, terminalPresent = true;
  const board = {
    get: id => id === task.id ? task : undefined,
    onChange: listener => { boardListener = listener; return { dispose: () => { boardListener = undefined; } }; },
    doingOf: () => current && { text: current }, timelineOf: () => timeline,
    prompts: () => [{ text: "Do the work", ...(reply ? { reply } : {}) }],
    terminal: () => terminalPresent ? { show: () => { shownTerminal++; } } : undefined, external: new Map(),
  };
  const activityFile = require.resolve("../out/headless-activity.js"), activityModule = new Module(activityFile, module);
  activityModule.filename = activityFile;
  activityModule.require = name => name === "vscode" ? vscode : require(name);
  // Control the refresh timer without waiting or retaining one after the test.
  activityModule._compile("const setInterval = fn => (globalThis.__activityTimer = fn, 1); const clearInterval = () => { globalThis.__activityTimerCleared = true; };\n" + fs.readFileSync(activityFile, "utf8"), activityFile);
  const activity = new activityModule.exports.HeadlessActivity(board);
  timer = globalThis.__activityTimer;
  const filename = require.resolve("../out/extension.js"), extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = name => name === "vscode" ? vscode : name.startsWith("./") ? {} : require(name);
  extension._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.testHandle = handle; module.exports.setActivity = value => { headlessActivity = value; };\n", filename);
  extension.exports.setActivity(activity);
  try {
    await extension.exports.testHandle(board, { type: "open", id: task.id });
    assert.equal(shownTerminal, 0);
    assert.equal(shownDoc.uri.scheme, "entomatical-activity");
    assert.match(provider.provideTextDocumentContent(shownDoc.uri), /Card status: running[\s\S]*Reading files[\s\S]*no reply yet/);
    let changes = 0;
    provider.onDidChange(uri => { assert.equal(uri, shownDoc.uri); changes++; });
    timer();
    assert.equal(changes, 0, "unchanged views do not refresh");
    current = "Running tests"; timeline = [{ text: "03:10 Tool: tests" }];
    timer();
    assert.equal(changes, 1);
    assert.match(provider.provideTextDocumentContent(shownDoc.uri), /Running tests[\s\S]*03:10 Tool: tests/);
    task.status = "review"; current = undefined; reply = "Finished."; boardListener();
    assert.equal(changes, 2);
    assert.match(provider.provideTextDocumentContent(shownDoc.uri), /Card status: review[\s\S]*Finished\./);
    terminalPresent = false;
    await extension.exports.testHandle(board, { type: "open", id: task.id });
    assert.equal(shownTerminal, 0, "a completed headless card still opens its activity");
    terminalPresent = true;
    task.takenOver = true;
    await extension.exports.testHandle(board, { type: "open", id: task.id });
    assert.equal(shownTerminal, 1, "a taken-over card keeps its terminal");
    task.headless = false;
    await extension.exports.testHandle(board, { type: "open", id: task.id });
    assert.equal(shownTerminal, 2, "an ordinary card keeps its terminal");
    documents.length = 0; timer();
    assert.equal(changes, 2, "closed views are not refreshed");
  } finally {
    activity.dispose();
    timerCleared = globalThis.__activityTimerCleared;
    delete globalThis.__activityTimer; delete globalThis.__activityTimerCleared;
  }
  assert.equal(registered, false);
  assert.equal(timerCleared, true);
  assert.equal(boardListener, undefined);
});
