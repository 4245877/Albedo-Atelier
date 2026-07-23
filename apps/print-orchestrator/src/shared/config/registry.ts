/**
 * The typed environment-variable registry.
 *
 * Every variable the service (or its deployment) consumes is declared exactly
 * once — either as a typed, env.ts-consumed reader (`envVar` and friends) or as
 * an `externalVar` consumed elsewhere (compose, printers.json `${VAR}`
 * substitution, a driver reading `process.env` directly). The registry is what
 * the `.env.example` correspondence test checks against, so an undeclared or
 * undocumented variable fails CI instead of silently drifting.
 */

/** Where env values come from (injectable for tests; `process.env` in production). */
export type EnvSource = Record<string, string | undefined>;

/** Thematic group — mirrors the `.env.example` sections and the config builders. */
export type EnvGroup =
  | "server"
  | "state"
  | "printers"
  | "uploads"
  | "slicing"
  | "scheduler"
  | "lights"
  | "filament"
  | "security"
  | "compose";

export interface RegisteredEnvVar {
  name: string;
  group: EnvGroup;
  /** Set when the variable is consumed outside `shared/env` (with the consumer). */
  externalConsumer?: string;
}

const registered = new Map<string, RegisteredEnvVar>();

function register(entry: RegisteredEnvVar): void {
  const existing = registered.get(entry.name);
  if (existing && (existing.group !== entry.group || existing.externalConsumer !== entry.externalConsumer)) {
    throw new Error(`Env var ${entry.name} registered twice with different metadata`);
  }
  registered.set(entry.name, entry);
}

/** Every declared variable, for the `.env.example` correspondence check. */
export function listRegisteredEnvVars(): RegisteredEnvVar[] {
  return [...registered.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A typed reader over one registered variable. */
export interface EnvReader<T> {
  readonly name: string;
  read(source: EnvSource): T;
}

/**
 * Declares one env-consumed variable: registers the name/group and returns the
 * typed reader the thematic builders use.
 */
export function envVar<T>(
  name: string,
  group: EnvGroup,
  read: (name: string, raw: string | undefined) => T
): EnvReader<T> {
  register({ name, group });
  return { name, read: (source) => read(name, source[name]) };
}

/**
 * Declares a variable consumed OUTSIDE `shared/env` — by compose, by the
 * printers-config `${VAR}` substitution, or by a driver reading `process.env`
 * directly. Registered so the `.env.example` check covers it; carries no reader.
 */
export function externalVar(name: string, group: EnvGroup, consumer: string): void {
  register({ name, group, externalConsumer: consumer });
}
