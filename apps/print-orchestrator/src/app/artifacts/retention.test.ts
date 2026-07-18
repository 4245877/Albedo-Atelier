import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";

import { ValidationError } from "../../core/errors";
import type { PrintQueueStore } from "../../domain/print/repositories";
import { openPrintQueueStore } from "../../infra/db/store";
import { ArtifactStorage, keyFor } from "../../infra/storage/artifactStorage";
import { PrintQueueService } from "../printQueue/printQueueService";
import { ArtifactService } from "./artifactService";
import type { AnalyzerResult } from "./analyzers";

/*
 * Retention and safe deletion: an artifact bound to live work is protected; a
 * deduplicated blob survives until its LAST reference goes; DB and file removal
 * stay consistent (file goes only after the commit; a failed unlink leaves an
 * orphan the sweep reclaims — never a lying DB row).
 */

const LIMITS = {
  zipMaxEntries: 10,
  zipMaxEntryBytes: 1 << 20,
  zipMaxTotalBytes: 1 << 20,
  zipMaxRatio: 200,
  xmlMaxBytes: 1 << 20
};

let dir: string;
let store: PrintQueueStore;
let storage: ArtifactStorage;
let service: ArtifactService;
let queue: PrintQueueService;

function result(): AnalyzerResult {
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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-retention-"));
  store = openPrintQueueStore(":memory:");
  storage = new ArtifactStorage({ root: path.join(dir, "artifacts") });
  service = new ArtifactService(store, storage, {
    limits: LIMITS,
    maxFileBytes: 1 << 20,
    timeoutMs: 2000,
    concurrency: 1,
    analyze: async () => result()
  });
  queue = new PrintQueueService(store);
});

