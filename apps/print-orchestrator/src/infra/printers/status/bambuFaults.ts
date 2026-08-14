import type { PrinterFault } from "./types";

/**
 * Decoding what a Bambu printer *complains* about, as opposed to what it is
 * doing.
 *
 * The LAN report has carried two fault channels all along and the adapter read
 * neither: `print_error`, a 32-bit register holding the code the machine puts on
 * its own screen, and `hms`, the Health Management System list. Because neither
 * reached the service, the one incident this module exists for — an A1 that
 * could not read its MicroSD card and so never started a job that was uploaded,
 * verified and correct — surfaced to the operator as "принтер занят / в ошибке /
 * истекло ожидание" and nowhere as the sentence the printer itself was
 * displaying.
 *
 * ## Rendering the codes
 *
 * Both registers are integers; both are *displayed* as hex halves, and the
 * displayed form is the only identifier that is any use to a human — it is what
 * the screen shows, what the manual indexes and what a search finds. So the
 * codes here are rendered exactly as the device renders them:
 *
 *  - `print_error` → `%04X-%04X`, e.g. `0x0500C010` → `0500-C010`;
 *  - one `hms` entry (`{attr, code}`) → `%04X_%04X_%04X_%04X`, the four 16-bit
 *    halves, which is the form Bambu's own HMS index uses.
 *
 * ## Naming the codes
 *
 * {@link KNOWN_FAULTS} holds only codes whose meaning has been *observed on a
 * machine in this farm* — the text below is transcribed from the A1's screen,
 * not from a guess about what a number range implies. Everything else is
 * reported honestly with its code and no invented meaning, and never blocks:
 * Bambu emits benign advisories through the same channel, and refusing a print
 * on an unrecognised number would ground the farm on a guess. That asymmetry is
 * the whole safety argument — an unknown fault costs a line in the diagnostics
 * panel, a mis-declared one costs a print.
 */

/** Fault codes confirmed against a real device, with the remedy they call for. */
const KNOWN_FAULTS: Record<string, { title: string; action: string; blocksStart: boolean }> = {
  // Observed 2026-08-14 on «Bambu Lab A1 Combo» while starting an uploaded and
  // verified plate package: the printer displayed this code and stayed IDLE, so
  // the job never began. Text as shown on the device's own screen.
  "0500-C010": {
    title: "Ошибка чтения/записи карты MicroSD",
    action:
      "Принтер не может прочитать карту MicroSD, на которой лежит файл печати. " +
      "Переустановите карту или замените её, затем повторите запуск.",
    blocksStart: true
  }
};

/** `0x0500C010` → `"0500-C010"`. The form on the printer's screen. */
export function formatBambuPrintError(value: number): string {
  const raw = value >>> 0;
  return `${hex16(raw >>> 16)}-${hex16(raw & 0xffff)}`;
}

/** `{attr, code}` → `"0300_0100_0002_0001"`. The form Bambu's HMS index uses. */
export function formatBambuHmsCode(attr: number, code: number): string {
  const a = attr >>> 0;
  const c = code >>> 0;
  return [a >>> 16, a & 0xffff, c >>> 16, c & 0xffff].map(hex16).join("_");
}

function hex16(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

function describe(code: string, source: string): PrinterFault {
  const known = KNOWN_FAULTS[code];
  return {
    code,
    source,
    title: known?.title ?? null,
    action: known?.action ?? null,
    blocksStart: known?.blocksStart ?? false
  };
}

/**
 * Every fault a merged `print` report is carrying, newest register first.
 *
 * A zero `print_error` means "no fault" and is dropped; an empty `hms` array
 * means the device explicitly has nothing to report. Duplicate codes across the
 * two registers collapse to one entry — the same fault is often visible in both,
 * and showing an operator the same code twice is how the previous incident's
 * error list became unreadable.
 */
export function parseBambuFaults(print: Record<string, unknown>): PrinterFault[] {
  const faults: PrinterFault[] = [];
  const seen = new Set<string>();

  const add = (fault: PrinterFault): void => {
    if (seen.has(fault.code)) return;
    seen.add(fault.code);
    faults.push(fault);
  };

  const printError = toUint32(print.print_error ?? print.mc_print_error_code);
  if (printError !== null && printError > 0) {
    add(describe(formatBambuPrintError(printError), "print_error"));
  }

  if (Array.isArray(print.hms)) {
    for (const entry of print.hms) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const attr = toUint32((entry as Record<string, unknown>).attr);
      const code = toUint32((entry as Record<string, unknown>).code);
      if (attr === null || code === null || (attr === 0 && code === 0)) continue;
      add(describe(formatBambuHmsCode(attr, code), "hms"));
    }
  }

  return faults;
}

/**
 * Whether the device says its removable print medium is readable.
 *
 * Bambu reports `sdcard` as a boolean; some firmwares send a string. `null` when
 * the field is absent — "the device did not say", never "the card is fine".
 */
export function parseBambuMediaPresent(print: Record<string, unknown>): boolean | null {
  const value = print.sdcard;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "ok", "normal"].includes(normalized)) return true;
    if (["false", "0", "no", "none", "missing", "abnormal"].includes(normalized)) return false;
  }
  return null;
}

/** The faults that provably prevent a start — the only ones allowed to refuse one. */
export function startBlockingFaults(faults: readonly PrinterFault[]): PrinterFault[] {
  return faults.filter((f) => f.blocksStart);
}

function toUint32(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(numeric) ? numeric >>> 0 : null;
}
