#!/usr/bin/env bash
#
# Atelier — safe full redeploy of the compose stack.
#
# The rule this script exists to enforce: NEVER take the running farm down
# before the replacement images exist. The incident it was written after was
#
#   docker compose down          # farm offline
#   docker compose up -d --build # -> "no space left on device"
#                                # -> nothing to bring back up
#
# so the order here is preflight -> build -> up -> verify. A failed build (disk
# full, TypeScript error, apt hiccup) leaves the previous containers running and
# serving; only a successful build is allowed to swap them. `docker compose up
# -d` recreates just the services whose image or config actually changed, which
# is why `down` buys nothing even on the happy path.
#
# Data safety: the orchestrator's durable state (queue.db with the print queue,
# runs, slicing AND the printer inventory incl. device credentials; state.json;
# uploaded artifacts) lives on the named volume `orchestrator-data`. Nothing in
# this script — including `reclaim`/`--cleanup` — ever touches a Docker volume.
# `down -v`, `volume prune` and `system prune --volumes` are deliberately absent
# and must stay absent.
#
# Usage:
#   ./scripts/deploy.sh                 # preflight -> build -> up -> health -> HTTP
#   ./scripts/deploy.sh --cleanup       # ... then reclaim build cache (volumes untouched)
#   ./scripts/deploy.sh preflight       # checks only, changes nothing
#   ./scripts/deploy.sh reclaim         # free disk safely (untagged images; cache kept)
#   ./scripts/deploy.sh reclaim --cache # ALSO drop the build cache (next build is COLD)
#   ./scripts/deploy.sh rollback        # re-point compose at the last-known-good images
#   ./scripts/deploy.sh status          # what is running right now
#
# Git is deliberately NOT part of a deploy: `git pull` mid-deploy would make the
# built image depend on whatever the remote happened to hold, and a pull that
# rewrites files under an in-flight build is its own failure mode. Pull first,
# review, then deploy — the script records (and warns about) the commit and
# working-tree state it built from.

set -Eeuo pipefail

# ── Tunables ────────────────────────────────────────────────────────────────
# Free-space floor before a build is allowed to start. Derived from this repo's
# actual images, not a guess: the `production-orca` target adds a 564 MB apt
# layer (GTK/WebKit/GL) on top of a 1.16 GB image, and a cold build also holds
# the Alpine build stage, the dev-dependency tree and BuildKit's own copy of
# every produced layer — ~3.3 GB peak. The lean `production` target needs ~1.5 GB.
# Override for a known-incremental build: --min-free-mb N or DEPLOY_MIN_FREE_MB.
# Two independent budgets. A single DEPLOY_MIN_FREE_MB used to overwrite BOTH,
# silently erasing the distinction it exists to express; it is now the explicit
# "same number for either target" override, with per-target vars beside it.
MIN_FREE_MB_ORCA="${DEPLOY_MIN_FREE_MB_ORCA:-${DEPLOY_MIN_FREE_MB:-4096}}"
MIN_FREE_MB_LEAN="${DEPLOY_MIN_FREE_MB_LEAN:-${DEPLOY_MIN_FREE_MB:-2048}}"
# Hard floor the build watchdog enforces WHILE building. Preflight only proves
# the disk was fine a minute ago; this is what actually protects the running
# containers (their writable layers and logs share the filesystem) from a build
# that eats the last byte. Below this the build is cancelled, not the farm.
DISK_FLOOR_MB="${DEPLOY_DISK_FLOOR_MB:-512}"
# Inodes: a build that cannot create files fails just as hard as one out of bytes.
MIN_FREE_INODES="${DEPLOY_MIN_FREE_INODES:-100000}"
# The orchestrator healthcheck allows 60 s start_period + 5 x 10 s retries, and
# a cold Bambu MQTT/Moonraker first poll is the slow part.
HEALTH_TIMEOUT="${DEPLOY_HEALTH_TIMEOUT:-180}"
HTTP_TIMEOUT="${DEPLOY_HTTP_TIMEOUT:-60}"

# The services this stack must define. Guards against running the script from a
# directory that merely happens to contain a compose.yml.
EXPECTED_SERVICES=(go2rtc print-orchestrator print-dashboard)
# The dashboard is the published entry point; its container port is 8080 and the
# host port is whatever compose mapped (DASHBOARD_BIND:8090 by default). Read at
# runtime via `docker compose port` — never hardcoded.
HTTP_SERVICE="print-dashboard"
HTTP_CONTAINER_PORT=8080

# ── Paths ───────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
cd "$REPO_ROOT"

STATE_DIR="${REPO_ROOT}/.deploy"
LOCK_FILE="${STATE_DIR}/deploy.lock"
STATE_FILE="${STATE_DIR}/state.env"
BUILD_LOG="${STATE_DIR}/build.log"
# Set by the disk watchdog when it cancels a build, so the failure path can tell
# "cancelled to protect the disk" from "the code did not compile".
WATCHDOG_FLAG="${STATE_DIR}/watchdog.tripped"
DB_SNAPSHOT_DIR="${STATE_DIR}/db-snapshots"
# Distinct exit codes: 1 generic, 3 watchdog, 130 SIGINT, 143 SIGTERM.
EXIT_WATCHDOG=3

# ── Output ──────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

TOTAL_STAGES=6
STAGE_NO=0
CURRENT_STAGE="startup"
WARNINGS=0

stage()  { STAGE_NO=$((STAGE_NO + 1)); CURRENT_STAGE="$1"
           printf '\n%s[%d/%d] %s%s\n' "$C_BOLD$C_BLUE" "$STAGE_NO" "$TOTAL_STAGES" "$1" "$C_RESET"; }
