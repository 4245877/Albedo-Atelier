import type { PrinterConfig } from "../infra/printers/config";
import type { PrinterLiveStatus } from "../infra/printers/status";
import { FulfillmentError } from "../infra/fulfillment/inventoryClient";
import type { SyncLoadedFilamentResult } from "../infra/fulfillment/inventoryClient";
import { env } from "../shared/env";
import type { StoreLogger } from "../shared/logger";
import type { EventFeed } from "./eventFeed";

/**
 * The slice of the fulfillment inventory client the sync needs: report the reel
 * a printer has loaded so fulfillment can bind it to a stock position for
 * auto-deduction. Structural, so the consumer stays decoupled and testable.
 */
export interface InventorySyncClient {
  readonly enabled: boolean;
  syncLoadedFilament(input: SyncPayload): Promise<SyncLoadedFilamentResult | null>;
}

/** One loaded-reel sync request as posted to fulfillment (see inventoryClient). */
export type SyncPayload = {
  printerId: string;
  amsTray?: number;
  material: string;
  color?: string;
};

/** One reel a printer reports loaded, derived from live status. */
export type SyncItem = {
  /** AMS slot for per-slot binding (Bambu); omit for the single printer-level reel. */
  amsTray?: number;
  material: string;
  color?: string;
};

/**
 * The reels a printer currently has loaded, straight from live telemetry —
 * one per AMS slot on Bambu (so multi-slot bindings resolve per tray), or the
 * single active reel elsewhere (Moonraker/K2 sliced metadata). A slot with no
 * reported material is skipped: we bind only what the device actually names, and
 * never invent a colour/material. Pure — exported for unit testing.
 */
export function buildSyncItems(
  printer: PrinterConfig,
  status: PrinterLiveStatus
): SyncItem[] {
  if (printer.protocol === "bambu") {
    return (status.amsTrays ?? [])
      .filter((tray) => tray.material)
      .map((tray) => ({
        amsTray: tray.tray,
        material: tray.material as string,
        color: tray.color ?? undefined,
      }));
  }

  const active = status.activeFilament;
  if (!active?.material) return [];
  return [{ material: active.material, color: active.color ?? undefined }];
}

/** Stable key for one reel binding (a printer's slot, or its single reel). */
function slotKey(printerId: string, amsTray: number | undefined): string {
  return `${printerId}:${amsTray ?? "main"}`;
}

/** Signature of a reel's loaded filament; a change is what triggers a re-sync. */
function signature(item: SyncItem): string {
  return `${item.material}|${item.color ?? ""}`;
}

/** Operator-facing label of one stock position from the sync response. */
function stockLabel(
  stock: { material?: string; color?: string; colorName?: string } | null | undefined
): string {
  if (!stock) return "—";
  const color = stock.colorName || stock.color || "";
  return [stock.material, color].filter(Boolean).join(" ") || "—";
}

/** Operator-facing label of the slot a reel sits in. */
function slotLabel(amsTray: number | undefined): string {
  return amsTray === undefined ? "катушка" : `AMS-слот ${amsTray}`;
}

/**
 * Keeps fulfillment's per-printer loaded-reel bindings in step with what the
 * devices report, so filament auto-deduction on completion always has a target
 * without any manual dashboard entry. Owns only the side effects — the network
 * dispatch and its de-duplication — alongside the pure {@link buildSyncItems}.
 *
 * Called once per printer per poll. To avoid hammering fulfillment every tick it
 * posts a slot only when its loaded filament *changes* (by {@link signature});
 * the mark is set only on a `resolved: true` answer, so a failed sync
 * (fulfillment down) retries on the next poll and an UNMATCHED hint
 * (`resolved: false` — the reel is not on the shelf yet) retries after
 * {@link retryUnresolvedMs}: stock added later by the operator is picked up
 * without a new reel load, but fulfillment is not re-posted every cycle. A
 * reel/slot change resets both states via the signature. Re-posting the same
 * hint is idempotent on the fulfillment side (an upsert), so retries are safe.
 * Never throws into the poll loop: a disabled client is a no-op and every
 * failure is swallowed after a log.
 *
 * Operator-facing side effects (all deduplicated, all optional — they need the
 * event feed to be wired in):
 *  - a binding that actually CHANGED stock (fulfillment reports `changed`)
 *    lands in the event feed once — the reel-change operational event;
 *  - a material-only match with a provably different colour
 *    (`colorMismatch: true`) lands as one warning per reel×stock combination;
 *  - a 401/403 (auth misconfiguration) lands as one warning per outage.
 */
