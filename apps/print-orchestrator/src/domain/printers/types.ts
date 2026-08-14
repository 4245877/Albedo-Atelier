import type { AmsKind } from "./modelSpecs";
import type { SpecSource } from "./specs";

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
  /** Resolved model — from the device where it identifies itself, else declared. */
  model: string | null;
  /** Where {@link model} came from. */
  modelSource: SpecSource;
  /** Device firmware version when the printer reports one; null otherwise. */
  firmware: string | null;
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
  /**
   * The canonical SQLite run currently holding this printer (dispatch-created),
   * or null. The dashboard snapshots it when confirming dangerous commands
   * (cancel/pause) so the backend can refuse (409) when the physical run
   * changed under the confirmation — even for a re-print of the same file name.
   */
  activeRunId?: string | null;
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
   * the declared `nozzleDiameterMm` fallback; null when neither is known. It is
   * a printer/slicer *setting*, not a physical sensor.
   */
  nozzleDiameter: number | null;
  /** Where {@link nozzleDiameter} came from. */
  nozzleDiameterSource: SpecSource;
  /** Nozzle hardware type (e.g. "hardened_steel"), from the printer or declared; null when unknown. */
  nozzleType: string | null;
  /** Where {@link nozzleType} came from. */
  nozzleTypeSource: SpecSource;
  /** Active filament material live from the printer (AMS tray or external spool); null when unreported. */
  liveMaterial: string | null;
  /** `#RRGGBB` of the active filament live from the printer; null when unreported. */
  liveMaterialColor: string | null;
  /** Where the shown filament came from. */
  liveMaterialSource: SpecSource;
  /** Global AMS tray index currently feeding; null for the external spool or when unknown. */
  activeTray: number | null;
  /**
   * Resolved build volume in mm. Read from the device on Klipper
   * (`stepper_*.position_max`), from the model catalogue on Bambu (whose
   * protocol does not carry it), else the declared value. Null when unknown.
   */
  buildVolume: { x: number; y: number; z: number } | null;
  /** Where {@link buildVolume} came from. */
  buildVolumeSource: SpecSource;
  /** Whether a multi-material unit is attached; null when the printer cannot say. */
  ams: boolean | null;
  /** Which kind it is (AMS / AMS Lite / CFS) — a model property; null when unknown. */
  amsKind: AmsKind | null;
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
  /** True when the adapter is implemented but this printer lacks configuration. */
  setupRequired: boolean;
  /** Exactly which fields are missing, each with where to obtain it. */
  setupMissing: { field: string; label: string; hint: string }[];
  /** Configured URL of the printer's own web UI, or null when none is set. */
  interfaceUrl: string | null;
  error?: string;
}
