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
#   ./scripts/deploy.sh reclaim         # free disk safely (build cache + dangling images)
#   ./scripts/deploy.sh rollback        # re-point compose at the previous images
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
MIN_FREE_MB_ORCA="${DEPLOY_MIN_FREE_MB:-4096}"
MIN_FREE_MB_LEAN="${DEPLOY_MIN_FREE_MB:-2048}"
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

# Any unhandled non-zero exit names the stage it happened in, so a failure is
# never just a bare shell error.
on_err() {
  local exit_code=$? line=$1
  printf '\n%s✗ Deployment failed during: %s%s (line %s, exit %s)\n' \
    "$C_RED$C_BOLD" "$CURRENT_STAGE" "$C_RESET$C_RED" "$line" "$exit_code" >&2
  printf '%s  The previous stack was left as-is; inspect it with: docker compose ps%s\n' "$C_RED" "$C_RESET" >&2
  exit "$exit_code"
}
trap 'on_err $LINENO' ERR

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

http_code() {
  local url="$1" body_file="$2"
  if have curl; then
    curl -sS -m 5 -o "$body_file" -w '%{http_code}' "$url" 2>/dev/null || echo 000
  else
    if wget -q -T 5 -O "$body_file" "$url" 2>/dev/null; then echo 200; else echo 000; fi
  fi
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
  if dc config | grep -q 'target: production-orca'; then
    ORCA_BUILD=1; MIN_FREE_MB="$MIN_FREE_MB_ORCA"
    ok "build target: production-orca (OrcaSlicer runtime; the heavy variant)"
  else
    ORCA_BUILD=0; MIN_FREE_MB="$MIN_FREE_MB_LEAN"
    ok "build target: production (lean image, no OrcaSlicer system libraries)"
  fi
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

      Safe ways to reclaim space (none of them touch a Docker volume, so
      queue.db and the rest of orchestrator-data are never at risk):

        ./scripts/deploy.sh reclaim     # build cache + dangling images
        docker builder prune -a         # build cache only
        docker image prune              # untagged images only
        docker logs --tail 0 …          # (container logs live under ${DOCKER_FS}/containers)

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
  ACTIVE_PRINTS="$(count_active_prints)"
  if [ "$ACTIVE_PRINTS" -gt 0 ]; then
    warn "${ACTIVE_PRINTS} printer(s) are mid-print right now"
  else
    ok "no prints in flight"
  fi
}

# Ask the *running* stack how many printers are printing/paused. Any failure
# (stack down, port closed, no HTTP client) reports 0 — this is an advisory
# gate, never a reason to block a deploy of a farm that is already offline.
count_active_prints() {
  local port url body n
  port="$(dc port "$HTTP_SERVICE" "$HTTP_CONTAINER_PORT" 2>/dev/null | awk -F: 'NF{print $NF}')" || true
  [ -n "${port:-}" ] || { echo 0; return; }
  url="http://127.0.0.1:${port}/api/print-orchestrator/api/printers"
  body="$(mktemp)"
  if [ "$(http_code "$url" "$body")" = "200" ]; then
    n="$(grep -o '"status":"\(printing\|paused\)"' "$body" | wc -l | tr -d ' ')"
  else
    n=0
  fi
  rm -f "$body"
  echo "${n:-0}"
}

