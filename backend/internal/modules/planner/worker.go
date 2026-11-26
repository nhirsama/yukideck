package planner

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"yukideck/internal/core/httpx"
	"yukideck/internal/core/messenger"
)

const (
	missedGraceWindow = 15 * time.Minute
	maxLogsPerUser    = 200
)

var retryBackoffs = []time.Duration{
	1 * time.Minute,
	5 * time.Minute,
	15 * time.Minute,
}

// WakeupWorker implements a zero-polling, event-driven scheduler backed by a single Go time.Timer
// and PostgreSQL's partial B-Tree index on planner_items(next_trigger_at).
type WakeupWorker struct {
	store    Store
	notifier messenger.Notifier
	logger   *slog.Logger
	wakeCh   chan struct{}
	nowFunc  func() time.Time
}

func NewWakeupWorker(store Store, notifier messenger.Notifier, logger *slog.Logger) *WakeupWorker {
	return &WakeupWorker{
		store:    store,
		notifier: notifier,
		logger:   logger,
		wakeCh:   make(chan struct{}, 1),
		nowFunc:  time.Now,
	}
}

// Wakeup non-blockingly signals the scheduler goroutine to recompute the nearest wakeup time.
func (w *WakeupWorker) Wakeup() {
	select {
	case w.wakeCh <- struct{}{}:
	default:
	}
}

// Run executes the event-driven timer loop until ctx is canceled.
func (w *WakeupWorker) Run(ctx context.Context) {
	var timer *time.Timer
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()

	for {
		w.ProcessDueOnce(ctx)

		nextAt, err := w.store.MinNextTriggerAt(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if w.logger != nil {
				w.logger.Error("planner query next trigger failed", "err", err)
			}
			// Backoff briefly on transient DB errors before retrying
			next := w.nowFunc().Add(15 * time.Second)
			nextAt = &next
		}

		var timerC <-chan time.Time
		if nextAt != nil {
			wait := time.Until(*nextAt)
			if wait < 100*time.Millisecond {
				wait = 100 * time.Millisecond
			}
			if timer == nil {
				timer = time.NewTimer(wait)
			} else {
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(wait)
			}
			timerC = timer.C
		} else if timer != nil {
			// No future triggers exist: stop timer and sleep completely idle until wakeCh fires.
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timerC = nil
		}

		select {
		case <-ctx.Done():
			return
		case <-w.wakeCh:
		case <-timerC:
		}
	}
}

// ProcessDueOnce processes all items whose next_trigger_at <= now.
// Exposed for deterministic unit testing.
func (w *WakeupWorker) ProcessDueOnce(ctx context.Context) {
	now := w.nowFunc().UTC()
	items, err := w.store.ListDueItems(ctx, now)
	if err != nil {
		if ctx.Err() == nil && w.logger != nil {
			w.logger.Error("planner list due items failed", "err", err)
		}
		return
	}
	for _, item := range items {
		w.processItem(ctx, item, now)
	}
}

