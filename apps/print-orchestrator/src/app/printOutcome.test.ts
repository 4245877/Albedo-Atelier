import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrinterLiveStatus } from "../infra/printers/status/types";
import { classifyPrintOutcome } from "./printOutcome";

/*
 * The one shared "how did the print end" classification (poller + run
 * lifecycle). The priority order is the contract: explicit cancel/error always
 * beats the progress-≥99 % heuristic.
 */

function status(over: Partial<PrinterLiveStatus>): PrinterLiveStatus {
  return {
    id: "p",
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
    ...over,
  };
}

test("offline is disconnected regardless of anything else", () => {
  assert.equal(
    classifyPrintOutcome(status({ online: false, status: "offline", progressPct: 100 })),
    "disconnected"
  );
});

test("an explicit device error is failed", () => {
  assert.equal(
    classifyPrintOutcome(status({ status: "error", error: "nozzle jam", progressPct: 100 })),
    "failed"
  );
});

test("explicit cancellation wins over progressPct >= 99", () => {
  assert.equal(
    classifyPrintOutcome(status({ stateText: "cancelled", progressPct: 100 })),
    "cancelled"
  );
  assert.equal(classifyPrintOutcome(status({ stateText: "ABORTED", progressPct: 99 })), "cancelled");
});

test("an explicit completion state is completed", () => {
  assert.equal(classifyPrintOutcome(status({ stateText: "complete" })), "completed");
  assert.equal(classifyPrintOutcome(status({ stateText: "FINISH" })), "completed");
});

test("progress >= 99 is only the fallback heuristic", () => {
  assert.equal(classifyPrintOutcome(status({ progressPct: 99 })), "completed");
  assert.equal(classifyPrintOutcome(status({ progressPct: 100 })), "completed");
  assert.equal(classifyPrintOutcome(status({ progressPct: 98 })), "unknown");
});

test("no signal at all is unknown, never guessed", () => {
  assert.equal(classifyPrintOutcome(status({})), "unknown");
  assert.equal(classifyPrintOutcome(status({ stateText: "standby" })), "unknown");
});
