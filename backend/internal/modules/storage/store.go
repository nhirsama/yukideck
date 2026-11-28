package storage

import (
	"cmp"
	"context"
	"errors"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"yukideck/internal/modules/storage/sqlcgen"
)

type ConfigRecord struct {
	UserID         int64
	Endpoint       string
	Region         string
	Bucket         string
	AccessKey      string
	SecretKeyEnc   string
	PublicBaseURL  string
	HashLength     int
	ForcePathStyle bool
	UploadMode     string // "direct" | "proxy"
	UpdatedAt      time.Time
}

type ObjectDimRecord struct {
	Key      string
	ByteSize int64
	Width    int
	Height   int
}

type ConfigStore interface {
	GetConfig(ctx context.Context, userID int64) (*ConfigRecord, error)
	UpsertConfig(ctx context.Context, rec ConfigRecord) (*ConfigRecord, error)

	ListObjectDims(ctx context.Context, userID int64) (map[string]ObjectDimRecord, error)
	UpsertObjectDims(ctx context.Context, userID int64, items []ObjectDimRecord) error
	RenameObjectDimKey(ctx context.Context, userID int64, oldKey, newKey string) error
	DeleteObjectDimsByKeys(ctx context.Context, userID int64, keys []string) error
	DeleteAllObjectDims(ctx context.Context, userID int64) error
}

type PGConfigStore struct {
	pool *pgxpool.Pool
	q    *sqlcgen.Queries
}

func NewPGConfigStore(pool *pgxpool.Pool) ConfigStore {
	return &PGConfigStore{pool: pool, q: sqlcgen.New(pool)}
}

func toConfigRecord(r sqlcgen.UserStorageConfig) *ConfigRecord {
	return &ConfigRecord{
		UserID:         r.UserID,
		Endpoint:       r.Endpoint,
		Region:         r.Region,
		Bucket:         r.Bucket,
		AccessKey:      r.AccessKey,
		SecretKeyEnc:   r.SecretKeyEnc,
		PublicBaseURL:  r.PublicBaseUrl,
		HashLength:     int(r.HashLength),
		ForcePathStyle: r.ForcePathStyle,
		UploadMode:     r.UploadMode,
		UpdatedAt:      r.UpdatedAt,
	}
}

func (s *PGConfigStore) GetConfig(ctx context.Context, userID int64) (*ConfigRecord, error) {
	row, err := s.q.GetStorageConfig(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return toConfigRecord(row), nil
}

func (s *PGConfigStore) UpsertConfig(ctx context.Context, rec ConfigRecord) (*ConfigRecord, error) {
	row, err := s.q.UpsertStorageConfig(ctx, sqlcgen.UpsertStorageConfigParams{
		UserID:         rec.UserID,
		Endpoint:       rec.Endpoint,
		Region:         rec.Region,
		Bucket:         rec.Bucket,
		AccessKey:      rec.AccessKey,
		SecretKeyEnc:   rec.SecretKeyEnc,
		PublicBaseUrl:  rec.PublicBaseURL,
		HashLength:     int32(rec.HashLength),
		ForcePathStyle: rec.ForcePathStyle,
		UploadMode:     rec.UploadMode,
	})
	if err != nil {
		return nil, err
	}
	return toConfigRecord(row), nil
}

func (s *PGConfigStore) ListObjectDims(ctx context.Context, userID int64) (map[string]ObjectDimRecord, error) {
	rows, err := s.q.ListObjectDims(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make(map[string]ObjectDimRecord, len(rows))
	for _, r := range rows {
		out[r.ObjectKey] = ObjectDimRecord{
			Key:      r.ObjectKey,
			ByteSize: r.ByteSize,
			Width:    int(r.Width),
			Height:   int(r.Height),
		}
	}
	return out, nil
}

func (s *PGConfigStore) UpsertObjectDims(ctx context.Context, userID int64, items []ObjectDimRecord) error {
	if len(items) == 0 {
		return nil
	}
	// Deduplicate and sort by key ascending so concurrent batch upserts never deadlock.
	dedup := make(map[string]ObjectDimRecord, len(items))
	for _, it := range items {
		dedup[it.Key] = it
	}
	sorted := make([]ObjectDimRecord, 0, len(dedup))
	for _, it := range dedup {
		sorted = append(sorted, it)
	}
	slices.SortFunc(sorted, func(a, b ObjectDimRecord) int {
		return cmp.Compare(a.Key, b.Key)
	})

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	qtx := s.q.WithTx(tx)
	for _, it := range sorted {
		if err := qtx.UpsertObjectDim(ctx, sqlcgen.UpsertObjectDimParams{
			UserID:    userID,
			ObjectKey: it.Key,
			ByteSize:  it.ByteSize,
			Width:     int32(it.Width),
			Height:    int32(it.Height),
		}); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *PGConfigStore) RenameObjectDimKey(ctx context.Context, userID int64, oldKey, newKey string) error {
	if oldKey == "" || newKey == "" || oldKey == newKey {
		return nil
	}
	return s.q.RenameObjectDimKey(ctx, sqlcgen.RenameObjectDimKeyParams{
		UserID:      userID,
		ObjectKey:   oldKey,
		ObjectKey_2: newKey,
	})
}

func (s *PGConfigStore) DeleteObjectDimsByKeys(ctx context.Context, userID int64, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	return s.q.DeleteObjectDimsByKeys(ctx, sqlcgen.DeleteObjectDimsByKeysParams{
		UserID:  userID,
		Column2: keys,
	})
}

func (s *PGConfigStore) DeleteAllObjectDims(ctx context.Context, userID int64) error {
	return s.q.DeleteAllObjectDims(ctx, userID)
}
