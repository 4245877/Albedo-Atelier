import type { PrinterView } from "../../domain/printers/types";
import { env } from "../../shared/env";
import { isWithinLocalTimeWindow } from "../../shared/time";
import { hasCameraSource, hasCameraStream, resolveWebrtcSource } from "../printers/camera";
import type { PrinterConfig } from "../printers/config";
import type { PrinterLiveStatus } from "../printers/status";
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
    camera: hasCameraSource(printer) ? camera?.state ?? "offline" : "none",
    cameraStream: hasCameraStream(printer),
    cameraSrc: resolveWebrtcSource(printer),
    light: status?.light ?? null,
    lightAllowed: isWithinLocalTimeWindow(env.nightWindow),
    snapshotAt: camera?.snapshotAt ?? null,
    ...(status?.error ? { error: status.error } : {})
  };
}
