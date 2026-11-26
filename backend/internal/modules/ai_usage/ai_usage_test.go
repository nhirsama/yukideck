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
		if r.IsSubagent && r.ParentSessionID != "" && r.ParentSessionID != r.SessionID {
			nonSub := r
			nonSub.IsSubagent = false
			delete(m.slices, sliceKey(userID, nonSub))
		}
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

func (m *memStore) ListDistinctModelsInRange(_ context.Context, userID int64, start, end time.Time) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	seen := map[string]struct{}{}
	for _, r := range m.slices {
		if r.UserID != userID || r.HourBucket.Before(start) || !r.HourBucket.Before(end) {
			continue
		}
		seen[r.Model] = struct{}{}
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out, nil
}

func (m *memStore) ListPagedSessionSlices(_ context.Context, userID int64, filter SessionPageFilter) ([]HourlySessionRecord, int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	modelSet := map[string]struct{}{}
	for _, mod := range filter.RawModels {
		modelSet[mod] = struct{}{}
	}

	type group struct {
		key      string
		rootID   string
		lastAt   time.Time
		tokens   int64
		records  []HourlySessionRecord
	}
	groups := map[string]*group{}
	for _, r := range m.slices {
		if r.UserID != userID || r.HourBucket.Before(filter.Start) || !r.HourBucket.Before(filter.End) {
			continue
		}
		if filter.Agent != "" && r.Agent != filter.Agent {
			continue
		}
		if filter.DeviceID != "" && r.DeviceID != filter.DeviceID {
			continue
		}
		if filter.Project != "" && r.Project != filter.Project {
			continue
		}
		if !filter.IncludeHidden && filter.DeviceID == "" {
			if dev, ok := m.devices[devKey(userID, r.DeviceID)]; ok && dev.Hidden {
				continue
			}
		}
		if len(modelSet) > 0 {
			if _, ok := modelSet[r.Model]; !ok {
				continue
			}
		}
		rootID := r.SessionID
		if r.IsSubagent && r.ParentSessionID != "" {
			rootID = r.ParentSessionID
		}
		k := r.DeviceID + "|" + r.Agent + "|" + rootID
		g, ok := groups[k]
		if !ok {
			g = &group{key: k, rootID: rootID, lastAt: r.LastEventAt}
			groups[k] = g
		}
		if r.LastEventAt.After(g.lastAt) {
			g.lastAt = r.LastEventAt
		}
		g.tokens += r.TotalTokens()
		g.records = append(g.records, r)
	}

	all := make([]*group, 0, len(groups))
	for _, g := range groups {
		all = append(all, g)
	}
	sort.Slice(all, func(i, j int) bool {
		if !all[i].lastAt.Equal(all[j].lastAt) {
			return all[i].lastAt.After(all[j].lastAt)
		}
		if all[i].tokens != all[j].tokens {
			return all[i].tokens > all[j].tokens
		}
		return all[i].rootID < all[j].rootID
	})

	total := len(all)
	startIdx := (filter.Page - 1) * filter.PageSize
	if startIdx < 0 {
		startIdx = 0
	}
	if startIdx >= total {
		return []HourlySessionRecord{}, total, nil
	}
	endIdx := startIdx + filter.PageSize
	if endIdx > total {
		endIdx = total
	}
	var out []HourlySessionRecord
	for _, g := range all[startIdx:endIdx] {
		out = append(out, g.records...)
	}
	return out, total, nil
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
		"anthropic/claude-sonnet-4-6-20260514":                "claude-sonnet-4.6",
		"us.anthropic.claude-opus-4-5-20251101-v1:0":          "claude-opus-4.5",
		"openrouter/anthropic/claude-opus-5-5-20261001:free":  "claude-opus-5.5",
		"claude-opus-4.6-thinking":                            "claude-opus-4.6",
		"claude-opus-4-7":                                     "claude-opus-4.7",
		"my-relay/sonnet-pro-fast":                            "claude-sonnet-4.6",
		"openai/gpt-5.3-codex":                                "gpt-5.3-codex",
		"google-antigravity/gemini-4-neon-high":               "gemini-4-neon-high",
		"models/gemini-4.0-carbon-preview":                    "gemini-4-carbon",
		"zai-org/glm-5.3":                                     "glm-5.3",
	}
	for raw, want := range cases {
		if got := NormalizeModel(raw, aliases); got != want {
			t.Fatalf("NormalizeModel(%q) = %q, want %q", raw, got, want)
		}
	}

	// Verify 2026 frontier models & arbitrary custom proxy prefixes resolve non-zero prices accurately.
	priceChecks := []struct {
		raw       string
		wantInput float64
		wantOut   float64
	}{
		{"openrouter/anthropic/claude-opus-5-5-20261001:thinking", 4.00, 20.00},
		{"claude-fable-5-2", 8.00, 40.00},
		{"claude-mythos-5-2", 8.00, 40.00},
		{"claude-opus-4-8", 5.00, 25.00},
		{"claude-sonnet-5-5", 2.00, 10.00},
		{"claude-haiku-5-5", 0.10, 0.50},
		{"claude-opus-4.6-thinking", 5.00, 25.00},
		{"claude-opus-4-7", 5.00, 25.00},
		{"gpt-6.2-sol", 2.00, 10.00},
		{"gpt-6.1-sol", 2.00, 10.00},
		{"my-relay/gpt-6.2-sol-20261117", 2.00, 10.00},
		{"gpt-6.2-astra", 8.00, 40.00},
		{"gpt-6.1-terra", 1.00, 5.00},
		{"gpt-6-luna", 0.10, 0.50},
		{"gpt-5.6-sol", 5.00, 30.00},
		{"gpt-5.6", 4.00, 20.00},
		{"gpt-5.5", 5.00, 30.00},
		{"gpt-5.3-codex-spark", 1.75, 14.00},
		{"codex-auto-review", 0.20, 1.20},
		{"my-private-proxy/gpt-5.4-mini-20260601", 0.75, 4.50},
		{"gpt-5.4-nano", 0.20, 1.25},
		{"google-antigravity/gemini-4-neon-high", 3.00, 15.00},
		{"gemini-4-carbon", 2.00, 10.00},
		{"gemini-4-hydrogen", 1.50, 7.50},
		{"gemini-3.8-flash", 0.75, 3.75},
		{"gemini-3-pro-preview", 2.00, 12.00},
		{"deepseek/deepseek-v4-pro", 1.32, 3.96},
		{"deepseek-v3.2", 0.26, 0.38},
		{"zai-org/glm-5.3", 1.40, 4.40},
		{"glm-5.1", 1.40, 4.40},
		{"moonshotai/kimi-k3.1-pro", 2.00, 10.00},
		{"qwen/qwen3.8-max-0902", 2.00, 6.00},
		{"minimax/MiniMax-M3", 0.30, 1.20},
		{"x-ai/grok-4.7", 2.00, 6.00},
		{"grok-4.5", 2.00, 6.00},
	}
	for _, tc := range priceChecks {
		canon := NormalizeModel(tc.raw, nil)
		p, ok := ResolvePrice(tc.raw, canon, nil)
		if !ok {
			t.Fatalf("ResolvePrice(%q -> %q) did not match any built-in price", tc.raw, canon)
		}
		if math.Abs(p.InputPerM-tc.wantInput) > 1e-6 || math.Abs(p.OutputPerM-tc.wantOut) > 1e-6 {
			t.Fatalf("ResolvePrice(%q -> %q) = (in=%.3f, out=%.3f), want (in=%.3f, out=%.3f)",
				tc.raw, canon, p.InputPerM, p.OutputPerM, tc.wantInput, tc.wantOut)
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

func TestHeatmapLogLevel(t *testing.T) {
	if got := heatmapLevel(0, 100_000, 200_000_000); got != 0 {
		t.Fatalf("zero tokens should be level 0, got %d", got)
	}
	if got := heatmapLevel(5_000_000, 5_000_000, 5_000_000); got != 4 {
		t.Fatalf("single active day should be level 4, got %d", got)
	}
	// With a 200M outlier spike and 500-token minimum, regular 5M and 30M days
	// should remain clearly shaded (level 3 and level 4) instead of collapsing to level 1.
	const minPos = 500
	const maxTok = 200_000_000
	if got := heatmapLevel(100_000, minPos, maxTok); got != 1 {
		t.Fatalf("expected 100K -> level 1, got %d", got)
	}
	if got := heatmapLevel(1_000_000, minPos, maxTok); got != 2 {
		t.Fatalf("expected 1M -> level 2, got %d", got)
	}
	if got := heatmapLevel(5_000_000, minPos, maxTok); got != 3 {
		t.Fatalf("expected 5M -> level 3, got %d", got)
	}
	if got := heatmapLevel(30_000_000, minPos, maxTok); got != 4 {
		t.Fatalf("expected 30M -> level 4, got %d", got)
	}
}

func TestSessionsPaginationAndFilters(t *testing.T) {
	store := newMemStore()
	svc := NewService(store)
	ctx := context.Background()

	base := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	slices := make([]IngestSlice, 0, 5)
	for i := 1; i <= 5; i++ {
		model := "claude-opus-5-5-20261001"
		agent := "claude"
		if i%2 == 0 {
			model = "google-antigravity/gemini-4-neon"
			agent = "antigravity"
		}
		slices = append(slices, IngestSlice{
			Agent:        agent,
			SessionID:    "sess-" + string(rune('0'+i)),
			HourBucket:   base.Add(time.Duration(i) * time.Hour),
			Model:        model,
			Project:      "yukideck",
			InputTokens:  int64(i * 10_000),
			OutputTokens: int64(i * 2_000),
			RequestCount: 1,
			FirstEventAt: base.Add(time.Duration(i)*time.Hour + 5*time.Minute),
			LastEventAt:  base.Add(time.Duration(i)*time.Hour + 10*time.Minute),
		})
	}
	if _, err := svc.Ingest(ctx, 1, IngestRequest{
		Device: IngestDevice{DeviceID: "dev-1", Name: "DevBox"},
		Slices: slices,
	}); err != nil {
		t.Fatalf("Ingest: %v", err)
	}

	filter := QueryFilter{
		Start:    base.Add(-time.Hour),
		End:      base.Add(10 * time.Hour),
		Timezone: "UTC",
	}

	p1, err := svc.Sessions(ctx, 1, filter, 1, 2)
	if err != nil {
		t.Fatalf("Sessions page 1: %v", err)
	}
	if p1.Total != 5 || len(p1.Sessions) != 2 || p1.Sessions[0].SessionID != "sess-5" || p1.Sessions[1].SessionID != "sess-4" {
		t.Fatalf("unexpected page 1: %+v", p1)
	}

	p3, err := svc.Sessions(ctx, 1, filter, 3, 2)
	if err != nil {
		t.Fatalf("Sessions page 3: %v", err)
	}
	if p3.Total != 5 || len(p3.Sessions) != 1 || p3.Sessions[0].SessionID != "sess-1" {
		t.Fatalf("unexpected page 3: %+v", p3)
	}

	// Out-of-range page still reports accurate Total
	p4, err := svc.Sessions(ctx, 1, filter, 4, 2)
	if err != nil {
		t.Fatalf("Sessions page 4: %v", err)
	}
	if p4.Total != 5 || len(p4.Sessions) != 0 {
		t.Fatalf("unexpected page 4: %+v", p4)
	}

	// Model filter resolves canonical model name into SQL pagination
	modelFilter := filter
	modelFilter.Model = "claude-opus-5.5"
	pm, err := svc.Sessions(ctx, 1, modelFilter, 1, 2)
	if err != nil {
		t.Fatalf("Sessions model filter: %v", err)
	}
	if pm.Total != 3 || len(pm.Sessions) != 2 || pm.Sessions[0].SessionID != "sess-5" || pm.Sessions[1].SessionID != "sess-3" {
		t.Fatalf("unexpected model-filtered sessions: %+v", pm)
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

func TestExactBeforeWildcardAndMultiLevelChannelStrip(t *testing.T) {
	// 1. Multi-level slash channel prefixes should all be stripped.
	if got := NormalizeModel("relay-a/v1/openai/gpt-6.1-sol-fast", nil); got != "gpt-6.1-sol-fast" {
		t.Fatalf("expected multi-level prefix stripped, got %q", got)
	}
	if got := NormalizeModel("corp/openrouter/anthropic/claude-opus-5-5-20261001", nil); got != "claude-opus-5.5" {
		t.Fatalf("expected multi-level claude prefix stripped, got %q", got)
	}

	// 2. Alias matching: exact always beats wildcard regardless of priority.
	aliases := []ModelAlias{
		{ID: 1, MatchPattern: "gpt-6.1-sol*", CanonicalModel: "gpt-6.1-sol", Priority: 1},
		{ID: 2, MatchPattern: "gpt-6.1-sol-turbo", CanonicalModel: "gpt-6.1-sol-turbo", Priority: 200},
	}
	if got := NormalizeModel("relay/openai/gpt-6.1-sol-turbo", aliases); got != "gpt-6.1-sol-turbo" {
		t.Fatalf("expected exact alias to beat lower-priority wildcard, got %q", got)
	}
	if got := NormalizeModel("relay/openai/gpt-6.1-sol-fast", aliases); got != "gpt-6.1-sol" {
		t.Fatalf("expected wildcard alias to group fast variant, got %q", got)
	}

	// 3. Pricing matching (Plan B): user exact > built-in exact > user wildcard > built-in wildcard,
	//    and raw exact beats canonical exact when raw was grouped under a wildcard alias.
	userPrices := []ModelPrice{
		{ModelPattern: "gpt-6.1-sol*", InputPerM: 1.0, OutputPerM: 5.0},
		{ModelPattern: "gpt-6.1-sol-fast", InputPerM: 4.5, OutputPerM: 22.5},
	}
	// Raw exact user override beats user wildcard and canonical model price.
	p, ok := ResolvePrice("relay/v1/gpt-6.1-sol-fast", "gpt-6.1-sol", userPrices)
	if !ok || p.InputPerM != 4.5 {
		t.Fatalf("expected raw exact user price 4.5, got %+v ok=%v", p, ok)
	}

	// Built-in exact price beats user wildcard price (Plan B).
	userWildcardOnly := []ModelPrice{
		{ModelPattern: "gpt-6.1*", InputPerM: 99.0, OutputPerM: 99.0},
	}
	pBuiltinExact, ok := ResolvePrice("proxy/v2/gpt-6.1-sol", "gpt-6.1-sol", userWildcardOnly)
	if !ok || pBuiltinExact.InputPerM == 99.0 {
		t.Fatalf("expected built-in exact price to beat user wildcard, got %+v ok=%v", pBuiltinExact, ok)
	}

	// Summary.ByModel.MergedRawModels & Sessions.ModelAliases record original raw model names.
	store := newMemStore()
	svc := NewService(store)
	ctx := context.Background()
	if _, err := svc.UpsertModelAlias(ctx, 1, UpsertModelAliasInput{
		MatchPattern:   "gpt-6.1-sol*",
		CanonicalModel: "gpt-6.1-sol",
		Priority:       10,
	}); err != nil {
		t.Fatalf("UpsertModelAlias: %v", err)
	}
	if _, err := svc.UpsertModelPrice(ctx, 1, UpsertModelPriceInput{
		ModelPattern: "gpt-6.1-sol-fast",
		InputPerM:    6.0,
		OutputPerM:   30.0,
	}); err != nil {
		t.Fatalf("UpsertModelPrice: %v", err)
	}
	h := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	if _, err := svc.Ingest(ctx, 1, IngestRequest{
		Device: IngestDevice{DeviceID: "d1", Name: "Dev"},
		Slices: []IngestSlice{
			{
				Agent:        "codex",
				SessionID:    "sess-fast",
				HourBucket:   h,
				Model:        "proxy/openai/gpt-6.1-sol-fast",
				Project:      "yukideck",
				InputTokens:  1_000_000,
				OutputTokens: 0,
				RequestCount: 1,
				FirstEventAt: h,
				LastEventAt:  h.Add(time.Minute),
			},
			{
				Agent:        "codex",
				SessionID:    "sess-std",
				HourBucket:   h,
				Model:        "gpt-6.1-sol",
				Project:      "yukideck",
				InputTokens:  1_000_000,
				OutputTokens: 0,
				RequestCount: 1,
				FirstEventAt: h,
				LastEventAt:  h.Add(time.Minute),
			},
		},
	}); err != nil {
		t.Fatalf("Ingest: %v", err)
	}

	filter := QueryFilter{Start: h.Add(-time.Hour), End: h.Add(2 * time.Hour), Timezone: "UTC"}
	sum, err := svc.Summary(ctx, 1, filter)
	if err != nil {
		t.Fatalf("Summary: %v", err)
	}
	if len(sum.ByModel) != 1 || sum.ByModel[0].Label != "gpt-6.1-sol" {
		t.Fatalf("expected merged single canonical model, got %+v", sum.ByModel)
	}
	if len(sum.ByModel[0].MergedRawModels) != 1 || sum.ByModel[0].MergedRawModels[0] != "proxy/openai/gpt-6.1-sol-fast" {
		t.Fatalf("expected MergedRawModels=[proxy/openai/gpt-6.1-sol-fast], got %+v", sum.ByModel[0].MergedRawModels)
	}
	// sess-fast billed at $6.0 + sess-std billed at built-in $2.0 = $8.0
	if math.Abs(sum.CostUSD-8.0) > 1e-6 {
		t.Fatalf("expected total cost $8.0 ($6 exact fast + $2 exact std), got %.6f", sum.CostUSD)
	}

	sessRes, err := svc.Sessions(ctx, 1, filter, 1, 10)
	if err != nil {
		t.Fatalf("Sessions: %v", err)
	}
	var fastSess, stdSess *SessionSummary
	for i := range sessRes.Sessions {
		if sessRes.Sessions[i].SessionID == "sess-fast" {
			fastSess = &sessRes.Sessions[i]
		}
		if sessRes.Sessions[i].SessionID == "sess-std" {
			stdSess = &sessRes.Sessions[i]
		}
	}
	if fastSess == nil || len(fastSess.ModelAliases["gpt-6.1-sol"]) != 1 || fastSess.ModelAliases["gpt-6.1-sol"][0] != "proxy/openai/gpt-6.1-sol-fast" {
		t.Fatalf("expected fastSess ModelAliases to carry original raw model, got %+v", fastSess)
	}
	if stdSess == nil || len(stdSess.ModelAliases) != 0 {
		t.Fatalf("expected stdSess to have empty ModelAliases, got %+v", stdSess)
	}
}

func TestIngestReplacesLegacyNonSubagentOrphanSlice(t *testing.T) {
	ctx := context.Background()
	st := newMemStore()
	svc := NewService(st)
	h := time.Date(2026, 9, 28, 9, 0, 0, 0, time.UTC)

	// 1. Simulate legacy collector sync (is_subagent=false, tool_call_count=0)
	if _, err := svc.Ingest(ctx, 1, IngestRequest{
		Device: IngestDevice{DeviceID: "dev-1", Name: "Ling"},
		Slices: []IngestSlice{
			{
				Agent:         "opencode",
				SessionID:     "ses_child",
				HourBucket:    h,
				Model:         "grok-4.7",
				IsSubagent:    false,
				InputTokens:   1000,
				OutputTokens:  200,
				RequestCount:  2,
				ToolCallCount: 0,
				FirstEventAt:  h,
				LastEventAt:   h.Add(time.Minute),
			},
		},
	}); err != nil {
		t.Fatalf("legacy Ingest: %v", err)
	}

	// 2. Simulate upgraded collector sync (is_subagent=true, parent_session_id set, tools extracted)
	if _, err := svc.Ingest(ctx, 1, IngestRequest{
		Device:         IngestDevice{DeviceID: "dev-1", Name: "Ling"},
		ForceOverwrite: true,
		Slices: []IngestSlice{
			{
				Agent:           "opencode",
				SessionID:       "ses_child",
				HourBucket:      h,
				Model:           "grok-4.7",
				IsSubagent:      true,
				ParentSessionID: "ses_root",
				InputTokens:     1000,
				OutputTokens:    200,
				RequestCount:    2,
				ToolCallCount:   5,
				ToolCalls:       map[string]int32{"bash": 3, "read": 2},
				FirstEventAt:    h,
				LastEventAt:     h.Add(time.Minute),
			},
		},
	}); err != nil {
		t.Fatalf("upgraded Ingest: %v", err)
	}

	filter := QueryFilter{Start: h.Add(-time.Hour), End: h.Add(2 * time.Hour), Timezone: "UTC"}
	sessRes, err := svc.Sessions(ctx, 1, filter, 1, 20)
	if err != nil {
		t.Fatalf("Sessions: %v", err)
	}
	if len(sessRes.Sessions) != 1 || sessRes.Sessions[0].SessionID != "ses_root" {
		t.Fatalf("expected legacy orphan removed leaving only ses_root, got %+v", sessRes.Sessions)
	}
	if sessRes.Sessions[0].ToolCallCount != 5 || sessRes.Sessions[0].Tokens.TotalTokens != 1200 {
		t.Fatalf("expected deduplicated tool_call_count=5 and total_tokens=1200, got %+v", sessRes.Sessions[0])
	}
}
