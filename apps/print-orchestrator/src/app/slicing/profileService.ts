import { JobError, NotFoundError, ValidationError } from "../../core/errors";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { AnalysisFinding, AuditEntityType, Metadata } from "../../domain/print/types";
import {
  validateProfileSet,
  type FindingSet,
  type SetMember
} from "../../domain/slicing/compatibility";
import { finding } from "../../domain/slicing/findings";
import {
  readFilament,
  readMachine,
  readProcess,
  type FilamentFields,
  type MachineFields,
  type OrcaSettings,
  type ProcessFields
} from "../../domain/slicing/orcaProfile";
import type {
  ProfileRevision,
  ProfileSet,
  ProfileSetValidation,
  ProfileType
} from "../../domain/slicing/types";
import type { OrcaRuntimeStatus, SliceRunner } from "../../infra/slicing/sliceRunner";
import type { StoreLogger } from "../../shared/logger";

/** The slice of a farm printer the compatibility checks and coverage report use. */
export interface SlicerPrinterRef {
  id: string;
  name: string;
  model: string | null;
  material: string | null;
  /** Transport/firmware family: "moonraker" | "bambu" | "creality". */
  protocol: string | null;
  /** Configured nozzle Ø (mm) from PrinterConfig; null when unknown. */
  nozzleMm?: number | null;
  /** Interchangeability class from PrinterConfig; null/empty when none. */
  printerClass?: string | null;
}

export interface CreateProfileSetInput {
  name: string;
  machineRevisionId: string;
  processRevisionId: string;
  filamentRevisionId: string;
  printerId?: string | null;
  printerClass?: string | null;
  actor?: string;
}

/** One printer's machine-profile coverage — surfaces the "no Ender 3 V3 KE profile" gap. */
export interface PrinterCoverage {
  printerId: string;
  printerName: string;
  model: string | null;
  hasAnyProfile: boolean;
  hasActiveProfile: boolean;
  activeProfileName: string | null;
}

export interface SlicingRuntimeReport {
  runtime: OrcaRuntimeStatus;
  profileCounts: { active: number; quarantined: number; invalid: number; total: number };
  /** Distinct unresolved parents across quarantined revisions (need `vendor/` profiles). */
  missingParents: string[];
  coverage: PrinterCoverage[];
}

/**
 * Read/management facade for profiles and profile sets. HTTP routes call this — it
 * never touches SQLite or a process directly. It owns two safety-critical rules:
 *   - a profile set's compatibility is (re-)validated from the *current* revision
 *     statuses, and
 *   - {@link ProfileService.approveSet} refuses to approve a set that has any blocker.
 */
export class ProfileService {
  private readonly now: () => Date;

