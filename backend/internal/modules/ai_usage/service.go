package ai_usage

import (
	"context"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"yukideck/internal/core/httpx"
)

const (
	MaxIngestBatchSlices = 500
	MaxIngestBodyBytes   = 8 << 20 // 8 MiB uncompressed guardrail
)

type QueryFilter struct {
	Start         time.Time
	End           time.Time
	Timezone      string
	Agent         string
	Model         string
	DeviceID      string
	Project       string
	IncludeHidden bool
}

type Service struct {
	store Store
}

func NewService(store Store) *Service {
	return &Service{store: store}
}

func (s *Service) Ingest(ctx context.Context, userID int64, req IngestRequest) (*IngestResponse, error) {
	devID := strings.TrimSpace(req.Device.DeviceID)
	if devID == "" {
		return nil, httpx.BadRequest("device.device_id 不能为空")
	}
	if len(devID) > 128 {
		return nil, httpx.BadRequest("device.device_id 过长")
	}
	if len(req.Slices) > MaxIngestBatchSlices {
		return nil, httpx.PayloadTooLarge("单批上报切片数量超过服务端上限（500）")
	}

	dev := IngestDevice{
		DeviceID:         devID,
		Name:             truncateStr(strings.TrimSpace(req.Device.Name), 120),
		OS:               truncateStr(strings.TrimSpace(req.Device.OS), 64),
		Arch:             truncateStr(strings.TrimSpace(req.Device.Arch), 32),
		Hostname:         truncateStr(strings.TrimSpace(req.Device.Hostname), 128),
		CollectorVersion: truncateStr(strings.TrimSpace(req.Device.CollectorVersion), 64),
	}
	if dev.Name == "" {
		if dev.Hostname != "" {
			dev.Name = dev.Hostname
		} else {
			dev.Name = dev.DeviceID
		}
	}

	if _, err := s.store.UpsertDeviceFromIngest(ctx, userID, dev); err != nil {
		return nil, err
	}

	records := make([]HourlySessionRecord, 0, len(req.Slices))
	for _, sl := range req.Slices {
		agent := strings.ToLower(strings.TrimSpace(sl.Agent))
		sessionID := strings.TrimSpace(sl.SessionID)
		model := strings.TrimSpace(sl.Model)
		if agent == "" || sessionID == "" || model == "" {
			return nil, httpx.BadRequest("切片缺少必填字段 agent / session_id / model")
		}
		if sl.HourBucket.IsZero() {
			return nil, httpx.BadRequest("切片缺少有效 hour_bucket")
		}
		if sl.InputTokens < 0 || sl.OutputTokens < 0 || sl.CacheReadTokens < 0 ||
			sl.CacheWriteTokens < 0 || sl.CacheWrite1hTokens < 0 || sl.ReasoningTokens < 0 ||
			sl.MaxContextTokens < 0 || sl.RequestCount < 0 || sl.ToolCallCount < 0 {
			return nil, httpx.BadRequest("用量统计字段不能为负数")
		}

		bucket := sl.HourBucket.UTC().Truncate(time.Hour)
		firstAt := sl.FirstEventAt.UTC()
		if firstAt.IsZero() {
			firstAt = bucket
		}
		lastAt := sl.LastEventAt.UTC()
		if lastAt.IsZero() {
			lastAt = firstAt
		}
		if lastAt.Before(firstAt) {
			lastAt = firstAt
		}

		cleanTools := make(map[string]int32, len(sl.ToolCalls))
		var toolSum int32
		for name, cnt := range sl.ToolCalls {
			n := truncateStr(strings.TrimSpace(name), 120)
			if n == "" || cnt <= 0 {
				continue
			}
			cleanTools[n] += cnt
			toolSum += cnt
		}
		toolCallCount := sl.ToolCallCount
		if toolSum > toolCallCount {
			toolCallCount = toolSum
		}

		records = append(records, HourlySessionRecord{
			UserID:             userID,
			DeviceID:           devID,
			Agent:              truncateStr(agent, 64),
			SessionID:          truncateStr(sessionID, 128),
			HourBucket:         bucket,
			Model:              truncateStr(model, 160),
			IsSubagent:         sl.IsSubagent,
			ParentSessionID:    truncateStr(strings.TrimSpace(sl.ParentSessionID), 128),
			Provider:           truncateStr(strings.ToLower(strings.TrimSpace(sl.Provider)), 64),
			Project:            truncateStr(strings.TrimSpace(sl.Project), 160),
			InputTokens:        sl.InputTokens,
			OutputTokens:       sl.OutputTokens,
			CacheReadTokens:    sl.CacheReadTokens,
			CacheWriteTokens:   sl.CacheWriteTokens,
			CacheWrite1hTokens: sl.CacheWrite1hTokens,
			ReasoningTokens:    sl.ReasoningTokens,
			MaxContextTokens:   sl.MaxContextTokens,
			ReportedCostUSD:    math.Max(0, sl.ReportedCostUSD),
			RequestCount:       sl.RequestCount,
			ToolCallCount:      toolCallCount,
			ToolCalls:          cleanTools,
			FirstEventAt:       firstAt,
			LastEventAt:        lastAt,
		})
	}

	if err := s.store.UpsertHourlySessions(ctx, userID, records, req.ForceOverwrite); err != nil {
		return nil, err
	}
	return &IngestResponse{Accepted: len(records), DeviceID: devID}, nil
}

