import { JobError, NotFoundError, ValidationError } from "../../core/errors";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import {
  ASSIGNMENT_TRANSITIONS,
  assertTransition,
  PLAN_TRANSITIONS
} from "../../domain/print/states";
import type {
  Assignment,
  AuditEntityType,
  Metadata,
  Plan,
  PrintTask
} from "../../domain/print/types";
import {
  DEFAULT_COMPATIBILITY_CONFIG,
  evaluateCompatibility,
  type CompatibilityConfig,
  type CompatibilityEvidence,
  type CompatibilityPrinterInput,
  type CompatibilityResult,
  type CompatibilityTaskInput,
  type Dimensions
} from "../../domain/scheduling/compatibility";
import type { EtaSource } from "../../domain/scheduling/eta";
import {
  buildPlan,
  type PlannerPrinterInput,
  type PlannerTaskInput,
  type ScoreComponent
} from "../../domain/scheduling/planner";
import {
  evaluateNightGate,
  selectNightSlots,
  type NightEvaluation,
  type NightGateInput
} from "../../domain/scheduling/night";
import { readFilament, readMachine } from "../../domain/slicing/orcaProfile";
import type { ProfileSet, SliceVariant } from "../../domain/slicing/types";
import { settingsOf } from "../slicing/profileService";

/**
 * The manual-scheduler application service — the one place HTTP routes call to
 * turn scheduling intents into audited, transactional changes over the SQLite
 * model. It resolves the live evidence (ready slice variants, approved profile
 * sets, printer telemetry, bed cycles) and delegates every *decision* to the pure
 * domain (`domain/scheduling`): compatibility, the placement heuristic, and the
 * night gate. It never touches the legacy `/api/queue` or `state.json`.
 *
 * Plans are revisioned and manually confirmed: {@link buildDraftPlan} /
 * {@link recomputePlan} always produce a fresh `DRAFT`; {@link confirmPlan} is
 * the only path to `ACTIVE`; and a recompute never edits a confirmed plan — it
 * supersedes it with a new revision. Draft assignments are `PROPOSED` (they hold
 * no bed and start no print — remote start is out of scope), each carrying its
 * full {@link PlanExplanation}.
 */

/** The live view of one printer the scheduler needs; assembled by the caller from telemetry + config. */
export interface SchedulerPrinterRef {
  id: string;
  name: string;
  model: string | null;
  protocol: string | null;
  /** Loaded material (live telemetry or config fallback); null when unknown. */
  material: string | null;
  /** Nozzle diameter (live or config); null when unknown. */
  nozzleMm: number | null;
  /** Build volume in mm from config; null when not configured. */
  buildVolume: Dimensions | null;
  online: boolean;
  status: CompatibilityPrinterInput["status"];
  remoteStartSupported: boolean;
  /** AMS/multi-material support; null when unknown. */
  ams: boolean | null;
  /** ms since the last telemetry update, or null when there is none. */
  telemetryAgeMs: number | null;
  /** Whether remaining material covers a print; null = unknown (fails the night gate honestly). */
  materialRemainingSufficient: boolean | null;
}

export interface SchedulerConfig {
  now: () => Date;
  /** OrcaSlicer runtime availability (probed by the caller); gates un-sliced work. */
  runtimeAvailable: boolean;
  /** Night ETA safety buffer, e.g. 0.2. */
  nightSafetyBufferRatio: number;
  /** Night window label to stamp on a night plan. */
  nightWindow: string;
  compatibility?: CompatibilityConfig;
  /** Scheduling-only assumption (s) for advancing free-time when ETA is unknown. */
  unknownEtaAssumptionS: number;
  actor?: string;
}

/** The stored explanation for one planned assignment (in `assignment.metadata.explanation`). */
export interface PlanExplanation {
  printerId: string;
  reason: string;
  score: number;
  scoreBreakdown: ScoreComponent[];
  alternatives: { printerId: string; score: number }[];
  warnings: string[];
  startMs: number;
  endMs: number | null;
  etaSeconds: number | null;
  etaSource: EtaSource;
  etaPreliminary: boolean;
}

export interface PlanAssignmentView {
  assignment: Assignment;
  task: PrintTask | null;
  explanation: PlanExplanation | null;
}

export interface PlanDetail {
  plan: Plan;
  assignments: PlanAssignmentView[];
  unplaced: { taskId: string; title: string; reason: string }[];
}

