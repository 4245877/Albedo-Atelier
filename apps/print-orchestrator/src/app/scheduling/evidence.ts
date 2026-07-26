import { ACTIVE_RUN_STATES, type PrintRunState } from "../../domain/print/types";
import type {
  Artifact,
  ArtifactAnalysis,
  BedCycle,
  BedCycleState,
  Metadata,
  PrintTask
} from "../../domain/print/types";
import {
  evaluateCompatibility,
  type CompatibilityEvidence,
  type CompatibilityPrinterInput,
  type CompatibilityResult,
  type CompatibilityTaskInput,
  type Dimensions
} from "../../domain/scheduling/compatibility";
import { readFilament, readMachine } from "../../domain/slicing/orcaProfile";
import type { ProfileSet, SliceVariant } from "../../domain/slicing/types";
import { settingsOf } from "../slicing/profileService";
import type { SchedulerContext } from "./context";
import type { CompatibilityMatrix, SchedulerPrinterRef } from "./types";

/** What {@link EvidenceResolver.resolveEvidence} assembles for one (task, printer). */
export interface ResolvedEvidence {
  taskInput: CompatibilityTaskInput;
  evidence: CompatibilityEvidence;
  buildVolume: Dimensions | null;
  needsSlicing: boolean;
  gcodeReady: boolean;
  /** The rows behind the evidence, so the dispatch layer re-reads nothing. */
  artifact: Artifact | null;
  analysis: ArtifactAnalysis | null;
  /** The ready slice variant targeting this printer, when one exists. */
  variant: SliceVariant | null;
  /** Live bed-cycle row for the printer (null when nothing is tracked). */
  bedCycle: BedCycle | null;
}

/**
 * Evidence resolution: assembles the live facts the pure scheduling domain
 * decides over — ready slice variants, approved profile sets, artifact
 * analyses, bed cycles and telemetry — for one (task, printer) pair, and the
 * task × printer compatibility matrix built from them. Nothing is invented:
 * unknowns stay null so the domain downgrades honestly to `review`.
 */
export class EvidenceResolver {
  constructor(private readonly ctx: SchedulerContext) {}

  /** The task × printer compatibility grid for every schedulable open-queue task. */
  compatibilityMatrix(): CompatibilityMatrix {
    const printers = this.ctx.listPrinters();
    const tasks = this.schedulableTasks();
    return {
      printers: printers.map((p) => ({ id: p.id, name: p.name })),
      rows: tasks.map((task) => ({
        taskId: task.id,
        title: task.title,
        results: printers.map((printer) => this.evaluate(task, printer))
      }))
    };
  }

  evaluate(task: PrintTask, printer: SchedulerPrinterRef): CompatibilityResult {
    const { taskInput, evidence, buildVolume } = this.resolveEvidence(task, printer);
    return evaluateCompatibility(
      taskInput,
      this.printerInputFor(printer, buildVolume),
      evidence,
      this.ctx.compatibilityConfig
    );
  }

  /** The printer half of the preflight input; shared with the dispatch-eligibility path. */
  printerInputFor(
    printer: SchedulerPrinterRef,
    buildVolume: Dimensions | null
  ): CompatibilityPrinterInput {
    return {
      id: printer.id,
      name: printer.name,
      model: printer.model,
      protocol: printer.protocol,
      material: printer.material,
      nozzleMm: printer.nozzleMm,
      // Already resolved (config field > ready-slice machine bed > approved profile
      // bed); null only when no source knows it → an honest `review`.
      buildVolume,
      online: printer.online,
      status: printer.status,
      remoteStartSupported: printer.remoteStartSupported,
      ams: printer.ams
    };
  }

