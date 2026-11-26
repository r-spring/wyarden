import { spawn } from "child_process";
import { createInterface } from "readline";
import * as os from "os";
import type { Usage } from "./sessions";

type NamedWindow = { utilization?: unknown; resets_at?: unknown };
type ClaudeLimits = { five_hour?: NamedWindow | null; seven_day?: NamedWindow | null; limits?: unknown };

/** Only accept quota fields; neither credentials nor conversation data are retained. */
export function parseUsage(value: unknown): Usage {
  const limits = (value as { rate_limits?: ClaudeLimits | null } | null)?.rate_limits;
  const percent = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : undefined;
  const reset = (v: unknown) => {
    const ms = typeof v === "string" ? Date.parse(v) : NaN;
    // Whole seconds: Claude's reset time wobbles by milliseconds between queries, which defeated the history's 15-minute dedupe.
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : undefined;
  };
  const rows = Array.isArray(limits?.limits) ? limits.limits : [];
  // Compare account-wide meters independent of presentation order and headline selection.
  // undefined means no usable candidate; null means the candidates disagreed.
  const window = (named: NamedWindow | null | undefined, kind: string) => {
    const typed = rows.filter((r) => r?.kind === kind && r.scope == null)
      .map((r): NamedWindow => ({ utilization: r.percent, resets_at: r.resets_at }));
    let reading: { pct: number; resets?: number } | undefined;
    for (const candidate of [named, ...typed]) {
      const pct = percent(candidate?.utilization);
      if (pct === undefined) continue;
      const resets = reset(candidate?.resets_at);
      if (reading && (reading.pct !== pct || (reading.resets !== undefined && resets !== undefined && reading.resets !== resets))) return null;
      reading = { pct, resets: resets ?? reading?.resets };
    }
    return reading;
  };
  const fiveHour = window(limits?.five_hour, "session");
  const week = window(limits?.seven_day, "weekly_all");
  // Empty and scoped-only lists explicitly replace a previous reading. A missing list or a
  // malformed meter is not evidence that the provider removed its account-wide windows.
  const validList = Array.isArray(limits?.limits) && rows.every(r => typeof r?.kind === "string" && percent(r.percent) !== undefined);
  if (fiveHour === undefined && week === undefined && !validList) throw new Error("Claude did not report subscription usage. Try Refresh again later.");
  const weeklyOnly = week && fiveHour === undefined && limits?.five_hour == null && validList &&
    rows.some(r => r.kind === "weekly_all" && r.scope == null) &&
    rows.every(r => r.kind === "weekly_all" || r.kind === "weekly_scoped");
  const quotaCoverage = weeklyOnly ? "weekly-only" : !fiveHour || !week ? "incomplete" : undefined;
  // A conflicting reply supersedes earlier numbers for that window. 'at' records local receipt.
  return { fiveHour: fiveHour?.pct, week: week?.pct, fiveHourResets: fiveHour?.resets, weekResets: week?.resets,
    ...(quotaCoverage && { quotaCoverage }), at: Date.now(), source: "query" };
}

/** Same experimental control request used by Claude's usage panel. No user prompt or inference turn. */
export function queryUsage(configDir: string, signal: AbortSignal): Promise<Usage> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Usage refresh cancelled."));
    const env = { ...process.env };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CLAUDECODE;
    // This probe belongs to the selected subscription folder, not an inherited API credential.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
    const child = spawn("claude", ["--print", "--input-format", "stream-json", "--output-format", "stream-json",
      "--verbose", "--safe-mode", "--no-session-persistence"], { cwd: os.homedir(), env, windowsHide: true });
    let done = false;
    const reader = createInterface({ input: child.stdout });
    const finish = (error?: Error, usage?: Usage) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reader.close();
      child.stdin.destroy();
      child.kill();
      if (error) reject(error); else resolve(usage!);
    };
    const cancel = () => finish(new Error("Usage refresh cancelled."));
    const timer = setTimeout(() => finish(new Error("Usage refresh timed out. Try Refresh again.")), 60_000);
    signal.addEventListener("abort", cancel, { once: true });
    child.on("error", () => finish(new Error("Could not start Claude to refresh usage. Check that Claude Code is installed.")));
    child.on("exit", () => finish(new Error("Claude closed before returning usage. Try signing in again.")));
    child.stdin.on("error", () => finish(new Error("Claude could not receive the usage request. Try Refresh again.")));
    child.stderr.resume();
    const send = (id: string, subtype: string) => child.stdin.write(JSON.stringify({
      type: "control_request", request_id: id, request: { subtype },
    }) + "\n");
    reader.on("line", (line) => {
      if (done) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const response = message?.response;
      if (message?.type !== "control_response" || !["initialize", "usage"].includes(response?.request_id)) return;
      if (response.subtype !== "success") return finish(new Error("Claude could not refresh usage. Try Refresh or sign in again; this Claude version may not support usage requests."));
      if (response.request_id === "initialize") { send("usage", "get_usage"); return; }
      try { finish(undefined, parseUsage(response.response)); }
      catch (error) { finish(error as Error); }
    });
    send("initialize", "initialize");
  });
}
