# Atelier

Workspace for Atelier services.

## Albedo — Зал Верховного Надзора

Start the local stack (first time on a fresh host):

```bash
cp .env.example .env    # fill in the deployment values
./ops/ensure-print-farm-network.sh
./ops/backup/install-timers.sh   # scheduled backups — do this BEFORE the first deploy
./scripts/deploy.sh
```

**`COMPOSE_FILE` decides which system you get.** `.env.example` ships it active:

```
COMPOSE_FILE=compose.yml:compose.orca.yml
```

Without it, compose builds the **lean** image, `/opt/orca` is never mounted, and
slicing is dead — while every container reports healthy and the deploy prints a
full success. Preflight now refuses that combination outright when
`ORCA_SLICER_CMD` is configured, rather than reporting it as an `ok` line. Comment
it out only for a deliberately lean host, and unset `ORCA_SLICER_CMD` there too.

**Disk.** A cold `production-orca` build needs **4096 MB** free on the Docker data
filesystem (lean: 2048 MB); preflight enforces it. See
[Reclaiming disk safely](#reclaiming-disk-safely).

### Updating a running deployment

```bash
./scripts/deploy.sh
```

That is the whole command. It runs preflight → build → `up -d` → health checks →
HTTP verification, and **never** takes the running farm down before the new
images exist.

Do **not** put `docker compose down` in front of a rebuild. `down` removes the
running containers *before* the new images exist, so any build failure — most
commonly `no space left on device`, since the `production-orca` target pulls in
the heavy GTK/WebKit layers — leaves the farm fully offline instead of merely
un-updated. `up -d` recreates only the services whose image or config actually
changed, so `down` buys nothing even on the happy path.

What the script adds over `build && up -d` by hand:

| stage | what it protects against |
|---|---|
| preflight | daemon down, wrong directory, missing `.env` or an unresolvable compose config, missing `print-farm` network, **not enough disk or inodes to build**, prints in flight |
| build | a build that fills the disk is cancelled by a watchdog *before* it starves the running containers; remote images are pulled here, not mid-swap |
| up | `--no-build` (the images are already verified); refuses to swap the orchestrator while a print is running unless `--allow-active-prints` |
| health | waits for every container's healthcheck, fails fast on a crash loop, dumps `ps` + logs + the last healthcheck output on failure |
| HTTP | dashboard `/`, orchestrator `/health` and `/ready` through the published port (read from compose, not hardcoded) |

Other subcommands:

```bash
./scripts/deploy.sh preflight   # checks only — changes nothing
./scripts/deploy.sh status      # containers, health, restarts, disk
./scripts/deploy.sh reclaim     # free disk safely: build cache + dangling images
./scripts/deploy.sh rollback    # re-point compose at the previous images
./scripts/deploy.sh --cleanup   # deploy, then reclaim
./scripts/deploy.sh --help
```

Cleanup is a **flag on a successful deploy**, not part of every run: the build
cache is what makes the next build cheap, and pruning it *before* a build only
makes that build need more disk, not less. Reclaim after you are green, or when
preflight tells you the disk is too tight.

`reclaim` only ever runs `docker builder prune -a` (build cache) and
`docker image prune` (untagged images). **No Docker volume is ever touched** by
any part of this script — `docker volume prune`, `docker system prune --volumes`
and `docker compose down -v` would delete `orchestrator-data`, which holds
`queue.db` (the print queue, runs, and the printer inventory *including device
credentials*). Never run them here.

**Why a no-op deploy is really a no-op.** The build runs with
`--provenance=false`. BuildKit's default provenance attestation makes the
exported image a manifest *list* whose digest embeds build metadata, so a
fully-cached rebuild still produces a new image id — and compose, comparing ids,
would recreate every built container on every deploy. That restart is not free:
it loses the in-memory run identity of prints already in flight (no filament
auto-deduction, no duration metric for them). With provenance off, running
`./scripts/deploy.sh` twice in a row leaves all three containers untouched.
(The `build.provenance` key in `compose.yml` is silently ignored by Compose v5 —
it has to be the CLI flag, which is why it lives in the script.)

**Git is not part of a deploy.** Pull, review, then deploy — the script records
the commit it built from and warns when the working tree is dirty.

**Rollback.** Before building, the script tags the images the running containers
came from as `<image>:previous`, and — **only after a deploy passes health and
HTTP verification** — tags that verified build `<image>:last-known-good` and
records its image ID in `.deploy/state.env`.

That ordering is the point. `:last-known-good` moves *after* proof, never before
a build, so:

* a failed deploy never becomes the rollback target;
* two failed deploys in a row cannot promote the first failure;
* a no-op deploy does not consume the target.

`./scripts/deploy.sh rollback` re-points `:latest` at the recorded
last-known-good, **verifies the recorded image ID still matches the tag** (and
refuses if something re-tagged it), checks for prints in flight, recreates the
containers, and then runs the same health + HTTP checks a deploy does. It prints
`ROLLBACK VERIFIED` only after those pass and exits non-zero with
`ROLLBACK FAILED` if they do not.

Rollback is *not* automatic. The orchestrator's SQLite migrations are
**forward-only** (no `down`), so if the failed deploy already migrated
`queue.db`, the older image cannot safely run against the new schema — it now
**refuses to start** rather than corrupting data silently (see
[Schema compatibility](#schema-compatibility)). `--rollback-on-failure` opts into
automatic rollback and is **blocked automatically** when the deploy applied a
migration; recover from a backup instead.

### Rollback limitations

* One step back only — `:last-known-good` holds a single generation.
* It restores **running containers, not the checkout**; the working tree stays
  on the new code.
* It cannot undo a migration. That is what the pre-deploy snapshot in
  `.deploy/db-snapshots/` and the scheduled backups are for.
* A host that has never completed a verified deploy has no target; the first run
  adopts the currently-running healthy stack and says so.

The equivalent by hand, if you ever need it without the script:

```bash
df -h /                 # 1. preflight: production-orca needs 4096 MB free (lean: 2048)
docker compose build    # 2. build — on failure the old stack keeps serving
docker compose up -d    # 3. swap: recreates only the services whose image changed
```

If a build fails on disk space, reclaim it with `docker builder prune -a`
(build cache only) — never `docker volume prune` or
`docker system prune --volumes`, which would delete `orchestrator-data` whenever
the containers happen to be stopped.

Dashboard (the entry point):

- `http://localhost:8090`

It binds to `127.0.0.1` by default. For intentional LAN access, set
`DASHBOARD_BIND=0.0.0.0` in `.env`; then use the host address, for example
`http://192.168.0.139:8090/`.

The dashboard calls the orchestrator same-origin through its nginx proxy, so the
API is reached at `http://localhost:8090/api/print-orchestrator/...`, e.g.:

- `GET http://localhost:8090/api/print-orchestrator/api/dashboard` — full state in one payload
- `GET http://localhost:8090/api/print-orchestrator/api/printers`

See `apps/print-orchestrator/README.md` for the full API (per-section reads and
printer/queue/automation actions) and the `/health`, `/ready`, `/metrics` probes.

### Persistence

Durable state lives on the `orchestrator-data` Docker volume, in two places with
different jobs:

| Path | Holds | Notes |
|---|---|---|
| `/app/data/queue.db` | **The queue and the domain model** — tasks, assignments, plans, runs, bed cycles, slicing, the operator schedule, and the **printer inventory including device credentials** | SQLite, WAL. The source of truth. |
| `/app/data/state.json` | Event feed, today's counters, filament deductions awaiting delivery, sub-gram carry, and **unreconciled deductions** owed after an untracked print | Written temp-file + atomic rename |
| `/app/data/artifacts/` | Uploaded files as content-addressed blobs (`sha256/<2>/<64>`) | Immutable; referenced by `queue.db` |
| `/app/data/snapshots/` | Camera stills | Non-critical |

The queue has **not** lived in `state.json` since the SQLite cutover; that file
now carries the feed, counters and deduction bookkeeping. Live telemetry is not
persisted (it is re-polled).

Both survive container recreation. Neither survives losing the volume — see
[Backup and restore](#backup-and-restore).

### Schema compatibility

Migrations are forward-only and run before the service accepts traffic. Since the
schema guard was added, an image also **refuses to start against a database
migrated by a newer image**, with an explicit message, instead of quietly
ignoring the migration versions it does not recognise and then reading and
writing a schema it was never compiled against. A crash-loop is visible to
`deploy.sh`; silent divergence is not.

### Which version is running?

```bash
./scripts/deploy.sh status                       # per-service revision
curl -s localhost:8090/api/print-orchestrator/version | jq
docker image inspect atelier-print-dashboard:latest \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

Images carry `org.opencontainers.image.revision` and the orchestrator serves
`GET /version` (commit, build time, dirty flag). This is what makes a **partial
deploy** — orchestrator updated, dashboard not — visible; health checks alone
stay green through one.

Build identity is stored in image *config* (labels/env), never written into a
filesystem layer, so it cannot make an otherwise-unchanged rebuild look like a
content change — which would defeat the mid-print recreation guard below.

### Backup and restore

`queue.db` holds the queue, every run, and the **printer inventory including
device credentials**; `artifacts/` holds the blobs those rows point at; `.env`
holds the only copy of the Bambu LAN access code outside the database. Losing the
volume without a backup means re-provisioning the farm by hand.

`ops/backup/` provides this. It is scheduled with **systemd user timers**
(the host has no passwordless sudo); `loginctl enable-linger` is what makes them
run at boot and with nobody logged in.

```bash
./ops/backup/install-timers.sh          # install + enable both timers
systemctl --user list-timers 'atelier-backup*'
journalctl --user -u atelier-backup.service -n 50
```

| Unit | Cadence | Contents |
|---|---|---|
| `atelier-backup.timer` | hourly | `queue.db` + `state.json` |
| `atelier-backup-full.timer` | daily 04:10 | the above + `artifacts/`, `snapshots/`, `.env`, `go2rtc.yaml` |

Manual runs:

```bash
./ops/backup/backup.sh --full
./ops/backup/verify.sh --all
./ops/backup/restore.sh --to-dir /tmp/atelier-restore-test    # rehearsal, never production
```

**How it stays consistent.** `queue.db` is snapshotted with `VACUUM INTO` on a
**read-only** handle — correct on a live WAL database, where `cp queue.db` is
not. `artifacts/` is copied **after** that snapshot, never before: uploads commit
the blob to content-addressed storage before inserting the row that references it
(`ingest.ts:84` vs `:112`) and committed blobs are immutable, so a later copy is
a superset of what the snapshot needs. The reverse order could reference a blob
copied too early to exist. Every blob the snapshot references is then **verified
present**, so the guarantee is checked rather than asserted. This is not an
atomic volume snapshot and is not claimed to be one.

**Restore is verified before it is trusted:** `restore.sh` refuses to restore a
set that does not pass `verify.sh`, and writes to a scratch directory unless you
explicitly pass `--to-production --i-mean-it` (which additionally refuses to run
while the orchestrator is up).

**Retention** is per tier (48 hourly / 14 daily / 8 weekly by default, in
`ops/backup/backup.conf`). Pruning only ever deletes inside the backup tree, and
every path passes a guard that rejects system paths, the Docker data root and the
git checkout.

**Security.** The backup root is `0700`, `.env` copies are `0600`, and secrets
never reach stdout, the journal or the manifest.

> **Where the backups live.** `ops/backup/config.sh` prefers a dedicated disk,
> located by filesystem **UUID** (`BACKUP_DISK_UUID`) rather than by mountpoint —
> an absent mount otherwise leaves an empty directory on the root disk that looks
> perfectly writable. When that disk is not mounted it falls back to
> `~/atelier-backups` and every run prints a **DEGRADED** warning, because a
> same-disk backup protects against volume loss, operator error and filesystem
> corruption — but **not** against losing the disk, host death, theft, fire or a
> root compromise. A second disk in the same chassis is still not an off-host
> backup.

### Reboot and recovery

The stack comes back by itself: `docker.service` is enabled and all three
containers use `restart: unless-stopped`. **No manual `docker compose up -d` is
needed after a reboot.**

The daemon's restart policy does not honour `depends_on`, so the dashboard may
start before the orchestrator. That is handled in nginx by resolving upstreams at
request time (`resolver 127.0.0.11`) instead of once at config-parse time — which
previously made nginx refuse to start at all (`[emerg] host not found in
upstream`) and crash-loop until the orchestrator appeared.

After an unexpected restart mid-print, see
[Restart cost](#printer-inventory) — run identity is recovered. A run the farm
could not reconcile is left `UNKNOWN` and its printer is **held** (blocked for
the queue) until a human resolves it; that is deliberate, since an unobserved
ending is never assumed to be a success.

### Reclaiming disk safely

```bash
./scripts/deploy.sh reclaim           # untagged images only — KEEPS the build cache
./scripts/deploy.sh reclaim --cache   # also drops the build cache
```

`--cache` is a last resort: it reclaims roughly a gigabyte and makes the next
build **cold**, which then needs ~4 GB. On a tight disk that turns a slow deploy
into an impossible one. Nothing in this script ever touches a Docker volume.

Usually the biggest win is not Docker at all:

```bash
du -sh ~/.vscode-server/cli/servers/* ~/.vscode-server/bin/*
```

Stale VS Code server versions accumulate at ~700 MB each. Delete only versions
that are not running (check with `ps` / `/proc/*/maps` first).

**Never** run these here — they delete the volume holding `queue.db` whenever the
containers happen to be stopped:

```
docker system prune -a --volumes
docker volume prune
docker compose down -v
```

### Ports & security

The **orchestrator control API is not published to the host** — it is reachable
only over the compose network. The dashboard (`8090`) is bound to localhost
unless `DASHBOARD_BIND=0.0.0.0` is explicitly set. The go2rtc WebRTC media port
(`8555`, required for live K2 video) is exposed on `0.0.0.0`; the go2rtc API
(`1985`) is bound to localhost.

> ⚠️ **Trust assumption:** the dashboard on `8090` is served on the LAN without
> its own login and proxies the control API same-origin
> (`/api/print-orchestrator/*`), so **anyone who can reach `8090` on the LAN can
> drive the printers** (pause/resume/cancel/light). **Do not expose `8090` to an
> untrusted network** (public IP, port-forward, shared VLAN); for extra gating
> put HTTP Basic Auth in front of nginx.
>
> What *is* enforced in code:
>
> - **CSRF / foreign origins:** the orchestrator refuses state-changing requests
>   whose `Origin` is neither the dashboard's own host nor in
>   `CORS_ALLOW_ORIGINS` (403) — a malicious web page in a LAN browser cannot
>   fire pause/cancel POSTs, and CORS stays closed besides. The dashboard proxy
>   additionally refuses `camera.jpg?ensureLight=…` (403), so a drive-by `<img>`
>   cannot flip the chamber light through the published port.
> - **API token:** `ORCHESTRATOR_API_TOKEN` (set in `.env`; generate with
>   `openssl rand -hex 24`) is required on every state-changing request and on
>   the side-effectful `camera.jpg?ensureLight=1`; other reads stay open. The
>   dashboard's nginx injects the token for the LAN dashboard (compose passes
>   the same variable to both containers), so the buttons keep working while
>   direct access to the control API (compose network / `print-farm`) is gated.
>   Mirror the value in fulfillment's `PRINTER_ORCHESTRATOR_API_TOKEN`. When the
>   token is unset, mutations are refused with 503 unless the deployment makes
>   the explicit isolated-network opt-in `ALLOW_UNAUTHENTICATED_MUTATIONS=1`.
> - **go2rtc:** only the signaling WebSocket (`/go2rtc/api/ws`) is proxied; the
>   rest of the go2rtc HTTP API (config editing, restart) is not reachable
>   through the dashboard, and go2rtc's own API port stays bound to localhost.

### Fulfillment integration

This orchestrator is the **only** service that talks to the printer hardware
(Moonraker HTTP, Bambu MQTT, Creality WebSocket, cameras/go2rtc) — exactly one
Bambu MQTT client and one go2rtc instance exist on the host, both in this
stack. The fulfillment API (`~/apps/fulfillment`) consumes it read-only over
HTTP:

- `GET /api/printers/inventory` — the printer **configuration** (which printers
  exist, model/type/class/protocol/material/nozzle/build volume/position and
  whether each is `enabled`). This is the inter-service contract: fulfillment
  builds its printer lists from it and refuses to bind a reel to a printer that
  is not in it or is disabled. Unlike `/api/printers` it INCLUDES disabled
  printers, so «отключён» and «удалён» stay distinguishable, and unlike
  `/api/printers/config` it carries no host, port or credential status;
- `GET /api/printers` — live statuses for fulfillment's monitoring, health
  checks and its read-only «3D-принтери» page;
- `GET /api/printers/:id/camera.jpg?ensureLight=1` — snapshots for Telegram
  print notifications (the orchestrator switches the chamber light on first at
  night).

Configuration and live state stay separate on purpose: a printer that is
configured-and-disabled and one that is enabled-but-offline are different
situations, and a merged feed cannot express both.

Both stacks meet on the shared external docker network **`print-farm`**
(stable name, independent of either project's directory). Create it once —
idempotent, and required before the first `docker compose up` of either
project:

```bash
./ops/ensure-print-farm-network.sh
```

The fulfillment `api` container dials `http://print-orchestrator:3100` (its
`PRINTER_ORCHESTRATOR_URL`) over that network, so the control API still is
not published to the LAN, no LAN IPs are pinned, and either stack may start
first (fulfillment degrades gracefully until this one is up). If
`ORCHESTRATOR_API_TOKEN` is set here, mirror it in fulfillment's
`PRINTER_ORCHESTRATOR_API_TOKEN`.

**Wire contracts.** Both cross-service payloads are pinned as committed
fixtures under `apps/print-orchestrator/contracts/`, generated by their own
tests and copied verbatim into fulfillment, which replays them through its
runtime validator:

| payload | pinned by | fixture |
|---|---|---|
| `GET /api/printers` (PrinterView, live state) | `src/app/printerView.contract.test.ts` | `printer-view.contract.json` |
| `GET /api/printers/inventory` (configuration) | `src/domain/printers/inventory.contract.test.ts` | `printer-inventory.contract.json` |

After a deliberate DTO change run `UPDATE_CONTRACT=1 pnpm test`, copy the
regenerated fixture into
`~/apps/fulfillment/apps/api/src/infra/integrations/orchestrator/` and make
both test suites pass. Each contract has a test guaranteeing the payload
carries no connection parameters or credentials (`host`, `port`, `serial`,
`accessCode`, `apiKey`, `snapshotUrl`, …).

**Printer config & secrets.** Printers are configured **from the dashboard**
(section «Оборудование фермы» → `/api/printers/config`): add a printer, change
its address, rotate a Bambu access code after a reset, disable it for repairs,
probe the connection. Changes apply from the next poll — no file edit, no
rebuild, no restart.

The card's *technical* fields fill themselves in: the service asks each printer
what hardware it is — model, build volume, nozzle diameter and type, AMS/AMS
Lite, loaded materials — and keeps that current, so an operator types only what
the device genuinely cannot report. Each value is shown with its source
(**с принтера** / **по модели** / **вручную**), the device wins over a stale
hand-typed value, and a disagreement between the two is surfaced rather than
hidden. See
[Hardware discovery](apps/print-orchestrator/README.md#hardware-discovery-what-a-printer-says-about-itself).

The inventory (hosts, serial, access code) lives in the
orchestrator's SQLite database on the `orchestrator-data` volume, so it must be
protected like a secret file (`600`, never copied into an image) and it is what
a backup has to include.

`apps/print-orchestrator/config/printers.json` is now only a **one-time seed**:
on the first boot after this cutover it is imported into the database and never
read again (guarded by an `app_meta` marker, so a stale file can never revert an
edit made in the panel). It stays **untracked** (`.gitignore`); start from
`config/printers.example.json` only when provisioning a brand-new host. Values
are imported verbatim, so `${BAMBU_A1_ACCESS_CODE}`-style references keep
resolving from `.env` until an operator types a literal value in the panel. The
old file was once committed — treat the Bambu LAN access code from any such
history as burned and rotate it on the printer (now a 20-second job in the UI).

Credentials only ever travel *inbound*: every read returns whether a credential
is set and, for an env reference, which variable it names — never the value. An
edit that omits a credential keeps the stored one, so the form can be submitted
whole without the browser ever holding a secret.

**Restart cost.** Recreating the orchestrator keeps the queue, event feed and
today's counters (`orchestrator-data` volume). Print-run identity is now
**recovered** as well: on the first poll after a restart the poller re-adopts the
canonical `PrintRun` from SQLite, restoring the run id (so the filament
idempotency key is unchanged and nothing can be deducted twice), the real
`startedAt` (so duration is not lost) and the AMS baseline captured when the
print began — which is persisted with the run precisely so it can be recovered.

When a run genuinely cannot be re-adopted (for example a print that began before
the farm ever knew about it), the completion still skips auto-deduction, but the
debt is now recorded **durably** as an unreconciled deduction in `state.json`
rather than only announced once in the capped event feed. `deploy.sh` also
refuses to recreate the orchestrator while prints are in flight, and fails closed
when it cannot determine whether any are.

Package manager: **pnpm** (`corepack enable`). The dashboard is static assets;
`apps/print-orchestrator` is the only Node project.
