/**
 * The persistent print-queue domain model.
 *
 * This is the durable backbone the operator queue is being grown into: instead
 * of a single JSON blob of throwaway "jobs", the work is modelled as a set of
 * long-lived entities whose *state* is tracked explicitly and never destroyed
 * once a print has been launched. The three concerns the brief keeps separate
 * live in three different entities:
 *
 *   - the **task** state       → {@link PrintTask.state}
 *   - the **assignment** state → {@link Assignment.state}
 *   - the **actual print** state → {@link PrintRun.state}
 *
 * and the chain `PrintTask → Assignment → DispatchAttempt → PrintRun` is kept
 * intact by foreign keys, so the history of *how* a task was launched survives.
 *
 * Every entity below is a plain data record — no behaviour, no SQLite. The
 * transition rules live in {@link file://./states.ts}, the storage ports in
 * {@link file://./repositories.ts}, and the SQLite implementations under
 * `infra/db`. The domain layer never imports `node:sqlite`.
 */

/** ISO-8601 timestamp string (UTC), the single time representation in the model. */
export type IsoTimestamp = string;

/**
 * Free-form structured metadata attached to an entity, persisted as a JSON
 * column. `unknown`-valued so callers must narrow before use — never `any`.
 */
export type Metadata = Record<string, unknown>;

// ── Artifact ───────────────────────────────────────────────────────────────

/**
 * What kind of thing an {@link Artifact} points at. `gcode` is a ready-to-print
 * file already on (or destined for) a printer; `model` is an un-sliced source
 * (STL/3MF) awaiting analysis; `unknown` covers legacy/imported records whose
 * kind was never recorded. File *upload* and slicing are out of scope for this
 * stage — an artifact is only a reference plus whatever metadata we already have.
 */
export type ArtifactKind = "gcode" | "model" | "unknown";

/**
 * A printable input: a reference to a file/model plus identifying metadata.
 * Deliberately storage-agnostic — `source` is an opaque locator (a printer-side
 * file name today, an uploaded blob key later); the bytes are not owned here.
 */
export interface Artifact {
  id: string;
  kind: ArtifactKind;
  /** Human-facing name (defaults to the file/model basename). */
  name: string;
  /** Opaque locator: the on-printer file path today, a blob key in future. */
  source: string | null;
  sizeBytes: number | null;
  /** Content hash when known; enables dedup/analysis reuse later. */
  sha256: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  version: number;
  /** Original id from an imported legacy record; null for natively-created rows. */
  legacyRef: string | null;
  metadata: Metadata;
}

// ── ArtifactAnalysis ─────────────────────────────────────────────────────────

/**
 * The **technical** state of the analysis job (deliberately kept separate from
 * its {@link AnalysisVerdict result}): `pending` — queued/awaiting a worker;
 * `running` — a worker is analysing it now; terminal `ready` (a verdict was
 * produced) / `failed` (the analyzer itself errored/timed out). A `pending` or
 * `running` row left behind by a crash is recovered on the next boot.
 */
export type ArtifactAnalysisState = "pending" | "running" | "ready" | "failed";

/**
 * The **format** the analyzer actually determined the bytes to be — from magic
 * bytes and internal structure, never from the file name alone. `unknown` is a
 * file whose content matches no supported format (or contradicts its extension).
 */
export type DetectedFormat = "stl" | "3mf" | "gcode" | "unknown";

/**
 * The **result** of a completed analysis — what should happen to the file next.
 * Distinct from {@link ArtifactAnalysisState}: an analysis can be technically
 * `ready` while its verdict is `blocked`. Values:
 *   - `needs_preparation` — a valid source model (STL / generic 3MF) that still
 *     needs a profile + slicing before it can be scheduled;
 *   - `schedulable` — a sliced file with enough data and no critical problem
 *     (fit for *planning* only — not an authorisation to auto-start);
 *   - `needs_input` — usable but missing operator input (material, units, …);
 *   - `review` — unknown/foreign/potentially-unsafe parameters need a human;
 *   - `blocked` — corrupt, format-mismatched, or carrying a critical problem.
 */
