// src/asana.ts: Asana as the context store for board tasks. A fake fetch stands in for app.asana.com.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Asana, contextBlock, finishComment, projectGid, NOTES_CAP, COMMENTS } = require("../out/asana.js");

const TOKEN = "1/secret-token-value";
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body && JSON.parse(init.body) });
    const path = url.replace("https://app.asana.com/api/1.0", "");
    const hit = Object.entries(routes).find(([prefix]) => path.startsWith(prefix));
    if (!hit) return { ok: false, status: 404, json: async () => ({ errors: [{ message: `no route ${path}` }] }) };
    const value = typeof hit[1] === "function" ? hit[1](path, init) : hit[1];
    return { ok: value.status === undefined || value.status < 400, status: value.status ?? 200, json: async () => value.body ?? value };
  };
  return { fetch, calls };
}

test("refuses to run without a token", () => {
  assert.throws(() => new Asana("", async () => ({})), /No Asana token/);
});

test("context reads the task and its comments, sends the token only as a bearer header", async () => {
  const { fetch, calls } = fakeFetch({
    "/tasks/42?": { data: { name: "Fix the dock", notes: "Plank 3 is loose.", permalink_url: "https://app.asana.com/0/1/42", due_on: "2026-11-20", assignee: { name: "the user" } } },
    "/tasks/42/stories": { data: [
      { type: "system", text: "added to project", created_at: "2026-11-01T10:00:00Z" },
      { type: "comment", text: "Bought screws.", created_at: "2026-11-02T09:00:00Z", created_by: { name: "Cassidy" } },
    ] },
  });
  const text = await new Asana(TOKEN, fetch).context("42", new Date("2026-11-02T12:00:00Z"));
  assert.match(text, /Asana context \(added by Entomatical/);
  assert.match(text, /Task: Fix the dock \(https:\/\/app\.asana\.com\/0\/1\/42\)/);
  assert.match(text, /Due: 2026-11-20/);
  assert.match(text, /Plank 3 is loose\./);
  assert.match(text, /- Cassidy, 2026-11-02: Bought screws\./);
  assert.doesNotMatch(text, /added to project/); // system stories are not comments
  assert.ok(calls.every((c) => c.headers.Authorization === `Bearer ${TOKEN}`));
  assert.ok(calls.every((c) => !c.url.includes(TOKEN)));
  assert.doesNotMatch(text, /secret-token/);
});

test("an Asana error names the status and message, never the token", async () => {
  const { fetch } = fakeFetch({ "/tasks/9": { status: 403, body: { errors: [{ message: "Not authorized" }] } } });
  await assert.rejects(new Asana(TOKEN, fetch).context("9"), (e) => /Asana answered 403: Not authorized/.test(e.message) && !e.message.includes(TOKEN));
});

test("open tasks follow next_page and say when more were left unread", async () => {
  let page = 0;
  const { fetch, calls } = fakeFetch({ "/projects/7/tasks": () => ({ data: [{ gid: String(++page), name: `T${page}`, permalink_url: `u${page}` }, { gid: "x", name: " " }], next_page: { offset: `o${page}` } }) });
  const r = await new Asana(TOKEN, fetch).openTasks("7");
  assert.equal(calls.length, 5);
  assert.ok(calls[0].url.includes("completed_since=now") && calls[0].url.includes("limit=100"));
  assert.ok(calls[1].url.includes("offset=o1"));
  assert.equal(r.tasks.length, 5); // unnamed rows (section headers) are left out
  assert.equal(r.truncated, true);
});

test("create posts name, notes and project; comment posts text", async () => {
  const { fetch, calls } = fakeFetch({
    "/tasks?": (p, init) => ({ data: { gid: "99", name: JSON.parse(init.body).data.name, permalink_url: "https://app.asana.com/0/7/99" } }),
    "/tasks/99/stories": { data: { gid: "s1" } },
  });
  const asana = new Asana(TOKEN, fetch);
  assert.deepEqual(await asana.create("7", "Card title", "Card prompt"), { gid: "99", name: "Card title", url: "https://app.asana.com/0/7/99" });
  assert.deepEqual(calls[0].body, { data: { name: "Card title", notes: "Card prompt", projects: ["7"] } });
  assert.equal(calls[0].method, "POST");
  await asana.comment("99", "Done.");
  assert.deepEqual(calls[1].body, { data: { text: "Done." } });
});

test("workspaces, then one workspace's projects sorted by name", async () => {
  const { fetch, calls } = fakeFetch({
    "/workspaces": { data: [{ gid: "1", name: "Example Co" }, { gid: "2", name: "Personal" }] },
    "/projects?workspace=2": { data: [{ gid: "b", name: "Zebra" }, { gid: "a", name: "Apple" }] },
  });
  const asana = new Asana(TOKEN, fetch);
  assert.deepEqual(await asana.workspaces(), [{ gid: "1", name: "Example Co" }, { gid: "2", name: "Personal" }]);
  assert.deepEqual(await asana.projects("2"), [{ gid: "a", name: "Apple" }, { gid: "b", name: "Zebra" }]);
  assert.ok(calls[1].url.includes("archived=false"));
});

test("the context block caps a long description and keeps only the latest comments", () => {
  const comments = Array.from({ length: COMMENTS + 3 }, (_, i) => ({ type: "comment", text: `c${i}`, created_at: "2026-11-02T00:00:00Z", created_by: { name: "R" } }));
  const text = contextBlock({ name: "T", notes: "x".repeat(NOTES_CAP + 50) }, comments, true);
  assert.match(text, /cut at 6,000 characters/);
  assert.match(text, /3 older not shown/);
  assert.match(text, /more history than was read/);
  assert.doesNotMatch(text, /: c0\n/);
  assert.match(text, /: c12/);
  assert.match(contextBlock({ name: "T", notes: "" }, [], false), /Description:\n\(none\)/);
});

test("finish comment and project ids", () => {
  assert.equal(finishComment("Fix", "ab12cd", "task/ab12cd", "All done.\nTests pass."), 'Entomatical finished "Fix" (card ab12cd): task/ab12cd was merged.\n\nLast reply:\nAll done.\nTests pass.');
  assert.equal(finishComment("Fix", "ab12cd", undefined, ""), 'Entomatical finished "Fix" (card ab12cd).');
  assert.equal(projectGid(" 1201234567890 "), "1201234567890");
  assert.equal(projectGid("https://app.asana.com/0/1201234567890/list"), "1201234567890");
  assert.equal(projectGid("https://app.asana.com/1/111/project/1201234567890/list/222"), "1201234567890");
  assert.equal(projectGid("not a project"), undefined);
});

function loadAsanaBoard(vscode, StubAsana) {
  const fs = require("node:fs"), Module = require("node:module");
  const filename = require.resolve("../out/asana-board.js");
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.require = (name) => (name === "vscode" ? vscode : name === "./asana" ? { Asana: StubAsana, projectGid, finishComment } : require(name)); // never the real Asana API
  mod._compile(fs.readFileSync(filename, "utf8"), filename);
  return mod.exports;
}

function projectTasks(gid) {
  return { tasks: [{ gid: "shared", name: `Shared in ${gid}` }, { gid: `task-${gid}`, name: `Task in ${gid}` }] };
}

function boardFixture({ openTasks = projectTasks, showQuickPick, create, context } = {}) {
  let project = "1";
  const calls = [];
  class StubAsana {
    constructor() { calls.push(["client"]); }
    async context(gid) { calls.push(["context", gid]); return context(gid); }
    async projectName(gid) { calls.push(["projectName", gid]); return `Project ${gid}`; }
    async openTasks(gid) { calls.push(["openTasks", gid]); return openTasks(gid); }
    async create(...args) { calls.push(["create", ...args]); return create?.(...args) ?? { gid: "created", name: args[1] }; }
  }
  const disposable = { dispose() {} };
  const vscode = { workspace: { getConfiguration: () => ({ get: () => project }), onDidChangeConfiguration: () => disposable },
    commands: { registerCommand: () => disposable }, window: { showQuickPick } };
  const api = loadAsanaBoard(vscode, StubAsana);
  const task = { id: "t1", title: "Card", prompt: "p" };
  const board = { mustOwn() {}, get: id => id === task.id ? task : undefined, startContext: new Map(), update: (t, patch) => Object.assign(t, patch) };
  return { api, board, task, calls, select: (gid) => { project = gid; } };
}

for (const failure of ["no project", "refresh failed"]) {
  test(`local Asana unlink works with ${failure} and prevents later context and comment calls`, async (t) => {
    const { api, board, task, calls, select } = boardFixture({
      openTasks: async () => { throw new Error("offline"); },
      showQuickPick: async items => items.find(item => item.action === "unlink"),
    });
    task.asana = { gid: "linked", name: "Original" };
    select("");
    const subscriptions = [];
    api.registerAsana({ subscriptions, secrets: { get: async () => "fixture-token" } }, board, () => {});
    t.after(() => subscriptions.forEach(item => item.dispose()));
    if (failure === "refresh failed") {
      select("1");
      assert.match((await api.refreshAsana()).error, /offline/);
    }
    const previousCalls = calls.slice();
    const { asana, ...otherFields } = task;
    await api.pickAsanaLink(board, task);
    assert.deepEqual(task, { ...otherFields, asana: undefined });
    await board.beforeStart(task);
    await api.commentOnFinish(task, "main", "finished");
    assert.deepEqual(calls, previousCalls);
  });
}

test("Unlink preserves a new link or a link now owned by a different window", async () => {
  for (const change of ["owner", "link"]) {
    let owned = true;
    const { api, board, task, calls } = boardFixture({ showQuickPick: async items => {
      if (change === "owner") owned = false;
      else task.asana = { gid: "new", name: "Replacement" };
      return items.find(item => item.action === "unlink");
    } });
    board.mustOwn = () => { if (!owned) throw new Error("owner changed"); };
    task.asana = { gid: "old", name: "Original" };
    await assert.rejects(api.pickAsanaLink(board, task), change === "owner" ? /owner changed/ : /link changed/);
    assert.equal(task.asana.gid, change === "owner" ? "old" : "new");
    assert.deepEqual(calls, []);
  }
});

for (const inFlight of ["context", "create"]) {
  test(`a pending Asana ${inFlight} cannot restore an unlinked card`, async (t) => {
    const started = Promise.withResolvers(), result = Promise.withResolvers();
    const pause = () => { started.resolve(); return result.promise; };
    let action = "change";
    const { api, board, task, calls, select } = boardFixture({ context: pause, create: pause,
      showQuickPick: async items => items.find(item => item.action === action || item.gid === "new"),
    });
    select("");
    const subscriptions = [];
    api.registerAsana({ subscriptions, secrets: { get: async () => "fixture-token" } }, board, () => {});
    t.after(() => subscriptions.forEach(item => item.dispose()));
    select("1");
    task.asana = { gid: "old", name: "Original" };
    const pending = inFlight === "context" ? board.beforeStart(task) : api.pickAsanaLink(board, task);
    await started.promise;
    action = "unlink";
    await api.pickAsanaLink(board, task);
    const atUnlink = calls.slice();
    if (inFlight === "context") {
      result.resolve("old project context");
      await pending;
    } else {
      result.resolve({ gid: "new-remote-id", name: "Created" });
      await assert.rejects(pending, /Asana created .*new-remote-id.*selection expired/);
    }
    assert.equal(task.asana, undefined);
    assert.equal(board.startContext.has(task.id), false);
    await api.commentOnFinish(task, "main", "finished");
    assert.deepEqual(calls, atUnlink);
  });
}

// F45: More → Asana task → "New" in a window that does not own the board created a real Asana task, then refused to record it.
test("More → Asana task in a window that does not own the board refuses before reading or creating anything in Asana", async () => {
  const { api, task, calls } = boardFixture({ showQuickPick: async (items) => items.find((i) => i.gid === "new") });
  const notOwner = () => { throw new Error("Another VS Code window runs this repo's board. Make changes there, or close that window."); };
  const board = { mustOwn: notOwner, update: notOwner };
  await assert.rejects(api.pickAsanaLink(board, task), /Another VS Code window runs this repo's board/);
  assert.deepEqual(calls, []);
});

for (const outcome of ["success", "error"]) {
  test(`BUG-05: delayed project A ${outcome} leaves B displayed and linkable`, async () => {
    const started = Promise.withResolvers(), pending = Promise.withResolvers();
    const { api, board, task, calls, select } = boardFixture({ openTasks(gid) {
      if (gid === "2") return projectTasks(gid);
      started.resolve();
      return pending.promise;
    } });
    const a = api.refreshAsana();
    await started.promise;
    select("2");
    await api.refreshAsana();
    const shown = api.asanaSnapshot();
    assert.equal(shown.projectName, "Project 2");

    if (outcome === "success") pending.resolve(projectTasks("1"));
    else pending.reject(new Error("Project 1 failed"));
    await a;
    assert.equal(api.asanaSnapshot(), shown);
    assert.equal(shown.error, undefined);
    assert.deepEqual(shown.tasks, projectTasks("2").tasks);

    const readCalls = calls.slice();
    await assert.rejects(api.linkAsana(board, task, { ...shown, choice: "task-1" }), /no longer open/);
    await api.linkAsana(board, task, { ...shown, choice: "task-2" });
    assert.deepEqual(task.asana, { gid: "task-2", name: "Task in 2", url: undefined });
    assert.deepEqual(calls, readCalls);
  });
}

test("BUG-05: clearing the project drops its snapshot and pending refresh, including when the same project is reselected", async () => {
  const started = Promise.withResolvers(), pending = Promise.withResolvers();
  let delay = false;
  const { api, board, task, calls, select } = boardFixture({ openTasks(gid) {
    if (!delay) return projectTasks(gid);
    started.resolve();
    return pending.promise;
  } });
  await api.refreshAsana();
  const shown = api.asanaSnapshot();
  delay = true;
  const refresh = api.refreshAsana();
  await started.promise;
  select("");
  await api.refreshAsana();
  assert.equal(api.asanaSnapshot(), undefined);
  pending.resolve(projectTasks("1"));
  await refresh;
  assert.equal(api.asanaSnapshot(), undefined);

  select("1");
  delay = false;
  await api.refreshAsana();
  const readCalls = calls.slice();
  await assert.rejects(api.linkAsana(board, task, { ...shown, choice: "shared" }), /selection expired/);
  assert.equal(task.asana, undefined);
  assert.deepEqual(calls, readCalls);
});

for (const [choice, nextProject] of [["shared", "2"], ["new", "2"], ["new", "1"]]) {
  test(`BUG-05: stale picker choice ${choice} after refreshing project ${nextProject} has no Asana or board effects`, async () => {
    const opened = Promise.withResolvers(), picked = Promise.withResolvers();
    const { api, board, task, calls, select } = boardFixture({ showQuickPick(items) {
      opened.resolve(items.find((item) => item.gid === choice));
      return picked.promise;
    } });
    const pick = api.pickAsanaLink(board, task);
    const item = await opened.promise;
    assert.ok(item);
    select(nextProject);
    await api.refreshAsana();
    const readCalls = calls.slice();
    picked.resolve(item);
    await assert.rejects(pick, /selection expired/);
    assert.equal(task.asana, undefined);
    assert.deepEqual(calls, readCalls);
  });
}

test("BUG-05: a current picker links an existing B task and can create a new task in B", async () => {
  let choice = "task-2";
  const { api, board, task, calls, select } = boardFixture({ showQuickPick: async (items) => items.find((item) => item.action === "change" || item.gid === choice) });
  select("2");
  await api.pickAsanaLink(board, task);
  assert.equal(task.asana.gid, "task-2");
  choice = "new";
  await api.pickAsanaLink(board, task);
  assert.deepEqual(task.asana, { gid: "created", name: "Card" });
  assert.deepEqual(calls.filter(([method]) => method === "create"), [["create", "2", "Card", "p"]]);
});

test("BUG-05: a create already sent to A cannot attach after B becomes current", async () => {
  const started = Promise.withResolvers(), pending = Promise.withResolvers();
  const { api, board, task, calls, select } = boardFixture({ create() {
    started.resolve();
    return pending.promise;
  } });
  await api.refreshAsana();
  const link = api.linkAsana(board, task, { ...api.asanaSnapshot(), choice: "new" });
  await started.promise;
  select("2");
  await api.refreshAsana();
  pending.resolve({ gid: "created", name: "Card" });
  await assert.rejects(link, /selection expired during creation/);
  assert.equal(task.asana, undefined);
  assert.deepEqual(calls.filter(([method]) => method === "create"), [["create", "1", "Card", "p"]]);
});

test("BUG-05: the board submits the displayed Asana generation and clears the choice on refresh", { timeout: 60_000 }, async (t) => {
  const cdp = require("./compile-webview-cdp");
  if (!cdp.edgePath()) return t.skip("No headless Edge, Chrome or Chromium is available.");
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const url = require("node:url").pathToFileURL(path.join(__dirname, "compile-webview-harness.html")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-asana-webview-"));
  let edge, page;
  try {
    edge = await cdp.launchEdge(url, scratch);
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the Asana webview harness");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "the board to load");
    const show = (project, generation) => page.evaluate(`window.__host(${JSON.stringify({ tasks: [], live: [], own: [], accounts: ["acct"],
      contextSource: "asana", asana: { project, generation, ...projectTasks(project) } })}); true`);
    const choose = (gid) => page.evaluate(`asanaBox.value = ${JSON.stringify(gid)}; asanaBox.dispatchEvent(new Event("change")); true`);
    const add = () => page.evaluate(`promptBox.value = "Card prompt"; addTask(); window.__posted.at(-1)`);

    await show("1", 1);
    await choose("new");
    await show("1", 1);
    const a = await add();
    assert.deepEqual([a.type, a.asana, a.asanaProject, a.asanaGeneration], ["create", "new", "1", 1]);
    await choose("new");
    await show("2", 2);
    assert.equal(await page.evaluate("asanaBox.value"), "");
    await choose("task-2");
    const b = await add();
    assert.deepEqual([b.type, b.asana, b.asanaProject, b.asanaGeneration], ["create", "task-2", "2", 2]);
  } finally {
    page?.close();
    if (edge) await edge.kill();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
