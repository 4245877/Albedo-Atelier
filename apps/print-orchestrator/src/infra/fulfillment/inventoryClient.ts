import { env } from "../../shared/env";
import { fetchWithTimeout, isTimeoutError } from "../../shared/fetchWithTimeout";

/**
 * Server-side client for the fulfillment inventory API. Fulfillment owns the
 * filament warehouse; this client is the ONLY door between the two services, in
 * both directions:
 *
 *  - writes — when a print completes the orchestrator posts the consumed
 *    filament and fulfillment deducts the matching stock (resolving
 *    material/color from the printer's loaded reel and converting mm→grams by
 *    material density on its side), and it pushes the reel each printer reports
 *    loaded so fulfillment can bind it to a stock position;
 *  - reads — the warehouse balances and those reel bindings come back over
 *    {@link fetchStockSummary} / {@link fetchLoadedReels}, which is what feeds
 *    the dashboard's «Материалы» card. atelier keeps NO copy of the stock: it
 *    caches the last answer for display (see FilamentStock) and says so plainly
 *    when the warehouse is unreachable, rather than showing stale numbers as
 *    fact.
 *
 * Read endpoints carry no body and are not admin-gated on the fulfillment side
 * (its own dashboard fetches them same-origin); the service token is still sent
 * on every request, so tightening that gate later needs no change here.
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

/** Warehouse verdict on one stock position, computed against ITS OWN thresholds. */
export type StockStatus = "ok" | "low" | "critical";

/**
 * One warehouse position (material × colour) as fulfillment reports it on
 * `GET /api/inventory/summary`. Grams are the warehouse's native unit; the
 * thresholds are per-position operator settings, so atelier must never
 * re-derive "low"/"critical" from a hardcoded fraction — it reads
 * {@link status}, which fulfillment computed from those very thresholds.
 */
export type FilamentStockPosition = {
  id: string;
  /** Uppercased material as stored ("PLA", "PETG", …). */
  material: string;
  /** Lowercased colour key as stored ("black", "yellow", `#rrggbb`, …). */
  color: string;
  /** Human colour name, already localized by fulfillment ("Чорний"). */
  colorName: string;
  /** `material colorName`, fulfillment's own display label for the position. */
  label: string;
  stockG: number;
  lowStockG: number;
  criticalStockG: number;
  status: StockStatus;
};

/** The whole shelf plus its roll-ups, as returned by `GET /api/inventory/summary`. */
export type FilamentStockSummary = {
  /** Total grams on the shelf across every active position. */
  totalG: number;
  /** How many reels are currently bound to a printer. */
  reelsInUse: number;
  positions: FilamentStockPosition[];
};

/**
 * One reel binding from `GET /api/inventory/printer-filament`: which warehouse
 * position a printer (or one AMS slot of it) currently has loaded. This is the
 * binding a completion deduction actually draws from, so it is the truthful
 * answer to "what is in this machine" — better than the material typed into the
 * printer's config.
 */
