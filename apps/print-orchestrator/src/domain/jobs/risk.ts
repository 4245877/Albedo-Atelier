import type { PrintJob } from "./types";

export type JobRiskLevel = "low" | "medium" | "high";

export function assessJobRisk(job: PrintJob): JobRiskLevel {
  return job.priority >= 100 ? "high" : "low";
}
