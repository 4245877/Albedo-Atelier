import assert from "node:assert/strict";
import { test } from "node:test";

import { JobError, StateTransitionError } from "../../core/errors";
import { OPERATION_LABELS } from "../../domain/operations/states";
import { REASON } from "../../domain/dispatch/reasons";
import type { PrintQueueStore } from "../../domain/print/repositories";
import { openPrintQueueStore } from "../../infra/db/store";
import type { PrinterConfig } from "../../infra/printers/config";
import type { PrinterLiveStatus } from "../../infra/printers/status";
import { DispatchService, type DispatchDeps } from "../dispatch/dispatchService";
import { RunLifecycleService } from "../dispatch/runLifecycle";
import { seedDeviceFile } from "../dispatch/testkit/deviceFiles";
import { PrintQueueService } from "../printQueue/printQueueService";
import { SchedulerContext } from "../scheduling/context";
import { EligibilityQueries } from "../scheduling/eligibility";
import { EvidenceResolver } from "../scheduling/evidence";
import type { SchedulerPrinterRef } from "../scheduling/types";
import { ManualOperationService } from "./manualOperationService";
import { OperatorScheduleService } from "./operatorScheduleService";

/*
 * The operator schedule and the manual operations, end to end over a real
 * (in-memory) SQLite store with a **fake clock** and a **fake device**.
 *
 * `startPhysical` is a spy and the file listing is a fixture: nothing here talks
 * to a printer or the network. The clock is a mutable `now` the tests advance by
 * hand, because every claim in this file is about *when* something becomes
 * possible — a test that used the wall clock could not assert any of it.
 */

const K2: PrinterConfig = {
  id: "k2",
  name: "Creality K2",
  model: "K2 Plus",
  type: "FDM",
  protocol: "moonraker",
  host: "127.0.0.1",
  material: "PLA",
  enabled: true
} as unknown as PrinterConfig;

/** 03:00 MSK — the instant the brief's night print finishes. */
const NIGHT = new Date("2026-07-28T00:00:00Z");
/** 08:00 MSK — when the operator's shift opens. */
const MORNING = new Date("2026-07-28T05:00:00Z");

interface Harness {
  store: PrintQueueStore;
  queue: PrintQueueService;
  dispatch: DispatchService;
  lifecycle: RunLifecycleService;
  schedule: OperatorScheduleService;
  operations: ManualOperationService;
  startCalls: string[];
  clock: { now: Date };
  knobs: { status: PrinterLiveStatus["status"]; online: boolean; autoContinuation: boolean };
  eligibilityFor: (taskId: string, mode: "manual" | "night") => ReturnType<EligibilityQueries["evaluate"]>;
}

