const test = require("node:test");
const assert = require("node:assert/strict");
const install = require("../tools/codex-panel-bridge.cjs");

test("panel bridge starts one turn in the panel's app-server, opens it while active and can interrupt it", async () => {
  const commands = new Map(), requests = [], ui = [], subscriptions = [], sequence = [];
  let provider;
  const vscode = {
    Uri: { from: (parts) => parts },
    commands: {
      registerCommand: (name, fn) => (commands.set(name, fn), { dispose() {} }),
      executeCommand: async (...args) => { ui.push(args); sequence.push(args[0]); },
    },
  };
  const connection = {
    initialized: true,
    registerProvider: (_name, handler) => (provider = handler, { dispose() {} }),
    sendRequest: (_name, id, method, params) => {
      requests.push({ method, params });
      sequence.push(method);
      const result = method === "thread/start" ? { thread: { id: "thread-1", path: "/session" } }
        : method === "turn/start" ? { turn: { id: "turn-1", status: "inProgress" } } : {};
      queueMicrotask(() => provider.onResult({ id, result }));
    },
  };
  const panel = {};
  const webviews = { editorPanels: new Map([[panel, { initialRoute: "/local/thread-1", ready: true }]]) };
  install(vscode, connection, subscriptions, webviews);
  const options = { taskId: "task", sandbox: "workspace-write", approvalPolicy: "never", cwd: "/worktree", prompt: "First line\nSecond line", named: true, title: "My task", model: "model-a", effort: "high",
    env: { ENTOMATICAL_TASK: "task" }, hooks: { "hooks.Stop": [{ matcher: "*" }] } };
  for (const policy of [
    { sandbox: "read-only", approvalPolicy: "on-request" }, { sandbox: "workspace-write", approvalPolicy: "on-request" },
    { sandbox: undefined }, { approvalPolicy: undefined, bypass: true },
  ]) {
    await assert.rejects(commands.get("entomatical.codexPanelStartWithPermissions")({ ...options, ...policy }), /Start the card in a Codex terminal/);
    assert.deepEqual(sequence, [], "unsupported options must not open a thread, panel or turn");
  }
  const result = await commands.get("entomatical.codexPanelStartWithPermissions")(options);
  assert.equal(panel.title, "My task");
  assert.deepEqual(result, { threadId: "thread-1", transcript: "/session", turnId: "turn-1", completed: false, status: undefined, threadStatus: undefined });
  assert.deepEqual(requests.map((r) => r.method), ["thread/start", "thread/name/set", "turn/start"]);
  assert.deepEqual(sequence, ["thread/start", "thread/name/set", "vscode.openWith", "turn/start"]);
  assert.deepEqual(requests[0].params, { cwd: "/worktree", model: "model-a", sandbox: "workspace-write", approvalPolicy: "never",
    config: { "hooks.Stop": [{ matcher: "*" }], "shell_environment_policy.set": { ENTOMATICAL_TASK: "task" } } });
  assert.deepEqual(requests[2].params, { threadId: "thread-1", input: [{ type: "text", text: options.prompt }], effort: "high" });
  assert.deepEqual(ui.at(-1), ["vscode.openWith", { scheme: "openai-codex", authority: "route", path: "/local/thread-1" }, "chatgpt.conversationEditor", { preview: false, preserveFocus: true }]);
  await commands.get("entomatical.codexPanelCancelStart")();
  assert.equal(requests.some(r => r.method === "turn/interrupt"), false, "a missing token cannot cancel a legacy launch");
  await commands.get("entomatical.codexPanelStop")("thread-1");
  assert.deepEqual(requests.at(-1), { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } });
  provider.onNotification({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } } });
  await assert.rejects(commands.get("entomatical.codexPanelStop")("thread-1"), /has not reported an active turn/);
});

