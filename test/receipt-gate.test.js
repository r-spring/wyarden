const test = require("node:test");
const assert = require("node:assert/strict");
const { gate, FORMATS } = require("../hook/receipt-gate.js");
const stop = (agent_type, last_assistant_message, extra = {}) => ({ hook_event_name: "SubagentStop", agent_type, last_assistant_message, stop_hook_active: false, ...extra });
test("formats cover the six types", () => {
  assert.deepEqual(Object.keys(FORMATS).sort(), ["ab-fixer", "ab-host-investigator", "ab-mapper", "ab-parity-checker", "ab-reviewer", "ab-test-gate"]);
  assert.deepEqual(FORMATS["ab-test-gate"], { prefix: "RESULT: ", lines: 15 });
  assert.deepEqual(FORMATS["ab-reviewer"], { prefix: "VERDICT: ", lines: 60 });
});
test("a well-formed reply passes", () => {
  assert.equal(gate(stop("ab-test-gate", "RESULT: pass\n# pass 412\n# fail 0")), undefined);
  assert.equal(gate(stop("ab-reviewer", "\n\nVERDICT: pass: no findings.\n")), undefined);
});
test("a reply without the prefix is sent back", () => {
  const out = gate(stop("ab-mapper", "Here is what I found:\nsrc/board.ts:12 — Task"));
  assert.equal(out.decision, "block");
  assert.equal(out.reason, 'Reply format for ab-mapper: first line starts with "RESULT: ", at most 40 lines. Send the reply again in that form and nothing else.');
});
test("a reply over the cap is sent back", () => {
  const long = "RESULT: pass\n" + Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(gate(stop("ab-test-gate", long)).decision, "block");
  assert.equal(gate(stop("ab-mapper", long)), undefined);
});
test("no block when already continuing", () => {
  assert.equal(gate(stop("ab-mapper", "no prefix here", { stop_hook_active: true })), undefined);
});
test("no block without a message", () => {
  assert.equal(gate(stop("ab-mapper", undefined)), undefined);
  assert.equal(gate(stop("ab-mapper", "")), undefined);
});
test("other agents are not gated", () => {
  assert.equal(gate(stop("general-purpose", "anything")), undefined);
  assert.equal(gate(stop(undefined, "anything")), undefined);
});
