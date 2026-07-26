import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { JobError, ValidationError } from "../../core/errors";
import { REASON } from "../../domain/dispatch/reasons";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { Artifact, ArtifactAnalysis, Assignment, PrintTask } from "../../domain/print/types";
import type { ProfileRevision, ProfileSet, ProfileType, SliceVariant } from "../../domain/slicing/types";
import { openPrintQueueStore } from "../../infra/db/store";
import type { PrinterCapabilities } from "../../infra/printers/capabilities";
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
 * Delivering a file to a printer, over a real in-memory SQLite store, a real
 * artifact blob store on disk and **fake adapters**. Nothing here talks to a
 * device: the "printer" is a Map of file names to sizes, and the upload is a
 * function whose behaviour each test bends (refuse, lose the response, land the
 * wrong bytes, hang up mid-transfer).
 *
 * The suite is organised around the failure modes that make an automated farm
 * dangerous rather than merely broken: a file that is not the one that was
 * verified, a delivery whose outcome nobody knows, and a record that is true
 * about a job we would no longer print.
 */

const GCODE = Buffer.from(
  ";FLAVOR:Klipper\n;printer_model = Creality K2\nG28\nG1 X10 Y10 E1 F1200\nM104 S0\n",
  "utf8"
);
const GCODE_SHA = createHash("sha256").update(GCODE).digest("hex");
const ISO = "2026-07-26T12:00:00.000Z";
/** What promotion names the file on the device: sanitized stem + content hash. */
const DEVICE_FILE = buildDeviceFileName({ name: "cube.gcode", sha256: GCODE_SHA });

/** k2 speaks Moonraker (upload + listing); x1c is a Bambu (neither). */
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
    id: "x1c",
    name: "Bambu X1C",
    model: "X1 Carbon",
    type: "FDM",
    protocol: "bambu",
    host: "127.0.0.2",
    material: "PLA",
    enabled: true
  }
] as unknown as PrinterConfig[];

/** How the fake device reacts to the next upload. */
type UploadMode =
  | "ok"
  /** The device refused; nothing landed. */
  | "refuse"
  /** The bytes landed, then the response was lost (timeout) — the nastiest case. */
  | "lost-response"
  /** The transfer died halfway: a short file is left behind. */
  | "truncated"
  /** The call "succeeds" but nothing appears on the device. */
  | "vanish";

interface Harness {
  store: PrintQueueStore;
  storage: ArtifactStorage;
  queue: PrintQueueService;
  devices: DeviceArtifactService;
  dispatch: DispatchService;
  /** Files the fake device holds, per printer. */
  onDevice: Map<string, { path: string; size: number }[]>;
  uploads: { printerId: string; remotePath: string; size: number }[];
  listCalls: number;
  startCalls: { printerId: string; file: string }[];
  uploadMode: UploadMode;
  /** Set to make the fake listing endpoint fail (device unreachable). */
  listingFails: boolean;
  /** Resolves once every queued upload may proceed (concurrency tests). */
  gate: { hold: boolean; release: () => void };
}

let TMP: string;
let h: Harness;

