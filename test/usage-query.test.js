const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const Module = require("node:module");
const children = [];
const spawn = (command, args, options) => {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { this.killed = true; }, command, args, options });
  children.push(child);
  return child;
};
const load = Module._load;
Module._load = function (name, ...rest) { return name === "child_process" ? { spawn } : load.call(this, name, ...rest); };
const { queryUsage, parseUsage } = require("../out/usage.js");
Module._load = load;

test("quota parsing preserves zero and missing windows and rejects malformed data", () => {
  const usage = parseUsage({ rate_limits: { five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 100, resets_at: "2027-01-01T00:00:00Z" } } });
  assert.equal(usage.fiveHour, 0);
  assert.equal(usage.week, 100);
  assert.equal(usage.fiveHourResets, undefined);
  assert.equal(usage.weekResets, Date.parse("2027-01-01T00:00:00Z") / 1000);
  assert.equal(usage.source, "query");
  assert.equal(parseUsage({ rate_limits: { five_hour: { utilization: 10 } } }).week, undefined);
  for (const value of [null, undefined, "25", -1, 101, NaN]) {
    assert.throws(() => parseUsage({ rate_limits: { five_hour: { utilization: value } } }), /did not report/);
  }
});

test("Claude usage accepts account-wide session and weekly meter rows, including zero", () => {
  const resets_at = "2027-01-01T00:00:00Z";
  const session = { kind: "session", group: "session", percent: 0, resets_at, scope: null, is_active: false };
  const weekly = { kind: "weekly_all", group: "weekly", percent: 33, resets_at, scope: null };
  const scoped = { ...weekly, kind: "weekly_scoped", percent: 86, scope: { model: { display_name: "Fable" } }, is_active: true };
  const rows = (limits, fields = {}) => parseUsage({ rate_limits: { five_hour: null, limits, ...fields } });
  const usage = rows([scoped, session, weekly]);
  assert.equal(usage.fiveHour, 0);
  assert.equal(usage.fiveHourResets, Date.parse(resets_at) / 1000);
  assert.equal(usage.week, 33);
  assert.equal(usage.weekResets, usage.fiveHourResets);
  assert.equal(rows([scoped, weekly]).fiveHour, undefined);
  assert.equal(rows([scoped, weekly]).quotaCoverage, "weekly-only");
  assert.equal(rows([session, weekly]).quotaCoverage, undefined);
  assert.equal(rows([weekly, { ...session, percent: null }]).quotaCoverage, "incomplete");
  assert.equal(rows([{ kind: "future_window", percent: 95 }, weekly]).quotaCoverage, "incomplete");
  assert.equal(rows(null, { seven_day: { utilization: 10 } }).quotaCoverage, "incomplete");
  assert.throws(() => rows([scoped, { ...session, scope: scoped.scope }, { ...session, percent: "0" }]), /did not report/);
  const agreement = rows([session, weekly, { ...session, is_active: true }], { five_hour: { utilization: 0, resets_at } });
  assert.equal(agreement.fiveHour, 0);
  assert.equal(agreement.fiveHourResets, usage.fiveHourResets);
});

test("agreeing 98% meters retain the one known reset in either order", () => {
  const resets_at = "2027-01-01T00:00:00Z";
  const known = { kind: "session", percent: 98, resets_at };
  const missing = { ...known, resets_at: null };
  for (const pair of [[missing, known], [known, missing]]) {
    const { fiveHour, fiveHourResets } = parseUsage({ rate_limits: { limits: pair } });
    assert.equal(fiveHour, 98);
    assert.equal(fiveHourResets, Date.parse(resets_at) / 1000);
    const mixed = parseUsage({ rate_limits: { five_hour: { utilization: 98, resets_at: pair[0].resets_at }, limits: [pair[1]] } });
    assert.deepEqual([mixed.fiveHour, mixed.fiveHourResets], [fiveHour, fiveHourResets]);
  }
});

test("conflicting Claude meters withhold only the disputed window in either order", () => {
  const resets_at = "2027-01-01T00:00:00Z";
  const weekly = { kind: "weekly_all", percent: 12, resets_at, scope: null };
  const session = { kind: "session", percent: 0, resets_at };
  for (const other of [{ ...weekly, percent: 96 }, { ...weekly, resets_at: "2027-01-02T00:00:00Z" }]) {
    for (const pair of [[weekly, other], [other, weekly]]) {
      const result = parseUsage({ rate_limits: { limits: [session, ...pair] } });
      assert.equal(result.week, undefined);
      assert.equal(result.weekResets, undefined);
      assert.equal(result.fiveHour, 0);
    }
    const named = { utilization: weekly.percent, resets_at };
    const mixed = parseUsage({ rate_limits: { seven_day: named, limits: [other, session] } });
    assert.equal(mixed.week, undefined);
    assert.equal(mixed.weekResets, undefined);
    assert.equal(mixed.fiveHour, 0);
    const onlyConflict = parseUsage({ rate_limits: { seven_day: named, limits: [other] } });
    assert.equal(onlyConflict.week, undefined);
    assert.equal(onlyConflict.fiveHour, undefined);
  }
});

test("usage request only initializes and queries the selected account; no inference prompt", async () => {
  const result = queryUsage("selected-account", new AbortController().signal);
  const child = children.at(-1);
  assert.equal(child.command, "claude");
  assert.equal(child.options.env.CLAUDE_CONFIG_DIR, "selected-account");
  assert.ok(child.args.includes("--safe-mode"));
  const init = JSON.parse(child.stdin.read().toString());
  assert.equal(init.request.subtype, "initialize");
  child.stdout.write(JSON.stringify({ type: "control_response", response: { request_id: "initialize", subtype: "success" } }) + "\n");
  const request = JSON.parse(child.stdin.read().toString());
  assert.equal(request.type, "control_request");
  assert.equal(request.request.subtype, "get_usage");
  child.stdout.write(JSON.stringify({ type: "control_response", response: { request_id: "usage", subtype: "success", response: { rate_limits: { five_hour: { utilization: 12 } } } } }) + "\n");
  assert.equal((await result).fiveHour, 12);
  assert.equal(child.killed, true);
});

test("unsupported requests, early exit, and cancellation end the probe", async () => {
  for (const failure of ["unsupported", "exit", "abort"]) {
    const controller = new AbortController();
    const result = queryUsage("", controller.signal);
    const child = children.at(-1);
    assert.equal(child.options.env.CLAUDE_CONFIG_DIR, undefined);
    if (failure === "unsupported") child.stdout.write(JSON.stringify({ type: "control_response", response: { request_id: "initialize", subtype: "error" } }) + "\n");
    if (failure === "exit") child.emit("exit", 1);
    if (failure === "abort") controller.abort();
    await assert.rejects(result);
    assert.equal(child.killed, true);
  }
});
