import assert from "node:assert/strict";
import { test } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

/*
 * The security hook with NO token configured (a separate file from
 * security.test.ts because env freezes process.env at first import): the
 * shared-secret guard is disabled, but the CSRF Origin check still refuses
 * mutating requests from foreign browser origins — CORS alone never stopped
 * the request from executing.
 */

delete process.env.ORCHESTRATOR_API_TOKEN;
delete process.env.CORS_ALLOW_ORIGINS;

async function buildApp(): Promise<FastifyInstance> {
  const { registerSecurity } = await import("./security");
  const app = Fastify();
  registerSecurity(app);
  app.post("/act", async () => ({ ok: true }));
  return app;
}

test("without a token the guard is off for non-browser callers", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "POST", url: "/act" });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("the CSRF Origin check applies even with the token guard off", async () => {
  const app = await buildApp();

  const foreign = await app.inject({
    method: "POST",
    url: "/act",
    headers: { origin: "http://evil.example" }
  });
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.json().error.code, "FORBIDDEN_ORIGIN");

  const sameHost = await app.inject({
    method: "POST",
    url: "/act",
    headers: { host: "farm.local:8090", origin: "http://farm.local:8090" }
  });
  assert.equal(sameHost.statusCode, 200);

  await app.close();
});
