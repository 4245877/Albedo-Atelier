import type { AnalysisFinding } from "../print/types";
import { dedupeFindings, finding } from "./findings";
import {
  intendedNozzleFromName,
  type FilamentFields,
  type MachineFields,
  type OrcaSettings,
  type ProcessFields,
  readFilament,
  readMachine,
  readProcess
} from "./orcaProfile";
import type { ProfileRevisionStatus, ProfileType } from "./types";

/**
 * Compatibility & sanity checks for slicing profiles.
 *
 * Two layers, matching the brief:
 *   1. {@link checkProfileSelf} — per-profile checks the importer runs on one
 *      profile in isolation (nozzle vs printer_variant, absurd layer height,
 *      out-of-range temperatures, uninformative name). Its blockers quarantine the
 *      revision.
 *   2. {@link validateProfileSet} — cross-profile checks when a machine + process +
 *      filament are combined for a target: nozzle agreement, layer height vs the
 *      machine's limits and nozzle, work area, temperature vs material, material vs
 *      the loaded printer, and G-code flavor vs the printer's firmware. Its blockers
 *      forbid approving the set.
 *
 * Everything is pure and returns structured `{ warnings, blockers }` — no I/O, no
 * throwing — so both layers are unit-testable with synthetic fields.
 */

export interface FindingSet {
  warnings: AnalysisFinding[];
  blockers: AnalysisFinding[];
}

function empty(): FindingSet {
  return { warnings: [], blockers: [] };
}

/** Sane hotend temperature envelope per material family (°C). */
const MATERIAL_TEMP: Record<string, { min: number; max: number }> = {
  PLA: { min: 180, max: 230 },
  PETG: { min: 220, max: 265 },
  ABS: { min: 230, max: 275 },
  ASA: { min: 230, max: 275 },
  TPU: { min: 200, max: 250 },
  TPE: { min: 200, max: 250 },
  PC: { min: 250, max: 310 },
  PA: { min: 240, max: 300 },
  NYLON: { min: 240, max: 300 },
  PVA: { min: 180, max: 220 },
  HIPS: { min: 220, max: 260 },
  PLA_CF: { min: 190, max: 240 },
  PETG_CF: { min: 230, max: 270 }
};

/** Nozzle line-width / layer-height rules of thumb. */
const LAYER_MAX_RATIO = 0.75; // layer height above 75% of nozzle Ø won't bond reliably
const LAYER_THICK_RATIO = 0.6; // above 60% is aggressive — worth a warning
const LAYER_MIN_RATIO = 0.1; // below ~10% is impractically thin

function materialKey(filamentType: string | null | undefined): string | null {
  if (!filamentType) return null;
  const norm = filamentType.toUpperCase().replace(/[\s-]+/g, "_");
  if (MATERIAL_TEMP[norm]) return norm;
  // Fall back to the leading family token ("PETG-CF Foo" → "PETG").
  const base = norm.split("_")[0];
  return MATERIAL_TEMP[base] ? base : null;
}

function approxEqual(a: number, b: number, eps = 0.001): boolean {
  return Math.abs(a - b) <= eps;
}

// ── Per-profile self checks ──────────────────────────────────────────────────

export interface SelfCheckInput {
  type: ProfileType;
  name: string;
  inherits: string | null;
  /** Raw settings (this profile's own keys). */
  raw: OrcaSettings;
  /** Fully-resolved settings when inheritance resolved; null otherwise. */
  resolved: OrcaSettings | null;
}

/**
 * Checks one profile on its own. Uses resolved settings when available (so
 * inherited values are visible) and always falls back to the profile's own keys.
 */
export function checkProfileSelf(input: SelfCheckInput): FindingSet {
  const out = empty();
  const effective = input.resolved ?? input.raw;

  checkName(input.name, out);

  if (input.type === "machine") checkMachineSelf(input, readMachine(effective), out);
  else if (input.type === "process") checkProcessSelf(readProcess(effective), out);
  else checkFilamentSelf(readFilament(effective), out);

  out.warnings = dedupeFindings(out.warnings);
  out.blockers = dedupeFindings(out.blockers);
  return out;
}

