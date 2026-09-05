import assert from "node:assert/strict";
import { test } from "node:test";

import {
  analysisReviewAccepted,
  ANALYSIS_REVIEW_KEY,
  makeAnalysisReview,
  readAnalysisReview,
  reviewCodesOf
} from "./analysisReview";
import { evaluateExecutableArtifact, executableKindOf } from "./executable";
import type { Artifact, ArtifactAnalysis } from "./types";

/*
 * The acknowledgement is the only thing that lets a `review` verdict print, so
 * every one of its limits is a safety property, not a nicety: it must be bound
 * to specific bytes, to a specific analysis, and to the specific findings that
 * were on screen when a person said yes.
 */

const SHA = "a".repeat(64);
const ISO = "2026-08-14T12:00:00.000Z";

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: "art_1",
    kind: "model",
    name: "bracket.gcode.3mf",
    source: "sha256/aa/…",
    sizeBytes: 1000,
    sha256: SHA,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {},
    ...over
  };
}

function analysis(over: Partial<ArtifactAnalysis> = {}): ArtifactAnalysis {
  return {
    id: "ana_1",
    artifactId: "art_1",
    state: "ready",
    detectedFormat: "3mf",
    verdict: "review",
    analyzer: "3mf",
    analyzerVersion: "1.1.0",
    estimatedDurationS: 100,
    estimatedFilamentG: 10,
    material: "PETG",
    nozzleDiameterMm: 0.4,
    layerHeightMm: 0.2,
    warnings: [{ code: "threemf_sliced_payload", message: "нарезан чужим профилем" }],
    blockers: [],
    data: { threeMfClass: "sliced", hasGcodePayload: true },
    error: null,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {},
    ...over
  };
}

/** An artifact carrying a live acknowledgement of `a`. */
function acknowledged(a: ArtifactAnalysis, by = "мастер"): Artifact {
  const ack = makeAnalysisReview({
    artifact: artifact(),
    analysis: a,
    confirmedBy: by,
    confirmedAt: ISO
  });
  assert.ok(ack, "the fixture itself must be acknowledgeable");
  return artifact({ metadata: { [ANALYSIS_REVIEW_KEY]: { ...ack } } });
}

test("a review verdict can be accepted, and the acceptance names its evidence", () => {
  const a = analysis();
  const ack = makeAnalysisReview({ artifact: artifact(), analysis: a, confirmedBy: "мастер", confirmedAt: ISO })!;
  assert.equal(ack.analysisId, a.id);
  assert.equal(ack.sha256, SHA, "bound to the bytes");
  assert.deepEqual(ack.codes, ["threemf_sliced_payload"], "and to the findings that were read");
  assert.equal(ack.confirmedBy, "мастер");
});

test("a schedulable verdict has nothing to accept", () => {
  assert.equal(
    makeAnalysisReview({
      artifact: artifact(),
      analysis: analysis({ verdict: "schedulable" }),
      confirmedBy: "мастер",
      confirmedAt: ISO
    }),
    null
  );
});

test("a blocked verdict cannot be accepted — no tick makes a corrupt file printable", () => {
  assert.equal(
    makeAnalysisReview({
      artifact: artifact(),
      analysis: analysis({ verdict: "blocked" }),
      confirmedBy: "мастер",
      confirmedAt: ISO
    }),
    null
  );
});

test("an analysis carrying blockers cannot be accepted either", () => {
  assert.equal(
    makeAnalysisReview({
      artifact: artifact(),
      analysis: analysis({ blockers: [{ code: "gcode_forbidden", message: "M502" }] }),
      confirmedBy: "мастер",
      confirmedAt: ISO
    }),
    null
  );
});

test("an unfinished analysis cannot be accepted in advance", () => {
  assert.equal(
    makeAnalysisReview({
      artifact: artifact(),
      analysis: analysis({ state: "running", verdict: null }),
      confirmedBy: "мастер",
      confirmedAt: ISO
    }),
    null
  );
});

test("replacing the file lapses the acknowledgement", () => {
  const a = analysis();
  const held = acknowledged(a);
  const changed = { ...held, sha256: "b".repeat(64) };
  const resolved = readAnalysisReview(changed, a)!;
  assert.equal(resolved.stale, true);
  assert.match(resolved.staleReason!, /содержимое файла изменилось/);
  assert.equal(analysisReviewAccepted(changed, a), false);
});

test("re-analysing the same bytes lapses it — nobody read THAT analysis", () => {
  const a = analysis();
  const held = acknowledged(a);
  const redone = analysis({ id: "ana_2" });
  const resolved = readAnalysisReview(held, redone)!;
  assert.equal(resolved.stale, true);
  assert.match(resolved.staleReason!, /проанализирован заново/);
});

test("a NEW finding is not covered by an acceptance made before it existed", () => {
  const a = analysis();
  const held = acknowledged(a);
  const withMore = analysis({
    warnings: [...a.warnings, { code: "gcode_unknown_slicer", message: "слайсер не распознан" }]
  });
  const resolved = readAnalysisReview(held, withMore)!;
  assert.equal(resolved.stale, true);
  assert.match(resolved.staleReason!, /новые замечания/);
  assert.match(resolved.staleReason!, /gcode_unknown_slicer/);
});

test("a live acknowledgement of the same analysis and bytes is current", () => {
  const a = analysis();
  const held = acknowledged(a);
  assert.equal(analysisReviewAccepted(held, a), true);
  assert.equal(readAnalysisReview(held, a)!.stale, false);
});

test("findings are collected from both lists, deduplicated and ordered", () => {
  const a = analysis({
    warnings: [
      { code: "b", message: "…" },
      { code: "a", message: "…" }
    ],
    blockers: [{ code: "a", message: "…" }]
  });
  assert.deepEqual(reviewCodesOf(a), ["a", "b"]);
});

/* ── Executable admission ─────────────────────────────────────────────────── */

test("a sliced 3MF is executable by CONTENT, never by its name", () => {
  assert.equal(executableKindOf(analysis()), "sliced_3mf");
  // The same double extension over a plain model: a ZIP with no plate payload.
  assert.equal(
    executableKindOf(analysis({ data: { threeMfClass: "generic", hasGcodePayload: false } })),
    null
  );
});

test("a model is refused by the executable path, and the refusal names slicing", () => {
  const result = evaluateExecutableArtifact(
    artifact({ name: "bracket.stl" }),
    analysis({ detectedFormat: "stl", verdict: "needs_preparation", data: {} })
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "not_executable");
  assert.match(result.ok === false ? result.reason : "", /нарежьте/i);
});

test("an executable with an unread review is refused WITH the next step flagged", () => {
  const result = evaluateExecutableArtifact(artifact(), analysis());
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.needsReview, true, "not a dead end — a step");
});

test("an executable with an accepted review is admitted, and says who accepted it", () => {
  const a = analysis();
  const result = evaluateExecutableArtifact(acknowledged(a), a);
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.kind, "sliced_3mf");
  assert.equal(result.ok === true && result.acknowledgedBy, "мастер");
});

test("a schedulable G-code needs no acknowledgement at all", () => {
  const result = evaluateExecutableArtifact(
    artifact({ name: "bracket.gcode", kind: "gcode" }),
    analysis({ detectedFormat: "gcode", verdict: "schedulable", warnings: [], data: {} })
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.kind, "gcode");
});

test("an unfinished analysis is refused without claiming a review would help", () => {
  const result = evaluateExecutableArtifact(artifact(), analysis({ state: "running", verdict: null }));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "analysis_incomplete");
  assert.equal(result.ok === false && result.needsReview, false);
});
