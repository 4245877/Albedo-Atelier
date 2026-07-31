import type { PrinterTechnology } from "./types";

/**
 * The *stored* printer configuration — the domain half of "a printer the farm
 * knows about", independent of where it is persisted.
 *
 * This module owns the vocabulary (protocols, light settings, the auto-clearing
 * capability) and the record shape; `infra/printers/config.ts` re-exports it and
 * turns a record into the runtime {@link PrinterConfig} the drivers consume.
 *
 * Two deliberate differences between a {@link PrinterRecord} and a runtime
 * `PrinterConfig`:
 *
 *  - a record holds strings **verbatim as the operator wrote them**, including
 *    `${ENV_VAR}` references. Expansion happens when the record is materialized,
 *    so a config imported from the old `printers.json` keeps working off `.env`
 *    while anything typed into the UI is stored literally;
 *  - `light.enabled` may be `null` = "not stated", which materializes to the
 *    protocol-derived default. A stored `true`/`false` is an operator decision
 *    and always wins.
 */

export const PRINTER_PROTOCOLS = ["moonraker", "bambu", "creality"] as const;

export type PrinterProtocol = (typeof PRINTER_PROTOCOLS)[number];

/**
 * Allowed printer id shape. The id is used verbatim as a filesystem path
 * segment (camera snapshots: `<snapshotsDir>/<id>/<day>/…`) and as a URL path
 * segment, so it is restricted to characters that cannot traverse a directory
 * or need escaping — letters, digits, underscore and hyphen.
 */
export const PRINTER_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Chamber-light control as it is stored (before protocol defaults are applied). */
export interface PrinterLightSettings {
  /**
   * Explicit operator decision, or `null` when never stated — `null`
   * materializes to the protocol default (Bambu: on; Moonraker: on when the
   * on/off G-code can be derived).
   */
  enabled: boolean | null;
  /** Moonraker output pin name; produces SET_PIN commands when present. */
  pin: string;
  /** The pin is active-low (lights at VALUE=0); swaps the derived G-code values. */
  invert: boolean;
  /** Explicit Moonraker G-code command for switching the light on. */
  onGcode: string;
  /** Explicit Moonraker G-code command for switching the light off. */
  offGcode: string;
  /** Moonraker object queried for state, e.g. "output_pin LED". */
  statusObject: string;
  /** Field inside the Moonraker status object; defaults to "value". */
  statusField: string;
  /** Bambu LED node passed to the local MQTT ledctrl command. */
  bambuNode: string;
}

export const DEFAULT_LIGHT_SETTINGS: PrinterLightSettings = {
  enabled: null,
  pin: "",
  invert: false,
  onGcode: "",
  offGcode: "",
  statusObject: "",
  statusField: "",
  bambuNode: ""
};

/** Verified hardware that leaves the bed clear without an operator. */
export interface AutomaticContinuationConfig {
  /** Master switch. False (the default) → the bed always needs a human. */
  allowed: boolean;
  /** What the hardware is, for the audit trail; free text from the config. */
  mechanism: string;
  /**
   * ISO date the mechanism was last *physically verified* by an operator. An
   * unverified mechanism does not count as one: `allowed` alone never clears a
   * bed — {@link automaticContinuationEnabled} requires both.
   */
  verifiedAt: string | null;
}

export const NO_AUTOMATIC_CONTINUATION: AutomaticContinuationConfig = {
  allowed: false,
  mechanism: "",
  verifiedAt: null
};

/**
 * Whether a printer may clear its own bed. Requires an explicit opt-in **and** a
 * recorded physical verification — the fail-closed reading of "явно настроена и
 * подтверждена соответствующая аппаратная возможность".
 */
export function automaticContinuationEnabled(printer: {
  automaticContinuation?: AutomaticContinuationConfig;
}): boolean {
  const c = printer.automaticContinuation;
  return c?.allowed === true && typeof c.verifiedAt === "string" && c.verifiedAt.trim().length > 0;
}

/**
 * One printer as it is persisted. The id is the operator-chosen slug (not a
 * generated id): it is already the key of every snapshot directory, API path and
 * `printerId` foreign reference in the queue, so it stays the primary key.
 */
export interface PrinterRecord {
  id: string;
  name: string;
  model: string;
  type: PrinterTechnology;
  /** Interchangeability class for class-scoped slice variants; "" = no class. */
  printerClass: string;

  protocol: PrinterProtocol;
  host: string;
  port: number | null;

  /** Declared loaded material (config metadata, not live telemetry). */
  material: string;
  nozzleDiameterMm: number | null;
  nozzleType: string;
  buildVolume: { x: number; y: number; z: number } | null;
  /** UI colour for the material chip. */
  swatch: string;
  snapshotUrl: string;
  streamUrl: string;
  /** The printer's own web UI (Fluidd/Mainsail…); http(s) only, "" when none. */
  interfaceUrl: string;

  enabled: boolean;

  // ── Access credentials (never leave the service in plaintext) ──────────────
  apiKey: string;
  serial: string;
  accessCode: string;
  /** Explicit opt-in for a TLS connection WITHOUT certificate verification. */
  allowInsecureTls: boolean;

  automaticContinuation: AutomaticContinuationConfig;
  light: PrinterLightSettings;

  /** Operator-facing ordering on the dashboard; ties break by id. */
  position: number;

  createdAt: string;
  updatedAt: string;
  version: number;
  metadata: Record<string, unknown>;
}

/** The three fields treated as secrets: masked on read, kept on partial update. */
export const PRINTER_SECRET_FIELDS = ["apiKey", "serial", "accessCode"] as const;

export type PrinterSecretField = (typeof PRINTER_SECRET_FIELDS)[number];

/**
 * Whether a stored value is an `${ENV_VAR}` reference rather than a literal
 * secret. Such a value is not itself sensitive — it names where the secret comes
 * from — so it is the one form of a credential the API may echo back, which is
 * what lets the UI show "берётся из ${BAMBU_A1_ACCESS_CODE}" instead of a blank.
 */
export function isEnvPlaceholder(value: string): boolean {
  return /^\$\{[A-Za-z0-9_]+\}$/.test(value.trim());
}