export type AnalysisVerdict =
  | "needs_preparation"
  | "schedulable"
  | "needs_input"
  | "review"
  | "blocked";

/**
 * One structured warning or blocker from an analyzer. `code` is a stable machine
 * key the dashboard/tests branch on; `message` is the operator-facing text.
 */
export interface AnalysisFinding {
  code: string;
  message: string;
}

/**
 * The result of analysing an {@link Artifact} — the detected format, a
 * pass/fail-style {@link AnalysisVerdict verdict}, structured warnings/blockers,
 * and whatever slicing estimates/geometry the analyzer could extract. The
 * built-in analyzers (STL / 3MF / G-code) write this; nothing fabricates
 * estimates for an un-sliced model.
 */
export interface ArtifactAnalysis {
  id: string;
  artifactId: string;
  state: ArtifactAnalysisState;
  /** Content-verified format; null until the analysis reaches `ready`/`failed`. */
  detectedFormat: DetectedFormat | null;
  /** The analysis result; null while `pending`/`running` and on `failed`. */
  verdict: AnalysisVerdict | null;
  /** Which analyzer produced this (e.g. "stl", "gcode", "3mf"); null until one runs. */
  analyzer: string | null;
  /** The analyzer's own version, so a re-analysis after an upgrade is comparable. */
  analyzerVersion: string | null;
  estimatedDurationS: number | null;
  estimatedFilamentG: number | null;
  material: string | null;
  nozzleDiameterMm: number | null;
  layerHeightMm: number | null;
  /** Non-blocking findings (units ambiguous, unknown command, …). */
  warnings: AnalysisFinding[];
  /** Critical findings that force `review`/`blocked` (corrupt, path traversal, …). */
  blockers: AnalysisFinding[];
  /** Analyzer-specific structured payload (bbox, slicer, plate data, …). */
  data: Metadata;
  /** Failure detail when `state === "failed"`. */
  error: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  version: number;
  metadata: Metadata;
}

// ── PrintTask ────────────────────────────────────────────────────────────────

/**
 * The lifecycle of a unit of work. Kept strictly separate from assignment and
 * run state: a task is `PRINTING` because a run it owns is live, not because it
 * holds any device itself. Terminal states (`COMPLETED`/`FAILED`/`CANCELLED`)
 * are never deleted — a launched task lives on as history.
 */
export type PrintTaskState =
  | "DRAFT"
  | "QUEUED"
  | "PLANNED"
  | "ASSIGNED"
  | "DISPATCHING"
  | "PRINTING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "NEEDS_REVIEW";

/**
 * The operator's day/night scheduling intent for a task. `any` — the planner may
 * place it whenever a printer is free; `day` — prefer attended (daytime) hours;
 * `night` — a candidate for the night batch (still only *recommended*, never
 * auto-started, and only when {@link PrintTask.unattendedAllowed} is set and every
 * night gate passes). Purely a planning/theme hint — not an authorisation to run.
 */
export type DayNightPreference = "any" | "day" | "night";

/**
 * A durable print job: the operator's intent plus its current lifecycle state.
 * Holds only *hints* about where/what to print (`targetPrinter`, `material`) —
 * the actual binding to a device is an {@link Assignment}, so a task can be
 * re-planned or re-assigned without losing its identity or history.
 */
