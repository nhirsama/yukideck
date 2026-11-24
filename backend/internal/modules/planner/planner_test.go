package planner

import (
	"context"
	"sync"
	"testing"
	"time"

	"yukideck/internal/core/messenger"
)

// --- In-memory Store & Notifier for deterministic unit tests ---

type memStore struct {
	mu     sync.Mutex
	nextID int64
	logID  int64
	items  map[int64]ItemRecord
	logs   []LogRecord
}

func newMemStore() *memStore {
	return &memStore{items: make(map[int64]ItemRecord)}
}

func (m *memStore) ListItems(_ context.Context, userID int64) ([]ItemRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []ItemRecord
	for _, it := range m.items {
		if it.UserID == userID {
			out = append(out, it)
		}
	}
	return out, nil
}

func (m *memStore) GetItem(_ context.Context, userID, id int64) (*ItemRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	it, ok := m.items[id]
	if !ok || it.UserID != userID {
		return nil, nil
	}
	return &it, nil
}

func (m *memStore) CreateItem(_ context.Context, rec ItemRecord) (*ItemRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextID++
	rec.ID = m.nextID
	rec.CreatedAt = time.Now()
	rec.UpdatedAt = rec.CreatedAt
	m.items[rec.ID] = rec
	return &rec, nil
}

func (m *memStore) UpdateItem(_ context.Context, rec ItemRecord) (*ItemRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.items[rec.ID]; !ok {
		return nil, nil
	}
	rec.UpdatedAt = time.Now()
	m.items[rec.ID] = rec
	return &rec, nil
}

func (m *memStore) DeleteItem(_ context.Context, userID, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if it, ok := m.items[id]; ok && it.UserID == userID {
		delete(m.items, id)
	}
	return nil
}

func (m *memStore) ListDueItems(_ context.Context, now time.Time) ([]ItemRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []ItemRecord
	for _, it := range m.items {
		if it.Status == StatusPending && it.NextTriggerAt != nil && !it.NextTriggerAt.After(now) {
			out = append(out, it)
		}
	}
	return out, nil
}

func (m *memStore) MinNextTriggerAt(_ context.Context) (*time.Time, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var minT *time.Time
	for _, it := range m.items {
		if it.Status == StatusPending && it.NextTriggerAt != nil {
			if minT == nil || it.NextTriggerAt.Before(*minT) {
				t := *it.NextTriggerAt
				minT = &t
			}
		}
	}
	return minT, nil
}

func (m *memStore) ListSentTriggerKeys(_ context.Context, itemID int64) (map[string]struct{}, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]struct{})
	for _, l := range m.logs {
		if l.ItemID != nil && *l.ItemID == itemID {
			out[l.TriggerKey] = struct{}{}
		}
	}
	return out, nil
}

func (m *memStore) InsertLogAndPrune(_ context.Context, rec LogRecord, _ int) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, l := range m.logs {
		if rec.ItemID != nil && l.ItemID != nil && *l.ItemID == *rec.ItemID && l.TriggerKey == rec.TriggerKey {
			return false, nil
		}
	}
	m.logID++
	rec.ID = m.logID
	rec.SentAt = time.Now()
	m.logs = append(m.logs, rec)
	return true, nil
}

func (m *memStore) ListLogs(_ context.Context, userID int64, _ int) ([]LogRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []LogRecord
	for _, l := range m.logs {
		if l.UserID == userID {
			out = append(out, l)
		}
	}
	return out, nil
}

type fakeNotifier struct {
	mu   sync.Mutex
	sent []messenger.Message
}

func (f *fakeNotifier) Send(_ context.Context, _ int64, _ []int64, msg messenger.Message) ([]messenger.DeliveryResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, msg)
	return []messenger.DeliveryResult{{ChannelID: 1, ChannelName: "TG", OK: true}}, nil
}

func TestLeapYearAndMonthEndAnchorPreservation(t *testing.T) {
	loc, _ := time.LoadLocation("Asia/Shanghai")

	// 1. Leap year yearly: 2024-02-29 -> 2025-02-28 -> ... -> 2028-02-29
	cfgLeap := RepeatConfig{AnchorMonth: 2, AnchorDay: 29, AnchorHour: 9, AnchorMinute: 30}
	cur := time.Date(2024, 2, 29, 9, 30, 0, 0, loc)
	y2025, ok, err := AdvanceTarget(cur, cfgLeap, CalendarSolar, RepeatYearly, "Asia/Shanghai")
	if err != nil || !ok || y2025.In(loc).Format("2006-01-02 15:04") != "2025-02-28 09:30" {
		t.Fatalf("expected 2025-02-28 09:30, got %v (err=%v)", y2025.In(loc), err)
	}
	cur = y2025
	for i := 0; i < 3; i++ {
		cur, _, _ = AdvanceTarget(cur, cfgLeap, CalendarSolar, RepeatYearly, "Asia/Shanghai")
	}
	if cur.In(loc).Format("2006-01-02 15:04") != "2028-02-29 09:30" {
		t.Fatalf("expected anchor recovery on leap year 2028-02-29 09:30, got %v", cur.In(loc))
	}

	// 2. Monthly 31st: Jan 31 -> Feb 28 -> Mar 31
	cfgMonth := RepeatConfig{AnchorDay: 31, AnchorHour: 8, AnchorMinute: 0}
	jan31 := time.Date(2026, 1, 31, 8, 0, 0, 0, loc)
	feb, _, _ := AdvanceTarget(jan31, cfgMonth, CalendarSolar, RepeatMonthly, "Asia/Shanghai")
	if feb.In(loc).Format("2006-01-02 15:04") != "2026-02-28 08:00" {
		t.Fatalf("expected 2026-02-28 08:00, got %v", feb.In(loc))
	}
	mar, _, _ := AdvanceTarget(feb, cfgMonth, CalendarSolar, RepeatMonthly, "Asia/Shanghai")
	if mar.In(loc).Format("2006-01-02 15:04") != "2026-03-31 08:00" {
		t.Fatalf("expected anchor recovery to 2026-03-31 08:00, got %v", mar.In(loc))
	}
}

