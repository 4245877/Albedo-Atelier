import path from "node:path";

import { readArgs, readBoolean, readPositiveInt } from "./readers";
import { envVar, type EnvSource } from "./registry";

const VARS = {
  /** The vendored catalog root (`config/slicers/orca`); ships in the image. */
  catalogDir: envVar("ORCA_CATALOG_DIR", "slicing", (_n, raw) => raw || null),
  /**
   * OrcaSlicer's own system-profile tree (`resources/profiles`) — the inheritance
   * parents user presets are built on. Defaults to the tree next to the configured
   * slicer binary, so a deployment that mounts a runtime resolves against the very
   * profiles that runtime ships. Empty string disables the runtime source (only
   * `vendor/` is used).
   */
  systemProfilesDir: envVar("ORCA_SYSTEM_PROFILES_DIR", "slicing", (_n, raw) =>
    raw === undefined ? null : raw.trim()
  ),
  /** Executable to spawn (OrcaSlicer, or a container runtime); null → runtime unavailable. */
  command: envVar("ORCA_SLICER_CMD", "slicing", (_n, raw) => raw?.trim() || null),
  /** Args prepended before the slice args (container `run … <image> orca-slicer`). */
  baseArgs: envVar("ORCA_SLICER_BASE_ARGS", "slicing", (_n, raw) => readArgs(raw)),
  /** Extra args appended before the model path (advanced tuning). */
  extraArgs: envVar("ORCA_SLICER_EXTRA_ARGS", "slicing", (_n, raw) => readArgs(raw)),
  /** The pinned OrcaSlicer version (the bundles were exported from 2.3.0). */
  pinnedVersion: envVar("ORCA_SLICER_VERSION", "slicing", (_n, raw) => raw?.trim() || "2.3.0"),
  /** True when the slicer runs with the network disabled (container mode). */
  networkIsolated: envVar("ORCA_SLICER_NETWORK_ISOLATED", "slicing", (n, raw) =>
    readBoolean(n, raw, false)
  ),
  /** Per-slice wall-clock budget (ms) before the process is killed. */
  timeoutMs: envVar("ORCA_SLICE_TIMEOUT_MS", "slicing", (n, raw) => readPositiveInt(n, raw, 600000)),
  /** How many slices may run at once (slicing is heavy — default 1). */
  concurrency: envVar("ORCA_SLICE_CONCURRENCY", "slicing", (n, raw) => readPositiveInt(n, raw, 1)),
  /** Base directory each slice gets an isolated work dir under (on the data volume). */
  tmpRoot: envVar("ORCA_SLICE_TMP_DIR", "slicing", (_n, raw) => raw || null),
  /** Import the catalog into the DB on first boot (idempotent). */
  autoImport: envVar("ORCA_AUTO_IMPORT", "slicing", (n, raw) => readBoolean(n, raw, true))
};

/**
 * OrcaSlicer preset-catalog + slicing-runtime configuration.
 *
 * `command` is the executable the slicing worker spawns; when unset there is **no**
 * runtime and every slice is honestly `blocked` (nothing is faked). For network
 * isolation, set `command` to a container runtime and `baseArgs` to its
 * `run --rm --network none …` flags, and flag `networkIsolated`. The pinned version
 * defaults to the OrcaSlicer release the vendored bundles came from; the worker
 * version is bumped in code when the slice logic changes (both feed the cache key).
 */
export function buildSlicingConfig(source: EnvSource, stateDir: string) {
  const command = VARS.command.read(source);
  const systemProfilesDir = VARS.systemProfilesDir.read(source);
  return {
    catalogDir:
      VARS.catalogDir.read(source) ?? path.resolve(process.cwd(), "config", "slicers", "orca"),
    /**
     * Where the OrcaSlicer *system* parents live. Unset → derived from the slicer
     * binary's own directory; explicitly empty → disabled (`vendor/` only).
     */
    systemProfilesDir:
      systemProfilesDir === null ? defaultSystemProfilesDir(command) : systemProfilesDir || null,
    command,
    baseArgs: VARS.baseArgs.read(source),
    extraArgs: VARS.extraArgs.read(source),
    pinnedVersion: VARS.pinnedVersion.read(source),
    /** The slice worker's own version — bump when the slice logic changes (cache key input). */
    workerVersion: "orca-slice-1",
    networkIsolated: VARS.networkIsolated.read(source),
    timeoutMs: VARS.timeoutMs.read(source),
    concurrency: VARS.concurrency.read(source),
    tmpRoot: VARS.tmpRoot.read(source) ?? path.resolve(stateDir, "slice-tmp"),
    autoImport: VARS.autoImport.read(source)
  };
}

/**
 * The OrcaSlicer profile tree that sits next to a slicer *binary* — `/opt/orca/AppRun`
 * → `/opt/orca/resources/profiles`. Returns null when the command is not a path (a
 * container runtime like `docker`, whose profiles are inside the image, or no
 * runtime at all); a path that does not exist simply contributes no profiles.
 */
function defaultSystemProfilesDir(command: string | null): string | null {
  if (!command || !command.includes(path.sep)) return null;
  return path.resolve(path.dirname(command), "resources", "profiles");
}
