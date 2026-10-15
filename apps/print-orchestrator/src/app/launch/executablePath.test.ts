import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { JobError } from "../../core/errors";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { Artifact, ArtifactAnalysis, PrintTask } from "../../domain/print/types";
import { openPrintQueueStore } from "../../infra/db/store";
import { establishClearBed } from "../dispatch/testkit/bed";
import type { PrinterConfig } from "../../infra/printers/config";
import type { PrinterFilesListing } from "../../infra/printers/files";
import { ArtifactStorage } from "../../infra/storage/artifactStorage";
import { ANALYZER_VERSION } from "../artifacts/analyzers";
import { ArtifactService } from "../artifacts/artifactService";
import { DeviceArtifactService } from "../dispatch/deviceArtifactService";
import { DispatchService, type DispatchDeps } from "../dispatch/dispatchService";
import { RunLifecycleService } from "../dispatch/runLifecycle";
import { ManualOperationService } from "../operations/manualOperationService";
import { OperatorScheduleService } from "../operations/operatorScheduleService";
import { PrintQueueService } from "../printQueue/printQueueService";
import { SchedulerContext } from "../scheduling/context";
import { EligibilityQueries } from "../scheduling/eligibility";
import { EvidenceResolver } from "../scheduling/evidence";
import { SchedulerService } from "../scheduling/schedulerService";
import type { SchedulerPrinterRef } from "../scheduling/types";
import { LaunchService } from "./launchService";

/*
 * **The road an already-printable file takes**, end to end over a real in-memory
 * store and fake adapters.
 *
 * The gap this suite exists for: the system accepted four kinds of file and had
 * a working path for two. STL and 3MF went upload → analyse → slice → promote →
 * queue → launch. Bare G-code and a sliced `.gcode.3mf` went upload → analyse →
 * *nothing*: the draft task they created could only be queued by promoting a
 * slice variant, which an already-sliced file does not have. The upload card
 * showed «готово к планированию» and the interface offered no action that could
 * reach a printer.
 *
 * So the assertions here are about the **whole chain being connected**, and
 * about the three-stage launch protocol behaving: what preflight refuses before
 * a byte moves, what only the final gate can catch, and what a file is allowed
 * to become on the way.
 */

const A1_GCODE = Buffer.from(
  ";FLAVOR:Marlin\n;printer_model = Bambu Lab A1\nG28\nG1 X10 Y10 E1 F1200\nM104 S0\n",
  "utf8"
);
const A1_SHA = createHash("sha256").update(A1_GCODE).digest("hex");
const ISO = "2026-08-14T12:00:00.000Z";

const A1: PrinterConfig = {
  id: "bambu-a1",
  name: "Bambu Lab A1 Combo",
  model: "Bambu Lab A1",
  type: "FDM",
  protocol: "bambu",
  host: "127.0.0.1",
  serial: "0391A2B3C4D5E6F",
  accessCode: "12345678",
  allowInsecureTls: true,
  // The config field is a CAPABILITY list, and the point of several tests below
  // is that it is never read as the loaded spool.
  material: "PLA / PETG / TPU",
  enabled: true
} as unknown as PrinterConfig;

const K2: PrinterConfig = {
  id: "k2",
  name: "Creality K2",
  model: "Creality K2",
  type: "FDM",
  protocol: "moonraker",
  host: "127.0.0.2",
  material: "PLA / PETG",
  enabled: true
} as unknown as PrinterConfig;

/** The Creality WebSocket adapter: telemetry only — no upload, listing or start. */
const ENDER: PrinterConfig = {
  id: "ender3",
  name: "Creality Ender 3 V3 KE",
  model: "Creality Ender 3 V3 KE",
  type: "FDM",
  protocol: "creality",
  host: "127.0.0.3",
  material: "PLA / PETG / TPU",
  enabled: true
} as unknown as PrinterConfig;

const PRINTERS = [A1, K2, ENDER];

interface Knobs {
  online: Record<string, boolean>;
  status: Record<string, SchedulerPrinterRef["status"]>;
  /** LIVE loaded material per printer; `null` = telemetry does not say. */
  loaded: Record<string, string | null>;
  nozzle: Record<string, number | null>;
  failStart: string | null;
  /** Uploads to these printers fail (the printer dropped off mid-transfer). */
  failUpload: Set<string>;
}

interface Harness {
  store: PrintQueueStore;
  queue: PrintQueueService;
  artifacts: ArtifactService;
  devices: DeviceArtifactService;
  dispatch: DispatchService;
  lifecycle: RunLifecycleService;
  launch: LaunchService;
  scheduler: SchedulerService;
  storage: ArtifactStorage;
  uploads: { printerId: string; remotePath: string; bytes: Uint8Array }[];
  startCalls: { printerId: string; file: string; plateGcodePath: string | null }[];
  onDevice: Map<string, { path: string; size: number }[]>;
  knobs: Knobs;
}

let TMP: string;
let h: Harness;

beforeEach(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "exec-path-"));
  h = await makeHarness(TMP);
});

