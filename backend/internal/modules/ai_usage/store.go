package ai_usage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"yukideck/internal/modules/ai_usage/sqlcgen"
)

type HourlySessionRecord struct {
	ID                 int64
	UserID             int64
	DeviceID           string
	Agent              string
	SessionID          string
	HourBucket         time.Time
	Model              string
	IsSubagent         bool
	ParentSessionID    string
	Provider           string
	Project            string
	InputTokens        int64
	OutputTokens       int64
	CacheReadTokens    int64
	CacheWriteTokens   int64
	CacheWrite1hTokens int64
	ReasoningTokens    int64
	MaxContextTokens   int64
	ReportedCostUSD    float64
	RequestCount       int32
	ToolCallCount      int32
	ToolCalls          map[string]int32
	FirstEventAt       time.Time
	LastEventAt        time.Time
	UpdatedAt          time.Time
}

func (r HourlySessionRecord) TotalTokens() int64 {
	return r.InputTokens + r.OutputTokens + r.CacheReadTokens + r.CacheWriteTokens + r.CacheWrite1hTokens + r.ReasoningTokens
}

type SessionPageFilter struct {
	Start         time.Time
	End           time.Time
	Agent         string
	DeviceID      string
	Project       string
	IncludeHidden bool
	RawModels     []string
	Page          int
	PageSize      int
}

type Store interface {
	UpsertDeviceFromIngest(ctx context.Context, userID int64, dev IngestDevice) (*Device, error)
	UpsertHourlySessions(ctx context.Context, userID int64, rows []HourlySessionRecord, forceOverwrite bool) error
	ListHourlySessions(ctx context.Context, userID int64, start, end time.Time) ([]HourlySessionRecord, error)
	ListHourlySessionsBySession(ctx context.Context, userID int64, sessionID, deviceID string) ([]HourlySessionRecord, error)
	ListDistinctModelsInRange(ctx context.Context, userID int64, start, end time.Time) ([]string, error)
	ListPagedSessionSlices(ctx context.Context, userID int64, filter SessionPageFilter) ([]HourlySessionRecord, int, error)

	ListDevices(ctx context.Context, userID int64) ([]Device, error)
	UpdateDevice(ctx context.Context, userID int64, deviceID, name string, hidden bool) (*Device, error)
	DeleteDevice(ctx context.Context, userID int64, deviceID string) (bool, error)

	ListModelAliases(ctx context.Context, userID int64) ([]ModelAlias, error)
	UpsertModelAlias(ctx context.Context, userID int64, in UpsertModelAliasInput) (*ModelAlias, error)
	DeleteModelAlias(ctx context.Context, userID, id int64) (bool, error)

	ListModelPrices(ctx context.Context, userID int64) ([]ModelPrice, error)
	UpsertModelPrice(ctx context.Context, userID int64, in UpsertModelPriceInput) (*ModelPrice, error)
	DeleteModelPrice(ctx context.Context, userID, id int64) (bool, error)
}

type PGStore struct {
	pool *pgxpool.Pool
	q    *sqlcgen.Queries
}

func NewPGStore(pool *pgxpool.Pool) Store {
	return &PGStore{pool: pool, q: sqlcgen.New(pool)}
}

func toHourlyRecord(row sqlcgen.AiUsageHourlySession) HourlySessionRecord {
	rec := HourlySessionRecord{
		ID:                 row.ID,
		UserID:             row.UserID,
		DeviceID:           row.DeviceID,
		Agent:              row.Agent,
		SessionID:          row.SessionID,
		HourBucket:         row.HourBucket.UTC(),
		Model:              row.Model,
		IsSubagent:         row.IsSubagent,
		ParentSessionID:    row.ParentSessionID,
		Provider:           row.Provider,
		Project:            row.Project,
		InputTokens:        row.InputTokens,
		OutputTokens:       row.OutputTokens,
		CacheReadTokens:    row.CacheReadTokens,
		CacheWriteTokens:   row.CacheWriteTokens,
		CacheWrite1hTokens: row.CacheWrite1hTokens,
		ReasoningTokens:    row.ReasoningTokens,
		MaxContextTokens:   row.MaxContextTokens,
		ReportedCostUSD:    row.ReportedCostUsd,
		RequestCount:       row.RequestCount,
		ToolCallCount:      row.ToolCallCount,
		ToolCalls:          map[string]int32{},
		FirstEventAt:       row.FirstEventAt.UTC(),
		LastEventAt:        row.LastEventAt.UTC(),
		UpdatedAt:          row.UpdatedAt.UTC(),
	}
	if len(row.ToolCalls) > 0 {
		_ = json.Unmarshal(row.ToolCalls, &rec.ToolCalls)
	}
	if rec.ToolCalls == nil {
		rec.ToolCalls = map[string]int32{}
	}
	return rec
}

