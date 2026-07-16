import { ValidationError } from "../core/errors";
import type { QueueJob } from "../domain/dashboard/types";
import { normalizeStartablePath } from "../infra/printers/files";
import type { EventFeed } from "./eventFeed";
import type { PersistedQueue } from "../infra/persistence/stateStore";

export type NewQueueJobInput = {
  title?: unknown;
  printer?: unknown;
  material?: unknown;
  eta?: unknown;
  at?: unknown;
  night?: unknown;
  file?: unknown;
};

/**
 * Operator-created print jobs. Hydrated from persisted state on start (empty on
 * first run — never seeded) and persisted again on every change, so the queue
 * and its id sequence survive a restart.
 */
export class QueueStore {
  private queue: QueueJob[];
  private queueSeq: number;

  constructor(
    private readonly events: EventFeed,
    initial: PersistedQueue = { seq: 0, jobs: [] },
    private readonly persist: () => void = () => {}
  ) {
    this.queue = initial.jobs.map((job) => ({ ...job }));
    this.queueSeq = initial.seq;
  }

  list(): QueueJob[] {
    return this.queue.map((job) => ({ ...job }));
  }

  /** The full durable projection: jobs plus the id sequence. */
  serialize(): PersistedQueue {
    return { seq: this.queueSeq, jobs: this.list() };
  }

  size(): number {
    return this.queue.length;
  }

  add(input: NewQueueJobInput): QueueJob {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) {
      throw new ValidationError("Поле «title» обязательно");
    }

    const printer = typeof input.printer === "string" ? input.printer.trim() : "";
    // The file goes to the printer driver verbatim on start, so it is held to
    // the same rules as the file browser right at the door: relative, no
    // `..`/`.`, printable G-code extension. startPrint re-validates at dispatch
    // (a legacy persisted job may predate this check), but a bad path should
    // fail here, when the operator is looking, not at night when it launches.
    const file =
      typeof input.file === "string" && input.file.trim()
        ? normalizeStartablePath(input.file)
        : "";
    const job: QueueJob = {
      id: `q${++this.queueSeq}`,
      title,
      printer: printer || "—",
      material:
        typeof input.material === "string" && input.material.trim() ? input.material.trim() : "—",
      eta: typeof input.eta === "string" && input.eta.trim() ? input.eta.trim() : "—",
      at: typeof input.at === "string" && input.at.trim() ? input.at.trim() : "в очереди",
      status: printer ? "ready" : "review",
      ...(input.night === true ? { night: true } : {}),
      ...(printer ? {} : { reason: "не задан принтер" }),
      ...(file ? { file } : {})
    };

    this.queue.push(job);
    this.events.push("＋", `Задание «${title}» добавлено в очередь`, "info");
    this.persist();
    return { ...job };
  }

  /** The first job ready to run, or undefined when none are ready. */
  findNextReady(): QueueJob | undefined {
    const next = this.queue.find((job) => job.status === "ready");
    return next ? { ...next } : undefined;
  }

  /** Removes a job by id (used once it has been dispatched to a printer). */
  remove(id: string): void {
    const index = this.queue.findIndex((job) => job.id === id);
    if (index === -1) return;
    this.queue.splice(index, 1);
    this.persist();
  }
}
