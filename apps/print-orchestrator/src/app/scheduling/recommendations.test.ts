import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { REASON } from "../../domain/dispatch/reasons";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type {
  Artifact,
  ArtifactAnalysis,
  PrintTask,
  QueueEntry
} from "../../domain/print/types";
import { openPrintQueueStore } from "../../infra/db/store";
import { ManualOperationService } from "../operations/manualOperationService";
import { OperatorScheduleService } from "../operations/operatorScheduleService";
import {
  SchedulerService,
  type PlanDetail,
  type SchedulerConfig,
  type SchedulerPrinterRef
} from "./schedulerService";

/*
 * The recommendation planner, end to end over a real (in-memory) SQLite store
 * with a **fake clock** and **no adapters at all**.
 *
 * Every claim here is about *when* something can happen, so the clock is a
 * mutable `now` the tests move by hand — a wall-clock test could assert none of
 * it. Nothing in this file talks to a printer: the scheduler has no adapter, no
 * uploader and no dispatcher wired into it, which is itself one of the
 * assertions (see "план не вызывает upload, dispatch или команды принтера").
 */

/** 03:00 Europe/Moscow — the instant the brief's night print finishes. */
const NIGHT = new Date("2026-07-28T00:00:00.000Z");
/** 08:00 Europe/Moscow — when the operator's shift opens. */
const MORNING = new Date("2026-07-28T05:00:00.000Z");
const MIN = 60_000;
const H = 60 * MIN;

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ── Harness ─────────────────────────────────────────────────────────────────

interface Harness {
  store: PrintQueueStore;
  clock: { now: Date };
  schedule: OperatorScheduleService;
  operations: ManualOperationService;
  printers: SchedulerPrinterRef[];
  /** Rebuilt per call so it always sees the current clock and printer knobs. */
  scheduler: () => SchedulerService;
}

function printer(id: string, over: Partial<SchedulerPrinterRef> = {}): SchedulerPrinterRef {
  return {
    id,
    name: id.toUpperCase(),
    model: id.toUpperCase(),
    protocol: "moonraker",
    printerClass: null,
    material: "PLA",
    nozzleMm: 0.4,
    buildVolume: { x: 300, y: 300, z: 300 },
    online: true,
    status: "idle",
    remoteStartSupported: true,
    ams: null,
    telemetryAgeMs: 1000,
    materialRemainingSufficient: null,
    printingTimeLeftMs: null,
    activeRunState: null,
    ...over
  };
}

function makeHarness(options: { dbPath?: string; printers?: SchedulerPrinterRef[] } = {}): Harness {
  const store = openPrintQueueStore(options.dbPath ?? ":memory:");
  const clock = { now: NIGHT };
  const now = (): Date => clock.now;
  const schedule = new OperatorScheduleService(store, { now });
  const operations = new ManualOperationService(store, schedule, { now });
  const printers = options.printers ?? [printer("p1")];

  const config = (): SchedulerConfig => ({
    now,
    runtimeAvailable: true,
    nightSafetyBufferRatio: 0.2,
    nightWindow: "21:30 – 07:30",
    farmTimeZone: "Europe/Moscow",
    compatibility: { telemetryStaleMs: 120_000 },
    unknownEtaAssumptionS: 4 * 3600,
    manualOperations: (printerId) => operations.openFor(printerId),
    operatorAvailabilityAt: (at) => schedule.availability(at)
  });

  return {
    store,
    clock,
    schedule,
    operations,
    printers,
    scheduler: () => new SchedulerService(store, () => printers, config())
  };
}

/** The default operator: 08:00–20:00 available, 23:00–07:00 asleep, Europe/Moscow. */
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