test("cancelling while turn/start is awaiting its reply interrupts the accepted turn once its id arrives", async () => {
  const commands = new Map(), requests = [];
  let provider, turnRequest;
  const vscode = { Uri: { from: (x) => x }, commands: {
    registerCommand: (name, fn) => (commands.set(name, fn), { dispose() {} }),
    executeCommand: async () => true,
  } };
  const connection = { initialized: true,
    registerProvider: (_name, handler) => (provider = handler, { dispose() {} }),
    sendRequest: (_name, id, method, params) => {
      requests.push({ method, params });
      if (method === "turn/start") { turnRequest = id; return; }
      const result = method === "thread/start" ? { thread: { id: "thread-1", path: "/session" } } : {};
      queueMicrotask(() => provider.onResult({ id, result }));
    },
  };
  install(vscode, connection, [], { editorPanels: new Map([[{}, { initialRoute: "/local/thread-1", ready: true }]]) });
  const starting = commands.get("entomatical.codexPanelStartWithPermissions")({ taskId: "task", sandbox: "read-only", approvalPolicy: "never", launchToken: "launch-1", cwd: "/repo", prompt: "go", named: true, title: "Task" });
  while (!turnRequest) await new Promise((resolve) => setImmediate(resolve));
  await commands.get("entomatical.codexPanelCancelStart")("launch-1");
  provider.onNotification({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "A" } } });
  provider.onNotification({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "A", status: "completed" } } });
  assert.deepEqual(requests.filter((r) => r.method === "turn/interrupt"), []);
  provider.onNotification({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
  provider.onResult({ id: turnRequest, result: { turn: { id: "turn-1" } } });
  await starting;
  assert.deepEqual(requests.filter((x) => x.method === "turn/interrupt"), [{ method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } }]);
});

async function pendingDispatch(t, { holdInterrupt = false, sendError = false, bridge = install } = {}) {
  const commands = new Map(), events = [], interrupts = [], warnings = [];
  let sent = Promise.withResolvers();
  const interruptReplies = [];
  let provider, expire;
  const setTimer = global.setTimeout;
  t.mock.method(global, "setTimeout", (fn, delay, ...args) => {
    const timer = setTimer(fn, delay, ...args);
    if (delay === 30_000) expire = () => { clearTimeout(timer); fn(); };
    return timer;
  });
  const vscode = { Uri: { from: value => value }, window: { showWarningMessage: text => warnings.push(text) }, commands: {
    registerCommand: (name, handler) => commands.set(name, handler),
    executeCommand: async (name, arg) => {
      if (name === "entomatical.codexPanelEvent") events.push(arg);
      return true;
    },
  } };
  const connection = {
    initialized: true, registerProvider: (_, handler) => { provider = handler; },
    sendRequest: (_, id, method, params) => {
      if (method === "turn/start") {
        sent.resolve(id);
        if (sendError) throw new Error("transport lost while sending");
        return;
      }
      if (method === "turn/interrupt") {
        interrupts.push(params);
        if (holdInterrupt) {
          interruptReplies.push(error => provider.onResult(error ? { id, error: { message: error } } : { id, result: {} }));
          return;
        }
      }
      provider.onResult({ id, result: method === "thread/start" ? { thread: { id: "thread" } } : {} });
    },
  };
  bridge(vscode, connection, [], { editorPanels: new Map([[{}, { initialRoute: "/local/thread", ready: true }]]) });
  const launch = async launchToken => {
    const start = commands.get("entomatical.codexPanelStartWithPermissions")({ taskId: "card", launchToken, cwd: "/repo",
      prompt: "B", named: true, title: "Fixture", sandbox: "read-only", approvalPolicy: "never" });
    const id = await sent.promise;
    sent = Promise.withResolvers();
    return { start, ack: turnId => provider.onResult({ id, result: { turn: { id: turnId } } }),
      reject: () => provider.onResult({ id, error: { message: "fixture refused: outcome is unknown" } }) };
  };
  const first = await launch("launch");
  return { ...first, launch, events, interrupts, interruptReplies, warnings, expire: () => expire(),
    notify: message => provider.onNotification(message),
    wait: () => provider.onNotification({ method: "thread/status/changed", params: { threadId: "thread",
      status: { type: "active", activeFlags: ["waitingOnApproval"] } } }),
    end: (turnId, threadId = "thread", status = "completed", fields = {}) =>
      provider.onNotification({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, ...fields } } }),
    disconnect: () => provider.onFatalError(new Error("fixture connection lost")),
    reconnect: () => provider.onInitialized(),
    stop: () => commands.get("entomatical.codexPanelStop")("thread"),
    cancel: (token = "launch") => commands.get("entomatical.codexPanelCancelStart")(token),
  };
}

