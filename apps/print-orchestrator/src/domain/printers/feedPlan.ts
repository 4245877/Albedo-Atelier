/**
 * **Which spool feeds which filament of a job — decided from the job, never from
 * "the first loaded tray".**
 *
 * A Bambu start names its filament source explicitly: `use_ams` plus an
 * `ams_mapping` array, indexed by the job's own filament order, whose values are
 * global tray ids (`ams_id × 4 + slot`). The start used to fill that array with
 * whichever AMS tray happened to be loaded first — the material the job was
 * sliced and verified for played no part — so a PETG job on a machine with PLA
 * in slot 1 and PETG in slot 3 printed in PLA, after every check had passed.
 *
 * The rules, all fail-closed:
 *
 *  - **No AMS reported** → the external spool (`use_ams: false`). Whether *that*
 *    spool holds the right material is the ordinary material rule's question.
 *  - **AMS present** → every filament the job uses must be matched to a tray
 *    holding *its* material. Exact (normalised) type wins; a colour, when the job
 *    names one, narrows a tie; the tray the printer is currently feeding breaks a
 *    remaining tie. Still more than one → `ambiguous`, and an operator chooses.
 *  - **An explicit choice** may pick a tray of the same material *family* (a
 *    "PLA Matte" spool for a "PLA" job); a different family is refused even when
 *    a person asks for it.
 *  - **The job's material unknown, or the AMS report missing** → unresolved.
 *    Guessing the source is exactly the defect this replaces.
 *
 * Pure. The caller reads the live trays and the job; the start command and the
 * admission check both use the plan this returns, and the start re-resolves it
 * against a fresh report right before publishing.
 */

/** One spool the printer could feed from, as the device reported it. */
export interface FeedTray {
  /** Global tray id: `ams_id × 4 + slot` for an AMS slot, 254 for the external spool. */
  trayId: number;
  /** True for the external spool holder (`vt_tray`). */
  external: boolean;
  material: string | null;
  /** `#RRGGBB` when reported. */
  color: string | null;
  /** True when the printer reports feeding from it right now (`tray_now`). */
  active: boolean;
}

/** One filament the job uses, by its index in the job's own filament list (0-based). */
export interface FeedFilament {
  index: number;
  material: string | null;
  color: string | null;
}

export interface FeedRequirement {
  filaments: FeedFilament[];
  /**
   * Length of the job's filament list (the mapping array's length). Filaments
   * the plate does not use are mapped to -1.
   */
  slotCount: number;
}

/** A per-filament mapping entry, with the tray it was matched to. */
export interface FeedAssignment {
  filamentIndex: number;
  trayId: number;
  material: string | null;
  color: string | null;
  /** How the tray was chosen — for the operator and the audit trail. */
  how: "exact" | "color" | "active" | "operator";
}

export type FeedPlan =
  | {
      kind: "external";
      /** The spool the job will draw from, when reported. */
      tray: FeedTray | null;
      reason: string;
    }
  | {
      kind: "ams";
      /** `ams_mapping` — indexed by filament, value = global tray id, -1 unused. */
      mapping: number[];
      /** `ams_mapping2` — the same, as `{ams_id, slot_id}` (255/255 unused). */
      mapping2: { ams_id: number; slot_id: number }[];
      assignments: FeedAssignment[];
    }
  | {
      kind: "unresolved";
      code: FeedProblemCode;
      message: string;
      /** For each unresolved filament, the trays an operator may choose from. */
      choices: { filamentIndex: number; material: string | null; trays: FeedTray[] }[];
    };

export type FeedProblemCode =
  /** No AMS tray holds the job's material. */
  | "AMS_MATERIAL_MISMATCH"
  /** Several trays hold it and nothing tells them apart — an operator chooses. */
  | "AMS_SLOT_AMBIGUOUS"
  /** The job does not say what material it needs. */
  | "AMS_MATERIAL_UNKNOWN"
  /** No usable AMS report (no telemetry, or the AMS block is missing). */
  | "AMS_STATE_UNKNOWN"
  /** A combination this farm does not start: mixed AMS + external feeding, unknown unit layout. */
  | "AMS_FEED_UNSUPPORTED";

