import type { StoreLogger } from "./logger";

/**
 * A tiny in-process, bounded worker pool over string job ids.
 *
 * It is deliberately *not* Redis or a separate service (out of scope): jobs run
 * inside this Node process, but never more than `concurrency` at once, so a
 * burst of work cannot spawn unbounded parallel jobs. Each job is an id;
 * `runOne` does the actual work. The pool owns only scheduling — it holds no
 * database or file state itself.
 *
 * Jobs survive a restart because they live as `pending`/`running` rows in
 * SQLite, not in this queue: on boot the owning service re-enqueues them (see
 * `ArtifactService.recover` / `SliceService.recover`). This queue is purely the
 * live, in-memory schedule. Previously duplicated as `AnalysisWorker` and
 * `SliceWorker`; the `label` keeps the crash-log lines distinguishable.
 */
export class BoundedWorkerPool {
  private readonly pending: string[] = [];
  private readonly queued = new Set<string>();
  private active = 0;
  private closed = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly runOne: (id: string) => Promise<void>,
    private readonly options: { logger?: StoreLogger; label: string }
  ) {}

  /** Schedules a job id (ignored if already scheduled or the pool is closed). */
  enqueue(id: string): void {
    if (this.closed || this.queued.has(id)) return;
    this.queued.add(id);
    this.pending.push(id);
    this.pump();
  }

  private pump(): void {
    while (!this.closed && this.active < this.concurrency && this.pending.length > 0) {
      const id = this.pending.shift() as string;
      this.queued.delete(id);
      this.active += 1;
      void this.runOne(id)
        .catch((error) => {
          this.options.logger?.error?.({ err: error, id }, `${this.options.label} job crashed`);
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
