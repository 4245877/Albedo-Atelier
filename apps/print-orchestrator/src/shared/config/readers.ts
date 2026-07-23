// ── Env value parsing ───────────────────────────────────────────────────────
// One consistent rule for every scalar env value: surrounding whitespace is
// trimmed, an unset or blank value uses the documented default, and a
// present-but-malformed value FAILS startup with a message naming the variable
// rather than silently degrading to a wrong limit, interval or flag. Numbers are
// parsed strictly (never `parseInt`/`parseFloat`, which quietly keep the leading
// digits of "200MB" or "1.5x"). The LIGHT_* block is the one deliberate
// exception — it is lenient and records issues so the farm keeps running (see
// `parseLightScheduleEnv` in ./lights).

/** Accepted tokens for a boolean flag, kept in one place for the strict and lenient readers. */
export const TRUE_TOKENS = new Set(["true", "1", "yes", "on"]);
export const FALSE_TOKENS = new Set(["false", "0", "no", "off"]);
const BOOLEAN_TOKENS = [...TRUE_TOKENS, ...FALSE_TOKENS].join("/");

/** Log levels Pino accepts (Fastify passes `logLevel` straight through to Pino). */
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/** `undefined`/blank → null (caller uses its default); otherwise the trimmed token. */
export function normalizeEnv(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

interface NumericBounds {
  /** The value must be an integer. */
  integer?: boolean;
  /** Inclusive lower bound. */
  min?: number;
  /** Inclusive upper bound. */
  max?: number;
  /** Exclusive lower bound (strictly-positive → `exclusiveMin: 0`). */
  exclusiveMin?: number;
}

/**
 * Strictly parses a numeric env value, failing fast on anything that is not a
 * complete, finite number within `bounds`. `Number()` (unlike parseInt/
 * parseFloat) rejects a trailing suffix — "200MB", "10abc", "1.5x" all become
 * NaN — while still accepting decimals, signs and scientific notation. Unset or
 * blank → the default.
 */
function readNumber(
  name: string,
  value: string | undefined,
  fallback: number,
  bounds: NumericBounds = {}
): number {
  const token = normalizeEnv(value);
  if (token === null) return fallback;

  const parsed = Number(token);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: «${token}» (expected a finite number)`);
  }
  if (bounds.integer && !Number.isInteger(parsed)) {
    throw new Error(`Invalid ${name}: «${token}» (expected an integer)`);
  }
  if (bounds.exclusiveMin !== undefined && !(parsed > bounds.exclusiveMin)) {
    throw new Error(`Invalid ${name}: «${token}» (must be greater than ${bounds.exclusiveMin})`);
  }
  if (bounds.min !== undefined && parsed < bounds.min) {
    throw new Error(`Invalid ${name}: «${token}» (must be ≥ ${bounds.min})`);
  }
  if (bounds.max !== undefined && parsed > bounds.max) {
    throw new Error(`Invalid ${name}: «${token}» (must be ≤ ${bounds.max})`);
  }
  return parsed;
}

/** Any integer (may be negative); fails fast on garbage or a non-integer. */
export function readInteger(name: string, value: string | undefined, fallback: number): number {
  return readNumber(name, value, fallback, { integer: true });
}

/** A strictly-positive integer (upload/analysis limits, retention, the poll interval). */
export function readPositiveInt(name: string, value: string | undefined, fallback: number): number {
  return readNumber(name, value, fallback, { integer: true, min: 1 });
}

/** A non-negative integer (a delay/settle where 0 = "no wait" is legitimate). */
export function readNonNegativeInt(
  name: string,
  value: string | undefined,
  fallback: number
): number {
  return readNumber(name, value, fallback, { integer: true, min: 0 });
}

/** A TCP port (1…65535). */
export function readPort(name: string, value: string | undefined, fallback: number): number {
  return readNumber(name, value, fallback, { integer: true, min: 1, max: 65535 });
}

/** A strictly-positive number (e.g. a compression ratio). */
export function readPositiveNumber(
  name: string,
  value: string | undefined,
  fallback: number
): number {
  return readNumber(name, value, fallback, { exclusiveMin: 0 });
}

/** A non-negative number (e.g. a safety-buffer fraction; 0 = "no buffer"). */
export function readNonNegativeNumber(
  name: string,
  value: string | undefined,
  fallback: number
): number {
  return readNumber(name, value, fallback, { min: 0 });
}

/**
 * A boolean env flag. Accepts true/1/yes/on and false/0/no/off (any case,
 * trimmed); unset/blank → the default. A present-but-unrecognized value (a typo
 * like `ture`) FAILS startup rather than silently taking the default — a
 * security flag such as `ORCA_SLICER_NETWORK_ISOLATED` must never be quietly
 * disabled by a typo. The lenient LIGHT_* variant records an issue instead of
 * throwing, by design.
 */
export function readBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  const token = normalizeEnv(value);
  if (token === null) return fallback;
  const normalized = token.toLowerCase();
  if (TRUE_TOKENS.has(normalized)) return true;
  if (FALSE_TOKENS.has(normalized)) return false;
  throw new Error(`Invalid ${name}: «${token}» (expected a boolean: ${BOOLEAN_TOKENS})`);
}

/** The log level Fastify/Pino will use; an unknown level fails fast here, not later inside Pino. */
export function readLogLevel(value: string | undefined, fallback: string): string {
  const token = normalizeEnv(value);
  if (token === null) return fallback;
  const level = token.toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(level)) {
    throw new Error(`Invalid LOG_LEVEL: «${token}» (expected one of ${LOG_LEVELS.join(", ")})`);
  }
  return level;
}

/** Splits a shell-ish args string on whitespace (container-mode base args); empty → []. */
export function readArgs(value: string | undefined): string[] {
  const token = normalizeEnv(value);
  return token === null ? [] : token.split(/\s+/);
}
