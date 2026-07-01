import type { Printer } from "./types";

export class PrinterDomainService {
  isAvailable(printer: Printer): boolean {
    return printer.state === "idle";
  }
}

export const printerDomainService = new PrinterDomainService();
