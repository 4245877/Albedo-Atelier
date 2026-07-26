import assert from "node:assert/strict";
import { test } from "node:test";

import { JobError, ValidationError } from "../../core/errors";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import { EMPTY_ASSIGNMENT_BINDING, type Assignment, type Plan } from "../../domain/print/types";
import { REASON } from "../../domain/dispatch/reasons";
import type { PrinterConfig } from "../../infra/printers/config";
import { openPrintQueueStore } from "../../infra/db/store";
import { PrintQueueService } from "../printQueue/printQueueService";
import { SchedulerContext } from "../scheduling/context";
import { EligibilityQueries } from "../scheduling/eligibility";
import { EvidenceResolver } from "../scheduling/evidence";
import type { SchedulerPrinterRef } from "../scheduling/types";
import { DispatchService, type DispatchDeps } from "./dispatchService";
import { seedDeviceFile } from "./testkit/deviceFiles";

/*
 * §2.2 (a confirmed plan is executed verbatim) and §2.3 (the manual path cannot
 * bypass the mandatory checks), over a real in-memory SQLite store with two fake
 * printers. No network, no device.
 */

const PRINTERS: PrinterConfig[] = [
  {
    id: "k2",
    name: "Creality K2",
    model: "K2 Plus",
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

interface Harness {
  store: PrintQueueStore;
  queue: PrintQueueService;
  dispatch: DispatchService;
  startCalls: { printerId: string; file: string }[];
}

function makeHarness(): Harness {
  const store = openPrintQueueStore(":memory:");
  const queue = new PrintQueueService(store);
  const startCalls: Harness["startCalls"] = [];

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
      now: () => new Date("2026-07-26T23:00:00Z"),
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
    listFiles: async (_printer, dir) => ({
      path: dir,
      entries: [
        { name: "part.gcode", path: "part.gcode", type: "file" as const, size: 1000, printable: true }
      ]
    }),
    evaluateEligibility: (input) => eligibility().evaluate(input)
  };

  return { store, queue, dispatch: new DispatchService(deps), startCalls };
}

/** A confirmed (ACTIVE) plan binding `taskId` to `printerId`. */
function confirmPlan(
  h: Harness,
  taskId: string,
  printerId: string,
  bindingPatch: Partial<Assignment["binding"]> = {}
): Plan {
  const iso = new Date().toISOString();
  const plan: Plan = {
    id: newId(ID_PREFIX.plan),
    name: "night batch",
    window: null,
    state: "ACTIVE",
    revision: 1,
    basePlanId: null,
    confirmedAt: iso,
    confirmedBy: "operator",
    createdAt: iso,
    updatedAt: iso,
    version: 1,
    metadata: {}
  };
  h.store.repositories.plans.insert(plan);
  const assignment: Assignment = {
    id: newId(ID_PREFIX.assignment),
    taskId,
    printerId,
    planId: plan.id,
    bedCycleId: null,
    state: "PROPOSED",
    source: "plan",
    reason: null,
    createdBy: null,
    binding: { ...EMPTY_ASSIGNMENT_BINDING, ...bindingPatch },
    invalidatedAt: null,
    invalidatedReason: null,
    createdAt: iso,
    updatedAt: iso,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  h.store.repositories.assignments.insert(assignment);
  return plan;
}

/**
 * An operator-confirmed manual file transfer — the evidence a non-upload adapter
 * needs. For such an adapter the named confirmation *is* the verification (there
 * is no listing to check it against), so the record it produces is `VERIFIED`
 * with `operator_confirmed`, exactly like the real service writes.
 */
function confirmManualTransfer(h: Harness, printerId: string, remotePath: string): void {
  seedDeviceFile(h.store, {
    printerId,
    remotePath,
    sizeBytes: 1000,
    transferMode: "manual_file_transfer",
    verification: "operator_confirmed"
  });
}

/**
 * A queued task whose file has already been delivered to `printer` and verified —
 * `prepared: false` leaves the delivery step undone, which is itself a refusal.
 */
function addTask(h: Harness, printer: string, options: { prepared?: boolean } = {}): string {
  const detail = h.queue.createTask({
    title: "Part",
    printer,
    material: "PLA",
    file: "part.gcode"
  });
  if (options.prepared !== false) {
    seedDeviceFile(h.store, {
      printerId: printer,
      remotePath: "part.gcode",
      artifactId: detail.task.artifactId,
      // A Bambu-class printer has no upload API: the operator carried the file.
      ...(printer === "k2"
        ? {}
        : {
            transferMode: "manual_file_transfer" as const,
            verification: "operator_confirmed" as const
          })
    });
  }
  return detail.task.id;
}

// ── §2.2 Executing a confirmed plan ─────────────────────────────────────────

test("a confirmed assignment is executed on its own printer, not the task's hint", async () => {
  const h = makeHarness();
  const taskId = addTask(h, "k2");
  confirmPlan(h, taskId, "k2");

  const result = await h.dispatch.dispatch({ taskId, mode: "manual" });
  assert.equal(result.printerId, "k2");
  assert.equal(h.startCalls[0].printerId, "k2");
});

test("a task re-pinned away from its confirmed assignment refuses instead of switching printers", async () => {
  const h = makeHarness();
  const taskId = addTask(h, "k2");
  confirmPlan(h, taskId, "k2");

  // The plan says k2; somebody re-pins the task to the Bambu afterwards.
  h.queue.pinPrinter(taskId, "x1c");

  await assert.rejects(
    h.dispatch.dispatch({ taskId, mode: "manual" }),
    (e: unknown) =>
      e instanceof JobError &&
      /расхождение назначения/.test(e.message) &&
      (e.details as { blockers?: { code: string }[] }).blockers?.[0]?.code ===
        REASON.ASSIGNMENT_PRINTER_MISMATCH
  );
  assert.equal(h.startCalls.length, 0, "no printer was silently substituted");
});

test("a superseded (CANCELLED) plan no longer binds the dispatch", async () => {
  const h = makeHarness();
  const taskId = addTask(h, "x1c", { prepared: false });
  const plan = confirmPlan(h, taskId, "k2");
  h.store.repositories.plans.update({ ...plan, state: "CANCELLED", updatedAt: new Date().toISOString() });
  // x1c has no upload adapter, so the manual transfer must be confirmed before a
  // start is admissible at all (that rule is asserted separately below).
  confirmManualTransfer(h, "x1c", "part.gcode");

  // With no live confirmed assignment the task's own pin decides again.
  const result = await h.dispatch.dispatch({ taskId, mode: "manual" });
  assert.equal(result.printerId, "x1c");
});

test("a DRAFT plan's proposal does not bind a dispatch (only a confirmed one does)", async () => {
  const h = makeHarness();
  const taskId = addTask(h, "x1c", { prepared: false });
  const plan = confirmPlan(h, taskId, "k2");
  h.store.repositories.plans.update({ ...plan, state: "DRAFT", confirmedAt: null, updatedAt: new Date().toISOString() });
  confirmManualTransfer(h, "x1c", "part.gcode");

  const result = await h.dispatch.dispatch({ taskId, mode: "manual" });
  assert.equal(result.printerId, "x1c", "a draft is a suggestion, not a reservation");
});

test("a printer whose adapter cannot upload refuses a start until the transfer is confirmed", async () => {
  const h = makeHarness();
  const taskId = addTask(h, "x1c", { prepared: false });

  await assert.rejects(
    h.dispatch.dispatch({ taskId, mode: "manual" }),
    (e: unknown) =>
      e instanceof JobError &&
      (e.details as { blockers?: { code: string }[] }).blockers?.some(
        (b) => b.code === REASON.DEVICE_TRANSFER_NOT_CONFIRMED
      ) === true
  );
  assert.equal(h.startCalls.length, 0, "nothing was sent to a printer we cannot deliver to");

  confirmManualTransfer(h, "x1c", "part.gcode");
  const result = await h.dispatch.dispatch({ taskId, mode: "manual" });
  assert.equal(result.printerId, "x1c");
});

test("a confirmed plan expecting a different file refuses the start", async () => {
  const h = makeHarness();
  const taskId = addTask(h, "k2");
  confirmPlan(h, taskId, "k2", { expectedRemotePath: "other.gcode" });

  await assert.rejects(h.dispatch.dispatch({ taskId, mode: "manual" }), JobError);
  assert.equal(h.startCalls.length, 0);
});

// ── §2.3 The manual path cannot bypass the checks ───────────────────────────

test("a manual start still runs the full eligibility check (a missing device file refuses)", async () => {
  const h = makeHarness();
  const detail = h.queue.createTask({
    title: "Ghost",
    printer: "k2",
    material: "PLA",
    file: "absent.gcode"
  });

  await assert.rejects(h.dispatch.dispatch({ taskId: detail.task.id, mode: "manual" }), JobError);
  assert.equal(h.startCalls.length, 0);
});

test("an override without a reason or an operator is rejected outright", async () => {
  const h = makeHarness();
  const taskId = addTask(h, "k2");

  for (const override of [
    { codes: [], reason: "why", operator: "op" },
    { codes: [REASON.DIMENSIONS_UNKNOWN], reason: "  ", operator: "op" },
    { codes: [REASON.DIMENSIONS_UNKNOWN], reason: "why", operator: "" }
  ]) {
    await assert.rejects(
      h.dispatch.dispatch({ taskId, mode: "manual", override }),
      ValidationError,
      JSON.stringify(override)
    );
  }
  assert.equal(h.startCalls.length, 0);
});

test("an override cannot be used on a night dispatch at all", async () => {
  const h = makeHarness();
  const taskId = addTask(h, "k2");

  await assert.rejects(
    h.dispatch.dispatch({
      taskId,
      mode: "night",
      override: { codes: [REASON.DIMENSIONS_UNKNOWN], reason: "я рядом", operator: "op" }
    }),
    ValidationError
  );
  assert.equal(h.startCalls.length, 0);
});

test("an override clears an overridable warning and lands in the audit trail", async () => {
  const h = makeHarness();
  // A legacy task with a delivered on-device file: its model size is unknown (a
  // `review`), which an attended operator may accept with a stated reason.
  const taskId = addTask(h, "k2");

  const result = await h.dispatch.dispatch({
    taskId,
    mode: "manual",
    override: {
      codes: [REASON.DIMENSIONS_UNKNOWN, REASON.DEVICE_FILE_NOT_VERIFIED],
      reason: "габариты сверил по модели вручную",
      operator: "operator-3"
    }
  });
  assert.equal(h.store.repositories.printRuns.getById(result.runId)?.state, "RUNNING");

  const event = h.store.repositories.audit.list().find((e) => e.action === "eligibility_override");
  assert.ok(event, "the override is audited");
  assert.equal(event?.actor, "operator-3");
  const detailBlob = event?.detail as {
    reason?: string;
    operator?: string;
    overridden?: { code: string }[];
    at?: string;
  };
  assert.equal(detailBlob.reason, "габариты сверил по модели вручную");
  assert.equal(detailBlob.operator, "operator-3");
  assert.ok(typeof detailBlob.at === "string", "the override records when it happened");
  assert.ok(
    detailBlob.overridden?.some((r) => r.code === REASON.DIMENSIONS_UNKNOWN),
    "the exact overridden codes are recorded"
  );
});

test("an override naming only irrelevant codes is refused (a stale preview)", async () => {
  const h = makeHarness();
  const taskId = addTask(h, "k2");

  await assert.rejects(
    h.dispatch.dispatch({
      taskId,
      mode: "manual",
      override: { codes: [REASON.AMS_UNSUPPORTED], reason: "не относится", operator: "op" }
    }),
    ValidationError
  );
});

test("no override can start a print over an occupied bed", async () => {
  const h = makeHarness();
  const iso = new Date().toISOString();
  h.store.repositories.bedCycles.insert({
    id: newId(ID_PREFIX.bedCycle),
    printerId: "k2",
    state: "AWAITING_CLEARANCE",
    assignmentId: null,
    createdAt: iso,
    updatedAt: iso,
    clearedAt: null,
    version: 1,
    metadata: {}
  });
  const taskId = addTask(h, "k2");

  await assert.rejects(
    h.dispatch.dispatch({
      taskId,
      mode: "manual",
      override: {
        codes: [REASON.BED_NOT_CLEAR, REASON.OPERATOR_INTERVENTION_REQUIRED],
        reason: "я точно снял",
        operator: "op"
      }
    }),
    (e: unknown) => e instanceof JobError && /стол|модель/i.test(e.message)
  );
  assert.equal(h.startCalls.length, 0, "a hard rule is not negotiable");
});

test("idempotency survives the new checks: the same key never starts a second print", async () => {
  const h = makeHarness();
  const taskId = addTask(h, "k2");

  const first = await h.dispatch.dispatch({ taskId, mode: "manual", idempotencyKey: "key-1" });
  const second = await h.dispatch.dispatch({ taskId, mode: "manual", idempotencyKey: "key-1" });

  assert.equal(second.runId, first.runId);
  assert.equal(second.deduplicated, true);
  assert.equal(h.startCalls.length, 1, "exactly one physical command");
});
