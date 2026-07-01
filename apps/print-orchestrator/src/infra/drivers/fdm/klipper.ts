import { createUnavailableDriver } from "../base/capabilities";
import type { PrinterDriverFactory } from "../base/DriverRegistry";

export const klipperDriverFactory: PrinterDriverFactory = (config) =>
  createUnavailableDriver("klipper", config);
