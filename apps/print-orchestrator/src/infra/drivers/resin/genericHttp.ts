import { createUnavailableDriver } from "../base/capabilities";
import type { PrinterDriverFactory } from "../base/DriverRegistry";

export const genericHttpDriverFactory: PrinterDriverFactory = (config) =>
  createUnavailableDriver("generic-http", config);
