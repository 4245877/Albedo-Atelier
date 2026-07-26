import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import readline from "node:readline";

import type { AnalysisFinding } from "../../../domain/print/types";
import { unknownUnits } from "../../../domain/shared/units";
import {
  addPoint,
  newBounds,
  normalizeGeometry,
  type BoundsAccumulator
} from "./geometry";
import { ANALYZER_VERSION, finding, type AnalyzerResult } from "./types";

/**
 * STL analysis for both binary and ASCII variants.
 *
 * It streams the geometry (never loading a large mesh whole): the binary path
 * reads fixed 50-byte triangle records in chunks, the ASCII path reads line by
 * line. It reports the concrete variant, triangle count, per-axis bounds and the
 * bounding-box size, and flags the corruption a file can carry *without* a full
 * mesh repair: a truncated/over-declared binary body, an empty model, non-finite
 * (NaN/∞) coordinates, absurd magnitudes and a degenerate (zero-extent) box.
 *
 * **The format stores no unit.** That is the single most important fact about an
 * STL here, and it is represented structurally rather than as a caveat: the
 * normalized {@link file://./geometry.ts geometry} comes back with `sizeMm ===
 * null` and `scaleKnown === false`, so no consumer can read millimetres out of
 * it. The raw numbers are still published (`sizeRaw`, and the legacy `bbox`) for
 * display and for the moment an operator confirms what they mean — see
 * {@link file://../../../domain/print/modelScale.ts ModelScaleConfirmation}.
 * Until that confirmation exists the scheduler treats the size as unproven, and
 * an unattended start is refused.
 *
 * A clean STL is always `needs_preparation`: it is a source model that still
 * needs a profile and slicing.
 */

const TRIANGLE_BYTES = 50;
const HEADER_BYTES = 84;
const CHUNK_BYTES = 64 * TRIANGLE_BYTES * 16; // ~51 KiB, whole triangles per chunk

export async function analyzeStl(
  handle: FileHandle,
  path: string,
  size: number,
  variant: "binary" | "ascii"
): Promise<AnalyzerResult> {
  const warnings: AnalysisFinding[] = [];
  const blockers: AnalysisFinding[] = [];

  const geom =
    variant === "binary"
      ? await readBinary(handle, size, blockers, warnings)
      : await readAscii(path, blockers);

  if (geom.triangles === 0) {
    blockers.push(finding("stl_empty", "Пустая модель (0 треугольников)"));
  }

  // An STL declares no unit at all — not "millimetre by default", genuinely none.
  const normalized = normalizeGeometry({
    prefix: "stl",
    bounds: geom.bounds,
    units: unknownUnits(),
    objectCount: geom.triangles > 0 ? 1 : 0,
    plateCount: geom.triangles > 0 ? 1 : 0
  });
  warnings.push(...normalized.warnings);
  blockers.push(...normalized.blockers);

  const geometry = normalized.geometry;

  return {
    detectedFormat: "stl",
    // A source model is never schedulable — it needs a profile + slicing.
    verdict: blockers.length > 0 ? "blocked" : "needs_preparation",
    warnings,
    blockers,
    data: {
      stlVariant: variant,
      triangles: geom.triangles,
      units: "unknown",
      // Legacy shape, kept for readers written before `geometry` existed. These
      // are the file's own numbers — deliberately NOT millimetres.
      bbox:
        geometry.minRaw && geometry.maxRaw && geometry.sizeRaw
          ? { min: geometry.minRaw, max: geometry.maxRaw, size: geometry.sizeRaw }
          : null,
      geometry
    },
    analyzer: "stl",
    analyzerVersion: ANALYZER_VERSION
  };
}

interface Geometry {
  triangles: number;
  bounds: BoundsAccumulator;
}

async function readBinary(
  handle: FileHandle,
  size: number,
  blockers: AnalysisFinding[],
  warnings: AnalysisFinding[]
): Promise<Geometry> {
  const bounds = newBounds();
  if (size < HEADER_BYTES) {
    blockers.push(finding("stl_truncated", "Обрезанный бинарный STL (нет заголовка)"));
    return { triangles: 0, bounds };
  }

  const header = Buffer.allocUnsafe(HEADER_BYTES);
  await handle.read(header, 0, HEADER_BYTES, 0);
  const declared = header.readUInt32LE(80);
  const expected = HEADER_BYTES + declared * TRIANGLE_BYTES;

  if (size < expected) {
    blockers.push(
      finding("stl_truncated", `Обрезанный бинарный STL: заявлено ${declared} треугольников, файл короче`)
    );
  } else if (size > expected) {
    warnings.push(finding("stl_trailing_data", "После треугольников есть лишние байты"));
  }

  let offset = HEADER_BYTES;
  let remainder = Buffer.alloc(0);
  let triangles = 0;

  while (offset < size && triangles < declared) {
    const toRead = Math.min(CHUNK_BYTES, size - offset);
    const buf = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await handle.read(buf, 0, toRead, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;

    const data = remainder.length ? Buffer.concat([remainder, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
    let pos = 0;
    while (pos + TRIANGLE_BYTES <= data.length && triangles < declared) {
      // Skip the 12-byte normal; read the 3 vertices (9 floats).
      for (let v = 0; v < 3; v++) {
        const base = pos + 12 + v * 12;
        addPoint(bounds, data.readFloatLE(base), data.readFloatLE(base + 4), data.readFloatLE(base + 8));
      }
      pos += TRIANGLE_BYTES;
      triangles++;
    }
    remainder = data.subarray(pos);
  }

  if (triangles < declared) {
    blockers.push(
      finding("stl_truncated", `Прочитано ${triangles} из ${declared} заявленных треугольников`)
    );
  }
  return { triangles, bounds };
}

async function readAscii(path: string, blockers: AnalysisFinding[]): Promise<Geometry> {
  const bounds = newBounds();
  let facets = 0;
  let vertices = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(path, { encoding: "latin1" }),
    crlfDelay: Infinity
  });
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (line.length === 0) continue;
      const lower = line.toLowerCase();
      if (lower.startsWith("facet")) {
        facets++;
      } else if (lower.startsWith("vertex")) {
        vertices++;
        const parts = line.split(/\s+/);
        // A short/garbled `vertex` line yields NaN here, which the accumulator
        // counts as non-finite → a blocker, rather than a silently smaller box.
        addPoint(bounds, Number(parts[1]), Number(parts[2]), Number(parts[3]));
      }
    }
  } finally {
    rl.close();
  }

  if (facets === 0 && vertices > 0) {
    // vertices without facet wrappers → structurally broken ASCII STL.
    blockers.push(finding("stl_corrupt", "Повреждённая структура ASCII STL (нет facet)"));
  }
  // Triangles come from facet count; fall back to vertex/3 if facets are absent.
  const triangles = facets > 0 ? facets : Math.floor(vertices / 3);
  return { triangles, bounds };
}
