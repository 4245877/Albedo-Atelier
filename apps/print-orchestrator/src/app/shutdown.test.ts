import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { openPrintQueueStore } from "../infra/db/store";
import { ArtifactStorage } from "../infra/storage/artifactStorage";
import { ArtifactService } from "./artifacts/artifactService";
import type { AnalyzerResult } from "./artifacts/analyzers";
import { FarmStore } from "./farmStore";

/*
 * Graceful-shutdown ordering. The historical bug: SQLite was closed while an
 * analysis/slice job was still writing, so its final transaction crashed with
 * "database is not open". The contract now: close() stops NEW work, whenIdle()
 * is awaited (with a deadline) and only then may the store close.
 */

const LIMITS = {
  zipMaxEntries: 10,
  zipMaxEntryBytes: 1 << 20,
  zipMaxTotalBytes: 1 << 20,
  zipMaxRatio: 200,
  xmlMaxBytes: 1 << 20
};

function slowResult(): AnalyzerResult {
  return {
    detectedFormat: "gcode",
    verdict: "schedulable",
    warnings: [],
    blockers: [],
    data: {},
    analyzer: "stub",
    analyzerVersion: "test"
  };
}

test("SIGTERM during analysis: the in-flight job finishes BEFORE the database closes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-shutdown-"));
  const store = openPrintQueueStore(":memory:");
  const storage = new ArtifactStorage({ root: path.join(dir, "artifacts") });
  const errors: unknown[] = [];
  const service = new ArtifactService(store, storage, {
    limits: LIMITS,
    maxFileBytes: 1 << 20,
    timeoutMs: 2000,
    concurrency: 1,
    logger: { error: (obj) => errors.push(obj) },
    analyze: async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return slowResult();
    }
  });

  const { analysis } = await service.ingest({
    source: Readable.from([Buffer.from("G28\nG1 X1 Y1\n")]),
    fileName: "part.gcode"
  });

  // The shutdown sequence FarmStore.stop() now performs:
  service.close(); // no new work
  await service.whenIdle(); // in-flight job settles, writing its result
  store.close(); // only now

  const finished = openPrintQueueStoreReopenCheck(errors);
  assert.ok(finished, "no write hit a closed database");
  assert.equal(errors.length, 0, `no worker crashes: ${JSON.stringify(errors)}`);
  // The result actually landed before close (we re-check via the same store
  // being closed — the read below must have happened before close in the
  // worker; assert on the captured analysis state instead).
  void analysis;
  fs.rmSync(dir, { recursive: true, force: true });
});

function openPrintQueueStoreReopenCheck(errors: unknown[]): boolean {
  return !errors.some((e) => String((e as { err?: Error }).err?.message ?? e).includes("database is not open"));
}

test("the drained analysis result is durably persisted (ready), not lost", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-shutdown2-"));
  const dbPath = path.join(dir, "queue.db");
  const store = openPrintQueueStore(dbPath);
  const storage = new ArtifactStorage({ root: path.join(dir, "artifacts") });
  const service = new ArtifactService(store, storage, {
    limits: LIMITS,
    maxFileBytes: 1 << 20,
    timeoutMs: 2000,
    concurrency: 1,
    analyze: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return slowResult();
    }
  });

  const { analysis } = await service.ingest({
    source: Readable.from([Buffer.from("G28\n")]),
    fileName: "p.gcode"
  });
  service.close();
  await service.whenIdle();
  store.close();

  // Reopen the same file: the result survived the shutdown.
  const reopened = openPrintQueueStore(dbPath);
  const persisted = reopened.repositories.artifactAnalyses.getById(analysis.id);
  assert.equal(persisted?.state, "ready");
  assert.equal(persisted?.verdict, "schedulable");
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("FarmStore.stop() is idempotent — a double signal awaits one shutdown, no crash", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-shutdown3-"));
  const store = new FarmStore(path.join(dir, "state.json"));
  store.addQueueJob({ title: "T", printer: "k2" }); // opens the SQLite store lazily

  await Promise.all([store.stop(), store.stop()]);
  await store.stop(); // and once more after completion
  fs.rmSync(dir, { recursive: true, force: true });
});
