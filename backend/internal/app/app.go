package app

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"yukideck/internal/config"
	"yukideck/internal/core/auth"
	"yukideck/internal/core/crypto"
	"yukideck/internal/core/db"
	"yukideck/internal/core/httpx"
	"yukideck/internal/core/messenger"
	"yukideck/internal/core/messenger/drivers"
	"yukideck/internal/core/module"
	"yukideck/internal/core/scheduler"
	"yukideck/internal/webui"
)

// Version is injected at build time via -ldflags "-X yukideck/internal/app.Version=<tag>".
var Version = "dev"

type App struct {
	cfg       *config.Config
	logger    *slog.Logger
	pool      *pgxpool.Pool
	authSvc   *auth.Service
	msgSvc    *messenger.Service
	scheduler *scheduler.Engine
	modules   []module.Module
	router    http.Handler
}

// New wires the complete production App: DB migrations, OIDC, Messenger, Scheduler, Modules, and WebUI.
func New(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, logger *slog.Logger) (*App, error) {
	keyBytes, err := cfg.MasterKeyBytes()
	if err != nil {
		return nil, err
	}
	box, err := crypto.NewBox(keyBytes)
	if err != nil {
		return nil, err
	}

	authSvc, err := auth.NewService(ctx, cfg, box, auth.NewPGUserStore(pool), logger)
	if err != nil {
		return nil, err
	}

	driverReg := messenger.NewRegistry()
	driverReg.Register(drivers.NewTelegramDriver(cfg.ExternalHTTPTimeout))

	cmdBus := messenger.NewCommandBus()
	msgSvc := messenger.NewService(
		messenger.NewPGStore(pool),
		driverReg,
		cmdBus,
		box,
		cfg.PublicBaseURL,
		cfg.ExternalHTTPTimeout,
		logger,
	)

	sched := scheduler.New(cfg.ExternalHTTPTimeout*3, logger)

	deps := module.Deps{
		Config:    cfg,
		Logger:    logger,
		DB:        pool,
		Crypto:    box,
		Messenger: msgSvc,
		Scheduler: sched,
	}
	allModules := BuildModules(deps)

	a := newWithDeps(cfg, logger, pool, authSvc, msgSvc, sched, allModules, webui.EmbeddedFS())

	if err := a.runMigrations(ctx); err != nil {
		return nil, err
	}
	if err := a.registerJobs(ctx); err != nil {
		return nil, err
	}
	return a, nil
}

func newWithDeps(
	cfg *config.Config,
	logger *slog.Logger,
	pool *pgxpool.Pool,
	authSvc *auth.Service,
	msgSvc *messenger.Service,
	sched *scheduler.Engine,
	candidates []module.Module,
	uiFS fs.FS,
) *App {
	enabledModules := make([]module.Module, 0, len(candidates))
	for _, m := range candidates {
		if cfg.IsModuleDisabled(m.Meta().ID) {
			if logger != nil {
				logger.Info("module disabled by config", "module", m.Meta().ID)
			}
			continue
		}
		m.RegisterCommands(msgSvc.CommandBus())
		enabledModules = append(enabledModules, m)
	}

	a := &App{
		cfg:       cfg,
		logger:    logger,
		pool:      pool,
		authSvc:   authSvc,
		msgSvc:    msgSvc,
		scheduler: sched,
		modules:   enabledModules,
	}
	a.router = a.buildRouter(uiFS)
	return a
}

func (a *App) runMigrations(ctx context.Context) error {
	sources := []db.MigrationSource{
		{ModuleID: "core_auth", FS: auth.Migrations()},
		{ModuleID: "core_messenger", FS: messenger.Migrations()},
	}
	for _, m := range a.modules {
		if mfs := m.Migrations(); mfs != nil {
			sources = append(sources, db.MigrationSource{
				ModuleID: "mod_" + m.Meta().ID,
				FS:       mfs,
			})
		}
	}
	return db.RunMigrations(ctx, a.pool, a.logger, sources)
}

func (a *App) registerJobs(ctx context.Context) error {
	for _, m := range a.modules {
		if err := m.RegisterJobs(ctx, a.scheduler); err != nil {
			return fmt.Errorf("register jobs for module %q: %w", m.Meta().ID, err)
		}
	}
	return nil
}

func (a *App) buildRouter(uiFS fs.FS) http.Handler {
	r := chi.NewRouter()
	r.Use(httpx.Recoverer(a.logger))
	r.Use(httpx.RequestLogger(a.logger))
	r.Use(httpx.CORSMiddleware(a.cfg.CORSAllowedOrigins))

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		httpx.JSON(w, http.StatusOK, HealthResponse{Status: "ok", Version: Version})
	})

	msgHandler := messenger.NewHandler(a.msgSvc, a.cfg.RequestMaxBodyBytes, a.logger)

	// Guarantee unknown /api/* paths always return JSON 404, never SPA HTML.
	apiNotFound := func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteError(w, r, a.logger, httpx.NotFound("API 路由不存在"))
	}

	r.Route("/api/v1", func(api chi.Router) {
		api.NotFound(apiNotFound)
		api.Get("/meta", func(w http.ResponseWriter, _ *http.Request) {
			metas := make([]module.Meta, 0, len(a.modules))
			for _, m := range a.modules {
				meta := m.Meta()
				if meta.APIPrefix == "" {
					meta.APIPrefix = "/api/v1/" + meta.ID
				}
				metas = append(metas, meta)
			}
			httpx.JSON(w, http.StatusOK, AppMeta{
				App:       "YukiDeck",
				Version:   Version,
				UIEnabled: a.cfg.UIEnabled && uiFS != nil,
				Modules:   metas,
			})
		})

		api.Route("/auth", a.authSvc.RegisterRoutes)

		// Public token-secured Normalized PushURL and inbound channel webhooks
		api.Route("/push", msgHandler.RegisterPublicPushRoutes)
		api.Route("/messenger/webhook", msgHandler.RegisterPublicWebhookRoutes)

		// Authenticated platform & module routes
		api.Group(func(priv chi.Router) {
			priv.Use(a.authSvc.RequireAuth)
			priv.Route("/messenger", msgHandler.RegisterProtectedRoutes)
			for _, m := range a.modules {
				mod := m
				priv.Route("/"+mod.Meta().ID, func(mr chi.Router) {
					mod.RegisterRoutes(mr)
				})
			}
		})
	})

	r.HandleFunc("/api", apiNotFound)
	r.HandleFunc("/api/*", apiNotFound)

	// Embedded React SPA (or 404 when UI_ENABLED=false for separated deployment)
	r.NotFound(webui.NewHandler(uiFS, a.cfg.UIEnabled).ServeHTTP)
	return r
}

func (a *App) Handler() http.Handler { return a.router }

func (a *App) StartBackground() {
	if a.scheduler != nil {
		a.scheduler.Start()
	}
}

func (a *App) Shutdown(ctx context.Context) error {
	if a.scheduler != nil {
		if err := a.scheduler.Stop(ctx); err != nil {
			return err
		}
	}
	if a.pool != nil {
		a.pool.Close()
	}
	return nil
}
