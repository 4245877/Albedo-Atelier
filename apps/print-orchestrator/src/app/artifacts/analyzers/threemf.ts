import type { FileHandle } from "node:fs/promises";

import type { AnalysisFinding } from "../../../domain/print/types";
import { ANALYZER_VERSION, finding, worstVerdict, type AnalyzerResult, type AnalyzerLimits } from "./types";
import { fileHandleSource, SafeZip, ZipSafetyError } from "./zip";
import { asArray, parseSafeXml, XmlSafetyError } from "./xml";

/**
 * 3MF analysis: a `.3mf` is treated as an untrusted OPC (ZIP) container. The
 * archive is opened through {@link SafeZip}, which enforces every ZIP-bomb /
 * traversal / symlink guard *before* anything is inflated; the model XML is
 * parsed through {@link parseSafeXml}, which forbids DTDs and entities.
 *
 * From the model it extracts (best-effort): declared unit, object/build-item
 * counts, a transform-aware bounding box, slicer metadata, thumbnails, embedded
 * slicer profiles and G-code payload. It classifies the file as a generic 3MF
 * model, an OrcaSlicer/BambuStudio project, a sliced/G-code 3MF, or an
 * unknown/unsupported 3MF — and a plain project is never treated as
 * ready-to-print (`needs_preparation`), while a sliced payload follows the same
 * G-code-style verdict rules.
 */

const MODEL_CANDIDATES = ["3D/3dmodel.model", "3D/3Dmodel.model"];
const CONTENT_TYPES = "[Content_Types].xml";
/** Cap on vertices folded into the bounding box, so a dense mesh cannot stall the worker. */
const MAX_BBOX_VERTICES = 2_000_000;

type Matrix = number[]; // 12 numbers: linear 3x3 (row-major) + translation

const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export async function analyze3mf(
  handle: FileHandle,
  size: number,
  limits: AnalyzerLimits
): Promise<AnalyzerResult> {
  const warnings: AnalysisFinding[] = [];
  const blockers: AnalysisFinding[] = [];

  let zip: SafeZip;
  try {
    zip = await SafeZip.open(fileHandleSource(handle, size), {
      maxEntries: limits.zipMaxEntries,
      maxEntryBytes: limits.zipMaxEntryBytes,
      maxTotalBytes: limits.zipMaxTotalBytes,
      maxRatio: limits.zipMaxRatio
    });
  } catch (error) {
    if (error instanceof ZipSafetyError) {
      return blocked3mf(finding(error.code, error.message));
    }
    throw error;
  }

  // A real 3MF is an OPC package: it must carry [Content_Types].xml and a model.
  const hasContentTypes = zip.has(CONTENT_TYPES);
  const modelName = MODEL_CANDIDATES.find((n) => zip.has(n)) ?? zip.find((n) => n.toLowerCase().endsWith(".model"))?.name;

  if (!hasContentTypes || !modelName) {
    return {
      detectedFormat: "3mf",
      verdict: "review",
      warnings: [finding("threemf_not_opc", "Не похоже на корректный 3MF-контейнер (нет [Content_Types].xml или модели)")],
      blockers,
      data: { threeMfClass: "unknown", entries: zip.entries.length },
      analyzer: "3mf",
      analyzerVersion: ANALYZER_VERSION
    };
  }

  // Parse the model XML under the DTD/entity + size guard.
  let model: unknown;
  try {
    const xml = (await zip.read(modelName, limits.xmlMaxBytes)).toString("utf8");
    model = parseSafeXml(xml, limits.xmlMaxBytes);
  } catch (error) {
    if (error instanceof XmlSafetyError) {
      // A DOCTYPE/ENTITY is an attack signal → blocked; malformed → blocked too.
      return blocked3mf(finding(error.code, error.message));
    }
    if (error instanceof ZipSafetyError) {
      return blocked3mf(finding(error.code, error.message));
    }
    throw error;
  }

  const modelInfo = extractModel(model, warnings);

  // Classify by the auxiliary entries.
  const entryNames = zip.entries.map((e) => e.name);
  const hasGcode = entryNames.some((n) => /\.gcode(\.\w+)?$/i.test(n) || /\.gcode$/i.test(n));
  const hasSlicerProject = entryNames.some((n) =>
    /Metadata\/(project_settings|model_settings|slice_info|process_settings)\.config$/i.test(n)
  );
  const hasThumbnail = entryNames.some((n) => /\.(png|jpg|jpeg)$/i.test(n) || /thumbnail/i.test(n));
  const hasEmbeddedProfiles = entryNames.some((n) => /Metadata\/.*\.config$/i.test(n));

  const threeMfClass = hasGcode
    ? "sliced"
    : hasSlicerProject
      ? "slicer_project"
      : "generic";

  const data: Record<string, unknown> = {
    threeMfClass,
    units: modelInfo.unit,
    objectCount: modelInfo.objectCount,
    buildItemCount: modelInfo.buildItemCount,
    plateCount: countPlates(entryNames),
    hasThumbnail,
    hasEmbeddedProfiles,
    hasGcodePayload: hasGcode,
    slicer: modelInfo.slicer,
    bbox: modelInfo.bbox,
    entries: zip.entries.length
  };

  // ── Verdict ─────────────────────────────────────────────────────────────
  let verdict: AnalyzerResult["verdict"];
  let material: string | null = null;

  if (threeMfClass === "sliced") {
    // A sliced / G-code 3MF follows G-code-style rules: usable only with enough
    // data, and never auto-safe as a foreign sliced file.
    const sliceInfo = await readSliceInfo(zip, entryNames, limits.xmlMaxBytes);
    material = sliceInfo.material;
    data.targetPrinter = sliceInfo.printer;
    data.sliceInfo = sliceInfo.raw;

    const verdicts: AnalyzerResult["verdict"][] = ["schedulable"];
    if (!material) verdicts.push("needs_input");
    // Foreign sliced payload + no confirmed target → a human should confirm.
    verdicts.push("review");
    if (!sliceInfo.printer) {
      warnings.push(finding("threemf_unknown_target", "Целевой принтер не подтверждён в sliced 3MF"));
    }
    verdict = worstVerdict(verdicts);
  } else {
    // Generic model or a project: still needs a profile + slicing.
    verdict = "needs_preparation";
    if (threeMfClass === "slicer_project") {
      warnings.push(finding("threemf_project", "Проект слайсера: требуется нарезка перед печатью"));
    }
  }

  return {
    detectedFormat: "3mf",
    verdict: blockers.length > 0 ? "blocked" : verdict,
    warnings,
    blockers,
    data,
    analyzer: "3mf",
    analyzerVersion: ANALYZER_VERSION,
    material
  };
}

