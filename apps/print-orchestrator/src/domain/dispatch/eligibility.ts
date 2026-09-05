/**
 * `DispatchEligibility` — the single authoritative answer to "may THIS verified
 * file start on THIS printer right now?".
 *
 * Two layers, one rule set:
 *
 *  - **PreflightCompatibility** ({@link evaluateCompatibility}, unchanged): can
 *    this model be made on this printer *at all* — size vs build volume,
 *    technology, material, nozzle, profile availability, AMS, printer class.
 *    Answers `compatible | review | blocked` and is what the matrix preview and
 *    the planner consume.
 *  - **DispatchEligibility** (this module): everything preflight says, *plus*
 *    the here-and-now facts a physical start depends on — bed clearance, device
 *    file identity, telemetry freshness, a confirmed plan reservation, the night
 *    window, and no other live run. It is a strict superset: a preflight blocker
 *    is always a dispatch blocker.
 *
 * Called from exactly three places (§2.1 of the brief):
 *   1. compatibility/eligibility preview — `SchedulerService.dispatchEligibility`;
 *   2. plan confirmation — same call, per placed assignment;
 *   3. immediately before the physical start, *inside* the dispatch reserve
 *      transaction — `DispatchService.reserve`.
 *
 * Pure and synchronous: the caller resolves every fact, this only classifies.
 * Every unknown critical is a blocker, never a pass — fail-closed by construction.
 */

import { gcodeFlavorFitsProtocol } from "../shared/gcodeFlavor";
import { normalizePrinterModel, printerModelsMatchStrict } from "../slicing/printerModel";
import {
  evaluateCompatibility,
  type CompatibilityConfig,
  type CompatibilityEvidence,
  type CompatibilityPrinterInput,
  type CompatibilityResult,
  type CompatibilityTaskInput,
  type PreflightReasonCode
} from "../scheduling/compatibility";
import { ACKNOWLEDGEABLE_VERDICTS } from "../print/analysisReview";
import { evaluateNightWindowFit, type NightWindowFit } from "../scheduling/nightWindow";
import {
  REASON,
  reason,
  statusOf,
  type EligibilityReason,
  type EligibilityResult,
  type ReasonCode
} from "./reasons";

export type DispatchMode = "manual" | "night";

/**
 * **Which half of the launch this evaluation is deciding.**
 *
 * The rules are one set; what differs is how much of the world is knowable yet.
 *
 *  - `preflight` — everything that can be answered *before a byte moves*: the
 *    printer's state and class, the file's declared target and flavor, the build
 *    volume, the nozzle, the material, the bed, manual operations, remote-start
 *    capability, the queue and the reservation, telemetry freshness. Run twice:
 *    once for the preview the operator reads, once again immediately before the
 *    delivery starts.
 *  - `dispatch` — the preflight rules **plus** the ones that only become
 *    answerable once the file is on the device: it exists, under the expected
 *    name, at the expected size, tracked by a delivery of ours.
 *
 * The split exists because the two used to be *different rule sets*. The preview
 * ran `evaluateCompatibility` alone, so it never checked the file's declared
 * target printer, the G-code flavor, remote-start support or the queue shape —
 * and cheerfully offered a K2 for a file sliced for an A1. The operator
 * confirmed, the file was uploaded to the K2, and only then did the dispatch
 * gate refuse. Every such refusal was knowable before the transfer, and now is:
 * `preflight` is a strict subset of `dispatch`, so a preview that passes can only
 * be overtaken by something that *changed*, never by something that was already
 * true.
 */
export type EligibilityStage = "preflight" | "dispatch";

/** How strongly the on-device file was matched against the registered artifact. */
export type DeviceFileIdentity =
  /** Listing not attempted yet (preview stage) — unknown, not proof of anything. */
  | "unchecked"
  /** The adapter cannot list files at all. */
  | "unsupported"
  /** Listing ran and the file is absent. */
  | "missing"
  /** Present, but only its name could be compared. */
  | "name-only"
  /** Present and its size matches the analysed artifact. */
  | "name+size";

/** The confirmed plan reservation a dispatch must execute verbatim, when there is one. */
export interface DispatchReservation {
  planId: string | null;
  assignmentId: string;
  /** The printer the confirmed assignment binds the task to. */
  printerId: string;
  /** Confirmed slice variant, when the plan was built from a slice. */
  sliceVariantId: string | null;
  /** Artifact content hash captured when the plan was confirmed. */
  artifactSha256: string | null;
  /** Profile revisions the confirmed slice was produced with. */
  profileRevisionIds: string[];
  /** Path the file is expected to occupy on the device. */
  expectedRemotePath: string | null;
  /** True when the binding stopped matching its task (re-sliced, re-queued, withdrawn). */
  stale: boolean;
  staleReason: string | null;
}

/** The tracked state of the file on the target device, as the caller resolved it. */
export interface DeviceArtifactFacts {
  state: string;
  transferMode: string;
  verification: string | null;
  remotePath: string;
  lastError: string | null;
  /**
   * True when the record no longer describes what this dispatch would print
   * (slice variant, artifact hash, printer, path, size, profiles or assignment
   * changed). Resolved by the caller — see `stalenessOf` — exactly like
   * {@link DispatchReservation.stale}.
   */
  stale: boolean;
  staleReason: string | null;
}

export interface DispatchFacts {
  mode: DispatchMode;
  /**
   * How far the launch has got. Defaults to `dispatch` (the strict, complete
   * rule set) when a caller does not say — an evaluator that forgets to declare
   * its stage must not accidentally get the lenient one.
   */
  stage?: EligibilityStage;

  // ── Task / queue shape ────────────────────────────────────────────────────
  taskState: string;
  entryState: string | null;
  /**
   * **When** the operator allows this job to run — the time preference, derived
   * by the caller from the task's single `dayNightPreference` field.
   *
   * Distinct from {@link unattendedAllowed}, which answers a different question:
   * whether it may run with nobody present. The two used to be a boolean `night`
   * flag *and* a `dayNightPreference` enum that the operator had to keep in sync
   * by hand, with the enum read by nothing at all. There is now one field, and
   * this is its projection.
   */
  night: boolean;
  /** Whether the job may run with no operator present. A permission, not a time. */
  unattendedAllowed: boolean;

