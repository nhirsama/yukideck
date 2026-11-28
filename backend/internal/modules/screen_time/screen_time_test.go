package screen_time

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"yukideck/internal/config"
	"yukideck/internal/core/auth"
	"yukideck/internal/core/crypto"
)

// --- In-memory test store ---

type memStore struct {
	mu           sync.Mutex
	configs      map[int64]ConfigRecord
	userTZ       map[int64]string
	userDisabled map[int64]bool
	totals       map[int64]map[string]DailyTotalRecord
	dims         map[int64]map[string][]DimensionRecord
	durations    map[int64]map[string][]DurationRecord
	heartbeats   map[int64]map[string][]HeartbeatRecord
}

func newMemStore() *memStore {
	return &memStore{
		configs:      make(map[int64]ConfigRecord),
		userTZ:       make(map[int64]string),
		userDisabled: make(map[int64]bool),
		totals:       make(map[int64]map[string]DailyTotalRecord),
		dims:         make(map[int64]map[string][]DimensionRecord),
		durations:    make(map[int64]map[string][]DurationRecord),
		heartbeats:   make(map[int64]map[string][]HeartbeatRecord),
	}
}

func (m *memStore) GetConfig(_ context.Context, userID int64) (*ConfigRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.configs[userID]
	if !ok {
		return nil, nil
	}
	cp := rec
	return &cp, nil
}

func (m *memStore) UpsertConfig(_ context.Context, rec ConfigRecord) (*ConfigRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if old, ok := m.configs[rec.UserID]; ok {
		rec.LastSyncedAt = old.LastSyncedAt
		rec.LastSyncAttemptAt = old.LastSyncAttemptAt
		rec.LastSyncedDate = old.LastSyncedDate
	}
	m.configs[rec.UserID] = rec
	cp := rec
	return &cp, nil
}

func (m *memStore) UpdateSyncOutcome(_ context.Context, rec ConfigRecord) (*ConfigRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	old, ok := m.configs[rec.UserID]
	if !ok {
		return nil, nil
	}
	old.WakaTimeUsername = rec.WakaTimeUsername
	old.TimeoutMinutes = normalizeTimeoutMinutes(rec.TimeoutMinutes)
	old.LastSyncedAt = rec.LastSyncedAt
	old.LastSyncAttemptAt = rec.LastSyncAttemptAt
	old.LastSyncedDate = rec.LastSyncedDate
	old.LastSyncStatus = rec.LastSyncStatus
	old.LastSyncError = rec.LastSyncError
	old.NextScheduledSyncAt = rec.NextScheduledSyncAt
	m.configs[rec.UserID] = old
	cp := old
	return &cp, nil
}

func (m *memStore) MarkHistoryImported(_ context.Context, userID int64, importedAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if old, ok := m.configs[userID]; ok {
		t := importedAt
		old.HistoryImportedAt = &t
		m.configs[userID] = old
	}
	return nil
}

func (m *memStore) ListDueScheduledConfigs(_ context.Context, now time.Time) ([]DueScheduledConfig, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []DueScheduledConfig
	for uid, rec := range m.configs {
		if rec.APIKeyEnc == "" || rec.LastSyncStatus == "auth_error" || rec.NextScheduledSyncAt == nil {
			continue
		}
		if m.userDisabled[uid] {
			continue
		}
		if !rec.NextScheduledSyncAt.After(now) {
			tz := m.userTZ[uid]
			if tz == "" {
				tz = auth.DefaultTimezone
			}
			out = append(out, DueScheduledConfig{Config: rec, UserTimezone: tz})
		}
	}
	return out, nil
}

func (m *memStore) HasDurationsOnDate(_ context.Context, userID int64, statDate time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if byDate, ok := m.durations[userID]; ok {
		return len(byDate[formatDate(statDate)]) > 0, nil
	}
	return false, nil
}

func (m *memStore) HasHeartbeatsOnDate(_ context.Context, userID int64, statDate time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if byDate, ok := m.heartbeats[userID]; ok {
		return len(byDate[formatDate(statDate)]) > 0, nil
	}
	return false, nil
}

func (m *memStore) ReplaceDayData(
	_ context.Context,
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
	m.mu.Lock()
	defer m.mu.Unlock()
	key := formatDate(statDate)
	if m.totals[userID] == nil {
		m.totals[userID] = make(map[string]DailyTotalRecord)
	}
	m.totals[userID][key] = DailyTotalRecord{
		UserID:       userID,
		StatDate:     statDate,
		TotalSeconds: totalSeconds,
		Timezone:     timezone,
	}
	if m.dims[userID] == nil {
		m.dims[userID] = make(map[string][]DimensionRecord)
	}
	m.dims[userID][key] = append([]DimensionRecord(nil), dims...)

	if replaceDurations {
		if m.durations[userID] == nil {
			m.durations[userID] = make(map[string][]DurationRecord)
		}
		m.durations[userID][key] = append([]DurationRecord(nil), durations...)
	}
	if replaceHeartbeats {
		if m.heartbeats[userID] == nil {
			m.heartbeats[userID] = make(map[string][]HeartbeatRecord)
		}
		m.heartbeats[userID][key] = append([]HeartbeatRecord(nil), heartbeats...)
	}
	return nil
}

