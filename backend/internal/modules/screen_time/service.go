package screen_time

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"yukideck/internal/core/auth"
	"yukideck/internal/core/crypto"
	"yukideck/internal/core/httpx"
)

const (
	dateLayout            = "2006-01-02"
	ScheduledSyncInterval = 7 * 24 * time.Hour
	ScheduledSyncDays     = 8 // 7-day cadence + 1-day midnight overlap
	VisitSyncCooldown     = 30 * time.Minute
	ErrorRetryDebounce    = 1 * time.Minute
	MaxVisitLookbackDays  = 14
	defaultThrottleDelay  = 200 * time.Millisecond
)

type Service struct {
	store              Store
	box                *crypto.Box
	client             WakaTimeClient
	logger             *slog.Logger
	nowFunc            func() time.Time
	throttleDelay      time.Duration
	dumpPollInterval   time.Duration
	asyncInitSync      bool
	asyncHistoryImport bool

	syncMu    sync.Mutex
	syncLocks map[int64]bool

	historyMu   sync.Mutex
	historyJobs map[int64]*HistoryImportStatus
}

func NewService(store Store, box *crypto.Box, client WakaTimeClient, logger *slog.Logger) *Service {
	if client == nil {
		client = NewHTTPWakaTimeClient(defaultRequestTimeout)
	}
	return &Service{
		store:              store,
		box:                box,
		client:             client,
		logger:             logger,
		nowFunc:            time.Now,
		throttleDelay:      defaultThrottleDelay,
		dumpPollInterval:   defaultDumpPollInterval,
		asyncInitSync:      true,
		asyncHistoryImport: true,
		syncLocks:          make(map[int64]bool),
		historyJobs:        make(map[int64]*HistoryImportStatus),
	}
}

func (s *Service) now() time.Time {
	if s.nowFunc != nil {
		return s.nowFunc().UTC()
	}
	return time.Now().UTC()
}

func (s *Service) tryLockUser(userID int64) bool {
	s.syncMu.Lock()
	defer s.syncMu.Unlock()
	if s.syncLocks[userID] {
		return false
	}
	s.syncLocks[userID] = true
	return true
}

func (s *Service) unlockUser(userID int64) {
	s.syncMu.Lock()
	defer s.syncMu.Unlock()
	delete(s.syncLocks, userID)
}

func makeAPIKeyHint(apiKey string) string {
	k := strings.TrimSpace(apiKey)
	if k == "" {
		return ""
	}
	if len(k) <= 8 {
		return "****"
	}
	prefix := k[:4]
	if strings.HasPrefix(k, "waka_") && len(k) > 9 {
		prefix = "waka_"
	}
	return prefix + "..." + k[len(k)-4:]
}

func loadLocationOrDefault(tz string) (*time.Location, string) {
	name := auth.NormalizeTimezone(tz)
	loc, err := time.LoadLocation(name)
	if err != nil {
		return time.UTC, "UTC"
	}
	return loc, name
}

func todayDateInTZ(now time.Time, tz string) time.Time {
	loc, _ := loadLocationOrDefault(tz)
	local := now.In(loc)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
}

func parseDateStrict(raw string) (time.Time, error) {
	t, err := time.Parse(dateLayout, strings.TrimSpace(raw))
	if err != nil {
		return time.Time{}, err
	}
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC), nil
}

func formatDate(t time.Time) string {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC).Format(dateLayout)
}

func toConfigView(rec *ConfigRecord) ConfigView {
	if rec == nil {
		return ConfigView{
			Configured:     false,
			APIBaseURL:     DefaultWakaTimeBaseURL,
			TimeoutMinutes: DefaultTimeoutMinutes,
			LastSyncStatus: "idle",
		}
	}
	v := ConfigView{
		Configured:          rec.APIKeyEnc != "",
		APIBaseURL:          rec.APIBaseURL,
		APIKeyHint:          rec.APIKeyHint,
		WakaTimeUsername:    rec.WakaTimeUsername,
		TimeoutMinutes:      normalizeTimeoutMinutes(rec.TimeoutMinutes),
		HistoryImportedAt:   rec.HistoryImportedAt,
		LastSyncedAt:        rec.LastSyncedAt,
		LastSyncStatus:      rec.LastSyncStatus,
		LastSyncError:       rec.LastSyncError,
		NextScheduledSyncAt: rec.NextScheduledSyncAt,
	}
	if v.APIBaseURL == "" {
		v.APIBaseURL = DefaultWakaTimeBaseURL
	}
	if v.LastSyncStatus == "" {
		v.LastSyncStatus = "idle"
	}
	if rec.LastSyncedDate != nil {
		v.LastSyncedDate = formatDate(*rec.LastSyncedDate)
	}
	return v
}

// --- Configuration & Connection Test ---

func (s *Service) GetConfig(ctx context.Context, userID int64) (ConfigView, error) {
	rec, err := s.store.GetConfig(ctx, userID)
	if err != nil {
		return ConfigView{}, httpx.Internal("读取配置失败", err)
	}
	return toConfigView(rec), nil
}

func (s *Service) TestConfig(ctx context.Context, userID int64, in TestConfigInput) (TestConfigResponse, error) {
	existing, err := s.store.GetConfig(ctx, userID)
	if err != nil {
		return TestConfigResponse{}, httpx.Internal("读取配置失败", err)
	}

	rawBase := strings.TrimSpace(in.APIBaseURL)
	if rawBase == "" && existing != nil {
		rawBase = existing.APIBaseURL
	}
	baseURL, err := ValidateBaseURL(rawBase)
	if err != nil {
		return TestConfigResponse{}, httpx.BadRequest(err.Error())
	}

	apiKey := strings.TrimSpace(in.APIKey)
	if apiKey == "" {
		if existing == nil || existing.APIKeyEnc == "" {
			return TestConfigResponse{}, httpx.BadRequest("请输入 WakaTime API Key")
		}
		plain, err := s.box.Decrypt(existing.APIKeyEnc)
		if err != nil {
			return TestConfigResponse{}, httpx.Internal("解密已保存的 API Key 失败", err)
		}
		apiKey = string(plain)
	}

	user, err := s.client.GetCurrentUser(ctx, baseURL, apiKey)
	if err != nil {
		if errors.Is(err, ErrAuthFailed) {
			return TestConfigResponse{}, httpx.BadRequest(err.Error())
		}
		return TestConfigResponse{}, httpx.BadRequest("连接 WakaTime 失败: " + err.Error())
	}
	return TestConfigResponse{
		OK:       true,
		Username: user.Username,
		Timezone: user.Timezone,
		Plan:     user.Plan,
	}, nil
}