function checkName(name: string, out: FindingSet): void {
  const patterns: Array<[RegExp, string]> = [
    [/-\s*copy\b/i, "«Copy»"],
    [/\bcopy\b/i, "«Copy»"],
    [/\bfast\d+\b/i, "«FAST1»-подобное имя"],
    [/\btest\b/i, "«test»"],
    [/тест/i, "«тест»"]
  ];
  for (const [re, label] of patterns) {
    if (re.test(name)) {
      out.warnings.push(
        finding("uninformative_name", `Неинформативное имя профиля (${label}): «${name}» — переименуйте перед использованием`)
      );
      return;
    }
  }
}

function checkMachineSelf(input: SelfCheckInput, m: MachineFields, out: FindingSet): void {
  if (m.nozzleDiameterMm === null || m.nozzleDiameterMm <= 0) {
    out.blockers.push(finding("nozzle_missing", "У профиля принтера не задан корректный диаметр сопла"));
  }
  // nozzle_diameter vs printer_variant (the classic 0.4-declared / 0.2-variant clash).
  if (m.nozzleDiameterMm !== null && m.printerVariant) {
    const variantNum = Number.parseFloat(m.printerVariant);
    if (Number.isFinite(variantNum) && !approxEqual(variantNum, m.nozzleDiameterMm)) {
      out.blockers.push(
        finding(
          "nozzle_variant_mismatch",
          `Диаметр сопла ${m.nozzleDiameterMm} мм не совпадает с вариантом принтера «${m.printerVariant}» — профиль наследует настройки другого сопла`
        )
      );
    }
  }
  // nozzle_diameter vs the "… X nozzle" the parent name *implies*. This is a
  // name-based inference, not a real setting, so it can misfire on a profile that
  // deliberately overrides its parent's nozzle — it must WARN, never quarantine.
  // Only the setting-backed `nozzle_variant_mismatch` above is trustworthy enough
  // to block. (See `intendedNozzleFromName`, which already ignores ambiguous sizes.)
  const inheritedNozzle = intendedNozzleFromName(input.inherits);
  if (m.nozzleDiameterMm !== null && inheritedNozzle !== null && !approxEqual(inheritedNozzle, m.nozzleDiameterMm)) {
    out.warnings.push(
      finding(
        "nozzle_parent_mismatch",
        `Сопло ${m.nozzleDiameterMm} мм, но имя родителя «${input.inherits}» подразумевает сопло ${inheritedNozzle} мм — проверьте, что переопределение сопла намеренное`
      )
    );
  }
  if ((m.bedWidthMm ?? 0) <= 0 || (m.bedDepthMm ?? 0) <= 0) {
    out.warnings.push(finding("work_area_unknown", "Не удалось определить рабочую область принтера (printable_area)"));
  }
}

function checkProcessSelf(p: ProcessFields, out: FindingSet): void {
  for (const [value, label] of [
    [p.layerHeightMm, "Высота слоя"],
    [p.initialLayerHeightMm, "Высота первого слоя"]
  ] as const) {
    if (value === null) continue;
    if (value <= 0 || value > 1.2) {
      out.blockers.push(finding("layer_height_invalid", `${label} ${value} мм вне допустимого диапазона`));
    } else if (value > 0.6) {
      out.warnings.push(finding("layer_height_high", `${label} ${value} мм необычно велика для FDM`));
    }
  }
  if (
    p.layerHeightMm !== null &&
    p.initialLayerHeightMm !== null &&
    p.initialLayerHeightMm < p.layerHeightMm - 0.001
  ) {
    out.warnings.push(
      finding(
        "initial_layer_thinner",
        `Первый слой (${p.initialLayerHeightMm} мм) тоньше основного (${p.layerHeightMm} мм) — обычно наоборот`
      )
    );
  }
}