/** One task's compatibility row across every printer. */
export interface CompatibilityRow {
  taskId: string;
  title: string;
  results: CompatibilityResult[];
}

export interface CompatibilityMatrix {
  printers: { id: string; name: string }[];
  rows: CompatibilityRow[];
}

export interface NightCandidatesReport {
  window: string;
  safetyBufferRatio: number;
  candidates: {
    taskId: string;
    title: string;
    printerId: string;
    bufferedEtaSeconds: number | null;
    preliminary: boolean;
  }[];
  rejected: { taskId: string; title: string; printerId: string; reasons: string[] }[];
}

export class SchedulerService {
  private readonly compatibilityConfig: CompatibilityConfig;

  constructor(
    private readonly store: PrintQueueStore,
    private readonly listPrinters: () => SchedulerPrinterRef[],
    private readonly config: SchedulerConfig
  ) {
    this.compatibilityConfig = config.compatibility ?? DEFAULT_COMPATIBILITY_CONFIG;
  }

  // ── Compatibility matrix ──────────────────────────────────────────────────────

  /** The task × printer compatibility grid for every schedulable open-queue task. */
  compatibilityMatrix(): CompatibilityMatrix {
    const printers = this.listPrinters();
    const tasks = this.schedulableTasks();
    return {
      printers: printers.map((p) => ({ id: p.id, name: p.name })),
      rows: tasks.map((task) => ({
        taskId: task.id,
        title: task.title,
        results: printers.map((printer) => this.evaluate(task, printer))
      }))
    };
  }

  // ── Plans ─────────────────────────────────────────────────────────────────────

  listPlans(): Plan[] {
    return this.store.repositories.plans.list();
  }

  getPlan(id: string): PlanDetail {
    const plan = this.requirePlan(id);
    return this.buildPlanDetail(plan);
  }

  /** Builds a fresh DRAFT plan from the current queue + live evidence. */
  buildDraftPlan(options: { name?: string; window?: string } = {}): PlanDetail {
    return this.store.transaction(() =>
      this.createDraft({ name: options.name ?? null, window: options.window ?? null, base: null })
    );
  }

  /**
   * Recomputes a plan into a *new* DRAFT revision (never edits it in place). The
   * new draft is seeded with the source plan's placements for stability. A source
   * DRAFT is superseded (CANCELLED); a confirmed (ACTIVE) plan is left untouched —
   * "подтверждённый план нельзя изменять автоматически".
   */
  recomputePlan(planId: string): PlanDetail {
    return this.store.transaction(() => {
      const base = this.requirePlan(planId);
      if (base.state === "COMPLETED" || base.state === "CANCELLED") {
        throw new JobError(`План «${planId}» в состоянии «${base.state}» — пересчёт невозможен`);
      }
      const detail = this.createDraft({
        name: base.name,
        window: base.window,
        base
      });
      if (base.state === "DRAFT") {
        this.cancelDraft(base, "superseded");
      }
      return detail;
    });
  }

  /** Manually confirms a DRAFT plan (DRAFT → ACTIVE). The only path to a confirmed plan. */
  confirmPlan(planId: string, actor?: string): PlanDetail {
    return this.store.transaction(() => {
      const plan = this.requirePlan(planId);
      if (plan.state !== "DRAFT") {
        throw new JobError(`Подтвердить можно только черновик; план «${planId}» — «${plan.state}»`);
      }
      assertTransition("план", PLAN_TRANSITIONS, plan.state, "ACTIVE");
      const iso = this.nowIso();
      const saved = this.store.repositories.plans.update({
        ...plan,
        state: "ACTIVE",
        confirmedAt: iso,
        confirmedBy: actor ?? this.actor,
        updatedAt: iso
      });
      this.recordAudit({
        entityType: "plan",
        entityId: plan.id,
        action: "confirmed",
        from: "DRAFT",
        to: "ACTIVE",
        actor
      });
      return this.buildPlanDetail(saved);
    });
  }

  // ── Night candidates ────────────────────────────────────────────────────────────

