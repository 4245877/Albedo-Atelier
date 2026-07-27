import { JobError, NotFoundError } from "../../core/errors";
import { DEFAULT_OPERATION_MINUTES, OPERATION_LABELS } from "../../domain/operations/states";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import {
  ASSIGNMENT_TRANSITIONS,
  assertTransition,
  PLAN_TRANSITIONS
} from "../../domain/print/states";
import {
  EMPTY_ASSIGNMENT_BINDING,
  type Assignment,
  type Metadata,
  type Plan,
  type PrintTask
} from "../../domain/print/types";
import { profileRevisionsIntact, resolveTaskBinding } from "../dispatch/binding";
import type { CompatibilityResult } from "../../domain/scheduling/compatibility";
import {
  buildPlan,
  type PlannerPrinterInput,
  type PlannerTaskInput
} from "../../domain/scheduling/planner";
import type { PrinterRelease } from "../../domain/scheduling/release";
import type { SchedulerContext } from "./context";
import type { EvidenceResolver } from "./evidence";
import {
  buildTimeline,
  etaConfidenceOf,
  plannable,
  readExplanation,
  readString,
  readStringArray,
  readTimeline,
  readUnplaced,
  sameMaterialFamily,
  unknownRelease
} from "./planView";
import { ReleaseProjector } from "./release";
import type {
  EtaConfidence,
  PlanAssignmentView,
  PlanDetail,
  PlanExplanation,
  PlannedManualOperation,
  PlanStaleness,
  PrinterTimeline,
  SchedulerPrinterRef,
  TimelineSegment,
  UnplacedView
} from "./types";

/** Frozen horizon default: confirmed work starting within 2 h is not re-planned. */
const DEFAULT_FROZEN_HORIZON_S = 2 * 60 * 60;

/**
 * Plan lifecycle — **recommendations only**: revisioned drafts, manual
 * confirmation, recompute-as-new-revision, and the real printer-release
 * projection feeding the placement heuristic.
 *
 * Plans are revisioned and manually confirmed: {@link buildDraftPlan} /
 * {@link recomputePlan} always produce a fresh `DRAFT`; {@link confirmPlan} is
 * the only path to `ACTIVE`; and a recompute never edits a confirmed plan — it
 * supersedes it with a new revision. Draft assignments are `PROPOSED` (they hold
 * no bed and start no print), each carrying its full {@link PlanExplanation}.
 *
 * Three properties this module is responsible for:
 *
 *  1. **A finished print does not free a printer.** Free-time comes from
 *     {@link ReleaseProjector} — machine occupancy *plus* the manual
 *     interventions still owed on the bed *plus* the operator's sleep/absence
 *     calendar, with one pair of hands shared across the farm.
 *  2. **Nothing unknown is guessed into an executable plan.** An unknown release
 *     or ETA leaves the task unplaced with a stable code; the only estimate that
 *     survives is an explicitly-flagged ghost block on the timeline.
 *  3. **Rolling horizon with a frozen head.** Running work and confirmed
 *     placements inside {@link SchedulerConfig.frozenHorizonS} are carried
 *     through a recompute untouched; everything later is free to move.
 */
export class PlanningService {
  private readonly release: ReleaseProjector;

  constructor(
    private readonly ctx: SchedulerContext,
    private readonly evidence: EvidenceResolver
  ) {
    this.release = new ReleaseProjector(ctx);
  }

  private get store() {
    return this.ctx.store;
  }

  listPlans(): Plan[] {
    return this.store.repositories.plans.list();
  }

  getPlan(id: string): PlanDetail {
    const plan = this.requirePlan(id);
    return this.buildPlanDetail(plan);
  }

  /** Builds a fresh DRAFT plan from the current queue + live evidence. */
  buildDraftPlan(options: { name?: string; window?: string; trigger?: string } = {}): PlanDetail {
    return this.store.transaction(() =>
      this.createDraft({
        name: options.name ?? null,
        window: options.window ?? null,
        base: null,
        trigger: options.trigger ?? "manual"
      })
    );
  }