function makeHarness(): Harness {
  const store = openPrintQueueStore(":memory:");
  const clock = { now: NIGHT };
  const now = (): Date => clock.now;
  const startCalls: string[] = [];
  const knobs: Harness["knobs"] = { status: "idle", online: true, autoContinuation: false };

  const schedule = new OperatorScheduleService(store, { now });
  const operations = new ManualOperationService(store, schedule, { now });
  const queue = new PrintQueueService(store, { now, operations });
  const lifecycle = new RunLifecycleService(store, { now, operations });

  const printerRef = (): SchedulerPrinterRef => ({
    id: K2.id,
    name: K2.name,
    model: K2.model,
    protocol: K2.protocol,
    printerClass: null,
    material: K2.material,
    nozzleMm: 0.4,
    buildVolume: { x: 350, y: 350, z: 350 },
    online: knobs.online,
    status: knobs.status as SchedulerPrinterRef["status"],
    remoteStartSupported: true,
    ams: null,
    faults: [],
    mediaPresent: null,
    telemetryAgeMs: 1_000,
    materialRemainingSufficient: null,
    printingTimeLeftMs: null,
    activeRunState: null
  });

  const eligibility = (): EligibilityQueries => {
    const ctx = new SchedulerContext(store, () => [printerRef()], {
      now,
      runtimeAvailable: true,
      nightSafetyBufferRatio: 0.2,
      nightWindow: "21:30 – 07:30",
      farmTimeZone: "Europe/Moscow",
      compatibility: { telemetryStaleMs: 120_000 },
      unknownEtaAssumptionS: 4 * 3600
    });
    return new EligibilityQueries(ctx, new EvidenceResolver(ctx));
  };

  const deps: DispatchDeps = {
    store,
    resolvePrinter: (ref) => (ref.trim().toLowerCase() === "k2" ? K2 : undefined),
    getStatus: () => undefined,
    startPhysical: async (_printerId, file) => void startCalls.push(file),
    classifyError: () => "unknown",
    listFiles: async (_printer, dir) => ({
      path: dir,
      entries: ["a.gcode", "b.gcode"].map((name) => ({
        name,
        path: name,
        type: "file" as const,
        size: 1000,
        printable: true
      }))
    }),
    evaluateEligibility: (input) =>
      eligibility().evaluate({ ...input, automaticContinuationAllowed: knobs.autoContinuation })
  };

  return {
    store,
    queue,
    dispatch: new DispatchService(deps),
    lifecycle,
    schedule,
    operations,
    startCalls,
    clock,
    knobs,
    eligibilityFor: (taskId, mode) =>
      eligibility().evaluate({
        taskId,
        printerId: "k2",
        mode,
        deviceFileIdentity: "name+size"
      })
  };
}

/** The default operator with a day shift and a sleep window crossing midnight. */
function withSchedule(h: Harness): string {
  const operator = h.schedule.primaryOperator();
  assert.ok(operator, "migration 011 seeds one operator");
  const days = [0, 1, 2, 3, 4, 5, 6];
  h.schedule.setWeeklySchedule(operator.id, {
    timeZone: "Europe/Moscow",
    available: days.map((weekday) => ({ weekday, start: "08:00", end: "20:00" })),
    sleep: days.map((weekday) => ({ weekday, start: "23:00", end: "07:00" }))
  });
  return operator.id;
}

function addTask(h: Harness, file: string): string {
  const detail = h.queue.createTask({ title: file, printer: "k2", material: "PLA", file });
  seedDeviceFile(h.store, {
    printerId: "k2",
    remotePath: file,
    artifactId: detail.task.artifactId
  });
  return detail.task.id;
}

/** Runs one print to completion, leaving a finished part on the plate. */
async function printAndFinish(h: Harness, file = "a.gcode"): Promise<void> {
  const taskId = addTask(h, file);
  const result = await h.dispatch.dispatch({ taskId, mode: "manual" });
  h.lifecycle.completeRun(result.runId, "SUCCEEDED");
}

const bedState = (h: Harness): string | null =>
  h.store.repositories.bedCycles.findOpenByPrinter("k2")?.state ?? null;

const blockerCodes = (result: { reasons: { severity: string; code: string }[] }): string[] =>
  result.reasons.filter((r) => r.severity === "blocker").map((r) => r.code);

// ── 1. A print finishes at night; the operator is available in the morning ──

test("a print that finishes at 03:00 opens a PENDING removal that becomes READY at 08:00", async () => {
  const h = makeHarness();
  withSchedule(h);
  await printAndFinish(h);

  const [operation] = h.operations.openFor("k2");
  assert.ok(operation, "finishing a print opened the clearance operation automatically");
  assert.equal(operation.type, "PART_REMOVAL");
  assert.equal(operation.origin, "print_finished");
  assert.equal(operation.state, "PENDING", "03:00 — the operator is asleep");
  assert.equal(bedState(h), "AWAITING_CLEARANCE");

  // The projection tells the operator when, and it is not "now".
  const nightHold = h.operations.printerHold("k2");
  assert.equal(nightHold.free, false);
  assert.equal(nightHold.waitingForOperator, true);
  assert.equal(
    nightHold.releaseAt,
    "2026-07-28T05:05:00.000Z",
    "08:00 MSK opening + the 5-minute removal"
  );

  // Advance the fake clock to the morning: the sweep promotes it.
  h.clock.now = MORNING;
  const { promoted } = h.operations.refreshReadiness();
  assert.equal(promoted, 1);
  assert.equal(h.operations.getOperation(operation.id).state, "READY");
  assert.ok(h.operations.getOperation(operation.id).readyAt, "the moment it became performable is recorded");
});

