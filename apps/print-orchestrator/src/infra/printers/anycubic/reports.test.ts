import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrinterConfig } from "../config";
import {
  applyProgress,
  buildAnycubicStatus,
  displayFileName,
  endsJob,
  JOB_STATE_MAX_AGE_MS,
  lifecycleOf,
  parseInfoReport,
  parsePrintEnding,
  parsePrintReport,
  parseStatusReport,
  parseTemperatureReport,
  reportTypeOf,
  stateTextOf,
  type AnycubicJobReport,
  type AnycubicObservation
} from "./reports";
import {
  KOBRA_X_INFO_COOLING,
  KOBRA_X_INFO_FREE_AFTER_PRINT,
  KOBRA_X_INFO_PRINTING,
  KOBRA_X_INFO_STATISTICS,
  KOBRA_X_PRINT_COOLING,
  KOBRA_X_PRINT_FINISHED,
  KOBRA_X_PRINT_PUSH,
  KOBRA_X_PRINT_RESET,
  KOBRA_X_RESPONSE_ACK,
  KOBRA_X_STATUS_FREE,
  KOBRA_X_TEMPERATURE_PUSH
} from "./testkit/kobraXCaptures";

/*
 * Reading Anycubic LAN reports. The payload shapes follow the captures cited in
 * reports.ts (chrisfore's S1 Max capture, the Kobra X integrations, OrcaCubic's
 * Kobra X notes); values are synthetic. What is pinned: the mapping into the
 * farm's status vocabulary, the fields that are and are not trusted, and that a
 * partial, contradictory or stale observation never reads as a start or an end.
 */

const PRINTER = { id: "kobra-x", name: "Kobra X" } as PrinterConfig;
const T0 = Date.parse("2026-10-16T12:00:00.000Z");

function info(data: Record<string, unknown>): unknown {
  return { type: "info", action: "query", msgid: "m1", timestamp: T0, state: "done", code: 200, data };
}

const PRINTING = info({
  printerName: "Кобра у окна",
  model: "Anycubic Kobra X",
  version: "2.0.1.9",
  state: "busy",
  temp: { curr_nozzle_temp: 214.6, target_nozzle_temp: 215, curr_hotbed_temp: 59.8, target_hotbed_temp: 60 },
  project: {
    state: "printing",
    pause: 0,
    filename: ".3mf_temp/benchy_PLA.gcode",
    taskid: "1001",
    progress: 37,
    curr_layer: 42,
    total_layers: 180,
    remain_time: 83,
    print_time: 41,
    supplies_usage: 2301
  },
  urls: { fileUploadurl: "http://192.168.1.60:18910/gcode_upload?s=SECRET", rtspUrl: "http://192.168.1.60:18088/live/TOKEN" }
});

function observe(payload: unknown, at = T0): AnycubicObservation {
  const report = parseInfoReport(payload);
  return {
    job: report?.job ?? null,
    jobObservedAt: report?.job ? at : null,
    temperatures: report?.temperatures ?? null,
    temperaturesObservedAt: report?.temperatures ? at : null
  };
}

test("a printing info report maps onto the farm's live status", () => {
  const status = buildAnycubicStatus(PRINTER, observe(PRINTING), T0 + 1000);
  assert.equal(status.online, true);
  assert.equal(status.status, "printing");
  assert.equal(status.stateText, "printing");
  assert.equal(status.currentFile, "benchy_PLA.gcode", "the printer's staging directory is not shown");
  assert.equal(status.progressPct, 37);
  assert.equal(status.remainingMinutes, 83, "remain_time is minutes — the printer's own countdown");
  assert.equal(status.currentLayer, 42);
  assert.equal(status.totalLayers, 180);
  assert.deepEqual(
    [status.nozzleTemp, status.nozzleTarget, status.bedTemp, status.bedTarget],
    [215, 215, 60, 60]
  );
  assert.equal(status.error, null);
  assert.equal(status.updatedAt, new Date(T0).toISOString(), "freshness is the observation, not the read");
});

