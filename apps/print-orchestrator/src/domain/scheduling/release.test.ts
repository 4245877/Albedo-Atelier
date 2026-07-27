import assert from "node:assert/strict";
import { test } from "node:test";

import {
  projectFarmRelease,
  type MachineOccupancy,
  type NextOperatorSlot,
  type ReleaseOperationInput
} from "./release";

const NOW = Date.parse("2026-07-17T03:00:00.000Z");
const MIN = 60_000;
const H = 60 * MIN;

function machine(id: string, over: Partial<MachineOccupancy> = {}): MachineOccupancy {
  return { printerId: id, busy: false, busyUntilMs: NOW, busyLabel: "свободен", ...over };
}

function operation(
  id: string,
  printerId: string,
  over: Partial<ReleaseOperationInput> = {}
): ReleaseOperationInput {
  return {
    id,
    type: "PART_REMOVAL",
    label: "снятие готовой модели",
    printerId,
    inProgress: false,
    blocking: true,
    minutes: 5,
    windowStartMs: null,
    createdAtMs: NOW,
    ...over
  };
}

/** A fake operator: available every day from 08:00 UTC, asleep the rest. */
const nineToFive: NextOperatorSlot = (fromMs) => {
  const day = Math.floor(fromMs / (24 * H)) * 24 * H;
  const openings = [day + 8 * H, day + 24 * H + 8 * H];
  const inShift = fromMs >= day + 8 * H && fromMs < day + 20 * H;
  return inShift ? fromMs : (openings.find((o) => o >= fromMs) ?? null);
};

/** An operator whose schedule cannot be resolved at all. */
const noSchedule: NextOperatorSlot = () => null;

test("an idle printer with nothing owed on it is free now", () => {
  const out = projectFarmRelease({
    nowMs: NOW,
    machines: [machine("p1")],
    operations: [],
    nextOperatorSlot: nineToFive
  });
  assert.equal(out.get("p1")?.releaseAtMs, NOW);
  assert.equal(out.get("p1")?.code, "FREE");
});

test("a finished print does NOT free the printer until the part is removed", () => {
  // The brief's worked example: 03:00 finish, operator asleep until 08:00,
  // 5-minute removal → the printer is available at 08:05, not at 03:00.
  const out = projectFarmRelease({
    nowMs: NOW,
    machines: [machine("p1")],
    operations: [operation("op1", "p1")],
    nextOperatorSlot: nineToFive
  });
  const p1 = out.get("p1")!;
  assert.equal(p1.releaseAtMs, NOW + 5 * H + 5 * MIN, "08:05, not 03:00");
  assert.equal(p1.code, "AWAITING_OPERATOR");
  assert.equal(p1.waitingForOperator, true);

  const wait = p1.segments.find((s) => s.kind === "operator_wait")!;
  assert.equal(wait.startMs, NOW, "the forced idle starts when the print ended");
  assert.equal(wait.endMs, NOW + 5 * H, "and ends when the operator becomes available");
  const work = p1.segments.find((s) => s.kind === "operation")!;
  assert.equal(work.startMs, NOW + 5 * H);
  assert.equal(work.endMs, NOW + 5 * H + 5 * MIN);
});

test("one operator does not perform two operations at once", () => {
  // Three printers all finished overnight. The operator clears them one after
  // another from 08:00 — not all three at 08:05.
  const out = projectFarmRelease({
    nowMs: NOW,
    machines: [machine("p1"), machine("p2"), machine("p3")],
    operations: [
      operation("op1", "p1", { createdAtMs: NOW - 3000 }),
      operation("op2", "p2", { createdAtMs: NOW - 2000 }),
      operation("op3", "p3", { createdAtMs: NOW - 1000 })
    ],
    nextOperatorSlot: nineToFive
  });
  assert.equal(out.get("p1")?.releaseAtMs, NOW + 5 * H + 5 * MIN);
  assert.equal(out.get("p2")?.releaseAtMs, NOW + 5 * H + 10 * MIN);
  assert.equal(out.get("p3")?.releaseAtMs, NOW + 5 * H + 15 * MIN);
});

test("sequential operations on one printer add up (material change, then nozzle change)", () => {
  const out = projectFarmRelease({
    nowMs: NOW,
    machines: [machine("p1")],
    operations: [
      operation("op1", "p1", {
        type: "MATERIAL_CHANGE",
        label: "замена материала",
        minutes: 15,
        createdAtMs: NOW - 2000
      }),
      operation("op2", "p1", {
        type: "NOZZLE_CHANGE",
        label: "замена сопла",
        minutes: 25,
        createdAtMs: NOW - 1000
      })
    ],
    nextOperatorSlot: nineToFive
  });
  const p1 = out.get("p1")!;
  assert.equal(p1.releaseAtMs, NOW + 5 * H + 40 * MIN, "15 + 25 minutes, not max(15, 25)");
  assert.deepEqual(p1.blockingOperationIds, ["op1", "op2"]);
  assert.equal(p1.segments.filter((s) => s.kind === "operation").length, 2);
});

