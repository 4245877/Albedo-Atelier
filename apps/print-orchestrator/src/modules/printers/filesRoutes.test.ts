import assert from "node:assert/strict";
import { test } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

import { AppError, JobError, NotFoundError, PrinterOfflineError } from "../../core/errors";
import { normalizeStartablePath } from "../../infra/printers/files";
import type { PrinterFilesListing } from "../../infra/printers/files";
import { registerPrinterRoutes, type PrinterCommands } from "./routes";

/*
 * HTTP mapping of the on-device file browser and remote start:
 * GET /api/printers/:id/files and POST /api/printers/:id/print. The fake store
 * reproduces the real FarmStore contract (path validation via the shared
 * normalizer, then delegation to the shared startPrint) and records the calls,
 * so the tests pin both the wire format and the delegation.
 */

interface Recorded {
  listCalls: Array<{ id: string; path: string }>;
  startCalls: Array<{ id: string; file: string }>;
}

function makeStore(behaviour: {
  listing?: PrinterFilesListing;
  startError?: Error;
  listError?: Error;
}): { store: PrinterCommands; calls: Recorded } {
  const calls: Recorded = { listCalls: [], startCalls: [] };
  const store = {
    async listPrinterFiles(id: string, path: string) {
      if (id !== "k2") throw new NotFoundError(`Printer "${id}"`);
      calls.listCalls.push({ id, path });
      if (behaviour.listError) throw behaviour.listError;
      return behaviour.listing ?? { path, entries: [] };
    },
    // Mirrors FarmStore.startPrinterFile: normalize first, then hand the safe
    // path to the shared startPrint (represented here by the recorded call).
    async startPrinterFile(id: string, file: string) {
      if (id !== "k2") throw new NotFoundError(`Printer "${id}"`);
      const normalized = normalizeStartablePath(file);
      calls.startCalls.push({ id, file: normalized });
      if (behaviour.startError) throw behaviour.startError;
      return { id, status: "printing" };
    }
  } as unknown as PrinterCommands;
  return { store, calls };
}

async function buildTestApp(store: PrinterCommands): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return;
    }
    reply.code(500).send({ error: { code: "INTERNAL", message: "Internal Server Error" } });
  });
  await app.register(registerPrinterRoutes, { prefix: "/api/printers", reads: {} as never, commands: store });
  return app;
}

test("GET /:id/files lists the requested directory", async () => {
  const listing: PrinterFilesListing = {
    path: "orders",
    entries: [
      { name: "june", path: "orders/june", type: "directory", printable: false },
      { name: "lid.gcode", path: "orders/lid.gcode", type: "file", printable: true, size: 42 }
    ]
  };
  const { store, calls } = makeStore({ listing });
  const app = await buildTestApp(store);

  const res = await app.inject({ method: "GET", url: "/api/printers/k2/files?path=orders" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, ...listing });
  assert.deepEqual(calls.listCalls, [{ id: "k2", path: "orders" }]);
  await app.close();
});

test("GET /:id/files defaults to the root and 404s for unknown printers", async () => {
  const { store, calls } = makeStore({});
  const app = await buildTestApp(store);

  const root = await app.inject({ method: "GET", url: "/api/printers/k2/files" });
  assert.equal(root.statusCode, 200);
  assert.deepEqual(calls.listCalls, [{ id: "k2", path: "" }]);

  const ghost = await app.inject({ method: "GET", url: "/api/printers/ghost/files" });
  assert.equal(ghost.statusCode, 404);
  await app.close();
});

test("GET /:id/files surfaces unsupported/offline as the store's domain errors", async () => {
  const unsupported = await buildTestApp(
    makeStore({ listError: new JobError("Просмотр файлов поддерживается только для Moonraker") }).store
  );
  const resUnsupported = await unsupported.inject({ method: "GET", url: "/api/printers/k2/files" });
  assert.equal(resUnsupported.statusCode, 409);
  assert.equal(resUnsupported.json().error.code, "JOB_ERROR");
  await unsupported.close();

  const offline = await buildTestApp(makeStore({ listError: new PrinterOfflineError("k2") }).store);
  const resOffline = await offline.inject({ method: "GET", url: "/api/printers/k2/files" });
  assert.equal(resOffline.statusCode, 409);
  assert.equal(resOffline.json().error.code, "PRINTER_OFFLINE");
  await offline.close();
});

test("POST /:id/print validates the body before touching the store", async () => {
  const { store, calls } = makeStore({});
  const app = await buildTestApp(store);

  for (const body of [undefined, {}, { file: "" }, { file: "   " }, { file: 42 }]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/printers/k2/print",
      ...(body === undefined ? {} : { payload: body })
    });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.json().error.code, "VALIDATION");
  }
  assert.deepEqual(calls.startCalls, []);
  await app.close();
});

test("POST /:id/print rejects unsafe paths with 400 and never reaches startPrint", async () => {
  const { store, calls } = makeStore({});
  const app = await buildTestApp(store);

  for (const file of ["../secret.gcode", "/etc/passwd", "dir/../a.gcode", "folder", "notes.txt"]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/printers/k2/print",
      payload: { file }
    });
    assert.equal(res.statusCode, 400, file);
    assert.equal(res.json().error.code, "VALIDATION", file);
  }
  assert.deepEqual(calls.startCalls, []);
  await app.close();
});

test("POST /:id/print hands the normalized file to the shared startPrint and returns the view", async () => {
  const { store, calls } = makeStore({});
  const app = await buildTestApp(store);

  const res = await app.inject({
    method: "POST",
    url: "/api/printers/k2/print",
    payload: { file: "  orders/lid.gcode  " }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, printer: { id: "k2", status: "printing" } });
  assert.deepEqual(calls.startCalls, [{ id: "k2", file: "orders/lid.gcode" }]);
  await app.close();
});

test("POST /:id/print maps busy/offline re-checks from startPrint to 409", async () => {
  const busyApp = await buildTestApp(
    makeStore({ startError: new JobError("«Creality K2» уже занят печатью — дождитесь завершения") }).store
  );
  const busy = await busyApp.inject({
    method: "POST",
    url: "/api/printers/k2/print",
    payload: { file: "a.gcode" }
  });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json().error.code, "JOB_ERROR");
  await busyApp.close();

  const offlineApp = await buildTestApp(makeStore({ startError: new PrinterOfflineError("k2") }).store);
  const offline = await offlineApp.inject({
    method: "POST",
    url: "/api/printers/k2/print",
    payload: { file: "a.gcode" }
  });
  assert.equal(offline.statusCode, 409);
  assert.equal(offline.json().error.code, "PRINTER_OFFLINE");
  await offlineApp.close();
});