  /**
   * Assembles the compatibility inputs for one (task, printer) from the live
   * model: the ready slice variant targeting this printer (if any), its profile
   * set, and the source analysis. Nothing is invented — unknowns stay null.
   */
  resolveEvidence(task: PrintTask, printer: SchedulerPrinterRef): ResolvedEvidence {
    const repos = this.ctx.store.repositories;
    const artifact = task.artifactId ? repos.artifacts.getById(task.artifactId) : null;
    // "Needs slicing" means there is source geometry the farm must turn into
    // printer-specific G-code. A task with no registered artifact that names a
    // file already sitting on the printer (the legacy/manual flow) has no bytes
    // to slice — treating it as un-sliced work would block every attended start
    // on a slice that can never exist. Its honesty is enforced elsewhere: with no
    // analysis it can never satisfy `gcodeReady`, so it stays night-ineligible.
    const needsSlicing = artifact
      ? artifact.kind !== "gcode"
      : typeof task.metadata.file !== "string" || task.metadata.file.trim() === "";

    const variant = this.readyVariantFor(task.id, printer);
    const profileSet = variant ? repos.profileSets.getById(variant.profileSetId) : null;
    const machineFields = profileSet ? this.machineFieldsOf(profileSet) : null;
    const filamentFields = profileSet ? this.filamentFieldsOf(profileSet) : null;

    // Source/output analysis for dimensions/nozzle/material when there is no slice.
    const analysis = artifact ? repos.artifactAnalyses.latestForArtifact(artifact.id) : null;
    // A ready G-code file's readiness proof (the night gate uses it in place of a
    // ready slice + approved set): the analysis finished and found no blockers.
    const gcodeReady =
      analysis !== null &&
      analysis.state === "ready" &&
      analysis.verdict !== "blocked" &&
      analysis.blockers.length === 0;

    // A ready slice's own dimensions win (the slicer worked in mm on this exact
    // machine); otherwise the source analysis, whose unit may be unproven.
    const readDimensions = readDims(variant?.dimensions ?? null) ?? readDims(analysis?.data ?? null);
    const dimensions = readDimensions?.dimensions ?? null;
    const requiredNozzleMm =
      machineFields?.nozzleDiameterMm ?? analysis?.nozzleDiameterMm ?? null;
    const material =
      task.material ?? filamentFields?.filamentType ?? analysis?.material ?? null;
    const gcodeFlavor = machineFields?.gcodeFlavor ?? null;

    // Build volume, in priority order: the explicit config field, then the ready
    // slice's own machine bed, then the approved machine profile bound to this
    // printer. The bed is a real, stored value — never invented — so a plain G-code
    // task no longer stalls on "рабочая область неизвестна".
    const sliceBed = bedDimsOf(machineFields);
    const profileBed = this.printerProfileBuildVolume(printer.id);
    const configBed = printer.buildVolume;
    const profileDerived = sliceBed ?? profileBed;
    const buildVolume = configBed ?? profileDerived;
    const buildVolumeConflict =
      configBed !== null && profileDerived !== null && dimsDiffer(configBed, profileDerived);

    const bed = repos.bedCycles.findOpenByPrinter(printer.id);

    const taskInput: CompatibilityTaskInput = {
      id: task.id,
      title: task.title,
      material,
      pinnedPrinterId: task.pinnedPrinterId,
      dimensions,
      // No dimensions at all is already reported as `dimensions_unknown`; the
      // scale flag only matters when there ARE numbers, so it defaults to true.
      dimensionsScaleKnown: readDimensions?.scaleKnown ?? true,
      requiredNozzleMm,
      gcodeFlavor,
      // No AMS/multi-material requirement is recorded anywhere in the model yet
      // (neither the task nor the analyzers detect it), so this stays an honest
      // `null` = unknown rather than a fabricated boolean. The compatibility AMS
      // branch only fires on `true`, so it is dormant — not wrong — until a real
      // source (a task field or a multi-filament analysis signal) feeds it.
      amsRequired: null,
      needsSlicing
    };

    const evidence: CompatibilityEvidence = {
      readySliceVariant: variant !== null,
      profileSetApproved: profileSet ? profileSet.approved : null,
      profileSetBlocked: profileSet ? profileSet.validation === "blocked" : false,
      runtimeAvailable: this.ctx.config.runtimeAvailable,
      bedCycle: this.bedStateFor(printer, bed ? bed.state : null),
      buildVolumeConflict,
      telemetryAgeMs: printer.telemetryAgeMs,
      maintenanceBlockers: [],
      sliceEtaS: variant?.orcaEtaS ?? null,
      gcodeEtaS: analysis?.estimatedDurationS ?? null
    };

    return {
      taskInput,
      evidence,
      buildVolume,
      needsSlicing,
      gcodeReady,
      artifact,
      analysis,
      variant,
      bedCycle: bed
    };
  }

  /**
   * The bed occupancy to reason with. A tracked cycle is authoritative; without
   * one we infer honestly from live telemetry instead of assuming CLEAR — a printer
   * that is physically printing (a legacy start outside the model) reads `RUNNING`,
   * and a printer we cannot observe reads `UNKNOWN`, so neither is silently treated
   * as a free bed.
   */
  private bedStateFor(printer: SchedulerPrinterRef, trackedState: BedCycleState | null): BedCycleState {
    if (trackedState !== null) return trackedState;
    if (printer.status === "printing" || printer.status === "paused") return "RUNNING";
    // A canonical run holding the printer means the bed is not free even when
    // telemetry isn't reporting a print: a fail-closed UNKNOWN run is an UNKNOWN bed
    // (a human reconciles it), a PENDING/RUNNING/PAUSED run is a busy (RUNNING) bed —
    // either way never silently inferred CLEAR below.
    if (heldByActiveRun(printer.activeRunState)) {
      return printer.activeRunState === "UNKNOWN" ? "UNKNOWN" : "RUNNING";
    }
    const staleMs = this.ctx.compatibilityConfig.telemetryStaleMs;
    const fresh = printer.telemetryAgeMs !== null && printer.telemetryAgeMs <= staleMs;
    if (printer.online && fresh && printer.status === "idle") return "CLEAR";
    return "UNKNOWN";
  }

