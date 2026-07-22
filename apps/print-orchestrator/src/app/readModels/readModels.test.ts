import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrinterView } from "../../domain/printers/types";
import type { PrintRun } from "../../domain/print/types";
import type { PrinterConfig } from "../../infra/printers/config";
import { openPrintQueueStore } from "../../infra/db/store";
import { PrintQueueService } from "../printQueue/printQueueService";
import { buildNightGateInfo } from "./buildNightGateInfo";
import { buildSchedulerPrinters } from "./buildSchedulerPrinters";
import { buildSlicerPrinters } from "./buildSlicerPrinters";

/*
 * The read-model builders extracted out of FarmStore. They are pure (explicit
 * arguments, no repositories created, no background work, no mutation) and must
 * keep producing the exact DTOs the scheduler / slicing / dashboard consume.
 */

function config(overrides: Partial<PrinterConfig>): PrinterConfig {
  return {
    id: "k2",
    name: "Creality K2",
    enabled: true,
    protocol: "moonraker",
    model: "K2",
    material: "PLA",
    nozzleDiameterMm: 0.4,
    printerClass: "fdm-large",
    ...overrides
  } as PrinterConfig;
}

test("buildSlicerPrinters projects every config into the slicer ref shape", () => {
  const refs = buildSlicerPrinters([
    config({ id: "a", name: "A" }),
    config({ id: "b", name: "B", model: null as never, material: null as never, nozzleDiameterMm: undefined })
  ]);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], {
    id: "a",
    name: "A",
    model: "K2",
    material: "PLA",
    protocol: "moonraker",
    nozzleMm: 0.4,
    printerClass: "fdm-large"
  });
  // Missing optionals collapse to null (never undefined) — the slicer ref contract.
  assert.equal(refs[1].nozzleMm, null);
});

test("buildSchedulerPrinters joins live views + config + active run into the scheduler ref", () => {
  const view = {
    id: "k2",
    name: "Creality K2",
    model: "K2",
    status: "printing",
    online: true,
    updatedAt: new Date(1_000).toISOString(),
    minutesLeft: 30,
    liveMaterial: "PETG",
    material: "PLA",
    nozzleDiameter: 0.4,
    remoteStartSupported: true
  } as unknown as PrinterView;

  const refs = buildSchedulerPrinters({
    printers: [view],
    configs: [config({ buildVolume: { x: 300, y: 300, z: 300 } as never })],
    activeRun: (id) => (id === "k2" ? ({ id: "run-1", state: "RUNNING" } as PrintRun) : null),
    now: () => 61_000
  });

  assert.equal(refs.length, 1);
  const ref = refs[0];
  assert.equal(ref.id, "k2");
  assert.equal(ref.protocol, "moonraker", "protocol comes from the config, not the view");
  assert.equal(ref.material, "PETG", "live material wins over the configured material");
  assert.equal(ref.printingTimeLeftMs, 30 * 60_000, "remaining print time while printing");
  assert.equal(ref.telemetryAgeMs, 60_000, "age = now − updatedAt");
  assert.equal(ref.activeRunState, "RUNNING", "the canonical run state decorates the ref");
  assert.equal(ref.materialRemainingSufficient, null);
  assert.equal(ref.ams, null);
});

test("buildSchedulerPrinters leaves remaining time null when the printer is idle", () => {
  const view = {
    id: "k2",
    name: "K2",
    model: "K2",
    status: "idle",
    online: true,
    updatedAt: null,
    minutesLeft: null,
    liveMaterial: null,
    material: "PLA",
    nozzleDiameter: 0.4,
    remoteStartSupported: true
  } as unknown as PrinterView;

  const [ref] = buildSchedulerPrinters({
    printers: [view],
    configs: [config({})],
    activeRun: () => null
  });
  assert.equal(ref.printingTimeLeftMs, null);
  assert.equal(ref.telemetryAgeMs, null, "no updatedAt → no telemetry age");
  assert.equal(ref.activeRunState, null);
});

test("buildNightGateInfo returns null before the queue store is open", () => {
  assert.equal(buildNightGateInfo({
    store: null,
    resolvePrinter: () => undefined,
    getStatus: () => undefined,
    nightWindow: "21:30 – 07:30",
    nightSafetyBufferRatio: 0.15
  }, "any"), null);
});

test("buildNightGateInfo reports the immutable identity + a hard blocker for an unassigned printer", () => {
  const store = openPrintQueueStore(":memory:");
  const service = new PrintQueueService(store, { isPrinterConfigured: () => true });
  const detail = service.createTask({ title: "Night part", night: true });

  const decision = buildNightGateInfo(
    {
      store,
      // No printer resolves → the gate must itself surface the missing-printer blocker.
      resolvePrinter: () => undefined,
      getStatus: () => undefined,
      nightWindow: "21:30 – 07:30",
      nightSafetyBufferRatio: 0.15
    },
    detail.task.id
  );

  assert.ok(decision, "a decision is produced for a known task");
  assert.equal(decision?.taskId, detail.task.id);
  assert.equal(decision?.taskVersion, detail.task.version);
  assert.equal(decision?.artifactSha256, null);
  assert.ok(
    decision?.blockers.some((b) => /принтер не назначен|не найден/.test(b)),
    "a missing printer is a hard blocker"
  );
  store.close();
});
