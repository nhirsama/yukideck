.PHONY: dev-backend dev-frontend build-frontend build-embed build-api build-collector sqlc types gen update-prices test clean

VERSION ?= dev
LDFLAGS := -s -w -X yukideck/internal/app.Version=$(VERSION)
SQLC_PKG := github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1
TYGO_PKG := github.com/gzuidhof/tygo@v0.2.21
MODEL_PRICES_URL ?= https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.json

sqlc:
	cd backend && go run $(SQLC_PKG) generate

types:
	cd backend && go run $(TYGO_PKG) generate

gen: sqlc types

update-prices:
	curl -fsSL "$(MODEL_PRICES_URL)" -o backend/internal/modules/ai_usage/model_prices_and_context_window.json

dev-backend:
	cd backend && go run ./cmd/server

dev-frontend:
	cd frontend && pnpm dev

build-frontend:
	cd frontend && pnpm build
	rm -rf backend/internal/webui/dist
	mkdir -p backend/internal/webui/dist
	cp -r frontend/dist/. backend/internal/webui/dist/

build-embed: build-frontend
	cd backend && CGO_ENABLED=0 go build -tags embed_ui -trimpath -ldflags="$(LDFLAGS)" -o bin/yukideck ./cmd/server

build-api:
	cd backend && CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/yukideck-api ./cmd/server

build-collector:
	cargo build --release --manifest-path collector/Cargo.toml

test:
	cd backend && go test ./... -v
	cd frontend && pnpm typecheck && pnpm build

clean:
	rm -rf backend/bin frontend/dist backend/internal/webui/dist
	mkdir -p backend/internal/webui/dist && touch backend/internal/webui/dist/.gitkeep
