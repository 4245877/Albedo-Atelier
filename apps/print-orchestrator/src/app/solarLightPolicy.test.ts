import assert from "node:assert/strict";
import { test } from "node:test";

import type { LightScheduleConfig } from "../shared/env";
import { SolarLightPolicy, type SolarCalculator } from "./solarLightPolicy";

/*
 * The darkness schedule in isolation: solar transitions with offsets, the
 * midnight-crossing dark period, the per-local-date recompute, degradation to
 * the fallback window (and to "unknown" when even that window is broken) and
 * the one-shot warnings. Everything runs on an injected clock and calculator —
 * no dependence on the real current date. TZ=UTC, so farm-local == UTC here.
 */

function config(over: Partial<LightScheduleConfig> = {}): LightScheduleConfig {
  return {
    mode: "solar",
    latitude: 50.45,
    longitude: 30.52,
    onOffsetMinutes: -30,
    offOffsetMinutes: 30,
    onlyWhenActive: true,
    fallbackWindow: "16:00-08:00",
    issues: [],
    ...over
  };
}

/** Fixed sun for any requested day: sunrise 04:00 UTC, sunset 18:00 UTC. */
const fixedSun: SolarCalculator = (localNoon) => ({
  sunriseAt: new Date(Date.UTC(localNoon.getFullYear(), localNoon.getMonth(), localNoon.getDate(), 4, 0, 0)),
  sunsetAt: new Date(Date.UTC(localNoon.getFullYear(), localNoon.getMonth(), localNoon.getDate(), 18, 0, 0))
});

const at = (h: number, m = 0, day = 2): Date => new Date(Date.UTC(2026, 6, day, h, m, 0));

function policy(over: Partial<LightScheduleConfig> = {}, calculator: SolarCalculator = fixedSun) {
  const warnings: string[] = [];
  const instance = new SolarLightPolicy(config(over), {
    calculator,
    onWarning: (message) => warnings.push(message)
  });
  return { instance, warnings };
}

test("solar: dark from sunset+onOffset until sunrise+offOffset, crossing midnight", () => {
  const { instance } = policy();

  // Offsets: on 17:30 (18:00−30), off 04:30 (04:00+30).
  assert.equal(instance.assess(at(12, 0)).dark, false, "midday is light");
  assert.equal(instance.assess(at(17, 29)).dark, false, "one minute before the on point");
  assert.equal(instance.assess(at(17, 31)).dark, true, "30 min before sunset is already dark");
  assert.equal(instance.assess(at(23, 59)).dark, true, "before midnight");
  assert.equal(instance.assess(at(0, 10, 3)).dark, true, "after midnight (next date)");
  assert.equal(instance.assess(at(4, 29, 3)).dark, true, "just before sunrise+30");
  assert.equal(instance.assess(at(4, 31, 3)).dark, false, "30 min after sunrise is light");

  const midday = instance.assess(at(12, 0, 3));
  assert.equal(midday.source, "solar");
  assert.equal(midday.usingFallback, false);
});

test("solar: next transition points at the upcoming boundary", () => {
  const { instance } = policy();

  const morningDark = instance.assess(at(3, 0));
  assert.equal(morningDark.nextTransitionAt?.toISOString(), at(4, 30).toISOString());

  const day = instance.assess(at(12, 0));
  assert.equal(day.nextTransitionAt?.toISOString(), at(17, 30).toISOString());

  const evening = instance.assess(at(20, 0));
  assert.equal(
    evening.nextTransitionAt?.toISOString(),
    at(4, 30, 3).toISOString(),
    "after sunset the next switch is tomorrow's sunrise+offset"
  );
});

test("solar: the pair is computed once per local date and recomputed on rollover", () => {
  const requested: string[] = [];
  const counting: SolarCalculator = (localNoon, lat, lon) => {
    requested.push(localNoon.toISOString());
    return fixedSun(localNoon, lat, lon);
  };
  const { instance } = policy({}, counting);

  instance.assess(at(10, 0));
  instance.assess(at(15, 0));
  instance.assess(at(23, 0));
  // One day = exactly two calculator calls (today + tomorrow for the next-off).
  assert.deepEqual(requested, ["2026-07-02T12:00:00.000Z", "2026-07-03T12:00:00.000Z"]);

  instance.assess(at(1, 0, 3)); // date rollover → fresh pair for July 3rd
  assert.deepEqual(requested.slice(2), ["2026-07-03T12:00:00.000Z", "2026-07-04T12:00:00.000Z"]);
});

