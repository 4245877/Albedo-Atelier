import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

/*
 * The `/api/printers/config` surface end-to-end through the real farmStore
 * singleton: routing, the shared token guard on every mutation, and the
 * add → test → re-credential → remove flow an operator actually performs.
 *
 * No device is contacted: the printers created here point at an address nothing
 * answers on, and no test calls the probe route.
 *
 * env freezes on first import, so process.env is set before anything reads it.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "printer-config-routes-"));
const TOKEN = "printer-config-test-token";
process.env.ORCHESTRATOR_API_TOKEN = TOKEN;
process.env.STATE_FILE_PATH = path.join(TMP, "state.json");
process.env.PRINTERS_CONFIG_PATH = path.join(TMP, "no-printers.json");

let app: FastifyInstance;

const auth = { authorization: `Bearer ${TOKEN}` };

before(async () => {
  const { AppError } = await import("../../core/errors");
  const { registerSecurity } = await import("../../http/security");
  const { registerPrinterConfigRoutes } = await import("./configRoutes");
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
  await app.register(registerPrinterConfigRoutes, {
    prefix: "/api/printers/config",
    printerConfig: () => farmStore.printerConfig
  });
  await app.ready();
});

after(async () => {
  await app.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const body = (res: { body: string }): Record<string, unknown> => JSON.parse(res.body);
const errorMessage = (res: { body: string }): string =>
  (body(res) as { error?: { message?: string } }).error?.message ?? "";

const moonraker = {
  id: "k2-test",
  name: "Creality K2",
  protocol: "moonraker",
  host: "192.0.2.10",
  port: 4408,
  light: { pin: "LED" }
};

// ── The guard ───────────────────────────────────────────────────────────────

test("every change to the farm's hardware requires the API token", async () => {
  for (const [method, url] of [
    ["POST", "/api/printers/config"],
    ["PATCH", "/api/printers/config/k2-test"],
    ["POST", "/api/printers/config/k2-test/enabled"],
    ["POST", "/api/printers/config/k2-test/test"],
    ["POST", "/api/printers/config/reorder"],
    ["DELETE", "/api/printers/config/k2-test"]
  ] as const) {
    const res = await app.inject({ method, url, payload: {} });
    assert.equal(res.statusCode, 401, `${method} ${url} must refuse an unauthenticated caller`);
  }
});

test("reads stay open — the dashboard lists printers without a token", async () => {
  const res = await app.inject({ method: "GET", url: "/api/printers/config" });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(body(res).printers));
});

// ── The lifecycle of a printer ──────────────────────────────────────────────

test("POST adds a printer and it is listed straight away", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/printers/config",
    headers: auth,
    payload: { ...moonraker, operator: "миха" }
  });
  assert.equal(res.statusCode, 201);
  const printer = body(res).printer as Record<string, unknown>;
  assert.equal(printer.id, "k2-test");
  assert.equal(printer.protocol, "moonraker");

  const list = await app.inject({ method: "GET", url: "/api/printers/config" });
  const printers = body(list).printers as { id: string }[];
  assert.ok(printers.some((p) => p.id === "k2-test"));
});

test("a rejected field is answered with a 400 naming it, not a silent drop", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/printers/config",
    headers: auth,
    payload: { ...moonraker, id: "another", interfaceUrl: "javascript:alert(1)" }
  });
  assert.equal(res.statusCode, 400);
  assert.match(errorMessage(res), /interfaceUrl/);

  const missing = await app.inject({
    method: "POST",
    url: "/api/printers/config",
    headers: auth,
    payload: { id: "no-host", name: "Без адреса", protocol: "moonraker" }
  });
  assert.equal(missing.statusCode, 400);
  assert.match(errorMessage(missing), /host/);
});

test("PATCH updates settings and returns the printer with credentials masked", async () => {
  const res = await app.inject({
    method: "PATCH",
    url: "/api/printers/config/k2-test",
    headers: auth,
    payload: { material: "PETG", swatch: "#4c4f55", apiKey: "secret-moonraker-key" }
  });
  assert.equal(res.statusCode, 200);
  const printer = body(res).printer as Record<string, unknown>;
  assert.equal(printer.material, "PETG");
  assert.deepEqual(printer.secrets, {
    apiKey: { set: true, source: "literal", envVar: null, resolved: true },
    serial: { set: false, source: "none", envVar: null, resolved: false },
    accessCode: { set: false, source: "none", envVar: null, resolved: false }
  });
  assert.ok(!res.body.includes("secret-moonraker-key"), "the key must not come back out");
});

test("GET /:id never discloses a stored credential", async () => {
  const res = await app.inject({ method: "GET", url: "/api/printers/config/k2-test" });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes("secret-moonraker-key"));
  assert.equal((body(res).secrets as Record<string, { set: boolean }>).apiKey.set, true);
});

test("POST /:id/enabled toggles the printer without touching anything else", async () => {
  const off = await app.inject({
    method: "POST",
    url: "/api/printers/config/k2-test/enabled",
    headers: auth,
    payload: { enabled: false }
  });
  assert.equal(off.statusCode, 200);
  assert.equal((body(off).printer as { enabled: boolean }).enabled, false);

  const bad = await app.inject({
    method: "POST",
    url: "/api/printers/config/k2-test/enabled",
    headers: auth,
    payload: { enabled: "нет" }
  });
  assert.equal(bad.statusCode, 400);

  const on = await app.inject({
    method: "POST",
    url: "/api/printers/config/k2-test/enabled",
    headers: auth,
    payload: { enabled: true }
  });
  assert.equal((body(on).printer as { enabled: boolean }).enabled, true);
});

test("GET /options serves the protocol vocabulary the form is built from", async () => {
  const res = await app.inject({ method: "GET", url: "/api/printers/config/options" });
  assert.equal(res.statusCode, 200);
  const protocols = body(res).protocols as { id: string; credentials: string[] }[];
  assert.deepEqual(
    protocols.map((p) => p.id),
    ["moonraker", "bambu", "creality"]
  );
  assert.deepEqual(protocols.find((p) => p.id === "bambu")?.credentials, ["serial", "accessCode"]);
});

test("an unknown printer is a 404 on read and on write alike", async () => {
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/printers/config/ghost" })).statusCode,
    404
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: "/api/printers/config/ghost",
        headers: auth,
        payload: { name: "x" }
      })
    ).statusCode,
    404
  );
});

test("DELETE removes the printer from the farm", async () => {
  const res = await app.inject({
    method: "DELETE",
    url: "/api/printers/config/k2-test",
    headers: auth
  });
  assert.equal(res.statusCode, 200);

  const list = await app.inject({ method: "GET", url: "/api/printers/config" });
  const printers = body(list).printers as { id: string }[];
  assert.ok(!printers.some((p) => p.id === "k2-test"));
});
