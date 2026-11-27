package clipboard

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"yukideck/internal/core/auth"
	"yukideck/internal/core/httpx"
)

type memStore struct {
	mu     sync.Mutex
	nextID int64
	items  map[int64]Record
}

func newMemStore() *memStore {
	return &memStore{
		items: make(map[int64]Record),
	}
}

func (m *memStore) ListActiveItems(_ context.Context, userID int64, now time.Time) ([]Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Record, 0)
	for _, r := range m.items {
		if r.UserID == userID && r.ExpiresAt.After(now) {
			out = append(out, r)
		}
	}
	return out, nil
}

func (m *memStore) GetActiveItem(_ context.Context, userID, id int64, now time.Time) (*Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.items[id]
	if !ok || r.UserID != userID || !r.ExpiresAt.After(now) {
		return nil, nil
	}
	cp := r
	return &cp, nil
}

func (m *memStore) GetMinSortOrder(_ context.Context, userID int64, now time.Time) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	minVal := 0
	for _, r := range m.items {
		if r.UserID == userID && r.ExpiresAt.After(now) && r.SortOrder < minVal {
			minVal = r.SortOrder
		}
	}
	return minVal, nil
}

func (m *memStore) CreateItem(_ context.Context, rec Record) (*Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextID++
	rec.ID = m.nextID
	rec.Version = 1
	m.items[rec.ID] = rec
	cp := rec
	return &cp, nil
}

func (m *memStore) UpdateItemContentWithVersion(_ context.Context, userID, id, expectedVersion int64, content string, byteSize int, starred bool, expiresAt, now time.Time) (*Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.items[id]
	if !ok || r.UserID != userID || !r.ExpiresAt.After(now) || r.Version != expectedVersion {
		return nil, nil
	}
	r.Content = content
	r.ByteSize = byteSize
	r.Starred = starred
	r.ExpiresAt = expiresAt
	r.Version++
	r.UpdatedAt = now
	m.items[id] = r
	cp := r
	return &cp, nil
}

func (m *memStore) UpdateItemContentForce(_ context.Context, userID, id int64, content string, byteSize int, starred bool, expiresAt, now time.Time) (*Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.items[id]
	if !ok || r.UserID != userID || !r.ExpiresAt.After(now) {
		return nil, nil
	}
	r.Content = content
	r.ByteSize = byteSize
	r.Starred = starred
	r.ExpiresAt = expiresAt
	r.Version++
	r.UpdatedAt = now
	m.items[id] = r
	cp := r
	return &cp, nil
}

func (m *memStore) UpdateItemMeta(_ context.Context, userID, id int64, starred bool, expiresAt, now time.Time) (*Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.items[id]
	if !ok || r.UserID != userID || !r.ExpiresAt.After(now) {
		return nil, nil
	}
	r.Starred = starred
	r.ExpiresAt = expiresAt
	r.UpdatedAt = now
	m.items[id] = r
	cp := r
	return &cp, nil
}

func (m *memStore) DeleteItem(_ context.Context, userID, id int64) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.items[id]
	if !ok || r.UserID != userID {
		return false, nil
	}
	delete(m.items, id)
	return true, nil
}

func (m *memStore) ReorderItems(_ context.Context, userID int64, ids []int64, now time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, id := range ids {
		r, ok := m.items[id]
		if ok && r.UserID == userID && r.ExpiresAt.After(now) {
			r.SortOrder = i
			m.items[id] = r
		}
	}
	return nil
}

func (m *memStore) PurgeExpired(_ context.Context, now time.Time) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var n int64
	for id, r := range m.items {
		if !r.ExpiresAt.After(now) {
			delete(m.items, id)
			n++
		}
	}
	return n, nil
}

func TestServiceCreateExpiryAndMaxBytes(t *testing.T) {
	store := newMemStore()
	svc := NewService(store, NewHub(), 128, nil)
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	svc.nowFn = func() time.Time { return now }

	// Default expiry is 24h.
	item, err := svc.CreateItem(context.Background(), 1, CreateItemInput{Content: "hello world"})
	if err != nil {
		t.Fatalf("create failed: %v", err)
	}
	if !item.ExpiresAt.Equal(now.Add(24 * time.Hour)) {
		t.Fatalf("expected 24h expiry, got %v", item.ExpiresAt)
	}
	if item.Version != 1 || item.ByteSize != 11 || item.CharCount != 11 || item.LineCount != 1 {
		t.Fatalf("unexpected item stats: %+v", item)
	}

	// Exceeding max bytes returns 413.
	_, err = svc.CreateItem(context.Background(), 1, CreateItemInput{Content: strings.Repeat("a", 129)})
	var appErr *httpx.AppError
	if !errors.As(err, &appErr) || appErr.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 payload_too_large, got %v", err)
	}

	// Expiry > 1 year rejected.
	tooFar := now.AddDate(1, 0, 2).Format(time.RFC3339)
	_, err = svc.CreateItem(context.Background(), 1, CreateItemInput{Content: "ok", ExpiresAt: &tooFar})
	if !errors.As(err, &appErr) || appErr.Status != http.StatusBadRequest {
		t.Fatalf("expected 400 for >1y expiry, got %v", err)
	}

	// Past expiry rejected.
	past := now.Add(-time.Minute).Format(time.RFC3339)
	_, err = svc.CreateItem(context.Background(), 1, CreateItemInput{Content: "ok", ExpiresAt: &past})
	if !errors.As(err, &appErr) || appErr.Status != http.StatusBadRequest {
		t.Fatalf("expected 400 for past expiry, got %v", err)
	}

	// Advance clock by 23h, then extend by another full 1 year from the new "now".
	now = now.Add(23 * time.Hour)
	oneYearFromNow := now.AddDate(1, 0, 0).Format(time.RFC3339)
	extended, err := svc.PatchItem(context.Background(), 1, item.ID, PatchItemInput{ExpiresAt: &oneYearFromNow})
	if err != nil {
		t.Fatalf("extend failed: %v", err)
	}
	if extended.Version != 1 {
		t.Fatalf("patch meta should not bump content version, got %d", extended.Version)
	}
	if !extended.ExpiresAt.Equal(now.AddDate(1, 0, 0)) {
		t.Fatalf("unexpected extended expiry: %v", extended.ExpiresAt)
	}
}

