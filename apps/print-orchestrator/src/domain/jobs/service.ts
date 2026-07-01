import type { PrintJob } from "./types";

export class JobDomainService {
  canStart(job: PrintJob): boolean {
    return job.state === "queued";
  }
}

export const jobDomainService = new JobDomainService();
