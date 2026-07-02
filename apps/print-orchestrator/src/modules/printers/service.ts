import { farmStore } from "../../infra/store/farmStore";
import type { CameraFrame } from "../../infra/printers/snapshot";
import type { PrinterView } from "../../domain/printers/types";

/**
 * Thin application service over {@link farmStore}. Kept as its own layer so the
 * HTTP routes stay declarative. Reads are served from the store's live poll
 * cache; actions dispatch real commands to the printer drivers.
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

export function pausePrinter(id: string): Promise<PrinterView> {
  return farmStore.pausePrinter(id);
}

export function resumePrinter(id: string): Promise<PrinterView> {
  return farmStore.resumePrinter(id);
}

export function cancelPrinter(id: string): Promise<PrinterView> {
  return farmStore.cancelPrinter(id);
}

export function setPrinterLight(id: string, on: boolean): Promise<PrinterView> {
  return farmStore.setLight(id, on);
}

export function capturePrinterSnapshot(id: string): Promise<PrinterView> {
  return farmStore.snapshotPrinter(id);
}

export function getPrinterCameraFrame(id: string): Promise<CameraFrame> {
  return farmStore.getCameraFrame(id);
}
