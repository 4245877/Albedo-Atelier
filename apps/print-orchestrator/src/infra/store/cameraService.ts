import { CameraError } from "../../core/errors";
import type { CameraState } from "../../domain/printers/types";
import { hhmm } from "../../shared/time";
import {
  captureCameraFrame,
  hasCameraSource,
  hasHttpCameraStream,
  isGo2RtcCamera,
  openCameraStream,
  probeGo2RtcStream,
  type CameraFrame,
  type CameraStream
} from "../printers/camera";
import type { PrinterConfig } from "../printers/config";

// A camera frame older than this is re-fetched on demand; between polls the
// cached frame doubles as the "is the camera reachable" probe result.
const CAMERA_PROBE_INTERVAL_MS = 30 * 1000;
const CAMERA_FRAME_FRESH_MS = 5 * 1000;

export interface CameraEntry {
  state: CameraState;
  snapshotAt: string | null;
  frame: CameraFrame | null;
  fetchedAt: number;
}

/**
 * Real camera frames + liveness, cached per printer. The poll loop calls
 * {@link probe}; the HTTP routes call {@link getFrame} / {@link getStream}.
 */
export class CameraService {
  private cameras = new Map<string, CameraEntry>();

  getEntry(id: string): CameraEntry | undefined {
    return this.cameras.get(id);
  }

  async probe(printer: PrinterConfig): Promise<void> {
    if (!hasCameraSource(printer)) {
      this.cameras.set(printer.id, {
        state: "none",
        snapshotAt: null,
        frame: null,
        fetchedAt: Date.now()
      });
      return;
    }

    const entry = this.cameras.get(printer.id);
    if (entry && Date.now() - entry.fetchedAt < CAMERA_PROBE_INTERVAL_MS) return;

    // go2rtc/WebRTC cameras (Creality K2): liveness comes from go2rtc's fast
    // /api/streams, never from pulling frame.jpeg — that request hangs because
    // the K2 only emits a keyframe to a live WebRTC client. The browser shows
    // the real picture over WebRTC; here we just keep the status honest and
    // leave any previously captured snapshot untouched.
    if (isGo2RtcCamera(printer)) {
      const online = await probeGo2RtcStream(printer);
      this.cameras.set(printer.id, {
        state: online ? "online" : "offline",
        snapshotAt: entry?.snapshotAt ?? null,
        frame: entry?.frame ?? null,
        fetchedAt: Date.now()
      });
      return;
    }

    const frame = await captureCameraFrame(printer);
    this.cameras.set(printer.id, {
      state: frame ? "online" : "offline",
      snapshotAt: frame ? hhmm() : entry?.snapshotAt ?? null,
      frame: frame ?? entry?.frame ?? null,
      fetchedAt: Date.now()
    });
  }

  /**
   * A real camera frame for `GET /api/printers/:id/camera.jpg`.
   *
   * `fresh` skips the short-lived frame cache and always pulls a new frame from
   * the device — used right after the light was switched on for a snapshot, so a
   * still-cached dark frame is never returned in place of the freshly lit one.
   */
  async getFrame(printer: PrinterConfig, options: { fresh?: boolean } = {}): Promise<CameraFrame> {
    const id = printer.id;
    if (!hasCameraSource(printer)) {
      throw new CameraError(id, "камера не настроена");
    }

    const entry = this.cameras.get(id);
    if (!options.fresh && entry?.frame && Date.now() - entry.fetchedAt < CAMERA_FRAME_FRESH_MS) {
      return entry.frame;
    }

    // go2rtc/WebRTC cameras have no usable still-image endpoint (frame.jpeg
    // hangs on the K2). The live picture is delivered to the browser over
    // WebRTC; a JPEG snapshot is simply not available, so report that honestly
    // instead of blocking the request for the full timeout.
    if (isGo2RtcCamera(printer)) {
      if (entry?.frame) return entry.frame;
      throw new CameraError(id, "снимок недоступен — камера транслируется по WebRTC");
    }

    const frame = await captureCameraFrame(printer);
    if (!frame) {
      this.cameras.set(id, {
        state: "offline",
        snapshotAt: entry?.snapshotAt ?? null,
        frame: entry?.frame ?? null,
        fetchedAt: Date.now()
      });
      throw new CameraError(id, "нет сигнала");
    }

    this.cameras.set(id, {
      state: "online",
      snapshotAt: hhmm(),
      frame,
      fetchedAt: Date.now()
    });
    return frame;
  }

  /** A live camera stream for `GET /api/printers/:id/camera.mp4`. */
  async getStream(printer: PrinterConfig): Promise<CameraStream> {
    if (isGo2RtcCamera(printer)) {
      throw new CameraError(printer.id, "трансляция доступна через WebRTC");
    }

    if (!hasHttpCameraStream(printer)) {
      throw new CameraError(printer.id, "трансляция не настроена");
    }

    const stream = await openCameraStream(printer);
    if (!stream) {
      throw new CameraError(printer.id, "нет видеопотока");
    }

    return stream;
  }
}
