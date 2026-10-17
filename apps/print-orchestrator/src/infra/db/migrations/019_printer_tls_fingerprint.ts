import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./types";

/**
 * `printers.tls_fingerprint` — the SHA-256 fingerprint of the TLS certificate an
 * operator confirmed for a printer. Anycubic LAN connects only to a broker that
 * presents exactly that certificate; there is no CA to verify it against.
 *
 * Plain `ADD COLUMN` with a constant default: no rebuild, so the
 * `printer_discovery` cascade migration 018 had to work around cannot trigger.
 * Every existing row reads `''` — "nothing confirmed" — which leaves every
 * printer exactly as it was: no other protocol reads the column, and an Anycubic
 * printer without a confirmed certificate connects to nothing.
 */
export const migration019: Migration = {
  version: 19,
  name: "019_printer_tls_fingerprint",
  up(db: DatabaseSync): void {
    db.exec(`ALTER TABLE printers ADD COLUMN tls_fingerprint TEXT NOT NULL DEFAULT '';`);
  }
};
