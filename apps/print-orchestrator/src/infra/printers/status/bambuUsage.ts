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
 * Reads the per-tray AMS snapshot out of a (merged) Bambu `print` payload.
 * Returns null when the device reports no AMS (e.g. printing from the external
 * spool), and skips fully empty slots so only loaded trays are tracked.
 */
export function parseAmsTrays(print: Record<string, unknown>): AmsTraySnapshot[] | null {
  const ams = print.ams;
  if (!isObject(ams) || !Array.isArray(ams.ams)) return null;

  const trayNow = firstText(ams.tray_now);
  const trays: AmsTraySnapshot[] = [];

  for (const unit of ams.ams) {
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

  return trays.length > 0 ? trays : null;
}

/**
 * Reads the external spool (`vt_tray`) as an active-filament candidate: what the
 * A1/P1 feeds from when printing without the AMS. Returns null when there is no
 * `vt_tray` object or it carries no usable material/colour/remain.
 */
export function parseVtTray(print: Record<string, unknown>): ActiveFilament | null {
  const vt = print.vt_tray;
  if (!isObject(vt)) return null;

  const material = firstText(vt.tray_type) || null;
  const color = normalizeTrayColor(vt.tray_color);
  const remainPct = clampPct(firstFiniteNumber(vt.remain));

  if (!material && color === null && remainPct === null) return null;

  return { material, color, tray: null, remainPct };
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
      tray: active.tray,
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
