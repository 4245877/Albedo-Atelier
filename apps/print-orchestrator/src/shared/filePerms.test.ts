import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { warnIfPermsTooOpen } from "./filePerms";
import type { StoreLogger } from "./logger";

/*
 * Real temp files with real modes. The permission-bit assertions are POSIX-only
 * (a system without group/world bits can't express 0644), so they skip
 * elsewhere; the missing-path / empty-path behaviour is checked everywhere.
 * Root-safe: the check reads the file's mode bits, not whether THIS uid can read
 * it, so chmod 0600 is "not flagged" even when the test runs as root.
 */
const posix = process.platform !== "win32";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fileperms-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function recorder() {
  const warnings: Array<{ obj: unknown; msg?: string }> = [];
  const logger: StoreLogger = { warn: (obj, msg) => warnings.push({ obj, msg }) };
  return { logger, warnings };
}

function writeFileMode(name: string, mode: number): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, "api_key=secret\n");
  fs.chmodSync(file, mode);
  return file;
}

test("a world-accessible file (0644) is flagged with its octal mode", { skip: !posix }, () => {
  const { logger, warnings } = recorder();
  const file = writeFileMode("loose.json", 0o644);
  warnIfPermsTooOpen(file, logger);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].obj, { path: file, mode: "644" }, "logs only path + octal mode");
});

test("a group-readable file (0640) is flagged too", { skip: !posix }, () => {
  const { logger, warnings } = recorder();
  warnIfPermsTooOpen(writeFileMode("group.json", 0o640), logger);
  assert.equal(warnings.length, 1);
});

test("a locked-down file (0600) is NOT flagged", { skip: !posix }, () => {
  const { logger, warnings } = recorder();
  warnIfPermsTooOpen(writeFileMode("tight.json", 0o600), logger);
  assert.equal(warnings.length, 0);
});

test("a missing file neither throws nor warns", () => {
  const { logger, warnings } = recorder();
  assert.doesNotThrow(() => warnIfPermsTooOpen(path.join(tmp, "does-not-exist.json"), logger));
  assert.equal(warnings.length, 0);
});

test("an empty path is a no-op", () => {
  const { logger, warnings } = recorder();
  warnIfPermsTooOpen("", logger);
  assert.equal(warnings.length, 0);
});

test("a logger without a warn method never throws (the method is optional)", { skip: !posix }, () => {
  const file = writeFileMode("loose2.json", 0o644);
  assert.doesNotThrow(() => warnIfPermsTooOpen(file, {}));
});
