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
}

interface Harness {
  store: PrintQueueStore;
  queue: PrintQueueService;
  artifacts: ArtifactService;
  devices: DeviceArtifactService;
  dispatch: DispatchService;
  lifecycle: RunLifecycleService;
  launch: LaunchService;
  storage: ArtifactStorage;
  uploads: { printerId: string; remotePath: string; bytes: Uint8Array }[];
  startCalls: { printerId: string; file: string }[];
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
    failStart: null
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
    unknownEtaAssumptionS: 4 * 3600
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
    startPhysical: async (printerId, file) => {
      if (knobs.failStart) throw new Error(knobs.failStart);
      startCalls.push({ printerId, file });
    },
    classifyError: () => "unknown",
    listFiles,
    evaluateEligibility: (input) => eligibility().evaluate(input),
    now: () => new Date(ISO)
  };

  const dispatch = new DispatchService(deps);
  const lifecycle = new RunLifecycleService(store, { now: () => new Date(ISO) });
  const schedule = new OperatorScheduleService(store, { now: () => new Date(ISO) });
  const manualOperations = new ManualOperationService(store, schedule, { now: () => new Date(ISO) });

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
function seedSliced3mfUpload() {
  return seedUpload({
    name: "bracket.gcode.3mf",
    // A ZIP is what the detector sees; the 3MF analyzer then finds the plate.
    bytes: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), A1_GCODE]),
    detectedFormat: "3mf",
    verdict: "review",
    data: { threeMfClass: "sliced", hasGcodePayload: true, targetPrinter: "Bambu Lab A1" },
    warnings: [
      { code: "threemf_sliced_payload", message: "Файл уже нарезан для «Bambu Lab A1»" }
    ]
  });
}

function bedClear(printerId: string): void {
  h.lifecycle.clearBed(printerId, { confirmation: "part_removed", actor: "test" });
}

// ═══════════════════════════════════════════════════════════════════════════
// G-code: upload → analyze → enqueue → preview → launch → run
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
// Sliced 3MF: upload → review → confirm → enqueue → preview → launch
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

test("the review acknowledgement lapses when the analysis is redone", () => {
  const { task, artifact } = seedSliced3mfUpload();
  h.artifacts.confirmAnalysisReview(artifact.id, { actor: "мастер" });

  // A fresh analysis of the same bytes: nobody has read THIS one.
  const repos = h.store.repositories;
  const previous = repos.artifactAnalyses.latestForArtifact(artifact.id)!;
  repos.artifactAnalyses.insert({
    ...previous,
    id: newId(ID_PREFIX.artifactAnalysis),
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
