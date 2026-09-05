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
#   ./scripts/deploy.sh --no-cleanup    # skip the post-deploy reclaim (default: ON)
#   ./scripts/deploy.sh preflight       # checks only, changes nothing
#   ./scripts/deploy.sh reclaim         # free disk safely (untagged images; cache capped)
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
# Ceiling for BuildKit's cache. The cache is not garbage-collected on its own:
# every build ADDS records and none are ever dropped, so an unattended host
# grows by roughly one full image worth of layers per deploy until the disk is
# full. 5 GB comfortably holds the warm layers of both targets while bounding
# the worst case. Enforced after each successful deploy (see do_reclaim).
BUILD_CACHE_MAX_GB="${DEPLOY_BUILD_CACHE_MAX_GB:-5}"
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
# Distinct exit codes: 1 generic failure, 3 watchdog, 4 DEFERRED (built but
# deliberately not swapped — nothing is broken), 130 SIGINT, 143 SIGTERM.
EXIT_WATCHDOG=3
EXIT_DEFERRED=4

# ── Output ──────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

TOTAL_STAGES=7
STAGE_NO=0
# Build identity, filled in by build_images. Declared here so every later
# reporting path can read them under `set -u` even if the build never ran.
GIT_COMMIT=""; BUILD_TIME=""; GIT_DIRTY=0
CURRENT_STAGE="startup"
WARNINGS=0

stage()  { STAGE_NO=$((STAGE_NO + 1)); CURRENT_STAGE="$1"
           printf '\n%s[%d/%d] %s%s\n' "$C_BOLD$C_BLUE" "$STAGE_NO" "$TOTAL_STAGES" "$1" "$C_RESET"; }
