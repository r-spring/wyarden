// F98: a card's new plan file is written to <main checkout>/workflows/ so Run a plan… lists it (hook/plan-folder.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { isPlan, repoOf, place, settle, finish, commitPlan, today, dated } = require("../hook/plan-folder.js");
const DAY = "2026-11-14";

const repo = path.resolve("/repo");
const wt = path.join(repo, ".entomatical", "wt", "0501bf");
const env = { ENTOMATICAL_REPO: repo };
const plan = JSON.stringify({ v: 1, name: "x", review: "checks", steps: [] });
const write = (file_path, content = plan, extra = {}) => ({ tool_name: "Write", cwd: wt, permission_mode: "bypassPermissions", tool_input: { file_path, content }, ...extra });
const none = () => false;

test("recognises plan files by name or by content", () => {
  assert.equal(isPlan("/a/x.plan.json", "not json"), true);
  assert.equal(isPlan("/a/x.json", plan), true);
  assert.equal(isPlan("/a/checks.json", JSON.stringify({ build: { run: "npm run build" } })), false);
  assert.equal(isPlan("/a/x.json", "[1]"), false);
  assert.equal(isPlan("/a/x.md", plan), false);
});

test("finds the board's repo from ENTOMATICAL_REPO, else from the worktree path", () => {
  assert.equal(repoOf(env, "/elsewhere"), repo);
  assert.equal(repoOf({}, wt), repo);
  assert.equal(repoOf({}, path.join(wt, "src")), repo);
  assert.equal(repoOf({}, "/plain/folder"), undefined);
});

test("moves a new plan written in the worktree to the main checkout's workflows/", () => {
  const out = place(write("workflows/next.plan.json"), env, none, DAY);
  const target = path.join(repo, "workflows", `${DAY}-next.plan.json`);
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(out.hookSpecificOutput.updatedInput, { file_path: target, content: plan });
  assert.match(out.systemMessage, /Run a plan… lists it/);
  assert.match(out.hookSpecificOutput.additionalContext, /not in your worktree or branch/);
  // Content alone makes it a plan; a name without .json gets .plan.json.
  assert.equal(place(write(path.join(wt, "docs", "steps.json")), env, none, DAY).hookSpecificOutput.updatedInput.file_path, path.join(repo, "workflows", `${DAY}-steps.json`));
  assert.equal(place(write(path.join(wt, "draft"), "{}"), env, none), undefined);
  assert.equal(place(write(path.join(wt, "draft.plan")), env, none), undefined);
});

test("asks first when the session asks for edits", () => {
  assert.equal(place(write("p.plan.json", plan, { permission_mode: "default" }), env, none).hookSpecificOutput.permissionDecision, "ask");
  assert.equal(place(write("p.plan.json", plan, { permission_mode: "acceptEdits" }), env, none).hookSpecificOutput.permissionDecision, "allow");
});

test("a new plan's name gets the day in front; a name that already has a date keeps it", () => {
  assert.equal(dated("x.plan.json", DAY), `${DAY}-x.plan.json`);
  assert.equal(dated("2026-01-02-x.plan.json", DAY), "2026-01-02-x.plan.json");
  assert.equal(today(new Date(2026, 0, 5, 23, 59)), "2026-01-05"); // this machine's own day, months and days padded
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
  // Written in the worktree under a dated name: moved, name unchanged.
  assert.equal(place(write("workflows/2026-01-02-x.plan.json"), env, none, DAY).hookSpecificOutput.updatedInput.file_path, path.join(repo, "workflows", "2026-01-02-x.plan.json"));
  // Written straight into a folder the picker reads: stays in that folder, and only gets its date.
  const shared = place(write(path.join(repo, "workflows", "a.plan.json")), env, none, DAY);
  assert.equal(shared.hookSpecificOutput.updatedInput.file_path, path.join(repo, "workflows", `${DAY}-a.plan.json`));
  assert.match(shared.hookSpecificOutput.additionalContext, /commits it on main/);
  const priv = place(write(path.join(repo, ".entomatical", "workflows", "a.plan.json")), env, none, DAY);
  assert.equal(priv.hookSpecificOutput.updatedInput.file_path, path.join(repo, ".entomatical", "workflows", `${DAY}-a.plan.json`));
  assert.doesNotMatch(priv.hookSpecificOutput.additionalContext, /commits it/); // the private folder is git-ignored
  // The dated name already taken there: refused.
  const taken = path.join(repo, "workflows", `${DAY}-a.plan.json`);
  assert.equal(place(write(path.join(repo, "workflows", "a.plan.json")), env, (f) => f === taken, DAY).hookSpecificOutput.permissionDecision, "deny");
});

