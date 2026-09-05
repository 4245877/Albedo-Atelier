import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";

import { JobError } from "../../core/errors";
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
import { PrintQueueService } from "../printQueue/printQueueService";
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
let queue: PrintQueueService;

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
  queue = new PrintQueueService(store, { now: () => new Date(ISO) });
  service = new ArtifactService(store, storage, {
    limits: LIMITS,
    maxFileBytes: 1 << 20,
    timeoutMs: 2000,
    concurrency: 1,
    analyze: async () => analyzerResult(),
    // Wired exactly as the runtime wires it: a cascading delete borrows the
    // queue's own cancellation instead of writing task rows itself.
    cancelTask: (taskId, reason, actor) => void queue.cancelTask(taskId, reason, actor)
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
  await assert.rejects(service.deleteArtifact(model.artifact.id), JobError);
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

  await assert.rejects(service.deleteArtifact(output.artifact.id), JobError);
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
  await assert.rejects(service.deleteArtifact(output.artifact.id), JobError);
  await assert.rejects(service.deleteArtifact(model.artifact.id), JobError);

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
  await assert.rejects(service.deleteArtifact(gcode.artifact.id), JobError);

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
  await assert.rejects(service.deleteArtifact(model.artifact.id), JobError);
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

/*
 * The far end of "FAILED is history".
 *
 * Retention counts FAILED among the terminal states, so a failed print's file may
 * be deleted — but the task state machine says `FAILED → QUEUED` (a failed print
 * may be retried). Deleting the file nulls `artifact_id` through the foreign key
 * and leaves `source_artifact_id` (which has no key) naming a row that is gone.
 * Re-queuing such a task used to succeed and put a QUEUED row in the queue with
 * nothing to print — and because every downstream identity check reads a missing
 * artifact as "no expectation" rather than "wrong", nothing downstream said so.
 */
test("a failed task whose file was deleted cannot be re-queued — it says why instead", async () => {
  const model = await upload("retry.gcode", "G28 ; retry-me");
  const repos = store.repositories;
  const queue = new PrintQueueService(store, { now: () => new Date(ISO) });

  // The print failed; the task is history as far as retention is concerned.
  repos.tasks.update({ ...repos.tasks.getById(model.task.id)!, state: "FAILED", updatedAt: ISO });
  assert.equal(service.deletionBlocker(model.artifact.id), null, "a failed task does not pin its file");

  await service.deleteArtifact(model.artifact.id);

  const orphaned = repos.tasks.getById(model.task.id)!;
  assert.equal(orphaned.artifactId, null, "the foreign key nulled the executable");
  assert.equal(orphaned.sourceArtifactId, model.artifact.id, "the keyless source column still names it");

  assert.throws(
    () => queue.releaseTask(orphaned.id),
    (e: unknown) => e instanceof JobError && /файл удалён/.test((e as Error).message)
  );
  assert.equal(repos.tasks.getById(orphaned.id)!.state, "FAILED", "the refusal changes nothing");
});

/* A task that legitimately never had an uploaded file is untouched by that rule. */
test("a file-less task still parks and returns to the queue as it always did", () => {
  const queue = new PrintQueueService(store, { now: () => new Date(ISO) });
  const created = queue.createTask({ title: "Ручная работа" }); // no printer, no file
  assert.equal(created.task.state, "NEEDS_REVIEW");
  assert.equal(created.task.artifactId, null);
  assert.equal(created.task.sourceArtifactId, null);

  assert.equal(queue.releaseTask(created.task.id).state, "QUEUED");
});

/*
 * A corrupt row must not become a filesystem primitive.
 *
 * `Artifact.source` is written only by the ingest path, which derives it from a
 * content hash — but deletion READS it back and hands it to the filesystem, so
 * the interesting question is what a row that says something else can make the
 * service unlink. A hand-edited database, a bad restore, a future bug upstream:
 * the answer has to be "nothing", from the storage layer's own key check, not
 * from trusting whoever wrote the row.
 */
test("a corrupt storage key deletes the row and touches nothing on disk", async () => {
  const outside = path.join(dir, "precious.txt");
  fs.writeFileSync(outside, "not yours");
  const repos = store.repositories;

  const evil = {
    id: newId(ID_PREFIX.artifact),
    kind: "gcode" as const,
    name: "evil.gcode",
    // Escapes the store root, and is not a well-formed `sha256/<2>/<64>` key.
    source: `../../${path.basename(dir)}/precious.txt`,
    sizeBytes: 9,
    sha256: "0".repeat(64),
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  repos.artifacts.insert(evil);

  // The row goes (the database is what the operator asked to clean up), the
  // unlink is refused by the key check, and the deletion says the blob stayed
  // rather than claiming a removal that never happened.
  const outcome = await service.deleteArtifact(evil.id);
  assert.equal(outcome.blobRemoved, false, "no unlink may be reported for a key that was refused");
  assert.equal(repos.artifacts.getById(evil.id), null, "the row is gone");
  assert.equal(fs.existsSync(outside), true, "the file outside the store is untouched");
});

test("an absolute path in `source` is refused the same way", async () => {
  const outside = path.join(dir, "absolute.txt");
  fs.writeFileSync(outside, "still not yours");
  const repos = store.repositories;

  const evil = {
    id: newId(ID_PREFIX.artifact),
    kind: "gcode" as const,
    name: "abs.gcode",
    source: outside,
    sizeBytes: 15,
    sha256: "1".repeat(64),
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  repos.artifacts.insert(evil);

  const outcome = await service.deleteArtifact(evil.id);
  assert.equal(outcome.blobRemoved, false);
  assert.equal(fs.existsSync(outside), true, "an absolute path is not a storage key");
});

/*
 * ── Каскадное удаление ───────────────────────────────────────────────────────
 *
 * Всё выше описывает файл, который трогать НЕЛЬЗЯ. Здесь — обратный случай, с
 * которого начинается работа оператора: модель больше не нужна, и её надо убрать
 * целиком, вместе со строкой планировщика. Без каскада это был тупик: «удалить
 * файл» отвечало 409 «его использует задание QUEUED», а убрать само задание из
 * раздела файлов было нечем — оператор оставался с файлом, который не удаляется,
 * и заданием, которое печатать нечего.
 *
 * Граница каскада намеренно совпадает с той, что очередь уже проводит для
 * «убрать строку»: планирование отменяется, физика — нет. Эти тесты закрепляют
 * и то, что каскад делает, и — важнее — то, чего он не делает и в каком порядке
 * отказывается.
 */

/** Задание планировщика поверх загруженного файла: QUEUED + строка очереди WAITING. */
function scheduled(artifactId: string, title = "3U-default") {
  return queue.addTask({ title, artifactId });
}

test("файл больше не нужен: каскад отменяет задание планировщика и удаляет файл", async () => {
  const model = await upload("3U-default.3mf", "3mf ; no longer needed");
  const planned = scheduled(model.artifact.id);
  const repos = store.repositories;

  // Ровно тот тупик, ради которого каскад и появился: обычное удаление отказывает…
  const hold = service.deletionHold(model.artifact.id);
  assert.match(hold.reason ?? "", /QUEUED/);
  await assert.rejects(service.deleteArtifact(model.artifact.id), JobError);
  // …но отказ теперь называет, что именно держит файл и что можно отменить.
  assert.equal(hold.cascadable, true);
  assert.deepEqual(
    hold.tasks.map((t) => t.id),
    [planned.task.id]
  );

  const outcome = await service.deleteArtifact(model.artifact.id, { cascade: true });

  assert.deepEqual(outcome.cancelledTasks, [planned.task.id]);
  assert.equal(outcome.blobRemoved, true);
  assert.equal(repos.artifacts.getById(model.artifact.id), null, "файла больше нет");
  assert.equal(repos.tasks.getById(planned.task.id)!.state, "CANCELLED", "и задания в очереди тоже");
  // «Висячей» строки не остаётся: запись очереди освобождена, а не брошена
  // указывать на задание, которому нечего печатать.
  assert.equal(repos.queue.findByTaskId(planned.task.id)!.state, "RELEASED");
  assert.equal(queue.listOpenQueue().length, 0, "планировщик пуст");

  // Черновик загрузки отменяется как и прежде — каскад его не касается.
  assert.equal(repos.tasks.getById(model.task.id)!.state, "CANCELLED");
  assert.deepEqual(outcome.cancelledTasks, [planned.task.id], "черновик не считается отменённым каскадом");
});

test("удаление файла записано в аудит вместе с отменённым заданием", async () => {
  const model = await upload("audited.3mf", "3mf ; audited");
  const planned = scheduled(model.artifact.id, "Аудируемое");

  await service.deleteArtifact(model.artifact.id, { cascade: true });

  const deleted = store.repositories.audit
    .listByEntity("artifact", model.artifact.id)
    .find((e) => e.action === "deleted");
  assert.ok(deleted, "удаление файла записано");
  assert.deepEqual(deleted!.detail?.cancelledTasks, [planned.task.id]);
  // Задание тоже рассказывает свою половину истории — через обычный cancelTask.
  assert.ok(
    store.repositories.audit
      .listByEntity("print_task", planned.task.id)
      .some((e) => e.action === "cancelled"),
    "отмена задания записана очередью, а не в обход неё"
  );
});

/*
 * Печать — не строка в базе. DISPATCHING означает, что файл уже уехал на
 * принтер, PRINTING — что по нему ведут соплом; отменяют такое на устройстве, а
 * не удалением байтов из-под работающей печати. Каскад здесь обязан отказать
 * ровно так же, как обычное удаление, и ничего не отменить по дороге.
 */
for (const state of ["DISPATCHING", "PRINTING"] as const) {
  test(`каскад не отменяет печать: задание в ${state} отказывает и остаётся на месте`, async () => {
    const gcode = await upload(`live-${state}.gcode`, `G28 ; live-${state}`);
    const planned = scheduled(gcode.artifact.id, `Печатается ${state}`);
    const repos = store.repositories;
    repos.tasks.update({ ...repos.tasks.getById(planned.task.id)!, state, updatedAt: ISO });

    const hold = service.deletionHold(gcode.artifact.id);
    assert.match(hold.reason ?? "", new RegExp(state));
    assert.equal(hold.cascadable, false, "такое не предлагают отменить");
    assert.deepEqual(hold.tasks, [], "и не называют отменяемым");

    await assert.rejects(service.deleteArtifact(gcode.artifact.id, { cascade: true }), JobError);
    assert.ok(repos.artifacts.getById(gcode.artifact.id), "файл на месте");
    assert.equal(repos.tasks.getById(planned.task.id)!.state, state, "задание не тронуто");
    assert.equal(repos.queue.findByTaskId(planned.task.id)!.state, "WAITING", "и очередь тоже");
  });
}

/*
 * Самое дорогое свойство каскада — порядок отказа.
 *
 * Файл может держаться сразу за несколько краёв графа: отменяемое задание И
 * загрузка байтов на принтер. Если сначала отменить то, что отменяется, и только
 * потом обнаружить непреодолимое, оператор получит 409 — и очередь, из которой
 * уже пропало задание, хотя файл остался. Отказ обязан случиться ДО первой
 * отмены.
 */
test("жёсткая блокировка позади отменяемой: отказ до единой отмены", async () => {
  const gcode = await upload("contended.gcode", "G28 ; contended");
  const planned = scheduled(gcode.artifact.id, "Ждёт в очереди");
  const repos = store.repositories;
  // Байты уже текут на принтер — этого каскад отменить не может.
  deviceArtifact(gcode.artifact.id, "UPLOADING");

  const hold = service.deletionHold(gcode.artifact.id);
  assert.match(hold.reason ?? "", /загружается на принтер/, "жёсткая причина вытесняет отменяемую");
  assert.equal(hold.cascadable, false);

  await assert.rejects(service.deleteArtifact(gcode.artifact.id, { cascade: true }), JobError);

  assert.ok(repos.artifacts.getById(gcode.artifact.id), "файл на месте");
  assert.equal(repos.tasks.getById(planned.task.id)!.state, "QUEUED", "задание НЕ отменено");
  assert.equal(repos.queue.findByTaskId(planned.task.id)!.state, "WAITING");
});

/*
 * Каскад не пишет строки состояний сам — он вызывает тот же `cancelTask`, что и
 * «убрать из очереди». Здесь это проверяется по следам, которые оставляет только
 * он: размотанное назначение и освобождённая строка очереди.
 */
test("каскад разматывает назначение через очередь, а не отменяет задание в обход", async () => {
  const gcode = await upload("placed.gcode", "G28 ; placed");
  const planned = scheduled(gcode.artifact.id, "Размещено");
  const repos = store.repositories;
  const placement = assignment({
    taskId: planned.task.id,
    state: "RESERVED",
    artifactId: gcode.artifact.id
  });

  const hold = service.deletionHold(gcode.artifact.id);
  assert.equal(hold.cascadable, true, "резерв снимается вместе с заданием");
  assert.deepEqual(hold.tasks.map((t) => t.id), [planned.task.id], "и держит его одно задание");

  const outcome = await service.deleteArtifact(gcode.artifact.id, { cascade: true });

  assert.deepEqual(outcome.cancelledTasks, [planned.task.id]);
  assert.equal(repos.assignments.getById(placement.id)!.state, "CANCELLED", "назначение размотано");
  assert.equal(repos.queue.findByTaskId(planned.task.id)!.state, "RELEASED");
  assert.equal(repos.artifacts.getById(gcode.artifact.id), null);
});

/*
 * Назначение, чьё задание уже история, отменить нечем: у терминального состояния
 * нет исходящих переходов. Такой файл держится намертво — и каскад обязан это
 * признать, а не пытаться.
 */
test("живое назначение на завершённом задании каскаду не поддаётся", async () => {
  const gcode = await upload("stuck.gcode", "G28 ; stuck");
  const repos = store.repositories;
  const planned = scheduled(gcode.artifact.id, "Уже завершено");
  repos.tasks.update({ ...repos.tasks.getById(planned.task.id)!, state: "COMPLETED", updatedAt: ISO });
  assignment({ taskId: planned.task.id, state: "RESERVED", artifactId: gcode.artifact.id });

  assert.equal(service.deletionHold(gcode.artifact.id).cascadable, false);
  await assert.rejects(service.deleteArtifact(gcode.artifact.id, { cascade: true }), JobError);
  assert.ok(repos.artifacts.getById(gcode.artifact.id));
});

/*
 * Модель, из которой уже нарезано и поставлено в очередь задание, держится через
 * ДВА края сразу: собственную колонку `source_artifact_id` и slice-вариант, на
 * котором стоит задание. Отменяется при этом одно задание — один раз.
 */
test("каскад по исходной модели отменяет задание один раз и уносит её вариант", async () => {
  const model = await upload("source.stl", "solid cascade-source");
  const output = await upload("source.gcode", "G28 ; cascade-source");
  const variant = sliceVariant({
    taskId: model.task.id,
    sourceArtifactId: model.artifact.id,
    outputArtifactId: output.artifact.id
  });
  promote(model.task.id, variant, "QUEUED");
  const repos = store.repositories;

  const hold = service.deletionHold(model.artifact.id);
  assert.equal(hold.cascadable, true);
  assert.deepEqual(hold.tasks.map((t) => t.id), [model.task.id], "две зацепки — одно задание");

  const outcome = await service.deleteArtifact(model.artifact.id, { cascade: true });

  assert.deepEqual(outcome.cancelledTasks, [model.task.id]);
  assert.deepEqual(outcome.removedSliceVariants, [variant.id]);
  assert.equal(repos.tasks.getById(model.task.id)!.state, "CANCELLED");
  // Нарезанный G-code — отдельный файл и отдельное решение оператора.
  assert.ok(repos.artifacts.getById(output.artifact.id), "G-code остаётся");
});

/*
 * Каскад — осознанное действие оператора, а не новое поведение старого вызова.
 * Тот же `deleteArtifact` вызывает и автоматическая уборка по retention; если бы
 * каскад был поведением по умолчанию, ночная уборка отменяла бы задания очереди.
 */
test("без флага удаление отказывает как прежде, и уборка ничего не отменяет", async () => {
  const gcode = await upload("swept.gcode", "G28 ; swept");
  const planned = scheduled(gcode.artifact.id, "Стоит в очереди");
  const repos = store.repositories;

  await assert.rejects(service.deleteArtifact(gcode.artifact.id), JobError);
  assert.ok(repos.artifacts.getById(gcode.artifact.id));

  // Черновик загрузки уборка отсеивает раньше всех проверок («только ручное
  // удаление»), а интересна здесь следующая за ним — та, что видит очередь.
  queue.cancelTask(gcode.task.id, "черновик не нужен");

  const swept = await service.retentionSweep({ olderThanDays: 0, dryRun: false });
  assert.deepEqual(swept.deleted, [], "уборка ничего не удалила");
  assert.equal(repos.tasks.getById(planned.task.id)!.state, "QUEUED", "и ничего не отменила");
  assert.ok(
    swept.skipped.some((s) => s.id === gcode.artifact.id && /QUEUED/.test(s.reason)),
    "а честно назвала причину пропуска"
  );
});

/*
 * Каскад без подключённой очереди не может состояться. Молчаливое «ну и ладно»
 * здесь — худший исход: файл был бы удалён, а задание осталось бы в очереди
 * указывать на исчезнувшие байты, то есть ровно та висячая строка, против
 * которой каскад и сделан.
 */
test("каскад без подключённой очереди отказывает, а не удаляет молча", async () => {
  const unwired = new ArtifactService(store, storage, {
    limits: LIMITS,
    maxFileBytes: 1 << 20,
    timeoutMs: 2000,
    concurrency: 1,
    analyze: async () => analyzerResult()
  });
  try {
    const gcode = await upload("unwired.gcode", "G28 ; unwired");
    const planned = scheduled(gcode.artifact.id, "Без очереди");

    await assert.rejects(unwired.deleteArtifact(gcode.artifact.id, { cascade: true }), JobError);
    assert.ok(store.repositories.artifacts.getById(gcode.artifact.id), "файл на месте");
    assert.equal(store.repositories.tasks.getById(planned.task.id)!.state, "QUEUED");
  } finally {
    unwired.close();
  }
});
