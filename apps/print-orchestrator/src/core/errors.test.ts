import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AppError,
  AuthorizationError,
  CameraError,
  InsufficientStorageError,
  JobError,
  MaterialError,
  NotFoundError,
  PayloadTooLargeError,
  PreviewConflictError,
  PrintIdentityConflictError,
  PrinterConnectionError,
  PrinterOfflineError,
  ServiceBusyError,
  StateTransitionError,
  UnauthorizedError,
  UniqueConstraintError,
  ValidationError,
  VersionConflictError,
  toClientError
} from "./errors";

// ── Taxonomy contract ────────────────────────────────────────────────────────
// name / code / statusCode / message template / interpolation / details shape.
// The messages and their language are part of the public contract — asserted
// verbatim so a stray rewrite is caught, not normalized away.

test("AppError carries code/statusCode/details and defaults the status to 500", () => {
  const err = new AppError("boom", "BOOM");
  assert.equal(err instanceof Error, true);
  assert.equal(err.name, "AppError");
  assert.equal(err.code, "BOOM");
  assert.equal(err.statusCode, 500);
  assert.equal(err.details, undefined);
  assert.equal(err.message, "boom");
});

test("the fixed-status errors keep their name/code/status/message", () => {
  const auth = new AuthorizationError();
  assert.deepEqual([auth.name, auth.code, auth.statusCode, auth.message], [
    "AuthorizationError",
    "FORBIDDEN",
    403,
    "Forbidden"
  ]);

  const unauth = new UnauthorizedError();
  assert.deepEqual([unauth.name, unauth.code, unauth.statusCode, unauth.message], [
    "UnauthorizedError",
    "UNAUTHORIZED",
    401,
    "Valid API token required"
  ]);

  const notFound = new NotFoundError("Задание");
  assert.deepEqual([notFound.name, notFound.code, notFound.statusCode, notFound.message], [
    "NotFoundError",
    "NOT_FOUND",
    404,
    "Задание not found"
  ]);
});

test("upload/capacity errors map to their HTTP statuses and pass details through", () => {
  const cases: Array<[AppError, string, number]> = [
    [new ValidationError("bad", { field: "x" }), "VALIDATION", 400],
    [new PayloadTooLargeError("big", { limitBytes: 10 }), "PAYLOAD_TOO_LARGE", 413],
    [new InsufficientStorageError("full"), "INSUFFICIENT_STORAGE", 507],
    [new ServiceBusyError("busy"), "SERVICE_BUSY", 503],
    [new MaterialError("mismatch"), "MATERIAL_ERROR", 409],
    [new JobError("illegal"), "JOB_ERROR", 409],
    [new PreviewConflictError("stale"), "PREVIEW_CONFLICT", 409]
  ];
  for (const [err, code, status] of cases) {
    assert.equal(err.code, code, code);
    assert.equal(err.statusCode, status, code);
  }
  assert.deepEqual(new ValidationError("bad", { field: "x" }).details, { field: "x" });
});

test("domain errors interpolate their arguments into structured details", () => {
  assert.deepEqual(new PrinterOfflineError("k2").details, { printerId: "k2" });
  assert.equal(new PrinterOfflineError("k2").message, "Принтер «k2» не в сети");

  assert.deepEqual(new StateTransitionError("task", "COMPLETED", "PRINTING").details, {
    entity: "task",
    from: "COMPLETED",
    to: "PRINTING"
  });
  assert.equal(
    new StateTransitionError("task", "COMPLETED", "PRINTING").message,
    "Недопустимый переход task: COMPLETED → PRINTING"
  );

  assert.deepEqual(new VersionConflictError("task", "t1", 3).details, {
    entity: "task",
    id: "t1",
    expectedVersion: 3
  });
  assert.deepEqual(new UniqueConstraintError("run").details, { entity: "run", detail: undefined });
});

test("PrintIdentityConflictError renders null expected/actual as an em dash", () => {
  const err = new PrintIdentityConflictError("K2", null, "job-b");
  assert.equal(err.code, "PRINT_IDENTITY_CONFLICT");
  assert.equal(err.statusCode, 409);
  assert.deepEqual(err.details, { printerName: "K2", expected: null, actual: "job-b" });
  assert.match(err.message, /ожидалось «—»/);
  assert.match(err.message, /печатается «job-b»/);
});

// ── cause preservation ───────────────────────────────────────────────────────

test("AppError preserves the original error as `cause` for diagnostics", () => {
  const original = new Error("socket hang up");
  const wrapped = new AppError("wrapped", "WRAP", 500, undefined, { cause: original });
  assert.equal(wrapped.cause, original);
});

test("PrinterConnectionError keeps a short client reason but preserves the full cause", () => {
  const original = Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
  const err = new PrinterConnectionError("k2", "fetch failed", { cause: original });
  assert.equal(err.cause, original, "the raw transport error is retained server-side");
  assert.equal(err.message, "Не удалось связаться с принтером «k2»: fetch failed");
  assert.deepEqual(err.details, { printerId: "k2", reason: "fetch failed" });
});

// ── client-safe serialization ────────────────────────────────────────────────

test("toClientError emits only code/message/details and never the cause", () => {
  const secret = new Error("ENOENT: /srv/secrets/printer.key, token=abcdef");
  const err = new PrinterConnectionError("k2", "fetch failed", { cause: secret });

  const body = toClientError(err);
  assert.deepEqual(Object.keys(body).sort(), ["code", "details", "message"]);
  assert.equal(body.code, "PRINTER_CONNECTION");
  assert.deepEqual(body.details, { printerId: "k2", reason: "fetch failed" });

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("cause"), false, "no cause key on the wire");
  assert.equal(serialized.includes("/srv/secrets"), false, "no internal path leaks");
  assert.equal(serialized.includes("token=abcdef"), false, "no token leaks");
});

test("toClientError normalizes a missing/non-object details to null", () => {
  assert.equal(toClientError(new AppError("m", "C")).details, null);
  // Defends the plain-object contract even against an `as any` bypass.
  const sneaky = new AppError("m", "C", 400, ["array"] as unknown as Record<string, unknown>);
  assert.equal(toClientError(sneaky).details, null);
});