  /**
   * Recomputes a plan into a *new* DRAFT revision (never edits it in place). The
   * new draft is seeded with the source plan's placements for stability. A source
   * DRAFT is superseded (CANCELLED); a confirmed (ACTIVE) plan is left untouched —
   * "подтверждённый план нельзя изменять автоматически" — and the placements it
   * froze are carried through unchanged.
   *
   * `trigger` is the stable code of the event that prompted the recalculation
   * (`task_added`, `print_finished`, `operation_completed`, …). It only ever
   * reaches the audit trail: this call is explicit, and nothing schedules it.
   */
  recomputePlan(planId: string, trigger?: string): PlanDetail {
    return this.store.transaction(() => {
      const base = this.requirePlan(planId);
      if (base.state === "COMPLETED" || base.state === "CANCELLED") {
        throw new JobError(`План «${planId}» в состоянии «${base.state}» — пересчёт невозможен`);
      }
      // createDraft seeds the new revision from `base` and then supersedes every
      // other DRAFT (including a DRAFT base) via {@link supersedeOtherDrafts}. A
      // confirmed (ACTIVE) base is deliberately left untouched — the new draft just
      // carries a higher revision and points back to it.
      return this.createDraft({
        name: base.name,
        window: base.window,
        base,
        trigger: trigger ?? "manual"
      });
    });
  }

  /**
   * The single "recalculate the recommendations" entry point for every event the
   * brief lists (a task added or removed, a priority or deadline change, a print
   * finishing, an intervention appearing or being performed, a schedule or
   * printer-state change, a new slice, an assignment change, a device error).
   *
   * It recomputes the freshest live plan, or builds the first one when there is
   * none. It is **explicitly invoked** — there is no worker, no cron and no
   * background trigger behind it — and it starts nothing: the result is a DRAFT
   * a human still has to confirm.
   */
  recomputeLive(trigger: string): PlanDetail {
    const live = this.livePlan();
    return live ? this.recomputePlan(live.id, trigger) : this.buildDraftPlan({ trigger });
  }

  /** The plan a recompute would act on: the confirmed one, else the newest draft. */
  livePlan(): Plan | null {
    const plans = this.store.repositories.plans.list();
    const active = plans.find((p) => p.state === "ACTIVE");
    if (active) return active;
    const drafts = plans.filter((p) => p.state === "DRAFT");
    drafts.sort((a, b) => b.revision - a.revision || b.createdAt.localeCompare(a.createdAt));
    return drafts[0] ?? null;
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
      // Idempotent: re-confirming the plan that is already live is a no-op, not a
      // second set of assignments (§6.2 "не создавай дубликаты при повторном
      // подтверждении"). A retried request must never re-enter the write path.
      if (plan.state === "ACTIVE") return this.buildPlanDetail(plan);
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

      // The executability re-check: slice variants, artifact hashes, profile
      // revisions and printer availability, per placed assignment. A confirmed
      // plan is executed verbatim later, so anything unverifiable now must refuse
      // here rather than surface as a mystery blocker at start time.
      const problems = this.executabilityProblems(plan.id);
      if (problems.length > 0) {
        throw new JobError(
          `План нельзя подтвердить: ${problems.map((p) => `${p.title} — ${p.reason}`).join("; ")}`,
          { unexecutable: problems }
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

      const iso = this.ctx.nowIso();

      // Freeze the binding as it is *at confirmation*: what the operator confirms is
      // the executable identity of each placement, not whatever the draft happened
      // to see. From here the dispatch verifies against these exact values.
      for (const assignment of this.assignmentsOf(plan.id)) {
        if (assignment.state !== "PROPOSED") continue;
        const task = this.store.repositories.tasks.getById(assignment.taskId);
        if (!task) continue;
        const { binding } = resolveTaskBinding(this.store.repositories, task);
        this.store.repositories.assignments.update({
          ...assignment,
          binding: {
            ...binding,
            etaS: binding.etaS ?? assignment.binding.etaS,
            plannedStartAt: assignment.binding.plannedStartAt,
            planRevision: plan.revision
          },
          updatedAt: iso
        });
        this.ctx.recordAudit({
          entityType: "assignment",
          entityId: assignment.id,
          action: "binding_confirmed",
          actor,
          detail: {
            planId: plan.id,
            taskId: task.id,
            printerId: assignment.printerId,
            sliceVariantId: binding.sliceVariantId,
            artifactId: binding.artifactId,
            artifactSha256: binding.artifactSha256,
            machineRevisionId: binding.machineRevisionId,
            processRevisionId: binding.processRevisionId,
            filamentRevisionId: binding.filamentRevisionId,
            expectedRemotePath: binding.expectedRemotePath,
            gcodeFlavor: binding.gcodeFlavor,
            nozzleMm: binding.nozzleMm,
            material: binding.material,
            etaS: binding.etaS
          }
        });
      }

      const saved = this.store.repositories.plans.update({
        ...plan,
        state: "ACTIVE",
        confirmedAt: iso,
        confirmedBy: actor ?? this.ctx.actor,
        updatedAt: iso
      });
      this.ctx.recordAudit({
        entityType: "plan",
        entityId: plan.id,
        action: "confirmed",
        from: "DRAFT",
        to: "ACTIVE",
        actor
      });
      // Confirming a plan reserves nothing physical and starts no printer — the
      // assignments stay PROPOSED until an explicit startAssignment.
      return this.buildPlanDetail(saved);
    });
  }