type enrichedSlice struct {
	row             HourlySessionRecord
	canonicalModel  string
	deviceName      string
	costUSD         float64
	cacheSavingsUSD float64
}

func (s *Service) loadUserMeta(ctx context.Context, userID int64) ([]Device, []ModelAlias, []ModelPrice, error) {
	var (
		devices []Device
		aliases []ModelAlias
		prices  []ModelPrice
		errDev  error
		errAls  error
		errPrc  error
		wg      sync.WaitGroup
	)
	wg.Add(3)
	go func() {
		defer wg.Done()
		devices, errDev = s.store.ListDevices(ctx, userID)
	}()
	go func() {
		defer wg.Done()
		aliases, errAls = s.store.ListModelAliases(ctx, userID)
	}()
	go func() {
		defer wg.Done()
		prices, errPrc = s.store.ListModelPrices(ctx, userID)
	}()
	wg.Wait()
	if errDev != nil {
		return nil, nil, nil, errDev
	}
	if errAls != nil {
		return nil, nil, nil, errAls
	}
	if errPrc != nil {
		return nil, nil, nil, errPrc
	}
	return devices, aliases, prices, nil
}

func (s *Service) loadEnriched(ctx context.Context, userID int64, filter QueryFilter) ([]enrichedSlice, FilterOptions, map[string]Device, error) {
	var (
		rows    []HourlySessionRecord
		devices []Device
		aliases []ModelAlias
		prices  []ModelPrice
		errRows error
		errMeta error
		wg      sync.WaitGroup
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		rows, errRows = s.store.ListHourlySessions(ctx, userID, filter.Start, filter.End)
	}()
	go func() {
		defer wg.Done()
		devices, aliases, prices, errMeta = s.loadUserMeta(ctx, userID)
	}()
	wg.Wait()
	if errRows != nil {
		return nil, FilterOptions{}, nil, errRows
	}
	if errMeta != nil {
		return nil, FilterOptions{}, nil, errMeta
	}

	devMap := make(map[string]Device, len(devices))
	for _, d := range devices {
		devMap[d.DeviceID] = d
	}

	agentSet := map[string]struct{}{}
	modelSet := map[string]struct{}{}
	projSet := map[string]struct{}{}

	filterAgent := strings.ToLower(strings.TrimSpace(filter.Agent))
	filterModel := strings.TrimSpace(filter.Model)
	filterDevice := strings.TrimSpace(filter.DeviceID)
	filterProject := strings.TrimSpace(filter.Project)

	out := make([]enrichedSlice, 0, len(rows))
	for _, row := range rows {
		dev, knownDev := devMap[row.DeviceID]
		if knownDev && dev.Hidden && !filter.IncludeHidden && filterDevice == "" {
			continue
		}
		canon := NormalizeModel(row.Model, aliases)

		agentSet[row.Agent] = struct{}{}
		modelSet[canon] = struct{}{}
		if row.Project != "" {
			projSet[row.Project] = struct{}{}
		}

		if filterAgent != "" && row.Agent != filterAgent {
			continue
		}
		if filterModel != "" && !strings.EqualFold(canon, filterModel) && !strings.EqualFold(row.Model, filterModel) {
			continue
		}
		if filterDevice != "" && row.DeviceID != filterDevice {
			continue
		}
		if filterProject != "" && row.Project != filterProject {
			continue
		}

		cost, savings := ComputeCost(row, canon, prices)
		devName := row.DeviceID
		if knownDev && dev.Name != "" {
			devName = dev.Name
		}
		out = append(out, enrichedSlice{
			row:             row,
			canonicalModel:  canon,
			deviceName:      devName,
			costUSD:         cost,
			cacheSavingsUSD: savings,
		})
	}

	visibleDevices := make([]Device, 0, len(devices))
	for _, d := range devices {
		if !d.Hidden || filter.IncludeHidden {
			visibleDevices = append(visibleDevices, d)
		}
	}

	opts := FilterOptions{
		Agents:   sortedKeys(agentSet),
		Models:   sortedKeys(modelSet),
		Projects: sortedKeys(projSet),
		Devices:  visibleDevices,
	}
	return out, opts, devMap, nil
}