test("readiness is bidirectional — an operation goes back to PENDING when the operator goes to sleep", async () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  await printAndFinish(h);

  const [operation] = h.operations.openFor("k2");
  assert.equal(operation.state, "READY", "opened while the operator was at the bench");

  h.clock.now = new Date("2026-07-28T21:00:00Z"); // 00:00 MSK — asleep again
  const { demoted } = h.operations.refreshReadiness();
  assert.equal(demoted, 1, "a READY operation nobody can perform is a lie");
  assert.equal(h.operations.getOperation(operation.id).state, "PENDING");
});

// ── 2 & 13. The next job waits for the removal — manual start included ──────

test("the next job is refused while the removal is outstanding, in manual mode too", async () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  await printAndFinish(h);

  const next = addTask(h, "b.gcode");
  const verdict = h.eligibilityFor(next, "manual");
  assert.equal(verdict.status, "blocked");
  assert.ok(
    blockerCodes(verdict).includes(REASON.MANUAL_OPERATION_REQUIRED),
    "the outstanding intervention is named as the blocker"
  );

  await assert.rejects(h.dispatch.dispatch({ taskId: next, mode: "manual" }), JobError);
  assert.equal(h.startCalls.length, 1, "only the first print ever reached the device");
});

test("a manual start cannot override a mandatory operation — the blocker is non-overridable", async () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  await printAndFinish(h);
  const next = addTask(h, "b.gcode");

  const verdict = h.eligibilityFor(next, "manual");
  const hard = verdict.reasons.filter(
    (r) => r.severity === "blocker" && r.code === REASON.MANUAL_OPERATION_REQUIRED
  );
  assert.equal(hard.length, 1);
  // A fully-formed, accountable override still cannot wave it through.
  await assert.rejects(
    h.dispatch.dispatch({
      taskId: next,
      mode: "manual",
      override: {
        codes: [REASON.MANUAL_OPERATION_REQUIRED],
        operator: "operator-7",
        reason: "спешу"
      }
    }),
    JobError
  );
  assert.equal(h.startCalls.length, 1);
});

test("a non-blocking operation does not stop the next job", async () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  const next = addTask(h, "b.gcode");
  h.operations.open({ type: "VISUAL_INSPECTION", printerId: "k2" });

  const verdict = h.eligibilityFor(next, "manual");
  assert.ok(!blockerCodes(verdict).includes(REASON.MANUAL_OPERATION_REQUIRED));
});

// ── 3. Confirming the operation clears the bed ──────────────────────────────

test("confirming the removal moves the bed to CLEAR and releases the printer", async () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  await printAndFinish(h);
  const [operation] = h.operations.openFor("k2");

  h.clock.now = new Date("2026-07-28T05:05:00Z"); // 08:05 MSK
  const done = h.operations.complete(operation.id, { actor: "operator-7", actualMinutes: 5 });

  assert.equal(done.state, "COMPLETED");
  assert.equal(done.confirmedBy, "operator-7", "the confirmation is attributed to a person");
  assert.equal(done.completedAt, "2026-07-28T05:05:00.000Z");
  assert.equal(done.actualMinutes, 5);
  assert.equal(bedState(h), null, "the cycle is CLEAR, so no open cycle remains");
  assert.equal(h.operations.printerHold("k2").free, true);

  // …and the next job can now start.
  const next = addTask(h, "b.gcode");
  await h.dispatch.dispatch({ taskId: next, mode: "manual" });
  assert.equal(h.startCalls.length, 2);
});

