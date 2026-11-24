package storage

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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
	pool *pgxpool.Pool
}

func NewPGConfigStore(pool *pgxpool.Pool) ConfigStore {
	return &PGConfigStore{pool: pool}
}

func (s *PGConfigStore) GetConfig(ctx context.Context, userID int64) (*ConfigRecord, error) {
	var r ConfigRecord
	err := s.pool.QueryRow(ctx, `
		SELECT user_id, endpoint, region, bucket, access_key, secret_key_enc,
		       public_base_url, hash_length, force_path_style, upload_mode, updated_at
		FROM user_storage_configs
		WHERE user_id = $1
	`, userID).Scan(
		&r.UserID, &r.Endpoint, &r.Region, &r.Bucket, &r.AccessKey, &r.SecretKeyEnc,
		&r.PublicBaseURL, &r.HashLength, &r.ForcePathStyle, &r.UploadMode, &r.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *PGConfigStore) UpsertConfig(ctx context.Context, rec ConfigRecord) (*ConfigRecord, error) {
	var r ConfigRecord
	err := s.pool.QueryRow(ctx, `
		INSERT INTO user_storage_configs (
			user_id, endpoint, region, bucket, access_key, secret_key_enc,
			public_base_url, hash_length, force_path_style, upload_mode
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		ON CONFLICT (user_id) DO UPDATE SET
			endpoint = EXCLUDED.endpoint,
			region = EXCLUDED.region,
			bucket = EXCLUDED.bucket,
			access_key = EXCLUDED.access_key,
			secret_key_enc = EXCLUDED.secret_key_enc,
			public_base_url = EXCLUDED.public_base_url,
			hash_length = EXCLUDED.hash_length,
			force_path_style = EXCLUDED.force_path_style,
			upload_mode = EXCLUDED.upload_mode,
			updated_at = NOW()
		RETURNING user_id, endpoint, region, bucket, access_key, secret_key_enc,
		          public_base_url, hash_length, force_path_style, upload_mode, updated_at
	`, rec.UserID, rec.Endpoint, rec.Region, rec.Bucket, rec.AccessKey, rec.SecretKeyEnc,
		rec.PublicBaseURL, rec.HashLength, rec.ForcePathStyle, rec.UploadMode,
	).Scan(
		&r.UserID, &r.Endpoint, &r.Region, &r.Bucket, &r.AccessKey, &r.SecretKeyEnc,
		&r.PublicBaseURL, &r.HashLength, &r.ForcePathStyle, &r.UploadMode, &r.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &r, nil
}