func (s *Service) UpdateConfig(ctx context.Context, userID int64, userTZ string, in UpdateConfigInput) (ConfigView, error) {
	baseURL, err := ValidateBaseURL(in.APIBaseURL)
	if err != nil {
		return ConfigView{}, httpx.BadRequest(err.Error())
	}
	existing, err := s.store.GetConfig(ctx, userID)
	if err != nil {
		return ConfigView{}, httpx.Internal("读取配置失败", err)
	}

	now := s.now()
	rec := ConfigRecord{
		UserID:         userID,
		APIBaseURL:     baseURL,
		TimeoutMinutes: DefaultTimeoutMinutes,
		LastSyncStatus: "idle",
	}
	if existing != nil {
		rec = *existing
		rec.APIBaseURL = baseURL
		rec.TimeoutMinutes = normalizeTimeoutMinutes(rec.TimeoutMinutes)
	}

	newKeyProvided := false
	switch {
	case in.ClearAPIKey:
		rec.APIKeyEnc = ""
		rec.APIKeyHint = ""
		rec.WakaTimeUsername = ""
		rec.LastSyncStatus = "idle"
		rec.LastSyncError = ""
		rec.NextScheduledSyncAt = nil
	case strings.TrimSpace(in.APIKey) != "":
		rawKey := strings.TrimSpace(in.APIKey)
		enc, err := s.box.Encrypt([]byte(rawKey))
		if err != nil {
			return ConfigView{}, httpx.Internal("加密 API Key 失败", err)
		}
		rec.APIKeyEnc = enc
		rec.APIKeyHint = makeAPIKeyHint(rawKey)
		rec.LastSyncStatus = "idle"
		rec.LastSyncError = ""
		next := now.Add(ScheduledSyncInterval)
		rec.NextScheduledSyncAt = &next
		newKeyProvided = true
	default:
		// Keep existing key; if key is present and schedule was missing or previously errored, recover cleanly.
		if rec.APIKeyEnc != "" && rec.NextScheduledSyncAt == nil {
			next := now.Add(ScheduledSyncInterval)
			rec.NextScheduledSyncAt = &next
		}
		if rec.LastSyncStatus == "auth_error" && existing != nil && existing.APIBaseURL != baseURL {
			rec.LastSyncStatus = "idle"
			rec.LastSyncError = ""
		}
	}

	saved, err := s.store.UpsertConfig(ctx, rec)
	if err != nil {
		return ConfigView{}, httpx.Internal("保存配置失败", err)
	}

	// Trigger initial recent sync asynchronously when first configured with a key.
	if newKeyProvided && (existing == nil || existing.LastSyncedAt == nil) {
		tzCopy := auth.NormalizeTimezone(userTZ)
		if s.asyncInitSync {
			go func() {
				initCtx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
				defer cancel()
				if _, err := s.SyncRecentDays(initCtx, userID, tzCopy, ScheduledSyncDays, false); err != nil && s.logger != nil {
					s.logger.Warn("screen_time initial sync failed", "user_id", userID, "err", err)
				}
			}()
		}
	}

	return toConfigView(saved), nil
}

// --- Sync Engine (7-day recent sync + visit-triggered incremental sync with 30m cooldown) ---

func (s *Service) SyncOnVisit(ctx context.Context, userID int64, userTZ string, moduleDisabled bool) (SyncResponse, error) {
	if moduleDisabled {
		return SyncResponse{Skipped: true, Reason: "module_disabled", LastSyncStatus: "idle"}, nil
	}
	cfg, err := s.store.GetConfig(ctx, userID)
	if err != nil {
		return SyncResponse{}, httpx.Internal("读取同步配置失败", err)
	}
	if cfg == nil || cfg.APIKeyEnc == "" {
		return SyncResponse{Skipped: true, Reason: "not_configured", LastSyncStatus: "idle"}, nil
	}
	if cfg.LastSyncStatus == "auth_error" {
		return SyncResponse{
			Skipped:        true,
			Reason:         "auth_error",
			LastSyncedAt:   cfg.LastSyncedAt,
			LastSyncStatus: cfg.LastSyncStatus,
			LastSyncError:  cfg.LastSyncError,
		}, nil
	}

	now := s.now()
	if cfg.LastSyncedAt != nil && now.Sub(*cfg.LastSyncedAt) < VisitSyncCooldown {
		return SyncResponse{
			Skipped:        true,
			Reason:         "cooldown",
			LastSyncedAt:   cfg.LastSyncedAt,
			LastSyncStatus: cfg.LastSyncStatus,
			LastSyncError:  cfg.LastSyncError,
		}, nil
	}
	if cfg.LastSyncStatus == "error" && cfg.LastSyncAttemptAt != nil && now.Sub(*cfg.LastSyncAttemptAt) < ErrorRetryDebounce {
		return SyncResponse{
			Skipped:        true,
			Reason:         "retry_backoff",
			LastSyncedAt:   cfg.LastSyncedAt,
			LastSyncStatus: cfg.LastSyncStatus,
			LastSyncError:  cfg.LastSyncError,
		}, nil
	}

	if !s.tryLockUser(userID) {
		return SyncResponse{
			Skipped:        true,
			Reason:         "in_progress",
			LastSyncedAt:   cfg.LastSyncedAt,
			LastSyncStatus: cfg.LastSyncStatus,
		}, nil
	}
	defer s.unlockUser(userID)

	today := todayDateInTZ(now, userTZ)
	earliest := today.AddDate(0, 0, -(MaxVisitLookbackDays - 1))
	start := today.AddDate(0, 0, -(ScheduledSyncDays - 1))
	if cfg.LastSyncedDate != nil {
		// Dynamic lookback: overlap 1 day from last_synced_date, capped at MaxVisitLookbackDays.
		cand := time.Date(cfg.LastSyncedDate.Year(), cfg.LastSyncedDate.Month(), cfg.LastSyncedDate.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, -1)
		yesterday := today.AddDate(0, 0, -1)
		if cand.After(yesterday) {
			cand = yesterday
		}
		if cand.Before(earliest) {
			cand = earliest
		}
		start = cand
	}

	return s.syncRange(ctx, cfg, userTZ, start, today, false)
}

