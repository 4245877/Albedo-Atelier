import assert from "node:assert/strict";
import { test } from "node:test";

import { computeCacheKey, type CacheKeyParts } from "./cacheKey";

function parts(over: Partial<CacheKeyParts> = {}): CacheKeyParts {
  return {
    sourceSha256: "a".repeat(64),
    machineResolvedSha256: "b".repeat(64),
    processResolvedSha256: "c".repeat(64),
    filamentResolvedSha256: "d".repeat(64),
    orcaVersion: "1.10.1",
    workerVersion: "slice-1",
    ...over
  };
}

test("cache key is a deterministic 64-char hex SHA-256", () => {
  const key = computeCacheKey(parts());
  assert.match(key, /^[0-9a-f]{64}$/);
});

test("the same inputs always produce the same key (repeat-stable)", () => {
  assert.equal(computeCacheKey(parts()), computeCacheKey(parts()));
});

test("property order in the parts object does not change the key", () => {
  // Build the identical values in a different literal order; the function reads
  // named fields, so JS property order must be irrelevant.
  const a: CacheKeyParts = {
    sourceSha256: "1".repeat(64),
    machineResolvedSha256: "2".repeat(64),
    processResolvedSha256: "3".repeat(64),
    filamentResolvedSha256: "4".repeat(64),
    orcaVersion: "2.0.0",
    workerVersion: "w"
  };
  const b: CacheKeyParts = {
    workerVersion: "w",
    orcaVersion: "2.0.0",
    filamentResolvedSha256: "4".repeat(64),
    processResolvedSha256: "3".repeat(64),
    machineResolvedSha256: "2".repeat(64),
    sourceSha256: "1".repeat(64)
  };
  assert.equal(computeCacheKey(a), computeCacheKey(b));
});

test("changing ANY significant component changes the key (all six are honoured)", () => {
  const base = computeCacheKey(parts());
  const fields: Array<keyof CacheKeyParts> = [
    "sourceSha256",
    "machineResolvedSha256",
    "processResolvedSha256",
    "filamentResolvedSha256",
    "orcaVersion",
    "workerVersion"
  ];
  for (const field of fields) {
    const changed = computeCacheKey(parts({ [field]: "changed-value" }));
    assert.notEqual(changed, base, `key must change when ${field} changes`);
  }
});

test("distinct components cannot be swapped without changing the key (no field is ambiguous)", () => {
  // Guards against a serialisation that concatenates values so that moving a
  // character across a boundary collides — the label prefixes must keep the
  // machine/process/filament slots distinct.
  const a = computeCacheKey(parts({ machineResolvedSha256: "x".repeat(64), processResolvedSha256: "y".repeat(64) }));
  const b = computeCacheKey(parts({ machineResolvedSha256: "y".repeat(64), processResolvedSha256: "x".repeat(64) }));
  assert.notEqual(a, b);
});

test("computing a key does not mutate the input parts", () => {
  const input = parts();
  const snapshot = JSON.parse(JSON.stringify(input));
  computeCacheKey(input);
  assert.deepEqual(input, snapshot);
});
