package planner

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/6tail/lunar-go/calendar"
	"github.com/robfig/cron/v3"
)

const (
	CalendarSolar = "solar"
	CalendarLunar = "lunar"

	RepeatNone         = "none"
	RepeatDaily        = "daily"
	RepeatWeekly       = "weekly"
	RepeatMonthly      = "monthly"
	RepeatYearly       = "yearly"
	RepeatIntervalDays = "interval_days"
	RepeatCron         = "cron"

	StatusPending = "pending"
	StatusDone    = "done"
)

// RepeatConfig stores both recurrence settings and original wall-clock anchors
// so leap years, month-end clamping (31->28->31), lunar leap months, and DST never drift.
type RepeatConfig struct {
	AnchorYear   int    `json:"anchor_year,omitempty"`
	AnchorMonth  int    `json:"anchor_month,omitempty"`  // 1..12
	AnchorDay    int    `json:"anchor_day,omitempty"`    // 1..31 (lunar 1..30)
	AnchorIsLeap bool   `json:"anchor_is_leap,omitempty"` // lunar leap month flag
	AnchorHour   int    `json:"anchor_hour,omitempty"`   // 0..23
	AnchorMinute int    `json:"anchor_minute,omitempty"` // 0..59
	Weekdays     []int  `json:"weekdays,omitempty"`      // 0=Sun..6=Sat
	Interval     int    `json:"interval,omitempty"`      // for interval_days (>=1)
	CronExpr     string `json:"cron_expr,omitempty"`     // 5-field cron expression
}

// RemindOffset represents one notification point before (or at) target_at.
type RemindOffset struct {
	Unit  string `json:"unit"`  // "minute" | "hour" | "day"
	Value int    `json:"value"` // >=0; 0 means on-time
}

func (o RemindOffset) Key() string {
	if o.Value <= 0 {
		return "0m"
	}
	switch o.Unit {
	case "day":
		return fmt.Sprintf("-%dd", o.Value)
	case "hour":
		return fmt.Sprintf("-%dh", o.Value)
	default:
		return fmt.Sprintf("-%dm", o.Value)
	}
}

func (o RemindOffset) Label() string {
	if o.Value <= 0 {
		return "准点"
	}
	switch o.Unit {
	case "day":
		return fmt.Sprintf("提前 %d 天", o.Value)
	case "hour":
		return fmt.Sprintf("提前 %d 小时", o.Value)
	default:
		return fmt.Sprintf("提前 %d 分钟", o.Value)
	}
}

type TriggerPoint struct {
	TriggerAt    time.Time
	TriggerKey   string
	TriggerLabel string
	Offset       RemindOffset
}

var cronParser = cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)

func LoadTimezone(tz string) (*time.Location, string, error) {
	name := strings.TrimSpace(tz)
	if name == "" {
		name = "Asia/Shanghai"
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		return nil, "", fmt.Errorf("无效时区 %q: %w", name, err)
	}
	return loc, name, nil
}

func DaysInSolarMonth(year, month int) int {
	// Day 0 of next month equals the last day of `month`.
	return time.Date(year, time.Month(month+1), 0, 0, 0, 0, 0, time.UTC).Day()
}

func daysInLunarMonth(lunarYear, lunarMonth int, isLeap bool) (int, bool) {
	ly := calendar.NewLunarYear(lunarYear)
	m := lunarMonth
	if isLeap {
		m = -lunarMonth
	}
	lm := ly.GetMonth(m)
	if lm == nil {
		return 0, false
	}
	return lm.GetDayCount(), true
}

// LunarToSolarTime converts a lunar date (clamping day 30->29 on short months and handling missing leap months)
// into a wall-clock time.Time in `loc`.
func LunarToSolarTime(lunarYear, lunarMonth, lunarDay int, isLeap bool, hour, minute int, loc *time.Location) (time.Time, error) {
	if lunarYear < 1901 || lunarYear > 2099 {
		return time.Time{}, errors.New("农历年份仅支持 1901–2099")
	}
	if lunarMonth < 1 || lunarMonth > 12 || lunarDay < 1 || lunarDay > 30 {
		return time.Time{}, errors.New("农历月日无效")
	}

	dayCount, exists := daysInLunarMonth(lunarYear, lunarMonth, isLeap)
	useLeap := isLeap
	if !exists && isLeap {
		// Fallback to non-leap month when target year does not have that leap month.
		useLeap = false
		dayCount, exists = daysInLunarMonth(lunarYear, lunarMonth, false)
	}
	if !exists || dayCount <= 0 {
		return time.Time{}, fmt.Errorf("无效的农历月份 %d-%d", lunarYear, lunarMonth)
	}
	clampedDay := lunarDay
	if clampedDay > dayCount {
		clampedDay = dayCount
	}

	signedMonth := lunarMonth
	if useLeap {
		signedMonth = -lunarMonth
	}
	l := calendar.NewLunar(lunarYear, signedMonth, clampedDay, hour, minute, 0)
	s := l.GetSolar()
	return time.Date(s.GetYear(), time.Month(s.GetMonth()), s.GetDay(), hour, minute, 0, 0, loc), nil
}

