import assert from "node:assert/strict";
import { test } from "node:test";

import type { QueueJob } from "../domain/dashboard/types";
import type { PrinterConfig } from "../infra/printers/config";
import {
  buildNightPlan,
  materialsIncompatible,
  parseEtaMinutes,
  windowLengthMinutes,
  type NightGateDecision,
  type NightPlanContext
} from "./nightPlanner";

/*
 * The night planner is a *projection*: it pools the ready queue into night
 * candidates, ranks them safest-first, and lists — verbatim — the blockers the
 * canonical night gate (`NightPlanContext.nightGate`) reports. It owns no night
 * rules of its own, so the dashboard shows exactly what the dispatch gate will
 * enforce. These tests pin the projection + ranking, and the pure parsing
 * helpers the canonical gate shares with it.
 */

function moonraker(id: string, name: string, material = "PLA"): PrinterConfig {
  return {
    id,
    name,
    model: "",
    type: "FDM",
    protocol: "moonraker",
    host: "127.0.0.1",
    material,
    swatch: "",
    snapshotUrl: "",
    streamUrl: "",
    interfaceUrl: "",
    enabled: true,
    apiKey: "",
    serial: "",
    accessCode: "",
    light: {
      enabled: false,
      pin: "",
      invert: false,
      onGcode: "",
      offGcode: "",
      statusObject: "",
      statusField: "value",
      bambuNode: ""
    }
  };
}

function job(over: Partial<QueueJob>): QueueJob {
  return {
    id: "q1",
    title: "Part",
    printer: "K2",
    material: "PLA",
    eta: "2ч",
    status: "ready",
    ...over
  };
}

/**
 * A canonical-gate stub: returns the blockers keyed by job id, plus the identity
 * a real gate carries. This stands in for `FarmStore.nightGateInfo`
 * (`evaluateDispatchGate`) so the planner can be tested as a pure projection.
 */
function gateWith(blockersById: Record<string, string[]>): NightPlanContext["nightGate"] {
  return (j: QueueJob): NightGateDecision => ({
    blockers: blockersById[j.id] ?? [],
    taskId: j.id,
    taskVersion: 1,
    artifactSha256: null
  });
}

test("parseEtaMinutes reads hours, minutes and combinations", () => {
  assert.equal(parseEtaMinutes("2ч"), 120);
  assert.equal(parseEtaMinutes("2 ч 30 м"), 150);
  assert.equal(parseEtaMinutes("90 м"), 90);
  assert.equal(parseEtaMinutes("1.5ч"), 90);
  assert.equal(parseEtaMinutes("—"), null, "an unknown eta is null, not zero");
  assert.equal(parseEtaMinutes(""), null);
});

test("windowLengthMinutes handles a wrap-around night window", () => {
  assert.equal(windowLengthMinutes("21:30 – 07:30"), 10 * 60);
  assert.equal(windowLengthMinutes("09:00 – 18:00"), 9 * 60);
  assert.equal(windowLengthMinutes("garbage"), null);
});

test("only ready jobs are candidates; night-flagged jobs win when present", () => {
  const ctx: NightPlanContext = {
    window: "21:30 – 07:30",
    resolvePrinter: () => moonraker("k2", "K2"),
    nightGate: gateWith({})
  };
  const plan = buildNightPlan(
    [
      job({ id: "q1", title: "Ready-no-night", file: "a.gcode" }),
      job({ id: "q2", title: "Night", night: true, file: "b.gcode" }),
      job({ id: "q3", title: "Review", status: "review" })
    ],
    ctx
  );
  assert.equal(plan.length, 1, "only the night-flagged ready job is considered");
  assert.equal(plan[0].job.title, "Night");
  assert.deepEqual(plan[0].blockers, [], "the canonical gate reported no blockers → startable");
});

