package screen_time

import (
	"sort"
	"strings"
	"time"
)

const DefaultTimeoutMinutes = 15

func normalizeTimeoutMinutes(v int) int {
	if v < 1 || v > 120 {
		return DefaultTimeoutMinutes
	}
	return v
}

// NormalizeCategory converts WakaTime raw heartbeat category strings (e.g. "coding", "writing tests")
// into the Title Case format returned by /summaries ("Coding", "Writing Tests").
func NormalizeCategory(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "Coding"
	}
	words := strings.Fields(strings.ToLower(trimmed))
	for i, w := range words {
		if len(w) > 0 {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	return strings.Join(words, " ")
}

// ResolveHeartbeat strips privacy/noisy fields (entity, dependencies, branch, lines) and resolves
// machine_name_id / user_agent_id into readable dimension labels.
func ResolveHeartbeat(
	userID int64,
	statDate time.Time,
	raw WakaHeartbeat,
	machines map[string]string,
	userAgents map[string]WakaUserAgent,
) HeartbeatRecord {
	project := strings.TrimSpace(raw.Project)
	if project == "" {
		project = "Unknown"
	}
	language := strings.TrimSpace(raw.Language)
	if language == "" {
		language = "Other"
	}
	editor := strings.TrimSpace(raw.Editor)
	osName := strings.TrimSpace(raw.OS)
	if (editor == "" || osName == "") && raw.UserAgentID != "" && userAgents != nil {
		if ua, ok := userAgents[raw.UserAgentID]; ok {
			if editor == "" {
				editor = strings.TrimSpace(ua.Editor)
			}
			if osName == "" {
				osName = strings.TrimSpace(ua.OS)
			}
		}
	}
	if editor == "" {
		editor = "Unknown"
	}
	if osName == "" {
		osName = "Unknown"
	}

	machine := strings.TrimSpace(raw.Machine)
	if machine == "" && raw.MachineNameID != "" && machines != nil {
		machine = strings.TrimSpace(machines[raw.MachineNameID])
	}
	if machine == "" {
		machine = "Unknown"
	}

	return HeartbeatRecord{
		UserID:      userID,
		StatDate:    statDate,
		HeartbeatAt: raw.Time.UTC(),
		Project:     project,
		Language:    language,
		Editor:      editor,
		OS:          osName,
		Category:    NormalizeCategory(raw.Category),
		Machine:     machine,
	}
}

// AggregateDayHeartbeats computes daily total seconds, 6-dimension breakdowns, and continuous
// project-sliced duration blocks using WakaTime's keystroke timeout algorithm.
func AggregateDayHeartbeats(
	userID int64,
	statDate time.Time,
	hbs []HeartbeatRecord,
	timeoutMinutes int,
) (float64, []DimensionRecord, []DurationRecord) {
	if len(hbs) == 0 {
		return 0, nil, nil
	}
	sorted := append([]HeartbeatRecord(nil), hbs...)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].HeartbeatAt.Before(sorted[j].HeartbeatAt)
	})

	timeoutSec := float64(normalizeTimeoutMinutes(timeoutMinutes) * 60)

	type dimKey struct {
		dim  string
		name string
	}
	dimTotals := make(map[dimKey]float64)
	addDim := func(dim, name string, sec float64) {
		if sec <= 0 {
			return
		}
		n := strings.TrimSpace(name)
		if n == "" {
			n = "Unknown"
		}
		dimTotals[dimKey{dim: dim, name: n}] += sec
	}

	var totalSec float64
	durations := make([]DurationRecord, 0, 16)

	blockStart := sorted[0].HeartbeatAt
	blockProject := sorted[0].Project
	blockDur := 0.0

	flushBlock := func() {
		if blockDur > 0 {
			durations = append(durations, DurationRecord{
				UserID:          userID,
				StatDate:        statDate,
				StartedAt:       blockStart,
				DurationSeconds: blockDur,
				Project:         blockProject,
			})
		}
	}

	for i := 1; i < len(sorted); i++ {
		prev := sorted[i-1]
		cur := sorted[i]
		delta := cur.HeartbeatAt.Sub(prev.HeartbeatAt).Seconds()
		if delta <= 0 {
			continue
		}
		if delta <= timeoutSec {
			totalSec += delta
			addDim("project", prev.Project, delta)
			addDim("language", prev.Language, delta)
			addDim("editor", prev.Editor, delta)
			addDim("os", prev.OS, delta)
			addDim("category", prev.Category, delta)
			addDim("machine", prev.Machine, delta)

			if prev.Project == blockProject {
				blockDur += delta
			} else {
				flushBlock()
				blockStart = prev.HeartbeatAt
				blockProject = prev.Project
				blockDur = delta
			}

			if cur.Project != blockProject {
				flushBlock()
				blockStart = cur.HeartbeatAt
				blockProject = cur.Project
				blockDur = 0
			}
		} else {
			flushBlock()
			blockStart = cur.HeartbeatAt
			blockProject = cur.Project
			blockDur = 0
		}
	}
	flushBlock()

	dims := make([]DimensionRecord, 0, len(dimTotals))
	for k, sec := range dimTotals {
		dims = append(dims, DimensionRecord{
			UserID:       userID,
			StatDate:     statDate,
			Dimension:    k.dim,
			Name:         k.name,
			TotalSeconds: sec,
		})
	}
	sort.Slice(dims, func(i, j int) bool {
		if dims[i].Dimension != dims[j].Dimension {
			return dims[i].Dimension < dims[j].Dimension
		}
		if dims[i].TotalSeconds != dims[j].TotalSeconds {
			return dims[i].TotalSeconds > dims[j].TotalSeconds
		}
		return dims[i].Name < dims[j].Name
	})

	return totalSec, dims, durations
}
