import type { CompatibilityReason, CompatibilityVerdict } from "../scheduling/compatibility";

/**
 * Choosing the printer to launch a task on — and being able to say *why*.
 *
 * The rule this replaces was "the first printer that is online", which is not a
 * decision but the order of a config file. It happily picks a printer whose bed
 * still holds the last part, whose loaded filament is the wrong family, or whose
 * copy of the file is stale, and it can never explain itself — so an operator
 * shown a choice they disagree with has nothing to argue with.
 *
 * Two properties make the result trustworthy:
 *
 *  - **Admission is not scoring.** A candidate with a blocker is never ranked
 *    "low", it is `eligible: false` and cannot be auto-selected at all. Score
 *    only ever orders printers that are *all* genuinely startable, so a large
 *    bonus can never outvote a safety refusal. (`compatibility.ts` produces the
 *    blocker/review/warning split; this module consumes it and never re-derives
 *    it.)
 *  - **Every point is attributable.** The score is a sum of named
 *    {@link ScoreComponent}s, so "Выбран Bambu Lab A1 Combo, потому что PETG уже
 *    установлен и принтер свободен" is generated from the same numbers that made
 *    the choice, not written by hand next to them.
 */

/** One named contribution to a candidate's score. */
export interface ScoreComponent {
  code: string;
  /** Operator-facing phrase, used to build the selection reason. */
  label: string;
  points: number;
}

/** What the file on the target device is known to be. */
export type DeviceFileState =
  /** Byte-identical copy confirmed present on the device. */
  | "verified"
  /** Present but not verified against the artifact (name/size unchecked). */
  | "unverified"
  /** Nothing there yet — the launch must upload it. */
  | "missing"
  /** A copy exists but describes an older artifact; it must be replaced. */
  | "stale";

/** Everything the ranking needs about one candidate printer. */
export interface LaunchCandidateInput {
  printerId: string;
  printerName: string;
  /** From `evaluateCompatibility` — never recomputed here. */
  verdict: CompatibilityVerdict;
  blockers: CompatibilityReason[];
  reviews: CompatibilityReason[];
  warnings: CompatibilityReason[];
  online: boolean;
  status: "offline" | "idle" | "printing" | "paused" | "error" | "unknown";
  /** Material the printer physically holds, when known. */
  loadedMaterial: string | null;
  /** Material the job needs, when known. */
  requiredMaterial: string | null;
  /** Nozzle physically fitted, in mm; null when unknown. */
  printerNozzleMm: number | null;
  /** Nozzle the slice was produced for, in mm; null when unknown. */
  requiredNozzleMm: number | null;
  deviceFile: DeviceFileState;
  /** Open queue length on this printer — a tie-breaker, never a blocker. */
  queueLength: number;
  /** Blocking manual operations still owed on this printer. */
  pendingManualOperations: number;
  /** Whether the orchestrator can start this printer without a human at it. */
  remoteStartSupported: boolean;
}

/** A ranked candidate: admissible or not, with the arithmetic that says why. */
export interface LaunchCandidate extends LaunchCandidateInput {
  /** True only when nothing blocks a start on this printer. */
  eligible: boolean;
  score: number;
  scoreBreakdown: ScoreComponent[];
  /** One sentence an operator can read. */
  reason: string;
}

export interface SelectionResult {
  /** Every candidate, best first; ineligible ones sort last and keep their reasons. */
  candidates: LaunchCandidate[];
  /** The auto-selected printer, or null when nothing is startable unattended. */
  recommendedPrinterId: string | null;
}

/**
 * Material families compare case-insensitively on their base name, so "PETG",
 * "petg" and a vendor's "PETG HF" all count as PETG. Deliberately *not* fuzzy
 * beyond that: PLA and PLA-CF have different temperatures, but treating "PETG"
 * and "PET" as unrelated is the safe direction to be wrong in.
 */
export function materialFamily(material: string | null): string | null {
  if (!material) return null;
  const base = material.trim().toLowerCase().split(/[\s\-_/]+/)[0];
  return base || null;
}

/** Whether the loaded filament satisfies what the job needs. Unknown ≠ match. */
export function materialMatches(required: string | null, loaded: string | null): boolean {
  const a = materialFamily(required);
  const b = materialFamily(loaded);
  return a !== null && b !== null && a === b;
}

/**
 * The here-and-now refusal a compatibility verdict does not carry: a printer
 * that is not reachable and confirmed free cannot be started at this instant,
 * whatever its profile compatibility says.
 *
 * Fail-closed on `unknown`: an unconfirmed state is not permission. This mirrors
 * the dispatch gate, which also demands a *confirmed* idle before it fires — the
 * point is that the preview refuses for the same reason the dispatch would,
 * instead of promising a start that is about to be rejected.
 */
function launchAdmission(input: LaunchCandidateInput): CompatibilityReason | null {
  if (!input.online) {
    return { code: "printer_offline", message: `Принтер «${input.printerName}» не в сети` };
  }
  if (input.status !== "idle") {
    // When the compatibility rules already named the *cause* — the code the
    // machine is showing on its own screen — restating it as "недоступен
    // (error)" adds a line and subtracts information. The named fault stands
    // alone; only an unexplained error state needs this fallback.
    if (input.status === "error") {
      return input.blockers.some((b) => NAMED_FAULT_CODES.has(b.code))
        ? null
        : {
            code: "printer_error",
            message: `Принтер «${input.printerName}» сейчас недоступен (${input.status})`
          };
    }
    return {
      code: "printer_busy",
      message: `Принтер «${input.printerName}» сейчас недоступен (${input.status})`
    };
  }
  return null;
}

