package assets

import (
	"embed"
	"io/fs"

	"github.com/go-chi/chi/v5"

	"yukideck/internal/core/module"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

type Module struct {
	module.BaseModule
	svc     *Service
	handler *Handler
}

func New(deps module.Deps) *Module {
	store := NewPGStore(deps.DB)
	rates := NewRatesProvider(store, deps.Config.ExternalHTTPTimeout, deps.Logger)
	svc := NewService(store, rates, deps.Logger)
	handler := NewHandler(svc, deps.Config.RequestMaxBodyBytes, deps.Logger)
	return &Module{
		svc:     svc,
		handler: handler,
	}
}

func (m *Module) Meta() module.Meta {
	return module.Meta{
		ID:          "assets",
		Name:        "物品资产",
		Description: "个人物品与资产管理、多币种折算、日均成本与两级分类整理",
		APIPrefix:   "/api/v1/assets",
	}
}

func (m *Module) Migrations() fs.FS {
	return migrationsFS
}

func (m *Module) RegisterRoutes(r chi.Router) {
	m.handler.RegisterRoutes(r)
}
