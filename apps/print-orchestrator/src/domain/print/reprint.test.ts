import assert from "node:assert/strict";
import { test } from "node:test";

import type { SliceVariant } from "../slicing/types";
import {
  evaluateReprint,
  evaluateVariantReprint,
  isFinishedTask,
  reprepareHint,
  type ReprintFacts
} from "./reprint";
import type { Artifact, ArtifactAnalysis } from "./types";

/*
 * «Напечатать ещё раз» is a new print of the same verified bytes. These pin the
 * classification the history screen and the reprint command share: which
 * finished prints can be repeated, by which route, and — when not — the one
 * refusal the operator can act on.
 */

const AT = "2026-10-14T10:00:00.000Z";

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: "art_out",
    kind: "gcode",
    name: "cube.gcode",
    source: "sha256/ab/" + "a".repeat(64),
    sizeBytes: 1200,
    sha256: "a".repeat(64),
    createdAt: AT,
    updatedAt: AT,
    version: 1,
    legacyRef: null,
    metadata: {},
    ...over
  };
}

function analysis(over: Partial<ArtifactAnalysis> = {}): ArtifactAnalysis {
  return {
    id: "ana_out",
    artifactId: "art_out",
    state: "ready",
    detectedFormat: "gcode",
    verdict: "schedulable",
    analyzer: "gcode",
    analyzerVersion: "1.4.0",
    estimatedDurationS: 3600,
    estimatedFilamentG: 12,
    material: "PETG",
    nozzleDiameterMm: 0.4,
    layerHeightMm: 0.2,
    warnings: [],
    blockers: [],
    data: {},
    error: null,
    createdAt: AT,
    updatedAt: AT,
    version: 1,
    metadata: {},
    ...over
  };
}

function variant(over: Partial<SliceVariant> = {}): SliceVariant {
  return {
    id: "slc_1",
    taskId: "task_1",
    sourceArtifactId: "art_src",
    profileSetId: "pset_1",
    targetPrinterId: "k2",
    targetPrinterClass: null,
    state: "ready",
    cacheKey: "ck",
    orcaVersion: "2.3.0",
    workerVersion: "w1",
    outputArtifactId: "art_out",
    outputAnalysisId: "ana_out",
    orcaEtaS: 3500,
    filamentG: 11,
    filamentMm: 3000,
    dimensions: null,
    warnings: [],
    blockers: [],
    error: null,
    startedAt: AT,
    endedAt: AT,
    createdAt: AT,
    updatedAt: AT,
    version: 1,
    metadata: { scale: { factor: 1, reason: "declared_by_file" } },
    ...over
  };
}

function facts(over: Partial<ReprintFacts> = {}): ReprintFacts {
  return {
    task: { state: "COMPLETED", artifactId: "art_out", sliceVariantId: "slc_1" },
    executable: artifact(),
    stored: true,
    analysis: analysis(),
    analysisCurrent: true,
    variant: variant(),
    ...over
  };
}

test("finished means COMPLETED, FAILED or CANCELLED — nothing in flight", () => {
  for (const state of ["COMPLETED", "FAILED", "CANCELLED"] as const) assert.equal(isFinishedTask(state), true);
  for (const state of ["DRAFT", "QUEUED", "PLANNED", "ASSIGNED", "DISPATCHING", "PRINTING", "NEEDS_REVIEW"] as const) {
    assert.equal(isFinishedTask(state), false, state);
  }
});

test("a finished sliced print is repeated through its own ready variant", () => {
  const verdict = evaluateReprint(facts());
  assert.deepEqual(verdict, { ok: true, route: "variant", artifactId: "art_out", variantId: "slc_1" });
});

test("a print still in the queue or on a printer is not «повтор» yet", () => {
  for (const state of ["QUEUED", "PRINTING", "DISPATCHING"] as const) {
    const verdict = evaluateReprint(facts({ task: { state, artifactId: "art_out", sliceVariantId: "slc_1" } }));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok ? null : verdict.code, "not_finished");
  }
});

test("an uploaded G-code (no variant) is repeated as the executable itself", () => {
  const verdict = evaluateReprint(
    facts({ task: { state: "CANCELLED", artifactId: "art_out", sliceVariantId: null }, variant: null })
  );
  assert.deepEqual(verdict, { ok: true, route: "executable", artifactId: "art_out", variantId: null });
});

test("a slice whose variant went with its deleted source model falls back to the executable route", () => {
  // print_tasks.slice_variant_id has no FK: the id stays, the row is gone.
  const verdict = evaluateReprint(facts({ variant: null }));
  assert.equal(verdict.ok && verdict.route, "executable");
});