afterEach(() => {
  h.artifacts.close();
  h.store.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function makeHarness(tmp: string): Promise<Harness> {
  const store = openPrintQueueStore(":memory:");
  // Every harness printer starts with a plate an operator confirmed empty — the
  // only evidence of a free bed (untracked is UNKNOWN and the gate refuses it).
  for (const id of ["bambu-a1", "k2", "ender3"]) establishClearBed(store, id);
  const storage = new ArtifactStorage({ root: path.join(tmp, "artifacts") });
  await storage.init();

  const onDevice = new Map<string, { path: string; size: number }[]>();
  const uploads: Harness["uploads"] = [];
  const startCalls: Harness["startCalls"] = [];
  const knobs: Knobs = {
    online: { "bambu-a1": true, k2: true, ender3: true },
    status: { "bambu-a1": "idle", k2: "idle", ender3: "idle" },
    loaded: { "bambu-a1": "PETG", k2: "PETG", ender3: "PETG" },
    nozzle: { "bambu-a1": 0.4, k2: 0.4, ender3: 0.4 },
    failStart: null,
    failUpload: new Set<string>()
  };

  const queue = new PrintQueueService(store, {
    now: () => new Date(ISO),
    isPrinterConfigured: (id) => PRINTERS.some((p) => p.id === id),
    resolvePrinter: (id) => PRINTERS.find((p) => p.id === id)
  });

  // The analyzer is stubbed: these tests are about the chain, not about parsing
  // G-code, and the real analyzer runs in a worker thread. Each fixture states
  // exactly what it wants the analysis to say.
  const artifacts = new ArtifactService(store, storage, {
    now: () => new Date(ISO),
    analyze: async () => ({
      detectedFormat: "gcode",
      verdict: "schedulable",
      warnings: [],
      blockers: [],
      data: {},
      analyzer: "gcode",
      analyzerVersion: ANALYZER_VERSION
    })
  } as never);

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

  const devices = new DeviceArtifactService({
    store,
    storage,
    resolvePrinter: (id) => PRINTERS.find((p) => p.id === id),
    listFiles,
    uploadFile: async (printer, remotePath, bytes) => {
      if (knobs.failUpload.has(printer.id)) throw new Error("связь с принтером оборвалась во время загрузки");
      uploads.push({ printerId: printer.id, remotePath, bytes });
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
      // Exactly what the read model now passes: live telemetry only, with the
      // config's capability list kept separately.
      material: knobs.loaded[p.id] ?? null,
      supportedMaterials: (p.material ?? "").split("/").map((m) => m.trim()).filter(Boolean),
      nozzleMm: knobs.nozzle[p.id] ?? null,
      buildVolume: { x: 256, y: 256, z: 256 },
      online: knobs.online[p.id] ?? true,
      status: knobs.status[p.id] ?? "idle",
      remoteStartSupported: p.protocol !== "creality",
      ams: false,
      faults: [],
      mediaPresent: null,
      telemetryAgeMs: 1_000,
      materialRemainingSufficient: null,
      printingTimeLeftMs: null,
      activeRunState: null
    }));

  const schedulerConfig = {
    now: () => new Date(ISO),
    runtimeAvailable: true,
    nightSafetyBufferRatio: 0.2,
    nightWindow: "21:30 – 07:30",
    farmTimeZone: "UTC",
    compatibility: { telemetryStaleMs: 120_000 },
    unknownEtaAssumptionS: 4 * 3600,
    // No AMS anywhere in this harness: each Bambu feeds from its external spool,
    // which holds whatever the `loaded` knob says.
    feedStateOf: (id: string) => ({
      hasAms: false,
      trays: [{ trayId: 254, external: true, material: knobs.loaded[id] ?? null, color: null, active: true }]
    })
  };
  const scheduler = new SchedulerService(store, refs, schedulerConfig);
  const eligibility = (): EligibilityQueries => {
    const ctx = new SchedulerContext(store, refs, schedulerConfig);
    return new EligibilityQueries(ctx, new EvidenceResolver(ctx));
  };

  const deps: DispatchDeps = {
    store,
    resolvePrinter: (ref) => {
      const wanted = ref.trim().toLowerCase();
      return PRINTERS.find((p) => p.id.toLowerCase() === wanted || p.name.toLowerCase() === wanted);
    },
    getStatus: () => undefined,
    startPhysical: async (printerId, file, _runId, options) => {
      if (knobs.failStart) throw new Error(knobs.failStart);
      startCalls.push({ printerId, file, plateGcodePath: options?.plateGcodePath ?? null });
      return { confirmed: true };
    },
    classifyError: () => "unknown",
    listFiles,
    evaluateEligibility: (input) => eligibility().evaluate(input),
    now: () => new Date(ISO)
  };

  const dispatch = new DispatchService(deps);
  const schedule = new OperatorScheduleService(store, { now: () => new Date(ISO) });
  const manualOperations = new ManualOperationService(store, schedule, { now: () => new Date(ISO) });
  // Wired as `createRuntime` wires it: a finished print opens the part-removal
  // operation, and a bed clearance closes it.
  const lifecycle = new RunLifecycleService(store, { now: () => new Date(ISO), operations: manualOperations });

  const launch = new LaunchService({
    store,
    printQueue: queue,
    scheduler,
    deviceArtifacts: devices,
    dispatch: () => dispatch,
    runLifecycle: () => lifecycle,
    manualOperations,
    resolvePrinter: (id) => PRINTERS.find((p) => p.id === id),
    automaticContinuationAllowed: () => false
  });

  return {
    store,
    queue,
    artifacts,
    devices,
    dispatch,
    lifecycle,
    launch,
    scheduler,
    storage,
    uploads,
    startCalls,
    onDevice,
    knobs
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * The state an upload leaves behind: a content-addressed blob, an artifact, a
 * `DRAFT` task and a finished analysis. Written directly rather than through the
 * multipart route, so a test can state exactly what the analysis concluded.
 */
function seedUpload(input: {
  name: string;
  bytes?: Buffer;
  detectedFormat: "gcode" | "3mf" | "stl";
  verdict: ArtifactAnalysis["verdict"];
  data?: Record<string, unknown>;
  material?: string | null;
  warnings?: { code: string; message: string }[];
  blockers?: { code: string; message: string }[];
}): { artifact: Artifact; task: PrintTask; analysis: ArtifactAnalysis } {
  const repos = h.store.repositories;
  const bytes = input.bytes ?? A1_GCODE;
  const sha = createHash("sha256").update(bytes).digest("hex");
  const key = `sha256/${sha.slice(0, 2)}/${sha}`;
  const blobPath = h.storage.resolvePath(key);
  fs.mkdirSync(path.dirname(blobPath), { recursive: true });
  fs.writeFileSync(blobPath, bytes);

  const artifact: Artifact = {
    id: newId(ID_PREFIX.artifact),
    kind: input.detectedFormat === "gcode" ? "gcode" : "model",
    name: input.name,
    source: key,
    sizeBytes: bytes.byteLength,
    sha256: sha,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  repos.artifacts.insert(artifact);

  const analysis: ArtifactAnalysis = {
    id: newId(ID_PREFIX.artifactAnalysis),
    artifactId: artifact.id,
    state: "ready",
    detectedFormat: input.detectedFormat,
    verdict: input.verdict,
    analyzer: input.detectedFormat,
    analyzerVersion: ANALYZER_VERSION,
    estimatedDurationS: 5329,
    estimatedFilamentG: 31.1,
    material: input.material === undefined ? "PETG" : input.material,
    nozzleDiameterMm: 0.4,
    layerHeightMm: 0.2,
    warnings: input.warnings ?? [],
    blockers: input.blockers ?? [],
    data: { size: [100, 100, 100], flavor: "marlin", printerModel: "Bambu Lab A1", ...input.data },
    error: null,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {}
  };
  repos.artifactAnalyses.insert(analysis);

  const task: PrintTask = {
    id: newId(ID_PREFIX.printTask),
    artifactId: artifact.id,
    sliceVariantId: null,
    sourceArtifactId: artifact.id,
    onDeviceFile: null,
    title: input.name,
    material: null,
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
    metadata: { source: "upload" }
  };
  repos.tasks.insert(task);
  return { artifact, task, analysis };
}

/** An uploaded, ready-to-print G-code targeting the A1. */
function seedGcodeUpload() {
  return seedUpload({ name: "bracket.gcode", detectedFormat: "gcode", verdict: "schedulable" });
}

/** An uploaded sliced 3MF: startable, and produced against a foreign profile. */
function seedSliced3mfUpload(plateEntry = "Metadata/plate_1.gcode") {
  return seedUpload({
    name: "bracket.gcode.3mf",
    // A ZIP is what the detector sees; the 3MF analyzer then finds the plate.
    bytes: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), A1_GCODE]),
    detectedFormat: "3mf",
    verdict: "review",
    // The 1.4.0 shape: the payload the analyzer opened, and the declared target
    // under the key the dispatch gate reads.
    data: {
      threeMfClass: "sliced",
      hasGcodePayload: true,
      printerModel: "Bambu Lab A1",
      targetPrinter: "Bambu Lab A1",
      payload: { entry: plateEntry, plateIndex: Number(/plate_(\d+)/.exec(plateEntry)?.[1] ?? 1), md5Verified: null }
    },
    warnings: [
      { code: "threemf_sliced_payload", message: "Файл уже нарезан для «Bambu Lab A1»" }
    ]
  });
}

function bedClear(printerId: string): void {
  h.lifecycle.clearBed(printerId, { confirmation: "part_removed", actor: "test" });
}

// ═══════════════════════════════════════════════════════════════════════════
// G-code: enqueue → preview → launch → run
//
// The analysis is seeded, not produced: `seedUpload` writes the artifact row,
// the blob and the analysis row directly, so what follows exercises the real
// enqueue, launch, delivery and dispatch services over a real SQLite store with
// fake device adapters. The upload+analyzer half of the chain has its own
// coverage over HTTP with the real worker-thread analyzer, in
// `modules/print/artifactRoutes.test.ts`.
// ═══════════════════════════════════════════════════════════════════════════

test("G-code: an uploaded ready file reaches a printer through enqueue → preview → launch", async () => {
  const { task, artifact } = seedGcodeUpload();

  // 1 · The chain used to stop right here: a DRAFT with no slice variant had no
  //     route into the queue at all.
  const detail = h.queue.enqueueExecutableArtifact(task.id);
  assert.equal(detail.task.state, "QUEUED");
  assert.equal(detail.queueEntry?.state, "WAITING", "a queued task is IN the queue");
  assert.ok(detail.task.onDeviceFile, "the device path is decided at enqueue time");
  assert.ok(
    detail.task.onDeviceFile!.includes(artifact.sha256!.slice(0, 8)),
    "the device name carries the content hash, so same-named uploads cannot collide"
  );

  // 2 · Preview: a real printer, chosen and explained.
  bedClear("bambu-a1");
  const preview = h.launch.preview(task.id);
  assert.equal(preview.state, "ready");
  assert.equal(preview.recommendedPrinterId, "bambu-a1");
  assert.match(preview.selectionNote, /A1/);

  // 3 · Launch: delivered and started, in that order.
  const outcome = await h.launch.launch(task.id, {});
  assert.equal(h.uploads.length, 1);
  assert.equal(h.startCalls.length, 1);
  assert.equal(h.startCalls[0].printerId, "bambu-a1");
  assert.ok(outcome.steps.includes("preflight_passed"));
  assert.equal(h.store.repositories.printRuns.getById(outcome.run.runId)?.state, "RUNNING");
});

test("G-code: the device name is re-derived for the printer that is actually chosen", async () => {
  // Queued with no printer in scope, so the name keeps the artifact's own
  // `.gcode`. A Bambu starts a `.gcode.3mf` plate package and must be handed one.
  const { task } = seedGcodeUpload();
  const queued = h.queue.enqueueExecutableArtifact(task.id);
  assert.match(queued.task.onDeviceFile!, /\.gcode$/);

  bedClear("bambu-a1");
  await h.launch.launch(task.id, {});
  assert.match(h.startCalls[0].file, /\.gcode\.3mf$/, "the container follows the target firmware");
});

test("enqueue is idempotent — a second call creates no second queue entry", () => {
  const { task } = seedGcodeUpload();
  const first = h.queue.enqueueExecutableArtifact(task.id);
  const second = h.queue.enqueueExecutableArtifact(task.id);

  assert.equal(second.queueEntry?.id, first.queueEntry?.id);
  assert.equal(second.task.version, first.task.version, "an identical repeat writes nothing");
  assert.equal(
    h.store.repositories.audit
      .listByEntity("print_task", task.id)
      .filter((e) => e.action === "executable_enqueued").length,
    1
  );
});

test("a model is refused by the executable path with the slicing step named", () => {
  const { task } = seedUpload({
    name: "bracket.stl",
    detectedFormat: "stl",
    verdict: "needs_preparation",
    material: null
  });
  assert.throws(
    () => h.queue.enqueueExecutableArtifact(task.id),
    (error: unknown) => error instanceof JobError && /нарежьте/i.test((error as Error).message)
  );
  assert.equal(h.store.repositories.queue.findByTaskId(task.id), null, "nothing was queued");
});

// ═══════════════════════════════════════════════════════════════════════════
// Sliced 3MF: review → confirm → enqueue → preview → launch
// (analysis seeded, as above — see the note on the G-code section)
// ═══════════════════════════════════════════════════════════════════════════

test("sliced 3MF: the enqueue is refused until a named operator accepts the review", async () => {
  const { task, artifact } = seedSliced3mfUpload();

  // The verdict is `review` by construction — the parameters are someone else's.
  assert.throws(
    () => h.queue.enqueueExecutableArtifact(task.id),
    (error: unknown) =>
      error instanceof JobError &&
      (error as JobError & { details?: Record<string, unknown> }).details?.needsReview === true
  );

  // …and the way through is the acknowledgement, not a flag anyone can set.
  h.artifacts.confirmAnalysisReview(artifact.id, { actor: "мастер", note: "профиль сверил" });
  const detail = h.queue.enqueueExecutableArtifact(task.id);
  assert.equal(detail.task.state, "QUEUED");

  bedClear("bambu-a1");
  const preview = h.launch.preview(task.id);
  assert.equal(preview.state, "ready", "an accepted review no longer refuses the launch");

  await h.launch.launch(task.id, {});
  assert.equal(h.startCalls.length, 1);
  assert.equal(h.startCalls[0].plateGcodePath, "Metadata/plate_1.gcode");
});

test("HIGH-11: an operator's plate-2 export is started by ITS entry, not the adapter's plate_1", async () => {
  const { task, artifact } = seedSliced3mfUpload("Metadata/plate_2.gcode");
  h.artifacts.confirmAnalysisReview(artifact.id, { actor: "мастер" });
  h.queue.enqueueExecutableArtifact(task.id);
  bedClear("bambu-a1");

  await h.launch.launch(task.id, {});
  assert.equal(h.startCalls.length, 1);
  assert.equal(h.startCalls[0].plateGcodePath, "Metadata/plate_2.gcode");
});

test("HIGH-11: a package whose analysis names no payload entry is refused before anything is reserved", async () => {
  const { task, artifact } = seedUpload({
    name: "legacy.gcode.3mf",
    bytes: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), A1_GCODE]),
    detectedFormat: "3mf",
    verdict: "review",
    // What a pre-1.4.0 analysis recorded: a payload exists, nobody read it.
    data: { threeMfClass: "sliced", hasGcodePayload: true, printerModel: "Bambu Lab A1" },
    warnings: []
  });
  h.artifacts.confirmAnalysisReview(artifact.id, { actor: "мастер" });
  h.queue.enqueueExecutableArtifact(task.id);
  bedClear("bambu-a1");

  await assert.rejects(h.launch.launch(task.id, {}), /не определён G-code/);
  assert.equal(h.startCalls.length, 0);
  assert.equal(h.store.repositories.printRuns.findActiveByTask(task.id), null, "nothing reserved");
});

