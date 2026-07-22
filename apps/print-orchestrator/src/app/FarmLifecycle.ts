import type { FarmRuntime } from "../bootstrap/createRuntime";
import { env, slicing } from "../shared/env";
import { warnIfPermsTooOpen } from "../shared/filePerms";
import type { StoreLogger } from "../shared/logger";
import { loadPrintersConfig } from "../infra/printers/config";
import { shutdownPrinterConnections } from "../infra/printers/status";

/**
 * Owns the farm's lifecycle — nothing else. It drives, in this exact order:
 *
 *   1. open the queue database and run the one-time legacy import;
 *   2. recover durable state (start guards, canonical runs, slice/preset
 *      catalog) BEFORE any background process is running;
 *   3. load the printer config and start the poll loop;
 *   4. …serve traffic (owned elsewhere)…
 *   5. shut down: stop the poll loop and device connections, stop and drain the
 *      analysis/slice workers, flush the JSON state, and close SQLite LAST.
 *
 * All creation and wiring lives in the composition root ({@link FarmRuntime});
 * this class only sequences that graph's startup and teardown.
 */
export class FarmLifecycle {
  /** In-progress shutdown, so a repeated stop() awaits the same sequence. */
  private stopping: Promise<void> | null = null;

  constructor(private readonly runtime: FarmRuntime) {}

  /** Loads the printer config, recovers durable state, and starts the poll loop. */
  async start(logger: StoreLogger = {}): Promise<void> {
    const runtime = this.runtime;
    runtime.state.useLogger(logger);
    if (runtime.state.loadWarning) {
      logger.warn?.({ warning: runtime.state.loadWarning }, "state store problem");
    }

    // Open the queue database and run the one-time import at startup (with the
    // real logger), rather than lazily on the first API hit.
    runtime.ensureQueue(logger);

    // Reconcile durable start guards left by a previous run: drop those whose
    // job is already gone (nothing to re-dispatch); keep unconfirmed ones so the
    // next start attempt reconciles them against the live device (fail-closed).
    this.sweepStartGuards(logger);

    // Recover pending/unknown dispatches guard-and-run together: a PENDING run
    // whose command provably never left is unwound and re-queued; anything
    // ambiguous is held (never re-dispatched) until reconciled by observation.
    if (runtime.runLifecycle) {
      const recovered = runtime.runLifecycle.recover();
      if (recovered.held + recovered.unwound + recovered.running > 0) {
        logger.info?.(recovered, "canonical run recovery after restart");
      }
    }

    // Probe the OrcaSlicer runtime once so the scheduler can gate un-sliced work
    // synchronously, AND surface its availability at boot. An unconfigured runtime
    // is a common deployment gap — the production image ships the preset catalog but
    // no OrcaSlicer binary — so it is logged loudly here instead of only being
    // discovered later when a slice silently blocks.
    if (runtime.sliceRunner) {
      try {
        const orca = await runtime.sliceRunner.probe();
        runtime.sliceRuntimeAvailable = orca.available;
        if (orca.available) {
          logger.info?.(
            {
              binary: orca.binaryPath,
              version: orca.detectedVersion,
              pinned: orca.pinnedVersion,
              versionMatches: orca.versionMatches,
              networkIsolated: orca.networkIsolated
            },
            "orca slicing runtime available"
          );
        } else {
          logger.warn?.(
            { reason: orca.error, pinned: orca.pinnedVersion },
            "orca slicing runtime UNAVAILABLE — slicing stays blocked until ORCA_SLICER_CMD points at an OrcaSlicer binary or container runtime (see .env.example / config/slicers/orca/README.md); monitoring and dispatch are unaffected"
          );
        }
      } catch (error) {
        runtime.sliceRuntimeAvailable = false;
        logger.warn?.({ err: error }, "orca slicing runtime probe failed — slicing unavailable");
      }
    }

    // Import the OrcaSlicer catalog once, before accepting traffic — best-effort so
    // a missing/broken catalog can never stop the farm from starting.
    if (slicing.autoImport && runtime.presetImportService) {
      try {
        const result = await runtime.presetImportService.import("system");
        // Re-validate any sets carried over from a previous run against the freshly
        // imported revisions, so a set the new catalog invalidated can't linger as
        // approved/valid (mirrors the operator-triggered import path).
        runtime.profileService?.revalidateSets("system");
        logger.info?.(
          { active: result.counts.active, quarantined: result.counts.quarantined, invalid: result.counts.invalid },
          "orca preset catalog imported"
        );
        // Make the "catalog can't form a working set" gap loud, not silent: the
        // shipped catalog quarantines everything that inherits an un-redistributed
        // OrcaSlicer system parent, so slicing has no complete set until those are
        // installed under vendor/ (scripts/install-orca-vendor-profiles.mjs).
        if (result.missingParents.length > 0) {
          logger.warn?.(
            {
              missingParents: result.missingParents,
              active: result.counts.active,
              quarantined: result.counts.quarantined
            },
            "orca catalog is missing inheritance parents — quarantined presets cannot form a working profile set until the vendor/ parents are installed (apps/print-orchestrator: pnpm slicing:vendor:install --orca-resources <dir>; see config/slicers/orca/vendor/README.md)"
          );
        }
      } catch (error) {
        logger.warn?.({ err: error }, "orca preset import on boot failed");
      }
    }

    const { printers, source } = await loadPrintersConfig();
    runtime.setConfig(printers, source);

    // Advisory: the printer config carries device secrets (API keys, access
    // codes). Warn if it is group/world-readable — never fatal (see helper).
    warnIfPermsTooOpen(process.env.PRINTERS_CONFIG_PATH ?? "", logger);

    if (source.warning) {
      logger.warn?.({ warning: source.warning }, "printers config problem");
    }
    logger.info?.(
      { printers: printers.length, source: source.kind },
      "farm store started with real printer config"
    );
    logger.info?.(
      { enabled: runtime.inventory.enabled },
      runtime.inventory.enabled
        ? "fulfillment filament auto-consume enabled"
        : "fulfillment filament auto-consume disabled (set FULFILLMENT_API_URL to enable)"
    );
    // Misconfiguration is loud at startup, not discovered print-by-print: an
    // enabled client with NO inter-service token will be refused (401) by
    // fulfillment once its temporary AUTH_OPTIONAL mode is off. The token value
    // itself is never logged.
    if (runtime.inventory.enabled && !runtime.inventory.hasServiceToken) {
      logger.warn?.(
        {},
        "ATELIER_FULFILLMENT_TOKEN is not set — fulfillment will refuse filament consume/sync with 401 unless its ATELIER_FULFILLMENT_AUTH_OPTIONAL compatibility mode is enabled"
      );
    }

    runtime.deviceCommands.useLogger(logger);
    await runtime.poller.start(logger);
  }