export interface PrintTask {
  id: string;
  /**
   * The **executable** artifact: the sliced output once a slice has been
   * promoted, the uploaded G-code for a ready-file task, the source model while
   * the task is still a draft. This is what a dispatch would send.
   */
  artifactId: string | null;
  /**
   * The exact {@link SliceVariant} the executable artifact came from; null for a
   * task whose file was uploaded ready-made or created before slicing existed.
   * A typed column (not `metadata`) so the queue is bound to a *slice*, not to a
   * file name — the whole point of the slice→queue handoff.
   */
  sliceVariantId: string | null;
  /** The source model (STL/3MF) the slice was produced from; null when there was none. */
  sourceArtifactId: string | null;
  /** The on-device path a dispatch will start; null until a file is bound. */
  onDeviceFile: string | null;
  title: string;
  /** Operator-stated material requirement; null when unspecified. */
  material: string | null;
  /** Preferred printer name/id hint (not a binding — that's an Assignment). */
  targetPrinter: string | null;
  /** Higher runs earlier within the queue ordering; default 0. */
  priority: number;
  state: PrintTaskState;
  /** Why the task is where it is (review reason, failure cause); operator-facing. */
  reason: string | null;
  /** Marked as a night-print candidate. */
  night: boolean;
  /** Earliest ISO time the task may start; null = no lower bound. */
  notBefore: IsoTimestamp | null;
  /** ISO time the task should be finished by; null = no deadline. */
  deadline: IsoTimestamp | null;
  /** Day/night scheduling preference; default `any`. */
  dayNightPreference: DayNightPreference;
  /** Hard binding to one printer id — the planner must place it there or not at all. Null = unpinned. */
  pinnedPrinterId: string | null;
  /** Explicit permission for an unattended (bed-not-cleared) night recommendation. */
  unattendedAllowed: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  version: number;
  legacyRef: string | null;
  metadata: Metadata;
}

// ── QueueEntry ───────────────────────────────────────────────────────────────

/**
 * `WAITING` — eligible to be planned/assigned; `HELD` — parked by the operator
 * (kept in the queue but skipped). A task leaves the queue by having its entry
 * `RELEASED` (dispatched/cancelled) — the task row itself is never removed.
 */
export type QueueEntryState = "WAITING" | "HELD" | "RELEASED";

/**
 * A task's membership and position in the queue. Split out from {@link PrintTask}
 * because ordering is a separate, contended concern: two operators reordering
 * the queue race on these rows, so this is where {@link QueueEntry.version}
 * (optimistic concurrency) earns its keep.
 */
export interface QueueEntry {
  id: string;
  taskId: string;
  /** Sort key; lower = nearer the front. Sparse (gaps allowed) to ease reordering. */
  position: number;
  state: QueueEntryState;
  enqueuedAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  version: number;
}

// ── Plan ─────────────────────────────────────────────────────────────────────

/** `DRAFT` → `ACTIVE` → terminal `COMPLETED`/`CANCELLED`. */
export type PlanState = "DRAFT" | "ACTIVE" | "COMPLETED" | "CANCELLED";

/**
 * A grouping of assignments scheduled together — e.g. a night batch across the
 * farm. Auto-planning is out of scope for this stage; a Plan can still be
 * created and its assignments attached manually. Versioned because a plan is a
 * contended, edited-in-place aggregate.
 */
export interface Plan {
  id: string;
  name: string | null;
  /** Optional scheduling window label (e.g. "21:30 – 07:30"). */
  window: string | null;
  state: PlanState;
  /**
   * Revision counter within a plan lineage. A recompute never edits a plan in
   * place: it supersedes the previous draft with a fresh DRAFT whose `revision`
   * is one higher — so a confirmed plan is immutable and its history survives.
   */
  revision: number;
  /**
   * The plan this one was recomputed from (its predecessor revision); null for the
   * first. Note: unlike `assignments.plan_id`, this column carries no SQL foreign
   * key — it was added by `ALTER TABLE` in 004, and SQLite cannot add a FK to an
   * existing table without a full table rebuild. The risk is only theoretical
   * (plans are never deleted, so the reference cannot dangle); rebuild the table to
   * add the constraint if plan deletion is ever introduced.
   */
  basePlanId: string | null;
  /** When the operator confirmed it (DRAFT → ACTIVE); null while still a draft. */
  confirmedAt: IsoTimestamp | null;
  /** Who confirmed it; null while still a draft. */
  confirmedBy: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  version: number;
  metadata: Metadata;
}

// ── Assignment ───────────────────────────────────────────────────────────────

/**
 * `PROPOSED` — bound to a printer but not yet holding the bed; `RESERVED` — the
 * bed is reserved for it; `ACTIVE` — a run is (or was) live on it; terminal
 * `RELEASED`/`CANCELLED`. Assignment state is about *the binding to a device*,
 * distinct from both the task lifecycle and the actual print.
 */