test("broken coordinates degrade to the fallback window with one warning, no crash", () => {
  const { instance, warnings } = policy({ latitude: null });

  const night = instance.assess(at(23, 0));
  assert.equal(night.dark, true, "23:00 is inside 16:00-08:00");
  assert.equal(night.source, "fallback");
  assert.equal(night.usingFallback, true);

  const day = instance.assess(at(12, 0));
  assert.equal(day.dark, false, "12:00 is outside 16:00-08:00");
  assert.equal(day.usingFallback, true);

  assert.equal(warnings.filter((w) => w.includes("резервное окно")).length, 1, "warned once");
});

test("a polar day (no sunrise/sunset) also lands on the fallback window", () => {
  const polar: SolarCalculator = () => ({ sunriseAt: null, sunsetAt: null });
  const { instance, warnings } = policy({ latitude: 78 }, polar);

  const verdict = instance.assess(at(23, 0));
  assert.equal(verdict.dark, true);
  assert.equal(verdict.source, "fallback");
  assert.equal(verdict.usingFallback, true);
  assert.equal(warnings.length, 1);
});

test("fallback window crosses midnight and reports its boundaries", () => {
  const { instance } = policy({ latitude: null, fallbackWindow: "16:00-08:00" });

  assert.equal(instance.assess(at(7, 59)).dark, true);
  assert.equal(instance.assess(at(8, 0)).dark, false);
  assert.equal(instance.assess(at(15, 59)).dark, false);
  assert.equal(instance.assess(at(16, 0)).dark, true);

  const day = instance.assess(at(12, 0));
  assert.equal(day.nextTransitionAt?.toISOString(), at(16, 0).toISOString());
  const night = instance.assess(at(23, 0));
  assert.equal(night.nextTransitionAt?.toISOString(), at(8, 0, 3).toISOString());
});

test("unusable window on top of unusable solar → darkness unknown (null), still no crash", () => {
  const { instance, warnings } = policy({ latitude: null, fallbackWindow: "16-8" });

  const verdict = instance.assess(at(23, 0));
  assert.equal(verdict.dark, null);
  assert.equal(verdict.source, "none");
  assert.equal(verdict.usingFallback, true);
  assert.ok(warnings.some((w) => w.includes("не читается")));
});

test("fixed mode switches on the window itself, without fallback semantics", () => {
  const { instance, warnings } = policy({ mode: "fixed", fallbackWindow: "21:30 – 07:30" });

  const night = instance.assess(at(23, 0));
  assert.equal(night.dark, true);
  assert.equal(night.source, "fixed");
  assert.equal(night.usingFallback, false);
  assert.equal(instance.assess(at(12, 0)).dark, false);
  assert.deepEqual(warnings, [], "a deliberate fixed window is not a degradation");
});

test("config issues are surfaced exactly once via onWarning", () => {
  const { instance, warnings } = policy({ issues: ["LIGHT_LATITUDE сломана"] });
  instance.assess(at(12, 0));
  instance.assess(at(13, 0));
  assert.deepEqual(warnings, ["LIGHT_LATITUDE сломана"]);
});

test("the real suncalc calculator produces sane Kyiv times (sanity, ballpark only)", () => {
  const real = new SolarLightPolicy(config(), { now: () => at(12, 0) });
  const verdict = real.assess(at(12, 0));
  // July midday in Kyiv is daylight; the next switch is this evening,
  // ~17:30–18:30 UTC (sunset ≈ 18:1x UTC minus the 30-minute offset).
  assert.equal(verdict.dark, false);
  assert.equal(verdict.source, "solar");
  const nextHourUtc = verdict.nextTransitionAt?.getUTCHours();
  assert.ok(
    nextHourUtc !== undefined && nextHourUtc >= 17 && nextHourUtc <= 18,
    `evening switch expected ~17:30–18:30 UTC, got ${verdict.nextTransitionAt?.toISOString()}`
  );
});
