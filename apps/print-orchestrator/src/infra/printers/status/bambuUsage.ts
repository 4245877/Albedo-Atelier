import { isObject } from "../../../shared/isObject";
import { firstFiniteNumber, firstText } from "./mapper";
import type { ActiveFilament, AmsTraySnapshot } from "./types";

/**
 * Bambu filament accounting from AMS/AMS-Lite telemetry.
 *
 * Bambu's local MQTT does **not** report extruded length/grams (that lives in
 * the slicer's 3MF metadata). What it does report, per AMS tray, is `remain`
 * (the printer's own 0–100 % estimate of filament left, driven by an extrusion
 * odometer / RFID) and `tray_weight` (the nominal spool weight). So the honest,
 * MQTT-native figure for a completed print is the drop in `remain` across the
 * job, per tray, times the nominal weight — which naturally covers multi-colour
 * A1 Combo prints that pull from several slots.
 *
 * This is an estimate quantised to 1 %: on a 1 kg spool that is ~10 g, on a
 * 250 g AMS-Lite spool ~2.5 g, so tiny prints can round to zero. When a tray's
 * `remain` is unknown (`-1`, uncalibrated) there is simply no data and we
 * deduct nothing rather than invent a number. For exact per-filament grams the
 * upgrade path is the sliced 3MF `Metadata/slice_info.config` (`used_g`/`used_m`
 * per filament), fetched over the printer's FTPS — pluggable behind the same
 * "usage → consume items" seam in the poller.
 */

/**
 * The slot index Bambu itself uses for the **external spool** — the filament
 * path an A1/P1 feeds from when it is not printing through the AMS.
 *
 * 254 is the vendor's own number: it is what `ams.tray_now` reports while the
 * external spool is feeding, and what `ams_mapping` expects for "not an AMS
 * slot". It cannot collide with a real tray, whose index is `unit*4 + id` and
 * so tops out at 15 for the four AMS units the protocol allows.
 *
 * Treating the external spool as a tray is the whole fix for a hole that ran the
 * length of the chain: `parseAmsTrays` returned `null` for a printer with no
 * AMS, so an external-spool print produced no baseline snapshot, no consumption
 * measurement, and no reel binding for the loaded filament. This farm's A1 Combo
 * reports zero AMS units and feeds externally, which means every print it has
 * ever run took that path.
 */
export const EXTERNAL_SPOOL_TRAY = 254;

/** One tray's measured consumption for a finished print. */
export interface BambuTrayUsage {
  /** Global tray index (matches {@link AmsTraySnapshot.tray}). */
  tray: number;
  /** Grams consumed from this tray (remain-drop × nominal spool weight). */
  grams: number;
  material: string | null;
  color: string | null;
}

/**
 * Normalises a Bambu `tray_color` (`RRGGBBAA`, no `#`) to `#RRGGBB`. Returns
 * null for an empty/unset slot: an all-zero value, a blank string, or a fully
 * transparent colour (alpha `00`) — while keeping opaque black (`000000FF`).
 */
