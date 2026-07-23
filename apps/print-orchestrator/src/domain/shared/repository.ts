/**
 * Neutral repository contracts shared by every domain area (print, slicing).
 *
 * Lives outside both `domain/print` and `domain/slicing` so the two areas can
 * each extend {@link WritableRepository} without importing one another — the
 * type-only cycle `print/repositories ↔ slicing/repositories` is broken here.
 */

/** Insert + optimistic-update, shared shape for the versioned entities. */
export interface WritableRepository<T extends { id: string; version: number }> {
  /** Persists a new row verbatim (the caller supplies id/timestamps/version). */
  insert(entity: T): T;
  /** One row by id, or null when absent. */
  getById(id: string): T | null;
  /**
   * Writes `entity`'s columns only if the stored `version` still matches
   * `entity.version`, then bumps the stored version by one and returns the
   * written row. Throws `VersionConflictError` on a stale version, `NotFoundError`
   * when the id is gone.
   */
  update(entity: T): T;
}
