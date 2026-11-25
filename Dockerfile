# syntax=docker/dockerfile:1

# Stage 1: Build React Frontend on native build host architecture
FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend-builder
WORKDIR /src/frontend
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN corepack install
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY frontend/ ./
RUN pnpm build

# Stage 2: Cross-compile Go Backend with embedded Frontend UI
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS backend-builder
ARG TARGETOS=linux
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY backend/ ./
COPY --from=frontend-builder /src/frontend/dist ./internal/webui/dist
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -tags embed_ui -trimpath -ldflags="-s -w -X yukideck/internal/app.Version=${VERSION}" -o /out/yukideck ./cmd/server

# Stage 3: Minimal Runtime Image (connects to external PostgreSQL via DATABASE_URL)
FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=backend-builder /out/yukideck /app/yukideck
EXPOSE 8080
ENTRYPOINT ["/app/yukideck"]
