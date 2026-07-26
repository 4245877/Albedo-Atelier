import { JobError, NotFoundError } from "../../core/errors";
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
import type { SchedulerContext } from "./context";
import { heldByActiveRun, type EvidenceResolver } from "./evidence";
import type { PlanDetail, PlanExplanation, SchedulerPrinterRef } from "./types";

/**
 * Plan lifecycle: revisioned drafts, manual confirmation, recompute-as-new-
 * revision, and the free-time projection feeding the placement heuristic.
 *
 * Plans are revisioned and manually confirmed: {@link buildDraftPlan} /
 * {@link recomputePlan} always produce a fresh `DRAFT`; {@link confirmPlan} is
 * the only path to `ACTIVE`; and a recompute never edits a confirmed plan — it
 * supersedes it with a new revision. Draft assignments are `PROPOSED` (they hold
 * no bed and start no print — remote start is out of scope), each carrying its
 * full {@link PlanExplanation}.
 */
export class PlanningService {
  constructor(
    private readonly ctx: SchedulerContext,
    private readonly evidence: EvidenceResolver
  ) {}

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

  private createDraft(input: { name: string | null; window: string | null; base: Plan | null }): PlanDetail {
    const printers = this.ctx.listPrinters();
    const tasks = this.evidence.schedulableTasks();
    const now = this.ctx.config.now().getTime();

    const previousByTask = input.base ? this.previousPlacements(input.base.id) : new Map<string, string>();

    // Compute compatibility once; feed only `compatible` printers to the planner.
    const compat = new Map<string, CompatibilityResult[]>();
    for (const task of tasks) {
      compat.set(task.id, printers.map((p) => this.evidence.evaluate(task, p)));
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
        requiredNozzleMm: this.evidence.taskRequiredNozzleMm(task),
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
      unknownEtaAssumptionS: this.ctx.config.unknownEtaAssumptionS
    });

    const iso = this.ctx.nowIso();
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
    this.ctx.recordAudit({
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
        freeAtMs = Math.max(freeAtMs, nowMs + this.ctx.config.unknownEtaAssumptionS * 1000);
        estimated = true;
      }
    } else if (heldByActiveRun(printer.activeRunState)) {
      // Live telemetry does not (yet) show a print, but a canonical run still holds
      // the printer — a PENDING dispatch reservation, or a fail-closed UNKNOWN outcome
      // that must never be released without device evidence. We have no remaining-time
      // estimate for it, so advance by the disclosed assumption and mark it estimated:
      // the printer is never treated as free-now while a run holds it.
      freeAtMs = Math.max(freeAtMs, nowMs + this.ctx.config.unknownEtaAssumptionS * 1000);
      estimated = true;
    } else if (this.bedBlocksPrinter(printer.id)) {
      // The device reports idle, but a finished part is still on the plate. This is
      // the 03:00–08:00 case from the brief: the printer is NOT available, it is in
      // forced downtime waiting for an operator. How long that lasts is genuinely
      // unknown (it depends on a human arriving), so the free-time is pushed out by
      // the disclosed assumption and flagged estimated — the planner may show the
      // gap, but it can no longer promise a start into it.
      freeAtMs = Math.max(freeAtMs, nowMs + this.ctx.config.unknownEtaAssumptionS * 1000);
      estimated = true;
    }

    for (const assignment of this.activeAssignmentsForPrinter(printer.id)) {
      const endMs = readExplanation(assignment.metadata)?.endMs ?? null;
      if (endMs !== null) freeAtMs = Math.max(freeAtMs, endMs);
      else estimated = true; // a committed assignment with unknown end is an estimate too
    }

    return { freeAtMs, estimated };
  }

  /**
   * True when the printer's bed still holds a part (or its state is unknown), so
   * nothing may be planned onto it until an operator confirms clearance. A printer
   * with no tracked cycle at all is not blocked — it simply has no history yet.
   */
  private bedBlocksPrinter(printerId: string): boolean {
    const bed = this.store.repositories.bedCycles.findOpenByPrinter(printerId);
    return bed !== null && bed.state !== "CLEAR";
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

  private requirePlan(id: string): Plan {
    const plan = this.store.repositories.plans.getById(id);
    if (!plan) throw new NotFoundError(`План «${id}»`);
    return plan;
  }
}

// ── Free helpers ────────────────────────────────────────────────────────────────

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
