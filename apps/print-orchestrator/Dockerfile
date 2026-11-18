# Both dependency stages use the same verified Node release and lockfile.
FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS dependency-base

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./

FROM dependency-base AS build
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

FROM dependency-base AS production-deps
RUN pnpm install --prod --frozen-lockfile

# Ship glibc for the optional Orca AppImage. Copy the Node executable and
# locked application dependencies so npm, Corepack and pnpm stay in the
# build stages. Keep these runtime layers independent of src/ and config/
# so ordinary code changes reuse the Orca system library layer below.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS runtime-deps

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3100

WORKDIR /app

# Preserve the runtime UID and home for the entrypoint and mounted slicer.
RUN groupadd --gid 1000 node \
    && useradd --uid 1000 --gid node --shell /bin/bash --create-home node \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates gosu libatomic1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=production-deps /usr/local/bin/node /usr/local/bin/node
COPY --from=production-deps /app/package.json ./package.json
COPY --from=production-deps /app/node_modules ./node_modules

# ── OrcaSlicer system libraries (SOURCE-INDEPENDENT, 564 MB) ────────────────
# The system libraries OrcaSlicer's Linux AppImage links against (it does not
# bundle the GTK/WebKit/GL stack, so the read-only mounted binary needs them
# present just to load — the boot-time version probe loads it too). Reached only
# by `production-orca` (selected by compose.orca.yml) together with the
# ORCA_HOST_DIR mount; the default deployment ships the lean image.
# Kept lean with --no-install-recommends; apt lists removed to shrink the layer.
FROM runtime-deps AS orca-deps

RUN DEBIAN_FRONTEND=noninteractive apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libgtk-3-0 \
      libwebkit2gtk-4.0-37 \
      libgl1 \
      libgl1-mesa-dri \
      libegl1 \
      libglu1-mesa \
      libnss3 \
      libxtst6 \
      libxrandr2 \
      libxss1 \
      libxi6 \
      libxcursor1 \
      libxcomposite1 \
      libxdamage1 \
      libgomp1 \
      libfontconfig1 \
      fontconfig \
      libdbus-1-3 \
      libsecret-1-0 \
      libnotify4 \
      libsm6 \
      libice6 \
    && rm -rf /var/lib/apt/lists/*

# ── Layer order ─────────────────────────────────────────────────────────────
# The two shipping targets are `production` (lean, on `runtime-deps`) and
# `production-orca` (on `orca-deps`). Each applies the SAME application payload
# — the four COPY/RUN lines below — and then its identity block.
#
# The payload is REPEATED in both leaves rather than shared through a common
# ancestor, and that is the whole point. The old layout put the payload in a
# `runtime-base` stage and derived `orca-runtime` FROM it, which meant the
# 564 MB apt layer sat AFTER `COPY --from=build /app/dist`. dist/ changes on
# every real commit, so the apt layer's cache key changed on every real commit:
# BuildKit re-ran the install and kept BOTH results. Eight deploys left eight
# 758 MB cache records — 5.9 GB of build cache for one unchanging layer, and
# ~1-2 min of avoidable apt traffic per deploy.
#
# With the heavy layer moved AHEAD of the payload it is invalidated only by a
# base-image or lockfile change, so ordinary commits reuse it. The cost is these
# four lines existing twice: KEEP THE TWO PAYLOAD BLOCKS IDENTICAL.
#
# ── Build identity ──────────────────────────────────────────────────────────
# Surfaced three ways, because each answers a different question:
#   * OCI labels -> `docker image inspect`, "what is in this image"
#   * ENV        -> `GET /version`, "what is actually running"
#   * deploy.sh  -> reads the label of the image a container was started from
#
# Declared LAST **in every leaf stage**, and repeated rather than inherited.
# Both halves of that rule are load-bearing.
#
# "Last" — an `ARG` invalidates the build cache for every instruction that
# FOLLOWS it, so declaring these near the top would rebuild `pnpm install --prod`
# and the apt layers on every commit, turning a metadata change into a new
# rootfs. Down here only image CONFIG changes: the image id moves, the layers do
# not.
#
# "Repeated, not inherited" — ARG values in scope and inherited ENV both feed the
# cache key of any RUN that follows them, so an identity block declared in a
# shared ancestor re-executed the apt layer on EVERY commit and produced a fresh
# rootfs digest every time. `docker history` showed it plainly:
#
#   RUN |3 GIT_COMMIT=<sha> BUILD_TIME=<t> GIT_DIRTY=0 /bin/sh -c apt-get …
#
# deploy.sh decides "did anything really change?" by comparing rootfs layers and
# uses that answer to decide whether recreating the orchestrator mid-print is
# necessary. A churning rootfs made every dashboard-only commit look like an
# orchestrator change, which armed the active-print gate and blocked deploys
# that had no business touching the orchestrator at all.
#
# Verified: two builds of the same tree with different GIT_COMMIT produce
# identical `RootFS.Layers` for BOTH `production` and `production-orca`.

FROM runtime-deps AS production

# -- application payload (keep identical to `production-orca` below) ---------
COPY --from=build /app/dist ./dist
# Default real-printer config; a compose volume can override /app/config. The
# real printers.json is excluded via .dockerignore, so only the example ships.
COPY config ./config
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Persisted-state mount point, owned by the runtime user for a fresh volume.
RUN mkdir -p /app/data && chown -R node:node /app/data

EXPOSE 3100

# Starts as root only to chown the data volume, then execs `node` as UID 1000.
# --experimental-sqlite enables the built-in node:sqlite driver (required on
# Node 22; a harmless no-op on newer runtimes); the warning is silenced so it
# does not repeat on every boot.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--experimental-sqlite", "--disable-warning=ExperimentalWarning", "dist/src/server.js"]

ARG GIT_COMMIT=""
ARG BUILD_TIME=""
ARG GIT_DIRTY="0"
LABEL org.opencontainers.image.revision="$GIT_COMMIT"
LABEL org.opencontainers.image.created="$BUILD_TIME"
LABEL org.opencontainers.image.title="atelier-print-orchestrator"
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_TIME=$BUILD_TIME
ENV GIT_DIRTY=$GIT_DIRTY

FROM orca-deps AS production-orca

# -- application payload (keep identical to `production` above) --------------
COPY --from=build /app/dist ./dist
COPY config ./config
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /app/data && chown -R node:node /app/data

EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--experimental-sqlite", "--disable-warning=ExperimentalWarning", "dist/src/server.js"]

ARG GIT_COMMIT=""
ARG BUILD_TIME=""
ARG GIT_DIRTY="0"
LABEL org.opencontainers.image.revision="$GIT_COMMIT"
LABEL org.opencontainers.image.created="$BUILD_TIME"
LABEL org.opencontainers.image.title="atelier-print-orchestrator"
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_TIME=$BUILD_TIME
ENV GIT_DIRTY=$GIT_DIRTY
