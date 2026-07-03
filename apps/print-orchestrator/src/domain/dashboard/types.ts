import type { CameraState, PrinterState, PrinterView } from "../printers/types";

/**
 * Every type here matches the shape the dashboard frontend renders 1:1
 * (apps/print-dashboard/app.js). The aggregate {@link DashboardSnapshot} maps
 * key-for-key onto the frontend's `state` object so the page can render the
 * whole board from a single `GET /api/dashboard` with no extra processing.
 */

export interface ServiceStatus {
  status: "ok" | "degraded" | "down";
  backend: "ok" | "down";
  version: string;
  startedHoursAgo: number;
}

export type QueueJobStatus = "ready" | "review" | "error";

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
}

export interface NightPrint {
  window: string;
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
  maintenance: number;
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