export function normalizeTrayColor(raw: unknown): string | null {
  const text = firstText(raw).replace(/^#/, "");
  const match = /^([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(text);
  if (!match) return null;
  const alpha = match[2];
  if (alpha && alpha.toLowerCase() === "00") return null;
  return `#${match[1].toUpperCase()}`;
}

function clampPct(value: number | null): number | null {
  if (value === null || value < 0) return null;
  return Math.max(0, Math.min(100, value));
}

/**
 * Reads the **loaded reels** out of a (merged) Bambu `print` payload: every AMS
 * tray, plus the external spool as {@link EXTERNAL_SPOOL_TRAY}.
 *
 * Returns null only when the device reports neither — not merely when it has no
 * AMS. Empty slots are skipped, so the list is what is actually loaded.
 */
export function parseAmsTrays(print: Record<string, unknown>): AmsTraySnapshot[] | null {
  const ams = print.ams;
  const trayNow = isObject(ams) ? firstText(ams.tray_now) : "";
  const trays: AmsTraySnapshot[] = [];

  for (const unit of isObject(ams) && Array.isArray(ams.ams) ? ams.ams : []) {
    if (!isObject(unit) || !Array.isArray(unit.tray)) continue;
    const unitId = firstFiniteNumber(unit.id) ?? 0;

    for (const raw of unit.tray) {
      if (!isObject(raw)) continue;
      const trayId = firstFiniteNumber(raw.id);
      if (trayId === null) continue;

      const material = firstText(raw.tray_type) || null;
      const color = normalizeTrayColor(raw.tray_color);
      const remainPct = clampPct(firstFiniteNumber(raw.remain));
      const weight = firstFiniteNumber(raw.tray_weight);
      const nominalWeightG = weight !== null && weight > 0 ? weight : null;

      // Skip a genuinely empty slot: no material, no remaining %, no weight.
      if (!material && remainPct === null && nominalWeightG === null) continue;

      const tray = unitId * 4 + trayId;
      trays.push({
        tray,
        material,
        color,
        remainPct,
        nominalWeightG,
        active: trayNow !== "" && Number(trayNow) === tray
      });
    }
  }

  const external = parseExternalSpoolTray(print, trayNow);
  if (external) trays.push(external);

  return trays.length > 0 ? trays : null;
}

/**
 * The external spool (`vt_tray`) as a tray snapshot, so every rule that already
 * knows how to measure and bind a tray applies to it unchanged — the remain-drop
 * consumption, the measurable-tray count, and the loaded-reel sync.
 *
 * `tray_weight` is usually absent on a non-RFID spool, which leaves
 * `nominalWeightG` null and therefore leaves the spool *unmeasurable*. That is
 * the honest outcome, and it is what the unreconciled-debt path exists for: an
 * estimate is not a measurement, and this must never manufacture one.
 */
export function parseExternalSpoolTray(
  print: Record<string, unknown>,
  trayNow: string
): AmsTraySnapshot | null {
  const vt = print.vt_tray;
  if (!isObject(vt)) return null;

  const material = firstText(vt.tray_type) || null;
  const color = normalizeTrayColor(vt.tray_color);
  const remainPct = clampPct(firstFiniteNumber(vt.remain));
  const weight = firstFiniteNumber(vt.tray_weight);
  const nominalWeightG = weight !== null && weight > 0 ? weight : null;

  if (!material && color === null && remainPct === null && nominalWeightG === null) return null;

  return {
    tray: EXTERNAL_SPOOL_TRAY,
    material,
    color,
    remainPct,
    nominalWeightG,
    // A printer with no AMS at all reports no `tray_now`; the external spool is
    // then the only path there is, so it is what is feeding.
    active: trayNow === "" || Number(trayNow) === EXTERNAL_SPOOL_TRAY
  };
}

/**
 * Reads the external spool as an active-filament candidate. Kept as its own
 * entry point for the display path, which reports an AMS *slot* number and must
 * not present 254 as one.
 */
export function parseVtTray(print: Record<string, unknown>): ActiveFilament | null {
  const tray = parseExternalSpoolTray(print, "");
  if (!tray) return null;
  return { material: tray.material, color: tray.color, tray: null, remainPct: tray.remainPct };
}

/**
 * The filament the printer is currently feeding from. Prefers the active AMS
 * tray (`ams.tray_now`); with no active tray it falls back to the external spool
 * (`vt_tray`). Returns null when the device reports neither — the caller then
 * falls back to the configured material rather than inventing one.
 */
export function resolveActiveFilament(
  print: Record<string, unknown>,
  trays: AmsTraySnapshot[] | null
): ActiveFilament | null {
  const active = trays?.find((tray) => tray.active) ?? null;
  if (active) {
    return {
      material: active.material,
      color: active.color,
      // The external spool is a tray for accounting, but it is not an AMS slot,
      // and showing "лоток 254" to an operator would be nonsense.
      tray: active.tray === EXTERNAL_SPOOL_TRAY ? null : active.tray,
      remainPct: active.remainPct
    };
  }

  return parseVtTray(print);
}

/**
 * How many trays could actually be measured — present at both start and end
 * with a known `remain` and nominal weight. Zero means there was no usable data
 * at all (uncalibrated trays, or no start snapshot), which is distinct from
 * "measured, but the print was too small to move the 1 % `remain`": the former
 * warrants an operator warning, the latter is a silent no-op.
 */
export function bambuMeasurableTrayCount(
  start: AmsTraySnapshot[] | null,
  end: AmsTraySnapshot[] | null
): number {
  if (!start || !end) return 0;

  const startByTray = new Map(start.map((tray) => [tray.tray, tray]));
  let count = 0;

  for (const endTray of end) {
    const startTray = startByTray.get(endTray.tray);
    if (!startTray) continue;
    const weight = startTray.nominalWeightG ?? endTray.nominalWeightG;
    if (startTray.remainPct !== null && endTray.remainPct !== null && weight !== null) {
      count += 1;
    }
  }

  return count;
}

/**
 * Attributes a finished print's filament to trays: for each tray present at
 * both start and end with a known `remain` and nominal weight, the positive
 * drop in `remain` becomes grams. Trays that were not used (no drop), refilled
 * mid-print (remain went up), or lack data are omitted, so the result is only
 * the slots this print actually consumed from. Empty when nothing is known.
 */
export function bambuTrayUsage(
  start: AmsTraySnapshot[] | null,
  end: AmsTraySnapshot[] | null
): BambuTrayUsage[] {
  if (!start || !end) return [];

  const startByTray = new Map(start.map((tray) => [tray.tray, tray]));
  const usage: BambuTrayUsage[] = [];

  for (const endTray of end) {
    const startTray = startByTray.get(endTray.tray);
    if (!startTray) continue;

    const weight = startTray.nominalWeightG ?? endTray.nominalWeightG;
    if (startTray.remainPct === null || endTray.remainPct === null || weight === null) {
      continue;
    }

    const droppedPct = startTray.remainPct - endTray.remainPct;
    if (droppedPct <= 0) continue;

    const grams = Math.round((droppedPct / 100) * weight * 100) / 100;
    if (grams <= 0) continue;

    usage.push({
      tray: endTray.tray,
      grams,
      material: endTray.material ?? startTray.material,
      color: endTray.color ?? startTray.color
    });
  }

  return usage;
}
