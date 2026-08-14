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
 * The protocol capability gate. Moonraker (HTTP) and Bambu (FTPS on 990) both
 * have a file API adapter; Creality's WebSocket protocol does not and is
 * reported honestly as unsupported rather than as an empty directory.
 */

test("printers with an implemented file API support browsing; Creality WS does not", () => {
  assert.equal(supportsPrinterFiles(makePrinter("moonraker")), true);
  assert.equal(supportsPrinterFiles(makePrinter("bambu")), true);
  assert.equal(supportsPrinterFiles(makePrinter("creality")), false);
});

test("fetchPrinterFiles throws a STRUCTURED unsupported error for Creality WS", async () => {
  await assert.rejects(
    fetchPrinterFiles(makePrinter("creality"), ""),
    (error: unknown) =>
      error instanceof PrinterCapabilityError &&
      error.code === "PRINTER_CAPABILITY_UNSUPPORTED" &&
      // The capability and protocol are machine-readable, so the dashboard can
      // offer the manual flow instead of parsing a Russian sentence.
      (error.details as { capability?: string }).capability === "supportsFileListing" &&
      (error.details as { protocol?: string }).protocol === "creality"
  );
});

test("a Bambu with no credentials reports WHAT TO CONFIGURE, not «unsupported»", async () => {
  // The distinction an operator can act on: the adapter exists, this printer is
  // simply not set up. Naming the missing field is the whole point.
  await assert.rejects(
    fetchPrinterFiles(makePrinter("bambu"), ""),
    (error: unknown) => {
      const err = error as { code?: string; details?: { missing?: { field: string }[] } };
      assert.equal(err.code, "PRINTER_NOT_CONFIGURED");
      assert.ok(err.details?.missing?.some((m) => m.field === "accessCode"));
      return true;
    }
  );
});
