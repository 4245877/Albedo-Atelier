import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, type Duplex } from "node:stream";
import { afterEach, beforeEach, mock, test } from "node:test";

import type { PrinterConfig } from "../config";
import { AnycubicHandshakeError, type AnycubicHandshakeResult } from "./handshake";
import {
  AnycubicSession,
  backoffDelay,
  buildReadQuery,
  DEFAULT_TIMING,
  isReadOnlyQuery,
  lanClientId,
  type AnycubicClientOptions,
  type AnycubicMqttClient,
  type AnycubicTransport
} from "./session";

/*
 * The session over a fake transport: no socket, no device. Timers are mocked, so
 * backoff and staleness are exercised in simulated time.
 */

const PRINTER = { id: "kobra-x", name: "Kobra X", host: "192.168.1.60" } as PrinterConfig;
const REPORTS = "anycubic/anycubicCloud/v1/printer/public/20030/dev1";
const CREDENTIALS = { username: "lan-user", password: "lan-secret-password", deviceId: "dev1", modelId: "20030" };
const HANDSHAKE: AnycubicHandshakeResult = {
  identity: { modelId: "20030", modelName: "Anycubic Kobra X", serialNumber: "SN1", deviceName: null },
  credentials: CREDENTIALS
};

class FakeClient extends EventEmitter implements AnycubicMqttClient {
  published: { topic: string; message: string }[] = [];
  subscribed: string[] = [];
  ended = false;
  constructor(readonly options: AnycubicClientOptions) {
    super();
  }
  subscribe(topic: string): void {
    this.subscribed.push(topic);
  }
  publish(topic: string, message: string, _options: unknown, callback?: () => void): void {
    this.published.push({ topic, message });
    callback?.();
  }
  end(): void {
    this.ended = true;
  }
  report(type: string, payload: unknown): void {
    this.emit("message", `${REPORTS}/${type}/report`, Buffer.from(JSON.stringify(payload)));
  }
}

interface Fake extends AnycubicTransport {
  handshakes: string[];
  clients: FakeClient[];
  handshakeResult: () => Promise<AnycubicHandshakeResult>;
}

function fakeTransport(): Fake {
  const fake: Fake = {
    handshakes: [],
    clients: [],
    handshakeResult: async () => HANDSHAKE,
    handshake: (_host, options) => {
      fake.handshakes.push(options.clientId);
      return fake.handshakeResult();
    },
    openTls: async () => new PassThrough() as Duplex,
    createClient: (_stream, options) => {
      const client = new FakeClient(options);
      fake.clients.push(client);
      return client;
    }
  };
  return fake;
}

let clock = Date.parse("2026-10-16T12:00:00.000Z");

beforeEach(() => {
  clock = Date.parse("2026-10-16T12:00:00.000Z");
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
});

afterEach(() => {
  mock.timers.reset();
});

/** Lets the session's awaited fake promises settle (setImmediate is not mocked). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Advances the session clock and the mocked timers together. */
async function advance(ms: number): Promise<void> {
  clock += ms;
  mock.timers.tick(ms);
  await settle();
}

function session(transport: AnycubicTransport): AnycubicSession {
  return new AnycubicSession({
    printerId: PRINTER.id,
    host: PRINTER.host,
    mqttPort: 9883,
    transport,
    now: () => clock,
    random: () => 0.5 // no jitter: backoff is exactly base·2^n
  });
}

const printingInfo = {
  type: "info",
  action: "query",
  data: {
    state: "busy",
    version: "2.0.1.9",
    temp: { curr_nozzle_temp: 210, target_nozzle_temp: 210, curr_hotbed_temp: 60, target_hotbed_temp: 60 },
    project: { state: "printing", pause: 0, filename: "part.gcode", taskid: "7", progress: 40, curr_layer: 20, total_layers: 50, remain_time: 30 }
  }
};

async function connected(transport: Fake): Promise<{ s: AnycubicSession; client: FakeClient }> {
  const s = session(transport);
  s.start();
  await settle();
  const client = transport.clients.at(-1)!;
  client.emit("connect");
  return { s, client };
}

test("connects with the handshake's login, subscribes to its reports, then waits for info", async () => {
  const transport = fakeTransport();
  const s = session(transport);
  assert.equal(s.status(PRINTER).status, "unknown", "before anything: unknown, not offline");

  s.start();
  s.start(); // idempotent
  await settle();
  assert.deepEqual(transport.handshakes, [lanClientId("kobra-x")], "one handshake, with the stable client id");
  assert.equal(transport.clients.length, 1, "one session, one client");
  const client = transport.clients[0];
  assert.equal(client.options.username, "lan-user");
  assert.equal(client.options.password, "lan-secret-password");
  assert.match(client.options.clientId, /^atelier_[0-9a-f]{8}$/);

  client.emit("connect");
  assert.deepEqual(client.subscribed, [`${REPORTS}/#`]);
  const waiting = s.status(PRINTER);
  assert.equal(waiting.online, false);
  assert.equal(waiting.status, "unknown", "a connection is not a confirmed job state");

  client.report("info", printingInfo);
  const live = s.status(PRINTER);
  assert.equal(live.online, true);
  assert.equal(live.status, "printing");
  assert.equal(live.progressPct, 40);
  assert.deepEqual([live.currentLayer, live.totalLayers], [20, 50]);
  assert.deepEqual(s.identity().reported.firmware, "2.0.1.9");
  s.stop();
});