// SyncRecentDays pulls the last N days (inclusive of today) and atomically merges every day.
func (s *Service) SyncRecentDays(ctx context.Context, userID int64, userTZ string, days int, advanceSchedule bool) (SyncResponse, error) {
	if days < 1 {
		days = ScheduledSyncDays
	}
	cfg, err := s.store.GetConfig(ctx, userID)
	if err != nil {
		return SyncResponse{}, err
	}
	if cfg == nil || cfg.APIKeyEnc == "" {
		return SyncResponse{Skipped: true, Reason: "not_configured", LastSyncStatus: "idle"}, nil
	}
	if !s.tryLockUser(userID) {
		return SyncResponse{Skipped: true, Reason: "in_progress", LastSyncStatus: cfg.LastSyncStatus}, nil
	}
	defer s.unlockUser(userID)

	now := s.now()
	today := todayDateInTZ(now, userTZ)
	start := today.AddDate(0, 0, -(days - 1))
	return s.syncRange(ctx, cfg, userTZ, start, today, advanceSchedule)
}

// RunScheduledSyncs checks all users whose 7-day cadence is due and syncs the recent 8 days.
func (s *Service) RunScheduledSyncs(ctx context.Context) error {
	now := s.now()
	dueList, err := s.store.ListDueScheduledConfigs(ctx, now)
	if err != nil {
		return err
	}
	for _, item := range dueList {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		cfgCopy := item.Config
		if !s.tryLockUser(cfgCopy.UserID) {
			continue
		}
		func() {
			defer s.unlockUser(cfgCopy.UserID)
			today := todayDateInTZ(s.now(), item.UserTimezone)
			start := today.AddDate(0, 0, -(ScheduledSyncDays - 1))
			if _, syncErr := s.syncRange(ctx, &cfgCopy, item.UserTimezone, start, today, true); syncErr != nil && s.logger != nil {
				s.logger.Warn("screen_time scheduled sync failed", "user_id", cfgCopy.UserID, "err", syncErr)
			}
		}()
	}
	return nil
}

