import type { PrinterConfig } from "../infra/printers/config";
import type { PrinterLiveStatus } from "../infra/printers/status";
import { bambuMeasurableTrayCount, bambuTrayUsage } from "../infra/printers/status/bambuUsage";
import type { AmsTraySnapshot } from "../infra/printers/status/types";
import { FulfillmentError } from "../infra/fulfillment/inventoryClient";
import { env } from "../shared/env";
import type { StoreLogger } from "../shared/logger";
import type { EventFeed } from "./eventFeed";
import { classifyPrintOutcome } from "./printOutcome";

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
 * One deduction that could not be delivered to fulfillment (unreachable/5xx/auth)
 * and is awaiting redelivery. The payload is retried verbatim: its
 * `idempotencyKey` makes redelivery safe even if the original request did land.
 * Persisted with the farm state so a restart cannot lose an owed deduction.
 * Deliberately payload-only — no HTTP headers, no tokens: authorization is
 * attached by the client at send time, never stored here.
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

/**
 * Sub-gram consumption carried per printer×slot until it reaches the minimum
 * deductible unit (see MIN_CONSUME_*). Persisted with the farm state so tiny
 * prints do not systematically evaporate across restarts. Keyed
 * `printerId:main` / `printerId:t<slot>`.
 */
export type FilamentCarry = Record<string, { grams?: number; lengthMm?: number }>;

/** Why a queued deduction was finally dropped (metric + operator event reason). */
export type PendingDropReason = "overflow" | "expired" | "rejected";

/** First retry delay; doubles per failed attempt up to {@link RETRY_MAX_DELAY_MS}. */
const RETRY_BASE_DELAY_MS = 60 * 1000;
const RETRY_MAX_DELAY_MS = 30 * 60 * 1000;

/**
 * Minimum deductible quantities. Fulfillment tracks stock in whole grams and
 * refuses a movement that would round to 0 g, so anything smaller is carried
 * (per printer×slot) until the sum crosses the unit:
 *  - grams (Bambu AMS remain-delta): 1 g;
 *  - length (Moonraker `filament_used`): 350 mm ≈ 0.9–1.1 g across the density
 *    table — the smallest length guaranteed to round to ≥ 1 g for every
 *    supported material.
 */
export const MIN_CONSUME_GRAMS = 1;
export const MIN_CONSUME_LENGTH_MM = 350;

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
 * received, the sub-gram carry accumulator, the soft-warning feed entries and
 * the logging.
 *
 * Failure handling follows the {@link FulfillmentError} taxonomy:
 *  - `rejected` (fulfillment processed and refused — no loaded reel, not enough
 *    stock): warned and dropped (metric reason `rejected`). Auto-retrying would
 *    re-fail identically, and once an operator corrects the stock by hand a
 *    late auto-retry could double-deduct.
 *  - `auth` (401/403 — the service token is missing/rotated): a CONFIGURATION
 *    error, not a transient one. The deduction was provably NOT processed, so
 *    it is queued and retried with the same backoff; the operator gets ONE
 *    prominent feed event per outage (no duplicate spam), reset by the first
 *    successful delivery.
 *  - `unreachable` (network/timeout/5xx — delivery unknown): queued in
 *    {@link PendingConsume} and redelivered with exponential backoff. The
 *    payload's `idempotencyKey` makes redelivery safe if the original did land.
 *    The queue is persisted via the injected `persist` callback, so restarts
 *    cannot lose an owed deduction.
 *
 * Queue bounds are configurable (env `FILAMENT_RETRY_QUEUE_MAX`, default 200;
 * `FILAMENT_RETRY_MAX_AGE_DAYS`, default 7). Every final drop — overflow,
 * expiry, rejection — is logged with its reason, surfaced as an operator event
 * and counted in {@link metrics}. The queue file itself is written by the
 * StateStore (temp file + atomic rename; a corrupt file is backed up, never
 * silently reset).
 */
