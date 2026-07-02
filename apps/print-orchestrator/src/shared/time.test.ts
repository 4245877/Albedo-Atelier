import assert from "node:assert/strict";
import { test } from "node:test";

import { isWithinLocalTimeWindow, parseLocalTimeWindow } from "./time";

// These run under TZ=UTC (see package.json "test" script) so local === UTC.
function at(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 6, 2, hour, minute, 0));
}

test("parseLocalTimeWindow reads a well-formed window", () => {
  assert.deepEqual(parseLocalTimeWindow("23:00 – 07:30"), {
    startMinutes: 23 * 60,
    endMinutes: 7 * 60 + 30
  });
});

test("parseLocalTimeWindow rejects garbage without throwing", () => {
  assert.equal(parseLocalTimeWindow("not a window"), null);
  assert.equal(parseLocalTimeWindow(""), null);
  assert.equal(parseLocalTimeWindow("25:99"), null);
});

test("isWithinLocalTimeWindow handles a wrap-around night window 23:00–07:30", () => {
  const window = "23:00 – 07:30";
  // Inside: late night and early morning.
  assert.equal(isWithinLocalTimeWindow(window, at(23, 30)), true);
  assert.equal(isWithinLocalTimeWindow(window, at(2)), true);
  assert.equal(isWithinLocalTimeWindow(window, at(7, 0)), true);
  // Boundaries: start inclusive, end exclusive.
  assert.equal(isWithinLocalTimeWindow(window, at(23, 0)), true);
  assert.equal(isWithinLocalTimeWindow(window, at(7, 30)), false);
  // Outside: daytime.
  assert.equal(isWithinLocalTimeWindow(window, at(12)), false);
  assert.equal(isWithinLocalTimeWindow(window, at(22, 59)), false);
});

test("isWithinLocalTimeWindow handles a same-day window 09:00–18:00", () => {
  const window = "09:00 – 18:00";
  assert.equal(isWithinLocalTimeWindow(window, at(12)), true);
  assert.equal(isWithinLocalTimeWindow(window, at(8, 59)), false);
  assert.equal(isWithinLocalTimeWindow(window, at(18, 0)), false);
});

test("isWithinLocalTimeWindow treats an invalid window as never-on (no throw)", () => {
  assert.equal(isWithinLocalTimeWindow("garbage", at(2)), false);
  assert.equal(isWithinLocalTimeWindow("garbage", at(12)), false);
});
