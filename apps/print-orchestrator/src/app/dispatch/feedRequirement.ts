import type { ArtifactAnalysis } from "../../domain/print/types";
import type { FeedFilament, FeedRequirement } from "../../domain/printers/feedPlan";

/**
 * **What the file that will actually be sent needs fed into the printer.**
 *
 * Two shapes reach a Bambu, and they are read differently:
 *
 *  - **bare G-code** (our own slice, or an uploaded `.gcode`) is wrapped at
 *    delivery into a plate package that declares exactly *one* filament
 *    (`slice_info`, `filament id="1"`), so the job uses filament 0 and its
 *    material is the task's. A G-code that selects several tools cannot be
 *    described by that package, and is refused rather than mapped by guesswork.
 *  - **an uploaded `.gcode.3mf`** is delivered as-is, and its own `slice_info`
 *    names the filaments the plate uses — id, type and colour — which is exactly
 *    what the mapping is indexed by.
 *
 * Returns `null` requirement with a reason when the file cannot be described.
 */
export function feedRequirementFor(input: {
  analysis: ArtifactAnalysis | null;
  /** The material the task/binding asks for (operator, profile or analysis). */
  material: string | null;
}): { requirement: FeedRequirement | null; problem: string | null } {
  const { analysis } = input;
  const data = analysis?.data ?? {};

  if (analysis?.detectedFormat === "3mf") {
    const filaments = slicedPlateFilaments(data);
    if (filaments === null) {
      return {
        requirement: null,
        problem: "в нарезанном 3MF не указано, какие филаменты использует пластина — лотки AMS сопоставить не с чем"
      };
    }
    const declared = typeof data.filamentSlotCount === "number" ? data.filamentSlotCount : 0;
    return {
      requirement: {
        filaments: filaments.map((f) => ({
          ...f,
          // The package names a type for every filament it uses; the task's own
          // material only fills a gap, never overrides what the file says.
          material: f.material ?? input.material
        })),
        slotCount: Math.max(declared, ...filaments.map((f) => f.index + 1))
      },
      problem: null
    };
  }

  const tools = toolsUsed(data);
  if (tools.length > 1) {
    return {
      requirement: null,
      problem: `G-code использует ${tools.length} инструмента — пакет Albedo описывает один филамент, многоцветный запуск через AMS не поддерживается`
    };
  }
  return {
    requirement: { filaments: [{ index: 0, material: input.material, color: null }], slotCount: 1 },
    problem: null
  };
}

/** Tool numbers a G-code selects; `[0]`-like when only a count (≤ 1) is known. */
function toolsUsed(data: Record<string, unknown>): number[] {
  const listed = data.toolsUsed;
  if (Array.isArray(listed)) {
    return listed.filter((t): t is number => typeof t === "number" && Number.isInteger(t) && t >= 0);
  }
  const count = data.toolCount;
  if (typeof count === "number" && Number.isFinite(count) && count > 1) {
    return Array.from({ length: Math.floor(count) }, (_, i) => i);
  }
  return [0];
}

/**
 * The filaments the (single) plate of a sliced package uses, from its
 * `slice_info` estimate, or null when the analysis does not carry them.
 */
function slicedPlateFilaments(data: Record<string, unknown>): FeedFilament[] | null {
  const plates = Array.isArray(data.plates) ? data.plates : [];
  if (plates.length !== 1) return null;
  const plate = plates[0];
  if (!plate || typeof plate !== "object") return null;
  const estimate = (plate as Record<string, unknown>).estimate;
  if (!estimate || typeof estimate !== "object") return null;
  const raw = (estimate as Record<string, unknown>).filaments;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: FeedFilament[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const id = rec.id;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) continue;
    out.push({
      index: id - 1,
      material: typeof rec.type === "string" && rec.type.trim() ? rec.type.trim() : null,
      color: typeof rec.colorHex === "string" ? rec.colorHex : null
    });
  }
  return out.length > 0 ? out : null;
}
