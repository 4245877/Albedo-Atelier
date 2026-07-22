import assert from "node:assert/strict";
import { test } from "node:test";

import { JobError, PreviewConflictError, UniqueConstraintError } from "../../core/errors";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { ArtifactAnalysis } from "../../domain/print/types";
import { newId, ID_PREFIX } from "../../domain/print/ids";
import type { PrinterConfig } from "../../infra/printers/config";
import type { PrinterLiveStatus } from "../../infra/printers/status";
import { openPrintQueueStore } from "../../infra/db/store";
import { PrintQueueService } from "../printQueue/printQueueService";
import { ANALYZER_VERSION } from "../artifacts/analyzers";
import { DispatchService, type DispatchDeps } from "./dispatchService";
import { RunLifecycleService } from "./runLifecycle";

/*
 * The canonical dispatch: the ONLY path that may physically start a print. The
 * store is a real (in-memory) SQLite database with the full migration set —
 * including the 008 partial unique indexes — a fake printer config, a stubbed
 * live status and a spy in place of the physical command. No real printer, no
 * network.
 */

const K2: PrinterConfig = {
  id: "k2",
  name: "Creality K2",
  model: "K2 Plus",
  type: "FDM",
  protocol: "moonraker",
  host: "127.0.0.1",
  port: 4408,
  material: "PLA",
  swatch: "",
  snapshotUrl: "",
  streamUrl: "",
  enabled: true
} as unknown as PrinterConfig;

function idle(over: Partial<PrinterLiveStatus> = {}): PrinterLiveStatus {
  return {
    id: "k2",
    online: true,
    status: "idle",
    currentFile: null,
    progressPct: null,
    remainingMinutes: null,
    filamentUsedMm: null,
    amsTrays: null,
    nozzleDiameterMm: null,
    nozzleType: null,
    liveMaterial: null,
    liveMaterialColor: null,
    activeTray: null,
    bedTempC: null,
    bedTargetC: null,
    nozzleTempC: null,
    nozzleTargetC: null,
    chamberTempC: null,
    light: null,
    stateText: null,
    stateMessage: null,
    error: null,
    updatedAt: new Date().toISOString(),
    ...over
  } as PrinterLiveStatus;
}

interface Harness {
  store: PrintQueueStore;
  queue: PrintQueueService;
  dispatch: DispatchService;
  lifecycle: RunLifecycleService;
  startCalls: { printerId: string; file: string; runId: string }[];
  /** Mutable behaviour knobs the tests flip. */
  knobs: {
    status: PrinterLiveStatus;
    startImpl: (printerId: string, file: string, runId: string) => Promise<void>;
    classify: (error: unknown) => "rejected" | "unknown";
    deviceFiles: { filename: string; size: number }[];
  };
}

function makeHarness(): Harness {
  const store = openPrintQueueStore(":memory:");
  const queue = new PrintQueueService(store);
  const startCalls: Harness["startCalls"] = [];
  const knobs: Harness["knobs"] = {
    status: idle(),
    startImpl: async () => {},
    classify: () => "unknown",
    deviceFiles: [{ filename: "chalice.gcode", size: 1000 }]
  };
  const deps: DispatchDeps = {
    store,
    resolvePrinter: (ref) =>
      ref.trim().toLowerCase() === "k2" || ref.trim().toLowerCase() === "creality k2"
        ? K2
        : undefined,
    getStatus: () => knobs.status,
    startPhysical: async (printerId, file, runId) => {
      startCalls.push({ printerId, file, runId });
      await knobs.startImpl(printerId, file, runId);
    },
    classifyError: (e) => knobs.classify(e),
    listFiles: async (_printer, dir) => ({
      path: dir,
      entries: knobs.deviceFiles.map((f) => ({
        name: f.filename,
        path: f.filename,
        type: "file" as const,
        size: f.size,
        printable: true
      }))
    }),
    nightWindow: "21:30 – 07:30",
    nightSafetyBufferRatio: 1
  };
  return {
    store,
    queue,
    dispatch: new DispatchService(deps),
    lifecycle: new RunLifecycleService(store),
    startCalls,
    knobs
  };
}

/** A legacy-style manual task: on-printer file name, no registered bytes. */
function addManualTask(h: Harness, over: { material?: string; file?: string } = {}): string {
  const detail = h.queue.createTask({
    title: "Chalice",
    printer: "k2",
    material: over.material ?? "PLA",
    file: over.file ?? "chalice.gcode"
  });
  return detail.task.id;
}

