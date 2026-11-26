// Fix 11 (F92): a short model name always means the newest version of that model, on every provider. Fixtures: the lists each CLI
// gave on 6 November 2026 (the authored provider-error regression section E).
const test = require("node:test");
const assert = require("node:assert/strict");
const m = require("../out/models.js");
const { parseAgyModels } = require("../out/acp.js");

const CODEX = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const GROK = ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"];
const AGY_TEXT = `Fetching available models...
gemini-4-argon-medium\tGemini 4 Argon (Medium)
gemini-4-argon-high\tGemini 4 Argon (High)
gemini-4-argon-low\tGemini 4 Argon (Low)
gemini-4-carbon-low\tGemini 4 Carbon (Low)
gemini-4-carbon-medium\tGemini 4 Carbon (Medium)
gemini-4-carbon-high\tGemini 4 Carbon (High)
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
claude-opus-5-5-low\tClaude Opus 5.5 (Low)
claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)
claude-opus-5-5-high\tClaude Opus 5.5 (High)
claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)
claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)
claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`;

test("Codex short names and older ids run the newest version of their family", () => {
  assert.equal(m.resolveModel("codex", "sol", CODEX), "gpt-6.1-sol");
  assert.equal(m.resolveModel("codex", "gpt-5.6-sol", CODEX), "gpt-5.6-sol", "an exact listed id runs as picked (F123)");
  assert.equal(m.resolveModel("codex", "gpt-5.5-sol", CODEX), "gpt-6.1-sol", "an id the provider no longer lists runs the newest");
  assert.equal(m.modelLabel("codex", "gpt-6.1-sol"), "Sol 6.1");
  assert.equal(m.modelLabel("claude", "claude-fable-5-2"), "Fable 5.2");
  assert.equal(m.modelLabel("codex", "gpt-reserve"), "gpt-reserve");
  assert.equal(m.resolveModel("codex", "gpt-6.1-sol", CODEX), "gpt-6.1-sol");
  assert.equal(m.resolveModel("codex", "terra", CODEX), "gpt-6.1-terra");
  assert.equal(m.resolveModel("codex", "luna", CODEX), "gpt-6-luna");
  assert.equal(m.resolveModel("codex", "astra", CODEX), "gpt-6-astra");
  assert.deepEqual(m.shortNames("codex", CODEX), [{ name: "sol", id: "gpt-6.1-sol" }, { name: "astra", id: "gpt-6-astra" }, { name: "terra", id: "gpt-6.1-terra" }, { name: "luna", id: "gpt-6-luna" }]);
  assert.equal(m.modelName("codex", "gpt-5.6-sol"), "sol", "a card stores the short name");
  assert.equal(m.modelName("codex", "sol"), "sol");
});

test("a new release is followed with no code change", () => {
  assert.equal(m.resolveModel("codex", "sol", [...CODEX, "gpt-6.2-sol"]), "gpt-6.2-sol");
  assert.equal(m.resolveModel("codex", "gpt-6.1-sol", [...CODEX, "gpt-6.2-sol"]), "gpt-6.1-sol", "a listed exact id stays (F123)");
  assert.equal(m.resolveModel("codex", "sol", [...CODEX, "gpt-6.10-sol"]), "gpt-6.10-sol", "versions compare as numbers, not text");
  assert.equal(m.resolveModel("grok", "grok", [...GROK, "grok-5"]), "grok-5");
  assert.equal(m.resolveModel("antigravity", "opus", ["claude-opus-5-5", "claude-opus-6-0"]), "claude-opus-6-0");
});

test("Codex's hidden models never match, and an unknown name lists the short names", () => {
  assert.equal(m.parseModel("codex", "gpt-reserve"), undefined);
  assert.equal(m.parseModel("codex", "codex-auto-review"), undefined);
  assert.throws(() => m.resolveModel("codex", "zeta", CODEX), /^Error: Unknown model zeta\. Valid: sol, astra, terra, luna, or a full id of one of them\.$/);
  assert.throws(() => m.resolveModel("codex", "sol", []), /Unknown model sol\. Valid: none listed yet\./);
});

test("Grok: grok and build", () => {
  assert.equal(m.resolveModel("grok", "grok", GROK), "grok-4.7");
  assert.equal(m.resolveModel("grok", "build", GROK), "grok-4.7-build-fast");
  assert.equal(m.resolveModel("grok", "grok-4.5", GROK), "grok-4.5", "a listed exact id stays (F123)");
  assert.equal(m.resolveModel("grok", "grok-4.1", GROK), "grok-4.7", "an unlisted one runs the newest");
  assert.equal(m.resolveModel("grok", "Auto", ["Auto"]), "Auto", "an advertised value of no known shape passes as it is");
});

test("a newer *-preview or *-latest id is never picked over an exact one (17 November 2026 review)", () => {
  const offered = [...GROK, "grok-4.8-build-preview", "grok-4.9-latest"];
  assert.equal(m.resolveModel("grok", "build", offered), "grok-4.7-build-fast");
  assert.equal(m.newestOf("grok", "build", offered), "grok-4.7-build-fast");
  assert.ok(m.shortNames("grok", offered).every((n) => n.id && m.isExactModel("grok", n.id)), "every listed short name runs an exact id");
});

