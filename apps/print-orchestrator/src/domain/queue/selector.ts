import type { Printer } from "../printers/types";
import type { PrintJob } from "../jobs/types";

export function selectPrinterForJob(printers: Printer[], _job: PrintJob): Printer | undefined {
  return printers.find((printer) => printer.state === "idle");
}