info()   { printf '      %s\n' "$*"; }
detail() { printf '      %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok()     { printf '      %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()   { WARNINGS=$((WARNINGS + 1)); printf '      %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()    { printf '      %s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
die()    { printf '\n%s✗ Deployment failed: %s%s\n' "$C_RED$C_BOLD" "$*" "$C_RESET" >&2; exit 1; }

# ── Process lifecycle: temp files, the background build, and signals ────────
# Three traps share one teardown path, and it must run exactly once. ERR fires
# on an unhandled non-zero, INT/TERM on an operator Ctrl+C or a `kill`, and EXIT
# on every path including the ones the other two take. Without the guard the
# same cleanup would run two or three times and race with itself (double `wait`,
# killing a pgid that has already been reused).
CLEANUP_DONE=0
MAIN_SHELL_PID=$$
TEMP_FILES=()
BUILD_PID=""
WATCHDOG_PID=""

# Registering temp files centrally is what makes them survive `die` — the old
# code removed them only on the success path, so every failed deploy leaked one.
new_temp() {
  local t; t="$(mktemp "${TMPDIR:-/tmp}/atelier-deploy.XXXXXX")"
  TEMP_FILES+=("$t")
  printf '%s' "$t"
}
remove_temps() {
  local t
  for t in ${TEMP_FILES+"${TEMP_FILES[@]}"}; do [ -n "$t" ] && rm -f "$t"; done
  TEMP_FILES=()
}

# Kill the build's whole process group, not just the pipeline's head. The build
# runs in its own group (`set -m` below) precisely so this can reach `dc build`,
# BuildKit's client AND the `tee` without touching this script or the watchdog.
stop_build() {
  [ -n "$BUILD_PID" ] || return 0
  kill -0 "$BUILD_PID" 2>/dev/null || return 0
  kill -TERM -- "-${BUILD_PID}" 2>/dev/null || true
  # Give BuildKit a moment to cancel the job server-side, then insist.
  local waited=0
  while kill -0 "$BUILD_PID" 2>/dev/null && [ "$waited" -lt 10 ]; do
    sleep 1; waited=$((waited + 1))
  done
  if kill -0 "$BUILD_PID" 2>/dev/null; then
    kill -KILL -- "-${BUILD_PID}" 2>/dev/null || true
  fi
  wait "$BUILD_PID" 2>/dev/null || true
  BUILD_PID=""
}
stop_watchdog() {
  [ -n "$WATCHDOG_PID" ] || return 0
  kill "$WATCHDOG_PID" 2>/dev/null || true
  wait "$WATCHDOG_PID" 2>/dev/null || true
  WATCHDOG_PID=""
}

# Shared teardown. `signal` is empty for ERR/EXIT.
cleanup() {
  local exit_code=$1 signal="${2:-}"
  # Subshells inherit these traps under `set -E`; teardown belongs to the main
  # shell only, or a failing $(...) would tear down a deploy that is still fine.
  [ "$BASHPID" = "$MAIN_SHELL_PID" ] || return 0
  [ "$CLEANUP_DONE" -eq 0 ] || return 0
  CLEANUP_DONE=1

  if [ -n "$signal" ]; then
    printf '\n%s✗ Deployment interrupted by SIG%s during: %s%s\n' \
      "$C_RED$C_BOLD" "$signal" "$CURRENT_STAGE" "$C_RESET" >&2
    if [ -n "$BUILD_PID" ]; then
      printf '%s  stopping the in-flight build (process group %s)...%s\n' "$C_RED" "$BUILD_PID" "$C_RESET" >&2
    fi
  fi
  stop_watchdog
  stop_build
  remove_temps
  rm -f "${STATE_FILE}.tmp"
  if [ -n "$signal" ]; then
    printf '%s  Nothing was swapped; the running stack is untouched: docker compose ps%s\n' "$C_RED" "$C_RESET" >&2
  fi
  return "$exit_code"
}

on_err() {
  local exit_code=$? line=$1
  [ "$BASHPID" = "$MAIN_SHELL_PID" ] || return "$exit_code"
  if [ "$CLEANUP_DONE" -eq 0 ]; then
    printf '\n%s✗ Deployment failed during: %s%s (line %s, exit %s)\n' \
      "$C_RED$C_BOLD" "$CURRENT_STAGE" "$C_RESET$C_RED" "$line" "$exit_code" >&2
    printf '%s  The previous stack was left as-is; inspect it with: docker compose ps%s\n' "$C_RED" "$C_RESET" >&2
  fi
  cleanup "$exit_code" || true
  exit "$exit_code"
}

# 128+signo is the convention every shell and CI system already understands:
# Ctrl+C must be distinguishable from "the build failed to compile".
on_signal() {
  local signal="$1" code="$2"
  cleanup "$code" "$signal" || true
  exit "$code"
}

trap 'on_err $LINENO' ERR
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap 'cleanup $? || true' EXIT

usage() {
  sed -n '3,40p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//;s/^#$//'
  cat <<'USAGE'

Flags (deploy):
  --cleanup               reclaim build cache + dangling images after a successful deploy
  --min-free-mb N         override the pre-build free-space requirement
  --health-timeout N      seconds to wait for containers to become healthy (default 180)
  --allow-active-prints   proceed even though printers are mid-print (the orchestrator
                          restart loses in-memory run identity: no filament auto-deduction
                          and no duration metric for those runs)
  --rollback-on-failure   if the new stack fails verification, re-point compose at the
                          previous images and restart them (see the migration caveat below)
  --no-disk-watchdog      do not cancel the build when free space hits the floor
  --no-http-check         skip stage 6 (for hosts where the dashboard port is firewalled)

Flags (reclaim):
  --safe                  untagged images only, build cache kept (default)
  --cache                 also drop the build cache — the NEXT BUILD BECOMES COLD
  -y, --yes               non-interactive: same as --allow-active-prints
  -h, --help              this help
USAGE
}

# ── Small helpers ───────────────────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }
dc()   { docker compose "$@"; }

# Free space / inodes on the filesystem that holds Docker's data root — which is
# what a build actually fills. It is usually / but must not be assumed to be.
docker_root() { docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker; }
free_mb()     { df -P -k "$1" | awk 'NR==2 {print int($4/1024)}'; }
free_inodes() { df -P -i "$1" | awk 'NR==2 {print $4}'; }
used_pct()    { df -P -k "$1" | awk 'NR==2 {gsub(/%/,"",$5); print $5}'; }

compose_project() {
  if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then printf '%s' "$COMPOSE_PROJECT_NAME"; return; fi
  if have jq; then dc config --format json 2>/dev/null | jq -r '.name'; return; fi
  basename "$REPO_ROOT" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-'
}

# Services compose will build (as opposed to pull). Only these can be rolled back
# to a locally tagged predecessor.
buildable_services() {
  if have jq; then
    dc config --format json | jq -r '.services | to_entries[] | select(.value.build) | .key'
  else
    dc config | awk '/^  [a-z]/ {svc=$1} /^    build:/ {print svc}' | tr -d ':'
  fi
}

# The image tag compose builds into: an explicit `image:` if the service declares
# one, else compose's default <project>-<service>.
service_image_name() {
  local svc="$1" img=""
  if have jq; then
    img="$(dc config --format json | jq -r --arg s "$svc" '.services[$s].image // empty')"
  fi
  if [ -n "$img" ]; then printf '%s' "$img"; return; fi
  printf '%s-%s' "$(compose_project)" "$svc"
}

container_id() { dc ps -q "$1" 2>/dev/null || true; }

image_id()  { docker image inspect "$1" --format '{{.Id}}' 2>/dev/null || true; }
# The image's actual content: the ordered rootfs layer digests. Unlike the image
# id this is stable across rebuilds that changed nothing. Takes an image
# REFERENCE (name:tag) — a container's .Image digest is not resolvable here.
rootfs_of() {
  if [ -z "$1" ]; then return 0; fi
  docker image inspect "$1" --format '{{.RootFS.Layers}}' 2>/dev/null || true
}

# "status health restarts" for a container, or "absent none 0".
container_state() {
  local cid="$1"
  if [ -z "$cid" ]; then printf 'absent none 0'; return; fi
  docker inspect "$cid" --format \
    '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' \
    2>/dev/null || printf 'absent none 0'
}

# Always exactly three digits. `curl -w '%{http_code}'` ALREADY prints 000 when
# it cannot connect, so the old `|| echo 000` appended a second one and produced
# "000000" in every connection-refused message.
http_code() {
  local url="$1" body_file="$2" out=""
  if have curl; then
    out="$(curl -sS -m 5 -o "$body_file" -w '%{http_code}' "$url" 2>/dev/null || true)"
  else
    if wget -q -T 5 -O "$body_file" "$url" 2>/dev/null; then out=200; fi
  fi
  case "$out" in
    [0-9][0-9][0-9]) printf '%s' "$out" ;;
    *)               printf '000' ;;
  esac
}

# ── Stage 1: preflight ──────────────────────────────────────────────────────
ORCA_BUILD=0
MIN_FREE_MB=0
DOCKER_FS=""
ACTIVE_PRINTS=0

preflight() {
  stage "Preflight checks"

  # -- toolchain ------------------------------------------------------------
  have docker || die "docker is not installed or not on PATH"
  docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon (is it running? is this user in the 'docker' group?)"
  dc version >/dev/null 2>&1 || die "'docker compose' (v2 plugin) is unavailable — the legacy docker-compose binary is not supported"
  ok "docker $(docker --version | awk '{gsub(/,/,"",$3); print $3}') · compose $(dc version --short)"

  # -- right project --------------------------------------------------------
  [ -f "${REPO_ROOT}/compose.yml" ] || die "no compose.yml in ${REPO_ROOT} — run this script from the Atelier checkout"
  [ -f "${REPO_ROOT}/apps/print-orchestrator/Dockerfile" ] || die "${REPO_ROOT} does not look like Atelier (apps/print-orchestrator missing)"
  local services svc
  services="$(dc config --services 2>/dev/null | sort | tr '\n' ' ')"
  for svc in "${EXPECTED_SERVICES[@]}"; do
    case " $services " in *" $svc "*) ;; *) die "compose stack has no '$svc' service — wrong project or wrong COMPOSE_FILE (resolved: $services)";; esac
  done
  ok "project '$(compose_project)' at ${REPO_ROOT} · services: ${services% }"

  # -- .env and a fully resolvable config -----------------------------------
  # compose.yml/compose.orca.yml use ${VAR:?...} for the deployment-specific
  # values, so `config -q` is the real check: it fails with the authored message
  # when .env is missing a required variable.
  [ -f "${REPO_ROOT}/.env" ] || die ".env is missing — copy .env.example to .env and fill in the deployment values"
  if ! dc config -q 2>"${STATE_DIR}/config.err"; then
    err "compose config is not resolvable:"
    sed 's/^/        /' "${STATE_DIR}/config.err" >&2
    die "invalid compose configuration (usually a variable missing from .env)"
  fi
  ok ".env present and the compose config resolves"

  # Which image variant are we building? It decides the disk budget.
  # Read from the EFFECTIVE, fully-merged config — the only thing that reflects
  # what will actually be built — not from the presence of a variable.
  local effective_config; effective_config="$(dc config 2>/dev/null || true)"
  if printf '%s' "$effective_config" | grep -q 'target: production-orca'; then
    ORCA_BUILD=1; MIN_FREE_MB="$MIN_FREE_MB_ORCA"
    ok "build target: production-orca (OrcaSlicer runtime; the heavy variant)"
  else
    ORCA_BUILD=0; MIN_FREE_MB="$MIN_FREE_MB_LEAN"
    info "build target: production (lean image, no OrcaSlicer system libraries)"
  fi

  # AT-016: a host that forgets COMPOSE_FILE silently builds a DIFFERENT SYSTEM
  # and still reports "deployed successfully" — every container healthy, every
  # HTTP check green, and slicing dead, discoverable only when someone tries to
  # slice. Two facts make that a provable contradiction rather than a matter of
  # taste, so it is a hard failure, not a warning.
  local orca_cmd=""
  orca_cmd="$(printf '%s' "$effective_config" | awk -F': *' '/ORCA_SLICER_CMD:/ {print $2; exit}' | tr -d '"')"
  if [ "$ORCA_BUILD" -eq 0 ] && [ -n "$orca_cmd" ]; then
    err "configuration contradiction: ORCA_SLICER_CMD is set (${orca_cmd}) but the effective compose config builds the LEAN target"
    cat >&2 <<'EOF'

      The orchestrator would be told to run OrcaSlicer at a path that this image
      does not contain and that compose does not mount. Slicing would fail at
      runtime while the deploy reported complete success.

      Add this to .env (see .env.example):
        COMPOSE_FILE=compose.yml:compose.orca.yml

      Or, if this host is deliberately lean, unset ORCA_SLICER_CMD.