function checkFilamentSelf(f: FilamentFields, out: FindingSet): void {
  const key = materialKey(f.filamentType);
  if (key && f.nozzleTempC !== null) {
    const range = MATERIAL_TEMP[key];
    if (f.nozzleTempC < range.min - 20 || f.nozzleTempC > range.max + 20) {
      out.blockers.push(
        finding(
          "temperature_out_of_range",
          `Температура сопла ${f.nozzleTempC}°C недопустима для ${f.filamentType} (норма ${range.min}–${range.max}°C)`
        )
      );
    } else if (f.nozzleTempC < range.min || f.nozzleTempC > range.max) {
      out.warnings.push(
        finding(
          "temperature_unusual",
          `Температура сопла ${f.nozzleTempC}°C выходит за обычный диапазон ${f.filamentType} (${range.min}–${range.max}°C)`
        )
      );
    }
  }
  if (f.nozzleTempC !== null && f.nozzleTempInitialC !== null) {
    const delta = f.nozzleTempInitialC - f.nozzleTempC;
    if (delta < -40 || delta > 50) {
      out.blockers.push(
        finding(
          "temperature_contradiction",
          `Температура первого слоя ${f.nozzleTempInitialC}°C противоречит основной ${f.nozzleTempC}°C`
        )
      );
    } else if (delta < -15 || delta > 25) {
      out.warnings.push(
        finding(
          "temperature_initial_gap",
          `Большая разница температур первого (${f.nozzleTempInitialC}°C) и основного (${f.nozzleTempC}°C) слоёв`
        )
      );
    }
  }
}

// ── Cross-profile set validation ─────────────────────────────────────────────

export interface SetMember<F> {
  name: string;
  status: ProfileRevisionStatus;
  fields: F;
}

export interface SetTarget {
  /** The loaded/allowed material(s) of the bound printer, e.g. "PLA / PETG". */
  printerMaterial?: string | null;
  /** The bound printer's transport/firmware family: moonraker | bambu | creality. */
  printerProtocol?: string | null;
  /** The bound printer's model — hard-checked against the machine profile's model. */
  printerModel?: string | null;
  /** The bound printer's configured nozzle Ø (mm) — hard-checked against the profile's nozzle. */
  printerNozzleMm?: number | null;
}

/**
 * A class of interchangeable printers as a slice target. `printers` is the hardware
 * of every farm printer carrying that class; an empty list means the class does not
 * exist (a blocker). The set is safe when it is compatible with *at least one*
 * member — a heterogeneous class where only some members fit is a warning, not a
 * block (the slice is then only valid on the compatible ones, re-checked per printer
 * at slice time).
 */
export interface SetClassTarget {
  className: string;
  printers: SetTarget[];
}

export interface ProfileSetValidationInput {
  machine: SetMember<MachineFields> | null;
  process: SetMember<ProcessFields> | null;
  filament: SetMember<FilamentFields> | null;
  /** A concrete bound printer. Mutually exclusive with {@link classTargets}. */
  target?: SetTarget;
  /** A class of interchangeable printers. Mutually exclusive with {@link target}. */
  classTargets?: SetClassTarget;
}

/**
 * Validates a machine + process + filament combination for a target. Any blocker
 * here forbids approving the set. A referenced revision that is not `active`
 * (quarantined/invalid) is itself a blocker — a set is only as trustworthy as its
 * parts.
 */
