import type { PrintQueueStore } from "../../domain/print/repositories";
import type { StoreLogger } from "../../shared/logger";
import { openDatabase } from "./database";
import { SqlitePrintQueueStore } from "./repositories";

/**
 * Opens the print-queue database (WAL, foreign keys, migrations applied) and
 * returns it as a domain {@link PrintQueueStore}. The one place the rest of the
 * app calls to get a ready store; `store.close()` closes the connection.
 */
export function openPrintQueueStore(dbPath: string, logger: StoreLogger = {}): PrintQueueStore {
  const db = openDatabase(dbPath, logger);
  return new SqlitePrintQueueStore(db);
}
