import assert from "node:assert/strict";
import { test } from "node:test";

import type { QueueJob } from "../../domain/dashboard/types";
import type { PrinterConfig } from "../printers/config";
import type { PrinterLiveStatus } from "../printers/status";
import {
  buildNightPlan,
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
    enabled: true,
    apiKey: "",
    serial: "",
    accessCode: "",
    light: {
      enabled: false,
      pin: "",
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
  assert.equal(windowLengthMinutes("23:00 – 07:30"), 8 * 60 + 30);
  assert.equal(windowLengthMinutes("09:00 – 18:00"), 9 * 60);
  assert.equal(windowLengthMinutes("garbage"), null);
});

test("only ready jobs are candidates; night-flagged jobs win when present", () => {
  const ctx: NightPlanContext = {
    window: "23:00 – 07:30",
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
    window: "23:00 – 07:30",
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
    window: "23:00 – 07:30",
    resolvePrinter: () => moonraker("k2", "K2"),
    getStatus: (id) => ({ ...idleStatus(id), online: false, status: "offline" })
  };
  const [entry] = buildNightPlan([job({ file: "" , eta: "20ч" })], ctx);
  assert.ok(entry.blockers.some((b) => b.includes("не в сети")));
  assert.ok(entry.blockers.some((b) => b.includes("файл")));
  assert.ok(entry.blockers.some((b) => b.includes("окно")), "an over-long print does not fit the window");
});
