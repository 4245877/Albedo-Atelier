import { asArray, parseSafeXml } from "./xml";
import { matchEntry, type PlateEstimate, type PlatePreviewRef, type PlateRecord } from "./threemfPlates";
import type { SafeZip } from "./zip";

/**
 * The *optional* per-plate assets a slicer project may carry: the plate
 * thumbnail, and the estimate a sliced plate reports about itself.
 *
 * Both are vendor extensions with no specification behind them, and both are
 * read in the same spirit: **nothing here may fail an analysis.** A missing
 * file, an unknown key, a value that will not parse, an image that is not the
 * image it claims to be — each yields `null` for that one fact and leaves the
 * rest of the 3MF exactly as it was. A picture is a convenience; a plate that
 * has none is still a plate an operator can choose.
 */

/**
 * Hard cap on a thumbnail. Orca/Bambu plate previews are tens to a few hundred
 * kilobytes; anything past this is not a thumbnail, and refusing to inflate it
 * costs the operator a picture rather than the analysis. Applies identically to
 * the analysis-time read and to the on-demand HTTP read, so the endpoint can
 * never be talked into inflating something the analyzer refused.
 */
export const PREVIEW_MAX_BYTES = 4 * 1024 * 1024;

/** The image types a preview may be. An extension is never evidence — the bytes are. */
export type PreviewContentType = "image/png" | "image/jpeg";

