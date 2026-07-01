export type PrintJobState = "draft" | "queued" | "printing" | "paused" | "completed" | "failed" | "canceled";

export interface PrintJob {
  id: string;
  printerId?: string;
  fileId?: string;
  materialId?: string;
  state: PrintJobState;
  priority: number;
  createdAt: string;
  updatedAt: string;
}
