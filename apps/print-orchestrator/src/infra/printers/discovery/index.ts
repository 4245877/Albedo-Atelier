import type { PrinterProtocol } from "../../../domain/printers/config";
import type { EditableSpecField } from "../../../domain/printers/specs";
import type { PrinterConfig } from "../config";
import { discoverBambuFacts } from "./bambu";
import { discoverCrealityFacts } from "./creality";
import { discoverMoonrakerFacts } from "./moonraker";
import { failedDiscovery, type DiscoveryResult } from "./types";

export type { DiscoveryResult } from "./types";

/**
 * Hardware discovery: what each protocol can tell the farm about the machine.
 *
 * The dispatch mirrors `status/index.ts` — one entry point, protocol-keyed, with
 * an honest refusal for anything unsupported instead of a silent empty result.
 * Discovery is strictly read-only: it asks a device to describe itself and never
 * sends a command, so it is safe to run against a printer mid-print.
 */
export async function discoverPrinterSpecs(printer: PrinterConfig): Promise<DiscoveryResult> {
  if (printer.protocol === "moonraker") return discoverMoonrakerFacts(printer);
  if (printer.protocol === "bambu") return discoverBambuFacts(printer);
  if (printer.protocol === "creality") return discoverCrealityFacts(printer);
  return failedDiscovery("Неподдерживаемый протокол принтера");
}

/**
 * Which editable card fields a protocol can fill in by itself.
 *
 * Served to the dashboard through `GET /api/printers/config/options`, so the
 * form can label a field «заполняется автоматически» or «принтер эту
 * характеристику не передаёт» without hard-coding protocol knowledge in the
 * browser — the same reason the credential lists come from the backend.
 *
 * This is the *capability*, not the outcome: a listed field can still end up
 * unknown (a Bambu that has not reported yet, an uncatalogued model). What it
 * promises is that leaving the field empty is a reasonable thing to do.
 */
const AUTO_FIELDS: Record<PrinterProtocol, readonly EditableSpecField[]> = {
  // Klipper publishes its own config: axis limits and nozzle diameter are real
  // readings. It has no notion of a model name or a nozzle type.
  moonraker: ["buildVolume", "nozzleDiameterMm"],
  // Bambu reports the nozzle (diameter and type) and the loaded AMS material;
  // the model comes from its serial, and the bed size from the catalogue entry
  // that model resolves to.
  bambu: ["model", "buildVolume", "nozzleDiameterMm", "nozzleType", "material"],
  // A status heartbeat, not a description API — some firmwares name themselves.
  creality: ["model"]
};

export function autoDiscoveredFields(protocol: PrinterProtocol): readonly EditableSpecField[] {
  return AUTO_FIELDS[protocol] ?? [];
}