  // ── File identity ─────────────────────────────────────────────────────────
  /** Resolved on-device path, or null when the task names no file. */
  file: string | null;
  /** False when the path fails `normalizeStartablePath`. */
  filePathValid: boolean;
  artifact: { id: string; sha256: string | null; sizeBytes: number | null; updatedAt: string } | null;
  analysis: {
    id: string;
    state: string;
    verdict: string | null;
    detectedFormat: string | null;
    blockers: { code: string; message: string }[];
    analyzerVersion: string | null;
    updatedAt: string;
    /** Target printer/model the file itself declares (`;printer_model=`), when any. */
    declaredTargetPrinter: string | null;
    /** G-code flavor the file itself declares, when any. */
    declaredGcodeFlavor: string | null;
    /**
     * For a 3MF: whether the archive was found to carry a real sliced plate
     * payload, as opposed to being a model or a slicer project. `null` when the
     * question does not apply or the analysis did not answer it — and `null`
     * refuses, because "probably a print" is not evidence.
     */
    containsGcodePayload?: boolean | null;
    /**
     * Whether a named operator has read and accepted a `review` verdict for
     * *this* analysis of *these* bytes — see
     * {@link file://../print/analysisReview.ts}. Resolved by the caller, never
     * inferred here, and it clears exactly one refusal: the verdict itself.
     * Analysis blockers, night mode and every other gate are untouched.
     */
    reviewAccepted?: boolean;
    /** Who accepted it and when, for the refusal text and the audit trail. */
    reviewAcceptedBy?: string | null;
    reviewAcceptedAt?: string | null;
  } | null;
  currentAnalyzerVersion: string;
  deviceFileIdentity: DeviceFileIdentity;

  // ── Printer here-and-now ──────────────────────────────────────────────────
  /**
   * The machine's **model** — the only field that establishes what hardware this
   * is (`"Bambu Lab A1"`, `"Creality K2"`). Null/empty when unconfigured.
   *
   * Split from the other two on purpose. These used to be one `printerLabels`
   * array, compared against a file's declared target by substring, and the mix
   * was wrong twice over: an operator's free-text *name* ("A1 у окна", "принтер
   * Пети") is decoration and must never establish hardware identity, and the
   * substring test made `"Bambu Lab A1"` match a printer labelled `"Bambu Lab A1
   * mini"` — a different bed, different nozzle limits, and a file that would be
   * accepted onto it.
   */
  printerModel: string | null;
  /**
   * The interchangeability **class** a class-scoped slice may target (every
   * "Creality K2" is class `k2`). A legitimate second identity for the same
   * comparison, and kept separate because it answers a different question.
   */
  printerClass: string | null;
  /** The operator-facing name. Shown in refusals, never compared. */
  printerName: string | null;
  /** Transport/firmware family (moonraker | bambu | creality); null when unknown. */
  printerProtocol: string | null;
  remoteStartSupported: boolean;
  /** Live status; `undefined` when no telemetry exists at all. */
  liveStatus: { online: boolean; status: string } | undefined;
  telemetryAgeMs: number | null;
  /** Any active PrintRun already holding this printer (id + state), or null. */
  activeRun: { id: string; state: string } | null;
  /** An unresolved durable start guard on this printer, or null. */
  startGuard: { file: string; state: string } | null;
  /** Live bed cycle state, or null when nothing is tracked (→ unknown). */
  bedState: string | null;
  /**
   * Whether the printer has a *configured and verified* mechanism that leaves
   * the bed clear without an operator (auto-eject, belt, part removal). Only
   * such a printer may continue a queue automatically.
   */
  automaticContinuationAllowed: boolean;

  // ── Operator / manual operations ──────────────────────────────────────────
  /**
   * The blocking manual operations still open on this printer (part removal,
   * nozzle change, …). A non-empty list means the machine is physically held.
   * Resolved by the caller from `ManualOperationService.openBlockingFor`.
   */
  blockingOperations: {
    id: string;
    type: string;
    state: string;
    label: string;
    /** Expected hands-on minutes; null when nobody has estimated it (fail-closed). */
    minutes: number | null;
  }[];
  /**
   * Where the operator is right now: `AVAILABLE` | `ASLEEP` | `AWAY` | `OFF` |
   * `UNKNOWN`. `UNKNOWN` is the absence of a schedule, not a schedule that says
   * no — only the former is a fail-closed stop.
   */
  operatorPresence: string;
  /** False when the schedule/timezone could not be resolved at all. */
  operatorScheduleResolved: boolean;
  /** Why the operator is (un)available — operator-facing text for the refusal. */
  operatorReason: string;

  // ── Plan binding ──────────────────────────────────────────────────────────
  reservation: DispatchReservation | null;
  /** The printer this dispatch is actually about to start on. */
  targetPrinterId: string;
  /** The slice variant this dispatch would send, when the work is sliced. */
  sliceVariantId: string | null;
  /** Profile revisions the task's *current* executable resolves to (vs. the reservation's). */
  currentProfileRevisionIds: string[];
  /**
   * Whether the adapter can push a file to the device at all. When it cannot, the
   * bytes got there by hand and only an operator confirmation (a
   * `DeviceArtifact` in `PRESENT_UNVERIFIED`/`VERIFIED`) may authorise a start.
   */
  adapterUploadSupported: boolean;
  /** The tracked device file for the path this dispatch would start; null when untracked. */
  deviceArtifact: DeviceArtifactFacts | null;

  // ── Night ─────────────────────────────────────────────────────────────────
  /** ETA in minutes from analysis/slice; null when genuinely unknown. */
  etaMinutes: number | null;
  nightWindow: string;
  farmTimeZone: string;
  nightSafetyBufferRatio: number;
  now: Date;
}

export interface DispatchEligibilityInput {
  preflight: {
    task: CompatibilityTaskInput;
    printer: CompatibilityPrinterInput;
    evidence: CompatibilityEvidence;
    config?: CompatibilityConfig;
  };
  facts: DispatchFacts;
}

export interface DispatchEligibility extends EligibilityResult {
  /** The preflight verdict this eligibility was built on (for UI/debug). */
  preflight: CompatibilityResult;
  /** Resolved night-window arithmetic; null outside night mode or when unresolvable. */
  nightWindowFit: NightWindowFit | null;
}

