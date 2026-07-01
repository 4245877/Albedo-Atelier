import type { PrintJob } from "../../../domain/jobs/types";
import type { PrinterState, PrinterView } from "../../../domain/printers/types";

export interface DriverConnectionConfig {
  endpoint?: string;
  token?: string;
  [key: string]: unknown;
}

export interface PrinterDriver {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getState(printer: PrinterView): Promise<PrinterState>;
  startJob(printer: PrinterView, job: PrintJob): Promise<void>;
  pauseJob(printer: PrinterView, job: PrintJob): Promise<void>;
  cancelJob(printer: PrinterView, job: PrintJob): Promise<void>;
}
