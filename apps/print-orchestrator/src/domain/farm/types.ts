/**
 * Farm-level service contracts consumed outside the dashboard read model:
 * `/ready` and `/metrics` (see `infra/observability/`). They live in the domain
 * layer — not in the read model that happens to compute them — because they are
 * part of the service's operational API, mirrored by external monitoring.
 */

/** Real readiness, derived from whether the poll loop is running and fresh. */
export interface FarmReadiness {
  /** false → the service should return 503. */
  ready: boolean;
  status: "ready" | "degraded" | "starting" | "stale" | "db_unavailable";
  service: string;
  startedAt: string;
  lastPollAt: string | null;
  lastPollAgeSeconds: number | null;
  printers: { total: number; online: number };
  /**
   * Can the service actually reach its own database? SQLite is the source of
   * truth for the queue, runs and the printer inventory, so a healthy poll loop
   * over an unreadable database is not readiness — it is a green light in front
   * of a farm that cannot dispatch anything.
   */
  database: { ok: boolean; error?: string };
}

/** Real farm counters exposed as Prometheus metrics. */
export interface FarmMetrics {
  up: number;
  uptimeSeconds: number;
  lastPollAgeSeconds: number | null;
  degraded: number;
  /** 1 when a cheap probe of queue.db succeeded, 0 when it did not. */
  dbOk: number;
  printersTotal: number;
  printersOnline: number;
  printersPrinting: number;
  printersError: number;
  camerasTotal: number;
  camerasOnline: number;
  queueJobs: number;
  completedToday: number;
  failedToday: number;
}
