import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";

import mqtt from "mqtt";
import { isObject } from "../../../shared/isObject";
import { KeyedMutex } from "../../../shared/keyedMutex";

import type { PrinterConfig } from "../config";
import { makeOfflineStatus } from "../status/mapper";
import { PrinterCommandError, type PrinterCommand, type PrinterLiveStatus } from "../status/types";
import { isFileReadRequest, isLightCommand, isPrintControlCommand, type AnycubicRequest, type AnycubicStorage } from "./requests";
import { anycubicPrivateUrl } from "./urls";
import { isPreparedAnycubicStart, type AnycubicPreparedStart } from "./start";
import {
  AnycubicHandshakeError,
  networkCode,
  performAnycubicHandshake,
  type AnycubicCredentials,
  type AnycubicDeviceIdentity,
  type AnycubicHandshakeResult
} from "./handshake";
import {
  applyProgress,
  buildAnycubicStatus,
  endsJob,
  JOB_STATE_MAX_AGE_MS,
  lifecycleOf,
  parseInfoReport,
  parsePrintEnding,
  parsePrintReport,
  parseStatusReport,
  parseTemperatureReport,
  queryTopic,
  reportSubscription,
  reportTypeOf,
  type AnycubicObservation,
  type AnycubicReportedIdentity,
  type AnycubicTemperatures
} from "./reports";
import { openPinnedTls, TlsConnectError, TlsPinMismatchError } from "./tls";

/**
 * One live LAN session with one Anycubic printer: handshake → TLS → MQTT, the
 * reports that arrive over it, and the read queries that keep them coming.
 *
 * The rules it keeps:
 *
 *  - **separate publication guards.** Payload-free telemetry queries and
 *    file reads each have an allowlist. Physical light,
 *    print and file-write categories each require an explicit, separate gate;
 *    neither read guard can authorize a physical command;
 *  - **one session per printer, never two in flight.** A connection attempt or a
 *    live connection belongs to a generation; tearing down bumps it, so a late
 *    callback of a superseded socket cannot touch the state;
 *  - **bounded retries.** A failure waits 5 s, doubling to 5 min, with jitter —
 *    a printer switched off for a week costs one attempt every five minutes,
 *    never a tight loop, and never a blocked poll (every network step runs in
 *    the background; {@link status} only reads memory);
 *  - **old data is never presented as current.** Losing the connection clears
 *    the job and the temperatures; a job state `info` has not re-confirmed for
 *    {@link JOB_STATE_MAX_AGE_MS} reads offline (see `buildAnycubicStatus`);
 *  - **credentials in memory only.** Re-learned by handshake after a restart, a
 *    configuration change or an authentication failure; never persisted, never
 *    logged, never part of a status or an error.
 *
 * TLS: the broker's certificate is self-signed with no CA, so every
 * connection — first and reconnect alike — must present exactly the certificate
 * the operator confirmed (`tlsFingerprint`, see `./tls.ts`); the registry starts
 * no session without one, and there is no unverified fallback. The check is made
 * *before* the MQTT client exists, so the password is never written to a socket
 * that presented anything else.
 */

export const ANYCUBIC_MQTT_PORT = 9883;

/** Payload-free telemetry reads, separate from files and physical commands. */
export const READ_ONLY_QUERIES = ["info", "light", "peripherie"] as const;
export type AnycubicReadQuery = (typeof READ_ONLY_QUERIES)[number];

export interface AnycubicQueryMessage {
  type: AnycubicReadQuery;
  action: "query";
  timestamp: number;
  msgid: string;
  data: null;
}

export function buildReadQuery(type: AnycubicReadQuery, timestamp: number, msgid: string): AnycubicQueryMessage {
  return { type, action: "query", timestamp, msgid, data: null };
}

/**
 * The telemetry guard: true only for a query from {@link READ_ONLY_QUERIES}
 * with no payload. File reads and physical commands have separate guards.
 */
export function isReadOnlyQuery(message: unknown): message is AnycubicQueryMessage {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return false;
  const m = message as Record<string, unknown>;
  return (
    (READ_ONLY_QUERIES as readonly unknown[]).includes(m.type) &&
    m.action === "query" &&
    m.data === null &&
    typeof m.timestamp === "number" && Number.isFinite(m.timestamp) &&
    typeof m.msgid === "string" && m.msgid.length > 0 && m.msgid.length <= 128 &&
    Object.keys(m).every((key) => ["type", "action", "timestamp", "msgid", "data"].includes(key))
  );
}

/** What the session needs from MQTT — the part of `MqttClient` it uses. */
export interface AnycubicMqttClient extends EventEmitter {
  subscribe(topic: string, options: { qos: 0 }, callback?: (error?: Error | null) => void): unknown;
  publish(
    topic: string,
    message: string,
    options: { qos: 0; retain: false },
    callback?: (error?: Error) => void
  ): unknown;
  end(force?: boolean, callback?: () => void): unknown;
}

