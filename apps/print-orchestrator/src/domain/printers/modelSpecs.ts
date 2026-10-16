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
  },
  {
    code: "anycubic-kobra-x",
    name: "Anycubic Kobra X",
    technology: "FDM",
    // Anycubic's published build volume. The LAN protocol does not report it.
    buildVolume: { x: 260, y: 260, z: 260 },
    // Its built-in four-colour changer is none of the kinds this vocabulary
    // names, and multi-material is out of scope until it is verified.
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
 * Bambu's own model identifiers, keyed by catalogue code.
 *
 * They appear in a sliced package's `slice_info.config` as `printer_model_id`
 * and in the plate package this farm builds — Bambu's internal names, not the
 * marketing ones: an A1 is `N2S`. Confirmed against a package downloaded from
 * this farm's A1. Strict both ways: an unknown code or id yields `null`, never
 * the nearest-looking neighbour — a package claiming the wrong machine is worse
 * than one that claims none.
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
export function bambuModelIdOf(code: string | null | undefined): string | null {
  if (!code) return null;
  return BAMBU_MODEL_IDS[code.trim().toLowerCase()] ?? null;
}

/** The catalogued model a Bambu `printer_model_id` names (`N2S` → A1), or null. */
export function modelSpecForBambuModelId(id: string | null | undefined): PrinterModelSpec | null {
  const wanted = (id ?? "").trim().toUpperCase();
  if (!wanted) return null;
  for (const [code, modelId] of Object.entries(BAMBU_MODEL_IDS)) {
    if (modelId === wanted) return lookupModelSpec(code);
  }
  return null;
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

/**
 * Anycubic LAN `modelId`s → catalogue codes.
 *
 * The printer states its `modelId` itself (`GET :18910/info` and the decrypted
 * LAN bundle), so unlike Bambu's serial prefixes this is a reading, not an
 * inference. Only models whose identifier has been confirmed on a real unit
 * are listed: `20030` is the Kobra X (OrcaCubic's capture of firmware 2.0.1.9;
 * the Home Assistant LAN integrations agree). Other Anycubic models share the
 * protocol but not the hardware — an unlisted id resolves to `null`, never to
 * the Kobra X, so its bed size is not lent to a different machine.
 */
const ANYCUBIC_MODEL_IDS: Readonly<Record<string, string>> = {
  "20030": "anycubic-kobra-x"
};

/** The catalogue code for an Anycubic LAN `modelId`, or `null` when not catalogued. */
export function anycubicModelCodeFor(modelId: string | number | null | undefined): string | null {
  if (modelId === null || modelId === undefined) return null;
  return ANYCUBIC_MODEL_IDS[String(modelId).trim()] ?? null;
}
