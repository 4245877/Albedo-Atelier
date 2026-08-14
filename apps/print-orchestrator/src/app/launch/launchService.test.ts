import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { JobError, ValidationError } from "../../core/errors";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { Artifact, ArtifactAnalysis, PrintTask } from "../../domain/print/types";
import type { ProfileRevision, ProfileSet, ProfileType, SliceVariant } from "../../domain/slicing/types";
import { openPrintQueueStore } from "../../infra/db/store";
import type { PrinterConfig } from "../../infra/printers/config";
import { buildDeviceFileName, type PrinterFilesListing } from "../../infra/printers/files";
import { ArtifactStorage } from "../../infra/storage/artifactStorage";
import { ANALYZER_VERSION } from "../artifacts/analyzers";
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
 * The operator's launch scenario, end to end over a real in-memory SQLite store
 * and fake adapters — no network, no device.
 *
 * The bug this suite exists for: a Bambu job that was sliced, packaged, uploaded
 * and VERIFIED could not be started from either button in the UI. Both paths
 * validated the on-device path *without* the target printer, fell back to the
 * Klipper G-code set, and refused the `.gcode.3mf` plate package the system had
 * built itself. The queue said "ГОТОВО К ЗАПУСКУ" and nothing ever started.
 *
 * So the central assertions here are physical: after `launch()`, did a start
 * command actually reach the device, and with WHICH file.
 */

const GCODE = Buffer.from(
  ";FLAVOR:Marlin\n;printer_model = Bambu Lab A1\nG28\nG1 X10 Y10 E1 F1200\nM104 S0\n",
  "utf8"
);
const GCODE_SHA = createHash("sha256").update(GCODE).digest("hex");
const ISO = "2026-08-14T12:00:00.000Z";

/** The A1 speaks Bambu (FTPS upload + LIST); the K2 speaks Moonraker. */
const A1: PrinterConfig = {
  id: "bambu-a1",
  name: "Bambu Lab A1 Combo",
  model: "Bambu Lab A1",
  type: "FDM",
  protocol: "bambu",
  host: "127.0.0.1",
  // `039…` is the A1 serial prefix: the plate-package builder derives the model
  // from it, so a placeholder serial makes the whole delivery step fail.
  serial: "0391A2B3C4D5E6F",
  accessCode: "12345678",
  allowInsecureTls: true,
  material: "PETG",
  enabled: true
} as unknown as PrinterConfig;

const K2: PrinterConfig = {
  id: "k2",
  name: "Creality K2",
  model: "Creality K2",
  type: "FDM",
  protocol: "moonraker",
  host: "127.0.0.2",
  material: "PLA",
  enabled: true
} as unknown as PrinterConfig;

const PRINTERS = [A1, K2];

/** The on-device name a Bambu delivery takes: `<stem>-<sha8>.gcode.3mf`. */
const BAMBU_DEVICE_FILE = buildDeviceFileName({ name: "3U-default.gcode", sha256: GCODE_SHA }, A1);

interface Knobs {
  online: Record<string, boolean>;
  status: Record<string, SchedulerPrinterRef["status"]>;
  material: Record<string, string | null>;
  nozzle: Record<string, number | null>;
  failUpload: boolean;
  failStart: string | null;
}

interface Harness {
  store: PrintQueueStore;
  queue: PrintQueueService;
  devices: DeviceArtifactService;
  dispatch: DispatchService;
  lifecycle: RunLifecycleService;
  launch: LaunchService;
  onDevice: Map<string, { path: string; size: number }[]>;
  uploads: { printerId: string; remotePath: string }[];
  startCalls: { printerId: string; file: string }[];
  knobs: Knobs;
}

let TMP: string;
let h: Harness;

