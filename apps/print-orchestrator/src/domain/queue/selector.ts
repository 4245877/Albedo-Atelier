import type { PrinterView } from "../printers/types";
import type { PrintJob } from "../jobs/types";

export function selectPrinterForJob(
  printers: PrinterView[],
  _job: PrintJob
): PrinterView | undefined {
  return printers.find((printer) => printer.status === "idle");
}
