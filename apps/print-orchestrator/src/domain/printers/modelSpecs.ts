import type { PrinterTechnology } from "./types";

/**
 * The printer **model catalogue**: what a given model *is*, for the facts its
 * protocol cannot report.
 *
 * This exists for exactly one gap. Bambu's local MQTT never states the build
 * volume — the printer knows its own bed size but does not put it on the wire —
 * so with the device alone the operator would still have to type 256×256×256 by
 * hand for an A1. Klipper, by contrast, *does* report it
 * (`stepper_*.position_max`), and there the catalogue is not consulted at all.
 *
 * Because a catalogue value is an assumption about a model rather than a reading
 * from a machine, it is tagged with its own source (`"catalog"`, «по модели») and
 * ranks BELOW both the device and the operator in {@link resolvePrinterSpecs}:
 * a device speaks for the specific unit, an operator speaks for the specific
 * unit, a table speaks only for the model.
 *
 * Honesty rules for edits:
 *
 *  - a model belongs here only with stock, manufacturer-published dimensions;
 *  - anything not known for a model is `null`, never a plausible guess;
 *  - {@link lookupModelSpec} returns `null` for an unknown key — the resolver
 *    then reports «неизвестно» instead of picking the nearest-looking entry.
 */

/** Which multi-material system a model ships with; null = none or unknown. */
export type AmsKind = "AMS" | "AMS Lite" | "CFS";

export interface PrinterModelSpec {
  /** Stable catalogue key, also what the API and audit trail carry. */
  code: string;
  /** Operator-facing model name, as the vendor writes it. */
  name: string;
  technology: PrinterTechnology;
  /** Stock build volume in mm; null when the model has no single published one. */
  buildVolume: { x: number; y: number; z: number } | null;
  /**
   * The multi-material system this model uses. Telemetry can say *whether* one is
   * attached and how many slots it has, but never which kind it is — an AMS and
   * an AMS Lite report through the same `ams` structure — so the kind is a
   * property of the model and lives here.
   */
  amsKind: AmsKind | null;
}

const MODELS: readonly PrinterModelSpec[] = [
  {
    code: "bambu-a1",
    name: "Bambu Lab A1",
    technology: "FDM",
    buildVolume: { x: 256, y: 256, z: 256 },
    amsKind: "AMS Lite"
  },
  {
    code: "bambu-a1-mini",
    name: "Bambu Lab A1 mini",
    technology: "FDM",
    buildVolume: { x: 180, y: 180, z: 180 },
    amsKind: "AMS Lite"
  },
  {
    code: "bambu-p1p",
    name: "Bambu Lab P1P",
    technology: "FDM",
    buildVolume: { x: 256, y: 256, z: 256 },
    amsKind: "AMS"
  },
  {
    code: "bambu-p1s",
    name: "Bambu Lab P1S",
    technology: "FDM",
    buildVolume: { x: 256, y: 256, z: 256 },
    amsKind: "AMS"
  },
  {
    code: "bambu-x1c",
    name: "Bambu Lab X1 Carbon",
    technology: "FDM",
    buildVolume: { x: 256, y: 256, z: 256 },
    amsKind: "AMS"
  },
  {
    code: "bambu-x1e",
    name: "Bambu Lab X1E",
    technology: "FDM",
    buildVolume: { x: 256, y: 256, z: 256 },
    amsKind: "AMS"
  },
  {
    code: "creality-k2-plus",
    name: "Creality K2 Plus",
    technology: "FDM",
    buildVolume: { x: 350, y: 350, z: 350 },
    amsKind: "CFS"
  },
  {
    code: "creality-ender3-v3-ke",
    name: "Creality Ender-3 V3 KE",
    technology: "FDM",
    buildVolume: { x: 220, y: 220, z: 240 },
    amsKind: null
  }
];

const BY_CODE = new Map(MODELS.map((model) => [model.code, model]));

/** The catalogue entry for a code, or null when the code is not catalogued. */
export function lookupModelSpec(code: string | null | undefined): PrinterModelSpec | null {
  if (!code) return null;
  return BY_CODE.get(code.trim().toLowerCase()) ?? null;
}

/** Every catalogued model — for tests and for the `/options` vocabulary. */
export function listModelSpecs(): readonly PrinterModelSpec[] {
  return MODELS;
}

/**
 * Bambu serial-number prefixes → catalogue codes.
 *
 * Bambu encodes the product line in the first three characters of the device
 * serial, and that is the ONLY model signal their local MQTT carries: the
 * `info.get_version` module list reports firmware and mainboard revisions
 * (`hw_ver: "AP05"`), which identify a *board*, not a printer — the same board
 * revision ships across several models, so deriving a model from it would be a
 * guess dressed as a reading.
 *
 * This mapping is community-established, not vendor-published. It is therefore
 * strict: an unrecognised prefix yields `null` and the model stays unknown,
 * rather than resolving to whatever entry looks closest.
 */
const BAMBU_SERIAL_PREFIXES: Readonly<Record<string, string>> = {
  "00M": "bambu-x1c",
  "00W": "bambu-x1e",
  "01S": "bambu-p1p",
  "01P": "bambu-p1s",
  "030": "bambu-a1-mini",
  "039": "bambu-a1"
};

/**
 * The catalogue code for a Bambu printer from its device serial, or `null` when
 * the prefix is not one we recognise.
 *
 * The serial itself is a stored credential and never leaves the service; only
 * the derived code (and, through it, the model name) is published.
 */
export function deriveBambuModelCode(serial: string | null | undefined): string | null {
  const trimmed = (serial ?? "").trim().toUpperCase();
  if (trimmed.length < 3) return null;
  return BAMBU_SERIAL_PREFIXES[trimmed.slice(0, 3)] ?? null;
}
