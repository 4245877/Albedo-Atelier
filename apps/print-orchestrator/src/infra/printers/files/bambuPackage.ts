import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";

/**
 * Builds the **`.gcode.3mf` plate package** a Bambu printer expects.
 *
 * Why a package at all, when our slicer already emits perfectly good A1 G-code:
 * the LAN start command is `print.project_file`, and it names a G-code *inside a
 * 3MF container* (`param: "Metadata/plate_1.gcode"`). That is the transport
 * Bambu Studio and OrcaSlicer themselves use, and it is what this farm's A1
 * already holds — every file on its SD card is a `*.gcode.3mf`.
 *
 * The layout below is not guessed. It replicates a real package downloaded from
 * that printer, part for part:
 *
 *     [Content_Types].xml
 *     _rels/.rels
 *     3D/3dmodel.model
 *     Metadata/plate_1.gcode           ← the sliced G-code, verbatim
 *     Metadata/plate_1.gcode.md5       ← upper-case MD5 of the above
 *     Metadata/plate_1.json
 *     Metadata/slice_info.config
 *     Metadata/model_settings.config
 *     Metadata/_rels/model_settings.config.rels
 *
 * Two deliberate omissions relative to a Bambu Studio export: the plate
 * thumbnails (`plate_1.png` and friends) and `project_settings.config`. The
 * thumbnails only drive the preview on the printer's screen, and the settings
 * blob is the slicer's own project state, which nothing on the device reads for
 * a local print. Neither is referenced by anything we emit — in particular the
 * `.rels` here does **not** point at absent thumbnails, because a relationship
 * to a missing part is exactly the kind of malformed package a firmware is
 * entitled to reject.
 *
 * **Deterministic**: the same G-code and metadata always produce byte-identical
 * output (fixed timestamps, no compression nondeterminism). That is what lets
 * the artifact's content hash stay a meaningful identity for the packaged file
 * and keeps `prepare` idempotent across restarts.
 */

/** The path the start command's `param` names inside the package. */
export const BAMBU_PLATE_GCODE_PATH = "Metadata/plate_1.gcode";

/**
 * Bambu's own model identifiers, keyed by this project's catalogue code.
 *
 * They appear in `slice_info.config` as `printer_model_id` and are Bambu's
 * internal names, not the marketing ones — an A1 is `N2S`. Confirmed against a
 * package downloaded from this farm's A1. An unknown model yields `null`, and
 * the caller omits the field rather than guessing a neighbour: a package
 * claiming the wrong machine is worse than one that claims none.
 */
const BAMBU_MODEL_IDS: Readonly<Record<string, string>> = {
  "bambu-a1": "N2S",
  "bambu-a1-mini": "N1",
  "bambu-p1p": "C11",
  "bambu-p1s": "C12",
  "bambu-x1c": "BL-P001",
  "bambu-x1e": "BL-P002"
};

/** Bambu's `printer_model_id` for a catalogue code, or null when unmapped. */
export function bambuModelIdFor(modelCode: string | null | undefined): string | null {
  if (!modelCode) return null;
  return BAMBU_MODEL_IDS[modelCode] ?? null;
}

export interface BambuPackageInput {
  /** The sliced G-code, exactly as the slicer produced it. */
  gcode: Uint8Array;
  /** Bambu model id for the target machine, e.g. "N2S" for the A1. */
  printerModelId: string;
  /** Nozzle diameter in mm, as the slice was produced for. */
  nozzleDiameterMm: number;
  /** Filament type ("PETG"), used for the slice-info entry. */
  material: string | null;
  /** Estimated print seconds; omitted from the metadata when unknown. */
  etaSeconds: number | null;
  /** Estimated filament grams; omitted when unknown. */
  filamentGrams: number | null;
  /** Bed type reported to the printer; "textured_plate" matches this farm's A1. */
  bedType?: string;
}

/** The package bytes plus the identity facts a caller records against it. */
export interface BambuPackage {
  bytes: Uint8Array;
  /** Upper-case MD5 of the embedded G-code — what `plate_1.gcode.md5` holds. */
  gcodeMd5: string;
  /** The `param` value the start command must use for this package. */
  plateGcodePath: string;
}

