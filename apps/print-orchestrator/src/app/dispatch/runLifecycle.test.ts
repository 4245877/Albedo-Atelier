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
    nightWindow: "21:30 – 07:30"
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
