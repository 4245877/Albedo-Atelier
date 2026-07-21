/**
 * The client-safe shape of {@link AppError.details}: a record of STRUCTURED
 * domain fields the dashboard branches on (`printerId`, `expected`/`actual`,
 * `entity`, `from`/`to`, `limitBytes`, …). It is serialized verbatim into the
 * JSON error body (see the app's error handler), so by contract it must carry
 * only such domain values — never raw transport/driver text, secrets, tokens,
 * file-system paths or an `Error`/stack. Anything diagnostic goes in
 * {@link AppErrorOptions.cause} instead, which stays server-side.
 */
export type AppErrorDetails = Record<string, unknown>;

export interface AppErrorOptions {
  /**
   * The original error, preserved for server-side diagnostics/logging. NEVER
   * serialized to the client — the error handler emits only code/message/details.
   */
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: AppErrorDetails;

  constructor(
    message: string,
    code: string,
    statusCode = 500,
    details?: AppErrorDetails,
    options?: AppErrorOptions
  ) {
    // Error's native `{ cause }` (ES2022, our target) keeps the original error
    // reachable as `error.cause` without ever putting it on the wire.
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

/** The client-safe JSON error body an {@link AppError} is serialized to. */
export interface ClientErrorBody {
  code: string;
  message: string;
  details: AppErrorDetails | null;
}

/**
 * Projects an {@link AppError} onto the client-safe body — the single place that
 * decides what leaves the service. Emits the stable `code`, the human `message`,
 * and `details` guarded to a plain object (so only the structured domain
 * contract can reach the client, never an array or stray primitive); by
 * omission it never serializes `cause`, the stack, or any other internal field.
 * Kept here beside the taxonomy, self-contained, so `core` stays a leaf module.
 */
export function toClientError(error: AppError): ClientErrorBody {
  const { details } = error;
  const safeDetails =
    details !== null && typeof details === "object" && !Array.isArray(details) ? details : null;
  return { code: error.code, message: error.message, details: safeDetails };
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
  constructor(message: string, details?: AppErrorDetails) {
    super(message, "VALIDATION", 400, details);
    this.name = "ValidationError";
  }
}

/**
 * An upload exceeded a configured size limit (single file, or a decoded ZIP
 * entry / total). A 413 the dashboard shows against the offending file without
 * failing the rest of a multi-file batch.
 */
export class PayloadTooLargeError extends AppError {
  constructor(message: string, details?: AppErrorDetails) {
    super(message, "PAYLOAD_TOO_LARGE", 413, details);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * The server-side artifact store is at capacity, or the disk is too low on free
 * space, to accept another upload. A 507 (Insufficient Storage) so the dashboard
 * can tell the operator to free space / prune, distinct from a per-file 413.
 */
export class InsufficientStorageError extends AppError {
  constructor(message: string, details?: AppErrorDetails) {
    super(message, "INSUFFICIENT_STORAGE", 507, details);
    this.name = "InsufficientStorageError";
  }
}

/**
 * The analysis backlog is at its bound, so a new upload cannot be accepted right
 * now. A 503 (Service Unavailable) — transient; the operator retries once the
 * queue drains.
 */
export class ServiceBusyError extends AppError {
  constructor(message: string, details?: AppErrorDetails) {
    super(message, "SERVICE_BUSY", 503, details);
    this.name = "ServiceBusyError";
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

/**
 * The printer is configured but the driver/transport failed to reach it.
 * `reason` is the short human-facing summary that goes to the client; the full
 * original transport error is preserved out-of-band as {@link AppError.cause}
 * for server-side diagnostics, never serialized.
 */
export class PrinterConnectionError extends AppError {
  constructor(printerId: string, reason?: string, options?: AppErrorOptions) {
    super(
      `Не удалось связаться с принтером «${printerId}»${reason ? `: ${reason}` : ""}`,
      "PRINTER_CONNECTION",
      502,
      { printerId, reason },
      options
    );
    this.name = "PrinterConnectionError";
  }
}

/** The camera/stream is unavailable, so no snapshot can be taken. */
export class CameraError extends AppError {
  constructor(printerId: string, reason: string, options?: AppErrorOptions) {
    super(
      `Camera error on "${printerId}": ${reason}`,
      "CAMERA_ERROR",
      502,
      { printerId, reason },
      options
    );
    this.name = "CameraError";
  }
}

/** The loaded material does not match what the job needs, etc. */
export class MaterialError extends AppError {
  constructor(message: string, details?: AppErrorDetails) {
    super(message, "MATERIAL_ERROR", 409, details);
    this.name = "MaterialError";
  }
}

/**
 * A dangerous command (cancel/stop) named a specific job to act on, but the
 * device is printing a *different* one — the caller's view was stale (a dashboard
 * polling race). Fail-closed: nothing is cancelled. A 409 with its own code so
 * the dashboard can tell the operator to refresh instead of retrying blindly.
 */
export class PrintIdentityConflictError extends AppError {
  constructor(printerName: string, expected: string | null, actual: string | null) {
    super(
      `На «${printerName}» сейчас идёт не то задание, которое вы видели ` +
        `(ожидалось «${expected ?? "—"}», печатается «${actual ?? "—"}») — обновите панель и повторите`,
      "PRINT_IDENTITY_CONFLICT",
      409,
      { printerName, expected, actual }
    );
    this.name = "PrintIdentityConflictError";
  }
}

/** The requested job/print action is not valid for the current state. */
export class JobError extends AppError {
  constructor(message: string, details?: AppErrorDetails) {
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
 * A database uniqueness invariant refused the write — e.g. a second active run
 * for one printer, a second live assignment for one task, or a repeated
 * dispatch idempotency key racing itself. The SQLite partial unique indexes
 * (migration 008) are the last line of defence behind the service checks; this
 * surfaces their refusal as a 409 instead of a raw driver error.
 */
export class UniqueConstraintError extends AppError {
  constructor(entity: string, detail?: string) {
    super(
      `Конфликт уникальности ${entity}${detail ? ` (${detail})` : ""} — параллельная операция уже создала конкурирующую запись`,
      "UNIQUE_CONFLICT",
      409,
      { entity, detail }
    );
    this.name = "UniqueConstraintError";
  }
}

/**
 * The immutable set the operator previewed/confirmed no longer matches reality:
 * the queue, the task version, the artifact hash or the printer state moved
 * between preview and start. Fail-closed: nothing is dispatched; the operator
 * must refresh the preview and confirm again.
 */
export class PreviewConflictError extends AppError {
  constructor(message: string, details?: AppErrorDetails) {
    super(message, "PREVIEW_CONFLICT", 409, details);
    this.name = "PreviewConflictError";
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
