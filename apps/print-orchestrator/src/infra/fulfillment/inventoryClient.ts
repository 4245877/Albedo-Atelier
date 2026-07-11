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
 * stock (nothing bound — not an error), true means the reel is now bound.
 */
export type SyncLoadedFilamentResult = {
  resolved: boolean;
  reason?: string;
};

/**
 * How a failed consume call should be treated by the caller:
 *  - `rejected` — fulfillment's consume handler received the request and said
 *    no (no loaded reel, not enough stock, material mismatch). Retrying the
 *    same payload gives the same answer until an operator fixes the stock, so
 *    the caller must NOT auto-retry — worse, the operator may correct the
 *    stock by hand in the meantime, and a late auto-retry would double-deduct.
 *  - `unreachable` — the request may never have been processed (network error,
 *    timeout, 5xx). The consume endpoint is idempotent per `idempotencyKey`,
 *    so retrying later is safe and expected.
 */
export type FulfillmentFailureKind = "rejected" | "unreachable";

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

  constructor(baseUrl: string = env.fulfillmentApiUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Whether a fulfillment base URL is configured; when false, `consume` is a no-op. */
  get enabled(): boolean {
    return Boolean(this.baseUrl);
  }

  /**
   * Deducts filament for a completed print. Returns `null` when the feature is
   * disabled; resolves with the movement/stock on success; throws
   * {@link FulfillmentError} when fulfillment rejects the call or is unreachable.
   */
  async consume(input: ConsumeFilamentInput): Promise<ConsumeFilamentResult | null> {
    if (!this.enabled) return null;

    const url = `${this.baseUrl}/api/inventory/filament/consume`;

    try {
      const res = await fetchWithTimeout(url, {
        method: "POST",
        timeoutMs: TIMEOUT_MS,
        headers: { "Content-Type": "application/json" },
        // Undefined fields are dropped by JSON.stringify, so each call carries
        // only the quantity/hints its source actually has.
        body: JSON.stringify({
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
        }),
      });

      const text = await res.text();
      const json = text ? safeJson(text) : null;

      if (!res.ok) {
        // A 4xx with a JSON `{ error }` body means fulfillment reached the
        // consume handler and rejected the request (no loaded filament, not
        // enough stock, …): surface its message and mark it permanent. A 5xx —
        // even with an error body (Fastify serializes crashes as JSON too) —
        // or a bodyless status means the deduction may not have been recorded,
        // so it stays retryable.
        if (res.status < 500 && json && typeof json.error === "string") {
          throw new FulfillmentError(json.error, "rejected");
        }
        throw new FulfillmentError(`склад вернул ${res.status}`, "unreachable");
      }

      return json as ConsumeFilamentResult;
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
   * Reports the reel a printer currently has loaded so fulfillment binds it to a
   * stock position for auto-deduction. Returns `null` when the feature is
   * disabled; resolves with `{ resolved }` on success (`resolved: false` means
   * the hint matched no stock — a benign no-op, not an error); throws
   * {@link FulfillmentError} only when fulfillment rejects the call or is
   * unreachable, so the caller can retry the sync on the next poll.
   */
  async syncLoadedFilament(
    input: SyncLoadedFilamentInput
  ): Promise<SyncLoadedFilamentResult | null> {
    if (!this.enabled) return null;

    const url = `${this.baseUrl}/api/inventory/printer-filament/sync`;

    try {
      const res = await fetchWithTimeout(url, {
        method: "POST",
        timeoutMs: TIMEOUT_MS,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          printerId: input.printerId,
          amsTray: input.amsTray,
          material: input.material,
          color: input.color,
          source: "printer",
        }),
      });

      const text = await res.text();
      const json = text ? safeJson(text) : null;

      if (!res.ok) {
        if (res.status < 500 && json && typeof json.error === "string") {
          throw new FulfillmentError(json.error, "rejected");
        }
        throw new FulfillmentError(`склад вернул ${res.status}`, "unreachable");
      }

      return (json as SyncLoadedFilamentResult) ?? { resolved: false };
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
}
