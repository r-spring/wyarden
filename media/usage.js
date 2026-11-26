// Use the owning machine's offset at this instant. Snapshots with only a zone use Intl as before.
function formatHostDate(at, clock, method, options = {}) {
  const date = new Date(at);
  const offset = clock.hostTimeOffsets?.findLast(([from]) => from <= date.getTime())?.[1];
  if (typeof offset === "number") return new Date(date.getTime() + offset * 1000)[method]([], { ...options, timeZone: "UTC" });
  return date[method]([], { ...options, timeZone: clock.hostTimezone });
}

// A reported quota is a snapshot, never an estimate of available requests.
function usageWindow(usage, key, now = Date.now(), timeZone, hostTimeOffsets) {
  const value = usage?.[key];
  const resets = usage?.[`${key}Resets`];
  const valid = typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
  const hasReset = typeof resets === "number" && Number.isFinite(resets) && resets > 0;
  const expired = hasReset && resets * 1000 <= now;
  const stale = !usage || !Number.isFinite(usage.at) || now - usage.at >= 15 * 60_000;
  const reset = expired ? "Reset time passed · awaiting a new reading"
    : hasReset ? `Resets ${formatHostDate(resets * 1000, { hostTimezone: timeZone, hostTimeOffsets }, "toLocaleString", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
    : "Reset time not reported";
  if (!valid || expired) return { text: expired ? "Awaiting update" : "Not reported", reset, tone: "unknown" };
  const rounded = Math.round(value);
  return {
    value,
    text: `${rounded}% used · ${100 - rounded}% remaining${stale ? " (last reported)" : ""}`,
    reset,
    stale,
    // A limit that was reached stays reached until its reset time, however old the reading (an expired window returned above).
    tone: value >= 100 && hasReset ? "limited" : stale ? "stale" : value >= 100 ? "limited" : value >= 80 ? "warning" : "normal",
  };
}

// A window's short name from its length in minutes: Claude's two keep their names, a provider's others say how long they are.
function windowShort(minutes) {
  return minutes === 300 ? "5-hour" : minutes === 7 * 1440 ? "weekly" : minutes < 1440 ? `${minutes / 60}-hour` : `${minutes / 1440}-day`;
}

// For the Max family, show the five-hour meter whenever Claude reports a value.
// A missing meter alone does not establish the account's entitlement.
function fiveHourShown(plan, usage) {
  return !/^max/i.test(plan || "") || typeof usage?.fiveHour === "number";
}

// The quick pick's one-line summary of an account (Switch account), by the same rules as the board's Accounts rows.
// A provider that reports its own windows (Codex) is read at their real lengths; Claude's reading has fiveHour and week.
function usageLine(usage, now = Date.now(), plan) {
  if (!usage) return "Usage not reported yet.";
  const part = (label, key, u = usage) => {
    const q = usageWindow(u, key, now);
    return q.value !== undefined ? `${label} ${Math.round(q.value)}%` : q.tone === "unknown" && q.text === "Awaiting update" ? `${label} has reset since the last reading` : `${label} unknown`;
  };
  const mins = Math.max(0, Math.floor((now - usage.at) / 60000));
  const age = mins >= 15 ? `last reported ${mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h`} ago` : "";
  const parts = usage.windows ? usage.windows.map((w) => part(windowShort(w.minutes), "w", { at: usage.at, w: w.pct, wResets: w.resets }))
    : [fiveHourShown(plan, usage) && part("5-hour", "fiveHour"), part("weekly", "week")];
  return [...parts, age].filter(Boolean).join(" · ");
}

// What the task columns are drawn from. The host re-posts the whole state on a timer for the Accounts rows; when this is unchanged
// the columns are left as they are, so a follow-up being typed keeps its undo history, selection and scroll.
function columnsKey(state) {
  const { accountRows, activeAccount, ...rest } = state || {};
  return JSON.stringify(rest);
}
if (typeof module !== "undefined") module.exports = { formatHostDate, usageWindow, usageLine, windowShort, fiveHourShown, columnsKey };
