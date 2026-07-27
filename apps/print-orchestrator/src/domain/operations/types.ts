/**
 * The **operator** half of the print model: when a human is actually there, and
 * what they physically have to do before a printer can run again.
 *
 * Everything else in this codebase models machines — files, slices, beds, runs.
 * None of it can answer the question a farm actually turns on: *the print
 * finished at 03:00, so when does that printer become usable again?* The answer
 * is not "03:00". It is "when an operator is awake, present, and has taken the
 * part off the plate" — and that is a schedule plus a typed, confirmable task.
 *
 * Two entity groups live here:
 *
 *  - the **schedule** ({@link Operator}, {@link ScheduleRule},
 *    {@link ScheduleException}, {@link OperatorAbsence}) — a timezone-anchored
 *    weekly availability calendar with a separate sleep track, date overrides
 *    and absences;
 *  - the **work** ({@link ManualOperation}) — one typed physical intervention
 *    with its own lifecycle, duration, allowed window and audit trail.
 *
 * Plain data records, exactly like `domain/print/types`: no behaviour, no
 * SQLite. Transition rules live in {@link file://./states.ts}, the pure
 * schedule arithmetic in {@link file://./schedule.ts}, the storage ports in
 * {@link file://./repositories.ts}.
 */

import type { IsoTimestamp, Metadata } from "../print/types";

export type { IsoTimestamp, Metadata } from "../print/types";

// ── Operator ─────────────────────────────────────────────────────────────────

/**
 * A person who can perform {@link ManualOperation}s.
 *
 * The farm has exactly one operator today, but the model is multi-operator from
 * the start because the two rules that matter are *per person*: "one operator
 * cannot run two interventions at once" and "this operator is asleep". Both
 * would have to be rewritten if availability were a farm-level singleton, so the
 * `operatorId` foreign key is here from day one — with a single seeded row.
 */
export interface Operator {
  id: string;
  name: string;
  /**
   * The IANA zone this operator's wall-clock schedule is expressed in (e.g.
   * `Europe/Moscow`). **Null means unknown, and unknown is fail-closed**: an
   * operator with no zone is never resolved as available, because "08:00" with
   * no zone names no instant. Never defaulted to the container's `TZ`.
   */
  timeZone: string | null;
  /** Inactive operators keep their history but are skipped by availability. */
  active: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  version: number;
  metadata: Metadata;
}

// ── Schedule ─────────────────────────────────────────────────────────────────

/**
 * Which track a window belongs to. They are deliberately **separate schedules**,
 * not one availability calendar with holes: an operator can be at the farm and
 * asleep (a night shift napping), and the two facts have different consequences
 * — `available` gates whether an intervention can be *performed*, `sleep` is why
 * a printer sits idle till morning and is what the timeline shows the operator.
 * Sleep always wins over availability where they overlap (see `resolveAvailability`).
 */
export type ScheduleTrack = "available" | "sleep";

/** `0` = Sunday … `6` = Saturday — the numbering `Date.getUTCDay()` uses. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * One recurring weekly window, as **local wall-clock minutes since midnight** in
 * the operator's zone — never as an instant. Storing wall clock is what makes
 * the schedule survive DST: "available 08:00–18:00 on Mondays" stays 08:00 local
 * on both sides of a transition, which is what a human means and what an
 * instant-based rule would silently break twice a year.
 *
 * `endMinutes <= startMinutes` wraps past midnight (23:00–07:00 = Mon 23:00 →
 * Tue 07:00), which is the normal shape of a sleep window.
 */
export interface ScheduleRule {
  id: string;
  operatorId: string;
  track: ScheduleTrack;
  weekday: Weekday;
  /** Inclusive start, local minutes since midnight (0…1439). */
  startMinutes: number;
  /** Exclusive end, local minutes since midnight (0…1440); wraps when ≤ start. */
  endMinutes: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  version: number;
  metadata: Metadata;
}

