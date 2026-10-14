import assert from "node:assert/strict";
import { test } from "node:test";

import { JobError } from "../../core/errors";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { PrinterConfig } from "../../infra/printers/config";
import type { PrinterLiveStatus } from "../../infra/printers/status";
import { openPrintQueueStore } from "../../infra/db/store";
import { PrintQueueService } from "../printQueue/printQueueService";
import { DispatchService, type DispatchDeps } from "./dispatchService";
import { finishedJobFile, RunLifecycleService, type BedOperationsPort } from "./runLifecycle";
import { establishClearBed } from "./testkit/bed";

/*
 * CRITICAL-02, the parts no run owns: prints started from the printer's own
 * screen (or an app), and prints that ran while Albedo was not watching. Both
 * leave plastic on the plate, and the next dispatch must not be told otherwise.
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

function status(over: Partial<PrinterLiveStatus> = {}): PrinterLiveStatus {
  return {
    id: "k2",
    online: true,
    status: "idle",
    currentFile: null,
    progressPct: null,
    remainingMinutes: null,
    filamentUsedMm: null,
    slicerFilamentG: null,
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
    faults: [],
    mediaPresent: null,
    error: null,
    updatedAt: new Date().toISOString(),
    ...over
  } as PrinterLiveStatus;
}

/** A spy standing in for the manual-operations service. */
function operationsSpy(): BedOperationsPort & { opened: { bedCycleId: string; reason?: string }[] } {
  const opened: { bedCycleId: string; reason?: string }[] = [];
  return {
    opened,
    openClearanceFor(input) {
      opened.push({ bedCycleId: input.bedCycleId, reason: input.reason });
      return { id: `op-${opened.length}` };
    },
    openClearanceOperations: () => [],
    complete: () => undefined
  };
}

function harness(options: { tracked?: boolean; live?: () => PrinterLiveStatus | undefined } = {}) {
  const store = openPrintQueueStore(":memory:");
  if (options.tracked !== false) establishClearBed(store, "k2");
  const ops = operationsSpy();
  const lifecycle = new RunLifecycleService(store, {
    operations: ops,
    getStatus: options.live ?? (() => undefined)
  });
  return { store, lifecycle, ops };
}

const latest = (store: PrintQueueStore) => store.repositories.bedCycles.latestByPrinter("k2");

test("a print started outside Albedo opens a RUNNING cycle marked external", () => {
  const { store, lifecycle } = harness();
  lifecycle.observe("k2", status(), status({ status: "printing", currentFile: "from-screen.gcode" }));
  const bed = latest(store)!;
  assert.equal(bed.state, "RUNNING");
  assert.equal(bed.metadata.external, true);
  assert.equal(bed.metadata.file, "from-screen.gcode");
  assert.ok(store.repositories.audit.listByEntity("bed_cycle", bed.id).some((e) => e.action === "external_print_observed"));
});

test("…and when it ends, the plate is AWAITING_CLEARANCE with a part-removal operation — never CLEAR", () => {
  const { store, lifecycle, ops } = harness();
  const printing = status({ status: "printing", currentFile: "from-screen.gcode" });
  lifecycle.observe("k2", status(), printing);
  lifecycle.observe("k2", printing, status({ currentFile: "from-screen.gcode", stateText: "complete" }));
  const bed = latest(store)!;
  assert.equal(bed.state, "AWAITING_CLEARANCE");
  assert.equal(ops.opened.length, 1, "the same tracked intervention a finished run opens");
  assert.equal(ops.opened[0].bedCycleId, bed.id);
});

test("repeated observations of the same external print do not open a second cycle", () => {
  const { store, lifecycle } = harness();
  const printing = status({ status: "printing", currentFile: "x.gcode" });
  lifecycle.observe("k2", status(), printing);
  lifecycle.observe("k2", printing, printing);
  lifecycle.observe("k2", printing, printing);
  assert.equal(store.repositories.bedCycles.listByPrinter("k2").filter((c) => c.metadata.external).length, 1);
});

test("first sight after a gap: a finished job Albedo cannot account for marks the plate occupied", () => {
  const { store, lifecycle, ops } = harness();
  // Albedo was down / the printer was off-line; it comes back reporting a
  // completed job nobody here started or watched.
  lifecycle.observe("k2", undefined, status({ currentFile: "printed-while-away.gcode", stateText: "complete" }));
  const bed = latest(store)!;
  assert.equal(bed.state, "AWAITING_CLEARANCE");
  assert.equal(bed.metadata.external, true);
  assert.equal(ops.opened.length, 1);
});