test("an uploaded plate package is delivered as-is, never wrapped a second time", async () => {
  const { task, artifact } = seedSliced3mfUpload();
  h.artifacts.confirmAnalysisReview(artifact.id, { actor: "мастер" });
  h.queue.enqueueExecutableArtifact(task.id);
  bedClear("bambu-a1");

  await h.launch.launch(task.id, {});
  // The bytes on the device are the artifact's own. Wrapping them would produce
  // a 3MF whose payload is another 3MF, and nothing downstream would notice —
  // the delivery check compares name and size, not the archive's contents.
  assert.equal(h.uploads.length, 1);
  assert.equal(h.uploads[0].bytes.byteLength, artifact.sizeBytes);
});

test("HIGH-05: re-analysing the SAME bytes with the SAME analyzer keeps the operator's answer", () => {
  const { task, artifact } = seedSliced3mfUpload();
  h.artifacts.confirmAnalysisReview(artifact.id, { actor: "мастер" });

  // A fresh run of the same analyzer over the same bytes: the same judgement.
  // Voiding the confirmation here is what fed the confirm → "stale" → re-analyse
  // → confirmation lost loop.
  const repos = h.store.repositories;
  const previous = repos.artifactAnalyses.latestForArtifact(artifact.id)!;
  repos.artifactAnalyses.insert({
    ...previous,
    id: newId(ID_PREFIX.artifactAnalysis),
    createdAt: "2026-08-15T12:00:00.000Z",
    updatedAt: "2026-08-15T12:00:00.000Z"
  });

  const detail = h.queue.enqueueExecutableArtifact(task.id);
  assert.equal(detail.task.state, "QUEUED");
});

