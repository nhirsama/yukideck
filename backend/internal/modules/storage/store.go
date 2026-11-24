package storage

import (
	"context"
	"errors"
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

type ConfigStore interface {
	GetConfig(ctx context.Context, userID int64) (*ConfigRecord, error)
	UpsertConfig(ctx context.Context, rec ConfigRecord) (*ConfigRecord, error)
}

type PGConfigStore struct {
	q *sqlcgen.Queries
}

func NewPGConfigStore(pool *pgxpool.Pool) ConfigStore {
	return &PGConfigStore{q: sqlcgen.New(pool)}
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
