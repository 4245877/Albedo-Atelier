import type { PrintQueueStore } from "../../domain/print/repositories";
import type { MaterialOverride, Plan, PrintTask } from "../../domain/print/types";
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
   * `compatibilityForTask` used to live here: one task against every printer,
   * through `evaluateCompatibility` alone. It existed for the launch preview,
   * and the launch preview is exactly what it got wrong — compatibility answers
   * "could this printer ever make this model", which is not the question a start
   * asks. It never saw the file's declared target printer, the G-code flavor,
   * remote-start support or the queue shape, so the screen offered machines
   * whose refusal was already certain.
   *
   * {@link launchPreflight} replaces it with the real admission policy at its
   * `preflight` stage. Nothing else called the old method, so it is gone rather
   * than left as a second, wronger way to ask the same question.
   */

  /**
   * **The launch admission policy, for one task against every printer.**
   *
   * The same {@link evaluateDispatchEligibility} the physical dispatch runs, at
   * the `preflight` stage: everything that is knowable before a byte moves. This
   * is what the launch preview shows and what the launch re-runs immediately
   * before it delivers a file, so the two cannot disagree.
   *
   * It replaces a preview built on `evaluateCompatibility` alone — which never
   * saw the file's declared target printer, the G-code flavor, remote-start
   * support or the queue shape, and therefore offered printers whose refusal was
   * already certain.
   */
  launchPreflight(
    task: PrintTask,
    options: { automaticContinuationAllowed?: (printerId: string) => boolean } = {}
  ): { printer: SchedulerPrinterRef; eligibility: DispatchEligibility }[] {
    return this.listPrinterRefs().map((printer) => ({
      printer,
      eligibility: this.eligibilityQueries.evaluateFor(task, printer, {
        mode: "manual",
        stage: "preflight",
        automaticContinuationAllowed:
          options.automaticContinuationAllowed?.(printer.id) ?? false
      })
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