func (s *Service) Summary(ctx context.Context, userID int64, filter QueryFilter) (*SummaryResponse, error) {
	loc := loadTimezone(filter.Timezone)
	slices, opts, _, err := s.loadEnriched(ctx, userID, filter)
	if err != nil {
		return nil, err
	}

	resp := &SummaryResponse{
		ByHourOfDay: make([]HourOfDayItem, 24),
		Filters:     opts,
	}
	for i := 0; i < 24; i++ {
		resp.ByHourOfDay[i] = HourOfDayItem{Hour: i}
	}

	activeDays := map[string]struct{}{}
	sessionKeys := map[string]struct{}{}
	byAgent := newBreakdownAgg()
	byModel := newBreakdownAgg()
	byDevice := newBreakdownAgg()
	byProject := newBreakdownAgg()

	for _, item := range slices {
		r := item.row
		tot := r.TotalTokens()
		resp.Tokens.InputTokens += r.InputTokens
		resp.Tokens.OutputTokens += r.OutputTokens
		resp.Tokens.CacheReadTokens += r.CacheReadTokens
		resp.Tokens.CacheWriteTokens += r.CacheWriteTokens
		resp.Tokens.CacheWrite1hTokens += r.CacheWrite1hTokens
		resp.Tokens.ReasoningTokens += r.ReasoningTokens
		resp.Tokens.TotalTokens += tot
		resp.CostUSD += item.costUSD
		resp.CacheSavingsUSD += item.cacheSavingsUSD
		resp.RequestCount += int64(r.RequestCount)
		resp.ToolCallCount += int64(r.ToolCallCount)
		if r.MaxContextTokens > resp.MaxContextTokens {
			resp.MaxContextTokens = r.MaxContextTokens
		}
		if r.IsSubagent {
			resp.SubagentTokens += tot
			resp.SubagentCostUSD += item.costUSD
		}

		localTime := r.HourBucket.In(loc)
		activeDays[localTime.Format("2006-01-02")] = struct{}{}
		hour := localTime.Hour()
		resp.ByHourOfDay[hour].TotalTokens += tot
		resp.ByHourOfDay[hour].CostUSD += item.costUSD
		resp.ByHourOfDay[hour].RequestCount += int64(r.RequestCount)

		rootSess := rootSessionKey(r)
		sessionKeys[rootSess] = struct{}{}

		byAgent.add(r.Agent, r.Agent, r, item.costUSD, rootSess)
		byModel.add(item.canonicalModel, item.canonicalModel, r, item.costUSD, rootSess)
		byDevice.add(r.DeviceID, item.deviceName, r, item.costUSD, rootSess)
		projKey := r.Project
		if projKey == "" {
			projKey = "(未标记项目)"
		}
		byProject.add(projKey, projKey, r, item.costUSD, rootSess)
	}

	inputPool := resp.Tokens.InputTokens + resp.Tokens.CacheReadTokens + resp.Tokens.CacheWriteTokens + resp.Tokens.CacheWrite1hTokens
	if inputPool > 0 {
		resp.CacheHitRate = float64(resp.Tokens.CacheReadTokens) / float64(inputPool)
	}
	resp.ActiveDays = len(activeDays)
	resp.SessionCount = len(sessionKeys)
	resp.ByAgent = byAgent.sorted()
	resp.ByModel = byModel.sorted()
	resp.ByDevice = byDevice.sorted()
	resp.ByProject = byProject.sorted()
	return resp, nil
}

