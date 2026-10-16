import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { after, afterEach, before, test } from "node:test";

import { DEFAULT_LIGHT_SETTINGS } from "../../../domain/printers/config";
import type { PrinterConfig } from "../config";
import { signCtrlRequest } from "./handshake";
import {
  anycubicTestHooks,
  discoverAnycubicFacts,
  dropAnycubicConnection,
  getAnycubicStatus,
  shutdownAnycubicConnections
} from "./index";
import { isReadOnlyQuery } from "./session";

/*
 * The whole adapter on real transports, against a fake printer on loopback:
 * the HTTP handshake (MD5 signature, AES bundle), a TLS server with a freshly
 * generated self-signed certificate, and a minimal MQTT 3.1.1 broker — while the
 * client side is the production code path (registry → session → node:tls →
 * mqtt.js). Nothing leaves 127.0.0.1 and no real printer is involved.
 *
 * Skipped when the `openssl` CLI is missing: CI forbids committed private keys,
 * so the certificate is generated per run.
 */

const TOKEN = "0123456789abcdefFEDCBA9876543210";
const LOCAL_TOKEN = "IVIVIVIVIVIVIVIV";
const LOGIN = { username: "lan-user", password: "lan-secret-password" };
const DEVICE_ID = "dev1";
const REPORTS = `anycubic/anycubicCloud/v1/printer/public/20030/${DEVICE_ID}`;

let workDir = "";
let certificate: { key: string; cert: string } | null = null;

try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "anycubic-lan-"));
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", path.join(workDir, "key.pem"), "-out", path.join(workDir, "cert.pem"),
      "-days", "2", "-subj", "/CN=anycubic-test"
    ],
    { stdio: "ignore" }
  );
  certificate = {
    key: fs.readFileSync(path.join(workDir, "key.pem"), "utf8"),
    cert: fs.readFileSync(path.join(workDir, "cert.pem"), "utf8")
  };
} catch {
  certificate = null;
}

const skip = certificate ? false : "openssl CLI unavailable — cannot generate a test certificate";

// ── The fake printer: HTTP handshake ──────────────────────────────────────────

let httpServer: http.Server;
let httpPort = 0;
let httpRequests: string[] = [];

function encryptBundle(): string {
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(TOKEN.slice(16, 32)), Buffer.from(LOCAL_TOKEN));
  const bundle = { ...LOGIN, deviceId: DEVICE_ID, modelId: "20030", broker: "mqtts://203.0.113.5:9883" };
  return Buffer.concat([cipher.update(JSON.stringify(bundle)), cipher.final()]).toString("base64");
}

// ── The fake printer: a minimal MQTT 3.1.1 broker over TLS ───────────────────

interface BrokerSession {
  socket: tls.TLSSocket;
  connect: { clientId: string; username: string; password: string } | null;
  subscriptions: string[];
  published: { topic: string; payload: string }[];
}

let broker: tls.Server;
let brokerPort = 0;
let sessions: BrokerSession[] = [];
/** What the broker answers to an info query, per connection index. */
let infoReplies: unknown[] = [];

function encodeLength(length: number): Buffer {
  const bytes: number[] = [];
  do {
    let digit = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) digit |= 0x80;
    bytes.push(digit);
  } while (length > 0);
  return Buffer.from(bytes);
}

function packet(type: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type]), encodeLength(body.length), body]);
}

function str(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from([bytes.length >> 8, bytes.length & 0xff]), bytes]);
}

function readStr(body: Buffer, offset: number): [string, number] {
  const length = body.readUInt16BE(offset);
  return [body.subarray(offset + 2, offset + 2 + length).toString("utf8"), offset + 2 + length];
}

function publishTo(session: BrokerSession, topic: string, payload: unknown): void {
  session.socket.write(packet(0x30, Buffer.concat([str(topic), Buffer.from(JSON.stringify(payload))])));
}

