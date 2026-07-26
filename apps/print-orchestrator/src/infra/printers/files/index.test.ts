import assert from "node:assert/strict";
import { test } from "node:test";

import { PrinterCapabilityError } from "../capabilities";
import { normalizePrinterConfig } from "../config";
import { fetchPrinterFiles, supportsPrinterFiles } from "./index";

function makePrinter(protocol: string) {
  const printer = normalizePrinterConfig({
    id: "p1",
    name: "Printer One",
    host: "192.168.0.10",
    protocol
  });
  assert.ok(printer, "fixture config must be valid");
  return printer;
}

/*
 * The protocol capability gate: only Moonraker has a file API adapter; Bambu
 * (MQTT) and Creality (WebSocket) are reported honestly as unsupported.
 */

test("only Moonraker printers support file browsing", () => {
  assert.equal(supportsPrinterFiles(makePrinter("moonraker")), true);
  assert.equal(supportsPrinterFiles(makePrinter("bambu")), false);
  assert.equal(supportsPrinterFiles(makePrinter("creality")), false);
});

test("fetchPrinterFiles throws a STRUCTURED unsupported error for Bambu and Creality WS", async () => {
  for (const protocol of ["bambu", "creality"]) {
    await assert.rejects(
      fetchPrinterFiles(makePrinter(protocol), ""),
      (error: unknown) =>
        error instanceof PrinterCapabilityError &&
        error.code === "PRINTER_CAPABILITY_UNSUPPORTED" &&
        // The capability and protocol are machine-readable, so the dashboard can
        // offer the manual flow instead of parsing a Russian sentence.
        (error.details as { capability?: string; protocol?: string }).capability ===
          "supportsFileListing" &&
        (error.details as { protocol?: string }).protocol === protocol,
      protocol
    );
  }
});
