import fs from "node:fs";

import type { StoreLogger } from "./logger";

/**
 * Advisory permission check for a secret-bearing config file (printer API keys,
 * access codes). Warns — never throws — when the file is group- or
 * world-accessible; such files should be `0600`.
 *
 * Deliberately non-fatal and safe under Docker: the container reads the file as
 * a fixed uid that still has access to a `0600` file it owns, so tightening the
 * permissions never breaks the runtime — a loose file is merely flagged so an
 * operator can fix it. A missing/unreadable path is silently ignored (it is not
 * this check's job to report that).
 */
export function warnIfPermsTooOpen(filePath: string, logger: StoreLogger): void {
  if (!filePath) return;
  try {
    const mode = fs.statSync(filePath).mode;
    if ((mode & 0o077) !== 0) {
      logger.warn?.(
        { path: filePath, mode: (mode & 0o777).toString(8) },
        "config file with secrets is group/world-accessible — recommend chmod 600"
      );
    }
  } catch {
    // Missing or unreadable file — not this check's concern.
  }
}
