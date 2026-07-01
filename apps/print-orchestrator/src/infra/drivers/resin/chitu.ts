import { createUnavailableDriver } from "../base/capabilities";
import type { PrinterDriverFactory } from "../base/DriverRegistry";

export const chituDriverFactory: PrinterDriverFactory = (config) =>
  createUnavailableDriver("chitu", config);