func (s *Service) syncRange(
	ctx context.Context,
	cfg *ConfigRecord,
	userTZ string,
	startDate, endDate time.Time,
	advanceSchedule bool,
) (SyncResponse, error) {
	now := s.now()
	_, tzName := loadLocationOrDefault(userTZ)

	plainKey, err := s.box.Decrypt(cfg.APIKeyEnc)
	if err != nil {
		return SyncResponse{}, httpx.Internal("解密 WakaTime API Key 失败", err)
	}
	apiKey := string(plainKey)
	baseURL := cfg.APIBaseURL
	if strings.TrimSpace(baseURL) == "" {
		baseURL = DefaultWakaTimeBaseURL
	}

	startStr := formatDate(startDate)
	endStr := formatDate(endDate)

	// Fetch user profile, summaries, machines, and user agents in parallel (1 round trip instead of 4).
	var (
		wakaUser   *WakaUser
		summaries  []WakaDaySummary
		sumErr     error
		machines   map[string]string
		userAgents map[string]WakaUserAgent
		metaWG     sync.WaitGroup
	)
	metaWG.Add(4)
	go func() {
		defer metaWG.Done()
		if u, uErr := s.client.GetCurrentUser(ctx, baseURL, apiKey); uErr == nil && u != nil {
			wakaUser = u
		}
	}()
	go func() {
		defer metaWG.Done()
		summaries, sumErr = s.client.GetSummaries(ctx, baseURL, apiKey, startStr, endStr, tzName)
	}()
	go func() {
		defer metaWG.Done()
		machines, _ = s.client.GetMachineNames(ctx, baseURL, apiKey)
	}()
	go func() {
		defer metaWG.Done()
		userAgents, _ = s.client.GetUserAgents(ctx, baseURL, apiKey)
	}()
	metaWG.Wait()

	username := cfg.WakaTimeUsername
	timeoutMin := normalizeTimeoutMinutes(cfg.TimeoutMinutes)
	if wakaUser != nil {
		if wakaUser.Username != "" {
			username = wakaUser.Username
		}
		if wakaUser.Timeout > 0 {
			timeoutMin = normalizeTimeoutMinutes(wakaUser.Timeout)
		}
	}
	if sumErr != nil {
		return s.recordSyncFailure(ctx, cfg, username, timeoutMin, now, sumErr)
	}

	summaryByDate := make(map[string]WakaDaySummary, len(summaries))
	for _, day := range summaries {
		summaryByDate[day.Date] = day
	}

	// Build day list and fetch active day details with bounded concurrency (max 4 workers).
	var dates []time.Time
	for cur := startDate; !cur.After(endDate); cur = cur.AddDate(0, 0, 1) {
		dates = append(dates, cur)
	}

	batchItems := make([]DayDataBatchItem, len(dates))
	var activeIdx []int
	for i, cur := range dates {
		dayStr := formatDate(cur)
		daySum, hasSum := summaryByDate[dayStr]
		totalSec := 0.0
		dayTZ := tzName
		var dims []DimensionRecord
		if hasSum {
			totalSec = daySum.TotalSeconds
			if daySum.Timezone != "" {
				dayTZ = daySum.Timezone
			}
			appendDims := func(dim string, entries []WakaDimEntry) {
				for _, e := range entries {
					dims = append(dims, DimensionRecord{
						UserID:       cfg.UserID,
						StatDate:     cur,
						Dimension:    dim,
						Name:         e.Name,
						TotalSeconds: e.TotalSeconds,
					})
				}
			}
			appendDims("project", daySum.Projects)
			appendDims("language", daySum.Languages)
			appendDims("editor", daySum.Editors)
			appendDims("os", daySum.OperatingSystems)
			appendDims("category", daySum.Categories)
			appendDims("machine", daySum.Machines)
		}
		batchItems[i] = DayDataBatchItem{
			StatDate:          cur,
			TotalSeconds:      totalSec,
			Timezone:          dayTZ,
			Dims:              dims,
			ReplaceDurations:  totalSec == 0,
			ReplaceHeartbeats: totalSec == 0,
		}
		if totalSec > 0 {
			activeIdx = append(activeIdx, i)
		}
	}

	if len(activeIdx) > 0 {
		const maxDetailWorkers = 4
		workerCount := len(activeIdx)
		if workerCount > maxDetailWorkers {
			workerCount = maxDetailWorkers
		}
		detailCtx, cancelDetail := context.WithCancel(ctx)
		defer cancelDetail()

		jobs := make(chan int, len(activeIdx))
		for _, idx := range activeIdx {
			jobs <- idx
		}
		close(jobs)

		var (
			hbAuthFailed atomic.Bool
			firstErrMu   sync.Mutex
			firstErr     error
			wg           sync.WaitGroup
		)
		setErr := func(err error) {
			firstErrMu.Lock()
			if firstErr == nil {
				firstErr = err
				cancelDetail()
			}
			firstErrMu.Unlock()
		}

		wg.Add(workerCount)
		for w := 0; w < workerCount; w++ {
			go func() {
				defer wg.Done()
				for idx := range jobs {
					if detailCtx.Err() != nil {
						return
					}
					cur := dates[idx]
					dayStr := formatDate(cur)

					var rawHBs []WakaHeartbeat
					var hbErr error
					if !hbAuthFailed.Load() {
						rawHBs, hbErr = s.client.GetHeartbeats(detailCtx, baseURL, apiKey, dayStr, tzName)
						if errors.Is(hbErr, ErrAuthFailed) {
							hbAuthFailed.Store(true)
						}
					}
					if hbErr == nil && len(rawHBs) > 0 {
						heartbeats := make([]HeartbeatRecord, 0, len(rawHBs))
						for _, raw := range rawHBs {
							heartbeats = append(heartbeats, ResolveHeartbeat(cfg.UserID, cur, raw, machines, userAgents))
						}
						_, _, durations := AggregateDayHeartbeats(cfg.UserID, cur, heartbeats, timeoutMin)
						batchItems[idx].Heartbeats = heartbeats
						batchItems[idx].Durations = durations
						batchItems[idx].ReplaceHeartbeats = true
						batchItems[idx].ReplaceDurations = true
						continue
					}

					// Graceful fallback to /durations when upstream lacks /heartbeats scope or returns none.
					rawDurs, durErr := s.client.GetDurations(detailCtx, baseURL, apiKey, dayStr, tzName)
					if durErr != nil {
						setErr(durErr)
						return
					}
					durations := make([]DurationRecord, 0, len(rawDurs))
					for _, d := range rawDurs {
						durations = append(durations, DurationRecord{
							UserID:          cfg.UserID,
							StatDate:        cur,
							StartedAt:       d.StartedAt,
							DurationSeconds: d.DurationSeconds,
							Project:         d.Project,
							Color:           d.Color,
						})
					}
					batchItems[idx].Durations = durations
					batchItems[idx].ReplaceDurations = true
				}
			}()
		}
		wg.Wait()
		if firstErr != nil {
			return s.recordSyncFailure(ctx, cfg, username, timeoutMin, now, firstErr)
		}
	}

	// Persist all synced days in a single atomic COPY FROM / Batch transaction.
	if err := s.store.ReplaceDaysBatch(ctx, cfg.UserID, batchItems); err != nil {
		return s.recordSyncFailure(ctx, cfg, username, timeoutMin, now, err)
	}
	daysSynced := len(batchItems)

	syncedAt := s.now()
	latestDate := endDate
	if cfg.LastSyncedDate != nil && cfg.LastSyncedDate.After(latestDate) {
		latestDate = *cfg.LastSyncedDate
	}

	nextScheduled := cfg.NextScheduledSyncAt
	if advanceSchedule || nextScheduled == nil {
		base := syncedAt
		if advanceSchedule && nextScheduled != nil {
			next := nextScheduled.Add(ScheduledSyncInterval)
			for !next.After(syncedAt) {
				next = next.Add(ScheduledSyncInterval)
			}
			nextScheduled = &next
		} else {
			next := base.Add(ScheduledSyncInterval)
			nextScheduled = &next
		}
	}

	outcome := ConfigRecord{
		UserID:              cfg.UserID,
		WakaTimeUsername:    username,
		TimeoutMinutes:      timeoutMin,
		LastSyncedAt:        &syncedAt,
		LastSyncAttemptAt:   &syncedAt,
		LastSyncedDate:      &latestDate,
		LastSyncStatus:      "ok",
		LastSyncError:       "",
		NextScheduledSyncAt: nextScheduled,
	}
	if _, err := s.store.UpdateSyncOutcome(ctx, outcome); err != nil {
		return SyncResponse{}, httpx.Internal("保存同步状态失败", err)
	}

	return SyncResponse{
		Synced:         true,
		Skipped:        false,
		DaysSynced:     daysSynced,
		StartDate:      startStr,
		EndDate:        endStr,
		LastSyncedAt:   &syncedAt,
		LastSyncStatus: "ok",
	}, nil
}

