import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

/*
 * The automatic queue over HTTP, on the real farmStore singleton with the
 * DEFAULT configuration — which is the point: nothing is set, so the executor
 * must be off, its rule locked, a pass refused, and the dry run still answer.
 *
 * env freezes on first import, so process.env is set at module top and
 * everything that reads it is imported dynamically after. No printers.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-auto-queue-routes-"));
const TOKEN = "auto-queue-test-token";
process.env.ORCHESTRATOR_API_TOKEN = TOKEN;
process.env.STATE_FILE_PATH = path.join(TMP, "state.json");
process.env.PRINTERS_CONFIG_PATH = path.join(TMP, "no-printers.json");
delete process.env.AUTO_QUEUE_ENABLED;

let app: FastifyInstance;

before(async () => {
  const { AppError, toClientError } = await import("../../core/errors");
  const { registerSecurity } = await import("../../http/security");
  const { registerAutomationRoutes } = await import("./routes");
  const { farmStore } = await import("../../app/farmStore");

  app = Fastify();
  registerSecurity(app);
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({ error: toClientError(error) });
      return;
    }
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    reply.code(status).send({ error: { code: "ERR", message: error.message } });
  });
  await app.register(registerAutomationRoutes, {
    prefix: "/api/automations",
    reads: farmStore.reads,
    commands: farmStore.commands
  });
  await app.ready();
});

after(async () => {
  await app.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const AUTH = { authorization: `Bearer ${TOKEN}` };

test("by default the «Автоочередь» rule is off and locked, with the reason", async () => {
  const res = await app.inject({ method: "GET", url: "/api/automations" });
  assert.equal(res.statusCode, 200);
  const rule = res.json().automations.find((a: { id: string }) => a.id === "auto-queue");
  assert.ok(rule, "the rule is listed");
  assert.equal(rule.on, false);
  assert.match(rule.locked, /AUTO_QUEUE_ENABLED=false/);
});

test("switching it on is refused (409) while the deployment switch is off", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/automations/auto-queue/toggle",
    payload: { on: true },
    headers: AUTH
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.details.code, "AUTOMATION_LOCKED");
  const off = await app.inject({
    method: "POST",
    url: "/api/automations/auto-queue/toggle",
    payload: { on: false },
    headers: AUTH
  });
  assert.equal(off.statusCode, 200, "switching off is always allowed");
});

test("the status and the dry run answer while it is off; a pass is refused", async () => {
  const overview = await app.inject({ method: "GET", url: "/api/automations/auto-queue" });
  assert.equal(overview.statusCode, 200);
  const body = overview.json();
  assert.equal(body.status.configured, false);
  assert.equal(body.status.armed, false);
  assert.equal(body.status.startedAt, null, "no timer in a process that does not allow it");
  assert.deepEqual(body.plan, []);

  const tick = await app.inject({ method: "POST", url: "/api/automations/auto-queue/tick", payload: {}, headers: AUTH });
  assert.equal(tick.statusCode, 409);
  assert.equal(tick.json().error.details.code, "AUTO_QUEUE_NOT_CONFIGURED");

  const noToken = await app.inject({ method: "POST", url: "/api/automations/auto-queue/tick", payload: {} });
  assert.equal(noToken.statusCode, 401);
});
