import assert from "node:assert/strict";
import { test } from "node:test";

import type { AnalysisFinding, ArtifactAnalysis, AnalysisVerdict, ArtifactAnalysisState } from "../print/types";
import { evaluateSliceOutput } from "./outputGate";

function analysis(over: Partial<ArtifactAnalysis> = {}): ArtifactAnalysis {
  return {
    id: "an_1",
    artifactId: "art_1",
    state: "ready" as ArtifactAnalysisState,
    detectedFormat: "gcode",
    verdict: "schedulable" as AnalysisVerdict,
    analyzer: "gcode",
    analyzerVersion: "1",
    estimatedDurationS: 3600,
    estimatedFilamentG: 12,
    material: "PETG",
    nozzleDiameterMm: 0.4,
    layerHeightMm: 0.2,
    warnings: [],
    blockers: [],
    data: {},
    error: null,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    version: 1,
    metadata: {},
    ...over
  };
}

const codes = (fs: AnalysisFinding[]): string[] => fs.map((f) => f.code);

test("a ready, schedulable, blocker-free output analysis passes the gate", () => {
  const gate = evaluateSliceOutput(analysis());
  assert.equal(gate.ok, true);
});

test("an analysis that did not complete (state !== ready) is rejected with output_analysis_incomplete", () => {
  for (const state of ["pending", "running", "failed"] as ArtifactAnalysisState[]) {
    const gate = evaluateSliceOutput(analysis({ state, error: "boom" }));
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.ok(codes(gate.blockers).includes("output_analysis_incomplete"));
  }
});

test("a ready analysis whose verdict is not schedulable is rejected (output_not_schedulable)", () => {
  for (const verdict of ["review", "needs_input", "needs_preparation", "blocked"] as AnalysisVerdict[]) {
    const gate = evaluateSliceOutput(analysis({ verdict }));
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.ok(codes(gate.blockers).includes("output_not_schedulable"));
  }
});

test("a null verdict on a ready analysis is treated as not-schedulable (fail-closed)", () => {
  const gate = evaluateSliceOutput(analysis({ verdict: null }));
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.ok(codes(gate.blockers).includes("output_not_schedulable"));
});

test("the analysis's own blockers are carried through the gate", () => {
  const gate = evaluateSliceOutput(
    analysis({ blockers: [{ code: "forbidden_command", message: "M502 в стартовом G-code" }] })
  );
  assert.equal(gate.ok, false);
  if (!gate.ok) {
    assert.ok(codes(gate.blockers).includes("forbidden_command"));
    assert.match(gate.reason, /M502/);
  }
});

test("blockers are de-duplicated so the same problem is not reported twice", () => {
  const dup: AnalysisFinding = { code: "forbidden_command", message: "M502" };
  const gate = evaluateSliceOutput(analysis({ verdict: "blocked", blockers: [dup, dup] }));
  assert.equal(gate.ok, false);
  if (!gate.ok) {
    const forbidden = gate.blockers.filter((b) => b.code === "forbidden_command");
    assert.equal(forbidden.length, 1);
  }
});

test("a ready+schedulable analysis that still carries a blocker does not pass (no silent success)", () => {
  const gate = evaluateSliceOutput(
    analysis({ verdict: "schedulable", blockers: [{ code: "risky", message: "подозрительная команда" }] })
  );
  assert.equal(gate.ok, false);
});
