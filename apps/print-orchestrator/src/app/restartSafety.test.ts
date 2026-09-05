import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrinterLiveStatus } from "../infra/printers/status/types";
import {
  assessPrinterRestart,
  assessRestartSafety,
  DEFAULT_RESTART_WINDOW_SECONDS,
  type CanonicalRunFacts,
  type RestartSafetyInput
} from "./restartSafety";

/*
 * The rules a redeploy asks about: "may the orchestrator be recreated right now
 * without losing print accounting?"
 *
 * The old deploy gate asked "is any printer busy?" and blocked on any answer
 * above zero. These tests pin the finer question down — a print dispatched
 * through the queue is fully re-adopted from SQLite on restart
 * (PrinterPoller.hydrateRunFromCanonical), while an untracked print, a lost
 * identity, a missing AMS baseline and a completion landing inside the restart
 * window are not, and must stay blocked.
 */

const NOW = new Date("2026-09-05T12:00:00.000Z");
const now = () => NOW;

function status(over: Partial<PrinterLiveStatus> = {}): PrinterLiveStatus {
  return {
    id: "a1",
    online: true,
    status: "printing",
    currentFile: "vase.gcode.3mf",
    progressPct: 40,
    remainingMinutes: 90,
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
    updatedAt: NOW.toISOString(),
    ...over
  } as PrinterLiveStatus;
}

function run(over: Partial<CanonicalRunFacts> = {}): CanonicalRunFacts {
  return {
    id: "run_1",
    state: "RUNNING",
    file: "vase.gcode.3mf",
    startedAt: "2026-09-05T11:00:00.000Z",
    hasAmsBaseline: true,
    ...over
  };
}

function input(over: Partial<RestartSafetyInput> = {}): RestartSafetyInput {
  return { id: "a1", name: "A1", protocol: "bambu", status: status(), run: run(), ...over };
}

const assess = (over: Partial<RestartSafetyInput> = {}, windowSeconds?: number) =>
  assessPrinterRestart(input(over), { now, restartWindowSeconds: windowSeconds });

test("an idle printer is never a reason to hold a deploy", () => {
  const verdict = assess({ status: status({ status: "idle", currentFile: null }), run: null });
  assert.equal(verdict.verdict, "idle");
  assert.deepEqual(verdict.risks, []);
  assert.equal(verdict.busy, false);
});

test("a queue-dispatched print with a durable canonical run is recoverable", () => {
  const verdict = assess();
  assert.equal(verdict.verdict, "recoverable");
  assert.deepEqual(verdict.risks, []);
  assert.equal(verdict.runId, "run_1");
  assert.equal(verdict.remainingMinutes, 90);
  assert.equal(verdict.remainingEstimated, false);
});

test("a paused print is held and assessed exactly like a running one", () => {
  const verdict = assess({ status: status({ status: "paused" }) });
  assert.equal(verdict.busy, true);
  assert.equal(verdict.verdict, "recoverable");
});

test("an external print with no canonical run is at risk (nothing to re-adopt)", () => {
  const verdict = assess({ run: null });
  assert.equal(verdict.verdict, "at-risk");
  assert.deepEqual(verdict.risks, ["untracked-print"]);
});

test("a closed run store is unknowable, not empty — it fails closed", () => {
  const verdict = assess({ run: undefined });
  assert.equal(verdict.verdict, "at-risk");
  assert.ok(verdict.risks.includes("runs-unavailable"));
});

test("a run the device does not confirm (different file) is at risk", () => {
  const verdict = assess({ status: status({ currentFile: "other-part.gcode.3mf" }) });
  assert.equal(verdict.verdict, "at-risk");
  assert.deepEqual(verdict.risks, ["identity-mismatch"]);
});

test("the file comparison uses the shared job identity rule, not string equality", () => {
  // A Bambu reports `subtask_name` without the container extension; that is the
  // same job, and treating it as a mismatch would block every Bambu deploy.
  const verdict = assess({ status: status({ currentFile: "vase" }) });
  assert.equal(verdict.verdict, "recoverable");
});

test("a run that has not attached yet (PENDING) cannot be adopted", () => {
  const verdict = assess({ run: run({ state: "PENDING" }) });
  assert.equal(verdict.verdict, "at-risk");
  assert.ok(verdict.risks.includes("run-not-attached"));
});

test("a run with no start time loses the duration metric", () => {
  const verdict = assess({ run: run({ startedAt: null }) });
  assert.equal(verdict.verdict, "at-risk");
  assert.ok(verdict.risks.includes("no-start-time"));
});

