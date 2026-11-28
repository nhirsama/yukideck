package screen_time

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	DefaultWakaTimeBaseURL = "https://wakatime.com/api/v1"
	maxExternalBodyBytes   = 10 << 20  // 10 MiB for regular JSON endpoints
	maxDataDumpStreamBytes = 512 << 20 // 512 MiB guardrail for streaming data_dumps
	defaultRequestTimeout  = 15 * time.Second
)

var (
	ErrAuthFailed  = errors.New("WakaTime API Key 无效或已过期")
	ErrRateLimited = errors.New("WakaTime API 请求触发限流，请稍后再试")
)

type WakaUser struct {
	Username string
	Timezone string
	Plan     string
	Timeout  int // minutes (WakaTime keystroke timeout, default 15)
}

type WakaUserAgent struct {
	Editor string
	OS     string
}

type WakaHeartbeat struct {
	Time          time.Time
	Project       string
	Language      string
	Editor        string
	OS            string
	Category      string
	Machine       string
	MachineNameID string
	UserAgentID   string
}

type WakaDataDump struct {
	ID              string
	Type            string
	Status          string
	PercentComplete float64
	DownloadURL     string
	IsProcessing    bool
	IsStuck         bool
	HasFailed       bool
	Expires         *time.Time
	CreatedAt       *time.Time
}

type WakaHeartbeatDumpDay struct {
	Date       string
	Heartbeats []WakaHeartbeat
}

type WakaDimEntry struct {
	Name         string
	TotalSeconds float64
}

type WakaDaySummary struct {
	Date             string // YYYY-MM-DD
	Timezone         string
	TotalSeconds     float64
	Projects         []WakaDimEntry
	Languages        []WakaDimEntry
	Editors          []WakaDimEntry
	OperatingSystems []WakaDimEntry
	Categories       []WakaDimEntry
	Machines         []WakaDimEntry
}

type WakaDuration struct {
	StartedAt       time.Time
	DurationSeconds float64
	Project         string
	Color           string
}

type WakaTimeClient interface {
	GetCurrentUser(ctx context.Context, baseURL, apiKey string) (*WakaUser, error)
	GetMachineNames(ctx context.Context, baseURL, apiKey string) (map[string]string, error)
	GetUserAgents(ctx context.Context, baseURL, apiKey string) (map[string]WakaUserAgent, error)
	GetSummaries(ctx context.Context, baseURL, apiKey, startDate, endDate, timezone string) ([]WakaDaySummary, error)
	GetDurations(ctx context.Context, baseURL, apiKey, date, timezone string) ([]WakaDuration, error)
	GetHeartbeats(ctx context.Context, baseURL, apiKey, date, timezone string) ([]WakaHeartbeat, error)
	ListDataDumps(ctx context.Context, baseURL, apiKey string) ([]WakaDataDump, error)
	CreateDataDump(ctx context.Context, baseURL, apiKey, dumpType string) (*WakaDataDump, error)
	DownloadHeartbeatDump(
		ctx context.Context,
		downloadURL, baseURL, apiKey string,
		onProgress func(bytesRead, totalBytes int64),
		onDay func(day WakaHeartbeatDumpDay) error,
	) error
}

type HTTPWakaTimeClient struct {
	httpClient *http.Client
}

func sameTrustBoundary(orig, next *url.URL) bool {
	if orig == nil || next == nil {
		return false
	}
	// Never carry credentials across a protocol downgrade from HTTPS to HTTP.
	if strings.EqualFold(orig.Scheme, "https") && !strings.EqualFold(next.Scheme, "https") {
		return false
	}
	if strings.EqualFold(orig.Host, next.Host) {
		return true
	}
	// Allow official WakaTime subdomain redirects (e.g. api.wakatime.com <-> wakatime.com).
	oh := strings.ToLower(orig.Hostname())
	nh := strings.ToLower(next.Hostname())
	isWakaHost := func(h string) bool {
		return h == "wakatime.com" || strings.HasSuffix(h, ".wakatime.com")
	}
	return isWakaHost(oh) && isWakaHost(nh)
}

func NewHTTPWakaTimeClient(timeout time.Duration) *HTTPWakaTimeClient {
	if timeout <= 0 {
		timeout = defaultRequestTimeout
	}
	client := &http.Client{
		Timeout: timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			// Never leak Authorization header to an unrelated host or over HTTP downgrade.
			if len(via) > 0 && !sameTrustBoundary(via[0].URL, req.URL) {
				req.Header.Del("Authorization")
			}
			return nil
		},
	}
	return &HTTPWakaTimeClient{httpClient: client}
}

func ValidateBaseURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return DefaultWakaTimeBaseURL, nil
	}
	trimmed = strings.TrimRight(trimmed, "/")
	u, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("无效的 API Base URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("API Base URL 仅支持 http 或 https 协议")
	}
	if u.Host == "" {
		return "", errors.New("API Base URL 缺少主机地址")
	}
	return trimmed, nil
}

func extractWakaErrorDetail(body []byte) string {
	var parsed struct {
		Error   string `json:"error"`
		Errors  []any  `json:"errors"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &parsed); err == nil {
		if s := strings.TrimSpace(parsed.Error); s != "" {
			return s
		}
		if s := strings.TrimSpace(parsed.Message); s != "" {
			return s
		}
	}
	msg := strings.TrimSpace(string(body))
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return msg
}

func buildAuthHeaders(apiKey string) []string {
	key := strings.TrimSpace(apiKey)
	if key == "" {
		return nil
	}
	lower := strings.ToLower(key)
	if strings.HasPrefix(lower, "bearer ") || strings.HasPrefix(lower, "basic ") {
		return []string{key}
	}
	basicHeader := "Basic " + base64.StdEncoding.EncodeToString([]byte(key))
	bearerHeader := "Bearer " + key
	// OAuth tokens (waka_tok_ / wakatok_) prefer Bearer; API keys prefer Basic base64(key).
	// If the primary scheme returns 401, doJSON falls back once to the alternate scheme.
	if strings.HasPrefix(key, "waka_tok_") || strings.HasPrefix(key, "wakatok_") {
		return []string{bearerHeader, basicHeader}
	}
	return []string{basicHeader, bearerHeader}
}

func (c *HTTPWakaTimeClient) doJSONWithAuth(ctx context.Context, method, rawURL, authHeader string, reqBody []byte, dst any) (int, []byte, error) {
	var bodyReader io.Reader
	if len(reqBody) > 0 {
		bodyReader = strings.NewReader(string(reqBody))
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, bodyReader)
	if err != nil {
		return 0, nil, fmt.Errorf("build wakatime request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "YukiDeck-ScreenTime/1.0")
	if len(reqBody) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("request wakatime api: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxExternalBodyBytes+1))
	if err != nil {
		return resp.StatusCode, nil, fmt.Errorf("read wakatime response: %w", err)
	}
	if int64(len(body)) > maxExternalBodyBytes {
		return resp.StatusCode, nil, errors.New("WakaTime 响应体积超出上限")
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 && dst != nil {
		if err := json.Unmarshal(body, dst); err != nil {
			return resp.StatusCode, body, fmt.Errorf("decode wakatime response: %w", err)
		}
	}
	return resp.StatusCode, body, nil
}

func (c *HTTPWakaTimeClient) doJSON(ctx context.Context, rawURL, apiKey string, dst any) error {
	return c.doJSONMethod(ctx, http.MethodGet, rawURL, apiKey, nil, dst)
}

func (c *HTTPWakaTimeClient) doJSONMethod(ctx context.Context, method, rawURL, apiKey string, reqBody []byte, dst any) error {
	headers := buildAuthHeaders(apiKey)
	if len(headers) == 0 {
		return ErrAuthFailed
	}

	var statusCode int
	var body []byte
	var err error
	for i, authHeader := range headers {
		statusCode, body, err = c.doJSONWithAuth(ctx, method, rawURL, authHeader, reqBody, dst)
		if err != nil {
			return err
		}
		if statusCode >= 200 && statusCode < 300 {
			return nil
		}
		// Only retry with alternate auth scheme when server replies 401 Unauthorized.
		if statusCode == http.StatusUnauthorized && i+1 < len(headers) {
			continue
		}
		break
	}

	switch {
	case statusCode == http.StatusUnauthorized || statusCode == http.StatusForbidden:
		detail := extractWakaErrorDetail(body)
		if detail != "" {
			return fmt.Errorf("%w (HTTP %d: %s)", ErrAuthFailed, statusCode, detail)
		}
		return fmt.Errorf("%w (HTTP %d)", ErrAuthFailed, statusCode)
	case statusCode == http.StatusTooManyRequests:
		return ErrRateLimited
	default:
		msg := extractWakaErrorDetail(body)
		return fmt.Errorf("WakaTime 接口返回 HTTP %d: %s", statusCode, msg)
	}
}

func (c *HTTPWakaTimeClient) GetCurrentUser(ctx context.Context, baseURL, apiKey string) (*WakaUser, error) {
	base, err := ValidateBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Data struct {
			Username    string `json:"username"`
			DisplayName string `json:"display_name"`
			Email       string `json:"email"`
			Timezone    string `json:"timezone"`
			Plan        string `json:"plan"`
			Timeout     int    `json:"timeout"`
		} `json:"data"`
	}
	if err := c.doJSON(ctx, base+"/users/current", apiKey, &payload); err != nil {
		return nil, err
	}
	name := strings.TrimSpace(payload.Data.Username)
	if name == "" {
		name = strings.TrimSpace(payload.Data.DisplayName)
	}
	if name == "" {
		name = strings.TrimSpace(payload.Data.Email)
	}
	return &WakaUser{
		Username: name,
		Timezone: strings.TrimSpace(payload.Data.Timezone),
		Plan:     strings.TrimSpace(payload.Data.Plan),
		Timeout:  normalizeTimeoutMinutes(payload.Data.Timeout),
	}, nil
}

func (c *HTTPWakaTimeClient) GetMachineNames(ctx context.Context, baseURL, apiKey string) (map[string]string, error) {
	base, err := ValidateBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Data []struct {
			ID    string `json:"id"`
			Value string `json:"value"`
			Name  string `json:"name"`
		} `json:"data"`
	}
	if err := c.doJSON(ctx, base+"/users/current/machine_names", apiKey, &payload); err != nil {
		return nil, err
	}
	out := make(map[string]string, len(payload.Data))
	for _, it := range payload.Data {
		id := strings.TrimSpace(it.ID)
		val := strings.TrimSpace(it.Value)
		if val == "" {
			val = strings.TrimSpace(it.Name)
		}
		if id != "" && val != "" {
			out[id] = val
		}
	}
	return out, nil
}

func (c *HTTPWakaTimeClient) GetUserAgents(ctx context.Context, baseURL, apiKey string) (map[string]WakaUserAgent, error) {
	base, err := ValidateBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Data []struct {
			ID     string `json:"id"`
			Editor string `json:"editor"`
			OS     string `json:"os"`
		} `json:"data"`
	}
	if err := c.doJSON(ctx, base+"/users/current/user_agents", apiKey, &payload); err != nil {
		return nil, err
	}
	out := make(map[string]WakaUserAgent, len(payload.Data))
	for _, it := range payload.Data {
		id := strings.TrimSpace(it.ID)
		if id != "" {
			out[id] = WakaUserAgent{
				Editor: strings.TrimSpace(it.Editor),
				OS:     strings.TrimSpace(it.OS),
			}
		}
	}
	return out, nil
}

type rawWakaDim struct {
	Name         string  `json:"name"`
	TotalSeconds float64 `json:"total_seconds"`
}

func convertWakaDims(items []rawWakaDim) []WakaDimEntry {
	if len(items) == 0 {
		return nil
	}
	agg := make(map[string]float64, len(items))
	order := make([]string, 0, len(items))
	for _, it := range items {
		name := strings.TrimSpace(it.Name)
		if name == "" {
			name = "Unknown"
		}
		if it.TotalSeconds <= 0 || math.IsNaN(it.TotalSeconds) || math.IsInf(it.TotalSeconds, 0) {
			continue
		}
		if _, exists := agg[name]; !exists {
			order = append(order, name)
		}
		agg[name] += it.TotalSeconds
	}
	out := make([]WakaDimEntry, 0, len(order))
	for _, name := range order {
		out = append(out, WakaDimEntry{Name: name, TotalSeconds: agg[name]})
	}
	return out
}

func (c *HTTPWakaTimeClient) GetSummaries(ctx context.Context, baseURL, apiKey, startDate, endDate, timezone string) ([]WakaDaySummary, error) {
	base, err := ValidateBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	qs := url.Values{}
	qs.Set("start", startDate)
	qs.Set("end", endDate)
	if tz := strings.TrimSpace(timezone); tz != "" {
		qs.Set("timezone", tz)
	}

	var payload struct {
		Data []struct {
			Range struct {
				Date     string `json:"date"`
				Timezone string `json:"timezone"`
			} `json:"range"`
			GrandTotal struct {
				TotalSeconds float64 `json:"total_seconds"`
			} `json:"grand_total"`
			Projects         []rawWakaDim `json:"projects"`
			Languages        []rawWakaDim `json:"languages"`
			Editors          []rawWakaDim `json:"editors"`
			OperatingSystems []rawWakaDim `json:"operating_systems"`
			Categories       []rawWakaDim `json:"categories"`
			Machines         []rawWakaDim `json:"machines"`
		} `json:"data"`
	}
	if err := c.doJSON(ctx, base+"/users/current/summaries?"+qs.Encode(), apiKey, &payload); err != nil {
		return nil, err
	}

	out := make([]WakaDaySummary, 0, len(payload.Data))
	for _, d := range payload.Data {
		dateStr := strings.TrimSpace(d.Range.Date)
		if dateStr == "" {
			continue
		}
		totalSec := d.GrandTotal.TotalSeconds
		if totalSec < 0 || math.IsNaN(totalSec) || math.IsInf(totalSec, 0) {
			totalSec = 0
		}
		tz := strings.TrimSpace(d.Range.Timezone)
		if tz == "" {
			tz = timezone
		}
		out = append(out, WakaDaySummary{
			Date:             dateStr,
			Timezone:         tz,
			TotalSeconds:     totalSec,
			Projects:         convertWakaDims(d.Projects),
			Languages:        convertWakaDims(d.Languages),
			Editors:          convertWakaDims(d.Editors),
			OperatingSystems: convertWakaDims(d.OperatingSystems),
			Categories:       convertWakaDims(d.Categories),
			Machines:         convertWakaDims(d.Machines),
		})
	}
	return out, nil
}

func (c *HTTPWakaTimeClient) GetDurations(ctx context.Context, baseURL, apiKey, date, timezone string) ([]WakaDuration, error) {
	base, err := ValidateBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	qs := url.Values{}
	qs.Set("date", date)
	if tz := strings.TrimSpace(timezone); tz != "" {
		qs.Set("timezone", tz)
	}

	var payload struct {
		Data []struct {
			Time     float64 `json:"time"`
			Duration float64 `json:"duration"`
			Project  string  `json:"project"`
			Color    string  `json:"color"`
		} `json:"data"`
	}
	if err := c.doJSON(ctx, base+"/users/current/durations?"+qs.Encode(), apiKey, &payload); err != nil {
		return nil, err
	}

	out := make([]WakaDuration, 0, len(payload.Data))
	for _, it := range payload.Data {
		if it.Time <= 0 || it.Duration <= 0 || math.IsNaN(it.Time) || math.IsNaN(it.Duration) || math.IsInf(it.Duration, 0) {
			continue
		}
		sec, frac := math.Modf(it.Time)
		started := time.Unix(int64(sec), int64(frac*1e9)).UTC()
		proj := strings.TrimSpace(it.Project)
		if proj == "" {
			proj = "Unknown"
		}
		out = append(out, WakaDuration{
			StartedAt:       started,
			DurationSeconds: it.Duration,
			Project:         proj,
			Color:           strings.TrimSpace(it.Color),
		})
	}
	return out, nil
}

type rawWakaHeartbeat struct {
	Time          float64 `json:"time"`
	Project       string  `json:"project"`
	Language      string  `json:"language"`
	Editor        string  `json:"editor"`
	OS            string  `json:"operating_system"`
	Category      string  `json:"category"`
	Machine       string  `json:"machine"`
	MachineNameID string  `json:"machine_name_id"`
	UserAgentID   string  `json:"user_agent_id"`
}

func convertRawHeartbeat(it rawWakaHeartbeat) (WakaHeartbeat, bool) {
	if it.Time <= 0 || math.IsNaN(it.Time) || math.IsInf(it.Time, 0) {
		return WakaHeartbeat{}, false
	}
	sec, frac := math.Modf(it.Time)
	return WakaHeartbeat{
		Time:          time.Unix(int64(sec), int64(frac*1e9)).UTC(),
		Project:       strings.TrimSpace(it.Project),
		Language:      strings.TrimSpace(it.Language),
		Editor:        strings.TrimSpace(it.Editor),
		OS:            strings.TrimSpace(it.OS),
		Category:      strings.TrimSpace(it.Category),
		Machine:       strings.TrimSpace(it.Machine),
		MachineNameID: strings.TrimSpace(it.MachineNameID),
		UserAgentID:   strings.TrimSpace(it.UserAgentID),
	}, true
}

func (c *HTTPWakaTimeClient) GetHeartbeats(ctx context.Context, baseURL, apiKey, date, timezone string) ([]WakaHeartbeat, error) {
	base, err := ValidateBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	qs := url.Values{}
	qs.Set("date", date)
	if tz := strings.TrimSpace(timezone); tz != "" {
		qs.Set("timezone", tz)
	}
	var payload struct {
		Data []rawWakaHeartbeat `json:"data"`
	}
	if err := c.doJSON(ctx, base+"/users/current/heartbeats?"+qs.Encode(), apiKey, &payload); err != nil {
		return nil, err
	}
	out := make([]WakaHeartbeat, 0, len(payload.Data))
	for _, it := range payload.Data {
		if hb, ok := convertRawHeartbeat(it); ok {
			out = append(out, hb)
		}
	}
	return out, nil
}

type rawWakaDataDump struct {
	ID              string  `json:"id"`
	Type            string  `json:"type"`
	Status          string  `json:"status"`
	PercentComplete float64 `json:"percent_complete"`
	DownloadURL     string  `json:"download_url"`
	IsProcessing    bool    `json:"is_processing"`
	IsStuck         bool    `json:"is_stuck"`
	HasFailed       bool    `json:"has_failed"`
	Expires         string  `json:"expires"`
	CreatedAt       string  `json:"created_at"`
}

func parseOptionalRFC3339(raw string) *time.Time {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			u := t.UTC()
			return &u
		}
	}
	return nil
}

func toWakaDataDump(r rawWakaDataDump) WakaDataDump {
	return WakaDataDump{
		ID:              strings.TrimSpace(r.ID),
		Type:            strings.ToLower(strings.TrimSpace(r.Type)),
		Status:          strings.TrimSpace(r.Status),
		PercentComplete: r.PercentComplete,
		DownloadURL:     strings.TrimSpace(r.DownloadURL),
		IsProcessing:    r.IsProcessing,
		IsStuck:         r.IsStuck,
		HasFailed:       r.HasFailed,
		Expires:         parseOptionalRFC3339(r.Expires),
		CreatedAt:       parseOptionalRFC3339(r.CreatedAt),
	}
}

func (c *HTTPWakaTimeClient) ListDataDumps(ctx context.Context, baseURL, apiKey string) ([]WakaDataDump, error) {
	base, err := ValidateBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Data []rawWakaDataDump `json:"data"`
	}
	if err := c.doJSON(ctx, base+"/users/current/data_dumps", apiKey, &payload); err != nil {
		return nil, err
	}
	out := make([]WakaDataDump, 0, len(payload.Data))
	for _, r := range payload.Data {
		out = append(out, toWakaDataDump(r))
	}
	return out, nil
}

func (c *HTTPWakaTimeClient) CreateDataDump(ctx context.Context, baseURL, apiKey, dumpType string) (*WakaDataDump, error) {
	base, err := ValidateBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	reqBody, _ := json.Marshal(map[string]any{
		"type":                dumpType,
		"email_when_finished": false,
	})
	var payload struct {
		Data rawWakaDataDump `json:"data"`
	}
	if err := c.doJSONMethod(ctx, http.MethodPost, base+"/users/current/data_dumps", apiKey, reqBody, &payload); err != nil {
		return nil, err
	}
	d := toWakaDataDump(payload.Data)
	return &d, nil
}

type progressReader struct {
	r          io.Reader
	total      int64
	read       int64
	lastReport int64
	onProgress func(bytesRead, totalBytes int64)
}

func (p *progressReader) Read(buf []byte) (int, error) {
	n, err := p.r.Read(buf)
	if n > 0 {
		p.read += int64(n)
		if p.onProgress != nil && (p.read-p.lastReport >= 64*1024 || err == io.EOF) {
			p.lastReport = p.read
			p.onProgress(p.read, p.total)
		}
	}
	return n, err
}

// DownloadHeartbeatDump streams a WakaTime heartbeats data_dump JSON day-by-day without loading the full file into memory.
func (c *HTTPWakaTimeClient) DownloadHeartbeatDump(
	ctx context.Context,
	downloadURL, baseURL, apiKey string,
	onProgress func(bytesRead, totalBytes int64),
	onDay func(day WakaHeartbeatDumpDay) error,
) error {
	dlParsed, err := url.Parse(strings.TrimSpace(downloadURL))
	if err != nil || (dlParsed.Scheme != "http" && dlParsed.Scheme != "https") || dlParsed.Host == "" {
		return errors.New("无效的导出下载地址")
	}
	baseParsed, _ := url.Parse(strings.TrimSpace(baseURL))

	streamClient := &http.Client{
		CheckRedirect: c.httpClient.CheckRedirect,
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, dlParsed.String(), nil)
	if err != nil {
		return fmt.Errorf("build download request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "YukiDeck-ScreenTime/1.0")
	// Pre-signed S3/GCS URLs reject foreign Authorization headers; attach auth only when same trust boundary as API base.
	if baseParsed != nil && sameTrustBoundary(baseParsed, dlParsed) {
		if headers := buildAuthHeaders(apiKey); len(headers) > 0 {
			req.Header.Set("Authorization", headers[0])
		}
	}

	resp, err := streamClient.Do(req)
	if err != nil {
		return fmt.Errorf("download data dump: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("%w (HTTP %d)", ErrAuthFailed, resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("下载导出文件失败 (HTTP %d): %s", resp.StatusCode, extractWakaErrorDetail(snippet))
	}

	limited := io.LimitReader(resp.Body, maxDataDumpStreamBytes+1)
	pr := &progressReader{
		r:          limited,
		total:      resp.ContentLength,
		onProgress: onProgress,
	}
	dec := json.NewDecoder(pr)

	tok, err := dec.Token()
	if err != nil {
		return fmt.Errorf("parse dump json root: %w", err)
	}
	delim, ok := tok.(json.Delim)
	if !ok {
		return errors.New("导出 JSON 格式无效")
	}

	decodeDay := func() error {
		var raw struct {
			Date       string             `json:"date"`
			Heartbeats []rawWakaHeartbeat `json:"heartbeats"`
		}
		if err := dec.Decode(&raw); err != nil {
			return fmt.Errorf("decode dump day: %w", err)
		}
		if pr.read > maxDataDumpStreamBytes {
			return errors.New("导出文件体积超出服务端安全上限")
		}
		hbs := make([]WakaHeartbeat, 0, len(raw.Heartbeats))
		for _, it := range raw.Heartbeats {
			if hb, ok := convertRawHeartbeat(it); ok {
				hbs = append(hbs, hb)
			}
		}
		return onDay(WakaHeartbeatDumpDay{
			Date:       strings.TrimSpace(raw.Date),
			Heartbeats: hbs,
		})
	}

	if delim == '[' {
		// Flat array of raw heartbeats fallback
		byDate := make(map[string][]WakaHeartbeat)
		order := make([]string, 0)
		for dec.More() {
			var it rawWakaHeartbeat
			if err := dec.Decode(&it); err != nil {
				return fmt.Errorf("decode flat heartbeat: %w", err)
			}
			if pr.read > maxDataDumpStreamBytes {
				return errors.New("导出文件体积超出服务端安全上限")
			}
			if hb, ok := convertRawHeartbeat(it); ok {
				d := hb.Time.UTC().Format(dateLayout)
				if _, exists := byDate[d]; !exists {
					order = append(order, d)
				}
				byDate[d] = append(byDate[d], hb)
			}
		}
		for _, d := range order {
			if err := onDay(WakaHeartbeatDumpDay{Date: d, Heartbeats: byDate[d]}); err != nil {
				return err
			}
		}
		if onProgress != nil {
			onProgress(pr.read, pr.total)
		}
		return nil
	}

	if delim != '{' {
		return errors.New("导出 JSON 根节点不是对象或数组")
	}

	// Stream object keys; process "days" array element-by-element while skipping all other keys cleanly.
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return fmt.Errorf("read dump key: %w", err)
		}
		key, _ := keyTok.(string)
		if key == "days" || key == "data" {
			arrTok, err := dec.Token()
			if err != nil {
				return fmt.Errorf("read %s array start: %w", key, err)
			}
			if d, ok := arrTok.(json.Delim); !ok || d != '[' {
				return fmt.Errorf("导出 JSON 字段 %q 不是数组", key)
			}
			for dec.More() {
				if err := decodeDay(); err != nil {
					return err
				}
			}
			if _, err := dec.Token(); err != nil {
				return fmt.Errorf("read %s array end: %w", key, err)
			}
		} else {
			var discard json.RawMessage
			if err := dec.Decode(&discard); err != nil {
				return fmt.Errorf("skip dump field %q: %w", key, err)
			}
		}
	}
	if onProgress != nil {
		onProgress(pr.read, pr.total)
	}
	return nil
}
