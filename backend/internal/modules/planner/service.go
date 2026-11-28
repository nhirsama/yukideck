package planner

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/6tail/lunar-go/calendar"

	"yukideck/internal/core/auth"
	"yukideck/internal/core/httpx"
	"yukideck/internal/core/messenger"
)

type Service struct {
	store    Store
	notifier messenger.Notifier
	worker   *WakeupWorker
	nowFunc  func() time.Time
}

func NewService(store Store, notifier messenger.Notifier, worker *WakeupWorker) *Service {
	return &Service{store: store, notifier: notifier, worker: worker, nowFunc: time.Now}
}

func (s *Service) nowUTC() time.Time {
	if s.nowFunc != nil {
		return s.nowFunc().UTC()
	}
	return time.Now().UTC()
}

func (s *Service) ListItems(ctx context.Context, userID int64) ([]ItemView, error) {
	recs, err := s.store.ListItems(ctx, userID)
	if err != nil {
		return nil, httpx.Internal("查询日程列表失败", err)
	}
	out := make([]ItemView, 0, len(recs))
	for _, r := range recs {
		out = append(out, toItemView(r))
	}
	return out, nil
}

func (s *Service) ListCalendarEvents(ctx context.Context, userID int64, start, end time.Time) ([]CalendarEventView, error) {
	recs, err := s.store.ListItems(ctx, userID)
	if err != nil {
		return nil, httpx.Internal("查询日历事件失败", err)
	}
	events := make([]CalendarEventView, 0)
	for _, r := range recs {
		if r.TargetAt == nil {
			continue
		}
		occurrences := ProjectOccurrences(r, start, end)
		for idx, occ := range occurrences {
			events = append(events, CalendarEventView{
				ID:          fmt.Sprintf("%d-%d", r.ID, idx),
				ItemID:      r.ID,
				Title:       r.Title,
				Note:        r.Note,
				Status:      r.Status,
				Start:       occ,
				Calendar:    r.CalendarType,
				LunarLabel:  FormatLunarDate(occ, r.Timezone),
				RepeatType:  r.RepeatType,
				HasReminder: len(r.RemindOffsets) > 0 || r.OverdueConfig.Enabled,
			})
		}
	}
	return events, nil
}

