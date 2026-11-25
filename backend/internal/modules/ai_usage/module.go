package ai_usage

import (
	"embed"
	"io/fs"

	"github.com/go-chi/chi/v5"

	"yukideck/internal/core/auth"
	"yukideck/internal/core/module"
)

const (
	PermissionIngest = "ai-usage:ingest"
	PermissionRead   = "ai-usage:read"
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
	svc := NewService(store)
	handler := NewHandler(svc, deps.Config.RequestMaxBodyBytes, deps.Logger)
	return &Module{svc: svc, handler: handler}
}

func (m *Module) Meta() module.Meta {
	return module.Meta{
		ID:          "ai-usage",
		Name:        "AI 用量统计",
		Description: "跨设备汇总 Claude Code、Codex、Antigravity、Pi 等 Agent 的小时级 Token、等效费用与工具调用统计",
		APIPrefix:   "/api/v1/ai-usage",
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
		Key:         PermissionIngest,
		ModuleID:    "ai-usage",
		ModuleName:  "AI 用量统计",
		Label:       "上报 AI 用量切片",
		Description: "允许本地采集探针向 /api/v1/ai-usage/ingest 幂等推送小时×会话用量切片",
	}, nil)
	reg.Register(auth.PermissionDef{
		Key:         PermissionRead,
		ModuleID:    "ai-usage",
		ModuleName:  "AI 用量统计",
		Label:       "读取 AI 用量统计",
		Description: "允许读取用量总览、趋势、热力图、会话明细与工具调用排行（不含设备/别名/单价管理）",
	}, nil)
}
