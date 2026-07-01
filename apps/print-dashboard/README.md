# Print Dashboard

Minimal static dashboard for the print orchestration workspace.

The nginx container serves the page on port `8080` and proxies:

- `/api/print-orchestrator/*` to `http://print-orchestrator:3100/*`
