// tools/cutover-entomatical.js against a throwaway fixture tree in the test's own temp folder: a real git repository with two
// worktrees under the board folder, nested test boards, helper folders, an old build backup, hard-linked transcripts, real
// SQLite databases, a binary file, an oversized file and a settings file. Never runs against the real machine: every root
// is passed explicitly.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const tool = path.join(__dirname, "..", "tools", "cutover-entomatical.js");
const { run, rollback, OLD, NEW } = require(tool);

const UP = OLD.toUpperCase();
const NUP = NEW.toUpperCase();
const enc = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const read = (p) => fs.readFileSync(p, "utf8");
const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const BLOB = Buffer.concat([Buffer.from(`x/.${OLD}/y`), Buffer.from([0, 1, 2, 255])]);
const BIN = Buffer.concat([Buffer.from([0x89, 0, 0, 7]), Buffer.from(`/.${OLD}/wt/a ${OLD}.x`), Buffer.from([0, 0xff])]);
const quiet = () => {};
const J = JSON.stringify; // a Windows path holds backslashes, so a fixture line is valid JSON only with its values escaped
// Windows makes a symbolic link only with a privilege an ordinary account lacks; a junction needs none and reads back the same way.
const LINK = process.platform === "win32" ? "junction" : undefined;

function fixture() {
  const F = fs.mkdtempSync(path.join(os.tmpdir(), "cut-"));
  const home = path.join(F, "home");
  const ws = path.join(home, "Dev", "ws");
  const board = path.join(ws, `.${OLD}`);
  const hb = path.join(home, `.${OLD}`);
  fs.mkdirSync(ws, { recursive: true });
  git("init", "-q", ws);
  write(path.join(ws, "README.md"), "hi\n");
  git("-C", ws, "add", "README.md");
  git("-C", ws, "commit", "-q", "-m", "init");
  for (const n of ["a", "b"]) git("-C", ws, "worktree", "add", "-q", "-b", n, path.join(board, "wt", n));
  fs.symlinkSync(path.join(board, "hooks"), path.join(board, "wt", "a", "hooks-link"), LINK);
  write(path.join(board, "wt", "a", `.${OLD}`, "keep.txt"), `${board}/wt/a\n`); // inside a worktree: left alone
  write(path.join(board, "tasks.json"), JSON.stringify({ tasks: ["a", "b"].map((id) => ({ id, worktree: path.join(board, "wt", id) })) }, null, 2));
  write(path.join(board, "hooks", "settings.json"), JSON.stringify({ hooks: { Stop: [{ command: `node ${hb}/hook/stop.js` }] } }));
  fs.writeFileSync(path.join(board, "hooks", "blob.bin"), BIN);
  write(path.join(board, "reports", "x.json"), JSON.stringify({ wt: path.join(board, "wt", "a") }));
  write(path.join(board, "big.log"), `${board}/wt/a\n`);
  fs.truncateSync(path.join(board, "big.log"), 21 * 1024 * 1024);
  const nested = path.join(board, "checks", "ship", "tmp", `${OLD}-tool-abc`, `.${OLD}`);
  write(path.join(nested, "tasks.json"), JSON.stringify({ wt: path.join(nested, "wt", "q") }));
  write(path.join(board, "archive", `${OLD}-test-xyz`, "f.txt"), "plain\n");
  write(path.join(board, "tmp", `${UP}-TEMP-ROOT`), `${UP}-TEMP-ROOT marks ${board}/tmp\n`);
  write(path.join(board, "tmp", "card1", "note.txt"), `${board}/wt/a\n`);
  write(path.join(ws, `.${OLD}-speech`, "tasks.json"), JSON.stringify({ wt: path.join(ws, `.${OLD}-speech`, "wt", "s") }));
  write(path.join(hb, `${OLD}-claude`), `#!/bin/sh\nexec "${hb}/inner-wrapper" "$@"\n`);
  write(path.join(hb, `${OLD}-claude.bak-1`), "#!/bin/sh\n");
  write(path.join(hb, "inner-wrapper"), `#!/bin/sh\n${UP}_HOOK=1 exec claude "$@"\n`);
  write(path.join(hb, "operator-token"), `${hb}/never-read\n`);
  write(path.join(hb, "helper-cwd", `${OLD}-helper-abc123`, "note.txt"), "x\n");
  write(path.join(hb, "usage", `${OLD}-codex-home-xyz.json`), "{}\n");
  const build = path.join(hb, "extension-backups", `${OLD}-0.8.9-20261105-abc`);
  write(path.join(build, "package.json"), JSON.stringify({ name: OLD, publisher: "example-publisher" }));
  write(path.join(build, "wrapper", `${OLD}-claude.js`), `// ~/.${OLD}/x and process.env.${UP}_X\n`);
  write(path.join(hb, "speech", "runtime", "readme.txt"), `${hb}/speech\n`);
  const projA = path.join(home, ".claude", "projects", `${enc(ws)}--${OLD}-wt-a`);
  const projB = path.join(home, ".claude-accounts", "acc", "projects", `${enc(ws)}--${OLD}-wt-a`);
  const projH = path.join(home, ".claude", "projects", `${enc(home)}--${OLD}-helper-cwd-${OLD}-helper-abc123`);
  write(path.join(projA, "t1.jsonl"), `{"cwd":"${board}/wt/a","text":"${OLD}"}\n`);
  fs.mkdirSync(projB, { recursive: true });
  fs.linkSync(path.join(projA, "t1.jsonl"), path.join(projB, "t1.jsonl"));
  write(path.join(projH, "t2.jsonl"), `{"cwd":"${hb}/helper-cwd/${OLD}-helper-abc123"}\n`);
  write(path.join(hb, "ledger", "sessions", "s1.jsonl"), `{"transcript":"${projA}/t1.jsonl","offset":12,"cwd":"${board}/wt/a"}\n`);
  write(path.join(home, ".claude", "history.jsonl"), [
    `{"display":${J(`see ${board}/wt/a`)},"project":${J(`${board}/wt/a`)},"timestamp":1}`,
    `not json ${board}/wt/a`,
    `{"display":"x", "project": ${J(ws)}}`, ""].join("\n"));
  const claudeJson = JSON.stringify({ numStartups: 3, projects: { [path.join(board, "wt", "a")]: { allowedTools: [] }, [ws]: {} } }, null, 2) + "\n";
  write(path.join(home, ".claude.json"), claudeJson);
  write(path.join(home, ".claude-accounts", "acc", ".claude.json"), claudeJson);
  const user = path.join(home, ".config", "VSCodium", "User");
  write(path.join(user, "settings.json"), `// my settings\n{\n  "${OLD}.autoStart": true,\n  "claudeCode.claudeProcessWrapper": ${JSON.stringify(`${hb}/${OLD}-claude`)},\n  "terminal.integrated.env.linux": { "${UP}_TRACE": "1" },\n  "editor.fontSize": 13\n}\n`);
  write(path.join(user, "keybindings.json"), JSON.stringify([{ key: "ctrl+k b", command: `${OLD}.openBoard`, when: `view == ${OLD}.board` }]));
  write(path.join(user, "profiles", "p1", "settings.json"), `{ "${OLD}.quietStartup": true }\n`);
  fs.mkdirSync(path.join(user, "globalStorage"), { recursive: true });
  const vdb = new DatabaseSync(path.join(user, "globalStorage", "state.vscdb"));
  vdb.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  const put = vdb.prepare("INSERT INTO ItemTable VALUES (?, ?)");
  put.run(`example-publisher.${OLD}`, JSON.stringify({ [`${OLD}.actionPicks`]: [1], panelDeclined: true }));
  put.run(`workbench.view.extension.${OLD}.state.hidden`, JSON.stringify([{ id: `${OLD}.board`, isHidden: false }]));
  put.run(`workbench.view.extension.${OLD}.blob`, BLOB);
  put.run("other.key", BLOB);
  vdb.close();
  fs.mkdirSync(path.join(home, ".codex"));
  const cdb = new DatabaseSync(path.join(home, ".codex", "state_5.sqlite"));
  cdb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0)");
  cdb.prepare("INSERT INTO threads (id, rollout_path, cwd) VALUES (?, ?, ?)").run("t1", path.join(home, ".codex", "sessions", "r.jsonl"), path.join(board, "wt", "a"));
  cdb.prepare("INSERT INTO threads (id, rollout_path, cwd) VALUES (?, ?, ?)").run("t2", path.join(home, ".codex", "sessions", "r2.jsonl"), ws);
  cdb.close();
  write(path.join(home, ".codex", "sessions", "r.jsonl"), `{"cwd":"${board}/wt/a"}\n`);
  write(path.join(home, ".grok", "settings.json"), JSON.stringify({ trustedWorkspaces: [path.join(board, "wt", "a")] }));
  write(path.join(home, ".grok", "auth.json"), JSON.stringify({ note: path.join(board, "wt", "a") }));
  write(path.join(home, "notes.md"), `Wrapper: ~/.${OLD}/${OLD}-claude, env ${UP}_X, the word ${OLD} stays.\n`);
  const args = { home, workspaces: [ws], vscodiumUser: user, text: [path.join(home, "notes.md")], state: path.join(F, "state"), listProcesses: () => [], log: quiet };
  return { F, home, ws, board, hb, build, projA, projB, projH, user, args, nb: path.join(ws, `.${NEW}`), nh: path.join(home, `.${NEW}`) };
}

