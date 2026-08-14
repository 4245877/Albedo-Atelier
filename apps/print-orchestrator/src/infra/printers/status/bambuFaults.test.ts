import assert from "node:assert/strict";
import test from "node:test";

import {
  formatBambuHmsCode,
  formatBambuPrintError,
  parseBambuFaults,
  parseBambuMediaPresent,
  startBlockingFaults
} from "./bambuFaults";

/**
 * The register decoding, pinned against the one incident that produced it.
 *
 * The A1 displayed `0500-C010` on its own screen while refusing to start an
 * uploaded, verified plate package. That string is the contract: an operator
 * matches what the service says against what the machine says, and a
 * differently-formatted rendering of the same number is useless to them.
 */

test("print_error renders exactly as the printer's screen shows it", () => {
  assert.equal(formatBambuPrintError(0x0500c010), "0500-C010");
  // The register arrives as a plain decimal over MQTT.
  assert.equal(formatBambuPrintError(83935248), "0500-C010");
  // Low halves keep their leading zeros; a trimmed code matches nothing.
  assert.equal(formatBambuPrintError(0x03000100), "0300-0100");
});

test("an HMS entry renders in the four-half form Bambu's own index uses", () => {
  assert.equal(formatBambuHmsCode(0x03000100, 0x00020001), "0300_0100_0002_0001");
});

test("the MicroSD read/write fault is recognised and blocks a start", () => {
  const faults = parseBambuFaults({ print_error: 0x0500c010, gcode_state: "IDLE" });

  assert.equal(faults.length, 1);
  assert.equal(faults[0].code, "0500-C010");
  assert.equal(faults[0].source, "print_error");
  assert.match(faults[0].title ?? "", /MicroSD/i);
  assert.equal(faults[0].blocksStart, true);
  assert.deepEqual(startBlockingFaults(faults), faults);
});

test("a fault is reported even while the device reports IDLE", () => {
  // The whole point: a job that never starts never leaves idle, so a fault that
  // is only believed in a non-idle state is a fault that is never believed.
  const faults = parseBambuFaults({ gcode_state: "IDLE", print_error: 0x0500c010 });
  assert.equal(faults.length, 1);
});

test("an unrecognised code is reported honestly and never blocks", () => {
  const faults = parseBambuFaults({ print_error: 0x07008011 });

  assert.equal(faults.length, 1);
  assert.equal(faults[0].code, "0700-8011");
  assert.equal(faults[0].title, null, "no meaning is invented for an unknown code");
  assert.equal(
    faults[0].blocksStart,
    false,
    "refusing on an undecoded number would ground the farm on a guess"
  );
  assert.deepEqual(startBlockingFaults(faults), []);
});

test("a quiet device produces no faults", () => {
  assert.deepEqual(parseBambuFaults({ print_error: 0, hms: [], gcode_state: "IDLE" }), []);
  assert.deepEqual(parseBambuFaults({}), []);
});

test("hms entries are decoded, and a code in both registers is reported once", () => {
  const faults = parseBambuFaults({
    print_error: 0x0500c010,
    hms: [
      { attr: 0x0500c010, code: 0x00000000 },
      { attr: 0x03000100, code: 0x00020001 }
    ]
  });

  // The first hms entry decodes to a four-half code, so it does NOT collide with
  // the print_error rendering; the second is a genuinely separate fault.
  assert.equal(faults.length, 3);
  assert.equal(faults[0].code, "0500-C010");
  assert.deepEqual(
    faults.map((f) => f.source),
    ["print_error", "hms", "hms"]
  );
});

test("malformed hms entries are skipped rather than throwing", () => {
  const faults = parseBambuFaults({
    hms: [null, "nonsense", { attr: 0, code: 0 }, { attr: 0x03000100, code: 0x00020001 }]
  });
  assert.equal(faults.length, 1);
});

test("media presence is read where the device states it, and stays unknown otherwise", () => {
  assert.equal(parseBambuMediaPresent({ sdcard: true }), true);
  assert.equal(parseBambuMediaPresent({ sdcard: false }), false);
  assert.equal(parseBambuMediaPresent({ sdcard: "normal" }), true);
  assert.equal(parseBambuMediaPresent({ sdcard: "missing" }), false);
  // Absent is "the device did not say", never "the card is fine".
  assert.equal(parseBambuMediaPresent({}), null);
  assert.equal(parseBambuMediaPresent({ sdcard: 42 }), null);
});
