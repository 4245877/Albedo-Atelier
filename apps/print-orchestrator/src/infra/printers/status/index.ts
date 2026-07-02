import type { PrinterConfig } from "../config";
import {
  getBambuStatus,
  sendBambuCommand,
  sendBambuLightCommand,
  shutdownBambuConnections
} from "./bambu";
import { getCrealityStatus } from "./creality";
import { makeOfflineStatus } from "./mapper";
import { getMoonrakerStatus, sendMoonrakerCommand, sendMoonrakerLightCommand } from "./moonraker";
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

export function supportsPrinterLight(printer: PrinterConfig): boolean {
  if (!printer.light.enabled) return false;
  if (printer.protocol === "bambu") return Boolean(printer.light.bambuNode);
  if (printer.protocol === "moonraker") {
    return Boolean(printer.light.onGcode && printer.light.offGcode);
  }
  return false;
}

export async function sendPrinterLight(printer: PrinterConfig, on: boolean): Promise<void> {
  if (!supportsPrinterLight(printer)) {
    throw new PrinterCommandError(
      `Управление подсветкой для протокола «${printer.protocol}» не настроено`
    );
  }
  if (printer.protocol === "moonraker") return sendMoonrakerLightCommand(printer, on);
  if (printer.protocol === "bambu") return sendBambuLightCommand(printer, on);
}

/** Closes all persistent device connections (Bambu MQTT clients, timers). */
export function shutdownPrinterConnections(): void {
  shutdownBambuConnections();
}
