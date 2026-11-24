package messenger

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ChannelRecord struct {
	ID                int64
	UserID            int64
	Type              string
	Name              string
	EnableOutbound    bool
	EnableInbound     bool
	IsDefaultOutbound bool
	Enabled           bool
	WebhookSecret     string
	ConfigEnc         string
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

type PushEndpointRecord struct {
	ID               int64
	UserID           int64
	Name             string
	TokenHash        string
	TokenEnc         string
	TargetMode       string // "default" | "selected"
	TargetChannelIDs []int64
	Enabled          bool
	LastCalledAt     *time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

type Store interface {
	ListChannels(ctx context.Context, userID int64) ([]ChannelRecord, error)
	GetChannel(ctx context.Context, userID, id int64) (*ChannelRecord, error)
	GetChannelByID(ctx context.Context, id int64) (*ChannelRecord, error)
	CreateChannel(ctx context.Context, rec ChannelRecord) (*ChannelRecord, error)
	UpdateChannel(ctx context.Context, rec ChannelRecord) (*ChannelRecord, error)
	DeleteChannel(ctx context.Context, userID, id int64) error

	ListPushEndpoints(ctx context.Context, userID int64) ([]PushEndpointRecord, error)
	GetPushEndpoint(ctx context.Context, userID, id int64) (*PushEndpointRecord, error)
	GetPushEndpointByTokenHash(ctx context.Context, tokenHash string) (*PushEndpointRecord, error)
	CreatePushEndpoint(ctx context.Context, rec PushEndpointRecord) (*PushEndpointRecord, error)
	UpdatePushEndpoint(ctx context.Context, rec PushEndpointRecord) (*PushEndpointRecord, error)
	RotatePushEndpointToken(ctx context.Context, userID, id int64, tokenHash, tokenEnc string) (*PushEndpointRecord, error)
	TouchPushEndpointCalled(ctx context.Context, id int64) error
	DeletePushEndpoint(ctx context.Context, userID, id int64) error
}

type PGStore struct {
	pool *pgxpool.Pool
}

func NewPGStore(pool *pgxpool.Pool) Store {
	return &PGStore{pool: pool}
}

func (s *PGStore) ListChannels(ctx context.Context, userID int64) ([]ChannelRecord, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, user_id, type, name, enable_outbound, enable_inbound, is_default_outbound,
		       enabled, webhook_secret, config_enc, created_at, updated_at
		FROM user_channels
		WHERE user_id = $1
		ORDER BY id ASC
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("list user channels: %w", err)
	}
	defer rows.Close()

	var out []ChannelRecord
	for rows.Next() {
		var r ChannelRecord
		if err := rows.Scan(
			&r.ID, &r.UserID, &r.Type, &r.Name, &r.EnableOutbound, &r.EnableInbound,
			&r.IsDefaultOutbound, &r.Enabled, &r.WebhookSecret, &r.ConfigEnc, &r.CreatedAt, &r.UpdatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *PGStore) GetChannel(ctx context.Context, userID, id int64) (*ChannelRecord, error) {
	var r ChannelRecord
	err := s.pool.QueryRow(ctx, `
		SELECT id, user_id, type, name, enable_outbound, enable_inbound, is_default_outbound,
		       enabled, webhook_secret, config_enc, created_at, updated_at
		FROM user_channels
		WHERE user_id = $1 AND id = $2
	`, userID, id).Scan(
		&r.ID, &r.UserID, &r.Type, &r.Name, &r.EnableOutbound, &r.EnableInbound,
		&r.IsDefaultOutbound, &r.Enabled, &r.WebhookSecret, &r.ConfigEnc, &r.CreatedAt, &r.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *PGStore) GetChannelByID(ctx context.Context, id int64) (*ChannelRecord, error) {
	var r ChannelRecord
	err := s.pool.QueryRow(ctx, `
		SELECT id, user_id, type, name, enable_outbound, enable_inbound, is_default_outbound,
		       enabled, webhook_secret, config_enc, created_at, updated_at
		FROM user_channels
		WHERE id = $1
	`, id).Scan(
		&r.ID, &r.UserID, &r.Type, &r.Name, &r.EnableOutbound, &r.EnableInbound,
		&r.IsDefaultOutbound, &r.Enabled, &r.WebhookSecret, &r.ConfigEnc, &r.CreatedAt, &r.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *PGStore) CreateChannel(ctx context.Context, rec ChannelRecord) (*ChannelRecord, error) {
	var r ChannelRecord
	err := s.pool.QueryRow(ctx, `
		INSERT INTO user_channels (
			user_id, type, name, enable_outbound, enable_inbound, is_default_outbound,
			enabled, webhook_secret, config_enc
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, user_id, type, name, enable_outbound, enable_inbound, is_default_outbound,
		          enabled, webhook_secret, config_enc, created_at, updated_at
	`, rec.UserID, rec.Type, rec.Name, rec.EnableOutbound, rec.EnableInbound,
		rec.IsDefaultOutbound, rec.Enabled, rec.WebhookSecret, rec.ConfigEnc,
	).Scan(
		&r.ID, &r.UserID, &r.Type, &r.Name, &r.EnableOutbound, &r.EnableInbound,
		&r.IsDefaultOutbound, &r.Enabled, &r.WebhookSecret, &r.ConfigEnc, &r.CreatedAt, &r.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *PGStore) UpdateChannel(ctx context.Context, rec ChannelRecord) (*ChannelRecord, error) {
	var r ChannelRecord
	err := s.pool.QueryRow(ctx, `
		UPDATE user_channels
		SET name = $3,
		    enable_outbound = $4,
		    enable_inbound = $5,
		    is_default_outbound = $6,
		    enabled = $7,
		    webhook_secret = $8,
		    config_enc = $9,
		    updated_at = NOW()
		WHERE user_id = $1 AND id = $2
		RETURNING id, user_id, type, name, enable_outbound, enable_inbound, is_default_outbound,
		          enabled, webhook_secret, config_enc, created_at, updated_at
	`, rec.UserID, rec.ID, rec.Name, rec.EnableOutbound, rec.EnableInbound,
		rec.IsDefaultOutbound, rec.Enabled, rec.WebhookSecret, rec.ConfigEnc,
	).Scan(
		&r.ID, &r.UserID, &r.Type, &r.Name, &r.EnableOutbound, &r.EnableInbound,
		&r.IsDefaultOutbound, &r.Enabled, &r.WebhookSecret, &r.ConfigEnc, &r.CreatedAt, &r.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *PGStore) DeleteChannel(ctx context.Context, userID, id int64) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM user_channels WHERE user_id = $1 AND id = $2`, userID, id)
	return err
}

func (s *PGStore) ListPushEndpoints(ctx context.Context, userID int64) ([]PushEndpointRecord, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, user_id, name, token_hash, token_enc, target_mode, target_channel_ids,
		       enabled, last_called_at, created_at, updated_at
		FROM push_endpoints
		WHERE user_id = $1
		ORDER BY id ASC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []PushEndpointRecord
	for rows.Next() {
		var r PushEndpointRecord
		if err := rows.Scan(
			&r.ID, &r.UserID, &r.Name, &r.TokenHash, &r.TokenEnc, &r.TargetMode,
			&r.TargetChannelIDs, &r.Enabled, &r.LastCalledAt, &r.CreatedAt, &r.UpdatedAt,
		); err != nil {
			return nil, err
		}
		if r.TargetChannelIDs == nil {
			r.TargetChannelIDs = []int64{}
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *PGStore) GetPushEndpoint(ctx context.Context, userID, id int64) (*PushEndpointRecord, error) {
	var r PushEndpointRecord
	err := s.pool.QueryRow(ctx, `
		SELECT id, user_id, name, token_hash, token_enc, target_mode, target_channel_ids,
		       enabled, last_called_at, created_at, updated_at
		FROM push_endpoints
		WHERE user_id = $1 AND id = $2
	`, userID, id).Scan(
		&r.ID, &r.UserID, &r.Name, &r.TokenHash, &r.TokenEnc, &r.TargetMode,
		&r.TargetChannelIDs, &r.Enabled, &r.LastCalledAt, &r.CreatedAt, &r.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if r.TargetChannelIDs == nil {
		r.TargetChannelIDs = []int64{}
	}
	return &r, nil
}

func (s *PGStore) GetPushEndpointByTokenHash(ctx context.Context, tokenHash string) (*PushEndpointRecord, error) {
	var r PushEndpointRecord
	err := s.pool.QueryRow(ctx, `
		SELECT id, user_id, name, token_hash, token_enc, target_mode, target_channel_ids,
		       enabled, last_called_at, created_at, updated_at
		FROM push_endpoints
		WHERE token_hash = $1
	`, tokenHash).Scan(
		&r.ID, &r.UserID, &r.Name, &r.TokenHash, &r.TokenEnc, &r.TargetMode,
		&r.TargetChannelIDs, &r.Enabled, &r.LastCalledAt, &r.CreatedAt, &r.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if r.TargetChannelIDs == nil {
		r.TargetChannelIDs = []int64{}
	}
	return &r, nil
}

func (s *PGStore) CreatePushEndpoint(ctx context.Context, rec PushEndpointRecord) (*PushEndpointRecord, error) {
	if rec.TargetChannelIDs == nil {
		rec.TargetChannelIDs = []int64{}
	}
	var r PushEndpointRecord
	err := s.pool.QueryRow(ctx, `
		INSERT INTO push_endpoints (user_id, name, token_hash, token_enc, target_mode, target_channel_ids, enabled)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, user_id, name, token_hash, token_enc, target_mode, target_channel_ids,
		          enabled, last_called_at, created_at, updated_at
	`, rec.UserID, rec.Name, rec.TokenHash, rec.TokenEnc, rec.TargetMode, rec.TargetChannelIDs, rec.Enabled,
	).Scan(
		&r.ID, &r.UserID, &r.Name, &r.TokenHash, &r.TokenEnc, &r.TargetMode,
		&r.TargetChannelIDs, &r.Enabled, &r.LastCalledAt, &r.CreatedAt, &r.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if r.TargetChannelIDs == nil {
		r.TargetChannelIDs = []int64{}
	}
	return &r, nil
}

func (s *PGStore) UpdatePushEndpoint(ctx context.Context, rec PushEndpointRecord) (*PushEndpointRecord, error) {
	if rec.TargetChannelIDs == nil {
		rec.TargetChannelIDs = []int64{}
	}
	var r PushEndpointRecord
	err := s.pool.QueryRow(ctx, `
		UPDATE push_endpoints
		SET name = $3,
		    target_mode = $4,
		    target_channel_ids = $5,
		    enabled = $6,
		    updated_at = NOW()
		WHERE user_id = $1 AND id = $2
		RETURNING id, user_id, name, token_hash, token_enc, target_mode, target_channel_ids,
		          enabled, last_called_at, created_at, updated_at
	`, rec.UserID, rec.ID, rec.Name, rec.TargetMode, rec.TargetChannelIDs, rec.Enabled,
	).Scan(
		&r.ID, &r.UserID, &r.Name, &r.TokenHash, &r.TokenEnc, &r.TargetMode,
		&r.TargetChannelIDs, &r.Enabled, &r.LastCalledAt, &r.CreatedAt, &r.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if r.TargetChannelIDs == nil {
		r.TargetChannelIDs = []int64{}
	}
	return &r, nil
}

func (s *PGStore) RotatePushEndpointToken(ctx context.Context, userID, id int64, tokenHash, tokenEnc string) (*PushEndpointRecord, error) {
	var r PushEndpointRecord
	err := s.pool.QueryRow(ctx, `
		UPDATE push_endpoints
		SET token_hash = $3, token_enc = $4, updated_at = NOW()
		WHERE user_id = $1 AND id = $2
		RETURNING id, user_id, name, token_hash, token_enc, target_mode, target_channel_ids,
		          enabled, last_called_at, created_at, updated_at
	`, userID, id, tokenHash, tokenEnc,
	).Scan(
		&r.ID, &r.UserID, &r.Name, &r.TokenHash, &r.TokenEnc, &r.TargetMode,
		&r.TargetChannelIDs, &r.Enabled, &r.LastCalledAt, &r.CreatedAt, &r.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if r.TargetChannelIDs == nil {
		r.TargetChannelIDs = []int64{}
	}
	return &r, nil
}

func (s *PGStore) TouchPushEndpointCalled(ctx context.Context, id int64) error {
	_, err := s.pool.Exec(ctx, `UPDATE push_endpoints SET last_called_at = NOW() WHERE id = $1`, id)
	return err
}

func (s *PGStore) DeletePushEndpoint(ctx context.Context, userID, id int64) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM push_endpoints WHERE user_id = $1 AND id = $2`, userID, id)
	return err
}
