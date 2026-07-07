import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

import { AppError, NotFoundError } from "../../core/errors";
import { SnapshotStore } from "../../infra/store/snapshotStore";
import { registerPrinterRoutes, type PrinterRoutesStore } from "./routes";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-routes-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A tiny farm facade backed by a real {@link SnapshotStore}, exposing only the
 * methods the snapshot routes call. It reproduces the real FarmStore's
 * config-guard / not-found behaviour so the HTTP mapping (paths, status codes,
 * content types) is exercised end-to-end without a live farm or real printers.
 */
function makeStore(snapshots: SnapshotStore, knownPrinter: string): PrinterRoutesStore {
  function assertKnown(id: string): void {
    if (id !== knownPrinter) throw new NotFoundError(`Printer "${id}"`);
  }
  return {
    async snapshotPrinter(id: string) {
      assertKnown(id);
      const meta = await snapshots.save(id, { data: Buffer.from([1, 2, 3]), mime: "image/jpeg" });
      return { printer: { id, latestSnapshotUrl: meta.url }, snapshot: meta };
    },
    listSnapshots(id: string) {
      assertKnown(id);
      return snapshots.list(id);
    },
    latestSnapshot(id: string) {
      assertKnown(id);
      const meta = snapshots.latest(id);
      if (!meta) throw new NotFoundError(`Snapshot for printer "${id}"`);
      return meta;
    },
    async readSnapshot(id: string, snapshotId: string) {
      assertKnown(id);
      const meta = snapshots.get(id, snapshotId);
      if (!meta) throw new NotFoundError(`Snapshot "${snapshotId}"`);
      return { meta, data: await snapshots.read(meta) };
    }
  } as unknown as PrinterRoutesStore;
}

async function buildTestApp(store: PrinterRoutesStore): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return;
    }
    reply.code(500).send({ error: { code: "INTERNAL", message: "Internal Server Error" } });
  });
  await app.register(registerPrinterRoutes, { prefix: "/api/printers", store });
  return app;
}

test("POST /:id/snapshot saves a snapshot and returns its metadata", async () => {
  const app = await buildTestApp(makeStore(new SnapshotStore(dir), "k2"));
  const res = await app.inject({ method: "POST", url: "/api/printers/k2/snapshot" });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.ok(body.snapshot.id);
  assert.equal(body.snapshot.url, `/api/printers/k2/snapshots/${encodeURIComponent(body.snapshot.id)}`);
  assert.ok(body.snapshot.capturedAt);
  await app.close();
});

test("the snapshot GET routes list, resolve latest, and serve the image", async () => {
  const snapshots = new SnapshotStore(dir);
  const app = await buildTestApp(makeStore(snapshots, "k2"));

  const created = (await app.inject({ method: "POST", url: "/api/printers/k2/snapshot" })).json();

  const list = await app.inject({ method: "GET", url: "/api/printers/k2/snapshots" });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 1);
  assert.equal(list.json()[0].id, created.snapshot.id);

  const latest = await app.inject({ method: "GET", url: "/api/printers/k2/snapshots/latest" });
  assert.equal(latest.statusCode, 200);
  assert.equal(latest.json().id, created.snapshot.id);

  const image = await app.inject({
    method: "GET",
    url: `/api/printers/k2/snapshots/${created.snapshot.id}`
  });
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers["content-type"], "image/jpeg");
  assert.deepEqual([...image.rawPayload], [1, 2, 3], "the raw JPEG bytes are served");

  await app.close();
});

test("latest is 404 before any snapshot exists; unknown ids are 404", async () => {
  const app = await buildTestApp(makeStore(new SnapshotStore(dir), "k2"));

  const latest = await app.inject({ method: "GET", url: "/api/printers/k2/snapshots/latest" });
  assert.equal(latest.statusCode, 404);

  const missing = await app.inject({ method: "GET", url: "/api/printers/k2/snapshots/nope" });
  assert.equal(missing.statusCode, 404);

  const unknownPrinter = await app.inject({ method: "GET", url: "/api/printers/ghost/snapshots" });
  assert.equal(unknownPrinter.statusCode, 404);

  await app.close();
});