test("values the protocol does not confirm stay null — nothing is derived", () => {
  const status = buildAnycubicStatus(PRINTER, observe(PRINTING), T0);
  // supplies_usage exists on the wire but its unit and per-slot attribution are
  // unverified on a four-colour Kobra X: it must not become a deductible length.
  assert.equal(status.filamentUsedMm, null);
  assert.equal(status.activeFilament, null);
  assert.equal(status.amsTrays, null);
  assert.equal(status.nozzleDiameterMm, null);
  assert.equal(status.chamberTemp, null);
  assert.equal(status.light, null);
  assert.deepEqual(status.faults, []);
  // The tokenized upload/camera URLs in the same report go nowhere.
  assert.ok(!JSON.stringify(status).includes("SECRET"));
  assert.ok(!JSON.stringify(status).includes("TOKEN"));
});

test("pause is read from the phase and from the authoritative pause flag", () => {
  const job = (phase: string, pause: number | null): AnycubicJobReport => ({
    work: "busy",
    phase,
    lastPhase: null,
    pauseCode: pause,
    file: "a.gcode",
    taskId: "1",
    progressPct: 10,
    currentLayer: 1,
    totalLayers: 10,
    remainingMinutes: 5
  });
  assert.equal(lifecycleOf(job("paused", 1)), "paused");
  assert.equal(lifecycleOf(job("pausing", 2)), "paused");
  assert.equal(lifecycleOf(job("printing", 1)), "paused", "pause=1 wins over a lagging phase");
  assert.equal(lifecycleOf(job("resuming", 3)), "printing");
  for (const preparing of ["preheating", "auto_leveling", "vibrating", "flow_calibrating", "checking"]) {
    assert.equal(lifecycleOf(job(preparing, 0)), "printing", `${preparing} holds the bed like printing`);
  }
});

test("transitions and contradictions are unknown — never a start and never an end", () => {
  const base: AnycubicJobReport = {
    work: "busy",
    phase: null,
    lastPhase: null,
    pauseCode: null,
    file: null,
    taskId: null,
    progressPct: null,
    currentLayer: null,
    totalLayers: null,
    remainingMinutes: null
  };
  assert.equal(lifecycleOf({ ...base, phase: null }), "unknown", "busy with no job: homing, loading filament");
  assert.equal(lifecycleOf({ ...base, phase: "stopping", pauseCode: 4 }), "unknown");
  assert.equal(lifecycleOf({ ...base, phase: "finished" }), "unknown", "busy still: the end is not confirmed");
  assert.equal(lifecycleOf({ ...base, phase: "some_new_phase" }), "unknown", "an uncaptured phase is not guessed");
  assert.equal(lifecycleOf({ ...base, work: "free", phase: "printing" }), "unknown", "free yet printing: mid-transition");
  assert.equal(lifecycleOf({ ...base, work: "free" }), "idle");
});

test("a finished job reads idle with the printer's own words for how it ended", () => {
  const finished = observe(info({ state: "free", project: null, last_project: { state: "finished", filename: "benchy.gcode", progress: 100 } }));
  const status = buildAnycubicStatus(PRINTER, finished, T0);
  assert.equal(status.status, "idle");
  assert.equal(status.stateText, "finished", "the shared outcome classifier reads this as completed");
  assert.equal(status.currentFile, null, "an idle machine is not printing a file");
  assert.equal(status.progressPct, null);

  const stopped = observe(info({ state: "free", last_project: { state: "stoped" } }));
  assert.equal(buildAnycubicStatus(PRINTER, stopped, T0).stateText, "stoped", "the firmware's spelling, kept");

  const bare = observe(info({ state: "free" }));
  assert.equal(buildAnycubicStatus(PRINTER, bare, T0).stateText, "free", "no ending named → nothing claimed");
});

