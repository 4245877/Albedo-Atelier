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
  /** Source artifact; null for a bare title-only task (legacy import, drafts). */
  artifactId: string | null;
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
  /** The plan this one was recomputed from (its predecessor revision); null for the first. */
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

/**
 * Binds a {@link PrintTask} to a printer (and optionally a {@link Plan} and the
 * {@link BedCycle} it occupies). This is the middle link of the durable chain
 * `PrintTask → Assignment → DispatchAttempt → PrintRun`: one task may accrue
 * several assignments over its life (re-assigned after a failure), and each is
 * kept.
 */
export interface Assignment {
  id: string;
  taskId: string;
  printerId: string;
  planId: string | null;
  /** The bed cycle this assignment reserved/ran on; null until it reserves one. */
  bedCycleId: string | null;
  state: AssignmentState;
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

// ── PrintRun ─────────────────────────────────────────────────────────────────

/**
 * The state of an *actual* print on the machine, as observed. `UNKNOWN` covers
 * a run whose outcome could not be observed (offline during completion,
 * restart mid-print). Terminal: `SUCCEEDED`/`FAILED`/`CANCELLED`.
 */
export type PrintRunState =
  | "RUNNING"
  | "PAUSED"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN";

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
  | "profile_revision"
  | "profile_set"
  | "slice_variant";

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