func (m *memStore) ReplaceDaysBatch(ctx context.Context, userID int64, items []DayDataBatchItem) error {
	for _, it := range items {
		if err := m.ReplaceDayData(
			ctx,
			userID,
			it.StatDate,
			it.TotalSeconds,
			it.Timezone,
			it.Dims,
			it.Durations,
			it.ReplaceDurations,
			it.Heartbeats,
			it.ReplaceHeartbeats,
		); err != nil {
			return err
		}
	}
	return nil
}

func (m *memStore) ListDailyTotals(_ context.Context, userID int64, startDate, endDate time.Time) ([]DailyTotalRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []DailyTotalRecord
	for _, r := range m.totals[userID] {
		if !r.StatDate.Before(startDate) && !r.StatDate.After(endDate) {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StatDate.Before(out[j].StatDate) })
	return out, nil
}

func (m *memStore) ListAllDailyTotals(_ context.Context, userID int64) ([]DailyTotalRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []DailyTotalRecord
	for _, r := range m.totals[userID] {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StatDate.Before(out[j].StatDate) })
	return out, nil
}

func (m *memStore) ListDailyDimensions(_ context.Context, userID int64, startDate, endDate time.Time) ([]DimensionRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []DimensionRecord
	for _, list := range m.dims[userID] {
		for _, r := range list {
			if !r.StatDate.Before(startDate) && !r.StatDate.After(endDate) {
				out = append(out, r)
			}
		}
	}
	return out, nil
}

func (m *memStore) ListDailyDimensionsByDim(_ context.Context, userID int64, dimension string, startDate, endDate time.Time) ([]DimensionRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []DimensionRecord
	for _, list := range m.dims[userID] {
		for _, r := range list {
			if r.Dimension == dimension && !r.StatDate.Before(startDate) && !r.StatDate.After(endDate) {
				out = append(out, r)
			}
		}
	}
	return out, nil
}

func (m *memStore) ListDurationsByDateRange(_ context.Context, userID int64, startDate, endDate time.Time) ([]DurationRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []DurationRecord
	for _, list := range m.durations[userID] {
		for _, r := range list {
			if !r.StatDate.Before(startDate) && !r.StatDate.After(endDate) {
				out = append(out, r)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.Before(out[j].StartedAt) })
	return out, nil
}

func (m *memStore) ListDurationsByDate(_ context.Context, userID int64, statDate time.Time) ([]DurationRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := append([]DurationRecord(nil), m.durations[userID][formatDate(statDate)]...)
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.Before(out[j].StartedAt) })
	return out, nil
}

// --- Mock WakaTime client ---

type mockWakaClient struct {
	mu              sync.Mutex
	user            *WakaUser
	userErr         error
	machines        map[string]string
	userAgents      map[string]WakaUserAgent
	summariesByDay  map[string]WakaDaySummary
	durationsByDay  map[string][]WakaDuration
	heartbeatsByDay map[string][]WakaHeartbeat
	summariesErr    error
	durationsErr    error
	heartbeatsErr   error
	dumps           []WakaDataDump
	dumpDays        []WakaHeartbeatDumpDay
	dumpCreateCalls int

	summaryCalls   [][2]string
	durationCalls  []string
	heartbeatCalls []string
}

func (c *mockWakaClient) GetCurrentUser(_ context.Context, _, _ string) (*WakaUser, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.userErr != nil {
		return nil, c.userErr
	}
	if c.user == nil {
		return &WakaUser{Username: "yuki", Timezone: "Asia/Shanghai", Plan: "free", Timeout: 15}, nil
	}
	return c.user, nil
}

func (c *mockWakaClient) GetMachineNames(_ context.Context, _, _ string) (map[string]string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.machines, nil
}

func (c *mockWakaClient) GetUserAgents(_ context.Context, _, _ string) (map[string]WakaUserAgent, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.userAgents, nil
}

func (c *mockWakaClient) GetHeartbeats(_ context.Context, _, _, date, _ string) ([]WakaHeartbeat, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.heartbeatCalls = append(c.heartbeatCalls, date)
	if c.heartbeatsErr != nil {
		return nil, c.heartbeatsErr
	}
	return append([]WakaHeartbeat(nil), c.heartbeatsByDay[date]...), nil
}

func (c *mockWakaClient) ListDataDumps(_ context.Context, _, _ string) ([]WakaDataDump, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]WakaDataDump(nil), c.dumps...), nil
}

func (c *mockWakaClient) CreateDataDump(_ context.Context, _, _, dumpType string) (*WakaDataDump, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.dumpCreateCalls++
	d := WakaDataDump{
		ID:              "dump-created",
		Type:            dumpType,
		Status:          "Completed",
		PercentComplete: 100,
		DownloadURL:     "https://s3.example.com/dump.json",
	}
	c.dumps = append(c.dumps, d)
	return &d, nil
}

