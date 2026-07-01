import type { PrintJob } from "../../domain/jobs/types";
import { sortQueue } from "../../domain/queue/service";

export async function listQueue(jobs: PrintJob[] = []): Promise<PrintJob[]> {
  return sortQueue(jobs);
}
