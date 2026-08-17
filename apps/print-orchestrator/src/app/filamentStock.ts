import {
  FulfillmentError,
  type FilamentStockPosition,
  type FilamentStockSummary,
  type LoadedReel
} from "../infra/fulfillment/inventoryClient";
import { env } from "../shared/env";
import type { StoreLogger } from "../shared/logger";

/**
 * The slice of the fulfillment inventory client this cache needs. Structural,
 * so the consumer stays decoupled and testable without a network.
 */
export interface InventoryStockClient {
  readonly enabled: boolean;
  fetchStockSummary(): Promise<FilamentStockSummary | null>;
  fetchLoadedReels(): Promise<LoadedReel[] | null>;
}

/**
 * What the read model gets: the last warehouse answer PLUS an honest account of
 * where it came from. The three fields that matter are deliberately separate,
 * because they mean different things to an operator:
 *
 *  - `connected` — is the integration configured at all (`FULFILLMENT_API_URL`)?
 *    False means atelier genuinely has no stock source, which is what the old
 *    «учёт не подключён» message described.
 *  - `ok` — did the last refresh succeed? False with `connected: true` is an
 *    OUTAGE, not an empty shelf: fulfillment is configured but silent.
 *  - `stale` — the last successful answer is older than the farm should trust.
 *
 * Collapsing these into "no data" is exactly the bug this cache exists to
 * avoid: a warehouse that is down must never render as a warehouse that is
 * empty, and a warehouse that is empty must never render as one that is absent.
 */
export interface FilamentStockView {
  connected: boolean;
  ok: boolean;
  /**
   * Configured, but no read has finished yet — the state right after a restart.
   * Distinct from an outage on purpose: "ещё не спросили" and "спросили, молчит"
   * must not read the same to an operator.
   */
  pending: boolean;
  stale: boolean;
  /** ISO time of the last SUCCESSFUL refresh; null until one lands. */
  fetchedAt: string | null;
  /** Operator-facing reason the last refresh failed; null while healthy. */
  error: string | null;
  positions: FilamentStockPosition[];
  reels: LoadedReel[];
  totalG: number;
  reelsInUse: number;
}

const EMPTY: Omit<FilamentStockView, "connected" | "ok" | "pending" | "stale" | "error"> = {
  fetchedAt: null,
  positions: [],
  reels: [],
  totalG: 0,
  reelsInUse: 0
};

/**
 * The read-side half of the fulfillment integration: a small polling cache of
 * the filament warehouse (balances + per-printer reel bindings), refreshed on
 * the printer-poll cadence and read *synchronously* by the dashboard read model.
 *
 * Why a cache and not a pass-through call: `GET /api/dashboard` is a hot,
 * frequently-polled read that must stay fast and must never fail because a
 * neighbouring service is slow. So the warehouse is fetched on its own cadence
 * ({@link env.filamentStockRefreshMs}), out of band, and the board renders the
 * last answer together with its age.
 *
 * atelier is NOT a second source of truth for stock — nothing here is persisted.
 * The cache lives in memory, dies with the process, and is rebuilt from
 * fulfillment on the first poll after a restart. On an outage the previous
 * numbers are kept but flagged (`ok: false`, and `stale` once they age out), so
 * the operator sees "these are the last known balances and the warehouse is
 * quiet" rather than either a lie or a blank.
 *
 * Never throws into the poll loop: a disabled client is a no-op and every
 * failure is swallowed after a log.
 */
export class FilamentStock {
  private logger: StoreLogger = {};
  private state = { ...EMPTY };
  /** Wall-clock of the last successful refresh; the anchor for `stale` + the cadence. */
  private fetchedAtMs: number | null = null;
  /**
   * Wall-clock of the last ATTEMPT, successful or not, so a failing warehouse is
   * retried on the cadence rather than on every poll. `null` = never attempted,
   * which is always due (a zero sentinel would make the very first read depend
   * on the clock's epoch).
   */
  private attemptedAtMs: number | null = null;
  private error: string | null = null;
  private inFlight: Promise<void> | null = null;
  /** One log line per outage, cleared by the next success — not one per poll. */
  private outageLogged = false;

  private readonly refreshIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly now: () => number;