func (c *mockWakaClient) DownloadHeartbeatDump(
	_ context.Context,
	_, _, _ string,
	onProgress func(bytesRead, totalBytes int64),
	onDay func(day WakaHeartbeatDumpDay) error,
) error {
	c.mu.Lock()
	days := append([]WakaHeartbeatDumpDay(nil), c.dumpDays...)
	c.mu.Unlock()
	total := int64(len(days) * 1024)
	for i, day := range days {
		if err := onDay(day); err != nil {
			return err
		}
		if onProgress != nil {
			onProgress(int64((i+1)*1024), total)
		}
	}
	return nil
}

func (c *mockWakaClient) GetSummaries(_ context.Context, _, _, startDate, endDate, _ string) ([]WakaDaySummary, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.summaryCalls = append(c.summaryCalls, [2]string{startDate, endDate})
	if c.summariesErr != nil {
		return nil, c.summariesErr
	}
	start, _ := parseDateStrict(startDate)
	end, _ := parseDateStrict(endDate)
	var out []WakaDaySummary
	for cur := start; !cur.After(end); cur = cur.AddDate(0, 0, 1) {
		k := formatDate(cur)
		if day, ok := c.summariesByDay[k]; ok {
			out = append(out, day)
		} else {
			out = append(out, WakaDaySummary{Date: k, TotalSeconds: 0})
		}
	}
	return out, nil
}

func (c *mockWakaClient) GetDurations(_ context.Context, _, _, date, _ string) ([]WakaDuration, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.durationCalls = append(c.durationCalls, date)
	if c.durationsErr != nil {
		return nil, c.durationsErr
	}
	return append([]WakaDuration(nil), c.durationsByDay[date]...), nil
}

// --- Tests ---

func TestHTTPWakaTimeClientAuthAndErrorsAndRedirectGuard(t *testing.T) {
	expectedAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("waka_secret_123"))

	otherHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Errorf("Authorization header leaked across hosts on redirect: %q", r.Header.Get("Authorization"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"username": "redirected"}})
	}))
	defer otherHost.Close()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/users/current":
			if r.Header.Get("Authorization") != expectedAuth {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{"username": "yuki", "timezone": "Asia/Shanghai", "plan": "free"},
			})
		case "/api/v1/users/current/summaries":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{{
					"range":       map[string]any{"date": "2026-11-28", "timezone": "Asia/Shanghai"},
					"grand_total": map[string]any{"total_seconds": 3600.0},
					"projects":    []map[string]any{{"name": "yukideck", "total_seconds": 3600.0}},
					"languages":   []map[string]any{{"name": "Go", "total_seconds": 2400.0}, {"name": "TypeScript", "total_seconds": 1200.0}},
				}},
			})
		case "/api/v1/users/current/durations":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{{
					"time":     1764300000.0,
					"duration": 1800.0,
					"project":  "yukideck",
					"color":    "#0ea5e9",
				}},
			})
		case "/bearer/users/current":
			if r.Header.Get("Authorization") != "Bearer waka_tok_abc" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{"username": "oauth_yuki", "timezone": "Asia/Shanghai", "plan": "free"},
			})
		case "/rate/users/current":
			w.WriteHeader(http.StatusTooManyRequests)
		case "/redir/users/current":
			http.Redirect(w, r, otherHost.URL+"/target", http.StatusFound)
		default:
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer srv.Close()

	client := NewHTTPWakaTimeClient(5 * time.Second)

	// 1. Valid auth & endpoints
	u, err := client.GetCurrentUser(context.Background(), srv.URL+"/api/v1", "waka_secret_123")
	if err != nil || u.Username != "yuki" || u.Timezone != "Asia/Shanghai" {
		t.Fatalf("GetCurrentUser failed: u=%+v err=%v", u, err)
	}
	sums, err := client.GetSummaries(context.Background(), srv.URL+"/api/v1", "waka_secret_123", "2026-11-28", "2026-11-28", "Asia/Shanghai")
	if err != nil || len(sums) != 1 || sums[0].TotalSeconds != 3600 || len(sums[0].Languages) != 2 {
		t.Fatalf("GetSummaries unexpected: %+v err=%v", sums, err)
	}
	durs, err := client.GetDurations(context.Background(), srv.URL+"/api/v1", "waka_secret_123", "2026-11-28", "Asia/Shanghai")
	if err != nil || len(durs) != 1 || durs[0].Project != "yukideck" || durs[0].DurationSeconds != 1800 {
		t.Fatalf("GetDurations unexpected: %+v err=%v", durs, err)
	}

	// 2. Bearer OAuth token (waka_tok_...) authenticates via Bearer header
	uOAuth, err := client.GetCurrentUser(context.Background(), srv.URL+"/bearer", "waka_tok_abc")
	if err != nil || uOAuth.Username != "oauth_yuki" {
		t.Fatalf("Bearer OAuth GetCurrentUser failed: u=%+v err=%v", uOAuth, err)
	}

	// 3. 401 -> ErrAuthFailed, 429 -> ErrRateLimited
	if _, err := client.GetCurrentUser(context.Background(), srv.URL+"/api/v1", "wrong"); !errors.Is(err, ErrAuthFailed) {
		t.Fatalf("expected ErrAuthFailed, got %v", err)
	}
	if _, err := client.GetCurrentUser(context.Background(), srv.URL+"/rate", "waka_secret_123"); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("expected ErrRateLimited, got %v", err)
	}

	// 3. Cross-host redirect strips Authorization header
	if _, err := client.GetCurrentUser(context.Background(), srv.URL+"/redir", "waka_secret_123"); err != nil {
		t.Fatalf("redirect request failed: %v", err)
	}
}

