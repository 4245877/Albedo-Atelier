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
 * (no printer assigned); `unconfirmed` — a start command went out and the
 * printer never confirmed it, so the job is neither startable nor printing and
 * only an operator's account of the machine can move it. Older persisted files
 * may still carry a legacy `"error"` status; the state loader normalizes it to
 * `review` on load.
 *
 * `unconfirmed` is deliberately NOT folded into `review`. It was, and that is
 * how the resolution flow became unreachable: a `review` row is passive, so the
 * one task that needed an operator decision was the one task with no button on
 * it, while a stale "▶ Запустить" elsewhere still pointed at a start the server
 * would (correctly) refuse. A distinct status lets the queue offer the decision
 * where the operator already is.
 */
export type QueueJobStatus = "ready" | "review" | "unconfirmed";

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
   * Measured facts behind the display strings above, absent when genuinely
   * unknown. They exist so the queue card can show what the system already
   * knows ("PETG · 0.4 мм · ≈ 1 ч 29 мин · ≈ 31 г") instead of the `—`
   * placeholders it printed while the data sat unread in the artifact analysis.
   * Absent ≠ zero: a missing field means "not measured", and the UI must render
   * it as unknown rather than as `0`.
   */
  nozzleMm?: number;
  etaSeconds?: number;
  filamentG?: number;
  /** The assignment that would execute this task, when one is already on file. */
  assignmentId?: string;
  /**
   * The run awaiting an operator's verdict, when `status` is `unconfirmed`. It
   * is the argument the resolution takes (`POST /api/print/runs/:id/resolve`),
   * so the queue row can carry the operator straight to the decision instead of
   * describing a dead end.
   */
  unresolvedRunId?: string;
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
   * Immutable preview identity of the candidate: the SQLite task id, the task
   * version and the artifact content hash the candidate was built from. The
   * dashboard sends these back with night-start; the server refuses (409) when
   * any of them moved — the operator never confirms one list and starts another.
   */
  taskId?: string;
  taskVersion?: number | null;
  artifactSha256?: string | null;
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

/** The warehouse's verdict on one position, computed from ITS OWN thresholds. */
export type MaterialStockStatus = "ok" | "low" | "critical";

export interface MaterialStock {
  name: string;
  swatch: string;
  have: number;
  unit: string;
  /**
   * The 100%-mark of the level bar: the position's own "low stock" threshold,
   * in {@link unit}. So a full bar means "at or above the threshold the operator
   * set for this position", not "a full spool" — the farm has no idea how large
   * a full spool is, and inventing one would make the bar fiction. 0 when the
   * warehouse defines no threshold, which the UI renders as no bar at all.
   */
  full: number;
  low?: boolean;
  need?: number;
  /**
   * The warehouse's own low/critical verdict. Authoritative — the UI must
   * colour the level by THIS, never by a hardcoded fraction of {@link full},
   * because the thresholds are per-position operator settings.
   */
  status?: MaterialStockStatus;
  /** Exact balance in the warehouse's native unit, for tooltips/diagnostics. */
  grams?: number;
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

/**
 * One reel the warehouse says is loaded in a printer — the binding a completed
 * print actually deducts from. Distinct from the `material` typed into the
 * printer's config: this is what the two services agreed is physically there.
 */
export interface MaterialLoadedReel {
  /** Printer name as the farm knows it (falls back to the warehouse snapshot). */
  printer: string;
  /** "AMS-слот 1" for a multi-slot machine, null for the single printer-level reel. */
  slot: string | null;
  material: string;
  /** Human colour name from the warehouse ("Чорний"); empty when it has none. */
  colorName: string;
  swatch: string;
  /** ISO time the binding was last written. */
  updatedAt: string;
}

/**
 * Where the balances came from and whether they can be trusted right now. The
 * UI needs all four to tell the operator the truth: an unconfigured integration,
 * a warehouse outage, an aged answer and a genuinely empty shelf are four
 * different situations that used to render identically as "учёт не подключён".
 */
export interface MaterialsSource {
  /** `fulfillment` once FULFILLMENT_API_URL is configured; `none` otherwise. */
  kind: "fulfillment" | "none";
  /** Whether the last warehouse read succeeded. */
  ok: boolean;
  /** Configured, but the first read has not finished yet (just after a restart). */
  pending: boolean;
  /** Whether the last successful read is older than the farm should trust. */
  stale: boolean;
  /** ISO time of the last successful read; null until one lands. */
  updatedAt: string | null;
  /** Operator-facing reason the last read failed; null while healthy. */
  error: string | null;
}

export interface MaterialsSection {
  filament: MaterialStock[];
  resin: MaterialStock[];
  mismatch: MaterialMismatch[];
  queueNeeds: MaterialQueueNeed[];
  /** Reel bindings from the warehouse; empty when it knows of none. */
  loaded: MaterialLoadedReel[];
  source: MaterialsSource;
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
