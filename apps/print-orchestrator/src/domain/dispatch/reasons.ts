/**
 * Stable reason codes for {@link file://./eligibility.ts DispatchEligibility}.
 *
 * The codes are a *contract*: the UI keys off them, the audit trail stores them,
 * the tests assert on them and a future automatic replanner will branch on them.
 * Messages are human text and may change freely; a code never may. New codes are
 * appended — an existing one is never repurposed.
 */

export const REASON = {
  // ── Bed / clearance ───────────────────────────────────────────────────────
  BED_NOT_CLEAR: "BED_NOT_CLEAR",
  BED_STATE_UNKNOWN: "BED_STATE_UNKNOWN",
  OPERATOR_INTERVENTION_REQUIRED: "OPERATOR_INTERVENTION_REQUIRED",
  AUTOMATIC_CONTINUATION_NOT_SUPPORTED: "AUTOMATIC_CONTINUATION_NOT_SUPPORTED",
  /**
   * The automatic queue was offered a job the operator asked to print by day
   * while no operator is on shift. Only `auto` mode raises it — a person
   * pressing «Запустить» is evidently there.
   */
  AUTO_DAY_ONLY: "AUTO_DAY_ONLY",

  // ── Operator schedule / manual operations ─────────────────────────────────
  /**
   * A typed physical intervention (part removal, nozzle change, …) is still
   * open on this printer. The machine is held until it is confirmed done — this
   * is the "планировщик считает принтер занятым до завершения обязательной
   * операции" rule, and it is never overridable: a full plate is not a policy.
   */
  MANUAL_OPERATION_REQUIRED: "MANUAL_OPERATION_REQUIRED",
  /** Nobody is available (asleep/away/off) to perform the required intervention. */
  OPERATOR_UNAVAILABLE: "OPERATOR_UNAVAILABLE",
  /**
   * The operator schedule, its timezone, or an operation's duration could not be
   * resolved. Fail-closed: automatic continuation is blocked rather than guessed.
   */
  OPERATOR_SCHEDULE_UNKNOWN: "OPERATOR_SCHEDULE_UNKNOWN",

  // ── Device state ──────────────────────────────────────────────────────────
  PRINTER_OFFLINE: "PRINTER_OFFLINE",
  PRINTER_BUSY: "PRINTER_BUSY",
  PRINTER_NOT_IDLE: "PRINTER_NOT_IDLE",
  PRINTER_ERROR: "PRINTER_ERROR",
  /**
   * The device is displaying a fault its adapter has *decoded* and knows
   * prevents a start (`blocksStart`) — the printer's own screen, not our
   * inference from a symptom.
   */
  PRINTER_FAULT: "PRINTER_FAULT",
  /** The printer cannot read the storage the print file is started from. */
  PRINTER_MEDIA_MISSING: "PRINTER_MEDIA_MISSING",
  /**
   * A previous start command left without a verdict and nobody has said what
   * happened. The printer may be printing right now: this is the guard against a
   * second dispatch of the same model, and it is resolved by the operator
   * reporting what they see, never by waving it through.
   */
  LAUNCH_UNCONFIRMED: "LAUNCH_UNCONFIRMED",
  /**
   * A preflight reason arrived that this layer has no translation for.
   *
   * Only reachable if a code escapes the compile-time exhaustive
   * `PREFLIGHT_CODE_MAP`. It is non-overridable on purpose: an unrecognised
   * refusal is an unknown critical, and the fail-closed rule applies to reasons
   * we do not understand exactly as it does to facts we cannot read.
   */
  PREFLIGHT_REASON_UNMAPPED: "PREFLIGHT_REASON_UNMAPPED",
  TELEMETRY_STALE: "TELEMETRY_STALE",
  TELEMETRY_MISSING: "TELEMETRY_MISSING",
  REMOTE_START_UNSUPPORTED: "REMOTE_START_UNSUPPORTED",
  /**
   * The printer's adapter is monitoring-only: it reads telemetry and takes no
   * job — not by upload, not by remote start, not by manual transfer. A fact
   * about the integration, not a judgement call, so it is never overridable.
   */
  PRINTER_MONITORING_ONLY: "PRINTER_MONITORING_ONLY",
  ACTIVE_RUN_EXISTS: "ACTIVE_RUN_EXISTS",
  UNRESOLVED_DISPATCH: "UNRESOLVED_DISPATCH",
  MAINTENANCE_BLOCKED: "MAINTENANCE_BLOCKED",

  // ── Geometry / hardware fit ───────────────────────────────────────────────
  BUILD_VOLUME_EXCEEDED: "BUILD_VOLUME_EXCEEDED",
  /**
   * The printed body sits outside the bed at the coordinates the FILE places it
   * at — a different fact from "too large". A part that fits by size can still
   * be off the plate if it was sliced for a bigger machine.
   */
  MODEL_OFF_BED: "MODEL_OFF_BED",
  BUILD_VOLUME_UNKNOWN: "BUILD_VOLUME_UNKNOWN",
  DIMENSIONS_UNKNOWN: "DIMENSIONS_UNKNOWN",
  MODEL_SCALE_UNKNOWN: "MODEL_SCALE_UNKNOWN",
  NOZZLE_MISMATCH: "NOZZLE_MISMATCH",
  NOZZLE_UNKNOWN: "NOZZLE_UNKNOWN",
  MATERIAL_MISMATCH: "MATERIAL_MISMATCH",
  MATERIAL_UNKNOWN: "MATERIAL_UNKNOWN",
  AMS_UNSUPPORTED: "AMS_UNSUPPORTED",
  AMS_UNKNOWN: "AMS_UNKNOWN",
  /**
   * The job uses more than one tool and nothing has decided which filament feeds
   * which. Overridable — an operator may knowingly accept that the whole model
   * prints from one tray — but never automatically.
   */
  AMS_MAPPING_AMBIGUOUS: "AMS_MAPPING_AMBIGUOUS",
  /** No AMS tray holds the material this job was sliced and checked for. */
  AMS_MATERIAL_MISMATCH: "AMS_MATERIAL_MISMATCH",
  /** Several trays hold it and nothing tells them apart — an operator picks the tray. */
  AMS_SLOT_AMBIGUOUS: "AMS_SLOT_AMBIGUOUS",
  /** The job's material is unknown, so no tray can be matched to it. */
  AMS_MATERIAL_UNKNOWN: "AMS_MATERIAL_UNKNOWN",
  /** No usable AMS report: the trays cannot be checked. */
  AMS_STATE_UNKNOWN: "AMS_STATE_UNKNOWN",
  /** A feeding combination this farm does not start (mixed sources, multi-tool package, unknown unit). */
  AMS_FEED_UNSUPPORTED: "AMS_FEED_UNSUPPORTED",
  /** The slice to be sent was cut at a different scale than the source's confirmed unit. */
  SLICE_SCALE_MISMATCH: "SLICE_SCALE_MISMATCH",

  // ── File / artifact identity ──────────────────────────────────────────────
  TARGET_PRINTER_MISMATCH: "TARGET_PRINTER_MISMATCH",
  TARGET_PRINTER_UNKNOWN: "TARGET_PRINTER_UNKNOWN",
  GCODE_FLAVOR_MISMATCH: "GCODE_FLAVOR_MISMATCH",
  PROFILE_SET_NOT_APPROVED: "PROFILE_SET_NOT_APPROVED",
  PROFILE_SET_QUARANTINED: "PROFILE_SET_QUARANTINED",
  SLICE_VARIANT_MISSING: "SLICE_VARIANT_MISSING",
  SLICE_VARIANT_MISMATCH: "SLICE_VARIANT_MISMATCH",
  SLICING_UNAVAILABLE: "SLICING_UNAVAILABLE",
  ARTIFACT_MISSING: "ARTIFACT_MISSING",
  ARTIFACT_HASH_MISSING: "ARTIFACT_HASH_MISSING",
  ARTIFACT_HASH_MISMATCH: "ARTIFACT_HASH_MISMATCH",
  DEVICE_FILE_MISSING: "DEVICE_FILE_MISSING",
  DEVICE_FILE_NOT_VERIFIED: "DEVICE_FILE_NOT_VERIFIED",
  /** The adapter cannot upload and no operator has confirmed the manual transfer. */
  DEVICE_TRANSFER_NOT_CONFIRMED: "DEVICE_TRANSFER_NOT_CONFIRMED",
  /** A tracked device file exists for this slot but is INVALID/failed. */
  DEVICE_FILE_INVALID: "DEVICE_FILE_INVALID",
  /**
   * The prepared file no longer describes what would be printed now — the slice
   * variant, artifact hash, printer, path, size, profiles or assignment moved
   * under it. The bytes on the device may be intact; they are simply not this
   * job's bytes, so the file must be prepared again.
   */
  DEVICE_FILE_STALE: "DEVICE_FILE_STALE",
  NO_FILE: "NO_FILE",
  BAD_FILE_PATH: "BAD_FILE_PATH",
  FORMAT_UNKNOWN: "FORMAT_UNKNOWN",
  FORMAT_MISMATCH: "FORMAT_MISMATCH",
  ANALYSIS_MISSING: "ANALYSIS_MISSING",
  ANALYSIS_IN_PROGRESS: "ANALYSIS_IN_PROGRESS",
  ANALYSIS_FAILED: "ANALYSIS_FAILED",
  ANALYSIS_BLOCKERS: "ANALYSIS_BLOCKERS",
  ANALYSIS_VERDICT: "ANALYSIS_VERDICT",
  ANALYSIS_STALE: "ANALYSIS_STALE",
  ANALYZER_OUTDATED: "ANALYZER_OUTDATED",

  // ── Plan / assignment binding ─────────────────────────────────────────────
  ASSIGNMENT_PRINTER_MISMATCH: "ASSIGNMENT_PRINTER_MISMATCH",
  /**
   * Another task's live decision holds this printer — a person's placement or
   * one under the confirmed plan — although nothing physical is there yet. The
   * dispatch has always refused it («уже есть живое назначение»); the policy
   * now says so too, so a preview cannot be green for a start that will be
   * refused before a byte moves.
   */
  PRINTER_RESERVED: "PRINTER_RESERVED",
  /**
   * Not a refusal: an operator explicitly chose this printer for a job a person
   * had placed elsewhere (no plan, nothing physical yet). The launch withdraws
   * that placement, audited, before placing the job here.
   */
  ASSIGNMENT_REPLACED: "ASSIGNMENT_REPLACED",
  ASSIGNMENT_NOT_CONFIRMED: "ASSIGNMENT_NOT_CONFIRMED",
  /** The assignment's binding no longer matches the task (re-queued, re-sliced, edited). */
  ASSIGNMENT_STALE: "ASSIGNMENT_STALE",
  /** A profile revision the confirmed slice was produced with is gone or changed. */
  PROFILE_REVISION_MISMATCH: "PROFILE_REVISION_MISMATCH",
  PINNED_ELSEWHERE: "PINNED_ELSEWHERE",

  // ── Task / queue shape ────────────────────────────────────────────────────
  TASK_STATE: "TASK_STATE",
  ENTRY_STATE: "ENTRY_STATE",
  NO_QUEUE_ENTRY: "NO_QUEUE_ENTRY",

  // ── Night ─────────────────────────────────────────────────────────────────
  NOT_NIGHT_FLAGGED: "NOT_NIGHT_FLAGGED",
  UNATTENDED_NOT_ALLOWED: "UNATTENDED_NOT_ALLOWED",
  NIGHT_WINDOW_TOO_SHORT: "NIGHT_WINDOW_TOO_SHORT",
  NIGHT_WINDOW_UNKNOWN: "NIGHT_WINDOW_UNKNOWN",
  UNKNOWN_ETA: "UNKNOWN_ETA"
} as const;

