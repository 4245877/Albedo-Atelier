# Base image pinned by digest (tag kept for humans) for reproducible builds.
# Refresh with: docker inspect --format '{{index .RepoDigests 0}}' node:22-alpine
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS build

WORKDIR /app

# Pin pnpm from the package.json "packageManager" field via corepack.
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

# The production stage runs on Debian (glibc), NOT Alpine (musl), so a mounted
# OrcaSlicer AppImage (a glibc binary) CAN run in the `production-orca` variant
# below. The build stage stays on Alpine: it only emits portable JS (dist/),
# copied in below. Pinned by digest like the build base; refresh with:
#   docker inspect --format '{{index .RepoDigests 0}}' node:22-bookworm-slim
#
# This is the LEAN default image: no GTK/WebKit/GL. The heavy OrcaSlicer system
# libraries live only in the `production-orca` stage, selected by
# compose.orca.yml — they must never creep into the base image.
FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS production

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3100

WORKDIR /app

RUN corepack enable
# gosu drops the entrypoint from root to the unprivileged node user after fixing
# the data-volume ownership (Debian's equivalent of Alpine's su-exec).
RUN apt-get update && apt-get install -y --no-install-recommends \
      gosu \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune

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

# ── OrcaSlicer host-runtime variant ─────────────────────────────────────────
# The base image plus the system libraries OrcaSlicer's Linux AppImage links
# against (it does not bundle the GTK/WebKit/GL stack, so the read-only mounted
# binary needs them present just to load — the boot-time version probe loads it
# too). Selected ONLY by compose.orca.yml (`target: production-orca`) together
# with the ORCA_HOST_DIR mount; the default deployment ships the lean image.
# Kept lean with --no-install-recommends; apt lists removed to shrink the layer.
FROM production AS production-orca

RUN apt-get update && apt-get install -y --no-install-recommends \
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
