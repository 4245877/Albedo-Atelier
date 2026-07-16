import type { PrinterConfig } from "../infra/printers/config";
import type { PrinterLiveStatus } from "../infra/printers/status";
import { bambuMeasurableTrayCount, bambuTrayUsage } from "../infra/printers/status/bambuUsage";
import type { AmsTraySnapshot } from "../infra/printers/status/types";
import { FulfillmentError } from "../infra/fulfillment/inventoryClient";
import type { StoreLogger } from "../shared/logger";
import type { EventFeed } from "./eventFeed";

/**
 * The slice of the fulfillment inventory client the farm needs: deduct filament
 * for a completed print. Structural, so the consumer stays decoupled and testable.
 */
export interface InventoryConsumer {
  readonly enabled: boolean;
  consume(input: ConsumePayload): Promise<unknown>;
}

/** The consume request payload as posted to fulfillment (see inventoryClient). */
export type ConsumePayload = {
  printerId: string;
  lengthMm?: number;
  grams?: number;
  amsTray?: number;
  material?: string;
  color?: string;
  printJobId: string;
  idempotencyKey: string;
  note?: string;
};

/**
 * One deduction that could not be delivered to fulfillment (unreachable/5xx)
 * and is awaiting redelivery. The payload is retried verbatim: its
 * `idempotencyKey` makes redelivery safe even if the original request did land.
 * Persisted with the farm state so a restart cannot lose an owed deduction.
 */
export type PendingConsume = {
  input: ConsumePayload;
  /** Printer display name for operator-facing feed messages. */
  printerName: string;
  /** Failed delivery attempts so far (>= 1 once queued). */
  attempts: number;
  /** Wall-clock (ms) before which no redelivery is attempted. */
  nextAttemptAtMs: number;
  /** Wall-clock (ms) of the first failed attempt; anchors the give-up age. */
  firstFailedAtMs: number;
};

/** First retry delay; doubles per failed attempt up to {@link RETRY_MAX_DELAY_MS}. */
const RETRY_BASE_DELAY_MS = 60 * 1000;
const RETRY_MAX_DELAY_MS = 30 * 60 * 1000;
/** After this long without a successful delivery the deduction is dropped (loudly). */
const RETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard cap on the queue; beyond it the oldest entry is dropped (logged). */
const MAX_PENDING = 200;

function retryDelayMs(attempts: number): number {
  const exponent = Math.min(attempts - 1, 30); // avoid 2^huge overflow
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** exponent, RETRY_MAX_DELAY_MS);
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
 * the network dispatch, the retry queue for deliveries fulfillment never
 * received, the soft-warning feed entries and the logging.
 *
 * Failure handling follows the {@link FulfillmentError} taxonomy:
 *  - `rejected` (fulfillment processed and refused — no loaded reel, not enough
 *    stock): warned and dropped. Auto-retrying would re-fail identically, and
 *    once an operator corrects the stock by hand a late auto-retry could
 *    double-deduct.
 *  - `unreachable` (network/timeout/5xx — delivery unknown): queued in
 *    {@link PendingConsume} and redelivered with exponential backoff. The
 *    payload's `idempotencyKey` makes redelivery safe if the original did land.
 *    The queue is persisted via the injected `persist` callback, so restarts
 *    cannot lose an owed deduction.
 */
export class FilamentConsumption {
  private logger: StoreLogger = {};
  private pending: PendingConsume[];
  private retrying = false;

  constructor(
    /** Fulfillment stock client; when absent/disabled, completion deduction is skipped. */
    private readonly inventory: InventoryConsumer | undefined,
    private readonly events: EventFeed,
    /** Schedules a state save; wired to the farm's StateStore. */
    private readonly persist: () => void = () => {},
    initialPending: PendingConsume[] = []
  ) {
    this.pending = [...initialPending];
  }

  /** Wires the store logger in once it is available (after config load). */
  useLogger(logger: StoreLogger): void {
    this.logger = logger;
  }

  /** The retry queue for persistence (a fresh array; entries are not copied). */
  serialize(): PendingConsume[] {
    return [...this.pending];
  }

