import type { AnalysisFinding } from "../../../domain/print/types";
import { resolveUnits, type ResolvedUnits } from "../../../domain/shared/units";
import { addPoint, mergeBounds, newBounds, type BoundsAccumulator } from "./geometry";
import type { PlacedItem } from "./threemfPlates";
import { finding, type AnalyzerLimits } from "./types";
import { asArray, parseSafeXml, XmlSafetyError } from "./xml";
import { SafeZip, ZipSafetyError } from "./zip";

/**
 * Resolving a 3MF package into *what will actually be printed*: the build items,
 * each object's mesh, and the transform chain that places them.
 *
 * Two things here are less obvious than they look.
 *
 * **Objects can live in other parts.** The 3MF *production extension* (`xmlns:p`,
 * used by Bambu Studio and OrcaSlicer for anything but the most trivial project)
 * lets a `<component>` or `<item>` name `p:path="/3D/Objects/Cube_1.model"` and
 * reference an object id defined in *that* part. Ids are scoped per part, so the
 * index is keyed `(part, id)`. Reading only the root model — as this analyzer
 * originally did — makes every such reference dangle: the package looks like it
 * builds nothing and reports no size at all, which is exactly the case where a
 * size is most needed. Parts are loaded breadth-first, bounded by a part count
 * and a shared XML byte budget.
 *
 * **Meshes are not parsed into objects.** A `<mesh>` is left as raw text by the
 * XML parser (`rawNodes`) and scanned here for its `<vertex>` coordinates. A DOM
 * of 100k+ vertex nodes is what made a 18 MB model take ~19 s of a 30 s analysis
 * budget; the scan does the same work in a fraction of it and, unlike a
 * bounding-box shortcut, still transforms every vertex individually — so a
 * rotated instance measures what it really occupies, not the box around it.
 */

/** Cap on vertices folded into the bounding box, so a dense mesh cannot stall the worker. */
const MAX_BBOX_VERTICES = 2_000_000;
/** Guard against a hostile/degenerate component graph (also caught by cycle detection). */
const MAX_COMPONENT_DEPTH = 20;
/** Cap on external `.model` parts loaded for one package. */
const MAX_MODEL_PARTS = 512;

type Matrix = number[]; // 12 numbers: linear 3x3 (row-major) + translation

const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export interface SceneResult {
  /** Objects declared in `<resources>` across every loaded part. */
  objectCount: number;
  buildItemCount: number;
  /** Build items that resolved to a real object — what the geometry describes. */
  resolvedItemCount: number;
  placed: PlacedItem[];
  scene: BoundsAccumulator;
  units: ResolvedUnits;
  slicer: string | null;
  /** Number of `.model` parts read (1 = root only). */
  partCount: number;
  truncated: boolean;
  warnings: AnalysisFinding[];
}

/**
 * Resolves the whole package into placed build items with transform-aware
 * bounds. `rootModel` is the already-parsed root `.model` document; further
 * parts are read from `zip` on demand.
 */
export async function buildScene(
  zip: SafeZip,
  rootPart: string,
  rootModel: unknown,
  limits: AnalyzerLimits
): Promise<SceneResult> {
  const warnings: AnalysisFinding[] = [];
  const index = await loadParts(zip, rootPart, rootModel, limits, warnings);

  const root = asRecord(asRecord(rootModel).model);
  const build = asRecord(root.build);
  const items = asArray(build.item as unknown);
  const state: TraversalState = {
    vertices: 0,
    truncated: false,
    badTransforms: 0,
    missingObjects: 0,
    cycles: 0,
    degenerateTransforms: 0,
    badVertices: 0
  };

  const placed: PlacedItem[] = [];
  let resolvedItemCount = 0;
  items.forEach((item, i) => {
    const rec = asRecord(item);
    const objectId = String(rec["@_objectid"] ?? "");
    const part = resolvePart(index, rootPart, rec["@_p:path"]);
    const bounds = newBounds();
    const resolved = accumulate(
      { part, objectId },
      parseTransform(rec["@_transform"], state),
      index,
      bounds,
      state,
      [],
      0
    );
    if (resolved) resolvedItemCount++;
    placed.push({ position: i + 1, objectId, bounds });
  });

  const scene = newBounds();
  for (const item of placed) mergeBounds(scene, item.bounds);

  const objectCount = [...index.parts.values()].reduce((n, p) => n + p.size, 0);
  collectWarnings(state, warnings, { itemCount: items.length, objectCount });

  return {
    objectCount,
    buildItemCount: items.length,
    resolvedItemCount,
    placed,
    scene,
    units: readUnit(root),
    slicer: extractSlicer(asArray(root.metadata as unknown)),
    partCount: index.parts.size,
    truncated: state.truncated,
    warnings
  };
}

