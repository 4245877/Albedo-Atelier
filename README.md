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

The orchestrator's mutable state — the operator queue, the event feed and
today's counters — is written to a JSON file on the `orchestrator-data` Docker
volume (`/app/data/state.json`), so it survives `docker compose down` and
container recreation. Live telemetry is not persisted (it is re-polled). See the
service README for details and `STATE_FILE_PATH`.

### Ports & security

The **orchestrator control API is not published to the host** — it is reachable
only over the compose network. Only the dashboard (`8090`) and the go2rtc WebRTC
media port (`8555`, required for live K2 video) are exposed on `0.0.0.0`; the
go2rtc API (`1985`) is bound to localhost.

> ⚠️ **Trust assumption:** the dashboard on `8090` is served on the LAN and
> proxies the control API same-origin (`/api/print-orchestrator/*`). Unless
> `ORCHESTRATOR_API_TOKEN` is set, that means **anyone who can reach `8090` on
> the LAN can drive the printers** (pause/resume/cancel/light) with no
> authentication — the guard logs a warning on startup when it is unset. This is
> acceptable only on a trusted home network. **Do not expose `8090` to an
> untrusted network** (public IP, port-forward, shared VLAN). To gate it, set
> `ORCHESTRATOR_API_TOKEN` (and inject it from the proxy) or put HTTP Basic Auth
> in front of nginx.

Package manager: **pnpm** (`corepack enable`). The dashboard is static assets;
`apps/print-orchestrator` is the only Node project.