  /** Evaluates the night (unattended) gate for every schedulable task, one slot per printer. */
  nightCandidates(): NightCandidatesReport {
    const printers = this.listPrinters();
    const tasks = this.schedulableTasks();
    const titleOf = new Map(tasks.map((t) => [t.id, t.title] as const));

    // Every open task × printer is evaluated; the gate itself enforces the
    // unattended permission and the rest of the criteria, so nothing is pre-filtered.
    const gateInputs: NightGateInput[] = [];
    for (const task of tasks) {
      for (const printer of printers) {
        gateInputs.push(this.nightGateFor(task, printer));
      }
    }
    const evaluations = gateInputs.map((g) => evaluateNightGate(g, {
      safetyBufferRatio: this.config.nightSafetyBufferRatio
    }));
    const { chosen, rejected } = selectNightSlots(gateInputs, evaluations);

    const chosenKeys = new Set(chosen.map((c) => `${c.taskId}:${c.printerId}`));
    const rejectedBySlot = new Map(rejected.map((r) => [`${r.taskId}:${r.printerId}`, r.reason] as const));

    return {
      window: this.config.nightWindow,
      safetyBufferRatio: this.config.nightSafetyBufferRatio,
      candidates: chosen.map((c) => ({
        taskId: c.taskId,
        title: titleOf.get(c.taskId) ?? c.taskId,
        printerId: c.printerId,
        bufferedEtaSeconds: c.bufferedEtaSeconds,
        preliminary: c.preliminary
      })),
      rejected: this.collectNightRejections(evaluations, chosenKeys, rejectedBySlot, titleOf)
    };
  }

  // ── Internals: evidence resolution ────────────────────────────────────────────

  private evaluate(task: PrintTask, printer: SchedulerPrinterRef): CompatibilityResult {
    const { taskInput, evidence, buildVolume } = this.resolveEvidence(task, printer);
    return evaluateCompatibility(
      taskInput,
      this.printerInput(printer, buildVolume),
      evidence,
      this.compatibilityConfig
    );
  }

  private printerInput(
    printer: SchedulerPrinterRef,
    buildVolume: Dimensions | null
  ): CompatibilityPrinterInput {
    return {
      id: printer.id,
      name: printer.name,
      model: printer.model,
      protocol: printer.protocol,
      material: printer.material,
      nozzleMm: printer.nozzleMm,
      // The machine profile's bed (when a ready slice pins one) wins over the
      // config fallback; null when neither is known → an honest `review`.
      buildVolume: buildVolume ?? printer.buildVolume,
      online: printer.online,
      status: printer.status,
      remoteStartSupported: printer.remoteStartSupported,
      ams: printer.ams
    };
  }

  /**
   * Assembles the compatibility inputs for one (task, printer) from the live
   * model: the ready slice variant targeting this printer (if any), its profile
   * set, and the source analysis. Nothing is invented — unknowns stay null.
   */
  private resolveEvidence(
    task: PrintTask,
    printer: SchedulerPrinterRef
  ): { taskInput: CompatibilityTaskInput; evidence: CompatibilityEvidence; buildVolume: Dimensions | null } {
    const repos = this.store.repositories;
    const artifact = task.artifactId ? repos.artifacts.getById(task.artifactId) : null;
    const needsSlicing = artifact ? artifact.kind !== "gcode" : true;

    const variant = this.readyVariantFor(task.id, printer.id);
    const profileSet = variant ? repos.profileSets.getById(variant.profileSetId) : null;
    const machineFields = profileSet ? this.machineFieldsOf(profileSet) : null;
    const filamentFields = profileSet ? this.filamentFieldsOf(profileSet) : null;

    // Source/output analysis for dimensions/nozzle/material when there is no slice.
    const analysis = artifact ? repos.artifactAnalyses.latestForArtifact(artifact.id) : null;

    const dimensions =
      readDims(variant?.dimensions ?? null) ?? readDims(analysis?.data ?? null) ?? null;
    const requiredNozzleMm =
      machineFields?.nozzleDiameterMm ?? analysis?.nozzleDiameterMm ?? null;
    const material =
      task.material ?? filamentFields?.filamentType ?? analysis?.material ?? null;
    const gcodeFlavor = machineFields?.gcodeFlavor ?? null;
    const buildVolume =
      machineFields &&
      machineFields.bedWidthMm !== null &&
      machineFields.bedDepthMm !== null &&
      machineFields.bedHeightMm !== null
        ? { x: machineFields.bedWidthMm, y: machineFields.bedDepthMm, z: machineFields.bedHeightMm }
        : null;

    const bed = repos.bedCycles.findOpenByPrinter(printer.id);

    const taskInput: CompatibilityTaskInput = {
      id: task.id,
      title: task.title,
      material,
      pinnedPrinterId: task.pinnedPrinterId,
      dimensions,
      requiredNozzleMm,
      gcodeFlavor,
      amsRequired: null,
      needsSlicing
    };

    const evidence: CompatibilityEvidence = {
      readySliceVariant: variant !== null,
      profileSetApproved: profileSet ? profileSet.approved : null,
      profileSetBlocked: profileSet ? profileSet.validation === "blocked" : false,
      runtimeAvailable: this.config.runtimeAvailable,
      bedCycle: bed ? bed.state : "CLEAR",
      telemetryAgeMs: printer.telemetryAgeMs,
      maintenanceBlockers: [],
      sliceEtaS: variant?.orcaEtaS ?? null,
      gcodeEtaS: analysis?.estimatedDurationS ?? null
    };

    return { taskInput, evidence, buildVolume };
  }

