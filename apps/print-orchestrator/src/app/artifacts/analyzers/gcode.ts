import fs from "node:fs";
import readline from "node:readline";

import type { AnalysisFinding, AnalysisVerdict } from "../../../domain/print/types";
import { CommandPolicy } from "./gcodePolicy";
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
 * temperatures, tool count, firmware flavor, target printer, and bounding boxes.
 *
 * The boxes are computed from the motion commands while honouring the coordinate
 * model — absolute/relative positioning (G90/G91), absolute/relative extrusion
 * (M82/M83), the coordinate-reset G92, and inch/millimetre units (G20/G21). It
 * does not emulate firmware; arcs and other constructs it cannot follow lower a
 * reported confidence and add a warning rather than pretend.
 *
 * Command safety is delegated to {@link CommandPolicy}, which judges a word in the
 * context of the machine the file targets — some opcodes are an attack on one
 * firmware and the vendor's own start-up routine on another.
 *
 * A recognised slicer + known target + material with no critical command yields
 * `schedulable` (fit for *planning*, not an unattended auto-start). An unknown
 * target, unknown slicer, risky command, or low bbox confidence forces at least
 * `review` — third-party G-code is never assumed safe for the night queue.
 */

const INCH = 25.4;

/**
 * A tool index at or above this is a *pseudo*-tool, not a physical extruder.
 * Bambu's G-code selects `T255` (no tool / park) and `T1000` (the AMS unload
 * pseudo-tool) around every filament change, which counted as real extruders and
 * reported a single-nozzle A1 print as three-tool multi-material.
 */
const MAX_PHYSICAL_TOOL = 16;

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