afterEach(() => {
  service.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function upload(name: string, content: string) {
  const res = await service.ingest({ source: Readable.from([Buffer.from(content)]), fileName: name });
  await service.whenIdle();
  return res;
}

test("an unused artifact deletes cleanly: DB row gone, blob gone, DRAFT task cancelled", async () => {
  const { artifact, task } = await upload("a.gcode", "G28\nunique-a");

  const outcome = await service.deleteArtifact(artifact.id);
  assert.equal(outcome.blobRemoved, true);
  assert.equal(store.repositories.artifacts.getById(artifact.id), null);
  assert.equal(await storage.exists(artifact.source as string), false, "blob unlinked");
  assert.equal(store.repositories.tasks.getById(task.id)?.state, "CANCELLED");
});

test("an artifact used by an active (queued) task is protected", async () => {
  const { artifact } = await upload("b.gcode", "G28\nunique-b");
  queue.addTask({ title: "Live", artifactId: artifact.id, pinnedPrinterId: undefined });

  await assert.rejects(
    service.deleteArtifact(artifact.id),
    (e: unknown) => e instanceof ValidationError && /использует артефакт/.test((e as Error).message)
  );
  assert.ok(store.repositories.artifacts.getById(artifact.id), "still present");
});

test("a deduplicated blob survives until the LAST referencing artifact is deleted", async () => {
  const first = await upload("same-1.gcode", "G28\nshared-bytes");
  const second = await upload("same-2.gcode", "G28\nshared-bytes");
  assert.equal(first.artifact.source, second.artifact.source, "one blob, two artifacts");

  const one = await service.deleteArtifact(first.artifact.id);
  assert.equal(one.blobRemoved, false, "still referenced by the second artifact");
  assert.equal(await storage.exists(second.artifact.source as string), true);

  const two = await service.deleteArtifact(second.artifact.id);
  assert.equal(two.blobRemoved, true, "last reference gone → blob gone");
  assert.equal(await storage.exists(second.artifact.source as string), false);
});

test("a filesystem unlink failure leaves a truthful DB (deleted) and an orphan the sweep reclaims", async () => {
  const { artifact } = await upload("c.gcode", "G28\nunique-c");
  const key = artifact.source as string;

  // Sabotage the unlink: replace the blob path with a non-empty directory.
  const blobPath = storage.resolvePath(key);
  fs.rmSync(blobPath);
  fs.mkdirSync(blobPath);
  fs.writeFileSync(path.join(blobPath, "stuck"), "x");

  const outcome = await service.deleteArtifact(artifact.id);
  assert.equal(outcome.blobRemoved, false, "unlink failed");
  assert.equal(store.repositories.artifacts.getById(artifact.id), null, "DB is truthful");

  // The orphan sweep reports it (dry run) …
  fs.rmSync(blobPath, { recursive: true, force: true });
  fs.writeFileSync(blobPath, "orphan-bytes");
  const dry = await service.orphanSweep({ dryRun: true });
  assert.ok(dry.orphanBlobsRemoved.includes(key));
  assert.equal(await storage.exists(key), true, "dry run touches nothing");
  // …and reclaims it for real.
  const wet = await service.orphanSweep({ dryRun: false });
  assert.ok(wet.orphanBlobsRemoved.includes(key));
  assert.equal(await storage.exists(key), false);
});

test("orphan DB records (blob missing on disk) are REPORTED, never auto-deleted", async () => {
  const { artifact } = await upload("d.gcode", "G28\nunique-d");
  fs.rmSync(storage.resolvePath(artifact.source as string));

  const report = await service.orphanSweep({ dryRun: false });
  assert.ok(report.artifactsMissingBlob.includes(artifact.id));
  assert.ok(store.repositories.artifacts.getById(artifact.id), "the row stays for the operator");
});

test("retention sweep: cutoff respected, DRAFT excluded, limit enforced, dry-run inert", async () => {
  const fresh = await upload("fresh.gcode", "G28\nfresh");
  const old1 = await upload("old1.gcode", "G28\nold-1");
  const old2 = await upload("old2.gcode", "G28\nold-2");

  // Age two artifacts past the cutoff and close their DRAFT tasks (a DRAFT is
  // never auto-reclaimed) — old1/old2 become terminal-referenced.
  const repos = store.repositories;
  for (const { artifact, task } of [old1, old2]) {
    const a = repos.artifacts.getById(artifact.id)!;
    repos.artifacts.update({ ...a, createdAt: "2020-01-01T00:00:00.000Z", updatedAt: a.updatedAt });
    const t = repos.tasks.getById(task.id)!;
    repos.tasks.update({ ...t, state: "CANCELLED", updatedAt: t.updatedAt });
  }
  // Age the fresh one's DRAFT too — it must be skipped for being a DRAFT.
  const freshArt = repos.artifacts.getById(fresh.artifact.id)!;
  repos.artifacts.update({ ...freshArt, createdAt: "2020-01-01T00:00:00.000Z", updatedAt: freshArt.updatedAt });

  const dry = await service.retentionSweep({ olderThanDays: 30, dryRun: true });
  assert.deepEqual([...dry.deleted].sort(), [old1.artifact.id, old2.artifact.id].sort());
  assert.ok(store.repositories.artifacts.getById(old1.artifact.id), "dry run deletes nothing");
  assert.ok(dry.skipped.some((s) => s.id === fresh.artifact.id && /черновик/.test(s.reason)));

  const limited = await service.retentionSweep({ olderThanDays: 30, maxDelete: 1 });
  assert.equal(limited.deleted.length, 1, "one sweep is bounded");
  assert.ok(limited.skipped.some((s) => /лимит/.test(s.reason)));

  const rest = await service.retentionSweep({ olderThanDays: 30 });
  assert.equal(rest.deleted.length, 1, "the remaining old artifact goes on the next sweep");
});

test("concurrent dispatch-vs-cleanup: an artifact that became live mid-decision is refused in the tx", async () => {
  const { artifact } = await upload("race.gcode", "G28\nrace");
  // The pre-check would pass (only a DRAFT reference)…
  assert.equal(service.deletionBlocker(artifact.id), null);
  // …but the task is queued before the delete transaction runs (simulating the
  // race) — the in-transaction re-check must refuse.
  queue.addTask({ title: "Raced", artifactId: artifact.id });
  await assert.rejects(service.deleteArtifact(artifact.id), ValidationError);
  assert.equal(await storage.exists(keyFor((artifact.sha256 as string) ?? "")), true, "blob intact");
});