/** A ready-to-print G-code task in the open queue. */
function addTask(
  store: PrintQueueStore,
  id: string,
  over: {
    durationS?: number | null;
    material?: string | null;
    nozzle?: number | null;
    priority?: number;
    position?: number;
    pinnedPrinterId?: string | null;
    createdAt?: string;
    unattended?: boolean;
  } = {}
): PrintTask {
  const iso = NIGHT.toISOString();
  const repos = store.repositories;
  const artifact: Artifact = {
    id: `art_${id}`,
    kind: "gcode",
    name: `${id}.gcode`,
    source: `${id}.gcode`,
    sizeBytes: null,
    sha256: null,
    createdAt: iso,
    updatedAt: iso,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  repos.artifacts.insert(artifact);

  const analysis: ArtifactAnalysis = {
    id: `ana_${id}`,
    artifactId: artifact.id,
    state: "ready",
    detectedFormat: "gcode",
    verdict: "schedulable",
    analyzer: "gcode",
    analyzerVersion: "1",
    estimatedDurationS: over.durationS === undefined ? 3600 : over.durationS,
    estimatedFilamentG: 20,
    material: over.material === undefined ? "PLA" : over.material,
    nozzleDiameterMm: over.nozzle === undefined ? 0.4 : over.nozzle,
    layerHeightMm: 0.2,
    warnings: [],
    blockers: [],
    data: { size: [100, 100, 100] },
    error: null,
    createdAt: iso,
    updatedAt: iso,
    version: 1,
    metadata: {}
  };
  repos.artifactAnalyses.insert(analysis);

  const task: PrintTask = {
    id,
    artifactId: artifact.id,
    sliceVariantId: null,
    sourceArtifactId: null,
    onDeviceFile: `${id}.gcode`,
    title: id,
    material: over.material === undefined ? "PLA" : over.material,
    targetPrinter: null,
    priority: over.priority ?? 0,
    state: "QUEUED",
    reason: null,
    night: false,
    notBefore: null,
    deadline: null,
    dayNightPreference: "any",
    pinnedPrinterId: over.pinnedPrinterId ?? null,
    unattendedAllowed: over.unattended === true,
    createdAt: over.createdAt ?? iso,
    updatedAt: iso,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  repos.tasks.insert(task);

  const entry: QueueEntry = {
    id: `qe_${id}`,
    taskId: id,
    position: over.position ?? 10,
    state: "WAITING",
    enqueuedAt: iso,
    updatedAt: iso,
    version: 1
  };
  repos.queue.insert(entry);
  return task;
}

/** Opens the clearance a finished print leaves behind, on an AWAITING_CLEARANCE bed. */
function leavePartOnPlate(h: Harness, printerId: string, options: { minutes?: number | null } = {}): string {
  const iso = h.clock.now.toISOString();
  const bed = h.store.repositories.bedCycles.insert({
    id: `bed_${printerId}_${Math.random().toString(36).slice(2, 8)}`,
    printerId,
    assignmentId: null,
    state: "AWAITING_CLEARANCE",
    clearedAt: null,
    createdAt: iso,
    updatedAt: iso,
    version: 1,
    metadata: {}
  });
  const operation = h.operations.open({
    type: "PART_REMOVAL",
    printerId,
    bedCycleId: bed.id,
    origin: "print_finished",
    ...(options.minutes === undefined ? {} : { estimatedMinutes: options.minutes })
  });
  return operation.id;
}

/** The placements of a plan, as a comparable, id-free shape. */
function shapeOf(plan: PlanDetail): unknown {
  return plan.assignments
    .map((a) => ({
      taskId: a.assignment.taskId,
      printerId: a.assignment.printerId,
      startMs: a.explanation?.startMs ?? null,
      endMs: a.explanation?.endMs ?? null
    }))
    .sort((x, y) => x.taskId.localeCompare(y.taskId));
}

const placementFor = (plan: PlanDetail, taskId: string): PlanDetail["assignments"][number] | undefined =>
  plan.assignments.find((a) => a.assignment.taskId === taskId);

// ── 1. A finished print does not free the printer ───────────────────────────

test("1. завершение печати не освобождает принтер до снятия модели", () => {
  const h = makeHarness();
  withSchedule(h);
  addTask(h.store, "t1");
  leavePartOnPlate(h, "p1");

  const plan = h.scheduler().buildDraftPlan();
  const a = placementFor(plan, "t1");
  assert.ok(a, "the work is still plannable — just not at 03:00");
  // 03:00 finish → operator asleep until 08:00 → 5-minute removal → 08:05.
  assert.equal(a.explanation?.startMs, MORNING.getTime() + 5 * MIN);
  assert.equal(plan.timeline[0].releaseAtMs, MORNING.getTime() + 5 * MIN);
  assert.equal(plan.timeline[0].releaseCode, "AWAITING_OPERATOR");
});

// ── 2. Night work moves to the first operator window ────────────────────────

test("2. операция ночью переносится на первое доступное окно оператора (03:00 → 08:00 → 08:05)", () => {
  const h = makeHarness();
  withSchedule(h);
  addTask(h.store, "t1");
  leavePartOnPlate(h, "p1");

  const lane = h.scheduler().buildDraftPlan().timeline[0];
  const wait = lane.segments.find((s) => s.kind === "operator_wait");
  const work = lane.segments.find((s) => s.kind === "operation");
  const print = lane.segments.find((s) => s.kind === "planned_print");

  assert.ok(wait && work && print, "the plan shows the pause explicitly, not as a silent gap");
  assert.equal(wait.startMs, NIGHT.getTime(), "03:00 — печать завершилась");
  assert.equal(wait.endMs, MORNING.getTime(), "03:00–08:00 — ожидание оператора");
  assert.equal(work.startMs, MORNING.getTime(), "08:00–08:05 — снятие модели");
  assert.equal(work.endMs, MORNING.getTime() + 5 * MIN);
  assert.equal(print.startMs, MORNING.getTime() + 5 * MIN, "08:05 — принтер доступен следующему");
  assert.equal(lane.waitingForOperator, true);
});

// ── 3. releaseAt: null leaves the work unplaced ─────────────────────────────

test("3. releaseAt: null оставляет задание непоставленным (без скрытого допущения)", () => {
  const h = makeHarness();
  withSchedule(h);
  addTask(h.store, "t1");
  // A removal nobody has estimated: the release time genuinely does not exist.
  leavePartOnPlate(h, "p1", { minutes: null });

  const plan = h.scheduler().buildDraftPlan();
  assert.equal(plan.assignments.length, 0);
  assert.equal(plan.unplaced.length, 1);
  assert.equal(plan.unplaced[0].code, "PRINTER_RELEASE_UNKNOWN");
  assert.equal(plan.timeline[0].releaseAtMs, null);
  assert.equal(plan.timeline[0].releaseCode, "RELEASE_UNKNOWN_DURATION");
});

test("3b. отсутствие расписания оператора тоже даёт null, а не «сейчас»", () => {
  const h = makeHarness(); // no schedule configured at all
  addTask(h.store, "t1");
  leavePartOnPlate(h, "p1");

  const plan = h.scheduler().buildDraftPlan();
  assert.equal(plan.assignments.length, 0);
  assert.equal(plan.unplaced[0].code, "PRINTER_RELEASE_UNKNOWN");
  assert.equal(plan.timeline[0].releaseCode, "RELEASE_UNKNOWN_SCHEDULE");
});

// ── 4. Material + nozzle change are sequential ──────────────────────────────

test("4. замена материала и сопла учитывается как последовательные операции", () => {
  const h = makeHarness();
  withSchedule(h);
  addTask(h.store, "t1");
  h.operations.open({ type: "MATERIAL_CHANGE", printerId: "p1" }); // 15 min
  h.operations.open({ type: "NOZZLE_CHANGE", printerId: "p1" }); // 25 min

  const plan = h.scheduler().buildDraftPlan();
  // 08:00 + 15 + 25 = 08:40 — not max(15, 25) and not 15 in parallel with 25.
  assert.equal(placementFor(plan, "t1")?.explanation?.startMs, MORNING.getTime() + 40 * MIN);
  assert.equal(plan.timeline[0].segments.filter((s) => s.kind === "operation").length, 2);
});

// ── 5. One operator cannot be in two places ────────────────────────────────

test("5. один оператор не выполняет две операции одновременно", () => {
  const h = makeHarness({ printers: [printer("p1"), printer("p2")] });
  withSchedule(h);
  addTask(h.store, "t1", { pinnedPrinterId: "p1" });
  addTask(h.store, "t2", { pinnedPrinterId: "p2" });
  leavePartOnPlate(h, "p1");
  leavePartOnPlate(h, "p2");

  const plan = h.scheduler().buildDraftPlan();
  const starts = ["t1", "t2"]
    .map((id) => placementFor(plan, id)?.explanation?.startMs ?? 0)
    .sort((a, b) => a - b);
  assert.equal(starts[0], MORNING.getTime() + 5 * MIN, "first plate cleared 08:00–08:05");
  assert.equal(starts[1], MORNING.getTime() + 10 * MIN, "second cleared 08:05–08:10, not in parallel");
});

// ── 6/7/8. Rolling horizon with a frozen head ──────────────────────────────

test("6. запущенное задание не меняется при пересчёте", () => {
  const h = makeHarness({ printers: [printer("p1"), printer("p2")] });
  withSchedule(h);
  h.clock.now = MORNING;
  addTask(h.store, "running");
  const first = h.scheduler().buildDraftPlan();
  const confirmed = h.scheduler().confirmPlan(first.plan.id);

  // The placement is now physically in flight: RESERVED and the task ASSIGNED.
  const assignment = confirmed.assignments[0].assignment;
  h.store.repositories.assignments.update({ ...assignment, state: "RESERVED" });
  const task = h.store.repositories.tasks.getById("running")!;
  h.store.repositories.tasks.update({ ...task, state: "ASSIGNED" });

  const replanned = h.scheduler().recomputeRecommendations("printer_state_changed");
  assert.equal(replanned.assignments.length, 0, "a running task is not re-placed");
  assert.deepEqual(
    replanned.frozen.map((f) => f.assignment.id),
    [assignment.id],
    "it is reported as frozen, referenced not copied"
  );
  assert.equal(replanned.frozen[0].explanation?.frozen, true);
  assert.equal(
    h.store.repositories.assignments.getById(assignment.id)?.state,
    "RESERVED",
    "and its stored state is untouched"
  );
});

test("7. подтверждённый ближайший assignment остаётся замороженным", () => {
  const h = makeHarness({ printers: [printer("p1"), printer("p2")] });
  withSchedule(h);
  h.clock.now = MORNING;
  addTask(h.store, "near");
  const confirmed = h.scheduler().confirmPlan(h.scheduler().buildDraftPlan().plan.id);
  const frozenId = confirmed.assignments[0].assignment.id;

  const replanned = h.scheduler().recomputeRecommendations("task_added");
  assert.deepEqual(replanned.frozen.map((f) => f.assignment.id), [frozenId]);
  assert.equal(replanned.assignments.length, 0, "the frozen task is not planned a second time");
  assert.ok(replanned.frozenUntil, "the plan states how far the freeze reaches");
});

test("8. изменение очереди перестраивает только неподтверждённую часть", () => {
  const h = makeHarness({ printers: [printer("p1"), printer("p2")] });
  withSchedule(h);
  h.clock.now = MORNING;
  addTask(h.store, "confirmed", { position: 1 });
  const confirmed = h.scheduler().confirmPlan(h.scheduler().buildDraftPlan().plan.id);
  const frozenAssignment = confirmed.assignments[0].assignment;

  // A new task arrives after confirmation.
  addTask(h.store, "fresh", { position: 2 });
  const replanned = h.scheduler().recomputeRecommendations("task_added");

  assert.deepEqual(
    replanned.assignments.map((a) => a.assignment.taskId),
    ["fresh"],
    "only the unconfirmed part is rebuilt"
  );
  assert.deepEqual(replanned.frozen.map((f) => f.assignment.id), [frozenAssignment.id]);
  const stored = h.store.repositories.assignments.getById(frozenAssignment.id)!;
  assert.equal(stored.printerId, frozenAssignment.printerId, "the frozen placement did not move");
  assert.equal(stored.state, "PROPOSED", "and was not cancelled by the recompute");
});

test("8b. подтверждённая работа за горизонтом заморозки возвращается в перестройку", () => {
  const h = makeHarness({ printers: [printer("p1")] });
  withSchedule(h);
  h.clock.now = MORNING;
  addTask(h.store, "a", { position: 1, durationS: 4 * 3600 });
  addTask(h.store, "b", { position: 2, durationS: 3600 });
  const confirmed = h.scheduler().confirmPlan(h.scheduler().buildDraftPlan().plan.id);
  // `b` is queued behind a 4-hour print, i.e. well past the 2-hour frozen horizon.
  const far = confirmed.assignments.find((x) => x.assignment.taskId === "b")!;
  assert.ok((far.explanation?.startMs ?? 0) > MORNING.getTime() + 2 * H);

  const replanned = h.scheduler().recomputeRecommendations("priority_changed");
  assert.deepEqual(
    replanned.frozen.map((f) => f.assignment.taskId),
    ["a"],
    "only the near-term placement stays frozen"
  );
  assert.deepEqual(
    replanned.assignments.map((a) => a.assignment.taskId),
    ["b"],
    "the far one is re-planned"
  );
});

// ── 9. Determinism ─────────────────────────────────────────────────────────

test("9. повторный расчёт с одинаковыми входными данными детерминирован", () => {
  const h = makeHarness({ printers: [printer("p1"), printer("p2"), printer("p3")] });
  withSchedule(h);
  h.clock.now = MORNING;
  addTask(h.store, "alpha", { position: 1 });
  addTask(h.store, "beta", { position: 2 });
  addTask(h.store, "gamma", { position: 3, durationS: 7200 });
  leavePartOnPlate(h, "p2");

  const first = h.scheduler().buildDraftPlan();
  const second = h.scheduler().buildDraftPlan();
  assert.deepEqual(shapeOf(second), shapeOf(first), "same inputs → same placements");
  assert.deepEqual(
    second.unplaced.map((u) => [u.taskId, u.code]),
    first.unplaced.map((u) => [u.taskId, u.code])
  );
  assert.deepEqual(
    second.timeline.map((l) => [l.printerId, l.releaseAtMs, l.releaseCode]),
    first.timeline.map((l) => [l.printerId, l.releaseAtMs, l.releaseCode])
  );
});

// ── 10. An untrustworthy ETA is not used as an exact time ──────────────────

test("10. недостоверная ETA не используется как точное время", () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  addTask(h.store, "t1", { durationS: null });

  const plan = h.scheduler().buildDraftPlan();
  assert.equal(plan.assignments.length, 0, "no start/end is invented");
  const [unplaced] = plan.unplaced;
  assert.equal(unplaced.code, "ETA_UNKNOWN");
  // The estimate survives only as an explicitly-marked visual hint.
  assert.equal(unplaced.hint?.approximate, true);
  assert.match(unplaced.hint?.note ?? "", /приблизительная/);
  const ghost = plan.timeline[0].segments.find((s) => s.kind === "approx_print");
  assert.equal(ghost?.approximate, true);
});

test("10b. предварительная (но известная) ETA помечается степенью достоверности", () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  addTask(h.store, "t1", { durationS: 3600 });
  const explanation = placementFor(h.scheduler().buildDraftPlan(), "t1")!.explanation!;
  assert.ok(["exact", "preliminary"].includes(explanation.etaConfidence));
  assert.equal(explanation.etaConfidence === "preliminary", explanation.etaPreliminary);
});

