import assert from "node:assert/strict";
import { test } from "node:test";

import { JobError, StateTransitionError } from "../../core/errors";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { PrinterLiveStatus } from "../../infra/printers/status";
import { openPrintQueueStore } from "../../infra/db/store";
import { PrintQueueService } from "../printQueue/printQueueService";
import { DispatchService, type DispatchDeps } from "./dispatchService";
import { RunLifecycleService } from "./runLifecycle";
import type { PrinterConfig } from "../../infra/printers/config";

/*
 * Run lifecycle reconciliation: the observed printer reality vs the canonical
 * SQLite run. Positive evidence attaches, observed endings complete EXACTLY
 * once, everything ambiguous goes UNKNOWN for the operator — never a second
 * run, never an invented completion.
 */

const K2 = {
  id: "k2",
  name: "K2",
  model: "K2",
  type: "FDM",
  protocol: "moonraker",
  host: "127.0.0.1",
  material: "PLA",
  swatch: "",
  snapshotUrl: "",
  streamUrl: "",
  enabled: true
} as unknown as PrinterConfig;

function status(over: Partial<PrinterLiveStatus>): PrinterLiveStatus {
  return {
    id: "k2",
    online: true,
    status: "idle",
    currentFile: null,
    progressPct: null,
    remainingMinutes: null,
    filamentUsedMm: null,
    amsTrays: null,
    nozzleDiameterMm: null,
    nozzleType: null,
    liveMaterial: null,
    liveMaterialColor: null,
    activeTray: null,
    stateText: null,
    stateMessage: null,
    faults: [],
    mediaPresent: null,
    error: null,
    updatedAt: new Date().toISOString(),
    ...over
  } as PrinterLiveStatus;
}

const printing = (file = "chalice.gcode") => status({ status: "printing", currentFile: file });
const idle = (over: Partial<PrinterLiveStatus> = {}) => status({ status: "idle", ...over });

async function runningRun(): Promise<{
  store: PrintQueueStore;
  lifecycle: RunLifecycleService;
  runId: string;
  taskId: string;
}> {
  const store = openPrintQueueStore(":memory:");
  const queue = new PrintQueueService(store);
  const taskId = queue.createTask({
    title: "Chalice",
    printer: "k2",
    material: "PLA",
    file: "chalice.gcode"
  }).task.id;
  const deps: DispatchDeps = {
    store,
    resolvePrinter: () => K2,
    getStatus: () => idle(),
    startPhysical: async () => {},
    classifyError: () => "unknown",
    listFiles: async () => ({
      path: "",
      entries: [{ name: "chalice.gcode", path: "chalice.gcode", type: "file", size: 5, printable: true }]
    }),
    // Nothing under test here depends on admission rules — the lifecycle tests
    // start from an already-reserved run, so a permissive evaluator is honest.
    evaluateEligibility: () => ({
      status: "eligible" as const,
      reasons: [],
      preflight: {
        taskId: "",
        printerId: "",
        verdict: "compatible" as const,
        blockers: [],
        reviews: [],
        warnings: [],
        eta: { seconds: null, source: "unknown" as const, preliminary: true }
      },
      nightWindowFit: null
    })
  };
  const result = await new DispatchService(deps).dispatch({ taskId, mode: "manual" });
  return { store, lifecycle: new RunLifecycleService(store), runId: result.runId, taskId };
}

test("completeRun cascades the chain: task COMPLETED, assignment RELEASED, bed AWAITING_CLEARANCE", async () => {
  const { store, lifecycle, runId, taskId } = await runningRun();
  const repos = store.repositories;
  const run = repos.printRuns.getById(runId)!;

  const done = lifecycle.completeRun(runId, "SUCCEEDED", { reason: "operator confirmed" });
  assert.equal(done.state, "SUCCEEDED");
  assert.equal(done.progress, 1);
  assert.equal(repos.tasks.getById(taskId)?.state, "COMPLETED");
  assert.equal(repos.assignments.getById(run.assignmentId)?.state, "RELEASED");
  assert.equal(repos.bedCycles.getById(run.bedCycleId!)?.state, "AWAITING_CLEARANCE");
  assert.equal(repos.queue.findByTaskId(taskId)?.state, "RELEASED");
  // The completion is journalled.
  assert.ok(
    repos.audit.listByEntity("print_run", runId).some((e) => e.action === "completed"),
    "run completion is journalled"
  );
});

test("completeRun is refused a second time (a terminal run cannot be re-completed)", async () => {
  const { store, lifecycle, runId } = await runningRun();
  const done = lifecycle.completeRun(runId, "SUCCEEDED");
  assert.equal(done.state, "SUCCEEDED");
  assert.throws(
    () => lifecycle.completeRun(runId, "FAILED"),
    (e: unknown) => e instanceof StateTransitionError,
    "an already-completed run cannot transition again"
  );
  assert.equal(store.repositories.printRuns.getById(runId)?.state, "SUCCEEDED");
});

