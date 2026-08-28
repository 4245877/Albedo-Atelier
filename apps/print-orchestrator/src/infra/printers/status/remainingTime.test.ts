import assert from "node:assert/strict";
import { test } from "node:test";

import { extrapolateRemainingMinutes, resolveRemainingMinutes } from "./mapper";
import { parseMoonrakerEstimatedTimeSec } from "./moonraker";

/*
 * "How much longer?" — one precedence for every adapter.
 *
 * The regression: Moonraker's ETA was extrapolated linearly from
 * `virtual_sdcard.progress`, which is FILE POSITION, not time. On any model that
 * is not uniform the two diverge badly, and the number feeds the night-window
 * fit, the operator's plan and the printer-release projection — not just a
 * display.
 */

const MIN = 60;

test("the device's own countdown wins over everything derivable", () => {
  assert.equal(
    resolveRemainingMinutes({
      reportedRemainingSec: 42 * MIN,
      slicerTotalSec: 10 * 3600,
      elapsedSec: 60,
      progressPct: 99
    }),
    42
  );
  // Zero is a real answer from a device about to finish, not a missing value.
  assert.equal(
    resolveRemainingMinutes({ reportedRemainingSec: 0, slicerTotalSec: 3600, elapsedSec: 60, progressPct: 5 }),
    0
  );
});

test("the slicer's estimate beats extrapolation — the non-linear print", () => {
  // A wide base under a tall spire: 80 % of the FILE is done after 30 minutes,
  // but the slicer knows the whole job is three hours.
  const remaining = resolveRemainingMinutes({
    reportedRemainingSec: null,
    slicerTotalSec: 3 * 3600,
    elapsedSec: 30 * MIN,
    progressPct: 80
  });
  assert.equal(remaining, 150, "2.5 hours left, per the toolpath the slicer timed");
  // What the old rule would have said: 30 min elapsed at 80 % ⇒ ~7 minutes left.
  assert.equal(extrapolateRemainingMinutes(80, 30 * MIN), 8);
});

test("no metadata: extrapolation is the fallback, not an error", () => {
  assert.equal(
    resolveRemainingMinutes({
      reportedRemainingSec: null,
      slicerTotalSec: null,
      elapsedSec: 60 * MIN,
      progressPct: 50
    }),
    60
  );
});

test("a print that has outlived the slicer's estimate is not «finishing now»", () => {
  // 4 hours into a job the slicer called 3 hours. `3h − 4h` is negative; reading
  // it as 0 would promise the queue a printer that is not about to be free.
  const remaining = resolveRemainingMinutes({
    reportedRemainingSec: null,
    slicerTotalSec: 3 * 3600,
    elapsedSec: 4 * 3600,
    progressPct: 90
  });
  assert.equal(remaining, extrapolateRemainingMinutes(90, 4 * 3600));
  assert.equal(remaining, 27, "the observed pace is the only evidence left");
});

test("too little progress to extrapolate is unknown, never a number", () => {
  for (const pct of [0, 0.5, 1, 1.9]) {
    assert.equal(
      resolveRemainingMinutes({ reportedRemainingSec: null, slicerTotalSec: null, elapsedSec: 120, progressPct: pct }),
      null,
      `${pct} % is not a sample`
    );
  }
  assert.equal(
    resolveRemainingMinutes({ reportedRemainingSec: null, slicerTotalSec: null, elapsedSec: 120, progressPct: 2 }),
    98
  );
});

test("nothing known at all is null — never zero, never «now»", () => {
  assert.equal(
    resolveRemainingMinutes({ reportedRemainingSec: null, slicerTotalSec: null, elapsedSec: null, progressPct: null }),
    null
  );
  // Nonsense values are refused rather than propagated.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
    assert.equal(
      resolveRemainingMinutes({ reportedRemainingSec: bad, slicerTotalSec: null, elapsedSec: null, progressPct: null }),
      null,
      `reported ${bad}`
    );
    assert.equal(
      resolveRemainingMinutes({ reportedRemainingSec: null, slicerTotalSec: bad, elapsedSec: 60, progressPct: null }),
      null,
      `slicer total ${bad}`
    );
  }
});

test("Moonraker metadata: estimated_time is read, and only when it is real", () => {
  assert.equal(parseMoonrakerEstimatedTimeSec({ estimated_time: 7384.5 }), 7384.5);
  assert.equal(parseMoonrakerEstimatedTimeSec({ estimated_time: "3600" }), 3600);
  for (const bad of [0, -1, null, undefined, "", "soon", Number.NaN]) {
    assert.equal(parseMoonrakerEstimatedTimeSec({ estimated_time: bad }), null, `estimated_time ${String(bad)}`);
  }
  assert.equal(parseMoonrakerEstimatedTimeSec({}), null);
});
