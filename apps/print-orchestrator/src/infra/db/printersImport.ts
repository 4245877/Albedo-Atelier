import type { PrintQueueStore } from "../../domain/print/repositories";
import type { PrinterRecord } from "../../domain/printers/config";
import type { StoreLogger } from "../../shared/logger";
import { loadPrinterRecords, type PrinterConfigSource } from "../printers/config";

/** app_meta key recording that the printers.json→SQLite import ran exactly once. */
export const PRINTERS_IMPORT_MARKER = "printers_import.config_file";

export interface PrintersImportResult {
  /** True when the import was skipped because the marker was already set. */
  skipped: boolean;
  imported: number;
  /** Where the seed came from, for the boot log. */
  source: PrinterConfigSource;
}

/**
 * One-time import of the hand-written printer config (`config/printers.json`, or
 * `PRINTERS_CONFIG_JSON`) into the `printers` table.
 *
 * Same policy as the legacy queue import: an `app_meta` marker set **inside the
 * import transaction** makes it run exactly once, and after that the database is
 * the single source of truth — the file is never read again, so an operator's
 * edit in the UI can never be silently reverted by a stale file on the next
 * restart. That is the whole point: the file described a farm you had to rebuild
 * to change.
 *
 * Deliberately marks itself done even when the seed is **empty**. A farm that
 * legitimately starts with no printers must be able to add its first one from
 * the UI without an old file resurrecting on the next boot.
 *
 * Strings are imported verbatim, `${BAMBU_A1_ACCESS_CODE}`-style references
 * included, so a farm that keeps its secrets in `.env` keeps working unchanged
 * until the operator types a literal value into the dashboard.
 */
export async function importPrintersConfig(
  store: PrintQueueStore,
  options: { logger?: StoreLogger; load?: () => Promise<{ records: PrinterRecord[]; source: PrinterConfigSource }> } = {}
): Promise<PrintersImportResult> {
  const repos = store.repositories;
  if (repos.meta.get(PRINTERS_IMPORT_MARKER)) {
    return { skipped: true, imported: 0, source: { kind: "db" } };
  }

  const load = options.load ?? loadPrinterRecords;
  const { records, source } = await load();

  const imported = store.transaction(() => {
    let count = 0;
    for (const record of records) {
      // Defensive: a printer already present under this id (a half-finished
      // earlier import, a manual insert) is left exactly as it is. The stored
      // row wins over the file — never the other way round.
      if (repos.printers.getById(record.id)) continue;
      repos.printers.insert(record);
      count += 1;
    }
    repos.meta.set(PRINTERS_IMPORT_MARKER, new Date().toISOString());
    return count;
  });

  options.logger?.info?.(
    { imported, source: source.kind, path: source.path },
    imported > 0
      ? "printer config imported into SQLite — config/printers.json is no longer read; edit printers in the dashboard"
      : "no seed printer config found — printers are managed in the dashboard"
  );

  return { skipped: false, imported, source };
}