info()   { printf '      %s\n' "$*"; }
detail() { printf '      %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok()     { printf '      %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()   { WARNINGS=$((WARNINGS + 1)); printf '      %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()    { printf '      %s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
# What a hard failure is CALLED depends on what was being attempted. A refused
# rollback printing "Deployment failed" sends the operator looking for a deploy
# that never ran. Set once by the dispatch, before anything can fail.
FAILURE_LABEL="DEPLOY FAILED"
die()    { printf '\n%s✗ %s: %s%s\n' "$C_RED$C_BOLD" "$FAILURE_LABEL" "$*" "$C_RESET" >&2; exit 1; }

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
    if [ "${SWAP_ATTEMPTED:-0}" -eq 0 ]; then
      printf '%s  Nothing was swapped; the running stack is untouched: docker compose ps%s\n' "$C_RED" "$C_RESET" >&2
    else
      printf '%s  Interrupted DURING the swap — check: docker compose ps%s\n' "$C_RED" "$C_RESET" >&2
    fi
  fi
  return "$exit_code"
}

on_err() {
  local exit_code=$? line=$1
  [ "$BASHPID" = "$MAIN_SHELL_PID" ] || return "$exit_code"
  if [ "$CLEANUP_DONE" -eq 0 ]; then
    printf '\n%s✗ %s during: %s%s (line %s, exit %s)\n' \
      "$C_RED$C_BOLD" "$FAILURE_LABEL" "$CURRENT_STAGE" "$C_RESET$C_RED" "$line" "$exit_code" >&2
    if [ "${SWAP_ATTEMPTED:-0}" -eq 0 ]; then
      printf '%s  Nothing was stopped — the previous stack is still serving: docker compose ps%s\n' "$C_RED" "$C_RESET" >&2
    else
      printf '%s  The swap had already started — containers MAY have been replaced. Check: docker compose ps%s\n' "$C_RED" "$C_RESET" >&2
      printf '%s  To return to the last verified images: ./scripts/deploy.sh rollback%s\n' "$C_RED" "$C_RESET" >&2
    fi
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
  --cleanup               post-deploy reclaim: untagged images + build-cache ceiling (DEFAULT)
  --no-cleanup            skip that reclaim; images and cache then accumulate every deploy
  --min-free-mb N         override the pre-build free-space requirement
  --health-timeout N      seconds to wait for containers to become healthy (default 180)
  --allow-active-prints   recreate the orchestrator even though printers are mid-print.
                          The printers are never touched. Canonical runs are re-adopted
                          from SQLite on restart, so identity, duration and filament
                          accounting survive; what does not is an UNTRACKED print (started
                          on the printer, not via the queue) and any completion that lands
                          inside the restart window.
  --rollback-on-failure   if the new stack fails verification, re-point compose at the
                          previous images and restart them (see the migration caveat below)
  --no-disk-watchdog      do not cancel the build when free space hits the floor
  --no-http-check         skip stage 6 (for hosts where the dashboard port is firewalled)

Flags (reclaim):
  --safe                  untagged images + build cache trimmed to the ceiling (default)
  --cache                 also drop the build cache — the NEXT BUILD BECOMES COLD
  -y, --yes               non-interactive: same as --allow-active-prints
  -h, --help              this help

Terminal states (read the LAST line of the log; the exit code matches):
  0   DEPLOY SUCCESS    built, swapped, healthy, HTTP-verified, identity proven
  0   ROLLBACK SUCCESS  last-known-good images restored AND verified
  4   DEPLOY DEFERRED   images built and cached, deliberately NOT swapped
                        (a print is in flight and the orchestrator would be
                        recreated). Nothing is broken; re-run when convenient.
  3   build cancelled by the disk watchdog — free space, then rebuild
  1   DEPLOY FAILED / ROLLBACK FAILED — needs a decision before re-running
  130/143  interrupted (SIGINT/SIGTERM); nothing was swapped
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

# These three ask compose to describe itself, and every one of them is reached
# by `status`, `rollback` and `reclaim` — commands that never run preflight and
# so have never proved the daemon is up or the config resolves. A bare
# `dc config | jq` there turns "the Docker daemon is down" into an abort at a
# line number under `set -e` + `pipefail`. Each now falls back instead.
compose_project() {
  if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then printf '%s' "$COMPOSE_PROJECT_NAME"; return; fi
  local name=""
  if have jq; then
    name="$(dc config --format json 2>/dev/null | jq -r '.name // empty' 2>/dev/null || true)"
  fi
  if [ -n "$name" ] && [ "$name" != "null" ]; then printf '%s' "$name"; return; fi
  # compose's own default: the directory name, lowercased and sanitised.
  # `tr -c` treats the trailing newline as "not in the set" too, so the naive
  # form returned "atelier-" instead of "atelier" — a project name that matches
  # no running container and no existing volume.
  local dir; dir="$(basename "$REPO_ROOT")"
  printf '%s' "$dir" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-'
}

# Services compose will build (as opposed to pull). Only these can be rolled back
# to a locally tagged predecessor.
buildable_services() {
  local out=""
  if have jq; then
    out="$(dc config --format json 2>/dev/null | jq -r '.services | to_entries[] | select(.value.build) | .key' 2>/dev/null || true)"
  fi
  if [ -z "$out" ]; then
    out="$(dc config 2>/dev/null | awk '/^  [a-z]/ {svc=$1} /^    build:/ {print svc}' | tr -d ':' || true)"
  fi
  [ -n "$out" ] && printf '%s\n' "$out"
  return 0
}

# The image tag compose builds into: an explicit `image:` if the service declares
# one, else compose's default <project>-<service>.
service_image_name() {
  local svc="$1" img=""
  if have jq; then
    img="$(dc config --format json 2>/dev/null | jq -r --arg s "$svc" '.services[$s].image // empty' 2>/dev/null || true)"
  fi
  [ "$img" = "null" ] && img=""
  if [ -n "$img" ]; then printf '%s' "$img"; return; fi
  printf '%s-%s' "$(compose_project)" "$svc"
}

container_id() { dc ps -q "$1" 2>/dev/null || true; }

image_id()  { docker image inspect "$1" --format '{{.Id}}' 2>/dev/null || true; }

# The image a service's CONTAINER is actually running, read from the container.
# This — not the `:latest` tag — is the only honest answer to "what is serving
# right now", and it is exactly what `docker compose up` compares against when
# it decides whether to recreate. The two diverge whenever a deploy built images
# but did not swap them in (a deferred deploy, an interrupted one, a manual
# `docker compose build`), and reading the tag in that state makes the script
# compare the new image against itself and conclude "nothing changed" while
# compose goes ahead and recreates the container anyway.
running_image_id() {
  local cid; cid="$(container_id "$1")"
  [ -n "$cid" ] || return 0
  docker inspect "$cid" --format '{{.Image}}' 2>/dev/null || true
}

# The commit an image was built from, straight off its OCI label.
image_revision() {
  local rev
  rev="$(docker image inspect "$1" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
  case "$rev" in ''|'<no value>') return 0 ;; *) printf '%s' "$rev" ;; esac
}
# The image's actual content: the ordered rootfs layer digests. Unlike the image
# id this is stable across rebuilds that changed nothing (a moved OCI label
# changes the id, never a layer).
#
# Takes any reference `docker image inspect` accepts — a name:tag, or the bare
# image id a container reports as `.Image`, which IS resolvable (verified on
# Docker 29.7 with the containerd image store; an older note here claimed
# otherwise and cost this script its ability to compare against what is
# actually running). Callers must still treat an EMPTY answer as "unknown" and
# fail safe, since an id can stop resolving at any time.
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
    # `rev-parse --git-dir` succeeds in a repository whose HEAD is UNBORN (git
    # init, nothing committed yet). `rev-parse HEAD` then exits 128 — and under
    # `set -e` a failing command substitution in an assignment aborts the whole
    # script, so this used to end a deploy with a bare "exit 128" at a line
    # number instead of the honest "there is no commit to build from".
    commit="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
    dirty="$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    if [ -z "$commit" ]; then
      warn "git repository has no commits yet — the image will be labelled with an unknown revision"
    elif [ "$dirty" -gt 0 ]; then
      warn "building from ${commit} with ${dirty} uncommitted change(s) — the deployed image will not match any commit"
    else
      ok "building from commit ${commit} (clean tree)"
    fi
  else
    warn "${REPO_ROOT} is not a git repository — the image will be labelled with an unknown revision"
  fi

  # -- security posture (README / SECURITY.md invariants) --------------------
  local bind token
  bind="$(dc config 2>/dev/null | awk '/published:/ {print $2}' | tr -d '"' | tr '\n' ' ')"
  detail "published ports: ${bind}"
  # Guarded on BOTH sides of the pipe. `pipefail` makes the whole substitution
  # fail if `dc config` dies OR jq does — and a failing `$(...)` in an assignment
  # ends the script under `set -e`, which is a violent way to react to not being
  # able to read one optional field.
  if have jq; then
    token="$(dc config --format json 2>/dev/null | jq -r '.services["print-dashboard"].environment.ORCHESTRATOR_API_TOKEN // ""' 2>/dev/null || true)"
  else
    token="?"   # unknown, not "empty" — do not warn about what was not read
  fi
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
  # `head -1`: a dual-stack publish prints one line per address family, and
  # without it `port` becomes "8090\n8090" and every URL built from it is junk.
  port="$(dc port "$HTTP_SERVICE" "$HTTP_CONTAINER_PORT" 2>/dev/null | awk -F: 'NF{print $NF}' | head -1)" || true
  [ -n "${port:-}" ] || { echo unknown; return; }
  url="http://127.0.0.1:${port}/api/print-orchestrator/api/printers"
  body="$(new_temp)"
  code="$(http_code "$url" "$body")"
  if [ "$code" != "200" ]; then rm -f "$body"; echo unknown; return; fi
  if have jq; then
    n="$(jq -r '[(if type=="array" then .[] else .printers[] end) | select(.status=="printing" or .status=="paused")] | length' <"$body" 2>/dev/null || echo unknown)"
  else
    # `|| true` is load-bearing: grep exits 1 when it matches NOTHING, and with
    # `set -o pipefail` that becomes the whole substitution's status, which under
    # `set -e` aborts the deploy. The no-match case is "no printers are busy" —
    # the single most common, most correct answer this branch can produce, and
    # it used to be the one that killed the script (on a host without jq).
    n="$( { grep -o '"status":"\(printing\|paused\)"' "$body" || true; } | wc -l | tr -d ' ')"
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