func (w *WakeupWorker) processItem(ctx context.Context, item ItemRecord, now time.Time) {
	// 1. Handle paused items (indefinite or timed pause expiration)
	if item.Paused {
		if item.PausedUntil == nil {
			item.NextTriggerAt = nil
			_, _ = w.store.UpdateItem(ctx, item)
			return
		}
		if item.PausedUntil.After(now) {
			u := item.PausedUntil.UTC()
			item.NextTriggerAt = &u
			_, _ = w.store.UpdateItem(ctx, item)
			return
		}
		// Timed pause expired: resume cleanly, skip missed triggers during pause without backfilling.
		resumed, err := resumePausedItem(ctx, w.store, item, now)
		if err != nil {
			if w.logger != nil {
				w.logger.Error("planner auto-resume paused item failed", "item_id", item.ID, "err", err)
			}
			return
		}
		item = resumed
		// If next_trigger_at is still in the future (or nil), we are done for this tick.
		if item.NextTriggerAt == nil || item.NextTriggerAt.After(now) {
			return
		}
	}

	if item.TargetAt == nil || (len(item.RemindOffsets) == 0 && !item.OverdueConfig.Enabled && item.RetryState == nil) {
		item.RetryState = nil
		item.NextTriggerAt = nil
		_, _ = w.store.UpdateItem(ctx, item)
		return
	}

	settledKeys, err := w.store.ListSettledTriggerKeys(ctx, item.ID)
	if err != nil {
		if w.logger != nil {
			w.logger.Error("planner load settled keys failed", "item_id", item.ID, "err", err)
		}
		return
	}

	// 2. Process pending retry backoff first (if any).
	if item.RetryState != nil {
		if _, settled := settledKeys[item.RetryState.TriggerKey]; settled {
			item.RetryState = nil
		} else if !item.RetryState.NextRetryAt.After(now) {
			// Check whether the next cycle has already arrived; if so, supersede old retry.
			if item.RepeatType != RepeatNone && item.RepeatType != "" {
				if nextTarget, ok, err := AdvanceTarget(*item.TargetAt, item.RepeatConfig, item.CalendarType, item.RepeatType, item.Timezone); err == nil && ok && !nextTarget.After(now) {
					itemID := item.ID
					_, _ = w.store.InsertSettledLogAndPrune(ctx, LogRecord{
						UserID:       item.UserID,
						ItemID:       &itemID,
						ItemTitle:    item.Title,
						TriggerKey:   item.RetryState.TriggerKey,
						TriggerLabel: item.RetryState.TriggerLabel,
						EventType:    item.RetryState.EventType,
						Status:       LogStatusSkipped,
						Reason:       ReasonCycleSuperseded,
						Attempt:      item.RetryState.Attempt,
						Error:        item.RetryState.LastError,
					}, maxLogsPerUser)
					settledKeys[item.RetryState.TriggerKey] = struct{}{}
					item.RetryState = nil
				}
			}

			if item.RetryState != nil {
				rs := *item.RetryState
				attempt := rs.Attempt + 1
				msg := BuildReminderMessage(item, rs.TriggerLabel, rs.EventType, now)
				outcome, reason, errMsg := w.deliver(ctx, item.UserID, item.ChannelIDs, msg)
				itemID := item.ID

				switch outcome {
				case LogStatusOK:
					_, _ = w.store.InsertSettledLogAndPrune(ctx, LogRecord{
						UserID:       item.UserID,
						ItemID:       &itemID,
						ItemTitle:    item.Title,
						TriggerKey:   rs.TriggerKey,
						TriggerLabel: rs.TriggerLabel,
						EventType:    rs.EventType,
						Status:       LogStatusOK,
						Reason:       reason,
						Attempt:      attempt,
						Error:        errMsg,
					}, maxLogsPerUser)
					settledKeys[rs.TriggerKey] = struct{}{}
					item.RetryState = nil

				case ReasonNoChannel:
					_, _ = w.store.InsertSettledLogAndPrune(ctx, LogRecord{
						UserID:       item.UserID,
						ItemID:       &itemID,
						ItemTitle:    item.Title,
						TriggerKey:   rs.TriggerKey,
						TriggerLabel: rs.TriggerLabel,
						EventType:    rs.EventType,
						Status:       LogStatusFailed,
						Reason:       ReasonNoChannel,
						Attempt:      attempt,
						Error:        errMsg,
					}, maxLogsPerUser)
					settledKeys[rs.TriggerKey] = struct{}{}
					item.RetryState = nil

				default:
					if rs.Attempt < len(retryBackoffs) {
						nextRetry := now.Add(retryBackoffs[rs.Attempt])
						rs.Attempt = attempt
						rs.NextRetryAt = nextRetry
						rs.LastError = errMsg
						item.RetryState = &rs
						_ = w.store.InsertAttemptLogAndPrune(ctx, LogRecord{
							UserID:       item.UserID,
							ItemID:       &itemID,
							ItemTitle:    item.Title,
							TriggerKey:   rs.TriggerKey,
							TriggerLabel: rs.TriggerLabel,
							EventType:    rs.EventType,
							Status:       LogStatusRetrying,
							Reason:       ReasonRetryScheduled,
							Attempt:      attempt,
							NextRetryAt:  &nextRetry,
							Error:        errMsg,
						}, maxLogsPerUser)
					} else {
						_, _ = w.store.InsertSettledLogAndPrune(ctx, LogRecord{
							UserID:       item.UserID,
							ItemID:       &itemID,
							ItemTitle:    item.Title,
							TriggerKey:   rs.TriggerKey,
							TriggerLabel: rs.TriggerLabel,
							EventType:    rs.EventType,
							Status:       LogStatusFailed,
							Reason:       ReasonRetryExhausted,
							Attempt:      attempt,
							Error:        errMsg,
						}, maxLogsPerUser)
						settledKeys[rs.TriggerKey] = struct{}{}
						item.RetryState = nil
					}
				}
			}
		}
	}

	// 3. Process due normal reminders (only when no active retry slot is occupied).
	if item.RetryState == nil {
		points := ComputeTriggersForOccurrence(*item.TargetAt, item.Timezone, item.RemindOffsets)
		for _, p := range points {
			if p.TriggerAt.After(now) {
				break
			}
			if _, settled := settledKeys[p.TriggerKey]; settled {
				continue
			}
			if w.dispatchTriggerPoint(ctx, &item, p, settledKeys, now) {
				// Entered retry backoff; pause further dispatches & cycle advancement until retry settles.
				break
			}
		}
	}

	// 4. Process due overdue nagging triggers (only when no active retry slot is occupied).
	if item.RetryState == nil && item.OverdueConfig.Enabled && now.After(*item.TargetAt) {
		overduePoints := ComputeOverdueTriggersForOccurrence(*item.TargetAt, item.Timezone, item.OverdueConfig)
		for _, p := range overduePoints {
			if p.TriggerAt.After(now) {
				break
			}
			if _, settled := settledKeys[p.TriggerKey]; settled {
				continue
			}
			if w.dispatchTriggerPoint(ctx, &item, p, settledKeys, now) {
				break
			}
		}

		// If all overdue points for this occurrence are now settled, record diagnostic limit-reached log once.
		if item.RetryState == nil && len(overduePoints) > 0 {
			allSettled := true
			for _, p := range overduePoints {
				if _, ok := settledKeys[p.TriggerKey]; !ok {
					allSettled = false
					break
				}
			}
			if allSettled {
				limitKey := OccurrenceKey(*item.TargetAt, item.Timezone) + "|overdue_limit"
				if _, already := settledKeys[limitKey]; !already {
					itemID := item.ID
					_, _ = w.store.InsertSettledLogAndPrune(ctx, LogRecord{
						UserID:       item.UserID,
						ItemID:       &itemID,
						ItemTitle:    item.Title,
						TriggerKey:   limitKey,
						TriggerLabel: fmt.Sprintf("逾期催办已达上限 (%d 次)", item.OverdueConfig.MaxCount),
						EventType:    EventOverdue,
						Status:       LogStatusSkipped,
						Reason:       ReasonOverdueLimitReached,
						Attempt:      1,
					}, maxLogsPerUser)
					settledKeys[limitKey] = struct{}{}
				}
			}
		}
	}

	// 5. Recompute next trigger; advance cycle only when no active retry and current cycle is completely done.
	nextTrigger := ComputeNextTrigger(item, settledKeys, time.Time{})
	if item.RetryState == nil && nextTrigger == nil && item.RepeatType != RepeatNone && item.RepeatType != "" && item.AutoAdvance {
		cur := *item.TargetAt
		for i := 0; i < 64; i++ {
			nextTarget, ok, err := AdvanceTarget(cur, item.RepeatConfig, item.CalendarType, item.RepeatType, item.Timezone)
			if err != nil || !ok || !nextTarget.After(cur) {
				break
			}
			cur = nextTarget
			item.TargetAt = &cur
			cand := ComputeNextTrigger(item, settledKeys, now)
			if cand != nil {
				nextTrigger = cand
				break
			}
		}
	}

	item.NextTriggerAt = nextTrigger
	if _, err := w.store.UpdateItem(ctx, item); err != nil && w.logger != nil {
		w.logger.Error("planner update item after trigger failed", "item_id", item.ID, "err", err)
	}
}

