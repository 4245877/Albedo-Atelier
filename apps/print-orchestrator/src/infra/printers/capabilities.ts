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
    fileVerification: "name_and_size"
  },
  // Bambu local MQTT + FTPS. Only pause/resume/cancel are implemented; a local
  // start needs a full 3mf/AMS mapping and the FTPS file transfer is not wired,
  // so every file capability is false — the operator copies the file and confirms.
  bambu: {
    supportsUpload: false,
    supportsFileListing: false,
    supportsRemoteStart: false,
    supportsFileDelete: false,
    fileVerification: "none"
  },
  // Creality's WebSocket protocol: telemetry only in this codebase.
  creality: {
    supportsUpload: false,
    supportsFileListing: false,
    supportsRemoteStart: false,
    supportsFileDelete: false,
    fileVerification: "none"
  }
};

/** Fail-closed capabilities for a protocol that is not in the table at all. */
const NONE: PrinterCapabilities = {
  supportsUpload: false,
  supportsFileListing: false,
  supportsRemoteStart: false,
  supportsFileDelete: false,
  fileVerification: "none"
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

/** The capability names, so a caller can name the one it needs in an error. */
export type PrinterCapabilityName = Exclude<keyof PrinterCapabilities, "fileVerification">;

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
