import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

import { FarmStore } from "../../app/farmStore";
import { registerPrinterRoutes } from "../printers/routes";
import { registerQueueRoutes } from "../queue/routes";
import { registerDashboardRoutes } from "./routes";

/*
 * The read-only dashboard HTTP surface. Uses an isolated, never-started
 * FarmStore (no printers config, no polling, no device traffic): every route
 * must still answer with an honest empty farm. Also pins the canonical-route
 * decision: the historical spec aliases (`/api/events/recent`,
 * `/api/night-print`, `/api/jobs/active`) duplicated `/api/events`,
 * `/api/queue/night` and `/api/printers/active` 1:1 and were removed.
 */

let dir: string;
let app: FastifyInstance;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-dash-routes-"));
  const store = new FarmStore(path.join(dir, "state.json"), path.join(dir, "snapshots"));
  app = Fastify();
  await app.register(registerDashboardRoutes, { prefix: "/api", store });
  await app.register(registerPrinterRoutes, { prefix: "/api/printers", store });
  await app.register(registerQueueRoutes, { prefix: "/api/queue" });
});

afterEach(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("GET /api/dashboard returns the whole board with the current contract", async () => {
  const res = await app.inject({ method: "GET", url: "/api/dashboard" });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  // Service status carries only real signals: no tautological `backend`
  // (the payload being received already proves the backend), no unused
  // `startedHoursAgo`.
  assert.deepEqual(Object.keys(body.service).sort(), ["status", "version"]);
  assert.equal(body.service.status, "ok");

  // The night window is exported in machine-readable form for the frontend
  // theme; with the default NIGHT_PRINT_WINDOW that is 21:30 → 07:30.
  assert.equal(body.night.window, "21:30 – 07:30");
  assert.equal(body.night.windowStart, "21:30");
  assert.equal(body.night.windowEnd, "07:30");

  // The printer status "maintenance" is unreachable and was removed — the
  // performance section no longer reports its always-zero counter.
  assert.ok(!("maintenance" in body.perf));
  assert.deepEqual(body.printers, []);
  assert.deepEqual(body.queue, []);
});

test("canonical per-section routes answer: events, night, active printers", async () => {
  const events = await app.inject({ method: "GET", url: "/api/events" });
  assert.equal(events.statusCode, 200);
  assert.ok(Array.isArray(events.json()));

  const night = await app.inject({ method: "GET", url: "/api/queue/night" });
  assert.equal(night.statusCode, 200);
  assert.equal(night.json().windowStart, "21:30");

  const active = await app.inject({ method: "GET", url: "/api/printers/active" });
  assert.equal(active.statusCode, 200);
  assert.deepEqual(active.json(), []);
});

test("the removed spec aliases are gone (404), not silently re-added", async () => {
  for (const url of ["/api/events/recent", "/api/night-print", "/api/jobs/active"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 404, `${url} must not exist`);
  }
});
