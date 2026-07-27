import { operationMinutes } from "../../domain/operations/planning";
import { OPERATION_LABELS } from "../../domain/operations/states";
import type { ManualOperation } from "../../domain/operations/types";
import {
  projectFarmRelease,
  type MachineOccupancy,
  type PrinterRelease,
  type ReleaseOperationInput
} from "../../domain/scheduling/release";
import type { SchedulerContext } from "./context";
import { heldByActiveRun } from "./evidence";
import type { SchedulerPrinterRef } from "./types";

/**
 * The app-side adapter that feeds the pure farm-release projection
 * (`domain/scheduling/release`) with live rows: telemetry, canonical runs, bed
 * cycles, open manual operations and the operator calendar.
 *
 * This is the one place the recommendation planner learns that **a finished
 * print does not free a printer**. Everything it assembles is either an observed
 * fact or an explicit unknown; it never substitutes a plausible number, so a
 * printer whose release depends on an unestimated intervention or an
 * unresolvable schedule comes back with `releaseAtMs: null` and the planner
 * leaves the work unplaced instead of promising a start.
 */
export class ReleaseProjector {
  constructor(private readonly ctx: SchedulerContext) {}

  /** Every known printer's real release, sharing one operator across the farm. */
  project(nowMs: number): Map<string, PrinterRelease> {
    const printers = this.ctx.listPrinters();
    const machines = printers.map((p) => this.machineOf(p, nowMs));
    const operations = printers.flatMap((p) => this.operationsOf(p, nowMs));

    return projectFarmRelease({
      nowMs,
      machines,
      operations,
      nextOperatorSlot: (fromMs) => this.nextOperatorSlot(fromMs)
    });
  }

  /**
   * The earliest instant at or after `fromMs` an operator could work, or null.
   *
   * Null is returned for **both** "no schedule could be resolved" and "no window
   * inside the lookahead horizon" — the caller treats them identically, because
   * in both cases there is no instant to plan against. Without an injected
   * availability source the answer is always null: a farm with no operator model
   * cannot promise a human, and guessing one is exactly the failure this whole
   * module exists to prevent.
   */
  nextOperatorSlot(fromMs: number): number | null {
    const resolve = this.ctx.config.operatorAvailabilityAt;
    if (!resolve) return null;
    const availability = resolve(new Date(fromMs));
    if (!availability.resolved) return null;
    if (availability.presence === "AVAILABLE") return fromMs;
    const next = availability.nextAvailableAt;
    return next ? Math.max(fromMs, next.getTime()) : null;
  }

  /** What the machine itself is doing, with no human in the picture. */
  private machineOf(printer: SchedulerPrinterRef, nowMs: number): MachineOccupancy {
    if (printer.status === "printing" || printer.status === "paused") {
      const left = printer.printingTimeLeftMs;
      return {
        printerId: printer.id,
        busy: true,
        // A printing machine with no reported remaining time is honestly unknown.
        // The old planner advanced it by a 4-hour assumption; that assumption is
        // what let a plan promise a start nobody could keep.
        busyUntilMs: left !== null && left > 0 ? nowMs + left : null,
        busyLabel: printer.status === "paused" ? "печать на паузе" : "печатает"
      };
    }
    if (heldByActiveRun(printer.activeRunState)) {
      // Telemetry shows no print, but a canonical run still holds the printer (a
      // PENDING dispatch reservation, or a fail-closed UNKNOWN outcome). There is
      // no remaining-time estimate for that, so it is busy-until-unknown.
      return {
        printerId: printer.id,
        busy: true,
        busyUntilMs: null,
        busyLabel: "удерживается активным запуском"
      };
    }
    return { printerId: printer.id, busy: false, busyUntilMs: nowMs, busyLabel: "свободен" };
  }

  /**
   * The interventions gating one printer: its open manual operations, plus a
   * synthetic one when the bed is known to be occupied and **no** operation has
   * been registered for it.
   *
   * That synthetic entry matters: an `AWAITING_CLEARANCE`/`UNKNOWN` bed with no
   * clearance operation is a printer holding a part with nobody tasked to remove
   * it. Its release is genuinely unknown, and saying so is the only honest
   * answer — the alternative (treating the bed as clear because no row exists)
   * is precisely the bug the bed model was introduced to stop.
   */
  private operationsOf(printer: SchedulerPrinterRef, nowMs: number): ReleaseOperationInput[] {
    const open = this.ctx.config.manualOperations?.(printer.id) ?? [];
    const out = open.map((op) => toReleaseInput(op, nowMs));

    if (out.some((op) => op.blocking)) return out;

    const bed = this.ctx.store.repositories.bedCycles.findOpenByPrinter(printer.id);
    if (bed && bed.state !== "CLEAR" && bed.state !== "RUNNING" && bed.state !== "RESERVED") {
      out.push({
        id: `virtual-bed-${printer.id}`,
        type: "PART_REMOVAL",
        label: `стол не освобождён (${bed.state}), операция снятия не зарегистрирована`,
        printerId: printer.id,
        inProgress: false,
        blocking: true,
        minutes: null, // unknown on purpose → release stays unknown
        windowStartMs: null,
        createdAtMs: Date.parse(bed.updatedAt) || nowMs
      });
    }
    return out;
  }
}

/** One stored operation flattened into the pure projection's input shape. */
function toReleaseInput(op: ManualOperation, nowMs: number): ReleaseOperationInput {
  const windowStart = op.windowStart ? Date.parse(op.windowStart) : NaN;
  return {
    id: op.id,
    type: op.type,
    label: OPERATION_LABELS[op.type] ?? op.type,
    printerId: op.printerId,
    inProgress: op.state === "IN_PROGRESS",
    blocking: op.blocking,
    // `operationMinutes` deliberately does NOT fall back to the type default: a
    // null here is a row created with the duration explicitly unknown.
    minutes: operationMinutes(op),
    windowStartMs: Number.isFinite(windowStart) ? windowStart : null,
    createdAtMs: Date.parse(op.createdAt) || nowMs
  };
}
