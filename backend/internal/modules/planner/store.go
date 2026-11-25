package planner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"yukideck/internal/modules/planner/sqlcgen"
)

type ItemRecord struct {
	ID            int64
	UserID        int64
	Title         string
	Note          string
	Status        string
	TargetAt      *time.Time
	Timezone      string
	CalendarType  string
	RepeatType    string
	RepeatConfig  RepeatConfig
	AutoAdvance   bool
	RemindOffsets []RemindOffset
	ChannelIDs    []int64
	NextTriggerAt *time.Time
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

type Store interface {
	ListItems(ctx context.Context, userID int64) ([]ItemRecord, error)
	GetItem(ctx context.Context, userID, id int64) (*ItemRecord, error)
	CreateItem(ctx context.Context, rec ItemRecord) (*ItemRecord, error)
	UpdateItem(ctx context.Context, rec ItemRecord) (*ItemRecord, error)
	DeleteItem(ctx context.Context, userID, id int64) error

	// Scheduler queries hitting the partial B-Tree index idx_planner_items_due
	ListDueItems(ctx context.Context, now time.Time) ([]ItemRecord, error)
	MinNextTriggerAt(ctx context.Context) (*time.Time, error)

	ListSentTriggerKeys(ctx context.Context, itemID int64) (map[string]struct{}, error)
	InsertLogAndPrune(ctx context.Context, rec LogRecord, maxKeep int) (bool, error)
	ListLogs(ctx context.Context, userID int64, limit int) ([]LogRecord, error)
}

type PGStore struct {
	q *sqlcgen.Queries
}

func NewPGStore(pool *pgxpool.Pool) Store {
	return &PGStore{q: sqlcgen.New(pool)}
}

func toItemRecord(row sqlcgen.PlannerItem) ItemRecord {
	r := ItemRecord{
		ID:            row.ID,
		UserID:        row.UserID,
		Title:         row.Title,
		Note:          row.Note,
		Status:        row.Status,
		TargetAt:      row.TargetAt,
		Timezone:      row.Timezone,
		CalendarType:  row.CalendarType,
		RepeatType:    row.RepeatType,
		AutoAdvance:   row.AutoAdvance,
		ChannelIDs:    row.ChannelIds,
		NextTriggerAt: row.NextTriggerAt,
		CreatedAt:     row.CreatedAt,
		UpdatedAt:     row.UpdatedAt,
	}
	if len(row.RepeatConfig) > 0 {
		_ = json.Unmarshal(row.RepeatConfig, &r.RepeatConfig)
	}
	if len(row.RemindOffsets) > 0 {
		_ = json.Unmarshal(row.RemindOffsets, &r.RemindOffsets)
	}
	if r.RemindOffsets == nil {
		r.RemindOffsets = []RemindOffset{}
	}
	if r.ChannelIDs == nil {
		r.ChannelIDs = []int64{}
	}
	return r
}

func toLogRecord(row sqlcgen.PlannerLog) LogRecord {
	return LogRecord{
		ID:           row.ID,
		UserID:       row.UserID,
		ItemID:       row.ItemID,
		ItemTitle:    row.ItemTitle,
		TriggerKey:   row.TriggerKey,
		TriggerLabel: row.TriggerLabel,
		Status:       row.Status,
		Error:        row.Error,
		SentAt:       row.SentAt,
	}
}

func (s *PGStore) ListItems(ctx context.Context, userID int64) ([]ItemRecord, error) {
	rows, err := s.q.ListItems(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list planner items: %w", err)
	}
	out := make([]ItemRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, toItemRecord(row))
	}
	return out, nil
}

