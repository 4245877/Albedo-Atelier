#!/bin/sh
set -e

# Run the service as the unprivileged `node` user, not root. A named Docker
# volume mounted at /app/data may have been created root-owned by an earlier
# root container, so fix its ownership first (while still root), then drop
# privileges with su-exec. The main process therefore runs as node (UID 1000).
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  chown -R node:node /app/data
  exec su-exec node "$@"
fi

exec "$@"
