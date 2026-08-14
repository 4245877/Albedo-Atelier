import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { PrinterConfig } from "../config";
import { mergeBambuRawPrint, shutdownBambuConnections } from "./bambu";
import {
  BambuStartUnconfirmedError,
  buildBambuStartPayload,
  confirmBambuStart,
  resolveAmsUse
} from "./bambuStart";
import { PrinterCommandError } from "./types";

/**
 * The start command is the one place in this codebase that makes a printer move,
 * so what it *sends* and what it accepts as *proof it worked* are both asserted
 * here. No broker and no device: the payload builder is pure, and confirmation
 * reads the same telemetry cache the live status poll fills.
 */

const PRINTER: PrinterConfig = {
  id: "bambu-a1-combo",
  name: "Bambu Lab A1 Combo",
  model: "Bambu Lab A1 Combo",
  type: "FDM",
  protocol: "bambu",
  host: "192.168.0.188",
  port: 8883,
  material: "PETG",
  swatch: "",
  snapshotUrl: "",
  streamUrl: "",
  interfaceUrl: "",
  enabled: true,
  apiKey: "",
  serial: "03919D551805635",
  accessCode: "secret00",
  allowInsecureTls: true,
  light: {
    enabled: true,
    pin: "",
    invert: false,
    onGcode: "",
    offGcode: "",
    statusObject: "",
    statusField: "",
    bambuNode: "chamber_light"
  }
};

afterEach(() => shutdownBambuConnections());

/** Seeds the telemetry cache the confirmation reads, as an MQTT report would. */
function reportState(fields: Record<string, unknown>): void {
  mergeBambuRawPrint(PRINTER.id, fields);
}

const immediate = {
  timeoutMs: 50,
  intervalMs: 1,
  sleep: async () => undefined
};

// ── What gets sent ────────────────────────────────────────────────────────────

test("a .gcode.3mf is started as a project_file naming the plate inside it", () => {
  const { payload, subtaskName } = buildBambuStartPayload(PRINTER, "cube-1a2b3c4d.gcode.3mf");

  assert.equal(payload.command, "project_file");
  assert.equal(payload.param, "Metadata/plate_1.gcode");
  assert.equal(payload.url, "file:///mnt/sdcard/cube-1a2b3c4d.gcode.3mf");
  assert.equal(payload.subtask_name, "cube-1a2b3c4d");
  assert.equal(subtaskName, "cube-1a2b3c4d");
  // Local print: these identify a cloud job and must be zeroed, not omitted.
  assert.equal(payload.project_id, "0");
  assert.equal(payload.task_id, "0");
  assert.equal(payload.bed_type, "auto");
});

test("a bare .gcode uses the simpler gcode_file command with an absolute path", () => {
  const { payload } = buildBambuStartPayload(PRINTER, "cube-1a2b3c4d.gcode");
  assert.equal(payload.command, "gcode_file");
  assert.equal(payload.param, "/cube-1a2b3c4d.gcode");
});

test("calibration is not silently switched on for every print", () => {
  // Flow/vibration calibration add minutes to each job and are a deliberate
  // machine-level decision, not a per-print default. Bed levelling is cheap.
  const { payload } = buildBambuStartPayload(PRINTER, "part.gcode.3mf");
  assert.equal(payload.flow_cali, false);
  assert.equal(payload.vibration_cali, false);
  assert.equal(payload.bed_leveling, true);
  assert.equal(payload.timelapse, false);
});

// ── AMS is read from the device, not assumed from the model name ─────────────

test("no AMS reported ⇒ use_ams false, even for a printer called «Combo»", () => {
  // This farm's A1 Combo reports zero AMS units and feeds from the external
  // spool. Telling the firmware to use a non-existent AMS is a refusal.
  reportState({ ams: { ams: [] }, vt_tray: { tray_type: "PETG" } });
  const ams = resolveAmsUse(PRINTER);
  assert.equal(ams.use, false);

  const { payload } = buildBambuStartPayload(PRINTER, "part.gcode.3mf");
  assert.equal(payload.use_ams, false);
  assert.ok(!("ams_mapping" in payload), "no mapping is sent when the AMS is not used");
});

