import { formatDateTimeInTimezone, getActiveUserTimezone } from '@/core/timezone';
import type { TimelineBlock } from './api';

export const SERIES_COLORS = [
  '#38bdf8',
  '#60a5fa',
  '#34d399',
  '#fbbf24',
  '#a78bfa',
  '#f472b6',
  '#2dd4bf',
  '#cbd5e1',
];

export const HEATMAP_CLASSES = [
  'bg-zinc-100',
  'bg-sky-100',
  'bg-sky-200',
  'bg-sky-400',
  'bg-sky-500',
];

export type ChartScaleMode = 'linear' | 'log';

export interface AxisTick {
  value: number;
  label: string;
  pct: number; // 0..100 from bottom
}

export interface AxisScale {
  ticks: AxisTick[];
  toPct: (val: number) => number;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  const totalMin = Math.round(seconds / 60);
  if (totalMin <= 0) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function formatDurationCompact(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0';
  const hours = seconds / 3600;
  if (hours >= 10) return `${Math.round(hours)}h`;
  if (hours >= 1) return `${Number(hours.toFixed(1))}h`;
  const mins = Math.round(seconds / 60);
  return `${Math.max(1, mins)}m`;
}

export function formatPercent(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return '0.0%';
  return `${pct.toFixed(1)}%`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

export function formatClockTime(iso: string, tz = getActiveUserTimezone()): string {
  return formatDateTimeInTimezone(iso, tz, {
    year: undefined,
    month: undefined,
    day: undefined,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatSyncTime(iso?: string, tz = getActiveUserTimezone()): string {
  if (!iso) return '尚未同步';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso;
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  return formatDateTimeInTimezone(iso, tz, {
    year: undefined,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function shiftDateISO(dateISO: string, deltaDays: number): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const sy = shifted.getUTCFullYear();
  const sm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const sd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${sy}-${sm}-${sd}`;
}

export function colorForProject(name: string, explicitColor?: string, indexMap?: Map<string, number>): string {
  if (explicitColor && /^#[0-9a-fA-F]{3,8}$/.test(explicitColor)) {
    return explicitColor;
  }
  if (name === '其他') return '#cbd5e1';
  if (indexMap && indexMap.has(name)) {
    return SERIES_COLORS[indexMap.get(name)! % (SERIES_COLORS.length - 1)];
  }
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return SERIES_COLORS[Math.abs(hash) % (SERIES_COLORS.length - 1)];
}

const NICE_DURATION_STEPS_SEC = [
  60, // 1m
  300, // 5m
  600, // 10m
  900, // 15m
  1800, // 30m
  3600, // 1h
  7200, // 2h
  10800, // 3h
  14400, // 4h
  18000, // 5h
  21600, // 6h
  28800, // 8h
  36000, // 10h
  54000, // 15h
  72000, // 20h
  108000, // 30h
  144000, // 40h
  180000, // 50h
  288000, // 80h
  360000, // 100h
  720000, // 200h
];

const LOG_DURATION_TICKS_SEC = [
  60, // 1m
  300, // 5m
  900, // 15m
  3600, // 1h
  14400, // 4h
  43200, // 12h
  172800, // 48h
  576000, // 160h
  1800000, // 500h
];

export function buildDurationAxisScale(
  values: number[],
  mode: ChartScaleMode,
  options?: { maxTicks?: number; minVisiblePct?: number },
): AxisScale {
  const maxTicks = options?.maxTicks ?? 5;
  const minVisiblePct = options?.minVisiblePct ?? 2;
  const positives = values.filter((v) => Number.isFinite(v) && v > 0);
  if (positives.length === 0) {
    return { ticks: [], toPct: () => 0 };
  }

  const maxPos = Math.max(...positives);
  const minPos = Math.min(...positives);

  if (mode === 'linear') {
    const rawStep = maxPos / Math.max(1, maxTicks - 1);
    let step = NICE_DURATION_STEPS_SEC.find((s) => s >= rawStep);
    if (!step) {
      const hours = rawStep / 3600;
      const mag = Math.pow(10, Math.floor(Math.log10(hours)));
      const norm = hours / mag;
      const niceMult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
      step = niceMult * mag * 3600;
    }
    const steps = Math.max(1, Math.ceil(maxPos / step));
    const niceMax = steps * step;
    const ticks: AxisTick[] = [];
    for (let i = 0; i <= steps; i++) {
      const value = i * step;
      ticks.push({
        value,
        label: value === 0 ? '0' : formatDurationCompact(value),
        pct: (i / steps) * 100,
      });
    }
    return {
      ticks,
      toPct: (val: number) => {
        if (!Number.isFinite(val) || val <= 0 || niceMax <= 0) return 0;
        return Math.min(100, Math.max(minVisiblePct, (val / niceMax) * 100));
      },
    };
  }

  // Logarithmic duration scale anchored on clean human-friendly time landmarks
  let minIdx = 0;
  for (let i = LOG_DURATION_TICKS_SEC.length - 1; i >= 0; i--) {
    if (LOG_DURATION_TICKS_SEC[i] <= minPos) {
      minIdx = i;
      break;
    }
  }
  let maxIdx = LOG_DURATION_TICKS_SEC.findIndex((t) => t >= maxPos);
  if (maxIdx === -1) maxIdx = LOG_DURATION_TICKS_SEC.length - 1;
  if (minIdx >= maxIdx) {
    if (maxIdx > 0) minIdx = maxIdx - 1;
    else maxIdx = Math.min(LOG_DURATION_TICKS_SEC.length - 1, minIdx + 1);
  }
  if (minIdx > 0 && Math.log10(minPos) - Math.log10(LOG_DURATION_TICKS_SEC[minIdx]) < 0.12) {
    minIdx -= 1;
  }

  const minVal = LOG_DURATION_TICKS_SEC[minIdx];
  const maxVal = LOG_DURATION_TICKS_SEC[maxIdx];
  const logMin = Math.log10(minVal);
  const logMax = Math.log10(maxVal);
  const logSpan = Math.max(0.1, logMax - logMin);

  const selected = LOG_DURATION_TICKS_SEC.slice(minIdx, maxIdx + 1);
  const step = Math.max(1, Math.ceil(selected.length / maxTicks));
  const ticks: AxisTick[] = [];
  selected.forEach((value, idx) => {
    if (idx === 0 || idx === selected.length - 1 || idx % step === 0) {
      ticks.push({
        value,
        label: formatDurationCompact(value),
        pct: ((Math.log10(value) - logMin) / logSpan) * 100,
      });
    }
  });

  return {
    ticks,
    toPct: (val: number) => {
      if (!Number.isFinite(val) || val <= 0) return 0;
      const pct = ((Math.log10(Math.max(val, minVal)) - logMin) / logSpan) * 100;
      return Math.min(100, Math.max(minVisiblePct, pct));
    },
  };
}

export interface UnifiedTimelineBlock {
  started_at: string;
  ended_at: string;
  start_minute: number;
  end_minute: number;
  active_seconds: number;
  projects: Array<{ project: string; seconds: number }>;
}

export interface ProjectTimelineBlock {
  started_at: string;
  ended_at: string;
  start_minute: number;
  end_minute: number;
  active_seconds: number;
}

export interface ProjectTimelineLane {
  project: string;
  total_seconds: number;
  blocks: ProjectTimelineBlock[];
}

const TIMELINE_MERGE_GAP_MIN = 5;
const UNIFIED_MIN_SPECK_SEC = 30;

/**
 * Merges all active coding blocks across every project into unified coding sessions
 * (merging gaps <= 5 minutes) for a single-color overview bar without inflating active time.
 */
export function coalesceUnifiedTimeline(rawBlocks: TimelineBlock[]): UnifiedTimelineBlock[] {
  if (!rawBlocks || rawBlocks.length === 0) return [];
  const sorted = [...rawBlocks]
    .filter((b) => b.duration_seconds > 0 && b.end_minute > b.start_minute)
    .sort((a, b) => a.start_minute - b.start_minute);
  if (sorted.length === 0) return [];

  interface WorkSession {
    started_at: string;
    ended_at: string;
    start_minute: number;
    end_minute: number;
    active_seconds: number;
    projMap: Map<string, number>;
  }

  const sessions: WorkSession[] = [];
  for (const b of sorted) {
    const proj = b.project || 'Unknown';
    const prev = sessions[sessions.length - 1];
    if (prev && b.start_minute - prev.end_minute <= TIMELINE_MERGE_GAP_MIN) {
      if (b.end_minute > prev.end_minute) {
        prev.end_minute = b.end_minute;
        prev.ended_at = b.ended_at;
      }
      prev.active_seconds += b.duration_seconds;
      prev.projMap.set(proj, (prev.projMap.get(proj) ?? 0) + b.duration_seconds);
    } else {
      const m = new Map<string, number>();
      m.set(proj, b.duration_seconds);
      sessions.push({
        started_at: b.started_at,
        ended_at: b.ended_at,
        start_minute: b.start_minute,
        end_minute: b.end_minute,
        active_seconds: b.duration_seconds,
        projMap: m,
      });
    }
  }

  const substantial = sessions.filter((s) => s.active_seconds >= UNIFIED_MIN_SPECK_SEC);
  const chosen = substantial.length > 0 ? substantial : sessions;

  return chosen.map((s) => ({
    started_at: s.started_at,
    ended_at: s.ended_at,
    start_minute: s.start_minute,
    end_minute: s.end_minute,
    active_seconds: s.active_seconds,
    projects: Array.from(s.projMap.entries())
      .map(([project, seconds]) => ({ project, seconds }))
      .sort((a, b) => b.seconds - a.seconds),
  }));
}

/**
 * Builds one clean coalesced timeline lane per project (merging same-project gaps <= 5 minutes).
 */
export function coalesceProjectTimelines(
  rawBlocks: TimelineBlock[],
  projectOrder: string[] = [],
): ProjectTimelineLane[] {
  if (!rawBlocks || rawBlocks.length === 0) return [];
  const byProject = new Map<string, TimelineBlock[]>();
  for (const b of rawBlocks) {
    if (b.duration_seconds <= 0 || b.end_minute <= b.start_minute) continue;
    const proj = b.project || 'Unknown';
    const list = byProject.get(proj);
    if (list) list.push(b);
    else byProject.set(proj, [b]);
  }

  const lanes: ProjectTimelineLane[] = [];
  for (const [project, list] of byProject.entries()) {
    list.sort((a, b) => a.start_minute - b.start_minute);
    const merged: ProjectTimelineBlock[] = [];
    let totalSec = 0;
    for (const b of list) {
      totalSec += b.duration_seconds;
      const prev = merged[merged.length - 1];
      if (prev && b.start_minute - prev.end_minute <= TIMELINE_MERGE_GAP_MIN) {
        if (b.end_minute > prev.end_minute) {
          prev.end_minute = b.end_minute;
          prev.ended_at = b.ended_at;
        }
        prev.active_seconds += b.duration_seconds;
      } else {
        merged.push({
          started_at: b.started_at,
          ended_at: b.ended_at,
          start_minute: b.start_minute,
          end_minute: b.end_minute,
          active_seconds: b.duration_seconds,
        });
      }
    }
    lanes.push({ project, total_seconds: totalSec, blocks: merged });
  }

  const orderMap = new Map<string, number>();
  projectOrder.forEach((name, idx) => orderMap.set(name, idx));
  lanes.sort((a, b) => {
    const ai = orderMap.get(a.project);
    const bi = orderMap.get(b.project);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return b.total_seconds - a.total_seconds;
  });

  return lanes;
}
