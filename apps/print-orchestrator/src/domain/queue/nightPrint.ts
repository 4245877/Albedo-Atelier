import type { PrintJob } from "../jobs/types";

export function isNightPrintCandidate(job: PrintJob): boolean {
  return job.priority < 50;
}
