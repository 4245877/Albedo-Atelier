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
  status: "ready" | "degraded" | "starting" | "stale";
  service: string;
  startedAt: string;
  lastPollAt: string | null;
  lastPollAgeSeconds: number | null;
  printers: { total: number; online: number };
}

/** Real farm counters exposed as Prometheus metrics. */
export interface FarmMetrics {
  up: number;
  uptimeSeconds: number;
  lastPollAgeSeconds: number | null;
  degraded: number;
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
