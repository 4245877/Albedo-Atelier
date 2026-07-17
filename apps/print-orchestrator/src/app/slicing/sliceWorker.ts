import type { StoreLogger } from "../../shared/logger";

/**
 * A bounded in-process pool for slice jobs — the slicing counterpart of
 * {@link AnalysisWorker}. Slicing is much heavier than analysis, so the default
 * concurrency is low (often 1). Jobs are just slice-variant ids; the real work
 * (spawn OrcaSlicer, stage output, analyse) is the {@link SliceService.runSlice}
 * callback. Jobs survive a restart because they live as `pending`/`running` rows in
 * SQLite, not in this queue — the service re-enqueues them on boot.
 */
export class SliceWorker {
  private readonly pending: string[] = [];
  private readonly queued = new Set<string>();
  private active = 0;
  private closed = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly runOne: (variantId: string) => Promise<void>,
    private readonly logger: StoreLogger = {}
  ) {}

  /** Schedules a variant id (ignored if already scheduled or the pool is closed). */
  enqueue(variantId: string): void {
    if (this.closed || this.queued.has(variantId)) return;
    this.queued.add(variantId);
    this.pending.push(variantId);
    this.pump();
  }

  private pump(): void {
    while (!this.closed && this.active < this.concurrency && this.pending.length > 0) {
      const id = this.pending.shift() as string;
      this.queued.delete(id);
      this.active += 1;
      void this.runOne(id)
        .catch((error) => {
          this.logger.error?.({ err: error, variantId: id }, "slice worker job crashed");
        })
        .finally(() => {
          this.active -= 1;
          this.pump();
          this.settleIfIdle();
        });
    }
    this.settleIfIdle();
  }

  private settleIfIdle(): void {
    if (this.active === 0 && this.pending.length === 0 && this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  /** Resolves once the queue is empty and no job is in flight (used by tests). */
  whenIdle(): Promise<void> {
    if (this.active === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  get inFlight(): number {
    return this.active + this.pending.length;
  }

  close(): void {
    this.closed = true;
    this.pending.length = 0;
    this.queued.clear();
  }
}