export type ReasonCode = (typeof REASON)[keyof typeof REASON];

export type ReasonSeverity = "warning" | "blocker";

export interface EligibilityReason {
  code: ReasonCode;
  severity: ReasonSeverity;
  message: string;
  /** Structured context for the UI/audit (never used for decisions). */
  evidence?: unknown;
}

export type EligibilityStatus = "eligible" | "review" | "blocked";

export interface EligibilityResult {
  status: EligibilityStatus;
  reasons: EligibilityReason[];
}

/**
 * Reasons an operator may NEVER wave through, whatever the override.
 * Everything outside this set is a `warning` an explicit, audited operator
 * override may clear (see `DispatchOverride`).
 *
 * The rule for membership: a code belongs here when accepting it risks physical
 * damage, a crash into an occupied bed, or starting a file that is not the one
 * that was verified. "Unknown" codes are here too — an unknown critical is a
 * fail-closed refusal, not a judgement call.
 */
export const NON_OVERRIDABLE: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  REASON.BED_NOT_CLEAR,
  REASON.BED_STATE_UNKNOWN,
  // A pending physical intervention is a fact about the hardware, not a warning
  // about it: no operator tick makes the part come off the plate by itself.
  REASON.MANUAL_OPERATION_REQUIRED,
  REASON.BUILD_VOLUME_EXCEEDED,
  // Printing off the plate is a crash into the frame, not a judgement call.
  REASON.MODEL_OFF_BED,
  REASON.GCODE_FLAVOR_MISMATCH,
  REASON.TARGET_PRINTER_MISMATCH,
  REASON.NOZZLE_MISMATCH,
  REASON.DEVICE_FILE_MISSING,
  REASON.DEVICE_FILE_NOT_VERIFIED,
  REASON.DEVICE_TRANSFER_NOT_CONFIRMED,
  REASON.DEVICE_FILE_INVALID,
  REASON.DEVICE_FILE_STALE,
  REASON.ASSIGNMENT_STALE,
  REASON.PROFILE_REVISION_MISMATCH,
  REASON.ARTIFACT_HASH_MISMATCH,
  REASON.ACTIVE_RUN_EXISTS,
  REASON.UNRESOLVED_DISPATCH,
  REASON.SLICE_VARIANT_MISMATCH,
  REASON.ASSIGNMENT_PRINTER_MISMATCH,
  // Waiving it would only move the refusal to the placement step: the other
  // job's decision holds the printer until it is started or withdrawn.
  REASON.PRINTER_RESERVED,
  REASON.PRINTER_BUSY,
  REASON.NO_FILE,
  REASON.BAD_FILE_PATH,
  REASON.FORMAT_MISMATCH,
  // The device saying it cannot start. An operator tick does not put the MicroSD
  // card back in, and does not clear the fault code on the screen: the start
  // would simply be refused by the adapter's own pre-flight a second later.
  REASON.PRINTER_FAULT,
  REASON.PRINTER_MEDIA_MISSING,
  // The double-print guard. Overriding it is exactly the action it exists to
  // prevent; the way out is to resolve the unconfirmed run, which is a separate
  // audited statement about what the operator actually saw.
  REASON.LAUNCH_UNCONFIRMED,
  // The filament the printer would draw from. Printing a PETG job from a PLA tray
  // is not a judgement call an operator accepts responsibility for; the way out
  // is choosing the right tray (or loading the right spool), never a waiver.
  REASON.AMS_MATERIAL_MISMATCH,
  REASON.AMS_SLOT_AMBIGUOUS,
  REASON.AMS_MATERIAL_UNKNOWN,
  REASON.AMS_STATE_UNKNOWN,
  REASON.AMS_FEED_UNSUPPORTED,
  // A part printed at 1/25.4 of its size is not a risk an operator can accept;
  // the way out is slicing it again at the confirmed scale.
  REASON.SLICE_SCALE_MISMATCH,
  // A refusal nobody has taught this layer to read. Fail-closed by construction.
  REASON.PREFLIGHT_REASON_UNMAPPED,
  // The adapter has no way to take the job at all; an override would only move
  // the refusal to the device call that does not exist.
  REASON.PRINTER_MONITORING_ONLY
]);

export function reason(
  code: ReasonCode,
  severity: ReasonSeverity,
  message: string,
  evidence?: unknown
): EligibilityReason {
  return evidence === undefined ? { code, severity, message } : { code, severity, message, evidence };
}

/** `blocked` when any blocker is present, `review` when only warnings are, else `eligible`. */
export function statusOf(reasons: readonly EligibilityReason[]): EligibilityStatus {
  if (reasons.some((r) => r.severity === "blocker")) return "blocked";
  return reasons.length > 0 ? "review" : "eligible";
}

/** The blockers an operator override cannot clear — empty means the start is overridable. */
export function hardBlockers(result: EligibilityResult): EligibilityReason[] {
  return result.reasons.filter((r) => r.severity === "blocker" && NON_OVERRIDABLE.has(r.code));
}