/**
 * What a date-specific exception does to that date's recurring rules.
 *
 *  - `available` / `sleep` — **replace** every recurring rule of that track for
 *    that local date (a one-off shift, a late start);
 *  - `off` — the operator is not available that date at all, whatever the weekly
 *    rules say (holiday, day off). It replaces the `available` track with nothing.
 *
 * Replacement rather than union is deliberate: "I work 12:00–16:00 this Saturday"
 * must not *add* to the usual Saturday hours, or an exception could only ever
 * widen availability and never narrow it.
 */
export type ScheduleExceptionKind = "available" | "sleep" | "off";

/**
 * A one-date override of the weekly schedule, keyed by the **local calendar
 * date** (`YYYY-MM-DD`) in the operator's zone — not by a UTC instant, so a
 * "2026-07-28" exception means that whole local day wherever the farm is.
 */
export interface ScheduleException {
  id: string;
  operatorId: string;
  /** Local calendar date in the operator's zone, `YYYY-MM-DD`. */
  date: string;
  kind: ScheduleExceptionKind;
  /** Null for `off` (the whole date), set for a replacement window. */
  startMinutes: number | null;
  endMinutes: number | null;
  note: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  version: number;
  metadata: Metadata;
}

/**
 * A temporary absence over an **instant range** (holiday, illness, a trip) —
 * UTC timestamps, unlike the wall-clock schedule, because an absence is a
 * continuous span of real time rather than a repeating local pattern. An absence
 * beats every rule and exception: away is away.
 */
export interface OperatorAbsence {
  id: string;
  operatorId: string;
  startsAt: IsoTimestamp;
  /** Null = open-ended (absent until explicitly ended). */
  endsAt: IsoTimestamp | null;
  reason: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  version: number;
  metadata: Metadata;
}

// ── Manual operation ─────────────────────────────────────────────────────────

/**
 * The typed physical interventions the farm's workflow is made of:
 *
 *   загрузка материала → замена сопла → замена пластины → запуск
 *   → снятие готовой модели → осмотр → подтверждение очистки стола
 *
 * Typed rather than free-text because each one carries a *different* duration,
 * a different consequence for the bed, and a different question for the
 * operator. A single "operator did something" flag can express none of that —
 * and, critically, cannot distinguish "the printer reports idle" from "a human
 * took the part off", which is the confusion this whole model exists to prevent.
 */
export type ManualOperationType =
  /** Снятие готовой модели с пластины. Clears the bed when confirmed. */
  | "PART_REMOVAL"
  /** Очистка или замена пластины. Also clears the bed when confirmed. */
  | "PLATE_SERVICE"
  /** Замена материала (другой филамент/цвет) — needs a purge, so it is slow. */
  | "MATERIAL_CHANGE"
  /** Замена катушки того же материала — faster than a full material change. */
  | "SPOOL_CHANGE"
  /** Замена сопла — the slowest routine intervention (cool, swap, re-level). */
  | "NOZZLE_CHANGE"
  /** Калибровка (bed mesh, offset, flow). */
  | "CALIBRATION"
  /** Визуальный осмотр первого слоя / готовой модели. */
  | "VISUAL_INSPECTION"
  /** Подтверждение ручной загрузки файла на принтер (adapters with no upload API). */
  | "FILE_TRANSFER_CONFIRM";

/** Every type, in workflow order — the single list UI/validation iterate. */
export const MANUAL_OPERATION_TYPES: readonly ManualOperationType[] = [
  "MATERIAL_CHANGE",
  "SPOOL_CHANGE",
  "NOZZLE_CHANGE",
  "PLATE_SERVICE",
  "CALIBRATION",
  "FILE_TRANSFER_CONFIRM",
  "VISUAL_INSPECTION",
  "PART_REMOVAL"
];

