import type { PrinterView } from "../../domain/printers/types";
import { hasCameraSource, hasCameraStream, resolveWebrtcSource } from "../printers/camera";
import type { PrinterConfig } from "../printers/config";
import { supportsPrinterLight, type PrinterLiveStatus } from "../printers/status";
import type { CameraEntry } from "./cameraService";

export function isBusyStatus(status: PrinterView["status"]): boolean {
  return status === "printing" || status === "paused";
}

/**
 * The dashboard-facing view for a printer, from its static config plus the live
 * status and camera entry. Keys match the frontend 1:1; every telemetry field
 * is null when the device did not report it.
 */
export function buildPrinterView(
  printer: PrinterConfig,
  status: PrinterLiveStatus | undefined,
  camera: CameraEntry | undefined
): PrinterView {
  const viewStatus: PrinterView["status"] = !status
    ? "unknown"
    : !status.online
      ? status.status === "unknown"
        ? "unknown"
        : "offline"
      : status.status;

  const cameraState = hasCameraSource(printer) ? camera?.state ?? "offline" : "none";
  const cameraOnline = cameraState === "online";
  const webrtcSource = resolveWebrtcSource(printer);

  // Prefer live filament telemetry from the device; fall back to the configured
  // material. Only "printer" is authoritative — config is a declared default.
  const activeFilament = status?.activeFilament ?? null;
  const liveMaterial = activeFilament?.material ?? null;
  const liveMaterialSource: PrinterView["liveMaterialSource"] = liveMaterial
    ? "printer"
    : printer.material
      ? "config"
      : "unknown";

  return {
    id: printer.id,
    name: printer.name,
    model: printer.model || null,
    type: printer.type,
    status: viewStatus,
    job: status?.currentFile ?? null,
    progress: status?.progressPct ?? null,
    nozzle: status && status.nozzleTemp !== null ? [status.nozzleTemp, status.nozzleTarget] : null,
    bed: status && status.bedTemp !== null ? [status.bedTemp, status.bedTarget] : null,
    chamber: status?.chamberTemp ?? null,
    minutesLeft: status?.remainingMinutes ?? null,
    material: printer.material || null,
    swatch: printer.swatch || null,
    nozzleDiameter: status?.nozzleDiameterMm ?? null,
    nozzleType: status?.nozzleType ?? null,
    liveMaterial,
    liveMaterialColor: activeFilament?.color ?? null,
    liveMaterialSource,
    activeTray: activeFilament?.tray ?? null,
    camera: cameraState,
    cameraStream: cameraOnline && hasCameraStream(printer),
    cameraSrc: cameraOnline ? webrtcSource : null,
    light: status?.light ?? null,
    lightSupported: supportsPrinterLight(printer),
    snapshotAt: camera?.snapshotAt ?? null,
    ...(status?.error ? { error: status.error } : {})
  };
}
