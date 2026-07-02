# Albedo Atelier — print-orchestrator

Fastify service that backs the Albedo Atelier dashboard: printers, print jobs,
queue, materials, cameras, automations, maintenance, events, warnings and
system status.

Data is real, never seeded. Printer configs come from `config/printers.json`
(or `PRINTERS_CONFIG_JSON`); live telemetry is polled from the devices —
Moonraker over HTTP, Bambu over local MQTT, Creality over WebSocket (see
`src/infra/printers/status/`, adapted from `apps/fulfillment`); camera frames are
real snapshots (`src/infra/printers/camera/`). Anything the farm genuinely does
not know (material stock, maintenance history, schedule) is returned empty/null
and the dashboard shows it as unavailable rather than inventing numbers.

State (the operator queue, the event feed, today's counters) is held in memory
and resets with the process — there is no database. The store is composed of
focused collaborators behind a facade (`src/infra/store/`): `PrinterPoller`,
`CameraService`, `QueueStore`, `EventFeed`, `PrinterCommandService` and the
read-only `DashboardReadModel`.

## Local development

Uses **pnpm** (via `corepack enable`).

```bash
pnpm install
pnpm run dev        # tsx watch
pnpm run typecheck  # tsc --noEmit
pnpm run build      # emit dist/
```

## Docker

The service listens on `0.0.0.0:3100` inside the container but is **not** published
to the host — the dashboard reaches it over the compose network.

```bash
docker compose up -d --build print-orchestrator
```

## API

Responses are JSON in the exact shape the dashboard renders (see
`apps/print-dashboard`). Errors are `{ "error": { "code", "message", "details" } }`
with a stable `code` (`PRINTER_OFFLINE`, `PRINTER_CONNECTION`, `CAMERA_ERROR`,
`MATERIAL_ERROR`, `JOB_ERROR`, `VALIDATION`, `NOT_FOUND`).

### Observability

- `GET /health` — liveness + uptime
- `GET /ready` — real readiness: `503` until the first poll completes and again
  if the poll loop goes stale; a merely degraded farm (some printers offline)
  still returns `200`
- `GET /metrics` — Prometheus counters drawn from the live farm state
  (`print_orchestrator_printers_online`, `_degraded`, `_queue_jobs`, …)

### Security

State-changing requests (everything below "Actions") are gated by an optional
shared secret. Set `ORCHESTRATOR_API_TOKEN` and send it as
`Authorization: Bearer <token>` (or `X-Api-Token`); reads stay open. When unset,
the guard is disabled and a startup warning is logged. CORS is closed by default
(no wildcard) — allow cross-origin callers via `CORS_ALLOW_ORIGINS`.

### Dashboard reads

- `GET /api/dashboard` — the whole board in one payload
- `GET /api/status` — overall service status
- `GET /api/printers` · `GET /api/printers/active` · `GET /api/printers/:id`
- `GET /api/printers/:id/camera.jpg` · `GET /api/printers/:id/camera.mp4`
- `GET /api/queue` · `GET /api/queue/night`
- `GET /api/materials` · `GET /api/cameras` · `GET /api/maintenance`
- `GET /api/events` · `GET /api/critical` · `GET /api/warnings`
- `GET /api/system` · `GET /api/today` · `GET /api/performance` · `GET /api/plan`
- `GET /api/automations`

### Actions

Printer actions dispatch **real** commands to the device (Moonraker HTTP,
Bambu local MQTT); unsupported combinations fail honestly rather than pretending.
Queue/night/automation features that have no engine yet return a clear error
instead of fabricating a result.

- `POST /api/printers/:id/pause` · `.../resume` · `.../cancel` · `.../snapshot`
- `POST /api/printers/:id/light` — body `{ "on": boolean }`
- `POST /api/queue` — add a job, body `{ title, printer?, material?, eta?, at?, night? }`
- `POST /api/queue/start-next` · `POST /api/queue/night/start` · `POST /api/queue/night/pick`
- `POST /api/automations/:id/toggle` — body `{ "on"?: boolean }` (omit to flip)