  /**
   * Boot-time reconciliation of durable start guards, now run-aware:
   *
   *  - a guard bound to a canonical run whose run is already terminal (or gone)
   *    protects nothing — dropped;
   *  - a guard bound to a live/unreconciled run is kept together with the run
   *    (fail-closed): the printer stays held until device evidence or the
   *    operator resolves it;
   *  - a legacy `ACKED` guard (no runId) can no longer be re-dispatched by
   *    anything — the legacy JSON queue lost its dispatch path — so it is
   *    dropped; legacy `SENT`/`UNKNOWN` guards are kept (physical outcome
   *    unknown, reconcile against the live device first).
   */
  private sweepStartGuards(logger: StoreLogger): void {
    const store = this.runtime.printQueueStore;
    if (!store) return;
    const guards = store.repositories.startGuards.list();
    if (guards.length === 0) return;
    const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
    for (const guard of guards) {
      if (guard.runId) {
        const run = store.repositories.printRuns.getById(guard.runId);
        if (!run || TERMINAL.has(run.state)) {
          store.repositories.startGuards.delete(guard.printerId);
          continue;
        }
      } else if (guard.state === "ACKED") {
        store.repositories.startGuards.delete(guard.printerId);
        continue;
      }
      logger.warn?.(
        { printer: guard.printerId, state: guard.state, file: guard.file, runId: guard.runId },
        "unconfirmed start guard retained — printer held until reconciled with the live device"
      );
    }
  }

  /**
   * Graceful shutdown in strict order — the database is closed LAST, after
   * every producer of writes has stopped and the in-flight work has settled:
   *
   *  1. stop the poll loop (and await the in-flight poll);
   *  2. close device connections — no new telemetry/dispatch can start;
   *  3. stop the analysis/slice workers accepting new jobs;
   *  4. await the jobs already running, up to a bounded deadline; whatever is
   *     still unfinished is reported explicitly (its `running` rows are
   *     recovered to `pending` on the next boot — nothing is lost silently);
   *  5. flush the JSON state;
   *  6. only then close SQLite.
   *
   * Idempotent: a second call (double signal, test teardown after a signal)
   * awaits the same shutdown instead of racing a second one into a closed DB.
   */
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      const runtime = this.runtime;
      // 1–2. No new polls, no device connections.
      await runtime.poller.stop();
      shutdownPrinterConnections();

      // 3. Workers stop accepting new jobs (queued-but-not-started are dropped;
      // they live as pending rows in SQLite and are re-queued on next boot).
      runtime.artifactService?.close();
      runtime.sliceService?.close();

      // 4. Bounded drain of the jobs already executing, so their final writes
      // land BEFORE the database closes ("database is not open" can no longer
      // happen on the normal path).
      const drains: Promise<void>[] = [];
      if (runtime.artifactService) drains.push(runtime.artifactService.whenIdle());
      if (runtime.sliceService) drains.push(runtime.sliceService.whenIdle());
      if (drains.length > 0) {
        const drained = await Promise.race([
          Promise.all(drains).then(() => true),
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), env.shutdownDrainTimeoutMs).unref?.()
          )
        ]);
        if (!drained) {
          // Forced shutdown: report exactly what is being abandoned.
          const unfinished = runtime.printQueueStore?.repositories.artifactAnalyses
            .listUnfinished()
            .map((a) => a.id);
          // eslint-disable-next-line no-console
          console.error(
            JSON.stringify({
              msg: "shutdown drain deadline hit — unfinished work will be recovered on next boot",
              unfinishedAnalyses: unfinished ?? []
            })
          );
        }
      }

      // 5. Persist the tail of accrued printing-hours and settle every write.
      runtime.state.save();
      await runtime.state.flush();

      // 6. Close the queue database last, and drop every service reference.
      runtime.disposeQueue();
    })();
    return this.stopping;
  }

  /** Awaits all pending state writes (used on shutdown and in tests). */
  flush(): Promise<void> {
    return this.runtime.state.flush();
  }

  pollOnce(): Promise<void> {
    return this.runtime.poller.pollOnce();
  }
}
