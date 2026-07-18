import assert from "node:assert/strict";
import { test } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

/*
 * The security hook with a configured API token: state-changing requests
 * require the token AND a trusted Origin (same-host or allowlisted); reads
 * stay open; the CSRF Origin check refuses foreign browser origins even when
 * the request carries a valid token (an nginx-injected token must not defeat
 * the CSRF protection).
 *
 * env freezes process.env at first import, so the variables are set here at
 * module top and ./security is imported dynamically inside the helpers.
 */

const TOKEN = "night-farm-token";
process.env.ORCHESTRATOR_API_TOKEN = TOKEN;
process.env.CORS_ALLOW_ORIGINS = "http://ally.example";
// The Host allowlist refuses unknown DNS names (anti-rebinding); the tests
// below address the service as farm.local, so it is allowlisted here.
process.env.ALLOWED_HOSTS = "farm.local";

async function buildApp(): Promise<FastifyInstance> {
  const { registerSecurity } = await import("./security");
  const app = Fastify();
  registerSecurity(app);
  app.post("/act", async () => ({ ok: true }));
  app.get("/read", async () => ({ ok: true }));
  return app;
}

test("reads stay open without a token", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/read" });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("a mutating request without the token is refused with 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "POST", url: "/act" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, "UNAUTHORIZED");

  const wrong = await app.inject({
    method: "POST",
    url: "/act",
    headers: { authorization: "Bearer wrong-token" }
  });
  assert.equal(wrong.statusCode, 401);
  await app.close();
});

test("the token is accepted as Bearer and as X-Api-Token", async () => {
  const app = await buildApp();
  const bearer = await app.inject({
    method: "POST",
    url: "/act",
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  assert.equal(bearer.statusCode, 200);

  const header = await app.inject({
    method: "POST",
    url: "/act",
    headers: { "x-api-token": TOKEN }
  });
  assert.equal(header.statusCode, 200);
  await app.close();
});

test("a foreign Origin is refused even with a valid token (CSRF guard)", async () => {
  const app = await buildApp();
  for (const origin of ["http://evil.example", "null"]) {
    const res = await app.inject({
      method: "POST",
      url: "/act",
      headers: { origin, authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(res.statusCode, 403, origin);
    assert.equal(res.json().error.code, "FORBIDDEN_ORIGIN", origin);
  }
  await app.close();
});

test("the dashboard's own origin (same host:port) passes the CSRF guard", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/act",
    headers: {
      host: "farm.local:8090",
      origin: "http://farm.local:8090",
      authorization: `Bearer ${TOKEN}`
    }
  });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("an allowlisted cross-origin client passes and gets CORS headers", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/act",
    headers: { origin: "http://ally.example", authorization: `Bearer ${TOKEN}` }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], "http://ally.example");
  await app.close();
});

test("preflight is answered without executing anything", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "OPTIONS",
    url: "/act",
    headers: { origin: "http://evil.example" }
  });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  await app.close();
});

test("camera.jpg?ensureLight=1 (side-effect GET) requires the token; plain reads do not", async () => {
  const { registerPrinterRoutes } = await import("../modules/printers/routes");
  const { AppError } = await import("../core/errors");

  const calls: Array<{ id: string; ensureLight: boolean }> = [];
  const store = {
    async getCameraFrame(id: string, options: { ensureLight?: boolean } = {}) {
      calls.push({ id, ensureLight: Boolean(options.ensureLight) });
      return { data: Buffer.from([0xff, 0xd8]), mime: "image/jpeg" };
    }
  } as never;

  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return;
    }
    reply.code(500).send({ error: { code: "INTERNAL", message: "Internal Server Error" } });
  });
  await app.register(registerPrinterRoutes, { prefix: "/api/printers", store });

  const open = await app.inject({ method: "GET", url: "/api/printers/k2/camera.jpg" });
  assert.equal(open.statusCode, 200, "a plain frame read stays open");

  const blocked = await app.inject({
    method: "GET",
    url: "/api/printers/k2/camera.jpg?ensureLight=1"
  });
  assert.equal(blocked.statusCode, 401, "ensureLight without the token is refused");
  assert.equal(calls.length, 1, "the light-ensuring capture was never attempted");

  const allowed = await app.inject({
    method: "GET",
    url: "/api/printers/k2/camera.jpg?ensureLight=1",
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  assert.equal(allowed.statusCode, 200);
  assert.deepEqual(calls[1], { id: "k2", ensureLight: true });

  await app.close();
});
