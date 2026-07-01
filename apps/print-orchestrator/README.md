# Albedo Atelier

Fastify service for future FDM and resin printer orchestration.

## Local development

```bash
npm install
npm run dev
```

## Docker

The service listens on `0.0.0.0` by default.

```bash
docker compose up -d --build print-orchestrator
```

## Endpoints

- `GET /health`
- `GET /ready`
- `GET /api/printers`