export function buildBambuPlatePackage(input: BambuPackageInput): BambuPackage {
  const gcodeMd5 = createHash("md5").update(input.gcode).digest("hex").toUpperCase();
  const bedType = input.bedType ?? "textured_plate";
  const nozzle = formatNumber(input.nozzleDiameterMm);
  const material = (input.material ?? "").trim() || "PLA";

  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: text(CONTENT_TYPES) },
    { name: "_rels/.rels", data: text(RELS) },
    { name: "3D/3dmodel.model", data: text(MODEL) },
    { name: BAMBU_PLATE_GCODE_PATH, data: input.gcode },
    { name: `${BAMBU_PLATE_GCODE_PATH}.md5`, data: text(gcodeMd5) },
    {
      name: "Metadata/plate_1.json",
      data: text(
        JSON.stringify({
          bed_type: bedType,
          filament_colors: ["#FFFFFF"],
          filament_ids: [0],
          first_extruder: 0,
          is_seq_print: false,
          nozzle_diameter: input.nozzleDiameterMm,
          version: 2
        })
      )
    },
    {
      name: "Metadata/slice_info.config",
      data: text(sliceInfo({ ...input, nozzle, material, bedType }))
    },
    { name: "Metadata/model_settings.config", data: text(MODEL_SETTINGS) },
    { name: "Metadata/_rels/model_settings.config.rels", data: text(MODEL_SETTINGS_RELS) }
  ];

  return { bytes: buildZip(entries), gcodeMd5, plateGcodePath: BAMBU_PLATE_GCODE_PATH };
}

// ── Package parts ─────────────────────────────────────────────────────────────

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
</Types>
`;

// Only the 3D model relationship: we emit no thumbnails, so we claim none.
const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

// An empty model. The geometry is irrelevant for a local print — the printer
// executes the G-code — but the part must exist and parse, because `.rels`
// points at it and the firmware opens the container as a 3MF.
const MODEL = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
 <metadata name="Application">AtelierPrintOrchestrator</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
 </resources>
 <build/>
</model>
`;

const MODEL_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
    <metadata key="gcode_file" value="${BAMBU_PLATE_GCODE_PATH}"/>
  </plate>
</config>
`;

const MODEL_SETTINGS_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/${BAMBU_PLATE_GCODE_PATH}" Id="rel-1" Type="http://schemas.bambulab.com/package/2021/gcode"/>
</Relationships>
`;

function sliceInfo(input: {
  printerModelId: string;
  nozzle: string;
  material: string;
  bedType: string;
  etaSeconds: number | null;
  filamentGrams: number | null;
}): string {
  const prediction = input.etaSeconds !== null ? Math.round(input.etaSeconds) : 0;
  const weight = input.filamentGrams !== null ? input.filamentGrams.toFixed(2) : "0.00";
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="02.06.00.51"/>
  </header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="printer_model_id" value="${escapeXml(input.printerModelId)}"/>
    <metadata key="nozzle_diameters" value="${escapeXml(input.nozzle)}"/>
    <metadata key="timelapse_type" value="0"/>
    <metadata key="prediction" value="${prediction}"/>
    <metadata key="weight" value="${weight}"/>
    <metadata key="outside" value="false"/>
    <metadata key="support_used" value="false"/>
    <metadata key="label_object_enabled" value="false"/>
    <filament id="1" tray_info_idx="" type="${escapeXml(input.material)}" color="#FFFFFF" used_m="0.00" used_g="${weight}" used_for_object="true" used_for_support="false"/>
    <nozzle id="0" extruder_id="1" nozzle_diameter="${escapeXml(input.nozzle)}" volume_type="Standard"/>
  </plate>
</config>
`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Trims a float to the shortest exact decimal ("0.4", not "0.4000000059604645"). */
function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toFixed(3))) : "0.4";
}

function text(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

// ── Minimal deterministic ZIP writer ──────────────────────────────────────────

/**
 * A ZIP writer rather than a dependency, for three reasons: the output must be
 * byte-deterministic (so the packaged file has a stable identity), it must never
 * emit ZIP64 for the small archives we build (some firmware readers are strict),
 * and the project already refuses to add a dependency for something this bounded.
 *
 * Deflate is used for every part, matching what a Bambu Studio export contains,
 * with a fixed DOS timestamp so two builds of the same slice are identical.
 */
interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** 1980-01-01 00:00:00 — the DOS epoch, so nothing varies with wall-clock time. */
const DOS_TIME = 0;
const DOS_DATE = 33;

function buildZip(entries: ZipEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data);
    const compressed = deflateRawSync(raw, { level: 9 });
    // Never let "compression" grow a part: fall back to stored, exactly as any
    // conforming writer does.
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    locals.push(local, payload);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralDirectory, end]);
}

/** Standard CRC-32 (IEEE 802.3), table built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
