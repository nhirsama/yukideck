package messenger

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"yukideck/internal/core/messenger/sqlcgen"
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
	Slug             string
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
	GetPushEndpointBySlug(ctx context.Context, userID int64, slug string) (*PushEndpointRecord, error)
	CreatePushEndpoint(ctx context.Context, rec PushEndpointRecord) (*PushEndpointRecord, error)
	UpdatePushEndpoint(ctx context.Context, rec PushEndpointRecord) (*PushEndpointRecord, error)
	TouchPushEndpointCalled(ctx context.Context, id int64) error
	DeletePushEndpoint(ctx context.Context, userID, id int64) error
}

type PGStore struct {
	q *sqlcgen.Queries
}

func NewPGStore(pool *pgxpool.Pool) Store {
	return &PGStore{q: sqlcgen.New(pool)}
}

func toChannelRecord(r sqlcgen.UserChannel) ChannelRecord {
	return ChannelRecord{
		ID:                r.ID,
		UserID:            r.UserID,
		Type:              r.Type,
		Name:              r.Name,
		EnableOutbound:    r.EnableOutbound,
		EnableInbound:     r.EnableInbound,
		IsDefaultOutbound: r.IsDefaultOutbound,
		Enabled:           r.Enabled,
		WebhookSecret:     r.WebhookSecret,
		ConfigEnc:         r.ConfigEnc,
		CreatedAt:         r.CreatedAt,
		UpdatedAt:         r.UpdatedAt,
	}
}

func toPushEndpointRecord(r sqlcgen.PushEndpoint) PushEndpointRecord {
	targetIDs := r.TargetChannelIds
	if targetIDs == nil {
		targetIDs = []int64{}
	}
	return PushEndpointRecord{
		ID:               r.ID,
		UserID:           r.UserID,
		Name:             r.Name,
		Slug:             r.Slug,
		TargetMode:       r.TargetMode,
		TargetChannelIDs: targetIDs,
		Enabled:          r.Enabled,
		LastCalledAt:     r.LastCalledAt,
		CreatedAt:        r.CreatedAt,
		UpdatedAt:        r.UpdatedAt,
	}
}

func (s *PGStore) ListChannels(ctx context.Context, userID int64) ([]ChannelRecord, error) {
	rows, err := s.q.ListChannels(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list user channels: %w", err)
	}
	out := make([]ChannelRecord, 0, len(rows))
	for _, r := range rows {
		out = append(out, toChannelRecord(r))
	}
	return out, nil
}

func (s *PGStore) GetChannel(ctx context.Context, userID, id int64) (*ChannelRecord, error) {
	row, err := s.q.GetChannel(ctx, sqlcgen.GetChannelParams{
		UserID: userID,
		ID:     id,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rec := toChannelRecord(row)
	return &rec, nil
}

func (s *PGStore) GetChannelByID(ctx context.Context, id int64) (*ChannelRecord, error) {
	row, err := s.q.GetChannelByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rec := toChannelRecord(row)
	return &rec, nil
}

func (s *PGStore) CreateChannel(ctx context.Context, rec ChannelRecord) (*ChannelRecord, error) {
	row, err := s.q.CreateChannel(ctx, sqlcgen.CreateChannelParams{
		UserID:            rec.UserID,
		Type:              rec.Type,
		Name:              rec.Name,
		EnableOutbound:    rec.EnableOutbound,
		EnableInbound:     rec.EnableInbound,
		IsDefaultOutbound: rec.IsDefaultOutbound,
		Enabled:           rec.Enabled,
		WebhookSecret:     rec.WebhookSecret,
		ConfigEnc:         rec.ConfigEnc,
	})
	if err != nil {
		return nil, err
	}
	out := toChannelRecord(row)
	return &out, nil
}

func (s *PGStore) UpdateChannel(ctx context.Context, rec ChannelRecord) (*ChannelRecord, error) {
	row, err := s.q.UpdateChannel(ctx, sqlcgen.UpdateChannelParams{
		UserID:            rec.UserID,
		ID:                rec.ID,
		Name:              rec.Name,
		EnableOutbound:    rec.EnableOutbound,
		EnableInbound:     rec.EnableInbound,
		IsDefaultOutbound: rec.IsDefaultOutbound,
		Enabled:           rec.Enabled,
		WebhookSecret:     rec.WebhookSecret,
		ConfigEnc:         rec.ConfigEnc,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	out := toChannelRecord(row)
	return &out, nil
}

func (s *PGStore) DeleteChannel(ctx context.Context, userID, id int64) error {
	return s.q.DeleteChannel(ctx, sqlcgen.DeleteChannelParams{
		UserID: userID,
		ID:     id,
	})
}

func (s *PGStore) ListPushEndpoints(ctx context.Context, userID int64) ([]PushEndpointRecord, error) {
	rows, err := s.q.ListPushEndpoints(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]PushEndpointRecord, 0, len(rows))
	for _, r := range rows {
		out = append(out, toPushEndpointRecord(r))
	}
	return out, nil
}

func (s *PGStore) GetPushEndpoint(ctx context.Context, userID, id int64) (*PushEndpointRecord, error) {
	row, err := s.q.GetPushEndpoint(ctx, sqlcgen.GetPushEndpointParams{
		UserID: userID,
		ID:     id,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rec := toPushEndpointRecord(row)
	return &rec, nil
}

func (s *PGStore) GetPushEndpointBySlug(ctx context.Context, userID int64, slug string) (*PushEndpointRecord, error) {
	row, err := s.q.GetPushEndpointBySlug(ctx, sqlcgen.GetPushEndpointBySlugParams{
		UserID: userID,
		Slug:   slug,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rec := toPushEndpointRecord(row)
	return &rec, nil
}

func (s *PGStore) CreatePushEndpoint(ctx context.Context, rec PushEndpointRecord) (*PushEndpointRecord, error) {
	targetIDs := rec.TargetChannelIDs
	if targetIDs == nil {
		targetIDs = []int64{}
	}
	row, err := s.q.CreatePushEndpoint(ctx, sqlcgen.CreatePushEndpointParams{
		UserID:           rec.UserID,
		Name:             rec.Name,
		Slug:             rec.Slug,
		TargetMode:       rec.TargetMode,
		TargetChannelIds: targetIDs,
		Enabled:          rec.Enabled,
	})
	if err != nil {
		return nil, err
	}
	out := toPushEndpointRecord(row)
	return &out, nil
}

func (s *PGStore) UpdatePushEndpoint(ctx context.Context, rec PushEndpointRecord) (*PushEndpointRecord, error) {
	targetIDs := rec.TargetChannelIDs
	if targetIDs == nil {
		targetIDs = []int64{}
	}
	row, err := s.q.UpdatePushEndpoint(ctx, sqlcgen.UpdatePushEndpointParams{
		UserID:           rec.UserID,
		ID:               rec.ID,
		Name:             rec.Name,
		Slug:             rec.Slug,
		TargetMode:       rec.TargetMode,
		TargetChannelIds: targetIDs,
		Enabled:          rec.Enabled,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	out := toPushEndpointRecord(row)
	return &out, nil
}

func (s *PGStore) TouchPushEndpointCalled(ctx context.Context, id int64) error {
	return s.q.TouchPushEndpointCalled(ctx, id)
}

func (s *PGStore) DeletePushEndpoint(ctx context.Context, userID, id int64) error {
	return s.q.DeletePushEndpoint(ctx, sqlcgen.DeletePushEndpointParams{
		UserID: userID,
		ID:     id,
	})
}