// ── 11. A manual-only printer is shown as needing a human ──────────────────

test("11. manual-only принтер отображается как требующий вмешательства", () => {
  const h = makeHarness({ printers: [printer("p1", { remoteStartSupported: false })] });
  withSchedule(h);
  h.clock.now = MORNING;
  addTask(h.store, "t1");

  const explanation = placementFor(h.scheduler().buildDraftPlan(), "t1")!.explanation!;
  assert.equal(explanation.manualStartRequired, true);
  assert.ok(explanation.warnings.some((w) => /вручную/.test(w)));
  assert.ok(
    explanation.manualOperations.some((op) => op.type === "FILE_TRANSFER_CONFIRM"),
    "the manual file transfer is named as a required operation"
  );
});

test("11b. каждое размещение называет операцию снятия и ожидаемое освобождение стола", () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  addTask(h.store, "t1", { durationS: 3600 });

  const explanation = placementFor(h.scheduler().buildDraftPlan(), "t1")!.explanation!;
  const removal = explanation.manualOperations.find((op) => op.type === "PART_REMOVAL");
  assert.equal(removal?.when, "after");
  // 09:00 print end + 5-minute removal, and flagged as a projection.
  assert.equal(explanation.bedReleaseMs, MORNING.getTime() + H + 5 * MIN);
  assert.equal(explanation.bedReleaseEstimated, true);
  assert.equal(explanation.requiresUpload, true, "no device file is tracked yet");
});

