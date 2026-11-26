// Loaded into every test process by test/run.js (--require). A recursive fs.rmSync that fails with EPERM, EBUSY or ENOTEMPTY is
// retried for up to 10 s. Why (16 November 2026, Windows, Node 26): Board starts git in the background (refreshNotInMain's
// `symbolic-ref`, deliver's MERGE_HEAD check, finish's `config --get`) and dispose() does not wait for it. A test that deletes its
// repo right after dispose() meets a git.exe whose working folder is that repo, and Windows refuses with EPERM; Node's own
// maxRetries gives up on EPERM at once. Measured: the git had started 17-76 ms before, and the delete worked 28-146 ms later.
const fs = require("node:fs");

const RETRY = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);
const rmSync = fs.rmSync;
const pause = new Int32Array(new SharedArrayBuffer(4));
fs.rmSync = function (target, options) {
  if (!options?.recursive) return rmSync.call(this, target, options);
  for (const until = Date.now() + 10_000; ;) {
    try { return rmSync.call(this, target, options); }
    catch (error) {
      if (!RETRY.has(error.code) || Date.now() > until) throw error;
      Atomics.wait(pause, 0, 0, 50);
    }
  }
};
