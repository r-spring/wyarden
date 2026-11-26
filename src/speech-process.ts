import { ChildProcess, execFile } from "child_process";
import { promisify } from "util";

/** A signal requests termination. Only close (or a failed spawn) releases the child. */
export function trackSpeechChild(child: ChildProcess) {
  let settled = false, terminating = false;
  let escalation: NodeJS.Timeout | undefined;
  const closed = new Promise<void>(resolve => {
    const finish = () => { settled = true; clearTimeout(escalation); resolve(); };
    child.once("close", finish);
    // An error with a PID can mean kill failed. Keep waiting for close in that case.
    child.on("error", () => { if (!child.pid) finish(); });
  });
  const running = () => !settled && child.pid && child.exitCode === null && child.signalCode === null;
  const terminate = () => {
    if (terminating || settled) return;
    terminating = true;
    const signal = () => {
      if (!running()) return;
      escalation = setTimeout(() => { if (running()) child.kill("SIGKILL"); }, 2000);
      child.kill("SIGTERM");
    };
    if (child.pid) signal();
    else child.once("spawn", signal);
  };
  return { closed, terminate };
}

/** Keep execFile's bounded stdout/stderr and wait for its process before releasing local audio files. */
export async function runSpeechFile(exe: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal, cwd?: string) {
  signal.throwIfAborted();
  const result = promisify(execFile)(exe, args, { env, cwd, windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024 });
  const child = trackSpeechChild(result.child);
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.terminate(); }, 120_000);
  signal.addEventListener("abort", child.terminate, { once: true });
  try {
    const output = await result;
    signal.throwIfAborted();
    if (timedOut) throw new Error("Local transcription timed out.");
    return output;
  } finally {
    await child.closed;
    clearTimeout(timeout);
    signal.removeEventListener("abort", child.terminate);
  }
}
