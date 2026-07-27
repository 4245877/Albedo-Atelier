import type { FastifyInstance } from "fastify";

import type { PrintServices } from "../../bootstrap/createRuntime";
import { ValidationError } from "../../core/errors";
import {
  MANUAL_OPERATION_TYPES,
  type ManualOperationType
} from "../../domain/operations/types";
import {
  DEFAULT_OPERATION_MINUTES,
  OPERATION_LABELS
} from "../../domain/operations/states";

/**
 * The operator-schedule and manual-operations API under `/api/print`.
 *
 * Schedule (`/schedule`):
 *   GET    /schedule                      the weekly schedule + live presence
 *   POST   /schedule                      replace timezone and/or the whole week
 *                                         body: { timeZone?, available?: [{weekday,start,end}], sleep?: […] }
 *   POST   /schedule/exceptions           add a date override
 *                                         body: { date: "YYYY-MM-DD", kind: available|sleep|off, start?, end?, note? }
 *   DELETE /schedule/exceptions/:id       remove one
 *   POST   /schedule/absences             record a temporary absence  body: { startsAt, endsAt?, reason? }
 *   DELETE /schedule/absences/:id         remove one
 *
 * Operations (`/operations`):
 *   GET    /operations                    the pending queue with live readiness + per-printer holds
 *   GET    /operations/types              the type vocabulary + default durations (for the UI form)
 *   POST   /operations                    open one by hand
 *                                         body: { type, printerId, assignmentId?, estimatedMinutes?, reason?, blocking?, windowStart?, windowEnd? }
 *   POST   /operations/:id/claim          an operator takes it       body: { operatorId }
 *   POST   /operations/:id/complete       CONFIRM it is done         body: { actor?, actualMinutes?, note? }
 *   POST   /operations/:id/fail           attempted, did not work    body: { actor?, note? }
 *   POST   /operations/:id/cancel         no longer needed           body: { reason? }
 *
 * `POST /operations/:id/complete` is the confirmation the whole bed-clearance
 * guarantee rests on, and it is deliberately the *only* way an operation ends as
 * done. There is no "printer looks idle, assume the part is off" route, because
 * a printer reporting idle after a print is exactly the state in which the part
 * is still on the plate.
 */
export function registerOperationsRoutes(
  app: FastifyInstance,
  services: Pick<PrintServices, "operatorSchedule" | "manualOperations">
): void {
  registerScheduleRoutes(app, services);
  registerManualOperationRoutes(app, services);
}

function registerScheduleRoutes(
  app: FastifyInstance,
  services: Pick<PrintServices, "operatorSchedule">
): void {
  app.get("/schedule", async () => {
    const view = services.operatorSchedule.view();
    return {
      schedule: view,
      operators: services.operatorSchedule.listOperators(),
      localToday: services.operatorSchedule.localToday()
    };
  });

  app.post<{ Body: unknown }>("/schedule", async (request) => {
    const operator = requireOperator(services);
    return {
      ok: true,
      schedule: services.operatorSchedule.setWeeklySchedule(operator, shapeWeekly(request.body))
    };
  });

  app.post<{ Body: unknown }>("/schedule/exceptions", async (request) => {
    const operator = requireOperator(services);
    const src = asRecord(request.body);
    return {
      ok: true,
      exception: services.operatorSchedule.addException(operator, {
        date: typeof src.date === "string" ? src.date : "",
        kind: src.kind as "available" | "sleep" | "off",
        start: optionalString(src.start) ?? null,
        end: optionalString(src.end) ?? null,
        note: optionalString(src.note) ?? null
      })
    };
  });

  app.delete<{ Params: { id: string } }>("/schedule/exceptions/:id", async (request) => {
    services.operatorSchedule.removeException(request.params.id);
    return { ok: true };
  });

  app.post<{ Body: unknown }>("/schedule/absences", async (request) => {
    const operator = requireOperator(services);
    const src = asRecord(request.body);
    return {
      ok: true,
      absence: services.operatorSchedule.addAbsence(operator, {
        startsAt: typeof src.startsAt === "string" ? src.startsAt : "",
        endsAt: optionalString(src.endsAt) ?? null,
        reason: optionalString(src.reason) ?? null
      })
    };
  });

  app.delete<{ Params: { id: string } }>("/schedule/absences/:id", async (request) => {
    services.operatorSchedule.removeAbsence(request.params.id);
    return { ok: true };
  });
}

