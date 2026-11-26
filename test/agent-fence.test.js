const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fence, moved, sharedModules, READ_ONLY } = require("../hook/agent-fence.js");
const bash = (agent_type, command) => ({ tool_name: "Bash", agent_id: "a1", agent_type, tool_input: { command } });
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === "deny" ? out.hookSpecificOutput.permissionDecisionReason : undefined;
test("read-only set", () => assert.deepEqual([...READ_ONLY].sort(), ["ab-host-investigator", "ab-mapper", "ab-reviewer", "ab-test-gate"]));
test("nobody pushes", () => {
  assert.equal(denied(fence(bash("ab-fixer", "git push origin task/x"))), "[agent fence] ab-fixer never pushes; commit and report the commit.");
  assert.equal(denied(fence(bash("ab-parity-checker", "cd /w && git push"))), "[agent fence] ab-parity-checker never pushes; commit and report the commit.");
  assert.ok(denied(fence(bash("ab-fixer", "git -C /w push origin task/x"))), "git -C");
  assert.ok(denied(fence(bash("ab-fixer", "git --no-pager push"))), "git --no-pager");
  assert.ok(denied(fence(bash("ab-fixer", 'git -C "/home/example/Dev Stuff/entomatical" push origin x'))), "git -C quoted path");
  assert.equal(fence(bash("ab-fixer", "git commit -F /var/tmp/msg.txt")), undefined);
});
test("the PowerShell tool is fenced too", () => {
  const out = fence({ tool_name: "PowerShell", agent_id: "a1", agent_type: "ab-reviewer", tool_input: { command: "git push origin HEAD" } });
  assert.equal(denied(out), "[agent fence] ab-reviewer never pushes; commit and report the commit.");
});
test("reviewer may read git", () => {
  for (const c of ["git log --oneline -5", "git diff HEAD~1", "git show a5c0dac --stat", "git status", "git rev-parse --short HEAD", "git fetch -q"]) assert.equal(fence(bash("ab-reviewer", c)), undefined, c);
});
test("read-only agents may not change the repo", () => {
  assert.equal(denied(fence(bash("ab-reviewer", "git commit -am x"))), "[agent fence] ab-reviewer is read-only: no repo-changing git command (commit).");
  for (const c of ["git checkout main", "git merge origin/main", "git stash push -u -m t", "git reset --hard", "git rebase main", "git add -A", "git switch x", "git restore .", "git pull"]) assert.ok(denied(fence(bash("ab-mapper", c))), c);
});
test("read-only agents may not write state", () => {
  assert.equal(denied(fence(bash("ab-test-gate", "echo x > ~/.entomatical/tasks.json"))), "[agent fence] ab-test-gate is read-only: no writes to .entomatical state or .claude folders.");
  assert.ok(denied(fence(bash("ab-mapper", "sed -i s/a/b/ /home/example/.claude/settings.json"))));
  assert.ok(denied(fence(bash("ab-mapper", "rm -rf /home/example/Dev Stuff/entomatical/.entomatical/events"))));
  assert.equal(fence(bash("ab-mapper", "cat ~/.entomatical/tasks.json | head -5")), undefined);
  assert.equal(fence(bash("ab-reviewer", "cat .claude/agents/ab-reviewer.md > /var/tmp/x")), undefined, "a read copied to scratch");
  assert.equal(fence(bash("ab-reviewer", "cp .claude/agents/ab-reviewer.md /var/tmp/x")), undefined, "cp to scratch");
  for (const c of ["rm -rf ~/.entomatical/wt/", "rm -rf /h/.entomatical/wt/7e1838", "rm ~/.entomatical/wt/../tasks.json", "rm .entomatical/wt/x/f ~/.entomatical/tasks.json", "tee ~/.claude/x > /dev/null", "echo x >~/.claude/f", "sed -i.bak s/a/b/ .entomatical/tasks.json", "cp /var/tmp/x ~/.claude/agents/x.md"]) assert.ok(denied(fence(bash("ab-mapper", c))), c);
});
test("the workspace's temporary folders are scratch, not state; climbing out of them is", () => {
  assert.equal(fence(bash("ab-reviewer", "cp src/a.ts '/home/example/Dev Stuff/entomatical/.entomatical/tmp/7e1838/a.ts'")), undefined);
  assert.equal(fence(bash("ab-test-gate", "npm test > .entomatical/tmp/134e48/t.log")), undefined);
  for (const c of ["rm .entomatical/tmp/../tasks.json", "echo x > .entomatical/tmp/x/../../events/a.jsonl", "rm -rf .entomatical/tmp"]) assert.ok(denied(fence(bash("ab-mapper", c))), c);
});
test("worktree path is not state", () => {
  assert.equal(fence(bash("ab-test-gate", "cd '/home/example/Dev Stuff/entomatical/.entomatical/wt/134e48' && npm test > /var/tmp/t.log")), undefined);
  assert.equal(fence(bash("ab-parity-checker", "mkdir -p /home/example/Dev Stuff/entomatical/.entomatical/wt/7e1838/docs/evidence/x")), undefined);
  assert.equal(fence(bash("ab-test-gate", "tee /h/.entomatical/wt/134e48/x.log")), undefined);
});
test("npm ci on linked packages is refused in every session, and nowhere else", () => {
  const ps = (command, cwd = "/w", agent_type) => ({ tool_name: "PowerShell", cwd, agent_type, tool_input: { command } });
  const yes = () => true, no = () => false;
  for (const c of ["npm ci", "npm ci *> .scratch/ci.log", "npm.cmd ci", "npm --silent ci", "npm clean-install", "npm ic", "cd src; npm ci", "npm run build:wrapper && npm ci"]) {
    assert.match(denied(fence(ps(c), yes)), /^\[agent fence\] node_modules here is a link to the main checkout's packages/, c);
  }
  assert.ok(denied(fence({ tool_name: "Bash", cwd: "/w", tool_input: { command: "npm ci && npm test" } }, yes)), "the Bash tool");
  assert.ok(denied(fence(ps("npm ci", "/w", "ab-fixer"), yes)), "an ab-* sub-agent");
  assert.ok(denied(fence(ps("npm ci", "/w", "general-purpose"), yes)), "another sub-agent");
  for (const c of ["npm test", "npm install", "npm run build", "npm run ci", "echo npm ci", "git commit -m 'npm ci'"]) assert.equal(fence(ps(c), yes), undefined, c);
  assert.equal(fence(ps("npm ci"), no), undefined, "a folder of its own");
  assert.equal(fence({ tool_name: "PowerShell", tool_input: { command: "npm ci" } }, yes), undefined, "no cwd in the event: runs as asked");
  // The folder asked about is the one the command has moved to.
  const asked = [];
  fence(ps('Set-Location "/w/a b"; npm ci'), (d) => (asked.push(d), false));
  fence(ps("cd sub && npm ci"), (d) => (asked.push(d), false));
  assert.deepEqual(asked, [path.resolve("/w/a b"), path.resolve("/w/sub")]);
});
test("moved: the folder after a cd or Set-Location", () => {
  assert.equal(moved("/w", "npm ci"), "/w");
  assert.equal(moved("/w", "cd sub"), path.resolve("/w/sub"));
  assert.equal(moved("/w", "Set-Location -LiteralPath '/x/y z'"), path.resolve("/x/y z"));
  assert.equal(moved("/w", "cd /c/x"), path.resolve("/c/x"));
  // The Bash tool on Windows is Git Bash, where /c/… is drive C.
  if (process.platform === "win32") assert.equal(moved("C:\\w", 'cd "/c/Users/r/Dev Stuff/x"', true), "c:\\Users\\r\\Dev Stuff\\x");
});
test("sharedModules: a link is shared, a folder is not, and npm's folder is found from below", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fence-"));
  try {
    const main = path.join(root, "main", "node_modules"), wt = path.join(root, "wt"), own = path.join(root, "own");
    for (const d of [main, path.join(wt, "src", "deep"), path.join(own, "node_modules"), path.join(root, "bare", "src")]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(root, "bare", "package.json"), "{}");
    fs.symlinkSync(main, path.join(wt, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(sharedModules(wt), true);
    assert.equal(sharedModules(path.join(wt, "src", "deep")), true, "from a folder below");
    assert.equal(sharedModules(own), false, "a real folder");
    assert.equal(sharedModules(path.join(root, "bare", "src")), false, "no node_modules: npm ci fills a new folder");
    assert.ok(denied(fence({ tool_name: "PowerShell", cwd: wt, tool_input: { command: "npm ci" } })), "the real check");
    assert.equal(fence({ tool_name: "PowerShell", cwd: own, tool_input: { command: "npm ci" } }), undefined);
  } finally {
    try { fs.unlinkSync(path.join(root, "wt", "node_modules")); } catch { /* not made */ } // the link itself first
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("only Bash inside ab- agents is fenced", () => {
  assert.equal(fence({ tool_name: "Bash", tool_input: { command: "git push" } }), undefined);
  assert.equal(fence(bash("general-purpose", "git push")), undefined);
  assert.equal(fence({ tool_name: "Edit", agent_id: "a1", agent_type: "ab-reviewer", tool_input: { file_path: "x" } }), undefined);
});