function blocked3mf(blocker: AnalysisFinding): AnalyzerResult {
  return {
    detectedFormat: "3mf",
    verdict: "blocked",
    warnings: [],
    blockers: [blocker],
    data: { threeMfClass: "unknown" },
    analyzer: "3mf",
    analyzerVersion: ANALYZER_VERSION
  };
}

// ── Model XML extraction ─────────────────────────────────────────────────────

interface ModelInfo {
  unit: string;
  objectCount: number;
  buildItemCount: number;
  slicer: string | null;
  bbox: { min: number[]; max: number[]; size: number[] } | null;
}

function extractModel(parsed: unknown, warnings: AnalysisFinding[]): ModelInfo {
  const root = asRecord(parsed);
  const model = asRecord(root.model);
  const unit = typeof model["@_unit"] === "string" ? (model["@_unit"] as string) : "millimeter";

  const resources = asRecord(model.resources);
  const objects = asArray(resources.object as unknown);
  const build = asRecord(model.build);
  const items = asArray(build.item as unknown);

  // Index objects by id for build-item resolution and component recursion.
  const objectsById = new Map<string, Record<string, unknown>>();
  for (const obj of objects) {
    const rec = asRecord(obj);
    const id = String(rec["@_id"] ?? "");
    if (id) objectsById.set(id, rec);
  }

  const slicer = extractSlicer(asArray(model.metadata as unknown));

  const bounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    any: false,
    vertices: 0,
    truncated: false
  };

  for (const item of items) {
    const rec = asRecord(item);
    const objectId = String(rec["@_objectid"] ?? "");
    const transform = parseTransform(rec["@_transform"]);
    accumulateObject(objectId, transform, objectsById, bounds, 0);
    if (bounds.truncated) break;
  }

  if (bounds.truncated) {
    warnings.push(finding("threemf_bbox_truncated", "Модель очень плотная — габариты рассчитаны частично"));
  }

  const bbox = bounds.any
    ? {
        min: bounds.min,
        max: bounds.max,
        size: [
          bounds.max[0] - bounds.min[0],
          bounds.max[1] - bounds.min[1],
          bounds.max[2] - bounds.min[2]
        ]
      }
    : null;

  return {
    unit,
    objectCount: objects.length,
    buildItemCount: items.length,
    slicer,
    bbox
  };
}

