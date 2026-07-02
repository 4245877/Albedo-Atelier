import type { PrinterConfig } from "../config";
import { getBambuStatus, sendBambuCommand, shutdownBambuConnections } from "./bambu";
import { getCrealityStatus } from "./creality";
import { makeOfflineStatus } from "./mapper";
import { getMoonrakerStatus, sendMoonrakerCommand } from "./moonraker";
import { PrinterCommandError, type PrinterCommand, type PrinterLiveStatus } from "./types";

/**
 * Live printer telemetry and control, one adapter per protocol (Moonraker HTTP,
 * Bambu local MQTT, Creality WebSocket) over a shared status mapper. Ported from
 * apps/fulfillment.
 */

export { PrinterCommandError } from "./types";
export type { PrinterCommand, PrinterLiveStatus } from "./types";

export async function getPrinterLiveStatus(printer: PrinterConfig): Promise<PrinterLiveStatus> {
  if (printer.protocol === "moonraker") return getMoonrakerStatus(printer);
  if (printer.protocol === "bambu") return getBambuStatus(printer);
  if (printer.protocol === "creality") return getCrealityStatus(printer);
  return makeOfflineStatus(printer, "Неподдерживаемый протокол принтера");
}

/**
 * Sends a real control command to the device. Supported: Moonraker HTTP
 * (`/printer/print/*`) and Bambu local MQTT (`print.command`). Creality's
 * WebSocket control protocol is not implemented — that is reported honestly.
 */
export async function sendPrinterCommand(
  printer: PrinterConfig,
  command: PrinterCommand
): Promise<void> {
  if (printer.protocol === "moonraker") return sendMoonrakerCommand(printer, command);
  if (printer.protocol === "bambu") return sendBambuCommand(printer, command);
  throw new PrinterCommandError(
    `Управление печатью для протокола «${printer.protocol}» пока не поддерживается`
  );
}

/** Closes all persistent device connections (Bambu MQTT clients, timers). */
export function shutdownPrinterConnections(): void {
  shutdownBambuConnections();
}
