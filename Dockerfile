# syntax=docker/dockerfile:1
# Panel only. The Mac drive-agent stays on the host (port 4371, /Volumes).

FROM --platform=linux/arm64 node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM --platform=linux/arm64 node:22-bookworm-slim AS build
WORKDIR /app
# 768 MiB heap leaves room in the 1536 MiB Mac Docker VM. Do not raise this
# while the VM stays at 1536 MiB.
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=768 \
    SKLAD_DOCKER_BUILD=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npx tsc --noEmit --pretty false --incremental false -p tsconfig.docker.json

FROM --platform=linux/arm64 node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=4317 \
    HOSTNAME=0.0.0.0 \
    SKLAD_DATA_DIR=/var/lib/sklad
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY docker/panel-entrypoint.sh /panel-entrypoint.sh
RUN chmod 755 /panel-entrypoint.sh && mkdir -p /var/lib/sklad
EXPOSE 4317
ENTRYPOINT ["/panel-entrypoint.sh"]
CMD ["node", "server.js"]
