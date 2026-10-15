import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { JobError } from "../../core/errors";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { Artifact, ArtifactAnalysis, DayNightPreference, PrintTask } from "../../domain/print/types";
import type { ProfileRevision, ProfileSet, ProfileType, SliceVariant } from "../../domain/slicing/types";
import { openPrintQueueStore } from "../../infra/db/store";
import type { PrinterConfig } from "../../infra/printers/config";
import type { PrinterFilesListing } from "../../infra/printers/files";
import { ArtifactStorage } from "../../infra/storage/artifactStorage";
import { ANALYZER_VERSION } from "../artifacts/analyzers";
import { establishClearBed } from "../dispatch/testkit/bed";
import { DeviceArtifactService } from "../dispatch/deviceArtifactService";
import { DispatchService, type DispatchDeps } from "../dispatch/dispatchService";
import { RunLifecycleService } from "../dispatch/runLifecycle";
import { LaunchService } from "../launch/launchService";
import { ManualOperationService } from "../operations/manualOperationService";
import { OperatorScheduleService } from "../operations/operatorScheduleService";
import { PrintQueueService } from "../printQueue/printQueueService";
import { SchedulerContext } from "../scheduling/context";
import { EligibilityQueries } from "../scheduling/eligibility";
import { EvidenceResolver } from "../scheduling/evidence";
import { SchedulerService } from "../scheduling/schedulerService";
import type { SchedulerPrinterRef } from "../scheduling/types";
import { declareSourceUnits } from "../slicing/testkit/source";
import { classifyDispatchError, refusedBeforeSend } from "../startGuard";
import { AUTO_QUEUE_ACTOR, AutoQueueExecutor, type AutoQueueConfig } from "./autoQueue";

/*
 * **Автоочередь, end to end over the real launch path.**
 *
 * The executor adds no rule of its own: every start is `LaunchService.launch`
 * in the policy's `auto` mode — the real preflight, delivery, final dispatch
 * gate, idempotency and audit — over an in-memory store and a fake device.
 * These pin the safety properties the stage asks for:
 *
 *   - off by default, twice (deployment switch + operator rule);
 *   - only jobs the operator allowed to run without them;
 *   - nothing a human would have to confirm is ever assumed (bed, material);
 *   - one start per tick and never two on one printer;
 *   - a start whose outcome is unknown HALTS the executor;
 *   - a refused job is left alone for a while, unless it changes.
 */

const GCODE = Buffer.from(";FLAVOR:Klipper\n;printer_model = Creality K2\nG28\nG1 X10 Y10 E1 F1200\nM104 S0\n", "utf8");
const GCODE_SHA = createHash("sha256").update(GCODE).digest("hex");
const NOW = Date.parse("2026-10-14T12:00:00.000Z"); // 12:00 UTC — outside the night window

const PRINTERS = [
  { id: "k2", name: "Creality K2", model: "Creality K2", type: "FDM", protocol: "moonraker", host: "127.0.0.2", material: "PETG", enabled: true },
  { id: "k2b", name: "Creality K2 #2", model: "Creality K2", type: "FDM", protocol: "moonraker", host: "127.0.0.3", material: "PETG", enabled: true }
] as unknown as PrinterConfig[];

interface Knobs {
  material: Record<string, string | null>;
  status: Record<string, SchedulerPrinterRef["status"]>;
  failStart: string | null;
  classify: "unknown" | "rejected";
  /** Uploads to these printers wait for the promise — a start held mid-delivery. */
  uploadGate: Record<string, Promise<void>>;
  /** The command layer refuses before anything is sent (the printer went offline during the upload). */
  refuseBeforeSend: string | null;
}

interface Harness {
  store: PrintQueueStore;
  queue: PrintQueueService;
  lifecycle: RunLifecycleService;
  launch: () => LaunchService;
  startCalls: { printerId: string; file: string }[];
  knobs: Knobs;
  clock: { ms: number };
  armed: { on: boolean; disarmedWith: string | null };
  events: string[];
  executor: (over?: Partial<AutoQueueConfig>) => AutoQueueExecutor;
}

let TMP: string;
let h: Harness;