test("an idle printer report is never read as a part removal", async () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  await printAndFinish(h);

  for (let i = 0; i < 5; i += 1) {
    h.lifecycle.observe(
      "k2",
      { online: true, status: "idle" } as PrinterLiveStatus,
      { online: true, status: "idle" } as PrinterLiveStatus
    );
  }
  assert.equal(bedState(h), "AWAITING_CLEARANCE", "idle telemetry confirms nothing");
  assert.equal(h.operations.openFor("k2").length, 1, "the operation is still outstanding");
});

test("clearing the bed directly also closes the tracked operation — the two cannot drift", async () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  await printAndFinish(h);
  const [operation] = h.operations.openFor("k2");

  h.lifecycle.clearBed("k2", { confirmation: "part_removed", actor: "operator-3" });

  assert.equal(h.operations.getOperation(operation.id).state, "COMPLETED");
  assert.equal(h.operations.getOperation(operation.id).confirmedBy, "operator-3");
  assert.equal(h.operations.openFor("k2").length, 0, "no phantom work left in the operator queue");
});

// ── 7. An unknown schedule blocks automatic continuation ────────────────────

test("with NO schedule configured, availability is UNKNOWN and the removal never becomes READY", async () => {
  const h = makeHarness();
  // Deliberately no `withSchedule` — the seeded operator has no timezone.
  await printAndFinish(h);

  const availability = h.schedule.availability();
  assert.equal(availability.presence, "UNKNOWN");
  assert.equal(availability.resolved, false);

  const [operation] = h.operations.openFor("k2");
  assert.equal(operation.state, "PENDING");
  h.clock.now = MORNING;
  assert.equal(h.operations.refreshReadiness().promoted, 0, "no schedule ⇒ nothing is performable");

  const hold = h.operations.printerHold("k2");
  assert.equal(hold.releaseAt, null, "and no release time is invented");
});

test("an unknown schedule blocks an unattended continuation onto a held printer", async () => {
  const h = makeHarness();
  await printAndFinish(h);
  const next = addTask(h, "b.gcode");
  const task = h.store.repositories.tasks.getById(next)!;
  h.store.repositories.tasks.update({
    ...task,
    night: true,
    unattendedAllowed: true,
    updatedAt: h.clock.now.toISOString()
  });

  const verdict = h.eligibilityFor(next, "night");
  const codes = blockerCodes(verdict);
  assert.ok(codes.includes(REASON.OPERATOR_SCHEDULE_UNKNOWN), "fail-closed on an unresolved schedule");
  assert.ok(codes.includes(REASON.MANUAL_OPERATION_REQUIRED));
});

test("a sleeping operator blocks the unattended continuation but not an attended start", async () => {
  const h = makeHarness();
  withSchedule(h);
  await printAndFinish(h); // still 03:00 — asleep
  const next = addTask(h, "b.gcode");
  const task = h.store.repositories.tasks.getById(next)!;
  h.store.repositories.tasks.update({
    ...task,
    night: true,
    unattendedAllowed: true,
    updatedAt: h.clock.now.toISOString()
  });

  const night = h.eligibilityFor(next, "night");
  assert.ok(blockerCodes(night).includes(REASON.OPERATOR_UNAVAILABLE));

  // The same facts in manual mode: the operator is evidently awake enough to
  // press the button, so their schedule is context, not a refusal. The mandatory
  // operation still blocks — that is the point of keeping the two separate.
  const manual = h.eligibilityFor(next, "manual");
  assert.ok(!blockerCodes(manual).includes(REASON.OPERATOR_UNAVAILABLE));
  assert.ok(
    manual.reasons.some(
      (r) => r.code === REASON.OPERATOR_UNAVAILABLE && r.severity === "warning"
    ),
    "…but it is still reported, as a warning"
  );
  assert.ok(blockerCodes(manual).includes(REASON.MANUAL_OPERATION_REQUIRED));
});