function handlePacket(session: BrokerSession, index: number, type: number, body: Buffer): void {
  switch (type >> 4) {
    case 1: {
      // CONNECT: protocol name, level, flags, keepalive, client id, [user], [password]
      let offset = readStr(body, 0)[1] + 1;
      const flags = body[offset];
      offset += 3;
      const [clientId, afterId] = readStr(body, offset);
      offset = afterId;
      let username = "";
      let password = "";
      if (flags & 0x80) [username, offset] = readStr(body, offset);
      if (flags & 0x40) [password, offset] = readStr(body, offset);
      session.connect = { clientId, username, password };
      const accepted = username === LOGIN.username && password === LOGIN.password;
      session.socket.write(Buffer.from([0x20, 0x02, 0x00, accepted ? 0x00 : 0x05]));
      return;
    }
    case 8: {
      // SUBSCRIBE: packet id, then (topic, qos) pairs
      const packetId = body.readUInt16BE(0);
      let offset = 2;
      const granted: number[] = [];
      while (offset < body.length) {
        const [topic, next] = readStr(body, offset);
        session.subscriptions.push(topic);
        offset = next + 1;
        granted.push(0);
      }
      session.socket.write(packet(0x90, Buffer.from([packetId >> 8, packetId & 0xff, ...granted])));
      return;
    }
    case 3: {
      // PUBLISH (QoS 0): the client's query. Answer an info query with a report.
      const [topic, offset] = readStr(body, 0);
      const payload = body.subarray(offset).toString("utf8");
      session.published.push({ topic, payload });
      const reply = infoReplies[index] ?? infoReplies.at(-1);
      if (topic.endsWith("/info") && reply) publishTo(session, `${REPORTS}/info/report`, reply);
      return;
    }
    case 12:
      session.socket.write(Buffer.from([0xd0, 0x00])); // PINGRESP
      return;
    default:
      return;
  }
}

before(async () => {
  if (!certificate) return;
  httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    httpRequests.push(`${req.method} ${url.pathname}`);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/info") {
      res.end(JSON.stringify({ token: TOKEN, modelId: 20030, modelName: "Anycubic Kobra X", cn: "SN-KX-1", ctrlType: "lan" }));
      return;
    }
    const ts = Number(url.searchParams.get("ts"));
    const ok = url.searchParams.get("sign") === signCtrlRequest(TOKEN, ts, url.searchParams.get("nonce") ?? "");
    res.end(JSON.stringify(ok ? { code: 200, data: { token: LOCAL_TOKEN, info: encryptBundle() } } : { code: 401 }));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  httpPort = (httpServer.address() as AddressInfo).port;

  broker = tls.createServer({ key: certificate.key, cert: certificate.cert }, (socket) => {
    const session: BrokerSession = { socket, connect: null, subscriptions: [], published: [] };
    const index = sessions.length;
    sessions.push(session);
    let buffer = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        let multiplier = 1;
        let length = 0;
        let offset = 1;
        let byte: number;
        do {
          if (offset >= buffer.length) return;
          byte = buffer[offset++];
          length += (byte & 0x7f) * multiplier;
          multiplier *= 128;
        } while (byte & 0x80);
        if (buffer.length < offset + length) return;
        const type = buffer[0];
        const body = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        handlePacket(session, index, type, body);
      }
    });
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  brokerPort = (broker.address() as AddressInfo).port;
});

afterEach(() => {
  shutdownAnycubicConnections();
  for (const session of sessions) session.socket.destroy();
  sessions = [];
  httpRequests = [];
  infoReplies = [];
  delete anycubicTestHooks.httpPort;
  delete anycubicTestHooks.timing;
});

