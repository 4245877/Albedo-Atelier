import type { Printer } from "../../domain/printers/types";
import { listPrinterRecords } from "./repo";

export async function listPrinters(): Promise<Printer[]> {
  return listPrinterRecords();
}
