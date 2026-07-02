// go2rtc can need several seconds to negotiate the Creality K2 WebRTC source
// and wait for the first keyframe when the bridge is cold.
export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_MAX_BYTES = 3_000_000;