func (s *Service) Trends(ctx context.Context, userID int64, filter QueryFilter, granularity, groupBy string) (*TrendsResponse, error) {
	loc := loadTimezone(filter.Timezone)
	switch granularity {
	case "hour", "day", "week", "month":
	default:
		granularity = "day"
	}
	switch groupBy {
	case "total", "agent", "model", "device", "project":
	default:
		groupBy = "agent"
	}

	slices, _, _, err := s.loadEnriched(ctx, userID, filter)
	if err != nil {
		return nil, err
	}

	buckets := map[string]*TrendPoint{}
	seriesTotals := map[string]int64{}

	for _, item := range slices {
		r := item.row
		tot := r.TotalTokens()
		bKey := formatBucket(r.HourBucket.In(loc), granularity)
		pt, ok := buckets[bKey]
		if !ok {
			pt = &TrendPoint{Bucket: bKey, Series: map[string]TrendSeriesValue{}}
			buckets[bKey] = pt
		}
		pt.TotalTokens += tot
		pt.CostUSD += item.costUSD
		pt.RequestCount += int64(r.RequestCount)

		sKey := "total"
		switch groupBy {
		case "agent":
			sKey = r.Agent
		case "model":
			sKey = item.canonicalModel
		case "device":
			sKey = item.deviceName
		case "project":
			if r.Project != "" {
				sKey = r.Project
			} else {
				sKey = "(未标记项目)"
			}
		}
		cur := pt.Series[sKey]
		cur.TotalTokens += tot
		cur.CostUSD += item.costUSD
		pt.Series[sKey] = cur
		seriesTotals[sKey] += tot
	}

	bucketKeys := make([]string, 0, len(buckets))
	for k := range buckets {
		bucketKeys = append(bucketKeys, k)
	}
	sort.Strings(bucketKeys)

	points := make([]TrendPoint, 0, len(bucketKeys))
	for _, k := range bucketKeys {
		points = append(points, *buckets[k])
	}

	seriesKeys := make([]string, 0, len(seriesTotals))
	for k := range seriesTotals {
		seriesKeys = append(seriesKeys, k)
	}
	sort.Slice(seriesKeys, func(i, j int) bool {
		if seriesTotals[seriesKeys[i]] != seriesTotals[seriesKeys[j]] {
			return seriesTotals[seriesKeys[i]] > seriesTotals[seriesKeys[j]]
		}
		return seriesKeys[i] < seriesKeys[j]
	})

	return &TrendsResponse{
		Granularity: granularity,
		GroupBy:     groupBy,
		SeriesKeys:  seriesKeys,
		Points:      points,
	}, nil
}