func (s *Service) recordSyncFailure(
	ctx context.Context,
	cfg *ConfigRecord,
	username string,
	timeoutMin int,
	attemptAt time.Time,
	syncErr error,
) (SyncResponse, error) {
	status := "error"
	errMsg := syncErr.Error()
	if errors.Is(syncErr, ErrAuthFailed) {
		status = "auth_error"
		errMsg = syncErr.Error()
	} else if errors.Is(syncErr, ErrRateLimited) {
		errMsg = ErrRateLimited.Error()
	}

	outcome := ConfigRecord{
		UserID:              cfg.UserID,
		WakaTimeUsername:    username,
		TimeoutMinutes:      timeoutMin,
		LastSyncedAt:        cfg.LastSyncedAt,
		LastSyncAttemptAt:   &attemptAt,
		LastSyncedDate:      cfg.LastSyncedDate,
		LastSyncStatus:      status,
		LastSyncError:       errMsg,
		NextScheduledSyncAt: cfg.NextScheduledSyncAt,
	}
	_, _ = s.store.UpdateSyncOutcome(ctx, outcome)

	return SyncResponse{
		Synced:         false,
		Skipped:        false,
		Reason:         status,
		LastSyncedAt:   cfg.LastSyncedAt,
		LastSyncStatus: status,
		LastSyncError:  errMsg,
	}, nil
}

// --- Analytics Queries ---

func (s *Service) resolveDateRange(ctx context.Context, userID int64, userTZ, startRaw, endRaw string) (time.Time, time.Time, error) {
	today := todayDateInTZ(s.now(), userTZ)
	startTrim := strings.TrimSpace(startRaw)
	endTrim := strings.TrimSpace(endRaw)

	if strings.EqualFold(startTrim, "all") {
		all, err := s.store.ListAllDailyTotals(ctx, userID)
		if err != nil {
			return time.Time{}, time.Time{}, err
		}
		start := today.AddDate(0, 0, -29)
		for _, d := range all {
			if d.TotalSeconds > 0 {
				start = time.Date(d.StatDate.Year(), d.StatDate.Month(), d.StatDate.Day(), 0, 0, 0, 0, time.UTC)
				break
			}
		}
		if start.After(today) {
			start = today
		}
		return start, today, nil
	}

	end := today
	if endTrim != "" {
		parsed, err := parseDateStrict(endTrim)
		if err != nil {
			return time.Time{}, time.Time{}, httpx.BadRequest("无效的 end 日期，应为 YYYY-MM-DD")
		}
		end = parsed
	}

	start := end.AddDate(0, 0, -29)
	if startTrim != "" {
		parsed, err := parseDateStrict(startTrim)
		if err != nil {
			return time.Time{}, time.Time{}, httpx.BadRequest("无效的 start 日期，应为 YYYY-MM-DD")
		}
		start = parsed
	}
	if end.Before(start) {
		return time.Time{}, time.Time{}, httpx.BadRequest("结束日期不能早于开始日期")
	}
	return start, end, nil
}

func computeStreaks(allTotals []DailyTotalRecord, today time.Time) (current int, longest int) {
	activeSet := make(map[string]bool)
	activeDates := make([]time.Time, 0, len(allTotals))
	for _, r := range allTotals {
		if r.TotalSeconds <= 0 {
			continue
		}
		d := time.Date(r.StatDate.Year(), r.StatDate.Month(), r.StatDate.Day(), 0, 0, 0, 0, time.UTC)
		k := formatDate(d)
		if !activeSet[k] {
			activeSet[k] = true
			activeDates = append(activeDates, d)
		}
	}
	if len(activeDates) == 0 {
		return 0, 0
	}
	sort.Slice(activeDates, func(i, j int) bool { return activeDates[i].Before(activeDates[j]) })

	run := 1
	longest = 1
	for i := 1; i < len(activeDates); i++ {
		if activeDates[i].Sub(activeDates[i-1]) == 24*time.Hour {
			run++
		} else {
			run = 1
		}
		if run > longest {
			longest = run
		}
	}

	// Current streak: counts backwards from today if active today, else from yesterday if active yesterday.
	cursor := today
	if !activeSet[formatDate(cursor)] {
		cursor = today.AddDate(0, 0, -1)
		if !activeSet[formatDate(cursor)] {
			return 0, longest
		}
	}
	for activeSet[formatDate(cursor)] {
		current++
		cursor = cursor.AddDate(0, 0, -1)
	}
	return current, longest
}

func aggregateBreakdown(rows []DimensionRecord, dim string, limit int) []BreakdownItem {
	totals := make(map[string]float64)
	var sum float64
	for _, r := range rows {
		if r.Dimension != dim || r.TotalSeconds <= 0 {
			continue
		}
		totals[r.Name] += r.TotalSeconds
		sum += r.TotalSeconds
	}
	items := make([]BreakdownItem, 0, len(totals))
	for name, sec := range totals {
		pct := 0.0
		if sum > 0 {
			pct = math.Round((sec/sum)*1000) / 10
		}
		items = append(items, BreakdownItem{
			Name:         name,
			TotalSeconds: sec,
			Percent:      pct,
		})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].TotalSeconds != items[j].TotalSeconds {
			return items[i].TotalSeconds > items[j].TotalSeconds
		}
		return items[i].Name < items[j].Name
	})
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	return items
}

