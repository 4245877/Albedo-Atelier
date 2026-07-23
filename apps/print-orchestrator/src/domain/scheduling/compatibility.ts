/**
 * Task × printer compatibility for the manual scheduler.
 *
 * A pure function ({@link evaluateCompatibility}) that, given already-resolved
 * evidence about one task and one printer, returns exactly one of the three
 * verdicts the brief demands — `compatible`, `review`, `blocked` — with the
 * structured reasons behind it plus the task's {@link EtaEstimate}.
 *
 * Two rules shape the whole module:
 *   - **An unknown *critical* value is `review`, never `compatible`.** Missing
 *     nozzle Ø, unknown loaded material, unreadable model size, stale/absent
 *     telemetry — each downgrades to `review` so a human confirms it rather than
 *     the machine assuming it away.
 *   - **A concrete contradiction is `blocked`.** A pin to another printer, a
 *     model that does not fit, a nozzle/material clash, a quarantined profile set,
 *     a missing slice (or unavailable OrcaSlicer runtime) for un-sliced work, an
 *     unsupported AMS requirement, or a maintenance blocker.
 *
 * No I/O and no throwing — the service layer resolves the evidence (slice
 * variants, profile sets, live telemetry, bed cycles) and this decides.
 */

import type { BedCycleState } from "../print/types";
import { gcodeFlavorFitsProtocol } from "../shared/gcodeFlavor";
import { resolveEta, type EtaEstimate } from "./eta";

export type CompatibilityVerdict = "compatible" | "review" | "blocked";

export interface CompatibilityReason {
  code: string;
  message: string;
}

/** A bounding box / build volume in millimetres. */
export interface Dimensions {
  x: number;
  y: number;
  z: number;
}

export interface CompatibilityTaskInput {
  id: string;
  title: string;
  /** Required material family (operator-stated or from the filament profile); null when unknown. */
  material: string | null;
  /** Hard pin to a printer id, or null when unpinned. */
  pinnedPrinterId: string | null;
  /** Model bounding box in mm, or null when the size could not be read. */
  dimensions: Dimensions | null;
  /** Required nozzle diameter (from slice/profile/analysis) in mm; null when unknown. */
  requiredNozzleMm: number | null;
  /** G-code flavor / firmware the file or machine profile targets; null when unknown. */
  gcodeFlavor: string | null;
  /** Whether the work needs multi-material / AMS mapping. null = unknown. */
  amsRequired: boolean | null;
  /**
   * True when this is un-sliced source (STL / generic 3MF) that needs an approved
   * printer-specific slice before it can print; false for a ready G-code task.
   */
  needsSlicing: boolean;
}

export interface CompatibilityPrinterInput {
  id: string;
  name: string;
  model: string | null;
  /** Transport/firmware family: moonraker | bambu | creality; null when unknown. */
  protocol: string | null;
  /** Loaded material, or null when unknown. */
  material: string | null;
  /** Nozzle diameter in mm, or null when unknown. */
  nozzleMm: number | null;
  /** Build volume in mm, or null when unknown. */
  buildVolume: Dimensions | null;
  online: boolean;
  status: "offline" | "idle" | "printing" | "paused" | "error" | "unknown";
  /** Whether the backend can remote-start the printer (else the operator starts it). */
  remoteStartSupported: boolean;
  /** Whether the printer exposes AMS/multi-material; null when unknown. */
  ams: boolean | null;
}

export interface CompatibilityEvidence {
  /** A ready printer-specific SliceVariant exists for this (task, printer). */
  readySliceVariant: boolean;
  /** The backing ProfileSet is approved. null = no set / unknown. */
  profileSetApproved: boolean | null;
  /** The backing ProfileSet is quarantined / carries blockers. */
  profileSetBlocked: boolean;
  /** OrcaSlicer runtime available (only decisive when needsSlicing && !readySliceVariant). */
  runtimeAvailable: boolean;
  /** Bed occupancy for the printer, or null when unknown. */
  bedCycle: BedCycleState | null;
  /**
   * True when the printer's build volume from its config disagrees with the one
   * read from its approved machine profile — a `review` so a human reconciles them
   * rather than the planner silently trusting one source.
   */
  buildVolumeConflict?: boolean;
  /** Telemetry age in ms, or null when there is no telemetry at all. */
  telemetryAgeMs: number | null;
  /** Maintenance blockers preventing use (empty = none). */
  maintenanceBlockers: string[];
  /** Verified slice ETA (seconds), or null. */
  sliceEtaS: number | null;
  /** G-code-analysis ETA (seconds), or null. */
  gcodeEtaS: number | null;
}

