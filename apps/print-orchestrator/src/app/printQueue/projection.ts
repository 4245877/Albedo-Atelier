import type { QueueJob, QueueJobStatus } from "../../domain/dashboard/types";
import type { Artifact, PrintTask, QueueEntry } from "../../domain/print/types";

/**
 * Renders the new persistent model back into the legacy {@link QueueJob} shape
 * the dashboard already knows. The brief allows the old queue format to be a
 * *projection* of the new model during the transition — this is that projection,
 * kept as a pure function so it is trivially testable and has no opinion about
 * where the rows came from.
 *
 * It is read-only and lossy on purpose: the new model carries far more (state
 * machine, versions, the assignment/run chain) than the flat legacy job, so only
 * the handful of fields the dashboard renders are mapped. Presentation-only bits
 * the old queue carried (`eta`, `at`) live in `task.metadata`.
 */

/** One open queue row: the entry, its task, and the task's artifact when it has one. */
export interface QueueProjectionRow {
  entry: QueueEntry;
  task: PrintTask;
  artifact: Artifact | null;
}

function metaString(task: PrintTask, key: string): string | undefined {
  const value = task.metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * A held entry or a task parked for the operator shows as `review`. `ready` is
 * shown ONLY for the one healthy combination — task `QUEUED` + entry `WAITING`.
 * Every other combination (a terminal/in-flight task still holding an open
 * entry) is inconsistent or transitional data: it projects as `review` with a
 * diagnostic reason, never as a guessed `ready` — corrupted state must be
 * visible, not startable.
 */
function toStatus(task: PrintTask, entry: QueueEntry): QueueJobStatus {
  if (entry.state === "HELD" || task.state === "NEEDS_REVIEW") return "review";
  if (task.state === "QUEUED" && entry.state === "WAITING") return "ready";
  return "review";
}

/** A diagnostic label for a task/entry combination that should not exist. */
function inconsistencyReason(task: PrintTask, entry: QueueEntry): string | null {
  if (entry.state === "HELD" || task.state === "NEEDS_REVIEW") return null;
  if (task.state === "QUEUED" && entry.state === "WAITING") return null;
  if (task.state === "ASSIGNED" || task.state === "DISPATCHING" || task.state === "PRINTING") {
    return `задание запускается/печатается (${task.state}) — строка очереди ещё не закрыта`;
  }
  return `несогласованное состояние: задание ${task.state}, запись очереди ${entry.state} — требуется проверка`;
}

export function toLegacyQueueJob(row: QueueProjectionRow): QueueJob {
  const { task, entry, artifact } = row;
  const status = toStatus(task, entry);
  const file = artifact?.source ?? metaString(task, "file");

  const job: QueueJob = {
    id: task.id,
    title: task.title,
    printer: task.targetPrinter ?? "—",
    material: task.material ?? "—",
    eta: metaString(task, "eta") ?? "—",
    status
  };

  const at = metaString(task, "at") ?? (status === "ready" ? "в очереди" : undefined);
  if (at) job.at = at;
  if (task.night) job.night = true;
  const diagnostic = inconsistencyReason(task, entry);
  if (diagnostic) job.reason = diagnostic;
  else if (task.reason) job.reason = task.reason;
  if (file) job.file = file;
  return job;
}

/** Projects a set of open queue rows (already ordered) into the legacy array. */
export function toLegacyQueue(rows: readonly QueueProjectionRow[]): QueueJob[] {
  return rows.map(toLegacyQueueJob);
}