test("blockers are the canonical gate's, verbatim, and the candidate carries them for the UI", () => {
  const ctx: NightPlanContext = {
    window: "21:30 – 07:30",
    resolvePrinter: () => moonraker("k2", "K2"),
    nightGate: gateWith({ q1: ["«K2» не в сети", "нет завершённого анализа файла"] })
  };
  const [entry] = buildNightPlan([job({ file: "a.gcode", night: true })], ctx);
  assert.deepEqual(entry.blockers, ["«K2» не в сети", "нет завершённого анализа файла"]);
  assert.deepEqual(
    entry.candidate.blockers,
    entry.blockers,
    "the candidate mirrors the entry's blockers"
  );
});

test("the planner adds NO blockers of its own — a clean gate means a startable candidate", () => {
  // A job that the OLD heuristic would have blocked (unmarked night, unknown
  // material, no file): with the canonical gate clean, the projection reports it
  // startable. There is no second rule set second-guessing the gate.
  const ctx: NightPlanContext = {
    window: "21:30 – 07:30",
    resolvePrinter: () => moonraker("k2", "K2", "PETG"),
    nightGate: gateWith({})
  };
  const [entry] = buildNightPlan([job({ material: "PLA", file: "", night: false })], ctx);
  assert.deepEqual(entry.blockers, [], "only the gate decides — and it said startable");
});

test("candidates are ranked safest first (fewer gate blockers → lower risk)", () => {
  const ctx: NightPlanContext = {
    window: "21:30 – 07:30",
    resolvePrinter: () => moonraker("k2", "K2"),
    nightGate: gateWith({
      q1: ["материал не подтверждён с обеих сторон — ночной запуск запрещён", "ETA неизвестна"],
      q2: []
    })
  };
  const plan = buildNightPlan(
    [
      job({ id: "q1", title: "Blocked", night: true, eta: "3ч" }),
      job({ id: "q2", title: "Clean", night: true, eta: "2ч", file: "b.gcode" })
    ],
    ctx
  );
  assert.equal(plan[0].job.title, "Clean", "the startable job ranks first");
  assert.ok(plan[0].candidate.risk < plan[1].candidate.risk, "more blockers → higher risk");
  assert.ok(plan[0].candidate.risk < 35, "a blocker-free candidate reads low risk");
});

test("the gate's preview identity is projected onto the candidate", () => {
  const ctx: NightPlanContext = {
    window: "21:30 – 07:30",
    resolvePrinter: () => moonraker("k2", "K2"),
    nightGate: (j) => ({ blockers: [], taskId: j.id, taskVersion: 7, artifactSha256: "abc123" })
  };
  const [entry] = buildNightPlan([job({ id: "task-x", night: true, file: "a.gcode" })], ctx);
  assert.equal(entry.candidate.taskId, "task-x");
  assert.equal(entry.candidate.taskVersion, 7);
  assert.equal(entry.candidate.artifactSha256, "abc123");
});

test("a null gate is un-verifiable, never silently startable", () => {
  const ctx: NightPlanContext = {
    window: "21:30 – 07:30",
    resolvePrinter: () => moonraker("k2", "K2"),
    nightGate: () => null
  };
  const [entry] = buildNightPlan([job({ night: true, file: "a.gcode" })], ctx);
  assert.equal(entry.blockers.length, 1, "a missing decision yields one honest blocker");
  assert.ok(entry.blockers[0].includes("не удалось проверить"));
});

test("materialsIncompatible only reports a concrete contradiction", () => {
  assert.equal(materialsIncompatible("PLA", "PETG"), true);
  assert.equal(materialsIncompatible("PLA", "PLA"), false);
  assert.equal(materialsIncompatible("pla", "PLA / PETG / TPU"), false);
  assert.equal(materialsIncompatible("ABS", "PLA / PETG / TPU"), true);
  assert.equal(materialsIncompatible("—", "PLA"), false, "unknown job material — nothing to contradict");
  assert.equal(materialsIncompatible("PLA", ""), false, "unknown loaded material — nothing to contradict");
});
