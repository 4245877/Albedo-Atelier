#!/usr/bin/env bash
#
# Atelier — restore a backup set.
#
#   ./ops/backup/restore.sh --to-dir /tmp/atelier-restore-test        # rehearsal (default)
#   ./ops/backup/restore.sh --set <dir> --to-dir <dir>
#   ./ops/backup/restore.sh --set <dir> --to-volume atelier_restore_test
#   ./ops/backup/restore.sh --set <dir> --to-production               # requires --i-mean-it
#
# The default target is a scratch DIRECTORY, never the live volume. Restoring
# over production is a separate, explicitly-flagged mode that refuses to run
# while the orchestrator is up — a half-replaced queue.db under a live writer is
# how a bad day becomes an unrecoverable one.

BACKUP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=ops/backup/config.sh
. "${BACKUP_DIR}/config.sh"

SET_DIR=""
TO_DIR=""
TO_VOLUME=""
TO_PRODUCTION=0
I_MEAN_IT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --set)           SET_DIR="${2:?--set needs a directory}"; shift ;;
    --to-dir)        TO_DIR="${2:?--to-dir needs a path}"; shift ;;
    --to-volume)     TO_VOLUME="${2:?--to-volume needs a name}"; shift ;;
    --to-production) TO_PRODUCTION=1 ;;
    --i-mean-it)     I_MEAN_IT=1 ;;
    -h|--help) sed -n '3,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

if [ -z "$SET_DIR" ]; then
  resolve_backup_root
  SET_DIR="$(readlink -f "${BACKUP_ROOT_RESOLVED}/latest-full" 2>/dev/null || true)"
  [ -n "$SET_DIR" ] || die "no --set given and no latest-full symlink under ${BACKUP_ROOT_RESOLVED}"
fi
[ -d "$SET_DIR" ] || die "no such backup set: ${SET_DIR}"

log "restoring from ${SET_DIR}"
"${BACKUP_DIR}/verify.sh" "$SET_DIR" || die "refusing to restore a set that does not verify"

# ── target selection ────────────────────────────────────────────────────────
if [ "$TO_PRODUCTION" -eq 1 ]; then
  [ "$I_MEAN_IT" -eq 1 ] || die "--to-production also requires --i-mean-it (this overwrites live data)"
  container_running && die "orchestrator is RUNNING — stop it first: docker compose stop print-orchestrator"
  TO_VOLUME="$ORCHESTRATOR_VOLUME"
  warn "restoring over PRODUCTION volume ${TO_VOLUME}"
elif [ -n "$TO_VOLUME" ]; then
  [ "$TO_VOLUME" != "$ORCHESTRATOR_VOLUME" ] ||
    die "refusing to write the production volume without --to-production --i-mean-it"
else
  [ -n "$TO_DIR" ] || TO_DIR="/tmp/atelier-restore-$(date -u +%Y%m%dT%H%M%SZ)"
fi

restore_payload() { # $1 = destination directory
  local dest="$1"
  mkdir -p "$dest"
  cp -a "${SET_DIR}/queue.db" "${dest}/queue.db"
  if [ -f "${SET_DIR}/state.json" ]; then cp -a "${SET_DIR}/state.json" "${dest}/state.json"; fi
  if [ -d "${SET_DIR}/artifacts" ];  then cp -a "${SET_DIR}/artifacts"  "${dest}/artifacts";  fi
  if [ -d "${SET_DIR}/snapshots" ];  then cp -a "${SET_DIR}/snapshots"  "${dest}/snapshots";  fi
  # A restored database must come back WITHOUT stale sidecars: the snapshot is
  # fully checkpointed, so any -wal/-shm found next to it would be from another
  # database entirely.
  rm -f "${dest}/queue.db-wal" "${dest}/queue.db-shm"
  return 0
}

if [ -n "$TO_DIR" ]; then
  if [ -e "$TO_DIR" ] && [ -n "$(ls -A "$TO_DIR" 2>/dev/null)" ]; then die "target ${TO_DIR} exists and is not empty"; fi
  restore_payload "$TO_DIR"
  chmod 0700 "$TO_DIR"
  ok "restored into ${TO_DIR}"
  printf '\n'
  log "secrets were NOT copied automatically; if you need them:"
  log "  cp ${SET_DIR}/secrets/atelier.env  <target>/.env    # 0600"
  printf '\n'
  log "next: verify the restored copy"
  log "  ./ops/backup/verify.sh ${SET_DIR}"
else
  docker volume inspect "$TO_VOLUME" >/dev/null 2>&1 || docker volume create "$TO_VOLUME" >/dev/null
  STAGE="$(mktemp -d)"
  restore_payload "$STAGE"
  restore_image="$(docker inspect -f '{{.Config.Image}}' "$ORCHESTRATOR_CONTAINER" 2>/dev/null || echo "${COMPOSE_PROJECT}-print-orchestrator:latest")"
  docker run --rm --network none --user "$(id -u):$(id -g)" \
    -v "${TO_VOLUME}:/dest" -v "${STAGE}:/src:ro" \
    --entrypoint sh "$restore_image" -c 'rm -rf /dest/queue.db /dest/queue.db-wal /dest/queue.db-shm /dest/state.json /dest/artifacts /dest/snapshots; cp -a /src/. /dest/'
  rm -rf "$STAGE"
  ok "restored into Docker volume ${TO_VOLUME}"
  if [ "$TO_PRODUCTION" -eq 1 ]; then log "now start the orchestrator: docker compose up -d print-orchestrator"; fi
fi
