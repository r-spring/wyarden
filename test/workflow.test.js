// The workflow scheduler (src/workflow.ts) driven by fake executors: the seven decisive checks, on the synthetic archive workflow fixture.
// No external worker, Drive or YubiKey is touched; a launch is a function call that records the step.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const W = require("../out/workflow.js");

const plan = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "recover-plan.json"), "utf8"));
const made = [];
test("named locks survive store reopening and non-accepted outcomes never release dependents", () => {
  const f = fixture(), a = f.by("baseline"), b = f.by("scope");
  a.workflow.resources = b.workflow.resources = ["named:wireless-window"];
  assert.ok(W.resourceOk("named:wireless-window"));
  const attempt = W.admit(a, f.store, f.ctx);
  const restored = new W.WorkflowStore(f.dir);
  assert.equal(W.readiness(b, f.tasks, restored, f.ctx).state, "resource");
  W.mark(a, restored, "ended", "owner disappeared");
  assert.equal(restored.claims()[0].attempt, attempt.id, "an uncertain operation keeps its external lock");
  for (const outcome of ["blocked", "deferred", "not-applicable"]) {
    assert.throws(() => W.close(a, restored, outcome, ""), /requires a reason/);
    W.close(a, restored, outcome, "Owner decision or missing prerequisite");
    assert.equal(W.readiness(f.by("small-prep"), f.tasks, restored, f.ctx).state, "dependency");
    assert.equal(restored.receipt(attempt.id).outcome, outcome);
  }
});
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

/** The plan as board cards (key = id), a fresh store, and a launch recorder. */
function fixture(localBudget = 4) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-workflow-"));
  made.push(dir);
  const tasks = plan.steps.map((s, i) => ({ id: s.key, title: s.title, createdAt: new Date(1700000000000 + i * 1000).toISOString(), dependsOn: s.dependsOn, workflow: { ...s.workflow, outcome: "pending" } }));
  const store = new W.WorkflowStore(dir);
  const ctx = { localBudget };
  const launched = [];
  const launch = (t, a) => { launched.push(t.id); W.mark(t, store, "running"); };
  const by = (id) => tasks.find((t) => t.id === id);
  const ready = (id) => W.readiness(by(id), tasks, store, ctx);
  return { dir, tasks, store, ctx, launched, launch, by, ready };
}

test("the plan validates; a cycle, unknown dependency and unknown resource are reported", () => {
  assert.deepEqual(W.validatePlan(plan), []);
  assert.match(W.validatePlan({ steps: [{ key: "a", title: "a", prompt: "p", dependsOn: ["b"], workflow: { resources: [] } }, { key: "b", title: "b", prompt: "p", dependsOn: ["a"], workflow: { resources: [] } }] }).join(" "), /cycle: a → b → a/);
  const errors = W.validatePlan({ steps: [{ key: "a", title: "a", prompt: "p", dependsOn: ["zz"], workflow: { resources: ["gpu"] } }] });
  assert.deepEqual(errors.sort(), ["Step a depends on unknown step zz.", "Step a: unknown resource gpu."]);
});

