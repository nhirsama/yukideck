package screen_time

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"yukideck/internal/core/auth"
	"yukideck/internal/core/httpx"
)

const (
	defaultDumpPollInterval   = 4 * time.Second
	maxDumpWaitDuration       = 10 * time.Minute
	historyBatchMaxDays       = 30
	historyBatchMaxHeartbeats = 15000
)

func (s *Service) GetHistoryImportStatus(userID int64) HistoryImportStatus {
	s.historyMu.Lock()
	defer s.historyMu.Unlock()
	st, ok := s.historyJobs[userID]
	if !ok || st == nil {
		return HistoryImportStatus{
			Running: false,
			Stage:   "idle",
		}
	}
	cp := *st
	return cp
}

func (s *Service) setHistoryStatus(userID int64, fn func(st *HistoryImportStatus)) HistoryImportStatus {
	s.historyMu.Lock()
	defer s.historyMu.Unlock()
	st := s.historyJobs[userID]
	if st == nil {
		st = &HistoryImportStatus{Stage: "idle"}
		s.historyJobs[userID] = st
	}
	fn(st)
	cp := *st
	return cp
}

// StartHistoryImport kicks off an asynchronous WakaTime heartbeats data_dump import.
// If history was never imported before, it imports all available days since account creation ("full").
// Otherwise it only fills missing gap dates ("gap") while leaving already archived dates untouched.
func (s *Service) StartHistoryImport(ctx context.Context, userID int64, userTZ string) (HistoryImportStatus, error) {
	cfg, err := s.store.GetConfig(ctx, userID)
	if err != nil {
		return HistoryImportStatus{}, httpx.Internal("读取配置失败", err)
	}
	if cfg == nil || cfg.APIKeyEnc == "" {
		return HistoryImportStatus{}, httpx.BadRequest("请先保存 WakaTime API Key")
	}

	s.historyMu.Lock()
	if cur := s.historyJobs[userID]; cur != nil && cur.Running {
		cp := *cur
		s.historyMu.Unlock()
		return cp, nil
	}
	now := s.now()
	mode := "full"
	if cfg.HistoryImportedAt != nil {
		mode = "gap"
	}
	initStatus := &HistoryImportStatus{
		Running:   true,
		Mode:      mode,
		Stage:     "requesting",
		Percent:   3,
		Message:   "正在向 WakaTime 请求历史心跳导出…",
		StartedAt: &now,
	}
	s.historyJobs[userID] = initStatus
	cp := *initStatus
	s.historyMu.Unlock()

	tzCopy := auth.NormalizeTimezone(userTZ)
	if s.asyncHistoryImport {
		go func() {
			runCtx, cancel := context.WithTimeout(context.Background(), maxDumpWaitDuration+5*time.Minute)
			defer cancel()
			s.runHistoryImport(runCtx, userID, tzCopy, mode)
		}()
	} else {
		s.runHistoryImport(ctx, userID, tzCopy, mode)
		return s.GetHistoryImportStatus(userID), nil
	}

	return cp, nil
}

func (s *Service) failHistoryImport(userID int64, err error) {
	now := s.now()
	msg := err.Error()
	if errors.Is(err, ErrAuthFailed) {
		msg = err.Error()
	}
	s.setHistoryStatus(userID, func(st *HistoryImportStatus) {
		st.Running = false
		st.Stage = "failed"
		st.Error = msg
		st.Message = "历史数据同步失败"
		st.FinishedAt = &now
	})
}

func findReusableHeartbeatDump(dumps []WakaDataDump, now time.Time) (completed *WakaDataDump, processing *WakaDataDump) {
	for i := range dumps {
		d := dumps[i]
		if d.Type != "heartbeats" || d.HasFailed || d.IsStuck {
			continue
		}
		if d.Expires != nil && !d.Expires.After(now) {
			continue
		}
		if strings.EqualFold(d.Status, "Completed") && d.DownloadURL != "" {
			if completed == nil {
				cp := d
				completed = &cp
			}
			continue
		}
		if d.IsProcessing || strings.Contains(strings.ToLower(d.Status), "pending") || strings.Contains(strings.ToLower(d.Status), "processing") || strings.Contains(strings.ToLower(d.Status), "uploading") {
			if processing == nil {
				cp := d
				processing = &cp
			}
		}
	}
	return completed, processing
}