export class FilamentConsumption {
  private logger: StoreLogger = {};
  private pending: PendingConsume[];
  private retrying = false;
  private carry: Map<string, { grams: number; lengthMm: number }>;
  private dropped: Record<PendingDropReason, number> = {
    overflow: 0,
    expired: 0,
    rejected: 0
  };
  /** One auth-misconfiguration event per outage; reset by any successful delivery. */
  private authNotified = false;

  private readonly maxPending: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(
    /** Fulfillment stock client; when absent/disabled, completion deduction is skipped. */
    private readonly inventory: InventoryConsumer | undefined,
    private readonly events: EventFeed,
    /** Schedules a state save; wired to the farm's StateStore. */
    private readonly persist: () => void = () => {},
    initialPending: PendingConsume[] = [],
    options: {
      initialCarry?: FilamentCarry;
      /** Queue cap; defaults to env FILAMENT_RETRY_QUEUE_MAX. */
      maxPending?: number;
      /** Give-up age; defaults to env FILAMENT_RETRY_MAX_AGE_DAYS. */
      maxAgeMs?: number;
      /** Clock, injectable for tests. */
      now?: () => number;
    } = {}
  ) {
    this.pending = [...initialPending];
    this.carry = new Map(
      Object.entries(options.initialCarry ?? {}).map(([key, value]) => [
        key,
        {
          grams: typeof value.grams === "number" && value.grams > 0 ? value.grams : 0,
          lengthMm: typeof value.lengthMm === "number" && value.lengthMm > 0 ? value.lengthMm : 0
        }
      ])
    );
    this.maxPending = options.maxPending ?? env.filamentRetryQueueMax;
    this.maxAgeMs = options.maxAgeMs ?? env.filamentRetryMaxAgeDays * 24 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /** Wires the store logger in once it is available (after config load). */
  useLogger(logger: StoreLogger): void {
    this.logger = logger;
  }

  /** Whether the fulfillment client is configured (deduction can happen at all). */
  get enabled(): boolean {
    return Boolean(this.inventory?.enabled);
  }

  /** The retry queue for persistence (a fresh array; entries are not copied). */
  serialize(): PendingConsume[] {
    return [...this.pending];
  }

  /** The sub-gram carry for persistence (only non-zero amounts are written). */
  serializeCarry(): FilamentCarry {
    const out: FilamentCarry = {};
    for (const [key, value] of this.carry) {
      const entry: { grams?: number; lengthMm?: number } = {};
      if (value.grams > 0) entry.grams = value.grams;
      if (value.lengthMm > 0) entry.lengthMm = value.lengthMm;
      if (entry.grams !== undefined || entry.lengthMm !== undefined) out[key] = entry;
    }
    return out;
  }

  /** Deductions still awaiting delivery (for tests/observability). */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Delivery-queue observability: backlog size + final drops by reason. */
  metrics(): { pending: number; dropped: Record<PendingDropReason, number> } {
    return { pending: this.pending.length, dropped: { ...this.dropped } };
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

    this.dispatchItems(printer, items, run.printId, job);
  }

  /**
   * Deduction attempt for a print that ENDED while the connection was down (the
   * printer reconnected already idle). Returns how it went so the poller can
   * surface the right operator event:
   *  - `"deducted"` — real consumption data survived the gap and was posted
   *    with the run's normal idempotency keys (so a duplicate observation can
   *    never double-deduct);
   *  - `"nothing"`  — the data reliably says ~0 was consumed (measured trays,
   *    no drop) — nothing owed;
   *  - `"unknown"`  — consumption cannot be recovered honestly (uncalibrated
   *    trays, a reset length counter, an ambiguous end state) — the caller must
   *    tell the operator to check and deduct by hand.
   *
   * Reliability rules per source:
   *  - Bambu: tray `remain` is absolute, so the start snapshot vs the CURRENT
   *    trays measures the whole print regardless of the offline gap.
   *  - Moonraker: `filament_used` survives until the next job starts, so the
   *    reported length is trusted only when the device's own end state confirms
   *    the job ended (complete/cancelled) — a rebooted Klipper reports a fresh
   *    counter and an idle state, which classifies as unknown.
   */
  consumeAfterReconnect(
    printer: PrinterConfig,
    next: PrinterLiveStatus,
    run: CompletedRun,
    job: string | null
  ): "deducted" | "nothing" | "unknown" {
    if (!this.inventory?.enabled) return "nothing";

    if (printer.protocol === "bambu") {
      if (bambuMeasurableTrayCount(run.amsStart, next.amsTrays) === 0) return "unknown";
      const items: ConsumeItem[] = bambuTrayUsage(run.amsStart, next.amsTrays).map((usage) => ({
        kind: "grams",
        grams: usage.grams,
        amsTray: usage.tray,
        material: usage.material,
        color: usage.color
      }));
      if (items.length === 0) return "nothing";
      this.dispatchItems(printer, items, run.printId, job);
      return "deducted";
    }

    const outcome = classifyPrintOutcome(next);
    const usedMm = next.filamentUsedMm;
    if (
      (outcome === "completed" || outcome === "cancelled") &&
      usedMm !== null &&
      usedMm > 0
    ) {
      this.dispatchItems(printer, [{ kind: "length", lengthMm: usedMm }], run.printId, job);
      return "deducted";
    }
    return "unknown";
  }

  /**
   * Builds the payloads for a run's consume items — applying the sub-gram carry
   * — and fires the deliveries. The idempotency key is only ever attached to a
   * payload that is actually sent; a below-threshold amount is carried without
   * touching the key, so the key stays free for the real deduction.
   */
  private dispatchItems(
    printer: PrinterConfig,
    items: ConsumeItem[],
    printJobId: string,
    job: string | null
  ): void {
    const note = job ? `Печать «${job}»` : undefined;
    for (const item of items) {
      const quantity = this.applyCarry(printer, item);
      if (!quantity) continue; // carried — below the minimum unit, nothing sent

      const input: ConsumePayload =
        item.kind === "length"
          ? {
              printerId: printer.id,
              lengthMm: quantity.lengthMm as number,
              printJobId,
              idempotencyKey: `${printer.id}:${printJobId}`,
              note
            }
          : {
              printerId: printer.id,
              grams: quantity.grams as number,
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

  /** Carry key: one accumulator per printer×slot (`main` = the single reel). */
  private carryKey(printerId: string, item: ConsumeItem): string {
    return item.kind === "grams" ? `${printerId}:t${item.amsTray}` : `${printerId}:main`;
  }

  /**
   * Folds the slot's carried remainder into this item and gates it on the
   * minimum unit. Below the threshold the total is stored back into the carry
   * (persisted) and nothing is sent; at/above it the carry is zeroed BEFORE the
   * delivery is attempted, so the carried amount rides inside the payload
   * exactly once — a queued redelivery retries the same payload and can never
   * re-add the carry.
   */
  private applyCarry(
    printer: PrinterConfig,
    item: ConsumeItem
  ): { grams?: number; lengthMm?: number } | null {
    const key = this.carryKey(printer.id, item);
    const carried = this.carry.get(key) ?? { grams: 0, lengthMm: 0 };

    if (item.kind === "grams") {
      const total = item.grams + carried.grams;
      if (total < MIN_CONSUME_GRAMS) {
        this.carry.set(key, { ...carried, grams: total });
        this.persist();
        this.logger.info?.(
          { printer: printer.id, slot: key, carriedG: total },
          "consumption below 1 g — carried until it reaches the minimum unit"
        );
        return null;
      }
      if (carried.grams > 0) {
        this.carry.set(key, { ...carried, grams: 0 });
        this.persist();
      }
      return { grams: total };
    }

    const total = item.lengthMm + carried.lengthMm;
    if (total < MIN_CONSUME_LENGTH_MM) {
      this.carry.set(key, { ...carried, lengthMm: total });
      this.persist();
      this.logger.info?.(
        { printer: printer.id, slot: key, carriedMm: total },
        "consumption below the minimum length — carried until it reaches the unit"
      );
      return null;
    }
    if (carried.lengthMm > 0) {
      this.carry.set(key, { ...carried, lengthMm: 0 });
      this.persist();
    }
    return { lengthMm: total };
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
      const now = this.now();
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
      this.authNotified = false;
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
        this.drop(entry, "rejected", `склад — ${error.message}`);
        return;
      }
      if (error instanceof FulfillmentError && error.kind === "auth") {
        this.notifyAuthOnce(error.message);
      }

      entry.attempts += 1;
      entry.nextAttemptAtMs = this.now() + retryDelayMs(entry.attempts);
      if (this.now() - entry.firstFailedAtMs > this.maxAgeMs) {
        const days = Math.round(this.maxAgeMs / (24 * 60 * 60 * 1000));
        this.drop(
          entry,
          "expired",
          `склад — не удалось списать за ${days} дн., отложенное списание отброшено (${label})`
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

  /**
   * Final removal of a queue entry with its reason: counted in the dropped
   * metric, logged with the idempotency key (so the deduction can be traced and
   * re-done by hand), and surfaced to the operator — a queued deduction never
   * disappears silently.
   */
  private drop(entry: PendingConsume, reason: PendingDropReason, message: string): void {
    this.dropped[reason] += 1;
    this.remove(entry);
    this.logger.warn?.(
      {
        printer: entry.input.printerId,
        idempotencyKey: entry.input.idempotencyKey,
        attempts: entry.attempts,
        reason
      },
      "pending consume dropped"
    );
    this.events.push("⚠", `<b>${entry.printerName}</b>: ${message}`, "err");
  }

  /** One prominent auth-misconfiguration event per outage (never per print). */
  private notifyAuthOnce(message: string): void {
    if (this.authNotified) return;
    this.authNotified = true;
    this.events.push(
      "⚠",
      `склад — ${message}; списания поставлены в очередь и будут повторены после исправления`,
      "err"
    );
  }

  /** First delivery of one deduction; failures route to the queue or the feed. */
  private async deliver(input: ConsumePayload, printerName: string): Promise<void> {
    try {
      await this.inventory!.consume(input);
      this.authNotified = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn?.({ err: error, printer: input.printerId }, "filament consume failed");

      if (error instanceof FulfillmentError && error.kind === "auth") {
        // Config error: the request was provably not processed — queue it for
        // after the operator fixes the token, and notify once (not per print).
        this.enqueue(input, printerName, message, { announce: false });
        this.notifyAuthOnce(message);
        return;
      }
      if (error instanceof FulfillmentError && error.kind === "unreachable") {
        this.enqueue(input, printerName, message, { announce: true });
        return;
      }
      this.events.push("⚠", `<b>${printerName}</b>: склад — ${message}`, "err");
    }
  }

  private enqueue(
    input: ConsumePayload,
    printerName: string,
    reason: string,
    options: { announce: boolean }
  ): void {
    if (this.pending.length >= this.maxPending) {
      // Overflow never silently deletes work: the OLDEST entry is dropped with
      // its reason counted, logged (with the idempotency key) and announced.
      const oldest = this.pending[0];
      this.drop(
        oldest,
        "overflow",
        `склад — очередь повторных списаний переполнена (${this.maxPending}), самое старое списание отброшено (${oldest.input.note ?? oldest.input.printJobId})`
      );
    }
    const now = this.now();
    this.pending.push({
      input,
      printerName,
      attempts: 1,
      nextAttemptAtMs: now + retryDelayMs(1),
      firstFailedAtMs: now
    });
    this.persist();
    if (options.announce) {
      this.events.push(
        "⚠",
        `<b>${printerName}</b>: склад — ${reason}; списание будет повторено автоматически`,
        "err"
      );
    }
  }
}