  /** The build volume from the approved machine profile bound to this printer id, or null. */
  private printerProfileBuildVolume(printerId: string): Dimensions | null {
    const set = this.approvedMachineSetFor(printerId);
    return set ? bedDimsOf(this.machineFieldsOf(set)) : null;
  }

  /** The most recently approved, non-blocked profile set bound to this exact printer id. */
  private approvedMachineSetFor(printerId: string): ProfileSet | null {
    const sets = this.ctx.store.repositories.profileSets
      .list()
      .filter((s) => s.printerId === printerId && s.approved && s.validation !== "blocked");
    // `list()` is newest-first by created_at; prefer the most recent approval.
    sets.sort((a, b) => (b.approvedAt ?? b.updatedAt).localeCompare(a.approvedAt ?? a.updatedAt));
    return sets[0] ?? null;
  }

  /**
   * A ready SliceVariant for this task that this printer may actually run: a
   * printer-specific variant wins; otherwise a *class-scoped* variant matches only
   * when its class equals this printer's class. A class-less printer never matches a
   * null-target variant — a slice is never treated as "fits any printer"
   * (fail-closed; the audit's "любой вариант с targetPrinterId === null подходит
   * любому принтеру" hole).
   */
  private readyVariantFor(taskId: string, printer: SchedulerPrinterRef): SliceVariant | null {
    const variants = this.ctx.store.repositories.sliceVariants
      .listByTask(taskId)
      .filter((v) => v.state === "ready" && v.outputArtifactId !== null);
    const printerClass = normalizeClass(printer.printerClass);
    return (
      variants.find((v) => v.targetPrinterId === printer.id) ??
      (printerClass
        ? variants.find(
            (v) => v.targetPrinterId === null && normalizeClass(v.targetPrinterClass) === printerClass
          )
        : undefined) ??
      null
    );
  }

  /**
   * The task's *printer-agnostic* required nozzle Ø (mm), from its artifact
   * analysis; null when unknown. The compatibility matrix resolves nozzle per
   * (task, printer) — including a printer-specific slice's machine profile — and
   * blocks a mismatch there; the planner only needs the task's own requirement so
   * its "nozzle swap" penalty and warning have a real value to compare against
   * (they were dead while this was hard-coded null).
   */
  taskRequiredNozzleMm(task: PrintTask): number | null {
    if (!task.artifactId) return null;
    const analysis = this.ctx.store.repositories.artifactAnalyses.latestForArtifact(task.artifactId);
    const nozzle = analysis?.nozzleDiameterMm ?? null;
    return nozzle !== null && Number.isFinite(nozzle) && nozzle > 0 ? nozzle : null;
  }

  private machineFieldsOf(set: ProfileSet): ReturnType<typeof readMachine> | null {
    const rev = this.ctx.store.repositories.profileRevisions.getById(set.machineRevisionId);
    return rev ? readMachine(settingsOf(rev)) : null;
  }

  private filamentFieldsOf(set: ProfileSet): ReturnType<typeof readFilament> | null {
    const rev = this.ctx.store.repositories.profileRevisions.getById(set.filamentRevisionId);
    return rev ? readFilament(settingsOf(rev)) : null;
  }

  /**
   * Open-queue tasks eligible for planning, in queue order: a `WAITING` entry whose
   * task is still awaiting placement (`QUEUED`/`PLANNED`). An `ASSIGNED` task already
   * holds a printer/bed (via `PrintQueueService.assignTask`) and must not be
   * planned onto a second one; a `NEEDS_REVIEW` task is parked for a human. Neither
   * is schedulable, so both are excluded here (the one place planning, the matrix,
   * and the night gate read).
   */
  schedulableTasks(): PrintTask[] {
    const repos = this.ctx.store.repositories;
    const tasks: PrintTask[] = [];
    for (const entry of repos.queue.listOpen()) {
      if (entry.state !== "WAITING") continue;
      const task = repos.tasks.getById(entry.taskId);
      if (!task) continue;
      if (task.state === "QUEUED" || task.state === "PLANNED") {
        tasks.push(task);
      }
    }
    return tasks;
  }
}

// ── Free helpers ────────────────────────────────────────────────────────────────

/**
 * Whether a canonical run in this state holds the printer — i.e. it is one of the
 * domain's authoritative {@link ACTIVE_RUN_STATES}. Uses the constant (not a local
 * literal list) so the scheduler's "is this printer free?" rule can never drift from
 * the infra `findActive*` queries or the migration-008 unique index.
 */