/**
 * Maps a preflight `CompatibilityReason.code` onto a stable dispatch reason code.
 * Preflight codes are lower-case and scheduler-facing; the dispatch contract uses
 * the SCREAMING_SNAKE vocabulary the UI/audit/tests key off.
 *
 * `Record<PreflightReasonCode, …>` is the point of the type: this used to be
 * `Record<string, …>` read through a `?? REASON.MAINTENANCE_BLOCKED`, and three
 * codes were simply never added — `printer_fault`, `printer_media_missing` and
 * `launch_unconfirmed`. Each therefore reached the operator as "принтер на
 * обслуживании", *and* inherited that code's override policy: MAINTENANCE_BLOCKED
 * is overridable, so a printer displaying a start-blocking fault, a printer with
 * no SD card, and a printer still holding an unconfirmed previous launch could
 * all be waved through from the launch screen. The last of those is the guard
 * against printing one model twice.
 *
 * With the vocabulary closed, adding a preflight reason without deciding what it
 * means here is a compile error rather than a silent downgrade.
 */
const PREFLIGHT_CODE_MAP: Record<PreflightReasonCode, ReasonCode> = {
  pinned_elsewhere: REASON.PINNED_ELSEWHERE,
  maintenance: REASON.MAINTENANCE_BLOCKED,
  printer_error: REASON.PRINTER_ERROR,
  printer_offline: REASON.PRINTER_OFFLINE,
  telemetry_missing: REASON.TELEMETRY_MISSING,
  telemetry_stale: REASON.TELEMETRY_STALE,
  slicing_unavailable: REASON.SLICING_UNAVAILABLE,
  profileset_quarantined: REASON.PROFILE_SET_QUARANTINED,
  slice_missing: REASON.SLICE_VARIANT_MISSING,
  profileset_unapproved: REASON.PROFILE_SET_NOT_APPROVED,
  profileset_unknown: REASON.PROFILE_SET_NOT_APPROVED,
  task_material_unknown: REASON.MATERIAL_UNKNOWN,
  printer_material_unknown: REASON.MATERIAL_UNKNOWN,
  material_mismatch: REASON.MATERIAL_MISMATCH,
  printer_nozzle_unknown: REASON.NOZZLE_UNKNOWN,
  task_nozzle_unknown: REASON.NOZZLE_UNKNOWN,
  nozzle_mismatch: REASON.NOZZLE_MISMATCH,
  build_volume_conflict: REASON.BUILD_VOLUME_UNKNOWN,
  dimensions_unknown: REASON.DIMENSIONS_UNKNOWN,
  model_scale_unknown: REASON.MODEL_SCALE_UNKNOWN,
  build_volume_unknown: REASON.BUILD_VOLUME_UNKNOWN,
  too_large: REASON.BUILD_VOLUME_EXCEEDED,
  gcode_flavor_mismatch: REASON.GCODE_FLAVOR_MISMATCH,
  ams_unsupported: REASON.AMS_UNSUPPORTED,
  ams_unknown: REASON.AMS_UNKNOWN,
  manual_start_only: REASON.REMOTE_START_UNSUPPORTED,
  bed_awaiting_clearance: REASON.BED_NOT_CLEAR,
  bed_unknown: REASON.BED_STATE_UNKNOWN,
  printer_busy: REASON.PRINTER_BUSY,
  // The three that were missing. Each has its own non-overridable code now, so
  // the operator reads the actual cause and cannot tick past it.
  printer_fault: REASON.PRINTER_FAULT,
  printer_media_missing: REASON.PRINTER_MEDIA_MISSING,
  launch_unconfirmed: REASON.LAUNCH_UNCONFIRMED,
  ams_mapping_ambiguous: REASON.AMS_MAPPING_AMBIGUOUS,
  model_off_bed: REASON.MODEL_OFF_BED
};

/**
 * Preflight `review`s a dispatch must harden into blockers.
 *
 * `ALWAYS` holds the ones no operator presence can compensate for: an occupied
 * or unknown bed is a physical collision risk, and stale/absent telemetry means
 * we are deciding on facts that may no longer be true.
 *
 * `NIGHT_ONLY` holds the unknowns an attended operator legitimately resolves by
 * looking at the machine — an unread model size, an unknown bed size, an
 * unreported nozzle. Unattended, each of those is a fail-closed refusal; attended,
 * each stays a `warning`, so the start is `review` (never `eligible`) and needs an
 * explicit, audited override.
 */
const REVIEW_IS_BLOCKER_ALWAYS: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  REASON.BED_NOT_CLEAR,
  REASON.BED_STATE_UNKNOWN,
  REASON.TELEMETRY_STALE,
  REASON.TELEMETRY_MISSING,
  REASON.PRINTER_OFFLINE
]);

const REVIEW_IS_BLOCKER_AT_NIGHT: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  REASON.DIMENSIONS_UNKNOWN,
  REASON.MODEL_SCALE_UNKNOWN,
  REASON.BUILD_VOLUME_UNKNOWN,
  REASON.NOZZLE_UNKNOWN,
  REASON.MATERIAL_UNKNOWN,
  REASON.PROFILE_SET_NOT_APPROVED,
  REASON.AMS_UNKNOWN
]);

function reviewSeverity(code: ReasonCode, mode: DispatchMode): "warning" | "blocker" {
  if (REVIEW_IS_BLOCKER_ALWAYS.has(code)) return "blocker";
  if (mode === "night" && REVIEW_IS_BLOCKER_AT_NIGHT.has(code)) return "blocker";
  return "warning";
}

/**
 * The authoritative check. Runs preflight compatibility first (so its rules live
 * in exactly one place), lifts its verdict into the dispatch vocabulary, then
 * adds the dispatch-only rules.
 */
export function evaluateDispatchEligibility(
  input: DispatchEligibilityInput
): DispatchEligibility {
  const { facts } = input;
  const preflight = evaluateCompatibility(
    input.preflight.task,
    input.preflight.printer,
    input.preflight.evidence,
    input.preflight.config
  );

  const reasons: EligibilityReason[] = [...liftPreflight(preflight, facts)];
  const push = (r: EligibilityReason): void => void reasons.push(r);

  pushQueueShape(facts, push);
  pushFileIdentity(facts, push);
  pushDeviceState(facts, push);
  pushBed(facts, push);
  pushManualOperations(facts, push);
  pushReservation(facts, push);
  const nightWindowFit = facts.mode === "night" ? pushNight(facts, push) : null;

  return {
    status: statusOf(reasons),
    reasons: dedupe(reasons),
    preflight,
    nightWindowFit
  };
}

// ── Rule groups ───────────────────────────────────────────────────────────────

