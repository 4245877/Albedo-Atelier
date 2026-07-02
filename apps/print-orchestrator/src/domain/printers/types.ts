export type PrinterTechnology = "FDM" | "Resin";

export type PrinterState =
  | "offline"
  | "idle"
  | "printing"
  | "paused"
  | "error"
  | "maintenance"
  /** The device is configured but has not reported a definite state yet. */
  | "unknown";

export type CameraState = "online" | "offline" | "none";

export interface PrinterCapabilities {
  heatedBed: boolean;
  chamberHeating: boolean;
  camera: boolean;
  remoteStart: boolean;
  materialSlots: number;
}

/**
 * Static connection config for a printer. Adapted from apps/fulfillment's
 * `PrinterConfig`: this is where a real driver (Bambu MQTT, Moonraker, Chitu…)
 * reads how to reach the device. It is intentionally kept separate from the
 * live {@link PrinterView} telemetry so a driver can be wired in later without
 * touching the dashboard-facing shape.
 */
export interface PrinterConnection {
  driver: string;
  protocol?: "mqtt" | "moonraker" | "http" | "serial";
  host?: string;
  port?: number;
}

/**
 * Live, dashboard-facing view of a printer. The keys here match the shape the
 * frontend renders 1:1 (`type`, `status`, `nozzle`/`bed` as `[current,target]`)
 * so the dashboard can display it without extra processing.
 *
 * Every telemetry field is nullable: `null` means the device did not report
 * the value, and the dashboard must show it as unknown rather than invent one.
 */
export interface PrinterView {
  id: string;
  name: string;
  model: string | null;
  type: PrinterTechnology;
  status: PrinterState;
  job: string | null;
  progress: number | null;
  /** `[current, target]` °C; target is null when the device does not report it. */
  nozzle: [number, number | null] | null;
  /** `[current, target]` °C; target is null when the device does not report it. */
  bed: [number, number | null] | null;
  chamber: number | null;
  minutesLeft: number | null;
  /** Declared loaded material from config; null when not specified. */
  material: string | null;
  swatch: string | null;
  camera: CameraState;
  /** Chamber light state; null — the device does not expose light control. */
  light: boolean | null;
  snapshotAt: string | null;
  error?: string;
  note?: string;
}

/**
 * Internal record held by the store: the dashboard view plus the connection
 * config and capabilities that stay server-side. {@link toPrinterView} strips
 * the internal fields before the record is sent to the dashboard.
 */
export interface PrinterRecord extends PrinterView {
  connection: PrinterConnection;
  capabilities: PrinterCapabilities;
}

export function toPrinterView(record: PrinterRecord): PrinterView {
  const { connection: _connection, capabilities: _capabilities, ...view } = record;
  return view;
}