test("an observed printing→idle completion closes the run SUCCEEDED exactly once", async () => {
  const { store, lifecycle, runId, taskId } = await runningRun();

  lifecycle.observe("k2", printing(), idle({ stateText: "complete", progressPct: 100 }));
  const run = store.repositories.printRuns.getById(runId)!;
  assert.equal(run.state, "SUCCEEDED");
  assert.ok(run.endedAt, "end time recorded");
  assert.equal(store.repositories.tasks.getById(taskId)?.state, "COMPLETED");

  // The same completion event delivered again is a no-op, not a second record.
  lifecycle.observe("k2", printing(), idle({ stateText: "complete", progressPct: 100 }));
  const again = store.repositories.printRuns.getById(runId)!;
  assert.equal(again.state, "SUCCEEDED");
  assert.equal(again.updatedAt, run.updatedAt, "no second completion write");
});

test("an observed cancellation closes the run CANCELLED; an error closes it FAILED", async () => {
  const a = await runningRun();
  a.lifecycle.observe("k2", printing(), idle({ stateText: "cancelled" }));
  assert.equal(a.store.repositories.printRuns.getById(a.runId)?.state, "CANCELLED");

  const b = await runningRun();
  b.lifecycle.observe("k2", printing(), status({ status: "error", error: "thermal runaway" }));
  const run = b.store.repositories.printRuns.getById(b.runId)!;
  assert.equal(run.state, "FAILED");
  assert.equal(b.store.repositories.tasks.getById(b.taskId)?.state, "FAILED");
});

test("reconnect finding the printer idle does NOT auto-complete: run goes UNKNOWN for review", async () => {
  const { store, lifecycle, runId } = await runningRun();

  // The ending was never observed (prev = offline): ambiguous, fail-closed.
  lifecycle.observe("k2", status({ status: "offline", online: false }), idle());
  assert.equal(store.repositories.printRuns.getById(runId)?.state, "UNKNOWN");
});

test("reconnect finding the SAME file still printing keeps the existing run (no new run)", async () => {
  const { store, lifecycle, runId, taskId } = await runningRun();

  lifecycle.observe("k2", status({ status: "offline", online: false }), printing());
  assert.equal(store.repositories.printRuns.getById(runId)?.state, "RUNNING");
  assert.equal(store.repositories.printRuns.listByTask(taskId).length, 1, "no second run minted");
});

test("a different file under a live run flags identity lost (UNKNOWN), never guesses", async () => {
  const { store, lifecycle, runId } = await runningRun();

  lifecycle.observe("k2", printing(), printing("other.gcode"));
  const run = store.repositories.printRuns.getById(runId)!;
  assert.equal(run.state, "UNKNOWN");
  assert.equal(run.metadata.identityLost, "other.gcode");
});

test("completion after reconnect is recorded once the ending is actually observed", async () => {
  const { store, lifecycle, runId } = await runningRun();

  // Disconnect and back while still printing — run stays RUNNING…
  lifecycle.observe("k2", status({ status: "offline", online: false }), printing());
  // …then the real ending is watched: completes exactly once.
  lifecycle.observe("k2", printing(), idle({ stateText: "complete" }));
  assert.equal(store.repositories.printRuns.getById(runId)?.state, "SUCCEEDED");
});

test("operator resolveRun: refused while the device prints the run's file; allowed when idle; only once", async () => {
  const { store, lifecycle, runId } = await runningRun();
  lifecycle.observe("k2", status({ status: "offline", online: false }), idle()); // → UNKNOWN

  assert.throws(
    () => lifecycle.resolveRun(runId, "SUCCEEDED", { status: printing() }),
    (e: unknown) => e instanceof JobError
  );

  const resolved = lifecycle.resolveRun(runId, "SUCCEEDED", { status: idle() });
  assert.equal(resolved.state, "SUCCEEDED");
  assert.throws(
    () => lifecycle.resolveRun(runId, "FAILED", { status: idle() }),
    (e: unknown) => e instanceof StateTransitionError,
    "a terminal run cannot be resolved twice"
  );
  assert.equal(store.repositories.printRuns.getById(runId)?.state, "SUCCEEDED");
});

