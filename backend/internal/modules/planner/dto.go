package planner

import "time"

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
	Unit  string `json:"unit" tstype:"'minute' | 'hour' | 'day'"`
	Value int    `json:"value"` // >=0; 0 means on-time
}

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
	Note          string          `json:"note,omitempty"`
	TargetLocal   string          `json:"target_local,omitempty"` // "YYYY-MM-DDTHH:MM" (solar local wall-clock; optional)
	LunarTarget   *LunarDateInput `json:"lunar_target,omitempty"` // optional when calendar_type == "lunar"
	Timezone      string          `json:"timezone,omitempty"`     // IANA timezone, default "Asia/Shanghai"
	CalendarType  string          `json:"calendar_type,omitempty" tstype:"'solar' | 'lunar'"`
	RepeatType    string          `json:"repeat_type,omitempty" tstype:"'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'interval_days' | 'cron'"`
	RepeatConfig  RepeatConfig    `json:"repeat_config,omitempty"`
	AutoAdvance   *bool           `json:"auto_advance,omitempty"`
	RemindOffsets []RemindOffset  `json:"remind_offsets,omitempty"`
	ChannelIDs    []int64         `json:"channel_ids,omitempty"`
}

type ItemView struct {
	ID            int64          `json:"id"`
	Title         string         `json:"title"`
	Note          string         `json:"note"`
	Status        string         `json:"status" tstype:"'pending' | 'done'"`
	TargetAt      *time.Time     `json:"target_at,omitempty"`
	TargetLocal   string         `json:"target_local,omitempty"`
	LunarLabel    string         `json:"lunar_label,omitempty"`
	Timezone      string         `json:"timezone"`
	CalendarType  string         `json:"calendar_type" tstype:"'solar' | 'lunar'"`
	RepeatType    string         `json:"repeat_type" tstype:"'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'interval_days' | 'cron'"`
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
	Status      string    `json:"status" tstype:"'pending' | 'done'"`
	Start       time.Time `json:"start"`
	Calendar    string    `json:"calendar_type" tstype:"'solar' | 'lunar'"`
	LunarLabel  string    `json:"lunar_label"`
	RepeatType  string    `json:"repeat_type" tstype:"'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'interval_days' | 'cron'"`
	HasReminder bool      `json:"has_reminder"`
}

type LogRecord struct {
	ID           int64     `json:"id"`
	UserID       int64     `json:"-"`
	ItemID       *int64    `json:"item_id,omitempty"`
	ItemTitle    string    `json:"item_title"`
	TriggerKey   string    `json:"trigger_key"`
	TriggerLabel string    `json:"trigger_label"`
	Status       string    `json:"status" tstype:"'ok' | 'failed'"`
	Error        string    `json:"error,omitempty"`
	SentAt       time.Time `json:"sent_at"`
}