test("the only thing ever published is a read-only info query", async () => {
  const transport = fakeTransport();
  const { s, client } = await connected(transport);
  client.report("info", printingInfo);
  // Pushes that make the session ask again, and periodic polls.
  client.report("status", { type: "status", action: "workReport", state: "free", data: null });
  await advance(DEFAULT_TIMING.infoQueryMs);
  client.report("print", { type: "print", data: { taskid: "99", progress: 1 } });
  await advance(DEFAULT_TIMING.infoQueryMs);

  assert.ok(client.published.length >= 3);
  for (const { topic, message } of client.published) {
    assert.equal(topic, "anycubic/anycubicCloud/v1/web/printer/20030/dev1/info");
    const parsed = JSON.parse(message) as unknown;
    assert.ok(isReadOnlyQuery(parsed), message);
  }
  s.stop();
});

test("the publish guard refuses every control message", () => {
  assert.equal(isReadOnlyQuery(buildReadQuery("info", 1, "m")), true);
  const controls = [
    { type: "print", action: "pause", timestamp: 1, msgid: "m", data: { taskid: "-1" } },
    { type: "print", action: "stop", timestamp: 1, msgid: "m", data: { taskid: "-1" } },
    { type: "print", action: "start", timestamp: 1, msgid: "m", data: { filename: "x.gcode" } },
    { type: "print", action: "update", timestamp: 1, msgid: "m", data: { settings: { target_nozzle_temp: 250 } } },
    { type: "light", action: "control", timestamp: 1, msgid: "m", data: { type: 2, status: 1, brightness: 100 } },
    { type: "video", action: "startCapture", timestamp: 1, msgid: "m", data: null },
    { type: "file", action: "deleteBatch", timestamp: 1, msgid: "m", data: { files: [] } },
    { type: "info", action: "query", timestamp: 1, msgid: "m", data: { anything: 1 } },
    { type: "info", action: "query", timestamp: 1, msgid: "m", data: null, extra: "smuggled" },
    { type: "tempature", action: "query", timestamp: 1, msgid: "m", data: null }
  ];
  for (const message of controls) assert.equal(isReadOnlyQuery(message), false, JSON.stringify(message));
});

test("a lost connection drops the old job at once and reconnects with backoff", async () => {
  const transport = fakeTransport();
  const { s, client } = await connected(transport);
  client.report("info", printingInfo);
  assert.equal(s.status(PRINTER).status, "printing");

  client.emit("close");
  const lost = s.status(PRINTER);
  assert.equal(lost.online, false);
  assert.equal(lost.status, "offline");
  assert.equal(lost.progressPct, null, "nothing from the dead connection is presented as current");
  assert.match(lost.error ?? "", /соединение потеряно/);
  assert.equal(client.ended, true);

  await advance(DEFAULT_TIMING.reconnectBaseMs - 1);
  assert.equal(transport.clients.length, 1, "no reconnect before the backoff");
  await advance(1);
  assert.equal(transport.clients.length, 2, "reconnected after 5 s");
  assert.equal(transport.handshakes.length, 1, "the in-memory login is reused while it works");

  const second = transport.clients[1];
  second.emit("connect");
  // A late message from the superseded client must not touch the new state.
  client.report("info", printingInfo);
  assert.equal(s.status(PRINTER).status, "unknown", "only the new connection's info counts");
  second.report("info", { type: "info", data: { state: "free", last_project: { state: "finished" } } });
  const recovered = s.status(PRINTER);
  assert.equal(recovered.online, true);
  assert.equal(recovered.status, "idle");
  s.stop();
});

test("refused credentials are forgotten and re-learned by a fresh handshake", async () => {
  const transport = fakeTransport();
  const s = session(transport);
  s.start();
  await settle();
  const client = transport.clients[0];
  client.emit("error", Object.assign(new Error("Connection refused: Not authorized"), { code: 5 }));
  const refused = s.status(PRINTER);
  assert.equal(refused.status, "offline");
  assert.match(refused.error ?? "", /отклонил учётные данные/);
  assert.equal(client.ended, true, "the refused attempt is closed, not left hanging");

  await advance(DEFAULT_TIMING.reconnectBaseMs);
  assert.equal(transport.handshakes.length, 2, "a new handshake, not a retry with the refused login");
  s.stop();
});

