import type { FarmReadiness } from "../../domain/farm/types";
import { farmStore } from "../../app/farmStore";

export type ReadyResponse = FarmReadiness;

/**
 * Real readiness, drawn from the live poll loop (see {@link FarmStore.getReadiness}).
 * `ready === false` means the caller should reply 503 — the service has not yet
 * completed a poll, or the poll loop has gone stale.
 */
export function getReadiness(): ReadyResponse {
  return farmStore.reads.getReadiness();
}
