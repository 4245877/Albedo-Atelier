import type { StoreLogger } from "../../shared/logger";

/**
 * A tiny in-process, bounded worker pool for artifact analysis.
 *
 * It is deliberately *not* Redis or a separate service (out of scope): analysis
 * runs inside this Node process, but never more than `concurrency` files at once,
 * so a burst of uploads cannot spawn unbounded parallel parses. Each job is an
 * analysis id; `runOne` does the actual work (open blob, analyze, persist). The
 * pool owns only scheduling — it holds no database or file state itself.
 *
 * Jobs survive a restart because they live as `pending`/`running` rows in
 * SQLite, not in this queue: on boot the service re-enqueues them (see
 * `ArtifactService.recover`). This queue is purely the live, in-memory schedule.
 */
export class AnalysisWorker {
  private readonly pending: string[] = [];
  private readonly queued = new Set<string>();
  private active = 0;
  private closed = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly runOne: (analysisId: string) => Promise<void>,
    private readonly logger: StoreLogger = {}
  ) {}

  /** Schedules an analysis id (ignored if already scheduled or the pool is closed). */
  enqueue(analysisId: string): void {
    if (this.closed || this.queued.has(analysisId)) return;
    this.queued.add(analysisId);
    this.pending.push(analysisId);
    this.pump();
  }

  private pump(): void {
    while (!this.closed && this.active < this.concurrency && this.pending.length > 0) {
      const id = this.pending.shift() as string;
      this.queued.delete(id);
      this.active += 1;
      void this.runOne(id)
        .catch((error) => {
          this.logger.error?.({ err: error, analysisId: id }, "analysis worker job crashed");
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

  /** Number of jobs waiting or running — for observability/tests. */
  get inFlight(): number {
    return this.active + this.pending.length;
  }

  /** Stops accepting new work; in-flight jobs run to completion. */
  close(): void {
    this.closed = true;
    this.pending.length = 0;
    this.queued.clear();
  }
}
