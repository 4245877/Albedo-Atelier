import assert from "node:assert/strict";
import { test } from "node:test";

import {
  capabilitiesOf,
  capabilitiesOfProtocol,
  PrinterCapabilityError,
  PrinterNotConfiguredError,
  printerReadiness,
  requireCapability,
  requireReady
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
    fileVerification: "name_and_size",
    startableExtensions: [".gcode", ".gco", ".g"],
    deviceFileExtension: ".gcode"
  });
});

test("Bambu declares upload + listing + start over its own FTPS/MQTT transports", () => {
  // These were all false while the FTPS client did not exist. That was an honest
  // statement about this codebase, not about the hardware — the device serves
  // FTPS on 990 and accepts `print.project_file` over MQTT.
  assert.deepEqual(capabilitiesOf(printer("bambu")), {
    supportsUpload: true,
    supportsFileListing: true,
    supportsRemoteStart: true,
    supportsFileDelete: true,
    fileVerification: "name_and_size",
    startableExtensions: [".gcode.3mf", ".3mf", ".gcode"],
    deviceFileExtension: ".gcode.3mf"
  });
});

test("the Bambu extension list puts .gcode.3mf first, so the double extension survives", () => {
  // Longest match wins: split at `.3mf` instead and a plate package would be
  // renamed into something the firmware does not open.
  const caps = capabilitiesOf(printer("bambu"));
  assert.equal(caps.startableExtensions[0], ".gcode.3mf");
  assert.ok(caps.startableExtensions.indexOf(".gcode.3mf") < caps.startableExtensions.indexOf(".3mf"));
});

test("Creality declares NO file abilities — the manual path, honestly", () => {
  const caps = capabilitiesOf(printer("creality"));
  assert.equal(caps.supportsUpload, false);
  assert.equal(caps.supportsFileListing, false);
  assert.equal(caps.supportsRemoteStart, false);
  assert.equal(caps.fileVerification, "none");
});

test("an unknown protocol can do nothing (fail-closed, not 'probably like Moonraker')", () => {
  for (const unknown of ["prusalink", "octoprint", "", null, undefined]) {
    assert.deepEqual(capabilitiesOfProtocol(unknown), {
      supportsUpload: false,
      supportsFileListing: false,
      supportsRemoteStart: false,
      supportsFileDelete: false,
      fileVerification: "none",
      startableExtensions: [".gcode", ".gco", ".g"],
      deviceFileExtension: ".gcode"
    });
  }
});

test("capabilities do not depend on the model or the printer's name", () => {
  // A Bambu named "Creality K2 Moonraker" is still a Bambu — and, just as
  // importantly, an id of `bambu-a1-combo` is not parsed for the word "combo".
  const disguised = capabilitiesOf(
    printer("bambu", { id: "bambu-a1-combo", name: "Creality K2 Moonraker", model: "K2 Plus" })
  );
  assert.equal(disguised.supportsUpload, true);
  assert.equal(disguised.deviceFileExtension, ".gcode.3mf");

  const moonraker = capabilitiesOf(printer("moonraker", { name: "Bambu Lab A1 Combo" }));
  assert.equal(moonraker.deviceFileExtension, ".gcode");
});

test("requireCapability throws a STRUCTURED error naming the capability and protocol", () => {
  assert.throws(
    () => requireCapability(printer("creality"), "supportsUpload", "перенесите файл вручную"),
    (error: unknown) => {
      assert.ok(error instanceof PrinterCapabilityError);
      assert.equal(error.code, "PRINTER_CAPABILITY_UNSUPPORTED");
      assert.equal(error.statusCode, 409);
      assert.deepEqual(error.details, {
        printerId: "p1",
        protocol: "creality",
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

// ── Readiness: what THIS printer still needs, as opposed to what the adapter can do ──

/**
 * The distinction these pin down is the one an operator could previously do
 * nothing with: a Bambu with no access code answered "адаптер не умеет загружать
 * файлы" — a statement about our software, which named nothing to fix.
 */

const BAMBU_READY = { serial: "03919D551805635", accessCode: "d1eea97d", allowInsecureTls: true };

test("a fully configured Bambu is ready", () => {
  const readiness = printerReadiness(printer("bambu", BAMBU_READY));
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.missing, []);
  assert.doesNotThrow(() => requireReady(printer("bambu", BAMBU_READY)));
});

test("a missing access code names the field and where to find it", () => {
  const readiness = printerReadiness(printer("bambu", { ...BAMBU_READY, accessCode: "" }));
  assert.equal(readiness.ready, false);
  const missing = readiness.missing.find((m) => m.field === "accessCode");
  assert.ok(missing, "the accessCode requirement must be reported");
  assert.match(missing.label, /access code/i);
  assert.match(missing.hint, /LAN/i);
});

test("a missing serial is reported separately from a missing access code", () => {
  const readiness = printerReadiness(printer("bambu", { ...BAMBU_READY, serial: "" }));
  assert.deepEqual(readiness.missing.map((m) => m.field), ["serial"]);
});

test("the insecure-TLS opt-in is a requirement, not a silent default", () => {
  const previous = process.env.BAMBU_ALLOW_INSECURE_TLS;
  delete process.env.BAMBU_ALLOW_INSECURE_TLS;
  try {
    const readiness = printerReadiness(printer("bambu", { ...BAMBU_READY, allowInsecureTls: false }));
    assert.equal(readiness.ready, false);
    assert.ok(readiness.missing.some((m) => m.field === "allowInsecureTls"));
  } finally {
    if (previous !== undefined) process.env.BAMBU_ALLOW_INSECURE_TLS = previous;
  }
});

test("requireReady throws a structured error listing every missing field", () => {
  assert.throws(
    () => requireReady(printer("bambu", { serial: "", accessCode: "", allowInsecureTls: true })),
    (error: unknown) => {
      assert.ok(error instanceof PrinterNotConfiguredError);
      assert.equal(error.code, "PRINTER_NOT_CONFIGURED");
      assert.equal(error.statusCode, 409);
      const details = error.details as { missing: { field: string }[] };
      assert.deepEqual(details.missing.map((m) => m.field).sort(), ["accessCode", "serial"]);
      // Crucially NOT a capability error: the adapter is implemented; the
      // printer is unconfigured, and the operator is told which field to fill.
      assert.ok(!(error instanceof PrinterCapabilityError));
      return true;
    }
  );
});

test("readiness reports configuration only — never whether the device answers", () => {
  // A perfectly configured printer that is switched off is READY but offline.
  // Merging the two would report "not configured" for a power cut.
  const readiness = printerReadiness(printer("bambu", { ...BAMBU_READY, host: "10.255.255.1" }));
  assert.equal(readiness.ready, true);
});
