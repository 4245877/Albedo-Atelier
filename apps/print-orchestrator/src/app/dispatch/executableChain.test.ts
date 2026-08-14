import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { JobError } from "../../core/errors";
import { REASON } from "../../domain/dispatch/reasons";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { Artifact, ArtifactAnalysis, PrintTask } from "../../domain/print/types";
import type { ProfileRevision, ProfileSet, ProfileType, SliceVariant } from "../../domain/slicing/types";
import { openPrintQueueStore } from "../../infra/db/store";
import type { PrinterConfig } from "../../infra/printers/config";
import { buildDeviceFileName, type PrinterFilesListing } from "../../infra/printers/files";
import { ArtifactStorage } from "../../infra/storage/artifactStorage";
import { ANALYZER_VERSION } from "../artifacts/analyzers";
import { PrintQueueService } from "../printQueue/printQueueService";
import { SchedulerContext } from "../scheduling/context";
import { EligibilityQueries } from "../scheduling/eligibility";
import { EvidenceResolver } from "../scheduling/evidence";
import type { SchedulerPrinterRef } from "../scheduling/types";
import { DeviceArtifactService } from "./deviceArtifactService";
import { DispatchService, type DispatchDeps } from "./dispatchService";

/*
 * The end-to-end executable chain, over a real in-memory SQLite store and fake
 * adapters — no network, no device:
 *
 *   slice → queue (promote) → manual assignment → device file → eligibility
 *          → startAssignment → run
 *
 * Every test here targets a gap the audit found: a manual assignment that could
 * never be started, a plan/assignment that carried no executable identity, a
 * file that nothing ever delivered, and start paths that could diverge.
 */

const GCODE = Buffer.from(
  ";FLAVOR:Klipper\n;printer_model = Creality K2\nG28\nG1 X10 Y10 E1 F1200\nM104 S0\n",
  "utf8"
);
const GCODE_SHA = createHash("sha256").update(GCODE).digest("hex");
const ISO = "2026-07-26T12:00:00.000Z";
/** The on-device name promotion generates for that artifact (stem + content hash). */
const DEVICE_FILE = buildDeviceFileName({ name: "cube.gcode", sha256: GCODE_SHA });

/** k2 speaks Moonraker (upload + listing); ender-ws is Creality WS (neither). */
const PRINTERS: PrinterConfig[] = [
  {
    id: "k2",
    name: "Creality K2",
    model: "Creality K2",
    type: "FDM",
    protocol: "moonraker",
    host: "127.0.0.1",
    material: "PLA",
    enabled: true
  },
  {
    id: "ender-ws",
    name: "Creality Ender 3 V3 KE",
    model: "Ender 3 V3 KE",
    type: "FDM",
    // The farm's remaining adapter with NO file API at all. (Bambu used to play
    // this role; it now uploads over FTPS, so the manual-transfer path is
    // exercised against the protocol that genuinely still needs it.)
    protocol: "creality",
    host: "127.0.0.2",
    material: "PLA",
    enabled: true
  }
] as unknown as PrinterConfig[];

interface Harness {
  store: PrintQueueStore;
  queue: PrintQueueService;
  devices: DeviceArtifactService;
  dispatch: DispatchService;
  /** Files the fake device "holds", per printer — what the listing returns. */
  onDevice: Map<string, { path: string; size: number }[]>;
  uploads: { printerId: string; remotePath: string; size: number }[];
  startCalls: { printerId: string; file: string }[];
  /** Forces the next upload to fail, like a device refusing the transfer. */
  failUpload: boolean;
}

let TMP: string;
let h: Harness;

beforeEach(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "exec-chain-"));
  h = await makeHarness(TMP);
});

