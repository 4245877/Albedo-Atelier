import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { Artifact, ArtifactAnalysis, PrintTask } from "../../domain/print/types";
import { openPrintQueueStore } from "../../infra/db/store";
import { capabilitiesOf, PrinterCapabilityError } from "../../infra/printers/capabilities";
import type { PrinterConfig } from "../../infra/printers/config";
import type { PrinterFilesListing } from "../../infra/printers/files";
import { ArtifactStorage } from "../../infra/storage/artifactStorage";
import { ANALYZER_VERSION } from "../artifacts/analyzers";
import { DeviceArtifactService } from "../dispatch/deviceArtifactService";
import { DispatchService } from "../dispatch/dispatchService";
import { establishClearBed } from "../dispatch/testkit/bed";
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
 * **A monitoring-only printer is never a target** — the Anycubic Kobra X at
 * stage 1, connected over `anycubic-lan`.
 *
 * Enabled, online, idle, with a confirmed-empty bed and a model that fits: every
 * fact that would make an ordinary printer the obvious choice. The farm must
 * still refuse it everywhere a job can reach a printer — the preview, a manual
 * launch (with an override attempt), the night and automatic modes, the planner
 * and the file preparation — through the one admission policy, and nothing may
 * be uploaded to it, started on it or recorded as a run on it.
 *
 * Wired like `executablePath.test.ts`, over a real in-memory store; the device
 * adapters are fakes that record what they were asked to do.
 */

const ISO = "2026-10-16T12:00:00.000Z";
const GCODE = Buffer.from(";FLAVOR:Marlin\nG28\nG1 X10 Y10 E1 F1200\nM104 S0\n", "utf8");

const K2 = {
  id: "k2",
  name: "Creality K2",
  model: "Creality K2",
  type: "FDM",
  protocol: "moonraker",
  host: "127.0.0.2",
  material: "PLA / PETG",
  enabled: true
} as unknown as PrinterConfig;

const KOBRA = {
  id: "kobra-x",
  name: "Anycubic Kobra X",
  model: "Anycubic Kobra X",
  type: "FDM",
  protocol: "anycubic-lan",
  host: "127.0.0.9",
  // A confirmed certificate: fully configured, and still monitoring only.
  tlsFingerprint: "0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0:0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0",
  material: "PLA / PETG",
  enabled: true
} as unknown as PrinterConfig;

const PRINTERS = [K2, KOBRA];

interface Harness {
  store: PrintQueueStore;
  queue: PrintQueueService;
  devices: DeviceArtifactService;
  launch: LaunchService;
  scheduler: SchedulerService;
  storage: ArtifactStorage;
  uploads: string[];
  startCalls: string[];
}

let TMP: string;
let h: Harness;

beforeEach(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "monitoring-only-"));
  const store = openPrintQueueStore(":memory:");
  for (const printer of PRINTERS) establishClearBed(store, printer.id);
  const storage = new ArtifactStorage({ root: path.join(TMP, "artifacts") });
  await storage.init();
  const uploads: string[] = [];
  const startCalls: string[] = [];
  const onDevice = new Map<string, { path: string; size: number }[]>();

  const queue = new PrintQueueService(store, {
    now: () => new Date(ISO),
    isPrinterConfigured: (id) => PRINTERS.some((p) => p.id === id),
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
      uploads.push(printer.id);
      onDevice.set(printer.id, [{ path: remotePath, size: bytes.byteLength }]);
      return { remotePath, sizeBytes: bytes.byteLength };
    },
    now: () => new Date(ISO)
  });

  // Exactly what `buildSchedulerPrinters` does: the job capability comes from
  // the one capability table, by protocol.
  const refs = (): SchedulerPrinterRef[] =>
    PRINTERS.map((p) => ({
      id: p.id,
      name: p.name,
      model: p.model,
      protocol: p.protocol,
      printerClass: null,
      material: "PETG",
      supportedMaterials: ["PLA", "PETG"],
      nozzleMm: 0.4,
      buildVolume: { x: 260, y: 260, z: 260 },
      online: true,
      status: "idle",
      remoteStartSupported: capabilitiesOf(p).supportsRemoteStart,
      jobsSupported: capabilitiesOf(p).supportsJobs,
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
    nightWindow: "00:00 – 23:59",
    farmTimeZone: "UTC",
    compatibility: { telemetryStaleMs: 120_000 },
    unknownEtaAssumptionS: 4 * 3600
  };
  const scheduler = new SchedulerService(store, refs, schedulerConfig);
  const eligibility = (): EligibilityQueries => {
    const ctx = new SchedulerContext(store, refs, schedulerConfig);
    return new EligibilityQueries(ctx, new EvidenceResolver(ctx));
  };
  const dispatch = new DispatchService({
    store,
    resolvePrinter: (ref) => PRINTERS.find((p) => p.id === ref.trim()),
    getStatus: () => undefined,
    startPhysical: async (printerId) => {
      startCalls.push(printerId);
      return { confirmed: true };
    },
    classifyError: () => "unknown",
    listFiles,
    evaluateEligibility: (input) => eligibility().evaluate(input),
    now: () => new Date(ISO)
  });
  const schedule = new OperatorScheduleService(store, { now: () => new Date(ISO) });
  const manualOperations = new ManualOperationService(store, schedule, { now: () => new Date(ISO) });
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
  h = { store, queue, devices, launch, scheduler, storage, uploads, startCalls };
});

