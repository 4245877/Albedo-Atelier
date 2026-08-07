import assert from "node:assert/strict";
import { test } from "node:test";

import { parseBambuAms, parseBambuFirmware, parseBambuMaterials, parseBambuSerial } from "./bambu";

/*
 * Parsing of the two payloads a Bambu printer sends about itself. The fixtures
 * below are shaped like the real LAN MQTT traffic — an `info.get_version` reply
 * and the AMS block of a `print` report — because the value of this layer is
 * entirely in reading those correctly and reading nothing else into them.
 */

const GET_VERSION_REPLY = {
  command: "get_version",
  sequence_id: "20001",
  module: [
    { name: "ota", project_name: "C11", sw_ver: "01.04.00.00", hw_ver: "AP05", sn: "0309CA470100001" },
    { name: "esp32", sw_ver: "00.03.12.31", hw_ver: "AP04", sn: "0309CA470100001" },
    { name: "mc", sw_ver: "00.00.19.05", hw_ver: "MC07", sn: "0309CA470100001" }
  ]
};

test("firmware comes from the ota module, not from another board's revision", () => {
  assert.equal(parseBambuFirmware(GET_VERSION_REPLY), "01.04.00.00");
});

test("the device-reported serial comes from the ota module", () => {
  assert.equal(parseBambuSerial(GET_VERSION_REPLY), "0309CA470100001");
});

test("a reply with no ota module yields null rather than another module's version", () => {
  const reply = { module: [{ name: "mc", sw_ver: "00.00.19.05", sn: "X" }] };
  assert.equal(parseBambuFirmware(reply), null);
  assert.equal(parseBambuSerial(reply), null);
});

test("a malformed reply is survivable", () => {
  assert.equal(parseBambuFirmware({}), null);
  assert.equal(parseBambuFirmware({ module: "not-an-array" }), null);
  assert.equal(parseBambuSerial({ module: [null, 42, "x"] }), null);
});

// ── AMS ──────────────────────────────────────────────────────────────────────

const AMS_PRINT = {
  ams: {
    tray_now: "1",
    ams: [
      {
        id: "0",
        humidity: "4",
        tray: [
          { id: "0", tray_type: "PLA", tray_color: "FFFFFFFF", remain: 92, tray_weight: "1000" },
          { id: "1", tray_type: "PETG", tray_color: "1A2B3CFF", remain: 40, tray_weight: "1000" },
          { id: "2", tray_type: "", tray_color: "00000000", remain: -1 },
          { id: "3", tray_type: "", tray_color: "00000000", remain: -1 }
        ]
      }
    ]
  }
};

test("AMS presence, unit count and slot count come from the device", () => {
  assert.deepEqual(parseBambuAms(AMS_PRINT), { present: true, units: 1, slots: 4 });
});

test("no ams block at all means UNKNOWN, not «no AMS»", () => {
  // A printer that has not sent a full report yet has said nothing about its
  // hardware; answering `present: false` would be inventing an absence.
  assert.equal(parseBambuAms({}), null);
  assert.equal(parseBambuAms({ ams: {} }), null);
});

test("an empty ams array IS the device saying no units are attached", () => {
  assert.deepEqual(parseBambuAms({ ams: { ams: [] } }), {
    present: false,
    units: null,
    slots: null
  });
});

test("loaded materials list the filled slots and mark the feeding one", () => {
  const materials = parseBambuMaterials(AMS_PRINT);
  assert.deepEqual(materials, [
    { slot: 0, material: "PLA", color: "#FFFFFF", remainPct: 92, active: false },
    { slot: 1, material: "PETG", color: "#1A2B3C", remainPct: 40, active: true }
  ]);
});

test("the external spool is listed only when nothing in the AMS is feeding", () => {
  const withExternal = {
    ams: { tray_now: "255", ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA", remain: 50, tray_weight: "1000" }] }] },
    vt_tray: { tray_type: "TPU", tray_color: "00FF00FF", remain: 70 }
  };

  const materials = parseBambuMaterials(withExternal);
  assert.deepEqual(materials?.at(-1), {
    slot: null,
    material: "TPU",
    color: "#00FF00",
    remainPct: 70,
    active: true
  });
});

test("an AMS tray that is feeding suppresses the external spool entry", () => {
  const both = {
    ...AMS_PRINT,
    vt_tray: { tray_type: "TPU", tray_color: "00FF00FF", remain: 70 }
  };

  const materials = parseBambuMaterials(both);
  assert.equal(materials?.some((entry) => entry.slot === null), false);
});

test("no filament anywhere yields null, not an empty list", () => {
  assert.equal(parseBambuMaterials({}), null);
});