func (s *Service) Heatmap(ctx context.Context, userID int64, filter QueryFilter) (*HeatmapResponse, error) {
	loc := loadTimezone(filter.Timezone)
	tzName := filter.Timezone
	if strings.TrimSpace(tzName) == "" {
		tzName = "UTC"
	}
	slices, _, _, err := s.loadEnriched(ctx, userID, filter)
	if err != nil {
		return nil, err
	}

	type dayAgg struct {
		tokens   int64
		cost     float64
		reqs     int64
		sessions map[string]struct{}
	}
	byDay := map[string]*dayAgg{}
	var maxTokens int64

	for _, item := range slices {
		r := item.row
		tot := r.TotalTokens()
		dayKey := r.HourBucket.In(loc).Format("2006-01-02")
		d, ok := byDay[dayKey]
		if !ok {
			d = &dayAgg{sessions: map[string]struct{}{}}
			byDay[dayKey] = d
		}
		d.tokens += tot
		d.cost += item.costUSD
		d.reqs += int64(r.RequestCount)
		d.sessions[rootSessionKey(r)] = struct{}{}
		if d.tokens > maxTokens {
			maxTokens = d.tokens
		}
	}

	keys := make([]string, 0, len(byDay))
	for k := range byDay {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	days := make([]HeatmapDay, 0, len(keys))
	for _, k := range keys {
		d := byDay[k]
		days = append(days, HeatmapDay{
			Date:         k,
			TotalTokens:  d.tokens,
			CostUSD:      d.cost,
			RequestCount: d.reqs,
			SessionCount: len(d.sessions),
			Level:        heatmapLevel(d.tokens, maxTokens),
		})
	}
	return &HeatmapResponse{Timezone: tzName, Days: days}, nil
}

func (s *Service) Sessions(ctx context.Context, userID int64, filter QueryFilter, page, pageSize int) (*SessionsResponse, error) {
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 || pageSize > 100 {
		pageSize = 20
	}

	pageFilter := SessionPageFilter{
		Start:         filter.Start,
		End:           filter.End,
		Agent:         strings.ToLower(strings.TrimSpace(filter.Agent)),
		DeviceID:      strings.TrimSpace(filter.DeviceID),
		Project:       strings.TrimSpace(filter.Project),
		IncludeHidden: filter.IncludeHidden,
		Page:          page,
		PageSize:      pageSize,
	}
	filterModel := strings.TrimSpace(filter.Model)

	var (
		rows    []HourlySessionRecord
		total   int
		devices []Device
		aliases []ModelAlias
		prices  []ModelPrice
		err     error
	)

	if filterModel == "" {
		var (
			errRows error
			errMeta error
			wg      sync.WaitGroup
		)
		wg.Add(2)
		go func() {
			defer wg.Done()
			rows, total, errRows = s.store.ListPagedSessionSlices(ctx, userID, pageFilter)
		}()
		go func() {
			defer wg.Done()
			devices, aliases, prices, errMeta = s.loadUserMeta(ctx, userID)
		}()
		wg.Wait()
		if errRows != nil {
			return nil, errRows
		}
		if errMeta != nil {
			return nil, errMeta
		}
	} else {
		var (
			distinctModels []string
			errModels      error
			errMeta        error
			wg             sync.WaitGroup
		)
		wg.Add(2)
		go func() {
			defer wg.Done()
			distinctModels, errModels = s.store.ListDistinctModelsInRange(ctx, userID, filter.Start, filter.End)
		}()
		go func() {
			defer wg.Done()
			devices, aliases, prices, errMeta = s.loadUserMeta(ctx, userID)
		}()
		wg.Wait()
		if errModels != nil {
			return nil, errModels
		}
		if errMeta != nil {
			return nil, errMeta
		}
		matchedRaw := make([]string, 0, len(distinctModels))
		for _, raw := range distinctModels {
			canon := NormalizeModel(raw, aliases)
			if strings.EqualFold(canon, filterModel) || strings.EqualFold(raw, filterModel) {
				matchedRaw = append(matchedRaw, raw)
			}
		}
		if len(matchedRaw) == 0 {
			return &SessionsResponse{Total: 0, Page: page, PageSize: pageSize, Sessions: []SessionSummary{}}, nil
		}
		pageFilter.RawModels = matchedRaw
		rows, total, err = s.store.ListPagedSessionSlices(ctx, userID, pageFilter)
		if err != nil {
			return nil, err
		}
	}

	if len(rows) == 0 {
		return &SessionsResponse{Total: total, Page: page, PageSize: pageSize, Sessions: []SessionSummary{}}, nil
	}

	devMap := make(map[string]Device, len(devices))
	for _, d := range devices {
		devMap[d.DeviceID] = d
	}

	type sessAgg struct {
		summary  SessionSummary
		modelSet map[string]struct{}
		hourSet  map[time.Time]struct{}
		subSet   map[string]struct{}
	}
	bySess := map[string]*sessAgg{}

	for _, r := range rows {
		canon := NormalizeModel(r.Model, aliases)
		costUSD, _ := ComputeCost(r, canon, prices)
		devName := r.DeviceID
		if dev, ok := devMap[r.DeviceID]; ok && dev.Name != "" {
			devName = dev.Name
		}

		tot := r.TotalTokens()
		rootID := r.SessionID
		if r.IsSubagent && r.ParentSessionID != "" {
			rootID = r.ParentSessionID
		}
		key := r.DeviceID + "|" + r.Agent + "|" + rootID
		agg, ok := bySess[key]
		if !ok {
			agg = &sessAgg{
				summary: SessionSummary{
					SessionID:    rootID,
					DeviceID:     r.DeviceID,
					DeviceName:   devName,
					Agent:        r.Agent,
					Project:      r.Project,
					ToolCalls:    map[string]int32{},
					FirstEventAt: r.FirstEventAt,
					LastEventAt:  r.LastEventAt,
				},
				modelSet: map[string]struct{}{},
				hourSet:  map[time.Time]struct{}{},
				subSet:   map[string]struct{}{},
			}
			bySess[key] = agg
		}
		sm := &agg.summary
		if sm.Project == "" && r.Project != "" {
			sm.Project = r.Project
		}
		sm.Tokens.InputTokens += r.InputTokens
		sm.Tokens.OutputTokens += r.OutputTokens
		sm.Tokens.CacheReadTokens += r.CacheReadTokens
		sm.Tokens.CacheWriteTokens += r.CacheWriteTokens
		sm.Tokens.CacheWrite1hTokens += r.CacheWrite1hTokens
		sm.Tokens.ReasoningTokens += r.ReasoningTokens
		sm.Tokens.TotalTokens += tot
		sm.CostUSD += costUSD
		if r.MaxContextTokens > sm.MaxContextTokens {
			sm.MaxContextTokens = r.MaxContextTokens
		}
		sm.RequestCount += int64(r.RequestCount)
		sm.ToolCallCount += int64(r.ToolCallCount)
		for tName, tCnt := range r.ToolCalls {
			sm.ToolCalls[tName] += tCnt
		}
		if r.IsSubagent {
			sm.SubagentTokens += tot
			sm.SubagentCostUSD += costUSD
			agg.subSet[r.SessionID] = struct{}{}
		}
		agg.modelSet[canon] = struct{}{}
		agg.hourSet[r.HourBucket] = struct{}{}
		if r.FirstEventAt.Before(sm.FirstEventAt) {
			sm.FirstEventAt = r.FirstEventAt
		}
		if r.LastEventAt.After(sm.LastEventAt) {
			sm.LastEventAt = r.LastEventAt
		}
	}

	sessions := make([]SessionSummary, 0, len(bySess))
	for _, agg := range bySess {
		agg.summary.Models = sortedKeys(agg.modelSet)
		agg.summary.HourCount = len(agg.hourSet)
		agg.summary.SubagentCount = len(agg.subSet)
		sessions = append(sessions, agg.summary)
	}
	sort.Slice(sessions, func(i, j int) bool {
		if !sessions[i].LastEventAt.Equal(sessions[j].LastEventAt) {
			return sessions[i].LastEventAt.After(sessions[j].LastEventAt)
		}
		if sessions[i].Tokens.TotalTokens != sessions[j].Tokens.TotalTokens {
			return sessions[i].Tokens.TotalTokens > sessions[j].Tokens.TotalTokens
		}
		return sessions[i].SessionID < sessions[j].SessionID
	})

	return &SessionsResponse{
		Total:    total,
		Page:     page,
		PageSize: pageSize,
		Sessions: sessions,
	}, nil
}

func (s *Service) SessionDetail(ctx context.Context, userID int64, sessionID, deviceID string) (*SessionDetailResponse, error) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil, httpx.BadRequest("session_id 不能为空")
	}
	var (
		rows    []HourlySessionRecord
		devices []Device
		aliases []ModelAlias
		prices  []ModelPrice
		errRows error
		errMeta error
		wg      sync.WaitGroup
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		rows, errRows = s.store.ListHourlySessionsBySession(ctx, userID, sessionID, strings.TrimSpace(deviceID))
	}()
	go func() {
		defer wg.Done()
		devices, aliases, prices, errMeta = s.loadUserMeta(ctx, userID)
	}()
	wg.Wait()
	if errRows != nil {
		return nil, errRows
	}
	if len(rows) == 0 {
		return nil, httpx.NotFound("会话不存在")
	}
	if errMeta != nil {
		return nil, errMeta
	}
	devNames := map[string]string{}
	for _, d := range devices {
		devNames[d.DeviceID] = d.Name
	}

	first := rows[0]
	devName := devNames[first.DeviceID]
	if devName == "" {
		devName = first.DeviceID
	}

	summary := SessionSummary{
		SessionID:    sessionID,
		DeviceID:     first.DeviceID,
		DeviceName:   devName,
		Agent:        first.Agent,
		Project:      first.Project,
		ToolCalls:    map[string]int32{},
		FirstEventAt: first.FirstEventAt,
		LastEventAt:  first.LastEventAt,
	}
	modelSet := map[string]struct{}{}
	hourSet := map[time.Time]struct{}{}
	subSet := map[string]struct{}{}
	items := make([]SessionHourItem, 0, len(rows))

	for _, r := range rows {
		canon := NormalizeModel(r.Model, aliases)
		cost, _ := ComputeCost(r, canon, prices)
		tot := r.TotalTokens()
		tokens := TokenTotals{
			InputTokens:        r.InputTokens,
			OutputTokens:       r.OutputTokens,
			CacheReadTokens:    r.CacheReadTokens,
			CacheWriteTokens:   r.CacheWriteTokens,
			CacheWrite1hTokens: r.CacheWrite1hTokens,
			ReasoningTokens:    r.ReasoningTokens,
			TotalTokens:        tot,
		}
		if summary.Project == "" && r.Project != "" {
			summary.Project = r.Project
		}
		summary.Tokens.InputTokens += r.InputTokens
		summary.Tokens.OutputTokens += r.OutputTokens
		summary.Tokens.CacheReadTokens += r.CacheReadTokens
		summary.Tokens.CacheWriteTokens += r.CacheWriteTokens
		summary.Tokens.CacheWrite1hTokens += r.CacheWrite1hTokens
		summary.Tokens.ReasoningTokens += r.ReasoningTokens
		summary.Tokens.TotalTokens += tot
		summary.CostUSD += cost
		if r.MaxContextTokens > summary.MaxContextTokens {
			summary.MaxContextTokens = r.MaxContextTokens
		}
		summary.RequestCount += int64(r.RequestCount)
		summary.ToolCallCount += int64(r.ToolCallCount)
		for tn, tc := range r.ToolCalls {
			summary.ToolCalls[tn] += tc
		}
		if r.IsSubagent {
			summary.SubagentTokens += tot
			summary.SubagentCostUSD += cost
			subSet[r.SessionID] = struct{}{}
		}
		modelSet[canon] = struct{}{}
		hourSet[r.HourBucket] = struct{}{}
		if r.FirstEventAt.Before(summary.FirstEventAt) {
			summary.FirstEventAt = r.FirstEventAt
		}
		if r.LastEventAt.After(summary.LastEventAt) {
			summary.LastEventAt = r.LastEventAt
		}

		items = append(items, SessionHourItem{
			HourBucket:       r.HourBucket,
			SessionID:        r.SessionID,
			IsSubagent:       r.IsSubagent,
			ParentSessionID:  r.ParentSessionID,
			RawModel:         r.Model,
			Model:            canon,
			Provider:         r.Provider,
			Tokens:           tokens,
			CostUSD:          cost,
			MaxContextTokens: r.MaxContextTokens,
			RequestCount:     r.RequestCount,
			ToolCallCount:    r.ToolCallCount,
			ToolCalls:        r.ToolCalls,
			FirstEventAt:     r.FirstEventAt,
			LastEventAt:      r.LastEventAt,
		})
	}
	summary.Models = sortedKeys(modelSet)
	summary.HourCount = len(hourSet)
	summary.SubagentCount = len(subSet)
	return &SessionDetailResponse{Session: summary, Slices: items}, nil
}