beforeEach(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "device-artifact-"));
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
  const state = {
    uploadMode: "ok" as UploadMode,
    listingFails: false,
    listCalls: 0,
    hold: false,
    waiters: [] as (() => void)[]
  };

  const queue = new PrintQueueService(store, {
    now: () => new Date(ISO),
    isPrinterConfigured: (id) => PRINTERS.some((p) => p.id === id)
  });

  const put = (printerId: string, file: { path: string; size: number }): void => {
    const files = onDevice.get(printerId) ?? [];
    onDevice.set(printerId, [...files.filter((f) => f.path !== file.path), file]);
  };

  const listFiles = async (printer: PrinterConfig, dir: string): Promise<PrinterFilesListing> => {
    state.listCalls += 1;
    if (state.listingFails) throw new Error("устройство недоступно");
    return {
      path: dir,
      entries: (onDevice.get(printer.id) ?? []).map((f) => ({
        name: f.path.split("/").pop() ?? f.path,
        path: f.path,
        type: "file" as const,
        size: f.size,
        printable: true
      }))
    };
  };

  const devices = new DeviceArtifactService({
    store,
    storage,
    resolvePrinter: (id) => PRINTERS.find((p) => p.id === id),
    listFiles,
    uploadFile: async (printer, remotePath, bytes) => {
      if (state.hold) {
        await new Promise<void>((resolve) => state.waiters.push(resolve));
      }
      switch (state.uploadMode) {
        case "refuse":
          throw new Error("устройство отклонило загрузку");
        case "lost-response":
          put(printer.id, { path: remotePath, size: bytes.byteLength });
          uploads.push({ printerId: printer.id, remotePath, size: bytes.byteLength });
          throw new Error("fetch failed: socket hang up");
        case "truncated":
          put(printer.id, { path: remotePath, size: Math.floor(bytes.byteLength / 2) });
          uploads.push({ printerId: printer.id, remotePath, size: bytes.byteLength });
          return { remotePath, sizeBytes: bytes.byteLength };
        case "vanish":
          uploads.push({ printerId: printer.id, remotePath, size: bytes.byteLength });
          return { remotePath, sizeBytes: bytes.byteLength };
        default:
          put(printer.id, { path: remotePath, size: bytes.byteLength });
          uploads.push({ printerId: printer.id, remotePath, size: bytes.byteLength });
          return { remotePath, sizeBytes: bytes.byteLength };
      }
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
    storage,
    queue,
    devices,
    dispatch: new DispatchService(deps),
    onDevice,
    uploads,
    startCalls,
    get listCalls() {
      return state.listCalls;
    },
    get uploadMode() {
      return state.uploadMode;
    },
    set uploadMode(mode: UploadMode) {
      state.uploadMode = mode;
    },
    get listingFails() {
      return state.listingFails;
    },
    set listingFails(value: boolean) {
      state.listingFails = value;
    },
    gate: {
      get hold() {
        return state.hold;
      },
      set hold(value: boolean) {
        state.hold = value;
      },
      release: () => {
        state.hold = false;
        for (const waiter of state.waiters.splice(0)) waiter();
      }
    } as Harness["gate"]
  };

  // The blob the upload path reads — written into the real content-addressed store.
  const blobPath = storage.resolvePath(`sha256/${GCODE_SHA.slice(0, 2)}/${GCODE_SHA}`);
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

/** A DRAFT task with a `ready` slice variant whose G-code output analyses clean. */
function seedReadySlice(targetPrinterId = "k2"): {
  task: PrintTask;
  variant: SliceVariant;
  output: Artifact;
  set: ProfileSet;
} {
  const repos = h.store.repositories;
  const declaredFlavor = targetPrinterId === "x1c" ? "marlin" : "klipper";
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

/** slice → queue → manual assignment, ready for a delivery. */
function assignReadySlice(printerId = "k2"): { assignment: Assignment; taskId: string; variantId: string } {
  const { variant } = seedReadySlice(printerId);
  const detail = h.queue.promoteSliceVariant(variant.id);
  const assignment = h.queue.assignTask(detail.task.id, printerId, { reason: "свободен" });
  return { assignment, taskId: detail.task.id, variantId: variant.id };
}

const recordFor = (assignment: Assignment) =>
  h.store.repositories.deviceArtifacts.findBySlot(
    assignment.printerId,
    assignment.binding.expectedRemotePath ?? ""
  );

// ── 1–2. Upload and verification ─────────────────────────────────────────────

test("1. a successful upload through the fake Moonraker adapter lands the exact artifact bytes", async () => {
  const { assignment } = assignReadySlice();

  const prepared = await h.devices.prepare(assignment.id);

  assert.equal(prepared.deviceArtifact.state, "VERIFIED");
  assert.equal(prepared.deviceArtifact.transferMode, "adapter_upload");
  assert.equal(prepared.deviceArtifact.artifactSha256, GCODE_SHA);
  assert.equal(prepared.ready, true);
  assert.equal(h.uploads.length, 1);
  assert.equal(h.uploads[0].printerId, "k2");
  assert.equal(h.uploads[0].remotePath, DEVICE_FILE, "the generated, content-addressed name");
  assert.equal(h.uploads[0].size, GCODE.byteLength, "the artifact's bytes, not a re-encoding");
});

test("2. verification is recorded as name_and_size — never as a SHA-256 the API cannot give", async () => {
  const { assignment } = assignReadySlice();

  const prepared = await h.devices.prepare(assignment.id);

  assert.equal(prepared.deviceArtifact.verification, "name_and_size");
  assert.equal(prepared.deviceArtifact.sizeBytes, GCODE.byteLength);
  assert.ok(prepared.deviceArtifact.verifiedAt, "the moment of the check is recorded");
  // The record keeps the artifact hash as the *expectation*, but the verification
  // level says plainly which evidence was actually obtained.
  assert.notEqual(prepared.deviceArtifact.verification, "sha256");
});

// ── 3–4. Idempotency and concurrency ─────────────────────────────────────────

test("3. preparing twice uploads once (idempotent delivery)", async () => {
  const { assignment } = assignReadySlice();

  const first = await h.devices.prepare(assignment.id);
  const second = await h.devices.prepare(assignment.id);

  assert.equal(h.uploads.length, 1, "the second prepare sent nothing");
  assert.equal(second.deviceArtifact.id, first.deviceArtifact.id, "one record, not two");
  assert.equal(second.deviceArtifact.version, first.deviceArtifact.version, "not even a rewrite");
  assert.equal(h.store.repositories.deviceArtifacts.listByPrinter("k2").length, 1);
});

test("4. parallel prepares of the same file are serialized — one upload, one record", async () => {
  const { assignment } = assignReadySlice();
  h.gate.hold = true;

  const inflight = [
    h.devices.prepare(assignment.id),
    h.devices.prepare(assignment.id),
    h.devices.prepare(assignment.id)
  ];
  // Let the first (and only) upload through; the rest queue behind the slot mutex.
  await new Promise((resolve) => setImmediate(resolve));
  h.gate.release();
  const results = await Promise.all(inflight);

  assert.equal(h.uploads.length, 1, "the slot mutex collapsed the race into one transfer");
  assert.equal(h.store.repositories.deviceArtifacts.listByPrinter("k2").length, 1);
  const ids = new Set(results.map((r) => r.deviceArtifact.id));
  assert.equal(ids.size, 1, "every caller got the same record");
  assert.ok(results.every((r) => r.deviceArtifact.state === "VERIFIED"));
});

// ── 5–6. What the device actually holds ──────────────────────────────────────

test("5. a size mismatch on the device marks the file INVALID and never VERIFIED", async () => {
  const { assignment } = assignReadySlice();
  h.uploadMode = "truncated"; // a half-written file with the right name

  const prepared = await h.devices.prepare(assignment.id);

  assert.equal(prepared.deviceArtifact.state, "INVALID");
  assert.match(prepared.deviceArtifact.lastError ?? "", /размер на устройстве/);
  assert.equal(prepared.ready, false);
});

test("6. a file that is absent after a 'successful' upload is INVALID, not VERIFIED", async () => {
  const { assignment } = assignReadySlice();
  h.uploadMode = "vanish"; // the adapter answered 200 and nothing arrived

  const prepared = await h.devices.prepare(assignment.id);

  assert.equal(prepared.deviceArtifact.state, "INVALID");
  assert.match(prepared.deviceArtifact.lastError ?? "", /не найден на устройстве/);
});

// ── 7–9. Errors, retries and lost outcomes ───────────────────────────────────

test("7. a network failure is persisted as FAILED with the reason kept", async () => {
  const { assignment } = assignReadySlice();
  h.uploadMode = "refuse";

  const prepared = await h.devices.prepare(assignment.id);

  assert.equal(prepared.deviceArtifact.state, "FAILED");
  assert.match(prepared.deviceArtifact.lastError ?? "", /отклонило загрузку/);
  // The state survives the call: a later reader sees the failure, not a blank.
  assert.equal(recordFor(assignment)?.state, "FAILED");
  assert.equal(
    h.store.repositories.assignments.getById(assignment.id)?.state,
    "PROPOSED",
    "a failed transfer never advances the assignment"
  );
});

test("8. a retry after a failure re-uploads and verifies", async () => {
  const { assignment } = assignReadySlice();
  h.uploadMode = "refuse";
  await h.devices.prepare(assignment.id);

  h.uploadMode = "ok";
  const retried = await h.devices.prepare(assignment.id);

  assert.equal(retried.deviceArtifact.state, "VERIFIED");
  assert.equal(h.uploads.length, 1, "only the successful attempt actually transferred bytes");
  assert.equal(retried.deviceArtifact.lastError, null, "the stale error is cleared, not kept around");
});

test("9. a LOST RESPONSE reconciles against the device instead of re-uploading blindly", async () => {
  const { assignment } = assignReadySlice();
  h.uploadMode = "lost-response"; // bytes landed, the answer never came back

  const prepared = await h.devices.prepare(assignment.id);

  assert.equal(prepared.deviceArtifact.state, "VERIFIED", "the file IS there — asking beat assuming");
  assert.equal(h.uploads.length, 1, "no second, blind push of the same file");
  assert.equal(prepared.deviceArtifact.verification, "name_and_size");

  const audit = h.store.repositories.audit.list(200);
  assert.ok(
    audit.some((e) => e.entityType === "device_artifact" && e.action === "upload_reconciled"),
    "the reconciliation is journalled, not silent"
  );
});

test("9b. a lost response whose file did NOT land is FAILED, not silently trusted", async () => {
  const { assignment } = assignReadySlice();
  // The upload throws AND the device is unreachable for the reconciliation read:
  // nothing was confirmed, so nothing may be assumed.
  h.uploadMode = "refuse";
  h.listingFails = true;

  const prepared = await h.devices.prepare(assignment.id);

  assert.equal(prepared.deviceArtifact.state, "FAILED");
  assert.match(prepared.deviceArtifact.lastError ?? "", /проверить наличие файла не удалось/);
});

test("9c. an unreadable listing leaves an uploaded file UNVERIFIED — and therefore un-startable", async () => {
  const { assignment, taskId } = assignReadySlice();
  h.listingFails = true;

  const prepared = await h.devices.prepare(assignment.id);

  assert.equal(prepared.deviceArtifact.state, "PRESENT_UNVERIFIED");
  assert.equal(prepared.ready, false);
  assert.match(prepared.deviceArtifact.lastError ?? "", /листинг недоступен/);
  void taskId;
});

// ── 10–11. The record must describe the CURRENT job ──────────────────────────

test("10. an invalidated (stale) assignment cannot prepare a file at all", async () => {
  const { assignment } = assignReadySlice();
  h.queue.invalidateAssignment(assignment.id, "оператор отозвал назначение");

  await assert.rejects(
    h.devices.prepare(assignment.id),
    (e: unknown) => e instanceof JobError && /устарело/.test(e.message)
  );
  assert.equal(h.uploads.length, 0, "nothing was sent for a placement nobody stands behind");
});

test("10b. a cancelled assignment cannot prepare a file either", async () => {
  const { assignment } = assignReadySlice();
  const repos = h.store.repositories;
  repos.assignments.update({ ...repos.assignments.getById(assignment.id)!, state: "CANCELLED", updatedAt: ISO });

  await assert.rejects(h.devices.prepare(assignment.id), JobError);
  assert.equal(h.uploads.length, 0);
});

test("11. re-slicing makes the delivered file STALE — the old bytes stop being startable", async () => {
  const { assignment, taskId } = assignReadySlice();
  await h.devices.prepare(assignment.id);
  assert.equal(recordFor(assignment)?.state, "VERIFIED");

  // The task is re-pointed at a different slice behind the delivery's back.
  const repos = h.store.repositories;
  const task = repos.tasks.getById(taskId)!;
  repos.tasks.update({ ...task, sliceVariantId: "slc_other", updatedAt: ISO });

  // The eligibility read computes staleness from the current binding, so the
  // start is refused even though the stored row still says VERIFIED.
  await assert.rejects(h.dispatch.startAssignment(assignment.id), JobError);
  assert.equal(h.startCalls.length, 0);
});

test("11b. a changed artifact hash marks a previously verified record STALE on the next prepare", async () => {
  const { assignment, variantId } = assignReadySlice();
  await h.devices.prepare(assignment.id);

  // A re-slice produced different bytes at the same logical place.
  const repos = h.store.repositories;
  const record = recordFor(assignment)!;
  repos.deviceArtifacts.update({ ...record, artifactSha256: "b".repeat(64), updatedAt: ISO });

  const prepared = await h.devices.prepare(assignment.id);
  assert.equal(prepared.deviceArtifact.state, "VERIFIED", "re-prepared from the current artifact");
  assert.equal(h.uploads.length, 2, "the wrong-content slot WAS re-uploaded, deliberately");
  assert.equal(prepared.deviceArtifact.artifactSha256, GCODE_SHA);

  const audit = h.store.repositories.audit.list(200);
  assert.ok(
    audit.some((e) => e.entityType === "device_artifact" && e.action === "stale"),
    "the supersession is journalled"
  );
  void variantId;
});

// ── 12. An unverified file blocks the dispatch ───────────────────────────────

test("12. an unverified file blocks the dispatch even when the bytes are physically there", async () => {
  const { assignment } = assignReadySlice();
  // The file is on the device — but nothing in this system delivered or checked
  // it, so there is no record and the start is refused.
  h.onDevice.set("k2", [{ path: DEVICE_FILE, size: GCODE.byteLength }]);

  await assert.rejects(
    h.dispatch.startAssignment(assignment.id),
    (e: unknown) =>
      e instanceof JobError &&
      (e.details as { blockers?: { code: string }[] }).blockers?.some(
        (b) => b.code === REASON.DEVICE_TRANSFER_NOT_CONFIRMED
      ) === true
  );
  assert.equal(h.startCalls.length, 0);
});

test("12b. every non-VERIFIED state refuses the start", async () => {
  for (const mode of ["refuse", "truncated", "vanish"] as UploadMode[]) {
    const local = await makeHarness(fs.mkdtempSync(path.join(os.tmpdir(), "device-states-")));
    const previous = h;
    h = local;
    try {
      const { assignment } = assignReadySlice();
      h.uploadMode = mode;
      const prepared = await h.devices.prepare(assignment.id);
      assert.notEqual(prepared.deviceArtifact.state, "VERIFIED", mode);
      await assert.rejects(h.dispatch.startAssignment(assignment.id), JobError, mode);
      assert.equal(h.startCalls.length, 0, mode);
    } finally {
      local.store.close();
      h = previous;
    }
  }
});

// ── 13–14. Printers with no upload API ───────────────────────────────────────

test("13. a manual transfer needs a NAMED operator confirmation", async () => {
  const { assignment } = assignReadySlice("x1c");

  const prepared = await h.devices.prepare(assignment.id);
  assert.equal(prepared.deviceArtifact.transferMode, "manual_file_transfer");
  assert.equal(prepared.deviceArtifact.state, "NOT_PRESENT");
  assert.equal(h.uploads.length, 0, "no pretend upload was attempted");
  // The operator is told exactly which local file and which remote path.
  assert.match(prepared.manualInstruction ?? "", /Скопируйте файл «cube\.gcode»/);
  assert.match(prepared.manualInstruction ?? "", new RegExp(DEVICE_FILE.replace(/\./g, "\\.")));
  assert.equal(prepared.localFile?.sha256, GCODE_SHA);
  assert.equal(prepared.expectedRemotePath, DEVICE_FILE);

  // An anonymous confirmation is not a confirmation.
  await assert.rejects(h.devices.confirmManualTransfer(assignment.id, "   "), ValidationError);

  const confirmed = await h.devices.confirmManualTransfer(assignment.id, "Миха");
  assert.equal(confirmed.deviceArtifact.state, "VERIFIED");
  assert.equal(confirmed.deviceArtifact.verification, "operator_confirmed");
  assert.equal(confirmed.deviceArtifact.confirmedBy, "Миха");

  const audit = h.store.repositories.audit.list(200);
  const event = audit.find((e) => e.action === "manual_transfer_confirmed");
  assert.equal(event?.actor, "Миха", "who confirmed, and when, is on the record");
});

test("14. a manually transferred file never authorises an automatic (night) start", async () => {
  const { assignment, taskId } = assignReadySlice("x1c");
  const repos = h.store.repositories;
  const task = repos.tasks.getById(taskId)!;
  repos.tasks.update({ ...task, night: true, unattendedAllowed: true, updatedAt: ISO });
  await h.devices.confirmManualTransfer(assignment.id, "Миха");

  await assert.rejects(h.dispatch.startAssignment(assignment.id, { mode: "night" }), JobError);
  assert.equal(h.startCalls.length, 0, "unattended automation for a manual-only adapter stays off");

  // The attended start, by contrast, is admissible.
  const result = await h.dispatch.startAssignment(assignment.id, { mode: "manual" });
  assert.equal(result.printerId, "x1c");
});

// ── 15–16. Path and source safety ────────────────────────────────────────────

test("15. an unsafe remote path is refused before anything is uploaded", async () => {
  const repos = h.store.repositories;
  const { assignment } = assignReadySlice();
  for (const bad of [
    "../../etc/passwd.gcode",
    "/absolute/path.gcode",
    "dir/../escape.gcode",
    "C:part.gcode",
    "back\\slash.gcode",
    "control\u0007char.gcode",
    "model.stl",
    "no-extension",
    `${"x".repeat(300)}.gcode`
  ]) {
    const stored = repos.assignments.getById(assignment.id)!;
    // Bypass the normal writer to plant the hostile value directly in the row —
    // this asserts the *reader* refuses it, not just the writer.
    repos.assignments.update({
      ...stored,
      binding: { ...stored.binding, expectedRemotePath: bad },
      updatedAt: ISO
    });

    await assert.rejects(h.devices.prepare(assignment.id), ValidationError, bad);
  }
  assert.equal(h.uploads.length, 0, "not one byte left the host for any of them");
});

test("16. only a file inside the artifact store can be uploaded", async () => {
  const repos = h.store.repositories;
  const outside = path.join(TMP, "secret.gcode");
  fs.writeFileSync(outside, "M104 S300\n");
  const { assignment } = assignReadySlice();
  const artifactId = repos.assignments.getById(assignment.id)!.binding.artifactId!;

  for (const source of [
    outside,
    "../../../etc/passwd",
    "http://192.168.0.5/evil.gcode",
    "file:///etc/hosts",
    "sha256/zz/nope"
  ]) {
    const artifact = repos.artifacts.getById(artifactId)!;
    repos.artifacts.update({ ...artifact, source, updatedAt: ISO });

    await assert.rejects(h.devices.prepare(assignment.id), ValidationError, source);
  }
  assert.equal(h.uploads.length, 0, "no arbitrary local path and no URL was ever read");
});

test("16b. a blob whose size no longer matches the registered artifact is refused", async () => {
  const { assignment } = assignReadySlice();
  // The stored blob was truncated (a partial write, a failed restore…).
  const blob = h.storage.resolvePath(`sha256/${GCODE_SHA.slice(0, 2)}/${GCODE_SHA}`);
  fs.writeFileSync(blob, GCODE.subarray(0, 10));

  await assert.rejects(
    h.devices.prepare(assignment.id),
    (e: unknown) => e instanceof JobError && /в хранилище/.test(e.message)
  );
  assert.equal(h.uploads.length, 0);
});

// ── 17. No endpoint outruns the eligibility check ────────────────────────────

test("17. a delivered file still does not start over a hard blocker (no path skips eligibility)", async () => {
  const { assignment } = assignReadySlice();
  await h.devices.prepare(assignment.id);

  // A part is still on the plate — a physical fact no amount of file readiness
  // may override, on any code path.
  h.store.repositories.bedCycles.insert({
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
    h.dispatch.startAssignment(assignment.id),
    (e: unknown) => e instanceof JobError && /стол/i.test(e.message)
  );
  assert.equal(h.startCalls.length, 0);
});

test("17b. one device slot cannot be claimed by a second live assignment", async () => {
  const { assignment } = assignReadySlice();
  await h.devices.prepare(assignment.id);

  // A plan proposal for another task, aimed at the same printer AND the same
  // path. (`assignTask` refuses a second live placement outright; a PROPOSED
  // plan row is deliberately outside that index, so this is the reachable way
  // two placements can point at one device slot.)
  const repos = h.store.repositories;
  const { task: other } = seedReadySlice();
  const rival: Assignment = {
    ...repos.assignments.getById(assignment.id)!,
    id: newId(ID_PREFIX.assignment),
    taskId: other.id,
    state: "PROPOSED",
    source: "plan",
    createdAt: ISO,
    updatedAt: ISO,
    version: 1
  };
  repos.assignments.insert(rival);

  await assert.rejects(
    h.devices.prepare(rival.id),
    (e: unknown) => e instanceof JobError && /уже занят активным назначением/.test(e.message)
  );
  assert.equal(h.uploads.length, 1, "the first assignment's file was not overwritten");
});

// ── 18. Restart ──────────────────────────────────────────────────────────────

test("18. a delivery orphaned by a restart is recovered, not left readable as ready", async () => {
  const { assignment } = assignReadySlice();
  const repos = h.store.repositories;

  // A crash mid-transfer: the row is left UPLOADING by a process that is gone.
  await h.devices.prepare(assignment.id);
  const record = recordFor(assignment)!;
  repos.deviceArtifacts.update({ ...record, state: "UPLOADING", verifiedAt: null, updatedAt: ISO });

  const recovered = h.devices.recover();

  assert.equal(recovered, 1);
  const after = recordFor(assignment)!;
  assert.equal(after.state, "NOT_PRESENT", "unknown is never left looking usable");
  assert.match(after.lastError ?? "", /перезапуском/);

  // …and the state is a real, durable row: a fresh service over the same store
  // reads it back and can carry the delivery to completion.
  const reopened = await h.devices.prepare(assignment.id);
  assert.equal(reopened.deviceArtifact.state, "VERIFIED");
  assert.equal(reopened.deviceArtifact.id, record.id, "the same record, not a duplicate");
});

test("18b. recovery reconciles rather than blindly re-uploading a file that is already there", async () => {
  const { assignment } = assignReadySlice();
  await h.devices.prepare(assignment.id);
  const record = recordFor(assignment)!;
  const repos = h.store.repositories;
  repos.deviceArtifacts.update({ ...record, state: "UPLOADING", updatedAt: ISO });
  const uploadsBefore = h.uploads.length;

  h.devices.recover();
  const prepared = await h.devices.prepare(assignment.id);

  assert.equal(prepared.deviceArtifact.state, "VERIFIED");
  assert.equal(
    h.uploads.length,
    uploadsBefore + 1,
    "one re-push of a file whose delivery was never confirmed is correct; a loop is not"
  );
});

// ── Capabilities are declared, not guessed ───────────────────────────────────

test("an adapter that cannot upload is never asked to — its declared capabilities decide", async () => {
  const calls: string[] = [];
  const capabilities = (printer: PrinterConfig): PrinterCapabilities => {
    calls.push(printer.id);
    return {
      supportsUpload: false,
      supportsFileListing: false,
      supportsRemoteStart: false,
      supportsFileDelete: false,
      fileVerification: "none"
    };
  };
  const devices = new DeviceArtifactService({
    store: h.store,
    storage: h.storage,
    resolvePrinter: (id) => PRINTERS.find((p) => p.id === id),
    listFiles: async () => {
      throw new Error("listing must not be attempted");
    },
    uploadFile: async () => {
      throw new Error("upload must not be attempted");
    },
    capabilities,
    now: () => new Date(ISO)
  });

  // k2 *is* a Moonraker printer, but the capability table is what decides — the
  // model name never is.
  const { assignment } = assignReadySlice();
  const prepared = await devices.prepare(assignment.id);

  assert.equal(prepared.deviceArtifact.transferMode, "manual_file_transfer");
  assert.equal(prepared.deviceArtifact.state, "NOT_PRESENT");
  assert.ok(calls.includes("k2"));
});