// ── 9. Cancelling an assignment cancels its unfinished operations ───────────

test("cancelling a task cancels the operations opened for its assignment", async () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  const taskId = addTask(h, "a.gcode");
  const assignment = h.queue.assignTask(taskId, "k2", { reason: "оператор выбрал" });

  const nozzle = h.operations.open({
    type: "NOZZLE_CHANGE",
    printerId: "k2",
    assignmentId: assignment.id,
    reason: "нужен 0.6"
  });
  assert.equal(h.operations.getOperation(nozzle.id).state, "READY");

  h.queue.cancelTask(taskId, "передумали");

  const after = h.operations.getOperation(nozzle.id);
  assert.equal(after.state, "CANCELLED", "работа, которой больше нет, не держит принтер");
  assert.equal(h.operations.printerHold("k2").free, true);
});

test("cancelling an assignment does NOT cancel the bed clearance it left behind", async () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  const taskId = addTask(h, "a.gcode");
  const result = await h.dispatch.dispatch({ taskId, mode: "manual" });
  h.lifecycle.completeRun(result.runId, "SUCCEEDED");

  const [clearance] = h.operations.openFor("k2");
  const run = h.store.repositories.printRuns.getById(result.runId)!;
  h.queue.invalidateAssignment(run.assignmentId, "снято оператором");

  assert.notEqual(
    h.operations.getOperation(clearance.id).state,
    "CANCELLED",
    "withdrawing paperwork does not take the part off the plate"
  );
  assert.equal(h.operations.printerHold("k2").free, false, "the printer stays held");
  assert.equal(bedState(h), "AWAITING_CLEARANCE");
});

// ── 10. Confirmation is idempotent ─────────────────────────────────────────

test("confirming an operation twice is idempotent — one clearance, one audit row", async () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  await printAndFinish(h);
  const [operation] = h.operations.openFor("k2");

  const first = h.operations.complete(operation.id, { actor: "operator-1", actualMinutes: 4 });
  const auditAfterFirst = h.store.repositories.audit.list().length;

  // A double-click, and then a much later repeat.
  const second = h.operations.complete(operation.id, { actor: "operator-2", actualMinutes: 99 });
  h.clock.now = new Date("2026-07-28T09:00:00Z");
  const third = h.operations.complete(operation.id, { actor: "operator-3" });

  assert.equal(second.completedAt, first.completedAt, "the completion time does not move");
  assert.equal(second.confirmedBy, "operator-1", "the first confirmer stands");
  assert.equal(second.actualMinutes, 4, "the reported duration is not overwritten");
  assert.deepEqual(third, first);
  assert.equal(
    h.store.repositories.audit.list().length,
    auditAfterFirst,
    "no second completion or clearance was written"
  );
});

test("a repeated clearance cannot free a bed that has since been re-reserved", async () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  await printAndFinish(h);
  const [operation] = h.operations.openFor("k2");
  h.operations.complete(operation.id, { actor: "operator-1" });

  // A new print takes the plate.
  const next = addTask(h, "b.gcode");
  await h.dispatch.dispatch({ taskId: next, mode: "manual" });
  assert.equal(bedState(h), "RUNNING");

  h.operations.complete(operation.id, { actor: "operator-1" });
  assert.equal(bedState(h), "RUNNING", "the stale confirmation did not clear a live plate");
});

// ── 11. One operator cannot perform two operations at once ─────────────────

