import { JobError, ValidationError } from "../../core/errors";
import type { QueueJob } from "../../domain/dashboard/types";
import type { EventFeed } from "./eventFeed";

export type NewQueueJobInput = {
  title?: unknown;
  printer?: unknown;
  material?: unknown;
  eta?: unknown;
  at?: unknown;
  night?: unknown;
};

/** Operator-created print jobs, held in memory (starts empty — never seeded). */
export class QueueStore {
  private queue: QueueJob[] = [];
  private queueSeq = 0;

  constructor(private readonly events: EventFeed) {}

  list(): QueueJob[] {
    return this.queue.map((job) => ({ ...job }));
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