// ── 12. Planning touches no device ─────────────────────────────────────────

test("12. план не вызывает upload, dispatch или команды принтера", () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  addTask(h.store, "t1");

  const plan = h.scheduler().buildDraftPlan();
  const confirmed = h.scheduler().confirmPlan(plan.plan.id);
  h.scheduler().recomputeRecommendations("manual");

  const repos = h.store.repositories;
  assert.equal(repos.printRuns.listByTask("t1").length, 0, "no print run was created");
  assert.equal(repos.printRuns.listActive().length, 0, "no run holds a printer");
  for (const a of confirmed.assignments) {
    assert.equal(repos.dispatchAttempts.maxAttemptNo(a.assignment.id), 0, "no dispatch was attempted");
  }
  assert.equal(repos.deviceArtifacts.listByPrinter("p1").length, 0, "no file was uploaded");
  assert.equal(repos.bedCycles.findOpenByPrinter("p1"), null, "no bed was reserved");
  for (const a of confirmed.assignments) {
    assert.equal(a.assignment.state, "PROPOSED", "confirming a plan reserves nothing");
    assert.equal(a.assignment.bedCycleId, null);
  }
});

// ── 13. The superseded plan is marked stale ────────────────────────────────

test("13. старый план помечается устаревшим", () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  addTask(h.store, "t1");

  const first = h.scheduler().buildDraftPlan();
  const second = h.scheduler().recomputePlan(first.plan.id, "task_added");

  const oldPlan = h.scheduler().getPlan(first.plan.id);
  assert.equal(oldPlan.staleness.stale, true);
  assert.equal(oldPlan.staleness.supersededByPlanId, second.plan.id);
  assert.equal(second.staleness.stale, false, "the fresh recommendation is current");
});