export type AssignmentState = "PROPOSED" | "RESERVED" | "ACTIVE" | "RELEASED" | "CANCELLED";

/** Where an assignment came from — the provenance a dispatch and the UI branch on. */
export type AssignmentSource = "plan" | "manual" | "dispatch";

/**
 * The **executable binding** of an assignment: exactly *what* is to be printed,
 * pinned at the moment the assignment was created or confirmed.
 *
 * This is the structure the brief calls for in place of "profile revision IDs
 * that are only checked when the planner happened to write them into
 * `assignment.metadata`". Every field is a typed column (migration 009), so the
 * dispatch can verify the file it is about to send is the one that was planned,
 * and a divergence is a refusal rather than an unnoticed substitution.
 *
 * `null` in any field means "not known at binding time" — never "does not
 * matter": the eligibility check treats a known value as a hard constraint and
 * an unknown one as an unresolved fact (fail-closed for unattended starts).
 */
export interface AssignmentBinding {
  /** The exact slice variant this assignment executes; null for a ready-file task. */
  sliceVariantId: string | null;
  /** The executable artifact (sliced output / uploaded G-code). */
  artifactId: string | null;
  /** Its content hash, captured when the binding was made (immutable identity). */
  artifactSha256: string | null;
  machineRevisionId: string | null;
  processRevisionId: string | null;
  filamentRevisionId: string | null;
  /** Where the file is expected to live on the device. */
  expectedRemotePath: string | null;
  gcodeFlavor: string | null;
  nozzleMm: number | null;
  material: string | null;
  /** Expected print duration in seconds (slicer ETA / analysis), when known. */
  etaS: number | null;
  /** Scheduled start from the plan; null for a manual assignment. */
  plannedStartAt: IsoTimestamp | null;
  /** The plan revision this binding was computed under; null outside a plan. */
  planRevision: number | null;
}

/** An empty binding — every field unknown. */
export const EMPTY_ASSIGNMENT_BINDING: AssignmentBinding = {
  sliceVariantId: null,
  artifactId: null,
  artifactSha256: null,
  machineRevisionId: null,
  processRevisionId: null,
  filamentRevisionId: null,
  expectedRemotePath: null,
  gcodeFlavor: null,
  nozzleMm: null,
  material: null,
  etaS: null,
  plannedStartAt: null,
  planRevision: null
};

/**
 * Binds a {@link PrintTask} to a printer (and optionally a {@link Plan} and the
 * {@link BedCycle} it occupies). This is the middle link of the durable chain
 * `PrintTask → Assignment → DispatchAttempt → PrintRun`: one task may accrue
 * several assignments over its life (re-assigned after a failure), and each is
 * kept.
 *
 * An assignment is **executable data**, not a recommendation: together with its
 * {@link AssignmentBinding} it names the printer, the slice and the file bytes a
 * dispatch must use. An assignment whose task changed underneath it is marked
 * {@link Assignment.invalidatedAt invalidated} rather than silently executed.
 */
export interface Assignment {
  id: string;
  taskId: string;
  printerId: string;
  planId: string | null;
  /** The bed cycle this assignment reserved/ran on; null until it reserves one. */
  bedCycleId: string | null;
  state: AssignmentState;
  /** What produced it: a confirmed plan, an operator, or the dispatch itself. */
  source: AssignmentSource;
  /** Why this printer was chosen (operator justification / planner reason). */
  reason: string | null;
  /** Who created it; null for system-created rows. */
  createdBy: string | null;
  binding: AssignmentBinding;
  /** When the binding stopped matching the task; null while it is still valid. */
  invalidatedAt: IsoTimestamp | null;
  invalidatedReason: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  version: number;
  legacyRef: string | null;
  metadata: Metadata;
}

// ── BedCycle ─────────────────────────────────────────────────────────────────

/**
 * The physical print-bed occupancy lifecycle for one printer, exactly as the
 * brief specifies:
 *
 *   CLEAR → RESERVED → RUNNING → AWAITING_CLEARANCE → CLEAR
 *
 * plus {@link BedCycleState UNKNOWN} for when the real state is lost (sensor
 * gap, restart mid-print, manual intervention) and must be recovered before the
 * bed can be trusted again.
 */