afterEach(() => {
  h.store.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function makeHarness(tmp: string): Promise<Harness> {
  const store = openPrintQueueStore(":memory:");
  const storage = new ArtifactStorage({ root: path.join(tmp, "artifacts") });
  await storage.init();

  const onDevice = new Map<string, { path: string; size: number }[]>();
  const uploads: Harness["uploads"] = [];
  const startCalls: Harness["startCalls"] = [];
  const queue = new PrintQueueService(store, {
    now: () => new Date(ISO),
    isPrinterConfigured: (id) => PRINTERS.some((p) => p.id === id)
  });

  const listFiles = async (printer: PrinterConfig, dir: string): Promise<PrinterFilesListing> => ({
    path: dir,
    entries: (onDevice.get(printer.id) ?? []).map((f) => ({
      name: f.path.split("/").pop() ?? f.path,
      path: f.path,
      type: "file" as const,
      size: f.size,
      printable: true
    }))
  });

  const state = { failUpload: false };
  const devices = new DeviceArtifactService({
    store,
    storage,
    resolvePrinter: (id) => PRINTERS.find((p) => p.id === id),
    listFiles,
    uploadFile: async (printer, remotePath, bytes) => {
      if (state.failUpload) throw new Error("устройство отклонило загрузку");
      uploads.push({ printerId: printer.id, remotePath, size: bytes.byteLength });
      const files = onDevice.get(printer.id) ?? [];
      onDevice.set(printer.id, [
        ...files.filter((f) => f.path !== remotePath),
        { path: remotePath, size: bytes.byteLength }
      ]);
      return { remotePath, sizeBytes: bytes.byteLength };
    },
    now: () => new Date(ISO)
  });

  const refs = (): SchedulerPrinterRef[] =>
    PRINTERS.map((p) => ({
      id: p.id,
      name: p.name,
      model: p.model,
      protocol: p.protocol,
      printerClass: null,
      material: p.material,
      nozzleMm: 0.4,
      buildVolume: { x: 350, y: 350, z: 350 },
      online: true,
      status: "idle" as const,
      remoteStartSupported: true,
      ams: null,
      faults: [],
      mediaPresent: null,
      telemetryAgeMs: 1_000,
      materialRemainingSufficient: null,
      printingTimeLeftMs: null,
      activeRunState: null
    }));

  const eligibility = (): EligibilityQueries => {
    const ctx = new SchedulerContext(store, refs, {
      now: () => new Date(ISO),
      runtimeAvailable: true,
      nightSafetyBufferRatio: 0.2,
      nightWindow: "21:30 – 07:30",
      farmTimeZone: "UTC",
      compatibility: { telemetryStaleMs: 120_000 },
      unknownEtaAssumptionS: 4 * 3600
    });
    return new EligibilityQueries(ctx, new EvidenceResolver(ctx));
  };

  const deps: DispatchDeps = {
    store,
    resolvePrinter: (ref) => {
      const wanted = ref.trim().toLowerCase();
      return PRINTERS.find((p) => p.id.toLowerCase() === wanted || p.name.toLowerCase() === wanted);
    },
    getStatus: () => undefined,
    startPhysical: async (printerId, file) => void startCalls.push({ printerId, file }),
    classifyError: () => "unknown",
    listFiles,
    evaluateEligibility: (input) => eligibility().evaluate(input),
    now: () => new Date(ISO)
  };

  const harness: Harness = {
    store,
    queue,
    devices,
    dispatch: new DispatchService(deps),
    onDevice,
    uploads,
    startCalls,
    get failUpload() {
      return state.failUpload;
    },
    set failUpload(v: boolean) {
      state.failUpload = v;
    }
  };
  // Write the blob the upload path reads.
  const key = `sha256/${GCODE_SHA.slice(0, 2)}/${GCODE_SHA}`;
  const blobPath = storage.resolvePath(key);
  fs.mkdirSync(path.dirname(blobPath), { recursive: true });
  fs.writeFileSync(blobPath, GCODE);
  return harness;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function revision(type: ProfileType, name: string, settings: Record<string, unknown>): ProfileRevision {
  const raw = JSON.stringify({ name, type, ...settings });
  const rev: ProfileRevision = {
    id: newId(ID_PREFIX.profileRevision),
    logicalId: `${type}:${name}`,
    type,
    name,
    inherits: null,
    status: "active",
    rawJson: raw,
    rawSha256: `${name}-${Math.random()}`,
    resolvedJson: raw,
    resolvedSha256: `${name}-resolved`,
    orcaVersion: "2.3.0",
    source: null,
    warnings: [],
    blockers: [],
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {}
  };
  h.store.repositories.profileRevisions.insert(rev);
  return rev;
}

/**
 * A DRAFT task with a source model and a `ready` slice variant whose verified
 * G-code output is analysed `schedulable` — the state the slicing tab hands to
 * "добавить в очередь".
 */
function seedReadySlice(targetPrinterId = "k2"): {
  task: PrintTask;
  variant: SliceVariant;
  output: Artifact;
  set: ProfileSet;
} {
  const repos = h.store.repositories;
  // The flavor must match the firmware family, or the dispatch (correctly)
  // refuses to hand the file to it.
  const declaredFlavor = targetPrinterId === "ender-ws" ? "marlin" : "klipper";
  const source: Artifact = {
    id: newId(ID_PREFIX.artifact),
    kind: "model",
    name: "cube.stl",
    source: "sha256/aa/source",
    sizeBytes: 134,
    sha256: "a".repeat(64),
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  const output: Artifact = {
    id: newId(ID_PREFIX.artifact),
    kind: "gcode",
    name: "cube.gcode",
    source: `sha256/${GCODE_SHA.slice(0, 2)}/${GCODE_SHA}`,
    sizeBytes: GCODE.byteLength,
    sha256: GCODE_SHA,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  repos.artifacts.insert(source);
  repos.artifacts.insert(output);

  const analysis: ArtifactAnalysis = {
    id: newId(ID_PREFIX.artifactAnalysis),
    artifactId: output.id,
    state: "ready",
    detectedFormat: "gcode",
    verdict: "schedulable",
    analyzer: "gcode",
    analyzerVersion: ANALYZER_VERSION,
    estimatedDurationS: 3600,
    estimatedFilamentG: 20,
    material: "PLA",
    nozzleDiameterMm: 0.4,
    layerHeightMm: 0.2,
    warnings: [],
    blockers: [],
    // The file declares the machine it was sliced for — the dispatch refuses to
    // send it anywhere else, so the fixture must declare the real target.
    data: {
      size: [100, 100, 100],
      flavor: declaredFlavor,
      printerModel: PRINTERS.find((p) => p.id === targetPrinterId)?.model ?? targetPrinterId
    },
    error: null,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {}
  };
  repos.artifactAnalyses.insert(analysis);

  const machine = revision("machine", `${targetPrinterId} 0.4`, {
    nozzle_diameter: ["0.4"],
    printer_model: PRINTERS.find((p) => p.id === targetPrinterId)?.model ?? targetPrinterId,
    gcode_flavor: declaredFlavor,
    printable_area: ["0x0", "300x0", "300x300", "0x300"],
    printable_height: "300"
  });
  const process = revision("process", "K2 0.2", { layer_height: "0.2" });
  const filament = revision("filament", "PLA @K2", { filament_type: ["PLA"] });

  const set: ProfileSet = {
    id: newId(ID_PREFIX.profileSet),
    name: "K2 · PLA",
    machineRevisionId: machine.id,
    processRevisionId: process.id,
    filamentRevisionId: filament.id,
    printerId: targetPrinterId,
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
  repos.profileSets.insert(set);

  const task: PrintTask = {
    id: newId(ID_PREFIX.printTask),
    artifactId: source.id,
    sliceVariantId: null,
    sourceArtifactId: source.id,
    onDeviceFile: null,
    title: "Cube",
    material: "PLA",
    targetPrinter: null,
    priority: 0,
    state: "DRAFT",
    reason: null,
    night: false,
    notBefore: null,
    deadline: null,
    dayNightPreference: "any",
    pinnedPrinterId: null,
    unattendedAllowed: false,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  repos.tasks.insert(task);

  const variant: SliceVariant = {
    id: newId(ID_PREFIX.sliceVariant),
    taskId: task.id,
    sourceArtifactId: source.id,
    profileSetId: set.id,
    targetPrinterId,
    targetPrinterClass: null,
    state: "ready",
    cacheKey: `ck_${task.id}`,
    orcaVersion: "2.3.0",
    workerVersion: "1",
    outputArtifactId: output.id,
    outputAnalysisId: analysis.id,
    orcaEtaS: 3600,
    filamentG: 20,
    filamentMm: 1000,
    dimensions: { size: [100, 100, 100] },
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
  repos.sliceVariants.insert(variant);
  return { task, variant, output, set };
}

// ── slice → queue ────────────────────────────────────────────────────────────

test("promotion binds the queue to the EXACT slice, artifact hash and profile set", () => {
  const { task, variant, output, set } = seedReadySlice();
  const detail = h.queue.promoteSliceVariant(variant.id);

  assert.equal(detail.task.state, "QUEUED");
  assert.equal(detail.task.sliceVariantId, variant.id, "the exact slice, not a file name");
  assert.equal(detail.task.artifactId, output.id);
  assert.equal(detail.task.sourceArtifactId, task.sourceArtifactId);
  // The device name carries the content identity: two models called "cube" can
  // never collide on one printer slot and overwrite each other's bytes.
  assert.equal(detail.task.onDeviceFile, DEVICE_FILE);
  assert.ok(DEVICE_FILE.includes(GCODE_SHA.slice(0, 8)), "the name encodes the artifact hash");
  assert.equal(detail.task.pinnedPrinterId, "k2", "printer-scoped slice pins its printer");
  assert.equal(detail.queueEntry?.state, "WAITING");

  // The profile revisions are recoverable from the binding, not from a metadata blob.
  const assignment = h.queue.assignTask(detail.task.id, "k2");
  assert.equal(assignment.binding.machineRevisionId, set.machineRevisionId);
  assert.equal(assignment.binding.processRevisionId, set.processRevisionId);
  assert.equal(assignment.binding.filamentRevisionId, set.filamentRevisionId);
  assert.equal(assignment.binding.artifactSha256, GCODE_SHA);
  assert.equal(assignment.binding.etaS, 3600);
  assert.equal(assignment.binding.gcodeFlavor, "klipper");
  assert.equal(assignment.binding.nozzleMm, 0.4);
});

test("promotion is idempotent — a repeat creates no second queue entry and no second version", () => {
  const { variant } = seedReadySlice();
  const first = h.queue.promoteSliceVariant(variant.id);
  const second = h.queue.promoteSliceVariant(variant.id);

  assert.equal(second.task.version, first.task.version, "the repeat did not write");
  assert.equal(second.queueEntry?.id, first.queueEntry?.id);
  assert.equal(
    h.store.repositories.queue.listOpen().filter((e) => e.taskId === first.task.id).length,
    1
  );
});

test("an unfinished slice is refused (nothing unverified reaches the queue)", () => {
  const { variant } = seedReadySlice();
  const repos = h.store.repositories;
  repos.sliceVariants.update({ ...variant, state: "pending", outputArtifactId: null, updatedAt: ISO });

  assert.throws(() => h.queue.promoteSliceVariant(variant.id), JobError);
});

test("a slice whose output analysis is blocked is refused", () => {
  const { variant, output } = seedReadySlice();
  const repos = h.store.repositories;
  const analysis = repos.artifactAnalyses.latestForArtifact(output.id)!;
  repos.artifactAnalyses.update({
    ...analysis,
    verdict: "blocked",
    blockers: [{ code: "forbidden_command", message: "M502 в start G-code" }],
    updatedAt: ISO
  });

  assert.throws(
    () => h.queue.promoteSliceVariant(variant.id),
    (e: unknown) => e instanceof JobError && /непроверенный файл/.test(e.message)
  );
});

// ── manual assignment → device file → start ──────────────────────────────────

/** The full happy path a supported (Moonraker) printer takes. */
async function promoteAssignPrepare(): Promise<{ taskId: string; assignmentId: string }> {
  const { variant } = seedReadySlice();
  const detail = h.queue.promoteSliceVariant(variant.id);
  const assignment = h.queue.assignTask(detail.task.id, "k2", { reason: "свободен" });
  const prepared = await h.devices.prepare(assignment.id);
  assert.equal(prepared.ready, true);
  return { taskId: detail.task.id, assignmentId: assignment.id };
}

test("a manually assigned task is startable by the canonical operation (no dead end)", async () => {
  const { taskId, assignmentId } = await promoteAssignPrepare();

  const result = await h.dispatch.startAssignment(assignmentId);

  assert.equal(result.printerId, "k2");
  assert.equal(result.assignmentId, assignmentId, "the SAME assignment was executed, not a new one");
  assert.equal(h.startCalls.length, 1);
  assert.equal(h.startCalls[0].file, DEVICE_FILE);

  // Exactly one assignment ever existed for the task — the start consumed it.
  const assignments = h.store.repositories.assignments.listByTask(taskId);
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].state, "ACTIVE");

  // The run traces back to the assignment and carries the artifact identity.
  const run = h.store.repositories.printRuns.getById(result.runId)!;
  assert.equal(run.assignmentId, assignmentId);
  assert.equal(run.artifactSha256, GCODE_SHA);
  assert.equal(run.state, "RUNNING");
});

test("startAssignment uses the assignment's printer even when the task is re-pinned elsewhere", async () => {
  const { taskId, assignmentId } = await promoteAssignPrepare();
  // Somebody re-pins the task to the Bambu after the placement was made.
  h.queue.pinPrinter(taskId, "ender-ws");

  await assert.rejects(
    h.dispatch.startAssignment(assignmentId),
    (e: unknown) => e instanceof JobError && /расхождение назначения/.test(e.message)
  );
  assert.equal(h.startCalls.length, 0, "no printer was silently substituted");
});

test("an idempotent retry returns the same run instead of a second physical start", async () => {
  const { assignmentId } = await promoteAssignPrepare();

  const first = await h.dispatch.startAssignment(assignmentId, { idempotencyKey: "op-1" });
  const second = await h.dispatch.startAssignment(assignmentId, { idempotencyKey: "op-1" });

  assert.equal(second.runId, first.runId);
  assert.equal(second.deduplicated, true);
  assert.equal(h.startCalls.length, 1, "only one command reached the device");
});

test("an active run blocks a second start of the same assignment", async () => {
  const { assignmentId } = await promoteAssignPrepare();
  await h.dispatch.startAssignment(assignmentId);

  await assert.rejects(h.dispatch.startAssignment(assignmentId), JobError);
  assert.equal(h.startCalls.length, 1);
});

test("an invalidated assignment is never executed", async () => {
  const { assignmentId } = await promoteAssignPrepare();
  h.queue.invalidateAssignment(assignmentId, "оператор отозвал назначение");

  await assert.rejects(
    h.dispatch.startAssignment(assignmentId),
    (e: unknown) =>
      e instanceof JobError &&
      (e.details as { blockers?: { code: string }[] }).blockers?.[0]?.code === REASON.ASSIGNMENT_STALE
  );
  assert.equal(h.startCalls.length, 0);
});

test("a slice-variant divergence blocks the start (the binding no longer describes the task)", async () => {
  const { assignmentId, taskId } = await promoteAssignPrepare();
  const repos = h.store.repositories;
  const task = repos.tasks.getById(taskId)!;
  // The task is re-pointed at a different slice behind the assignment's back.
  repos.tasks.update({ ...task, sliceVariantId: "slc_other", updatedAt: ISO });

  await assert.rejects(
    h.dispatch.startAssignment(assignmentId),
    (e: unknown) => e instanceof JobError && /больше не соответствует заданию/.test(e.message)
  );
  assert.equal(h.startCalls.length, 0);
});

test("a quarantined profile revision blocks the start of an already-bound assignment", async () => {
  const { assignmentId } = await promoteAssignPrepare();
  const repos = h.store.repositories;
  const assignment = repos.assignments.getById(assignmentId)!;
  const machine = repos.profileRevisions.getById(assignment.binding.machineRevisionId!)!;
  repos.profileRevisions.update({ ...machine, status: "quarantined", updatedAt: ISO });

  await assert.rejects(
    h.dispatch.startAssignment(assignmentId),
    (e: unknown) =>
      e instanceof JobError &&
      (e.details as { blockers?: { code: string }[] }).blockers?.[0]?.code ===
        REASON.PROFILE_REVISION_MISMATCH
  );
  assert.equal(h.startCalls.length, 0);
});

// ── device file preparation ──────────────────────────────────────────────────

test("prepare uploads the file and verifies it by name and size (never a fake hash check)", async () => {
  const { variant } = seedReadySlice();
  const detail = h.queue.promoteSliceVariant(variant.id);
  const assignment = h.queue.assignTask(detail.task.id, "k2");

  const prepared = await h.devices.prepare(assignment.id);

  assert.equal(prepared.deviceArtifact.state, "VERIFIED");
  assert.equal(prepared.deviceArtifact.transferMode, "adapter_upload");
  assert.equal(
    prepared.deviceArtifact.verification,
    "name_and_size",
    "the strongest identity Moonraker offers — recorded honestly"
  );
  assert.equal(prepared.deviceArtifact.artifactSha256, GCODE_SHA);
  assert.equal(prepared.manualInstruction, null);
  assert.equal(h.uploads.length, 1);
  assert.equal(h.uploads[0].size, GCODE.byteLength);
});

test("preparing twice re-uploads nothing (idempotent delivery)", async () => {
  const { variant } = seedReadySlice();
  const detail = h.queue.promoteSliceVariant(variant.id);
  const assignment = h.queue.assignTask(detail.task.id, "k2");

  const first = await h.devices.prepare(assignment.id);
  const second = await h.devices.prepare(assignment.id);

  assert.equal(h.uploads.length, 1, "the second prepare sent nothing");
  assert.equal(second.deviceArtifact.id, first.deviceArtifact.id);
  assert.equal(second.deviceArtifact.version, first.deviceArtifact.version);
});

test("a failed upload marks the file FAILED and leaves the assignment un-started", async () => {
  const { variant } = seedReadySlice();
  const detail = h.queue.promoteSliceVariant(variant.id);
  const assignment = h.queue.assignTask(detail.task.id, "k2");
  h.failUpload = true;

  const prepared = await h.devices.prepare(assignment.id);
  // FAILED, not INVALID: the *transfer* did not complete (and the device listing
  // confirmed the file is not there), which is a different retry story from
  // "the bytes on the device are not the artifact's".
  assert.equal(prepared.deviceArtifact.state, "FAILED");
  assert.match(prepared.deviceArtifact.lastError ?? "", /отклонило загрузку/);
  assert.equal(prepared.ready, false);
  assert.equal(
    h.store.repositories.assignments.getById(assignment.id)?.state,
    "PROPOSED",
    "a failed transfer never advances the assignment"
  );

  await assert.rejects(h.dispatch.startAssignment(assignment.id), JobError);
  assert.equal(h.startCalls.length, 0);

  // A retry after the device recovers succeeds — the INVALID state is recoverable.
  h.failUpload = false;
  const retried = await h.devices.prepare(assignment.id);
  assert.equal(retried.deviceArtifact.state, "VERIFIED");
});

test("an adapter without upload demands a named manual transfer and blocks until confirmed", async () => {
  const { variant } = seedReadySlice("ender-ws");
  const detail = h.queue.promoteSliceVariant(variant.id);
  const assignment = h.queue.assignTask(detail.task.id, "ender-ws");

  const prepared = await h.devices.prepare(assignment.id);
  assert.equal(prepared.deviceArtifact.transferMode, "manual_file_transfer");
  assert.equal(prepared.deviceArtifact.state, "NOT_PRESENT");
  assert.equal(prepared.ready, false);
  assert.match(prepared.manualInstruction ?? "", /Скопируйте файл/);
  assert.equal(h.uploads.length, 0, "no pretend upload was attempted");

  await assert.rejects(
    h.dispatch.startAssignment(assignment.id),
    (e: unknown) =>
      e instanceof JobError &&
      (e.details as { blockers?: { code: string }[] }).blockers?.some(
        (b) => b.code === REASON.DEVICE_TRANSFER_NOT_CONFIRMED
      ) === true
  );

  const confirmed = await h.devices.confirmManualTransfer(assignment.id, "Миха");
  // No file API at all: the named confirmation IS the verification, and it is
  // recorded as exactly that — never dressed up as a device-side check.
  assert.equal(confirmed.deviceArtifact.state, "VERIFIED");
  assert.equal(confirmed.deviceArtifact.verification, "operator_confirmed");
  assert.equal(confirmed.deviceArtifact.confirmedBy, "Миха");

  const result = await h.dispatch.startAssignment(assignment.id);
  assert.equal(result.printerId, "ender-ws");
});

test("a manual-transfer printer stays blocked for an UNATTENDED start even after confirmation", async () => {
  const { variant, task } = seedReadySlice("ender-ws");
  const detail = h.queue.promoteSliceVariant(variant.id);
  const repos = h.store.repositories;
  const queued = repos.tasks.getById(detail.task.id)!;
  repos.tasks.update({ ...queued, night: true, unattendedAllowed: true, updatedAt: ISO });
  void task;

  const assignment = h.queue.assignTask(detail.task.id, "ender-ws");
  await h.devices.confirmManualTransfer(assignment.id, "Миха");

  await assert.rejects(
    h.dispatch.startAssignment(assignment.id, { mode: "night" }),
    (e: unknown) => e instanceof JobError
  );
  assert.equal(h.startCalls.length, 0, "unattended automation for a manual-only adapter stays off");
});

// ── queue changes invalidate a placement ─────────────────────────────────────

test("changing scheduling parameters invalidates a not-yet-started placement", () => {
  const { variant } = seedReadySlice();
  const detail = h.queue.promoteSliceVariant(variant.id);
  const assignment = h.queue.assignTask(detail.task.id, "k2");

  h.queue.setTaskScheduling(detail.task.id, { priority: 7 });

  const after = h.store.repositories.assignments.getById(assignment.id)!;
  assert.ok(after.invalidatedAt, "the placement no longer matches the queue it was computed from");
  assert.match(after.invalidatedReason ?? "", /параметры планирования/);
});

test("an invalidated placement forces a replan instead of being executed", async () => {
  const { variant } = seedReadySlice();
  const detail = h.queue.promoteSliceVariant(variant.id);
  const assignment = h.queue.assignTask(detail.task.id, "k2");
  await h.devices.prepare(assignment.id);
  h.queue.setTaskScheduling(detail.task.id, { priority: 7 });

  await assert.rejects(h.dispatch.startAssignment(assignment.id), JobError);
  assert.equal(h.startCalls.length, 0);
});

test("a live run is NOT disturbed by a later queue edit", async () => {
  const { assignmentId, taskId } = await promoteAssignPrepare();
  const result = await h.dispatch.startAssignment(assignmentId);

  // The task is PRINTING, so scheduling edits are refused outright — and the
  // assignment/run are untouched either way.
  assert.throws(() => h.queue.setTaskScheduling(taskId, { priority: 9 }));
  const assignment = h.store.repositories.assignments.getById(assignmentId)!;
  assert.equal(assignment.state, "ACTIVE");
  assert.equal(assignment.invalidatedAt, null);
  assert.equal(h.store.repositories.printRuns.getById(result.runId)?.state, "RUNNING");
});

// ── no bypass ────────────────────────────────────────────────────────────────

test("a bed still holding a part blocks the start of a fully prepared assignment", async () => {
  const { assignmentId } = await promoteAssignPrepare();
  const repos = h.store.repositories;
  repos.bedCycles.insert({
    id: newId(ID_PREFIX.bedCycle),
    printerId: "k2",
    state: "AWAITING_CLEARANCE",
    assignmentId: null,
    createdAt: ISO,
    updatedAt: ISO,
    clearedAt: null,
    version: 1,
    metadata: {}
  });

  await assert.rejects(
    h.dispatch.startAssignment(assignmentId),
    (e: unknown) => e instanceof JobError && /стол/i.test(e.message)
  );
  assert.equal(h.startCalls.length, 0);
});

test("an unresolved start guard blocks a second command on the printer", async () => {
  const { assignmentId } = await promoteAssignPrepare();
  h.store.repositories.startGuards.upsert({
    printerId: "k2",
    file: "other.gcode",
    state: "UNKNOWN",
    jobRef: null,
    runId: null,
    requestedAt: ISO,
    updatedAt: ISO
  });

  await assert.rejects(h.dispatch.startAssignment(assignmentId), JobError);
  assert.equal(h.startCalls.length, 0);
});

test("every step of the chain is journalled", async () => {
  const { assignmentId } = await promoteAssignPrepare();
  await h.dispatch.startAssignment(assignmentId);

  const actions = h.store.repositories.audit.list(500);
  const has = (entityType: string, action: string): boolean =>
    actions.some((e) => e.entityType === entityType && e.action === action);

  assert.ok(has("print_task", "slice_promoted"), "slice → queue");
  assert.ok(has("assignment", "assigned_manually"), "manual placement");
  assert.ok(has("device_artifact", "uploaded"), "file delivery");
  assert.ok(has("device_artifact", "verified"), "file verification");
  assert.ok(has("assignment", "reserved"), "reservation");
  assert.ok(has("dispatch_attempt", "created"), "dispatch attempt");
  assert.ok(has("print_run", "started"), "run");
});
