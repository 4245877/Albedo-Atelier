import { env } from "../../shared/env";
import { fetchWithTimeout, isTimeoutError } from "../../shared/fetchWithTimeout";

/**
 * Server-side client for the fulfillment inventory API. When a print completes,
 * the orchestrator posts the consumed filament here and fulfillment deducts the
 * matching stock (resolving material/color from the printer's loaded reel and
 * converting mm→grams by material density on its side).
 *
 * Two quantity shapes, one per source of truth:
 *  - Moonraker/K2 reports extruded length, so we send `lengthMm` for the single
 *    loaded reel.
 *  - Bambu MQTT has no length; filament is measured per AMS tray in grams (see
 *    bambuUsage.ts), so we send `grams` plus `amsTray` (which slot) and the
 *    tray's `material`/`color` hints, one call per used slot. Fulfillment uses
 *    `amsTray` to resolve that slot's reel and already tracks stock in grams.
 *
 * These extra fields are additive: a fulfillment that only understands the
 * single-reel `lengthMm` case keeps working for Moonraker unchanged.
 *
 * Authentication: both endpoints are protected on the fulfillment side by a
 * dedicated inter-service token (fulfillment env `ATELIER_FULFILLMENT_TOKEN`),
 * sent in the `x-service-token` header. The token is read from THIS service's
 * `ATELIER_FULFILLMENT_TOKEN` env var, attached centrally in {@link post} for
 * every request (first delivery and queue redelivery alike), and never logged,
 * never embedded in error messages and never persisted anywhere. A 401/403 is
 * classified as its own {@link FulfillmentFailureKind} (`auth`) — a
 * configuration error, not a transient network failure.
 *
 * Modeled on fulfillment's own outbound proxy (`modules/appeals/upstream.ts`):
 * a hard request timeout, a typed error, and a safe JSON parse. The
 * feature is disabled (a no-op) until `FULFILLMENT_API_URL` is configured, so the
 * farm keeps running standalone.
 */

const TIMEOUT_MS = 8000;

export type ConsumeFilamentInput = {
  /** Orchestrator printer id; must match fulfillment's `printer_filament_state.printerId`. */
  printerId: string;
  /** Extruded filament length in mm (Moonraker `print_stats.filament_used`). */
  lengthMm?: number;
  /** Consumed grams (Bambu AMS remain-delta). Provide this or {@link lengthMm}. */
  grams?: number;
  /** AMS slot index for per-slot reel resolution (Bambu AMS); omit for single-reel printers. */
  amsTray?: number;
  /** Material hint from the AMS tray (`tray_type`), to resolve/validate the slot's reel. */
  material?: string;
  /** Colour hint from the AMS tray (`#RRGGBB`). */
  color?: string;
  /** Stable identity of the print run, recorded on the movement. */
  printJobId: string;
  /** Dedup key so a re-observed/retried completion is not deducted twice. */
  idempotencyKey: string;
  note?: string;
};

export type ConsumeFilamentResult = {
  duplicate: boolean;
  /**
   * Whole grams fulfillment ACTUALLY deducted for this request (0 on a
   * duplicate). Additive contract field: this side already sends pre-normalized
   * integer grams (see FilamentConsumption.applyCarry), so `appliedG` equals
   * the sent quantity; older fulfillment builds leave it undefined.
   */
  appliedG?: number;
  stock: { material: string; color: string; stockG: number } | null;
  movement: { id: string; quantityG: number } | null;
};

/**
 * The loaded-filament hint the orchestrator pushes so fulfillment can bind the
 * printer's reel to a stock position automatically — no manual dashboard entry
 * (see FilamentSync). Material/colour are raw device values; fulfillment resolves
 * them to an existing reel (per slot for AMS) and records the binding used by
 * {@link consume} at completion.
 */
export type SyncLoadedFilamentInput = {
  /** Orchestrator printer id; must match fulfillment's `printer_filament_state.printerId`. */
  printerId: string;
  /** AMS slot for per-slot binding (Bambu AMS); omit for single-reel printers. */
  amsTray?: number;
  /** Loaded material as the device reports it (may carry a brand suffix). */
  material: string;
  /** Loaded colour hint (`#RRGGBB` or a named colour); omit when the device has none. */
  color?: string;
};

/**
 * Fulfillment's answer to a sync: `resolved` false means the hint matched no
 * stock (nothing bound — the caller re-tries later, once the operator may have
 * stocked the material), true means the reel is now bound.
 *
 * The extra fields are additive diagnostics newer fulfillment builds return on
 * `resolved: true`; an older fulfillment simply leaves them undefined:
 *  - `changed` — the binding actually moved to a different stock position (vs an
 *    idempotent re-sync of the same reel), so the caller can announce the reel
 *    change exactly once;
 *  - `matchedBy` / `colorMismatch` — how the stock was matched; `material-only`
 *    with `colorMismatch: true` means the reel's reported colour provably
 *    differs from the only stock of that material, worth an operator warning;
 *  - `stock` / `previousStock` — human-readable labels of the bound position
 *    (and the one it replaced) for operator-facing messages.
 */
export type SyncLoadedFilamentResult = {
  resolved: boolean;
  reason?: string;
  changed?: boolean;
  matchedBy?: "material-color" | "material-only";
  colorMismatch?: boolean;
  stock?: { id?: string; material?: string; color?: string; colorName?: string } | null;
  previousStock?: { material?: string; color?: string; colorName?: string } | null;
};

