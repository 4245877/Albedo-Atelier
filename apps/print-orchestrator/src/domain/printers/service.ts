import type { PrinterView } from "./types";

export class PrinterDomainService {
  isAvailable(printer: PrinterView): boolean {
    return printer.status === "idle";
  }
}

export const printerDomainService = new PrinterDomainService();