const finalItem = (text, fields) => ({ id: "reply", type: "agentMessage", phase: "final_answer", text, ...fields });
const question = "Which should we use?\n1. Keep the file\n2. Replace the file\n";
const statement = "Everything passed.\n```\n" + "example\n".repeat(120) + "Continue?"; // unclosed fence, including the last 600 characters

test("timed-out dispatch bounds retained foreign replies and drops them immediately on exact cancellation", async t => {
  // Inspect the live launch, including while no acknowledgement is coming. Delivery alone cannot show discarded bodies.
  let active;
  const set = Map.prototype.set;
  const capture = t.mock.method(Map.prototype, "set", function(key, value) {
    if (key === "thread" && value?.launchToken === "launch") active = value;
    return set.call(this, key, value);
  });
  const f = await pendingDispatch(t);
  capture.mock.restore();
  assert.ok(active);
  function retained() {
    const seen = new Set(), replies = [];
    function visit(node) {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (typeof node.text === "string") replies.push(Buffer.byteLength(node.text));
      for (const value of node instanceof Map || node instanceof Set ? node.values() : Object.values(node)) visit(value);
    }
    visit(active);
    return [replies.length, replies.reduce((sum, size) => sum + size, 0)];
  }
  f.expire();
  assert.equal((await f.start).uncertain, true);
  const flood = start => {
    for (let i = start; i < start + 32; i++) {
      const text = String(i).padEnd(64 * 1024, "x");
      f.end("foreign-" + i, "thread", "completed", { error: null, items: [finalItem(text)] });
    }
  };
  flood(0);
  const before = retained();
  await f.cancel("other-launch");
  assert.deepEqual(retained(), before);
  await f.cancel();
  const cancelled = retained();
  flood(32);
  f.notify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "foreign-after-cancel", status: "completed",
    error: null, get items() { assert.fail("cancelled dispatch read the reply items"); } } } });
  const after = retained();
  assert.deepEqual(f.events, []);
  f.ack("B");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.interrupts, [{ threadId: "thread", turnId: "B" }]);
  assert.deepEqual(f.events.map(e => [e.method, e.turnId]), [["dispatch/accepted", "B"]]);
  assert.deepEqual({ before, cancelled, after }, { before: [4, 262144], cancelled: [0, 0], after: [0, 0] });
});

for (const [buffered, extraByte] of [[true, false], [true, true], [false, true]]) {
  test(`reply limit includes UTF-8 item ID and full text / buffered ${buffered} / over by one byte ${extraByte}`, async t => {
    const f = await pendingDispatch(t);
    const id = "éé", text = "é".repeat(65534) + (extraByte ? "?" : "");
    assert.equal(Buffer.byteLength(id) + Buffer.byteLength(text), 128 * 1024 + Number(extraByte));
    if (!buffered) { f.ack("B"); await f.start; }
    f.end("B", "thread", "completed", { error: null, items: [finalItem(text, { id })] });
    if (buffered) { f.ack("B"); assert.equal((await f.start).completed, true); }
    assert.deepEqual(f.events[0].terminalEvidence, buffered && extraByte ? { outcome: "completed" }
      : { outcome: "completed", finalAnswer: { itemId: id, text, asks: extraByte } });
  });
}

test("full pre-ack buffer preserves identical duplicates and keeps overflow completions identifiable", async t => {
  const f = await pendingDispatch(t);
  const finish = (id, text) => f.end(id, "thread", "completed", { error: null, items: [finalItem(text)] });
  for (const confirmed of ["fourth", "overflow", "replacement"]) {
    const launch = confirmed === "fourth" ? f : await f.launch(confirmed);
    for (const id of ["first", "second", "third", "fourth", "overflow"]) finish(id, question);
    finish("fourth", question);
    finish("first", statement); // conflict releases its occupied slot
    finish("replacement", question);
    finish("overflow", question); // cannot restore evidence that was dropped
    launch.ack(confirmed);
    assert.equal((await launch.start).completed, true);
    const end = f.events.at(-1);
    assert.equal(end.turnId, confirmed);
    assert.deepEqual(end.terminalEvidence, confirmed === "overflow" ? { outcome: "completed" }
      : { outcome: "completed", finalAnswer: { itemId: "reply", text: question, asks: true } });
  }
});

