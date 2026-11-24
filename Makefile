.PHONY: dev-backend dev-frontend build-frontend build-embed build-api sqlc test clean

sqlc:
	cd backend && sqlc generate

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
	cd backend && CGO_ENABLED=0 go build -tags embed_ui -trimpath -ldflags="-s -w" -o bin/yukideck ./cmd/server

build-api:
	cd backend && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/yukideck-api ./cmd/server

test:
	cd backend && go test ./... -v
	cd frontend && pnpm typecheck && pnpm build

clean:
	rm -rf backend/bin frontend/dist backend/internal/webui/dist
	mkdir -p backend/internal/webui/dist && touch backend/internal/webui/dist/.gitkeep
