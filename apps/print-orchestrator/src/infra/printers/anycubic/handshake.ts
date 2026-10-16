import { createDecipheriv, createHash, randomInt } from "node:crypto";

import { isBareNetworkHost } from "../../../domain/printers/validation";
import { isObject } from "../../../shared/isObject";
import { isTimeoutError } from "../../../shared/fetchWithTimeout";

/**
 * The Anycubic LAN-mode handshake: how a client on the printer's network turns
 * the printer's IP address into credentials for its local MQTT broker.
 *
 *   1. `GET  http://<ip>:18910/info` → identity plus a one-time `token`;
 *   2. `POST http://<ip>:18910/ctrl?ts&nonce&sign&did`, signed with that token;
 *   3. AES-128-CBC-decrypt the answer → the broker's username/password and the
 *      `deviceId` that names the MQTT topics.
 *
 * Not vendor-documented. It is the flow three independent open implementations
 * converge on (the Home Assistant LAN integrations by stribor and grunna, which
 * target the Kobra X, and chrisfore's) and that OrcaCubic validated read-only on
 * a Kobra X running firmware 2.0.1.9. Each of its assumptions is checked here and
 * refused in words when it does not hold, rather than half-trusted.
 *
 * Two deliberate departures from those clients:
 *
 *  - **the device never chooses where we connect.** `/info` names a
 *    `ctrlInfoUrl` and the decrypted bundle a `broker`; both are ignored. The
 *    signed request always goes to the configured host on 18910 (`/ctrl`, as
 *    OrcaCubic does), and the broker is always the configured host. Redirects are
 *    refused. Anything on the LAN can answer on 18910; it must not be able to
 *    point this service at another machine;
 *  - **nothing secret is kept or shown.** The credentials live in the caller's
 *    memory only; no error message carries the token, the ciphertext or any
 *    part of the bundle, and the client certificate/key the bundle also contains
 *    are discarded (the broker accepts a username/password login without them —
 *    grunna and OrcaCubic connect that way to a Kobra X).
 */

export const ANYCUBIC_HTTP_PORT = 18910;

/** Per request: a printer on the LAN answers in milliseconds, a dead one never. */
const HANDSHAKE_TIMEOUT_MS = 5000;

/** `/info` and `/ctrl` answers are a few hundred bytes; anything far larger is not a printer. */
const MAX_ANSWER_BYTES = 64 * 1024;

const NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** What the printer says about itself. Not secret — shown on the hardware card. */
export interface AnycubicDeviceIdentity {
  /** Anycubic's numeric model identifier, as text (`"20030"` is the Kobra X). */
  modelId: string;
  /** The model name the device reports, verbatim; null when it reports none. */
  modelName: string | null;
  /** The device serial (`cn`), when the printer publishes it. */
  serialNumber: string | null;
  /** The name the owner gave the printer on its screen, when reported. */
  deviceName: string | null;
}

/** Broker login. Held in memory only, never persisted, logged or returned by an API. */
export interface AnycubicCredentials {
  username: string;
  password: string;
  /** Names the MQTT topics (`…/{modelId}/{deviceId}/…`). */
  deviceId: string;
  modelId: string;
}

export interface AnycubicHandshakeResult {
  identity: AnycubicDeviceIdentity;
  credentials: AnycubicCredentials;
}

/**
 * Why the handshake failed, as a category the session can act on: `unreachable`
 * and `timeout` are retried with backoff, the rest describe a printer that needs
 * a person (LAN mode off, an unknown firmware variant, something that is not a
 * printer at all) and are retried slowly.
 */
export type AnycubicHandshakeFailure =
  | "unreachable"
  | "timeout"
  | "not_a_printer"
  | "cloud_mode"
  | "rejected"
  | "unsupported";

export class AnycubicHandshakeError extends Error {
  constructor(
    message: string,
    readonly failure: AnycubicHandshakeFailure
  ) {
    super(message);
    this.name = "AnycubicHandshakeError";
  }
}

