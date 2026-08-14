import type { FileHandle } from "node:fs/promises";

import type { AnalysisFinding } from "../../../domain/print/types";
import { normalizeGeometry, type NormalizedGeometry } from "./geometry";
import { countPlateEntries, readPlateAssignment, resolvePlates } from "./threemfPlates";
import { buildScene } from "./threemfScene";
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
 *   2. **The transforms — and the parts.** Only what the `<build>` places is
 *      printed, each item through its own matrix and each nested `<component>`
 *      through the composition of its parent's, including components that live
 *      in a *separate* `.model` part (the production extension Bambu Studio and
 *      OrcaSlicer use). See {@link file://./threemfScene.ts buildScene}.
 *   3. **The plates.** A slicer project may hold several plates — several
 *      separate prints. Their union is not the size of anything that will be
 *      printed, so a multi-plate package publishes per-plate boxes and withholds
 *      the merged one (see {@link NormalizedGeometry}).
 */

/**
 * The conventional model part. OPC compares part names case-insensitively, so
 * this is resolved through {@link SafeZip.resolve} rather than matched exactly —
 * writers do differ in the spelling of `3dmodel.model`.
 */
const MODEL_PART = "3D/3dmodel.model";
const CONTENT_TYPES = "[Content_Types].xml";
/** A real G-code payload entry (a `.gcode.md5` sidecar is NOT one). */
const GCODE_ENTRY = /\.(gcode|gco|g)$/i;

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
      return blocked3mf(finding(error.code, error.message, error.hint ?? ZIP_HINT));
    }
    throw error;
  }

  // A real 3MF is an OPC package: it carries [Content_Types].xml and a model
  // part. Both are resolved case-insensitively (OPC part names are), and the two
  // are judged separately: a package whose model is readable is analysed even
  // when the content-types part is missing — that is a defect worth reporting,
  // not a reason to call a readable model "unknown".
  const hasContentTypes = zip.resolve(CONTENT_TYPES) !== null;
  const modelName = zip.resolve(MODEL_PART) ?? zip.find((n) => n.toLowerCase().endsWith(".model"))?.name;

  if (!modelName) {
    return unknown3mf(zip.entries.map((e) => e.name), hasContentTypes);
  }
  if (!hasContentTypes) {
    warnings.push(
      finding(
        "threemf_no_content_types",
        "В контейнере нет [Content_Types].xml — 3MF собран не по спецификации",
        "Файл разобран по модели внутри него; если что-то выглядит не так, пересохраните его в слайсере."
      )
    );
  }

  // Parse the model XML under the DTD/entity + size guard.
  let model: unknown;
  try {
    const xml = (await zip.read(modelName, limits.xmlMaxBytes)).toString("utf8");
    // Mesh bodies stay raw text and are scanned in `buildScene`; see there for why.
    model = parseSafeXml(xml, limits.xmlMaxBytes, { rawNodes: ["*.mesh"] });
  } catch (error) {
    if (error instanceof XmlSafetyError) {
      // A DOCTYPE/ENTITY is an attack signal → blocked; malformed → blocked too.
      return blocked3mf(finding(error.code, error.message, XML_HINT));
    }
    if (error instanceof ZipSafetyError) {
      return blocked3mf(finding(error.code, error.message, error.hint ?? ZIP_HINT));
    }
    throw error;
  }

  const entryNames = zip.entries.map((e) => e.name);
  // Plate → object assignment, when the package records one (OrcaSlicer /
  // BambuStudio projects). Best-effort: an unreadable or unmappable file leaves
  // the plates unattributed, which is reported rather than guessed around.
  const plateAssignment = await readPlateAssignment(zip, entryNames, limits.xmlMaxBytes);
  const scene = await buildScene(zip, modelName, model, limits);
  warnings.push(...scene.warnings);

  const plates = resolvePlates(scene.placed, plateAssignment, countPlateEntries(entryNames));
  const normalized = normalizeGeometry({
    prefix: "threemf",
    bounds: scene.scene,
    units: scene.units,
    // What will actually be printed: the build items resolved to real objects.
    objectCount: scene.resolvedItemCount,
    plateCount: plates.count,
    plates: plates.scoped,
    truncated: scene.truncated
  });
  warnings.push(...normalized.warnings);
  blockers.push(...normalized.blockers);

  const payload = classifyEntries(entryNames);
  const producer = detectProducer(scene.slicer, entryNames);
  const data = describe(payload, producer, scene, normalized.geometry, zip.entries.length);
  const outcome = await decide(payload.threeMfClass, producer, zip, entryNames, limits, warnings);
  Object.assign(data, outcome.data);

  return {
    detectedFormat: "3mf",
    verdict: blockers.length > 0 ? "blocked" : outcome.verdict,
    warnings,
    blockers,
    data,
    analyzer: "3mf",
    analyzerVersion: ANALYZER_VERSION,
    material: outcome.material
  };
}

