# syntax=docker/dockerfile:1
# Контекст сборки — корень репозитория: docker build -f panel/Dockerfile .

# ── агент для мостов (отдаётся панелью по /dl) ──
FROM golang:1.24-alpine AS agent
WORKDIR /src/agent
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ ./
ARG VERSION=dev
# Подпись релиза: передайте приватный ключ как BuildKit secret (он не попадает ни в слои образа, ни в историю):
#   docker build --secret id=agent_key,src=release.key ...
# Публичный ключ agent/release.pub должен лежать в репозитории. Без секрета релиз собирается неподписанным.
RUN --mount=type=secret,id=agent_key set -e; mkdir -p /out; \
    for arch in amd64 arm64; do \
      CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" \
        -o /out/popug-agent-linux-$arch ./cmd/popug-agent; \
    done; \
    echo "${VERSION}" > /out/VERSION; \
    cd /out && sha256sum popug-agent-linux-amd64 popug-agent-linux-arm64 > SHA256SUMS; cd /src/agent; \
    if [ -s /run/secrets/agent_key ] && [ -f release.pub ]; then \
      go build -o /tmp/popug-release ./cmd/popug-release; \
      for arch in amd64 arm64; do \
        /tmp/popug-release sign -key /run/secrets/agent_key -version "${VERSION}" -arch $arch -o /out/popug-agent-linux-$arch.sig /out/popug-agent-linux-$arch; \
      done; \
      cp release.pub /out/update.pub; \
    else echo "агент собран без подписи: обновление по кнопке отключено"; fi

# ── сервер и фронт ──
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY protocol/package.json protocol/
COPY panel/server/package.json panel/server/
COPY panel/web/package.json panel/web/
RUN npm ci
COPY protocol protocol
COPY panel panel
RUN npm run build -w panel/web && npm run build -w panel/server

# ── зависимости только для прода ──
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY protocol/package.json protocol/
COPY panel/server/package.json panel/server/
COPY panel/web/package.json panel/web/
RUN npm ci --omit=dev -w panel/server && npm cache clean --force

# ── итоговый образ ──
FROM node:22-alpine
ARG VERSION=dev
ENV NODE_ENV=production \
    PANEL_VERSION=${VERSION} \
    WEB_DIST=/app/panel/web/dist \
    AGENT_DIST=/app/agent-dist \
    MIGRATIONS_DIR=/app/panel/server/drizzle
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/panel/server/dist ./panel/server/dist
COPY --from=build /app/panel/server/drizzle ./panel/server/drizzle
COPY --from=build /app/panel/web/dist ./panel/web/dist
COPY --from=agent /out/ ./agent-dist/
COPY agent/install.sh agent/packaging/popug-agent.service ./agent-dist/
RUN chown -R node:node /app/agent-dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "panel/server/dist/server.js"]
