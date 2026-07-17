import type { WritableRepository } from "../print/repositories";
import type { ProfileRevision, ProfileSet, ProfileType, SliceVariant } from "./types";

/**
 * Storage ports for the slicing domain. Like the print-queue ports, these are the
 * only contract the service layer sees — the SQLite adapters under
 * `infra/db/repositories` are the sole `node:sqlite` code. They plug into the same
 * {@link PrintQueueStore} (one database, one transaction runner), so a slice and
 * the artifact/analysis rows it produces commit together.
 */

export interface ProfileRevisionRepository extends WritableRepository<ProfileRevision> {
  /** The revision with this exact raw content hash, if already imported (dedup). */
  findByRawSha256(rawSha256: string): ProfileRevision | null;
  /** The single `active` revision for a logical id, if any (what a set may bind). */
  findActiveByLogicalId(logicalId: string): ProfileRevision | null;
  /** Newest revision (any status) for a logical id. */
  latestByLogicalId(logicalId: string): ProfileRevision | null;
  list(type?: ProfileType): ProfileRevision[];
}

export interface ProfileSetRepository extends WritableRepository<ProfileSet> {
  list(): ProfileSet[];
}

export interface SliceVariantRepository extends WritableRepository<SliceVariant> {
  /** A finished (`ready`) variant with this cache key whose output still exists — a cache hit. */
  findReadyByCacheKey(cacheKey: string): SliceVariant | null;
  listByTask(taskId: string): SliceVariant[];
  /** Not-yet-finished variants (`pending`/`running`), oldest first, for startup recovery. */
  listUnfinished(): SliceVariant[];
  list(): SliceVariant[];
}
