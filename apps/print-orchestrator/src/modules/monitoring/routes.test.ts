import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

import { FarmStore } from "../../app/farmStore";
import { registerMonitoringRoutes } from "./routes";

/*
 * The monitoring-lease HTTP surface over an isolated, never-started FarmStore.
 * A fake clock pins the expiry arithmetic; the CSRF/token protection itself is
 * covered by src/http/security.test.ts (this route is an ordinary mutating
 * POST behind the same global hook).
 */

const RealDate = Date;
let fakeNow = RealDate.UTC(2026, 6, 2, 12, 0, 0);

class FakeDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof Date> | []) {
    if (args.length === 0) {
      super(fakeNow);
    } else {
      super(...args);
    }
  }
  static now(): number {
    return fakeNow;
  }
}

let dir: string;
let app: FastifyInstance;

beforeEach(async () => {
  // @ts-expect-error install controllable clock
  globalThis.Date = FakeDate;
  fakeNow = RealDate.UTC(2026, 6, 2, 12, 0, 0);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-monitoring-routes-"));
  const store = new FarmStore(path.join(dir, "state.json"), path.join(dir, "snapshots"));
  app = Fastify();
  await app.register(registerMonitoringRoutes, { prefix: "/api/monitoring", store });
});

afterEach(async () => {
  globalThis.Date = RealDate;
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("POST /api/monitoring/lease grants a 60–90 s lease and reports its expiry", async () => {
  const res = await app.inject({ method: "POST", url: "/api/monitoring/lease" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.ok(body.ttlSeconds >= 60 && body.ttlSeconds <= 90, `ttl ${body.ttlSeconds}s in bounds`);
  assert.equal(
    new RealDate(body.expiresAt).getTime(),
    fakeNow + body.ttlSeconds * 1000,
    "expiresAt = now + TTL"
  );
});

test("repeated renewals are idempotent extensions of the same lease", async () => {
  const first = (await app.inject({ method: "POST", url: "/api/monitoring/lease" })).json();
  fakeNow += 30 * 1000;
  const second = (await app.inject({ method: "POST", url: "/api/monitoring/lease" })).json();

  assert.equal(second.ok, true);
  assert.equal(
    new RealDate(second.expiresAt).getTime() - new RealDate(first.expiresAt).getTime(),
    30 * 1000,
    "the second call moved the expiry forward by the elapsed time"
  );
});
