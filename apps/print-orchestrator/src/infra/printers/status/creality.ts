import WebSocket from "ws";

import type { PrinterConfig } from "../config";
import { firstFiniteNumber, firstText, makeOfflineStatus, roundOrNull, toFiniteNumber } from "./mapper";
import type { PrinterLiveStatus } from "./types";

const CREALITY_TIMEOUT_MS = 2500;

/**
 * Filament extruded so far this print, in mm, from a Creality WebSocket
 * heartbeat frame.
 *
 * The adapter used to hardcode `null` here with the comment "Creality WS status
 * carries no filament grams/length". That is not true of this protocol family:
 * the K1/Ender-3 V3 KE heartbeat reports a running extrusion odometer, and
 * because it was read as `null` the Ender's filament was NEVER deducted and
 * NEVER even measurable — every completed print on it silently became an
 * unreconciled debt.
 *
 * Field naming is not uniform across firmware revisions, so a small set of
 * candidates is tried, longest-standing first. Nothing is inferred: an absent,
 * non-numeric or negative reading stays `null`, which the consumption layer
 * reads as "there was nothing to measure" (a debt) rather than as a measured
 * zero. Exported so the mapping can be tested against captured frames without a
 * device — this farm's Ender is offline, so the candidate list is deliberately
 * conservative rather than exhaustive.
 */
export function parseCrealityUsedFilamentMm(frame: Record<string, unknown>): number | null {
  const used = firstFiniteNumber(
    frame.usedMaterialLength,
    frame.usedMaterialLength0,
    frame.consumedFilament
  );
  return used !== null && used >= 0 ? used : null;
}

/**
 * The material the machine says is loaded, when the heartbeat names one.
 *
 * Kept separate from {@link parseCrealityUsedFilamentMm} because the two answer
 * different questions and the firmware may report one without the other. `-1`
 * and `unknown` are the protocol's own "no value" markers (the same convention
 * the CFS uses) and must not become a material name — binding a warehouse reel
 * to the string "-1" would deduct from a position nobody meant.
 */
export function parseCrealityMaterial(frame: Record<string, unknown>): string | null {
  const raw = firstText(frame.materialType, frame.consumableName, frame.filamentType).trim();
  if (!raw || raw === "-1" || raw.toLowerCase() === "unknown" || raw.toLowerCase() === "none") {
    return null;
  }
  return raw;
}

function normalizeCrealityState(state: unknown): PrinterLiveStatus["status"] {
  const value = String(state ?? "").toLowerCase();

  if (value === "1" || value.includes("print")) return "printing";
  if (value === "5" || value.includes("pause")) return "paused";
  if (value === "0" || value.includes("stop") || value.includes("idle")) return "idle";
  if (value.includes("error") || value.includes("fail")) return "error";

  return "unknown";
}

export function getCrealityStatus(printer: PrinterConfig): Promise<PrinterLiveStatus> {
  const url = `ws://${printer.host}:${printer.port ?? 9999}`;

  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    let settled = false;

    const finish = (status: PrinterLiveStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws?.close();
      } catch {
        // ignore
      }
      resolve(status);
    };

    const timeout = setTimeout(() => {
      finish(makeOfflineStatus(printer, "Creality WebSocket: таймаут"));
    }, CREALITY_TIMEOUT_MS);

    try {
      ws = new WebSocket(url);
    } catch (err) {
      finish(makeOfflineStatus(printer, err instanceof Error ? err.message : String(err)));
      return;
    }

    ws.on("open", () => {
      try {
        ws?.send(JSON.stringify({ ModeCode: "heart_beat", msg: new Date().toISOString() }));
      } catch {
        // ignore
      }
    });

    ws.on("message", (data) => {
      try {
        const raw = data.toString();
        if (!raw || raw === "ok") return;

        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const progress = toFiniteNumber(parsed.printProgress);
        const mappedStatus = normalizeCrealityState(parsed.state);
        const stateMessage = firstText(parsed.err, parsed.errorMsg) || null;
        const leftSec = toFiniteNumber(parsed.printLeftTime);
        const crealityMaterial = parseCrealityMaterial(parsed);

        finish({
          id: printer.id,
          online: true,
          status: mappedStatus,
          currentFile: firstText(parsed.printFileName) || null,
          progressPct: roundOrNull(progress),
          remainingMinutes: leftSec === null ? null : Math.round(leftSec / 60),
          // The heartbeat's extrusion odometer when this firmware sends one;
          // null (→ an unreconciled debt, never a silent zero) when it does not.
          filamentUsedMm: parseCrealityUsedFilamentMm(parsed),
          // The heartbeat carries no slicer weight estimate.
          slicerFilamentG: null,
          amsTrays: null,
          // Creality WS status exposes no nozzle diameter.
          nozzleDiameterMm: null,
          nozzleType: null,
          activeFilament: crealityMaterial
            ? { material: crealityMaterial, color: null, tray: null, remainPct: null }
            : null,
          nozzleTemp: roundOrNull(toFiniteNumber(parsed.nozzleTemp)),
          nozzleTarget: roundOrNull(firstFiniteNumber(parsed.targetNozzleTemp, parsed.nozzleTempTarget)),
          bedTemp: roundOrNull(toFiniteNumber(parsed.bedTemp0)),
          bedTarget: roundOrNull(firstFiniteNumber(parsed.targetBedTemp0, parsed.bedTemp0Target)),
          chamberTemp: null,
          light: null,
          stateText: firstText(parsed.state) || null,
          stateMessage,
          // The Creality WebSocket carries an error *string*, already surfaced as
          // `stateMessage`; there is no coded fault register to decode.
          faults: [],
          mediaPresent: null,
          error: mappedStatus === "error" ? stateMessage || "Принтер сообщил об ошибке" : null,
          updatedAt: new Date().toISOString()
        });
      } catch (err) {
        finish(makeOfflineStatus(printer, err instanceof Error ? err.message : String(err)));
      }
    });

    ws.on("error", () => {
      finish(makeOfflineStatus(printer, "Creality WebSocket: ошибка соединения"));
    });

    ws.on("close", () => {
      if (!settled) {
        finish(makeOfflineStatus(printer, "Creality WebSocket: соединение закрыто"));
      }
    });
  });
}
