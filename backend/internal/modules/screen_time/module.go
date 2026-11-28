package screen_time

import (
	"context"
	"embed"
	"io/fs"

	"github.com/go-chi/chi/v5"

	"yukideck/internal/core/auth"
	"yukideck/internal/core/module"
	"yukideck/internal/core/scheduler"
)

const (
	ModuleID       = "screen-time"
	PermissionRead = "screen-time:read"
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
	client := NewHTTPWakaTimeClient(deps.Config.ExternalHTTPTimeout)
	svc := NewService(store, deps.Crypto, client, deps.Logger)
	handler := NewHandler(svc, deps.Config.RequestMaxBodyBytes, deps.Logger)
	return &Module{svc: svc, handler: handler}
}

func (m *Module) Meta() module.Meta {
	return module.Meta{
		ID:          ModuleID,
		Name:        "使用时间",
		Description: "零侵入同步 WakaTime 编码记录并永久归档，提供多维趋势、年度热力图、24 小时活跃分布与每日编码时间轴",
		APIPrefix:   "/api/v1/" + ModuleID,
	}
}

func (m *Module) Migrations() fs.FS {
	return migrationsFS
}

func (m *Module) RegisterRoutes(r chi.Router) {
	m.handler.RegisterRoutes(r)
}

func (m *Module) RegisterPermissions(reg *auth.PermissionRegistry) {
	reg.Register(auth.PermissionDef{
		Key:         PermissionRead,
		ModuleID:    ModuleID,
		ModuleName:  "使用时间",
		Label:       "读取使用时间统计",
		Description: "允许读取编码时长总览、趋势、热力图、多维排行、24 小时分布与每日时间轴（不含配置修改与同步触发）",
	}, nil)
}

func (m *Module) RegisterJobs(_ context.Context, sched *scheduler.Engine) error {
	// Poll every 30 minutes for users whose 7-day full 14-day archival cadence is due.
	return sched.Upsert("screen-time:scheduled-sync", "*/30 * * * *", "UTC", m.svc.RunScheduledSyncs)
}