test("an unreachable printer backs off exponentially up to the cap — never a tight loop", async () => {
  const transport = fakeTransport();
  transport.handshakeResult = async () => {
    throw new AnycubicHandshakeError("принтер недоступен по HTTP (/info: EHOSTUNREACH)", "unreachable");
  };
  const s = session(transport);
  s.start();
  await settle();
  assert.equal(transport.handshakes.length, 1);
  assert.match(s.status(PRINTER).error ?? "", /EHOSTUNREACH/);

  // Ten minutes of a dead printer: 5, 10, 20, 40, 80, 160, 300, … seconds apart.
  await advance(10 * 60_000);
  assert.ok(transport.handshakes.length <= 8, `attempts: ${transport.handshakes.length}`);
  const delays = [1, 2, 3, 4, 5, 6, 7, 8, 12].map((n) => backoffDelay(n, DEFAULT_TIMING, 0.5));
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
  s.stop();
});

test("a broker that never acknowledges times out instead of hanging", async () => {
  const transport = fakeTransport();
  const s = session(transport);
  s.start();
  await settle();
  assert.equal(s.status(PRINTER).status, "unknown");
  await advance(DEFAULT_TIMING.connackTimeoutMs);
  const status = s.status(PRINTER);
  assert.equal(status.status, "offline");
  assert.match(status.error ?? "", /не подтвердил подключение/);
  assert.equal(transport.clients[0].ended, true);
  s.stop();
});

test("a silent broker is replaced: no info for too long → reconnect", async () => {
  const transport = fakeTransport();
  const { s, client } = await connected(transport);
  client.report("info", printingInfo);
  // The printer stops answering; the socket stays up.
  await advance(60_000 + 1);
  assert.equal(s.status(PRINTER).status, "offline", "stale after 60 s");
  await advance(70_000);
  assert.equal(client.ended, true, "the watchdog closed the silent connection");
  await advance(DEFAULT_TIMING.reconnectMaxMs);
  assert.ok(transport.clients.length >= 2, "and a fresh one was opened");
  s.stop();
});

test("status never waits on the network", async () => {
  const transport = fakeTransport();
  transport.handshakeResult = () => new Promise(() => {}); // a printer that never answers
  const s = session(transport);
  s.start();
  const started = performance.now();
  const status = s.status(PRINTER);
  assert.ok(performance.now() - started < 50);
  assert.equal(status.status, "unknown");
  s.stop();
});

test("stop ends the session for good", async () => {
  const transport = fakeTransport();
  const { s, client } = await connected(transport);
  client.report("info", printingInfo);
  s.stop();
  assert.equal(client.ended, true);
  client.emit("close"); // the close of a stopped session schedules nothing
  await advance(DEFAULT_TIMING.reconnectMaxMs * 2);
  assert.equal(transport.clients.length, 1);
  assert.equal(transport.handshakes.length, 1);
  assert.equal(s.state, "stopped");
});

test("no status or error ever carries the broker login", async () => {
  const transport = fakeTransport();
  const { s, client } = await connected(transport);
  const seen: string[] = [JSON.stringify(s.status(PRINTER))];
  client.report("info", printingInfo);
  seen.push(JSON.stringify(s.status(PRINTER)));
  client.emit("error", Object.assign(new Error(`bad ${CREDENTIALS.password}`), { code: "ECONNRESET" }));
  client.emit("close");
  seen.push(JSON.stringify(s.status(PRINTER)));
  for (const text of seen) {
    assert.ok(!text.includes(CREDENTIALS.password), text);
    assert.ok(!text.includes(CREDENTIALS.username), text);
  }
  s.stop();
});

test("the LAN client id is stable per printer and shaped like the vendor's", () => {
  assert.equal(lanClientId("kobra-x"), lanClientId("kobra-x"));
  assert.notEqual(lanClientId("kobra-x"), lanClientId("kobra-x-2"));
  assert.match(lanClientId("kobra-x"), /^[0-9A-F]{32}$/);
});

test("nothing thrown inside a listener escapes into the process", async () => {
  const transport = fakeTransport();
  const { s, client } = await connected(transport);
  client.report("info", printingInfo);

  // A malformed event (a topic that is not text) is dropped, not thrown.
  assert.doesNotThrow(() => client.emit("message", 42 as unknown as string, Buffer.from("{}")));
  assert.equal(s.status(PRINTER).status, "printing", "one bad report changes nothing");

  // A failure while handling the connection itself tears it down and retries.
  const second = await (async () => {
    client.emit("close");
    await advance(DEFAULT_TIMING.reconnectBaseMs);
    return transport.clients[1];
  })();
  second.subscribe = () => {
    throw new Error("broken client");
  };
  assert.doesNotThrow(() => second.emit("connect"));
  const status = s.status(PRINTER);
  assert.equal(status.status, "offline");
  assert.match(status.error ?? "", /внутренняя ошибка/);
  assert.equal(second.ended, true);
  await advance(DEFAULT_TIMING.reconnectBaseMs * 2);
  assert.equal(transport.clients.length, 3, "and the session tried again");
  s.stop();
});
