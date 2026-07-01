import type { PrintJob } from "../jobs/types";

export function sortQueue(jobs: PrintJob[]): PrintJob[] {
  return [...jobs].sort((left, right) => right.priority - left.priority);
}
