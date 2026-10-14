import { ACTIVE_RUN_STATES, type BedCycle, type BedCycleState, type PrintRunState } from "./types";

/**
 * **What is on this printer's plate right now — the one answer every layer uses.**
 *
 * Three different facts used to be read as one. A printer reporting `idle`
 * says its *program* is not running; it says nothing about whether the part it
 * just finished is still standing on the bed. The scheduler inferred `CLEAR`
 * from a fresh `idle`, the dashboard defaulted an untracked bed to `CLEAR`, and
 * the dispatch only refused a bed it had an open row for — so a printer whose
 * history was never tracked, or one that printed something started on its own
 * touchscreen, looked free to all three.
 *
 * The rules, in order, each fail-closed:
 *
 *  1. **A tracked, non-CLEAR cycle is authoritative.** RESERVED, RUNNING,
 *     AWAITING_CLEARANCE and UNKNOWN are statements somebody recorded; nothing
 *     here overrides them with telemetry.
 *  2. **Observed printing outranks a CLEAR record.** A device printing (or
 *     paused) is physically using the bed whatever the ledger says — an
 *     external start does not ask Albedo first.
 *  3. **A canonical run holding the printer** is occupancy even when telemetry
 *     reads idle: an UNKNOWN outcome is an UNKNOWN bed, anything else is busy.
 *  4. **A recorded CLEAR is the only evidence of a free plate.** It was written
 *     by a named operator (or a verified mechanism) and survives until an
 *     observed print opens a new cycle.
 *  5. **Nothing tracked → UNKNOWN.** Never `CLEAR`, however idle the printer is.
 *
 * Pure: the caller reads the rows and the telemetry, this only decides.
 */
export interface BedOccupancyInput {
  /** The printer's newest bed cycle in any state; null when never tracked. */
  latestCycle: Pick<BedCycle, "state"> | null;
  /** Live device state, when telemetry exists. */
  liveStatus: string | null;
  /** Whether the device answered the last poll. */
  online: boolean;
  /** State of the canonical run holding the printer, if any. */
  activeRunState: PrintRunState | null;
}

export interface BedOccupancy {
  state: BedCycleState;
  /** Where the answer came from — so a UI can say "по наблюдению" vs "подтверждено". */
  source: "tracked" | "telemetry" | "active_run" | "untracked";
}

export function resolveBedOccupancy(input: BedOccupancyInput): BedOccupancy {
  const tracked = input.latestCycle?.state ?? null;
  if (tracked !== null && tracked !== "CLEAR") return { state: tracked, source: "tracked" };

  const printing = input.online && (input.liveStatus === "printing" || input.liveStatus === "paused");
  if (printing) return { state: "RUNNING", source: "telemetry" };

  if (input.activeRunState && ACTIVE_RUN_STATES.includes(input.activeRunState)) {
    return {
      state: input.activeRunState === "UNKNOWN" ? "UNKNOWN" : "RUNNING",
      source: "active_run"
    };
  }

  if (tracked === "CLEAR") return { state: "CLEAR", source: "tracked" };
  return { state: "UNKNOWN", source: "untracked" };
}

/** Metadata key on a bed cycle recording that it was opened for a print Albedo did not start. */
export const EXTERNAL_BED_CYCLE_KEY = "external";

/** Whether a cycle was opened by observing a print that no canonical run owns. */
export function isExternalCycle(cycle: Pick<BedCycle, "metadata"> | null | undefined): boolean {
  return cycle?.metadata?.[EXTERNAL_BED_CYCLE_KEY] === true;
}