  /** Deductions still awaiting delivery (for tests/observability). */
  get pendingCount(): number {
    return this.pending.length;
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

    // A completed print with no tracked run — one that was already printing when
    // this process started, or was revived across a restart — has no reliable
    // idempotency anchor. Its device-reported total (Moonraker length) spans the
    // whole job, and a synthetic `printer:date:file` key would collide for two
    // untracked prints of the same file on the same day and under-deduct. Matching
    // the documented restart behaviour (README “Restart cost”: such prints skip
    // auto-deduction), skip it and tell the operator to deduct by hand rather
    // than guess. A tracked run always carries a printId, so the deduction below
    // stays idempotent.
    if (!run) {
      this.events.push(
        "⚠",
        `<b>${printer.name}</b>: склад — печать${job ? ` «${job}»` : ""} не отслеживалась (перезапуск во время печати), автосписание пропущено — спишите вручную`,
        "err"
      );
      return;
    }

    const printJobId = run.printId;
    const note = job ? `Печать «${job}»` : undefined;
    for (const item of items) {
      const input: ConsumePayload =
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
      void this.deliver(input, printer.name);
    }
  }

  /**
   * Redelivers due queue entries (nextAttemptAtMs in the past). Invoked from
   * the poll loop every cycle; self-guarded so overlapping invocations and slow
   * deliveries (each bounded by the client timeout) never stack. Sequential on
   * purpose: when fulfillment is down every attempt fails the same way, so
   * parallel calls would only multiply timeouts.
   */
  async retryPending(): Promise<void> {
    if (this.retrying || this.pending.length === 0 || !this.inventory?.enabled) return;
    this.retrying = true;
    try {
      const now = Date.now();
      const due = this.pending.filter((entry) => entry.nextAttemptAtMs <= now);
      for (const entry of due) {
        await this.retryOne(entry);
      }
    } finally {
      this.retrying = false;
    }
  }

  private async retryOne(entry: PendingConsume): Promise<void> {
    const label = entry.input.note ?? entry.input.printJobId;
    try {
      await this.inventory!.consume(entry.input);
      this.remove(entry);
      this.events.push(
        "✔",
        `<b>${entry.printerName}</b>: склад — отложенное списание выполнено (${label})`,
        "ok"
      );
    } catch (error) {
      if (error instanceof FulfillmentError && error.kind === "rejected") {
        // Fulfillment finally processed it and said no — same terminal outcome
        // as an immediate rejection: tell the operator, stop retrying.
        this.remove(entry);
        this.events.push("⚠", `<b>${entry.printerName}</b>: склад — ${error.message}`, "err");
        return;
      }

      entry.attempts += 1;
      entry.nextAttemptAtMs = Date.now() + retryDelayMs(entry.attempts);
      if (Date.now() - entry.firstFailedAtMs > RETRY_MAX_AGE_MS) {
        this.remove(entry);
        this.events.push(
          "⚠",
          `<b>${entry.printerName}</b>: склад — не удалось списать за 7 дней, отложенное списание отброшено (${label})`,
          "err"
        );
        return;
      }
      this.persist();
      this.logger.warn?.(
        { printer: entry.input.printerId, attempts: entry.attempts },
        "filament consume retry failed"
      );
    }
  }

  private remove(entry: PendingConsume): void {
    this.pending = this.pending.filter((item) => item !== entry);
    this.persist();
  }

  /** First delivery of one deduction; failures route to the queue or the feed. */
  private async deliver(input: ConsumePayload, printerName: string): Promise<void> {
    try {
      await this.inventory!.consume(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn?.({ err: error, printer: input.printerId }, "filament consume failed");

      if (error instanceof FulfillmentError && error.kind === "unreachable") {
        this.enqueue(input, printerName, message);
        return;
      }
      this.events.push("⚠", `<b>${printerName}</b>: склад — ${message}`, "err");
    }
  }

  private enqueue(input: ConsumePayload, printerName: string, reason: string): void {
    if (this.pending.length >= MAX_PENDING) {
      const dropped = this.pending.shift();
      this.logger.warn?.(
        { droppedKey: dropped?.input.idempotencyKey },
        "pending consume queue full — dropped the oldest entry"
      );
    }
    const now = Date.now();
    this.pending.push({
      input,
      printerName,
      attempts: 1,
      nextAttemptAtMs: now + retryDelayMs(1),
      firstFailedAtMs: now
    });
    this.persist();
    this.events.push(
      "⚠",
      `<b>${printerName}</b>: склад — ${reason}; списание будет повторено автоматически`,
      "err"
    );
  }
}
