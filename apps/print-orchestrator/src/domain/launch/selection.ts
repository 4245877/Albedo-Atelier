import type { CompatibilityVerdict } from "../scheduling/compatibility";

/**
 * One refusal/《confirm this》/note, in the vocabulary the *launch* speaks.
 *
 * Deliberately not `CompatibilityReason`: the launch admission is now the whole
 * {@link file://../dispatch/eligibility.ts DispatchEligibility} at its
 * `preflight` stage, whose codes are the SCREAMING_SNAKE dispatch contract, and
 * whose lifted preflight reasons carry their original lower-case code as
 * evidence. Both must survive to the operator, so this is the shape that carries
 * both plus the one thing the UI must never guess: whether a human may accept it.
 */
export interface LaunchReason {
  /** The dispatch contract code (`TARGET_PRINTER_MISMATCH`, …). */
  code: string;
  message: string;
  /** The originating preflight code, when this reason was lifted from one. */
  preflightCode?: string;
  /**
   * Which preflight bucket it came from — `blocker` | `review` | `warning`.
   * Severity says whether the launch may proceed; this says whether there is an
   * open question a human could close, which the flattened severity cannot.
   */
  origin?: string;
  /** Whether a named operator may accept this and proceed. Decided upstream. */
  overridable?: boolean;
  /**
   * The confirmation code that *resolves* this reason by causing a real
   * server-side action (writing a bed-clear event, recording a material
   * assertion) — as opposed to waiving it. Absent when there is none.
   */
  confirmation?: string;
}

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
  /** From the preflight eligibility — never recomputed here. */
  verdict: CompatibilityVerdict;
  blockers: LaunchReason[];
  reviews: LaunchReason[];
  warnings: LaunchReason[];
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
  /** How many *other* printers could also take this job right now. */
  alternativeCount: number;
  /** One sentence naming the automatic choice and its alternatives; null when none. */
  recommendation: string | null;
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
 * `launchAdmission` used to live here: a second, private copy of "offline and
 * busy are refusals *now*, whatever the planner thinks". It existed because the
 * preview ran `evaluateCompatibility`, which files those as things a human
 * should look at rather than as blockers.
 *
 * The preview now runs the real {@link evaluateDispatchEligibility} at its
 * `preflight` stage, which already says exactly that — and says a dozen more
 * things the local copy never knew (the file's declared target printer, the
 * G-code flavor, remote-start support, the queue shape). A second implementation
 * of an admission rule is precisely what the launch service is documented not to
 * have, so it is gone: `blockers` arrives decided.
 */

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
    const blockers = input.blockers;
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
  const startable = candidates.filter((c) => c.eligible && c.remoteStartSupported);
  return {
    candidates,
    recommendedPrinterId: best ? best.printerId : null,
    alternativeCount: Math.max(0, startable.length - 1),
    recommendation: best ? recommendationSentence(best, startable.length - 1) : null
  };
}

/**
 * Why *this* printer was chosen, in the operator's words — and how many others
 * would also have worked.
 *
 * The count is the half that was missing. "Выбран A1" with no alternatives named
 * reads as the only option, so an operator with a free second machine never
 * learns they had a choice; and when there genuinely is only one, saying so is
 * more useful than any ranking explanation.
 */
function recommendationSentence(best: LaunchCandidate, others: number): string {
  if (others <= 0) {
    return `${best.printerName} — единственный принтер, готовый принять это задание`;
  }
  const positives = best.scoreBreakdown
    .filter((p) => p.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 2)
    .map((p) => p.label);
  const because = positives.length > 0 ? `: ${positives.join(", ")}` : "";
  return `Выбран ${best.printerName} автоматически${because}. Ещё ${others} ${plural(others, "подходит", "подходят", "подходят")}`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}
