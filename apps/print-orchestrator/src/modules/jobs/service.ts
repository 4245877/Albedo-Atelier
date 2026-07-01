import type { PrintJob } from "../../domain/jobs/types";
import { listJobRecords } from "./repo";

export async function listJobs(): Promise<PrintJob[]> {
  return listJobRecords();
}