func TestLunarClampingAndDSTWallClockOffsets(t *testing.T) {
	shanghai, _ := time.LoadLocation("Asia/Shanghai")

	// Lunar New Year's Eve (12-30) in 2025: lunar 2025 month 12 only has 29 days -> clamps to 12-29 without error
	tLunar, err := LunarToSolarTime(2025, 12, 30, false, 18, 0, shanghai)
	if err != nil {
		t.Fatalf("LunarToSolarTime clamped: %v", err)
	}
	if tLunar.IsZero() {
		t.Fatalf("expected valid solar conversion for clamped lunar date")
	}

	// DST transition in America/New_York: 2026-03-08 clocks spring forward 02:00 -> 03:00 (23-hour day).
	// Target = 2026-03-09 09:00 EDT; "-1 day" MUST stay 2026-03-08 09:00 EDT (wall clock), while "-30m" is 08:30 EDT.
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skipf("tzdata for America/New_York unavailable: %v", err)
	}
	target := time.Date(2026, 3, 9, 9, 0, 0, 0, ny)
	points := ComputeTriggersForOccurrence(target, "America/New_York", []RemindOffset{
		{Unit: "day", Value: 1},
		{Unit: "minute", Value: 30},
		{Unit: "minute", Value: 0},
	})
	if len(points) != 3 {
		t.Fatalf("expected 3 trigger points, got %d", len(points))
	}
	if got := points[0].TriggerAt.In(ny).Format("2006-01-02 15:04"); got != "2026-03-08 09:00" {
		t.Fatalf("expected -1d across DST to preserve 09:00 wall-clock, got %s", got)
	}
	if got := points[1].TriggerAt.In(ny).Format("2006-01-02 15:04"); got != "2026-03-09 08:30" {
		t.Fatalf("expected -30m to be 08:30, got %s", got)
	}
}

func TestUnifiedTodoAndIndividualMultiOffsetDispatch(t *testing.T) {
	store := newMemStore()
	notifier := &fakeNotifier{}
	worker := NewWakeupWorker(store, notifier, nil)
	svc := NewService(store, notifier, worker)
	ctx := context.Background()

	// 1. Pure Todo: title only -> target_at=nil, next_trigger_at=nil (excluded from partial B-Tree index)
	todo, err := svc.CreateItem(ctx, 1, UpsertItemInput{Title: "买牛奶"})
	if err != nil {
		t.Fatalf("CreateItem pure todo: %v", err)
	}
	if todo.TargetAt != nil || todo.NextTriggerAt != nil {
		t.Fatalf("expected nil target & trigger for pure todo, got %+v", todo)
	}

	// 2. Repeating item with 2 offsets (-30m and 0m)
	loc, _ := time.LoadLocation("Asia/Shanghai")
	target := time.Date(2026, 12, 1, 9, 0, 0, 0, loc).UTC()
	item, err := store.CreateItem(ctx, ItemRecord{
		UserID:       1,
		Title:        "交房租",
		Note:         "转账给房东",
		Status:       StatusPending,
		TargetAt:     &target,
		Timezone:     "Asia/Shanghai",
		CalendarType: CalendarSolar,
		RepeatType:   RepeatMonthly,
		RepeatConfig: RepeatConfig{AnchorDay: 1, AnchorHour: 9, AnchorMinute: 0},
		AutoAdvance:  true,
		RemindOffsets: []RemindOffset{
			{Unit: "minute", Value: 30},
			{Unit: "minute", Value: 0},
		},
	})
	if err != nil {
		t.Fatalf("seed item: %v", err)
	}
	item.NextTriggerAt = ComputeNextTrigger(*item, map[string]struct{}{}, time.Time{})
	_, _ = store.UpdateItem(ctx, *item)

	// Trigger 1: 08:30 (-30m)
	t1 := time.Date(2026, 12, 1, 8, 30, 0, 0, loc)
	worker.nowFunc = func() time.Time { return t1 }
	worker.ProcessDueOnce(ctx)
	// Calling again at same minute MUST be idempotently deduplicated
	worker.ProcessDueOnce(ctx)

	if len(notifier.sent) != 1 {
		t.Fatalf("expected exactly 1 message at 08:30 (deduped), got %d", len(notifier.sent))
	}

	// Trigger 2: 09:00 (0m) -> sends 2nd individual message & auto-advances to 2027-01-01 09:00
	t2 := time.Date(2026, 12, 1, 9, 0, 0, 0, loc)
	worker.nowFunc = func() time.Time { return t2 }
	worker.ProcessDueOnce(ctx)

	if len(notifier.sent) != 2 {
		t.Fatalf("expected 2nd individual message at 09:00, got %d", len(notifier.sent))
	}
	updated, _ := store.GetItem(ctx, 1, item.ID)
	if updated.TargetAt.In(loc).Format("2006-01-02 15:04") != "2027-01-01 09:00" {
		t.Fatalf("expected auto-advance to 2027-01-01 09:00, got %v", updated.TargetAt.In(loc))
	}
	if updated.NextTriggerAt == nil || updated.NextTriggerAt.In(loc).Format("2006-01-02 15:04") != "2027-01-01 08:30" {
		t.Fatalf("expected next trigger at 2027-01-01 08:30, got %v", updated.NextTriggerAt)
	}
}
