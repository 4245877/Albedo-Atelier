import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";

import { ValidationError } from "../../core/errors";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import {
  EMPTY_ASSIGNMENT_BINDING,
  type Assignment,
  type AssignmentState,
  type DeviceArtifact,
  type DeviceArtifactState,
  type PrintTaskState
} from "../../domain/print/types";
import type {
  ProfileRevision,
  ProfileSet,
  ProfileType,
  SliceVariant,
  SliceVariantState
} from "../../domain/slicing/types";
import { openPrintQueueStore } from "../../infra/db/store";
import { ArtifactStorage } from "../../infra/storage/artifactStorage";
import { ArtifactService } from "./artifactService";
import type { AnalyzerResult } from "./analyzers";

/*
 * Deleting a stored file is only safe if we can see EVERY row that points at it.
 *
 * The reference graph is wider than it looks: a promoted slice re-points its
 * task's `artifact_id` at the produced G-code and leaves the source model named
 * only by `source_artifact_id`, assignments carry their own binding columns, and
 * `slice_variants.source_artifact_id` is `ON DELETE CASCADE` — so deleting a
 * model can destroy slice variants without a single line of application code
 * saying so. These tests pin the rules that keep that from happening quietly,
 * and the blob lock that keeps a delete from robbing a concurrent upload.
 */

const ISO = "2025-01-01T00:00:00.000Z";
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