beforeEach(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "auto-queue-"));
  h = await makeHarness(TMP);
});

afterEach(() => {
  h.store.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function makeHarness(tmp: string): Promise<Harness> {
  const store = openPrintQueueStore(":memory:");
  const clock = { ms: NOW };
  const now = () => new Date(clock.ms);
  const storage = new ArtifactStorage({ root: path.join(tmp, "artifacts") });
  await storage.init();
  const key = `sha256/${GCODE_SHA.slice(0, 2)}/${GCODE_SHA}`;
  const blobPath = storage.resolvePath(key);
  fs.mkdirSync(path.dirname(blobPath), { recursive: true });
  fs.writeFileSync(blobPath, GCODE);

  const onDevice = new Map<string, { path: string; size: number }[]>();
  const startCalls: Harness["startCalls"] = [];
  const knobs: Knobs = {
    material: { k2: "PETG", k2b: "PETG" },
    status: { k2: "idle", k2b: "idle" },
    failStart: null,
    classify: "unknown",
    uploadGate: {},
    refuseBeforeSend: null
  };

  const queue = new PrintQueueService(store, {
    now,
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
      await knobs.uploadGate[printer.id];
      const files = onDevice.get(printer.id) ?? [];
      onDevice.set(printer.id, [...files.filter((f) => f.path !== remotePath), { path: remotePath, size: bytes.byteLength }]);
      return { remotePath, sizeBytes: bytes.byteLength };
    },
    now
  });
  const refs = (): SchedulerPrinterRef[] =>
    PRINTERS.map((p) => ({
      id: p.id,
      name: p.name,
      model: p.model,
      protocol: p.protocol,
      printerClass: null,
      material: knobs.material[p.id] ?? null,
      nozzleMm: 0.4,
      buildVolume: { x: 256, y: 256, z: 256 },
      online: true,
      status: knobs.status[p.id] ?? "idle",
      remoteStartSupported: true,
      ams: false,
      faults: [],
      mediaPresent: true,
      telemetryAgeMs: 1_000,
      materialRemainingSufficient: null,
      printingTimeLeftMs: null,
      activeRunState: null
    }));
  const schedulerConfig = {
    now,
    runtimeAvailable: true,
    nightSafetyBufferRatio: 0.2,
    nightWindow: "21:30 – 07:30",
    farmTimeZone: "UTC",
    compatibility: { telemetryStaleMs: 120_000 },
    unknownEtaAssumptionS: 4 * 3600
  };
  const eligibility = (): EligibilityQueries => {
    const ctx = new SchedulerContext(store, refs, schedulerConfig);
    return new EligibilityQueries(ctx, new EvidenceResolver(ctx));
  };
  const dispatch = new DispatchService({
    store,
    resolvePrinter: (ref) => PRINTERS.find((p) => p.id === ref.trim().toLowerCase()),
    getStatus: () => undefined,
    startPhysical: async (printerId, file) => {
      if (knobs.refuseBeforeSend) throw refusedBeforeSend(new JobError(knobs.refuseBeforeSend));
      if (knobs.failStart) throw new Error(knobs.failStart);
      startCalls.push({ printerId, file });
      return { confirmed: false };
    },
    // The real classifier decides what it can know for certain (a refusal before
    // the send); the knob plays the device's ambiguous answers.
    classifyError: (error) => (classifyDispatchError(error) === "rejected" ? "rejected" : knobs.classify),
    listFiles,
    evaluateEligibility: (input) => eligibility().evaluate(input),
    now
  } satisfies DispatchDeps);
  const lifecycle = new RunLifecycleService(store, { now });
  const schedule = new OperatorScheduleService(store, { now });
  const manualOperations = new ManualOperationService(store, schedule, { now });
  const launch = () =>
    new LaunchService({
      store,
      printQueue: queue,
      scheduler: new SchedulerService(store, refs, schedulerConfig),
      deviceArtifacts: devices,
      dispatch: () => dispatch,
      runLifecycle: () => lifecycle,
      manualOperations,
      resolvePrinter: (id) => PRINTERS.find((p) => p.id === id),
      automaticContinuationAllowed: () => false
    });

  const armed = { on: true, disarmedWith: null as string | null };
  const events: string[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const executor = (over: Partial<AutoQueueConfig> = {}) =>
    new AutoQueueExecutor({
      config: { enabled: true, intervalMs: 60_000, startupDelayMs: 0, maxStartsPerTick: 1, retryCooldownMs: 15 * 60_000, ...over },
      store: () => store,
      openQueue: () => queue.listOpenQueue(),
      launch,
      isArmed: () => armed.on,
      disarm: (reason) => {
        armed.on = false;
        armed.disarmedWith = reason;
      },
      serialize: (task) => {
        const next = chain.catch(() => undefined).then(task);
        chain = next.catch(() => undefined);
        return next;
      },
      withdrawPlacement: (assignmentId, reason) => void queue.invalidateAssignment(assignmentId, reason, AUTO_QUEUE_ACTOR),
      notify: (_kind, text) => void events.push(text),
      now
    });

  return { store, queue, lifecycle, launch, startCalls, knobs, clock, armed, events, executor };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function revision(type: ProfileType, name: string, settings: Record<string, unknown>): ProfileRevision {
  const raw = JSON.stringify({ name, type, ...settings });
  const iso = new Date(NOW).toISOString();
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
    createdAt: iso,
    updatedAt: iso,
    version: 1,
    metadata: {}
  };
  h.store.repositories.profileRevisions.insert(rev);
  return rev;
}

/**
 * A sliced, analysed, promoted K2 job: PETG, 0.4 mm, 1 h. `unattended` is the
 * operator's permission to run it with nobody pressing the button.
 */
function queuedJob(
  options: { title?: string; unattended?: boolean; when?: DayNightPreference; printerId?: string } = {}
): PrintTask {
  const repos = h.store.repositories;
  const iso = new Date(h.clock.ms).toISOString();
  const target = options.printerId ?? null;
  const source: Artifact = {
    id: newId(ID_PREFIX.artifact),
    kind: "model",
    name: `${options.title ?? "part"}.3mf`,
    source: "sha256/aa/source3mf",
    sizeBytes: 900_000,
    sha256: createHash("sha256").update(newId(ID_PREFIX.artifact)).digest("hex"),
    createdAt: iso,
    updatedAt: iso,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  const output: Artifact = {
    id: newId(ID_PREFIX.artifact),
    kind: "gcode",
    name: `${options.title ?? "part"}.gcode`,
    source: `sha256/${GCODE_SHA.slice(0, 2)}/${GCODE_SHA}`,
    sizeBytes: GCODE.byteLength,
    sha256: GCODE_SHA,
    createdAt: iso,
    updatedAt: iso,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  repos.artifacts.insert(source);
  repos.artifacts.insert(output);
  declareSourceUnits(h.store, source.id);
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
    material: "PETG",
    nozzleDiameterMm: 0.4,
    layerHeightMm: 0.2,
    warnings: [],
    blockers: [],
    data: { size: [100, 100, 100], flavor: "klipper", printerModel: "Creality K2" },
    error: null,
    createdAt: iso,
    updatedAt: iso,
    version: 1,
    metadata: {}
  };
  repos.artifactAnalyses.insert(analysis);
  const machine = revision("machine", `K2 0.4 ${Math.random()}`, {
    nozzle_diameter: ["0.4"],
    printer_model: "Creality K2",
    gcode_flavor: "klipper",
    printable_area: ["0x0", "256x0", "256x256", "0x256"],
    printable_height: "256"
  });
  const process = revision("process", `0.2 ${Math.random()}`, { layer_height: "0.2" });
  const filament = revision("filament", `PETG ${Math.random()}`, { filament_type: ["PETG"] });
  const set: ProfileSet = {
    id: newId(ID_PREFIX.profileSet),
    name: "K2 · PETG",
    machineRevisionId: machine.id,
    processRevisionId: process.id,
    filamentRevisionId: filament.id,
    printerId: target,
    printerClass: target ? null : "k2",
    validation: "valid",
    approved: true,
    approvedBy: "operator",
    approvedAt: iso,
    warnings: [],
    blockers: [],
    createdAt: iso,
    updatedAt: iso,
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
    title: options.title ?? "part",
    material: "PETG",
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
    createdAt: iso,
    updatedAt: iso,
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
    targetPrinterId: target,
    targetPrinterClass: target ? null : "k2",
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
    startedAt: iso,
    endedAt: iso,
    createdAt: iso,
    updatedAt: iso,
    version: 1,
    metadata: { scale: { factor: 1, reason: "declared_by_file" } }
  };
  repos.sliceVariants.insert(variant);
  const queued = h.queue.promoteSliceVariant(variant.id).task;
  if (options.unattended !== false || options.when) {
    h.queue.setTaskScheduling(queued.id, {
      unattendedAllowed: options.unattended !== false,
      ...(options.when ? { dayNightPreference: options.when } : {})
    });
  }
  return h.store.repositories.tasks.getById(queued.id)!;
}

function clearBeds(...ids: string[]): void {
  for (const id of ids) establishClearBed(h.store, id, new Date(h.clock.ms - 60_000));
}

/** A latch for {@link Knobs.uploadGate}: the upload waits until `open()`. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Yields to the event loop until `cond` holds — a start reaching its upload, say. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (cond()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function uploading(printerId: string): boolean {
  return h.store.repositories.deviceArtifacts
    .listByStates(["UPLOADING"])
    .some((record) => record.printerId === printerId);
}

// ── Off by default ──────────────────────────────────────────────────────────

test("not configured: nothing is examined, nothing starts — whatever the rule says", async () => {
  clearBeds("k2");
  queuedJob();
  const executor = h.executor({ enabled: false });
  const result = await executor.tick();
  assert.equal(result.skipped, "not_configured");
  assert.deepEqual(h.startCalls, []);
  assert.equal(executor.status().configured, false);
  executor.start();
  assert.equal(executor.status().startedAt, null, "no timer for an executor the deployment does not allow");
});

test("configured but not armed by the operator: nothing starts", async () => {
  clearBeds("k2");
  queuedJob();
  h.armed.on = false;
  const result = await h.executor().tick();
  assert.equal(result.skipped, "disarmed");
  assert.deepEqual(h.startCalls, []);
});

// ── What it starts, and how ─────────────────────────────────────────────────

test("armed: a job allowed to run without an operator starts through the real launch path, audited as the executor", async () => {
  clearBeds("k2", "k2b");
  const job = queuedJob({ title: "bracket" });
  const executor = h.executor();
  const result = await executor.tick();

  assert.equal(result.started, 1);
  assert.equal(h.startCalls.length, 1, "exactly one command reached a printer");
  const [decision] = result.decisions;
  assert.equal(decision.outcome, "started");
  const run = h.store.repositories.printRuns.findActiveByTask(job.id)!;
  assert.equal(run.id, decision.runId);
  assert.equal(run.metadata.mode, "auto", "the run says it was started automatically");
  assert.equal(run.idempotencyKey, `auto:${job.id}:v${job.version}`);
  const audit = h.store.repositories.audit.listByEntity("print_task", job.id);
  assert.ok(audit.some((e) => e.actor === AUTO_QUEUE_ACTOR), "audited under the executor's name");
  assert.ok(h.events.some((e) => /bracket/.test(e)));
  assert.equal(executor.status().recent[0].outcome, "started");
});

test("a job WITHOUT the permission is never started, and the dry run says why", async () => {
  clearBeds("k2");
  const job = queuedJob({ unattended: false });
  const executor = h.executor();
  const result = await executor.tick();
  assert.equal(result.started, 0);
  assert.deepEqual(h.startCalls, []);
  const plan = executor.plan();
  assert.equal(plan.find((d) => d.taskId === job.id)?.outcome, "not_allowed");
});

test("an unrecorded bed is a refusal — the executor never ticks «стол свободен» for anyone", async () => {
  // No clearance recorded on either printer.
  const job = queuedJob();
  const result = await h.executor().tick();
  assert.equal(result.started, 0);
  assert.deepEqual(h.startCalls, []);
  assert.equal(result.decisions[0]?.outcome, "waiting");
  assert.equal(result.decisions[0]?.taskId, job.id);
  assert.equal(h.store.repositories.bedCycles.latestByPrinter("k2"), null, "no CLEAR cycle was written on its behalf");
});

test("unreported material is a refusal in auto mode (a human would have been asked)", async () => {
  clearBeds("k2", "k2b");
  h.knobs.material = { k2: null, k2b: null };
  queuedJob();
  const result = await h.executor().tick();
  assert.equal(result.started, 0);
  assert.equal(result.decisions[0]?.outcome, "waiting");
  assert.match(result.decisions[0]?.message ?? "", /материал/i);
});

test("one start per tick; the next tick takes the next job on the other printer", async () => {
  clearBeds("k2", "k2b");
  queuedJob({ title: "first" });
  queuedJob({ title: "second" });
  const executor = h.executor();
  assert.equal((await executor.tick()).started, 1);
  assert.equal((await executor.tick()).started, 1);
  assert.deepEqual(h.startCalls.map((c) => c.printerId).sort(), ["k2", "k2b"], "never twice on one printer");
  assert.equal((await executor.tick()).started, 0, "both printers are now held by their runs");
});

test("never two starts on one printer, even with room for more starts per tick", async () => {
  clearBeds("k2");
  h.knobs.status.k2b = "printing"; // the second printer is busy
  queuedJob({ title: "a" });
  queuedJob({ title: "b" });
  const result = await h.executor({ maxStartsPerTick: 5 }).tick();
  assert.equal(result.started, 1);
  assert.equal(h.startCalls.length, 1);
});

test("a tick already in flight answers «busy» instead of starting a second pass", async () => {
  clearBeds("k2");
  queuedJob();
  const executor = h.executor();
  const [a, b] = await Promise.all([executor.tick(), executor.tick()]);
  assert.equal(b.skipped, "busy");
  assert.equal(a.started + b.started, 1);
});

test("a job placed on a printer by a person goes there or nowhere", async () => {
  clearBeds("k2", "k2b");
  const job = queuedJob();
  h.queue.assignTask(job.id, "k2b", { reason: "оператор так решил" });
  await h.executor().tick();
  assert.deepEqual(h.startCalls.map((c) => c.printerId), ["k2b"]);
});

// ── When something goes wrong ───────────────────────────────────────────────

test("a start whose outcome is lost HALTS the executor: the rule is switched off, and it stays off", async () => {
  clearBeds("k2", "k2b");
  const job = queuedJob({ title: "lost" });
  queuedJob({ title: "next" });
  h.knobs.failStart = "socket hang up";
  h.knobs.classify = "unknown";
  const executor = h.executor({ maxStartsPerTick: 5 });
  const result = await executor.tick();

  assert.equal(result.decisions.at(-1)?.outcome, "halted");
  assert.equal(h.armed.on, false, "the circuit breaker switched the rule off");
  assert.match(h.armed.disarmedWith ?? "", /неизвестен/);
  assert.equal(result.decisions.filter((d) => d.outcome === "started").length, 0, "nothing else was started after it");
  assert.equal(h.store.repositories.printRuns.findActiveByTask(job.id)?.state, "UNKNOWN", "the printer stays held for a person");
  assert.equal((await executor.tick()).skipped, "disarmed");
  assert.match(executor.status().haltedReason ?? "", /lost|неизвестен/);
});

test("an earlier automatic start the printer never confirmed halts the next tick before anything else is tried", async () => {
  clearBeds("k2", "k2b");
  const job = queuedJob({ title: "ghost" });
  const executor = h.executor();
  await executor.tick();
  const run = h.store.repositories.printRuns.findActiveByTask(job.id)!;
  // The printer never showed the job: the lifecycle marks the accepted start UNKNOWN.
  h.store.repositories.printRuns.update({ ...run, state: "UNKNOWN" });
  queuedJob({ title: "other" });
  const before = h.startCalls.length;
  const result = await executor.tick();
  assert.equal(result.skipped, "disarmed");
  assert.equal(h.startCalls.length, before);
  assert.equal(h.armed.on, false);
});

test("a start refused before the send (printer gone offline mid-delivery) is a refusal, not a halt — nothing was sent", async () => {
  // It used to read as an unknown outcome: a phantom UNKNOWN run with the bed
  // RESERVED, and the executor stopping itself over a printer that merely
  // dropped off the network during the upload.
  clearBeds("k2");
  h.knobs.status.k2b = "printing";
  const job = queuedJob({ title: "dropped" });
  h.knobs.refuseBeforeSend = "«Creality K2» не отвечает";
  const executor = h.executor();
  const result = await executor.tick();
  assert.equal(result.decisions[0]?.outcome, "refused", JSON.stringify(result.decisions));
  assert.equal(h.armed.on, true, "no halt: the outcome is known — nothing left");
  assert.equal(h.store.repositories.printRuns.findActiveByTask(job.id), null, "no run is held");
  assert.equal(h.store.repositories.tasks.getById(job.id)?.state, "QUEUED", "the job is back in the queue");
  assert.equal(h.store.repositories.bedCycles.latestByPrinter("k2")?.state, "CLEAR", "the plate is free again");
  assert.equal(executor.status().cooldowns.length, 1, "and rests before the next try");
});

test("a definitive refusal leaves the job alone for the cool-down, then it is tried again", async () => {
  clearBeds("k2", "k2b");
  queuedJob({ title: "refused" });
  h.knobs.failStart = "file not found (404)";
  h.knobs.classify = "rejected";
  const executor = h.executor({ retryCooldownMs: 10 * 60_000 });
  const first = await executor.tick();
  assert.equal(first.decisions[0]?.outcome, "refused");
  assert.equal(h.armed.on, true, "a clean refusal is not an unknown — the executor keeps running");
  assert.equal(executor.status().cooldowns.length, 1);

  h.knobs.failStart = null;
  assert.equal((await executor.tick()).started, 0, "still cooling down");
  assert.equal(executor.plan()[0]?.code, "AUTO_COOLDOWN", "the dry run says the job is resting, and why");
  h.clock.ms += 11 * 60_000;
  const again = await executor.tick();
  assert.equal(again.started, 1, `tried again after the cool-down: ${JSON.stringify(again.decisions)}`);
});

// ── Time preferences ────────────────────────────────────────────────────────

test("a night job waits for the night window; a day job waits for an operator on shift", async () => {
  clearBeds("k2", "k2b");
  const night = queuedJob({ title: "night", when: "night" });
  const day = queuedJob({ title: "day", when: "day" });
  const executor = h.executor({ maxStartsPerTick: 5 });
  const result = await executor.tick(); // 12:00 UTC, no operator schedule configured
  assert.equal(result.started, 0);
  const byTask = new Map(result.decisions.map((d) => [d.taskId, d]));
  assert.equal(byTask.get(night.id)?.outcome, "waiting");
  assert.match(byTask.get(night.id)?.message ?? "", /ночн/i);
  assert.equal(byTask.get(day.id)?.outcome, "waiting");
  assert.match(byTask.get(day.id)?.message ?? "", /оператор/i);
});

// ── Dry run and lifecycle ──────────────────────────────────────────────────

test("the dry run changes nothing and works while the executor is off", async () => {
  clearBeds("k2");
  const job = queuedJob();
  h.armed.on = false;
  const executor = h.executor({ enabled: false });
  const plan = executor.plan();
  assert.equal(plan[0]?.taskId, job.id);
  assert.equal(plan[0]?.outcome, "would_start");
  assert.deepEqual(h.startCalls, []);
  assert.equal(h.store.repositories.tasks.getById(job.id)?.state, "QUEUED");
  assert.equal(h.store.repositories.assignments.listByTask(job.id).length, 0, "no placement was made");
});

test("the dry run, polled while an automatic start is mid-delivery, leaves that start's placement alone", async () => {
  // The dashboard polls the dry run every 15 s, and a delivery can take longer
  // than that. The dry run used to withdraw «the executor's own» placements —
  // the one the start in flight was delivering under among them — and the
  // final gate then refused that start as «назначение устарело».
  clearBeds("k2");
  h.knobs.status.k2b = "printing";
  const job = queuedJob({ title: "in flight" });
  const hold = gate();
  h.knobs.uploadGate.k2 = hold.promise;
  const executor = h.executor();
  const ticking = executor.tick();
  await until(() => uploading("k2"), "the automatic delivery to start");

  executor.plan();
  const own = h.store.repositories.assignments.listByTask(job.id).filter((a) => a.createdBy === AUTO_QUEUE_ACTOR);
  assert.equal(own.length, 1, "the start in flight placed the job");
  assert.equal(own[0].invalidatedAt, null, "the dry run withdrew nothing");

  hold.open();
  const result = await ticking;
  assert.equal(result.started, 1, JSON.stringify(result.decisions));
  assert.deepEqual(h.startCalls.map((c) => c.printerId), ["k2"]);
});

// ── A person and the executor at the same time (scenario I) ─────────────────

test("a person and the executor start the same job on the same printer at once: one print, one command, no halt", async () => {
  // Manual launches are not serialised with the executor's ticks; the device
  // slot lock, the final gate and the «one active run per task» index are what
  // keep the two from sending two starts.
  clearBeds("k2");
  h.knobs.status.k2b = "printing"; // only k2 can take it
  const job = queuedJob({ title: "both at once" });
  const hold = gate();
  h.knobs.uploadGate.k2 = hold.promise;
  const executor = h.executor();
  const auto = executor.tick();
  await until(() => uploading("k2"), "the automatic delivery to start");

  const manual = h.launch().launch(job.id, { printerId: "k2", idempotencyKey: "operator-click" });
  hold.open();
  const [autoResult, manualResult] = await Promise.allSettled([auto, manual]);

  assert.equal(h.startCalls.length, 1, "exactly one start command reached the printer");
  assert.equal(h.armed.on, true, "a person's start is not the executor's unknown — no halt");
  const run = h.store.repositories.printRuns.findActiveByTask(job.id);
  assert.ok(run, "one active run holds the job");
  assert.equal(autoResult.status, "fulfilled");
  const decision = autoResult.status === "fulfilled" ? autoResult.value.decisions[0] : undefined;
  if (manualResult.status === "fulfilled") {
    assert.equal(run.idempotencyKey, "operator-click");
    assert.equal(decision?.outcome, "waiting", JSON.stringify(decision));
  } else {
    assert.equal(run.metadata.mode, "auto");
    assert.equal(decision?.outcome, "started");
  }
});

test("a person moving the job to another printer while the executor delivers it: the person's start wins, the stale one is refused at the gate", async () => {
  clearBeds("k2", "k2b");
  h.knobs.status.k2b = "printing"; // the executor can only choose k2
  const job = queuedJob({ title: "moved by hand" });
  const hold = gate();
  h.knobs.uploadGate.k2 = hold.promise;
  const executor = h.executor();
  const auto = executor.tick();
  await until(() => uploading("k2"), "the automatic delivery to start");

  h.knobs.status.k2b = "idle";
  const manual = await h.launch().launch(job.id, { printerId: "k2b" });
  assert.equal(manual.printerId, "k2b");
  hold.open();
  const result = await auto;

  assert.equal(result.started, 0, JSON.stringify(result.decisions));
  assert.equal(result.decisions[0]?.outcome, "waiting", "someone else's start got there first — not a halt");
  assert.deepEqual(h.startCalls.map((c) => c.printerId), ["k2b"], "nothing was sent to the printer the executor had picked");
  assert.equal(h.armed.on, true);
});

// ── A person's placement and the launch window (HIGH-13, completed) ─────────

test("an operator explicitly choosing another printer moves their own placement — withdrawn, audited, one start", async () => {
  // `LaunchService.ensureAssignment` always meant to do this («оператор выбрал
  // другой принтер»), but the policy refused every printer but the placed one
  // first, with a message about a «подтверждённый план» that did not exist.
  clearBeds("k2", "k2b");
  const job = queuedJob({ unattended: false });
  const placed = h.queue.assignTask(job.id, "k2", { reason: "оператор" });

  const k2b = h.launch().preview(job.id, "k2b").candidates.find((c) => c.printerId === "k2b")!;
  assert.equal(k2b.eligible, true, JSON.stringify(k2b.blockers));
  assert.ok(k2b.warnings.some((w) => w.code === "ASSIGNMENT_REPLACED"), "the screen says the placement will move");

  const outcome = await h.launch().launch(job.id, { printerId: "k2b" });
  assert.equal(outcome.printerId, "k2b");
  assert.ok(outcome.steps.includes("assignment_replaced"));
  assert.ok(h.store.repositories.assignments.getById(placed.id)?.invalidatedAt, "the old placement is withdrawn");
  assert.deepEqual(h.startCalls.map((c) => c.printerId), ["k2b"]);
});

test("without that explicit choice a person's placement decides: the recommendation does not move it", () => {
  clearBeds("k2", "k2b");
  const job = queuedJob({ unattended: false });
  h.queue.assignTask(job.id, "k2b", { reason: "оператор" });
  const preview = h.launch().preview(job.id);
  assert.equal(preview.recommendedPrinterId, "k2b");
  const k2 = preview.candidates.find((c) => c.printerId === "k2")!;
  assert.ok(k2.blockers.some((b) => b.code === "ASSIGNMENT_PRINTER_MISMATCH"), JSON.stringify(k2.blockers));
  const auto = h.launch().preview(job.id, "k2", { mode: "auto" }).candidates.find((c) => c.printerId === "k2")!;
  assert.equal(auto.eligible, false, "the automatic queue never moves a placed job, even asked about another printer");
});

test("stop() waits for the tick in flight and nothing runs after it", async () => {
  clearBeds("k2");
  queuedJob();
  const executor = h.executor();
  const running = executor.tick();
  await executor.stop();
  await running;
  assert.equal((await executor.tick()).skipped, "stopped");
});

test("a print that started and then lost its telemetry holds its own printer only — the executor keeps going", async () => {
  clearBeds("k2", "k2b");
  const first = queuedJob({ title: "running" });
  const executor = h.executor();
  await executor.tick();
  const run = h.store.repositories.printRuns.findActiveByTask(first.id)!;
  // Seen printing, then the printer went silent: UNKNOWN, but it DID start.
  h.store.repositories.printRuns.update({ ...run, state: "UNKNOWN", startedAt: new Date(h.clock.ms).toISOString() });
  queuedJob({ title: "next" });
  const result = await executor.tick();
  assert.equal(result.skipped, null);
  assert.equal(h.armed.on, true, "no halt: the lost print is held by the policy, not by stopping everything");
  assert.equal(result.started, 1, "the other printer still gets work");
  assert.notEqual(h.startCalls.at(-1)?.printerId, run.printerId);
});

test("the executor's own placement from a refused attempt does not tie the job to that printer", async () => {
  clearBeds("k2", "k2b");
  const job = queuedJob({ title: "rebound" });
  h.queue.assignTask(job.id, "k2", { reason: "прошлая попытка автоочереди" }, AUTO_QUEUE_ACTOR);
  h.knobs.status.k2 = "printing"; // that printer is now busy with something else
  const result = await h.executor().tick();
  assert.equal(result.started, 1, JSON.stringify(result.decisions));
  assert.deepEqual(h.startCalls.map((c) => c.printerId), ["k2b"]);
});

test("a withdrawn manual placement binds nothing: the job launches elsewhere, and a newer placement decides", async () => {
  // HIGH-13 made a withdrawn placement stop HOLDING the task and the printer,
  // but the dispatch policy still read the OLDEST placement as the task's
  // reservation: every printer was refused («назначение устарело»,
  // «расходится с планом») — even after a person placed the job again.
  clearBeds("k2", "k2b");
  const job = queuedJob({ title: "moved" });
  const placed = h.queue.assignTask(job.id, "k2", { reason: "оператор" });
  h.queue.invalidateAssignment(placed.id, "оператор передумал");
  const k2b = h.launch().preview(job.id, "k2b").candidates.find((c) => c.printerId === "k2b")!;
  assert.deepEqual(k2b.blockers.map((b) => b.code), [], JSON.stringify(k2b.blockers));

  // Placed again — on the same printer as the withdrawn one: the new decision decides.
  h.queue.assignTask(job.id, "k2", { reason: "снова" });
  const outcome = await h.launch().launch(job.id, { printerId: "k2" });
  assert.equal(outcome.printerId, "k2");
  assert.equal(h.startCalls.length, 1);
});
