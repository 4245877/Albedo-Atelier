#!/usr/bin/env bash
#
# Shared configuration and safety guards for the Atelier backup scripts.
# Sourced by backup.sh / verify.sh / restore.sh — never executed directly.
#
# Configuration precedence: environment > ops/backup/backup.conf > defaults.

set -Eeuo pipefail

BACKUP_LIB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${BACKUP_LIB_DIR}/../.." && pwd -P)"

# ── Defaults ────────────────────────────────────────────────────────────────
# The dedicated backup disk, identified by filesystem UUID rather than by device
# name (sdb can become sdc after a reboot) or by mountpoint (a missing mount
# leaves an empty directory on the ROOT disk that looks writable and silently
# turns an off-root backup into a same-root one). When this UUID is mounted, its
# mountpoint wins over BACKUP_ROOT_FALLBACK automatically.
: "${BACKUP_DISK_UUID:=}"
# Where backups go when the dedicated disk is not mounted. Same physical disk as
# production, so it protects against Docker volume loss / operator error /
# filesystem corruption, but NOT against loss of the disk itself.
: "${BACKUP_ROOT_FALLBACK:=${HOME}/atelier-backups}"
# Explicitly force a root and skip auto-detection entirely.
: "${BACKUP_ROOT:=}"

: "${COMPOSE_PROJECT:=atelier}"
: "${ORCHESTRATOR_CONTAINER:=atelier-print-orchestrator}"
: "${ORCHESTRATOR_VOLUME:=atelier_orchestrator-data}"
: "${DATA_DIR_IN_CONTAINER:=/app/data}"

# Retention, in whole backup sets. Sized for the fallback (root-disk) case:
# a full set is ~15 MB today, so this budget is a few hundred MB. On the
# dedicated 240 GB disk these can be raised generously.
: "${RETAIN_HOURLY:=48}"    # db-only sets
: "${RETAIN_DAILY:=14}"     # full sets
: "${RETAIN_WEEKLY:=8}"     # full sets promoted from the daily line

# Refuse to write a backup that would leave the filesystem below this. A backup
# must never be the thing that fills the disk out from under a running print.
: "${BACKUP_MIN_FREE_MB:=1024}"

# ── Load the operator config file, if present ───────────────────────────────
BACKUP_CONF="${BACKUP_CONF:-${BACKUP_LIB_DIR}/backup.conf}"
if [ -f "$BACKUP_CONF" ]; then
  # shellcheck disable=SC1090
  . "$BACKUP_CONF"
fi

# ── Output ──────────────────────────────────────────────────────────────────
log()  { printf '[%s] %s\n' "$(date -Iseconds)" "$*"; }
ok()   { printf '[%s] ✓ %s\n' "$(date -Iseconds)" "$*"; }
warn() { printf '[%s] ! %s\n' "$(date -Iseconds)" "$*" >&2; }
die()  { printf '[%s] ✗ %s\n' "$(date -Iseconds)" "$*" >&2; exit 1; }

# ── Backup root resolution ──────────────────────────────────────────────────
# Sets BACKUP_ROOT_RESOLVED and BACKUP_TIER ("dedicated" | "fallback").
resolve_backup_root() {
  BACKUP_TIER="fallback"
  if [ -n "$BACKUP_ROOT" ]; then
    BACKUP_ROOT_RESOLVED="$BACKUP_ROOT"
    BACKUP_TIER="explicit"
  elif [ -n "$BACKUP_DISK_UUID" ] && [ -e "/dev/disk/by-uuid/${BACKUP_DISK_UUID}" ]; then
    local dev mp
    dev="$(readlink -f "/dev/disk/by-uuid/${BACKUP_DISK_UUID}")"
    mp="$(findmnt -n -o TARGET --source "$dev" 2>/dev/null | head -1 || true)"
    if [ -n "$mp" ]; then
      BACKUP_ROOT_RESOLVED="${mp}/atelier"
      BACKUP_TIER="dedicated"
    else
      warn "backup disk ${BACKUP_DISK_UUID} exists as ${dev} but is not mounted — falling back"
      BACKUP_ROOT_RESOLVED="$BACKUP_ROOT_FALLBACK"
    fi
  else
    BACKUP_ROOT_RESOLVED="$BACKUP_ROOT_FALLBACK"
  fi
  export BACKUP_ROOT_RESOLVED BACKUP_TIER
}

