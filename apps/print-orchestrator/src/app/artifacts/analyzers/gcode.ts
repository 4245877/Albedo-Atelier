import fs from "node:fs";
import readline from "node:readline";

import type { AnalysisFinding, AnalysisVerdict } from "../../../domain/print/types";
import {
  ANALYZER_VERSION,
  escalateToReview,
  finding,
  worstVerdict,
  type AnalyzerResult
} from "./types";

/**
 * Streaming G-code analysis. The file is read line by line (constant memory —
 * never slurped whole and never executed) and yields, best-effort: slicer +
 * version, estimated time, material and usage, layer height, nozzle diameter,
 * temperatures, tool count, firmware flavor, target printer, and a toolpath
 * bounding box.
 *
 * The bounding box is computed from the motion commands while honouring the
 * coordinate model — absolute/relative positioning (G90/G91), absolute/relative
 * extrusion (M82/M83), the coordinate-reset G92, and inch/millimetre units
 * (G20/G21). It does not emulate firmware; arcs and other constructs it cannot
 * follow lower a reported confidence and add a warning rather than pretend.
 *
 * A recognised slicer + known target + material with no critical command yields
 * `schedulable` (fit for *planning*, not an unattended auto-start). An unknown
 * target, unknown slicer, risky command, or low bbox confidence forces at least
 * `review` — third-party G-code is never assumed safe for the night queue.
 */

const INCH = 25.4;
/** Firmware-config-mutating or cold-extrusion commands that warrant a human look. */
const RISKY_COMMANDS = new Set(["M500", "M502", "M302", "M501"]);

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface Bounds {
  min: Vec3;
  max: Vec3;
  any: boolean;
}

export async function analyzeGcode(path: string): Promise<AnalyzerResult> {
  const warnings: AnalysisFinding[] = [];
  const blockers: AnalysisFinding[] = [];

  // Coordinate state (firmware defaults).
  let absolutePos = true;
  let unitScale = 1; // mm; G20 → 25.4
  const pos: Vec3 = { x: 0, y: 0, z: 0 };
  const originOffset: Vec3 = { x: 0, y: 0, z: 0 };
  const bounds: Bounds = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
    any: false
  };

  let motionCommands = 0;
  let hasArcs = false;
  let hasRelativeMoves = false;
  let usedInches = false;
  const tools = new Set<number>();
  const riskyFound = new Set<string>();

  // Extracted metadata (null until a line supplies it).
  const meta: {
    slicer: string | null;
    slicerVersion: string | null;
    flavor: string | null;
    printerModel: string | null;
    material: string | null;
    layerHeightMm: number | null;
    nozzleDiameterMm: number | null;
    nozzleTempC: number | null;
    bedTempC: number | null;
    estimatedDurationS: number | null;
    filamentUsedMm: number | null;
    filamentUsedG: number | null;
  } = {
    slicer: null,
    slicerVersion: null,
    flavor: null,
    printerModel: null,
    material: null,
    layerHeightMm: null,
    nozzleDiameterMm: null,
    nozzleTempC: null,
    bedTempC: null,
    estimatedDurationS: null,
    filamentUsedMm: null,
    filamentUsedG: null
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (line.length === 0) continue;

      if (line.startsWith(";")) {
        extractComment(line, meta);
        continue;
      }

      // Strip an inline comment, then read the command word.
      const code = line.split(";", 1)[0].trim();
      if (code.length === 0) continue;
      const word = code.split(/\s+/)[0].toUpperCase();

      if (RISKY_COMMANDS.has(word)) riskyFound.add(word);

      if (word === "G20") {
        unitScale = INCH;
        usedInches = true;
      } else if (word === "G21") {
        unitScale = 1;
      } else if (word === "G90") {
        absolutePos = true;
      } else if (word === "G91") {
        absolutePos = false;
      } else if (word === "G92") {
        applyG92(code, pos, originOffset, unitScale);
      } else if (word === "G28") {
        // Homing resets the logical origin; treat homed axes as 0.
        applyHome(code, pos, originOffset);
      } else if (word === "G0" || word === "G1") {
        motionCommands++;
        if (!absolutePos) hasRelativeMoves = true;
        applyMove(code, pos, originOffset, unitScale, absolutePos, bounds);
      } else if (word === "G2" || word === "G3") {
        motionCommands++;
        hasArcs = true;
        // Arc endpoint still bounds the path even if the arc bulge is not traced.
        applyMove(code, pos, originOffset, unitScale, absolutePos, bounds);
      } else if (/^T\d+$/.test(word)) {
        tools.add(Number(word.slice(1)));
      }
    }
  } finally {
    rl.close();
  }

  // ── Findings ────────────────────────────────────────────────────────────
  if (hasArcs) {
    warnings.push(finding("gcode_arcs", "Дуги (G2/G3) — габариты по конечным точкам, приблизительно"));
  }
  if (usedInches) {
    warnings.push(finding("gcode_inch_units", "Часть координат в дюймах (G20) — приведены к мм"));
  }
  for (const cmd of riskyFound) {
    warnings.push(finding("gcode_risky_command", `Потенциально опасная команда ${cmd}`));
  }
  if (motionCommands === 0) {
    warnings.push(finding("gcode_no_toolpath", "Не найдено команд перемещения — это точно печатный G-code?"));
  }

  const confidence: "high" | "medium" | "low" = !bounds.any || motionCommands === 0
    ? "low"
    : hasArcs || hasRelativeMoves
      ? "medium"
      : "high";

  const bbox = bounds.any
    ? {
        min: [bounds.min.x, bounds.min.y, bounds.min.z],
        max: [bounds.max.x, bounds.max.y, bounds.max.z],
        size: [
          bounds.max.x - bounds.min.x,
          bounds.max.y - bounds.min.y,
          bounds.max.z - bounds.min.z
        ],
        confidence
      }
    : null;

  // ── Verdict ─────────────────────────────────────────────────────────────
  const verdicts: AnalysisVerdict[] = ["schedulable"];
  if (!meta.material) verdicts.push("needs_input");
  if (!meta.slicer || !meta.printerModel || riskyFound.size > 0 || confidence === "low") {
    verdicts.push("review");
  }
  if (!meta.slicer) {
    warnings.push(finding("gcode_unknown_slicer", "Слайсер не распознан"));
  }
  if (!meta.printerModel) {
    warnings.push(finding("gcode_unknown_target", "Целевой принтер не указан — не считать безопасным для ночной печати"));
  }
  const verdict =
    blockers.length > 0 ? "blocked" : escalateFromConditions(worstVerdict(verdicts), riskyFound.size > 0);

  return {
    detectedFormat: "gcode",
    verdict,
    warnings,
    blockers,
    data: {
      slicer: meta.slicer,
      slicerVersion: meta.slicerVersion,
      flavor: meta.flavor,
      printerModel: meta.printerModel,
      nozzleTempC: meta.nozzleTempC,
      bedTempC: meta.bedTempC,
      toolCount: tools.size > 0 ? tools.size : 1,
      filamentUsedMm: meta.filamentUsedMm,
      motionCommands,
      bbox
    },
    analyzer: "gcode",
    analyzerVersion: ANALYZER_VERSION,
    material: meta.material,
    estimatedDurationS: meta.estimatedDurationS,
    estimatedFilamentG: meta.filamentUsedG,
    nozzleDiameterMm: meta.nozzleDiameterMm,
    layerHeightMm: meta.layerHeightMm
  };
}

