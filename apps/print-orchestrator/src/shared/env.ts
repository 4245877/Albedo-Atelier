import path from "node:path";

import { buildFilamentConfig } from "./config/filament";
import { parseLightScheduleEnv } from "./config/lights";
import { buildSchedulerConfig } from "./config/scheduler";
import { buildSecurityConfig } from "./config/security";
import { buildServerConfig } from "./config/server";
import { buildSlicingConfig } from "./config/slicing";
import { buildStateConfig } from "./config/state";
import { buildUploadsConfig } from "./config/uploads";
// Externals register their names into the registry as a side effect, so the
// `.env.example` correspondence test sees the complete inventory.
import "./config/externals";

/**
 * The composed runtime configuration, built from `process.env` exactly once at
 * module load.
 *
 * Every variable is DECLARED in the typed registry (`./config/registry`) by its
 * thematic builder — server, state, uploads, slicing, scheduler, lights,
 * filament, security — and `./config/externals` inventories the variables
 * consumed outside this module (compose, printers.json). The
 * `config/registry.test.ts` check keeps the registry and `.env.example` in
 * lockstep, so an undeclared or undocumented variable fails CI.
 *
 * This module keeps the historical export shape (`env`, `uploads`, `slicing`,
 * the strict readers and the lenient light-schedule parser) so consumers and
 * tests are untouched by the registry refactor.
 */

const source = process.env;

const server = buildServerConfig(source);
const state = buildStateConfig(source);
const stateDir = path.dirname(state.stateFilePath);
const scheduler = buildSchedulerConfig(source);
const filament = buildFilamentConfig(source);
const security = buildSecurityConfig(source);

/** Upload + analysis limits and locations (see `config/uploads.ts`). */
export const uploads = Object.freeze(buildUploadsConfig(source, stateDir));

/** OrcaSlicer preset-catalog + slicing-runtime configuration (see `config/slicing.ts`). */
export const slicing = Object.freeze(buildSlicingConfig(source, stateDir));

export const env = Object.freeze({
  ...server,
  ...state,
  ...scheduler,
  ...filament,
  ...security,
  /** Chamber-light schedule (`LIGHT_*`); invalid values degrade, never throw. */
  lightSchedule: parseLightScheduleEnv(source, scheduler.nightWindow)
});

// ── Back-compat re-exports ───────────────────────────────────────────────────
// The strict scalar readers and the lenient LIGHT_* parser kept their public
// home here when the implementations moved into ./config.
export {
  readBoolean,
  readInteger,
  readLogLevel,
  readNonNegativeInt,
  readNonNegativeNumber,
  readPort,
  readPositiveInt,
  readPositiveNumber
} from "./config/readers";
export { parseLightScheduleEnv, type LightScheduleConfig, type LightScheduleMode } from "./config/lights";
