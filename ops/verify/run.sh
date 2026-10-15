#!/usr/bin/env bash
#
# End-to-end verification of a CANDIDATE orchestrator image, isolated from the
# farm — before it is deployed.
#
#   ops/verify/run.sh [image]          # default: atelier-print-orchestrator:verify
#
# Build the candidate under its own tag first (never :latest — see
# scripts/deploy.sh for what that tag means):
#
#   docker build --target production-orca -t atelier-print-orchestrator:verify apps/print-orchestrator
#
# What it stands up, all on an `--internal` docker network (no route to the LAN,
# so nothing here can reach a real printer — checked before anything starts):
#   - two simulated Creality K2 (fake-moonraker.mjs), the ground truth for which
#     commands physically reached a "printer";
#   - the candidate image with a FRESH data dir (empty queue.db, so every
#     migration runs), the shipped catalog, two simulated printers in its seed
#     config, and — when ORCA_HOST_DIR is set (it is, in this repo's .env) — the
#     real OrcaSlicer mounted exactly as compose.orca.yml mounts it;
#   - scenarios.mjs in a throwaway node container, phase by phase:
#       main     A, A2, E, B, D, C, F, K, G, then a long print in flight
#       (the orchestrator is SIGKILLed mid-print and started again)
#       restart  J
#       (the orchestrator is recreated with AUTO_QUEUE_ENABLED=true)
#       auto     H
#
# Leaves the report and every container's log in $VERIFY_WORK/out (printed at
# the end) and removes the containers and the network. Exit code: 0 when every
# scenario passed.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd -- "${HERE}/../.." && pwd -P)"
IMAGE="${1:-atelier-print-orchestrator:verify}"
NODE_IMAGE="${VERIFY_NODE_IMAGE:-node:22-alpine}"
TOKEN="verify-$(date +%s)-$RANDOM"
SUFFIX="$$"
NET="atelier-verify-${SUFFIX}"
WORK="${VERIFY_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/atelier-verify.XXXXXX")}"
OUT="${WORK}/out"

if [ -z "${ORCA_HOST_DIR:-}" ] && [ -f "${REPO}/.env" ]; then
  ORCA_HOST_DIR="$(sed -n 's/^ORCA_HOST_DIR=//p' "${REPO}/.env" | tail -1)"
fi

say() { printf '\n── %s\n' "$*"; }