/** A fully-qualified night task: hashed artifact + fresh schedulable analysis. */
function addNightTask(
  h: Harness,
  over: {
    analysis?: Partial<ArtifactAnalysis>;
    sha?: string | null;
    size?: number | null;
    unattendedAllowed?: boolean;
  } = {}
): { taskId: string; artifactId: string } {
  const repos = h.store.repositories;
  const iso = new Date().toISOString();
  const artifactId = newId(ID_PREFIX.artifact);
  repos.artifacts.insert({
    id: artifactId,
    kind: "gcode",
    name: "chalice.gcode",
    source: `blobs/${artifactId}`,
    sizeBytes: over.size === undefined ? 1000 : over.size,
    sha256: over.sha === undefined ? "a".repeat(64) : over.sha,
    createdAt: iso,
    updatedAt: iso,
    version: 1,
    legacyRef: null,
    metadata: {}
  });
  repos.artifactAnalyses.insert({
    id: newId(ID_PREFIX.artifactAnalysis),
    artifactId,
    state: "ready",
    detectedFormat: "gcode",
    verdict: "schedulable",
    analyzer: "gcode",
    analyzerVersion: ANALYZER_VERSION,
    estimatedDurationS: 2 * 3600,
    estimatedFilamentG: 20,
    material: "PLA",
    nozzleDiameterMm: 0.4,
    layerHeightMm: 0.2,
    warnings: [],
    blockers: [],
    data: {},
    error: null,
    createdAt: iso,
    updatedAt: iso,
    version: 1,
    metadata: {},
    ...(over.analysis ?? {})
  });
  const detail = h.queue.addTask({
    title: "Night chalice",
    artifactId,
    material: "PLA",
    pinnedPrinterId: "k2",
    night: true,
    unattendedAllowed: over.unattendedAllowed ?? true
  });
  // The on-device file name lives in task metadata for hashed artifacts.
  const task = h.store.repositories.tasks.getById(detail.task.id)!;
  h.store.repositories.tasks.update({
    ...task,
    metadata: { ...task.metadata, file: "chalice.gcode" },
    updatedAt: iso
  });
  return { taskId: detail.task.id, artifactId };
}

// ── Manual dispatch through SQLite ──────────────────────────────────────────

test("manual dispatch reserves task/assignment/attempt/run in SQLite, sends ONE command, finalizes RUNNING", async () => {
  const h = makeHarness();
  const taskId = addManualTask(h);

  const result = await h.dispatch.dispatch({ taskId, mode: "manual" });

  assert.equal(h.startCalls.length, 1, "exactly one physical command");
  assert.equal(h.startCalls[0].runId, result.runId, "the command carries the reserved runId");
  assert.equal(h.startCalls[0].file, "chalice.gcode");

  const repos = h.store.repositories;
  const run = repos.printRuns.getById(result.runId)!;
  assert.equal(run.state, "RUNNING");
  assert.equal(run.file, "chalice.gcode");
  assert.equal(repos.tasks.getById(taskId)?.state, "PRINTING");
  assert.equal(repos.queue.findByTaskId(taskId)?.state, "RELEASED");
  assert.equal(repos.assignments.getById(run.assignmentId)?.state, "ACTIVE");
  const attempt = repos.dispatchAttempts.getById(run.dispatchAttemptId!)!;
  assert.equal(attempt.state, "ACKED");
});

test("a SQLite refusal BEFORE dispatch means no command is ever sent (preview version conflict)", async () => {
  const h = makeHarness();
  const taskId = addManualTask(h);

  await assert.rejects(
    h.dispatch.dispatch({ taskId, mode: "manual", expectedTaskVersion: 99 }),
    (e: unknown) => e instanceof PreviewConflictError
  );
  assert.equal(h.startCalls.length, 0, "nothing reached the printer");
  // The reserve transaction rolled back atomically: no run, assignment or bed leaked.
  const repos = h.store.repositories;
  assert.equal(repos.printRuns.listActive().length, 0, "no run was reserved");
  assert.equal(repos.assignments.listByTask(taskId).length, 0, "no assignment leaked");
  assert.equal(repos.bedCycles.findOpenByPrinter("k2"), null, "no bed cycle leaked");
  assert.equal(repos.tasks.getById(taskId)?.state, "QUEUED", "task untouched");
});