/** Compatibility codes that already carry a specific physical cause. */
const NAMED_FAULT_CODES = new Set(["printer_fault", "printer_media_missing"]);

const WEIGHTS = {
  materialLoaded: 40,
  fileReady: 25,
  idle: 20,
  nozzleExact: 10,
  noManualOps: 8,
  remoteStart: 6,
  queuePenaltyPerJob: -3,
  reviewPenaltyPerItem: -5
} as const;

function scoreOf(input: LaunchCandidateInput): ScoreComponent[] {
  const parts: ScoreComponent[] = [];

  // The single most valuable property: the right filament is already in the
  // machine, so the launch needs no physical change and cannot print PETG
  // geometry in PLA.
  if (materialMatches(input.requiredMaterial, input.loadedMaterial)) {
    parts.push({
      code: "material_loaded",
      label: `${input.loadedMaterial} уже заправлен`,
      points: WEIGHTS.materialLoaded
    });
  }

  if (input.deviceFile === "verified") {
    parts.push({ code: "file_ready", label: "файл уже на принтере", points: WEIGHTS.fileReady });
  }

  if (input.online && input.status === "idle") {
    parts.push({ code: "idle", label: "принтер свободен", points: WEIGHTS.idle });
  }

  if (
    input.requiredNozzleMm !== null &&
    input.printerNozzleMm !== null &&
    Math.abs(input.requiredNozzleMm - input.printerNozzleMm) < 1e-6
  ) {
    parts.push({
      code: "nozzle_exact",
      label: `сопло ${input.printerNozzleMm} мм совпадает`,
      points: WEIGHTS.nozzleExact
    });
  }

  if (input.pendingManualOperations === 0) {
    parts.push({ code: "no_manual_ops", label: "нет незакрытых работ", points: WEIGHTS.noManualOps });
  }

  if (input.remoteStartSupported) {
    parts.push({ code: "remote_start", label: "запускается удалённо", points: WEIGHTS.remoteStart });
  }

  if (input.queueLength > 0) {
    parts.push({
      code: "queue_depth",
      label: `в очереди уже ${input.queueLength}`,
      points: WEIGHTS.queuePenaltyPerJob * input.queueLength
    });
  }

  if (input.reviews.length > 0) {
    parts.push({
      code: "needs_review",
      label: `${input.reviews.length} пункт(ов) требуют подтверждения`,
      points: WEIGHTS.reviewPenaltyPerItem * input.reviews.length
    });
  }

  return parts;
}

/**
 * The sentence the UI shows. Built from the two highest-value components that
 * actually fired, so it names the reasons that decided the ranking rather than
 * restating the whole breakdown.
 */
function buildReason(input: LaunchCandidateInput, parts: ScoreComponent[], eligible: boolean): string {
  if (!eligible) {
    const first = input.blockers[0];
    return first ? first.message : "Запуск на этом принтере невозможен";
  }
  const positives = parts.filter((p) => p.points > 0).sort((a, b) => b.points - a.points);
  if (positives.length === 0) return `${input.printerName}: подходит`;
  return `${input.printerName}: ${positives.slice(0, 2).map((p) => p.label).join(", ")}`;
}

/**
 * Ranks every candidate and names the one to launch on.
 *
 * A candidate is admissible only with an empty blocker list. `reviews` (bed not
 * confirmed, telemetry stale, …) do **not** disqualify — they are the things an
 * operator can resolve, so they cost points and are surfaced for confirmation
 * instead of hiding the printer.
 *
 * Auto-selection is stricter than manual selection on purpose: it additionally
 * requires remote-start support, since "auto" that ends with a human walking to
 * the machine is not automatic.
 */
export function selectLaunchPrinter(inputs: readonly LaunchCandidateInput[]): SelectionResult {
  const candidates: LaunchCandidate[] = inputs.map((input) => {
    // Compatibility answers "could this printer ever run this?" — a planning
    // question, which is why it files "offline" and "busy" as things a human
    // should look at rather than as refusals. A launch is a physical act *now*,
    // so those become hard blockers here. Without this, auto-select happily
    // recommends a printer that is switched off (the dispatch then refuses it,
    // and the operator is told "не готово" about a printer the UI just chose).
    const admission = launchAdmission(input);
    // Deduplicated by code: the here-and-now check and the compatibility rules
    // describe the same machine, so a printer in error used to produce two
    // near-identical `printer_error` lines — and an operator reading four
    // reasons for one physical fault stops reading them.
    const blockers =
      admission && !input.blockers.some((b) => b.code === admission.code)
        ? [...input.blockers, admission]
        : input.blockers;
    const eligible = blockers.length === 0;
    const scoreBreakdown = eligible ? scoreOf(input) : [];
    const score = scoreBreakdown.reduce((sum, p) => sum + p.points, 0);
    return {
      ...input,
      blockers,
      eligible,
      score,
      scoreBreakdown,
      reason: buildReason({ ...input, blockers }, scoreBreakdown, eligible)
    };
  });

  candidates.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    // Stable, explainable tie-break so equally-good printers do not reorder
    // between two reads of the same state.
    return a.printerId.localeCompare(b.printerId);
  });

  const best = candidates.find((c) => c.eligible && c.remoteStartSupported) ?? null;
  return { candidates, recommendedPrinterId: best ? best.printerId : null };
}
