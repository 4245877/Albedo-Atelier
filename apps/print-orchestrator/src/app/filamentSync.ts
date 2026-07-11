import type { PrinterConfig } from "../infra/printers/config";
import type { PrinterLiveStatus } from "../infra/printers/status";
import { FulfillmentError } from "../infra/fulfillment/inventoryClient";
import type { StoreLogger } from "../shared/logger";

/**
 * The slice of the fulfillment inventory client the sync needs: report the reel
 * a printer has loaded so fulfillment can bind it to a stock position for
 * auto-deduction. Structural, so the consumer stays decoupled and testable.
 */
export interface InventorySyncClient {
  readonly enabled: boolean;
  syncLoadedFilament(input: SyncPayload): Promise<{ resolved: boolean } | null>;
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

/**
 * Keeps fulfillment's per-printer loaded-reel bindings in step with what the
 * devices report, so filament auto-deduction on completion always has a target
 * without any manual dashboard entry. Owns only the side effects — the network
 * dispatch and its de-duplication — alongside the pure {@link buildSyncItems}.
 *
 * Called once per printer per poll. To avoid hammering fulfillment every tick it
 * posts a slot only when its loaded filament *changes* (by {@link signature});
 * the mark is set only on a completed call, so a failed sync (fulfillment
 * down) is naturally retried on the next poll. Never throws into the poll loop:
 * a disabled client is a no-op and every failure is swallowed after a log.
 */
export class FilamentSync {
  private logger: StoreLogger = {};
  /** Last signature successfully synced per slot key; the de-dup anchor. */
  private synced = new Map<string, string>();
  /** Slot keys with an in-flight call, so overlapping polls don't double-send. */
  private inFlight = new Set<string>();

  constructor(
    /** Fulfillment stock client; when absent/disabled, sync is a no-op. */
    private readonly inventory: InventorySyncClient | undefined
  ) {}

  /** Wires the store logger in once it is available (after config load). */
  useLogger(logger: StoreLogger): void {
    this.logger = logger;
  }

  /**
   * Fire-and-forget reconciliation of one printer's loaded reels with
   * fulfillment. A no-op when the client is disabled or the device reports no
   * loaded filament; otherwise it posts each slot whose filament changed since
   * the last successful sync.
   */
  syncPrinter(printer: PrinterConfig, status: PrinterLiveStatus): void {
    if (!this.inventory?.enabled) return;

    for (const item of buildSyncItems(printer, status)) {
      const key = slotKey(printer.id, item.amsTray);
      const sig = signature(item);
      if (this.synced.get(key) === sig || this.inFlight.has(key)) continue;
      void this.deliver(printer.id, key, sig, item);
    }
  }

  private async deliver(
    printerId: string,
    key: string,
    sig: string,
    item: SyncItem
  ): Promise<void> {
    this.inFlight.add(key);
    try {
      const result = await this.inventory!.syncLoadedFilament({
        printerId,
        amsTray: item.amsTray,
        material: item.material,
        color: item.color,
      });
      // Mark synced whatever the resolution: an unmatched hint (resolved:false)
      // is a stable state — re-posting it every poll would only add noise. A new
      // reel changes the signature and syncs again; stock added later is picked
      // up by the completion consume, which resolves against live stock.
      this.synced.set(key, sig);
      if (result && result.resolved === false) {
        this.logger.warn?.(
          { printer: printerId, material: item.material, amsTray: item.amsTray },
          "loaded filament matched no fulfillment stock (bind skipped)"
        );
      }
    } catch (error) {
      // Leave the signature unmarked so the next poll retries. Rejected vs
      // unreachable does not matter here — both simply retry on the next tick.
      const message = error instanceof FulfillmentError ? error.message : String(error);
      this.logger.warn?.({ printer: printerId, reason: message }, "filament sync failed");
    } finally {
      this.inFlight.delete(key);
    }
  }
}
