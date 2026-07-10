import type { PersistedToday } from "../infra/persistence/stateStore";
import { env } from "../shared/env";
import { localDateKey } from "../shared/time";

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Largest gap between two polls we still trust as a single continuous printing
 * interval. Normal polls are seconds apart (PRINTER_POLL_INTERVAL_MS, default
 * 10 s), but a hung poll, a suspended process or a backend that was down can
 * make the wall clock jump far beyond that; crediting the whole jump would
 * invent printing-hours the farm never observed. A single interval therefore
 * contributes at most this much. Tied to the poll interval (with a floor) so a
 * deliberately slow poll cadence does not systematically cap itself.
 */
const MAX_PRINT_ACCRUAL_MS = Math.max(env.printerPollIntervalMs * 6, 5 * 60 * 1000);

/**
 * Today's observed farm statistics: completions, failures, accumulated
 * printer-time in `printing`, and the average duration of the runs the poller
 * watched from start to finish. Keyed by the local calendar day
 * ({@link localDateKey}); every read/write first rolls the day over, so a value
 * from yesterday can never leak into today. Purely an accumulator — the poller
 * decides *what* counts (which transition is a completion, which interval was
 * really spent printing) and the state store decides *when* to persist.
 *
 * Serialization uses the existing {@link PersistedToday} contract unchanged, so
 * state files written before this class existed keep loading.
 */
export class TodayCounters {
  private key = localDateKey();
  private done = 0;
  private failed = 0;
  /** Sum of observed printer-time in `printing` today, in ms (across all printers). */
  private printingMs = 0;
  /**
   * Daily aggregate for the "average print duration" metric: summed duration
   * and count of successfully completed runs whose start the poller observed.
   * The average is total/count; a count of 0 means the UI shows "нет данных".
   */
  private avgDurationMsTotal = 0;
  private avgDurationCount = 0;

  constructor(initial?: PersistedToday) {
    // Hydrate from persisted state. rollover() resets the values on the first
    // read if the persisted day is no longer today.
    if (initial?.key) {
      this.key = initial.key;
      this.done = initial.done;
      this.failed = initial.failed;
      // `?? 0` tolerates a state file written before printing-hours tracking (or
      // a hand-built PersistedToday in tests) — same lenient stance as the store.
      this.printingMs = initial.printingMs ?? 0;
      // Likewise tolerant of files written before average-duration tracking.
      this.avgDurationMsTotal = initial.avgDurationMsTotal ?? 0;
      this.avgDurationCount = initial.avgDurationCount ?? 0;
    }
  }

  /** The durable projection of today's counters (rolled over to the current day first). */
  serialize(): PersistedToday {
    this.rollover();
    return {
      key: this.key,
      done: this.done,
      failed: this.failed,
      printingMs: this.printingMs,
      avgDurationMsTotal: this.avgDurationMsTotal,
      avgDurationCount: this.avgDurationCount
    };
  }

  /**
   * One successfully completed print. `durationMs` is the observed
   * start-to-finish span when the poller watched the run begin, or `null` for a
   * run with no known start (pre-existing at boot, revived across a restart) —
   * those count as done but stay out of the average, so an unknown or partial
   * duration never biases it.
   */
  recordCompleted(durationMs: number | null): void {
    this.rollover();
    this.done += 1;
    if (durationMs !== null && durationMs > 0) {
      this.avgDurationMsTotal += durationMs;
      this.avgDurationCount += 1;
    }
  }

  recordFailed(): void {
    this.rollover();
    this.failed += 1;
  }

  /**
   * Credits one observed printing interval toward today's total and returns the
   * ms actually credited. The slice is clipped to the current local day (a
   * print straddling local midnight splits across days — rollover() has already
   * zeroed the counter, so only the post-midnight part lands) and capped at
   * {@link MAX_PRINT_ACCRUAL_MS} (a hung poll / suspended process cannot inject
   * hours). Deciding *whether* the interval was printing time at all is the
   * poller's job — it tracks the per-printer anchors and the previous status.
   */
  creditPrintingInterval(fromMs: number, nowMs: number): number {
    this.rollover();
    const midnight = new Date(nowMs);
    midnight.setHours(0, 0, 0, 0);
    const from = Math.max(fromMs, midnight.getTime());
    const credited = Math.min(nowMs - from, MAX_PRINT_ACCRUAL_MS);
    if (credited <= 0) return 0;
    this.printingMs += credited;
    return credited;
  }

  getDone(): number {
    this.rollover();
    return this.done;
  }

  getFailed(): number {
    this.rollover();
    return this.failed;
  }

  /**
   * Today's accumulated printer-time in `printing`, exposed as hours rounded to
   * one decimal. It is a sum across every printer, so a busy farm can report
   * more than 24 — that is intended, it is not a queue ETA or a job count.
   */
  getHoursUsed(): number {
    this.rollover();
    const hours = this.printingMs / MS_PER_HOUR;
    return Math.round(hours * 10) / 10;
  }

  /**
   * Mean duration in ms of the print runs that completed successfully today and
   * whose start the poller observed, or `null` when there is none yet (→ the
   * dashboard shows "нет данных"). Deliberately computed from summed real run
   * durations, never from printingMs / done — that sum mixes in still-running
   * prints, is taken across printers, and is clipped at midnight.
   */
  getAvgPrintMs(): number | null {
    this.rollover();
    if (this.avgDurationCount <= 0) return null;
    return this.avgDurationMsTotal / this.avgDurationCount;
  }

  private rollover(): void {
    const key = localDateKey();
    if (key !== this.key) {
      this.key = key;
      this.done = 0;
      this.failed = 0;
      this.printingMs = 0;
      this.avgDurationMsTotal = 0;
      this.avgDurationCount = 0;
    }
  }
}
