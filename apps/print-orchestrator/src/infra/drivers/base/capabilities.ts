import type { PrintJob } from "../../../domain/jobs/types";
import type { Printer, PrinterState } from "../../../domain/printers/types";
import type { DriverConnectionConfig, PrinterDriver } from "./PrinterDriver";

class UnavailablePrinterDriver implements PrinterDriver {
  constructor(
    public readonly name: string,
    private readonly _config: DriverConnectionConfig
  ) {}

  async connect(): Promise<void> {
    return undefined;
  }

  async disconnect(): Promise<void> {
    return undefined;
  }

  async getState(_printer: Printer): Promise<PrinterState> {
    return "offline";
  }

  async startJob(_printer: Printer, _job: PrintJob): Promise<void> {
    throw new Error(`${this.name} driver is not implemented yet`);
  }

  async pauseJob(_printer: Printer, _job: PrintJob): Promise<void> {
    throw new Error(`${this.name} driver is not implemented yet`);
  }

  async cancelJob(_printer: Printer, _job: PrintJob): Promise<void> {
    throw new Error(`${this.name} driver is not implemented yet`);
  }
}

export function createUnavailableDriver(name: string, config: DriverConnectionConfig): PrinterDriver {
  return new UnavailablePrinterDriver(name, config);
}
