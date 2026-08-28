import type { PrinterConfig } from "../config";
import type { PrinterLiveStatus } from "./types";

/**
 * Protocol-agnostic helpers for turning raw device payloads into a
 * {@link PrinterLiveStatus}. Shared by the Moonraker/Bambu/Creality adapters.
 * (`isObject` lives in `shared/isObject` — the same guard the config and
 * persisted-state loaders use.)
 */

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.trim().replace(",", ".");
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const numberValue = toFiniteNumber(value);
    if (numberValue !== null) return numberValue;
  }
  return null;
}

export function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

export function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

export function toStatusState(value: unknown): PrinterLiveStatus["status"] {
  const state = String(value ?? "").toLowerCase();

  if (["printing", "running", "prepare", "preparing", "heating"].includes(state)) {
    return "printing";
  }
  if (["paused", "pause", "pausing"].includes(state)) return "paused";
  // `cancel`/`cancelled` land in "idle": an aborted print is not an error state.
  if (
    ["complete", "standby", "idle", "finished", "finish", "cancel", "cancelled", "canceled"].includes(
      state
    )
  ) {
    return "idle";
  }
  if (["error", "failed", "failure"].includes(state)) return "error";

  return "unknown";
}

export function makeOfflineStatus(printer: PrinterConfig, error: string): PrinterLiveStatus {
  return {
    id: printer.id,
    online: false,
    status: "offline",
    currentFile: null,
    progressPct: null,
    remainingMinutes: null,
    filamentUsedMm: null,
    amsTrays: null,
    nozzleDiameterMm: null,
    nozzleType: null,
    activeFilament: null,
    nozzleTemp: null,
    nozzleTarget: null,
    bedTemp: null,
    bedTarget: null,
    chamberTemp: null,
    light: null,
    stateText: null,
    stateMessage: null,
    // An unreachable printer is not a printer with no faults — it is a printer
    // we cannot ask. Empty here means "nothing observed", and every consumer
    // treats it that way rather than as a clean bill of health.
    faults: [],
    mediaPresent: null,
    error,
    updatedAt: new Date().toISOString()
  };
}

/**
 * Below this, progress is too small a sample to extrapolate from: at 1 % a
 * two-second timing wobble scales into hours. Reported as unknown instead.
 */
const MIN_EXTRAPOLATION_PCT = 2;

/**
 * **How much longer?** — one precedence, for every adapter.
 *
 * The sources are not equally good, and the order below is the whole rule:
 *
 *  1. **The device's own countdown** (`mc_remaining_time` on Bambu, `leftSec` on
 *     Creality). The firmware is running the job and knows what is left.
 *  2. **The slicer's estimate for this exact file**, minus time already spent.
 *     Moonraker/Klipper has no countdown of its own, but the sliced file carries
 *     `estimated_time`, computed from the real toolpath with acceleration —
 *     a far better statement about a non-uniform model than anything derivable
 *     from progress.
 *  3. **Linear extrapolation from progress**, and only as a last resort.
 *
 * Why (3) was wrong as Moonraker's primary source: its `progress` is
 * `virtual_sdcard` **file position**, not time. A model that is a wide base
 * under a tall thin spire spends most of its bytes on the base and most of its
 * hours on the spire, so the extrapolation reports "80 % done, 20 minutes left"
 * for another two hours — and that number is what the night-window fit, the
 * operator's plan and the release projection are built on.
 *
 * Every source is bounded at zero and returns null rather than guessing.
 */
export function resolveRemainingMinutes(input: {
  /** A remaining time the device itself reports, in seconds. */
  reportedRemainingSec: number | null;
  /** The slicer's total estimate for the loaded file, in seconds. */
  slicerTotalSec: number | null;
  /** Seconds spent printing so far. */
  elapsedSec: number | null;
  /** Completion 0–100, however the adapter measures it. */
  progressPct: number | null;
}): number | null {
  const { reportedRemainingSec, slicerTotalSec, elapsedSec, progressPct } = input;

  if (
    reportedRemainingSec !== null &&
    Number.isFinite(reportedRemainingSec) &&
    reportedRemainingSec >= 0
  ) {
    return Math.round(reportedRemainingSec / 60);
  }

  if (
    slicerTotalSec !== null &&
    Number.isFinite(slicerTotalSec) &&
    slicerTotalSec > 0 &&
    elapsedSec !== null &&
    Number.isFinite(elapsedSec) &&
    elapsedSec >= 0 &&
    // An estimate the print has already outlived says nothing about the rest of
    // it. Reporting the 0 it arithmetically gives would claim the job ends now,
    // so the extrapolation below is used instead.
    slicerTotalSec > elapsedSec
  ) {
    return Math.round((slicerTotalSec - elapsedSec) / 60);
  }

  return extrapolateRemainingMinutes(progressPct, elapsedSec);
}

/**
 * The last-resort estimate: assumes the remaining file takes as long per unit of
 * progress as the part already done. Null below {@link MIN_EXTRAPOLATION_PCT},
 * where the sample is too small to mean anything.
 */
export function extrapolateRemainingMinutes(
  progressPct: number | null,
  elapsedSec: number | null
): number | null {
  if (progressPct === null || !Number.isFinite(progressPct) || progressPct < MIN_EXTRAPOLATION_PCT) {
    return null;
  }
  if (elapsedSec === null || !Number.isFinite(elapsedSec) || elapsedSec <= 0) return null;
  const totalSec = elapsedSec / (progressPct / 100);
  return Math.round(Math.max(0, totalSec - elapsedSec) / 60);
}
