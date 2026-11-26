// The Obsidian integration uses only disposable folders; no personal vault or running VS Code is touched.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { listNotes, noteContext, createNote, appendResult } = require("../out/obsidian.js");

async function temp(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "entomatical-obsidian-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("lists Markdown notes under a folder, ignores hidden entries and bounds the list", async (t) => {
  const dir = await temp(t);
  await fs.promises.mkdir(path.join(dir, "nested"));
  await fs.promises.mkdir(path.join(dir, ".obsidian"));
  await fs.promises.writeFile(path.join(dir, "nested", "one.md"), "one");
  await fs.promises.writeFile(path.join(dir, ".obsidian", "hidden.md"), "hidden");
  await fs.promises.writeFile(path.join(dir, "other.txt"), "not a note");
  assert.deepEqual(await listNotes(dir), { notes: [path.join("nested", "one.md")], truncated: false });
  await Promise.all(Array.from({ length: 500 }, (_, i) => fs.promises.writeFile(path.join(dir, `note-${i}.md`), "")));
  const many = await listNotes(dir);
  assert.equal(many.notes.length, 500);
  assert.equal(many.truncated, true);
});

test("creates unique safe filenames and adds a bounded context and result without overwriting", async (t) => {
  const dir = await temp(t);
  const original = path.join(dir, "_CON.md");
  await fs.promises.writeFile(original, "existing");
  const link = await createNote(dir, "CON", "Prompt in the note");
  assert.equal(link.note, "_CON (2).md");
  assert.equal(await fs.promises.readFile(original, "utf8"), "existing");
  const unicode = await createNote(dir, "漢".repeat(100), "Unicode title");
  assert.ok(Buffer.byteLength(unicode.note, "utf8") < 255);
  assert.ok(fs.existsSync(path.join(dir, unicode.note)));
  assert.match(await noteContext(link), /# CON\n\nPrompt in the note/);
  await fs.promises.appendFile(path.join(dir, link.note), "x".repeat(7000));
  const context = await noteContext(link);
  assert.match(context, /cut at 6,000 characters/);
  const before = await fs.promises.readFile(path.join(dir, link.note), "utf8");
  await appendResult(link, "Card", "42", "task/42", "Finished safely.");
  const after = await fs.promises.readFile(path.join(dir, link.note), "utf8");
  assert.ok(after.startsWith(before));
  assert.match(after, /Entomatical result/);
  assert.match(after, /Finished safely\./);
  await fs.promises.unlink(path.join(dir, link.note));
  await assert.rejects(appendResult(link, "Card", "42", undefined, "No recreation"), /ENOENT/);
  assert.equal(fs.existsSync(path.join(dir, link.note)), false);
});

test("rejects paths outside the selected folder and notes redirected through a symlink", async (t) => {
  const root = await temp(t), outside = await temp(t);
  await fs.promises.writeFile(path.join(outside, "outside.md"), "private");
  await fs.promises.writeFile(path.join(root, "other.md"), "untouched");
  await assert.rejects(noteContext({ folder: root, note: path.join("..", path.basename(outside), "outside.md") }), /outside/);
  await assert.rejects(noteContext({ folder: root, note: path.join(outside, "outside.md") }), /Invalid/);
  try { await fs.promises.symlink(path.join(root, "other.md"), path.join(root, "redirect.md")); }
  catch (e) { if (["EPERM", "EACCES", "ENOTSUP"].includes(e.code)) return t.skip("Symlinks are unavailable on this host"); throw e; }
  assert.deepEqual((await listNotes(root)).notes, ["other.md"]);
  await assert.rejects(appendResult({ folder: root, note: "redirect.md" }, "Card", "1"), /symbolic link/);
  assert.equal(await fs.promises.readFile(path.join(root, "other.md"), "utf8"), "untouched");
});

function boardFixture(folder, readNote) {
  const settings = { "obsidian.folder": folder, contextSource: "obsidian" }, commands = {}, warnings = [];
  let pick = async () => undefined, own = true;
  const vscode = {
    ConfigurationTarget: { Workspace: 2 },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback, update: async (key, value) => { settings[key] = value; } }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    commands: { registerCommand: (name, fn) => { commands[name] = fn; return { dispose() {} }; }, executeCommand: async (name) => { commands.executed = name; } },
    window: {
      showQuickPick: (items) => pick(items),
      showOpenDialog: async () => [{ fsPath: folder }],
      showWarningMessage: async (message) => warnings.push(message),
      showErrorMessage: async (message) => warnings.push(message),
      showInformationMessage: async () => undefined,
    },
  };
  const filename = require.resolve("../out/obsidian-board.js"), mod = new Module(filename, module);
  mod.filename = filename;
  mod.require = (name) => name === "vscode" ? vscode : name === "./obsidian" ? { ...require("../out/obsidian.js"), ...(readNote && { noteContext: readNote }) } : require(name);
  mod._compile(fs.readFileSync(filename, "utf8"), filename);
  const board = {
    startContext: new Map(), noteStartContext: new Map(),
    beforeStart: async (task) => board.startContext.set(task.id, "Asana context"),
    mustOwn() { if (!own) throw new Error("not the board owner"); },
    update(task, patch) { this.mustOwn(); Object.assign(task, patch); },
  };
  const context = { subscriptions: [] };
  mod.exports.registerObsidian(context, board, () => undefined);
  return { api: mod.exports, board, vscode, settings, commands, warnings, pick: (fn) => { pick = fn; }, owner: (value) => { own = value; },
    dispose: () => context.subscriptions.forEach((d) => d.dispose()) };
}

