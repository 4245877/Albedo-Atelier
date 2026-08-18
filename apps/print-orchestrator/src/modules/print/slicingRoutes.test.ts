import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

/*
 * The `/api/print/slicing` HTTP surface end-to-end through the real farmStore
 * singleton and the REAL vendored catalog, with no OrcaSlicer runtime configured
 * (ORCA_SLICER_CMD unset) — so it also proves the honest "runtime unavailable"
 * reporting and the approval blocker guard over HTTP. env freezes on first import,
 * so process.env is set here before anything that reads it is imported.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "slicing-routes-"));
const TOKEN = "slicing-test-token";
process.env.ORCHESTRATOR_API_TOKEN = TOKEN;
process.env.STATE_FILE_PATH = path.join(TMP, "state.json");
process.env.PRINTERS_CONFIG_PATH = path.join(TMP, "no-printers.json");
// Leave ORCA_SLICER_CMD unset → no runtime.

let app: FastifyInstance;

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

  // Deterministically import the catalog (no farmStore.start in this test).
  const imp = await app.inject({
    method: "POST",
    url: "/api/print/slicing/presets/import",
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  assert.equal(imp.statusCode, 200);
});

after(async () => {
  await app.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("POST /slicing/presets/import imports the real catalog (20 active, 1 quarantined)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/print/slicing/presets/import",
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  assert.equal(res.statusCode, 200);
  const { result } = res.json();
  // The vendor/ closure resolves every Bambu A1 chain and the whole Creality K2 one.
  assert.equal(result.counts.active, 20);
  // One preset stays quarantined, and not for a missing dependency: the operator's
  // `Creality K2 PETG 0.4 FAST` export declares a 0.4 mm nozzle on a "0.2"
  // printer_variant. That contradiction is the profile's own, so no installed parent
  // can clear it.
  assert.equal(result.counts.quarantined, 1);
  assert.equal(result.counts.invalid, 0);
  assert.equal(result.sourceIntegrity.ok, true);
  assert.deepEqual(result.missingParents, []);
});

test("GET /slicing/runtime honestly reports no runtime + the profile counts", async () => {
  const res = await app.inject({ method: "GET", url: "/api/print/slicing/runtime" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.runtime.available, false);
  assert.ok(body.runtime.error, "expected an honest diagnostic");
  assert.equal(body.profileCounts.active, 20);
  assert.equal(body.profileCounts.quarantined, 1);
  assert.ok(Array.isArray(body.coverage));
  assert.deepEqual(body.missingParents, []);
});

test("GET /slicing/profiles lists all 21 revisions; ?type filters", async () => {
  const all = await app.inject({ method: "GET", url: "/api/print/slicing/profiles" });
  assert.equal(all.json().profiles.length, 21);
  const filament = await app.inject({ method: "GET", url: "/api/print/slicing/profiles?type=filament" });
  const names = filament.json().profiles.map((p: { name: string }) => p.name);
  assert.ok(names.includes("Creality"));
});

test("the Bambu A1 0.4 machine profile is served active, with its resolved BBL chain", async () => {
  const res = await app.inject({ method: "GET", url: "/api/print/slicing/profiles?type=machine" });
  const profiles = res.json().profiles as Array<{
    name: string;
    status: string;
    resolvedJson: string | null;
    metadata: { vendor?: string; inheritanceChain?: string[] };
  }>;
  const a1 = profiles.find((p) => p.name === "Bambu Lab A1 0.4 PETG");
  assert.ok(a1, "expected the Bambu Lab A1 0.4 PETG machine profile");
  assert.equal(a1.status, "active");
  assert.equal(a1.metadata.vendor, "BBL");
  assert.deepEqual(a1.metadata.inheritanceChain, [
    "fdm_machine_common",
    "fdm_bbl_3dp_001_common",
    "Bambu Lab A1 0.4 nozzle",
    "Bambu Lab A1 0.4 PETG"
  ]);
  const resolved = JSON.parse(a1.resolvedJson ?? "{}");
  assert.deepEqual(resolved.nozzle_diameter, ["0.4"]);
  assert.equal(resolved.printer_model, "Bambu Lab A1");
});

test("creating a set with a quarantined member is blocked, and approval is refused (409)", async () => {
  const profiles = (await app.inject({ method: "GET", url: "/api/print/slicing/profiles" })).json().profiles as Array<{
    id: string;
    type: string;
    name: string;
    status: string;
  }>;
  // The catalog's only quarantined revision is a machine, so that is the offending
  // member here; the other two are active. One bad member is all the rule needs.
  const machine = profiles.find((p) => p.type === "machine" && p.status === "quarantined");
  const process = profiles.find((p) => p.type === "process" && p.status === "active");
  const filament = profiles.find((p) => p.type === "filament" && p.status === "active");
  assert.ok(machine && process && filament);

  const create = await app.inject({
    method: "POST",
    url: "/api/print/slicing/profile-sets",
    headers: { authorization: `Bearer ${TOKEN}` },
    // A class target (not a concrete printerId) — this test's empty farm has no
    // printers, and a set's block here comes from its quarantined MEMBER, not its
    // target. (A concrete printerId is now validated to exist; see the profile tests.)
    payload: { name: "blocked set", machine: machine.id, process: process.id, filament: filament.id, printerClass: "k2" }
  });
  assert.equal(create.statusCode, 200);
  const setId = create.json().set.id;
  assert.equal(create.json().set.validation, "blocked");

  const approve = await app.inject({
    method: "POST",
    url: `/api/print/slicing/profile-sets/${setId}/approve`,
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  assert.equal(approve.statusCode, 409);
});

test("mutations require the API token and reject a foreign Origin (CSRF)", async () => {
  const noToken = await app.inject({ method: "POST", url: "/api/print/slicing/presets/import" });
  assert.equal(noToken.statusCode, 401);

  const foreign = await app.inject({
    method: "POST",
    url: "/api/print/slicing/slice",
    headers: { authorization: `Bearer ${TOKEN}`, origin: "http://evil.example", host: "farm.local" },
    payload: { artifactId: "x", profileSetId: "y" }
  });
  assert.equal(foreign.statusCode, 403);
});

test("slicing endpoints never expose the legacy queue (it stays empty)", async () => {
  const q = await app.inject({ method: "GET", url: "/api/print/queue" });
  assert.deepEqual(q.json().queue, []);
});
