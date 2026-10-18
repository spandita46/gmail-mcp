import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { localMidnightEpoch, localToday } from "../src/time.js";

const TZ = "America/Toronto";
// Read an epoch back as Toronto wall-clock time, to check it really is local midnight.
const torontoClock = (epochSeconds: number) =>
  new Date(epochSeconds * 1000).toLocaleString("en-CA", { timeZone: TZ, hourCycle: "h23" });

describe("localMidnightEpoch", () => {
  it("matches the value verified live against Gmail", () => assert.equal(localMidnightEpoch("2026-10-17", TZ), 1792209600));

  // Both 2026 DST change days and the days after: a naive offset calculation is off by an hour here.
  for (const date of ["2026-03-08", "2026-03-09", "2026-11-01", "2026-11-02", "2026-01-15", "2026-07-01"]) {
    it(`${date} is 00:00:00 in Toronto`, () => assert.equal(torontoClock(localMidnightEpoch(date, TZ)), `${date}, 00:00:00`));
  }

  it("works for other zones (India, no DST)", () =>
    assert.equal(new Date(localMidnightEpoch("2026-10-17", "Asia/Kolkata") * 1000).toISOString(), "2026-10-16T18:30:00.000Z"));
});

describe("localToday", () => {
  it("returns YYYY-MM-DD", () => assert.match(localToday(TZ), /^\d{4}-\d{2}-\d{2}$/));
});
