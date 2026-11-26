import { execFileSync } from "child_process";

type Offset = [fromMs: number, secondsEast: number | null];
type HostClock = { hostTimezone?: string; hostTimeOffsets?: Offset[] };
const { formatHostDate } = require("../media/usage.js") as {
  formatHostDate(at: number, clock: HostClock, method: "toLocaleTimeString", options: Intl.DateTimeFormatOptions): string;
};

/** zdump -i gives the first wall time under each new offset, including fractional-hour and historical seconds. */
function systemOffsets(zone: string): Offset[] | undefined {
  const rows = execFileSync("zdump", ["-i", "-c", "1970,2100", "--", zone], {
    encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
  }).trim().split(/\r?\n/).slice(1); // TZ="..."
  const offsets: Offset[] = [];
  for (const row of rows) {
    const [date, time, offset] = row.split("\t");
    const parts = /^([+-])(\d\d)(\d\d)?(\d\d)?$/.exec(offset);
    if (!parts) return undefined;
    const seconds = (parts[1] === "-" ? -1 : 1) * (Number(parts[2]) * 3600 + Number(parts[3] || 0) * 60 + Number(parts[4] || 0));
    let from = 0;
    if (offsets.length) {
      const [h, m = "00", s = "00"] = time.split(":");
      from = Date.parse(`${date}T${h}:${m}:${s}Z`) - seconds * 1000;
      if (!Number.isFinite(from)) return undefined;
    } else if (date !== "-" || time !== "-") return undefined;
    if (offsets.at(-1)?.[1] !== seconds) offsets.push([from, seconds]);
  }
  if (!offsets.length) return undefined;
  offsets.push([Date.UTC(2100, 0), null]); // Outside the dump, use the named zone.
  return offsets;
}

let cached: HostClock | undefined;
export function hostClock(): HostClock {
  if (cached) return cached;
  cached = { hostTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  try {
    if (process.platform === "win32") {
      if (!cached.hostTimezone || cached.hostTimezone === "America/Vancouver") {
        const id = execFileSync("tzutil.exe", ["/g"], { encoding: "utf8", windowsHide: true, timeout: 2000 }).trim();
        if (id === "British Columbia Standard Time") {
          cached.hostTimezone = "America/Vancouver";
          // This Windows ID denotes BC's permanent Pacific time from the final spring transition.
          // https://news.gov.bc.ca/releases/2026AG0013-000209
          cached.hostTimeOffsets = [[Date.UTC(2026, 2, 8, 10), -7 * 3600]];
        }
      }
    } else if (process.env.TZ === "" || process.env.TZ === "UTC") {
      cached.hostTimezone = "UTC";
    } else {
      cached.hostTimeOffsets = systemOffsets(process.env.TZ ?? "/etc/localtime");
    }
  } catch { /* Keep the named zone if the host's rules cannot be read. */ }
  return cached;
}

export const localTimeZone = () => hostClock().hostTimezone;
export const localTime = (ms: number, options: Intl.DateTimeFormatOptions = {}) => formatHostDate(ms, hostClock(), "toLocaleTimeString", {
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, ...options,
});
