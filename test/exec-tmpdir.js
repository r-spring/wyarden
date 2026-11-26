// A temp folder where a test may run the fake CLI scripts it writes. Linux /tmp may be mounted noexec, so a script
// written to os.tmpdir() there fails with EACCES and the speech tests failed for a reason that had nothing to do with the code
// (found 4 November 2026). This probes os.tmpdir() once and falls back to /var/tmp, which allows execution.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

let chosen;
function execTmpdir() {
  if (chosen) return chosen;
  if (process.platform === "win32") return (chosen = os.tmpdir());
  for (const dir of [os.tmpdir(), "/var/tmp"]) {
    let probe;
    try {
      probe = fs.mkdtempSync(path.join(dir, "exec-probe-"));
      const script = path.join(probe, "probe.sh");
      fs.writeFileSync(script, "#!/bin/sh\nexit 0\n"); fs.chmodSync(script, 0o700);
      execFileSync(script, { stdio: "ignore" });
      return (chosen = dir);
    } catch { /* this folder cannot run programs: try the next */ }
    finally { if (probe) fs.rmSync(probe, { recursive: true, force: true }); }
  }
  return (chosen = os.tmpdir());
}
module.exports = { execTmpdir };