export type BedCycleState =
  | "CLEAR"
  | "RESERVED"
  | "RUNNING"
  | "AWAITING_CLEARANCE"
  | "UNKNOWN";

/**
 * One occupancy cycle of a printer's bed. A new cycle is opened when the bed is
 * reserved and closed (`CLEAR` + `clearedAt`) once the operator confirms the
 * previous print was removed — the guarantee that a printer is not started onto
 * a bed that still holds the last part.
 */
export interface BedCycle {
  id: string;
  printerId: string;
  state: BedCycleState;
  /** The assignment currently occupying the bed; null when CLEAR/UNKNOWN. */
  assignmentId: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  /** Set when the cycle returns to CLEAR (bed confirmed empty). */
  clearedAt: IsoTimestamp | null;
  version: number;
  metadata: Metadata;
}

// ── DispatchAttempt ──────────────────────────────────────────────────────────

/**
 * `PENDING` — recorded, not yet sent; `SENT` — a start command left the
 * orchestrator; terminal `ACKED` (device accepted) / `FAILED`. Remote start is
 * out of scope for this stage, so attempts are *recorded* here for the future
 * dispatcher to drive — nothing in this stage actually talks to a device.
 */
export type DispatchAttemptState = "PENDING" | "SENT" | "ACKED" | "FAILED";

/**
 * One attempt to launch an {@link Assignment} on its printer. Append-only per
 * attempt (a retry is a new row with a higher {@link DispatchAttempt.attemptNo}),
 * so the full launch history is preserved — the third link of the chain.
 */
export interface DispatchAttempt {
  id: string;
  assignmentId: string;
  taskId: string;
  printerId: string;
  /** 1-based attempt counter within the assignment. */
  attemptNo: number;
  state: DispatchAttemptState;
  /** Failure detail when `state === "FAILED"`. */
  error: string | null;
  requestedAt: IsoTimestamp;
  /** When the attempt reached a terminal state; null while in flight. */
  completedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  version: number;
  metadata: Metadata;
}

// ── DeviceArtifact ───────────────────────────────────────────────────────────

/**
 * The state of the *file on the printer* — deliberately a separate axis from
 * the task, the assignment and the run, because "the slice is ready" and "the
 * bytes are on that machine" are different facts and conflating them is how a
 * dispatch ends up starting a file that is absent or stale.
 *
 * The happy path and the three distinct ways it can end:
 *
 *   NOT_PRESENT → UPLOADING → PRESENT_UNVERIFIED → VERIFIED
 *                     ↓              ↓                ↓
 *                  FAILED         INVALID          STALE
 *
 *  - `FAILED`  — the *transfer* did not complete (device refused, network died).
 *    The bytes are not known to be there; a retry may simply re-upload.
 *  - `INVALID` — the bytes *are* (or were) there but do not match the artifact:
 *    missing after upload, wrong size. Never startable, retry re-uploads.
 *  - `STALE`   — the record was valid for something that is no longer what we
 *    would print: a new slice variant, a different content hash, another
 *    printer/path, a changed profile set or a withdrawn assignment. The file on
 *    the device may be perfectly intact — it is simply not *this* job's file.
 *
 * Only `VERIFIED` authorises a start. Everything else — including
 * `PRESENT_UNVERIFIED`, which means "something is there but we have not matched
 * it yet" — is a refusal.
 */
export type DeviceArtifactState =
  | "NOT_PRESENT"
  | "UPLOADING"
  | "PRESENT_UNVERIFIED"
  | "VERIFIED"
  | "INVALID"
  | "FAILED"
  | "STALE";

/**
 * How the bytes got onto the device. `adapter_upload` — the orchestrator pushed
 * them over the adapter's file API; `manual_file_transfer` — the adapter has no
 * upload API (Bambu, Creality WS), so an operator copied the file and confirmed
 * it. There is no third, pretend-automatic mode.
 */
