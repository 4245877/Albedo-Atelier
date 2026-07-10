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

State (the operator queue, the event feed, today's counters) is persisted to a
single JSON file so it survives a restart — there is still no database. The path
is `STATE_FILE_PATH` (default `<cwd>/data/state.json`; `/app/data/state.json` on
the `orchestrator-data` volume in Docker). Writes are atomic (temp file +
rename) and loading is tolerant: a missing file starts empty (first run) and a
corrupt/hand-edited one degrades to empty defaults with a logged warning instead
of crashing startup. The farm is composed of focused collaborators behind the
`FarmStore` facade (`src/app/`): the `PrinterPoller` poll loop with its
extracted `LightScheduler`, `TodayCounters` and `FilamentConsumption`,
plus `CameraService`, `QueueStore`, `EventFeed` and the read-only
`DashboardReadModel` (exposed as `farmStore.reads`). Persistence lives in
`src/infra/persistence/` (`StateStore`, `SnapshotStore`); HTTP routes in
`src/modules/`, the CORS/token hook in `src/http/security.ts`.

Live telemetry is deliberately **not** persisted — printer statuses and the
manual light override are re-derived on the next poll, and persisting statuses
would make a restart re-announce pre-existing conditions. Material stock,
maintenance history and automations are still honest stubs with no runtime state
yet; the persistence layer is structured to hold them once they are implemented.

Printer lights are governed by `NIGHT_PRINT_WINDOW` (default
`21:30 – 07:30`) using the process local timezone (`TZ` in Docker). On each
poll, supported lights are switched on inside that window and switched off
outside it.

**Manual override.** A manual light command is allowed at any time. It is
serialized with the scheduler through a per-printer light queue, so a manual
command and a scheduled one can never interleave on the wire, and a stale
scheduled command can never clobber a fresh manual one. After a manual command
the chosen state is held for **5 minutes**; once that window passes the
schedule takes over again — turning the light on if the night window says on,
off if it says off. Two caveats:

- The return to the schedule happens on the **next poll tick**, not exactly at
  the 5-minute mark, so the effective hold is `5 min + up to
  PRINTER_POLL_INTERVAL_MS` (default 10 s).
- The override lives **in memory only**. Restarting the orchestrator drops it,
  and the schedule may reassert the scheduled state on the first poll after
  restart. This is intentional (there is no database); persist it only if that
  ever becomes a requirement.

If a scheduled light command is sent but the reported state never converges to
the target (wrong `pin`, `SET_PIN` accepted but nothing physically changes, or
`output_pin <pin>` reflecting a different device), the poller stops retrying
after 3 attempts, backs off for 5 minutes, and logs/feeds **one** warning
naming the pin to check in `printer.cfg` — instead of resending every tick and
flapping the UI. The counter resets on convergence or on a manual command.

**Per protocol.** Bambu uses local MQTT `system.ledctrl` (`light.bambuNode`,
default `chamber_light`). Moonraker uses `light.pin` to generate
`SET_PIN PIN=<pin> VALUE=1/0` and reads `output_pin <pin>`; use explicit
`light.onGcode`, `light.offGcode`, `light.statusObject` and `light.statusField`
for custom setups. **The Creality K2 in this deployment is driven over
Moonraker**, not the Creality WebSocket adapter — its config uses
`protocol: "moonraker"`, `port: 4408`, `light: { pin: "LED" }`, so its light is
`SET_PIN PIN=LED VALUE=1/0` read back from `output_pin LED`. Creality
**WebSocket** light control is not implemented for any model.

## Filament auto-consume

When a print **completes** (never on cancel or error), the poller deducts the
used filament from the fulfillment warehouse via
`POST /api/inventory/filament/consume`. All stock logic stays in fulfillment —
the orchestrator only reports what a printer consumed. Disabled (a no-op) until
`FULFILLMENT_API_URL` is set, so the farm still runs standalone. Warehouse
errors are **soft**: logged and shown as one feed warning, never fatal to the
poll loop. Each deduction carries a stable `idempotencyKey` so a re-observed
completion or a retry cannot double-deduct.

The consumed amount comes from whatever the device actually knows:

- **Moonraker / K2** reports extruded length (`print_stats.filament_used`), sent
  as `lengthMm` for the single loaded reel.
- **Bambu A1 Combo / AMS Lite** MQTT does **not** report grams or length (that
  lives in slicer metadata). Instead each AMS tray reports `remain` — the
  printer's own 0–100 % estimate of filament left — and a nominal spool weight.
  The poller snapshots the trays at print start and, at completion, deducts the
  drop in `remain` × nominal weight as **grams per tray**, sending one call per
  used slot with `amsTray` + material/colour hints so fulfillment resolves the
  right per-slot reel. This naturally covers multi-colour prints. See
  `src/infra/printers/status/bambuUsage.ts`.

  Caveats, handled honestly rather than papered over: `remain` is quantised to
  1 % (≈10 g on a 1 kg spool, ≈2.5 g on a 250 g AMS-Lite spool), so very small
  prints can round to zero; an **uncalibrated** tray (`remain = -1`) or a print
  that was already running before the orchestrator started (no start snapshot,
  it is in-memory only) yields no data — nothing is deducted and one soft
  warning is fed. For exact per-filament grams the upgrade path is the sliced
  3MF `Metadata/slice_info.config` (`used_g`/`used_m`) fetched over the
  printer's FTPS, pluggable behind the same completion → consume-items seam.

## Nozzle & active filament (live)

Each printer view carries the nozzle and the currently loaded filament **live
from the device** where it reports them, so the operator does not have to keep
the config's `material` field in sync by hand:

- `nozzleDiameter` (mm) — Bambu `print.nozzle_diameter`, **and** Moonraker/Klipper
  `configfile.settings.extruder.nozzle_diameter` (`parseMoonrakerNozzleDiameter`
  in `moonraker.ts`), so the **Creality K2** (driven over Moonraker on port 4408)
  reports it live too. Like Bambu's, it is a *setting* read from the printer's own
  config, not a sensor. `nozzleType` is **Bambu-only** — Klipper has no standard
  nozzle-type field.
- `liveMaterial` / `liveMaterialColor` / `activeTray` — the active filament. On
  **Bambu**, resolved in `resolveActiveFilament()`
  (`src/infra/printers/status/bambuUsage.ts`): first the active AMS/AMS-Lite tray
  (`print.ams.tray_now` → `print.ams.ams[].tray[].tray_type` / `tray_color`), then
  the external spool (`print.vt_tray`) when no AMS tray is feeding. On the
  **Creality K2** (Moonraker), resolved in `parseMoonrakerJobFilament()` from the
  *current job's sliced metadata* (`/server/files/metadata` → `filament_type` /
  `filament_colors`) while a print is loaded — see the K2 note below. `activeTray`
  is `null` on the K2 (no slot concept in metadata).