test("Antigravity: opus, argon, carbon, flash, sonnet and gpt-oss over agy's per-effort ids; an id with its effort keeps that effort", () => {
  const ids = parseAgyModels(AGY_TEXT).map(([id]) => id);
  assert.equal(ids.length, 16);
  // A short name: the newest version, at high where agy lists one id per effort (the terminal drops the effort and passes --effort).
  assert.equal(m.resolveModel("antigravity", "opus", ids), "claude-opus-5-5-high");
  assert.equal(m.resolveModel("antigravity", "argon", ids), "gemini-4-argon-high");
  // Carbon (the user, 14 November 2026): agy on Windows lists gemini-4-carbon-low, -medium and -high beside Argon.
  assert.deepEqual(m.parseModel("antigravity", "gemini-4-carbon-high"), { family: "carbon", version: [4] });
  assert.equal(m.resolveModel("antigravity", "carbon", ids), "gemini-4-carbon-high");
  assert.equal(m.resolveModel("antigravity", "carbon", [...ids, "gemini-4.1-carbon-high"]), "gemini-4.1-carbon-high", "the newest Carbon");
  assert.equal(m.modelName("antigravity", "gemini-4-carbon"), "carbon");
  assert.equal(m.resolveModel("antigravity", "flash", ids), "gemini-3.8-flash-high");
  assert.equal(m.resolveModel("antigravity", "sonnet", ids), "claude-sonnet-5-5-high");
  assert.equal(m.resolveModel("antigravity", "gpt-oss", ids), "gpt-oss-120b-medium");
  assert.equal(m.resolveModel("antigravity", "argon", ["gemini-4-argon", "gemini-4-argon-high"]), "gemini-4-argon", "the plain id wins");
  // One of agy's own ids carries its effort: the newest version with that same effort.
  assert.equal(m.resolveModel("antigravity", "gemini-3.8-flash-low", ids), "gemini-3.8-flash-low");
  assert.equal(m.resolveModel("antigravity", "gemini-3.8-flash-low", [...ids, "gemini-3.9-flash-low", "gemini-3.9-flash-high"]), "gemini-3.8-flash-low", "a listed exact id stays (F123)");
  assert.equal(m.resolveModel("antigravity", "gemini-3.7-flash-low", [...ids, "gemini-3.9-flash-low", "gemini-3.9-flash-high"]), "gemini-3.9-flash-low", "an unlisted one runs the newest with its effort");
  assert.equal(m.modelName("antigravity", "claude-opus-5-5"), "opus");
  assert.equal(m.modelName("antigravity", "gemini-3.8-flash-low"), "gemini-3.8-flash-low", "its effort is part of the choice");
});

test("Claude: a short name or any version of a family resolves to that family's full id (F92, 17 November 2026)", () => {
  assert.equal(m.resolveModel("claude", "fable", []), "claude-fable-5-2");
  assert.equal(m.resolveModel("claude", "claude-fable-5-1", []), "claude-fable-5-2", "as add() keeps any Claude id as its family");
  assert.equal(m.resolveModel("claude", "claude-fable-6-0", []), "claude-fable-5-2", "a made-up newer id is still fable");
  assert.equal(m.modelName("claude", "claude-opus-5-5"), "opus");
  assert.throws(() => m.resolveModel("claude", "gpt-6.1-sol", []), /Unknown model gpt-6\.1-sol\. Valid: opus, sonnet, haiku, fable, or a full id of one of them\./);
});

test("version order is numeric part by part", () => {
  assert.ok(m.compareVersions([6, 1], [6]) > 0);
  assert.ok(m.compareVersions([6], [5, 6]) > 0);
  assert.ok(m.compareVersions([6, 10], [6, 9]) > 0);
  assert.equal(m.compareVersions([5, 5], [5, 5]), 0);
  assert.equal(m.familyLabel("sol"), "Sol");
  assert.equal(m.familyLabel("gpt-oss"), "GPT-OSS");
});

test("exact ids only (the user, 17 November 2026): short names, aliases and no model are not exact, and exactModel refuses them", () => {
  for (const [provider, id] of [["claude", "claude-opus-5-5"], ["codex", "gpt-6.2-sol"], ["codex", "gpt-reserve"], ["grok", "grok-4.7"],
    ["grok", "grok-4.7-build-fast"], ["antigravity", "claude-opus-5-5"], ["antigravity", "gemini-4-argon-high"], ["antigravity", "gemini-pro-orchestrator"]])
    assert.equal(m.isExactModel(provider, id), true, `${provider} ${id}`);
  for (const [provider, id] of [["claude", "opus"], ["claude", "opus-5-5"], ["claude", "toString"], ["codex", "sol"], ["codex", "gpt"], ["grok", "grok"],
    ["grok", "build"], ["grok", "Auto"], ["antigravity", "opus"], ["antigravity", "argon"], ["antigravity", "gpt-oss"], ["codex", "default"], ["grok", ""], ["codex", undefined], ["grok", "grok-4-latest"], ["antigravity", "gemini-flash-latest"], ["antigravity", "gemini-3-pro-preview"]])
    assert.equal(m.isExactModel(provider, id), false, `${provider} ${id}`);
  assert.equal(m.exactModel("codex", "gpt-6.2-sol"), "gpt-6.2-sol");
  assert.throws(() => m.exactModel("codex", "sol"), /^Error: Codex would be handed "sol", not an exact model id, so nothing was started./);
  assert.throws(() => m.exactModel("grok", undefined), /^Error: Grok would be handed no model, not an exact model id/);
  assert.throws(() => m.exactModel("claude", "opus"), /^Error: Claude Code would be handed "opus"/);
  // Every Claude list name maps to an exact id.
  for (const id of Object.values(m.CLAUDE_MODEL_IDS)) assert.equal(m.isExactModel("claude", id), true);
});
