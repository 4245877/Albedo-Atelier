import type { Printer } from "../../domain/printers/types";

const printers: Printer[] = [];

export async function listPrinterRecords(): Promise<Printer[]> {
  return [...printers];
}
