import { readPositiveInt } from "./readers";
import { envVar, type EnvSource } from "./registry";

const VARS = {
  /**
   * Base URL of the fulfillment API used to auto-deduct filament stock when a
   * print completes (e.g. `http://fulfillment-api:8080` or `http://<host>:3001`).
   * Empty disables auto-consume — the farm keeps running standalone.
   */
  fulfillmentApiUrl: envVar("FULFILLMENT_API_URL", "filament", (_n, raw) => raw ?? ""),
  /**
   * Inter-service token for the fulfillment inventory endpoints (consume/sync),
   * sent as the `x-service-token` header. Must equal fulfillment's own
   * `ATELIER_FULFILLMENT_TOKEN`. Never logged, never persisted. Empty with
   * `FULFILLMENT_API_URL` set is a misconfiguration: fulfillment answers 401
   * unless its temporary `ATELIER_FULFILLMENT_AUTH_OPTIONAL` mode is on — a
   * loud warning is logged at startup and every auth refusal surfaces as an
   * operator event (see FilamentConsumption/FilamentSync).
   */
  fulfillmentServiceToken: envVar("ATELIER_FULFILLMENT_TOKEN", "filament", (_n, raw) => raw ?? ""),
  /**
   * How long to wait before re-posting a loaded-reel sync that fulfillment
   * answered `resolved: false` (no matching stock yet). Long enough not to
   * hammer fulfillment every poll, short enough that stock added by the
   * operator is picked up before the print usually finishes.
   */
  filamentSyncRetryMs: envVar("FILAMENT_SYNC_RETRY_MS", "filament", (n, raw) =>
    readPositiveInt(n, raw, 5 * 60 * 1000)
  ),
  /**
   * Hard cap on the persistent filament-deduction retry queue. Beyond it the
   * OLDEST entry is dropped with an operator event and a dropped-counter bump
   * (never silently). Documented default: 200.
   */
  filamentRetryQueueMax: envVar("FILAMENT_RETRY_QUEUE_MAX", "filament", (n, raw) =>
    readPositiveInt(n, raw, 200)
  ),
  /**
   * How long a queued deduction is retried before it is dropped (loudly, with
   * an operator event + dropped counter). Documented default: 7 days.
   */
  filamentRetryMaxAgeDays: envVar("FILAMENT_RETRY_MAX_AGE_DAYS", "filament", (n, raw) =>
    readPositiveInt(n, raw, 7)
  )
};

/** Fulfillment-warehouse integration (filament auto-deduction) settings. */
export function buildFilamentConfig(source: EnvSource) {
  return {
    fulfillmentApiUrl: VARS.fulfillmentApiUrl.read(source),
    fulfillmentServiceToken: VARS.fulfillmentServiceToken.read(source),
    filamentSyncRetryMs: VARS.filamentSyncRetryMs.read(source),
    filamentRetryQueueMax: VARS.filamentRetryQueueMax.read(source),
    filamentRetryMaxAgeDays: VARS.filamentRetryMaxAgeDays.read(source)
  };
}
