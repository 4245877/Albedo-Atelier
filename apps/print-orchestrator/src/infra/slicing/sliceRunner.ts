/**
 * The slicing-runtime port. `SliceService` depends only on this interface, so the
 * real {@link OrcaCliRunner} (which spawns the pinned OrcaSlicer binary) and the
 * in-process fake used by tests are interchangeable. The service never spawns a
 * process or knows a CLI flag itself.
 *
 * The contract is deliberately honest about absence: {@link SliceRunner.probe}
 * reports whether a usable runtime exists (and whether it is the *pinned* version),
 * and {@link SliceRunner.slice} throws {@link SliceRuntimeUnavailableError} rather
 * than inventing an output when the runtime is missing — the service turns that
 * into a `blocked` variant with a clear reason, never a fake slice/ETA/file.
 */

/**
 * Why the runtime is (un)usable — one machine-readable reason per failure mode, so
 * the UI can say something better than "OrcaSlicer недоступен" and an operator knows
 * which of the very different repairs applies.
 *
 * Ordered roughly by the stage that detects it: configuration → the file on disk →
 * the process → its CLI → its resources → real slicing.
 */
export type OrcaRuntimeState =
  /** `ORCA_SLICER_CMD` is unset — the farm runs without slicing, honestly. */
  | "not_configured"
  /** The configured path does not exist (bad deploy, unmounted volume, stale symlink). */
  | "executable_missing"
  /** The file exists but is empty / not executable — a truncated or aborted install. */
  | "executable_corrupted"
  /** The binary cannot start: missing shared libraries (a lean image without the GTK stack). */
  | "runtime_dependency_missing"
  /** It runs, but is not an OrcaSlicer CLI, or lacks the flags this worker drives it with. */
  | "cli_incompatible"
  /** No `resources/profiles` tree beside the binary — inheritance parents unavailable. */
  | "resources_missing"
  /** Binary and resources/pin disagree about the OrcaSlicer release. */
  | "version_mismatch"
  /** Everything looks right, but a real slice of the smoke fixture did not produce G-code. */
  | "smoke_failed"
  /** Verified: this binary really turns settings + a model into G-code. */
  | "ready";

/** The outcome of the smoke slice — a real slice of a tiny fixture, not a flag check. */
export interface OrcaSmokeResult {
  ok: boolean;
  /** The OrcaSlicer release taken from the produced G-code header (authoritative). */
  releaseVersion: string | null;
  /** Bytes of G-code produced (0 when the slice failed). */
  gcodeBytes: number;
  durationMs: number;
  /** Technical failure detail; null on success. */
  error: string | null;
  checkedAt: string;
}

/** The result of probing for a usable OrcaSlicer runtime. */
export interface OrcaRuntimeStatus {
  /** True only when the runtime is verified usable — see {@link OrcaRuntimeStatus.state}. */
  available: boolean;
  /** The machine-readable reason behind `available`. */
  state: OrcaRuntimeState;
  binaryPath: string | null;
  /**
   * The OrcaSlicer **release** (e.g. `2.3.0`) — from the smoke slice's G-code header
   * when one has run, else inferred from the resources tree. Deliberately *not* the
   * CLI banner: that prints {@link OrcaRuntimeStatus.cliBuild} instead.
   */
  detectedVersion: string | null;
  /**
   * The CLI banner's build id (e.g. `01.10.01.50`). This is OrcaSlicer's inherited
   * BambuStudio `SLIC3R_VERSION`, which stays on the 1.10.x lineage in every 2.x
   * release — it is NOT the release number and must never be compared to the pin.
   */
  cliBuild: string | null;
  /** The release the `resources/profiles` tree belongs to (e.g. `2.3.0`), when readable. */
  resourcesVersion: string | null;
  /** The version the deployment pinned; null when unpinned. */
  pinnedVersion: string | null;
  /** Whether detected === pinned; null when unavailable or unpinned. */
  versionMatches: boolean | null;
  /** Whether the runner runs the slicer with the network disabled (container mode). */
  networkIsolated: boolean;
  /** A short, operator-facing diagnostic when unusable; null when all good. */
  error: string | null;
  /** The full technical detail (CLI stderr, paths) — for admins/logs, not end users. */
  detail: string | null;
  /** The last real slice check, when one has run in this process. */
  smoke: OrcaSmokeResult | null;
  /** The slicing worker's own version (part of the cache key). */
  workerVersion: string;
}

export interface SliceRequest {
  /** Absolute path to the source model (STL / generic 3MF). */
  modelPath: string;
  /** Absolute paths to the resolved profile JSONs written for this slice. */
  machineJsonPath: string;
  processJsonPath: string;
  filamentJsonPath: string;
  /** Absolute path the runner must leave the finished sliced file at on success. */
  outputPath: string;
  /** An isolated, already-created working directory for this slice. */
  workDir: string;
}

export interface SliceRunOutput {
  /** Where the sliced file ended up (equal to {@link SliceRequest.outputPath}). */
  outputPath: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

/** Per-call slice options. `probed` lets the caller supply an availability check it
 *  already ran, so the runner need not re-probe (spawn a second `--version`) for the
 *  same operation; when omitted the runner probes itself, keeping its guarantee. */
export interface SliceRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  probed?: OrcaRuntimeStatus;
}

export interface SliceRunner {
  /** The worker version, mixed into a variant's cache key. */
  readonly workerVersion: string;
  /** The pinned OrcaSlicer version, or null when unpinned/unknown. */
  readonly pinnedVersion: string | null;
  /**
   * Reports whether the runtime is usable. Cheap and side-effect free: it inspects
   * the binary, its CLI and its resources, and folds in the last
   * {@link SliceRunner.verifySlicing} result when one exists — it never slices.
   */
  probe(): Promise<OrcaRuntimeStatus>;
  /**
   * Proves the runtime by really slicing a tiny fixture into G-code, and caches the
   * outcome for subsequent {@link SliceRunner.probe} calls. This is what makes
   * "доступен" mean *can slice* rather than *answered a flag*. Cheap enough (~1 s)
   * to run at boot; `force` re-runs an already-cached check.
   */
  verifySlicing(options?: { force?: boolean; signal?: AbortSignal }): Promise<OrcaRuntimeStatus>;
  /** Slices one model, or throws one of the errors below. */
  slice(req: SliceRequest, options?: SliceRunOptions): Promise<SliceRunOutput>;
}

/** No usable OrcaSlicer runtime — the honest "cannot slice" signal (→ `blocked`). */
export class SliceRuntimeUnavailableError extends Error {
  readonly code = "runtime_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "SliceRuntimeUnavailableError";
  }
}

/** The slicer exceeded its wall-clock budget and was killed (→ `failed`). */
export class SliceTimeoutError extends Error {
  readonly code = "timeout";
  constructor(message: string) {
    super(message);
    this.name = "SliceTimeoutError";
  }
}

/** The slicer ran but exited non-zero or produced no output (→ `failed`). */
export class SliceProcessError extends Error {
  readonly code = "slice_failed";
  constructor(message: string) {
    super(message);
    this.name = "SliceProcessError";
  }
}