func toDeviceDTO(row sqlcgen.AiUsageDevice) Device {
	return Device{
		ID:               row.ID,
		DeviceID:         row.DeviceID,
		Name:             row.Name,
		OS:               row.Os,
		Arch:             row.Arch,
		Hostname:         row.Hostname,
		CollectorVersion: row.CollectorVersion,
		LastSyncedAt:     row.LastSyncedAt.UTC(),
		Hidden:           row.Hidden,
		CreatedAt:        row.CreatedAt.UTC(),
		UpdatedAt:        row.UpdatedAt.UTC(),
	}
}

func toAliasDTO(row sqlcgen.AiUsageModelAlias) ModelAlias {
	return ModelAlias{
		ID:             row.ID,
		MatchPattern:   row.MatchPattern,
		CanonicalModel: row.CanonicalModel,
		Priority:       row.Priority,
		CreatedAt:      row.CreatedAt.UTC(),
		UpdatedAt:      row.UpdatedAt.UTC(),
	}
}

func toPriceDTO(row sqlcgen.AiUsageModelPrice) ModelPrice {
	return ModelPrice{
		ID:               row.ID,
		ModelPattern:     row.ModelPattern,
		InputPerM:        row.InputPerM,
		OutputPerM:       row.OutputPerM,
		CacheReadPerM:    row.CacheReadPerM,
		CacheWritePerM:   row.CacheWritePerM,
		CacheWrite1hPerM: row.CacheWrite1hPerM,
		Builtin:          false,
		CreatedAt:        row.CreatedAt.UTC(),
		UpdatedAt:        row.UpdatedAt.UTC(),
	}
}

func (s *PGStore) UpsertDeviceFromIngest(ctx context.Context, userID int64, dev IngestDevice) (*Device, error) {
	row, err := s.q.UpsertDeviceFromIngest(ctx, sqlcgen.UpsertDeviceFromIngestParams{
		UserID:           userID,
		DeviceID:         dev.DeviceID,
		Name:             dev.Name,
		Os:               dev.OS,
		Arch:             dev.Arch,
		Hostname:         dev.Hostname,
		CollectorVersion: dev.CollectorVersion,
	})
	if err != nil {
		return nil, fmt.Errorf("upsert ai_usage device: %w", err)
	}
	out := toDeviceDTO(row)
	return &out, nil
}

func (s *PGStore) UpsertHourlySessions(ctx context.Context, userID int64, rows []HourlySessionRecord, forceOverwrite bool) error {
	if len(rows) == 0 {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin ai_usage ingest tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	qtx := s.q.WithTx(tx)
	params := make([]sqlcgen.UpsertHourlySessionParams, 0, len(rows))
	orphanDeletes := make([]sqlcgen.DeleteOrphanNonSubagentHourlySessionParams, 0)
	for _, r := range rows {
		tc := r.ToolCalls
		if tc == nil {
			tc = map[string]int32{}
		}
		tcBytes, err := json.Marshal(tc)
		if err != nil {
			return fmt.Errorf("marshal tool_calls: %w", err)
		}
		params = append(params, sqlcgen.UpsertHourlySessionParams{
			UserID:             userID,
			DeviceID:           r.DeviceID,
			Agent:              r.Agent,
			SessionID:          r.SessionID,
			HourBucket:         r.HourBucket.UTC(),
			Model:              r.Model,
			IsSubagent:         r.IsSubagent,
			ParentSessionID:    r.ParentSessionID,
			Provider:           r.Provider,
			Project:            r.Project,
			InputTokens:        r.InputTokens,
			OutputTokens:       r.OutputTokens,
			CacheReadTokens:    r.CacheReadTokens,
			CacheWriteTokens:   r.CacheWriteTokens,
			CacheWrite1hTokens: r.CacheWrite1hTokens,
			ReasoningTokens:    r.ReasoningTokens,
			MaxContextTokens:   r.MaxContextTokens,
			ReportedCostUsd:    r.ReportedCostUSD,
			RequestCount:       r.RequestCount,
			ToolCallCount:      r.ToolCallCount,
			ToolCalls:          tcBytes,
			FirstEventAt:       r.FirstEventAt.UTC(),
			LastEventAt:        r.LastEventAt.UTC(),
			Column24:           forceOverwrite,
		})
		if r.IsSubagent && r.ParentSessionID != "" && r.ParentSessionID != r.SessionID {
			orphanDeletes = append(orphanDeletes, sqlcgen.DeleteOrphanNonSubagentHourlySessionParams{
				UserID:     userID,
				DeviceID:   r.DeviceID,
				Agent:      r.Agent,
				SessionID:  r.SessionID,
				HourBucket: r.HourBucket.UTC(),
				Model:      r.Model,
			})
		}
	}

	var batchErr error
	br := qtx.UpsertHourlySession(ctx, params)
	br.Exec(func(_ int, err error) {
		if err != nil && batchErr == nil {
			batchErr = err
		}
	})
	if batchErr != nil {
		return fmt.Errorf("upsert hourly session: %w", batchErr)
	}
	if len(orphanDeletes) > 0 {
		var delErr error
		dbr := qtx.DeleteOrphanNonSubagentHourlySession(ctx, orphanDeletes)
		dbr.Exec(func(_ int, err error) {
			if err != nil && delErr == nil {
				delErr = err
			}
		})
		if delErr != nil {
			return fmt.Errorf("delete orphan non-subagent hourly session: %w", delErr)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit ai_usage ingest tx: %w", err)
	}
	return nil
}

func (s *PGStore) ListHourlySessions(ctx context.Context, userID int64, start, end time.Time) ([]HourlySessionRecord, error) {
	rows, err := s.q.ListHourlySessions(ctx, sqlcgen.ListHourlySessionsParams{
		UserID:       userID,
		HourBucket:   start.UTC(),
		HourBucket_2: end.UTC(),
	})
	if err != nil {
		return nil, fmt.Errorf("list hourly sessions: %w", err)
	}
	out := make([]HourlySessionRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, toHourlyRecord(row))
	}
	return out, nil
}

func (s *PGStore) ListHourlySessionsBySession(ctx context.Context, userID int64, sessionID, deviceID string) ([]HourlySessionRecord, error) {
	rows, err := s.q.ListHourlySessionsBySession(ctx, sqlcgen.ListHourlySessionsBySessionParams{
		UserID:    userID,
		SessionID: sessionID,
		Column3:   deviceID,
	})
	if err != nil {
		return nil, fmt.Errorf("list hourly sessions by session: %w", err)
	}
	out := make([]HourlySessionRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, toHourlyRecord(row))
	}
	return out, nil
}

