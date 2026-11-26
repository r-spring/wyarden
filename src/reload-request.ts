import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// F84 (the user, 4 November 2026): a session or a terminal can reload every VS Code window on the machine while the user is away,
// with `node ~/.entomatical/board.js reload-windows`. That writes this file; each installed Entomatical window polls it and reloads
// itself when the request is newer than the window's own start, so a reloaded window never reloads again for the same request.
export const RELOAD_FILE = path.join(os.homedir(), ".entomatical", "reload-request.json");

/** True when the file's request was made after this window started. */
export function wantsReload(text: string, startedAt: number): boolean {
  try {
    const at = JSON.parse(text)?.at;
    return typeof at === "number" && at > startedAt && at <= Date.now() + 60_000;
  } catch {
    return false;
  }
}

/**
 * Polls the request file (fs.watch can run out of inotify instances here, see 0b980cf) and calls reload once. It reads the file on a
 * timer rather than using fs.watchFile: watchFile's first stat is asynchronous, and a request written before it lands becomes the
 * baseline, so no change is ever seen (missed under the full suite's load, linux, 6 November 2026).
 */
export function watchReloadRequests(startedAt: number, reload: () => void, file = RELOAD_FILE, interval = 2000): { dispose(): void } {
  let done = false;
  const check = () => {
    if (done) return;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return; // no request yet
    }
    if (wantsReload(text, startedAt)) {
      done = true;
      reload();
    }
  };
  const timer = setInterval(check, interval);
  check();
  return { dispose: () => clearInterval(timer) };
}
