import assert from "node:assert/strict";
import { test } from "node:test";

import type { Assignment, DeviceArtifact, PrintRun } from "../../domain/print/types";
import { EMPTY_ASSIGNMENT_BINDING } from "../../domain/print/types";
import { assignmentView } from "./assignmentRoutes";

/*
 * `nextAction` — the execution panel's single hint about what to do next.
 *
 * The incident it is pinned against: a launch on the A1 was dispatched, never
 * confirmed, and left the task DISPATCHING with an UNKNOWN run, a RESERVED
 * assignment, a RESERVED bed and a live start guard. This hint was computed from
 * the device file ALONE — which was still VERIFIED — so it said `start`, and the
 * dashboard drew a green "▶ Запустить" over five standing holds. Pressing it
 * could only ever produce a 409. The server was right to refuse; the UI was
 * wrong to ask.
 */

const ISO = "2026-08-14T12:00:00.000Z";

function assignment(over: Partial<Assignment> = {}): Assignment {
  return {
    id: "asg_1",
    taskId: "task_1",
    printerId: "bambu-a1-combo",
    planId: null,
    bedCycleId: "bed_1",
    state: "RESERVED",
    source: "manual",
    reason: null,
    createdBy: "operator",
    invalidatedAt: null,
    invalidatedReason: null,
    binding: { ...EMPTY_ASSIGNMENT_BINDING, expectedRemotePath: "3U-default-28ab3676.gcode.3mf" },
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {},
    ...over
  } as Assignment;
}

function device(over: Partial<DeviceArtifact> = {}): DeviceArtifact {
  return {
    id: "dev_1",
    printerId: "bambu-a1-combo",
    assignmentId: "asg_1",
    state: "VERIFIED",
    transferMode: "adapter_upload",
    remotePath: "3U-default-28ab3676.gcode.3mf",
    ...over
  } as DeviceArtifact;
}

function run(over: Partial<PrintRun> = {}): PrintRun {
  return {
    id: "run_1",
    taskId: "task_1",
    assignmentId: "asg_1",
    dispatchAttemptId: "dsp_1",
    printerId: "bambu-a1-combo",
    bedCycleId: "bed_1",
    state: "UNKNOWN",
    file: "3U-default-28ab3676.gcode.3mf",
    artifactId: "art_1",
    artifactSha256: "28ab3676",
    idempotencyKey: null,
    startedAt: null,
    endedAt: null,
    progress: null,
    filamentUsedG: null,
    durationS: null,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {},
    ...over
  } as PrintRun;
}

test("a verified file with no run in the way is startable", () => {
  const view = assignmentView(assignment(), device(), null);
  assert.equal(view.nextAction, "start");
  assert.equal(view.fileReady, true);
  assert.equal(view.unresolvedRunId, null);
});

test("a VERIFIED file does NOT mean startable while a start awaits the operator", () => {
  // The exact live shape. The file is verified and stays verified — that is not
  // the question the operator is being asked.
  const view = assignmentView(assignment(), device({ state: "VERIFIED" }), run());

  assert.equal(view.nextAction, "resolve", "the honest next step is the verdict");
  assert.notEqual(view.nextAction, "start");
  assert.equal(view.unresolvedRunId, "run_1");
  assert.equal(view.fileReady, true, "the file is still verified; it just is not the blocker");
  assert.equal(view.deviceArtifact?.state, "VERIFIED", "and the artifact is untouched");
});

test("a PENDING run that never started blocks the hint the same way", () => {
  const view = assignmentView(assignment(), device(), run({ state: "PENDING" }));
  assert.equal(view.nextAction, "resolve");
  assert.equal(view.unresolvedRunId, "run_1");
});

test("a run that was observed printing is not the operator's to resolve here", () => {
  const view = assignmentView(assignment(), device(), run({ state: "RUNNING", startedAt: ISO }));
  assert.equal(view.unresolvedRunId, null);
  assert.notEqual(view.nextAction, "resolve");
});

test("an UNKNOWN run that HAD started is a completion question, not a start one", () => {
  const view = assignmentView(assignment(), device(), run({ startedAt: ISO }));
  assert.equal(view.unresolvedRunId, null);
});

test("once the run is resolved away, the assignment is startable again", () => {
  // `unwindUnstarted` cancels the run, so it is no longer the task's active one
  // and never reaches this function.
  const view = assignmentView(assignment({ state: "CANCELLED" }), device(), null);
  assert.equal(view.nextAction, "start");
  assert.equal(view.unresolvedRunId, null);
});

test("the file steps still come first when there is no verified file", () => {
  const upload = assignmentView(assignment(), device({ state: "NOT_PRESENT" }), null);
  assert.equal(upload.nextAction, "prepare-file");

  const manual = assignmentView(
    assignment(),
    device({ state: "NOT_PRESENT", transferMode: "manual_file_transfer" }),
    null
  );
  assert.equal(manual.nextAction, "confirm-file");
});

test("an unresolved run outranks the file steps too", () => {
  // Uploading again would be busywork: the printer is held either way, and the
  // upload cannot succeed into a slot the unresolved run still owns.
  const view = assignmentView(assignment(), device({ state: "NOT_PRESENT" }), run());
  assert.equal(view.nextAction, "resolve");
});

test("an invalidated placement still asks for a replan above everything", () => {
  const view = assignmentView(assignment({ invalidatedAt: ISO }), device(), run());
  assert.equal(view.nextAction, "replan");
});
