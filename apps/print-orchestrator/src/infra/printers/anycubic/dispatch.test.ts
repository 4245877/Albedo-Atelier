import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import mqtt from "mqtt";

import { canCaptureSnapshot, hasCameraSource, resolveSnapshotUrl } from "../camera";
import { PrinterCapabilityError } from "../capabilities";
import { normalizePrinterConfig, type PrinterConfig } from "../config";
import { discoverPrinterSpecs } from "../discovery";
import { deletePrinterFile, fetchPrinterFiles, uploadPrinterFile } from "../files";
import {
  disconnectPrinter,
  getPrinterLiveStatus,
  PrinterCommandError,
  sendPrinterCommand,
  sendPrinterLight,
  sendPrinterStart,
  shutdownPrinterConnections,
  supportsPrinterControl,
  supportsPrinterLight,
  supportsPrinterStart
} from "../status";

/*
 * Every protocol switch in the printer layer, asked about an `anycubic-lan`
 * printer — and about a protocol nobody implements. `fetch` (Moonraker,
 * cameras) and `mqtt.connect` (Bambu) are replaced by tripwires: reaching either
 * fails the test, which is the proof that no other adapter's code is ever run
 * for these printers. The Anycubic printer has no confirmed certificate here, so
 * its own adapter contacts nothing either; where one is confirmed (`CONFIGURED`),
 * the refusals below are the capability's, not a missing setting's.
 */

const CONFIGURED = {
  tlsFingerprint: "0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0:0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0"
};

const fetchCalls: string[] = [];

beforeEach(() => {
  fetchCalls.length = 0;
  mock.method(globalThis, "fetch", async (input: unknown) => {
    fetchCalls.push(String(input));
    throw new Error("network must not be touched");
  });
  mock.method(mqtt, "connect", () => {
    throw new Error("the Bambu MQTT client must not be created");
  });
});

afterEach(() => {
  shutdownPrinterConnections();
  mock.restoreAll();
});

function kobra(over: Record<string, unknown> = {}): PrinterConfig {
  const config = normalizePrinterConfig({
    id: "kobra-x",
    name: "Kobra X",
    host: "192.168.1.60",
    protocol: "anycubic-lan",
    light: { enabled: true, bambuNode: "chamber_light", onGcode: "M355 S1", offGcode: "M355 S0" },
    ...over
  });
  assert.ok(config);
  return config;
}

/** A protocol this build does not implement, as a corrupted runtime value would carry it. */
const ALIEN = { ...kobra(), id: "alien", protocol: "octoprint" } as unknown as PrinterConfig;

test("telemetry is the Anycubic adapter's, and without a confirmed certificate it contacts nothing", async () => {
  const status = await getPrinterLiveStatus(kobra());
  assert.equal(status.online, false);
  assert.equal(status.status, "offline");
  assert.match(status.error ?? "", /сертификат принтера не подтверждён/);
  assert.deepEqual(fetchCalls, []);
});

test("an unimplemented protocol gets an explicit refusal, not Moonraker's poll", async () => {
  const status = await getPrinterLiveStatus(ALIEN);
  assert.equal(status.status, "offline");
  assert.match(status.error ?? "", /Неподдерживаемый протокол принтера «octoprint»/);
  assert.deepEqual(fetchCalls, []);
});

test("pause, resume and cancel are refused and nothing is sent", async () => {
  for (const printer of [kobra(CONFIGURED), ALIEN]) {
    assert.equal(supportsPrinterControl(printer), false);
    for (const command of ["pause", "resume", "cancel"] as const) {
      await assert.rejects(sendPrinterCommand(printer, command), PrinterCommandError);
    }
  }
  assert.deepEqual(fetchCalls, []);
});

test("a remote start is refused before any transport is chosen", async () => {
  for (const printer of [kobra(CONFIGURED), ALIEN]) {
    assert.equal(supportsPrinterStart(printer), false);
    await assert.rejects(sendPrinterStart(printer, "part.gcode"), PrinterCapabilityError);
  }
  assert.deepEqual(fetchCalls, []);
});

test("the light is not controllable, even with light settings on the record", async () => {
  const printer = kobra(CONFIGURED);
  assert.equal(supportsPrinterLight(printer), false);
  await assert.rejects(sendPrinterLight(printer, true), PrinterCommandError);
  await assert.rejects(sendPrinterLight(ALIEN, true), PrinterCommandError);
  assert.deepEqual(fetchCalls, []);
});

test("files cannot be listed, uploaded or deleted — and never through Moonraker", async () => {
  for (const printer of [kobra(CONFIGURED), ALIEN]) {
    await assert.rejects(fetchPrinterFiles(printer, ""), PrinterCapabilityError);
    await assert.rejects(uploadPrinterFile(printer, "part.gcode", new Uint8Array([1, 2, 3])), PrinterCapabilityError);
    await assert.rejects(deletePrinterFile(printer, "part.gcode"), PrinterCapabilityError);
  }
  assert.deepEqual(fetchCalls, []);
});

test("no camera URL is guessed for it", () => {
  const printer = kobra(CONFIGURED);
  assert.equal(resolveSnapshotUrl(printer), null);
  assert.equal(canCaptureSnapshot(printer), false);
  assert.equal(hasCameraSource(printer), false);
});

test("discovery is the Anycubic adapter's — a cache read with no I/O", async () => {
  const result = await discoverPrinterSpecs(kobra(CONFIGURED));
  assert.equal(result.succeeded, false);
  assert.match(result.error ?? "", /Anycubic LAN/);
  const alien = await discoverPrinterSpecs(ALIEN);
  assert.match(alien.error ?? "", /Неподдерживаемый протокол принтера «octoprint»/);
  assert.deepEqual(fetchCalls, []);
});

test("dropping its connection is safe whether or not a session exists", () => {
  assert.doesNotThrow(() => disconnectPrinter("kobra-x"));
  assert.doesNotThrow(() => disconnectPrinter("never-seen"));
});
