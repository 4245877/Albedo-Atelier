import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";

import type { PrintQueueStore } from "../../domain/print/repositories";
import { openPrintQueueStore } from "../../infra/db/store";
import { ArtifactStorage, keyFor } from "../../infra/storage/artifactStorage";
import { ArtifactService, type AnalyzeFn } from "./artifactService";
import type { AnalyzerResult } from "./analyzers";

const LIMITS = {
  zipMaxEntries: 1000,
  zipMaxEntryBytes: 1 << 20,
  zipMaxTotalBytes: 1 << 20,
  zipMaxRatio: 200,
  xmlMaxBytes: 1 << 20
};

function preparationResult(): AnalyzerResult {
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

interface Harness {
  service: ArtifactService;
  store: PrintQueueStore;
  storage: ArtifactStorage;
  dir: string;
  setAnalyze(fn: AnalyzeFn): void;
}

let dir: string;
let harness: Harness;

function makeHarness(store?: PrintQueueStore): Harness {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-svc-"));
  const st = store ?? openPrintQueueStore(":memory:");
  const storage = new ArtifactStorage({ root: path.join(d, "artifacts") });
  let impl: AnalyzeFn = async () => preparationResult();
  const service = new ArtifactService(st, storage, {
    limits: LIMITS,
    maxFileBytes: 1 << 20,
    timeoutMs: 2000,
    concurrency: 2,
    analyze: (input, limits) => impl(input, limits)
  });
  return { service, store: st, storage, dir: d, setAnalyze: (fn) => (impl = fn) };
}

beforeEach(() => {
  harness = makeHarness();
  dir = harness.dir;
});
afterEach(() => {
  harness.service.close();
  harness.store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function upload(name: string, data: Buffer | string) {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return harness.service.ingest({ source: Readable.from([buf]), fileName: name });
}

test("ingest creates an Artifact + DRAFT task + pending analysis + audit, and NO queue entry", async () => {
  const { artifact, task, analysis, blobExisted } = await upload("cube.stl", "solid model bytes");

  assert.equal(artifact.kind, "model");
  assert.equal(artifact.source, keyFor(createHash("sha256").update("solid model bytes").digest("hex")));
  assert.equal(task.state, "DRAFT");
  assert.equal(task.artifactId, artifact.id);
  assert.equal(analysis.state, "pending");
  assert.equal(blobExisted, false);

  const repos = harness.store.repositories;
  // The upload is a draft — it is NOT enqueued into the working queue.
  assert.equal(repos.queue.listOpen().length, 0);
  assert.equal(repos.queue.findByTaskId(task.id), null);

  // Audit trail for the upload chain.
  const artAudit = repos.audit.listByEntity("artifact", artifact.id).map((e) => e.action);
  assert.ok(artAudit.includes("uploaded"));
  assert.ok(repos.audit.listByEntity("print_task", task.id).some((e) => e.action === "created"));
  assert.ok(repos.audit.listByEntity("artifact_analysis", analysis.id).some((e) => e.action === "created"));
});

test("identical content reports blobExisted and does not duplicate the physical blob", async () => {
  const first = await upload("a.stl", "same bytes");
  const second = await upload("b.stl", "same bytes");

  assert.equal(first.blobExisted, false);
  assert.equal(second.blobExisted, true);
  assert.equal(first.artifact.source, second.artifact.source);

  const hashDir = path.dirname(harness.storage.resolvePath(first.artifact.source as string));
  assert.equal(fs.readdirSync(hashDir).length, 1, "one physical blob for identical content");

  // Two distinct artifacts + draft tasks still exist (two user intents).
  assert.notEqual(first.artifact.id, second.artifact.id);
});

test("the worker analyses the file and stores a verdict; the task stays DRAFT", async () => {
  const { artifact, task } = await upload("cube.stl", "bytes");
  await harness.service.whenIdle();

  const detail = harness.service.getArtifactDetail(artifact.id);
  const latest = detail.analyses[detail.analyses.length - 1];
  assert.equal(latest.state, "ready");
  assert.equal(latest.verdict, "needs_preparation");
  assert.equal(latest.detectedFormat, "stl");
  assert.equal(harness.store.repositories.tasks.getById(task.id)?.state, "DRAFT");
  assert.ok(
    harness.store.repositories.audit
      .listByEntity("artifact_analysis", latest.id)
      .some((e) => e.action === "analyzed")
  );
});

test("a blocked verdict parks the draft task in NEEDS_REVIEW", async () => {
  harness.setAnalyze(async () => ({
    ...preparationResult(),
    verdict: "blocked",
    blockers: [{ code: "unsupported_content", message: "не распознано" }]
  }));
  const { task } = await upload("weird.stl", "bytes");
  await harness.service.whenIdle();
  const updated = harness.store.repositories.tasks.getById(task.id);
  assert.equal(updated?.state, "NEEDS_REVIEW");
  assert.equal(updated?.reason, "не распознано");
});

test("a failed analysis can be re-run", async () => {
  harness.setAnalyze(async () => {
    throw new Error("boom");
  });
  const { artifact } = await upload("cube.stl", "bytes");
  await harness.service.whenIdle();

  let detail = harness.service.getArtifactDetail(artifact.id);
  assert.equal(detail.analyses[detail.analyses.length - 1].state, "failed");

  // Fix the analyzer and re-run.
  harness.setAnalyze(async () => preparationResult());
  harness.service.reanalyze(artifact.id);
  await harness.service.whenIdle();

  detail = harness.service.getArtifactDetail(artifact.id);
  assert.equal(detail.analyses.length, 2, "a fresh analysis row was appended");
  assert.equal(detail.analyses[detail.analyses.length - 1].state, "ready");
});

test("unfinished (pending/running) analyses are recovered after a restart", async () => {
  const a = await upload("a.stl", "aaa");
  const b = await upload("b.stl", "bbb");
  await harness.service.whenIdle();
  harness.service.close();

  const repos = harness.store.repositories;
  // Simulate a crash: force the two analyses back to pending/running.
  const ra = repos.artifactAnalyses.latestForArtifact(a.artifact.id)!;
  const rb = repos.artifactAnalyses.latestForArtifact(b.artifact.id)!;
  repos.artifactAnalyses.update({ ...ra, state: "pending", verdict: null });
  repos.artifactAnalyses.update({ ...rb, state: "running", verdict: null });

  // A fresh service over the same store (the "restart").
  const restarted = new ArtifactService(harness.store, harness.storage, {
    limits: LIMITS,
    maxFileBytes: 1 << 20,
    timeoutMs: 2000,
    concurrency: 2,
    analyze: async () => preparationResult()
  });
  const recovered = restarted.recover();
  assert.equal(recovered, 2);
  await restarted.whenIdle();
  restarted.close();

  assert.equal(repos.artifactAnalyses.getById(ra.id)?.state, "ready");
  assert.equal(repos.artifactAnalyses.getById(rb.id)?.state, "ready");
  // The running row went through a recovery transition.
  assert.ok(
    repos.audit.listByEntity("artifact_analysis", rb.id).some((e) => e.action === "analysis_recovered")
  );
});

test("a DB failure after the blob is saved removes the orphan blob and leaves no temp file", async () => {
  const data = Buffer.from("orphan bytes");
  const key = keyFor(createHash("sha256").update(data).digest("hex"));

  // Break the transaction so the row creation fails after the blob is committed.
  const original = harness.store.transaction.bind(harness.store);
  harness.store.transaction = (<T>(): T => {
    throw new Error("db is down");
  }) as typeof harness.store.transaction;

  await assert.rejects(() => upload("x.stl", data), /db is down/);

  // Restore for the afterEach close.
  harness.store.transaction = original;

  assert.equal(await harness.storage.exists(key), false, "orphan blob was cleaned up");
  const tmp = harness.storage.tmpDir;
  assert.deepEqual(fs.existsSync(tmp) ? fs.readdirSync(tmp) : [], [], "no leftover temp files");
});

test("integration: the real analyzer reads a stored G-code blob", async () => {
  // A service with the DEFAULT (real) analyzer for one end-to-end pass.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-svc-real-"));
  const store = openPrintQueueStore(":memory:");
  const storage = new ArtifactStorage({ root: path.join(d, "artifacts") });
  const real = {
    service: new ArtifactService(store, storage, {
      limits: LIMITS,
      maxFileBytes: 1 << 20,
      timeoutMs: 5000,
      concurrency: 2
    }),
    store,
    dir: d
  };
  try {
    const gcode = [
      "; generated by PrusaSlicer 2.7.1",
      "; printer_model = MK4",
      "; filament_type = PLA",
      "G21",
      "G90",
      "G1 X0 Y0",
      "G1 X40 Y30"
    ].join("\n");
    const { artifact } = await real.service.ingest({
      source: Readable.from([Buffer.from(gcode)]),
      fileName: "real.gcode"
    });
    await real.service.whenIdle();
    const detail = real.service.getArtifactDetail(artifact.id);
    const latest = detail.analyses[detail.analyses.length - 1];
    assert.equal(latest.state, "ready");
    assert.equal(latest.detectedFormat, "gcode");
    assert.equal(latest.material, "PLA");
  } finally {
    real.service.close();
    real.store.close();
    fs.rmSync(real.dir, { recursive: true, force: true });
  }
});