/** The structured payload the dashboard and the scheduler read off an analysis. */
function describe(
  payload: EntryClassification,
  producer: ThreeMfProducer | null,
  scene: Awaited<ReturnType<typeof buildScene>>,
  geometry: NormalizedGeometry,
  entryCount: number
): Record<string, unknown> {
  return {
    threeMfClass: payload.threeMfClass,
    // Which tool wrote the package, when it can be told apart — the operator's
    // first question about a 3MF, and what decides whether the embedded profile
    // means anything to us. `null` = the package does not say.
    producer,
    gcodeEntries: payload.gcodeEntries,
    // The resolved canonical unit ("millimeter", "inch", … or "unknown" when the
    // file declared something we cannot convert). Legacy readers key off this.
    units: geometry.sourceUnits,
    declaredUnits: geometry.declaredUnits,
    objectCount: scene.objectCount,
    buildItemCount: scene.buildItemCount,
    /** `.model` parts read — >1 means the production extension is in use. */
    modelPartCount: scene.partCount,
    plateCount: geometry.plateCount,
    hasThumbnail: payload.hasThumbnail,
    hasEmbeddedProfiles: payload.hasEmbeddedProfiles,
    hasGcodePayload: payload.hasGcode,
    slicer: scene.slicer,
    // Legacy shape: the box in the file's own units (NOT millimetres). Kept for
    // readers written before `geometry`; new code reads `geometry.sizeMm`.
    bbox:
      geometry.minRaw && geometry.maxRaw && geometry.sizeRaw
        ? { min: geometry.minRaw, max: geometry.maxRaw, size: geometry.sizeRaw }
        : null,
    geometry,
    entries: entryCount
  };
}

/**
 * What should happen to the file next. Two shapes only: a sliced payload follows
 * the G-code rules (and is never auto-safe as a foreign slice), anything else is
 * a source model that still needs a profile and a slicing run.
 */
async function decide(
  threeMfClass: EntryClassification["threeMfClass"],
  producer: ThreeMfProducer | null,
  zip: SafeZip,
  entryNames: string[],
  limits: AnalyzerLimits,
  warnings: AnalysisFinding[]
): Promise<{
  verdict: AnalyzerResult["verdict"];
  material: string | null;
  data: Record<string, unknown>;
}> {
  if (threeMfClass !== "sliced") {
    if (threeMfClass === "slicer_project") {
      warnings.push(
        finding(
          "threemf_project",
          `Проект слайсера${producer ? ` (${PRODUCER_LABEL[producer]})` : ""}: внутри модель и настройки, но не G-code`,
          "Файл можно нарезать здесь — выберите профиль в разделе слайсинга."
        )
      );
    }
    return { verdict: "needs_preparation", material: null, data: {} };
  }

  const sliceInfo = await readSliceInfo(zip, entryNames, limits.xmlMaxBytes);
  const verdicts: AnalyzerResult["verdict"][] = ["schedulable"];
  if (!sliceInfo.material) verdicts.push("needs_input");
  // A sliced payload was produced against *someone else's* machine profile; its
  // speeds, temperatures and bed shape are not ours to trust. So the verdict is
  // `review` unconditionally — including when the file names a target printer,
  // because naming one is not the same as us having verified it. Deliberate and
  // fail-closed, not an oversight.
  verdicts.push("review");
  warnings.push(
    finding(
      "threemf_sliced_payload",
      sliceInfo.printer
        ? `Файл уже нарезан для «${sliceInfo.printer}» — параметры чужие и требуют подтверждения`
        : "Файл уже нарезан, но целевой принтер в нём не указан",
      "Проверьте, что материал и принтер совпадают с вашими, и подтвердите задание вручную."
    )
  );
  if (!sliceInfo.printer) {
    warnings.push(finding("threemf_unknown_target", "Целевой принтер не подтверждён в sliced 3MF"));
  }
  return {
    verdict: worstVerdict(verdicts),
    material: sliceInfo.material,
    data: { targetPrinter: sliceInfo.printer, sliceInfo: sliceInfo.raw }
  };
}

/**
 * What the auxiliary entries say the package *is*: a plain model, a slicer
 * project awaiting slicing, or a sliced payload carrying G-code. The file name
 * never decides this — only what the archive actually contains.
 *
 * The G-code test looks for a real payload entry (`…/plate_1.gcode`) and NOT for
 * its sidecars: a lone `plate_1.gcode.md5` used to be enough to call a project
 * "sliced", which then took the ready-to-print branch with nothing to print.
 */
