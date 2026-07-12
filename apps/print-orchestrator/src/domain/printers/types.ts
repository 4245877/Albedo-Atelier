export type PrinterTechnology = "FDM" | "Resin";

export type PrinterState =
  | "offline"
  | "idle"
  | "printing"
  | "paused"
  | "error"
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
  /** Whether the device answered the last poll (false while offline/unreported). */
  online: boolean;
  /**
   * Raw device state string (e.g. Moonraker "complete"/"cancelled", Bambu
   * "FINISH"). Consumers such as the fulfillment monitor use it to tell a
   * cancelled print from a completed one; null until the device reports one.
   */
  stateText: string | null;
  /** Human-readable reason (pause reason, error text) when the device gives one. */
  stateMessage: string | null;
  /** When the underlying live status was produced; null before the first report. */
  updatedAt: string | null;
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
  /**
   * Nozzle diameter in mm. Live from the printer where it reports the setting
   * (Bambu `nozzle_diameter`, or Klipper/Moonraker `configfile` on the K2), else
   * the configured `nozzleDiameterMm` fallback; null when neither is known. It is
   * a printer/slicer *setting*, not a physical sensor.
   */
  nozzleDiameter: number | null;
  /** Where {@link nozzleDiameter} came from: `printer` (live), `config` (printers.json) or `unknown`. */
  nozzleDiameterSource: "printer" | "config" | "unknown";
  /** Nozzle hardware type (e.g. "hardened_steel"), live from the printer or the config fallback; null when unknown. */
  nozzleType: string | null;
  /** Where {@link nozzleType} came from: `printer` (live), `config` (printers.json) or `unknown`. */
  nozzleTypeSource: "printer" | "config" | "unknown";
  /** Active filament material live from the printer (AMS tray or external spool); null when unreported. */
  liveMaterial: string | null;
  /** `#RRGGBB` of the active filament live from the printer; null when unreported. */
  liveMaterialColor: string | null;
  /**
   * Where the shown filament came from: `printer` (live telemetry), `config`
   * (fallback from printers.json) or `unknown` (neither available).
   */
  liveMaterialSource: "printer" | "config" | "unknown";
  /** Global AMS tray index currently feeding; null for the external spool or when unknown. */
  activeTray: number | null;
  camera: CameraState;
  /** True when an online live browser-safe camera stream is available now. */
  cameraStream: boolean;
  /** Online go2rtc stream name to view over WebRTC (via `/go2rtc/`), or null. */
  cameraSrc: string | null;
  /** Chamber light state; null — the device does not expose light control. */
  light: boolean | null;
  /** Whether this printer has a configured light command. */
  lightSupported: boolean;
  snapshotAt: string | null;
  /**
   * Whether the backend can capture and save a still snapshot for this camera —
   * the capability flag the dashboard uses to enable/disable the snapshot button,
   * instead of guessing from `camera`/`cameraSrc`.
   */
  snapshotAvailable: boolean;
  /** API path of the most recently saved snapshot, or null when none exist yet. */
  latestSnapshotUrl: string | null;
  /** Whether the backend can browse this printer's on-device files (Moonraker only). */
  filesSupported: boolean;
  /** Whether the backend can remote-start an on-device file (Moonraker only). */
  remoteStartSupported: boolean;
  /** Configured URL of the printer's own web UI, or null when none is set. */
  interfaceUrl: string | null;
  error?: string;
}