test("an info report without a machine state confirms nothing", () => {
  const report = parseInfoReport(info({ temp: { curr_nozzle_temp: 30 }, version: "2.0.1.9" }));
  assert.equal(report?.job, null);
  assert.equal(report?.temperatures?.nozzle, 30, "its temperatures are still readings");
  assert.equal(report?.identity.firmware, "2.0.1.9");

  const status = buildAnycubicStatus(PRINTER, observe(info({ temp: { curr_nozzle_temp: 30 } })), T0);
  assert.equal(status.online, false);
  assert.equal(status.status, "unknown");
  assert.match(status.error ?? "", /ожидание/);
});

test("malformed and foreign payloads are ignored without throwing", () => {
  for (const payload of [null, "text", 42, [], {}, { data: null }, { data: [] }, { data: "x" }]) {
    assert.equal(parseInfoReport(payload), null);
    assert.equal(parsePrintReport(payload), null);
    assert.equal(parseTemperatureReport(payload), null);
  }
  const weird = parseInfoReport(info({ state: "busy", project: { state: 7, progress: "abc", remain_time: -5, curr_layer: 1.5 } }));
  assert.equal(weird?.job?.phase, null);
  assert.equal(weird?.job?.progressPct, null);
  assert.equal(weird?.job?.remainingMinutes, null, "a negative countdown is unknown, not zero");
  assert.equal(weird?.job?.currentLayer, null);
  assert.equal(parseInfoReport(info({ state: "busy", project: { state: "printing", progress: 250 } }))?.job?.progressPct, null);
  assert.equal(parseTemperatureReport({ data: { curr_nozzle_temp: 9999 } }), null, "a sentinel is not a temperature");
});

test("unknown fields and unknown report types are ignored", () => {
  const report = parseInfoReport(
    info({ state: "free", brand_new_field: { deep: true }, features: { gcode_3mf_support: 1 } })
  );
  assert.equal(report?.job?.work, "free");

  const base = "anycubic/anycubicCloud/v1/printer/public/20030/dev1";
  assert.equal(reportTypeOf(`${base}/info/report`, "20030", "dev1"), "info");
  assert.equal(reportTypeOf(`${base}/tempature/report`, "20030", "dev1"), "tempature");
  assert.equal(reportTypeOf(`${base}/multiColorBox/report`, "20030", "dev1"), null, "out of scope");
  assert.equal(reportTypeOf(`${base}/file/report`, "20030", "dev1"), null);
  assert.equal(reportTypeOf(`${base}/response`, "20030", "dev1"), null, "the generic ack is not a report");
  assert.equal(reportTypeOf(`${base.replace("dev1", "dev2")}/info/report`, "20030", "dev1"), null, "another device");
  assert.equal(reportTypeOf("anycubic/anycubicCloud/v1/web/printer/20030/dev1/info", "20030", "dev1"), null);
});

test("a print push enriches the confirmed job and never starts one", () => {
  const printing = parseInfoReport(PRINTING)!.job!;
  const push = parsePrintReport({
    type: "print",
    action: "start",
    state: "printing",
    data: { taskid: "1001", filename: ".3mf_temp/benchy_PLA.gcode", progress: 52, curr_layer: 60, total_layers: 180, remain_time: 61 }
  })!;
  const enriched = applyProgress(printing, push);
  assert.equal(enriched.progressPct, 52);
  assert.equal(enriched.currentLayer, 60);
  assert.equal(enriched.remainingMinutes, 61);
  assert.equal(enriched.phase, "printing", "lifecycle untouched");

  const idle = parseInfoReport(info({ state: "free" }))!.job!;
  assert.equal(applyProgress(idle, push), idle, "progress for a job info has not confirmed is dropped");

  const otherJob = parsePrintReport({ data: { taskid: "999", progress: 90 } })!;
  assert.equal(applyProgress(printing, otherJob), printing, "another task's progress is not this job's");

  assert.equal(parsePrintReport({ type: "print", data: { taskid: "-1" } }), null, "an ack is not progress");
  assert.equal(parsePrintReport({ type: "print", data: { settings: { target_nozzle_temp: 220 } } }), null);
});

test("status workReports carry the coarse state only", () => {
  assert.equal(parseStatusReport({ type: "status", action: "workReport", state: "busy", data: null }), "busy");
  assert.equal(parseStatusReport({ state: "FREE" }), "free");
  assert.equal(parseStatusReport({ state: "done" }), null);
});

