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
  /** True when an online live browser-safe camera stream is available now. */
  cameraStream: boolean;
  /** Online go2rtc stream name to view over WebRTC (via `/go2rtc/`), or null. */
  cameraSrc: string | null;
  /** Chamber light state; null — the device does not expose light control. */
  light: boolean | null;
  /** Whether this printer has a configured light command. */
  lightSupported: boolean;
  /** Whether the schedule currently wants the light on. */
  lightAllowed: boolean;
  snapshotAt: string | null;
  error?: string;
  note?: string;
}