func TestSyncCooldownDynamicLookbackAnd7DayScheduledBackfill(t *testing.T) {
	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x11}, 32))
	store := newMemStore()
	loc, _ := time.LoadLocation("Asia/Shanghai")

	curNow := time.Date(2026, 11, 28, 10, 0, 0, 0, loc).UTC()
	mock := &mockWakaClient{
		summariesByDay: map[string]WakaDaySummary{
			"2026-11-26": {
				Date:         "2026-11-26",
				TotalSeconds: 3600,
				Projects:     []WakaDimEntry{{Name: "yukideck", TotalSeconds: 3600}},
				Languages:    []WakaDimEntry{{Name: "Go", TotalSeconds: 3600}},
				Editors:      []WakaDimEntry{{Name: "VS Code", TotalSeconds: 3600}},
			},
			"2026-11-28": {
				Date:         "2026-11-28",
				TotalSeconds: 5400,
				Projects:     []WakaDimEntry{{Name: "yukideck", TotalSeconds: 5400}},
				Languages:    []WakaDimEntry{{Name: "TypeScript", TotalSeconds: 5400}},
				Editors:      []WakaDimEntry{{Name: "VS Code", TotalSeconds: 5400}},
			},
		},
		durationsByDay: map[string][]WakaDuration{
			"2026-11-26": {{StartedAt: time.Date(2026, 11, 26, 14, 0, 0, 0, loc).UTC(), DurationSeconds: 3600, Project: "yukideck"}},
			"2026-11-28": {{StartedAt: time.Date(2026, 11, 28, 9, 50, 0, 0, loc).UTC(), DurationSeconds: 1800, Project: "yukideck"}},
		},
	}

	svc := NewService(store, box, mock, nil)
	svc.throttleDelay = 0
	svc.asyncInitSync = false
	svc.nowFunc = func() time.Time { return curNow }

	// 1. Save config sets next_scheduled_sync_at = now + 7 days and masks key
	cfgView, err := svc.UpdateConfig(context.Background(), 1, "Asia/Shanghai", UpdateConfigInput{
		APIBaseURL: DefaultWakaTimeBaseURL,
		APIKey:     "waka_abcde12345",
	})
	if err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}
	if !cfgView.Configured || cfgView.APIKeyHint != "waka_...2345" {
		t.Fatalf("unexpected config view: %+v", cfgView)
	}
	if cfgView.NextScheduledSyncAt == nil || !cfgView.NextScheduledSyncAt.Equal(curNow.Add(ScheduledSyncInterval)) {
		t.Fatalf("expected next_scheduled_sync_at = +7d, got %v", cfgView.NextScheduledSyncAt)
	}

	// 2. First SyncOnVisit pulls recent 8 days (2026-11-21 .. 2026-11-28) and prunes detail calls to only 2 active days
	res1, err := svc.SyncOnVisit(context.Background(), 1, "Asia/Shanghai", false)
	if err != nil || !res1.Synced || res1.DaysSynced != 8 || res1.StartDate != "2026-11-21" || res1.EndDate != "2026-11-28" {
		t.Fatalf("unexpected first visit sync: %+v err=%v", res1, err)
	}
	if len(mock.durationCalls) != 2 {
		t.Fatalf("expected durations pruned to 2 active days, got %d (%v)", len(mock.durationCalls), mock.durationCalls)
	}

	// 3. Re-visiting within 30 minutes is skipped with cooldown
	curNow = curNow.Add(15 * time.Minute)
	resCool, err := svc.SyncOnVisit(context.Background(), 1, "Asia/Shanghai", false)
	if err != nil || !resCool.Skipped || resCool.Reason != "cooldown" {
		t.Fatalf("expected cooldown skip, got %+v err=%v", resCool, err)
	}
	if len(mock.summaryCalls) != 1 {
		t.Fatalf("cooldown should not hit WakaTime API")
	}

	// 4. Visiting 3 days later pulls dynamic lookback (2026-11-27 .. 2026-12-01)
	curNow = curNow.Add(3 * 24 * time.Hour)
	resIncr, err := svc.SyncOnVisit(context.Background(), 1, "Asia/Shanghai", false)
	if err != nil || !resIncr.Synced || resIncr.StartDate != "2026-11-27" || resIncr.EndDate != "2026-12-01" {
		t.Fatalf("unexpected incremental sync: %+v err=%v", resIncr, err)
	}

	// 5. After 7 days from config save, RunScheduledSyncs pulls recent 8 days and advances +7d
	curNow = time.Date(2026, 12, 5, 10, 5, 0, 0, loc).UTC()
	if err := svc.RunScheduledSyncs(context.Background()); err != nil {
		t.Fatalf("RunScheduledSyncs: %v", err)
	}
	lastCall := mock.summaryCalls[len(mock.summaryCalls)-1]
	if lastCall[0] != "2026-11-28" || lastCall[1] != "2026-12-05" {
		t.Fatalf("expected 8-day scheduled sync [2026-11-28..2026-12-05], got %v", lastCall)
	}
	cfgAfter, _ := svc.GetConfig(context.Background(), 1)
	expectedNext := time.Date(2026, 12, 12, 10, 0, 0, 0, loc).UTC()
	if cfgAfter.NextScheduledSyncAt == nil || !cfgAfter.NextScheduledSyncAt.Equal(expectedNext) {
		t.Fatalf("expected next_scheduled_sync_at=%v, got %v", expectedNext, cfgAfter.NextScheduledSyncAt)
	}

	// 6. Disabled module skips visit sync and scheduled sync
	resDisabled, err := svc.SyncOnVisit(context.Background(), 1, "Asia/Shanghai", true)
	if err != nil || !resDisabled.Skipped || resDisabled.Reason != "module_disabled" {
		t.Fatalf("expected module_disabled skip, got %+v", resDisabled)
	}
	store.userDisabled[1] = true
	curNow = curNow.Add(10 * 24 * time.Hour)
	callsBefore := len(mock.summaryCalls)
	if err := svc.RunScheduledSyncs(context.Background()); err != nil {
		t.Fatalf("RunScheduledSyncs disabled: %v", err)
	}
	if len(mock.summaryCalls) != callsBefore {
		t.Fatalf("disabled module should be skipped by scheduled sync")
	}

	// 7. 401 marks auth_error and pauses visit sync
	store.userDisabled[1] = false
	mock.summariesErr = ErrAuthFailed
	resAuthErr, err := svc.SyncOnVisit(context.Background(), 1, "Asia/Shanghai", false)
	if err != nil || resAuthErr.LastSyncStatus != "auth_error" {
		t.Fatalf("expected auth_error status, got %+v err=%v", resAuthErr, err)
	}
	callsAfterErr := len(mock.summaryCalls)
	resPaused, _ := svc.SyncOnVisit(context.Background(), 1, "Asia/Shanghai", false)
	if !resPaused.Skipped || resPaused.Reason != "auth_error" || len(mock.summaryCalls) != callsAfterErr {
		t.Fatalf("expected paused after auth_error, got %+v", resPaused)
	}
}