test("an operation with no estimated duration collapses the release to null", () => {
  const out = projectFarmRelease({
    nowMs: NOW,
    machines: [machine("p1")],
    operations: [operation("op1", "p1", { minutes: null })],
    nextOperatorSlot: nineToFive
  });
  const p1 = out.get("p1")!;
  assert.equal(p1.releaseAtMs, null, "unknown, never 'now'");
  assert.equal(p1.code, "RELEASE_UNKNOWN_DURATION");
  assert.ok(p1.segments.some((s) => s.kind === "unknown" && s.endMs === null));
});

test("an unresolvable operator schedule collapses the release to null", () => {
  const out = projectFarmRelease({
    nowMs: NOW,
    machines: [machine("p1")],
    operations: [operation("op1", "p1")],
    nextOperatorSlot: noSchedule
  });
  assert.equal(out.get("p1")?.releaseAtMs, null);
  assert.equal(out.get("p1")?.code, "RELEASE_UNKNOWN_SCHEDULE");
});

test("an unknown duration poisons the operator, so later printers are unknown too", () => {
  // One pair of hands: if we cannot say when the operator finishes the first job,
  // we cannot say when they start the second either. Fail-closed, farm-wide.
  const out = projectFarmRelease({
    nowMs: NOW,
    machines: [machine("p1"), machine("p2")],
    operations: [
      operation("op1", "p1", { minutes: null, createdAtMs: NOW - 2000 }),
      operation("op2", "p2", { createdAtMs: NOW - 1000 })
    ],
    nextOperatorSlot: nineToFive
  });
  assert.equal(out.get("p1")?.releaseAtMs, null);
  assert.equal(out.get("p2")?.releaseAtMs, null);
});

test("a later computable operation cannot repair an already-unknown printer", () => {
  const out = projectFarmRelease({
    nowMs: NOW,
    machines: [machine("p1")],
    operations: [
      operation("op1", "p1", { minutes: null, createdAtMs: NOW - 2000 }),
      operation("op2", "p1", { minutes: 5, createdAtMs: NOW - 1000 })
    ],
    nextOperatorSlot: nineToFive
  });
  assert.equal(out.get("p1")?.releaseAtMs, null);
});

test("a printing machine with no remaining time is busy-unknown, never free", () => {
  const out = projectFarmRelease({
    nowMs: NOW,
    machines: [machine("p1", { busy: true, busyUntilMs: null, busyLabel: "печатает" })],
    operations: [],
    nextOperatorSlot: nineToFive
  });
  assert.equal(out.get("p1")?.releaseAtMs, null);
  assert.equal(out.get("p1")?.code, "MACHINE_BUSY_UNKNOWN");
});

test("an in-progress operation is being done now, not at the next operator window", () => {
  const out = projectFarmRelease({
    nowMs: NOW,
    machines: [machine("p1")],
    operations: [operation("op1", "p1", { inProgress: true, minutes: 5 })],
    nextOperatorSlot: nineToFive
  });
  const p1 = out.get("p1")!;
  assert.equal(p1.releaseAtMs, NOW + 5 * MIN, "hands are already on it at 03:00");
  assert.equal(p1.code, "OPERATION_IN_PROGRESS");
});

test("a non-blocking operation is reported but does not hold the printer", () => {
  const out = projectFarmRelease({
    nowMs: NOW,
    machines: [machine("p1")],
    operations: [
      operation("op1", "p1", { blocking: false, type: "VISUAL_INSPECTION", label: "визуальная проверка" })
    ],
    nextOperatorSlot: nineToFive
  });
  assert.equal(out.get("p1")?.releaseAtMs, NOW);
  assert.equal(out.get("p1")?.code, "FREE");
});

test("the projection is deterministic regardless of operation array order", () => {
  const ops = [
    operation("opB", "p2", { createdAtMs: NOW - 1000 }),
    operation("opA", "p1", { createdAtMs: NOW - 1000 })
  ];
  const run = (list: ReleaseOperationInput[]): (number | null)[] => {
    const out = projectFarmRelease({
      nowMs: NOW,
      machines: [machine("p1"), machine("p2")],
      operations: list,
      nextOperatorSlot: nineToFive
    });
    return [out.get("p1")!.releaseAtMs, out.get("p2")!.releaseAtMs];
  };
  assert.deepEqual(run(ops), run([...ops].reverse()));
});

test("an operation waits for its own window even when the operator is available", () => {
  const noon = Date.parse("2026-07-17T12:00:00.000Z");
  const out = projectFarmRelease({
    nowMs: noon,
    machines: [machine("p1", { busyUntilMs: noon })],
    operations: [operation("op1", "p1", { windowStartMs: noon + 2 * H })],
    nextOperatorSlot: nineToFive
  });
  assert.equal(out.get("p1")?.releaseAtMs, noon + 2 * H + 5 * MIN);
});
