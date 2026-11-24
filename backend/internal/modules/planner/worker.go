package planner

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"yukideck/internal/core/messenger"
)

const (
	missedGraceWindow = 15 * time.Minute
	maxLogsPerUser    = 100
)

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
	if item.TargetAt == nil || len(item.RemindOffsets) == 0 {
		item.NextTriggerAt = nil
		_, _ = w.store.UpdateItem(ctx, item)
		return
	}

	sentKeys, err := w.store.ListSentTriggerKeys(ctx, item.ID)
	if err != nil {
		if w.logger != nil {
			w.logger.Error("planner load sent keys failed", "item_id", item.ID, "err", err)
		}
		return
	}

	points := ComputeTriggersForOccurrence(*item.TargetAt, item.Timezone, item.RemindOffsets)
	for _, p := range points {
		if p.TriggerAt.After(now) {
			break
		}
		if _, already := sentKeys[p.TriggerKey]; already {
			continue
		}

		// Stale trigger protection: if server was down longer than missedGraceWindow, skip spamming old alerts.
		if now.Sub(p.TriggerAt) > missedGraceWindow {
			sentKeys[p.TriggerKey] = struct{}{}
			continue
		}

		// Send one individual message per triggered reminder (user preference: complete -> delete message).
		msg := BuildReminderMessage(item, p.TriggerLabel)
		status, errMsg := w.deliver(ctx, item.UserID, item.ChannelIDs, msg)

		itemID := item.ID
		_, _ = w.store.InsertLogAndPrune(ctx, LogRecord{
			UserID:       item.UserID,
			ItemID:       &itemID,
			ItemTitle:    item.Title,
			TriggerKey:   p.TriggerKey,
			TriggerLabel: p.TriggerLabel,
			Status:       status,
			Error:        errMsg,
		}, maxLogsPerUser)
		sentKeys[p.TriggerKey] = struct{}{}
	}

	// Determine next pending trigger for current occurrence.
	nextTrigger := ComputeNextTrigger(item, sentKeys, time.Time{})
	if nextTrigger == nil && item.RepeatType != RepeatNone && item.RepeatType != "" && item.AutoAdvance {
		// Current cycle finished: advance target_at to the next cycle using original anchors.
		cur := *item.TargetAt
		for i := 0; i < 64; i++ {
			nextTarget, ok, err := AdvanceTarget(cur, item.RepeatConfig, item.CalendarType, item.RepeatType, item.Timezone)
			if err != nil || !ok || !nextTarget.After(cur) {
				break
			}
			cur = nextTarget
			item.TargetAt = &cur
			cand := ComputeNextTrigger(item, sentKeys, now)
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

func (w *WakeupWorker) deliver(ctx context.Context, userID int64, channelIDs []int64, msg messenger.Message) (string, string) {
	if w.notifier == nil {
		return "failed", "消息中枢未初始化"
	}
	results, err := w.notifier.Send(ctx, userID, channelIDs, msg)
	if err != nil {
		return "failed", err.Error()
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
		return "ok", ""
	}
	if anyOK {
		return "ok", "部分渠道失败: " + strings.Join(errs, "; ")
	}
	return "failed", strings.Join(errs, "; ")
}

func BuildReminderMessage(item ItemRecord, triggerLabel string) messenger.Message {
	title := item.Title
	if triggerLabel != "" {
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
