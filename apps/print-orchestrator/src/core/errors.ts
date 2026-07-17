export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 500,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class AuthorizationError extends AppError {
  constructor(message = "Forbidden") {
    super(message, "FORBIDDEN", 403);
    this.name = "AuthorizationError";
  }
}

/** A missing/invalid API token on an action that requires one. */
export class UnauthorizedError extends AppError {
  constructor(message = "Valid API token required") {
    super(message, "UNAUTHORIZED", 401);
    this.name = "UnauthorizedError";
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "VALIDATION", 400, details);
    this.name = "ValidationError";
  }
}

/**
 * Domain error taxonomy for the farm. Each maps to a stable `code` the
 * dashboard can branch on, and an HTTP status. These make the failure modes
 * from the brief explicit: an offline printer, a lost connection, a camera
 * that won't stream, a material conflict, and an illegal job action.
 */

/** The printer is powered down / unreachable, so the action cannot run. */
export class PrinterOfflineError extends AppError {
  constructor(printerId: string) {
    super(`Принтер «${printerId}» не в сети`, "PRINTER_OFFLINE", 409, { printerId });
    this.name = "PrinterOfflineError";
  }
}

/** The printer is configured but the driver/transport failed to reach it. */
export class PrinterConnectionError extends AppError {
  constructor(printerId: string, reason?: string) {
    super(
      `Не удалось связаться с принтером «${printerId}»${reason ? `: ${reason}` : ""}`,
      "PRINTER_CONNECTION",
      502,
      { printerId, reason }
    );
    this.name = "PrinterConnectionError";
  }
}

/** The camera/stream is unavailable, so no snapshot can be taken. */
export class CameraError extends AppError {
  constructor(printerId: string, reason: string) {
    super(`Camera error on "${printerId}": ${reason}`, "CAMERA_ERROR", 502, {
      printerId,
      reason
    });
    this.name = "CameraError";
  }
}

/** The loaded material does not match what the job needs, etc. */
export class MaterialError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "MATERIAL_ERROR", 409, details);
    this.name = "MaterialError";
  }
}

/** The requested job/print action is not valid for the current state. */
export class JobError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "JOB_ERROR", 409, details);
    this.name = "JobError";
  }
}

/**
 * An illegal state-machine transition was attempted on a queue entity (e.g.
 * moving a `COMPLETED` task back to `PRINTING`). Raised by the domain
 * transition rules, never by SQLite — a 409 the dashboard can branch on.
 */
export class StateTransitionError extends AppError {
  constructor(entity: string, from: string, to: string) {
    super(
      `Недопустимый переход ${entity}: ${from} → ${to}`,
      "STATE_TRANSITION",
      409,
      { entity, from, to }
    );
    this.name = "StateTransitionError";
  }
}

/**
 * An optimistic-concurrency clash: the caller's `version` no longer matches the
 * stored row, so someone else changed it first. The caller should re-read and
 * retry. A 409 distinct from {@link StateTransitionError} so clients can tell a
 * genuine conflict from an illegal move.
 */
export class VersionConflictError extends AppError {
  constructor(entity: string, id: string, expectedVersion: number) {
    super(
      `Конфликт версий ${entity} «${id}»: ожидалась версия ${expectedVersion}, запись изменена другим процессом`,
      "VERSION_CONFLICT",
      409,
      { entity, id, expectedVersion }
    );
    this.name = "VersionConflictError";
  }
}
