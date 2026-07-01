import { createUnavailableDriver } from "../base/capabilities";
import type { PrinterDriverFactory } from "../base/DriverRegistry";

export const crealityDriverFactory: PrinterDriverFactory = (config) =>
  createUnavailableDriver("creality", config);