# ── Stage 2: rollback snapshot ──────────────────────────────────────────────
# Tag the images the CURRENTLY RUNNING containers were started from as
# <image>:previous. Tagging (rather than relying on the soon-to-be-dangling
# image) is what makes rollback survive `docker image prune`, which only removes
# untagged images.
snapshot_images() {
  stage "Snapshotting current images for rollback"
  mkdir -p "$STATE_DIR"
  : >"${STATE_FILE}.tmp"
  {
    printf '# written by scripts/deploy.sh — the state a rollback returns to\n'
    printf 'SNAPSHOT_AT=%s\n' "$(date -Iseconds)"
    if git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
      printf 'SNAPSHOT_GIT_COMMIT=%s\n' "$(git -C "$REPO_ROOT" rev-parse HEAD)"
    fi
  } >>"${STATE_FILE}.tmp"

  # Pin the TAG compose resolves (<image>:latest), not the running container's
  # .Image digest: under the containerd image store that digest is the
  # platform-specific manifest/config digest and `docker tag` / `docker image
  # inspect` cannot resolve it ("No such image"). The tag is what the build is
  # about to overwrite, so it is also exactly what a rollback needs back.
  local svc img_id img_name tagged=0
  while read -r svc; do
    [ -n "$svc" ] || continue
    img_name="$(service_image_name "$svc")"
    img_id="$(image_id "${img_name}:latest")"
    if [ -z "$img_id" ]; then
      detail "${svc}: no ${img_name}:latest yet — nothing to snapshot"
      continue
    fi
    docker tag "${img_name}:latest" "${img_name}:previous"
    {
      printf 'PREV_IMAGE_%s=%s\n'    "$(printf '%s' "$svc" | tr '-' '_')" "${img_name}:previous"
      printf 'PREV_IMAGE_ID_%s=%s\n' "$(printf '%s' "$svc" | tr '-' '_')" "$img_id"
    } >>"${STATE_FILE}.tmp"
    ok "${svc}: ${img_id:7:12} tagged ${img_name}:previous"
    tagged=$((tagged + 1))
  done < <(buildable_services)

  mv "${STATE_FILE}.tmp" "$STATE_FILE"
  if [ "$tagged" -eq 0 ]; then
    warn "nothing was running — this is a first deploy, so there is nothing to roll back to"
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

  # Pull the non-buildable images now (go2rtc, pinned by digest) so stage 4 is a
  # purely local operation: a registry outage must not strand the swap half-way.
  if dc pull --quiet --ignore-buildable 2>/dev/null; then
    ok "remote images present locally"
  else
    warn "could not pre-pull remote images — 'up' will try again (already-present images are unaffected)"
  fi

  local watchdog_pid="" build_pid rc=0
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
  set -m
  ( set -o pipefail; dc build --provenance=false 2>&1 | tee "$BUILD_LOG" ) &
  build_pid=$!
  set +m

  if [ "${DISK_WATCHDOG:-1}" = "1" ]; then
    ( trap 'exit 0' TERM
      while kill -0 "$build_pid" 2>/dev/null; do
        sleep 5
        local_free="$(free_mb "$DOCKER_FS")"
        if [ "${local_free:-999999}" -lt "$DISK_FLOOR_MB" ]; then
          printf '\n      %s!%s disk watchdog: only %s MB left on %s — cancelling the build to protect the running containers\n' \
            "$C_YELLOW" "$C_RESET" "$local_free" "$DOCKER_FS" >&2
          kill -TERM -- "-${build_pid}" 2>/dev/null || true
          exit 0
        fi
      done ) &
    watchdog_pid=$!
    detail "disk watchdog armed: build is cancelled if free space on ${DOCKER_FS} drops below ${DISK_FLOOR_MB} MB"
  fi

  wait "$build_pid" || rc=$?
  if [ -n "$watchdog_pid" ]; then kill "$watchdog_pid" 2>/dev/null || true; wait "$watchdog_pid" 2>/dev/null || true; fi

  if [ "$rc" -ne 0 ]; then
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
  ok "all images built"
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
      detail "${svc}: image id changed but the filesystem is identical (build metadata only)"
    else
      detail "${svc}: image unchanged — compose recreates it only if its config changed"
    fi
  done < <(buildable_services)

  # The active-print gate fires here, not in preflight: an idempotent re-run
  # with unchanged images never reaches it, and by now nothing has been stopped.
  if [ "$orchestrator_changed" -eq 1 ] && [ "$ACTIVE_PRINTS" -gt 0 ] && [ "$ALLOW_ACTIVE_PRINTS" -eq 0 ]; then
    err "${ACTIVE_PRINTS} print(s) in flight and the orchestrator image changed"
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
  body="$(mktemp)"
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
  if [ "$ROLLBACK_ON_FAILURE" -eq 1 ]; then
    warn "verification failed — rolling back to the previous images"
    do_rollback
    die "${reason} (rolled back to the previous images; check the logs above)"
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

# ── rollback ────────────────────────────────────────────────────────────────
do_rollback() {
  [ -f "$STATE_FILE" ] || die "no ${STATE_FILE} — this host has no recorded previous deploy to roll back to"
  # shellcheck disable=SC1090
  local restored=0 svc var img
  while read -r svc; do
    [ -n "$svc" ] || continue
    var="PREV_IMAGE_$(printf '%s' "$svc" | tr '-' '_')"
    img="$(awk -F= -v k="$var" '$1==k{print $2}' "$STATE_FILE")"
    [ -n "$img" ] || { detail "${svc}: no recorded previous image"; continue; }
    if ! docker image inspect "$img" >/dev/null 2>&1; then
      warn "${svc}: recorded image ${img} no longer exists (pruned?) — cannot roll this service back"
      continue
    fi
    docker tag "$img" "$(service_image_name "$svc"):latest"
    ok "${svc}: restored $(service_image_name "$svc"):latest ← ${img}"
    restored=$((restored + 1))
  done < <(buildable_services)

  [ "$restored" -gt 0 ] || die "no previous images could be restored"
  dc up -d --no-build
  ok "previous images are running again"
  info "note: the working tree is still at the NEW code — rollback restores the running"
  info "      containers, not the checkout. Re-deploy once the failure is fixed."
  dc ps --format 'table {{.Service}}\t{{.Status}}' | sed 's/^/        /'
}

# ── reclaim (safe cleanup) ──────────────────────────────────────────────────
# Build cache and untagged images only. No `-a` on image prune (that would
# delete images no container currently uses, including :previous), and above
# all NO volume operations of any kind — orchestrator-data holds queue.db.
do_reclaim() {
  local fs before after
  fs="${DOCKER_FS:-$(docker_root)}"; [ -d "$fs" ] || fs="/"
  before="$(free_mb "$fs")"
  info "reclaiming build cache and dangling images (Docker volumes are never touched)"
  docker builder prune -a -f | sed 's/^/        /'
  docker image prune -f      | sed 's/^/        /'
  after="$(free_mb "$fs")"
  ok "free space on ${fs}: ${before} MB → ${after} MB (+$((after - before)) MB)"
  detail "orchestrator-data and every other volume were left untouched:"
  docker volume ls --format '        {{.Name}}' | grep orchestrator-data || true
}

# ── status ──────────────────────────────────────────────────────────────────
do_status() {
  printf '%sAtelier stack%s (project %s, %s)\n\n' "$C_BOLD" "$C_RESET" "$(compose_project)" "$REPO_ROOT"
  dc ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
  printf '\n'
  local svc
  while read -r svc; do
    [ -n "$svc" ] || continue
    printf '  %-20s %s\n' "$svc" "$(container_state "$(container_id "$svc")")"
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
COMMAND="deploy"
CLEANUP=0
ALLOW_ACTIVE_PRINTS=0
ROLLBACK_ON_FAILURE=0
SKIP_HTTP=0
DISK_WATCHDOG=1
MIN_FREE_MB_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    deploy|preflight|rollback|reclaim|status) COMMAND="$1" ;;
    --cleanup)              CLEANUP=1 ;;
    --min-free-mb)          MIN_FREE_MB_OVERRIDE="${2:?--min-free-mb needs a value}"; shift ;;
    --health-timeout)       HEALTH_TIMEOUT="${2:?--health-timeout needs a value}"; shift ;;
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
    do_reclaim
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

    if [ "$CLEANUP" -eq 1 ]; then
      printf '\n%sPost-deploy cleanup%s\n' "$C_BOLD$C_BLUE" "$C_RESET"
      do_reclaim
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