function snapshot(root, times) {
  const out = [];
  const visit = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      let line = path.relative(root, p);
      if (st.isSymbolicLink()) line += ` L ${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) line += " D";
      else line += ` F ${st.size} ${crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex")}`;
      if (times) line += ` ${st.mtimeMs}`;
      out.push(line);
      if (st.isDirectory()) visit(p);
    }
  };
  visit(root);
  return out;
}
const journal = (file) => read(file).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const groupCounts = (audit, F) => [...audit.groups].map(([reason, paths]) => `${paths.length} ${reason.split(F).join("F")}`).sort();

test("dry run, through the command line, changes nothing", () => {
  const fx = fixture();
  const before = snapshot(fx.F, true);
  const r = spawnSync(process.execPath, [tool, "--home", fx.home, "--vscodium-user", fx.user, "--workspace", fx.ws, "--text", path.join(fx.home, "notes.md"), "--state", fx.args.state, "--force-preflight"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRY RUN/);
  assert.match(r.stdout, new RegExp(`would rename .*\\.${OLD} -> .*\\.${NEW}`));
  assert.match(r.stdout, /would update .*state\.vscdb/);
  assert.match(r.stdout, new RegExp(`--uninstall-extension example-publisher\\.${OLD}`));
  assert.deepEqual(snapshot(fx.F, true), before);
  assert.equal(fs.existsSync(fx.args.state), false);
});

test("--summary prints only counts per step and the grouped leftovers", () => {
  const fx = fixture();
  const r = spawnSync(process.execPath, [tool, "--summary", "--home", fx.home, "--vscodium-user", fx.user, "--workspace", fx.ws, "--state", fx.args.state, "--force-preflight"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^actions per step: home folder \d+, workspaces \d+, VSCodium \d+, Claude \d+, Codex \d+, Antigravity and Grok \d+, text files 0; total \d+ planned$/m);
  assert.match(r.stdout, /^audit: the plan fixes \d+; \d+ would be left$/m);
  assert.match(r.stdout, /^ {2}1 {2}old build backups: contents left as they were: /m);
  assert.doesNotMatch(r.stdout, /would (rename|rewrite|update)|codium/);
});

test("the dry-run audit predicts what --apply leaves", () => {
  const a = fixture();
  const dry = run(a.args);
  const b = fixture();
  const applied = run({ ...b.args, apply: true });
  assert.ok(dry.audit.fixed > 20, String(dry.audit.fixed));
  assert.deepEqual(groupCounts(dry.audit, a.F), groupCounts(applied.audit, b.F));
  assert.equal(dry.actions, applied.actions);
  // what is left is a short, named list: the old build, the folder inside a worktree, and nothing the plan touches
  assert.deepEqual(groupCounts(applied.audit, b.F), ["1 old build backups: contents left as they were", "1 worktree files left as they are (each branch's own files; merging main renames them)"]);
  assert.ok(applied.audit.skipped.big >= 1 && applied.audit.skipped.speech === 1);
});

test("--apply moves everything and journals each action", () => {
  const fx = fixture();
  const transcript = fs.readFileSync(path.join(fx.projA, "t1.jsonl"));
  const buildFiles = snapshot(fx.build, false);
  const lines = [];
  const r = run({ ...fx.args, apply: true, log: (l) => lines.push(l) });
  assert.equal(r.refused, null);
  assert.deepEqual(r.problems, []);
  // home folder: wrapper, helpers, usage file, old build (folder name only), speech left alone, credentials not read
  assert.ok(!fs.existsSync(fx.hb) && fs.existsSync(path.join(fx.nh, `${NEW}-claude`)) && fs.existsSync(path.join(fx.nh, `${NEW}-claude.bak-1`)));
  assert.equal(read(path.join(fx.nh, `${NEW}-claude`)), `#!/bin/sh\nexec "${fx.nh}/inner-wrapper" "$@"\n`);
  assert.match(read(path.join(fx.nh, "inner-wrapper")), new RegExp(`^#!/bin/sh\\n${NUP}_HOOK=1`));
  assert.equal(read(path.join(fx.nh, "operator-token")), `${fx.hb}/never-read\n`);
  assert.ok(fs.existsSync(path.join(fx.nh, "helper-cwd", `${NEW}-helper-abc123`, "note.txt")));
  assert.ok(fs.existsSync(path.join(fx.nh, "usage", `${NEW}-codex-home-xyz.json`)));
  const newBuild = path.join(fx.nh, "extension-backups", `${NEW}-0.8.9-20261105-abc`);
  assert.deepEqual(snapshot(newBuild, false), buildFiles);
  assert.equal(read(path.join(fx.nh, "speech", "runtime", "readme.txt")), `${fx.hb}/speech\n`);
  // workspace board: marker, nested test board, tool and test folders, every text file, oversized file skipped
  assert.ok(!fs.existsSync(fx.board) && fs.existsSync(fx.nb));
  assert.ok(fs.existsSync(path.join(fx.nb, "tmp", `${NUP}-TEMP-ROOT`)));
  assert.equal(read(path.join(fx.nb, "tmp", "card1", "note.txt")), `${fx.board}/wt/a\n`, "tmp contents are not rewritten");
  const nestedNew = path.join(fx.nb, "checks", "ship", "tmp", `${NEW}-tool-abc`, `.${NEW}`);
  assert.deepEqual(JSON.parse(read(path.join(nestedNew, "tasks.json"))), { wt: path.join(nestedNew, "wt", "q") });
  assert.ok(fs.existsSync(path.join(fx.nb, "archive", `${NEW}-test-xyz`, "f.txt")));
  assert.deepEqual(JSON.parse(read(path.join(fx.nb, "reports", "x.json"))), { wt: path.join(fx.nb, "wt", "a") });
  assert.ok(read(path.join(fx.nb, "big.log")).startsWith(`${fx.board}/wt/a\n`));
  assert.ok(lines.includes(`skip (over 20 MB): ${path.join(fx.nb, "big.log")}`), lines.join("\n"));
  assert.equal(read(path.join(fx.nb, "wt", "a", `.${OLD}`, "keep.txt")), `${fx.board}/wt/a\n`, "worktree contents are left alone");
  assert.deepEqual(JSON.parse(read(path.join(fx.ws, `.${NEW}-speech`, "tasks.json"))), { wt: path.join(fx.ws, `.${NEW}-speech`, "wt", "s") });
  // git worktrees
  const list = git("-C", fx.ws, "worktree", "list", "--porcelain");
  assert.doesNotMatch(list, /prunable/);
  for (const n of ["a", "b"]) {
    // git prints forward slashes on Windows too, and the drive letter in its own case
    assert.ok(list.toLowerCase().includes(`worktree ${path.join(fx.nb, "wt", n).split(path.sep).join("/")}\n`.toLowerCase()), list);
    git("-C", path.join(fx.nb, "wt", n), "status", "--porcelain");
  }
  assert.equal(fs.readlinkSync(path.join(fx.nb, "wt", "a", "hooks-link")), path.join(fx.nb, "hooks"));
  for (const t of JSON.parse(read(path.join(fx.nb, "tasks.json"))).tasks) assert.ok(fs.statSync(t.worktree).isDirectory(), t.worktree);
  assert.equal(JSON.parse(read(path.join(fx.nb, "hooks", "settings.json"))).hooks.Stop[0].command, `node ${fx.nh}/hook/stop.js`); // parsed: a Windows path is escaped in the file
  assert.deepEqual(fs.readFileSync(path.join(fx.nb, "hooks", "blob.bin")), BIN);
  // VSCodium settings
  const settingsText = read(path.join(fx.user, "settings.json"));
  assert.match(settingsText, /^\/\/ my settings\n/);
  const settings = JSON.parse(settingsText.replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(settings[`${NEW}.autoStart`], true);
  assert.equal(settings[`${OLD}.autoStart`], undefined);
  assert.equal(settings["claudeCode.claudeProcessWrapper"], `${fx.nh}/${NEW}-claude`);
  assert.deepEqual(settings["terminal.integrated.env.linux"], { [`${NUP}_TRACE`]: "1" });
  assert.deepEqual(JSON.parse(read(path.join(fx.user, "keybindings.json"))), [{ key: "ctrl+k b", command: `${NEW}.openBoard`, when: `view == ${NEW}.board` }]);
  assert.ok(read(path.join(fx.user, "profiles", "p1", "settings.json")).includes(`"${NEW}.quietStartup"`));
  // state.vscdb
  const vdb = new DatabaseSync(path.join(fx.user, "globalStorage", "state.vscdb"), { readOnly: true });
  const rows = Object.fromEntries(vdb.prepare("SELECT key, value FROM ItemTable").all().map((x) => [x.key, x.value]));
  vdb.close();
  assert.deepEqual(Object.keys(rows).sort(), ["other.key", `example-publisher.${NEW}`, `workbench.view.extension.${NEW}.blob`, `workbench.view.extension.${NEW}.state.hidden`].sort());
  assert.deepEqual(JSON.parse(rows[`example-publisher.${NEW}`]), { [`${NEW}.actionPicks`]: [1], panelDeclined: true });
  assert.deepEqual(JSON.parse(rows[`workbench.view.extension.${NEW}.state.hidden`]), [{ id: `${NEW}.board`, isHidden: false }]);
  assert.ok(Buffer.from(rows[`workbench.view.extension.${NEW}.blob`]).equals(BLOB));
  assert.ok(Buffer.from(rows["other.key"]).equals(BLOB));
  // Codex
  const cdb = new DatabaseSync(path.join(fx.home, ".codex", "state_5.sqlite"), { readOnly: true });
  assert.deepEqual(cdb.prepare("SELECT id, cwd FROM threads ORDER BY id").all().map((x) => [x.id, x.cwd]), [["t1", path.join(fx.nb, "wt", "a")], ["t2", fx.ws]]);
  cdb.close();
  assert.equal(read(path.join(fx.home, ".codex", "sessions", "r.jsonl")), `{"cwd":"${fx.board}/wt/a"}\n`);
  // Claude: folders renamed (worktree and helper), transcripts byte-identical and still one inode
  const newA = path.join(fx.home, ".claude", "projects", `${enc(fx.ws)}--${NEW}-wt-a`, "t1.jsonl");
  const newB = path.join(fx.home, ".claude-accounts", "acc", "projects", `${enc(fx.ws)}--${NEW}-wt-a`, "t1.jsonl");
  assert.ok(fs.readFileSync(newA).equals(transcript) && fs.readFileSync(newB).equals(transcript));
  assert.equal(fs.statSync(newA).ino, fs.statSync(newB).ino);
  assert.equal(fs.statSync(newA).nlink, 2);
  assert.ok(fs.existsSync(path.join(fx.home, ".claude", "projects", `${enc(fx.home)}--${NEW}-helper-cwd-${NEW}-helper-abc123`, "t2.jsonl")));
  for (const cj of [path.join(fx.home, ".claude.json"), path.join(fx.home, ".claude-accounts", "acc", ".claude.json")]) {
    const text = read(cj);
    assert.deepEqual(Object.keys(JSON.parse(text).projects), [path.join(fx.nb, "wt", "a"), fx.ws]);
    assert.match(text, /^\{\n {2}"numStartups": 3,/);
  }
  assert.equal(read(path.join(fx.home, ".claude", "history.jsonl")), [
    `{"display":${J(`see ${fx.board}/wt/a`)},"project":${J(`${fx.nb}/wt/a`)},"timestamp":1}`,
    `not json ${fx.board}/wt/a`,
    `{"display":"x", "project": ${J(fx.ws)}}`, ""].join("\n"));
  // ledger: transcript folder names and cwd fields; the byte offset stays
  assert.equal(read(path.join(fx.nh, "ledger", "sessions", "s1.jsonl")), `{"transcript":"${path.dirname(newA)}/t1.jsonl","offset":12,"cwd":"${fx.nb}/wt/a"}\n`);
  // Grok, text file
  assert.deepEqual(JSON.parse(read(path.join(fx.home, ".grok", "settings.json"))).trustedWorkspaces, [path.join(fx.nb, "wt", "a")]);
  assert.equal(JSON.parse(read(path.join(fx.home, ".grok", "auth.json"))).note, path.join(fx.board, "wt", "a"), "credential files are not touched");
  assert.equal(read(path.join(fx.home, "notes.md")), `Wrapper: ~/.${NEW}/${NEW}-claude, env ${NUP}_X, the word ${OLD} stays.\n`);
  // journal: one line per action, each kind present
  const acts = journal(r.journal);
  assert.equal(acts.length, r.actions);
  const renames = acts.filter((a) => a.op === "rename").map((a) => a.to);
  for (const to of [fx.nh, path.join(fx.nh, `${NEW}-claude`), fx.nb, path.join(fx.nb, "tmp", `${NUP}-TEMP-ROOT`), path.dirname(newA), path.dirname(newB), newBuild,
    path.join(fx.nh, "helper-cwd", `${NEW}-helper-abc123`), path.join(fx.ws, `.${NEW}-speech`)]) assert.ok(renames.includes(to), to);
  const nestedRenames = renames.filter((p) => p.includes(`${path.sep}checks${path.sep}`));
  assert.ok(nestedRenames[0].endsWith(`.${NEW}`) && nestedRenames[1].endsWith(`${NEW}-tool-abc`), "deepest first");
  const writes = acts.filter((a) => a.op === "write").map((a) => a.path);
  for (const p of [path.join(fx.nb, "tasks.json"), path.join(fx.ws, ".git", "worktrees", "a", "gitdir"), path.join(fx.user, "settings.json"),
    path.join(fx.home, ".claude.json"), path.join(fx.home, ".claude", "history.jsonl"), path.join(fx.nh, "ledger", "sessions", "s1.jsonl"), path.join(fx.home, "notes.md")]) assert.ok(writes.includes(p), p);
  assert.deepEqual(acts.filter((a) => a.op === "db").map((a) => path.basename(a.path)).sort(), ["state.vscdb", "state_5.sqlite"]);
  assert.deepEqual(acts.filter((a) => a.op === "link").map((a) => a.path), [path.join(fx.nb, "wt", "a", "hooks-link")]);
});

test("--drop-old-builds deletes the old build backups, and rollback says it cannot restore them", () => {
  const fx = fixture();
  const r = run({ ...fx.args, apply: true, dropOldBuilds: true });
  assert.equal(fs.readdirSync(path.join(fx.nh, "extension-backups")).length, 0);
  assert.ok(!r.audit.groups.has("old build backups: contents left as they were"));
  const drop = journal(r.journal).filter((a) => a.op === "drop");
  assert.deepEqual(drop.map((a) => a.path), [fx.build.replace(fx.hb, fx.nh)]);
  const lines = [];
  assert.equal(rollback(r.journal, (l) => lines.push(l)), 0);
  assert.ok(lines.some((l) => l.startsWith("cannot undo:")), lines.join("\n"));
  assert.ok(fs.existsSync(fx.hb) && !fs.existsSync(fx.build));
});

test("a second --apply does nothing", () => {
  const fx = fixture();
  run({ ...fx.args, apply: true });
  const before = snapshot(fx.F, true);
  const r = run({ ...fx.args, apply: true });
  assert.equal(r.actions, 0);
  assert.equal(r.journal, undefined);
  assert.deepEqual(snapshot(fx.F, true), before);
});

test("a failed apply journals completed moves and rollback preserves an occupied original path", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.F, { recursive: true, force: true }));
  const before = snapshot(fx.home, false);
  const lines = [];
  const rename = fs.renameSync;
  let moves = 0;
  const fault = t.mock.method(fs, "renameSync", (from, to) => {
    if (++moves === 2) throw new Error("fixture interrupted the second move");
    return rename(from, to);
  });
  assert.throws(() => run({ ...fx.args, apply: true, log: (line) => lines.push(line) }), /fixture interrupted the second move/);
  fault.mock.restore();
  const instructions = lines.find((line) => line.startsWith("undo what was done:"));
  assert.ok(instructions, "the interrupted apply prints its rollback command");
  const match = /--rollback "(.+)"$/.exec(instructions);
  assert.ok(match, instructions);
  const file = match[1];
  assert.deepEqual(journal(file).map(({ op, from, to }) => [op, from, to]), [["rename", fx.hb, fx.nh]]);
  assert.notDeepEqual(snapshot(fx.home, false), before);

  const occupant = path.join(fx.hb, "new-file");
  write(occupant, "created after the interrupted move");
  const messages = [];
  assert.equal(rollback(file, (line) => messages.push(line)), 1);
  assert.ok(messages.includes(`skip: cannot move ${fx.nh} back to ${fx.hb}`));
  assert.equal(read(occupant), "created after the interrupted move");
  assert.ok(fs.existsSync(fx.nh));
  fs.unlinkSync(occupant);
  fs.rmdirSync(fx.hb);
  assert.equal(rollback(file, quiet), 0);
  assert.deepEqual(snapshot(fx.home, false), before);
});

test("--rollback restores the original tree", () => {
  const fx = fixture();
  const before = snapshot(fx.home, false);
  const r = run({ ...fx.args, apply: true });
  assert.notDeepEqual(snapshot(fx.home, false), before);
  assert.equal(rollback(r.journal, quiet), 0);
  assert.deepEqual(snapshot(fx.home, false), before);
  assert.doesNotMatch(git("-C", fx.ws, "worktree", "list", "--porcelain"), /prunable/);
});

test("preflight refuses when an old and a new folder both exist", () => {
  const fx = fixture();
  fs.mkdirSync(fx.nb);
  const before = snapshot(fx.F, true);
  const r = run({ ...fx.args, apply: true });
  assert.equal(r.actions, 0);
  assert.ok(r.refused.some((x) => x.includes(fx.board) && x.includes(fx.nb)), r.refused.join("\n"));
  assert.deepEqual(snapshot(fx.F, true), before);
});

test("JSONC preflight refuses both key orders in each editor settings location before any write", () => {
  const fx = fixture();
  const oldKey = `${OLD}.notifications`;
  const newKey = `${NEW}.notifications`;
  const cases = [
    [path.join(fx.user, "settings.json"), "", ""],
    [path.join(fx.user, "profiles", "p1", "settings.json"), '"[javascript]": {', "}"],
    [path.join(fx.ws, ".vscode", "settings.json"), '"[typescript][javascript]": {', "}"],
    [path.join(fx.ws, "project.code-workspace"), '"settings": { "[json]": {', "}}"],
  ];
  for (const [file, prefix, suffix] of cases) {
    for (const keys of [[oldKey, newKey], [newKey, oldKey]]) {
      // The destination has an escaped period and a comment between its key and colon.
      const pair = keys.map((k) => k === newKey ? `"${NEW}\\u002enotifications" /* : } */ : false` : `"${k}": true`);
      write(file, `{ ${prefix} "note": "private fixture value", ${pair.join(", ")}, ${suffix} }\n`);
      const before = snapshot(fx.F, true);
      const lines = [];
      const r = run({ ...fx.args, apply: true, forcePreflight: keys[0] === newKey, log: (s) => lines.push(s) });
      assert.equal(r.actions, 0, file);
      assert.equal(r.refused.length, 1);
      for (const detail of [file, oldKey, newKey]) assert.ok(r.refused[0].includes(detail), detail);
      assert.doesNotMatch(lines.join("\n"), /private fixture value/);
      assert.deepEqual(snapshot(fx.F, true), before);
    }
    fs.unlinkSync(file);
  }
});

test("JSONC migrates a lone setting once, keeps separate scopes and trivia, and rolls back exact bytes", () => {
  const fx = fixture();
  const oldKey = `${OLD}.notifications`;
  const newKey = `${NEW}.notifications`;
  const file = path.join(fx.ws, "project.code-workspace");
  const document = (key) => [
    "\uFEFF{", `  // "${oldKey}": false`,
    `  "settings": { "${newKey}": false,`,
    `    "[json]": { /* "${newKey}": true */ "${key}": true, },`,
    `    "[javascript]": { "${newKey}": false },`,
    `    "example.text": ${J(`He said "${oldKey}": { // }`)},`,
    `    "example.note": "See ~/.${OLD}/example and ${oldKey} in the guide",`,
    '  }, "folders": [{ "path": "." }],', "}", "",
  ].join("\r\n");
  write(file, document(oldKey));
  // An explicit --text selecting the same file must use the same settings rules.
  const args = { ...fx.args, text: [file] };
  const before = snapshot(fx.home, false);
  const r = run({ ...args, apply: true });
  assert.equal(r.refused, null);
  assert.deepEqual(r.problems, []);
  assert.equal(read(file), document(newKey));
  assert.equal(journal(r.journal).filter((a) => a.path === file).length, 1);
  assert.ok(!r.audit.left.some((hit) => hit.path === file));
  assert.equal(run({ ...args, apply: true }).actions, 0);
  assert.equal(rollback(r.journal, quiet), 0);
  assert.deepEqual(snapshot(fx.home, false), before);
});

test("the CLI reports all conflicting settings files without creating a journal", () => {
  const fx = fixture();
  const profile = path.join(fx.user, "settings.json");
  const workspace = path.join(fx.ws, "project.code-workspace");
  const pair = `{ "${OLD}.notifications": "private old value", "${NEW}.notifications": "private new value" }`;
  write(profile, pair);
  write(workspace, `{ "settings": { "[json]": ${pair} } }`);
  const before = snapshot(fx.F, true);
  const args = [tool, "--home", fx.home, "--vscodium-user", fx.user, "--workspace", fx.ws, "--state", fx.args.state, "--force-preflight"];
  for (const flags of [[], ["--apply"]]) {
    const r = spawnSync(process.execPath, [...args, ...flags], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr);
    const reasons = r.stdout.split("\n").filter((line) => line.includes("conflicting editor keys"));
    assert.equal(reasons.length, 2);
    for (const file of [profile, workspace]) {
      assert.ok(reasons.some((s) => s.includes(file) && s.includes(`${OLD}.notifications`) && s.includes(`${NEW}.notifications`)));
    }
    assert.doesNotMatch(r.stdout + r.stderr, /private (?:old|new) value/);
    assert.deepEqual(snapshot(fx.F, true), before);
  }
});

test("normal cutover preserves filename patterns and shell tasks while migrating real keybindings", () => {
  const fx = fixture();
  const profile = path.join(fx.user, "settings.json");
  const workspace = path.join(fx.ws, "tasks.code-workspace");
  const bindings = path.join(fx.user, "keybindings.json");
  const patterns = { [`${OLD}.fixture`]: "plaintext", [`${NEW}.fixture`]: "json" };
  const settings = J({ "files.associations": patterns, "[json]": { "files.associations": patterns } });
  const task = J({ tasks: { version: "2.0.0", tasks: [{ type: "shell", command: `echo ${OLD}.notifications` }] } });
  const shortcuts = (id) => J([
    { key: "ctrl+b", command: `${id}.openBoard`, when: `view == ${id}.board`, args: { command: `echo ${OLD}.notifications` } },
    { key: "ctrl+k", command: `-${id}.openBoard` },
  ]);
  write(profile, settings);
  write(workspace, task);
  write(bindings, shortcuts(OLD));
  const before = snapshot(fx.home, false);
  const r = run({ ...fx.args, apply: true });
  assert.equal(r.refused, null);
  assert.deepEqual(r.problems, []);
  assert.equal(read(profile), settings);
  assert.equal(read(workspace), task);
  assert.equal(read(bindings), shortcuts(NEW));
  assert.ok(!r.audit.left.some((hit) => [profile, workspace, bindings].includes(hit.path)));
  assert.equal(rollback(r.journal, quiet), 0);
  assert.deepEqual(snapshot(fx.home, false), before);
});

for (const kind of ["env", "profiles"]) {
  test(`terminal.integrated.${kind} follows moved targets on apply, audits clean and rolls back`, () => {
    const fx = fixture();
    const isEnv = kind === "env";
    const file = isEnv ? path.join(fx.user, "settings.json") : path.join(fx.ws, "terminal.code-workspace");
    const root = isEnv ? fx.ws : fx.home;
    const name = isEnv ? "events.jsonl" : "shell";
    const target = (id) => path.join(root, `.${id}`, "bin with spaces", `${id}-${name}`);
    write(target(OLD), "fixture target\n");
    const profileName = `${OLD}.shell`;
    const literal = `echo ${target(OLD)} and ${OLD}.notifications`;
    const platforms = ["linux", "osx", "windows"];
    function config(id) {
      const settings = { "files.associations": { [profileName]: "text", [`${NEW}.shell`]: "json" } };
      for (const os of platforms) {
        const relative = path.relative(root, target(id));
        const base = isEnv ? "${workspaceFolder}" : "${env:USERPROFILE}";
        let value = target(id);
        if (os === "osx") value = (isEnv ? "${workspaceFolder}/" : "~/") + relative.split(path.sep).join("/");
        if (os === "windows") value = base + "\\" + relative.split(path.sep).join("\\");
        const env = { [`${id.toUpperCase()}_EVENTS`]: value, [`${NUP}_LEDGER_DIR`]: value, MESSAGE: literal, FLAG: null };
        settings[`terminal.integrated.${kind}.${os}`] = isEnv ? env : {
          [profileName]: { path: os === "windows" ? ["unrelated.exe", value] : value, env, args: ["-c", literal] },
        };
        if (!isEnv) settings[`terminal.integrated.automationProfile.${os}`] = { path: value, args: [literal] };
      }
      return isEnv ? settings : { settings, tasks: { tasks: [{ type: "shell", command: literal }] } };
    }
    write(file, J(config(OLD)));
    const before = snapshot(fx.home, false);
    const r = run({ ...fx.args, apply: true });
    assert.equal(r.refused, null);
    assert.deepEqual(r.problems, []);
    assert.ok(!r.audit.left.some((hit) => hit.path === file));
    assert.equal(read(target(NEW)), "fixture target\n");
    assert.ok(!fs.existsSync(target(OLD)));
    const applied = JSON.parse(read(file));
    for (const os of platforms) {
      const entry = (isEnv ? applied : applied.settings)[`terminal.integrated.${kind}.${os}`];
      const paths = isEnv ? [entry[`${NUP}_EVENTS`]] : [entry[profileName].path, entry[profileName].env[`${NUP}_EVENTS`]];
      for (const configured of paths) {
        const ref = Array.isArray(configured) ? configured[1] : configured;
        const resolved = ref.replace(/^(?:~|\$\{(?:workspaceFolder|env:USERPROFILE)\})/, () => root).replaceAll("\\", "/");
        assert.equal(path.normalize(resolved), target(NEW), `${kind}.${os} configured target`);
        assert.equal(read(resolved), "fixture target\n");
      }
    }
    assert.equal(read(file), J(config(NEW)));
    assert.equal(run({ ...fx.args, apply: true }).actions, 0);
    assert.equal(rollback(r.journal, quiet), 0);
    assert.deepEqual(snapshot(fx.home, false), before);
  });
}

test("preflight refuses while a process still uses the old name", () => {
  const fx = fixture();
  const before = snapshot(fx.F, true);
  const lines = [];
  const r = run({ ...fx.args, apply: true, log: (l) => lines.push(l), listProcesses: () => [{ pid: 999999, cmd: `node ${fx.hb}/${OLD}-claude`, cwd: "/" }, { pid: 999998, cmd: "bash", cwd: path.join(fx.board, "wt", "a") }, { pid: 999997, cmd: "bash", cwd: "/" }] });
  assert.equal(r.refused.length, 2, r.refused.join("\n"));
  assert.match(lines.join("\n"), /Nothing was changed/);
  assert.deepEqual(snapshot(fx.F, true), before);
});

test("the audit reports a planted leftover, grouped with a count and examples", () => {
  const fx = fixture();
  const cj = path.join(fx.home, ".claude.json");
  write(cj, JSON.stringify({ githubRepoPaths: { "a/b": [path.join(fx.board, "wt", "a")] }, ...JSON.parse(read(cj)) }, null, 2));
  const planted = path.join(fx.home, ".claude", "projects", `-x-${OLD}-repo`);
  write(path.join(planted, "t.jsonl"), "{}\n");
  const lines = [];
  const r = run({ ...fx.args, apply: true, log: (l) => lines.push(l) });
  assert.deepEqual(JSON.parse(read(cj)).githubRepoPaths, { "a/b": [path.join(fx.nb, "wt", "a")] }, "paths outside the project keys move too");
  const reason = `names (${path.join(fx.home, ".claude", "projects")})`;
  assert.deepEqual(r.audit.groups.get(reason), [planted]);
  assert.ok(lines.includes(`  1  ${reason}: ${planted}`), lines.join("\n"));
  assert.deepEqual(r.problems, [], "no binary file in the text backup tree");
});

test("an old dot folder inside a worktree path stays, and a second pass does not take it for a new match", () => {
  const fx = fixture();
  const inner = `${fx.board}/wt/a/.${OLD}/verification`;
  write(path.join(fx.hb, "ledger", "sessions.json"), JSON.stringify({ cwd: inner }));
  write(path.join(fx.board, "tmp", "c2", "claude-1000", `-x--${OLD}-wt-c2`, "f"), "x\n");
  const r = run({ ...fx.args, apply: true });
  assert.equal(JSON.parse(read(path.join(fx.nh, "ledger", "sessions.json"))).cwd, `${fx.nb}/wt/a/.${OLD}/verification`);
  assert.ok(fs.existsSync(path.join(fx.nb, "tmp", "c2", "claude-1000", `-x--${NEW}-wt-c2`, "f")), "scratch folders named after a board path follow it");
  assert.ok(!r.audit.left.some((h) => h.path.endsWith("sessions.json")));
  assert.equal(run({ ...fx.args, apply: true }).actions, 0);
});

test("the alpha build's names, paths and database rows stay as they are; the home speech folder follows its settings", () => {
  const fx = fixture();
  const A = `${OLD}-alpha`;
  const homeAlpha = path.join(fx.home, `.${A}`);
  const wsAlpha = path.join(fx.ws, `.${A}`);
  const homeSpeech = path.join(fx.home, `.${OLD}-speech`);
  write(path.join(homeAlpha, `${OLD}-claude.js`), `// ~/.${A}\n`);
  write(path.join(wsAlpha, "tasks.json"), "[]\n");
  write(path.join(homeSpeech, "whisper", "models", "m.bin"), "model\n");
  write(path.join(homeSpeech, `${OLD}-claude.js`), `// ~/.${OLD}-speech\n`);
  write(path.join(fx.hb, "usage", `${A}-codex-home.json`), "{}\n");
  const alphaProject = path.join(fx.home, ".claude", "projects", `${enc(fx.ws)}--${A}-wt-x`);
  write(path.join(alphaProject, "t.jsonl"), "{}\n");
  const mixed = { alphaWrapper: path.join(homeAlpha, `${OLD}-claude.js`), alphaCard: path.join(wsAlpha, "wt", "x"), alphaId: `example-publisher.${A}`,
    alphaView: `workbench.view.extension.${A}`, mainCard: path.join(fx.board, "wt", "a"), mainId: `example-publisher.${OLD}` };
  write(path.join(fx.hb, "ledger", "mixed.json"), J(mixed));
  write(path.join(fx.user, "settings.json"), J({ [`${OLD}.speech.whisperFolder`]: path.join(homeSpeech, "whisper"), [`${A}.autoStart`]: true,
    "claudeCode.claudeProcessWrapper": path.join(homeAlpha, `${OLD}-claude.js`) }));
  const secret = (id) => `secret://${J({ extensionId: `example-publisher.${id}`, key: `${OLD}.asana.token` })}`;
  const vdbFile = path.join(fx.user, "globalStorage", "state.vscdb");
  const vdb = new DatabaseSync(vdbFile);
  const put = vdb.prepare("INSERT INTO ItemTable VALUES (?, ?)");
  put.run(`example-publisher.${A}`, J({ [`${OLD}.actionPicks`]: [2] }));
  put.run(`workbench.view.extension.${A}.state.hidden`, J([{ id: `${A}.board`, isHidden: false }]));
  put.run(secret(A), "alpha token");
  put.run(secret(OLD), "main token");
  vdb.close();

  const r = run({ ...fx.args, apply: true });
  assert.equal(r.refused, null);
  assert.deepEqual(r.problems, []);
  // alpha: folders, files, a usage file named after it and its Claude project folder keep their names
  assert.equal(read(path.join(homeAlpha, `${OLD}-claude.js`)), `// ~/.${A}\n`);
  assert.equal(read(path.join(wsAlpha, "tasks.json")), "[]\n");
  assert.ok(fs.existsSync(path.join(fx.nh, "usage", `${A}-codex-home.json`)));
  assert.ok(fs.existsSync(path.join(alphaProject, "t.jsonl")));
  // alpha in text: its paths (file name included), extension id and view id stay; the main build's move, in the same file
  assert.deepEqual(JSON.parse(read(path.join(fx.nh, "ledger", "mixed.json"))), { ...mixed, mainCard: path.join(fx.nb, "wt", "a"), mainId: `example-publisher.${NEW}` });
  const settings = JSON.parse(read(path.join(fx.user, "settings.json")));
  assert.equal(settings["claudeCode.claudeProcessWrapper"], path.join(homeAlpha, `${OLD}-claude.js`));
  assert.equal(settings[`${A}.autoStart`], true);
  // alpha's database rows stay; the main build's saved state and its secret move
  const db = new DatabaseSync(vdbFile, { readOnly: true });
  const rows = Object.fromEntries(db.prepare("SELECT key, value FROM ItemTable").all().map((x) => [x.key, x.value]));
  db.close();
  assert.deepEqual(JSON.parse(rows[`example-publisher.${A}`]), { [`${OLD}.actionPicks`]: [2] });
  assert.deepEqual(JSON.parse(rows[`workbench.view.extension.${A}.state.hidden`]), [{ id: `${A}.board`, isHidden: false }]);
  assert.equal(rows[secret(A)], "alpha token");
  assert.equal(rows[secret(OLD)], undefined);
  assert.equal(rows[`secret://${J({ extensionId: `example-publisher.${NEW}`, key: `${NEW}.asana.token` })}`], "main token");
  assert.ok(rows[`example-publisher.${NEW}`] !== undefined && rows[`example-publisher.${OLD}`] === undefined);
  // the home speech folder is renamed, its contents are not, and the setting names the folder that now exists
  const newSpeech = path.join(fx.home, `.${NEW}-speech`);
  assert.ok(!fs.existsSync(homeSpeech));
  assert.equal(read(path.join(newSpeech, `${OLD}-claude.js`)), `// ~/.${OLD}-speech\n`);
  assert.equal(settings[`${NEW}.speech.whisperFolder`], path.join(newSpeech, "whisper"));
  assert.ok(fs.existsSync(path.join(settings[`${NEW}.speech.whisperFolder`], "models", "m.bin")));
  assert.ok(journal(r.journal).some((a) => a.op === "rename" && a.to === newSpeech));
  // nothing of alpha's is counted as left over, a second run changes nothing, and rollback puts the speech folder back
  assert.ok(!r.audit.left.some((h) => h.path.includes(A)), J(r.audit.left.filter((h) => h.path.includes(A))));
  assert.equal(run({ ...fx.args, apply: true }).actions, 0);
  assert.equal(rollback(r.journal, quiet), 0);
  assert.ok(fs.existsSync(path.join(homeSpeech, "whisper", "models", "m.bin")) && !fs.existsSync(newSpeech));
});
test("a board folder a running program sits in is left alone and reported; the rest moves; the next run finishes it",
  { skip: process.platform !== "win32" && "only Windows refuses to rename a folder a program is running in" }, async () => {
    const fx = fixture();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: path.join(fx.board, "reports"), stdio: "ignore" });
    let first;
    try {
      first = run({ ...fx.args, apply: true });
      assert.equal(first.refused, null);
      assert.ok(first.problems.some((p) => p.startsWith(`${fx.board} is in use by a running program`)), J(first.problems));
      assert.ok(fs.existsSync(path.join(fx.board, "tasks.json")) && !fs.existsSync(fx.nb), "the busy board keeps its name");
      assert.ok(read(path.join(fx.board, "tasks.json")).includes(`.${OLD}`), "and its files are not rewritten");
      assert.ok(fs.existsSync(fx.nh) && !fs.existsSync(fx.hb), "the home folder moved");
      assert.ok(fs.existsSync(path.join(fx.ws, `.${NEW}-speech`, "tasks.json")), "the workspace's other folder moved");
      assert.doesNotMatch(git("-C", fx.ws, "worktree", "list", "--porcelain"), /prunable/, "its worktrees still point at it");
      git("-C", path.join(fx.board, "wt", "a"), "status", "--porcelain");
      assert.ok(first.audit.left.some((h) => h.path === fx.board), "the audit lists it as left");
      assert.equal(journal(first.journal).length, first.actions, "a refused rename is neither counted nor journaled");
    } finally {
      await new Promise((done) => { child.once("exit", done); child.kill(); });
    }
    const second = run({ ...fx.args, apply: true });
    assert.deepEqual(second.problems, []);
    assert.ok(!fs.existsSync(fx.board) && fs.existsSync(path.join(fx.nb, "tasks.json")));
    for (const t of JSON.parse(read(path.join(fx.nb, "tasks.json"))).tasks) assert.ok(fs.statSync(t.worktree).isDirectory(), t.worktree);
    assert.doesNotMatch(git("-C", fx.ws, "worktree", "list", "--porcelain"), /prunable/);
    git("-C", path.join(fx.nb, "wt", "a"), "status", "--porcelain");
    assert.equal(run({ ...fx.args, apply: true }).actions, 0);
  });
