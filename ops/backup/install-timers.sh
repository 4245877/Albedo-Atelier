#!/usr/bin/env bash
#
# Install the backup timers as SYSTEMD USER units.
#
# User units rather than system units because this host has no passwordless
# sudo. With lingering enabled (`loginctl enable-linger $USER`, which this script
# checks) they start at boot and keep running with nobody logged in, which is the
# property that actually matters. Moving them to /etc/systemd/system later is a
# copy and a `systemctl enable --now` — the units carry no user-specific paths
# beyond %h.

set -Eeuo pipefail
BACKUP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

mkdir -p "$UNIT_DIR"
for u in atelier-backup.service atelier-backup.timer \
         atelier-backup-full.service atelier-backup-full.timer; do
  cp "${BACKUP_DIR}/${u}" "${UNIT_DIR}/${u}"
  echo "installed ${UNIT_DIR}/${u}"
done

systemctl --user daemon-reload
systemctl --user enable --now atelier-backup.timer atelier-backup-full.timer

if [ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null)" != "yes" ]; then
  echo
  echo "WARNING: lingering is OFF for ${USER}."
  echo "  The timers will stop when you log out and will not start at boot."
  echo "  Fix with:  loginctl enable-linger ${USER}"
  echo
fi

systemctl --user list-timers 'atelier-backup*' --no-pager
