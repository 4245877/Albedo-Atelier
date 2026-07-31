import { capabilitiesOf, requireCapability } from "../capabilities";
import type { PrinterConfig } from "../config";
import {
  dropBambuConnection,
  getBambuStatus,
  sendBambuCommand,
  sendBambuLightCommand,
  shutdownBambuConnections
} from "./bambu";
import { getCrealityStatus } from "./creality";
import { makeOfflineStatus } from "./mapper";
import {
  getMoonrakerStatus,
  sendMoonrakerCommand,
  sendMoonrakerLightCommand,
  sendMoonrakerStart
} from "./moonraker";
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

/**
 * Whether remote start of an on-device file is implemented for this printer's
 * adapter — read from the single capability table, never re-derived here. Only
 * Moonraker exposes a simple, well-defined print-start endpoint; Bambu local
 * start needs a full 3mf/AMS mapping and Creality control is unimplemented, so
 * those are reported as unsupported rather than faked.
 */
export function supportsPrinterStart(printer: PrinterConfig): boolean {
  return capabilitiesOf(printer).supportsRemoteStart;
}

/**
 * Starts a print of a file already on the printer. Supported for Moonraker;
 * other protocols throw a structured {@link PrinterCapabilityError}.
 */
export async function sendPrinterStart(printer: PrinterConfig, filename: string): Promise<void> {
  requireCapability(printer, "supportsRemoteStart", "запустите файл на самом принтере");
  return sendMoonrakerStart(printer, filename);
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

/**
 * Drops any persistent connection held for ONE printer, so the next poll
 * reconnects from the current configuration. Called after its settings or
 * credentials change and when it is removed from the farm. Only Bambu keeps a
 * long-lived client — Moonraker is request/response and Creality opens a fresh
 * WebSocket per poll, so for those this is correctly a no-op.
 */
export function disconnectPrinter(printerId: string): void {
  dropBambuConnection(printerId);
}

/** Closes all persistent device connections (Bambu MQTT clients, timers). */
export function shutdownPrinterConnections(): void {
  shutdownBambuConnections();
}
