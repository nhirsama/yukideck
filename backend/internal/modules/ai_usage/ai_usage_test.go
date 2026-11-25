package ai_usage

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"math"
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

type memStore struct {
	mu      sync.Mutex
	nextID  int64
	slices  map[string]HourlySessionRecord
	devices map[string]Device
	aliases map[int64]struct {
		userID int64
		a      ModelAlias
	}
	prices map[int64]struct {
		userID int64
		p      ModelPrice
	}
}

func newMemStore() *memStore {
	return &memStore{
		slices:  map[string]HourlySessionRecord{},
		devices: map[string]Device{},
		aliases: map[int64]struct {
			userID int64
			a      ModelAlias
		}{},
		prices: map[int64]struct {
			userID int64
			p      ModelPrice
		}{},
	}
}

func sliceKey(userID int64, r HourlySessionRecord) string {
	sub := "0"
	if r.IsSubagent {
		sub = "1"
	}
	return r.DeviceID + "|" + r.Agent + "|" + r.SessionID + "|" + r.HourBucket.UTC().Format(time.RFC3339) + "|" + r.Model + "|" + sub + "|" + string(rune(userID+'0'))
}

func devKey(userID int64, deviceID string) string {
	return string(rune(userID+'0')) + "|" + deviceID
}

func (m *memStore) UpsertDeviceFromIngest(_ context.Context, userID int64, dev IngestDevice) (*Device, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := devKey(userID, dev.DeviceID)
	cur, ok := m.devices[k]
	now := time.Now().UTC()
	if !ok {
		m.nextID++
		cur = Device{
			ID:        m.nextID,
			DeviceID:  dev.DeviceID,
			Name:      dev.Name,
			CreatedAt: now,
		}
	}
	if cur.Name == "" {
		cur.Name = dev.Name
	}
	if dev.OS != "" {
		cur.OS = dev.OS
	}
	if dev.Arch != "" {
		cur.Arch = dev.Arch
	}
	if dev.Hostname != "" {
		cur.Hostname = dev.Hostname
	}
	if dev.CollectorVersion != "" {
		cur.CollectorVersion = dev.CollectorVersion
	}
	cur.LastSyncedAt = now
	cur.UpdatedAt = now
	m.devices[k] = cur
	cp := cur
	return &cp, nil
}

func (m *memStore) UpsertHourlySessions(_ context.Context, userID int64, rows []HourlySessionRecord, forceOverwrite bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range rows {
		r.UserID = userID
		k := sliceKey(userID, r)
		if cur, ok := m.slices[k]; ok {
			if !forceOverwrite && r.LastEventAt.Before(cur.LastEventAt) {
				continue
			}
			if r.ParentSessionID == "" {
				r.ParentSessionID = cur.ParentSessionID
			}
			if r.Provider == "" {
				r.Provider = cur.Provider
			}
			if r.Project == "" {
				r.Project = cur.Project
			}
			if cur.FirstEventAt.Before(r.FirstEventAt) {
				r.FirstEventAt = cur.FirstEventAt
			}
		}
		m.slices[k] = r
	}
	return nil
}

func (m *memStore) ListHourlySessions(_ context.Context, userID int64, start, end time.Time) ([]HourlySessionRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []HourlySessionRecord
	for _, r := range m.slices {
		if r.UserID != userID {
			continue
		}
		if !r.HourBucket.Before(start) && r.HourBucket.Before(end) {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].HourBucket.Before(out[j].HourBucket) })
	return out, nil
}

func (m *memStore) ListHourlySessionsBySession(_ context.Context, userID int64, sessionID, deviceID string) ([]HourlySessionRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []HourlySessionRecord
	for _, r := range m.slices {
		if r.UserID != userID {
			continue
		}
		if deviceID != "" && r.DeviceID != deviceID {
			continue
		}
		if r.SessionID == sessionID || r.ParentSessionID == sessionID {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].HourBucket.Before(out[j].HourBucket) })
	return out, nil
}

func (m *memStore) ListDevices(_ context.Context, userID int64) ([]Device, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Device
	prefix := string(rune(userID+'0')) + "|"
	for k, d := range m.devices {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			out = append(out, d)
		}
	}
	return out, nil
}

func (m *memStore) UpdateDevice(_ context.Context, userID int64, deviceID, name string, hidden bool) (*Device, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := devKey(userID, deviceID)
	d, ok := m.devices[k]
	if !ok {
		return nil, nil
	}
	d.Name = name
	d.Hidden = hidden
	m.devices[k] = d
	return &d, nil
}

func (m *memStore) DeleteDevice(_ context.Context, userID int64, deviceID string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := devKey(userID, deviceID)
	if _, ok := m.devices[k]; !ok {
		return false, nil
	}
	delete(m.devices, k)
	return true, nil
}