export function heldByActiveRun(state: PrintRunState | null | undefined): boolean {
  return state != null && ACTIVE_RUN_STATES.includes(state);
}

/** The `{x,y,z}` build volume from parsed machine fields, or null when any axis is unknown. */
function bedDimsOf(machine: ReturnType<typeof readMachine> | null): Dimensions | null {
  if (
    machine &&
    machine.bedWidthMm !== null &&
    machine.bedDepthMm !== null &&
    machine.bedHeightMm !== null
  ) {
    return { x: machine.bedWidthMm, y: machine.bedDepthMm, z: machine.bedHeightMm };
  }
  return null;
}

/** Normalises a printer/variant class label for case/space-insensitive comparison. */
function normalizeClass(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** True when two build volumes differ on any axis by more than a rounding tolerance. */
function dimsDiffer(a: Dimensions, b: Dimensions): boolean {
  const eps = 0.5; // mm — profiles/config round bed sizes; ignore sub-mm noise
  return Math.abs(a.x - b.x) > eps || Math.abs(a.y - b.y) > eps || Math.abs(a.z - b.z) > eps;
}

/**
 * A bounding box read out of a slice/analysis metadata blob, together with
 * whether its unit is *proven* to be millimetres.
 *
 * The analyzers emit `bbox: { min, max, size }` (STL, 3MF, G-code) alongside a
 * `units` field; earlier readers only understood a bare `size` array or a
 * `{x,y,z}` object, so every analysis-derived box silently came back `null` and
 * no model was ever checked against a build volume. Both shapes are handled here,
 * and the unit is resolved rather than assumed:
 *
 *   - 3MF declares its unit → converted to mm, scale known;
 *   - G-code is machine coordinates → already mm, scale known;
 *   - STL declares nothing → numbers kept, scale **unknown** (never assumed mm).
 */
interface ReadDimensions {
  dimensions: Dimensions;
  scaleKnown: boolean;
}

/** 3MF `unit` values → millimetres per unit (the 3MF core spec set). */
const UNIT_TO_MM: Record<string, number> = {
  micron: 0.001,
  micrometer: 0.001,
  millimeter: 1,
  millimetre: 1,
  mm: 1,
  centimeter: 10,
  centimetre: 10,
  cm: 10,
  meter: 1000,
  metre: 1000,
  m: 1000,
  inch: 25.4,
  in: 25.4,
  foot: 304.8,
  ft: 304.8
};

function readDims(meta: Metadata | null): ReadDimensions | null {
  if (!meta) return null;
  const record = meta as Record<string, unknown>;
  const raw = readRawDims(record);
  if (!raw) return null;

  const declared = typeof record.units === "string" ? record.units.trim().toLowerCase() : null;
  // A slice variant's stored dimensions are produced by the slicer in mm.
  if (declared === null) return { dimensions: raw, scaleKnown: true };
  if (declared === "unknown") return { dimensions: raw, scaleKnown: false };

  const factor = UNIT_TO_MM[declared];
  if (factor === undefined) {
    // A unit we do not know how to convert is not a unit we may guess at.
    return { dimensions: raw, scaleKnown: false };
  }
  return {
    dimensions: { x: raw.x * factor, y: raw.y * factor, z: raw.z * factor },
    scaleKnown: true
  };
}

/** The `{x,y,z}` extent, from any of the shapes the analyzers/slicer produce. */
function readRawDims(record: Record<string, unknown>): Dimensions | null {
  // `bbox: { min, max, size }` — what every built-in analyzer emits.
  const bbox = record.bbox;
  if (bbox && typeof bbox === "object" && !Array.isArray(bbox)) {
    const b = bbox as Record<string, unknown>;
    const fromSize = tripleOf(b.size);
    if (fromSize) return fromSize;
    const min = tripleOf(b.min);
    const max = tripleOf(b.max);
    if (min && max) {
      return { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
    }
  }
  // Bare `size` / `bbox` arrays and a `{x,y,z}` object (slice-variant shapes).
  return tripleOf(record.size) ?? tripleOf(record.bbox) ?? tripleOf(record.dimensions);
}

/** A `[x,y,z]` array or `{x,y,z}` object of finite numbers, else null. */
function tripleOf(value: unknown): Dimensions | null {
  if (Array.isArray(value) && value.length >= 3) {
    const [x, y, z] = value;
    if (isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(z)) return { x, y, z };
    return null;
  }
  if (value && typeof value === "object") {
    const d = value as Record<string, unknown>;
    if (isFiniteNumber(d.x) && isFiniteNumber(d.y) && isFiniteNumber(d.z)) {
      return { x: d.x, y: d.y, z: d.z };
    }
  }
  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