/**
 * Preflight verdicts, translated; `review` escalates to `blocker` for the codes
 * above.
 *
 * One fact is deliberately not lifted twice. The preflight `maintenance` blocker
 * and this layer's {@link REASON.MANUAL_OPERATION_REQUIRED} are the *same*
 * physical intervention seen at two altitudes: the planner needs it as "this
 * printer is held" so it stops placing jobs there, while the dispatch reports
 * each operation individually, by name and state, and equally non-overridably.
 * Showing both puts two lines in front of the operator for one half-removed
 * nozzle, so the less specific one stands down whenever the more specific one is
 * present. Nothing is weakened: the refusal below is the stricter of the two.
 */
function liftPreflight(preflight: CompatibilityResult, facts: DispatchFacts): EligibilityReason[] {
  const mode = facts.mode;
  const supersededByOperations = facts.blockingOperations.length > 0;
  const out: EligibilityReason[] = [];
  for (const b of preflight.blockers) {
    if (b.code === "maintenance" && supersededByOperations) continue;
    out.push(
      reason(mapPreflightCode(b.code), "blocker", b.message, {
        stage: "preflight",
        code: b.code,
        origin: "blocker"
      })
    );
  }
  for (const r of preflight.reviews) {
    const code = mapPreflightCode(r.code);
    // `origin` is what lets a consumer tell a preflight *review* — an open
    // question a human closes — from a preflight *warning*, once both have been
    // flattened into this layer's single `warning` severity. Without it the
    // launch screen cannot know which notes deserve a confirmation control and
    // which are just context.
    out.push(
      reason(code, reviewSeverity(code, mode), r.message, {
        stage: "preflight",
        code: r.code,
        origin: "review"
      })
    );
  }
  for (const w of preflight.warnings) {
    const code = mapPreflightCode(w.code);
    // `manual_start_only` and `REMOTE_START_UNSUPPORTED` are the same fact at two
    // altitudes: the planner wants a soft "a human will press the button", the
    // launch wants a refusal, because there is no button for it to press. Keeping
    // both put a *warning* about remote start next to a *blocker* about remote
    // start, and the launch screen showed the printer as "совместим".
    if (code === REASON.REMOTE_START_UNSUPPORTED) continue;
    // A G-code flavor the firmware does not speak is advisory when *planning*
    // but a refusal when actually sending the file to that firmware.
    const severity: "warning" | "blocker" =
      code === REASON.GCODE_FLAVOR_MISMATCH || (mode === "night" && code === REASON.PRINTER_BUSY)
        ? "blocker"
        : "warning";
    out.push(
      reason(code, severity, w.message, { stage: "preflight", code: w.code, origin: "warning" })
    );
  }
  return out;
}

/** The stage this evaluation runs at; absent means the strict, complete one. */
function stageOf(f: DispatchFacts): EligibilityStage {
  return f.stage ?? "dispatch";
}

function pushQueueShape(f: DispatchFacts, push: (r: EligibilityReason) => void): void {
  if (f.taskState !== "QUEUED") {
    push(
      reason(
        REASON.TASK_STATE,
        "blocker",
        `задание в состоянии «${f.taskState}» — запускать можно только из QUEUED`,
        { taskState: f.taskState }
      )
    );
  }
  if (f.entryState === null) {
    push(reason(REASON.NO_QUEUE_ENTRY, "blocker", "у задания нет записи в очереди"));
  } else if (f.entryState !== "WAITING") {
    push(
      reason(
        REASON.ENTRY_STATE,
        "blocker",
        `запись очереди в состоянии «${f.entryState}» — запуск только из WAITING`,
        { entryState: f.entryState }
      )
    );
  }
}

function pushFileIdentity(f: DispatchFacts, push: (r: EligibilityReason) => void): void {
  if (!f.file) {
    push(reason(REASON.NO_FILE, "blocker", "у задания не задан файл для запуска на принтере"));
  } else if (!f.filePathValid) {
    push(reason(REASON.BAD_FILE_PATH, "blocker", `файл «${f.file}» не проходит проверку пути`, { file: f.file }));
  }

  const a = f.analysis;
  if (a) {
    if (a.state === "failed") {
      push(reason(REASON.ANALYSIS_FAILED, "blocker", "анализ файла завершился ошибкой — перезапустите анализ"));
    } else if (a.state === "pending" || a.state === "running") {
      push(reason(REASON.ANALYSIS_IN_PROGRESS, "blocker", "анализ файла ещё не завершён"));
    } else {
      if (a.blockers.length > 0) {
        push(
          reason(
            REASON.ANALYSIS_BLOCKERS,
            "blocker",
            `анализ выявил критические проблемы: ${a.blockers.map((b) => b.message).join("; ")}`,
            { blockers: a.blockers }
          )
        );
      }
      if (a.verdict && a.verdict !== "schedulable") {
        // A `review` a named operator has read and accepted is not the same
        // fact as an unread one. Accepting it is the documented way an uploaded
        // sliced 3MF — startable, but produced against somebody else's machine
        // profile — becomes launchable, and it stays a `warning` so the reason
        // is still on screen, still in the audit trail, and still a refusal for
        // an unattended start (which has nobody to have accepted anything).
        const acknowledged =
          a.reviewAccepted === true &&
          ACKNOWLEDGEABLE_VERDICTS.has(a.verdict) &&
          f.mode !== "night";
        push(
          reason(
            REASON.ANALYSIS_VERDICT,
            acknowledged ? "warning" : "blocker",
            acknowledged
              ? `вердикт анализа «${a.verdict}» принят оператором${a.reviewAcceptedBy ? ` (${a.reviewAcceptedBy})` : ""}`
              : `вердикт анализа «${a.verdict}» не допускает запуск (нужен schedulable)`,
            {
              verdict: a.verdict,
              reviewAccepted: a.reviewAccepted === true,
              reviewAcceptedBy: a.reviewAcceptedBy ?? null,
              reviewAcceptedAt: a.reviewAcceptedAt ?? null
            }
          )
        );
      }
      if (a.detectedFormat === "unknown") {
        push(reason(REASON.FORMAT_UNKNOWN, "blocker", "формат файла не распознан по содержимому"));
      }
      pushFormatContradiction(f.file, a.detectedFormat, a.containsGcodePayload ?? null, push);
      pushStaleness(f, a, push);
      pushDeclaredTarget(f, a, push);
    }
  }

  // The two rules that need the bytes to have moved. Asking them before the
  // delivery would report "файл не найден на принтере" about a file nobody has
  // sent yet — a true statement that is not a refusal, and that would make every
  // preview of every un-delivered job look blocked.
  if (stageOf(f) === "dispatch") {
    pushDeviceFile(f, push);
    pushDeviceDelivery(f, push);
  }

  if (f.mode === "night") {
    if (!f.artifact) {
      push(reason(REASON.ARTIFACT_MISSING, "blocker", "у задания нет зарегистрированного артефакта"));
    } else if (!f.artifact.sha256) {
      push(
        reason(
          REASON.ARTIFACT_HASH_MISSING,
          "blocker",
          "артефакт не имеет контрольной суммы — идентичность файла нельзя доказать"
        )
      );
    }
    if (!f.analysis || f.analysis.state !== "ready") {
      push(reason(REASON.ANALYSIS_MISSING, "blocker", "нет завершённого анализа файла"));
    } else if (f.analysis.detectedFormat !== "gcode") {
      push(
        reason(
          REASON.FORMAT_UNKNOWN,
          "blocker",
          `ночной запуск требует подтверждённый G-code (обнаружено: ${f.analysis.detectedFormat ?? "—"})`,
          { detectedFormat: f.analysis.detectedFormat }
        )
      );
    }
  }
}

