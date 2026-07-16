import assert from "node:assert/strict";
import { test } from "node:test";

import { parseLightScheduleEnv } from "./env";

/*
 * Lenient LIGHT_* parsing: invalid values never throw (the farm must keep
 * running) — they are replaced by defaults and recorded as issues, which the
 * policy later surfaces as warnings. NIGHT_PRINT_WINDOW is only the legacy
 * migration source for fixed mode.
 */

const NIGHT = "21:30 – 07:30";

test("defaults: solar mode over Kyiv with −30/+30 offsets and the 16:00-08:00 fallback", () => {
  const config = parseLightScheduleEnv({}, NIGHT);
  assert.deepEqual(config, {
    mode: "solar",
    latitude: 50.45,
    longitude: 30.52,
    onOffsetMinutes: -30,
    offOffsetMinutes: 30,
    onlyWhenActive: true,
    fallbackWindow: "16:00-08:00",
    issues: []
  });
});

test("explicit valid values are taken verbatim", () => {
  const config = parseLightScheduleEnv(
    {
      LIGHT_SCHEDULE_MODE: "solar",
      LIGHT_LATITUDE: "59.94",
      LIGHT_LONGITUDE: "30.31",
      LIGHT_ON_OFFSET_MINUTES: "-15",
      LIGHT_OFF_OFFSET_MINUTES: "45",
      LIGHT_ONLY_WHEN_ACTIVE: "false",
      LIGHT_FALLBACK_WINDOW: "17:00-09:00"
    },
    NIGHT
  );
  assert.equal(config.latitude, 59.94);
  assert.equal(config.longitude, 30.31);
  assert.equal(config.onOffsetMinutes, -15);
  assert.equal(config.offOffsetMinutes, 45);
  assert.equal(config.onlyWhenActive, false);
  assert.equal(config.fallbackWindow, "17:00-09:00");
  assert.deepEqual(config.issues, []);
});

test("garbage never throws: every broken value degrades to its default with an issue", () => {
  const config = parseLightScheduleEnv(
    {
      LIGHT_SCHEDULE_MODE: "lunar",
      LIGHT_LATITUDE: "abc",
      LIGHT_LONGITUDE: "999",
      LIGHT_ON_OFFSET_MINUTES: "sunset",
      LIGHT_OFF_OFFSET_MINUTES: "100000",
      LIGHT_ONLY_WHEN_ACTIVE: "maybe",
      LIGHT_FALLBACK_WINDOW: "16-8"
    },
    NIGHT
  );
  assert.equal(config.mode, "solar");
  assert.equal(config.latitude, null, "unusable latitude → solar impossible, not a crash");
  assert.equal(config.longitude, null);
  assert.equal(config.onOffsetMinutes, -30);
  assert.equal(config.offOffsetMinutes, 30);
  assert.equal(config.onlyWhenActive, true);
  assert.equal(config.fallbackWindow, "16:00-08:00");
  assert.equal(config.issues.length, 7, "each broken value is reported");
});

test("fixed mode without an explicit window migrates the legacy NIGHT_PRINT_WINDOW", () => {
  const migrated = parseLightScheduleEnv({ LIGHT_SCHEDULE_MODE: "fixed" }, NIGHT);
  assert.equal(migrated.mode, "fixed");
  assert.equal(migrated.fallbackWindow, NIGHT, "pre-solar schedule preserved");
  assert.deepEqual(migrated.issues, []);

  const explicit = parseLightScheduleEnv(
    { LIGHT_SCHEDULE_MODE: "fixed", LIGHT_FALLBACK_WINDOW: "20:00-06:00" },
    NIGHT
  );
  assert.equal(explicit.fallbackWindow, "20:00-06:00");
});

test("fixed mode with a broken legacy window still ends up with a usable default", () => {
  const config = parseLightScheduleEnv({ LIGHT_SCHEDULE_MODE: "fixed" }, "whenever");
  assert.equal(config.fallbackWindow, "16:00-08:00");
  assert.equal(config.issues.length, 1);
});