export function validateProfileSet(input: ProfileSetValidationInput): FindingSet {
  const out = empty();
  const { machine, process, filament, target, classTargets } = input;

  // Every member must be present and active.
  for (const [member, label] of [
    [machine, "профиль принтера"],
    [process, "профиль печати"],
    [filament, "профиль филамента"]
  ] as const) {
    if (!member) {
      out.blockers.push(finding("member_missing", `В наборе не выбран ${label}`));
    } else if (member.status !== "active") {
      out.blockers.push(
        finding(
          "member_not_active",
          `${label[0].toUpperCase()}${label.slice(1)} «${member.name}» имеет статус «${member.status}» и не может использоваться`
        )
      );
    }
  }

  const m = machine?.fields;
  const p = process?.fields;
  const f = filament?.fields;

  // Nozzle agreement (intent hinted by process/filament names vs the machine).
  if (m?.nozzleDiameterMm != null) {
    const processIntended = process ? intendedNozzleFromName(process.name) : null;
    if (processIntended !== null && !approxEqual(processIntended, m.nozzleDiameterMm)) {
      out.warnings.push(
        finding(
          "process_nozzle_intent",
          `Профиль печати «${process?.name}» рассчитан на сопло ${processIntended} мм, а у принтера ${m.nozzleDiameterMm} мм`
        )
      );
    }
    const filamentIntended = filament ? intendedNozzleFromName(filament.name) : null;
    if (filamentIntended !== null && !approxEqual(filamentIntended, m.nozzleDiameterMm)) {
      out.warnings.push(
        finding(
          "filament_nozzle_intent",
          `Профиль филамента «${filament?.name}» рассчитан на сопло ${filamentIntended} мм, а у принтера ${m.nozzleDiameterMm} мм`
        )
      );
    }
  }

  // Layer height vs machine limits and nozzle.
  if (p && m) {
    checkLayerAgainstMachine(p.layerHeightMm, "Высота слоя", m, out);
    checkLayerAgainstMachine(p.initialLayerHeightMm, "Высота первого слоя", m, out);
  }

  // Work area must be known and positive (model-fit is checked at slice time).
  if (m && ((m.bedWidthMm ?? 0) <= 0 || (m.bedDepthMm ?? 0) <= 0 || (m.bedHeightMm ?? 0) <= 0)) {
    out.warnings.push(finding("work_area_unknown", "Рабочая область принтера не определена полностью"));
  }

  // Temperature vs material (filament already self-checked; here we surface it at set level too).
  if (f) {
    const key = materialKey(f.filamentType);
    if (key && f.nozzleTempC !== null) {
      const range = MATERIAL_TEMP[key];
      if (f.nozzleTempC < range.min - 20 || f.nozzleTempC > range.max + 20) {
        out.blockers.push(
          finding(
            "temperature_out_of_range",
            `Температура филамента ${f.nozzleTempC}°C недопустима для ${f.filamentType} (${range.min}–${range.max}°C)`
          )
        );
      }
    }
  }

  // Filament ↔ printer model soft check ("@K2" filament on an A1, etc.) — this uses
  // the machine profile's own model, so it is target-independent.
  if (filament && m?.printerModel) {
    const modelToken = modelTokenMismatch(filament.name, m.printerModel);
    if (modelToken) {
      out.warnings.push(
        finding(
          "filament_model_mismatch",
          `Филамент «${filament.name}» помечен для другой модели принтера, чем «${m.printerModel}»`
        )
      );
    }
  }

  // G-code flavor present at all? (Whether it *fits the target's firmware* is a
  // target-dependent check, applied below.)
  if (m && !m.gcodeFlavor) {
    out.warnings.push(finding("gcode_flavor_missing", "У профиля принтера не задан gcode_flavor"));
  }

  // ── Target checks ───────────────────────────────────────────────────────────
  // The sliced file is produced FOR the machine profile; a concrete disagreement
  // with the bound printer's own hardware means the output would be physically
  // wrong for the device it targets. A concrete printer runs these once; a class
  // runs them per member and blocks only when NO member can safely run the set.
  if (target) {
    appendTargetChecks(out, m, f, target);
  } else if (classTargets) {
    appendClassChecks(out, m, f, classTargets);
  }

  out.warnings = dedupeFindings(out.warnings);
  out.blockers = dedupeFindings(out.blockers);
  return out;
}

