package screen_time

import "time"

type ConfigView struct {
	Configured          bool       `json:"configured"`
	APIBaseURL          string     `json:"api_base_url"`
	APIKeyHint          string     `json:"api_key_hint"`
	WakaTimeUsername    string     `json:"wakatime_username"`
	TimeoutMinutes      int        `json:"timeout_minutes"`
	HistoryImportedAt   *time.Time `json:"history_imported_at,omitempty"`
	LastSyncedAt        *time.Time `json:"last_synced_at,omitempty"`
	LastSyncedDate      string     `json:"last_synced_date,omitempty"`
	LastSyncStatus      string     `json:"last_sync_status" tstype:"'idle' | 'ok' | 'auth_error' | 'error'"`
	LastSyncError       string     `json:"last_sync_error"`
	NextScheduledSyncAt *time.Time `json:"next_scheduled_sync_at,omitempty"`
}

type HistoryImportStatus struct {
	Running            bool       `json:"running"`
	Mode               string     `json:"mode" tstype:"'' | 'full' | 'gap'"`
	Stage              string     `json:"stage" tstype:"'idle' | 'requesting' | 'exporting' | 'downloading' | 'finalizing' | 'completed' | 'failed'"`
	Percent            float64    `json:"percent"`
	ExportPercent      float64    `json:"export_percent"`
	Message            string     `json:"message"`
	DaysProcessed      int        `json:"days_processed"`
	DaysImported       int        `json:"days_imported"`
	DaysSkipped        int        `json:"days_skipped"`
	HeartbeatsImported int64      `json:"heartbeats_imported"`
	BytesDownloaded    int64      `json:"bytes_downloaded"`
	TotalBytes         int64      `json:"total_bytes"`
	StartedAt          *time.Time `json:"started_at,omitempty"`
	FinishedAt         *time.Time `json:"finished_at,omitempty"`
	Error              string     `json:"error,omitempty"`
}

type UpdateConfigInput struct {
	APIBaseURL  string `json:"api_base_url"`
	APIKey      string `json:"api_key,omitempty"`
	ClearAPIKey bool   `json:"clear_api_key,omitempty"`
}

type TestConfigInput struct {
	APIBaseURL string `json:"api_base_url,omitempty"`
	APIKey     string `json:"api_key,omitempty"`
}

type TestConfigResponse struct {
	OK       bool   `json:"ok"`
	Username string `json:"username"`
	Timezone string `json:"timezone"`
	Plan     string `json:"plan"`
}

type SyncResponse struct {
	Synced         bool       `json:"synced"`
	Skipped        bool       `json:"skipped"`
	Reason         string     `json:"reason,omitempty"`
	DaysSynced     int        `json:"days_synced"`
	StartDate      string     `json:"start_date,omitempty"`
	EndDate        string     `json:"end_date,omitempty"`
	LastSyncedAt   *time.Time `json:"last_synced_at,omitempty"`
	LastSyncStatus string     `json:"last_sync_status" tstype:"'idle' | 'ok' | 'auth_error' | 'error'"`
	LastSyncError  string     `json:"last_sync_error,omitempty"`
}

type BreakdownItem struct {
	Name         string  `json:"name"`
	TotalSeconds float64 `json:"total_seconds"`
	Percent      float64 `json:"percent"`
}

type BestDayView struct {
	Date         string  `json:"date"`
	TotalSeconds float64 `json:"total_seconds"`
}

type SummaryResponse struct {
	Configured            bool           `json:"configured"`
	StartDate             string         `json:"start_date"`
	EndDate               string         `json:"end_date"`
	Timezone              string         `json:"timezone"`
	TotalSeconds          float64        `json:"total_seconds"`
	PreviousTotalSeconds  float64        `json:"previous_total_seconds"`
	ActiveDays            int            `json:"active_days"`
	TotalDays             int            `json:"total_days"`
	DailyAvgActiveSeconds float64        `json:"daily_avg_active_seconds"`
	DailyAvgAllSeconds    float64        `json:"daily_avg_all_seconds"`
	CurrentStreakDays     int            `json:"current_streak_days"`
	LongestStreakDays     int            `json:"longest_streak_days"`
	BestDay               *BestDayView   `json:"best_day,omitempty"`
	TopProject            *BreakdownItem `json:"top_project,omitempty"`
	TopLanguage           *BreakdownItem `json:"top_language,omitempty"`
	TopEditor             *BreakdownItem `json:"top_editor,omitempty"`
	WakaTimeUsername      string         `json:"wakatime_username"`
	LastSyncedAt          *time.Time     `json:"last_synced_at,omitempty"`
	LastSyncStatus        string         `json:"last_sync_status" tstype:"'idle' | 'ok' | 'auth_error' | 'error'"`
	LastSyncError         string         `json:"last_sync_error"`
}

type TrendPoint struct {
	Bucket       string             `json:"bucket"`
	Label        string             `json:"label"`
	TotalSeconds float64            `json:"total_seconds"`
	Series       map[string]float64 `json:"series"`
}

type TrendsResponse struct {
	Granularity string       `json:"granularity" tstype:"'day' | 'week' | 'month'"`
	GroupBy     string       `json:"group_by" tstype:"'total' | 'project' | 'language' | 'editor' | 'category' | 'os' | 'machine'"`
	SeriesKeys  []string     `json:"series_keys"`
	Points      []TrendPoint `json:"points"`
}

type HeatmapDay struct {
	Date         string  `json:"date"`
	TotalSeconds float64 `json:"total_seconds"`
	Level        int     `json:"level"`
}

type HeatmapResponse struct {
	StartDate      string       `json:"start_date"`
	EndDate        string       `json:"end_date"`
	Year           int          `json:"year,omitempty"`
	AvailableYears []int        `json:"available_years"`
	TotalSeconds   float64      `json:"total_seconds"`
	ActiveDays     int          `json:"active_days"`
	MaxSeconds     float64      `json:"max_seconds"`
	Days           []HeatmapDay `json:"days"`
}

type BreakdownsResponse struct {
	StartDate        string          `json:"start_date"`
	EndDate          string          `json:"end_date"`
	TotalSeconds     float64         `json:"total_seconds"`
	Projects         []BreakdownItem `json:"projects"`
	Languages        []BreakdownItem `json:"languages"`
	Editors          []BreakdownItem `json:"editors"`
	OperatingSystems []BreakdownItem `json:"operating_systems"`
	Categories       []BreakdownItem `json:"categories"`
	Machines         []BreakdownItem `json:"machines"`
}

type HourOfDayItem struct {
	Hour         int     `json:"hour"`
	TotalSeconds float64 `json:"total_seconds"`
	AvgSeconds   float64 `json:"avg_seconds"`
}

type HourlyResponse struct {
	StartDate  string          `json:"start_date"`
	EndDate    string          `json:"end_date"`
	Timezone   string          `json:"timezone"`
	ActiveDays int             `json:"active_days"`
	Hours      []HourOfDayItem `json:"hours"`
}

type TimelineBlock struct {
	StartedAt       time.Time `json:"started_at"`
	EndedAt         time.Time `json:"ended_at"`
	StartMinute     float64   `json:"start_minute"`
	EndMinute       float64   `json:"end_minute"`
	DurationSeconds float64   `json:"duration_seconds"`
	Project         string    `json:"project"`
	Color           string    `json:"color"`
}

type TimelineResponse struct {
	Date         string          `json:"date"`
	Timezone     string          `json:"timezone"`
	TotalSeconds float64         `json:"total_seconds"`
	Projects     []BreakdownItem `json:"projects"`
	Blocks       []TimelineBlock `json:"blocks"`
}
