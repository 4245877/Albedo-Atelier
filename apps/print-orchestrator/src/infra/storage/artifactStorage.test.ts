import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";

import { PayloadTooLargeError, ValidationError } from "../../core/errors";
import { ArtifactStorage, keyFor } from "./artifactStorage";

let dir: string;
let storage: ArtifactStorage;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-blob-"));
  storage = new ArtifactStorage({ root: path.join(dir, "artifacts") });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function sha(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
function tmpFiles(): string[] {
  return fs.existsSync(storage.tmpDir) ? fs.readdirSync(storage.tmpDir) : [];
}

test("stage hashes and sizes while streaming; commit content-addresses atomically", async () => {
  const data = Buffer.from("a printable model");
  const staged = await storage.stage(Readable.from([data]));
  assert.equal(staged.sha256, sha(data));
  assert.equal(staged.sizeBytes, data.length);

  const committed = await storage.commit(staged);
  assert.equal(committed.key, keyFor(sha(data)));
  assert.equal(committed.deduplicated, false);
  assert.ok(await storage.exists(committed.key));
  // The committed file holds exactly the bytes; the temp is gone.
  assert.deepEqual(fs.readFileSync(storage.resolvePath(committed.key)), data);
  assert.deepEqual(tmpFiles(), []);
});

test("identical content is stored once and reported as pre-existing", async () => {
  const data = Buffer.from("dedupe me");
  const first = await storage.commit(await storage.stage(Readable.from([data])));
  assert.equal(first.deduplicated, false);

  const second = await storage.commit(await storage.stage(Readable.from([data])));
  assert.equal(second.deduplicated, true);
  assert.equal(second.key, first.key);

  // Exactly one physical blob under the hash directory.
  const hashDir = path.dirname(storage.resolvePath(first.key));
  assert.deepEqual(fs.readdirSync(hashDir), [sha(data)]);
});

test("exceeding maxBytes rejects and leaves no temp file", async () => {
  await assert.rejects(
    () => storage.stage(Readable.from([Buffer.alloc(2048)]), { maxBytes: 1024 }),
    PayloadTooLargeError
  );
  assert.deepEqual(tmpFiles(), []);
});

test("a truncated transport flag rejects and cleans the temp file", async () => {
  await assert.rejects(
    () => storage.stage(Readable.from([Buffer.from("partial")]), { alreadyTruncated: () => true }),
    PayloadTooLargeError
  );
  assert.deepEqual(tmpFiles(), []);
});

test("a source read error removes the temp file (aborted upload)", async () => {
  const source = new Readable({
    read() {
      this.push(Buffer.from("some"));
      this.destroy(new Error("connection reset"));
    }
  });
  await assert.rejects(() => storage.stage(source), /connection reset/);
  assert.deepEqual(tmpFiles(), []);
});

test("resolvePath refuses a malformed / traversing storage key", () => {
  assert.throws(() => storage.resolvePath("../../etc/passwd"), ValidationError);
  assert.throws(() => storage.resolvePath("sha256/zz/not-hex"), ValidationError);
});

test("remove deletes a committed blob (orphan cleanup)", async () => {
  const committed = await storage.commit(await storage.stage(Readable.from([Buffer.from("x")])));
  assert.ok(await storage.exists(committed.key));
  await storage.remove(committed.key);
  assert.equal(await storage.exists(committed.key), false);
});
