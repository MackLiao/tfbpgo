# syntax=docker/dockerfile:1.7

# Base images are digest-pinned (tag kept for readability): an upstream
# re-tag must not silently change the toolchain/libc under a CGO binary,
# and rebuilds of the same git tag stay reproducible. Bump tag + digest
# together (digests fetched 2026-06-10).
# ===== Stage 1: SPA build =====
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS spa-builder
WORKDIR /src
COPY frontend/package.json frontend/pnpm-lock.yaml ./frontend/
# Pin pnpm to match the lockfile's pnpm-lock.yaml version (9.x). Avoid
# `pnpm@latest` so image rebuilds are reproducible across pnpm major bumps.
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /src/frontend
RUN pnpm install --frozen-lockfile
WORKDIR /src
COPY backend/openapi.yaml ./backend/openapi.yaml
COPY frontend/ ./frontend/
WORKDIR /src/frontend
# vite.config.ts emits to ../backend/static/dist so the Go embed resolves.
RUN pnpm types:gen && pnpm build

# ===== Stage 2: Go build (CGO) =====
# 1.25.10 picks up the 1.25.8–1.25.10 stdlib security fixes (crypto/tls
# KeyUpdate DoS GO-2026-4870, net/textproto, crypto/x509) — keep ≥ this patch.
FROM golang:1.25.10-bookworm@sha256:154bd7001b6eb339e88c964442c0ad6ed5e53f09844cc818a41ce4ecb3ce3b43 AS go-builder
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
FROM debian:bookworm-slim@sha256:0104b334637a5f19aa9c983a91b54c89887c0984081f2068983107a6f6c21eeb
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
# Probe /readyz (artifact open + DuckDB canary + cache), not /healthz: a
# container serving a broken artifact must go unhealthy so `restart:
# unless-stopped` recycles it instead of half-serving. /readyz responds in
# <2s even under load (registered outside the throttle group).
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
    CMD wget -qO- --tries=1 --timeout=2 http://127.0.0.1:8080/readyz || exit 1
ENTRYPOINT ["/usr/local/bin/tfbp-server"]