export type DeviceTransferMode = "adapter_upload" | "manual_file_transfer";

/**
 * How strongly the on-device file was matched against the registered artifact.
 * Recorded honestly: no adapter in this farm exposes a content hash, so
 * `name_and_size` (Moonraker's listing) is the strongest evidence available and
 * is never dressed up as a cryptographic check.
 */
export type DeviceVerification = "name_and_size" | "name_only" | "operator_confirmed";

/**
 * One tracked file on one printer: the link between a {@link SliceVariant}'s
 * output and the bytes a start command will actually execute. Keyed in storage
 * by `(printerId, remotePath)` — the physical slot — so a re-upload of the same
 * slice updates the record instead of accumulating duplicates.
 */
export interface DeviceArtifact {
  id: string;
  printerId: string;
  /** The assignment this delivery was prepared for; null for an ad-hoc record. */
  assignmentId: string | null;
  sliceVariantId: string | null;
  artifactId: string | null;
  /** The artifact's content hash — what the file *should* be. */
  artifactSha256: string | null;
  /** Normalized path on the device (relative to its G-code root). */
  remotePath: string;
  sizeBytes: number | null;
  state: DeviceArtifactState;
  transferMode: DeviceTransferMode;
  /** Null until the file reaches `PRESENT_UNVERIFIED`/`VERIFIED`. */
  verification: DeviceVerification | null;
  uploadedAt: IsoTimestamp | null;
  verifiedAt: IsoTimestamp | null;
  /** Operator who confirmed a manual transfer; null otherwise. */
  confirmedBy: string | null;
  /** Failure/staleness detail for `FAILED`/`INVALID`/`STALE` (or the last failed attempt). */
  lastError: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  version: number;
  metadata: Metadata;
}

// ── StartGuard ───────────────────────────────────────────────────────────────

/**
 * Durable state of one physical start-of-print intent, tracked so a single
 * operator/queue command can produce **at most one** physical print even across
 * lost Moonraker responses, retries and process restarts.
 *
 *   - `SENT`    — the intent was recorded and a start command left the
 *     orchestrator, but no outcome is known yet (written *before* dispatch).
 *   - `ACKED`   — the device accepted the start (HTTP 2xx). The guard is kept
 *     until the originating queue job has been *durably* removed, so a crash in
 *     that window cannot re-dispatch it.
 *   - `UNKNOWN` — the response was lost/timed out or the device answered
 *     ambiguously. Fail-closed: the printer is held and never auto-restarted;
 *     the next attempt reconciles against the real device state.
 *
 * A definitive device rejection (e.g. file-not-found 404, connection refused)
 * deletes the guard instead — nothing was started, so a retry is safe.
 */
export type StartGuardState = "SENT" | "ACKED" | "UNKNOWN";

