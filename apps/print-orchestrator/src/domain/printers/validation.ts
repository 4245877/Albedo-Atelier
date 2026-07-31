import { ValidationError } from "../../core/errors";
import {
  DEFAULT_LIGHT_SETTINGS,
  NO_AUTOMATIC_CONTINUATION,
  PRINTER_ID_RE,
  PRINTER_PROTOCOLS,
  type AutomaticContinuationConfig,
  type PrinterLightSettings,
  type PrinterProtocol,
  type PrinterRecord
} from "./config";
import type { PrinterTechnology } from "./types";

/**
 * Validation of operator-supplied printer settings.
 *
 * The loader in `infra/printers/config.ts` is deliberately *lenient*: a bad
 * entry in a hand-written JSON file is dropped so one typo cannot take the whole
 * farm down. This module is the opposite and deliberately so — input arriving
 * from the UI is answered with a precise 400 naming the field, because silently
 * dropping what an operator just typed is how a printer ends up "saved" with an
 * empty access code and no explanation.
 *
 * Everything here is pure: it takes raw JSON and an optional existing record and
 * returns the record to store. Uniqueness, persistence and audit belong to the
 * service above it.
 */

/** Raw (unvalidated) input as it arrives from the API — every field optional. */
export type PrinterInput = Record<string, unknown>;

export interface BuildOptions {
  /** The record being edited; absent for a create. */
  base?: PrinterRecord;
  /** ISO timestamp stamped on the result. */
  now: string;
  /** Position for a newly created printer (ignored on edit). */
  nextPosition?: number;
}

const MAX_TEXT = 200;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Present in the payload at all? An absent key means "leave as it was". */
function has(input: PrinterInput, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function text(value: unknown, field: string, { max = MAX_TEXT } = {}): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") {
    throw new ValidationError(`Поле «${field}» должно быть строкой`, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ValidationError(`Поле «${field}» длиннее ${max} символов`, { field });
  }
  return trimmed;
}

function requiredText(value: unknown, field: string): string {
  const result = text(value, field);
  if (!result) throw new ValidationError(`Поле «${field}» обязательно`, { field });
  return result;
}

function bool(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new ValidationError(`Поле «${field}» должно быть boolean`, { field });
  }
  return value;
}

/**
 * An optional positive number: `null`/`""` clears it, a non-number or a
 * non-positive value is a 400 (never a silent drop to null — the operator would
 * see the field simply not save).
 */
function positiveNumberOrNull(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
    throw new ValidationError(`Поле «${field}» должно быть положительным числом`, { field });
  }
  return parsed;
}

function portOrNull(value: unknown): number | null {
  const parsed = positiveNumberOrNull(value, "port");
  if (parsed === null) return null;
  if (!Number.isInteger(parsed) || parsed > 65535) {
    throw new ValidationError("Поле «port» должно быть целым числом 1…65535", { field: "port" });
  }
  return parsed;
}

/**
 * An http(s) URL or "". Anything else is refused rather than stored: the
 * interface link becomes a clickable href and the camera URLs are fetched by
 * the backend, so a `file:`/`javascript:` value must never reach either.
 */
function httpUrlOrEmpty(value: unknown, field: string): string {
  const raw = text(value, field, { max: 500 });
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) {
    throw new ValidationError(`Поле «${field}» должно быть http(s)-ссылкой`, { field });
  }
  return raw;
}

function protocol(value: unknown): PrinterProtocol {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!(PRINTER_PROTOCOLS as readonly string[]).includes(raw)) {
    throw new ValidationError(
      `Поле «protocol» должно быть одним из: ${PRINTER_PROTOCOLS.join(", ")}`,
      { field: "protocol" }
    );
  }
  return raw as PrinterProtocol;
}

function technology(value: unknown): PrinterTechnology {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "resin") return "Resin";
  if (raw === "fdm") return "FDM";
  throw new ValidationError("Поле «type» должно быть FDM или Resin", { field: "type" });
}

/** `#RGB`/`#RRGGBB` or "" — it is written straight into a CSS colour. */
function swatch(value: unknown): string {
  const raw = text(value, "swatch", { max: 32 });
  if (!raw) return "";
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) {
    throw new ValidationError("Поле «swatch» должно быть HEX-цветом, например #7fb3d8", {
      field: "swatch"
    });
  }
  return raw;
}