/**
 * The target-dependent hardware checks for one concrete printer: nozzle Ø and model
 * are hard blockers (the output would be physically wrong); material fit and G-code
 * flavor vs firmware are soft warnings. Kept as a standalone helper so a single
 * concrete target and each member of a class run the exact same rules.
 */
function appendTargetChecks(
  out: FindingSet,
  m: MachineFields | undefined,
  f: FilamentFields | undefined,
  target: SetTarget
): void {
  if (m) {
    if (
      m.nozzleDiameterMm != null &&
      target.printerNozzleMm != null &&
      target.printerNozzleMm > 0 &&
      !approxEqual(m.nozzleDiameterMm, target.printerNozzleMm)
    ) {
      out.blockers.push(
        finding(
          "printer_nozzle_mismatch",
          `Сопло профиля принтера ${m.nozzleDiameterMm} мм не совпадает с соплом целевого принтера ${target.printerNozzleMm} мм`
        )
      );
    }
    if (m.printerModel && target.printerModel && !modelsLooselyMatch(m.printerModel, target.printerModel)) {
      out.blockers.push(
        finding(
          "printer_model_mismatch",
          `Профиль принтера рассчитан на «${m.printerModel}», а целевой принтер — «${target.printerModel}»`
        )
      );
    }
    if (m.gcodeFlavor && target.printerProtocol && !gcodeFlavorFitsProtocol(m.gcodeFlavor, target.printerProtocol)) {
      out.warnings.push(
        finding(
          "gcode_flavor_mismatch",
          `G-code flavor «${m.gcodeFlavor}» не типичен для принтера с протоколом «${target.printerProtocol}»`
        )
      );
    }
  }
  if (f?.filamentType && target.printerMaterial && !materialSupportedByPrinter(f.filamentType, target.printerMaterial)) {
    out.warnings.push(
      finding(
        "material_not_supported",
        `Филамент ${f.filamentType} не входит в список материалов принтера («${target.printerMaterial}») — проверьте, что он заправлен`
      )
    );
  }
}

/**
 * Validates the set against a *class* of interchangeable printers. An empty class
 * is a blocker (the target does not exist). Otherwise every member is checked with
 * {@link appendTargetChecks}: the set is blocked only when NOT ONE member is
 * compatible; when only some fit, that is a warning (slice on the compatible ones).
 */
function appendClassChecks(
  out: FindingSet,
  m: MachineFields | undefined,
  f: FilamentFields | undefined,
  ct: SetClassTarget
): void {
  if (ct.printers.length === 0) {
    out.blockers.push(
      finding(
        "printer_class_unknown",
        `Класс принтеров «${ct.className}» не найден среди принтеров фермы — укажите существующий класс или конкретный принтер`
      )
    );
    return;
  }
  const perPrinter = ct.printers.map((t) => {
    const s = empty();
    appendTargetChecks(s, m, f, t);
    return s;
  });
  const compatible = perPrinter.filter((s) => s.blockers.length === 0);
  if (compatible.length === 0) {
    out.blockers.push(
      finding(
        "printer_class_incompatible",
        `Набор нельзя безопасно использовать ни на одном принтере класса «${ct.className}»`
      )
    );
    // Surface the concrete reasons (deduped by the caller) so the operator sees why.
    for (const s of perPrinter) out.blockers.push(...s.blockers);
    return;
  }
  // At least one printer of the class works: keep the compatible printers' soft
  // warnings, and — if the class is heterogeneous — flag that the slice is only
  // valid on some of its members (the concrete printer is re-checked at slice time).
  for (const s of compatible) out.warnings.push(...s.warnings);
  if (compatible.length < perPrinter.length) {
    out.warnings.push(
      finding(
        "printer_class_partial",
        `Набор совместим не со всеми принтерами класса «${ct.className}» (${compatible.length} из ${perPrinter.length}) — слайсинг допустим только на совместимых`
      )
    );
  }
}