/**
 * How a failed call should be treated by the caller:
 *  - `rejected` — fulfillment's handler received the request and said no (no
 *    loaded reel, not enough stock, material mismatch). Retrying the same
 *    payload gives the same answer until an operator fixes the stock, so the
 *    caller must NOT auto-retry — worse, the operator may correct the stock by
 *    hand in the meantime, and a late auto-retry would double-deduct.
 *  - `auth` — fulfillment refused the credentials (401/403). A configuration
 *    error (missing/rotated `ATELIER_FULFILLMENT_TOKEN`), not a transient
 *    failure: the payload was NOT processed, so retrying later (after the
 *    operator fixes the token) is safe, but hammering is pointless.
 *  - `unreachable` — the request may never have been processed (network error,
 *    timeout, 5xx). The consume endpoint is idempotent per `idempotencyKey`,
 *    so retrying later is safe and expected.
 */
export type FulfillmentFailureKind = "rejected" | "auth" | "unreachable";

/** A reached-but-rejected or unreachable fulfillment call. Message is operator-facing. */
export class FulfillmentError extends Error {
  constructor(
    message: string,
    readonly kind: FulfillmentFailureKind = "unreachable"
  ) {
    super(message);
    this.name = "FulfillmentError";
  }
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class FulfillmentInventoryClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string;

  constructor(
    baseUrl: string = env.fulfillmentApiUrl,
    serviceToken: string = env.fulfillmentServiceToken
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.serviceToken = serviceToken.trim();
  }

  /** Whether a fulfillment base URL is configured; when false, `consume` is a no-op. */
  get enabled(): boolean {
    return Boolean(this.baseUrl);
  }

  /**
   * Whether the inter-service token is configured. Surfaced so startup can log
   * a clear misconfiguration warning (enabled client, no token → fulfillment
   * will answer 401 once its compatibility mode is off). The token value itself
   * is never exposed.
   */
  get hasServiceToken(): boolean {
    return this.serviceToken.length > 0;
  }

  /**
   * The one POST path both endpoints share: the service token is attached HERE,
   * centrally, so every request — first delivery and queue redelivery alike —
   * carries the same `x-service-token` header. Response taxonomy:
   * 401/403 → `auth`; other 4xx with a JSON `{ error }` body → `rejected`
   * (fulfillment reached the handler and refused); 5xx / bodyless / network /
   * timeout → `unreachable` (processing unknown, retry is safe).
   */
  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.serviceToken) headers["x-service-token"] = this.serviceToken;

    try {
      const res = await fetchWithTimeout(url, {
        method: "POST",
        timeoutMs: TIMEOUT_MS,
        headers,
        // Undefined fields are dropped by JSON.stringify, so each call carries
        // only the quantity/hints its source actually has.
        body: JSON.stringify(body),
      });

      const text = await res.text();
      const json = text ? safeJson(text) : null;

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          // Never echo the token (or its absence details) — name the variable only.
          throw new FulfillmentError(
            `склад отклонил сервисную авторизацию (HTTP ${res.status}) — проверьте ATELIER_FULFILLMENT_TOKEN на обеих сторонах`,
            "auth"
          );
        }
        // A 4xx with a JSON `{ error }` body means fulfillment reached the
        // handler and rejected the request (no loaded filament, not enough
        // stock, …): surface its message and mark it permanent. A 5xx — even
        // with an error body (Fastify serializes crashes as JSON too) — or a
        // bodyless status means the operation may not have been recorded, so it
        // stays retryable.
        if (res.status < 500 && json && typeof json.error === "string") {
          throw new FulfillmentError(json.error, "rejected");
        }
        throw new FulfillmentError(`склад вернул ${res.status}`, "unreachable");
      }

      return json;
    } catch (error) {
      if (error instanceof FulfillmentError) throw error;
      const reason = isTimeoutError(error)
        ? `таймаут ${TIMEOUT_MS} мс`
        : error instanceof Error
          ? error.message
          : String(error);
      throw new FulfillmentError(`склад филамента недоступен (${reason})`);
    }
  }

  /**
   * Deducts filament for a completed print. Returns `null` when the feature is
   * disabled; resolves with the movement/stock on success; throws
   * {@link FulfillmentError} when fulfillment rejects the call or is unreachable.
   */
  async consume(input: ConsumeFilamentInput): Promise<ConsumeFilamentResult | null> {
    if (!this.enabled) return null;

    const json = await this.post("/api/inventory/filament/consume", {
      printerId: input.printerId,
      lengthMm: input.lengthMm,
      grams: input.grams,
      amsTray: input.amsTray,
      material: input.material,
      color: input.color,
      source: "printer",
      printJobId: input.printJobId,
      idempotencyKey: input.idempotencyKey,
      note: input.note,
    });

    return json as ConsumeFilamentResult;
  }

  /**
   * Reports the reel a printer currently has loaded so fulfillment binds it to a
   * stock position for auto-deduction. Returns `null` when the feature is
   * disabled; resolves with `{ resolved, … }` on success (`resolved: false`
   * means the hint matched no stock — the caller re-tries after a delay, see
   * FilamentSync); throws {@link FulfillmentError} when fulfillment rejects the
   * call or is unreachable, so the caller can retry the sync on the next poll.
   */
  async syncLoadedFilament(
    input: SyncLoadedFilamentInput
  ): Promise<SyncLoadedFilamentResult | null> {
    if (!this.enabled) return null;

    const json = await this.post("/api/inventory/printer-filament/sync", {
      printerId: input.printerId,
      amsTray: input.amsTray,
      material: input.material,
      color: input.color,
      source: "printer",
    });

    return (json as SyncLoadedFilamentResult) ?? { resolved: false };
  }
}
