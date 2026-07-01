export type PrinterTechnology = "fdm" | "resin";

export type PrinterState = "offline" | "idle" | "printing" | "paused" | "error" | "maintenance";

export interface PrinterCapabilities {
  heatedBed: boolean;
  chamberHeating: boolean;
  camera: boolean;
  remoteStart: boolean;
  materialSlots: number;
}

export interface Printer {
  id: string;
  name: string;
  technology: PrinterTechnology;
  driver: string;
  state: PrinterState;
  capabilities: PrinterCapabilities;
  createdAt?: string;
  updatedAt?: string;
}