// ── Part index ───────────────────────────────────────────────────────────────

interface PartIndex {
  /** part entry name → object id → object element. */
  parts: Map<string, Map<string, Record<string, unknown>>>;
}

/**
 * Breadth-first load of the root part plus every `.model` part reachable through
 * a `p:path` reference. Bounded by {@link MAX_MODEL_PARTS} and by a byte budget
 * shared across all parts, so a package cannot make the analyzer read forever.
 * A part that cannot be read is reported and skipped — its objects then show up
 * as the "missing object" warning, which is truthful, rather than as silence.
 */
async function loadParts(
  zip: SafeZip,
  rootPart: string,
  rootModel: unknown,
  limits: AnalyzerLimits,
  warnings: AnalysisFinding[]
): Promise<PartIndex> {
  const parts = new Map<string, Map<string, Record<string, unknown>>>();
  let budget = limits.xmlMaxBytes;
  let failed = 0;

  const queue: { name: string; model: unknown }[] = [{ name: rootPart, model: rootModel }];
  const seen = new Set<string>([rootPart]);

  while (queue.length > 0) {
    const current = queue.shift() as { name: string; model: unknown };
    const model = asRecord(asRecord(current.model).model);
    parts.set(current.name, indexObjects(model));

    for (const raw of referencedPaths(model)) {
      const resolved = zip.resolve(normalizePartPath(raw));
      if (!resolved) {
        warnings.push(
          finding(
            "threemf_missing_part",
            `Внутри 3MF нет части «${raw}», на которую ссылается модель`,
            "Пересохраните проект в слайсере — часть модели потерялась при сборке файла."
          )
        );
        continue;
      }
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      if (parts.size + queue.length >= MAX_MODEL_PARTS) {
        warnings.push(
          finding(
            "threemf_parts_truncated",
            `В пакете больше ${MAX_MODEL_PARTS} частей модели — часть сцены не учтена в габаритах`
          )
        );
        queue.length = 0;
        break;
      }
      try {
        const text = (await zip.read(resolved, Math.min(budget, limits.xmlMaxBytes))).toString("utf8");
        budget -= Buffer.byteLength(text, "utf8");
        queue.push({ name: resolved, model: parseSafeXml(text, limits.xmlMaxBytes, MODEL_PARSE) });
        if (budget <= 0) {
          warnings.push(
            finding("threemf_parts_truncated", "Части модели превысили лимит разбора XML — сцена учтена не полностью")
          );
          queue.length = 0;
          break;
        }
      } catch (error) {
        // A sub-part that is corrupt/oversized must not sink the whole analysis:
        // the package's other parts still describe real geometry. Counted and
        // reported once, below.
        if (error instanceof XmlSafetyError || error instanceof ZipSafetyError) failed++;
        else throw error;
      }
    }
  }

  if (failed > 0) {
    warnings.push(
      finding(
        "threemf_part_unreadable",
        `Не удалось прочитать частей модели: ${failed} — габариты могут быть занижены`,
        "Пересохраните проект в слайсере и загрузите снова."
      )
    );
  }
  return { parts };
}

/** Parser options for a `.model` document: mesh bodies stay raw text. */
const MODEL_PARSE = { rawNodes: ["*.mesh"] } as const;