- `liveMaterialSource` / `nozzleDiameterSource` / `nozzleTypeSource` — `"printer"`
  when the value came from the device, `"config"` when it fell back to
  `printers.json`, or `"unknown"` when neither is set. The dashboard shows a small
  **с принтера** / **из конфигурации** tag on the material, and the `Сопло 0.4 мм`
  chip renders muted/dashed when the diameter is a config fallback rather than live.
  On the K2, a `"printer"` material tag means "the sliced material of the running
  job" (not an RFID/sensor read) — the honest live source Moonraker exposes there.

**Config fallback.** Beyond the declared `material`, `printers.json` accepts
optional `nozzleDiameterMm` and `nozzleType`. They are shown only as a labelled
**из конфигурации** fallback when the device does not report a live value (a
Creality-WebSocket printer, or any printer while offline) — never dressed up as
telemetry.

Partial MQTT deltas that omit these fields keep the last known value (merge in
`mergeBambuStatus`), so the chips do not flicker to "unknown" between reports.

### Creality K2 filament type — what is and isn't available

The K2 runs Klipper behind Moonraker, so its **nozzle diameter** is a real live
read (above). Its **active filament** comes from the **current job's sliced
metadata** (`parseMoonrakerJobFilament()`); the CFS `box`/`filament_rack` objects
are deliberately **not** a source. This was verified against the real unit
(K2-7F14) with `scripts/probe-k2.mjs`:

- **Sliced-file metadata (used)** — `GET /server/files/metadata?filename=<print_stats.filename>`
  returns the job's `filament_type` / `filament_name` and (slicer-dependent)
  `filament_colors`. `parseMoonrakerJobFilament` takes the primary material and
  first valid `#RRGGBB`, tagged `liveMaterialSource: "printer"`. Fetched only
  while a print is `printing`/`paused` with a known filename; otherwise the view
  falls back to the configured `material`. It is the *sliced* material, not a
  sensor read — same "setting, not measurement" caveat as the nozzle diameter.
- **CFS (`box` object) — not used.** The probe showed `box.state: "disconnect"`
  with every slot (`T1..T4`, positions A–D) reporting `material_type` /
  `color_value` / `remain_len` as `"-1"`, and **no field naming the active slot**.
  `filament_rack` likewise reported `material_type: "-1"`. Reading an "active
  filament" from these would mean inventing the slot, so it is left alone until a
  loaded CFS payload can be captured. (`material_type` is a coded `1XXXXX` value
  decoded via Creality's cloud `material_database.json`, also not available here.)

Use `scripts/probe-k2.mjs` to dump these raw payloads from real hardware:

```bash
docker cp apps/print-orchestrator/scripts/probe-k2.mjs \
  atelier-print-orchestrator:/tmp/probe-k2.mjs
docker exec atelier-print-orchestrator node /tmp/probe-k2.mjs 192.168.0.132 4408
```

**Limitation.** The A1 Combo has no physical nozzle-diameter sensor:
`nozzle_diameter` mirrors the **setting** in the printer/slicer. If the nozzle is
swapped without updating that setting, the reported diameter is stale — treat it
as "what the printer is configured for", not a measurement. Requires **LAN Mode**
and the printer's **access code** (`serial` + `accessCode`); without them the
Bambu adapter reports the printer as not configured and nothing is live.

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
- `POST /api/printers/:id/light` — body `{ "on": boolean }`; manual state is kept for 5 minutes (in memory; ±one poll tick), then `NIGHT_PRINT_WINDOW` takes over again
- `POST /api/queue` — add a job, body `{ title, printer?, material?, eta?, at?, night? }`
- `POST /api/queue/start-next` · `POST /api/queue/night/start` · `POST /api/queue/night/pick`
- `POST /api/automations/:id/toggle` — body `{ "on"?: boolean }` (omit to flip)
