import type { WritableRepository } from "../shared/repository";
import type { PrinterRecord } from "./config";

/**
 * Storage port for the printer configuration. The service layer depends on this
 * interface only; the SQLite adapter lives in `infra/db/repositories`.
 */
export interface PrinterRepository extends WritableRepository<PrinterRecord> {
  /** Every configured printer, enabled or not, in operator order. */
  list(): PrinterRecord[];
  /** Removes the printer. The runtime config is reloaded by the service. */
  delete(id: string): void;
  /** Highest `position` in use, or 0 when the farm has no printers yet. */
  maxPosition(): number;
}