/** The global id Bambu uses for the external spool. */
export const EXTERNAL_TRAY_ID = 254;

export interface ResolveFeedInput {
  /**
   * The trays the printer reports, AMS slots and external spool alike; null when
   * there is no report at all.
   */
  trays: FeedTray[] | null;
  /** Whether the printer reports any AMS unit. */
  hasAms: boolean;
  requirement: FeedRequirement;
  /** Operator choice: filament index → tray id. */
  choice?: Readonly<Record<number, number>> | null;
}

export function resolveFeedPlan(input: ResolveFeedInput): FeedPlan {
  const { requirement } = input;
  if (!input.hasAms) {
    const external = input.trays?.find((t) => t.external) ?? null;
    return {
      kind: "external",
      tray: external,
      reason: "AMS не подключён — печать с внешней катушки"
    };
  }
  if (input.trays === null) {
    return unresolved(
      "AMS_STATE_UNKNOWN",
      "принтер не сообщает состояние AMS — источник филамента нельзя выбрать",
      []
    );
  }

  const used = [...requirement.filaments].sort((a, b) => a.index - b.index);
  if (used.length === 0) {
    return unresolved("AMS_MATERIAL_UNKNOWN", "задание не сообщает, какие филаменты использует", []);
  }
  const unknown = used.filter((f) => !normalizeFeedMaterial(f.material));
  if (unknown.length > 0) {
    return unresolved(
      "AMS_MATERIAL_UNKNOWN",
      "материал задания неизвестен — лоток AMS нельзя сопоставить; укажите материал задания",
      unknown.map((f) => ({ filamentIndex: f.index, material: null, trays: input.trays ?? [] }))
    );
  }

  const assignments: FeedAssignment[] = [];
  const ambiguous: { filamentIndex: number; material: string | null; trays: FeedTray[] }[] = [];
  const mismatched: { filament: FeedFilament; trays: FeedTray[] }[] = [];

  for (const filament of used) {
    const chosenId = input.choice?.[filament.index];
    if (chosenId !== undefined && chosenId !== null) {
      const tray = input.trays.find((t) => t.trayId === chosenId) ?? null;
      if (!tray) {
        return unresolved(
          "AMS_MATERIAL_MISMATCH",
          `выбранный лоток ${trayLabel({ trayId: chosenId, external: chosenId === EXTERNAL_TRAY_ID })} не найден в отчёте принтера`,
          [{ filamentIndex: filament.index, material: filament.material, trays: input.trays }]
        );
      }
      if (!sameFamily(tray.material, filament.material)) {
        return unresolved(
          "AMS_MATERIAL_MISMATCH",
          `в выбранном лотке ${trayLabel(tray)} — ${tray.material ?? "неизвестный материал"}, а задание требует ${filament.material}`,
          [{ filamentIndex: filament.index, material: filament.material, trays: input.trays }]
        );
      }
      assignments.push(toAssignment(filament, tray, "operator"));
      continue;
    }

    const exact = input.trays.filter((t) => sameMaterial(t.material, filament.material));
    if (exact.length === 0) {
      mismatched.push({
        filament,
        trays: input.trays.filter((t) => sameFamily(t.material, filament.material))
      });
      continue;
    }
    if (exact.length === 1) {
      assignments.push(toAssignment(filament, exact[0], "exact"));
      continue;
    }
    const wantColor = normalizeColor(filament.color);
    const byColor = wantColor ? exact.filter((t) => normalizeColor(t.color) === wantColor) : [];
    if (byColor.length === 1) {
      assignments.push(toAssignment(filament, byColor[0], "color"));
      continue;
    }
    const pool = byColor.length > 1 ? byColor : exact;
    // "The tray it is feeding from right now" only settles a SINGLE-filament job.
    // With several, the same active tray would win for each of them and the
    // whole model would print in one spool — the silent failure this replaces.
    const active = used.length === 1 ? pool.filter((t) => t.active) : [];
    if (active.length === 1) {
      assignments.push(toAssignment(filament, active[0], "active"));
      continue;
    }
    ambiguous.push({ filamentIndex: filament.index, material: filament.material, trays: pool });
  }

  // Two filaments of one job drawn from one tray is a one-colour print of a
  // multi-colour job. Only an operator who said so explicitly may ask for it.
  const byTray = new Map<number, FeedAssignment[]>();
  for (const a of assignments) byTray.set(a.trayId, [...(byTray.get(a.trayId) ?? []), a]);
  for (const [trayId, shared] of byTray) {
    if (shared.length > 1 && shared.some((a) => a.how !== "operator")) {
      const tray = input.trays.find((t) => t.trayId === trayId) ?? null;
      return unresolved(
        "AMS_SLOT_AMBIGUOUS",
        `несколько филаментов задания совпали с одним лотком (${tray ? trayLabel(tray) : trayId}) — выберите лоток для каждого`,
        shared.map((a) => ({
          filamentIndex: a.filamentIndex,
          material: a.material,
          trays: input.trays!.filter((t) => sameFamily(t.material, a.material))
        }))
      );
    }
  }

  if (mismatched.length > 0) {
    const first = mismatched[0];
    const loaded = input.trays
      .map((t) => `${trayLabel(t)}: ${t.material ?? "пусто/неизвестно"}`)
      .join(", ");
    return unresolved(
      "AMS_MATERIAL_MISMATCH",
      `ни в одном лотке нет ${first.filament.material} (${loaded || "лотки пусты"})` +
        (first.trays.length > 0 ? " — есть лотки того же семейства, их можно выбрать явно" : ""),
      mismatched.map((m) => ({
        filamentIndex: m.filament.index,
        material: m.filament.material,
        trays: m.trays
      }))
    );
  }
  if (ambiguous.length > 0) {
    return unresolved(
      "AMS_SLOT_AMBIGUOUS",
      `${ambiguous[0].material} есть в нескольких лотках (${ambiguous[0].trays.map(trayLabel).join(", ")}) — выберите, из какого печатать`,
      ambiguous
    );
  }

  const externalCount = assignments.filter((a) => a.trayId === EXTERNAL_TRAY_ID).length;
  if (externalCount === assignments.length) {
    const tray = input.trays.find((t) => t.external) ?? null;
    return { kind: "external", tray, reason: "материал задания — на внешней катушке" };
  }
  if (externalCount > 0) {
    return unresolved(
      "AMS_FEED_UNSUPPORTED",
      "часть филаментов задания — на внешней катушке, часть — в AMS; такой запуск не поддерживается",
      []
    );
  }

  const slotCount = Math.max(requirement.slotCount, ...assignments.map((a) => a.filamentIndex + 1));
  const mapping = new Array<number>(slotCount).fill(-1);
  const mapping2 = Array.from({ length: slotCount }, () => ({ ams_id: 255, slot_id: 255 }));
  for (const a of assignments) {
    if (a.trayId < 0 || a.trayId >= 128) {
      // AMS HT and other unit layouts number their trays differently; refuse
      // rather than send an id whose meaning we have not verified.
      return unresolved(
        "AMS_FEED_UNSUPPORTED",
        `лоток ${a.trayId} относится к блоку, раскладка которого не поддерживается`,
        []
      );
    }
    mapping[a.filamentIndex] = a.trayId;
    mapping2[a.filamentIndex] = { ams_id: Math.floor(a.trayId / 4), slot_id: a.trayId % 4 };
  }
  return { kind: "ams", mapping, mapping2, assignments };
}

