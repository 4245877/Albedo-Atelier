import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

/*
 * The `/api/print/schedule` and `/api/print/operations` HTTP surface end-to-end
 * through the real farmStore singleton, with no printers configured (the store
 * is never started) — so it exercises the routing, the shared CSRF/token guard
 * on every mutation (including DELETE), the schedule round-trip and the
 * operation lifecycle. No printer is contacted: none is configured, and no route
 * here reaches a device.
 *
 * env freezes on first import, so process.env is set before anything reads it.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "operations-routes-"));
const TOKEN = "operations-test-token";
process.env.ORCHESTRATOR_API_TOKEN = TOKEN;
process.env.STATE_FILE_PATH = path.join(TMP, "state.json");
process.env.PRINTERS_CONFIG_PATH = path.join(TMP, "no-printers.json");

let app: FastifyInstance;

const auth = { authorization: `Bearer ${TOKEN}` };

before(async () => {
  const { AppError } = await import("../../core/errors");
  const { registerSecurity } = await import("../../http/security");
  const { registerPrintQueueRoutes } = await import("./routes");
  const { farmStore } = await import("../../app/farmStore");

  app = Fastify();
  registerSecurity(app);
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return;
    }
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    reply.code(status).send({ error: { code: "ERR", message: error.message } });
  });
  await app.register(registerPrintQueueRoutes, {
    prefix: "/api/print",
    services: farmStore,
    commands: farmStore.commands
  });
  await app.ready();
});

after(async () => {
  await app.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const body = (res: { body: string }): Record<string, unknown> => JSON.parse(res.body);

/** The `{ error: { message } }` envelope the shared error handler sends. */
const errorMessage = (res: { body: string }): string =>
  (body(res) as { error?: { message?: string } }).error?.message ?? "";

// ── The guard ───────────────────────────────────────────────────────────────

test("every mutation is refused without the token — POST and DELETE alike", async () => {
  for (const [method, url] of [
    ["POST", "/api/print/schedule"],
    ["POST", "/api/print/schedule/exceptions"],
    ["POST", "/api/print/schedule/absences"],
    ["POST", "/api/print/operations"],
    ["DELETE", "/api/print/schedule/exceptions/shx_1"],
    ["DELETE", "/api/print/schedule/absences/abs_1"]
  ] as const) {
    const res = await app.inject({ method, url, payload: {} });
    assert.ok(
      res.statusCode === 401 || res.statusCode === 403,
      `${method} ${url} → ${res.statusCode}`
    );
  }
});

// ── Schedule ────────────────────────────────────────────────────────────────

test("GET /schedule starts UNKNOWN — a farm with no schedule fails closed", async () => {
  const res = await app.inject({ method: "GET", url: "/api/print/schedule" });
  assert.equal(res.statusCode, 200);
  const payload = body(res) as unknown as {
    schedule: { operator: { timeZone: string | null }; availability: { presence: string; resolved: boolean } };
    operators: unknown[];
  };
  assert.equal(payload.operators.length, 1, "migration 011 seeds exactly one operator");
  assert.equal(payload.schedule.operator.timeZone, null, "no zone is assumed from the environment");
  assert.equal(payload.schedule.availability.presence, "UNKNOWN");
  assert.equal(payload.schedule.availability.resolved, false);
});

test("POST /schedule stores the timezone and the whole week, including a sleep window past midnight", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/print/schedule",
    headers: auth,
    payload: {
      timeZone: "Europe/Moscow",
      available: [
        { weekday: 1, start: "08:00", end: "20:00" },
        { weekday: 2, start: "08:00", end: "20:00" }
      ],
      sleep: [{ weekday: 1, start: "23:00", end: "07:00" }]
    }
  });
  assert.equal(res.statusCode, 200);
  const payload = body(res) as unknown as {
    schedule: {
      operator: { timeZone: string };
      available: { weekday: number; start: string; end: string }[];
      sleep: { weekday: number; start: string; end: string }[];
      availability: { resolved: boolean };
    };
  };
  assert.equal(payload.schedule.operator.timeZone, "Europe/Moscow");
  assert.equal(payload.schedule.available.length, 2);
  assert.deepEqual(payload.schedule.sleep, [{ weekday: 1, start: "23:00", end: "07:00" }]);
  assert.equal(payload.schedule.availability.resolved, true, "the schedule now resolves");
});

