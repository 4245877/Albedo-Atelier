import type { CameraState, PrinterState, PrinterView } from "../printers/types";

/**
 * Every type here matches the shape the dashboard frontend renders 1:1
 * (apps/print-dashboard/app.js). The aggregate {@link DashboardSnapshot} maps
 * key-for-key onto the frontend's `state` object so the page can render the
 * whole board from a single `GET /api/dashboard` with no extra processing.
 */

export interface ServiceStatus {
  status: "ok" | "degraded" | "down";
  version: string;
}

/**
 * `ready` — has a printer, can be started; `review` — needs operator attention
 * (no printer assigned). Older persisted files may still carry a legacy
 * `"error"` status; the state loader normalizes it to `review` on load.
 */
export type QueueJobStatus = "ready" | "review";

export interface QueueJob {
  id: string;
  title: string;
  printer: string;
  material: string;
  eta: string;
  status: QueueJobStatus;
  /** Scheduled start; absent for jobs still in review or errored. */
  at?: string;
  night?: boolean;
  reason?: string;
  /**
   * Name of the print file already present on the target printer. Optional
   * operator metadata; required for remote start (see FarmStore.startNext) —
   * without it the farm cannot tell the device which job to run.
   */
  file?: string;
}

export interface NightCandidate {
  title: string;
  printer: string;
  eta: string;
  risk: number;
  riskLabel: string;
  /**
   * The concrete, hard reasons this job cannot launch tonight (mirrors
   * NightPlanEntry.blockers). Empty → startable; the dashboard disables the
   * night-start button and lists these otherwise, so the UI never claims a
   * blocked job "fits the window".
   */
  blockers: string[];
}

export interface NightPrint {
  /** Human label of the configured window, e.g. `"21:30 – 07:30"`. */
  window: string;
  /**
   * Machine-readable bounds of the same window (`"HH:MM"`), parsed from
   * `NIGHT_PRINT_WINDOW`. The dashboard uses them for the automatic
   * night theme, so the frontend never keeps its own copy of the schedule.
   * `null` when the configured window cannot be parsed.
   */
  windowStart: string | null;
  windowEnd: string | null;
  candidates: NightCandidate[];
  pick: number;
}

export type EventLevel = "err" | "warn" | "info";

export interface CriticalEvent {
  icon: string;
  text: string;
  time: string;
  level: EventLevel;
}

export interface MaterialStock {
  name: string;
  swatch: string;
  have: number;
  unit: string;
  full: number;
  low?: boolean;
  need?: number;
}

export interface MaterialMismatch {
  job: string;
  needs: string;
  printer: string;
  loaded: string;
}

export interface MaterialQueueNeed {
  text: string;
  status: "warn" | "ok";
}

export interface MaterialsSection {
  filament: MaterialStock[];
  resin: MaterialStock[];
  mismatch: MaterialMismatch[];
  queueNeeds: MaterialQueueNeed[];
}

/**
 * Real observed counters. `done`/`failed` count transitions the service has
 * itself observed since it started (they reset with the process); the nullable
 * fields are `null` until a real data source can provide them.
 */
export interface TodaySection {
  done: number;
  active: number;
  failed: number;
  hoursUsed: number | null;
  hoursQueued: number | null;
}

export interface PerformanceSection {
  /** Instantaneous busy share of the farm; null when no printers configured. */
  load: number | null;
  free: number;
  busy: number;
  avgPrint: string | null;
  successRate: number | null;
}

export interface Automation {
  id: string;
  name: string;
  desc: string;
  on: boolean;
}

export type SystemComponentStatus = "ok" | "warn" | "err";

export interface SystemComponent {
  name: string;
  val: string;
  ok: SystemComponentStatus;
}

export type FeedKind = "ok" | "err" | "info";

export interface FeedEvent {
  icon: string;
  text: string;
  time: string;
  kind: FeedKind;
}

export interface Warning {
  icon: string;
  text: string;
  hint: string;
  level: EventLevel;
}

export interface PlanItem {
  title: string;
  printer: string;
  at: string;
}

export interface PlanSection {
  /** Null while no scheduler feeds the plan — never a made-up "next print". */
  next: PlanItem | null;
  upcoming: PlanItem[];
  queueEta: string | null;
  nightReady: string | null;
  manual: string[];
}

export interface MaintenanceRow {
  p: string;
  clean: string;
  nozzle: string;
  fep: string;
  calib: string;
  success: string;
  due: boolean;
}

/**
 * Machine-readable rule that produced the current light decision for one
 * printer. Deliberately about the *decision*, never about whether the physical
 * command succeeded — the command outcome lives in `LightControlView.actual`.
 */
export type LightPolicyReason =
  | "manual_override"
  | "monitoring_lease"
  | "solar_dark_active_print"
  | "solar_dark"
  | "solar_daylight"
  | "printer_inactive"
  | "automation_disabled"
  | "fallback_window"
  | "fixed_window"
  | "dark_unknown_safe_on"
  | "unsupported";

/** Per-printer chamber-light policy state for the dashboard (`snapshot.lights`). */
export interface LightControlView {
  id: string;
  /** Whether this printer has a controllable light at all. */
  supported: boolean;
  /** What the automation currently wants; null when it deliberately does not act. */
  desired: boolean | null;
  /** Last reported physical light state; null when the device does not say. */
  actual: boolean | null;
  reason: LightPolicyReason;
  /** ISO timestamp of the next automatic switch, when one is known. */
  nextTransitionAt: string | null;
  /** True while the solar schedule is degraded to the fallback window. */
  usingFallback: boolean;
}

/** Compact camera projection, derived from printers, for `GET /api/cameras`. */
export interface CameraView {
  id: string;
  name: string;
  camera: CameraState;
  cameraStream: boolean;
  cameraSrc: string | null;
  light: boolean;
  status: PrinterState;
  snapshotAt: string | null;
}

export interface AutomationsSection {
  automations: Automation[];
  lastRun: string | null;
}

/** The whole board in one payload — mirrors the frontend `state` object. */
export interface DashboardSnapshot {
  service: ServiceStatus;
  printers: PrinterView[];
  lights: LightControlView[];
  queue: QueueJob[];
  night: NightPrint;
  critical: CriticalEvent[];
  materials: MaterialsSection;
  today: TodaySection;
  perf: PerformanceSection;
  automations: Automation[];
  automationLastRun: string | null;
  system: SystemComponent[];
  feed: FeedEvent[];
  warnings: Warning[];
  plan: PlanSection;
  maintenance: MaintenanceRow[];
}