// dispatchTriggerPoint handles grace-window protection, single-item dispatch, and retry state initialization.
// Returns true if the trigger failed and entered retry backoff (stopping further dispatches in this tick).
func (w *WakeupWorker) dispatchTriggerPoint(ctx context.Context, item *ItemRecord, p TriggerPoint, settledKeys map[string]struct{}, now time.Time) bool {
	itemID := item.ID
	if now.Sub(p.TriggerAt) > missedGraceWindow {
		_, _ = w.store.InsertSettledLogAndPrune(ctx, LogRecord{
			UserID:       item.UserID,
			ItemID:       &itemID,
			ItemTitle:    item.Title,
			TriggerKey:   p.TriggerKey,
			TriggerLabel: p.TriggerLabel,
			EventType:    p.EventType,
			Status:       LogStatusSkipped,
			Reason:       ReasonMissedGraceWindow,
			Attempt:      1,
		}, maxLogsPerUser)
		settledKeys[p.TriggerKey] = struct{}{}
		return false
	}

	msg := BuildReminderMessage(*item, p.TriggerLabel, p.EventType, now)
	outcome, reason, errMsg := w.deliver(ctx, item.UserID, item.ChannelIDs, msg)

	switch outcome {
	case LogStatusOK:
		_, _ = w.store.InsertSettledLogAndPrune(ctx, LogRecord{
			UserID:       item.UserID,
			ItemID:       &itemID,
			ItemTitle:    item.Title,
			TriggerKey:   p.TriggerKey,
			TriggerLabel: p.TriggerLabel,
			EventType:    p.EventType,
			Status:       LogStatusOK,
			Reason:       reason,
			Attempt:      1,
			Error:        errMsg,
		}, maxLogsPerUser)
		settledKeys[p.TriggerKey] = struct{}{}
		return false

	case ReasonNoChannel:
		_, _ = w.store.InsertSettledLogAndPrune(ctx, LogRecord{
			UserID:       item.UserID,
			ItemID:       &itemID,
			ItemTitle:    item.Title,
			TriggerKey:   p.TriggerKey,
			TriggerLabel: p.TriggerLabel,
			EventType:    p.EventType,
			Status:       LogStatusFailed,
			Reason:       ReasonNoChannel,
			Attempt:      1,
			Error:        errMsg,
		}, maxLogsPerUser)
		settledKeys[p.TriggerKey] = struct{}{}
		return false

	default:
		nextRetry := now.Add(retryBackoffs[0])
		item.RetryState = &RetryState{
			TriggerKey:   p.TriggerKey,
			TriggerLabel: p.TriggerLabel,
			EventType:    p.EventType,
			OverdueIndex: p.OverdueIndex,
			Attempt:      1,
			NextRetryAt:  nextRetry,
			LastError:    errMsg,
		}
		_ = w.store.InsertAttemptLogAndPrune(ctx, LogRecord{
			UserID:       item.UserID,
			ItemID:       &itemID,
			ItemTitle:    item.Title,
			TriggerKey:   p.TriggerKey,
			TriggerLabel: p.TriggerLabel,
			EventType:    p.EventType,
			Status:       LogStatusRetrying,
			Reason:       ReasonRetryScheduled,
			Attempt:      1,
			NextRetryAt:  &nextRetry,
			Error:        errMsg,
		}, maxLogsPerUser)
		return true
	}
}