func (s *Service) Tools(ctx context.Context, userID int64, filter QueryFilter) (*ToolsResponse, error) {
	slices, _, _, err := s.loadEnriched(ctx, userID, filter)
	if err != nil {
		return nil, err
	}

	type toolAgg struct {
		count   int64
		byAgent map[string]int64
	}
	byTool := map[string]*toolAgg{}
	var totalCalls int64

	for _, item := range slices {
		r := item.row
		for name, cnt := range r.ToolCalls {
			if cnt <= 0 {
				continue
			}
			t, ok := byTool[name]
			if !ok {
				t = &toolAgg{byAgent: map[string]int64{}}
				byTool[name] = t
			}
			t.count += int64(cnt)
			t.byAgent[r.Agent] += int64(cnt)
			totalCalls += int64(cnt)
		}
	}

	stats := make([]ToolStat, 0, len(byTool))
	for name, agg := range byTool {
		share := 0.0
		if totalCalls > 0 {
			share = float64(agg.count) / float64(totalCalls)
		}
		stats = append(stats, ToolStat{
			Name:    name,
			Count:   agg.count,
			Share:   share,
			ByAgent: agg.byAgent,
		})
	}
	sort.Slice(stats, func(i, j int) bool {
		if stats[i].Count != stats[j].Count {
			return stats[i].Count > stats[j].Count
		}
		return stats[i].Name < stats[j].Name
	})
	return &ToolsResponse{TotalCalls: totalCalls, Tools: stats}, nil
}

