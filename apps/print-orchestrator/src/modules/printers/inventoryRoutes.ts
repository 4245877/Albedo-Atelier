import type { FastifyInstance } from "fastify";

import type { PrinterConfigService } from "../../app/printers/printerConfigService";

/** The one capability this route needs, passed explicitly at registration. */
export interface PrinterInventoryRoutesOptions {
  printerConfig: () => PrinterConfigService;
}

/**
 * `GET /api/printers/inventory` — the stable, read-only **inter-service**
 * contract for "which printers does this farm have, and what are they".
 *
 * Why it exists next to `/api/printers` and `/api/printers/config`:
 *
 *  - `/api/printers` answers *live state* and only for enabled printers, so a
 *    consumer reading configuration from it cannot tell a disabled printer from
 *    a deleted one, and sees nothing at all before the first poll;
 *  - `/api/printers/config` is the operator's editing surface — connection
 *    parameters and credential status. Handing that to another service means
 *    handing it the farm's wiring for no reason.
 *
 * This route returns configuration only, includes disabled printers (flagged),
 * and carries no host, port, credential or camera URL — see
 * `domain/printers/inventory.ts`, which projects the fields explicitly so a new
 * column on the stored record can never leak by being added upstream.
 *
 * It is a plain read: the shared guard leaves GETs open (the host allowlist
 * still applies), and it works identically with or without the API token.
 */
export async function registerPrinterInventoryRoutes(
  app: FastifyInstance,
  opts: PrinterInventoryRoutesOptions
): Promise<void> {
  app.get("/", async (_request, reply) => {
    const snapshot = opts.printerConfig().inventory();
    // Configuration changes only when an operator changes it, but a consumer
    // must never serve a cached farm from a proxy: correctness here beats the
    // handful of bytes.
    reply.header("Cache-Control", "no-store");
    return snapshot;
  });
}
