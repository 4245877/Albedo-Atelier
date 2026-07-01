import { createUnavailableDriver } from "../base/capabilities";
import type { PrinterDriverFactory } from "../base/DriverRegistry";

export const anycubicDriverFactory: PrinterDriverFactory = (config) =>
  createUnavailableDriver("anycubic", config);