func (s *Service) runHistoryImport(ctx context.Context, userID int64, userTZ, mode string) {
	cfg, err := s.store.GetConfig(ctx, userID)
	if err != nil || cfg == nil || cfg.APIKeyEnc == "" {
		if err == nil {
			err = errors.New("未配置 WakaTime API Key")
		}
		s.failHistoryImport(userID, err)
		return
	}

	plainKey, err := s.box.Decrypt(cfg.APIKeyEnc)
	if err != nil {
		s.failHistoryImport(userID, fmt.Errorf("解密 WakaTime API Key 失败: %w", err))
		return
	}
	apiKey := string(plainKey)
	baseURL := cfg.APIBaseURL
	if strings.TrimSpace(baseURL) == "" {
		baseURL = DefaultWakaTimeBaseURL
	}
	_, tzName := loadLocationOrDefault(userTZ)

	// 1. Fetch user timeout, machine names, and user agents up front so heartbeats resolve cleanly.
	timeoutMin := normalizeTimeoutMinutes(cfg.TimeoutMinutes)
	if u, uErr := s.client.GetCurrentUser(ctx, baseURL, apiKey); uErr == nil && u != nil {
		if u.Timeout > 0 {
			timeoutMin = normalizeTimeoutMinutes(u.Timeout)
		}
	}
	machines, _ := s.client.GetMachineNames(ctx, baseURL, apiKey)
	userAgents, _ := s.client.GetUserAgents(ctx, baseURL, apiKey)

	// 2. Check existing dumps; reuse an unexpired Completed or active processing heartbeats dump if available.
	dumps, err := s.client.ListDataDumps(ctx, baseURL, apiKey)
	if err != nil {
		s.failHistoryImport(userID, fmt.Errorf("查询 WakaTime 导出列表失败: %w", err))
		return
	}

	completed, processing := findReusableHeartbeatDump(dumps, s.now())
	var targetDump *WakaDataDump
	switch {
	case completed != nil:
		targetDump = completed
	case processing != nil:
		targetDump = processing
	default:
		created, createErr := s.client.CreateDataDump(ctx, baseURL, apiKey, "heartbeats")
		if createErr != nil {
			s.failHistoryImport(userID, fmt.Errorf("发起 WakaTime 历史导出失败: %w", createErr))
			return
		}
		targetDump = created
	}

	// 3. Poll until WakaTime finishes generating the dump.
	pollInterval := s.dumpPollInterval
	if pollInterval <= 0 {
		pollInterval = defaultDumpPollInterval
	}
	waitDeadline := time.Now().Add(maxDumpWaitDuration)
	for targetDump.DownloadURL == "" || !strings.EqualFold(targetDump.Status, "Completed") {
		if targetDump.HasFailed || targetDump.IsStuck {
			s.failHistoryImport(userID, errors.New("WakaTime 后台导出任务失败或卡住，请稍后重试"))
			return
		}
		if time.Now().After(waitDeadline) {
			s.failHistoryImport(userID, errors.New("等待 WakaTime 导出超时，请稍后再试"))
			return
		}
		expPct := math.Max(0, math.Min(100, targetDump.PercentComplete))
		overall := 5 + expPct*0.50 // 5% -> 55%
		statusText := targetDump.Status
		if statusText == "" {
			statusText = "正在排队导出…"
		}
		s.setHistoryStatus(userID, func(st *HistoryImportStatus) {
			st.Stage = "exporting"
			st.ExportPercent = math.Round(expPct*10) / 10
			st.Percent = math.Round(overall*10) / 10
			st.Message = fmt.Sprintf("WakaTime 后台导出中（%.0f%% · %s）", expPct, statusText)
		})

		select {
		case <-time.After(pollInterval):
		case <-ctx.Done():
			s.failHistoryImport(userID, ctx.Err())
			return
		}

		latestDumps, listErr := s.client.ListDataDumps(ctx, baseURL, apiKey)
		if listErr != nil {
			s.failHistoryImport(userID, fmt.Errorf("查询导出进度失败: %w", listErr))
			return
		}
		var matched *WakaDataDump
		for i := range latestDumps {
			if targetDump.ID != "" && latestDumps[i].ID == targetDump.ID {
				cp := latestDumps[i]
				matched = &cp
				break
			}
		}
		if matched == nil {
			c, p := findReusableHeartbeatDump(latestDumps, s.now())
			if c != nil {
				matched = c
			} else if p != nil {
				matched = p
			}
		}
		if matched == nil {
			s.failHistoryImport(userID, errors.New("未找到进行中的 WakaTime 导出任务"))
			return
		}
		targetDump = matched
	}

	// 4. Prepare existing date index when running in gap-fill mode.
	existingDates := make(map[string]bool)
	if mode == "gap" {
		allTotals, listErr := s.store.ListAllDailyTotals(ctx, userID)
		if listErr != nil {
			s.failHistoryImport(userID, fmt.Errorf("查询本地历史记录失败: %w", listErr))
			return
		}
		for _, r := range allTotals {
			existingDates[formatDate(r.StatDate)] = true
		}
	}

	s.setHistoryStatus(userID, func(st *HistoryImportStatus) {
		st.Stage = "downloading"
		st.ExportPercent = 100
		st.Percent = 55
		st.Message = "导出完成，正在流式下载并解析心跳数据…"
	})

	// 5. Stream download, resolve, aggregate & bulk-persist via COPY FROM batches.
	daysProcessed := 0
	daysImported := 0
	daysSkipped := 0
	var heartbeatsImported int64
	var latestDumpDate time.Time

	pendingDays := make([]DayDataBatchItem, 0, historyBatchMaxDays)
	pendingHeartbeats := 0

	flushPending := func() error {
		if len(pendingDays) == 0 {
			return nil
		}
		if err := s.store.ReplaceDaysBatch(ctx, userID, pendingDays); err != nil {
			return err
		}
		daysImported += len(pendingDays)
		heartbeatsImported += int64(pendingHeartbeats)
		pendingDays = pendingDays[:0]
		pendingHeartbeats = 0

		s.setHistoryStatus(userID, func(st *HistoryImportStatus) {
			st.DaysProcessed = daysProcessed
			st.DaysImported = daysImported
			st.DaysSkipped = daysSkipped
			st.HeartbeatsImported = heartbeatsImported
			if mode == "gap" {
				st.Message = fmt.Sprintf("正在批量补齐空白日期（已扫描 %d 天，补齐 %d 天 / %d 条心跳）…", daysProcessed, daysImported, heartbeatsImported)
			} else {
				st.Message = fmt.Sprintf("正在流式解析并批量写入（已导入 %d 天 / %d 条心跳）…", daysImported, heartbeatsImported)
			}
		})
		return nil
	}

	dlErr := s.client.DownloadHeartbeatDump(
		ctx,
		targetDump.DownloadURL,
		baseURL,
		apiKey,
		func(bytesRead, totalBytes int64) {
			s.setHistoryStatus(userID, func(st *HistoryImportStatus) {
				st.BytesDownloaded = bytesRead
				st.TotalBytes = totalBytes
				if totalBytes > 0 {
					ratio := math.Min(1, float64(bytesRead)/float64(totalBytes))
					st.Percent = math.Round((55+ratio*37)*10) / 10 // 55% -> 92%
				} else {
					// Asymptotic fallback when Content-Length is omitted (chunked encoding)
					ratio := 1 - math.Exp(-float64(bytesRead)/float64(15<<20))
					st.Percent = math.Round((55+ratio*35)*10) / 10
				}
			})
		},
		func(day WakaHeartbeatDumpDay) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			statDate, parseErr := parseDateStrict(day.Date)
			if parseErr != nil {
				return nil
			}
			daysProcessed++
			if statDate.After(latestDumpDate) {
				latestDumpDate = statDate
			}

			// In gap mode, skip days already present in local archive.
			if mode == "gap" && existingDates[day.Date] {
				daysSkipped++
				if daysProcessed%20 == 0 {
					s.setHistoryStatus(userID, func(st *HistoryImportStatus) {
						st.DaysProcessed = daysProcessed
						st.DaysImported = daysImported
						st.DaysSkipped = daysSkipped
						st.HeartbeatsImported = heartbeatsImported
						st.Message = fmt.Sprintf("正在扫描并补齐缺口（已扫描 %d 天，补齐 %d 天）…", daysProcessed, daysImported)
					})
				}
				return nil
			}

			resolved := make([]HeartbeatRecord, 0, len(day.Heartbeats))
			for _, raw := range day.Heartbeats {
				resolved = append(resolved, ResolveHeartbeat(userID, statDate, raw, machines, userAgents))
			}

			totalSec, dims, durations := AggregateDayHeartbeats(userID, statDate, resolved, timeoutMin)
			pendingDays = append(pendingDays, DayDataBatchItem{
				StatDate:          statDate,
				TotalSeconds:      totalSec,
				Timezone:          tzName,
				Dims:              dims,
				Durations:         durations,
				ReplaceDurations:  true,
				Heartbeats:        resolved,
				ReplaceHeartbeats: true,
			})
			pendingHeartbeats += len(resolved)

			if len(pendingDays) >= historyBatchMaxDays || pendingHeartbeats >= historyBatchMaxHeartbeats {
				return flushPending()
			}
			if daysProcessed%5 == 0 {
				s.setHistoryStatus(userID, func(st *HistoryImportStatus) {
					st.DaysProcessed = daysProcessed
					st.DaysImported = daysImported
					st.DaysSkipped = daysSkipped
					st.HeartbeatsImported = heartbeatsImported
				})
			}
			return nil
		},
	)
	if dlErr == nil {
		dlErr = flushPending()
	}
	if dlErr != nil {
		s.failHistoryImport(userID, fmt.Errorf("流式导入历史心跳失败: %w", dlErr))
		return
	}

	// 6. Finalize: sync only the tail days after the dump (typically yesterday + today, capped at ScheduledSyncDays).
	tailDays := ScheduledSyncDays
	if !latestDumpDate.IsZero() {
		today := todayDateInTZ(s.now(), tzName)
		diff := int(today.Sub(latestDumpDate)/(24*time.Hour)) + 1
		if diff < 2 {
			diff = 2
		}
		if diff < tailDays {
			tailDays = diff
		}
	}
	s.setHistoryStatus(userID, func(st *HistoryImportStatus) {
		st.Stage = "finalizing"
		st.Percent = 94
		st.DaysProcessed = daysProcessed
		st.DaysImported = daysImported
		st.DaysSkipped = daysSkipped
		st.HeartbeatsImported = heartbeatsImported
		st.Message = fmt.Sprintf("正在同步最近 %d 天最新数据并校验收尾…", tailDays)
	})

	_, _ = s.SyncRecentDays(ctx, userID, tzName, tailDays, false)

	doneAt := s.now()
	_ = s.store.MarkHistoryImported(ctx, userID, doneAt)

	s.setHistoryStatus(userID, func(st *HistoryImportStatus) {
		st.Running = false
		st.Stage = "completed"
		st.Percent = 100
		st.DaysProcessed = daysProcessed
		st.DaysImported = daysImported
		st.DaysSkipped = daysSkipped
		st.HeartbeatsImported = heartbeatsImported
		st.FinishedAt = &doneAt
		if mode == "gap" {
			if daysImported == 0 {
				st.Message = fmt.Sprintf("扫描 %d 天完成，本地历史完整无缺口", daysProcessed)
			} else {
				st.Message = fmt.Sprintf("缺口补齐完成：新增 %d 天（%d 条心跳），跳过 %d 天已有记录", daysImported, heartbeatsImported, daysSkipped)
			}
		} else {
			st.Message = fmt.Sprintf("全量历史导入完成：共导入 %d 天（%d 条心跳）", daysImported, heartbeatsImported)
		}
	})
}