func (s *PGStore) GetItem(ctx context.Context, userID, id int64) (*ItemRecord, error) {
	row, err := s.q.GetItem(ctx, sqlcgen.GetItemParams{
		UserID: userID,
		ID:     id,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rec := toItemRecord(row)
	return &rec, nil
}

func (s *PGStore) CreateItem(ctx context.Context, rec ItemRecord) (*ItemRecord, error) {
	repeatJSON, _ := json.Marshal(rec.RepeatConfig)
	offsetsJSON, _ := json.Marshal(rec.RemindOffsets)
	channelIDs := rec.ChannelIDs
	if channelIDs == nil {
		channelIDs = []int64{}
	}
	row, err := s.q.CreateItem(ctx, sqlcgen.CreateItemParams{
		UserID:        rec.UserID,
		Title:         rec.Title,
		Note:          rec.Note,
		Status:        rec.Status,
		TargetAt:      rec.TargetAt,
		Timezone:      rec.Timezone,
		CalendarType:  rec.CalendarType,
		RepeatType:    rec.RepeatType,
		RepeatConfig:  repeatJSON,
		AutoAdvance:   rec.AutoAdvance,
		RemindOffsets: offsetsJSON,
		ChannelIds:    channelIDs,
		NextTriggerAt: rec.NextTriggerAt,
	})
	if err != nil {
		return nil, err
	}
	out := toItemRecord(row)
	return &out, nil
}

func (s *PGStore) UpdateItem(ctx context.Context, rec ItemRecord) (*ItemRecord, error) {
	repeatJSON, _ := json.Marshal(rec.RepeatConfig)
	offsetsJSON, _ := json.Marshal(rec.RemindOffsets)
	channelIDs := rec.ChannelIDs
	if channelIDs == nil {
		channelIDs = []int64{}
	}
	row, err := s.q.UpdateItem(ctx, sqlcgen.UpdateItemParams{
		UserID:        rec.UserID,
		ID:            rec.ID,
		Title:         rec.Title,
		Note:          rec.Note,
		Status:        rec.Status,
		TargetAt:      rec.TargetAt,
		Timezone:      rec.Timezone,
		CalendarType:  rec.CalendarType,
		RepeatType:    rec.RepeatType,
		RepeatConfig:  repeatJSON,
		AutoAdvance:   rec.AutoAdvance,
		RemindOffsets: offsetsJSON,
		ChannelIds:    channelIDs,
		NextTriggerAt: rec.NextTriggerAt,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	out := toItemRecord(row)
	return &out, nil
}

func (s *PGStore) DeleteItem(ctx context.Context, userID, id int64) error {
	return s.q.DeleteItem(ctx, sqlcgen.DeleteItemParams{
		UserID: userID,
		ID:     id,
	})
}

// ListDueItems uses the partial B-Tree index idx_planner_items_due.
func (s *PGStore) ListDueItems(ctx context.Context, now time.Time) ([]ItemRecord, error) {
	nowUTC := now.UTC()
	rows, err := s.q.ListDueItems(ctx, &nowUTC)
	if err != nil {
		return nil, err
	}
	out := make([]ItemRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, toItemRecord(row))
	}
	return out, nil
}

// MinNextTriggerAt reads the leftmost leaf of partial index idx_planner_items_due in O(log N).
func (s *PGStore) MinNextTriggerAt(ctx context.Context) (*time.Time, error) {
	t, err := s.q.MinNextTriggerAt(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return t, nil
}

func (s *PGStore) ListSentTriggerKeys(ctx context.Context, itemID int64) (map[string]struct{}, error) {
	id := itemID
	keys, err := s.q.ListSentTriggerKeys(ctx, &id)
	if err != nil {
		return nil, err
	}
	out := make(map[string]struct{}, len(keys))
	for _, k := range keys {
		out[k] = struct{}{}
	}
	return out, nil
}

// InsertLogAndPrune atomically inserts a deduplicated log row and prunes older rows beyond maxKeep per user.
// Returns inserted=false if this (item_id, trigger_key) was already recorded.
func (s *PGStore) InsertLogAndPrune(ctx context.Context, rec LogRecord, maxKeep int) (bool, error) {
	rowsAffected, err := s.q.InsertLog(ctx, sqlcgen.InsertLogParams{
		UserID:       rec.UserID,
		ItemID:       rec.ItemID,
		ItemTitle:    rec.ItemTitle,
		TriggerKey:   rec.TriggerKey,
		TriggerLabel: rec.TriggerLabel,
		Status:       rec.Status,
		Error:        rec.Error,
	})
	if err != nil {
		return false, err
	}
	inserted := rowsAffected > 0
	if inserted && maxKeep > 0 {
		_ = s.q.PruneUserLogs(ctx, sqlcgen.PruneUserLogsParams{
			UserID: rec.UserID,
			Limit:  int32(maxKeep),
		})
	}
	return inserted, nil
}

func (s *PGStore) ListLogs(ctx context.Context, userID int64, limit int) ([]LogRecord, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.q.ListLogs(ctx, sqlcgen.ListLogsParams{
		UserID: userID,
		Limit:  int32(limit),
	})
	if err != nil {
		return nil, err
	}
	out := make([]LogRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, toLogRecord(row))
	}
	return out, nil
}
