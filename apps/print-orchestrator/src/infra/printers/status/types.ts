/**
 * One AMS/AMS-Lite tray as the device reports it (Bambu). Used to attribute a
 * completed print's filament to the right slot(s). `remainPct` is the printer's
 * own remaining estimate (odometer/RFID based); the drop across a print, times
 * `nominalWeightG`, is what we deduct. Anything the device leaves unknown is
 * `null` — never invented.
 */
export interface AmsTraySnapshot {
  /** Global tray index (`amsUnit*4 + trayId`); A1 Combo's single AMS Lite is 0..3. */
  tray: number;
  /** Loaded material, from `tray_type` (e.g. "PLA"); null when the slot is empty. */
  material: string | null;
  /** `#RRGGBB` from `tray_color` (alpha dropped); null when unset/empty. */
  color: string | null;
  /** Remaining filament 0..100, or null when the device does not know it (`-1`). */
  remainPct: number | null;
  /** Nominal spool weight in grams (`tray_weight`); null/≤0 when unknown. */
  nominalWeightG: number | null;
  /** Whether this is the tray the printer is currently feeding (`tray_now`). */
  active: boolean;
}

/**
 * Live telemetry for one printer, straight from the device. Adapted from
 * apps/fulfillment (`modules/printers/routes.ts`), extended with temperature
 * targets and chamber readings where the device reports them. Every field that
 * a device does not report stays `null` — nothing here is ever invented.
 */
export interface PrinterLiveStatus {
  id: string;
  online: boolean;
  status: "idle" | "printing" | "paused" | "error" | "offline" | "unknown";
  currentFile: string | null;
  progressPct: number | null;
  remainingMinutes: number | null;
  /**
   * Filament extruded so far this print, in mm (Klipper `print_stats.filament_used`).
   * `null` when the device/adapter does not report it (Bambu, Creality, offline).
   */
  filamentUsedMm: number | null;
  /**
   * AMS/AMS-Lite tray state (Bambu), or `null` when the device/adapter has no
   * AMS (Moonraker, Creality, offline). Snapshotted at print start and compared
   * at completion to attribute filament per slot.
   */
  amsTrays: AmsTraySnapshot[] | null;
  nozzleTemp: number | null;
  nozzleTarget: number | null;
  bedTemp: number | null;
  bedTarget: number | null;
  chamberTemp: number | null;
  /** Chamber/work-area light state; null when the device or adapter cannot report it. */
  light: boolean | null;
  /** Raw device state string (e.g. moonraker "complete"/"cancelled"). */
  stateText: string | null;
  /** Human-readable reason (pause reason, error text) when the device gives one. */
  stateMessage: string | null;
  error: string | null;
  updatedAt: string;
}

export type PrinterCommand = "pause" | "resume" | "cancel";

export class PrinterCommandError extends Error {}
