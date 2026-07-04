import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bambuMeasurableTrayCount,
  bambuTrayUsage,
  normalizeTrayColor,
  parseAmsTrays
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

test("parseAmsTrays returns null when there is no AMS or no loaded trays", () => {
  assert.equal(parseAmsTrays({}), null);
  assert.equal(parseAmsTrays({ ams: { ams: [] } }), null);
  assert.equal(parseAmsTrays({ ams: { ams: [{ id: "0", tray: [{ id: "0" }] }] } }), null);
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