func (s *Service) CreateItem(ctx context.Context, userID int64, in UpsertItemInput) (*ItemView, error) {
	if strings.TrimSpace(in.Timezone) == "" {
		in.Timezone = auth.UserTimezone(ctx)
	}
	rec, err := buildItemRecord(userID, 0, StatusPending, in, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	created, err := s.store.CreateItem(ctx, *rec)
	if err != nil {
		return nil, httpx.Internal("创建事项失败", err)
	}
	s.wakeup()
	v := toItemView(*created)
	return &v, nil
}

func (s *Service) UpdateItem(ctx context.Context, userID, id int64, in UpsertItemInput) (*ItemView, error) {
	existing, err := s.store.GetItem(ctx, userID, id)
	if err != nil {
		return nil, httpx.Internal("查询事项失败", err)
	}
	if existing == nil {
		return nil, httpx.NotFound("事项不存在")
	}
	if strings.TrimSpace(in.Timezone) == "" {
		if strings.TrimSpace(existing.Timezone) != "" {
			in.Timezone = existing.Timezone
		} else {
			in.Timezone = auth.UserTimezone(ctx)
		}
	}

	now := time.Now().UTC()
	rec, err := buildItemRecord(userID, id, existing.Status, in, now)
	if err != nil {
		return nil, err
	}

	// Preserve pause state if item still has target_at.
	if rec.TargetAt != nil && existing.Paused {
		rec.Paused = existing.Paused
		rec.PausedUntil = existing.PausedUntil
	}

	// Preserve active retry state only if target_at did not move and item is not paused.
	if existing.RetryState != nil && !rec.Paused && rec.TargetAt != nil && existing.TargetAt != nil && rec.TargetAt.Equal(*existing.TargetAt) {
		rec.RetryState = existing.RetryState
	}

	// Preserve settled dedup awareness when target_at did not move.
	settledKeys, err := s.store.ListSettledTriggerKeys(ctx, id)
	if err == nil && rec.Status == StatusPending {
		rec.NextTriggerAt = ComputeNextTrigger(*rec, settledKeys, now.Truncate(time.Minute))
	}

	updated, err := s.store.UpdateItem(ctx, *rec)
	if err != nil {
		return nil, httpx.Internal("更新事项失败", err)
	}
	if updated == nil {
		return nil, httpx.NotFound("事项不存在")
	}
	s.wakeup()
	v := toItemView(*updated)
	return &v, nil
}

func (s *Service) DeleteItem(ctx context.Context, userID, id int64) error {
	if err := s.store.DeleteItem(ctx, userID, id); err != nil {
		return httpx.Internal("删除事项失败", err)
	}
	s.wakeup()
	return nil
}

// CompleteItem marks a one-time item as done, OR advances a repeating item immediately to its next cycle.
func (s *Service) CompleteItem(ctx context.Context, userID, id int64) (*ItemView, error) {
	item, err := s.store.GetItem(ctx, userID, id)
	if err != nil {
		return nil, httpx.Internal("查询事项失败", err)
	}
	if item == nil {
		return nil, httpx.NotFound("事项不存在")
	}

	item.RetryState = nil
	item.Paused = false
	item.PausedUntil = nil

	if item.TargetAt != nil && item.RepeatType != RepeatNone && item.RepeatType != "" {
		nextTarget, ok, err := AdvanceTarget(*item.TargetAt, item.RepeatConfig, item.CalendarType, item.RepeatType, item.Timezone)
		if err != nil {
			return nil, httpx.BadRequest("推进下一周期失败: " + err.Error())
		}
		if ok {
			item.Status = StatusPending
			item.TargetAt = &nextTarget
			settledKeys, _ := s.store.ListSettledTriggerKeys(ctx, item.ID)
			item.NextTriggerAt = ComputeNextTrigger(*item, settledKeys, time.Now().UTC().Truncate(time.Minute))
		} else {
			item.Status = StatusDone
			item.NextTriggerAt = nil
		}
	} else {
		item.Status = StatusDone
		item.NextTriggerAt = nil
	}

	updated, err := s.store.UpdateItem(ctx, *item)
	if err != nil {
		return nil, httpx.Internal("更新事项状态失败", err)
	}
	s.wakeup()
	v := toItemView(*updated)
	return &v, nil
}

// FinishItem permanently marks any item (including recurring items) as done.
func (s *Service) FinishItem(ctx context.Context, userID, id int64) (*ItemView, error) {
	item, err := s.store.GetItem(ctx, userID, id)
	if err != nil {
		return nil, httpx.Internal("查询事项失败", err)
	}
	if item == nil {
		return nil, httpx.NotFound("事项不存在")
	}

	item.Status = StatusDone
	item.RetryState = nil
	item.Paused = false
	item.PausedUntil = nil
	item.NextTriggerAt = nil

	updated, err := s.store.UpdateItem(ctx, *item)
	if err != nil {
		return nil, httpx.Internal("标记事项完成失败", err)
	}
	s.wakeup()
	v := toItemView(*updated)
	return &v, nil
}

// AdvanceItemToCurrent fast-forwards an overdue recurring item straight to the earliest upcoming
// occurrence strictly after now while preserving original recurrence anchors.
func (s *Service) AdvanceItemToCurrent(ctx context.Context, userID, id int64) (*ItemView, error) {
	item, err := s.store.GetItem(ctx, userID, id)
	if err != nil {
		return nil, httpx.Internal("查询事项失败", err)
	}
	if item == nil {
		return nil, httpx.NotFound("事项不存在")
	}
	if item.Status != StatusPending {
		return nil, httpx.BadRequest("已完成的事项无法推进周期")
	}
	if item.TargetAt == nil || item.RepeatType == RepeatNone || item.RepeatType == "" {
		return nil, httpx.BadRequest("仅循环事项支持推进至当前周期")
	}

	now := s.nowUTC()
	if item.TargetAt.After(now) {
		return nil, httpx.BadRequest("当前事项尚未逾期，无需快速推进")
	}

	var nextTarget time.Time
	if item.RepeatType == RepeatCron {
		loc, tzName, err := LoadTimezone(item.Timezone)
		if err != nil {
			return nil, httpx.BadRequest(err.Error())
		}
		sched, err := parseCronWithTZ(item.RepeatConfig.CronExpr, tzName)
		if err != nil {
			return nil, httpx.BadRequest("Cron 表达式无效: " + err.Error())
		}
		nextTarget = sched.Next(now.In(loc)).UTC()
		if nextTarget.IsZero() {
			return nil, httpx.BadRequest("无法计算下一周期时间")
		}
	} else {
		cur := *item.TargetAt
		advanced := false
		for i := 0; i < 50000; i++ {
			cand, ok, err := AdvanceTarget(cur, item.RepeatConfig, item.CalendarType, item.RepeatType, item.Timezone)
			if err != nil {
				return nil, httpx.BadRequest("推进至当前周期失败: " + err.Error())
			}
			if !ok || !cand.After(cur) {
				break
			}
			cur = cand
			if cur.After(now) {
				nextTarget = cur
				advanced = true
				break
			}
		}
		if !advanced {
			return nil, httpx.BadRequest("无法推进至当前周期，请手动修改目标时间")
		}
	}

	item.Status = StatusPending
	item.TargetAt = &nextTarget
	item.RetryState = nil
	item.Paused = false
	item.PausedUntil = nil

	settledKeys, _ := s.store.ListSettledTriggerKeys(ctx, item.ID)
	item.NextTriggerAt = ComputeNextTrigger(*item, settledKeys, now.Truncate(time.Minute))

	updated, err := s.store.UpdateItem(ctx, *item)
	if err != nil {
		return nil, httpx.Internal("推进事项周期失败", err)
	}
	s.wakeup()
	v := toItemView(*updated)
	return &v, nil
}

func (s *Service) ReopenItem(ctx context.Context, userID, id int64) (*ItemView, error) {
	item, err := s.store.GetItem(ctx, userID, id)
	if err != nil {
		return nil, httpx.Internal("查询事项失败", err)
	}
	if item == nil {
		return nil, httpx.NotFound("事项不存在")
	}
	item.Status = StatusPending
	item.RetryState = nil
	item.Paused = false
	item.PausedUntil = nil
	settledKeys, _ := s.store.ListSettledTriggerKeys(ctx, item.ID)
	item.NextTriggerAt = ComputeNextTrigger(*item, settledKeys, time.Now().UTC().Truncate(time.Minute))

	updated, err := s.store.UpdateItem(ctx, *item)
	if err != nil {
		return nil, httpx.Internal("恢复事项失败", err)
	}
	s.wakeup()
	v := toItemView(*updated)
	return &v, nil
}

func (s *Service) PauseItem(ctx context.Context, userID, id int64, in PauseItemInput) (*ItemView, error) {
	item, err := s.store.GetItem(ctx, userID, id)
	if err != nil {
		return nil, httpx.Internal("查询事项失败", err)
	}
	if item == nil {
		return nil, httpx.NotFound("事项不存在")
	}
	if item.Status != StatusPending {
		return nil, httpx.BadRequest("已完成的事项无法暂停")
	}
	if item.TargetAt == nil {
		return nil, httpx.BadRequest("无目标时间的待办无需暂停通知")
	}

	now := time.Now().UTC()
	item.Paused = true
	item.RetryState = nil
	if in.Indefinite {
		item.PausedUntil = nil
		item.NextTriggerAt = nil
	} else {
		if in.Until == nil || !in.Until.After(now) {
			return nil, httpx.BadRequest("恢复时间必须晚于当前时间")
		}
		u := in.Until.UTC()
		item.PausedUntil = &u
		item.NextTriggerAt = &u
	}

	updated, err := s.store.UpdateItem(ctx, *item)
	if err != nil {
		return nil, httpx.Internal("暂停事项失败", err)
	}
	s.wakeup()
	v := toItemView(*updated)
	return &v, nil
}

func (s *Service) ResumeItem(ctx context.Context, userID, id int64) (*ItemView, error) {
	item, err := s.store.GetItem(ctx, userID, id)
	if err != nil {
		return nil, httpx.Internal("查询事项失败", err)
	}
	if item == nil {
		return nil, httpx.NotFound("事项不存在")
	}
	if !item.Paused {
		v := toItemView(*item)
		return &v, nil
	}

	resumed, err := resumePausedItem(ctx, s.store, *item, time.Now().UTC())
	if err != nil {
		return nil, httpx.Internal("恢复通知失败", err)
	}
	s.wakeup()
	v := toItemView(resumed)
	return &v, nil
}

func (s *Service) TestItem(ctx context.Context, userID, id int64) error {
	item, err := s.store.GetItem(ctx, userID, id)
	if err != nil {
		return httpx.Internal("查询事项失败", err)
	}
	if item == nil {
		return httpx.NotFound("事项不存在")
	}
	if s.notifier == nil {
		return httpx.Internal("消息中枢未初始化", nil)
	}
	msg := BuildReminderMessage(*item, "手动测试", EventReminder, time.Now().UTC())
	results, err := s.notifier.Send(ctx, userID, item.ChannelIDs, msg)
	if err != nil {
		return httpx.BadRequest("测试推送失败: " + err.Error())
	}
	for _, r := range results {
		if r.OK {
			return nil
		}
	}
	if len(results) > 0 && results[0].Error != "" {
		return httpx.BadRequest("测试推送失败: " + results[0].Error)
	}
	return httpx.BadRequest("测试推送失败")
}

func (s *Service) ListLogs(ctx context.Context, userID int64, status string, limit int) ([]LogRecord, error) {
	status = strings.ToLower(strings.TrimSpace(status))
	switch status {
	case "", LogStatusOK, LogStatusRetrying, LogStatusFailed, LogStatusSkipped:
	default:
		return nil, httpx.BadRequest("无效的日志状态筛选")
	}
	if limit <= 0 || limit > maxLogsPerUser {
		limit = maxLogsPerUser
	}
	logs, err := s.store.ListLogs(ctx, userID, status, limit)
	if err != nil {
		return nil, httpx.Internal("查询推送历史失败", err)
	}
	return logs, nil
}

func (s *Service) wakeup() {
	if s.worker != nil {
		s.worker.Wakeup()
	}
}

// --- Input parsing & normalization ---

func buildItemRecord(userID, id int64, status string, in UpsertItemInput, now time.Time) (*ItemRecord, error) {
	title := strings.TrimSpace(in.Title)
	if title == "" {
		return nil, httpx.BadRequest("标题不能为空")
	}
	loc, tzName, err := LoadTimezone(in.Timezone)
	if err != nil {
		return nil, httpx.BadRequest(err.Error())
	}

	calType := strings.ToLower(strings.TrimSpace(in.CalendarType))
	if calType == "" {
		calType = CalendarSolar
	}
	if calType != CalendarSolar && calType != CalendarLunar {
		return nil, httpx.BadRequest("calendar_type 仅支持 solar 或 lunar")
	}

	repeatType := strings.ToLower(strings.TrimSpace(in.RepeatType))
	if repeatType == "" {
		repeatType = RepeatNone
	}
	repeatCfg := in.RepeatConfig

	var targetAt *time.Time
	hasTarget := strings.TrimSpace(in.TargetLocal) != "" || in.LunarTarget != nil
	if hasTarget {
		if calType == CalendarLunar && in.LunarTarget != nil {
			lt := in.LunarTarget
			t, err := LunarToSolarTime(lt.Year, lt.Month, lt.Day, lt.IsLeap, lt.Hour, lt.Minute, loc)
			if err != nil {
				return nil, httpx.BadRequest(err.Error())
			}
			utc := t.UTC()
			targetAt = &utc
			repeatCfg.AnchorYear = lt.Year
			repeatCfg.AnchorMonth = lt.Month
			repeatCfg.AnchorDay = lt.Day
			repeatCfg.AnchorIsLeap = lt.IsLeap
			repeatCfg.AnchorHour = lt.Hour
			repeatCfg.AnchorMinute = lt.Minute
		} else {
			raw := strings.TrimSpace(in.TargetLocal)
			parsed, err := parseLocalDateTime(raw, loc)
			if err != nil {
				return nil, httpx.BadRequest("目标时间格式无效（需精确到分钟 YYYY-MM-DDTHH:MM）")
			}
			utc := parsed.UTC()
			targetAt = &utc
			if calType == CalendarLunar {
				sol := calendar.NewSolar(parsed.Year(), int(parsed.Month()), parsed.Day(), parsed.Hour(), parsed.Minute(), 0)
				lun := sol.GetLunar()
				m := lun.GetMonth()
				isLeap := m < 0
				if isLeap {
					m = -m
				}
				repeatCfg.AnchorYear = lun.GetYear()
				repeatCfg.AnchorMonth = m
				repeatCfg.AnchorDay = lun.GetDay()
				repeatCfg.AnchorIsLeap = isLeap
			} else {
				repeatCfg.AnchorYear = parsed.Year()
				repeatCfg.AnchorMonth = int(parsed.Month())
				repeatCfg.AnchorDay = parsed.Day()
				repeatCfg.AnchorIsLeap = false
			}
			repeatCfg.AnchorHour = parsed.Hour()
			repeatCfg.AnchorMinute = parsed.Minute()
		}
	} else if repeatType == RepeatCron {
		// Allow cron-only schedule without manual initial target_local: derive first target_at from cron.
		sched, err := parseCronWithTZ(repeatCfg.CronExpr, tzName)
		if err != nil {
			return nil, httpx.BadRequest("Cron 表达式无效: " + err.Error())
		}
		first := sched.Next(now.In(loc)).UTC()
		targetAt = &first
	} else {
		// Pure Todo without target_at: no recurrence or notification offsets
		repeatType = RepeatNone
		repeatCfg = RepeatConfig{}
	}

	if err := ValidateRepeat(repeatType, calType, tzName, repeatCfg); err != nil {
		return nil, httpx.BadRequest(err.Error())
	}

	offsets, err := NormalizeOffsets(in.RemindOffsets)
	if err != nil {
		return nil, httpx.BadRequest(err.Error())
	}
	if targetAt == nil {
		offsets = []RemindOffset{}
	}

	overdueCfg, err := NormalizeOverdueConfig(in.OverdueConfig, repeatType, calType, tzName, repeatCfg, targetAt)
	if err != nil {
		return nil, httpx.BadRequest(err.Error())
	}

	autoAdvance := true
	if in.AutoAdvance != nil {
		autoAdvance = *in.AutoAdvance
	}

	channelIDs := in.ChannelIDs
	if channelIDs == nil {
		channelIDs = []int64{}
	}

	rec := &ItemRecord{
		ID:            id,
		UserID:        userID,
		Title:         title,
		Note:          strings.TrimSpace(in.Note),
		Status:        status,
		TargetAt:      targetAt,
		Timezone:      tzName,
		CalendarType:  calType,
		RepeatType:    repeatType,
		RepeatConfig:  repeatCfg,
		AutoAdvance:   autoAdvance,
		RemindOffsets: offsets,
		OverdueConfig: overdueCfg,
		ChannelIDs:    channelIDs,
	}
	rec.NextTriggerAt = ComputeNextTrigger(*rec, map[string]struct{}{}, now.Truncate(time.Minute))
	return rec, nil
}

func parseLocalDateTime(raw string, loc *time.Location) (time.Time, error) {
	layouts := []string{
		"2006-01-02T15:04",
		"2006-01-02 15:04",
		"2006-01-02T15:04:05",
		time.RFC3339,
	}
	for _, layout := range layouts {
		if layout == time.RFC3339 {
			if t, err := time.Parse(layout, raw); err == nil {
				return t.In(loc).Truncate(time.Minute), nil
			}
			continue
		}
		if t, err := time.ParseInLocation(layout, raw, loc); err == nil {
			return t.Truncate(time.Minute), nil
		}
	}
	return time.Time{}, fmt.Errorf("cannot parse %q", raw)
}

func toItemView(r ItemRecord) ItemView {
	v := ItemView{
		ID:            r.ID,
		Title:         r.Title,
		Note:          r.Note,
		Status:        r.Status,
		TargetAt:      r.TargetAt,
		Timezone:      r.Timezone,
		CalendarType:  r.CalendarType,
		RepeatType:    r.RepeatType,
		RepeatConfig:  r.RepeatConfig,
		AutoAdvance:   r.AutoAdvance,
		RemindOffsets: r.RemindOffsets,
		OverdueConfig: r.OverdueConfig,
		Paused:        r.Paused,
		PausedUntil:   r.PausedUntil,
		RetryState:    r.RetryState,
		ChannelIDs:    r.ChannelIDs,
		NextTriggerAt: r.NextTriggerAt,
		CreatedAt:     r.CreatedAt,
		UpdatedAt:     r.UpdatedAt,
	}
	if r.TargetAt != nil {
		loc, _, err := LoadTimezone(r.Timezone)
		if err != nil {
			loc = time.UTC
		}
		lt := r.TargetAt.In(loc)
		v.TargetLocal = lt.Format("2006-01-02T15:04")
		v.LunarLabel = FormatLunarDate(lt, r.Timezone)
	}
	return v
}
