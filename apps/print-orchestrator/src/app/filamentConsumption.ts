import { randomUUID } from "node:crypto";
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

/**
 * A completed print whose filament could NOT be deducted automatically, kept
 * until an operator clears it.
 *
 * This exists because the previous behaviour — a single line pushed into the
 * event feed — was indistinguishable from no record at all: the feed is capped
 * and unacknowledged, so the debt scrolled away and the warehouse silently
 * drifted from reality by a spool at a time. A durable row survives restarts and
 * can be listed, which is the difference between "we owe a deduction" and "we
 * used to know we owed a deduction".
 */
export type UnreconciledConsume = {
  /** Stable id so a UI can acknowledge exactly one entry. */
  id: string;
  printerId: string;
  printerName: string;
  /** The print's file, when known. */
  job: string | null;
  /** ISO timestamp of when the debt was recorded. */
  observedAt: string;
  /** Why automatic deduction could not happen — shown verbatim to the operator. */
  reason: string;
  /**
   * The slicer's own figure for this job, in grams, when one is known.
   *
   * An **orientation, not a measurement**, and labelled as such everywhere it
   * surfaces. It is what the slicer expected to extrude, which is the right
   * starting number for an operator writing off a spool by hand — and exactly
   * the wrong number to post to the warehouse automatically, because nothing
   * observed it. The two are kept apart by {@link ConsumptionConfidence}: this
   * field can never become a deduction without a human.
   */
  estimatedGrams: number | null;
  /**
   * The quantity a device DID measure for this print but the warehouse never
   * applied — a rejected deduction (no loaded reel, not enough stock, archived
   * position) or one dropped from the retry queue.
   *
   * Distinct from {@link estimatedGrams} on purpose, and the distinction is the
   * whole point: this is an observation, so an operator settling the debt is
   * confirming a real number rather than accepting a guess. Null for debts that
   * arise because nothing was measured at all.
   */
  measured: { grams?: number; lengthMm?: number } | null;
  /**
   * The delivery that was owed, verbatim, when one was built. Kept so settling
   * the debt re-posts the ORIGINAL payload — same `idempotencyKey` — which means
   * a manual settlement can never double-deduct against a delivery that had in
   * fact landed. Null for debts with no payload (nothing was measurable).
   */
  payload: ConsumePayload | null;
};

/**
 * How well a consumption figure is known. The distinction is the whole point of
 * the accounting: `remain`-based grams and Klipper's extruded length are things
 * a device *observed*, while a slicer's estimate is a thing software *predicted*,
 * and only the first may be deducted without a person.
 *
 * `remain` itself is measured but coarse — quantised to 1 %, so ~10 g on a 1 kg
 * spool and ~2.5 g on a 250 g AMS-Lite spool. It is reported as `measured`
 * because it is an observation of the physical spool, not because it is precise;
 * the sub-gram carry exists precisely because it is not.
 */
export type ConsumptionConfidence =
  /** A device observed it (AMS remain-drop, Klipper `filament_used`). */
  | "measured"
  /** A slicer predicted it. Never deducted automatically. */
  | "estimated"
  /** Nothing observed and nothing predicted. */
  | "none";

/** Why a queued deduction was finally dropped (metric + operator event reason). */
export type PendingDropReason = "overflow" | "expired" | "rejected";

