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

### Ports & security

The **orchestrator control API is not published to the host** — it is reachable
only over the compose network (via the dashboard proxy), so pause/resume/cancel
cannot be driven directly from the LAN. Only the dashboard (`8090`) and the
go2rtc WebRTC media port (`8555`, required for live K2 video) are exposed on
`0.0.0.0`; the go2rtc API (`1985`) is bound to localhost.

For defence in depth, set `ORCHESTRATOR_API_TOKEN` in `.env` to require a bearer
token on state-changing requests. See `.env.example`.

Package manager: **pnpm** (`corepack enable`). The dashboard is static assets;
`apps/print-orchestrator` is the only Node project.



Примерная палитра светлой темы:
Жемчужный блик #FAF7FB
Фарфоровая кожа #F3EEF2
Холодная тень кожи  #D9CDD4
Обсидиановый волос #16141D
Индиговый отлив #3E3A57
Полуночное крыло #1F2430
Слоновая кость рогов  #E5DED0
Топазовый ирис  #D6C652
Соборный белый #F8F5FA
Кружевной серо-голубой `#BFC6D6
Старинное золото  #C49A3A
Аметистовая слива #6D4C78