func (s *Service) GetSummary(ctx context.Context, userID int64, userTZ, startRaw, endRaw string) (SummaryResponse, error) {
	_, tzName := loadLocationOrDefault(userTZ)
	cfg, err := s.store.GetConfig(ctx, userID)
	if err != nil {
		return SummaryResponse{}, httpx.Internal("读取配置失败", err)
	}
	start, end, err := s.resolveDateRange(ctx, userID, tzName, startRaw, endRaw)
	if err != nil {
		return SummaryResponse{}, err
	}

	totals, err := s.store.ListDailyTotals(ctx, userID, start, end)
	if err != nil {
		return SummaryResponse{}, httpx.Internal("查询编码总览失败", err)
	}
	allTotals, err := s.store.ListAllDailyTotals(ctx, userID)
	if err != nil {
		return SummaryResponse{}, httpx.Internal("查询历史统计失败", err)
	}
	dims, err := s.store.ListDailyDimensions(ctx, userID, start, end)
	if err != nil {
		return SummaryResponse{}, httpx.Internal("查询维度统计失败", err)
	}

	totalDays := int(end.Sub(start)/(24*time.Hour)) + 1
	if totalDays < 1 {
		totalDays = 1
	}

	// Equal-length previous period comparison (skipped for "all")
	var prevTotal float64
	if !strings.EqualFold(strings.TrimSpace(startRaw), "all") {
		prevEnd := start.AddDate(0, 0, -1)
		prevStart := prevEnd.AddDate(0, 0, -(totalDays - 1))
		if prevRows, pErr := s.store.ListDailyTotals(ctx, userID, prevStart, prevEnd); pErr == nil {
			for _, r := range prevRows {
				prevTotal += r.TotalSeconds
			}
		}
	}

	var totalSec float64
	activeDays := 0
	var bestDay *BestDayView
	for _, r := range totals {
		if r.TotalSeconds <= 0 {
			continue
		}
		totalSec += r.TotalSeconds
		activeDays++
		if bestDay == nil || r.TotalSeconds > bestDay.TotalSeconds {
			bestDay = &BestDayView{
				Date:         formatDate(r.StatDate),
				TotalSeconds: r.TotalSeconds,
			}
		}
	}

	avgActive := 0.0
	if activeDays > 0 {
		avgActive = totalSec / float64(activeDays)
	}
	avgAll := totalSec / float64(totalDays)

	today := todayDateInTZ(s.now(), tzName)
	curStreak, longestStreak := computeStreaks(allTotals, today)

	var topProject, topLang, topEditor *BreakdownItem
	if list := aggregateBreakdown(dims, "project", 1); len(list) > 0 {
		v := list[0]
		topProject = &v
	}
	if list := aggregateBreakdown(dims, "language", 1); len(list) > 0 {
		v := list[0]
		topLang = &v
	}
	if list := aggregateBreakdown(dims, "editor", 1); len(list) > 0 {
		v := list[0]
		topEditor = &v
	}

	cfgView := toConfigView(cfg)
	return SummaryResponse{
		Configured:            cfgView.Configured,
		StartDate:             formatDate(start),
		EndDate:               formatDate(end),
		Timezone:              tzName,
		TotalSeconds:          totalSec,
		PreviousTotalSeconds:  prevTotal,
		ActiveDays:            activeDays,
		TotalDays:             totalDays,
		DailyAvgActiveSeconds: avgActive,
		DailyAvgAllSeconds:    avgAll,
		CurrentStreakDays:     curStreak,
		LongestStreakDays:     longestStreak,
		BestDay:               bestDay,
		TopProject:            topProject,
		TopLanguage:           topLang,
		TopEditor:             topEditor,
		WakaTimeUsername:      cfgView.WakaTimeUsername,
		LastSyncedAt:          cfgView.LastSyncedAt,
		LastSyncStatus:        cfgView.LastSyncStatus,
		LastSyncError:         cfgView.LastSyncError,
	}, nil
}

func bucketKeyAndLabel(d time.Time, granularity string) (string, string) {
	switch granularity {
	case "week":
		// Monday-based week start
		offset := (int(d.Weekday()) + 6) % 7
		monday := d.AddDate(0, 0, -offset)
		k := formatDate(monday)
		return k, k[5:]
	case "month":
		k := fmt.Sprintf("%04d-%02d", d.Year(), d.Month())
		return k, k
	default:
		k := formatDate(d)
		return k, k[5:]
	}
}

func (s *Service) GetTrends(
	ctx context.Context,
	userID int64,
	userTZ, startRaw, endRaw, granularity, groupBy string,
	topN int,
) (TrendsResponse, error) {
	granularity = strings.ToLower(strings.TrimSpace(granularity))
	if granularity == "" {
		granularity = "day"
	}
	if granularity != "day" && granularity != "week" && granularity != "month" {
		return TrendsResponse{}, httpx.BadRequest("granularity 仅支持 day / week / month")
	}

	groupBy = strings.ToLower(strings.TrimSpace(groupBy))
	if groupBy == "" {
		groupBy = "total"
	}
	switch groupBy {
	case "total", "project", "language", "editor", "category", "os", "machine":
	default:
		return TrendsResponse{}, httpx.BadRequest("不支持的 group_by 分组维度")
	}
	if topN <= 0 || topN > 12 {
		topN = 6
	}

	start, end, err := s.resolveDateRange(ctx, userID, userTZ, startRaw, endRaw)
	if err != nil {
		return TrendsResponse{}, err
	}

	totals, err := s.store.ListDailyTotals(ctx, userID, start, end)
	if err != nil {
		return TrendsResponse{}, httpx.Internal("查询趋势数据失败", err)
	}

	// Build continuous ordered buckets covering [start, end]
	bucketOrder := make([]string, 0)
	bucketLabels := make(map[string]string)
	bucketTotals := make(map[string]float64)
	bucketSeries := make(map[string]map[string]float64)

	for cur := start; !cur.After(end); cur = cur.AddDate(0, 0, 1) {
		k, lbl := bucketKeyAndLabel(cur, granularity)
		if _, exists := bucketLabels[k]; !exists {
			bucketOrder = append(bucketOrder, k)
			bucketLabels[k] = lbl
			bucketSeries[k] = make(map[string]float64)
		}
	}

	for _, r := range totals {
		k, _ := bucketKeyAndLabel(r.StatDate, granularity)
		if _, exists := bucketLabels[k]; exists {
			bucketTotals[k] += r.TotalSeconds
		}
	}

	seriesKeys := []string{}
	if groupBy == "total" {
		seriesKeys = []string{"总计"}
		for _, k := range bucketOrder {
			if bucketTotals[k] > 0 {
				bucketSeries[k]["总计"] = bucketTotals[k]
			}
		}
	} else {
		dims, err := s.store.ListDailyDimensionsByDim(ctx, userID, groupBy, start, end)
		if err != nil {
			return TrendsResponse{}, httpx.Internal("查询趋势分组明细失败", err)
		}
		ranked := aggregateBreakdown(dims, groupBy, 0)
		topSet := make(map[string]bool, topN)
		for i, item := range ranked {
			if i < topN {
				topSet[item.Name] = true
				seriesKeys = append(seriesKeys, item.Name)
			}
		}
		hasOther := false
		for _, r := range dims {
			if r.TotalSeconds <= 0 {
				continue
			}
			k, _ := bucketKeyAndLabel(r.StatDate, granularity)
			if _, exists := bucketLabels[k]; !exists {
				continue
			}
			name := r.Name
			if !topSet[name] {
				name = "其他"
				hasOther = true
			}
			bucketSeries[k][name] += r.TotalSeconds
		}
		if hasOther {
			seriesKeys = append(seriesKeys, "其他")
		}
	}

	points := make([]TrendPoint, 0, len(bucketOrder))
	for _, k := range bucketOrder {
		points = append(points, TrendPoint{
			Bucket:       k,
			Label:        bucketLabels[k],
			TotalSeconds: bucketTotals[k],
			Series:       bucketSeries[k],
		})
	}

	return TrendsResponse{
		Granularity: granularity,
		GroupBy:     groupBy,
		SeriesKeys:  seriesKeys,
		Points:      points,
	}, nil
}

