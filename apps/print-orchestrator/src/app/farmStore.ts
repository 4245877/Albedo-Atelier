import { createRuntime, type FarmRuntime, type PrintServices } from "../bootstrap/createRuntime";
import type { QueueJob, NightCandidate } from "../domain/dashboard/types";
import type { StoreLogger } from "../shared/logger";
import { FarmCommands, type NewQueueJobInput } from "./FarmCommands";
import { FarmLifecycle } from "./FarmLifecycle";

export type { NewQueueJobInput } from "./FarmCommands";
export type { PrintServices } from "../bootstrap/createRuntime";

/**
 * A thin compatibility facade over the three collaborators the farm was split
 * into: the composition root ({@link FarmRuntime}, which creates and wires all
 * infrastructure + services), the {@link FarmLifecycle} (start / recovery /
 * shutdown) and the {@link FarmCommands} (every state-changing operation). Pure
 * reads are served by the runtime's read model via {@link FarmStore.reads}.
 *
 * It owns no infrastructure, runs no orchestration and builds no read models of
 * its own — every member below just forwards to one of those collaborators. It
 * exists so the module singleton, the observability collectors and the existing
 * test suites keep a stable entry point while the internals stay decomposed; new
 * code should depend on the narrow {@link FarmRuntime} collaborators directly.
 */
export class FarmStore implements PrintServices {
  private readonly runtime: FarmRuntime;
  private readonly lifecycle: FarmLifecycle;
  /** Every state-changing operation of the farm (printer/queue/night/files). */
  readonly commands: FarmCommands;

  constructor(stateFilePath?: string, snapshotsDir?: string, dbPath?: string) {
    this.runtime = createRuntime({ stateFilePath, snapshotsDir, dbPath });
    this.lifecycle = new FarmLifecycle(this.runtime);
    this.commands = new FarmCommands(this.runtime);
  }

  // ── Read model + lazy service accessors (delegated to the runtime) ─────────

  /** Read-only projections of the live farm state (dashboard/API reads). */
  get reads() {
    return this.runtime.reads;
  }
  /** The persistent print-queue service (SQLite), opened on first access. */
  get printQueue() {
    return this.runtime.printQueue;
  }
  /** The upload/analysis service (SQLite + content-addressed blobs), lazy. */
  get artifacts() {
    return this.runtime.artifacts;
  }
  /** The OrcaSlicer preset/profile/slice services (SQLite-backed), lazy. */
  get slicing() {
    return this.runtime.slicing;
  }
  /** The manual-scheduler service, built per access over the live telemetry. */
  get scheduler() {
    return this.runtime.scheduler;
  }

  // ── Lifecycle (delegated to FarmLifecycle) ─────────────────────────────────

  start(logger: StoreLogger = {}): Promise<void> {
    return this.lifecycle.start(logger);
  }
  stop(): Promise<void> {
    return this.lifecycle.stop();
  }
  flush(): Promise<void> {
    return this.lifecycle.flush();
  }
  pollOnce(): Promise<void> {
    return this.lifecycle.pollOnce();
  }

  // ── Commands (delegated to FarmCommands; the operations tests drive) ───────

  addQueueJob(input: NewQueueJobInput): QueueJob {
    return this.commands.addQueueJob(input);
  }
  removeQueueJob(id: string): QueueJob {
    return this.commands.removeQueueJob(id);
  }
  reviewQueueJob(id: string, reason?: string): QueueJob {
    return this.commands.reviewQueueJob(id, reason);
  }
  startNext(): Promise<{ job: QueueJob; printer: string; runId: string }> {
    return this.commands.startNext();
  }
  startNight(preview: {
    taskId?: string;
    expectedTaskVersion?: number;
    artifactSha256?: string | null;
  } = {}): Promise<{ candidate: NightCandidate; window: string; runId: string }> {
    return this.commands.startNight(preview);
  }
}

export const farmStore = new FarmStore();