test("preview of version N cannot start the queue at version N+1 (queue param edit invalidates)", async () => {
  const h = makeHarness();
  const taskId = addManualTask(h);
  const v1 = h.store.repositories.tasks.getById(taskId)!.version;

  // Another operator edits the task between preview and confirm.
  const task = h.store.repositories.tasks.getById(taskId)!;
  h.store.repositories.tasks.update({ ...task, material: "PETG", updatedAt: new Date().toISOString() });

  await assert.rejects(
    h.dispatch.dispatch({ taskId, mode: "manual", expectedTaskVersion: v1 }),
    (e: unknown) => e instanceof PreviewConflictError
  );
  assert.equal(h.startCalls.length, 0);
});

test("artifact hash drift between preview and start refuses with 409", async () => {
  const h = makeHarness();
  const { taskId } = addNightTask(h);

  await assert.rejects(
    h.dispatch.dispatch({
      taskId,
      mode: "night",
      expectedArtifactSha256: "b".repeat(64) // the operator saw a different file
    }),
    (e: unknown) => e instanceof PreviewConflictError
  );
  assert.equal(h.startCalls.length, 0);
});

test("timeout after an accepted command: run → UNKNOWN, held; NO second run on retry", async () => {
  const h = makeHarness();
  const taskId = addManualTask(h);
  h.knobs.startImpl = async (printerId, file, runId) => {
    // Emulate the command service: durable guard BEFORE dispatch, then a lost response.
    h.store.repositories.startGuards.upsert({
      printerId,
      file,
      state: "UNKNOWN",
      jobRef: runId,
      runId,
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    throw new Error("timeout");
  };
  h.knobs.classify = () => "unknown";

  await assert.rejects(h.dispatch.dispatch({ taskId, mode: "manual" }));
  const active = h.store.repositories.printRuns.listActive();
  assert.equal(active.length, 1);
  assert.equal(active[0].state, "UNKNOWN", "run is held, not failed");

  // A retry must NOT re-dispatch: guard + active run hold the printer.
  await assert.rejects(
    h.dispatch.dispatch({ taskId, mode: "manual" }),
    (e: unknown) => e instanceof JobError
  );
  assert.equal(h.startCalls.length, 1, "the device saw exactly one command");
  assert.equal(h.store.repositories.printRuns.listByTask(taskId).length, 1, "one run, ever");
});

test("a definitive rejection unwinds: run CANCELLED, task re-queued with reason, retry allowed", async () => {
  const h = makeHarness();
  const taskId = addManualTask(h);
  h.knobs.startImpl = async () => {
    throw new Error("File not found");
  };
  h.knobs.classify = () => "rejected";

  await assert.rejects(h.dispatch.dispatch({ taskId, mode: "manual" }));
  const repos = h.store.repositories;
  assert.equal(repos.printRuns.listActive().length, 0, "no active run left");
  const task = repos.tasks.getById(taskId)!;
  assert.equal(task.state, "QUEUED", "re-queued for a corrected retry");
  assert.match(task.reason ?? "", /отклонён/);

  // A corrected retry goes through and mints a NEW run.
  h.knobs.startImpl = async () => {};
  const result = await h.dispatch.dispatch({ taskId, mode: "manual" });
  assert.equal(repos.printRuns.getById(result.runId)?.state, "RUNNING");
  assert.equal(repos.printRuns.listByTask(taskId).length, 2, "history keeps both runs");
});

test("restart with an UNKNOWN run: recovery holds it, dispatch refused, no second command", async () => {
  const h = makeHarness();
  const taskId = addManualTask(h);
  h.knobs.startImpl = async (printerId, file, runId) => {
    h.store.repositories.startGuards.upsert({
      printerId,
      file,
      state: "UNKNOWN",
      jobRef: runId,
      runId,
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    throw new Error("timeout");
  };
  await assert.rejects(h.dispatch.dispatch({ taskId, mode: "manual" }));

  // "Restart": a fresh lifecycle over the same store runs boot recovery.
  const lifecycle = new RunLifecycleService(h.store);
  const recovered = lifecycle.recover();
  assert.equal(recovered.held, 1, "the unknown dispatch is held, not resolved");
  assert.equal(h.store.repositories.printRuns.listActive().length, 1);

  await assert.rejects(
    h.dispatch.dispatch({ taskId, mode: "manual" }),
    (e: unknown) => e instanceof JobError
  );
  assert.equal(h.startCalls.length, 1, "still exactly one physical command across the restart");
});

test("restart recovery unwinds a PENDING run whose command provably never left (no guard)", async () => {
  const h = makeHarness();
  const taskId = addManualTask(h);
  // Crash between the reserve commit and the guard write: simulate by making
  // the physical send die BEFORE the guard exists, with classify = unknown and
  // then dropping the finalize (we emulate by reserving via a failed dispatch
  // whose finalize wrote UNKNOWN — so instead build the state manually).
  h.knobs.startImpl = async () => {
    throw new Error("process crashed");
  };
  h.knobs.classify = () => "unknown";
  await assert.rejects(h.dispatch.dispatch({ taskId, mode: "manual" }));
  // Emulate "crash before finalize + before guard": force the run back to
  // PENDING and remove any guard.
  const repos = h.store.repositories;
  const run = repos.printRuns.listByTask(taskId)[0];
  const current = repos.printRuns.getById(run.id)!;
  h.store.transaction(() => {
    repos.printRuns.update({ ...current, state: "PENDING" as never, updatedAt: new Date().toISOString() });
  });
  repos.startGuards.delete("k2");

  const recovered = new RunLifecycleService(h.store).recover();
  assert.equal(recovered.unwound, 1, "never-sent dispatch is unwound");
  assert.equal(repos.printRuns.getById(run.id)?.state, "CANCELLED");
  assert.equal(repos.tasks.getById(taskId)?.state, "QUEUED", "task re-queued");
});

test("idempotency: repeating the same key returns the SAME run and sends nothing new", async () => {
  const h = makeHarness();
  const taskId = addManualTask(h);

  const first = await h.dispatch.dispatch({ taskId, mode: "manual", idempotencyKey: "op-1" });
  const second = await h.dispatch.dispatch({ taskId, mode: "manual", idempotencyKey: "op-1" });

  assert.equal(second.runId, first.runId);
  assert.equal(second.deduplicated, true);
  assert.equal(h.startCalls.length, 1, "one key → one physical command");
});

// ── Night dispatch ──────────────────────────────────────────────────────────

test("night dispatch: a fully-qualified hashed+analysed task starts through the same SQLite path", async () => {
  const h = makeHarness();
  const { taskId, artifactId } = addNightTask(h);

  const result = await h.dispatch.dispatch({ taskId, mode: "night" });
  assert.equal(h.startCalls.length, 1);
  const run = h.store.repositories.printRuns.getById(result.runId)!;
  assert.equal(run.state, "RUNNING");
  assert.equal(run.artifactId, artifactId, "the run records the artifact identity");
  assert.equal(run.artifactSha256, "a".repeat(64), "…and the immutable hash");
});

for (const [label, mutate] of Object.entries({
  "verdict review": { analysis: { verdict: "review" as const } },
  "verdict needs_preparation": { analysis: { verdict: "needs_preparation" as const } },
  "detected format unknown": { analysis: { detectedFormat: "unknown" as const } },
  "analysis carries blockers": {
    analysis: { blockers: [{ code: "x", message: "опасная команда" }] }
  },
  "no artifact hash": { sha: null },
  "no artifact size": { size: null },
  "no unattended permission": { unattendedAllowed: false },
  "stale analyzer version": { analysis: { analyzerVersion: "0.0.1" } }
} as const)) {
  test(`night dispatch refuses fail-closed: ${label}`, async () => {
    const h = makeHarness();
    const { taskId } = addNightTask(h, mutate as never);
    await assert.rejects(
      h.dispatch.dispatch({ taskId, mode: "night" }),
      (e: unknown) => e instanceof JobError
    );
    assert.equal(h.startCalls.length, 0, "nothing reached the printer");
  });
}

test("night dispatch refuses when the file changed after analysis (stale analysis)", async () => {
  const h = makeHarness();
  const { taskId, artifactId } = addNightTask(h);
  // The artifact content moved AFTER the analysis was produced.
  const repos = h.store.repositories;
  const artifact = repos.artifacts.getById(artifactId)!;
  repos.artifacts.update({
    ...artifact,
    sha256: "c".repeat(64),
    updatedAt: new Date(Date.now() + 60_000).toISOString()
  });

  await assert.rejects(
    h.dispatch.dispatch({ taskId, mode: "night" }),
    (e: unknown) => e instanceof JobError && /изменился после/.test(e.message)
  );
  assert.equal(h.startCalls.length, 0);
});

test("same name but different size on the device refuses the dispatch (identity mismatch)", async () => {
  const h = makeHarness();
  const { taskId } = addNightTask(h);
  h.knobs.deviceFiles = [{ filename: "chalice.gcode", size: 999 }]; // ≠ artifact 1000

  await assert.rejects(
    h.dispatch.dispatch({ taskId, mode: "night" }),
    (e: unknown) => e instanceof JobError && /отличается/.test(e.message)
  );
  assert.equal(h.startCalls.length, 0);
});

test("a file missing on the device refuses before anything is reserved", async () => {
  const h = makeHarness();
  const taskId = addManualTask(h);
  h.knobs.deviceFiles = [];

  await assert.rejects(
    h.dispatch.dispatch({ taskId, mode: "manual" }),
    (e: unknown) => e instanceof JobError && /не найден/.test(e.message)
  );
  assert.equal(h.startCalls.length, 0);
  assert.equal(h.store.repositories.printRuns.listByTask(taskId).length, 0);
});

// ── Service-level lifecycle invariants (canonical dispatch path) ────────────
// These were previously asserted against PrintQueueService.startRun/completeRun,
// an alternative lifecycle that has been removed; they now run through the
// canonical DispatchService / RunLifecycleService.

test("the dispatch path journals the run lifecycle (reserved → started, task dispatching → printing)", async () => {
  const h = makeHarness();
  const taskId = addManualTask(h);
  const result = await h.dispatch.dispatch({ taskId, mode: "manual" });
  const repos = h.store.repositories;

  const runAudit = repos.audit.listByEntity("print_run", result.runId).map((e) => e.action);
  assert.ok(runAudit.includes("reserved"), "run reservation is journalled");
  assert.ok(runAudit.includes("started"), "run start is journalled");
  const taskAudit = repos.audit.listByEntity("print_task", taskId).map((e) => e.action);
  assert.ok(taskAudit.includes("dispatching"));
  assert.ok(taskAudit.includes("printing"));
  assert.ok(repos.audit.list().some((e) => e.entityType === "assignment"));
});

test("a second dispatch for a task already printing is refused (one active run per task)", async () => {
  const h = makeHarness();
  const taskId = addManualTask(h);
  await h.dispatch.dispatch({ taskId, mode: "manual" });

  await assert.rejects(
    h.dispatch.dispatch({ taskId, mode: "manual" }),
    (e: unknown) => e instanceof JobError
  );
  assert.equal(h.startCalls.length, 1, "no second physical command");
  assert.equal(h.store.repositories.printRuns.listByTask(taskId).length, 1, "one run, ever");
});

test("a second task cannot dispatch to a printer that already runs (one active run per printer)", async () => {
  const h = makeHarness();
  h.knobs.deviceFiles = [
    { filename: "a.gcode", size: 1000 },
    { filename: "b.gcode", size: 1000 }
  ];
  const t1 = addManualTask(h, { file: "a.gcode" });
  await h.dispatch.dispatch({ taskId: t1, mode: "manual" });

  const t2 = h.queue.createTask({ title: "B", printer: "k2", file: "b.gcode" }).task.id;
  await assert.rejects(
    h.dispatch.dispatch({ taskId: t2, mode: "manual" }),
    (e: unknown) => e instanceof JobError
  );
  assert.equal(h.startCalls.length, 1, "the busy printer saw no second command");
});

test("cancelTask on a live dispatched run: run CANCELLED, task CANCELLED, bed awaiting clearance", async () => {
  const h = makeHarness();
  const taskId = addManualTask(h);
  const result = await h.dispatch.dispatch({ taskId, mode: "manual" });
  const repos = h.store.repositories;
  assert.equal(repos.printRuns.getById(result.runId)?.state, "RUNNING");

  h.queue.cancelTask(taskId, "оператор отменил");
  assert.equal(repos.tasks.getById(taskId)?.state, "CANCELLED", "task kept, not deleted");
  assert.equal(repos.printRuns.getById(result.runId)?.state, "CANCELLED");
  assert.equal(repos.assignments.getById(result.assignmentId)?.state, "CANCELLED");
  assert.equal(repos.bedCycles.findOpenByPrinter("k2")?.state, "AWAITING_CLEARANCE");
  assert.equal(repos.queue.findByTaskId(taskId)?.state, "RELEASED");
});

test("bed clearance: a completed run leaves the bed AWAITING_CLEARANCE; a manual dispatch presumes it clear", async () => {
  const h = makeHarness();
  h.knobs.deviceFiles = [
    { filename: "a.gcode", size: 1000 },
    { filename: "b.gcode", size: 1000 }
  ];
  const t1 = addManualTask(h, { file: "a.gcode" });
  const r1 = await h.dispatch.dispatch({ taskId: t1, mode: "manual" });
  h.lifecycle.completeRun(r1.runId, "SUCCEEDED");

  const repos = h.store.repositories;
  assert.equal(
    repos.bedCycles.findOpenByPrinter("k2")?.state,
    "AWAITING_CLEARANCE",
    "part still on the bed after a print"
  );

  // A new manual start presumes the awaiting bed clear (audited) and runs.
  const t2 = h.queue.createTask({ title: "B", printer: "k2", file: "b.gcode" }).task.id;
  const r2 = await h.dispatch.dispatch({ taskId: t2, mode: "manual" });
  assert.equal(repos.printRuns.getById(r2.runId)?.state, "RUNNING");
  assert.ok(
    repos.audit.list().some((e) => e.entityType === "bed_cycle" && e.action === "presumed_cleared"),
    "the awaiting-clearance bed was presumed clear with an audit trace"
  );
});

// ── Engine-enforced invariants (008 partial unique indexes) ─────────────────

test("the DB itself refuses a second active run on one printer (backstop behind the service)", () => {
  const h = makeHarness();
  const t1 = addManualTask(h);
  const repos = h.store.repositories;
  const iso = new Date().toISOString();
  const mkRun = (taskId: string, assignmentId: string) => ({
    id: newId(ID_PREFIX.printRun),
    taskId,
    assignmentId,
    dispatchAttemptId: null,
    printerId: "k2",
    bedCycleId: null,
    state: "RUNNING" as const,
    file: null,
    artifactId: null,
    artifactSha256: null,
    idempotencyKey: null,
    startedAt: iso,
    endedAt: null,
    progress: 0,
    filamentUsedG: null,
    durationS: null,
    createdAt: iso,
    updatedAt: iso,
    version: 1,
    legacyRef: null,
    metadata: {}
  });
  const asg = h.queue.assignTask(t1, "k2");
  repos.printRuns.insert(mkRun(t1, asg.id));

  const t2 = h.queue.createTask({ title: "Second", printer: "k2", file: "x.gcode" }).task.id;
  assert.throws(
    () => repos.printRuns.insert(mkRun(t2, asg.id)),
    (e: unknown) => e instanceof UniqueConstraintError
  );
});

test("the DB refuses a second active run for one task and a duplicated idempotency key", () => {
  const h = makeHarness();
  const t1 = addManualTask(h);
  const repos = h.store.repositories;
  const iso = new Date().toISOString();
  const asg = h.queue.assignTask(t1, "k2");
  const base = {
    taskId: t1,
    assignmentId: asg.id,
    dispatchAttemptId: null,
    bedCycleId: null,
    file: null,
    artifactId: null,
    artifactSha256: null,
    startedAt: iso,
    endedAt: null,
    progress: 0,
    filamentUsedG: null,
    durationS: null,
    createdAt: iso,
    updatedAt: iso,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  repos.printRuns.insert({
    ...base,
    id: newId(ID_PREFIX.printRun),
    printerId: "k2",
    state: "RUNNING",
    idempotencyKey: "key-1"
  });
  // Second active run, same task, DIFFERENT printer → still refused (task index).
  assert.throws(
    () =>
      repos.printRuns.insert({
        ...base,
        id: newId(ID_PREFIX.printRun),
        printerId: "other",
        state: "PENDING",
        idempotencyKey: null
      }),
    (e: unknown) => e instanceof UniqueConstraintError
  );
  // Terminal runs do not collide; a duplicated idempotency key does.
  assert.throws(
    () =>
      repos.printRuns.insert({
        ...base,
        id: newId(ID_PREFIX.printRun),
        printerId: "other2",
        state: "SUCCEEDED",
        idempotencyKey: "key-1"
      }),
    (e: unknown) => e instanceof UniqueConstraintError
  );
});