export interface AnycubicClientOptions {
  clientId: string;
  username: string;
  password: string;
  keepalive: number;
  connectTimeout: number;
}

/** The network edges, injectable so tests never open a socket to a real device. */
export interface AnycubicTransport {
  handshake(host: string, options: { clientId: string; httpPort?: number }): Promise<AnycubicHandshakeResult>;
  /**
   * Resolves with a TLS stream whose broker presented exactly the `fingerprint`
   * certificate; rejects, having written nothing, for any other.
   */
  openTls(host: string, port: number, timeoutMs: number, fingerprint: string): Promise<Duplex>;
  /** An MQTT client over an already-established stream. */
  createClient(stream: Duplex, options: AnycubicClientOptions): AnycubicMqttClient;
}

export interface AnycubicTiming {
  /** How often `info` is queried while connected. */
  infoQueryMs: number;
  /** The soonest an extra `info` query may follow another. */
  refreshMinMs: number;
  tlsTimeoutMs: number;
  connackTimeoutMs: number;
  keepaliveS: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

export const DEFAULT_TIMING: AnycubicTiming = {
  infoQueryMs: 20_000,
  refreshMinMs: 5_000,
  tlsTimeoutMs: 6_000,
  connackTimeoutMs: 8_000,
  keepaliveS: 30,
  reconnectBaseMs: 5_000,
  reconnectMaxMs: 300_000
};

export interface AnycubicSessionOptions {
  printerId: string;
  host: string;
  mqttPort: number;
  /** The confirmed broker certificate (canonical SHA-256); every connection must present it. */
  tlsFingerprint: string;
  /** Only for tests; production uses the protocol's 18910. */
  httpPort?: number;
  transport?: AnycubicTransport;
  timing?: Partial<AnycubicTiming>;
  now?: () => number;
  random?: () => number;
  /** Separate physical categories; omitted means no physical command may leave. */
  controls?: { light?: boolean; print?: boolean; upload?: boolean; start?: boolean };
  confirmationPollMs?: number;
}

/** What the session knows about the device itself, for hardware discovery. */
export interface AnycubicIdentitySnapshot {
  /** From the handshake's `/info`; null until one succeeded. */
  device: AnycubicDeviceIdentity | null;
  /** From `info` reports; fields stay null until reported. */
  reported: AnycubicReportedIdentity;
}

type Phase = "idle" | "connecting" | "connected" | "backoff" | "stopped";

const MAX_REPORT_BYTES = 512 * 1024;

export interface AnycubicPeripheral {
  cameraPresent: boolean | null;
  usbPresent: boolean | null;
}

interface PendingRead {
  type: string;
  action: string;
  matches: (reply: Record<string, unknown>) => boolean;
  resolve: (reply: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AnycubicSession {
  private readonly transport: AnycubicTransport;
  private readonly timing: AnycubicTiming;
  private readonly now: () => number;
  private readonly random: () => number;

  private phase: Phase = "idle";
  /** Bumped whenever a connection is abandoned; callbacks of older generations are ignored. */
  private generation = 0;
  private failures = 0;
  private lastError: string | null = null;
  private credentials: AnycubicCredentials | null = null;
  private device: AnycubicDeviceIdentity | null = null;
  private reported: AnycubicReportedIdentity = { printerName: null, model: null, firmware: null };
  private observation: AnycubicObservation = emptyObservation();
  private client: AnycubicMqttClient | null = null;
  private stream: Duplex | null = null;
  private connectedAt = 0;
  private lastQueryAt = 0;
  private lastLightQueryAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connackTimer: ReturnType<typeof setTimeout> | null = null;
  private queryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly fileReads = new KeyedMutex();
  private readonly reads = new KeyedMutex();
  private pendingReads = new Set<PendingRead>();
  private lightReport: { on: boolean; observedAt: number } | null = null;
  private cameraUrl: string | null = null;
  private uploadUrl: string | null = null;
  private uncertainStart = false;
  private cameraDisconnect: (() => void) | null = null;
  private jobKey: string | null = null;
  private jobElapsed: number | null = null;
  private uncertainPrint: { key: string; command: PrinterCommand } | null = null;
  private readonly controls = new KeyedMutex();

  constructor(private readonly options: AnycubicSessionOptions) {
    this.transport = options.transport ?? DEFAULT_TRANSPORT;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /** Starts connecting if nothing is running yet. Idempotent and non-blocking. */
  start(): void {
    if (this.phase !== "idle") return;
    void this.connect(++this.generation);
  }

  /** Ends the session for good: no reconnect, nothing kept. */
  stop(): void {
    this.phase = "stopped";
    this.generation += 1;
    this.teardown();
    this.clearTimer("reconnect");
    this.credentials = null;
    this.observation = emptyObservation();
  }

  /** The live status, from memory. Never touches the network. */
  status(printer: PrinterConfig): PrinterLiveStatus {
    if (this.phase === "connected") {
      const status = buildAnycubicStatus(printer, this.observation, this.now());
      status.controlJobKey = status.online && ["printing", "paused"].includes(status.status) ? this.jobKey : null;
      if (status.online && this.lightReport && this.now() - this.lightReport.observedAt <= JOB_STATE_MAX_AGE_MS) {
        status.light = this.lightReport.on;
      }
      return status;
    }
    if (this.lastError === null) {
      // Not failed yet — just not there yet. Unknown, like a Bambu awaiting its
      // first report: neither "offline" nor anything a lifecycle may act on.
      return { ...makeOfflineStatus(printer, "Anycubic LAN: подключение к принтеру…"), status: "unknown" };
    }
    return makeOfflineStatus(printer, this.lastError);
  }

  identity(): AnycubicIdentitySnapshot {
    return { device: this.device, reported: { ...this.reported } };
  }

  /** For tests and diagnostics: the session's phase. */
  get state(): Phase {
    return this.phase;
  }

  withFileRead<T>(task: () => Promise<T>): Promise<T> {
    return this.fileReads.run("files", task);
  }

  readFilePage(storage: AnycubicStorage, path: string, page: number, size: number): Promise<Record<string, unknown>> {
    return this.requestRead("file", storage === "local" ? "listLocal" : "listUdisk", { path, page_num: page, page_size: size });
  }

  readFileDetails(storage: AnycubicStorage, filename: string): Promise<Record<string, unknown>> {
    return this.withFileRead(() => this.requestRead("file", "fileDetails", { root: storage === "local" ? "local" : "udisk", filename },
      (reply) => isObject(reply.data) && reply.data.filename === filename && reply.data.root === (storage === "local" ? "local" : "udisk")));
  }

  async readPeripheral(): Promise<AnycubicPeripheral> {
    const reply = await this.requestRead("peripherie", "query", null);
    const data = isObject(reply.data) ? reply.data : {};
    return { cameraPresent: bit(data.camera), usbPresent: bit(data.udisk) };
  }

  async readLight(): Promise<boolean> {
    const reply = await this.requestRead("light", "query", null);
    const on = parseLight(reply);
    if (on === null) throw new PrinterCommandError("Anycubic LAN: состояние подсветки не получено");
    return on;
  }

  async refreshInfo(): Promise<void> {
    await this.requestRead("info", "query", null, (reply) => Boolean(parseInfoReport(reply)?.job));
  }

  async uploadAddress(): Promise<string> {
    this.requireControl("upload");
    await this.refreshInfo();
    this.requireControl("upload");
    if (this.observation.job?.work !== "free" || !this.uploadUrl) throw new PrinterCommandError("Anycubic LAN: для загрузки требуется свободный принтер и актуальный адрес", true);
    return this.uploadUrl;
  }

  /** Called only through the common start driver after DeviceArtifact dispatch admission. */
  async startPreparedFile(data: AnycubicPreparedStart): Promise<void> {
    return this.controls.run("print", async () => {
      this.requireControl("start");
      if (!isPreparedAnycubicStart(data)) throw new PrinterCommandError("Anycubic LAN: некорректный запрос запуска", true);
      if (this.uncertainStart) throw new PrinterCommandError("Anycubic LAN: предыдущий запуск не подтверждён — повтор запрещён", true);
      await this.refreshInfo();
      this.requireControl("start");
      if (this.observation.job?.work !== "free") throw new PrinterCommandError("Anycubic LAN: запуск разрешён только из idle", true);
      const reply = await this.readFilePage("local", "/", 1, 200);
      const records = isObject(reply.data) && Array.isArray(reply.data.records) ? reply.data.records : [];
      if (!isObject(reply.data) || reply.data.list_mode !== 0 || records.filter(r => isObject(r) && r.filename === data.filename && r.is_dir === false && r.size === data.filesize).length !== 1) {
        throw new PrinterCommandError("Anycubic LAN: файл запуска с ожидаемым именем и размером отсутствует", true);
      }
      await this.refreshInfo();
      this.requireControl("start");
      if (this.observation.job?.work !== "free") throw new PrinterCommandError("Anycubic LAN: принтер стал занят перед запуском", true);
      // Existing PrinterCommandService owns the durable start guard. This is
      // only an additional transport hold, including on lost response/reconnect.
      this.uncertainStart = true;
      const credentials = this.credentials!;
      const topic = `anycubic/anycubicCloud/v1/slicer/printer/${credentials.modelId}/${credentials.deviceId}/print`;
      try {
        this.client!.publish(topic, JSON.stringify({ type: "print", action: "start", data, timestamp: this.now(), msgid: randomUUID() }), { qos: 0, retain: false }, () => {});
      } catch { throw new PrinterCommandError("Anycubic LAN: исход отправки запуска неизвестен — повтор запрещён"); }
      for (let i = 0; i < 12; i++) {
        await this.refreshInfo();
        const job = this.observation.job;
        if (job?.work === "busy" && job.file?.split("/").at(-1) === data.filename && lifecycleOf(job) === "printing") {
          this.uncertainStart = false;
          return;
        }
        if (job?.work === "busy") break;
        await this.controlPollDelay();
      }
      throw new PrinterCommandError("Anycubic LAN: реальный старт не подтверждён — повтор запрещён");
    });
  }

  async setLight(on: boolean): Promise<void> {
    return this.controls.run("light", async () => {
      this.requireControl("light");
      await this.refreshInfo();
      this.requireControl("light");
      if (await this.readLight() === on) return;
      await this.publishControl("light", "light", "control", { type: 3, status: on ? 1 : 0, brightness: on ? 100 : 0 });
      for (let i = 0; i < 6; i++) {
        if (await this.readLight() === on) return;
        await this.controlPollDelay();
      }
      throw new PrinterCommandError("Anycubic LAN: принтер не подтвердил изменение подсветки");
    });
  }

  async controlPrint(command: PrinterCommand, expectedJobKey?: string): Promise<void> {
    return this.controls.run("print", async () => {
      this.requireControl("print");
      await this.refreshInfo();
      this.requireControl("print");
      const job = this.observation.job;
      const key = this.jobKey;
      if (!key || !expectedJobKey || key !== expectedJobKey || !job?.file) {
        throw new PrinterCommandError("Anycubic LAN: печать изменилась — обновите карточку перед командой", true);
      }
      if (this.uncertainPrint?.key === key) {
        const previous = this.uncertainPrint.command;
        const confirmed = previous === "pause" ? job.phase === "paused" && job.pauseCode === 1
          : previous === "resume" && job.phase === "printing" && job.pauseCode === 0;
        if (!confirmed) throw new PrinterCommandError("Anycubic LAN: результат предыдущей команды неизвестен — повторная отправка заблокирована", true);
        // A late factual report settles the earlier intent without resending it.
        // The operator can then issue the next action for that same print.
        this.uncertainPrint = null;
        if (command === previous) return;
      }
      if (job.work !== "busy" || (command === "pause" ? job.phase !== "printing" : command === "resume" ? job.phase !== "paused" : !["printing", "paused"].includes(job.phase ?? ""))) {
        throw new PrinterCommandError("Anycubic LAN: текущее состояние не допускает эту команду", true);
      }
      const file = job.file;
      // This hold precedes the send and survives connection loss. No timeout retries.
      this.uncertainPrint = { key, command };
      await this.publishControl("print", "print", command === "cancel" ? "stop" : command, { taskid: job.taskId ?? "-1" });
      for (let i = 0; i < 6; i++) {
        await this.refreshInfo();
        const next = this.observation.job;
        // last_project may still describe an older print. Only the ending
        // matched to the job in hand, followed by free, confirms this stop.
        const stopped = next?.work === "free" && this.observation.ending === "stoped";
        const same = this.jobKey === key && next?.file === file && next.work === "busy";
        const confirmed = command === "cancel" ? stopped : same && (command === "pause" ? next.phase === "paused" && next.pauseCode === 1 : next.phase === "printing" && next.pauseCode === 0);
        if (confirmed) { this.uncertainPrint = null; return; }
        if (!same && !(command === "cancel" && next?.work === "free")) break;
        await this.controlPollDelay();
      }
      throw new PrinterCommandError("Anycubic LAN: выполнение команды печати не подтверждено; повтор запрещён до проверки состояния");
    });
  }

  private requireControl(category: "light" | "print" | "upload" | "start"): void {
    if (!this.options.controls?.[category]) throw new PrinterCommandError("Anycubic LAN: эта категория управления ещё не разрешена после аппаратной проверки", true);
    if (this.phase !== "connected" || this.device?.modelId !== "20030" || this.reported.firmware !== "2.0.2.2" ||
        this.observation.jobObservedAt === null || this.now() - this.observation.jobObservedAt > JOB_STATE_MAX_AGE_MS ||
        !this.observation.job || ["unknown", "offline", "error"].includes(lifecycleOf(this.observation.job))) {
      throw new PrinterCommandError("Anycubic LAN: нет актуального подтверждённого состояния совместимого Kobra X", true);
    }
  }

  private publishControl(category: "light" | "print", type: string, action: string, data: unknown): Promise<void> {
    this.requireControl(category);
    const message: AnycubicRequest = { type, action, data, timestamp: this.now(), msgid: randomUUID() };
    if (!(category === "light" ? isLightCommand(message) : isPrintControlCommand(message))) {
      return Promise.reject(new PrinterCommandError("Anycubic LAN: управляющая команда запрещена", true));
    }
    const client = this.client!;
    const credentials = this.credentials!;
    // The callback only confirms transport delivery. Callers must read the
    // resulting device state before reporting any physical success.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new PrinterCommandError("Anycubic LAN: исход отправки команды неизвестен")), 8000);
      try {
        client.publish(queryTopic(credentials.modelId, credentials.deviceId, type), JSON.stringify(message), { qos: 0, retain: false }, (error) => {
          clearTimeout(timer);
          if (error) reject(new PrinterCommandError("Anycubic LAN: исход отправки команды неизвестен"));
          else resolve();
        });
      } catch { clearTimeout(timer); reject(new PrinterCommandError("Anycubic LAN: исход отправки команды неизвестен")); }
    });
  }

  private controlPollDelay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.options.confirmationPollMs ?? 500));
  }

  /** Private upstream lease for go2rtc. No video command is issued, even on reconnect. */
  leaseCameraSource(onDisconnect: () => void): { url: string; release: () => void } {
    if (this.phase !== "connected" || this.device?.modelId !== "20030" || !this.cameraUrl ||
        this.observation.jobObservedAt === null || this.now() - this.observation.jobObservedAt > JOB_STATE_MAX_AGE_MS) {
      throw new PrinterCommandError("Anycubic LAN: адрес камеры сейчас недоступен");
    }
    if (this.cameraDisconnect) throw new PrinterCommandError("Anycubic LAN: видеопоток уже обслуживается go2rtc");
    this.cameraDisconnect = onDisconnect;
    return { url: this.cameraUrl, release: () => {
      if (this.cameraDisconnect === onDisconnect) this.cameraDisconnect = null;
    } };
  }

  /**
   * Firmware 2.0.2.2 replaces msgid. Serialize by report type/action, require the
   * actual device report, and discard the socket on timeout: a late answer must
   * never satisfy the next request. The generic /response ACK is never read.
   */
  private requestRead(type: string, action: string, data: unknown, matches: PendingRead["matches"] = () => true): Promise<Record<string, unknown>> {
    return this.reads.run(type, () => new Promise((resolve, reject) => {
      const message = { type, action, data, timestamp: this.now(), msgid: randomUUID() };
      if (!(isReadOnlyQuery(message) || isFileReadRequest(message))) {
        reject(new PrinterCommandError("Anycubic LAN: запрос чтения запрещён", true));
        return;
      }
      const client = this.client;
      const credentials = this.credentials;
      if (this.phase !== "connected" || !client || !credentials) {
        reject(new PrinterCommandError("Anycubic LAN: дождитесь подключения к принтеру", true));
        return;
      }
      const generation = this.generation;
      const pending: PendingRead = { type, action, matches, resolve, reject, timer: setTimeout(() => {
        this.fail(generation, "Anycubic LAN: таймаут ответа — переподключение");
      }, 8000) };
      this.pendingReads.add(pending);
      try {
        client.publish(queryTopic(credentials.modelId, credentials.deviceId, type), JSON.stringify(message), { qos: 0, retain: false }, (error) => {
          if (error) this.fail(generation, "Anycubic LAN: ошибка отправки запроса — переподключение");
        });
      } catch {
        this.fail(generation, "Anycubic LAN: ошибка отправки запроса — переподключение");
      }
    }));
  }

  private resolveRead(type: string, json: unknown): void {
    if (!isObject(json) || json.type !== type) return;
    for (const pending of this.pendingReads) {
      const action = type === "info" && json.action === "report" ? "query" : json.action;
      if (pending.type !== type || pending.action !== action) continue;
      if (json.code === 200 && !pending.matches(json)) continue;
      clearTimeout(pending.timer);
      this.pendingReads.delete(pending);
      if (json.code !== 200 || json.state === "failed") {
        const code = typeof json.code === "number" ? json.code : "unknown";
        pending.reject(new PrinterCommandError(`Anycubic LAN: запрос ${pending.action} отклонён (код ${code})`, true));
      } else pending.resolve(json);
    }
  }

  // ── Connecting ─────────────────────────────────────────────────────────────

  private async connect(generation: number): Promise<void> {
    this.phase = "connecting";
    const { host, mqttPort, httpPort } = this.options;
    try {
      if (!this.credentials) {
        const result = await this.transport.handshake(host, {
          clientId: lanClientId(this.options.printerId),
          httpPort
        });
        if (generation !== this.generation) return;
        this.credentials = result.credentials;
        this.device = result.identity;
      }

      const stream = await this.transport.openTls(
        host,
        mqttPort,
        this.timing.tlsTimeoutMs,
        this.options.tlsFingerprint
      );
      if (generation !== this.generation) {
        stream.destroy();
        return;
      }
      this.stream = stream;
      // A stream error is reported through the client's `close`; this listener
      // only guarantees an unhandled 'error' can never take the process down.
      stream.on("error", () => {});

      const credentials = this.credentials;
      const client = this.transport.createClient(stream, {
        clientId: `atelier_${randomBytes(4).toString("hex")}`,
        username: credentials.username,
        password: credentials.password,
        keepalive: this.timing.keepaliveS,
        connectTimeout: this.timing.connackTimeoutMs
      });
      this.client = client;
      this.connackTimer = setTimeout(() => {
        if (generation === this.generation && this.phase === "connecting") {
          this.fail(generation, "Anycubic LAN: брокер MQTT не подтвердил подключение (таймаут)");
        }
      }, this.timing.connackTimeoutMs);
      this.connackTimer.unref?.();

      // Every listener is guarded: an exception escaping an EventEmitter listener
      // inside mqtt.js would be an uncaught exception — the whole orchestrator,
      // every other printer included, for one malformed report from this one.
      client.on("connect", () =>
        this.guarded(generation, () => this.onConnected(generation, credentials), true)
      );
      client.on("message", (topic: string, payload: Buffer, packet?: { retain?: boolean }) =>
        this.guarded(generation, () => { if (!packet?.retain) this.onMessage(generation, topic, payload); }, false)
      );
      client.on("error", (error: unknown) =>
        this.guarded(generation, () => this.onClientError(generation, error), true)
      );
      client.on("close", () =>
        this.guarded(
          generation,
          () => {
            if (generation !== this.generation) return;
            this.fail(generation, this.phase === "connected" ? "Anycubic LAN: соединение потеряно" : null);
          },
          true
        )
      );
    } catch (error) {
      if (generation !== this.generation) return;
      this.fail(generation, describeConnectError(error));
    }
  }

  private onConnected(generation: number, credentials: AnycubicCredentials): void {
    if (generation !== this.generation) return;
    this.clearTimer("connack");
    this.phase = "connected";
    this.failures = 0;
    this.lastError = null;
    this.connectedAt = this.now();
    this.client?.subscribe(reportSubscription(credentials.modelId, credentials.deviceId), { qos: 0 });
    this.query("info");
    this.queryTimer = setInterval(() => this.guarded(generation, () => this.tick(generation), true), this.timing.infoQueryMs);
    this.queryTimer.unref?.();
  }

  /**
   * Runs a callback from the network or a timer so nothing it throws can escape
   * into the process. A failure in connection handling tears the connection
   * down (`restart`); a failure on one report only drops that report.
   */
  private guarded(generation: number, task: () => void, restart: boolean): void {
    try {
      task();
    } catch {
      if (restart) {
        try {
          this.fail(generation, "Anycubic LAN: внутренняя ошибка обработки соединения — переподключение");
        } catch {
          // nothing more can be done safely here
        }
      }
    }
  }

  /** The periodic `info` query, and the watchdog for a broker that stopped answering. */
  private tick(generation: number): void {
    if (generation !== this.generation || this.phase !== "connected") return;
    const confirmedAt = this.observation.jobObservedAt ?? this.connectedAt;
    if (this.now() - confirmedAt > JOB_STATE_MAX_AGE_MS * 2) {
      // Connected but silent: a live socket to a printer that no longer answers
      // is worth less than a fresh attempt.
      this.fail(generation, "Anycubic LAN: принтер перестал отвечать на запросы состояния");
      return;
    }
    this.query("info");
    if (this.reported.firmware === "2.0.2.2") this.query("light");
  }

  private onClientError(generation: number, error: unknown): void {
    if (generation !== this.generation) return;
    const code = (error as { code?: unknown })?.code;
    // A refused CONNACK (mqtt.js reports its return code as a number) ends the
    // attempt now: the client does not close the connection by itself.
    if (code === 4 || code === 5) {
      // The broker refused these credentials. They came from a handshake; the
      // next attempt performs a fresh one.
      this.credentials = null;
      this.fail(
        generation,
        "Anycubic LAN: брокер MQTT отклонил учётные данные LAN-доступа — они будут запрошены у принтера заново"
      );
      return;
    }
    if (typeof code === "number") {
      this.fail(generation, `Anycubic LAN: брокер MQTT отклонил подключение (код ${code})`);
      return;
    }
    // Anything else surfaces again as `close`, which schedules the retry.
    this.lastError = `Anycubic LAN: ошибка MQTT (${errorCode(error)})`;
  }

  /** Tears the connection down and schedules the next attempt with backoff. */
  private fail(generation: number, reason: string | null): void {
    if (generation !== this.generation || this.phase === "stopped") return;
    this.generation += 1;
    this.teardown();
    if (reason) this.lastError = reason;
    else this.lastError ??= "Anycubic LAN: соединение закрыто";
    this.failures += 1;
    this.phase = "backoff";
    const delay = backoffDelay(this.failures, this.timing, this.random());
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.phase !== "backoff") return;
      void this.connect(++this.generation);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private teardown(): void {
    this.clearTimer("connack");
    this.clearTimer("query");
    for (const pending of this.pendingReads) {
      clearTimeout(pending.timer);
      pending.reject(new PrinterCommandError("Anycubic LAN: соединение закрыто до ответа"));
    }
    this.pendingReads.clear();
    this.lightReport = null;
    this.lastLightQueryAt = 0;
    this.cameraUrl = null;
    this.uploadUrl = null;
    this.cameraDisconnect?.();
    this.cameraDisconnect = null;
    this.jobKey = null;
    this.jobElapsed = null;
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        client.end(true);
      } catch {
        // discarded either way
      }
    }
    const stream = this.stream;
    this.stream = null;
    stream?.destroy();
    // Nothing observed over a dead connection may survive into the next one.
    this.observation = emptyObservation();
  }

  private clearTimer(which: "reconnect" | "connack" | "query"): void {
    if (which === "reconnect" && this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (which === "connack" && this.connackTimer) {
      clearTimeout(this.connackTimer);
      this.connackTimer = null;
    }
    if (which === "query" && this.queryTimer) {
      clearInterval(this.queryTimer);
      this.queryTimer = null;
    }
  }

  // ── Talking ────────────────────────────────────────────────────────────────

  /** Publishes a payload-free telemetry read; never a file or physical command. */
  private query(type: AnycubicReadQuery): void {
    const client = this.client;
    const credentials = this.credentials;
    if (!client || !credentials || this.phase !== "connected") return;
    if ([...this.pendingReads].some((p) => p.type === type)) return;
    if (type === "light" && this.now() - this.lastLightQueryAt < this.timing.infoQueryMs) return;
    const message = buildReadQuery(type, this.now(), randomUUID());
    if (!isReadOnlyQuery(message)) return;
    this.lastQueryAt = this.now();
    if (type === "light") this.lastLightQueryAt = this.now();
    client.publish(
      queryTopic(credentials.modelId, credentials.deviceId, type),
      JSON.stringify(message),
      { qos: 0, retain: false },
      () => {}
    );
  }

  /** An extra `info` query, rate-limited — asked when a push hints the job changed. */
  private refreshSoon(): void {
    if (this.now() - this.lastQueryAt >= this.timing.refreshMinMs) this.query("info");
  }

  private onMessage(generation: number, topic: string, payload: Buffer): void {
    if (generation !== this.generation || this.phase !== "connected") return;
    const credentials = this.credentials;
    if (!credentials) return;
    const type = reportTypeOf(topic, credentials.modelId, credentials.deviceId);
    if (!type || payload.byteLength > MAX_REPORT_BYTES) return;

    let json: unknown;
    try {
      json = JSON.parse(payload.toString("utf8"));
    } catch {
      return; // not JSON: not a report this adapter reads
    }
    const now = this.now();
    this.resolveRead(type, json);

    if (type === "file" || type === "peripherie") return;
    if (type === "light") {
      const on = parseLight(json);
      if (on !== null) this.lightReport = { on, observedAt: now };
      return;
    }

    if (type === "info") {
      const report = parseInfoReport(json);
      if (!report) return;
      if (isObject(json) && isObject(json.data) && isObject(json.data.urls)) {
        this.cameraUrl = anycubicPrivateUrl(json.data.urls.rtspUrl, this.options.host, "camera");
        this.uploadUrl = anycubicPrivateUrl(json.data.urls.fileUploadurl, this.options.host, "upload");
      }
      this.reported = {
        printerName: report.identity.printerName ?? this.reported.printerName,
        model: report.identity.model ?? this.reported.model,
        firmware: report.identity.firmware ?? this.reported.firmware
      };
      if (report.temperatures) this.foldTemperatures(report.temperatures, now);
      if (report.job) {
        // A job running again is the next job: the last one's ending must not
        // become the words for how this one ends.
        const lifecycle = lifecycleOf(report.job);
        if (lifecycle === "printing" || lifecycle === "paused") this.observation.ending = null;
        const old = this.observation.job;
        const elapsed = isObject(json) && isObject(json.data) && isObject(json.data.project) && typeof json.data.project.print_time === "number" ? json.data.project.print_time : null;
        if (report.job.work === "free") this.jobKey = null;
        else if (report.job.file && (!this.jobKey || old?.file !== report.job.file || old?.taskId !== report.job.taskId ||
            elapsed !== null && this.jobElapsed !== null && elapsed < this.jobElapsed)) this.jobKey = randomUUID();
        this.jobElapsed = elapsed;
        this.observation.job = report.job;
        this.observation.jobObservedAt = now;
      }
      if (this.reported.firmware === "2.0.2.2" && !this.lightReport) this.query("light");
      return;
    }

    if (type === "tempature") {
      const temperatures = parseTemperatureReport(json);
      if (temperatures) this.foldTemperatures(temperatures, now);
      return;
    }

    if (type === "print") {
      const job = this.observation.job;
      // How the job in hand ended, when the push names it for that job — the
      // only place firmware 2.0.2.2 says it. Kept as words; `info` still ends it.
      const ending = parsePrintEnding(json);
      if (ending && job && endsJob(job, ending)) this.observation.ending = ending.phase;

      const progress = parsePrintReport(json);
      if (!progress) return;
      const lifecycle = job ? lifecycleOf(job) : null;
      if (!job || (lifecycle !== "printing" && lifecycle !== "paused")) {
        // Progress for a job `info` has not confirmed: ask, do not infer.
        this.refreshSoon();
        return;
      }
      this.observation.job = applyProgress(job, progress);
      return;
    }

    // status: the coarse free/busy. A change is a reason to ask, not an answer.
    const work = parseStatusReport(json);
    if (work && work !== this.observation.job?.work) this.refreshSoon();
  }

  /** Folds reported temperatures in; a field the report omits keeps its last value. */
  private foldTemperatures(next: AnycubicTemperatures, now: number): void {
    const previous = this.observation.temperatures;
    this.observation.temperatures = {
      nozzle: next.nozzle ?? previous?.nozzle ?? null,
      nozzleTarget: next.nozzleTarget ?? previous?.nozzleTarget ?? null,
      bed: next.bed ?? previous?.bed ?? null,
      bedTarget: next.bedTarget ?? previous?.bedTarget ?? null
    };
    this.observation.temperaturesObservedAt = now;
  }
}

