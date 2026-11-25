package planner

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
	PermissionRead  = "planner:read"
	PermissionWrite = "planner:write"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

type Module struct {
	module.BaseModule
	svc     *Service
	handler *Handler
	worker  *WakeupWorker
}

func New(deps module.Deps) *Module {
	store := NewPGStore(deps.DB)
	worker := NewWakeupWorker(store, deps.Messenger, deps.Logger)
	svc := NewService(store, deps.Messenger, worker)
	handler := NewHandler(svc, deps.Config.RequestMaxBodyBytes, deps.Logger)
	return &Module{
		svc:     svc,
		handler: handler,
		worker:  worker,
	}
}

func (m *Module) Meta() module.Meta {
	return module.Meta{
		ID:          "planner",
		Name:        "日程与提醒",
		Description: "统一的待办清单、公历/农历日历计划与精确到分钟的多时间点独立推送",
		APIPrefix:   "/api/v1/planner",
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
		ModuleID:    "planner",
		ModuleName:  "日程与提醒",
		Label:       "读取日程与待办",
		Description: "允许读取事项列表、日历视图与推送历史",
	}, nil)
	reg.Register(auth.PermissionDef{
		Key:         PermissionWrite,
		ModuleID:    "planner",
		ModuleName:  "日程与提醒",
		Label:       "管理日程与待办",
		Description: "允许新建、编辑、删除、完成/恢复事项及触发测试推送",
	}, nil)
}

// RegisterJobs starts the event-driven single-timer wakeup loop tied to application context lifecycle.
func (m *Module) RegisterJobs(ctx context.Context, _ *scheduler.Engine) error {
	go m.worker.Run(ctx)
	return nil
}
