import { connect as tlsConnect, type TLSSocket } from "node:tls";

import { PrinterCommandError } from "../status/types";

/**
 * Bambu Lab's local file transport — **implicit FTPS on port 990**.
 *
 * This is the half of the Bambu adapter that was declared missing: the capability
 * table said "the FTPS file transfer is not wired", so every file capability was
 * `false` and the whole slice→queue→print chain terminated on "оператор должен
 * перенести файл вручную". The device has always spoken this protocol — it
 * answers `220 BBL-P003 FTP Server` on 990 — it simply had no client here.
 *
 * Three properties of Bambu's server drive the shape of this module, and each one
 * is the reason a generic FTP library would not have worked unmodified:
 *
 *  1. **Implicit TLS.** The session is TLS *from the first byte* — there is no
 *     plaintext greeting and no `AUTH TLS` upgrade. We open a `tls.connect` and
 *     speak FTP inside it.
 *  2. **A per-printer self-signed certificate.** Exactly like the MQTT channel,
 *     there is no CA to verify against, so `rejectUnauthorized` must be off. That
 *     disables TLS authentication, so — mirroring `status/bambu.ts` — it is an
 *     **explicit opt-in** (`allowInsecureTls`), never a silent default.
 *  3. **TLS session reuse on the data channel.** The server requires the data
 *     connection to resume the control connection's TLS session, which is how it
 *     ties the two together. Without `session:` the data transfer is accepted and
 *     then dropped, which reads as a mysterious truncation. We pass the control
 *     socket's session explicitly.
 *
 * Everything here is request/response with a deadline. Nothing retries: a caller
 * that wants a retry decides that itself, because for an *upload* a blind second
 * attempt is exactly the behaviour `DeviceArtifactService.reconcile` exists to
 * avoid.
 */

/** Implicit-FTPS control port. Bambu does not offer explicit FTPS or plain FTP. */
export const BAMBU_FTPS_PORT = 990;

/** The only username Bambu's LAN services accept; the password is the access code. */
export const BAMBU_FTPS_USER = "bblp";

const CONNECT_TIMEOUT_MS = 8_000;
const COMMAND_TIMEOUT_MS = 15_000;
/** A full plate G-code is single-digit MB; this bounds a stalled transfer, not a big one. */
const TRANSFER_TIMEOUT_MS = 180_000;

export interface BambuFtpsTarget {
  host: string;
  accessCode: string;
  /** Control port; defaults to {@link BAMBU_FTPS_PORT}. Never the MQTT port. */
  port?: number;
}

/** One parsed entry from a `LIST` response. */
export interface BambuFtpsEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  modifiedAt?: string;
}

/** One FTP reply: its numeric code and the full (possibly multi-line) text. */
interface FtpReply {
  code: number;
  text: string;
}

/**
 * A live control connection. Created by {@link openBambuFtps}, and **always**
 * closed by the `withBambuFtps` helper — a leaked control socket keeps a session
 * open on a device that permits very few of them.
 */
class BambuFtpsSession {
  /** Bytes received on the control channel that do not yet form a whole reply. */
  private buffer = "";
  /** Resolvers waiting for the next complete reply, in arrival order. */
  private readonly waiters: {
    resolve: (reply: FtpReply) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }[] = [];
  private fatal: Error | null = null;