const GCODE_EXT_RE = /\.(gcode|gco|g)$/i;
const MODEL_EXT_RE = /\.(stl|3mf)$/i;
/**
 * A **G-code container**: a 3MF whose payload is a sliced plate, not geometry.
 *
 * This is what a Bambu printer is handed (`<name>.gcode.3mf`, started via
 * `print.project_file`). Its content genuinely *is* G-code, so the "extension
 * promises a model, content is G-code" rule below must not fire on it — the
 * double extension is precisely the slicer's way of saying "3MF wrapper, G-code
 * inside". A bare `.3mf` keeps the old, correct meaning.
 */
const GCODE_CONTAINER_RE = /\.gcode\.3mf$/i;

function pushFormatContradiction(
  file: string | null,
  detectedFormat: string | null,
  containsGcodePayload: boolean | null | undefined,
  push: (r: EligibilityReason) => void
): void {
  if (!file || !detectedFormat) return;
  if (GCODE_CONTAINER_RE.test(file)) {
    // The wrapper must contain what it claims. Two analyses legitimately answer
    // that, and they are two different files:
    //
    //  - `gcode`, when the container is built *here* at the transport boundary
    //    around one of our slices — the analysed artifact is the bare G-code;
    //  - `3mf` **carrying a sliced plate payload**, when the operator uploaded a
    //    finished `.gcode.3mf` and the analyzer opened the archive and found one.
    //
    // The second used to be refused outright, which made every uploaded sliced
    // 3MF fail with "имя обещает G-code, а содержимое — 3mf" about a file that is
    // exactly what its name says. Accepting the format alone would go too far the
    // other way: a plain model renamed to `.gcode.3mf` also analyses as `3mf`, and
    // that one is a genuine contradiction. So the payload decides, and an
    // unanswered payload question refuses.
    const container =
      detectedFormat === "gcode" || (detectedFormat === "3mf" && containsGcodePayload === true);
    if (!container) {
      push(
        reason(
          REASON.FORMAT_MISMATCH,
          "blocker",
          detectedFormat === "3mf"
            ? "имя обещает нарезанный 3MF-пакет, а внутри архива нет G-code"
            : `имя обещает G-code внутри 3MF-пакета, а содержимое — «${detectedFormat}»`,
          { file, detectedFormat, containsGcodePayload: containsGcodePayload ?? null }
        )
      );
    }
    return;
  }
  if (GCODE_EXT_RE.test(file) && detectedFormat !== "gcode") {
    push(
      reason(
        REASON.FORMAT_MISMATCH,
        "blocker",
        `расширение обещает G-code, содержимое — «${detectedFormat}»`,
        { file, detectedFormat }
      )
    );
  } else if (MODEL_EXT_RE.test(file) && detectedFormat === "gcode") {
    push(
      reason(REASON.FORMAT_MISMATCH, "blocker", "расширение обещает модель (STL/3MF), содержимое — G-code", {
        file
      })
    );
  }
}

function pushStaleness(
  f: DispatchFacts,
  a: NonNullable<DispatchFacts["analysis"]>,
  push: (r: EligibilityReason) => void
): void {
  if (!f.artifact?.sha256) return;
  if (a.updatedAt < f.artifact.updatedAt) {
    push(reason(REASON.ANALYSIS_STALE, "blocker", "файл изменился после последнего анализа"));
  }
  if (a.analyzerVersion && a.analyzerVersion !== f.currentAnalyzerVersion) {
    push(
      reason(
        REASON.ANALYZER_OUTDATED,
        "blocker",
        `анализ выполнен версией ${a.analyzerVersion}, текущая ${f.currentAnalyzerVersion} — перезапустите анализ`,
        { analyzerVersion: a.analyzerVersion, current: f.currentAnalyzerVersion }
      )
    );
  }
}

/**
 * The target printer and flavor the *file itself* declares. A sliced file carries
 * `;printer_model=` / `;FLAVOR=`; sending a file sliced for another machine is a
 * hard refusal, never a warning, because the firmware will happily execute
 * geometry and temperatures meant for different hardware.
 */
function pushDeclaredTarget(
  f: DispatchFacts,
  a: NonNullable<DispatchFacts["analysis"]>,
  push: (r: EligibilityReason) => void
): void {
  const declared = a.declaredTargetPrinter?.trim();
  if (declared) {
    // Model first, class second — the two identities a file may legitimately
    // declare. The comparison is the farm's ONE model rule
    // (`printerModelsMatchStrict`), which normalises vendor spelling and kit
    // suffixes ("Bambu Lab A1 Combo" IS an A1) while keeping every other token
    // significant, so `A1` ≠ `A1 mini` and `K2` ≠ `K2 Plus`.
    const identities = [f.printerModel, f.printerClass].filter(
      (v): v is string => typeof v === "string" && normalizePrinterModel(v).length > 0
    );
    const shownAs = f.printerModel?.trim() || f.printerName?.trim() || "—";
    if (identities.length === 0) {
      push(
        reason(
          REASON.TARGET_PRINTER_UNKNOWN,
          "blocker",
          `файл собран для «${declared}», но модель принтера не указана — сверить не с чем`,
          { declared, printerName: f.printerName }
        )
      );
    } else if (!identities.some((identity) => printerModelsMatchStrict(declared, identity))) {
      push(
        reason(
          REASON.TARGET_PRINTER_MISMATCH,
          "blocker",
          `файл собран для «${declared}», а запускается на «${shownAs}»`,
          { declared, model: f.printerModel, printerClass: f.printerClass }
        )
      );
    }
  } else if (f.mode === "night" && a.detectedFormat === "gcode") {
    push(
      reason(
        REASON.TARGET_PRINTER_UNKNOWN,
        "blocker",
        "целевой принтер не указан в файле — ночной запуск запрещён"
      )
    );
  }

  const flavor = a.declaredGcodeFlavor?.trim();
  if (flavor && f.printerProtocol && !gcodeFlavorFitsProtocol(flavor, f.printerProtocol)) {
    push(
      reason(
        REASON.GCODE_FLAVOR_MISMATCH,
        "blocker",
        `G-code flavor «${flavor}» несовместим с прошивкой «${f.printerProtocol}»`,
        { flavor, protocol: f.printerProtocol }
      )
    );
  }
}