test("a Bambu run with no persisted AMS baseline under-deducts after a restart", () => {
  const verdict = assess({ run: run({ hasAmsBaseline: false }) });
  assert.equal(verdict.verdict, "at-risk");
  assert.deepEqual(verdict.risks, ["no-ams-baseline"]);
});

test("a non-Bambu run needs no AMS baseline", () => {
  const verdict = assess({ protocol: "moonraker", run: run({ hasAmsBaseline: false }) });
  assert.equal(verdict.verdict, "recoverable");
});

test("a print finishing inside the restart window is at risk", () => {
  // The completion would be observed by neither process, so runLifecycle parks
  // the run in UNKNOWN for an operator — exactly what the gate exists to avoid.
  const verdict = assess({ status: status({ remainingMinutes: 2 }) });
  assert.equal(verdict.verdict, "at-risk");
  assert.deepEqual(verdict.risks, ["finishing-soon"]);
});

test("the restart window is a parameter, not a constant", () => {
  assert.equal(assess({ status: status({ remainingMinutes: 20 }) }).verdict, "recoverable");
  assert.equal(assess({ status: status({ remainingMinutes: 20 }) }, 3600).verdict, "at-risk");
  assert.equal(DEFAULT_RESTART_WINDOW_SECONDS, 180);
});

test("remaining time is estimated from progress and elapsed time when the device gives no ETA", () => {
  // Started an hour ago, 40 % done -> ~90 minutes left. Recoverable.
  const verdict = assess({ status: status({ remainingMinutes: null }) });
  assert.equal(verdict.verdict, "recoverable");
  assert.equal(verdict.remainingEstimated, true);
  assert.ok(verdict.remainingMinutes !== null && verdict.remainingMinutes > 89);
});

test("the estimate catches a print that is nearly done without an ETA", () => {
  // Started an hour ago, 99.9 % done -> well under the window.
  const verdict = assess({ status: status({ remainingMinutes: null, progressPct: 99.9 }) });
  assert.equal(verdict.verdict, "at-risk");
  assert.deepEqual(verdict.risks, ["finishing-soon"]);
});

test("no ETA and no usable progress cannot rule out a completion — fail closed", () => {
  const verdict = assess({ status: status({ remainingMinutes: null, progressPct: null }) });
  assert.equal(verdict.verdict, "at-risk");
  assert.deepEqual(verdict.risks, ["progress-unknown"]);
});

test("an offline printer holding an active run is judged on durability alone", () => {
  // A completion cannot be observed on an offline printer with or WITHOUT a
  // restart, so the window check would be noise; what still matters is whether
  // the run can be re-adopted when it comes back.
  const offline = status({ online: false, status: "offline", currentFile: null, remainingMinutes: null });
  assert.equal(assess({ status: offline }).verdict, "recoverable");
  assert.equal(assess({ status: offline, run: run({ hasAmsBaseline: false }) }).verdict, "at-risk");
});

test("an offline printer with no active run is idle", () => {
  const offline = status({ online: false, status: "offline", currentFile: null });
  assert.equal(assess({ status: offline, run: null }).verdict, "idle");
});

test("a printer that has never been polled is not treated as busy", () => {
  assert.equal(assess({ status: undefined, run: null }).verdict, "idle");
});

test("the farm verdict is safe only when every active print is recoverable", () => {
  const safe = assessRestartSafety(
    [input(), input({ id: "k2", name: "K2", protocol: "moonraker" })],
    { now }
  );
  assert.equal(safe.activePrints, 2);
  assert.equal(safe.recoverable, 2);
  assert.equal(safe.atRisk, 0);
  assert.equal(safe.safeToRestart, true);

  const mixed = assessRestartSafety([input(), input({ id: "k2", name: "K2", run: null })], { now });
  assert.equal(mixed.activePrints, 2);
  assert.equal(mixed.recoverable, 1);
  assert.equal(mixed.atRisk, 1);
  assert.equal(mixed.safeToRestart, false);
});

test("an entirely idle farm is safe to restart", () => {
  const idle = assessRestartSafety(
    [input({ status: status({ status: "idle", currentFile: null }), run: null })],
    { now }
  );
  assert.equal(idle.activePrints, 0);
  assert.equal(idle.safeToRestart, true);
});

test("a farm with no printers at all is safe to restart", () => {
  const empty = assessRestartSafety([], { now });
  assert.equal(empty.safeToRestart, true);
  assert.deepEqual(empty.printers, []);
});
