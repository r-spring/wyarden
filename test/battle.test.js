// Battle Royale's line-up (src/battle.ts, the user, 14 November 2026): one card per provider on its top model at its top effort.
const test = require("node:test");
const assert = require("node:assert/strict");
const { battleLineup, solEffort, battlePrompt, battlePreamble, battleFallbackTitle, contestantsFrom, DEFAULT_CONTESTANTS } = require("../out/battle.js");

const ACCOUNTS = [
  { name: "user@claude-one" }, { name: "user@claude-two" },
  { name: "Codex · user@codex", provider: "codex" },
  { name: "Grok · ~/.grok", provider: "grok" }, { name: "Grok · work", provider: "grok" },
  { name: "user@antigravity", provider: "antigravity" },
];
const CODEX = [{ model: "gpt-6-luna", efforts: ["low"] }, { model: "gpt-6-sol", efforts: ["low", "high"] }, { model: "gpt-6.1-sol", efforts: ["low", "medium", "high", "xhigh", "ultra"] }];

test("four providers in order: Claude on Fable at max, Codex on Sol at ultra, Grok on its default, Antigravity on Carbon at high", () => {
  const { lineup, skipped } = battleLineup(ACCOUNTS, "", CODEX);
  assert.deepEqual(lineup, [
    { provider: "claude", label: "Claude", account: "user@claude-one", model: "fable", effort: "max" },
    { provider: "codex", label: "Codex", account: "Codex · user@codex", model: "sol", effort: "ultra" },
    { provider: "grok", label: "Grok", account: "Grok · ~/.grok" },
    { provider: "antigravity", label: "Antigravity", account: "user@antigravity", model: "carbon", effort: "high" },
  ]);
  assert.deepEqual(skipped, []);
});

test("the form's account is used for its own provider; the others keep their first account", () => {
  const claude = battleLineup(ACCOUNTS, "user@claude-two", CODEX).lineup;
  assert.deepEqual(claude.map((e) => e.account), ["user@claude-two", "Codex · user@codex", "Grok · ~/.grok", "user@antigravity"]);
  const grok = battleLineup(ACCOUNTS, "Grok · work", CODEX).lineup;
  assert.deepEqual(grok.map((e) => e.account), ["user@claude-one", "Codex · user@codex", "Grok · work", "user@antigravity"]);
});

test("Sol without ultra runs at the highest effort its newest version lists", () => {
  const noUltra = [{ model: "gpt-6-sol", efforts: ["xhigh", "low", "high", "medium"] }];
  assert.equal(solEffort(noUltra), "xhigh");
  assert.equal(battleLineup(ACCOUNTS, "", noUltra).lineup[1].effort, "xhigh");
  assert.equal(solEffort(CODEX), "ultra"); // the newest Sol (6.1) lists ultra, the older one does not
  assert.equal(solEffort([{ model: "gpt-6-sol", efforts: ["ultra"] }, { model: "gpt-6.1-sol", efforts: ["high"] }]), "high");
  assert.equal(solEffort([{ model: "gpt-6-luna", efforts: ["low"] }]), undefined);
});

test("a provider with no account is skipped and named; Codex with no Sol model too", () => {
  const { lineup, skipped } = battleLineup(ACCOUNTS.filter((a) => a.provider !== "grok"), "", CODEX);
  assert.deepEqual(lineup.map((e) => e.provider), ["claude", "codex", "antigravity"]);
  assert.deepEqual(skipped, [{ provider: "grok", label: "Grok", reason: "no Grok account is signed in" }]);
  const noSol = battleLineup(ACCOUNTS, "", [{ model: "gpt-6-luna", efforts: ["low"] }]);
  assert.deepEqual(noSol.lineup.map((e) => e.provider), ["claude", "grok", "antigravity"]);
  assert.deepEqual(noSol.skipped.map((s) => s.reason), ["the Codex CLI lists no sol model"]);
});

test("fewer than two contestants is refused, naming what is missing", () => {
  assert.throws(() => battleLineup([{ name: "user@claude-one" }], "", CODEX),
    /at least two contestants, and only Claude can run\. Codex: no Codex account is signed in; Grok: no Grok account is signed in; Antigravity: no Antigravity account is signed in\./);
  assert.throws(() => battleLineup([], "", []), /none can run/);
  assert.equal(battleLineup([{ name: "a" }, { name: "Grok · g", provider: "grok" }], "", []).lineup.length, 2); // two is enough
});

test("every card's prompt is the battle line, a blank line, then the prepared prompt; the fallback title is the prompt's first line", () => {
  assert.equal(battlePrompt("Do it.", 3), `${battlePreamble(3)}\n\nDo it.`);
  assert.equal(battlePreamble(3), "Battle Royale: three other models have this same task. Nobody will answer a question or approve a plan. Decide for yourself and finish the task.");
  assert.match(battlePreamble(1), /^Battle Royale: one other model has this same task\./);
  assert.equal(battleFallbackTitle("\n  Fix the parser  \nmore"), "Fix the parser");
});

// The entomatical.battleRoyale.contestants setting (the user, 17 November 2026): how many fight, and on what.
test("contestantsFrom keeps known providers, trims, caps at 8, and falls back to the default line-up", () => {
  assert.deepEqual(contestantsFrom(undefined), DEFAULT_CONTESTANTS);
  assert.deepEqual(contestantsFrom([{ provider: "nope" }, "x", null]), DEFAULT_CONTESTANTS);
  assert.deepEqual(contestantsFrom([{ provider: "claude", model: " opus ", effort: 3 }, { provider: "grok", account: "Grok · work" }]),
    [{ provider: "claude", model: "opus", effort: "", account: "" }, { provider: "grok", model: "", effort: "", account: "Grok · work" }]);
  assert.equal(contestantsFrom(Array.from({ length: 12 }, () => ({ provider: "claude" }))).length, 8);
});

test("a configured line-up: its order, a provider twice numbered, its own account, model and effort; Codex on Sol at top effort when left empty; Grok's ignored", () => {
  const { lineup, skipped } = battleLineup(ACCOUNTS, "", CODEX, contestantsFrom([
    { provider: "claude", model: "opus", effort: "high", account: "user@claude-two" }, { provider: "claude" },
    { provider: "codex" }, { provider: "grok", model: "x", effort: "y" }, { provider: "antigravity", account: "someone else" }]));
  assert.deepEqual(lineup, [
    { provider: "claude", label: "Claude 1", account: "user@claude-two", model: "opus", effort: "high" },
    { provider: "claude", label: "Claude 2", account: "user@claude-one" },
    { provider: "codex", label: "Codex", account: "Codex · user@codex", model: "sol", effort: "ultra" },
    { provider: "grok", label: "Grok", account: "Grok · ~/.grok" },
  ]);
  assert.deepEqual(skipped, [{ provider: "antigravity", label: "Antigravity", reason: 'the Antigravity account "someone else" is not signed in' }]);
  // A Codex effort typed is used as typed.
  assert.equal(battleLineup(ACCOUNTS, "", CODEX, [{ provider: "codex", model: "luna", effort: "low" }, { provider: "grok" }]).lineup[0].effort, "low");
});
