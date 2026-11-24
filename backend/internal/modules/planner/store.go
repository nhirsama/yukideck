package planner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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

type LogRecord struct {
	ID           int64     `json:"id"`
	UserID       int64     `json:"-"`
	ItemID       *int64    `json:"item_id,omitempty"`
	ItemTitle    string    `json:"item_title"`
	TriggerKey   string    `json:"trigger_key"`
	TriggerLabel string    `json:"trigger_label"`
	Status       string    `json:"status"` // "ok" | "failed"
	Error        string    `json:"error,omitempty"`
	SentAt       time.Time `json:"sent_at"`
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
	pool *pgxpool.Pool
}

func NewPGStore(pool *pgxpool.Pool) Store {
	return &PGStore{pool: pool}
}

func scanItem(row pgx.Row) (*ItemRecord, error) {
	var (
		r            ItemRecord
		repeatCfgRaw []byte
		offsetsRaw   []byte
	)
	err := row.Scan(
		&r.ID, &r.UserID, &r.Title, &r.Note, &r.Status,
		&r.TargetAt, &r.Timezone, &r.CalendarType,
		&r.RepeatType, &repeatCfgRaw, &r.AutoAdvance,
		&offsetsRaw, &r.ChannelIDs, &r.NextTriggerAt,
		&r.CreatedAt, &r.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(repeatCfgRaw) > 0 {
		_ = json.Unmarshal(repeatCfgRaw, &r.RepeatConfig)
	}
	if len(offsetsRaw) > 0 {
		_ = json.Unmarshal(offsetsRaw, &r.RemindOffsets)
	}
	if r.RemindOffsets == nil {
		r.RemindOffsets = []RemindOffset{}
	}
	if r.ChannelIDs == nil {
		r.ChannelIDs = []int64{}
	}
	return &r, nil
}

const itemColumns = `
	id, user_id, title, note, status,
	target_at, timezone, calendar_type,
	repeat_type, repeat_config, auto_advance,
	remind_offsets, channel_ids, next_trigger_at,
	created_at, updated_at
`

func (s *PGStore) ListItems(ctx context.Context, userID int64) ([]ItemRecord, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+itemColumns+`
		FROM planner_items
		WHERE user_id = $1
		ORDER BY
			CASE WHEN status = 'pending' THEN 0 ELSE 1 END ASC,
			target_at ASC NULLS LAST,
			id DESC
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("list planner items: %w", err)
	}
	defer rows.Close()

	var out []ItemRecord
	for rows.Next() {
		item, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		if item != nil {
			out = append(out, *item)
		}
	}
	return out, rows.Err()
}

func (s *PGStore) GetItem(ctx context.Context, userID, id int64) (*ItemRecord, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT `+itemColumns+`
		FROM planner_items
		WHERE user_id = $1 AND id = $2
	`, userID, id)
	return scanItem(row)
}

func (s *PGStore) CreateItem(ctx context.Context, rec ItemRecord) (*ItemRecord, error) {
	repeatJSON, _ := json.Marshal(rec.RepeatConfig)
	offsetsJSON, _ := json.Marshal(rec.RemindOffsets)
	if rec.ChannelIDs == nil {
		rec.ChannelIDs = []int64{}
	}
	row := s.pool.QueryRow(ctx, `
		INSERT INTO planner_items (
			user_id, title, note, status,
			target_at, timezone, calendar_type,
			repeat_type, repeat_config, auto_advance,
			remind_offsets, channel_ids, next_trigger_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		RETURNING `+itemColumns,
		rec.UserID, rec.Title, rec.Note, rec.Status,
		rec.TargetAt, rec.Timezone, rec.CalendarType,
		rec.RepeatType, repeatJSON, rec.AutoAdvance,
		offsetsJSON, rec.ChannelIDs, rec.NextTriggerAt,
	)
	return scanItem(row)
}

