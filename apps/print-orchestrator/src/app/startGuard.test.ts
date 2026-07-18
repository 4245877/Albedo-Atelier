import assert from "node:assert/strict";
import { test } from "node:test";

import { PrinterCommandError, type PrinterLiveStatus } from "../infra/printers/status";
import type { StartGuard } from "../domain/print/types";
import { classifyDispatchError, reconcileStartGuard } from "./startGuard";

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
    activeFilament: null,
    nozzleTemp: null,
    nozzleTarget: null,
    bedTemp: null,
    bedTarget: null,
    chamberTemp: null,
    light: null,
    stateText: null,
    stateMessage: null,
    error: null,
    updatedAt: new Date().toISOString(),
    ...over
  };
}

function guard(over: Partial<StartGuard> = {}): StartGuard {
  return {
    printerId: "k2",
    file: "model.gcode",
    state: "UNKNOWN",
    jobRef: "q1",
    runId: null,
    requestedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over
  };
}

// ── classifyDispatchError ────────────────────────────────────────────────────

test("a lost/timed-out response is classified 'unknown' (the print may be running)", () => {
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  assert.equal(classifyDispatchError(timeout), "unknown");
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.equal(classifyDispatchError(aborted), "unknown");
});

test("a definitive device rejection (file 404) is 'rejected' — a retry is safe", () => {
  assert.equal(classifyDispatchError(new PrinterCommandError("нет файла", true)), "rejected");
});

test("an ambiguous device error (HTTP 5xx) is 'unknown', not 'rejected'", () => {
  assert.equal(classifyDispatchError(new PrinterCommandError("Moonraker HTTP 500")), "unknown");
});

test("a pre-connection network error (refused/DNS) never reached the device → 'rejected'", () => {
  assert.equal(classifyDispatchError({ cause: { code: "ECONNREFUSED" } }), "rejected");
  assert.equal(classifyDispatchError(Object.assign(new Error("dns"), { code: "ENOTFOUND" })), "rejected");
});

test("an unclassifiable error is treated 'unknown' (fail-closed)", () => {
  assert.equal(classifyDispatchError(new Error("weird")), "unknown");
  assert.equal(classifyDispatchError({ cause: { code: "ECONNRESET" } }), "unknown");
});

// ── reconcileStartGuard ──────────────────────────────────────────────────────

test("printing the guarded file → already-running (do not re-dispatch)", () => {
  const decision = reconcileStartGuard(
    guard({ file: "model.gcode" }),
    status({ status: "printing", currentFile: "model.gcode" }),
    "model.gcode"
  );
  assert.equal(decision, "already-running");
});

test("printing the guarded file reported as a path still matches by basename", () => {
  const decision = reconcileStartGuard(
    guard({ file: "model.gcode" }),
    status({ status: "printing", currentFile: "gcodes/model.gcode" }),
    "model.gcode"
  );
  assert.equal(decision, "already-running");
});

test("printing a DIFFERENT file → busy-other (our start never ran, printer busy)", () => {
  const decision = reconcileStartGuard(
    guard({ file: "model.gcode" }),
    status({ status: "printing", currentFile: "other.gcode" }),
    "model.gcode"
  );
  assert.equal(decision, "busy-other");
});

test("idle after an UNKNOWN start → held (fail-closed, never auto re-dispatch)", () => {
  assert.equal(reconcileStartGuard(guard({ state: "UNKNOWN" }), status({ status: "idle" }), "model.gcode"), "held");
});

test("idle after an ACKED start → still held (may already have printed and finished)", () => {
  assert.equal(reconcileStartGuard(guard({ state: "ACKED" }), status({ status: "idle" }), "model.gcode"), "held");
});

test("offline / errored / unknown device → held (cannot verify)", () => {
  for (const s of ["offline", "error", "unknown"] as const) {
    assert.equal(reconcileStartGuard(guard(), status({ status: s, online: s !== "offline" }), "model.gcode"), "held");
  }
});
