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
  TELEMETRY_STALE: "TELEMETRY_STALE",
  TELEMETRY_MISSING: "TELEMETRY_MISSING",
  REMOTE_START_UNSUPPORTED: "REMOTE_START_UNSUPPORTED",
  ACTIVE_RUN_EXISTS: "ACTIVE_RUN_EXISTS",
  UNRESOLVED_DISPATCH: "UNRESOLVED_DISPATCH",
  MAINTENANCE_BLOCKED: "MAINTENANCE_BLOCKED",

  // ── Geometry / hardware fit ───────────────────────────────────────────────
  BUILD_VOLUME_EXCEEDED: "BUILD_VOLUME_EXCEEDED",
  BUILD_VOLUME_UNKNOWN: "BUILD_VOLUME_UNKNOWN",
  DIMENSIONS_UNKNOWN: "DIMENSIONS_UNKNOWN",
  MODEL_SCALE_UNKNOWN: "MODEL_SCALE_UNKNOWN",
  NOZZLE_MISMATCH: "NOZZLE_MISMATCH",
  NOZZLE_UNKNOWN: "NOZZLE_UNKNOWN",
  MATERIAL_MISMATCH: "MATERIAL_MISMATCH",
  MATERIAL_UNKNOWN: "MATERIAL_UNKNOWN",
  AMS_UNSUPPORTED: "AMS_UNSUPPORTED",
  AMS_UNKNOWN: "AMS_UNKNOWN",

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
  REASON.PRINTER_BUSY,
  REASON.NO_FILE,
  REASON.BAD_FILE_PATH,
  REASON.FORMAT_MISMATCH
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
