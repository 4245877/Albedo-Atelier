/**
 * Real camera access for the farm, split by concern:
 *   urls          — snapshot/stream URL resolving + capability predicates
 *   go2rtc        — WebRTC (Creality K2) liveness probe
 *   bambuCamera   — Bambu local TLS liveview frame grab
 *   snapshot      — HTTP still-image capture (with the Bambu fallback)
 *   stream        — live stream proxy
 *
 * Ported from apps/fulfillment (`modules/printers/snapshot.ts` + `bambuCamera.ts`).
 */
export type { CameraFrame, CameraStream } from "./types";
export {
  hasCameraSource,
  hasCameraStream,
  hasHttpCameraStream,
  isGo2RtcCamera,
  resolveGo2RtcApiBase,
  resolveSnapshotUrl,
  resolveStreamUrl,
  resolveWebrtcSource
} from "./urls";
export { probeGo2RtcStream } from "./go2rtc";
export { captureCameraFrame } from "./snapshot";
export { openCameraStream } from "./stream";