# Which printers are busy, by name, so the operator can see WHY a deploy is
# being held instead of having to go and look. Best-effort: never allowed to
# fail the gate it is only annotating.
describe_active_prints() {
  local cid out
  cid="$(container_id print-orchestrator)"
  [ -n "$cid" ] || return 0
  out="$(docker exec -i "$cid" node -e '
    fetch("http://127.0.0.1:3100/api/printers")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then((d) => {
        const list = Array.isArray(d) ? d : d.printers;
        if (!Array.isArray(list)) throw new Error("unexpected payload shape");
        for (const p of list.filter((x) => x && (x.status === "printing" || x.status === "paused"))) {
          const pct = typeof p.progress === "number" ? p.progress + "%" : "?";
          process.stdout.write(`${p.name || p.id}: ${p.status} ${pct} — ${p.currentJob || p.job || "unnamed job"}\n`);
        }
      })
      .catch(() => {});
  ' 2>/dev/null || true)"
  [ -n "$out" ] || return 0
  printf '%s\n' "$out" | sed 's/^/        · /'
}

# The gate itself, so deploy and rollback enforce IDENTICAL rules.
# $1 = what is about to happen, for the message.
#
# Returns 0 to proceed, 1 when prints are in flight, 2 when the state could not
# be determined. It NEVER exits: "a printer is busy" is an expected, correct
# outcome of a healthy farm, and the caller is the only thing that knows whether
# that means DEFERRED (a deploy that can simply be re-run) or a refusal (a
# rollback the operator asked for explicitly).
enforce_active_print_gate() {
  local what="$1" active
  active="$(count_active_prints)"
  if [ "$active" = "unknown" ]; then
    if [ "$ALLOW_ACTIVE_PRINTS" -eq 1 ]; then
      warn "could not determine whether prints are in flight — proceeding on --allow-active-prints"
      return 0
    fi
    # "Unknown" fails CLOSED, with one carve-out that is not a loophole but the
    # whole point of the gate stated precisely.
    #
    # This gate protects the orchestrator's observation of a running print. An
    # orchestrator that is itself down or unhealthy is observing nothing — it has
    # already lost whatever the gate exists to preserve, and recreating it cannot
    # make that worse. Without this carve-out the rule became a deadlock in the
    # one situation that needs a rollback most: a new image that cannot start
    # takes the API and the DB reader down with it, so the state is unknowABLE,
    # so the automatic rollback refuses, so the farm stays down. Observed
    # exactly that way during testing.
    local o_state o_status o_health
    o_state="$(container_state "$(container_id print-orchestrator)")"
    o_status="$(awk '{print $1}' <<<"$o_state")"
    o_health="$(awk '{print $2}' <<<"$o_state")"
    if [ "$o_status" != "running" ] || { [ "$o_health" != "none" ] && [ "$o_health" != "healthy" ]; }; then
      warn "active-print state is unknown because the orchestrator is ${o_status}/${o_health} — it is tracking nothing, so this gate has nothing left to protect"
      return 0
    fi
    err "could not determine whether any prints are in flight"
    cat >&2 <<'EOF'

      The orchestrator is up and healthy but answered neither the direct API nor
      the dashboard proxy, so this is NOT the same as "no prints are running".

      Check the farm, then re-run. To override deliberately:
        ./scripts/deploy.sh --allow-active-prints
EOF
    return 2
  fi
  if [ "$active" -gt 0 ] && [ "$ALLOW_ACTIVE_PRINTS" -eq 0 ]; then
    err "${active} print(s) in flight and ${what}"
    describe_active_prints >&2
    cat >&2 <<'EOF'

      The printers are NOT touched by a deploy — they keep printing either way.
      What a recreate costs is orchestrator-side observation of those runs.

      Durable state is safe: the queue, the event feed, today's counters, the
      canonical PrintRun rows and their AMS baselines all live on the
      orchestrator-data volume. On restart the poller re-adopts the canonical
      run for any printer it finds mid-print (hydrateRunFromCanonical), so run
      id, start time and filament baseline survive — filament auto-deduction and
      the duration metric still happen.

      What is genuinely at risk is narrower, and it is why this gate still
      exists:
        · a print with NO canonical PrintRun row (started on the printer itself,
          not dispatched through the queue) has no identity to re-adopt;
        · a completion that lands inside the restart window is observed by
          neither the old process nor the new one;
        · a Bambu run adopted without a persisted AMS baseline deducts nothing
          until the next full AMS report.
EOF
    return 1
  fi
  if [ "$active" -eq 0 ]; then
    ok "no prints in flight"
  else
    warn "${active} print(s) in flight — proceeding on --allow-active-prints"
    describe_active_prints >&2
  fi
  return 0
}