function accumulateObject(
  objectId: string,
  worldTransform: Matrix,
  objectsById: Map<string, Record<string, unknown>>,
  bounds: { min: number[]; max: number[]; any: boolean; vertices: number; truncated: boolean },
  depth: number
): void {
  if (depth > 20 || bounds.truncated) return;
  const object = objectsById.get(objectId);
  if (!object) return;

  const mesh = asRecord(object.mesh);
  const vertices = asArray(asRecord(mesh.vertices).vertex as unknown);
  for (const v of vertices) {
    if (bounds.vertices >= MAX_BBOX_VERTICES) {
      bounds.truncated = true;
      return;
    }
    bounds.vertices++;
    const rec = asRecord(v);
    const p = applyTransform(
      [Number(rec["@_x"]), Number(rec["@_y"]), Number(rec["@_z"])],
      worldTransform
    );
    if (p.every(Number.isFinite)) {
      bounds.any = true;
      for (let i = 0; i < 3; i++) {
        if (p[i] < bounds.min[i]) bounds.min[i] = p[i];
        if (p[i] > bounds.max[i]) bounds.max[i] = p[i];
      }
    }
  }

  // Nested components reference other objects with their own transforms.
  const components = asArray(asRecord(object.components).component as unknown);
  for (const c of components) {
    const rec = asRecord(c);
    const childId = String(rec["@_objectid"] ?? "");
    const childTransform = parseTransform(rec["@_transform"]);
    accumulateObject(childId, multiply(worldTransform, childTransform), objectsById, bounds, depth + 1);
    if (bounds.truncated) return;
  }
}

function extractSlicer(metadata: unknown[]): string | null {
  for (const entry of metadata) {
    const rec = asRecord(entry);
    const name = String(rec["@_name"] ?? "").toLowerCase();
    if (name.includes("application")) {
      const value = rec["#text"];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

async function readSliceInfo(
  zip: SafeZip,
  entryNames: string[],
  maxBytes: number
): Promise<{ material: string | null; printer: string | null; raw: Record<string, unknown> | null }> {
  const infoName = entryNames.find((n) => /Metadata\/slice_info\.config$/i.test(n));
  if (!infoName) return { material: null, printer: null, raw: null };
  try {
    const xml = (await zip.read(infoName, maxBytes)).toString("utf8");
    const parsed = parseSafeXml(xml, maxBytes);
    const config = asRecord(asRecord(parsed).config);
    const plate = asArray(config.plate as unknown)[0];
    const metadata = asArray(asRecord(plate).metadata as unknown);
    let material: string | null = null;
    let printer: string | null = null;
    for (const m of metadata) {
      const rec = asRecord(m);
      const key = String(rec["@_key"] ?? "").toLowerCase();
      const value = rec["@_value"];
      if (typeof value !== "string") continue;
      if (key.includes("filament") && key.includes("type") && !material) material = value;
      if (key.includes("printer") && !printer) printer = value;
    }
    return { material, printer, raw: { source: infoName } };
  } catch {
    return { material: null, printer: null, raw: null };
  }
}

function countPlates(entryNames: string[]): number {
  const plates = new Set<string>();
  for (const name of entryNames) {
    const m = name.match(/plate_(\d+)/i);
    if (m) plates.add(m[1]);
  }
  return plates.size;
}

// ── Transform maths (row-vector · matrix convention, per the 3MF spec) ────────

function parseTransform(value: unknown): Matrix {
  if (typeof value !== "string") return IDENTITY;
  const nums = value.trim().split(/\s+/).map(Number);
  if (nums.length !== 12 || nums.some((n) => !Number.isFinite(n))) return IDENTITY;
  return nums;
}

/** Transforms a point by an affine matrix: p' = p·L + t. */
function applyTransform(p: number[], m: Matrix): number[] {
  return [
    p[0] * m[0] + p[1] * m[3] + p[2] * m[6] + m[9],
    p[0] * m[1] + p[1] * m[4] + p[2] * m[7] + m[10],
    p[0] * m[2] + p[1] * m[5] + p[2] * m[8] + m[11]
  ];
}

/** Composes so applyTransform(p, multiply(parent, child)) === parent(child(p)). */
function multiply(parent: Matrix, child: Matrix): Matrix {
  const Lc = [child[0], child[1], child[2], child[3], child[4], child[5], child[6], child[7], child[8]];
  const Lp = [parent[0], parent[1], parent[2], parent[3], parent[4], parent[5], parent[6], parent[7], parent[8]];
  const linear = (i: number, j: number): number =>
    Lc[i * 3] * Lp[j] + Lc[i * 3 + 1] * Lp[3 + j] + Lc[i * 3 + 2] * Lp[6 + j];
  const tc = [child[9], child[10], child[11]];
  const t = (j: number): number => tc[0] * Lp[j] + tc[1] * Lp[3 + j] + tc[2] * Lp[6 + j] + parent[9 + j];
  return [
    linear(0, 0), linear(0, 1), linear(0, 2),
    linear(1, 0), linear(1, 1), linear(1, 2),
    linear(2, 0), linear(2, 1), linear(2, 2),
    t(0), t(1), t(2)
  ];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