test("one operator cannot hold two operations at once", async () => {
  const h = makeHarness();
  const operatorId = withSchedule(h);
  h.clock.now = MORNING;

  const first = h.operations.open({ type: "NOZZLE_CHANGE", printerId: "k2" });
  const second = h.operations.open({ type: "CALIBRATION", printerId: "k2" });
  h.operations.refreshReadiness();

  h.operations.claim(first.id, operatorId);
  assert.throws(
    () => h.operations.claim(second.id, operatorId),
    (e: unknown) => e instanceof JobError && /уже выполняет/.test((e as Error).message)
  );

  // Re-claiming the same one is a harmless no-op…
  assert.equal(h.operations.claim(first.id, operatorId).id, first.id);
  // …and finishing the first frees the operator for the second.
  h.operations.complete(first.id, { actor: "оператор" });
  assert.equal(h.operations.claim(second.id, operatorId).state, "IN_PROGRESS");
});

// ── 12. Unfinished operations survive a restart ────────────────────────────

test("unfinished operations are recovered after a restart, with readiness re-derived", async () => {
  const h = makeHarness();
  const operatorId = withSchedule(h);
  await printAndFinish(h); // 03:00, operator asleep → PENDING
  const [operation] = h.operations.openFor("k2");
  const claimed = h.operations.open({ type: "CALIBRATION", printerId: "k2" });
  h.clock.now = MORNING;
  h.operations.refreshReadiness();
  h.operations.claim(claimed.id, operatorId);
  // Rewind to the small hours and let the sweep defer the removal again, so the
  // process goes down with a genuinely PENDING operation and a claimed one.
  h.clock.now = NIGHT;
  h.operations.refreshReadiness();
  assert.equal(h.operations.getOperation(operation.id).state, "PENDING");

  // "Restart": a brand-new service pair over the SAME store, as the composition
  // root builds after a reboot. The rows are durable; the readiness is not.
  const clock = { now: MORNING };
  const schedule2 = new OperatorScheduleService(h.store, { now: () => clock.now });
  const operations2 = new ManualOperationService(h.store, schedule2, { now: () => clock.now });

  const recovered = operations2.recover();
  assert.equal(recovered.open, 2, "both unfinished operations came back");
  assert.equal(recovered.inProgress, 1);
  assert.equal(recovered.promoted, 1, "the deferred removal is now performable");

  assert.equal(operations2.getOperation(operation.id).state, "READY");
  assert.equal(
    operations2.getOperation(claimed.id).state,
    "IN_PROGRESS",
    "a human may still be holding the nozzle — never reset behind their back"
  );
  assert.equal(operations2.printerHold("k2").free, false, "the printer is still held");
});

// ── 14. Night auto-start and automatic continuation stay OFF ───────────────

test("nothing starts a print by itself: no scheduler tick, no automatic continuation", async () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  await printAndFinish(h);
  const next = addTask(h, "b.gcode");
  const task = h.store.repositories.tasks.getById(next)!;
  h.store.repositories.tasks.update({
    ...task,
    night: true,
    unattendedAllowed: true,
    updatedAt: h.clock.now.toISOString()
  });

  // Every read the system performs — readiness sweep, holds, eligibility — and
  // an explicit unattended attempt. None of them may reach the device.
  h.operations.refreshReadiness();
  h.operations.printerHold("k2");
  h.eligibilityFor(next, "night");
  await assert.rejects(h.dispatch.dispatch({ taskId: next, mode: "night" }), JobError);

  assert.equal(h.startCalls.length, 1, "only the operator-initiated first print ever ran");
});

test("an available operator still does not license automatic continuation onto a held bed", async () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING; // operator is right there
  await printAndFinish(h);
  const next = addTask(h, "b.gcode");
  const task = h.store.repositories.tasks.getById(next)!;
  h.store.repositories.tasks.update({
    ...task,
    night: true,
    unattendedAllowed: true,
    updatedAt: h.clock.now.toISOString()
  });

  const verdict = h.eligibilityFor(next, "night");
  const codes = blockerCodes(verdict);
  assert.ok(codes.includes(REASON.MANUAL_OPERATION_REQUIRED));
  assert.ok(codes.includes(REASON.BED_NOT_CLEAR), "the plate is still the physical blocker");
  assert.ok(
    !codes.includes(REASON.OPERATOR_UNAVAILABLE),
    "the operator being present is not itself a problem — the un-cleared bed is"
  );
});

