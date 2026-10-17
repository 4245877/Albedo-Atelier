import type { DiscoveredFacts } from "../../../domain/printers/discovery";
import { canonicalTlsFingerprint } from "../../../domain/printers/validation";
import { anycubicModelCodeFor, lookupModelSpec } from "../../../domain/printers/modelSpecs";
import { printerReadiness, type PrinterRequirement } from "../capabilities";
import type { PrinterConfig } from "../config";
import {
  failedDiscovery,
  fromCatalog,
  fromPrinter,
  succeededDiscovery,
  type DiscoveryResult
} from "../discovery/types";
import { makeOfflineStatus } from "../status/mapper";
import type { PrinterLiveStatus } from "../status/types";
import { ANYCUBIC_MQTT_PORT, AnycubicSession, type AnycubicTiming, type AnycubicTransport } from "./session";
import { readBrokerCertificate, type AnycubicBrokerCertificate } from "./tls";

/**
 * The Anycubic LAN adapter (`anycubic-lan`) as the rest of the service sees it:
 * one session per printer, kept in this module like the Bambu MQTT clients, and
 * four entry points the protocol switches in `status/` and `discovery/` call.
 *
 * Monitoring only. There is no command, upload, file or light function here to
 * call — the capability table declares all of them absent, and the dispatchers
 * refuse this protocol explicitly rather than falling through to another one.
 */

export { ANYCUBIC_MQTT_PORT } from "./session";
export { ANYCUBIC_HTTP_PORT } from "./handshake";
export type { AnycubicBrokerCertificate } from "./tls";

interface Entry {
  /** The settings the session was built from; a change rebuilds it. */
  key: string;
  session: AnycubicSession;
}

const sessions = new Map<string, Entry>();

/**
 * Test seam: lets a test drive the registry over a fake transport (and faster
 * timers) without a device. Production never sets it.
 */
export const anycubicTestHooks: {
  transport?: AnycubicTransport;
  timing?: Partial<AnycubicTiming>;
  httpPort?: number;
} = {};

/** How long reading the broker certificate for an operator may take. */
const CERTIFICATE_READ_TIMEOUT_MS = 6000;

function connectionKey(printer: PrinterConfig): string {
  return JSON.stringify([printer.host, printer.port ?? null, canonicalTlsFingerprint(printer.tlsFingerprint ?? "")]);
}

/**
 * The live status of one Anycubic printer. Starts (or keeps) its session and
 * answers from memory — never waits on the network, so a slow or dead printer
 * cannot hold up the poll of the others.
 */
export function getAnycubicStatus(printer: PrinterConfig): PrinterLiveStatus {
  const readiness = printerReadiness(printer);
  if (!readiness.ready) {
    // Not connecting at all is the honest answer for an unconfirmed certificate
    // or an unusable address; any session from earlier settings is closed.
    dropAnycubicConnection(printer.id);
    return makeOfflineStatus(printer, notConfiguredReason(readiness.missing));
  }

  const key = connectionKey(printer);
  let entry = sessions.get(printer.id);
  if (entry && entry.key !== key) {
    entry.session.stop();
    sessions.delete(printer.id);
    entry = undefined;
  }
  if (!entry) {
    entry = {
      key,
      session: new AnycubicSession({
        printerId: printer.id,
        host: printer.host,
        mqttPort: printer.port ?? ANYCUBIC_MQTT_PORT,
        // Ready means confirmed: readiness refuses a printer without a valid pin.
        tlsFingerprint: canonicalTlsFingerprint(printer.tlsFingerprint ?? "") ?? "",
        httpPort: anycubicTestHooks.httpPort,
        transport: anycubicTestHooks.transport,
        timing: anycubicTestHooks.timing
      })
    };
    sessions.set(printer.id, entry);
  }
  entry.session.start();
  return entry.session.status(printer);
}

/**
 * Hardware discovery from what the session already holds — no I/O, like the
 * Bambu probe. `/info` names the model id, the model and the serial; `info`
 * reports add the firmware.
 *
 * The catalogue speaks only for a model id confirmed on a real unit (`20030`,
 * the Kobra X): its build volume is then a `catalog` fact. Any other Anycubic
 * model reports its own name and nothing is lent to it.
 */
export function discoverAnycubicFacts(printer: PrinterConfig): DiscoveryResult {
  const session = sessions.get(printer.id)?.session;
  const snapshot = session?.identity();
  const device = snapshot?.device ?? null;
  // A probe succeeds only while the device is actually answering: what a past
  // session learned is kept by the discovery service on a failed probe, so the
  // card keeps it — but labelled stale rather than freshly confirmed.
  if (!session || !snapshot || !device || session.state !== "connected") {
    return failedDiscovery(
      "Принтер сейчас не на связи по Anycubic LAN — проверьте адрес, режим LAN и подтверждённый сертификат"
    );
  }

  const facts: DiscoveredFacts = {};
  const idVia = `HTTP :18910/info → modelId ${device.modelId}`;
  const spec = lookupModelSpec(anycubicModelCodeFor(device.modelId));
  if (spec) {
    facts.modelCode = fromPrinter(spec.code, idVia);
    facts.technology = fromCatalog(spec.technology);
    if (spec.buildVolume) facts.buildVolume = fromCatalog(spec.buildVolume);
  }

  if (device.modelName) facts.model = fromPrinter(device.modelName, "HTTP :18910/info → modelName");
  else if (snapshot.reported.model) facts.model = fromPrinter(snapshot.reported.model, "MQTT info → model");
  else if (spec) facts.model = fromPrinter(spec.name, idVia);

  if (snapshot.reported.firmware) {
    facts.firmware = fromPrinter(snapshot.reported.firmware, "MQTT info → version");
  }
  const name = device.deviceName ?? snapshot.reported.printerName;
  if (name) {
    facts.deviceName = fromPrinter(
      name,
      device.deviceName ? "HTTP :18910/info → deviceName" : "MQTT info → printerName"
    );
  }
  if (device.serialNumber) facts.serialNumber = fromPrinter(device.serialNumber, "HTTP :18910/info → cn");

  return succeededDiscovery(facts);
}

/**
 * The certificate the printer's broker presents right now, for an operator to
 * confirm — a TLS handshake with nothing sent and nothing trusted (`./tls.ts`).
 * Independent of the live session, which it neither opens nor disturbs.
 */
export function readAnycubicBrokerCertificate(printer: PrinterConfig): Promise<AnycubicBrokerCertificate> {
  return readBrokerCertificate(printer.host, printer.port ?? ANYCUBIC_MQTT_PORT, CERTIFICATE_READ_TIMEOUT_MS);
}

/** Closes one printer's session and forgets everything it learned, credentials included. */
export function dropAnycubicConnection(printerId: string): void {
  const entry = sessions.get(printerId);
  if (!entry) return;
  entry.session.stop();
  sessions.delete(printerId);
}

/** Closes every session (service shutdown). */
export function shutdownAnycubicConnections(): void {
  for (const entry of sessions.values()) entry.session.stop();
  sessions.clear();
}

function notConfiguredReason(missing: PrinterRequirement[]): string {
  if (missing.some((m) => m.field === "host")) {
    return "Anycubic LAN: укажите IP-адрес принтера — без http://, порта и пути";
  }
  if (missing.some((m) => m.field === "tlsFingerprint")) {
    return (
      "Anycubic LAN: сертификат принтера не подтверждён — в настройках принтера получите сертификат " +
      "с принтера и подтвердите его отпечаток SHA-256; до этого сервис к принтеру не подключается"
    );
  }
  return `Anycubic LAN: не настроено — ${missing.map((m) => m.label).join(", ")}`;
}