func TestAnalyticsHourlySplitStreaksAndUserIsolation(t *testing.T) {
	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x22}, 32))
	store := newMemStore()
	loc, _ := time.LoadLocation("Asia/Shanghai")
	curNow := time.Date(2026, 11, 28, 15, 0, 0, 0, loc).UTC()

	svc := NewService(store, box, &mockWakaClient{}, nil)
	svc.nowFunc = func() time.Time { return curNow }

	// Seed User 1 data across 3 consecutive days (26, 27, 28) + earlier streak (20, 21)
	seedDay := func(uid int64, dateStr string, total float64, proj, lang string, durs []DurationRecord) {
		d, _ := parseDateStrict(dateStr)
		_ = store.ReplaceDayData(context.Background(), uid, d, total, "Asia/Shanghai", []DimensionRecord{
			{UserID: uid, StatDate: d, Dimension: "project", Name: proj, TotalSeconds: total},
			{UserID: uid, StatDate: d, Dimension: "language", Name: lang, TotalSeconds: total},
			{UserID: uid, StatDate: d, Dimension: "editor", Name: "VS Code", TotalSeconds: total},
		}, durs, true, nil, false)
	}

	d28, _ := parseDateStrict("2026-11-28")
	seedDay(1, "2026-11-20", 1800, "old-proj", "Python", nil)
	seedDay(1, "2026-11-21", 1800, "old-proj", "Python", nil)
	seedDay(1, "2026-11-26", 3600, "yukideck", "Go", nil)
	seedDay(1, "2026-11-27", 7200, "yukideck", "Go", nil)
	seedDay(1, "2026-11-28", 1800, "yukideck", "TypeScript", []DurationRecord{
		{
			UserID:          1,
			StatDate:        d28,
			StartedAt:       time.Date(2026, 11, 28, 10, 50, 0, 0, loc).UTC(),
			DurationSeconds: 1800, // 10:50 -> 11:20 (600s in hour 10, 1200s in hour 11)
			Project:         "yukideck",
			Color:           "#38bdf8",
		},
	})
	// Seed User 2 data to ensure strict isolation
	seedDay(2, "2026-11-28", 99999, "secret-proj", "Rust", nil)

	// 1. Summary & Streak check (User 1)
	sum, err := svc.GetSummary(context.Background(), 1, "Asia/Shanghai", "2026-11-26", "2026-11-28")
	if err != nil {
		t.Fatalf("GetSummary: %v", err)
	}
	if sum.TotalSeconds != 12600 || sum.ActiveDays != 3 || sum.CurrentStreakDays != 3 || sum.LongestStreakDays != 3 {
		t.Fatalf("unexpected summary: %+v", sum)
	}
	if sum.BestDay == nil || sum.BestDay.Date != "2026-11-27" || sum.BestDay.TotalSeconds != 7200 {
		t.Fatalf("unexpected best day: %+v", sum.BestDay)
	}
	if sum.TopProject == nil || sum.TopProject.Name != "yukideck" {
		t.Fatalf("unexpected top project: %+v", sum.TopProject)
	}

	// 2. Cross-hour duration split check
	hourly, err := svc.GetHourly(context.Background(), 1, "Asia/Shanghai", "2026-11-28", "2026-11-28")
	if err != nil {
		t.Fatalf("GetHourly: %v", err)
	}
	if hourly.Hours[10].TotalSeconds != 600 || hourly.Hours[11].TotalSeconds != 1200 {
		t.Fatalf("expected 600s in hour 10 and 1200s in hour 11, got h10=%.1f h11=%.1f", hourly.Hours[10].TotalSeconds, hourly.Hours[11].TotalSeconds)
	}

	// 3. Timeline check
	tl, err := svc.GetTimeline(context.Background(), 1, "Asia/Shanghai", "2026-11-28")
	if err != nil {
		t.Fatalf("GetTimeline: %v", err)
	}
	if len(tl.Blocks) != 1 || tl.Blocks[0].StartMinute != 650 || tl.Blocks[0].EndMinute != 680 {
		t.Fatalf("unexpected timeline blocks: %+v", tl.Blocks)
	}

	// 4. Trends & Heatmap & Breakdowns
	trends, err := svc.GetTrends(context.Background(), 1, "Asia/Shanghai", "2026-11-26", "2026-11-28", "day", "language", 6)
	if err != nil || len(trends.Points) != 3 || len(trends.SeriesKeys) != 2 {
		t.Fatalf("unexpected trends: %+v err=%v", trends, err)
	}
	hm, err := svc.GetHeatmap(context.Background(), 1, "Asia/Shanghai", 2026)
	if err != nil || hm.ActiveDays != 5 || hm.MaxSeconds != 7200 {
		t.Fatalf("unexpected heatmap: %+v err=%v", hm, err)
	}
	bd, err := svc.GetBreakdowns(context.Background(), 1, "Asia/Shanghai", "2026-11-26", "2026-11-28", 10)
	if err != nil || len(bd.Projects) != 1 || bd.Projects[0].Name != "yukideck" {
		t.Fatalf("unexpected breakdowns: %+v err=%v", bd, err)
	}

	// 5. Isolation: User 2 sees only secret-proj
	sum2, _ := svc.GetSummary(context.Background(), 2, "Asia/Shanghai", "2026-11-26", "2026-11-28")
	if sum2.TotalSeconds != 99999 || sum2.TopProject == nil || sum2.TopProject.Name != "secret-proj" {
		t.Fatalf("user 2 isolation broken: %+v", sum2)
	}
}