// resumePausedItem transitions a paused item back to active, logging skipped triggers during pause
// without backfilling, and advancing recurring items cleanly past cycles elapsed during pause.
func resumePausedItem(ctx context.Context, store Store, item ItemRecord, now time.Time) (ItemRecord, error) {
	settledKeys, err := store.ListSettledTriggerKeys(ctx, item.ID)
	if err != nil {
		return item, err
	}

	itemID := item.ID
	if item.TargetAt != nil {
		// Settle all triggers of current cycle that fell <= now during pause.
		for _, p := range ComputeTriggersForOccurrence(*item.TargetAt, item.Timezone, item.RemindOffsets) {
			if p.TriggerAt.After(now) {
				break
			}
			if _, ok := settledKeys[p.TriggerKey]; ok {
				continue
			}
			_, _ = store.InsertSettledLogAndPrune(ctx, LogRecord{
				UserID:       item.UserID,
				ItemID:       &itemID,
				ItemTitle:    item.Title,
				TriggerKey:   p.TriggerKey,
				TriggerLabel: p.TriggerLabel,
				EventType:    EventPause,
				Status:       LogStatusSkipped,
				Reason:       ReasonPaused,
				Attempt:      1,
			}, maxLogsPerUser)
			settledKeys[p.TriggerKey] = struct{}{}
		}
		if item.OverdueConfig.Enabled {
			for _, p := range ComputeOverdueTriggersForOccurrence(*item.TargetAt, item.Timezone, item.OverdueConfig) {
				if p.TriggerAt.After(now) {
					break
				}
				if _, ok := settledKeys[p.TriggerKey]; ok {
					continue
				}
				_, _ = store.InsertSettledLogAndPrune(ctx, LogRecord{
					UserID:       item.UserID,
					ItemID:       &itemID,
					ItemTitle:    item.Title,
					TriggerKey:   p.TriggerKey,
					TriggerLabel: p.TriggerLabel,
					EventType:    EventPause,
					Status:       LogStatusSkipped,
					Reason:       ReasonPaused,
					Attempt:      1,
				}, maxLogsPerUser)
				settledKeys[p.TriggerKey] = struct{}{}
			}
		}
	}

	item.Paused = false
	item.PausedUntil = nil
	item.RetryState = nil

	// Compute next upcoming trigger strictly after now; if recurring cycle fully elapsed while paused, advance cleanly.
	minTime := now.Truncate(time.Minute).Add(time.Minute)
	nextTrigger := ComputeNextTrigger(item, settledKeys, minTime)
	if nextTrigger == nil && item.TargetAt != nil && item.RepeatType != RepeatNone && item.RepeatType != "" && item.AutoAdvance {
		cur := *item.TargetAt
		skippedCycles := 0
		for i := 0; i < 512; i++ {
			nextTarget, ok, err := AdvanceTarget(cur, item.RepeatConfig, item.CalendarType, item.RepeatType, item.Timezone)
			if err != nil || !ok || !nextTarget.After(cur) {
				break
			}
			cur = nextTarget
			item.TargetAt = &cur
			cand := ComputeNextTrigger(item, settledKeys, minTime)
			if cand != nil {
				nextTrigger = cand
				break
			}
			skippedCycles++
		}
		if skippedCycles > 0 {
			key := fmt.Sprintf("pause_skip|%s", now.UTC().Format("20060102T150405Z"))
			_, _ = store.InsertSettledLogAndPrune(ctx, LogRecord{
				UserID:       item.UserID,
				ItemID:       &itemID,
				ItemTitle:    item.Title,
				TriggerKey:   key,
				TriggerLabel: fmt.Sprintf("暂停期间跳过 %d 个周期", skippedCycles),
				EventType:    EventPause,
				Status:       LogStatusSkipped,
				Reason:       ReasonPaused,
				Attempt:      1,
			}, maxLogsPerUser)
		}
	}

	item.NextTriggerAt = nextTrigger
	updated, err := store.UpdateItem(ctx, item)
	if err != nil {
		return item, err
	}
	if updated != nil {
		return *updated, nil
	}
	return item, nil
}