// ── The operation lifecycle ────────────────────────────────────────────────

test("a failed operation keeps holding the printer and can be retried", async () => {
  const h = makeHarness();
  const operatorId = withSchedule(h);
  h.clock.now = MORNING;
  const nozzle = h.operations.open({ type: "NOZZLE_CHANGE", printerId: "k2" });
  h.operations.refreshReadiness();
  h.operations.claim(nozzle.id, operatorId);

  const failed = h.operations.fail(nozzle.id, { actor: "оператор", note: "сопло всё ещё забито" });
  assert.equal(failed.state, "FAILED");
  assert.equal(h.operations.printerHold("k2").free, false, "a failed fix is not a working printer");

  // Retry: FAILED → IN_PROGRESS → COMPLETED.
  h.operations.claim(nozzle.id, operatorId);
  assert.equal(h.operations.complete(nozzle.id, { actor: "оператор" }).state, "COMPLETED");
  assert.equal(h.operations.printerHold("k2").free, true);
});

test("a completed operation is terminal — it cannot be reopened or cancelled", async () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  const op = h.operations.open({ type: "CALIBRATION", printerId: "k2" });
  h.operations.complete(op.id, { actor: "оператор" });

  assert.throws(() => h.operations.cancel(op.id, "передумали"), JobError);
  assert.throws(() => h.operations.fail(op.id, {}), StateTransitionError);
});

test("a cancelled operation cannot be confirmed as done", async () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  const op = h.operations.open({ type: "CALIBRATION", printerId: "k2" });
  h.operations.cancel(op.id, "не нужна");

  assert.throws(
    () => h.operations.complete(op.id, { actor: "оператор" }),
    (e: unknown) => e instanceof JobError && /отменена/.test((e as Error).message)
  );
});

test("every open operation carries its type's own duration into the hold projection", async () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  h.operations.open({ type: "MATERIAL_CHANGE", printerId: "k2" });
  h.operations.open({ type: "NOZZLE_CHANGE", printerId: "k2" });

  const pending = h.operations.pending();
  const material = pending.find((p) => p.operation.type === "MATERIAL_CHANGE");
  const nozzle = pending.find((p) => p.operation.type === "NOZZLE_CHANGE");
  assert.equal(material?.expectedMinutes, 15);
  assert.equal(nozzle?.expectedMinutes, 25);
  assert.equal(material?.label, OPERATION_LABELS.MATERIAL_CHANGE);

  // 08:00 + 15 + 25 — sequential, because there is one operator.
  assert.equal(h.operations.printerHold("k2").releaseAt, "2026-07-28T05:40:00.000Z");
});

test("an operation whose duration is explicitly unknown makes the release time unknown", async () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  h.operations.open({ type: "CALIBRATION", printerId: "k2", estimatedMinutes: null });

  const hold = h.operations.printerHold("k2");
  assert.equal(hold.free, false);
  assert.equal(hold.releaseAt, null, "fail-closed: an unestimated task has no finish time");
});

test("forced idle is measured from when the operation was opened, and only while waiting", async () => {
  const h = makeHarness();
  withSchedule(h);
  await printAndFinish(h); // 03:00 MSK, asleep

  h.clock.now = new Date("2026-07-28T02:00:00Z"); // two hours later, still asleep
  const waiting = h.operations.printerHold("k2");
  assert.equal(waiting.forcedIdleMinutes, 120, "два часа вынужденного простоя");

  const [operation] = h.operations.openFor("k2");
  h.clock.now = MORNING;
  h.operations.refreshReadiness();
  h.operations.claim(operation.id, h.schedule.primaryOperator()!.id);
  assert.equal(
    h.operations.printerHold("k2").forcedIdleMinutes,
    null,
    "hands on the machine is work, not idle"
  );
});
