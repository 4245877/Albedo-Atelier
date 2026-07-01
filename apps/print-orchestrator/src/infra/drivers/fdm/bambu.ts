import { createUnavailableDriver } from "../base/capabilities";
import type { PrinterDriverFactory } from "../base/DriverRegistry";

export const bambuDriverFactory: PrinterDriverFactory = (config) =>
  createUnavailableDriver("bambu", config);
