import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseLightScheduleEnv,
  readBoolean,
  readInteger,
  readLogLevel,
  readNonNegativeInt,
  readNonNegativeNumber,
  readPort,
  readPositiveInt,
  readPositiveNumber
} from "./env";

/*
 * Strict scalar parsing: unset/blank → default, valid → the value, and any
 * malformed value fails fast with a message naming the variable. The point is
 * that a corrupted limit/interval/flag can never be silently accepted (the old
 * parseInt/parseFloat kept the leading digits of "200MB"/"1.5x").
 */

const N = "TEST_VAR";

test("readInteger: blank/unset → default, valid parsed, garbage & non-integers rejected", () => {
  assert.equal(readInteger(N, undefined, 7), 7);
  assert.equal(readInteger(N, "", 7), 7);
  assert.equal(readInteger(N, "   ", 7), 7, "whitespace-only is treated as unset");
  assert.equal(readInteger(N, "42", 7), 42);
  assert.equal(readInteger(N, "  42  ", 7), 42, "surrounding whitespace is trimmed");
  assert.equal(readInteger(N, "-5", 7), -5, "plain readInteger allows negatives");
  assert.equal(readInteger(N, "1e3", 7), 1000, "scientific notation that is integral is accepted");
  assert.equal(readInteger(N, "0x10", 7), 16, "a complete hex literal is a valid number, not garbage");
  // Only a value that is NOT a complete finite numeric literal, or is non-integral,
  // is rejected — crucially the unit-suffixed values the old parseInt accepted.
  for (const bad of ["200MB", "10abc", "1.5", "1.5x", "abc", "NaN", "Infinity"]) {
    assert.throws(() => readInteger(N, bad, 7), /Invalid TEST_VAR/, `must reject «${bad}»`);
  }
});

test("readPositiveInt: rejects zero, negatives and the 200MB-style suffix", () => {
  assert.equal(readPositiveInt(N, undefined, 200), 200);
  assert.equal(readPositiveInt(N, "1", 200), 1);
  for (const bad of ["0", "-1", "200MB", "1.5"]) {
    assert.throws(() => readPositiveInt(N, bad, 200), /Invalid TEST_VAR/, `must reject «${bad}»`);
  }
});

test("readNonNegativeInt: allows 0, rejects negatives", () => {
  assert.equal(readNonNegativeInt(N, "0", 5), 0);
  assert.equal(readNonNegativeInt(N, "1200", 5), 1200);
  assert.throws(() => readNonNegativeInt(N, "-1", 5), /must be ≥ 0/);
});

test("readPort: only 1…65535", () => {
  assert.equal(readPort(N, "3100", 3100), 3100);
  assert.equal(readPort(N, "65535", 3100), 65535);
  assert.throws(() => readPort(N, "0", 3100), /must be ≥ 1/);
  assert.throws(() => readPort(N, "70000", 3100), /must be ≤ 65535/);
});

test("readPositiveNumber vs readNonNegativeNumber differ only at zero", () => {
  assert.equal(readPositiveNumber(N, "200", 200), 200);
  assert.throws(() => readPositiveNumber(N, "0", 200), /greater than 0/);
  assert.throws(() => readPositiveNumber(N, "-0.5", 200), /greater than 0/);

  assert.equal(readNonNegativeNumber(N, "0", 0.2), 0);
  assert.equal(readNonNegativeNumber(N, "0.2", 0.2), 0.2);
  assert.throws(() => readNonNegativeNumber(N, "-0.2", 0.2), /must be ≥ 0/);
  assert.throws(() => readNonNegativeNumber(N, "1.5x", 0.2), /finite number/);
});

test("readBoolean: known tokens map, unset → default, a typo fails fast", () => {
  for (const t of ["true", "1", "YES", "on", " On "]) assert.equal(readBoolean(N, t, false), true, t);
  for (const f of ["false", "0", "no", "OFF"]) assert.equal(readBoolean(N, f, true), false, f);
  assert.equal(readBoolean(N, undefined, true), true);
  assert.equal(readBoolean(N, "  ", false), false);
  for (const bad of ["ture", "maybe", "2", "y"]) {
    assert.throws(() => readBoolean(N, bad, false), /expected a boolean/, `must reject «${bad}»`);
  }
});

test("readLogLevel: pino levels only, case-insensitive, unknown fails fast", () => {
  assert.equal(readLogLevel(undefined, "info"), "info");
  assert.equal(readLogLevel("DEBUG", "info"), "debug");
  assert.equal(readLogLevel("  warn ", "info"), "warn");
  for (const bad of ["verbose", "warning", "loud"]) {
    assert.throws(() => readLogLevel(bad, "info"), /Invalid LOG_LEVEL/, `must reject «${bad}»`);
  }
});

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