export class FilamentSync {
  private logger: StoreLogger = {};
  /** Last signature successfully synced (resolved) per slot key; the de-dup anchor. */
  private synced = new Map<string, string>();
  /**
   * Slots whose last sync answered `resolved: false` (or was refused as an auth
   * error): the signature it happened for plus the earliest wall-clock for the
   * next retry. Kept SEPARATE from {@link synced} — an unresolved sync is not a
   * success and must retry once the delay passes or the reel changes.
   */
  private unresolved = new Map<string, { sig: string; nextRetryAtMs: number }>();
  /** Slot keys with an in-flight call, so overlapping polls don't double-send. */
  private inFlight = new Set<string>();
  /**
   * Printer ids currently in a logged "reports no loaded filament" dry spell.
   * The de-dup anchor for the no-data notice so an idle device (a K2 with no
   * active reel, an empty AMS) is flagged once, not on every poll; cleared the
   * moment the device names a reel again, so a later dry spell is flagged afresh.
   */
  private noData = new Set<string>();
  /** Per-slot warn signature of the last colour-mismatch warning (dedup anchor). */
  private colorWarned = new Map<string, string>();
  /** One auth-misconfiguration event per outage; reset by any successful call. */
  private authNotified = false;

  private readonly events: EventFeed | undefined;
  private readonly retryUnresolvedMs: number;
  private readonly now: () => number;

  constructor(
    /** Fulfillment stock client; when absent/disabled, sync is a no-op. */
    private readonly inventory: InventorySyncClient | undefined,
    options: {
      /** Operator event feed for reel-change / mismatch / auth notices. */
      events?: EventFeed;
      /** Delay before re-posting an unresolved hint; defaults to the env setting. */
      retryUnresolvedMs?: number;
      /** Clock, injectable for tests. */
      now?: () => number;
    } = {}
  ) {
    this.events = options.events;
    this.retryUnresolvedMs = options.retryUnresolvedMs ?? env.filamentSyncRetryMs;
    this.now = options.now ?? Date.now;
  }

  /** Wires the store logger in once it is available (after config load). */
  useLogger(logger: StoreLogger): void {
    this.logger = logger;
  }

  /**
   * Fire-and-forget reconciliation of one printer's loaded reels with
   * fulfillment. A no-op when the client is disabled or the device reports no
   * loaded filament; otherwise it posts each slot whose filament changed since
   * the last successful sync — or whose earlier sync stayed unresolved and is
   * due for a retry.
   */
  syncPrinter(printer: PrinterConfig, status: PrinterLiveStatus): void {
    if (!this.inventory?.enabled) return;

    const items = buildSyncItems(printer, status);

    if (items.length === 0) {
      this.noteNoData(printer, status);
      return;
    }

    // The device is naming reels again — end any dry spell so the next one is
    // logged afresh rather than silently swallowed.
    this.noData.delete(printer.id);

    for (const item of items) {
      const key = slotKey(printer.id, item.amsTray);
      const sig = signature(item);
      if (this.synced.get(key) === sig || this.inFlight.has(key)) continue;

      const pending = this.unresolved.get(key);
      if (pending && pending.sig === sig && this.now() < pending.nextRetryAtMs) {
        continue; // unresolved, but the retry delay has not passed yet
      }
      void this.deliver(printer, key, sig, item);
    }
  }

  /**
   * Records that a printer named no loaded filament this poll. Offline is its
   * own signal (surfaced as a connection loss by the poller), so only an ONLINE
   * printer that simply isn't transmitting a reel is worth flagging — and only
   * once per dry spell (see {@link noData}), so a legitimately idle K2 with no
   * active reel does not log on every tick. Nothing is synced either way: a
   * missing hint must never overwrite a good binding with a blank.
   */
  private noteNoData(printer: PrinterConfig, status: PrinterLiveStatus): void {
    if (!status.online || this.noData.has(printer.id)) return;
    this.noData.add(printer.id);
    this.logger.info?.(
      { printer: printer.id, protocol: printer.protocol, status: status.status },
      "printer reported no loaded filament — nothing to sync"
    );
  }