/** Model labels compared loosely: case/space-insensitive containment either way. */
function pushDeviceFile(f: DispatchFacts, push: (r: EligibilityReason) => void): void {
  switch (f.deviceFileIdentity) {
    case "missing":
      push(
        reason(REASON.DEVICE_FILE_MISSING, "blocker", `файл «${f.file ?? "—"}» не найден на принтере`, {
          file: f.file
        })
      );
      break;
    case "unchecked":
      // Preview stage: honest unknown. A *dispatch* always resolves this first,
      // so an `unchecked` reaching the reserve transaction is itself a refusal.
      push(
        reason(
          REASON.DEVICE_FILE_NOT_VERIFIED,
          "blocker",
          "наличие файла на принтере ещё не проверено"
        )
      );
      break;
    case "unsupported":
      if (f.mode === "night") {
        push(
          reason(
            REASON.DEVICE_FILE_NOT_VERIFIED,
            "blocker",
            "протокол принтера не позволяет проверить файл на устройстве — ночной запуск запрещён"
          )
        );
      } else {
        push(
          reason(
            REASON.DEVICE_FILE_NOT_VERIFIED,
            "warning",
            "протокол принтера не позволяет проверить файл на устройстве"
          )
        );
      }
      break;
    case "name-only":
      if (f.mode === "night" && f.artifact) {
        push(
          reason(
            REASON.DEVICE_FILE_NOT_VERIFIED,
            "blocker",
            "идентичность файла на принтере подтверждена только именем — ночной запуск запрещён"
          )
        );
      } else {
        push(
          reason(
            REASON.DEVICE_FILE_NOT_VERIFIED,
            "warning",
            "идентичность файла на принтере подтверждена только именем"
          )
        );
      }
      break;
    default:
      break;
  }
}

/**
 * How the bytes reached the device — the half of file identity the listing check
 * cannot answer.
 *
 * The listing pre-flight can say "a file with this name and size is there". It
 * cannot say who put it there, which slice it came from, or whether it is still
 * the file this job means. Only the tracked `DeviceArtifact` can, so **every**
 * start requires one in `VERIFIED`:
 *
 *  - no record at all → nothing in this system delivered or checked that file.
 *    An operator who copied it by hand says so explicitly (`confirmManualTransfer`),
 *    which is auditable; a path string that merely happens to resolve is not.
 *  - `UPLOADING` / `NOT_PRESENT` → the delivery has not finished.
 *  - `PRESENT_UNVERIFIED` → something is there, but it has not been matched
 *    against the artifact. "Probably fine" is not evidence.
 *  - `FAILED` / `INVALID` → the delivery failed, or what is there is not it.
 *  - `STALE` → it was valid, for a job we would no longer print.
 *
 * For an adapter with no upload API (Bambu, Creality WS) the orchestrator did not
 * put the file there and cannot list it either, so the named operator confirmation
 * *is* the verification — and unattended mode has no confirmation path at all, so
 * a manual-transfer printer can never be auto-started. Every refusal here is
 * non-overridable.
 */
function pushDeviceDelivery(f: DispatchFacts, push: (r: EligibilityReason) => void): void {
  const tracked = f.deviceArtifact;

  if (!tracked) {
    push(
      reason(
        REASON.DEVICE_TRANSFER_NOT_CONFIRMED,
        "blocker",
        f.adapterUploadSupported
          ? "файл не подготовлен на принтере — выполните подготовку файла перед запуском"
          : "адаптер принтера не умеет загружать файлы — оператор должен перенести файл вручную и подтвердить это",
        { remotePath: f.file, adapterUploadSupported: f.adapterUploadSupported }
      )
    );
    return;
  }

  if (tracked.stale || tracked.state === "STALE") {
    push(
      reason(
        REASON.DEVICE_FILE_STALE,
        "blocker",
        `подготовленный файл устарел${tracked.staleReason ? `: ${tracked.staleReason}` : ""} — подготовьте файл заново`,
        tracked
      )
    );
    return;
  }

  switch (tracked.state) {
    case "VERIFIED":
      break;
    case "INVALID":
    case "FAILED":
      push(
        reason(
          REASON.DEVICE_FILE_INVALID,
          "blocker",
          `подготовка файла на принтере завершилась ошибкой${tracked.lastError ? `: ${tracked.lastError}` : ""} — повторите загрузку`,
          tracked
        )
      );
      return;
    case "UPLOADING":
    case "NOT_PRESENT":
      push(
        reason(
          REASON.DEVICE_TRANSFER_NOT_CONFIRMED,
          "blocker",
          `файл на принтере в состоянии «${tracked.state}» — дождитесь завершения подготовки`,
          tracked
        )
      );
      return;
    default:
      // PRESENT_UNVERIFIED and anything a future migration adds: unverified is
      // a refusal, never a pass.
      push(
        reason(
          REASON.DEVICE_FILE_NOT_VERIFIED,
          "blocker",
          `файл на принтере не проверен (${tracked.state})${tracked.lastError ? `: ${tracked.lastError}` : ""} — повторите подготовку`,
          tracked
        )
      );
      return;
  }

  if (tracked.transferMode === "manual_file_transfer" && f.mode === "night") {
    push(
      reason(
        REASON.DEVICE_TRANSFER_NOT_CONFIRMED,
        "blocker",
        "файл перенесён вручную — автоматический (ночной) запуск для такого принтера запрещён"
      )
    );
  }
}