type stubUserStore struct{}

func (stubUserStore) UpsertByOIDCSub(_ context.Context, sub, u, e, a string) (*auth.User, error) {
	return &auth.User{ID: 1, OIDCSub: sub, Username: u, Email: e, AvatarURL: a, Timezone: auth.DefaultTimezone, DisabledModules: []string{}}, nil
}
func (stubUserStore) FindByID(_ context.Context, id int64) (*auth.User, error) {
	return &auth.User{ID: id, Username: "yuki", Timezone: auth.DefaultTimezone, DisabledModules: []string{}}, nil
}
func (stubUserStore) UpdatePreferences(_ context.Context, id int64, tz string, disabled []string) (*auth.User, error) {
	return &auth.User{ID: id, Username: "yuki", Timezone: tz, DisabledModules: disabled}, nil
}

type stubKeyStore struct {
	mu     sync.Mutex
	nextID int64
	keys   map[int64]auth.APIKeyRecord
}

func (s *stubKeyStore) List(_ context.Context, _ int64) ([]auth.APIKeyRecord, error) { return nil, nil }
func (s *stubKeyStore) Get(_ context.Context, _, _ int64) (*auth.APIKeyRecord, error) {
	return nil, nil
}
func (s *stubKeyStore) FindByHash(_ context.Context, hash string) (*auth.APIKeyRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.keys {
		if r.KeyHash == hash {
			cp := r
			return &cp, nil
		}
	}
	return nil, nil
}
func (s *stubKeyStore) Create(_ context.Context, rec auth.APIKeyRecord) (*auth.APIKeyRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	rec.ID = s.nextID
	s.keys[rec.ID] = rec
	return &rec, nil
}
func (s *stubKeyStore) Update(_ context.Context, rec auth.APIKeyRecord) (*auth.APIKeyRecord, error) {
	return &rec, nil
}
func (s *stubKeyStore) Rotate(_ context.Context, _, _ int64, _, _ string) (*auth.APIKeyRecord, error) {
	return nil, nil
}
func (s *stubKeyStore) TouchUsed(_ context.Context, _ int64) error { return nil }
func (s *stubKeyStore) Delete(_ context.Context, _, _ int64) error { return nil }