  private constructor(
    private readonly socket: TLSSocket,
    private readonly target: BambuFtpsTarget
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (error: Error) => this.onFatal(error));
    socket.on("close", () => this.onFatal(new Error("FTPS-соединение закрыто принтером")));
  }

  /** Opens the TLS control channel and reads the server greeting. */
  static async open(target: BambuFtpsTarget): Promise<BambuFtpsSession> {
    const port = target.port ?? BAMBU_FTPS_PORT;
    const socket = await new Promise<TLSSocket>((resolve, reject) => {
      const s = tlsConnect(
        {
          host: target.host,
          port,
          // See module docs (2): no CA exists for a per-printer self-signed cert.
          // The caller has already required the explicit `allowInsecureTls` opt-in.
          rejectUnauthorized: false,
          timeout: CONNECT_TIMEOUT_MS
        },
        () => {
          s.setTimeout(0);
          resolve(s);
        }
      );
      s.once("timeout", () => {
        s.destroy();
        reject(new PrinterCommandError(`Таймаут FTPS-подключения к ${target.host}:${port}`));
      });
      s.once("error", (error: Error) =>
        reject(new PrinterCommandError(`FTPS-подключение к ${target.host}:${port}: ${error.message}`))
      );
    });

    const session = new BambuFtpsSession(socket, target);
    // Implicit FTPS still opens with a 220 greeting, just already inside TLS.
    await session.expect([220], session.readReply());
    return session;
  }

  /** `USER`/`PASS`, then binary mode and an encrypted data channel. */
  async login(): Promise<void> {
    const user = await this.send(`USER ${BAMBU_FTPS_USER}`);
    // 230 = logged in outright; 331 = password required (the normal path).
    if (user.code === 331) {
      const pass = await this.send(`PASS ${this.target.accessCode}`);
      if (pass.code !== 230) {
        throw new PrinterCommandError(
          pass.code === 530
            ? "Bambu отклонил LAN access code (FTPS 530) — проверьте код доступа на экране принтера"
            : `Аутентификация FTPS не удалась: ${pass.code} ${pass.text}`
        );
      }
    } else if (user.code !== 230) {
      throw new PrinterCommandError(`FTPS USER отклонён: ${user.code} ${user.text}`);
    }

    // Binary — an ASCII transfer would rewrite line endings and corrupt G-code.
    await this.expect([200], this.send("TYPE I"));
    // PBSZ 0 / PROT P: encrypt the data channel too. Bambu requires PROT P.
    await this.send("PBSZ 0").catch(() => undefined);
    await this.expect([200], this.send("PROT P"));
  }

  /** Directory listing. `dir` is relative to the SD-card root; "" lists the root. */
  async list(dir: string): Promise<BambuFtpsEntry[]> {
    const raw = await this.transferIn(dir ? `LIST /${dir}` : "LIST /");
    return parseListResponse(raw);
  }

  /** Uploads `bytes` to `remotePath` (relative to the SD-card root). */
  async store(remotePath: string, bytes: Uint8Array): Promise<void> {
    await this.transferOut(`STOR /${remotePath}`, bytes);
  }

  /** Byte size of one file, or null when the server will not report it. */
  async size(remotePath: string): Promise<number | null> {
    const reply = await this.send(`SIZE /${remotePath}`);
    if (reply.code !== 213) return null;
    const value = Number.parseInt(reply.text.trim(), 10);
    return Number.isFinite(value) ? value : null;
  }

  /** Deletes one file; a missing file is reported, never swallowed. */
  async delete(remotePath: string): Promise<void> {
    await this.expect([250], this.send(`DELE /${remotePath}`));
  }

  /** Sends `QUIT` best-effort and destroys the socket. Safe to call twice. */
  async close(): Promise<void> {
    if (!this.socket.destroyed) {
      await this.send("QUIT").catch(() => undefined);
    }
    this.socket.destroy();
    this.onFatal(new Error("FTPS-сессия закрыта"));
  }

  // ── Data-channel plumbing ──────────────────────────────────────────────────

  /**
   * Opens a passive data connection. Returns the socket **already connected**,
   * resuming the control channel's TLS session — see module docs (3).
   */
  private async openDataSocket(): Promise<TLSSocket> {
    const pasv = await this.send("PASV");
    if (pasv.code !== 227) {
      throw new PrinterCommandError(`FTPS PASV отклонён: ${pasv.code} ${pasv.text}`);
    }
    const { host, port } = parsePasv(pasv.text, this.target.host);

    return new Promise<TLSSocket>((resolve, reject) => {
      const s = tlsConnect(
        {
          host,
          port,
          rejectUnauthorized: false,
          // The server ties the data channel to the control channel by TLS
          // session id; without this the transfer is dropped mid-flight.
          session: this.socket.getSession(),
          timeout: CONNECT_TIMEOUT_MS
        },
        () => {
          s.setTimeout(0);
          resolve(s);
        }
      );
      s.once("timeout", () => {
        s.destroy();
        reject(new PrinterCommandError(`Таймаут FTPS data-подключения к ${host}:${port}`));
      });
      s.once("error", (error: Error) =>
        reject(new PrinterCommandError(`FTPS data-канал ${host}:${port}: ${error.message}`))
      );
    });
  }

  /** Runs a command whose payload the server sends to us (LIST). */
  private async transferIn(command: string): Promise<string> {
    const data = await this.openDataSocket();
    const collected = collect(data);
    // The 1xx preliminary reply comes after the data socket exists.
    const opened = await this.send(command);
    await this.expect([125, 150], Promise.resolve(opened));

    let payload: string;
    try {
      payload = await withDeadline(collected, TRANSFER_TIMEOUT_MS, "чтение данных FTPS");
    } finally {
      data.destroy();
    }
    await this.expect([226, 250], this.readReply());
    return payload;
  }

  /** Runs a command whose payload we send to the server (STOR). */
  private async transferOut(command: string, bytes: Uint8Array): Promise<void> {
    const data = await this.openDataSocket();
    const opened = await this.send(command);
    try {
      await this.expect([125, 150], Promise.resolve(opened));
    } catch (error) {
      data.destroy();
      throw error;
    }

    try {
      await withDeadline(
        new Promise<void>((resolve, reject) => {
          data.once("error", reject);
          // `end(bytes)` writes then half-closes, which is what signals
          // end-of-file to the server for a STOR.
          data.end(bytes, () => resolve());
        }),
        TRANSFER_TIMEOUT_MS,
        "передача данных FTPS"
      );
    } finally {
      data.destroy();
    }

    // 226 is the server's confirmation that it committed the whole file. Anything
    // else means the bytes did not land, however healthy the socket looked.
    await this.expect([226, 250], this.readReply());
  }

  // ── Control-channel plumbing ───────────────────────────────────────────────

  private send(command: string): Promise<FtpReply> {
    if (this.fatal) return Promise.reject(this.fatal);
    const reply = this.readReply();
    this.socket.write(`${command}\r\n`);
    return reply;
  }

  /** Resolves with the next complete reply the server sends. */
  private readReply(): Promise<FtpReply> {
    if (this.fatal) return Promise.reject(this.fatal);
    return new Promise<FtpReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new PrinterCommandError("Таймаут ответа FTPS от принтера"));
      }, COMMAND_TIMEOUT_MS);
      this.waiters.push({ resolve, reject, timer });
      this.drain();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    this.drain();
  }

  /**
   * Extracts every complete reply currently in the buffer.
   *
   * A reply is either a single `NNN text` line, or a multi-line block that opens
   * with `NNN-` and closes with a line starting `NNN ` (same code). Parsing the
   * multi-line form properly matters: `PASV`'s address lives in a reply that some
   * firmwares wrap, and a naive line-at-a-time reader would desynchronise the
   * whole command stream.
   */
  private drain(): void {
    while (this.waiters.length > 0) {
      const reply = this.takeReply();
      if (!reply) return;
      const waiter = this.waiters.shift();
      if (!waiter) return;
      clearTimeout(waiter.timer);
      waiter.resolve(reply);
    }
  }

  private takeReply(): FtpReply | null {
    const lines = this.buffer.split("\r\n");
    // The trailing element is an incomplete line (or "" after a clean break).
    for (let i = 0; i < lines.length - 1; i += 1) {
      const first = lines[0];
      const match = /^(\d{3})([ -])/.exec(first);
      if (!match) {
        // Not a reply at all — drop the junk line and re-examine.
        this.buffer = lines.slice(1).join("\r\n");
        return this.takeReply();
      }
      const code = Number.parseInt(match[1], 10);
      if (match[2] === " ") {
        this.buffer = lines.slice(1).join("\r\n");
        return { code, text: first.slice(4) };
      }
      // Multi-line: find the terminator "NNN " with the same code.
      const terminator = new RegExp(`^${match[1]} `);
      for (let j = 1; j <= i; j += 1) {
        if (terminator.test(lines[j])) {
          const text = lines.slice(0, j + 1).join("\n");
          this.buffer = lines.slice(j + 1).join("\r\n");
          return { code, text };
        }
      }
      return null;
    }
    return null;
  }

  private onFatal(error: Error): void {
    if (!this.fatal) this.fatal = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      clearTimeout(waiter.timer);
      waiter.reject(this.fatal);
    }
  }

  /** Asserts a reply's code, turning anything else into an honest error. */
  private async expect(codes: number[], pending: Promise<FtpReply>): Promise<FtpReply> {
    const reply = await pending;
    if (!codes.includes(reply.code)) {
      throw new PrinterCommandError(`FTPS ответил ${reply.code}: ${reply.text.trim()}`);
    }
    return reply;
  }
}

