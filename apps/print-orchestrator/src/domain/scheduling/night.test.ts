import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateNightGate, selectNightSlots, type NightGateInput } from "./night";

const config = { safetyBufferRatio: 0.2 };

function gate(over: Partial<NightGateInput> = {}): NightGateInput {
  return {
    taskId: "t1",
    printerId: "p1",
    priority: 0,
    readySliceVariant: true,
    profileSetApproved: true,
    etaSeconds: 3600,
    materialSufficient: true,
    telemetryFresh: true,
    bedCycle: "CLEAR",
    maintenanceBlockers: [],
    unattendedAllowed: true,
    ...over
  };
}

test("a fully-eligible night candidate passes and gets a buffered ETA flagged preliminary", () => {
  const r = evaluateNightGate(gate(), config);
  assert.equal(r.eligible, true);
  assert.equal(r.bufferedEtaSeconds, 4320); // 3600 * 1.2
  assert.equal(r.preliminary, true);
});

test("no unattended permission fails the gate", () => {
  const r = evaluateNightGate(gate({ unattendedAllowed: false }), config);
  assert.equal(r.eligible, false);
  assert.ok(r.blockers.some((b) => /без присмотра/.test(b)));
});

test("a non-clear bed fails the gate", () => {
  const r = evaluateNightGate(gate({ bedCycle: "AWAITING_CLEARANCE" }), config);
  assert.equal(r.eligible, false);
  assert.ok(r.blockers.some((b) => /стол не свободен/.test(b)));
});

test("an unknown material remainder fails the gate (never assumed sufficient)", () => {
  const r = evaluateNightGate(gate({ materialSufficient: null }), config);
  assert.equal(r.eligible, false);
  assert.ok(r.blockers.some((b) => /остаток материала/.test(b)));
});

test("an unknown ETA fails the gate and yields no buffered time", () => {
  const r = evaluateNightGate(gate({ etaSeconds: null }), config);
  assert.equal(r.eligible, false);
  assert.equal(r.bufferedEtaSeconds, null);
});

test("stale telemetry / unapproved set / no slice each fail the gate", () => {
  assert.equal(evaluateNightGate(gate({ telemetryFresh: false }), config).eligible, false);
  assert.equal(evaluateNightGate(gate({ profileSetApproved: false }), config).eligible, false);
  assert.equal(evaluateNightGate(gate({ readySliceVariant: false }), config).eligible, false);
});

test("selectNightSlots keeps exactly one candidate per printer and rejects the rest", () => {
  const inputs = [
    gate({ taskId: "a", printerId: "p1", priority: 1 }),
    gate({ taskId: "b", printerId: "p1", priority: 9 }),
    gate({ taskId: "c", printerId: "p2", priority: 3 })
  ];
  const results = inputs.map((g) => evaluateNightGate(g, config));
  const { chosen, rejected } = selectNightSlots(inputs, results);
  assert.equal(chosen.length, 2); // one per printer
  const p1 = chosen.find((c) => c.printerId === "p1")!;
  assert.equal(p1.taskId, "b"); // highest priority wins the single slot
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].taskId, "a");
  assert.match(rejected[0].reason, /одна печать на принтер/);
});