function checkLayerAgainstMachine(
  layer: number | null,
  label: string,
  m: MachineFields,
  out: FindingSet
): void {
  if (layer === null) return;
  if (m.maxLayerHeightMm !== null && layer > m.maxLayerHeightMm + 0.001) {
    out.blockers.push(
      finding(
        "layer_exceeds_max",
        `${label} ${layer} мм превышает максимум принтера ${m.maxLayerHeightMm} мм`
      )
    );
  }
  if (m.minLayerHeightMm !== null && layer < m.minLayerHeightMm - 0.001) {
    out.warnings.push(
      finding("layer_below_min", `${label} ${layer} мм ниже минимума принтера ${m.minLayerHeightMm} мм`)
    );
  }
  if (m.nozzleDiameterMm !== null && m.nozzleDiameterMm > 0) {
    const ratio = layer / m.nozzleDiameterMm;
    if (ratio > LAYER_MAX_RATIO) {
      out.blockers.push(
        finding(
          "layer_too_thick",
          `${label} ${layer} мм — ${Math.round(ratio * 100)}% диаметра сопла ${m.nozzleDiameterMm} мм (максимум ~${Math.round(LAYER_MAX_RATIO * 100)}%)`
        )
      );
    } else if (ratio > LAYER_THICK_RATIO) {
      out.warnings.push(
        finding(
          "layer_thick",
          `${label} ${layer} мм — ${Math.round(ratio * 100)}% диаметра сопла ${m.nozzleDiameterMm} мм (агрессивно)`
        )
      );
    } else if (ratio < LAYER_MIN_RATIO) {
      out.warnings.push(
        finding("layer_too_thin", `${label} ${layer} мм очень тонкая для сопла ${m.nozzleDiameterMm} мм`)
      );
    }
  }
}

/** Normalises a material string into its family tokens ("PLA / PETG" → ["PLA","PETG"]). */
function materialTokens(material: string): string[] {
  return material
    .toUpperCase()
    .split(/[\s,/|+]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function materialSupportedByPrinter(filamentType: string, printerMaterial: string): boolean {
  const want = filamentType.toUpperCase().split(/[\s-]+/)[0];
  const have = materialTokens(printerMaterial);
  if (have.length === 0) return true; // printer material unknown → don't complain
  // Exact family-token match only. A two-sided `startsWith` used to treat PET and
  // PETG (or PA and PAHT) as interchangeable because one name is a prefix of the
  // other — but those are different materials with different temps, so require the
  // family tokens to be equal. ("PETG-CF" already reduces to "PETG" via `want`.)
  return have.some((t) => t === want);
}

/** Loose model comparison: normalise to alphanumerics and require either to contain the other. */
function modelsLooselyMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const nb = b.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!na || !nb) return true; // one side unknown → don't hard-block on a comparison we can't make
  return na.includes(nb) || nb.includes(na);
}

/** True when the filament name carries a printer-model token that clashes with the machine model. */
function modelTokenMismatch(filamentName: string, printerModel: string): boolean {
  const name = filamentName.toUpperCase();
  const model = printerModel.toUpperCase();
  const checks: Array<[RegExp, RegExp]> = [
    [/@?K2\b/, /K2/],
    [/\bA1\b/, /A1/],
    [/\bBBL\b|\bBAMBU\b/, /BAMBU/]
  ];
  for (const [inName, inModel] of checks) {
    if (inName.test(name) && !inModel.test(model)) return true;
  }
  return false;
}

function gcodeFlavorFitsProtocol(flavor: string, protocol: string): boolean {
  const f = flavor.toLowerCase();
  const expected: Record<string, string[]> = {
    moonraker: ["klipper", "reprapfirmware", "marlin"],
    creality: ["klipper", "marlin"],
    bambu: ["marlin", "bbl", "klipper"]
  };
  const allowed = expected[protocol.toLowerCase()];
  if (!allowed) return true; // unknown protocol → don't complain
  return allowed.some((a) => f.includes(a));
}
