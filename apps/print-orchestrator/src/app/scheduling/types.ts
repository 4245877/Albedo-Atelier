import type { PrintRunState } from "../../domain/print/types";
import type { Assignment, Plan, PrintTask } from "../../domain/print/types";
import type {
  CompatibilityConfig,
  CompatibilityPrinterInput,
  CompatibilityResult,
  Dimensions
} from "../../domain/scheduling/compatibility";
import type { EtaSource } from "../../domain/scheduling/eta";
import type { ScoreComponent } from "../../domain/scheduling/planner";

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