# A deploy that built everything and then deliberately did not swap is NOT a
# failure — it is a decision the script made on the operator's behalf, and it
# needs its own terminal state and its own exit code. Reporting it as
# "Deployment failed" trains operators to ignore real failures.
deploy_deferred() {
  local reason="$1" svc
  printf '\n%s◐ DEPLOY DEFERRED — nothing was swapped%s\n' "$C_YELLOW$C_BOLD" "$C_RESET" >&2
  printf '%s  reason: %s%s\n\n' "$C_YELLOW" "$reason" "$C_RESET" >&2
  printf '      BUILT    : %s\n' "${GIT_COMMIT:0:12} — images are tagged :latest and ready" >&2
  printf '      APPLIED  : nothing — every running container is untouched\n' >&2
  printf '      RUNNING  :\n' >&2
  while read -r svc; do
    [ -n "$svc" ] || continue
    printf '                 %-20s %s · %s\n' "$svc" "$(container_state "$(container_id "$svc")")" "$(running_revision "$svc")" >&2
  done < <(dc config --services)
  cat >&2 <<EOF

      The build is done and cached, so re-running costs seconds, not minutes:
        ./scripts/deploy.sh                        # once the prints have finished
        ./scripts/deploy.sh --allow-active-prints  # accept the caveats and swap now

      Exit code ${EXIT_DEFERRED} means DEFERRED (built, not applied) as opposed to
      1 = failed. Nothing needs repairing before the next attempt.
EOF
  exit "$EXIT_DEFERRED"
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
    # Read the CONTAINER, not the tag. The old code took `${img_name}:latest`
    # and called it "currently running", which is only true when the previous
    # deploy completed. After a deferred or interrupted one the tag holds an
    # image that was built but never swapped in, and re-tagging :previous from
    # it destroyed the only pointer back to what is actually serving — while
    # making the stage-4 comparison compare the new image against itself.
    img_id="$(running_image_id "$svc")"
    if [ -z "$img_id" ]; then
      detail "${svc}: no container running — first deploy"
      continue
    fi
    RUNNING_IMAGE_ID["$svc"]="$img_id"
    # :previous == "the image the container is on right now". Kept for
    # continuity, but it is NOT what rollback uses.
    docker tag "$img_id" "${img_name}:previous"
    detail "${svc}: running ${img_id:7:12} (rev $(image_revision "$img_id" | cut -c1-12), tagged ${img_name}:previous)"
    recorded=$((recorded + 1))
  done < <(buildable_services)

  [ "$recorded" -gt 0 ] || warn "nothing was running — this is a first deploy"

  # Bootstrap / repair. A host that has never completed a verified deploy under
  # this scheme has no :last-known-good — but so does a host whose recorded
  # target was pruned out from under it, and THAT case used to be invisible:
  # the old check only asked whether the state file held a value, so a state
  # file naming images that no longer exist left rollback permanently broken and
  # nothing said so until someone actually needed it.
  if [ "$recorded" -gt 0 ] && ! lkg_is_usable; then
    if stack_is_healthy; then
      # Adopt the RUNNING containers, not :latest — at this point :latest may be
      # an unverified image left behind by a deferred deploy, and blessing that
      # as the rollback target would be exactly backwards.
      adopt_last_known_good "the currently running, healthy stack" running
    else
      warn "no usable last-known-good and the running stack is not healthy — rollback is unavailable until a deploy verifies"
    fi
  fi

  snapshot_database
}

