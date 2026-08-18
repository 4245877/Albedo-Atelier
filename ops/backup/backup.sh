#!/usr/bin/env bash
#
# Atelier — create one backup set.
#
#   ./ops/backup/backup.sh --full     # queue.db + artifacts + state + secrets
#   ./ops/backup/backup.sh --db       # queue.db + state only (the hourly line)
#
# CONSISTENCY between queue.db and artifacts/ (the property that matters — a
# restored database whose rows point at blobs that were never copied is worse
# than no backup, because it looks fine):
#
#   1. queue.db is snapshotted first, with VACUUM INTO on a read-only handle.
#   2. artifacts/ is copied AFTER that snapshot.
#   3. every blob key the snapshot references is then verified to be present.
#
# Step 2 must follow step 1, not precede it. Uploads commit the blob to
# content-addressed storage (atomic rename) BEFORE inserting the row that
# references it — apps/print-orchestrator/src/app/artifacts/ingest.ts:84 vs :112
# — and committed blobs are immutable (`commit` deduplicates onto an existing
# key, never rewrites it). So every row present at step 1 already had its bytes
# on disk, and a copy taken later is a SUPERSET of what the snapshot needs.
# Artifacts created during the window are harmless extras; the reverse order
# would let the snapshot reference a blob copied too early to exist.
#
# The one hole this ordering cannot close is an operator deleting an artifact
# mid-run (DELETE /api/print/artifacts/:id or the orphan sweep — both are
# explicit API calls, there is no background sweep). Step 3 catches exactly that
# and fails the run instead of shipping a quietly broken set. This is NOT an
# atomic snapshot of the volume and is not claimed to be one.

BACKUP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=ops/backup/config.sh
. "${BACKUP_DIR}/config.sh"

MODE="full"
TIER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --full) MODE="full" ;;
    --db)   MODE="db" ;;
    --tier) TIER="${2:?--tier needs a value}"; shift ;;
    -h|--help) sed -n '3,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[ -n "$TIER" ] || { [ "$MODE" = "db" ] && TIER="hourly" || TIER="daily"; }

resolve_backup_root
ROOT="$BACKUP_ROOT_RESOLVED"
assert_safe_backup_path "$ROOT"

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
SET_DIR="${ROOT}/sets/${TIER}/${STAMP}"
INCOMPLETE="${SET_DIR}.incomplete"

log "Atelier backup: mode=${MODE} tier=${TIER} root=${ROOT} (${BACKUP_TIER})"
if [ "$BACKUP_TIER" != "dedicated" ]; then
  warn "DEGRADED: backups are on the same physical disk as production."
  warn "  Protects against: Docker volume loss, operator error, filesystem corruption in the volume."
  warn "  Does NOT protect against: loss of this disk, host death, theft, fire, ransomware."
fi

mkdir -p "$ROOT"; chmod 0700 "$ROOT"
mkdir -p "${ROOT}/sets"

FREE_MB="$(free_mb_of "$ROOT")"
[ "$FREE_MB" -ge "$BACKUP_MIN_FREE_MB" ] ||
  die "only ${FREE_MB} MB free on ${ROOT} (floor ${BACKUP_MIN_FREE_MB} MB) — refusing to back up onto a nearly full filesystem"

# ── Everything from here is torn down on any failure ────────────────────────
# NOTE: this must never delete anything when it fires inside a command
# substitution. With `set -E` an ERR trap is inherited by subshells, and an
# `exit` there only ends the subshell — so a naive cleanup would wipe the
# half-built set and let the parent carry on believing it still existed.
# Guarding on BASHPID == $$ keeps teardown in the main shell only.
MAIN_SHELL_PID=$$
cleanup_incomplete() {
  local rc=$?
  [ "$BASHPID" = "$MAIN_SHELL_PID" ] || return "$rc"
  if [ -d "$INCOMPLETE" ]; then
    assert_safe_backup_path "$INCOMPLETE" && rm -rf "$INCOMPLETE"
  fi
  clear_staging || true
  exit "$rc"
}
clear_staging() {
  if container_running; then
    docker exec "$ORCHESTRATOR_CONTAINER" rm -rf "${DATA_DIR_IN_CONTAINER}/.backup-staging" 2>/dev/null || true
  fi
}
trap cleanup_incomplete INT TERM ERR

rm -rf "$INCOMPLETE"; mkdir -p "$INCOMPLETE"; chmod 0700 "$INCOMPLETE"

