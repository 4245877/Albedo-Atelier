#!/bin/sh
set -e

# Run the service as the unprivileged `node` user, not root. A named Docker
# volume mounted at /app/data may have been created root-owned by an earlier
# root container, so fix its ownership first (while still root), then drop
# privileges with gosu. The main process therefore runs as node (UID 1000).
# (gosu is Debian's su-exec equivalent; the image moved off Alpine so it can
# execute the mounted glibc OrcaSlicer binary.)
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  chown -R node:node /app/data
  exec gosu node "$@"
fi

exec "$@"
