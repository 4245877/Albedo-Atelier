import type { PrintRun } from "../../domain/print/types";
import type { PrinterView } from "../../domain/printers/types";
import type { PrinterConfig } from "../../infra/printers/config";
import type { SchedulerPrinterRef } from "../scheduling/schedulerService";

export interface SchedulerPrintersDeps {
  /** Live printer views (telemetry joined with config) — from the read model. */
  printers: PrinterView[];
  /** Full printer configs (protocol / interchangeability class the view omits). */
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
      // Live telemetry ONLY. The old `?? view.material` fallback promoted the
      // config field — a capability list like "PLA / PETG / TPU" — to a statement
      // about the spool, and `materialsClash` then read its first token as the
      // loaded filament: every PETG job on that printer was refused with
      // «заправлен PLA». An unknown material is now an unknown, which the
      // compatibility rules turn into a confirmable question instead.
      material: view.liveMaterial,
      supportedMaterials: parseSupportedMaterials(view.material),
      nozzleMm: view.nozzleDiameter,
      // Resolved build volume (priority): the device's own axis limits on Klipper,
      // the model catalogue on Bambu, else what the operator declared. The
      // scheduler falls back to the approved machine profile when it is unknown.
      buildVolume: view.buildVolume ?? null,
      online: view.online,
      status: view.status,
      remoteStartSupported: view.remoteStartSupported,
      // Whether the printer has a multi-material unit, as discovered from the
      // device. Was hardcoded null — which made every AMS-requiring task resolve
      // to `ams_unknown` and land in review, even on the A1 Combo whose AMS the
      // service has been reading all along.
      ams: view.ams ?? null,
      // What the device is complaining about, carried separately from what it is
      // doing: an idle printer with an unreadable card is idle and unusable at
      // the same time, and only this field can say the second half.
      faults: view.faults,
      mediaPresent: view.mediaPresent,
      telemetryAgeMs: Number.isFinite(updatedMs) ? Math.max(0, now - updatedMs) : null,
      // Remaining-material telemetry does not exist; the scheduler resolves
      // sufficiency from operator material overrides instead.
      materialRemainingSufficient: null,
      printingTimeLeftMs,
      activeRunState: deps.activeRun(view.id)?.state ?? null
    };
  });
}

/**
 * The declared material list of a printer, split out of the free-text config
 * field operators write as `"PLA / PETG / TPU"`. Context for the operator and
 * for the confirmation prompt — never evidence about what is loaded.
 */
function parseSupportedMaterials(declared: string | null): string[] {
  if (!declared) return [];
  return declared
    .split(/[\/,|+]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
