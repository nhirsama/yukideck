import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Calendar,
  ChevronDown,
  Clock,
  Flame,
  Loader2,
  Settings,
  Trophy,
} from 'lucide-react';
import { DatePicker } from '@/components/DatePicker';
import {
  HeatmapRangeOverlay,
  useTemporaryRangeHighlight,
} from '@/components/HeatmapRangeOverlay';
import { LoadingState } from '@/components/LoadingState';
import { Select } from '@/components/Select';
import { Tooltip } from '@/components/Tooltip';
import { useAuth } from '@/core/auth';
import { isTouchPrimary } from '@/core/responsive';
import { getDateOffsetISOInTimezone, useUserTimezone } from '@/core/timezone';
import {
  screenTimeApi,
  type BreakdownItem,
  type HeatmapDay,
  type TrendGranularity,
  type TrendGroupBy,
} from './api';
import {
  buildDurationAxisScale,
  coalesceProjectTimelines,
  coalesceUnifiedTimeline,
  colorForProject,
  formatClockTime,
  formatDuration,
  formatPercent,
  formatSyncTime,
  HEATMAP_CLASSES,
  SERIES_COLORS,
  type ChartScaleMode,
} from './format';

type RangePreset = 'today' | '7d' | '30d' | '90d' | '365d';
type BreakdownTab = 'project' | 'language' | 'editor' | 'category' | 'machine' | 'os';

const PRESET_OPTIONS: Array<{ key: RangePreset; label: string }> = [
  { key: 'today', label: '今日' },
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: '90d', label: '近 90 天' },
  { key: '365d', label: '近 1 年' },
];

const GROUP_BY_OPTIONS: Array<{ value: TrendGroupBy; label: string }> = [
  { value: 'project', label: '按项目堆叠' },
  { value: 'language', label: '按语言堆叠' },
  { value: 'editor', label: '按编辑器堆叠' },
  { value: 'category', label: '按分类堆叠' },
  { value: 'machine', label: '按设备堆叠' },
  { value: 'os', label: '按系统堆叠' },
  { value: 'total', label: '总计' },
];

const BREAKDOWN_TABS: Array<{ key: BreakdownTab; label: string }> = [
  { key: 'project', label: '项目' },
  { key: 'language', label: '语言' },
  { key: 'editor', label: '编辑器' },
  { key: 'category', label: '分类' },
  { key: 'machine', label: '设备' },
  { key: 'os', label: '系统' },
];

function computePresetDates(preset: RangePreset, tz: string): { start: string; end: string } {
  const today = getDateOffsetISOInTimezone(0, tz);
  switch (preset) {
    case 'today':
      return { start: today, end: today };
    case '7d':
      return { start: getDateOffsetISOInTimezone(-6, tz), end: today };
    case '30d':
      return { start: getDateOffsetISOInTimezone(-29, tz), end: today };
    case '90d':
      return { start: getDateOffsetISOInTimezone(-89, tz), end: today };
    case '365d':
      return { start: getDateOffsetISOInTimezone(-364, tz), end: today };
  }
}

function diffDaysInclusive(startISO: string, endISO: string): number {
  const [sy, sm, sd] = startISO.split('-').map(Number);
  const [ey, em, ed] = endISO.split('-').map(Number);
  if (!sy || !sm || !sd || !ey || !em || !ed) return 0;
  const s = Date.UTC(sy, sm - 1, sd);
  const e = Date.UTC(ey, em - 1, ed);
  return Math.max(0, Math.round((e - s) / 86_400_000) + 1);
}

