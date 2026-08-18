#!/usr/bin/env bash
#
# Verify a backup set (or the newest full set when called with no argument).
# Creating a file is not evidence of a backup; this is what makes it evidence.
#
#   ./ops/backup/verify.sh                 # newest full set
#   ./ops/backup/verify.sh <set-dir>       # a specific set
#   ./ops/backup/verify.sh --all           # every set under the backup root

BACKUP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=ops/backup/config.sh
. "${BACKUP_DIR}/config.sh"

node_bin() {
  if command -v node >/dev/null 2>&1; then printf 'node'; return; fi
  # No node on PATH on this host; the VS Code server ships one and it is a
  # normal Node build, which is all verify-set.js needs.
  local candidate
  candidate="$(find "$HOME/.vscode-server/bin" -maxdepth 2 -name node -type f 2>/dev/null | head -1)"
  [ -n "$candidate" ] || die "no node binary found — cannot verify (install node or set PATH)"
  printf '%s' "$candidate"
}

verify_one() {
  local dir="$1"
  log "verifying $(basename "$dir")"
  "$(node_bin)" --experimental-sqlite "${BACKUP_DIR}/verify-set.js" "$dir" 2>&1 |
    grep -vE 'ExperimentalWarning|trace-warnings'
  return "${PIPESTATUS[0]}"
}

case "${1:-}" in
  --all)
    resolve_backup_root
    assert_safe_backup_path "$BACKUP_ROOT_RESOLVED"
    rc=0; n=0
    while read -r d; do
      [ -n "$d" ] || continue
      n=$((n + 1)); verify_one "$d" || rc=1
    done < <(find "${BACKUP_ROOT_RESOLVED}/sets" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | sort)
    [ "$n" -gt 0 ] || die "no backup sets found under ${BACKUP_ROOT_RESOLVED}/sets"
    if [ "$rc" -eq 0 ]; then ok "all ${n} set(s) verified"; else die "one or more sets failed verification"; fi
    ;;
  "")
    resolve_backup_root
    target="${BACKUP_ROOT_RESOLVED}/latest-full"
    [ -e "$target" ] || die "no latest-full set at ${target} — run ./ops/backup/backup.sh --full"
    verify_one "$(readlink -f "$target")" || die "verification failed"
    ok "verified"
    ;;
  *)
    [ -d "$1" ] || die "not a directory: $1"
    verify_one "$1" || exit 1
    ;;
esac