export interface CompatibilityConfig {
  /** Telemetry older than this (ms) is stale → review. */
  telemetryStaleMs: number;
}

export const DEFAULT_COMPATIBILITY_CONFIG: CompatibilityConfig = {
  telemetryStaleMs: 120_000
};

export interface CompatibilityResult {
  taskId: string;
  printerId: string;
  verdict: CompatibilityVerdict;
  blockers: CompatibilityReason[];
  reviews: CompatibilityReason[];
  warnings: CompatibilityReason[];
  eta: EtaEstimate;
}

const NOZZLE_EPS = 0.001;

function approxEqual(a: number, b: number, eps = NOZZLE_EPS): boolean {
  return Math.abs(a - b) <= eps;
}

/** Leading material family token, upper-cased ("PETG-CF Foo" → "PETG"). */
function materialFamily(material: string): string {
  return material.toUpperCase().split(/[\s\-_/,|+]+/).filter(Boolean)[0] ?? "";
}

/** A concrete material contradiction (both known and different families). */
function materialsClash(a: string, b: string): boolean {
  const fa = materialFamily(a);
  const fb = materialFamily(b);
  if (!fa || !fb) return false;
  return !(fa === fb || fa.startsWith(fb) || fb.startsWith(fa));
}


/** True when the model does not fit the build volume on any axis. */
function exceedsVolume(dims: Dimensions, volume: Dimensions): boolean {
  return dims.x > volume.x + 0.01 || dims.y > volume.y + 0.01 || dims.z > volume.z + 0.01;
}

/**
 * Evaluates one task against one printer. Deterministic and side-effect-free:
 * the caller resolves every field of {@link CompatibilityEvidence}; here we only
 * classify.
 */