interface EntryClassification {
  threeMfClass: "sliced" | "slicer_project" | "generic";
  hasGcode: boolean;
  gcodeEntries: string[];
  hasThumbnail: boolean;
  hasEmbeddedProfiles: boolean;
}

function classifyEntries(entryNames: string[]): EntryClassification {
  const gcodeEntries = entryNames.filter((n) => GCODE_ENTRY.test(n));
  const hasSlicerProject = entryNames.some((n) => PROJECT_CONFIG.test(n));
  return {
    threeMfClass: gcodeEntries.length > 0 ? "sliced" : hasSlicerProject ? "slicer_project" : "generic",
    hasGcode: gcodeEntries.length > 0,
    gcodeEntries,
    hasThumbnail: entryNames.some((n) => /\.(png|jpg|jpeg)$/i.test(n) || /thumbnail/i.test(n)),
    hasEmbeddedProfiles: entryNames.some((n) => /Metadata\/.*\.config$/i.test(n))
  };
}

/** Config parts a slicer project carries — PrusaSlicer's included. */
const PROJECT_CONFIG =
  /Metadata\/(project_settings|model_settings|slice_info|process_settings|Slic3r_PE(_model)?|Cura(Project|Settings))\.config$/i;

export type ThreeMfProducer = "orcaslicer" | "bambustudio" | "prusaslicer" | "cura" | "other";

const PRODUCER_LABEL: Record<ThreeMfProducer, string> = {
  orcaslicer: "OrcaSlicer",
  bambustudio: "Bambu Studio",
  prusaslicer: "PrusaSlicer",
  cura: "Cura",
  other: "другой слайсер"
};

/**
 * Which tool wrote the package. The model's own `Application` metadata is the
 * primary evidence (writers state it: `OrcaSlicer-2.1.1`, `BambuStudio-01.09…`,
 * `PrusaSlicer-2.7.1`); the entry layout is the fallback for packages that omit
 * it — PrusaSlicer's `Slic3r_PE*.config`, Orca/Bambu's `project_settings.config`.
 * `null` means the package genuinely does not say, which is not an error: a
 * plain 3MF exported from CAD names no slicer at all.
 */
function detectProducer(application: string | null, entryNames: string[]): ThreeMfProducer | null {
  const app = (application ?? "").toLowerCase();
  if (app.includes("orca")) return "orcaslicer";
  if (app.includes("bambu")) return "bambustudio";
  if (app.includes("prusa") || app.includes("slic3r")) return "prusaslicer";
  if (app.includes("cura")) return "cura";

  const names = entryNames.join("\n").toLowerCase();
  if (/metadata\/slic3r_pe/.test(names)) return "prusaslicer";
  if (/metadata\/cura/.test(names)) return "cura";
  // Orca and Bambu share this layout byte-for-byte; without the Application
  // metadata they cannot be told apart, so neither is claimed.
  if (/metadata\/(project_settings|model_settings|slice_info)\.config/.test(names)) return "other";
  return application ? "other" : null;
}

/** Advice attached to a structural ZIP failure — the same action fixes most of them. */
const ZIP_HINT =
  "Файл повреждён или собран нестандартно. Пересохраните его в слайсере (Файл → Сохранить проект как…) и загрузите снова.";
const XML_HINT = "Модель внутри файла повреждена. Пересохраните проект в слайсере и загрузите снова.";

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

/**
 * A ZIP we could open safely but which holds no 3D model part. Not blocked — the
 * bytes are readable and harmless, there is simply nothing to print — and the
 * finding says *what* was found instead of the generic "unknown 3MF" the UI used
 * to show for every unreadable case alike.
 */
function unknown3mf(entryNames: string[], hasContentTypes: boolean): AnalyzerResult {
  const sample = entryNames.filter((n) => !n.endsWith("/")).slice(0, 3).join(", ");
  return {
    detectedFormat: "3mf",
    verdict: "review",
    warnings: [
      finding(
        "threemf_no_model",
        hasContentTypes
          ? "Это ZIP-контейнер OPC, но 3D-модели (*.model) внутри нет"
          : `Внутри архива нет 3D-модели${sample ? ` (найдено: ${sample})` : ""}`,
        "Похоже, это не 3MF, а обычный ZIP. Загрузите сам 3MF/STL, а не архив с ним."
      )
    ],
    blockers: [],
    data: { threeMfClass: "unknown", producer: null, entries: entryNames.length },
    analyzer: "3mf",
    analyzerVersion: ANALYZER_VERSION
  };
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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