func (s *Service) GetHeatmap(ctx context.Context, userID int64, userTZ string, year int) (HeatmapResponse, error) {
	today := todayDateInTZ(s.now(), userTZ)
	allTotals, err := s.store.ListAllDailyTotals(ctx, userID)
	if err != nil {
		return HeatmapResponse{}, httpx.Internal("查询热力图数据失败", err)
	}

	yearSet := map[int]bool{today.Year(): true}
	byDate := make(map[string]float64, len(allTotals))
	for _, r := range allTotals {
		if r.TotalSeconds > 0 {
			yearSet[r.StatDate.Year()] = true
		}
		byDate[formatDate(r.StatDate)] = r.TotalSeconds
	}
	availYears := make([]int, 0, len(yearSet))
	for y := range yearSet {
		availYears = append(availYears, y)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(availYears)))

	var start, end time.Time
	if year > 0 {
		start = time.Date(year, 1, 1, 0, 0, 0, 0, time.UTC)
		end = time.Date(year, 12, 31, 0, 0, 0, 0, time.UTC)
		if year == today.Year() && end.After(today) {
			end = today
		}
	} else {
		end = today
		start = today.AddDate(0, 0, -364)
	}

	var maxSec, totalSec float64
	activeDays := 0
	rawDays := make([]HeatmapDay, 0, 366)
	for cur := start; !cur.After(end); cur = cur.AddDate(0, 0, 1) {
		k := formatDate(cur)
		sec := byDate[k]
		if sec > 0 {
			activeDays++
			totalSec += sec
			if sec > maxSec {
				maxSec = sec
			}
		}
		rawDays = append(rawDays, HeatmapDay{Date: k, TotalSeconds: sec})
	}

	for i := range rawDays {
		sec := rawDays[i].TotalSeconds
		if sec <= 0 || maxSec <= 0 {
			rawDays[i].Level = 0
			continue
		}
		ratio := sec / maxSec
		switch {
		case ratio <= 0.25:
			rawDays[i].Level = 1
		case ratio <= 0.50:
			rawDays[i].Level = 2
		case ratio <= 0.75:
			rawDays[i].Level = 3
		default:
			rawDays[i].Level = 4
		}
	}

	return HeatmapResponse{
		StartDate:      formatDate(start),
		EndDate:        formatDate(end),
		Year:           year,
		AvailableYears: availYears,
		TotalSeconds:   totalSec,
		ActiveDays:     activeDays,
		MaxSeconds:     maxSec,
		Days:           rawDays,
	}, nil
}

func (s *Service) GetBreakdowns(ctx context.Context, userID int64, userTZ, startRaw, endRaw string, limit int) (BreakdownsResponse, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	start, end, err := s.resolveDateRange(ctx, userID, userTZ, startRaw, endRaw)
	if err != nil {
		return BreakdownsResponse{}, err
	}
	totals, err := s.store.ListDailyTotals(ctx, userID, start, end)
	if err != nil {
		return BreakdownsResponse{}, httpx.Internal("查询总时长失败", err)
	}
	dims, err := s.store.ListDailyDimensions(ctx, userID, start, end)
	if err != nil {
		return BreakdownsResponse{}, httpx.Internal("查询多维排行失败", err)
	}

	var totalSec float64
	for _, r := range totals {
		totalSec += r.TotalSeconds
	}

	return BreakdownsResponse{
		StartDate:        formatDate(start),
		EndDate:          formatDate(end),
		TotalSeconds:     totalSec,
		Projects:         aggregateBreakdown(dims, "project", limit),
		Languages:        aggregateBreakdown(dims, "language", limit),
		Editors:          aggregateBreakdown(dims, "editor", limit),
		OperatingSystems: aggregateBreakdown(dims, "os", limit),
		Categories:       aggregateBreakdown(dims, "category", limit),
		Machines:         aggregateBreakdown(dims, "machine", limit),
	}, nil
}

// SplitDurationIntoHours splits [startedAt, startedAt + durationSec] accurately across hour boundaries in loc.
func SplitDurationIntoHours(startedAt time.Time, durationSec float64, loc *time.Location, buckets *[24]float64) {
	if durationSec <= 0 || loc == nil || buckets == nil {
		return
	}
	cur := startedAt.In(loc)
	end := cur.Add(time.Duration(durationSec * float64(time.Second)))
	for cur.Before(end) {
		nextHour := time.Date(cur.Year(), cur.Month(), cur.Day(), cur.Hour()+1, 0, 0, 0, loc)
		segEnd := end
		if nextHour.Before(segEnd) {
			segEnd = nextHour
		}
		delta := segEnd.Sub(cur).Seconds()
		if delta > 0 {
			buckets[cur.Hour()] += delta
		}
		if !segEnd.After(cur) {
			break
		}
		cur = segEnd
	}
}