test("unlinking Asana during or after a note read preserves only the Obsidian context", async (t) => {
  const dir = await temp(t), started = Promise.withResolvers(), note = Promise.withResolvers();
  const f = boardFixture(dir, () => { started.resolve(); return note.promise; });
  t.after(f.dispose);
  const task = { id: "7", obsidian: { folder: dir, note: "linked.md" } };
  const pending = f.board.beforeStart(task);
  await started.promise;
  f.board.startContext.delete(task.id);
  note.resolve("Note content");
  await pending;
  assert.equal(f.board.startContext.has(task.id), false);
  assert.equal(f.board.noteStartContext.get(task.id), "Note content");
  await f.board.beforeStart(task);
  f.board.startContext.delete(task.id);
  assert.equal(f.board.noteStartContext.get(task.id), "Note content");
});

test("linking a note composes with existing context and Finish uses the original folder after a source change", async (t) => {
  const dir = await temp(t), other = await temp(t), f = boardFixture(dir);
  t.after(f.dispose);
  await f.api.refreshObsidian();
  const task = { id: "7", title: "Card", prompt: "Do the work" };
  await f.api.linkObsidian(f.board, task, "new");
  await f.board.beforeStart(task);
  assert.equal(f.board.startContext.get("7"), "Asana context");
  assert.match(f.board.noteStartContext.get("7"), /Obsidian context[\s\S]*Do the work/);
  f.settings["obsidian.folder"] = other;
  f.settings.contextSource = "asana";
  await f.api.appendOnFinish(task, "task/7", "Result from the session");
  assert.match(await fs.promises.readFile(path.join(dir, task.obsidian.note), "utf8"), /Result from the session/);
  assert.deepEqual(await fs.promises.readdir(other), []);
  await fs.promises.unlink(path.join(dir, task.obsidian.note));
  await f.board.beforeStart(task);
  await f.api.appendOnFinish(task, undefined, "Missing");
  assert.equal(f.board.startContext.get("7"), "Asana context");
  assert.equal(f.board.noteStartContext.has("7"), false);
  assert.equal(f.warnings.length, 2);
  assert.deepEqual(await fs.promises.readdir(dir), []);
});

test("a note made from the card is shown as linked, also when the folder setting differs only in case on Windows (F85)", async (t) => {
  const dir = await temp(t), f = boardFixture(dir);
  t.after(f.dispose);
  // The folder dialog can give `c:\…` while realpath gives `C:\…`; the link must keep the setting's spelling and still match.
  if (process.platform === "win32") f.settings["obsidian.folder"] = dir.replace(/^[a-z]:/i, (d) => d === d.toUpperCase() ? d.toLowerCase() : d.toUpperCase());
  await f.api.refreshObsidian();
  const task = { id: "9", title: "Card", prompt: "Prompt" };
  await f.api.linkObsidian(f.board, task, "new");
  assert.equal(task.obsidian.folder, f.settings["obsidian.folder"]);
  let shown;
  f.pick(async (items) => { shown = items; return undefined; });
  await f.api.pickObsidianLink(f.board, task);
  assert.equal(shown.find((item) => item.note === task.obsidian.note)?.description, "linked");
  if (process.platform === "win32") { // a link stored before this fix holds the realpath spelling
    task.obsidian = { folder: await fs.promises.realpath(dir), note: task.obsidian.note };
    await f.api.pickObsidianLink(f.board, task);
    assert.equal(shown.find((item) => item.note === task.obsidian.note)?.description, "linked");
  }
});