test("POST /schedule refuses a bogus timezone at write time rather than failing closed at 3 a.m.", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/print/schedule",
    headers: auth,
    payload: { timeZone: "Moscow/Nowhere" }
  });
  assert.equal(res.statusCode, 400);
  assert.match(errorMessage(res), /IANA/);

  // The previously stored, valid zone survived the rejected write.
  const after = await app.inject({ method: "GET", url: "/api/print/schedule" });
  assert.equal(
    (body(after) as unknown as { schedule: { operator: { timeZone: string } } }).schedule.operator.timeZone,
    "Europe/Moscow"
  );
});

test("POST /schedule replaces the week wholesale — a partial week is never readable", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/print/schedule",
    headers: auth,
    payload: { available: [{ weekday: 3, start: "10:00", end: "14:00" }], sleep: [] }
  });
  assert.equal(res.statusCode, 200);
  const payload = body(res) as unknown as {
    schedule: { available: { weekday: number }[]; sleep: unknown[] };
  };
  assert.deepEqual(payload.schedule.available.map((w) => w.weekday), [3], "Mon/Tue are gone");
  assert.equal(payload.schedule.sleep.length, 0);
});

test("a date exception round-trips and can be removed", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/print/schedule/exceptions",
    headers: auth,
    payload: { date: "2026-08-01", kind: "available", start: "12:00", end: "16:00", note: "короткий день" }
  });
  assert.equal(created.statusCode, 200);
  const exception = (body(created) as unknown as { exception: { id: string; startMinutes: number } }).exception;
  assert.equal(exception.startMinutes, 12 * 60);

  const listed = await app.inject({ method: "GET", url: "/api/print/schedule" });
  assert.equal(
    (body(listed) as unknown as { schedule: { exceptions: unknown[] } }).schedule.exceptions.length,
    1
  );

  const removed = await app.inject({
    method: "DELETE",
    url: `/api/print/schedule/exceptions/${exception.id}`,
    headers: auth
  });
  assert.equal(removed.statusCode, 200);
  const empty = await app.inject({ method: "GET", url: "/api/print/schedule" });
  assert.equal(
    (body(empty) as unknown as { schedule: { exceptions: unknown[] } }).schedule.exceptions.length,
    0
  );
});

test("a malformed exception is a 400, not a silently-stored zero", async () => {
  for (const payload of [
    { date: "01.08.2026", kind: "available", start: "12:00", end: "16:00" },
    { date: "2026-08-01", kind: "нечто", start: "12:00", end: "16:00" },
    { date: "2026-08-01", kind: "available", start: "25:00", end: "16:00" },
    { date: "2026-08-01", kind: "available" }
  ]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/print/schedule/exceptions",
      headers: auth,
      payload
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
});

test("an absence round-trips; an end before its start is refused", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/print/schedule/absences",
    headers: auth,
    payload: { startsAt: "2026-08-10T00:00:00Z", endsAt: "2026-08-20T00:00:00Z", reason: "отпуск" }
  });
  assert.equal(created.statusCode, 200);
  const absence = (body(created) as unknown as { absence: { id: string } }).absence;

  const bad = await app.inject({
    method: "POST",
    url: "/api/print/schedule/absences",
    headers: auth,
    payload: { startsAt: "2026-08-20T00:00:00Z", endsAt: "2026-08-10T00:00:00Z" }
  });
  assert.equal(bad.statusCode, 400);

  const removed = await app.inject({
    method: "DELETE",
    url: `/api/print/schedule/absences/${absence.id}`,
    headers: auth
  });
  assert.equal(removed.statusCode, 200);
});

// ── Operations ──────────────────────────────────────────────────────────────

test("GET /operations/types exposes the whole vocabulary with per-type durations", async () => {
  const res = await app.inject({ method: "GET", url: "/api/print/operations/types" });
  assert.equal(res.statusCode, 200);
  const types = (body(res) as unknown as {
    types: { type: string; label: string; defaultMinutes: number }[];
  }).types;
  assert.equal(types.length, 8, "all eight typed interventions from the brief");
  const byType = new Map(types.map((t) => [t.type, t]));
  assert.equal(byType.get("NOZZLE_CHANGE")?.defaultMinutes, 25);
  assert.equal(byType.get("MATERIAL_CHANGE")?.defaultMinutes, 15);
  assert.notEqual(
    byType.get("NOZZLE_CHANGE")?.defaultMinutes,
    byType.get("MATERIAL_CHANGE")?.defaultMinutes
  );
  for (const t of types) assert.ok(t.label.length > 0, `${t.type} has an operator-facing label`);
});