/**
 * Re-checks a pinned plan against the trays as they are *now* — the last step
 * before a start is published. Null when every pinned tray still holds what the
 * plan matched it for; otherwise the operator-facing reason the start must not go.
 */
export function verifyPinnedFeed(plan: FeedPlan, trays: FeedTray[] | null, hasAms: boolean): string | null {
  if (plan.kind === "unresolved") return plan.message;
  if (plan.kind === "external") {
    if (hasAms && trays === null) return "принтер не сообщает состояние подачи филамента";
    return null;
  }
  if (!hasAms || trays === null) {
    return "AMS больше не сообщается принтером — выбранные лотки нельзя подтвердить";
  }
  for (const a of plan.assignments) {
    const tray = trays.find((t) => t.trayId === a.trayId);
    if (!tray) return `лоток ${trayLabel({ trayId: a.trayId, external: false })} больше не виден в AMS`;
    if (!sameFamily(tray.material, a.material) || (a.how !== "operator" && !sameMaterial(tray.material, a.material))) {
      return `в лотке ${trayLabel(tray)} теперь ${tray.material ?? "неизвестный материал"}, а запуск был подготовлен для ${a.material}`;
    }
    const pinnedColor = normalizeColor(a.color);
    if (pinnedColor && normalizeColor(tray.color) !== pinnedColor) {
      return `в лотке ${trayLabel(tray)} сменился цвет катушки (${tray.color ?? "—"} вместо ${a.color})`;
    }
  }
  return null;
}

