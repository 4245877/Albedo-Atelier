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

// ── ZIP64 ────────────────────────────────────────────────────────────────────
//
// Refusing ZIP64 was the bug behind "ZIP64-архивы не поддерживаются" on ordinary
// 150 KB slicer files: miniz — inside PrusaSlicer / OrcaSlicer / BambuStudio —
// writes the ZIP64 records regardless of size. These lock the support in.

test("ZIP64 (miniz layout: sentinels + ZIP64 EOCD + locator) reads like any archive", async () => {
  const zip = await open(
    makeZip(
      [
        { name: "a.txt", data: "hello" },
        { name: "b.txt", data: "world world world", method: "deflate" }
      ],
      { zip64: "full" }
    )
  );
  assert.equal(zip.entries.length, 2);
  // The 64-bit values from the extra field replaced every 0xFFFFFFFF sentinel.
  assert.equal(zip.entries[0].uncompressedSize, 5);
  assert.equal(zip.entries[0].localHeaderOffset, 0);
  assert.equal((await zip.read("a.txt", 1024)).toString(), "hello");
  assert.equal((await zip.read("b.txt", 1024)).toString(), "world world world");
});

test("a ZIP64 end-of-central-directory alone (32-bit entries) is read too", async () => {
  const zip = await open(makeZip([{ name: "a.txt", data: "hello" }], { zip64: "eocd" }));
  assert.equal((await zip.read("a.txt", 1024)).toString(), "hello");
});

test("ZIP64 does not exempt an archive from the bomb limits", async () => {
  const buf = makeZip([{ name: "big", data: "x", uncompressedSizeOverride: 10_000_000 }], {
    zip64: "full"
  });
  await assert.rejects(() => open(buf), (e: ZipSafetyError) => e.code === "zip_entry_too_large");
});

test("ZIP64 sentinels with no ZIP64 record read as corruption, not as unsupported", async () => {
  const buf = makeZip([{ name: "a.txt", data: "hello" }], {
    zip64: "full",
    omitZip64Record: true
  });
  await assert.rejects(() => open(buf), (e: ZipSafetyError) => e.code === "zip_corrupt");
});

// ── Tail scanning ────────────────────────────────────────────────────────────

test("an archive comment does not hide the end-of-central-directory record", async () => {
  const zip = await open(makeZip([{ name: "a.txt", data: "hello" }], { comment: "made by fixture" }));
  assert.equal((await zip.read("a.txt", 1024)).toString(), "hello");
});

test("EOCD-looking bytes inside stored data do not derail the scan", async () => {
  // "PK\x05\x06" + 18 bytes of plausible-looking record, stored verbatim.
  const decoy = Buffer.concat([Buffer.from("PK\x05\x06", "latin1"), Buffer.alloc(18)]);
  const zip = await open(makeZip([{ name: "decoy.bin", data: decoy }]));
  assert.equal(zip.entries.length, 1);
  assert.deepEqual(await zip.read("decoy.bin", 1024), decoy);
});

test("resolve() matches OPC part names case-insensitively and returns the real spelling", async () => {
  const zip = await open(makeZip([{ name: "3D/3Dmodel.model", data: "<model/>" }]));
  assert.equal(zip.resolve("3d/3dmodel.model"), "3D/3Dmodel.model");
  assert.equal(zip.resolve("3D/missing.model"), null);
});
