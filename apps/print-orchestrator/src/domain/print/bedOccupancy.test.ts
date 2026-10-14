import assert from "node:assert/strict";
import { test } from "node:test";

import { isExternalCycle, resolveBedOccupancy } from "./bedOccupancy";

/*
 * CRITICAL-02: `idle` is the state of the printer's program, not of its plate.
 * Only a recorded clearance is evidence of a free bed.
 */

const idle = { liveStatus: "idle", online: true, activeRunState: null } as const;

test("an idle printer with no tracked bed is UNKNOWN — never CLEAR", () => {
  assert.deepEqual(resolveBedOccupancy({ ...idle, latestCycle: null }), {
    state: "UNKNOWN",
    source: "untracked"
  });
});

test("only a recorded CLEAR cycle makes the bed CLEAR", () => {
  assert.equal(resolveBedOccupancy({ ...idle, latestCycle: { state: "CLEAR" } }).state, "CLEAR");
});

test("a finished part stays on the plate however idle the printer reports itself", () => {
  const occupancy = resolveBedOccupancy({ ...idle, latestCycle: { state: "AWAITING_CLEARANCE" } });
  assert.equal(occupancy.state, "AWAITING_CLEARANCE");
  assert.equal(occupancy.source, "tracked");
});

test("a print observed on the machine outranks a CLEAR record (an external start)", () => {
  const occupancy = resolveBedOccupancy({
    latestCycle: { state: "CLEAR" },
    liveStatus: "printing",
    online: true,
    activeRunState: null
  });
  assert.deepEqual(occupancy, { state: "RUNNING", source: "telemetry" });
});

test("an offline printer's last CLEAR is kept, but its telemetry proves nothing new", () => {
  assert.equal(
    resolveBedOccupancy({ latestCycle: null, liveStatus: "printing", online: false, activeRunState: null }).state,
    "UNKNOWN",
    "a stale 'printing' from an offline device is not evidence either way"
  );
});

test("an UNKNOWN run is an UNKNOWN bed; a PENDING one holds it busy", () => {
  assert.equal(resolveBedOccupancy({ ...idle, latestCycle: { state: "CLEAR" }, activeRunState: "UNKNOWN" }).state, "UNKNOWN");
  assert.equal(resolveBedOccupancy({ ...idle, latestCycle: { state: "CLEAR" }, activeRunState: "PENDING" }).state, "RUNNING");
});

test("external cycles are recognised by their marker", () => {
  assert.equal(isExternalCycle({ metadata: { external: true } }), true);
  assert.equal(isExternalCycle({ metadata: {} }), false);
  assert.equal(isExternalCycle(null), false);
});
