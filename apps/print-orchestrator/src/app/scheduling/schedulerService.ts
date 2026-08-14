import type { PrintQueueStore } from "../../domain/print/repositories";
import type { MaterialOverride, Plan, PrintTask } from "../../domain/print/types";
import type { CompatibilityResult } from "../../domain/scheduling/compatibility";
import type { DispatchEligibility } from "../../domain/dispatch/eligibility";
import { SchedulerContext } from "./context";
import { EligibilityQueries, type EligibilityRequest } from "./eligibility";
import { EvidenceResolver } from "./evidence";
import { NightQueries } from "./night";
import { PlanningService } from "./planning";
import type {
  CompatibilityMatrix,
  NightCandidatesReport,
  PlanDetail,
  SchedulerConfig,
  SchedulerPrinterRef
} from "./types";

export type { EligibilityRequest } from "./eligibility";
export type {
  CompatibilityMatrix,
  CompatibilityRow,
  EtaConfidence,
  NightCandidatesReport,
  PlanAssignmentView,
  PlanDetail,
  PlanExplanation,
  PlannedManualOperation,
  PlanStaleness,
  PrinterTimeline,
  SchedulerConfig,
  SchedulerPrinterRef,
  TimelineSegment,
  UnplacedView
} from "./types";

/**
 * The manual-scheduler application service — the one place HTTP routes call to
 * turn scheduling intents into audited, transactional changes over the SQLite
 * model. A facade over three use-case modules sharing one {@link SchedulerContext}:
 *
 *   - {@link EvidenceResolver} — resolves the live evidence (ready slice
 *     variants, approved profile sets, printer telemetry, bed cycles) and the
 *     compatibility matrix;
 *   - {@link PlanningService} — revisioned draft plans, manual confirmation,
 *     recompute, free-time projection;
 *   - {@link NightQueries} — the night (unattended) gate and the operator
 *     material overrides.
 *
 * Every *decision* is delegated to the pure domain (`domain/scheduling`):
 * compatibility, the placement heuristic, and the night gate. It never touches
 * the legacy `/api/queue` or `state.json`.
 */
export class SchedulerService {
  private readonly evidence: EvidenceResolver;
  private readonly planning: PlanningService;
  private readonly night: NightQueries;
  private readonly eligibilityQueries: EligibilityQueries;

  private readonly printers: () => SchedulerPrinterRef[];

  constructor(
    store: PrintQueueStore,
    listPrinters: () => SchedulerPrinterRef[],
    config: SchedulerConfig
  ) {
    this.printers = listPrinters;
    const ctx = new SchedulerContext(store, listPrinters, config);
    this.evidence = new EvidenceResolver(ctx);
    this.planning = new PlanningService(ctx, this.evidence);
    this.night = new NightQueries(ctx, this.evidence);
    this.eligibilityQueries = new EligibilityQueries(ctx, this.evidence);
  }

  // ── Compatibility matrix (EvidenceResolver) ──────────────────────────────────

  compatibilityMatrix(): CompatibilityMatrix {
    return this.evidence.compatibilityMatrix();
  }

  /**
   * Compatibility of ONE task against every configured printer, paired with the
   * printer reference it was judged against.
   *
   * The launch flow needs both halves — the verdict *and* the live printer facts
   * (loaded material, nozzle, status) it must show the operator — and it must
   * judge a task the matrix may not list at all: `compatibilityMatrix()` covers
   * only currently-schedulable queue rows, while a launch can legitimately be
   * previewed for a task that is already assigned.
   */
  compatibilityForTask(task: PrintTask): {
    printer: SchedulerPrinterRef;
    result: CompatibilityResult;
  }[] {
    return this.listPrinterRefs().map((printer) => ({
      printer,
      result: this.evidence.evaluate(task, printer)
    }));
  }

  /** The live printer references the scheduler reasons over (telemetry joined in). */
  listPrinterRefs(): SchedulerPrinterRef[] {
    return this.printers();
  }

  // ── Dispatch eligibility (EligibilityQueries) ───────────────────────────────

  /**
   * The authoritative "may this start now?" check — the SAME call the physical
   * dispatch makes inside its reserve transaction. Exposed here so the preview
   * and the plan-confirmation path cannot answer differently from enforcement.
   */
  dispatchEligibility(request: EligibilityRequest): DispatchEligibility {
    return this.eligibilityQueries.evaluate(request);
  }

  // ── Plans (PlanningService) ──────────────────────────────────────────────────

  listPlans(): Plan[] {
    return this.planning.listPlans();
  }

  getPlan(id: string): PlanDetail {
    return this.planning.getPlan(id);
  }

  buildDraftPlan(options: { name?: string; window?: string; trigger?: string } = {}): PlanDetail {
    return this.planning.buildDraftPlan(options);
  }

  recomputePlan(planId: string, trigger?: string): PlanDetail {
    return this.planning.recomputePlan(planId, trigger);
  }

  /**
   * Recalculate the recommendations after a change (a task added, a print
   * finished, an intervention performed, the operator's schedule edited, …).
   *
   * Explicit by design: it is invoked by an operator or an API call, never by a
   * worker or a timer, and it produces a DRAFT — it uploads nothing, reserves
   * nothing and starts nothing.
   */
  recomputeRecommendations(trigger: string): PlanDetail {
    return this.planning.recomputeLive(trigger);
  }

  confirmPlan(planId: string, actor?: string, expectedVersion?: number): PlanDetail {
    return this.planning.confirmPlan(planId, actor, expectedVersion);
  }

  // ── Night candidates + material overrides (NightQueries) ─────────────────────

  nightCandidates(): NightCandidatesReport {
    return this.night.nightCandidates();
  }

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
    return this.night.setMaterialOverride(printerId, input);
  }

  listActiveMaterialOverrides(): MaterialOverride[] {
    return this.night.listActiveMaterialOverrides();
  }
}