func (s *PGStore) ListDistinctModelsInRange(ctx context.Context, userID int64, start, end time.Time) ([]string, error) {
	models, err := s.q.ListDistinctModelsInRange(ctx, sqlcgen.ListDistinctModelsInRangeParams{
		UserID:       userID,
		HourBucket:   start.UTC(),
		HourBucket_2: end.UTC(),
	})
	if err != nil {
		return nil, fmt.Errorf("list distinct models in range: %w", err)
	}
	return models, nil
}

func (s *PGStore) ListPagedSessionSlices(ctx context.Context, userID int64, filter SessionPageFilter) ([]HourlySessionRecord, int, error) {
	models := filter.RawModels
	if models == nil {
		models = []string{}
	}
	offset := int32((filter.Page - 1) * filter.PageSize)
	if offset < 0 {
		offset = 0
	}
	rows, err := s.q.ListPagedSessionSlices(ctx, sqlcgen.ListPagedSessionSlicesParams{
		UserID:        userID,
		StartTime:     filter.Start.UTC(),
		EndTime:       filter.End.UTC(),
		Agent:         filter.Agent,
		DeviceID:      filter.DeviceID,
		Project:       filter.Project,
		IncludeHidden: filter.IncludeHidden,
		Models:        models,
		PageOffset:    offset,
		PageLimit:     int32(filter.PageSize),
	})
	if err != nil {
		return nil, 0, fmt.Errorf("list paged session slices: %w", err)
	}
	if len(rows) == 0 {
		if filter.Page <= 1 {
			return []HourlySessionRecord{}, 0, nil
		}
		cnt, err := s.q.CountFilteredSessions(ctx, sqlcgen.CountFilteredSessionsParams{
			UserID:        userID,
			StartTime:     filter.Start.UTC(),
			EndTime:       filter.End.UTC(),
			Agent:         filter.Agent,
			DeviceID:      filter.DeviceID,
			Project:       filter.Project,
			IncludeHidden: filter.IncludeHidden,
			Models:        models,
		})
		if err != nil {
			return nil, 0, fmt.Errorf("count filtered sessions: %w", err)
		}
		return []HourlySessionRecord{}, int(cnt), nil
	}

	total := int(rows[0].TotalSessions)
	out := make([]HourlySessionRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, toHourlyRecord(sqlcgen.AiUsageHourlySession{
			ID:                 row.ID,
			UserID:             row.UserID,
			DeviceID:           row.DeviceID,
			Agent:              row.Agent,
			SessionID:          row.SessionID,
			HourBucket:         row.HourBucket,
			Model:              row.Model,
			IsSubagent:         row.IsSubagent,
			ParentSessionID:    row.ParentSessionID,
			Provider:           row.Provider,
			Project:            row.Project,
			InputTokens:        row.InputTokens,
			OutputTokens:       row.OutputTokens,
			CacheReadTokens:    row.CacheReadTokens,
			CacheWriteTokens:   row.CacheWriteTokens,
			CacheWrite1hTokens: row.CacheWrite1hTokens,
			ReasoningTokens:    row.ReasoningTokens,
			MaxContextTokens:   row.MaxContextTokens,
			ReportedCostUsd:    row.ReportedCostUsd,
			RequestCount:       row.RequestCount,
			ToolCallCount:      row.ToolCallCount,
			ToolCalls:          row.ToolCalls,
			FirstEventAt:       row.FirstEventAt,
			LastEventAt:        row.LastEventAt,
			UpdatedAt:          row.UpdatedAt,
		}))
	}
	return out, total, nil
}