for (const source of ["task", "attempt", "claim"]) test(`unknown persisted ${source} resource blocks dispatch and continuation without discarding evidence`, async () => {
  const f = fixture(), task = { id: "worker", title: "Worker", createdAt: "", workflow: { resources: ["named:worker"], outcome: "pending" } };
  const attempt = W.admit(task, f.store, f.ctx);
  assert.ok(attempt);
  const legacy = "retired-worker-fixture", tasks = [task];
  let file;
  if (source === "task") tasks.push({ id: "legacy", title: "Legacy", createdAt: "", workflow: { resources: [legacy], outcome: "pending" } });
  if (source === "attempt") {
    f.store.saveAttempt({ ...attempt, id: "legacy", resources: [legacy] });
    file = path.join(f.dir, "attempts", "legacy.json");
  }
  if (source === "claim") {
    const dir = path.join(f.dir, "claims", legacy);
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, "0.json");
    fs.writeFileSync(file, JSON.stringify({ resource: legacy, slot: 0, attempt: "legacy", task: "legacy", window: 1, at: "" }));
  }
  const before = file && fs.readFileSync(file, "utf8"), claims = f.store.claims();
  assert.match(W.validateAttempt(task, tasks, f.store, f.ctx), /explicit reconciliation/);
  const next = { id: "next", title: "Next worker", createdAt: "", workflow: { resources: ["named:worker"], outcome: "pending" } };
  assert.equal(W.readiness(next, tasks, f.store, f.ctx).state, "blocked");
  const result = await W.dispatch([...tasks, next], f.store, f.ctx, "preparation", f.launch);
  assert.deepEqual(result.launched, []);
  assert.deepEqual(f.launched, []);
  if (source !== "task") assert.equal(W.admit(next, f.store, f.ctx), undefined);
  else assert.equal(W.admit(tasks[1], f.store, f.ctx), undefined);
  assert.equal(W.resourceOk(legacy), false);
  assert.equal(W.capacity(legacy, 4), 0);
  assert.equal(f.store.claim(legacy, 1, attempt), false);
  assert.deepEqual(f.store.claims(), claims, "claims remain readable and are not aliased or discarded");
  assert.ok(f.store.attempt(attempt.id), "attempt remains available for audit");
  if (file) assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("1. independent steps start together; a preparation step does not wait for SSH or Drive", async () => {
  const f = fixture();
  const r = await W.dispatch(f.tasks, f.store, f.ctx, "preparation", f.launch, () => {}, 1);
  assert.deepEqual(r.launched, ["baseline", "scope"]); // the two steps with no dependency, in one pass
  assert.equal(f.ready("small-prep").text, "Needs accepted result of Evidence baseline and source map");
  W.mark(f.by("baseline"), f.store, "ended");
  W.close(f.by("baseline"), f.store, "accepted", "none");
  const r2 = await W.dispatch(f.tasks, f.store, f.ctx, "preparation", f.launch, () => {}, 1);
  // Three branches start at once off the accepted baseline (scope still holds one local slot of four); none asks for ssh or rclone.
  assert.deepEqual(r2.launched, ["small-prep", "large-prep", "retention"]);
  assert.equal(f.ready("small-prep").text, "Running");
  assert.equal(f.store.claims().filter((c) => c.resource === "local").length, 4);
});

test("dispatch overlaps independent startup while respecting the local budget and result joins", async () => {
  const f = fixture(2), started = [];
  f.by("retention").dependsOn = []; // A third independent step, behind the two priority-10 steps.
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const run = W.dispatch(f.tasks, f.store, f.ctx, "preparation", async (step) => {
    started.push(step.id); W.mark(step, f.store, "running");
    if (step.id === "baseline") await first;
  });
  let result;
  try {
    assert.deepEqual(started, ["baseline", "scope"], "the second callback starts before the first startup resolves");
    assert.equal(f.store.claims().filter((c) => c.resource === "local").length, 2);
    assert.equal(f.ready("small-prep").state, "dependency", "startup does not accept the baseline result");
    assert.equal(f.ready("retention").state, "resource", "a slow startup still owns its session slot");
  } finally { releaseFirst(); result = await run; }
  assert.deepEqual(result.launched, ["baseline", "scope"]);
  assert.equal(f.ready("small-prep").state, "dependency");
});

test("concurrent startup failures keep priority order and do not retry consumed scopes", async () => {
  const f = fixture(2), tasks = [f.by("baseline"), f.by("scope")], started = [];
  for (const step of tasks) {
    step.workflow.scope = { operations: [step.id], sources: [], destinations: [], toolVersion: "generated fixture", bounds: "one dispatch" };
    f.store.approve(step.workflow.scope);
  }
  let rejectFirst;
  const first = new Promise((_, reject) => { rejectFirst = reject; });
  const run = W.dispatch(tasks, f.store, f.ctx, "authorized", (step) => {
    started.push(step.id);
    if (step.id === "baseline") return first;
    throw new Error("second startup failed first");
  });
  let result;
  try { assert.deepEqual(started, ["baseline", "scope"]); }
  finally { rejectFirst(new Error("first startup failed later")); result = await run; }
  assert.deepEqual(result.launched, []);
  assert.deepEqual(result.skipped.map((s) => s.id), ["baseline", "scope"]);
  for (const step of tasks) {
    assert.equal(step.workflow.outcome, "failed");
    assert.deepEqual(f.store.approval(step.workflow.scope).used, [step.workflow.attempt]);
  }
  const again = await W.dispatch(tasks, f.store, f.ctx, "authorized", () => { throw new Error("must not retry"); });
  assert.deepEqual(again.launched, []);
  assert.ok(again.skipped.every((s) => /Touch budget spent/.test(s.text)));
});

test("2. joins wait for accepted evidence: Review, a gone session or a manual Done do not release dependents", async () => {
  const f = fixture();
  await W.dispatch(f.tasks, f.store, f.ctx, "preparation", f.launch, () => {}, 1);
  W.mark(f.by("baseline"), f.store, "ended"); // Stop hook: the card is in Review
  assert.equal(f.ready("small-prep").state, "dependency");
  assert.equal(f.ready("baseline").text, "Session ended: Record its result (attempt " + f.by("baseline").workflow.attempt + ")");
  assert.equal(f.by("baseline").workflow.outcome, "pending");
  W.close(f.by("baseline"), f.store, "held", "hash list incomplete");
  assert.equal(f.ready("small-prep").state, "dependency", "a held result releases nothing");
  const r = await W.dispatch(f.tasks, f.store, f.ctx, "preparation", f.launch, () => {}, 1);
  assert.ok(!r.launched.includes("small-prep"));
  // A closure step needs its tranche to end in any outcome; an ordinary dependency needs accepted.
  f.by("small-tranche").workflow.outcome = "failed";
  assert.equal(f.ready("small-closure").text, "Ready");
  f.by("small-tranche").workflow.outcome = "pending";
  assert.equal(f.ready("small-closure").text, "Needs Small-file tranche to end");
});

test("3. two windows cannot claim the same exclusive resource", () => {
  const f = fixture();
  const other = new W.WorkflowStore(f.dir); // a second window on the same repository
  const a = { id: "x", title: "Large-pipeline qualification", createdAt: "", workflow: { resources: ["external-worker"], outcome: "pending" } };
  const b = { id: "y", title: "Small-reader qualification", createdAt: "", workflow: { resources: ["external-worker"], outcome: "pending" } };
  assert.ok(W.admit(a, f.store, f.ctx, 111));
  assert.equal(W.admit(b, other, f.ctx, 222), undefined);
  assert.equal(W.readiness(b, [a, b], other, f.ctx).text, "Waiting for external worker");
  assert.equal(W.readiness(b, [a, b], other, f.ctx).state, "resource");
  const lane = W.lanes([a, b], other, f.ctx).find((l) => l.resource === "external-worker");
  assert.equal(lane.holders[0].window, 111);
  assert.deepEqual(lane.queued, ["Small-reader qualification"]);
  assert.deepEqual(lane.release, [`Record result of Large-pipeline qualification (attempt ${a.workflow.attempt})`]);
  assert.equal(b.workflow.attempt, undefined, "the lost claim left no attempt behind");
  assert.equal(W.capacity("cloud", 4), 0);
});

test("4. reload does not duplicate an uncertain launch; the attempt is persisted before the launch", async () => {
  const f = fixture();
  const persisted = [];
  await W.dispatch(f.tasks, f.store, f.ctx, "preparation", (t) => { persisted.push(fs.existsSync(path.join(f.dir, "attempts", `${t.workflow.attempt}.json`))); throw new Error("window closed"); }, () => {}, 1);
  assert.deepEqual(persisted, [true, true]);
  assert.equal(f.by("baseline").workflow.outcome, "failed", "a launch that threw is recorded, not retried");
  // A launch the window died in: the attempt is on disk in state launching. Reload: the same cards read back, a new store on the same
  // folder; the session is gone, so the outcome is unknown.
  assert.ok(W.admit(f.by("retention"), f.store, f.ctx, 1));
  const tasks = JSON.parse(JSON.stringify(f.tasks));
  const store = new W.WorkflowStore(f.dir);
  const baseline = tasks.find((t) => t.id === "retention");
  W.mark(baseline, store, "ended", "session gone or interrupted");
  assert.equal(baseline.workflow.outcome, "unknown");
  const launched = [];
  const r = await W.dispatch(tasks, store, f.ctx, "preparation", (t) => launched.push(t.id), () => {}, 2);
  assert.deepEqual(launched, ["baseline", "scope"], "the failed launches of preparation steps may run again; the uncertain one may not");
  assert.match(r.skipped.find((s) => s.id === "retention").text, /^Interrupted: attempt \w+ has no result yet/);
  assert.match(W.validateAttempt(baseline, tasks, store, f.ctx), /is unknown: Record its result; no retry/);
  // Reconciled by the owner: the attempt stays on record, a new one may start.
  W.close(baseline, store, "cancelled", "window closed mid-run");
  assert.equal(W.readiness(baseline, tasks, store, f.ctx).state, "dependency"); // back at its ordinary gates (it needs the baseline)
  assert.equal(store.receipt(baseline.workflow.attempt).outcome, "cancelled");
});

test("5. an authentication failure is not retried: the one touch is spent and the claims stay until closed", async () => {
  const f = fixture();
  const qual = f.by("large-qual");
  f.by("large-prep").workflow.outcome = "accepted";
  assert.match(f.ready("large-qual").text, /^Awaiting scope review/);
  f.store.approve(qual.workflow.scope);
  assert.equal(f.ready("large-qual").text, "Needs current ssh admission");
  f.store.admit("ssh", 60_000);
  assert.equal(f.ready("large-qual").text, "Ready");
  // The launch passes the board's gate (validateAttempt) right after admit spent this attempt's own touch. Before 5 November 2026 the
  // gate read that touch as "Touch budget spent" and refused every approved scoped step (found live on Windows, F66).
  const gated = [];
  const r = await W.dispatch(f.tasks, f.store, f.ctx, "authorized", (t, a) => { gated.push(W.validateAttempt(t, f.tasks, f.store, f.ctx)); f.launch(t, a); }, () => {}, 1);
  assert.deepEqual(r.launched, ["large-qual"]);
  assert.deepEqual(gated, [undefined]);
  assert.equal(W.validateAttempt(qual, f.tasks, f.store, f.ctx), undefined, "its running attempt still validates");
  // A re-approval is a new budget this attempt did not spend: the attempt cannot continue under it.
  const before = JSON.parse(fs.readFileSync(path.join(f.dir, "approvals", `${W.scopeHash(qual.workflow.scope)}.json`), "utf8"));
  f.store.approve(qual.workflow.scope);
  assert.match(W.validateAttempt(qual, f.tasks, f.store, f.ctx), /has no touch of the current approval; no retry/);
  fs.writeFileSync(path.join(f.dir, "approvals", `${before.scopeHash}.json`), JSON.stringify(before));
  W.fail(qual, f.store, "login failed");
  assert.equal(qual.workflow.outcome, "failed");
  assert.ok(f.store.claims().some((c) => c.resource === "external-worker" && c.attempt === qual.workflow.attempt), "external worker stays held until the owner closes the attempt");
  assert.match(f.ready("large-qual").text, /^Failed \(attempt \w+\) still holds resources: Record its result/);
  W.close(qual, f.store, "failed", "login failed; no retry");
  assert.match(f.ready("large-qual").text, /^Touch budget spent \(1 of 1, attempt \w+\); no retry/);
  const r2 = await W.dispatch(f.tasks, f.store, f.ctx, "authorized", f.launch, () => {}, 1);
  assert.deepEqual(r2.launched, []);
  // An expired admission blocks a fresh approval too; admissions are not authorization.
  f.store.approve(qual.workflow.scope);
  f.store.admit("ssh", -1);
  assert.equal(f.ready("large-qual").text, "Needs current ssh admission");
});

test("6. Resume cannot bypass a hold, a blocker, or a dependency that went away", async () => {
  const f = fixture();
  await W.dispatch(f.tasks, f.store, f.ctx, "preparation", f.launch, () => {}, 1);
  const scope = f.by("scope");
  W.mark(scope, f.store, "ended");
  W.close(scope, f.store, "held", "waiting on the owner");
  assert.match(W.validateAttempt(scope, f.tasks, f.store, f.ctx), /is held: Record its result; no retry/);
  assert.equal(f.ready("scope").text, `Held (attempt ${scope.workflow.attempt}): waiting on the owner`);
  assert.equal((await W.dispatch(f.tasks, f.store, f.ctx, "preparation", f.launch, () => {}, 1)).launched.includes("scope"), false);
  W.close(scope, f.store, "cancelled", "re-judged"); // the owner re-judges it; a preparation step may then run again
  assert.equal(f.ready("scope").text, "Ready");
  // A running attempt whose dependency was later withdrawn, or whose scope approval vanished, cannot continue either.
  const prep = f.by("small-prep");
  f.by("baseline").workflow.outcome = "accepted";
  assert.ok(W.admit(prep, f.store, f.ctx, 1));
  assert.equal(W.validateAttempt(prep, f.tasks, f.store, f.ctx), undefined);
  f.by("baseline").workflow.outcome = "pending";
  assert.match(W.validateAttempt(prep, f.tasks, f.store, f.ctx), /^Needs accepted result/);
  f.by("baseline").workflow.outcome = "accepted";
  prep.workflow.blocker = "owner hold";
  assert.equal(W.validateAttempt(prep, f.tasks, f.store, f.ctx), "Awaiting resolution of owner hold");
});

/** One synthetic scoped attempt whose single approved touch has already been consumed. */
function scopedAttempt(refs, now = Date.now()) {
  const f = fixture(), step = f.by("large-qual");
  f.ctx.now = now;
  step.workflow.scope = { ...structuredClone(step.workflow.scope), expires: new Date(f.ctx.now + 60_000).toISOString() };
  step.workflow.admission = step.workflow.admission?.slice();
  step.workflow.refs = refs;
  f.by("large-prep").workflow.outcome = "accepted";
  f.store.approve(step.workflow.scope);
  f.store.admit("ssh", 60_000, f.ctx.now);
  const attempt = W.admit(step, f.store, f.ctx, 1);
  assert.ok(attempt);
  W.mark(step, f.store, "running");
  return { ...f, step, attempt };
}

test("a scoped attempt continues under its own consumed touch without authorizing another dispatch", () => {
  const f = scopedAttempt();
  assert.equal(W.validateAttempt(f.step, f.tasks, f.store, f.ctx), undefined);
  assert.deepEqual(f.store.approval(f.step.workflow.scope).used, [f.attempt.id]);
  const another = { ...f.step, id: "another", workflow: { ...f.step.workflow, attempt: undefined } };
  assert.match(W.readiness(another, f.tasks, f.store, f.ctx).text, /^Touch budget spent/);
});

test("an ended pending conversation revalidates every gate before it can resume", async (t) => {
  const cases = [
    ["valid same attempt", () => {}, undefined],
    ["expired authorization", (f) => { f.ctx.now += 60_001; }, /Authorization expired/],
    ["new policy hold", (f) => { f.step.workflow.blocker = "owner hold"; }, /Awaiting resolution of owner hold/],
    ["withdrawn dependency", (f) => { f.by("large-prep").workflow.outcome = "held"; }, /Needs accepted result/],
    ["expired admission", (f) => { f.store.admit("ssh", -1, f.ctx.now); }, /Needs current ssh admission/],
    ["lost payload claim", (f) => { f.store.release(f.attempt.id, "external-worker"); }, /no longer holds external-worker/],
    ["replacement approval", (f) => { f.store.approve(f.step.workflow.scope); }, /not approved for this attempt/],
  ];
  for (const [name, change, expected] of cases) await t.test(name, () => {
    const f = scopedAttempt();
    W.mark(f.step, f.store, "ended");
    change(f);
    const problem = W.validateAttempt(f.step, f.tasks, f.store, f.ctx);
    if (expected) assert.match(problem, expected); else {
      assert.equal(problem, undefined);
      assert.equal(W.reopen(f.step, f.store, f.ctx), undefined);
      assert.equal(f.store.attempt(f.attempt.id).state, "running");
      assert.deepEqual(f.store.approval(f.step.workflow.scope).used, [f.attempt.id]);
    }
  });
});

test("a running attempt rejects scope edits, including expiry changes that keep the same approval key", async (t) => {
  const cases = [
    ["changed operation", (f) => { f.step.workflow.scope.operations.push("another operation"); }],
    ["extended expiry", (f) => { f.step.workflow.scope.expires = new Date(f.ctx.now + 120_000).toISOString(); }],
    ["removed scope", (f) => { f.step.workflow.scope = undefined; }],
  ];
  for (const [name, change] of cases) await t.test(name, () => {
    const f = scopedAttempt();
    change(f);
    assert.match(W.validateAttempt(f.step, f.tasks, f.store, f.ctx), /Scope changed since dispatch/);
  });
});

test("a scoped attempt requires its own use in the still-current approval", async (t) => {
  for (const replacement of [undefined, [], ["another-attempt"]]) await t.test(JSON.stringify(replacement) ?? "missing", () => {
    const f = scopedAttempt();
    const file = path.join(f.store.dir, "approvals", `${W.scopeHash(f.step.workflow.scope)}.json`);
    if (replacement === undefined) fs.rmSync(file);
    else fs.writeFileSync(file, JSON.stringify({ ...f.store.approval(f.step.workflow.scope), used: replacement }));
    assert.match(W.validateAttempt(f.step, f.tasks, f.store, f.ctx), /not approved for this attempt/);
  });
});

test("completed authentication releases only this attempt's prompt requirement", () => {
  const f = scopedAttempt();
  f.store.release(f.attempt.id, "auth-prompt");
  const attempt = f.store.attempt(f.attempt.id);
  attempt.resources = attempt.resources.filter((r) => r !== "auth-prompt");
  f.store.saveAttempt(attempt);
  assert.equal(W.validateAttempt(f.step, f.tasks, f.store, f.ctx), undefined);
  assert.ok(f.step.workflow.resources.includes("auth-prompt"), "a future dispatch still needs its own prompt slot");
  assert.ok(f.store.claims().some((c) => c.attempt === f.attempt.id && c.resource === "external-worker"));
});

test("admission names are fixed at dispatch and later changes cannot widen an attempt", () => {
  const f = scopedAttempt();
  assert.deepEqual(f.attempt.admission, ["ssh"]);
  assert.equal(W.validateAttempt(f.step, f.tasks, f.store, f.ctx), undefined);
  f.step.workflow.admission.push("rclone");
  assert.deepEqual(f.attempt.admission, ["ssh"], "the snapshot does not share the mutable declaration array");
  assert.deepEqual(f.store.attempt(f.attempt.id).admission, ["ssh"]);
  assert.match(W.validateAttempt(f.step, f.tasks, f.store, f.ctx), /Admission requirements changed since dispatch/);
});

test("an older attempt without captured admissions cannot continue a step that requires them", () => {
  const f = scopedAttempt(), legacy = f.store.attempt(f.attempt.id);
  delete legacy.admission;
  f.store.saveAttempt(legacy);
  assert.match(W.validateAttempt(f.step, f.tasks, f.store, f.ctx), /Admission requirements changed since dispatch/);
});

test("an admission expiring after a valid phase blocks the next phase of the same attempt", () => {
  const f = scopedAttempt();
  assert.equal(W.validateAttempt(f.step, f.tasks, f.store, f.ctx), undefined);
  f.store.admit("ssh", -1, f.ctx.now);
  assert.equal(W.validateAttempt(f.step, f.tasks, f.store, f.ctx), "Needs current ssh admission");
});

test("a persisted failed, held or unknown attempt cannot resume through a stale pending card", async (t) => {
  for (const outcome of ["failed", "held", "unknown"]) await t.test(outcome, () => {
    const f = scopedAttempt(), attempt = f.store.attempt(f.attempt.id);
    Object.assign(attempt, { state: "ended", outcome });
    f.store.saveAttempt(attempt);
    assert.match(W.validateAttempt(f.step, f.tasks, f.store, f.ctx), new RegExp(`is ${outcome}:.*no retry`));
    assert.equal(f.store.claims().length, 2, "validation preserves the unresolved resource holds");
  });
});

test("invalid nonempty authorization expiry blocks both dispatch and continuation", () => {
  const f = fixture(), step = f.by("large-qual");
  f.by("large-prep").workflow.outcome = "accepted";
  step.workflow.scope = { ...structuredClone(step.workflow.scope), expires: "not-a-timestamp" };
  f.store.approve(step.workflow.scope); f.store.admit("ssh", 60_000);
  assert.match(f.ready("large-qual").text, /Authorization expiry is invalid/);
  // Simulate a legacy attempt already admitted with this invalid bound.
  W.admit(step, f.store, f.ctx);
  assert.match(W.validateAttempt(step, f.tasks, f.store, f.ctx), /Authorization expiry is invalid/);
});

test("extending or removing expiry before dispatch cannot reuse an earlier approval", async (t) => {
  for (const extend of [true, false]) await t.test(extend ? "extended" : "removed", async () => {
    const f = fixture(), step = f.by("large-qual"), now = Date.now();
    f.by("large-prep").workflow.outcome = "accepted";
    step.workflow.scope = { ...structuredClone(step.workflow.scope), expires: new Date(now + 60_000).toISOString() };
    const approval = f.store.approve(step.workflow.scope);
    f.store.admit("ssh", 300_000, now);
    f.ctx.now = now + 60_001;
    if (extend) step.workflow.scope.expires = new Date(now + 120_000).toISOString(); else delete step.workflow.scope.expires;
    assert.equal(W.scopeHash(step.workflow.scope), approval.scopeHash, "preserve existing approval filename compatibility");
    const r = await W.dispatch(f.tasks, f.store, f.ctx, "authorized", f.launch);
    assert.deepEqual(r.launched, []);
    assert.match(r.skipped.find((s) => s.id === step.id).text, /Scope changed since approval/);
    assert.equal(step.workflow.attempt, undefined);
    assert.deepEqual(f.store.claims(), []);
    assert.deepEqual(f.store.approval(step.workflow.scope).used, []);
  });
});

test("continuation binds the approval expiry to the recorded attempt", async (t) => {
  for (const extend of [true, false]) await t.test(extend ? "extended" : "removed", () => {
    const f = scopedAttempt(), approval = f.store.approval(f.step.workflow.scope);
    if (extend) approval.scope.expires = new Date(f.ctx.now + 120_000).toISOString(); else delete approval.scope.expires;
    fs.writeFileSync(path.join(f.store.dir, "approvals", `${approval.scopeHash}.json`), JSON.stringify(approval));
    assert.match(W.validateAttempt(f.step, f.tasks, f.store, f.ctx), /not approved for this attempt/);
  });
});

test("edited execution scope cannot be accepted or release dependencies", async (t) => {
  const cases = [
    ["operations", (s) => { s.operations.push("another operation"); }],
    ["sources", (s) => { s.sources.push("another source"); }],
    ["tool version", (s) => { s.toolVersion = "different-tool-version"; }],
    ["extended expiry", (s) => { s.expires = new Date(Date.parse(s.expires) + 60_000).toISOString(); }],
    ["removed expiry", (s) => { delete s.expires; }],
  ];
  for (const [name, change] of cases) await t.test(name, () => {
    const f = scopedAttempt();
    W.mark(f.step, f.store, "ended");
    const before = f.store.attempt(f.attempt.id), claims = f.store.claims();
    change(f.step.workflow.scope);
    assert.throws(() => W.close(f.step, f.store, "accepted", ""), /Scope changed since dispatch/);
    assert.equal(f.step.workflow.outcome, "pending");
    assert.equal(f.step.workflow.receipt, undefined);
    assert.equal(f.store.receipt(f.attempt.id), undefined);
    assert.deepEqual(f.store.attempt(f.attempt.id), before);
    assert.deepEqual(f.store.claims(), claims);
  });
});

test("a completed original scope may be accepted after its authorization expires", () => {
  const f = scopedAttempt(undefined, Date.now() - 120_000);
  W.mark(f.step, f.store, "ended");
  assert.ok(Date.parse(f.step.workflow.scope.expires) < Date.now());
  const receipt = W.close(f.step, f.store, "accepted", "Original run completed; no further execution authorized.");
  assert.equal(receipt.outcome, "accepted");
  assert.equal(f.step.workflow.receipt, f.attempt.id);
  assert.deepEqual(f.store.claims(), []);
});

test("changed input, tool or output references block continuation and acceptance without reading inputs", async (t) => {
  for (const key of ["inputs", "tools", "outputs"]) await t.test(key, () => {
    const f = scopedAttempt({ inputs: ["unread-source-descriptor"], tools: ["reader-version-descriptor"], outputs: [] });
    assert.equal(W.validateAttempt(f.step, f.tasks, f.store, f.ctx), undefined, "input/tool descriptors need no readable files");
    const before = f.store.attempt(f.attempt.id), claims = f.store.claims();
    f.step.workflow.refs[key] = ["changed-descriptor"];
    assert.match(W.validateAttempt(f.step, f.tasks, f.store, f.ctx), /references changed since dispatch/);
    assert.throws(() => W.close(f.step, f.store, "accepted", ""), /references changed since dispatch/);
    assert.equal(f.store.receipt(f.attempt.id), undefined);
    assert.deepEqual(f.store.attempt(f.attempt.id), before);
    assert.deepEqual(f.store.claims(), claims);
  });
});

test("missing declared output cannot be accepted; a hold preserves the missing-artifact record", () => {
  const f = fixture(), step = f.by("baseline"), output = path.join(f.dir, "absent-result.json");
  step.workflow.refs = { inputs: ["unread-input-descriptor"], tools: ["unread-tool-descriptor"], outputs: [output] };
  step.workflow.resources = ["local", "catalog-writer"];
  W.admit(step, f.store, f.ctx);
  W.mark(step, f.store, "running"); W.mark(step, f.store, "ended");
  const before = f.store.attempt(step.workflow.attempt), claims = f.store.claims();
  assert.deepEqual(claims.map((c) => c.resource), ["catalog-writer"]);
  assert.throws(() => W.close(step, f.store, "accepted", ""), /declared output artifact is missing or unreadable/);
  assert.equal(step.workflow.outcome, "pending");
  assert.equal(step.workflow.receipt, undefined);
  assert.equal(f.store.receipt(before.id), undefined);
  assert.deepEqual(f.store.attempt(before.id), before);
  assert.deepEqual(f.store.claims(), claims);
  const receipt = W.close(step, f.store, "held", "The result file was not produced.");
  assert.equal(receipt.artifacts[output], "missing");
  assert.equal(receipt.outcome, "held");
  assert.equal(f.store.claims().length, 0);
  assert.equal(f.ready("small-prep").state, "dependency");
});

test("7. blocked payload work leaves independent preparation running; external worker is one job; USB stays ahead of retention", async () => {
  const f = fixture(1);
  for (const id of ["baseline", "store", "small-prep", "large-prep"]) f.by(id).workflow.outcome = "accepted";
  for (const id of ["small-qual", "large-qual", "small-tranche", "large-tranche"]) f.store.approve(f.by(id).workflow.scope);
  f.store.admit("ssh", 60_000); f.store.admit("rclone", 60_000);
  // The live Drive steps carry the unresolved prohibition; nothing here resolves it or invents a USB task.
  assert.equal(f.ready("small-tranche").text, "Awaiting resolution of USB-rules payload prohibition (EXAMPLE-POLICY.md)");
  assert.equal(f.ready("small-tranche").state, "blocked");
  const r = await W.dispatch(f.tasks, f.store, f.ctx, "authorized", f.launch, () => {}, 1);
  assert.deepEqual(r.launched, ["small-qual"], "one external worker job; the large qualification waits for the slot");
  assert.equal(f.ready("large-qual").text, "Waiting for external worker");
  assert.equal(f.ready("large-qual").state, "resource");
  assert.ok(r.skipped.some((s) => s.id === "large-tranche" && /payload prohibition/.test(s.text)));
  // With external worker occupied and the tranches blocked, the local budget (one slot) still runs preparation: USB work before retention.
  const p = await W.dispatch(f.tasks, f.store, f.ctx, "preparation", f.launch, () => {}, 1);
  assert.deepEqual(p.launched, ["scope"]);
  assert.equal(f.ready("retention").text, "Waiting for a local session slot (1 of 1 in use)");
  assert.equal(f.ready("repair").text, "Awaiting resolution of separate repair authorization");
  assert.equal(f.tasks.filter((t) => t.workflow.attempt).length, 2);
});

test("a receipt carries the attempt, references, artifact hashes, checks and limitations, and only accepted names a receipt", () => {
  const f = fixture();
  const out = path.join(f.dir, "snapshot.json");
  fs.writeFileSync(out, "{}");
  const b = f.by("baseline");
  b.workflow.refs = { inputs: ["evidence/*"], tools: ["hasher 1.0"], outputs: [out] };
  W.admit(b, f.store, f.ctx, 1);
  W.mark(b, f.store, "running"); W.mark(b, f.store, "ended");
  assert.throws(() => W.close(b, f.store, "accepted", "", false), /checks did not pass/);
  const r = W.close(b, f.store, "accepted", "one source unreadable");
  assert.equal(r.attempt, b.workflow.attempt);
  assert.deepEqual(r.inputs, ["evidence/*"]); assert.deepEqual(r.tools, ["hasher 1.0"]);
  assert.equal(r.artifacts[out], "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  assert.deepEqual(r.checks, ["snapshot hashed", "source map complete"]);
  assert.equal(b.workflow.receipt, r.attempt);
  assert.equal(f.ready("small-prep").text, "Ready");
  assert.equal(f.store.claims().length, 0);
});

// The board's gate: every launch path passes it, and the card's column never changes the outcome.
test("Board: workflow admission, continuation and recording a result", async (t) => {
  class EventEmitter { listeners = []; event = (l) => (this.listeners.push(l), { dispose() {} }); fire(e) { for (const l of this.listeners) l(e); } dispose() {} }
  const vscode = { EventEmitter, window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined, createTerminal: () => { throw new Error("no terminal in this test"); } } };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-home-"));
  made.push(home);
  const env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
  let board;
  try {
    const { Board } = require("../out/board.js");
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-wf-board-"));
    made.push(repo);
    board = new Board(repo, path.join(repo, "none", "hook.js"), path.join(repo, "hookdir"));
    const step = board.add("Small-reader preparation", "p", undefined, undefined, undefined, undefined, undefined, { workflow: { resources: ["local"], outcome: "pending" } });
    board.update(step, { sessionId: "sid", worktree: repo });
    board.gate(step); // a new attempt, as Start would make
    assert.equal(board.workflow.attempt(step.workflow.attempt).boardRoot, repo);
    board.update(step, { status: "running" });
    assert.equal(board.workflow.attempt(step.workflow.attempt).state, "running");
    board.update(step, { status: "done" }); // Mark done
    assert.equal(step.workflow.outcome, "pending");
    assert.equal(board.readinessOf(step).text, `Session ended: Record its result (attempt ${step.workflow.attempt})`);
    // F45: a window that does not own the board changes nothing, in the workflow store either.
    const owner = path.join(board.dir, "owner.json"), notOwner = /Another VS Code window runs this repo's board/;
    fs.writeFileSync(owner, JSON.stringify({ pid: process.ppid, at: Date.now() })); // another window, stood in for by the parent process
    const claims = JSON.stringify(board.workflow.claims());
    assert.throws(() => board.closeStep(step, "held", "elsewhere"), notOwner);
    assert.equal(board.workflow.attempt(step.workflow.attempt).outcome, undefined); // before: closed, its receipt written, then save() refused
    assert.throws(() => board.approveScope(step), notOwner);
    await assert.rejects(board.resume(step), notOwner); // before the gate re-takes its local slot
    assert.equal(JSON.stringify(board.workflow.claims()), claims);
    fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, at: Date.now() }));
    board.closeStep(step, "held", "owner hold");
    await assert.rejects(board.resume(step), /Held \(attempt \w+\): owner hold$/);
    await assert.rejects(board.openInPanel(step), /Held \(attempt/);
    assert.throws(() => board.switchAccount(step, "nobody"), /not signed in|Held/);
    assert.throws(() => board.send(step, "carry on"), /No live session/); // no terminal; the gate sits behind that check and refuses too
    const plain = board.add("plain", "a card without workflow information");
    board.gate(plain); // passes
    assert.deepEqual(board.workflow.claims(), []); // Record result released every claim

    for (const outcome of ["held", "failed"]) await t.test(`a task edited after dispatch can be recorded as ${outcome}`, () => {
      const step = board.add("Writer", "p", undefined, undefined, undefined, undefined, undefined, { workflow: { resources: ["catalog-writer"], outcome: "pending" } });
      board.gate(step);
      board.update(step, { workflow: { ...step.workflow, resources: ["writer-typo"] } });
      assert.throws(() => board.gate(step), /explicit reconciliation/);
      assert.throws(() => board.closeStep(step, "accepted", ""), /explicit reconciliation/);
      assert.equal(board.workflow.receipt(step.workflow.attempt), undefined);
      assert.equal(board.workflow.claims()[0].attempt, step.workflow.attempt);
      assert.equal(board.closeStep(step, outcome, "Reconcile edited task").outcome, outcome);
      assert.deepEqual(board.workflow.claims(), []);
      board.update(step, { workflow: { ...step.workflow, resources: ["catalog-writer"] } });
    });

    const typo = "catalog-writre";
    const saved = board.add("Saved resource", "p", undefined, undefined, undefined, undefined, undefined, { workflow: { resources: [typo], outcome: "pending" } });
    await t.test("a new typo cannot reserve a slot or start an attempt", () => {
      assert.throws(() => board.gate(saved), /explicit reconciliation/);
      assert.equal(saved.workflow.attempt, undefined);
      assert.deepEqual(board.workflow.claims(), []);
    });
    // Recreate records that an older release could have written, including a claim owned by the same attempt.
    const attempt = { id: "old", task: saved.id, title: saved.title, startedAt: "", state: "ended", resources: [typo], window: 1 };
    saved.workflow.attempt = attempt.id;
    board.workflow.saveAttempt(attempt);
    const dir = path.join(board.workflow.dir, "claims", typo);
    fs.mkdirSync(dir, { recursive: true });
    const claim = { resource: typo, slot: 0, attempt: attempt.id, task: saved.id, window: 1, at: "" };
    fs.writeFileSync(path.join(dir, "0.json"), JSON.stringify(claim));
    await t.test("an old matching claim cannot reopen the attempt", () => {
      assert.throws(() => board.gate(saved), /explicit reconciliation/);
      assert.deepEqual(board.workflow.attempt(attempt.id), attempt);
    });
    await t.test("an old matching claim cannot produce an accepted receipt", () => {
      assert.throws(() => board.closeStep(saved, "accepted", ""), /explicit reconciliation/);
      assert.equal(board.workflow.receipt(attempt.id), undefined);
      assert.deepEqual(board.workflow.claims(), [claim]);
      assert.equal(saved.workflow.outcome, "pending");
      assert.equal(board.closeStep(saved, "held", "Reconcile resource").outcome, "held");
    });
  } finally {
    board?.dispose();
    Module._load = load;
    process.env.HOME = env.HOME; process.env.USERPROFILE = env.USERPROFILE;
  }
});
