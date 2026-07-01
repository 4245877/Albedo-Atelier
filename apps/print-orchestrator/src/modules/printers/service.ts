import { farmStore } from "../../infra/store/farmStore";
import type { PrinterView } from "../../domain/printers/types";

/**
 * Thin application service over {@link farmStore}. Kept as its own layer so the
 * HTTP routes stay declarative and a real datasource/driver can be swapped in
 * behind these functions without touching the routes.
 */

export function listPrinters(): PrinterView[] {
  return farmStore.listPrinters();
}

export function listActivePrinters(): PrinterView[] {
  return farmStore.listActivePrinters();
}

export function getPrinter(id: string): PrinterView {
  return farmStore.getPrinter(id);
}

export function pausePrinter(id: string): PrinterView {
  return farmStore.pausePrinter(id);
}

export function resumePrinter(id: string): PrinterView {
  return farmStore.resumePrinter(id);
}

export function cancelPrinter(id: string): PrinterView {
  return farmStore.cancelPrinter(id);
}

export function setPrinterLight(id: string, on: boolean): PrinterView {
  return farmStore.setLight(id, on);
}

export function capturePrinterSnapshot(id: string): PrinterView {
  return farmStore.snapshotPrinter(id);
}