export function evaluateCompatibility(
  task: CompatibilityTaskInput,
  printer: CompatibilityPrinterInput,
  evidence: CompatibilityEvidence,
  config: CompatibilityConfig = DEFAULT_COMPATIBILITY_CONFIG
): CompatibilityResult {
  const blockers: CompatibilityReason[] = [];
  const reviews: CompatibilityReason[] = [];
  const warnings: CompatibilityReason[] = [];
  const block = (code: string, message: string): void => void blockers.push({ code, message });
  const review = (code: string, message: string): void => void reviews.push({ code, message });
  const warn = (code: string, message: string): void => void warnings.push({ code, message });

  // ── Pin ─────────────────────────────────────────────────────────────────────
  if (task.pinnedPrinterId && task.pinnedPrinterId !== printer.id) {
    block("pinned_elsewhere", `Задание закреплено за другим принтером (${task.pinnedPrinterId})`);
  }

  // ── Maintenance ───────────────────────────────────────────────────────────────
  for (const m of evidence.maintenanceBlockers) {
    block("maintenance", `Обслуживание: ${m}`);
  }

  // ── Printer state & telemetry freshness ──────────────────────────────────────
  if (printer.status === "error") {
    block("printer_error", `Принтер «${printer.name}» в ошибке`);
  } else if (!printer.online) {
    review("printer_offline", `Принтер «${printer.name}» не в сети — готовность не подтверждена`);
  }
  if (evidence.telemetryAgeMs === null) {
    review("telemetry_missing", "Нет телеметрии принтера — состояние неизвестно");
  } else if (evidence.telemetryAgeMs > config.telemetryStaleMs) {
    review(
      "telemetry_stale",
      `Телеметрия устарела (${Math.round(evidence.telemetryAgeMs / 1000)} с назад)`
    );
  }

  // ── Slicing readiness ─────────────────────────────────────────────────────────
  if (task.needsSlicing) {
    if (!evidence.readySliceVariant) {
      if (!evidence.runtimeAvailable) {
        block("slicing_unavailable", "OrcaSlicer runtime недоступен — модель нельзя подготовить");
      } else if (evidence.profileSetBlocked) {
        block("profileset_quarantined", "Набор профилей в карантине (есть блокеры)");
      } else {
        block("slice_missing", "Нет готового слайса под этот принтер");
      }
    } else {
      if (evidence.profileSetBlocked) {
        block("profileset_quarantined", "Набор профилей слайса в карантине");
      } else if (evidence.profileSetApproved === false) {
        review("profileset_unapproved", "Набор профилей слайса не утверждён — нужна проверка");
      } else if (evidence.profileSetApproved === null) {
        review("profileset_unknown", "Не удалось определить набор профилей слайса");
      }
    }
  } else if (evidence.profileSetBlocked) {
    // A ready G-code task whose backing set is quarantined is still suspect.
    block("profileset_quarantined", "Набор профилей в карантине");
  }

  // ── Material ──────────────────────────────────────────────────────────────────
  if (task.material === null) {
    review("task_material_unknown", "Материал задания не задан");
  } else if (printer.material === null) {
    review("printer_material_unknown", `Материал, заправленный в «${printer.name}», неизвестен`);
  } else if (materialsClash(task.material, printer.material)) {
    block(
      "material_mismatch",
      `Материал задания (${task.material}) не совпадает с заправленным (${printer.material})`
    );
  }

  // ── Nozzle ────────────────────────────────────────────────────────────────────
  if (printer.nozzleMm === null) {
    review("printer_nozzle_unknown", `Диаметр сопла «${printer.name}» неизвестен`);
  } else if (task.requiredNozzleMm !== null && !approxEqual(task.requiredNozzleMm, printer.nozzleMm)) {
    block(
      "nozzle_mismatch",
      `Требуется сопло ${task.requiredNozzleMm} мм, у принтера ${printer.nozzleMm} мм`
    );
  }
  if (task.requiredNozzleMm === null && task.needsSlicing) {
    review("task_nozzle_unknown", "Требуемый диаметр сопла не определён");
  }

  // ── Dimensions vs build volume ────────────────────────────────────────────────
  if (evidence.buildVolumeConflict) {
    review(
      "build_volume_conflict",
      `Рабочая область «${printer.name}» из конфигурации расходится с утверждённым профилем`
    );
  }
  if (task.dimensions === null) {
    review("dimensions_unknown", "Размеры модели не определены");
  } else if (printer.buildVolume === null) {
    review("build_volume_unknown", `Рабочая область «${printer.name}» неизвестна`);
  } else if (exceedsVolume(task.dimensions, printer.buildVolume)) {
    block(
      "too_large",
      `Модель ${fmtDims(task.dimensions)} не помещается в область ${fmtDims(printer.buildVolume)}`
    );
  }

  // ── G-code flavor / firmware ──────────────────────────────────────────────────
  if (task.gcodeFlavor && printer.protocol && !gcodeFlavorFitsProtocol(task.gcodeFlavor, printer.protocol)) {
    warn(
      "gcode_flavor_mismatch",
      `G-code flavor «${task.gcodeFlavor}» не типичен для протокола «${printer.protocol}»`
    );
  }

  // ── AMS / extruder mapping ────────────────────────────────────────────────────
  if (task.amsRequired === true) {
    if (printer.ams === false) block("ams_unsupported", "Нужен AMS/мультиматериал, а принтер его не поддерживает");
    else if (printer.ams === null) review("ams_unknown", "Поддержка AMS принтером неизвестна");
  }

  // ── Upload / start capability ─────────────────────────────────────────────────
  if (!printer.remoteStartSupported) {
    warn("manual_start_only", "Удалённый запуск не поддержан — оператор запускает вручную");
  }

  // ── Bed cycle ─────────────────────────────────────────────────────────────────
  switch (evidence.bedCycle) {
    case "AWAITING_CLEARANCE":
      review("bed_awaiting_clearance", "Стол ждёт очистки после прошлой печати");
      break;
    case "UNKNOWN":
      review("bed_unknown", "Состояние стола неизвестно");
      break;
    case "RUNNING":
    case "RESERVED":
      warn("printer_busy", "Принтер сейчас занят — печать после освобождения");
      break;
    default:
      break;
  }

  const verdict: CompatibilityVerdict =
    blockers.length > 0 ? "blocked" : reviews.length > 0 ? "review" : "compatible";

  return {
    taskId: task.id,
    printerId: printer.id,
    verdict,
    blockers,
    reviews,
    warnings,
    eta: resolveEta({ sliceEtaS: evidence.sliceEtaS, gcodeEtaS: evidence.gcodeEtaS })
  };
}

function fmtDims(d: Dimensions): string {
  const r = (n: number): number => Math.round(n * 10) / 10;
  return `${r(d.x)}×${r(d.y)}×${r(d.z)} мм`;
}
