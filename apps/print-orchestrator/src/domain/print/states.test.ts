import assert from "node:assert/strict";
import { test } from "node:test";

import { StateTransitionError } from "../../core/errors";
import {
  ASSIGNMENT_TRANSITIONS,
  assertTransition,
  BED_CYCLE_TRANSITIONS,
  canTransition,
  DISPATCH_ATTEMPT_TRANSITIONS,
  isTerminal,
  PRINT_RUN_TRANSITIONS,
  PRINT_TASK_TRANSITIONS,
  QUEUE_ENTRY_TRANSITIONS
} from "./states";
import { ACTIVE_RUN_STATES } from "./types";
import type { PrintRunState } from "./types";

test("a self-transition is always allowed (idempotent setters never throw)", () => {
  assert.ok(canTransition(PRINT_TASK_TRANSITIONS, "PRINTING", "PRINTING"));
  assert.doesNotThrow(() =>
    assertTransition("задание", PRINT_TASK_TRANSITIONS, "COMPLETED", "COMPLETED")
  );
});

test("PrintTask: the happy path is legal end to end", () => {
  const path = [
    ["DRAFT", "QUEUED"],
    ["QUEUED", "ASSIGNED"],
    ["ASSIGNED", "DISPATCHING"],
    ["DISPATCHING", "PRINTING"],
    ["PRINTING", "COMPLETED"]
  ] as const;
  for (const [from, to] of path) {
    assert.ok(canTransition(PRINT_TASK_TRANSITIONS, from, to), `${from} → ${to}`);
  }
});

test("PrintTask: launched terminal states are dead-ends (a launched task is not deleted, just frozen)", () => {
  assert.ok(isTerminal(PRINT_TASK_TRANSITIONS, "COMPLETED"));
  assert.ok(isTerminal(PRINT_TASK_TRANSITIONS, "CANCELLED"));
  // FAILED is the one non-dead terminal: it may be re-queued for a retry.
  assert.ok(!isTerminal(PRINT_TASK_TRANSITIONS, "FAILED"));
  assert.ok(canTransition(PRINT_TASK_TRANSITIONS, "FAILED", "QUEUED"));
});

test("PrintTask: an illegal jump throws StateTransitionError with a 409", () => {
  assert.throws(
    () => assertTransition("задание", PRINT_TASK_TRANSITIONS, "COMPLETED", "PRINTING"),
    (err: unknown) => {
      assert.ok(err instanceof StateTransitionError);
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "STATE_TRANSITION");
      return true;
    }
  );
});

test("BedCycle: the brief's cycle CLEAR→RESERVED→RUNNING→AWAITING_CLEARANCE→CLEAR is legal", () => {
  const cycle = [
    ["CLEAR", "RESERVED"],
    ["RESERVED", "RUNNING"],
    ["RUNNING", "AWAITING_CLEARANCE"],
    ["AWAITING_CLEARANCE", "CLEAR"]
  ] as const;
  for (const [from, to] of cycle) {
    assert.ok(canTransition(BED_CYCLE_TRANSITIONS, from, to), `${from} → ${to}`);
  }
});

test("BedCycle: UNKNOWN is reachable from every live state and recovers to CLEAR/RESERVED", () => {
  for (const from of ["CLEAR", "RESERVED", "RUNNING", "AWAITING_CLEARANCE"] as const) {
    assert.ok(canTransition(BED_CYCLE_TRANSITIONS, from, "UNKNOWN"), `${from} → UNKNOWN`);
  }
  assert.ok(canTransition(BED_CYCLE_TRANSITIONS, "UNKNOWN", "CLEAR"));
  assert.ok(canTransition(BED_CYCLE_TRANSITIONS, "UNKNOWN", "RESERVED"));
  // But you cannot skip clearance: RUNNING → CLEAR is not allowed.
  assert.ok(!canTransition(BED_CYCLE_TRANSITIONS, "RUNNING", "CLEAR"));
});

test("Assignment / DispatchAttempt / PrintRun terminals are dead-ends", () => {
  for (const s of ["RELEASED", "CANCELLED"] as const) {
    assert.ok(isTerminal(ASSIGNMENT_TRANSITIONS, s));
  }
  for (const s of ["ACKED", "FAILED"] as const) {
    assert.ok(isTerminal(DISPATCH_ATTEMPT_TRANSITIONS, s));
  }
  for (const s of ["SUCCEEDED", "FAILED", "CANCELLED"] as const) {
    assert.ok(isTerminal(PRINT_RUN_TRANSITIONS, s));
  }
});

test("PrintRun: ACTIVE_RUN_STATES is exactly the non-terminal run states (single source of truth for the printer-holding set)", () => {
  // The infra layer derives its `state IN (…)` SQL from this constant, so the
  // set of "active/printer-holding" runs and the set of non-terminal runs must
  // stay identical: a run holds a printer iff it has not reached a terminal.
  const allStates = Object.keys(PRINT_RUN_TRANSITIONS) as PrintRunState[];
  const nonTerminal = allStates.filter((s) => !isTerminal(PRINT_RUN_TRANSITIONS, s)).sort();
  assert.deepEqual([...ACTIVE_RUN_STATES].sort(), nonTerminal);

  // And, defensively, no terminal state may ever leak into the active set —
  // a completed/failed/cancelled run must never be seen as still holding a bed.
  for (const s of ACTIVE_RUN_STATES) {
    assert.ok(!isTerminal(PRINT_RUN_TRANSITIONS, s), `${s} must be non-terminal`);
  }
});

test("QueueEntry: WAITING ⇄ HELD, both release; RELEASED is terminal", () => {
  assert.ok(canTransition(QUEUE_ENTRY_TRANSITIONS, "WAITING", "HELD"));
  assert.ok(canTransition(QUEUE_ENTRY_TRANSITIONS, "HELD", "WAITING"));
  assert.ok(canTransition(QUEUE_ENTRY_TRANSITIONS, "WAITING", "RELEASED"));
  assert.ok(isTerminal(QUEUE_ENTRY_TRANSITIONS, "RELEASED"));
});
