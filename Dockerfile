# syntax=docker/dockerfile:1.7

# ===== Stage 1: SPA build =====
FROM node:20-bookworm-slim AS spa-builder
WORKDIR /src
COPY frontend/package.json frontend/pnpm-lock.yaml ./frontend/
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /src/frontend
RUN pnpm install --frozen-lockfile
WORKDIR /src
COPY backend/openapi.yaml ./backend/openapi.yaml
COPY frontend/ ./frontend/
WORKDIR /src/frontend
# vite.config.ts emits to ../backend/static/dist so the Go embed resolves.
RUN pnpm types:gen && pnpm build

# ===== Stage 2: Go build (CGO) =====
FROM golang:1.25-bookworm AS go-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY backend/go.mod backend/go.sum ./backend/
WORKDIR /src/backend
RUN go mod download
WORKDIR /src
COPY backend/ ./backend/
# Bring in the SPA bundle so //go:embed all:dist resolves.
COPY --from=spa-builder /src/backend/static/dist ./backend/static/dist
WORKDIR /src/backend
ARG VERSION=dev
ENV CGO_ENABLED=1
RUN go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" \
    -o /out/tfbp-server ./cmd/tfbp-server

# ===== Stage 3: runtime =====
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates wget \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --no-create-home --shell /usr/sbin/nologin --uid 10001 app \
    && mkdir -p /data /tmp/duckdb \
    && chown -R app:app /tmp/duckdb
COPY --from=go-builder /out/tfbp-server /usr/local/bin/tfbp-server
USER app
WORKDIR /data
ENV DUCKDB_PATH=/data/tfbp.duckdb
ENV DUCKDB_TEMP_DIR=/tmp/duckdb
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
    CMD wget -qO- --tries=1 --timeout=2 http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/tfbp-server"]
