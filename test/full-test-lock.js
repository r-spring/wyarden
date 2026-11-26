// One full test run at a time on this machine (the user, 18 November 2026): parallel npm test runs overloaded linux.
// Keep the SQLite file in the shared temp root: unlinking it would let waiters lock two different files.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");

// ps obtains the start time from /proc/<pid>/stat on Linux. Both answers use UTC epoch milliseconds.
// Failure or two timestamps within the precision of ps cannot establish PID reuse.
function startedAfter(pid, at) {
  if (!Number.isSafeInteger(at) || at <= 0) return false;
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true };
  try {
    if (process.platform === "linux") {
      const born = execFileSync("/usr/bin/ps", ["-o", "lstart=", "-p", String(pid)],
        { ...options, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
      return Date.parse(born.trim() + " GMT") > at + 1000;
    }
    if (process.platform === "win32") {
      const ps = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const born = execFileSync(ps, ["-NoProfile", "-NonInteractive", "-Command",
        `([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`], options);
      return Number(born.trim()) > at;
    }
  } catch { /* Process disappeared or its creation time is unavailable. */ }
  return false;
}

// Keep the descriptor through release. The old runner can unlink and recreate the name at any
// instruction. Neither takeover nor release may write to whichever inode the name points at later.
function contents(fd) {
  const bytes = Buffer.alloc(fs.fstatSync(fd).size);
  return bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0)).toString("utf8");
}

function writeRecord(fd, record, oldSize) {
  const text = Buffer.from(record);
  const bytes = Buffer.alloc(Math.max(oldSize, text.length), 0x20);
  text.copy(bytes);
  // One positional write. Truncating before writing would expose incomplete JSON to old readers.
  if (fs.writeSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw Error("Short full-test lock write");
  return bytes.toString("utf8");
}

// Older runners own just the JSON file. An incomplete legacy write has no PID we can safely disprove.
function stale(record) {
  let h;
  try { h = JSON.parse(record); } catch { return false; }
  if (h?.released === true) return true;
  if (!Number.isSafeInteger(h?.pid) || h.pid <= 0) return false;
  if (h.sqliteOwner) return true; // We already hold its OS lock, even if its PID is now in use again.
  try { process.kill(h.pid, 0); } catch (e) { return e.code === "ESRCH"; }
  return startedAfter(h.pid, h.at);
}

const identity = file => fs.statSync(file, { bigint: true, throwIfNoEntry: false });
const sameFile = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;

// Only the SQLite writer touches the retirement name. If a legacy reaper replaced the public
// name at the instant of rename, retain that exact inode and restore it without overwriting a
// later claimant. After interruption the next writer completes the same operation.
function restoreDisplaced(file, retired) {
  const displaced = identity(retired);
  if (!displaced) return true;
  try { fs.linkSync(retired, file); }
  catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (!sameFile(displaced, identity(file)) && !stale(fs.readFileSync(retired, "utf8"))) return false;
  }
  fs.unlinkSync(retired);
  return true;
}

function acquire(file, { pollMs = 1000, log = console.error } = {}) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file + ".sqlite");
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let told = false;
  function wait() {
    if (!told) log("Waiting for the full test run holding " + file + " to finish.");
    told = true;
    Atomics.wait(pause, 0, 0, pollMs);
  }
  try {
    // The kernel releases this writer lock on process exit, including a crash during initialization.
    for (;;) {
      try { db.exec("BEGIN IMMEDIATE"); break; }
      catch (e) { if (e.errcode !== 5) throw e; } // SQLITE_BUSY
      wait();
    }
    const sqliteOwner = randomUUID();
    const retired = file + ".retiring";
    for (;;) {
      if (!restoreDisplaced(file, retired)) { wait(); continue; }
      let fd;
      try {
        try { fd = fs.openSync(file, "r+"); }
        catch (e) { if (e.code !== "ENOENT") throw e; }
        const previous = fd === undefined ? undefined : contents(fd);
        if (previous !== undefined && !stale(previous)) {
          fs.closeSync(fd);
          fd = undefined;
          wait();
          continue;
        }
        // The old binary takes a live PID after 45 minutes based solely on 'at'. Give it a
        // non-expiring compatibility timestamp; acquiredAt is the actual time of admission.
        let record = JSON.stringify({ pid: process.pid, at: Number.MAX_SAFE_INTEGER, acquiredAt: Date.now(), cwd: process.cwd(), sqliteOwner });
        if (fd === undefined) {
          const pending = file + ".next";
          fs.rmSync(pending, { force: true }); // Could still be a hard link after a crash.
          fs.writeFileSync(pending, record);
          try {
            fd = fs.openSync(pending, "r+");
            try { fs.linkSync(pending, file); }
            catch (e) { if (e.code === "EEXIST") continue; throw e; }
          } finally { fs.unlinkSync(pending); }
        } else {
          record = writeRecord(fd, record, Buffer.byteLength(previous));
          // A parent-revision contender may already have acquired a different inode. Its own
          // unconditional unlink after a stale observation can still run *after* this check:
          // an unmodified old reaper cannot be fenced by the new runners' SQLite transaction.
          // Old code also makes that decision if its read races a clean release and sees ENOENT.
          try { if (fs.readFileSync(file, "utf8") !== record) continue; }
          catch (e) { if (e.code === "ENOENT") continue; throw e; }
        }
        const owned = fd;
        fd = undefined;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          try {
            const owner = fs.fstatSync(owned, { bigint: true });
            if (contents(owned) !== record || !sameFile(owner, identity(file))) return;
            // Atomically vacate the public name. Only delete the verified private generation:
            // a check followed by unlink(file) could instead delete a genuine legacy successor.
            try { fs.renameSync(file, retired); }
            catch (e) { if (e.code === "ENOENT") return; throw e; }
            if (sameFile(owner, identity(retired)) && fs.readFileSync(retired, "utf8") === record) fs.unlinkSync(retired);
            else restoreDisplaced(file, retired);
          } finally {
            try { fs.closeSync(owned); } finally { db.close(); }
          }
        };
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
  } catch (e) { db.close(); throw e; }
}

// Loaded by the test coordinator after Node has parsed all flags and their values. Consume the
// variable before it spawns test processes, so its preloaded children never queue behind their parent.
if (process.env.ENTOMATICAL_TEST_LOCK !== undefined) {
  const file = process.env.ENTOMATICAL_TEST_LOCK;
  delete process.env.ENTOMATICAL_TEST_LOCK;
  const selections = process.argv.slice(1);
  if (!selections.length) process.argv.push("test/*.test.js"); // Exclude runner/helper scripts from default discovery.
  if (file) {
    const paths = new Set(selections.map(arg => path.resolve(arg)));
    const suite = fs.readdirSync(__dirname).filter(name => name.endsWith(".test.js"));
    const patterns = [...paths];
    if (!paths.size || suite.every(name => {
      const testFile = path.join(__dirname, name);
      return paths.has(testFile) || patterns.some(pattern => testFile.startsWith(pattern + path.sep) || path.matchesGlob(testFile, pattern));
    })) process.once("exit", acquire(file));
  }
}

module.exports = { acquire };