test("a job state info has not re-confirmed goes offline instead of looking current", () => {
  const observation = observe(PRINTING);
  const fresh = buildAnycubicStatus(PRINTER, observation, T0 + JOB_STATE_MAX_AGE_MS);
  assert.equal(fresh.status, "printing");

  const stale = buildAnycubicStatus(PRINTER, observation, T0 + JOB_STATE_MAX_AGE_MS + 1);
  assert.equal(stale.online, false);
  assert.equal(stale.status, "offline");
  assert.equal(stale.progressPct, null, "an old print's progress is not shown as live");
  assert.equal(stale.currentFile, null);
  assert.equal(stale.nozzleTemp, null);
  assert.match(stale.error ?? "", /60 секунд/);
});

test("temperatures have their own freshness", () => {
  const observation: AnycubicObservation = {
    ...observe(PRINTING),
    jobObservedAt: T0 + 50_000,
    temperaturesObservedAt: T0
  };
  const status = buildAnycubicStatus(PRINTER, observation, T0 + 61_000);
  assert.equal(status.status, "printing", "the job is fresh");
  assert.equal(status.nozzleTemp, null, "the temperature is not");
});

test("a target of 0 is a reading (heater off), not an absence", () => {
  const temps = parseTemperatureReport({ type: "tempature", data: { curr_nozzle_temp: 25, target_nozzle_temp: 0 } });
  assert.equal(temps?.nozzleTarget, 0);
  assert.equal(temps?.bed, null, "an omitted field is unknown");
});

// ── Captured on a real Kobra X (firmware 2.0.2.2) ─────────────────────────────

test("a Kobra X info report captured mid-print maps onto the live status", () => {
  const report = parseInfoReport(KOBRA_X_INFO_PRINTING)!;
  assert.deepEqual(report.identity, { printerName: "Anycubic Kobra X", model: "Anycubic Kobra X", firmware: "2.0.2.2" });
  assert.equal(report.job?.taskId, null, 'task_id "-1" is the firmware\'s "no task", not an id');
  assert.equal(report.job?.lastPhase, null, "an empty last_project names no ending");

  const status = buildAnycubicStatus(PRINTER, observe(KOBRA_X_INFO_PRINTING), T0);
  assert.equal(status.online, true);
  assert.equal(status.status, "printing");
  assert.equal(status.stateText, "printing");
  assert.equal(status.currentFile, "Sample+Part+Set_plate(07)_PETG_0.2_2h10m.gcode");
  assert.equal(status.progressPct, 74);
  assert.equal(status.remainingMinutes, 33);
  assert.deepEqual([status.currentLayer, status.totalLayers], [12, 15]);
  assert.deepEqual(
    [status.nozzleTemp, status.nozzleTarget, status.bedTemp, status.bedTarget],
    [240, 240, 75, 75]
  );
  assert.equal(status.error, null);
  for (const leak of ["gcode_upload", ":18088", "192.0.2.10"]) {
    assert.ok(!JSON.stringify(status).includes(leak), `${leak} stays out of the status`);
  }
});

test("a captured mid-print push (action \"start\", taskid \"-1\") enriches the job and starts nothing", () => {
  const job = parseInfoReport(KOBRA_X_INFO_PRINTING)!.job!;
  const push = parsePrintReport(KOBRA_X_PRINT_PUSH)!;
  assert.equal(push.taskId, null);

  const enriched = applyProgress(job, push);
  assert.equal(enriched.remainingMinutes, 32);
  assert.equal(enriched.phase, "printing", "the push's action/state do not touch the lifecycle");
  assert.equal(lifecycleOf(enriched), "printing");

  // Every print started on the screen reports "-1": matched as an id, another
  // local job's progress would be folded into this one. The file decides instead.
  const otherLocalJob = parsePrintReport({
    ...KOBRA_X_PRINT_PUSH,
    data: { ...KOBRA_X_PRINT_PUSH.data, filename: "other_plate.gcode", progress: 5, remain_time: 120 }
  })!;
  assert.equal(applyProgress(job, otherLocalJob), job);

  assert.equal(parsePrintReport(KOBRA_X_RESPONSE_ACK), null, "the bare ack carries no progress");
});

