import { externalVar } from "./registry";

/**
 * Environment variables consumed OUTSIDE `shared/env` — by compose, by the
 * printers-config `${VAR}` substitution, or by infra reading `process.env`
 * directly. Declared here so the registry (and its `.env.example`
 * correspondence test) stays the single complete inventory.
 */

// Printer configuration (infra/printers/config.ts reads process.env directly).
externalVar("PRINTERS_CONFIG_PATH", "printers", "infra/printers/config.ts");
externalVar("PRINTERS_CONFIG_JSON", "printers", "infra/printers/config.ts");
// `${VAR}` placeholders inside config/printers.json (substituted at load).
externalVar("BAMBU_A1_SERIAL", "printers", "config/printers.json placeholder");
externalVar("BAMBU_A1_ACCESS_CODE", "printers", "config/printers.json placeholder");
// Global opt-in read by the Bambu MQTT adapter (per-printer flag is in config).
externalVar("BAMBU_ALLOW_INSECURE_TLS", "printers", "infra/printers/status/bambu.ts");

// Deployment-level variables consumed by compose.yml / the container runtime.
externalVar("TZ", "compose", "compose.yml (container timezone)");
externalVar("DASHBOARD_BIND", "compose", "compose.yml (dashboard publish address)");
externalVar("K2_CAMERA_SOURCE", "compose", "compose.yml → go2rtc.yaml (K2 WebRTC source)");
externalVar("GO2RTC_WEBRTC_CANDIDATE", "compose", "compose.yml → go2rtc.yaml (LAN ICE candidate)");
externalVar("ORCA_HOST_DIR", "compose", "compose.orca.yml (host OrcaSlicer squashfs mount)");
