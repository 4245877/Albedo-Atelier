import type { X509Certificate } from "node:crypto";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";

import { canonicalTlsFingerprint } from "../../../domain/printers/validation";
import { networkCode } from "./handshake";

/**
 * TLS to the printer's MQTT broker, and the rule it exists for: the broker login
 * is written only to a broker that presented the certificate an operator
 * confirmed.
 *
 * The certificate is self-signed (`O=AnyCubic`, no CN/SAN, not a CA — Kobra X,
 * firmware 2.0.2.2), so no CA and no name can vouch for it. The certificate
 * itself can: its SHA-256 fingerprint, confirmed once by the operator
 * (`tlsFingerprint`) and compared on every connection, first and reconnect
 * alike. The TLS handshake still makes the broker prove it holds that
 * certificate's private key; only the CA-chain check, which has nothing to work
 * with here, gives way to the exact match — made before the socket reaches
 * anything that writes. A mismatch ends the attempt: nothing is sent, and no
 * other certificate is ever taken in its place.
 *
 * The limit, measured on the unit: the LAN handshake (`/ctrl`) hands the
 * broker's certificate *and private key* to any client that asks. The pin keeps
 * out whatever has not done that handshake — another device on the address, a
 * reassigned IP, a MITM without the key — but not a host on the same LAN that
 * has; no check on this side can. The trust boundary is the printer's network.
 */

/** The certificate as an operator is shown it before confirming. Public facts only. */
export interface AnycubicBrokerCertificate {
  /** Canonical SHA-256 fingerprint — what `tlsFingerprint` stores. */
  fingerprint256: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** Issued and signed by itself — expected for this broker. */
  selfSigned: boolean;
}

export class TlsConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsConnectError";
  }
}

/** The broker presented a certificate other than the confirmed one. */
export class TlsPinMismatchError extends Error {
  constructor(readonly presented: string | null) {
    super(
      presented
        ? "сертификат принтера не совпадает с подтверждённым — подключение заблокировано " +
            `(принтер предъявил SHA-256 ${shortFingerprint(presented)}). Если сертификат сменился законно ` +
            "(сброс, обновление прошивки), получите и подтвердите новый в настройках принтера"
        : "принтер не предъявил сертификат — подключение заблокировано"
    );
    this.name = "TlsPinMismatchError";
  }
}

/**
 * A TLS stream to the broker, opened only if it presents exactly `pinned`.
 * Rejects — having written nothing — for any other certificate, or when there is
 * no valid pin to compare with.
 */
export async function openPinnedTls(host: string, port: number, timeoutMs: number, pinned: string): Promise<Duplex> {
  const expected = canonicalTlsFingerprint(pinned);
  if (!expected) throw new TlsConnectError("сертификат принтера не подтверждён — подключение не выполняется");
  const socket = await handshake(host, port, timeoutMs);
  const presented = canonicalTlsFingerprint(socket.getPeerX509Certificate()?.fingerprint256 ?? "");
  if (presented !== expected) {
    socket.destroy();
    throw new TlsPinMismatchError(presented);
  }
  return socket;
}

/**
 * The certificate the broker presents, for an operator to look at and confirm.
 * A TLS handshake and nothing else: no byte is written, the socket is closed at
 * once, and nothing about it is trusted or kept.
 */
export async function readBrokerCertificate(
  host: string,
  port: number,
  timeoutMs: number
): Promise<AnycubicBrokerCertificate> {
  const socket = await handshake(host, port, timeoutMs);
  try {
    const cert = socket.getPeerX509Certificate();
    const fingerprint256 = canonicalTlsFingerprint(cert?.fingerprint256 ?? "");
    if (!cert || !fingerprint256) throw new TlsConnectError("брокер принтера не предъявил сертификат");
    return {
      fingerprint256,
      subject: describeName(cert.subject),
      issuer: describeName(cert.issuer),
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      selfSigned: isSelfSigned(cert)
    };
  } finally {
    socket.destroy();
  }
}

/**
 * Its own name as issuer and its own key in the signature. Not `checkIssued`:
 * OpenSSL also demands keyCertSign of an issuer, which the printer's
 * certificate (keyUsage digitalSignature + keyEncipherment) does not carry.
 */
export function isSelfSigned(cert: X509Certificate): boolean {
  return cert.subject === cert.issuer && cert.verify(cert.publicKey);
}

/** `0F:1E:2D:3C…D2:E1:F0` — enough to tell two certificates apart in a sentence. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.length > 24 ? `${fingerprint.slice(0, 11)}…${fingerprint.slice(-8)}` : fingerprint;
}

/**
 * Completes a TLS handshake and hands back the socket with nothing verified but
 * the handshake itself; the callers decide what the certificate is worth.
 */
function handshake(host: string, port: number, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      // No CA can vouch for a self-signed broker, so the chain verdict is not
      // what decides: the callers compare the certificate itself (module note).
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
      // SNI is for names; sending an IP literal as one is a protocol violation.
      ...(net.isIP(host) === 0 ? { servername: host } : {})
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new TlsConnectError(`TLS-соединение с портом ${port} не установлено за отведённое время (timeout)`));
    }, timeoutMs);
    timer.unref?.();
    const onError = (error: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new TlsConnectError(`TLS-соединение с портом ${port} не установлено (${errorCode(error)})`));
    };
    socket.once("error", onError);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      socket.removeListener("error", onError);
      resolve(socket);
    });
  });
}

/** `O=AnyCubic` — one line, bounded: the text comes from the device. */
function describeName(name: string): string {
  return name.replace(/\s*\n\s*/g, ", ").trim().slice(0, 200);
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z_]{3,40}$/.test(code)) return code;
  return networkCode(error);
}