func TestHTTPPermissionsReadKeyVsSessionOnly(t *testing.T) {
	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x55}, 32))
	cfg := &config.Config{RequestMaxBodyBytes: 1 << 20}
	keyStore := &stubKeyStore{keys: map[int64]auth.APIKeyRecord{}}
	authSvc := auth.NewTestService(cfg, box, stubUserStore{}, keyStore, nil)

	svc := NewService(newMemStore(), box, &mockWakaClient{}, nil)
	handler := NewHandler(svc, 1<<20, nil)
	(&Module{}).RegisterPermissions(authSvc.Permissions())

	r := chi.NewRouter()
	r.Group(func(api chi.Router) {
		api.Use(authSvc.RequireAuth)
		api.Route("/api/v1/screen-time", handler.RegisterRoutes)
	})

	// Mint API key with screen-time:read
	plainKey := "ydk_screentime_read_test_key"
	_, _ = keyStore.Create(context.Background(), auth.APIKeyRecord{
		UserID:    1,
		Name:      "reader",
		KeyPrefix: "ydk_scre",
		KeyHash:   crypto.SHA256Hex(plainKey),
		Policies:  []auth.PolicyRule{{Permission: PermissionRead, Resources: []string{"*"}}},
		Enabled:   true,
	})

	// 1. Read endpoints succeed with API key
	for _, path := range []string{"/summary", "/trends", "/heatmap", "/breakdowns", "/hourly", "/timeline"} {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/screen-time"+path, nil)
		req.Header.Set("Authorization", "Bearer "+plainKey)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s with read API key expected 200, got %d: %s", path, rec.Code, rec.Body.String())
		}
	}

	// 2. Session-only endpoints reject API key with 403
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/config"},
		{http.MethodPut, "/config"},
		{http.MethodPost, "/config/test"},
		{http.MethodPost, "/sync"},
		{http.MethodGet, "/history-import"},
		{http.MethodPost, "/history-import"},
	} {
		req := httptest.NewRequest(tc.method, "/api/v1/screen-time"+tc.path, bytes.NewBufferString(`{}`))
		req.Header.Set("Authorization", "Bearer "+plainKey)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s %s with API key expected 403, got %d", tc.method, tc.path, rec.Code)
		}
	}
}

func TestHistoryImportFullAndGapModesAndHeartbeatAggregation(t *testing.T) {
	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x77}, 32))
	store := newMemStore()
	loc, _ := time.LoadLocation("Asia/Shanghai")
	curNow := time.Date(2026, 11, 28, 12, 0, 0, 0, loc).UTC()

	day1Start := time.Date(2025, 10, 1, 10, 0, 0, 0, loc).UTC()
	day2Start := time.Date(2025, 10, 2, 14, 0, 0, 0, loc).UTC()

	mock := &mockWakaClient{
		user: &WakaUser{Username: "yuki", Timezone: "Asia/Shanghai", Plan: "free", Timeout: 10},
		machines: map[string]string{
			"m-1": "arch-kde",
		},
		userAgents: map[string]WakaUserAgent{
			"ua-1": {Editor: "VS Code", OS: "Linux"},
		},
		dumpDays: []WakaHeartbeatDumpDay{
			{
				Date: "2025-10-01",
				Heartbeats: []WakaHeartbeat{
					{Time: day1Start, Project: "yukideck", Language: "Go", Category: "coding", MachineNameID: "m-1", UserAgentID: "ua-1"},
					// +5 min (<= 10m timeout -> merged into 300s block)
					{Time: day1Start.Add(5 * time.Minute), Project: "yukideck", Language: "Go", Category: "coding", MachineNameID: "m-1", UserAgentID: "ua-1"},
					// +20 min (> 10m timeout -> starts a new block)
					{Time: day1Start.Add(25 * time.Minute), Project: "other", Language: "TypeScript", Category: "debugging", MachineNameID: "m-1", UserAgentID: "ua-1"},
					// +4 min (<= 10m timeout -> 240s block)
					{Time: day1Start.Add(29 * time.Minute), Project: "other", Language: "TypeScript", Category: "debugging", MachineNameID: "m-1", UserAgentID: "ua-1"},
				},
			},
			{
				Date: "2025-10-02",
				Heartbeats: []WakaHeartbeat{
					{Time: day2Start, Project: "yukideck", Language: "Go", Category: "coding", MachineNameID: "m-1", UserAgentID: "ua-1"},
					{Time: day2Start.Add(8 * time.Minute), Project: "yukideck", Language: "Go", Category: "coding", MachineNameID: "m-1", UserAgentID: "ua-1"},
				},
			},
		},
	}

	svc := NewService(store, box, mock, nil)
	svc.throttleDelay = 0
	svc.dumpPollInterval = time.Millisecond
	svc.asyncInitSync = false
	svc.asyncHistoryImport = false
	svc.nowFunc = func() time.Time { return curNow }

	_, err := svc.UpdateConfig(context.Background(), 1, "Asia/Shanghai", UpdateConfigInput{
		APIBaseURL: DefaultWakaTimeBaseURL,
		APIKey:     "waka_tok_hist_1234",
	})
	if err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}

	// 1. First history import runs in "full" mode, resolves machine/user_agent & aggregates with timeout=10m
	stFull, err := svc.StartHistoryImport(context.Background(), 1, "Asia/Shanghai")
	if err != nil || stFull.Stage != "completed" || stFull.Mode != "full" || stFull.DaysImported != 2 || stFull.HeartbeatsImported != 6 {
		t.Fatalf("unexpected full history import status: %+v err=%v", stFull, err)
	}

	d1, _ := parseDateStrict("2025-10-01")
	totals, _ := store.ListDailyTotals(context.Background(), 1, d1, d1)
	if len(totals) != 1 || totals[0].TotalSeconds != 540 { // 300s + 240s
		t.Fatalf("expected 540s on 2025-10-01, got %+v", totals)
	}
	tl, _ := svc.GetTimeline(context.Background(), 1, "Asia/Shanghai", "2025-10-01")
	if len(tl.Blocks) != 2 || tl.Blocks[0].Project != "yukideck" || tl.Blocks[0].DurationSeconds != 300 || tl.Blocks[1].Project != "other" || tl.Blocks[1].DurationSeconds != 240 {
		t.Fatalf("unexpected imported timeline blocks: %+v", tl.Blocks)
	}
	if len(store.heartbeats[1]["2025-10-01"]) != 4 || store.heartbeats[1]["2025-10-01"][0].Machine != "arch-kde" || store.heartbeats[1]["2025-10-01"][0].Editor != "VS Code" {
		t.Fatalf("expected resolved heartbeats stored, got %+v", store.heartbeats[1]["2025-10-01"])
	}

	// 2. Second history import runs in "gap" mode: skips already-archived 2025-10-01 & 2025-10-02, only imports newly appearing gap date 2025-10-03
	day3Start := time.Date(2025, 10, 3, 9, 0, 0, 0, loc).UTC()
	mock.dumpDays = append(mock.dumpDays, WakaHeartbeatDumpDay{
		Date: "2025-10-03",
		Heartbeats: []WakaHeartbeat{
			{Time: day3Start, Project: "gap-proj", Language: "Rust", Category: "coding", MachineNameID: "m-1", UserAgentID: "ua-1"},
			{Time: day3Start.Add(6 * time.Minute), Project: "gap-proj", Language: "Rust", Category: "coding", MachineNameID: "m-1", UserAgentID: "ua-1"},
		},
	})
	stGap, err := svc.StartHistoryImport(context.Background(), 1, "Asia/Shanghai")
	if err != nil || stGap.Stage != "completed" || stGap.Mode != "gap" || stGap.DaysImported != 1 || stGap.DaysSkipped != 2 {
		t.Fatalf("unexpected gap history import status: %+v err=%v", stGap, err)
	}
	d3, _ := parseDateStrict("2025-10-03")
	totals3, _ := store.ListDailyTotals(context.Background(), 1, d3, d3)
	if len(totals3) != 1 || totals3[0].TotalSeconds != 360 {
		t.Fatalf("expected gap day 2025-10-03 imported with 360s, got %+v", totals3)
	}
}

