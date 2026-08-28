import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bambuMeasurableTrayCount,
  EXTERNAL_SPOOL_TRAY,
  bambuTrayUsage,
  normalizeTrayColor,
  parseAmsTrays,
  parseVtTray,
  resolveActiveFilament
} from "./bambuUsage";
import type { AmsTraySnapshot } from "./types";

/*
 * Pure Bambu AMS accounting: colour normalisation, reading the tray snapshot out
 * of a raw MQTT `print` payload, and turning start→end `remain` drops into grams.
 * No devices, no timers — just the math the poller relies on at completion.
 */

// ── normalizeTrayColor ─────────────────────────────────────────────────────

test("normalizeTrayColor: RRGGBBAA → #RRGGBB, drops alpha", () => {
  assert.equal(normalizeTrayColor("FF8800FF"), "#FF8800");
  assert.equal(normalizeTrayColor("1a2b3cff"), "#1A2B3C");
});

test("normalizeTrayColor keeps opaque black but drops empty/transparent slots", () => {
  assert.equal(normalizeTrayColor("000000FF"), "#000000", "opaque black is a real colour");
  assert.equal(normalizeTrayColor("00000000"), null, "fully transparent = empty slot");
  assert.equal(normalizeTrayColor(""), null);
  assert.equal(normalizeTrayColor("nope"), null);
  assert.equal(normalizeTrayColor(undefined), null);
});

test("normalizeTrayColor accepts a bare 6-hex value and a leading #", () => {
  assert.equal(normalizeTrayColor("00FF00"), "#00FF00");
  assert.equal(normalizeTrayColor("#00ff00"), "#00FF00");
});

// ── parseAmsTrays ──────────────────────────────────────────────────────────

test("parseAmsTrays reads loaded trays, marks the active one, skips empty slots", () => {
  const print = {
    ams: {
      tray_now: "1",
      ams: [
        {
          id: "0",
          tray: [
            { id: "0", tray_type: "PLA", tray_color: "FF0000FF", remain: 80, tray_weight: "1000" },
            { id: "1", tray_type: "PETG", tray_color: "00FF00FF", remain: 50, tray_weight: "1000" },
            { id: "2", tray_type: "", tray_color: "00000000", remain: -1 }, // empty slot
            { id: "3" } // empty slot
          ]
        }
      ]
    }
  };

  const trays = parseAmsTrays(print);
  assert.ok(trays);
  assert.equal(trays!.length, 2, "only the two loaded trays are returned");

  assert.deepEqual(trays![0], {
    tray: 0,
    material: "PLA",
    color: "#FF0000",
    remainPct: 80,
    nominalWeightG: 1000,
    active: false
  });
  assert.deepEqual(trays![1], {
    tray: 1,
    material: "PETG",
    color: "#00FF00",
    remainPct: 50,
    nominalWeightG: 1000,
    active: true // tray_now === "1"
  });
});

