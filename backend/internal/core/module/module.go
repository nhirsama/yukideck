package module

import (
	"context"
	"io/fs"
	"log/slog"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"yukideck/internal/config"
	"yukideck/internal/core/auth"
	"yukideck/internal/core/crypto"
	"yukideck/internal/core/messenger"
	"yukideck/internal/core/scheduler"
)

// Deps bundles stable platform core capabilities injected into every module.
// Modules MUST only depend on core packages and NEVER import another module directly.
type Deps struct {
	Config    *config.Config
	Logger    *slog.Logger
	DB        *pgxpool.Pool
	Crypto    *crypto.Box
	Messenger messenger.Notifier
	Scheduler *scheduler.Engine
}

// Module is the lifecycle contract implemented by every pluggable business module.
type Module interface {
	Meta() Meta
	Migrations() fs.FS
	RegisterRoutes(r chi.Router)
	RegisterPermissions(reg *auth.PermissionRegistry)
	RegisterJobs(ctx context.Context, sched *scheduler.Engine) error
	RegisterCommands(bus *messenger.CommandBus)
}

// BaseModule provides no-op defaults for optional lifecycle hooks so modules only implement what they need.
type BaseModule struct{}

func (BaseModule) Migrations() fs.FS                                           { return nil }
func (BaseModule) RegisterRoutes(chi.Router)                                   {}
func (BaseModule) RegisterPermissions(*auth.PermissionRegistry)                {}
func (BaseModule) RegisterJobs(context.Context, *scheduler.Engine) error       { return nil }
func (BaseModule) RegisterCommands(*messenger.CommandBus)                      {}
