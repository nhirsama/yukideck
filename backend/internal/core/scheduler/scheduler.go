package scheduler

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/robfig/cron/v3"
)

// JobFunc is executed with a timeout-bounded context on each trigger.
type JobFunc func(ctx context.Context) error

// Engine wraps robfig/cron with keyed hot-upsert/remove, panic recovery, and bounded job timeouts.
type Engine struct {
	mu         sync.Mutex
	c          *cron.Cron
	entries    map[string]cron.EntryID
	jobTimeout time.Duration
	logger     *slog.Logger
}

func New(jobTimeout time.Duration, logger *slog.Logger) *Engine {
	if jobTimeout <= 0 {
		jobTimeout = 30 * time.Second
	}
	return &Engine{
		c:          cron.New(cron.WithParser(cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor))),
		entries:    make(map[string]cron.EntryID),
		jobTimeout: jobTimeout,
		logger:     logger,
	}
}

func (e *Engine) Start() {
	e.c.Start()
}

// Stop stops scheduling new runs and waits for running jobs up to ctx deadline.
func (e *Engine) Stop(ctx context.Context) error {
	stopCtx := e.c.Stop()
	select {
	case <-stopCtx.Done():
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Upsert registers or replaces a job identified by key (e.g. "cron:job:12" or "assets:daily-check").
func (e *Engine) Upsert(key, cronExpr, timezone string, fn JobFunc) error {
	spec := strings.TrimSpace(cronExpr)
	if spec == "" {
		return fmt.Errorf("empty cron expression for job %q", key)
	}
	if tz := strings.TrimSpace(timezone); tz != "" {
		if _, err := time.LoadLocation(tz); err != nil {
			return fmt.Errorf("invalid timezone %q: %w", tz, err)
		}
		if !strings.HasPrefix(spec, "CRON_TZ=") && !strings.HasPrefix(spec, "TZ=") {
			spec = "CRON_TZ=" + tz + " " + spec
		}
	}

	wrapped := func() {
		defer func() {
			if rec := recover(); rec != nil && e.logger != nil {
				e.logger.Error("scheduled job panicked", "key", key, "panic", rec)
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), e.jobTimeout)
		defer cancel()
		if err := fn(ctx); err != nil && e.logger != nil {
			e.logger.Error("scheduled job failed", "key", key, "err", err)
		}
	}

	e.mu.Lock()
	defer e.mu.Unlock()

	if existingID, ok := e.entries[key]; ok {
		e.c.Remove(existingID)
		delete(e.entries, key)
	}
	id, err := e.c.AddFunc(spec, wrapped)
	if err != nil {
		return fmt.Errorf("schedule job %q (%q): %w", key, cronExpr, err)
	}
	e.entries[key] = id
	return nil
}

func (e *Engine) Remove(key string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if id, ok := e.entries[key]; ok {
		e.c.Remove(id)
		delete(e.entries, key)
	}
}

func (e *Engine) Has(key string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	_, ok := e.entries[key]
	return ok
}
