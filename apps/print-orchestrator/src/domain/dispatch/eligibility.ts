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
import {
  evaluateCompatibility,
  type CompatibilityConfig,
  type CompatibilityEvidence,
  type CompatibilityPrinterInput,
  type CompatibilityResult,
  type CompatibilityTaskInput
} from "../scheduling/compatibility";
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
}

export interface DispatchFacts {
  mode: DispatchMode;

  // ── Task / queue shape ────────────────────────────────────────────────────
  taskState: string;
  entryState: string | null;
  night: boolean;
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
  } | null;
  currentAnalyzerVersion: string;
  deviceFileIdentity: DeviceFileIdentity;

  // ── Printer here-and-now ──────────────────────────────────────────────────
  /**
   * Names a sliced file may legitimately declare as its target for this printer:
   * its model, its name and its interchangeability class. A file declaring
   * anything outside this set is refused (§2.1 "target printer or printer class
   * inside G-code/3MF").
   */
  printerLabels: string[];
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

  // ── Plan binding ──────────────────────────────────────────────────────────
  reservation: DispatchReservation | null;
  /** The printer this dispatch is actually about to start on. */
  targetPrinterId: string;
  /** The slice variant this dispatch would send, when the work is sliced. */
  sliceVariantId: string | null;

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
 * the SCREAMING_SNAKE vocabulary the UI/audit/tests key off. Anything unmapped
 * keeps its meaning but is reported under a conservative generic code.
 */
const PREFLIGHT_CODE_MAP: Record<string, ReasonCode> = {
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
  printer_busy: REASON.PRINTER_BUSY
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

  const reasons: EligibilityReason[] = [...liftPreflight(preflight, facts.mode)];
  const push = (r: EligibilityReason): void => void reasons.push(r);

  pushQueueShape(facts, push);
  pushFileIdentity(facts, push);
  pushDeviceState(facts, push);
  pushBed(facts, push);
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

/** Preflight verdicts, translated; `review` escalates to `blocker` for the codes above. */
function liftPreflight(preflight: CompatibilityResult, mode: DispatchMode): EligibilityReason[] {
  const out: EligibilityReason[] = [];
  for (const b of preflight.blockers) {
    out.push(reason(mapCode(b.code), "blocker", b.message, { stage: "preflight", code: b.code }));
  }
  for (const r of preflight.reviews) {
    const code = mapCode(r.code);
    out.push(reason(code, reviewSeverity(code, mode), r.message, { stage: "preflight", code: r.code }));
  }
  for (const w of preflight.warnings) {
    const code = mapCode(w.code);
    // A G-code flavor the firmware does not speak is advisory when *planning*
    // but a refusal when actually sending the file to that firmware.
    const severity: "warning" | "blocker" =
      code === REASON.GCODE_FLAVOR_MISMATCH || (mode === "night" && code === REASON.PRINTER_BUSY)
        ? "blocker"
        : "warning";
    out.push(reason(code, severity, w.message, { stage: "preflight", code: w.code }));
  }
  return out;
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
        push(
          reason(
            REASON.ANALYSIS_VERDICT,
            "blocker",
            `вердикт анализа «${a.verdict}» не допускает запуск (нужен schedulable)`,
            { verdict: a.verdict }
          )
        );
      }
      if (a.detectedFormat === "unknown") {
        push(reason(REASON.FORMAT_UNKNOWN, "blocker", "формат файла не распознан по содержимому"));
      }
      pushFormatContradiction(f.file, a.detectedFormat, push);
      pushStaleness(f, a, push);
      pushDeclaredTarget(f, a, push);
    }
  }

  pushDeviceFile(f, push);

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

function pushFormatContradiction(
  file: string | null,
  detectedFormat: string | null,
  push: (r: EligibilityReason) => void
): void {
  if (!file || !detectedFormat) return;
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
  const labels = f.printerLabels.filter((l) => l.trim().length > 0);
  if (declared) {
    if (labels.length === 0) {
      push(
        reason(
          REASON.TARGET_PRINTER_UNKNOWN,
          "blocker",
          `файл собран для «${declared}», но модель принтера неизвестна — сверить не с чем`,
          { declared }
        )
      );
    } else if (!labels.some((label) => modelsMatch(declared, label))) {
      push(
        reason(
          REASON.TARGET_PRINTER_MISMATCH,
          "blocker",
          `файл собран для «${declared}», а запускается на «${labels[0]}»`,
          { declared, labels }
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
function modelsMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/[\s_-]+/g, "");
  const nb = b.toLowerCase().replace(/[\s_-]+/g, "");
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

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
 * A confirmed plan is executable data, not a suggestion. When a reservation
 * exists, the dispatch must run *that* assignment: same printer, same slice,
 * same artifact. A divergence is never silently accepted — it blocks so the
 * caller can replan or ask an operator.
 */
function pushReservation(f: DispatchFacts, push: (r: EligibilityReason) => void): void {
  const r = f.reservation;
  if (!r) return;

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
      reason(REASON.NOT_NIGHT_FLAGGED, "blocker", "задание не отмечено для печати без присмотра — подтвердите явно")
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

function mapCode(code: string): ReasonCode {
  return PREFLIGHT_CODE_MAP[code] ?? REASON.MAINTENANCE_BLOCKED;
}

export type { CompatibilityResult };