// deliver sends the message and classifies the outcome into LogStatusOK, ReasonNoChannel, or LogStatusFailed.
func (w *WakeupWorker) deliver(ctx context.Context, userID int64, channelIDs []int64, msg messenger.Message) (string, string, string) {
	if w.notifier == nil {
		return ReasonNoChannel, ReasonNoChannel, "消息中枢未初始化"
	}
	results, err := w.notifier.Send(ctx, userID, channelIDs, msg)
	if err != nil {
		var appErr *httpx.AppError
		if (errors.As(err, &appErr) && appErr.Status == http.StatusBadRequest) ||
			strings.Contains(err.Error(), "未找到可用的出站推送渠道") {
			return ReasonNoChannel, ReasonNoChannel, err.Error()
		}
		return LogStatusFailed, "", err.Error()
	}
	var errs []string
	anyOK := false
	for _, r := range results {
		if r.OK {
			anyOK = true
		} else if r.Error != "" {
			errs = append(errs, fmt.Sprintf("%s: %s", r.ChannelName, r.Error))
		}
	}
	if anyOK && len(errs) == 0 {
		return LogStatusOK, "", ""
	}
	if anyOK {
		return LogStatusOK, ReasonPartialChannelFailure, "部分渠道失败: " + strings.Join(errs, "; ")
	}
	if len(errs) == 0 {
		return LogStatusFailed, "", "推送渠道返回未知错误"
	}
	return LogStatusFailed, "", strings.Join(errs, "; ")
}

