import type { PrintRun } from "../../domain/print/types";
import type { PrinterView } from "../../domain/printers/types";
import type { PrinterConfig } from "../../infra/printers/config";
import type { SchedulerPrinterRef } from "../scheduling/schedulerService";

export interface SchedulerPrintersDeps {
  /** Live printer views (telemetry joined with config) — from the read model. */
  printers: PrinterView[];
  /** Full printer configs (protocol / class / build-volume the view omits). */
  configs: PrinterConfig[];
  /**
   * The canonical run holding a printer, from the same authoritative query the
   * dispatch path uses. Telemetry `status` alone is not enough: a PENDING
   * reservation or a fail-closed UNKNOWN run holds the printer while the device
   * may still read idle, and the scheduler must not plan onto it.
   */
  activeRun: (printerId: string) => PrintRun | null;
  /** Injectable clock for telemetry-age arithmetic; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Joins the live printer telemetry + config into the shape the scheduler needs.
 * Read-only: explicit inputs, no repositories created, no background work, no
 * mutation. Extracted verbatim from the former `FarmStore.schedulerPrinters`.
 */
export function buildSchedulerPrinters(deps: SchedulerPrintersDeps): SchedulerPrinterRef[] {
  const now = deps.now ? deps.now() : Date.now();
  return deps.printers.map((view) => {
    const config = deps.configs.find((c) => c.id === view.id) ?? null;
    const updatedMs = view.updatedAt ? Date.parse(view.updatedAt) : NaN;
    // Remaining print time is only meaningful while the device reports printing.
    const printing = view.status === "printing" || view.status === "paused";
    const printingTimeLeftMs =
      printing && view.minutesLeft !== null ? Math.max(0, view.minutesLeft) * 60_000 : null;
    return {
      id: view.id,
      name: view.name,
      model: view.model,
      protocol: config?.protocol ?? null,
      printerClass: config?.printerClass ?? null,
      material: view.liveMaterial ?? view.material,
      nozzleMm: view.nozzleDiameter,
      // Explicit config build volume (priority); the scheduler otherwise reads the
      // approved machine profile bound to this printer.
      buildVolume: config?.buildVolume ?? null,
      online: view.online,
      status: view.status,
      remoteStartSupported: view.remoteStartSupported,
      ams: null,
      telemetryAgeMs: Number.isFinite(updatedMs) ? Math.max(0, now - updatedMs) : null,
      // Remaining-material telemetry does not exist; the scheduler resolves
      // sufficiency from operator material overrides instead.
      materialRemainingSufficient: null,
      printingTimeLeftMs,
      activeRunState: deps.activeRun(view.id)?.state ?? null
    };
  });
}
