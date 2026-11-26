package ai_usage

import "time"

// IngestDevice describes the collector host reporting slices.
type IngestDevice struct {
	DeviceID         string `json:"device_id"`
	Name             string `json:"name,omitempty"`
	OS               string `json:"os,omitempty"`
	Arch             string `json:"arch,omitempty"`
	Hostname         string `json:"hostname,omitempty"`
	CollectorVersion string `json:"collector_version,omitempty"`
}

// IngestSlice represents one (device, agent, session, hour, model, is_subagent) usage snapshot.
type IngestSlice struct {
	Agent              string           `json:"agent"`
	SessionID          string           `json:"session_id"`
	HourBucket         time.Time        `json:"hour_bucket"`
	Model              string           `json:"model"`
	IsSubagent         bool             `json:"is_subagent,omitempty"`
	ParentSessionID    string           `json:"parent_session_id,omitempty"`
	Provider           string           `json:"provider,omitempty"`
	Project            string           `json:"project,omitempty"`
	InputTokens        int64            `json:"input_tokens"`
	OutputTokens       int64            `json:"output_tokens"`
	CacheReadTokens    int64            `json:"cache_read_tokens"`
	CacheWriteTokens   int64            `json:"cache_write_tokens"`
	CacheWrite1hTokens int64            `json:"cache_write_1h_tokens"`
	ReasoningTokens    int64            `json:"reasoning_tokens"`
	MaxContextTokens   int64            `json:"max_context_tokens"`
	ReportedCostUSD    float64          `json:"reported_cost_usd"`
	RequestCount       int32            `json:"request_count"`
	ToolCallCount      int32            `json:"tool_call_count"`
	ToolCalls          map[string]int32 `json:"tool_calls,omitempty"`
	FirstEventAt       time.Time        `json:"first_event_at"`
	LastEventAt        time.Time        `json:"last_event_at"`
}

type IngestRequest struct {
	Device         IngestDevice  `json:"device"`
	ForceOverwrite bool          `json:"force_overwrite,omitempty"`
	Slices         []IngestSlice `json:"slices"`
}

type IngestResponse struct {
	Accepted int    `json:"accepted"`
	DeviceID string `json:"device_id"`
}

type TokenTotals struct {
	InputTokens        int64 `json:"input_tokens"`
	OutputTokens       int64 `json:"output_tokens"`
	CacheReadTokens    int64 `json:"cache_read_tokens"`
	CacheWriteTokens   int64 `json:"cache_write_tokens"`
	CacheWrite1hTokens int64 `json:"cache_write_1h_tokens"`
	ReasoningTokens    int64 `json:"reasoning_tokens"`
	TotalTokens        int64 `json:"total_tokens"`
}

type BreakdownItem struct {
	Key             string   `json:"key"`
	Label           string   `json:"label"`
	TotalTokens     int64    `json:"total_tokens"`
	InputTokens     int64    `json:"input_tokens"`
	OutputTokens    int64    `json:"output_tokens"`
	CacheReadTokens int64    `json:"cache_read_tokens"`
	CostUSD         float64  `json:"cost_usd"`
	RequestCount    int64    `json:"request_count"`
	ToolCallCount   int64    `json:"tool_call_count"`
	SessionCount    int      `json:"session_count"`
	MergedRawModels []string `json:"merged_raw_models,omitempty"`
}

type HourOfDayItem struct {
	Hour         int     `json:"hour"`
	TotalTokens  int64   `json:"total_tokens"`
	CostUSD      float64 `json:"cost_usd"`
	RequestCount int64   `json:"request_count"`
}

type FilterOptions struct {
	Agents   []string `json:"agents"`
	Models   []string `json:"models"`
	Projects []string `json:"projects"`
	Devices  []Device `json:"devices"`
}

type SummaryResponse struct {
	Tokens             TokenTotals     `json:"tokens"`
	CostUSD            float64         `json:"cost_usd"`
	CacheSavingsUSD    float64         `json:"cache_savings_usd"`
	CacheHitRate       float64         `json:"cache_hit_rate"`
	RequestCount       int64           `json:"request_count"`
	ToolCallCount      int64           `json:"tool_call_count"`
	MaxContextTokens   int64           `json:"max_context_tokens"`
	ActiveDays         int             `json:"active_days"`
	SessionCount       int             `json:"session_count"`
	SubagentTokens     int64           `json:"subagent_tokens"`
	SubagentCostUSD    float64         `json:"subagent_cost_usd"`
	ByAgent            []BreakdownItem `json:"by_agent"`
	ByModel            []BreakdownItem `json:"by_model"`
	ByDevice           []BreakdownItem `json:"by_device"`
	ByProject          []BreakdownItem `json:"by_project"`
	ByHourOfDay        []HourOfDayItem `json:"by_hour_of_day"`
	Filters            FilterOptions   `json:"filters"`
}

type TrendSeriesValue struct {
	TotalTokens int64   `json:"total_tokens"`
	CostUSD     float64 `json:"cost_usd"`
}

type TrendPoint struct {
	Bucket       string                      `json:"bucket"`
	TotalTokens  int64                       `json:"total_tokens"`
	CostUSD      float64                     `json:"cost_usd"`
	RequestCount int64                       `json:"request_count"`
	Series       map[string]TrendSeriesValue `json:"series"`
}

