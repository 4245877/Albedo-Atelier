import type { PrinterConfig } from "../config";
import type { PrinterLiveStatus } from "./types";

/**
 * Protocol-agnostic helpers for turning raw device payloads into a
 * {@link PrinterLiveStatus}. Shared by the Moonraker/Bambu/Creality adapters.
 */

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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
    nozzleTemp: null,
    nozzleTarget: null,
    bedTemp: null,
    bedTarget: null,
    chamberTemp: null,
    stateText: null,
    stateMessage: null,
    error,
    updatedAt: new Date().toISOString()
  };
}

export function estimateRemainingMinutes(
  progressPct: number | null,
  elapsedSec: number | null
): number | null {
  if (!progressPct || progressPct <= 0 || !elapsedSec) return null;
  const totalSec = elapsedSec / (progressPct / 100);
  return Math.round(Math.max(0, totalSec - elapsedSec) / 60);
}
