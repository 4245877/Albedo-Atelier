import {
  dropAnycubicConnection,
  getAnycubicStatus,
  shutdownAnycubicConnections
} from "../anycubic";
import { capabilitiesOf, requireCapability } from "../capabilities";
import type { PrinterConfig } from "../config";
import {
  dropBambuConnection,
  getBambuStatus,
  sendBambuCommand,
  sendBambuLightCommand,
  shutdownBambuConnections
} from "./bambu";
import { sendBambuStart } from "./bambuStart";
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
 * Bambu local MQTT, Creality WebSocket, Anycubic LAN MQTT) over a shared status
 * mapper. Ported from apps/fulfillment.
 *
 * Every switch below names each protocol it serves; there is no default branch
 * that hands an unrecognised printer to another adapter's code.
 */

export { PrinterCommandError } from "./types";
export type { PrinterCommand, PrinterLiveStatus } from "./types";

export async function getPrinterLiveStatus(printer: PrinterConfig): Promise<PrinterLiveStatus> {
  if (printer.protocol === "moonraker") return getMoonrakerStatus(printer);
  if (printer.protocol === "bambu") return getBambuStatus(printer);
  if (printer.protocol === "creality") return getCrealityStatus(printer);
  if (printer.protocol === "anycubic-lan") return getAnycubicStatus(printer);
  return makeOfflineStatus(printer, `Неподдерживаемый протокол принтера «${String(printer.protocol)}»`);
}

/**
 * Sends a real control command to the device. Supported: Moonraker HTTP
 * (`/printer/print/*`) and Bambu local MQTT (`print.command`). Creality's
 * WebSocket control and Anycubic LAN control are not implemented — that is
 * reported honestly, and nothing is sent.
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
 * adapter — read from the single capability table, never re-derived here.
 * Moonraker exposes a print-start endpoint; Bambu starts an on-card file over
 * local MQTT (`print.project_file` / `print.gcode_file`). Creality control is
 * unimplemented and is reported as unsupported rather than faked.
 */
/** Whether pause/resume/cancel can be sent to this printer at all (see `sendPrinterCommand`). */
export function supportsPrinterControl(printer: PrinterConfig): boolean {
  return printer.protocol === "moonraker" || printer.protocol === "bambu";
}

export function supportsPrinterStart(printer: PrinterConfig): boolean {
  return capabilitiesOf(printer).supportsRemoteStart;
}

/**
 * Starts a print of a file already on the printer, and does **not** return until
 * the device has confirmed the job is running (Bambu) or the endpoint has
 * accepted it (Moonraker). Protocols with no implementation throw a structured
 * {@link PrinterCapabilityError}.
 */
export async function sendPrinterStart(
  printer: PrinterConfig,
  filename: string,
  options: { feed?: Record<string, unknown> | null; plateGcodePath?: string | null } = {}
): Promise<{ confirmed: boolean }> {
  requireCapability(printer, "supportsRemoteStart", "запустите файл на самом принтере");
  if (printer.protocol === "bambu") {
    // The Bambu start does not return until the device's own report names the
    // job as running (see `confirmBambuStart`) — that IS confirmation.
    await sendBambuStart(printer, filename, {
      feed: options.feed ?? null,
      plateGcodePath: options.plateGcodePath ?? null
    });
    return { confirmed: true };
  }
  // Moonraker answering 200 says the request was accepted, nothing more.
  await sendMoonrakerStart(printer, filename);
  return { confirmed: false };
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
 * credentials change and when it is removed from the farm. Bambu and Anycubic
 * keep long-lived clients — Moonraker is request/response and Creality opens a
 * fresh WebSocket per poll, so for those this is correctly a no-op.
 */
export function disconnectPrinter(printerId: string): void {
  dropBambuConnection(printerId);
  dropAnycubicConnection(printerId);
}

/** Closes all persistent device connections (Bambu and Anycubic MQTT sessions, timers). */
export function shutdownPrinterConnections(): void {
  shutdownBambuConnections();
  shutdownAnycubicConnections();
}