function indexObjects(model: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const obj of asArray(asRecord(model.resources).object as unknown)) {
    const rec = asRecord(obj);
    const id = String(rec["@_id"] ?? "");
    if (id) byId.set(id, rec);
  }
  return byId;
}

/** Every `p:path` a part's build items and components point at. */
function referencedPaths(model: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) out.push(value.trim());
  };
  for (const item of asArray(asRecord(model.build).item as unknown)) push(asRecord(item)["@_p:path"]);
  for (const obj of asArray(asRecord(model.resources).object as unknown)) {
    for (const c of asArray(asRecord(asRecord(obj).components).component as unknown)) {
      push(asRecord(c)["@_p:path"]);
    }
  }
  return out;
}

/** OPC part paths are package-absolute (`/3D/…`); ZIP entry names are not. */
function normalizePartPath(raw: string): string {
  return raw.replace(/^\/+/, "");
}

/** The part a reference lands in — its own `p:path`, or the referrer's part. */
function resolvePart(index: PartIndex, current: string, path: unknown): string {
  if (typeof path !== "string" || !path.trim()) return current;
  const normalized = normalizePartPath(path.trim());
  for (const name of index.parts.keys()) {
    if (name.toLowerCase() === normalized.toLowerCase()) return name;
  }
  return normalized; // unknown → resolves to nothing and is counted as missing
}

// ── Traversal ────────────────────────────────────────────────────────────────

/** Counters for the malformed-but-not-fatal things a component graph can contain. */
interface TraversalState {
  vertices: number;
  truncated: boolean;
  badTransforms: number;
  missingObjects: number;
  cycles: number;
  degenerateTransforms: number;
  badVertices: number;
}

interface ObjectRef {
  part: string;
  objectId: string;
}

function refKey(ref: ObjectRef): string {
  return `${ref.part}#${ref.objectId}`;
}

/** Folds one object (mesh + nested components) into `bounds`. Returns whether it resolved. */
function accumulate(
  ref: ObjectRef,
  worldTransform: Matrix,
  index: PartIndex,
  bounds: BoundsAccumulator,
  state: TraversalState,
  chain: readonly string[],
  depth: number
): boolean {
  if (depth > MAX_COMPONENT_DEPTH || state.truncated) return false;
  const object = index.parts.get(ref.part)?.get(ref.objectId);
  if (!object) {
    state.missingObjects++;
    return false;
  }
  const key = refKey(ref);
  if (chain.includes(key)) {
    // A component graph that references an ancestor would recurse forever;
    // stop and say so instead of silently multiplying the geometry.
    state.cycles++;
    return false;
  }

  readMesh(object.mesh, worldTransform, bounds, state);
  if (state.truncated) return true;

  // Nested components reference other objects — possibly in another part —
  // with their own transforms.
  for (const c of asArray(asRecord(object.components).component as unknown)) {
    const rec = asRecord(c);
    accumulate(
      { part: resolvePart(index, ref.part, rec["@_p:path"]), objectId: String(rec["@_objectid"] ?? "") },
      multiply(worldTransform, parseTransform(rec["@_transform"], state)),
      index,
      bounds,
      state,
      [...chain, key],
      depth + 1
    );
    if (state.truncated) break;
  }
  return true;
}

const VERTEX_TAG = /<vertex\b[^>]*>/g;
const VERTEX_COORD = /\b([xyz])\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Folds a mesh's vertices into `bounds`, each through `transform`. The mesh
 * arrives as the raw text between `<mesh>` tags (see {@link MODEL_PARSE}); the
 * object form is still handled for any caller that parses meshes normally.
 */
