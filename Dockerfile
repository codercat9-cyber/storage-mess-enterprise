# STORAGE&MESS Enterprise — сервер и веб-клиент в одном образе.
#   docker build -t storage-mess-enterprise .
# Запуск и настройка — docker-compose.yml и docs/DOCKER.md.

ARG NODE=22-bookworm

# ── веб-клиент: адрес сервера = адрес страницы (как у корпоративного стенда)
FROM node:${NODE} AS web
WORKDIR /src/web-client
COPY web-client/package.json web-client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web-client/ ./
RUN VITE_SAME_ORIGIN=1 npx vite build

# ── сервер: нативные модули (better-sqlite3, sharp, mediasoup) собираются здесь
FROM node:${NODE} AS server
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

# ── итоговый образ: только то, что нужно для работы
FROM node:${NODE}-slim
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    LAN_DISCOVERY=0
WORKDIR /app/server
COPY --from=server --chown=node:node /src/server/package.json ./
COPY --from=server --chown=node:node /src/server/node_modules ./node_modules
COPY --from=server --chown=node:node /src/server/dist ./dist
COPY --from=web --chown=node:node /src/web-client/dist /app/web-client/dist
COPY --chown=node:node tools/docker/healthcheck.cjs /app/healthcheck.cjs
# База, файлы, аватары, журналы — на томах; certs — по желанию (HTTPS прямо в контейнере)
RUN mkdir -p data storage avatars/users avatars/groups logs certs && chown -R node:node /app
USER node
VOLUME ["/app/server/data", "/app/server/storage", "/app/server/avatars", "/app/server/logs"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "/app/healthcheck.cjs"]
CMD ["node", "dist/index.js"]
