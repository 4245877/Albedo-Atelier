import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultMinutesFor,
  operationMinutes,
  projectPrinterRelease,
  resolveReadiness
} from "./planning";
import type { OperatorAvailability } from "./schedule";
import { DEFAULT_OPERATION_MINUTES } from "./states";
import { MANUAL_OPERATION_TYPES, type ManualOperation, type ManualOperationType } from "./types";

/*
 * Readiness and the printer-release projection, as pure functions.
 *
 * The question under test is the one a morning plan depends on: given a printer
 * holding a finished part and an operator who is asleep until 08:00, when is the
 * machine usable again — and when must the honest answer be "unknown"?
 */

const NOW = new Date("2026-07-28T00:00:00Z"); // 03:00 MSK — the brief's night finish
const MORNING = new Date("2026-07-28T05:00:00Z"); // 08:00 MSK

function availability(over: Partial<OperatorAvailability> = {}): OperatorAvailability {
  return {
    presence: "AVAILABLE",
    operatorId: "op_1",
    nextAvailableAt: NOW,
    availableUntil: null,
    reason: "оператор доступен",
    resolved: true,
    ...over
  };
}

const ASLEEP = availability({
  presence: "ASLEEP",
  nextAvailableAt: MORNING,
  reason: "оператор спит"
});

const UNKNOWN = availability({
  presence: "UNKNOWN",
  nextAvailableAt: null,
  resolved: false,
  reason: "таймзона оператора не задана"
});

let seq = 0;

function operation(over: Partial<ManualOperation> = {}): ManualOperation {
  seq += 1;
  return {
    id: `mop_${seq}`,
    type: "PART_REMOVAL",
    state: "PENDING",
    printerId: "k2",
    assignmentId: null,
    taskId: null,
    bedCycleId: null,
    estimatedMinutes: null,
    windowStart: null,
    windowEnd: null,
    blocking: true,
    origin: "print_finished",
    reason: null,
    assignedOperatorId: null,
    confirmedBy: null,
    startedAt: null,
    completedAt: null,
    actualMinutes: null,
    readyAt: null,
    note: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    version: 1,
    metadata: {},
    ...over
  };
}

// ── Requirement 8: each type carries its own duration ───────────────────────

test("every operation type has its own default duration — none share one constant", () => {
  for (const type of MANUAL_OPERATION_TYPES) {
    const minutes = defaultMinutesFor(type);
    assert.equal(typeof minutes, "number", `${type} has a duration`);
    assert.ok((minutes as number) > 0, `${type} takes real time`);
  }
  // The two the brief calls out explicitly must not be the same number: a nozzle
  // change is a cool-down, a swap and a re-level; a material change is a purge.
  assert.notEqual(
    DEFAULT_OPERATION_MINUTES.NOZZLE_CHANGE,
    DEFAULT_OPERATION_MINUTES.MATERIAL_CHANGE,
    "замена сопла и замена материала занимают разное время"
  );
  assert.ok(
    DEFAULT_OPERATION_MINUTES.NOZZLE_CHANGE > DEFAULT_OPERATION_MINUTES.SPOOL_CHANGE,
    "a nozzle change is slower than swapping a spool of the same material"
  );
  assert.ok(
    DEFAULT_OPERATION_MINUTES.MATERIAL_CHANGE > DEFAULT_OPERATION_MINUTES.PART_REMOVAL,
    "a material change is slower than lifting a part off the plate"
  );
});

test("the stored estimate is the duration; a null one stays UNKNOWN rather than borrowing the default", () => {
  assert.equal(operationMinutes(operation({ type: "NOZZLE_CHANGE", estimatedMinutes: 40 })), 40);
  assert.equal(operationMinutes(operation({ estimatedMinutes: 0 })), 0, "zero is a real estimate");
  // The type default exists, but it is stamped at creation — never substituted on
  // read, or the fail-closed "unknown duration" branch could never fire.
  assert.equal(
    operationMinutes(operation({ type: "NOZZLE_CHANGE", estimatedMinutes: null })),
    null,
    "an unestimated operation reports unknown, not 25 minutes"
  );
  assert.equal(operationMinutes(operation({ type: "CALIBRATION", estimatedMinutes: Number.NaN })), null);
  assert.equal(defaultMinutesFor("CALIBRATION"), DEFAULT_OPERATION_MINUTES.CALIBRATION);
  assert.equal(defaultMinutesFor("NOT_A_TYPE" as ManualOperationType), null);
});

// ── Readiness ───────────────────────────────────────────────────────────────

test("an available operator makes an open operation ready now", () => {
  const verdict = resolveReadiness(operation(), availability(), NOW);
  assert.equal(verdict.ready, true);
  assert.equal(verdict.code, null);
  assert.equal(verdict.earliestAt?.toISOString(), NOW.toISOString());
});

test("a sleeping operator defers the operation to their next opening", () => {
  const verdict = resolveReadiness(operation(), ASLEEP, NOW);
  assert.equal(verdict.ready, false);
  assert.equal(verdict.code, "OPERATOR_UNAVAILABLE");
  assert.equal(verdict.earliestAt?.toISOString(), MORNING.toISOString());
  assert.match(verdict.reason, /спит/);
});