for (const hasTerminalItem of [true, false]) {
  test(`direct panel sends the final item before the terminal summary / summary includes item ${hasTerminalItem}`, async t => {
    const f = await pendingDispatch(t);
    f.ack("B");
    await f.start;
    f.notify({ method: "turn/started", params: { threadId: "thread", turn: { id: "B", status: "inProgress", items: [], itemsView: "notLoaded" } } });
    const item = finalItem("1. Add an example.\n2. Check it.\n\nDo you approve this plan?", { questions: null });
    for (const completed of [{ id: "prompt", type: "userMessage" }, item]) {
      f.notify({ method: "item/completed", params: { threadId: "thread", turnId: "B", item: completed } });
    }
    assert.deepEqual(f.events.map(e => e.method), ["turn/started"]);
    f.end("B", "thread", "completed", { error: null, itemsView: "summary", items: hasTerminalItem ? [item] : [] });
    assert.deepEqual(f.events.map(e => e.method), ["turn/started", "turn/completed"]);
    assert.deepEqual(f.events[1].terminalEvidence, hasTerminalItem
      ? { outcome: "completed", finalAnswer: { itemId: item.id, text: item.text, asks: true } }
      : { outcome: "completed" });
  });
}

for (const bundled of [true, false]) {
  test(`standalone sidecar on successive turns on one thread / classifier installed ${bundled}`, async t => {
    const fs = require("node:fs"), path = require("node:path");
    const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "panel-classifier-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const original = "activate();title();";
    const spec = { version: "fixture", sha256: require("node:crypto").createHash("sha256").update(original).digest("hex"),
      activation: "activate();", title: "title();" };
    fs.mkdirSync(path.join(dir, "out"));
    fs.mkdirSync(path.join(dir, "hook"));
    fs.writeFileSync(path.join(dir, "hook", "hook.js"), "throw new Error('loaded an unrelated extension hook')");
    fs.writeFileSync(path.join(dir, "out", "extension.js"), original);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ publisher: "openai", name: "chatgpt", version: spec.version }));
    const sidecar = path.join(dir, "out", "entomatical-panel-bridge.cjs");
    if (bundled) require("../tools/codex-panel-patch.cjs").change(dir, "install", spec);
    else fs.copyFileSync(require.resolve("../tools/codex-panel-bridge.cjs"), sidecar); // older installer copied only the source
    const f = await pendingDispatch(t, { bridge: require(sidecar) });
    const finish = (id, text) => f.end(id, "thread", "completed", { items: [finalItem(text)], error: null });
    finish("A", question);
    f.ack("A");
    await f.start;
    const next = await f.launch("next");
    next.ack("B");
    await next.start;
    finish("A", question);
    finish("B", statement);
    assert.deepEqual(f.events.map(e => [e.turnId, e.launchToken, e.terminalEvidence.finalAnswer]), [
      ["A", "launch", { itemId: "reply", text: question, ...(bundled && { asks: true }) }],
      ["B", "next", { itemId: "reply", text: statement, ...(bundled && { asks: false }) }],
    ]);
  });
}