  /** A ready SliceVariant for this task targeting this printer (by id or class), or null. */
  private readyVariantFor(taskId: string, printerId: string): SliceVariant | null {
    const variants = this.store.repositories.sliceVariants
      .listByTask(taskId)
      .filter((v) => v.state === "ready" && v.outputArtifactId !== null);
    return (
      variants.find((v) => v.targetPrinterId === printerId) ??
      variants.find((v) => v.targetPrinterId === null) ??
      null
    );
  }

  private machineFieldsOf(set: ProfileSet): ReturnType<typeof readMachine> | null {
    const rev = this.store.repositories.profileRevisions.getById(set.machineRevisionId);
    return rev ? readMachine(settingsOf(rev)) : null;
  }

  private filamentFieldsOf(set: ProfileSet): ReturnType<typeof readFilament> | null {
    const rev = this.store.repositories.profileRevisions.getById(set.filamentRevisionId);
    return rev ? readFilament(settingsOf(rev)) : null;
  }

  private nightGateFor(task: PrintTask, printer: SchedulerPrinterRef): NightGateInput {
    const { evidence } = this.resolveEvidence(task, printer);
    const staleMs = this.compatibilityConfig.telemetryStaleMs;
    const telemetryFresh =
      evidence.telemetryAgeMs !== null && evidence.telemetryAgeMs <= staleMs;
    const etaSeconds = evidence.sliceEtaS ?? evidence.gcodeEtaS ?? null;
    return {
      taskId: task.id,
      printerId: printer.id,
      priority: task.priority,
      readySliceVariant: evidence.readySliceVariant,
      profileSetApproved: evidence.profileSetApproved === true,
      etaSeconds,
      materialSufficient: printer.materialRemainingSufficient,
      telemetryFresh,
      bedCycle: evidence.bedCycle,
      maintenanceBlockers: evidence.maintenanceBlockers,
      unattendedAllowed: task.unattendedAllowed
    };
  }

