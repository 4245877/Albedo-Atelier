import assert from "node:assert/strict";
import { test } from "node:test";

import { JobError, NotFoundError } from "../../core/errors";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { PrinterConfig } from "../../infra/printers/config";
import type { PrinterLiveStatus } from "../../infra/printers/status";
import { openPrintQueueStore } from "../../infra/db/store";
import { PrintQueueService } from "../printQueue/printQueueService";
import { SchedulerContext } from "../scheduling/context";
import { EligibilityQueries } from "../scheduling/eligibility";
import { EvidenceResolver } from "../scheduling/evidence";
import type { SchedulerPrinterRef } from "../scheduling/types";
import { DispatchService, type DispatchDeps } from "./dispatchService";
import { RunLifecycleService } from "./runLifecycle";
import { seedDeviceFile } from "./testkit/deviceFiles";

/*
 * The night-safety half of the brief, end to end over a real (in-memory) SQLite
 * store with a fake device: the bed lifecycle CLEAR → RESERVED → RUNNING →
 * AWAITING_CLEARANCE, and everything that is NOT allowed to clear it.
 *
 * No real printer and no network: `startPhysical` is a spy and the file listing
 * is a fixture.
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

interface Harness {
  store: PrintQueueStore;
  queue: PrintQueueService;
  dispatch: DispatchService;
  lifecycle: RunLifecycleService;
  startCalls: string[];
  knobs: { status: PrinterLiveStatus["status"]; online: boolean; autoContinuation: boolean };
}

function makeHarness(): Harness {
  const store = openPrintQueueStore(":memory:");
  const queue = new PrintQueueService(store);
  const startCalls: string[] = [];
  const knobs: Harness["knobs"] = { status: "idle", online: true, autoContinuation: false };

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
    telemetryAgeMs: 1_000,
    materialRemainingSufficient: null,
    printingTimeLeftMs: null,
    activeRunState: null
  });

  const eligibility = (): EligibilityQueries => {
    const ctx = new SchedulerContext(store, () => [printerRef()], {
      now: () => new Date("2026-07-26T23:00:00Z"),
      runtimeAvailable: true,
      nightSafetyBufferRatio: 0.2,
      nightWindow: "21:30 – 07:30",
      farmTimeZone: "UTC",
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
      eligibility().evaluate({
        ...input,
        automaticContinuationAllowed: knobs.autoContinuation
      })
  };

  return {
    store,
    queue,
    dispatch: new DispatchService(deps),
    lifecycle: new RunLifecycleService(store),
    startCalls,
    knobs
  };
}

/**
 * A queued task whose file is already prepared on the device — the delivery step
 * every start now requires, so these bed-clearance tests keep testing the bed.
 */
function addTask(h: Harness, file: string): string {
  const detail = h.queue.createTask({ title: file, printer: "k2", material: "PLA", file });
  seedDeviceFile(h.store, {
    printerId: "k2",
    remotePath: file,
    artifactId: detail.task.artifactId
  });
  return detail.task.id;
}

/** Runs one print to completion and returns the printer holding a finished part. */
async function printAndFinish(h: Harness): Promise<void> {
  const taskId = addTask(h, "a.gcode");
  const result = await h.dispatch.dispatch({ taskId, mode: "manual" });
  h.lifecycle.completeRun(result.runId, "SUCCEEDED");
}

const bedState = (h: Harness): string | null =>
  h.store.repositories.bedCycles.findOpenByPrinter("k2")?.state ?? null;

// ── The bed lifecycle ───────────────────────────────────────────────────────

test("CLEAR → RESERVED → RUNNING → AWAITING_CLEARANCE across a full print", async () => {
  const h = makeHarness();
  const taskId = addTask(h, "a.gcode");
  assert.equal(bedState(h), null, "no cycle before the first dispatch");

  const result = await h.dispatch.dispatch({ taskId, mode: "manual" });
  assert.equal(bedState(h), "RUNNING", "a dispatched, acked print holds the bed");

  h.lifecycle.completeRun(result.runId, "SUCCEEDED");
  assert.equal(bedState(h), "AWAITING_CLEARANCE", "a finished print leaves the part on the plate");
});