/** One outstanding (unreconciled) start intent, keyed by printer. */
export interface StartGuard {
  printerId: string;
  /** The normalized on-device file the start was for. */
  file: string;
  state: StartGuardState;
  /**
   * The legacy queue job this start originated from, when any — so a boot-time
   * sweep can drop a guard whose job is already gone, and the queue flow knows
   * which job to remove. `null` for a direct operator start (no queue job).
   */
  jobRef: string | null;
  /**
   * The canonical {@link PrintRun} this guard protects (dispatch-created runs);
   * `null` for direct operator starts that have no run. Guard and run are
   * recovered *together* after a restart: an unreconciled guard keeps its run
   * PENDING/UNKNOWN, and neither is resolved without device evidence.
   */
  runId: string | null;
  requestedAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

// ── PrintRun ─────────────────────────────────────────────────────────────────

/**
 * The state of an *actual* print on the machine, as observed. `PENDING` is a
 * run *reserved inside the dispatch transaction* before the physical command is
 * sent — the durable record that a start is about to leave (or has left with an
 * unconfirmed outcome). `UNKNOWN` covers a run whose outcome could not be
 * observed (lost response, offline during completion, restart mid-print); it is
 * never auto-resolved — reconciliation against the live device or the operator
 * decides. Terminal: `SUCCEEDED`/`FAILED`/`CANCELLED`.
 */
export type PrintRunState =
  | "PENDING"
  | "RUNNING"
  | "PAUSED"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN";

/** Run states that hold a printer / block a second dispatch. */
export const ACTIVE_RUN_STATES: readonly PrintRunState[] = [
  "PENDING",
  "RUNNING",
  "PAUSED",
  "UNKNOWN"
];

/**
 * A single physical execution of a task on a printer — the last link of the
 * chain. Separate from the task and assignment so the observed reality (start,
 * pause, finish, filament used) is recorded independently of the intent, and a
 * task with a failed run can spawn a fresh assignment + run without rewriting
 * history.
 */
export interface PrintRun {
  id: string;
  taskId: string;
  assignmentId: string;
  /** The dispatch attempt that launched this run; null for observed/legacy runs. */
  dispatchAttemptId: string | null;
  printerId: string;
  bedCycleId: string | null;
  state: PrintRunState;
  /** The normalized on-device file path this run's start command named. */
  file: string | null;
  /** The registered artifact the dispatch decision was based on; null for legacy/observed runs. */
  artifactId: string | null;
  /** The artifact's content hash captured at dispatch time (immutable identity). */
  artifactSha256: string | null;
  /** Caller-supplied dispatch idempotency key; a repeat returns this run, never a second one. */
  idempotencyKey: string | null;
  startedAt: IsoTimestamp | null;
  endedAt: IsoTimestamp | null;
  /** 0..1 progress when known. */
  progress: number | null;
  filamentUsedG: number | null;
  durationS: number | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  version: number;
  legacyRef: string | null;
  metadata: Metadata;
}

// ── MaterialOverride ─────────────────────────────────────────────────────────

/**
 * An operator's manual assertion about a printer's remaining filament, standing in
 * for the remaining-material telemetry the farm does not have. It is the only
 * source that can satisfy the night gate's "enough material" criterion: without one
 * the gate honestly reports the remainder as unknown and refuses the candidate.
 *
 * Deliberately explicit and expiring: it records *who* asserted it and *until when*
 * ({@link expiresAt}), and — when the operator gave a figure — for how many print
 * hours the loaded spool is believed to last ({@link coverageHours}). A print is
 * only considered covered when its (buffered) ETA fits inside that coverage.
 */
export interface MaterialOverride {
  id: string;
  /** The farm printer id this assertion is about. */
  printerId: string;
  /** The operator's verdict: true = enough loaded, false = explicitly not enough. */
  sufficient: boolean;
  /** Believed print-hours the loaded spool lasts; null = a blanket "enough" with no figure. */
  coverageHours: number | null;
  note: string | null;
  /** Who asserted it (operator name/id); null when not recorded. */
  author: string | null;
  createdAt: IsoTimestamp;
  /** When the assertion stops counting; null = no expiry (stands until replaced). */
  expiresAt: IsoTimestamp | null;
  version: number;
  metadata: Metadata;
}

// ── AuditEvent ───────────────────────────────────────────────────────────────

/** The entities an {@link AuditEvent} can be about. */
export type AuditEntityType =
  | "artifact"
  | "artifact_analysis"
  | "print_task"
  | "queue_entry"
  | "plan"
  | "assignment"
  | "bed_cycle"
  | "dispatch_attempt"
  | "print_run"
  | "material_override"
  | "profile_revision"
  | "profile_set"
  | "slice_variant"
  | "device_artifact";

/**
 * An append-only record of a domain change — every state transition and
 * significant action lands here, preserving the security/journalling guarantee
 * the JSON event feed gave, but structured and queryable. Never updated or
 * deleted; carries no optimistic version.
 */
export interface AuditEvent {
  id: string;
  at: IsoTimestamp;
  entityType: AuditEntityType;
  entityId: string;
  /** Short action verb, e.g. "created", "transition", "enqueued". */
  action: string;
  /** State before a transition; null for non-transition actions. */
  fromState: string | null;
  toState: string | null;
  /** Who/what caused it (operator, "system", a module name); null when unknown. */
  actor: string | null;
  detail: Metadata;
}