/**
 * Runs `fn` against a logged-in FTPS session and closes it afterwards, whatever
 * happens. Every caller uses this — there is no way to obtain a session that the
 * caller could forget to close.
 */
export async function withBambuFtps<T>(
  target: BambuFtpsTarget,
  fn: (session: BambuFtpsSession) => Promise<T>
): Promise<T> {
  const session = await BambuFtpsSession.open(target);
  try {
    await session.login();
    return await fn(session);
  } finally {
    await session.close().catch(() => undefined);
  }
}

export type { BambuFtpsSession };

// ── Parsing helpers (pure, exported for tests) ────────────────────────────────

/**
 * The host/port from a `227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)` reply.
 *
 * The advertised host is deliberately **ignored** in favour of the host we dialled:
 * a printer behind NAT (or one that reports `0,0,0,0`) would otherwise send us to
 * an unroutable address. The port is the only part we need from it.
 */
export function parsePasv(text: string, controlHost: string): { host: string; port: number } {
  const match = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(text);
  if (!match) {
    throw new PrinterCommandError(`Не удалось разобрать ответ FTPS PASV: ${text.trim()}`);
  }
  const high = Number.parseInt(match[5], 10);
  const low = Number.parseInt(match[6], 10);
  const port = high * 256 + low;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new PrinterCommandError(`Некорректный порт в ответе FTPS PASV: ${text.trim()}`);
  }
  return { host: controlHost, port };
}