test("an unresolved schedule is not ready and names no earliest time (fail-closed)", () => {
  const verdict = resolveReadiness(operation(), UNKNOWN, NOW);
  assert.equal(verdict.ready, false);
  assert.equal(verdict.code, "SCHEDULE_UNKNOWN");
  assert.equal(verdict.earliestAt, null, "an unknown schedule must not imply 'soon'");
});

test("an operation window that has not opened defers even an available operator", () => {
  const later = new Date("2026-07-28T09:00:00Z");
  const verdict = resolveReadiness(
    operation({ windowStart: later.toISOString() }),
    availability(),
    NOW
  );
  assert.equal(verdict.ready, false);
  assert.equal(verdict.code, "WINDOW_NOT_OPEN");
  assert.equal(verdict.earliestAt?.toISOString(), later.toISOString());
});

test("the later of the two gates wins when both are shut", () => {
  const afterMorning = new Date("2026-07-28T07:00:00Z"); // 10:00 MSK, after the 08:00 opening
  const verdict = resolveReadiness(
    operation({ windowStart: afterMorning.toISOString() }),
    ASLEEP,
    NOW
  );
  assert.equal(verdict.earliestAt?.toISOString(), afterMorning.toISOString());
});

test("a finished or cancelled operation is never 'ready' again", () => {
  for (const state of ["COMPLETED", "CANCELLED"] as const) {
    const verdict = resolveReadiness(operation({ state }), availability(), NOW);
    assert.equal(verdict.ready, false, state);
    assert.equal(verdict.code, "NOT_OPEN", state);
  }
});

// ── Printer release projection ──────────────────────────────────────────────

test("a printer with no blocking operation is free now", () => {
  const projection = projectPrinterRelease([], availability(), NOW);
  assert.equal(projection.free, true);
  assert.equal(projection.releaseAt?.toISOString(), NOW.toISOString());
  assert.equal(projection.waitingForOperator, false);
});

test("the brief's example: a 03:00 finish releases the printer at 08:05, not at 03:00", () => {
  const projection = projectPrinterRelease(
    [operation({ type: "PART_REMOVAL", estimatedMinutes: 5 })],
    ASLEEP,
    NOW
  );
  assert.equal(projection.free, false);
  assert.equal(projection.waitingForOperator, true);
  assert.equal(
    projection.releaseAt?.toISOString(),
    "2026-07-28T05:05:00.000Z",
    "08:00 MSK opening + 5 minutes of work"
  );
});

test("blocking operations are sequential — one operator, one pair of hands", () => {
  const projection = projectPrinterRelease(
    [
      operation({ type: "PART_REMOVAL", estimatedMinutes: 5 }),
      operation({ type: "NOZZLE_CHANGE", estimatedMinutes: 25 })
    ],
    availability(),
    NOW
  );
  assert.equal(
    projection.releaseAt?.toISOString(),
    "2026-07-28T00:30:00.000Z",
    "5 + 25 minutes back to back, not max(5, 25)"
  );
  assert.equal(projection.blocking.length, 2);
});

test("a non-blocking operation does not hold the printer", () => {
  const projection = projectPrinterRelease(
    [operation({ type: "VISUAL_INSPECTION", blocking: false })],
    ASLEEP,
    NOW
  );
  assert.equal(projection.free, true, "an inspection is a quality check, not a collision risk");
});

test("an unknown duration collapses the whole projection to 'unknown', never a partial promise", () => {
  const projection = projectPrinterRelease(
    [
      operation({ type: "PART_REMOVAL", estimatedMinutes: 5 }),
      operation({ type: "CALIBRATION", estimatedMinutes: null })
    ],
    availability(),
    NOW
  );
  assert.equal(projection.free, false);
  assert.equal(projection.releaseAt, null);
  assert.match(projection.reason, /неизвест/);
});

test("an unresolved operator schedule makes the release time unknown", () => {
  const projection = projectPrinterRelease(
    [operation({ type: "PART_REMOVAL", estimatedMinutes: 5 })],
    UNKNOWN,
    NOW
  );
  assert.equal(projection.releaseAt, null, "no schedule ⇒ no release time, ever");
  assert.equal(projection.waitingForOperator, true);
});

test("an in-progress operation counts from now, not from the operator's next window", () => {
  const projection = projectPrinterRelease(
    [operation({ type: "NOZZLE_CHANGE", state: "IN_PROGRESS", estimatedMinutes: 25 })],
    ASLEEP,
    NOW
  );
  assert.equal(
    projection.releaseAt?.toISOString(),
    "2026-07-28T00:25:00.000Z",
    "somebody is evidently already doing it"
  );
});

test("a FAILED operation still holds the printer", () => {
  const projection = projectPrinterRelease(
    [operation({ type: "NOZZLE_CHANGE", state: "FAILED", estimatedMinutes: 25 })],
    availability(),
    NOW
  );
  assert.equal(projection.free, false, "a nozzle that is still clogged is not a ready printer");
});

test("completed and cancelled operations release the printer", () => {
  for (const state of ["COMPLETED", "CANCELLED"] as const) {
    const projection = projectPrinterRelease([operation({ state })], availability(), NOW);
    assert.equal(projection.free, true, state);
  }
});