test("first sight after a gap with the job the operator already cleared does NOT re-flag it", () => {
  let live: PrinterLiveStatus | undefined = status({ currentFile: "old.gcode", stateText: "complete" });
  const { store, lifecycle } = harness({ tracked: false, live: () => live });
  // The operator confirms the plate clear while the device reports old.gcode as done.
  lifecycle.clearBed("k2", { confirmation: "part_removed", actor: "miha" });
  assert.equal(latest(store)?.metadata.deviceLastJob, "old.gcode");
  // Restart: the device still reports the same finished job.
  live = status({ currentFile: "old.gcode", stateText: "complete" });
  lifecycle.observe("k2", undefined, live);
  assert.equal(latest(store)?.state, "CLEAR", "an accounted-for job is not an external print");
});

test("a plain idle with a leftover file name (no named ending) is not read as a print", () => {
  const { store, lifecycle } = harness();
  lifecycle.observe("k2", undefined, status({ currentFile: "x.gcode", stateText: "0" }));
  assert.equal(latest(store)?.state, "CLEAR");
  assert.equal(finishedJobFile(status({ currentFile: "x.gcode", stateText: "standby" })), null);
  assert.equal(finishedJobFile(status({ currentFile: "x.gcode", stateText: "cancelled" })), "x.gcode");
});

test("the plate cannot be confirmed clear while the printer is visibly printing on it", () => {
  const { lifecycle } = harness({ live: () => status({ status: "printing", currentFile: "x.gcode" }) });
  assert.throws(
    () => lifecycle.clearBed("k2", { confirmation: "part_removed" }),
    (e: unknown) => e instanceof JobError && /сейчас печатает/.test(e.message)
  );
});

test("a repeated «стол свободен» on an already-clear plate is not a second clearance", () => {
  const { store, lifecycle } = harness();
  const before = store.repositories.bedCycles.listByPrinter("k2").length;
  const again = lifecycle.clearBed("k2", { confirmation: "part_removed" });
  assert.equal(again.state, "CLEAR");
  assert.equal(store.repositories.bedCycles.listByPrinter("k2").length, before);
});

// ── The dispatch backstop ─────────────────────────────────────────────────────

function dispatchFor(store: PrintQueueStore, live: PrinterLiveStatus, calls: string[]): DispatchService {
  const deps: DispatchDeps = {
    store,
    resolvePrinter: () => K2,
    getStatus: () => live,
    startPhysical: async (_id, file) => {
      calls.push(file);
      return { confirmed: true };
    },
    classifyError: () => "unknown",
    listFiles: async () => ({
      path: "",
      entries: [{ name: "a.gcode", path: "a.gcode", type: "file", size: 5, printable: true }]
    }),
    // Permissive on purpose: these tests are about the reserve-time backstop
    // that holds even if a caller is ever wired with a laxer evaluator.
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
  return new DispatchService(deps);
}

test("dispatch refuses a printer whose plate was never confirmed, whatever the evaluator said", async () => {
  const store = openPrintQueueStore(":memory:");
  const taskId = new PrintQueueService(store).createTask({ title: "A", printer: "k2", file: "a.gcode" }).task.id;
  const calls: string[] = [];
  await assert.rejects(
    dispatchFor(store, status(), calls).dispatch({ taskId, mode: "manual" }),
    /ни разу не подтверждён свободным/
  );
  assert.deepEqual(calls, [], "nothing reached the printer");
  assert.equal(store.repositories.printRuns.listByTask(taskId).length, 0, "nothing was reserved");
});

test("dispatch refuses a printer that is visibly printing, even on a CLEAR record", async () => {
  const store = openPrintQueueStore(":memory:");
  establishClearBed(store, "k2");
  const taskId = new PrintQueueService(store).createTask({ title: "A", printer: "k2", file: "a.gcode" }).task.id;
  const calls: string[] = [];
  await assert.rejects(
    dispatchFor(store, status({ status: "printing", currentFile: "other.gcode" }), calls).dispatch({
      taskId,
      mode: "manual"
    }),
    /сейчас печатает/
  );
  assert.deepEqual(calls, []);
});