test("leaves dated writes in the picker's folders, edits of existing files and other tools alone", () => {
  assert.equal(place(write(path.join(repo, "workflows", `${DAY}-a.plan.json`)), env, none, DAY), undefined);
  assert.equal(place(write(path.join(repo, ".entomatical", "workflows", "2025-12-31-a.plan.json")), env, none, DAY), undefined);
  const undatedThere = path.join(repo, "workflows", "old.plan.json");
  assert.equal(place(write(undatedThere), env, (f) => f === undatedThere, DAY), undefined); // an existing undated plan is rewritten where it is
  const shipped = path.join(wt, "workflows", "example.plan.json");
  assert.equal(place(write(shipped), env, (f) => f === shipped), undefined);
  assert.equal(place({ ...write("a.plan.json"), tool_name: "Edit" }, env, none), undefined);
  assert.equal(place(write(path.join(wt, "notes.md"), "# hi"), env, none), undefined);
  assert.equal(place(write("/plain/a.plan.json", plan, { cwd: "/plain" }), {}, none), undefined); // not a card: no repo known
});

test("refuses a name already taken in workflows/", () => {
  const taken = path.join(repo, "workflows", `${DAY}-example.plan.json`);
  const out = place(write("workflows/example.plan.json"), env, (f) => f === taken, DAY);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /already exists/);
});

// A throwaway main checkout on branch main with one commit and a staged unrelated change.
function mainRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-planfolder-"));
  const g = (...args) => { const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.invalid"); g("config", "user.name", "Test"); g("config", "commit.gpgsign", "false");
  fs.mkdirSync(path.join(dir, "workflows"));
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  g("add", "."); g("commit", "-q", "-m", "start");
  fs.writeFileSync(path.join(dir, "README.md"), "staged\n"); g("add", "README.md");
  return { dir, g };
}

test("with no pending list (an older settings file), commits a plan file written in the main checkout's workflows/ at once, that file only", (t) => {
  const { dir, g } = mainRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "workflows", "next.plan.json");
  fs.writeFileSync(file, plan);
  const ev = { hook_event_name: "PostToolUse", tool_name: "Write", cwd: path.join(dir, ".entomatical", "wt", "abc123"), tool_input: { file_path: file, content: plan } };
  const out = settle(ev, { ENTOMATICAL_REPO: dir, ENTOMATICAL_TASK: "abc123" });
  // One visible line names where the file is, absolute, and the commit: Claude Code 2.1.319 does not show the PreToolUse systemMessage
  // of an allowed Write in the terminal (linux F98 check, 9 November 2026), but shows this PostToolUse one.
  assert.equal(out.systemMessage, `[plan folder] plan file saved to ${file} and committed on main (${g("rev-parse", "--short", "HEAD")}); not pushed`);
  assert.equal(g("log", "-1", "--format=%s"), "Plan file workflows/next.plan.json (card abc123)");
  assert.equal(g("show", "--name-only", "--format=", "HEAD"), "workflows/next.plan.json");
  assert.equal(g("diff", "--cached", "--name-only"), "README.md"); // the unrelated staged change stays staged
  // An edit is committed too; an unchanged file makes no commit and prints nothing.
  fs.writeFileSync(file, plan.replace('"x"', '"y"'));
  assert.match(settle({ ...ev, tool_name: "Edit", tool_input: { file_path: file } }, { ENTOMATICAL_REPO: dir }).systemMessage, /committed/);
  assert.equal(settle({ ...ev, tool_name: "Edit", tool_input: { file_path: file } }, { ENTOMATICAL_REPO: dir }), undefined);
  assert.equal(g("rev-list", "--count", "HEAD"), "3");
});