function registerManualOperationRoutes(
  app: FastifyInstance,
  services: Pick<PrintServices, "manualOperations">
): void {
  app.get("/operations", async () => {
    // Readiness depends on the clock, so it is re-derived on every read rather
    // than served from whatever the last sweep happened to write.
    services.manualOperations.refreshReadiness();
    const pending = services.manualOperations.pending();
    const printers = [...new Set(pending.map((p) => p.operation.printerId))];
    return {
      operations: pending,
      holds: printers.map((id) => services.manualOperations.printerHold(id))
    };
  });

  app.get("/operations/types", async () => ({
    types: MANUAL_OPERATION_TYPES.map((type) => ({
      type,
      label: OPERATION_LABELS[type],
      defaultMinutes: DEFAULT_OPERATION_MINUTES[type]
    }))
  }));

  app.post<{ Body: unknown }>("/operations", async (request) => {
    const src = asRecord(request.body);
    const type = src.type;
    if (!MANUAL_OPERATION_TYPES.includes(type as ManualOperationType)) {
      throw new ValidationError(
        `Поле «type» обязательно, одно из: ${MANUAL_OPERATION_TYPES.join(", ")}`
      );
    }
    const printerId = optionalString(src.printerId);
    if (!printerId) throw new ValidationError("Поле «printerId» обязательно");

    return {
      ok: true,
      operation: services.manualOperations.open({
        type: type as ManualOperationType,
        printerId,
        assignmentId: optionalString(src.assignmentId) ?? null,
        taskId: optionalString(src.taskId) ?? null,
        ...(src.estimatedMinutes === null || typeof src.estimatedMinutes === "number"
          ? { estimatedMinutes: finiteOrNull(src.estimatedMinutes) }
          : {}),
        windowStart: optionalString(src.windowStart) ?? null,
        windowEnd: optionalString(src.windowEnd) ?? null,
        ...(typeof src.blocking === "boolean" ? { blocking: src.blocking } : {}),
        reason: optionalString(src.reason) ?? null
      })
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/operations/:id/claim", async (request) => {
    const operatorId = optionalString(asRecord(request.body).operatorId);
    if (!operatorId) throw new ValidationError("Поле «operatorId» обязательно");
    return { ok: true, operation: services.manualOperations.claim(request.params.id, operatorId) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/operations/:id/complete",
    async (request) => {
      const src = asRecord(request.body);
      return {
        ok: true,
        operation: services.manualOperations.complete(request.params.id, {
          actor: optionalString(src.actor),
          actualMinutes: finiteOrNull(src.actualMinutes),
          note: optionalString(src.note) ?? null
        })
      };
    }
  );

  app.post<{ Params: { id: string }; Body: unknown }>("/operations/:id/fail", async (request) => {
    const src = asRecord(request.body);
    return {
      ok: true,
      operation: services.manualOperations.fail(request.params.id, {
        actor: optionalString(src.actor),
        note: optionalString(src.note)
      })
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/operations/:id/cancel", async (request) => {
    const reason = optionalString(asRecord(request.body).reason) ?? "операция отменена оператором";
    return { ok: true, operation: services.manualOperations.cancel(request.params.id, reason) };
  });
}

/**
 * The operator every schedule write applies to. Single-operator farm: the whole
 * API is guarded by one shared token, so there is no authenticated principal to
 * attribute yet — the primary operator row is the subject. When per-user auth
 * lands, take the id from the request identity instead.
 */
function requireOperator(services: Pick<PrintServices, "operatorSchedule">): string {
  const operator = services.operatorSchedule.primaryOperator();
  if (!operator) throw new ValidationError("В базе нет ни одного оператора");
  return operator.id;
}

/** Narrows an untrusted body into the weekly-schedule input; absent fields stay absent. */
function shapeWeekly(body: unknown): {
  timeZone?: string | null;
  available?: { weekday: number; start: string; end: string }[];
  sleep?: { weekday: number; start: string; end: string }[];
} {
  const src = asRecord(body);
  const out: {
    timeZone?: string | null;
    available?: { weekday: number; start: string; end: string }[];
    sleep?: { weekday: number; start: string; end: string }[];
  } = {};
  // `null` is meaningful here — it clears the zone back to unknown — so presence
  // is tested rather than truthiness.
  if ("timeZone" in src) out.timeZone = optionalString(src.timeZone) ?? null;
  if ("available" in src) out.available = shapeWindows(src.available);
  if ("sleep" in src) out.sleep = shapeWindows(src.sleep);
  return out;
}

function shapeWindows(value: unknown): { weekday: number; start: string; end: string }[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const w = asRecord(raw);
    return {
      weekday: Number(w.weekday),
      start: typeof w.start === "string" ? w.start : "",
      end: typeof w.end === "string" ? w.end : ""
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
