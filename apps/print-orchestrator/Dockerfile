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

FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS production

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3100

WORKDIR /app

RUN corepack enable
# su-exec lets the entrypoint drop from root to the unprivileged node user after
# fixing the data-volume ownership.
RUN apk add --no-cache su-exec

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
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/src/server.js"]
