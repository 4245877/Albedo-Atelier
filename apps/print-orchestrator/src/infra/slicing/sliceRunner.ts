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

/** The result of probing for a usable OrcaSlicer runtime. */
export interface OrcaRuntimeStatus {
  /** True only when a binary was found *and* (if pinned) it is the pinned version. */
  available: boolean;
  binaryPath: string | null;
  detectedVersion: string | null;
  /** The version the deployment pinned; null when unpinned. */
  pinnedVersion: string | null;
  /** Whether detected === pinned; null when unavailable or unpinned. */
  versionMatches: boolean | null;
  /** Whether the runner runs the slicer with the network disabled (container mode). */
  networkIsolated: boolean;
  /** A human diagnostic when unavailable/mismatched; null when all good. */
  error: string | null;
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
  /** Detects a usable runtime without slicing anything. */
  probe(): Promise<OrcaRuntimeStatus>;
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
