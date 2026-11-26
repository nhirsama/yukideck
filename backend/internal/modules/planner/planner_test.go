package planner

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"yukideck/internal/core/httpx"
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

func (m *memStore) ListSettledTriggerKeys(_ context.Context, itemID int64) (map[string]struct{}, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]struct{})
	for _, l := range m.logs {
		if l.ItemID != nil && *l.ItemID == itemID && (l.Status == LogStatusOK || l.Status == LogStatusFailed || l.Status == LogStatusSkipped) {
			out[l.TriggerKey] = struct{}{}
		}
	}
	return out, nil
}

func (m *memStore) InsertSettledLogAndPrune(_ context.Context, rec LogRecord, _ int) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, l := range m.logs {
		if rec.ItemID != nil && l.ItemID != nil && *l.ItemID == *rec.ItemID && l.TriggerKey == rec.TriggerKey &&
			(l.Status == LogStatusOK || l.Status == LogStatusFailed || l.Status == LogStatusSkipped) {
			return false, nil
		}
	}
	m.logID++
	rec.ID = m.logID
	rec.SentAt = time.Now()
	m.logs = append(m.logs, rec)
	return true, nil
}

func (m *memStore) InsertAttemptLogAndPrune(_ context.Context, rec LogRecord, _ int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.logID++
	rec.ID = m.logID
	rec.SentAt = time.Now()
	m.logs = append(m.logs, rec)
	return nil
}

func (m *memStore) ListLogs(_ context.Context, userID int64, status string, _ int) ([]LogRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []LogRecord
	for _, l := range m.logs {
		if l.UserID == userID && (status == "" || l.Status == status) {
			out = append(out, l)
		}
	}
	return out, nil
}

type fakeNotifier struct {
	mu      sync.Mutex
	sent    []messenger.Message
	sendFn  func(attempt int, msg messenger.Message) ([]messenger.DeliveryResult, error)
	calls   int
}

