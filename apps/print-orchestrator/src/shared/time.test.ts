import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hhmm,
  isWithinLocalTimeWindow,
  localDateKey,
  minutesSinceLocalMidnight,
  minutesToHhmm,
  parseLocalTimeWindow
} from "./time";

/*
 * These functions work in LOCAL time by design (the operator's wall clock), so
 * the tests build dates from LOCAL components — `new Date(y, m, d, H, M)`. That
 * makes `getHours()` return exactly H in ANY timezone, so the suite is
 * reproducible whether or not `TZ=UTC` is set (running a single file, from an
 * IDE, or on a machine in another zone). It never depends on the package script.
 */
function at(hour: number, minute = 0): Date {
  return new Date(2026, 6, 2, hour, minute, 0, 0);
}

test("hhmm formats local hours:minutes zero-padded", () => {
  assert.equal(hhmm(at(7, 5)), "07:05");
  assert.equal(hhmm(at(23, 59)), "23:59");
  assert.equal(hhmm(at(0, 0)), "00:00");
});

test("localDateKey formats the local calendar date", () => {
  assert.equal(localDateKey(at(1, 30)), "2026-07-02");
  assert.equal(localDateKey(new Date(2026, 0, 9, 12)), "2026-01-09", "month & day are 1-padded");
});

test("minutesSinceLocalMidnight counts from local 00:00", () => {
  assert.equal(minutesSinceLocalMidnight(at(0, 0)), 0);
  assert.equal(minutesSinceLocalMidnight(at(7, 30)), 450);
  assert.equal(minutesSinceLocalMidnight(at(23, 59)), 1439);
});

test("minutesToHhmm is the inverse over the day and normalizes out-of-range input", () => {
  assert.equal(minutesToHhmm(0), "00:00");
  assert.equal(minutesToHhmm(450), "07:30");
  assert.equal(minutesToHhmm(1439), "23:59");
  // Out of range wraps into a day instead of "24:00" / a negative string.
  assert.equal(minutesToHhmm(1440), "00:00");
  assert.equal(minutesToHhmm(1500), "01:00");
  assert.equal(minutesToHhmm(-1), "23:59");
  // Fractions truncate toward zero.
  assert.equal(minutesToHhmm(90.7), "01:30");
  assert.throws(() => minutesToHhmm(Number.NaN), RangeError);
  assert.throws(() => minutesToHhmm(Number.POSITIVE_INFINITY), RangeError);
});

test("parseLocalTimeWindow reads a well-formed window with any dash/spacing", () => {
  assert.deepEqual(parseLocalTimeWindow("21:30 – 07:30"), {
    startMinutes: 21 * 60 + 30,
    endMinutes: 7 * 60 + 30
  });
  assert.deepEqual(parseLocalTimeWindow("09:00-18:00"), { startMinutes: 540, endMinutes: 1080 });
  assert.deepEqual(parseLocalTimeWindow("8:05 to 9:00"), { startMinutes: 485, endMinutes: 540 });
});

test("parseLocalTimeWindow rejects malformed input without throwing", () => {
  for (const bad of ["not a window", "", "25:99", "10:00", "12", "12:60-13:00"]) {
    assert.equal(parseLocalTimeWindow(bad), null, `«${bad}» → null`);
  }
});

test("isWithinLocalTimeWindow: same-day window, start inclusive / end exclusive", () => {
  const window = "09:00 – 18:00";
  assert.equal(isWithinLocalTimeWindow(window, at(12)), true);
  assert.equal(isWithinLocalTimeWindow(window, at(9, 0)), true, "start inclusive");
  assert.equal(isWithinLocalTimeWindow(window, at(18, 0)), false, "end exclusive");
  assert.equal(isWithinLocalTimeWindow(window, at(8, 59)), false);
});

test("isWithinLocalTimeWindow: wrap-around night window crosses midnight", () => {
  const window = "21:30 – 07:30";
  assert.equal(isWithinLocalTimeWindow(window, at(23, 30)), true);
  assert.equal(isWithinLocalTimeWindow(window, at(2)), true);
  assert.equal(isWithinLocalTimeWindow(window, at(21, 30)), true, "start inclusive");
  assert.equal(isWithinLocalTimeWindow(window, at(7, 30)), false, "end exclusive");
  assert.equal(isWithinLocalTimeWindow(window, at(12)), false);
  assert.equal(isWithinLocalTimeWindow(window, at(21, 29)), false);
});

test("isWithinLocalTimeWindow: a zero-length window (start === end) is the whole day", () => {
  // Documented, deliberate semantics — NOT "never on".
  assert.equal(isWithinLocalTimeWindow("08:00-08:00", at(8, 0)), true);
  assert.equal(isWithinLocalTimeWindow("08:00-08:00", at(3, 0)), true);
  assert.equal(isWithinLocalTimeWindow("08:00-08:00", at(20, 0)), true);
});

test("isWithinLocalTimeWindow: an invalid window is never-on (no throw)", () => {
  assert.equal(isWithinLocalTimeWindow("garbage", at(2)), false);
  assert.equal(isWithinLocalTimeWindow("garbage", at(12)), false);
});

test("isWithinLocalTimeWindow accepts a pre-parsed window object", () => {
  assert.equal(isWithinLocalTimeWindow({ startMinutes: 540, endMinutes: 1080 }, at(10)), true);
  assert.equal(isWithinLocalTimeWindow({ startMinutes: 540, endMinutes: 1080 }, at(19)), false);
});
