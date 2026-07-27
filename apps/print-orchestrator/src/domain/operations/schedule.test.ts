import assert from "node:assert/strict";
import { test } from "node:test";

import {
  effectiveWindowsForDate,
  isValidTimeZone,
  localWeekdayInZone,
  resolveAvailability,
  resolveFarmAvailability,
  shiftLocalDate,
  weekdayOfLocalDate,
  zonedWallClockToUtc,
  type OperatorScheduleInput
} from "./schedule";
import type {
  Operator,
  OperatorAbsence,
  ScheduleException,
  ScheduleRule,
  ScheduleTrack,
  Weekday
} from "./types";

/*
 * The operator-availability arithmetic, as a pure function of (schedule, instant).
 *
 * Everything here uses a **fake clock** — an explicit `Date` passed in — and
 * touches no store, no printer and no network. That is the point: the answer to
 * "is somebody there at 03:00?" must be reproducible, and a test that depended
 * on the machine's own clock or `TZ` could not check the DST behaviour at all.
 */

const OPERATOR: Operator = {
  id: "op_1",
  name: "Оператор",
  timeZone: "Europe/Moscow",
  active: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
  metadata: {}
};

let seq = 0;

function rule(track: ScheduleTrack, weekday: Weekday, start: number, end: number): ScheduleRule {
  seq += 1;
  return {
    id: `shr_${seq}`,
    operatorId: OPERATOR.id,
    track,
    weekday,
    startMinutes: start,
    endMinutes: end,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    metadata: {}
  };
}

