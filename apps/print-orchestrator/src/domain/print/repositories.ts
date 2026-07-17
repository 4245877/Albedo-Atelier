import type {
  ProfileRevisionRepository,
  ProfileSetRepository,
  SliceVariantRepository
} from "../slicing/repositories";
import type {
  Artifact,
  ArtifactAnalysis,
  Assignment,
  AuditEvent,
  BedCycle,
  DispatchAttempt,
  Plan,
  PrintRun,
  PrintTask,
  QueueEntry
} from "./types";

/**
 * The storage boundary for the print-queue domain.
 *
 * These are *ports*: the service layer depends only on these interfaces, never
 * on SQLite. The concrete adapters live under `infra/db/repositories` and are
 * the only code that speaks `node:sqlite`. This is what the brief means by
 * "изолируй работу с БД через repository-интерфейсы; не связывай доменный слой
 * напрямую с SQLite".
 *
 * ## Optimistic concurrency
 * Every mutable entity carries a `version`. `update(entity)` writes the row only
 * when the stored version still equals `entity.version`, then bumps it; a
 * mismatch throws {@link file://../../core/errors.ts VersionConflictError}. So a
 * caller reads, mutates, and writes back the same object it read; a racing
 * writer makes the second write fail loudly instead of silently clobbering.
 * Callers are responsible for setting `updatedAt` before `update`; the repo owns
 * only the `version` bump.
 *
 * ## Transactions
 * Related multi-entity changes run inside {@link PrintQueueStore.transaction},
 * which wraps them in a single SQLite transaction on the shared connection —
 * either all the writes land or none do.
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

export interface ArtifactRepository extends WritableRepository<Artifact> {
  findByLegacyRef(legacyRef: string): Artifact | null;
  /** Any artifact whose `source` (storage key) matches — used to tell whether a blob is still referenced. */
  findBySource(source: string): Artifact | null;
  list(): Artifact[];
}

export interface ArtifactAnalysisRepository extends WritableRepository<ArtifactAnalysis> {
  listByArtifact(artifactId: string): ArtifactAnalysis[];
  latestForArtifact(artifactId: string): ArtifactAnalysis | null;
  /** Not-yet-finished analyses (`pending`/`running`), oldest first, for startup recovery. */
  listUnfinished(): ArtifactAnalysis[];
}

/** Optional filter for a task listing. */
export interface TaskQuery {
  states?: PrintTask["state"][];
}

export interface PrintTaskRepository extends WritableRepository<PrintTask> {
  findByLegacyRef(legacyRef: string): PrintTask | null;
  /** The (single) task created for an uploaded artifact; oldest first if several. */
  findByArtifactId(artifactId: string): PrintTask | null;
  list(query?: TaskQuery): PrintTask[];
}

export interface QueueEntryRepository extends WritableRepository<QueueEntry> {
  findByTaskId(taskId: string): QueueEntry | null;
  /** Entries not yet released (WAITING/HELD), ordered by position then enqueue time. */
  listOpen(): QueueEntry[];
  /** The largest `position` among open entries, or null when the queue is empty. */
  maxPosition(): number | null;
}

export interface PlanRepository extends WritableRepository<Plan> {
  list(): Plan[];
}

export interface AssignmentRepository extends WritableRepository<Assignment> {
  listByTask(taskId: string): Assignment[];
  /** The current non-terminal assignment on a printer, if any. */
  findOpenByPrinter(printerId: string): Assignment | null;
}

export interface BedCycleRepository extends WritableRepository<BedCycle> {
  /** The current non-terminal (not CLEAR) cycle for a printer, if any. */
  findOpenByPrinter(printerId: string): BedCycle | null;
  listByPrinter(printerId: string): BedCycle[];
}

export interface DispatchAttemptRepository extends WritableRepository<DispatchAttempt> {
  listByAssignment(assignmentId: string): DispatchAttempt[];
  /** Highest `attemptNo` recorded for an assignment, or 0 when there are none. */
  maxAttemptNo(assignmentId: string): number;
}

export interface PrintRunRepository extends WritableRepository<PrintRun> {
  listByTask(taskId: string): PrintRun[];
  findByLegacyRef(legacyRef: string): PrintRun | null;
}

/** Append-only: no update, no version. */
export interface AuditEventRepository {
  insert(event: AuditEvent): AuditEvent;
  /** Newest-first, capped at `limit`. */
  list(limit?: number): AuditEvent[];
  listByEntity(entityType: AuditEvent["entityType"], entityId: string): AuditEvent[];
}

/**
 * Small key/value side-table for one-off operational markers — currently just
 * the legacy-import guard, so the JSON→SQLite import runs exactly once.
 */
export interface AppMetaRepository {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** The full set of repositories, all bound to one database connection. */
export interface Repositories {
  artifacts: ArtifactRepository;
  artifactAnalyses: ArtifactAnalysisRepository;
  tasks: PrintTaskRepository;
  queue: QueueEntryRepository;
  plans: PlanRepository;
  assignments: AssignmentRepository;
  bedCycles: BedCycleRepository;
  dispatchAttempts: DispatchAttemptRepository;
  printRuns: PrintRunRepository;
  audit: AuditEventRepository;
  meta: AppMetaRepository;
  // slicing domain (domain/slicing)
  profileRevisions: ProfileRevisionRepository;
  profileSets: ProfileSetRepository;
  sliceVariants: SliceVariantRepository;
}

/**
 * The domain-facing database handle: a bundle of repositories plus a
 * transaction runner and lifecycle. The SQLite adapter implements it; the
 * service depends only on this.
 */
export interface PrintQueueStore {
  readonly repositories: Repositories;
  /**
   * Runs `fn` inside a single database transaction. Everything `fn` writes
   * through the repositories commits atomically; any thrown error rolls it all
   * back and re-throws. Synchronous, matching the underlying `node:sqlite` API.
   * Not reentrant — do not nest.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}
