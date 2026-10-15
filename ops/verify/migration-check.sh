#!/usr/bin/env bash
#
# Boots a CANDIDATE orchestrator image on a COPY of the production database —
# before the deploy — to see what its first start will do to real data:
# migrations, the catalog auto-import, the re-validation of approved profile
# sets, run recovery.
#
#   ops/verify/migration-check.sh [image]   # default: atelier-print-orchestrator:verify
#
# Production is only READ: the snapshot is `VACUUM INTO` from a read-only
# connection, in a throwaway container that mounts the data volume read-only.
# The candidate then runs with `--network none` (no route to any printer; the
# printers in the copied database simply read as offline) on that copy, and the
# copy is inspected before and after. Nothing is written to the volume, nothing
# reaches a printer, no running container is touched.
#
# Also checks the rollback limit: the running (old) image is pointed at the
# migrated copy and must refuse it (SchemaTooNewError) — i.e. a code rollback
# after this deploy needs the pre-deploy backup, not just the old image.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd -- "${HERE}/../.." && pwd -P)"
IMAGE="${1:-atelier-print-orchestrator:verify}"
VOLUME="${ORCHESTRATOR_VOLUME:-atelier_orchestrator-data}"
RUNNING="${ORCHESTRATOR_CONTAINER:-atelier-print-orchestrator}"
NODE_IMAGE="${VERIFY_NODE_IMAGE:-node:22-alpine}"
WORK="${VERIFY_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/atelier-migration.XXXXXX")}"
NAME="verify-migration-$$"

if [ -z "${ORCA_HOST_DIR:-}" ] && [ -f "${REPO}/.env" ]; then
  ORCA_HOST_DIR="$(sed -n 's/^ORCA_HOST_DIR=//p' "${REPO}/.env" | tail -1)"
fi

cleanup() { docker rm -f "$NAME" "${NAME}-old" >/dev/null 2>&1 || true; }
trap cleanup EXIT

mkdir -p "${WORK}/snapshot" "${WORK}/data" "${WORK}/old"
say() { printf '\n── %s\n' "$*"; }

# Always a scratch copy (never the volume): mounted read-write because a WAL
# database cannot be opened, even read-only, where its -shm cannot be written.
inspect() {
  docker run --rm --network none --user "$(id -u):$(id -g)" -v "$1:/db" -v "${HERE}:/bin-verify:ro" \
    "$NODE_IMAGE" node --disable-warning=ExperimentalWarning /bin-verify/inspect-db.cjs /db/queue.db
}

say "read-only snapshot of ${VOLUME}/queue.db"
docker run --rm --network none --user "$(id -u):$(id -g)" \
  -v "${VOLUME}:/data:ro" -v "${WORK}/snapshot:/out" "$NODE_IMAGE" node -e '
    const { DatabaseSync } = require("node:sqlite");
    const src = new DatabaseSync("/data/queue.db", { readOnly: true });
    src.exec("VACUUM INTO '\''/out/queue.db'\''");
    src.close();'
inspect "${WORK}/snapshot" >"${WORK}/before.json"
cat "${WORK}/before.json"

say "candidate ${IMAGE} on a copy, --network none"
cp "${WORK}/snapshot/queue.db" "${WORK}/data/queue.db"
# state.json carries the automation rules and counters; the copy keeps them so
# the first start sees what production would.
docker run --rm --network none --user "$(id -u):$(id -g)" -v "${VOLUME}:/data:ro" -v "${WORK}/data:/out" \
  "$NODE_IMAGE" sh -c 'cp /data/state.json /out/state.json 2>/dev/null || true'
orca=()
if [ -n "${ORCA_HOST_DIR:-}" ] && [ -x "${ORCA_HOST_DIR}/AppRun" ]; then
  orca=(-v "${ORCA_HOST_DIR}:/opt/orca:ro" -e ORCA_SLICER_CMD=/opt/orca/AppRun -e ORCA_SLICER_VERSION=2.3.0)
fi
docker run -d --name "$NAME" --network none \
  -e NODE_ENV=production -e HOST=127.0.0.1 -e PORT=3100 -e TZ=Europe/Kyiv \
  -e PRINTERS_CONFIG_PATH=/app/config/printers.json -e STATE_FILE_PATH=/app/data/state.json \
  -e ORCHESTRATOR_API_TOKEN=migration-check \
  -v "${REPO}/apps/print-orchestrator/config/slicers:/app/config/slicers:ro" \
  -v "${WORK}/data:/app/data" "${orca[@]}" "$IMAGE" >/dev/null
for _ in $(seq 1 90); do
  if docker exec "$NAME" node -e "fetch('http://127.0.0.1:3100/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
    break
  fi
  sleep 2
done
docker exec "$NAME" node -e "fetch('http://127.0.0.1:3100/api/print/slicing/runtime').then(r=>r.json()).then(j=>console.log(JSON.stringify({runtime:j.runtime.available,profileCounts:j.profileCounts,missingParents:j.missingParents})))"
docker exec "$NAME" node -e "fetch('http://127.0.0.1:3100/api/printers').then(r=>r.json()).then(l=>console.log(JSON.stringify(l.map(p=>({id:p.id,status:p.status,readiness:p.readiness&&p.readiness.label,bed:p.bedCycle&&p.bedCycle.state,confirmable:p.bedCycle&&p.bedCycle.confirmable})))))"
docker exec "$NAME" node -e "fetch('http://127.0.0.1:3100/api/automations/auto-queue').then(r=>r.json()).then(j=>console.log(JSON.stringify({configured:j.status.configured,armed:j.status.armed,plan:j.plan.map(d=>d.outcome+': '+d.message)})))"
docker logs "$NAME" >"${WORK}/candidate.log" 2>&1
docker stop "$NAME" >/dev/null
inspect "${WORK}/data" >"${WORK}/after.json"
say "after the candidate's first start"
cat "${WORK}/after.json"

say "rollback limit: the running image on the migrated copy"
old_image="$(docker inspect -f '{{.Config.Image}}' "$RUNNING")"
cp "${WORK}/data/queue.db" "${WORK}/old/queue.db"
docker run --rm --name "${NAME}-old" --network none \
  -e NODE_ENV=production -e HOST=127.0.0.1 -e PORT=3100 \
  -e PRINTERS_CONFIG_PATH=/app/config/printers.json -e STATE_FILE_PATH=/app/data/state.json \
  -v "${REPO}/apps/print-orchestrator/config/slicers:/app/config/slicers:ro" \
  -v "${WORK}/old:/app/data" "$old_image" >"${WORK}/old-image.log" 2>&1 &
old_pid=$!
sleep 20
docker rm -f "${NAME}-old" >/dev/null 2>&1 || true
wait "$old_pid" 2>/dev/null || true
if grep -q "SchemaTooNewError\|schema is newer" "${WORK}/old-image.log"; then
  echo "${old_image} refuses the migrated database (SchemaTooNewError) — as documented"
else
  echo "UNEXPECTED: ${old_image} did not refuse the migrated database; see ${WORK}/old-image.log"
fi

say "work dir: ${WORK}"