test("the captured end of a print: cool-down confirms nothing, the push names the ending, info frees the machine", () => {
  const cooling = parseInfoReport(KOBRA_X_INFO_COOLING)!.job!;
  assert.equal(cooling.phase, "nozzle_cooling_off");
  assert.equal(lifecycleOf(cooling), "unknown", "over, but busy: neither a start nor an end");
  assert.equal(parsePrintReport(KOBRA_X_PRINT_COOLING), null, "a cool-down push carries no progress");
  assert.equal(parsePrintEnding(KOBRA_X_PRINT_COOLING), null, "cooling down is not an ending");
  assert.equal(parsePrintEnding(KOBRA_X_PRINT_RESET), null);
  assert.equal(parsePrintEnding(KOBRA_X_PRINT_PUSH), null, "mid-print");

  const ending = parsePrintEnding(KOBRA_X_PRINT_FINISHED)!;
  assert.deepEqual(ending, { phase: "finished", file: cooling.file, taskId: null });
  assert.ok(endsJob(cooling, ending), "the job in hand, by file — its task id is the sentinel");
  assert.ok(!endsJob({ ...cooling, file: "other_plate.gcode" }, ending), "not another job's ending");
  const free = parseInfoReport(KOBRA_X_INFO_FREE_AFTER_PRINT)!.job!;
  assert.ok(!endsJob(free, ending), "a free machine holds no job to end");

  // last_project stays empty on this firmware: info alone cannot say how it ended.
  assert.equal(free.lastPhase, null);
  const unannounced = buildAnycubicStatus(PRINTER, observe(KOBRA_X_INFO_FREE_AFTER_PRINT), T0);
  assert.equal(unannounced.status, "idle");
  assert.equal(unannounced.stateText, "free", "the shared classifier reads this as an ambiguous ending");

  const announced = buildAnycubicStatus(PRINTER, { ...observe(KOBRA_X_INFO_FREE_AFTER_PRINT), ending: "finished" }, T0);
  assert.equal(announced.status, "idle");
  assert.equal(announced.stateText, "finished", "the shared classifier reads this as completed");
  assert.equal(announced.currentFile, null);
  assert.deepEqual(
    [announced.nozzleTemp, announced.nozzleTarget, announced.bedTemp, announced.bedTarget],
    [171, 0, 73, 0]
  );
  // The info report's own words still win when it has them.
  const said = observe(info({ state: "free", last_project: { state: "stoped" } }));
  assert.equal(buildAnycubicStatus(PRINTER, { ...said, ending: "finished" }, T0).stateText, "stoped");
});

test("captured side traffic: statistics on the info topic, temperature and status pushes", () => {
  const statistics = parseInfoReport(KOBRA_X_INFO_STATISTICS);
  assert.equal(statistics?.job, null, "lifetime counters are not a machine state");
  assert.equal(statistics?.temperatures, null);
  assert.deepEqual(statistics?.identity, { printerName: null, model: null, firmware: null });

  assert.deepEqual(parseTemperatureReport(KOBRA_X_TEMPERATURE_PUSH), {
    nozzle: 240,
    nozzleTarget: 0,
    bed: 75,
    bedTarget: 0
  });
  assert.equal(parseStatusReport(KOBRA_X_STATUS_FREE), "free");
});

test("stateText and display names", () => {
  assert.equal(stateTextOf(parseInfoReport(PRINTING)!.job!), "printing");
  assert.equal(stateTextOf(parseInfoReport(info({ state: "busy" }))!.job!), "busy");
  assert.equal(displayFileName("/useremain/app/gk/gcodes/part.gcode"), "part.gcode");
  assert.equal(displayFileName("part.gcode"), "part.gcode");
  assert.equal(displayFileName(""), null);
  assert.equal(displayFileName(null), null);
});
