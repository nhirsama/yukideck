package planner

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/6tail/lunar-go/calendar"

	"yukideck/internal/core/httpx"
	"yukideck/internal/core/messenger"
)

type LunarDateInput struct {
	Year   int  `json:"year"`
	Month  int  `json:"month"`
	Day    int  `json:"day"`
	IsLeap bool `json:"is_leap"`
	Hour   int  `json:"hour"`
	Minute int  `json:"minute"`
}

type UpsertItemInput struct {
	Title         string          `json:"title"`
	Note          string          `json:"note"`
	TargetLocal   string          `json:"target_local"`   // "YYYY-MM-DDTHH:MM" (solar local wall-clock; optional)
	LunarTarget   *LunarDateInput `json:"lunar_target"`   // optional when calendar_type == "lunar"
	Timezone      string          `json:"timezone"`       // IANA timezone, default "Asia/Shanghai"
	CalendarType  string          `json:"calendar_type"`  // "solar" | "lunar"
	RepeatType    string          `json:"repeat_type"`    // none|daily|weekly|monthly|yearly|interval_days|cron
	RepeatConfig  RepeatConfig    `json:"repeat_config"`
	AutoAdvance   *bool           `json:"auto_advance"`
	RemindOffsets []RemindOffset  `json:"remind_offsets"`
	ChannelIDs    []int64         `json:"channel_ids"`
}

type ItemView struct {
	ID            int64          `json:"id"`
	Title         string         `json:"title"`
	Note          string         `json:"note"`
	Status        string         `json:"status"`
	TargetAt      *time.Time     `json:"target_at,omitempty"`
	TargetLocal   string         `json:"target_local,omitempty"`
	LunarLabel    string         `json:"lunar_label,omitempty"`
	Timezone      string         `json:"timezone"`
	CalendarType  string         `json:"calendar_type"`
	RepeatType    string         `json:"repeat_type"`
	RepeatConfig  RepeatConfig   `json:"repeat_config"`
	AutoAdvance   bool           `json:"auto_advance"`
	RemindOffsets []RemindOffset `json:"remind_offsets"`
	ChannelIDs    []int64        `json:"channel_ids"`
	NextTriggerAt *time.Time     `json:"next_trigger_at,omitempty"`
	CreatedAt     time.Time      `json:"created_at"`
	UpdatedAt     time.Time      `json:"updated_at"`
}

type CalendarEventView struct {
	ID          string    `json:"id"`
	ItemID      int64     `json:"item_id"`
	Title       string    `json:"title"`
	Note        string    `json:"note"`
	Status      string    `json:"status"`
	Start       time.Time `json:"start"`
	Calendar    string    `json:"calendar_type"`
	LunarLabel  string    `json:"lunar_label"`
	RepeatType  string    `json:"repeat_type"`
	HasReminder bool      `json:"has_reminder"`
}

type Service struct {
	store    Store
	notifier messenger.Notifier
	worker   *WakeupWorker
}

func NewService(store Store, notifier messenger.Notifier, worker *WakeupWorker) *Service {
	return &Service{store: store, notifier: notifier, worker: worker}
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
				HasReminder: len(r.RemindOffsets) > 0,
			})
		}
	}
	return events, nil
}

func (s *Service) CreateItem(ctx context.Context, userID int64, in UpsertItemInput) (*ItemView, error) {
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

	rec, err := buildItemRecord(userID, id, existing.Status, in, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	// Preserve dedup awareness against already-sent triggers if target_at did not move.
	sentKeys, err := s.store.ListSentTriggerKeys(ctx, id)
	if err == nil && rec.Status == StatusPending {
		rec.NextTriggerAt = ComputeNextTrigger(*rec, sentKeys, time.Now().UTC().Truncate(time.Minute))
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

	if item.TargetAt != nil && item.RepeatType != RepeatNone && item.RepeatType != "" {
		nextTarget, ok, err := AdvanceTarget(*item.TargetAt, item.RepeatConfig, item.CalendarType, item.RepeatType, item.Timezone)
		if err != nil {
			return nil, httpx.BadRequest("推进下一周期失败: " + err.Error())
		}
		if ok {
			item.Status = StatusPending
			item.TargetAt = &nextTarget
			sentKeys, _ := s.store.ListSentTriggerKeys(ctx, item.ID)
			item.NextTriggerAt = ComputeNextTrigger(*item, sentKeys, time.Now().UTC().Truncate(time.Minute))
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

func (s *Service) ReopenItem(ctx context.Context, userID, id int64) (*ItemView, error) {
	item, err := s.store.GetItem(ctx, userID, id)
	if err != nil {
		return nil, httpx.Internal("查询事项失败", err)
	}
	if item == nil {
		return nil, httpx.NotFound("事项不存在")
	}
	item.Status = StatusPending
	sentKeys, _ := s.store.ListSentTriggerKeys(ctx, item.ID)
	item.NextTriggerAt = ComputeNextTrigger(*item, sentKeys, time.Now().UTC().Truncate(time.Minute))

	updated, err := s.store.UpdateItem(ctx, *item)
	if err != nil {
		return nil, httpx.Internal("恢复事项失败", err)
	}
	s.wakeup()
	v := toItemView(*updated)
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
	msg := BuildReminderMessage(*item, "手动测试")
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

func (s *Service) ListLogs(ctx context.Context, userID int64) ([]LogRecord, error) {
	logs, err := s.store.ListLogs(ctx, userID, 50)
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