test("the review acknowledgement lapses when a DIFFERENT analyzer version redoes the analysis", () => {
  const { task, artifact } = seedSliced3mfUpload();
  h.artifacts.confirmAnalysisReview(artifact.id, { actor: "мастер" });

  const repos = h.store.repositories;
  const previous = repos.artifactAnalyses.latestForArtifact(artifact.id)!;
  repos.artifactAnalyses.insert({
    ...previous,
    id: newId(ID_PREFIX.artifactAnalysis),
    analyzerVersion: "9.9.9",
    createdAt: "2026-08-15T12:00:00.000Z",
    updatedAt: "2026-08-15T12:00:00.000Z"
  });

  assert.throws(
    () => h.queue.enqueueExecutableArtifact(task.id),
    (error: unknown) => error instanceof JobError && /подтвержд/i.test((error as Error).message)
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Wrong printer — the preflight/delivery boundary
// ═══════════════════════════════════════════════════════════════════════════

test("wrong printer: the preview already blocks, and NO file is sent to it", async () => {
  // Sliced for the A1; the operator picks the K2.
  const { task } = seedGcodeUpload();
  h.queue.enqueueExecutableArtifact(task.id);
  bedClear("k2");

  const preview = h.launch.preview(task.id, "k2");
  const k2 = preview.candidates.find((c) => c.printerId === "k2")!;
  assert.equal(k2.eligible, false, "the preview knows the file names another machine");
  assert.ok(
    k2.problems.some((p) => p.code === "TARGET_PRINTER_MISMATCH" && p.kind === "blocker"),
    "and says which fact refuses it"
  );

  await assert.rejects(() => h.launch.launch(task.id, { printerId: "k2" }), JobError);
  // The load-bearing assertion: the refusal happened BEFORE the transfer, so no
  // stray file was left on a printer that was never going to run it.
  assert.deepEqual(h.uploads, [], "nothing was uploaded to the wrong printer");
  assert.deepEqual(h.startCalls, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// Material semantics
// ═══════════════════════════════════════════════════════════════════════════

test("material unknown: no false mismatch, a confirmable question instead", () => {
  const { task } = seedGcodeUpload();
  h.queue.enqueueExecutableArtifact(task.id);
  bedClear("bambu-a1");
  // The printer's config still says "PLA / PETG / TPU"; telemetry says nothing.
  h.knobs.loaded["bambu-a1"] = null;

  const preview = h.launch.preview(task.id);
  const a1 = preview.candidates.find((c) => c.printerId === "bambu-a1")!;
  assert.ok(
    !a1.problems.some((p) => p.code === "MATERIAL_MISMATCH"),
    "an unread spool is not a contradiction — this used to refuse every PETG job"
  );
  assert.equal(preview.state, "needs_confirmation");
  const confirmation = preview.confirmations.find((c) => c.code === "material_loaded");
  assert.ok(confirmation, "the operator is asked, by name, what is loaded");
  assert.match(confirmation!.label, /PETG/);
  assert.ok(confirmation!.effect, "and told what confirming it does");
});

test("material unknown: after the confirmation the launch proceeds and is audited", async () => {
  const { task } = seedGcodeUpload();
  h.queue.enqueueExecutableArtifact(task.id);
  bedClear("bambu-a1");
  h.knobs.loaded["bambu-a1"] = null;

  await assert.rejects(
    () => h.launch.launch(task.id, {}),
    /Требуется подтверждение/,
    "the launch refuses while the question is open"
  );

  const outcome = await h.launch.launch(task.id, {
    confirmations: ["material_loaded"],
    actor: "мастер"
  });
  assert.equal(h.startCalls.length, 1);
  assert.ok(outcome.steps.includes("material_confirmed"));
  const audited = h.store.repositories.audit
    .listByEntity("print_task", task.id)
    .find((e) => e.action === "material_confirmed");
  assert.equal(audited?.actor, "мастер", "who said it is part of the record");
});

test("material mismatch: telemetry reporting a DIFFERENT filament still blocks", () => {
  const { task } = seedGcodeUpload();
  h.queue.enqueueExecutableArtifact(task.id);
  bedClear("bambu-a1");
  h.knobs.loaded["bambu-a1"] = "PLA"; // the device says PLA; the job needs PETG

  const preview = h.launch.preview(task.id);
  const a1 = preview.candidates.find((c) => c.printerId === "bambu-a1")!;
  assert.equal(a1.eligible, false);
  assert.ok(a1.problems.some((p) => p.code === "MATERIAL_MISMATCH" && p.kind === "blocker"));
});

// ═══════════════════════════════════════════════════════════════════════════
// Remote start unsupported
// ═══════════════════════════════════════════════════════════════════════════

test("a printer whose adapter cannot start remotely is never an ordinary candidate", async () => {
  const { task } = seedGcodeUpload();
  h.queue.enqueueExecutableArtifact(task.id);
  bedClear("ender3");

  const preview = h.launch.preview(task.id, "ender3");
  const ender = preview.candidates.find((c) => c.printerId === "ender3")!;
  assert.equal(ender.eligible, false, "«совместим» would be a promise the launch cannot keep");
  const problem = ender.problems.find((p) => p.code === "REMOTE_START_UNSUPPORTED");
  assert.ok(problem, "and the reason is the adapter, named");
  assert.equal(problem!.kind, "blocker");
  assert.match(problem!.action, /с экрана принтера|другой принтер/i, "with a next action");
  assert.notEqual(preview.recommendedPrinterId, "ender3");

  await assert.rejects(() => h.launch.launch(task.id, { printerId: "ender3" }), JobError);
  assert.deepEqual(h.uploads, [], "nothing is pushed at an adapter that cannot receive it");
});

// ═══════════════════════════════════════════════════════════════════════════
// Idempotency, queue readiness and the delivery race
// ═══════════════════════════════════════════════════════════════════════════

test("idempotency: repeating a launch key returns the original run, not a second start", async () => {
  const { task } = seedGcodeUpload();
  h.queue.enqueueExecutableArtifact(task.id);
  bedClear("bambu-a1");

  const first = await h.launch.launch(task.id, { idempotencyKey: "launch:k" });
  const second = await h.launch.launch(task.id, { idempotencyKey: "launch:k" });

  assert.equal(second.run.runId, first.run.runId);
  assert.equal(second.run.deduplicated, true);
  assert.equal(h.startCalls.length, 1, "exactly one physical start");
});

test("two operators launching the same job at once produce ONE physical start", async () => {
  // Sequential idempotency is the easy half. This is the hard one: both calls
  // run their preflight before either has reserved anything, and both then
  // suspend on the upload — so the second is *inside* the operation when the
  // first commits. Only the reserve transaction, which re-reads the rows it
  // decides on, can separate them. The two callers are different people with
  // different keys, so the idempotency key cannot help here.
  const { task } = seedGcodeUpload();
  h.queue.enqueueExecutableArtifact(task.id);
  bedClear("bambu-a1");

  const results = await Promise.allSettled([
    h.launch.launch(task.id, { actor: "anna", idempotencyKey: "launch:anna" }),
    h.launch.launch(task.id, { actor: "boris", idempotencyKey: "launch:boris" })
  ]);

  assert.equal(h.startCalls.length, 1, "exactly one start command reached the device");
  assert.equal(
    results.filter((r) => r.status === "fulfilled").length,
    1,
    "and exactly one caller was told the print began"
  );
  const runs = h.store.repositories.printRuns.listByTask(task.id);
  assert.equal(runs.length, 1, "one run row, not two");
});

test("delivery race: a bed occupied DURING the transfer is caught by the final gate", async () => {
  const { task } = seedGcodeUpload();
  h.queue.enqueueExecutableArtifact(task.id);
  bedClear("bambu-a1");

  // The preflight passes, and the world changes while the bytes are in flight:
  // the upload hook opens a bed cycle for the printer, exactly as a finished
  // print would. Only the final gate — which re-reads every row inside the
  // dispatch transaction — can see this.
  const devices = h.devices as unknown as {
    deps: { uploadFile: (p: PrinterConfig, r: string, b: Uint8Array) => Promise<unknown> };
  };
  const original = devices.deps.uploadFile;
  devices.deps.uploadFile = async (printer, remotePath, bytes) => {
    const result = await original(printer, remotePath, bytes);
    h.store.repositories.bedCycles.insert({
      id: newId(ID_PREFIX.bedCycle),
      printerId: "bambu-a1",
      state: "AWAITING_CLEARANCE",
      assignmentId: null,
      createdAt: ISO,
      updatedAt: ISO,
      clearedAt: null,
      version: 1,
      metadata: {}
    });
    return result;
  };

  await assert.rejects(() => h.launch.launch(task.id, {}), JobError);
  assert.equal(h.uploads.length, 1, "the file did get delivered — that part succeeded");
  assert.deepEqual(h.startCalls, [], "but nothing started onto an occupied bed");
});

test("queue readiness answers per row, from the same preflight the launch runs", () => {
  const ready = seedGcodeUpload();
  h.queue.enqueueExecutableArtifact(ready.task.id);
  bedClear("bambu-a1");

  const rows = h.launch.queueReadiness();
  const row = rows.find((r) => r.taskId === ready.task.id)!;
  assert.equal(row.state, "ready");
  assert.equal(row.canLaunch, true);
  assert.match(row.summary, /Можно запустить/);
  assert.equal(row.printerId, "bambu-a1");
});

test("the queue's readiness page reads the queue once, not once per row", () => {
  // `readinessFor` needs the per-printer queue depth (a ranking tie-break), and
  // read it for itself. On a page that is itself a queue listing that made 26
  // full projections of the same queue — and the projection is the expensive
  // half: measured on a 25-row store it costs ~45 ms against ~1 ms for the raw
  // SELECT, because it joins the artifact, analysis and run of every row. At a
  // 6-second dashboard poll that was over a second of blocked event loop per
  // tick, spent re-deriving one Map.
  const seen: number[] = [];
  const service = h.queue as unknown as { listOpenQueue: () => unknown[] };
  const original = service.listOpenQueue.bind(h.queue);
  let calls = 0;
  service.listOpenQueue = () => {
    calls += 1;
    return original();
  };
  try {
    for (let i = 0; i < 5; i += 1) {
      const s = seedGcodeUpload();
      h.queue.enqueueExecutableArtifact(s.task.id);
    }
    calls = 0;
    const rows = h.launch.queueReadiness();
    seen.push(rows.length);
  } finally {
    service.listOpenQueue = original;
  }

  assert.equal(seen[0], 5, "all five rows answered");
  assert.equal(calls, 1, "and the queue was projected exactly once for the whole page");
});

test("readiness is answerable for one task by id, in the queue or out of it", () => {
  // The task panel's question, and the reason it needs its own answer: asking
  // for the queue page and filtering client-side evaluated the whole farm once
  // per row for a single row's answer, and returned NOTHING for a task past the
  // page limit or already out of the queue — a diagnostic screen going silent
  // for exactly the backlog nobody can see.
  const queued = seedGcodeUpload();
  h.queue.enqueueExecutableArtifact(queued.task.id);
  bedClear("bambu-a1");
  assert.equal(h.launch.readinessForTaskId(queued.task.id).canLaunch, true);

  // A DRAFT never appears in `listOpenQueue`, so the page could not answer for it.
  const draft = seedGcodeUpload();
  assert.equal(
    h.launch.queueReadiness().find((r) => r.taskId === draft.task.id),
    undefined,
    "the queue page has nothing to say about a task that is not in the queue"
  );
  const row = h.launch.readinessForTaskId(draft.task.id);
  assert.equal(row.taskId, draft.task.id);
  assert.equal(row.canLaunch, false);
  assert.ok(row.summary.length > 0, "and the per-task answer still says something useful");
});

test("queue readiness names the obstacle instead of reporting QUEUED as ready", () => {
  const { task } = seedGcodeUpload();
  h.queue.enqueueExecutableArtifact(task.id);
  // Every printer is mid-print. The task's own row is unchanged — still QUEUED,
  // still WAITING — and that pair used to render as «готово к запуску».
  for (const id of ["bambu-a1", "k2", "ender3"]) h.knobs.status[id] = "printing";

  const row = h.launch.queueReadiness().find((r) => r.taskId === task.id)!;
  assert.equal(
    h.store.repositories.queue.findByTaskId(task.id)?.state,
    "WAITING",
    "the queue row itself says nothing is wrong"
  );
  assert.equal(row.state, "blocked");
  assert.equal(row.canLaunch, false);
  assert.ok(row.summary.length > 0, "and the readiness says what is in the way");
  assert.ok(row.primaryProblem, "with one named cause, not a bare «нет готового принтера»");
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 3 — what an assignment may claim (HIGH-12/13) and the FAILED retry (HIGH-16)
// ═══════════════════════════════════════════════════════════════════════════

/** A queued, launchable G-code task. */
function queuedGcodeTask(): PrintTask {
  const { task } = seedGcodeUpload();
  return h.queue.enqueueExecutableArtifact(task.id).task;
}

function assignmentsOf(taskId: string) {
  return h.store.repositories.assignments.listByTask(taskId);
}

test("HIGH-12: a manual launch on the printer a DRAFT plan suggested neither reuses the proposal nor needs the plan", async () => {
  const task = queuedGcodeTask();
  bedClear("bambu-a1");
  const draft = h.scheduler.buildDraftPlan();
  const proposal = draft.assignments.find((a) => a.assignment.taskId === task.id)?.assignment;
  assert.ok(proposal, JSON.stringify(draft.unplaced));
  assert.equal(proposal.printerId, "bambu-a1");
  assert.equal(proposal.state, "PROPOSED");

  // This used to reuse the draft's proposal and fail «подтвердите план перед запуском».
  await h.launch.launch(task.id, { printerId: "bambu-a1" });
  assert.equal(h.startCalls.length, 1);

  const run = h.store.repositories.printRuns.findActiveByTask(task.id);
  assert.ok(run);
  const used = h.store.repositories.assignments.getById(run.assignmentId ?? "");
  assert.equal(used?.source, "manual", "the operator's own placement ran");
  assert.notEqual(used?.id, proposal.id);
  // The draft's suggestion for this task is withdrawn, and the draft — now an
  // answer to a question that changed — cannot be confirmed as it stands.
  const withdrawn = h.store.repositories.assignments.getById(proposal.id);
  assert.ok(withdrawn?.invalidatedAt);
  assert.match(withdrawn?.invalidatedReason ?? "", /вручную/);
  assert.throws(() => h.scheduler.confirmPlan(draft.plan.id), /План устарел/);
});

test("HIGH-12: placing a task by hand withdraws the draft's proposal for it; the draft must be recomputed", () => {
  const task = queuedGcodeTask();
  bedClear("bambu-a1");
  const draft = h.scheduler.buildDraftPlan();
  const proposal = draft.assignments.find((a) => a.assignment.taskId === task.id)?.assignment;
  assert.ok(proposal);

  const manual = h.queue.assignTask(task.id, "bambu-a1", { reason: "оператор решил сам" });
  assert.equal(manual.source, "manual");
  assert.ok(h.store.repositories.assignments.getById(proposal.id)?.invalidatedAt);
  // The task is still queued work — only the draft's answer for it is gone.
  assert.throws(() => h.scheduler.confirmPlan(draft.plan.id), /часть предложений снята/);
  // The recompute treats the operator's placement as decided: the task is not
  // proposed anywhere again, so confirming can never give it a second placement.
  const fresh = h.scheduler.recomputeRecommendations("assignment_changed");
  assert.notEqual(fresh.plan.id, draft.plan.id);
  assert.ok(!fresh.assignments.some((a) => a.assignment.taskId === task.id && a.assignment.planId === fresh.plan.id));
});

test("HIGH-12: a DRAFT plan's proposal for another task does not take the printer from a manual start", async () => {
  const proposed = queuedGcodeTask();
  bedClear("bambu-a1");
  const draft = h.scheduler.buildDraftPlan();
  assert.equal(draft.assignments.find((a) => a.assignment.taskId === proposed.id)?.assignment.printerId, "bambu-a1");

  const urgent = queuedGcodeTask();
  await h.launch.launch(urgent.id, { printerId: "bambu-a1" });
  assert.equal(h.startCalls.length, 1);
  assert.ok(h.store.repositories.printRuns.findActiveByTask(urgent.id));
});

test("HIGH-13: an invalidated placement holds neither its task nor its printer", async () => {
  const first = queuedGcodeTask();
  const placed = h.queue.assignTask(first.id, "bambu-a1", { reason: "оператор" });
  h.queue.invalidateAssignment(placed.id, "оператор передумал");
  bedClear("bambu-a1");

  // Another task may take the printer the withdrawn placement named…
  const other = queuedGcodeTask();
  await h.launch.launch(other.id, { printerId: "bambu-a1" });
  assert.equal(h.startCalls.length, 1);
  h.lifecycle.completeRun(h.store.repositories.printRuns.findActiveByTask(other.id)!.id, "SUCCEEDED");
  bedClear("bambu-a1");

  // …and the task itself can be placed again (it used to be «уже назначено»).
  const again = h.queue.assignTask(first.id, "bambu-a1", { reason: "снова" });
  assert.notEqual(again.id, placed.id);
  assert.equal(assignmentsOf(first.id).filter((a) => a.invalidatedAt === null && a.state === "PROPOSED").length, 1);
});

test("HIGH-13: a confirmed or manual placement still holds the printer — only advice and history stopped holding it", () => {
  const first = queuedGcodeTask();
  h.queue.assignTask(first.id, "bambu-a1", { reason: "оператор" });
  const second = queuedGcodeTask();
  assert.throws(() => h.queue.assignTask(second.id, "bambu-a1"), /уже занят назначением/);
  assert.throws(() => h.queue.assignTask(first.id, "bambu-a1"), /уже назначено/);
});

test("a launch whose delivery failed withdraws the placement it made: neither the job nor the printer stays held", async () => {
  // The placement used to stay. The job was then tied to that printer, the
  // printer refused every other job («уже занят назначением») — and nothing on
  // the screen could withdraw it.
  const task = queuedGcodeTask();
  bedClear("bambu-a1");
  h.knobs.failUpload.add("bambu-a1");
  await assert.rejects(() => h.launch.launch(task.id, { printerId: "bambu-a1" }));
  assert.equal(h.startCalls.length, 0, "nothing was started");
  const [own] = assignmentsOf(task.id);
  assert.ok(own?.invalidatedAt, "the attempt's own placement is withdrawn");
  assert.match(own.invalidatedReason ?? "", /запуск не состоялся/);

  // The printer takes another job, and the job itself launches once the link is back.
  h.knobs.failUpload.clear();
  const other = queuedGcodeTask();
  await h.launch.launch(other.id, { printerId: "bambu-a1" });
  h.lifecycle.completeRun(h.store.repositories.printRuns.findActiveByTask(other.id)!.id, "SUCCEEDED");
  bedClear("bambu-a1");
  await h.launch.launch(task.id, { printerId: "bambu-a1" });
  assert.deepEqual(
    h.startCalls.map((c) => c.printerId),
    ["bambu-a1", "bambu-a1"]
  );
});

test("a placement made before the attempt is a decision: a failed delivery leaves it in place", async () => {
  const task = queuedGcodeTask();
  const placed = h.queue.assignTask(task.id, "bambu-a1", { reason: "оператор" });
  bedClear("bambu-a1");
  h.knobs.failUpload.add("bambu-a1");
  await assert.rejects(() => h.launch.launch(task.id, { printerId: "bambu-a1" }));
  assert.equal(h.store.repositories.assignments.getById(placed.id)?.invalidatedAt, null);
});

test("a printer held by another job's placement is refused in the preview, not one step into the launch", async () => {
  // The preview used to be green here and the launch then failed at the
  // placement step with «уже занят назначением asg_…» — a refusal the preview
  // could have known about, which is exactly what the one policy forbids.
  const first = queuedGcodeTask();
  h.queue.assignTask(first.id, "bambu-a1", { reason: "оператор" });
  bedClear("bambu-a1");
  const second = queuedGcodeTask();
  const preview = h.launch.preview(second.id, "bambu-a1");
  const a1 = preview.candidates.find((c) => c.printerId === "bambu-a1")!;
  assert.equal(a1.eligible, false);
  assert.ok(a1.blockers.some((b) => b.code === "PRINTER_RESERVED"), JSON.stringify(a1.blockers));
  assert.equal(preview.primaryProblem?.code, "PRINTER_RESERVED");
  assert.equal(h.launch.readinessForTaskId(second.id).canLaunch, false, "the queue row says so too");
  await assert.rejects(() => h.launch.launch(second.id, { printerId: "bambu-a1" }), /занят/);
  assert.equal(h.uploads.length, 0, "nothing was delivered for a start that could not happen");
});

test("after a finished print, «Стол свободен» in the launch window is enough: the part-removal operation closes with it", async () => {
  // Found end to end (ops/verify): a finished print leaves the bed
  // AWAITING_CLEARANCE *and* an open PART_REMOVAL operation — one fact, two
  // records. The launch window offered the «Стол свободен» tick for the bed, but
  // the operation's own blocker made the printer ineligible first, so the tick —
  // which closes that very operation — was never applied and every repeat print
  // on the same printer was refused.
  const first = queuedGcodeTask();
  bedClear("bambu-a1");
  await h.launch.launch(first.id, { printerId: "bambu-a1" });
  h.lifecycle.completeRun(h.store.repositories.printRuns.findActiveByTask(first.id)!.id, "SUCCEEDED");
  const removal = h.store.repositories.manualOperations
    .listByPrinter("bambu-a1")
    .find((op) => op.type === "PART_REMOVAL" && op.state !== "COMPLETED");
  assert.ok(removal, "the finished print opened the part-removal operation");

  const next = queuedGcodeTask();
  const preview = h.launch.preview(next.id, "bambu-a1");
  const a1 = preview.candidates.find((c) => c.printerId === "bambu-a1")!;
  assert.equal(a1.eligible, true, `only questions a person answers remain: ${JSON.stringify(a1.blockers)}`);
  assert.deepEqual(preview.confirmations.filter((c) => c.required).map((c) => c.code), ["bed_clear"]);
  assert.equal(preview.state, "needs_confirmation");

  await assert.rejects(() => h.launch.launch(next.id, { printerId: "bambu-a1" }), /Стол свободен/, "without the tick: refused");
  await h.launch.launch(next.id, { printerId: "bambu-a1", confirmations: ["bed_clear"] });
  assert.equal(h.startCalls.length, 2, "with it: started");
  assert.equal(h.store.repositories.manualOperations.getById(removal.id)?.state, "COMPLETED", "and the operation is closed, by the same confirmation");
});

test("the automatic queue is not given that tick: a part on the plate still refuses an auto start", async () => {
  const first = queuedGcodeTask();
  bedClear("bambu-a1");
  await h.launch.launch(first.id, { printerId: "bambu-a1" });
  h.lifecycle.completeRun(h.store.repositories.printRuns.findActiveByTask(first.id)!.id, "SUCCEEDED");
  const next = queuedGcodeTask();
  const a1 = h.launch.preview(next.id, "bambu-a1", { mode: "auto" }).candidates.find((c) => c.printerId === "bambu-a1")!;
  assert.equal(a1.eligible, false);
  assert.ok(a1.blockers.some((b) => b.code === "MANUAL_OPERATION_REQUIRED"), JSON.stringify(a1.blockers));
});

test("HIGH-16: a FAILED print retried goes back INTO the queue, at the tail, and can be launched again", async () => {
  const task = queuedGcodeTask();
  const waiting = queuedGcodeTask();
  bedClear("bambu-a1");
  await h.launch.launch(task.id, { printerId: "bambu-a1" });
  const run = h.store.repositories.printRuns.findActiveByTask(task.id)!;
  h.lifecycle.completeRun(run.id, "FAILED", { reason: "отлип от стола" });
  assert.equal(h.store.repositories.tasks.getById(task.id)?.state, "FAILED");
  assert.equal(h.store.repositories.queue.findByTaskId(task.id)?.state, "RELEASED");

  const retried = h.queue.releaseTask(task.id);
  assert.equal(retried.state, "QUEUED");
  const entry = h.store.repositories.queue.findByTaskId(task.id)!;
  assert.equal(entry.state, "WAITING", "a queued task is IN the queue");
  const waitingEntry = h.store.repositories.queue.findByTaskId(waiting.id)!;
  assert.ok(entry.position > waitingEntry.position, "the retry joins the tail");
  assert.ok(h.queue.listOpenQueue().some((row) => row.task.id === task.id));
  // The failed attempt stays in history.
  assert.equal(h.store.repositories.printRuns.getById(run.id)?.state, "FAILED");

  // The failed part is still on the plate: clear it, and the retry launches.
  bedClear("bambu-a1");
  await h.launch.launch(task.id, { printerId: "bambu-a1" });
  assert.equal(h.startCalls.length, 2);
  assert.notEqual(h.store.repositories.printRuns.findActiveByTask(task.id)?.id, run.id);
});