func formatOverdueElapsed(d time.Duration) string {
	if d < time.Minute {
		return "不足 1 分钟"
	}
	totalMins := int(d / time.Minute)
	days := totalMins / (24 * 60)
	hours := (totalMins % (24 * 60)) / 60
	mins := totalMins % 60
	if days > 0 {
		if hours > 0 {
			return fmt.Sprintf("%d 天 %d 小时", days, hours)
		}
		return fmt.Sprintf("%d 天", days)
	}
	if hours > 0 {
		if mins > 0 {
			return fmt.Sprintf("%d 小时 %d 分钟", hours, mins)
		}
		return fmt.Sprintf("%d 小时", hours)
	}
	return fmt.Sprintf("%d 分钟", mins)
}

func BuildReminderMessage(item ItemRecord, triggerLabel, eventType string, now time.Time) messenger.Message {
	title := item.Title
	if eventType == EventOverdue {
		overdueSuffix := ""
		if item.TargetAt != nil && now.After(*item.TargetAt) {
			overdueSuffix = fmt.Sprintf("（已逾期 %s）", formatOverdueElapsed(now.Sub(*item.TargetAt)))
		}
		if triggerLabel != "" {
			title = fmt.Sprintf("[%s] %s%s", triggerLabel, item.Title, overdueSuffix)
		} else {
			title = fmt.Sprintf("[逾期催办] %s%s", item.Title, overdueSuffix)
		}
	} else if triggerLabel != "" {
		title = fmt.Sprintf("%s（%s）", item.Title, triggerLabel)
	}

	var lines []string
	if item.TargetAt != nil {
		loc, _, err := LoadTimezone(item.Timezone)
		if err != nil {
			loc = time.UTC
		}
		lt := item.TargetAt.In(loc)
		timeLine := "目标时间：" + lt.Format("2006-01-02 15:04")
		if item.CalendarType == CalendarLunar {
			timeLine += "（" + FormatLunarDate(lt, item.Timezone) + "）"
		}
		lines = append(lines, timeLine)
	}
	if strings.TrimSpace(item.Note) != "" {
		lines = append(lines, "备注："+strings.TrimSpace(item.Note))
	}
	content := strings.Join(lines, "\n")
	if content == "" {
		content = item.Title
	}
	return messenger.Message{
		Title:   title,
		Content: content,
	}
}
