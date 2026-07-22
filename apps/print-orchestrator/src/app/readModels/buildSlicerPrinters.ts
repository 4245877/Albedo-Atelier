import type { PrinterConfig } from "../../infra/printers/config";
import type { SlicerPrinterRef } from "../slicing/profileService";

/**
 * Projects the farm printers into the shape the slicing compatibility checks
 * use. Pure: a function of the config list only — no telemetry, no
 * repositories, no side effects. Extracted verbatim from the former
 * `FarmStore.slicerPrinters` so the slicing profile/slice services keep seeing
 * the identical projection.
 */
export function buildSlicerPrinters(configs: PrinterConfig[]): SlicerPrinterRef[] {
  return configs.map((c) => ({
    id: c.id,
    name: c.name,
    model: c.model ?? null,
    material: c.material ?? null,
    protocol: c.protocol ?? null,
    nozzleMm: c.nozzleDiameterMm ?? null,
    printerClass: c.printerClass ?? null
  }));
}
