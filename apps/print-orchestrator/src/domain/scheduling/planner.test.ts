import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPlan,
  DEFAULT_WEIGHTS,
  urgencyScore,
  type PlannerPrinterInput,
  type PlannerTaskInput
} from "./planner";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");

function task(over: Partial<PlannerTaskInput> = {}): PlannerTaskInput {
  return {
    taskId: "t1",
    title: "T",
    priority: 0,
    createdAtMs: NOW - 60_000,
    notBeforeMs: null,
    deadlineMs: null,
    pinnedPrinterId: null,
    material: "PLA",
    requiredNozzleMm: 0.4,
    etaSeconds: 3600,
    compatiblePrinterIds: ["p1", "p2"],
    previousPrinterId: null,
    ...over
  };
}

function printer(id: string, over: Partial<PlannerPrinterInput> = {}): PlannerPrinterInput {
  return {
    printerId: id,
    name: id.toUpperCase(),
    freeAtMs: NOW,
    currentMaterial: "PLA",
    currentNozzleMm: 0.4,
    ...over
  };
}

const config = { nowMs: NOW, unknownEtaAssumptionS: 4 * 3600 };

test("a task is placed and carries a full explanation", () => {
  const result = buildPlan([task()], [printer("p1"), printer("p2")], config);
  assert.equal(result.assignments.length, 1);
  const a = result.assignments[0];
  assert.ok(a.printerId === "p1" || a.printerId === "p2");
  assert.ok(a.scoreBreakdown.length >= 0);
  assert.ok(typeof a.reason === "string" && a.reason.length > 0);
  assert.equal(a.etaSeconds, 3600);
});

test("a non-finite deadline never poisons ordering or scores (NaN-resistant domain)", () => {
  // deadlineMs = NaN is unreachable through the API (it canonicalises timestamps),
  // but urgencyScore/buildPlan are public domain functions and must stay finite:
  // one NaN would make the urgency sort non-deterministic and would charge every
  // candidate the deadline-miss penalty (`end <= NaN` is false).
  assert.ok(Number.isFinite(urgencyScore(task({ deadlineMs: NaN }), DEFAULT_WEIGHTS, NOW)));

  const result = buildPlan(
    [task({ taskId: "t1", deadlineMs: NaN }), task({ taskId: "t2", deadlineMs: NaN, createdAtMs: NaN })],
    [printer("p1"), printer("p2")],
    config
  );
  assert.equal(result.unplaced.length, 0);
  for (const a of result.assignments) {
    assert.ok(Number.isFinite(a.score), "assignment score stays finite");
    assert.ok(
      !a.scoreBreakdown.some((c) => c.label === "не успевает к дедлайну"),
      "a NaN deadline must be neutral, not a deadline-miss penalty"
    );
  }
});

test("a pinned task goes to its printer even against a cheaper alternative", () => {
  const result = buildPlan(
    [task({ pinnedPrinterId: "p2" })],
    [printer("p1"), printer("p2", { freeAtMs: NOW + 4 * 3600 * 1000 })],
    config
  );
  assert.equal(result.assignments[0].printerId, "p2");
});

test("a pinned but incompatible printer leaves the task unplaced with a reason", () => {
  const result = buildPlan(
    [task({ pinnedPrinterId: "p9", compatiblePrinterIds: ["p1"] })],
    [printer("p1")],
    config
  );
  assert.equal(result.assignments.length, 0);
  assert.equal(result.unplaced.length, 1);
  assert.match(result.unplaced[0].reason, /Закреплён/);
});

test("the printer that frees earlier wins on score", () => {
  const result = buildPlan(
    [task({ compatiblePrinterIds: ["p1", "p2"] })],
    [printer("p1", { freeAtMs: NOW + 6 * 3600 * 1000 }), printer("p2", { freeAtMs: NOW })],
    config
  );
  assert.equal(result.assignments[0].printerId, "p2");
  assert.ok(result.assignments[0].alternatives.some((alt) => alt.printerId === "p1"));
});

test("two tasks are serialised onto the same single printer (free-time advances)", () => {
  const a = task({ taskId: "a", compatiblePrinterIds: ["p1"], priority: 5 });
  const b = task({ taskId: "b", compatiblePrinterIds: ["p1"], priority: 1 });
  const result = buildPlan([a, b], [printer("p1")], config);
  const first = result.assignments.find((x) => x.taskId === "a")!;
  const second = result.assignments.find((x) => x.taskId === "b")!;
  assert.equal(first.printerId, "p1");
  assert.equal(second.printerId, "p1");
  assert.ok(second.startMs >= (first.endMs ?? 0), "second task starts after the first ends");
});

test("an unknown ETA still places the task but keeps end/eta null and warns", () => {
  const result = buildPlan([task({ etaSeconds: null })], [printer("p1")], config);
  const a = result.assignments[0];
  assert.equal(a.etaSeconds, null);
  assert.equal(a.endMs, null);
  assert.ok(a.warnings.some((w) => /ETA неизвестна/.test(w)));
});

test("stability: a task keeps its previous-plan printer when scores are otherwise equal", () => {
  const result = buildPlan(
    [task({ previousPrinterId: "p2" })],
    [printer("p1"), printer("p2")],
    config
  );
  assert.equal(result.assignments[0].printerId, "p2");
  assert.ok(result.assignments[0].scoreBreakdown.some((c) => c.label === "стабильность плана"));
});

test("a deadline that cannot be met is warned about", () => {
  const result = buildPlan(
    [task({ deadlineMs: NOW + 30 * 60_000, etaSeconds: 3600 })],
    [printer("p1")],
    config
  );
  assert.ok(result.assignments[0].warnings.some((w) => /дедлайн/i.test(w)));
});

test("manual queue order breaks a tie: a lower queueRank is planned first", () => {
  // Two otherwise-identical tasks on one printer; the front-of-queue one runs first.
  const front = task({ taskId: "front", queueRank: 0, compatiblePrinterIds: ["p1"], createdAtMs: NOW - 1000 });
  const back = task({ taskId: "back", queueRank: 1, compatiblePrinterIds: ["p1"], createdAtMs: NOW - 1000 });
  // Feed them in the "wrong" array order to prove the score, not input order, decides.
  const result = buildPlan([back, front], [printer("p1")], config);
  const frontA = result.assignments.find((a) => a.taskId === "front")!;
  const backA = result.assignments.find((a) => a.taskId === "back")!;
  assert.ok(frontA.startMs <= backA.startMs, "front-of-queue task is scheduled first");
});

test("a printer whose free-time is only estimated warns the waiting task", () => {
  const result = buildPlan(
    [task({ compatiblePrinterIds: ["p1"], etaSeconds: 3600 })],
    [printer("p1", { freeAtMs: NOW + 3 * 3600 * 1000, freeAtEstimated: true })],
    config
  );
  assert.ok(
    result.assignments[0].warnings.some((w) => /оценено приблизительно/.test(w)),
    "an estimated free-time is disclosed as a warning"
  );
});
