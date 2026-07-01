import { createUnavailableDriver } from "../base/capabilities";
import type { PrinterDriverFactory } from "../base/DriverRegistry";

export const elegooDriverFactory: PrinterDriverFactory = (config) =>
  createUnavailableDriver("elegoo", config);