  constructor(
    private readonly store: PrintQueueStore,
    private readonly runner: SliceRunner,
    private readonly listPrinters: () => SlicerPrinterRef[],
    private readonly options: { now?: () => Date; logger?: StoreLogger } = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  // ── Profiles ───────────────────────────────────────────────────────────────

  listProfiles(type?: ProfileType): ProfileRevision[] {
    return this.store.repositories.profileRevisions.list(type);
  }

  getProfile(id: string): ProfileRevision {
    const rev = this.store.repositories.profileRevisions.getById(id);
    if (!rev) throw new NotFoundError(`Профиль «${id}»`);
    return rev;
  }

  // ── Profile sets ─────────────────────────────────────────────────────────────

  listSets(): ProfileSet[] {
    return this.store.repositories.profileSets.list();
  }

  getSet(id: string): ProfileSet {
    const set = this.store.repositories.profileSets.getById(id);
    if (!set) throw new NotFoundError(`Набор профилей «${id}»`);
    return set;
  }

  /** Creates a profile set (unapproved), running compatibility validation up front. */
  createSet(input: CreateProfileSetInput): ProfileSet {
    if (!input.name?.trim()) throw new ValidationError("Поле «name» обязательно");
    const machine = this.requireRevision(input.machineRevisionId, "machine");
    const process = this.requireRevision(input.processRevisionId, "process");
    const filament = this.requireRevision(input.filamentRevisionId, "filament");
    // Exactly one target: a concrete printer (printerId) OR a class (printerClass),
    // never both and never neither — an ambiguous or absent target cannot be
    // validated against real hardware.
    if (Boolean(input.printerId) === Boolean(input.printerClass)) {
      throw new ValidationError(
        "Укажите ровно одну цель: либо конкретный принтер (printerId), либо класс (printerClass)"
      );
    }
    // A concrete target must exist in the farm — a slice for a phantom printer is meaningless.
    if (input.printerId && !this.listPrinters().some((p) => p.id === input.printerId)) {
      throw new NotFoundError(`Принтер «${input.printerId}» не найден в конфигурации фермы`);
    }

    const findings = this.validate(machine, process, filament, input.printerId ?? null);
    const validation = validationStatus(findings);
    const iso = this.nowIso();
    const actor = input.actor ?? "operator";

    const set: ProfileSet = {
      id: newId(ID_PREFIX.profileSet),
      name: input.name.trim(),
      machineRevisionId: machine.id,
      processRevisionId: process.id,
      filamentRevisionId: filament.id,
      printerId: input.printerId ?? null,
      printerClass: input.printerClass ?? null,
      validation,
      approved: false,
      approvedBy: null,
      approvedAt: null,
      warnings: findings.warnings,
      blockers: findings.blockers,
      createdAt: iso,
      updatedAt: iso,
      version: 1,
      metadata: {}
    };
    this.store.transaction(() => {
      this.store.repositories.profileSets.insert(set);
      this.recordAudit(actor, {
        entityType: "profile_set",
        entityId: set.id,
        action: "created",
        to: validation,
        detail: { blockers: findings.blockers.length, warnings: findings.warnings.length }
      });
    });
    return set;
  }

  /**
   * Approves a set — but only after re-validating against the current revision
   * statuses, and never when any blocker remains. This is the gate the brief
   * demands: "запрет утверждения ProfileSet с blockers".
   */
  approveSet(id: string, actor = "operator"): ProfileSet {
    return this.store.transaction(() => {
      const set = this.getSet(id);
      const machine = this.requireRevision(set.machineRevisionId, "machine");
      const process = this.requireRevision(set.processRevisionId, "process");
      const filament = this.requireRevision(set.filamentRevisionId, "filament");
      const findings = this.validate(machine, process, filament, set.printerId);
      const validation = validationStatus(findings);

      if (findings.blockers.length > 0) {
        // Persist the refreshed validation so the operator sees why, then refuse.
        this.store.repositories.profileSets.update({
          ...set,
          validation,
          warnings: findings.warnings,
          blockers: findings.blockers,
          updatedAt: this.nowIso()
        });
        throw new JobError(
          `Нельзя утвердить набор с блокерами: ${findings.blockers.map((b) => b.message).join("; ")}`
        );
      }

      const iso = this.nowIso();
      const approved = this.store.repositories.profileSets.update({
        ...set,
        validation,
        warnings: findings.warnings,
        blockers: findings.blockers,
        approved: true,
        approvedBy: actor,
        approvedAt: iso,
        updatedAt: iso
      });
      this.recordAudit(actor, {
        entityType: "profile_set",
        entityId: set.id,
        action: "approved",
        to: validation
      });
      return approved;
    });
  }

  // ── Runtime & coverage ───────────────────────────────────────────────────────

  async runtimeReport(): Promise<SlicingRuntimeReport> {
    const runtime = await this.runner.probe();
    const all = this.store.repositories.profileRevisions.list();
    const profileCounts = {
      active: all.filter((r) => r.status === "active").length,
      quarantined: all.filter((r) => r.status === "quarantined").length,
      invalid: all.filter((r) => r.status === "invalid").length,
      total: all.length
    };
    const missingParents = new Set<string>();
    for (const rev of all) {
      for (const b of rev.blockers) {
        if (b.code === "missing_parent") {
          const m = /«([^»]+)»/.exec(b.message);
          if (m) missingParents.add(m[1]);
        }
      }
    }
    return {
      runtime,
      profileCounts,
      missingParents: [...missingParents].sort(),
      coverage: this.printerCoverage(all.filter((r) => r.type === "machine"))
    };
  }

  /** For each farm printer, whether a machine profile (any / active) covers it. */
  printerCoverage(machines?: ProfileRevision[]): PrinterCoverage[] {
    const machineProfiles = machines ?? this.store.repositories.profileRevisions.list("machine");
    return this.listPrinters().map((printer) => {
      const matches = machineProfiles.filter((m) => modelMatches(m, printer));
      const active = matches.find((m) => m.status === "active") ?? null;
      return {
        printerId: printer.id,
        printerName: printer.name,
        model: printer.model,
        hasAnyProfile: matches.length > 0,
        hasActiveProfile: active !== null,
        activeProfileName: active?.name ?? null
      };
    });
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private requireRevision(id: string, type: ProfileType): ProfileRevision {
    const rev = this.store.repositories.profileRevisions.getById(id);
    if (!rev) throw new NotFoundError(`Профиль «${id}»`);
    if (rev.type !== type) {
      throw new ValidationError(`Профиль «${rev.name}» имеет тип «${rev.type}», ожидался «${type}»`);
    }
    return rev;
  }

  private validate(
    machine: ProfileRevision,
    process: ProfileRevision,
    filament: ProfileRevision,
    printerId: string | null
  ): FindingSet {
    const printer = printerId ? this.listPrinters().find((p) => p.id === printerId) ?? null : null;
    const machineMember: SetMember<MachineFields> = {
      name: machine.name,
      status: machine.status,
      fields: readMachine(settingsOf(machine))
    };
    const processMember: SetMember<ProcessFields> = {
      name: process.name,
      status: process.status,
      fields: readProcess(settingsOf(process))
    };
    const filamentMember: SetMember<FilamentFields> = {
      name: filament.name,
      status: filament.status,
      fields: readFilament(settingsOf(filament))
    };
    const findings = validateProfileSet({
      machine: machineMember,
      process: processMember,
      filament: filamentMember,
      target: printer
        ? {
            printerMaterial: printer.material,
            printerProtocol: printer.protocol,
            printerModel: printer.model,
            printerNozzleMm: printer.nozzleMm ?? null,
            printerClass: printer.printerClass ?? null
          }
        : undefined
    });
    // A concrete target that no longer resolves to a farm printer (removed from
    // config after the set was created) cannot be validated → block approval.
    if (printerId && !printer) {
      findings.blockers.push(
        finding("target_printer_unknown", `Целевой принтер «${printerId}» не найден в конфигурации фермы`)
      );
    }
    return findings;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private recordAudit(
    actor: string,
    input: { entityType: AuditEntityType; entityId: string; action: string; to?: string; detail?: Metadata }
  ): void {
    this.store.repositories.audit.insert({
      id: newId(ID_PREFIX.auditEvent),
      at: this.nowIso(),
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      fromState: null,
      toState: input.to ?? null,
      actor,
      detail: input.detail ?? {}
    });
  }
}

/** A revision's effective settings: the resolved merge when available, else its raw JSON. */
export function settingsOf(rev: ProfileRevision): OrcaSettings {
  const text = rev.resolvedJson ?? rev.rawJson;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as OrcaSettings)
      : {};
  } catch {
    return {};
  }
}

function validationStatus(findings: FindingSet): ProfileSetValidation {
  if (findings.blockers.length > 0) return "blocked";
  if (findings.warnings.length > 0) return "warnings";
  return "valid";
}

/** Loose printer-model match: normalise and check either token contains the other. */
function modelMatches(machine: ProfileRevision, printer: SlicerPrinterRef): boolean {
  const settings = settingsOf(machine);
  const machineModel = normalizeModel(readMachine(settings).printerModel ?? machine.name);
  const printerModel = normalizeModel(printer.model ?? printer.name);
  if (!machineModel || !printerModel) return false;
  return machineModel.includes(printerModel) || printerModel.includes(machineModel);
}

function normalizeModel(value: string | null): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