test("13b. подтверждённый план остаётся ACTIVE, но помечается устаревшим новой рекомендацией", () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  addTask(h.store, "t1", { position: 1 });
  const confirmed = h.scheduler().confirmPlan(h.scheduler().buildDraftPlan().plan.id);

  addTask(h.store, "t2", { position: 2 });
  const fresh = h.scheduler().recomputeRecommendations("task_added");

  const reread = h.scheduler().getPlan(confirmed.plan.id);
  assert.equal(reread.plan.state, "ACTIVE", "still the plan of record — a draft does not cancel it");
  assert.equal(reread.staleness.stale, true);
  assert.equal(reread.staleness.supersededByPlanId, fresh.plan.id);
});

// ── 14. Stable unplaced codes ──────────────────────────────────────────────

test("14. причины непостановки имеют стабильные коды", () => {
  const h = makeHarness({ printers: [printer("p1")] });
  withSchedule(h);
  h.clock.now = MORNING;
  addTask(h.store, "no_eta", { durationS: null, position: 1 });
  addTask(h.store, "wrong_material", { material: "PETG", position: 2 });
  addTask(h.store, "bad_pin", { pinnedPrinterId: "p9", position: 3 });

  const codes = new Map(
    h.scheduler().buildDraftPlan().unplaced.map((u) => [u.taskId, u.code])
  );
  assert.equal(codes.get("no_eta"), "ETA_UNKNOWN");
  assert.equal(codes.get("wrong_material"), "NO_COMPATIBLE_PRINTER");
  assert.equal(codes.get("bad_pin"), "PINNED_PRINTER_UNAVAILABLE");
});