test("a non-owner cannot create a note, including after ownership changes while the picker is open", async (t) => {
  const dir = await temp(t), f = boardFixture(dir);
  t.after(f.dispose);
  await f.api.refreshObsidian();
  const task = { id: "8", title: "Card", prompt: "Prompt" };
  f.owner(false);
  await assert.rejects(f.api.linkObsidian(f.board, task, "new"), /not the board owner/);
  f.owner(true);
  f.pick(async (items) => { f.owner(false); return items.find((item) => item.note === "new"); });
  await assert.rejects(f.api.pickObsidianLink(f.board, task), /not the board owner/);
  assert.deepEqual(await fs.promises.readdir(dir), []);
  assert.equal(task.obsidian, undefined);
});

test("the source picker selects a folder and can hide new links without deleting existing ones", async (t) => {
  const dir = await temp(t), f = boardFixture(dir);
  t.after(f.dispose);
  f.settings.contextSource = "asana";
  f.pick(async (items) => items.find((item) => item.source === "obsidian"));
  await f.commands["entomatical.contextSource"]();
  assert.equal(f.settings.contextSource, "obsidian");
  assert.equal(f.settings["obsidian.folder"], dir);
  f.pick(async (items) => items.find((item) => item.source === "none"));
  await f.commands["entomatical.contextSource"]();
  assert.equal(f.settings.contextSource, "none");
  assert.equal(f.settings["obsidian.folder"], dir);
  f.pick(async (items) => items.find((item) => item.source === "asana"));
  await f.commands["entomatical.contextSource"]();
  assert.equal(f.commands.executed, "entomatical.asanaProject");
});

test("the real Finish and Merge handlers disclose and append only after confirmation", async (t) => {
  const dir = await temp(t), f = boardFixture(dir), dialogs = [], actions = [];
  t.after(f.dispose);
  const link = await createNote(dir, "Destination", "Original text"), file = path.join(dir, link.note);
  const task = { id: "9", title: "Card", branch: "task/9", obsidian: link, status: "review" };
  let answer;
  f.vscode.ProgressLocation = { Notification: 15 };
  f.vscode.window.showWarningMessage = async (message, options) => { dialogs.push({ message, detail: options.detail }); return answer; };
  f.vscode.window.withProgress = async (_options, fn) => fn({ report() {} });
  f.board.repo = "/throwaway";
  f.board.get = (id) => id === task.id ? task : undefined;
  f.board.parentCommits = async () => 0;
  f.board.finalReply = () => "Completed work";
  f.board.finish = async (_task, how) => { actions.push(how); };
  f.board.complete = async (_task, confirm) => {
    if (!(await confirm({ dirty: [], target: "main", overlap: [], commits: [] }, [], { open: false, asking: false, landed: false, restore: false, noBranch: false, waiting: [] }))) return undefined;
    actions.push("finish"); return [];
  };
  const filename = require.resolve("../out/extension.js"), mod = new Module(filename, module);
  mod.filename = filename;
  mod.require = (name) => {
    if (name === "vscode") return f.vscode;
    if (name === "./obsidian-board") return f.api;
    if (name === "./asana-board") return { commentOnFinish: async () => undefined };
    if (name === "./git") return { git: async () => "main" };
    if (name === "./finish") return { statusPath: (s) => s };
    if (name === "./profiles") return require("../out/profiles.js"); // pure: capability profiles (phase 2)
    if (name.startsWith("./")) return {};
    return require(name);
  };
  mod._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.handleForTest = handle;\n", filename);
  const run = (type) => mod.exports.handleForTest(f.board, { type, id: task.id });
  const original = await fs.promises.readFile(file, "utf8");
  await run("finish");
  assert.match(dialogs.at(-1).detail, /Append up to 3,000 characters of the session's last reply to the Obsidian note "Destination.md"/);
  assert.equal(await fs.promises.readFile(file, "utf8"), original);
  answer = "Finish";
  await run("finish");
  let content = await fs.promises.readFile(file, "utf8");
  assert.equal((content.match(/Entomatical result/g) || []).length, 1);
  assert.match(content, /Completed work/);
  answer = undefined;
  await run("merge");
  assert.match(dialogs.at(-1).message, /last reply \(up to 3,000 characters\) will be appended/);
  assert.equal(await fs.promises.readFile(file, "utf8"), content);
  answer = "Merge";
  await run("merge");
  content = await fs.promises.readFile(file, "utf8");
  assert.equal((content.match(/Entomatical result/g) || []).length, 2);
  assert.deepEqual(actions, ["finish", "merge"]);
});
