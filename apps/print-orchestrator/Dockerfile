FROM node:22-alpine AS build

WORKDIR /app

# Pin pnpm from the package.json "packageManager" field via corepack.
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

FROM node:22-alpine AS production

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3100

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune

COPY --from=build /app/dist ./dist
# Default real-printer config; a compose volume can override /app/config.
COPY config ./config

EXPOSE 3100

CMD ["node", "dist/src/server.js"]