func (f *fakeNotifier) Send(_ context.Context, _ int64, _ []int64, msg messenger.Message) ([]messenger.DeliveryResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.sendFn != nil {
		res, err := f.sendFn(f.calls, msg)
		if err == nil {
			for _, r := range res {
				if r.OK {
					f.sent = append(f.sent, msg)
					break
				}
			}
		}
		return res, err
	}
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

	tLunar, err := LunarToSolarTime(2025, 12, 30, false, 18, 0, shanghai)
	if err != nil {
		t.Fatalf("LunarToSolarTime clamped: %v", err)
	}
	if tLunar.IsZero() {
		t.Fatalf("expected valid solar conversion for clamped lunar date")
	}

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

	todo, err := svc.CreateItem(ctx, 1, UpsertItemInput{Title: "买牛奶"})
	if err != nil {
		t.Fatalf("CreateItem pure todo: %v", err)
	}
	if todo.TargetAt != nil || todo.NextTriggerAt != nil {
		t.Fatalf("expected nil target & trigger for pure todo, got %+v", todo)
	}

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

	t1 := time.Date(2026, 12, 1, 8, 30, 0, 0, loc)
	worker.nowFunc = func() time.Time { return t1 }
	worker.ProcessDueOnce(ctx)
	worker.ProcessDueOnce(ctx)

	if len(notifier.sent) != 1 {
		t.Fatalf("expected exactly 1 message at 08:30 (deduped), got %d", len(notifier.sent))
	}

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

func TestRetryBackoffAndAutoAdvanceDeferral(t *testing.T) {
	store := newMemStore()
	notifier := &fakeNotifier{
		sendFn: func(attempt int, msg messenger.Message) ([]messenger.DeliveryResult, error) {
			if attempt <= 2 {
				return nil, errors.New("temporary network timeout")
			}
			return []messenger.DeliveryResult{{ChannelID: 1, ChannelName: "TG", OK: true}}, nil
		},
	}
	worker := NewWakeupWorker(store, notifier, nil)
	ctx := context.Background()
	loc, _ := time.LoadLocation("Asia/Shanghai")

	target := time.Date(2026, 12, 1, 9, 0, 0, 0, loc).UTC()
	item, _ := store.CreateItem(ctx, ItemRecord{
		UserID:        1,
		Title:         "每日打卡",
		Status:        StatusPending,
		TargetAt:      &target,
		Timezone:      "Asia/Shanghai",
		CalendarType:  CalendarSolar,
		RepeatType:    RepeatDaily,
		RepeatConfig:  RepeatConfig{AnchorHour: 9, AnchorMinute: 0},
		AutoAdvance:   true,
		RemindOffsets: []RemindOffset{{Unit: "minute", Value: 0}},
	})
	item.NextTriggerAt = ComputeNextTrigger(*item, map[string]struct{}{}, time.Time{})
	_, _ = store.UpdateItem(ctx, *item)

	// Attempt 1 fails at 09:00 -> schedules retry #1 at 09:01, does NOT advance target_at!
	t0 := time.Date(2026, 12, 1, 9, 0, 0, 0, loc)
	worker.nowFunc = func() time.Time { return t0 }
	worker.ProcessDueOnce(ctx)

	cur, _ := store.GetItem(ctx, 1, item.ID)
	if cur.RetryState == nil || cur.RetryState.Attempt != 1 {
		t.Fatalf("expected RetryState attempt=1, got %+v", cur.RetryState)
	}
	if cur.TargetAt.In(loc).Format("2006-01-02") != "2026-12-01" {
		t.Fatalf("must NOT advance cycle while retrying, got %v", cur.TargetAt.In(loc))
	}
	if !cur.NextTriggerAt.Equal(t0.Add(1 * time.Minute).UTC()) {
		t.Fatalf("expected next trigger at +1m, got %v", cur.NextTriggerAt)
	}

	// Attempt 2 fails at 09:01 -> schedules retry #2 at 09:06 (+5m)
	t1 := t0.Add(1 * time.Minute)
	worker.nowFunc = func() time.Time { return t1 }
	worker.ProcessDueOnce(ctx)

	cur, _ = store.GetItem(ctx, 1, item.ID)
	if cur.RetryState == nil || cur.RetryState.Attempt != 2 {
		t.Fatalf("expected RetryState attempt=2, got %+v", cur.RetryState)
	}
	if !cur.NextTriggerAt.Equal(t1.Add(5 * time.Minute).UTC()) {
		t.Fatalf("expected next trigger at +5m, got %v", cur.NextTriggerAt)
	}

	// Attempt 3 succeeds at 09:06 -> clears RetryState and auto-advances to 2026-12-02 09:00!
	t2 := t1.Add(5 * time.Minute)
	worker.nowFunc = func() time.Time { return t2 }
	worker.ProcessDueOnce(ctx)

	cur, _ = store.GetItem(ctx, 1, item.ID)
	if cur.RetryState != nil {
		t.Fatalf("expected RetryState cleared after success, got %+v", cur.RetryState)
	}
	if cur.TargetAt.In(loc).Format("2006-01-02 15:04") != "2026-12-02 09:00" {
		t.Fatalf("expected advance to 2026-12-02 09:00 after retry succeeded, got %v", cur.TargetAt.In(loc))
	}

	logs, _ := store.ListLogs(ctx, 1, "", 50)
	if len(logs) != 3 {
		t.Fatalf("expected 3 log entries (2 retrying + 1 ok), got %d: %+v", len(logs), logs)
	}
	if logs[0].Status != LogStatusRetrying || logs[1].Status != LogStatusRetrying || logs[2].Status != LogStatusOK || logs[2].Attempt != 3 {
		t.Fatalf("unexpected log sequence: %+v", logs)
	}
}

func TestRetryExhaustedAndNoChannelAndMissedGraceLog(t *testing.T) {
	ctx := context.Background()
	loc, _ := time.LoadLocation("Asia/Shanghai")

	// 1. Exhausted retries (1m -> 5m -> 15m, total 4 attempts)
	store := newMemStore()
	notifier := &fakeNotifier{
		sendFn: func(attempt int, msg messenger.Message) ([]messenger.DeliveryResult, error) {
			return []messenger.DeliveryResult{{ChannelID: 1, ChannelName: "TG", OK: false, Error: "502 bad gateway"}}, nil
		},
	}
	worker := NewWakeupWorker(store, notifier, nil)
	target := time.Date(2026, 12, 1, 10, 0, 0, 0, loc).UTC()
	item, _ := store.CreateItem(ctx, ItemRecord{
		UserID:        1,
		Title:         "失败测试",
		Status:        StatusPending,
		TargetAt:      &target,
		Timezone:      "Asia/Shanghai",
		CalendarType:  CalendarSolar,
		RepeatType:    RepeatNone,
		RemindOffsets: []RemindOffset{{Unit: "minute", Value: 0}},
	})
	item.NextTriggerAt = ComputeNextTrigger(*item, map[string]struct{}{}, time.Time{})
	_, _ = store.UpdateItem(ctx, *item)

	times := []time.Time{
		time.Date(2026, 12, 1, 10, 0, 0, 0, loc),
		time.Date(2026, 12, 1, 10, 1, 0, 0, loc),
		time.Date(2026, 12, 1, 10, 6, 0, 0, loc),
		time.Date(2026, 12, 1, 10, 21, 0, 0, loc),
	}
	for _, ts := range times {
		worker.nowFunc = func() time.Time { return ts }
		worker.ProcessDueOnce(ctx)
	}
	cur, _ := store.GetItem(ctx, 1, item.ID)
	if cur.RetryState != nil || cur.NextTriggerAt != nil {
		t.Fatalf("expected exhausted retry cleared, got retry=%+v next=%v", cur.RetryState, cur.NextTriggerAt)
	}
	failedLogs, _ := store.ListLogs(ctx, 1, LogStatusFailed, 50)
	if len(failedLogs) != 1 || failedLogs[0].Reason != ReasonRetryExhausted || failedLogs[0].Attempt != 4 {
		t.Fatalf("expected 1 failed/retry_exhausted attempt=4 log, got %+v", failedLogs)
	}

	// 2. Non-retryable no_channel error settles on attempt 1
	store2 := newMemStore()
	notifier2 := &fakeNotifier{
		sendFn: func(attempt int, msg messenger.Message) ([]messenger.DeliveryResult, error) {
			return nil, httpx.BadRequest("未找到可用的出站推送渠道")
		},
	}
	worker2 := NewWakeupWorker(store2, notifier2, nil)
	item2, _ := store2.CreateItem(ctx, ItemRecord{
		UserID:        1,
		Title:         "无渠道测试",
		Status:        StatusPending,
		TargetAt:      &target,
		Timezone:      "Asia/Shanghai",
		CalendarType:  CalendarSolar,
		RepeatType:    RepeatNone,
		RemindOffsets: []RemindOffset{{Unit: "minute", Value: 0}},
	})
	item2.NextTriggerAt = ComputeNextTrigger(*item2, map[string]struct{}{}, time.Time{})
	_, _ = store2.UpdateItem(ctx, *item2)
	worker2.nowFunc = func() time.Time { return times[0] }
	worker2.ProcessDueOnce(ctx)

	cur2, _ := store2.GetItem(ctx, 1, item2.ID)
	if cur2.RetryState != nil {
		t.Fatalf("no_channel must NOT retry, got %+v", cur2.RetryState)
	}
	noChanLogs, _ := store2.ListLogs(ctx, 1, LogStatusFailed, 50)
	if len(noChanLogs) != 1 || noChanLogs[0].Reason != ReasonNoChannel {
		t.Fatalf("expected no_channel failed log, got %+v", noChanLogs)
	}

	// 3. Missed grace window (>15m) logs skipped / missed_grace_window instead of silent drop
	store3 := newMemStore()
	worker3 := NewWakeupWorker(store3, &fakeNotifier{}, nil)
	item3, _ := store3.CreateItem(ctx, ItemRecord{
		UserID:        1,
		Title:         "超时跳过测试",
		Status:        StatusPending,
		TargetAt:      &target,
		Timezone:      "Asia/Shanghai",
		CalendarType:  CalendarSolar,
		RepeatType:    RepeatNone,
		RemindOffsets: []RemindOffset{{Unit: "minute", Value: 0}},
	})
	item3.NextTriggerAt = ComputeNextTrigger(*item3, map[string]struct{}{}, time.Time{})
	_, _ = store3.UpdateItem(ctx, *item3)
	worker3.nowFunc = func() time.Time { return times[0].Add(20 * time.Minute) }
	worker3.ProcessDueOnce(ctx)

	skipLogs, _ := store3.ListLogs(ctx, 1, LogStatusSkipped, 50)
	if len(skipLogs) != 1 || skipLogs[0].Reason != ReasonMissedGraceWindow {
		t.Fatalf("expected missed_grace_window skip log, got %+v", skipLogs)
	}
}

func TestOverdueValidationClampAndRecurringLifecycle(t *testing.T) {
	loc, _ := time.LoadLocation("Asia/Shanghai")
	target := time.Date(2026, 12, 1, 9, 0, 0, 0, loc).UTC()

	// 1. Default max_count = 3 and silent clamp >10 -> 10
	cfgDef, err := NormalizeOverdueConfig(&OverdueConfig{Enabled: true, IntervalUnit: "hour", IntervalValue: 2}, RepeatNone, CalendarSolar, "Asia/Shanghai", RepeatConfig{}, &target)
	if err != nil || cfgDef.MaxCount != 3 {
		t.Fatalf("expected default max_count=3, got %+v err=%v", cfgDef, err)
	}
	cfgClamp, err := NormalizeOverdueConfig(&OverdueConfig{Enabled: true, IntervalUnit: "day", IntervalValue: 1, MaxCount: 99}, RepeatNone, CalendarSolar, "Asia/Shanghai", RepeatConfig{}, &target)
	if err != nil || cfgClamp.MaxCount != 10 {
		t.Fatalf("expected clamped max_count=10, got %+v err=%v", cfgClamp, err)
	}

	// 2. Strict `<` cycle length validation
	// daily (24h): 6h * 4 = 24h -> MUST fail (not strictly less)
	if _, err := NormalizeOverdueConfig(&OverdueConfig{Enabled: true, IntervalUnit: "hour", IntervalValue: 6, MaxCount: 4}, RepeatDaily, CalendarSolar, "Asia/Shanghai", RepeatConfig{}, &target); err == nil {
		t.Fatalf("expected strict < rejection for 6h * 4 == 24h on daily repeat")
	}
	// daily (24h): 6h * 3 = 18h < 24h -> MUST succeed
	if _, err := NormalizeOverdueConfig(&OverdueConfig{Enabled: true, IntervalUnit: "hour", IntervalValue: 6, MaxCount: 3}, RepeatDaily, CalendarSolar, "Asia/Shanghai", RepeatConfig{}, &target); err != nil {
		t.Fatalf("expected 6h * 3 < 24h to pass on daily repeat, got err=%v", err)
	}
	// weekly Mon+Wed (min gap 2d): 1d * 2 = 2d -> MUST fail
	if _, err := NormalizeOverdueConfig(&OverdueConfig{Enabled: true, IntervalUnit: "day", IntervalValue: 1, MaxCount: 2}, RepeatWeekly, CalendarSolar, "Asia/Shanghai", RepeatConfig{Weekdays: []int{1, 3}}, &target); err == nil {
		t.Fatalf("expected strict < rejection for 1d * 2 == 2d on Mon+Wed weekly repeat")
	}

	// 3. Recurring item with overdue enabled + auto_advance=true:
	//    on-time reminder does NOT advance; sends overdue 1/2 and 2/2, then logs overdue_limit_reached and auto-advances!
	store := newMemStore()
	notifier := &fakeNotifier{}
	worker := NewWakeupWorker(store, notifier, nil)
	ctx := context.Background()

	item, _ := store.CreateItem(ctx, ItemRecord{
		UserID:        1,
		Title:         "每周备份",
		Status:        StatusPending,
		TargetAt:      &target,
		Timezone:      "Asia/Shanghai",
		CalendarType:  CalendarSolar,
		RepeatType:    RepeatWeekly,
		RepeatConfig:  RepeatConfig{AnchorHour: 9, AnchorMinute: 0},
		AutoAdvance:   true,
		RemindOffsets: []RemindOffset{{Unit: "minute", Value: 0}},
		OverdueConfig: OverdueConfig{Enabled: true, IntervalUnit: "day", IntervalValue: 1, MaxCount: 2},
	})
	item.NextTriggerAt = ComputeNextTrigger(*item, map[string]struct{}{}, time.Time{})
	_, _ = store.UpdateItem(ctx, *item)

	// On-time (Dec 1 09:00): sends normal reminder, stays on Dec 1 waiting for overdue #1 (Dec 2 09:00)
	worker.nowFunc = func() time.Time { return time.Date(2026, 12, 1, 9, 0, 0, 0, loc) }
	worker.ProcessDueOnce(ctx)
	cur, _ := store.GetItem(ctx, 1, item.ID)
	if cur.TargetAt.In(loc).Format("2006-01-02") != "2026-12-01" {
		t.Fatalf("must NOT advance before overdue nags complete, got %v", cur.TargetAt.In(loc))
	}
	if cur.NextTriggerAt == nil || cur.NextTriggerAt.In(loc).Format("2006-01-02 15:04") != "2026-12-02 09:00" {
		t.Fatalf("expected overdue #1 scheduled for 2026-12-02 09:00, got %v", cur.NextTriggerAt)
	}

	// Overdue #1 (Dec 2 09:00)
	worker.nowFunc = func() time.Time { return time.Date(2026, 12, 2, 9, 0, 0, 0, loc) }
	worker.ProcessDueOnce(ctx)
	cur, _ = store.GetItem(ctx, 1, item.ID)
	if cur.TargetAt.In(loc).Format("2006-01-02") != "2026-12-01" {
		t.Fatalf("still waiting for overdue #2, got %v", cur.TargetAt.In(loc))
	}

	// Overdue #2 (Dec 3 09:00) -> limit reached -> auto-advances to Dec 8 09:00!
	worker.nowFunc = func() time.Time { return time.Date(2026, 12, 3, 9, 0, 0, 0, loc) }
	worker.ProcessDueOnce(ctx)
	cur, _ = store.GetItem(ctx, 1, item.ID)
	if len(notifier.sent) != 3 {
		t.Fatalf("expected 3 messages (1 on-time + 2 overdue), got %d", len(notifier.sent))
	}
	if cur.TargetAt.In(loc).Format("2006-01-02 15:04") != "2026-12-08 09:00" {
		t.Fatalf("expected auto-advance to 2026-12-08 09:00 after overdue limit, got %v", cur.TargetAt.In(loc))
	}
	skipLogs, _ := store.ListLogs(ctx, 1, LogStatusSkipped, 50)
	if len(skipLogs) != 1 || skipLogs[0].Reason != ReasonOverdueLimitReached {
		t.Fatalf("expected overdue_limit_reached log, got %+v", skipLogs)
	}
}

func TestPauseTimedAutoResumeAndIndefinitePause(t *testing.T) {
	store := newMemStore()
	notifier := &fakeNotifier{}
	worker := NewWakeupWorker(store, notifier, nil)
	svc := NewService(store, notifier, worker)
	ctx := context.Background()
	loc, _ := time.LoadLocation("Asia/Shanghai")

	target := time.Date(2026, 12, 1, 9, 0, 0, 0, loc).UTC()
	item, _ := store.CreateItem(ctx, ItemRecord{
		UserID:        1,
		Title:         "晨会提醒",
		Status:        StatusPending,
		TargetAt:      &target,
		Timezone:      "Asia/Shanghai",
		CalendarType:  CalendarSolar,
		RepeatType:    RepeatDaily,
		RepeatConfig:  RepeatConfig{AnchorHour: 9, AnchorMinute: 0},
		AutoAdvance:   true,
		RemindOffsets: []RemindOffset{{Unit: "minute", Value: 0}},
	})
	item.NextTriggerAt = ComputeNextTrigger(*item, map[string]struct{}{}, time.Time{})
	_, _ = store.UpdateItem(ctx, *item)

	// 1. Timed pause until Dec 2 10:00 (covers Dec 1 09:00 and Dec 2 09:00)
	resumeAt := time.Date(2026, 12, 2, 10, 0, 0, 0, loc).UTC()
	pausedView, err := svc.PauseItem(ctx, 1, item.ID, PauseItemInput{Until: &resumeAt})
	if err != nil {
		t.Fatalf("PauseItem timed: %v", err)
	}
	if !pausedView.Paused || pausedView.NextTriggerAt == nil || !pausedView.NextTriggerAt.Equal(resumeAt) {
		t.Fatalf("expected paused with next_trigger_at == paused_until, got %+v", pausedView)
	}

	// At Dec 1 09:00 -> still paused, must NOT send
	worker.nowFunc = func() time.Time { return time.Date(2026, 12, 1, 9, 0, 0, 0, loc) }
	worker.ProcessDueOnce(ctx)
	if len(notifier.sent) != 0 {
		t.Fatalf("must NOT send during pause, got %d", len(notifier.sent))
	}

	// At Dec 2 10:00 -> pause expires, auto-resumes, skips missed Dec 1 & Dec 2 without backfilling, schedules Dec 3 09:00
	worker.nowFunc = func() time.Time { return time.Date(2026, 12, 2, 10, 0, 0, 0, loc) }
	worker.ProcessDueOnce(ctx)
	if len(notifier.sent) != 0 {
		t.Fatalf("must NOT backfill missed reminders on resume, got %d", len(notifier.sent))
	}
	cur, _ := store.GetItem(ctx, 1, item.ID)
	if cur.Paused || cur.PausedUntil != nil {
		t.Fatalf("expected pause cleared after expiration, got paused=%v until=%v", cur.Paused, cur.PausedUntil)
	}
	if cur.NextTriggerAt == nil || cur.NextTriggerAt.In(loc).Format("2006-01-02 15:04") != "2026-12-03 09:00" {
		t.Fatalf("expected next trigger aligned to 2026-12-03 09:00, got %v", cur.NextTriggerAt)
	}
	skipLogs, _ := store.ListLogs(ctx, 1, LogStatusSkipped, 50)
	if len(skipLogs) == 0 || skipLogs[0].Reason != ReasonPaused {
		t.Fatalf("expected paused skip log, got %+v", skipLogs)
	}

	// 2. Indefinite pause sets next_trigger_at = nil until manual resume
	indefView, err := svc.PauseItem(ctx, 1, item.ID, PauseItemInput{Indefinite: true})
	if err != nil {
		t.Fatalf("PauseItem indefinite: %v", err)
	}
	if !indefView.Paused || indefView.PausedUntil != nil || indefView.NextTriggerAt != nil {
		t.Fatalf("expected indefinite pause with nil next_trigger_at, got %+v", indefView)
	}
	resumedView, err := svc.ResumeItem(ctx, 1, item.ID)
	if err != nil {
		t.Fatalf("ResumeItem: %v", err)
	}
	if resumedView.Paused || resumedView.NextTriggerAt == nil {
		t.Fatalf("expected resumed active item with future next_trigger_at, got %+v", resumedView)
	}
}
