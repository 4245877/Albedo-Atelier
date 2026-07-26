import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";

import { ValidationError } from "../../core/errors";
import { MODEL_SCALE_KEY, readModelScale } from "../../domain/print/modelScale";
import type { PrintQueueStore } from "../../domain/print/repositories";
import { openPrintQueueStore } from "../../infra/db/store";
import { ArtifactStorage } from "../../infra/storage/artifactStorage";
import type { AnalyzerResult } from "./analyzers";
import { ArtifactService } from "./artifactService";

/**
 * The operator scale confirmation — the only supported way an STL's un-scaled
 * numbers become millimetres. Everything here exists to keep that one decision
 * honest: it must be validated, audited, bound to the bytes it was made for, and
 * revocable.
 */

const LIMITS = {
  zipMaxEntries: 1000,
  zipMaxEntryBytes: 1 << 20,
  zipMaxTotalBytes: 1 << 20,
  zipMaxRatio: 200,
  xmlMaxBytes: 1 << 20
};

function stubResult(): AnalyzerResult {
  return {
    detectedFormat: "stl",
    verdict: "needs_preparation",
    warnings: [],
    blockers: [],
    data: { triangles: 2 },
    analyzer: "stub",
    analyzerVersion: "test"
  };
}

let dir: string;
let store: PrintQueueStore;
let service: ArtifactService;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-scale-"));
  store = openPrintQueueStore(":memory:");
  service = new ArtifactService(store, new ArtifactStorage({ root: path.join(dir, "artifacts") }), {
    limits: LIMITS,
    maxFileBytes: 1 << 20,
    timeoutMs: 2000,
    concurrency: 1,
    analyze: async () => stubResult()
  });
});
afterEach(() => {
  service.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function upload(name: string, data: string) {
  return service.ingest({ source: Readable.from([Buffer.from(data)]), fileName: name });
}

test("a confirmation is stored against the artifact's content hash and audited", async () => {
  const { artifact } = await upload("part.stl", "solid bytes");

  const { confirmation } = service.confirmModelScale(artifact.id, { units: "centimeter" });
  assert.equal(confirmation.units, "centimeter");
  assert.equal(confirmation.scaleFactor, 1);
  assert.equal(confirmation.sha256, artifact.sha256);

  const saved = store.repositories.artifacts.getById(artifact.id);
  assert.ok(saved);
  const resolved = readModelScale(saved);
  assert.ok(resolved);
  assert.equal(resolved.stale, false);
  assert.equal(resolved.mmPerUnit, 10);

  const actions = store.repositories.audit.listByEntity("artifact", artifact.id).map((e) => e.action);
  assert.ok(actions.includes("model_scale_confirmed"));
});

test("an extra scale factor is folded into the millimetres-per-unit", async () => {
  const { artifact } = await upload("part.stl", "solid bytes");
  service.confirmModelScale(artifact.id, { units: "inch", scaleFactor: 2 });

  const resolved = readModelScale(store.repositories.artifacts.getById(artifact.id)!);
  assert.equal(resolved?.mmPerUnit, 50.8);
});

test("an unconvertible unit or a nonsensical factor is refused", async () => {
  const { artifact } = await upload("part.stl", "solid bytes");

  assert.throws(() => service.confirmModelScale(artifact.id, { units: "parsec" }), ValidationError);
  assert.throws(() => service.confirmModelScale(artifact.id, { units: "" }), ValidationError);
  assert.throws(
    () => service.confirmModelScale(artifact.id, { units: "millimeter", scaleFactor: 0 }),
    ValidationError
  );
  assert.throws(
    () => service.confirmModelScale(artifact.id, { units: "millimeter", scaleFactor: -3 }),
    ValidationError
  );
  assert.throws(
    () => service.confirmModelScale(artifact.id, { units: "millimeter", scaleFactor: "many" }),
    ValidationError
  );
  // Nothing was written by any of the refused attempts.
  assert.equal(readModelScale(store.repositories.artifacts.getById(artifact.id)!), null);
});

test("G-code cannot be re-scaled — it is already machine millimetres", async () => {
  const { artifact } = await upload("ready.gcode", "G1 X0 Y0");
  assert.equal(artifact.kind, "gcode");
  assert.throws(() => service.confirmModelScale(artifact.id, { units: "inch" }), ValidationError);
});

test("clearing a confirmation returns the size to unproven, and is audited", async () => {
  const { artifact } = await upload("part.stl", "solid bytes");
  service.confirmModelScale(artifact.id, { units: "meter" });

  service.clearModelScale(artifact.id);
  const saved = store.repositories.artifacts.getById(artifact.id)!;
  assert.equal(readModelScale(saved), null);
  assert.equal(saved.metadata[MODEL_SCALE_KEY], undefined);

  const actions = store.repositories.audit.listByEntity("artifact", artifact.id).map((e) => e.action);
  assert.ok(actions.includes("model_scale_cleared"));
});

test("a confirmation does not carry over to different bytes", async () => {
  const { artifact } = await upload("part.stl", "original bytes");
  service.confirmModelScale(artifact.id, { units: "centimeter" });

  // Simulate the file being replaced under the same artifact row.
  const saved = store.repositories.artifacts.getById(artifact.id)!;
  const replaced = store.repositories.artifacts.update({ ...saved, sha256: "different-hash" });

  const resolved = readModelScale(replaced);
  assert.ok(resolved, "the record survives so the operator can see it lapsed");
  assert.equal(resolved.stale, true);
});

test("confirming an unknown artifact is a not-found, not a silent no-op", () => {
  assert.throws(() => service.confirmModelScale("art_missing", { units: "millimeter" }), /art_missing/);
});