after(async () => {
  if (certificate) {
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  }
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

function printer(overrides: Partial<PrinterConfig> = {}): PrinterConfig {
  return {
    id: "kobra-x",
    name: "Kobra X",
    model: "",
    type: "FDM",
    protocol: "anycubic-lan",
    host: "127.0.0.1",
    port: brokerPort,
    material: "",
    swatch: "",
    snapshotUrl: "",
    streamUrl: "",
    interfaceUrl: "",
    enabled: true,
    apiKey: "",
    serial: "",
    accessCode: "",
    allowInsecureTls: true,
    light: { ...DEFAULT_LIGHT_SETTINGS, enabled: false, statusField: "value", bambuNode: "" } as PrinterConfig["light"],
    ...overrides
  } as PrinterConfig;
}

async function until<T>(read: () => T, accept: (value: T) => boolean, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = read();
  while (!accept(value)) {
    if (Date.now() > deadline) assert.fail(`condition not reached; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = read();
  }
  return value;
}

const PRINTING = {
  type: "info",
  action: "query",
  code: 200,
  data: {
    state: "busy",
    version: "2.0.1.9",
    printerName: "Кобра у окна",
    temp: { curr_nozzle_temp: 209.7, target_nozzle_temp: 210, curr_hotbed_temp: 60.2, target_hotbed_temp: 60 },
    project: { state: "printing", pause: 0, filename: "part.gcode", taskid: "7", progress: 40, curr_layer: 20, total_layers: 50, remain_time: 30 }
  }
};
const IDLE = { type: "info", action: "query", code: 200, data: { state: "free", last_project: { state: "finished" } } };

test("handshake → TLS → MQTT → live status, over the production code path", { skip }, async () => {
  anycubicTestHooks.httpPort = httpPort;
  infoReplies = [PRINTING];
  const config = printer();

  const first = getAnycubicStatus(config);
  assert.equal(first.status, "unknown", "connecting is not offline and not a state");

  const live = await until(() => getAnycubicStatus(config), (s) => s.online && s.status === "printing");
  assert.equal(live.progressPct, 40);
  assert.deepEqual([live.currentLayer, live.totalLayers], [20, 50]);
  assert.deepEqual([live.nozzleTemp, live.bedTemp], [210, 60]);

  assert.deepEqual(httpRequests, ["GET /info", "POST /ctrl"]);
  const session = sessions[0];
  assert.deepEqual(
    { username: session.connect?.username, password: session.connect?.password },
    LOGIN,
    "the broker login is the decrypted bundle's"
  );
  assert.deepEqual(session.subscriptions, [`${REPORTS}/#`]);
  assert.ok(session.published.length >= 1);
  for (const message of session.published) {
    assert.equal(message.topic, `anycubic/anycubicCloud/v1/web/printer/20030/${DEVICE_ID}/info`);
    assert.ok(isReadOnlyQuery(JSON.parse(message.payload)), message.payload);
  }

  const discovered = discoverAnycubicFacts(config);
  assert.equal(discovered.succeeded, true);
  assert.equal(discovered.facts.model?.value, "Anycubic Kobra X");
  assert.equal(discovered.facts.firmware?.value, "2.0.1.9");
  assert.equal(discovered.facts.serialNumber?.value, "SN-KX-1");
  assert.deepEqual(discovered.facts.buildVolume?.value, { x: 260, y: 260, z: 260 });
  assert.equal(discovered.facts.buildVolume?.source, "catalog");
});

test("a dropped broker connection reads offline at once and recovers on reconnect", { skip }, async () => {
  anycubicTestHooks.httpPort = httpPort;
  anycubicTestHooks.timing = { reconnectBaseMs: 200, reconnectMaxMs: 400 };
  infoReplies = [PRINTING, IDLE];
  const config = printer();

  await until(() => getAnycubicStatus(config), (s) => s.online && s.status === "printing");
  sessions[0].socket.destroy(); // the printer reboots, Wi-Fi drops…

  const lost = await until(() => getAnycubicStatus(config), (s) => !s.online);
  assert.equal(lost.status, "offline");
  assert.equal(lost.progressPct, null, "the print from before the drop is not shown as current");
  assert.equal(
    discoverAnycubicFacts(config).succeeded,
    false,
    "a probe while the printer is away is a failed probe — the card keeps old facts, marked stale"
  );

  const back = await until(() => getAnycubicStatus(config), (s) => s.online);
  assert.equal(back.status, "idle");
  assert.equal(back.stateText, "finished");
  assert.equal(sessions.length, 2, "one reconnect, one new session");
  assert.deepEqual(httpRequests, ["GET /info", "POST /ctrl"], "the in-memory login was reused");
});

test("without the explicit TLS opt-in nothing is contacted at all", { skip }, async () => {
  anycubicTestHooks.httpPort = httpPort;
  const status = getAnycubicStatus(printer({ allowInsecureTls: false }));
  assert.equal(status.online, false);
  assert.equal(status.status, "offline");
  assert.match(status.error ?? "", /самоподписанный сертификат/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(httpRequests, []);
  assert.equal(sessions.length, 0);
});

test("changing the address or the TLS opt-in rebuilds the session from scratch", { skip }, async () => {
  anycubicTestHooks.httpPort = httpPort;
  infoReplies = [PRINTING];
  const config = printer();
  await until(() => getAnycubicStatus(config), (s) => s.online);

  // The operator withdraws the TLS opt-in: the live session must close.
  getAnycubicStatus(printer({ allowInsecureTls: false }));
  await until(() => sessions[0].socket.destroyed || sessions[0].socket.readableEnded, Boolean);

  dropAnycubicConnection("kobra-x");
  assert.equal(getAnycubicStatus(printer()).status, "unknown", "a dropped session starts over");
});