/** A risky command always forces review even if everything else looked schedulable. */
function escalateFromConditions(verdict: ReturnType<typeof worstVerdict>, risky: boolean) {
  return risky ? escalateToReview(verdict) : verdict;
}

// ── Coordinate handling ─────────────────────────────────────────────────────

function readAxis(code: string, axis: string): number | null {
  const match = code.match(new RegExp(`(?:^|\\s)${axis}(-?\\d+(?:\\.\\d+)?)`, "i"));
  return match ? Number(match[1]) : null;
}

function applyMove(
  code: string,
  pos: Vec3,
  origin: Vec3,
  scale: number,
  absolute: boolean,
  bounds: Bounds
): void {
  let moved = false;
  for (const axis of ["x", "y", "z"] as const) {
    const raw = readAxis(code, axis);
    if (raw === null) continue;
    moved = true;
    if (absolute) {
      pos[axis] = raw * scale + origin[axis];
    } else {
      pos[axis] += raw * scale;
    }
  }
  if (!moved) return;
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return;
  bounds.any = true;
  bounds.min.x = Math.min(bounds.min.x, pos.x);
  bounds.min.y = Math.min(bounds.min.y, pos.y);
  bounds.min.z = Math.min(bounds.min.z, pos.z);
  bounds.max.x = Math.max(bounds.max.x, pos.x);
  bounds.max.y = Math.max(bounds.max.y, pos.y);
  bounds.max.z = Math.max(bounds.max.z, pos.z);
}

/** G92 renames the current physical position: keep `pos`, shift the origin offset. */
function applyG92(code: string, pos: Vec3, origin: Vec3, scale: number): void {
  for (const axis of ["x", "y", "z"] as const) {
    const raw = readAxis(code, axis);
    if (raw === null) continue;
    origin[axis] = pos[axis] - raw * scale;
  }
}