const LIST_LINE_RE =
  /^([\-dl])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d+\s+(?:\d{4}|\d{2}:\d{2}))\s+(.+)$/;

/**
 * Parses a Unix-style `LIST` response into normalized entries.
 *
 * Bambu's server emits classic `ls -l` lines. Entries whose shape we do not
 * recognise are **skipped rather than guessed at**: an unparsed line must never
 * become a file record that a dispatch would later treat as proof of delivery.
 * `.` and `..` are dropped for the same reason.
 */
export function parseListResponse(raw: string): BambuFtpsEntry[] {
  const entries: BambuFtpsEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = LIST_LINE_RE.exec(trimmed);
    if (!match) continue;

    const name = match[4].trim();
    if (!name || name === "." || name === "..") continue;
    // A symlink's target ("link -> /target") is not a name we can verify against.
    if (match[1] === "l") continue;

    const size = Number.parseInt(match[2], 10);
    entries.push({
      name,
      type: match[1] === "d" ? "directory" : "file",
      ...(match[1] === "d" || !Number.isFinite(size) ? {} : { size })
    });
  }
  return entries;
}

// ── Small async utilities ─────────────────────────────────────────────────────

function collect(socket: TLSSocket): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("error", reject);
  });
}

function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new PrinterCommandError(`Таймаут: ${what} (${ms} мс)`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