  /**
   * Per-assignment reasons the plan cannot be confirmed. Everything checked here
   * is *identity and availability*, not the here-and-now of a start (bed, live
   * telemetry, device file) — those legitimately change between confirmation and
   * dispatch and are re-checked by `DispatchEligibility` at start time.
   */
  private executabilityProblems(planId: string): { taskId: string; title: string; reason: string }[] {
    const repos = this.store.repositories;
    const printers = new Map(this.ctx.listPrinters().map((p) => [p.id, p]));
    const problems: { taskId: string; title: string; reason: string }[] = [];

    for (const assignment of this.assignmentsOf(planId)) {
      if (assignment.state === "CANCELLED" || assignment.state === "RELEASED") continue;
      const task = repos.tasks.getById(assignment.taskId);
      if (!task) {
        problems.push({ taskId: assignment.taskId, title: assignment.taskId, reason: "задание исчезло" });
        continue;
      }
      const reason = this.executabilityProblem(task, assignment.printerId, printers.has(assignment.printerId));
      if (reason) problems.push({ taskId: task.id, title: task.title, reason });
    }
    return problems;
  }

  /** The single unexecutable reason for one placement, or null when it is sound. */
  private executabilityProblem(
    task: PrintTask,
    printerId: string,
    printerKnown: boolean
  ): string | null {
    const repos = this.store.repositories;
    if (!printerKnown) return `принтер «${printerId}» отключён или отсутствует в конфигурации`;

    // An executable variant must exist: either a ready slice, or an artifact that
    // is already a printable file. A task with neither is a plan that cannot run.
    const artifact = task.artifactId ? repos.artifacts.getById(task.artifactId) : null;
    if (!artifact) return "у задания нет исполнимого артефакта";

    if (task.sliceVariantId) {
      const variant = repos.sliceVariants.getById(task.sliceVariantId);
      if (!variant) return `слайс «${task.sliceVariantId}» больше не существует`;
      if (variant.state !== "ready") return `слайс в состоянии «${variant.state}», не ready`;
      if (variant.outputArtifactId !== artifact.id) {
        return "исполнимый артефакт задания не совпадает с выходом подтверждённого слайса";
      }
      if (
        variant.targetPrinterId !== null &&
        variant.targetPrinterId !== printerId
      ) {
        return `слайс собран для «${variant.targetPrinterId}», а план ставит его на «${printerId}»`;
      }
    }

    const { binding } = resolveTaskBinding(repos, task);
    if (binding.artifactSha256 === null && artifact.sha256 !== null) {
      return "не удалось зафиксировать контрольную сумму файла";
    }
    const revisions = profileRevisionsIntact(repos, binding);
    if (!revisions.ok) return revisions.reason;

    if (!task.onDeviceFile) return "не задан путь файла на устройстве";
    return null;
  }

