import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrinterLiveStatus } from "../infra/printers/status/types";
import { classifyPrintOutcome, describeAmbiguousEnding } from "./printOutcome";

/*
 * The one shared "how did the print end" classification (poller + filament
 * consumption + run lifecycle).
 *
 * The contract, in priority order: offline says nothing, an error is a failure,
 * an explicit cancel beats an explicit completion, and **nothing else is
 * success**. Progress used to be a fallback that returned `completed` at ≥ 99 %,
 * which meant a print stopped at 99.5 % was recorded as SUCCEEDED — terminal,
 * with the task completed, the assignment released, filament deducted and a bed
 * clearance opened for a part that was never finished.
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
    ...over,
  };
}

/** Every ending, and the one verdict each may produce. */
const ENDINGS: {
  name: string;
  status: Partial<PrinterLiveStatus>;
  outcome: string;
  evidence: string;
}[] = [
  // ── Offline: the device is not making a statement at all ──────────────────
  { name: "offline at 100 %", status: { online: false, status: "offline", progressPct: 100 }, outcome: "disconnected", evidence: "offline" },
  { name: "offline mid-print", status: { online: false, status: "offline", progressPct: 42 }, outcome: "disconnected", evidence: "offline" },
  { name: "offline having said «complete»", status: { online: false, status: "offline", stateText: "complete" }, outcome: "disconnected", evidence: "offline" },

  // ── The device names an error ─────────────────────────────────────────────
  { name: "error at 100 %", status: { status: "error", error: "nozzle jam", progressPct: 100 }, outcome: "failed", evidence: "device_error" },
  { name: "error having said «FINISH»", status: { status: "error", stateText: "FINISH" }, outcome: "failed", evidence: "device_error" },

  // ── The device names a cancellation ───────────────────────────────────────
  { name: "cancelled at 100 %", status: { stateText: "cancelled", progressPct: 100 }, outcome: "cancelled", evidence: "device_state" },
  { name: "aborted at 99 %", status: { stateText: "ABORTED", progressPct: 99 }, outcome: "cancelled", evidence: "device_state" },
  { name: "stopped at 99.5 %", status: { stateText: "stopped by user", progressPct: 99.5 }, outcome: "cancelled", evidence: "device_state" },
  { name: "cancel beats a completion word in the same text", status: { stateText: "cancelled before finish" }, outcome: "cancelled", evidence: "device_state" },

  // ── The device names a completion ─────────────────────────────────────────
  { name: "Moonraker «complete»", status: { stateText: "complete", progressPct: 100 }, outcome: "completed", evidence: "device_state" },
  { name: "Bambu «FINISH»", status: { stateText: "FINISH", progressPct: 100 }, outcome: "completed", evidence: "device_state" },
  { name: "«done»", status: { stateText: "done" }, outcome: "completed", evidence: "device_state" },
  // The device's word is what counts, even when progress disagrees: a print can
  // report FINISH with a stale percentage.
  { name: "«FINISH» at 97 %", status: { stateText: "FINISH", progressPct: 97 }, outcome: "completed", evidence: "device_state" },

  // ── The device names nothing: never success ───────────────────────────────
  { name: "98 %, no state text", status: { progressPct: 98 }, outcome: "unknown", evidence: "none" },
  { name: "99 %, no state text", status: { progressPct: 99 }, outcome: "unknown", evidence: "none" },
  { name: "99.5 %, no state text", status: { progressPct: 99.5 }, outcome: "unknown", evidence: "none" },
  { name: "100 %, no state text", status: { progressPct: 100 }, outcome: "unknown", evidence: "none" },
  { name: "nothing at all", status: {}, outcome: "unknown", evidence: "none" },
  { name: "Klipper «standby» (the file was reset)", status: { stateText: "standby", progressPct: 100 }, outcome: "unknown", evidence: "none" },
  { name: "Bambu «IDLE»", status: { stateText: "IDLE", progressPct: 99.9 }, outcome: "unknown", evidence: "none" }
];

test("print ending matrix: only a device's own terminal state may say «success»", () => {
  for (const ending of ENDINGS) {
    const verdict = classifyPrintOutcome(status(ending.status));
    assert.equal(verdict.outcome, ending.outcome, `${ending.name}: outcome`);
    assert.equal(verdict.evidence, ending.evidence, `${ending.name}: evidence`);
  }
});

test("no amount of progress alone produces a completion", () => {
  for (let pct = 90; pct <= 100; pct += 0.5) {
    const verdict = classifyPrintOutcome(status({ progressPct: pct }));
    assert.equal(verdict.outcome, "unknown", `${pct} % with no terminal state is not a success`);
  }
});

test("the verdict carries the progress it refuses to act on", () => {
  const verdict = classifyPrintOutcome(status({ progressPct: 99.5, stateText: "IDLE" }));
  assert.equal(verdict.progressPct, 99.5);
  assert.equal(verdict.stateText, "IDLE");
  const sentence = describeAmbiguousEnding(verdict);
  assert.match(sentence, /99\.5 %/, "the operator must be told how far it got");
  assert.match(sentence, /IDLE/, "and what the printer actually said");
});

test("an ambiguous ending with no numbers at all still reads as a sentence", () => {
  const sentence = describeAmbiguousEnding(classifyPrintOutcome(status({})));
  assert.match(sentence, /прогресс неизвестен/);
  assert.match(sentence, /ничего не сообщил/);
});
