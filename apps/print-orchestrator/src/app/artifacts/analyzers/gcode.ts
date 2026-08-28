import fs from "node:fs";

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
 * Line terminators. `\r\n` first so a CRLF pair is one break, not two; the lone
 * `\r` and the Unicode separators are kept because dropping them would let a
 * hostile file hide a command from the policy on a line the parser never sees.
 */
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/** Read size. Larger chunks mean fewer awaits, which is most of what readline cost. */
const READ_CHUNK_BYTES = 1 << 20;

/**
 * One line-by-line pass over the file: metadata comments, the command policy, and
 * the coordinate simulation that produces the boxes. Constant memory — the file is
 * streamed, never slurped, and never executed.
 *
 * ## Why this loop is written the way it is
 *
 * A 50 MB OrcaSlicer file took ~50 s here, against a 30 s analysis budget, so
 * every large upload came back `analysis: failed` for a reason that had nothing
 * to do with the file. Four things accounted for it, and all four were paid
 * *per line* on a file with millions of them:
 *
 *  1. four `new RegExp` compilations per motion command (one per axis) — see
 *     {@link scanAxisWords};
 *  2. `readline`'s per-line promise, which put the whole file through the
 *     microtask queue one line at a time; the stream is chunked here instead, so
 *     there is one await per megabyte rather than one per line;
 *  3. an object literal per motion command for the segment's start point, now
 *     held in scalars;
 *  4. `split` allocating an array of every word on a line to read the first one.
 *
 * None of it changes what is computed: the bounding boxes, the command policy
 * verdict and the metadata are identical, which is what the analyzer's fixture
 * tests pin.
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

  // Coordinate state (firmware defaults). Held as scalars, not Vec3 objects: the
  // segment's start point is needed on every extruding move and allocating one
  // object per move is millions of short-lived objects on a large file.
  let absolutePos = true;
  let absoluteE = true; // M82 is the firmware default; slicers usually switch to M83
  let unitScale = 1; // mm; G20 → 25.4
  let ePos = 0;
  let insideObject = false;
  let bed: BedArea | null = null;
  let lineNo = 0;
  let posX = 0;
  let posY = 0;
  let posZ = 0;
  let originX = 0;
  let originY = 0;
  let originZ = 0;

  // One scratch record for the whole file: the axis words of the line in hand.
  // Reused rather than reallocated, because on a 50 MB file this is the hot loop.
  const words = newAxisWords();
  const home = newAxisWords();

  const handleLine = (rawLine: string): void => {
    lineNo += 1;
    const line = rawLine.trim();
    if (line.length === 0) return;

    if (line.charCodeAt(0) === 59 /* ; */) {
      // One lower-case copy serves all three readers; each used to make its own.
      const low = line.toLowerCase();
      extractComment(line, low, scan.meta);
      bed ??= readPrintableArea(low);
      const marker = readObjectMarker(low);
      if (marker !== null) {
        insideObject = marker;
        scan.sawObjectMarkers = true;
      }
      return;
    }

    // Strip an inline comment, then read the command word.
    const semi = line.indexOf(";");
    const code = semi === -1 ? line : line.slice(0, semi).trimEnd();
    if (code.length === 0) return;
    const word = commandWord(code);

    scan.policy.observe(word, lineNo);

    if (word === "G0" || word === "G1" || word === "G2" || word === "G3") {
      scan.motionCommands++;
      if (!absolutePos) scan.hasRelativeMoves = true;
      // An arc's endpoint still bounds the path even if the bulge is not traced.
      if (word === "G2" || word === "G3") scan.hasArcs = true;
      const fromX = posX;
      const fromY = posY;
      const fromZ = posZ;
      scanAxisWords(code, words);

      let moved = false;
      if (!Number.isNaN(words.x)) {
        moved = true;
        posX = absolutePos ? words.x * unitScale + originX : posX + words.x * unitScale;
      }
      if (!Number.isNaN(words.y)) {
        moved = true;
        posY = absolutePos ? words.y * unitScale + originY : posY + words.y * unitScale;
      }
      if (!Number.isNaN(words.z)) {
        moved = true;
        posZ = absolutePos ? words.z * unitScale + originZ : posZ + words.z * unitScale;
      }

      // Whether this move *deposits* material. Both extrusion modes: in relative
      // mode (`M83`, what every modern slicer emits) any positive E adds material;
      // in absolute mode (`M82`) only an E that advances past the current position
      // does, so retract/prime pairs do not count as printing.
      let deposits = false;
      const e = words.e;
      if (!Number.isNaN(e)) {
        if (absoluteE) {
          deposits = e > ePos + 1e-9;
          ePos = e;
        } else {
          deposits = e > 1e-9;
          ePos += e;
        }
      }

      if (moved) {
        extend(scan.toolpath, posX, posY, posZ);
        // Material laid down, with both ends of the segment on the bed. Travels
        // are excluded by the first condition; the machine's own priming, purge
        // and nozzle-wipe lines by the second (Bambu draws them a hair *outside*
        // the bed, at Y=-0.5, precisely so they are not part of the print).
        if (deposits) {
          if (bed !== null && !(onBed(bed, fromX, fromY) && onBed(bed, posX, posY))) {
            scan.depositedOffBed = true;
          } else {
            extend(scan.deposited, fromX, fromY, fromZ);
            extend(scan.deposited, posX, posY, posZ);
            // …and the flush a filament change performs mid-print is excluded by
            // the object markers, which is why they are tracked separately.
            if (insideObject) {
              extend(scan.object, fromX, fromY, fromZ);
              extend(scan.object, posX, posY, posZ);
            }
          }
        }
      }
    } else if (word === "G20") {
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
      // G92 renames the current physical position: keep `pos`, shift the origin.
      scanAxisWords(code, words);
      if (!Number.isNaN(words.x)) originX = posX - words.x * unitScale;
      if (!Number.isNaN(words.y)) originY = posY - words.y * unitScale;
      if (!Number.isNaN(words.z)) originZ = posZ - words.z * unitScale;
      if (!Number.isNaN(words.e)) ePos = words.e;
    } else if (word === "G28") {
      // Homing resets the logical origin; treat homed axes as 0.
      readHomedAxes(code, home);
      if (!Number.isNaN(home.x)) {
        posX = 0;
        originX = 0;
      }
      if (!Number.isNaN(home.y)) {
        posY = 0;
        originY = 0;
      }
      if (!Number.isNaN(home.z)) {
        posZ = 0;
        originZ = 0;
      }
    } else if (word.charCodeAt(0) === 84 /* T */ && TOOL_SELECT.test(word)) {
      const index = Number(word.slice(1));
      if (index <= MAX_PHYSICAL_TOOL) scan.tools.add(index);
    }
  };

  const stream = fs.createReadStream(path, {
    encoding: "utf8",
    highWaterMark: READ_CHUNK_BYTES
  });

  let carry = "";
  try {
    for await (const chunk of stream) {
      let pending = carry + (chunk as string);
      // A `\r` at a chunk boundary must wait for the next chunk to know whether it
      // is a lone break or half of a CRLF pair.
      let heldCr = "";
      if (pending.charCodeAt(pending.length - 1) === 13) {
        heldCr = "\r";
        pending = pending.slice(0, -1);
      }
      const parts = pending.split(LINE_BREAK);
      carry = (parts.pop() ?? "") + heldCr;
      for (let i = 0; i < parts.length; i += 1) handleLine(parts[i]);
    }
    if (carry.length > 0) handleLine(carry);
  } finally {
    stream.destroy();
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
 * The axis words of **one** command, read in a single left-to-right pass.
 *
 * This used to be four `code.match(new RegExp(...))` calls per motion line — one
 * per axis, each compiling a fresh pattern from a template string. On a 50 MB
 * OrcaSlicer file (1.8 M motion commands) that is 7.3 M regex compilations, and
 * it cost ~50 s of CPU: more than the 30 s analysis budget, so every large file
 * came back `analysis: failed` for a reason that had nothing to do with the file.
 *
 * The grammar is unchanged, and the permissive number form is not tidiness:
 * OrcaSlicer omits the leading zero on fractions, so 94 731 of the 96 480 E words
 * in a single real A1 file are written `E.03338` and only 1 749 as `E0.03338`. A
 * parser demanding a digit before the point silently skips 98 % of the extrusion
 * in that file (and every `Z.3` move with it), which — once the model's box came
 * to be measured from extruding moves — would have meant measuring it from a
 * two-percent sample.
 *
 * Semantics preserved exactly from the regex it replaces: an axis letter counts
 * only at the start of a whitespace-delimited word (so the `X` of `M117 MAX` is
 * not an axis), the letter is case-insensitive, the **first** occurrence wins,
 * and trailing junk after a valid number is ignored (`X12abc` reads 12).
 */
interface AxisWords {
  /** NaN when the command carries no such word — the "absent" sentinel. */
  x: number;
  y: number;
  z: number;
  e: number;
}

/** One reused scratch record: the scan runs per line and must not allocate. */
function newAxisWords(): AxisWords {
  return { x: NaN, y: NaN, z: NaN, e: NaN };
}

const SPACE = 32;

/**
 * The command word of a line (`G1`, `M104`, `T0`), upper-cased.
 *
 * `code.split(/\s+/)[0].toUpperCase()` allocated an array of every word on the
 * line just to read the first one — once per non-comment line, so millions of
 * throwaway arrays on a large file.
 */
function commandWord(code: string): string {
  const len = code.length;
  let end = 0;
  while (end < len && code.charCodeAt(end) > SPACE) end += 1;
  // The four motion words are ~99 % of a print file. Returning the shared literal
  // for them skips both the slice and the case fold, and — because the result is
  // then a constant — makes the comparisons at the call site pointer-equality.
  if (end === 2 && (code.charCodeAt(0) | 0x20) === 103 /* g */) {
    const digit = code.charCodeAt(1);
    if (digit === 48) return "G0";
    if (digit === 49) return "G1";
    if (digit === 50) return "G2";
    if (digit === 51) return "G3";
  }
  return code.slice(0, end).toUpperCase();
}

/** `T0`, `T12` — a tool select, as opposed to a Klipper macro that starts with T. */
const TOOL_SELECT = /^T\d+$/;

/**
 * Fills `out` with the X/Y/Z/E words of `code`, skipping the leading command
 * word. Allocation-free apart from the numeric slices themselves.
 */
function scanAxisWords(code: string, out: AxisWords): void {
  out.x = NaN;
  out.y = NaN;
  out.z = NaN;
  out.e = NaN;
  const len = code.length;
  let i = 0;
  // The command word itself (G1, G92, …) is never an axis word.
  while (i < len && code.charCodeAt(i) > SPACE) i += 1;

  while (i < len) {
    while (i < len && code.charCodeAt(i) <= SPACE) i += 1;
    if (i >= len) break;
    // Lower-case the ASCII letter with a single bit — the axis letters are all
    // alphabetic, so this is exactly `toLowerCase` for the cases that matter.
    const letter = code.charCodeAt(i) | 0x20;
    i += 1;
    const axis =
      letter === 120 ? "x" : letter === 121 ? "y" : letter === 122 ? "z" : letter === 101 ? "e" : null;
    if (axis === null || !Number.isNaN(out[axis])) {
      // Not an axis, or already seen (first occurrence wins): skip the word.
      while (i < len && code.charCodeAt(i) > SPACE) i += 1;
      continue;
    }
    const value = readNumberAt(code, i);
    if (value !== null) {
      out[axis] = value;
      i = numberEnd;
    }
    // Whether or not it parsed, continue from the next whitespace-delimited word:
    // trailing junk after a valid number is ignored, exactly as the regex did.
    while (i < len && code.charCodeAt(i) > SPACE) i += 1;
  }
}

/**
 * Where the last {@link readNumberAt} stopped. A module-level out-parameter
 * rather than a returned pair, because this runs millions of times per file and
 * an object per call is the allocation the rewrite exists to remove. Only ever
 * read immediately after a successful `readNumberAt`, on one thread.
 */
let numberEnd = 0;

/** 10^k for every k a decimal fraction can carry exactly (10^22 is the last one). */
const POW10: readonly number[] = Array.from({ length: 23 }, (_, k) => Number(`1e${k}`));

/** Digits that still fit an exact integer in a double (10^15 < 2^53). */
const MAX_EXACT_DIGITS = 15;

/**
 * The number starting at `from`, or null when the text there is not one.
 * Grammar: `[-+]?(digits[.digits*] | .digits)` — the same one the regex used.
 */
function readNumberAt(code: string, from: number): number | null {
  const len = code.length;
  let i = from;
  const c = code.charCodeAt(i);
  const negative = c === 45; /* - */
  if (negative || c === 43 /* + */) i += 1;

  // Digits of the integer and fraction parts accumulate into ONE integer
  // mantissa; the decimal point is remembered as an exponent. `1234` and `12.34`
  // both give mantissa 1234, with fracDigits 0 and 2.
  let mantissa = 0;
  let digits = 0;
  let fracDigits = 0;
  const intStart = i;
  while (i < len && isDigit(code.charCodeAt(i))) {
    mantissa = mantissa * 10 + (code.charCodeAt(i) - 48);
    digits += 1;
    i += 1;
  }
  const intDigits = i - intStart;
  if (i < len && code.charCodeAt(i) === 46 /* . */) {
    i += 1;
    const fracStart = i;
    while (i < len && isDigit(code.charCodeAt(i))) {
      mantissa = mantissa * 10 + (code.charCodeAt(i) - 48);
      digits += 1;
      i += 1;
    }
    fracDigits = i - fracStart;
  }
  // `.5` is valid, `12.` is valid, a bare sign or letter is not.
  if (intDigits === 0 && fracDigits === 0) return null;
  numberEnd = i;

  // `mantissa` and `POW10[fracDigits]` are both exactly representable here, so
  // this single IEEE division is *correctly rounded* — bit-identical to what
  // `Number("12.34")` returns, without materialising the string. Anything longer
  // than that (a slicer writing 20 significant digits) falls back to the parser.
  if (digits <= MAX_EXACT_DIGITS && fracDigits <= 22) {
    const value = mantissa / POW10[fracDigits];
    return negative ? -value : value;
  }
  const value = Number(code.slice(from, i));
  return Number.isFinite(value) ? value : null;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/**
 * Reads one axis word's value. Kept as the readable entry point for the cold
 * paths (G92, tests); the hot motion path uses {@link scanAxisWords} directly so
 * one pass serves all four axes.
 */
export function readAxis(code: string, axis: "x" | "y" | "z" | "e"): number | null {
  const words = newAxisWords();
  scanAxisWords(code, words);
  const value = words[axis];
  return Number.isNaN(value) ? null : value;
}


function newBounds(): Bounds {
  return {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
    any: false
  };
}

/** Grows `bounds` to contain a point, ignoring one no longer numerically sane. */
function extend(bounds: Bounds, x: number, y: number, z: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  bounds.any = true;
  if (x < bounds.min.x) bounds.min.x = x;
  if (y < bounds.min.y) bounds.min.y = y;
  if (z < bounds.min.z) bounds.min.z = z;
  if (x > bounds.max.x) bounds.max.x = x;
  if (y > bounds.max.y) bounds.max.y = y;
  if (z > bounds.max.z) bounds.max.z = z;
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
function onBed(bed: BedArea, x: number, y: number): boolean {
  const eps = 0.01;
  return x >= bed.minX - eps && x <= bed.maxX + eps && y >= bed.minY - eps && y <= bed.maxY + eps;
}



/**
 * Which axes a `G28` homes, written into `out` as 0 (homed) / NaN (not).
 *
 * `G28` names its axes as bare words (`G28 X Y`) that carry no number, so the
 * axis-word scan cannot answer this and the letters are read directly. A bare
 * `G28` homes everything.
 */
function readHomedAxes(code: string, out: AxisWords): void {
  out.x = NaN;
  out.y = NaN;
  out.z = NaN;
  out.e = NaN;
  let mentionsAxis = false;
  const len = code.length;
  let i = 0;
  while (i < len && code.charCodeAt(i) > SPACE) i += 1; // skip "G28"
  while (i < len) {
    while (i < len && code.charCodeAt(i) <= SPACE) i += 1;
    if (i >= len) break;
    const letter = code.charCodeAt(i) | 0x20;
    if (letter === 120) {
      out.x = 0;
      mentionsAxis = true;
    } else if (letter === 121) {
      out.y = 0;
      mentionsAxis = true;
    } else if (letter === 122) {
      out.z = 0;
      mentionsAxis = true;
    }
    while (i < len && code.charCodeAt(i) > SPACE) i += 1;
  }
  if (!mentionsAxis) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
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
function readObjectMarker(low: string): boolean | null {
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
function readPrintableArea(low: string): BedArea | null {
  if (!low.includes("printable_area")) return null;
  const m = low.match(/;\s*printable_area\s*=\s*(.+)/i);
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

/**
 * Metadata from one comment line. `low` is the same line lower-cased, passed in
 * because the caller already needs it — it gates each group with a substring
 * test so a per-layer `;TYPE:` comment costs three `indexOf` calls instead of
 * eighteen regex matches.
 *
 * Values are read from `line`, not `low`: a slicer name, a printer model and a
 * material are reported to the operator and must keep their case.
 */
function extractComment(line: string, low: string, meta: GcodeMeta): void {
  /** First writer wins: a header banner outranks a repeated per-layer comment. */
  const set = <K extends keyof GcodeMeta>(key: K, value: GcodeMeta[K] | null): void => {
    if (value !== null && value !== undefined && meta[key] === null) meta[key] = value;
  };

  let m: RegExpMatchArray | null;

  // Slicer + version banners.
  if (low.includes("generated by") || low.includes("generated with")) {
    m = line.match(/;\s*generated by\s+(PrusaSlicer|SuperSlicer|OrcaSlicer|BambuStudio|PrusaGCodeViewer)\s+([\d.]+)/i);
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
  }

  if (low.includes("flavor")) {
    m = line.match(/;\s*FLAVOR:\s*(\S+)/i);
    if (m) set("flavor", m[1]);
  }

  if (low.includes("printer_model") || low.includes("printer_settings_id") || low.includes("machine_name")) {
    m = line.match(/;\s*(?:printer_model|printer_settings_id|machine_name)\s*=\s*(.+)/i);
    if (m) set("printerModel", m[1].trim());
  }

  if (low.includes("material") || low.includes("filament")) {
    m = line.match(/;\s*(?:filament_type|filament used material|material)\s*=\s*([A-Za-z0-9+\- ]+)/i);
    if (m) set("material", m[1].split(/[;,]/)[0].trim());
    m = line.match(/;\s*filament:\s*([A-Za-z0-9+\- ]+)/i);
    if (m) set("material", m[1].split(/[;,]/)[0].trim());
  }

  if (low.includes("layer_height")) {
    m = line.match(/;\s*layer_height\s*=\s*([\d.]+)/i);
    if (m) set("layerHeightMm", Number(m[1]));
  }

  if (low.includes("nozzle_diameter")) {
    m = line.match(/;\s*nozzle_diameter\s*=\s*([\d.]+)/i);
    if (m) set("nozzleDiameterMm", Number(m[1].split(/[,;]/)[0]));
  }

  if (low.includes("temperature")) {
    m = line.match(/;\s*(?:first_layer_temperature|temperature|nozzle_temperature)\s*=\s*(\d+)/i);
    if (m) set("nozzleTempC", Number(m[1]));
    m = line.match(/;\s*(?:first_layer_bed_temperature|bed_temperature)\s*=\s*(\d+)/i);
    if (m) set("bedTempC", Number(m[1]));
  }

  // Estimated time — Prusa/Orca "Nd Nh Nm Ns" or Cura ";TIME:<seconds>".
  if (low.includes("time")) {
    m = line.match(/;\s*estimated printing time.*?=\s*(.+)/i);
    if (m) set("estimatedDurationS", parseHms(m[1]));
    m = line.match(/;\s*(?:model printing time|total estimated time):\s*(.+)/i);
    if (m) set("estimatedDurationS", parseHms(m[1]));
    m = line.match(/;\s*TIME:\s*(\d+)/i);
    if (m) set("estimatedDurationS", Number(m[1]));
  }

  // Filament usage.
  //
  // Two families, and reading only one of them is how a BambuStudio file lost its
  // weight. PrusaSlicer/SuperSlicer/Orca write `key [unit] = value`;
  // BambuStudio writes `total filament weight [g] : value` — a different noun
  // ("weight", "length" rather than "used") *and* a different separator. Both
  // separators and both nouns are accepted per unit, so the unit — never the
  // phrasing — decides which field a number lands in.
  if (low.includes("filament")) {
    m = line.match(/;\s*(?:total\s+)?filament\s+(?:used|length)\s*\[mm\]\s*[:=]\s*([\d.]+)/i);
    if (m) set("filamentUsedMm", Number(m[1]));
    m = line.match(/;\s*(?:total\s+)?filament\s+(?:used|weight)\s*\[g\]\s*[:=]\s*([\d.]+)/i);
    if (m) set("filamentUsedG", Number(m[1]));
    // Cura reports one line in metres, with no bracketed unit at all.
    m = line.match(/;\s*Filament used:\s*([\d.]+)m\b/i);
    if (m) set("filamentUsedMm", Number(m[1]) * 1000);
  }
}

/**
 * A slicer's human-readable duration in seconds, or null when the text carries
 * none.
 *
 * **Days count.** PrusaSlicer, SuperSlicer, OrcaSlicer and BambuStudio all write
 * `1d 2h 3m 4s` once a print passes twenty-four hours, and dropping the `1d`
 * turned a 26-hour job into a 2-hour one. That number is not cosmetic: it is the
 * ETA the scheduler fits into the night window, so a multi-day print was being
 * planned as if it finished before dawn.
 *
 * Each unit is read at most once and independently, so partial forms
 * (`2d 5m`, `45m 12s`, `2 hours 5 minutes`) all work.
 */
function parseHms(text: string): number | null {
  const units: [RegExp, number][] = [
    [/(\d+)\s*(?:d(?![a-ce-z])|days?)\b/i, 86400],
    [/(\d+)\s*(?:h(?![a-z])|hours?)\b/i, 3600],
    [/(\d+)\s*(?:m(?![a-rt-z])|min(?:ute)?s?)\b/i, 60],
    [/(\d+)\s*(?:s(?![a-z])|sec(?:ond)?s?)\b/i, 1]
  ];
  let seconds = 0;
  let matched = false;
  for (const [pattern, scale] of units) {
    const m = text.match(pattern);
    if (!m) continue;
    seconds += Number(m[1]) * scale;
    matched = true;
  }
  return matched ? seconds : null;
}