test("does not commit off main or during a merge, and says why", (t) => {
  const { dir, g } = mainRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "workflows", "a.plan.json");
  fs.writeFileSync(file, plan);
  g("checkout", "-q", "-b", "other");
  assert.match(commitPlan(dir, file).skipped, /on other, not main/);
  g("checkout", "-q", "main");
  fs.writeFileSync(path.join(dir, ".git", "MERGE_HEAD"), g("rev-parse", "HEAD") + "\n");
  assert.match(commitPlan(dir, file).skipped, /merge is under way/);
  const out = settle({ hook_event_name: "PostToolUse", tool_name: "Write", cwd: dir, tool_input: { file_path: file, content: plan } }, { ENTOMATICAL_REPO: dir });
  assert.equal(out.systemMessage, `[plan folder] plan file saved to ${file}, not committed: a merge is under way in the main checkout. Run a plan… lists it; the user commits it.`);
});

// F98 (the user, 14 November 2026): writes and edits in a turn are listed; the card's Stop commits each plan file once.
function turn(t) {
  const { dir, g } = mainRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pending = path.join(dir, ".git", "card.plan-pending"); // stands in for <board>/hooks/<card>.plan-pending
  const env = { ENTOMATICAL_REPO: dir, ENTOMATICAL_TASK: "abc123" };
  const cwd = path.join(dir, ".entomatical", "wt", "abc123");
  const post = (tool_name, file, content) => settle({ hook_event_name: "PostToolUse", tool_name, cwd, tool_input: { file_path: file, ...(content ? { content } : {}) } }, env, commitPlan, pending);
  const stop = () => finish({ hook_event_name: "Stop", cwd }, env, pending);
  return { dir, g, pending, post, stop };
}

test("F98 (a): three writes and edits of one plan file in a turn make no commit and one pending entry", (t) => {
  const { dir, g, pending, post } = turn(t);
  const file = path.join(dir, "workflows", "next.plan.json");
  fs.writeFileSync(file, plan);
  const out = post("Write", file, plan);
  assert.equal(out.systemMessage, `[plan folder] plan file saved to ${file}; it is committed on main when this turn ends (not pushed)`);
  assert.match(out.hookSpecificOutput.additionalContext, /Say this in your last reply\.$/);
  fs.writeFileSync(file, plan.replace('"x"', '"y"')); post("Edit", file);
  fs.writeFileSync(file, plan.replace('"x"', '"z"')); post("MultiEdit", file);
  assert.equal(g("rev-list", "--count", "HEAD"), "1");
  assert.deepEqual([...new Set(fs.readFileSync(pending, "utf8").split("\n").filter(Boolean))], [file]);
});

test("F98 (b): the Stop makes exactly one commit with the final content; a second Stop makes none", (t) => {
  const { dir, g, pending, post, stop } = turn(t);
  const file = path.join(dir, "workflows", "next.plan.json");
  fs.writeFileSync(file, plan); post("Write", file, plan);
  const last = plan.replace('"x"', '"final"');
  fs.writeFileSync(file, last); post("Edit", file);
  const out = stop();
  const sha = g("rev-parse", "--short", "HEAD");
  assert.equal(out.systemMessage, `[plan folder] ${file} committed on main (${sha}); not pushed`);
  assert.equal(out.decision, undefined); // never blocks the stop
  assert.equal(g("rev-list", "--count", "HEAD"), "2");
  assert.equal(g("log", "-1", "--format=%s"), "Plan file workflows/next.plan.json (card abc123)");
  assert.equal(g("show", "--name-only", "--format=", "HEAD"), "workflows/next.plan.json");
  assert.equal(g("show", "HEAD:workflows/next.plan.json"), last);
  assert.equal(g("diff", "--cached", "--name-only"), "README.md"); // the unrelated staged change stays staged
  assert.equal(fs.existsSync(pending), false);
  assert.equal(stop(), undefined);
  assert.equal(g("rev-list", "--count", "HEAD"), "2");
});

