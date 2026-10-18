import { TIME_ZONE } from "./config.js"; // set with GMAIL_MCP_TZ

// How far `timeZone`'s wall clock is ahead of UTC at a given instant, in ms.
// Toronto in October (EDT) → -4h. In January (EST) → -5h.
// Trick: format the instant as wall-clock parts in that zone, read those parts back
// *as if* they were UTC, and the difference is the offset. No date library needed.
function offsetMs(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23", // 0–23, so midnight is 00 and not 24
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const wallClockAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return wallClockAsUtc - epochMs;
}

// "2026-10-17" → Unix seconds for 00:00 on that date in `timeZone` (1792209600 for Toronto).
export function localMidnightEpoch(
  date: string,
  timeZone: string = TIME_ZONE,
): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const midnightUtc = Date.UTC(y, m - 1, d); // midnight in UTC, our first guess
  // Shift by the zone's offset to land on local midnight…
  let epochMs = midnightUtc - offsetMs(midnightUtc, timeZone);
  // …then check again. On DST change days the offset at the guess and at the result
  // can differ by an hour, and a second pass corrects that.
  const corrected = midnightUtc - offsetMs(epochMs, timeZone);
  if (corrected !== epochMs) epochMs = corrected;
  return Math.floor(epochMs / 1000); // Gmail wants whole seconds
}

// Today's local date as "YYYY-MM-DD". The en-CA locale happens to format dates in ISO order.
export function localToday(timeZone: string = TIME_ZONE): string {
  return new Date().toLocaleDateString("en-CA", { timeZone });
}