/**
 * The lifecycle of one intervention:
 *
 *   PENDING → READY → IN_PROGRESS → COMPLETED
 *                        ↘ FAILED | CANCELLED
 *
 *  - `PENDING`  — required, but not yet performable: the operator is asleep/away,
 *    or the allowed window has not opened. This is the state a printer sits in
 *    from 03:00 to 08:00 in the brief's example.
 *  - `READY`    — an operator is available and the window is open; it can be done
 *    now. The promotion is computed, never guessed (see `resolveReadiness`).
 *  - `IN_PROGRESS` — an operator claimed it. At most one per operator.
 *  - `COMPLETED` — confirmed done, by a named actor, at a recorded time.
 *  - `FAILED`   — attempted and did not work (nozzle still clogged); stays
 *    blocking so the printer is not handed a job it cannot run.
 *  - `CANCELLED` — no longer needed (its assignment was cancelled).
 */
export type ManualOperationState =
  | "PENDING"
  | "READY"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

/** States in which an operation still holds its printer. */
export const OPEN_OPERATION_STATES: readonly ManualOperationState[] = [
  "PENDING",
  "READY",
  "IN_PROGRESS",
  "FAILED"
];

/** Why the operation exists — provenance, so the UI can explain itself. */
export type ManualOperationOrigin =
  /** Opened automatically when a run finished and left a part on the plate. */
  | "print_finished"
  /** Opened automatically when an assignment needs a hardware change first. */
  | "assignment_requirement"
  /** Created by an operator by hand. */
  | "operator"
  /** Opened by a maintenance/calibration policy. */
  | "maintenance";

/**
 * One physical intervention: what has to be done, on which machine, for which
 * assignment, how long it takes, when it may be done, who confirmed it and when.
 *
 * **Blocking is the load-bearing field.** A `blocking` operation makes its
 * printer unavailable to the scheduler and refuses every dispatch — manual or
 * automatic — until it reaches `COMPLETED` or `CANCELLED`. That is the rule the
 * brief's "планировщик должен считать принтер занятым до завершения обязательной
 * операции" turns into, and the reason a start cannot be talked past by an
 * operator override: a full bed is a physical fact, not a policy.
 */
export interface ManualOperation {
  id: string;
  type: ManualOperationType;
  state: ManualOperationState;
  printerId: string;
  /** The assignment this intervention serves; null for farm-level maintenance. */
  assignmentId: string | null;
  /** The task behind that assignment, denormalised for the operator queue view. */
  taskId: string | null;
  /** The bed cycle it clears, for the clearance types; null otherwise. */
  bedCycleId: string | null;
  /**
   * Expected hands-on time in minutes. **Null means unknown**, and an unknown
   * duration is fail-closed: nothing may be scheduled after it, because "the
   * printer is free at 08:00 + ?" is not a time.
   */
  estimatedMinutes: number | null;
  /** Earliest the operation may be performed; null = as soon as an operator is free. */
  windowStart: IsoTimestamp | null;
  /** Latest it should be performed by; null = no deadline. Advisory, never a silent skip. */
  windowEnd: IsoTimestamp | null;
  /** Whether the printer is held until this completes. */
  blocking: boolean;
  origin: ManualOperationOrigin;
  /** Operator-facing explanation of why it was opened. */
  reason: string | null;
  /** The operator who claimed it (`IN_PROGRESS`); null while unclaimed. */
  assignedOperatorId: string | null;
  /** Who confirmed the completion — a name, never "system". */
  confirmedBy: string | null;
  /** When it moved to `IN_PROGRESS`. */
  startedAt: IsoTimestamp | null;
  /** When it reached `COMPLETED`/`FAILED`/`CANCELLED`. */
  completedAt: IsoTimestamp | null;
  /** Wall-clock minutes the operator actually spent, when reported. */
  actualMinutes: number | null;
  /** When it became performable (`PENDING` → `READY`), for the idle-time report. */
  readyAt: IsoTimestamp | null;
  /** Failure/cancellation detail. */
  note: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  version: number;
  metadata: Metadata;
}
