import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import type { CameraFrame } from "../printers/camera";
import { SnapshotStore } from "./snapshotStore";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-snap-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function frame(bytes: number[], mime = "image/jpeg"): CameraFrame {
  return { data: Buffer.from(bytes), mime };
}

test("save writes the image file and returns durable metadata", async () => {
  const store = new SnapshotStore(dir);
  const meta = await store.save("k2", frame([1, 2, 3, 4]), { status: "printing" });

  assert.equal(meta.printerId, "k2");
  assert.equal(meta.mime, "image/jpeg");
  assert.equal(meta.bytes, 4);
  assert.equal(meta.status, "printing");
  assert.equal(meta.url, `/api/printers/k2/snapshots/${encodeURIComponent(meta.id)}`);
  assert.ok(/^\d+-[0-9a-f]{8}$/.test(meta.id), "id is <timestamp>-<hex>");

  // The path is relative to the store dir, laid out as <printer>/<day>/<id>.jpg.
  const day = meta.capturedAt.slice(0, 10);
  assert.equal(meta.path, `k2/${day}/${meta.id}.jpg`);

  const onDisk = await fsp.readFile(path.join(dir, meta.path));
  assert.deepEqual([...onDisk], [1, 2, 3, 4], "the saved bytes are the frame bytes");
});

test("save is atomic — no leftover .tmp files and read() returns the image", async () => {
  const store = new SnapshotStore(dir);
  const meta = await store.save("k2", frame([9, 9, 9]));

  const dayDir = path.join(dir, "k2", meta.capturedAt.slice(0, 10));
  const entries = await fsp.readdir(dayDir);
  assert.deepEqual(entries, [`${meta.id}.jpg`], "only the final file exists, no temp");

  const bytes = await store.read(meta);
  assert.deepEqual([...bytes], [9, 9, 9]);
});

test("the file extension and stored mime follow the frame's content type", async () => {
  const store = new SnapshotStore(dir);
  const png = await store.save("k2", frame([1], "image/png"));
  assert.equal(png.mime, "image/png");
  assert.ok(png.path.endsWith(".png"));

  // Unknown/odd content types fall back to a .jpg file and image/jpeg mime.
  const odd = await store.save("k2", frame([1], "application/octet-stream"));
  assert.ok(odd.path.endsWith(".jpg"));

  // A parametrised jpeg content type is normalised.
  const jpeg = await store.save("k2", frame([1], "image/jpeg; charset=binary"));
  assert.equal(jpeg.mime, "image/jpeg");
});

test("list is newest-first and latest/get resolve the right records", async () => {
  const store = new SnapshotStore(dir);
  const a = await store.save("k2", frame([1]), { now: new Date("2026-07-01T10:00:00Z") });
  const b = await store.save("k2", frame([2]), { now: new Date("2026-07-02T10:00:00Z") });
  await store.save("a1", frame([3]), { now: new Date("2026-07-03T10:00:00Z") });

  const list = store.list("k2");
  assert.deepEqual(list.map((m) => m.id), [b.id, a.id], "newest first, scoped to the printer");
  assert.equal(store.latest("k2")?.id, b.id);
  assert.equal(store.get("k2", a.id)?.id, a.id);
  assert.equal(store.get("k2", "nope"), undefined);
  // A snapshot id is scoped to its printer.
  assert.equal(store.get("a1", a.id), undefined);
});

test("retention keeps only the newest N per printer and deletes the pruned files", async () => {
  const store = new SnapshotStore(dir, [], () => {}, { retainPerPrinter: 2 });
  const metas = [];
  for (let i = 0; i < 4; i += 1) {
    metas.push(await store.save("k2", frame([i]), { now: new Date(2026, 6, 1 + i) }));
  }

  const kept = store.list("k2");
  assert.equal(kept.length, 2, "only two survive");
  assert.deepEqual(kept.map((m) => m.id), [metas[3].id, metas[2].id]);

  // The two oldest files are gone from disk; the two newest remain.
  assert.equal(fs.existsSync(path.join(dir, metas[0].path)), false);
  assert.equal(fs.existsSync(path.join(dir, metas[1].path)), false);
  assert.equal(fs.existsSync(path.join(dir, metas[2].path)), true);
  assert.equal(fs.existsSync(path.join(dir, metas[3].path)), true);
});

test("metadata survives a restart via serialize()/constructor rehydration", async () => {
  const first = new SnapshotStore(dir);
  const meta = await first.save("k2", frame([1, 2]));

  const restarted = new SnapshotStore(dir, first.serialize());
  assert.equal(restarted.latest("k2")?.id, meta.id);
  const bytes = await restarted.read(restarted.latest("k2")!);
  assert.deepEqual([...bytes], [1, 2]);
});