  private async deliver(
    printer: PrinterConfig,
    key: string,
    sig: string,
    item: SyncItem
  ): Promise<void> {
    this.inFlight.add(key);
    try {
      const result = await this.inventory!.syncLoadedFilament({
        printerId: printer.id,
        amsTray: item.amsTray,
        material: item.material,
        color: item.color,
      });
      this.authNotified = false;

      if (!result || result.resolved) {
        // Bound (or the feature answered nothing to bind against — disabled).
        this.synced.set(key, sig);
        this.unresolved.delete(key);
        if (result) this.announceResolved(printer, key, sig, item, result);
        return;
      }

      // resolved:false is NOT a success: the reel matched no stock yet. Keep it
      // out of `synced` and schedule a delayed retry — stock the operator adds
      // later is then bound without waiting for a reel change. Logged once per
      // signature, not on every retry.
      const firstMiss = !this.unresolved.get(key) || this.unresolved.get(key)!.sig !== sig;
      this.unresolved.set(key, { sig, nextRetryAtMs: this.now() + this.retryUnresolvedMs });
      if (firstMiss) {
        this.logger.warn?.(
          {
            printer: printer.id,
            material: item.material,
            amsTray: item.amsTray,
            retryInMs: this.retryUnresolvedMs,
          },
          "loaded filament matched no fulfillment stock — bind pending, will retry"
        );
      }
    } catch (error) {
      if (error instanceof FulfillmentError && error.kind === "auth") {
        // Configuration error, not a transient one: retry on the slow cadence
        // (a poll-rate retry would hammer a misconfigured endpoint) and tell
        // the operator once per outage.
        this.unresolved.set(key, { sig, nextRetryAtMs: this.now() + this.retryUnresolvedMs });
        this.logger.warn?.({ printer: printer.id, reason: error.message }, "filament sync auth failed");
        if (!this.authNotified) {
          this.authNotified = true;
          this.events?.push("⚠", `склад — ${error.message}`, "err");
        }
        return;
      }
      // Leave the signature unmarked so the next poll retries. Rejected vs
      // unreachable does not matter here — both simply retry on the next tick.
      const message = error instanceof FulfillmentError ? error.message : String(error);
      this.logger.warn?.({ printer: printer.id, reason: message }, "filament sync failed");
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Operator-facing notices for a successful bind, driven by the additive
   * diagnostics newer fulfillment builds return (older builds return none —
   * everything here degrades to a no-op):
   *  - `changed` → the reel-change operational event, exactly once per actual
   *    binding change (an idempotent re-sync reports `changed: false`);
   *  - `colorMismatch` → one warning per reel×stock combination that the match
   *    was material-only and the colours provably differ.
   */
  private announceResolved(
    printer: PrinterConfig,
    key: string,
    sig: string,
    item: SyncItem,
    result: SyncLoadedFilamentResult
  ): void {
    const slot = slotLabel(item.amsTray);

    if (result.changed === true) {
      this.events?.push(
        "⟳",
        `<b>${printer.name}</b>: ${slot} — привязана позиция ${stockLabel(result.stock)}` +
          (result.previousStock ? ` (была ${stockLabel(result.previousStock)})` : ""),
        "info"
      );
    }

    if (result.colorMismatch === true) {
      const warnSig = `${sig}|${result.stock?.id ?? ""}`;
      if (this.colorWarned.get(key) !== warnSig) {
        this.colorWarned.set(key, warnSig);
        this.events?.push(
          "⚠",
          `<b>${printer.name}</b>: ${slot} — цвет катушки (${item.material} ${item.color ?? "?"}) ` +
            `не совпадает с позицией склада ${stockLabel(result.stock)}; ` +
            `сопоставлено только по материалу — проверьте привязку`,
          "err"
        );
      }
    } else {
      this.colorWarned.delete(key);
    }
  }
}
