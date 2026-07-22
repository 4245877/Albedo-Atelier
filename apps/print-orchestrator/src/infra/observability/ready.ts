import type { FarmReadiness } from "../../domain/farm/types";
import type { DashboardReadModel } from "../../app/dashboardReadModel";

export type ReadyResponse = FarmReadiness;

/**
 * Real readiness, drawn from the live poll loop (via
 * {@link DashboardReadModel.getReadiness}). `ready === false` means the caller
 * should reply 503 — the service has not yet completed a poll, or the poll loop
 * has gone stale. The read model is passed in explicitly — no farm singleton.
 */
export function getReadiness(reads: Pick<DashboardReadModel, "getReadiness">): ReadyResponse {
  return reads.getReadiness();
}