func (s *Service) GetHourly(ctx context.Context, userID int64, userTZ, startRaw, endRaw string) (HourlyResponse, error) {
	loc, tzName := loadLocationOrDefault(userTZ)
	start, end, err := s.resolveDateRange(ctx, userID, tzName, startRaw, endRaw)
	if err != nil {
		return HourlyResponse{}, err
	}
	// Expand 1 day on each edge so blocks near midnight in another timezone are captured, then clip.
	durs, err := s.store.ListDurationsByDateRange(ctx, userID, start.AddDate(0, 0, -1), end.AddDate(0, 0, 1))
	if err != nil {
		return HourlyResponse{}, httpx.Internal("查询时段分布失败", err)
	}

	rangeStart := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, loc)
	rangeEnd := time.Date(end.Year(), end.Month(), end.Day()+1, 0, 0, 0, 0, loc)

	var buckets [24]float64
	activeDaySet := make(map[string]bool)
	for _, d := range durs {
		if d.DurationSeconds <= 0 {
			continue
		}
		bStart := d.StartedAt.In(loc)
		bEnd := bStart.Add(time.Duration(d.DurationSeconds * float64(time.Second)))
		if !bEnd.After(rangeStart) || !bStart.Before(rangeEnd) {
			continue
		}
		if bStart.Before(rangeStart) {
			bStart = rangeStart
		}
		if bEnd.After(rangeEnd) {
			bEnd = rangeEnd
		}
		clipped := bEnd.Sub(bStart).Seconds()
		if clipped <= 0 {
			continue
		}
		activeDaySet[formatDate(bStart)] = true
		SplitDurationIntoHours(bStart, clipped, loc, &buckets)
	}

	activeDays := len(activeDaySet)
	hours := make([]HourOfDayItem, 24)
	for h := 0; h < 24; h++ {
		avg := 0.0
		if activeDays > 0 {
			avg = buckets[h] / float64(activeDays)
		}
		hours[h] = HourOfDayItem{
			Hour:         h,
			TotalSeconds: math.Round(buckets[h]*10) / 10,
			AvgSeconds:   math.Round(avg*10) / 10,
		}
	}

	return HourlyResponse{
		StartDate:  formatDate(start),
		EndDate:    formatDate(end),
		Timezone:   tzName,
		ActiveDays: activeDays,
		Hours:      hours,
	}, nil
}

func (s *Service) GetTimeline(ctx context.Context, userID int64, userTZ, dateRaw string) (TimelineResponse, error) {
	loc, tzName := loadLocationOrDefault(userTZ)
	targetDate := todayDateInTZ(s.now(), tzName)
	if strings.TrimSpace(dateRaw) != "" {
		parsed, err := parseDateStrict(dateRaw)
		if err != nil {
			return TimelineResponse{}, httpx.BadRequest("无效的 date 参数，应为 YYYY-MM-DD")
		}
		targetDate = parsed
	}

	durs, err := s.store.ListDurationsByDate(ctx, userID, targetDate)
	if err != nil {
		return TimelineResponse{}, httpx.Internal("查询每日时间轴失败", err)
	}

	dayStart := time.Date(targetDate.Year(), targetDate.Month(), targetDate.Day(), 0, 0, 0, 0, loc)
	dayEnd := dayStart.AddDate(0, 0, 1)
	dayTotalMins := dayEnd.Sub(dayStart).Minutes()
	if dayTotalMins <= 0 {
		dayTotalMins = 1440
	}

	blocks := make([]TimelineBlock, 0, len(durs))
	projTotals := make(map[string]float64)
	var totalSec float64

	for _, d := range durs {
		if d.DurationSeconds <= 0 {
			continue
		}
		bStart := d.StartedAt.In(loc)
		bEnd := bStart.Add(time.Duration(d.DurationSeconds * float64(time.Second)))
		if !bEnd.After(dayStart) || !bStart.Before(dayEnd) {
			// Keep blocks that belong to stat_date even if timezone shifted slightly by clamping.
			continue
		}
		if bStart.Before(dayStart) {
			bStart = dayStart
		}
		if bEnd.After(dayEnd) {
			bEnd = dayEnd
		}
		durSec := bEnd.Sub(bStart).Seconds()
		if durSec <= 0 {
			continue
		}
		startMin := bStart.Sub(dayStart).Minutes()
		endMin := bEnd.Sub(dayStart).Minutes()
		if endMin > dayTotalMins {
			endMin = dayTotalMins
		}
		proj := d.Project
		if proj == "" {
			proj = "Unknown"
		}
		blocks = append(blocks, TimelineBlock{
			StartedAt:       bStart.UTC(),
			EndedAt:         bEnd.UTC(),
			StartMinute:     math.Round(startMin*100) / 100,
			EndMinute:       math.Round(endMin*100) / 100,
			DurationSeconds: math.Round(durSec*10) / 10,
			Project:         proj,
			Color:           d.Color,
		})
		projTotals[proj] += durSec
		totalSec += durSec
	}

	// Fallback: if durations empty (e.g. summaries present without durations), use daily total.
	if totalSec == 0 {
		if dayRows, err := s.store.ListDailyTotals(ctx, userID, targetDate, targetDate); err == nil && len(dayRows) > 0 {
			totalSec = dayRows[0].TotalSeconds
		}
	}

	projects := make([]BreakdownItem, 0, len(projTotals))
	for name, sec := range projTotals {
		pct := 0.0
		if totalSec > 0 {
			pct = math.Round((sec/totalSec)*1000) / 10
		}
		projects = append(projects, BreakdownItem{
			Name:         name,
			TotalSeconds: sec,
			Percent:      pct,
		})
	}
	sort.Slice(projects, func(i, j int) bool {
		if projects[i].TotalSeconds != projects[j].TotalSeconds {
			return projects[i].TotalSeconds > projects[j].TotalSeconds
		}
		return projects[i].Name < projects[j].Name
	})

	return TimelineResponse{
		Date:         formatDate(targetDate),
		Timezone:     tzName,
		TotalSeconds: totalSec,
		Projects:     projects,
		Blocks:       blocks,
	}, nil
}
