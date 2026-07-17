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
  BedCycleState,
  MaterialOverride,
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
import { applySafetyBuffer, type EtaSource } from "../../domain/scheduling/eta";
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
  /**
   * Remaining time of the print currently on this printer, in ms; null when it is
   * not printing or the device reports no estimate. Drives the planner's free-time
   * so a plan never promises a start on a printer that is still busy.
   */
  printingTimeLeftMs: number | null;
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

/** Default validity of a material override when the operator gives no window (a night's worth). */
const DEFAULT_OVERRIDE_VALID_HOURS = 16;

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
      // createDraft seeds the new revision from `base` and then supersedes every
      // other DRAFT (including a DRAFT base) via {@link supersedeOtherDrafts}. A
      // confirmed (ACTIVE) base is deliberately left untouched — the new draft just
      // carries a higher revision and points back to it.
      return this.createDraft({ name: base.name, window: base.window, base });
    });
  }

  /**
   * Manually confirms a DRAFT plan (DRAFT → ACTIVE) — the only path to a confirmed
   * plan. In one transaction it also (a) **supersedes** the previous ACTIVE plan
   * (→ CANCELLED), so there is never more than one live plan, and (b) **revalidates**
   * the draft: every placed task must still be schedulable at confirm time, else it
   * refuses (409) rather than confirming a plan that assigns a cancelled/held task.
   * An optional {@link expectedVersion} guards against confirming a stale draft.
   */
  confirmPlan(planId: string, actor?: string, expectedVersion?: number): PlanDetail {
    return this.store.transaction(() => {
      const plan = this.requirePlan(planId);
      if (plan.state !== "DRAFT") {
        throw new JobError(`Подтвердить можно только черновик; план «${planId}» — «${plan.state}»`);
      }
      if (expectedVersion !== undefined && plan.version !== expectedVersion) {
        throw new JobError(
          `План «${planId}» изменился (версия ${plan.version} ≠ ожидаемой ${expectedVersion}) — обновите черновик`
        );
      }

      // Re-check that every placed task is still schedulable; a task cancelled/held
      // since the draft was built makes the plan unexecutable.
      const stale = this.staleAssignments(plan.id);
      if (stale.length > 0) {
        throw new JobError(
          `План устарел: задания больше не готовы к планированию (${stale
            .map((s) => s.title)
            .join(", ")}) — пересчитайте черновик`,
          { staleTasks: stale }
        );
      }

      assertTransition("план", PLAN_TRANSITIONS, plan.state, "ACTIVE");

      // Supersede the currently-confirmed plan, if any, before this one goes ACTIVE
      // (also what the single-ACTIVE storage guard requires).
      for (const other of this.store.repositories.plans.list()) {
        if (other.id !== plan.id && other.state === "ACTIVE") {
          this.cancelActive(other, `superseded by ${plan.id}`);
        }
      }

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

  /** Placed tasks in a plan that are no longer schedulable (title + id), for a confirm-time check. */
  private staleAssignments(planId: string): { taskId: string; title: string }[] {
    const schedulable = new Set(this.schedulableTasks().map((t) => t.id));
    const stale: { taskId: string; title: string }[] = [];
    const seen = new Set<string>();
    for (const a of this.assignmentsOf(planId)) {
      if (a.state === "CANCELLED" || a.state === "RELEASED") continue;
      if (seen.has(a.taskId) || schedulable.has(a.taskId)) continue;
      seen.add(a.taskId);
      const task = this.store.repositories.tasks.getById(a.taskId);
      stale.push({ taskId: a.taskId, title: task?.title ?? a.taskId });
    }
    return stale;
  }

  /** Supersedes a confirmed (ACTIVE) plan: cancels its still-open assignments, plan → CANCELLED. */
  private cancelActive(plan: Plan, reason: string): void {
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
      action: "superseded",
      from: plan.state,
      to: "CANCELLED",
      detail: { reason }
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

  // ── Material overrides (operator-facing) ─────────────────────────────────────────

  /**
   * Records the operator assertion "this printer has enough loaded filament" —
   * the manual stand-in for the remaining-material telemetry the farm lacks, and
   * the only thing that lets a night candidate clear the material gate. The printer
   * must exist in the farm config; the assertion carries an author and an expiry.
   */
  setMaterialOverride(
    printerId: string,
    input: {
      sufficient?: boolean;
      coverageHours?: number | null;
      note?: string | null;
      validForHours?: number | null;
      author?: string;
    } = {}
  ): MaterialOverride {
    const id = printerId.trim();
    if (!id) throw new ValidationError("Не указан принтер");
    if (!this.listPrinters().some((p) => p.id === id)) {
      throw new ValidationError(`Принтер «${id}» отсутствует в конфигурации фермы`);
    }
    const coverageHours =
      input.coverageHours === null || input.coverageHours === undefined
        ? null
        : requirePositive(input.coverageHours, "coverageHours");
    const validForHours =
      input.validForHours === null || input.validForHours === undefined
        ? DEFAULT_OVERRIDE_VALID_HOURS
        : requirePositive(input.validForHours, "validForHours");

    const nowMs = this.config.now().getTime();
    const iso = new Date(nowMs).toISOString();
    return this.store.transaction(() => {
      const override: MaterialOverride = {
        id: newId(ID_PREFIX.materialOverride),
        printerId: id,
        sufficient: input.sufficient !== false,
        coverageHours,
        note: input.note?.trim() || null,
        author: input.author ?? this.actor,
        createdAt: iso,
        expiresAt: new Date(nowMs + validForHours * 3_600_000).toISOString(),
        version: 1,
        metadata: {}
      };
      this.store.repositories.materialOverrides.insert(override);
      this.recordAudit({
        entityType: "material_override",
        entityId: override.id,
        action: "created",
        actor: input.author,
        detail: { printerId: id, sufficient: override.sufficient, coverageHours, validForHours }
      });
      return override;
    });
  }

  /** The active (unexpired) material override for every printer that has one. */
  listActiveMaterialOverrides(): MaterialOverride[] {
    return this.listPrinters()
      .map((p) => this.activeMaterialOverride(p.id))
      .filter((o): o is MaterialOverride => o !== null);
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
      // Already resolved (config field > ready-slice machine bed > approved profile
      // bed); null only when no source knows it → an honest `review`.
      buildVolume,
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
  ): {
    taskInput: CompatibilityTaskInput;
    evidence: CompatibilityEvidence;
    buildVolume: Dimensions | null;
    needsSlicing: boolean;
    gcodeReady: boolean;
  } {
    const repos = this.store.repositories;
    const artifact = task.artifactId ? repos.artifacts.getById(task.artifactId) : null;
    const needsSlicing = artifact ? artifact.kind !== "gcode" : true;

    const variant = this.readyVariantFor(task.id, printer.id);
    const profileSet = variant ? repos.profileSets.getById(variant.profileSetId) : null;
    const machineFields = profileSet ? this.machineFieldsOf(profileSet) : null;
    const filamentFields = profileSet ? this.filamentFieldsOf(profileSet) : null;

    // Source/output analysis for dimensions/nozzle/material when there is no slice.
    const analysis = artifact ? repos.artifactAnalyses.latestForArtifact(artifact.id) : null;
    // A ready G-code file's readiness proof (the night gate uses it in place of a
    // ready slice + approved set): the analysis finished and found no blockers.
    const gcodeReady =
      analysis !== null &&
      analysis.state === "ready" &&
      analysis.verdict !== "blocked" &&
      analysis.blockers.length === 0;

    const dimensions =
      readDims(variant?.dimensions ?? null) ?? readDims(analysis?.data ?? null) ?? null;
    const requiredNozzleMm =
      machineFields?.nozzleDiameterMm ?? analysis?.nozzleDiameterMm ?? null;
    const material =
      task.material ?? filamentFields?.filamentType ?? analysis?.material ?? null;
    const gcodeFlavor = machineFields?.gcodeFlavor ?? null;

    // Build volume, in priority order: the explicit config field, then the ready
    // slice's own machine bed, then the approved machine profile bound to this
    // printer. The bed is a real, stored value — never invented — so a plain G-code
    // task no longer stalls on "рабочая область неизвестна".
    const sliceBed = bedDimsOf(machineFields);
    const profileBed = this.printerProfileBuildVolume(printer.id);
    const configBed = printer.buildVolume;
    const profileDerived = sliceBed ?? profileBed;
    const buildVolume = configBed ?? profileDerived;
    const buildVolumeConflict =
      configBed !== null && profileDerived !== null && dimsDiffer(configBed, profileDerived);

    const bed = repos.bedCycles.findOpenByPrinter(printer.id);

    const taskInput: CompatibilityTaskInput = {
      id: task.id,
      title: task.title,
      material,
      pinnedPrinterId: task.pinnedPrinterId,
      dimensions,
      requiredNozzleMm,
      gcodeFlavor,
      // No AMS/multi-material requirement is recorded anywhere in the model yet
      // (neither the task nor the analyzers detect it), so this stays an honest
      // `null` = unknown rather than a fabricated boolean. The compatibility AMS
      // branch only fires on `true`, so it is dormant — not wrong — until a real
      // source (a task field or a multi-filament analysis signal) feeds it.
      amsRequired: null,
      needsSlicing
    };

    const evidence: CompatibilityEvidence = {
      readySliceVariant: variant !== null,
      profileSetApproved: profileSet ? profileSet.approved : null,
      profileSetBlocked: profileSet ? profileSet.validation === "blocked" : false,
      runtimeAvailable: this.config.runtimeAvailable,
      bedCycle: this.bedStateFor(printer, bed ? bed.state : null),
      buildVolumeConflict,
      telemetryAgeMs: printer.telemetryAgeMs,
      maintenanceBlockers: [],
      sliceEtaS: variant?.orcaEtaS ?? null,
      gcodeEtaS: analysis?.estimatedDurationS ?? null
    };

    return { taskInput, evidence, buildVolume, needsSlicing, gcodeReady };
  }

  /**
   * The bed occupancy to reason with. A tracked cycle is authoritative; without
   * one we infer honestly from live telemetry instead of assuming CLEAR — a printer
   * that is physically printing (a legacy start outside the model) reads `RUNNING`,
   * and a printer we cannot observe reads `UNKNOWN`, so neither is silently treated
   * as a free bed.
   */
  private bedStateFor(printer: SchedulerPrinterRef, trackedState: BedCycleState | null): BedCycleState {
    if (trackedState !== null) return trackedState;
    if (printer.status === "printing" || printer.status === "paused") return "RUNNING";
    const staleMs = this.compatibilityConfig.telemetryStaleMs;
    const fresh = printer.telemetryAgeMs !== null && printer.telemetryAgeMs <= staleMs;
    if (printer.online && fresh && printer.status === "idle") return "CLEAR";
    return "UNKNOWN";
  }

  /** The build volume from the approved machine profile bound to this printer id, or null. */
  private printerProfileBuildVolume(printerId: string): Dimensions | null {
    const set = this.approvedMachineSetFor(printerId);
    return set ? bedDimsOf(this.machineFieldsOf(set)) : null;
  }

  /** The most recently approved, non-blocked profile set bound to this exact printer id. */
  private approvedMachineSetFor(printerId: string): ProfileSet | null {
    const sets = this.store.repositories.profileSets
      .list()
      .filter((s) => s.printerId === printerId && s.approved && s.validation !== "blocked");
    // `list()` is newest-first by created_at; prefer the most recent approval.
    sets.sort((a, b) => (b.approvedAt ?? b.updatedAt).localeCompare(a.approvedAt ?? a.updatedAt));
    return sets[0] ?? null;
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

  /**
   * The task's *printer-agnostic* required nozzle Ø (mm), from its artifact
   * analysis; null when unknown. The compatibility matrix resolves nozzle per
   * (task, printer) — including a printer-specific slice's machine profile — and
   * blocks a mismatch there; the planner only needs the task's own requirement so
   * its "nozzle swap" penalty and warning have a real value to compare against
   * (they were dead while this was hard-coded null).
   */
  private taskRequiredNozzleMm(task: PrintTask): number | null {
    if (!task.artifactId) return null;
    const analysis = this.store.repositories.artifactAnalyses.latestForArtifact(task.artifactId);
    const nozzle = analysis?.nozzleDiameterMm ?? null;
    return nozzle !== null && Number.isFinite(nozzle) && nozzle > 0 ? nozzle : null;
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
    const { evidence, needsSlicing, gcodeReady } = this.resolveEvidence(task, printer);
    const staleMs = this.compatibilityConfig.telemetryStaleMs;
    const telemetryFresh =
      evidence.telemetryAgeMs !== null && evidence.telemetryAgeMs <= staleMs;
    const etaSeconds = evidence.sliceEtaS ?? evidence.gcodeEtaS ?? null;
    const bufferedEtaSeconds =
      etaSeconds !== null ? applySafetyBuffer(etaSeconds, this.config.nightSafetyBufferRatio) : null;
    return {
      taskId: task.id,
      printerId: printer.id,
      priority: task.priority,
      needsSlicing,
      readySliceVariant: evidence.readySliceVariant,
      profileSetApproved: evidence.profileSetApproved === true,
      gcodeReady,
      etaSeconds,
      // Compare the buffered ETA against the operator's material-coverage override.
      materialSufficient: this.resolveMaterialSufficient(printer, bufferedEtaSeconds),
      telemetryFresh,
      bedCycle: evidence.bedCycle,
      maintenanceBlockers: evidence.maintenanceBlockers,
      unattendedAllowed: task.unattendedAllowed
    };
  }

  /**
   * Whether the printer's loaded filament covers a print of `bufferedEtaSeconds`.
   * A live telemetry hint (rare today) wins; otherwise the operator's material
   * override decides, and with neither the answer is honestly `null` (unknown),
   * which fails the night gate rather than assuming enough.
   */
  private resolveMaterialSufficient(
    printer: SchedulerPrinterRef,
    bufferedEtaSeconds: number | null
  ): boolean | null {
    if (printer.materialRemainingSufficient !== null) return printer.materialRemainingSufficient;
    const override = this.activeMaterialOverride(printer.id);
    if (!override) return null;
    if (!override.sufficient) return false;
    if (override.coverageHours === null) return true; // a blanket "enough" assertion
    if (bufferedEtaSeconds === null) return null; // can't verify coverage against an unknown ETA
    return bufferedEtaSeconds <= override.coverageHours * 3600;
  }

  /** The newest still-valid (unexpired) material override for a printer, or null. */
  private activeMaterialOverride(printerId: string): MaterialOverride | null {
    const nowMs = this.config.now().getTime();
    for (const override of this.store.repositories.materialOverrides.listByPrinter(printerId)) {
      if (override.expiresAt === null) return override;
      const expMs = Date.parse(override.expiresAt);
      if (!Number.isFinite(expMs) || expMs > nowMs) return override;
    }
    return null;
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

    // `tasks` is in queue order (schedulableTasks reads listOpen), so the index is
    // the operator's manual rank — feeding it to the planner makes a reorder move.
    const plannerTasks: PlannerTaskInput[] = tasks.map((task, index) => {
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
        requiredNozzleMm: this.taskRequiredNozzleMm(task),
        etaSeconds: eta?.seconds ?? null,
        compatiblePrinterIds: compatible.map((r) => r.printerId),
        previousPrinterId: previousByTask.get(task.id) ?? null,
        queueRank: index
      };
    });

    const plannerPrinters: PlannerPrinterInput[] = printers.map((p) => {
      const { freeAtMs, estimated } = this.printerFreeAt(p, now);
      return {
        printerId: p.id,
        name: p.name,
        freeAtMs,
        freeAtEstimated: estimated,
        currentMaterial: p.material,
        currentNozzleMm: p.nozzleMm
      };
    });

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

    // A fresh draft supersedes every other outstanding DRAFT, so repeated or
    // parallel builds cannot leave a pile of orphan drafts competing to be "the
    // plan". Confirmed (ACTIVE) plans are left untouched — only confirm supersedes
    // those.
    this.supersedeOtherDrafts(plan.id);

    return this.buildPlanDetail(plan);
  }

  /** Cancels every DRAFT plan except `keepId` (they are superseded by the new draft). */
  private supersedeOtherDrafts(keepId: string): void {
    for (const other of this.store.repositories.plans.list()) {
      if (other.id !== keepId && other.state === "DRAFT") {
        this.cancelDraft(other, "superseded");
      }
    }
  }

  /**
   * When a printer becomes free, from live telemetry and confirmed work. A printer
   * that is printing pushes free-time out by its reported remaining time; if it is
   * printing but reports no remaining time, the free-time is *estimated* (flagged so
   * placements warn) rather than pretended to be now. Assignments already committed
   * by a confirmed (ACTIVE) plan push it out further still.
   */
  private printerFreeAt(printer: SchedulerPrinterRef, nowMs: number): { freeAtMs: number; estimated: boolean } {
    let freeAtMs = nowMs;
    let estimated = false;

    if (printer.status === "printing" || printer.status === "paused") {
      if (printer.printingTimeLeftMs !== null && printer.printingTimeLeftMs > 0) {
        freeAtMs = Math.max(freeAtMs, nowMs + printer.printingTimeLeftMs);
      } else {
        // Busy, but no remaining estimate — advance by the disclosed assumption and
        // mark it estimated so a task placed here is warned, not promised.
        freeAtMs = Math.max(freeAtMs, nowMs + this.config.unknownEtaAssumptionS * 1000);
        estimated = true;
      }
    }

    for (const assignment of this.activeAssignmentsForPrinter(printer.id)) {
      const endMs = readExplanation(assignment.metadata)?.endMs ?? null;
      if (endMs !== null) freeAtMs = Math.max(freeAtMs, endMs);
      else estimated = true; // a committed assignment with unknown end is an estimate too
    }

    return { freeAtMs, estimated };
  }

  /** Open assignments (not released/cancelled) a confirmed ACTIVE plan holds on a printer. */
  private activeAssignmentsForPrinter(printerId: string): Assignment[] {
    const out: Assignment[] = [];
    for (const plan of this.store.repositories.plans.list()) {
      if (plan.state !== "ACTIVE") continue;
      for (const a of this.assignmentsOf(plan.id)) {
        if (
          a.printerId === printerId &&
          (a.state === "PROPOSED" || a.state === "RESERVED" || a.state === "ACTIVE")
        ) {
          out.push(a);
        }
      }
    }
    return out;
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
    // One indexed lookup on assignments.plan_id (migration 006), already ordered by
    // created_at, id — not a scan of every task's assignments. This is called on
    // every plan view/confirm/supersede and free-time projection, so it must not
    // degrade as the (never-deleted) task history grows.
    return this.store.repositories.assignments.listByPlan(planId);
  }

  private previousPlacements(planId: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const a of this.assignmentsOf(planId)) {
      if (a.state !== "CANCELLED" && a.state !== "RELEASED") map.set(a.taskId, a.printerId);
    }
    return map;
  }

  // ── Internals: shared ─────────────────────────────────────────────────────────

  /**
   * Open-queue tasks eligible for planning, in queue order: a `WAITING` entry whose
   * task is still awaiting placement (`QUEUED`/`PLANNED`). An `ASSIGNED` task already
   * holds a printer/bed (via {@link PrintQueueService.assignTask}) and must not be
   * planned onto a second one; a `NEEDS_REVIEW` task is parked for a human. Neither
   * is schedulable, so both are excluded here (the one place planning, the matrix,
   * and the night gate read).
   */
  private schedulableTasks(): PrintTask[] {
    const repos = this.store.repositories;
    const tasks: PrintTask[] = [];
    for (const entry of repos.queue.listOpen()) {
      if (entry.state !== "WAITING") continue;
      const task = repos.tasks.getById(entry.taskId);
      if (!task) continue;
      if (task.state === "QUEUED" || task.state === "PLANNED") {
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

/** A finite, strictly-positive number, else a 400 — for operator-supplied hours. */
function requirePositive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`Поле «${field}» должно быть положительным числом`);
  }
  return value;
}

/** The `{x,y,z}` build volume from parsed machine fields, or null when any axis is unknown. */
function bedDimsOf(machine: ReturnType<typeof readMachine> | null): Dimensions | null {
  if (
    machine &&
    machine.bedWidthMm !== null &&
    machine.bedDepthMm !== null &&
    machine.bedHeightMm !== null
  ) {
    return { x: machine.bedWidthMm, y: machine.bedDepthMm, z: machine.bedHeightMm };
  }
  return null;
}

/** True when two build volumes differ on any axis by more than a rounding tolerance. */
function dimsDiffer(a: Dimensions, b: Dimensions): boolean {
  const eps = 0.5; // mm — profiles/config round bed sizes; ignore sub-mm noise
  return Math.abs(a.x - b.x) > eps || Math.abs(a.y - b.y) > eps || Math.abs(a.z - b.z) > eps;
}

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
