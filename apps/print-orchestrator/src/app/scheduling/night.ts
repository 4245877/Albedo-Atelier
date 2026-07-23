import { ValidationError } from "../../core/errors";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { MaterialOverride, PrintTask } from "../../domain/print/types";
import { applySafetyBuffer, resolveEta } from "../../domain/scheduling/eta";
import {
  evaluateNightGate,
  selectNightSlots,
  type NightEvaluation,
  type NightGateInput
} from "../../domain/scheduling/night";
import type { SchedulerContext } from "./context";
import type { EvidenceResolver } from "./evidence";
import type { NightCandidatesReport, SchedulerPrinterRef } from "./types";

/** Default validity of a material override when the operator gives no window (a night's worth). */
const DEFAULT_OVERRIDE_VALID_HOURS = 16;

/**
 * Night (unattended) queries: the night-gate evaluation for every schedulable
 * task × printer, and the operator material overrides that stand in for the
 * remaining-filament telemetry the farm lacks. Every decision is delegated to
 * the pure domain gate (`domain/scheduling/night`); this module only resolves
 * evidence and persists overrides.
 */
export class NightQueries {
  constructor(
    private readonly ctx: SchedulerContext,
    private readonly evidence: EvidenceResolver
  ) {}

  /** Evaluates the night (unattended) gate for every schedulable task, one slot per printer. */
  nightCandidates(): NightCandidatesReport {
    const printers = this.ctx.listPrinters();
    const tasks = this.evidence.schedulableTasks();
    const titleOf = new Map(tasks.map((t) => [t.id, t.title] as const));

    // Every open task × printer is evaluated; the gate itself enforces the
    // unattended permission and the rest of the criteria, so nothing is pre-filtered.
    const gateInputs: NightGateInput[] = [];
    for (const task of tasks) {
      for (const printer of printers) {
        gateInputs.push(this.nightGateFor(task, printer));
      }
    }
    const evaluations = gateInputs.map((g) => evaluateNightGate(g, {
      safetyBufferRatio: this.ctx.config.nightSafetyBufferRatio
    }));
    const { chosen, rejected } = selectNightSlots(gateInputs, evaluations);

    const chosenKeys = new Set(chosen.map((c) => `${c.taskId}:${c.printerId}`));
    const rejectedBySlot = new Map(rejected.map((r) => [`${r.taskId}:${r.printerId}`, r.reason] as const));

    return {
      window: this.ctx.config.nightWindow,
      safetyBufferRatio: this.ctx.config.nightSafetyBufferRatio,
      candidates: chosen.map((c) => ({
        taskId: c.taskId,
        title: titleOf.get(c.taskId) ?? c.taskId,
        printerId: c.printerId,
        bufferedEtaSeconds: c.bufferedEtaSeconds,
        preliminary: c.preliminary
      })),
      rejected: this.collectNightRejections(evaluations, chosenKeys, rejectedBySlot, titleOf)
    };
  }

  /**
   * Records the operator assertion "this printer has enough loaded filament" —
   * the manual stand-in for the remaining-material telemetry the farm lacks, and
   * the only thing that lets a night candidate clear the material gate. The printer
   * must exist in the farm config; the assertion carries an author and an expiry.
   */
  setMaterialOverride(
    printerId: string,
    input: {
      sufficient?: boolean;
      coverageHours?: number | null;
      note?: string | null;
      validForHours?: number | null;
      author?: string;
    } = {}
  ): MaterialOverride {
    const id = printerId.trim();
    if (!id) throw new ValidationError("Не указан принтер");
    if (!this.ctx.listPrinters().some((p) => p.id === id)) {
      throw new ValidationError(`Принтер «${id}» отсутствует в конфигурации фермы`);
    }
    const coverageHours =
      input.coverageHours === null || input.coverageHours === undefined
        ? null
        : requirePositive(input.coverageHours, "coverageHours");
    const validForHours =
      input.validForHours === null || input.validForHours === undefined
        ? DEFAULT_OVERRIDE_VALID_HOURS
        : requirePositive(input.validForHours, "validForHours");

    const nowMs = this.ctx.config.now().getTime();
    const iso = new Date(nowMs).toISOString();
    return this.ctx.store.transaction(() => {
      const override: MaterialOverride = {
        id: newId(ID_PREFIX.materialOverride),
        printerId: id,
        sufficient: input.sufficient !== false,
        coverageHours,
        note: input.note?.trim() || null,
        author: input.author ?? this.ctx.actor,
        createdAt: iso,
        expiresAt: new Date(nowMs + validForHours * 3_600_000).toISOString(),
        version: 1,
        metadata: {}
      };
      this.ctx.store.repositories.materialOverrides.insert(override);
      this.ctx.recordAudit({
        entityType: "material_override",
        entityId: override.id,
        action: "created",
        actor: input.author,
        detail: { printerId: id, sufficient: override.sufficient, coverageHours, validForHours }
      });
      return override;
    });
  }

