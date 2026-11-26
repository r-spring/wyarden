// A stand-in for src/helper-tab.ts in tests that load out/extension.js with fake modules: it records what the handlers tell the tab.
// The real module is tested in test/helper-tab.test.js.
const Module = require("node:module");
// helper-tab.js imports "vscode" (used only inside HelperTabs); load it with a bare stand-in for its pure formatters, then restore the loader.
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? {} : load.call(this, request, ...rest); };
const real = require("../out/helper-tab");
Module._load = load;
function helperTabStub() {
  const tabs = [];
  class HelperTabs {
    start(key, run, boardKey) {
      const tab = { key, run, boardKey, events: [] }; tabs.push(tab);
      const output = (source = "") => (text, stream) => tab.events.push(["output", source, stream ?? "log", text]);
      return { output, line: output(), prompt: (t) => tab.events.push(["prompt", t]), stage: (t) => tab.events.push(["stage", t]),
        finish: (view, model) => tab.events.push(["finish", view, model]), fail: (e, cancelled) => tab.events.push(["fail", e, cancelled]) };
    }
    show(requestId) { tabs.push({ shown: requestId }); }
    releaseBoard(boardKey) { tabs.push({ released: boardKey }); }
  }
  return { tabs, module: { HelperTabs, helperTitle: real.helperTitle, refineView: real.refineView, improveView: real.improveView, reviewView: real.reviewView, usageNote: real.usageNote } };
}
module.exports = { helperTabStub };
