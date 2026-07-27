import type { PrintRunState } from "../../domain/print/types";
import type { Assignment, Plan, PrintTask } from "../../domain/print/types";
import type {
  CompatibilityConfig,
  CompatibilityPrinterInput,
  CompatibilityResult,
  Dimensions
} from "../../domain/scheduling/compatibility";
import type { OperatorAvailability } from "../../domain/operations/schedule";
import type { ManualOperation } from "../../domain/operations/types";
import type { EtaSource } from "../../domain/scheduling/eta";
import type { ApproximateHint, ScoreComponent, UnplacedCode } from "../../domain/scheduling/planner";
import type { ReleaseSegment } from "../../domain/scheduling/release";

/** The live view of one printer the scheduler needs; assembled by the caller from telemetry + config. */
export interface SchedulerPrinterRef {
  id: string;
  name: string;
  model: string | null;
  protocol: string | null;
  /** Interchangeability class (config `printerClass`); null/empty when none. */
  printerClass?: string | null;
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
  /**
   * The state of the canonical `PrintRun` currently holding this printer, if
   * any — one of `ACTIVE_RUN_STATES` (PENDING/RUNNING/PAUSED/UNKNOWN); null/
   * absent when no run holds it. This is *distinct from* live telemetry `status`: a
   * run can hold a printer (a PENDING dispatch reservation, or a fail-closed UNKNOWN
   * outcome) while telemetry still reads idle. The scheduler treats a held printer as
   * busy — never free-now, never a clear bed — so a plan cannot promise a start the
   * dispatch gate would then refuse. Populated from the same authoritative active-run
   * query (`findActiveByPrinter`) the dispatch path uses, so the availability rule is
   * identical across domain, app and infra.
   */
  activeRunState?: PrintRunState | null;
}

export interface SchedulerConfig {
  now: () => Date;
  /** OrcaSlicer runtime availability (probed by the caller); gates un-sliced work. */
  runtimeAvailable: boolean;
  /**
   * Night ETA safety buffer as a **fraction**: 0.2 → +20% → `eta × 1.2`. Never a
   * bare multiplier and never minutes.
   */
  nightSafetyBufferRatio: number;
  /** Night window label ("HH:MM – HH:MM") in the farm's local wall clock. */
  nightWindow: string;
  /**
   * IANA timezone the night window's wall clock refers to. Stored timestamps stay
   * UTC; only window arithmetic is localized, and only through this zone.
   */
  farmTimeZone: string;
  compatibility?: CompatibilityConfig;
  /**
   * Seconds used **only** to draw an explicitly-approximate ghost block for a
   * task whose ETA is unknown. It never becomes a planned start or end — such a
   * task stays unplaced with the `ETA_UNKNOWN` code.
   */
  unknownEtaAssumptionS: number;
  /**
   * The open manual interventions holding a printer. Absent means the farm has no
   * operator model wired in, and a printer with an occupied bed then resolves to
   * an *unknown* release — never to "free now".
   */
  manualOperations?: (printerId: string) => readonly ManualOperation[];
  /**
   * Farm operator availability at an arbitrary instant (not just `now`) — the
   * projection needs it to answer "when could a human next do this?" repeatedly
   * as it walks the operator's day. Absent → fail-closed: no release time is
   * computable for anything that needs hands.
   */
  operatorAvailabilityAt?: (at: Date) => OperatorAvailability;
  /**
   * The **frozen horizon** in seconds: confirmed assignments whose planned start
   * falls inside it are not re-planned by a recompute. Beyond it, a confirmed but
   * not-yet-started placement is fair game for the rolling horizon. Default 2 h.
   */
  frozenHorizonS?: number;
  actor?: string;
}

/**
 * How much the ETA behind a placement can be trusted. `exact` = a slicer/G-code
 * number for this exact printer; `preliminary` = a real number the compatibility
 * layer flagged as provisional; `unknown` never appears on a placement at all
 * (such a task is left unplaced) and exists only for read-back of older rows.
 */