function analyzerResult(): AnalyzerResult {
  return {
    detectedFormat: "stl",
    verdict: "needs_preparation",
    warnings: [],
    blockers: [],
    data: {},
    analyzer: "stub",
    analyzerVersion: "test"
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-deletion-"));
  store = openPrintQueueStore(":memory:");
  storage = new ArtifactStorage({ root: path.join(dir, "artifacts") });
  service = new ArtifactService(store, storage, {
    limits: LIMITS,
    maxFileBytes: 1 << 20,
    timeoutMs: 2000,
    concurrency: 1,
    analyze: async () => analyzerResult()
  });
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

/** A minimal stored profile revision — a slice variant's set needs three real ones. */
function revision(type: ProfileType): ProfileRevision {
  const rev: ProfileRevision = {
    id: newId(ID_PREFIX.profileRevision),
    logicalId: `${type}:fixture`,
    type,
    name: `fixture ${type}`,
    inherits: null,
    status: "active",
    rawJson: "{}",
    rawSha256: newId(ID_PREFIX.profileRevision),
    resolvedJson: "{}",
    resolvedSha256: null,
    orcaVersion: "2.3.0",
    source: "fixture",
    warnings: [],
    blockers: [],
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {}
  };
  store.repositories.profileRevisions.insert(rev);
  return rev;
}

/** An approved profile set — the FK a slice variant needs besides its task. */
function profileSet(): ProfileSet {
  const set: ProfileSet = {
    id: newId(ID_PREFIX.profileSet),
    name: "K2 · PLA",
    machineRevisionId: revision("machine").id,
    processRevisionId: revision("process").id,
    filamentRevisionId: revision("filament").id,
    printerId: "k2",
    printerClass: null,
    validation: "valid",
    approved: true,
    approvedBy: "operator",
    approvedAt: ISO,
    warnings: [],
    blockers: [],
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {}
  };
  store.repositories.profileSets.insert(set);
  return set;
}

function sliceVariant(over: {
  taskId: string;
  sourceArtifactId: string;
  outputArtifactId?: string | null;
  state?: SliceVariantState;
}): SliceVariant {
  const variant: SliceVariant = {
    id: newId(ID_PREFIX.sliceVariant),
    taskId: over.taskId,
    sourceArtifactId: over.sourceArtifactId,
    profileSetId: profileSet().id,
    targetPrinterId: "k2",
    targetPrinterClass: null,
    state: over.state ?? "ready",
    cacheKey: `ck_${over.taskId}`,
    orcaVersion: "2.3.0",
    workerVersion: "1",
    outputArtifactId: over.outputArtifactId ?? null,
    outputAnalysisId: null,
    orcaEtaS: 3600,
    filamentG: 20,
    filamentMm: 1000,
    dimensions: null,
    warnings: [],
    blockers: [],
    error: null,
    startedAt: ISO,
    endedAt: ISO,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {}
  };
  store.repositories.sliceVariants.insert(variant);
  return variant;
}

/** What `promoteSliceVariant` leaves behind: the task now executes the G-code. */
function promote(taskId: string, variant: SliceVariant, state: PrintTaskState = "QUEUED"): void {
  const task = store.repositories.tasks.getById(taskId)!;
  store.repositories.tasks.update({
    ...task,
    artifactId: variant.outputArtifactId,
    sliceVariantId: variant.id,
    sourceArtifactId: variant.sourceArtifactId,
    onDeviceFile: "cube.gcode",
    state,
    updatedAt: ISO
  });
}

function assignment(over: {
  taskId: string;
  state: AssignmentState;
  artifactId?: string | null;
  sliceVariantId?: string | null;
}): Assignment {
  const row: Assignment = {
    id: newId(ID_PREFIX.assignment),
    taskId: over.taskId,
    printerId: "k2",
    planId: null,
    bedCycleId: null,
    state: over.state,
    source: "manual",
    reason: null,
    createdBy: "operator",
    binding: {
      ...EMPTY_ASSIGNMENT_BINDING,
      artifactId: over.artifactId ?? null,
      sliceVariantId: over.sliceVariantId ?? null
    },
    invalidatedAt: null,
    invalidatedReason: null,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  store.repositories.assignments.insert(row);
  return row;
}

function deviceArtifact(artifactId: string, state: DeviceArtifactState): DeviceArtifact {
  const row: DeviceArtifact = {
    id: newId(ID_PREFIX.deviceArtifact),
    printerId: "k2",
    assignmentId: null,
    sliceVariantId: null,
    artifactId,
    artifactSha256: null,
    remotePath: "cube.gcode",
    sizeBytes: 10,
    state,
    transferMode: "adapter_upload",
    verification: null,
    uploadedAt: null,
    verifiedAt: null,
    confirmedBy: null,
    lastError: null,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {}
  };
  store.repositories.deviceArtifacts.insert(row);
  return row;
}

test("a source model a live task was promoted from is protected — the task no longer names it as artifact_id", async () => {
  const model = await upload("cube.stl", "solid cube-a");
  const output = await upload("cube.gcode", "G28 ; sliced-a");
  const variant = sliceVariant({
    taskId: model.task.id,
    sourceArtifactId: model.artifact.id,
    outputArtifactId: output.artifact.id
  });
  promote(model.task.id, variant, "QUEUED");

  // Exactly the hole this closes: `artifact_id` now points at the G-code, so a
  // check that reads only that column sees the STL as unreferenced.
  assert.equal(store.repositories.tasks.findByArtifactId(model.artifact.id), null);

  const blocker = service.deletionBlocker(model.artifact.id);
  assert.match(blocker ?? "", /QUEUED/);
  await assert.rejects(service.deleteArtifact(model.artifact.id), ValidationError);
  assert.ok(store.repositories.artifacts.getById(model.artifact.id), "the model survives");
  assert.ok(store.repositories.sliceVariants.getById(variant.id), "so does its slice");
});

test("the G-code a live task executes is protected too", async () => {
  const model = await upload("cube2.stl", "solid cube-b");
  const output = await upload("cube2.gcode", "G28 ; sliced-b");
  const variant = sliceVariant({
    taskId: model.task.id,
    sourceArtifactId: model.artifact.id,
    outputArtifactId: output.artifact.id
  });
  promote(model.task.id, variant, "QUEUED");

  await assert.rejects(service.deleteArtifact(output.artifact.id), ValidationError);
  assert.ok(store.repositories.artifacts.getById(output.artifact.id));
});

test("deleting a finished model removes its slice variants EXPLICITLY and keeps the sliced G-code", async () => {
  const model = await upload("done.stl", "solid cube-c");
  const output = await upload("done.gcode", "G28 ; sliced-c");
  const variant = sliceVariant({
    taskId: model.task.id,
    sourceArtifactId: model.artifact.id,
    outputArtifactId: output.artifact.id
  });
  promote(model.task.id, variant, "COMPLETED");

  const outcome = await service.deleteArtifact(model.artifact.id);

  assert.deepEqual(outcome.removedSliceVariants, [variant.id]);
  assert.equal(outcome.blobRemoved, true);
  assert.equal(store.repositories.sliceVariants.getById(variant.id), null, "the variant went with its source");
  // The sliced G-code is a file of its own — it is NOT collateral.
  assert.ok(store.repositories.artifacts.getById(output.artifact.id), "the G-code artifact stays");
  assert.equal(await storage.exists(output.artifact.source as string), true, "and so do its bytes");

  // The cascade is auditable rather than silent — that is the whole point of
  // doing it in the service instead of leaving it to the foreign key.
  const audit = store.repositories.audit.listByEntity("slice_variant", variant.id);
  assert.ok(audit.some((e) => e.action === "deleted"), "the removed variant is in the audit log");
});

test("a live assignment protects both the file it names and the model behind its variant", async () => {
  const model = await upload("live.stl", "solid cube-d");
  const output = await upload("live.gcode", "G28 ; sliced-d");
  const variant = sliceVariant({
    taskId: model.task.id,
    sourceArtifactId: model.artifact.id,
    outputArtifactId: output.artifact.id
  });
  // The task itself is terminal — only the assignment is still live.
  promote(model.task.id, variant, "COMPLETED");
  const live = assignment({
    taskId: model.task.id,
    state: "RESERVED",
    artifactId: output.artifact.id,
    sliceVariantId: variant.id
  });

  assert.match(service.deletionBlocker(output.artifact.id) ?? "", new RegExp(live.id));
  assert.match(service.deletionBlocker(model.artifact.id) ?? "", new RegExp(variant.id));
  await assert.rejects(service.deleteArtifact(output.artifact.id), ValidationError);
  await assert.rejects(service.deleteArtifact(model.artifact.id), ValidationError);

  // Released placement → both are free again, and the variant goes with the model.
  const released = store.repositories.assignments.getById(live.id)!;
  store.repositories.assignments.update({ ...released, state: "RELEASED", updatedAt: ISO });
  assert.equal(service.deletionBlocker(output.artifact.id), null);
  assert.equal(service.deletionBlocker(model.artifact.id), null);
});

test("a file being streamed to a printer is protected; one already delivered is not", async () => {
  const gcode = await upload("device.gcode", "G28 ; sliced-e");
  const repos = store.repositories;
  repos.tasks.update({ ...repos.tasks.getById(gcode.task.id)!, state: "CANCELLED", updatedAt: ISO });

  const record = deviceArtifact(gcode.artifact.id, "UPLOADING");
  assert.match(service.deletionBlocker(gcode.artifact.id) ?? "", /загружается на принтер/);
  await assert.rejects(service.deleteArtifact(gcode.artifact.id), ValidationError);

  // VERIFIED means the bytes are on the printer and no longer need ours; a live
  // placement around them is caught by the assignment rule, not by this one.
  const stored = repos.deviceArtifacts.getById(record.id)!;
  repos.deviceArtifacts.update({ ...stored, state: "VERIFIED", updatedAt: ISO });
  assert.equal(service.deletionBlocker(gcode.artifact.id), null);
  const outcome = await service.deleteArtifact(gcode.artifact.id);
  assert.equal(outcome.blobRemoved, true);
});

test("an unfinished slice still holds its source model", async () => {
  const model = await upload("busy.stl", "solid cube-f");
  const variant = sliceVariant({
    taskId: model.task.id,
    sourceArtifactId: model.artifact.id,
    state: "running"
  });
  assert.match(service.deletionBlocker(model.artifact.id) ?? "", new RegExp(variant.id));
  await assert.rejects(service.deleteArtifact(model.artifact.id), ValidationError);
});

test("an upload deduplicating onto bytes a delete is unlinking keeps its blob", async () => {
  const content = "G28 ; contended-bytes";
  const first = await upload("shared.gcode", content);
  const key = first.artifact.source as string;

  // Hold the unlink open so the two operations really are concurrent, and signal
  // the moment the delete has passed its refcount check and is inside `remove`.
  const realRemove = storage.remove.bind(storage);
  let entered!: () => void;
  const inRemove = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  storage.remove = async (k: string) => {
    entered();
    await gate;
    return realRemove(k);
  };

  const deletion = service.deleteArtifact(first.artifact.id);
  await inRemove;

  // The upload starts while the blob is mid-deletion. Without the per-key lock it
  // would commit (dedup: the file is still there), insert its row, and then have
  // its bytes unlinked out from under it — a DB row pointing at nothing.
  const second = service.ingest({
    source: Readable.from([Buffer.from(content)]),
    fileName: "shared-again.gcode"
  });
  await new Promise((resolve) => setImmediate(resolve));
  release();

  const removed = await deletion;
  const uploaded = await second;
  await service.whenIdle();

  assert.equal(removed.blobRemoved, true, "the first delete did unlink the blob");
  assert.equal(uploaded.artifact.source, key, "the new artifact addresses the same content");
  assert.equal(await storage.exists(key), true, "and its bytes are on disk");
  assert.ok(store.repositories.artifacts.getById(uploaded.artifact.id));
});
