import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, mock, test } from "node:test";
import mqtt from "mqtt";

import type { PrinterConfig } from "../config";
import {
  dropBambuConnection, getBambuDeviceInfo, getBambuRawPrint, getBambuStatus,
  shutdownBambuConnections
} from "./bambu";

// Mock the actual adapter's MQTT transport: these tests never open a socket.
class FakeClient extends EventEmitter {
  connected = true;
  published: string[] = [];
  subscribe() {}
  publish(_topic: string, payload: string, callback?: (error?: Error) => void) {
    this.published.push(payload);
    callback?.();
  }
  end() { this.connected = false; }
}

afterEach(() => {
  shutdownBambuConnections();
  mock.restoreAll();
});

function fixture() {
  const client = new FakeClient();
  mock.method(mqtt, "connect", () => client as unknown as mqtt.MqttClient);
  const printer = {
    id: "connection-probe", name: "Probe", protocol: "bambu", host: "127.0.0.1",
    serial: "TEST", accessCode: "TEST", allowInsecureTls: true,
    light: { enabled: false, bambuNode: "chamber_light" }
  } as PrinterConfig;
  getBambuStatus(printer);
  const report = (print: Record<string, unknown>) => {
    client.emit("message", "device/TEST/report", Buffer.from(JSON.stringify({ print })));
  };
  report({ gcode_state: "RUNNING", mc_percent: 75, subtask_id: "job-1", subtask_name: "part.3mf" });
  return { printer, client, report };
}

for (const event of ["close", "offline"]) {
  test(`MQTT ${event} invalidates cached printing and reconnect deltas cannot revive it`, () => {
    const f = fixture();
    assert.equal(getBambuStatus(f.printer).status, "printing");
    f.client.connected = false;
    f.client.emit(event);
    const disconnected = getBambuStatus(f.printer);
    assert.equal(disconnected.online, false);
    assert.equal(disconnected.progressPct, null);
    assert.equal(disconnected.currentFile, null);

    f.client.connected = true;
    f.client.emit("connect");
    f.report({ nozzle_temper: 30 });
    const partial = getBambuStatus(f.printer);
    assert.equal(partial.status, "unknown", "old RUNNING was discarded");
    assert.equal(partial.online, false, "a temperature delta cannot confirm the current job state");
    f.report({ gcode_state: "FINISH", mc_percent: 100, subtask_id: "job-1", subtask_name: "part.3mf" });
    const completed = getBambuStatus(f.printer);
    assert.equal(completed.status, "idle");
    assert.equal(completed.stateText, "FINISH");
    assert.equal(completed.progressPct, 100);
  });
}

test("a disconnected MQTT client cannot expose cached online telemetry even before a close callback", () => {
  const f = fixture();
  f.client.connected = false;
  assert.equal(getBambuStatus(f.printer).online, false);
});

test("a connected but silent printer becomes offline after three missed full reports", () => {
  const f = fixture();
  const observedAt = Date.parse(getBambuStatus(f.printer).updatedAt);
  const now = mock.method(Date, "now", () => observedAt + 90001);
  const stale = getBambuStatus(f.printer);
  assert.equal(stale.online, false);
  assert.equal(stale.progressPct, null);
  assert.match(stale.error ?? "", /90 секунд/);
  now.mock.restore();

  f.report({ nozzle_temper: 30 });
  const partial = getBambuStatus(f.printer);
  assert.equal(partial.status, "unknown", "a delta cannot resurface old job data");
  assert.equal(partial.online, false);
  f.report({ gcode_state: "RUNNING", mc_percent: 80 });
  assert.equal(getBambuStatus(f.printer).progressPct, 80);
});

test("temperature deltas cannot keep an unconfirmed old printing state fresh forever", () => {
  const f = fixture();
  const observedAt = Date.parse(getBambuStatus(f.printer).updatedAt);
  mock.method(Date, "now", () => observedAt + 90001);
  f.report({ nozzle_temper: 210 });
  assert.equal(getBambuStatus(f.printer).online, false);
});

test("a close callback preserves the MQTT authentication error that explains the outage", () => {
  const f = fixture();
  f.client.emit("error", new Error("not authorized"));
  f.client.connected = false;
  f.client.emit("close");
  assert.match(getBambuStatus(f.printer).error ?? "", /not authorized/);
});

test("a partial new-job identity cannot reuse the preceding job's confirmed state", () => {
  const f = fixture();
  f.report({ subtask_id: "job-2", subtask_name: "other.3mf", nozzle_temper: 210 });
  const partial = getBambuStatus(f.printer);
  assert.equal(partial.status, "unknown");
  assert.equal(partial.online, false);
  assert.equal(partial.progressPct, null);

  f.report({ gcode_state: "RUNNING", mc_percent: 1 });
  const running = getBambuStatus(f.printer);
  assert.equal(running.online, true);
  assert.equal(running.status, "printing");
  assert.equal(running.currentFile, "other.3mf");
  assert.equal(running.progressPct, 1);
});

test("callbacks from a retired MQTT client cannot overwrite its replacement's state or publish requests", () => {
  const f = fixture();
  dropBambuConnection(f.printer.id);
  const replacement = new FakeClient();
  mock.method(mqtt, "connect", () => replacement as unknown as mqtt.MqttClient);
  getBambuStatus(f.printer);
  replacement.emit("message", "device/TEST/report", Buffer.from(JSON.stringify({
    print: { gcode_state: "FINISH", mc_percent: 100, subtask_id: "job-2", subtask_name: "new.3mf" }
  })));
  replacement.emit("message", "device/TEST/report", Buffer.from(JSON.stringify({
    info: { module: [{ name: "new-device" }] }
  })));
  const expected = getBambuStatus(f.printer);
  const requestCount = f.client.published.length;

  f.client.emit("connect");
  f.report({ gcode_state: "RUNNING", mc_percent: 75, subtask_id: "job-1", subtask_name: "old.3mf" });
  f.client.emit("message", "device/TEST/report", Buffer.from(JSON.stringify({
    info: { module: [{ name: "old-device" }] }
  })));
  f.client.emit("error", new Error("retired client error"));
  f.client.emit("close");
  f.client.emit("offline");

  assert.deepEqual(getBambuStatus(f.printer), expected);
  assert.equal(getBambuRawPrint(f.printer.id)?.subtask_name, "new.3mf");
  assert.deepEqual(getBambuDeviceInfo(f.printer.id), { module: [{ name: "new-device" }] });
  assert.equal(f.client.published.length, requestCount, "a retired connect callback sends no requests");
});

test("unrelated MQTT topics cannot update printer telemetry", () => {
  const f = fixture();
  const expected = getBambuStatus(f.printer);
  f.client.emit("message", "device/OTHER/report", Buffer.from(JSON.stringify({
    print: { gcode_state: "FINISH", mc_percent: 100 }
  })));
  assert.deepEqual(getBambuStatus(f.printer), expected);
});

test("a same-job name-only delta preserves its authoritative online state and progress", () => {
  const f = fixture();
  f.report({ subtask_name: "part.3mf", nozzle_temper: 210 });
  const unchanged = getBambuStatus(f.printer);
  assert.equal(unchanged.online, true);
  assert.equal(unchanged.status, "printing");
  assert.equal(unchanged.progressPct, 75);
  assert.equal(getBambuRawPrint(f.printer.id)?.subtask_id, "job-1");
});
