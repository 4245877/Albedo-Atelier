import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import readline from "node:readline";

import type { AnalysisFinding } from "../../../domain/print/types";
import { ANALYZER_VERSION, finding, type AnalyzerResult } from "./types";

/**
 * STL analysis for both binary and ASCII variants.
 *
 * It streams the geometry (never loading a large mesh whole): the binary path
 * reads fixed 50-byte triangle records in chunks, the ASCII path reads line by
 * line. It reports the concrete variant, triangle count, per-axis bounds and the
 * bounding-box size, and flags the corruption a file can carry *without* a full
 * mesh repair: a truncated/over-declared binary body, an empty model, and
 * non-finite (NaN/∞) coordinates.
 *
 * Units are deliberately reported as `unknown` — STL carries no reliable unit —
 * so nothing here claims millimetres. Only heuristic size warnings are emitted
 * (suspiciously tiny/large bounds). A clean STL is always `needs_preparation`:
 * it is a source model that still needs a profile and slicing.
 */

const TRIANGLE_BYTES = 50;
const HEADER_BYTES = 84;
const CHUNK_BYTES = 64 * TRIANGLE_BYTES * 16; // ~51 KiB, whole triangles per chunk

interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
  any: boolean;
  nonFinite: boolean;
}

function newBounds(): Bounds {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    any: false,
    nonFinite: false
  };
}

function addPoint(b: Bounds, x: number, y: number, z: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    b.nonFinite = true;
    return;
  }
  b.any = true;
  const p: [number, number, number] = [x, y, z];
  for (let i = 0; i < 3; i++) {
    if (p[i] < b.min[i]) b.min[i] = p[i];
    if (p[i] > b.max[i]) b.max[i] = p[i];
  }
}

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

  const bounds = geom.bounds;
  if (bounds.nonFinite) {
    blockers.push(finding("stl_non_finite", "Модель содержит нечисловые или бесконечные координаты"));
  }
  if (geom.triangles === 0) {
    blockers.push(finding("stl_empty", "Пустая модель (0 треугольников)"));
  }

  const bbox = bounds.any
    ? {
        min: bounds.min,
        max: bounds.max,
        size: [
          bounds.max[0] - bounds.min[0],
          bounds.max[1] - bounds.min[1],
          bounds.max[2] - bounds.min[2]
        ] as [number, number, number]
      }
    : null;

  if (bbox) {
    const maxDim = Math.max(...bbox.size);
    if (maxDim > 0 && maxDim < 1) {
      warnings.push(
        finding("stl_suspicious_scale", "Подозрительно маленькая модель (единицы измерения неизвестны)")
      );
    } else if (maxDim > 1000) {
      warnings.push(
        finding("stl_suspicious_scale", "Подозрительно большая модель (единицы измерения неизвестны)")
      );
    }
  }

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
      bbox
    },
    analyzer: "stl",
    analyzerVersion: ANALYZER_VERSION
  };
}

interface Geometry {
  triangles: number;
  bounds: Bounds;
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

    let data = remainder.length ? Buffer.concat([remainder, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
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
        const x = Number(parts[1]);
        const y = Number(parts[2]);
        const z = Number(parts[3]);
        addPoint(bounds, x, y, z);
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
