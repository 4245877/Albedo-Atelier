import path from "node:path";

import { readInteger, readNonNegativeInt } from "./readers";
import { envVar, type EnvSource } from "./registry";

const VARS = {
  /**
   * JSON file the operator queue, event feed and today counters are persisted
   * to, so they survive a restart. Defaults to `<cwd>/data/state.json`; in the
   * container `<cwd>` is `/app`, and compose mounts a volume at `/app/data`.
   */
  stateFilePath: envVar("STATE_FILE_PATH", "state", (_n, raw) => raw || null),
  /**
   * SQLite database backing the persistent print-queue model (tasks, assignments,
   * the print-run chain, audit log). Kept next to the state file so the same
   * mounted `/app/data` volume holds both; defaults to `<state dir>/queue.db`.
   */
  queueDbPath: envVar("QUEUE_DB_PATH", "state", (_n, raw) => raw || null),
  /**
   * Directory the saved camera snapshots (JPEG/PNG files) are written to, kept
   * next to the state file so the same mounted volume holds both. The durable
   * JSON state stores only the per-snapshot metadata; the image bytes live here
   * as files. Defaults to `<state dir>/snapshots`.
   */
  snapshotsDir: envVar("SNAPSHOTS_DIR", "state", (_n, raw) => raw || null),
  /**
   * How many saved snapshots to keep per printer. Older ones (metadata and the
   * file on disk) are pruned after each new capture so the volume cannot grow
   * without bound. Must be at least 1.
   */
  snapshotRetainPerPrinter: envVar("SNAPSHOT_RETAIN_PER_PRINTER", "state", (n, raw) =>
    Math.max(1, readInteger(n, raw, 30))
  ),
  /**
   * How long to wait after switching a chamber light on for a night snapshot
   * before grabbing the frame, so the camera exposes a lit scene rather than a
   * dark one. Only applies when a light-ensured capture actually flipped the
   * light (see FarmStore.getCameraFrame / ensureLight).
   */
  snapshotLightSettleMs: envVar("SNAPSHOT_LIGHT_SETTLE_MS", "state", (n, raw) =>
    readNonNegativeInt(n, raw, 1200)
  )
};

/** Durable-state locations (JSON state, SQLite, snapshots) and their knobs. */
export function buildStateConfig(source: EnvSource) {
  const stateFilePath =
    VARS.stateFilePath.read(source) ?? path.resolve(process.cwd(), "data", "state.json");
  const stateDir = path.dirname(stateFilePath);
  return {
    stateFilePath,
    /** SQLite database file for the persistent print-queue model (see above). */
    queueDbPath: VARS.queueDbPath.read(source) ?? path.resolve(stateDir, "queue.db"),
    snapshotsDir: VARS.snapshotsDir.read(source) ?? path.resolve(stateDir, "snapshots"),
    snapshotRetainPerPrinter: VARS.snapshotRetainPerPrinter.read(source),
    snapshotLightSettleMs: VARS.snapshotLightSettleMs.read(source)
  };
}
