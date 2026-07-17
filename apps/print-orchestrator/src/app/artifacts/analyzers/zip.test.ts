import assert from "node:assert/strict";
import { test } from "node:test";

import { makeZip } from "../testkit/fixtures";
import { bufferSource, SafeZip, ZipSafetyError, type ZipLimits } from "./zip";

const LIMITS: ZipLimits = {
  maxEntries: 100,
  maxEntryBytes: 1024,
  maxTotalBytes: 4096,
  maxRatio: 200
};

function open(buf: Buffer, overrides: Partial<ZipLimits> = {}): Promise<SafeZip> {
  return SafeZip.open(bufferSource(buf), { ...LIMITS, ...overrides });
}

test("reads a valid archive and inflates a stored + a deflated entry", async () => {
  const zip = await open(
    makeZip([
      { name: "a.txt", data: "hello" },
      { name: "b.txt", data: "world world world", method: "deflate" }
    ])
  );
  assert.equal(zip.entries.length, 2);
  assert.equal((await zip.read("a.txt", 1024)).toString(), "hello");
  assert.equal((await zip.read("b.txt", 1024)).toString(), "world world world");
});

test("rejects too many entries", async () => {
  const buf = makeZip([{ name: "a" }, { name: "b" }, { name: "c" }]);
  await assert.rejects(() => open(buf, { maxEntries: 2 }), (e: ZipSafetyError) => e.code === "zip_too_many_entries");
});

test("rejects path traversal, absolute paths and backslashes", async () => {
  for (const name of ["../evil.txt", "/etc/passwd", "a\\b.txt", "sub/../../x"]) {
    await assert.rejects(
      () => open(makeZip([{ name }])),
      (e: ZipSafetyError) => e instanceof ZipSafetyError,
      name
    );
  }
});

test("rejects a symlink entry (unix S_IFLNK in external attrs)", async () => {
  const buf = makeZip([{ name: "link", data: "/etc/passwd", unixMode: 0o120777 }]);
  await assert.rejects(() => open(buf), (e: ZipSafetyError) => e.code === "zip_symlink");
});

test("rejects duplicate paths", async () => {
  const buf = makeZip([{ name: "dup.txt", data: "1" }, { name: "dup.txt", data: "2" }]);
  await assert.rejects(() => open(buf), (e: ZipSafetyError) => e.code === "zip_duplicate");
});

test("rejects an over-declared uncompressed entry size (before inflation)", async () => {
  // Data is tiny, but the central directory *claims* it is huge — the bomb
  // signal must be caught from the declaration, not by inflating.
  const buf = makeZip([{ name: "big", data: "x", uncompressedSizeOverride: 10_000_000 }]);
  await assert.rejects(() => open(buf), (e: ZipSafetyError) => e.code === "zip_entry_too_large");
});

test("rejects an excessive total uncompressed size across entries", async () => {
  const buf = makeZip([
    { name: "a", data: "x", uncompressedSizeOverride: 900 },
    { name: "b", data: "y", uncompressedSizeOverride: 900 }
  ]);
  await assert.rejects(
    () => open(buf, { maxEntryBytes: 1000, maxTotalBytes: 1000 }),
    (e: ZipSafetyError) => e.code === "zip_total_too_large"
  );
});

test("rejects a suspicious compression ratio (zip bomb)", async () => {
  // 200 KiB of zeros deflates to a few hundred bytes → ratio far above the cap.
  const buf = makeZip([{ name: "bomb", data: Buffer.alloc(200 * 1024), method: "deflate" }]);
  await assert.rejects(
    () => open(buf, { maxEntryBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024, maxRatio: 50 }),
    (e: ZipSafetyError) => e.code === "zip_ratio"
  );
});

test("rejects a non-ZIP buffer", async () => {
  await assert.rejects(
    () => open(Buffer.from("this is definitely not a zip file at all")),
    (e: ZipSafetyError) => e.code === "zip_not_zip"
  );
});

test("read() caps inflation output at the requested max", async () => {
  const zip = await open(makeZip([{ name: "big.txt", data: "abcdefghij" }]));
  await assert.rejects(
    () => zip.read("big.txt", 3),
    (e: ZipSafetyError) => e.code === "zip_entry_too_large"
  );
});
