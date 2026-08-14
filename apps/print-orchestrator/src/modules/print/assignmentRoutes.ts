import type { FastifyInstance } from "fastify";

import type { PrintServices } from "../../bootstrap/createRuntime";
import { JobError, ValidationError } from "../../core/errors";
import type { Assignment, DeviceArtifact, PrintRun } from "../../domain/print/types";

/**
 * The **execution** surface under `/api/print/assignments` — the part of the
 * process that was previously unreachable over HTTP: an assignment could be
 * created (by a plan or by hand) and then nothing could prepare its file or
 * start it.
 *
 * Every action here delegates to a domain service; no handler touches SQLite, a
 * driver or a device directly, and the start path is the same
 * `DispatchService.startAssignment` the queue and night paths funnel into — so
 * there is no "convenience" route that skips the bed check, the file check,
 * `DispatchEligibility`, idempotency, the reservation or the audit trail.
 *
 * Reads:
 *   GET  /assignments                 open assignments + their device-file state
 *   GET  /assignments/:id             one assignment with its binding + device file
 *
 * Actions (guarded by the shared CSRF/token middleware):
 *   POST /assignments/:id/prepare-file   upload (or demand a manual transfer)
 *   POST /assignments/:id/confirm-file   operator confirms a manual transfer  body: { operator }
 *   POST /assignments/:id/start          run THIS assignment                  body: { idempotencyKey?, expectedTaskVersion?, override? }
 *   POST /assignments/:id/invalidate     withdraw a placement                 body: { reason }
 */
export function registerAssignmentRoutes(
  app: FastifyInstance,
  services: Pick<PrintServices, "printQueue" | "deviceArtifacts" | "dispatchService">
): void {
  app.get("/assignments", async () => ({
    assignments: services.printQueue
      .listOpenAssignments()
      .map((assignment) =>
        assignmentView(
          assignment,
          services.deviceArtifacts.forAssignment(assignment),
          services.printQueue.findActiveRunByTask(assignment.taskId)
        )
      )
  }));

  app.get<{ Params: { id: string } }>("/assignments/:id", async (request) => {
    const assignment = services.printQueue.getAssignment(request.params.id);
    return {
      assignment: assignmentView(
        assignment,
        services.deviceArtifacts.forAssignment(assignment),
        services.printQueue.findActiveRunByTask(assignment.taskId)
      )
    };
  });

  app.post<{ Params: { id: string } }>("/assignments/:id/prepare-file", async (request) => ({
    ok: true,
    ...(await services.deviceArtifacts.prepare(request.params.id))
  }));

  app.post<{ Params: { id: string }; Body: { operator?: unknown } }>(
    "/assignments/:id/confirm-file",
    async (request) => {
      const operator = optionalString(request.body?.operator);
      if (!operator) {
        throw new ValidationError(
          "Поле «operator» обязательно — подтверждение ручного переноса файла должно быть именным"
        );
      }
      return {
        ok: true,
        ...(await services.deviceArtifacts.confirmManualTransfer(request.params.id, operator))
      };
    }
  );

  app.post<{
    Params: { id: string };
    Body: {
      idempotencyKey?: unknown;
      expectedTaskVersion?: unknown;
      override?: { codes?: unknown; reason?: unknown; operator?: unknown };
    };
  }>("/assignments/:id/start", async (request) => {
    const dispatch = services.dispatchService;
    if (!dispatch) throw new JobError("Служба запуска ещё не инициализирована");

    const body = request.body ?? {};
    const options: Parameters<typeof dispatch.startAssignment>[1] = {
      // `manual` only: an attended operator is pressing this. Unattended (night)
      // starts have their own gated path and are not reachable from here.
      mode: "manual",
      actor: "operator"
    };
    const key = optionalString(body.idempotencyKey);
    if (key) options.idempotencyKey = key;
    if (typeof body.expectedTaskVersion === "number" && Number.isFinite(body.expectedTaskVersion)) {
      options.expectedTaskVersion = body.expectedTaskVersion;
    }
    const override = shapeOverride(body.override);
    if (override) options.override = override;

    return { ok: true, run: await dispatch.startAssignment(request.params.id, options) };
  });

  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
    "/assignments/:id/invalidate",
    async (request) => {
      const reason = optionalString(request.body?.reason);
      if (!reason) throw new ValidationError("Поле «reason» обязательно");
      return {
        ok: true,
        assignment: services.printQueue.invalidateAssignment(request.params.id, reason)
      };
    }
  );
}

/**
 * The assignment as the execution UI needs it: the binding (what exactly will be
 * printed), the device-file state, and the single next action. `nextAction` is a
 * *hint* — the server re-decides everything on the actual call, so a stale UI can
 * never talk the backend into skipping a step.
 *
 * The hint being only a hint is not licence for it to be wrong. It was derived
 * from the device file alone, so a VERIFIED file made this say `start` even when
 * the task's previous start was still awaiting the operator's verdict — and the
 * dashboard duly drew a green "▶ Запустить" whose only possible outcome was a
 * 409 reciting five invariants. A hint that names an impossible action is worse
 * than no hint: it is the UI promising something the server must then refuse.
 */
export function assignmentView(
  assignment: Assignment,
  deviceArtifact: DeviceArtifact | null,
  activeRun: PrintRun | null = null
) {
  // Only a VERIFIED file is startable — "present but unmatched" is not evidence,
  // and the server refuses it regardless of what this hint says.
  const ready = deviceArtifact?.state === "VERIFIED";
  // A dispatched start the printer never confirmed. Nothing about this task can
  // proceed until an operator says what the machine actually did, so the honest
  // next action is that decision — not a start, and not a file step either.
  const unresolved =
    activeRun &&
    activeRun.startedAt === null &&
    (activeRun.state === "PENDING" || activeRun.state === "UNKNOWN")
      ? activeRun
      : null;
  return {
    assignment,
    deviceArtifact,
    fileReady: ready,
    // Present exactly when a verdict is owed, and it is the argument the
    // resolution takes (`POST /api/print/runs/:id/resolve`).
    unresolvedRunId: unresolved?.id ?? null,
    nextAction: assignment.invalidatedAt
      ? "replan"
      : unresolved
        ? "resolve"
        : ready
          ? "start"
          : deviceArtifact?.transferMode === "manual_file_transfer"
            ? "confirm-file"
            : "prepare-file"
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Narrows an untrusted override; the service re-validates and refuses hard blockers. */
function shapeOverride(
  raw: { codes?: unknown; reason?: unknown; operator?: unknown } | undefined
): { codes: string[]; reason: string; operator: string } | undefined {
  if (!raw) return undefined;
  const codes = Array.isArray(raw.codes)
    ? raw.codes.filter((c): c is string => typeof c === "string")
    : [];
  const reason = optionalString(raw.reason);
  const operator = optionalString(raw.operator);
  if (codes.length === 0 || !reason || !operator) return undefined;
  return { codes, reason, operator };
}
