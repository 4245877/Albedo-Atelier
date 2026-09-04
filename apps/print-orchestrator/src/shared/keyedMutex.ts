/**
 * Per-key promise chains: `run(key, task)` serializes tasks with the same key
 * strictly one after another, while different keys run independently. Failures
 * do not break the chain — the next task still runs. Previously duplicated as
 * the private `runExclusive` of the command service and the light scheduler.
 *
 * A chain that has drained is dropped, so the map holds only keys with work in
 * flight. That matters because the key space is not always small and fixed:
 * printer ids are, but blob storage keys are one per stored file, and the
 * artifact orphan sweep locks EVERY blob on disk in turn — with no cleanup the
 * map grew to the size of the whole store and stayed there for the life of the
 * process. Dropping only a link that is still the tail keeps the serialization
 * exact: a task that queued behind it has already replaced the tail, so nothing
 * can start early.
 */
export class KeyedMutex {
  private readonly chain = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = (this.chain.get(key) ?? Promise.resolve()).catch(() => {});
    const next = prev.then(task);
    const link: Promise<unknown> = next.then(
      () => this.drop(key, link),
      () => this.drop(key, link)
    );
    this.chain.set(key, link);
    return next;
  }

  /** Keys with work still queued or running — bookkeeping visibility for tests. */
  get size(): number {
    return this.chain.size;
  }

  /** Drops chains whose key is not in `live` (bookkeeping for removed printers). */
  prune(live: Set<string>): void {
    for (const key of this.chain.keys()) {
      if (!live.has(key)) this.chain.delete(key);
    }
  }

  /** Forgets a drained chain, unless someone has already queued behind it. */
  private drop(key: string, link: Promise<unknown>): void {
    if (this.chain.get(key) === link) this.chain.delete(key);
  }
}
