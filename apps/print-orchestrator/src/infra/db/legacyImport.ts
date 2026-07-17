import { newId, ID_PREFIX } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { Artifact, Metadata, PrintTask, QueueEntry } from "../../domain/print/types";
import type { QueueJob } from "../../domain/dashboard/types";
import type { StoreLogger } from "../../shared/logger";

/** app_meta key that records the JSON→SQLite import ran, so it runs exactly once. */
export const LEGACY_IMPORT_MARKER = "legacy_import.state_json";

const POSITION_STEP = 10;

export interface LegacyImportResult {
  /** True when the import was skipped because the marker was already set. */
  skipped: boolean;
  imported: number;
}

/** "—"/empty legacy placeholder → null. */
function orNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "—" ? trimmed : null;
}

/**
 * One-time import of the legacy JSON operator queue into the SQLite model.
 *
 * Safe and idempotent by two independent guards: an `app_meta` marker set inside
 * the import transaction (so it never runs twice), and a per-task
 * `findByLegacyRef` check (so even a forced re-run cannot duplicate a job). Old
 * ids are preserved verbatim as `legacyRef`, which is how a later stage can
 * reconcile the two worlds.
 *
 * This is explicitly **not** dual-write: after this runs once, the legacy JSON
 * queue and the SQLite model evolve independently. The whole import is a single
 * transaction — it either lands completely or leaves the database untouched.
 */
export function importLegacyQueue(
  store: PrintQueueStore,
  jobs: readonly QueueJob[],
  options: { now?: () => Date; logger?: StoreLogger } = {}
): LegacyImportResult {
  const repos = store.repositories;
  if (repos.meta.get(LEGACY_IMPORT_MARKER)) {
    return { skipped: true, imported: 0 };
  }

  const now = options.now ?? (() => new Date());
  const iso = now().toISOString();

  const result = store.transaction(() => {
    let imported = 0;
    let index = 0;
    for (const job of jobs) {
      if (!job.id || repos.tasks.findByLegacyRef(job.id)) continue;

      const file = orNull(job.file);
      let artifactId: string | null = null;
      if (file) {
        const artifact: Artifact = {
          id: newId(ID_PREFIX.artifact),
          kind: "gcode",
          name: file,
          source: file,
          sizeBytes: null,
          sha256: null,
          createdAt: iso,
          updatedAt: iso,
          version: 1,
          legacyRef: null,
          metadata: { importedFrom: job.id }
        };
        repos.artifacts.insert(artifact);
        artifactId = artifact.id;
      }

      const review = job.status === "review";
      const metadata: Metadata = {};
      const eta = orNull(job.eta);
      if (eta) metadata.eta = eta;
      if (job.at?.trim()) metadata.at = job.at.trim();
      if (file) metadata.file = file;

      const task: PrintTask = {
        id: newId(ID_PREFIX.printTask),
        artifactId,
        title: job.title || "(без названия)",
        material: orNull(job.material),
        targetPrinter: orNull(job.printer),
        priority: 0,
        state: review ? "NEEDS_REVIEW" : "QUEUED",
        reason: orNull(job.reason),
        night: job.night === true,
        notBefore: null,
        deadline: null,
        dayNightPreference: "any",
        pinnedPrinterId: null,
        unattendedAllowed: false,
        createdAt: iso,
        updatedAt: iso,
        version: 1,
        legacyRef: job.id,
        metadata
      };
      repos.tasks.insert(task);

      const entry: QueueEntry = {
        id: newId(ID_PREFIX.queueEntry),
        taskId: task.id,
        position: (index + 1) * POSITION_STEP,
        state: review ? "HELD" : "WAITING",
        enqueuedAt: iso,
        updatedAt: iso,
        version: 1
      };
      repos.queue.insert(entry);

      repos.audit.insert({
        id: newId(ID_PREFIX.auditEvent),
        at: iso,
        entityType: "print_task",
        entityId: task.id,
        action: "imported",
        fromState: null,
        toState: task.state,
        actor: "system",
        detail: { legacyRef: job.id }
      });

      imported += 1;
      index += 1;
    }

    repos.meta.set(LEGACY_IMPORT_MARKER, iso);
    return { skipped: false, imported };
  });

  options.logger?.info?.(
    { imported: result.imported },
    "legacy queue imported into SQLite (one-time)"
  );
  return result;
}
