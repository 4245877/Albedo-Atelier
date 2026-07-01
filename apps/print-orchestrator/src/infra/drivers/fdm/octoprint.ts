import { createUnavailableDriver } from "../base/capabilities";
import type { PrinterDriverFactory } from "../base/DriverRegistry";

export const octoprintDriverFactory: PrinterDriverFactory = (config) =>
  createUnavailableDriver("octoprint", config);
