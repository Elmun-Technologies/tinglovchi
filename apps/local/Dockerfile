# SUHBAT — server (masalan, Hetzner) uchun konteyner. Qurish: apps/local papkasidan.
FROM node:22-alpine

ENV NODE_ENV=production \
    SUHBAT_DATA_DIR=/data \
    SUHBAT_HOST=0.0.0.0 \
    SUHBAT_PORT=4780 \
    SUHBAT_TRUST_PROXY=1

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.mjs ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4780

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- --header="Host: localhost:4780" http://127.0.0.1:4780/style.css >/dev/null || exit 1

CMD ["node", "server.mjs"]