  constructor(
    /** Fulfillment stock client; when absent/disabled the cache stays empty. */
    private readonly inventory: InventoryStockClient | undefined,
    options: {
      /** How often the warehouse is re-read; defaults to the env setting. */
      refreshIntervalMs?: number;
      /** Age past which the last answer is flagged stale; defaults to 3× the interval. */
      staleAfterMs?: number;
      /** Clock, injectable for tests. */
      now?: () => number;
    } = {}
  ) {
    this.refreshIntervalMs = options.refreshIntervalMs ?? env.filamentStockRefreshMs;
    this.staleAfterMs = options.staleAfterMs ?? this.refreshIntervalMs * 3;
    this.now = options.now ?? Date.now;
  }

  /** Wires the store logger in once it is available (after config load). */
  useLogger(logger: StoreLogger): void {
    this.logger = logger;
  }

  /** Whether a fulfillment base URL is configured at all. */
  get connected(): boolean {
    return Boolean(this.inventory?.enabled);
  }

  /**
   * Refreshes if the cadence is due and no call is already in flight.
   * Fire-and-forget by contract: called from the poll loop, self-guarded, and it
   * must never delay or fail a poll. The started call is returned (undefined when
   * the cadence declined) purely so tests can await it — the poll loop drops it.
   */
  refreshIfDue(): Promise<void> | undefined {
    if (!this.connected || this.inFlight) return undefined;
    if (this.attemptedAtMs !== null && this.now() - this.attemptedAtMs < this.refreshIntervalMs) {
      return undefined;
    }
    return this.refresh();
  }

  /**
   * Re-reads the warehouse now, regardless of the cadence. Awaited by the
   * lifecycle on start (so the board has real balances on the first render) and
   * by tests; concurrent callers share the single in-flight call.
   */
  async refresh(): Promise<void> {
    if (!this.connected) return;
    if (this.inFlight) return this.inFlight;
    const run = this.load().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async load(): Promise<void> {
    this.attemptedAtMs = this.now();
    try {
      // Both reads in parallel — they are independent GETs against the same
      // service, and the board needs them together.
      const [summary, reels] = await Promise.all([
        this.inventory!.fetchStockSummary(),
        this.inventory!.fetchLoadedReels()
      ]);
      // A disabled client answers null on both; nothing to record.
      if (!summary && !reels) return;

      this.state = {
        fetchedAt: new Date(this.attemptedAtMs).toISOString(),
        positions: summary?.positions ?? [],
        reels: reels ?? [],
        totalG: summary?.totalG ?? 0,
        reelsInUse: summary?.reelsInUse ?? 0
      };
      this.fetchedAtMs = this.attemptedAtMs;
      this.error = null;
      if (this.outageLogged) {
        this.outageLogged = false;
        this.logger.info?.(
          { positions: this.state.positions.length, reels: this.state.reels.length },
          "filament warehouse readable again"
        );
      }
    } catch (error) {
      // Keep the previous balances — they are the last thing that was true —
      // and record WHY they stopped refreshing. Logged once per outage so a
      // fulfillment that stays down does not flood the log every poll.
      this.error = error instanceof FulfillmentError ? error.message : String(error);
      if (!this.outageLogged) {
        this.outageLogged = true;
        this.logger.warn?.(
          { reason: this.error, hadData: this.fetchedAtMs !== null },
          "filament warehouse read failed — the board will show the last known balances as stale"
        );
      }
    }
  }

  /** The current view of the warehouse, for the dashboard read model. */
  snapshot(): FilamentStockView {
    const connected = this.connected;
    if (!connected) {
      return { ...EMPTY, connected: false, ok: false, pending: false, stale: false, error: null };
    }
    const pending = this.fetchedAtMs === null && this.error === null;
    return {
      ...this.state,
      connected: true,
      ok: this.error === null && this.fetchedAtMs !== null,
      pending,
      // Nothing read yet is not "stale data" — there is no data to age. Staleness
      // is a claim about an answer we HAVE, so it stays false while pending.
      stale: pending ? false : this.fetchedAtMs === null || this.now() - this.fetchedAtMs > this.staleAfterMs,
      error: this.error
    };
  }
}
