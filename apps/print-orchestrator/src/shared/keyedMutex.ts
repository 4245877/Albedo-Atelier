/**
 * Per-key promise chains: `run(key, task)` serializes tasks with the same key
 * strictly one after another, while different keys run independently. Failures
 * do not break the chain — the next task still runs. Previously duplicated as
 * the private `runExclusive` of the command service and the light scheduler.
 */
export class KeyedMutex {
  private readonly chain = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = (this.chain.get(key) ?? Promise.resolve()).catch(() => {});
    const next = prev.then(task);
    this.chain.set(key, next.catch(() => {}));
    return next;
  }

  /** Drops chains whose key is not in `live` (bookkeeping for removed printers). */
  prune(live: Set<string>): void {
    for (const key of this.chain.keys()) {
      if (!live.has(key)) this.chain.delete(key);
    }
  }
}
