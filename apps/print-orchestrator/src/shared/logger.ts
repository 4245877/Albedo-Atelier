import { env } from "./env";

export const loggerConfig = {
  level: env.logLevel
};

/**
 * The minimal structural logger the application services and stores accept.
 * Fastify's request/app logger satisfies it; tests pass `{}` or a recorder.
 * Every method is optional so a collaborator can be built before the real
 * logger exists (e.g. the state store loads during construction).
 */
export type StoreLogger = {
  info?: (obj: unknown, message?: string) => void;
  warn?: (obj: unknown, message?: string) => void;
  error?: (obj: unknown, message?: string) => void;
};