for (const buffered of [false, true]) {
  for (const [name, status, fields, expected] of [
    ["question", "completed", { error: null, items: [finalItem("Working.", { id: "progress", phase: "commentary" }), finalItem(question)] }, true],
    ["statement", "completed", { error: null, items: [finalItem(statement)] }, false],
    ["status only", "completed", {}, undefined],
    ["unreported error field", "completed", { items: [finalItem(question)] }, undefined],
    ["missing items", "completed", { error: null }, "unknown"],
    ["no final answer", "completed", { error: null, items: [finalItem("Continue?", { phase: "commentary" })] }, "unknown"],
    ["conflicting replies", "completed", { error: null, items: [finalItem(question), finalItem(statement, { id: "other" })] }, "unknown"],
    ["conflicting item ID", "completed", { error: null, items: [finalItem(question), { type: "commandExecution", id: "reply" }] }, "unknown"],
    ["empty text", "completed", { error: null, items: [finalItem(" ")] }, "unknown"],
    ["missing item ID", "completed", { error: null, items: [finalItem(question, { id: undefined })] }, "unknown"],
    ["foreign item turn", "completed", { error: null, items: [finalItem(question, { turnId: "A" })] }, "unknown"],
    ["foreign item thread", "completed", { error: null, items: [finalItem(question, { threadId: "elsewhere" })] }, "unknown"],
    ["inconsistent turn thread", "completed", { error: null, threadId: "elsewhere", items: [finalItem(question)] }, undefined],
    ["completed with error", "completed", { error: { message: "failure" }, items: [finalItem(question)] }, undefined],
    ["failed", "failed", { error: { message: "failure" }, items: [finalItem(question)] }, undefined],
    ["interrupted", "interrupted", { error: null, items: [finalItem(question)] }, undefined],
  ]) {
    test(`terminal evidence / ${name} / ${buffered ? "before" : "after"} acknowledgement`, async t => {
      const f = await pendingDispatch(t);
      if (!buffered) { f.ack("B"); await f.start; }
      const foreign = { error: null, items: [finalItem("Unrelated reply?")] };
      f.end("A", "thread", "completed", foreign);
      f.end("B", "another-thread", "completed", foreign);
      f.end("B", "thread", status, fields);
      if (buffered) {
        assert.deepEqual(f.events, []);
        f.ack("B");
        await f.start;
      }
      const answer = expected === true ? question : statement;
      const evidence = typeof expected === "boolean" ? { outcome: "completed", finalAnswer: { itemId: "reply", text: answer, asks: expected } }
        : expected === "unknown" ? { outcome: "completed" } : undefined;
      assert.deepEqual(f.events, [{ taskId: "card", launchToken: "launch", threadId: "thread", turnId: "B",
        method: "turn/completed", status, ...(evidence && { terminalEvidence: evidence }) }]);
    });
  }
}

for (const second of ["same", "different", "failed"]) {
  test(`buffered terminal evidence on duplicate notices / ${second}`, async t => {
    const f = await pendingDispatch(t);
    const reply = finalItem(question);
    f.end("B", "thread", "completed", { items: [reply], error: null });
    f.end("B", "thread", second === "failed" ? "failed" : "completed",
      { items: [second === "different" ? finalItem(statement) : reply], error: null });
    f.ack("B");
    await f.start;
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].status, "completed");
    assert.deepEqual(f.events[0].terminalEvidence, second === "failed" ? undefined : { outcome: "completed",
      ...(second === "same" && { finalAnswer: { itemId: "reply", text: question, asks: true } }) });
  });
}

test("exact-token Stop ignores a replacement on the same thread and deduplicates its own interrupt", async t => {
  const f = await pendingDispatch(t);
  f.end("A");
  f.expire();
  assert.equal((await f.start).uncertain, true);
  f.ack("A");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.events.filter(event => event.method === "turn/completed").map(event => event.turnId), ["A"]);
  await f.cancel("launch");
  assert.deepEqual(f.interrupts, []);
  const next = await f.launch("new-token");
  await f.cancel("launch");
  next.ack("B");
  await next.start;
  await f.cancel("launch");
  await f.cancel("thread");
  assert.deepEqual(f.interrupts, []);
  await Promise.all([f.cancel("new-token"), f.cancel("new-token")]);
  await f.cancel("new-token");
  f.end("B");
  await f.cancel("new-token");
  assert.deepEqual(f.interrupts, [{ threadId: "thread", turnId: "B" }]);
});

test("exact-token Stop latches on a silent start without guessing a turn", async t => {
  const f = await pendingDispatch(t);
  f.expire();
  assert.equal((await f.start).uncertain, true);
  f.end("A");
  await f.cancel();
  await f.cancel();
  assert.deepEqual(f.interrupts, []);
  f.ack("B");
  await new Promise(resolve => setImmediate(resolve));
  await f.cancel();
  assert.deepEqual(f.interrupts, [{ threadId: "thread", turnId: "B" }]);
});

