# Учебный каталог AD (LDAP) и RADIUS — только для показа, не для работы.
FROM node:22-bookworm-slim
WORKDIR /demo
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY directory-server.cjs radius-server.cjs ./
RUN mkdir -p /demo/state && chown -R node:node /demo
ENV DEMO_HOST=0.0.0.0 DEMO_STATE_DIR=/demo/state
USER node
EXPOSE 1389 9480 1812/udp
CMD ["sh", "-c", "node radius-server.cjs & exec node directory-server.cjs"]