function bit(value: unknown): boolean | null {
  return value === 1 ? true : value === 0 ? false : null;
}

/** Only a query report of the one light captured on model 20030, never a control ACK. */
function parseLight(json: unknown): boolean | null {
  if (!isObject(json) || json.type !== "light" || json.action !== "query" || json.code !== 200 ||
      !isObject(json.data) || !Array.isArray(json.data.lights)) return null;
  const light = json.data.lights.find((l) => isObject(l) && l.type === 3);
  return isObject(light) ? bit(light.status) : null;
}

function emptyObservation(): AnycubicObservation {
  return { job: null, jobObservedAt: null, temperatures: null, temperaturesObservedAt: null, ending: null };
}

/** 5 s, 10 s, 20 s … capped at 5 min, ±20 % so a farm of printers does not retry in lockstep. */
export function backoffDelay(failures: number, timing: AnycubicTiming, random: number): number {
  const exponent = Math.min(Math.max(failures - 1, 0), 16);
  const base = Math.min(timing.reconnectMaxMs, timing.reconnectBaseMs * 2 ** exponent);
  const jitter = 0.8 + 0.4 * Math.min(Math.max(random, 0), 1);
  return Math.round(Math.min(timing.reconnectMaxMs, base * jitter));
}

/**
 * The client identifier (`did`) the handshake presents: stable per farm printer,
 * so the device sees one client rather than a new one per restart, and derived
 * rather than stored. 32 upper-case hex characters, the shape the vendor's own
 * clients send.
 */
