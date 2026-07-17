/**
 * The slicing domain model: OrcaSlicer profiles, vetted profile sets, and slice
 * jobs. It sits alongside the print-queue model (`domain/print`) and reuses its
 * primitives — {@link IsoTimestamp}, {@link Metadata}, {@link AnalysisFinding} —
 * rather than inventing parallel ones. Like the rest of the domain these are
 * plain data records: no behaviour, no SQLite. The transition rules live in
 * {@link file://./states.ts}, the storage ports in {@link file://./repositories.ts}.
 *
 * The chain a source model travels is
 *
 *   Artifact (STL/3MF) + ProfileSet → SliceVariant → OrcaSlicer → output Artifact
 *
 * with every profile pinned to an immutable {@link ProfileRevision} so a slice is
 * reproducible and auditable: the exact bytes that fed OrcaSlicer are recoverable
 * from the revisions and the source artifact's content hash.
 */

import type { AnalysisFinding, IsoTimestamp, Metadata } from "../print/types";

// ── ProfileRevision ──────────────────────────────────────────────────────────

/** The three OrcaSlicer profile kinds we model (Orca's `printer` folder = `machine`). */
export type ProfileType = "machine" | "process" | "filament";

/**
 * A revision's disposition:
 *   - `active` — inheritance resolves fully and no blocker-level problem was found;
 *     usable in a profile set.
 *   - `quarantined` — a blocker was found (missing/cyclic/wrong-type parent, or a
 *     self-contradiction like nozzle vs printer_variant). **Never** activated, and
 *     a profile set may not reference it. Kept so the operator can see *why*.
 *   - `invalid` — not a usable profile at all (unparseable, not an object, no name,
 *     unknown type).
 */
export type ProfileRevisionStatus = "active" | "quarantined" | "invalid";

/**
 * One immutable revision of a logical machine/process/filament profile.
 *
 * "Immutable" is literal: a revision is keyed by the SHA-256 of its raw bytes, so
 * re-importing the same file is a no-op and editing a profile produces a *new*
 * revision rather than mutating an old one. `resolvedJson` is the fully
 * inheritance-merged settings (null while the inheritance is unresolved), and its
 * hash lets a slice's {@link SliceVariant.cacheKey cache key} pin the exact
 * resolved inputs.
 */
export interface ProfileRevision {
  id: string;
  /** Stable logical identity `"<type>:<orca name>"`; revisions of one profile share it. */
  logicalId: string;
  type: ProfileType;
  /** The OrcaSlicer `name` (may contain spaces / non-ASCII); the display identity. */
  name: string;
  /** Parent profile `name` this inherits from; null for a root profile. */
  inherits: string | null;
  status: ProfileRevisionStatus;
  /** The exact profile JSON as text (byte-preserving); the immutability anchor. */
  rawJson: string;
  rawSha256: string;
  /** Inheritance-merged settings as text; null when the chain could not be resolved. */
  resolvedJson: string | null;
  resolvedSha256: string | null;
  /** The OrcaSlicer version the source bundle declared; null when unknown. */
  orcaVersion: string | null;
  /** The catalog source archive id this revision was imported from. */
  source: string | null;
  /** Non-blocking issues (uninformative name, intended-nozzle hint, …). */
  warnings: AnalysisFinding[];
  /** Blocker issues that forced quarantine (missing parent, cycle, mismatch, …). */
  blockers: AnalysisFinding[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  version: number;
  metadata: Metadata;
}

// ── ProfileSet ───────────────────────────────────────────────────────────────

/**
 * The automatic compatibility verdict for a set:
 *   - `valid` — the three profiles are compatible with each other and the target;
 *   - `warnings` — compatible but with non-blocking concerns;
 *   - `blocked` — at least one blocker; approval is refused.
 */
export type ProfileSetValidation = "valid" | "warnings" | "blocked";

/**
 * A vetted `(machine, process, filament)` combination bound to a compatible
 * printer (or printer class). The three profiles are pinned to specific
 * {@link ProfileRevision revisions}, so a set does not silently change meaning
 * when a profile is re-imported. `approved` is the deliberate operator gate: a set
 * with a `blocked` validation can never be approved (enforced by the service).
 */
export interface ProfileSet {
  id: string;
  name: string;
  machineRevisionId: string;
  processRevisionId: string;
  filamentRevisionId: string;
  /** Compatible farm printer id (config/printers.json); null when class-scoped. */
  printerId: string | null;
  /** Compatible printer class label; null when a concrete printer is named. */
  printerClass: string | null;
  validation: ProfileSetValidation;
  approved: boolean;
  approvedBy: string | null;
  approvedAt: IsoTimestamp | null;
  warnings: AnalysisFinding[];
  blockers: AnalysisFinding[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  version: number;
  metadata: Metadata;
}

// ── SliceVariant ─────────────────────────────────────────────────────────────

/**
 * A slice job's state (deliberately mirroring {@link ArtifactAnalysisState}'s
 * shape): `pending` queued, `running` a worker holds it, terminal `ready`
 * (an output artifact was produced) / `failed` (the slicer errored/timed out) /
 * `blocked` (refused before running — no runtime, un-approved set, un-sliceable
 * source). A `pending`/`running` row orphaned by a crash is recovered on boot.
 */
export type SliceVariantState = "pending" | "running" | "ready" | "failed" | "blocked";

/**
 * One preparation of a source model into a printable file with a chosen profile
 * set. Holds the reproducibility key ({@link SliceVariant.cacheKey}) and — only
 * when OrcaSlicer actually produced them — the estimates: OrcaSlicer's own ETA is
 * stored verbatim in {@link SliceVariant.orcaEtaS} and is **never** relabelled as a
 * P50/P90 or fed into a synthetic percentile. Nothing here is fabricated when the
 * slicer is unavailable — the variant goes `blocked` with an honest reason instead.
 */
export interface SliceVariant {
  id: string;
  /** The source print task (its state is untouched by slicing). */
  taskId: string;
  /** The source model artifact (STL / generic 3MF). */
  sourceArtifactId: string;
  profileSetId: string;
  /** Target printer id, or null when only a class is targeted. */
  targetPrinterId: string | null;
  targetPrinterClass: string | null;
  state: SliceVariantState;
  /** source sha + resolved profile hashes + orca version + worker version (dedup key). */
  cacheKey: string;
  orcaVersion: string | null;
  workerVersion: string | null;
  /** The produced printable artifact (G-code / sliced 3MF); null until `ready`. */
  outputArtifactId: string | null;
  /** The analysis of the output artifact (re-run through the existing analyzer). */
  outputAnalysisId: string | null;
  /** OrcaSlicer's own predicted print time, in seconds — stored as-is, not a percentile. */
  orcaEtaS: number | null;
  /** Filament mass OrcaSlicer reported for this slice (grams); null when unknown. */
  filamentG: number | null;
  /** Filament length OrcaSlicer reported (millimetres); null when unknown. */
  filamentMm: number | null;
  /** Model/print dimensions OrcaSlicer reported (bbox, plate, …); null when unknown. */
  dimensions: Metadata | null;
  warnings: AnalysisFinding[];
  blockers: AnalysisFinding[];
  /** Failure/blocked detail when `state` is `failed`/`blocked`. */
  error: string | null;
  startedAt: IsoTimestamp | null;
  endedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  version: number;
  metadata: Metadata;
}