/** First retry delay; doubles per failed attempt up to {@link RETRY_MAX_DELAY_MS}. */
const RETRY_BASE_DELAY_MS = 60 * 1000;
/** Cap on stored manual-deduction debts, so a persistent fault cannot grow state.json without bound. */
const MAX_UNRECONCILED = 200;
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
  /**
   * What the slicer said this job would use, in grams, when the queue knows.
   * Carried only so an unmeasurable print can leave the operator a starting
   * number; never a deduction — see {@link ConsumptionConfidence}.
   */
  estimatedGrams?: number | null;
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
  /** Debts awaiting a manual deduction; persisted with the farm state. */
  private unreconciled: UnreconciledConsume[];
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
      /** Unreconciled deductions restored from the persisted farm state. */
      initialUnreconciled?: UnreconciledConsume[];
      /** Queue cap; defaults to env FILAMENT_RETRY_QUEUE_MAX. */
      maxPending?: number;
      /** Give-up age; defaults to env FILAMENT_RETRY_MAX_AGE_DAYS. */
      maxAgeMs?: number;
      /** Clock, injectable for tests. */
      now?: () => number;
    } = {}
  ) {
    this.pending = [...initialPending];
    this.unreconciled = [...(options?.initialUnreconciled ?? [])];
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

  /** Unreconciled deductions for persistence and for the operator-facing read. */
  serializeUnreconciled(): UnreconciledConsume[] {
    return [...this.unreconciled];
  }

  /** Every outstanding manual-deduction debt, newest first. */
  listUnreconciled(): UnreconciledConsume[] {
    return [...this.unreconciled].reverse();
  }

  /** One debt by id, or null. */
  findUnreconciled(id: string): UnreconciledConsume | null {
    return this.unreconciled.find((entry) => entry.id === id) ?? null;
  }

  /**
   * Operator acknowledgement: the debt has been settled by hand.
   *
   * Persists immediately. Without that the acknowledgement lived only in memory
   * and a restart resurrected a debt the operator had already written off —
   * which is the same class of bug as losing one.
   */
  clearUnreconciled(id: string): boolean {
    const before = this.unreconciled.length;
    this.unreconciled = this.unreconciled.filter((entry) => entry.id !== id);
    const removed = this.unreconciled.length !== before;
    if (removed) this.persist();
    return removed;
  }

  /**
   * Settle a debt by actually posting its deduction to the warehouse — the
   * operator's decision, taken once the reason it failed has been fixed (a reel
   * bound, stock refilled, a position restored).
   *
   * Only a debt that carries the ORIGINAL payload can be settled this way, and
   * the payload is re-posted verbatim: the `idempotencyKey` is the one the
   * failed delivery already used, so if that delivery had in fact landed,
   * fulfillment answers `duplicate` and nothing is deducted twice. The debt is
   * cleared only after fulfillment accepted it; a refusal leaves it standing
   * with the new reason, because a debt that disappears on a failed settlement
   * is exactly the drift this whole ledger exists to prevent.
   */
  async settleUnreconciled(
    id: string,
    /**
     * Grams the OPERATOR states, for a debt with nothing measured — the A1's
     * external spool reports no `tray_weight`, so its prints are unmeasurable by
     * construction and no amount of retrying will produce a figure.
     *
     * This is the one door through which a non-measurement may move the
     * warehouse, and it is deliberately narrow: a person has to name the number,
     * having been shown the slicer's estimate next to it. Automatic deduction
     * still never accepts an estimate — see {@link ConsumptionConfidence}.
     */
    grams?: number
  ): Promise<{ settled: boolean; reason?: string }> {
    const entry = this.findUnreconciled(id);
    if (!entry) return { settled: false, reason: "долг не найден" };
    if (!this.inventory?.enabled) {
      return { settled: false, reason: "интеграция со складом не настроена" };
    }

    const manual = grams !== undefined;
    if (manual && (!Number.isFinite(grams) || (grams as number) < MIN_CONSUME_GRAMS)) {
      return { settled: false, reason: `укажите не менее ${MIN_CONSUME_GRAMS} г` };
    }
    const payload = manual ? this.manualPayload(entry, grams as number) : entry.payload;
    if (!payload) {
      return {
        settled: false,
        reason: "по этой печати нет измеренного расхода — укажите граммы для списания вручную"
      };
    }

    try {
      await this.inventory.consume(payload);
      this.authNotified = false;
      this.clearUnreconciled(id);
      this.events.push(
        "✔",
        `<b>${entry.printerName}</b>: склад — ручное списание выполнено` +
          `${entry.job ? ` (${entry.job})` : ""}`,
        "ok"
      );
      return { settled: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.reason = message;
      this.persist();
      this.logger.warn?.(
        { printer: entry.printerId, debt: id },
        "manual settlement of an unreconciled consume failed"
      );
      return { settled: false, reason: message };
    }
  }

  /**
   * Record that a print finished without a recoverable deduction. Bounded, so a
   * persistent fault cannot grow the state file without limit — the OLDEST entry
   * is dropped, because the newest debt is the one most likely still actionable.
   *
   * Persists on its own rather than relying on a caller's later save: every call
   * site happens to push a feed event straight after (and the feed persists),
   * but a debt whose durability depends on an unrelated side effect is one
   * refactor away from being lost.
   */
  private recordUnreconciled(
    printer: { id: string; name: string },
    job: string | null,
    reason: string,
    options: {
      estimatedGrams?: number | null;
      measured?: { grams?: number; lengthMm?: number } | null;
      payload?: ConsumePayload | null;
    } = {}
  ): void {
    this.unreconciled.push({
      id: randomUUID(),
      printerId: printer.id,
      printerName: printer.name,
      job,
      observedAt: new Date().toISOString(),
      reason,
      estimatedGrams: options.estimatedGrams ?? null,
      measured: options.measured ?? null,
      payload: options.payload ?? null
    });
    while (this.unreconciled.length > MAX_UNRECONCILED) this.unreconciled.shift();
    this.persist();
  }

  /**
   * The deduction for an operator-stated settlement of an unmeasured debt.
   *
   * The idempotency key is derived from the DEBT id (a UUID minted once, when
   * the debt was recorded), so a double-submit — an impatient second click, a
   * retried request — settles the same debt exactly once on the warehouse side.
   * Whole grams: fulfillment tracks stock in whole grams and this figure came
   * from a person, not from an accumulator that needs a sub-gram carry.
   */
  private manualPayload(entry: UnreconciledConsume, grams: number): ConsumePayload {
    const rounded = Math.round(grams);
    return {
      printerId: entry.printerId,
      grams: rounded,
      printJobId: entry.payload?.printJobId ?? entry.id,
      idempotencyKey: `manual:${entry.id}`,
      note: entry.job ? `Ручное списание за печать «${entry.job}»` : "Ручное списание"
    };
  }

  /** The measured quantity a payload carries, for an operator-facing debt row. */
  private measuredOf(input: ConsumePayload): { grams?: number; lengthMm?: number } {
    return input.grams !== undefined ? { grams: input.grams } : { lengthMm: input.lengthMm as number };
  }

  /** "12 г" / "1450 мм" — how a debt's owed quantity reads to an operator. */
  private quantityLabel(input: ConsumePayload): string {
    return input.grams !== undefined
      ? `${input.grams} г`
      : `${Math.round(input.lengthMm ?? 0)} мм`;
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
    job: string | null,
    /**
     * The slicer's expected grams for this job when the caller knows one and
     * the run does not carry it — an untracked run has no `CompletedRun` to
     * hold it, and a device that publishes its own sliced metadata (Moonraker
     * `filament_weight_total`) can supply one the queue never had. Orientation
     * only: it is written onto a debt, never deducted.
     */
    estimatedGrams: number | null = null
  ): void {
    if (!this.inventory?.enabled) return;

    // A completed print with no tracked run — one that was already printing when
    // this process started and could NOT be re-adopted from the canonical record
    // (see PrinterPoller.hydrateRunFromCanonical) — has no reliable idempotency
    // anchor. Its device-reported total (Moonraker length) spans the whole job,
    // and a synthetic `printer:date:file` key would collide for two untracked
    // prints of the same file on the same day and under-deduct. So it is still
    // not deducted automatically — but the debt is now RECORDED DURABLY instead
    // of only announced in the event feed, which is capped and unacknowledged
    // and therefore scrolled the obligation away.
    //
    // Checked before the measurement below on purpose: whether the device
    // happened to give us measurable data does not change the fact that a print
    // completed whose filament nobody deducted.
    if (!run) {
      // The estimate is attached here too: an untracked run still has a job on
      // the queue most of the time, and a debt with a starting number is the
      // difference between an operator who can settle it and one who cannot.
      const untrackedEstimate = estimatedGrams ?? null;
      this.recordUnreconciled(
        printer,
        job,
        "печать не отслеживалась (перезапуск во время печати) — автосписание пропущено",
        { estimatedGrams: untrackedEstimate }
      );
      this.events.push(
        "⚠",
        `<b>${printer.name}</b>: склад — печать${job ? ` «${job}»` : ""} не отслеживалась (перезапуск во время печати), автосписание пропущено — спишите вручную`,
        "err"
      );
      return;
    }

    const items = buildConsumeItems(printer, prev, next, run.amsStart ?? null);
    if (items.length === 0) {
      // Nothing was deducted. The question is whether that is because the print
      // was too small to move the 1 % `remain` — a legitimate ~0 g no-op — or
      // because the device gave us nothing to measure at all.
      //
      // The second case used to produce ONLY a feed line, and the feed is capped
      // and unacknowledged: the obligation scrolled away and the warehouse drifted
      // by a spool at a time. It is the ordinary case for this farm's A1, which
      // feeds from an external spool with no `tray_weight`, so there is nothing
      // to turn a remain-drop into grams with. That is now a durable debt, with
      // the slicer's own figure attached as an ORIENTATION for whoever writes it
      // off — never posted as a deduction, because nothing observed it.
      if (!this.measuredSomething(printer, prev, next, run)) {
        const estimate = run.estimatedGrams ?? estimatedGrams ?? null;
        const hint =
          estimate !== null ? ` по расчёту слайсера ≈ ${estimate.toFixed(1)} г (оценка, не замер)` : "";
        this.recordUnreconciled(
          printer,
          job,
          `принтер не сообщил расход филамента — автосписание невозможно${hint}`,
          { estimatedGrams: estimate }
        );
        this.events.push(
          "⚠",
          `<b>${printer.name}</b>: склад — нет данных о расходе филамента${job ? ` для «${job}»` : ""}` +
            `, списание пропущено${hint} — спишите вручную`,
          "err"
        );
      }
      return;
    }

    this.dispatchItems(printer, items, run.printId, job);
  }

  /**
   * Whether the device produced a usable *measurement* for this print, whatever
   * it came to.
   *
   * The distinction this draws is between "measured, and the answer was
   * approximately zero" and "there was nothing to measure". Only the second is a
   * debt: the first is a real observation of a print too small to move a 1 %
   * `remain`, and recording it as an obligation would bury the real ones under
   * one row per test cube.
   */
  private measuredSomething(
    printer: PrinterConfig,
    prev: PrinterLiveStatus,
    next: PrinterLiveStatus,
    run: CompletedRun
  ): boolean {
    if (printer.protocol === "bambu") {
      const endTrays = next.amsTrays ?? prev.amsTrays;
      return bambuMeasurableTrayCount(run.amsStart ?? null, endTrays) > 0;
    }
    // Klipper reports a cumulative extruded length; its presence IS the
    // measurement, and a genuine 0 mm means the job extruded nothing.
    const usedMm = next.filamentUsedMm ?? prev.filamentUsedMm;
    return usedMm !== null && Number.isFinite(usedMm);
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

    const { outcome } = classifyPrintOutcome(next);
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
      void this.deliver(input, printer.name, job);
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
      // Quantity contract: fulfillment tracks stock in WHOLE grams and rounds
      // any fraction it receives, so sending a fractional total would make the
      // applied amount differ from what the carry assumed was sent (systematic
      // drift). Send the integer part and keep the sub-gram remainder here —
      // what is sent is then exactly what fulfillment applies. The epsilon
      // absorbs float noise so e.g. 99.999999999 counts as the 100 g it is.
      const grams = Math.floor(total + 1e-9);
      const remainder = total - grams;
      // Sub-microgram remainders are float noise from the sum, not consumption.
      this.carry.set(key, { ...carried, grams: remainder < 1e-6 ? 0 : remainder });
      this.persist();
      return { grams };
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
    // A queue entry leaving the queue for good is still an owed deduction: the
    // quantity was measured and the warehouse never applied it. It becomes a
    // durable debt for the same reason a rejected first delivery does — the
    // counters behind /api/monitoring/filament-queue are in-memory and reset on
    // restart, so they cannot be the only trace that grams went missing.
    this.recordUnreconciled(
      { id: entry.input.printerId, name: entry.printerName },
      entry.input.note ?? null,
      `отложенное списание ${this.quantityLabel(entry.input)} отброшено (${reason}): ${message}`,
      { measured: this.measuredOf(entry.input), payload: entry.input }
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
  private async deliver(input: ConsumePayload, printerName: string, job: string | null): Promise<void> {
    try {
      const result = (await this.inventory!.consume(input)) as { duplicate?: boolean } | null;
      this.authNotified = false;
      if (result?.duplicate === true) {
        // The key was already spent, so THIS request moved nothing. Harmless for
        // a genuine redelivery, but the key is the run id and a run adopted from
        // the canonical record can outlive one physical print — in which case a
        // real deduction has just silently applied 0 g. Never silent: the carry
        // was already zeroed for it.
        this.logger.warn?.(
          { printer: input.printerId, idempotencyKey: input.idempotencyKey },
          "fulfillment reported the deduction as a duplicate — nothing was applied by this request"
        );
      }
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

      // Rejected: fulfillment processed the call and refused (no loaded reel,
      // not enough stock, an archived position). Auto-retrying is still wrong —
      // it would re-fail identically, and a late retry after a manual correction
      // could double-deduct — but DROPPING it was worse. The carry was already
      // zeroed for this quantity, so a feed line alone meant the grams simply
      // vanished; with stock at zero on the shelf, every subsequent print on
      // that printer vanished the same way. The debt is now durable, carries the
      // measured quantity, and can be settled with one action once the reason is
      // fixed — see settleUnreconciled.
      this.recordUnreconciled(
        { id: input.printerId, name: printerName },
        job,
        `склад отклонил списание ${this.quantityLabel(input)}: ${message}`,
        { measured: this.measuredOf(input), payload: input }
      );
      this.events.push(
        "⚠",
        `<b>${printerName}</b>: склад — ${message}; списание ${this.quantityLabel(input)} ` +
          `сохранено как долг — исправьте причину и подтвердите списание`,
        "err"
      );
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
