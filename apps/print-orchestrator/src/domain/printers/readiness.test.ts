import assert from "node:assert/strict";
import { test } from "node:test";

import { describePrinterReadiness, type PrinterReadinessInput } from "./readiness";

/*
 * «Свободен» is not something a printer's `idle` can say on its own: the plate,
 * an unconfirmed start and owed operations all decide whether it can take a job.
 */

const base: PrinterReadinessInput = {
  setupRequired: false,
  online: true,
  status: "idle",
  error: null,
  bedState: "CLEAR",
  bedExternal: false,
  activeRun: null,
  blockingOperations: [],
  telemetryAgeMs: 2_000,
  telemetryStaleMs: 120_000
};

test("only an idle printer on a confirmed-clear plate, with fresh telemetry, is ready", () => {
  const r = describePrinterReadiness(base);
  assert.equal(r.state, "ready");
  assert.equal(r.canAcceptJob, true);
});

test("idle with a finished part on the plate is NOT «свободен»", () => {
  const r = describePrinterReadiness({ ...base, bedState: "AWAITING_CLEARANCE" });
  assert.equal(r.state, "needs_clearance");
  assert.equal(r.label, "Ждёт снятия детали");
  assert.equal(r.canAcceptJob, false);
});

test("idle with an unconfirmed plate asks for a confirmation", () => {
  const r = describePrinterReadiness({ ...base, bedState: "UNKNOWN" });
  assert.equal(r.state, "bed_unknown");
  assert.equal(r.canAcceptJob, false);
});

test("an accepted-but-unobserved start reads as starting, not as idle or printing", () => {
  const r = describePrinterReadiness({
    ...base,
    bedState: "RESERVED",
    activeRun: { state: "PENDING", startedAt: null, dispatchPhase: "accepted", cancelRequested: false }
  });
  assert.equal(r.state, "starting");
  assert.equal(r.label, "Запуск принят");
});

test("an UNKNOWN start outcome holds the printer and says what to do", () => {
  const r = describePrinterReadiness({
    ...base,
    bedState: "RESERVED",
    activeRun: { state: "UNKNOWN", startedAt: null, dispatchPhase: "accepted", cancelRequested: false }
  });
  assert.equal(r.state, "held");
  assert.match(r.detail ?? "", /отметьте, что произошло/);
});

test("an owed operation, stale telemetry, offline and setup each say so first", () => {
  assert.equal(describePrinterReadiness({ ...base, blockingOperations: ["замена сопла"] }).state, "maintenance");
  assert.equal(describePrinterReadiness({ ...base, telemetryAgeMs: 600_000 }).state, "stale");
  assert.equal(describePrinterReadiness({ ...base, online: false }).state, "offline");
  assert.equal(describePrinterReadiness({ ...base, setupRequired: true }).state, "setup");
});

test("a print started outside Albedo is printing — and named as such", () => {
  const r = describePrinterReadiness({ ...base, status: "printing", bedState: "RUNNING", bedExternal: true });
  assert.equal(r.state, "printing");
  assert.match(r.detail ?? "", /не через Albedo/);
});

test("a monitoring-only printer is never «Готов к печати», even idle on a clear plate", () => {
  const r = describePrinterReadiness({ ...base, jobsSupported: false });
  assert.equal(r.state, "monitoring");
  assert.equal(r.label, "Только наблюдение");
  assert.equal(r.canAcceptJob, false);
  // What it is doing still reads as itself.
  assert.equal(describePrinterReadiness({ ...base, jobsSupported: false, status: "printing" }).state, "printing");
  assert.equal(describePrinterReadiness({ ...base, jobsSupported: false, online: false }).state, "offline");
  assert.equal(describePrinterReadiness({ ...base, jobsSupported: true }).state, "ready");
});
