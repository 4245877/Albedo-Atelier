import type { PrinterDiscoveryRecord } from "../domain/printers/discovery";
import {
  resolvePrinterSpecs,
  withLiveReading,
  type ResolvedPrinterSpecs
} from "../domain/printers/specs";
import type { PrinterView } from "../domain/printers/types";
import {
  canCaptureSnapshot,
  hasCameraSource,
  hasCameraStream,
  resolveWebrtcSource
} from "../infra/printers/camera";
import { printerReadiness } from "../infra/printers/capabilities";
import type { PrinterConfig } from "../infra/printers/config";
import { supportsPrinterFiles } from "../infra/printers/files";
import {
  supportsPrinterLight,
  supportsPrinterStart,
  type PrinterLiveStatus
} from "../infra/printers/status";
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
  camera: CameraEntry | undefined,
  latestSnapshotUrl: string | null = null,
  /**
   * The printer's resolved hardware specification. Optional so a caller that has
   * not wired discovery still gets the previous behaviour — the manual config as
   * the only fallback behind live telemetry.
   */
  specs: ResolvedPrinterSpecs = resolvePrinterSpecs(printer, null)
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

  // Every hardware characteristic is resolved by one shared rule
  // (`domain/printers/specs.ts`), then overlaid with this poll's live reading
  // where the device sent one — the freshest thing it said wins, but the
  // priority between device, operator and catalogue is decided in exactly one
  // place, so this view can never disagree with the hardware card.
  const observedAt = status?.updatedAt ?? null;
  const nozzleDiameterSpec = withLiveReading(
    specs.nozzleDiameterMm,
    status?.nozzleDiameterMm ?? null,
    "телеметрия принтера",
    observedAt
  );
  const nozzleTypeSpec = withLiveReading(
    specs.nozzleType,
    status?.nozzleType ?? null,
    "телеметрия принтера",
    observedAt
  );

  // Live filament is a different question from the loaded-material spec — "what
  // is feeding right now" — so it keeps its own telemetry-first resolution.
  const activeFilament = status?.activeFilament ?? null;
  const materialSpec = withLiveReading(
    specs.material,
    activeFilament?.material ?? null,
    "телеметрия принтера",
    observedAt
  );

  return {
    id: printer.id,
    name: printer.name,
    model: specs.model.value,
    modelSource: specs.model.source,
    firmware: specs.firmware.value,
    type: printer.type,
    status: viewStatus,
    online: status?.online ?? false,
    stateText: status?.stateText ?? null,
    stateMessage: status?.stateMessage ?? null,
    faults: status?.faults ?? [],
    mediaPresent: status?.mediaPresent ?? null,
    updatedAt: status?.updatedAt ?? null,
    job: status?.currentFile ?? null,
    progress: status?.progressPct ?? null,
    nozzle: status && status.nozzleTemp !== null ? [status.nozzleTemp, status.nozzleTarget] : null,
    bed: status && status.bedTemp !== null ? [status.bedTemp, status.bedTarget] : null,
    chamber: status?.chamberTemp ?? null,
    minutesLeft: status?.remainingMinutes ?? null,
    material: printer.material || null,
    swatch: printer.swatch || null,
    nozzleDiameter: nozzleDiameterSpec.value,
    nozzleDiameterSource: nozzleDiameterSpec.source,
    nozzleType: nozzleTypeSpec.value,
    nozzleTypeSource: nozzleTypeSpec.source,
    // Strictly what a DEVICE said is loaded — null when none did, so the
    // long-standing `liveMaterial ?? material` fallback in consumers keeps
    // meaning what it says. The source tag below still describes the resolution
    // as a whole, which is how the dashboard labels the material it displays.
    liveMaterial: materialSpec.source === "printer" ? materialSpec.value : null,
    liveMaterialColor: activeFilament?.color ?? null,
    liveMaterialSource: materialSpec.source,
    activeTray: activeFilament?.tray ?? null,
    buildVolume: specs.buildVolume.value,
    buildVolumeSource: specs.buildVolume.source,
    ams: specs.ams.value?.present ?? null,
    amsKind: specs.ams.value?.kind ?? null,
    camera: cameraState,
    cameraStream: cameraOnline && hasCameraStream(printer),
    cameraSrc: cameraOnline ? webrtcSource : null,
    light: status?.light ?? null,
    lightSupported: supportsPrinterLight(printer),
    snapshotAt: camera?.snapshotAt ?? null,
    snapshotAvailable: canCaptureSnapshot(printer),
    latestSnapshotUrl,
    filesSupported: supportsPrinterFiles(printer),
    remoteStartSupported: supportsPrinterStart(printer),
    // What this printer still needs CONFIGURED before its (implemented) adapter
    // can reach the device. Sent alongside the capabilities so the dashboard can
    // tell "this printer cannot do remote start" apart from "this printer needs
    // an access code" — the two used to arrive as one unactionable message.
    setupRequired: !printerReadiness(printer).ready,
    setupMissing: printerReadiness(printer).missing,
    interfaceUrl: printer.interfaceUrl || null,
    ...(status?.error ? { error: status.error } : {})
  };
}