beforeEach(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "launch-"));
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
  const knobs: Knobs = {
    online: { "bambu-a1": true, k2: true },
    status: { "bambu-a1": "idle", k2: "idle" },
    material: { "bambu-a1": "PETG", k2: "PLA" },
    nozzle: { "bambu-a1": 0.4, k2: 0.4 },
    failUpload: false,
    failStart: null
  };

  const queue = new PrintQueueService(store, {
    now: () => new Date(ISO),
    isPrinterConfigured: (id) => PRINTERS.some((p) => p.id === id),
    // Required for promotion to name the file the TARGET device starts: without
    // it the on-device name defaults to `.gcode` even for a Bambu.
    resolvePrinter: (id) => PRINTERS.find((p) => p.id === id)
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

  const devices = new DeviceArtifactService({
    store,
    storage,
    resolvePrinter: (id) => PRINTERS.find((p) => p.id === id),
    listFiles,
    uploadFile: async (printer, remotePath, bytes) => {
      if (knobs.failUpload) throw new Error("устройство отклонило загрузку");
      uploads.push({ printerId: printer.id, remotePath });
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
      material: knobs.material[p.id] ?? null,
      nozzleMm: knobs.nozzle[p.id] ?? null,
      buildVolume: { x: 256, y: 256, z: 256 },
      online: knobs.online[p.id] ?? true,
      status: knobs.status[p.id] ?? "idle",
      remoteStartSupported: true,
      ams: false,
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

  // The blob the upload path reads.
  const key = `sha256/${GCODE_SHA.slice(0, 2)}/${GCODE_SHA}`;
  const blobPath = storage.resolvePath(key);
  fs.mkdirSync(path.dirname(blobPath), { recursive: true });
  fs.writeFileSync(blobPath, GCODE);

  return { store, queue, devices, dispatch, lifecycle, launch, onDevice, uploads, startCalls, knobs };
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
 * The exact state the operator's farm was in: a `3U-default.3mf` model, sliced
 * for the A1, analysed as PETG / 0.4 mm / 1 h 29 m / 31 g, promoted to the queue.
 */
function seedQueuedBambuJob(targetPrinterId = "bambu-a1"): { task: PrintTask; variant: SliceVariant } {
  const repos = h.store.repositories;
  const printer = PRINTERS.find((p) => p.id === targetPrinterId)!;
  const flavor = targetPrinterId === "k2" ? "klipper" : "marlin";

  const source: Artifact = {
    id: newId(ID_PREFIX.artifact),
    kind: "model",
    name: "3U-default.3mf",
    source: "sha256/aa/source3mf",
    sizeBytes: 900_000,
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
    name: "3U-default.gcode",
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
    estimatedDurationS: 5329,
    estimatedFilamentG: 31.1,
    material: "PETG",
    nozzleDiameterMm: 0.4,
    layerHeightMm: 0.2,
    warnings: [],
    blockers: [],
    data: { size: [100, 100, 100], flavor, printerModel: printer.model },
    error: null,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {}
  };
  repos.artifactAnalyses.insert(analysis);

  const machine = revision("machine", `${targetPrinterId} 0.4`, {
    nozzle_diameter: ["0.4"],
    printer_model: printer.model,
    gcode_flavor: flavor,
    printable_area: ["0x0", "256x0", "256x256", "0x256"],
    printable_height: "256"
  });
  const process = revision("process", "0.2 standard", { layer_height: "0.2" });
  const filament = revision("filament", "PETG", { filament_type: ["PETG"] });

  const set: ProfileSet = {
    id: newId(ID_PREFIX.profileSet),
    name: `${printer.name} · PETG`,
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
    title: "3U-default.3mf",
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
    orcaEtaS: 5329,
    filamentG: 31.1,
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

  const detail = h.queue.promoteSliceVariant(variant.id);
  return { task: detail.task, variant };
}

/** Confirms a free bed so a launch needs no operator checkbox. */
function bedClear(printerId = "bambu-a1"): void {
  h.lifecycle.clearBed(printerId, { confirmation: "part_removed", actor: "test" });
}

// ── The reported bug ─────────────────────────────────────────────────────────

test("a prepared Bambu job launches and the .gcode.3mf plate package reaches the device", async () => {
  const { task } = seedQueuedBambuJob();
  bedClear();

  const outcome = await h.launch.launch(task.id, { confirmations: [] });

  // The physical assertion: a start command left the orchestrator, for THIS
  // printer, naming the plate package — not the source model, not the raw G-code.
  assert.deepEqual(h.startCalls, [{ printerId: "bambu-a1", file: BAMBU_DEVICE_FILE }]);
  assert.match(BAMBU_DEVICE_FILE, /\.gcode\.3mf$/);
  assert.equal(outcome.printerId, "bambu-a1");
  assert.ok(outcome.run.runId);
});

test("the launch never sends the source .3mf or the bare .gcode artifact name", async () => {
  const { task } = seedQueuedBambuJob();
  bedClear();
  await h.launch.launch(task.id, {});

  const sent = h.startCalls[0].file;
  assert.notEqual(sent, "3U-default.3mf", "the source model is not an executable");
  assert.notEqual(sent, "3U-default.gcode", "the artifact name is not the device path");
  assert.ok(sent.includes(GCODE_SHA.slice(0, 8)), "the device name carries the content hash");
});

test("plain G-code still launches on a Moonraker printer", async () => {
  const { task } = seedQueuedBambuJob("k2");
  h.knobs.material.k2 = "PETG";
  bedClear("k2");

  await h.launch.launch(task.id, {});
  assert.equal(h.startCalls.length, 1);
  assert.match(h.startCalls[0].file, /\.gcode$/, "Klipper gets a bare .gcode, not a 3MF");
});

// ── Preview: what the card shows ─────────────────────────────────────────────

test("the preview reports the measured facts instead of placeholders", () => {
  const { task } = seedQueuedBambuJob();
  const preview = h.launch.preview(task.id);

  assert.equal(preview.displayTitle, "3U-default", "the extension is not part of the model's name");
  assert.equal(preview.material, "PETG");
  assert.equal(preview.nozzleMm, 0.4);
  assert.equal(preview.etaSeconds, 5329);
  assert.equal(preview.etaText, "≈ 1 ч 29 мин");
  assert.equal(Math.round(preview.filamentG!), 31);
});

test("a printer reporting filament with no AMS is described as an external spool", () => {
  const { task } = seedQueuedBambuJob();
  const preview = h.launch.preview(task.id);
  assert.equal(preview.materialSource, "external");
});

test("preview is pure — it uploads nothing and starts nothing", () => {
  const { task } = seedQueuedBambuJob();
  h.launch.preview(task.id);
  h.launch.preview(task.id, "k2");
  assert.deepEqual(h.uploads, []);
  assert.deepEqual(h.startCalls, []);
});

// ── Bed clearance ────────────────────────────────────────────────────────────

/** Runs a print to completion so the bed genuinely holds a finished part. */
async function leaveFinishedPartOnBed(): Promise<void> {
  const { task } = seedQueuedBambuJob();
  bedClear();
  const outcome = await h.launch.launch(task.id, {});
  h.lifecycle.completeRun(outcome.run.runId, "SUCCEEDED");
  h.startCalls.length = 0;
  h.uploads.length = 0;
}

test("a bed still holding a finished part asks for confirmation and blocks without it", async () => {
  await leaveFinishedPartOnBed();
  assert.equal(
    h.store.repositories.bedCycles.findOpenByPrinter("bambu-a1")?.state,
    "AWAITING_CLEARANCE"
  );

  const { task } = seedQueuedBambuJob();
  const preview = h.launch.preview(task.id);

  const bed = preview.confirmations.find((c) => c.code === "bed_clear");
  assert.ok(bed, "an occupied bed must surface a confirmation, not a silent refusal");
  assert.equal(bed.required, true);
  assert.equal(preview.state, "needs_confirmation", "…and the card must not claim «готово»");

  await assert.rejects(() => h.launch.launch(task.id, { confirmations: [] }), ValidationError);
  assert.deepEqual(h.startCalls, [], "nothing was sent");
});

test("confirming the bed clears the cycle and lets the same launch through", async () => {
  await leaveFinishedPartOnBed();
  const { task } = seedQueuedBambuJob();

  const outcome = await h.launch.launch(task.id, { confirmations: ["bed_clear"] });

  assert.ok(outcome.steps.includes("bed_confirmed"));
  assert.equal(h.startCalls.length, 1, "the print started after the confirmation");
});

test("confirming a bed with no tracked history at all establishes a CLEAR cycle", () => {
  // The farm's real starting state: `bed_cycles` is empty because no print has
  // ever run under this model. `clearBed` used to refuse with "открытый цикл
  // стола не найден", so the one exit from an unknown bed was unreachable.
  assert.equal(h.store.repositories.bedCycles.findOpenByPrinter("bambu-a1"), null);
  h.lifecycle.clearBed("bambu-a1", { confirmation: "part_removed", actor: "operator" });

  const cycles = h.store.repositories.bedCycles.listByPrinter("bambu-a1");
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].state, "CLEAR");
  assert.equal(cycles[0].metadata.established, true, "recorded as an assertion, not a print result");
});

test("an online, idle printer with no tracked cycle needs no checkbox", () => {
  // Documents the existing inference (`evidence.bedStateFor`): fresh telemetry
  // reporting idle reads as CLEAR. Asking anyway on every launch is what trains
  // operators to click through safety prompts without reading them.
  const { task } = seedQueuedBambuJob();
  const preview = h.launch.preview(task.id);
  assert.deepEqual(preview.confirmations, []);
  assert.equal(preview.state, "ready");
});

// ── Printer choice ───────────────────────────────────────────────────────────

test("auto-select picks the printer holding the right filament", () => {
  const { task } = seedQueuedBambuJob();
  bedClear();
  const preview = h.launch.preview(task.id);

  assert.equal(preview.recommendedPrinterId, "bambu-a1");
  const chosen = preview.candidates.find((c) => c.printerId === "bambu-a1")!;
  assert.match(chosen.reason, /PETG/, "the UI must be able to say WHY");
});

test("a manual override honours the operator's printer when it is eligible", async () => {
  const { task } = seedQueuedBambuJob("k2");
  h.knobs.material.k2 = "PETG";
  bedClear("k2");

  await h.launch.launch(task.id, { printerId: "k2" });
  assert.equal(h.startCalls[0].printerId, "k2");
});

test("a manual override cannot push past a safety blocker", async () => {
  const { task } = seedQueuedBambuJob(); // sliced for the A1, pinned to it
  bedClear("k2");

  // The K2 is online and idle, but this G-code was built for the A1.
  await assert.rejects(
    () => h.launch.launch(task.id, { printerId: "k2", confirmations: ["bed_clear"] }),
    JobError
  );
  assert.deepEqual(h.startCalls, [], "«всё равно печатать» is not offered for a blocker");
});

test("an incompatible material blocks the printer and says so in operator language", () => {
  const { task } = seedQueuedBambuJob();
  h.knobs.material["bambu-a1"] = "PLA"; // PETG job, PLA loaded

  const preview = h.launch.preview(task.id);
  const a1 = preview.candidates.find((c) => c.printerId === "bambu-a1")!;
  assert.equal(a1.eligible, false);
  const problem = a1.problems.find((p) => p.code === "material_mismatch");
  assert.ok(problem, "the mismatch must be reported");
  assert.equal(problem.kind, "blocker");
  assert.match(problem.title, /материал/i);
  assert.ok(problem.technical.includes("material_mismatch"), "the code stays in diagnostics");
});

test("a nozzle mismatch blocks the launch", () => {
  const { task } = seedQueuedBambuJob();
  h.knobs.nozzle["bambu-a1"] = 0.6; // sliced for 0.4

  const preview = h.launch.preview(task.id);
  const a1 = preview.candidates.find((c) => c.printerId === "bambu-a1")!;
  assert.equal(a1.eligible, false);
  assert.ok(a1.problems.some((p) => p.code === "nozzle_mismatch" && p.kind === "blocker"));
});

// ── Printer availability ─────────────────────────────────────────────────────

test("an offline printer is not recommended and explains itself", () => {
  const { task } = seedQueuedBambuJob();
  h.knobs.online["bambu-a1"] = false;
  h.knobs.status["bambu-a1"] = "offline";

  const preview = h.launch.preview(task.id);
  assert.equal(preview.recommendedPrinterId, null);
  assert.equal(preview.state, "blocked");
  const a1 = preview.candidates.find((c) => c.printerId === "bambu-a1")!;
  assert.ok(a1.problems.some((p) => p.code === "printer_offline"));
});

test("a busy printer does not accept a second job", async () => {
  const { task } = seedQueuedBambuJob();
  h.knobs.status["bambu-a1"] = "printing";
  bedClear();

  await assert.rejects(() => h.launch.launch(task.id, { confirmations: ["bed_clear"] }));
  assert.deepEqual(h.startCalls, []);
});

// ── Delivery ─────────────────────────────────────────────────────────────────

test("the launch uploads the file itself — the operator never opens the file browser", async () => {
  const { task } = seedQueuedBambuJob();
  bedClear();
  assert.deepEqual(h.onDevice.get("bambu-a1") ?? [], [], "nothing on the device yet");

  await h.launch.launch(task.id, {});

  assert.equal(h.uploads.length, 1, "the launch delivered the package");
  assert.equal(h.uploads[0].remotePath, BAMBU_DEVICE_FILE);
  assert.equal(h.startCalls.length, 1);
});

test("an already-verified file is not re-uploaded", async () => {
  const { task } = seedQueuedBambuJob();
  bedClear();
  await h.launch.launch(task.id, {});
  const afterFirst = h.uploads.length;

  // A second launch of the same task is refused (a run already holds it), but
  // the delivery step must not have re-pushed bytes before that refusal.
  await h.launch.launch(task.id, { idempotencyKey: "k" }).catch(() => {});
  assert.equal(h.uploads.length, afterFirst, "verified bytes are left alone");
});

test("a failed upload refuses the launch and sends no start command", async () => {
  const { task } = seedQueuedBambuJob();
  bedClear();
  h.knobs.failUpload = true;

  await assert.rejects(() => h.launch.launch(task.id, {}));
  assert.deepEqual(h.startCalls, [], "never start what was not delivered");
});

test("a rejected start surfaces as a failure and leaves no phantom run", async () => {
  const { task } = seedQueuedBambuJob();
  bedClear();
  h.knobs.failStart = "принтер отклонил команду";

  await assert.rejects(() => h.launch.launch(task.id, {}));
  const runs = h.store.repositories.printRuns.listByTask(task.id);
  assert.ok(
    runs.every((r) => r.state !== "RUNNING"),
    "a refused start must not leave a RUNNING run behind"
  );
});

// ── Double click / refresh ───────────────────────────────────────────────────

test("the same idempotency key never starts a second print", async () => {
  const { task } = seedQueuedBambuJob();
  bedClear();
  const key = "launch:double-click";

  const first = await h.launch.launch(task.id, { idempotencyKey: key });
  const second = await h.launch.launch(task.id, { idempotencyKey: key });

  assert.equal(second.run.runId, first.run.runId, "the retry returned the original run");
  assert.equal(h.startCalls.length, 1, "exactly one physical start");
});

test("two concurrent clicks produce at most one start", async () => {
  const { task } = seedQueuedBambuJob();
  bedClear();
  const key = "launch:concurrent";

  const results = await Promise.allSettled([
    h.launch.launch(task.id, { idempotencyKey: key }),
    h.launch.launch(task.id, { idempotencyKey: key })
  ]);

  assert.ok(results.some((r) => r.status === "fulfilled"), "one of them started the print");
  assert.equal(h.startCalls.length, 1, "the device was commanded exactly once");
});

test("a launch without a key still cannot double-start a task", async () => {
  const { task } = seedQueuedBambuJob();
  bedClear();
  await h.launch.launch(task.id, {});
  await assert.rejects(() => h.launch.launch(task.id, {}), "an active run holds the task");
  assert.equal(h.startCalls.length, 1);
});

// ── State machine ────────────────────────────────────────────────────────────

test("the preview reports «running» once a run holds the task", async () => {
  const { task } = seedQueuedBambuJob();
  bedClear();
  await h.launch.launch(task.id, {});

  const preview = h.launch.preview(task.id);
  assert.equal(preview.state, "running");
  assert.ok(preview.activeRunId, "the live run is named so the UI can follow it");
});