func TestHTTPWakaTimeClientDownloadHeartbeatDumpStreamingAndAuthIsolation(t *testing.T) {
	var dumpAuthHeader string
	dumpSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dumpAuthHeader = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"user": {"username": "yuki", "timeout": 15},
			"range": {"start": "2025-10-01", "end": "2025-10-02"},
			"days": [
				{
					"date": "2025-10-01",
					"heartbeats": [
						{
							"time": 1759284000.5,
							"project": "yukideck",
							"language": "Go",
							"category": "coding",
							"editor": "VS Code",
							"operating_system": "Linux",
							"machine_name_id": "m-1",
							"entity": "/home/secret/main.go",
							"dependencies": ["secret-dep"],
							"branch": "main",
							"lines": 120
						}
					]
				},
				{
					"date": "2025-10-02",
					"heartbeats": []
				}
			]
		}`))
	}))
	defer dumpSrv.Close()

	// Base URL is a different host than dumpSrv (simulating pre-signed S3/GCS URL)
	apiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer apiSrv.Close()

	client := NewHTTPWakaTimeClient(5 * time.Second)
	var seenDays []WakaHeartbeatDumpDay
	var lastBytes int64
	err := client.DownloadHeartbeatDump(
		context.Background(),
		dumpSrv.URL+"/export.json",
		apiSrv.URL,
		"waka_tok_secret_value",
		func(downloaded, _ int64) {
			lastBytes = downloaded
		},
		func(day WakaHeartbeatDumpDay) error {
			seenDays = append(seenDays, day)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("DownloadHeartbeatDump failed: %v", err)
	}
	if dumpAuthHeader != "" {
		t.Fatalf("expected no Authorization header sent to cross-host pre-signed dump URL, got %q", dumpAuthHeader)
	}
	if lastBytes <= 0 {
		t.Fatalf("expected progress callback bytes > 0, got %d", lastBytes)
	}
	if len(seenDays) != 2 || seenDays[0].Date != "2025-10-01" || len(seenDays[0].Heartbeats) != 1 {
		t.Fatalf("unexpected streamed days: %+v", seenDays)
	}
	hb := seenDays[0].Heartbeats[0]
	if hb.Project != "yukideck" || hb.Language != "Go" || hb.Editor != "VS Code" || hb.OS != "Linux" || hb.MachineNameID != "m-1" {
		t.Fatalf("unexpected parsed heartbeat: %+v", hb)
	}
}
