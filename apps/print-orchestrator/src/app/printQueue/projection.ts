import type { QueueJob, QueueJobStatus } from "../../domain/dashboard/types";
import type {
  Artifact,
  ArtifactAnalysis,
  Assignment,
  PrintRun,
  PrintTask,
  QueueEntry
} from "../../domain/print/types";

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
  /**
   * Latest analysis of the task's artifact, when one exists.
   *
   * The task's own `material` / `metadata.eta` are *operator-stated* fields and
   * are routinely null for anything the pipeline produced itself: a sliced task
   * gets its material, nozzle, duration and filament weight from analysing the
   * G-code, not from someone typing them in. Reading only the task is what made
   * a fully-analysed job render as `— · —` while its analysis held
   * "PETG, 0.4 mm, 1 h 29 m, 31.1 g".
   */
  analysis?: ArtifactAnalysis | null;
  /**
   * The assignment that would execute this task, when one is on file. Its
   * binding is the most specific truth available — it names the exact printer,
   * material, nozzle and ETA the slice was actually produced for.
   */
  assignment?: Assignment | null;
  /**
   * The task's active run, when one exists. Needed here for one distinction the
   * flat status cannot otherwise make: a run that was dispatched but never
   * confirmed started looks exactly like a live print from the task's side
   * (`DISPATCHING`), while physically nothing is happening and the operator —
   * not the poller — is the only one who can say so.
   */
  run?: PrintRun | null;
}

/**
 * A run that holds the printer without ever having begun: the start command was
 * accepted, the confirmation never came. `startedAt === null` is the load-bearing
 * half — a run with a start time was observed printing, whatever it is doing now.
 */
function isUnconfirmedStart(run: PrintRun | null | undefined): run is PrintRun {
  return Boolean(
    run && run.startedAt === null && (run.state === "PENDING" || run.state === "UNKNOWN")
  );
}

function metaString(task: PrintTask, key: string): string | undefined {
  const value = task.metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A positive finite number, or null — analyses may carry 0/NaN for "unknown". */
function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** `5329` → `≈ 1 ч 29 мин`. Duration is shown, never invented: null stays null. */
export function formatEta(seconds: number | null): string | null {
  const total = positive(seconds);
  if (total === null) return null;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `≈ ${minutes} мин`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `≈ ${h} ч` : `≈ ${h} ч ${m} мин`;
}

/**
 * A held entry or a task parked for the operator shows as `review`. `ready` is
 * shown ONLY for the one healthy combination — task `QUEUED` + entry `WAITING`.
 * Every other combination (a terminal/in-flight task still holding an open
 * entry) is inconsistent or transitional data: it projects as `review` with a
 * diagnostic reason, never as a guessed `ready` — corrupted state must be
 * visible, not startable.
 */
function toStatus(task: PrintTask, entry: QueueEntry, run?: PrintRun | null): QueueJobStatus {
  // Checked before everything else: an unconfirmed start is the one state where
  // the operator's next move is neither "start it" nor "wait for it", and the
  // row must say so in its own words. Folding it into `review` (as this did)
  // hid the only action that can clear it.
  if (isUnconfirmedStart(run)) return "unconfirmed";
  if (entry.state === "HELD" || task.state === "NEEDS_REVIEW") return "review";
  if (task.state === "QUEUED" && entry.state === "WAITING") return "ready";
  return "review";
}

/** A diagnostic label for a task/entry combination that should not exist. */
function inconsistencyReason(
  task: PrintTask,
  entry: QueueEntry,
  run?: PrintRun | null
): string | null {
  // Not an inconsistency: a real, named situation with a known remedy. The old
  // text ("строка очереди ещё не закрыта") described the database to an operator
  // who needed to be told to go look at the printer.
  if (isUnconfirmedStart(run)) {
    return `принтер не подтвердил запуск «${run.file}» — посмотрите на принтер и отметьте, что произошло`;
  }
  if (entry.state === "HELD" || task.state === "NEEDS_REVIEW") return null;
  if (task.state === "QUEUED" && entry.state === "WAITING") return null;
  if (task.state === "ASSIGNED" || task.state === "DISPATCHING" || task.state === "PRINTING") {
    return `задание запускается/печатается (${task.state}) — строка очереди ещё не закрыта`;
  }
  return `несогласованное состояние: задание ${task.state}, запись очереди ${entry.state} — требуется проверка`;
}

export function toLegacyQueueJob(row: QueueProjectionRow): QueueJob {
  const { task, entry, artifact } = row;
  const analysis = row.analysis ?? null;
  const binding = row.assignment?.binding ?? null;
  const run = row.run ?? null;
  const status = toStatus(task, entry, run);
  const file = artifact?.source ?? metaString(task, "file");

  // Precedence is most-specific-first, and every source is a *fact* rather than a
  // guess: the assignment binding (what the slice was built for) beats the
  // operator's stated field, which beats the analysis read off the file itself.
  const material = binding?.material ?? task.material ?? analysis?.material ?? null;
  const nozzleMm = positive(binding?.nozzleMm ?? analysis?.nozzleDiameterMm ?? null);
  const etaSeconds = positive(binding?.etaS ?? analysis?.estimatedDurationS ?? null);
  const filamentG = positive(analysis?.estimatedFilamentG ?? null);

  const job: QueueJob = {
    id: task.id,
    title: task.title,
    printer: task.pinnedPrinterId ?? task.targetPrinter ?? "—",
    material: material ?? "—",
    eta: metaString(task, "eta") ?? formatEta(etaSeconds) ?? "—",
    status
  };

  // Machine-readable companions to the display strings above, so the dashboard
  // can format/compare without re-parsing "≈ 1 ч 29 мин". Omitted when unknown —
  // absent means "not measured", which is not the same as zero.
  if (nozzleMm !== null) job.nozzleMm = nozzleMm;
  if (etaSeconds !== null) job.etaSeconds = etaSeconds;
  if (filamentG !== null) job.filamentG = filamentG;
  if (row.assignment) job.assignmentId = row.assignment.id;
  // The id the resolution needs. Present exactly when `status` is `unconfirmed`,
  // so the client never has to infer "is there a decision to make" from prose.
  if (isUnconfirmedStart(run)) job.unresolvedRunId = run.id;

  const at = metaString(task, "at") ?? (status === "ready" ? "в очереди" : undefined);
  if (at) job.at = at;
  if (task.night) job.night = true;
  const diagnostic = inconsistencyReason(task, entry, run);
  if (diagnostic) job.reason = diagnostic;
  else if (task.reason) job.reason = task.reason;
  if (file) job.file = file;
  return job;
}

/** Projects a set of open queue rows (already ordered) into the legacy array. */
export function toLegacyQueue(rows: readonly QueueProjectionRow[]): QueueJob[] {
  return rows.map(toLegacyQueueJob);
}