func (s *PGStore) ListDevices(ctx context.Context, userID int64) ([]Device, error) {
	rows, err := s.q.ListDevices(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list devices: %w", err)
	}
	out := make([]Device, 0, len(rows))
	for _, row := range rows {
		out = append(out, toDeviceDTO(row))
	}
	return out, nil
}

func (s *PGStore) UpdateDevice(ctx context.Context, userID int64, deviceID, name string, hidden bool) (*Device, error) {
	row, err := s.q.UpdateDevice(ctx, sqlcgen.UpdateDeviceParams{
		UserID:   userID,
		DeviceID: deviceID,
		Name:     name,
		Hidden:   hidden,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("update device: %w", err)
	}
	out := toDeviceDTO(row)
	return &out, nil
}

func (s *PGStore) DeleteDevice(ctx context.Context, userID int64, deviceID string) (bool, error) {
	n, err := s.q.DeleteDevice(ctx, sqlcgen.DeleteDeviceParams{UserID: userID, DeviceID: deviceID})
	if err != nil {
		return false, fmt.Errorf("delete device: %w", err)
	}
	return n > 0, nil
}

func (s *PGStore) ListModelAliases(ctx context.Context, userID int64) ([]ModelAlias, error) {
	rows, err := s.q.ListModelAliases(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list model aliases: %w", err)
	}
	out := make([]ModelAlias, 0, len(rows))
	for _, row := range rows {
		out = append(out, toAliasDTO(row))
	}
	return out, nil
}

func (s *PGStore) UpsertModelAlias(ctx context.Context, userID int64, in UpsertModelAliasInput) (*ModelAlias, error) {
	row, err := s.q.UpsertModelAlias(ctx, sqlcgen.UpsertModelAliasParams{
		UserID:         userID,
		MatchPattern:   in.MatchPattern,
		CanonicalModel: in.CanonicalModel,
		Priority:       in.Priority,
	})
	if err != nil {
		return nil, fmt.Errorf("upsert model alias: %w", err)
	}
	out := toAliasDTO(row)
	return &out, nil
}

func (s *PGStore) DeleteModelAlias(ctx context.Context, userID, id int64) (bool, error) {
	n, err := s.q.DeleteModelAlias(ctx, sqlcgen.DeleteModelAliasParams{UserID: userID, ID: id})
	if err != nil {
		return false, fmt.Errorf("delete model alias: %w", err)
	}
	return n > 0, nil
}

func (s *PGStore) ListModelPrices(ctx context.Context, userID int64) ([]ModelPrice, error) {
	rows, err := s.q.ListModelPrices(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list model prices: %w", err)
	}
	out := make([]ModelPrice, 0, len(rows))
	for _, row := range rows {
		out = append(out, toPriceDTO(row))
	}
	return out, nil
}

func (s *PGStore) UpsertModelPrice(ctx context.Context, userID int64, in UpsertModelPriceInput) (*ModelPrice, error) {
	row, err := s.q.UpsertModelPrice(ctx, sqlcgen.UpsertModelPriceParams{
		UserID:           userID,
		ModelPattern:     in.ModelPattern,
		InputPerM:        in.InputPerM,
		OutputPerM:       in.OutputPerM,
		CacheReadPerM:    in.CacheReadPerM,
		CacheWritePerM:   in.CacheWritePerM,
		CacheWrite1hPerM: in.CacheWrite1hPerM,
	})
	if err != nil {
		return nil, fmt.Errorf("upsert model price: %w", err)
	}
	out := toPriceDTO(row)
	return &out, nil
}

func (s *PGStore) DeleteModelPrice(ctx context.Context, userID, id int64) (bool, error) {
	n, err := s.q.DeleteModelPrice(ctx, sqlcgen.DeleteModelPriceParams{UserID: userID, ID: id})
	if err != nil {
		return false, fmt.Errorf("delete model price: %w", err)
	}
	return n > 0, nil
}
