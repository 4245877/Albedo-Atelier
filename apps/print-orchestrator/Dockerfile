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

# The production stage runs on Debian (glibc), NOT Alpine (musl), because it must
# be able to execute the mounted OrcaSlicer AppImage (ORCA_SLICER_CMD=/opt/orca/
# AppRun) — a glibc binary that cannot run on musl. The build stage stays on
# Alpine: it only emits portable JS (dist/), copied in below. Pinned by digest
# like the build base; refresh with:
#   docker inspect --format '{{index .RepoDigests 0}}' node:22-bookworm-slim
FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS production

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3100

WORKDIR /app

RUN corepack enable
# gosu drops the entrypoint from root to the unprivileged node user after fixing
# the data-volume ownership (Debian's equivalent of Alpine's su-exec). The rest
# are OrcaSlicer's runtime dependencies: its Linux AppImage links the system
# GTK/WebKit/GL stack instead of bundling it, so the read-only mounted binary
# needs them present just to load — the boot-time version probe loads it too.
# Kept lean with --no-install-recommends; apt lists removed to shrink the layer.
RUN apt-get update && apt-get install -y --no-install-recommends \
      gosu \
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
