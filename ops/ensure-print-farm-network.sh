#!/bin/sh
# Creates the shared docker bridge network between the fulfillment stack and
# the atelier print-orchestrator stack. Idempotent: safe to run before every
# `docker compose up` of either project; both compose files reference the
# network as `external: true, name: print-farm`, so neither stack depends on
# the other's auto-generated network name (or on the other being up at all).
set -eu

NETWORK_NAME="${PRINT_FARM_NETWORK:-print-farm}"

if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  echo "ok: docker network '$NETWORK_NAME' already exists"
else
  docker network create --driver bridge "$NETWORK_NAME" >/dev/null
  echo "created: docker network '$NETWORK_NAME'"
fi