test("parseAmsTrays: unknown remain (-1) becomes null, not a number", () => {
  const trays = parseAmsTrays({
    ams: { tray_now: "255", ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA", remain: -1, tray_weight: "250" }] }] }
  });
  assert.equal(trays![0].remainPct, null);
  assert.equal(trays![0].nominalWeightG, 250);
  assert.equal(trays![0].active, false, "tray_now 255 (none) matches no tray");
});

test("parseAmsTrays indexes trays globally across AMS units", () => {
  const trays = parseAmsTrays({
    ams: {
      tray_now: "5",
      ams: [
        { id: "0", tray: [{ id: "0", tray_type: "PLA", remain: 90, tray_weight: "1000" }] },
        { id: "1", tray: [{ id: "1", tray_type: "ABS", remain: 70, tray_weight: "1000" }] }
      ]
    }
  });
  // unit 1, tray 1 → global index 1*4 + 1 = 5.
  assert.equal(trays![1].tray, 5);
  assert.equal(trays![1].active, true);
});

test("parseAmsTrays returns null only when NOTHING is loaded — no AMS and no spool", () => {
  assert.equal(parseAmsTrays({}), null);
  assert.equal(parseAmsTrays({ ams: { ams: [] } }), null);
  assert.equal(parseAmsTrays({ ams: { ams: [{ id: "0", tray: [{ id: "0" }] }] } }), null);
  // An empty external spool is not a loaded reel either.
  assert.equal(parseAmsTrays({ vt_tray: {} }), null);
  assert.equal(parseAmsTrays({ vt_tray: { tray_type: "", remain: -1 } }), null);
});

// ── The external spool as a first-class tray ────────────────────────────────
//
// `parseAmsTrays` used to return null for any printer without an AMS, which is
// this farm's A1 Combo on every print it has ever run: no baseline snapshot, no
// consumption measurement, and no loaded-reel binding for the filament actually
// in the machine.

test("a printer with NO AMS still reports its external spool as a loaded reel", () => {
  const trays = parseAmsTrays({
    vt_tray: { tray_type: "PLA", tray_color: "00AE42FF", remain: 78, tray_weight: "1000" }
  });
  assert.ok(trays, "an external spool is a loaded reel");
  assert.equal(trays.length, 1);
  assert.equal(trays[0].tray, EXTERNAL_SPOOL_TRAY);
  assert.equal(trays[0].material, "PLA");
  assert.equal(trays[0].color, "#00AE42");
  assert.equal(trays[0].remainPct, 78);
  assert.equal(trays[0].nominalWeightG, 1000);
  assert.equal(trays[0].active, true, "with no AMS there is no other path it could be feeding from");
});

test("an external spool with no declared weight is loaded but NOT measurable", () => {
  // The ordinary non-RFID spool. It must appear (so it can be bound to a reel)
  // and it must not produce grams (so nothing is invented).
  const trays = parseAmsTrays({ vt_tray: { tray_type: "PETG", remain: 60 } });
  assert.ok(trays);
  assert.equal(trays[0].nominalWeightG, null);
  const later = parseAmsTrays({ vt_tray: { tray_type: "PETG", remain: 52 } });
  assert.deepEqual(bambuTrayUsage(trays, later), [], "no weight, no grams — never a guess");
  assert.equal(bambuMeasurableTrayCount(trays, later), 0);
});

test("an external spool WITH a weight is measured by the same remain rule as an AMS tray", () => {
  const start = parseAmsTrays({ vt_tray: { tray_type: "PLA", remain: 95, tray_weight: "1000" } });
  const end = parseAmsTrays({ vt_tray: { tray_type: "PLA", remain: 88, tray_weight: "1000" } });
  assert.deepEqual(bambuTrayUsage(start, end), [
    { tray: EXTERNAL_SPOOL_TRAY, grams: 70, material: "PLA", color: null }
  ]);
});

test("AMS trays and the external spool coexist, with tray_now choosing the active one", () => {
  const print = {
    ams: {
      tray_now: String(EXTERNAL_SPOOL_TRAY),
      ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA", remain: 40, tray_weight: "1000" }] }]
    },
    vt_tray: { tray_type: "PETG", remain: 90, tray_weight: "1000" }
  };
  const trays = parseAmsTrays(print);
  assert.ok(trays);
  assert.deepEqual(trays.map((t) => t.tray), [0, EXTERNAL_SPOOL_TRAY]);
  assert.equal(trays[0].active, false);
  assert.equal(trays[1].active, true, "the printer says it is feeding externally");
  // …and an AMS slot that IS feeding keeps the external spool inactive.
  const viaAms = parseAmsTrays({ ...print, ams: { ...print.ams, tray_now: "0" } });
  assert.equal(viaAms?.[0].active, true);
  assert.equal(viaAms?.[1].active, false);
});

test("the external spool is never presented to the operator as an AMS slot number", () => {
  const print = { vt_tray: { tray_type: "PLA", tray_color: "FF0000FF", remain: 70 } };
  const active = resolveActiveFilament(print, parseAmsTrays(print));
  assert.equal(active?.material, "PLA");
  assert.equal(active?.tray, null, "«лоток 254» is not a thing an operator can look at");
  assert.equal(active?.remainPct, 70);
});

// ── parseVtTray / resolveActiveFilament ────────────────────────────────────

test("resolveActiveFilament picks the active AMS tray (tray_now)", () => {
  const print = {
    ams: {
      tray_now: "1",
      ams: [
        {
          id: "0",
          tray: [
            { id: "0", tray_type: "PLA", tray_color: "FF0000FF", remain: 80, tray_weight: "1000" },
            { id: "1", tray_type: "PETG", tray_color: "00FF00FF", remain: 50, tray_weight: "1000" }
          ]
        }
      ]
    }
  };
  const trays = parseAmsTrays(print);
  assert.deepEqual(resolveActiveFilament(print, trays), {
    material: "PETG",
    color: "#00FF00",
    tray: 1,
    remainPct: 50
  });
});

test("resolveActiveFilament falls back to vt_tray when no AMS tray is active", () => {
  // tray_now 255 = external spool, no AMS tray feeding.
  const print = {
    ams: {
      tray_now: "255",
      ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA", remain: 90, tray_weight: "1000" }] }]
    },
    vt_tray: { tray_type: "TPU", tray_color: "0000FFFF", remain: 42 }
  };
  const trays = parseAmsTrays(print);
  assert.deepEqual(resolveActiveFilament(print, trays), {
    material: "TPU",
    color: "#0000FF",
    tray: null,
    remainPct: 42
  });
});

test("resolveActiveFilament returns null when neither AMS nor vt_tray has data", () => {
  assert.equal(resolveActiveFilament({}, null), null);
  assert.equal(resolveActiveFilament({ vt_tray: { tray_type: "", tray_color: "00000000" } }, null), null);
});

test("parseVtTray reads the external spool and ignores an empty one", () => {
  assert.deepEqual(parseVtTray({ vt_tray: { tray_type: "PETG", tray_color: "112233FF", remain: 70 } }), {
    material: "PETG",
    color: "#112233",
    tray: null,
    remainPct: 70
  });
  assert.equal(parseVtTray({}), null);
  assert.equal(parseVtTray({ vt_tray: {} }), null);
});

// ── bambuTrayUsage ─────────────────────────────────────────────────────────

function tray(overrides: Partial<AmsTraySnapshot> & { tray: number }): AmsTraySnapshot {
  // `=== undefined` checks so an explicit `null` (unknown remain/weight) is
  // respected rather than coalesced back to a default.
  return {
    tray: overrides.tray,
    material: overrides.material ?? "PLA",
    color: overrides.color ?? "#FF0000",
    remainPct: overrides.remainPct === undefined ? null : overrides.remainPct,
    nominalWeightG: overrides.nominalWeightG === undefined ? 1000 : overrides.nominalWeightG,
    active: overrides.active ?? false
  };
}

test("bambuTrayUsage: a single tray's remain drop becomes grams", () => {
  const usage = bambuTrayUsage(
    [tray({ tray: 0, remainPct: 100, nominalWeightG: 1000 })],
    [tray({ tray: 0, remainPct: 85, nominalWeightG: 1000 })]
  );
  assert.equal(usage.length, 1);
  assert.equal(usage[0].tray, 0);
  assert.equal(usage[0].grams, 150); // 15% of 1000 g
});

test("bambuTrayUsage attributes a multi-slot print per tray, ignoring untouched slots", () => {
  const start = [
    tray({ tray: 0, remainPct: 100, nominalWeightG: 1000, material: "PLA", color: "#FF0000" }),
    tray({ tray: 1, remainPct: 60, nominalWeightG: 250, material: "PETG", color: "#00FF00" }),
    tray({ tray: 2, remainPct: 40, nominalWeightG: 1000, material: "ABS" })
  ];
  const end = [
    tray({ tray: 0, remainPct: 88, nominalWeightG: 1000, material: "PLA", color: "#FF0000" }),
    tray({ tray: 1, remainPct: 40, nominalWeightG: 250, material: "PETG", color: "#00FF00" }),
    tray({ tray: 2, remainPct: 40, nominalWeightG: 1000, material: "ABS" }) // untouched
  ];

  const usage = bambuTrayUsage(start, end);
  assert.equal(usage.length, 2, "only the two used slots produce a deduction");
  assert.deepEqual(usage[0], { tray: 0, grams: 120, material: "PLA", color: "#FF0000" });
  assert.deepEqual(usage[1], { tray: 1, grams: 50, material: "PETG", color: "#00FF00" });
});

test("bambuTrayUsage skips trays with unknown remain, unknown weight, or a refill", () => {
  // Unknown remain at start.
  assert.deepEqual(
    bambuTrayUsage([tray({ tray: 0, remainPct: null })], [tray({ tray: 0, remainPct: 50 })]),
    []
  );
  // Unknown nominal weight.
  assert.deepEqual(
    bambuTrayUsage(
      [tray({ tray: 0, remainPct: 100, nominalWeightG: null })],
      [tray({ tray: 0, remainPct: 50, nominalWeightG: null })]
    ),
    []
  );
  // Refilled mid-print (remain went up) → no negative deduction.
  assert.deepEqual(
    bambuTrayUsage([tray({ tray: 0, remainPct: 40 })], [tray({ tray: 0, remainPct: 90 })]),
    []
  );
  // No change → nothing consumed.
  assert.deepEqual(
    bambuTrayUsage([tray({ tray: 0, remainPct: 50 })], [tray({ tray: 0, remainPct: 50 })]),
    []
  );
});

test("bambuTrayUsage returns nothing when either snapshot is missing", () => {
  assert.deepEqual(bambuTrayUsage(null, [tray({ tray: 0, remainPct: 50 })]), []);
  assert.deepEqual(bambuTrayUsage([tray({ tray: 0, remainPct: 50 })], null), []);
  assert.deepEqual(bambuTrayUsage(null, null), []);
});

// ── bambuMeasurableTrayCount ───────────────────────────────────────────────

test("bambuMeasurableTrayCount separates 'no data' from 'measured but zero'", () => {
  const same = [tray({ tray: 0, remainPct: 50 })];
  // Measured, even though the drop is zero → count 1 (a silent no-op, not a warning).
  assert.equal(bambuMeasurableTrayCount(same, same), 1);
  // Genuinely no data: unknown remain, unknown weight, or no snapshot → count 0.
  assert.equal(
    bambuMeasurableTrayCount([tray({ tray: 0, remainPct: null })], [tray({ tray: 0, remainPct: 50 })]),
    0
  );
  assert.equal(
    bambuMeasurableTrayCount(
      [tray({ tray: 0, remainPct: 50, nominalWeightG: null })],
      [tray({ tray: 0, remainPct: 40, nominalWeightG: null })]
    ),
    0
  );
  assert.equal(bambuMeasurableTrayCount(null, same), 0);
});
