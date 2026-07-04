import WebSocket from "ws";

import type { PrinterConfig } from "../config";
import { firstFiniteNumber, firstText, makeOfflineStatus, roundOrNull, toFiniteNumber } from "./mapper";
import type { PrinterLiveStatus } from "./types";

const CREALITY_TIMEOUT_MS = 2500;

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

        finish({
          id: printer.id,
          online: true,
          status: mappedStatus,
          currentFile: firstText(parsed.printFileName) || null,
          progressPct: roundOrNull(progress),
          remainingMinutes: leftSec === null ? null : Math.round(leftSec / 60),
          // Creality WS status carries no filament grams/length.
          filamentUsedMm: null,
          amsTrays: null,
          nozzleTemp: roundOrNull(toFiniteNumber(parsed.nozzleTemp)),
          nozzleTarget: roundOrNull(firstFiniteNumber(parsed.targetNozzleTemp, parsed.nozzleTempTarget)),
          bedTemp: roundOrNull(toFiniteNumber(parsed.bedTemp0)),
          bedTarget: roundOrNull(firstFiniteNumber(parsed.targetBedTemp0, parsed.bedTemp0Target)),
          chamberTemp: null,
          light: null,
          stateText: firstText(parsed.state) || null,
          stateMessage,
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
