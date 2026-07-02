# Atelier

Workspace for Atelier services.

## Albedo Atelier

Start the local stack:

```bash
docker compose down
docker compose up -d --build
```

Endpoints:

- `GET http://localhost:3100/health`
- `GET http://localhost:3100/ready`
- `GET http://localhost:3100/api/dashboard` — full dashboard state in one payload
- `GET http://localhost:3100/api/printers`

See `apps/print-orchestrator/README.md` for the full API (per-section reads and printer/queue/automation actions).

Dashboard:

- `http://localhost:8090`

Both services bind published ports to `0.0.0.0` so they can be reached from local network devices when the host firewall allows it.
# Albedo-Atelier