// Device management (OIDC session only)

func (s *Service) ListDevices(ctx context.Context, userID int64) ([]Device, error) {
	return s.store.ListDevices(ctx, userID)
}

func (s *Service) UpdateDevice(ctx context.Context, userID int64, deviceID string, in UpdateDeviceInput) (*Device, error) {
	deviceID = strings.TrimSpace(deviceID)
	name := truncateStr(strings.TrimSpace(in.Name), 120)
	if deviceID == "" {
		return nil, httpx.BadRequest("无效的设备 ID")
	}
	if name == "" {
		return nil, httpx.BadRequest("设备名称不能为空")
	}
	dev, err := s.store.UpdateDevice(ctx, userID, deviceID, name, in.Hidden)
	if err != nil {
		return nil, err
	}
	if dev == nil {
		return nil, httpx.NotFound("设备不存在")
	}
	return dev, nil
}

func (s *Service) DeleteDevice(ctx context.Context, userID int64, deviceID string) error {
	ok, err := s.store.DeleteDevice(ctx, userID, strings.TrimSpace(deviceID))
	if err != nil {
		return err
	}
	if !ok {
		return httpx.NotFound("设备不存在")
	}
	return nil
}

// Model alias management (OIDC session only)

func (s *Service) ListModelAliases(ctx context.Context, userID int64) ([]ModelAlias, error) {
	return s.store.ListModelAliases(ctx, userID)
}

func (s *Service) UpsertModelAlias(ctx context.Context, userID int64, in UpsertModelAliasInput) (*ModelAlias, error) {
	in.MatchPattern = truncateStr(strings.TrimSpace(in.MatchPattern), 160)
	in.CanonicalModel = truncateStr(strings.TrimSpace(in.CanonicalModel), 160)
	if in.MatchPattern == "" || in.CanonicalModel == "" {
		return nil, httpx.BadRequest("匹配模式与目标标准模型名不能为空")
	}
	if in.Priority == 0 {
		in.Priority = 100
	}
	return s.store.UpsertModelAlias(ctx, userID, in)
}

