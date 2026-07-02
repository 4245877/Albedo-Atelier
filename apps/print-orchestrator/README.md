# Albedo Atelier — print-orchestrator

Fastify service that backs the Albedo Atelier dashboard: printers, print jobs,
queue, materials, cameras, automations, maintenance, events, warnings and
system status.

Data currently comes from a seeded in-memory store (`src/infra/store`), which is
the single seam to replace with a database + real printer drivers later. The
printer-integration patterns are adapted from `apps/fulfillment` (static
connection config vs. live status, per-printer error isolation); driver stubs
live in `src/infra/drivers`.

## Local development

```bash
npm install
npm run dev        # tsx watch
npm run typecheck  # tsc --noEmit
npm run build      # emit dist/
```

## Docker

The service listens on `0.0.0.0:3100` by default.

```bash
docker compose up -d --build print-orchestrator
```

## API

Responses are JSON in the exact shape the dashboard renders (see
`apps/print-dashboard`). Errors are `{ "error": { "code", "message", "details" } }`
with a stable `code` (`PRINTER_OFFLINE`, `PRINTER_CONNECTION`, `CAMERA_ERROR`,
`MATERIAL_ERROR`, `JOB_ERROR`, `VALIDATION`, `NOT_FOUND`).

### Observability

- `GET /health`
- `GET /ready`

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

These mutate the store today and are structured to dispatch to real printer
drivers later (see the `// TODO(real driver)` seams in `src/infra/store`).

- `POST /api/printers/:id/pause` · `.../resume` · `.../cancel` · `.../snapshot`
- `POST /api/printers/:id/light` — body `{ "on": boolean }`
- `POST /api/queue` — add a job, body `{ title, printer?, material?, eta?, at?, night? }`
- `POST /api/queue/start-next` · `POST /api/queue/night/start` · `POST /api/queue/night/pick`
- `POST /api/automations/:id/toggle` — body `{ "on"?: boolean }` (omit to flip)
