# Stage 1: Build React Frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /src/frontend
RUN corepack enable
COPY frontend/package.json frontend/pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY frontend/ ./
RUN pnpm build

# Stage 2: Build Go Backend with embedded Frontend UI
FROM golang:1.24-alpine AS backend-builder
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum* ./
RUN go mod download
COPY backend/ ./
COPY --from=frontend-builder /src/frontend/dist ./internal/webui/dist
RUN CGO_ENABLED=0 go build -tags embed_ui -trimpath -ldflags="-s -w" -o /out/yukideck ./cmd/server

# Stage 3: Minimal Runtime Image (connects to external PostgreSQL via DATABASE_URL)
FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=backend-builder /out/yukideck /app/yukideck
EXPOSE 8080
ENTRYPOINT ["/app/yukideck"]