func (s *Service) DeleteModelAlias(ctx context.Context, userID, id int64) error {
	ok, err := s.store.DeleteModelAlias(ctx, userID, id)
	if err != nil {
		return err
	}
	if !ok {
		return httpx.NotFound("模型别名不存在")
	}
	return nil
}

// Model price management (OIDC session only)

func (s *Service) ListPrices(ctx context.Context, userID int64) (*PricesResponse, error) {
	custom, err := s.store.ListModelPrices(ctx, userID)
	if err != nil {
		return nil, err
	}
	return &PricesResponse{
		Custom:  custom,
		Builtin: DefaultModelPrices(),
	}, nil
}

func (s *Service) UpsertModelPrice(ctx context.Context, userID int64, in UpsertModelPriceInput) (*ModelPrice, error) {
	in.ModelPattern = truncateStr(strings.TrimSpace(in.ModelPattern), 160)
	if in.ModelPattern == "" {
		return nil, httpx.BadRequest("模型匹配模式不能为空")
	}
	if in.InputPerM < 0 || in.OutputPerM < 0 || in.CacheReadPerM < 0 || in.CacheWritePerM < 0 || in.CacheWrite1hPerM < 0 {
		return nil, httpx.BadRequest("单价不能为负数")
	}
	return s.store.UpsertModelPrice(ctx, userID, in)
}

func (s *Service) DeleteModelPrice(ctx context.Context, userID, id int64) error {
	ok, err := s.store.DeleteModelPrice(ctx, userID, id)
	if err != nil {
		return err
	}
	if !ok {
		return httpx.NotFound("自定义单价不存在")
	}
	return nil
}

// Helpers

type breakdownAgg struct {
	items    map[string]*BreakdownItem
	sessions map[string]map[string]struct{}
}

func newBreakdownAgg() *breakdownAgg {
	return &breakdownAgg{
		items:    map[string]*BreakdownItem{},
		sessions: map[string]map[string]struct{}{},
	}
}

func (b *breakdownAgg) add(key, label string, r HourlySessionRecord, costUSD float64, rootSess string) {
	item, ok := b.items[key]
	if !ok {
		item = &BreakdownItem{Key: key, Label: label}
		b.items[key] = item
		b.sessions[key] = map[string]struct{}{}
	}
	item.TotalTokens += r.TotalTokens()
	item.InputTokens += r.InputTokens
	item.OutputTokens += r.OutputTokens
	item.CacheReadTokens += r.CacheReadTokens
	item.CostUSD += costUSD
	item.RequestCount += int64(r.RequestCount)
	item.ToolCallCount += int64(r.ToolCallCount)
	b.sessions[key][rootSess] = struct{}{}
}

func (b *breakdownAgg) sorted() []BreakdownItem {
	out := make([]BreakdownItem, 0, len(b.items))
	for k, item := range b.items {
		item.SessionCount = len(b.sessions[k])
		out = append(out, *item)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].TotalTokens != out[j].TotalTokens {
			return out[i].TotalTokens > out[j].TotalTokens
		}
		return out[i].Key < out[j].Key
	})
	return out
}

func rootSessionKey(r HourlySessionRecord) string {
	sid := r.SessionID
	if r.IsSubagent && r.ParentSessionID != "" {
		sid = r.ParentSessionID
	}
	return r.DeviceID + "|" + r.Agent + "|" + sid
}

func loadTimezone(tz string) *time.Location {
	tz = strings.TrimSpace(tz)
	if tz == "" {
		return time.UTC
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return time.UTC
	}
	return loc
}

func formatBucket(t time.Time, granularity string) string {
	switch granularity {
	case "hour":
		return t.Format("2006-01-02 15:00")
	case "week":
		// ISO Monday start date
		weekday := int(t.Weekday())
		if weekday == 0 {
			weekday = 7
		}
		monday := t.AddDate(0, 0, -(weekday - 1))
		return monday.Format("2006-01-02")
	case "month":
		return t.Format("2006-01")
	default:
		return t.Format("2006-01-02")
	}
}

func heatmapLevel(tokens, maxTokens int64) int {
	if tokens <= 0 || maxTokens <= 0 {
		return 0
	}
	ratio := float64(tokens) / float64(maxTokens)
	switch {
	case ratio >= 0.75:
		return 4
	case ratio >= 0.45:
		return 3
	case ratio >= 0.20:
		return 2
	default:
		return 1
	}
}

func sortedKeys(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func truncateStr(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}
