import path from "node:path";

import { readArgs, readBoolean, readPositiveInt } from "./readers";
import { envVar, type EnvSource } from "./registry";

const VARS = {
  /** The vendored catalog root (`config/slicers/orca`); ships in the image. */
  catalogDir: envVar("ORCA_CATALOG_DIR", "slicing", (_n, raw) => raw || null),
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
  return {
    catalogDir:
      VARS.catalogDir.read(source) ?? path.resolve(process.cwd(), "config", "slicers", "orca"),
    command: VARS.command.read(source),
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