/** A rectangular bed, read from the file's own `; printable_area = …` comment. */
interface BedArea {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Everything one streaming pass over the file collects. */
interface Scan {
  meta: GcodeMeta;
  policy: CommandPolicy;
  /** Everything the head does, including the machine's own priming and parking. */
  toolpath: Bounds;
  /** Material deposited on the bed, wherever it happened. */
  deposited: Bounds;
  /** Material deposited on the bed *inside the slicer's object markers*. */
  object: Bounds;
  sawObjectMarkers: boolean;
  depositedOffBed: boolean;
  motionCommands: number;
  hasArcs: boolean;
  hasRelativeMoves: boolean;
  usedInches: boolean;
  tools: Set<number>;
}

interface GcodeMeta {
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
}

/**
 * One line-by-line pass over the file: metadata comments, the command policy, and
 * the coordinate simulation that produces the boxes. Constant memory — the file is
 * streamed, never slurped, and never executed.
 */
async function scanGcode(path: string): Promise<Scan> {
  const scan: Scan = {
    meta: {
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
    },
    policy: new CommandPolicy(),
    toolpath: newBounds(),
    deposited: newBounds(),
    object: newBounds(),
    sawObjectMarkers: false,
    depositedOffBed: false,
    motionCommands: 0,
    hasArcs: false,
    hasRelativeMoves: false,
    usedInches: false,
    tools: new Set<number>()
  };

  // Coordinate state (firmware defaults).
  let absolutePos = true;
  let absoluteE = true; // M82 is the firmware default; slicers usually switch to M83
  let unitScale = 1; // mm; G20 → 25.4
  let ePos = 0;
  let insideObject = false;
  let bed: BedArea | null = null;
  let lineNo = 0;
  const pos: Vec3 = { x: 0, y: 0, z: 0 };
  const originOffset: Vec3 = { x: 0, y: 0, z: 0 };

  const rl = readline.createInterface({
    input: fs.createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  try {
    for await (const rawLine of rl) {
      lineNo += 1;
      const line = rawLine.trim();
      if (line.length === 0) continue;

      if (line.startsWith(";")) {
        extractComment(line, scan.meta);
        bed ??= readPrintableArea(line);
        const marker = readObjectMarker(line);
        if (marker !== null) {
          insideObject = marker;
          scan.sawObjectMarkers = true;
        }
        continue;
      }

      // Strip an inline comment, then read the command word.
      const code = line.split(";", 1)[0].trim();
      if (code.length === 0) continue;
      const word = code.split(/\s+/)[0].toUpperCase();

      scan.policy.observe(word, lineNo);

      if (word === "G20") {
        unitScale = INCH;
        scan.usedInches = true;
      } else if (word === "G21") {
        unitScale = 1;
      } else if (word === "G90") {
        absolutePos = true;
      } else if (word === "G91") {
        absolutePos = false;
      } else if (word === "M82") {
        absoluteE = true;
      } else if (word === "M83") {
        absoluteE = false;
      } else if (word === "G92") {
        applyG92(code, pos, originOffset, unitScale);
        const e = readAxis(code, "e");
        if (e !== null) ePos = e;
      } else if (word === "G28") {
        // Homing resets the logical origin; treat homed axes as 0.
        applyHome(code, pos, originOffset);
      } else if (word === "G0" || word === "G1" || word === "G2" || word === "G3") {
        scan.motionCommands++;
        if (!absolutePos) scan.hasRelativeMoves = true;
        // An arc's endpoint still bounds the path even if the bulge is not traced.
        if (word === "G2" || word === "G3") scan.hasArcs = true;
        const from = { ...pos };
        const moved = applyMove(code, pos, originOffset, unitScale, absolutePos);
        const extruded = readExtrusion(code, absoluteE, ePos);
        ePos = extruded.ePos;
        if (moved) {
          extend(scan.toolpath, pos);
          // Material laid down, with both ends of the segment on the bed. Travels
          // are excluded by the first condition; the machine's own priming, purge
          // and nozzle-wipe lines by the second (Bambu draws them a hair *outside*
          // the bed, at Y=-0.5, precisely so they are not part of the print).
          if (extruded.deposits) {
            if (bed !== null && !(onBed(bed, from) && onBed(bed, pos))) {
              scan.depositedOffBed = true;
            } else {
              extend(scan.deposited, from);
              extend(scan.deposited, pos);
              // …and the flush a filament change performs mid-print is excluded by
              // the object markers, which is why they are tracked separately.
              if (insideObject) {
                extend(scan.object, from);
                extend(scan.object, pos);
              }
            }
          }
        }
      } else if (/^T\d+$/.test(word)) {
        const index = Number(word.slice(1));
        if (index <= MAX_PHYSICAL_TOOL) scan.tools.add(index);
      }
    }
  } finally {
    rl.close();
  }

  return scan;
}

export async function analyzeGcode(path: string): Promise<AnalyzerResult> {
  const warnings: AnalysisFinding[] = [];
  const blockers: AnalysisFinding[] = [];

  const {
    meta,
    policy,
    toolpath,
    deposited,
    object,
    sawObjectMarkers,
    depositedOffBed,
    motionCommands,
    hasArcs,
    hasRelativeMoves,
    usedInches,
    tools
  } = await scanGcode(path);

  // ── Findings ────────────────────────────────────────────────────────────
  const commands = policy.evaluate({ slicer: meta.slicer, printerModel: meta.printerModel });
  warnings.push(...commands.warnings);
  blockers.push(...commands.blockers);

  if (hasArcs) {
    warnings.push(finding("gcode_arcs", "Дуги (G2/G3) — габариты по конечным точкам, приблизительно"));
  }
  if (usedInches) {
    warnings.push(finding("gcode_inch_units", "Часть координат в дюймах (G20) — приведены к мм"));
  }
  if (depositedOffBed) {
    warnings.push(
      finding(
        "gcode_purge_outside_bed",
        "Часть экструзии идёт вне рабочей области (штатная промывка/очистка сопла) — в габариты модели не включена"
      )
    );
  }
  if (motionCommands === 0) {
    warnings.push(finding("gcode_no_toolpath", "Не найдено команд перемещения — это точно печатный G-code?"));
  }

  // The *model's* box is what downstream fit checks mean by "dimensions"; the raw
  // toolpath box is kept beside it for diagnostics. Preference order, best evidence
  // first: what the slicer marked as the object, else everything extruded onto the
  // bed, else — for a file that lays down nothing we can attribute — the bare
  // toolpath. `bboxBasis` reports which, rather than passing a purge-inflated box
  // off as the model. The choice is made here, at the end, because "this file has no
  // object markers" is only knowable once the whole file has been read.
  const basis = sawObjectMarkers && object.any ? "object" : deposited.any ? "extrusion" : "toolpath";
  const bounds = basis === "object" ? object : basis === "extrusion" ? deposited : toolpath;
  const confidence: "high" | "medium" | "low" = !bounds.any || motionCommands === 0
    ? "low"
    : hasArcs || hasRelativeMoves
      ? "medium"
      : "high";

  const bbox = boxOf(bounds, confidence);

  // ── Verdict ─────────────────────────────────────────────────────────────
  const verdicts: AnalysisVerdict[] = ["schedulable"];
  if (!meta.material) verdicts.push("needs_input");
  if (!meta.slicer || !meta.printerModel || policy.hasReviewCommands || confidence === "low") {
    verdicts.push("review");
  }
  if (!meta.slicer) {
    warnings.push(finding("gcode_unknown_slicer", "Слайсер не распознан"));
  }
  if (!meta.printerModel) {
    warnings.push(finding("gcode_unknown_target", "Целевой принтер не указан — не считать безопасным для ночной печати"));
  }
  const verdict =
    blockers.length > 0
      ? "blocked"
      : escalateFromConditions(worstVerdict(verdicts), policy.hasReviewCommands);

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
      bbox,
      bboxBasis: basis,
      toolpathBbox: boxOf(toolpath, confidence)
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

/**
 * Reads one axis word's value, in every shape a slicer actually writes.
 *
 * The permissive number grammar is not theoretical tidiness: OrcaSlicer omits the
 * leading zero on fractions, so 94 731 of the 96 480 E words in a single real A1
 * file are written `E.03338` and only 1 749 as `E0.03338`. A pattern demanding a
 * digit before the point silently skipped 98 % of the extrusion in that file (and
 * every `Z.3` move with it) — which, once the model's box came to be measured from
 * extruding moves, would have meant measuring it from a two-percent sample.
 */
const AXIS_NUMBER = "([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+))";

function readAxis(code: string, axis: string): number | null {
  const match = code.match(new RegExp(`(?:^|\\s)${axis}${AXIS_NUMBER}`, "i"));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** Advances `pos` by one move command. Returns whether any axis actually moved. */
function applyMove(code: string, pos: Vec3, origin: Vec3, scale: number, absolute: boolean): boolean {
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
  return moved;
}

function newBounds(): Bounds {
  return {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
    any: false
  };
}

/** Grows `bounds` to contain `p`, ignoring a position no longer numerically sane. */
function extend(bounds: Bounds, p: Vec3): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
  bounds.any = true;
  bounds.min.x = Math.min(bounds.min.x, p.x);
  bounds.min.y = Math.min(bounds.min.y, p.y);
  bounds.min.z = Math.min(bounds.min.z, p.z);
  bounds.max.x = Math.max(bounds.max.x, p.x);
  bounds.max.y = Math.max(bounds.max.y, p.y);
  bounds.max.z = Math.max(bounds.max.z, p.z);
}

function boxOf(bounds: Bounds, confidence: "high" | "medium" | "low") {
  if (!bounds.any) return null;
  return {
    min: [bounds.min.x, bounds.min.y, bounds.min.z],
    max: [bounds.max.x, bounds.max.y, bounds.max.z],
    size: [
      bounds.max.x - bounds.min.x,
      bounds.max.y - bounds.min.y,
      bounds.max.z - bounds.min.z
    ],
    confidence
  };
}

/**
 * Whether a point is on the declared bed. The tolerance is float noise only, not a
 * courtesy margin: Bambu's purge and nozzle-load lines sit a mere 0.5 mm past the
 * front edge (`Y-0.5`), so anything more generous would pull them back into the
 * model's box — which is the whole thing this filter exists to prevent.
 */
function onBed(bed: BedArea, p: Vec3): boolean {
  const eps = 0.01;
  return (
    p.x >= bed.minX - eps && p.x <= bed.maxX + eps && p.y >= bed.minY - eps && p.y <= bed.maxY + eps
  );
}

/**
 * Reads a move's E word and reports whether it *deposits* material. Handles both
 * extrusion modes: in relative mode (`M83`, what every modern slicer emits) any
 * positive E adds material; in absolute mode (`M82`) only an E that advances past
 * the current position does, so retract/prime pairs do not count as printing.
 */
function readExtrusion(code: string, absolute: boolean, ePos: number): { deposits: boolean; ePos: number } {
  const raw = readAxis(code, "e");
  if (raw === null) return { deposits: false, ePos };
  if (absolute) return { deposits: raw > ePos + 1e-9, ePos: raw };
  return { deposits: raw > 1e-9, ePos: ePos + raw };
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

// ── Object / bed markers ─────────────────────────────────────────────────────

/**
 * The slicer's own "this is the model" brackets. OrcaSlicer, BambuStudio and
 * PrusaSlicer all emit a pair around each object's per-layer toolpath
 * (`; start printing object, unique label id: 8` … `; stop printing object …`,
 * PrusaSlicer's `; printing object Foo id:0 copy 0` … `; stop printing object …`),
 * which is the authoritative statement of where the model ends and the machine's
 * own routines begin. Returns true/false to open/close the region, null when the
 * comment says nothing about it.
 */
function readObjectMarker(line: string): boolean | null {
  const low = line.toLowerCase();
  if (!low.includes("printing object")) return null;
  if (low.includes("stop printing object")) return false;
  if (low.includes("start printing object") || /;\s*printing object\b/.test(low)) return true;
  return null;
}

/**
 * The bed the file was sliced for, from its own config block
 * (`; printable_area = 0x0,256x0,256x256,0x256`). Used to tell the model apart
 * from the purge/flush a machine performs off the bed — never to *judge* whether
 * the print fits, which is the scheduler's call against the real printer.
 */
function readPrintableArea(line: string): BedArea | null {
  const m = line.match(/;\s*printable_area\s*=\s*(.+)/i);
  if (!m) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const point of m[1].split(",")) {
    const pair = point.trim().match(/^(-?\d+(?:\.\d+)?)x(-?\d+(?:\.\d+)?)$/i);
    if (!pair) continue;
    xs.push(Number(pair[1]));
    ys.push(Number(pair[2]));
  }
  if (xs.length < 3) return null;
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

// ── Comment / metadata extraction ────────────────────────────────────────────

function extractComment(line: string, meta: GcodeMeta): void {
  /** First writer wins: a header banner outranks a repeated per-layer comment. */
  const set = <K extends keyof GcodeMeta>(key: K, value: GcodeMeta[K] | null): void => {
    if (value !== null && value !== undefined && meta[key] === null) meta[key] = value;
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
