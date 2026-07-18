import assert from "node:assert/strict";
import { test } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

/*
 * The security hook with NO token configured (a separate file from
 * security.test.ts because env freezes process.env at first import). The
 * cutover behaviour is FAIL-CLOSED: absent auth configuration REFUSES every
 * mutation (503 AUTH_NOT_CONFIGURED) — "not configured" no longer means
 * "everyone is authorized". Reads stay open; the explicit
 * ALLOW_UNAUTHENTICATED_MUTATIONS=1 opt-in is exercised in security.test.ts's
 * sibling because env freezes on first import.
 */

delete process.env.ORCHESTRATOR_API_TOKEN;
delete process.env.CORS_ALLOW_ORIGINS;
delete process.env.ALLOW_UNAUTHENTICATED_MUTATIONS;

async function buildApp(): Promise<FastifyInstance> {
  const { registerSecurity } = await import("./security");
  const app = Fastify();
  registerSecurity(app);
  app.post("/act", async () => ({ ok: true }));
  app.get("/read", async () => ({ ok: true }));
  return app;
}

test("without a token every mutation is refused fail-closed (503), reads stay open", async () => {
  const app = await buildApp();

  const res = await app.inject({ method: "POST", url: "/act" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, "AUTH_NOT_CONFIGURED");

  const read = await app.inject({ method: "GET", url: "/read" });
  assert.equal(read.statusCode, 200, "reads are not blocked by the missing token");

  await app.close();
});

test("the CSRF Origin check fires before the auth refusal", async () => {
  const app = await buildApp();

  const foreign = await app.inject({
    method: "POST",
    url: "/act",
    headers: { origin: "http://evil.example" }
  });
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.json().error.code, "FORBIDDEN_ORIGIN");

  await app.close();
});

test("a DNS hostname outside the allowlist is refused for every method (anti-rebinding)", async () => {
  const app = await buildApp();

  // The rebinding scenario: the victim's browser resolves attacker.example to
  // the farm's IP and sends the request with the attacker's name in Host.
  const read = await app.inject({
    method: "GET",
    url: "/read",
    headers: { host: "attacker.example" }
  });
  assert.equal(read.statusCode, 403);
  assert.equal(read.json().error.code, "FORBIDDEN_HOST");

  // Literal IPs and localhost keep working without configuration.
  for (const host of ["127.0.0.1:3100", "192.168.0.139:8090", "localhost:8090"]) {
    const ok = await app.inject({ method: "GET", url: "/read", headers: { host } });
    assert.equal(ok.statusCode, 200, host);
  }

  await app.close();
});

test("Sec-Fetch-Site: cross-site refuses a mutation whatever Origin claims", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/act",
    headers: { host: "farm.local:8090", "sec-fetch-site": "cross-site" }
  });
  // farm.local is also not allowlisted → refused as host; use an IP to isolate
  // the Sec-Fetch-Site path.
  const viaIp = await app.inject({
    method: "POST",
    url: "/act",
    headers: { host: "192.168.0.10:8090", "sec-fetch-site": "cross-site" }
  });
  assert.equal(viaIp.statusCode, 403);
  assert.equal(viaIp.json().error.code, "FORBIDDEN_ORIGIN");
  void res;
  await app.close();
});

test("clickjacking/security headers are stamped on every response", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/read" });
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.equal(res.headers["content-security-policy"], "frame-ancestors 'none'");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  await app.close();
});