func TestServiceOptimisticLockingAndUserIsolation(t *testing.T) {
	store := newMemStore()
	svc := NewService(store, NewHub(), DefaultMaxBytes, nil)
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	svc.nowFn = func() time.Time { return now }

	created, err := svc.CreateItem(context.Background(), 1, CreateItemInput{Content: "v1"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// User 2 cannot read or update user 1's item.
	if _, err := svc.GetItem(context.Background(), 2, created.ID); err == nil {
		t.Fatalf("expected user isolation on GetItem")
	}

	// Update with matching expected_version succeeds and increments version to 2.
	v1 := int64(1)
	u2, err := svc.UpdateItem(context.Background(), 1, created.ID, UpdateItemInput{
		Content:         "v2",
		ExpectedVersion: &v1,
	})
	if err != nil {
		t.Fatalf("update v1->v2: %v", err)
	}
	if u2.Version != 2 || u2.Content != "v2" {
		t.Fatalf("unexpected updated item: %+v", u2)
	}

	// Stale expected_version returns 409 version_conflict.
	_, err = svc.UpdateItem(context.Background(), 1, created.ID, UpdateItemInput{
		Content:         "stale write",
		ExpectedVersion: &v1,
	})
	var appErr *httpx.AppError
	if !errors.As(err, &appErr) || appErr.Status != http.StatusConflict || appErr.Code != "version_conflict" {
		t.Fatalf("expected 409 version_conflict, got %v", err)
	}

	// Force overwrite succeeds and increments version to 3.
	u3, err := svc.UpdateItem(context.Background(), 1, created.ID, UpdateItemInput{
		Content:         "forced v3",
		ExpectedVersion: &v1,
		Force:           true,
	})
	if err != nil {
		t.Fatalf("force update: %v", err)
	}
	if u3.Version != 3 || u3.Content != "forced v3" {
		t.Fatalf("unexpected forced item: %+v", u3)
	}
}

func TestServiceSearchSortReorderAndPurge(t *testing.T) {
	store := newMemStore()
	svc := NewService(store, NewHub(), DefaultMaxBytes, nil)
	base := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	now := base
	svc.nowFn = func() time.Time { return now }

	a, _ := svc.CreateItem(context.Background(), 1, CreateItemInput{Content: "alpha snippet"})
	now = base.Add(time.Minute)
	starred := true
	expSoon := now.Add(2 * time.Hour).Format(time.RFC3339)
	b, _ := svc.CreateItem(context.Background(), 1, CreateItemInput{Content: "beta starred", Starred: &starred, ExpiresAt: &expSoon})
	now = base.Add(2 * time.Minute)
	c, _ := svc.CreateItem(context.Background(), 1, CreateItemInput{Content: "gamma snippet"})

	// Starred always floats to top.
	res, err := svc.ListItems(context.Background(), 1, ListQuery{SortBy: "updated_at", SortDir: "desc"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(res.Items) != 3 || res.Items[0].ID != b.ID || res.Items[1].ID != c.ID || res.Items[2].ID != a.ID {
		t.Fatalf("unexpected order: %+v", res.Items)
	}

	// Keyword search.
	searchRes, _ := svc.ListItems(context.Background(), 1, ListQuery{Q: "SNIPPET"})
	if searchRes.Total != 2 {
		t.Fatalf("expected 2 search matches, got %d", searchRes.Total)
	}

	// Manual reorder.
	if err := svc.ReorderItems(context.Background(), 1, ReorderItemsInput{IDs: []int64{b.ID, a.ID, c.ID}}); err != nil {
		t.Fatalf("reorder: %v", err)
	}
	manualRes, _ := svc.ListItems(context.Background(), 1, ListQuery{SortBy: "manual", SortDir: "asc"})
	if manualRes.Items[0].ID != b.ID || manualRes.Items[1].ID != a.ID || manualRes.Items[2].ID != c.ID {
		t.Fatalf("unexpected manual order: %+v", manualRes.Items)
	}

	// Advance past b's 2h expiry -> b vanishes immediately from List and is purged by PurgeExpired.
	now = base.Add(3 * time.Hour)
	afterExp, _ := svc.ListItems(context.Background(), 1, ListQuery{})
	if afterExp.Total != 2 {
		t.Fatalf("expected 2 active items after expiry, got %d", afterExp.Total)
	}
	purged, err := svc.PurgeExpired(context.Background())
	if err != nil || purged != 1 {
		t.Fatalf("expected 1 purged row, got %d err=%v", purged, err)
	}
}

func TestCompactListAndLargeSSEFetchRequired(t *testing.T) {
	store := newMemStore()
	hub := NewHub()
	svc := NewService(store, hub, DefaultMaxBytes, nil)

	sub := hub.Subscribe(1, "tab-b")
	defer hub.Unsubscribe(sub)

	largeText := strings.Repeat("x", 70*1024) // 70 KiB > 64 KiB SSE threshold & > 32 KiB list threshold
	created, err := svc.CreateItem(context.Background(), 1, CreateItemInput{
		Content:  largeText,
		ClientID: "tab-a",
	})
	if err != nil {
		t.Fatalf("create large: %v", err)
	}
	if created.ContentOmitted || len(created.Content) != len(largeText) {
		t.Fatalf("create response should contain full content")
	}

	listRes, err := svc.ListItems(context.Background(), 1, ListQuery{})
	if err != nil || len(listRes.Items) != 1 {
		t.Fatalf("list large: %v", err)
	}
	if !listRes.Items[0].ContentOmitted || listRes.Items[0].Content != "" || len(listRes.Items[0].Preview) != PreviewMaxRunes {
		t.Fatalf("expected omitted content with preview in list: %+v", listRes.Items[0])
	}

	select {
	case ev := <-sub.ch:
		if ev.Type != "created" || !ev.FetchRequired || ev.Item != nil {
			t.Fatalf("expected lightweight fetch_required SSE event for >64KiB item, got %+v", ev)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for SSE event")
	}
}

func TestHTTPAndSSEStreamThroughRequestLogger(t *testing.T) {
	store := newMemStore()
	svc := NewService(store, NewHub(), DefaultMaxBytes, nil)
	h := NewHandler(svc, 1<<20, DefaultMaxBytes, nil)

	r := chi.NewRouter()
	r.Use(httpx.RequestLogger(nil))
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := auth.WithPrincipal(req.Context(), &auth.Principal{
				User:       &auth.User{ID: 42, Username: "tester"},
				Kind:       auth.PrincipalSession,
				Authorized: true,
			})
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.Route("/api/v1/clipboard", h.RegisterRoutes)

	srv := httptest.NewServer(r)
	defer srv.Close()

	// Connect SSE client as tab-b.
	sseCtx, cancelSSE := context.WithCancel(context.Background())
	defer cancelSSE()
	sseReq, _ := http.NewRequestWithContext(sseCtx, http.MethodGet, srv.URL+"/api/v1/clipboard/events?client_id=tab-b", nil)
	sseResp, err := http.DefaultClient.Do(sseReq)
	if err != nil {
		t.Fatalf("open sse: %v", err)
	}
	defer sseResp.Body.Close()
	if sseResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for SSE, got %d", sseResp.StatusCode)
	}

	reader := bufio.NewReader(sseResp.Body)
	// Read initial ": connected" comment line + blank line.
	line, err := reader.ReadString('\n')
	if err != nil || !strings.HasPrefix(line, ": connected") {
		t.Fatalf("expected connected comment, got %q err=%v", line, err)
	}
	_, _ = reader.ReadString('\n')

	// Create clip as tab-a over HTTP.
	body, _ := json.Marshal(CreateItemInput{Content: "hello realtime", ClientID: "tab-a"})
	postResp, err := http.Post(srv.URL+"/api/v1/clipboard/items", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("post item: %v", err)
	}
	defer postResp.Body.Close()
	if postResp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d", postResp.StatusCode)
	}

	// Verify SSE client receives event immediately.
	evLine, err := reader.ReadString('\n')
	if err != nil || strings.TrimSpace(evLine) != "event: clipboard" {
		t.Fatalf("expected event: clipboard, got %q err=%v", evLine, err)
	}
	dataLine, err := reader.ReadString('\n')
	if err != nil || !strings.HasPrefix(dataLine, "data: ") {
		t.Fatalf("expected data line, got %q err=%v", dataLine, err)
	}
	var got ClipboardEvent
	if err := json.Unmarshal([]byte(strings.TrimPrefix(strings.TrimSpace(dataLine), "data: ")), &got); err != nil {
		t.Fatalf("unmarshal sse event: %v", err)
	}
	if got.Type != "created" || got.Item == nil || got.Item.Content != "hello realtime" {
		t.Fatalf("unexpected sse payload: %+v", got)
	}
}