test("F98 (c): a pending plan file gone by the Stop (archived or deleted) is skipped without an error", (t) => {
  const { dir, g, pending, post, stop } = turn(t);
  const file = path.join(dir, "workflows", "gone.plan.json");
  fs.writeFileSync(file, plan); post("Write", file, plan);
  fs.rmSync(file);
  assert.equal(stop(), undefined);
  assert.equal(g("rev-list", "--count", "HEAD"), "1");
  assert.equal(fs.existsSync(pending), false);
});

test("F98 (d): a guard refusal at Stop (main checkout not on main) is reported and the file stays uncommitted", (t) => {
  const { dir, g, post, stop } = turn(t);
  const file = path.join(dir, "workflows", "a.plan.json");
  fs.writeFileSync(file, plan); post("Write", file, plan);
  g("checkout", "-q", "-b", "other");
  assert.equal(stop().systemMessage, `[plan folder] ${file} not committed: the main checkout is on other, not main. Run a plan… lists it; the user commits it.`);
  assert.equal(g("rev-list", "--count", "HEAD"), "1");
  assert.equal(g("ls-files", "--", "workflows/a.plan.json"), "");
});

test("F98: the script lists at PostToolUse and commits at Stop; Stop without a list prints nothing", (t) => {
  const { dir, g, pending } = turn(t);
  const script = path.join(__dirname, "..", "hook", "plan-folder.js");
  const run = (ev, args) => spawnSync(process.execPath, [script, ...args], { input: JSON.stringify(ev), encoding: "utf8", env: { ...process.env, ENTOMATICAL_REPO: dir } });
  const file = path.join(dir, "workflows", "s.plan.json");
  fs.writeFileSync(file, plan);
  assert.match(run({ hook_event_name: "PostToolUse", tool_name: "Write", cwd: dir, tool_input: { file_path: file, content: plan } }, [pending]).stdout, /when this turn ends/);
  assert.equal(g("rev-list", "--count", "HEAD"), "1");
  const out = run({ hook_event_name: "Stop", cwd: dir }, [pending]);
  assert.equal(out.status, 0);
  assert.match(JSON.parse(out.stdout).systemMessage, /committed on main/);
  assert.equal(g("rev-list", "--count", "HEAD"), "2");
  assert.equal(run({ hook_event_name: "Stop", cwd: dir }, []).stdout, "");
});

test("ignores files outside the main checkout's workflows/ and non-plan files", () => {
  const never = () => assert.fail("must not commit");
  const ev = (file_path, content) => ({ hook_event_name: "PostToolUse", tool_name: "Write", cwd: wt, tool_input: { file_path, content } });
  assert.equal(settle(ev(path.join(wt, "workflows", "a.plan.json"), plan), env, never), undefined);
  assert.equal(settle(ev(path.join(repo, "workflows", "checks.json"), "{}"), env, never), undefined);
  assert.equal(settle(ev(path.join(repo, ".entomatical", "workflows", "a.plan.json"), plan), env, never), undefined);
  assert.equal(settle({ ...ev(path.join(repo, "workflows", "a.plan.json"), plan), tool_name: "Bash" }, env, never), undefined);
});

test("the script prints the decision, and nothing on bad input", () => {
  const script = path.join(__dirname, "..", "hook", "plan-folder.js");
  const run = (input, extraEnv = {}) => spawnSync(process.execPath, [script], { input, encoding: "utf8", env: { ...process.env, ...extraEnv } });
  const before = today();
  const out = run(JSON.stringify(write(`fresh-${process.pid}.plan.json`)), env);
  assert.equal(out.status, 0);
  const fresh = [before, today()].map((d) => path.join(repo, "workflows", `${d}-fresh-${process.pid}.plan.json`)); // either day, should midnight pass
  assert.ok(fresh.includes(JSON.parse(out.stdout).hookSpecificOutput.updatedInput.file_path));
  const bad = run("not json", env);
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, "");
});
