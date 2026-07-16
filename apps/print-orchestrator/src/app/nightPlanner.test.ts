import assert from "node:assert/strict";
import { test } from "node:test";

import type { QueueJob } from "../domain/dashboard/types";
import type { PrinterConfig } from "../infra/printers/config";
import type { PrinterLiveStatus } from "../infra/printers/status";
import {
  buildNightPlan,
  materialsIncompatible,
  parseEtaMinutes,
  windowLengthMinutes,
  type NightPlanContext
} from "./nightPlanner";

/*
 * The night planner ranks ready queue jobs into safe-first candidates and, for
 * each, lists the hard reasons it cannot actually launch tonight.
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

function idleStatus(id: string): PrinterLiveStatus {
  return {
    id,
    online: true,
    status: "idle",
    currentFile: null,
    progressPct: null,
    remainingMinutes: null,
    filamentUsedMm: null,
    amsTrays: null,
    nozzleDiameterMm: null,
    nozzleType: null,
    activeFilament: null,
    nozzleTemp: null,
    nozzleTarget: null,
    bedTemp: null,
    bedTarget: null,
    chamberTemp: null,
    light: null,
    stateText: null,
    stateMessage: null,
    error: null,
    updatedAt: new Date().toISOString()
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
    getStatus: (id) => idleStatus(id)
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
  assert.deepEqual(plan[0].blockers, [], "an online idle moonraker with a file has no blockers");
});

test("candidates are ranked safest first", () => {
  const ctx: NightPlanContext = {
    window: "21:30 – 07:30",
    resolvePrinter: (j) => (j.printer === "OFF" ? undefined : moonraker("k2", "K2")),
    getStatus: (id) => idleStatus(id)
  };
  const plan = buildNightPlan(
    [
      job({ id: "q1", title: "Unresolved", printer: "OFF", eta: "3ч" }),
      job({ id: "q2", title: "Clean", printer: "K2", eta: "2ч", file: "b.gcode" })
    ],
    ctx
  );
  assert.equal(plan[0].job.title, "Clean", "the startable job ranks first");
  assert.ok(plan[0].candidate.risk < plan[1].candidate.risk);
});

test("blockers list concrete reasons a job cannot launch tonight", () => {
  const ctx: NightPlanContext = {
    window: "21:30 – 07:30",
    resolvePrinter: () => moonraker("k2", "K2"),
    getStatus: (id) => ({ ...idleStatus(id), online: false, status: "offline" })
  };
  const [entry] = buildNightPlan([job({ file: "" , eta: "20ч" })], ctx);
  assert.ok(entry.blockers.some((b) => b.includes("не в сети")));
  assert.ok(entry.blockers.some((b) => b.includes("файл")));
  assert.ok(entry.blockers.some((b) => b.includes("окно")), "an over-long print does not fit the window");
});

test("an unknown ETA is a hard blocker, not a discount (unattended print)", () => {
  const ctx: NightPlanContext = {
    window: "21:30 – 07:30",
    resolvePrinter: () => moonraker("k2", "K2"),
    getStatus: (id) => idleStatus(id)
  };
  const [entry] = buildNightPlan([job({ eta: "—", file: "a.gcode" })], ctx);
  assert.ok(
    entry.blockers.some((b) => b.includes("длительность")),
    "no ETA → cannot verify the window → blocked"
  );
  assert.deepEqual(entry.candidate.blockers, entry.blockers, "the candidate carries the blockers for the UI");
});

test("an unconfirmed printer state (unknown) is a hard blocker", () => {
  const ctx: NightPlanContext = {
    window: "21:30 – 07:30",
    resolvePrinter: () => moonraker("k2", "K2"),
    getStatus: (id) => ({ ...idleStatus(id), status: "unknown" })
  };
  const [entry] = buildNightPlan([job({ file: "a.gcode" })], ctx);
  assert.ok(entry.blockers.some((b) => b.includes("не подтверждено")));
});

test("a material contradiction is a hard blocker; a matching token in a list is not", () => {
  const ctx: NightPlanContext = {
    window: "21:30 – 07:30",
    resolvePrinter: () => moonraker("k2", "K2", "PETG"),
    getStatus: (id) => idleStatus(id)
  };
  const [entry] = buildNightPlan([job({ material: "PLA", file: "a.gcode" })], ctx);
  assert.ok(entry.blockers.some((b) => b.includes("материал")));

  const multi: NightPlanContext = {
    ...ctx,
    resolvePrinter: () => moonraker("k2", "K2", "PLA / PETG / TPU")
  };
  const [ok] = buildNightPlan([job({ material: "PLA", file: "a.gcode" })], multi);
  assert.deepEqual(ok.blockers, [], "PLA is among the loaded alternatives");
});

test("an unsafe job file path is a blocker", () => {
  const ctx: NightPlanContext = {
    window: "21:30 – 07:30",
    resolvePrinter: () => moonraker("k2", "K2"),
    getStatus: (id) => idleStatus(id)
  };
  const [entry] = buildNightPlan([job({ file: "../evil.gcode" })], ctx);
  assert.ok(entry.blockers.some((b) => b.includes("проверку пути")));
});

test("materialsIncompatible only reports a concrete contradiction", () => {
  assert.equal(materialsIncompatible("PLA", "PETG"), true);
  assert.equal(materialsIncompatible("PLA", "PLA"), false);
  assert.equal(materialsIncompatible("pla", "PLA / PETG / TPU"), false);
  assert.equal(materialsIncompatible("ABS", "PLA / PETG / TPU"), true);
  assert.equal(materialsIncompatible("—", "PLA"), false, "unknown job material — nothing to contradict");
  assert.equal(materialsIncompatible("PLA", ""), false, "unknown loaded material — nothing to contradict");
});