afterEach(() => {
  h.store.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** An uploaded, analysed, ready-to-print G-code, queued — fit for either printer. */
function queuedGcode(options: { unattended?: boolean } = {}): PrintTask {
  const repos = h.store.repositories;
  const sha = createHash("sha256").update(GCODE).digest("hex");
  const key = `sha256/${sha.slice(0, 2)}/${sha}`;
  fs.mkdirSync(path.dirname(h.storage.resolvePath(key)), { recursive: true });
  fs.writeFileSync(h.storage.resolvePath(key), GCODE);
  const artifact: Artifact = {
    id: newId(ID_PREFIX.artifact),
    kind: "gcode",
    name: "bracket.gcode",
    source: key,
    sizeBytes: GCODE.byteLength,
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
    detectedFormat: "gcode",
    verdict: "schedulable",
    analyzer: "gcode",
    analyzerVersion: ANALYZER_VERSION,
    estimatedDurationS: 3600,
    estimatedFilamentG: 20,
    material: "PETG",
    nozzleDiameterMm: 0.4,
    layerHeightMm: 0.2,
    warnings: [],
    blockers: [],
    data: { size: [40, 40, 20], flavor: "marlin" },
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
    title: "bracket.gcode",
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
    unattendedAllowed: options.unattended ?? false,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: { source: "upload" }
  };
  repos.tasks.insert(task);
  return h.queue.enqueueExecutableArtifact(task.id).task;
}

function nothingHappenedOnKobra(): void {
  assert.deepEqual(h.uploads.filter((id) => id === "kobra-x"), [], "nothing was uploaded to it");
  assert.deepEqual(h.startCalls.filter((id) => id === "kobra-x"), [], "nothing was started on it");
  assert.equal(h.store.repositories.printRuns.findActiveByPrinter("kobra-x"), null, "no run holds it");
  assert.deepEqual(h.store.repositories.deviceArtifacts.listByPrinter("kobra-x"), [], "no file is recorded on it");
}

test("the preview never offers it, names why, and recommends a printer that takes jobs", () => {
  const task = queuedGcode();
  const preview = h.launch.preview(task.id, "kobra-x");
  const kobra = preview.candidates.find((c) => c.printerId === "kobra-x")!;
  assert.equal(kobra.eligible, false);
  const problem = kobra.problems.find((p) => p.code === "PRINTER_MONITORING_ONLY");
  assert.ok(problem, `the reason is the integration: ${JSON.stringify(kobra.problems.map((p) => p.code))}`);
  assert.equal(problem!.kind, "blocker");
  assert.equal(problem!.overridable, false, "no tick, no override clears it");
  assert.match(problem!.title, /только для наблюдения/);
  assert.ok(
    !kobra.problems.some((p) => p.code === "manual_start_only"),
    "and it does not suggest starting the job by hand there"
  );

  const recommended = h.launch.preview(task.id);
  assert.equal(recommended.recommendedPrinterId, "k2");
});

test("an explicit manual launch on it is refused — even with an override attempt", async () => {
  const task = queuedGcode();
  await assert.rejects(() => h.launch.launch(task.id, { printerId: "kobra-x" }));
  await assert.rejects(() =>
    h.launch.launch(task.id, {
      printerId: "kobra-x",
      confirmations: ["bed_clear", "material_loaded"],
      override: { codes: ["PRINTER_MONITORING_ONLY", "REMOTE_START_UNSUPPORTED"], reason: "проверка" },
      actor: "operator"
    })
  );
  nothingHappenedOnKobra();

  // The same job still launches on the printer that takes jobs.
  const outcome = await h.launch.launch(task.id, { printerId: "k2" });
  assert.equal(outcome.run.printerId ?? "k2", "k2");
  assert.deepEqual(h.startCalls, ["k2"]);
});

test("night and automatic modes refuse it as well", async () => {
  const task = queuedGcode({ unattended: true });
  h.store.repositories.tasks.update({ ...h.store.repositories.tasks.getById(task.id)!, night: true, dayNightPreference: "night" });

  const night = h.scheduler.nightCandidates();
  assert.ok(!night.candidates.some((c) => c.printerId === "kobra-x"), "never a night candidate");
  const nightGate = h.scheduler.dispatchEligibility({ taskId: task.id, printerId: "kobra-x", mode: "night" });
  assert.equal(nightGate.status, "blocked");
  assert.ok(nightGate.reasons.some((r) => r.code === "PRINTER_MONITORING_ONLY" && r.severity === "blocker"));

  await assert.rejects(() => h.launch.launch(task.id, { printerId: "kobra-x", mode: "auto" }));
  nothingHappenedOnKobra();
});

test("the planner never places a job on it", () => {
  queuedGcode();
  queuedGcode();
  const matrix = h.scheduler.compatibilityMatrix();
  for (const row of matrix.rows) {
    const kobra = row.results.find((r) => r.printerId === "kobra-x")!;
    assert.equal(kobra.verdict, "blocked");
    assert.equal(kobra.blockers[0]?.code, "monitoring_only", "headlined first");
  }
  const plan = h.scheduler.buildDraftPlan({ name: "test" });
  assert.ok(plan.assignments.length > 0, "the jobs are placed — on the printer that takes them");
  assert.ok(
    plan.assignments.every((a) => a.assignment.printerId !== "kobra-x"),
    JSON.stringify(plan.assignments.map((a) => a.assignment.printerId))
  );
});

test("no file is prepared or confirmed for it, even after a placement by hand", async () => {
  const task = queuedGcode();
  // A placement is only an intention; the queue keeps accepting it as before.
  const assignment = h.queue.assignTask(task.id, "kobra-x", { reason: "проверка" });
  await assert.rejects(() => h.devices.prepare(assignment.id), PrinterCapabilityError);
  await assert.rejects(() => h.devices.confirmManualTransfer(assignment.id, "operator"), PrinterCapabilityError);
  nothingHappenedOnKobra();
});