# Does the recorded last-known-good still exist and still resolve to the id it
# was recorded as? A tag that was re-pointed, or an image that a prune removed,
# is not a rollback target — it is a promise the script cannot keep.
lkg_is_usable() {
  [ -f "$STATE_FILE" ] || return 1
  local svc img recorded actual any=0
  while read -r svc; do
    [ -n "$svc" ] || continue
    img="$(awk -F= -v k="LKG_IMAGE_$(printf '%s' "$svc" | tr '-' '_')" '$1==k{print $2}' "$STATE_FILE")"
    recorded="$(lkg_image_id "$svc")"
    [ -n "$img" ] && [ -n "$recorded" ] || return 1
    actual="$(image_id "$img")"
    [ -n "$actual" ] || return 1
    [ "$actual" = "$recorded" ] || return 1
    any=1
  done < <(buildable_services)
  [ "$any" -eq 1 ]
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

# Bless a set of images as the thing a rollback returns to. Called ONLY after
# full verification, or once at bootstrap/repair for an already-healthy stack.
#
# $1 = why, for the state file and the log.
# $2 = source: "latest" (default — the build this deploy just verified) or
#      "running" (the images the containers are actually on). The distinction
#      matters: at bootstrap time :latest can be an unverified image a deferred
#      deploy left behind, and blessing that would make "last known good" mean
#      "never known to work at all".
adopt_last_known_good() {
  local why="$1" source="${2:-latest}" svc img_name img_id tmp blessed_rev=""
  tmp="${STATE_FILE}.tmp"

  # Resolve every id BEFORE writing anything, so a half-written state file can
  # never replace a good one.
  local -A blessed=()
  while read -r svc; do
    [ -n "$svc" ] || continue
    img_name="$(service_image_name "$svc")"
    if [ "$source" = "running" ]; then
      img_id="$(running_image_id "$svc")"
    else
      img_id="$(image_id "${img_name}:latest")"
    fi
    [ -n "$img_id" ] || continue
    blessed["$svc"]="$img_id"
    [ "$svc" = "print-orchestrator" ] && blessed_rev="$(image_revision "$img_id")"
  done < <(buildable_services)

  if [ "${#blessed[@]}" -eq 0 ]; then
    warn "nothing to record as last-known-good (${why})"
    return 0
  fi

  {
    printf '# written by scripts/deploy.sh — the LAST KNOWN GOOD state a rollback returns to\n'
    printf 'LKG_AT=%s\n' "$(date -Iseconds)"
    printf 'LKG_REASON=%s\n' "$why"
    # The commit of the image being BLESSED, read from its own OCI label — not
    # `git rev-parse HEAD`, which answers "what is checked out", a different
    # question that is simply wrong whenever the tree is ahead of what runs.
    if [ -n "$blessed_rev" ]; then
      printf 'LKG_GIT_COMMIT=%s\n' "$blessed_rev"
      printf 'DEPLOYED_GIT_COMMIT=%s\n' "$blessed_rev"
    elif [ -n "$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)" ]; then
      printf 'LKG_GIT_COMMIT=%s\n' "$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
      printf 'DEPLOYED_GIT_COMMIT=%s\n' "$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
    fi
  } >"$tmp"

  for svc in "${!blessed[@]}"; do
    img_name="$(service_image_name "$svc")"
    img_id="${blessed[$svc]}"
    docker tag "$img_id" "${img_name}:last-known-good"
    {
      printf 'LKG_IMAGE_%s=%s\n'    "$(printf '%s' "$svc" | tr '-' '_')" "${img_name}:last-known-good"
      printf 'LKG_IMAGE_ID_%s=%s\n' "$(printf '%s' "$svc" | tr '-' '_')" "$img_id"
      printf 'PREV_IMAGE_%s=%s\n'    "$(printf '%s' "$svc" | tr '-' '_')" "${img_name}:last-known-good"
      printf 'PREV_IMAGE_ID_%s=%s\n' "$(printf '%s' "$svc" | tr '-' '_')" "$img_id"
    } >>"$tmp"
    ok "${svc}: last-known-good ← ${img_id:7:12}"
  done

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
    # `|| true` on every one: an unborn HEAD makes these exit 128, which under
    # `set -e` would abort the deploy at the point where it was merely trying to
    # LABEL the image. A missing label is a cosmetic loss; an aborted deploy is
    # not. Note that `rev-parse HEAD` also PRINTS the literal string "HEAD" on
    # failure, so the emptiness check has to come after, not instead.
    GIT_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
    BUILD_TIME="$(git -C "$REPO_ROOT" show -s --format=%cI HEAD 2>/dev/null || true)"
    case "$GIT_COMMIT" in
      [0-9a-f][0-9a-f]*) ;;
      *) GIT_COMMIT=""; BUILD_TIME="" ;;
    esac
    if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null || true)" ]; then GIT_DIRTY=1; else GIT_DIRTY=0; fi
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
# Flips to 1 the moment `docker compose up` is invoked. Before that, "nothing was
# stopped" is a guarantee this script can make; after it, it is a guess.
SWAP_ATTEMPTED=0
declare -A BASELINE_RESTARTS=()

