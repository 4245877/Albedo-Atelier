import { NotFoundError, ValidationError } from "../../core/errors";
import {
  isValidTimeZone,
  resolveAvailability,
  resolveFarmAvailability,
  type OperatorAvailability,
  type OperatorScheduleInput
} from "../../domain/operations/schedule";
import type {
  Operator,
  OperatorAbsence,
  ScheduleException,
  ScheduleExceptionKind,
  ScheduleRule,
  ScheduleTrack,
  Weekday
} from "../../domain/operations/types";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import { localDateInZone } from "../../domain/scheduling/nightWindow";
import { recordAuditEvent, type AuditInput } from "../audit";

/** One weekly window as the API/UI exchange it: `"HH:MM"` strings, not minutes. */
export interface WeeklyWindowInput {
  weekday: number;
  start: string;
  end: string;
}

/** The whole weekly schedule for one operator, replaced atomically. */
export interface WeeklyScheduleInput {
  timeZone?: string | null;
  available?: WeeklyWindowInput[];
  sleep?: WeeklyWindowInput[];
}

export interface ScheduleExceptionInput {
  date: string;
  kind: ScheduleExceptionKind;
  start?: string | null;
  end?: string | null;
  note?: string | null;
}

export interface AbsenceInput {
  startsAt: string;
  endsAt?: string | null;
  reason?: string | null;
}

/** The operator schedule as the dashboard renders it. */
export interface OperatorScheduleView {
  operator: Operator;
  available: { weekday: Weekday; start: string; end: string }[];
  sleep: { weekday: Weekday; start: string; end: string }[];
  exceptions: ScheduleException[];
  absences: OperatorAbsence[];
  availability: {
    presence: OperatorAvailability["presence"];
    reason: string;
    resolved: boolean;
    nextAvailableAt: string | null;
    availableUntil: string | null;
  };
}

/**
 * The operator-schedule application service: CRUD over the roster, the weekly
 * rules, the date exceptions and the absences, plus the one read the rest of the
 * system actually depends on — {@link availability}.
 *
 * Every decision is delegated to the pure `domain/operations/schedule`; this
 * module only loads rows, validates operator input and writes audit trail. The
 * two things it is strict about:
 *
 *  - **a timezone must be a real IANA zone or absent.** A typo'd zone is
 *    rejected at write time (a 400) rather than silently stored to fail closed
 *    at 3 a.m., when the failure is expensive to diagnose;
 *  - **the weekly schedule is replaced as a whole**, inside one transaction. A
 *    per-row edit API would let a half-applied week look like a real schedule.
 */
export class OperatorScheduleService {
  private readonly nowFn: () => Date;
  private readonly actor: string;