export type LoadedReel = {
  printerId: string;
  /** Live name from atelier, else the snapshot taken when the reel was bound. */
  printerName: string | null;
  /** AMS slot, or null for the printer-level reel of a single-spool machine. */
  amsTray: number | null;
  stockId: string;
  material: string;
  color: string;
  updatedAt: string;
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

/** Finite number or the fallback — a malformed field must never become NaN. */
function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Whitelist-parse of a position's status; anything unexpected reads as "ok". */
function stockStatus(value: unknown): StockStatus {
  return value === "low" || value === "critical" ? value : "ok";
}

/**
 * Reads one warehouse position out of the summary payload, tolerating a
 * fulfillment build that adds or renames fields around the ones we use. A row
 * without a material is dropped by the caller — a nameless position cannot be
 * matched to a queued job, and rendering it would just be noise.
 */
function toPosition(raw: any): FilamentStockPosition | null {
  const material = str(raw?.material).trim();
  if (!material) return null;
  const color = str(raw?.color).trim();
  const colorName = str(raw?.colorName).trim() || color;
  return {
    id: str(raw?.id),
    material,
    color,
    colorName,
    label: str(raw?.label).trim() || [material, colorName].filter(Boolean).join(" "),
    stockG: Math.max(0, num(raw?.stockG)),
    lowStockG: Math.max(0, num(raw?.lowStockG)),
    criticalStockG: Math.max(0, num(raw?.criticalStockG)),
    status: stockStatus(raw?.status)
  };
}

/** Reads one reel binding; a row without a printer id binds nothing and is dropped. */
function toLoadedReel(raw: any): LoadedReel | null {
  const printerId = str(raw?.printerId).trim();
  if (!printerId) return null;
  const amsTray = raw?.amsTray === null || raw?.amsTray === undefined ? null : num(raw.amsTray, 0);
  return {
    printerId,
    printerName: str(raw?.printerName).trim() || null,
    amsTray,
    stockId: str(raw?.stockId),
    material: str(raw?.material).trim(),
    color: str(raw?.color).trim(),
    updatedAt: str(raw?.updatedAt)
  };
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
   * The one path EVERY endpoint shares, read and write alike: the service token
   * is attached HERE, centrally, so every request — first delivery, queue
   * redelivery, warehouse read — carries the same `x-service-token` header.
   * Response taxonomy: 401/403 → `auth`; other 4xx with a JSON `{ error }` body
   * → `rejected` (fulfillment reached the handler and refused); 5xx / bodyless /
   * network / timeout → `unreachable` (processing unknown, retry is safe).
   */
  private async request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};
    if (body) headers["Content-Type"] = "application/json";
    if (this.serviceToken) headers["x-service-token"] = this.serviceToken;

    try {
      const res = await fetchWithTimeout(url, {
        method,
        timeoutMs: TIMEOUT_MS,
        headers,
        // Undefined fields are dropped by JSON.stringify, so each call carries
        // only the quantity/hints its source actually has.
        ...(body ? { body: JSON.stringify(body) } : {}),
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

  private post(path: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", path, body);
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

  /**
   * The warehouse shelf: every active material × colour position with its
   * balance and fulfillment's own low/critical verdict. Returns `null` when the
   * integration is disabled; throws {@link FulfillmentError} when fulfillment
   * refuses or is unreachable — the caller decides how to show an outage (it
   * must never be shown as an empty shelf).
   *
   * The payload is parsed defensively (see {@link toPosition}): an unexpected
   * or partially-broken row is dropped, never turned into a NaN balance.
   */
  async fetchStockSummary(): Promise<FilamentStockSummary | null> {
    if (!this.enabled) return null;

    const json = (await this.request("GET", "/api/inventory/summary")) as any;
    const rows: unknown[] = Array.isArray(json?.stock) ? json.stock : [];
    const positions = rows
      .map(toPosition)
      .filter((position): position is FilamentStockPosition => position !== null);

    return {
      // fulfillment reports the roll-up in kilograms; grams are the unit every
      // balance here is kept in, so convert once at the boundary.
      totalG: Math.max(0, num(json?.filamentKg) * 1000),
      reelsInUse: Math.max(0, Math.round(num(json?.reelsInUse))),
      positions
    };
  }

  /**
   * Which warehouse position each printer (or AMS slot) currently has loaded —
   * the bindings the completion deduction draws from. Returns `null` when the
   * integration is disabled; throws {@link FulfillmentError} on refusal/outage.
   */
  async fetchLoadedReels(): Promise<LoadedReel[] | null> {
    if (!this.enabled) return null;

    const json = (await this.request("GET", "/api/inventory/printer-filament")) as any;
    const rows: unknown[] = Array.isArray(json?.items) ? json.items : [];
    return rows.map(toLoadedReel).filter((reel): reel is LoadedReel => reel !== null);
  }
}
