import type { PrintJob } from "../../../domain/jobs/types";
import type { Printer, PrinterState } from "../../../domain/printers/types";

export interface DriverConnectionConfig {
  endpoint?: string;
  token?: string;
  [key: string]: unknown;
}

export interface PrinterDriver {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getState(printer: Printer): Promise<PrinterState>;
  startJob(printer: Printer, job: PrintJob): Promise<void>;
  pauseJob(printer: Printer, job: PrintJob): Promise<void>;
  cancelJob(printer: Printer, job: PrintJob): Promise<void>;
}