/** `"HH:MM"` → minutes, so the tests read like the schedule an operator types. */
function at(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** The same window on every weekday — the common "I work these hours" shape. */
function everyDay(track: ScheduleTrack, start: string, end: string): ScheduleRule[] {
  return ([0, 1, 2, 3, 4, 5, 6] as Weekday[]).map((d) => rule(track, d, at(start), at(end)));
}

function exception(over: Partial<ScheduleException> & { date: string }): ScheduleException {
  seq += 1;
  return {
    id: `shx_${seq}`,
    operatorId: OPERATOR.id,
    kind: "available",
    startMinutes: null,
    endMinutes: null,
    note: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    metadata: {},
    ...over
  };
}

function absence(startsAt: string, endsAt: string | null, reason = "отпуск"): OperatorAbsence {
  seq += 1;
  return {
    id: `abs_${seq}`,
    operatorId: OPERATOR.id,
    startsAt,
    endsAt,
    reason,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    metadata: {}
  };
}

function schedule(over: Partial<OperatorScheduleInput> = {}): OperatorScheduleInput {
  return {
    operator: OPERATOR,
    rules: everyDay("available", "08:00", "23:00"),
    exceptions: [],
    absences: [],
    ...over
  };
}

// ── Zone plumbing ───────────────────────────────────────────────────────────

test("isValidTimeZone accepts IANA ids and refuses everything else", () => {
  assert.equal(isValidTimeZone("Europe/Moscow"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Not/AZone"), false);
  assert.equal(isValidTimeZone(""), false);
  assert.equal(isValidTimeZone(null), false);
  assert.equal(isValidTimeZone("MSK+3"), false);
});

test("weekday is read from the LOCAL calendar date, not the process timezone", () => {
  // 2026-07-27 is a Monday. At 22:00 UTC it is already Tuesday in Moscow (+03).
  assert.equal(weekdayOfLocalDate("2026-07-27"), 1);
  assert.equal(localWeekdayInZone(new Date("2026-07-27T22:00:00Z"), "Europe/Moscow"), 2);
  assert.equal(localWeekdayInZone(new Date("2026-07-27T22:00:00Z"), "UTC"), 1);
});

test("shiftLocalDate walks the plain calendar, including across months", () => {
  assert.equal(shiftLocalDate("2026-07-31", 1), "2026-08-01");
  assert.equal(shiftLocalDate("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftLocalDate("nonsense", 1), null);
});

test("zonedWallClockToUtc maps a local wall clock to the right instant", () => {
  // Moscow is UTC+3 all year (no DST since 2014).
  assert.equal(
    zonedWallClockToUtc("2026-07-27", at("08:00"), "Europe/Moscow")?.toISOString(),
    "2026-07-27T05:00:00.000Z"
  );
  assert.equal(
    zonedWallClockToUtc("2026-07-27", at("08:00"), "UTC")?.toISOString(),
    "2026-07-27T08:00:00.000Z"
  );
  assert.equal(zonedWallClockToUtc("2026-07-27", at("08:00"), "Not/AZone"), null);
});

// ── Requirement 5: IANA timezone and the DST transition ─────────────────────

test("a wall-clock window keeps its LOCAL hour across a DST transition", () => {
  // Berlin: CEST (+02) until 2026-10-25 03:00, CET (+01) after.
  const before = zonedWallClockToUtc("2026-10-24", at("08:00"), "Europe/Berlin");
  const after = zonedWallClockToUtc("2026-10-26", at("08:00"), "Europe/Berlin");
  assert.equal(before?.toISOString(), "2026-10-24T06:00:00.000Z", "08:00 CEST = 06:00Z");
  assert.equal(after?.toISOString(), "2026-10-26T07:00:00.000Z", "08:00 CET = 07:00Z");
  // The instants differ by 48h + 1h — proof the schedule followed the wall clock
  // rather than drifting with a fixed offset.
  assert.equal(after!.getTime() - before!.getTime(), 49 * 3_600_000);
});

test("spring-forward: a local time that does not exist resolves to the first real instant after the gap", () => {
  // Berlin 2026-03-29: 02:00 → 03:00, so 02:30 never happens.
  const resolved = zonedWallClockToUtc("2026-03-29", at("02:30"), "Europe/Berlin");
  assert.ok(resolved, "a nonexistent wall clock still resolves (forward), never null");
  assert.equal(resolved!.toISOString(), "2026-03-29T01:30:00.000Z");
  // 01:30Z is 03:30 local — i.e. after the gap, not an hour before it.
  const localHour = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    hourCycle: "h23"
  }).format(resolved!);
  assert.equal(localHour, "03");
});

test("availability across a DST change is evaluated in the operator's zone, not the process one", () => {
  const berlin: Operator = { ...OPERATOR, timeZone: "Europe/Berlin" };
  const input = schedule({ operator: berlin, rules: everyDay("available", "08:00", "18:00") });

  // 07:30Z on 2026-10-24 is 09:30 CEST → inside the window.
  assert.equal(resolveAvailability(input, new Date("2026-10-24T07:30:00Z")).presence, "AVAILABLE");
  // The same 07:30Z on 2026-10-26 is 08:30 CET → still inside.
  assert.equal(resolveAvailability(input, new Date("2026-10-26T07:30:00Z")).presence, "AVAILABLE");
  // 06:30Z after the change is 07:30 CET → before the window opens.
  assert.equal(resolveAvailability(input, new Date("2026-10-26T06:30:00Z")).presence, "OFF");
  // …but the same 06:30Z before the change was 08:30 CEST → inside it.
  assert.equal(resolveAvailability(input, new Date("2026-10-23T06:30:00Z")).presence, "AVAILABLE");
});

// ── Requirement 4: sleep crossing midnight ──────────────────────────────────

test("a sleep window crossing midnight covers both sides of it", () => {
  const input = schedule({
    rules: [...everyDay("available", "08:00", "23:00"), ...everyDay("sleep", "23:00", "07:00")]
  });
  const msk = (iso: string): string => resolveAvailability(input, new Date(iso)).presence;

  // 2026-07-27 is a Monday; Moscow = UTC+3.
  assert.equal(msk("2026-07-27T19:00:00Z"), "AVAILABLE", "22:00 MSK — the window has not opened yet");
  assert.equal(msk("2026-07-27T20:30:00Z"), "ASLEEP", "23:30 MSK — before midnight, asleep");
  assert.equal(msk("2026-07-27T21:00:00Z"), "ASLEEP", "00:00 MSK Tue — after midnight, still asleep");
  assert.equal(msk("2026-07-28T00:00:00Z"), "ASLEEP", "03:00 MSK — deep in the wrapped window");
  assert.equal(msk("2026-07-28T04:30:00Z"), "OFF", "07:30 MSK — awake (sleep ended at 07:00), not yet on shift");
  assert.equal(msk("2026-07-28T05:30:00Z"), "AVAILABLE", "08:30 MSK — on shift");
  assert.equal(msk("2026-07-27T17:00:00Z"), "AVAILABLE", "20:00 MSK — still the evening window");
});

test("sleep wins over an overlapping availability window", () => {
  // Deliberately overlapping: available all day, asleep 23:00–07:00.
  const input = schedule({
    rules: [...everyDay("available", "00:00", "00:00"), ...everyDay("sleep", "23:00", "07:00")]
  });
  assert.equal(
    resolveAvailability(input, new Date("2026-07-28T00:00:00Z")).presence,
    "ASLEEP",
    "03:00 MSK is inside both tracks — sleep decides"
  );
});

// ── Requirement 1: night finish, morning operator ───────────────────────────

test("at 03:00 the operator is asleep and the next opening is 08:00 the same morning", () => {
  const input = schedule({
    rules: [...everyDay("available", "08:00", "20:00"), ...everyDay("sleep", "23:00", "07:00")]
  });
  // 2026-07-28T00:00Z = 03:00 MSK — the brief's "печать завершилась в 03:00".
  const night = resolveAvailability(input, new Date("2026-07-28T00:00:00Z"));
  assert.equal(night.presence, "ASLEEP");
  assert.equal(
    night.nextAvailableAt?.toISOString(),
    "2026-07-28T05:00:00.000Z",
    "08:00 MSK is the first performable moment"
  );

  const morning = resolveAvailability(input, new Date("2026-07-28T05:00:00Z"));
  assert.equal(morning.presence, "AVAILABLE");
  assert.equal(morning.nextAvailableAt?.toISOString(), "2026-07-28T05:00:00.000Z", "already there");
  assert.equal(morning.availableUntil?.toISOString(), "2026-07-28T17:00:00.000Z", "until 20:00 MSK");
});

test("between the sleep window and the shift start the operator is OFF, not asleep", () => {
  const input = schedule({
    rules: [...everyDay("available", "09:00", "18:00"), ...everyDay("sleep", "23:00", "07:00")]
  });
  const early = resolveAvailability(input, new Date("2026-07-28T05:00:00Z")); // 08:00 MSK
  assert.equal(early.presence, "OFF", "awake but not on shift");
  assert.equal(early.nextAvailableAt?.toISOString(), "2026-07-28T06:00:00.000Z");
});

// ── Requirement 6: a date exception overrides the weekly schedule ───────────

test("effectiveWindowsForDate: an exception REPLACES the weekday's rules, never extends them", () => {
  const input = schedule({
    rules: everyDay("available", "08:00", "20:00"),
    exceptions: [exception({ date: "2026-07-28", kind: "available", startMinutes: at("12:00"), endMinutes: at("16:00") })]
  });
  assert.deepEqual(effectiveWindowsForDate(input, "available", "2026-07-27"), [
    { startMinutes: at("08:00"), endMinutes: at("20:00") }
  ]);
  assert.deepEqual(
    effectiveWindowsForDate(input, "available", "2026-07-28"),
    [{ startMinutes: at("12:00"), endMinutes: at("16:00") }],
    "the usual 08:00–20:00 is gone, not merged with 12:00–16:00"
  );
});

test("a date exception narrows availability for that date only", () => {
  const input = schedule({
    rules: everyDay("available", "08:00", "20:00"),
    exceptions: [exception({ date: "2026-07-28", kind: "available", startMinutes: at("12:00"), endMinutes: at("16:00") })]
  });
  const msk = (iso: string): string => resolveAvailability(input, new Date(iso)).presence;

  assert.equal(msk("2026-07-27T06:00:00Z"), "AVAILABLE", "09:00 MSK Monday — normal week");
  assert.equal(msk("2026-07-28T06:00:00Z"), "OFF", "09:00 MSK Tuesday — outside the exception");
  assert.equal(msk("2026-07-28T10:00:00Z"), "AVAILABLE", "13:00 MSK Tuesday — inside it");
  assert.equal(msk("2026-07-29T06:00:00Z"), "AVAILABLE", "09:00 MSK Wednesday — back to normal");
});

test("an `off` exception blanks the whole date whatever the weekly rules say", () => {
  const input = schedule({
    rules: everyDay("available", "08:00", "20:00"),
    exceptions: [exception({ date: "2026-07-28", kind: "off", note: "выходной" })]
  });
  const day = resolveAvailability(input, new Date("2026-07-28T10:00:00Z"));
  assert.equal(day.presence, "OFF");
  assert.equal(
    day.nextAvailableAt?.toISOString(),
    "2026-07-29T05:00:00.000Z",
    "the next opening is the following day at 08:00 MSK"
  );
});

// ── Absences ────────────────────────────────────────────────────────────────

test("an absence beats the schedule, and availability resumes when it ends", () => {
  const input = schedule({
    rules: everyDay("available", "08:00", "20:00"),
    absences: [absence("2026-07-27T00:00:00Z", "2026-07-29T00:00:00Z", "отпуск")]
  });
  const away = resolveAvailability(input, new Date("2026-07-28T10:00:00Z"));
  assert.equal(away.presence, "AWAY");
  assert.match(away.reason, /отпуск/);
  assert.equal(
    away.nextAvailableAt?.toISOString(),
    "2026-07-29T05:00:00.000Z",
    "the first window after the absence ends"
  );
  assert.equal(resolveAvailability(input, new Date("2026-07-29T10:00:00Z")).presence, "AVAILABLE");
});

test("an open-ended absence never resolves to a next opening", () => {
  const input = schedule({ absences: [absence("2026-07-01T00:00:00Z", null, "бессрочно")] });
  const away = resolveAvailability(input, new Date("2026-07-28T10:00:00Z"));
  assert.equal(away.presence, "AWAY");
  assert.equal(away.nextAvailableAt, null, "unknown, and never guessed as 'soon'");
});

// ── Requirement 7: unknown is not "no" ──────────────────────────────────────

test("an unresolvable schedule is UNKNOWN and unresolved — never OFF", () => {
  const cases: [string, OperatorScheduleInput | null][] = [
    ["no operator at all", null],
    ["no timezone", schedule({ operator: { ...OPERATOR, timeZone: null } })],
    ["a bad timezone", schedule({ operator: { ...OPERATOR, timeZone: "Nowhere/Land" } })],
    ["an inactive operator", schedule({ operator: { ...OPERATOR, active: false } })]
  ];
  for (const [label, input] of cases) {
    const result = resolveAvailability(input, new Date("2026-07-28T10:00:00Z"));
    assert.equal(result.presence, "UNKNOWN", label);
    assert.equal(result.resolved, false, label);
    assert.equal(result.nextAvailableAt, null, `${label}: no invented opening`);
  }
});

test("a valid zone with NO rules is a resolved OFF with no opening — a known 'no'", () => {
  const result = resolveAvailability(schedule({ rules: [] }), new Date("2026-07-28T10:00:00Z"));
  assert.equal(result.presence, "OFF");
  assert.equal(result.resolved, true, "the schedule parsed; it simply says nothing is scheduled");
  assert.equal(result.nextAvailableAt, null);
});

// ── Multiple operators ──────────────────────────────────────────────────────

test("the farm is available when ANY operator is; an empty roster is UNKNOWN", () => {
  const early = schedule({ rules: everyDay("available", "06:00", "14:00") });
  const late = schedule({
    operator: { ...OPERATOR, id: "op_2", name: "Второй" },
    rules: everyDay("available", "14:00", "22:00")
  });

  assert.equal(resolveFarmAvailability([], new Date("2026-07-28T10:00:00Z")).presence, "UNKNOWN");
  // 08:00 MSK — only the early shift.
  assert.equal(
    resolveFarmAvailability([early, late], new Date("2026-07-28T05:00:00Z")).presence,
    "AVAILABLE"
  );
  // 20:00 MSK — only the late shift.
  const evening = resolveFarmAvailability([early, late], new Date("2026-07-28T17:00:00Z"));
  assert.equal(evening.presence, "AVAILABLE");
  assert.equal(evening.operatorId, "op_2");
  // 03:00 MSK — neither; the soonest opening across the roster is the early one.
  const night = resolveFarmAvailability([early, late], new Date("2026-07-28T00:00:00Z"));
  assert.notEqual(night.presence, "AVAILABLE");
  assert.equal(night.nextAvailableAt?.toISOString(), "2026-07-28T03:00:00.000Z", "06:00 MSK");
});