export function lanClientId(printerId: string): string {
  return createHash("sha256").update(`atelier:${printerId}`).digest("hex").slice(0, 32).toUpperCase();
}

/** An operator-safe sentence for a failed attempt: categories and OS codes only. */
function describeConnectError(error: unknown): string {
  if (error instanceof AnycubicHandshakeError) return `Anycubic LAN: ${error.message}`;
  if (error instanceof TlsPinMismatchError || error instanceof TlsConnectError) {
    return `Anycubic LAN: ${error.message}`;
  }
  return `Anycubic LAN: ошибка подключения (${errorCode(error)})`;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z_]{3,40}$/.test(code)) return code;
  if (typeof code === "number" && Number.isFinite(code)) return `код ${code}`;
  return networkCode(error);
}

// ── The real transport ───────────────────────────────────────────────────────

function createClient(stream: Duplex, options: AnycubicClientOptions): AnycubicMqttClient {
  return new mqtt.MqttClient(() => stream as unknown as mqtt.IStream, {
    protocolVersion: 4,
    clean: true,
    clientId: options.clientId,
    username: options.username,
    password: options.password,
    keepalive: options.keepalive,
    connectTimeout: options.connectTimeout,
    // Reconnection is the session's job (backoff, fresh handshake when needed);
    // the client must never reconnect on its own through a stream it cannot rebuild.
    reconnectPeriod: 0,
    resubscribe: false
  }) as unknown as AnycubicMqttClient;
}

const DEFAULT_TRANSPORT: AnycubicTransport = {
  handshake: (host, options) => performAnycubicHandshake(host, options),
  openTls: openPinnedTls,
  createClient
};
