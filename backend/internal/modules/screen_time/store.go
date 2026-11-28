package screen_time

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"yukideck/internal/modules/screen_time/sqlcgen"
)

type ConfigRecord struct {
	UserID              int64
	APIBaseURL          string
	APIKeyEnc           string
	APIKeyHint          string
	WakaTimeUsername    string
	TimeoutMinutes      int
	HistoryImportedAt   *time.Time
	LastSyncedAt        *time.Time
	LastSyncAttemptAt   *time.Time
	LastSyncedDate      *time.Time
	LastSyncStatus      string
	LastSyncError       string
	NextScheduledSyncAt *time.Time
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

type HeartbeatRecord struct {
	ID          int64
	UserID      int64
	StatDate    time.Time
	HeartbeatAt time.Time
	Project     string
	Language    string
	Editor      string
	OS          string
	Category    string
	Machine     string
}

type DueScheduledConfig struct {
	Config       ConfigRecord
	UserTimezone string
}

type DailyTotalRecord struct {
	UserID       int64
	StatDate     time.Time
	TotalSeconds float64
	Timezone     string
	SyncedAt     time.Time
}

type DimensionRecord struct {
	UserID       int64
	StatDate     time.Time
	Dimension    string
	Name         string
	TotalSeconds float64
}

type DurationRecord struct {
	ID              int64
	UserID          int64
	StatDate        time.Time
	StartedAt       time.Time
	DurationSeconds float64
	Project         string
	Color           string
}

type DayDataBatchItem struct {
	StatDate          time.Time
	TotalSeconds      float64
	Timezone          string
	Dims              []DimensionRecord
	Durations         []DurationRecord
	ReplaceDurations  bool
	Heartbeats        []HeartbeatRecord
	ReplaceHeartbeats bool
}

type Store interface {
	GetConfig(ctx context.Context, userID int64) (*ConfigRecord, error)
	UpsertConfig(ctx context.Context, rec ConfigRecord) (*ConfigRecord, error)
	UpdateSyncOutcome(ctx context.Context, rec ConfigRecord) (*ConfigRecord, error)
	MarkHistoryImported(ctx context.Context, userID int64, importedAt time.Time) error
	ListDueScheduledConfigs(ctx context.Context, now time.Time) ([]DueScheduledConfig, error)

	HasDurationsOnDate(ctx context.Context, userID int64, statDate time.Time) (bool, error)
	HasHeartbeatsOnDate(ctx context.Context, userID int64, statDate time.Time) (bool, error)
	ReplaceDayData(
		ctx context.Context,
		userID int64,
		statDate time.Time,
		totalSeconds float64,
		timezone string,
		dims []DimensionRecord,
		durations []DurationRecord,
		replaceDurations bool,
		heartbeats []HeartbeatRecord,
		replaceHeartbeats bool,
	) error
	ReplaceDaysBatch(ctx context.Context, userID int64, items []DayDataBatchItem) error

	ListDailyTotals(ctx context.Context, userID int64, startDate, endDate time.Time) ([]DailyTotalRecord, error)
	ListAllDailyTotals(ctx context.Context, userID int64) ([]DailyTotalRecord, error)
	ListDailyDimensions(ctx context.Context, userID int64, startDate, endDate time.Time) ([]DimensionRecord, error)
	ListDailyDimensionsByDim(ctx context.Context, userID int64, dimension string, startDate, endDate time.Time) ([]DimensionRecord, error)
	ListDurationsByDateRange(ctx context.Context, userID int64, startDate, endDate time.Time) ([]DurationRecord, error)
	ListDurationsByDate(ctx context.Context, userID int64, statDate time.Time) ([]DurationRecord, error)
}

type PGStore struct {
	pool *pgxpool.Pool
	q    *sqlcgen.Queries
}

func NewPGStore(pool *pgxpool.Pool) *PGStore {
	return &PGStore{
		pool: pool,
		q:    sqlcgen.New(pool),
	}
}

func toConfigRecord(row sqlcgen.ScreenTimeConfig) *ConfigRecord {
	return &ConfigRecord{
		UserID:              row.UserID,
		APIBaseURL:          row.ApiBaseUrl,
		APIKeyEnc:           row.ApiKeyEnc,
		APIKeyHint:          row.ApiKeyHint,
		WakaTimeUsername:    row.WakatimeUsername,
		TimeoutMinutes:      normalizeTimeoutMinutes(int(row.TimeoutMinutes)),
		HistoryImportedAt:   row.HistoryImportedAt,
		LastSyncedAt:        row.LastSyncedAt,
		LastSyncAttemptAt:   row.LastSyncAttemptAt,
		LastSyncedDate:      row.LastSyncedDate,
		LastSyncStatus:      row.LastSyncStatus,
		LastSyncError:       row.LastSyncError,
		NextScheduledSyncAt: row.NextScheduledSyncAt,
		CreatedAt:           row.CreatedAt,
		UpdatedAt:           row.UpdatedAt,
	}
}

func (s *PGStore) GetConfig(ctx context.Context, userID int64) (*ConfigRecord, error) {
	row, err := s.q.GetConfig(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get screen_time config: %w", err)
	}
	return toConfigRecord(row), nil
}

func (s *PGStore) UpsertConfig(ctx context.Context, rec ConfigRecord) (*ConfigRecord, error) {
	row, err := s.q.UpsertConfig(ctx, sqlcgen.UpsertConfigParams{
		UserID:              rec.UserID,
		ApiBaseUrl:          rec.APIBaseURL,
		ApiKeyEnc:           rec.APIKeyEnc,
		ApiKeyHint:          rec.APIKeyHint,
		WakatimeUsername:    rec.WakaTimeUsername,
		TimeoutMinutes:      int32(normalizeTimeoutMinutes(rec.TimeoutMinutes)),
		LastSyncStatus:      rec.LastSyncStatus,
		LastSyncError:       rec.LastSyncError,
		NextScheduledSyncAt: rec.NextScheduledSyncAt,
	})
	if err != nil {
		return nil, fmt.Errorf("upsert screen_time config: %w", err)
	}
	return toConfigRecord(row), nil
}

func (s *PGStore) UpdateSyncOutcome(ctx context.Context, rec ConfigRecord) (*ConfigRecord, error) {
	row, err := s.q.UpdateSyncOutcome(ctx, sqlcgen.UpdateSyncOutcomeParams{
		UserID:              rec.UserID,
		WakatimeUsername:    rec.WakaTimeUsername,
		TimeoutMinutes:      int32(normalizeTimeoutMinutes(rec.TimeoutMinutes)),
		LastSyncedAt:        rec.LastSyncedAt,
		LastSyncAttemptAt:   rec.LastSyncAttemptAt,
		LastSyncedDate:      rec.LastSyncedDate,
		LastSyncStatus:      rec.LastSyncStatus,
		LastSyncError:       rec.LastSyncError,
		NextScheduledSyncAt: rec.NextScheduledSyncAt,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("update screen_time sync outcome: %w", err)
	}
	return toConfigRecord(row), nil
}

func (s *PGStore) MarkHistoryImported(ctx context.Context, userID int64, importedAt time.Time) error {
	return s.q.MarkHistoryImported(ctx, sqlcgen.MarkHistoryImportedParams{
		UserID:            userID,
		HistoryImportedAt: &importedAt,
	})
}

func (s *PGStore) ListDueScheduledConfigs(ctx context.Context, now time.Time) ([]DueScheduledConfig, error) {
	rows, err := s.q.ListDueScheduledConfigs(ctx, &now)
	if err != nil {
		return nil, fmt.Errorf("list due screen_time configs: %w", err)
	}
	out := make([]DueScheduledConfig, 0, len(rows))
	for _, r := range rows {
		out = append(out, DueScheduledConfig{
			Config: ConfigRecord{
				UserID:              r.UserID,
				APIBaseURL:          r.ApiBaseUrl,
				APIKeyEnc:           r.ApiKeyEnc,
				APIKeyHint:          r.ApiKeyHint,
				WakaTimeUsername:    r.WakatimeUsername,
				TimeoutMinutes:      normalizeTimeoutMinutes(int(r.TimeoutMinutes)),
				HistoryImportedAt:   r.HistoryImportedAt,
				LastSyncedAt:        r.LastSyncedAt,
				LastSyncAttemptAt:   r.LastSyncAttemptAt,
				LastSyncedDate:      r.LastSyncedDate,
				LastSyncStatus:      r.LastSyncStatus,
				LastSyncError:       r.LastSyncError,
				NextScheduledSyncAt: r.NextScheduledSyncAt,
				CreatedAt:           r.CreatedAt,
				UpdatedAt:           r.UpdatedAt,
			},
			UserTimezone: r.UserTimezone,
		})
	}
	return out, nil
}

func (s *PGStore) HasDurationsOnDate(ctx context.Context, userID int64, statDate time.Time) (bool, error) {
	return s.q.HasDurationsOnDate(ctx, sqlcgen.HasDurationsOnDateParams{
		UserID:   userID,
		StatDate: statDate,
	})
}

func (s *PGStore) HasHeartbeatsOnDate(ctx context.Context, userID int64, statDate time.Time) (bool, error) {
	return s.q.HasHeartbeatsOnDate(ctx, sqlcgen.HasHeartbeatsOnDateParams{
		UserID:   userID,
		StatDate: statDate,
	})
}

func (s *PGStore) ReplaceDayData(
	ctx context.Context,
	userID int64,
	statDate time.Time,
	totalSeconds float64,
	timezone string,
	dims []DimensionRecord,
	durations []DurationRecord,
	replaceDurations bool,
	heartbeats []HeartbeatRecord,
	replaceHeartbeats bool,
) error {
	return s.ReplaceDaysBatch(ctx, userID, []DayDataBatchItem{{
		StatDate:          statDate,
		TotalSeconds:      totalSeconds,
		Timezone:          timezone,
		Dims:              dims,
		Durations:         durations,
		ReplaceDurations:  replaceDurations,
		Heartbeats:        heartbeats,
		ReplaceHeartbeats: replaceHeartbeats,
	}})
}

// ReplaceDaysBatch atomically replaces one or more days using pipelined batch upserts
// and PostgreSQL COPY FROM streams, eliminating per-row round trips.
func (s *PGStore) ReplaceDaysBatch(ctx context.Context, userID int64, items []DayDataBatchItem) error {
	if len(items) == 0 {
		return nil
	}

	// Deduplicate by stat_date within the batch (keep last occurrence) so primary keys never collide.
	deduped := make([]DayDataBatchItem, 0, len(items))
	indexByDate := make(map[string]int, len(items))
	for _, it := range items {
		key := it.StatDate.UTC().Format(dateLayout)
		if idx, exists := indexByDate[key]; exists {
			deduped[idx] = it
		} else {
			indexByDate[key] = len(deduped)
			deduped = append(deduped, it)
		}
	}

	totalParams := make([]sqlcgen.UpsertDailyTotalsBatchParams, 0, len(deduped))
	allDates := make([]time.Time, 0, len(deduped))
	durDates := make([]time.Time, 0, len(deduped))
	hbDates := make([]time.Time, 0, len(deduped))

	dimCap, durCap, hbCap := 0, 0, 0
	for _, it := range deduped {
		dimCap += len(it.Dims)
		if it.ReplaceDurations {
			durCap += len(it.Durations)
		}
		if it.ReplaceHeartbeats {
			hbCap += len(it.Heartbeats)
		}
	}

	dimRows := make([]sqlcgen.CopyDailyDimensionsParams, 0, dimCap)
	durRows := make([]sqlcgen.CopyDurationsParams, 0, durCap)
	hbRows := make([]sqlcgen.CopyHeartbeatsParams, 0, hbCap)

	for _, it := range deduped {
		totalParams = append(totalParams, sqlcgen.UpsertDailyTotalsBatchParams{
			UserID:       userID,
			StatDate:     it.StatDate,
			TotalSeconds: it.TotalSeconds,
			Timezone:     it.Timezone,
		})
		allDates = append(allDates, it.StatDate)
		for _, d := range it.Dims {
			dimRows = append(dimRows, sqlcgen.CopyDailyDimensionsParams{
				UserID:       userID,
				StatDate:     it.StatDate,
				Dimension:    d.Dimension,
				Name:         d.Name,
				TotalSeconds: d.TotalSeconds,
			})
		}
		if it.ReplaceDurations {
			durDates = append(durDates, it.StatDate)
			for _, dur := range it.Durations {
				durRows = append(durRows, sqlcgen.CopyDurationsParams{
					UserID:          userID,
					StatDate:        it.StatDate,
					StartedAt:       dur.StartedAt.UTC(),
					DurationSeconds: dur.DurationSeconds,
					Project:         dur.Project,
					Color:           dur.Color,
				})
			}
		}
		if it.ReplaceHeartbeats {
			hbDates = append(hbDates, it.StatDate)
			for _, hb := range it.Heartbeats {
				hbRows = append(hbRows, sqlcgen.CopyHeartbeatsParams{
					UserID:      userID,
					StatDate:    it.StatDate,
					HeartbeatAt: hb.HeartbeatAt.UTC(),
					Project:     hb.Project,
					Language:    hb.Language,
					Editor:      hb.Editor,
					Os:          hb.OS,
					Category:    hb.Category,
					Machine:     hb.Machine,
				})
			}
		}
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin replace days tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	qtx := s.q.WithTx(tx)

	var batchErr error
	br := qtx.UpsertDailyTotalsBatch(ctx, totalParams)
	br.Exec(func(_ int, execErr error) {
		if execErr != nil && batchErr == nil {
			batchErr = execErr
		}
	})
	if batchErr != nil {
		return fmt.Errorf("upsert daily totals batch: %w", batchErr)
	}

	if err := qtx.DeleteDailyDimensionsByDates(ctx, sqlcgen.DeleteDailyDimensionsByDatesParams{
		UserID:  userID,
		Column2: allDates,
	}); err != nil {
		return fmt.Errorf("delete daily dimensions batch: %w", err)
	}
	if len(dimRows) > 0 {
		if _, err := qtx.CopyDailyDimensions(ctx, dimRows); err != nil {
			return fmt.Errorf("copy daily dimensions: %w", err)
		}
	}

	if len(durDates) > 0 {
		if err := qtx.DeleteDurationsByDates(ctx, sqlcgen.DeleteDurationsByDatesParams{
			UserID:  userID,
			Column2: durDates,
		}); err != nil {
			return fmt.Errorf("delete durations batch: %w", err)
		}
		if len(durRows) > 0 {
			if _, err := qtx.CopyDurations(ctx, durRows); err != nil {
				return fmt.Errorf("copy durations: %w", err)
			}
		}
	}

	if len(hbDates) > 0 {
		if err := qtx.DeleteHeartbeatsByDates(ctx, sqlcgen.DeleteHeartbeatsByDatesParams{
			UserID:  userID,
			Column2: hbDates,
		}); err != nil {
			return fmt.Errorf("delete heartbeats batch: %w", err)
		}
		if len(hbRows) > 0 {
			if _, err := qtx.CopyHeartbeats(ctx, hbRows); err != nil {
				return fmt.Errorf("copy heartbeats: %w", err)
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit replace days tx: %w", err)
	}
	return nil
}

func (s *PGStore) ListDailyTotals(ctx context.Context, userID int64, startDate, endDate time.Time) ([]DailyTotalRecord, error) {
	rows, err := s.q.ListDailyTotals(ctx, sqlcgen.ListDailyTotalsParams{
		UserID:     userID,
		StatDate:   startDate,
		StatDate_2: endDate,
	})
	if err != nil {
		return nil, fmt.Errorf("list daily totals: %w", err)
	}
	out := make([]DailyTotalRecord, 0, len(rows))
	for _, r := range rows {
		out = append(out, DailyTotalRecord{
			UserID:       r.UserID,
			StatDate:     r.StatDate,
			TotalSeconds: r.TotalSeconds,
			Timezone:     r.Timezone,
			SyncedAt:     r.SyncedAt,
		})
	}
	return out, nil
}

func (s *PGStore) ListAllDailyTotals(ctx context.Context, userID int64) ([]DailyTotalRecord, error) {
	rows, err := s.q.ListAllDailyTotals(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list all daily totals: %w", err)
	}
	out := make([]DailyTotalRecord, 0, len(rows))
	for _, r := range rows {
		out = append(out, DailyTotalRecord{
			UserID:       r.UserID,
			StatDate:     r.StatDate,
			TotalSeconds: r.TotalSeconds,
			Timezone:     r.Timezone,
			SyncedAt:     r.SyncedAt,
		})
	}
	return out, nil
}

func (s *PGStore) ListDailyDimensions(ctx context.Context, userID int64, startDate, endDate time.Time) ([]DimensionRecord, error) {
	rows, err := s.q.ListDailyDimensions(ctx, sqlcgen.ListDailyDimensionsParams{
		UserID:     userID,
		StatDate:   startDate,
		StatDate_2: endDate,
	})
	if err != nil {
		return nil, fmt.Errorf("list daily dimensions: %w", err)
	}
	out := make([]DimensionRecord, 0, len(rows))
	for _, r := range rows {
		out = append(out, DimensionRecord{
			UserID:       r.UserID,
			StatDate:     r.StatDate,
			Dimension:    r.Dimension,
			Name:         r.Name,
			TotalSeconds: r.TotalSeconds,
		})
	}
	return out, nil
}

func (s *PGStore) ListDailyDimensionsByDim(ctx context.Context, userID int64, dimension string, startDate, endDate time.Time) ([]DimensionRecord, error) {
	rows, err := s.q.ListDailyDimensionsByDim(ctx, sqlcgen.ListDailyDimensionsByDimParams{
		UserID:     userID,
		Dimension:  dimension,
		StatDate:   startDate,
		StatDate_2: endDate,
	})
	if err != nil {
		return nil, fmt.Errorf("list daily dimensions by dim: %w", err)
	}
	out := make([]DimensionRecord, 0, len(rows))
	for _, r := range rows {
		out = append(out, DimensionRecord{
			UserID:       r.UserID,
			StatDate:     r.StatDate,
			Dimension:    r.Dimension,
			Name:         r.Name,
			TotalSeconds: r.TotalSeconds,
		})
	}
	return out, nil
}

func (s *PGStore) ListDurationsByDateRange(ctx context.Context, userID int64, startDate, endDate time.Time) ([]DurationRecord, error) {
	rows, err := s.q.ListDurationsByDateRange(ctx, sqlcgen.ListDurationsByDateRangeParams{
		UserID:     userID,
		StatDate:   startDate,
		StatDate_2: endDate,
	})
	if err != nil {
		return nil, fmt.Errorf("list durations by range: %w", err)
	}
	out := make([]DurationRecord, 0, len(rows))
	for _, r := range rows {
		out = append(out, DurationRecord{
			ID:              r.ID,
			UserID:          r.UserID,
			StatDate:        r.StatDate,
			StartedAt:       r.StartedAt,
			DurationSeconds: r.DurationSeconds,
			Project:         r.Project,
			Color:           r.Color,
		})
	}
	return out, nil
}

func (s *PGStore) ListDurationsByDate(ctx context.Context, userID int64, statDate time.Time) ([]DurationRecord, error) {
	rows, err := s.q.ListDurationsByDate(ctx, sqlcgen.ListDurationsByDateParams{
		UserID:   userID,
		StatDate: statDate,
	})
	if err != nil {
		return nil, fmt.Errorf("list durations by date: %w", err)
	}
	out := make([]DurationRecord, 0, len(rows))
	for _, r := range rows {
		out = append(out, DurationRecord{
			ID:              r.ID,
			UserID:          r.UserID,
			StatDate:        r.StatDate,
			StartedAt:       r.StartedAt,
			DurationSeconds: r.DurationSeconds,
			Project:         r.Project,
			Color:           r.Color,
		})
	}
	return out, nil
}