start_services() {
  stage "Starting updated services"

  # Which services will compose ACTUALLY recreate, and is the change real?
  #
  # Two separate questions, and the old code answered neither cleanly. It
  # compared the tag as it stood before the build against the tag after it —
  # "did this build produce something different" — which is not the same as
  # "does the running container need replacing". They diverge after any deploy
  # that built without swapping: the tag already holds the new image, so the
  # comparison sees no change, skips the active-print gate, and then `up -d`
  # recreates the orchestrator anyway because the CONTAINER is still on the old
  # image. The gate silently disarmed itself in exactly the situation it was
  # written for.
  #
  # So: compare against the running container.
  #   * recreate? -> new image id != the id the container is on. This is
  #     literally compose's own rule, so the script cannot disagree with it.
  #   * real change? -> rootfs layers differ. Identical layers with a different
  #     id is build metadata only (an OCI label moving with the commit), and
  #     recreating for that is pure cost.
  local svc img_name new_id new_fs run_id run_fs orchestrator_changed=0
  while read -r svc; do
    [ -n "$svc" ] || continue
    img_name="$(service_image_name "$svc")"
    new_id="$(image_id "${img_name}:latest")"
    [ -n "$new_id" ] || new_id="$(image_id "$img_name")"
    run_id="${RUNNING_IMAGE_ID[$svc]:-}"

    if [ -z "$new_id" ]; then
      warn "${svc}: no image resolved after the build — leaving the decision to compose"
      continue
    fi
    if [ -z "$run_id" ]; then
      # Nothing is running for this service, so nothing can be disturbed by
      # starting it. Deliberately does NOT arm the gate: with no orchestrator up
      # there is no API and no DB to ask, `count_active_prints` correctly answers
      # "unknown", and a first deploy (or a deploy after a manual `compose down`)
      # would be blocked by a check that has nothing to protect.
      IMAGES_CHANGED=$((IMAGES_CHANGED + 1))
      ok "${svc}: not running — will be started from ${new_id:7:12}"
      continue
    fi
    if [ "$new_id" = "$run_id" ]; then
      detail "${svc}: already running ${run_id:7:12} — compose recreates it only if its config changed"
      continue
    fi

    new_fs="$(rootfs_of "${img_name}:latest")"
    run_fs="$(rootfs_of "$run_id")"
    if [ -n "$run_fs" ] && [ "$new_fs" = "$run_fs" ]; then
      # AT-004: THE decision must be made once, not twice by different rules.
      # This script compares rootfs layers; `docker compose up` compares image
      # IDs. When they disagree the script would conclude "unchanged" and skip
      # the gate while compose still recreated the container — killing run
      # identity mid-print, the exact thing the gate exists to prevent.
      #
      # Rather than hoping they agree, make the two views identical: move the
      # tag back onto the byte-identical image compose is already running.
      # After this compose sees literally the same image id and cannot recreate
      # the container, whatever provenance settings are in play.
      warn "${svc}: image id changed but the filesystem is identical (build metadata only)"
      docker tag "$run_id" "${img_name}:latest"
      detail "${svc}: ${img_name}:latest re-pointed at the running image ${run_id:7:12} so compose sees no change"
      continue
    fi

    IMAGES_CHANGED=$((IMAGES_CHANGED + 1))
    ok "${svc}: new image ${new_id:7:12} (running ${run_id:7:12}) — filesystem changed"
    [ "$svc" = "print-orchestrator" ] && orchestrator_changed=1
  done < <(buildable_services)

  # The active-print gate fires HERE, with FRESHLY READ data, not in preflight:
  # a production-orca build takes minutes, and a night-scheduled print can start
  # inside that window. Re-reading turns a build-length race into a seconds-long
  # one. An idempotent re-run with unchanged images never reaches this point.
  #
  # It is armed ONLY for an orchestrator recreate. A dashboard-only or
  # go2rtc-only change cannot disturb a print — nothing in this stack observes a
  # printer except the orchestrator — so a busy farm must not block it, and
  # does not.
  if [ "$orchestrator_changed" -eq 1 ] && [ -z "${RUNNING_IMAGE_ID[print-orchestrator]:-}" ]; then
    # Belt and braces: the loop above already declines to arm the gate for a
    # service that is not up, but keep the invariant stated where it is read.
    orchestrator_changed=0
    detail "orchestrator is not running — nothing to disturb, no active-print gate"
  fi
  if [ "$orchestrator_changed" -eq 1 ]; then
    info "re-checking prints in flight immediately before the swap"
    local gate_rc=0
    enforce_active_print_gate "the orchestrator image changed" || gate_rc=$?
    case "$gate_rc" in
      0) ;;
      1) deploy_deferred "${IMAGES_CHANGED} image(s) built, but a print is in flight and the orchestrator would be recreated" ;;
      *) deploy_deferred "${IMAGES_CHANGED} image(s) built, but the active-print state could not be determined" ;;
    esac
  else
    detail "the orchestrator will not be recreated — no active-print gate needed"
  fi

  if [ "$IMAGES_CHANGED" -eq 0 ]; then
    detail "no service image changed — 'up -d' will reconcile configuration only"
  fi

  # Baseline restart counters so a crash loop after the swap is distinguishable
  # from a container that was already flapping.
  while read -r svc; do
    [ -n "$svc" ] || continue
    BASELINE_RESTARTS["$svc"]="$(container_state "$(container_id "$svc")" | awk '{print $3}')"
  done < <(dc config --services)

  # --no-build: the images are already built and verified above; an implicit
  # rebuild here would be an unguarded second build.
  #
  # From this line on, containers may have been REPLACED. Everything downstream
  # (including the ERR trap's wording) has to stop claiming the old stack is
  # still serving.
  SWAP_ATTEMPTED=1
  local up_rc=0
  dc up -d --no-build || up_rc=$?
  if [ "$up_rc" -ne 0 ]; then
    # `up` does not only fail before touching anything. print-dashboard declares
    # `depends_on: print-orchestrator: condition: service_healthy`, so when a new
    # orchestrator image cannot become healthy compose recreates it, waits, and
    # THEN exits non-zero with "dependency failed to start". The old container is
    # already gone at that point.
    #
    # This used to reach the ERR trap, which printed "the previous stack was left
    # as-is" — false — and exited without ever consulting --rollback-on-failure.
    # The single loudest "this image does not work" was the one failure mode that
    # could not trigger an automatic rollback.
    err "docker compose up -d failed (exit ${up_rc}) — containers may already have been replaced"
    dump_failure print-orchestrator
    handle_verification_failure "docker compose up -d failed (exit ${up_rc})"
  fi
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
          dump_failure "$svc"
          # Route through handle_verification_failure, NOT die. These two are
          # the LOUDEST possible "the new image does not work", and they used to
          # be the only post-swap failures that ignored --rollback-on-failure
          # outright: an operator who asked for an automatic rollback got one
          # for a slow healthcheck but not for a container that could not start
          # at all — precisely backwards.
          handle_verification_failure "${svc} exited during startup (${status})" ;;
      esac
      if [ "$restarts" -gt $(( ${BASELINE_RESTARTS[$svc]:-0} + 2 )) ]; then
        err "${svc} is crash-looping (restart count ${restarts})"
        dump_failure "$svc"
        handle_verification_failure "${svc} is restarting repeatedly (restart count ${restarts})"
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
  port="$(awk -F: 'NF{print $NF}' <<<"$mapping" | head -1)"
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

