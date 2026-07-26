import type { FileHandle } from "node:fs/promises";

import type { AnalysisFinding } from "../../../domain/print/types";
import { resolveUnits, type ResolvedUnits } from "../../../domain/shared/units";
import {
  addPoint,
  mergeBounds,
  newBounds,
  normalizeGeometry,
  type BoundsAccumulator,
  type NormalizedGeometry
} from "./geometry";
import {
  countPlateEntries,
  readPlateAssignment,
  resolvePlates,
  type PlacedItem,
  type PlateAssignment
} from "./threemfPlates";
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
 *
 * ## How the size is computed
 *
 * A 3MF's coordinates mean nothing without three things, and all three are
 * honoured here:
 *
 *   1. **The declared unit.** `<model unit="…">` may be micron, millimeter,
 *      centimetre, metre, inch or foot; the spec's default (millimetre) applies
 *      only when the attribute is absent. The box is converted to mm exactly
 *      once, in {@link file://./geometry.ts normalizeGeometry}. A unit we cannot
 *      map is reported as unknown — never silently treated as millimetres.
 *   2. **The transforms.** Only what the `<build>` places is printed, each item
 *      through its own matrix, and each nested `<component>` through the
 *      composition of its parent's. Vertices are folded into the box *after*
 *      transformation, so a scaled/rotated/translated instance measures what it
 *      will actually occupy.
 *   3. **The plates.** A slicer project may hold several plates — several
 *      separate prints. Their union is not the size of anything that will be
 *      printed, so a multi-plate package publishes per-plate boxes and withholds
 *      the merged one (see {@link NormalizedGeometry}).
 */

const MODEL_CANDIDATES = ["3D/3dmodel.model", "3D/3Dmodel.model"];
const CONTENT_TYPES = "[Content_Types].xml";
/** Cap on vertices folded into the bounding box, so a dense mesh cannot stall the worker. */
const MAX_BBOX_VERTICES = 2_000_000;
/** Guard against a hostile/degenerate component graph (also caught by cycle detection). */
const MAX_COMPONENT_DEPTH = 20;

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

  const entryNames = zip.entries.map((e) => e.name);
  // Plate → object assignment, when the package records one (OrcaSlicer /
  // BambuStudio projects). Best-effort: an unreadable or unmappable file leaves
  // the plates unattributed, which is reported rather than guessed around.
  const plateAssignment = await readPlateAssignment(zip, entryNames, limits.xmlMaxBytes);
  const modelInfo = extractModel(model, warnings, {
    plateAssignment,
    entryPlateCount: countPlateEntries(entryNames)
  });
  warnings.push(...modelInfo.geometryWarnings);
  blockers.push(...modelInfo.geometryBlockers);

  const payload = classifyEntries(entryNames);
  const threeMfClass = payload.threeMfClass;
  const geometry = modelInfo.geometry;
  const data: Record<string, unknown> = {
    threeMfClass,
    // The resolved canonical unit ("millimeter", "inch", … or "unknown" when the
    // file declared something we cannot convert). Legacy readers key off this.
    units: geometry.sourceUnits,
    declaredUnits: geometry.declaredUnits,
    objectCount: modelInfo.objectCount,
    buildItemCount: modelInfo.buildItemCount,
    plateCount: geometry.plateCount,
    hasThumbnail: payload.hasThumbnail,
    hasEmbeddedProfiles: payload.hasEmbeddedProfiles,
    hasGcodePayload: payload.hasGcode,
    slicer: modelInfo.slicer,
    // Legacy shape: the box in the file's own units (NOT millimetres). Kept for
    // readers written before `geometry`; new code reads `geometry.sizeMm`.
    bbox:
      geometry.minRaw && geometry.maxRaw && geometry.sizeRaw
        ? { min: geometry.minRaw, max: geometry.maxRaw, size: geometry.sizeRaw }
        : null,
    geometry,
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

/**
 * What the auxiliary entries say the package *is*: a plain model, a slicer
 * project awaiting slicing, or a sliced payload carrying G-code. The file name
 * never decides this — only what the archive actually contains.
 */
function classifyEntries(entryNames: string[]): {
  threeMfClass: "sliced" | "slicer_project" | "generic";
  hasGcode: boolean;
  hasThumbnail: boolean;
  hasEmbeddedProfiles: boolean;
} {
  const hasGcode = entryNames.some((n) => /\.gcode(\.\w+)?$/i.test(n) || /\.gcode$/i.test(n));
  const hasSlicerProject = entryNames.some((n) =>
    /Metadata\/(project_settings|model_settings|slice_info|process_settings)\.config$/i.test(n)
  );
  return {
    threeMfClass: hasGcode ? "sliced" : hasSlicerProject ? "slicer_project" : "generic",
    hasGcode,
    hasThumbnail: entryNames.some((n) => /\.(png|jpg|jpeg)$/i.test(n) || /thumbnail/i.test(n)),
    hasEmbeddedProfiles: entryNames.some((n) => /Metadata\/.*\.config$/i.test(n))
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
  objectCount: number;
  buildItemCount: number;
  slicer: string | null;
  geometry: NormalizedGeometry;
  geometryWarnings: AnalysisFinding[];
  geometryBlockers: AnalysisFinding[];
}

function extractModel(
  parsed: unknown,
  warnings: AnalysisFinding[],
  context: { plateAssignment: PlateAssignment | null; entryPlateCount: number }
): ModelInfo {
  const root = asRecord(parsed);
  const model = asRecord(root.model);
  const units = readUnit(model);

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

  const traversal: TraversalState = {
    vertices: 0,
    truncated: false,
    badTransforms: 0,
    missingObjects: 0,
    cycles: 0,
    degenerateTransforms: 0
  };

  // Each build item is accumulated on its own, so plates can be scoped later
  // without re-reading the mesh.
  const placed: PlacedItem[] = [];
  items.forEach((item, index) => {
    const rec = asRecord(item);
    const objectId = String(rec["@_objectid"] ?? "");
    const transform = parseTransform(rec["@_transform"], traversal);
    const bounds = newBounds();
    accumulateObject(objectId, transform, objectsById, bounds, traversal, [], 0);
    placed.push({ position: index + 1, objectId, bounds });
  });

  const scene = newBounds();
  for (const item of placed) mergeBounds(scene, item.bounds);

  if (traversal.badTransforms > 0) {
    warnings.push(
      finding(
        "threemf_bad_transform",
        `Некорректная матрица преобразования (${traversal.badTransforms}) — объект размещён без неё, габариты могут быть занижены`
      )
    );
  }
  if (traversal.degenerateTransforms > 0) {
    warnings.push(
      finding(
        "threemf_degenerate_transform",
        `Вырожденное преобразование (${traversal.degenerateTransforms}) — объект схлопнут в плоскость или точку`
      )
    );
  }
  if (traversal.missingObjects > 0) {
    warnings.push(
      finding(
        "threemf_missing_object",
        `Ссылка на несуществующий объект (${traversal.missingObjects}) — часть сцены не учтена в габаритах`
      )
    );
  }
  if (traversal.cycles > 0) {
    warnings.push(
      finding("threemf_component_cycle", "Циклическая ссылка между компонентами — обход прерван")
    );
  }
  if (items.length === 0 && objects.length > 0) {
    warnings.push(
      finding(
        "threemf_no_build_items",
        "В <build> нет ни одного элемента — печатать нечего, габариты не определены"
      )
    );
  }

  const plates = resolvePlates(placed, context.plateAssignment, context.entryPlateCount);
  const normalized = normalizeGeometry({
    prefix: "threemf",
    bounds: scene,
    units,
    // What will actually be printed: the build items resolved to real objects.
    objectCount: placed.filter((p) => objectsById.has(p.objectId)).length,
    plateCount: plates.count,
    plates: plates.scoped,
    truncated: traversal.truncated
  });

  return {
    objectCount: objects.length,
    buildItemCount: items.length,
    slicer,
    geometry: normalized.geometry,
    geometryWarnings: normalized.warnings,
    geometryBlockers: normalized.blockers
  };
}

/**
 * The model's unit. The 3MF core spec defaults an *absent* `unit` attribute to
 * millimetre — but only an absent one: a present-and-unreadable value is an
 * unknown unit, not a millimetre.
 */
function readUnit(model: Record<string, unknown>): ResolvedUnits {
  const raw = model["@_unit"];
  if (typeof raw !== "string" || raw.trim() === "") {
    return { units: "millimeter", mmPerUnit: 1, declared: null, unrecognized: false };
  }
  return resolveUnits(raw);
}

/** Counters for the malformed-but-not-fatal things a component graph can contain. */
interface TraversalState {
  vertices: number;
  truncated: boolean;
  badTransforms: number;
  missingObjects: number;
  cycles: number;
  degenerateTransforms: number;
}

function accumulateObject(
  objectId: string,
  worldTransform: Matrix,
  objectsById: Map<string, Record<string, unknown>>,
  bounds: BoundsAccumulator,
  state: TraversalState,
  chain: readonly string[],
  depth: number
): void {
  if (depth > MAX_COMPONENT_DEPTH || state.truncated) return;
  const object = objectsById.get(objectId);
  if (!object) {
    state.missingObjects++;
    return;
  }
  if (chain.includes(objectId)) {
    // A component graph that references an ancestor would recurse forever;
    // stop and say so instead of silently multiplying the geometry.
    state.cycles++;
    return;
  }

  const mesh = asRecord(object.mesh);
  const vertices = asArray(asRecord(mesh.vertices).vertex as unknown);
  for (const v of vertices) {
    if (state.vertices >= MAX_BBOX_VERTICES) {
      state.truncated = true;
      return;
    }
    state.vertices++;
    const rec = asRecord(v);
    const p = applyTransform(
      [Number(rec["@_x"]), Number(rec["@_y"]), Number(rec["@_z"])],
      worldTransform
    );
    // Non-finite / absurd coordinates are counted by the accumulator and become
    // analysis blockers — never quietly dropped from the box.
    addPoint(bounds, p[0], p[1], p[2]);
  }

  // Nested components reference other objects with their own transforms.
  const components = asArray(asRecord(object.components).component as unknown);
  for (const c of components) {
    const rec = asRecord(c);
    const childId = String(rec["@_objectid"] ?? "");
    const childTransform = parseTransform(rec["@_transform"], state);
    accumulateObject(
      childId,
      multiply(worldTransform, childTransform),
      objectsById,
      bounds,
      state,
      [...chain, objectId],
      depth + 1
    );
    if (state.truncated) return;
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

// ── Transform maths (row-vector · matrix convention, per the 3MF spec) ────────

/**
 * Parses a `transform` attribute: 12 finite numbers, linear 3×3 row-major
 * followed by the translation. An absent attribute is legal (identity); a
 * *present but unparseable* one is not — it is counted so the analysis can say
 * the object was placed without its transform rather than pretending it had none.
 */
function parseTransform(value: unknown, state: TraversalState): Matrix {
  if (value === undefined || value === null) return IDENTITY;
  if (typeof value !== "string") {
    state.badTransforms++;
    return IDENTITY;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    state.badTransforms++;
    return IDENTITY;
  }
  const nums = trimmed.split(/\s+/).map(Number);
  if (nums.length !== 12 || nums.some((n) => !Number.isFinite(n))) {
    state.badTransforms++;
    return IDENTITY;
  }
  if (determinant(nums) === 0) {
    // A singular linear part collapses the object; the resulting degenerate box
    // is a blocker downstream, but the *cause* belongs in the findings here.
    state.degenerateTransforms++;
  }
  return nums;
}

/** Determinant of the linear 3×3 part — zero means the transform is singular. */
function determinant(m: Matrix): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
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