function readMesh(
  mesh: unknown,
  transform: Matrix,
  bounds: BoundsAccumulator,
  state: TraversalState
): void {
  if (typeof mesh === "string") {
    VERTEX_TAG.lastIndex = 0;
    let tag: RegExpExecArray | null;
    while ((tag = VERTEX_TAG.exec(mesh)) !== null) {
      if (state.vertices >= MAX_BBOX_VERTICES) {
        state.truncated = true;
        return;
      }
      state.vertices++;
      const p = readCoords(tag[0]);
      if (p) addPoint(bounds, ...applyTransform(p, transform));
      else state.badVertices++;
    }
    return;
  }
  for (const v of asArray(asRecord(asRecord(mesh).vertices).vertex as unknown)) {
    if (state.vertices >= MAX_BBOX_VERTICES) {
      state.truncated = true;
      return;
    }
    state.vertices++;
    const rec = asRecord(v);
    const p = applyTransform(
      [Number(rec["@_x"]), Number(rec["@_y"]), Number(rec["@_z"])],
      transform
    );
    addPoint(bounds, p[0], p[1], p[2]);
  }
}

/**
 * Pulls `x`/`y`/`z` out of one `<vertex …/>` tag. A missing coordinate makes the
 * vertex unusable (counted, not silently read as 0); a *present but non-numeric*
 * one is passed through as `NaN` so the geometry accumulator raises it as the
 * corrupt-coordinate blocker it already knows how to report.
 */
function readCoords(tag: string): [number, number, number] | null {
  let x: number | undefined;
  let y: number | undefined;
  let z: number | undefined;
  VERTEX_COORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VERTEX_COORD.exec(tag)) !== null) {
    const value = Number(m[2] ?? m[3]);
    if (m[1] === "x") x = value;
    else if (m[1] === "y") y = value;
    else z = value;
  }
  return x === undefined || y === undefined || z === undefined ? null : [x, y, z];
}

function collectWarnings(
  state: TraversalState,
  warnings: AnalysisFinding[],
  counts: { itemCount: number; objectCount: number }
): void {
  if (state.badTransforms > 0) {
    warnings.push(
      finding(
        "threemf_bad_transform",
        `Некорректная матрица преобразования (${state.badTransforms}) — объект размещён без неё, габариты могут быть занижены`
      )
    );
  }
  if (state.degenerateTransforms > 0) {
    warnings.push(
      finding(
        "threemf_degenerate_transform",
        `Вырожденное преобразование (${state.degenerateTransforms}) — объект схлопнут в плоскость или точку`
      )
    );
  }
  if (state.missingObjects > 0) {
    warnings.push(
      finding(
        "threemf_missing_object",
        `Ссылка на несуществующий объект (${state.missingObjects}) — часть сцены не учтена в габаритах`
      )
    );
  }
  if (state.cycles > 0) {
    warnings.push(
      finding("threemf_component_cycle", "Циклическая ссылка между компонентами — обход прерван")
    );
  }
  if (state.badVertices > 0) {
    warnings.push(
      finding(
        "threemf_bad_vertex",
        `Вершин без координат: ${state.badVertices} — они исключены из габаритов`
      )
    );
  }
  if (counts.itemCount === 0 && counts.objectCount > 0) {
    warnings.push(
      finding(
        "threemf_no_build_items",
        "В <build> нет ни одного элемента — печатать нечего, габариты не определены"
      )
    );
  }
}

// ── Model metadata ───────────────────────────────────────────────────────────

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
function applyTransform(p: number[], m: Matrix): [number, number, number] {
  return [
    p[0] * m[0] + p[1] * m[3] + p[2] * m[6] + m[9],
    p[0] * m[1] + p[1] * m[4] + p[2] * m[7] + m[10],
    p[0] * m[2] + p[1] * m[5] + p[2] * m[8] + m[11]
  ];
}

/** Composes so applyTransform(p, multiply(parent, child)) === parent(child(p)). */
function multiply(parent: Matrix, child: Matrix): Matrix {
  const Lp = parent;
  const linear = (i: number, j: number): number =>
    child[i * 3] * Lp[j] + child[i * 3 + 1] * Lp[3 + j] + child[i * 3 + 2] * Lp[6 + j];
  const t = (j: number): number =>
    child[9] * Lp[j] + child[10] * Lp[3 + j] + child[11] * Lp[6 + j] + parent[9 + j];
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