  constructor(
    private readonly store: PrintQueueStore,
    options: { now?: () => Date; actor?: string } = {}
  ) {
    this.nowFn = options.now ?? (() => new Date());
    this.actor = options.actor ?? "operator";
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  listOperators(): Operator[] {
    return this.store.repositories.operators.list();
  }

  /** The default operator — the single-operator farm's implicit subject. */
  primaryOperator(): Operator | null {
    const repos = this.store.repositories;
    return repos.operators.listActive()[0] ?? repos.operators.list()[0] ?? null;
  }

  /** Everything one operator's availability depends on, loaded in one place. */
  scheduleInputFor(operatorId: string): OperatorScheduleInput | null {
    const repos = this.store.repositories;
    const operator = repos.operators.getById(operatorId);
    if (!operator) return null;
    return {
      operator,
      rules: repos.scheduleRules.listByOperator(operatorId),
      exceptions: repos.scheduleExceptions.listByOperator(operatorId),
      absences: repos.operatorAbsences.listByOperator(operatorId)
    };
  }

  /**
   * Farm-level availability at `now` (defaults to the service clock) — the single
   * read the scheduler, the dispatch gate and the readiness sweep all use, so
   * they can never disagree about whether somebody is around.
   */
  availability(now?: Date): OperatorAvailability {
    const at = now ?? this.nowFn();
    const inputs = this.store.repositories.operators
      .listActive()
      .map((o) => this.scheduleInputFor(o.id))
      .filter((i): i is OperatorScheduleInput => i !== null);
    return resolveFarmAvailability(inputs, at);
  }

  /** Availability of one specific operator (the per-person view). */
  availabilityOf(operatorId: string, now?: Date): OperatorAvailability {
    return resolveAvailability(this.scheduleInputFor(operatorId), now ?? this.nowFn());
  }

  /** The schedule of one operator in the shape the dashboard renders. */
  view(operatorId?: string): OperatorScheduleView | null {
    const operator = operatorId
      ? this.store.repositories.operators.getById(operatorId)
      : this.primaryOperator();
    if (!operator) return null;

    const input = this.scheduleInputFor(operator.id);
    const availability = resolveAvailability(input, this.nowFn());
    const rules = input?.rules ?? [];
    const toWindow = (r: ScheduleRule): { weekday: Weekday; start: string; end: string } => ({
      weekday: r.weekday,
      start: minutesToHhmm(r.startMinutes),
      end: minutesToHhmm(r.endMinutes)
    });

    return {
      operator,
      available: rules.filter((r) => r.track === "available").map(toWindow),
      sleep: rules.filter((r) => r.track === "sleep").map(toWindow),
      exceptions: [...(input?.exceptions ?? [])],
      absences: [...(input?.absences ?? [])],
      availability: {
        presence: availability.presence,
        reason: availability.reason,
        resolved: availability.resolved,
        nextAvailableAt: availability.nextAvailableAt?.toISOString() ?? null,
        availableUntil: availability.availableUntil?.toISOString() ?? null
      }
    };
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /**
   * Replaces an operator's timezone and entire weekly schedule in one
   * transaction. Windows are given as `"HH:MM"` and stored as local minutes; a
   * window whose end is ≤ its start wraps past midnight and is accepted as-is
   * (that is the normal shape of a sleep window).
   */
  setWeeklySchedule(operatorId: string, input: WeeklyScheduleInput, actor?: string): OperatorScheduleView {
    return this.store.transaction(() => {
      const repos = this.store.repositories;
      const operator = repos.operators.getById(operatorId);
      if (!operator) throw new NotFoundError(`Оператор «${operatorId}»`);

      if (input.timeZone !== undefined) {
        const zone = input.timeZone === null ? null : input.timeZone.trim();
        if (zone !== null && !isValidTimeZone(zone)) {
          throw new ValidationError(
            `Таймзона «${zone}» не является корректным IANA-идентификатором (например, Europe/Moscow)`
          );
        }
        const iso = this.nowIso();
        repos.operators.update({ ...operator, timeZone: zone, updatedAt: iso });
        this.audit({
          entityType: "operator",
          entityId: operator.id,
          action: "timezone_set",
          actor,
          detail: { timeZone: zone }
        });
      }

      if (input.available !== undefined || input.sleep !== undefined) {
        // Replace-as-a-whole: a partially-applied week must never be readable.
        repos.scheduleRules.deleteByOperator(operatorId);
        this.insertRules(operatorId, "available", input.available ?? []);
        this.insertRules(operatorId, "sleep", input.sleep ?? []);
        this.audit({
          entityType: "operator",
          entityId: operator.id,
          action: "schedule_replaced",
          actor,
          detail: {
            available: (input.available ?? []).length,
            sleep: (input.sleep ?? []).length
          }
        });
      }

      return this.view(operatorId) as OperatorScheduleView;
    });
  }

  /** Adds a one-date override of the weekly schedule. */
  addException(operatorId: string, input: ScheduleExceptionInput, actor?: string): ScheduleException {
    return this.store.transaction(() => {
      const repos = this.store.repositories;
      if (!repos.operators.getById(operatorId)) throw new NotFoundError(`Оператор «${operatorId}»`);

      const date = (input.date ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new ValidationError("Поле «date» должно быть локальной датой в формате YYYY-MM-DD");
      }
      if (input.kind !== "available" && input.kind !== "sleep" && input.kind !== "off") {
        throw new ValidationError("Поле «kind» должно быть одним из: available | sleep | off");
      }

      // `off` is a whole-day statement and carries no window; the other kinds
      // replace that date's rules and therefore must name one.
      let startMinutes: number | null = null;
      let endMinutes: number | null = null;
      if (input.kind !== "off") {
        startMinutes = parseHhmm(input.start, "start");
        endMinutes = parseHhmm(input.end, "end");
      }

      const iso = this.nowIso();
      const exception: ScheduleException = {
        id: newId(ID_PREFIX.scheduleException),
        operatorId,
        date,
        kind: input.kind,
        startMinutes,
        endMinutes,
        note: input.note?.trim() || null,
        createdAt: iso,
        updatedAt: iso,
        version: 1,
        metadata: {}
      };
      repos.scheduleExceptions.insert(exception);
      this.audit({
        entityType: "schedule_exception",
        entityId: exception.id,
        action: "created",
        actor,
        detail: { operatorId, date, kind: input.kind, startMinutes, endMinutes }
      });
      return exception;
    });
  }

  removeException(exceptionId: string, actor?: string): void {
    this.store.transaction(() => {
      const repos = this.store.repositories;
      const existing = repos.scheduleExceptions.getById(exceptionId);
      if (!existing) throw new NotFoundError(`Исключение расписания «${exceptionId}»`);
      repos.scheduleExceptions.delete(exceptionId);
      this.audit({
        entityType: "schedule_exception",
        entityId: exceptionId,
        action: "deleted",
        actor,
        detail: { operatorId: existing.operatorId, date: existing.date }
      });
    });
  }

  /** Records a temporary absence (holiday, illness, a trip). */
  addAbsence(operatorId: string, input: AbsenceInput, actor?: string): OperatorAbsence {
    return this.store.transaction(() => {
      const repos = this.store.repositories;
      if (!repos.operators.getById(operatorId)) throw new NotFoundError(`Оператор «${operatorId}»`);

      const startsAt = parseIso(input.startsAt, "startsAt");
      const endsAt =
        input.endsAt === null || input.endsAt === undefined ? null : parseIso(input.endsAt, "endsAt");
      if (endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt)) {
        throw new ValidationError("Поле «endsAt» должно быть позже «startsAt»");
      }

      const iso = this.nowIso();
      const absence: OperatorAbsence = {
        id: newId(ID_PREFIX.operatorAbsence),
        operatorId,
        startsAt,
        endsAt,
        reason: input.reason?.trim() || null,
        createdAt: iso,
        updatedAt: iso,
        version: 1,
        metadata: {}
      };
      repos.operatorAbsences.insert(absence);
      this.audit({
        entityType: "operator_absence",
        entityId: absence.id,
        action: "created",
        actor,
        detail: { operatorId, startsAt, endsAt }
      });
      return absence;
    });
  }

  removeAbsence(absenceId: string, actor?: string): void {
    this.store.transaction(() => {
      const repos = this.store.repositories;
      const existing = repos.operatorAbsences.getById(absenceId);
      if (!existing) throw new NotFoundError(`Отсутствие «${absenceId}»`);
      repos.operatorAbsences.delete(absenceId);
      this.audit({
        entityType: "operator_absence",
        entityId: absenceId,
        action: "deleted",
        actor,
        detail: { operatorId: existing.operatorId }
      });
    });
  }

  /** Today's local calendar date in the operator's zone — the exception-form default. */
  localToday(operatorId?: string): string | null {
    const operator = operatorId
      ? this.store.repositories.operators.getById(operatorId)
      : this.primaryOperator();
    if (!operator || !isValidTimeZone(operator.timeZone)) return null;
    return localDateInZone(this.nowFn(), operator.timeZone as string);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private insertRules(operatorId: string, track: ScheduleTrack, windows: WeeklyWindowInput[]): void {
    const iso = this.nowIso();
    for (const window of windows) {
      const weekday = Number(window?.weekday);
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        throw new ValidationError("Поле «weekday» должно быть целым числом 0…6 (0 = воскресенье)");
      }
      const rule: ScheduleRule = {
        id: newId(ID_PREFIX.scheduleRule),
        operatorId,
        track,
        weekday: weekday as Weekday,
        startMinutes: parseHhmm(window?.start, "start"),
        endMinutes: parseHhmm(window?.end, "end"),
        createdAt: iso,
        updatedAt: iso,
        version: 1,
        metadata: {}
      };
      this.store.repositories.scheduleRules.insert(rule);
    }
  }

  private audit(input: AuditInput): void {
    recordAuditEvent(this.store, () => this.nowIso(), this.actor, input);
  }

  private nowIso(): string {
    return this.nowFn().toISOString();
  }
}

/** `"HH:MM"` → minutes since midnight; a 400 on anything else (never a silent 0). */
function parseHhmm(value: unknown, field: string): number {
  if (typeof value !== "string") {
    throw new ValidationError(`Поле «${field}» обязательно в формате HH:MM`);
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new ValidationError(`Поле «${field}» должно быть временем в формате HH:MM`);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours < 0 || hours > 24 || minutes < 0 || minutes > 59 || (hours === 24 && minutes > 0)) {
    throw new ValidationError(`Поле «${field}»: недопустимое время «${value}»`);
  }
  return hours * 60 + minutes;
}

function parseIso(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ValidationError(`Поле «${field}» должно быть датой-временем ISO-8601`);
  }
  return new Date(value).toISOString();
}

/** Minutes since midnight → `"HH:MM"`, with 1440 kept as `24:00` (a window end). */
function minutesToHhmm(minutes: number): string {
  if (minutes >= 1440) return "24:00";
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}
