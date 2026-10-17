import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, X509Certificate } from "node:crypto";
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
  readAnycubicBrokerCertificate,
  shutdownAnycubicConnections
} from "./index";
import { isReadOnlyQuery } from "./session";
import { isSelfSigned, openPinnedTls, TlsConnectError, TlsPinMismatchError } from "./tls";

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

/** The fake broker's certificate, as an operator would have confirmed it. */
const PIN = certificate ? new X509Certificate(certificate.cert).fingerprint256 : "";
/** A well-formed fingerprint of some other certificate. */
const OTHER = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";

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
  /** Application bytes the client wrote after the TLS handshake. */
  bytes: number;
}

let broker: tls.Server;
let brokerPort = 0;
let sessions: BrokerSession[] = [];
/**
 * TCP connections the broker accepted. Counted below TLS on purpose: a client
 * that closes right after its side of a TLS 1.3 handshake (which is what a pin
 * mismatch does) may never complete the server's side, so it would not show up
 * as a session at all.
 */
let tcpConnections = 0;
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
    const session: BrokerSession = { socket, connect: null, subscriptions: [], published: [], bytes: 0 };
    const index = sessions.length;
    sessions.push(session);
    let buffer = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      session.bytes += chunk.length;
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
  broker.on("connection", () => {
    tcpConnections += 1;
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  brokerPort = (broker.address() as AddressInfo).port;
});

afterEach(() => {
  shutdownAnycubicConnections();
  for (const session of sessions) session.socket.destroy();
  sessions = [];
  tcpConnections = 0;
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
    tlsFingerprint: PIN,
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

test("without a confirmed certificate nothing is contacted at all — the old TLS opt-in opens nothing", { skip }, async () => {
  anycubicTestHooks.httpPort = httpPort;
  for (const config of [printer({ tlsFingerprint: "" }), printer({ tlsFingerprint: "", allowInsecureTls: true })]) {
    const status = getAnycubicStatus(config);
    assert.equal(status.online, false);
    assert.equal(status.status, "offline");
    assert.match(status.error ?? "", /сертификат принтера не подтверждён/);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(httpRequests, []);
  assert.equal(sessions.length, 0);
});

test("a broker presenting another certificate is refused before the login is written, on every attempt", { skip }, async () => {
  anycubicTestHooks.httpPort = httpPort;
  anycubicTestHooks.timing = { reconnectBaseMs: 100, reconnectMaxMs: 200 };
  infoReplies = [PRINTING];
  const config = printer({ tlsFingerprint: OTHER });

  const refused = await until(() => getAnycubicStatus(config), (s) => s.status === "offline");
  assert.match(refused.error ?? "", /не совпадает с подтверждённым — подключение заблокировано/);
  assert.ok((refused.error ?? "").includes(PIN.slice(0, 11)), "names the certificate the broker presented");
  await until(() => tcpConnections, (n) => n >= 3);
  for (const session of sessions) {
    assert.equal(session.connect, null, "no MQTT CONNECT — the password never left");
    assert.equal(session.bytes, 0, "not one application byte after the handshake");
  }
  assert.equal(getAnycubicStatus(config).online, false, "and nothing was accepted in its place");
});

test("confirming a different certificate rebuilds the session, and a stale one stays blocked", { skip }, async () => {
  anycubicTestHooks.httpPort = httpPort;
  infoReplies = [PRINTING];
  await until(() => getAnycubicStatus(printer()), (s) => s.online);

  // The operator replaces the pin: the live session must close and the new pin rule.
  getAnycubicStatus(printer({ tlsFingerprint: OTHER }));
  await until(() => sessions[0].socket.destroyed || sessions[0].socket.readableEnded, Boolean);
  const blocked = await until(() => getAnycubicStatus(printer({ tlsFingerprint: OTHER })), (s) => s.status === "offline");
  assert.match(blocked.error ?? "", /не совпадает с подтверждённым/);

  dropAnycubicConnection("kobra-x");
  assert.equal(getAnycubicStatus(printer()).status, "unknown", "a dropped session starts over");
});

test("reading the broker certificate for the operator sends nothing and trusts nothing", { skip }, async () => {
  const certificate = await readAnycubicBrokerCertificate(printer({ tlsFingerprint: "" }));
  assert.equal(certificate.fingerprint256, PIN);
  assert.equal(certificate.subject, "CN=anycubic-test");
  assert.equal(certificate.selfSigned, true);
  await until(() => tcpConnections, (n) => n === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const session of sessions) {
    assert.equal(session.bytes, 0);
    assert.equal(session.connect, null);
  }
});

test("the pinned TLS opener refuses without a valid pin before touching the network", { skip }, async () => {
  for (const pin of ["", "not-a-fingerprint", PIN.slice(0, 20)]) {
    await assert.rejects(openPinnedTls("127.0.0.1", brokerPort, 2000, pin), TlsConnectError);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(tcpConnections, 0, "no connection was even opened");
  await assert.rejects(openPinnedTls("127.0.0.1", brokerPort, 2000, OTHER), TlsPinMismatchError);
  const stream = await openPinnedTls("127.0.0.1", brokerPort, 2000, PIN.toLowerCase().replaceAll(":", ""));
  stream.destroy();
  await until(() => tcpConnections, (n) => n === 2, 2000);
});

test("a certificate shaped like the printer's (no keyCertSign, no CA flag) still reads as self-signed", { skip }, () => {
  // The Kobra X broker's own profile: O=AnyCubic, serial 01, keyUsage
  // digitalSignature + keyEncipherment, nothing else.
  const config = path.join(workDir, "kobra-profile.cnf");
  fs.writeFileSync(
    config,
    "[req]\ndistinguished_name = dn\nx509_extensions = ext\nprompt = no\n[dn]\nO = AnyCubic\n" +
      "[ext]\nkeyUsage = digitalSignature, keyEncipherment\n"
  );
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-config", config, "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", path.join(workDir, "kobra-key.pem"), "-out", path.join(workDir, "kobra-cert.pem"),
      "-days", "2", "-set_serial", "1"
    ],
    { stdio: "ignore" }
  );
  const cert = new X509Certificate(fs.readFileSync(path.join(workDir, "kobra-cert.pem"), "utf8"));
  assert.equal(cert.checkIssued(cert), false, "OpenSSL's issuer check rejects it — the trap");
  assert.equal(isSelfSigned(cert), true);
  assert.equal(isSelfSigned(new X509Certificate(certificate!.cert)), true);
});
