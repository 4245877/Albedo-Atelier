import type { PrinterConfig } from "../infra/printers/config";
import type { PrinterLiveStatus } from "../infra/printers/status";
import { bambuMeasurableTrayCount, bambuTrayUsage } from "../infra/printers/status/bambuUsage";
import type { AmsTraySnapshot } from "../infra/printers/status/types";
import type { StoreLogger } from "../shared/logger";
import { localDateKey } from "../shared/time";
import type { EventFeed } from "./eventFeed";

/**
 * The slice of the fulfillment inventory client the farm needs: deduct filament
 * for a completed print. Structural, so the consumer stays decoupled and testable.
 */
export interface InventoryConsumer {
  readonly enabled: boolean;
  consume(input: {
    printerId: string;
    lengthMm?: number;
    grams?: number;
    amsTray?: number;
    material?: string;
    color?: string;
    printJobId: string;
    idempotencyKey: string;
    note?: string;
  }): Promise<unknown>;
}

/** One filament deduction derived from a completed print. */
export type ConsumeItem =
  | { kind: "length"; lengthMm: number }
  | { kind: "grams"; grams: number; amsTray: number; material: string | null; color: string | null };

/** What the deduction needs to know about the completed run (see PrintRun in the poller). */
export interface CompletedRun {
  /** Stable identity minted at print start; the idempotency anchor. */
  printId: string;
  /** AMS tray `remain` snapshot at print start (Bambu), diffed at completion. */
  amsStart: AmsTraySnapshot[] | null;
}

/**
 * Turns one completed print into zero or more filament deductions. Moonraker
 * reports a single extruded length for the loaded reel; Bambu attributes grams
 * per AMS tray from the drop in each tray's `remain` between the start snapshot
 * and completion ({@link bambuTrayUsage}), so multi-slot prints deduct from
 * every slot they used. An empty list means the device gave nothing to deduct.
 * Pure — no HTTP; exported for unit testing.
 */
export function buildConsumeItems(
  printer: PrinterConfig,
  prev: PrinterLiveStatus,
  next: PrinterLiveStatus,
  amsStart: AmsTraySnapshot[] | null
): ConsumeItem[] {
  if (printer.protocol === "bambu") {
    const endTrays = next.amsTrays ?? prev.amsTrays;
    return bambuTrayUsage(amsStart, endTrays).map((usage) => ({
      kind: "grams",
      grams: usage.grams,
      amsTray: usage.tray,
      material: usage.material,
      color: usage.color
    }));
  }

  const usedMm = next.filamentUsedMm ?? prev.filamentUsedMm;
  return usedMm && usedMm > 0 ? [{ kind: "length", lengthMm: usedMm }] : [];
}

/**
 * Posts a completed print's filament consumption to fulfillment. Separated from
 * the pure {@link buildConsumeItems}: this class owns only the side effects —
 * the network dispatch, the soft-warning feed entries and the logging.
 */
export class FilamentConsumption {
  private logger: StoreLogger = {};

  constructor(
    /** Fulfillment stock client; when absent/disabled, completion deduction is skipped. */
    private readonly inventory: InventoryConsumer | undefined,
    private readonly events: EventFeed
  ) {}

  /** Wires the store logger in once it is available (after config load). */
  useLogger(logger: StoreLogger): void {
    this.logger = logger;
  }

  /**
   * Fire-and-forget filament deduction for a completed print. Never throws into
   * the poll loop: a missing/disabled client is a no-op, and any failure
   * (fulfillment down, no loaded filament, not enough stock) is logged and
   * surfaced as a soft warning. Idempotent per print — and per AMS tray — via a
   * stable `idempotencyKey`, so a re-observed completion or a retry never
   * double-deducts.
   *
   * When the print completed but the device gave no usable consumption data —
   * Bambu with uncalibrated AMS trays (`remain = -1`) or a missing start
   * snapshot — nothing is deducted (we never invent grams). For Bambu that gap
   * is surfaced as one soft warning so the operator knows stock was untouched;
   * Moonraker without a reported length stays silent, exactly as before.
   */
  consumeForPrint(
    printer: PrinterConfig,
    prev: PrinterLiveStatus,
    next: PrinterLiveStatus,
    run: CompletedRun | undefined,
    job: string | null
  ): void {
    if (!this.inventory?.enabled) return;

    const items = buildConsumeItems(printer, prev, next, run?.amsStart ?? null);
    if (items.length === 0) {
      // Warn only when the device gave us nothing to measure (uncalibrated trays
      // or a missing start snapshot) — not when it measured a print too small to
      // move the 1 % `remain`, which is a legitimate ~0 g no-op.
      const endTrays = next.amsTrays ?? prev.amsTrays;
      if (printer.protocol === "bambu" && bambuMeasurableTrayCount(run?.amsStart ?? null, endTrays) === 0) {
        this.events.push(
          "⚠",
          `<b>${printer.name}</b>: склад — нет данных о расходе филамента${job ? ` для «${job}»` : ""}, списание пропущено`,
          "err"
        );
      }
      return;
    }

    const printJobId = run?.printId ?? `${printer.id}:${localDateKey()}:${job ?? "?"}`;
    for (const item of items) {
      this.dispatchConsumeItem(printer, item, printJobId, job);
    }
  }

  private dispatchConsumeItem(
    printer: PrinterConfig,
    item: ConsumeItem,
    printJobId: string,
    job: string | null
  ): void {
    const note = job ? `Печать «${job}»` : undefined;
    const input =
      item.kind === "length"
        ? {
            printerId: printer.id,
            lengthMm: item.lengthMm,
            printJobId,
            idempotencyKey: `${printer.id}:${printJobId}`,
            note
          }
        : {
            printerId: printer.id,
            grams: item.grams,
            amsTray: item.amsTray,
            material: item.material ?? undefined,
            color: item.color ?? undefined,
            printJobId,
            idempotencyKey: `${printer.id}:${printJobId}:t${item.amsTray}`,
            note
          };

    void this.inventory!.consume(input).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn?.({ err: error, printer: printer.id }, "filament consume failed");
      this.events.push("⚠", `<b>${printer.name}</b>: склад — ${message}`, "err");
    });
  }
}
