import { JobError, ValidationError } from "../../core/errors";
import type { QueueJob } from "../../domain/dashboard/types";
import type { EventFeed } from "./eventFeed";
import type { PersistedQueue } from "./stateStore";

export type NewQueueJobInput = {
  title?: unknown;
  printer?: unknown;
  material?: unknown;
  eta?: unknown;
  at?: unknown;
  night?: unknown;
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
      ...(printer ? {} : { reason: "не задан принтер" })
    };

    this.queue.push(job);
    this.events.push("＋", `Задание «${title}» добавлено в очередь`, "info");
    this.persist();
    return { ...job };
  }

  startNext(): QueueJob {
    const next = this.queue.find((job) => job.status === "ready");
    if (!next) {
      throw new JobError("В очереди нет заданий, готовых к запуску");
    }
    // Starting a job requires the print file to be present on the printer;
    // remote upload/start is not implemented, and pretending otherwise would
    // mark queue entries as printing while the device stays idle.
    throw new JobError(
      "Удалённый запуск заданий пока не поддерживается — запустите файл на самом принтере"
    );
  }
}
