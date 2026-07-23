import type { PrintQueueStore } from "../../domain/print/repositories";
import type { MaterialOverride, Plan } from "../../domain/print/types";
import { SchedulerContext } from "./context";
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

export type {
  CompatibilityMatrix,
  CompatibilityRow,
  NightCandidatesReport,
  PlanAssignmentView,
  PlanDetail,
  PlanExplanation,
  SchedulerConfig,
  SchedulerPrinterRef
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

  constructor(
    store: PrintQueueStore,
    listPrinters: () => SchedulerPrinterRef[],
    config: SchedulerConfig
  ) {
    const ctx = new SchedulerContext(store, listPrinters, config);
    this.evidence = new EvidenceResolver(ctx);
    this.planning = new PlanningService(ctx, this.evidence);
    this.night = new NightQueries(ctx, this.evidence);
  }

  // ── Compatibility matrix (EvidenceResolver) ──────────────────────────────────

  compatibilityMatrix(): CompatibilityMatrix {
    return this.evidence.compatibilityMatrix();
  }

  // ── Plans (PlanningService) ──────────────────────────────────────────────────

  listPlans(): Plan[] {
    return this.planning.listPlans();
  }

  getPlan(id: string): PlanDetail {
    return this.planning.getPlan(id);
  }

  buildDraftPlan(options: { name?: string; window?: string } = {}): PlanDetail {
    return this.planning.buildDraftPlan(options);
  }

  recomputePlan(planId: string): PlanDetail {
    return this.planning.recomputePlan(planId);
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