EOF
    die "COMPOSE_FILE does not include compose.orca.yml but ORCA_SLICER_CMD is configured"
  fi
  if [ "$ORCA_BUILD" -eq 1 ]; then
    # Prove the runtime is actually mounted, not merely requested.
    if printf '%s' "$effective_config" | grep -q '/opt/orca'; then
      ok "OrcaSlicer runtime mount present in the effective config"
    else
      die "target is production-orca but no /opt/orca mount resolved — check ORCA_HOST_DIR and compose.orca.yml"
    fi
  fi
  # COMPOSE_FILE usually lives in .env, which compose reads itself and the shell
  # does not — so reporting only the shell variable would claim "unset" on a host
  # where it is very much set.
  local compose_file_setting="${COMPOSE_FILE:-}"
  if [ -z "$compose_file_setting" ] && [ -f "${REPO_ROOT}/.env" ]; then
    compose_file_setting="$(awk -F= '/^COMPOSE_FILE=/{sub(/^COMPOSE_FILE=/,""); print; exit}' "${REPO_ROOT}/.env")"
    [ -n "$compose_file_setting" ] && compose_file_setting="${compose_file_setting} (from .env)"
  fi
  detail "COMPOSE_FILE=${compose_file_setting:-<unset — compose defaults apply>}"
  if [ -n "${MIN_FREE_MB_OVERRIDE:-}" ]; then MIN_FREE_MB="$MIN_FREE_MB_OVERRIDE"; fi

  # -- the shared external network ------------------------------------------
  # compose declares print-farm as external; without it `up` fails outright.
  # The repo's own helper is idempotent, so just run it.
  if docker network inspect print-farm >/dev/null 2>&1; then
    ok "shared network 'print-farm' exists"
  else
    "${REPO_ROOT}/ops/ensure-print-farm-network.sh" >/dev/null
    ok "shared network 'print-farm' created (ops/ensure-print-farm-network.sh)"
  fi

  # -- disk ------------------------------------------------------------------
  DOCKER_FS="$(docker_root)"
  [ -d "$DOCKER_FS" ] || DOCKER_FS="/"
  local mb inodes pct
  mb="$(free_mb "$DOCKER_FS")"; inodes="$(free_inodes "$DOCKER_FS")"; pct="$(used_pct "$DOCKER_FS")"
  info "disk (${DOCKER_FS}): ${mb} MB free, ${pct}% used, ${inodes} inodes free"
  detail "$(df -h "$DOCKER_FS" | tail -1)"

  if [ "$mb" -lt "$MIN_FREE_MB" ]; then
    err "not enough free space to build: ${mb} MB free, ${MIN_FREE_MB} MB required"
    printf '\n'
    df -h "$DOCKER_FS" | sed 's/^/        /' >&2
    printf '\n' >&2
    docker system df | sed 's/^/        /' >&2
    cat >&2 <<EOF

      Nothing was built and nothing was stopped — the running stack is untouched.

      Safe ways to reclaim space, BEST FIRST (none of them touch a Docker
      volume, so queue.db and the rest of orchestrator-data are never at risk):

        du -sh ~/.vscode-server/cli/servers/* ~/.vscode-server/bin/*
                                        # stale VS Code server versions are
                                        # usually the single biggest win here;
                                        # delete every one that is not running
        ./scripts/deploy.sh reclaim     # untagged images, KEEPS the build cache
        journalctl --vacuum-size=100M   # if journald has grown
        docker logs --tail 0 …          # (container logs live under ${DOCKER_FS}/containers)

      LAST RESORT — this makes the next build COLD and therefore need MORE
      space (~${MIN_FREE_MB_ORCA} MB), not less:
        ./scripts/deploy.sh reclaim --cache

      NEVER run these here — they delete the volume holding queue.db whenever
      the containers happen to be stopped:
        docker system prune -a --volumes
        docker volume prune
        docker compose down -v

      If you know this build is incremental (only src/ changed, cache warm),
      re-run with an explicit budget:  ./scripts/deploy.sh --min-free-mb ${mb}
EOF
    exit 1
  fi
  ok "free space ${mb} MB ≥ required ${MIN_FREE_MB} MB"

  if [ "$inodes" -lt "$MIN_FREE_INODES" ]; then
    die "only ${inodes} free inodes on ${DOCKER_FS} (need ${MIN_FREE_INODES}) — a build creates many small files"
  fi
  ok "free inodes ${inodes} ≥ required ${MIN_FREE_INODES}"

  # -- current stack ---------------------------------------------------------
  info "current stack:"
  dc ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | sed 's/^/        /' || true
  info "docker disk usage:"
  docker system df | sed 's/^/        /'

  # -- the persistent volume must exist and must not be about to be recreated -
  local vol; vol="$(compose_project)_orchestrator-data"
  if docker volume inspect "$vol" >/dev/null 2>&1; then
    ok "persistent volume '${vol}' present (queue.db, state.json, artifacts)"
  else
    warn "persistent volume '${vol}' does not exist yet — it will be created empty on first start"
  fi

  # -- source revision -------------------------------------------------------
  if git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    local commit dirty
    commit="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
    dirty="$(git -C "$REPO_ROOT" status --porcelain | wc -l | tr -d ' ')"
    if [ "$dirty" -gt 0 ]; then
      warn "building from ${commit} with ${dirty} uncommitted change(s) — the deployed image will not match any commit"
    else
      ok "building from commit ${commit} (clean tree)"
    fi
  fi

  # -- security posture (README / SECURITY.md invariants) --------------------
  local bind token
  bind="$(dc config 2>/dev/null | awk '/published:/ {print $2}' | tr -d '"' | tr '\n' ' ')"
  detail "published ports: ${bind}"
  token="$(dc config --format json 2>/dev/null | { have jq && jq -r '.services["print-dashboard"].environment.ORCHESTRATOR_API_TOKEN // ""' || echo "?"; })"
  if [ -z "$token" ]; then
    warn "ORCHESTRATOR_API_TOKEN is empty — state-changing API calls are refused (503) unless ALLOW_UNAUTHENTICATED_MUTATIONS=1; see SECURITY.md"
  fi

  # -- prints in flight ------------------------------------------------------
  # Recreating the orchestrator keeps the queue and the event feed (volume), but
  # in-memory run identity is lost: prints that finish after the swap skip
  # filament auto-deduction and the duration metric. Worth a deliberate decision.
  # Reported here for the operator, but NOT used as the gate: by the time the
  # swap happens a production-orca build may have been running for minutes, and
  # a night-scheduled print can start inside that window. The binding check is
  # re-taken immediately before `up -d` (stage 4).
  ACTIVE_PRINTS="$(count_active_prints)"
  case "$ACTIVE_PRINTS" in
    unknown) warn "could not determine how many prints are in flight (re-checked before the swap)" ;;
    0)       ok "no prints in flight (re-checked before the swap)" ;;
    *)       warn "${ACTIVE_PRINTS} printer(s) are mid-print right now (re-checked before the swap)" ;;
  esac
}

# How many prints are in flight RIGHT NOW.
#
# Echoes a non-negative integer, or the literal string "unknown" when the state
# could not be determined. "unknown" is not 0: the old code collapsed every
# failure (stack down, HTTP 500, malformed JSON, no curl) into 0 and called it
# an "advisory gate", which meant the one protection against recreating the
# orchestrator mid-print failed OPEN exactly when the farm was least healthy.
#
# Two independent sources, both consulted:
#   * live telemetry  — a printer physically printing, even with no queue entry;
#   * canonical PrintRun rows in SQLite — RUNNING/PAUSED survive a printer going
#     offline, which live telemetry does not.
# The higher of the two wins.
count_active_prints() {
  local live="unknown" runs="unknown"
  live="$(count_active_prints_live)"
  runs="$(count_active_runs_db)"

  # Neither source could answer -> fail closed.
  if [ "$live" = "unknown" ] && [ "$runs" = "unknown" ]; then echo "unknown"; return; fi
  [ "$live" = "unknown" ] && live=0
  [ "$runs" = "unknown" ] && runs=0
  if [ "$runs" -gt "$live" ]; then echo "$runs"; else echo "$live"; fi
}

# Live printer telemetry, asked of the orchestrator DIRECTLY over the compose
# network. The old path went through the dashboard's nginx, so an unhealthy
# dashboard — or a published-port change — silently answered "no prints".
count_active_prints_live() {
  local cid out
  cid="$(container_id print-orchestrator)"
  if [ -n "$cid" ]; then
    out="$(docker exec -i "$cid" node -e '
      fetch("http://127.0.0.1:3100/api/printers")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
        .then((d) => {
          const list = Array.isArray(d) ? d : d.printers;
          if (!Array.isArray(list)) throw new Error("unexpected payload shape");
          const busy = list.filter((p) => p && (p.status === "printing" || p.status === "paused"));
          process.stdout.write("ACTIVE=" + busy.length);
        })
        .catch((e) => { process.stdout.write("ERROR=" + e.message); });
    ' 2>/dev/null || true)"
    case "$out" in
      ACTIVE=*) printf '%s' "${out#ACTIVE=}"; return ;;
    esac
  fi

  # Fallback: the published dashboard proxy. Parsed with a real JSON reader when
  # jq is available rather than by counting substring occurrences.
  local port url body code n
  port="$(dc port "$HTTP_SERVICE" "$HTTP_CONTAINER_PORT" 2>/dev/null | awk -F: 'NF{print $NF}')" || true
  [ -n "${port:-}" ] || { echo unknown; return; }
  url="http://127.0.0.1:${port}/api/print-orchestrator/api/printers"
  body="$(new_temp)"
  code="$(http_code "$url" "$body")"
  if [ "$code" != "200" ]; then rm -f "$body"; echo unknown; return; fi
  if have jq; then
    n="$(jq -r '[(if type=="array" then .[] else .printers[] end) | select(.status=="printing" or .status=="paused")] | length' <"$body" 2>/dev/null || echo unknown)"
  else
    n="$(grep -o '"status":"\(printing\|paused\)"' "$body" | wc -l | tr -d ' ')"
  fi
  rm -f "$body"
  case "$n" in
    ''|*[!0-9]*) echo unknown ;;
    *)           echo "$n" ;;
  esac
}

# Canonical runs. A print whose printer dropped off the network is still a print
# in flight, and only the database knows that.
count_active_runs_db() {
  local cid out
  cid="$(container_id print-orchestrator)"
  [ -n "$cid" ] || { echo unknown; return; }
  out="$(docker exec -i "$cid" node --experimental-sqlite -e '
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync("/app/data/queue.db", { readOnly: true });
      const row = db.prepare("SELECT COUNT(*) n FROM print_runs WHERE state IN (?, ?)").get("RUNNING", "PAUSED");
      process.stdout.write("RUNS=" + row.n);
    } catch (e) { process.stdout.write("ERROR=" + e.message); }
  ' 2>/dev/null || true)"
  case "$out" in
    RUNS=*) printf '%s' "${out#RUNS=}" ;;
    *)      echo unknown ;;
  esac
}

# The gate itself, so deploy and rollback enforce IDENTICAL rules.
# $1 = what is about to happen, for the message.
enforce_active_print_gate() {
  local what="$1" active
  active="$(count_active_prints)"
  if [ "$active" = "unknown" ]; then
    if [ "$ALLOW_ACTIVE_PRINTS" -eq 1 ]; then
      warn "could not determine whether prints are in flight — proceeding on --allow-active-prints"
      return 0
    fi
    err "could not determine whether any prints are in flight"
    cat >&2 <<'EOF'

      The orchestrator did not answer on either the direct API or the dashboard
      proxy, so this is NOT the same as "no prints are running". Recreating the
      orchestrator mid-print loses run identity: filament auto-deduction and the
      duration metric are skipped for those runs.

      Check the farm, then re-run. To override deliberately:
        ./scripts/deploy.sh --allow-active-prints
EOF
    die "active-print state unknown (use --allow-active-prints to override)"
  fi
  if [ "$active" -gt 0 ] && [ "$ALLOW_ACTIVE_PRINTS" -eq 0 ]; then
    err "${active} print(s) in flight and ${what}"
    cat >&2 <<'EOF'

      Recreating the orchestrator keeps the queue, event feed and today's
      counters (they live on the orchestrator-data volume), but in-memory print
      RUN IDENTITY is lost: prints that finish after the swap skip filament
      auto-deduction in the fulfillment warehouse and the average-duration
      metric. The prints themselves keep printing — the printers are not touched.

      The images are already built, so re-running later costs nothing:
        ./scripts/deploy.sh                        # once the prints have finished
        ./scripts/deploy.sh --allow-active-prints  # accept the loss and swap now
EOF
    die "prints in flight (use --allow-active-prints to override)"
  fi
  if [ "$active" -eq 0 ]; then
    ok "no prints in flight"
  else
    warn "${active} print(s) in flight — proceeding on --allow-active-prints"
  fi
  return 0
}

# ── Stage 2: record the running images + pre-deploy DB snapshot ─────────────
# THREE distinct things, previously conflated into one mutable `:previous` tag:
#
#   candidate         — what this build produces (:latest after stage 3)
#   currently-running — what the containers are on right now (recorded here)
#   last-known-good   — the newest image that actually PASSED health + HTTP
#                       verification (tagged :last-known-good, and only ever
#                       moved at the very end of a successful deploy)
#
# The old code moved `:previous` to `:latest` BEFORE every build, unconditionally.
# That made it "whatever was tagged last time", not "a version known to work":
# a second deploy after a failed one promoted the FAILED image to the rollback
# target, and a no-op deploy destroyed the only real target. `:previous` is still
# written, as an alias for the running image, so existing muscle memory and docs
# keep working — but rollback now follows :last-known-good.
declare -A RUNNING_IMAGE_ID=()

snapshot_images() {
  stage "Recording running images + pre-deploy database snapshot"
  mkdir -p "$STATE_DIR"

  local svc img_id img_name recorded=0
  while read -r svc; do
    [ -n "$svc" ] || continue
    img_name="$(service_image_name "$svc")"
    img_id="$(image_id "${img_name}:latest")"
    if [ -z "$img_id" ]; then
      detail "${svc}: no ${img_name}:latest yet — first deploy"
      continue
    fi
    RUNNING_IMAGE_ID["$svc"]="$img_id"
    # :previous == "what was running before this deploy". Kept for continuity,
    # but it is NOT what rollback uses.
    docker tag "${img_name}:latest" "${img_name}:previous"
    detail "${svc}: running ${img_id:7:12} (tagged ${img_name}:previous)"
    recorded=$((recorded + 1))
  done < <(buildable_services)

  [ "$recorded" -gt 0 ] || warn "nothing was running — this is a first deploy"

  # Bootstrap: a host that has never completed a verified deploy under the new
  # scheme has no :last-known-good. The stack that is running and healthy right
  # now is the best evidence available, so adopt it once, explicitly.
  if [ "$recorded" -gt 0 ] && [ -z "$(lkg_image_id print-orchestrator)" ]; then
    if stack_is_healthy; then
      adopt_last_known_good "the currently running, healthy stack"
    else
      warn "no last-known-good recorded and the running stack is not healthy — rollback will be unavailable until a deploy verifies"
    fi
  fi

  snapshot_database
}

# Is every service that has a healthcheck currently healthy?
stack_is_healthy() {
  local svc state status health
  while read -r svc; do
    [ -n "$svc" ] || continue
    state="$(container_state "$(container_id "$svc")")"
    status="$(awk '{print $1}' <<<"$state")"; health="$(awk '{print $2}' <<<"$state")"
    [ "$status" = "running" ] || return 1
    if [ "$health" != "none" ] && [ "$health" != "healthy" ]; then return 1; fi
  done < <(dc config --services)
  return 0
}

lkg_image_id() {
  [ -f "$STATE_FILE" ] || return 0
  awk -F= -v k="LKG_IMAGE_ID_$(printf '%s' "$1" | tr '-' '_')" '$1==k{print $2}' "$STATE_FILE"
}

# Move last-known-good to whatever :latest currently resolves to. Called ONLY
# after full verification (or once at bootstrap for an already-healthy stack).
adopt_last_known_good() {
  local why="$1" svc img_name img_id tmp
  tmp="${STATE_FILE}.tmp"
  {
    printf '# written by scripts/deploy.sh — the LAST KNOWN GOOD state a rollback returns to\n'
    printf 'LKG_AT=%s\n' "$(date -Iseconds)"
    printf 'LKG_REASON=%s\n' "$why"
    if git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
      # The commit of the image being blessed — NOT, as the old
      # SNAPSHOT_GIT_COMMIT did, the commit being deployed over it.
      printf 'LKG_GIT_COMMIT=%s\n' "$(git -C "$REPO_ROOT" rev-parse HEAD)"
      printf 'DEPLOYED_GIT_COMMIT=%s\n' "$(git -C "$REPO_ROOT" rev-parse HEAD)"
    fi
  } >"$tmp"

  while read -r svc; do
    [ -n "$svc" ] || continue
    img_name="$(service_image_name "$svc")"
    img_id="$(image_id "${img_name}:latest")"
    [ -n "$img_id" ] || continue
    docker tag "${img_name}:latest" "${img_name}:last-known-good"
    {
      printf 'LKG_IMAGE_%s=%s\n'    "$(printf '%s' "$svc" | tr '-' '_')" "${img_name}:last-known-good"
      printf 'LKG_IMAGE_ID_%s=%s\n' "$(printf '%s' "$svc" | tr '-' '_')" "$img_id"
      printf 'PREV_IMAGE_%s=%s\n'    "$(printf '%s' "$svc" | tr '-' '_')" "${img_name}:last-known-good"
      printf 'PREV_IMAGE_ID_%s=%s\n' "$(printf '%s' "$svc" | tr '-' '_')" "$img_id"
    } >>"$tmp"
    ok "${svc}: last-known-good ← ${img_id:7:12}"
  done < <(buildable_services)

  mv "$tmp" "$STATE_FILE"
  detail "last-known-good updated (${why})"
}

# ── AT-013(2): cheap pre-deploy database snapshot ───────────────────────────
# Not a substitute for ops/backup (which is scheduled, verified and retained) —
# this is the "undo" that belongs to THIS deploy, taken seconds before the swap,
# and it is what makes a forward-only migration survivable.
snapshot_database() {
  mkdir -p "$DB_SNAPSHOT_DIR"
  local cid stamp target
  cid="$(container_id print-orchestrator)"
  if [ -z "$cid" ]; then
    detail "orchestrator not running — no pre-deploy database snapshot"
    return 0
  fi
  stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  target="${DB_SNAPSHOT_DIR}/queue-${stamp}.db"
  # Fed on stdin rather than with -e: the SQL needs single quotes around the
  # destination path, which cannot survive a single-quoted shell argument.
  if docker exec -i "$cid" node --experimental-sqlite - >/dev/null 2>&1 <<'NODE' && docker cp "${cid}:/tmp/predeploy.db" "$target" >/dev/null 2>&1; then
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
fs.rmSync("/tmp/predeploy.db", { force: true });
const db = new DatabaseSync("/app/data/queue.db", { readOnly: true });
db.exec("VACUUM INTO '/tmp/predeploy.db'");
db.close();
NODE
    docker exec "$cid" rm -f /tmp/predeploy.db 2>/dev/null || true
    chmod 0600 "$target"
    ok "pre-deploy database snapshot: ${target} ($(du -h "$target" | cut -f1))"
    # Keep the last 10; they are ~850 KB each and live outside /tmp on purpose.
    local old
    while read -r old; do [ -n "$old" ] && rm -f "$old"; done < <(
      find "$DB_SNAPSHOT_DIR" -maxdepth 1 -name 'queue-*.db' -type f | sort -r | tail -n +11)
  else
    warn "could not take a pre-deploy database snapshot (continuing; scheduled backups are unaffected)"
  fi
}

# ── Stage 3: build ──────────────────────────────────────────────────────────
# The whole point of the script: this runs BEFORE anything is stopped, and a
# failure here exits with the old containers still serving traffic.
build_images() {
  stage "Building images"
  if [ "$ORCA_BUILD" -eq 1 ]; then
    info "target production-orca — the heavy variant (GTK/WebKit/GL layer); a cold build takes minutes and ~3 GB"
  else
    info "target production — the lean image"
  fi
  info "this does not touch the running containers — they keep serving until stage 4"
  mkdir -p "$STATE_DIR"

  # Build identity for the OCI labels and GET /version. BUILD_TIME is the
  # COMMIT's timestamp, not "now", on purpose: a wall-clock value would differ on
  # every run, so rebuilding an unchanged commit would produce a different image
  # and defeat the no-op deploy path that keeps the orchestrator from being
  # recreated mid-print. Per-commit values keep an unchanged rebuild identical.
  if git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    GIT_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    BUILD_TIME="$(git -C "$REPO_ROOT" show -s --format=%cI HEAD)"
    if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then GIT_DIRTY=1; else GIT_DIRTY=0; fi
  else
    GIT_COMMIT=""; BUILD_TIME=""; GIT_DIRTY=0
  fi
  export GIT_COMMIT BUILD_TIME GIT_DIRTY
  detail "build identity: ${GIT_COMMIT:0:12} (dirty=${GIT_DIRTY}) @ ${BUILD_TIME:-unknown}"

  # Pull the non-buildable images now (go2rtc, pinned by digest) so stage 4 is a
  # purely local operation: a registry outage must not strand the swap half-way.
  if dc pull --quiet --ignore-buildable 2>/dev/null; then
    ok "remote images present locally"
  else
    warn "could not pre-pull remote images — 'up' will try again (already-present images are unaffected)"
  fi

  local rc=0
  rm -f "$WATCHDOG_FLAG"
  # Run the build in its own process group so the watchdog can cancel the whole
  # pipeline (compose + tee) without touching this script.
  # --provenance=false: BuildKit's default provenance attestation makes the
  # exported image a manifest LIST whose digest embeds build metadata, so a
  # fully-cached rebuild still yields a NEW image id. Compose compares that id,
  # so every deploy would recreate every built container even when not one layer
  # changed — needlessly restarting the orchestrator and losing the in-memory
  # run identity of prints already in flight. With it off, an unchanged rebuild
  # is a true no-op and `up -d` leaves the containers alone. (The equivalent
  # `build.provenance` key in compose.yml is silently ignored by compose v5 —
  # verified — so it has to be the flag here.)
  #
  # `9>&-` closes the deploy lock in the child. An `exec 9>` fd has no
  # close-on-exec flag, so without this the background build INHERITS the flock;
  # if the parent then dies (Ctrl+C, crash) the orphaned build keeps the lock
  # held and every later deploy is refused with "another deploy is already
  # running" pointing at a script that no longer exists.
  set -m
  ( set -o pipefail; dc build --provenance=false 2>&1 | tee "$BUILD_LOG" ) 9>&- &
  BUILD_PID=$!
  set +m

  if [ "${DISK_WATCHDOG:-1}" = "1" ]; then
    ( trap 'exit 0' TERM
      # `9>&-` here too: the watchdog must not pin the lock either.
      while kill -0 "$BUILD_PID" 2>/dev/null; do
        sleep 5
        # Re-check AFTER the sleep. The build very often finishes DURING these
        # five seconds; without this second check a low-disk reading taken after
        # a successful build would print a scary "cancelling the build" line,
        # signal an already-dead process group (whose pgid may by then belong to
        # someone else) and leave the operator chasing a cancellation that never
        # happened.
        kill -0 "$BUILD_PID" 2>/dev/null || exit 0
        local_free="$(free_mb "$DOCKER_FS")"
        if [ "${local_free:-999999}" -lt "$DISK_FLOOR_MB" ]; then
          printf '\n      %s!%s disk watchdog: only %s MB left on %s — cancelling the build to protect the running containers\n' \
            "$C_YELLOW" "$C_RESET" "$local_free" "$DOCKER_FS" >&2
          # Record WHY the build is about to die. The exit status alone cannot
          # distinguish "cancelled to save the disk" from "TypeScript error",
          # and the two need very different operator responses.
          printf 'free_mb=%s floor_mb=%s at=%s\n' "$local_free" "$DISK_FLOOR_MB" "$(date -Iseconds)" >"$WATCHDOG_FLAG"
          kill -TERM -- "-${BUILD_PID}" 2>/dev/null || true
          exit 0
        fi
      done ) 9>&- &
    WATCHDOG_PID=$!
    detail "disk watchdog armed: build is cancelled if free space on ${DOCKER_FS} drops below ${DISK_FLOOR_MB} MB"
  fi

  wait "$BUILD_PID" || rc=$?
  BUILD_PID=""
  stop_watchdog

  if [ "$rc" -ne 0 ]; then
    if [ -f "$WATCHDOG_FLAG" ]; then
      err "build CANCELLED BY THE DISK WATCHDOG — this is not a code failure"
      detail "$(cat "$WATCHDOG_FLAG")"
      printf '\n' >&2
      info "the previous stack was never stopped — it is still running:"
      dc ps --format 'table {{.Service}}\t{{.Status}}' | sed 's/^/        /' >&2 || true
      cat >&2 <<EOF

      Free space first, then rebuild. In order of preference:
        du -sh ~/.vscode-server/cli/servers/*   # stale VS Code servers are usually the biggest win
        docker image prune -f                   # untagged images only
        ./scripts/deploy.sh reclaim --cache      # LAST resort: the next build becomes COLD (~4 GB)
EOF
      cleanup "$EXIT_WATCHDOG" || true
      exit "$EXIT_WATCHDOG"
    fi
    err "build failed (exit ${rc}); full log: ${BUILD_LOG}"
    tail -n 25 "$BUILD_LOG" | sed 's/^/        /' >&2
    printf '\n'
    info "the previous stack was never stopped — it is still running:"
    dc ps --format 'table {{.Service}}\t{{.Status}}' | sed 's/^/        /' >&2 || true
    if grep -qi 'no space left on device' "$BUILD_LOG"; then
      cat >&2 <<EOF

      Out of disk. Reclaim safely (never touches Docker volumes / queue.db):
        ./scripts/deploy.sh reclaim
EOF
    fi
    die "docker compose build"
  fi
  # A watchdog that tripped but whose build still succeeded is a diagnostic, not
  # a failure — say so plainly instead of leaving a cancellation line unexplained.
  if [ -f "$WATCHDOG_FLAG" ]; then
    warn "the disk watchdog fired but the build completed anyway ($(cat "$WATCHDOG_FLAG"))"
    rm -f "$WATCHDOG_FLAG"
  fi
  ok "all images built"

  # AT-014(b): preflight proved the disk was fine BEFORE a build that may have
  # consumed gigabytes. `up -d` creates writable layers and starts writing logs,
  # so re-prove it here rather than trusting a minutes-old reading.
  local post_build_mb; post_build_mb="$(free_mb "$DOCKER_FS")"
  if [ "$post_build_mb" -lt "$DISK_FLOOR_MB" ]; then
    err "only ${post_build_mb} MB free on ${DOCKER_FS} after the build (floor ${DISK_FLOOR_MB} MB)"
    die "refusing to start containers on a nearly full filesystem — the images are built, free space and re-run"
  fi
  detail "free space after build: ${post_build_mb} MB (floor ${DISK_FLOOR_MB} MB)"
}

# ── Stage 4: swap ───────────────────────────────────────────────────────────
IMAGES_CHANGED=0
declare -A BASELINE_RESTARTS=()

start_services() {
  stage "Starting updated services"

  # Which services actually got a new image? Only those force a recreate, and
  # only an orchestrator recreate can disturb an in-flight print.
  #
  # Compared by ROOTFS LAYERS, not by image id: BuildKit's provenance
  # attestation (disabled in compose.yml, but a `docker compose build` run by
  # hand elsewhere may re-enable it) changes the manifest digest on every build
  # while every layer stays byte-identical. Comparing ids there would report
  # "new image" for a no-op rebuild and gate a deploy that changes nothing.
  #
  # The comparison is between the tag as it stood BEFORE this build (stage 2
  # pinned it as :previous) and the tag as it stands AFTER — i.e. "did this
  # build change anything", which is what decides whether compose swaps the
  # container. The running container's own digest cannot be used here: the
  # containerd image store does not expose it as a resolvable image reference.
  local svc img_name new_id old_id new_fs old_fs orchestrator_changed=0
  while read -r svc; do
    [ -n "$svc" ] || continue
    img_name="$(service_image_name "$svc")"
    new_id="$(image_id "${img_name}:latest")"
    if [ -z "$new_id" ]; then new_id="$(image_id "$img_name")"; fi
    old_id="$(image_id "${img_name}:previous")"
    new_fs="$(rootfs_of "${img_name}:latest")"; old_fs="$(rootfs_of "${img_name}:previous")"
    if [ -n "$new_id" ] && [ "$new_fs" != "$old_fs" ]; then
      IMAGES_CHANGED=$((IMAGES_CHANGED + 1))
      ok "${svc}: new image ${new_id:7:12} (was ${old_id:7:12}) — filesystem changed"
      if [ "$svc" = "print-orchestrator" ]; then orchestrator_changed=1; fi
    elif [ -n "$new_id" ] && [ "$new_id" != "$old_id" ]; then
      # AT-004: THE decision must be made once, not twice by different rules.
      # This script compares rootfs layers; `docker compose up` compares image
      # IDs. They agree only while --provenance=false keeps the id stable. When
      # they disagree, the script concludes "unchanged" and skips the gate while
      # compose still recreates the container — silently killing run identity
      # mid-print, which is the exact thing the gate exists to prevent.
      #
      # Rather than trusting the flag, make the two views identical: move the
      # tag back onto the byte-identical image compose is already running. After
      # this, compose sees literally the same image ID and cannot recreate the
      # container, whatever provenance settings are in play.
      warn "${svc}: image id changed but the filesystem is identical (build metadata only)"
      if [ -n "${RUNNING_IMAGE_ID[$svc]:-}" ]; then
        docker tag "${RUNNING_IMAGE_ID[$svc]}" "${img_name}:latest"
        detail "${svc}: ${img_name}:latest re-pointed at the running image ${RUNNING_IMAGE_ID[$svc]:7:12} so compose sees no change"
      fi
    else
      detail "${svc}: image unchanged — compose recreates it only if its config changed"
    fi
  done < <(buildable_services)

  # The active-print gate fires HERE, with FRESHLY READ data, not in preflight:
  # a production-orca build takes minutes, and a night-scheduled print can start
  # inside that window. Re-reading turns a build-length race into a seconds-long
  # one. An idempotent re-run with unchanged images never reaches this point.
  if [ "$orchestrator_changed" -eq 1 ]; then
    info "re-checking prints in flight immediately before the swap"
    enforce_active_print_gate "the orchestrator image changed"
  else
    detail "orchestrator image unchanged — no restart, so no active-print gate needed"
  fi

  # Baseline restart counters so a crash loop after the swap is distinguishable
  # from a container that was already flapping.
  while read -r svc; do
    [ -n "$svc" ] || continue
    BASELINE_RESTARTS["$svc"]="$(container_state "$(container_id "$svc")" | awk '{print $3}')"
  done < <(dc config --services)

  # --no-build: the images are already built and verified above; an implicit
  # rebuild here would be an unguarded second build.
  dc up -d --no-build
  ok "docker compose up -d completed"
}

# ── Stage 5: health ─────────────────────────────────────────────────────────
wait_for_health() {
  stage "Waiting for health checks"
  local deadline=$(( SECONDS + HEALTH_TIMEOUT )) svc cid state status health restarts
  local -a services=()
  mapfile -t services < <(dc config --services)
  local -A last_report=()
  local pending=1

  while [ "$pending" -eq 1 ]; do
    pending=0
    for svc in "${services[@]}"; do
      cid="$(container_id "$svc")"
      state="$(container_state "$cid")"
      status="$(awk '{print $1}' <<<"$state")"
      health="$(awk '{print $2}' <<<"$state")"
      restarts="$(awk '{print $3}' <<<"$state")"

      local report="${status}/${health}"
      if [ "${last_report[$svc]:-}" != "$report" ]; then
        last_report["$svc"]="$report"
        if [ "$health" = "none" ]; then detail "${svc}: ${status} (no healthcheck defined)"
        else detail "${svc}: ${status}, health=${health}"; fi
      fi

      case "$status" in
        exited|dead)
          err "${svc} exited (${status})"
          dump_failure "$svc"; die "${svc} exited during startup" ;;
      esac
      if [ "$restarts" -gt $(( ${BASELINE_RESTARTS[$svc]:-0} + 2 )) ]; then
        err "${svc} is crash-looping (restart count ${restarts})"
        dump_failure "$svc"; die "${svc} is restarting repeatedly"
      fi

      # A service without a healthcheck (go2rtc, until compose.yml gained one)
      # can only be judged by "is it running".
      if [ "$health" = "none" ]; then
        [ "$status" = "running" ] || pending=1
      else
        [ "$health" = "healthy" ] || pending=1
      fi
    done

    if [ "$pending" -eq 0 ]; then break; fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      err "timed out after ${HEALTH_TIMEOUT}s waiting for services to become healthy"
      for svc in "${services[@]}"; do
        state="$(container_state "$(container_id "$svc")")"
        status="$(awk '{print $1}' <<<"$state")"; health="$(awk '{print $2}' <<<"$state")"
        if { [ "$health" != "none" ] && [ "$health" != "healthy" ]; } || { [ "$health" = "none" ] && [ "$status" != "running" ]; }; then
          err "${svc} did not become healthy (${status}/${health})"
          dump_failure "$svc"
        fi
      done
      handle_verification_failure "services did not become healthy within ${HEALTH_TIMEOUT}s"
    fi
    sleep 3
  done

  for svc in "${services[@]}"; do
    state="$(container_state "$(container_id "$svc")")"
    ok "${svc}: $(awk '{print $1}' <<<"$state") · health=$(awk '{print $2}' <<<"$state") · restarts=$(awk '{print $3}' <<<"$state")"
  done
}

dump_failure() {
  local svc="$1"
  printf '\n      %s--- docker compose ps ---%s\n' "$C_DIM" "$C_RESET" >&2
  dc ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | sed 's/^/        /' >&2 || true
  printf '\n      %s--- last 40 log lines: %s ---%s\n' "$C_DIM" "$svc" "$C_RESET" >&2
  dc logs --tail 40 --no-color "$svc" 2>&1 | sed 's/^/        /' >&2 || true
  local cid; cid="$(container_id "$svc")"
  if [ -n "$cid" ]; then
    local hc; hc="$(docker inspect "$cid" --format '{{if .State.Health}}{{range .State.Health.Log}}{{.ExitCode}}: {{.Output}}{{end}}{{end}}' 2>/dev/null | tail -c 600)"
    if [ -n "$hc" ]; then
      printf '\n      %s--- last healthcheck output ---%s\n' "$C_DIM" "$C_RESET" >&2
      printf '%s\n' "$hc" | sed 's/^/        /' >&2
    fi
  fi
  printf '\n' >&2
}

# ── Stage 6: HTTP ───────────────────────────────────────────────────────────
verify_http() {
  stage "Verifying HTTP endpoints"
  if [ "$SKIP_HTTP" -eq 1 ]; then
    warn "skipped (--no-http-check)"
    return 0
  fi

  local mapping port base
  mapping="$(dc port "$HTTP_SERVICE" "$HTTP_CONTAINER_PORT" 2>/dev/null || true)"
  if [ -z "$mapping" ]; then
    warn "${HTTP_SERVICE} publishes no host port for ${HTTP_CONTAINER_PORT} — skipping HTTP verification"
    return 0
  fi
  port="$(awk -F: 'NF{print $NF}' <<<"$mapping")"
  # Always dial loopback: the published bind may be 0.0.0.0 (LAN) or 127.0.0.1,
  # and loopback works for both without assuming the host's LAN address.
  base="http://127.0.0.1:${port}"
  info "dashboard published at ${mapping} → probing ${base}"

  probe "${base}/" "dashboard (nginx static)" '' || return 1
  probe "${base}/api/print-orchestrator/health" "orchestrator /health (via dashboard proxy)" '"status":"ok"' || return 1
  # /ready is the real readiness signal: 503 until the first printer poll lands
  # or if the poll loop goes stale. `status` may be "degraded" (an offline
  # printer) and that is still a correct, serving deployment — do not require ok.
  probe "${base}/api/print-orchestrator/ready" "orchestrator /ready (first poll completed)" '"ready":true' || return 1
}

probe() {
  local url="$1" label="$2" expect="$3"
  local deadline=$(( SECONDS + HTTP_TIMEOUT )) code body
  body="$(new_temp)"
  while :; do
    code="$(http_code "$url" "$body")"
    if [ "$code" = "200" ] && { [ -z "$expect" ] || grep -q "$expect" "$body"; }; then
      ok "${label} → HTTP ${code}"
      if [ -n "$expect" ]; then detail "$(head -c 200 "$body")"; fi
      rm -f "$body"; return 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      err "${label} → HTTP ${code} at ${url}"
      if [ -s "$body" ]; then head -c 500 "$body" | sed 's/^/        /' >&2; fi
      rm -f "$body"
      dump_failure "$HTTP_SERVICE"
      # always exits (rolls back first when --rollback-on-failure is set)
      handle_verification_failure "${label} did not answer correctly at ${url}"
    fi
    sleep 2
  done
}

# ── Failure handling after the swap ─────────────────────────────────────────
# By this point the new containers are already running, so "the old stack keeps
# serving" no longer applies. Rollback is offered but NOT automatic by default:
# the orchestrator's SQLite migrations are forward-only (no `down`), so an older
# image may meet a schema it does not know. Opt in with --rollback-on-failure.
handle_verification_failure() {
  local reason="$1"
  # Already inside do_rollback's own verification: recursing would roll back the
  # rollback. Let rollback_verify see the failure instead.
  if [ "${ROLLBACK_IN_PROGRESS:-0}" -eq 1 ]; then
    die "$reason"
  fi
  if [ "$ROLLBACK_ON_FAILURE" -eq 1 ]; then
    # AT-013(3): forward-only migrations. If THIS deploy applied one, the schema
    # has already moved past what the last-known-good image understands, and an
    # automatic rollback would start an old binary on a future schema — which
    # the new startup guard turns into a crash loop, and which without that
    # guard silently corrupts data. Refuse, and hand over the exact recovery.
    if deploy_applied_migrations; then
      err "this deploy APPLIED DATABASE MIGRATIONS — automatic rollback is blocked"
      cat >&2 <<EOF

      queue.db is now at a schema the previous image does not know. Migrations
      are forward-only, so re-pointing compose at the old image is NOT a safe
      undo. Recover deliberately instead:

        docker compose logs --tail 200 print-orchestrator   # what actually failed
        ls -t ${DB_SNAPSHOT_DIR}/                           # pre-deploy snapshots
        ./ops/backup/restore.sh --set <set> --to-production --i-mean-it

      If you are certain the old image tolerates this schema, roll back by hand:
        ./scripts/deploy.sh rollback
EOF
      die "${reason} (rollback blocked: migrations were applied)"
    fi
    warn "verification failed — rolling back to the last-known-good images"
    do_rollback
    die "${reason} (rolled back to the last-known-good images; check the logs above)"
  fi
  cat >&2 <<EOF

      The new containers are running but did not verify. Options:

        docker compose logs -f print-orchestrator     # find out why
        ./scripts/deploy.sh rollback                  # re-point compose at the
                                                      # :previous images and restart

      Rollback caveat: the orchestrator's SQLite migrations are FORWARD-ONLY.
      If this deploy introduced a new migration it has already been applied to
      queue.db, and the previous image may not understand the new schema. Check
      "migration" lines in the logs before rolling back; restoring a backup of
      the orchestrator-data volume is the safe path in that case.
EOF
  die "$reason"
}

# Did the container that just started apply migrations? The orchestrator logs a
# line when it does; absence of the line means the schema is unchanged.
deploy_applied_migrations() {
  local logs
  logs="$(dc logs --tail 400 --no-color print-orchestrator 2>/dev/null || true)"
  printf '%s' "$logs" | grep -qiE 'migrations applied|queue database migrations'
}

# ── rollback ────────────────────────────────────────────────────────────────
do_rollback() {
  [ -f "$STATE_FILE" ] || die "no ${STATE_FILE} — this host has no recorded last-known-good to roll back to"
  local restored=0 svc var_tag var_id img recorded_id actual_id

  # AT-005(b): rollback recreates containers exactly like a deploy does, so it
  # needs the same protection. It previously had none at all.
  info "checking prints in flight before rolling back"
  enforce_active_print_gate "a rollback would recreate the orchestrator"

  while read -r svc; do
    [ -n "$svc" ] || continue
    var_tag="LKG_IMAGE_$(printf '%s' "$svc" | tr '-' '_')"
    var_id="LKG_IMAGE_ID_$(printf '%s' "$svc" | tr '-' '_')"
    img="$(awk -F= -v k="$var_tag" '$1==k{print $2}' "$STATE_FILE")"
    recorded_id="$(awk -F= -v k="$var_id" '$1==k{print $2}' "$STATE_FILE")"
    [ -n "$img" ] || { detail "${svc}: no recorded last-known-good image"; continue; }
    if ! docker image inspect "$img" >/dev/null 2>&1; then
      warn "${svc}: recorded image ${img} no longer exists (pruned?) — cannot roll this service back"
      continue
    fi
    # AT-003(3): the tag is mutable, the recorded ID is not. If they disagree,
    # something re-tagged the image behind our back and "rollback" would start
    # an unknown build. Refuse rather than guess.
    actual_id="$(image_id "$img")"
    if [ -n "$recorded_id" ] && [ "$actual_id" != "$recorded_id" ]; then
      err "${svc}: ${img} now resolves to ${actual_id:7:12} but the recorded last-known-good is ${recorded_id:7:12}"
      die "rollback target has been re-tagged since it was recorded — refusing to start an unverified image"
    fi
    docker tag "$img" "$(service_image_name "$svc"):latest"
    ok "${svc}: restored $(service_image_name "$svc"):latest ← ${img} (${actual_id:7:12})"
    restored=$((restored + 1))
  done < <(buildable_services)

  [ "$restored" -gt 0 ] || die "no last-known-good images could be restored"

  dc up -d --no-build
  info "containers re-created from the last-known-good images — now VERIFYING"

  # AT-009: "previous images are running again" used to be printed here, before
  # anything had been checked. A rollback onto an image that cannot start (for
  # instance because a forward-only migration already moved the schema past it)
  # would report success while the farm was down.
  ROLLBACK_IN_PROGRESS=1
  if ! rollback_verify; then
    err "ROLLBACK FAILED — the last-known-good images did not come up healthy"
    dump_failure print-orchestrator
    cat >&2 <<EOF

      The farm is NOT serving. This is the case the pre-deploy database snapshot
      exists for — a forward-only migration may have moved queue.db past what
      this image understands:

        ls -t ${DB_SNAPSHOT_DIR}/                    # snapshots, newest first
        ./ops/backup/restore.sh --set <backup-set> --to-production --i-mean-it
        docker compose logs --tail 100 print-orchestrator
EOF
    exit 1
  fi

  ok "ROLLBACK VERIFIED — last-known-good images are running and answering"
  info "note: the working tree is still at the NEW code — rollback restores the running"
  info "      containers, not the checkout. Re-deploy once the failure is fixed."
  dc ps --format 'table {{.Service}}\t{{.Status}}' | sed 's/^/        /'
}

# Health + HTTP, reusing the same checks a deploy runs. Returns non-zero instead
# of dying so do_rollback can report ROLLBACK FAILED itself.
ROLLBACK_IN_PROGRESS=0
rollback_verify() {
  local saved_stage_no="$STAGE_NO" saved_total="$TOTAL_STAGES"
  TOTAL_STAGES=$((STAGE_NO + 2))
  ( wait_for_health ) || return 1
  ( verify_http )     || return 1
  STAGE_NO="$saved_stage_no"; TOTAL_STAGES="$saved_total"
  return 0
}

# ── reclaim (safe cleanup) ──────────────────────────────────────────────────
# Build cache and untagged images only. No `-a` on image prune (that would
# delete images no container currently uses, including :previous), and above
# all NO volume operations of any kind — orchestrator-data holds queue.db.
# Two modes, because they are not the same operation:
#
#   --safe  (default) untagged images only. Frees real space, keeps the warm
#                     build cache the next build depends on.
#   --cache           ALSO drops the entire build cache. This makes the next
#                     build COLD, and a cold production-orca build needs ~4 GB —
#                     so on a tight disk this can turn "deploy is slow" into
#                     "deploy no longer fits". It reclaims ~1 GB to cost ~4 GB.
#
# The old single mode always did `builder prune -a`, and preflight recommended it
# FIRST in its out-of-disk message — the worst available advice at that moment.
do_reclaim() {
  local mode="${1:-safe}" fs before after
  fs="${DOCKER_FS:-$(docker_root)}"; [ -d "$fs" ] || fs="/"
  before="$(free_mb "$fs")"

  if [ "$mode" = "cache" ]; then
    warn "reclaiming the BUILD CACHE — the next build will be COLD"
    warn "a cold production-orca build needs ~${MIN_FREE_MB_ORCA} MB free; make sure that is achievable"
    docker builder prune -a -f | sed 's/^/        /'
  else
    info "safe reclaim: untagged images only (build cache kept — the next build needs it)"
  fi
  docker image prune -f | sed 's/^/        /'

  after="$(free_mb "$fs")"
  ok "free space on ${fs}: ${before} MB → ${after} MB (+$((after - before)) MB)"
  if [ "$mode" != "cache" ]; then
    detail "build cache left intact; to drop it too: ./scripts/deploy.sh reclaim --cache"
    docker system df | awk '/Build Cache/ {print "        build cache still held: " $3}'
  fi
  detail "orchestrator-data and every other volume were left untouched:"
  docker volume ls --format '        {{.Name}}' | grep orchestrator-data || true
}

# The commit a RUNNING container was actually built from, read from the image it
# was started from rather than from the checkout — which is the whole point: the
# working tree can be many commits ahead of whatever is serving traffic, and a
# partial deploy leaves two services on different revisions.
running_revision() {
  local svc="$1" cid img rev
  cid="$(container_id "$svc")"
  [ -n "$cid" ] || { printf 'rev=absent'; return; }
  img="$(docker inspect "$cid" --format '{{.Image}}' 2>/dev/null || true)"
  rev="$(docker inspect "$img" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
  case "$rev" in
    ''|'<no value>') printf 'rev=unlabelled' ;;
    *)               printf 'rev=%s' "${rev:0:12}" ;;
  esac
}

# ── status ──────────────────────────────────────────────────────────────────
do_status() {
  printf '%sAtelier stack%s (project %s, %s)\n\n' "$C_BOLD" "$C_RESET" "$(compose_project)" "$REPO_ROOT"
  dc ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
  printf '\n'
  local svc
  while read -r svc; do
    [ -n "$svc" ] || continue
    printf '  %-20s %-26s %s\n' "$svc" "$(container_state "$(container_id "$svc")")" "$(running_revision "$svc")"
  done < <(dc config --services)
  printf '\n'
  df -h "$(docker_root)" 2>/dev/null | sed 's/^/  /' || df -h / | sed 's/^/  /'
  printf '\n'
  docker system df | sed 's/^/  /'
  if [ -f "$STATE_FILE" ]; then
    printf '\n  rollback target (%s):\n' "$STATE_FILE"
    sed 's/^/    /' "$STATE_FILE"
  fi
}

# ── argument parsing ────────────────────────────────────────────────────────
# Validated here, at parse time, so a typo costs nothing. The old code accepted
# any string and only tripped later: `--health-timeout abc` blew up inside
# $(( SECONDS + HEALTH_TIMEOUT )) AFTER preflight, snapshot and a full build.
assert_positive_int() {
  local value="$1" flag="$2"
  case "$value" in
    ''|*[!0-9]*) die "${flag} needs a positive integer (got: '${value}')" ;;
  esac
  [ "$value" -gt 0 ] 2>/dev/null || die "${flag} needs a positive integer (got: '${value}')"
}

COMMAND="deploy"
CLEANUP=0
RECLAIM_MODE="safe"
ALLOW_ACTIVE_PRINTS=0
ROLLBACK_ON_FAILURE=0
SKIP_HTTP=0
DISK_WATCHDOG=1
MIN_FREE_MB_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    deploy|preflight|rollback|reclaim|status) COMMAND="$1" ;;
    --safe)                 RECLAIM_MODE="safe" ;;
    --cache)                RECLAIM_MODE="cache" ;;
    --cleanup)              CLEANUP=1 ;;
    --min-free-mb)          assert_positive_int "${2:-}" --min-free-mb;    MIN_FREE_MB_OVERRIDE="$2"; shift ;;
    --health-timeout)       assert_positive_int "${2:-}" --health-timeout; HEALTH_TIMEOUT="$2";        shift ;;
    --allow-active-prints)  ALLOW_ACTIVE_PRINTS=1 ;;
    --rollback-on-failure)  ROLLBACK_ON_FAILURE=1 ;;
    --no-http-check)        SKIP_HTTP=1 ;;
    --no-disk-watchdog)     DISK_WATCHDOG=0 ;;
    -y|--yes)               ALLOW_ACTIVE_PRINTS=1 ;;
    -h|--help)              usage; exit 0 ;;
    *) printf 'unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# ── single-instance lock ────────────────────────────────────────────────────
# Two concurrent deploys would race on the same image tags and on `up -d`
# (compose would recreate containers underneath each other). Non-blocking on
# purpose: a second operator should be told, not silently queued.
mkdir -p "$STATE_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  die "another deploy is already running (lock: ${LOCK_FILE}). Wait for it, or check: ./scripts/deploy.sh status"
fi
printf '%s pid=%s cmd=%s\n' "$(date -Iseconds)" "$$" "$COMMAND" >&9 || true

# ── dispatch ────────────────────────────────────────────────────────────────
case "$COMMAND" in
  status)
    trap - ERR
    do_status
    ;;
  reclaim)
    CURRENT_STAGE="reclaim"
    DOCKER_FS="$(docker_root)"
    do_reclaim "$RECLAIM_MODE"
    ;;
  rollback)
    CURRENT_STAGE="rollback"
    do_rollback
    ;;
  preflight)
    TOTAL_STAGES=1
    preflight
    printf '\n%s✓ Preflight passed%s — %s warning(s). Nothing was built or changed.\n' \
      "$C_GREEN$C_BOLD" "$C_RESET" "$WARNINGS"
    ;;
  deploy)
    START_TS=$SECONDS
    preflight
    snapshot_images
    build_images
    start_services
    wait_for_health
    verify_http

    # Everything above passed: health checks AND real HTTP responses. Only now
    # is this build entitled to be the thing a rollback returns to. Doing it
    # here (rather than before the build, as the old snapshot did) is what makes
    # ":previous" mean "last version that actually worked" instead of "whatever
    # was tagged last time" — a failed deploy never touches the target, and a
    # second failed deploy cannot promote the first failure.
    if [ "$IMAGES_CHANGED" -gt 0 ]; then
      adopt_last_known_good "verified deploy at $(date -Iseconds)"
    else
      detail "no image changed — last-known-good left as it was"
    fi

    if [ "$CLEANUP" -eq 1 ]; then
      printf '\n%sPost-deploy cleanup%s\n' "$C_BOLD$C_BLUE" "$C_RESET"
      # Safe by default: --cleanup must not quietly destroy the warm cache the
      # NEXT deploy needs. `reclaim --cache` is the explicit way to do that.
      do_reclaim "$RECLAIM_MODE"
    fi

    PORT_MAP="$(dc port "$HTTP_SERVICE" "$HTTP_CONTAINER_PORT" 2>/dev/null || echo 'not published')"
    printf '\n%s✓ Atelier deployed successfully%s in %ss (%s warning(s))\n' \
      "$C_GREEN$C_BOLD" "$C_RESET" "$((SECONDS - START_TS))" "$WARNINGS"
    printf '  dashboard: %s\n' "$PORT_MAP"
    printf '  images swapped: %s\n' "$IMAGES_CHANGED"
    printf '  roll back with: ./scripts/deploy.sh rollback\n'
    if [ "$CLEANUP" -eq 0 ]; then
      printf '  %sfree build cache when disk gets tight: ./scripts/deploy.sh reclaim%s\n' "$C_DIM" "$C_RESET"
    fi
    ;;
esac