test("exact-token Stop skips an acknowledged turn that finishes before the interrupt goes on the wire", async t => {
  const f = await pendingDispatch(t);
  f.ack("B");
  await f.start;
  const stopping = f.cancel();
  f.end("B");
  await stopping;
  assert.deepEqual(f.interrupts, []);
});

test("a known refusal survives a disconnect between retry and transmission", async t => {
  const f = await pendingDispatch(t, { holdInterrupt: true });
  f.ack("B");
  await f.start;
  const first = assert.rejects(f.cancel(), /refused/);
  await new Promise(resolve => setImmediate(resolve));
  f.interruptReplies[0]("interrupt refused");
  await first;
  const retry = assert.rejects(f.cancel(), /connection lost/);
  f.disconnect();
  await new Promise(resolve => setImmediate(resolve));
  f.interruptReplies[1]?.("fixture connection lost");
  await retry;
  f.reconnect();
  f.wait();
  assert.deepEqual(f.interrupts.map(request => request.turnId), ["B"]);
  assert.deepEqual(f.events.map(event => event.method), ["thread/status/changed"]);
});

for (const transmitted of [false, true]) {
  for (const refused of [false, true]) {
    test(`timed-out interrupt's late reply / retry transmitted ${transmitted} / refusal ${refused}`, async t => {
      const f = await pendingDispatch(t, { holdInterrupt: true });
      f.ack("B");
      await f.start;
      const first = assert.rejects(f.cancel(), /outcome is unknown/);
      await new Promise(resolve => setImmediate(resolve));
      f.expire();
      await first;
      const retry = f.cancel();
      if (transmitted) await new Promise(resolve => setImmediate(resolve));
      f.interruptReplies[0](refused ? "late refusal" : undefined);
      f.wait();
      const duplicate = f.cancel();
      await new Promise(resolve => setImmediate(resolve));
      f.wait();
      for (const reply of f.interruptReplies.slice(1)) reply();
      await Promise.all([retry, duplicate]);
      f.interruptReplies[0]("duplicate late refusal");
      f.wait();
      // Only a refusal before the retry transmits exposes the first wait. A late acceptance then makes the retry unnecessary.
      assert.equal(f.events.filter(e => e.method === "thread/status/changed").length, !transmitted && refused ? 1 : 0);
      assert.deepEqual(f.interrupts.map(request => request.turnId), transmitted || refused ? ["B", "B"] : ["B"]);
    });
  }
}

test("a timed-out interrupt's late refusal cannot expose a replacement turn", async t => {
  const f = await pendingDispatch(t, { holdInterrupt: true });
  f.ack("B");
  await f.start;
  const first = assert.rejects(f.cancel(), /outcome is unknown/);
  await new Promise(resolve => setImmediate(resolve));
  f.expire();
  await first;
  f.end("B");
  const next = await f.launch("new-token");
  next.ack("C");
  await next.start;
  const stop = f.cancel("new-token");
  await new Promise(resolve => setImmediate(resolve));
  f.interruptReplies[0]("late refusal for B");
  f.wait();
  f.interruptReplies[1]();
  await stop;
  assert.deepEqual(f.events.filter(event => event.method === "thread/status/changed"), []);
  assert.deepEqual(f.interrupts.map(request => request.turnId), ["B", "C"]);
});