type TrendsResponse struct {
	Granularity string       `json:"granularity"`
	GroupBy     string       `json:"group_by"`
	SeriesKeys  []string     `json:"series_keys"`
	Points      []TrendPoint `json:"points"`
}

type HeatmapDay struct {
	Date         string  `json:"date"`
	TotalTokens  int64   `json:"total_tokens"`
	CostUSD      float64 `json:"cost_usd"`
	RequestCount int64   `json:"request_count"`
	SessionCount int     `json:"session_count"`
	Level        int     `json:"level"`
}

type HeatmapResponse struct {
	Timezone string       `json:"timezone"`
	Days     []HeatmapDay `json:"days"`
}

type SessionSummary struct {
	SessionID        string              `json:"session_id"`
	DeviceID         string              `json:"device_id"`
	DeviceName       string              `json:"device_name"`
	Agent            string              `json:"agent"`
	Project          string              `json:"project"`
	Models           []string            `json:"models"`
	ModelAliases     map[string][]string `json:"model_aliases,omitempty"`
	Tokens           TokenTotals         `json:"tokens"`
	CostUSD          float64          `json:"cost_usd"`
	MaxContextTokens int64            `json:"max_context_tokens"`
	RequestCount     int64            `json:"request_count"`
	ToolCallCount    int64            `json:"tool_call_count"`
	ToolCalls        map[string]int32 `json:"tool_calls"`
	SubagentCount    int              `json:"subagent_count"`
	SubagentTokens   int64            `json:"subagent_tokens"`
	SubagentCostUSD  float64          `json:"subagent_cost_usd"`
	HourCount        int              `json:"hour_count"`
	FirstEventAt     time.Time        `json:"first_event_at"`
	LastEventAt      time.Time        `json:"last_event_at"`
}

type SessionsResponse struct {
	Total    int              `json:"total"`
	Page     int              `json:"page"`
	PageSize int              `json:"page_size"`
	Sessions []SessionSummary `json:"sessions"`
}

type SessionHourItem struct {
	HourBucket       time.Time        `json:"hour_bucket"`
	SessionID        string           `json:"session_id"`
	IsSubagent       bool             `json:"is_subagent"`
	ParentSessionID  string           `json:"parent_session_id,omitempty"`
	RawModel         string           `json:"raw_model"`
	Model            string           `json:"model"`
	Provider         string           `json:"provider"`
	Tokens           TokenTotals      `json:"tokens"`
	CostUSD          float64          `json:"cost_usd"`
	MaxContextTokens int64            `json:"max_context_tokens"`
	RequestCount     int32            `json:"request_count"`
	ToolCallCount    int32            `json:"tool_call_count"`
	ToolCalls        map[string]int32 `json:"tool_calls"`
	FirstEventAt     time.Time        `json:"first_event_at"`
	LastEventAt      time.Time        `json:"last_event_at"`
}

type SessionDetailResponse struct {
	Session SessionSummary    `json:"session"`
	Slices  []SessionHourItem `json:"slices"`
}

type ToolStat struct {
	Name    string           `json:"name"`
	Count   int64            `json:"count"`
	Share   float64          `json:"share"`
	ByAgent map[string]int64 `json:"by_agent"`
}

type ToolsResponse struct {
	TotalCalls int64      `json:"total_calls"`
	Tools      []ToolStat `json:"tools"`
}

type Device struct {
	ID               int64     `json:"id"`
	DeviceID         string    `json:"device_id"`
	Name             string    `json:"name"`
	OS               string    `json:"os"`
	Arch             string    `json:"arch"`
	Hostname         string    `json:"hostname"`
	CollectorVersion string    `json:"collector_version"`
	LastSyncedAt     time.Time `json:"last_synced_at"`
	Hidden           bool      `json:"hidden"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

type UpdateDeviceInput struct {
	Name   string `json:"name"`
	Hidden bool   `json:"hidden"`
}

type ModelAlias struct {
	ID             int64     `json:"id"`
	MatchPattern   string    `json:"match_pattern"`
	CanonicalModel string    `json:"canonical_model"`
	Priority       int32     `json:"priority"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type UpsertModelAliasInput struct {
	MatchPattern   string `json:"match_pattern"`
	CanonicalModel string `json:"canonical_model"`
	Priority       int32  `json:"priority"`
}

type ModelPrice struct {
	ID                int64     `json:"id,omitempty"`
	ModelPattern      string    `json:"model_pattern"`
	InputPerM         float64   `json:"input_per_m"`
	OutputPerM        float64   `json:"output_per_m"`
	CacheReadPerM     float64   `json:"cache_read_per_m"`
	CacheWritePerM    float64   `json:"cache_write_per_m"`
	CacheWrite1hPerM  float64   `json:"cache_write_1h_per_m"`
	Builtin           bool      `json:"builtin"`
	CreatedAt         time.Time `json:"created_at,omitempty"`
	UpdatedAt         time.Time `json:"updated_at,omitempty"`
}

type UpsertModelPriceInput struct {
	ModelPattern     string  `json:"model_pattern"`
	InputPerM        float64 `json:"input_per_m"`
	OutputPerM       float64 `json:"output_per_m"`
	CacheReadPerM    float64 `json:"cache_read_per_m"`
	CacheWritePerM   float64 `json:"cache_write_per_m"`
	CacheWrite1hPerM float64 `json:"cache_write_1h_per_m"`
}

type PricesResponse struct {
	Custom  []ModelPrice `json:"custom"`
	Builtin []ModelPrice `json:"builtin"`
}