test("an operation can be opened, listed with its hold, confirmed, and confirmed again idempotently", async () => {
  const opened = await app.inject({
    method: "POST",
    url: "/api/print/operations",
    headers: auth,
    payload: { type: "NOZZLE_CHANGE", printerId: "k2", reason: "нужен 0.6" }
  });
  assert.equal(opened.statusCode, 200);
  const operation = (body(opened) as unknown as {
    operation: { id: string; state: string; blocking: boolean; estimatedMinutes: number };
  }).operation;
  assert.equal(operation.blocking, true);
  assert.equal(operation.estimatedMinutes, 25, "the type default is stamped at creation");

  const listed = await app.inject({ method: "GET", url: "/api/print/operations" });
  const payload = body(listed) as unknown as {
    operations: { operation: { id: string }; ready: boolean; reason: string; expectedMinutes: number }[];
    holds: { printerId: string; free: boolean; releaseAt: string | null }[];
  };
  const row = payload.operations.find((o) => o.operation.id === operation.id);
  assert.ok(row, "the operation is in the pending queue");
  assert.equal(row.expectedMinutes, 25);
  const hold = payload.holds.find((held) => held.printerId === "k2");
  assert.equal(hold?.free, false, "the printer is held while it is outstanding");

  const done = await app.inject({
    method: "POST",
    url: `/api/print/operations/${operation.id}/complete`,
    headers: auth,
    payload: { actor: "operator-9", actualMinutes: 31 }
  });
  assert.equal(done.statusCode, 200);
  const completed = (body(done) as unknown as {
    operation: { state: string; confirmedBy: string; actualMinutes: number; completedAt: string };
  }).operation;
  assert.equal(completed.state, "COMPLETED");
  assert.equal(completed.confirmedBy, "operator-9");
  assert.equal(completed.actualMinutes, 31, "the reported actual duration is kept, not the estimate");

  const again = await app.inject({
    method: "POST",
    url: `/api/print/operations/${operation.id}/complete`,
    headers: auth,
    payload: { actor: "operator-other", actualMinutes: 1 }
  });
  assert.equal(again.statusCode, 200);
  const repeat = (body(again) as unknown as {
    operation: { confirmedBy: string; completedAt: string; actualMinutes: number };
  }).operation;
  assert.equal(repeat.confirmedBy, "operator-9", "the first confirmation stands");
  assert.equal(repeat.completedAt, completed.completedAt);
  assert.equal(repeat.actualMinutes, 31);
});

test("POST /operations validates the type and the printer instead of inventing defaults", async () => {
  for (const payload of [
    { printerId: "k2" },
    { type: "СНЯТЬ_МОДЕЛЬ", printerId: "k2" },
    { type: "PART_REMOVAL" }
  ]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/print/operations",
      headers: auth,
      payload
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
});

test("an explicitly unestimated operation reports an unknown release time, never a guess", async () => {
  const opened = await app.inject({
    method: "POST",
    url: "/api/print/operations",
    headers: auth,
    payload: { type: "CALIBRATION", printerId: "unknown-duration-printer", estimatedMinutes: null }
  });
  assert.equal(opened.statusCode, 200);

  const listed = await app.inject({ method: "GET", url: "/api/print/operations" });
  const payload = body(listed) as unknown as {
    holds: { printerId: string; free: boolean; releaseAt: string | null }[];
  };
  const hold = payload.holds.find((h) => h.printerId === "unknown-duration-printer");
  assert.equal(hold?.free, false);
  assert.equal(hold?.releaseAt, null, "fail-closed: no duration ⇒ no promised release");
});

test("claiming an operation requires naming the operator", async () => {
  const opened = await app.inject({
    method: "POST",
    url: "/api/print/operations",
    headers: auth,
    payload: { type: "VISUAL_INSPECTION", printerId: "k2" }
  });
  const id = (body(opened) as unknown as { operation: { id: string } }).operation.id;

  const anonymous = await app.inject({
    method: "POST",
    url: `/api/print/operations/${id}/claim`,
    headers: auth,
    payload: {}
  });
  assert.equal(anonymous.statusCode, 400, "an unattributed claim is not a claim");
});