for (const late of [false, true]) {
  for (const outcome of ["ack", "reject", "early end", "cancel"]) {
    test(`B dispatch after A completes / ${outcome} / ${late ? "late" : "on time"}`, async t => {
      const f = await pendingDispatch(t);
      f.end("A");
      f.end(undefined);
      f.end("B", "other-thread");
      if (outcome === "early end") {
        f.end("B", "thread", "interrupted");
        f.end("A");
      }
      assert.deepEqual(f.events, []);
      if (late) {
        f.expire();
        const result = await f.start;
        assert.deepEqual([result.uncertain, result.completed, result.turnId], [true, false, undefined]);
      }
      if (outcome === "reject") {
        f.reject();
        if (!late) await assert.rejects(f.start, /fixture refused/);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(f.events.map(e => e.method), late ? ["dispatch/rejected"] : []);
        await assert.rejects(f.stop(), /active turn/);
        return;
      }
      let stopping;
      if (outcome === "cancel" || outcome === "early end") {
        if (late) stopping = f.stop(); else await f.cancel();
        assert.deepEqual(f.interrupts, []);
      }
      f.ack("B");
      const result = await f.start;
      await stopping;
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(f.interrupts, outcome === "cancel" ? [{ threadId: "thread", turnId: "B" }] : []);
      if (!late) assert.deepEqual([result.threadId, result.turnId, result.completed], ["thread", "B", outcome === "early end"]);
      if (outcome !== "early end") {
        f.end("A");
        f.end(undefined);
        assert.equal(f.events.some(e => e.method === "turn/completed"), false);
        await f.stop();
        assert.deepEqual(f.interrupts, [{ threadId: "thread", turnId: "B" }]);
        f.end("B");
      } else assert.deepEqual(f.interrupts, []);
      f.end("B"); // duplicate after settlement
      const ends = f.events.filter(e => e.method === "turn/completed");
      assert.deepEqual(ends.map(e => [e.threadId, e.turnId, e.launchToken, e.status]),
        [["thread", "B", "launch", outcome === "early end" ? "interrupted" : "completed"]]);
      await assert.rejects(f.stop(), /active turn/);
    });
  }
}

for (const cancelStart of [false, true]) {
  test(`buffered success after timeout distinguishes stopping the thread from cancelling the launch / CancelStart ${cancelStart}`, async t => {
    const f = await pendingDispatch(t);
    f.end("B");
    f.expire();
    assert.equal((await f.start).uncertain, true);
    // A Board still awaiting command delivery cancels its launch token. An owned thread uses Stop instead.
    const stopping = cancelStart ? f.cancel() : f.stop();
    f.ack("B");
    await stopping;
    await new Promise(resolve => setImmediate(resolve));
    const ends = f.events.filter(event => event.method === "turn/completed");
    assert.deepEqual(ends.map(event => event.turnId), cancelStart ? [] : ["B"]);
    await assert.rejects(f.stop(), /has not reported an active turn/);
    assert.deepEqual(f.interrupts, []);
  });
}

for (const ended of [false, true]) {
  test(`deferred cancellation reports an interrupt refusal only while B is outstanding / ended ${ended}`, async t => {
    const f = await pendingDispatch(t, { holdInterrupt: true });
    await f.cancel();
    f.ack("B");
    await new Promise(resolve => setImmediate(resolve));
    f.end(ended ? "B" : "A");
    f.interruptReplies[0]("fixture interrupt refused");
    const result = await f.start;
    assert.deepEqual([result.completed, f.warnings.length], [ended, ended ? 0 : 1]);
    assert.deepEqual(f.events.filter(e => e.method === "turn/completed").map(e => e.turnId), ended ? ["B"] : []);
    if (!ended) assert.match(f.warnings[0], /fixture interrupt refused/);
    assert.deepEqual(f.interrupts, [{ threadId: "thread", turnId: "B" }]);
  });
}

for (const outcome of ["missing id", "disconnect"]) {
  test(`an unidentifiable dispatch cannot complete or interrupt a guessed turn / ${outcome}`, async t => {
    const f = await pendingDispatch(t);
    f.end("A");
    await f.cancel();
    if (outcome === "missing id") f.ack(undefined); else f.disconnect();
    const result = await f.start;
    f.end("B");
    assert.deepEqual([result.uncertain, result.turnId, result.completed, f.events, f.interrupts], [true, undefined, false, [], []]);
    assert.match(f.warnings[0], /did not identify/);
    await assert.rejects(f.stop(), /active turn/);
  });
}

test("a transport exception during send supplies no authoritative turn or rejection", async t => {
  const f = await pendingDispatch(t, { sendError: true });
  const result = await f.start;
  f.end("A");
  assert.deepEqual([result.uncertain, result.turnId, result.completed, f.events], [true, undefined, false, []]);
  await assert.rejects(f.stop(), /active turn/);
});
