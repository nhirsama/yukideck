package clipboard

import (
	"context"
	"embed"
	"io/fs"

	"github.com/go-chi/chi/v5"

	"yukideck/internal/core/module"
	"yukideck/internal/core/scheduler"
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
	hub := NewHub()
	svc := NewService(store, hub, deps.Config.ClipboardMaxBytes, deps.Logger)
	handler := NewHandler(svc, deps.Config.RequestMaxBodyBytes, deps.Config.ClipboardMaxBytes, deps.Logger)
	return &Module{
		svc:     svc,
		handler: handler,
	}
}

func (m *Module) Meta() module.Meta {
	return module.Meta{
		ID:          "clipboard",
		Name:        "剪切板",
		Description: "跨设备云端纯文本剪切板、实时同步编辑与 Markdown 预览",
		APIPrefix:   "/api/v1/clipboard",
	}
}

func (m *Module) Migrations() fs.FS {
	return migrationsFS
}

func (m *Module) RegisterRoutes(r chi.Router) {
	m.handler.RegisterRoutes(r)
}

func (m *Module) RegisterJobs(_ context.Context, sched *scheduler.Engine) error {
	if sched == nil {
		return nil
	}
	return sched.Upsert("clipboard:purge-expired", "*/15 * * * *", "", func(ctx context.Context) error {
		_, err := m.svc.PurgeExpired(ctx)
		return err
	})
}
