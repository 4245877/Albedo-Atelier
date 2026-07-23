import { JobError, NotFoundError, ValidationError } from "../../core/errors";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import { recordAuditEvent } from "../audit";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { AuditEntityType, Metadata } from "../../domain/print/types";
import {
  validateProfileSet,
  type FindingSet,
  type SetMember,
  type SetTarget
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
  /** Interchangeability class (config `printerClass`); null when the printer has none. */
  printerClass: string | null;
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
    private readonly options: {
      now?: () => Date;
      logger?: StoreLogger;
      /**
       * Called with every fresh runtime probe result (from {@link runtimeReport}).
       * The store uses it to keep its single cached `sliceRuntimeAvailable` — the
       * one the manual scheduler gates on — in sync with what the slicing tab sees,
       * so the two can't drift after OrcaSlicer crashes or recovers between boots.
       */
      onRuntimeProbed?: (available: boolean) => void;
    } = {}
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
    return this.store.repositories.profileSets.list().map((s) => this.refreshedForDisplay(s));
  }

  getSet(id: string): ProfileSet {
    const set = this.store.repositories.profileSets.getById(id);
    if (!set) throw new NotFoundError(`Набор профилей «${id}»`);
    return this.refreshedForDisplay(set);
  }

  /** The raw stored set (no live re-validation) — for internal write paths. */
  private requireSet(id: string): ProfileSet {
    const set = this.store.repositories.profileSets.getById(id);
    if (!set) throw new NotFoundError(`Набор профилей «${id}»`);
    return set;
  }

  /**
   * A display copy of a set whose validation is recomputed from the *current*
   * revision + printer state, so the UI can never show a stale `approved/valid`:
   * if a member fell out of `active` (a re-import quarantined it, say) or the target
   * printer/class changed, the copy is `blocked` and its approval is withdrawn with
   * an explicit "re-validate" note. Pure — it never writes (see {@link revalidateSets}
   * for the persisted, audited counterpart run after an import).
   */
  private refreshedForDisplay(set: ProfileSet): ProfileSet {
    const findings = this.validateStoredSet(set);
    const validation = validationStatus(findings);
    const blockers = [...findings.blockers];
    let approved = set.approved;
    if (validation === "blocked") {
      if (set.approved) {
        blockers.unshift(
          finding(
            "set_needs_revalidation",
            "Набор был утверждён, но состав профилей изменился после повторного импорта — проверьте и утвердите заново"
          )
        );
      }
      approved = false;
    }
    return { ...set, validation, warnings: findings.warnings, blockers, approved };
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

    const findings = this.validate(machine, process, filament, {
      printerId: input.printerId ?? null,
      printerClass: input.printerClass ?? null
    });
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
    // Re-validate and persist the *refreshed* validation atomically, deciding
    // inside the transaction whether the set is approvable — but WITHOUT throwing
    // in it. Throwing here would roll the write back, so a re-import that surfaced
    // new blockers would be discarded and the operator would keep getting a
    // reason-less refusal. Instead the write (blockers and all) always commits, and
    // the refusal is raised as an HTTP error *after* the transaction returns.
    const outcome = this.store.transaction(() => {
      const set = this.requireSet(id);
      const machine = this.requireRevision(set.machineRevisionId, "machine");
      const process = this.requireRevision(set.processRevisionId, "process");
      const filament = this.requireRevision(set.filamentRevisionId, "filament");
      const findings = this.validate(machine, process, filament, {
        printerId: set.printerId,
        printerClass: set.printerClass
      });
      const validation = validationStatus(findings);
      const blocked = findings.blockers.length > 0;
      const iso = this.nowIso();

      const saved = this.store.repositories.profileSets.update({
        ...set,
        validation,
        warnings: findings.warnings,
        blockers: findings.blockers,
        approved: blocked ? set.approved : true,
        approvedBy: blocked ? set.approvedBy : actor,
        approvedAt: blocked ? set.approvedAt : iso,
        updatedAt: iso
      });
      this.recordAudit(actor, {
        entityType: "profile_set",
        entityId: set.id,
        action: blocked ? "approval_refused" : "approved",
        to: validation,
        detail: blocked ? { blockers: findings.blockers.length } : undefined
      });
      return { saved, blockers: findings.blockers, blocked };
    });

    if (outcome.blocked) {
      throw new JobError(
        `Нельзя утвердить набор с блокерами: ${outcome.blockers.map((b) => b.message).join("; ")}`
      );
    }
    return outcome.saved;
  }

  /**
   * Re-validates every profile set against the *current* revision/printer state and
   * persists the result — the authoritative counterpart to {@link refreshedForDisplay}.
   * Called after a preset (re)import, which can flip a revision `active → quarantined`
   * (e.g. a vendor parent went missing) on the very ids an approved set pins. A set
   * that a changed member made unusable has its approval **revoked** (never left
   * showing a stale `approved/valid`), so the durable state and what the pipeline
   * would actually accept can't drift. Returns the number of sets it changed.
   */
  revalidateSets(actor = "system"): number {
    let changed = 0;
    for (const set of this.store.repositories.profileSets.list()) {
      const machine = this.store.repositories.profileRevisions.getById(set.machineRevisionId);
      const process = this.store.repositories.profileRevisions.getById(set.processRevisionId);
      const filament = this.store.repositories.profileRevisions.getById(set.filamentRevisionId);
      const findings = this.validate(machine, process, filament, {
        printerId: set.printerId,
        printerClass: set.printerClass
      });
      const validation = validationStatus(findings);
      const revoke = set.approved && findings.blockers.length > 0;
      // Write only when the operator-visible verdict changed (or approval must be
      // revoked) — a no-op re-import must not bump versions or spam the audit log.
      if (validation === set.validation && !revoke) continue;
      this.store.transaction(() => {
        const current = this.store.repositories.profileSets.getById(set.id);
        if (!current) return;
        this.store.repositories.profileSets.update({
          ...current,
          validation,
          warnings: findings.warnings,
          blockers: findings.blockers,
          approved: revoke ? false : current.approved,
          updatedAt: this.nowIso()
        });
        this.recordAudit(actor, {
          entityType: "profile_set",
          entityId: set.id,
          action: revoke ? "approval_revoked" : "revalidated",
          to: validation,
          detail: revoke ? { reason: "member_no_longer_usable" } : undefined
        });
      });
      changed += 1;
    }
    return changed;
  }

  // ── Runtime & coverage ───────────────────────────────────────────────────────

  async runtimeReport(): Promise<SlicingRuntimeReport> {
    const runtime = await this.runner.probe();
    // Keep the store's cached availability (read synchronously by the scheduler) in
    // step with this fresh probe, so the tab and the planner never disagree.
    this.options.onRuntimeProbed?.(runtime.available);
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
        printerClass: printer.printerClass ?? null,
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

  /**
   * The single compatibility mechanism used by create, approve, display and
   * (post-import) re-validation. Revisions may be null (deleted/never-loaded), which
   * validateProfileSet reports as a missing member. The target is exactly one of a
   * concrete printer OR a printer class:
   *   - printer: hard-checked against that device's hardware; a target that no longer
   *     resolves to a farm printer is a blocker;
   *   - class: hard-checked against EVERY printer of the class — unknown class or a
   *     class with no compatible member is a blocker (a partial fit is a warning).
   */
  private validate(
    machine: ProfileRevision | null,
    process: ProfileRevision | null,
    filament: ProfileRevision | null,
    target: { printerId: string | null; printerClass: string | null }
  ): FindingSet {
    const members = setMembersOf(machine, process, filament);
    if (target.printerId) {
      const printer = this.listPrinters().find((p) => p.id === target.printerId) ?? null;
      const findings = validateProfileSet({ ...members, target: printer ? targetOf(printer) : undefined });
      // A concrete target that no longer resolves to a farm printer (removed from
      // config after the set was created) cannot be validated → block approval.
      if (!printer) {
        findings.blockers.push(
          finding("target_printer_unknown", `Целевой принтер «${target.printerId}» не найден в конфигурации фермы`)
        );
      }
      return findings;
    }
    if (target.printerClass) {
      const printers = this.printersOfClass(target.printerClass);
      return validateProfileSet({
        ...members,
        classTargets: { className: target.printerClass, printers: printers.map(targetOf) }
      });
    }
    // No target bound (createSet forbids this; kept defensive for display).
    return validateProfileSet(members);
  }

  /** Re-validates a stored set against the current revision/printer state (tolerant of deleted revisions). */
  private validateStoredSet(set: ProfileSet): FindingSet {
    const repos = this.store.repositories;
    return this.validate(
      repos.profileRevisions.getById(set.machineRevisionId),
      repos.profileRevisions.getById(set.processRevisionId),
      repos.profileRevisions.getById(set.filamentRevisionId),
      { printerId: set.printerId, printerClass: set.printerClass }
    );
  }

  /** Farm printers whose interchangeability class matches `className` (case/space-insensitive). */
  private printersOfClass(className: string): SlicerPrinterRef[] {
    const want = normalizeClass(className);
    return this.listPrinters().filter((p) => p.printerClass && normalizeClass(p.printerClass) === want);
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private recordAudit(
    actor: string,
    input: { entityType: AuditEntityType; entityId: string; action: string; to?: string; detail?: Metadata }
  ): void {
    recordAuditEvent(this.store, () => this.nowIso(), actor, input);
  }
}

/**
 * Builds the compatibility {@link SetMember}s from three (possibly-null) revisions.
 * Shared by the profile service and the slice service so a set is always read into
 * the validator the exact same way (единый механизм). A null revision becomes a
 * null member — validateProfileSet reports that as a missing member.
 */
export function setMembersOf(
  machine: ProfileRevision | null,
  process: ProfileRevision | null,
  filament: ProfileRevision | null
): {
  machine: SetMember<MachineFields> | null;
  process: SetMember<ProcessFields> | null;
  filament: SetMember<FilamentFields> | null;
} {
  return {
    machine: machine ? { name: machine.name, status: machine.status, fields: readMachine(settingsOf(machine)) } : null,
    process: process ? { name: process.name, status: process.status, fields: readProcess(settingsOf(process)) } : null,
    filament: filament
      ? { name: filament.name, status: filament.status, fields: readFilament(settingsOf(filament)) }
      : null
  };
}

/** The compatibility {@link SetTarget} view of one farm printer's hardware. */
export function targetOf(printer: SlicerPrinterRef): SetTarget {
  return {
    printerMaterial: printer.material,
    printerProtocol: printer.protocol,
    printerModel: printer.model,
    printerNozzleMm: printer.nozzleMm ?? null
  };
}

/** Canonical form of a printer-class label for matching (trimmed, case-insensitive). */
export function normalizeClass(value: string): string {
  return value.trim().toLowerCase();
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
