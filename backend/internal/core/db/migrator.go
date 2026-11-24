package db

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Migration struct {
	ModuleID string
	Version  int
	Name     string
	SQL      string
}

type MigrationSource struct {
	ModuleID string
	FS       fs.FS
}

const createMigrationsTableSQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
	module_id  TEXT NOT NULL,
	version    INT  NOT NULL,
	name       TEXT NOT NULL,
	applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	PRIMARY KEY (module_id, version)
);`

// ParseMigrations walks an fs.FS and extracts ordered numeric-prefixed SQL files (e.g. 001_init.sql).
func ParseMigrations(moduleID string, fsys fs.FS) ([]Migration, error) {
	if fsys == nil {
		return nil, nil
	}
	var out []Migration
	err := fs.WalkDir(fsys, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".sql") {
			return nil
		}
		base := filepath.Base(path)
		prefix, _, ok := strings.Cut(base, "_")
		if !ok {
			return fmt.Errorf("migration %q in module %q must start with '<number>_'", base, moduleID)
		}
		version, err := strconv.Atoi(prefix)
		if err != nil || version <= 0 {
			return fmt.Errorf("invalid migration version %q in module %q", base, moduleID)
		}
		content, err := fs.ReadFile(fsys, path)
		if err != nil {
			return fmt.Errorf("read migration %q: %w", path, err)
		}
		out = append(out, Migration{
			ModuleID: moduleID,
			Version:  version,
			Name:     base,
			SQL:      string(content),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Version < out[j].Version
	})
	for i := 1; i < len(out); i++ {
		if out[i].Version == out[i-1].Version {
			return nil, fmt.Errorf("duplicate migration version %d in module %q", out[i].Version, moduleID)
		}
	}
	return out, nil
}

// RunMigrations executes pending per-module migrations transactionally and idempotently.
func RunMigrations(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger, sources []MigrationSource) error {
	if _, err := pool.Exec(ctx, createMigrationsTableSQL); err != nil {
		return fmt.Errorf("ensure schema_migrations table: %w", err)
	}

	for _, src := range sources {
		migrations, err := ParseMigrations(src.ModuleID, src.FS)
		if err != nil {
			return err
		}
		for _, m := range migrations {
			var applied bool
			err := pool.QueryRow(ctx,
				`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE module_id = $1 AND version = $2)`,
				m.ModuleID, m.Version,
			).Scan(&applied)
			if err != nil {
				return fmt.Errorf("check migration %s/%d: %w", m.ModuleID, m.Version, err)
			}
			if applied {
				continue
			}

			tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
			if err != nil {
				return fmt.Errorf("begin migration tx %s/%d: %w", m.ModuleID, m.Version, err)
			}
			if _, err := tx.Exec(ctx, m.SQL); err != nil {
				_ = tx.Rollback(ctx)
				return fmt.Errorf("exec migration %s/%s: %w", m.ModuleID, m.Name, err)
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO schema_migrations (module_id, version, name) VALUES ($1, $2, $3)`,
				m.ModuleID, m.Version, m.Name,
			); err != nil {
				_ = tx.Rollback(ctx)
				return fmt.Errorf("record migration %s/%s: %w", m.ModuleID, m.Name, err)
			}
			if err := tx.Commit(ctx); err != nil {
				return fmt.Errorf("commit migration %s/%s: %w", m.ModuleID, m.Name, err)
			}
			if logger != nil {
				logger.Info("applied migration", "module", m.ModuleID, "version", m.Version, "file", m.Name)
			}
		}
	}
	return nil
}