export interface HandshakeOptions {
  /** Stable client identifier (`did`) — the printer sees one client per farm printer. */
  clientId: string;
  /** Override for tests; production always uses {@link ANYCUBIC_HTTP_PORT}. */
  httpPort?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/** `sign = md5(md5(token[0:16]) + ts + nonce)`, lower-case hex. */
export function signCtrlRequest(token: string, ts: number, nonce: string): string {
  const first = md5Hex(token.slice(0, 16));
  return md5Hex(`${first}${ts}${nonce}`);
}

/**
 * Decrypts the `/ctrl` bundle: AES-128-CBC, key = `token[16:32]`, IV = the
 * answer's own `data.token` (right-padded with NULs / truncated to 16 bytes, the
 * tolerance chrisfore's hardware-validated client applies), PKCS#7.
 */
export function decryptCtrlBundle(cipherBase64: string, token: string, ivText: string): unknown {
  const key = Buffer.from(token.slice(16, 32), "utf8");
  if (key.length !== 16) throw new Error("bad key length");
  const iv = Buffer.alloc(16);
  Buffer.from(ivText, "utf8").copy(iv, 0, 0, 16);
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  const plain = Buffer.concat([decipher.update(Buffer.from(cipherBase64, "base64")), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

/** `http://<host>:<port>` with IPv6 literals bracketed. */
export function httpOrigin(host: string, port: number): string {
  return host.includes(":") ? `http://[${host}]:${port}` : `http://${host}:${port}`;
}

/**
 * Runs the handshake against `host`. Resolves with the device identity and the
 * broker credentials, or rejects with an {@link AnycubicHandshakeError} whose
 * message is safe to show to an operator.
 */
export async function performAnycubicHandshake(
  host: string,
  options: HandshakeOptions
): Promise<AnycubicHandshakeResult> {
  if (!isBareNetworkHost(host)) {
    throw new AnycubicHandshakeError(
      "адрес принтера должен быть IP-адресом или именем без схемы, порта и пути",
      "unsupported"
    );
  }
  const origin = httpOrigin(host, options.httpPort ?? ANYCUBIC_HTTP_PORT);
  const now = options.now ?? Date.now;

  const info = await requestJson(origin, "/info", "GET", options);
  if (!isObject(info)) {
    throw new AnycubicHandshakeError("ответ /info не похож на ответ принтера Anycubic", "not_a_printer");
  }
  if (typeof info.ctrlType === "string" && info.ctrlType.toLowerCase() === "cloud") {
    throw new AnycubicHandshakeError(
      "принтер работает в облачном режиме — включите режим LAN на экране принтера",
      "cloud_mode"
    );
  }
  const token = typeof info.token === "string" ? info.token : "";
  if (token.length < 32) {
    throw new AnycubicHandshakeError(
      "принтер не выдал токен LAN-режима — включите режим LAN на экране принтера " +
        "(или прошивка использует другой вариант протокола)",
      "unsupported"
    );
  }

  const ts = now();
  const nonce = Array.from({ length: 6 }, () => NONCE_ALPHABET[randomInt(NONCE_ALPHABET.length)]).join("");
  const query = new URLSearchParams({
    ts: String(ts),
    nonce,
    sign: signCtrlRequest(token, ts, nonce),
    did: options.clientId
  });
  const ctrl = await requestJson(origin, `/ctrl?${query.toString()}`, "POST", options);
  if (!isObject(ctrl)) {
    throw new AnycubicHandshakeError("ответ /ctrl не похож на ответ принтера Anycubic", "not_a_printer");
  }
  if (ctrl.code !== 200) {
    throw new AnycubicHandshakeError(
      `принтер отклонил запрос локального доступа (/ctrl: код ${describeCode(ctrl.code)})`,
      "rejected"
    );
  }
  const sealed = ctrl.data;
  if (!isObject(sealed) || typeof sealed.info !== "string" || typeof sealed.token !== "string") {
    throw new AnycubicHandshakeError("ответ /ctrl не содержит параметров доступа", "unsupported");
  }

  let bundle: unknown;
  try {
    bundle = decryptCtrlBundle(sealed.info, token, sealed.token);
  } catch {
    throw new AnycubicHandshakeError(
      "не удалось расшифровать параметры LAN-доступа — прошивка использует неизвестный вариант протокола",
      "unsupported"
    );
  }
  if (!isObject(bundle)) {
    throw new AnycubicHandshakeError("параметры LAN-доступа имеют неизвестный формат", "unsupported");
  }

  const username = nonEmptyText(bundle.username);
  const password = nonEmptyText(bundle.password);
  const deviceId = nonEmptyText(bundle.deviceId);
  // Firmware spells it both ways (`modelId` / `modeId`); /info carries it too.
  const modelId = idText(bundle.modelId) ?? idText(bundle.modeId) ?? idText(info.modelId);
  if (!username || !password || !deviceId || !modelId) {
    throw new AnycubicHandshakeError(
      "в параметрах LAN-доступа нет логина, пароля или идентификатора устройства",
      "unsupported"
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(deviceId) || !/^[A-Za-z0-9_-]+$/.test(modelId)) {
    // Both become MQTT topic segments; a wildcard or separator in either would
    // subscribe to something other than this printer.
    throw new AnycubicHandshakeError("идентификатор устройства в ответе принтера некорректен", "unsupported");
  }

  return {
    identity: {
      modelId,
      modelName: nonEmptyText(info.modelName) ?? nonEmptyText(bundle.modelName),
      serialNumber: nonEmptyText(info.cn),
      deviceName: nonEmptyText(info.deviceName)
    },
    credentials: { username, password, deviceId, modelId }
  };
}

async function requestJson(
  origin: string,
  path: string,
  method: "GET" | "POST",
  options: HandshakeOptions
): Promise<unknown> {
  const doFetch = options.fetch ?? fetch;
  const endpoint = path.split("?")[0];
  let response: Response;
  try {
    response = await doFetch(`${origin}${path}`, {
      method,
      // The answer must come from the address we asked; a redirect is the device
      // naming another host, and is refused rather than followed.
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS),
      ...(method === "POST" ? { body: "" } : {})
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new AnycubicHandshakeError(`принтер не ответил на ${endpoint} за отведённое время (timeout)`, "timeout");
    }
    throw new AnycubicHandshakeError(
      `принтер недоступен по HTTP (${endpoint}: ${networkCode(error)})`,
      "unreachable"
    );
  }

  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => {});
    throw new AnycubicHandshakeError(`${endpoint} ответил перенаправлением — оно не выполняется`, "not_a_printer");
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new AnycubicHandshakeError(`${endpoint} ответил HTTP ${response.status}`, "not_a_printer");
  }

  let text: string;
  try {
    text = await readCapped(response, MAX_ANSWER_BYTES);
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new AnycubicHandshakeError(`принтер не ответил на ${endpoint} за отведённое время (timeout)`, "timeout");
    }
    throw new AnycubicHandshakeError(`ответ ${endpoint} не прочитан`, "not_a_printer");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AnycubicHandshakeError(`ответ ${endpoint} не является JSON — по этому адресу не принтер Anycubic`, "not_a_printer");
  }
}

/** Reads a response body, refusing one larger than `limit` bytes before it is buffered whole. */
async function readCapped(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    void response.body?.cancel().catch(() => {});
    throw new Error("answer too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error("answer too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function md5Hex(value: string): string {
  return createHash("md5").update(value, "utf8").digest("hex");
}

function nonEmptyText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function idText(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return nonEmptyText(value);
}

/** A numeric/short code only — never echo arbitrary device text into an error. */
function describeCode(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^[\w-]{1,16}$/.test(value)) return value;
  return "неизвестен";
}

/** The OS-level cause (ECONNREFUSED, EHOSTUNREACH, …), never a URL or payload. */
export function networkCode(error: unknown): string {
  // undici wraps the socket error: `TypeError("fetch failed", { cause })`.
  for (const candidate of [isObject(error) ? error.cause : undefined, error]) {
    const code = isObject(candidate) ? candidate.code : undefined;
    if (typeof code === "string" && /^[A-Z_]{3,32}$/.test(code)) return code;
  }
  return "сетевая ошибка";
}
