import type { PrinterCapabilities } from "./types";

export const defaultFdmCapabilities: PrinterCapabilities = {
  heatedBed: true,
  chamberHeating: false,
  camera: false,
  remoteStart: false,
  materialSlots: 1
};

export const defaultResinCapabilities: PrinterCapabilities = {
  heatedBed: false,
  chamberHeating: false,
  camera: false,
  remoteStart: false,
  materialSlots: 1
};