export type EtaConfidence = "exact" | "preliminary" | "unknown";

/** One manual intervention the operator has to perform around a placement. */
export interface PlannedManualOperation {
  type: string;
  label: string;
  /** Expected hands-on minutes; null when nobody has estimated the type. */
  minutes: number | null;
  /** `before` = required to start this print; `after` = required to free the bed. */
  when: "before" | "after";
}

/** The stored explanation for one planned assignment (in `assignment.metadata.explanation`). */
export interface PlanExplanation {
  printerId: string;
  reason: string;
  score: number;
  scoreBreakdown: ScoreComponent[];
  alternatives: { printerId: string; score: number }[];
  warnings: string[];
  /** Hard reasons this placement could not be *started* right now (not "why here"). */
  blockers: string[];
  startMs: number;
  endMs: number | null;
  etaSeconds: number | null;
  etaSource: EtaSource;
  etaPreliminary: boolean;
  etaConfidence: EtaConfidence;
  /** The printer's release code/reason at planning time (`FREE`, `AWAITING_OPERATOR`, …). */
  releaseCode: string;
  releaseReason: string;
  /**
   * When the *bed* is expected to be free again after this print — the print end
   * plus the clearance an operator has to perform, resolved against their
   * schedule. Null when that cannot be computed; `bedReleaseEstimated` marks it
   * as a projection over an operation that has not been opened yet.
   */
  bedReleaseMs: number | null;
  bedReleaseEstimated: boolean;
  manualOperations: PlannedManualOperation[];
  /** True when the executable file is not yet known to be on the device. */
  requiresUpload: boolean;
  /** True when the adapter cannot start remotely — a human presses start. */
  manualStartRequired: boolean;
  /** True when this placement is frozen (confirmed/near-term) and not re-planned. */
  frozen: boolean;
}

export interface PlanAssignmentView {
  assignment: Assignment;
  task: PrintTask | null;
  explanation: PlanExplanation | null;
}

/** A task the planner refused to place, with its stable code. */
export interface UnplacedView {
  taskId: string;
  title: string;
  code: UnplacedCode | string;
  reason: string;
  /** Explicitly-approximate visual hint; never an executable time. */
  hint: ApproximateHint | null;
}

/** One stretch of a printer lane on the recommendation timeline. */
export interface TimelineSegment {
  kind:
    | ReleaseSegment["kind"]
    /** A recommended (unconfirmed) print. */
    | "planned_print"
    /** A confirmed placement inside the frozen horizon. */
    | "frozen_print"
    /** A non-executable ghost for an unplaced task. */
    | "approx_print";
  startMs: number;
  endMs: number | null;
  label: string;
  taskId?: string;
  operationId?: string;
  operationType?: string;
  /** True for anything that is an estimate rather than a computed placement. */
  approximate?: boolean;
}

export interface PrinterTimeline {
  printerId: string;
  name: string;
  releaseCode: string;
  releaseReason: string;
  releaseAtMs: number | null;
  waitingForOperator: boolean;
  segments: TimelineSegment[];
}

/** Whether this plan's recommendation has been overtaken by a newer one. */
export interface PlanStaleness {
  stale: boolean;
  reason: string | null;
  supersededByPlanId: string | null;
}

export interface PlanDetail {
  plan: Plan;
  assignments: PlanAssignmentView[];
  unplaced: UnplacedView[];
  /**
   * Placements carried over untouched from the confirmed plan: running work and
   * confirmed assignments inside the frozen horizon. They are shown so the
   * operator sees the whole day, but a recompute never moves them.
   */
  frozen: PlanAssignmentView[];
  timeline: PrinterTimeline[];
  staleness: PlanStaleness;
  /** The instant this recommendation was computed against (plan build time). */
  generatedAt: string;
  /** End of the frozen horizon at build time; null when nothing is frozen. */
  frozenUntil: string | null;
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