function buildVolume(value: unknown): { x: number; y: number; z: number } | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) {
    throw new ValidationError("Поле «buildVolume» должно быть объектом {x, y, z} в мм", {
      field: "buildVolume"
    });
  }
  // An empty object (every axis cleared in the form) means "not configured".
  if (["x", "y", "z"].every((axis) => value[axis] === null || value[axis] === undefined || value[axis] === "")) {
    return null;
  }
  const x = positiveNumberOrNull(value.x, "buildVolume.x");
  const y = positiveNumberOrNull(value.y, "buildVolume.y");
  const z = positiveNumberOrNull(value.z, "buildVolume.z");
  if (x === null || y === null || z === null) {
    throw new ValidationError(
      "Габариты стола указываются целиком: нужны все три оси x, y, z (в мм)",
      { field: "buildVolume" }
    );
  }
  return { x, y, z };
}

function automaticContinuation(
  value: unknown,
  base: AutomaticContinuationConfig
): AutomaticContinuationConfig {
  if (value === undefined) return base;
  if (value === null) return { ...NO_AUTOMATIC_CONTINUATION };
  if (!isObject(value)) {
    throw new ValidationError("Поле «automaticContinuation» должно быть объектом", {
      field: "automaticContinuation"
    });
  }
  const allowed = bool(value.allowed, "automaticContinuation.allowed", base.allowed);
  const mechanism = has(value, "mechanism")
    ? text(value.mechanism, "automaticContinuation.mechanism")
    : base.mechanism;

  let verifiedAt = base.verifiedAt;
  if (has(value, "verifiedAt")) {
    const raw = text(value.verifiedAt, "automaticContinuation.verifiedAt", { max: 64 });
    if (!raw) verifiedAt = null;
    else if (!Number.isFinite(Date.parse(raw))) {
      throw new ValidationError(
        "Поле «automaticContinuation.verifiedAt» должно быть датой ISO-8601",
        { field: "automaticContinuation.verifiedAt" }
      );
    } else verifiedAt = raw;
  }

  // Fail-closed pairing, stated at the boundary instead of silently later: an
  // opt-in without a recorded physical check does not clear a single bed, so
  // saving that combination would look like it enabled something it did not.
  if (allowed && !verifiedAt) {
    throw new ValidationError(
      "Автопродолжение включается только вместе с датой проверки механизма (verifiedAt)",
      { field: "automaticContinuation.verifiedAt" }
    );
  }
  return { allowed, mechanism, verifiedAt };
}

function light(value: unknown, base: PrinterLightSettings): PrinterLightSettings {
  if (value === undefined) return base;
  if (value === null) return { ...DEFAULT_LIGHT_SETTINGS };
  if (!isObject(value)) {
    throw new ValidationError("Поле «light» должно быть объектом", { field: "light" });
  }

  let enabled = base.enabled;
  if (has(value, "enabled")) {
    const raw = value.enabled;
    if (raw === null) enabled = null;
    else if (typeof raw === "boolean") enabled = raw;
    else throw new ValidationError("Поле «light.enabled» должно быть boolean или null", {
      field: "light.enabled"
    });
  }

  return {
    enabled,
    pin: has(value, "pin") ? text(value.pin, "light.pin", { max: 64 }) : base.pin,
    invert: bool(value.invert, "light.invert", base.invert),
    onGcode: has(value, "onGcode") ? text(value.onGcode, "light.onGcode") : base.onGcode,
    offGcode: has(value, "offGcode") ? text(value.offGcode, "light.offGcode") : base.offGcode,
    statusObject: has(value, "statusObject")
      ? text(value.statusObject, "light.statusObject")
      : base.statusObject,
    statusField: has(value, "statusField")
      ? text(value.statusField, "light.statusField", { max: 64 })
      : base.statusField,
    bambuNode: has(value, "bambuNode")
      ? text(value.bambuNode, "light.bambuNode", { max: 64 })
      : base.bambuNode
  };
}

/**
 * A credential field. Three distinct meanings, and the distinction is the whole
 * point of the "reset the access code" flow:
 *
 *  - **absent** → keep whatever is stored. This is what lets the UI submit the
 *    full form without ever having received the current secret;
 *  - **`null`** → clear it explicitly;
 *  - **a string** → replace it.
 */
function secret(input: PrinterInput, field: string, base: string): string {
  if (!has(input, field)) return base;
  const raw = input[field];
  if (raw === null) return "";
  return text(raw, field, { max: 500 });
}

/** Validates the operator-chosen id (create only — the id is immutable after). */
export function validatePrinterId(value: unknown): string {
  const id = requiredText(value, "id");
  if (!PRINTER_ID_RE.test(id)) {
    throw new ValidationError(
      "Поле «id» может содержать только латиницу, цифры, дефис и подчёркивание (оно используется в путях и ссылках)",
      { field: "id" }
    );
  }
  if (id.length > 64) {
    throw new ValidationError("Поле «id» длиннее 64 символов", { field: "id" });
  }
  return id;
}