# ── 1. queue.db — consistent snapshot on the live WAL database ──────────────
log "snapshotting queue.db (VACUUM INTO, read-only handle)"
SNAP_OUT="$(run_node_on_data "${BACKUP_DIR}/snapshot-db.js")"
SNAP_JSON="$(printf '%s\n' "$SNAP_OUT" | sed -n 's/^SNAPSHOT_JSON://p' | tail -1)"
[ -n "$SNAP_JSON" ] || { printf '%s\n' "$SNAP_OUT" >&2; die "queue.db snapshot produced no metadata"; }

INTEGRITY="$(printf '%s' "$SNAP_JSON" | sed -n 's/.*"integrityCheck":"\([^"]*\)".*/\1/p')"
[ "$INTEGRITY" = "ok" ] || die "snapshot failed integrity_check: ${INTEGRITY:-<none>}"
SCHEMA_VERSION="$(printf '%s' "$SNAP_JSON" | sed -n 's/.*"schemaVersion":\([0-9]*\).*/\1/p')"
ok "queue.db snapshot: integrity=ok schema_version=${SCHEMA_VERSION}"

# ── 2. copy the data out of the volume ──────────────────────────────────────
# A throwaway container is the only way to read a named volume without root, and
# it works whether or not the orchestrator is up. The volume is mounted READ-ONLY
# and the container runs as the invoking uid, so the copied tree is owned by us
# (retention can prune it) and production cannot be written to.
copy_from_volume() {
  local image
  image="$(docker inspect -f '{{.Config.Image}}' "$ORCHESTRATOR_CONTAINER" 2>/dev/null || echo '')"
  [ -n "$image" ] || image="${COMPOSE_PROJECT}-print-orchestrator:latest"
  docker run --rm --network none --user "$(id -u):$(id -g)" \
    -v "${ORCHESTRATOR_VOLUME}:/data:ro" -v "${INCOMPLETE}:/out" \
    --entrypoint sh "$image" -c "$1"
}

log "copying data out of ${ORCHESTRATOR_VOLUME}"
if [ "$MODE" = "full" ]; then
  COPY_LIST='.backup-staging/queue.db state.json artifacts snapshots'
else
  COPY_LIST='.backup-staging/queue.db state.json'
fi
# ONE tar stream, not a concatenation: `tar -x` stops at the first
# end-of-archive marker, so piping several `tar -c` runs into a single reader
# silently extracts only the first member and drops the rest.
copy_from_volume "cd /data && set -- ; for p in ${COPY_LIST}; do [ -e \"\$p\" ] && set -- \"\$@\" \"\$p\"; done; [ \"\$#\" -gt 0 ] || exit 1; tar -cf - \"\$@\" | tar -C /out -xf -"

mv "${INCOMPLETE}/.backup-staging/queue.db" "${INCOMPLETE}/queue.db"
rmdir "${INCOMPLETE}/.backup-staging" 2>/dev/null || true
clear_staging
[ -s "${INCOMPLETE}/queue.db" ] || die "queue.db did not make it out of the volume"
ok "queue.db extracted ($(du -h "${INCOMPLETE}/queue.db" | cut -f1))"
if [ "$MODE" = "full" ]; then
  ART_FILES=0; ART_SIZE=0
  if [ -d "${INCOMPLETE}/artifacts" ]; then
    ART_FILES="$(find "${INCOMPLETE}/artifacts" -type f | wc -l | tr -d ' ')"
    ART_SIZE="$(du -sh "${INCOMPLETE}/artifacts" | cut -f1)"
  fi
  ok "artifacts: ${ART_FILES} file(s), ${ART_SIZE}"
  [ "$ART_FILES" -gt 0 ] || warn "no artifact blobs were copied — verification will catch it if the database references any"
fi

# ── 3. secrets needed to rebuild the farm ───────────────────────────────────
# .env holds the Bambu LAN access code and the API tokens; without it a restored
# queue.db cannot actually drive the printers. It is the reason this whole tree
# is 0700 and why the manifest records only names, never values.
if [ "$MODE" = "full" ] && [ -f "${REPO_ROOT}/.env" ]; then
  mkdir -p "${INCOMPLETE}/secrets"; chmod 0700 "${INCOMPLETE}/secrets"
  cp -p "${REPO_ROOT}/.env" "${INCOMPLETE}/secrets/atelier.env"
  chmod 0600 "${INCOMPLETE}/secrets/atelier.env"
  ok "secrets: .env captured (0600, values never logged)"
fi
for f in go2rtc.yaml config/printers.json; do
  if [ "$MODE" = "full" ] && [ -f "${REPO_ROOT}/${f}" ]; then
    mkdir -p "${INCOMPLETE}/repo/$(dirname "$f")"
    cp -p "${REPO_ROOT}/${f}" "${INCOMPLETE}/repo/${f}"
  fi
done

# ── 4. manifest ─────────────────────────────────────────────────────────────
GIT_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
GIT_DIRTY="$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
SET_BYTES="$(du -sb "$INCOMPLETE" | cut -f1)"
{
  printf '{\n'
  printf '  "createdAt": "%s",\n' "$(date -Iseconds)"
  printf '  "mode": "%s",\n  "tier": "%s",\n' "$MODE" "$TIER"
  printf '  "hostname": "%s",\n' "$(hostname)"
  printf '  "backupTier": "%s",\n' "$BACKUP_TIER"
  printf '  "gitCommit": "%s",\n  "gitDirtyFiles": %s,\n' "$GIT_COMMIT" "${GIT_DIRTY:-0}"
  printf '  "orchestratorImage": "%s",\n' "$(docker inspect -f '{{.Image}}' "$ORCHESTRATOR_CONTAINER" 2>/dev/null || echo unknown)"
  printf '  "sizeBytes": %s,\n' "$SET_BYTES"
  printf '  "contents": [%s],\n' "$(cd "$INCOMPLETE" && find . -maxdepth 1 -mindepth 1 -printf '"%f",' | sed 's/,$//')"
  printf '  "secretsIncluded": %s,\n' "$([ -f "${INCOMPLETE}/secrets/atelier.env" ] && echo true || echo false)"
  printf '  "database": %s\n' "$SNAP_JSON"
  printf '}\n'
} >"${INCOMPLETE}/manifest.json"
chmod 0600 "${INCOMPLETE}/manifest.json"

# ── 5. verify before publishing the set ─────────────────────────────────────
log "verifying the set before publishing it"
if ! "${BACKUP_DIR}/verify.sh" "$INCOMPLETE"; then
  die "verification failed — the set was NOT published"
fi

trap - INT TERM ERR
mv "$INCOMPLETE" "$SET_DIR"
ln -sfn "$SET_DIR" "${ROOT}/latest-${TIER}"
if [ "$MODE" = "full" ]; then ln -sfn "$SET_DIR" "${ROOT}/latest-full"; fi
ok "published ${SET_DIR} ($(du -sh "$SET_DIR" | cut -f1))"

# ── 6. retention (only ever inside this tier's directory) ───────────────────
prune_tier() {
  # Separate declarations: under `set -u` a later initialiser in the same
  # `local` statement cannot rely on an earlier one in the same statement.
  local tier="$1"
  local keep="$2"
  local dir="${ROOT}/sets/${tier}"
  local n victim
  [ -d "$dir" ] || return 0
  assert_safe_backup_path "$dir"
  n="$(find "$dir" -mindepth 1 -maxdepth 1 -type d -name '20*' | wc -l)"
  [ "$n" -gt "$keep" ] || { log "retention ${tier}: ${n}/${keep} sets, nothing to prune"; return 0; }
  while [ "$n" -gt "$keep" ]; do
    victim="$(find "$dir" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort | head -1)"
    [ -n "$victim" ] || break
    assert_safe_backup_path "$victim"
    rm -rf "$victim"
    log "retention ${tier}: pruned $(basename "$victim")"
    n=$((n - 1))
  done
}
# Promote the first full set of an ISO week into the weekly line before pruning
# the daily line, so a long-lived copy survives the 14-day daily window.
if [ "$MODE" = "full" ]; then
  WEEK_TAG="$(date -u +%G-W%V)"
  if [ ! -d "${ROOT}/sets/weekly/${WEEK_TAG}" ]; then
    mkdir -p "${ROOT}/sets/weekly"
    cp -al "$SET_DIR" "${ROOT}/sets/weekly/${WEEK_TAG}" 2>/dev/null ||
      cp -a "$SET_DIR" "${ROOT}/sets/weekly/${WEEK_TAG}"
    ok "promoted to weekly/${WEEK_TAG}"
  fi
fi
prune_tier hourly "$RETAIN_HOURLY"
prune_tier daily  "$RETAIN_DAILY"
prune_tier weekly "$RETAIN_WEEKLY"

log "backup root now $(du -sh "$ROOT" 2>/dev/null | cut -f1), ${FREE_MB} MB was free before this run"
ok "backup complete"