func (s *PGStore) UpdateItem(ctx context.Context, rec ItemRecord) (*ItemRecord, error) {
	repeatJSON, _ := json.Marshal(rec.RepeatConfig)
	offsetsJSON, _ := json.Marshal(rec.RemindOffsets)
	if rec.ChannelIDs == nil {
		rec.ChannelIDs = []int64{}
	}
	row := s.pool.QueryRow(ctx, `
		UPDATE planner_items
		SET title = $3,
		    note = $4,
		    status = $5,
		    target_at = $6,
		    timezone = $7,
		    calendar_type = $8,
		    repeat_type = $9,
		    repeat_config = $10,
		    auto_advance = $11,
		    remind_offsets = $12,
		    channel_ids = $13,
		    next_trigger_at = $14,
		    updated_at = NOW()
		WHERE user_id = $1 AND id = $2
		RETURNING `+itemColumns,
		rec.UserID, rec.ID, rec.Title, rec.Note, rec.Status,
		rec.TargetAt, rec.Timezone, rec.CalendarType,
		rec.RepeatType, repeatJSON, rec.AutoAdvance,
		offsetsJSON, rec.ChannelIDs, rec.NextTriggerAt,
	)
	return scanItem(row)
}

func (s *PGStore) DeleteItem(ctx context.Context, userID, id int64) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM planner_items WHERE user_id = $1 AND id = $2`, userID, id)
	return err
}

// ListDueItems uses the partial B-Tree index idx_planner_items_due.
func (s *PGStore) ListDueItems(ctx context.Context, now time.Time) ([]ItemRecord, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+itemColumns+`
		FROM planner_items
		WHERE status = 'pending'
		  AND next_trigger_at IS NOT NULL
		  AND next_trigger_at <= $1
		ORDER BY next_trigger_at ASC
		LIMIT 200
	`, now.UTC())
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []ItemRecord
	for rows.Next() {
		item, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		if item != nil {
			out = append(out, *item)
		}
	}
	return out, rows.Err()
}

// MinNextTriggerAt reads the leftmost leaf of partial index idx_planner_items_due in O(log N).
func (s *PGStore) MinNextTriggerAt(ctx context.Context) (*time.Time, error) {
	var t *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT MIN(next_trigger_at)
		FROM planner_items
		WHERE status = 'pending' AND next_trigger_at IS NOT NULL
	`).Scan(&t)
	if err != nil {
		return nil, err
	}
	return t, nil
}

func (s *PGStore) ListSentTriggerKeys(ctx context.Context, itemID int64) (map[string]struct{}, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT trigger_key FROM planner_logs WHERE item_id = $1
	`, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[string]struct{})
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		out[k] = struct{}{}
	}
	return out, rows.Err()
}

// InsertLogAndPrune atomically inserts a deduplicated log row and prunes older rows beyond maxKeep per user.
// Returns inserted=false if this (item_id, trigger_key) was already recorded.
func (s *PGStore) InsertLogAndPrune(ctx context.Context, rec LogRecord, maxKeep int) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO planner_logs (user_id, item_id, item_title, trigger_key, trigger_label, status, error)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (item_id, trigger_key) WHERE item_id IS NOT NULL DO NOTHING
	`, rec.UserID, rec.ItemID, rec.ItemTitle, rec.TriggerKey, rec.TriggerLabel, rec.Status, rec.Error)
	if err != nil {
		return false, err
	}
	inserted := tag.RowsAffected() > 0
	if inserted && maxKeep > 0 {
		_, _ = s.pool.Exec(ctx, `
			DELETE FROM planner_logs
			WHERE user_id = $1
			  AND id NOT IN (
				SELECT id FROM planner_logs WHERE user_id = $1 ORDER BY sent_at DESC, id DESC LIMIT $2
			  )
		`, rec.UserID, maxKeep)
	}
	return inserted, nil
}

func (s *PGStore) ListLogs(ctx context.Context, userID int64, limit int) ([]LogRecord, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, user_id, item_id, item_title, trigger_key, trigger_label, status, error, sent_at
		FROM planner_logs
		WHERE user_id = $1
		ORDER BY sent_at DESC, id DESC
		LIMIT $2
	`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]LogRecord, 0)
	for rows.Next() {
		var r LogRecord
		if err := rows.Scan(&r.ID, &r.UserID, &r.ItemID, &r.ItemTitle, &r.TriggerKey, &r.TriggerLabel, &r.Status, &r.Error, &r.SentAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
