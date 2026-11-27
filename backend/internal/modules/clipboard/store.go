package clipboard

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"yukideck/internal/modules/clipboard/sqlcgen"
)

type Store interface {
	ListActiveItems(ctx context.Context, userID int64, now time.Time) ([]Record, error)
	GetActiveItem(ctx context.Context, userID, id int64, now time.Time) (*Record, error)
	GetMinSortOrder(ctx context.Context, userID int64, now time.Time) (int, error)
	CreateItem(ctx context.Context, rec Record) (*Record, error)
	UpdateItemContentWithVersion(ctx context.Context, userID, id, expectedVersion int64, content string, byteSize int, starred bool, expiresAt, now time.Time) (*Record, error)
	UpdateItemContentForce(ctx context.Context, userID, id int64, content string, byteSize int, starred bool, expiresAt, now time.Time) (*Record, error)
	UpdateItemMeta(ctx context.Context, userID, id int64, starred bool, expiresAt, now time.Time) (*Record, error)
	DeleteItem(ctx context.Context, userID, id int64) (bool, error)
	ReorderItems(ctx context.Context, userID int64, ids []int64, now time.Time) error
	PurgeExpired(ctx context.Context, now time.Time) (int64, error)
}

type PGStore struct {
	pool *pgxpool.Pool
	q    *sqlcgen.Queries
}

func NewPGStore(pool *pgxpool.Pool) *PGStore {
	var q *sqlcgen.Queries
	if pool != nil {
		q = sqlcgen.New(pool)
	}
	return &PGStore{pool: pool, q: q}
}

func (s *PGStore) ListActiveItems(ctx context.Context, userID int64, now time.Time) ([]Record, error) {
	rows, err := s.q.ListActiveItems(ctx, sqlcgen.ListActiveItemsParams{
		UserID:    userID,
		ExpiresAt: now,
	})
	if err != nil {
		return nil, err
	}
	out := make([]Record, 0, len(rows))
	for _, row := range rows {
		out = append(out, fromSQLCRow(row))
	}
	return out, nil
}

func (s *PGStore) GetActiveItem(ctx context.Context, userID, id int64, now time.Time) (*Record, error) {
	row, err := s.q.GetActiveItem(ctx, sqlcgen.GetActiveItemParams{
		ID:        id,
		UserID:    userID,
		ExpiresAt: now,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	rec := fromSQLCRow(row)
	return &rec, nil
}

func (s *PGStore) GetMinSortOrder(ctx context.Context, userID int64, now time.Time) (int, error) {
	v, err := s.q.GetMinSortOrder(ctx, sqlcgen.GetMinSortOrderParams{
		UserID:    userID,
		ExpiresAt: now,
	})
	if err != nil {
		return 0, err
	}
	return int(v), nil
}

func (s *PGStore) CreateItem(ctx context.Context, rec Record) (*Record, error) {
	row, err := s.q.CreateItem(ctx, sqlcgen.CreateItemParams{
		UserID:    rec.UserID,
		Content:   rec.Content,
		ByteSize:  int32(rec.ByteSize),
		Starred:   rec.Starred,
		SortOrder: int32(rec.SortOrder),
		ExpiresAt: rec.ExpiresAt,
		CreatedAt: rec.CreatedAt,
	})
	if err != nil {
		return nil, err
	}
	out := fromSQLCRow(row)
	return &out, nil
}

func (s *PGStore) UpdateItemContentWithVersion(ctx context.Context, userID, id, expectedVersion int64, content string, byteSize int, starred bool, expiresAt, now time.Time) (*Record, error) {
	row, err := s.q.UpdateItemContentWithVersion(ctx, sqlcgen.UpdateItemContentWithVersionParams{
		ID:        id,
		UserID:    userID,
		Version:   expectedVersion,
		Content:   content,
		ByteSize:  int32(byteSize),
		Starred:   starred,
		ExpiresAt: expiresAt,
		UpdatedAt: now,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	out := fromSQLCRow(row)
	return &out, nil
}

func (s *PGStore) UpdateItemContentForce(ctx context.Context, userID, id int64, content string, byteSize int, starred bool, expiresAt, now time.Time) (*Record, error) {
	row, err := s.q.UpdateItemContentForce(ctx, sqlcgen.UpdateItemContentForceParams{
		ID:        id,
		UserID:    userID,
		Content:   content,
		ByteSize:  int32(byteSize),
		Starred:   starred,
		ExpiresAt: expiresAt,
		UpdatedAt: now,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	out := fromSQLCRow(row)
	return &out, nil
}

func (s *PGStore) UpdateItemMeta(ctx context.Context, userID, id int64, starred bool, expiresAt, now time.Time) (*Record, error) {
	row, err := s.q.UpdateItemMeta(ctx, sqlcgen.UpdateItemMetaParams{
		ID:        id,
		UserID:    userID,
		Starred:   starred,
		ExpiresAt: expiresAt,
		UpdatedAt: now,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	out := fromSQLCRow(row)
	return &out, nil
}

func (s *PGStore) DeleteItem(ctx context.Context, userID, id int64) (bool, error) {
	n, err := s.q.DeleteItem(ctx, sqlcgen.DeleteItemParams{
		ID:     id,
		UserID: userID,
	})
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

func (s *PGStore) ReorderItems(ctx context.Context, userID int64, ids []int64, now time.Time) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	qtx := s.q.WithTx(tx)
	for i, id := range ids {
		if err := qtx.UpdateItemSortOrder(ctx, sqlcgen.UpdateItemSortOrderParams{
			ID:        id,
			UserID:    userID,
			SortOrder: int32(i),
			ExpiresAt: now,
		}); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *PGStore) PurgeExpired(ctx context.Context, now time.Time) (int64, error) {
	return s.q.PurgeExpiredItems(ctx, now)
}

func fromSQLCRow(r sqlcgen.ClipboardItem) Record {
	return Record{
		ID:        r.ID,
		UserID:    r.UserID,
		Content:   r.Content,
		ByteSize:  int(r.ByteSize),
		Starred:   r.Starred,
		SortOrder: int(r.SortOrder),
		Version:   r.Version,
		ExpiresAt: r.ExpiresAt,
		CreatedAt: r.CreatedAt,
		UpdatedAt: r.UpdatedAt,
	}
}