  /** The active (unexpired) material override for every printer that has one. */
  listActiveMaterialOverrides(): MaterialOverride[] {
    return this.ctx.listPrinters()
      .map((p) => this.activeMaterialOverride(p.id))
      .filter((o): o is MaterialOverride => o !== null);
  }

  // ── Internals ─────────────────────────────────────────────────────────────────

  private nightGateFor(task: PrintTask, printer: SchedulerPrinterRef): NightGateInput {
    const { evidence, needsSlicing, gcodeReady } = this.evidence.resolveEvidence(task, printer);
    const staleMs = this.ctx.compatibilityConfig.telemetryStaleMs;
    const telemetryFresh =
      evidence.telemetryAgeMs !== null && evidence.telemetryAgeMs <= staleMs;
    // Resolve the ETA through the same canonical resolver the compatibility matrix
    // uses, so a non-positive slice/gcode duration (bad data) is treated as *unknown*
    // here too — never a "known" night ETA that would fail the gate silently or, via
    // the safety buffer, surface a negative duration.
    const etaSeconds = resolveEta({ sliceEtaS: evidence.sliceEtaS, gcodeEtaS: evidence.gcodeEtaS }).seconds;
    const bufferedEtaSeconds =
      etaSeconds !== null ? applySafetyBuffer(etaSeconds, this.ctx.config.nightSafetyBufferRatio) : null;
    return {
      taskId: task.id,
      printerId: printer.id,
      priority: task.priority,
      needsSlicing,
      readySliceVariant: evidence.readySliceVariant,
      profileSetApproved: evidence.profileSetApproved === true,
      gcodeReady,
      etaSeconds,
      // Compare the buffered ETA against the operator's material-coverage override.
      materialSufficient: this.resolveMaterialSufficient(printer, bufferedEtaSeconds),
      telemetryFresh,
      bedCycle: evidence.bedCycle,
      maintenanceBlockers: evidence.maintenanceBlockers,
      unattendedAllowed: task.unattendedAllowed
    };
  }

  /**
   * Whether the printer's loaded filament covers a print of `bufferedEtaSeconds`.
   * A live telemetry hint (rare today) wins; otherwise the operator's material
   * override decides, and with neither the answer is honestly `null` (unknown),
   * which fails the night gate rather than assuming enough.
   */
  private resolveMaterialSufficient(
    printer: SchedulerPrinterRef,
    bufferedEtaSeconds: number | null
  ): boolean | null {
    if (printer.materialRemainingSufficient !== null) return printer.materialRemainingSufficient;
    const override = this.activeMaterialOverride(printer.id);
    if (!override) return null;
    if (!override.sufficient) return false;
    if (override.coverageHours === null) return true; // a blanket "enough" assertion
    if (bufferedEtaSeconds === null) return null; // can't verify coverage against an unknown ETA
    return bufferedEtaSeconds <= override.coverageHours * 3600;
  }

  /** The newest still-valid (unexpired) material override for a printer, or null. */
  private activeMaterialOverride(printerId: string): MaterialOverride | null {
    const nowMs = this.ctx.config.now().getTime();
    for (const override of this.ctx.store.repositories.materialOverrides.listByPrinter(printerId)) {
      if (override.expiresAt === null) return override;
      const expMs = Date.parse(override.expiresAt);
      if (!Number.isFinite(expMs) || expMs > nowMs) return override;
    }
    return null;
  }

  private collectNightRejections(
    evaluations: NightEvaluation[],
    chosenKeys: Set<string>,
    rejectedBySlot: Map<string, string>,
    titleOf: Map<string, string>
  ): NightCandidatesReport["rejected"] {
    const out: NightCandidatesReport["rejected"] = [];
    const seen = new Set<string>();
    for (const e of evaluations) {
      const key = `${e.taskId}:${e.printerId}`;
      if (chosenKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      const reasons = e.eligible ? [] : e.blockers;
      const slotReason = rejectedBySlot.get(key);
      const allReasons = slotReason ? [slotReason, ...reasons] : reasons;
      if (allReasons.length === 0) continue;
      out.push({
        taskId: e.taskId,
        title: titleOf.get(e.taskId) ?? e.taskId,
        printerId: e.printerId,
        reasons: allReasons
      });
    }
    return out;
  }
}

/** A finite, strictly-positive number, else a 400 — for operator-supplied hours. */
function requirePositive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`Поле «${field}» должно быть положительным числом`);
  }
  return value;
}
