import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyBufferMinutes,
  evaluateNightWindowFit,
  localMinutesInZone,
  remainingWindowMinutes,
  windowLengthMinutes
} from "./nightWindow";

const WINDOW = "21:30 – 07:30";

test("the ETA safety buffer is a FRACTION: 0.2 adds exactly 20%", () => {
  assert.equal(applyBufferMinutes(240, 0.2), 288, "4h + 20% = 4h48m");
  assert.equal(applyBufferMinutes(100, 0.2), 120);
  assert.equal(applyBufferMinutes(60, 0), 60, "no buffer is a no-op");
  // The historical bug: reading 0.2 as a multiplier silently REMOVED the margin
  // (Math.max(1, 0.2) === 1). A fraction can only ever extend the duration.
  assert.ok(applyBufferMinutes(240, 0.2) > 240, "a buffer never shortens a print");
});

test("a negative or non-finite buffer collapses to no buffer, never a shorter ETA", () => {
  assert.equal(applyBufferMinutes(120, -1), 120);
  assert.equal(applyBufferMinutes(120, Number.NaN), 120);
  assert.equal(applyBufferMinutes(120, Number.POSITIVE_INFINITY), 120);
});

test("windowLengthMinutes measures the whole window, wrapping midnight", () => {
  assert.equal(windowLengthMinutes(WINDOW), 600, "21:30 → 07:30 is 10h");
  assert.equal(windowLengthMinutes("08:00 – 17:00"), 540);
  assert.equal(windowLengthMinutes("nonsense"), null);
});

test("remaining window is measured from NOW, not the window's total length", () => {
  // 02:00 UTC inside 21:30–07:30 → 5h30m left, not the 10h nominal window.
  assert.equal(remainingWindowMinutes(WINDOW, new Date("2026-07-26T02:00:00Z"), "UTC"), 330);
  // 22:00, just after the window opens → 9h30m left.
  assert.equal(remainingWindowMinutes(WINDOW, new Date("2026-07-26T22:00:00Z"), "UTC"), 570);
  // 07:00, near the close → 30 minutes left.
  assert.equal(remainingWindowMinutes(WINDOW, new Date("2026-07-26T07:00:00Z"), "UTC"), 30);
  // Outside the window there is no remaining time (never the wait until it opens).
  assert.equal(remainingWindowMinutes(WINDOW, new Date("2026-07-26T12:00:00Z"), "UTC"), 0);
});

test("midnight crossing is continuous: 23:59 → 00:01 loses exactly two minutes", () => {
  const before = remainingWindowMinutes(WINDOW, new Date("2026-07-26T23:59:00Z"), "UTC");
  const after = remainingWindowMinutes(WINDOW, new Date("2026-07-27T00:01:00Z"), "UTC");
  assert.equal(before, 451);
  assert.equal(after, 449);
});

test("the window is read in the FARM timezone, not the process timezone", () => {
  const instant = new Date("2026-07-26T19:00:00Z"); // 22:00 in Moscow (UTC+3)
  assert.equal(localMinutesInZone(instant, "UTC"), 19 * 60);
  assert.equal(localMinutesInZone(instant, "Europe/Moscow"), 22 * 60);

  // In UTC the farm is not yet in its night window; in Moscow it is.
  assert.equal(remainingWindowMinutes(WINDOW, instant, "UTC"), 0);
  assert.equal(remainingWindowMinutes(WINDOW, instant, "Europe/Moscow"), 570);
});

test("an invalid timezone yields null (fail-closed), never a silent UTC fallback", () => {
  assert.equal(localMinutesInZone(new Date(), "Not/AZone"), null);
  assert.equal(remainingWindowMinutes(WINDOW, new Date(), "Not/AZone"), null);
  assert.equal(
    evaluateNightWindowFit({
      window: WINDOW,
      now: new Date(),
      timeZone: "Not/AZone",
      etaMinutes: 60,
      safetyBufferRatio: 0.2
    }),
    null
  );
});

test("an unparseable window yields null rather than an unchecked start", () => {
  assert.equal(
    evaluateNightWindowFit({
      window: "всю ночь",
      now: new Date("2026-07-26T02:00:00Z"),
      timeZone: "UTC",
      etaMinutes: 60,
      safetyBufferRatio: 0.2
    }),
    null
  );
});

test("the brief's worked example: 02:00, window ends 07:00, ETA 4h, buffer 20% → fits", () => {
  const fit = evaluateNightWindowFit({
    window: "21:00 – 07:00",
    now: new Date("2026-07-26T02:00:00Z"),
    timeZone: "UTC",
    etaMinutes: 240,
    safetyBufferRatio: 0.2
  });
  assert.ok(fit);
  assert.equal(fit.remainingMinutes, 300, "5 hours left of the window");
  assert.equal(fit.bufferedEtaMinutes, 288, "4h48m with the buffer");
  assert.equal(fit.fits, true);
});

test("the same ETA one hour later no longer fits — the check is against time LEFT", () => {
  const fit = evaluateNightWindowFit({
    window: "21:00 – 07:00",
    now: new Date("2026-07-26T03:00:00Z"),
    timeZone: "UTC",
    etaMinutes: 240,
    safetyBufferRatio: 0.2
  });
  assert.ok(fit);
  assert.equal(fit.remainingMinutes, 240);
  assert.equal(fit.bufferedEtaMinutes, 288);
  assert.equal(fit.fits, false, "288 > 240");
  // Against the *total* 10h window this same print would have passed — that was
  // the defect: a 4h print accepted at 06:00 because "the night is 10 hours long".
  assert.equal(windowLengthMinutes("21:00 – 07:00"), 600);
});

test("outside the window nothing fits, however short the print", () => {
  const fit = evaluateNightWindowFit({
    window: WINDOW,
    now: new Date("2026-07-26T12:00:00Z"),
    timeZone: "UTC",
    etaMinutes: 5,
    safetyBufferRatio: 0.2
  });
  assert.ok(fit);
  assert.equal(fit.insideWindow, false);
  assert.equal(fit.fits, false);
});