test("no file, a deleted blob, or a name-only legacy file refuses with the step to take", () => {
  const missing = evaluateReprint(facts({ task: { state: "COMPLETED", artifactId: null, sliceVariantId: null }, executable: null }));
  assert.equal(missing.ok ? null : missing.code, "file_missing");

  const deleted = evaluateReprint(facts({ stored: false }));
  assert.equal(deleted.ok ? null : deleted.code, "file_deleted");
  assert.match(deleted.ok ? "" : deleted.reason, /подготовьте модель заново/);

  const legacy = evaluateReprint(facts({ executable: artifact({ sha256: null, source: "cube.gcode" }), variant: null }));
  assert.equal(legacy.ok ? null : legacy.code, "file_unverified");
});

test("an unchecked blob (stored: null) is not a refusal — the delivery re-reads it", () => {
  assert.equal(evaluateReprint(facts({ stored: null })).ok, true);
});

test("a print closed while still a model has nothing to repeat — it must be sliced", () => {
  const verdict = evaluateReprint(
    facts({
      task: { state: "CANCELLED", artifactId: "art_src", sliceVariantId: null },
      executable: artifact({ id: "art_src", name: "cube.stl", kind: "model" }),
      analysis: analysis({ detectedFormat: "stl", verdict: "needs_preparation" }),
      variant: null
    })
  );
  assert.equal(verdict.ok ? null : verdict.code, "not_sliced");
});

test("an outdated analysis refuses before the launch would, naming the version", () => {
  const verdict = evaluateReprint(facts({ analysis: analysis({ analyzerVersion: "1.2.0" }), analysisCurrent: false }));
  assert.equal(verdict.ok ? null : verdict.code, "analysis_outdated");
  assert.match(verdict.ok ? "" : verdict.reason, /1\.2\.0/);
});

test("the output gate still applies: a blocked analysis is not printed again", () => {
  const verdict = evaluateReprint(
    facts({ analysis: analysis({ blockers: [{ code: "forbidden_command", message: "M502 в стартовом коде" }] }) })
  );
  assert.equal(verdict.ok ? null : verdict.code, "analysis_refused");
  assert.match(verdict.ok ? "" : verdict.reason, /M502/);
});

test("an uploaded sliced 3MF needs its review accepted, exactly like its first enqueue", () => {
  const verdict = evaluateReprint(
    facts({
      task: { state: "COMPLETED", artifactId: "art_out", sliceVariantId: null },
      executable: artifact({ name: "plate.gcode.3mf" }),
      analysis: analysis({ detectedFormat: "3mf", verdict: "review", data: { threeMfClass: "sliced" } }),
      variant: null
    })
  );
  assert.equal(verdict.ok ? null : verdict.code, "analysis_refused");
  assert.match(verdict.ok ? "" : verdict.reason, /подтвержд/);
});

test("variant reprint: a ready variant with a clean output, whatever its task", () => {
  const ok = evaluateVariantReprint({ variant: variant(), executable: artifact(), stored: true, analysis: analysis(), analysisCurrent: true });
  assert.deepEqual(ok, { ok: true, route: "variant", artifactId: "art_out", variantId: "slc_1" });

  const failed = evaluateVariantReprint({
    variant: variant({ state: "failed", outputArtifactId: null }),
    executable: null,
    stored: null,
    analysis: null,
    analysisCurrent: false
  });
  assert.equal(failed.ok ? null : failed.code, "variant_not_ready");

  const gone = evaluateVariantReprint({ variant: variant(), executable: artifact(), stored: false, analysis: analysis(), analysisCurrent: true });
  assert.equal(gone.ok ? null : gone.code, "file_deleted");
});

test("«подготовить заново» offers the source and the recipe it was made with", () => {
  const source = artifact({ id: "art_src", name: "cube.stl", kind: "model" });
  const sourceAnalysis = analysis({ id: "ana_src", artifactId: "art_src", detectedFormat: "stl", verdict: "needs_preparation" });
  assert.deepEqual(
    reprepareHint({ source, sourceAnalysis, variant: variant(), lastPrinterId: "a1" }),
    { artifactId: "art_src", printerId: "k2", profileSetId: "pset_1" },
    "the variant's target printer wins over where it last ran"
  );
  assert.deepEqual(
    reprepareHint({ source, sourceAnalysis, variant: null, lastPrinterId: "a1" }),
    { artifactId: "art_src", printerId: "a1", profileSetId: null }
  );
  assert.equal(reprepareHint({ source: null, sourceAnalysis: null, variant: variant(), lastPrinterId: null }), null);
  assert.equal(
    reprepareHint({ source, sourceAnalysis: analysis({ verdict: "blocked" }), variant: null, lastPrinterId: null }),
    null,
    "a source the analyzer refused is not something to slice"
  );
});