export interface SniffedImage {
  contentType: PreviewContentType;
  widthPx: number | null;
  heightPx: number | null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * What these bytes actually are, from their signature — the one authority on a
 * preview's content type.
 *
 * This is what stops MIME spoofing and, with it, the classic "SVG served as an
 * image" XSS: an SVG (or an HTML document, or a G-code file) named `plate_1.png`
 * matches neither signature and is refused, so the endpoint has nothing to
 * mislabel. Dimensions are read from the headers only — a PNG's `IHDR`, a JPEG's
 * frame marker — never by decompressing the image.
 */
export function sniffImage(data: Buffer): SniffedImage | null {
  if (data.length >= 24 && data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    // The first chunk of a PNG must be IHDR: length(4) type(4) width(4) height(4).
    if (data.toString("latin1", 12, 16) !== "IHDR") return null;
    const widthPx = data.readUInt32BE(16);
    const heightPx = data.readUInt32BE(20);
    return {
      contentType: "image/png",
      widthPx: plausibleDimension(widthPx),
      heightPx: plausibleDimension(heightPx)
    };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    const frame = readJpegFrame(data);
    return { contentType: "image/jpeg", widthPx: frame?.width ?? null, heightPx: frame?.height ?? null };
  }
  return null;
}

/** No real thumbnail is 0 or 100 000 px on a side; such a value is not a dimension. */
function plausibleDimension(value: number): number | null {
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : null;
}

/**
 * A JPEG's size lives in its Start-Of-Frame segment, which sits after an
 * arbitrary run of other segments. Walk the marker chain — bounded by the
 * buffer — and stop at the first frame header; anything malformed yields null.
 */
function readJpegFrame(data: Buffer): { width: number; height: number } | null {
  let p = 2;
  while (p + 3 < data.length) {
    if (data[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = data[p + 1];
    // Padding / standalone markers carry no length field.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      p += 2;
      continue;
    }
    const length = data.readUInt16BE(p + 2);
    if (length < 2) return null;
    // SOF0..SOF15, minus the DHT/JPG/DAC markers interleaved in that range.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (p + 9 >= data.length) return null;
      const height = data.readUInt16BE(p + 5);
      const width = data.readUInt16BE(p + 7);
      const w = plausibleDimension(width);
      const h = plausibleDimension(height);
      return w !== null && h !== null ? { width: w, height: h } : null;
    }
    p += 2 + length;
  }
  return null;
}

// ── Preview discovery ────────────────────────────────────────────────────────

/**
 * Attaches each plate's preview *metadata* — never its bytes.
 *
 * The image itself stays in the archive: an analysis row is JSON in SQLite, and
 * putting a few hundred kilobytes of PNG per plate in it would bloat every read
 * of every artifact for a picture almost nobody is looking at. What is stored is
 * enough to fetch it again safely and to lay it out before it arrives — the
 * archive entry, its verified type, its pixel size, its byte size.
 *
 * Resolution order is the one the brief fixes: a path the config *declares*
 * wins, and only if there is none is the conventional `plate_<n>.png` tried.
 * Writers do disagree about these names between versions, so a hardcoded name
 * must never override what the file itself says.
 */
export async function attachPlatePreviews(
  zip: SafeZip,
  plates: readonly PlateRecord[]
): Promise<{ unreadable: number }> {
  const entryNames = zip.entries.filter((e) => !e.isDirectory).map((e) => e.name);
  let unreadable = 0;

  for (const plate of plates) {
    const { candidates, declared } = previewCandidates(plate, entryNames);

    let resolved = false;
    for (const candidate of candidates) {
      const preview = await readPreviewRef(zip, candidate.entry, candidate.kind);
      if (preview) {
        plate.preview = preview;
        resolved = true;
        break;
      }
    }
    // A picture the config *declared* and we cannot use is worth saying out
    // loud — the file promised one. A conventional guess that missed is not: it
    // was only ever a guess, and most projects legitimately carry no thumbnail.
    if (!resolved && declared) unreadable++;
  }

  return { unreadable };
}

function previewCandidates(
  plate: PlateRecord,
  entryNames: readonly string[]
): { candidates: { entry: string; kind: PlatePreviewRef["kind"] }[]; declared: boolean } {
  const conventional = new RegExp(`(^|/)plate_${plate.index}\\.(png|jpe?g)$`, "i");
  const guesses = entryNames
    .filter((n) => conventional.test(n))
    .map((entry) => ({ entry, kind: "conventional" as const }));

  const declared = plate.settings.thumbnail_file;
  if (!declared) return { candidates: guesses, declared: false };

  const found = matchEntry(entryNames, declared);
  // The declared path wins when it resolves. When it does not — a path outside
  // the package, or one naming an entry that is not there — the convention is
  // still tried, but the broken promise is reported either way.
  return {
    candidates: found ? [{ entry: found, kind: "declared" as const }, ...guesses] : guesses,
    declared: true
  };
}

/** Reads one candidate entry into a verified reference, or null if it is not usable. */
async function readPreviewRef(
  zip: SafeZip,
  entry: string,
  kind: PlatePreviewRef["kind"]
): Promise<PlatePreviewRef | null> {
  const declaredSize = zip.entries.find((e) => e.name === entry && !e.isDirectory)?.uncompressedSize;
  if (declaredSize === undefined || declaredSize === 0 || declaredSize > PREVIEW_MAX_BYTES) return null;
  try {
    const data = await zip.read(entry, PREVIEW_MAX_BYTES);
    const image = sniffImage(data);
    if (!image) return null;
    return {
      kind,
      entry,
      contentType: image.contentType,
      widthPx: image.widthPx,
      heightPx: image.heightPx,
      bytes: data.length
    };
  } catch {
    return null;
  }
}

// ── slice_info.config ────────────────────────────────────────────────────────

export interface SliceInfoPlate {
  /** The plate this block describes, when it says so. */
  index: number | null;
  estimate: PlateEstimate;
  /** The printer the file was sliced for, as this plate reports it. */
  printer: string | null;
  /** The first filament type named — the legacy single-material answer. */
  material: string | null;
}

export interface SliceInfo {
  entry: string;
  plates: SliceInfoPlate[];
}

/**
 * Reads `Metadata/slice_info.config` — what an already-sliced package says about
 * each plate it carries.
 *
 * **Every field here is optional and every field is untrusted.** The format is a
 * vendor extension with no published schema; the shapes read below are the ones
 * observed in Bambu/Orca exports, and a file that spells them differently simply
 * yields nulls. Two consequences are deliberate: an unreadable or unexpected
 * `slice_info.config` never makes the 3MF invalid, and nothing read here decides
 * a verdict, selects a profile, or reaches the slicer — it is shown, and that is
 * all.
 */
export async function readSliceInfo(
  zip: SafeZip,
  entryNames: readonly string[],
  maxBytes: number
): Promise<SliceInfo | null> {
  const entry = entryNames.find((n) => /Metadata\/slice_info\.config$/i.test(n));
  if (!entry) return null;
  try {
    const xml = (await zip.read(entry, maxBytes)).toString("utf8");
    const config = asRecord(asRecord(parseSafeXml(xml, maxBytes)).config);
    const plates = asArray(config.plate as unknown).slice(0, 256).map(readSliceInfoPlate);
    return { entry, plates };
  } catch {
    return null;
  }
}

function readSliceInfoPlate(plate: unknown): SliceInfoPlate {
  const rec = asRecord(plate);
  const meta = new Map<string, string>();
  for (const m of asArray(rec.metadata as unknown)) {
    const entry = asRecord(m);
    const key = String(entry["@_key"] ?? "").trim().toLowerCase();
    const value = entry["@_value"];
    if (key && typeof value === "string" && !meta.has(key)) meta.set(key, value.trim());
  }

  const filaments = asArray(rec.filament as unknown)
    .slice(0, 64)
    .map(readFilament)
    .filter((f): f is PlateEstimate["filaments"][number] => f !== null);

  return {
    index: intOrNull(meta.get("index")),
    estimate: {
      // Orca/Bambu write the ETA as `prediction`, in seconds. Other spellings
      // are accepted because a wrong guess here costs a displayed number, not
      // a decision.
      durationS: numberOrNull(meta.get("prediction") ?? meta.get("prediction_seconds")),
      weightG: numberOrNull(meta.get("weight")),
      supportUsed: boolOrNull(meta.get("support_used")),
      filaments
    },
    printer: firstOf(meta, ["printer_model_id", "printer_model", "printer"]),
    material: filaments.find((f) => f.type)?.type ?? firstOf(meta, ["filament_type"])
  };
}

function readFilament(raw: unknown): PlateEstimate["filaments"][number] | null {
  const rec = asRecord(raw);
  const id = intOrNull(stringOrNull(rec["@_id"]));
  if (id === null) return null;
  const color = stringOrNull(rec["@_color"]);
  return {
    id,
    type: stringOrNull(rec["@_type"]),
    colorHex: color !== null && /^#[0-9a-f]{3,8}$/i.test(color) ? color.toUpperCase() : null,
    usedG: numberOrNull(stringOrNull(rec["@_used_g"]))
  };
}

/** Binds each slice-info block to its plate: by declared index, else by position. */
export function applySliceInfo(plates: readonly PlateRecord[], info: SliceInfo | null): void {
  if (!info) return;
  const byIndex = new Map<number, SliceInfoPlate>();
  for (const plate of info.plates) if (plate.index !== null) byIndex.set(plate.index, plate);

  plates.forEach((plate, i) => {
    const match = byIndex.get(plate.index) ?? (byIndex.size === 0 ? info.plates[i] : undefined);
    if (match) plate.estimate = match.estimate;
  });
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberOrNull(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) / 1000 : null;
}

function intOrNull(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && n <= 100_000 ? n : null;
}

function boolOrNull(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return null;
}

function firstOf(meta: Map<string, string>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = meta.get(key);
    if (value) return value.slice(0, 120);
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
