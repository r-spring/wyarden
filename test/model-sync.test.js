// Sync models (22 November 2026): a Claude sync takes the newest listed id of each family; dated API ids drop their date.
const test = require("node:test");
const assert = require("node:assert/strict");
const m = require("../out/models.js");

test("setClaudeModelIds keeps the newest listed id per family and leaves unlisted families alone", () => {
  const before = { ...m.CLAUDE_MODEL_IDS };
  try {
    const ids = m.setClaudeModelIds(["claude-opus-5-5", "claude-opus-5-6", "claude-sonnet-5-6-20261101", "gpt-4"]);
    assert.equal(ids.opus, "claude-opus-5-6");
    assert.equal(ids.sonnet, "claude-sonnet-5-6");
    assert.equal(ids.haiku, before.haiku);
    assert.equal(m.claudeModelId("opus"), "claude-opus-5-6");
  } finally { Object.assign(m.CLAUDE_MODEL_IDS, before); }
});