  private collectNightRejections(
    evaluations: NightEvaluation[],
    chosenKeys: Set<string>,
    rejectedBySlot: Map<string, string>,
    titleOf: Map<string, string>
  ): NightCandidatesReport["rejected"] {
    const out: NightCandidatesReport["rejected"] = [];
    const seen = new Set<string>();
    for (const e of evaluations) {
      const key = `${e.taskId}:${e.printerId}`;
      if (chosenKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      const reasons = e.eligible ? [] : e.blockers;
      const slotReason = rejectedBySlot.get(key);
      const allReasons = slotReason ? [slotReason, ...reasons] : reasons;
      if (allReasons.length === 0) continue;
      out.push({
        taskId: e.taskId,
        title: titleOf.get(e.taskId) ?? e.taskId,
        printerId: e.printerId,
        reasons: allReasons
      });
    }
    return out;
  }

  // ── Internals: plan persistence ──────────────────────────────────────────────

  private createDraft(input: { name: string | null; window: string | null; base: Plan | null }): PlanDetail {
    const printers = this.listPrinters();
    const tasks = this.schedulableTasks();
    const now = this.config.now().getTime();

    const previousByTask = input.base ? this.previousPlacements(input.base.id) : new Map<string, string>();

    // Compute compatibility once; feed only `compatible` printers to the planner.
    const compat = new Map<string, CompatibilityResult[]>();
    for (const task of tasks) {
      compat.set(task.id, printers.map((p) => this.evaluate(task, p)));
    }

    const plannerTasks: PlannerTaskInput[] = tasks.map((task) => {
      const results = compat.get(task.id) ?? [];
      const compatible = results.filter((r) => r.verdict === "compatible");
      const eta = compatible.find((r) => r.eta.seconds !== null)?.eta ?? compatible[0]?.eta ?? null;
      return {
        taskId: task.id,
        title: task.title,
        priority: task.priority,
        createdAtMs: Date.parse(task.createdAt) || now,
        notBeforeMs: task.notBefore ? Date.parse(task.notBefore) || null : null,
        deadlineMs: task.deadline ? Date.parse(task.deadline) || null : null,
        pinnedPrinterId: task.pinnedPrinterId,
        material: task.material,
        requiredNozzleMm: null,
        etaSeconds: eta?.seconds ?? null,
        compatiblePrinterIds: compatible.map((r) => r.printerId),
        previousPrinterId: previousByTask.get(task.id) ?? null
      };
    });

    const plannerPrinters: PlannerPrinterInput[] = printers.map((p) => ({
      printerId: p.id,
      name: p.name,
      freeAtMs: now,
      currentMaterial: p.material,
      currentNozzleMm: p.nozzleMm
    }));

    const planResult = buildPlan(plannerTasks, plannerPrinters, {
      nowMs: now,
      unknownEtaAssumptionS: this.config.unknownEtaAssumptionS
    });

    const iso = this.nowIso();
    const revision = input.base ? input.base.revision + 1 : 1;
    const unplaced = planResult.unplaced.map((u) => ({
      taskId: u.taskId,
      title: tasks.find((t) => t.id === u.taskId)?.title ?? u.taskId,
      reason: u.reason
    }));

    const plan: Plan = {
      id: newId(ID_PREFIX.plan),
      name: input.name,
      window: input.window,
      state: "DRAFT",
      revision,
      basePlanId: input.base?.id ?? null,
      confirmedAt: null,
      confirmedBy: null,
      createdAt: iso,
      updatedAt: iso,
      version: 1,
      metadata: { unplaced }
    };
    this.store.repositories.plans.insert(plan);
    this.recordAudit({
      entityType: "plan",
      entityId: plan.id,
      action: "drafted",
      to: "DRAFT",
      detail: { revision, assignments: planResult.assignments.length, unplaced: unplaced.length }
    });

    for (const a of planResult.assignments) {
      const result = (compat.get(a.taskId) ?? []).find((r) => r.printerId === a.printerId);
      const explanation: PlanExplanation = {
        printerId: a.printerId,
        reason: a.reason,
        score: a.score,
        scoreBreakdown: a.scoreBreakdown,
        alternatives: a.alternatives,
        warnings: a.warnings,
        startMs: a.startMs,
        endMs: a.endMs,
        etaSeconds: a.etaSeconds,
        etaSource: result?.eta.source ?? "unknown",
        etaPreliminary: result?.eta.preliminary ?? true
      };
      const assignment: Assignment = {
        id: newId(ID_PREFIX.assignment),
        taskId: a.taskId,
        printerId: a.printerId,
        planId: plan.id,
        bedCycleId: null,
        state: "PROPOSED",
        createdAt: iso,
        updatedAt: iso,
        version: 1,
        legacyRef: null,
        metadata: { explanation }
      };
      this.store.repositories.assignments.insert(assignment);
      this.recordAudit({
        entityType: "assignment",
        entityId: assignment.id,
        action: "proposed",
        to: "PROPOSED",
        detail: { taskId: a.taskId, printerId: a.printerId, planId: plan.id }
      });
    }

    return this.buildPlanDetail(plan);
  }

  /** Cancels a draft plan and its still-proposed assignments (used when superseded). */
  private cancelDraft(plan: Plan, reason: string): void {
    const repos = this.store.repositories;
    for (const a of this.assignmentsOf(plan.id)) {
      if (a.state === "PROPOSED" || a.state === "RESERVED") {
        assertTransition("назначение", ASSIGNMENT_TRANSITIONS, a.state, "CANCELLED");
        repos.assignments.update({ ...a, state: "CANCELLED", updatedAt: this.nowIso() });
      }
    }
    assertTransition("план", PLAN_TRANSITIONS, plan.state, "CANCELLED");
    repos.plans.update({ ...plan, state: "CANCELLED", updatedAt: this.nowIso() });
    this.recordAudit({
      entityType: "plan",
      entityId: plan.id,
      action: "cancelled",
      from: plan.state,
      to: "CANCELLED",
      detail: { reason }
    });
  }

  private buildPlanDetail(plan: Plan): PlanDetail {
    const repos = this.store.repositories;
    const assignments = this.assignmentsOf(plan.id).map((assignment) => ({
      assignment,
      task: repos.tasks.getById(assignment.taskId),
      explanation: readExplanation(assignment.metadata)
    }));
    const unplaced = readUnplaced(plan.metadata);
    return { plan, assignments, unplaced };
  }

  private assignmentsOf(planId: string): Assignment[] {
    // Assignments are looked up per task then filtered by plan; the set per plan is small.
    const tasks = this.store.repositories.tasks.list();
    const out: Assignment[] = [];
    for (const task of tasks) {
      for (const a of this.store.repositories.assignments.listByTask(task.id)) {
        if (a.planId === planId) out.push(a);
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  private previousPlacements(planId: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const a of this.assignmentsOf(planId)) {
      if (a.state !== "CANCELLED" && a.state !== "RELEASED") map.set(a.taskId, a.printerId);
    }
    return map;
  }

  // ── Internals: shared ─────────────────────────────────────────────────────────

  /** Open-queue tasks eligible for planning: WAITING entries whose task is not terminal/in-flight. */
  private schedulableTasks(): PrintTask[] {
    const repos = this.store.repositories;
    const tasks: PrintTask[] = [];
    for (const entry of repos.queue.listOpen()) {
      if (entry.state !== "WAITING") continue;
      const task = repos.tasks.getById(entry.taskId);
      if (!task) continue;
      if (
        task.state === "QUEUED" ||
        task.state === "PLANNED" ||
        task.state === "ASSIGNED" ||
        task.state === "NEEDS_REVIEW"
      ) {
        tasks.push(task);
      }
    }
    return tasks;
  }

  private requirePlan(id: string): Plan {
    const plan = this.store.repositories.plans.getById(id);
    if (!plan) throw new NotFoundError(`План «${id}»`);
    return plan;
  }

  private get actor(): string {
    return this.config.actor ?? "operator";
  }

  private nowIso(): string {
    return this.config.now().toISOString();
  }

  private recordAudit(input: {
    entityType: AuditEntityType;
    entityId: string;
    action: string;
    from?: string;
    to?: string;
    actor?: string;
    detail?: Metadata;
  }): void {
    this.store.repositories.audit.insert({
      id: newId(ID_PREFIX.auditEvent),
      at: this.nowIso(),
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      fromState: input.from ?? null,
      toState: input.to ?? null,
      actor: input.actor ?? this.actor,
      detail: input.detail ?? {}
    });
  }
}

// ── Free helpers ────────────────────────────────────────────────────────────────

/** Reads a `{x,y,z}` bounding box from a slice/analysis metadata blob; null when absent. */
function readDims(meta: Metadata | null): Dimensions | null {
  if (!meta) return null;
  const size = (meta as Record<string, unknown>).size ?? (meta as Record<string, unknown>).bbox;
  if (Array.isArray(size) && size.length >= 3) {
    const [x, y, z] = size;
    if (typeof x === "number" && typeof y === "number" && typeof z === "number") {
      return { x, y, z };
    }
  }
  const dims = (meta as Record<string, unknown>).dimensions;
  if (dims && typeof dims === "object") {
    const d = dims as Record<string, unknown>;
    if (typeof d.x === "number" && typeof d.y === "number" && typeof d.z === "number") {
      return { x: d.x, y: d.y, z: d.z };
    }
  }
  return null;
}

function readExplanation(metadata: Metadata): PlanExplanation | null {
  const raw = metadata.explanation;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as unknown as PlanExplanation;
  }
  return null;
}

function readUnplaced(metadata: Metadata): PlanDetail["unplaced"] {
  const raw = metadata.unplaced;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (item && typeof item === "object") {
      const r = item as Record<string, unknown>;
      if (typeof r.taskId === "string") {
        return [{
          taskId: r.taskId,
          title: typeof r.title === "string" ? r.title : r.taskId,
          reason: typeof r.reason === "string" ? r.reason : ""
        }];
      }
    }
    return [];
  });
}