test("an AMS with a loaded tray maps to that slot in the documented 5-slot form", () => {
  reportState({
    ams: { ams: [{ id: "0", tray: [{ id: "0" }, { id: "1", tray_type: "PETG" }] }] }
  });
  const ams = resolveAmsUse(PRINTER);

  assert.equal(ams.use, true);
  // Reverse-indexed, -1 = unused, the active slot last.
  assert.deepEqual(ams.mapping, [-1, -1, -1, -1, 1]);

  const { payload } = buildBambuStartPayload(PRINTER, "part.gcode.3mf");
  assert.equal(payload.use_ams, true);
  assert.deepEqual(payload.ams_mapping, [-1, -1, -1, -1, 1]);
});

test("telemetry we have never received is not read as «no AMS» plus a guess", () => {
  // Nothing reported at all: fail closed to the external spool rather than
  // inventing a slot that may hold the wrong filament.
  const ams = resolveAmsUse(PRINTER);
  assert.equal(ams.use, false);
});

// ── What counts as proof it started ──────────────────────────────────────────

test("confirmation succeeds only when the device reports OUR job running", async () => {
  reportState({ gcode_state: "RUNNING", subtask_name: "cube-1a2b3c4d" });
  await confirmBambuStart(PRINTER, "cube-1a2b3c4d", immediate);
});

test("a job that was already running does not confirm a different start", async () => {
  // The false positive that would turn «the command was ignored» into «dispatch
  // succeeded» — and leave the queue believing it started something it did not.
  reportState({ gcode_state: "RUNNING", subtask_name: "somebody-elses-print" });
  await assert.rejects(
    () => confirmBambuStart(PRINTER, "cube-1a2b3c4d", immediate),
    BambuStartUnconfirmedError
  );
});

test("an idle printer never confirms a start", async () => {
  reportState({ gcode_state: "IDLE", subtask_name: "" });
  await assert.rejects(
    () => confirmBambuStart(PRINTER, "cube-1a2b3c4d", immediate),
    BambuStartUnconfirmedError
  );
});

test("silence is an UNCONFIRMED outcome, never a success and never a refusal", async () => {
  // The distinction the dispatch turns into «hold the printer and reconcile»
  // instead of «retry», which is how one model would get printed twice.
  await assert.rejects(
    () => confirmBambuStart(PRINTER, "cube-1a2b3c4d", immediate),
    (error: unknown) => {
      assert.ok(error instanceof BambuStartUnconfirmedError);
      assert.match((error as Error).message, /не подтвердил запуск/);
      return true;
    }
  );
});

test("an explicit FAILED state is a definitive refusal, not an unknown", async () => {
  reportState({ gcode_state: "FAILED", subtask_name: "cube-1a2b3c4d", print_error: 117 });
  await assert.rejects(
    () => confirmBambuStart(PRINTER, "cube-1a2b3c4d", immediate),
    (error: unknown) => {
      assert.ok(error instanceof PrinterCommandError);
      assert.ok(!(error instanceof BambuStartUnconfirmedError), "refusal, not unknown");
      assert.match((error as Error).message, /отклонил запуск/);
      assert.match((error as Error).message, /117/);
      return true;
    }
  );
});

test("PREPARE counts as started — the firmware accepted the job", async () => {
  reportState({ gcode_state: "PREPARE", gcode_file: "cube-1a2b3c4d.gcode.3mf" });
  await confirmBambuStart(PRINTER, "cube-1a2b3c4d", immediate);
});

test("the job is matched however the firmware spells the file name", async () => {
  reportState({ gcode_state: "RUNNING", gcode_file: "/mnt/sdcard/cube-1a2b3c4d.gcode.3mf" });
  await confirmBambuStart(PRINTER, "cube-1a2b3c4d", immediate);
});
