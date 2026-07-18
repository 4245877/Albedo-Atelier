import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";

import { InsufficientStorageError, PayloadTooLargeError, ServiceBusyError } from "../../core/errors";
import type { PrintQueueStore } from "../../domain/print/repositories";
import { openPrintQueueStore } from "../../infra/db/store";
import { ArtifactStorage } from "../../infra/storage/artifactStorage";
import { ArtifactService, type ArtifactServiceOptions, type AnalyzeFn } from "./artifactService";
import type { AnalyzerResult } from "./analyzers";

/*
 * Server-side admission control for uploads (P0-5): a hostile or runaway client
 * must not be able to exhaust the shared data volume, the artifact store or the
 * analysis backlog. Every limit is enforced on the server, and a rejected upload
 * leaves no temp file behind.
 */

const LIMITS = { zipMaxEntries: 1000, zipMaxEntryBytes: 1 << 20, zipMaxTotalBytes: 1 << 20, zipMaxRatio: 200, xmlMaxBytes: 1 << 20 };

function ok(): AnalyzerResult {
  return { detectedFormat: "stl", verdict: "needs_preparation", warnings: [], blockers: [], data: {}, analyzer: "stub", analyzerVersion: "test" };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function harness(over: Partial<ArtifactServiceOptions> = {}, analyze: AnalyzeFn = async () => ok()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-quota-"));
  const store = openPrintQueueStore(":memory:");
  const storage = new ArtifactStorage({ root: path.join(dir, "artifacts") });
  const service = new ArtifactService(store, storage, {
    limits: LIMITS,
    maxFileBytes: 1 << 20,
    timeoutMs: 2000,
    concurrency: 2,
    analyze,
    ...over
  });
  cleanups.push(() => {
    service.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { service, storage, store, dir };
}

function tempFiles(storage: ArtifactStorage): string[] {
  try {
    return fs.readdirSync(storage.tmpDir).filter((f) => f.endsWith(".part"));
  } catch {
    return [];
  }
}

function upload(service: ArtifactService, name: string, data: string) {
  return service.ingest({ source: Readable.from([Buffer.from(data)]), fileName: name });
}

test("an oversized single file is refused (413) and no temp file is left behind", async () => {
  const { service, storage } = harness({ maxFileBytes: 8 });
  await assert.rejects(upload(service, "big.stl", "way more than eight bytes"), PayloadTooLargeError);
  assert.deepEqual(tempFiles(storage), [], "the staged temp file was cleaned up");
});

test("the artifact-count quota is enforced server-side", async () => {
  const { service, storage } = harness({ maxArtifactCount: 1 });
  await upload(service, "a.stl", "aaa");
  await assert.rejects(upload(service, "b.stl", "bbb"), InsufficientStorageError);
  assert.deepEqual(tempFiles(storage), [], "the rejected upload's temp file was cleaned up");
});

test("the total-store-bytes quota is enforced server-side", async () => {
  const { service } = harness({ maxStoredBytes: 4 });
  await assert.rejects(upload(service, "a.stl", "more than four bytes"), InsufficientStorageError);
});

test("identical (dedup) content does not count twice toward the byte quota", async () => {
  // Two bytes stored; quota 4 leaves room for exactly one 2-byte blob. Re-uploading
  // the SAME content must be allowed (adds nothing to disk), not double-counted.
  const { service } = harness({ maxStoredBytes: 4 });
  await upload(service, "a.stl", "ab");
  const again = await upload(service, "a-copy.stl", "ab");
  assert.equal(again.blobExisted, true, "the blob was deduplicated");
});

test("uploads are refused when free disk is below the reserve (507)", async () => {
  // Reserve larger than any real free space → the pre-upload check fails closed.
  const { service, storage } = harness({ minFreeDiskBytes: Number.MAX_SAFE_INTEGER });
  await assert.rejects(upload(service, "a.stl", "aaa"), InsufficientStorageError);
  assert.deepEqual(tempFiles(storage), [], "nothing was staged when the disk check failed");
});

test("the analysis backlog is bounded — a new upload is refused (503) when the queue is full", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  // The single in-flight analysis blocks on the gate, so inFlight stays at 1.
  const { service, store } = harness({ analysisMaxQueue: 1, timeoutMs: 5000 }, async () => {
    await gate;
    return ok();
  });

  await upload(service, "a.stl", "aaa"); // enqueued → inFlight = 1
  await assert.rejects(upload(service, "b.stl", "bbb"), ServiceBusyError);

  release();
  await service.whenIdle();
  // Once the queue drains, uploads are accepted again.
  const after = await upload(service, "c.stl", "ccc");
  assert.equal(after.artifact.name, "c.stl");
  void store;
});
