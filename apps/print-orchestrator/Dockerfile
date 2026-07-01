FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json knexfile.ts ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS production

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3100

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

EXPOSE 3100

CMD ["node", "dist/src/server.js"]