func (m *memStore) ListModelAliases(_ context.Context, userID int64) ([]ModelAlias, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []ModelAlias
	for _, entry := range m.aliases {
		if entry.userID == userID {
			out = append(out, entry.a)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Priority != out[j].Priority {
			return out[i].Priority < out[j].Priority
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (m *memStore) UpsertModelAlias(_ context.Context, userID int64, in UpsertModelAliasInput) (*ModelAlias, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, entry := range m.aliases {
		if entry.userID == userID && entry.a.MatchPattern == in.MatchPattern {
			entry.a.CanonicalModel = in.CanonicalModel
			entry.a.Priority = in.Priority
			m.aliases[id] = entry
			cp := entry.a
			return &cp, nil
		}
	}
	m.nextID++
	a := ModelAlias{ID: m.nextID, MatchPattern: in.MatchPattern, CanonicalModel: in.CanonicalModel, Priority: in.Priority}
	m.aliases[a.ID] = struct {
		userID int64
		a      ModelAlias
	}{userID: userID, a: a}
	return &a, nil
}

func (m *memStore) DeleteModelAlias(_ context.Context, userID, id int64) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.aliases[id]
	if !ok || e.userID != userID {
		return false, nil
	}
	delete(m.aliases, id)
	return true, nil
}

func (m *memStore) ListModelPrices(_ context.Context, userID int64) ([]ModelPrice, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []ModelPrice
	for _, entry := range m.prices {
		if entry.userID == userID {
			out = append(out, entry.p)
		}
	}
	return out, nil
}

func (m *memStore) UpsertModelPrice(_ context.Context, userID int64, in UpsertModelPriceInput) (*ModelPrice, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, entry := range m.prices {
		if entry.userID == userID && entry.p.ModelPattern == in.ModelPattern {
			entry.p.InputPerM = in.InputPerM
			entry.p.OutputPerM = in.OutputPerM
			entry.p.CacheReadPerM = in.CacheReadPerM
			entry.p.CacheWritePerM = in.CacheWritePerM
			entry.p.CacheWrite1hPerM = in.CacheWrite1hPerM
			m.prices[id] = entry
			cp := entry.p
			return &cp, nil
		}
	}
	m.nextID++
	p := ModelPrice{
		ID:               m.nextID,
		ModelPattern:     in.ModelPattern,
		InputPerM:        in.InputPerM,
		OutputPerM:       in.OutputPerM,
		CacheReadPerM:    in.CacheReadPerM,
		CacheWritePerM:   in.CacheWritePerM,
		CacheWrite1hPerM: in.CacheWrite1hPerM,
	}
	m.prices[p.ID] = struct {
		userID int64
		p      ModelPrice
	}{userID: userID, p: p}
	return &p, nil
}

func (m *memStore) DeleteModelPrice(_ context.Context, userID, id int64) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.prices[id]
	if !ok || e.userID != userID {
		return false, nil
	}
	delete(m.prices, id)
	return true, nil
}

func TestNormalizeModelAndPricing(t *testing.T) {
	aliases := []ModelAlias{
		{ID: 1, MatchPattern: "my-relay/sonnet*", CanonicalModel: "claude-sonnet-4.6", Priority: 10},
	}

	cases := map[string]string{
		"anthropic/claude-sonnet-4-6-20260514": "claude-sonnet-4.6",
		"us.anthropic.claude-opus-4-5-20251101-v1:0": "claude-opus-4.5",
		"my-relay/sonnet-pro-fast":             "claude-sonnet-4.6",
		"openai/gpt-5.3-codex":                 "gpt-5.3-codex",
	}
	for raw, want := range cases {
		if got := NormalizeModel(raw, aliases); got != want {
			t.Fatalf("NormalizeModel(%q) = %q, want %q", raw, got, want)
		}
	}

	row := HourlySessionRecord{
		Model:              "anthropic/claude-sonnet-4-6-20260514",
		InputTokens:        1_000_000,
		OutputTokens:       500_000,
		CacheReadTokens:    2_000_000,
		CacheWriteTokens:   1_000_000,
		CacheWrite1hTokens: 500_000,
	}
	canon := NormalizeModel(row.Model, aliases)
	cost, savings := ComputeCost(row, canon, nil)
	// 1*3 + 0.5*15 + 2*0.3 + 1*3.75 + 0.5*6 = 3 + 7.5 + 0.6 + 3.75 + 3 = 17.85
	if math.Abs(cost-17.85) > 1e-6 {
		t.Fatalf("expected cost 17.85, got %.6f", cost)
	}
	// savings = 2 * (3.0 - 0.3) = 5.4
	if math.Abs(savings-5.4) > 1e-6 {
		t.Fatalf("expected cache savings 5.4, got %.6f", savings)
	}

	// Custom price overrides built-in price
	custom := []ModelPrice{{ModelPattern: "claude-sonnet-4.6", InputPerM: 1.0, OutputPerM: 2.0, CacheReadPerM: 0.1, CacheWritePerM: 1.0, CacheWrite1hPerM: 2.0}}
	cost2, _ := ComputeCost(row, canon, custom)
	// 1*1 + 0.5*2 + 2*0.1 + 1*1 + 0.5*2 = 4.2
	if math.Abs(cost2-4.2) > 1e-6 {
		t.Fatalf("expected custom cost 4.2, got %.6f", cost2)
	}
}

func TestCrossDaySessionSubagentRollupAndTimezone(t *testing.T) {
	store := newMemStore()
	svc := NewService(store)
	ctx := context.Background()

	// 2026-11-24 23:40 Asia/Shanghai == 2026-11-24 15:40 UTC
	// 2026-11-25 00:15 Asia/Shanghai == 2026-11-24 16:15 UTC
	h1 := time.Date(2026, 11, 24, 15, 0, 0, 0, time.UTC)
	h2 := time.Date(2026, 11, 24, 16, 0, 0, 0, time.UTC)

	_, err := svc.Ingest(ctx, 1, IngestRequest{
		Device: IngestDevice{DeviceID: "mac-1", Name: "MacBook Pro", OS: "darwin", Arch: "arm64", CollectorVersion: "0.1.0"},
		Slices: []IngestSlice{
			{
				Agent:            "claude",
				SessionID:        "sess-root",
				HourBucket:       h1,
				Model:            "claude-sonnet-4-6-20260514",
				Provider:         "anthropic",
				Project:          "yukideck",
				InputTokens:      100_000,
				OutputTokens:     20_000,
				CacheReadTokens:  300_000,
				MaxContextTokens: 180_000,
				RequestCount:     5,
				ToolCallCount:    8,
				ToolCalls:        map[string]int32{"Read": 5, "Edit": 3},
				FirstEventAt:     h1.Add(40 * time.Minute),
				LastEventAt:      h1.Add(58 * time.Minute),
			},
			{
				Agent:            "claude",
				SessionID:        "sess-root",
				HourBucket:       h2,
				Model:            "claude-sonnet-4-6-20260514",
				Provider:         "anthropic",
				Project:          "yukideck",
				InputTokens:      50_000,
				OutputTokens:     10_000,
				MaxContextTokens: 120_000,
				RequestCount:     3,
				ToolCallCount:    2,
				ToolCalls:        map[string]int32{"Bash": 2},
				FirstEventAt:     h2.Add(2 * time.Minute),
				LastEventAt:      h2.Add(15 * time.Minute),
			},
			{
				Agent:           "claude",
				SessionID:       "sess-sub-1",
				IsSubagent:      true,
				ParentSessionID: "sess-root",
				HourBucket:      h2,
				Model:           "claude-haiku-4-5-20251001",
				Provider:        "anthropic",
				Project:         "yukideck",
				InputTokens:     40_000,
				OutputTokens:    5_000,
				RequestCount:    2,
				ToolCallCount:   1,
				ToolCalls:       map[string]int32{"Grep": 1},
				FirstEventAt:    h2.Add(5 * time.Minute),
				LastEventAt:     h2.Add(10 * time.Minute),
			},
		},
	})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}

	filter := QueryFilter{
		Start:    h1.Add(-24 * time.Hour),
		End:      h2.Add(24 * time.Hour),
		Timezone: "Asia/Shanghai",
	}

	// Heatmap in Asia/Shanghai must split into 2026-11-24 and 2026-11-25!
	hm, err := svc.Heatmap(ctx, 1, filter)
	if err != nil {
		t.Fatalf("Heatmap: %v", err)
	}
	if len(hm.Days) != 2 || hm.Days[0].Date != "2026-11-24" || hm.Days[1].Date != "2026-11-25" {
		t.Fatalf("expected split across 2 Shanghai days, got %+v", hm.Days)
	}

	// Sessions list merges cross-day slices + subagent under sess-root
	sessResp, err := svc.Sessions(ctx, 1, filter, 1, 20)
	if err != nil {
		t.Fatalf("Sessions: %v", err)
	}
	if sessResp.Total != 1 || sessResp.Sessions[0].SessionID != "sess-root" {
		t.Fatalf("expected 1 merged root session, got %+v", sessResp)
	}
	s0 := sessResp.Sessions[0]
	if s0.SubagentCount != 1 || s0.SubagentTokens != 45_000 || s0.HourCount != 2 || s0.MaxContextTokens != 180_000 {
		t.Fatalf("unexpected merged session metrics: %+v", s0)
	}

	// Session detail returns all 3 slices (2 main + 1 subagent)
	detail, err := svc.SessionDetail(ctx, 1, "sess-root", "mac-1")
	if err != nil {
		t.Fatalf("SessionDetail: %v", err)
	}
	if len(detail.Slices) != 3 {
		t.Fatalf("expected 3 detail slices, got %d", len(detail.Slices))
	}

	// Tools ranking
	tools, err := svc.Tools(ctx, 1, filter)
	if err != nil {
		t.Fatalf("Tools: %v", err)
	}
	if tools.TotalCalls != 11 || len(tools.Tools) != 4 || tools.Tools[0].Name != "Read" {
		t.Fatalf("unexpected tool stats: %+v", tools)
	}

	// User 2 cannot see User 1's data
	sum2, err := svc.Summary(ctx, 2, filter)
	if err != nil {
		t.Fatalf("Summary user2: %v", err)
	}
	if sum2.Tokens.TotalTokens != 0 || sum2.SessionCount != 0 {
		t.Fatalf("expected strict user isolation, got %+v", sum2)
	}
}

type stubUserStore struct{}

func (stubUserStore) UpsertByOIDCSub(_ context.Context, sub, u, e, a string) (*auth.User, error) {
	return &auth.User{ID: 1, OIDCSub: sub, Username: u, Email: e, AvatarURL: a}, nil
}
func (stubUserStore) FindByID(_ context.Context, id int64) (*auth.User, error) {
	return &auth.User{ID: id, Username: "yuki"}, nil
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

func TestHTTPPermissionsAndGzipIngest(t *testing.T) {
	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x44}, 32))
	cfg := &config.Config{RequestMaxBodyBytes: 1 << 20}
	keyStore := &stubKeyStore{keys: map[int64]auth.APIKeyRecord{}}
	authSvc := auth.NewTestService(cfg, box, stubUserStore{}, keyStore, nil)

	store := newMemStore()
	svc := NewService(store)
	handler := NewHandler(svc, 1<<20, nil)
	(&Module{}).RegisterPermissions(authSvc.Permissions())

	r := chi.NewRouter()
	r.Group(func(api chi.Router) {
		api.Use(authSvc.RequireAuth)
		api.Route("/api/v1/ai-usage", handler.RegisterRoutes)
	})

	// Create ingest-only API key
	ingestKey, err := authSvc.CreateAPIKey(context.Background(), 1, auth.UpsertAPIKeyInput{
		Name:     "Collector",
		Enabled:  true,
		Policies: []auth.PolicyRule{{Permission: PermissionIngest, Resources: []string{"*"}}},
	})
	if err != nil {
		t.Fatalf("CreateAPIKey: %v", err)
	}

	// Gzipped ingest succeeds with ingest-only API key
	payload, _ := json.Marshal(IngestRequest{
		Device: IngestDevice{DeviceID: "linux-dev", Name: "DevBox"},
		Slices: []IngestSlice{{
			Agent:        "codex",
			SessionID:    "s-1",
			HourBucket:   time.Now().UTC().Truncate(time.Hour),
			Model:        "gpt-5.3-codex",
			InputTokens:  1000,
			OutputTokens: 200,
			RequestCount: 1,
		}},
	})
	var gzBuf bytes.Buffer
	gzw := gzip.NewWriter(&gzBuf)
	_, _ = gzw.Write(payload)
	_ = gzw.Close()

	reqIngest := httptest.NewRequest(http.MethodPost, "/api/v1/ai-usage/ingest", &gzBuf)
	reqIngest.Header.Set("Authorization", "Bearer "+ingestKey.PlainKey)
	reqIngest.Header.Set("Content-Encoding", "gzip")
	recIngest := httptest.NewRecorder()
	r.ServeHTTP(recIngest, reqIngest)
	if recIngest.Code != http.StatusOK {
		t.Fatalf("expected 200 on gzip ingest, got %d %s", recIngest.Code, recIngest.Body.String())
	}

	// Ingest-only key is forbidden from reading summary and managing aliases
	for _, path := range []string{"/api/v1/ai-usage/summary", "/api/v1/ai-usage/aliases"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer "+ingestKey.PlainKey)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for ingest-only key on %s, got %d", path, rec.Code)
		}
	}

	// OIDC session can read summary and manage aliases
	tok, _ := authSvc.IssueSessionToken(1)
	reqAlias := httptest.NewRequest(http.MethodPut, "/api/v1/ai-usage/aliases", bytes.NewBufferString(`{"match_pattern":"gpt-5.3*","canonical_model":"gpt-5.3-codex","priority":10}`))
	reqAlias.AddCookie(&http.Cookie{Name: "yukideck_session", Value: tok})
	recAlias := httptest.NewRecorder()
	r.ServeHTTP(recAlias, reqAlias)
	if recAlias.Code != http.StatusOK {
		t.Fatalf("expected 200 for OIDC session on PUT /aliases, got %d %s", recAlias.Code, recAlias.Body.String())
	}
}
