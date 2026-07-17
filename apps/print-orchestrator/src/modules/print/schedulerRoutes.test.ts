import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

/*
 * The `/api/print/scheduler` HTTP surface end-to-end through the real farmStore
 * singleton, with no printers configured (the store is never started) — so it
 * exercises the routing, the CSRF/token guard on mutations, the honest "no
 * compatible printers" path, and pin validation against the farm config. env
 * freezes on first import, so process.env is set before anything reads it.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-routes-"));
const TOKEN = "scheduler-test-token";
process.env.ORCHESTRATOR_API_TOKEN = TOKEN;
process.env.STATE_FILE_PATH = path.join(TMP, "state.json");
process.env.PRINTERS_CONFIG_PATH = path.join(TMP, "no-printers.json");

let app: FastifyInstance;

const auth = { authorization: `Bearer ${TOKEN}` };

before(async () => {
  const { AppError } = await import("../../core/errors");
  const { registerSecurity } = await import("../../http/security");
  const { registerPrintQueueRoutes } = await import("./routes");

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
  await app.register(registerPrintQueueRoutes, { prefix: "/api/print" });
  await app.ready();
});

after(async () => {
  await app.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("a mutation without the token is refused by the shared guard", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/print/scheduler/queue",
    payload: { title: "no-token" }
  });
  assert.ok(res.statusCode === 401 || res.statusCode === 403);
});

test("POST /scheduler/queue adds a task; GET /scheduler/queue lists it", async () => {
  const add = await app.inject({
    method: "POST",
    url: "/api/print/scheduler/queue",
    headers: auth,
    payload: { title: "Bracket", material: "PETG", priority: 3, unattendedAllowed: true }
  });
  assert.equal(add.statusCode, 200);
  const task = add.json().task.task;
  assert.equal(task.state, "QUEUED");
  assert.equal(task.priority, 3);

  const list = await app.inject({ method: "GET", url: "/api/print/scheduler/queue" });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().queue.some((row: { task: { id: string } }) => row.task.id === task.id));
  return task;
});

test("params, pin/unpin and reorder round-trip over HTTP", async () => {
  const add = await app.inject({
    method: "POST",
    url: "/api/print/scheduler/queue",
    headers: auth,
    payload: { title: "Params" }
  });
  const detail = add.json().task;
  const taskId = detail.task.id;
  const version = detail.queueEntry.version;

  const params = await app.inject({
    method: "POST",
    url: `/api/print/scheduler/tasks/${taskId}/params`,
    headers: auth,
    payload: { priority: 7, deadline: "2026-07-18T09:00:00.000Z", dayNightPreference: "night" }
  });
  assert.equal(params.statusCode, 200);
  assert.equal(params.json().task.priority, 7);
  assert.equal(params.json().task.dayNightPreference, "night");

  // A pin to a printer the farm does not know is refused (400) — no printers are
  // configured in this harness, so any pin is an unknown-printer pin.
  const pin = await app.inject({
    method: "POST",
    url: `/api/print/scheduler/tasks/${taskId}/pin`,
    headers: auth,
    payload: { printer: "ghost-9000" }
  });
  assert.equal(pin.statusCode, 400);

  // Unpin is always safe (idempotent) and leaves the task unpinned.
  const unpin = await app.inject({
    method: "POST",
    url: `/api/print/scheduler/tasks/${taskId}/unpin`,
    headers: auth
  });
  assert.equal(unpin.json().task.pinnedPrinterId, null);

  const reorder = await app.inject({
    method: "POST",
    url: `/api/print/scheduler/tasks/${taskId}/reorder`,
    headers: auth,
    payload: { position: 5, expectedVersion: version }
  });
  assert.equal(reorder.statusCode, 200);
  // Positions are renormalised to POSITION_STEP multiples on every reorder (so the
  // dashboard's neighbour ± 1 never collapses a gap); the sole entry lands at 10.
  assert.equal(reorder.json().entry.position, 10);

  // A stale expectedVersion now conflicts (409).
  const stale = await app.inject({
    method: "POST",
    url: `/api/print/scheduler/tasks/${taskId}/reorder`,
    headers: auth,
    payload: { position: 9, expectedVersion: version }
  });
  assert.equal(stale.statusCode, 409);
});

test("GET /scheduler/compatibility and the plan lifecycle respond over HTTP", async () => {
  const matrix = await app.inject({ method: "GET", url: "/api/print/scheduler/compatibility" });
  assert.equal(matrix.statusCode, 200);
  assert.ok(Array.isArray(matrix.json().printers));

  const draft = await app.inject({ method: "POST", url: "/api/print/scheduler/plans", headers: auth });
  assert.equal(draft.statusCode, 200);
  const planId = draft.json().plan.plan.id;
  assert.equal(draft.json().plan.plan.state, "DRAFT");
  assert.equal(draft.json().plan.plan.revision, 1);

  const confirm = await app.inject({
    method: "POST",
    url: `/api/print/scheduler/plans/${planId}/confirm`,
    headers: auth
  });
  assert.equal(confirm.statusCode, 200);
  assert.equal(confirm.json().plan.plan.state, "ACTIVE");
});

test("GET /scheduler/night reports candidates with the configured buffer", async () => {
  const res = await app.inject({ method: "GET", url: "/api/print/scheduler/night" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok("candidates" in body && "rejected" in body);
  assert.equal(typeof body.safetyBufferRatio, "number");
});

test("material override: unknown printer is refused (400); the active list starts empty", async () => {
  const list = await app.inject({ method: "GET", url: "/api/print/scheduler/material" });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().overrides, [], "no printers configured → no overrides");

  const bad = await app.inject({
    method: "POST",
    url: "/api/print/scheduler/printers/ghost-9000/material",
    headers: auth,
    payload: { coverageHours: 8 }
  });
  assert.equal(bad.statusCode, 400);
});