# The device backing a path, for the "is the dedicated disk really there" check
# and for the destructive-path guard.
source_device_of() { findmnt -n -o SOURCE --target "$1" 2>/dev/null | head -1 || true; }
mountpoint_of()    { findmnt -n -o TARGET --target "$1" 2>/dev/null | head -1 || true; }
free_mb_of()       { df -P -k "$1" | awk 'NR==2 {print int($4/1024)}'; }

# ── Destructive-path guard ──────────────────────────────────────────────────
# Every path this suite ever deletes from must pass this first. Retention is the
# only thing here that removes files, and a bug in the path arithmetic must not
# be able to reach outside the backup tree.
assert_safe_backup_path() {
  local p="$1" real
  [ -n "$p" ] || die "refusing to operate on an empty path"
  case "$p" in
    /|/root|/home|/usr|/etc|/var|/var/lib|/var/lib/docker|/var/lib/docker/*|/boot|/bin|/sbin|/lib|/opt|/mnt|/srv|/dev|/proc|/sys)
      die "refusing to operate on a system path: ${p}" ;;
  esac
  case "$p" in
    */atelier-backups|*/atelier-backups/*|*/atelier|*/atelier/*) ;;
    *) die "refusing to operate outside a recognised backup tree: ${p}" ;;
  esac
  real="$(readlink -f "$p" 2>/dev/null || printf '%s' "$p")"
  case "$real" in
    "$REPO_ROOT"|"$REPO_ROOT"/*) die "refusing to operate inside the git checkout: ${real}" ;;
    /var/lib/docker/*)           die "refusing to operate inside the Docker data root: ${real}" ;;
  esac
  # Depth: /a/b is the shallowest we ever accept, so a truncated variable
  # collapsing to "/" or "/mnt" cannot be handed to rm -rf.
  local depth; depth="$(printf '%s' "$real" | tr -cd '/' | wc -c)"
  [ "$depth" -ge 2 ] || die "backup path is suspiciously shallow: ${real}"
  return 0
}

# ── Orchestrator access ─────────────────────────────────────────────────────
container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$ORCHESTRATOR_CONTAINER" 2>/dev/null || echo false)" = "true" ]
}

# Run a node script against the live data directory. Prefers `docker exec` into
# the running orchestrator (cheapest, and the WAL/-shm are already mapped there);
# falls back to a throwaway container on the same volume so a backup still works
# when the farm is down — which is exactly when a backup matters most.
run_node_on_data() {
  local script="$1"; shift
  if container_running; then
    docker exec -i "$ORCHESTRATOR_CONTAINER" node --experimental-sqlite - "$@" <"$script" 2>&1 |
      grep -vE 'ExperimentalWarning|trace-warnings' || true
  else
    local image
    image="$(docker inspect -f '{{.Config.Image}}' "$ORCHESTRATOR_CONTAINER" 2>/dev/null || echo '')"
    [ -n "$image" ] || image="${COMPOSE_PROJECT}-print-orchestrator:latest"
    warn "orchestrator container is not running — using a throwaway container on ${ORCHESTRATOR_VOLUME}"
    docker run --rm -i --network none \
      -v "${ORCHESTRATOR_VOLUME}:${DATA_DIR_IN_CONTAINER}" \
      --entrypoint node "$image" --experimental-sqlite - "$@" <"$script" 2>&1 |
      grep -vE 'ExperimentalWarning|trace-warnings' || true
  fi
}