test("a FAILED and a CANCELLED print also leave the bed awaiting clearance", async () => {
  for (const outcome of ["FAILED", "CANCELLED"] as const) {
    const h = makeHarness();
    const taskId = addTask(h, "a.gcode");
    const result = await h.dispatch.dispatch({ taskId, mode: "manual" });
    h.lifecycle.completeRun(result.runId, outcome);
    assert.equal(bedState(h), "AWAITING_CLEARANCE", `${outcome} may still have left material`);
  }
});

// ── What must NOT clear a bed ───────────────────────────────────────────────

test("an idle printer report does not clear the bed", async () => {
  const h = makeHarness();
  await printAndFinish(h);
  // Many poll cycles of a perfectly idle, online printer.
  for (let i = 0; i < 5; i += 1) {
    h.lifecycle.observe(
      "k2",
      { online: true, status: "idle" } as PrinterLiveStatus,
      { online: true, status: "idle" } as PrinterLiveStatus
    );
  }
  assert.equal(bedState(h), "AWAITING_CLEARANCE", "idle telemetry is not a clearance event");
});

test("a manual (attended) start does not clear the bed and is refused", async () => {
  const h = makeHarness();
  await printAndFinish(h);
  const next = addTask(h, "b.gcode");

  await assert.rejects(h.dispatch.dispatch({ taskId: next, mode: "manual" }), JobError);
  assert.equal(bedState(h), "AWAITING_CLEARANCE");
  assert.equal(h.startCalls.length, 1, "only the first print ever reached the device");
});

test("unattendedAllowed does not clear the bed", async () => {
  const h = makeHarness();
  await printAndFinish(h);
  const taskId = addTask(h, "b.gcode");
  const task = h.store.repositories.tasks.getById(taskId)!;
  h.store.repositories.tasks.update({
    ...task,
    night: true,
    unattendedAllowed: true,
    updatedAt: new Date().toISOString()
  });

  await assert.rejects(h.dispatch.dispatch({ taskId, mode: "manual" }), JobError);
  assert.equal(bedState(h), "AWAITING_CLEARANCE", "a permission on the task is not a cleared plate");
});

test("a successful previous print does not license the next one", async () => {
  const h = makeHarness();
  await printAndFinish(h);
  const next = addTask(h, "b.gcode");
  const before = h.store.repositories.audit.list().length;

  await assert.rejects(h.dispatch.dispatch({ taskId: next, mode: "manual" }), JobError);
  assert.equal(bedState(h), "AWAITING_CLEARANCE");
  assert.ok(
    !h.store.repositories.audit
      .list()
      .slice(before)
      .some((e) => e.toState === "CLEAR"),
    "the refused start wrote no clearance"
  );
});

// ── What DOES clear a bed ───────────────────────────────────────────────────

test("an explicit operator clearance releases the printer, and is audited", async () => {
  const h = makeHarness();
  await printAndFinish(h);

  const cleared = h.lifecycle.clearBed("k2", {
    confirmation: "part_removed",
    actor: "operator-7",
    note: "снял вручную"
  });
  assert.equal(cleared.state, "CLEAR");
  assert.equal(cleared.metadata.clearance, "part_removed");
  assert.equal(cleared.metadata.clearedBy, "operator-7");
  assert.equal(bedState(h), null, "a cleared cycle is closed");

  const event = h.store.repositories.audit
    .list()
    .find((e) => e.entityType === "bed_cycle" && e.action === "cleared");
  assert.ok(event, "the clearance is in the audit trail");
  assert.equal(event?.actor, "operator-7");
  assert.equal(event?.toState, "CLEAR");
});

test("a plate swap is an equally valid clearance", async () => {
  const h = makeHarness();
  await printAndFinish(h);
  assert.equal(h.lifecycle.clearBed("k2", { confirmation: "plate_swapped" }).state, "CLEAR");
});

test("after a clearance the next job runs", async () => {
  const h = makeHarness();
  await printAndFinish(h);
  const next = addTask(h, "b.gcode");

  h.lifecycle.clearBed("k2", { confirmation: "part_removed" });
  const result = await h.dispatch.dispatch({ taskId: next, mode: "manual" });

  assert.equal(h.store.repositories.printRuns.getById(result.runId)?.state, "RUNNING");
  assert.equal(h.startCalls.length, 2);
  assert.equal(bedState(h), "RUNNING");
});

