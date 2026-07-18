import assert from "node:assert/strict";
import { test } from "node:test";

import { createSnapshot, isSnapshotStale, paramsPayload } from "../render/editSnapshot.js";

/*
 * The two-tab optimistic-locking scenario, simulated end-to-end against a tiny
 * in-memory "server" with the same version semantics as the backend
 * (expectedVersion mismatch → 409):
 *
 *   tab A opens the form at v1 → tab B saves (v2) → tab A's poll refreshes the
 *   global state → tab A must (a) see its form flagged stale and (b) submit
 *   with the SNAPSHOT version (v1), earning an honest 409 — never a silent
 *   clobber of B's change. Re-reading mints a new snapshot and then succeeds.
 */

function makeServer() {
  const task = { id: "task_1", version: 1, priority: 0, dayNightPreference: "any" };
  return {
    get: () => ({ ...task }),
    save(payload) {
      if (payload.expectedVersion !== undefined && payload.expectedVersion !== task.version) {
        const err = new Error(`409 VERSION_CONFLICT: ожидалась версия ${payload.expectedVersion}`);
        err.status = 409;
        throw err;
      }
      task.priority = payload.priority;
      task.version += 1;
      return { ...task };
    }
  };
}

test("two tabs: the stale tab submits its snapshot version and gets 409, never a silent overwrite", () => {
  const server = makeServer();

  // Tab A opens the editor at v1 — the snapshot freezes that identity.
  const snapA = createSnapshot(server.get());
  assert.equal(snapA.version, 1);

  // Tab B edits and saves first — the server moves to v2.
  const snapB = createSnapshot(server.get());
  server.save(paramsPayload(snapB, { priority: 5 }));
  assert.equal(server.get().version, 2);
  assert.equal(server.get().priority, 5);

  // Tab A's background poll refreshes its global state to v2 — the OPEN form
  // must be flagged stale (this is what renders the banner)…
  const polled = server.get();
  assert.equal(isSnapshotStale(snapA, polled), true, "the open form is visibly stale");

  // …and its submit still carries the SNAPSHOT version (v1), not the polled v2.
  const payloadA = paramsPayload(snapA, { priority: 9 });
  assert.equal(payloadA.expectedVersion, 1, "expectedVersion comes from the snapshot, not the poll");
  assert.throws(() => server.save(payloadA), /409/);
  assert.equal(server.get().priority, 5, "tab B's change survived — nothing was clobbered");

  // Tab A re-reads: a NEW snapshot at v2; the retried save now succeeds.
  const freshSnap = createSnapshot(server.get());
  assert.equal(isSnapshotStale(freshSnap, server.get()), false);
  server.save(paramsPayload(freshSnap, { priority: 9 }));
  assert.equal(server.get().priority, 9);
  assert.equal(server.get().version, 3);
});

test("a deleted/dispatched task makes the open form stale too", () => {
  const snap = createSnapshot({ id: "task_1", version: 4 });
  assert.equal(isSnapshotStale(snap, null), true);
});

test("a form without a snapshot sends no expectedVersion (server applies last-write)", () => {
  const payload = paramsPayload(null, { priority: 1 });
  assert.equal("expectedVersion" in payload, false);
});