/** G28 homes: the homed axes become the logical origin (physical 0 here). */
function applyHome(code: string, pos: Vec3, origin: Vec3): void {
  const mentionsAxis = /(?:^|\s)[XYZ]/i.test(code);
  for (const axis of ["x", "y", "z"] as const) {
    const homed = !mentionsAxis || new RegExp(`(?:^|\\s)${axis}`, "i").test(code);
    if (homed) {
      pos[axis] = 0;
      origin[axis] = 0;
    }
  }
}

// ── Comment / metadata extraction ────────────────────────────────────────────

function extractComment(line: string, meta: Record<string, unknown>): void {
  const set = <T>(key: string, value: T | null): void => {
    if (value !== null && value !== undefined && (meta[key] === null || meta[key] === undefined)) {
      meta[key] = value;
    }
  };

  // Slicer + version banners.
  let m = line.match(/;\s*generated by\s+(PrusaSlicer|SuperSlicer|OrcaSlicer|BambuStudio|PrusaGCodeViewer)\s+([\d.]+)/i);
  if (m) {
    set("slicer", m[1]);
    set("slicerVersion", m[2]);
  }
  m = line.match(/;\s*Generated with\s+Cura[_ ]?SteamEngine\s+([\d.]+)/i);
  if (m) {
    set("slicer", "Cura");
    set("slicerVersion", m[1]);
  }
  m = line.match(/;\s*G-?Code generated by\s+Simplify3D.*?Version\s+([\d.]+)/i);
  if (m) {
    set("slicer", "Simplify3D");
    set("slicerVersion", m[1]);
  }

  m = line.match(/;\s*FLAVOR:\s*(\S+)/i);
  if (m) set("flavor", m[1]);

  m = line.match(/;\s*(?:printer_model|printer_settings_id|machine_name)\s*=\s*(.+)/i);
  if (m) set("printerModel", m[1].trim());

  m = line.match(/;\s*(?:filament_type|filament used material|material)\s*=\s*([A-Za-z0-9+\- ]+)/i);
  if (m) set("material", m[1].split(/[;,]/)[0].trim());
  m = line.match(/;\s*filament:\s*([A-Za-z0-9+\- ]+)/i);
  if (m) set("material", m[1].split(/[;,]/)[0].trim());

  m = line.match(/;\s*layer_height\s*=\s*([\d.]+)/i);
  if (m) set("layerHeightMm", Number(m[1]));

  m = line.match(/;\s*nozzle_diameter\s*=\s*([\d.]+)/i);
  if (m) set("nozzleDiameterMm", Number(m[1].split(/[,;]/)[0]));

  m = line.match(/;\s*(?:first_layer_temperature|temperature|nozzle_temperature)\s*=\s*(\d+)/i);
  if (m) set("nozzleTempC", Number(m[1]));
  m = line.match(/;\s*(?:first_layer_bed_temperature|bed_temperature)\s*=\s*(\d+)/i);
  if (m) set("bedTempC", Number(m[1]));

  // Estimated time — Prusa/Orca "Nh Nm Ns" or Cura ";TIME:<seconds>".
  m = line.match(/;\s*estimated printing time.*?=\s*(.+)/i);
  if (m) set("estimatedDurationS", parseHms(m[1]));
  m = line.match(/;\s*(?:model printing time|total estimated time):\s*(.+)/i);
  if (m) set("estimatedDurationS", parseHms(m[1]));
  m = line.match(/;\s*TIME:\s*(\d+)/i);
  if (m) set("estimatedDurationS", Number(m[1]));

  // Filament usage.
  m = line.match(/;\s*(?:total\s+)?filament used\s*\[mm\]\s*=\s*([\d.]+)/i);
  if (m) set("filamentUsedMm", Number(m[1]));
  m = line.match(/;\s*(?:total\s+)?filament used\s*\[g\]\s*=\s*([\d.]+)/i);
  if (m) set("filamentUsedG", Number(m[1]));
  m = line.match(/;\s*Filament used:\s*([\d.]+)m/i);
  if (m) set("filamentUsedMm", Number(m[1]) * 1000);
}

/** Parses "1h 2m 3s" / "45m 12s" / "2 hours 5 minutes" into seconds. */
function parseHms(text: string): number | null {
  let seconds = 0;
  let matched = false;
  const h = text.match(/(\d+)\s*(?:h|hour)/i);
  const min = text.match(/(\d+)\s*(?:m(?!s)|min)/i);
  const s = text.match(/(\d+)\s*(?:s|sec)/i);
  if (h) {
    seconds += Number(h[1]) * 3600;
    matched = true;
  }
  if (min) {
    seconds += Number(min[1]) * 60;
    matched = true;
  }
  if (s) {
    seconds += Number(s[1]);
    matched = true;
  }
  return matched ? seconds : null;
}