cleanup() {
  for name in "verify-orch-${SUFFIX}" "verify-fake-k2a-${SUFFIX}" "verify-fake-k2b-${SUFFIX}"; do
    docker logs "$name" >"${OUT}/${name%-${SUFFIX}}.log" 2>&1 || true
    docker rm -f "$name" >/dev/null 2>&1 || true
  done
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "${WORK}/config" "${WORK}/data" "$OUT"
docker image inspect "$IMAGE" >/dev/null

say "isolated network ${NET}"
docker network create --internal "$NET" >/dev/null
[ "$(docker network inspect -f '{{.Internal}}' "$NET")" = "true" ] || { echo "network is not internal — refusing to continue" >&2; exit 2; }
if docker run --rm --network "$NET" "$NODE_IMAGE" node -e \
  "fetch('http://1.1.1.1',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(0),()=>process.exit(1))"; then
  echo "the verification network can reach the outside — refusing to continue" >&2
  exit 2
fi
echo "no route out of the network: confirmed"

say "two simulated Creality K2"
for p in k2a k2b; do
  docker run -d --name "verify-fake-${p}-${SUFFIX}" --network "$NET" --network-alias "fake-${p}" \
    -e SIM_NAME="$p" -e PRINT_SECONDS=20 -v "${HERE}:/sim:ro" "$NODE_IMAGE" node /sim/fake-moonraker.mjs >/dev/null
done

# The seed config: ONLY the simulated printers. (The image itself never carries
# the farm's printers.json — .dockerignore — and this mount replaces /app/config.)
cp -r "${REPO}/apps/print-orchestrator/config/slicers" "${WORK}/config/"
cat >"${WORK}/config/printers.json" <<'JSON'
[
  { "id": "k2a", "name": "K2 · A (sim)", "model": "Creality K2", "printerClass": "k2", "type": "FDM",
    "protocol": "moonraker", "host": "fake-k2a", "port": 7125, "material": "PETG", "nozzleDiameterMm": 0.4,
    "enabled": true, "apiKey": "", "serial": "", "accessCode": "", "light": { "enabled": false } },
  { "id": "k2b", "name": "K2 · B (sim)", "model": "Creality K2", "printerClass": "k2", "type": "FDM",
    "protocol": "moonraker", "host": "fake-k2b", "port": 7125, "material": "PETG", "nozzleDiameterMm": 0.4,
    "enabled": true, "apiKey": "", "serial": "", "accessCode": "", "light": { "enabled": false } }
]
JSON

run_orchestrator() {
  local auto_queue="$1"
  local orca=()
  if [ -n "${ORCA_HOST_DIR:-}" ] && [ -x "${ORCA_HOST_DIR}/AppRun" ]; then
    orca=(-v "${ORCA_HOST_DIR}:/opt/orca:ro" -e ORCA_SLICER_CMD=/opt/orca/AppRun -e ORCA_SLICER_VERSION=2.3.0)
  fi
  # The compose service name: the only DNS name the orchestrator's Host
  # allowlist (DNS-rebinding guard) admits without ALLOWED_HOSTS — as in production.
  docker run -d --name "verify-orch-${SUFFIX}" --network "$NET" --network-alias print-orchestrator \
    --stop-timeout 30 \
    -e NODE_ENV=production -e HOST=0.0.0.0 -e PORT=3100 -e LOG_LEVEL=info -e TZ=Europe/Kyiv \
    -e PRINTERS_CONFIG_PATH=/app/config/printers.json -e STATE_FILE_PATH=/app/data/state.json \
    -e PRINTER_POLL_INTERVAL_MS=2000 -e ORCHESTRATOR_API_TOKEN="$TOKEN" \
    -e AUTO_QUEUE_ENABLED="$auto_queue" -e AUTO_QUEUE_STARTUP_DELAY_MS=3000 -e AUTO_QUEUE_INTERVAL_MS=10000 \
    -v "${WORK}/config:/app/config:ro" -v "${WORK}/data:/app/data" "${orca[@]}" \
    "$IMAGE" >/dev/null
}

scenarios() {
  docker run --rm --network "$NET" --user "$(id -u):$(id -g)" \
    -e ORCH_URL=http://print-orchestrator:3100 -e ORCH_TOKEN="$TOKEN" -e OUT_DIR=/e2e/out \
    -v "${HERE}:/e2e/bin:ro" -v "${OUT}:/e2e/out" "$NODE_IMAGE" node /e2e/bin/scenarios.mjs "$1"
}

status=0
say "candidate ${IMAGE} (fresh data dir, automatic queue OFF)"
run_orchestrator false
scenarios main || status=1

say "SIGKILL mid-print, then start again"
docker kill --signal KILL "verify-orch-${SUFFIX}" >/dev/null
docker logs "verify-orch-${SUFFIX}" >"${OUT}/verify-orch-before-kill.log" 2>&1 || true
docker start "verify-orch-${SUFFIX}" >/dev/null
scenarios restart || status=1

say "recreated with AUTO_QUEUE_ENABLED=true (this isolated stage only)"
docker logs "verify-orch-${SUFFIX}" >"${OUT}/verify-orch-after-restart.log" 2>&1 || true
docker stop "verify-orch-${SUFFIX}" >/dev/null
docker rm "verify-orch-${SUFFIX}" >/dev/null
run_orchestrator true
scenarios auto || status=1

say "report: ${OUT}"
exit "$status"
