const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const cdp = require("./compile-webview-cdp");

// Load a fresh extension clock with an isolated platform, ICU default zone and system command.
function fixture(platform, icuZone, output, tz = "America/Vancouver") {
  const calls = [], clock = {};
  vm.runInNewContext(fs.readFileSync(require.resolve("../out/local-time.js"), "utf8"), {
    exports: clock, process: { platform, env: { TZ: tz } },
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: icuZone }) }) },
    require: (name) => name === "child_process" ? { execFileSync(command, args) {
      calls.push([command, ...args]);
      return output;
    } } : require(name),
  });
  return { clock, calls };
}

const winter = "2025-01-15T18:00:00Z", november = "2026-11-04T22:39:13Z";
const transitions = [
  'TZ="America/Vancouver"', "-\t-\t-08\tPST", "2025-03-09\t03\t-07\tPDT\t1",
  "2025-11-02\t01\t-08\tPST", "2026-03-08\t03\t-07\tPDT\t1", "2026-11-01\t02\t-07\tMST",
].join("\n");

test("one host snapshot formats Vancouver winter and post-policy history in the host, standalone CLI and board", async (t) => {
  // A fixed UTC-8 fallback reproduces stale ICU on both November dates even on CI with newer tzdata.
  const { clock, calls } = fixture("linux", "Etc/GMT+8", transitions);
  assert.equal(clock.localTime(Date.parse(winter)), "10:00:00");
  assert.equal(clock.localTime(Date.parse(november)), "15:39:13");
  assert.equal(clock.localTime(Date.parse("2025-11-02T08:59:59Z")), "01:59:59");
  assert.equal(clock.localTime(Date.parse("2025-11-02T09:00:00Z")), "01:00:00");
  const snapshot = clock.hostClock();
  assert.deepEqual(calls, [["zdump", "-i", "-c", "1970,2100", "--", "America/Vancouver"]]);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "clock-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5 }));
  const dir = path.join(repo, ".entomatical");
  fs.mkdirSync(path.join(dir, "events"), { recursive: true });
  const task = { id: "aaaaaa", title: "Clock", prompt: "Work", status: "review", createdAt: winter, updatedAt: winter,
    measurement: { source: "unknown", at: november, context: { usedPercent: 20, at: winter } } };
  fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([task]));
  fs.writeFileSync(path.join(dir, "events", "aaaaaa.jsonl"), JSON.stringify({ t: Date.parse(november), desc: "November" }));
  const show = (owner) => {
    fs.writeFileSync(path.join(dir, "capabilities.json"), JSON.stringify(owner));
    return execFileSync(process.execPath, [require.resolve("../tools/board.js"), "show", "aaaaaa"], {
      cwd: repo, env: { ...process.env, ENTOMATICAL_REPO: repo, TZ: "UTC" }, encoding: "utf8",
    });
  };
  const shown = show(snapshot);
  assert.match(shown, /since 10:00:00/);
  assert.match(shown, /15:39:13 November/);
  assert.match(shown, /2025-01-15T18:00:00.000Z/);
  assert.match(show({ hostTimezone: "Etc/GMT+7" }), /since 11:00:00/);
  assert.match(show({}), /since 18:00:00/);

  await t.test("the browser renders both measurements and the reset using the owner's snapshot", async (t) => {
    if (!cdp.edgePath()) return t.skip("A browser is required for the board DOM check");
    const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
    const edge = await cdp.launchEdge(url, repo);
    try {
      const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find(p => p.type === "page" && p.url === url), "board page");
      const page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
      try {
        await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board load");
        await page.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
        const board = { tasks: [task], live: [], own: [], accounts: [], ...snapshot };
        await page.evaluate(`window.__host(${JSON.stringify(board)}); true`);
        const card = await page.evaluate("document.querySelector('.card').textContent");
        assert.match(card, /started 10:00/);
        assert.match(card, /Measured[^·]*(?:15:39:13|0?3:39:13\s*p\.?m)/i);
        assert.match(card, /Context window 20% full[^)]*10:00:00/);
        const reset = await page.evaluate(`usageWindow({ week: 20, weekResets: ${Date.parse(november) / 1000} }, "week", 0, state.hostTimezone, state.hostTimeOffsets).reset`);
        assert.match(reset, /15:39|0?3:39\s*p\.?m/i);
      } finally { page.close(); }
    } finally { await edge.kill(); }
  });
});

test("unmapped Windows BC keeps Vancouver history and observes its final spring transition", () => {
  const { clock, calls } = fixture("win32", undefined, "British Columbia Standard Time\r\n");
  assert.equal(clock.localTimeZone(), "America/Vancouver");
  assert.equal(clock.localTime(Date.parse(winter)), "10:00:00");
  assert.equal(clock.localTime(Date.parse(november)), "15:39:13");
  assert.deepEqual(calls, [["tzutil.exe", "/g"]]);
});

test("UTC is retained without a system command; unreadable system rules retain the named zone", () => {
  const { clock, calls } = fixture("linux", "UTC", undefined, "UTC");
  assert.equal(clock.localTimeZone(), "UTC");
  assert.equal(clock.localTime(Date.parse(november)), "22:39:13");
  assert.deepEqual(calls, []);
  const failed = fixture("linux", "Asia/Kolkata", "invalid output").clock;
  assert.equal(failed.localTime(Date.parse(winter)), "23:30:00");
});

test("a fractional-hour transition applies at its UTC instant across midnight", () => {
  const kathmandu = 'TZ="Asia/Kathmandu"\n-\t-\t+0530\n1986-01-01\t00:15\t+0545';
  const { clock } = fixture("linux", "UTC", kathmandu, "Asia/Kathmandu");
  assert.equal(clock.localTime(Date.parse("1985-12-31T18:29:59Z")), "23:59:59");
  assert.equal(clock.localTime(Date.parse("1985-12-31T18:30:00Z")), "00:15:00");
});