function pushDeviceState(f: DispatchFacts, push: (r: EligibilityReason) => void): void {
  if (!f.remoteStartSupported) {
    push(reason(REASON.REMOTE_START_UNSUPPORTED, "blocker", "удалённый запуск для этого принтера не поддерживается"));
  }
  const s = f.liveStatus;
  if (!s || !s.online) {
    push(reason(REASON.PRINTER_OFFLINE, "blocker", "принтер не в сети"));
  } else if (s.status === "printing" || s.status === "paused") {
    push(reason(REASON.PRINTER_BUSY, "blocker", "принтер уже занят печатью", { status: s.status }));
  } else if (s.status !== "idle") {
    push(
      reason(REASON.PRINTER_NOT_IDLE, "blocker", `состояние принтера не подтверждено (${s.status})`, {
        status: s.status
      })
    );
  }

  if (f.activeRun) {
    push(
      reason(
        REASON.ACTIVE_RUN_EXISTS,
        "blocker",
        `на принтере уже есть активная печать (${f.activeRun.id}, ${f.activeRun.state})`,
        f.activeRun
      )
    );
  }
  if (f.startGuard) {
    push(
      reason(
        REASON.UNRESOLVED_DISPATCH,
        "blocker",
        `есть неподтверждённый запуск «${f.startGuard.file}» — снимите блокировку после проверки принтера`,
        f.startGuard
      )
    );
  }
}

/**
 * Bed clearance — the rule the whole night-safety half of the brief turns on.
 *
 * `AWAITING_CLEARANCE` means a finished part is (as far as the system knows)
 * still on the plate. Only an explicit clearance event moves it to `CLEAR`:
 * operator removal, plate swap, or a *verified* automatic mechanism. Neither
 * `manual` mode nor `unattendedAllowed` may substitute for one — that
 * substitution is precisely what let the old dispatch crash into a full bed.
 */
function pushBed(f: DispatchFacts, push: (r: EligibilityReason) => void): void {
  const state = f.bedState;
  if (state === null || state === "UNKNOWN") {
    push(
      reason(
        REASON.BED_STATE_UNKNOWN,
        "blocker",
        "состояние стола неизвестно — подтвердите, что стол свободен",
        { bedState: state }
      )
    );
    return;
  }
  if (state === "CLEAR") return;

  if (state === "AWAITING_CLEARANCE") {
    push(
      reason(
        REASON.BED_NOT_CLEAR,
        "blocker",
        "на столе осталась готовая модель — снимите её и подтвердите очистку стола",
        { bedState: state }
      )
    );
    push(
      reason(
        REASON.OPERATOR_INTERVENTION_REQUIRED,
        "blocker",
        "требуется вмешательство оператора: снять модель или заменить пластину"
      )
    );
    if (f.mode === "night" && !f.automaticContinuationAllowed) {
      push(
        reason(
          REASON.AUTOMATIC_CONTINUATION_NOT_SUPPORTED,
          "blocker",
          "у принтера нет подтверждённой автоматической очистки стола — автопродолжение очереди запрещено"
        )
      );
    }
    return;
  }

  // RESERVED / RUNNING — someone else holds the plate.
  push(
    reason(REASON.BED_NOT_CLEAR, "blocker", `стол не свободен (${state})`, { bedState: state })
  );
}

/**
 * Outstanding physical interventions — the human half of "is this printer free?".
 *
 * Two separate facts, deliberately not merged:
 *
 *  1. **A blocking operation holds the machine.** Part removal, a plate swap, a
 *     nozzle change: until one of these is *confirmed done by a named person*,
 *     the printer cannot run the next job, whoever asks and however they ask.
 *     The refusal is non-overridable and applies in `manual` mode exactly as in
 *     `night` mode — "ручной запуск не обходит обязательную операцию".
 *  2. **Whether an operator can even do it** is a different question, and only
 *     matters for automation. An asleep operator does not make a *manual* start
 *     illegal — the person pressing the button is evidently awake. It makes an
 *     *unattended* continuation impossible, because the intervention it depends
 *     on cannot happen. Hence: presence is a blocker at night, context at day.
 *
 * The fail-closed edge is the third case: when the schedule cannot be resolved
 * at all (no timezone, no rules, no operator) *and* an intervention is pending,
 * the automatic continuation is refused outright. An unknown schedule is not an
 * available operator, and "the queue will carry on once somebody, at some point,
 * clears that plate" is not a plan.
 *
 * Note the scoping: operator facts only ever escalate to a blocker when an
 * intervention is actually outstanding. A night start onto an already-clear bed
 * needs no human, so a sleeping operator is context for it, not a refusal — the
 * night window, `unattendedAllowed` and the bed rules already govern that case.
 */
function pushManualOperations(f: DispatchFacts, push: (r: EligibilityReason) => void): void {
  for (const op of f.blockingOperations) {
    push(
      reason(
        REASON.MANUAL_OPERATION_REQUIRED,
        "blocker",
        `требуется ручная операция: ${op.label} (${op.state}) — подтвердите выполнение перед запуском`,
        op
      )
    );
  }

  // "Continuing automatically" is what the operator's presence gates. Nothing to
  // continue past ⇒ nothing for a schedule to decide.
  const needsOperator = f.blockingOperations.length > 0;
  const automatic = f.mode === "night";

  if (!f.operatorScheduleResolved) {
    push(
      reason(
        REASON.OPERATOR_SCHEDULE_UNKNOWN,
        automatic && needsOperator ? "blocker" : "warning",
        `расписание оператора не разобрано (${f.operatorReason}) — автоматическое продолжение очереди запрещено`,
        { presence: f.operatorPresence, pendingOperations: f.blockingOperations.length }
      )
    );
    return;
  }

  if (f.operatorPresence !== "AVAILABLE") {
    push(
      reason(
        REASON.OPERATOR_UNAVAILABLE,
        // An operator standing at the machine at 23:00 may start a print by hand
        // even though the schedule says they should be asleep; an *unattended*
        // continuation that depends on them cannot.
        automatic && needsOperator ? "blocker" : "warning",
        needsOperator
          ? `${f.operatorReason} — обязательные операции не могут быть выполнены сейчас`
          : f.operatorReason,
        { presence: f.operatorPresence, pendingOperations: f.blockingOperations.length }
      )
    );
  }
}

/**
 * A confirmed plan is executable data, not a suggestion. When a reservation
 * exists, the dispatch must run *that* assignment: same printer, same slice,
 * same artifact. A divergence is never silently accepted — it blocks so the
 * caller can replan or ask an operator.
 */