test("auto_cleared is refused unless the printer's capability is configured AND verified", async () => {
  const h = makeHarness();
  await printAndFinish(h);

  assert.throws(
    () => h.lifecycle.clearBed("k2", { confirmation: "auto_cleared" }),
    /нет подтверждённой автоматической очистки/
  );
  assert.equal(bedState(h), "AWAITING_CLEARANCE", "the refused claim changed nothing");

  const cleared = h.lifecycle.clearBed("k2", {
    confirmation: "auto_cleared",
    automaticContinuationAllowed: true
  });
  assert.equal(cleared.state, "CLEAR");
});

test("a bed under an active print cannot be 'cleared' out from under it", async () => {
  const h = makeHarness();
  const taskId = addTask(h, "a.gcode");
  await h.dispatch.dispatch({ taskId, mode: "manual" });

  assert.throws(() => h.lifecycle.clearBed("k2", { confirmation: "part_removed" }), /занят активной печатью/);
  assert.equal(bedState(h), "RUNNING");
});

test("clearing a printer with no tracked cycle establishes one — recorded, never a silent no-op", () => {
  const h = makeHarness();
  // This used to be a NotFoundError. That was defensible as a statement about
  // the data ("there is no cycle to clear") but wrong as a product rule: a
  // printer with no history reads as bed state UNKNOWN, the dispatch gate blocks
  // on UNKNOWN, and the only exit from UNKNOWN was a cycle that only a completed
  // print could create. A farm's first print could therefore never start, and
  // the operator had no button anywhere that would fix it.
  //
  // The confirmation now opens the history it was missing. What must NOT change
  // is that it stays *evidence*: an attributed, audited operator assertion.
  const cycle = h.lifecycle.clearBed("k2", { confirmation: "part_removed", actor: "miha" });

  assert.equal(cycle.state, "CLEAR");
  assert.equal(cycle.printerId, "k2");
  assert.equal(cycle.metadata.clearedBy, "miha", "the assertion is named");
  assert.equal(cycle.metadata.established, true, "distinguishable from a cleared print");

  const audit = h.store.repositories.audit.listByEntity("bed_cycle", cycle.id);
  assert.ok(
    audit.some((e) => e.action === "established"),
    "an assertion that leaves no audit trail is a silent no-op with extra steps"
  );
});

test("an unverified auto-clear cannot establish a cycle either", () => {
  const h = makeHarness();
  // The `auto_cleared` guard must hold on the no-history path too, or the new
  // branch becomes a way around it.
  assert.throws(
    () => h.lifecycle.clearBed("k2", { confirmation: "auto_cleared" }),
    /автоматической очистки/
  );
  assert.equal(h.store.repositories.bedCycles.listByPrinter("k2").length, 0, "nothing was written");
});

// ── The night scenario from the brief ───────────────────────────────────────

test("03:00 finish → idle until 08:00 → clearance → 08:05 start", async () => {
  const h = makeHarness();
  const first = addTask(h, "a.gcode");
  const run = await h.dispatch.dispatch({ taskId: first, mode: "manual" });

  // 03:00 — the print finishes.
  h.lifecycle.completeRun(run.runId, "SUCCEEDED");
  assert.equal(bedState(h), "AWAITING_CLEARANCE");

  // 03:00–08:00 — the printer sits idle and online. It is NOT available: the
  // scheduler must read this as forced downtime, not a free printer.
  const next = addTask(h, "b.gcode");
  for (let hour = 0; hour < 5; hour += 1) {
    h.lifecycle.observe(
      "k2",
      { online: true, status: "idle" } as PrinterLiveStatus,
      { online: true, status: "idle" } as PrinterLiveStatus
    );
    await assert.rejects(
      h.dispatch.dispatch({ taskId: next, mode: "manual" }),
      JobError,
      `hour ${hour}: the occupied bed still blocks`
    );
  }
  assert.equal(h.startCalls.length, 1, "nothing started during the five idle hours");

  // 08:00 — the operator arrives and removes the model.
  h.lifecycle.clearBed("k2", { confirmation: "part_removed", actor: "operator" });

  // 08:05 — the next job may finally start.
  const second = await h.dispatch.dispatch({ taskId: next, mode: "manual" });
  assert.equal(h.store.repositories.printRuns.getById(second.runId)?.state, "RUNNING");
  assert.equal(h.startCalls.length, 2);
});