/**
 * Builds the record to store from raw input, merged over `base` when editing.
 * Absent keys keep the stored value, so a partial PATCH is safe; explicit nulls
 * clear. Throws {@link ValidationError} naming the offending field.
 */
export function buildPrinterRecord(input: PrinterInput, options: BuildOptions): PrinterRecord {
  if (!isObject(input)) {
    throw new ValidationError("Тело запроса должно быть объектом с настройками принтера");
  }
  const base = options.base;
  const id = base ? base.id : validatePrinterId(input.id);

  // The two fields a printer cannot exist without. On create they must be given;
  // on edit an absent key keeps the stored value but an empty one is refused.
  const name = has(input, "name") || !base ? requiredText(input.name, "name") : base.name;
  const host = has(input, "host") || !base ? requiredText(input.host, "host") : base.host;

  const record: PrinterRecord = {
    id,
    name,
    host,
    model: has(input, "model") ? text(input.model, "model") : (base?.model ?? ""),
    type: has(input, "type") || !base ? technology(input.type ?? base?.type ?? "FDM") : base.type,
    printerClass: has(input, "printerClass")
      ? text(input.printerClass, "printerClass", { max: 64 })
      : (base?.printerClass ?? ""),

    protocol:
      has(input, "protocol") || !base
        ? protocol(input.protocol ?? base?.protocol)
        : base.protocol,
    port: has(input, "port") ? portOrNull(input.port) : (base?.port ?? null),

    material: has(input, "material") ? text(input.material, "material") : (base?.material ?? ""),
    nozzleDiameterMm: has(input, "nozzleDiameterMm")
      ? positiveNumberOrNull(input.nozzleDiameterMm, "nozzleDiameterMm")
      : (base?.nozzleDiameterMm ?? null),
    nozzleType: has(input, "nozzleType")
      ? text(input.nozzleType, "nozzleType", { max: 64 })
      : (base?.nozzleType ?? ""),
    buildVolume: has(input, "buildVolume")
      ? buildVolume(input.buildVolume)
      : (base?.buildVolume ?? null),
    swatch: has(input, "swatch") ? swatch(input.swatch) : (base?.swatch ?? ""),
    snapshotUrl: has(input, "snapshotUrl")
      ? httpUrlOrEmpty(input.snapshotUrl, "snapshotUrl")
      : (base?.snapshotUrl ?? ""),
    streamUrl: has(input, "streamUrl")
      ? httpUrlOrEmpty(input.streamUrl, "streamUrl")
      : (base?.streamUrl ?? ""),
    interfaceUrl: has(input, "interfaceUrl")
      ? httpUrlOrEmpty(input.interfaceUrl, "interfaceUrl")
      : (base?.interfaceUrl ?? ""),

    enabled: bool(input.enabled, "enabled", base?.enabled ?? true),

    apiKey: secret(input, "apiKey", base?.apiKey ?? ""),
    serial: secret(input, "serial", base?.serial ?? ""),
    accessCode: secret(input, "accessCode", base?.accessCode ?? ""),
    allowInsecureTls: bool(input.allowInsecureTls, "allowInsecureTls", base?.allowInsecureTls ?? false),

    automaticContinuation: automaticContinuation(
      input.automaticContinuation,
      base?.automaticContinuation ?? { ...NO_AUTOMATIC_CONTINUATION }
    ),
    light: light(input.light, base?.light ?? { ...DEFAULT_LIGHT_SETTINGS }),

    position: base?.position ?? options.nextPosition ?? 0,
    createdAt: base?.createdAt ?? options.now,
    updatedAt: options.now,
    version: base?.version ?? 1,
    metadata: base?.metadata ?? {}
  };

  assertProtocolRequirements(record);
  return record;
}

/**
 * Cross-field rules that only make sense once the protocol is known. These are
 * warnings-turned-errors on purpose: a Bambu printer without a serial cannot
 * connect at all, and saving it silently would show up hours later as a printer
 * that is simply "offline" for no stated reason.
 */
function assertProtocolRequirements(record: PrinterRecord): void {
  if (record.protocol !== "bambu") return;
  // Only enforced for an enabled printer: a draft can be saved disabled and
  // completed later, which is exactly the "add a printer step by step" flow.
  if (!record.enabled) return;
  if (!record.serial) {
    throw new ValidationError(
      "Для Bambu Lab обязателен серийный номер принтера (serial) — без него LAN-подключение невозможно",
      { field: "serial" }
    );
  }
  if (!record.accessCode) {
    throw new ValidationError(
      "Для Bambu Lab обязателен код доступа (accessCode) с экрана принтера: настройки → сеть → LAN",
      { field: "accessCode" }
    );
  }
}