# ── Stage 7: deployed identity ──────────────────────────────────────────────
# `docker compose up` exiting 0 and a green healthcheck prove the stack STARTED.
# They do not prove it started the thing this deploy built. A tag that failed to
# move, a container compose declined to recreate, a service still on yesterday's
# image behind a perfectly healthy nginx — all of those pass stages 5 and 6.
#
# So close the loop explicitly: git commit -> built image -> running container.
verify_deployed_identity() {
  stage "Verifying deployed identity (commit → image → container)"
  local svc img_name expected actual rev failures=0

  for svc in $(buildable_services); do
    img_name="$(service_image_name "$svc")"
    expected="$(image_id "${img_name}:latest")"
    actual="$(running_image_id "$svc")"
    rev="$(image_revision "$actual")"

    if [ -z "$actual" ]; then
      err "${svc}: no container running"; failures=$((failures + 1)); continue
    fi
    if [ -n "$expected" ] && [ "$expected" != "$actual" ]; then
      err "${svc}: container runs ${actual:7:12} but ${img_name}:latest is ${expected:7:12}"
      failures=$((failures + 1)); continue
    fi
    if [ -n "$GIT_COMMIT" ] && [ -n "$rev" ] && [ "$rev" != "$GIT_COMMIT" ]; then
      # Not fatal on its own: an unchanged service legitimately keeps serving an
      # older image when this commit did not touch it. Say which, and why.
      warn "${svc}: running revision ${rev:0:12}, built from ${GIT_COMMIT:0:12} (image unchanged by this commit)"
      ok "${svc}: ${actual:7:12} — matches ${img_name}:latest"
      continue
    fi
    if [ "${GIT_DIRTY:-0}" = "1" ]; then
      ok "${svc}: ${actual:7:12} · rev ${rev:0:12} (built from a DIRTY tree)"
    else
      ok "${svc}: ${actual:7:12} · rev ${rev:0:12}"
    fi
  done

  # Persistent state must still be attached, and queue.db must still be
  # readable through the new binary. A deploy that came up healthy on an EMPTY
  # volume (a mount typo recreating it) also answers /health with 200.
  local cid vol_ok=0
  cid="$(container_id print-orchestrator)"
  if [ -n "$cid" ]; then
    if docker inspect "$cid" --format '{{range .Mounts}}{{.Name}} {{end}}' 2>/dev/null \
         | grep -q "$(compose_project)_orchestrator-data"; then
      ok "persistent volume $(compose_project)_orchestrator-data is mounted"
      vol_ok=1
    else
      err "persistent volume $(compose_project)_orchestrator-data is NOT mounted"
      failures=$((failures + 1))
    fi
  fi
  if [ "$vol_ok" -eq 1 ]; then
    local counts
    counts="$(docker exec -i "$cid" node --experimental-sqlite -e '
      try {
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync("/app/data/queue.db", { readOnly: true });
        const q = db.prepare("SELECT COUNT(*) n FROM queue_entries").get().n;
        const r = db.prepare("SELECT COUNT(*) n FROM print_runs").get().n;
        const p = db.prepare("SELECT COUNT(*) n FROM printers").get().n;
        process.stdout.write(`OK queue=${q} runs=${r} printers=${p}`);
      } catch (e) { process.stdout.write("ERROR=" + e.message); }
    ' 2>/dev/null || true)"
    case "$counts" in
      OK*) ok "queue.db readable through the new image (${counts#OK })" ;;
      *)   err "queue.db is not readable through the new image (${counts:-no answer})"
           failures=$((failures + 1)) ;;
    esac
  fi

  if [ "$failures" -gt 0 ]; then
    handle_verification_failure "${failures} deployed-identity check(s) failed — the running stack is not what this deploy built"
  fi
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

  # Prove the target exists BEFORE touching anything — including before asking
  # about prints. Discovering that the rollback is impossible only after the
  # per-service loop has already re-tagged some of them is how a rollback turns
  # a bad deploy into a mixed stack.
  if ! lkg_is_usable; then
    err "the recorded last-known-good is not usable"
    while read -r svc; do
      [ -n "$svc" ] || continue
      img="$(awk -F= -v k="LKG_IMAGE_$(printf '%s' "$svc" | tr '-' '_')" '$1==k{print $2}' "$STATE_FILE")"
      recorded_id="$(lkg_image_id "$svc")"
      actual_id="$(image_id "${img:-/nonexistent}")"
      if [ -z "$img" ] || [ -z "$recorded_id" ]; then
        detail "${svc}: nothing recorded"
      elif [ -z "$actual_id" ]; then
        detail "${svc}: ${img} (${recorded_id:7:12}) no longer exists — pruned?"
      elif [ "$actual_id" != "$recorded_id" ]; then
        detail "${svc}: ${img} now resolves to ${actual_id:7:12}, recorded ${recorded_id:7:12} — re-tagged behind our back"
      fi
    done < <(buildable_services)
    cat >&2 <<EOF

      Nothing was changed. Recover deliberately instead:

        ./scripts/deploy.sh status                          # what is running now
        docker images atelier-print-orchestrator            # what images remain
        ls -t ${DB_SNAPSHOT_DIR}/                           # pre-deploy snapshots
        ./ops/backup/restore.sh --set <set> --to-production --i-mean-it

      A successful ./scripts/deploy.sh records a fresh last-known-good, and so
      does any run that finds the stack healthy with no usable target recorded.
EOF
    printf '\n%s✗ ROLLBACK FAILED: no usable last-known-good images%s\n' "$C_RED$C_BOLD" "$C_RESET" >&2
    exit 1
  fi

  # AT-005(b): rollback recreates containers exactly like a deploy does, so it
  # needs the same protection. It previously had none at all. Unlike a deploy
  # this is not deferrable — the operator asked for it explicitly — so a busy
  # farm is a refusal, not a DEFERRED state.
  info "checking prints in flight before rolling back"
  local gate_rc=0
  enforce_active_print_gate "a rollback would recreate the orchestrator" || gate_rc=$?
  if [ "$gate_rc" -ne 0 ]; then
    # A refusal is not a failure: nothing was attempted, nothing is broken.
    FAILURE_LABEL="ROLLBACK REFUSED"
    if [ "$gate_rc" -eq 2 ]; then
      die "active-print state unknown — nothing was changed (override with --allow-active-prints)"
    fi
    die "prints in flight — nothing was changed (override with --allow-active-prints)"
  fi

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
    printf '\n%s✗ ROLLBACK FAILED%s — the last-known-good images did not come up healthy\n' \
      "$C_RED$C_BOLD" "$C_RESET" >&2
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

  printf '\n%s✓ ROLLBACK SUCCESS%s — last-known-good images are running, healthy and answering\n' \
    "$C_GREEN$C_BOLD" "$C_RESET"
  info "note: the working tree is still at the NEW code — rollback restores the running"
  info "      containers, not the checkout. Re-deploy once the failure is fixed."
  dc ps --format 'table {{.Service}}\t{{.Status}}' | sed 's/^/        /'
}