// FormatLunarDate returns a concise Chinese lunar label for a UTC/local time in `tz`.
func FormatLunarDate(t time.Time, tz string) string {
	loc, _, err := LoadTimezone(tz)
	if err != nil {
		loc = time.UTC
	}
	lt := t.In(loc)
	s := calendar.NewSolar(lt.Year(), int(lt.Month()), lt.Day(), lt.Hour(), lt.Minute(), 0)
	l := s.GetLunar()
	return fmt.Sprintf("农历%s月%s", l.GetMonthInChinese(), l.GetDayInChinese())
}

// ValidateRepeat checks repeat_type & repeat_config consistency.
func ValidateRepeat(repeatType, calendarType, tz string, cfg RepeatConfig) error {
	switch repeatType {
	case RepeatNone, RepeatDaily, RepeatMonthly, RepeatYearly:
		return nil
	case RepeatWeekly:
		for _, wd := range cfg.Weekdays {
			if wd < 0 || wd > 6 {
				return errors.New("weekly 星期几范围必须为 0–6")
			}
		}
		return nil
	case RepeatIntervalDays:
		if cfg.Interval < 1 || cfg.Interval > 3650 {
			return errors.New("每隔 N 天的间隔需在 1–3650 之间")
		}
		return nil
	case RepeatCron:
		if calendarType == CalendarLunar {
			return errors.New("自定义 Cron 表达式仅支持公历模式")
		}
		expr := strings.TrimSpace(cfg.CronExpr)
		if expr == "" {
			return errors.New("请填写自定义 Cron 表达式")
		}
		if _, err := parseCronWithTZ(expr, tz); err != nil {
			return fmt.Errorf("Cron 表达式无效: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("不支持的周期类型: %s", repeatType)
	}
}

func parseCronWithTZ(expr, tz string) (cron.Schedule, error) {
	spec := strings.TrimSpace(expr)
	if tz != "" && !strings.HasPrefix(spec, "CRON_TZ=") && !strings.HasPrefix(spec, "TZ=") {
		spec = "CRON_TZ=" + tz + " " + spec
	}
	return cronParser.Parse(spec)
}

func NormalizeOffsets(in []RemindOffset) ([]RemindOffset, error) {
	if len(in) == 0 {
		return []RemindOffset{}, nil
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]RemindOffset, 0, len(in))
	for _, o := range in {
		unit := strings.ToLower(strings.TrimSpace(o.Unit))
		if unit == "" {
			unit = "minute"
		}
		if unit != "minute" && unit != "hour" && unit != "day" {
			return nil, fmt.Errorf("不支持的提前提醒单位: %s", o.Unit)
		}
		if o.Value < 0 || o.Value > 36500 {
			return nil, errors.New("提前提醒数值超出合理范围")
		}
		norm := RemindOffset{Unit: unit, Value: o.Value}
		if norm.Value == 0 {
			norm.Unit = "minute"
		}
		k := norm.Key()
		if _, dup := seen[k]; dup {
			continue
		}
		seen[k] = struct{}{}
		out = append(out, norm)
	}
	return out, nil
}

// ComputeTriggersForOccurrence calculates all sorted trigger timestamps for a single target_at occurrence.
// Day-based offsets use calendar AddDate in user's IANA timezone to preserve wall-clock HH:MM across DST.
// Hour/minute offsets subtract exact duration from target_at.
func ComputeTriggersForOccurrence(targetAt time.Time, tz string, offsets []RemindOffset) []TriggerPoint {
	if targetAt.IsZero() || len(offsets) == 0 {
		return nil
	}
	loc, _, err := LoadTimezone(tz)
	if err != nil {
		loc = time.UTC
	}
	localTarget := targetAt.In(loc).Truncate(time.Minute)
	occKey := localTarget.UTC().Format("20060102T1504Z")

	points := make([]TriggerPoint, 0, len(offsets))
	for _, o := range offsets {
		var triggerAt time.Time
		if o.Value <= 0 {
			triggerAt = localTarget
		} else {
			switch o.Unit {
			case "day":
				// Calendar subtraction preserves wall-clock HH:MM across DST transitions!
				d := localTarget.AddDate(0, 0, -o.Value)
				triggerAt = time.Date(d.Year(), d.Month(), d.Day(), localTarget.Hour(), localTarget.Minute(), 0, 0, loc)
			case "hour":
				triggerAt = localTarget.Add(-time.Duration(o.Value) * time.Hour)
			default:
				triggerAt = localTarget.Add(-time.Duration(o.Value) * time.Minute)
			}
		}
		utcAt := triggerAt.UTC().Truncate(time.Minute)
		points = append(points, TriggerPoint{
			TriggerAt:    utcAt,
			TriggerKey:   occKey + "|" + o.Key(),
			TriggerLabel: o.Label(),
			Offset:       o,
		})
	}

	sort.Slice(points, func(i, j int) bool {
		if !points[i].TriggerAt.Equal(points[j].TriggerAt) {
			return points[i].TriggerAt.Before(points[j].TriggerAt)
		}
		return points[i].TriggerKey < points[j].TriggerKey
	})
	return points
}

// AdvanceTarget computes the next occurrence after `currentTarget` using original anchors so
// leap years (Feb 29), month-ends (31st), lunar leap months, and DST transitions never drift.
func AdvanceTarget(currentTarget time.Time, cfg RepeatConfig, calType, repeatType, tz string) (time.Time, bool, error) {
	if currentTarget.IsZero() || repeatType == RepeatNone || repeatType == "" {
		return time.Time{}, false, nil
	}
	loc, tzName, err := LoadTimezone(tz)
	if err != nil {
		return time.Time{}, false, err
	}
	cur := currentTarget.In(loc)
	hour := cfg.AnchorHour
	minute := cfg.AnchorMinute
	if cfg.AnchorMonth == 0 && cfg.AnchorDay == 0 && hour == 0 && minute == 0 {
		hour = cur.Hour()
		minute = cur.Minute()
	}

	switch repeatType {
	case RepeatDaily:
		nextDate := cur.AddDate(0, 0, 1)
		return time.Date(nextDate.Year(), nextDate.Month(), nextDate.Day(), hour, minute, 0, 0, loc).UTC(), true, nil

	case RepeatIntervalDays:
		step := cfg.Interval
		if step < 1 {
			step = 1
		}
		nextDate := cur.AddDate(0, 0, step)
		return time.Date(nextDate.Year(), nextDate.Month(), nextDate.Day(), hour, minute, 0, 0, loc).UTC(), true, nil

	case RepeatWeekly:
		if len(cfg.Weekdays) == 0 {
			nextDate := cur.AddDate(0, 0, 7)
			return time.Date(nextDate.Year(), nextDate.Month(), nextDate.Day(), hour, minute, 0, 0, loc).UTC(), true, nil
		}
		wdSet := make(map[int]struct{}, len(cfg.Weekdays))
		for _, wd := range cfg.Weekdays {
			wdSet[wd] = struct{}{}
		}
		for delta := 1; delta <= 7; delta++ {
			cand := cur.AddDate(0, 0, delta)
			if _, ok := wdSet[int(cand.Weekday())]; ok {
				return time.Date(cand.Year(), cand.Month(), cand.Day(), hour, minute, 0, 0, loc).UTC(), true, nil
			}
		}
		return time.Time{}, false, nil

	case RepeatMonthly:
		if calType == CalendarLunar {
			s := calendar.NewSolar(cur.Year(), int(cur.Month()), cur.Day(), hour, minute, 0)
			l := s.GetLunar()
			ly := l.GetYear()
			lm := l.GetMonth()
			if lm < 0 {
				lm = -lm
			}
			lm++
			if lm > 12 {
				ly++
				lm = 1
			}
			anchorDay := cfg.AnchorDay
			if anchorDay <= 0 {
				anchorDay = l.GetDay()
			}
			nextT, err := LunarToSolarTime(ly, lm, anchorDay, false, hour, minute, loc)
			if err != nil {
				return time.Time{}, false, err
			}
			return nextT.UTC(), true, nil
		}
		// Solar monthly with anchor day clamping (31 -> Feb 28/29 -> Mar 31)
		y := cur.Year()
		m := int(cur.Month()) + 1
		if m > 12 {
			y++
			m = 1
		}
		anchorDay := cfg.AnchorDay
		if anchorDay <= 0 {
			anchorDay = cur.Day()
		}
		maxDay := DaysInSolarMonth(y, m)
		day := anchorDay
		if day > maxDay {
			day = maxDay
		}
		return time.Date(y, time.Month(m), day, hour, minute, 0, 0, loc).UTC(), true, nil

	case RepeatYearly:
		if calType == CalendarLunar {
			s := calendar.NewSolar(cur.Year(), int(cur.Month()), cur.Day(), hour, minute, 0)
			l := s.GetLunar()
			nextYear := l.GetYear() + 1
			anchorMonth := cfg.AnchorMonth
			if anchorMonth <= 0 {
				m := l.GetMonth()
				if m < 0 {
					m = -m
				}
				anchorMonth = m
			}
			anchorDay := cfg.AnchorDay
			if anchorDay <= 0 {
				anchorDay = l.GetDay()
			}
			nextT, err := LunarToSolarTime(nextYear, anchorMonth, anchorDay, cfg.AnchorIsLeap, hour, minute, loc)
			if err != nil {
				return time.Time{}, false, err
			}
			return nextT.UTC(), true, nil
		}
		// Solar yearly with anchor month/day clamping (2024-02-29 -> 2025-02-28 -> 2028-02-29)
		nextYear := cur.Year() + 1
		anchorMonth := cfg.AnchorMonth
		if anchorMonth <= 0 {
			anchorMonth = int(cur.Month())
		}
		anchorDay := cfg.AnchorDay
		if anchorDay <= 0 {
			anchorDay = cur.Day()
		}
		maxDay := DaysInSolarMonth(nextYear, anchorMonth)
		day := anchorDay
		if day > maxDay {
			day = maxDay
		}
		return time.Date(nextYear, time.Month(anchorMonth), day, hour, minute, 0, 0, loc).UTC(), true, nil

	case RepeatCron:
		sched, err := parseCronWithTZ(cfg.CronExpr, tzName)
		if err != nil {
			return time.Time{}, false, err
		}
		return sched.Next(cur).UTC(), true, nil

	default:
		return time.Time{}, false, nil
	}
}

// ComputeNextTrigger returns the earliest unsent TriggerPoint for an item's current target_at.
// If minTime is non-zero, triggers strictly earlier than minTime are skipped (used when saving a new/edited item).
func ComputeNextTrigger(item ItemRecord, sentKeys map[string]struct{}, minTime time.Time) *time.Time {
	if item.Status != StatusPending || item.TargetAt == nil || len(item.RemindOffsets) == 0 {
		return nil
	}
	points := ComputeTriggersForOccurrence(*item.TargetAt, item.Timezone, item.RemindOffsets)
	for _, p := range points {
		if _, sent := sentKeys[p.TriggerKey]; sent {
			continue
		}
		if !minTime.IsZero() && p.TriggerAt.Before(minTime) {
			continue
		}
		t := p.TriggerAt
		return &t
	}
	return nil
}

// ProjectOccurrences expands an item's target_at across [rangeStart, rangeEnd] for Calendar view rendering.
func ProjectOccurrences(item ItemRecord, rangeStart, rangeEnd time.Time) []time.Time {
	if item.TargetAt == nil {
		return nil
	}
	var out []time.Time
	cur := *item.TargetAt

	// Walk forward up to 120 occurrences (safe bound for daily/yearly over a calendar window).
	for i := 0; i < 120; i++ {
		if cur.After(rangeEnd) {
			break
		}
		if !cur.Before(rangeStart) && !cur.After(rangeEnd) {
			out = append(out, cur)
		}
		if item.RepeatType == RepeatNone || item.RepeatType == "" {
			break
		}
		next, ok, err := AdvanceTarget(cur, item.RepeatConfig, item.CalendarType, item.RepeatType, item.Timezone)
		if err != nil || !ok || !next.After(cur) {
			break
		}
		cur = next
	}
	return out
}
