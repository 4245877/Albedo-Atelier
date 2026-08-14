import { AppError } from "../../core/errors";
import type { PrinterConfig, PrinterProtocol } from "./config";

/**
 * What each printer adapter can actually **do** — declared once, as data.
 *
 * Before this module the same question ("can we push a file to it?", "can we
 * list its storage?", "can we start a file remotely?") was answered by
 * `protocol === "moonraker"` comparisons scattered across five files. Each was
 * individually right and collectively unauditable: adding an adapter meant
 * finding every predicate, and nothing stopped a caller from assuming a
 * capability that adapter never had.
 *
 * The table below is the single declaration. It is keyed by **protocol** — the
 * implemented transport — never by printer model or name: a capability is a
 * property of the code that talks to the device, not of the sticker on it.
 *
 * `fileVerification` states, honestly, the strongest identity check the adapter's
 * API can support:
 *
 *  - `name_and_size` — the listing reports names *and* byte sizes (Moonraker).
 *    No adapter in this farm exposes a content hash, so this is the ceiling; it
 *    is never recorded or reported as a SHA-256 match.
 *  - `none` — there is no file API at all, so the only available evidence is a
 *    named operator confirming they copied the file by hand.
 */

/** One adapter's declared abilities. Every field is explicit — no defaults, no inference. */
export interface PrinterCapabilities {
  /** The orchestrator can push file bytes to the device over the adapter's API. */
  supportsUpload: boolean;
  /** The adapter can enumerate on-device files (needed to verify a delivery). */
  supportsFileListing: boolean;
  /** The adapter can start an on-device file by path. */
  supportsRemoteStart: boolean;
  /** The adapter can delete an on-device file. */
  supportsFileDelete: boolean;
  /** Strongest identity check the adapter's file API allows. */
  fileVerification: "name_and_size" | "name_only" | "none";
  /**
   * Extensions this adapter can actually *start*, lower-case, longest-match first.
   *
   * Protocol-scoped on purpose: Klipper starts a bare `.gcode`, while a Bambu
   * printer is handed a `.gcode.3mf` plate package (what Bambu Studio itself
   * uploads, and what this farm's A1 already holds on its SD card). A single
   * global list would either forbid the Bambu package or invite someone to hand
   * Moonraker a `.3mf` it cannot execute.
   */
  startableExtensions: readonly string[];
  /**
   * The extension a *prepared* file takes on this device. Always one of
   * {@link startableExtensions}; it is what `buildDeviceFileName` appends.
   */
  deviceFileExtension: string;
}

const CAPABILITIES: Readonly<Record<PrinterProtocol, PrinterCapabilities>> = {
  // Klipper/Moonraker HTTP: `/server/files/upload`, `/server/files/directory`
  // (which reports `size`), `/printer/print/start`. Delete (`DELETE
  // /server/files/gcodes/<path>`) exists in the API but is not implemented here,
  // so it is declared `false` rather than assumed.
  moonraker: {
    supportsUpload: true,
    supportsFileListing: true,
    supportsRemoteStart: true,
    supportsFileDelete: false,
    fileVerification: "name_and_size",
    startableExtensions: [".gcode", ".gco", ".g"],
    deviceFileExtension: ".gcode"
  },
  // Bambu LAN: implicit FTPS on 990 for files (`infra/printers/files/bambu.ts`)
  // and local MQTT for control (`infra/printers/status/bambuStart.ts`).
  //
  // Every one of these was `false` until the FTPS client existed, with the
  // comment "the FTPS file transfer is not wired" — an accurate statement about
  // this codebase that was routinely misread as a statement about the hardware.
  // The device has always served `220 BBL-P003 FTP Server` on 990 and accepted
  // `print.project_file` over MQTT.
  //
  // `LIST` reports names *and* byte sizes, so the verification ceiling is the
  // same `name_and_size` Moonraker offers. Delete (`DELE`) is implemented, which
  // is what lets a superseded package be removed from a small SD card.
  bambu: {
    supportsUpload: true,
    supportsFileListing: true,
    supportsRemoteStart: true,
    supportsFileDelete: true,
    fileVerification: "name_and_size",
    // `.gcode.3mf` must precede `.3mf`: the longest match wins, so a plate
    // package keeps its full double extension instead of being split at `.3mf`.
    startableExtensions: [".gcode.3mf", ".3mf", ".gcode"],
    deviceFileExtension: ".gcode.3mf"
  },
  // Creality's WebSocket protocol: telemetry only in this codebase.
  creality: {
    supportsUpload: false,
    supportsFileListing: false,
    supportsRemoteStart: false,
    supportsFileDelete: false,
    fileVerification: "none",
    startableExtensions: [".gcode", ".gco", ".g"],
    deviceFileExtension: ".gcode"
  }
};

/** Fail-closed capabilities for a protocol that is not in the table at all. */
const NONE: PrinterCapabilities = {
  supportsUpload: false,
  supportsFileListing: false,
  supportsRemoteStart: false,
  supportsFileDelete: false,
  fileVerification: "none",
  startableExtensions: [".gcode", ".gco", ".g"],
  deviceFileExtension: ".gcode"
};

/** The declared capabilities of a protocol; an unknown protocol can do nothing. */
export function capabilitiesOfProtocol(
  protocol: string | null | undefined
): PrinterCapabilities {
  if (!protocol) return NONE;
  return CAPABILITIES[protocol as PrinterProtocol] ?? NONE;
}

/** The declared capabilities of a configured printer. */
export function capabilitiesOf(printer: PrinterConfig): PrinterCapabilities {
  return capabilitiesOfProtocol(printer.protocol);
}

