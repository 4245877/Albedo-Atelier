import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";

import mqtt from "mqtt";

import type { PrinterConfig } from "../config";
import { makeOfflineStatus } from "../status/mapper";
import type { PrinterLiveStatus } from "../status/types";
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
 *  - **read-only, enforced in code.** The only thing ever published is a
 *    `{type: "info", action: "query", data: null}` request, built here and
 *    re-checked by {@link isReadOnlyQuery} before it leaves; there is no method
 *    that publishes anything else. The broker's command vocabulary (print, light,
 *    temperature, camera, file…) is not reachable from this module;
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

/** The read queries this adapter may publish. Nothing else, ever. */
export const READ_ONLY_QUERIES = ["info"] as const;
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
 * The publish guard: true only for a read query from {@link READ_ONLY_QUERIES}
 * with no payload. Every outgoing message passes it; anything else is dropped.
 */
export function isReadOnlyQuery(message: unknown): message is AnycubicQueryMessage {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return false;
  const m = message as Record<string, unknown>;
  return (
    (READ_ONLY_QUERIES as readonly unknown[]).includes(m.type) &&
    m.action === "query" &&
    m.data === null &&
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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connackTimer: ReturnType<typeof setTimeout> | null = null;
  private queryTimer: ReturnType<typeof setInterval> | null = null;

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
    if (this.phase === "connected") return buildAnycubicStatus(printer, this.observation, this.now());
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
      client.on("message", (topic: string, payload: Buffer) =>
        this.guarded(generation, () => this.onMessage(generation, topic, payload), false)
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

  /** Publishes one read query. The only publish in this module. */
  private query(type: AnycubicReadQuery): void {
    const client = this.client;
    const credentials = this.credentials;
    if (!client || !credentials || this.phase !== "connected") return;
    const message = buildReadQuery(type, this.now(), randomUUID());
    if (!isReadOnlyQuery(message)) return;
    this.lastQueryAt = this.now();
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

    if (type === "info") {
      const report = parseInfoReport(json);
      if (!report) return;
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
        this.observation.job = report.job;
        this.observation.jobObservedAt = now;
      }
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
