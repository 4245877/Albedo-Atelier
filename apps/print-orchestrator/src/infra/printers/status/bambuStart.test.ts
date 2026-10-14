import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { PrinterConfig } from "../config";
import { mergeBambuRawPrint, shutdownBambuConnections } from "./bambu";
import {
  assertBambuCanStart,
  BambuStartUnconfirmedError,
  buildBambuStartPayload,
  confirmBambuStart,
  feedStateFromReport,
  liveFeedState,
  sendBambuStart
} from "./bambuStart";
import { resolveFeedPlan, type FeedPlan } from "../../../domain/printers/feedPlan";
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

test("HIGH-11: an uploaded package is started by the plate entry its analysis read", () => {
  // An operator's export of plate 2 carries `plate_2.gcode`; naming plate_1
  // would start a plate that is not in the file.
  const { payload } = buildBambuStartPayload(PRINTER, "bracket-1a2b3c4d.gcode.3mf", null, "Metadata/plate_2.gcode");
  assert.equal(payload.command, "project_file");
  assert.equal(payload.param, "Metadata/plate_2.gcode");

  // The name ends up inside a device command: only the plate-entry shape passes,
  // refused before anything is published.
  for (const bad of ["../plate_1.gcode", "Metadata/plate_1.gcode; M502", "Metadata/x.gcode", "Metadata/plate_0.gcode"]) {
    assert.throws(
      () => buildBambuStartPayload(PRINTER, "bracket-1a2b3c4d.gcode.3mf", null, bad),
      (e: unknown) => e instanceof PrinterCommandError,
      bad
    );
  }
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

// ── The filament source comes from the job, never "the first loaded tray" ────

/** A one-filament job asking for `material`, planned against the CURRENT report. */
function planFor(material: string, choice?: Record<number, number>): FeedPlan {
  const live = liveFeedState(PRINTER);
  return resolveFeedPlan({
    hasAms: live.hasAms === true,
    trays: live.trays,
    requirement: { filaments: [{ index: 0, material, color: null }], slotCount: 1 },
    choice: choice ?? null
  });
}

test("no AMS reported ⇒ use_ams false, even for a printer called «Combo»", () => {
  // This farm's A1 Combo reports zero AMS units and feeds from the external
  // spool. Telling the firmware to use a non-existent AMS is a refusal.
  reportState({ ams: { ams: [] }, vt_tray: { tray_type: "PETG" } });
  const plan = planFor("PETG");
  assert.equal(plan.kind, "external");

  const { payload } = buildBambuStartPayload(PRINTER, "part.gcode.3mf", plan);
  assert.equal(payload.use_ams, false);
  assert.ok(!("ams_mapping" in payload), "no mapping is sent when the AMS is not used");
});

test("CRITICAL-03: the tray holding the job's material is used, not the first loaded one", () => {
  // Slot 1 (tray 0) holds PLA and is loaded first; the PETG job must go to slot 3.
  reportState({
    ams: {
      tray_now: "0",
      ams: [
        {
          id: "0",
          tray: [
            { id: "0", tray_type: "PLA", tray_color: "FFFFFFFF" },
            { id: "1" },
            { id: "2", tray_type: "PETG", tray_color: "000000FF" }
          ]
        }
      ]
    }
  });
  const plan = planFor("PETG");
  assert.equal(plan.kind, "ams");
  const { payload } = buildBambuStartPayload(PRINTER, "part.gcode.3mf", plan);
  assert.equal(payload.use_ams, true);
  // Bambu Studio's form: indexed by the job's filament (one), value = global tray id.
  assert.deepEqual(payload.ams_mapping, [2]);
  assert.deepEqual(payload.ams_mapping2, [{ ams_id: 0, slot_id: 2 }]);
});

test("a second AMS unit is addressed by its real global tray id (ams_id × 4 + slot)", () => {
  reportState({
    ams: {
      ams: [
        { id: "0", tray: [{ id: "0", tray_type: "PLA" }] },
        { id: "1", tray: [{ id: "3", tray_type: "PETG" }] }
      ]
    }
  });
  const plan = planFor("PETG");
  assert.equal(plan.kind, "ams");
  const { payload } = buildBambuStartPayload(PRINTER, "part.gcode.3mf", plan);
  assert.deepEqual(payload.ams_mapping, [7]);
  assert.deepEqual(payload.ams_mapping2, [{ ams_id: 1, slot_id: 3 }]);
});

test("no tray with the job's material ⇒ unresolved, and the payload builder refuses it", () => {
  reportState({ ams: { ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA" }] }] } });
  const plan = planFor("PETG");
  assert.equal(plan.kind, "unresolved");
  assert.equal(plan.kind === "unresolved" && plan.code, "AMS_MATERIAL_MISMATCH");
  assert.throws(
    () => buildBambuStartPayload(PRINTER, "part.gcode.3mf", plan),
    (e: unknown) => e instanceof PrinterCommandError && e.definitivelyRejected
  );
});

test("two trays with the material and nothing to tell them apart ⇒ ambiguous until an operator picks", () => {
  reportState({
    ams: {
      ams: [
        {
          id: "0",
          tray: [
            { id: "0", tray_type: "PETG", tray_color: "FF0000FF" },
            { id: "1", tray_type: "PETG", tray_color: "00FF00FF" }
          ]
        }
      ]
    }
  });
  const ambiguous = planFor("PETG");
  assert.equal(ambiguous.kind === "unresolved" && ambiguous.code, "AMS_SLOT_AMBIGUOUS");
  const chosen = planFor("PETG", { 0: 1 });
  assert.equal(chosen.kind, "ams");
  assert.deepEqual(chosen.kind === "ams" && chosen.mapping, [1]);
});

test("an operator cannot pick a tray of a different material family", () => {
  reportState({ ams: { ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA" }, { id: "1", tray_type: "PETG" }] }] } });
  const plan = planFor("PETG", { 0: 0 });
  assert.equal(plan.kind === "unresolved" && plan.code, "AMS_MATERIAL_MISMATCH");
});

test("a bare .gcode cannot be started through the AMS — there is no mapping in gcode_file", () => {
  reportState({ ams: { ams: [{ id: "0", tray: [{ id: "0", tray_type: "PETG" }] }] } });
  const plan = planFor("PETG");
  assert.throws(() => buildBambuStartPayload(PRINTER, "part.gcode", plan), PrinterCommandError);
});

test("the pinned tray is re-checked right before publishing: a swapped spool refuses with nothing sent", async () => {
  reportState({
    online: true,
    ams: { ams: [{ id: "0", tray: [{ id: "0", tray_type: "PETG", tray_color: "000000FF" }] }] }
  } as Record<string, unknown>);
  const plan = planFor("PETG");
  assert.equal(plan.kind, "ams");
  // Between the decision and the send, someone loads PLA into that slot.
  reportState({ ams: { ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA", tray_color: "000000FF" }] }] } });
  await assert.rejects(
    sendBambuStart(PRINTER, "part.gcode.3mf", { feed: plan as unknown as Record<string, unknown> }),
    (e: unknown) =>
      e instanceof PrinterCommandError && e.definitivelyRejected && /PLA/.test(e.message)
  );
});

test("an AMS printer refuses a start with no pinned feed at all (no silent first-tray fallback)", async () => {
  reportState({ ams: { ams: [{ id: "0", tray: [{ id: "0", tray_type: "PETG" }] }] } });
  await assert.rejects(
    sendBambuStart(PRINTER, "part.gcode.3mf", { feed: null }),
    (e: unknown) => e instanceof PrinterCommandError && e.definitivelyRejected
  );
});

test("telemetry we have never received is not read as «no AMS»", () => {
  // Nothing reported at all: the feeding options are unknown, not "external".
  const live = liveFeedState(PRINTER);
  assert.equal(live.hasAms, null);
  assert.equal(live.trays, null);
});

test("the report parser exposes the external spool as tray 254 beside the AMS slots", () => {
  const state = feedStateFromReport({
    ams: { tray_now: "254", ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA" }] }] },
    vt_tray: { tray_type: "PETG", tray_color: "112233FF" }
  });
  assert.equal(state.hasAms, true);
  const external = state.trays.find((t) => t.external);
  assert.equal(external?.trayId, 254);
  assert.equal(external?.material, "PETG");
  assert.equal(external?.active, true);
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
  reportState({ gcode_state: "FAILED", subtask_name: "cube-1a2b3c4d", print_error: 0x0300c011 });
  await assert.rejects(
    () => confirmBambuStart(PRINTER, "cube-1a2b3c4d", immediate),
    (error: unknown) => {
      assert.ok(error instanceof PrinterCommandError);
      assert.ok(!(error instanceof BambuStartUnconfirmedError), "refusal, not unknown");
      assert.match((error as Error).message, /отклонил запуск/);
      // The code as the printer's screen renders it — the decimal register was a
      // number that appeared nowhere in the operator's world.
      assert.match((error as Error).message, /0300-C011/);
      assert.equal(
        (error as PrinterCommandError).definitivelyRejected,
        true,
        "a refused start must unwind, not hold the printer for reconciliation"
      );
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

/**
 * Confirmation options whose first wait makes the device raise `code`.
 *
 * Timing is the whole point of these cases: a fault the printer was ALREADY
 * showing is a standing complaint, while one raised after the command went out
 * is this start's verdict. Seeding the report before the call would test the
 * former while claiming to test the latter.
 */
function raisesFaultWhileWaiting(code: number): typeof immediate {
  let raised = false;
  return {
    ...immediate,
    sleep: async () => {
      if (!raised) {
        raised = true;
        reportState({ gcode_state: "IDLE", print_error: code });
      }
    }
  };
}

// ── The MicroSD incident ─────────────────────────────────────────────────────
//
// A plate package was uploaded, size-verified on the card and correct. The A1
// could not read the card, put `0500-C010` on its screen, and stayed at IDLE for
// the whole confirmation window — so the only thing the service could conclude
// was «не подтвердил запуск», which held the printer and made it report itself
// busy to its own queue. Every assertion below is that failure, inverted.

test("a MicroSD fault raised after the command is a REFUSAL, not an unknown", async () => {
  reportState({ gcode_state: "IDLE", subtask_name: "" });

  await assert.rejects(
    // The device raises the fault mid-wait, while still sitting at IDLE — the
    // exact shape of the incident, and the case a gcode_state-only watch can
    // never see, because a job that never starts never leaves idle.
    () => confirmBambuStart(PRINTER, "cube-1a2b3c4d", raisesFaultWhileWaiting(0x0500c010)),
    (error: unknown) => {
      assert.ok(error instanceof PrinterCommandError);
      assert.ok(
        !(error instanceof BambuStartUnconfirmedError),
        "an explained refusal must not be reported as an unknown outcome"
      );
      assert.equal((error as PrinterCommandError).definitivelyRejected, true);
      return true;
    }
  );
});

test("the refusal names the card, the code and the remedy — one cause, actionable", async () => {
  reportState({ gcode_state: "IDLE" });

  await assert.rejects(
    () => confirmBambuStart(PRINTER, "cube-1a2b3c4d", raisesFaultWhileWaiting(0x0500c010)),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /0500-C010/, "the code the printer's screen is showing");
      assert.match(message, /MicroSD/i, "what it means");
      assert.match(message, /Переустановите|замените/i, "what to do about it");
      assert.match(message, /Bambu Lab A1 Combo/, "which machine");
      return true;
    }
  );
});

test("a fault the printer was already showing does not fail the next launch", async () => {
  // Standing complaints are not this start's verdict. Without this, one
  // unacknowledged advisory would refuse every subsequent launch on the machine.
  reportState({ gcode_state: "IDLE", print_error: 0x0500c010 });

  await assert.rejects(
    () => confirmBambuStart(PRINTER, "cube-1a2b3c4d", immediate),
    BambuStartUnconfirmedError,
    "pre-existing fault ⇒ still merely unconfirmed, not attributed to this start"
  );
});

test("an unrecognised fault code never turns a slow start into a refusal", async () => {
  reportState({ gcode_state: "IDLE" });

  await assert.rejects(
    () => confirmBambuStart(PRINTER, "cube-1a2b3c4d", raisesFaultWhileWaiting(0x07008011)),
    BambuStartUnconfirmedError,
    "only codes with a confirmed meaning may conclude anything"
  );
});

test("a job that starts anyway wins over a fault raised alongside it", async () => {
  // A benign-but-blocking-looking code must not cancel a print that is visibly
  // running: positive evidence of our job outranks the fault channel.
  reportState({ gcode_state: "RUNNING", subtask_name: "cube-1a2b3c4d", print_error: 0x0500c010 });
  await confirmBambuStart(PRINTER, "cube-1a2b3c4d", immediate);
});

// ── Pre-flight ───────────────────────────────────────────────────────────────

test("a start is refused before publishing when the card is not readable", () => {
  reportState({ gcode_state: "IDLE", sdcard: false });

  assert.throws(
    () => assertBambuCanStart(PRINTER),
    (error: unknown) => {
      assert.ok(error instanceof PrinterCommandError);
      assert.equal((error as PrinterCommandError).definitivelyRejected, true);
      assert.match((error as Error).message, /карт[уы] MicroSD/i);
      return true;
    }
  );
});

test("a readable card and a quiet device pass pre-flight", () => {
  reportState({ gcode_state: "IDLE", sdcard: true, print_error: 0, hms: [] });
  assert.doesNotThrow(() => assertBambuCanStart(PRINTER));
});

test("pre-flight stays silent when the device has reported nothing yet", () => {
  // Absence of telemetry is refused by the dispatch gate, with a better message
  // than this module could give; inventing a second refusal here would be noise.
  assert.doesNotThrow(() => assertBambuCanStart(PRINTER));
});