/**
 * One thing this printer still needs before its adapter can reach the device.
 *
 * Separate from {@link PrinterCapabilities} on purpose, and the distinction is
 * the whole point of this half of the module:
 *
 *  - a **capability** says what the adapter *implements* — a property of our code,
 *    identical for every printer speaking that protocol;
 *  - a **readiness requirement** says what this *particular* printer is missing —
 *    a property of its configuration.
 *
 * Conflating them is what produced the report an operator could do nothing with:
 * a Bambu printer with no access code answered "адаптер не умеет загружать
 * файлы", which is a statement about the software and left them nothing to fix.
 * The honest answer is "укажите LAN access code", which names the field.
 */
export interface PrinterRequirement {
  /** Config field the operator must fill (matches the inventory form). */
  field: string;
  /** Operator-facing name of what is missing. */
  label: string;
  /** Where to get it / why it is needed. */
  hint: string;
}

export interface PrinterReadiness {
  /** True when every requirement for device I/O is satisfied. */
  ready: boolean;
  missing: PrinterRequirement[];
}

/**
 * What this printer still needs before upload/listing/start can be attempted.
 *
 * Only ever reports *configuration* gaps — never reachability. Whether the device
 * answers is a live fact the status poll owns; a printer can be perfectly
 * configured and switched off, and those two must not be reported as one thing.
 */
export function printerReadiness(printer: PrinterConfig): PrinterReadiness {
  const missing: PrinterRequirement[] = [];

  if (printer.protocol === "bambu") {
    if (!printer.serial?.trim()) {
      missing.push({
        field: "serial",
        label: "серийный номер принтера",
        hint: "экран принтера: Settings → Device — задаёт MQTT-топики устройства"
      });
    }
    if (!printer.accessCode?.trim()) {
      missing.push({
        field: "accessCode",
        label: "LAN access code",
        hint: "экран принтера: Settings → LAN Only Mode — пароль и для MQTT, и для FTPS"
      });
    }
    // Both LAN channels use the same per-printer self-signed certificate, so the
    // same explicit opt-in gates both. Without it the adapter refuses to connect
    // rather than silently disabling TLS authentication.
    if (printer.allowInsecureTls !== true && process.env.BAMBU_ALLOW_INSECURE_TLS !== "1") {
      missing.push({
        field: "allowInsecureTls",
        label: "подтверждение TLS без проверки сертификата",
        hint: "у Bambu самоподписанный сертификат без CA: allowInsecureTls: true у принтера или BAMBU_ALLOW_INSECURE_TLS=1"
      });
    }
  }

  if (printer.protocol === "moonraker" && !printer.host?.trim()) {
    missing.push({
      field: "host",
      label: "адрес принтера",
      hint: "IP или имя хоста Moonraker"
    });
  }

  return { ready: missing.length === 0, missing };
}

/**
 * A structured refusal for an operation whose adapter *is* implemented but whose
 * printer is not fully configured. Distinct code from
 * {@link PrinterCapabilityError} so the dashboard can offer the settings form
 * instead of the manual-transfer flow.
 */
export class PrinterNotConfiguredError extends AppError {
  constructor(printer: { id: string; name: string; protocol: string }, missing: PrinterRequirement[]) {
    super(
      `Принтер «${printer.name}» не настроен для удалённой работы — не хватает: ${missing
        .map((m) => `${m.label} (${m.hint})`)
        .join("; ")}`,
      "PRINTER_NOT_CONFIGURED",
      409,
      { printerId: printer.id, protocol: printer.protocol, missing }
    );
    this.name = "PrinterNotConfiguredError";
  }
}

/** Throws {@link PrinterNotConfiguredError} when any requirement is unmet. */
export function requireReady(printer: PrinterConfig): void {
  const readiness = printerReadiness(printer);
  if (!readiness.ready) {
    throw new PrinterNotConfiguredError(printer, readiness.missing);
  }
}

/**
 * The *boolean* capability names, so a caller can name the one it needs in an
 * error. Descriptive fields (`fileVerification`, the extension lists) are not
 * capabilities to require — they describe how a capability behaves.
 */
export type PrinterCapabilityName = Exclude<
  keyof PrinterCapabilities,
  "fileVerification" | "startableExtensions" | "deviceFileExtension"
>;

const CAPABILITY_LABEL: Record<PrinterCapabilityName, string> = {
  supportsUpload: "загрузка файлов",
  supportsFileListing: "просмотр файлов на устройстве",
  supportsRemoteStart: "удалённый запуск печати",
  supportsFileDelete: "удаление файлов"
};

/**
 * A **structured** refusal for an operation the adapter does not implement —
 * the alternative to pretending the operation succeeded. Carries the protocol
 * and the capability name so the dashboard can branch (offer the manual-transfer
 * flow) instead of parsing a message.
 */
export class PrinterCapabilityError extends AppError {
  constructor(
    printer: { id: string; name: string; protocol: string },
    capability: PrinterCapabilityName,
    hint?: string
  ) {
    super(
      `Адаптер «${printer.protocol}» принтера «${printer.name}» не поддерживает ${CAPABILITY_LABEL[capability]}${hint ? ` — ${hint}` : ""}`,
      "PRINTER_CAPABILITY_UNSUPPORTED",
      409,
      { printerId: printer.id, protocol: printer.protocol, capability }
    );
    this.name = "PrinterCapabilityError";
  }
}

/** Throws {@link PrinterCapabilityError} unless the adapter declares `capability`. */
export function requireCapability(
  printer: PrinterConfig,
  capability: PrinterCapabilityName,
  hint?: string
): void {
  if (!capabilitiesOf(printer)[capability]) {
    throw new PrinterCapabilityError(printer, capability, hint);
  }
}
