import assert from "node:assert/strict";
import { test } from "node:test";

import {
  capabilitiesOf,
  capabilitiesOfProtocol,
  PrinterCapabilityError,
  requireCapability
} from "./capabilities";
import { normalizePrinterConfig } from "./config";

/*
 * Capabilities are *declared*, per protocol, in one table — never inferred from a
 * printer's model or name. These tests pin that contract down, because the whole
 * delivery model branches on it: an adapter that claims an ability it does not
 * have would either fake an upload or start a file nobody verified.
 */

function printer(protocol: string, over: Record<string, unknown> = {}) {
  const config = normalizePrinterConfig({
    id: "p1",
    name: "Printer One",
    host: "192.168.0.10",
    protocol,
    ...over
  });
  assert.ok(config, "fixture config must be valid");
  return config;
}

test("Moonraker declares upload + listing + remote start, and name_and_size verification", () => {
  const caps = capabilitiesOf(printer("moonraker"));
  assert.deepEqual(caps, {
    supportsUpload: true,
    supportsFileListing: true,
    supportsRemoteStart: true,
    // Not implemented here, so declared false rather than assumed from the API docs.
    supportsFileDelete: false,
    // The ceiling of what the API can prove — never presented as a content hash.
    fileVerification: "name_and_size"
  });
});

test("Bambu and Creality declare NO file abilities — the manual path, honestly", () => {
  for (const protocol of ["bambu", "creality"]) {
    assert.deepEqual(
      capabilitiesOf(printer(protocol)),
      {
        supportsUpload: false,
        supportsFileListing: false,
        supportsRemoteStart: false,
        supportsFileDelete: false,
        fileVerification: "none"
      },
      protocol
    );
  }
});

test("an unknown protocol can do nothing (fail-closed, not 'probably like Moonraker')", () => {
  for (const unknown of ["prusalink", "octoprint", "", null, undefined]) {
    assert.deepEqual(capabilitiesOfProtocol(unknown), {
      supportsUpload: false,
      supportsFileListing: false,
      supportsRemoteStart: false,
      supportsFileDelete: false,
      fileVerification: "none"
    });
  }
});

test("capabilities do not depend on the model or the printer's name", () => {
  // A Bambu named "Creality K2 Moonraker" is still a Bambu.
  const disguised = capabilitiesOf(
    printer("bambu", { name: "Creality K2 Moonraker", model: "K2 Plus" })
  );
  assert.equal(disguised.supportsUpload, false);
  assert.equal(disguised.supportsFileListing, false);
});

test("requireCapability throws a STRUCTURED error naming the capability and protocol", () => {
  assert.throws(
    () => requireCapability(printer("bambu"), "supportsUpload", "перенесите файл вручную"),
    (error: unknown) => {
      assert.ok(error instanceof PrinterCapabilityError);
      assert.equal(error.code, "PRINTER_CAPABILITY_UNSUPPORTED");
      assert.equal(error.statusCode, 409);
      assert.deepEqual(error.details, {
        printerId: "p1",
        protocol: "bambu",
        capability: "supportsUpload"
      });
      return true;
    }
  );
});

test("requireCapability passes silently for a declared ability", () => {
  assert.doesNotThrow(() => requireCapability(printer("moonraker"), "supportsUpload"));
  assert.doesNotThrow(() => requireCapability(printer("moonraker"), "supportsFileListing"));
  assert.doesNotThrow(() => requireCapability(printer("moonraker"), "supportsRemoteStart"));
  // …but not for one nobody implemented.
  assert.throws(() => requireCapability(printer("moonraker"), "supportsFileDelete"));
});
