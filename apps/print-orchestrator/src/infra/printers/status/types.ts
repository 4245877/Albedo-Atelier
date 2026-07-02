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