  /** Placed tasks in a plan that are no longer schedulable (title + id), for a confirm-time check. */
  private staleAssignments(planId: string): { taskId: string; title: string }[] {
    const schedulable = new Set(this.evidence.schedulableTasks().map((t) => t.id));
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
        repos.assignments.update({ ...a, state: "CANCELLED", updatedAt: this.ctx.nowIso() });
      }
    }
    assertTransition("план", PLAN_TRANSITIONS, plan.state, "CANCELLED");
    repos.plans.update({ ...plan, state: "CANCELLED", updatedAt: this.ctx.nowIso() });
    this.ctx.recordAudit({
      entityType: "plan",
      entityId: plan.id,
      action: "superseded",
      from: plan.state,
      to: "CANCELLED",
      detail: { reason }
    });
  }

  // ── Internals: plan persistence ──────────────────────────────────────────────

  private createDraft(input: {
    name: string | null;
    window: string | null;
    base: Plan | null;
    trigger: string;
  }): PlanDetail {
    const printers = this.ctx.listPrinters();
    const now = this.ctx.config.now().getTime();
    const frozenUntil = now + this.frozenHorizonS() * 1000;

    // ── The frozen head of the rolling horizon ────────────────────────────────
    // Confirmed placements that are already running, or due to start inside the
    // frozen horizon, are NOT re-planned: they hold their printer and their task
    // is taken out of the pool. Confirmed work further out is released back into
    // the pool, which is exactly what makes the horizon *rolling*.
    const { frozen, released } = this.partitionConfirmed(now, frozenUntil);
    const frozenTaskIds = new Set(frozen.map((a) => a.taskId));

    const tasks = this.evidence.schedulableTasks().filter((t) => !frozenTaskIds.has(t.id));

    const previousByTask = new Map<string, string>(
      input.base ? this.previousPlacements(input.base.id) : []
    );
    // A released confirmed placement still counts as "where it was", so the
    // stability bonus keeps it put unless something better genuinely changed.
    for (const a of released) previousByTask.set(a.taskId, a.printerId);

    // Compute compatibility once; feed only `compatible` printers to the planner.
    const compat = new Map<string, CompatibilityResult[]>();
    for (const task of tasks) {
      compat.set(task.id, printers.map((p) => this.evidence.evaluate(task, p)));
    }

    // `tasks` is in queue order (schedulableTasks reads listOpen), so the index is
    // the operator's manual rank — feeding it to the planner makes a reorder move.
    const plannerTasks: PlannerTaskInput[] = tasks.map((task, index) => {
      const results = compat.get(task.id) ?? [];
      const compatible = results.filter(plannable);
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
        requiredNozzleMm: this.evidence.taskRequiredNozzleMm(task),
        etaSeconds: eta?.seconds ?? null,
        compatiblePrinterIds: compatible.map((r) => r.printerId),
        previousPrinterId: previousByTask.get(task.id) ?? null,
        queueRank: index
      };
    });

    // The real release of every printer: machine + interventions + operator, with
    // one pair of hands shared across the farm.
    const releases = this.release.project(now);
    const frozenEnds = new Map<string, number>();
    for (const a of frozen) {
      const end = readExplanation(a.metadata)?.endMs ?? null;
      if (end !== null) frozenEnds.set(a.printerId, Math.max(frozenEnds.get(a.printerId) ?? 0, end));
      else frozenEnds.set(a.printerId, Number.NaN); // an end nobody knows poisons the printer
    }

    const plannerPrinters: PlannerPrinterInput[] = printers.map((p) => {
      const release = releases.get(p.id) ?? unknownRelease(p.id);
      const frozenEnd = frozenEnds.get(p.id);
      const freeAtMs =
        release.releaseAtMs === null || (frozenEnd !== undefined && Number.isNaN(frozenEnd))
          ? null
          : Math.max(release.releaseAtMs, frozenEnd ?? 0);
      return {
        printerId: p.id,
        name: p.name,
        freeAtMs,
        releaseCode:
          frozenEnd !== undefined && !Number.isNaN(frozenEnd) && (frozenEnd > (release.releaseAtMs ?? 0))
            ? "FROZEN_ASSIGNMENT"
            : release.code,
        releaseReason:
          freeAtMs === null && release.releaseAtMs !== null
            ? "подтверждённое назначение без известного времени окончания"
            : release.reason,
        currentMaterial: p.material,
        currentNozzleMm: p.nozzleMm,
        remoteStartSupported: p.remoteStartSupported
      };
    });
    const printerById = new Map(plannerPrinters.map((p) => [p.printerId, p]));

    const planResult = buildPlan(plannerTasks, plannerPrinters, {
      nowMs: now,
      unknownEtaAssumptionS: this.ctx.config.unknownEtaAssumptionS
    });

    const iso = this.ctx.nowIso();
    const revision = input.base ? input.base.revision + 1 : 1;
    const unplaced: UnplacedView[] = planResult.unplaced.map((u) => ({
      taskId: u.taskId,
      title: tasks.find((t) => t.id === u.taskId)?.title ?? u.taskId,
      code: u.code,
      reason: u.reason,
      hint: u.hint
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
      metadata: {
        unplaced: unplaced as unknown as Metadata[keyof Metadata],
        generatedAt: iso,
        trigger: input.trigger,
        frozenUntil: frozen.length > 0 ? new Date(frozenUntil).toISOString() : null,
        frozenAssignmentIds: frozen.map((a) => a.id),
        // The recommendation is a *view of a moment*; storing it makes the plan
        // readable verbatim after a restart instead of silently re-deriving a
        // different one against a moved clock.
        timeline: buildTimeline({
          printers,
          releases,
          assignments: planResult.assignments,
          frozen,
          unplaced,
          nowMs: now,
          titleOf: (taskId) => this.store.repositories.tasks.getById(taskId)?.title ?? taskId
        }) as unknown as Metadata[keyof Metadata]
      } as Metadata
    };
    this.store.repositories.plans.insert(plan);
    this.ctx.recordAudit({
      entityType: "plan",
      entityId: plan.id,
      action: "drafted",
      to: "DRAFT",
      detail: {
        revision,
        trigger: input.trigger,
        assignments: planResult.assignments.length,
        unplaced: unplaced.length,
        frozen: frozen.length,
        released: released.length
      }
    });

    for (const a of planResult.assignments) {
      const result = (compat.get(a.taskId) ?? []).find((r) => r.printerId === a.printerId);
      const printerRef = printers.find((p) => p.id === a.printerId) ?? null;
      const placedTaskForOps = tasks.find((t) => t.id === a.taskId) ?? null;
      const bed = this.projectBedRelease(a.endMs);
      const explanation: PlanExplanation = {
        printerId: a.printerId,
        reason: a.reason,
        score: a.score,
        scoreBreakdown: a.scoreBreakdown,
        alternatives: a.alternatives,
        warnings: a.warnings,
        blockers: [],
        startMs: a.startMs,
        endMs: a.endMs,
        etaSeconds: a.etaSeconds,
        etaSource: result?.eta.source ?? "unknown",
        etaPreliminary: result?.eta.preliminary ?? true,
        etaConfidence: etaConfidenceOf(a.etaSeconds, result?.eta.preliminary ?? true),
        releaseCode: printerById.get(a.printerId)?.releaseCode ?? "FREE",
        releaseReason: printerById.get(a.printerId)?.releaseReason ?? "",
        bedReleaseMs: bed.releaseMs,
        bedReleaseEstimated: bed.estimated,
        manualOperations: placedTaskForOps
          ? this.plannedOperations(placedTaskForOps, printerRef)
          : [],
        requiresUpload: placedTaskForOps ? this.requiresUpload(placedTaskForOps, a.printerId) : true,
        manualStartRequired: printerRef ? printerRef.remoteStartSupported !== true : true,
        frozen: false
      };
      // The placement is executable data from the moment it is drafted: the exact
      // slice, artifact hash and profile revisions the compatibility answer was
      // computed against travel with it, so confirmation re-checks them rather
      // than re-deriving a possibly-different answer later.
      const placedTask = tasks.find((t) => t.id === a.taskId) ?? null;
      const resolved = placedTask
        ? resolveTaskBinding(this.store.repositories, placedTask)
        : null;
      const assignment: Assignment = {
        id: newId(ID_PREFIX.assignment),
        taskId: a.taskId,
        printerId: a.printerId,
        planId: plan.id,
        bedCycleId: null,
        state: "PROPOSED",
        source: "plan",
        reason: a.reason,
        createdBy: null,
        binding: {
          ...(resolved?.binding ?? EMPTY_ASSIGNMENT_BINDING),
          etaS: a.etaSeconds ?? resolved?.binding.etaS ?? null,
          plannedStartAt: new Date(a.startMs).toISOString(),
          planRevision: revision
        },
        invalidatedAt: null,
        invalidatedReason: null,
        createdAt: iso,
        updatedAt: iso,
        version: 1,
        legacyRef: null,
        metadata: { explanation }
      };
      this.store.repositories.assignments.insert(assignment);
      this.ctx.recordAudit({
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

  /**
   * Marks every plan the new draft overtakes as **stale**, so no stored
   * recommendation can be read as current after a recalculation:
   *
   *  - outstanding DRAFTs are stamped and cancelled (a pile of orphan drafts
   *    competing to be "the plan" is worse than none);
   *  - the confirmed (ACTIVE) plan is stamped but **left ACTIVE** — it is still
   *    the plan of record and the only thing anything may be started from. Only
   *    an explicit confirmation of the new draft replaces it.
   */
  private supersedeOtherDrafts(keepId: string): void {
    for (const other of this.store.repositories.plans.list()) {
      if (other.id === keepId) continue;
      if (other.state === "DRAFT") {
        this.cancelDraft(this.markStale(other, "superseded", keepId), "superseded");
      } else if (other.state === "ACTIVE") {
        this.markStale(other, `пересчитан: есть новая рекомендация ${keepId}`, keepId);
      }
    }
  }

  private frozenHorizonS(): number {
    const configured = this.ctx.config.frozenHorizonS;
    return typeof configured === "number" && Number.isFinite(configured) && configured >= 0
      ? configured
      : DEFAULT_FROZEN_HORIZON_S;
  }

  /**
   * Splits the confirmed plan's open placements into the **frozen head** and the
   * **rebuildable tail** of the rolling horizon.
   *
   * Frozen: anything already started (`RESERVED`/`ACTIVE`) and anything whose
   * confirmed start falls inside the horizon — the operator has committed to it,
   * files may already be staged for it, and moving it under their feet is exactly
   * what "подтверждённый ближайший assignment остаётся замороженным" forbids. A
   * confirmed placement with no readable start is frozen too: an unknown is never
   * resolved in favour of moving something.
   *
   * Released: still-`PROPOSED` placements starting beyond the horizon. They go
   * back into the pool, which is what makes the horizon roll.
   */
  private partitionConfirmed(
    nowMs: number,
    frozenUntilMs: number
  ): { frozen: Assignment[]; released: Assignment[] } {
    const frozen: Assignment[] = [];
    const released: Assignment[] = [];
    for (const plan of this.store.repositories.plans.list()) {
      if (plan.state !== "ACTIVE") continue;
      for (const a of this.assignmentsOf(plan.id)) {
        if (a.state !== "PROPOSED" && a.state !== "RESERVED" && a.state !== "ACTIVE") continue;
        if (a.state !== "PROPOSED") {
          frozen.push(a); // already reserved/running — never re-planned
          continue;
        }
        const startMs = a.binding.plannedStartAt ? Date.parse(a.binding.plannedStartAt) : NaN;
        if (!Number.isFinite(startMs) || startMs <= frozenUntilMs) frozen.push(a);
        else released.push(a);
      }
    }
    // Deterministic order regardless of how the store returned them.
    const byId = (x: Assignment, y: Assignment): number => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
    frozen.sort(byId);
    released.sort(byId);
    void nowMs;
    return { frozen, released };
  }

  /**
   * When the *bed* is expected to be free after a print ends: the clearance an
   * operator still has to perform, resolved against their calendar.
   *
   * This is deliberately an **estimate** and is flagged as one — the clearance
   * operation does not exist yet (it is opened when the print actually finishes),
   * so its duration is the type default rather than a stored value. It never
   * feeds placement; it exists so the plan can answer "when is the plate free
   * again?" without pretending the answer is a fact.
   */
  private projectBedRelease(endMs: number): { releaseMs: number | null; estimated: boolean } {
    const slot = this.release.nextOperatorSlot(endMs);
    if (slot === null) return { releaseMs: null, estimated: true };
    return {
      releaseMs: slot + DEFAULT_OPERATION_MINUTES.PART_REMOVAL * 60_000,
      estimated: true
    };
  }

  /** The interventions a placement implies, before the print and after it. */
  private plannedOperations(
    task: PrintTask,
    printer: SchedulerPrinterRef | null
  ): PlannedManualOperation[] {
    const out: PlannedManualOperation[] = [];
    const add = (type: keyof typeof DEFAULT_OPERATION_MINUTES, when: "before" | "after"): void => {
      out.push({
        type,
        label: OPERATION_LABELS[type],
        minutes: DEFAULT_OPERATION_MINUTES[type] ?? null,
        when
      });
    };
    if (printer && task.material && printer.material && !sameMaterialFamily(task.material, printer.material)) {
      add("MATERIAL_CHANGE", "before");
    }
    const requiredNozzle = this.evidence.taskRequiredNozzleMm(task);
    if (
      printer &&
      requiredNozzle !== null &&
      printer.nozzleMm !== null &&
      Math.abs(requiredNozzle - printer.nozzleMm) > 0.001
    ) {
      add("NOZZLE_CHANGE", "before");
    }
    if (printer && printer.remoteStartSupported !== true) add("FILE_TRANSFER_CONFIRM", "before");
    // Every print ends with a part on a plate. This is the operation the whole
    // release projection is about, so the plan names it up front.
    add("PART_REMOVAL", "after");
    return out;
  }

  /**
   * Whether the executable file still has to reach the printer. True unless a
   * tracked device artifact for this exact remote path is present *and* its
   * content hash matches the binding — a file with a different hash in the slot
   * is not "already uploaded", it is the wrong file.
   */
  private requiresUpload(task: PrintTask, printerId: string): boolean {
    const { binding } = resolveTaskBinding(this.store.repositories, task);
    const path = binding.expectedRemotePath ?? task.onDeviceFile;
    if (!path) return true;
    const record = this.store.repositories.deviceArtifacts.findBySlot(printerId, path);
    if (!record) return true;
    if (record.state !== "VERIFIED" && record.state !== "PRESENT_UNVERIFIED") return true;
    if (binding.artifactSha256 !== null && record.artifactSha256 !== null) {
      return record.artifactSha256 !== binding.artifactSha256;
    }
    return false;
  }


  /** Cancels a draft plan and its still-proposed assignments (used when superseded). */
  private cancelDraft(plan: Plan, reason: string): void {
    const repos = this.store.repositories;
    for (const a of this.assignmentsOf(plan.id)) {
      if (a.state === "PROPOSED" || a.state === "RESERVED") {
        assertTransition("назначение", ASSIGNMENT_TRANSITIONS, a.state, "CANCELLED");
        repos.assignments.update({ ...a, state: "CANCELLED", updatedAt: this.ctx.nowIso() });
      }
    }
    assertTransition("план", PLAN_TRANSITIONS, plan.state, "CANCELLED");
    repos.plans.update({ ...plan, state: "CANCELLED", updatedAt: this.ctx.nowIso() });
    this.ctx.recordAudit({
      entityType: "plan",
      entityId: plan.id,
      action: "cancelled",
      from: plan.state,
      to: "CANCELLED",
      detail: { reason }
    });
  }

  /**
   * Reads a stored plan back in full — the same shape whether it was just built
   * or is being re-read after a restart. Everything a recommendation asserts
   * (placements, timeline, unplaced codes, frozen head) is persisted, so nothing
   * here is silently re-derived against a moved clock.
   */
  private buildPlanDetail(plan: Plan): PlanDetail {
    const repos = this.store.repositories;
    const frozenIds = new Set(readStringArray(plan.metadata.frozenAssignmentIds));
    const assignments = this.assignmentsOf(plan.id).map((assignment) => ({
      assignment,
      task: repos.tasks.getById(assignment.taskId),
      explanation: readExplanation(assignment.metadata)
    }));

    // The frozen head lives on the CONFIRMED plan, not on this draft: it is
    // referenced, never copied, so one placement can never exist twice.
    const frozen: PlanAssignmentView[] = [];
    for (const id of frozenIds) {
      const assignment = repos.assignments.getById(id);
      if (!assignment) continue;
      const explanation = readExplanation(assignment.metadata);
      frozen.push({
        assignment,
        task: repos.tasks.getById(assignment.taskId),
        explanation: explanation ? { ...explanation, frozen: true } : null
      });
    }

    return {
      plan,
      assignments,
      unplaced: readUnplaced(plan.metadata),
      frozen,
      timeline: readTimeline(plan.metadata),
      staleness: this.stalenessOf(plan),
      generatedAt: readString(plan.metadata.generatedAt) ?? plan.createdAt,
      frozenUntil: readString(plan.metadata.frozenUntil)
    };
  }

  /**
   * Whether this plan's recommendation has been overtaken.
   *
   * Two sources, both explicit: a `stale` marker written when the plan was
   * superseded, and the live existence of a newer revision. The second matters
   * for a *confirmed* plan — it stays ACTIVE and executable (a draft does not
   * cancel it), but the operator must be able to see that a newer recommendation
   * disagrees with it.
   */
  private stalenessOf(plan: Plan): PlanStaleness {
    const marker = plan.metadata.stale;
    if (marker && typeof marker === "object" && !Array.isArray(marker)) {
      const m = marker as Record<string, unknown>;
      return {
        stale: true,
        reason: typeof m.reason === "string" ? m.reason : "план устарел",
        supersededByPlanId: typeof m.by === "string" ? m.by : null
      };
    }
    if (plan.state === "CANCELLED" || plan.state === "COMPLETED") {
      return { stale: true, reason: `план в состоянии «${plan.state}»`, supersededByPlanId: null };
    }
    const newer = this.store.repositories.plans
      .list()
      .find((p) => p.id !== plan.id && p.state === "DRAFT" && p.revision > plan.revision);
    if (newer) {
      return {
        stale: true,
        reason: `есть более новая рекомендация (ревизия ${newer.revision})`,
        supersededByPlanId: newer.id
      };
    }
    return { stale: false, reason: null, supersededByPlanId: null };
  }

  /** Stamps a plan as superseded by `byPlanId` (a marker, not a state change). */
  private markStale(plan: Plan, reason: string, byPlanId: string): Plan {
    return this.store.repositories.plans.update({
      ...plan,
      metadata: { ...plan.metadata, stale: { reason, by: byPlanId, at: this.ctx.nowIso() } },
      updatedAt: this.ctx.nowIso()
    });
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

  private requirePlan(id: string): Plan {
    const plan = this.store.repositories.plans.getById(id);
    if (!plan) throw new NotFoundError(`План «${id}»`);
    return plan;
  }
}
