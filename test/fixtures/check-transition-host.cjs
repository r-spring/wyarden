// A separate extension host lets the test exit immediately after the real tasks.json rename.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const load = Module._load;
Module._load = function (name, ...rest) {
  if (name !== "vscode") return load.call(this, name, ...rest);
  return { EventEmitter: class extends EventEmitter {
    event = listener => { this.on("event", listener); return { dispose: () => this.off("event", listener) }; };
    fire(value) { this.emit("event", value); }
    dispose() { this.removeAllListeners(); }
  },
    window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }) } };
};
const { Board } = require("../../out/board.js");
const [repo, id, fault] = process.argv.slice(2);
const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
if (!board.isOwner(true)) throw new Error("fixture could not acquire the released board");
const task = board.get(id);
const receipt = path.join(task.checks.run, "receipt.json");
const rename = fs.renameSync, read = fs.readFileSync;
let committed = false, injected = 0;
fs.renameSync = (from, to) => {
  rename(from, to);
  if (to !== board.file) return;
  committed = true;
  if (fault === "host exit") process.exit(81);
};
fs.readFileSync = (file, ...args) => {
  if (committed && file === receipt && !injected) {
    injected++;
    throw Object.assign(new Error("fixture: transient check receipt read"), { code: "EIO" });
  }
  return read(file, ...args);
};
board.update(task, { status: "running" });
console.log(JSON.stringify({ committed, injected }));
board.dispose();
