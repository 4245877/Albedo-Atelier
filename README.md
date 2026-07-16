# Atelier

Workspace for Atelier services.

## Albedo — Зал Верховного Надзора

Start the local stack:

```bash
docker compose down
docker compose up -d --build
```

Dashboard (the entry point, published on the LAN):

- `http://localhost:8090`

The dashboard calls the orchestrator same-origin through its nginx proxy, so the
API is reached at `http://localhost:8090/api/print-orchestrator/...`, e.g.:

- `GET http://localhost:8090/api/print-orchestrator/api/dashboard` — full state in one payload
- `GET http://localhost:8090/api/print-orchestrator/api/printers`

See `apps/print-orchestrator/README.md` for the full API (per-section reads and
printer/queue/automation actions) and the `/health`, `/ready`, `/metrics` probes.

### Persistence

The orchestrator's mutable state — the operator queue, the event feed,
today's counters and filament deductions still awaiting delivery to the
fulfillment warehouse — is written to a JSON file on the `orchestrator-data`
Docker volume (`/app/data/state.json`), so it survives `docker compose down`
and container recreation. Live telemetry is not persisted (it is re-polled). See the
service README for details and `STATE_FILE_PATH`.

### Ports & security

The **orchestrator control API is not published to the host** — it is reachable
only over the compose network. Only the dashboard (`8090`) and the go2rtc WebRTC
media port (`8555`, required for live K2 video) are exposed on `0.0.0.0`; the
go2rtc API (`1985`) is bound to localhost.

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
>   token is unset the guard is disabled and a warning is logged on startup.
> - **go2rtc:** only the signaling WebSocket (`/go2rtc/api/ws`) is proxied; the
>   rest of the go2rtc HTTP API (config editing, restart) is not reachable
>   through the dashboard, and go2rtc's own API port stays bound to localhost.

### Fulfillment integration

This orchestrator is the **only** service that talks to the printer hardware
(Moonraker HTTP, Bambu MQTT, Creality WebSocket, cameras/go2rtc) — exactly one
Bambu MQTT client and one go2rtc instance exist on the host, both in this
stack. The fulfillment API (`~/apps/fulfillment`) consumes it read-only over
HTTP:

- `GET /api/printers` — statuses for fulfillment's monitoring, health checks
  and its read-only «3D-принтери» page;
- `GET /api/printers/:id/camera.jpg?ensureLight=1` — snapshots for Telegram
  print notifications (the orchestrator switches the chamber light on first at
  night).

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

**Wire contract.** The `GET /api/printers` payload (PrinterView) is pinned by
`src/app/printerView.contract.test.ts` against
`apps/print-orchestrator/contracts/printer-view.contract.json`; the same
fixture is committed verbatim in fulfillment and replayed through its runtime
validator. After a deliberate DTO change run `UPDATE_CONTRACT=1 pnpm test`,
copy the regenerated fixture into
`~/apps/fulfillment/apps/api/src/infra/integrations/orchestrator/` and make
both test suites pass. The contract (and a test) also guarantees the payload
carries no connection parameters or credentials (`host`, `serial`,
`accessCode`, `apiKey`, `snapshotUrl`, …).

**Printer config & secrets.** `apps/print-orchestrator/config/printers.json`
holds LAN hosts and the Bambu serial + access code, so it is **untracked**
(`.gitignore`) and lives only on this host; start from
`config/printers.example.json`. It used to be committed — treat the Bambu
LAN access code from any old history as burned and rotate it on the printer.

**Restart cost.** Recreating the orchestrator container keeps the queue,
event feed and today's counters (`orchestrator-data` volume), but in-memory
print-run identity is lost: prints already running are still tracked, yet
their completion skips filament auto-deduction and the average-duration
metric. Prefer deploying while no print is mid-run when that matters.

Package manager: **pnpm** (`corepack enable`). The dashboard is static assets;
`apps/print-orchestrator` is the only Node project.