// ── 15. A plan survives a restart ──────────────────────────────────────────

test("15. после перезапуска активный и подтверждённый план читается корректно", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-plan-restart-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "queue.db");

  const first = makeHarness({ dbPath });
  withSchedule(first);
  first.clock.now = MORNING;
  addTask(first.store, "t1");
  leavePartOnPlate(first, "p1");
  const built = first.scheduler().buildDraftPlan();
  const confirmed = first.scheduler().confirmPlan(built.plan.id);
  const before = shapeOf(confirmed);
  const timelineBefore = confirmed.timeline;
  first.store.close?.();

  // A fresh process: new store, new services, same file.
  const second = makeHarness({ dbPath });
  second.clock.now = new Date(MORNING.getTime() + 3 * H);
  const reread = second.scheduler().getPlan(confirmed.plan.id);

  assert.equal(reread.plan.state, "ACTIVE");
  assert.deepEqual(shapeOf(reread), before, "the confirmed placements read back verbatim");
  assert.deepEqual(
    reread.timeline.map((l) => [l.printerId, l.releaseAtMs]),
    timelineBefore.map((l) => [l.printerId, l.releaseAtMs]),
    "the stored recommendation is not silently re-derived against the moved clock"
  );
  assert.equal(reread.assignments[0].assignment.state, "PROPOSED", "and nothing started meanwhile");
  second.store.close?.();
});

// ── 16. Night auto-start and automatic continuation stay off ───────────────

test("16. ночной автозапуск и автоматическое продолжение остаются выключенными", () => {
  const h = makeHarness();
  withSchedule(h);
  h.clock.now = MORNING;
  addTask(h.store, "n1", { unattended: true });

  // The night report is a *report*: it names candidates and starts nothing.
  const report = h.scheduler().nightCandidates();
  assert.ok(Array.isArray(report.candidates));
  assert.equal(h.store.repositories.printRuns.listActive().length, 0, "reporting starts nothing");

  // And the gate still refuses an unattended start: the farm has no verified
  // automatic bed clearing, so automatic continuation is not permitted.
  leavePartOnPlate(h, "p1");
  const verdict = h.scheduler().dispatchEligibility({ taskId: "n1", printerId: "p1", mode: "night" });
  const blockers = verdict.reasons.filter((r) => r.severity === "blocker").map((r) => r.code);
  assert.ok(blockers.includes(REASON.AUTOMATIC_CONTINUATION_NOT_SUPPORTED));
  assert.ok(blockers.includes(REASON.OPERATOR_INTERVENTION_REQUIRED));
  assert.equal(verdict.status, "blocked");
});
