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

// Variables consumed by scripts/deploy.sh, not by the service. They live in
// .env because that is the file the operator already edits per host, and the
// registry's .env.example correspondence test requires every documented
// variable to be declared somewhere — so they are declared here rather than
// left as a permanent test failure.
externalVar("COMPOSE_FILE", "compose", "docker compose (which compose files form the stack)");
externalVar("DEPLOY_MIN_FREE_MB", "deploy", "scripts/deploy.sh (pre-build free-space floor, both targets)");
externalVar("DEPLOY_MIN_FREE_MB_ORCA", "deploy", "scripts/deploy.sh (free-space floor, production-orca)");
externalVar("DEPLOY_MIN_FREE_MB_LEAN", "deploy", "scripts/deploy.sh (free-space floor, lean production)");
externalVar("DEPLOY_DISK_FLOOR_MB", "deploy", "scripts/deploy.sh (disk watchdog floor during a build)");
externalVar("DEPLOY_HEALTH_TIMEOUT", "deploy", "scripts/deploy.sh (seconds to wait for healthy)");
externalVar("DEPLOY_HTTP_TIMEOUT", "deploy", "scripts/deploy.sh (seconds to wait for HTTP verification)");