# Health + HTTP, reusing the same checks a deploy runs. Returns non-zero instead
# of dying so do_rollback can report ROLLBACK FAILED itself.
ROLLBACK_IN_PROGRESS=0
rollback_verify() {
  local saved_stage_no="$STAGE_NO" saved_total="$TOTAL_STAGES"
  TOTAL_STAGES=$((STAGE_NO + 3))
  # Each runs in a subshell so its `die` cannot kill the rollback report — which
  # also means each gets its OWN copy of STAGE_NO and any increment is lost. Step
  # the parent's counter between them, or all three print the same "[5/7]".
  ( wait_for_health )            || return 1; STAGE_NO=$((STAGE_NO + 1))
  ( verify_http )                || return 1; STAGE_NO=$((STAGE_NO + 1))
  # Prove the containers are actually on the restored images. "Healthy" alone
  # would also be true if compose had declined to recreate anything and the
  # broken build were still serving.
  ( verify_deployed_identity )   || return 1
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
    info "safe reclaim: untagged images + build cache trimmed to ${BUILD_CACHE_MAX_GB} GB (the warm top is kept)"
    # Evicts least-recently-used cache records until the total fits the ceiling,
    # so the layers the NEXT build needs survive while the cache stops growing
    # without bound. Unlike `-a` this never forces a cold build.
    docker builder prune -f --max-used-space "${BUILD_CACHE_MAX_GB}GB" | tail -1 | sed 's/^/        /'
  fi
  docker image prune -f | sed 's/^/        /'

  after="$(free_mb "$fs")"
  ok "free space on ${fs}: ${before} MB → ${after} MB (+$((after - before)) MB)"
  if [ "$mode" != "cache" ]; then
    detail "build cache trimmed to the ${BUILD_CACHE_MAX_GB} GB ceiling; to drop it entirely: ./scripts/deploy.sh reclaim --cache"
    docker system df | awk '/Build Cache/ {print "        build cache still held: " $5}'
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
    # The state file is a record, not a guarantee. An image it names can be
    # pruned or re-tagged at any time, and printing the record alone told the
    # operator a rollback was available when it was not.
    if lkg_is_usable; then
      printf '\n  %s✓ rollback target verified — every recorded image still resolves to its recorded id%s\n' \
        "$C_GREEN" "$C_RESET"
    else
      printf '\n  %s✗ ROLLBACK UNAVAILABLE — the recorded images no longer resolve (pruned or re-tagged)%s\n' \
        "$C_RED$C_BOLD" "$C_RESET"
      printf '    the next ./scripts/deploy.sh re-adopts the running stack if it is healthy\n'
    fi
  else
    printf '\n  %sno rollback target recorded yet (%s absent)%s\n' "$C_YELLOW" "$STATE_FILE" "$C_RESET"
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
# ON by default. Leaving it off is what let 6.99 GB of build cache and 2.9 GB of
# untagged images accumulate: every deploy orphans the images it replaces and
# appends to a cache nothing ever trims. --no-cleanup restores the old behaviour.
CLEANUP=1
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
    --no-cleanup)           CLEANUP=0 ;;
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
    FAILURE_LABEL="RECLAIM FAILED"
    DOCKER_FS="$(docker_root)"
    do_reclaim "$RECLAIM_MODE"
    ;;
  rollback)
    CURRENT_STAGE="rollback"
    FAILURE_LABEL="ROLLBACK FAILED"
    do_rollback
    ;;
  preflight)
    FAILURE_LABEL="PREFLIGHT FAILED"
    TOTAL_STAGES=1
    preflight
    printf '\n%s✓ Preflight passed%s — %s warning(s). Nothing was built or changed.\n' \
      "$C_GREEN$C_BOLD" "$C_RESET" "$WARNINGS"
    ;;
  deploy)
    START_TS=$SECONDS
    svc=""
    preflight
    snapshot_images
    build_images
    start_services
    wait_for_health
    verify_http
    verify_deployed_identity

    # Everything above passed: health checks AND real HTTP responses. Only now
    # is this build entitled to be the thing a rollback returns to. Doing it
    # here (rather than before the build, as the old snapshot did) is what makes
    # ":previous" mean "last version that actually worked" instead of "whatever
    # was tagged last time" — a failed deploy never touches the target, and a
    # second failed deploy cannot promote the first failure.
    if [ "$IMAGES_CHANGED" -gt 0 ]; then
      adopt_last_known_good "verified deploy at $(date -Iseconds)" latest
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
    printf '\n%s✓ DEPLOY SUCCESS%s in %ss (%s warning(s))\n' \
      "$C_GREEN$C_BOLD" "$C_RESET" "$((SECONDS - START_TS))" "$WARNINGS"
    printf '  BUILT     : %s\n' "${GIT_COMMIT:0:12}${GIT_DIRTY:+ (dirty tree)}"
    printf '  APPLIED   : %s service image(s) swapped\n' "$IMAGES_CHANGED"
    printf '  RUNNING   :\n'
    while read -r svc; do
      [ -n "$svc" ] || continue
      printf '              %-20s %s · %s\n' "$svc" "$(container_state "$(container_id "$svc")")" "$(running_revision "$svc")"
    done < <(dc config --services)
    printf '  dashboard : %s\n' "$PORT_MAP"
    printf '  roll back : ./scripts/deploy.sh rollback\n'
    if [ "$CLEANUP" -eq 0 ]; then
      printf '  %sfree build cache when disk gets tight: ./scripts/deploy.sh reclaim%s\n' "$C_DIM" "$C_RESET"
    fi
    ;;
esac
