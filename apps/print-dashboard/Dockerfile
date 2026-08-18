# Pinned STABLE nginx by exact version + digest (no floating tags): 1.30.4
# carries the fixes for CVE-2026-42533 (map+regex heap overflow),
# CVE-2026-60005 (slice/unnamed-capture memory disclosure) and CVE-2026-56434
# (SSI use-after-free). Update deliberately: bump the tag AND refresh the
# digest together (`docker inspect --format '{{index .RepoDigests 0}}' nginx:<tag>`),
# then re-run `nginx -t` in CI.
FROM nginx:1.30.4-alpine@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46

# Build identity — same rationale as the orchestrator: without it there is no way
# to tell whether the dashboard was updated alongside the backend, and a partial
# deploy (new API shape, old front-end) passes every health check while showing
# the operator a broken board.
# nginx.conf is an envsubst template: the image entrypoint renders it to
# /etc/nginx/conf.d/default.conf at container start, substituting
# ${ORCHESTRATOR_API_TOKEN} from the environment (see compose.yml).
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY index.html /usr/share/nginx/html/index.html
COPY styles /usr/share/nginx/html/styles
# Dashboard ES modules: entry (app.js) + root modules, the shared primitives
# (polling/inflight/format/chips), the per-feature controller/view folders and
# the board render/ folder.
COPY app.js api.js util.js nav.js cameraPlayers.js actions.js theme.js /usr/share/nginx/html/
COPY shared /usr/share/nginx/html/shared
COPY features /usr/share/nginx/html/features
COPY render /usr/share/nginx/html/render
COPY assets /usr/share/nginx/html/assets
COPY camera-webrtc.js /usr/share/nginx/html/camera-webrtc.js
COPY video-rtc.js /usr/share/nginx/html/video-rtc.js

EXPOSE 8080

# ── Build identity ──────────────────────────────────────────────────────────
# LABELs only — never a RUN that writes a file — and declared LAST. Labels live
# in image CONFIG, so they change the image id without touching a filesystem
# layer; an ARG placed earlier would additionally invalidate every COPY below it
# and rebuild the whole asset tree on each commit. Both properties matter: they
# keep an otherwise-unchanged rebuild byte-identical, which is what lets
# deploy.sh tell a real change from a metadata one.
ARG GIT_COMMIT=""
ARG BUILD_TIME=""
LABEL org.opencontainers.image.revision="$GIT_COMMIT"
LABEL org.opencontainers.image.created="$BUILD_TIME"
LABEL org.opencontainers.image.title="atelier-print-dashboard"
