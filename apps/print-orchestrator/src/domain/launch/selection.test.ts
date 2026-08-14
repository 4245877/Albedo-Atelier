import assert from "node:assert/strict";
import { test } from "node:test";

import {
  materialMatches,
  selectLaunchPrinter,
  type LaunchCandidateInput
} from "./selection";

/*
 * Auto-selection replaces "the first printer that is online". These tests pin
 * the two properties that make the result usable: a blocked printer can never be
 * chosen no matter how good it looks on every other axis, and the choice among
 * *startable* printers is the explainable one.
 */

function candidate(over: Partial<LaunchCandidateInput> = {}): LaunchCandidateInput {
  return {
    printerId: "p1",
    printerName: "Printer One",
    verdict: "compatible",
    blockers: [],
    reviews: [],
    warnings: [],
    online: true,
    status: "idle",
    loadedMaterial: "PETG",
    requiredMaterial: "PETG",
    printerNozzleMm: 0.4,
    requiredNozzleMm: 0.4,
    deviceFile: "verified",
    queueLength: 0,
    pendingManualOperations: 0,
    remoteStartSupported: true,
    ...over
  };
}

// ── Material comparison ─────────────────────────────────────────────────────

test("material families compare case- and suffix-insensitively, unknown never matches", () => {
  assert.equal(materialMatches("PETG", "petg"), true);
  assert.equal(materialMatches("PETG", "PETG HF"), true);
  assert.equal(materialMatches("PLA", "PLA-CF"), true);
  assert.equal(materialMatches("PETG", "PLA"), false);
  // An unknown on either side is not a match — the safe direction.
  assert.equal(materialMatches("PETG", null), false);
  assert.equal(materialMatches(null, "PETG"), false);
  assert.equal(materialMatches(null, null), false);
});

// ── Admission ───────────────────────────────────────────────────────────────

test("a blocked printer is never recommended, however attractive otherwise", () => {
  const result = selectLaunchPrinter([
    candidate({
      printerId: "blocked",
      // Everything a score would love…
      blockers: [{ code: "gcode_flavor_mismatch", message: "файл собран для другого принтера" }]
    })
  ]);
  assert.equal(result.recommendedPrinterId, null, "a blocker is not a low score");
  assert.equal(result.candidates[0].eligible, false);
  assert.equal(result.candidates[0].score, 0, "ineligible candidates are not scored at all");
});

test("a printer that cannot be started remotely is not the automatic choice", () => {
  const result = selectLaunchPrinter([
    candidate({ printerId: "manual-only", remoteStartSupported: false })
  ]);
  // Still listed and still eligible for a *manual* launch at the machine…
  assert.equal(result.candidates[0].eligible, true);
  // …but "automatic" that ends with a walk to the printer is not automatic.
  assert.equal(result.recommendedPrinterId, null);
});

test("reviews cost points but do not disqualify — they are the operator's to close", () => {
  const result = selectLaunchPrinter([
    candidate({ reviews: [{ code: "bed_unknown", message: "состояние стола неизвестно" }] })
  ]);
  assert.equal(result.candidates[0].eligible, true);
  assert.equal(result.recommendedPrinterId, "p1");
});

// ── Ranking ─────────────────────────────────────────────────────────────────

test("the printer already holding the right filament wins over an equal one that does not", () => {
  const result = selectLaunchPrinter([
    candidate({ printerId: "wrong-material", printerName: "A", loadedMaterial: null }),
    candidate({ printerId: "right-material", printerName: "B", loadedMaterial: "PETG" })
  ]);
  assert.equal(result.recommendedPrinterId, "right-material");
  assert.ok(
    result.candidates[0].reason.includes("PETG"),
    `reason should name the deciding fact, got: ${result.candidates[0].reason}`
  );
});

test("a busy printer loses to a free one", () => {
  const result = selectLaunchPrinter([
    candidate({ printerId: "busy", status: "printing" }),
    candidate({ printerId: "free", status: "idle" })
  ]);
  assert.equal(result.recommendedPrinterId, "free");
});

test("a printer that already holds the verified file beats one that must upload", () => {
  const result = selectLaunchPrinter([
    candidate({ printerId: "needs-upload", deviceFile: "missing" }),
    candidate({ printerId: "has-file", deviceFile: "verified" })
  ]);
  assert.equal(result.recommendedPrinterId, "has-file");
});

test("queue depth and open manual operations push a printer down", () => {
  const result = selectLaunchPrinter([
    candidate({ printerId: "loaded", queueLength: 4 }),
    candidate({ printerId: "empty", queueLength: 0 })
  ]);
  assert.equal(result.recommendedPrinterId, "empty");

  const withOps = selectLaunchPrinter([
    candidate({ printerId: "owed", pendingManualOperations: 2 }),
    candidate({ printerId: "clean", pendingManualOperations: 0 })
  ]);
  assert.equal(withOps.recommendedPrinterId, "clean");
});

test("ordering is stable for equally-good printers", () => {
  const a = candidate({ printerId: "aaa" });
  const b = candidate({ printerId: "bbb" });
  assert.equal(selectLaunchPrinter([a, b]).recommendedPrinterId, "aaa");
  assert.equal(selectLaunchPrinter([b, a]).recommendedPrinterId, "aaa", "input order must not decide");
});

test("eligible candidates always sort ahead of blocked ones", () => {
  const result = selectLaunchPrinter([
    candidate({ printerId: "blocked", blockers: [{ code: "printer_offline", message: "не в сети" }] }),
    candidate({ printerId: "ok" })
  ]);
  assert.deepEqual(
    result.candidates.map((c) => c.printerId),
    ["ok", "blocked"]
  );
});

// ── Explainability ──────────────────────────────────────────────────────────

test("every point in the score is attributable to a named component", () => {
  const [best] = selectLaunchPrinter([candidate()]).candidates;
  const summed = best.scoreBreakdown.reduce((n, p) => n + p.points, 0);
  assert.equal(best.score, summed, "score must equal the sum of its parts");
  assert.ok(best.scoreBreakdown.length > 0);
  for (const part of best.scoreBreakdown) {
    assert.ok(part.code && part.label, "each component names itself for the UI");
  }
});

test("a blocked candidate explains itself with its first blocker", () => {
  const [only] = selectLaunchPrinter([
    candidate({ blockers: [{ code: "printer_offline", message: "Принтер «X» не в сети" }] })
  ]).candidates;
  assert.match(only.reason, /не в сети/);
});
