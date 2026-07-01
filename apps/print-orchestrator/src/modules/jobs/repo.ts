import type { PrintJob } from "../../domain/jobs/types";

const jobs: PrintJob[] = [];

export async function listJobRecords(): Promise<PrintJob[]> {
  return [...jobs];
}