function pushReservation(f: DispatchFacts, push: (r: EligibilityReason) => void): void {
  const r = f.reservation;
  if (!r) return;

  if (r.stale) {
    push(
      reason(
        REASON.ASSIGNMENT_STALE,
        "blocker",
        `назначение помечено устаревшим${r.staleReason ? `: ${r.staleReason}` : ""} — требуется перепланирование`,
        { assignmentId: r.assignmentId, planId: r.planId, staleReason: r.staleReason }
      )
    );
  }

  // The profile revisions the confirmed slice was produced with must still be the
  // ones the task resolves to now. A re-import that quarantines a profile and
  // re-points a set would otherwise print with settings nobody confirmed.
  if (r.profileRevisionIds.length > 0) {
    const current = new Set(f.currentProfileRevisionIds);
    const drifted = r.profileRevisionIds.filter((id) => !current.has(id));
    if (drifted.length > 0) {
      push(
        reason(
          REASON.PROFILE_REVISION_MISMATCH,
          "blocker",
          "профили задания отличаются от подтверждённых в плане",
          { confirmed: r.profileRevisionIds, actual: f.currentProfileRevisionIds, drifted }
        )
      );
    }
  }

  if (r.printerId !== f.targetPrinterId) {
    push(
      reason(
        REASON.ASSIGNMENT_PRINTER_MISMATCH,
        "blocker",
        `подтверждённый план назначает принтер «${r.printerId}», а запуск идёт на «${f.targetPrinterId}»`,
        { assigned: r.printerId, actual: f.targetPrinterId, assignmentId: r.assignmentId }
      )
    );
  }
  if (r.sliceVariantId !== null && r.sliceVariantId !== f.sliceVariantId) {
    push(
      reason(
        REASON.SLICE_VARIANT_MISMATCH,
        "blocker",
        "слайс отличается от подтверждённого в плане",
        { confirmed: r.sliceVariantId, actual: f.sliceVariantId }
      )
    );
  }
  if (r.artifactSha256 !== null && f.artifact && f.artifact.sha256 !== r.artifactSha256) {
    push(
      reason(
        REASON.ARTIFACT_HASH_MISMATCH,
        "blocker",
        "содержимое файла отличается от подтверждённого в плане",
        { confirmed: r.artifactSha256, actual: f.artifact.sha256 }
      )
    );
  }
  if (
    r.expectedRemotePath !== null &&
    f.file !== null &&
    basename(r.expectedRemotePath) !== basename(f.file)
  ) {
    push(
      reason(
        REASON.DEVICE_FILE_NOT_VERIFIED,
        "blocker",
        `план ожидает файл «${r.expectedRemotePath}», запускается «${f.file}»`,
        { expected: r.expectedRemotePath, actual: f.file }
      )
    );
  }
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** Night-only rules: explicit permission, a known ETA, and a fit into the time LEFT. */
function pushNight(f: DispatchFacts, push: (r: EligibilityReason) => void): NightWindowFit | null {
  if (!f.night) {
    push(
      reason(
        REASON.NOT_NIGHT_FLAGGED,
        "blocker",
        "задание не отмечено для ночного запуска — выберите «ночью» в параметрах планирования"
      )
    );
  }
  if (!f.unattendedAllowed) {
    push(
      reason(
        REASON.UNATTENDED_NOT_ALLOWED,
        "blocker",
        "для задания не дано явное разрешение unattended-печати (unattendedAllowed)"
      )
    );
  }

  if (f.etaMinutes === null) {
    // Fail-closed: an assumed ETA may decorate a preview, never authorise a start.
    push(
      reason(REASON.UNKNOWN_ETA, "blocker", "длительность печати неизвестна — нельзя проверить ночное окно")
    );
    return null;
  }

  const fit = evaluateNightWindowFit({
    window: f.nightWindow,
    now: f.now,
    timeZone: f.farmTimeZone,
    etaMinutes: f.etaMinutes,
    safetyBufferRatio: f.nightSafetyBufferRatio
  });
  if (!fit) {
    push(
      reason(
        REASON.NIGHT_WINDOW_UNKNOWN,
        "blocker",
        `ночное окно «${f.nightWindow}» или таймзона «${f.farmTimeZone}» не разобраны — ночной запуск запрещён`,
        { window: f.nightWindow, timeZone: f.farmTimeZone }
      )
    );
    return null;
  }
  if (!fit.fits) {
    push(
      reason(
        REASON.NIGHT_WINDOW_TOO_SHORT,
        "blocker",
        fit.insideWindow
          ? `печать ${fit.bufferedEtaMinutes} мин (с запасом) не помещается в оставшиеся ${fit.remainingMinutes} мин ночного окна`
          : `сейчас вне ночного окна «${f.nightWindow}»`,
        fit
      )
    );
  }

  // Even a print that fits leaves a part on the plate at the end. Without a
  // verified automatic mechanism that is a planned morning intervention — the
  // plan must say so rather than imply the printer frees itself.
  if (!f.automaticContinuationAllowed) {
    push(
      reason(
        REASON.OPERATOR_INTERVENTION_REQUIRED,
        "warning",
        "после завершения стол останется занят до прихода оператора — следующее задание не начнётся автоматически"
      )
    );
  }
  return fit;
}

/** Collapses repeats of the same (code, message) pair, keeping the strongest severity. */
function dedupe(reasons: readonly EligibilityReason[]): EligibilityReason[] {
  const byKey = new Map<string, EligibilityReason>();
  for (const r of reasons) {
    const key = `${r.code}::${r.message}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, r);
    } else if (existing.severity === "warning" && r.severity === "blocker") {
      byKey.set(key, r);
    }
  }
  return [...byKey.values()];
}

/**
 * A preflight code in the dispatch vocabulary.
 *
 * The map is exhaustive by type, so the fallback is unreachable through the
 * normal path; it exists for a value that reached here from outside the type
 * system (a persisted row, a hand-built test input) and is deliberately *not*
 * a plausible-looking code. `PREFLIGHT_REASON_UNMAPPED` is non-overridable:
 * a refusal nobody has taught this layer to read is an unknown critical.
 */
export function mapPreflightCode(code: string): ReasonCode {
  return PREFLIGHT_CODE_MAP[code as PreflightReasonCode] ?? REASON.PREFLIGHT_REASON_UNMAPPED;
}

export type { CompatibilityResult };
