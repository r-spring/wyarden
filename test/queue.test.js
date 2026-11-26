const test = require("node:test");
const assert = require("node:assert/strict");
const q = require("../out/queue.js");

const card = (id, status, extra = {}) => ({ id, title: `card ${id}`, status, createdAt: `2026-11-03T10:0${id.length}:00Z`, ...extra });

test("Start after: a card waits until the card it follows is Done, or in Review after a real Stop with its checks passed", () => {
  const b = card("b", "queued", { dependsOn: ["a"], held: true });
  for (const [a, wait] of [
    [card("a", "running"), "Starts after card a"],
    [card("a", "review", { completion: { commands: ["npm test"] }, checks: { status: "running" } }), "Starts after card a"],
    [card("a", "review", { completion: { commands: ["npm test"] }, checks: { status: "error" } }), "Starts after card a"],
    [card("a", "review", { interrupted: true }), "Waiting: card a was interrupted"],
    [card("a", "review", { completion: { commands: ["npm test"] }, checks: { status: "complete" } }), undefined],
    [card("a", "review"), undefined], // no checks to wait for
    [card("a", "done"), undefined],
  ]) assert.equal(q.waitReason(b, [a, b], 0), wait, JSON.stringify(a));
  assert.equal(q.waitReason(b, [b], 0), undefined, "a deleted card holds nothing back");
  assert.equal(q.waitReason({ ...b, workflow: {} }, [card("a", "running"), b], 0), undefined, "plan steps keep workflow.ts gates");
});

test("a watched card (an orchestrator's child, a plan step) releases its Start after cards only at Done, once its watcher merged it", () => {
  const b = card("b", "queued", { dependsOn: ["a"], held: true, openedBy: "m", watchedBy: "m" });
  for (const [a, wait] of [
    [card("a", "review", { watchedBy: "m", completion: { commands: ["npm test"] }, checks: { status: "complete" } }), "Starts after card a"],
    [card("a", "review", { openedBy: "m" }), "Starts after card a"], // watchedBy defaults to openedBy
    [card("a", "review", { watchedBy: "m", interrupted: true }), "Waiting: card a was interrupted"],
    [card("a", "done", { watchedBy: "m" }), undefined],
  ]) assert.equal(q.waitReason(b, [a, b], 0), wait, JSON.stringify(a));
  // Fails on the code before: a watched card in Review with its checks passed released b before its watcher had merged it.
});

test("a discarded Start after card releases nobody, and its title stays on the cards waiting for it once it is deleted (ported from 52c573d)", () => {
  const b = card("b", "queued", { dependsOn: ["a"], held: true });
  assert.equal(q.waitReason(b, [card("a", "done", { discarded: true }), b], 0), "blocked: card a discarded");
  assert.equal(q.waitReason({ ...b, blocked: "card a" }, [b], 0), "blocked: card a discarded", "deleted after the discard");
  assert.equal(q.waitReason(b, [card("a", "done"), b], 0), undefined, "an ordinary Done still releases");
});

test("the running limit holds cards back, counts starting cards, starts oldest first, and 0 means no limit", () => {
  const tasks = [card("r1", "running"), card("s", "queued", { sessionId: "x" }), card("needs", "needs-input"),
    card("h22", "queued", { held: true }), card("h1", "queued", { held: true }), card("plain", "queued")];
  assert.equal(q.waitReason(tasks[3], tasks, 2), "Waiting for a session slot (2 of 2 running)");
  assert.deepEqual(q.toStart(tasks, 2).map((t) => t.id), []);
  assert.deepEqual(q.toStart(tasks, 3).map((t) => t.id), ["h1"]);
  assert.deepEqual(q.toStart(tasks, 0).map((t) => t.id), ["h1", "h22"], "only held cards; never one the user left queued");
  // A held card whose Start after card is unfinished is skipped, and the next one takes the slot.
  const after = [card("a", "running"), card("w", "queued", { held: true, dependsOn: ["a"] }), card("ww", "queued", { held: true })];
  assert.deepEqual(q.toStart(after, 2).map((t) => t.id), ["ww"]);
});