/** "AMS 1 · лоток 3" / "внешняя катушка" — how an operator names a tray. */
export function trayLabel(tray: Pick<FeedTray, "trayId" | "external">): string {
  if (tray.external || tray.trayId === EXTERNAL_TRAY_ID) return "внешняя катушка";
  const ams = Math.floor(tray.trayId / 4) + 1;
  const slot = (tray.trayId % 4) + 1;
  return `AMS ${ams} · лоток ${slot}`;
}

/** Upper-cased, separator-normalised material type: "petg hf" → "PETG-HF". */
export function normalizeFeedMaterial(material: string | null | undefined): string | null {
  if (typeof material !== "string") return null;
  const value = material.trim().toUpperCase().replace(/[\s_]+/g, "-");
  return value.length > 0 ? value : null;
}

function sameMaterial(a: string | null, b: string | null): boolean {
  const na = normalizeFeedMaterial(a);
  const nb = normalizeFeedMaterial(b);
  return na !== null && na === nb;
}

/** First token of the type — "PLA-MATTE" and "PLA" share a family; "PLA" and "PETG" do not. */
function sameFamily(a: string | null, b: string | null): boolean {
  const fa = normalizeFeedMaterial(a)?.split("-")[0] ?? null;
  const fb = normalizeFeedMaterial(b)?.split("-")[0] ?? null;
  return fa !== null && fa === fb;
}

function normalizeColor(color: string | null | undefined): string | null {
  if (typeof color !== "string") return null;
  const hex = color.trim().replace(/^#/, "").toUpperCase();
  // Bambu reports RRGGBBAA; the alpha says nothing about which spool this is.
  const rgb = hex.length === 8 ? hex.slice(0, 6) : hex;
  return /^[0-9A-F]{6}$/.test(rgb) ? `#${rgb}` : null;
}

function toAssignment(filament: FeedFilament, tray: FeedTray, how: FeedAssignment["how"]): FeedAssignment {
  return {
    filamentIndex: filament.index,
    trayId: tray.trayId,
    material: tray.material ?? filament.material,
    color: tray.color,
    how
  };
}

function unresolved(
  code: FeedProblemCode,
  message: string,
  choices: { filamentIndex: number; material: string | null; trays: FeedTray[] }[]
): FeedPlan {
  return { kind: "unresolved", code, message, choices };
}