export default function ScreenTimePage() {
  const qc = useQueryClient();
  const { isAuthenticated } = useAuth();
  const tz = useUserTimezone();
  const todayISO = useMemo(() => getDateOffsetISOInTimezone(0, tz), [tz]);

  const [preset, setPreset] = useState<RangePreset | null>('30d');
  const [startDate, setStartDate] = useState(() => computePresetDates('30d', tz).start);
  const [endDate, setEndDate] = useState(() => computePresetDates('30d', tz).end);
  const [granularity, setGranularity] = useState<TrendGranularity>('day');
  const [groupBy, setGroupBy] = useState<TrendGroupBy>('project');
  const [scaleMode, setScaleMode] = useState<ChartScaleMode>('linear');
  const [heatmapYear, setHeatmapYear] = useState<number>(0); // 0 = rolling 365 days
  const [timelineDate, setTimelineDate] = useState<string>(() => getDateOffsetISOInTimezone(0, tz));
  const [breakdownTab, setBreakdownTab] = useState<BreakdownTab>('project');

  const [syncingVisit, setSyncingVisit] = useState(false);
  const [activeTrendBucket, setActiveTrendBucket] = useState<string | null>(null);
  const [activeHeatmapDate, setActiveHeatmapDate] = useState<string | null>(null);
  const [activeHour, setActiveHour] = useState<number | null>(null);
  const [activeTimelineDetail, setActiveTimelineDetail] = useState<{
    title: string;
    range: string;
    durationSec: number;
  } | null>(null);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const { visible: rangeHighlightVisible, trigger: triggerRangeHighlight } =
    useTemporaryRangeHighlight(3000);

  const heatmapScrollRef = useRef<HTMLDivElement>(null);
  const timelineSectionRef = useRef<HTMLElement>(null);

  // Recalculate preset date bounds when global timezone changes
  const prevTzRef = useRef(tz);
  useEffect(() => {
    if (prevTzRef.current === tz) return;
    prevTzRef.current = tz;
    if (preset) {
      const next = computePresetDates(preset, tz);
      setStartDate(next.start);
      setEndDate(next.end);
    }
    setTimelineDate(getDateOffsetISOInTimezone(0, tz));
  }, [tz, preset]);

  // Silent visit-triggered incremental sync (enforces 30-minute cooldown server-side)
  const visitSyncedRef = useRef(false);
  useEffect(() => {
    if (!isAuthenticated || visitSyncedRef.current) return;
    visitSyncedRef.current = true;
    let cancelled = false;
    setSyncingVisit(true);
    screenTimeApi
      .syncOnVisit()
      .then((res) => {
        if (cancelled) return;
        if (res.synced) {
          void qc.invalidateQueries({ queryKey: ['screen-time'] });
        }
      })
      .catch(() => {
        // Silent failure: existing local data remains visible
      })
      .finally(() => {
        if (!cancelled) setSyncingVisit(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, qc]);

  const applyPreset = (p: RangePreset) => {
    setPreset(p);
    const next = computePresetDates(p, tz);
    setStartDate(next.start);
    setEndDate(next.end);
    triggerRangeHighlight();
    if (p === '365d') {
      setGranularity('week');
    } else {
      setGranularity('day');
    }
  };

  const selectedSpanDays = useMemo(
    () => diffDaysInclusive(startDate, endDate),
    [startDate, endDate],
  );
  const showHeatmapYearSelector = selectedSpanDays > 366;

  // Reset heatmap year back to rolling 1-year when selected range is <= 1 year
  useEffect(() => {
    if (!showHeatmapYearSelector && heatmapYear !== 0) {
      setHeatmapYear(0);
    }
  }, [showHeatmapYearSelector, heatmapYear]);

  const rollingYearStartISO = useMemo(() => getDateOffsetISOInTimezone(-364, tz), [tz]);
  const effectiveHeatmapYear = showHeatmapYearSelector
    ? heatmapYear
    : endDate && endDate < rollingYearStartISO
      ? Number(endDate.slice(0, 4)) || 0
      : 0;

  const rangeParams = useMemo(
    () => ({ start: startDate, end: endDate, tz }),
    [startDate, endDate, tz],
  );

  const { data: summary, isLoading: loadingSummary } = useQuery({
    queryKey: ['screen-time', 'summary', rangeParams],
    queryFn: () => screenTimeApi.summary(rangeParams),
  });

  const { data: trends } = useQuery({
    queryKey: ['screen-time', 'trends', rangeParams, granularity, groupBy],
    queryFn: () => screenTimeApi.trends({ ...rangeParams, granularity, group_by: groupBy }),
    enabled: Boolean(summary?.configured),
  });

  const { data: heatmap } = useQuery({
    queryKey: ['screen-time', 'heatmap', effectiveHeatmapYear, tz],
    queryFn: () => screenTimeApi.heatmap({ year: effectiveHeatmapYear || undefined, tz }),
    enabled: Boolean(summary?.configured),
  });

  const { data: breakdowns } = useQuery({
    queryKey: ['screen-time', 'breakdowns', rangeParams],
    queryFn: () => screenTimeApi.breakdowns({ ...rangeParams, limit: 15 }),
    enabled: Boolean(summary?.configured),
  });

  // 24h hourly distribution follows the selected timeline date
  const { data: hourly } = useQuery({
    queryKey: ['screen-time', 'hourly', timelineDate, tz],
    queryFn: () => screenTimeApi.hourly({ start: timelineDate, end: timelineDate, tz }),
    enabled: Boolean(summary?.configured),
  });

  const {
    data: timeline,
    isLoading: loadingTimeline,
    isFetching: fetchingTimeline,
  } = useQuery({
    queryKey: ['screen-time', 'timeline', timelineDate, tz],
    queryFn: () => screenTimeApi.timeline({ date: timelineDate, tz }),
    enabled: Boolean(summary?.configured),
  });

  useEffect(() => {
    setActiveTimelineDetail(null);
  }, [timelineDate]);

  const trendSeriesColors = useMemo(() => {
    const map = new Map<string, string>();
    (trends?.series_keys ?? []).forEach((key, idx) => {
      map.set(key, key === '其他' ? '#cbd5e1' : SERIES_COLORS[idx % (SERIES_COLORS.length - 1)]);
    });
    return map;
  }, [trends?.series_keys]);

  const trendPoints = useMemo(() => trends?.points ?? [], [trends?.points]);
  const trendLabelStep = Math.max(1, Math.ceil(trendPoints.length / 10));

  const trendScale = useMemo(
    () =>
      buildDurationAxisScale(
        trendPoints.map((pt) => pt.total_seconds),
        scaleMode,
        { maxTicks: 6, minVisiblePct: 2 },
      ),
    [trendPoints, scaleMode],
  );

  const hourItems = useMemo(
    () =>
      hourly?.hours ??
      Array.from({ length: 24 }, (_, hour) => ({ hour, total_seconds: 0, avg_seconds: 0 })),
    [hourly?.hours],
  );

  const hourScale = useMemo(
    () =>
      buildDurationAxisScale(
        hourItems.map((h) => h.total_seconds),
        'linear',
        { maxTicks: 4, minVisiblePct: 3 },
      ),
    [hourItems],
  );

  // Build week-aligned heatmap grid
  const heatmapGrid = useMemo(() => {
    if (!heatmap?.days || heatmap.days.length === 0) return [];
    const byDate = new Map<string, HeatmapDay>();
    for (const d of heatmap.days) {
      byDate.set(d.date, d);
    }
    const [sy, sm, sd] = heatmap.start_date.split('-').map(Number);
    const [ey, em, ed] = heatmap.end_date.split('-').map(Number);
    const startUTC = new Date(Date.UTC(sy, sm - 1, sd));
    const endUTC = new Date(Date.UTC(ey, em - 1, ed));
    startUTC.setUTCDate(startUTC.getUTCDate() - startUTC.getUTCDay());

    const weeks: Array<Array<{ date: string; inRange: boolean; day?: HeatmapDay }>> = [];
    const cur = new Date(startUTC);
    while (cur <= endUTC) {
      const col: Array<{ date: string; inRange: boolean; day?: HeatmapDay }> = [];
      for (let i = 0; i < 7; i++) {
        const y = cur.getUTCFullYear();
        const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(cur.getUTCDate()).padStart(2, '0');
        const iso = `${y}-${m}-${dd}`;
        const inRange = iso >= heatmap.start_date && iso <= heatmap.end_date;
        col.push({ date: iso, inRange, day: inRange ? byDate.get(iso) : undefined });
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
      weeks.push(col);
    }
    return weeks;
  }, [heatmap]);

  const heatmapMonthLabels = useMemo(() => {
    const labels = new Map<number, string>();
    const firstCols: Array<{ wi: number; month: number }> = [];
    heatmapGrid.forEach((week, wi) => {
      const first = week.find((c) => c.inRange && c.date.endsWith('-01'));
      if (first) {
        firstCols.push({ wi, month: Number(first.date.slice(5, 7)) });
      }
    });
    if (heatmapGrid.length > 0 && (firstCols.length === 0 || firstCols[0].wi >= 3)) {
      const firstIn = heatmapGrid[0].find((c) => c.inRange);
      if (firstIn) {
        labels.set(0, `${Number(firstIn.date.slice(5, 7))}月`);
      }
    }
    for (const item of firstCols) {
      labels.set(item.wi, `${item.month}月`);
    }
    return labels;
  }, [heatmapGrid]);

  useEffect(() => {
    const el = heatmapScrollRef.current;
    if (!el) return;
    if (el.scrollWidth > el.clientWidth) {
      el.scrollLeft = el.scrollWidth;
    }
  }, [heatmapGrid.length]);

  const breakdownItems: BreakdownItem[] = useMemo(() => {
    if (!breakdowns) return [];
    switch (breakdownTab) {
      case 'language':
        return breakdowns.languages;
      case 'editor':
        return breakdowns.editors;
      case 'category':
        return breakdowns.categories;
      case 'machine':
        return breakdowns.machines;
      case 'os':
        return breakdowns.operating_systems;
      default:
        return breakdowns.projects;
    }
  }, [breakdowns, breakdownTab]);

  // Complementary right-column ranking (mirrors AIUsagePage's right card)
  const sideRanking = useMemo(() => {
    if (breakdownTab === 'language') {
      return { title: '项目排行', items: breakdowns?.projects ?? [] };
    }
    return { title: '语言排行', items: breakdowns?.languages ?? [] };
  }, [breakdowns, breakdownTab]);

  const timelineProjectIndex = useMemo(() => {
    const map = new Map<string, number>();
    (timeline?.projects ?? []).forEach((p, idx) => map.set(p.name, idx));
    return map;
  }, [timeline?.projects]);

  const unifiedTimelineBlocks = useMemo(
    () => coalesceUnifiedTimeline(timeline?.blocks ?? []),
    [timeline?.blocks],
  );

  const projectTimelineLanes = useMemo(
    () =>
      coalesceProjectTimelines(
        timeline?.blocks ?? [],
        (timeline?.projects ?? []).map((p) => p.name),
      ),
    [timeline?.blocks, timeline?.projects],
  );

  const activeTrendPoint = useMemo(
    () => (activeTrendBucket ? trendPoints.find((pt) => pt.bucket === activeTrendBucket) ?? null : null),
    [activeTrendBucket, trendPoints],
  );

  const activeHeatmapCell = useMemo(() => {
    if (!activeHeatmapDate) return null;
    for (const week of heatmapGrid) {
      const hit = week.find((c) => c.date === activeHeatmapDate);
      if (hit) return hit;
    }
    return null;
  }, [activeHeatmapDate, heatmapGrid]);

  const activeHourItem = useMemo(
    () => (activeHour !== null ? hourItems.find((h) => h.hour === activeHour) ?? null : null),
    [activeHour, hourItems],
  );

  const jumpToTimelineDate = (date: string) => {
    setTimelineDate(date);
    timelineSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  if (loadingSummary) {
    return <LoadingState label="正在加载使用时间..." variant="module" />;
  }

  // Unconfigured onboarding state
  if (summary && !summary.configured) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="yd-page-title">使用时间</h1>
          <Link to="/settings?tab=screen-time" className="yd-btn-secondary">
            <Settings className="h-3.5 w-3.5" />
            配置
          </Link>
        </div>
        <div className="yd-empty max-w-lg mx-auto my-10 p-8 sm:p-10 space-y-3.5 text-center">
          <div className="h-11 w-11 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center mx-auto">
            <Clock className="h-5 w-5" />
          </div>
          <h2 className="text-base font-medium text-zinc-800">连接你的 WakaTime 账号</h2>
          <p className="text-xs text-zinc-500 leading-relaxed">
            无需修改本地编辑器插件配置。填入 WakaTime API Key 后，YukiDeck 会自动归档每日编码明细与原始心跳，并支持一键导入全部历史记录。
          </p>
          <div className="pt-1.5">
            <Link to="/settings?tab=screen-time" className="yd-btn-primary">
              <Settings className="h-3.5 w-3.5" />
              前往配置 WakaTime
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const deltaPct =
    summary && summary.previous_total_seconds > 0
      ? Math.round(((summary.total_seconds - summary.previous_total_seconds) / summary.previous_total_seconds) * 100)
      : null;

  return (
    <div className="space-y-6">
      {/* Header (mirrors AIUsagePage; no manual refresh button) */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <h1 className="yd-page-title">使用时间</h1>
          {syncingVisit && (
            <span className="inline-flex items-center gap-1.5 text-xs text-sky-600">
              <Loader2 className="h-3 w-3 animate-spin" />
              同步中…
            </span>
          )}
          {!syncingVisit && summary?.last_sync_status === 'auth_error' && (
            <Link
              to="/settings?tab=screen-time"
              className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-xs text-red-700 hover:bg-red-100 transition-colors"
            >
              <AlertTriangle className="h-3 w-3" />
              鉴权失效
            </Link>
          )}
          {!syncingVisit && summary?.last_sync_status === 'error' && (
            <Tooltip content={summary.last_sync_error || '上次同步异常'}>
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs text-amber-700">
                <AlertTriangle className="h-3 w-3" />
                同步异常
              </span>
            </Tooltip>
          )}
        </div>

        <div className="flex items-center gap-2.5">
          {summary?.last_synced_at && (
            <span className="hidden sm:inline text-xs text-zinc-400 tabular-nums">
              最近同步 {formatSyncTime(summary.last_synced_at, tz)}
            </span>
          )}
          <Link to="/settings?tab=screen-time" className="yd-btn-secondary">
            <Settings className="h-3.5 w-3.5" />
            配置
          </Link>
        </div>
      </div>

      {/* Filters Card (mirrors AIUsagePage) */}
      <div className="yd-card p-3.5 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="yd-segment-scroll">
            {PRESET_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => applyPreset(opt.key)}
                className={`yd-segment-btn ${
                  preset === opt.key ? 'yd-segment-active' : 'yd-segment-idle'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:flex sm:w-auto sm:flex-wrap items-center gap-1.5">
            <DatePicker
              ariaLabel="开始日期"
              value={startDate}
              max={endDate || todayISO}
              onChange={(v) => {
                if (!v) return;
                setPreset(null);
                setStartDate(v);
                triggerRangeHighlight();
              }}
              className="w-full sm:w-[132px] min-w-0"
            />
            <span className="text-xs text-zinc-400 text-center">~</span>
            <DatePicker
              ariaLabel="结束日期"
              value={endDate}
              min={startDate || undefined}
              max={todayISO}
              onChange={(v) => {
                if (!v) return;
                setPreset(null);
                setEndDate(v);
                triggerRangeHighlight();
              }}
              className="w-full sm:w-[132px] min-w-0"
            />
          </div>
        </div>
      </div>

      {/* KPI Cards (exact AIUsagePage density & typography) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="yd-card p-3.5 sm:p-4">
          <div className="flex items-center justify-between text-xs sm:text-[13px] text-zinc-500">
            <span>总编码时长</span>
            <Clock className="h-4 w-4 text-zinc-400 shrink-0" />
          </div>
          <div className="mt-2 sm:mt-2.5 font-mono text-xl sm:text-[26px] leading-tight font-semibold tracking-tight text-zinc-900 tabular-nums">
            {formatDuration(summary?.total_seconds ?? 0)}
          </div>
          <div className="mt-1.5 text-[11px] sm:text-xs tabular-nums leading-relaxed">
            {deltaPct !== null ? (
              <span className={deltaPct >= 0 ? 'text-emerald-700' : 'text-amber-600'}>
                {deltaPct >= 0 ? `+${deltaPct}%` : `${deltaPct}%`} 较上周期
              </span>
            ) : (
              <span className="text-zinc-400">
                {summary?.start_date} ~ {summary?.end_date}
              </span>
            )}
          </div>
        </div>

        <div className="yd-card p-3.5 sm:p-4">
          <div className="flex items-center justify-between text-xs sm:text-[13px] text-zinc-500">
            <span>日均时长</span>
            <Calendar className="h-4 w-4 text-zinc-400 shrink-0" />
          </div>
          <div className="mt-2 sm:mt-2.5 font-mono text-xl sm:text-[26px] leading-tight font-semibold tracking-tight text-zinc-900 tabular-nums">
            {formatDuration(summary?.daily_avg_active_seconds ?? 0)}
          </div>
          <div className="mt-1.5 text-[11px] sm:text-xs text-zinc-400 tabular-nums leading-relaxed">
            活跃日均 · 自然日均 {formatDuration(summary?.daily_avg_all_seconds ?? 0)}
          </div>
        </div>

        <div className="yd-card p-3.5 sm:p-4">
          <div className="flex items-center justify-between text-xs sm:text-[13px] text-zinc-500">
            <span>活跃天数 / 连续</span>
            <Flame className="h-4 w-4 text-zinc-400 shrink-0" />
          </div>
          <div className="mt-2 sm:mt-2.5 font-mono text-xl sm:text-[26px] leading-tight font-semibold tracking-tight text-zinc-900 tabular-nums">
            {summary?.active_days ?? 0}
            <span className="text-xs sm:text-[13px] font-normal text-zinc-400 ml-1 sm:ml-1.5">
              / {summary?.total_days ?? 0} 天
            </span>
          </div>
          <div className="mt-1.5 text-[11px] sm:text-xs text-zinc-400 tabular-nums leading-relaxed">
            当前连续 {summary?.current_streak_days ?? 0} 天 · 最长 {summary?.longest_streak_days ?? 0} 天
          </div>
        </div>

        <button
          type="button"
          disabled={!summary?.best_day}
          onClick={() => summary?.best_day && jumpToTimelineDate(summary.best_day.date)}
          className="yd-card-interactive p-3.5 sm:p-4 text-left disabled:cursor-default disabled:hover:border-zinc-200/80"
        >
          <div className="flex items-center justify-between text-xs sm:text-[13px] text-zinc-500">
            <span>最佳单日</span>
            <Trophy className="h-4 w-4 text-zinc-400 shrink-0" />
          </div>
          <div className="mt-2 sm:mt-2.5 font-mono text-xl sm:text-[26px] leading-tight font-semibold tracking-tight text-zinc-900 tabular-nums">
            {summary?.best_day ? formatDuration(summary.best_day.total_seconds) : '—'}
          </div>
          <div className="mt-1.5 text-[11px] sm:text-xs text-zinc-400 tabular-nums leading-relaxed">
            {summary?.best_day ? `${summary.best_day.date} · 点击看时间轴` : '暂无记录'}
          </div>
        </button>
      </div>

      {/* Trends Chart (mirrors AIUsagePage Y-axis, dashed grid lines, Tooltip, scale switch) */}
      <section className="yd-card p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-medium text-zinc-900">编码趋势</h2>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <Select
              value={granularity}
              onChange={(v) => setGranularity(v as TrendGranularity)}
              options={[
                { value: 'day', label: '按天' },
                { value: 'week', label: '按周' },
                { value: 'month', label: '按月' },
              ]}
              className="py-1"
              ariaLabel="时间粒度"
            />
            <Select
              value={groupBy}
              onChange={(v) => setGroupBy(v as TrendGroupBy)}
              options={GROUP_BY_OPTIONS}
              className="py-1"
              ariaLabel="堆叠维度"
            />
            <div className="yd-segment">
              <button
                type="button"
                onClick={() => setScaleMode('linear')}
                className={`yd-segment-btn py-0.5 ${
                  scaleMode === 'linear' ? 'yd-segment-active' : 'yd-segment-idle'
                }`}
              >
                线性
              </button>
              <button
                type="button"
                onClick={() => setScaleMode('log')}
                className={`yd-segment-btn py-0.5 ${
                  scaleMode === 'log' ? 'yd-segment-active' : 'yd-segment-idle'
                }`}
              >
                对数
              </button>
            </div>
          </div>
        </div>

        {trendPoints.length === 0 || trendScale.ticks.length === 0 ? (
          <div className="h-44 flex items-center justify-center text-sm text-zinc-400">
            选定时间范围内暂无数据
          </div>
        ) : (
          <>
            {groupBy !== 'total' && (trends?.series_keys?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-zinc-500">
                {(trends?.series_keys ?? []).map((key) => (
                  <span key={key} className="inline-flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: trendSeriesColors.get(key) ?? '#38bdf8' }}
                    />
                    {key}
                  </span>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              {trendScale.ticks.length > 0 && (
                <div className="w-12 shrink-0 pt-3 pb-[22px]">
                  <div className="relative h-44">
                    {trendScale.ticks.map((t) => (
                      <span
                        key={t.value}
                        style={{ bottom: `${t.pct}%` }}
                        className="absolute right-0 translate-y-1/2 text-[11px] leading-none text-zinc-400 tabular-nums whitespace-nowrap select-none"
                      >
                        {t.label}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex-1 min-w-0 overflow-x-auto">
                <div className="min-w-[480px] pt-3">
                  <div className="relative h-44 border-b border-zinc-200/80">
                    {trendScale.ticks.map((t) =>
                      t.pct > 0 ? (
                        <div
                          key={t.value}
                          style={{ bottom: `${t.pct}%` }}
                          className="pointer-events-none absolute inset-x-0 border-t border-dashed border-zinc-100"
                        />
                      ) : null,
                    )}
                    <div className="relative z-10 flex items-end gap-1.5 h-full">
                      {trendPoints.map((pt) => {
                        const pct = trendScale.toPct(pt.total_seconds);
                        const topParts = Object.entries(pt.series ?? {})
                          .filter(([, v]) => v > 0)
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 4)
                          .map(([k, v]) => `${k}: ${formatDuration(v)}`);
                        const tipLines = [
                          pt.bucket,
                          `总计: ${formatDuration(pt.total_seconds)}`,
                          ...(groupBy !== 'total' ? topParts : []),
                        ];
                        return (
                          <Tooltip key={pt.bucket} delay={80} content={tipLines.join('\n')}>
                            <div
                              onClick={() => {
                                if (isTouchPrimary()) {
                                  setActiveTrendBucket((cur) => (cur === pt.bucket ? null : pt.bucket));
                                } else if (granularity === 'day') {
                                  jumpToTimelineDate(pt.bucket);
                                }
                              }}
                              className={`flex-1 min-w-[10px] flex flex-col items-center h-full justify-end group ${
                                granularity === 'day' ? 'cursor-pointer' : ''
                              }`}
                            >
                              <div
                                className="w-full max-w-[26px] rounded-t-[4px] overflow-hidden flex flex-col-reverse transition-opacity group-hover:opacity-80"
                                style={{ height: `${pct}%` }}
                              >
                                {(trends?.series_keys ?? []).map((sKey) => {
                                  const v = pt.series?.[sKey] ?? 0;
                                  if (v <= 0 || pt.total_seconds <= 0) return null;
                                  return (
                                    <div
                                      key={sKey}
                                      style={{
                                        height: `${(v / pt.total_seconds) * 100}%`,
                                        backgroundColor: trendSeriesColors.get(sKey) ?? '#38bdf8',
                                      }}
                                    />
                                  );
                                })}
                              </div>
                            </div>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 h-[22px] pt-1.5">
                    {trendPoints.map((pt, i) => {
                      const showLabel =
                        i % trendLabelStep === 0 ||
                        (i === trendPoints.length - 1 &&
                          trendPoints.length -
                            1 -
                            Math.floor((trendPoints.length - 1) / trendLabelStep) * trendLabelStep >=
                            Math.ceil(trendLabelStep / 2));
                      return (
                        <div key={pt.bucket} className="relative flex-1 min-w-[10px] h-full">
                          {showLabel ? (
                            <span
                              className={`absolute top-0 text-[11px] leading-none text-zinc-400 whitespace-nowrap tabular-nums select-none ${
                                i === 0
                                  ? 'left-0'
                                  : i === trendPoints.length - 1
                                    ? 'right-0'
                                    : 'left-1/2 -translate-x-1/2'
                              }`}
                            >
                              {pt.label}
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {activeTrendPoint && (
              <div className="sm:hidden flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#f8fafc] border border-zinc-200/75 px-3 py-2 text-xs text-zinc-600 tabular-nums">
                <span className="font-mono font-medium text-zinc-800">{activeTrendPoint.bucket}</span>
                <span>总计 {formatDuration(activeTrendPoint.total_seconds)}</span>
              </div>
            )}
          </>
        )}
      </section>

      {/* Heatmap + 24h Distribution (mirrors AIUsagePage 2:1 grid & full-width aspect-square cells) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section className="lg:col-span-2 yd-card p-4 sm:p-5 flex flex-col justify-between gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <h2 className="text-[15px] font-medium text-zinc-800">年度活跃</h2>
              <span className="text-xs text-zinc-400 tabular-nums">
                {heatmap?.active_days ?? 0} 天 · {formatDuration(heatmap?.total_seconds ?? 0)}
              </span>
            </div>
            <div className="flex items-center gap-3">
              {showHeatmapYearSelector && (
                <div className="w-24">
                  <Select
                    value={String(heatmapYear)}
                    onChange={(v) => setHeatmapYear(Number(v))}
                    options={[
                      { value: '0', label: '近 1 年' },
                      ...(heatmap?.available_years ?? []).map((y) => ({
                        value: String(y),
                        label: `${y} 年`,
                      })),
                    ]}
                    size="sm"
                    ariaLabel="热力图年份"
                  />
                </div>
              )}
              <div className="hidden sm:flex items-center gap-1 text-xs text-zinc-400">
                <span>少</span>
                {HEATMAP_CLASSES.map((cls, idx) => (
                  <span key={idx} className={`h-2.5 w-2.5 rounded-[2px] ${cls}`} />
                ))}
                <span>多</span>
              </div>
            </div>
          </div>

          <div ref={heatmapScrollRef} className="overflow-x-auto pb-1 sm:overflow-visible sm:pb-0">
            <div className="min-w-[640px] sm:min-w-0 space-y-1.5">
              <div
                className="grid w-full gap-[2px] sm:gap-[3px] h-4"
                style={{ gridTemplateColumns: `repeat(${Math.max(heatmapGrid.length, 1)}, minmax(0, 1fr))` }}
              >
                {heatmapGrid.map((_, wi) => {
                  const label = heatmapMonthLabels.get(wi);
                  return (
                    <div key={wi} className="relative min-w-0">
                      {label ? (
                        <span
                          className={`absolute top-0 text-[11px] leading-none text-zinc-400 whitespace-nowrap select-none tabular-nums ${
                            wi >= heatmapGrid.length - 2 ? 'right-0' : 'left-0'
                          }`}
                        >
                          {label}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <div className="relative">
                <div
                  className="grid w-full gap-[2px] sm:gap-[3px]"
                  style={{ gridTemplateColumns: `repeat(${Math.max(heatmapGrid.length, 1)}, minmax(0, 1fr))` }}
                >
                  {heatmapGrid.map((week, wi) => (
                    <div key={wi} className="grid grid-rows-7 gap-[2px] sm:gap-[3px]">
                      {week.map((cell) => {
                        if (!cell.inRange) {
                          return <div key={cell.date} className="w-full aspect-square" />;
                        }
                        const lvl = cell.day?.level ?? 0;
                        const isSelected = cell.date === timelineDate;
                        return (
                          <Tooltip
                            key={cell.date}
                            delay={80}
                            content={
                              cell.day && cell.day.total_seconds > 0
                                ? `${cell.date}: ${formatDuration(cell.day.total_seconds)}（点击查看当日分布与时间轴）`
                                : `${cell.date}: 无记录`
                            }
                          >
                            <div
                              onClick={() => {
                                if (isTouchPrimary()) {
                                  setActiveHeatmapDate((cur) => (cur === cell.date ? null : cell.date));
                                }
                                jumpToTimelineDate(cell.date);
                              }}
                              className={`w-full aspect-square rounded-[2px] ring-1 ring-inset transition-opacity hover:opacity-75 cursor-pointer ${
                                HEATMAP_CLASSES[lvl] ?? HEATMAP_CLASSES[0]
                              } ${isSelected ? 'ring-sky-600' : 'ring-black/[0.04]'}`}
                            />
                          </Tooltip>
                        );
                      })}
                    </div>
                  ))}
                </div>

                {/* Temporary rounded polygon outline framing the manually adjusted date range */}
                <HeatmapRangeOverlay
                  weeks={heatmapGrid}
                  startDate={startDate}
                  endDate={endDate}
                  visible={rangeHighlightVisible}
                  disabled={showHeatmapYearSelector}
                />
              </div>
            </div>
          </div>

          {activeHeatmapCell && (
            <div className="sm:hidden flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#f8fafc] border border-zinc-200/75 px-3 py-1.5 text-xs text-zinc-600 tabular-nums">
              <span className="font-mono font-medium text-zinc-800">{activeHeatmapCell.date}</span>
              <span>
                {activeHeatmapCell.day && activeHeatmapCell.day.total_seconds > 0
                  ? formatDuration(activeHeatmapCell.day.total_seconds)
                  : '无记录'}
              </span>
            </div>
          )}
        </section>

        <section className="yd-card p-4 sm:p-5 flex flex-col justify-between gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[15px] font-medium text-zinc-800">时段分布</h2>
            <span className="text-xs text-zinc-400 tabular-nums">{timelineDate}</span>
          </div>

          <div className="flex gap-2 items-stretch">
            {hourScale.ticks.length > 0 && (
              <div className="w-10 shrink-0 pt-2 pb-[20px]">
                <div className="relative h-28">
                  {hourScale.ticks.map((t) => (
                    <span
                      key={t.value}
                      style={{ bottom: `${t.pct}%` }}
                      className="absolute right-0 translate-y-1/2 text-[11px] leading-none text-zinc-400 tabular-nums whitespace-nowrap select-none"
                    >
                      {t.label}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="flex-1 min-w-0 pt-2">
              <div className="relative h-28 border-b border-zinc-200/80">
                {hourScale.ticks.map((t) =>
                  t.pct > 0 ? (
                    <div
                      key={t.value}
                      style={{ bottom: `${t.pct}%` }}
                      className="pointer-events-none absolute inset-x-0 border-t border-dashed border-zinc-100"
                    />
                  ) : null,
                )}
                <div className="relative z-10 grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[2px] sm:gap-[3px] h-full items-end">
                  {hourItems.map((h) => {
                    const pct = hourScale.toPct(h.total_seconds);
                    const hh = String(h.hour).padStart(2, '0');
                    const hhNext = String((h.hour + 1) % 24).padStart(2, '0');
                    return (
                      <Tooltip
                        key={h.hour}
                        delay={80}
                        content={`${timelineDate} ${hh}:00 ~ ${hhNext}:00\n编码时长: ${formatDuration(h.total_seconds)}`}
                      >
                        <div
                          onClick={() => {
                            if (isTouchPrimary()) {
                              setActiveHour((cur) => (cur === h.hour ? null : h.hour));
                            }
                          }}
                          className="min-w-0 h-full flex items-end rounded-t hover:bg-zinc-100/70 transition-colors group"
                        >
                          <div
                            className="w-full rounded-t-[2px] bg-sky-400 group-hover:bg-sky-500 transition-colors"
                            style={{ height: `${pct}%` }}
                          />
                        </div>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[2px] sm:gap-[3px] h-[20px] pt-1.5">
                {hourItems.map((h, idx) => (
                  <div key={h.hour} className="relative min-w-0 h-full">
                    {h.hour % 4 === 0 ? (
                      <span
                        className={`absolute top-0 text-[11px] leading-none text-zinc-400 tabular-nums whitespace-nowrap select-none ${
                          idx === 0
                            ? 'left-0'
                            : idx === hourItems.length - 1
                              ? 'right-0'
                              : 'left-1/2 -translate-x-1/2'
                        }`}
                      >
                        {h.hour}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {activeHourItem && (
            <div className="sm:hidden flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#f8fafc] border border-zinc-200/75 px-3 py-1.5 text-xs text-zinc-600 tabular-nums">
              <span className="font-mono font-medium text-zinc-800">
                {timelineDate} {String(activeHourItem.hour).padStart(2, '0')}:00
              </span>
              <span>编码 {formatDuration(activeHourItem.total_seconds)}</span>
            </div>
          )}
        </section>
      </div>

      {/* Daily Coding Timeline */}
      <section ref={timelineSectionRef} className="yd-card p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-medium text-zinc-900">每日编码时间轴</h2>
            <span className="text-[13px] text-zinc-400 tabular-nums">
              {timelineDate} ·{' '}
              {loadingTimeline || fetchingTimeline
                ? '加载中…'
                : formatDuration(timeline?.total_seconds ?? 0)}
            </span>
          </div>

          {!loadingTimeline && !fetchingTimeline && projectTimelineLanes.length > 0 && (
            <Tooltip content={timelineExpanded ? '收起按项目展开' : '按项目展开时间轴'}>
              <button
                type="button"
                onClick={() => setTimelineExpanded((v) => !v)}
                aria-expanded={timelineExpanded}
                aria-label={timelineExpanded ? '收起按项目展开' : '按项目展开时间轴'}
                className={`yd-btn-icon h-7 w-7 p-0 border transition-colors ${
                  timelineExpanded
                    ? 'border-sky-200 bg-sky-50 text-sky-600'
                    : 'border-zinc-200 text-zinc-500 hover:text-zinc-800'
                }`}
              >
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform duration-200 ${
                    timelineExpanded ? 'rotate-180' : ''
                  }`}
                />
              </button>
            </Tooltip>
          )}
        </div>

        {loadingTimeline || fetchingTimeline ? (
          <div className="space-y-2">
            <div className="h-11 rounded-lg bg-[#f8fafc] border border-zinc-200/75 flex items-center justify-center gap-2 text-xs text-zinc-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500" />
              正在加载时间轴…
            </div>
            <div className="relative h-4 text-[11px] text-zinc-400 tabular-nums select-none">
              {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (
                <span
                  key={h}
                  style={{ left: `${(h / 24) * 100}%` }}
                  className={`absolute top-0 ${
                    h === 0 ? 'translate-x-0' : h === 24 ? '-translate-x-full' : '-translate-x-1/2'
                  }`}
                >
                  {String(h).padStart(2, '0')}:00
                </span>
              ))}
            </div>
          </div>
        ) : unifiedTimelineBlocks.length === 0 ? (
          <div className="space-y-2">
            <div className="h-11 rounded-lg bg-[#f8fafc] border border-zinc-200/75 flex items-center justify-center text-xs text-zinc-400">
              当日暂无编码时间段记录
            </div>
            <div className="relative h-4 text-[11px] text-zinc-400 tabular-nums select-none">
              {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (
                <span
                  key={h}
                  style={{ left: `${(h / 24) * 100}%` }}
                  className={`absolute top-0 ${
                    h === 0 ? 'translate-x-0' : h === 24 ? '-translate-x-full' : '-translate-x-1/2'
                  }`}
                >
                  {String(h).padStart(2, '0')}:00
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="overflow-x-auto pb-1 sm:overflow-visible sm:pb-0">
              <div className="min-w-[540px] sm:min-w-0 space-y-2">
                {/* Unified single-color active coding bar */}
                <div className="flex items-center gap-3">
                  {timelineExpanded && (
                    <div className="w-32 sm:w-44 shrink-0 flex items-center justify-between gap-2 text-xs">
                      <span className="inline-flex items-center gap-1.5 min-w-0 font-medium text-zinc-800">
                        <span className="h-2 w-2 rounded-full bg-sky-400 shrink-0" />
                        <span className="truncate">全部有效编码</span>
                      </span>
                      <span className="font-mono text-[11px] text-zinc-400 shrink-0 tabular-nums">
                        {formatDuration(timeline?.total_seconds ?? 0)}
                      </span>
                    </div>
                  )}
                  <div
                    className={`flex-1 min-w-0 relative rounded-lg bg-[#f8fafc] border border-zinc-200/75 overflow-hidden ${
                      timelineExpanded ? 'h-8' : 'h-11'
                    }`}
                  >
                    {[3, 6, 9, 12, 15, 18, 21].map((h) => (
                      <div
                        key={h}
                        style={{ left: `${(h / 24) * 100}%` }}
                        className="pointer-events-none absolute inset-y-0 border-l border-dashed border-zinc-200/80"
                      />
                    ))}
                    {unifiedTimelineBlocks.map((blk, idx) => {
                      const leftPct = Math.max(0, Math.min(100, (blk.start_minute / 1440) * 100));
                      const rawWidthPct = Math.max(0.35, ((blk.end_minute - blk.start_minute) / 1440) * 100);
                      const widthPct = Math.min(100 - leftPct, rawWidthPct);
                      const rangeLabel = `${formatClockTime(blk.started_at, tz)} ~ ${formatClockTime(blk.ended_at, tz)}`;
                      const tipLines = [
                        `${rangeLabel} · 有效编码 ${formatDuration(blk.active_seconds)}`,
                        ...blk.projects
                          .slice(0, 4)
                          .map((p) => `${p.project}: ${formatDuration(p.seconds)}`),
                      ];
                      return (
                        <Tooltip
                          key={`u-${blk.started_at}-${idx}`}
                          delay={60}
                          content={tipLines.join('\n')}
                        >
                          <div
                            onClick={() => {
                              if (isTouchPrimary()) {
                                setActiveTimelineDetail({
                                  title: '有效编码',
                                  range: rangeLabel,
                                  durationSec: blk.active_seconds,
                                });
                              }
                            }}
                            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                            className={`absolute rounded-[3px] bg-sky-400 hover:bg-sky-500 transition-colors cursor-pointer ${
                              timelineExpanded ? 'top-1.5 bottom-1.5' : 'top-2 bottom-2'
                            }`}
                          />
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>

                {/* Expanded: One timeline row per project aligned to the exact same 00:00~24:00 ruler */}
                {timelineExpanded && projectTimelineLanes.length > 0 && (
                  <div className="pt-1.5 border-t border-zinc-100 space-y-1.5">
                    {projectTimelineLanes.map((lane) => {
                      const laneColor = colorForProject(lane.project, undefined, timelineProjectIndex);
                      return (
                        <div key={lane.project} className="flex items-center gap-3">
                          <div className="w-32 sm:w-44 shrink-0 flex items-center justify-between gap-2 text-xs">
                            <span
                              title={lane.project}
                              className="inline-flex items-center gap-1.5 min-w-0 text-zinc-700"
                            >
                              <span
                                className="h-2 w-2 rounded-full shrink-0"
                                style={{ backgroundColor: laneColor }}
                              />
                              <span className="font-mono truncate">{lane.project}</span>
                            </span>
                            <span className="font-mono text-[11px] text-zinc-400 shrink-0 tabular-nums">
                              {formatDuration(lane.total_seconds)}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0 relative h-7 rounded-md bg-[#f8fafc] border border-zinc-200/60 overflow-hidden">
                            {[3, 6, 9, 12, 15, 18, 21].map((h) => (
                              <div
                                key={h}
                                style={{ left: `${(h / 24) * 100}%` }}
                                className="pointer-events-none absolute inset-y-0 border-l border-dashed border-zinc-200/70"
                              />
                            ))}
                            {lane.blocks.map((blk, bIdx) => {
                              const leftPct = Math.max(0, Math.min(100, (blk.start_minute / 1440) * 100));
                              const rawWidthPct = Math.max(
                                0.35,
                                ((blk.end_minute - blk.start_minute) / 1440) * 100,
                              );
                              const widthPct = Math.min(100 - leftPct, rawWidthPct);
                              const rangeLabel = `${formatClockTime(blk.started_at, tz)} ~ ${formatClockTime(blk.ended_at, tz)}`;
                              return (
                                <Tooltip
                                  key={`${lane.project}-${blk.started_at}-${bIdx}`}
                                  delay={60}
                                  content={`${lane.project}\n${rangeLabel} · 有效编码 ${formatDuration(blk.active_seconds)}`}
                                >
                                  <div
                                    onClick={() => {
                                      if (isTouchPrimary()) {
                                        setActiveTimelineDetail({
                                          title: lane.project,
                                          range: rangeLabel,
                                          durationSec: blk.active_seconds,
                                        });
                                      }
                                    }}
                                    style={{
                                      left: `${leftPct}%`,
                                      width: `${widthPct}%`,
                                      backgroundColor: laneColor,
                                    }}
                                    className="absolute top-1.5 bottom-1.5 rounded-[3px] transition-opacity hover:opacity-80 cursor-pointer"
                                  />
                                </Tooltip>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Shared 00:00 ~ 24:00 ruler */}
                <div className="flex items-center gap-3">
                  {timelineExpanded && <div className="w-32 sm:w-44 shrink-0" />}
                  <div className="flex-1 min-w-0 relative h-4 text-[11px] text-zinc-400 tabular-nums select-none">
                    {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (
                      <span
                        key={h}
                        style={{ left: `${(h / 24) * 100}%` }}
                        className={`absolute top-0 ${
                          h === 0 ? 'translate-x-0' : h === 24 ? '-translate-x-full' : '-translate-x-1/2'
                        }`}
                      >
                        {String(h).padStart(2, '0')}:00
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {activeTimelineDetail && (
              <div className="sm:hidden flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#f8fafc] border border-zinc-200/75 px-3 py-1.5 text-xs text-zinc-600 tabular-nums">
                <span className="font-mono font-medium text-zinc-800">
                  {activeTimelineDetail.title}
                </span>
                <span>
                  {activeTimelineDetail.range} · 有效 {formatDuration(activeTimelineDetail.durationSec)}
                </span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Multi-dimensional Breakdown + Side Ranking (exact AIUsagePage 2:1 layout) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section className="lg:col-span-2 yd-card p-4 sm:p-5 space-y-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[15px] font-medium text-zinc-900">多维分布</h2>
            <div className="yd-segment-scroll">
              {BREAKDOWN_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setBreakdownTab(tab.key)}
                  className={`yd-segment-btn py-0.5 ${
                    breakdownTab === tab.key ? 'yd-segment-active' : 'yd-segment-idle'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="yd-table">
              <thead className="yd-thead">
                <tr>
                  <th className="py-2 pr-3 font-medium">名称</th>
                  <th className="hidden sm:table-cell py-2 pr-3 font-medium w-40">分布</th>
                  <th className="py-2 pr-3 font-medium text-right whitespace-nowrap">时长</th>
                  <th className="py-2 font-medium text-right whitespace-nowrap">占比</th>
                </tr>
              </thead>
              <tbody className="yd-tbody tabular-nums">
                {breakdownItems.slice(0, 12).map((item) => (
                  <tr key={item.name} className="hover:bg-zinc-50/70 transition-colors">
                    <td className="py-2.5 pr-3 font-mono text-zinc-800 max-w-[180px] sm:max-w-none">
                      <span className="block truncate">{item.name}</span>
                    </td>
                    <td className="hidden sm:table-cell py-2.5 pr-3">
                      <div className="h-1.5 rounded-full bg-[#f1f5f9] overflow-hidden">
                        <div
                          className="h-full bg-sky-400 rounded-full"
                          style={{ width: `${Math.max(2, Math.min(100, item.percent))}%` }}
                        />
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-right text-zinc-700 whitespace-nowrap">
                      {formatDuration(item.total_seconds)}
                    </td>
                    <td className="py-2.5 text-right text-zinc-500 whitespace-nowrap">
                      {formatPercent(item.percent)}
                    </td>
                  </tr>
                ))}
                {breakdownItems.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-zinc-400">
                      暂无数据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="yd-card p-4 sm:p-5 space-y-3.5">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-medium text-zinc-900">{sideRanking.title}</h2>
            <span className="text-xs text-zinc-400 tabular-nums">
              共 {formatDuration(breakdowns?.total_seconds ?? 0)}
            </span>
          </div>
          <div className="space-y-3">
            {sideRanking.items.slice(0, 10).map((item) => (
              <div key={item.name} className="space-y-1.5">
                <div className="flex justify-between text-[13px]">
                  <span className="font-mono text-zinc-800 truncate">{item.name}</span>
                  <span className="text-zinc-500 shrink-0 ml-2 tabular-nums">
                    {formatDuration(item.total_seconds)}{' '}
                    <span className="text-zinc-400">({formatPercent(item.percent)})</span>
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-[#f1f5f9] overflow-hidden">
                  <div
                    className="h-full bg-sky-400 rounded-full"
                    style={{ width: `${Math.max(2, Math.min(100, item.percent))}%` }}
                  />
                </div>
              </div>
            ))}
            {sideRanking.items.length === 0 && (
              <div className="py-6 text-center text-sm text-zinc-400">暂无记录</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