test("start guard and run recover TOGETHER: guard held while its run is unresolved, dropped when terminal", async () => {
  const { store, lifecycle, runId } = await runningRun();
  // Simulate the crash window: guard still present for the running dispatch.
  store.repositories.startGuards.upsert({
    printerId: "k2",
    file: "chalice.gcode",
    state: "ACKED",
    jobRef: runId,
    runId,
    requestedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  // Positive evidence (device printing our file) confirms and releases the guard.
  lifecycle.observe("k2", status({ status: "offline", online: false }), printing());
  assert.equal(store.repositories.printRuns.getById(runId)?.state, "RUNNING");
  // Completion drops the guard together with closing the run.
  lifecycle.observe("k2", printing(), idle({ stateText: "complete" }));
  assert.equal(store.repositories.startGuards.get("k2"), null, "guard released with the run");
});

// ── A start the device has since refused ─────────────────────────────────────
//
// The fail-closed hold below is correct when the evidence is silence. It was
// applied to a case that was not silent: an A1 that could not read its MicroSD
// card sat at IDLE reporting `0500-C010`, and the UNKNOWN run went on reserving
// the bed — which made the printer report itself busy to its own queue, with no
// exit but a human who knew to look for one.

/** A dispatched run whose start threw, leaving it held and never started. */
async function unconfirmedRun(): Promise<{
  store: PrintQueueStore;
  lifecycle: RunLifecycleService;
  runId: string;
  taskId: string;
}> {
  const store = openPrintQueueStore(":memory:");
  const queue = new PrintQueueService(store);
  const taskId = queue.createTask({
    title: "Chalice",
    printer: "k2",
    material: "PLA",
    file: "chalice.gcode"
  }).task.id;
  const deps: DispatchDeps = {
    store,
    resolvePrinter: () => K2,
    getStatus: () => idle(),
    startPhysical: async () => {
      throw new Error("принтер не подтвердил запуск");
    },
    classifyError: () => "unknown",
    listFiles: async () => ({
      path: "",
      entries: [{ name: "chalice.gcode", path: "chalice.gcode", type: "file", size: 5, printable: true }]
    }),
    evaluateEligibility: () => ({
      status: "eligible" as const,
      reasons: [],
      preflight: {
        taskId: "",
        printerId: "",
        verdict: "compatible" as const,
        blockers: [],
        reviews: [],
        warnings: [],
        eta: { seconds: null, source: "unknown" as const, preliminary: true }
      },
      nightWindowFit: null
    })
  };
  await assert.rejects(() => new DispatchService(deps).dispatch({ taskId, mode: "manual" }));
  const run = store.repositories.printRuns.findActiveByPrinter("k2");
  assert.ok(run, "the held run exists");
  return { store, lifecycle: new RunLifecycleService(store), runId: run.id, taskId };
}

const withFault = (over: Partial<PrinterLiveStatus> = {}) =>
  idle({
    faults: [
      {
        code: "0500-C010",
        source: "print_error",
        title: "Ошибка чтения/записи карты MicroSD",
        action: "Переустановите карту MicroSD или замените её.",
        blocksStart: true
      }
    ],
    ...over
  });

test("an idle printer reporting a start-blocking fault releases the run it never started", async () => {
  const { store, lifecycle, runId, taskId } = await unconfirmedRun();
  const repos = store.repositories;
  assert.equal(repos.printRuns.getById(runId)?.state, "UNKNOWN");

  lifecycle.observe("k2", idle(), withFault());

  assert.equal(repos.printRuns.getById(runId)?.state, "CANCELLED");
  assert.equal(repos.printRuns.findActiveByPrinter("k2"), null, "the printer is free again");
  assert.equal(
    repos.tasks.getById(taskId)?.state,
    "QUEUED",
    "the job was never wrong — it returns to the queue for a corrected retry"
  );
  assert.equal(repos.startGuards.get("k2"), null, "the hold is dropped with the run");
  const bed = repos.bedCycles.findOpenByPrinter("k2");
  assert.ok(bed === null || bed.state === "CLEAR");
});

test("an unreadable print medium releases it too", async () => {
  const { store, lifecycle, runId } = await unconfirmedRun();
  lifecycle.observe("k2", idle(), idle({ mediaPresent: false }));
  assert.equal(store.repositories.printRuns.getById(runId)?.state, "CANCELLED");
});

test("silence still holds the run — only a NAMED cause may release it", async () => {
  const { store, lifecycle, runId } = await unconfirmedRun();

  // An idle printer with nothing to say could still be one whose print started
  // and is not yet visible. Guessing here is how a live print gets cancelled.
  lifecycle.observe("k2", idle(), idle());
  assert.equal(store.repositories.printRuns.getById(runId)?.state, "UNKNOWN");

  // An unrecognised fault is not a named cause either.
  lifecycle.observe(
    "k2",
    idle(),
    idle({
      faults: [
        { code: "0700-8011", source: "hms", title: null, action: null, blocksStart: false }
      ]
    })
  );
  assert.equal(store.repositories.printRuns.getById(runId)?.state, "UNKNOWN");
});

test("a run the device IS printing is never released by a fault beside it", async () => {
  const { store, lifecycle, runId } = await runningRun();
  lifecycle.observe(
    "k2",
    printing(),
    withFault({ status: "printing", currentFile: "chalice.gcode" })
  );
  assert.equal(
    store.repositories.printRuns.getById(runId)?.state,
    "RUNNING",
    "positive evidence of the print outranks the fault channel"
  );
});

test("resolving an unstarted run re-queues the task instead of failing it terminally", async () => {
  const { store, lifecycle, runId, taskId } = await unconfirmedRun();

  lifecycle.resolveRun(runId, "FAILED", { status: idle(), actor: "operator" });

  const repos = store.repositories;
  assert.equal(repos.printRuns.getById(runId)?.state, "CANCELLED");
  assert.equal(
    repos.tasks.getById(taskId)?.state,
    "QUEUED",
    "«it never started» is not «it failed» — the operator must have a job left to relaunch"
  );
  assert.equal(repos.printRuns.findActiveByPrinter("k2"), null);
});
